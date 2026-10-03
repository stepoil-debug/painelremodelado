
create or replace function ops_core.normalize_item_key(value text)
returns text language sql immutable as $$
  select nullif(regexp_replace(upper(coalesce(value,'')), '[^A-Z0-9]', '', 'g'),'');
$$;

create or replace function ops_core.infer_item_type(project_type text, drawing text, description text)
returns text language plpgsql immutable as $$
declare v text := lower(coalesce(project_type,'') || ' ' || coalesce(drawing,'') || ' ' || coalesce(description,''));
begin
  if v ~ '(support|suporte|sup[-_ ]?[0-9])' then return 'SUPPORT'; end if;
  if v ~ '(structure|estrutura|str[-_ ]?[0-9])' then return 'STRUCTURE'; end if;
  if v ~ '(frame|quadro)' then return 'FRAME'; end if;
  if v ~ '(spool|iso|pipe|piping)' then return 'SPOOL'; end if;
  return 'OTHER';
end $$;

create or replace function ops_core.register_project_alias(
  p_project_id uuid,p_region text,p_alias text,p_source text default 'system'
)
returns void language plpgsql security definer set search_path=ops_core,public as $$
declare v_norm text := ops_core.normalize_alias(p_alias);
begin
  if p_project_id is null or v_norm is null then return; end if;
  insert into ops_core.project_aliases(project_id,region,alias,alias_norm,source_system)
  values(p_project_id,upper(coalesce(nullif(p_region,''),'BR')),p_alias,v_norm,coalesce(nullif(p_source,''),'system'))
  on conflict(region,alias_norm) do update
  set project_id=excluded.project_id,alias=excluded.alias,source_system=excluded.source_system;
end $$;

create or replace function ops_core.ensure_item_stages(p_item_id uuid)
returns void language plpgsql security definer set search_path=ops_core,public as $$
declare v_item ops_core.items%rowtype;
begin
  select * into v_item from ops_core.items where id=p_item_id;
  if not found then return; end if;

  insert into ops_core.item_stages(item_id,stage_key,stage_order,is_applicable,status,source_system)
  select v_item.id,w.stage_key,w.stage_order,
    case
      when w.stage_key='hydro' then v_item.item_type='SPOOL'
      when w.stage_key in ('scan-initial','scan-final') then coalesce(v_item.requires_3d,true)
      when w.stage_key='assembly-simulation' then coalesce(v_item.requires_assembly_simulation,false)
      else true
    end,
    'pending','ops_core'
  from ops_core.workflow_stages w
  where w.active=true
  on conflict(item_id,stage_key) do nothing;
end $$;

create or replace function ops_core.recompute_item_progress(p_item_id uuid)
returns numeric language plpgsql security definer set search_path=ops_core,public as $$
declare v_progress numeric;
begin
  select round(coalesce(avg(coalesce(progress,0)),0),2)
  into v_progress
  from ops_core.item_stages
  where item_id=p_item_id and is_applicable=true;

  update ops_core.items set overall_progress=coalesce(v_progress,0),updated_at=now()
  where id=p_item_id;
  return coalesce(v_progress,0);
end $$;

