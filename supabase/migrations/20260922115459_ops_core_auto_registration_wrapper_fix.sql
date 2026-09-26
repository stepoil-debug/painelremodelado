
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
  v_cutover jsonb;
  v_ready boolean:=false;
begin
  v_materialized:=ops_core.materialize_candidate(p_project_core,p_actor);
  v_report:=public.ops_core_project_validation_report(p_project_core);
  v_ready:=coalesce((v_report->>'ready_for_cutover')::boolean,false);

  if v_ready then
    v_cutover:=ops_core.project_cutover(p_project_core,p_actor);
    return jsonb_build_object(
      'ok',true,
      'registered',true,
      'activated',true,
      'materialized',v_materialized,
      'report',v_report,
      'cutover',v_cutover
    );
  end if;

  update ops_core.registration_candidates
  set candidate_status='reconciled',last_seen_at=now()
  where region='BR' and project_core=ops_core.normalize_project_core(p_project_core);

  return jsonb_build_object(
    'ok',true,
    'registered',true,
    'activated',false,
    'pending_detail',true,
    'materialized',v_materialized,
    'report',v_report
  );
end $$;
