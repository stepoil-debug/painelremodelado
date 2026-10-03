
create or replace function public.ops_core_fcb_status(p_project_key text)
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core,ops_panel
as $$
with x as (
  select
    d.source_row_id,
    d.drawing_number,
    d.document_title,
    d.current_revision,
    d.current_status,
    d.source_version,
    d.synced_at
  from ops_panel.drawings_current d
  where ops_core.normalize_project_core(d.project_key)=ops_core.normalize_project_core(p_project_key)
    and d.is_fcb=true
)
select jsonb_build_object(
  'project_core',ops_core.normalize_project_core(p_project_key),
  'fcb_count',count(*),
  'has_fcb',count(*)>0,
  'status',case when count(*)>0 then 'detected' else 'awaiting_fcb' end,
  'latest_revision',(
    select current_revision
    from x
    order by ops_core.revision_rank(current_revision) desc,source_version desc nulls last,synced_at desc nulls last
    limit 1
  ),
  'latest_source_row_id',(
    select source_row_id
    from x
    order by ops_core.revision_rank(current_revision) desc,source_version desc nulls last,synced_at desc nulls last
    limit 1
  ),
  'documents',coalesce(jsonb_agg(to_jsonb(x) order by ops_core.revision_rank(current_revision),source_row_id),'[]'::jsonb)
)
from x;
$$;

create or replace function public.ops_core_project_validation_report(p_project_key text)
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core
as $$
with p as (
  select *
  from ops_core.projects
  where region='BR' and project_core=ops_core.normalize_project_core(p_project_key)
  limit 1
),
stats as (
  select
    count(*) item_count,
    count(*) filter(where i.weight_kg is null) missing_weight,
    count(*) filter(where i.material is null or btrim(i.material)='') missing_material,
    count(*) filter(where i.item_type='OTHER') unclassified_items,
    count(*) filter(where coalesce((i.source_metadata->>'provisional_breakdown')::boolean,false)) provisional_breakdown,
    count(*) filter(where not exists(
      select 1 from ops_core.item_stages s where s.item_id=i.id
    )) items_without_workflow
  from ops_core.items i
  join p on i.project_id=p.id
  where not i.removed_from_scope
),
docs as (
  select
    count(*) document_count,
    count(*) filter(where current_revision is null or current_revision='UNSPECIFIED') missing_revision,
    count(*) filter(where source_row_id is not null) source_linked
  from ops_core.documents d
  join p on d.project_id=p.id
),
fcb as (
  select public.ops_core_fcb_status(p_project_key) data
)
select jsonb_build_object(
  'project',(select to_jsonb(p) from p),
  'items',to_jsonb(stats),
  'documents',to_jsonb(docs),
  'fcb',(select data from fcb),
  'blocking_issues',
    (case when not coalesce(((select data from fcb)->>'has_fcb')::boolean,false)
      then jsonb_build_array('FCB vigente ainda não disponível. O cadastro técnico deve aguardar o FCB.')
      else '[]'::jsonb end)
    ||
    (case when (select item_count from stats)=0
      and coalesce(((select data from fcb)->>'has_fcb')::boolean,false)
      then jsonb_build_array('FCB detectado, mas os itens técnicos ainda não foram importados.')
      else '[]'::jsonb end)
    ||
    (case when (select items_without_workflow from stats)>0
      then jsonb_build_array('Há itens sem workflow.')
      else '[]'::jsonb end),
  'warnings',jsonb_build_object(
    'missing_weight',(select missing_weight from stats),
    'missing_material',(select missing_material from stats),
    'unclassified_items',(select unclassified_items from stats),
    'provisional_breakdown',(select provisional_breakdown from stats),
    'documents_without_revision',(select missing_revision from docs),
    'provisional_drawing_items',(
      select count(*)
      from ops_core.items i
      join p on i.project_id=p.id
      where not i.removed_from_scope
        and coalesce(i.source_metadata->>'candidate_materialized','false')='true'
    )
  ),
  'ready_for_cutover',(
    coalesce(((select data from fcb)->>'has_fcb')::boolean,false)
    and (select item_count from stats)>0
    and (select items_without_workflow from stats)=0
    and (select missing_weight from stats)=0
    and (select missing_material from stats)=0
  ),
  'generated_at',now()
)
from stats,docs;
$$;

