
drop materialized view if exists ops_core.demand_feed_cache;

create materialized view ops_core.demand_feed_cache as
select * from ops_core.demand_feed;

create index demand_feed_cache_region_idx
  on ops_core.demand_feed_cache(region, project_number);
create index demand_feed_cache_project_idx
  on ops_core.demand_feed_cache(project_number, iso);
create index demand_feed_cache_status_idx
  on ops_core.demand_feed_cache(current_status);
create index demand_feed_cache_source_mode_idx
  on ops_core.demand_feed_cache(source_mode);

revoke all on ops_core.demand_feed_cache from anon,authenticated;
grant select on ops_core.demand_feed_cache to service_role;

create or replace function ops_core.refresh_demand_feed_cache()
returns jsonb
language plpgsql
security definer
set search_path=ops_core,public
as $$
declare
  v_started timestamptz:=clock_timestamp();
  v_rows integer;
begin
  refresh materialized view ops_core.demand_feed_cache;
  select count(*) into v_rows from ops_core.demand_feed_cache;
  return jsonb_build_object(
    'ok',true,
    'rows',v_rows,
    'refreshed_at',clock_timestamp(),
    'elapsed_ms',round((extract(epoch from (clock_timestamp()-v_started))*1000)::numeric,2)
  );
end $$;

create or replace function public.ops_core_refresh_demand_feed_cache()
returns jsonb
language sql
security definer
set search_path=public,ops_core
as $$
  select ops_core.refresh_demand_feed_cache();
$$;

grant execute on function ops_core.refresh_demand_feed_cache() to service_role;
grant execute on function public.ops_core_refresh_demand_feed_cache() to service_role;

create or replace function public.ops_core_get_demands(
  p_region text default 'BR',
  p_limit integer default 2000
)
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core
as $$
select coalesce(jsonb_agg(to_jsonb(q) order by q.project_number,q.iso),'[]'::jsonb)
from (
  select *
  from ops_core.demand_feed_cache
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
set search_path=public,ops_core
as $$
select coalesce(jsonb_agg(to_jsonb(q) order by q.project_number,q.iso),'[]'::jsonb)
from (
  select *
  from ops_core.demand_feed_cache
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
