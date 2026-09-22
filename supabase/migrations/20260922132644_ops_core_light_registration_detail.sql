
create or replace function public.ops_core_registration_detail(p_project_key text)
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core
as $$
with p as (
  select *
  from ops_core.projects
  where region='BR'
    and project_core=ops_core.normalize_project_core(p_project_key)
  limit 1
)
select jsonb_build_object(
  'project',(select to_jsonb(p) from p),
  'items',coalesce((
    select jsonb_agg(to_jsonb(i) order by i.iso_code,i.drawing_code,i.item_key)
    from ops_core.items i
    join p on p.id=i.project_id
    where not i.removed_from_scope
  ),'[]'::jsonb)
);
$$;

grant execute on function public.ops_core_registration_detail(text) to service_role;
