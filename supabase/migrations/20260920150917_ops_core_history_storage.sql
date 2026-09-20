
alter table ops_core.projects
  add column if not exists completed_at timestamptz,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by text,
  add column if not exists archive_reason text,
  add column if not exists reporting_year integer;

alter table ops_core.items
  add column if not exists completed_at timestamptz;

update ops_core.items
set completed_at=coalesce(completed_at,updated_at)
where current_status='completed' and completed_at is null;

create table if not exists ops_core.legacy_tracking_history (
  id uuid primary key default gen_random_uuid(),
  snapshot_scope text not null check (snapshot_scope in ('current','archive')),
  source_key text not null,
  source_row_id bigint not null,
  source_version bigint,
  synced_at timestamptz,
  project_core text not null,
  project_display text,
  item_key text,
  item text,
  drawing text,
  line_number text,
  observations text,
  client text,
  vessel text,
  project_type text,
  pm text,
  priority text,
  current_stage text,
  current_status text,
  start_date date,
  finish_date date,
  project_finish_date date,
  fabrication_start date,
  overall_progress numeric,
  weight_kg numeric,
  m2 numeric,
  project_finished boolean not null default false,
  status_text text,
  archive_source text,
  reporting_date date,
  reporting_year integer,
  date_quality_status text not null default 'OK',
  source_payload jsonb not null default '{}'::jsonb,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_key,source_row_id)
);

create index if not exists legacy_tracking_history_project_idx
  on ops_core.legacy_tracking_history(project_core,reporting_year);
create index if not exists legacy_tracking_history_year_idx
  on ops_core.legacy_tracking_history(reporting_year,snapshot_scope,project_finished);
create index if not exists legacy_tracking_history_client_idx
  on ops_core.legacy_tracking_history(client);

