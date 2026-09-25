create or replace function ops_core.archive_legacy_tracking_project_if_completed(
  p_project_id uuid,
  p_actor text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,ops_panel,public
as $$
declare
  p ops_core.projects%rowtype;
  v_finished boolean:=false;
  v_item_count integer:=0;
  v_project_finish_date date;
  v_last_finish date;
  v_completed_at timestamptz;
  v_candidate_count integer:=0;
begin
  select * into p
  from ops_core.projects
  where id=p_project_id
  for update;

  if not found then
    return jsonb_build_object('ok',false,'reason','project-not-found');
  end if;

  if p.source_mode<>'legacy_tracking' or not p.active then
    return jsonb_build_object(
      'ok',true,
      'archived',p.source_mode='archived',
      'reason','not-active-legacy-tracking'
    );
  end if;

  select
    count(*)::integer,
    coalesce(bool_and(coalesce(t.project_finished,false)),false),
    max(t.project_finish_date),
    max(t.finish_date)
  into v_item_count,v_finished,v_project_finish_date,v_last_finish
  from ops_panel.tracking_current_items t
  where ops_core.normalize_project_core(t.project_key)=p.project_core;

  if v_item_count=0 or not v_finished then
    return jsonb_build_object(
      'ok',true,
      'archived',false,
      'project_core',p.project_core,
      'items',v_item_count,
      'reason','tracking-project-not-finished'
    );
  end if;

  v_completed_at:=coalesce(v_project_finish_date::timestamptz,v_last_finish::timestamptz,now());

  -- The ops_core mirror is frozen as a historical snapshot before the
  -- project is removed from the operational demand feed.
  update ops_core.items
  set current_stage_key='completed',
      current_status='completed',
      overall_progress=100,
      completed_at=coalesce(completed_at,v_completed_at),
      updated_at=now()
  where project_id=p.id
    and not removed_from_scope;

  update ops_core.projects
  set source_mode='archived',
      project_status='ARCHIVED',
      active=false,
      completed_at=coalesce(completed_at,v_completed_at),
      archived_at=coalesce(archived_at,now()),
      archived_by=coalesce(nullif(p_actor,''),'system'),
      archive_reason=coalesce(archive_reason,'AUTO_TRACKING_PROJECT_FINISHED'),
      reporting_year=extract(year from v_completed_at)::integer,
      updated_at=now()
  where id=p.id;

  update ops_core.handoffs
  set status='completed',
      completed_at=coalesce(completed_at,now())
  where project_id=p.id
    and status in ('available','accepted');

  update ops_core.notifications
  set resolved_at=coalesce(resolved_at,now())
  where project_id=p.id
    and resolved_at is null;

  update ops_core.registration_candidates c
  set candidate_status='rejected',
      suggested_data=coalesce(c.suggested_data,'{}'::jsonb)||jsonb_build_object(
        'history_check',jsonb_build_object(
          'classification','finalized_current_tracking',
          'checked_at',now(),
          'current_tracking',true
        )
      ),
      conflicts=coalesce(c.conflicts,'[]'::jsonb)||jsonb_build_array(
        jsonb_build_object(
          'type','historical_finalized',
          'message','BSP finalizada no Tracking atual e movida para Arquivados.',
          'completed_on',v_completed_at::date,
          'detected_at',now()
        )
      )
  where c.region=p.region
    and c.project_core=p.project_core
    and c.validated_project_id is null
    and c.candidate_status<>'rejected';
  get diagnostics v_candidate_count=row_count;

  insert into ops_core.audit_events(
    project_id,entity_type,entity_id,action,actor_email,source_system,
    before_data,after_data,metadata
  ) values(
    p.id,'project',p.id::text,'project.auto_archived',
    coalesce(nullif(p_actor,''),'system'),'tracking',
    jsonb_build_object(
      'source_mode',p.source_mode,
      'project_status',p.project_status,
      'active',p.active
    ),
    jsonb_build_object(
      'source_mode','archived',
      'project_status','ARCHIVED',
      'completed_at',v_completed_at,
      'reporting_year',extract(year from v_completed_at)::integer
    ),
    jsonb_build_object(
      'reason','tracking-project-finished',
      'items',v_item_count,
      'registration_candidates_rejected',v_candidate_count
    )
  );

  return jsonb_build_object(
    'ok',true,
    'archived',true,
    'project_id',p.id,
    'project_core',p.project_core,
    'items',v_item_count,
    'completed_at',v_completed_at,
    'registration_candidates_rejected',v_candidate_count
  );
end;
$$;

create or replace function ops_core.archive_completed_legacy_tracking_projects(
  p_actor text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,ops_panel,public
as $$
declare
  r record;
  v_result jsonb;
  v_results jsonb:='[]'::jsonb;
  v_archived integer:=0;
  v_candidates_rejected integer:=0;
begin
  for r in
    select p.id
    from ops_core.projects p
    join lateral (
      select
        count(*) item_count,
        coalesce(bool_and(coalesce(t.project_finished,false)),false) all_finished
      from ops_panel.tracking_current_items t
      where ops_core.normalize_project_core(t.project_key)=p.project_core
    ) t on true
    where p.region='BR'
      and p.active=true
      and p.source_mode='legacy_tracking'
      and t.item_count>0
      and t.all_finished
    order by p.project_core
  loop
    v_result:=ops_core.archive_legacy_tracking_project_if_completed(r.id,p_actor);
    v_results:=v_results||jsonb_build_array(v_result);
    if coalesce((v_result->>'archived')::boolean,false) then
      v_archived:=v_archived+1;
      v_candidates_rejected:=v_candidates_rejected+coalesce((v_result->>'registration_candidates_rejected')::integer,0);
    end if;
  end loop;

  -- Candidates without a materialized project must not keep finalized current
  -- Tracking BSPs in the validation queue.
  with finished_current as (
    select ops_core.normalize_project_core(t.project_key) project_core
    from ops_panel.tracking_current_items t
    where ops_core.normalize_project_core(t.project_key) is not null
    group by ops_core.normalize_project_core(t.project_key)
    having bool_and(coalesce(t.project_finished,false))
  )
  update ops_core.registration_candidates c
  set candidate_status='rejected',
      suggested_data=coalesce(c.suggested_data,'{}'::jsonb)||jsonb_build_object(
        'history_check',jsonb_build_object(
          'classification','finalized_current_tracking',
          'checked_at',now(),
          'current_tracking',true
        )
      ),
      conflicts=coalesce(c.conflicts,'[]'::jsonb)||jsonb_build_array(
        jsonb_build_object(
          'type','historical_finalized',
          'message','BSP finalizada no Tracking atual e mantida fora da fila de cadastro.',
          'detected_at',now()
        )
      )
  from finished_current f
  where c.region='BR'
    and c.project_core=f.project_core
    and c.validated_project_id is null
    and c.candidate_status<>'rejected';
  get diagnostics v_candidates_rejected=row_count;

  return jsonb_build_object(
    'ok',true,
    'archived_projects',v_archived,
    'registration_candidates_rejected',v_candidates_rejected,
    'projects',v_results,
    'refreshed_at',now()
  );
end;
$$;

create or replace function public.ops_core_refresh_registration()
returns jsonb
language plpgsql
security definer
set search_path=public,ops_core
as $$
declare
  v_archive jsonb;
  v_base jsonb;
  v_fcb jsonb;
begin
  v_base:=ops_core.refresh_registration_candidates();
  v_fcb:=ops_core.enforce_fcb_first_registration();
  -- Run the archive cleanup last: candidate refresh can discover a finished
  -- Tracking BSP before the project is removed from the operational queue.
  v_archive:=ops_core.archive_completed_legacy_tracking_projects('system:registration-refresh');
  return jsonb_build_object(
    'ok',true,
    'legacy_archive',v_archive,
    'base',v_base,
    'fcb_first',v_fcb,
    'refreshed_at',now()
  );
end;
$$;

grant execute on function ops_core.archive_legacy_tracking_project_if_completed(uuid,text) to service_role;
grant execute on function ops_core.archive_completed_legacy_tracking_projects(text) to service_role;
grant execute on function public.ops_core_refresh_registration() to service_role;

select public.ops_core_refresh_registration();
select ops_core.refresh_demand_feed_cache();
