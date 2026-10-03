
create schema if not exists ops_core;
create extension if not exists pgcrypto;

create or replace function ops_core.normalize_project_core(value text)
returns text
language sql
immutable
as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        regexp_replace(upper(trim(coalesce(value,''))), '[–—−]', '-', 'g'),
        '^(BSP|BEP|BPP|B3D|SP)[[:space:]-]*', '', 'i'
      ),
      '[[:space:]]+', '', 'g'
    ),
    ''
  );
$$;

create or replace function ops_core.normalize_alias(value text)
returns text
language sql
immutable
as $$
  select nullif(regexp_replace(upper(coalesce(value,'')), '[^A-Z0-9]', '', 'g'),'');
$$;

create or replace function ops_core.detect_prefix(value text)
returns text
language sql
immutable
as $$
  select nullif((regexp_match(upper(trim(coalesce(value,''))), '^(BSP|BEP|BPP|B3D|SP)'))[1],'');
$$;

create table if not exists ops_core.projects (
  id uuid primary key default gen_random_uuid(),
  region text not null default 'BR',
  project_core text not null,
  project_prefix text,
  display_code text not null,
  client text,
  vessel text,
  pm text,
  customer_po text,
  client_reference text,
  project_type text,
  project_status text not null default 'ACTIVE',
  priority text,
  acceptance_date date,
  contractual_date date,
  deadline_date date,
  replanned_finish date,
  drawing_approval_date date,
  fabrication_start date,
  source_mode text not null default 'legacy_tracking'
    check (source_mode in ('legacy_tracking','ops_core','archived')),
  validation_status text not null default 'imported'
    check (validation_status in ('discovered','collecting','parsed','reconciled','validation_required','validated','rejected','imported')),
  legacy_project_row_id text,
  legacy_snapshot jsonb not null default '{}'::jsonb,
  source_metadata jsonb not null default '{}'::jsonb,
  validated_at timestamptz,
  validated_by text,
  cutover_at timestamptz,
  cutover_by text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(region, project_core)
);

create table if not exists ops_core.project_aliases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references ops_core.projects(id) on delete cascade,
  region text not null default 'BR',
  alias text not null,
  alias_norm text not null,
  source_system text not null default 'manual',
  created_at timestamptz not null default now(),
  unique(region, alias_norm)
);

create table if not exists ops_core.items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references ops_core.projects(id) on delete cascade,
  item_key text not null,
  item_type text not null default 'SPOOL'
    check (item_type in ('SPOOL','SUPPORT','STRUCTURE','FRAME','OTHER')),
  iso_code text,
  spool_code text,
  tag_number text,
  drawing_code text,
  line_number text,
  description text,
  material text,
  size text,
  schedule text,
  weight_kg numeric,
  painting_m2 numeric,
  quantity numeric,
  joints numeric,
  hdg_kg numeric,
  fbe_required boolean,
  requires_3d boolean,
  requires_assembly_simulation boolean,
  current_stage_key text,
  current_status text not null default 'new',
  planned_start date,
  planned_finish date,
  fabrication_start date,
  overall_progress numeric not null default 0,
  visible_to_client boolean not null default true,
  removed_from_scope boolean not null default false,
  removed_by_revision_id uuid,
  legacy_iso_key text,
  legacy_project_row_id text,
  legacy_raw jsonb not null default '{}'::jsonb,
  source_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, item_key)
);

create table if not exists ops_core.workflow_stages (
  stage_key text primary key,
  stage_order integer not null unique,
  name text not null,
  sector_key text not null,
  execution_mode text not null default 'manual'
    check (execution_mode in ('manual','apontamento','automatic','integration')),
  photo_policy text not null default 'none'
    check (photo_policy in ('required_start_finish','optional','none')),
  hh_activity_keys text[] not null default '{}',
  default_sla_minutes integer,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb
);

