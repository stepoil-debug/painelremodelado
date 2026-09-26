
create or replace function ops_core.sync_legacy_tracking_current_items(p_region text default 'BR')
returns jsonb
language plpgsql
security definer
set search_path=ops_core,ops_panel,public
as $$
declare
  v_region text:=upper(coalesce(nullif(btrim(p_region),''),'BR'));
  v_upserted integer:=0;
begin
  with current_dedup as (
    select distinct on (
      ops_core.normalize_project_core(t.project_key),
      t.item_key
    )
      t.*
    from ops_panel.tracking_current_items t
    where t.item_key is not null
      and ops_core.normalize_project_core(t.project_key) is not null
    order by
      ops_core.normalize_project_core(t.project_key),
      t.item_key,
      t.synced_at desc nulls last,
      t.source_version desc nulls last,
      t.source_row_id desc
  )
  insert into ops_core.items(
    project_id,item_key,item_type,iso_code,drawing_code,line_number,description,
    weight_kg,painting_m2,current_stage_key,current_status,planned_start,planned_finish,
    fabrication_start,overall_progress,legacy_iso_key,legacy_project_row_id,legacy_raw,source_metadata
  )
  select
    p.id,
    t.item_key,
    ops_core.infer_item_type(t.project_type,t.drawing,t.observations),
    case when upper(coalesce(t.drawing,'')) like '%ISO%' then nullif(t.drawing,'') else null end,
    nullif(t.drawing,''),
    nullif(t.line_number,''),
    nullif(t.observations,''),
    t.weight_kg,
    t.m2,
    nullif(t.current_stage,''),
    coalesce(nullif(t.current_status,''),'new'),
    t.start_date,
    t.finish_date,
    t.fabrication_start,
    coalesce(t.overall_progress,0),
    t.item_key,
    t.project_row_id::text,
    rr.payload->'cells',
    jsonb_build_object(
      'bootstrap','tracking_current_items',
      'source_row_id',t.source_row_id,
      'source_version',t.source_version,
      'synced_at',t.synced_at,
      'tracking_item',t.item
    )
  from current_dedup t
  join ops_core.projects p
    on p.region=v_region
   and p.project_core=ops_core.normalize_project_core(t.project_key)
   and p.source_mode='legacy_tracking'
   and p.active=true
  left join lateral (
    select r.payload
    from ops_panel.source_rows r
    where r.source_key='tracking'
      and r.source_row_id=t.source_row_id
      and r.active=true
    order by r.source_version desc nulls last,r.synced_at desc nulls last
    limit 1
  ) rr on true
  where v_region='BR'
  on conflict(project_id,item_key) do update
  set
    iso_code=coalesce(ops_core.items.iso_code,excluded.iso_code),
    drawing_code=coalesce(excluded.drawing_code,ops_core.items.drawing_code),
    line_number=coalesce(excluded.line_number,ops_core.items.line_number),
    description=coalesce(excluded.description,ops_core.items.description),
    weight_kg=excluded.weight_kg,
    painting_m2=excluded.painting_m2,
    current_stage_key=excluded.current_stage_key,
    current_status=excluded.current_status,
    planned_start=excluded.planned_start,
    planned_finish=excluded.planned_finish,
    fabrication_start=excluded.fabrication_start,
    overall_progress=excluded.overall_progress,
    legacy_iso_key=excluded.legacy_iso_key,
    legacy_project_row_id=excluded.legacy_project_row_id,
    legacy_raw=coalesce(excluded.legacy_raw,ops_core.items.legacy_raw),
    source_metadata=ops_core.items.source_metadata||excluded.source_metadata,
    updated_at=now()
  where (select source_mode from ops_core.projects where id=ops_core.items.project_id)='legacy_tracking';

  get diagnostics v_upserted=row_count;

  update ops_core.items i
  set
    material=coalesce(nullif(i.legacy_raw->>'Material',''),i.material),
    size=coalesce(nullif(i.legacy_raw->>'Size',''),i.size),
    schedule=coalesce(nullif(i.legacy_raw->>'SCH',''),i.schedule),
    quantity=coalesce(public.tracking_parse_number(i.legacy_raw->>'Quantity Spools'),i.quantity),
    joints=coalesce(public.tracking_parse_number(i.legacy_raw->>'Quantity Juntas'),i.joints),
    hdg_kg=coalesce(public.tracking_parse_number(i.legacy_raw->>'HDG (Kg)'),i.hdg_kg),
    updated_at=now()
  from ops_core.projects p
  where i.project_id=p.id
    and p.region=v_region
    and p.source_mode='legacy_tracking'
    and p.active=true;

  perform ops_core.ensure_item_stages(i.id)
  from ops_core.items i
  join ops_core.projects p on p.id=i.project_id
  where p.region=v_region
    and p.source_mode='legacy_tracking'
    and p.active=true;

  return jsonb_build_object(
    'ok',true,
    'region',v_region,
    'items_upserted',v_upserted,
    'finished_at',now()
  );
