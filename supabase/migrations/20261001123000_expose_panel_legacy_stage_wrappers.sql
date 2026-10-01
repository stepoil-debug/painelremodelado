-- Expose the protected panel-advance routines through the public PostgREST
-- schema. The implementation remains in ops_core and is only callable by the
-- service role through the Edge Function.

create or replace function public.ops_core_get_panel_legacy_stage_advances(
  p_region text default 'BR'
)
returns jsonb
language sql
security definer
set search_path = public, ops_core
as $$
  select ops_core.get_panel_legacy_stage_advances(p_region);
$$;

create or replace function public.ops_core_apply_panel_legacy_stage_action(
  p_region text,
  p_project_row_id text,
  p_project_number text,
  p_iso text,
  p_stage_key text,
  p_tracking_stage_key text,
  p_action text,
  p_actor_email text,
  p_actor_name text default null,
  p_progress numeric default null,
  p_note text default null
)
returns jsonb
language sql
security definer
set search_path = public, ops_core
as $$
  select ops_core.apply_panel_legacy_stage_action(
    p_region => p_region,
    p_project_row_id => p_project_row_id,
    p_project_number => p_project_number,
    p_iso => p_iso,
    p_stage_key => p_stage_key,
    p_tracking_stage_key => p_tracking_stage_key,
    p_action => p_action,
    p_actor_email => p_actor_email,
    p_actor_name => p_actor_name,
    p_progress => p_progress,
    p_note => p_note
  );
$$;

revoke all on function public.ops_core_get_panel_legacy_stage_advances(text) from public, anon, authenticated;
revoke all on function public.ops_core_apply_panel_legacy_stage_action(text,text,text,text,text,text,text,text,text,numeric,text) from public, anon, authenticated;
grant execute on function public.ops_core_get_panel_legacy_stage_advances(text) to service_role;
grant execute on function public.ops_core_apply_panel_legacy_stage_action(text,text,text,text,text,text,text,text,text,numeric,text) to service_role;
