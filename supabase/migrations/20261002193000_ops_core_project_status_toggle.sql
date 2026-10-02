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

  if v_before = v_after then
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
    select
      i.id as item_id,
      i.current_stage_key,
      s.id as item_stage_id,
      coalesce(s.progress, 0) as progress,
      coalesce(w.sector_key, 'nao_classificado') as sector_key
    from ops_core.items i
    left join lateral (
      select st.id, st.progress
      from ops_core.item_stages st
      where st.item_id = i.id
        and st.stage_key = i.current_stage_key
      limit 1
    ) s on true
    left join ops_core.workflow_stages w on w.stage_key = i.current_stage_key
    where i.project_id = v_project.id
      and not i.removed_from_scope
  loop
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
      v_item.item_id,
      v_item.item_stage_id,
      case when p_on_hold then 'project.on_hold' else 'project.ongoing' end,
      coalesce(v_item.current_stage_key, 'project_status'),
      v_item.sector_key,
      v_item.progress,
      v_item.progress,
      nullif(btrim(coalesce(p_actor_email, '')), ''),
      nullif(btrim(coalesce(p_actor_name, p_actor_email, '')), ''),
      'ops_core',
      gen_random_uuid()::text,
      jsonb_build_object(
        'note', v_note,
        'status_from', v_before,
        'status_to', v_after,
        'action', case when p_on_hold then 'on_hold' else 'ongoing' end
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