create or replace function ops_core.refresh_registration_candidates()
returns jsonb language plpgsql security definer set search_path=ops_core,ops_panel,public as $$
declare v_count integer := 0;
begin
  with source_projects as (
    select 'wip'::text source_system,
      ops_core.normalize_project_core(project_key) project_core,
      project_key display_code,
      jsonb_build_object(
        'client',client,'vessel',vessel,'pm',pm,'customer_po',customer_po,
        'acceptance_date',acceptance_date,'contractual_date',contractual_date,
        'deadline_date',deadline_date,'drawing_approval_date',drawing_approval_date,
        'project_status',overall_status
      ) suggested
    from ops_panel.wip_current where project_key is not null

    union all

    select 'job_order',ops_core.normalize_project_core(project_key),project_key,
      jsonb_build_object('client',client,'pm',pm_responsible,'po_numbers',po_numbers,'project_status',project_status)
    from ops_panel.job_order_current where project_key is not null

    union all

    select 'drawing',ops_core.normalize_project_core(project_key),min(project_key),
      jsonb_build_object('client',max(client),'drawing_count',count(*),'latest_revision',max(current_revision))
    from ops_panel.drawings_current
    where project_key is not null
    group by ops_core.normalize_project_core(project_key)
  ),
  grouped as (
    select project_core,
      min(display_code) filter(where display_code is not null) display_code,
      array_agg(distinct source_system order by source_system) source_systems,
      jsonb_object_agg(source_system,suggested) suggested_data
    from source_projects
    where project_core is not null
    group by project_core
  ),
  inserted as (
    insert into ops_core.registration_candidates(
      region,project_core,display_code,candidate_status,source_systems,suggested_data,last_seen_at,validated_project_id
    )
    select 'BR',g.project_core,coalesce(g.display_code,g.project_core),
      case when p.id is null then 'validation_required' else 'validated' end,
      g.source_systems,g.suggested_data,now(),
      case when p.source_mode='ops_core' then p.id else null end
    from grouped g
    left join ops_core.projects p on p.region='BR' and p.project_core=g.project_core
    on conflict(region,project_core) do update
    set display_code=excluded.display_code,
        source_systems=excluded.source_systems,
        suggested_data=excluded.suggested_data,
        last_seen_at=now(),
        candidate_status=case when ops_core.registration_candidates.validated_project_id is not null then 'validated' else excluded.candidate_status end,
        validated_project_id=coalesce(ops_core.registration_candidates.validated_project_id,excluded.validated_project_id)
    returning 1
  )
  select count(*) into v_count from inserted;

  return jsonb_build_object('ok',true,'candidates_upserted',v_count,'refreshed_at',now());
end $$;

create or replace function ops_core.bootstrap_tracking_snapshot(p_region text default 'BR')
returns jsonb language plpgsql security definer set search_path=ops_core,ops_panel,public as $$
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

  insert into ops_core.project_aliases(project_id,region,alias,alias_norm,source_system)
  select p.id,p.region,a.alias,ops_core.normalize_alias(a.alias),a.source_system
  from ops_core.projects p
  cross join lateral (values (p.project_core,'canonical'),(p.display_code,'bootstrap')) a(alias,source_system)
  where p.region=v_region and a.alias is not null and ops_core.normalize_alias(a.alias) is not null
  on conflict(region,alias_norm) do update set project_id=excluded.project_id;

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
end $$;

create or replace function ops_core.project_cutover(p_project_core text,p_actor text default 'system')
returns jsonb language plpgsql security definer set search_path=ops_core,public as $$
declare
  v_core text := ops_core.normalize_project_core(p_project_core);
  v_project ops_core.projects%rowtype;
  v_items integer;
  v_missing_stages integer;
begin
  select * into v_project from ops_core.projects
  where region='BR' and project_core=v_core for update;
  if not found then raise exception 'Projeto % não encontrado no ops_core.',p_project_core; end if;

  select count(*) into v_items from ops_core.items where project_id=v_project.id and removed_from_scope=false;
  if v_items=0 then raise exception 'Projeto % não possui itens para cutover.',v_project.display_code; end if;

  perform ops_core.ensure_item_stages(id) from ops_core.items where project_id=v_project.id;

  select count(*) into v_missing_stages
  from ops_core.items i
  where i.project_id=v_project.id and not exists(select 1 from ops_core.item_stages s where s.item_id=i.id);
  if v_missing_stages>0 then raise exception 'Projeto % possui % itens sem workflow.',v_project.display_code,v_missing_stages; end if;

  update ops_core.projects
  set validation_status='validated',source_mode='ops_core',
      validated_at=coalesce(validated_at,now()),validated_by=coalesce(nullif(p_actor,''),'system'),
      cutover_at=now(),cutover_by=coalesce(nullif(p_actor,''),'system'),updated_at=now()
  where id=v_project.id;

  insert into ops_core.audit_events(project_id,entity_type,entity_id,action,actor_email,source_system,before_data,after_data)
  values(v_project.id,'project',v_project.id::text,'project.cutover',coalesce(nullif(p_actor,''),'system'),'ops_core',
    jsonb_build_object('source_mode',v_project.source_mode,'validation_status',v_project.validation_status),
    jsonb_build_object('source_mode','ops_core','validation_status','validated','items',v_items));

  update ops_core.registration_candidates
  set candidate_status='validated',validated_project_id=v_project.id,last_seen_at=now()
  where region=v_project.region and project_core=v_project.project_core;

  return jsonb_build_object('ok',true,'project_id',v_project.id,'project_core',v_project.project_core,'display_code',v_project.display_code,'items',v_items,'source_mode','ops_core','cutover_at',now());
