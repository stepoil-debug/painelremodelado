
create or replace function ops_core.ensure_qr_for_item(p_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,public
as $$
declare
  i ops_core.items%rowtype;
  p ops_core.projects%rowtype;
  v_iso text;
  v_bsp_norm text;
  v_iso_norm text;
  v_client_key text;
  v_existing uuid;
  v_token uuid;
begin
  select * into i from ops_core.items where id=p_item_id;
  if not found then return jsonb_build_object('ok',false,'reason','item-not-found'); end if;

  select * into p from ops_core.projects where id=i.project_id;
  if not found or p.source_mode<>'ops_core' then
    return jsonb_build_object('ok',false,'reason','project-not-core');
  end if;

  if i.removed_from_scope then
    return jsonb_build_object('ok',false,'reason','removed-from-scope');
  end if;

  if i.item_type<>'SPOOL' and nullif(i.iso_code,'') is null then
    return jsonb_build_object('ok',false,'reason','not-iso-item');
  end if;

  v_iso:=coalesce(nullif(i.spool_code,''),nullif(i.iso_code,''),nullif(i.drawing_code,''),nullif(i.item_key,''));
  if v_iso is null then return jsonb_build_object('ok',false,'reason','iso-not-found'); end if;

  v_bsp_norm:=regexp_replace(lower(coalesce(p.project_core,p.display_code,'')),'[^a-z0-9]','','g');
  v_iso_norm:=regexp_replace(lower(v_iso),'[^a-z0-9]','','g');
  v_client_key:=lower(btrim(coalesce(p.client,'')));

  select q.id into v_existing
  from public.iso_qr_codes q
  where q.region=p.region
    and regexp_replace(lower(coalesce(q.bsp,'')),'[^a-z0-9]','','g') like '%'||v_bsp_norm
    and regexp_replace(lower(coalesce(q.iso,q.iso_full_name,'')),'[^a-z0-9]','','g')=v_iso_norm
  order by q.created_at
  limit 1;

  if v_existing is not null then
    update public.iso_qr_codes
    set client=coalesce(nullif(p.client,''),client),
        work_order=coalesce(nullif(p.customer_po,''),work_order),
        vessel=coalesce(nullif(p.vessel,''),vessel),
        tag_number=coalesce(nullif(i.tag_number,''),tag_number),
        status=coalesce(nullif(i.current_status,''),status),
        progress=coalesce(i.overall_progress,progress),
        source=case when source like '%tracking%' then source else 'ops_core-auto' end,
        updated_at=now()
    where id=v_existing;

    return jsonb_build_object('ok',true,'existing',true,'qr_id',v_existing);
  end if;

  v_token:=gen_random_uuid();

  insert into public.iso_qr_codes(
    region,client,client_key,bsp,bsp_key,work_order,vessel,tag_number,
    iso,iso_key,iso_full_name,qr_token,qr_url,status,progress,source,created_at,updated_at
  )
  values(
    p.region,
    coalesce(p.client,''),
    v_client_key,
    p.display_code,
    lower(btrim(p.display_code)),
    coalesce(p.customer_po,''),
    coalesce(p.vessel,''),
    coalesce(i.tag_number,''),
    v_iso,
    regexp_replace(lower(v_iso),'[^a-z0-9]+',' ','g'),
    v_iso,
    v_token,
    '/qr-tracking.html?token='||v_token::text,
    coalesce(i.current_status,''),
    coalesce(i.overall_progress,0),
    'ops_core-auto',
    now(),now()
  )
  on conflict(region,client_key,bsp_key,iso_key) do update
  set status=excluded.status,
      progress=excluded.progress,
      updated_at=now()
  returning id into v_existing;

  return jsonb_build_object('ok',true,'existing',false,'qr_id',v_existing);
end $$;

create or replace function ops_core.trg_sync_item_qr()
returns trigger
language plpgsql
security definer
set search_path=ops_core,public
as $$
begin
  perform ops_core.ensure_qr_for_item(new.id);
  return new;
exception when others then
  insert into ops_core.audit_events(
    project_id,item_id,entity_type,entity_id,action,source_system,metadata
  )
  values(
    new.project_id,new.id,'item',new.id::text,'qr.sync_error','ops_core',
    jsonb_build_object('error',sqlerrm)
  );
  return new;
end $$;

drop trigger if exists trg_ops_core_item_qr on ops_core.items;
create trigger trg_ops_core_item_qr
after insert or update of current_status,overall_progress,iso_code,spool_code,drawing_code,removed_from_scope
on ops_core.items
for each row execute function ops_core.trg_sync_item_qr();

create or replace function ops_core.project_cutover(
  p_project_core text,
  p_actor text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,public
as $$
declare
  v_core text := ops_core.normalize_project_core(p_project_core);
  v_project ops_core.projects%rowtype;
  v_items integer;
  v_missing_stages integer;
  v_qr integer := 0;
  r record;
begin
  select * into v_project
  from ops_core.projects
  where region='BR' and project_core=v_core
  for update;

  if not found then raise exception 'Projeto % não encontrado no ops_core.',p_project_core; end if;

  select count(*) into v_items
  from ops_core.items
  where project_id=v_project.id and removed_from_scope=false;
  if v_items=0 then raise exception 'Projeto % não possui itens para cutover.',v_project.display_code; end if;

  perform ops_core.ensure_item_stages(id)
  from ops_core.items
  where project_id=v_project.id;

  select count(*) into v_missing_stages
  from ops_core.items i
  where i.project_id=v_project.id
    and not exists(select 1 from ops_core.item_stages s where s.item_id=i.id);

  if v_missing_stages>0 then
    raise exception 'Projeto % possui % itens sem workflow.',v_project.display_code,v_missing_stages;
  end if;

  if exists (
    select 1 from ops_core.items i
    where i.project_id=v_project.id
      and not i.removed_from_scope
      and coalesce((i.source_metadata->>'provisional_breakdown')::boolean,false)
  ) then
    raise exception 'Projeto % possui itens provisórios que precisam ser detalhados antes do cutover.',v_project.display_code;
  end if;

  update ops_core.projects
  set validation_status='validated',
      source_mode='ops_core',
      validated_at=coalesce(validated_at,now()),
      validated_by=coalesce(nullif(p_actor,''),'system'),
      cutover_at=now(),
      cutover_by=coalesce(nullif(p_actor,''),'system'),
      updated_at=now()
  where id=v_project.id;

  for r in
    select id from ops_core.items
    where project_id=v_project.id and not removed_from_scope
  loop
    begin
      perform ops_core.ensure_qr_for_item(r.id);
      v_qr:=v_qr+1;
    exception when others then
      insert into ops_core.audit_events(
        project_id,item_id,entity_type,entity_id,action,source_system,metadata
      )
      values(
        v_project.id,r.id,'item',r.id::text,'qr.cutover_sync_error','ops_core',
        jsonb_build_object('error',sqlerrm)
      );
    end;
  end loop;

  insert into ops_core.audit_events(
    project_id,entity_type,entity_id,action,actor_email,source_system,before_data,after_data
  )
  values(
    v_project.id,'project',v_project.id::text,'project.cutover',
    coalesce(nullif(p_actor,''),'system'),'ops_core',
    jsonb_build_object('source_mode',v_project.source_mode,'validation_status',v_project.validation_status),
    jsonb_build_object('source_mode','ops_core','validation_status','validated','items',v_items,'qr_checked',v_qr)
  );

  update ops_core.registration_candidates
  set candidate_status='validated',
      validated_project_id=v_project.id,
      last_seen_at=now()
  where region=v_project.region and project_core=v_project.project_core;

  return jsonb_build_object(
    'ok',true,
    'project_id',v_project.id,
    'project_core',v_project.project_core,
    'display_code',v_project.display_code,
    'items',v_items,
    'qr_checked',v_qr,
    'source_mode','ops_core',
    'cutover_at',now()
  );
end $$;
