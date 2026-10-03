create or replace function ops_core.cleanup_finalized_registration_candidates()
returns jsonb
language plpgsql
security definer
set search_path = ops_core, ops_panel, public
as $$
declare
  v_rejected integer := 0;
begin
  update ops_core.registration_candidates c
  set candidate_status = 'rejected',
      suggested_data = coalesce(c.suggested_data, '{}'::jsonb)
        || jsonb_build_object(
          'history_check', jsonb_build_object(
            'classification', 'finalized_old',
            'checked_at', now(),
            'current_tracking', false
          )
        )
  where c.region = 'BR'
    and c.candidate_status <> 'rejected'
    and (
      c.suggested_data #>> '{history_check,classification}' in ('finalized_old', 'finalized_current_tracking')
      or exists (
        select 1
        from ops_core.archived_project_catalog a
        where a.project_core = c.project_core
      )
      or exists (
        select 1
        from ops_panel.wip_current w
        where ops_core.normalize_project_core(w.project_key) = c.project_core
          and upper(coalesce(w.overall_status, '')) in ('DELIVERED', 'CANCELLED', 'MISSING DATA BOOK', 'FINISHED', 'COMPLETED', 'CLOSED')
      )
    );
  get diagnostics v_rejected = row_count;

  update ops_core.notifications n
  set read_at = coalesce(n.read_at, now()),
      resolved_at = coalesce(n.resolved_at, now())
  where n.notification_type = 'registration.new_bsp_from_drawing'
    and (
      exists (
        select 1
        from ops_core.registration_candidates c
        where c.region = 'BR'
          and c.project_core = regexp_replace(n.dedup_key, '^new-drawing-bsp:', '')
          and c.candidate_status = 'rejected'
      )
      or exists (
        select 1
        from ops_core.archived_project_catalog a
        where a.project_core = regexp_replace(n.dedup_key, '^new-drawing-bsp:', '')
      )
      or exists (
        select 1
        from ops_panel.wip_current w
        where ops_core.normalize_project_core(w.project_key) = regexp_replace(n.dedup_key, '^new-drawing-bsp:', '')
          and upper(coalesce(w.overall_status, '')) in ('DELIVERED', 'CANCELLED', 'MISSING DATA BOOK', 'FINISHED', 'COMPLETED', 'CLOSED')
      )
    );

  return jsonb_build_object('ok', true, 'rejected', v_rejected, 'cleaned_at', now());
end;
$$;

revoke all on function ops_core.cleanup_finalized_registration_candidates() from public, anon, authenticated;
grant execute on function ops_core.cleanup_finalized_registration_candidates() to service_role;

create or replace function public.ops_core_refresh_registration()
returns jsonb
language plpgsql
security definer
set search_path = public, ops_core
as $$
declare
  v_archive jsonb;
  v_base jsonb;
  v_fcb jsonb;
  v_cleanup jsonb;
begin
  v_base := ops_core.refresh_registration_candidates();
  v_fcb := ops_core.enforce_fcb_first_registration();
  v_archive := ops_core.archive_completed_legacy_tracking_projects('system:registration-refresh');
  v_cleanup := ops_core.cleanup_finalized_registration_candidates();
  return jsonb_build_object(
    'ok', true,
    'legacy_archive', v_archive,
    'base', v_base,
    'fcb_first', v_fcb,
    'finalized_cleanup', v_cleanup,
    'refreshed_at', now()
  );
end;
$$;

revoke all on function public.ops_core_refresh_registration() from public, anon, authenticated;
grant execute on function public.ops_core_refresh_registration() to service_role;

select ops_core.cleanup_finalized_registration_candidates();
