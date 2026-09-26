-- PROPOSTA. NÃO EXECUTAR antes de validar escrita Smartsheet.
create table if not exists ops_panel.hh_tracking_outbox (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  project_row_id text not null,
  iso_key text not null,
  tracking_stage_key text not null,
  source_progress_column text not null,
  source_actual_column text,
  requested_progress numeric(6,3),
  requested_actual_date date,
  dedup_key text not null unique,
  status text not null default 'pending' check (status in ('pending','processing','sent','failed','cancelled')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
