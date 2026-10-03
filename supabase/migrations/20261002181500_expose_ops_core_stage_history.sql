-- Keep ops_core private and expose only the stage history needed by the
-- operational Edge Function through a service-role-only public RPC.
create or replace function public.ops_core_get_project_stage_history(
  p_region text default 'BR',
  p_project_numbers text[] default '{}'
)
returns jsonb
language sql
security definer
set search_path = public, ops_core
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id,
    'project_id', e.project_id,
    'project_core', p.project_core,
    'item_id', e.item_id,
    'stage_key', e.stage_key,
    'event_type', e.event_type,
    'progress_from', e.progress_from,
    'progress_to', e.progress_to,
    'created_at', e.created_at,
    'source_system', e.source_system,
    'actor_email', e.actor_email,
    'actor_name', e.actor_name,
    'payload', e.payload
  ) order by e.created_at desc), '[]'::jsonb)
  from ops_core.stage_events e
  join ops_core.projects p on p.id = e.project_id
  where p.region = coalesce(nullif(btrim(p_region), ''), 'BR')
    and p.project_core = any(coalesce(p_project_numbers, '{}'::text[]))
    and e.source_system = 'ops_core';
$$;

revoke all on function public.ops_core_get_project_stage_history(text, text[]) from public, anon, authenticated;
grant execute on function public.ops_core_get_project_stage_history(text, text[]) to service_role;
