
alter table ops_core.projects drop constraint if exists projects_source_mode_check;
alter table ops_core.projects
  add constraint projects_source_mode_check
  check (source_mode in ('pending_validation','legacy_tracking','ops_core','archived'));

create or replace function ops_core.materialize_candidate(
  p_project_core text,
  p_actor text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,ops_panel,public
as $$
declare
  v_core text := ops_core.normalize_project_core(p_project_core);
  c ops_core.registration_candidates%rowtype;
  p ops_core.projects%rowtype;
  v_created boolean := false;
  v_items integer := 0;
  r record;
begin
  select * into c
  from ops_core.registration_candidates
  where region='BR' and project_core=v_core
  for update;

  if not found then
    raise exception 'Candidato % não encontrado.',p_project_core;
  end if;

  select * into p
  from ops_core.projects
  where region='BR' and project_core=v_core
  limit 1;

  if not found then
    insert into ops_core.projects(
      region,project_core,project_prefix,display_code,
      client,vessel,pm,customer_po,project_status,
      acceptance_date,contractual_date,deadline_date,drawing_approval_date,
      source_mode,validation_status,source_metadata
    )
    values(
      'BR',v_core,ops_core.detect_prefix(c.display_code),coalesce(nullif(c.display_code,''),v_core),
      coalesce(
        nullif(c.suggested_data #>> '{wip,client}',''),
        nullif(c.suggested_data #>> '{job_order,client}',''),
        nullif(c.suggested_data #>> '{drawing,client}','')
      ),
      nullif(c.suggested_data #>> '{wip,vessel}',''),
      coalesce(
        nullif(c.suggested_data #>> '{wip,pm}',''),
        nullif(c.suggested_data #>> '{job_order,pm}','')
      ),
      coalesce(
        nullif(c.suggested_data #>> '{wip,customer_po}',''),
        nullif(c.suggested_data #>> '{job_order,po_numbers}','')
      ),
      coalesce(nullif(c.suggested_data #>> '{wip,project_status}',''),'PENDING VALIDATION'),
      public.tracking_parse_date(c.suggested_data #>> '{wip,acceptance_date}'),
      public.tracking_parse_date(c.suggested_data #>> '{wip,contractual_date}'),
      public.tracking_parse_date(c.suggested_data #>> '{wip,deadline_date}'),
      public.tracking_parse_date(c.suggested_data #>> '{wip,drawing_approval_date}'),
      'pending_validation','validation_required',
      jsonb_build_object(
        'created_from_candidate',c.id,
        'created_by',coalesce(nullif(p_actor,''),'system'),
        'suggested_data',c.suggested_data
      )
    )
    returning * into p;
    v_created:=true;
  end if;

  perform ops_core.register_project_alias(p.id,'BR',p.project_core,'canonical');
  perform ops_core.register_project_alias(p.id,'BR',p.display_code,'candidate');

  for r in
    select
      d.source_row_id,
      d.drawing_number,
      d.document_title,
      d.current_revision,
      d.current_status,
      d.raw_cells,
      t.requires_3d_scan,
      t.requires_assembly_simulation
    from ops_panel.drawings_current d
    left join ops_panel.drawing_technical_profile t
      on t.source_row_id=d.source_row_id
    where ops_core.normalize_project_core(d.project_key)=v_core
      and (
        upper(coalesce(d.raw_cells->>'UNIT','')) like '%SPOOL%'
        or upper(coalesce(d.raw_cells->>'UNIT','')) like '%SUPPORT%'
        or upper(coalesce(d.drawing_number,'')) like '%-ISO-%'
        or upper(coalesce(d.drawing_number,'')) like '%-SUP-%'
      )
  loop
    insert into ops_core.items(
      project_id,item_key,item_type,iso_code,drawing_code,description,
      quantity,requires_3d,requires_assembly_simulation,
      current_stage_key,current_status,source_metadata
    )
    values(
      p.id,
      coalesce(
        ops_core.normalize_item_key(r.drawing_number),
        ops_core.normalize_item_key(r.document_title),
        'DRAWING'||r.source_row_id::text
      ),
      ops_core.infer_item_type(
        r.raw_cells->>'UNIT',
        r.drawing_number,
        r.document_title
      ),
      case when upper(coalesce(r.drawing_number,'')) like '%-ISO-%' then r.drawing_number else null end,
      r.drawing_number,
      r.document_title,
      public.tracking_parse_number(r.raw_cells->>'QUANTITY'),
      r.requires_3d_scan,
      r.requires_assembly_simulation,
      'drawing',
      'validation_required',
      jsonb_build_object(
        'candidate_materialized',true,
        'drawing_source_row_id',r.source_row_id,
        'drawing_revision',r.current_revision,
        'provisional_breakdown',
          coalesce(public.tracking_parse_number(r.raw_cells->>'QUANTITY'),1)>1
      )
    )
    on conflict(project_id,item_key) do update
    set drawing_code=coalesce(ops_core.items.drawing_code,excluded.drawing_code),
        description=coalesce(ops_core.items.description,excluded.description),
        quantity=coalesce(excluded.quantity,ops_core.items.quantity),
        requires_3d=coalesce(excluded.requires_3d,ops_core.items.requires_3d),
        requires_assembly_simulation=coalesce(excluded.requires_assembly_simulation,ops_core.items.requires_assembly_simulation),
        source_metadata=ops_core.items.source_metadata||excluded.source_metadata,
        updated_at=now();
  end loop;

  perform ops_core.ensure_item_stages(i.id)
  from ops_core.items i
  where i.project_id=p.id;

  for r in
    select source_row_id
    from ops_panel.source_rows
    where source_key='drawing'
      and active=true
      and ops_core.normalize_project_core(payload #>> '{derived,project_key}')=v_core
  loop
    perform ops_core.sync_drawing_source_row(r.source_row_id);
  end loop;

  select count(*) into v_items
  from ops_core.items
  where project_id=p.id and not removed_from_scope;

  update ops_core.registration_candidates
  set candidate_status='reconciled',
      validated_project_id=p.id,
      last_seen_at=now()
  where id=c.id;

  insert into ops_core.audit_events(
    project_id,entity_type,entity_id,action,actor_email,source_system,after_data
  )
  values(
    p.id,'project',p.id::text,
    case when v_created then 'project.materialized_from_candidate' else 'project.candidate_refreshed' end,
    coalesce(nullif(p_actor,''),'system'),'ops_core',
    jsonb_build_object('project_core',p.project_core,'items',v_items,'source_mode',p.source_mode)
  );

  return jsonb_build_object(
    'ok',true,
    'created',v_created,
    'project_id',p.id,
    'project_core',p.project_core,
    'display_code',p.display_code,
    'source_mode',p.source_mode,
    'items',v_items
  );
end $$;

create or replace function ops_core.upsert_project_item(
  p_project_key text,
  p_item_id uuid default null,
  p_item_key text default null,
  p_iso_code text default null,
  p_spool_code text default null,
  p_drawing_code text default null,
  p_item_type text default 'SPOOL',
  p_description text default null,
  p_line_number text default null,
  p_material text default null,
  p_size text default null,
  p_schedule text default null,
  p_weight_kg numeric default null,
  p_painting_m2 numeric default null,
  p_quantity numeric default null,
  p_joints numeric default null,
  p_requires_3d boolean default null,
  p_requires_assembly_simulation boolean default null,
  p_actor text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,public
as $$
declare
  p ops_core.projects%rowtype;
  i_before ops_core.items%rowtype;
  i_after ops_core.items%rowtype;
  v_key text;
  v_type text := upper(coalesce(nullif(p_item_type,''),'SPOOL'));
begin
  select * into p
  from ops_core.projects
  where region='BR' and project_core=ops_core.normalize_project_core(p_project_key)
  limit 1;
  if not found then raise exception 'Projeto não encontrado.'; end if;
  if p.source_mode='archived' then raise exception 'Projeto arquivado não pode ser editado.'; end if;
  if v_type not in ('SPOOL','SUPPORT','STRUCTURE','FRAME','OTHER') then
    raise exception 'Tipo de item inválido.';
  end if;

  if p_item_id is not null then
    select * into i_before
    from ops_core.items
    where id=p_item_id and project_id=p.id
    for update;
  end if;

  v_key:=coalesce(
    ops_core.normalize_item_key(p_item_key),
    ops_core.normalize_item_key(p_spool_code),
    ops_core.normalize_item_key(p_iso_code),
    ops_core.normalize_item_key(p_drawing_code)
  );
  if v_key is null then raise exception 'Informe uma identificação para o item.'; end if;

  if i_before.id is null then
    insert into ops_core.items(
      project_id,item_key,item_type,iso_code,spool_code,drawing_code,line_number,description,
      material,size,schedule,weight_kg,painting_m2,quantity,joints,
      requires_3d,requires_assembly_simulation,current_stage_key,current_status,source_metadata
    )
    values(
      p.id,v_key,v_type,nullif(p_iso_code,''),nullif(p_spool_code,''),nullif(p_drawing_code,''),
      nullif(p_line_number,''),nullif(p_description,''),nullif(p_material,''),nullif(p_size,''),nullif(p_schedule,''),
      p_weight_kg,p_painting_m2,p_quantity,p_joints,p_requires_3d,p_requires_assembly_simulation,
      'drawing','validation_required',
      jsonb_build_object('manual_validation',true,'provisional_breakdown',false,'edited_by',p_actor)
    )
    returning * into i_after;
  else
    update ops_core.items
    set item_key=v_key,item_type=v_type,
        iso_code=nullif(p_iso_code,''),spool_code=nullif(p_spool_code,''),
        drawing_code=coalesce(nullif(p_drawing_code,''),drawing_code),
        line_number=nullif(p_line_number,''),description=nullif(p_description,''),
        material=nullif(p_material,''),size=nullif(p_size,''),schedule=nullif(p_schedule,''),
        weight_kg=p_weight_kg,painting_m2=p_painting_m2,quantity=p_quantity,joints=p_joints,
        requires_3d=p_requires_3d,requires_assembly_simulation=p_requires_assembly_simulation,
        source_metadata=(source_metadata-'provisional_breakdown') ||
          jsonb_build_object('manual_validation',true,'provisional_breakdown',false,'edited_by',p_actor),
        updated_at=now()
    where id=i_before.id
    returning * into i_after;
  end if;

  perform ops_core.ensure_item_stages(i_after.id);

  update ops_core.item_stages
  set is_applicable=case
    when stage_key='hydro' then i_after.item_type='SPOOL'
    when stage_key in ('scan-initial','scan-final') then coalesce(i_after.requires_3d,true)
    when stage_key='assembly-simulation' then coalesce(i_after.requires_assembly_simulation,false)
    else is_applicable end,
    updated_at=now()
  where item_id=i_after.id;

  insert into ops_core.audit_events(
    project_id,item_id,entity_type,entity_id,action,actor_email,source_system,before_data,after_data
  )
  values(
    p.id,i_after.id,'item',i_after.id::text,
    case when i_before.id is null then 'item.created' else 'item.updated' end,
    coalesce(nullif(p_actor,''),'system'),'ops_core',
    case when i_before.id is null then null else to_jsonb(i_before) end,
    to_jsonb(i_after)
  );

  return jsonb_build_object('ok',true,'item',to_jsonb(i_after));
end $$;

create or replace function ops_core.mark_item_removed(
  p_project_key text,
  p_item_id uuid,
  p_reason text default null,
  p_actor text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,public
as $$
declare p ops_core.projects%rowtype; i ops_core.items%rowtype;
begin
  select * into p
  from ops_core.projects
  where region='BR' and project_core=ops_core.normalize_project_core(p_project_key)
  limit 1;
  if not found then raise exception 'Projeto não encontrado.'; end if;

  select * into i
  from ops_core.items
  where id=p_item_id and project_id=p.id
  for update;
  if not found then raise exception 'Item não encontrado.'; end if;

  update ops_core.items
  set removed_from_scope=true,current_status='removed_from_scope',
      source_metadata=source_metadata||jsonb_build_object(
        'removed_reason',p_reason,'removed_by',p_actor,'removed_at',now()
      ),
      updated_at=now()
  where id=i.id;

  update ops_core.handoffs
  set status='cancelled',
      metadata=metadata||jsonb_build_object('cancel_reason','item_removed_from_scope')
  where item_id=i.id and status='available';

  insert into ops_core.audit_events(
    project_id,item_id,entity_type,entity_id,action,actor_email,source_system,before_data,after_data,metadata
  )
  values(
    p.id,i.id,'item',i.id::text,'item.removed_from_scope',
    p_actor,'ops_core',to_jsonb(i),
    (select to_jsonb(x) from ops_core.items x where x.id=i.id),
    jsonb_build_object('reason',p_reason)
  );

  return jsonb_build_object('ok',true,'item_id',i.id,'removed_from_scope',true);
end $$;

create or replace function public.ops_core_materialize_candidate(p_project_key text,p_actor text)
returns jsonb
language sql
security definer
set search_path=public,ops_core
as $$ select ops_core.materialize_candidate(p_project_key,p_actor); $$;

create or replace function public.ops_core_upsert_item(
  p_project_key text,
  p_item_id uuid default null,
  p_item_key text default null,
  p_iso_code text default null,
  p_spool_code text default null,
  p_drawing_code text default null,
  p_item_type text default 'SPOOL',
  p_description text default null,
  p_line_number text default null,
  p_material text default null,
  p_size text default null,
  p_schedule text default null,
  p_weight_kg numeric default null,
  p_painting_m2 numeric default null,
  p_quantity numeric default null,
  p_joints numeric default null,
  p_requires_3d boolean default null,
  p_requires_assembly_simulation boolean default null,
  p_actor text default 'system'
)
returns jsonb
language sql
security definer
set search_path=public,ops_core
as $$
select ops_core.upsert_project_item(
  p_project_key,p_item_id,p_item_key,p_iso_code,p_spool_code,p_drawing_code,p_item_type,
  p_description,p_line_number,p_material,p_size,p_schedule,p_weight_kg,p_painting_m2,p_quantity,
  p_joints,p_requires_3d,p_requires_assembly_simulation,p_actor
);
$$;

create or replace function public.ops_core_remove_item(
  p_project_key text,
  p_item_id uuid,
  p_reason text,
  p_actor text
)
returns jsonb
language sql
security definer
set search_path=public,ops_core
as $$ select ops_core.mark_item_removed(p_project_key,p_item_id,p_reason,p_actor); $$;

create or replace function public.ops_core_project_validation_report(p_project_key text)
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core
as $$
with p as (
  select *
  from ops_core.projects
  where region='BR' and project_core=ops_core.normalize_project_core(p_project_key)
  limit 1
),
stats as (
  select
    count(*) item_count,
    count(*) filter(where i.weight_kg is null) missing_weight,
    count(*) filter(where i.material is null or btrim(i.material)='') missing_material,
    count(*) filter(where i.item_type='OTHER') unclassified_items,
    count(*) filter(where coalesce((i.source_metadata->>'provisional_breakdown')::boolean,false)) provisional_breakdown,
    count(*) filter(where not exists(
      select 1 from ops_core.item_stages s where s.item_id=i.id
    )) items_without_workflow
  from ops_core.items i
  join p on i.project_id=p.id
  where not i.removed_from_scope
),
docs as (
  select
    count(*) document_count,
    count(*) filter(where current_revision is null or current_revision='UNSPECIFIED') missing_revision,
    count(*) filter(where source_row_id is not null) source_linked
  from ops_core.documents d
  join p on d.project_id=p.id
)
select jsonb_build_object(
  'project',(select to_jsonb(p) from p),
  'items',to_jsonb(stats),
  'documents',to_jsonb(docs),
  'blocking_issues',
    (case when (select item_count from stats)=0 then jsonb_build_array('Projeto sem itens.') else '[]'::jsonb end)
    ||
    (case when (select items_without_workflow from stats)>0 then jsonb_build_array('Há itens sem workflow.') else '[]'::jsonb end)
    ||
    (case when (select provisional_breakdown from stats)>0 then jsonb_build_array('Há documentos com quantidade maior que 1 que ainda precisam ser detalhados em itens reais.') else '[]'::jsonb end),
  'warnings',jsonb_build_object(
    'missing_weight',(select missing_weight from stats),
    'missing_material',(select missing_material from stats),
    'unclassified_items',(select unclassified_items from stats),
    'provisional_breakdown',(select provisional_breakdown from stats),
    'documents_without_revision',(select missing_revision from docs)
  ),
  'ready_for_cutover',(
    (select item_count from stats)>0
    and (select items_without_workflow from stats)=0
    and (select provisional_breakdown from stats)=0
  ),
  'generated_at',now()
)
from stats,docs;
$$;

revoke all on function public.ops_core_materialize_candidate(text,text) from public,anon,authenticated;
revoke all on function public.ops_core_upsert_item(text,uuid,text,text,text,text,text,text,text,text,text,text,numeric,numeric,numeric,numeric,boolean,boolean,text) from public,anon,authenticated;
revoke all on function public.ops_core_remove_item(text,uuid,text,text) from public,anon,authenticated;

grant execute on function public.ops_core_materialize_candidate(text,text) to service_role;
grant execute on function public.ops_core_upsert_item(text,uuid,text,text,text,text,text,text,text,text,text,text,numeric,numeric,numeric,numeric,boolean,boolean,text) to service_role;
grant execute on function public.ops_core_remove_item(text,uuid,text,text) to service_role;
