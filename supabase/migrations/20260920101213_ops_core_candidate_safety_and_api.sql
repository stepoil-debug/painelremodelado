
create or replace function ops_core.is_valid_project_core(value text)
returns boolean
language sql
immutable
as $$
  select coalesce(value,'') ~ '^[0-9]{2}-(?:[0-9]{3,4}|P[0-9]{3})(?:-[0-9A-Z]{1,3}){0,3}$';
$$;

create or replace function ops_core.normalize_sector_key(value text)
returns text
language sql
immutable
as $$
  select case
    when regexp_replace(lower(coalesce(value,'')),'[^a-z0-9]+','','g') like '%calder%' then 'caldeiraria'
    when regexp_replace(lower(coalesce(value,'')),'[^a-z0-9]+','','g') like '%sold%' then 'solda'
    when regexp_replace(lower(coalesce(value,'')),'[^a-z0-9]+','','g') like '%qual%' then 'qualidade'
    when regexp_replace(lower(coalesce(value,'')),'[^a-z0-9]+','','g') like '%inspec%' then 'qualidade'
    when regexp_replace(lower(coalesce(value,'')),'[^a-z0-9]+','','g') like '%pint%' then 'pintura'
    when regexp_replace(lower(coalesce(value,'')),'[^a-z0-9]+','','g') like '%engenh%' then 'engenharia'
    when regexp_replace(lower(coalesce(value,'')),'[^a-z0-9]+','','g') like '%supri%' then 'suprimentos'
    when regexp_replace(lower(coalesce(value,'')),'[^a-z0-9]+','','g') like '%exped%' then 'expedicao'
    when regexp_replace(lower(coalesce(value,'')),'[^a-z0-9]+','','g') like '%pcp%' then 'pcp'
    else null
  end;
$$;

create or replace function ops_core.refresh_registration_candidates()
returns jsonb
language plpgsql
security definer
set search_path=ops_core,ops_panel,public
as $$
declare
  v_upserted integer := 0;
  v_rejected integer := 0;
