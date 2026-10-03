create or replace function ops_core.register_candidate_automatically(
  p_project_core text,
  p_actor text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,public
as $$
declare
  v_materialized jsonb;
  v_report jsonb;
  v_project_id uuid;
  v_ready boolean:=false;
  v_complete boolean:=false;
begin
  v_materialized:=ops_core.materialize_candidate(p_project_core,p_actor);
  v_report:=public.ops_core_project_validation_report(p_project_core);
  v_ready:=coalesce((v_report->>'ready_for_cutover')::boolean,false);
  v_complete:=v_ready and jsonb_array_length(coalesce(v_report->'non_blocking_warnings','[]'::jsonb))=0;

  select id into v_project_id
  from ops_core.projects
  where region='BR' and project_core=ops_core.normalize_project_core(p_project_core)
  limit 1;

  update ops_core.projects
  set validation_status=case when v_complete then 'validated' else 'validation_required' end,
      source_metadata=coalesce(source_metadata,'{}'::jsonb)||jsonb_build_object(
        'registration_state',case when v_complete then 'registered' else 'registered_with_pending_information' end,
        'registration_checked_at',now(),
        'registration_actor',coalesce(nullif(p_actor,''),'system'),
        'technical_authority','FCB',
        'panel_mode','observation',
        'panel_mutation_allowed',false
      ),
      updated_at=now()
  where id=v_project_id;

  update ops_core.registration_candidates
  set candidate_status=case when v_complete then 'validated' else 'validation_required' end,
      validated_project_id=v_project_id,
      last_seen_at=now()
  where region='BR' and project_core=ops_core.normalize_project_core(p_project_core);

  return jsonb_build_object(
    'ok',true,
    'registered',true,
    'activated',false,
    'observation_mode',true,
    'awaiting_fcb',false,
    'ready_for_activation',v_ready,
    'complete',v_complete,
    'pending_information',not v_complete,
    'materialized',v_materialized,
    'report',v_report
  );
end $$;

create or replace function ops_core.enforce_fcb_first_registration()
returns jsonb
language plpgsql
security definer
set search_path=ops_core,ops_panel,public
as $$
declare
  r record;
  v_profile jsonb;
  v_tracking jsonb;
  v_registration jsonb;
  v_detected integer := 0;
  v_registered integer := 0;
  v_pending integer := 0;
  v_waiting integer := 0;
begin
  for r in
    select distinct ops_core.normalize_project_core(d.project_key) project_core
    from ops_panel.drawings_current d
    where d.is_fcb=true
      and ops_core.is_valid_project_core(ops_core.normalize_project_core(d.project_key))
  loop
    v_profile:=ops_core.refresh_fcb_project_profile(r.project_core);
    v_tracking:=ops_core.refresh_project_tracking_validation(r.project_core);

    update ops_core.registration_candidates c
    set source_systems=array(select distinct unnest(array_append(coalesce(c.source_systems,'{}'::text[]),'fcb')) order by 1),
        suggested_data=coalesce(c.suggested_data,'{}'::jsonb)||jsonb_build_object(
          'fcb',v_profile||jsonb_build_object('status','detected'),
          'tracking_validation',v_tracking,
          'technical_authority','FCB',
          'panel_mode',jsonb_build_object('mode','observation','panel_mutation_allowed',false,'checked_at',now()),
          'detection',jsonb_build_object(
            'new_project',not exists(select 1 from ops_core.projects p where p.region=c.region and p.project_core=c.project_core and p.active),
            'source','fcb','checked_current_tracking',true,
            'detected_at',coalesce(c.suggested_data #>> '{detection,detected_at}',now()::text)
          ),
          'fcb_first',true
        ),
        last_seen_at=now()
    where c.region='BR' and c.project_core=r.project_core;

    if exists(select 1 from ops_core.registration_candidates c where c.region='BR' and c.project_core=r.project_core) then
      v_registration:=ops_core.register_candidate_automatically(r.project_core,'system');
      if coalesce((v_registration->>'complete')::boolean,false) then
        v_registered:=v_registered+1;
      else
        v_pending:=v_pending+1;
      end if;
    end if;
    v_detected:=v_detected+1;
  end loop;

  update ops_core.registration_candidates c
  set suggested_data=coalesce(c.suggested_data,'{}'::jsonb)||jsonb_build_object(
        'fcb',jsonb_build_object('status','awaiting_fcb','checked_at',now(),'source','drawing_documentation_control'),
        'technical_authority','FCB','fcb_first',true,
        'panel_mode',jsonb_build_object('mode','observation','panel_mutation_allowed',false,'checked_at',now())
      ),
      candidate_status='validation_required',last_seen_at=now()
  where c.region='BR'
    and c.validated_project_id is null
    and 'drawing'=any(coalesce(c.source_systems,'{}'::text[]))
    and not exists(select 1 from ops_panel.drawings_current d where d.is_fcb=true and ops_core.normalize_project_core(d.project_key)=c.project_core);
  get diagnostics v_waiting=row_count;

  return jsonb_build_object('ok',true,'fcb_projects',v_detected,'auto_registered',v_registered,'pending_information',v_pending,'awaiting_fcb',v_waiting,'refreshed_at',now());
end;
$$;

grant execute on function ops_core.enforce_fcb_first_registration() to service_role;
