-- Add DMA/VA to the visible workflow and rename the quality phases without changing legacy keys.
-- The existing scan-initial key already occupies the correct slot between fit-up and welding,
-- so it is renamed in place to preserve item history and stage references.

update ops_core.workflow_stages
set name = case stage_key
  when 'scan-initial' then 'DMA/VA'
  when 'nde' then 'DMF/VF'
  when 'scan-final' then 'END'
  else name
end,
metadata = coalesce(metadata, '{}'::jsonb)
  || case stage_key
    when 'scan-initial' then jsonb_build_object('panel_label', 'DMA/VA')
    when 'nde' then jsonb_build_object('panel_label', 'DMF/VF')
    when 'scan-final' then jsonb_build_object('panel_label', 'END')
    else '{}'::jsonb
  end
where stage_key in ('scan-initial', 'nde', 'scan-final');

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
      when 'fitup' then 'dma_va'
      when 'dma_va' then 'welding'
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
      when 'dma_va' then 'DMA/VA'
      when 'welding' then 'Soldagem'
      when 'quality_visual' then 'DMF/VF'
      when 'quality_dimensional' then 'END'
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
      when 'fitup' then 'dma_va'
      when 'dma_va' then 'welding'
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

revoke all on function ops_core.apply_panel_legacy_stage_action(text,text,text,text,text,text,text,text,text,numeric,text) from public, anon, authenticated;
grant execute on function ops_core.apply_panel_legacy_stage_action(text,text,text,text,text,text,text,text,text,numeric,text) to service_role;

revoke all on function ops_core.undo_panel_legacy_stage_action(text,text,text,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function ops_core.undo_panel_legacy_stage_action(text,text,text,text,text,text,text,text,text) to service_role;

