-- Allow the last panel advancement to be reverted without deleting its audit trail.

create or replace function ops_core.get_panel_legacy_stage_advances(p_region text default 'BR')
returns jsonb
language sql
stable
security definer
set search_path = public, ops_core
as $$
  with grouped as (
    select a.region,
      a.project_row_id,
      max(a.project_number) as project_number,
      a.iso_key,
      max(a.iso) as iso,
      max(a.updated_at) as updated_at,
      jsonb_agg(jsonb_build_object(
        'stage_key', a.stage_key,
        'tracking_stage_key', a.tracking_stage_key,
        'progress', a.panel_progress,
        'status', a.panel_status,
        'updated_at', a.updated_at,
        'last_action', a.last_action,
        'last_actor', a.last_actor_name,
        'can_undo', exists (
          select 1
          from ops_core.panel_legacy_stage_events e
          where e.advance_id = a.id
            and e.id = (
              select latest.id
              from ops_core.panel_legacy_stage_events latest
              where latest.advance_id = a.id
              order by latest.created_at desc, latest.id desc
              limit 1
            )
            and e.event_type in ('stage.start', 'stage.progress', 'stage.complete')
        )
      ) order by a.updated_at desc) as stage_overrides
    from ops_core.panel_legacy_stage_advances a
    where a.region = coalesce(nullif(btrim(p_region), ''), 'BR')
    group by a.region, a.project_row_id, a.iso_key
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'region', g.region,
    'project_row_id', g.project_row_id,
    'project_number', g.project_number,
    'iso_key', g.iso_key,
    'iso', g.iso,
    'stage_overrides', g.stage_overrides
  ) order by g.updated_at desc), '[]'::jsonb)
  from grouped g;
$$;

