create or replace function ops_core.hold_restore_stage_key(p_status text)
returns text
language sql
immutable
as $$
  select case
    when lower(coalesce(p_status, '')) like '%fabrication not started%' then 'drawing'
    when lower(coalesce(p_status, '')) like '%material separation%'
      or lower(coalesce(p_status, '')) like '%procurement%' then 'material'
    when lower(coalesce(p_status, '')) like '%spool assemble%'
      or lower(coalesce(p_status, '')) like '%welding preparation%' then 'preassembly'
    when lower(coalesce(p_status, '')) like '%full welding%'
      or lower(coalesce(p_status, '')) like '%welding execution%' then 'welding'
    when lower(coalesce(p_status, '')) like '%hydro test%' then 'hydro'
    when lower(coalesce(p_status, '')) like '%package and delivered%'
      or lower(coalesce(p_status, '')) like '%expedi%' then 'package'
    when lower(coalesce(p_status, '')) like '%inspeção dimensional inicial%'
      or lower(coalesce(p_status, '')) like '%inspecao dimensional inicial%'
      or lower(coalesce(p_status, '')) like '%scan inicial%' then 'scan-initial'
    when lower(coalesce(p_status, '')) like '%inspeção dimensional%'
      or lower(coalesce(p_status, '')) like '%inspecao dimensional%'
      or lower(coalesce(p_status, '')) like '%3d%' then 'scan-final'
    when lower(coalesce(p_status, '')) like '%end%'
      or lower(coalesce(p_status, '')) like '%nde%'
      or lower(coalesce(p_status, '')) like '%visual%' then 'nde'
    when lower(coalesce(p_status, '')) like '%pintura%'
      or lower(coalesce(p_status, '')) like '%hdg%'
      or lower(coalesce(p_status, '')) like '%fbe%' then 'painting'
    else null
  end;
$$;

