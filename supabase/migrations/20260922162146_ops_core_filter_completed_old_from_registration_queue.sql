CREATE OR REPLACE FUNCTION ops_core.refresh_registration_candidates()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops_core', 'ops_panel', 'public'
AS $function$
declare
  v_upserted integer := 0;
  v_rejected integer := 0;
begin
  with
  wip_ranked as (
    select distinct on (project_core)
      project_core,
      project_key,
      client,
      vessel,
      pm,
      customer_po,
      acceptance_date,
      contractual_date,
      deadline_date,
      drawing_approval_date,
      overall_status
    from (
      select
        ops_core.normalize_project_core(w.project_key) project_core,
        w.*
      from ops_panel.wip_current w
      where w.project_key is not null
        and ops_core.is_valid_project_core(ops_core.normalize_project_core(w.project_key))
        and upper(coalesce(w.overall_status,'')) not in ('DELIVERED','CANCELLED','MISSING DATA BOOK')
    ) x
    order by project_core,source_row_id desc
  ),
  job_ranked as (
    select distinct on (project_core)
      project_core,
      project_key,
      client,
      pm_responsible,
      po_numbers,
      project_status
    from (
      select ops_core.normalize_project_core(j.project_key) project_core,j.*
      from ops_panel.job_order_current j
      where j.project_key is not null
        and ops_core.is_valid_project_core(ops_core.normalize_project_core(j.project_key))
    ) x
    order by project_core,source_updated_at desc nulls last,project_key
  ),
  drawing_agg as (
    select
      ops_core.normalize_project_core(d.project_key) project_core,
      min(d.project_key) project_key,
      max(nullif(d.client,'')) client,
      max(nullif(d.pm,'')) pm,
      max(nullif(d.priority,'')) priority,
      max(nullif(d.po_number,'')) po_number,
      count(*)::integer drawing_count,
      max(nullif(d.current_revision,'')) latest_revision
    from ops_panel.drawings_current d
    where d.project_key is not null
      and ops_core.is_valid_project_core(ops_core.normalize_project_core(d.project_key))
    group by ops_core.normalize_project_core(d.project_key)
  ),
  trigger_projects as (
    select p.project_core,p.display_code,'existing_project'::text trigger_source
    from ops_core.projects p
    where p.region='BR' and p.active=true

    union all

    select w.project_core,w.project_key,'wip_active'
    from wip_ranked w

    union all

    select c.project_core,c.display_code,'drawing_candidate'
    from ops_core.registration_candidates c
    join drawing_agg d on d.project_core=c.project_core
    where c.region='BR'
      and c.validated_project_id is null
      and c.candidate_status in ('validation_required','reconciled')
      and 'drawing'=any(coalesce(c.source_systems,'{}'::text[]))
  ),
  valid_triggers as (
    select distinct on (project_core)
      project_core,display_code,trigger_source
    from trigger_projects
    where ops_core.is_valid_project_core(project_core)
    order by project_core,
      case trigger_source when 'existing_project' then 1 when 'wip_active' then 2 else 3 end
  ),
  enriched as (
    select
      t.project_core,
      coalesce(nullif(t.display_code,''),t.project_core) display_code,
      array_remove(array[
        case when p.id is not null then 'legacy_snapshot' end,
        case when w.project_core is not null then 'wip' end,
        case when j.project_core is not null then 'job_order' end,
        case when d.project_core is not null then 'drawing' end
      ],null)::text[] source_systems,
      jsonb_strip_nulls(jsonb_build_object(
        'wip',case when w.project_core is null then null else jsonb_build_object(
          'project_key',w.project_key,'client',w.client,'vessel',w.vessel,'pm',w.pm,
          'customer_po',w.customer_po,'acceptance_date',w.acceptance_date,
          'contractual_date',w.contractual_date,'deadline_date',w.deadline_date,
          'drawing_approval_date',w.drawing_approval_date,'project_status',w.overall_status
        ) end,
        'job_order',case when j.project_core is null then null else jsonb_build_object(
          'project_key',j.project_key,'client',j.client,'pm',j.pm_responsible,
          'po_numbers',j.po_numbers,'project_status',j.project_status
        ) end,
        'drawing',case when d.project_core is null then null else jsonb_build_object(
          'project_key',d.project_key,'client',d.client,'drawing_count',d.drawing_count,
          'latest_revision',d.latest_revision,'pm',d.pm,'priority',d.priority,'po_number',d.po_number
        ) end
      )) suggested_data,
      p.id project_id,
      p.source_mode
    from valid_triggers t
    left join ops_core.projects p on p.region='BR' and p.project_core=t.project_core
    left join wip_ranked w on w.project_core=t.project_core
    left join job_ranked j on j.project_core=t.project_core
    left join drawing_agg d on d.project_core=t.project_core
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
        suggested_data=ops_core.registration_candidates.suggested_data||excluded.suggested_data,
        last_seen_at=now(),
        candidate_status=case
          when ops_core.registration_candidates.validated_project_id is not null
               and excluded.validated_project_id is not null then 'validated'
          else excluded.candidate_status
        end,
        validated_project_id=coalesce(
          excluded.validated_project_id,
          ops_core.registration_candidates.validated_project_id
        )
    returning 1
  )
  select count(*) into v_upserted from upserted;

  with
  active_wip as (
    select distinct ops_core.normalize_project_core(w.project_key) project_core
    from ops_panel.wip_current w
    where w.project_key is not null
      and upper(coalesce(w.overall_status,'')) not in ('DELIVERED','CANCELLED','MISSING DATA BOOK')
  ),
  drawing_projects as (
    select distinct ops_core.normalize_project_core(d.project_key) project_core
    from ops_panel.drawings_current d
    where d.project_key is not null
  )
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
      select 1 from ops_core.projects p
      where p.region=c.region and p.project_core=c.project_core and p.active=true
    )
    and not exists (select 1 from active_wip w where w.project_core=c.project_core)
    and not (
      'drawing'=any(coalesce(c.source_systems,'{}'::text[]))
      and exists(select 1 from drawing_projects d where d.project_core=c.project_core)
    );
  get diagnostics v_rejected=row_count;

  -- Keep the registration queue clean: current Tracking has priority over OLD.
  -- Only projects no longer present in current Tracking can be auto-classified as historical/finalized.
  with current_tracking as (
    select distinct ops_core.normalize_project_core(t.project_key) project_core
    from ops_panel.tracking_current_items t
    where ops_core.normalize_project_core(t.project_key) is not null
  ),
  archived_history as (
    select a.project_core,a.completed_on,a.archive_source
    from ops_core.archived_project_catalog a
  ),
  finished_history as (
    select
      h.project_core,
      bool_or(h.project_finished) project_finished,
      max(h.project_finish_date) project_finish_date,
      max(h.finish_date) last_item_finish
    from ops_core.legacy_tracking_history h
    group by h.project_core
  ),
  terminal_wip as (
    select distinct ops_core.normalize_project_core(w.project_key) project_core,
           upper(coalesce(w.overall_status,'')) overall_status
    from ops_panel.wip_current w
    where w.project_key is not null
      and upper(coalesce(w.overall_status,'')) in
        ('DELIVERED','CANCELLED','MISSING DATA BOOK','FINISHED','COMPLETED','CLOSED')
  ),
  historical_matches as (
    select
      c.id,
      c.project_core,
      a.completed_on,
      a.archive_source,
      h.project_finish_date,
      h.last_item_finish,
      tw.overall_status wip_status
    from ops_core.registration_candidates c
    left join archived_history a on a.project_core=c.project_core
    left join finished_history h on h.project_core=c.project_core
    left join terminal_wip tw on tw.project_core=c.project_core
    where c.region='BR'
      and c.validated_project_id is null
      and c.candidate_status<>'rejected'
      and not exists (
        select 1 from current_tracking ct where ct.project_core=c.project_core
      )
      and (
        (a.completed_on is not null and a.completed_on <= current_date)
        or (
          h.project_finished=true
          and coalesce(h.project_finish_date,h.last_item_finish) is not null
          and coalesce(h.project_finish_date,h.last_item_finish) <= current_date
        )
        or tw.project_core is not null
      )
  )
  update ops_core.registration_candidates c
  set
    candidate_status='rejected',
    suggested_data=coalesce(c.suggested_data,'{}'::jsonb) || jsonb_build_object(
      'history_check',jsonb_build_object(
        'classification','finalized_old',
        'checked_at',now(),
        'current_tracking',false
      )
    ),
    conflicts=coalesce(c.conflicts,'[]'::jsonb) || jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object(
        'type','historical_finalized',
        'message','BSP removida da fila de cadastro: não está no Tracking atual e possui evidência de finalização no OLD/WIP.',
        'completed_on',hm.completed_on,
        'project_finish_date',hm.project_finish_date,
        'last_item_finish',hm.last_item_finish,
        'archive_source',hm.archive_source,
        'wip_status',hm.wip_status,
        'detected_at',now()
      ))
    )
  from historical_matches hm
  where c.id=hm.id;

  get diagnostics v_rejected=row_count;

  -- Mark only genuine Drawing projects as new after checking current Tracking and historical sources.
  with current_tracking as (
    select distinct ops_core.normalize_project_core(t.project_key) project_core
    from ops_panel.tracking_current_items t
    where ops_core.normalize_project_core(t.project_key) is not null
  )
  update ops_core.registration_candidates c
  set suggested_data=coalesce(c.suggested_data,'{}'::jsonb) || jsonb_build_object(
    'detection',jsonb_build_object(
      'new_project',true,
      'source','drawing',
      'checked_current_tracking',true,
      'checked_old_history',true,
      'detected_at',coalesce(c.suggested_data #>> '{detection,detected_at}',now()::text)
    )
  )
  where c.region='BR'
    and c.validated_project_id is null
    and c.candidate_status='validation_required'
    and 'drawing'=any(coalesce(c.source_systems,'{}'::text[]))
    and not exists (
      select 1 from current_tracking ct where ct.project_core=c.project_core
    );

  return jsonb_build_object(
    'ok',true,
    'candidates_upserted',v_upserted,
    'historical_rejected',v_rejected,
    'refreshed_at',now()
  );
end $function$
;