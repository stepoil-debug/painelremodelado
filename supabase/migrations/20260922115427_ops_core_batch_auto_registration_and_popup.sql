
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
  v_documents integer := 0;
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
        nullif(c.suggested_data #>> '{job_order,pm}',''),
        nullif(c.suggested_data #>> '{drawing,pm}','')
      ),
      coalesce(
        nullif(c.suggested_data #>> '{wip,customer_po}',''),
        nullif(c.suggested_data #>> '{job_order,po_numbers}',''),
        nullif(c.suggested_data #>> '{drawing,po_number}','')
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

  with drawing_rows as (
    select
      d.source_row_id,
      d.source_version,
      d.synced_at,
      ops_core.clean_drawing_identity(d.drawing_number) drawing_number,
      nullif(btrim(d.document_title),'') document_title,
      coalesce(
        ops_core.clean_drawing_identity(d.drawing_number),
        nullif(btrim(d.document_title),''),
        'DRAWING-'||d.source_row_id::text
      ) effective_code,
      coalesce(nullif(btrim(d.current_revision),''),'UNSPECIFIED') current_revision,
      nullif(d.current_status,'') current_status,
      d.raw_cells,
      upper(coalesce(d.raw_cells->>'UNIT','')) unit,
      public.tracking_parse_number(d.raw_cells->>'QUANTITY') raw_quantity,
      t.requires_3d_scan,
      t.requires_assembly_simulation
    from ops_panel.drawings_current d
    left join ops_panel.drawing_technical_profile t on t.source_row_id=d.source_row_id
    where ops_core.normalize_project_core(d.project_key)=v_core
  ),
  item_source as (
    select distinct on (item_key)
      source_row_id,
      source_version,
      effective_code,
      drawing_number,
      document_title,
      current_revision,
      raw_cells,
      unit,
      raw_quantity,
      requires_3d_scan,
      requires_assembly_simulation,
      item_key
    from (
      select
        r.*,
        coalesce(
          ops_core.normalize_item_key(r.effective_code),
          'DRAWING'||r.source_row_id::text
        ) item_key
      from drawing_rows r
      where
        r.unit like '%SPOOL%'
        or r.unit like '%SUPPORT%'
        or r.unit like '%STR%'
        or r.unit like '%KG%'
        or upper(r.effective_code) like '%-ISO-%'
        or upper(r.effective_code) like '%-SUP-%'
        or upper(r.effective_code) like '%-STR-%'
    ) x
    order by item_key,source_version desc nulls last,source_row_id desc
  )
  insert into ops_core.items(
    project_id,item_key,item_type,iso_code,drawing_code,description,
    weight_kg,quantity,requires_3d,requires_assembly_simulation,
    current_stage_key,current_status,overall_progress,source_metadata
  )
  select
    p.id,
    s.item_key,
    ops_core.infer_item_type(s.unit,s.effective_code,s.document_title),
    case
      when s.unit like '%SPOOL%' or upper(s.effective_code) like '%-ISO-%'
      then s.effective_code
      else null
    end,
    s.effective_code,
    s.document_title,
    case when s.unit like '%KG%' then s.raw_quantity else null end,
    case when s.unit like '%KG%' then 1 else coalesce(s.raw_quantity,1) end,
    s.requires_3d_scan,
    s.requires_assembly_simulation,
    'drawing',
    'validation_required',
    0,
    jsonb_build_object(
      'candidate_materialized',true,
      'drawing_source_row_id',s.source_row_id,
      'drawing_revision',s.current_revision,
      'provisional_breakdown',
        case
          when s.unit like '%KG%' then false
          else coalesce(s.raw_quantity,1)>1
        end
    )
  from item_source s
  on conflict(project_id,item_key) do update
  set
    item_type=excluded.item_type,
    iso_code=coalesce(excluded.iso_code,ops_core.items.iso_code),
    drawing_code=coalesce(excluded.drawing_code,ops_core.items.drawing_code),
    description=coalesce(excluded.description,ops_core.items.description),
    weight_kg=coalesce(excluded.weight_kg,ops_core.items.weight_kg),
    quantity=coalesce(excluded.quantity,ops_core.items.quantity),
    requires_3d=coalesce(excluded.requires_3d,ops_core.items.requires_3d),
    requires_assembly_simulation=coalesce(excluded.requires_assembly_simulation,ops_core.items.requires_assembly_simulation),
    source_metadata=ops_core.items.source_metadata||excluded.source_metadata,
    updated_at=now();

  get diagnostics v_items=row_count;

  perform ops_core.ensure_item_stages(i.id)
  from ops_core.items i
  where i.project_id=p.id and not i.removed_from_scope;

  with drawing_rows as (
    select distinct on (document_key)
      d.source_row_id,
      d.source_version,
      coalesce(
        ops_core.clean_drawing_identity(d.drawing_number),
        nullif(btrim(d.document_title),''),
        'DRAWING-'||d.source_row_id::text
      ) effective_code,
      ops_core.clean_drawing_identity(d.drawing_number) drawing_number,
      nullif(btrim(d.document_title),'') document_title,
      coalesce(nullif(btrim(d.current_revision),''),'UNSPECIFIED') current_revision,
      nullif(d.current_status,'') current_status,
      d.raw_cells,
      upper(coalesce(d.raw_cells->>'UNIT','')) unit,
      public.tracking_parse_number(d.raw_cells->>'QUANTITY') raw_quantity,
      t.requires_3d_scan,
      t.requires_assembly_simulation,
      coalesce(
        ops_core.normalize_alias(ops_core.clean_drawing_identity(d.drawing_number)),
        ops_core.normalize_alias(nullif(btrim(d.document_title),'')),
        d.source_row_id::text
      ) document_key
    from ops_panel.drawings_current d
    left join ops_panel.drawing_technical_profile t on t.source_row_id=d.source_row_id
    where ops_core.normalize_project_core(d.project_key)=v_core
    order by document_key,d.source_version desc nulls last,d.source_row_id desc
  )
  insert into ops_core.documents(
    project_id,document_key,document_type,document_number,title,current_revision,current_status,
    requires_3d,requires_assembly_simulation,source_system,source_row_id,source_version,metadata
  )
  select
    p.id,
    r.document_key,
    case
      when upper(coalesce(r.effective_code,r.document_title,'')) like '%FCB%' then 'FCB'
      when r.unit like '%SPOOL%' then 'ISO'
      else 'DRAWING'
    end,
    r.effective_code,
    r.document_title,
    r.current_revision,
    r.current_status,
    r.requires_3d_scan,
    r.requires_assembly_simulation,
    'drawing',
    r.source_row_id,
    r.source_version,
    jsonb_build_object('raw_cells',coalesce(r.raw_cells,'{}'::jsonb),'quantity',r.raw_quantity)
  from drawing_rows r
  on conflict(project_id,document_key) do update
  set
    document_type=excluded.document_type,
    document_number=excluded.document_number,
    title=excluded.title,
    current_revision=excluded.current_revision,
    current_status=excluded.current_status,
    requires_3d=excluded.requires_3d,
    requires_assembly_simulation=excluded.requires_assembly_simulation,
    source_row_id=excluded.source_row_id,
    source_version=excluded.source_version,
    metadata=excluded.metadata,
    updated_at=now();

  get diagnostics v_documents=row_count;

  update ops_core.document_revisions dr
  set is_current=false,
      status=case when dr.status='current' then 'superseded' else dr.status end
  from ops_core.documents d
  where dr.document_id=d.id
    and d.project_id=p.id
    and dr.is_current=true;

  with drawing_rows as (
    select distinct on (document_key)
      d.source_row_id,
      d.source_version,
      coalesce(nullif(btrim(d.current_revision),''),'UNSPECIFIED') current_revision,
      d.raw_cells,
      coalesce(
        ops_core.normalize_alias(ops_core.clean_drawing_identity(d.drawing_number)),
        ops_core.normalize_alias(nullif(btrim(d.document_title),'')),
        d.source_row_id::text
      ) document_key
    from ops_panel.drawings_current d
    where ops_core.normalize_project_core(d.project_key)=v_core
    order by document_key,d.source_version desc nulls last,d.source_row_id desc
  )
  insert into ops_core.document_revisions(
    document_id,revision,source_version,is_current,status,changed_fields,source_payload,detected_at
  )
  select
    d.id,
    r.current_revision,
    r.source_version,
    true,
    'current',
    '{}'::jsonb,
    jsonb_build_object(
      'cells',coalesce(r.raw_cells,'{}'::jsonb),
      'derived',jsonb_build_object('project_key',v_core,'current_revision',r.current_revision)
    ),
    now()
  from drawing_rows r
  join ops_core.documents d
    on d.project_id=p.id and d.document_key=r.document_key
  on conflict(document_id,revision,source_version) do update
  set is_current=true,status='current',source_payload=excluded.source_payload,detected_at=now();

  insert into ops_core.document_item_links(document_id,item_id,link_type)
  select distinct
    d.id,
    i.id,
    'drawing'
  from ops_core.documents d
  join ops_core.items i on i.project_id=d.project_id and not i.removed_from_scope
  where d.project_id=p.id
    and ops_core.normalize_document_item_key(coalesce(i.drawing_code,i.iso_code,i.item_key),p.project_core)
      =ops_core.normalize_document_item_key(coalesce(d.document_number,d.title,d.document_key),p.project_core)
  on conflict do nothing;

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
    jsonb_build_object(
      'project_core',p.project_core,
      'items',v_items,
      'documents',v_documents,
      'source_mode',p.source_mode,
      'mode','batch'
    )
  );

  return jsonb_build_object(
    'ok',true,
    'created',v_created,
    'project_id',p.id,
    'project_core',p.project_core,
    'display_code',p.display_code,
    'source_mode',p.source_mode,
    'items',v_items,
    'documents',v_documents
  );
end $$;

create or replace function ops_core.register_candidate_automatically(
  p_project_core text,
  p_actor text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,public
as $$
declare
  v_materialized jsonb;
  v_report jsonb;
  v_cutover jsonb;
  v_ready boolean:=false;
begin
  v_materialized:=ops_core.materialize_candidate(p_project_core,p_actor);
  v_report:=ops_core.project_validation_report(p_project_core);
  v_ready:=coalesce((v_report->>'ready_for_cutover')::boolean,false);

  if v_ready then
    v_cutover:=ops_core.project_cutover(p_project_core,p_actor);
    return jsonb_build_object(
      'ok',true,
      'registered',true,
      'activated',true,
      'materialized',v_materialized,
      'report',v_report,
      'cutover',v_cutover
    );
  end if;

  update ops_core.registration_candidates
  set candidate_status='reconciled',last_seen_at=now()
  where region='BR' and project_core=ops_core.normalize_project_core(p_project_core);

  return jsonb_build_object(
    'ok',true,
    'registered',true,
    'activated',false,
    'pending_detail',true,
    'materialized',v_materialized,
    'report',v_report
  );
end $$;

create or replace function public.ops_core_register_candidate_auto(p_project_key text,p_actor text)
returns jsonb
language sql
security definer
set search_path=public,ops_core
as $$
  select ops_core.register_candidate_automatically(p_project_key,p_actor);
$$;

create or replace function public.ops_core_new_bsp_alerts(p_limit integer default 10)
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core
as $$
select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc),'[]'::jsonb)
from (
  select
    n.id,
    n.notification_type,
    n.title,
    n.message,
    n.severity,
    n.created_at,
    n.read_at,
    regexp_replace(n.dedup_key,'^new-drawing-bsp:','') project_core,
    coalesce(c.display_code,regexp_replace(n.dedup_key,'^new-drawing-bsp:','')) display_code,
    c.source_systems,
    c.suggested_data
  from ops_core.notifications n
  left join ops_core.registration_candidates c
    on c.region='BR'
   and c.project_core=regexp_replace(n.dedup_key,'^new-drawing-bsp:','')
  where n.notification_type='registration.new_bsp_from_drawing'
    and n.read_at is null
    and n.resolved_at is null
  order by n.created_at desc
  limit greatest(1,least(coalesce(p_limit,10),50))
) q;
$$;

grant execute on function ops_core.materialize_candidate(text,text) to service_role;
grant execute on function ops_core.register_candidate_automatically(text,text) to service_role;
grant execute on function public.ops_core_register_candidate_auto(text,text) to service_role;
grant execute on function public.ops_core_new_bsp_alerts(integer) to service_role;
