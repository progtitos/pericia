-- =========================================================
-- PeríciaAI / ExpertSystem — Schema Multitenant (Supabase/Postgres)
-- =========================================================
create extension if not exists "pgcrypto";

-- ---------- ORGANIZATIONS (White Label) ----------
create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name varchar(255) not null,
  slug varchar(255) unique not null,
  logo_url text,
  primary_color varchar(50) default '#0f172a',
  plan varchar(50) default 'trial', -- 'trial', 'pro', 'enterprise' (referenciado pelo módulo Mercado Pago)
  mercadopago_customer_id text,
  created_at timestamptz default now()
);

-- ---------- PROFILES ----------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid references organizations(id) on delete cascade,
  full_name text,
  role varchar(50) default 'expert', -- 'admin' | 'expert' | 'assistant'
  created_at timestamptz default now()
);

-- ---------- FORENSIC CASES ----------
create table if not exists forensic_cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  process_number varchar(100) not null,
  court_name text,
  plaintiff text,
  defendant text,
  case_type varchar(50), -- 'previdenciario' | 'bancario_financiamento' | 'cartao_credito' | 'sfh'
  status varchar(50) default 'triagem', -- 'triagem' | 'calculo' | 'redacao' | 'concluido'
  metadata jsonb default '{}'::jsonb, -- DIB, DER, RMI, citação, índices, taxa contratada, etc.
  created_by uuid references profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---------- CASE DOCUMENTS ----------
create table if not exists case_documents (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references forensic_cases(id) on delete cascade,
  file_name text not null,
  file_path text not null, -- Supabase Storage bucket path
  file_type varchar(50), -- 'processo_pdf' | 'extrato_pdf' | 'planilha_excel'
  extracted_text text,
  extracted_json jsonb, -- saída estruturada do Gemini (Structured Output)
  ocr_status varchar(50) default 'pending', -- 'pending' | 'processing' | 'done' | 'error'
  anonymized boolean default false,
  created_at timestamptz default now()
);

-- ---------- CASE QUESTIONS (Quesitos) ----------
create table if not exists case_questions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references forensic_cases(id) on delete cascade,
  author varchar(50), -- 'juiz' | 'autor' | 'reu'
  question_number int,
  question_text text not null,
  proposed_answer text,
  is_approved boolean default false,
  created_at timestamptz default now()
);

-- ---------- BANK STATEMENT LINES (linhas normalizadas de extrato) ----------
create table if not exists statement_entries (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references case_documents(id) on delete cascade,
  case_id uuid references forensic_cases(id) on delete cascade,
  entry_date date not null,
  description text,
  debit numeric(18,2) default 0,
  credit numeric(18,2) default 0,
  running_balance numeric(18,2),
  ocr_confidence numeric(4,3), -- 0.000 a 1.000
  flagged_for_review boolean default false, -- true quando reconciliação falha
  created_at timestamptz default now()
);

-- ---------- CALCULATION RUNS (auditável: cada recálculo gera uma versão) ----------
create table if not exists calculation_runs (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references forensic_cases(id) on delete cascade,
  run_type varchar(50), -- 'previdenciario' | 'bancario'
  parameters jsonb not null, -- DIB/DER/RMI, taxa, sistema (price/sac), datas-base
  result_summary jsonb, -- valor final líquido, totais, honorários (Súmula 111)
  created_by uuid references profiles(id),
  created_at timestamptz default now()
);

create table if not exists calculation_installments (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references calculation_runs(id) on delete cascade,
  competence date not null, -- mês/ano de referência
  original_value numeric(18,2),
  index_applied varchar(30), -- 'IPCA-E' | 'INPC' | 'SELIC' | 'POUPANCA'
  index_rate numeric(10,6),
  monetary_correction numeric(18,2),
  interest_value numeric(18,2),
  corrected_value numeric(18,2),
  created_at timestamptz default now()
);

-- ---------- REPORT DRAFTS (Minutas de Laudo) ----------
create table if not exists report_drafts (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references forensic_cases(id) on delete cascade,
  run_id uuid references calculation_runs(id),
  content_markdown text not null,
  version int default 1,
  generated_by_ai boolean default true,
  reviewed boolean default false,
  created_at timestamptz default now()
);

-- ---------- AUDIT LOG (rastreabilidade pericial) ----------
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  actor_id uuid references profiles(id),
  case_id uuid references forensic_cases(id),
  action text not null, -- 'upload_document' | 'run_calculation' | 'generate_report' | 'approve_question'
  details jsonb,
  created_at timestamptz default now()
);