end $$;

create or replace function ops_core.project_revert_to_legacy(p_project_core text,p_actor text default 'system')
returns jsonb language plpgsql security definer set search_path=ops_core,public as $$
declare v_core text := ops_core.normalize_project_core(p_project_core); v_project ops_core.projects%rowtype;
begin
  select * into v_project from ops_core.projects where region='BR' and project_core=v_core for update;
  if not found then raise exception 'Projeto não encontrado.'; end if;
  if v_project.legacy_project_row_id is null then raise exception 'Projeto não possui origem Tracking para rollback.'; end if;

  update ops_core.projects set source_mode='legacy_tracking',validation_status='validation_required',updated_at=now()
  where id=v_project.id;

  insert into ops_core.audit_events(project_id,entity_type,entity_id,action,actor_email,source_system,before_data,after_data)
  values(v_project.id,'project',v_project.id::text,'project.rollback_to_legacy',coalesce(nullif(p_actor,''),'system'),'ops_core',
    jsonb_build_object('source_mode',v_project.source_mode),jsonb_build_object('source_mode','legacy_tracking'));

  return jsonb_build_object('ok',true,'project_id',v_project.id,'source_mode','legacy_tracking');
end $$;

create or replace view ops_core.demand_feed as
select p.region,coalesce(i.legacy_iso_key,i.item_key) iso_key,
  coalesce(i.legacy_project_row_id,p.legacy_project_row_id,'') project_row_id,
  p.project_core project_number,coalesce(i.iso_code,i.drawing_code,i.item_key) iso,
  i.drawing_code drawing,i.line_number,i.description,i.tag_number client_tag,p.project_type,
  i.current_stage_key current_stage,i.current_status,i.planned_start,i.planned_finish,i.fabrication_start,
  i.overall_progress,i.weight_kg,i.painting_m2 m2,'ops_core'::text source_version,
  i.updated_at source_updated_at,i.updated_at synced_at,p.display_code project_display,p.client,p.vessel,p.pm,
  p.project_status,p.replanned_finish,false archived,null::text archive_source,null::integer archive_rank,
  p.source_mode,p.id core_project_id,i.id core_item_id
from ops_core.projects p
join ops_core.items i on i.project_id=p.id and i.removed_from_scope=false
where p.active=true and p.source_mode='ops_core'
union all
select ti.region,ti.iso_key,ti.project_row_id,ti.project_number,ti.iso,ti.drawing,ti.line_number,ti.description,
  ti.client_tag,ti.project_type,ti.current_stage,ti.current_status,ti.planned_start,ti.planned_finish,
  ti.fabrication_start,ti.overall_progress,ti.weight_kg,ti.m2,ti.source_version,ti.source_updated_at,ti.synced_at,
  tp.project_display,tp.client,tp.vessel,tp.pm,tp.project_status,tp.replanned_finish,false,null::text,null::integer,
  'legacy_tracking'::text,p.id,null::uuid
from public.tracking_isos ti
left join public.tracking_projects tp on tp.region=ti.region and tp.project_row_id=ti.project_row_id and tp.active=true
left join ops_core.projects p on p.region=ti.region and p.project_core=ops_core.normalize_project_core(ti.project_number)
where ti.active=true and coalesce(p.source_mode,'legacy_tracking')='legacy_tracking';