insert into ops_core.workflow_stages(stage_key,stage_order,name,sector_key,execution_mode,photo_policy,hh_activity_keys,default_sla_minutes)
values
('drawing',10,'Emissão de detalhamento','engenharia','integration','none','{}',480),
('stock',20,'Verificando estoque','suprimentos','integration','none','{}',240),
('material',30,'Separação de material','suprimentos','integration','none','{}',360),
('preassembly',40,'Caldeiraria / Pré-montagem','caldeiraria','apontamento','required_start_finish',array['fitup','montagem','suporte'],360),
('scan-initial',50,'3D Scan Inicial','qualidade','integration','optional','{}',180),
('welding',60,'Solda','solda','apontamento','required_start_finish',array['solda','reparo','retrabalho'],480),
('nde',70,'END / NDE','qualidade','manual','optional','{}',240),
('scan-final',80,'3D Scan Final','qualidade','integration','optional','{}',180),
('assembly-simulation',85,'Simulação de Montagem','qualidade','integration','optional','{}',240),
('hydro',90,'TH / Teste Hidrostático','qualidade','apontamento','optional',array['hydro_test'],240),
('painting',100,'Pintura / HDG / FBE','pintura','apontamento','required_start_finish',array['pintura'],480),
('final-inspection',110,'Unitização e Inspeção Final','qualidade','manual','optional',array['inspecao'],180),
('package',120,'Preparado para envio','expedicao','manual','none','{}',240)
on conflict(stage_key) do update set
  stage_order=excluded.stage_order,
  name=excluded.name,
  sector_key=excluded.sector_key,
  execution_mode=excluded.execution_mode,
  photo_policy=excluded.photo_policy,
  hh_activity_keys=excluded.hh_activity_keys,
  default_sla_minutes=excluded.default_sla_minutes,
  active=true;

create table if not exists ops_core.item_stages (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references ops_core.items(id) on delete cascade,
  stage_key text not null references ops_core.workflow_stages(stage_key),
  stage_order integer not null,
  is_applicable boolean not null default true,
  progress numeric,
  status text not null default 'pending'
    check (status in ('pending','available','accepted','in_progress','waiting','blocked','completed','skipped','on_hold')),
  planned_date date,
  forecast_date date,
  actual_date date,
  action text,
  source_system text not null default 'ops_core',
  source_ref text,
  entered_at timestamptz,
  accepted_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  updated_by text,
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  unique(item_id, stage_key)
);

create table if not exists ops_core.stage_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references ops_core.projects(id) on delete cascade,
  item_id uuid not null references ops_core.items(id) on delete cascade,
  item_stage_id uuid references ops_core.item_stages(id) on delete set null,
  event_type text not null,
  stage_key text,
  sector_key text,
  progress_from numeric,
  progress_to numeric,
  actor_email text,
  actor_name text,
  source_system text not null,
  source_event_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_ops_core_stage_event_source
  on ops_core.stage_events(source_system, source_event_id)
  where source_event_id is not null;

create table if not exists ops_core.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references ops_core.projects(id) on delete cascade,
  document_key text not null,
  document_type text not null default 'DRAWING',
  document_number text,
  title text,
  current_revision text,
  current_status text,
  requires_3d boolean,
  requires_assembly_simulation boolean,
  source_system text not null default 'drawing',
  source_row_id bigint,
  source_version bigint,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, document_key)
);

create table if not exists ops_core.document_revisions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references ops_core.documents(id) on delete cascade,
  revision text not null,
  source_version bigint,
  file_hash text,
  is_current boolean not null default false,
  status text not null default 'current'
    check (status in ('current','superseded','lower_revision','same_revision_changed','processing_error')),
  changed_fields jsonb not null default '{}'::jsonb,
  source_payload jsonb not null default '{}'::jsonb,
  detected_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(document_id, revision, source_version)
);

create unique index if not exists uq_ops_core_document_current
  on ops_core.document_revisions(document_id)
  where is_current;

alter table ops_core.items
  drop constraint if exists items_removed_by_revision_id_fkey;
alter table ops_core.items
  add constraint items_removed_by_revision_id_fkey
  foreign key (removed_by_revision_id) references ops_core.document_revisions(id) on delete set null;

create table if not exists ops_core.document_item_links (
  document_id uuid not null references ops_core.documents(id) on delete cascade,
  item_id uuid not null references ops_core.items(id) on delete cascade,
  link_type text not null default 'drawing',
  created_at timestamptz not null default now(),
  primary key(document_id,item_id,link_type)
);

