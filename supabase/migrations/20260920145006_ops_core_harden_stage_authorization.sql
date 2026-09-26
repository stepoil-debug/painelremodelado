
create or replace function ops_core.apply_stage_action(
  p_item_id uuid,
  p_action text,
  p_actor_email text,
  p_actor_name text default null,
  p_actor_sector text default null,
  p_progress numeric default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,public
as $$
declare
  i ops_core.items%rowtype;
  p ops_core.projects%rowtype;
  s ops_core.item_stages%rowtype;
  w ops_core.workflow_stages%rowtype;
  v_action text:=lower(btrim(coalesce(p_action,'')));
  v_actor_scope text:=lower(btrim(coalesce(p_actor_sector,'')));
  v_sector text:=ops_core.normalize_sector_key(p_actor_sector);
  v_is_admin boolean:=v_actor_scope in ('admin','administrator','administrador','all','todos','pcp');
  v_event uuid;
  v_progress numeric;
  v_before jsonb;
  v_handoff uuid;
begin
  select * into i from ops_core.items where id=p_item_id for update;
  if not found then raise exception 'Item não encontrado.'; end if;

  select * into p from ops_core.projects where id=i.project_id;
  if p.source_mode<>'ops_core' then
    raise exception 'Esta BSP ainda está no Tracking legado. Valide o cadastro antes de executar ações operacionais.';
  end if;

  select * into s
  from ops_core.item_stages
  where item_id=i.id and stage_key=i.current_stage_key
  limit 1
  for update;

  if not found then
    select * into s
    from ops_core.item_stages
    where item_id=i.id and is_applicable and status<>'completed'
    order by stage_order
    limit 1
    for update;
  end if;
  if not found then raise exception 'Não há etapa operacional pendente para este item.'; end if;

  select * into w from ops_core.workflow_stages where stage_key=s.stage_key;
  if not found then raise exception 'Etapa operacional sem configuração.'; end if;

  if not v_is_admin then
    if v_sector is null then
      raise exception 'Seu setor não está autorizado para executar ações operacionais nesta etapa.';
    end if;
    if v_sector<>w.sector_key then
      raise exception 'A etapa atual pertence ao setor %, não ao setor do usuário.',w.sector_key;
    end if;
  end if;

  if v_action in ('progress','complete','start')
     and w.execution_mode='apontamento' then
    raise exception 'Esta etapa é controlada pelo Apontamento HH. O avanço deve ser registrado no aplicativo de apontamento.';
  end if;

  v_before:=to_jsonb(s);

  if v_action='accept' then
    update ops_core.item_stages
    set status=case when status='completed' then status else 'accepted' end,
        accepted_at=coalesce(accepted_at,now()),
        updated_by=coalesce(p_actor_name,p_actor_email),
        updated_at=now()
    where id=s.id;

    update ops_core.handoffs
    set status='accepted',
        accepted_at=coalesce(accepted_at,now()),
        accepted_by=coalesce(p_actor_name,p_actor_email)
    where item_id=i.id and to_stage_key=s.stage_key and status='available'
    returning id into v_handoff;

    update ops_core.items
    set current_stage_key=s.stage_key,current_status='accepted',updated_at=now()
    where id=i.id;

  elsif v_action in ('start','progress') then
    v_progress:=greatest(0,least(99,coalesce(p_progress,case when s.progress>0 then s.progress else 25 end)));
    update ops_core.item_stages
    set progress=v_progress,status='in_progress',
        started_at=coalesce(started_at,now()),
        updated_by=coalesce(p_actor_name,p_actor_email),
        updated_at=now(),
        metadata=metadata||jsonb_build_object('last_note',p_note)
    where id=s.id;
    update ops_core.items
    set current_stage_key=s.stage_key,current_status='in_progress',updated_at=now()
    where id=i.id;
    perform ops_core.recompute_item_progress(i.id);

  elsif v_action='wait' then
    update ops_core.item_stages
    set status='waiting',updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now(),
        metadata=metadata||jsonb_build_object('waiting_note',p_note)
    where id=s.id;
    update ops_core.items set current_status='waiting',updated_at=now() where id=i.id;

  elsif v_action='block' then
    update ops_core.item_stages
    set status='blocked',updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now(),
        metadata=metadata||jsonb_build_object('blocked_note',p_note,'blocked_at',now())
    where id=s.id;
    update ops_core.items set current_status='blocked',updated_at=now() where id=i.id;

  elsif v_action='resume' then
    update ops_core.item_stages
    set status=case when progress>0 then 'in_progress' when accepted_at is not null then 'accepted' else 'available' end,
        updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now()
    where id=s.id;
    update ops_core.items
    set current_status=case when s.progress>0 then 'in_progress' else 'available' end,updated_at=now()
    where id=i.id;

  elsif v_action='complete' then
    update ops_core.item_stages
    set progress=100,status='completed',
        started_at=coalesce(started_at,now()),completed_at=coalesce(completed_at,now()),
        actual_date=coalesce(actual_date,current_date),
        updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now(),
        metadata=metadata||jsonb_build_object('completion_note',p_note)
    where id=s.id;
    update ops_core.items set current_status='completed_stage',updated_at=now() where id=i.id;
    perform ops_core.recompute_item_progress(i.id);

  else
    raise exception 'Ação operacional inválida: %',p_action;
  end if;

  select progress into v_progress from ops_core.item_stages where id=s.id;

  insert into ops_core.stage_events(
    project_id,item_id,item_stage_id,event_type,stage_key,sector_key,
    progress_from,progress_to,actor_email,actor_name,source_system,source_event_id,payload
  )
  values(
    p.id,i.id,s.id,'stage.'||v_action,s.stage_key,w.sector_key,
    s.progress,v_progress,p_actor_email,p_actor_name,'ops_core',
    gen_random_uuid()::text,
    jsonb_build_object('note',p_note,'before',v_before,'action',v_action)
  )
  returning id into v_event;

  if v_action='complete' then
    return ops_core.advance_item_after_stage(i.id,s.stage_key,v_event,coalesce(p_actor_name,p_actor_email))
      || jsonb_build_object('event_id',v_event);
  end if;

  return jsonb_build_object(
    'ok',true,'project_id',p.id,'item_id',i.id,'stage_key',s.stage_key,
    'action',v_action,'progress',v_progress,'event_id',v_event,'handoff_id',v_handoff
  );
end $$;
