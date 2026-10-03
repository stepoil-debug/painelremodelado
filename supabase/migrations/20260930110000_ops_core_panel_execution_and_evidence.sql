-- O avanço operacional passa a ser feito pelo painel nesta fase.
-- Mantemos as chaves de HH para histórico, mas elas não bloqueiam mais a operação.
update ops_core.workflow_stages
set execution_mode = 'manual',
    metadata = coalesce(metadata, '{}'::jsonb)
      || jsonb_build_object(
        'panel_execution_mode', 'manual',
        'hh_control_disabled_at', now()
      )
where execution_mode = 'apontamento';

create table if not exists ops_core.stage_evidence (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references ops_core.items(id) on delete cascade,
  item_stage_id uuid not null references ops_core.item_stages(id) on delete cascade,
  photo_type text not null check (photo_type in ('start', 'finish', 'extra')),
  storage_bucket text not null default 'ops-evidence',
  storage_path text not null unique,
  caption text,
  taken_at timestamptz not null default now(),
  uploaded_by_email text,
  uploaded_by_name text,
  content_type text,
  file_size_bytes integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists stage_evidence_item_stage_idx
  on ops_core.stage_evidence(item_id, item_stage_id, taken_at);

alter table ops_core.stage_evidence enable row level security;
revoke all on ops_core.stage_evidence from anon, authenticated;

insert into storage.buckets(id, name, public)
values ('ops-evidence', 'ops-evidence', false)
on conflict (id) do update set public = false;
