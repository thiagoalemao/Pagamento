# Mentoria Imersiva Veterinária — landing de checkout

Página única de pagamento. O front-end coleta os dados, o backend cria a
cobrança no Asaas e devolve o `invoiceUrl`, para onde o cliente é
redirecionado. Nenhum dado de cartão passa pelo nosso código e a chave da API
nunca vai ao browser.

## Estrutura

```
mentoria-imersiva/
├── public/
│   ├── index.html                 página de checkout
│   ├── obrigado.html              retorno após pagamento confirmado
│   └── assets/
│       └── logo-lockup-white.png
├── api/
│   ├── checkout.js                POST — cria cliente + cobrança, devolve invoiceUrl
│   └── webhook-asaas.js           POST — recebe os eventos de cobrança do Asaas
├── package.json
├── vercel.json
└── .env.example
```

`package.json` com `"type": "module"` é obrigatório: sem ele o runtime da
Vercel não interpreta o `export default` dos arquivos em `api/` e o checkout
responde 404.

## Variáveis de ambiente

Configure na Vercel em *Settings > Environment Variables*. Nunca comite valores.

| Variável | Para que serve | Obrigatória |
|---|---|---|
| `ASAAS_API_KEY` | Chave da API do Asaas | sim |
| `ASAAS_ENV` | `sandbox` (padrão) ou `production` | não |
| `SITE_URL` | URL pública, sem barra final. Monta o retorno `/obrigado` | recomendada |
| `ASAAS_WEBHOOK_TOKEN` | Token do webhook. Sem ele o endpoint recusa tudo | sim, se usar webhook |
| `LEAD_WEBHOOK_URL` | Recebe o lead no envio do formulário | não |
| `VENDA_WEBHOOK_URL` | Recebe a confirmação de pagamento | não |

Ao virar para produção, troque a chave **e** defina `ASAAS_ENV=production`.
Trocar só um dos dois faz a chamada falhar com 401.

## Publicar

```bash
npm i -g vercel
cd mentoria-imersiva
vercel          # preview
vercel --prod   # produção
```

Sem passo de build: a Vercel serve `public/` como estático e transforma cada
arquivo em `api/` numa função serverless.

Se este projeto estiver dentro do monorepo, aponte *Settings > General > Root
Directory* para `mentoria-imersiva`. Sem isso as funções não são criadas.

Para rodar local com o backend funcionando:

```bash
cp .env.example .env.local   # preencha ASAAS_API_KEY
vercel dev
```

Abrir o `index.html` direto no browser mostra a página, mas o botão de
pagamento falha com uma mensagem explicando — o `/api/checkout` não existe
fora da Vercel.

## Regras de preço (não altere)

| Condição | Payload enviado ao Asaas | Total |
|---|---|---|
| À vista | `billingType: UNDEFINED`, `value: 4900.00` | R$ 4.900,00 |
| Parcelado | `billingType: CREDIT_CARD`, `installmentCount: 6`, `installmentValue: 897.00` | R$ 5.382,00 |

`installmentValue` fixo é o que garante a parcela exata de R$ 897,00. Se usar
`totalValue`, o Asaas recalcula e a parcela sai quebrada.

**Confira antes de ir ao ar:** se a conta Asaas tiver juros de parcelamento
configurados no painel, eles podem incidir por cima dos R$ 897 e a parcela
sair maior que o anunciado. Teste em sandbox e confira o valor da parcela na
tela final do Asaas, não só na API.

## Fluxo

1. Front valida nome, e-mail, CPF/CNPJ (com dígito verificador) e telefone.
2. `POST /api/checkout` com os dados, a condição escolhida e a origem
   (`?origem=webinario` na URL).
3. Backend aplica limite por IP, checa a armadilha anti-robô e revalida tudo.
4. Backend registra o lead (log + `LEAD_WEBHOOK_URL`) **antes** de chamar o
   Asaas — é isso que permite recuperar quem desiste na tela de pagamento.
