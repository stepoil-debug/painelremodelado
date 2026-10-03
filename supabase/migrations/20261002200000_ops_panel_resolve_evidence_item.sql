create or replace function public.ops_panel_resolve_item_for_evidence(
  p_project_core text,
  p_iso text
)
returns uuid
language sql
security definer
set search_path = public, ops_core
as $$
with params as (
  select
    regexp_replace(
      regexp_replace(upper(btrim(coalesce(p_project_core, ''))), '[^A-Z0-9]', '', 'g'),
      '^(BSP|BEP|BPP|B3D)', '', 'g'
    ) as project_key,
    regexp_replace(upper(btrim(coalesce(p_iso, ''))), '[^A-Z0-9]', '', 'g') as iso_key
)
select i.id
from ops_core.items i
join ops_core.projects p on p.id = i.project_id
cross join params q
where p.active
  and not i.removed_from_scope
  and regexp_replace(
    regexp_replace(upper(coalesce(p.project_core, '')), '[^A-Z0-9]', '', 'g'),
    '^(BSP|BEP|BPP|B3D)', '', 'g'
  ) = q.project_key
  and q.iso_key <> ''
  and q.iso_key in (
    regexp_replace(upper(coalesce(i.item_key, '')), '[^A-Z0-9]', '', 'g'),
    regexp_replace(upper(coalesce(i.iso_code, '')), '[^A-Z0-9]', '', 'g'),
    regexp_replace(upper(coalesce(i.spool_code, '')), '[^A-Z0-9]', '', 'g'),
    regexp_replace(upper(coalesce(i.tag_number, '')), '[^A-Z0-9]', '', 'g'),
    regexp_replace(upper(coalesce(i.drawing_code, '')), '[^A-Z0-9]', '', 'g'),
    regexp_replace(upper(coalesce(i.legacy_iso_key, '')), '[^A-Z0-9]', '', 'g')
  )
order by i.updated_at desc nulls last
limit 1;
$$;

revoke all on function public.ops_panel_resolve_item_for_evidence(text, text) from public, anon, authenticated;
grant execute on function public.ops_panel_resolve_item_for_evidence(text, text) to service_role;
