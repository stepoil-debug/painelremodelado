alter table ops_core.items
  add column if not exists parent_item_id uuid;

alter table ops_core.items
  drop constraint if exists items_parent_item_id_fkey;

alter table ops_core.items
  add constraint items_parent_item_id_fkey
  foreign key (parent_item_id) references ops_core.items(id) on delete set null;

create index if not exists idx_ops_core_items_parent
  on ops_core.items(project_id,parent_item_id,removed_from_scope);

create or replace function ops_core.create_manual_project(
  p_project_core text,
  p_display_code text default null,
  p_client text default null,
  p_vessel text default null,
  p_pm text default null,
  p_project_type text default null,
  p_priority text default 'Normal',
  p_actor text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,public
as $$
declare
  v_core text := ops_core.normalize_project_core(p_project_core);
  v_display text := coalesce(nullif(btrim(p_display_code),''),'BSP-'||v_core);
  v_project ops_core.projects%rowtype;
begin
  if v_core is null or not ops_core.is_valid_project_core(v_core) then
    raise exception 'Código de BSP inválido. Use, por exemplo, 25-708.';
  end if;

  if exists(select 1 from ops_core.projects where region='BR' and project_core=v_core) then
    raise exception 'A BSP % já está cadastrada.',v_core;
  end if;

  insert into ops_core.projects(
    region,project_core,project_prefix,display_code,client,vessel,pm,
    project_type,project_status,priority,source_mode,validation_status,
    source_metadata
  )
  values(
    'BR',v_core,ops_core.detect_prefix(v_display),v_display,
    nullif(btrim(p_client),''),nullif(btrim(p_vessel),''),nullif(btrim(p_pm),''),
    nullif(btrim(p_project_type),''),'ACTIVE',nullif(btrim(p_priority),''),
    'ops_core','validation_required',
    jsonb_build_object(
      'manual_registration',true,
      'registered_by',coalesce(nullif(p_actor,''),'system'),
      'registered_at',now()
    )
  )
  returning * into v_project;

  perform ops_core.register_project_alias(v_project.id,'BR',v_project.project_core,'manual');
  perform ops_core.register_project_alias(v_project.id,'BR',v_project.display_code,'manual');

  insert into ops_core.registration_candidates(
    region,project_core,display_code,candidate_status,source_systems,
    suggested_data,validated_project_id
  )
  values(
    'BR',v_project.project_core,v_project.display_code,'validation_required',array['manual']::text[],
    jsonb_build_object(
      'manual_registration',true,
      'project',jsonb_build_object(
        'client',v_project.client,'vessel',v_project.vessel,'pm',v_project.pm,
        'project_type',v_project.project_type
      )
    ),v_project.id
  )
  on conflict(region,project_core) do update
  set display_code=excluded.display_code,
      source_systems=array['manual']::text[],
      suggested_data=excluded.suggested_data,
      validated_project_id=excluded.validated_project_id,
      last_seen_at=now();

  insert into ops_core.audit_events(
    project_id,entity_type,entity_id,action,actor_email,source_system,after_data
  )
  values(
    v_project.id,'project',v_project.id::text,'project.created_manually',
    coalesce(nullif(p_actor,''),'system'),'ops_core',to_jsonb(v_project)
  );

  return jsonb_build_object(
    'ok',true,
    'project_id',v_project.id,
    'project_core',v_project.project_core,
    'display_code',v_project.display_code,
    'manual_registration',true
  );
end $$;

create or replace function ops_core.upsert_manual_item(
  p_project_key text,
  p_item jsonb,
  p_actor text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,public
as $$
declare
  v_result jsonb;
  v_item_id uuid;
  v_parent_id uuid;
  v_project_id uuid;
  v_before ops_core.items%rowtype;
  v_after ops_core.items%rowtype;
  v_item_id_text text := nullif(p_item->>'id','');
  v_parent_id_text text := nullif(p_item->>'parent_item_id','');
  v_parent_key text := nullif(p_item->>'parent_item_key','');
  v_parent_item ops_core.items%rowtype;
begin
  if p_item is null or jsonb_typeof(p_item) <> 'object' then
    raise exception 'Dados do item inválidos.';
  end if;

  v_result := ops_core.upsert_project_item(
    p_project_key,
    case when v_item_id_text is null then null else v_item_id_text::uuid end,
    coalesce(nullif(p_item->>'item_key',''),nullif(p_item->>'tag_number','')),
    p_item->>'iso_code',
    p_item->>'spool_code',
    p_item->>'drawing_code',
    coalesce(nullif(p_item->>'item_type',''),'OTHER'),
    p_item->>'description',
    p_item->>'line_number',
    p_item->>'material',
    p_item->>'size',
    p_item->>'schedule',
    public.tracking_parse_number(p_item->>'weight_kg'),
    public.tracking_parse_number(p_item->>'painting_m2'),
    public.tracking_parse_number(p_item->>'quantity'),
    public.tracking_parse_number(p_item->>'joints'),
    case lower(coalesce(p_item->>'requires_3d','')) when 'true' then true when 'yes' then true when 'sim' then true when 'false' then false when 'no' then false when 'nao' then false else null end,
    case lower(coalesce(p_item->>'requires_assembly_simulation','')) when 'true' then true when 'yes' then true when 'sim' then true when 'false' then false when 'no' then false when 'nao' then false else null end,
    p_actor
  );

  v_item_id := (v_result->'item'->>'id')::uuid;
  select * into v_after from ops_core.items where id=v_item_id;
  v_project_id := v_after.project_id;
  select * into v_before from ops_core.items where id=v_item_id;

  if v_parent_id_text is not null then
    v_parent_id := v_parent_id_text::uuid;
  elsif v_parent_key is not null then
    select * into v_parent_item
    from ops_core.items
    where project_id=v_project_id
      and not removed_from_scope
      and ops_core.normalize_item_key(coalesce(item_key,iso_code,spool_code,drawing_code))=ops_core.normalize_item_key(v_parent_key)
    limit 1;
    v_parent_id := v_parent_item.id;
  end if;

  if v_parent_id is not null then
    select * into v_parent_item
    from ops_core.items
    where id=v_parent_id and project_id=v_project_id and not removed_from_scope;
    if not found then raise exception 'A tag pai não pertence à mesma BSP.'; end if;
    if v_parent_id=v_item_id then raise exception 'Um item não pode ser pai dele mesmo.'; end if;
  end if;

  update ops_core.items
  set parent_item_id=v_parent_id,
      tag_number=case when p_item ? 'tag_number' then nullif(btrim(p_item->>'tag_number'),'') else tag_number end,
      source_metadata=(source_metadata-'manual_hierarchy') || jsonb_build_object(
        'manual_hierarchy',true,
        'parent_item_id',v_parent_id,
        'edited_by',coalesce(nullif(p_actor,''),'system')
      ),
      updated_at=now()
  where id=v_item_id;

  select * into v_after from ops_core.items where id=v_item_id;
  insert into ops_core.audit_events(
    project_id,item_id,entity_type,entity_id,action,actor_email,source_system,before_data,after_data
  )
  values(
    v_project_id,v_item_id,'item',v_item_id::text,'item.hierarchy_updated',
    coalesce(nullif(p_actor,''),'system'),'ops_core',to_jsonb(v_before),to_jsonb(v_after)
  );

  return jsonb_build_object('ok',true,'item',to_jsonb(v_after));
end $$;

create or replace function public.ops_core_create_manual_project(
  p_project_core text,
  p_display_code text default null,
  p_client text default null,
  p_vessel text default null,
  p_pm text default null,
  p_project_type text default null,
  p_priority text default 'Normal',
  p_actor text default 'system'
)
returns jsonb
language sql
security definer
set search_path=public,ops_core
as $$ select ops_core.create_manual_project($1,$2,$3,$4,$5,$6,$7,$8); $$;

create or replace function public.ops_core_upsert_manual_item(
  p_project_key text,
  p_item jsonb,
  p_actor text default 'system'
)
returns jsonb
language sql
security definer
set search_path=public,ops_core
as $$ select ops_core.upsert_manual_item($1,$2,$3); $$;

create or replace function public.ops_core_list_candidates(
  p_status text default 'validation_required',
  p_limit integer default 200
)
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core
as $$
select coalesce(
  jsonb_agg(to_jsonb(q) order by q.last_seen_at desc,q.project_core),
  '[]'::jsonb
)
from (
  select
    c.*,
    p.source_mode,
    p.validation_status,
    p.client,
    p.vessel,
    p.pm,
    p.project_status,
    coalesce((p.source_metadata->>'manual_registration')::boolean,false) manual_registration,
    (select count(*) from ops_core.items i where i.project_id=p.id and not i.removed_from_scope) item_count,
    (select count(*) from ops_core.documents d where d.project_id=p.id) document_count
  from ops_core.registration_candidates c
  left join ops_core.projects p
    on p.region=c.region and p.project_core=c.project_core
  where ops_core.is_valid_project_core(c.project_core)
    and (
      p_status is null
      or p_status=''
      or c.candidate_status=p_status
      or (p_status='validation_required' and coalesce((p.source_metadata->>'manual_registration')::boolean,false))
    )
  order by c.last_seen_at desc,c.project_core
  limit greatest(1,least(coalesce(p_limit,200),1000))
) q;
$$;

revoke all on function public.ops_core_create_manual_project(text,text,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.ops_core_upsert_manual_item(text,jsonb,text) from public,anon,authenticated;
revoke all on function public.ops_core_list_candidates(text,integer) from public,anon,authenticated;

grant execute on function public.ops_core_create_manual_project(text,text,text,text,text,text,text,text) to service_role;
grant execute on function public.ops_core_upsert_manual_item(text,jsonb,text) to service_role;
grant execute on function public.ops_core_list_candidates(text,integer) to service_role;
