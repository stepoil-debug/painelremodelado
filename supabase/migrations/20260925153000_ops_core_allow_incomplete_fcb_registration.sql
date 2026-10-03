create or replace function public.ops_core_project_validation_report(p_project_key text)
returns jsonb language sql stable security definer set search_path=public,ops_core
as $$
with p as (
  select * from ops_core.projects
  where region='BR' and project_core=ops_core.normalize_project_core(p_project_key)
  limit 1
),
stats as (
  select count(*) item_count,
    count(*) filter(where i.weight_kg is null) missing_weight,
    count(*) filter(where i.material is null or btrim(i.material)='') missing_material,
    count(*) filter(where i.item_type='OTHER') unclassified_items,
    count(*) filter(where coalesce((i.source_metadata->>'provisional_breakdown')::boolean,false)) provisional_breakdown,
    count(*) filter(where not exists(select 1 from ops_core.item_stages s where s.item_id=i.id)) items_without_workflow
  from ops_core.items i join p on i.project_id=p.id
  where not i.removed_from_scope
    and coalesce(i.source_metadata->>'fcb_superseded','false')<>'true'
),
docs as (
  select count(*) document_count,
    count(*) filter(where current_revision is null or current_revision='UNSPECIFIED') missing_revision,
    count(*) filter(where source_row_id is not null) source_linked
  from ops_core.documents d join p on d.project_id=p.id
  where coalesce(d.metadata->>'fcb_superseded','false')<>'true'
),
fcb as (select public.ops_core_fcb_status(p_project_key) data),
tracking as (
  select coalesce(to_jsonb(v),'{}'::jsonb) data
  from ops_core.project_source_validation v
  where v.region='BR' and v.project_core=ops_core.normalize_project_core(p_project_key)
    and v.source_system='tracking'
)
select jsonb_build_object(
  'project',(select to_jsonb(p) from p),
  'items',to_jsonb(stats),
  'documents',to_jsonb(docs),
  'fcb',(select data from fcb),
  'tracking_validation',(select data from tracking),
  'technical_authority','FCB',
  'blocking_issues',
    (case when not coalesce(((select data from fcb)->>'has_fcb')::boolean,false)
      then jsonb_build_array('FCB vigente ainda não disponível. O cadastro técnico deve aguardar o FCB.') else '[]'::jsonb end)
    || (case when (select item_count from stats)=0 and coalesce(((select data from fcb)->>'has_fcb')::boolean,false)
      then jsonb_build_array('FCB detectado, mas os itens técnicos ainda não foram importados.') else '[]'::jsonb end)
    || (case when (select items_without_workflow from stats)>0
      then jsonb_build_array('Há itens sem workflow.') else '[]'::jsonb end)
    || (case when (select missing_material from stats)>0
      then jsonb_build_array('Há itens FCB sem material.') else '[]'::jsonb end),
  'non_blocking_warnings',
    (case when (select missing_weight from stats)>0
      then jsonb_build_array('Há itens FCB sem peso. O cadastro pode seguir; complete o peso quando disponível.') else '[]'::jsonb end),
  'warnings',jsonb_build_object(
    'missing_weight',(select missing_weight from stats),
    'missing_material',(select missing_material from stats),
    'unclassified_items',(select unclassified_items from stats),
    'provisional_breakdown',(select provisional_breakdown from stats),
    'documents_without_revision',(select missing_revision from docs),
    'provisional_drawing_items',(select count(*) from ops_core.items i join p on i.project_id=p.id
      where not i.removed_from_scope and coalesce(i.source_metadata->>'fcb_superseded','false')='true'),
    'tracking_mismatch',case when (select data from tracking)->>'status'='mismatch' then 1 else 0 end
  ),
  'ready_for_cutover',(
    coalesce(((select data from fcb)->>'has_fcb')::boolean,false)
    and (select item_count from stats)>0
    and (select items_without_workflow from stats)=0
    and (select missing_material from stats)=0
  ),
  'generated_at',now()
) from stats,docs;
$$;

grant execute on function public.ops_core_project_validation_report(text) to service_role;