create table if not exists ops_core.legacy_source_map (
  id uuid primary key default gen_random_uuid(),
  source_system text not null,
  source_type text not null,
  source_project_row_id text,
  source_item_key text,
  source_id text,
  project_id uuid references ops_core.projects(id) on delete cascade,
  item_id uuid references ops_core.items(id) on delete cascade,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_ops_core_legacy_source_map
  on ops_core.legacy_source_map(
    source_system,
    source_type,
    coalesce(source_project_row_id,''),
    coalesce(source_item_key,''),
    coalesce(source_id,'')
  );

create table if not exists ops_core.registration_candidates (
  id uuid primary key default gen_random_uuid(),
  region text not null default 'BR',
  project_core text not null,
  display_code text not null,
  candidate_status text not null default 'discovered'
    check (candidate_status in ('discovered','collecting','parsed','reconciled','validation_required','validated','rejected')),
  source_systems text[] not null default '{}',
  suggested_data jsonb not null default '{}'::jsonb,
  conflicts jsonb not null default '[]'::jsonb,
  discovered_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  validated_project_id uuid references ops_core.projects(id) on delete set null,
  unique(region,project_core)
);

create table if not exists ops_core.handoffs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references ops_core.projects(id) on delete cascade,
  item_id uuid not null references ops_core.items(id) on delete cascade,
  from_stage_key text,
  from_sector_key text,
  to_stage_key text not null,
  to_sector_key text not null,
  status text not null default 'available'
    check (status in ('available','accepted','completed','cancelled','rejected')),
  dedup_key text not null unique,
  available_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by text,
  completed_at timestamptz,
  note text,
  source_event_id uuid references ops_core.stage_events(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists ops_core.notifications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references ops_core.projects(id) on delete cascade,
  item_id uuid references ops_core.items(id) on delete cascade,
  handoff_id uuid references ops_core.handoffs(id) on delete set null,
  sector_key text,
  recipient_email text,
  notification_type text not null,
  title text not null,
  message text not null,
  severity text not null default 'info'
    check (severity in ('info','success','warning','danger')),
  dedup_key text unique,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  acknowledged_at timestamptz,
  resolved_at timestamptz
);

create table if not exists ops_core.audit_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references ops_core.projects(id) on delete cascade,
  item_id uuid references ops_core.items(id) on delete cascade,
  document_id uuid references ops_core.documents(id) on delete cascade,
  entity_type text not null,
  entity_id text,
  action text not null,
  actor_email text,
  source_system text not null default 'ops_core',
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_ops_core_projects_mode on ops_core.projects(region,source_mode,active);
create index if not exists idx_ops_core_items_project on ops_core.items(project_id,current_status,current_stage_key);
create index if not exists idx_ops_core_item_stages_queue on ops_core.item_stages(stage_key,status,entered_at);
create index if not exists idx_ops_core_stage_events_item on ops_core.stage_events(item_id,created_at desc);
create index if not exists idx_ops_core_documents_project on ops_core.documents(project_id,updated_at desc);
create index if not exists idx_ops_core_candidates_status on ops_core.registration_candidates(region,candidate_status,last_seen_at desc);
create index if not exists idx_ops_core_handoffs_queue on ops_core.handoffs(to_sector_key,status,available_at);
create index if not exists idx_ops_core_notifications_sector on ops_core.notifications(sector_key,read_at,created_at desc);

alter table ops_core.projects enable row level security;
alter table ops_core.project_aliases enable row level security;
alter table ops_core.items enable row level security;
alter table ops_core.workflow_stages enable row level security;
alter table ops_core.item_stages enable row level security;
alter table ops_core.stage_events enable row level security;
alter table ops_core.documents enable row level security;
alter table ops_core.document_revisions enable row level security;
alter table ops_core.document_item_links enable row level security;
alter table ops_core.legacy_source_map enable row level security;
alter table ops_core.registration_candidates enable row level security;
alter table ops_core.handoffs enable row level security;
alter table ops_core.notifications enable row level security;
alter table ops_core.audit_events enable row level security;

revoke all on schema ops_core from public, anon, authenticated;
revoke all on all tables in schema ops_core from public, anon, authenticated;
revoke all on all sequences in schema ops_core from public, anon, authenticated;

create or replace function ops_core.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at=now();
  return new;
end $$;

drop trigger if exists trg_ops_core_projects_touch on ops_core.projects;
create trigger trg_ops_core_projects_touch before update on ops_core.projects
for each row execute function ops_core.touch_updated_at();

drop trigger if exists trg_ops_core_items_touch on ops_core.items;
create trigger trg_ops_core_items_touch before update on ops_core.items
for each row execute function ops_core.touch_updated_at();

drop trigger if exists trg_ops_core_documents_touch on ops_core.documents;
create trigger trg_ops_core_documents_touch before update on ops_core.documents
for each row execute function ops_core.touch_updated_at();
