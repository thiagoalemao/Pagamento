// POST /api/checkout — cria cliente e cobrança no Asaas e devolve o invoiceUrl.
// A chave da API vive só aqui, em variável de ambiente. Nunca no front-end.

const PRECOS = {
  vista: { billingType: 'UNDEFINED', value: 4900.0 },
  parcelado: { billingType: 'CREDIT_CARD', installmentCount: 6, installmentValue: 897.0 },
};

const base = () =>
  process.env.ASAAS_ENV === 'production'
    ? 'https://api.asaas.com/v3'
    : 'https://api-sandbox.asaas.com/v3';

const soNumeros = (v) => String(v || '').replace(/\D/g, '');

// ---------------------------------------------------------------------------
// Limite de requisições
//
// Guarda os últimos envios por IP na memória da instância. Cobre o caso comum:
// alguém apertando o botão em loop ou um script simples. NÃO cobre ataque
// distribuído nem sobrevive a um cold start da função — para isso é preciso
// um armazenamento externo (Upstash Redis / Vercel KV). Está documentado no
// README como pendência caso o volume de tráfego justifique.
// ---------------------------------------------------------------------------
const JANELA_MS = 10 * 60 * 1000;
const MAX_POR_JANELA = 5;
const historico = new Map();

function excedeuLimite(ip) {
  const agora = Date.now();
  const registros = (historico.get(ip) || []).filter((t) => agora - t < JANELA_MS);
  registros.push(agora);
  historico.set(ip, registros);

  // Limpeza oportunista para a memória não crescer sem limite.
  if (historico.size > 500) {
    for (const [chave, tempos] of historico) {
      if (!tempos.some((t) => agora - t < JANELA_MS)) historico.delete(chave);
    }
  }

  return registros.length > MAX_POR_JANELA;
}

function ipDe(req) {
  const encaminhado = req.headers['x-forwarded-for'];
  if (typeof encaminhado === 'string' && encaminhado.length) return encaminhado.split(',')[0].trim();
  return req.socket?.remoteAddress || 'desconhecido';
}

// ---------------------------------------------------------------------------
// Validação de documento
// ---------------------------------------------------------------------------
function validaCPF(c) {
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += parseInt(c[i]) * (10 - i);
  let d1 = (s * 10) % 11; if (d1 === 10) d1 = 0;
  if (d1 !== parseInt(c[9])) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += parseInt(c[i]) * (11 - i);
  let d2 = (s * 10) % 11; if (d2 === 10) d2 = 0;
  return d2 === parseInt(c[10]);
}

