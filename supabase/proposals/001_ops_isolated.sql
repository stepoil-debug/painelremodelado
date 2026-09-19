-- STEP Operational Flow · PROPOSTA DE SCHEMA ISOLADO
-- NÃO EXECUTAR EM PRODUÇÃO SEM REVISÃO E APROVAÇÃO.
-- Este arquivo fica em /supabase/proposals de propósito e NÃO em /migrations.
-- Objetivo: criar o motor operacional sem alterar tabelas public.hh_* existentes.

create schema if not exists ops;
create extension if not exists pgcrypto;

create table if not exists ops.sectors (
  id uuid primary key default gen_random_uuid(),
  sector_key text not null unique,
  name text not null,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ops.sector_members (
  id uuid primary key default gen_random_uuid(),
  sector_id uuid not null references ops.sectors(id) on delete cascade,
  user_id uuid,
  user_email text not null,
  user_name text,
  role_key text not null default 'member',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (sector_id, user_email)
);

create table if not exists ops.workflow_templates (
  id uuid primary key default gen_random_uuid(),
  workflow_key text not null unique,
  name text not null,
  description text,
  active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists ops.workflow_stages (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references ops.workflow_templates(id) on delete cascade,
  stage_key text not null,
  name text not null,
  sector_id uuid not null references ops.sectors(id),
  sort_order integer not null,
  execution_mode text not null default 'manual' check (execution_mode in ('manual','apontamento','automatic','integration')),
  photo_policy text not null default 'none' check (photo_policy in ('required_start_finish','optional','none')),
  handoff_policy text not null default 'require_acceptance' check (handoff_policy in ('auto_assign','require_acceptance')),
  sla_minutes integer,
  active boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  unique (workflow_id, stage_key)
);

create table if not exists ops.demands (
  id uuid primary key default gen_random_uuid(),
  demand_key text not null unique,
  workflow_id uuid references ops.workflow_templates(id),
  project_row_id text,
  project_key text,
  spool_row_id text,
  bsp_number text not null,
  iso text,
  tag_number text,
  client text,
  vessel text,
  work_order text,
  description text,
  current_stage_id uuid references ops.workflow_stages(id),
  current_sector_id uuid references ops.sectors(id),
  assigned_user_id uuid,
  assigned_user_email text,
  assigned_user_name text,
  queue_status text not null default 'new' check (queue_status in ('new','accepted','in_progress','waiting','blocked','late','completed','cancelled','on_hold')),
  priority text not null default 'normal' check (priority in ('critical','high','normal','low')),
  entered_sector_at timestamptz,
  accepted_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  sla_due_at timestamptz,
  source_system text not null default 'step_operational_panel',
  source_ref text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ops.demand_stage_history (
  id uuid primary key default gen_random_uuid(),
  demand_id uuid not null references ops.demands(id) on delete cascade,
  stage_id uuid not null references ops.workflow_stages(id),
  sector_id uuid not null references ops.sectors(id),
  status text not null,
  entered_at timestamptz not null default now(),
  accepted_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  completed_by_email text,
  completion_note text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists ops.hh_session_links (
  id uuid primary key default gen_random_uuid(),
  demand_id uuid not null references ops.demands(id) on delete cascade,
  demand_stage_history_id uuid references ops.demand_stage_history(id) on delete set null,
  hh_session_id uuid not null,
  activity_key text,
  linked_at timestamptz not null default now(),
  unique (demand_id, hh_session_id)
);

create table if not exists ops.handoffs (
  id uuid primary key default gen_random_uuid(),
  demand_id uuid not null references ops.demands(id) on delete cascade,
  from_stage_id uuid references ops.workflow_stages(id),
  to_stage_id uuid references ops.workflow_stages(id),
  from_sector_id uuid references ops.sectors(id),
  to_sector_id uuid not null references ops.sectors(id),
  status text not null default 'available' check (status in ('available','accepted','rejected','cancelled')),
  available_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by_email text,
  note text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists ops.blockers (
  id uuid primary key default gen_random_uuid(),
  demand_id uuid not null references ops.demands(id) on delete cascade,
  blocker_type text not null,
  title text not null,
  description text,
  opened_by_email text,
  opened_at timestamptz not null default now(),
  resolved_by_email text,
  resolved_at timestamptz,
  status text not null default 'open' check (status in ('open','resolved','cancelled'))
);

create table if not exists ops.events (
  id uuid primary key default gen_random_uuid(),
  demand_id uuid references ops.demands(id) on delete cascade,
  event_key text not null,
  source_system text not null,
  source_event_id text,
  actor_email text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_ops_events_source
  on ops.events(source_system, source_event_id)
  where source_event_id is not null;

create table if not exists ops.notifications (
  id uuid primary key default gen_random_uuid(),
  demand_id uuid references ops.demands(id) on delete cascade,
  event_id uuid references ops.events(id) on delete set null,
  sector_id uuid references ops.sectors(id),
  recipient_email text,
  notification_type text not null,
  title text not null,
  message text not null,
  severity text not null default 'info' check (severity in ('info','success','warning','danger')),
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  read_at timestamptz,
  acknowledged_at timestamptz,
  resolved_at timestamptz
);

create table if not exists ops.outbox (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references ops.events(id) on delete cascade,
  channel text not null default 'in_app',
  dedup_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','processing','sent','failed','cancelled')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create table if not exists ops.audit_log (
  id uuid primary key default gen_random_uuid(),
  demand_id uuid references ops.demands(id) on delete cascade,
  entity_type text not null,
  entity_id uuid,
  action text not null,
  actor_email text,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_ops_demands_sector_status on ops.demands(current_sector_id, queue_status, entered_sector_at);
create index if not exists idx_ops_demands_bsp_iso on ops.demands(bsp_number, iso);
create index if not exists idx_ops_history_demand on ops.demand_stage_history(demand_id, entered_at desc);
create index if not exists idx_ops_handoffs_target on ops.handoffs(to_sector_id, status, available_at);
create index if not exists idx_ops_notifications_recipient on ops.notifications(recipient_email, read_at, created_at desc);
create index if not exists idx_ops_outbox_pending on ops.outbox(status, available_at) where status = 'pending';

-- Seed estrutural proposto. Nada deste bloco é aplicado enquanto o arquivo continuar em /proposals.
insert into ops.sectors (sector_key, name, sort_order) values
('engenharia','Engenharia',10),
('pcp','PCP',20),
('caldeiraria','Caldeiraria',30),
('solda','Solda',40),
('qualidade','Qualidade',50),
('pintura','Pintura',60),
('expedicao','Expedição',70)
on conflict (sector_key) do nothing;

-- IMPORTANTE:
-- 1. Não há ALTER TABLE, INSERT, UPDATE ou DELETE em public.hh_*.
-- 2. hh_session_links.hh_session_id é apenas uma referência lógica ao UUID de public.hh_sessions.
-- 3. A futura ponte HH -> ops deve ser idempotente e operar por evento, nunca alterando a sessão HH.
-- 4. Políticas RLS, grants e funções transacionais devem ser definidos somente após revisão de permissões do STEP One.
