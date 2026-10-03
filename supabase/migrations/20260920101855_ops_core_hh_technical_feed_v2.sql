
create or replace view ops_core.demand_feed as
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
  on i.project_id=p.id and i.removed_from_scope=false
where p.active=true and p.source_mode='ops_core'

union all

select
  ti.region,
  ti.iso_key,
  ti.project_row_id,
  ti.project_number,
  ti.iso,
  ti.drawing,
  ti.line_number,
  ti.description,
  ti.client_tag,
  ti.project_type,
  ti.current_stage,
  ti.current_status,
  ti.planned_start,
  ti.planned_finish,
  ti.fabrication_start,
  ti.overall_progress,
  ti.weight_kg,
  ti.m2,
  ti.source_version,
  ti.source_updated_at,
  ti.synced_at,
  tp.project_display,
  tp.client,
  tp.vessel,
  tp.pm,
  tp.project_status,
  tp.replanned_finish,
  false,
  null::text,
  null::integer,
  'legacy_tracking'::text,
  p.id,
  null::uuid,
  null::text,
  null::text,
  null::text,
  null::numeric,
  null::numeric,
  null::text,
  null::boolean,
  null::boolean,
  null::text
from public.tracking_isos ti
left join public.tracking_projects tp
  on tp.region=ti.region
 and tp.project_row_id=ti.project_row_id
 and tp.active=true
left join ops_core.projects p
  on p.region=ti.region
 and p.project_core=ops_core.normalize_project_core(ti.project_number)
where ti.active=true
  and coalesce(p.source_mode,'legacy_tracking')='legacy_tracking';
