alter table ops_core.panel_legacy_stage_advances
  add column if not exists stage_key text;

alter table ops_core.panel_legacy_stage_advances
  add column if not exists tracking_stage_key text;

update ops_core.panel_legacy_stage_advances
set stage_key = coalesce(nullif(stage_key, ''), 'legacy_current'),
    tracking_stage_key = coalesce(nullif(tracking_stage_key, ''), 'legacy_current')
where stage_key is null or tracking_stage_key is null;

alter table ops_core.panel_legacy_stage_advances
  alter column stage_key set not null,
  alter column tracking_stage_key set not null;

alter table ops_core.panel_legacy_stage_advances
  drop constraint if exists panel_legacy_stage_advances_region_project_row_id_iso_key_key;

create unique index if not exists panel_legacy_stage_advances_stage_identity_idx
  on ops_core.panel_legacy_stage_advances(region, project_row_id, iso_key, stage_key);

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
      'last_actor', a.last_actor_name
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

create or replace function ops_core.apply_panel_legacy_stage_action(
  p_region text,
  p_project_row_id text,
  p_project_number text,
  p_iso text,
  p_stage_key text,
  p_tracking_stage_key text,
  p_action text,
  p_actor_email text,
  p_actor_name text default null,
  p_progress numeric default null,
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
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_actor_email text := nullif(btrim(coalesce(p_actor_email, '')), '');
  v_actor_name text := nullif(btrim(coalesce(p_actor_name, '')), '');
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
  v_tracking record;
  v_advance ops_core.panel_legacy_stage_advances%rowtype;
  v_before_progress numeric;
  v_before_status text;
  v_next_progress numeric;
  v_next_status text;
begin
  if v_project_row_id = '' or v_iso_norm = '' or v_stage_key is null or v_tracking_stage_key is null then
    raise exception 'BSP, ISO e etapa são obrigatórios para editar este apontamento.';
  end if;

  if v_action not in ('accept', 'start', 'progress', 'wait', 'resume', 'block', 'complete') then
    raise exception 'Ação de avanço inválida: %', p_action;
  end if;

  select t.region, t.project_row_id, t.project_number, t.iso_key, t.iso, t.drawing,
         t.current_stage, t.current_status, t.overall_progress
    into v_tracking
  from public.tracking_isos t
  where t.region = v_region
    and t.active = true
    and t.project_row_id = v_project_row_id
    and ops_core.panel_legacy_key(coalesce(t.iso_key, t.drawing, t.iso)) = v_iso_norm
  order by t.synced_at desc nulls last
  limit 1;

  if not found then
    raise exception 'Apontamento legado não encontrado ou não está ativo no Tracking.';
  end if;

  insert into ops_core.panel_legacy_stage_advances (
    region, project_row_id, project_number, iso_key, iso,
    stage_key, tracking_stage_key, base_stage, base_status, base_progress, panel_progress
  ) values (
    v_region, v_project_row_id, coalesce(v_tracking.project_number, v_project_number),
    v_iso_norm, coalesce(v_tracking.iso, v_tracking.drawing, p_iso),
    v_stage_key, v_tracking_stage_key, v_tracking.current_stage, v_tracking.current_status,
    case when v_stage_key=v_tracking_stage_key then greatest(0, least(100, coalesce(v_tracking.overall_progress, 0))) else 0 end,
    case when v_stage_key=v_tracking_stage_key then greatest(0, least(100, coalesce(v_tracking.overall_progress, 0))) else 0 end
  )
  on conflict (region, project_row_id, iso_key, stage_key) do nothing;

  select * into v_advance
  from ops_core.panel_legacy_stage_advances
  where region=v_region and project_row_id=v_project_row_id and iso_key=v_iso_norm and stage_key=v_stage_key
  for update;

  v_before_progress := v_advance.panel_progress;
  v_before_status := v_advance.panel_status;
  v_next_progress := v_before_progress;
  v_next_status := v_before_status;

  if v_action in ('start', 'progress') then
    v_next_progress := greatest(v_before_progress, least(99, greatest(0, coalesce(p_progress, case when v_before_progress > 0 then v_before_progress else 25 end))));
    if v_next_progress <= v_before_progress and v_action = 'progress' then
      raise exception 'O novo avanço precisa ser maior que o atual.';
    end if;
    v_next_status := 'in_progress';
  elsif v_action = 'complete' then
    v_next_progress := 100;
    v_next_status := 'completed';
  elsif v_action = 'wait' then
    v_next_status := 'waiting';
  elsif v_action = 'block' then
    v_next_status := 'blocked';
  elsif v_action = 'resume' then
    v_next_status := case when v_before_progress > 0 then 'in_progress' else 'new' end;
  elsif v_action = 'accept' then
    v_next_status := case when v_before_progress > 0 then 'in_progress' else 'new' end;
  end if;

  update ops_core.panel_legacy_stage_advances
  set panel_status=v_next_status,
      panel_progress=v_next_progress,
      last_action=v_action,
      last_note=v_note,
      last_actor_email=v_actor_email,
      last_actor_name=v_actor_name,
      updated_at=now()
  where id=v_advance.id;

  insert into ops_core.panel_legacy_stage_events (
    advance_id, region, project_row_id, project_number, iso_key,
    event_type, progress_from, progress_to, status_from, status_to,
    actor_email, actor_name, note, payload
  ) values (
    v_advance.id, v_region, v_project_row_id, v_advance.project_number, v_iso_norm,
    'stage.' || v_action, v_before_progress, v_next_progress, v_before_status, v_next_status,
    v_actor_email, v_actor_name, v_note,
    jsonb_build_object('source', 'tracking_legacy', 'iso', v_advance.iso, 'stage_key', v_stage_key)
  );

  return jsonb_build_object(
    'ok', true,
    'source', 'tracking_legacy',
    'region', v_region,
    'project_row_id', v_project_row_id,
    'project_number', v_advance.project_number,
    'iso_key', v_iso_norm,
    'stage_key', v_stage_key,
    'action', v_action,
    'progress', v_next_progress,
    'status', v_next_status,
    'updated_at', now()
  );
end;
$$;

revoke all on function ops_core.get_panel_legacy_stage_advances(text) from public, anon, authenticated;
revoke all on function ops_core.apply_panel_legacy_stage_action(text,text,text,text,text,text,text,text,text,numeric,text) from public, anon, authenticated;
grant execute on function ops_core.get_panel_legacy_stage_advances(text) to service_role;
grant execute on function ops_core.apply_panel_legacy_stage_action(text,text,text,text,text,text,text,text,text,numeric,text) to service_role;

create or replace function ops_core.apply_stage_action_for_stage(
  p_item_id uuid,
  p_stage_key text,
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
set search_path = public, ops_core
as $$
declare
  i ops_core.items%rowtype;
  p ops_core.projects%rowtype;
  s ops_core.item_stages%rowtype;
  w ops_core.workflow_stages%rowtype;
  v_action text:=lower(btrim(coalesce(p_action,'')));
  v_sector text:=ops_core.normalize_sector_key(p_actor_sector);
  v_scope text:=lower(btrim(coalesce(p_actor_sector,'')));
  v_is_admin boolean:=v_scope in ('admin','administrator','administrador','all','todos','pcp');
  v_event uuid;
  v_before jsonb;
  v_from numeric;
  v_to numeric;
begin
  select * into i from ops_core.items where id=p_item_id for update;
  if not found then raise exception 'Item não encontrado.'; end if;
  select * into p from ops_core.projects where id=i.project_id;
  if p.source_mode<>'ops_core' then raise exception 'Esta BSP ainda está no Tracking legado.'; end if;
  if btrim(coalesce(p_stage_key,'')) = '' then
    return ops_core.apply_stage_action(p_item_id,p_action,p_actor_email,p_actor_name,p_actor_sector,p_progress,p_note);
  end if;
  select * into s from ops_core.item_stages where item_id=i.id and stage_key=p_stage_key and is_applicable for update;
  if not found then raise exception 'A etapa selecionada não está disponível para este item.'; end if;
  select * into w from ops_core.workflow_stages where stage_key=s.stage_key;
  if not found then raise exception 'Etapa operacional sem configuração.'; end if;
  if not v_is_admin and (v_sector is null or v_sector<>w.sector_key) then
    raise exception 'A etapa atual pertence ao setor %, não ao setor do usuário.',w.sector_key;
  end if;
  if v_action not in ('accept','start','progress','wait','resume','block','complete') then raise exception 'Ação operacional inválida: %',p_action; end if;
  if v_action in ('progress','complete','start') and w.execution_mode='apontamento' then raise exception 'Esta etapa ainda está configurada para apontamento.'; end if;
  v_before:=to_jsonb(s); v_from:=coalesce(s.progress,0); v_to:=v_from;
  if v_action in ('start','progress') then
    v_to:=greatest(v_from,least(99,coalesce(p_progress,case when v_from>0 then v_from else 25 end)));
    if v_action='progress' and v_to<=v_from then raise exception 'O novo avanço precisa ser maior que o atual.'; end if;
    update ops_core.item_stages set progress=v_to,status='in_progress',started_at=coalesce(started_at,now()),updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now(),metadata=metadata||jsonb_build_object('last_note',p_note) where id=s.id;
  elsif v_action='complete' then
    v_to:=100; update ops_core.item_stages set progress=100,status='completed',started_at=coalesce(started_at,now()),completed_at=coalesce(completed_at,now()),actual_date=coalesce(actual_date,current_date),updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now(),metadata=metadata||jsonb_build_object('completion_note',p_note) where id=s.id;
  elsif v_action='wait' then update ops_core.item_stages set status='waiting',updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now(),metadata=metadata||jsonb_build_object('waiting_note',p_note) where id=s.id;
  elsif v_action='block' then update ops_core.item_stages set status='blocked',updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now(),metadata=metadata||jsonb_build_object('blocked_note',p_note) where id=s.id;
  elsif v_action='resume' then update ops_core.item_stages set status=case when coalesce(progress,0)>0 then 'in_progress' else 'available' end,updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now() where id=s.id;
  elsif v_action='accept' then update ops_core.item_stages set status=case when status='completed' then status else 'accepted' end,accepted_at=coalesce(accepted_at,now()),updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now() where id=s.id;
  end if;
  insert into ops_core.stage_events(project_id,item_id,item_stage_id,event_type,stage_key,sector_key,progress_from,progress_to,actor_email,actor_name,source_system,source_event_id,payload)
  values(p.id,i.id,s.id,'stage.'||v_action,s.stage_key,w.sector_key,v_from,v_to,p_actor_email,p_actor_name,'ops_core',gen_random_uuid()::text,jsonb_build_object('note',p_note,'before',v_before,'action',v_action,'selected_stage',true)) returning id into v_event;
  perform ops_core.recompute_item_progress(i.id);
  return jsonb_build_object('ok',true,'project_id',p.id,'item_id',i.id,'stage_key',s.stage_key,'action',v_action,'progress',v_to,'event_id',v_event);
end;
$$;

create or replace function public.ops_core_stage_action_for_stage(
  p_item_id uuid, p_stage_key text, p_action text, p_actor_email text,
  p_actor_name text default null, p_actor_sector text default null,
  p_progress numeric default null, p_note text default null
)
returns jsonb
language sql
security definer
set search_path = public, ops_core
as $$
  select ops_core.apply_stage_action_for_stage(p_item_id,p_stage_key,p_action,p_actor_email,p_actor_name,p_actor_sector,p_progress,p_note);
$$;

revoke all on function ops_core.apply_stage_action_for_stage(uuid,text,text,text,text,text,numeric,text) from public, anon, authenticated;
revoke all on function public.ops_core_stage_action_for_stage(uuid,text,text,text,text,text,numeric,text) from public, anon, authenticated;
grant execute on function ops_core.apply_stage_action_for_stage(uuid,text,text,text,text,text,numeric,text) to service_role;
grant execute on function public.ops_core_stage_action_for_stage(uuid,text,text,text,text,text,numeric,text) to service_role;
