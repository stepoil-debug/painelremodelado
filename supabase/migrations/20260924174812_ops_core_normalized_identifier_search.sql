
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
with params as (
  select
    btrim(coalesce(p_search,'')) search_raw,
    regexp_replace(upper(btrim(coalesce(p_search,''))),'[^A-Z0-9]','','g') search_compact
),
normalized as (
  select
    search_raw,
    search_compact,
    regexp_replace(search_compact,'^(BSP|ISO|SPL)','') search_identifier
  from params
)
select coalesce(jsonb_agg(to_jsonb(q) order by q.project_number,q.iso),'[]'::jsonb)
from (
  select d.*
  from ops_core.demand_feed_cache d
  cross join normalized s
  where (p_region is null or upper(d.region)=upper(p_region))
    and (
      s.search_raw=''
      or d.project_number ilike '%'||s.search_raw||'%'
      or d.project_display ilike '%'||s.search_raw||'%'
      or d.project_row_id ilike '%'||s.search_raw||'%'
      or coalesce(d.core_project_id::text,'') ilike '%'||s.search_raw||'%'
      or coalesce(d.core_item_id::text,'') ilike '%'||s.search_raw||'%'
      or d.iso ilike '%'||s.search_raw||'%'
      or d.drawing ilike '%'||s.search_raw||'%'
      or d.client ilike '%'||s.search_raw||'%'
      or d.vessel ilike '%'||s.search_raw||'%'
      or d.description ilike '%'||s.search_raw||'%'

      -- Busca de identificadores sem pontuação:
      -- 25-481 = 25481 = BSP.25/481
      -- 25-481-STR-001 = 25481STR001 = BSP-25.481/STR.001
      or regexp_replace(upper(coalesce(d.project_number,'')),'[^A-Z0-9]','','g') like '%'||s.search_identifier||'%'
      or regexp_replace(upper(coalesce(d.project_display,'')),'[^A-Z0-9]','','g') like '%'||s.search_identifier||'%'
      or regexp_replace(upper(coalesce(d.iso,'')),'[^A-Z0-9]','','g') like '%'||s.search_identifier||'%'
      or regexp_replace(upper(coalesce(d.drawing,'')),'[^A-Z0-9]','','g') like '%'||s.search_identifier||'%'
      or regexp_replace(
           upper(coalesce(d.project_number,'')||coalesce(d.iso,'')),
           '[^A-Z0-9]','','g'
         ) like '%'||s.search_identifier||'%'
      or regexp_replace(
           upper(coalesce(d.project_number,'')||coalesce(d.drawing,'')),
           '[^A-Z0-9]','','g'
         ) like '%'||s.search_identifier||'%'
    )
  order by d.project_number,d.iso
  limit greatest(1,least(coalesce(p_limit,500),2000))
) q;
$$;

grant execute on function public.ops_core_search_demands(text,text,integer) to service_role;
