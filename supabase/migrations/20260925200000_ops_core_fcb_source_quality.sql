create or replace function public.ops_core_fcb_sources(p_project_key text)
returns jsonb
language sql
stable
security definer
set search_path = public, ops_core, ops_panel
as $$
  select coalesce(jsonb_agg(to_jsonb(q) order by q.source_row_id), '[]'::jsonb)
  from (
    select
      d.source_row_id,
      d.source_version,
      d.project_key,
      d.drawing_number,
      d.document_title,
      d.current_revision,
      d.current_status,
      d.raw_cells->>'UNIT' as unit,
      d.synced_at
    from ops_panel.drawings_current d
    where ops_core.normalize_project_core(d.project_key)=ops_core.normalize_project_core(p_project_key)
      and ops_core.is_valid_project_core(ops_core.normalize_project_core(d.project_key))
      and (
        coalesce(d.is_fcb,false)
        or ops_core.detect_fcb_text(concat_ws(' ', d.drawing_number, d.document_title, d.raw_cells->>'UNIT'))
        or upper(coalesce(d.drawing_number,'')) ~ '(^|[- _])(FCB|ISO|SUP|STR)([- _]|$)'
           and ops_core.detect_fcb_text(coalesce(d.document_title,''))
      )
      and upper(coalesce(d.document_title,'')) not like '%CANCEL%'
      and upper(coalesce(d.current_status,'')) not in ('CANCELLED','CANCELED')
  ) q;
$$;

revoke all on function public.ops_core_fcb_sources(text) from public, anon, authenticated;
grant execute on function public.ops_core_fcb_sources(text) to service_role;

create or replace function ops_core.enforce_fcb_first_registration()
returns jsonb
language plpgsql
security definer
set search_path = ops_core, ops_panel, public
as $$
declare
  r record;
  v_profile jsonb;
  v_tracking jsonb;
  v_registration jsonb;
  v_detected integer:=0;
  v_registered integer:=0;
  v_pending integer:=0;
  v_waiting integer:=0;
begin
  for r in
    select distinct project_core
    from (
      select ops_core.normalize_project_core(d.project_key) project_core
      from ops_panel.drawings_current d
      where d.is_fcb=true

      union

      select ops_core.normalize_project_core(i.project_core) project_core
      from ops_core.fcb_ingestions i
      where i.is_current=true
        and i.status in ('parsed','applied','validated')
    ) detected
    where ops_core.is_valid_project_core(project_core)
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
    and ops_core.is_valid_project_core(c.project_core)
    and 'drawing'=any(coalesce(c.source_systems,'{}'::text[]))
    and not exists(select 1 from ops_panel.drawings_current d where d.is_fcb=true and ops_core.normalize_project_core(d.project_key)=c.project_core)
    and not exists(select 1 from ops_core.fcb_ingestions i where i.is_current=true and i.status in ('parsed','applied','validated') and ops_core.normalize_project_core(i.project_core)=c.project_core);
  get diagnostics v_waiting=row_count;

  return jsonb_build_object('ok',true,'fcb_projects',v_detected,'auto_registered',v_registered,'pending_information',v_pending,'awaiting_fcb',v_waiting,'refreshed_at',now());
end;
$$;

revoke all on function ops_core.enforce_fcb_first_registration() from public, anon, authenticated;
grant execute on function ops_core.enforce_fcb_first_registration() to service_role;
