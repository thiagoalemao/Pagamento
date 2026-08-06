# thiagoalemaovet

Repositório central dos projetos digitais da Thiago Alemão Gestão Empresarial
Veterinária. Cada pasta na raiz é um projeto independente, com seu próprio
README e seu próprio deploy.

---

## Projetos

| Pasta | O que é | Stack | Status | Deploy |
|---|---|---|---|---|
| [`mentoria-imersiva/`](./mentoria-imersiva) | Landing de checkout da Mentoria Imersiva Veterinária. Coleta os dados, cria a cobrança no Asaas e redireciona para o pagamento hospedado. | HTML/CSS/JS puro + funções serverless Node | Em finalização | Vercel |
| `_______________/` | *(confirme o nome)* CRM multi-funil — Kanban com etapas customizáveis, tabela de leads, dashboard. | — | — | — |
| `_______________/` | *(confirme o nome)* Formulário de diagnóstico de gestão — 8 seções, persistência local, export JSON/PDF. | — | — | — |

> Substitua as linhas com `___` pelos nomes reais das pastas quando migrar
> cada projeto para cá. Se algum deles não vier para este repositório,
> apague a linha em vez de deixá-la em branco.

---

## Regra de deploy no monorepo (leia antes de publicar)

Cada projeto é publicado como um **projeto separado na Vercel**, não como um
deploy único do repositório inteiro.

Ao criar o projeto na Vercel, em *Settings > General > Root Directory*,
aponte para a pasta do projeto (ex.: `mentoria-imersiva`).

**Isso não é opcional.** A Vercel só transforma arquivos em funções
serverless se eles estiverem em `api/` **relativo à Root Directory**. Se você
deixar a Root Directory na raiz do repositório, `mentoria-imersiva/api/checkout.js`
não vira função — o site sobe, a página aparece, e o botão de pagamento
retorna 404. É o erro mais comum ao converter um projeto solto em monorepo.

---

## Segredos

Nenhuma chave de API entra neste repositório, em nenhum arquivo, em nenhum
commit — inclusive em `.env.example`, que guarda só os nomes das variáveis.

Todas as chaves ficam em *Environment Variables* no painel da Vercel, por
projeto. Se uma chave for exposta por acidente, revogue no painel de origem
antes de qualquer outra coisa: apagar o commit não resolve, o histórico do Git
guarda o valor.

Cada projeto documenta as próprias variáveis no seu README.

---

## Convenções

- Nome de pasta em minúsculas com hífen: `mentoria-imersiva`, não `Mentoria Imersiva`.
- Todo projeto tem `README.md` próprio, com: o que é, como rodar local,
  variáveis de ambiente necessárias e como publicar.
- Todo projeto tem `.gitignore` cobrindo no mínimo `.env`, `.env.local`,
  `.vercel` e `node_modules`.
- Branch `main` é o que está no ar. Mudança que mexe em preço, chave de API ou
  fluxo de pagamento vai para uma branch e passa por teste em sandbox antes
  do merge.
