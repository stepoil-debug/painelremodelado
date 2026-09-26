
create or replace function public.ops_core_archive_detail(p_project_core text)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,ops_core,ops_panel
as $$
declare
  v_core text := ops_core.normalize_project_core(p_project_core);
  v_core_project ops_core.projects%rowtype;
  v_origin text;
  v_project jsonb;
  v_metrics jsonb;
  v_items jsonb;
  v_holds jsonb;
  v_stage_metrics jsonb;
  v_hh jsonb;
  v_documents jsonb;
  v_start date;
  v_actual_start date;
  v_fab_start date;
  v_end date;
  v_hold_days numeric:=0;
  v_total_weight numeric:=0;
  v_total_m2 numeric:=0;
  v_item_count integer:=0;
  v_lead_days numeric;
  v_fab_days numeric;
  v_effective_days numeric;
  v_avg_item_days numeric;
  v_total_hh numeric:=0;
begin
  select * into v_core_project
  from ops_core.projects
  where project_core=v_core and source_mode='archived'
  order by archived_at desc nulls last
  limit 1;

  if found then
    v_origin:='OPS_CORE';

    select
      min(coalesce(s.started_at::date,i.fabrication_start,i.planned_start)),
      min(s.started_at::date),
      min(coalesce(i.fabrication_start,v_core_project.fabrication_start)),
      coalesce(v_core_project.completed_at::date,v_core_project.archived_at::date),
      count(*) filter(where not i.removed_from_scope),
      coalesce(sum(i.weight_kg) filter(where not i.removed_from_scope),0),
      coalesce(sum(i.painting_m2) filter(where not i.removed_from_scope),0),
      round(avg(
        case
          when not i.removed_from_scope
           and i.completed_at is not null
           and coalesce(i.fabrication_start,i.planned_start) is not null
          then greatest(1,i.completed_at::date-coalesce(i.fabrication_start,i.planned_start)+1)
        end
      )::numeric,2)
    into v_start,v_actual_start,v_fab_start,v_end,v_item_count,v_total_weight,v_total_m2,v_avg_item_days
    from ops_core.items i
    left join lateral (
      select min(started_at) started_at
      from ops_core.item_stages s0
      where s0.item_id=i.id and s0.started_at is not null
    ) s on true
    where i.project_id=v_core_project.id;

    select coalesce(round(sum(extract(epoch from (coalesce(ended_at,v_end::timestamptz)-started_at))/86400.0)::numeric,2),0)
    into v_hold_days
    from ops_core.hold_periods
    where project_id=v_core_project.id
      and started_at::date<=coalesce(v_end,current_date);

    select coalesce(sum(total_hh),0)
    into v_total_hh
    from public.hh_sessions
    where status='finished'
      and ops_core.normalize_project_core(coalesce(nullif(project_key,''),nullif(bsp_number,'')))=v_core;

    v_project:=jsonb_build_object(
      'origin',v_origin,
      'project_id',v_core_project.id,
      'project_core',v_core_project.project_core,
      'project_display',v_core_project.display_code,
      'client',v_core_project.client,
      'vessel',v_core_project.vessel,
      'pm',v_core_project.pm,
      'project_type',v_core_project.project_type,
      'customer_po',v_core_project.customer_po,
      'client_reference',v_core_project.client_reference,
      'priority',v_core_project.priority,
      'project_status',v_core_project.project_status,
      'acceptance_date',v_core_project.acceptance_date,
      'contractual_date',v_core_project.contractual_date,
      'deadline_date',v_core_project.deadline_date,
      'replanned_finish',v_core_project.replanned_finish,
      'drawing_approval_date',v_core_project.drawing_approval_date,
      'project_start_date',v_start,
      'actual_start_date',v_actual_start,
      'fabrication_start_date',v_fab_start,
      'completed_on',v_end,
      'archived_at',v_core_project.archived_at,
      'reporting_year',v_core_project.reporting_year
    );

    select coalesce(jsonb_agg(to_jsonb(q) order by q.item_display),'[]'::jsonb)
    into v_items
    from (
      select
        i.id,
        i.item_key,
        coalesce(i.spool_code,i.iso_code,i.drawing_code,i.item_key) item_display,
        i.item_type,
        i.iso_code,
        i.spool_code,
        i.drawing_code,
        i.line_number,
        i.tag_number,
        i.description,
        i.material,
        i.size,
        i.schedule,
        i.weight_kg,
        i.painting_m2 m2,
        i.quantity,
        i.joints,
        i.hdg_kg,
        i.fbe_required,
        i.requires_3d,
        i.requires_assembly_simulation,
        i.planned_start start_date,
        i.fabrication_start,
        i.completed_at::date finish_date,
        i.overall_progress,
        i.current_status,
        i.removed_from_scope,
        (
          select coalesce(jsonb_agg(to_jsonb(st) order by st.stage_order),'[]'::jsonb)
          from (
            select
              s.stage_key,
              w.name stage_name,
              w.sector_key,
              s.stage_order,
              s.status,
              s.progress,
              s.entered_at,
              s.accepted_at,
              s.started_at,
              s.completed_at,
              case when s.started_at is not null and s.completed_at is not null
                then round((extract(epoch from (s.completed_at-s.started_at))/3600.0)::numeric,2)
              end execution_hours,
              case when s.entered_at is not null and s.completed_at is not null
                then round((extract(epoch from (s.completed_at-s.entered_at))/3600.0)::numeric,2)
              end total_stage_hours
            from ops_core.item_stages s
            join ops_core.workflow_stages w on w.stage_key=s.stage_key
            where s.item_id=i.id and s.is_applicable
            order by s.stage_order
          ) st
        ) stages
      from ops_core.items i
      where i.project_id=v_core_project.id
    ) q;

    select coalesce(jsonb_agg(to_jsonb(q) order by q.started_at),'[]'::jsonb)
    into v_holds
    from (
      select id,project_core,item_id,started_at,ended_at,reason,source_system,
             round((extract(epoch from (coalesce(ended_at,now())-started_at))/3600.0)::numeric,2) duration_hours
      from ops_core.hold_periods
      where project_id=v_core_project.id
      order by started_at
    ) q;

    select coalesce(jsonb_agg(to_jsonb(q) order by q.stage_order),'[]'::jsonb)
    into v_stage_metrics
    from (
      select
        s.stage_order,
        s.stage_key,
        w.name stage_name,
        w.sector_key,
        count(*) filter(where s.completed_at is not null) completed_items,
        round(avg(
          case when s.started_at is not null and s.completed_at is not null
          then extract(epoch from (s.completed_at-s.started_at))/3600.0 end
        )::numeric,2) avg_execution_hours,
        round(avg(
          case when s.entered_at is not null and s.started_at is not null
          then extract(epoch from (s.started_at-s.entered_at))/3600.0 end
        )::numeric,2) avg_queue_hours,
        round(avg(
          case when s.entered_at is not null and s.completed_at is not null
          then extract(epoch from (s.completed_at-s.entered_at))/3600.0 end
        )::numeric,2) avg_total_hours
      from ops_core.item_stages s
      join ops_core.items i on i.id=s.item_id
      join ops_core.workflow_stages w on w.stage_key=s.stage_key
      where i.project_id=v_core_project.id and s.is_applicable
      group by s.stage_order,s.stage_key,w.name,w.sector_key
      order by s.stage_order
    ) q;

    select coalesce(jsonb_agg(to_jsonb(q) order by q.activity_name),'[]'::jsonb)
    into v_hh
    from (
      select
        coalesce(nullif(activity_name,''),nullif(activity_key,''),'Atividade') activity_name,
        count(*) sessions,
        sum(coalesce(total_workers,0)) workers_recorded,
        round(sum(coalesce(elapsed_minutes,0))/60.0,2) elapsed_hours,
        round(sum(coalesce(total_hh,0))::numeric,2) total_hh,
        min(start_at) first_start,
        max(end_at) last_finish
      from public.hh_sessions
      where status='finished'
        and ops_core.normalize_project_core(coalesce(nullif(project_key,''),nullif(bsp_number,'')))=v_core
      group by coalesce(nullif(activity_name,''),nullif(activity_key,''),'Atividade')
    ) q;

    select coalesce(jsonb_agg(to_jsonb(q) order by q.document_type,q.document_number),'[]'::jsonb)
    into v_documents
    from (
      select
        d.id,
        d.document_type,
        d.document_number,
        d.title,
        d.current_revision,
        d.current_status,
        d.requires_3d,
        d.requires_assembly_simulation,
        d.source_system,
        (
          select coalesce(jsonb_agg(to_jsonb(r) order by ops_core.revision_rank(r.revision),r.source_version),'[]'::jsonb)
          from (
            select dr.revision,dr.source_version,dr.is_current,dr.status,dr.detected_at,dr.changed_fields
            from ops_core.document_revisions dr
            where dr.document_id=d.id
          ) r
        ) revisions
      from ops_core.documents d
      where d.project_id=v_core_project.id
    ) q;
  else
    v_origin:='LEGACY_TRACKING';

    if not exists(select 1 from ops_core.legacy_final_item_catalog where project_core=v_core) then
      return jsonb_build_object('ok',false,'reason','archive-project-not-found','project_core',v_core);
    end if;

    select
      min(case when start_date between date '2000-01-01' and date '2100-12-31' then start_date end),
      min(case when fabrication_start between date '2000-01-01' and date '2100-12-31' then fabrication_start end),
      max(reporting_date),
      count(*),
      coalesce(sum(weight_kg),0),
      coalesce(sum(case when m2 between 0 and 100000 then m2 else 0 end),0),
      round(avg(
        case
          when finish_date between date '2000-01-01' and date '2100-12-31'
           and fabrication_start between date '2000-01-01' and date '2100-12-31'
           and finish_date>=fabrication_start
          then finish_date-fabrication_start+1
        end
      )::numeric,2)
    into v_start,v_fab_start,v_end,v_item_count,v_total_weight,v_total_m2,v_avg_item_days
    from ops_core.legacy_final_item_catalog
    where project_core=v_core;

    select coalesce(round(sum(duration_hours)/24.0,2),0)
    into v_hold_days
    from ops_core.legacy_on_hold_history
    where project_core=v_core;

    select coalesce(sum(total_hh),0)
    into v_total_hh
    from public.hh_sessions
    where status='finished'
      and ops_core.normalize_project_core(coalesce(nullif(project_key,''),nullif(bsp_number,'')))=v_core;

    select jsonb_build_object(
      'origin',v_origin,
      'project_id',null,
      'project_core',v_core,
      'project_display',max(project_display),
      'client',max(client),
      'vessel',max(vessel),
      'pm',max(pm),
      'project_type',max(project_type),
      'customer_po',null,
      'client_reference',null,
      'priority',max(priority),
      'project_status','ARCHIVED',
      'acceptance_date',null,
      'contractual_date',null,
      'deadline_date',null,
      'replanned_finish',null,
      'drawing_approval_date',null,
      'project_start_date',v_start,
      'actual_start_date',null,
      'fabrication_start_date',v_fab_start,
      'completed_on',v_end,
      'archived_at',null,
      'reporting_year',extract(year from v_end)::integer
    )
    into v_project
    from ops_core.legacy_final_item_catalog
    where project_core=v_core;

    select coalesce(jsonb_agg(to_jsonb(q) order by q.item_display),'[]'::jsonb)
    into v_items
    from (
      select
        null::uuid id,
        item_key,
        coalesce(nullif(item,''),nullif(drawing,''),item_key) item_display,
        null::text item_type,
        item iso_code,
        null::text spool_code,
        drawing drawing_code,
        line_number,
        null::text tag_number,
        observations description,
        null::text material,
        null::text size,
        null::text schedule,
        weight_kg,
        case when m2 between 0 and 100000 then m2 else null end m2,
        null::numeric quantity,
        null::numeric joints,
        null::numeric hdg_kg,
        null::boolean fbe_required,
        null::boolean requires_3d,
        null::boolean requires_assembly_simulation,
        start_date,
        fabrication_start,
        finish_date,
        overall_progress,
        current_status,
        false removed_from_scope,
        '[]'::jsonb stages,
        source_key,
        archive_source,
        case when m2 is not null and (m2<0 or m2>100000) then true else false end metric_warning
      from ops_core.legacy_final_item_catalog
      where project_core=v_core
    ) q;

    select coalesce(jsonb_agg(to_jsonb(q) order by q.started_at),'[]'::jsonb)
    into v_holds
    from (
      select
        source_hold_id id,
        project_core,
        null::uuid item_id,
        iso,
        started_at,
        ended_at,
        null::text reason,
        'legacy_tracking'::text source_system,
        duration_hours
      from ops_core.legacy_on_hold_history
      where project_core=v_core
      order by started_at
    ) q;

    v_stage_metrics:='[]'::jsonb;

    select coalesce(jsonb_agg(to_jsonb(q) order by q.activity_name),'[]'::jsonb)
    into v_hh
    from (
      select
        coalesce(nullif(activity_name,''),nullif(activity_key,''),'Atividade') activity_name,
        count(*) sessions,
        sum(coalesce(total_workers,0)) workers_recorded,
        round(sum(coalesce(elapsed_minutes,0))/60.0,2) elapsed_hours,
        round(sum(coalesce(total_hh,0))::numeric,2) total_hh,
        min(start_at) first_start,
        max(end_at) last_finish
      from public.hh_sessions
      where status='finished'
        and ops_core.normalize_project_core(coalesce(nullif(project_key,''),nullif(bsp_number,'')))=v_core
      group by coalesce(nullif(activity_name,''),nullif(activity_key,''),'Atividade')
    ) q;

    v_documents:='[]'::jsonb;
  end if;

  if v_start is not null and v_end is not null and v_end>=v_start then
    v_lead_days:=v_end-v_start+1;
  end if;
  if v_fab_start is not null and v_end is not null and v_end>=v_fab_start then
    v_fab_days:=v_end-v_fab_start+1;
    v_effective_days:=greatest(1,v_fab_days-coalesce(v_hold_days,0));
  end if;

  v_metrics:=jsonb_build_object(
    'item_count',v_item_count,
    'total_weight_kg',round(coalesce(v_total_weight,0),2),
    'total_m2',round(coalesce(v_total_m2,0),2),
    'project_start_date',v_start,
    'actual_start_date',v_actual_start,
    'fabrication_start_date',v_fab_start,
    'completed_on',v_end,
    'lead_time_days',v_lead_days,
    'fabrication_calendar_days',v_fab_days,
    'hold_days',round(coalesce(v_hold_days,0),2),
    'effective_fabrication_days',v_effective_days,
    'avg_item_fabrication_days',v_avg_item_days,
    'weight_per_calendar_day',
      case when v_fab_days>0 then round((v_total_weight/v_fab_days)::numeric,2) end,
    'weight_per_effective_day',
      case when v_effective_days>0 then round((v_total_weight/v_effective_days)::numeric,2) end,
    'items_per_effective_day',
      case when v_effective_days>0 then round((v_item_count::numeric/v_effective_days)::numeric,2) end,
    'total_hh',round(coalesce(v_total_hh,0),2),
    'kg_per_hh',
      case when v_total_hh>0 then round((v_total_weight/v_total_hh)::numeric,2) end,
    'data_completeness',jsonb_build_object(
      'has_project_start',v_start is not null,
      'has_fabrication_start',v_fab_start is not null,
      'has_completion',v_end is not null,
      'has_hold_history',coalesce(v_hold_days,0)>0,
      'has_hh',coalesce(v_total_hh,0)>0,
      'has_stage_timing',jsonb_array_length(coalesce(v_stage_metrics,'[]'::jsonb))>0
    )
  );

  return jsonb_build_object(
    'ok',true,
    'origin',v_origin,
    'project',coalesce(v_project,'{}'::jsonb),
    'metrics',v_metrics,
    'items',coalesce(v_items,'[]'::jsonb),
    'hold_periods',coalesce(v_holds,'[]'::jsonb),
    'stage_metrics',coalesce(v_stage_metrics,'[]'::jsonb),
    'hh_summary',coalesce(v_hh,'[]'::jsonb),
    'documents',coalesce(v_documents,'[]'::jsonb)
  );
end $$;

grant execute on function public.ops_core_archive_detail(text) to service_role;
