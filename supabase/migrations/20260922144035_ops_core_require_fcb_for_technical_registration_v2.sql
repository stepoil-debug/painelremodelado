
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
  v_core text:=ops_core.normalize_project_core(p_project_core);
  v_fcb jsonb;
  v_has_fcb boolean:=false;
  v_existing uuid;
  v_materialized jsonb;
  v_report jsonb;
  v_cutover jsonb;
  v_ready boolean:=false;
begin
  v_fcb:=public.ops_core_fcb_status(v_core);
  v_has_fcb:=coalesce((v_fcb->>'has_fcb')::boolean,false);

  select id into v_existing
  from ops_core.projects
  where region='BR' and project_core=v_core
  limit 1;

  if not v_has_fcb then
    update ops_core.registration_candidates
    set
      candidate_status='validation_required',
      suggested_data=coalesce(suggested_data,'{}'::jsonb)
        || jsonb_build_object(
          'fcb',
          jsonb_build_object(
            'status','awaiting_fcb',
            'checked_at',now(),
            'source','drawing_documentation_control'
          )
        ),
      last_seen_at=now()
    where region='BR' and project_core=v_core;

    if v_existing is not null then
      update ops_core.projects
      set
        validation_status='validation_required',
        source_metadata=coalesce(source_metadata,'{}'::jsonb)
          || jsonb_build_object(
            'technical_authority','FCB',
            'fcb_status','awaiting_fcb',
            'provisional_drawing_items',true
          ),
        updated_at=now()
      where id=v_existing;

      update ops_core.items
      set
        source_metadata=coalesce(source_metadata,'{}'::jsonb)
          || jsonb_build_object(
            'technical_authority','DRAWING_PROVISIONAL',
            'awaiting_fcb',true
          ),
        updated_at=now()
      where project_id=v_existing
        and not removed_from_scope;
    end if;

    return jsonb_build_object(
      'ok',true,
      'registered',v_existing is not null,
      'activated',false,
      'awaiting_fcb',true,
      'fcb',v_fcb,
      'message','FCB vigente ainda não disponível. Nenhum dado provisório será tratado como cadastro técnico final.'
    );
  end if;

  v_materialized:=ops_core.materialize_candidate(v_core,p_actor);

  update ops_core.projects
  set
    validation_status='validation_required',
    source_metadata=coalesce(source_metadata,'{}'::jsonb)
      || jsonb_build_object(
        'technical_authority','FCB',
        'fcb_status','detected',
        'fcb_revision',v_fcb->>'latest_revision',
        'fcb_source_row_id',v_fcb->>'latest_source_row_id'
      ),
    updated_at=now()
  where region='BR' and project_core=v_core;

  v_report:=public.ops_core_project_validation_report(v_core);
  v_ready:=coalesce((v_report->>'ready_for_cutover')::boolean,false);

  if v_ready then
    v_cutover:=ops_core.project_cutover(v_core,p_actor);
    return jsonb_build_object(
      'ok',true,
      'registered',true,
      'activated',true,
      'awaiting_fcb',false,
      'materialized',v_materialized,
      'report',v_report,
      'cutover',v_cutover,
      'fcb',v_fcb
    );
  end if;

  return jsonb_build_object(
    'ok',true,
    'registered',true,
    'activated',false,
    'awaiting_fcb',false,
    'fcb_detected',true,
    'materialized',v_materialized,
    'report',v_report,
    'fcb',v_fcb
  );
end $$;
