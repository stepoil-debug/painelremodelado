-- Registration candidates are kept for validation only. They must never be
-- exposed by the operational demand feed before a controlled cutover.

create or replace function public.ops_core_get_demands(
  p_region text default 'BR',
  p_limit integer default 2000
)
returns jsonb
language sql
stable
security definer
set search_path = public, ops_core, ops_panel
as $$
with combined as (
  select c.*
  from ops_core.demand_feed_cache c
  where coalesce(c.source_mode, 'legacy_tracking') <> 'pending_validation'
  union all
  select o.*
  from ops_core.open_old_demand_feed o
  where coalesce(o.source_mode, 'legacy_tracking') <> 'pending_validation'
    and not exists(
      select 1
      from ops_core.demand_feed_cache c
      where c.project_number = o.project_number
        and c.iso_key = o.iso_key
    )
)
select coalesce(jsonb_agg(to_jsonb(q) order by q.project_number, q.iso), '[]'::jsonb)
from (
  select *
  from combined
  where p_region is null or upper(region) = upper(p_region)
  order by project_number, iso
  limit greatest(1, least(coalesce(p_limit, 2000), 5000))
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
set search_path = public, ops_core, ops_panel
as $$
with combined as (
  select c.*
  from ops_core.demand_feed_cache c
  where coalesce(c.source_mode, 'legacy_tracking') <> 'pending_validation'
  union all
  select o.*
  from ops_core.open_old_demand_feed o
  where coalesce(o.source_mode, 'legacy_tracking') <> 'pending_validation'
    and not exists(
      select 1
      from ops_core.demand_feed_cache c
      where c.project_number = o.project_number
        and c.iso_key = o.iso_key
    )
)
select coalesce(jsonb_agg(to_jsonb(q) order by q.project_number, q.iso), '[]'::jsonb)
from (
  select *
  from combined
  where (p_region is null or upper(region) = upper(p_region))
    and (
      btrim(coalesce(p_search, '')) = ''
      or project_number ilike '%' || p_search || '%'
      or project_display ilike '%' || p_search || '%'
      or project_row_id ilike '%' || p_search || '%'
      or coalesce(core_project_id::text, '') ilike '%' || p_search || '%'
      or coalesce(core_item_id::text, '') ilike '%' || p_search || '%'
      or iso ilike '%' || p_search || '%'
      or drawing ilike '%' || p_search || '%'
      or client ilike '%' || p_search || '%'
      or vessel ilike '%' || p_search || '%'
      or description ilike '%' || p_search || '%'
    )
  order by project_number, iso
  limit greatest(1, least(coalesce(p_limit, 500), 2000))
) q;
$$;

revoke all on function public.ops_core_get_demands(text, integer) from public, anon, authenticated;
revoke all on function public.ops_core_search_demands(text, text, integer) from public, anon, authenticated;
grant execute on function public.ops_core_get_demands(text, integer) to service_role;
grant execute on function public.ops_core_search_demands(text, text, integer) to service_role;
