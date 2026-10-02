-- Read-only service-role wrappers for the legacy panel stage overlay. The
-- underlying ops_core tables remain private from PostgREST schema access.
create or replace function public.ops_core_get_panel_legacy_stage_metadata(
  p_region text default 'BR'
)
returns jsonb
language sql
security definer
set search_path = public, ops_core
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'region', a.region,
    'project_row_id', a.project_row_id,
    'project_number', a.project_number,
    'iso_key', a.iso_key,
    'stage_key', a.stage_key,
    'created_at', a.created_at,
    'updated_at', a.updated_at,
    'last_actor_email', a.last_actor_email,
    'last_actor_name', a.last_actor_name,
    'last_action', a.last_action
  ) order by a.updated_at desc), '[]'::jsonb)
  from ops_core.panel_legacy_stage_advances a
  where a.region = coalesce(nullif(btrim(p_region), ''), 'BR');
$$;

create or replace function public.ops_core_get_panel_legacy_stage_events(
  p_region text default 'BR'
)
returns jsonb
language sql
security definer
set search_path = public, ops_core
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id,
    'region', e.region,
    'project_row_id', e.project_row_id,
    'project_number', e.project_number,
    'iso_key', e.iso_key,
    'event_type', e.event_type,
    'progress_from', e.progress_from,
    'progress_to', e.progress_to,
    'actor_email', e.actor_email,
    'actor_name', e.actor_name,
    'note', e.note,
    'payload', e.payload,
    'created_at', e.created_at
  ) order by e.created_at asc), '[]'::jsonb)
  from ops_core.panel_legacy_stage_events e
  where e.region = coalesce(nullif(btrim(p_region), ''), 'BR');
$$;

revoke all on function public.ops_core_get_panel_legacy_stage_metadata(text) from public, anon, authenticated;
revoke all on function public.ops_core_get_panel_legacy_stage_events(text) from public, anon, authenticated;
grant execute on function public.ops_core_get_panel_legacy_stage_metadata(text) to service_role;
grant execute on function public.ops_core_get_panel_legacy_stage_events(text) to service_role;
