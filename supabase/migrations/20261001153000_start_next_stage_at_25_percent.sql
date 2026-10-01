-- Start the next stage at the first panel milestone after a handoff.
-- The legacy panel and OPS Core must not expose a newly released stage at 0%.

create or replace function ops_core.advance_item_after_stage(
  p_item_id uuid,
  p_stage_key text,
  p_source_event_id uuid default null,
  p_actor text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path = ops_core, public
as $$
declare
  i ops_core.items%rowtype;
  p ops_core.projects%rowtype;
  cur ops_core.item_stages%rowtype;
  nxt record;
  v_handoff_id uuid;
  v_dedup text;
  v_archive jsonb;
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
    set current_stage_key='completed',
        current_status='completed',
        overall_progress=100,
        completed_at=coalesce(completed_at,now()),
        updated_at=now()
    where id=i.id;

    v_archive:=ops_core.archive_project_if_completed(p.id,p_actor);
    return jsonb_build_object('ok',true,'completed',true,'project_archive',v_archive);
  end if;

  update ops_core.item_stages
  set progress=greatest(coalesce(progress,0),25),
      status='in_progress',
      started_at=coalesce(started_at,now()),
      entered_at=coalesce(entered_at,now()),
      updated_at=now()
  where item_id=i.id and stage_key=nxt.stage_key;

  update ops_core.items
  set current_stage_key=nxt.stage_key,current_status='in_progress',updated_at=now()
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
    jsonb_build_object('actor',p_actor,'initial_progress',25)
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

  return jsonb_build_object('ok',true,'completed',false,'next_stage',nxt.stage_key,'next_sector',nxt.sector_key,'next_progress',25,'handoff_id',v_handoff_id);
end
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
        'in_progress', 25, 'handoff', v_actor_email, v_actor_name
      ) on conflict (region, project_row_id, iso_key, stage_key) do update
        set panel_status = case when ops_core.panel_legacy_stage_advances.panel_progress < 25 then 'in_progress' else ops_core.panel_legacy_stage_advances.panel_status end,
            panel_progress = greatest(ops_core.panel_legacy_stage_advances.panel_progress, 25),
            updated_at = now();
    end if;
  end if;

  return jsonb_build_object(
    'ok', true, 'source', 'tracking_legacy', 'region', v_region,
    'project_row_id', v_project_row_id, 'project_number', v_advance.project_number,
    'iso_key', v_iso_norm, 'stage_key', v_stage_key, 'action', v_action,
    'progress', v_next_progress, 'status', v_next_status,
    'next_stage_key', v_next_stage_key, 'next_stage_label', v_next_stage_label,
    'next_progress', case when v_next_stage_key is null then null else 25 end,
    'updated_at', now()
  );
end;
$$;

revoke all on function ops_core.advance_item_after_stage(uuid,text,uuid,text) from public, anon, authenticated;
grant execute on function ops_core.advance_item_after_stage(uuid,text,uuid,text) to service_role;
revoke all on function ops_core.apply_panel_legacy_stage_action(text,text,text,text,text,text,text,text,text,numeric,text) from public, anon, authenticated;
grant execute on function ops_core.apply_panel_legacy_stage_action(text,text,text,text,text,text,text,text,text,numeric,text) to service_role;