create or replace function ops_core.register_candidate_automatically(
  p_project_core text,
  p_actor text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,public
as $$
declare
  v_core text:=ops_core.normalize_project_core(p_project_core);
  v_fcb jsonb;
  v_has_fcb boolean:=false;
  v_existing uuid;
  v_materialized jsonb;
  v_report jsonb;
  v_cutover jsonb;
  v_ready boolean:=false;
begin
  v_fcb:=public.ops_core_fcb_status(v_core);
  v_has_fcb:=coalesce((v_fcb->>'has_fcb')::boolean,false);

  select id into v_existing
  from ops_core.projects
  where region='BR' and project_core=v_core
  limit 1;

  if not v_has_fcb then
    update ops_core.registration_candidates
    set
      candidate_status='validation_required',
      suggested_data=coalesce(suggested_data,'{}'::jsonb)
        || jsonb_build_object(
          'fcb',
          jsonb_build_object(
            'status','awaiting_fcb',
            'checked_at',now(),
            'source','drawing_documentation_control'
          )
        ),
      last_seen_at=now()
    where region='BR' and project_core=v_core;

    if v_existing is not null then
      update ops_core.projects
      set
        validation_status='awaiting_fcb',
        source_metadata=coalesce(source_metadata,'{}'::jsonb)
          || jsonb_build_object(
            'technical_authority','FCB',
            'fcb_status','awaiting_fcb',
            'provisional_drawing_items',true
          ),
        updated_at=now()
      where id=v_existing;

      update ops_core.items
      set
        source_metadata=coalesce(source_metadata,'{}'::jsonb)
          || jsonb_build_object(
            'technical_authority','DRAWING_PROVISIONAL',
            'awaiting_fcb',true
          ),
        updated_at=now()
      where project_id=v_existing
        and not removed_from_scope;
    end if;

    return jsonb_build_object(
      'ok',true,
      'registered',v_existing is not null,
      'activated',false,
      'awaiting_fcb',true,
      'fcb',v_fcb,
      'message','FCB vigente ainda não disponível. Nenhum dado provisório será tratado como cadastro técnico final.'
    );
  end if;

  v_materialized:=ops_core.materialize_candidate(v_core,p_actor);

  update ops_core.projects
  set
    validation_status='fcb_detected',
    source_metadata=coalesce(source_metadata,'{}'::jsonb)
      || jsonb_build_object(
        'technical_authority','FCB',
        'fcb_status','detected',
        'fcb_revision',v_fcb->>'latest_revision',
        'fcb_source_row_id',v_fcb->>'latest_source_row_id'
      ),
    updated_at=now()
  where region='BR' and project_core=v_core;

  v_report:=public.ops_core_project_validation_report(v_core);
  v_ready:=coalesce((v_report->>'ready_for_cutover')::boolean,false);

  if v_ready then
    v_cutover:=ops_core.project_cutover(v_core,p_actor);
    return jsonb_build_object(
      'ok',true,
      'registered',true,
      'activated',true,
      'awaiting_fcb',false,
      'materialized',v_materialized,
      'report',v_report,
      'cutover',v_cutover,
      'fcb',v_fcb
    );
  end if;

  return jsonb_build_object(
    'ok',true,
    'registered',true,
    'activated',false,
    'awaiting_fcb',false,
    'fcb_detected',true,
    'materialized',v_materialized,
    'report',v_report,
    'fcb',v_fcb
  );
end $$;

grant execute on function public.ops_core_fcb_status(text) to service_role;
grant execute on function public.ops_core_project_validation_report(text) to service_role;
grant execute on function ops_core.register_candidate_automatically(text,text) to service_role;
