
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
  from ops_core.demand_feed
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
revoke all on function public.ops_core_search_demands(text,text,integer) from public,anon,authenticated;
grant execute on function public.ops_core_search_demands(text,text,integer) to service_role;
