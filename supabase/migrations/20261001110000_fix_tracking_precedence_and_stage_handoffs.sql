-- Keep the newest Tracking-derived row authoritative in the panel feed and
-- make 100% complete the selected operational stage with an automatic handoff.

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
  v_completed boolean:=false;
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
    v_to:=greatest(v_from,least(100,coalesce(p_progress,case when v_from>0 then v_from else 25 end)));
    if v_action='progress' and v_to<=v_from then raise exception 'O novo avanço precisa ser maior que o atual.'; end if;
    v_completed:=v_to>=100;
    update ops_core.item_stages
    set progress=v_to,
        status=case when v_completed then 'completed' else 'in_progress' end,
        started_at=coalesce(started_at,now()),
        completed_at=case when v_completed then coalesce(completed_at,now()) else completed_at end,
        actual_date=case when v_completed then coalesce(actual_date,current_date) else actual_date end,
        updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now(),metadata=metadata||jsonb_build_object('last_note',p_note)
    where id=s.id;
  elsif v_action='complete' then
    v_to:=100;
    v_completed:=true;
    update ops_core.item_stages
    set progress=100,status='completed',started_at=coalesce(started_at,now()),completed_at=coalesce(completed_at,now()),actual_date=coalesce(actual_date,current_date),updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now(),metadata=metadata||jsonb_build_object('completion_note',p_note)
    where id=s.id;
  elsif v_action='wait' then
    update ops_core.item_stages set status='waiting',updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now(),metadata=metadata||jsonb_build_object('waiting_note',p_note) where id=s.id;
  elsif v_action='block' then
    update ops_core.item_stages set status='blocked',updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now(),metadata=metadata||jsonb_build_object('blocked_note',p_note) where id=s.id;
  elsif v_action='resume' then
    update ops_core.item_stages set status=case when progress>0 then 'in_progress' when accepted_at is not null then 'accepted' else 'available' end,updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now() where id=s.id;
  elsif v_action='accept' then
    update ops_core.item_stages set status=case when status='completed' then status else 'accepted' end,accepted_at=coalesce(accepted_at,now()),updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now() where id=s.id;
  end if;

  update ops_core.items
  set current_stage_key=s.stage_key,
      current_status=case when v_completed then 'completed_stage' else current_status end,
      updated_at=now()
  where id=i.id;

  insert into ops_core.stage_events(project_id,item_id,item_stage_id,event_type,stage_key,sector_key,progress_from,progress_to,actor_email,actor_name,source_system,source_event_id,payload)
  values(p.id,i.id,s.id,'stage.'||v_action,s.stage_key,w.sector_key,v_from,v_to,p_actor_email,p_actor_name,'ops_core',gen_random_uuid()::text,jsonb_build_object('note',p_note,'before',v_before,'action',v_action,'selected_stage',true))
  returning id into v_event;

  if v_completed then
    return ops_core.advance_item_after_stage(i.id,s.stage_key,v_event,coalesce(p_actor_name,p_actor_email))
      || jsonb_build_object('event_id',v_event,'progress',100);
  end if;

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
  v_next_stage_key text;
  v_next_stage_label text;
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
  where t.region = v_region and t.active = true and t.project_row_id = v_project_row_id
    and ops_core.panel_legacy_key(coalesce(t.iso_key, t.drawing, t.iso)) = v_iso_norm
  order by t.synced_at desc nulls last limit 1;
  if not found then raise exception 'Apontamento legado não encontrado ou não está ativo no Tracking.'; end if;

  insert into ops_core.panel_legacy_stage_advances (
    region, project_row_id, project_number, iso_key, iso, stage_key, tracking_stage_key,
    base_stage, base_status, base_progress, panel_progress
  ) values (
    v_region, v_project_row_id, coalesce(v_tracking.project_number, v_project_number), v_iso_norm,
    coalesce(v_tracking.iso, v_tracking.drawing, p_iso), v_stage_key, v_tracking_stage_key,
    v_tracking.current_stage, v_tracking.current_status,
    case when v_stage_key=v_tracking_stage_key then greatest(0, least(100, coalesce(v_tracking.overall_progress, 0))) else 0 end,
    case when v_stage_key=v_tracking_stage_key then greatest(0, least(100, coalesce(v_tracking.overall_progress, 0))) else 0 end
  ) on conflict (region, project_row_id, iso_key, stage_key) do nothing;

  select * into v_advance from ops_core.panel_legacy_stage_advances
  where region=v_region and project_row_id=v_project_row_id and iso_key=v_iso_norm and stage_key=v_stage_key for update;
  v_before_progress := v_advance.panel_progress;
  v_before_status := v_advance.panel_status;
  v_next_progress := v_before_progress;
  v_next_status := v_before_status;

  if v_action in ('start', 'progress') then
    v_next_progress := greatest(v_before_progress, least(100, greatest(0, coalesce(p_progress, case when v_before_progress > 0 then v_before_progress else 25 end))));
    if v_next_progress <= v_before_progress and v_action = 'progress' then raise exception 'O novo avanço precisa ser maior que o atual.'; end if;
    v_next_status := case when v_next_progress >= 100 then 'completed' else 'in_progress' end;
  elsif v_action = 'complete' then
    v_next_progress := 100;
    v_next_status := 'completed';
  elsif v_action = 'wait' then v_next_status := 'waiting';
  elsif v_action = 'block' then v_next_status := 'blocked';
  elsif v_action = 'resume' then v_next_status := case when v_before_progress > 0 then 'in_progress' else 'new' end;
  elsif v_action = 'accept' then v_next_status := case when v_before_progress > 0 then 'in_progress' else 'new' end;
  end if;

  update ops_core.panel_legacy_stage_advances
  set panel_status=v_next_status,panel_progress=v_next_progress,last_action=v_action,last_note=v_note,
      last_actor_email=v_actor_email,last_actor_name=v_actor_name,updated_at=now()
  where id=v_advance.id;

  insert into ops_core.panel_legacy_stage_events (
    advance_id, region, project_row_id, project_number, iso_key, event_type,
    progress_from, progress_to, status_from, status_to, actor_email, actor_name, note, payload
  ) values (
    v_advance.id, v_region, v_project_row_id, v_advance.project_number, v_iso_norm,
    'stage.' || v_action, v_before_progress, v_next_progress, v_before_status, v_next_status,
    v_actor_email, v_actor_name, v_note,
    jsonb_build_object('source', 'tracking_legacy', 'iso', v_advance.iso, 'stage_key', v_stage_key)
  );

  if v_next_status = 'completed' then
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
    v_next_stage_label := case v_next_stage_key
      when 'stock_check' then 'Verificação de Estoque'
      when 'material_separation' then 'Separação de Material'
      when 'cutting' then 'Corte e Preparação'
      when 'fitup' then 'Caldeiraria / Fit-up'
      when 'welding' then 'Soldagem'
      when 'quality_visual' then 'Inspeção Visual'
      when 'quality_dimensional' then 'Inspeção Dimensional'
      when 'hydro_test' then 'Hydro Test'
      when 'painting' then 'Pintura / Revestimento'
      when 'final_inspection' then 'Inspeção Final'
      when 'dispatch' then 'Liberação / Expedição'
      else null
    end;
    if v_next_stage_key is not null then
      insert into ops_core.panel_legacy_stage_advances (
        region, project_row_id, project_number, iso_key, iso, stage_key, tracking_stage_key,
        base_stage, base_status, base_progress, panel_status, panel_progress,
        last_action, last_actor_email, last_actor_name
      ) values (
        v_region, v_project_row_id, v_advance.project_number, v_iso_norm, v_advance.iso,
        v_next_stage_key, v_next_stage_key, v_next_stage_label, 'Nova etapa liberada', 0,
        'new', 0, 'handoff', v_actor_email, v_actor_name
      ) on conflict (region, project_row_id, iso_key, stage_key) do nothing;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true, 'source', 'tracking_legacy', 'region', v_region,
    'project_row_id', v_project_row_id, 'project_number', v_advance.project_number,
    'iso_key', v_iso_norm, 'stage_key', v_stage_key, 'action', v_action,
    'progress', v_next_progress, 'status', v_next_status,
    'next_stage_key', v_next_stage_key, 'next_stage_label', v_next_stage_label,
    'updated_at', now()
  );
end;
$$;

revoke all on function ops_core.apply_panel_legacy_stage_action(text,text,text,text,text,text,text,text,text,numeric,text) from public, anon, authenticated;
grant execute on function ops_core.apply_panel_legacy_stage_action(text,text,text,text,text,text,text,text,text,numeric,text) to service_role;