5. Backend busca o cliente por `cpfCnpj` e cria se não existir.
6. Backend cria a cobrança com `callback.successUrl` apontando para `/obrigado`.
7. Front redireciona para o `invoiceUrl` — checkout hospedado pelo Asaas.
8. Pagamento confirmado: o cliente volta para `/obrigado` e o Asaas dispara o
   webhook.

## Proteção contra abuso

- Limite de 5 envios por IP a cada 10 minutos.
- Campo-armadilha invisível: se vier preenchido, o envio é descartado em
  silêncio com resposta falsa de sucesso.
- Timeout de 15s nas chamadas ao Asaas.

O limite fica na memória da instância serverless. Ele some num cold start e
não cobre ataque distribuído. Se a página passar a receber tráfego pago em
volume, troque por Vercel KV ou Upstash Redis.

## Webhook

Painel do Asaas > Integrações > Webhooks:

- URL: `https://SEU-DOMINIO/api/webhook-asaas`
- Token: o mesmo valor de `ASAAS_WEBHOOK_TOKEN` (32 a 255 caracteres)
- Tipo de envio: sequencial
- Versão da API: v3
- E-mail de notificação de falha: um endereço que você lê todo dia
- Eventos: `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`,
  `PAYMENT_REFUNDED`, `PAYMENT_CHARGEBACK_REQUESTED`

Sandbox e produção são contas separadas: o webhook precisa ser criado nas
duas, cada uma com sua própria URL.

**Ordem obrigatória:** definir `ASAAS_WEBHOOK_TOKEN` na Vercel e fazer o
deploy **antes** de criar o webhook no painel. O handler recusa com 401
qualquer chamada sem o token certo, e 15 recusas seguidas interrompem a fila.

O Asaas só considera entrega bem-sucedida a resposta **HTTP 200** — 201, 204
e redirects contam como falha. Por isso o handler responde 200 até quando o
parsing falha.

A entrega é *at least once*: o mesmo evento pode chegar duas vezes. Este
handler não deduplica — quem recebe o `VENDA_WEBHOOK_URL` precisa ignorar
`paymentId` + `evento` já processados, senão você manda boas-vindas repetida.

Se a fila for interrompida, os eventos ficam guardados por 14 dias. Corrija a
causa e reative em Integrações > Webhooks.

O redirecionamento do navegador não é confirmação de pagamento. Boleto pago
dois dias depois nunca passa pela página de obrigado. Só o webhook confirma
dinheiro na conta — use ele como gatilho de entrega.

No parcelado o Asaas dispara um evento por parcela paga. O handler marca
`installmentNumber === 1` como venda e as demais como recebimento, para você
não contar seis vendas onde houve uma.

## Roteiro de teste antes de virar produção

1. `ASAAS_ENV=sandbox`, chave de sandbox.
2. Enviar o formulário com CPF inválido → mensagem de erro clara.
3. Enviar seis vezes seguidas → a sexta responde 429.
4. Fluxo à vista → conferir R$ 4.900,00 na tela do Asaas.
5. Fluxo parcelado → conferir **6x de R$ 897,00**, não 6x de R$ 816,67.
6. Pagar em sandbox → conferir se cai em `/obrigado`.
7. Conferir o log da Vercel: `[lead]` e `[asaas]` aparecendo.
8. Só então trocar chave e `ASAAS_ENV` para produção e repetir 4 e 5.

## O que ainda depende de você

- Subtítulo da página: hoje há um rascunho. Troque pelo texto do webinário.
- `og:url` e `og:image` no `index.html`: colocar o domínio real e gerar a
  imagem de preview 1200x630 em `public/assets/og-mentoria.jpg`.
- `obrigado.html`: link do grupo de WhatsApp e número de suporte.
- Pixel do Meta ou GTM, se for anunciar.
- Domínio: `SITE_URL` precisa bater com o domínio cadastrado nos dados
  comerciais da conta Asaas, senão o retorno é recusado.