end $$;

grant execute on function ops_core.sync_legacy_tracking_current_items(text) to service_role;

create or replace function public.ops_core_sync_legacy_tracking_current_items(p_region text default 'BR')
returns jsonb
language sql
security definer
set search_path=public,ops_core
as $$
  select ops_core.sync_legacy_tracking_current_items(p_region);
$$;

grant execute on function public.ops_core_sync_legacy_tracking_current_items(text) to service_role;

create or replace view ops_core.demand_feed as
with legacy_current as (
  select distinct on (
    ops_core.normalize_project_core(t.project_key),
    t.item_key
  )
    t.*
  from ops_panel.tracking_current_items t
  where t.item_key is not null
    and ops_core.normalize_project_core(t.project_key) is not null
  order by
    ops_core.normalize_project_core(t.project_key),
    t.item_key,
    t.synced_at desc nulls last,
    t.source_version desc nulls last,
    t.source_row_id desc
)
select
  p.region,
  coalesce(i.legacy_iso_key,i.item_key) iso_key,
  coalesce(i.legacy_project_row_id,p.legacy_project_row_id,i.project_id::text) project_row_id,
  p.project_core project_number,
  coalesce(i.spool_code,i.iso_code,i.drawing_code,i.item_key) iso,
  i.drawing_code drawing,
  i.line_number,
  i.description,
  i.tag_number client_tag,
  p.project_type,
  i.current_stage_key current_stage,
  i.current_status,
  i.planned_start,
  i.planned_finish,
  i.fabrication_start,
  i.overall_progress,
  i.weight_kg,
  i.painting_m2 m2,
  'ops_core'::text source_version,
  i.updated_at source_updated_at,
  i.updated_at synced_at,
  p.display_code project_display,
  p.client,
  p.vessel,
  p.pm,
  p.project_status,
  p.replanned_finish,
  false archived,
  null::text archive_source,
  null::integer archive_rank,
  p.source_mode,
  p.id core_project_id,
  i.id core_item_id,
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
join ops_core.items i on i.project_id=p.id and not i.removed_from_scope
where p.active=true and p.source_mode='ops_core'

union all

select
  'BR'::text region,
  t.item_key iso_key,
  t.project_row_id::text project_row_id,
  ops_core.normalize_project_core(t.project_key) project_number,
  coalesce(nullif(t.drawing,''),nullif(t.item,''),t.item_key) iso,
  t.drawing,
  t.line_number,
  t.observations description,
  null::text client_tag,
  t.project_type,
  t.current_stage,
  t.current_status,
  t.start_date planned_start,
  t.finish_date planned_finish,
  t.fabrication_start,
  t.overall_progress,
  t.weight_kg,
  t.m2,
  t.source_version::text source_version,
  t.synced_at source_updated_at,
  t.synced_at,
  coalesce(p.display_code,'BSP '||ops_core.normalize_project_core(t.project_key)) project_display,
  coalesce(nullif(p.client,''),nullif(t.client,'')) client,
  coalesce(nullif(p.vessel,''),nullif(t.vessel,'')) vessel,
  coalesce(nullif(p.pm,''),nullif(t.pm,'')) pm,
  p.project_status,
  coalesce(p.replanned_finish,t.project_finish_date) replanned_finish,
  false archived,
  null::text archive_source,
  null::integer archive_rank,
  'legacy_tracking'::text source_mode,
  p.id core_project_id,
  null::uuid core_item_id,
  null::text material,
  null::text size,
  null::text schedule,
  null::numeric joints,
  null::numeric quantity,
  null::text spool_code,
  null::boolean requires_3d,
  null::boolean requires_assembly_simulation,
  p.customer_po
from legacy_current t
left join ops_core.projects p
  on p.region='BR'
 and p.project_core=ops_core.normalize_project_core(t.project_key)
where coalesce(p.source_mode,'legacy_tracking')='legacy_tracking';

select ops_core.sync_legacy_tracking_current_items('BR');