create or replace function ops_core.undo_panel_legacy_stage_action(
  p_region text,
  p_project_row_id text,
  p_project_number text,
  p_iso text,
  p_stage_key text,
  p_tracking_stage_key text,
  p_actor_email text,
  p_actor_name text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, ops_core
as $$
declare
  v_region text := coalesce(nullif(btrim(p_region), ''), 'BR');
  v_project_row_id text := btrim(coalesce(p_project_row_id, ''));
  v_project_number text := btrim(coalesce(p_project_number, ''));
  v_iso_norm text := ops_core.panel_legacy_key(p_iso);
  v_stage_key text := nullif(btrim(coalesce(p_stage_key, '')), '');
  v_tracking_stage_key text := nullif(btrim(coalesce(p_tracking_stage_key, '')), '');
  v_actor_email text := nullif(btrim(coalesce(p_actor_email, '')), '');
  v_actor_name text := nullif(btrim(coalesce(p_actor_name, '')), '');
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
  v_advance ops_core.panel_legacy_stage_advances%rowtype;
  v_event ops_core.panel_legacy_stage_events%rowtype;
  v_next ops_core.panel_legacy_stage_advances%rowtype;
  v_restore_progress numeric;
  v_restore_status text;
  v_next_stage_key text;
begin
  if v_project_row_id = '' or v_iso_norm = '' or v_stage_key is null or v_tracking_stage_key is null then
    raise exception 'BSP, ISO e etapa são obrigatórios para desfazer o avanço.';
  end if;

  select * into v_advance
  from ops_core.panel_legacy_stage_advances
  where region=v_region and project_row_id=v_project_row_id and iso_key=v_iso_norm and stage_key=v_stage_key
  for update;
  if not found then raise exception 'Avanço do painel não encontrado para esta etapa.'; end if;

  select * into v_event
  from ops_core.panel_legacy_stage_events
  where advance_id=v_advance.id
  order by created_at desc, id desc
  limit 1;
  if not found or v_event.event_type not in ('stage.start','stage.progress','stage.complete') then
    raise exception 'Somente o último avanço do painel pode ser desfeito.';
  end if;

  v_restore_progress := greatest(0, least(100, coalesce(v_event.progress_from, 0)));
  v_restore_status := coalesce(nullif(v_event.status_from, ''), case when v_restore_progress > 0 then 'in_progress' else 'new' end);

  if v_event.event_type = 'stage.complete' then
    v_next_stage_key := case v_stage_key
      when 'engineering_release' then 'stock_check'
      when 'stock_check' then 'material_separation'
      when 'material_separation' then 'cutting'
      when 'cutting' then 'fitup'
      when 'fitup' then 'welding'
      when 'welding' then 'quality_visual'
      when 'quality_visual' then 'quality_dimensional'
      when 'quality_dimensional' then 'hydro_test'
      when 'hydro_test' then 'painting'
      when 'painting' then 'final_inspection'
      when 'final_inspection' then 'dispatch'
      else null
    end;

    if v_next_stage_key is not null then
      select * into v_next
      from ops_core.panel_legacy_stage_advances
      where region=v_region and project_row_id=v_project_row_id and iso_key=v_iso_norm and stage_key=v_next_stage_key
      for update;

      if found then
        if v_next.panel_progress <> 25 or v_next.panel_status <> 'in_progress'
           or exists (
             select 1 from ops_core.panel_legacy_stage_events e
             where e.advance_id=v_next.id and e.created_at > v_event.created_at
           ) then
          raise exception 'Não é possível desfazer: a próxima etapa já recebeu outra ação.';
        end if;

        update ops_core.panel_legacy_stage_advances
        set panel_status='new', panel_progress=0, last_action='undo_handoff',
            last_note='Handoff revertido junto com a correção do avanço.',
            last_actor_email=v_actor_email, last_actor_name=v_actor_name, updated_at=now()
        where id=v_next.id;

        insert into ops_core.panel_legacy_stage_events(
          advance_id,region,project_row_id,project_number,iso_key,event_type,
          progress_from,progress_to,status_from,status_to,actor_email,actor_name,note,payload
        ) values(
          v_next.id,v_region,v_project_row_id,v_next.project_number,v_iso_norm,'stage.undo_handoff',
          25,0,'in_progress','new',v_actor_email,v_actor_name,v_note,
          jsonb_build_object('undone_event_id',v_event.id,'source','panel_undo')
        );
      end if;
    end if;
  end if;

  update ops_core.panel_legacy_stage_advances
  set panel_status=v_restore_status,
      panel_progress=v_restore_progress,
      last_action='undo',
      last_note=coalesce(v_note,'Último avanço desfeito pelo painel.'),
      last_actor_email=v_actor_email,
      last_actor_name=v_actor_name,
      updated_at=now()
  where id=v_advance.id;

  insert into ops_core.panel_legacy_stage_events(
    advance_id,region,project_row_id,project_number,iso_key,event_type,
    progress_from,progress_to,status_from,status_to,actor_email,actor_name,note,payload
  ) values(
    v_advance.id,v_region,v_project_row_id,v_advance.project_number,v_iso_norm,'stage.undo',
    v_advance.panel_progress,v_restore_progress,v_advance.panel_status,v_restore_status,
    v_actor_email,v_actor_name,v_note,
    jsonb_build_object('undone_event_id',v_event.id,'source','panel_undo','stage_key',v_stage_key)
  );

  return jsonb_build_object(
    'ok',true,'source','tracking_legacy','stage_key',v_stage_key,
    'progress',v_restore_progress,'status',v_restore_status,
    'handoff_reverted',v_next_stage_key is not null,'updated_at',now()
  );
end;
$$;

create or replace function ops_core.undo_stage_action_for_stage(
  p_item_id uuid,
  p_stage_key text,
  p_actor_email text,
  p_actor_name text default null,
  p_actor_sector text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, ops_core
as $$
declare
  i ops_core.items%rowtype;
  p ops_core.projects%rowtype;
  s ops_core.item_stages%rowtype;
  w ops_core.workflow_stages%rowtype;
  e ops_core.stage_events%rowtype;
  nxt ops_core.item_stages%rowtype;
  h ops_core.handoffs%rowtype;
  v_before jsonb;
  v_restore_progress numeric;
  v_restore_status text;
  v_scope text:=lower(btrim(coalesce(p_actor_sector,'')));
  v_sector text:=ops_core.normalize_sector_key(p_actor_sector);
  v_is_admin boolean:=v_scope in ('admin','administrator','administrador','all','todos','pcp');
begin
  select * into i from ops_core.items where id=p_item_id for update;
  if not found then raise exception 'Item não encontrado.'; end if;
  select * into p from ops_core.projects where id=i.project_id;
  if p.source_mode<>'ops_core' and not (p.source_mode='archived' and p.archive_reason='AUTO_ALL_ITEMS_COMPLETED') then
    raise exception 'Esta BSP ainda está no Tracking legado.';
  end if;
  select * into s from ops_core.item_stages where item_id=i.id and stage_key=p_stage_key and is_applicable for update;
  if not found then raise exception 'A etapa selecionada não está disponível para este item.'; end if;
  select * into w from ops_core.workflow_stages where stage_key=s.stage_key;
  if not found then raise exception 'Etapa operacional sem configuração.'; end if;
  if not v_is_admin and (v_sector is null or v_sector<>w.sector_key) then
    raise exception 'A etapa atual pertence ao setor %, não ao setor do usuário.',w.sector_key;
  end if;

  select * into e
  from ops_core.stage_events
  where item_id=i.id and stage_key=s.stage_key
  order by created_at desc, id desc
  limit 1;
  if not found or e.event_type not in ('stage.start','stage.progress','stage.complete') then
    raise exception 'Somente o último avanço do painel pode ser desfeito.';
  end if;

  v_before:=coalesce(e.payload->'before','{}'::jsonb);
  v_restore_progress:=greatest(0,least(100,coalesce(nullif(v_before->>'progress','')::numeric,e.progress_from,0)));
  v_restore_status:=coalesce(nullif(v_before->>'status',''),case when v_restore_progress>0 then 'in_progress' else 'available' end);

  if e.event_type='stage.complete' then
    select s2.* into nxt
    from ops_core.item_stages s2
    where s2.item_id=i.id and s2.is_applicable=true and s2.stage_order>s.stage_order and s2.status<>'completed'
    order by s2.stage_order
    limit 1
    for update;

    if found then
      if coalesce(nxt.progress,0)<>25 or nxt.status<>'in_progress'
         or exists(select 1 from ops_core.stage_events ne where ne.item_id=i.id and ne.stage_key=nxt.stage_key and ne.created_at>e.created_at)
         or exists(select 1 from ops_core.stage_evidence se where se.item_id=i.id and se.item_stage_id=nxt.id and se.created_at>e.created_at) then
        raise exception 'Não é possível desfazer: a próxima etapa já recebeu outra ação ou evidência.';
      end if;

      select * into h
      from ops_core.handoffs
      where item_id=i.id and from_stage_key=s.stage_key and to_stage_key=nxt.stage_key and source_event_id=e.id
      order by available_at desc
      limit 1
      for update;
      if found and h.status<>'available' then
        raise exception 'Não é possível desfazer: a próxima etapa já foi assumida.';
      end if;

      update ops_core.item_stages
      set progress=null,status='pending',entered_at=null,accepted_at=null,started_at=null,
          completed_at=null,actual_date=null,updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now()
      where id=nxt.id;
      if found then
        insert into ops_core.stage_events(
          project_id,item_id,item_stage_id,event_type,stage_key,sector_key,
          progress_from,progress_to,actor_email,actor_name,source_system,source_event_id,payload
        ) values(
          p.id,i.id,nxt.id,'stage.undo_handoff',nxt.stage_key,
          (select sector_key from ops_core.workflow_stages where stage_key=nxt.stage_key),
          25,0,p_actor_email,p_actor_name,'ops_core',gen_random_uuid()::text,
          jsonb_build_object('undone_event_id',e.id,'source','panel_undo')
        );
      end if;
      if h.id is not null then
        update ops_core.handoffs set status='cancelled',note=coalesce(p_note,'Handoff revertido pelo painel.') where id=h.id;
      end if;
    end if;
  end if;

  update ops_core.item_stages
  set progress=v_restore_progress,
      status=v_restore_status,
      entered_at=(nullif(v_before->>'entered_at',''))::timestamptz,
      accepted_at=(nullif(v_before->>'accepted_at',''))::timestamptz,
      started_at=(nullif(v_before->>'started_at',''))::timestamptz,
      completed_at=(nullif(v_before->>'completed_at',''))::timestamptz,
      actual_date=(nullif(v_before->>'actual_date',''))::date,
      updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now()
  where id=s.id;

  if e.event_type='stage.complete' then
    update ops_core.items
    set current_stage_key=s.stage_key,current_status=v_restore_status,overall_progress=null,updated_at=now()
    where id=i.id;
    if p.source_mode='archived' or p.active=false then
      update ops_core.projects
      set source_mode='ops_core',project_status='ACTIVE',active=true,completed_at=null,archived_at=null,
          archived_by=null,archive_reason=null,reporting_year=null,updated_at=now()
      where id=p.id and archive_reason='AUTO_ALL_ITEMS_COMPLETED';
    end if;
  end if;

  insert into ops_core.stage_events(
    project_id,item_id,item_stage_id,event_type,stage_key,sector_key,
    progress_from,progress_to,actor_email,actor_name,source_system,source_event_id,payload
  ) values(
    p.id,i.id,s.id,'stage.undo',s.stage_key,w.sector_key,
    s.progress,v_restore_progress,p_actor_email,p_actor_name,'ops_core',gen_random_uuid()::text,
    jsonb_build_object('undone_event_id',e.id,'source','panel_undo','before',v_before)
  );

  perform ops_core.recompute_item_progress(i.id);
  return jsonb_build_object('ok',true,'source','ops_core','item_id',i.id,'stage_key',s.stage_key,
    'progress',v_restore_progress,'status',v_restore_status,'updated_at',now());
end;
$$;

create or replace function public.ops_core_undo_panel_legacy_stage_action(
  p_region text,p_project_row_id text,p_project_number text,p_iso text,
  p_stage_key text,p_tracking_stage_key text,p_actor_email text,
  p_actor_name text default null,p_note text default null
)
returns jsonb language sql security definer set search_path=public,ops_core
as $$
  select ops_core.undo_panel_legacy_stage_action(p_region,p_project_row_id,p_project_number,p_iso,p_stage_key,p_tracking_stage_key,p_actor_email,p_actor_name,p_note);
$$;

create or replace function public.ops_core_undo_stage_action_for_stage(
  p_item_id uuid,p_stage_key text,p_actor_email text,p_actor_name text default null,
  p_actor_sector text default null,p_note text default null
)
returns jsonb language sql security definer set search_path=public,ops_core
as $$
  select ops_core.undo_stage_action_for_stage(p_item_id,p_stage_key,p_actor_email,p_actor_name,p_actor_sector,p_note);
$$;

revoke all on function ops_core.get_panel_legacy_stage_advances(text) from public,anon,authenticated;
revoke all on function ops_core.undo_panel_legacy_stage_action(text,text,text,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function ops_core.undo_stage_action_for_stage(uuid,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.ops_core_undo_panel_legacy_stage_action(text,text,text,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.ops_core_undo_stage_action_for_stage(uuid,text,text,text,text,text) from public,anon,authenticated;
grant execute on function ops_core.get_panel_legacy_stage_advances(text) to service_role;
grant execute on function ops_core.undo_panel_legacy_stage_action(text,text,text,text,text,text,text,text,text) to service_role;
grant execute on function ops_core.undo_stage_action_for_stage(uuid,text,text,text,text,text) to service_role;
grant execute on function public.ops_core_undo_panel_legacy_stage_action(text,text,text,text,text,text,text,text,text) to service_role;
grant execute on function public.ops_core_undo_stage_action_for_stage(uuid,text,text,text,text,text) to service_role;
