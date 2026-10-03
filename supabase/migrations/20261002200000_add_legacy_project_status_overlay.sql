create table if not exists ops_core.panel_legacy_project_status (
  id uuid primary key default gen_random_uuid(),
  region text not null default 'BR',
  project_row_id text not null,
  project_number text not null,
  panel_status text not null check (panel_status in ('ONGOING', 'ON HOLD')),
  last_note text,
  last_actor_email text,
  last_actor_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (region, project_row_id, project_number)
);

create table if not exists ops_core.panel_legacy_project_status_events (
  id uuid primary key default gen_random_uuid(),
  status_id uuid not null references ops_core.panel_legacy_project_status(id) on delete cascade,
  region text not null,
  project_row_id text not null,
  project_number text not null,
  status_from text,
  status_to text not null,
  actor_email text,
  actor_name text,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists panel_legacy_project_status_lookup_idx
  on ops_core.panel_legacy_project_status(region, project_row_id, project_number);

create index if not exists panel_legacy_project_status_events_lookup_idx
  on ops_core.panel_legacy_project_status_events(region, project_row_id, project_number, created_at desc);

alter table ops_core.panel_legacy_project_status enable row level security;
alter table ops_core.panel_legacy_project_status_events enable row level security;
revoke all on ops_core.panel_legacy_project_status from anon, authenticated;
revoke all on ops_core.panel_legacy_project_status_events from anon, authenticated;
grant select, insert, update on ops_core.panel_legacy_project_status to service_role;
grant select, insert on ops_core.panel_legacy_project_status_events to service_role;

create or replace function public.ops_core_set_legacy_project_operational_status(
  p_region text,
  p_project_row_id text,
  p_project_number text,
  p_on_hold boolean,
  p_actor_email text default null,
  p_actor_name text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, ops_core
as $$
declare
  v_region text := coalesce(nullif(btrim(p_region), ''), 'BR');
  v_row_id text := nullif(btrim(coalesce(p_project_row_id, '')), '');
  v_number text := nullif(btrim(coalesce(p_project_number, '')), '');
  v_after text := case when p_on_hold then 'ON HOLD' else 'ONGOING' end;
  v_status ops_core.panel_legacy_project_status%rowtype;
  v_before text;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
begin
  if v_row_id is null or v_number is null then
    raise exception 'BSP legada sem identificação suficiente para controle operacional.';
  end if;

  select * into v_status
  from ops_core.panel_legacy_project_status s
  where s.region = v_region
    and s.project_row_id = v_row_id
    and s.project_number = v_number
  for update;

  v_before := v_status.panel_status;
  insert into ops_core.panel_legacy_project_status(
    id, region, project_row_id, project_number, panel_status,
    last_note, last_actor_email, last_actor_name, created_at, updated_at
  ) values (
    coalesce(v_status.id, gen_random_uuid()), v_region, v_row_id, v_number, v_after,
    v_note, p_actor_email, p_actor_name, coalesce(v_status.created_at, now()), now()
  )
  on conflict (region, project_row_id, project_number) do update set
    panel_status = excluded.panel_status,
    last_note = excluded.last_note,
    last_actor_email = excluded.last_actor_email,
    last_actor_name = excluded.last_actor_name,
    updated_at = now()
  returning * into v_status;

  insert into ops_core.panel_legacy_project_status_events(
    status_id, region, project_row_id, project_number,
    status_from, status_to, actor_email, actor_name, note
  ) values (
    v_status.id, v_region, v_row_id, v_number,
    v_before, v_after, p_actor_email, p_actor_name, v_note
  );

  return jsonb_build_object(
    'ok', true,
    'changed', v_before is distinct from v_after,
    'region', v_region,
    'project_row_id', v_row_id,
    'project_number', v_number,
    'status', v_after,
    'actor_email', p_actor_email,
    'actor_name', p_actor_name,
    'updated_at', v_status.updated_at
  );
end;
$$;

create or replace function public.ops_core_get_legacy_project_status(
  p_region text default 'BR'
)
returns jsonb
language sql
security definer
set search_path = public, ops_core
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'region', s.region,
    'project_row_id', s.project_row_id,
    'project_number', s.project_number,
    'panel_status', s.panel_status,
    'last_note', s.last_note,
    'last_actor_email', s.last_actor_email,
    'last_actor_name', s.last_actor_name,
    'updated_at', s.updated_at
  ) order by s.updated_at desc), '[]'::jsonb)
  from ops_core.panel_legacy_project_status s
  where s.region = coalesce(nullif(btrim(p_region), ''), 'BR');
$$;

revoke all on function public.ops_core_set_legacy_project_operational_status(text, text, text, boolean, text, text, text) from public, anon, authenticated;
revoke all on function public.ops_core_get_legacy_project_status(text) from public, anon, authenticated;
grant execute on function public.ops_core_set_legacy_project_operational_status(text, text, text, boolean, text, text, text) to service_role;
grant execute on function public.ops_core_get_legacy_project_status(text) to service_role;
