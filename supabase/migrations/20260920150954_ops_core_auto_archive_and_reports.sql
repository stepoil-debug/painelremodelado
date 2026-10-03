
create or replace function ops_core.archive_project_if_completed(
  p_project_id uuid,
  p_actor text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,public
as $$
declare
  p ops_core.projects%rowtype;
  v_items integer;
  v_incomplete integer;
  v_completed_at timestamptz;
begin
  select * into p from ops_core.projects where id=p_project_id for update;
  if not found then return jsonb_build_object('ok',false,'reason','project-not-found'); end if;
  if p.source_mode<>'ops_core' then
    return jsonb_build_object('ok',true,'archived',p.source_mode='archived','reason','not-active-ops-core');
  end if;

  select
    count(*) filter(where not removed_from_scope),
    count(*) filter(where not removed_from_scope and current_status<>'completed'),
    max(completed_at) filter(where not removed_from_scope)
  into v_items,v_incomplete,v_completed_at
  from ops_core.items
  where project_id=p_project_id;

  if v_items=0 or v_incomplete>0 then
    return jsonb_build_object('ok',true,'archived',false,'items',v_items,'incomplete',v_incomplete);
  end if;

  v_completed_at:=coalesce(v_completed_at,now());

  update ops_core.projects
  set source_mode='archived',
      project_status='ARCHIVED',
      active=false,
      completed_at=coalesce(completed_at,v_completed_at),
      archived_at=coalesce(archived_at,now()),
      archived_by=coalesce(nullif(p_actor,''),'system'),
      archive_reason=coalesce(archive_reason,'AUTO_ALL_ITEMS_COMPLETED'),
      reporting_year=extract(year from coalesce(completed_at,v_completed_at))::integer,
      updated_at=now()
  where id=p_project_id;

  update ops_core.handoffs
  set status='completed',
      completed_at=coalesce(completed_at,now())
  where project_id=p_project_id
    and status in ('available','accepted');

  update ops_core.notifications
  set resolved_at=coalesce(resolved_at,now())
  where project_id=p_project_id
    and resolved_at is null;

  insert into ops_core.audit_events(
    project_id,entity_type,entity_id,action,actor_email,source_system,before_data,after_data,metadata
  ) values(
    p_project_id,'project',p_project_id::text,'project.auto_archived',
    coalesce(nullif(p_actor,''),'system'),'ops_core',
    jsonb_build_object('source_mode',p.source_mode,'project_status',p.project_status,'active',p.active),
    jsonb_build_object(
      'source_mode','archived',
      'project_status','ARCHIVED',
      'completed_at',v_completed_at,
      'reporting_year',extract(year from v_completed_at)::integer
    ),
    jsonb_build_object('reason','all-active-items-completed','items',v_items)
  );

  return jsonb_build_object(
    'ok',true,
    'archived',true,
    'project_id',p_project_id,
    'items',v_items,
    'completed_at',v_completed_at,
    'reporting_year',extract(year from v_completed_at)::integer
  );
end $$;

create or replace function ops_core.archive_after_item_completion()
returns trigger
language plpgsql
security definer
set search_path=ops_core,public
as $$
begin
  if new.current_status='completed'
     and (old.current_status is distinct from new.current_status or old.overall_progress is distinct from new.overall_progress) then
    perform ops_core.archive_project_if_completed(new.project_id,'system:auto-completion');
  end if;
  return new;
end $$;

drop trigger if exists trg_ops_core_archive_after_item_completion on ops_core.items;
create trigger trg_ops_core_archive_after_item_completion
after update of current_status,overall_progress on ops_core.items
for each row
execute function ops_core.archive_after_item_completion();

create or replace function ops_core.advance_item_after_stage(
  p_item_id uuid,
  p_stage_key text,
  p_source_event_id uuid default null,
  p_actor text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,public
as $$
declare
  i ops_core.items%rowtype;
  p ops_core.projects%rowtype;
  cur ops_core.item_stages%rowtype;
  nxt record;
  v_handoff_id uuid;
  v_dedup text;
  v_archive jsonb;
begin
  select * into i from ops_core.items where id=p_item_id for update;
  if not found then return jsonb_build_object('ok',false,'reason','item-not-found'); end if;
  select * into p from ops_core.projects where id=i.project_id;
  if p.source_mode<>'ops_core' then return jsonb_build_object('ok',false,'reason','legacy-project'); end if;

  select * into cur from ops_core.item_stages where item_id=i.id and stage_key=p_stage_key;
  if not found then return jsonb_build_object('ok',false,'reason','stage-not-found'); end if;

  select s.stage_key,s.stage_order,w.name,w.sector_key,w.default_sla_minutes
  into nxt
  from ops_core.item_stages s
  join ops_core.workflow_stages w on w.stage_key=s.stage_key
  where s.item_id=i.id and s.is_applicable=true and s.stage_order>cur.stage_order and s.status<>'completed'
  order by s.stage_order
  limit 1;

  if not found then
    update ops_core.items
    set current_stage_key='completed',
        current_status='completed',
        overall_progress=100,
        completed_at=coalesce(completed_at,now()),
        updated_at=now()
    where id=i.id;

    v_archive:=ops_core.archive_project_if_completed(p.id,p_actor);
    return jsonb_build_object('ok',true,'completed',true,'project_archive',v_archive);
  end if;

  update ops_core.item_stages
  set status=case when status='pending' then 'available' else status end,
      entered_at=coalesce(entered_at,now()),updated_at=now()
  where item_id=i.id and stage_key=nxt.stage_key;

  update ops_core.items
  set current_stage_key=nxt.stage_key,current_status='available',updated_at=now()
  where id=i.id;

  v_dedup:=concat('handoff:',i.id,':',p_stage_key,':',nxt.stage_key);

  insert into ops_core.handoffs(
    project_id,item_id,from_stage_key,from_sector_key,to_stage_key,to_sector_key,
    status,dedup_key,available_at,source_event_id,metadata
  )
  values(
    p.id,i.id,p_stage_key,
    (select sector_key from ops_core.workflow_stages where stage_key=p_stage_key),
    nxt.stage_key,nxt.sector_key,'available',v_dedup,now(),p_source_event_id,
    jsonb_build_object('actor',p_actor)
  )
  on conflict(dedup_key) do update set
    status=case when ops_core.handoffs.status='cancelled' then 'available' else ops_core.handoffs.status end
  returning id into v_handoff_id;

  insert into ops_core.notifications(
    project_id,item_id,handoff_id,sector_key,notification_type,title,message,severity,dedup_key
  )
  values(
    p.id,i.id,v_handoff_id,nxt.sector_key,'handoff.created',
    'Nova demanda disponível',
    concat(p.display_code,' / ',coalesce(i.iso_code,i.drawing_code,i.item_key),' disponível para ',nxt.name,'.'),
    'info',concat('notification:',v_dedup)
  )
  on conflict(dedup_key) do nothing;

  return jsonb_build_object('ok',true,'completed',false,'next_stage',nxt.stage_key,'next_sector',nxt.sector_key,'handoff_id',v_handoff_id);
end $$;

create or replace view ops_core.legacy_final_item_catalog as
with ranked as (
  select h.*,
         row_number() over(
           partition by h.project_core,coalesce(h.item_key,h.source_row_id::text)
           order by
             case when h.snapshot_scope='current' then 1 else 0 end desc,
             h.synced_at desc nulls last,
             h.source_version desc nulls last
         ) as dedup_rank
  from ops_core.legacy_tracking_history h
  where h.project_finished=true
)
select *
from ranked
where dedup_rank=1;

create or replace view ops_core.archived_project_catalog as
with legacy_hold as (
  select project_core,
         round(sum(duration_hours)/24.0,2) hold_days
  from ops_core.legacy_on_hold_history
  where project_core is not null
  group by project_core
),
core_hold as (
  select project_core,
         round(sum(extract(epoch from (coalesce(ended_at,now())-started_at))/3600.0)/24.0,2) hold_days
  from ops_core.hold_periods
  group by project_core
),
legacy as (
  select
    'LEGACY_TRACKING'::text origin,
    null::uuid project_id,
    project_core,
    max(project_display) project_display,
    max(client) client,
    max(vessel) vessel,
    max(pm) pm,
    max(project_type) project_type,
    max(reporting_date) completed_on,
    extract(year from max(reporting_date))::integer reporting_year,
    count(*) item_count,
    round(sum(coalesce(weight_kg,0))::numeric,2) total_weight_kg,
    round(sum(coalesce(m2,0))::numeric,2) total_m2,
    max(archive_source) archive_source
  from ops_core.legacy_final_item_catalog
  where reporting_date is not null
  group by project_core
),
core as (
  select
    'OPS_CORE'::text origin,
    p.id project_id,
    p.project_core,
    p.display_code project_display,
    p.client,
    p.vessel,
    p.pm,
    p.project_type,
    coalesce(p.completed_at::date,p.archived_at::date) completed_on,
    coalesce(p.reporting_year,extract(year from coalesce(p.completed_at,p.archived_at))::integer) reporting_year,
    count(i.id) filter(where not i.removed_from_scope) item_count,
    round(coalesce(sum(coalesce(i.weight_kg,0)) filter(where not i.removed_from_scope),0)::numeric,2) total_weight_kg,
    round(coalesce(sum(coalesce(i.painting_m2,0)) filter(where not i.removed_from_scope),0)::numeric,2) total_m2,
    'OPS_CORE'::text archive_source
  from ops_core.projects p
  left join ops_core.items i on i.project_id=p.id
  where p.source_mode='archived'
  group by p.id
)
select
  x.*,
  round(coalesce(lh.hold_days,0)+coalesce(ch.hold_days,0),2) hold_days
from (
  select * from legacy
  union all
  select * from core
) x
left join legacy_hold lh using(project_core)
left join core_hold ch using(project_core);

create or replace view ops_core.annual_summary as
select
  reporting_year,
  count(*) projects,
  count(distinct nullif(client,'')) clients,
  sum(item_count) items,
  round(sum(total_weight_kg)::numeric,2) total_weight_kg,
  round(sum(total_m2)::numeric,2) total_m2,
  round(sum(hold_days)::numeric,2) hold_days
from ops_core.archived_project_catalog
where reporting_year is not null
group by reporting_year
order by reporting_year;

create or replace view ops_core.annual_client_summary as
select
  reporting_year,
  coalesce(nullif(client,''),'Não informado') client,
  count(*) projects,
  sum(item_count) items,
  round(sum(total_weight_kg)::numeric,2) total_weight_kg,
  round(sum(total_m2)::numeric,2) total_m2,
  round(sum(hold_days)::numeric,2) hold_days
from ops_core.archived_project_catalog
where reporting_year is not null
group by reporting_year,coalesce(nullif(client,''),'Não informado')
order by reporting_year,projects desc,client;

create or replace view ops_core.history_data_quality as
select
  source_key,
  source_row_id,
  project_core,
  item_key,
  start_date,
  finish_date,
  project_finish_date,
  date_quality_status,
  imported_at
from ops_core.legacy_tracking_history
where date_quality_status<>'OK';

create or replace function public.ops_core_archive_catalog(
  p_year integer default null,
  p_search text default null,
  p_limit integer default 1000
)
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core
as $$
select coalesce(jsonb_agg(to_jsonb(q) order by q.completed_on desc nulls last,q.project_core desc),'[]'::jsonb)
from (
  select *
  from ops_core.archived_project_catalog a
  where (p_year is null or a.reporting_year=p_year)
    and (
      nullif(btrim(coalesce(p_search,'')),'') is null
      or concat_ws(' ',a.project_core,a.project_display,a.client,a.vessel,a.pm,a.project_type)
         ilike '%'||btrim(p_search)||'%'
    )
  order by a.completed_on desc nulls last,a.project_core desc
  limit greatest(1,least(coalesce(p_limit,1000),5000))
) q;
$$;

create or replace function public.ops_core_annual_summary()
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core
as $$
select coalesce(jsonb_agg(to_jsonb(a) order by a.reporting_year),'[]'::jsonb)
from ops_core.annual_summary a;
$$;

create or replace function public.ops_core_history_health()
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core
as $$
select jsonb_build_object(
  'legacy_history_rows',(select count(*) from ops_core.legacy_tracking_history),
  'legacy_archive_rows',(select count(*) from ops_core.legacy_tracking_history where snapshot_scope='archive'),
  'legacy_current_rows',(select count(*) from ops_core.legacy_tracking_history where snapshot_scope='current'),
  'on_hold_periods',(select count(*) from ops_core.legacy_on_hold_history),
  'invalid_date_rows',(select count(*) from ops_core.history_data_quality),
  'archived_projects',(select count(*) from ops_core.archived_project_catalog),
  'years',(select coalesce(jsonb_agg(reporting_year order by reporting_year),'[]'::jsonb) from ops_core.annual_summary)
);
$$;

grant execute on function ops_core.archive_project_if_completed(uuid,text) to service_role;
grant execute on function public.ops_core_archive_catalog(integer,text,integer) to service_role;
grant execute on function public.ops_core_annual_summary() to service_role;
grant execute on function public.ops_core_history_health() to service_role;
