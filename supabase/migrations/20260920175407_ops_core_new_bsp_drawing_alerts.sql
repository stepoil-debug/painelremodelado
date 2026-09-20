
create table if not exists ops_core.drawing_project_registry (
  project_core text primary key,
  first_display_code text,
  first_seen_at timestamptz not null default now(),
  first_seen_source_version bigint,
  last_seen_at timestamptz not null default now(),
  last_seen_source_version bigint,
  drawing_count integer not null default 0,
  last_client text,
  last_pm text,
  last_priority text,
  last_po_number text,
  alerted_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

alter table ops_core.drawing_project_registry enable row level security;
revoke all on ops_core.drawing_project_registry from anon,authenticated;
grant all on ops_core.drawing_project_registry to service_role;

insert into ops_core.drawing_project_registry(
  project_core,first_display_code,first_seen_at,first_seen_source_version,
  last_seen_at,last_seen_source_version,drawing_count,last_client,last_pm,last_priority,last_po_number,
  alerted_at,metadata
)
select
  ops_core.normalize_project_core(d.project_key),
  min(d.project_key),
  coalesce(min(d.synced_at),now()),
  min(d.source_version),
  coalesce(max(d.synced_at),now()),
  max(d.source_version),
  count(*)::integer,
  max(nullif(d.client,'')),
  max(nullif(d.pm,'')),
  max(nullif(d.priority,'')),
  max(nullif(d.po_number,'')),
  now(),
  jsonb_build_object('baseline',true,'seeded_at',now())
from ops_panel.drawings_current d
where ops_core.is_valid_project_core(ops_core.normalize_project_core(d.project_key))
group by ops_core.normalize_project_core(d.project_key)
on conflict(project_core) do update
set last_seen_at=excluded.last_seen_at,
    last_seen_source_version=excluded.last_seen_source_version,
    drawing_count=excluded.drawing_count,
    last_client=excluded.last_client,
    last_pm=excluded.last_pm,
    last_priority=excluded.last_priority,
    last_po_number=excluded.last_po_number;

create or replace function ops_core.detect_new_drawing_projects()
returns jsonb
language plpgsql
security definer
set search_path=ops_core,ops_panel,public
as $$
declare
  r record;
  v_candidate_id uuid;
  v_new_count integer:=0;
  v_seen_count integer:=0;
  v_new_projects jsonb:='[]'::jsonb;
begin
  for r in
    select
      ops_core.normalize_project_core(d.project_key) project_core,
      min(d.project_key) display_code,
      max(nullif(d.client,'')) client,
      max(nullif(d.pm,'')) pm,
      max(nullif(d.priority,'')) priority,
      max(nullif(d.po_number,'')) po_number,
      max(d.current_revision) latest_revision,
      max(d.source_version) source_version,
      max(d.synced_at) synced_at,
      count(*)::integer drawing_count,
      bool_or(coalesce(d.is_fcb,false)) has_fcb
    from ops_panel.drawings_current d
    where ops_core.is_valid_project_core(ops_core.normalize_project_core(d.project_key))
    group by ops_core.normalize_project_core(d.project_key)
  loop
    if exists(select 1 from ops_core.drawing_project_registry x where x.project_core=r.project_core) then
      update ops_core.drawing_project_registry
      set last_seen_at=coalesce(r.synced_at,now()),
          last_seen_source_version=r.source_version,
          drawing_count=r.drawing_count,
          last_client=r.client,
          last_pm=r.pm,
          last_priority=r.priority,
          last_po_number=r.po_number
      where project_core=r.project_core;
      v_seen_count:=v_seen_count+1;
      continue;
    end if;

    insert into ops_core.drawing_project_registry(
      project_core,first_display_code,first_seen_at,first_seen_source_version,
      last_seen_at,last_seen_source_version,drawing_count,last_client,last_pm,last_priority,last_po_number,
      alerted_at,metadata
    ) values(
      r.project_core,r.display_code,coalesce(r.synced_at,now()),r.source_version,
      coalesce(r.synced_at,now()),r.source_version,r.drawing_count,r.client,r.pm,r.priority,r.po_number,
      now(),
      jsonb_build_object('baseline',false,'detected_by','drawing_sync','has_fcb',r.has_fcb)
    );

    insert into ops_core.registration_candidates(
      region,project_core,display_code,candidate_status,source_systems,
      suggested_data,conflicts,discovered_at,last_seen_at,validated_project_id
    )
    values(
      'BR',
      r.project_core,
      coalesce(nullif(r.display_code,''),r.project_core),
      'validation_required',
      array['drawing']::text[],
      jsonb_build_object(
        'drawing',jsonb_strip_nulls(jsonb_build_object(
          'project_key',r.display_code,
          'client',r.client,
          'pm',r.pm,
          'priority',r.priority,
          'po_number',r.po_number,
          'drawing_count',r.drawing_count,
          'latest_revision',r.latest_revision,
          'source_version',r.source_version,
          'has_fcb',r.has_fcb
        )),
        'detection',jsonb_build_object(
          'source','drawing',
          'new_project',true,
          'detected_at',now()
        )
      ),
      '[]'::jsonb,
      now(),
      now(),
      null
    )
    on conflict(region,project_core) do update
    set display_code=coalesce(nullif(excluded.display_code,''),ops_core.registration_candidates.display_code),
        candidate_status=case
          when ops_core.registration_candidates.validated_project_id is not null then 'validated'
          else 'validation_required'
        end,
        source_systems=(
          select array_agg(distinct s)
          from unnest(coalesce(ops_core.registration_candidates.source_systems,'{}'::text[])||array['drawing']::text[]) s
        ),
        suggested_data=ops_core.registration_candidates.suggested_data||excluded.suggested_data,
        last_seen_at=now()
    returning id into v_candidate_id;

    insert into ops_core.notifications(
      sector_key,notification_type,title,message,severity,dedup_key,created_at
    )
    values(
      'engenharia',
      'registration.new_bsp_from_drawing',
      'Nova BSP detectada no Drawing',
      coalesce(nullif(r.display_code,''),r.project_core)
        || ' foi adicionada ao Drawing e entrou na fila de cadastro. Confira e valide no painel.',
      'warning',
      'new-drawing-bsp:'||r.project_core,
      now()
    )
    on conflict(dedup_key) do nothing;

    insert into ops_core.audit_events(
      entity_type,entity_id,action,actor_email,source_system,after_data,metadata
    )
    values(
      'registration_candidate',
      v_candidate_id::text,
      'registration.new_bsp_detected',
      'system:drawing-sync',
      'drawing',
      jsonb_build_object(
        'project_core',r.project_core,
        'display_code',r.display_code,
        'drawing_count',r.drawing_count,
        'source_version',r.source_version
      ),
      jsonb_build_object('notification_created',true)
    );

    v_new_count:=v_new_count+1;
    v_new_projects:=v_new_projects||jsonb_build_array(
      jsonb_build_object(
        'project_core',r.project_core,
        'display_code',r.display_code,
        'client',r.client,
        'drawing_count',r.drawing_count
      )
    );
  end loop;

  return jsonb_build_object(
    'ok',true,
    'new_projects',v_new_count,
    'known_projects',v_seen_count,
    'projects',v_new_projects,
    'checked_at',now()
  );
end $$;

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

    union

    select
      c.project_core,
      c.display_code,
      'drawing_candidate'
    from ops_core.registration_candidates c
    where c.region='BR'
      and c.validated_project_id is null
      and c.candidate_status in ('validation_required','reconciled')
      and 'drawing'=any(coalesce(c.source_systems,'{}'::text[]))
      and exists(
        select 1 from ops_panel.drawings_current d
        where ops_core.normalize_project_core(d.project_key)=c.project_core
      )
  ),
  valid_triggers as (
    select distinct on (project_core)
      project_core,display_code,trigger_source
    from trigger_projects
    where ops_core.is_valid_project_core(project_core)
    order by project_core,
      case trigger_source
        when 'existing_project' then 1
        when 'wip_active' then 2
        else 3
      end
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
          'latest_revision',d.latest_revision,'pm',d.pm,'priority',d.priority,'po_number',d.po_number
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
        max(pm) pm,
        max(priority) priority,
        max(po_number) po_number,
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
        suggested_data=ops_core.registration_candidates.suggested_data||excluded.suggested_data,
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
    )
    and not (
      'drawing'=any(coalesce(c.source_systems,'{}'::text[]))
      and exists(
        select 1 from ops_panel.drawings_current d
        where ops_core.normalize_project_core(d.project_key)=c.project_core
      )
    );
  get diagnostics v_rejected=row_count;

  return jsonb_build_object(
    'ok',true,
    'candidates_upserted',v_upserted,
    'historical_rejected',v_rejected,
    'refreshed_at',now()
  );
end $$;

create or replace function public.ops_core_detect_new_drawing_projects()
returns jsonb
language sql
security definer
set search_path=public,ops_core
as $$
  select ops_core.detect_new_drawing_projects();
$$;

grant execute on function ops_core.detect_new_drawing_projects() to service_role;
grant execute on function public.ops_core_detect_new_drawing_projects() to service_role;
