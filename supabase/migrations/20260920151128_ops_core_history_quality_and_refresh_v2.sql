
create or replace view ops_core.history_metric_quality as
select
  source_key,
  source_row_id,
  project_core,
  item_key,
  reporting_year,
  weight_kg,
  m2,
  case
    when m2 is not null and (m2 < 0 or m2 > 100000) then 'M2_OUTLIER'
    when weight_kg is not null and weight_kg < 0 then 'NEGATIVE_WEIGHT'
    else null
  end issue_type
from ops_core.legacy_tracking_history
where (m2 is not null and (m2 < 0 or m2 > 100000))
   or (weight_kg is not null and weight_kg < 0);

create or replace view ops_core.archived_project_catalog as
with legacy_hold as (
  select project_core,
         round(sum(duration_hours)/24.0,2) hold_days
  from ops_core.legacy_on_hold_history
  where project_core is not null
  group by project_core
),
core_hold as (
  select project_core,
         round(sum(extract(epoch from (coalesce(ended_at,now())-started_at))/3600.0)/24.0,2) hold_days
  from ops_core.hold_periods
  group by project_core
),
core_archived_keys as (
  select project_core from ops_core.projects where source_mode='archived'
),
legacy as (
  select
    'LEGACY_TRACKING'::text origin,
    null::uuid project_id,
    project_core,
    max(project_display) project_display,
    max(client) client,
    max(vessel) vessel,
    max(pm) pm,
    max(project_type) project_type,
    max(reporting_date) completed_on,
    extract(year from max(reporting_date))::integer reporting_year,
    count(*) item_count,
    round(sum(coalesce(weight_kg,0))::numeric,2) total_weight_kg,
    round(sum(case when m2 between 0 and 100000 then m2 else 0 end)::numeric,2) total_m2,
    max(archive_source) archive_source,
    count(*) filter(where m2 is not null and (m2 < 0 or m2 > 100000)) metric_quality_issues
  from ops_core.legacy_final_item_catalog l
  where reporting_date is not null
    and not exists(select 1 from core_archived_keys c where c.project_core=l.project_core)
  group by project_core
),
core as (
  select
    'OPS_CORE'::text origin,
    p.id project_id,
    p.project_core,
    p.display_code project_display,
    p.client,
    p.vessel,
    p.pm,
    p.project_type,
    coalesce(p.completed_at::date,p.archived_at::date) completed_on,
    coalesce(p.reporting_year,extract(year from coalesce(p.completed_at,p.archived_at))::integer) reporting_year,
    count(i.id) filter(where not i.removed_from_scope) item_count,
    round(coalesce(sum(coalesce(i.weight_kg,0)) filter(where not i.removed_from_scope),0)::numeric,2) total_weight_kg,
    round(coalesce(sum(coalesce(i.painting_m2,0)) filter(where not i.removed_from_scope),0)::numeric,2) total_m2,
    'OPS_CORE'::text archive_source,
    0::bigint metric_quality_issues
  from ops_core.projects p
  left join ops_core.items i on i.project_id=p.id
  where p.source_mode='archived'
  group by p.id
),
combined as (
  select * from legacy
  union all
  select * from core
)
select
  x.origin,
  x.project_id,
  x.project_core,
  x.project_display,
  x.client,
  x.vessel,
  x.pm,
  x.project_type,
  x.completed_on,
  x.reporting_year,
  x.item_count,
  x.total_weight_kg,
  x.total_m2,
  x.archive_source,
  round(coalesce(lh.hold_days,0)+coalesce(ch.hold_days,0),2) hold_days,
  x.metric_quality_issues
from combined x
left join legacy_hold lh using(project_core)
left join core_hold ch using(project_core);

create or replace view ops_core.annual_summary as
select
  reporting_year,
  count(*) projects,
  count(distinct nullif(client,'')) clients,
  sum(item_count) items,
  round(sum(total_weight_kg)::numeric,2) total_weight_kg,
  round(sum(total_m2)::numeric,2) total_m2,
  round(sum(hold_days)::numeric,2) hold_days,
  sum(metric_quality_issues) metric_quality_issues
from ops_core.archived_project_catalog
where reporting_year is not null
group by reporting_year
order by reporting_year;

create or replace view ops_core.annual_client_summary as
select
  reporting_year,
  coalesce(nullif(client,''),'Não informado') client,
  count(*) projects,
  sum(item_count) items,
  round(sum(total_weight_kg)::numeric,2) total_weight_kg,
  round(sum(total_m2)::numeric,2) total_m2,
  round(sum(hold_days)::numeric,2) hold_days,
  sum(metric_quality_issues) metric_quality_issues
from ops_core.archived_project_catalog
where reporting_year is not null
group by reporting_year,coalesce(nullif(client,''),'Não informado')
order by reporting_year,projects desc,client;

create or replace function public.ops_core_history_health()
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core
as $$
select jsonb_build_object(
  'legacy_history_rows',(select count(*) from ops_core.legacy_tracking_history),
  'legacy_archive_rows',(select count(*) from ops_core.legacy_tracking_history where snapshot_scope='archive'),
  'legacy_current_rows',(select count(*) from ops_core.legacy_tracking_history where snapshot_scope='current'),
  'on_hold_periods',(select count(*) from ops_core.legacy_on_hold_history),
  'invalid_date_rows',(select count(*) from ops_core.history_data_quality),
  'metric_quality_rows',(select count(*) from ops_core.history_metric_quality),
  'archived_projects',(select count(*) from ops_core.archived_project_catalog),
  'years',(select coalesce(jsonb_agg(reporting_year order by reporting_year),'[]'::jsonb) from ops_core.annual_summary)
);
$$;

do $$
begin
  if not exists(select 1 from cron.job where jobname='ops-core-history-refresh-hourly') then
    perform cron.schedule(
      'ops-core-history-refresh-hourly',
      '25 * * * *',
      'select ops_core.refresh_legacy_history();'
    );
  end if;
end $$;
