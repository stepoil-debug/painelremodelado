create or replace view ops_core.open_old_demand_feed as
with ranked as (
  select
    h.*,
    row_number() over(
      partition by h.project_core,coalesce(h.item_key,h.source_row_id::text)
      order by h.updated_at desc nulls last,h.synced_at desc nulls last,
               h.source_version desc nulls last,h.source_row_id desc
    ) as rn
  from ops_core.legacy_tracking_history h
  where h.snapshot_scope='archive'
    and h.source_key like 'tracking_old_%'
    and not h.project_finished
    and h.project_core is not null
    and not exists(
      select 1
      from ops_panel.tracking_current_items t
      where ops_core.normalize_project_core(t.project_key)=h.project_core
    )
    and not exists(
      select 1
      from ops_core.projects p
      where p.region='BR'
        and p.project_core=h.project_core
        and p.source_mode='archived'
    )
)
select
  'BR'::text as region,
  r.item_key as iso_key,
  nullif(r.source_row_id::text,'') as project_row_id,
  r.project_core as project_number,
  coalesce(nullif(r.drawing,''),nullif(r.item,''),r.item_key) as iso,
  r.drawing,
  r.line_number,
  r.observations as description,
  null::text as client_tag,
  r.project_type,
  r.current_stage,
  r.current_status,
  r.start_date as planned_start,
  r.finish_date as planned_finish,
  r.fabrication_start,
  coalesce(r.overall_progress,0)::numeric as overall_progress,
  r.weight_kg,
  r.m2,
  coalesce(r.source_version::text,'old') as source_version,
  r.updated_at as source_updated_at,
  r.synced_at,
  coalesce(nullif(r.project_display,''),'BSP '||r.project_core) as project_display,
  r.client,
  r.vessel,
  r.pm,
  'OLD · ABERTO'::text as project_status,
  r.project_finish_date as replanned_finish,
  false as archived,
  r.archive_source,
  nullif(r.source_payload->>'archive_rank','')::integer as archive_rank,
  'legacy_tracking'::text as source_mode,
  null::uuid as core_project_id,
  null::uuid as core_item_id,
  null::text as material,
  null::text as size,
  null::text as schedule,
  null::numeric as joints,
  null::numeric as quantity,
  null::text as spool_code,
  null::boolean as requires_3d,
  null::boolean as requires_assembly_simulation,
  null::text as customer_po
from ranked r
where r.rn=1;

create or replace function public.ops_core_get_demands(
  p_region text default 'BR',
  p_limit integer default 2000
)
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core,ops_panel
as $$
with combined as (
  select c.*
  from ops_core.demand_feed_cache c
  union all
  select o.*
  from ops_core.open_old_demand_feed o
  where not exists(
    select 1
    from ops_core.demand_feed_cache c
    where c.project_number=o.project_number
      and c.iso_key=o.iso_key
  )
)
select coalesce(jsonb_agg(to_jsonb(q) order by q.project_number,q.iso),'[]'::jsonb)
from (
  select *
  from combined
  where p_region is null or upper(region)=upper(p_region)
  order by project_number,iso
  limit greatest(1,least(coalesce(p_limit,2000),5000))
) q;
$$;

create or replace function public.ops_core_search_demands(
  p_region text default 'BR',
  p_search text default '',
  p_limit integer default 500
)
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core,ops_panel
as $$
with combined as (
  select c.*
  from ops_core.demand_feed_cache c
  union all
  select o.*
  from ops_core.open_old_demand_feed o
  where not exists(
    select 1
    from ops_core.demand_feed_cache c
    where c.project_number=o.project_number
      and c.iso_key=o.iso_key
  )
)
select coalesce(jsonb_agg(to_jsonb(q) order by q.project_number,q.iso),'[]'::jsonb)
from (
  select *
  from combined
  where (p_region is null or upper(region)=upper(p_region))
    and (
      btrim(coalesce(p_search,''))=''
      or project_number ilike '%'||p_search||'%'
      or project_display ilike '%'||p_search||'%'
      or project_row_id ilike '%'||p_search||'%'
      or coalesce(core_project_id::text,'') ilike '%'||p_search||'%'
      or coalesce(core_item_id::text,'') ilike '%'||p_search||'%'
      or iso ilike '%'||p_search||'%'
      or drawing ilike '%'||p_search||'%'
      or client ilike '%'||p_search||'%'
      or vessel ilike '%'||p_search||'%'
      or description ilike '%'||p_search||'%'
    )
  order by project_number,iso
  limit greatest(1,least(coalesce(p_limit,500),2000))
) q;
$$;

grant execute on function public.ops_core_get_demands(text,integer) to service_role;
grant execute on function public.ops_core_search_demands(text,text,integer) to service_role;