begin
  with trigger_projects as (
    select
      p.project_core,
      p.display_code,
      'existing_project'::text trigger_source
    from ops_core.projects p
    where p.region='BR' and p.active=true

    union

    select distinct
      ops_core.normalize_project_core(w.project_key),
      w.project_key,
      'wip_active'
    from ops_panel.wip_current w
    where w.project_key is not null
      and ops_core.is_valid_project_core(ops_core.normalize_project_core(w.project_key))
      and upper(coalesce(w.overall_status,'')) not in ('DELIVERED','CANCELLED','MISSING DATA BOOK')
  ),
  valid_triggers as (
    select distinct on (project_core)
      project_core,display_code,trigger_source
    from trigger_projects
    where ops_core.is_valid_project_core(project_core)
    order by project_core,
      case trigger_source when 'existing_project' then 1 else 2 end
  ),
  enriched as (
    select
      t.project_core,
      coalesce(nullif(t.display_code,''),t.project_core) display_code,
      array_remove(array[
        case when p.id is not null then 'legacy_snapshot' end,
        case when w.project_key is not null then 'wip' end,
        case when j.project_key is not null then 'job_order' end,
        case when d.project_key is not null then 'drawing' end
      ],null)::text[] source_systems,
      jsonb_strip_nulls(jsonb_build_object(
        'wip',case when w.project_key is null then null else jsonb_build_object(
          'project_key',w.project_key,'client',w.client,'vessel',w.vessel,'pm',w.pm,
          'customer_po',w.customer_po,'acceptance_date',w.acceptance_date,
          'contractual_date',w.contractual_date,'deadline_date',w.deadline_date,
          'drawing_approval_date',w.drawing_approval_date,'project_status',w.overall_status
        ) end,
        'job_order',case when j.project_key is null then null else jsonb_build_object(
          'project_key',j.project_key,'client',j.client,'pm',j.pm_responsible,
          'po_numbers',j.po_numbers,'project_status',j.project_status
        ) end,
        'drawing',case when d.project_key is null then null else jsonb_build_object(
          'project_key',d.project_key,'client',d.client,'drawing_count',d.drawing_count,
          'latest_revision',d.latest_revision
        ) end
      )) suggested_data,
      p.id project_id,
      p.source_mode
    from valid_triggers t
    left join ops_core.projects p
      on p.region='BR' and p.project_core=t.project_core
    left join lateral (
      select *
      from ops_panel.wip_current x
      where ops_core.normalize_project_core(x.project_key)=t.project_core
      order by x.source_row_id desc
      limit 1
    ) w on true
    left join lateral (
      select *
      from ops_panel.job_order_current x
      where ops_core.normalize_project_core(x.project_key)=t.project_core
      limit 1
    ) j on true
    left join lateral (
      select
        min(project_key) project_key,
        max(client) client,
        count(*) drawing_count,
        max(current_revision) latest_revision
      from ops_panel.drawings_current x
      where ops_core.normalize_project_core(x.project_key)=t.project_core
    ) d on d.project_key is not null
  ),
  upserted as (
    insert into ops_core.registration_candidates(
      region,project_core,display_code,candidate_status,source_systems,
      suggested_data,last_seen_at,validated_project_id
    )
    select
      'BR',e.project_core,e.display_code,
      case when e.source_mode='ops_core' then 'validated' else 'validation_required' end,
      e.source_systems,e.suggested_data,now(),
      case when e.source_mode='ops_core' then e.project_id else null end
    from enriched e
    on conflict(region,project_core) do update
    set display_code=excluded.display_code,
        source_systems=excluded.source_systems,
        suggested_data=excluded.suggested_data,
        last_seen_at=now(),
        candidate_status=case
          when ops_core.registration_candidates.validated_project_id is not null then 'validated'
          else excluded.candidate_status
        end,
        validated_project_id=coalesce(
          ops_core.registration_candidates.validated_project_id,
          excluded.validated_project_id
        )
    returning 1
  )
  select count(*) into v_upserted from upserted;

  update ops_core.registration_candidates c
  set candidate_status='rejected',
      conflicts=coalesce(c.conflicts,'[]'::jsonb) || jsonb_build_array(
        jsonb_build_object(
          'type','historical_or_non_operational_source',
          'message','Registro mantido fora da fila de validação operacional.',
          'detected_at',now()
        )
      )
  where c.region='BR'
    and c.validated_project_id is null
    and c.candidate_status<>'rejected'
    and not exists (
      select 1
      from ops_core.projects p
      where p.region=c.region and p.project_core=c.project_core and p.active=true
    )
    and not exists (
      select 1
      from ops_panel.wip_current w
      where ops_core.normalize_project_core(w.project_key)=c.project_core
        and upper(coalesce(w.overall_status,'')) not in ('DELIVERED','CANCELLED','MISSING DATA BOOK')
    );
  get diagnostics v_rejected=row_count;

  return jsonb_build_object(
    'ok',true,
    'candidates_upserted',v_upserted,
    'historical_rejected',v_rejected,
    'refreshed_at',now()
  );