create or replace function public.ops_core_set_project_operational_status(
  p_on_hold boolean,
  p_project_core text default null,
  p_project_id uuid default null,
  p_item_id uuid default null,
  p_actor_email text default null,
  p_actor_name text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, ops_core
as $$
declare
  v_project ops_core.projects%rowtype;
  v_item record;
  v_before text;
  v_after text := case when p_on_hold then 'ON HOLD' else 'ONGOING' end;
  v_event_count integer := 0;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
  v_base_status text;
  v_restore_stage text;
  v_restore_status text;
  v_event_stage text;
  v_event_stage_id uuid;
  v_needs_item_reconciliation boolean := false;
begin
  select p.*
    into v_project
  from ops_core.projects p
  where (
    p_project_id is not null
    and p.id = p_project_id
  )
  or (
    p_item_id is not null
    and exists (
      select 1
      from ops_core.items i
      where i.id = p_item_id
        and i.project_id = p.id
    )
  )
  or (
    nullif(btrim(p_project_core), '') is not null
    and regexp_replace(upper(coalesce(p.project_core, '')), '[^A-Z0-9]', '', 'g') =
        regexp_replace(upper(btrim(p_project_core)), '[^A-Z0-9]', '', 'g')
  )
  order by case when p.source_mode = 'ops_core' then 0 else 1 end, p.updated_at desc nulls last
  limit 1
  for update;

  if not found then
    raise exception 'BSP não encontrada no OPS Core.';
  end if;

  if v_project.source_mode not in ('ops_core', 'legacy_tracking') then
    raise exception 'A BSP ainda não está disponível para controle operacional no painel.';
  end if;

  v_before := upper(btrim(coalesce(v_project.project_status, '')));

  select exists (
    select 1
    from ops_core.items i
    where i.project_id = v_project.id
      and not i.removed_from_scope
      and (
        (p_on_hold and lower(coalesce(i.current_stage_key, '')) <> 'on hold')
        or (not p_on_hold and lower(coalesce(i.current_stage_key, '')) = 'on hold')
      )
  )
  into v_needs_item_reconciliation;

  if v_before = v_after and not v_needs_item_reconciliation then
    return jsonb_build_object(
      'ok', true,
      'changed', false,
      'project_id', v_project.id,
      'project_core', v_project.project_core,
      'status', v_after,
      'updated_at', v_project.updated_at
    );
  end if;

  update ops_core.projects
  set project_status = v_after,
      updated_at = now()
  where id = v_project.id;

  for v_item in
    select i.*
    from ops_core.items i
    where i.project_id = v_project.id
      and not i.removed_from_scope
    for update
  loop
    v_base_status := nullif(btrim(split_part(coalesce(v_item.current_status, ''), '·', 1)), '');
    if upper(coalesce(v_base_status, '')) in ('ON HOLD', 'ONGOING') then
      v_base_status := null;
    end if;

    v_restore_stage := nullif(v_item.source_metadata #>> '{panel_hold,stage_key}', '');
    v_restore_status := nullif(v_item.source_metadata #>> '{panel_hold,status}', '');
    if v_restore_stage is null then
      v_restore_stage := ops_core.hold_restore_stage_key(v_base_status);
    end if;
    if v_restore_status is null then
      v_restore_status := v_base_status;
    end if;

    if p_on_hold then
      v_event_stage := nullif(v_item.current_stage_key, '');
      if lower(coalesce(v_event_stage, '')) = 'on hold' then
        v_event_stage := coalesce(v_restore_stage, 'on_hold');
      end if;

      update ops_core.items
      set current_stage_key = 'On Hold',
          current_status = case
            when v_restore_status is not null then v_restore_status || ' · ON HOLD'
            else 'On Hold'
          end,
          source_metadata = source_metadata || jsonb_build_object(
            'panel_hold', jsonb_build_object(
              'stage_key', coalesce(v_event_stage, 'on_hold'),
              'status', v_restore_status,
              'held_at', now()
            )
          ),
          updated_at = now()
      where id = v_item.id;
    else
      v_event_stage := coalesce(v_restore_stage, nullif(v_item.current_stage_key, ''));
      if lower(coalesce(v_event_stage, '')) = 'on hold' then
        v_event_stage := null;
      end if;

      update ops_core.items
      set current_stage_key = coalesce(v_event_stage, current_stage_key),
          current_status = coalesce(v_restore_status, nullif(regexp_replace(current_status, '\s*·\s*ON HOLD', '', 'gi'), ''), current_status),
          source_metadata = source_metadata - 'panel_hold',
          updated_at = now()
      where id = v_item.id;
    end if;

    select s.id
      into v_event_stage_id
    from ops_core.item_stages s
    where s.item_id = v_item.id
      and s.stage_key = coalesce(v_event_stage, 'on_hold')
    limit 1;

    insert into ops_core.stage_events(
      project_id,
      item_id,
      item_stage_id,
      event_type,
      stage_key,
      sector_key,
      progress_from,
      progress_to,
      actor_email,
      actor_name,
      source_system,
      source_event_id,
      payload
    ) values (
      v_project.id,
      v_item.id,
      v_event_stage_id,
      case when p_on_hold then 'project.on_hold' else 'project.ongoing' end,
      coalesce(v_event_stage, 'project_status'),
      coalesce((select w.sector_key from ops_core.workflow_stages w where w.stage_key = v_event_stage), 'nao_classificado'),
      v_item.overall_progress,
      v_item.overall_progress,
      nullif(btrim(coalesce(p_actor_email, '')), ''),
      nullif(btrim(coalesce(p_actor_name, p_actor_email, '')), ''),
      'ops_core',
      gen_random_uuid()::text,
      jsonb_build_object(
        'note', v_note,
        'status_from', v_before,
        'status_to', v_after,
        'action', case when p_on_hold then 'on_hold' else 'ongoing' end,
        'restored_stage', v_event_stage
      )
    );
    v_event_count := v_event_count + 1;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'changed', true,
    'project_id', v_project.id,
    'project_core', v_project.project_core,
    'status_from', v_before,
    'status', v_after,
    'event_count', v_event_count,
    'updated_at', now()
  );
end;
$$;

revoke all on function public.ops_core_set_project_operational_status(boolean, text, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.ops_core_set_project_operational_status(boolean, text, uuid, uuid, text, text, text) to service_role;
