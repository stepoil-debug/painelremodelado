
create or replace view ops_core.demand_feed as
with legacy_active_projects as (
  select distinct
    ops_core.normalize_project_core(tp.project_number) as project_core
  from public.tracking_projects tp
  where upper(tp.region)='BR'
    and coalesce(tp.active,true)
    and ops_core.normalize_project_core(tp.project_number) is not null
),
legacy_current as (
  select distinct on (
    ops_core.normalize_project_core(t.project_key),
    t.item_key
  )
    t.source_key,
    t.source_row_id,
    t.source_version,
    t.synced_at,
    t.project_key,
    t.item,
    t.drawing,
    t.item_key,
    t.line_number,
    t.observations,
    t.client,
    t.vessel,
    t.project_type,
    t.pm,
    t.priority,
    t.current_stage,
    t.current_status,
    t.start_date,
    t.finish_date,
    t.project_finish_date,
    t.fabrication_start,
    t.overall_progress,
    t.weight_kg,
    t.m2,
    t.project_finished,
    t.status_text,
    t.project_row_id
  from ops_panel.tracking_current_items t
  where t.item_key is not null
    and ops_core.normalize_project_core(t.project_key) is not null
  order by
    ops_core.normalize_project_core(t.project_key),
    t.item_key,
    t.synced_at desc nulls last,
    t.source_version desc nulls last,
    t.source_row_id desc
),
legacy_current_active as (
  select t.*
  from legacy_current t
  join legacy_active_projects a
    on a.project_core=ops_core.normalize_project_core(t.project_key)
),
legacy_fallback as (
  select
    p.region,
    coalesce(i.legacy_iso_key,i.item_key) as iso_key,
    coalesce(i.legacy_project_row_id,p.legacy_project_row_id,i.project_id::text) as project_row_id,
    p.project_core as project_number,
    coalesce(i.spool_code,i.iso_code,i.drawing_code,i.item_key) as iso,
    i.drawing_code as drawing,
    i.line_number,
    i.description,
    i.tag_number as client_tag,
    p.project_type,
    i.current_stage_key as current_stage,
    i.current_status,
    i.planned_start,
    i.planned_finish,
    i.fabrication_start,
    i.overall_progress,
    i.weight_kg,
    i.painting_m2 as m2,
    'legacy_fallback'::text as source_version,
    i.updated_at as source_updated_at,
    i.updated_at as synced_at,
    p.display_code as project_display,
    p.client,
    p.vessel,
    p.pm,
    p.project_status,
    p.replanned_finish,
    false as archived,
    null::text as archive_source,
    null::integer as archive_rank,
    'legacy_tracking'::text as source_mode,
    p.id as core_project_id,
    i.id as core_item_id,
    i.material,
    i.size,
    i.schedule,
    i.joints,
    i.quantity,
    i.spool_code,
    i.requires_3d,
    i.requires_assembly_simulation,
    p.customer_po
  from ops_core.projects p
  join legacy_active_projects a
    on a.project_core=p.project_core
  join ops_core.items i
    on i.project_id=p.id
   and not i.removed_from_scope
  where upper(p.region)='BR'
    and p.active=true
    and p.source_mode='legacy_tracking'
    and not exists (
      select 1
      from legacy_current t
      where ops_core.normalize_project_core(t.project_key)=p.project_core
    )
)
select
  p.region,
  coalesce(i.legacy_iso_key,i.item_key) as iso_key,
  coalesce(i.legacy_project_row_id,p.legacy_project_row_id,i.project_id::text) as project_row_id,
  p.project_core as project_number,
  coalesce(i.spool_code,i.iso_code,i.drawing_code,i.item_key) as iso,
  i.drawing_code as drawing,
  i.line_number,
  i.description,
  i.tag_number as client_tag,
  p.project_type,
  i.current_stage_key as current_stage,
  i.current_status,
  i.planned_start,
  i.planned_finish,
  i.fabrication_start,
  i.overall_progress,
  i.weight_kg,
  i.painting_m2 as m2,
  'ops_core'::text as source_version,
  i.updated_at as source_updated_at,
  i.updated_at as synced_at,
  p.display_code as project_display,
  p.client,
  p.vessel,
  p.pm,
  p.project_status,
  p.replanned_finish,
  false as archived,
  null::text as archive_source,
  null::integer as archive_rank,
  p.source_mode,
  p.id as core_project_id,
  i.id as core_item_id,
  i.material,
  i.size,
  i.schedule,
  i.joints,
  i.quantity,
  i.spool_code,
  i.requires_3d,
  i.requires_assembly_simulation,
  p.customer_po
from ops_core.projects p
join ops_core.items i
  on i.project_id=p.id
 and not i.removed_from_scope
where p.active=true
  and p.source_mode='ops_core'

union all

select
  'BR'::text as region,
  t.item_key as iso_key,
  t.project_row_id::text as project_row_id,
  ops_core.normalize_project_core(t.project_key) as project_number,
  coalesce(nullif(t.drawing,''),nullif(t.item,''),t.item_key) as iso,
  t.drawing,
  t.line_number,
  t.observations as description,
  null::text as client_tag,
  t.project_type,
  t.current_stage,
  t.current_status,
  t.start_date as planned_start,
  t.finish_date as planned_finish,
  t.fabrication_start,
  t.overall_progress,
  t.weight_kg,
  t.m2,
  t.source_version::text as source_version,
  t.synced_at as source_updated_at,
  t.synced_at,
  coalesce(p.display_code,'BSP '||ops_core.normalize_project_core(t.project_key)) as project_display,
  coalesce(nullif(p.client,''),nullif(t.client,'')) as client,
  coalesce(nullif(p.vessel,''),nullif(t.vessel,'')) as vessel,
  coalesce(nullif(p.pm,''),nullif(t.pm,'')) as pm,
  p.project_status,
  coalesce(p.replanned_finish,t.project_finish_date) as replanned_finish,
  false as archived,
  null::text as archive_source,
  null::integer as archive_rank,
  'legacy_tracking'::text as source_mode,
  p.id as core_project_id,
  null::uuid as core_item_id,
  null::text as material,
  null::text as size,
  null::text as schedule,
  null::numeric as joints,
  null::numeric as quantity,
  null::text as spool_code,
  null::boolean as requires_3d,
  null::boolean as requires_assembly_simulation,
  p.customer_po
from legacy_current_active t
left join ops_core.projects p
  on p.region='BR'
 and p.project_core=ops_core.normalize_project_core(t.project_key)
where coalesce(p.source_mode,'legacy_tracking')='legacy_tracking'

union all

select
  f.region,
  f.iso_key,
  f.project_row_id,
  f.project_number,
  f.iso,
  f.drawing,
  f.line_number,
  f.description,
  f.client_tag,
  f.project_type,
  f.current_stage,
  f.current_status,
  f.planned_start,
  f.planned_finish,
  f.fabrication_start,
  f.overall_progress,
  f.weight_kg,
  f.m2,
  f.source_version,
  f.source_updated_at,
  f.synced_at,
  f.project_display,
  f.client,
  f.vessel,
  f.pm,
  f.project_status,
  f.replanned_finish,
  f.archived,
  f.archive_source,
  f.archive_rank,
  f.source_mode,
  f.core_project_id,
  f.core_item_id,
  f.material,
  f.size,
  f.schedule,
  f.joints,
  f.quantity,
  f.spool_code,
  f.requires_3d,
  f.requires_assembly_simulation,
  f.customer_po
from legacy_fallback f;

select ops_core.refresh_demand_feed_cache();