end $$;

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

  select * into p
  from ops_core.projects
  where region=upper(coalesce(nullif(u.region,''),'BR'))
    and project_core=ops_core.normalize_project_core(u.project_number)
    and source_mode='ops_core'
  limit 1;
  if not found then return jsonb_build_object('ok',false,'reason','project-not-cutover'); end if;

  select * into i
  from ops_core.items
  where project_id=p.id
    and removed_from_scope=false
    and (
      ops_core.normalize_item_key(iso_code)=ops_core.normalize_item_key(u.spool_iso)
      or ops_core.normalize_item_key(drawing_code)=ops_core.normalize_item_key(u.spool_iso)
      or item_key=ops_core.normalize_item_key(u.spool_iso)
    )
  limit 1;
  if not found then return jsonb_build_object('ok',false,'reason','item-not-found'); end if;

  v_sector:=ops_core.normalize_sector_key(u.sector);
  if v_sector is null then
    return jsonb_build_object('ok',false,'reason','sector-not-mapped','sector',u.sector);
  end if;

  select st.id,st.stage_key,st.progress
  into s
  from ops_core.item_stages st
  join ops_core.workflow_stages w on w.stage_key=st.stage_key
  where st.item_id=i.id
    and st.is_applicable=true
    and st.status<>'completed'
    and w.sector_key=v_sector
  order by st.stage_order
  limit 1;

  if not found then return jsonb_build_object('ok',false,'reason','sector-stage-not-found'); end if;

  v_progress:=greatest(0,least(100,coalesce(u.progress,0)));

  insert into ops_core.stage_events(
    project_id,item_id,item_stage_id,event_type,stage_key,sector_key,
    progress_from,progress_to,actor_email,actor_name,source_system,source_event_id,payload
  )
  values(
    p.id,i.id,s.id,
    case when v_progress>=100 then 'stage.completed' else 'stage.progress_changed' end,
    s.stage_key,v_sector,s.progress,v_progress,u.created_by,u.created_by_name,
    'stage_updates',u.id,to_jsonb(u)
  )
  on conflict(source_system,source_event_id) do update
    set payload=excluded.payload
  returning id into v_event_id;

  update ops_core.item_stages
  set progress=v_progress,
      status=case
        when v_progress>=100 then 'completed'
        when v_progress>0 then 'in_progress'
        else status
      end,
      actual_date=case when v_progress>=100 then coalesce(u.completion_date,current_date) else actual_date end,
      completed_at=case when v_progress>=100 then coalesce(u.resolved_at,u.updated_at,now()) else completed_at end,
      source_system='stage_updates',
      source_ref=u.id,
      updated_by=u.created_by_name,
      updated_at=now(),
      metadata=metadata || jsonb_build_object(
        'note',u.note,
        'resolution_note',u.resolution_note
      )
  where id=s.id;

  perform ops_core.recompute_item_progress(i.id);

  if v_progress>=100 then
    perform ops_core.advance_item_after_stage(
      i.id,s.stage_key,v_event_id,coalesce(u.created_by_name,'stage_updates')
    );
  else
    update ops_core.items
    set current_stage_key=s.stage_key,
        current_status='in_progress',
        updated_at=now()
    where id=i.id;
  end if;

  return jsonb_build_object(
    'ok',true,
    'project_id',p.id,
    'item_id',i.id,
    'stage_key',s.stage_key,
    'progress',v_progress
  );
end $$;

create or replace function public.ops_core_list_candidates(
  p_status text default 'validation_required',
  p_limit integer default 200
)
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core
as $$
select coalesce(
  jsonb_agg(to_jsonb(q) order by q.last_seen_at desc,q.project_core),
  '[]'::jsonb
)
from (
  select
    c.*,
    p.source_mode,
    p.validation_status,
    p.client,
    p.vessel,
    p.pm,
    p.project_status,
    (select count(*) from ops_core.items i where i.project_id=p.id and not i.removed_from_scope) item_count,
    (select count(*) from ops_core.documents d where d.project_id=p.id) document_count
  from ops_core.registration_candidates c
  left join ops_core.projects p
    on p.region=c.region and p.project_core=c.project_core
  where ops_core.is_valid_project_core(c.project_core)
    and (
      p_status is null
      or p_status=''
      or c.candidate_status=p_status
    )
  order by c.last_seen_at desc,c.project_core
  limit greatest(1,least(coalesce(p_limit,200),1000))
) q;
$$;