function validaCNPJ(c) {
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (pesos) => {
    let s = 0;
    for (let i = 0; i < pesos.length; i++) s += parseInt(c[i]) * pesos[i];
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  if (calc([5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) !== parseInt(c[12])) return false;
  return calc([6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === parseInt(c[13]);
}

// ---------------------------------------------------------------------------
// Chamada ao Asaas
// ---------------------------------------------------------------------------
async function asaas(caminho, opcoes = {}) {
  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(), 15000);
  try {
    const r = await fetch(base() + caminho, {
      ...opcoes,
      signal: controle.signal,
      headers: {
        'Content-Type': 'application/json',
        access_token: process.env.ASAAS_API_KEY,
        'User-Agent': 'mentoria-imersiva-veterinaria',
        ...(opcoes.headers || {}),
      },
    });
    const texto = await r.text();
    let corpo = {};
    try { corpo = texto ? JSON.parse(texto) : {}; } catch { corpo = { raw: texto }; }
    return { ok: r.ok, status: r.status, corpo };
  } finally {
    clearTimeout(prazo);
  }
}

// ---------------------------------------------------------------------------
// Registro do lead
//
// Dispara os dados do formulário para uma URL externa (n8n, Make, Zapier,
// Apps Script de planilha, seu CRM) assim que a pessoa envia — antes de ela
// chegar na tela de pagamento. É isso que permite recuperar quem abandona.
// Falha aqui nunca derruba o checkout: no pior caso o lead vai só para o log.
// ---------------------------------------------------------------------------
async function registrarLead(dados) {
  console.log('[lead]', JSON.stringify(dados));
  const destino = process.env.LEAD_WEBHOOK_URL;
  if (!destino) return;
  try {
    const controle = new AbortController();
    setTimeout(() => controle.abort(), 4000);
    await fetch(destino, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados),
      signal: controle.signal,
    });
  } catch (erro) {
    console.error('[lead] falha ao encaminhar', erro?.message);
  }
}

function vencimento(dias = 3) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ mensagem: 'Método não permitido.' });
  }

  if (!process.env.ASAAS_API_KEY) {
    console.error('ASAAS_API_KEY ausente no ambiente.');
    return res.status(500).json({ mensagem: 'O checkout está indisponível. Chame o suporte no WhatsApp.' });
  }

  const ip = ipDe(req);
  if (excedeuLimite(ip)) {
    console.warn('[limite] excedido', ip);
    return res.status(429).json({ mensagem: 'Muitas tentativas seguidas. Espere alguns minutos e tente de novo.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    // Armadilha: campo invisível no formulário. Humano nunca preenche.
    // Responde 200 com um destino falso para o robô achar que funcionou.
    if (String(body.empresa || '').trim()) {
      console.warn('[armadilha] preenchida', ip);
      return res.status(200).json({ invoiceUrl: 'https://asaas.com', paymentId: null, condicao: 'vista' });
    }

    const nome = String(body.nome || '').trim().slice(0, 120);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 160);
    const documento = soNumeros(body.documento);
    const telefone = soNumeros(body.telefone);
    const condicao = body.condicao === 'parcelado' ? 'parcelado' : 'vista';
    const origem = String(body.origem || '').trim().slice(0, 60) || 'direto';

    if (nome.split(' ').filter(Boolean).length < 2)
      return res.status(400).json({ mensagem: 'Informe o nome completo.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
      return res.status(400).json({ mensagem: 'E-mail inválido.' });
    const docOk = documento.length === 11 ? validaCPF(documento)
      : documento.length === 14 ? validaCNPJ(documento) : false;
    if (!docOk)
      return res.status(400).json({ mensagem: 'CPF ou CNPJ inválido. Confira os números digitados.' });
    if (telefone.length < 10 || telefone.length > 11)
      return res.status(400).json({ mensagem: 'Informe o WhatsApp com DDD.' });

    const referencia = 'mentoria-' + condicao + '-' + Date.now();

    // Grava o lead antes de qualquer coisa: mesmo que o Asaas falhe ou a
    // pessoa desista na tela de pagamento, o contato não se perde.
    await registrarLead({
      referencia, nome, email, documento, telefone, condicao, origem,
      etapa: 'formulario_enviado',
      em: new Date().toISOString(),
    });

    // 1) Recupera o cliente pelo documento; cria se não existir.
    let customerId = null;
    const busca = await asaas('/customers?cpfCnpj=' + documento);
    if (busca.ok && Array.isArray(busca.corpo.data) && busca.corpo.data.length) {
      customerId = busca.corpo.data[0].id;
    } else {
      const criado = await asaas('/customers', {
        method: 'POST',
        body: JSON.stringify({
          name: nome,
          email,
          cpfCnpj: documento,
          mobilePhone: telefone,
          notificationDisabled: false,
        }),
      });
      if (!criado.ok || !criado.corpo.id) {
        console.error('Falha ao criar cliente', criado.status, criado.corpo);
        const detalhe = criado.corpo?.errors?.[0]?.description;
        return res.status(400).json({ mensagem: detalhe || 'Não foi possível registrar seus dados. Confira o CPF/CNPJ.' });
      }
      customerId = criado.corpo.id;
    }

    // 2) Cria a cobrança na condição escolhida.
    const preco = PRECOS[condicao];
    const cobranca = {
      customer: customerId,
      dueDate: vencimento(condicao === 'vista' ? 3 : 1),
      description: 'Mentoria Imersiva Veterinária',
      externalReference: referencia,
      ...preco,
    };

    // Retorno para a página de obrigado. O domínio precisa ser o mesmo
    // cadastrado nos dados comerciais da conta Asaas, senão o Asaas recusa.
    if (process.env.SITE_URL) {
      cobranca.callback = {
        successUrl: process.env.SITE_URL.replace(/\/$/, '') + '/obrigado',
        autoRedirect: true,
      };
    }

    const pag = await asaas('/payments', { method: 'POST', body: JSON.stringify(cobranca) });
    if (!pag.ok || !pag.corpo.invoiceUrl) {
      console.error('Falha ao criar cobrança', pag.status, pag.corpo);
      const detalhe = pag.corpo?.errors?.[0]?.description;
      return res.status(502).json({ mensagem: detalhe || 'Não conseguimos gerar a cobrança agora. Tente novamente em instantes.' });
    }

    await registrarLead({
      referencia, nome, email, documento, telefone, condicao, origem,
      etapa: 'cobranca_gerada',
      paymentId: pag.corpo.id,
      invoiceUrl: pag.corpo.invoiceUrl,
      em: new Date().toISOString(),
    });

    return res.status(200).json({
      invoiceUrl: pag.corpo.invoiceUrl,
      paymentId: pag.corpo.id,
      condicao,
    });
  } catch (erro) {
    console.error('Erro inesperado no checkout', erro);
    return res.status(500).json({ mensagem: 'Algo falhou no nosso lado. Tente novamente ou chame o suporte no WhatsApp.' });
  }
}