-- =========================================================
-- ROW LEVEL SECURITY
-- =========================================================
alter table organizations enable row level security;
alter table profiles enable row level security;
alter table forensic_cases enable row level security;
alter table case_documents enable row level security;
alter table case_questions enable row level security;
alter table statement_entries enable row level security;
alter table calculation_runs enable row level security;
alter table calculation_installments enable row level security;
alter table report_drafts enable row level security;
alter table audit_log enable row level security;

-- Helper: retorna o org_id do usuário autenticado atual
create or replace function auth_org_id()
returns uuid
language sql
security definer
stable
as $$
  select org_id from profiles where id = auth.uid();
$$;

-- Helper: retorna o role do usuário autenticado atual
create or replace function auth_role()
returns varchar
language sql
security definer
stable
as $$
  select role from profiles where id = auth.uid();
$$;

-- ORGANIZATIONS: usuário só vê/edita a própria organização
create policy "org_select_own" on organizations
  for select using (id = auth_org_id());
create policy "org_update_admin" on organizations
  for update using (id = auth_org_id() and auth_role() = 'admin');

-- PROFILES: usuário vê colegas da mesma org; só admin edita outros perfis
create policy "profiles_select_same_org" on profiles
  for select using (org_id = auth_org_id());
create policy "profiles_update_self_or_admin" on profiles
  for update using (id = auth.uid() or auth_role() = 'admin');
create policy "profiles_insert_self" on profiles
  for insert with check (id = auth.uid());

-- FORENSIC_CASES: isolado por org_id (multitenancy)
create policy "cases_select_same_org" on forensic_cases
  for select using (org_id = auth_org_id());
create policy "cases_insert_same_org" on forensic_cases
  for insert with check (org_id = auth_org_id());
create policy "cases_update_same_org" on forensic_cases
  for update using (org_id = auth_org_id());
create policy "cases_delete_admin_only" on forensic_cases
  for delete using (org_id = auth_org_id() and auth_role() = 'admin');

-- CASE_DOCUMENTS: via join implícito ao caso (mesma org)
create policy "documents_select_same_org" on case_documents
  for select using (
    case_id in (select id from forensic_cases where org_id = auth_org_id())
  );
create policy "documents_insert_same_org" on case_documents
  for insert with check (
    case_id in (select id from forensic_cases where org_id = auth_org_id())
  );
create policy "documents_update_same_org" on case_documents
  for update using (
    case_id in (select id from forensic_cases where org_id = auth_org_id())
  );

-- CASE_QUESTIONS
create policy "questions_select_same_org" on case_questions
  for select using (
    case_id in (select id from forensic_cases where org_id = auth_org_id())
  );
create policy "questions_write_same_org" on case_questions
  for all using (
    case_id in (select id from forensic_cases where org_id = auth_org_id())
  );

-- STATEMENT_ENTRIES
create policy "statement_entries_same_org" on statement_entries
  for all using (
    case_id in (select id from forensic_cases where org_id = auth_org_id())
  );

-- CALCULATION_RUNS / INSTALLMENTS
create policy "calc_runs_same_org" on calculation_runs
  for all using (
    case_id in (select id from forensic_cases where org_id = auth_org_id())
  );
create policy "calc_installments_same_org" on calculation_installments
  for all using (
    run_id in (
      select cr.id from calculation_runs cr
      join forensic_cases fc on fc.id = cr.case_id
      where fc.org_id = auth_org_id()
    )
  );

-- REPORT_DRAFTS
create policy "reports_same_org" on report_drafts
  for all using (
    case_id in (select id from forensic_cases where org_id = auth_org_id())
  );

-- AUDIT_LOG (somente leitura para não-admin; insert liberado via service role)
create policy "audit_select_same_org" on audit_log
  for select using (org_id = auth_org_id());

-- =========================================================
-- STORAGE (Supabase Storage) — bucket privado por organização
-- Execute também via painel/CLI do Supabase (buckets não são 100% via SQL puro):
--   supabase storage buckets create case-files --private
-- Policy de storage (ilustrativa, ajustar path convention: {org_id}/{case_id}/{file}):
-- =========================================================
-- create policy "case_files_same_org" on storage.objects
--   for all using (
--     bucket_id = 'case-files'
--     and (storage.foldername(name))[1] = auth_org_id()::text
--   );