create or replace function public.ops_core_get_demands(p_region text default 'BR',p_limit integer default 2000)
returns jsonb language sql stable security definer set search_path=public,ops_core as $$
select coalesce(jsonb_agg(to_jsonb(q) order by q.project_number,q.iso),'[]'::jsonb)
from (
  select * from ops_core.demand_feed
  where p_region is null or upper(region)=upper(p_region)
  order by project_number,iso
  limit greatest(1,least(coalesce(p_limit,2000),5000))
) q;
$$;

create or replace function public.ops_core_search_demands(p_region text default 'BR',p_search text default '',p_limit integer default 500)
returns jsonb language sql stable security definer set search_path=public,ops_core as $$
select coalesce(jsonb_agg(to_jsonb(q) order by q.project_number,q.iso),'[]'::jsonb)
from (
  select * from ops_core.demand_feed
  where (p_region is null or upper(region)=upper(p_region))
    and (btrim(coalesce(p_search,''))='' or project_number ilike '%'||p_search||'%' or project_display ilike '%'||p_search||'%'
      or iso ilike '%'||p_search||'%' or drawing ilike '%'||p_search||'%' or client ilike '%'||p_search||'%'
      or vessel ilike '%'||p_search||'%' or description ilike '%'||p_search||'%')
  order by project_number,iso
  limit greatest(1,least(coalesce(p_limit,500),2000))
) q;
$$;

create or replace function public.ops_core_migration_status()
returns jsonb language sql stable security definer set search_path=public,ops_core as $$
with p as (
  select count(*) total,count(*) filter(where source_mode='ops_core') cutover,
    count(*) filter(where source_mode='legacy_tracking') legacy,
    count(*) filter(where validation_status='validation_required') validation_required
  from ops_core.projects where active=true and region='BR'
), i as (
  select count(*) total,count(*) filter(where p.source_mode='ops_core') cutover,
    count(*) filter(where p.source_mode='legacy_tracking') legacy,count(*) filter(where i.removed_from_scope) removed
  from ops_core.items i join ops_core.projects p on p.id=i.project_id where p.active=true and p.region='BR'
), c as (
  select count(*) total,count(*) filter(where candidate_status='validation_required') pending,
    count(*) filter(where candidate_status='validated') validated
  from ops_core.registration_candidates where region='BR'
)
select jsonb_build_object('projects',to_jsonb(p),'items',to_jsonb(i),'candidates',to_jsonb(c),'generated_at',now())
from p,i,c;
$$;

create or replace function public.ops_core_project_detail(p_project_key text)
returns jsonb language sql stable security definer set search_path=public,ops_core as $$
with p as (
  select * from ops_core.projects
  where region='BR' and project_core=ops_core.normalize_project_core(p_project_key) limit 1
)
select jsonb_build_object(
  'project',(select to_jsonb(p) from p),
  'aliases',coalesce((select jsonb_agg(to_jsonb(a) order by a.alias) from ops_core.project_aliases a join p on a.project_id=p.id),'[]'::jsonb),
  'items',coalesce((select jsonb_agg(to_jsonb(i) order by i.iso_code,i.drawing_code,i.item_key) from ops_core.items i join p on i.project_id=p.id),'[]'::jsonb),
  'stages',coalesce((select jsonb_agg(to_jsonb(s) order by i.item_key,s.stage_order) from ops_core.item_stages s join ops_core.items i on i.id=s.item_id join p on i.project_id=p.id),'[]'::jsonb),
  'documents',coalesce((select jsonb_agg(to_jsonb(d) order by d.document_number,d.updated_at desc) from ops_core.documents d join p on d.project_id=p.id),'[]'::jsonb),
  'handoffs',coalesce((select jsonb_agg(to_jsonb(h) order by h.available_at desc) from ops_core.handoffs h join p on h.project_id=p.id),'[]'::jsonb),
  'notifications',coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at desc) from ops_core.notifications n join p on n.project_id=p.id),'[]'::jsonb)
);
$$;

revoke all on function public.ops_core_get_demands(text,integer) from public,anon,authenticated;
revoke all on function public.ops_core_search_demands(text,text,integer) from public,anon,authenticated;
revoke all on function public.ops_core_migration_status() from public,anon,authenticated;
revoke all on function public.ops_core_project_detail(text) from public,anon,authenticated;
