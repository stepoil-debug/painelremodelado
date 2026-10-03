-- Finalized BSPs can still exist in the Drawing feed for historical reasons.
-- They must not remain in the operational "new BSP" popup or be re-opened by
-- the FCB refresh routine.

with old_candidates as (
  select
    c.region,
    c.project_core
  from ops_core.registration_candidates c
  where c.region = 'BR'
    and (
      c.candidate_status = 'rejected'
      or c.suggested_data #>> '{history_check,classification}' in ('finalized_old', 'finalized_current_tracking')
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
    )
)
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
where exists (
  select 1
  from old_candidates old
  where old.region = c.region
    and old.project_core = c.project_core
);

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

create or replace function public.ops_core_new_bsp_alerts(p_limit integer default 10)
returns jsonb
language sql
stable
security definer
set search_path = public, ops_core, ops_panel
as $$
select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc), '[]'::jsonb)
from (
  select
    n.id,
    n.notification_type,
    n.title,
    n.message,
    n.severity,
    n.created_at,
    n.read_at,
    regexp_replace(n.dedup_key, '^new-drawing-bsp:', '') project_core,
    coalesce(c.display_code, regexp_replace(n.dedup_key, '^new-drawing-bsp:', '')) display_code,
    c.source_systems,
    c.suggested_data
  from ops_core.notifications n
  left join ops_core.registration_candidates c
    on c.region = 'BR'
   and c.project_core = regexp_replace(n.dedup_key, '^new-drawing-bsp:', '')
  where n.notification_type = 'registration.new_bsp_from_drawing'
    and n.read_at is null
    and n.resolved_at is null
    and coalesce(c.candidate_status, '') <> 'rejected'
    and coalesce(c.suggested_data #>> '{history_check,classification}', '') not in ('finalized_old', 'finalized_current_tracking')
    and not exists (
      select 1
      from ops_core.archived_project_catalog a
      where a.project_core = regexp_replace(n.dedup_key, '^new-drawing-bsp:', '')
    )
    and not exists (
      select 1
      from ops_panel.wip_current w
      where ops_core.normalize_project_core(w.project_key) = regexp_replace(n.dedup_key, '^new-drawing-bsp:', '')
        and upper(coalesce(w.overall_status, '')) in ('DELIVERED', 'CANCELLED', 'MISSING DATA BOOK', 'FINISHED', 'COMPLETED', 'CLOSED')
    )
  order by n.created_at desc
  limit greatest(1, least(coalesce(p_limit, 10), 50))
) q;
$$;

revoke all on function public.ops_core_new_bsp_alerts(integer) from public, anon, authenticated;
grant execute on function public.ops_core_new_bsp_alerts(integer) to service_role;