create table if not exists ops_core.legacy_on_hold_history (
  id uuid primary key default gen_random_uuid(),
  source_hold_id uuid not null unique,
  entity_key text,
  project_core text,
  project_display text,
  legacy_project_row_id bigint,
  legacy_spool_row_id bigint,
  iso text,
  client text,
  vessel text,
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_hours numeric,
  hold_status text not null,
  detected_status text,
  source_cache_updated_at timestamptz,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists legacy_on_hold_project_idx
  on ops_core.legacy_on_hold_history(project_core,started_at);
create index if not exists legacy_on_hold_started_idx
  on ops_core.legacy_on_hold_history(started_at);

create table if not exists ops_core.hold_periods (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references ops_core.projects(id) on delete cascade,
  item_id uuid references ops_core.items(id) on delete cascade,
  project_core text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  reason text,
  source_system text not null default 'ops_core',
  source_ref text,
  created_by text,
  ended_by text,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists hold_periods_project_idx on ops_core.hold_periods(project_core,started_at);
create unique index if not exists one_open_hold_per_item_idx
  on ops_core.hold_periods(item_id) where item_id is not null and ended_at is null;

alter table ops_core.legacy_tracking_history enable row level security;
alter table ops_core.legacy_on_hold_history enable row level security;
alter table ops_core.hold_periods enable row level security;
revoke all on ops_core.legacy_tracking_history,ops_core.legacy_on_hold_history,ops_core.hold_periods from anon,authenticated;
grant all on ops_core.legacy_tracking_history,ops_core.legacy_on_hold_history,ops_core.hold_periods to service_role;

create or replace function ops_core.valid_reporting_date(
  p_project_finish date,
  p_finish date,
  p_start date
)
returns date
language sql
immutable
as $$
  select case
    when p_project_finish between date '2000-01-01' and date '2100-12-31' then p_project_finish
    when p_finish between date '2000-01-01' and date '2100-12-31' then p_finish
    when p_start between date '2000-01-01' and date '2100-12-31' then p_start
    else null
  end;
$$;

create or replace function ops_core.refresh_legacy_history()
returns jsonb
language plpgsql
security definer
set search_path=ops_core,ops_panel,public
as $$
declare
  v_archive integer:=0;
  v_current integer:=0;
  v_hold integer:=0;
begin
  insert into ops_core.legacy_tracking_history(
    snapshot_scope,source_key,source_row_id,source_version,synced_at,
    project_core,project_display,item_key,item,drawing,line_number,observations,
    client,vessel,project_type,pm,priority,current_stage,current_status,
    start_date,finish_date,project_finish_date,fabrication_start,overall_progress,
    weight_kg,m2,project_finished,status_text,archive_source,
    reporting_date,reporting_year,date_quality_status,source_payload,updated_at
  )
  select
    'archive',
    a.source_key,
    a.source_row_id,
    a.source_version,
    a.synced_at,
    ops_core.normalize_project_core(a.project_key),
    a.project_key,
    a.item_key,
    a.item,
    a.drawing,
    a.line_number,
    a.observations,
    a.client,
    a.vessel,
    a.project_type,
    a.pm,
    a.priority,
    a.current_stage,
    a.current_status,
    a.start_date,
    a.finish_date,
    a.project_finish_date,
    a.fabrication_start,
    a.overall_progress,
    a.weight_kg,
    a.m2,
    coalesce(a.project_finished,false),
    a.status_text,
    a.archive_source,
    ops_core.valid_reporting_date(a.project_finish_date,a.finish_date,a.start_date),
    extract(year from ops_core.valid_reporting_date(a.project_finish_date,a.finish_date,a.start_date))::integer,
    case when ops_core.valid_reporting_date(a.project_finish_date,a.finish_date,a.start_date) is null then 'INVALID_OR_MISSING_DATE' else 'OK' end,
    jsonb_build_object(
      'archive_rank',a.archive_rank,
      'rn',a.rn,
      'source_key',a.source_key
    ),
    now()
  from ops_panel.tracking_archive_items a
  where ops_core.normalize_project_core(a.project_key) is not null
  on conflict(source_key,source_row_id) do update set
    source_version=excluded.source_version,
    synced_at=excluded.synced_at,
    project_core=excluded.project_core,
    project_display=excluded.project_display,
    item_key=excluded.item_key,
    item=excluded.item,
    drawing=excluded.drawing,
    line_number=excluded.line_number,
    observations=excluded.observations,
    client=excluded.client,
    vessel=excluded.vessel,
    project_type=excluded.project_type,
    pm=excluded.pm,
    priority=excluded.priority,
    current_stage=excluded.current_stage,
    current_status=excluded.current_status,
    start_date=excluded.start_date,
    finish_date=excluded.finish_date,
    project_finish_date=excluded.project_finish_date,
    fabrication_start=excluded.fabrication_start,
    overall_progress=excluded.overall_progress,
    weight_kg=excluded.weight_kg,
    m2=excluded.m2,
    project_finished=excluded.project_finished,
    status_text=excluded.status_text,
    archive_source=excluded.archive_source,
    reporting_date=excluded.reporting_date,
    reporting_year=excluded.reporting_year,
    date_quality_status=excluded.date_quality_status,
    source_payload=excluded.source_payload,
    updated_at=now();
  get diagnostics v_archive=row_count;

  insert into ops_core.legacy_tracking_history(
    snapshot_scope,source_key,source_row_id,source_version,synced_at,
    project_core,project_display,item_key,item,drawing,line_number,observations,
    client,vessel,project_type,pm,priority,current_stage,current_status,
    start_date,finish_date,project_finish_date,fabrication_start,overall_progress,
    weight_kg,m2,project_finished,status_text,archive_source,
    reporting_date,reporting_year,date_quality_status,source_payload,updated_at
  )
  select
    'current',
    'tracking_current',
    a.source_row_id,
    a.source_version,
    a.synced_at,
    ops_core.normalize_project_core(a.project_key),
    a.project_key,
    a.item_key,
    a.item,
    a.drawing,
    a.line_number,
    a.observations,
    a.client,
    a.vessel,
    a.project_type,
    a.pm,
    a.priority,
    a.current_stage,
    a.current_status,
    a.start_date,
    a.finish_date,
    a.project_finish_date,
    a.fabrication_start,
    a.overall_progress,
    a.weight_kg,
    a.m2,
    coalesce(a.project_finished,false),
    a.status_text,
    null,
    ops_core.valid_reporting_date(a.project_finish_date,a.finish_date,a.start_date),
    extract(year from ops_core.valid_reporting_date(a.project_finish_date,a.finish_date,a.start_date))::integer,
    case when ops_core.valid_reporting_date(a.project_finish_date,a.finish_date,a.start_date) is null then 'INVALID_OR_MISSING_DATE' else 'OK' end,
    jsonb_build_object('source','tracking_current'),
    now()
  from ops_panel.tracking_current_items a
  where ops_core.normalize_project_core(a.project_key) is not null
  on conflict(source_key,source_row_id) do update set
    source_version=excluded.source_version,
    synced_at=excluded.synced_at,
    project_core=excluded.project_core,
    project_display=excluded.project_display,
    item_key=excluded.item_key,
    item=excluded.item,
    drawing=excluded.drawing,
    line_number=excluded.line_number,
    observations=excluded.observations,
    client=excluded.client,
    vessel=excluded.vessel,
    project_type=excluded.project_type,
    pm=excluded.pm,
    priority=excluded.priority,
    current_stage=excluded.current_stage,
    current_status=excluded.current_status,
    start_date=excluded.start_date,
    finish_date=excluded.finish_date,
    project_finish_date=excluded.project_finish_date,
    fabrication_start=excluded.fabrication_start,
    overall_progress=excluded.overall_progress,
    weight_kg=excluded.weight_kg,
    m2=excluded.m2,
    project_finished=excluded.project_finished,
    status_text=excluded.status_text,
    reporting_date=excluded.reporting_date,
    reporting_year=excluded.reporting_year,
    date_quality_status=excluded.date_quality_status,
    source_payload=excluded.source_payload,
    updated_at=now();
  get diagnostics v_current=row_count;

  insert into ops_core.legacy_on_hold_history(
    source_hold_id,entity_key,project_core,project_display,
    legacy_project_row_id,legacy_spool_row_id,iso,client,vessel,
    started_at,ended_at,duration_hours,hold_status,detected_status,
    source_cache_updated_at,updated_at
  )
  select
    h.id,
    h.entity_key,
    ops_core.normalize_project_core(h.project_number),
    h.project_display,
    h.project_row_id,
    h.spool_row_id,
    h.iso,
    h.client,
    h.vessel,
    h.started_at,
    h.ended_at,
    round((extract(epoch from (coalesce(h.ended_at,now())-h.started_at))/3600.0)::numeric,2),
    case when h.ended_at is null then 'OPEN' else 'CLOSED' end,
    h.detected_status,
    h.source_cache_updated_at,
    now()
  from public.operations_on_hold_periods h
  on conflict(source_hold_id) do update set
    project_core=excluded.project_core,
    project_display=excluded.project_display,
    legacy_project_row_id=excluded.legacy_project_row_id,
    legacy_spool_row_id=excluded.legacy_spool_row_id,
    iso=excluded.iso,
    client=excluded.client,
    vessel=excluded.vessel,
    started_at=excluded.started_at,
    ended_at=excluded.ended_at,
    duration_hours=excluded.duration_hours,
    hold_status=excluded.hold_status,
    detected_status=excluded.detected_status,
    source_cache_updated_at=excluded.source_cache_updated_at,
    updated_at=now();
  get diagnostics v_hold=row_count;

  return jsonb_build_object(
    'ok',true,
    'archive_rows_upserted',v_archive,
    'current_rows_upserted',v_current,
    'hold_rows_upserted',v_hold,
    'refreshed_at',now()
  );
end $$;

select ops_core.refresh_legacy_history();

grant execute on function ops_core.refresh_legacy_history() to service_role;
