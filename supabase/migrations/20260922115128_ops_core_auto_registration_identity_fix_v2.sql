CREATE OR REPLACE FUNCTION ops_core.sync_drawing_source_row_unprotected(p_source_row_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops_core', 'ops_panel', 'public'
AS $function$
declare
  r ops_panel.source_rows%rowtype;
  p ops_core.projects%rowtype;
  d_old ops_core.documents%rowtype;
  d_new ops_core.documents%rowtype;
  v_project_raw text;
  v_core text;
  v_number text;
  v_title text;
  v_key text;
  v_revision text;
  v_status text;
  v_3d boolean;
  v_sim boolean;
  v_quantity numeric;
  v_changed jsonb := '{}'::jsonb;
  v_same_revision boolean := false;
  v_linked integer := 0;
begin
  select * into r
  from ops_panel.source_rows
  where source_key='drawing' and source_row_id=p_source_row_id and active=true
  order by source_version desc
  limit 1;

  if not found then return jsonb_build_object('ok',false,'reason','drawing-row-not-found'); end if;

  v_project_raw:=coalesce(nullif(r.payload #>> '{derived,project_key}',''),nullif(r.payload->'cells'->>'Project Number',''),nullif(r.payload->'cells'->>'Task Name (BSP, GASP, ICSP,SP)',''));
  v_core:=ops_core.normalize_project_core(v_project_raw);
  if v_core is null then return jsonb_build_object('ok',false,'reason','project-not-detected'); end if;

  select * into p from ops_core.projects where region='BR' and project_core=v_core limit 1;
  if not found then
    insert into ops_core.registration_candidates(region,project_core,display_code,candidate_status,source_systems,suggested_data,last_seen_at)
    values('BR',v_core,coalesce(v_project_raw,v_core),'validation_required',array['drawing'],
      jsonb_build_object('drawing',jsonb_build_object('source_row_id',r.source_row_id,'payload',r.payload)),now())
    on conflict(region,project_core) do update
    set last_seen_at=now(),
        source_systems=(select array_agg(distinct x) from unnest(ops_core.registration_candidates.source_systems||array['drawing']) x);
    return jsonb_build_object('ok',true,'candidate_only',true,'project_core',v_core);
  end if;

  v_number:=ops_core.clean_drawing_identity(coalesce(nullif(r.payload #>> '{derived,drawing_number}',''),nullif(r.payload->'cells'->>'Drawing Number (Rev. A)','')));
  v_title:=coalesce(nullif(r.payload #>> '{derived,document_title}',''),nullif(r.payload->'cells'->>'Doc. Ref.Client / Title',''));
  v_key:=coalesce(ops_core.normalize_alias(v_number),ops_core.normalize_alias(v_title),r.source_row_id::text);
  v_revision:=coalesce(nullif(btrim(r.payload #>> '{derived,current_revision}'),''),'UNSPECIFIED');
  v_status:=coalesce(nullif(r.payload #>> '{derived,current_status}',''),nullif(r.payload->'cells'->>'Current Drawing Status',''));
  v_3d:=ops_core.parse_yes_no(r.payload->'cells'->>'3D Scan    (yes/no)');
  v_sim:=ops_core.parse_yes_no(r.payload->'cells'->>'Necessita Simulação de Montagem');
  v_quantity:=public.tracking_parse_number(r.payload->'cells'->>'QUANTITY');

  select * into d_old from ops_core.documents
  where project_id=p.id and document_key=v_key
  limit 1;

  if found then
    if d_old.current_revision is distinct from v_revision then
      v_changed:=v_changed||jsonb_build_object('revision',jsonb_build_object('from',d_old.current_revision,'to',v_revision));
    end if;
    if d_old.current_status is distinct from v_status then
      v_changed:=v_changed||jsonb_build_object('status',jsonb_build_object('from',d_old.current_status,'to',v_status));
    end if;
    if d_old.requires_3d is distinct from v_3d then
      v_changed:=v_changed||jsonb_build_object('requires_3d',jsonb_build_object('from',d_old.requires_3d,'to',v_3d));
    end if;
    if d_old.requires_assembly_simulation is distinct from v_sim then
      v_changed:=v_changed||jsonb_build_object('requires_assembly_simulation',jsonb_build_object('from',d_old.requires_assembly_simulation,'to',v_sim));
    end if;
    v_same_revision:=d_old.current_revision is not distinct from v_revision;
  end if;

  insert into ops_core.documents(
    project_id,document_key,document_type,document_number,title,current_revision,current_status,
    requires_3d,requires_assembly_simulation,source_system,source_row_id,source_version,metadata
  )
  values(
    p.id,v_key,
    case when upper(coalesce(v_number,v_title,'')) like '%FCB%' then 'FCB'
         when upper(coalesce(r.payload->'cells'->>'UNIT','')) like '%SPOOL%' then 'ISO'
         else 'DRAWING' end,
    v_number,v_title,v_revision,v_status,v_3d,v_sim,'drawing',r.source_row_id,r.source_version,
    jsonb_build_object('raw_cells',coalesce(r.payload->'cells','{}'::jsonb),'quantity',v_quantity)
  )
  on conflict(project_id,document_key) do update
  set document_number=excluded.document_number,title=excluded.title,current_revision=excluded.current_revision,
      current_status=excluded.current_status,requires_3d=excluded.requires_3d,
      requires_assembly_simulation=excluded.requires_assembly_simulation,source_row_id=excluded.source_row_id,
      source_version=excluded.source_version,metadata=excluded.metadata,updated_at=now()
  returning * into d_new;

  update ops_core.document_revisions
  set is_current=false,status='superseded'
  where document_id=d_new.id and is_current=true
    and (revision is distinct from v_revision or source_version is distinct from r.source_version);

  insert into ops_core.document_revisions(
    document_id,revision,source_version,is_current,status,changed_fields,source_payload,detected_at
  )
  values(
    d_new.id,v_revision,r.source_version,true,
    case when v_same_revision and d_old.id is not null and d_old.source_version is distinct from r.source_version
         then 'same_revision_changed' else 'current' end,
    v_changed,r.payload,now()
  )
  on conflict(document_id,revision,source_version) do update
  set is_current=true,status=excluded.status,changed_fields=excluded.changed_fields,
      source_payload=excluded.source_payload,detected_at=now();

  with candidates as (
    select i.id
    from ops_core.items i
    where i.project_id=p.id and i.removed_from_scope=false
      and ops_core.normalize_document_item_key(coalesce(i.drawing_code,i.iso_code,i.item_key),p.project_core)
          =ops_core.normalize_document_item_key(coalesce(v_number,v_title),p.project_core)
  ),
  links as (
    insert into ops_core.document_item_links(document_id,item_id,link_type)
    select d_new.id,id,'drawing' from candidates
    on conflict do nothing
    returning item_id
  )
  select count(*) into v_linked from links;

  update ops_core.items i
  set requires_3d=coalesce(v_3d,i.requires_3d),
      requires_assembly_simulation=coalesce(v_sim,i.requires_assembly_simulation),
      quantity=coalesce(v_quantity,i.quantity),
      drawing_code=coalesce(i.drawing_code,v_number),
      source_metadata=i.source_metadata||jsonb_build_object(
        'drawing_source_row_id',r.source_row_id,'drawing_source_version',r.source_version,'drawing_revision',v_revision
      ),
      updated_at=now()
  where i.id in (
    select item_id from ops_core.document_item_links where document_id=d_new.id
  );

  update ops_core.item_stages s
  set is_applicable=case
      when s.stage_key in ('scan-initial','scan-final') then coalesce(i.requires_3d,s.is_applicable)
      when s.stage_key='assembly-simulation' then coalesce(i.requires_assembly_simulation,false)
      else s.is_applicable end,
      updated_at=now()
  from ops_core.items i
  where s.item_id=i.id and i.id in (
    select item_id from ops_core.document_item_links where document_id=d_new.id
  );

  if v_changed<>'{}'::jsonb then
    insert into ops_core.audit_events(
      project_id,document_id,entity_type,entity_id,action,source_system,before_data,after_data,metadata
    )
    values(
      p.id,d_new.id,'document',d_new.id::text,
      case when d_old.current_revision is distinct from v_revision then 'document.revision_changed' else 'document.technical_update' end,
      'drawing',
      case when d_old.id is null then null else to_jsonb(d_old) end,
      to_jsonb(d_new),
      jsonb_build_object('changed_fields',v_changed,'linked_items',v_linked)
    );
  end if;

  return jsonb_build_object('ok',true,'project_id',p.id,'document_id',d_new.id,'revision',v_revision,'linked_items',v_linked,'changed_fields',v_changed);
end $function$
;

CREATE OR REPLACE FUNCTION ops_core.sync_drawing_source_row(p_source_row_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops_core', 'ops_panel', 'public'
AS $function$
declare
  r ops_panel.source_rows%rowtype;
  p ops_core.projects%rowtype;
  d ops_core.documents%rowtype;
  rev ops_core.document_revisions%rowtype;
  v_project_raw text;
  v_core text;
  v_number text;
  v_title text;
  v_key text;
  v_incoming_revision text;
  v_current_revision text;
  v_incoming_rank bigint;
  v_current_rank bigint;
  v_result jsonb;
begin
  select * into r
  from ops_panel.source_rows
  where source_key='drawing' and source_row_id=p_source_row_id and active=true
  order by source_version desc
  limit 1;
  if not found then return jsonb_build_object('ok',false,'reason','drawing-row-not-found'); end if;

  v_project_raw:=coalesce(
    nullif(r.payload #>> '{derived,project_key}',''),
    nullif(r.payload->'cells'->>'Project Number',''),
    nullif(r.payload->'cells'->>'Task Name (BSP, GASP, ICSP,SP)','')
  );
  v_core:=ops_core.normalize_project_core(v_project_raw);

  select * into p from ops_core.projects
  where region='BR' and project_core=v_core
  limit 1;

  if not found then
    return ops_core.sync_drawing_source_row_unprotected(p_source_row_id);
  end if;

  v_number:=ops_core.clean_drawing_identity(coalesce(
    nullif(r.payload #>> '{derived,drawing_number}',''),
    nullif(r.payload->'cells'->>'Drawing Number (Rev. A)','')
  ));
  v_title:=coalesce(
    nullif(r.payload #>> '{derived,document_title}',''),
    nullif(r.payload->'cells'->>'Doc. Ref.Client / Title','')
  );
  v_key:=coalesce(ops_core.normalize_alias(v_number),ops_core.normalize_alias(v_title),r.source_row_id::text);
  v_incoming_revision:=coalesce(nullif(btrim(r.payload #>> '{derived,current_revision}'),''),'UNSPECIFIED');

  select * into d
  from ops_core.documents
  where project_id=p.id and document_key=v_key
  limit 1;

  if d.id is not null and d.current_revision is not null then
    v_current_revision:=d.current_revision;
    v_incoming_rank:=ops_core.revision_rank(v_incoming_revision);
    v_current_rank:=ops_core.revision_rank(v_current_revision);

    if v_incoming_revision is distinct from v_current_revision
       and v_incoming_rank < v_current_rank then
      insert into ops_core.document_revisions(
        document_id,revision,source_version,is_current,status,changed_fields,source_payload,detected_at
      )
      values(
        d.id,v_incoming_revision,r.source_version,false,'lower_revision',
        jsonb_build_object(
          'revision',jsonb_build_object('from',v_current_revision,'received',v_incoming_revision),
          'decision','ignored_downgrade'
        ),
        r.payload,now()
      )
      on conflict(document_id,revision,source_version) do update
      set is_current=false,status='lower_revision',source_payload=excluded.source_payload,detected_at=now()
      returning * into rev;

      insert into ops_core.document_revision_reviews(
        revision_id,review_status,reviewed_by,reviewed_at,note,diff_snapshot
      )
      values(
        rev.id,'auto_accepted','system',now(),
        'Revisão inferior armazenada como histórico e impedida de substituir a revisão vigente.',
        jsonb_build_object('current_revision',v_current_revision,'received_revision',v_incoming_revision)
      )
      on conflict(revision_id) do nothing;

      insert into ops_core.audit_events(
        project_id,document_id,entity_type,entity_id,action,source_system,before_data,after_data,metadata
      )
      values(
        p.id,d.id,'document',d.id::text,'document.lower_revision_ignored','drawing',
        jsonb_build_object('current_revision',v_current_revision),
        jsonb_build_object('received_revision',v_incoming_revision,'source_version',r.source_version),
        jsonb_build_object('source_row_id',p_source_row_id)
      );

      return jsonb_build_object(
        'ok',true,'ignored_downgrade',true,'document_id',d.id,
        'current_revision',v_current_revision,'received_revision',v_incoming_revision
      );
    end if;
  end if;

  v_result:=ops_core.sync_drawing_source_row_unprotected(p_source_row_id);

  select * into d
  from ops_core.documents
  where project_id=p.id and document_key=v_key
  limit 1;

  if d.id is not null then
    select * into rev
    from ops_core.document_revisions
    where document_id=d.id and is_current
    order by detected_at desc
    limit 1;

    if rev.id is not null then
      insert into ops_core.document_revision_reviews(
        revision_id,review_status,reviewed_by,reviewed_at,note,diff_snapshot
      )
      values(
        rev.id,
        case when rev.status='same_revision_changed' then 'pending' else 'auto_accepted' end,
        case when rev.status='same_revision_changed' then null else 'system' end,
        case when rev.status='same_revision_changed' then null else now() end,
        case when rev.status='same_revision_changed'
          then 'Conteúdo alterado mantendo a mesma revisão. Requer conferência.'
          else 'Revisão atualizada automaticamente pela fonte documental.' end,
        coalesce(rev.changed_fields,'{}'::jsonb)
      )
      on conflict(revision_id) do update
      set diff_snapshot=excluded.diff_snapshot,
          review_status=case
            when ops_core.document_revision_reviews.review_status='approved' then 'approved'
            else excluded.review_status end,
          note=excluded.note;

      perform ops_core.record_field_source('document',d.id,'current_revision',to_jsonb(d.current_revision),
        'drawing',p_source_row_id::text,'current_revision',d.id,rev.id,1,'{}'::jsonb);
      perform ops_core.record_field_source('document',d.id,'requires_3d',to_jsonb(d.requires_3d),
        'drawing',p_source_row_id::text,'3D Scan (yes/no)',d.id,rev.id,1,'{}'::jsonb);
      perform ops_core.record_field_source('document',d.id,'requires_assembly_simulation',to_jsonb(d.requires_assembly_simulation),
        'drawing',p_source_row_id::text,'Necessita Simulação de Montagem',d.id,rev.id,1,'{}'::jsonb);
      perform ops_core.record_field_source('document',d.id,'quantity',d.metadata->'quantity',
        'drawing',p_source_row_id::text,'QUANTITY',d.id,rev.id,1,'{}'::jsonb);
    end if;
  end if;

  return v_result;
end $function$
;

CREATE OR REPLACE FUNCTION ops_core.materialize_candidate(p_project_core text, p_actor text DEFAULT 'system'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops_core', 'ops_panel', 'public'
AS $function$
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
      ops_core.clean_drawing_identity(d.drawing_number) drawing_number,
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
      case
        when upper(coalesce(r.raw_cells->>'UNIT','')) like '%SPOOL%'
          or upper(coalesce(r.drawing_number,r.document_title,'')) like '%-ISO-%'
        then coalesce(r.drawing_number,r.document_title)
        else null
      end,
      coalesce(r.drawing_number,r.document_title),
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
end $function$
;