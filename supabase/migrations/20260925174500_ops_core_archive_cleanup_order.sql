create or replace function public.ops_core_refresh_registration()
returns jsonb
language plpgsql
security definer
set search_path=public,ops_core
as $$
declare
  v_archive jsonb;
  v_base jsonb;
  v_fcb jsonb;
begin
  v_base:=ops_core.refresh_registration_candidates();
  v_fcb:=ops_core.enforce_fcb_first_registration();
  -- Candidate refresh can rediscover a finished Tracking BSP. Archive last
  -- so finalized projects remain outside the operational queue.
  v_archive:=ops_core.archive_completed_legacy_tracking_projects('system:registration-refresh');
  return jsonb_build_object(
    'ok',true,
    'legacy_archive',v_archive,
    'base',v_base,
    'fcb_first',v_fcb,
    'refreshed_at',now()
  );
end;
$$;

grant execute on function public.ops_core_refresh_registration() to service_role;

select public.ops_core_refresh_registration();
select ops_core.refresh_demand_feed_cache();
