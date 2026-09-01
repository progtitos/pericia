# PeríciaAI / ExpertSystem

MVP de plataforma SaaS multitenant de perícia judicial e extração inteligente com IA.

## Stack
- **Frontend/Backend:** Next.js 14 (App Router, TypeScript, Tailwind), hospedado na Vercel.
- **Banco & Auth:** Supabase (Postgres + RLS, Auth, Storage).
- **IA:** Google Gemini (`@google/genai`) com **Structured Outputs** (JSON Schema) para extração, e prompt livre — mas 100% ancorado em números já calculados — para a redação da minuta.
- **Cálculo:** motor 100% determinístico em TypeScript puro (`src/lib/calc/*`), sem qualquer dependência da IA para números.

## Por que a IA nunca calcula números
Este é o princípio arquitetural mais importante do sistema, e por isso está repetido em vários pontos do código:

1. **Extração (Fases 1 e 2):** o Gemini só extrai dados *literais* do documento (Structured Output com `responseSchema` fixo). Se não tiver certeza, retorna `null` ou registra em `observacoes_para_conferencia_humana` / `alertas` — nunca "estima".
2. **Validação de extratos:** a checagem `saldo inicial + entradas − saídas = saldo final` (`src/lib/calc/reconciliation.ts`) é código puro. A IA nunca "conserta" uma divergência — ela é sinalizada com um selo vermelho de conferência obrigatória para o perito.
3. **Recálculo previdenciário/bancário:** `src/lib/calc/previdenciario.ts` e `src/lib/calc/price-sac.ts` implementam as regras (EC 113/2021, Resolução CJF 784/2022, Súmula 111/STJ, Price/SAC) em TypeScript determinístico, consultando as séries oficiais do BACEN (`src/lib/calc/bacen.ts`).
4. **Minuta do laudo (Fase 4):** a IA recebe o resultado do cálculo já pronto (`resultadoCalculo`) e só pode **citar números que já estão nesse objeto** — nunca calcular ou arredondar de forma diferente. Além disso, só pode citar normas de uma whitelist fixa (`LEIS_E_SUMULAS_PERMITIDAS` em `src/lib/gemini/prompts.ts`), o que evita alucinação de leis/súmulas inexistentes.

## Setup local

```bash
cp .env.example .env.local
# preencha NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
# SUPABASE_SERVICE_ROLE_KEY e GOOGLE_GEMINI_API_KEY

npm install
```

### 1. Banco de dados
No painel do Supabase (SQL Editor), rode `supabase/schema.sql`. Ele cria:
- Tabelas multitenant (`organizations`, `profiles`, `forensic_cases`, `case_documents`, `case_questions`, `statement_entries`, `calculation_runs`, `calculation_installments`, `report_drafts`, `audit_log`).
- **Row Level Security** ativado em todas as tabelas, isolando os dados por `org_id` — a base do White Label multitenant.

### 2. Storage
Crie um bucket **privado** chamado `case-files` (painel do Supabase → Storage, ou CLI):
```bash
supabase storage buckets create case-files --private
```
Path convention usada pelo `FileUploader`: `{caseId}/{fileType}/{timestamp}-{fileName}`.

### 3. Rodar
```bash
npm run dev
```

## Fluxo do produto (4 fases)
| Fase | Tela | Rota de API | Motor |
|---|---|---|---|
| 1. Triagem | `/casos/[id]` aba Triagem | `POST /api/gemini/extract-processo` | Gemini (Structured Output) |
| 2. OCR de Extratos | aba Extratos | `POST /api/gemini/extract-extrato` | Gemini + `reconciliarExtrato()` (determinístico) |
| 3. Recálculo | aba Cálculo | `POST /api/calculo/demonstrativo` | `calcularPrevidenciario()` (determinístico, consulta BACEN) |
| 4. Minuta do Laudo | aba Laudo | `POST /api/gemini/gerar-laudo` | Gemini, ancorado no resultado da Fase 3 |

## LGPD
`src/lib/lgpd/anonymize.ts` mascara CPF/CNPJ/conta-agência com tokens reversíveis antes de reenviar texto já extraído para novas chamadas de IA (ex.: geração da minuta), controlado pela flag `ENABLE_ANONYMIZATION_BEFORE_AI`.

## White Label / Multitenancy
- `organizations.slug`, `logo_url`, `primary_color` já estão no schema para customização visual por tenant.
- Toda query nas tabelas de negócio é filtrada implicitamente por `org_id` via RLS (`auth_org_id()`), então o isolamento entre peritos/escritórios é garantido no banco, não apenas na aplicação.

## Hooks preparados para Mercado Pago
`organizations.plan` e `organizations.mercadopago_customer_id` já existem no schema. Para o MVP, a integração real de cobrança/assinatura (checkout, webhook de confirmação de pagamento) fica como próximo passo — o campo `MERCADOPAGO_ACCESS_TOKEN` já está reservado em `.env.example`.

## O que este MVP entrega vs. próximos passos
**Entregue:**
- Schema completo com RLS multitenant.
- Pipeline de triagem processual via IA com Structured Output anti-alucinação.
- OCR de extratos + reconciliação determinística de saldo com alerta obrigatório.
- Motor de recálculo previdenciário (IPCA-E/INPC → SELIC pós-EC 113/2021) consultando o BACEN, com honorários pela Súmula 111/STJ.
- Comparador Price × SAC e checagem de taxa média de mercado (perícia bancária).
- Geração de minuta de laudo ancorada nos números já calculados.
- UI completa do fluxo de 4 fases, autenticação e multitenancy.

**Próximos passos sugeridos:**
- Parser de planilhas Excel/CSV (a extração de extrato hoje cobre PDF/imagem via Gemini; para `.xlsx/.csv` já estruturados, vale um parser determinístico com a lib `xlsx` já incluída em `package.json`, sem precisar de IA).
- Exportação da minuta final para `.docx`/`.pdf` formatado nos moldes do CPC.
- Editor de quesitos com aprovação (`case_questions.is_approved`) integrado à tela de laudo.
- Checkout Mercado Pago + webhook de assinatura.
- Customização de tema (logo/cor) por organização lida de `organizations.primary_color` no layout.
