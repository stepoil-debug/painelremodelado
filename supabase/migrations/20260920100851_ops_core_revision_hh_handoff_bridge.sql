
create or replace function ops_core.normalize_document_item_key(value text, project_core text)
returns text
language plpgsql
immutable
as $$
declare
  v text := ops_core.normalize_alias(value);
  c text := ops_core.normalize_alias(project_core);
begin
  if v is null then return null; end if;
  v := regexp_replace(v,'^(BSP|BEP|BPP|B3D|SP)','');
  if c is not null and left(v,length(c))=c then v:=substr(v,length(c)+1); end if;
  return nullif(v,'');
end $$;

create or replace function ops_core.parse_yes_no(value text)
returns boolean
language sql
immutable
as $$
  select case
    when lower(btrim(coalesce(value,''))) in ('sim','yes','y','true','1','x') then true
    when lower(btrim(coalesce(value,''))) in ('não','nao','no','n','false','0') then false
    else null
  end;
$$;

create or replace function ops_core.sync_drawing_source_row(p_source_row_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,ops_panel,public
as $$
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

  v_number:=coalesce(nullif(r.payload #>> '{derived,drawing_number}',''),nullif(r.payload->'cells'->>'Drawing Number (Rev. A)',''));
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
end $$;

create or replace function ops_core.trg_sync_drawing_source_row()
returns trigger
language plpgsql
security definer
set search_path=ops_core,ops_panel,public
as $$
begin
  if new.source_key='drawing' and new.active=true
     and (tg_op='INSERT' or old.row_hash is distinct from new.row_hash or old.source_version is distinct from new.source_version)
  then
    perform ops_core.sync_drawing_source_row(new.source_row_id);
  end if;
  return new;
end $$;

drop trigger if exists trg_ops_core_sync_drawing on ops_panel.source_rows;
create trigger trg_ops_core_sync_drawing
after insert or update of payload,row_hash,source_version,active on ops_panel.source_rows
for each row execute function ops_core.trg_sync_drawing_source_row();

create or replace function ops_core.sync_existing_drawings()
returns jsonb
language plpgsql
security definer
set search_path=ops_core,ops_panel,public
as $$
declare r record; v_ok integer:=0; v_err integer:=0;
begin
  for r in
    select distinct source_row_id
    from ops_panel.source_rows sr
    where sr.source_key='drawing' and sr.active=true
      and exists(
        select 1 from ops_core.projects p
        where p.project_core=ops_core.normalize_project_core(sr.payload #>> '{derived,project_key}')
      )
  loop
    begin
      perform ops_core.sync_drawing_source_row(r.source_row_id);
      v_ok:=v_ok+1;
    exception when others then
      v_err:=v_err+1;
    end;
  end loop;
  return jsonb_build_object('ok',true,'synced',v_ok,'errors',v_err,'finished_at',now());
end $$;

create or replace function ops_core.stage_key_for_hh(p_activity_key text)
returns text
language sql
stable
set search_path=ops_core,public
as $$
  select stage_key
  from ops_core.workflow_stages
  where active=true and lower(coalesce(p_activity_key,''))=any(
    select lower(x) from unnest(hh_activity_keys) x
  )
  order by stage_order
  limit 1;
$$;

create or replace function ops_core.advance_item_after_stage(
  p_item_id uuid,
  p_stage_key text,
  p_source_event_id uuid default null,
  p_actor text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,public
as $$
declare
  i ops_core.items%rowtype;
  p ops_core.projects%rowtype;
  cur ops_core.item_stages%rowtype;
  nxt record;
  v_handoff_id uuid;
  v_dedup text;
begin
  select * into i from ops_core.items where id=p_item_id for update;
  if not found then return jsonb_build_object('ok',false,'reason','item-not-found'); end if;
  select * into p from ops_core.projects where id=i.project_id;
  if p.source_mode<>'ops_core' then return jsonb_build_object('ok',false,'reason','legacy-project'); end if;

  select * into cur from ops_core.item_stages where item_id=i.id and stage_key=p_stage_key;
  if not found then return jsonb_build_object('ok',false,'reason','stage-not-found'); end if;

  select s.stage_key,s.stage_order,w.name,w.sector_key,w.default_sla_minutes
  into nxt
  from ops_core.item_stages s
  join ops_core.workflow_stages w on w.stage_key=s.stage_key
  where s.item_id=i.id and s.is_applicable=true and s.stage_order>cur.stage_order and s.status<>'completed'
  order by s.stage_order
  limit 1;

  if not found then
    update ops_core.items
    set current_stage_key='completed',current_status='completed',overall_progress=100,updated_at=now()
    where id=i.id;
    return jsonb_build_object('ok',true,'completed',true);
  end if;

  update ops_core.item_stages
  set status=case when status='pending' then 'available' else status end,
      entered_at=coalesce(entered_at,now()),updated_at=now()
  where item_id=i.id and stage_key=nxt.stage_key;

  update ops_core.items
  set current_stage_key=nxt.stage_key,current_status='available',updated_at=now()
  where id=i.id;

  v_dedup:=concat('handoff:',i.id,':',p_stage_key,':',nxt.stage_key);

  insert into ops_core.handoffs(
    project_id,item_id,from_stage_key,from_sector_key,to_stage_key,to_sector_key,
    status,dedup_key,available_at,source_event_id,metadata
  )
  values(
    p.id,i.id,p_stage_key,
    (select sector_key from ops_core.workflow_stages where stage_key=p_stage_key),
    nxt.stage_key,nxt.sector_key,'available',v_dedup,now(),p_source_event_id,
    jsonb_build_object('actor',p_actor)
  )
  on conflict(dedup_key) do update set
    status=case when ops_core.handoffs.status='cancelled' then 'available' else ops_core.handoffs.status end
  returning id into v_handoff_id;

  insert into ops_core.notifications(
    project_id,item_id,handoff_id,sector_key,notification_type,title,message,severity,dedup_key
  )
  values(
    p.id,i.id,v_handoff_id,nxt.sector_key,'handoff.created',
    'Nova demanda disponível',
    concat(p.display_code,' / ',coalesce(i.iso_code,i.drawing_code,i.item_key),' disponível para ',nxt.name,'.'),
    'info',concat('notification:',v_dedup)
  )
  on conflict(dedup_key) do nothing;

  return jsonb_build_object('ok',true,'completed',false,'next_stage',nxt.stage_key,'next_sector',nxt.sector_key,'handoff_id',v_handoff_id);
end $$;

create or replace function ops_core.sync_hh_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,public
as $$
declare
  h public.hh_sessions%rowtype;
  p ops_core.projects%rowtype;
  i ops_core.items%rowtype;
  s ops_core.item_stages%rowtype;
  v_core text;
  v_item_norm text;
  v_stage text;
  v_progress numeric;
  v_completed boolean;
  v_event_id uuid;
  v_source_event text;
begin
  select * into h from public.hh_sessions where id=p_session_id;
  if not found then return jsonb_build_object('ok',false,'reason','session-not-found'); end if;

  v_core:=ops_core.normalize_project_core(coalesce(nullif(h.project_key,''),nullif(h.bsp_number,'')));
  select * into p from ops_core.projects where region='BR' and project_core=v_core and source_mode='ops_core' limit 1;
  if not found then return jsonb_build_object('ok',false,'reason','project-not-cutover'); end if;

  v_item_norm:=ops_core.normalize_document_item_key(h.iso,p.project_core);
  select * into i
  from ops_core.items
  where project_id=p.id and removed_from_scope=false
    and (
      ops_core.normalize_document_item_key(coalesce(drawing_code,iso_code,item_key),p.project_core)=v_item_norm
      or ops_core.normalize_item_key(iso_code)=ops_core.normalize_item_key(h.iso)
      or item_key=ops_core.normalize_item_key(h.iso)
    )
  order by case when ops_core.normalize_item_key(iso_code)=ops_core.normalize_item_key(h.iso) then 0 else 1 end
  limit 1;

  if not found then return jsonb_build_object('ok',false,'reason','item-not-found','project_id',p.id); end if;

  v_stage:=ops_core.stage_key_for_hh(h.activity_key);
  if v_stage is null then return jsonb_build_object('ok',false,'reason','activity-not-mapped','activity_key',h.activity_key); end if;

  perform ops_core.ensure_item_stages(i.id);
  select * into s from ops_core.item_stages where item_id=i.id and stage_key=v_stage for update;
  if not found or not s.is_applicable then return jsonb_build_object('ok',false,'reason','stage-not-applicable','stage_key',v_stage); end if;

  v_progress:=greatest(0,least(100,coalesce(h.progress_percent,case when h.status in ('finished','forced_closed') then 100 else 0 end)));
  v_completed:=v_progress>=100 or h.status in ('finished','forced_closed');
  v_source_event:=concat(h.id,':',v_stage,':',v_progress,':',coalesce(h.progress_status,''),':',coalesce(h.status,''));

  insert into ops_core.stage_events(
    project_id,item_id,item_stage_id,event_type,stage_key,sector_key,
    progress_from,progress_to,actor_email,actor_name,source_system,source_event_id,payload
  )
  values(
    p.id,i.id,s.id,
    case when v_completed then 'stage.completed' else 'stage.progress_changed' end,
    v_stage,(select sector_key from ops_core.workflow_stages where stage_key=v_stage),
    s.progress,v_progress,h.progress_updated_by,h.progress_updated_by_name,'hh',v_source_event,to_jsonb(h)
  )
  on conflict(source_system,source_event_id) do update
    set payload=excluded.payload
  returning id into v_event_id;

  update ops_core.item_stages
  set progress=v_progress,
      status=case when v_completed then 'completed'
                  when v_progress>0 then 'in_progress'
                  else status end,
      started_at=coalesce(started_at,h.start_at),
      completed_at=case when v_completed then coalesce(h.end_at,now()) else completed_at end,
      actual_date=case when v_completed then coalesce(h.end_at,now())::date else actual_date end,
      source_system='hh',source_ref=h.id::text,
      updated_by=coalesce(h.progress_updated_by_name,h.finished_by_name,h.created_by_name),
      updated_at=now(),
      metadata=metadata||jsonb_build_object('hh_session_id',h.id,'total_hh',h.total_hh,'workers',h.total_workers,'finish_status',h.finish_status)
  where id=s.id;

  update ops_core.items
  set current_stage_key=v_stage,
      current_status=case when v_completed then 'completed_stage' else 'in_progress' end,
      updated_at=now()
  where id=i.id;

  perform ops_core.recompute_item_progress(i.id);

  if v_completed then
    perform ops_core.advance_item_after_stage(i.id,v_stage,v_event_id,coalesce(h.finished_by_name,h.progress_updated_by_name,'HH'));
  end if;

  return jsonb_build_object('ok',true,'project_id',p.id,'item_id',i.id,'stage_key',v_stage,'progress',v_progress,'completed',v_completed);
end $$;

create or replace function ops_core.trg_sync_hh_session()
returns trigger
language plpgsql
security definer
set search_path=ops_core,public
as $$
begin
  perform ops_core.sync_hh_session(new.id);
  return new;
exception when others then
  insert into ops_core.audit_events(entity_type,entity_id,action,source_system,metadata)
  values('hh_session',new.id::text,'hh.sync_error','hh',jsonb_build_object('error',sqlerrm));
  return new;
end $$;

drop trigger if exists trg_ops_core_hh_session on public.hh_sessions;
create trigger trg_ops_core_hh_session
after insert or update of progress_percent,progress_status,status,end_at,activity_key on public.hh_sessions
for each row execute function ops_core.trg_sync_hh_session();

create or replace function ops_core.sync_manual_stage_update(p_update_id text)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,public
as $$
declare
  u public.stage_updates%rowtype;
  p ops_core.projects%rowtype;
  i ops_core.items%rowtype;
  s record;
  v_sector text;
  v_progress numeric;
  v_event_id uuid;
begin
  select * into u from public.stage_updates where id=p_update_id;
  if not found then return jsonb_build_object('ok',false,'reason','update-not-found'); end if;

  select * into p from ops_core.projects
  where region=upper(coalesce(nullif(u.region,''),'BR'))
    and project_core=ops_core.normalize_project_core(u.project_number)
    and source_mode='ops_core'
  limit 1;
  if not found then return jsonb_build_object('ok',false,'reason','project-not-cutover'); end if;

  select * into i from ops_core.items
  where project_id=p.id and removed_from_scope=false
    and (ops_core.normalize_item_key(iso_code)=ops_core.normalize_item_key(u.spool_iso)
      or ops_core.normalize_item_key(drawing_code)=ops_core.normalize_item_key(u.spool_iso)
      or item_key=ops_core.normalize_item_key(u.spool_iso))
  limit 1;
  if not found then return jsonb_build_object('ok',false,'reason','item-not-found'); end if;

  v_sector:=lower(unaccent(coalesce(u.sector,'')));
  select st.id,st.stage_key,st.progress
  into s
  from ops_core.item_stages st
  join ops_core.workflow_stages w on w.stage_key=st.stage_key
  where st.item_id=i.id and st.is_applicable=true and st.status<>'completed'
    and (
      lower(unaccent(w.sector_key))=v_sector
      or (v_sector like '%calder%' and w.sector_key='caldeiraria')
      or (v_sector like '%sold%' and w.sector_key='solda')
      or (v_sector like '%qual%' and w.sector_key='qualidade')
      or (v_sector like '%pint%' and w.sector_key='pintura')
      or (v_sector like '%engenh%' and w.sector_key='engenharia')
      or (v_sector like '%supri%' and w.sector_key='suprimentos')
      or (v_sector like '%exped%' and w.sector_key='expedicao')
    )
  order by st.stage_order
  limit 1;

  if not found then return jsonb_build_object('ok',false,'reason','sector-stage-not-found'); end if;

  v_progress:=greatest(0,least(100,coalesce(u.progress,0)));

  insert into ops_core.stage_events(
    project_id,item_id,item_stage_id,event_type,stage_key,sector_key,
    progress_from,progress_to,actor_email,actor_name,source_system,source_event_id,payload
  )
  values(
    p.id,i.id,s.id,case when v_progress>=100 then 'stage.completed' else 'stage.progress_changed' end,
    s.stage_key,u.sector,s.progress,v_progress,u.created_by,u.created_by_name,'stage_updates',u.id,to_jsonb(u)
  )
  on conflict(source_system,source_event_id) do update set payload=excluded.payload
  returning id into v_event_id;

  update ops_core.item_stages
  set progress=v_progress,status=case when v_progress>=100 then 'completed' when v_progress>0 then 'in_progress' else status end,
      actual_date=case when v_progress>=100 then coalesce(u.completion_date,current_date) else actual_date end,
      completed_at=case when v_progress>=100 then coalesce(u.resolved_at,u.updated_at,now()) else completed_at end,
      source_system='stage_updates',source_ref=u.id,updated_by=u.created_by_name,updated_at=now(),
      metadata=metadata||jsonb_build_object('note',u.note,'resolution_note',u.resolution_note)
  where id=s.id;

  perform ops_core.recompute_item_progress(i.id);
  if v_progress>=100 then
    perform ops_core.advance_item_after_stage(i.id,s.stage_key,v_event_id,coalesce(u.created_by_name,'stage_updates'));
  else
    update ops_core.items set current_stage_key=s.stage_key,current_status='in_progress',updated_at=now() where id=i.id;
  end if;

  return jsonb_build_object('ok',true,'project_id',p.id,'item_id',i.id,'stage_key',s.stage_key,'progress',v_progress);
end $$;

create or replace function ops_core.trg_sync_manual_stage_update()
returns trigger
language plpgsql
security definer
set search_path=ops_core,public
as $$
begin
  perform ops_core.sync_manual_stage_update(new.id);
  return new;
exception when others then
  insert into ops_core.audit_events(entity_type,entity_id,action,source_system,metadata)
  values('stage_update',new.id,'stage_update.sync_error','stage_updates',jsonb_build_object('error',sqlerrm));
  return new;
end $$;

drop trigger if exists trg_ops_core_stage_update on public.stage_updates;
create trigger trg_ops_core_stage_update
after insert or update of progress,status,completion_date,resolved_at on public.stage_updates
for each row execute function ops_core.trg_sync_manual_stage_update();

select ops_core.sync_existing_drawings();
