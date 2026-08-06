// POST /api/webhook-asaas — recebe os eventos de cobrança do Asaas.
//
// O redirecionamento do navegador (successUrl) não é confirmação de pagamento:
// o cliente pode fechar a aba, pagar um boleto três dias depois ou o Pix cair
// fora do fluxo. Só o webhook confirma dinheiro na conta. É daqui que sai o
// gatilho de entrega: e-mail de boas-vindas, entrada no grupo, aviso interno.
//
// Para ativar: painel do Asaas > Integrações > Webhooks
//   URL:   https://SEU-DOMINIO/api/webhook-asaas
//   Token: o mesmo valor colocado em ASAAS_WEBHOOK_TOKEN
//   Eventos: PAYMENT_CONFIRMED, PAYMENT_RECEIVED, PAYMENT_OVERDUE,
//            PAYMENT_REFUNDED, PAYMENT_CHARGEBACK_REQUESTED

const EVENTOS_DE_VENDA = ['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'];

async function encaminhar(payload) {
  const destino = process.env.VENDA_WEBHOOK_URL;
  if (!destino) return;
  try {
    const controle = new AbortController();
    setTimeout(() => controle.abort(), 4000);
    await fetch(destino, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controle.signal,
    });
  } catch (erro) {
    console.error('[venda] falha ao encaminhar', erro?.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  const tokenEsperado = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!tokenEsperado) {
    // Sem token configurado o endpoint aceitaria qualquer POST forjado.
    console.error('ASAAS_WEBHOOK_TOKEN ausente — webhook recusado.');
    return res.status(401).json({ recebido: false });
  }
  if (req.headers['asaas-access-token'] !== tokenEsperado) {
    console.warn('[webhook] token inválido');
    return res.status(401).json({ recebido: false });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const evento = body.event;
    const pagamento = body.payment || {};

    const resumo = {
      evento,
      paymentId: pagamento.id,
      parcelamento: pagamento.installment || null,
      parcela: pagamento.installmentNumber || null,
      valor: pagamento.value,
      valorLiquido: pagamento.netValue,
      forma: pagamento.billingType,
      cliente: pagamento.customer,
      referencia: pagamento.externalReference,
      pagoEm: pagamento.paymentDate || pagamento.confirmedDate || null,
      em: new Date().toISOString(),
    };

    console.log('[asaas]', evento, JSON.stringify(resumo));

    if (EVENTOS_DE_VENDA.includes(evento)) {
      // No parcelado o Asaas dispara um evento por parcela paga.
      // installmentNumber === 1 é a venda; os demais são recebimentos.
      resumo.tipo = (!resumo.parcela || resumo.parcela === 1) ? 'venda' : 'recebimento_parcela';
      await encaminhar(resumo);
    } else {
      await encaminhar(resumo);
    }

    return res.status(200).json({ recebido: true });
  } catch (erro) {
    console.error('Erro no webhook', erro);
    // 200 evita reenvio infinito do Asaas por erro nosso de parsing.
    return res.status(200).json({ recebido: true });
  }
}