create or replace function public.ops_core_project_validation_report(p_project_key text)
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core
as $$
with p as (
  select *
  from ops_core.projects
  where region='BR'
    and project_core=ops_core.normalize_project_core(p_project_key)
  limit 1
),
stats as (
  select
    count(*) item_count,
    count(*) filter(where i.weight_kg is null) missing_weight,
    count(*) filter(where i.material is null or btrim(i.material)='') missing_material,
    count(*) filter(where i.item_type='OTHER') unclassified_items,
    count(*) filter(where not exists(
      select 1 from ops_core.item_stages s where s.item_id=i.id
    )) items_without_workflow
  from ops_core.items i
  join p on i.project_id=p.id
  where not i.removed_from_scope
),
docs as (
  select
    count(*) document_count,
    count(*) filter(where current_revision is null or current_revision='UNSPECIFIED') missing_revision,
    count(*) filter(where source_row_id is not null) source_linked
  from ops_core.documents d
  join p on d.project_id=p.id
)
select jsonb_build_object(
  'project',(select to_jsonb(p) from p),
  'items',to_jsonb(stats),
  'documents',to_jsonb(docs),
  'blocking_issues',jsonb_build_array(
    case when (select item_count from stats)=0 then 'Projeto sem itens.' end,
    case when (select items_without_workflow from stats)>0 then 'Há itens sem workflow.' end
  ) - null,
  'warnings',jsonb_build_object(
    'missing_weight',(select missing_weight from stats),
    'missing_material',(select missing_material from stats),
    'unclassified_items',(select unclassified_items from stats),
    'documents_without_revision',(select missing_revision from docs)
  ),
  'ready_for_cutover',(
    (select item_count from stats)>0
    and (select items_without_workflow from stats)=0
  ),
  'generated_at',now()
)
from stats,docs;
$$;

create or replace function public.ops_core_cutover_project(
  p_project_key text,
  p_actor text
)
returns jsonb
language sql
security definer
set search_path=public,ops_core
as $$
  select ops_core.project_cutover(p_project_key,p_actor);
$$;

create or replace function public.ops_core_revert_project(
  p_project_key text,
  p_actor text
)
returns jsonb
language sql
security definer
set search_path=public,ops_core
as $$
  select ops_core.project_revert_to_legacy(p_project_key,p_actor);
$$;

create or replace function public.ops_core_refresh_registration()
returns jsonb
language sql
security definer
set search_path=public,ops_core
as $$
  select ops_core.refresh_registration_candidates();
$$;

create or replace function public.ops_core_refresh_legacy_snapshot()
returns jsonb
language sql
security definer
set search_path=public,ops_core
as $$
  select ops_core.bootstrap_tracking_snapshot('BR');
$$;

revoke all on function public.ops_core_list_candidates(text,integer) from public,anon,authenticated;
revoke all on function public.ops_core_project_validation_report(text) from public,anon,authenticated;
revoke all on function public.ops_core_cutover_project(text,text) from public,anon,authenticated;
revoke all on function public.ops_core_revert_project(text,text) from public,anon,authenticated;
revoke all on function public.ops_core_refresh_registration() from public,anon,authenticated;
revoke all on function public.ops_core_refresh_legacy_snapshot() from public,anon,authenticated;

grant execute on function public.ops_core_get_demands(text,integer) to service_role;
grant execute on function public.ops_core_search_demands(text,text,integer) to service_role;
grant execute on function public.ops_core_migration_status() to service_role;
grant execute on function public.ops_core_project_detail(text) to service_role;
grant execute on function public.ops_core_list_candidates(text,integer) to service_role;
grant execute on function public.ops_core_project_validation_report(text) to service_role;
grant execute on function public.ops_core_cutover_project(text,text) to service_role;
grant execute on function public.ops_core_revert_project(text,text) to service_role;
grant execute on function public.ops_core_refresh_registration() to service_role;
grant execute on function public.ops_core_refresh_legacy_snapshot() to service_role;

select ops_core.refresh_registration_candidates();
