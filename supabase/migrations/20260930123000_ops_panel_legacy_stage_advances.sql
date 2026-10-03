create table if not exists ops_core.panel_legacy_stage_advances (
  id uuid primary key default gen_random_uuid(),
  region text not null default 'BR',
  project_row_id text not null,
  project_number text not null,
  iso_key text not null,
  iso text,
  base_stage text,
  base_status text,
  base_progress numeric not null default 0,
  panel_status text not null default 'new'
    check (panel_status in ('new', 'in_progress', 'waiting', 'blocked', 'completed')),
  panel_progress numeric not null default 0
    check (panel_progress >= 0 and panel_progress <= 100),
  last_action text,
  last_note text,
  last_actor_email text,
  last_actor_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (region, project_row_id, iso_key)
);

create index if not exists panel_legacy_stage_advances_lookup_idx
  on ops_core.panel_legacy_stage_advances(region, project_row_id, iso_key);

create table if not exists ops_core.panel_legacy_stage_events (
  id uuid primary key default gen_random_uuid(),
  advance_id uuid not null references ops_core.panel_legacy_stage_advances(id) on delete cascade,
  region text not null,
  project_row_id text not null,
  project_number text not null,
  iso_key text not null,
  event_type text not null,
  progress_from numeric,
  progress_to numeric,
  status_from text,
  status_to text,
  actor_email text,
  actor_name text,
  note text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists panel_legacy_stage_events_lookup_idx
  on ops_core.panel_legacy_stage_events(region, project_row_id, iso_key, created_at desc);

alter table ops_core.panel_legacy_stage_advances enable row level security;
alter table ops_core.panel_legacy_stage_events enable row level security;
revoke all on ops_core.panel_legacy_stage_advances from anon, authenticated;
revoke all on ops_core.panel_legacy_stage_events from anon, authenticated;
grant select, insert, update on ops_core.panel_legacy_stage_advances to service_role;
grant select, insert on ops_core.panel_legacy_stage_events to service_role;

create or replace function ops_core.panel_legacy_key(p_value text)
returns text
language sql
immutable
set search_path = public, ops_core
as $$
  select regexp_replace(upper(coalesce(p_value, '')), '[^A-Z0-9]', '', 'g');
$$;

create or replace function ops_core.get_panel_legacy_stage_advances(p_region text default 'BR')
returns jsonb
language sql
stable
security definer
set search_path = public, ops_core
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'region', a.region,
    'project_row_id', a.project_row_id,
    'project_number', a.project_number,
    'iso_key', a.iso_key,
    'iso', a.iso,
    'current_stage', a.base_stage,
    'current_status', case a.panel_status
      when 'in_progress' then 'Em execução'
      when 'waiting' then 'Aguardando'
      when 'blocked' then 'Bloqueado'
      when 'completed' then 'Finalizado'
      else coalesce(a.base_status, 'Nova')
    end,
    'overall_progress', a.panel_progress,
    'panel_advance_status', a.panel_status,
    'panel_advance_updated_at', a.updated_at,
    'panel_advance_last_action', a.last_action,
    'panel_advance_last_actor', a.last_actor_name
  ) order by a.updated_at desc), '[]'::jsonb)
  from ops_core.panel_legacy_stage_advances a
  where a.region = coalesce(nullif(btrim(p_region), ''), 'BR');
$$;

