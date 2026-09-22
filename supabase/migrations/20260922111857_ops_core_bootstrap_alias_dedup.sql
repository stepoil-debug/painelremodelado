CREATE OR REPLACE FUNCTION ops_core.bootstrap_tracking_snapshot(p_region text DEFAULT 'BR'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops_core', 'ops_panel', 'public'
AS $function$
declare
  v_region text := upper(coalesce(nullif(btrim(p_region),''),'BR'));
  v_projects integer := 0;
  v_items integer := 0;
  v_stages integer := 0;
begin
  with canonical_tracking as (
    select distinct on (tp.region,ops_core.normalize_project_core(tp.project_number)) tp.*
    from public.tracking_projects tp
    where tp.region=v_region and tp.active=true
      and ops_core.normalize_project_core(tp.project_number) is not null
    order by tp.region,ops_core.normalize_project_core(tp.project_number),
      tp.source_updated_at desc nulls last,tp.synced_at desc,tp.project_row_id desc
  )
  insert into ops_core.projects(
    region,project_core,project_prefix,display_code,client,vessel,pm,project_type,project_status,
    acceptance_date,contractual_date,deadline_date,replanned_finish,drawing_approval_date,fabrication_start,
    source_mode,validation_status,legacy_project_row_id,legacy_snapshot,source_metadata,active
  )
  select tp.region,ops_core.normalize_project_core(tp.project_number),ops_core.detect_prefix(tp.project_number),
    coalesce(nullif(tp.project_display,''),nullif(tp.project_number,''),ops_core.normalize_project_core(tp.project_number)),
    nullif(coalesce(nullif(w.client,''),nullif(tp.client,''),nullif(j.client,'')),''),
    nullif(coalesce(nullif(w.vessel,''),nullif(tp.vessel,'')),''),
    nullif(coalesce(nullif(w.pm,''),nullif(tp.pm,''),nullif(j.pm_responsible,'')),''),
    nullif(tp.project_type,''),coalesce(nullif(w.overall_status,''),nullif(tp.project_status,''),'ACTIVE'),
    w.acceptance_date,w.contractual_date,w.deadline_date,tp.replanned_finish,w.drawing_approval_date,tp.fabrication_start,
    'legacy_tracking','imported',tp.project_row_id,to_jsonb(tp),
    jsonb_build_object(
      'bootstrap','tracking_snapshot','tracking_source_version',tp.source_version,
      'tracking_synced_at',tp.synced_at,'wip_found',w.project_key is not null,'job_order_found',j.project_key is not null
    ),tp.active
  from canonical_tracking tp
  left join lateral (
    select * from ops_panel.wip_current w0
    where ops_core.normalize_project_core(w0.project_key)=ops_core.normalize_project_core(tp.project_number)
    order by w0.source_row_id desc limit 1
  ) w on true
  left join lateral (
    select * from ops_panel.job_order_current j0
    where ops_core.normalize_project_core(j0.project_key)=ops_core.normalize_project_core(tp.project_number)
    limit 1
  ) j on true
  on conflict(region,project_core) do update
  set client=coalesce(ops_core.projects.client,excluded.client),
      vessel=coalesce(ops_core.projects.vessel,excluded.vessel),
      pm=coalesce(ops_core.projects.pm,excluded.pm),
      project_type=coalesce(ops_core.projects.project_type,excluded.project_type),
      project_status=coalesce(nullif(ops_core.projects.project_status,''),excluded.project_status),
      acceptance_date=coalesce(ops_core.projects.acceptance_date,excluded.acceptance_date),
      contractual_date=coalesce(ops_core.projects.contractual_date,excluded.contractual_date),
      deadline_date=coalesce(ops_core.projects.deadline_date,excluded.deadline_date),
      replanned_finish=coalesce(ops_core.projects.replanned_finish,excluded.replanned_finish),
      drawing_approval_date=coalesce(ops_core.projects.drawing_approval_date,excluded.drawing_approval_date),
      fabrication_start=coalesce(ops_core.projects.fabrication_start,excluded.fabrication_start),
      legacy_project_row_id=coalesce(ops_core.projects.legacy_project_row_id,excluded.legacy_project_row_id),
      legacy_snapshot=case when ops_core.projects.source_mode='legacy_tracking' then excluded.legacy_snapshot else ops_core.projects.legacy_snapshot end,
      source_metadata=ops_core.projects.source_metadata || excluded.source_metadata,
      updated_at=now();
  get diagnostics v_projects=row_count;

  with alias_candidates as (
    select
      p.id project_id,
      p.region,
      a.alias,
      ops_core.normalize_alias(a.alias) alias_norm,
      a.source_system,
      a.priority
    from ops_core.projects p
    cross join lateral (
      values
        (p.project_core,'canonical'::text,1),
        (p.display_code,'bootstrap'::text,2)
    ) a(alias,source_system,priority)
    where p.region=v_region
      and a.alias is not null
      and ops_core.normalize_alias(a.alias) is not null
  ),
  chosen_aliases as (
    select distinct on (region,alias_norm)
      project_id,region,alias,alias_norm,source_system
    from alias_candidates
    order by region,alias_norm,priority,project_id
  )
  insert into ops_core.project_aliases(project_id,region,alias,alias_norm,source_system)
  select project_id,region,alias,alias_norm,source_system
  from chosen_aliases
  on conflict(region,alias_norm) do update
  set project_id=excluded.project_id,
      alias=excluded.alias,
      source_system=excluded.source_system;

  with raw_aliases as (
    select project_key alias,'wip'::text source_system from ops_panel.wip_current where project_key is not null
    union all select project_key,'job_order' from ops_panel.job_order_current where project_key is not null
    union all select project_key,'drawing' from ops_panel.drawings_current where project_key is not null
    union all select project_key,'dimensional' from ops_panel.dimensional_current where project_key is not null
  ),
  chosen as (
    select distinct on (p.id,p.region,ops_core.normalize_alias(r.alias))
      p.id project_id,p.region,r.alias,ops_core.normalize_alias(r.alias) alias_norm,r.source_system
    from ops_core.projects p
    join raw_aliases r on ops_core.normalize_project_core(r.alias)=p.project_core
    where p.region=v_region and ops_core.normalize_alias(r.alias) is not null
    order by p.id,p.region,ops_core.normalize_alias(r.alias),
      case r.source_system when 'wip' then 1 when 'job_order' then 2 when 'drawing' then 3 else 4 end
  )
  insert into ops_core.project_aliases(project_id,region,alias,alias_norm,source_system)
  select project_id,region,alias,alias_norm,source_system from chosen
  on conflict(region,alias_norm) do update
  set project_id=excluded.project_id,alias=excluded.alias,source_system=excluded.source_system;

  with canonical_items as (
    select distinct on (
      ti.region,ops_core.normalize_project_core(ti.project_number),
      coalesce(ops_core.normalize_item_key(nullif(ti.drawing,'')),ops_core.normalize_item_key(nullif(ti.iso,'')),ops_core.normalize_item_key(nullif(ti.iso_key,'')))
    ) ti.*
    from public.tracking_isos ti
    where ti.region=v_region and ti.active=true
    order by ti.region,ops_core.normalize_project_core(ti.project_number),
      coalesce(ops_core.normalize_item_key(nullif(ti.drawing,'')),ops_core.normalize_item_key(nullif(ti.iso,'')),ops_core.normalize_item_key(nullif(ti.iso_key,''))),
      ti.source_updated_at desc nulls last,ti.synced_at desc,ti.project_row_id desc
  )
  insert into ops_core.items(
    project_id,item_key,item_type,iso_code,drawing_code,line_number,description,
    weight_kg,painting_m2,current_stage_key,current_status,planned_start,planned_finish,
    fabrication_start,overall_progress,legacy_iso_key,legacy_project_row_id,source_metadata
  )
  select p.id,
    coalesce(ops_core.normalize_item_key(nullif(ti.drawing,'')),ops_core.normalize_item_key(nullif(ti.iso,'')),ops_core.normalize_item_key(nullif(ti.iso_key,''))),
    ops_core.infer_item_type(ti.project_type,ti.drawing,ti.description),
    nullif(ti.iso,''),nullif(ti.drawing,''),nullif(ti.line_number,''),nullif(ti.description,''),
    ti.weight_kg,ti.m2,nullif(ti.current_stage,''),coalesce(nullif(ti.current_status,''),'new'),
    ti.planned_start,ti.planned_finish,ti.fabrication_start,coalesce(ti.overall_progress,0),
    ti.iso_key,ti.project_row_id,
    jsonb_build_object('bootstrap','tracking_isos','source_version',ti.source_version,'source_updated_at',ti.source_updated_at,'synced_at',ti.synced_at,'client_tag',ti.client_tag)
  from canonical_items ti
  join ops_core.projects p on p.region=ti.region and p.project_core=ops_core.normalize_project_core(ti.project_number)
  where coalesce(ops_core.normalize_item_key(nullif(ti.drawing,'')),ops_core.normalize_item_key(nullif(ti.iso,'')),ops_core.normalize_item_key(nullif(ti.iso_key,''))) is not null
  on conflict(project_id,item_key) do update
  set iso_code=coalesce(ops_core.items.iso_code,excluded.iso_code),
      drawing_code=coalesce(ops_core.items.drawing_code,excluded.drawing_code),
      line_number=coalesce(ops_core.items.line_number,excluded.line_number),
      description=coalesce(ops_core.items.description,excluded.description),
      weight_kg=case when (select source_mode from ops_core.projects where id=ops_core.items.project_id)='legacy_tracking' then excluded.weight_kg else ops_core.items.weight_kg end,
      painting_m2=case when (select source_mode from ops_core.projects where id=ops_core.items.project_id)='legacy_tracking' then excluded.painting_m2 else ops_core.items.painting_m2 end,
      current_stage_key=case when (select source_mode from ops_core.projects where id=ops_core.items.project_id)='legacy_tracking' then excluded.current_stage_key else ops_core.items.current_stage_key end,
      current_status=case when (select source_mode from ops_core.projects where id=ops_core.items.project_id)='legacy_tracking' then excluded.current_status else ops_core.items.current_status end,
      planned_start=case when (select source_mode from ops_core.projects where id=ops_core.items.project_id)='legacy_tracking' then excluded.planned_start else ops_core.items.planned_start end,
      planned_finish=case when (select source_mode from ops_core.projects where id=ops_core.items.project_id)='legacy_tracking' then excluded.planned_finish else ops_core.items.planned_finish end,
      fabrication_start=case when (select source_mode from ops_core.projects where id=ops_core.items.project_id)='legacy_tracking' then excluded.fabrication_start else ops_core.items.fabrication_start end,
      overall_progress=case when (select source_mode from ops_core.projects where id=ops_core.items.project_id)='legacy_tracking' then excluded.overall_progress else ops_core.items.overall_progress end,
      source_metadata=ops_core.items.source_metadata || excluded.source_metadata,updated_at=now();
  get diagnostics v_items=row_count;

  with source_details as (
    select r.source_row_id,ops_core.normalize_project_core(r.payload #>> '{derived,project_key}') project_core,
      ops_core.normalize_item_key(coalesce(nullif(r.payload #>> '{derived,drawing}',''),nullif(r.payload #>> '{derived,item}',''))) item_key,
      r.payload->'cells' cells
    from ops_panel.source_rows r
    where r.source_key='tracking' and r.active=true
      and coalesce((r.payload #>> '{derived,is_detail}')::boolean,false)=true
  ),
  matched as (
    select distinct on (i.id) i.id item_id,s.source_row_id,s.cells
    from ops_core.items i
    join ops_core.projects p on p.id=i.project_id and p.region=v_region
    join source_details s on s.project_core=p.project_core and s.item_key=i.item_key
    order by i.id,s.source_row_id desc
  )
  update ops_core.items i
  set material=nullif(m.cells->>'Material',''),size=nullif(m.cells->>'Size',''),schedule=nullif(m.cells->>'SCH',''),
      quantity=public.tracking_parse_number(m.cells->>'Quantity Spools'),
      joints=public.tracking_parse_number(m.cells->>'Quantity Juntas'),
      hdg_kg=public.tracking_parse_number(m.cells->>'HDG (Kg)'),
      fbe_required=case
        when lower(coalesce(m.cells->>'FBE','')) in ('yes','sim','true','1','x') then true
        when lower(coalesce(m.cells->>'FBE','')) in ('no','não','nao','false','0') then false
        else null end,
      legacy_raw=m.cells,
      source_metadata=i.source_metadata || jsonb_build_object('legacy_source_row_id',m.source_row_id),
      updated_at=now()
  from matched m
  where i.id=m.item_id
    and (select source_mode from ops_core.projects p where p.id=i.project_id)='legacy_tracking';

  with canonical_stage_rows as (
    select distinct on (i.id,st.stage_key) i.id item_id,st.*
    from public.tracking_iso_stages st
    join public.tracking_isos ti on ti.region=st.region and ti.project_row_id=st.project_row_id and ti.iso_key=st.iso_key and ti.active=true
    join ops_core.projects p on p.region=ti.region and p.project_core=ops_core.normalize_project_core(ti.project_number)
    join ops_core.items i on i.project_id=p.id
      and i.item_key=coalesce(ops_core.normalize_item_key(nullif(ti.drawing,'')),ops_core.normalize_item_key(nullif(ti.iso,'')),ops_core.normalize_item_key(nullif(ti.iso_key,'')))
    where st.region=v_region and st.active=true
    order by i.id,st.stage_key,st.source_updated_at desc nulls last,st.synced_at desc
  )
  insert into ops_core.item_stages(
    item_id,stage_key,stage_order,is_applicable,progress,status,planned_date,forecast_date,actual_date,
    action,source_system,source_ref,updated_by,metadata
  )
  select item_id,stage_key,stage_order,is_applicable,progress,
    case when actual_date is not null or coalesce(progress,0)>=100 then 'completed'
         when coalesce(progress,0)>0 then 'in_progress' else 'pending' end,
    planned_date,forecast_date,actual_date,nullif(action,''),'tracking_snapshot',
    concat(region,':',project_row_id,':',iso_key,':',stage_key),nullif(manual_updated_by,''),
    jsonb_build_object('planned_source',planned_source,'forecast_source',forecast_source,'actual_source',actual_source,'action_source',action_source,'source_version',source_version,'source_updated_at',source_updated_at)
  from canonical_stage_rows
  on conflict(item_id,stage_key) do update
  set stage_order=excluded.stage_order,is_applicable=excluded.is_applicable,
      progress=case when (select p.source_mode from ops_core.projects p join ops_core.items ii on ii.project_id=p.id where ii.id=ops_core.item_stages.item_id)='legacy_tracking' then excluded.progress else ops_core.item_stages.progress end,
      status=case when (select p.source_mode from ops_core.projects p join ops_core.items ii on ii.project_id=p.id where ii.id=ops_core.item_stages.item_id)='legacy_tracking' then excluded.status else ops_core.item_stages.status end,
      planned_date=case when (select p.source_mode from ops_core.projects p join ops_core.items ii on ii.project_id=p.id where ii.id=ops_core.item_stages.item_id)='legacy_tracking' then excluded.planned_date else ops_core.item_stages.planned_date end,
      forecast_date=case when (select p.source_mode from ops_core.projects p join ops_core.items ii on ii.project_id=p.id where ii.id=ops_core.item_stages.item_id)='legacy_tracking' then excluded.forecast_date else ops_core.item_stages.forecast_date end,
      actual_date=case when (select p.source_mode from ops_core.projects p join ops_core.items ii on ii.project_id=p.id where ii.id=ops_core.item_stages.item_id)='legacy_tracking' then excluded.actual_date else ops_core.item_stages.actual_date end,
      action=case when (select p.source_mode from ops_core.projects p join ops_core.items ii on ii.project_id=p.id where ii.id=ops_core.item_stages.item_id)='legacy_tracking' then excluded.action else ops_core.item_stages.action end,
      metadata=ops_core.item_stages.metadata || excluded.metadata,updated_at=now();
  get diagnostics v_stages=row_count;

  insert into ops_core.legacy_source_map(source_system,source_type,source_project_row_id,source_item_key,source_id,project_id,item_id,metadata)
  select 'tracking','project',tp.project_row_id,null,tp.project_row_id,p.id,null,
    jsonb_build_object('project_number',tp.project_number,'source_version',tp.source_version)
  from public.tracking_projects tp
  join ops_core.projects p on p.region=tp.region and p.project_core=ops_core.normalize_project_core(tp.project_number)
  where tp.region=v_region and tp.active=true
  on conflict do nothing;

  insert into ops_core.legacy_source_map(source_system,source_type,source_project_row_id,source_item_key,source_id,project_id,item_id,metadata)
  select 'tracking','item',i.legacy_project_row_id,i.legacy_iso_key,i.legacy_iso_key,p.id,i.id,jsonb_build_object('item_key',i.item_key)
  from ops_core.items i join ops_core.projects p on p.id=i.project_id
  where p.region=v_region
  on conflict do nothing;

  perform ops_core.ensure_item_stages(i.id)
  from ops_core.items i join ops_core.projects p on p.id=i.project_id
  where p.region=v_region;

  perform ops_core.refresh_registration_candidates();

  return jsonb_build_object('ok',true,'region',v_region,'projects_upserted',v_projects,'items_upserted',v_items,'stages_upserted',v_stages,'finished_at',now());
end $function$
;