create or replace function ops_core.apply_panel_legacy_stage_action(
  p_region text,
  p_project_row_id text,
  p_project_number text,
  p_iso text,
  p_action text,
  p_actor_email text,
  p_actor_name text default null,
  p_progress numeric default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, ops_core
as $$
declare
  v_region text := coalesce(nullif(btrim(p_region), ''), 'BR');
  v_project_row_id text := btrim(coalesce(p_project_row_id, ''));
  v_project_number text := btrim(coalesce(p_project_number, ''));
  v_iso_norm text := ops_core.panel_legacy_key(p_iso);
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_actor_email text := nullif(btrim(coalesce(p_actor_email, '')), '');
  v_actor_name text := nullif(btrim(coalesce(p_actor_name, '')), '');
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
  v_tracking record;
  v_advance ops_core.panel_legacy_stage_advances%rowtype;
  v_before_progress numeric;
  v_before_status text;
  v_next_progress numeric;
  v_next_status text;
begin
  if v_project_row_id = '' or v_iso_norm = '' then
    raise exception 'BSP e ISO são obrigatórios para editar este apontamento.';
  end if;

  if v_action not in ('accept', 'start', 'progress', 'wait', 'resume', 'block', 'complete') then
    raise exception 'Ação de avanço inválida: %', p_action;
  end if;

  select t.region, t.project_row_id, t.project_number, t.iso_key, t.iso, t.drawing,
         t.current_stage, t.current_status, t.overall_progress
    into v_tracking
  from public.tracking_isos t
  where t.region = v_region
    and t.active = true
    and t.project_row_id = v_project_row_id
    and ops_core.panel_legacy_key(coalesce(t.iso_key, t.drawing, t.iso)) = v_iso_norm
  order by t.synced_at desc nulls last
  limit 1;

  if not found then
    raise exception 'Apontamento legado não encontrado ou não está ativo no Tracking.';
  end if;

  insert into ops_core.panel_legacy_stage_advances (
    region, project_row_id, project_number, iso_key, iso,
    base_stage, base_status, base_progress, panel_progress
  ) values (
    v_region, v_project_row_id, coalesce(v_tracking.project_number, v_project_number),
    v_iso_norm, coalesce(v_tracking.iso, v_tracking.drawing, p_iso),
    v_tracking.current_stage, v_tracking.current_status,
    greatest(0, least(100, coalesce(v_tracking.overall_progress, 0))),
    greatest(0, least(100, coalesce(v_tracking.overall_progress, 0)))
  )
  on conflict (region, project_row_id, iso_key) do nothing;

  select * into v_advance
  from ops_core.panel_legacy_stage_advances
  where region=v_region and project_row_id=v_project_row_id and iso_key=v_iso_norm
  for update;

  v_before_progress := v_advance.panel_progress;
  v_before_status := v_advance.panel_status;
  v_next_progress := v_before_progress;
  v_next_status := v_before_status;

  if v_action in ('start', 'progress') then
    v_next_progress := greatest(v_before_progress, least(99, greatest(0, coalesce(p_progress, case when v_before_progress > 0 then v_before_progress else 25 end))));
    if v_next_progress <= v_before_progress and v_action = 'progress' then
      raise exception 'O novo avanço precisa ser maior que o atual.';
    end if;
    v_next_status := 'in_progress';
  elsif v_action = 'complete' then
    v_next_progress := 100;
    v_next_status := 'completed';
  elsif v_action = 'wait' then
    v_next_status := 'waiting';
  elsif v_action = 'block' then
    v_next_status := 'blocked';
  elsif v_action = 'resume' then
    v_next_status := case when v_before_progress > 0 then 'in_progress' else 'new' end;
  elsif v_action = 'accept' then
    v_next_status := case when v_before_progress > 0 then 'in_progress' else 'new' end;
  end if;

  update ops_core.panel_legacy_stage_advances
  set panel_status=v_next_status,
      panel_progress=v_next_progress,
      last_action=v_action,
      last_note=v_note,
      last_actor_email=v_actor_email,
      last_actor_name=v_actor_name,
      updated_at=now()
  where id=v_advance.id;

  insert into ops_core.panel_legacy_stage_events (
    advance_id, region, project_row_id, project_number, iso_key,
    event_type, progress_from, progress_to, status_from, status_to,
    actor_email, actor_name, note, payload
  ) values (
    v_advance.id, v_region, v_project_row_id, v_advance.project_number, v_iso_norm,
    'stage.' || v_action, v_before_progress, v_next_progress, v_before_status, v_next_status,
    v_actor_email, v_actor_name, v_note,
    jsonb_build_object('source', 'tracking_legacy', 'iso', v_advance.iso)
  );

  return jsonb_build_object(
    'ok', true,
    'source', 'tracking_legacy',
    'region', v_region,
    'project_row_id', v_project_row_id,
    'project_number', v_advance.project_number,
    'iso_key', v_iso_norm,
    'action', v_action,
    'progress', v_next_progress,
    'status', v_next_status,
    'updated_at', now()
  );
end;
$$;

revoke all on function ops_core.panel_legacy_key(text) from public, anon, authenticated;
revoke all on function ops_core.get_panel_legacy_stage_advances(text) from public, anon, authenticated;
revoke all on function ops_core.apply_panel_legacy_stage_action(text,text,text,text,text,text,text,numeric,text) from public, anon, authenticated;
grant execute on function ops_core.panel_legacy_key(text) to service_role;
grant execute on function ops_core.get_panel_legacy_stage_advances(text) to service_role;
grant execute on function ops_core.apply_panel_legacy_stage_action(text,text,text,text,text,text,text,numeric,text) to service_role;
