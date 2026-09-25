-- FCB-first registration boundary.
-- Drawing/FCB is the technical authority. Tracking remains a read-only
-- validation source during the migration and is never mutated by these paths.

create or replace function ops_core.detect_fcb_text(p_value text)
returns boolean
language sql
immutable
as $$
  select translate(lower(coalesce(p_value,'')),
    'áàâãäéèêëíìîïóòôõöúùûüç',
    'aaaaaeeeeiiiiooooouuuuc'
  ) ~ '(^|[^a-z0-9])fcb([^a-z0-9]|$)|fabrication[[:space:]]+control[[:space:]]+book|controle[[:space:]]+de[[:space:]]+fabricacao|control[[:space:]]+book';
$$;

create or replace function ops_core.detect_fcb_cells(p_raw jsonb)
returns boolean
language sql
immutable
as $$
  select exists(
    select 1
    from jsonb_each_text(coalesce(p_raw,'{}'::jsonb)) cell
    where ops_core.detect_fcb_text(cell.key || ' ' || cell.value)
  );
$$;

-- Backfill rows that were already synchronized before the broader FCB
-- recognition was added. No row is deleted or re-keyed.
update ops_panel.drawings_current d
set is_fcb=true
where coalesce(d.is_fcb,false)=false
  and ops_core.detect_fcb_cells(d.raw_cells);

create table if not exists ops_core.fcb_project_profiles (
  id uuid primary key default gen_random_uuid(),
  region text not null default 'BR',
  project_core text not null,
  project_id uuid references ops_core.projects(id) on delete set null,
  fcb_count integer not null default 0,
  latest_revision text,
  latest_source_row_id bigint,
  source_version bigint,
  technical_profile jsonb not null default '{}'::jsonb,
  documents jsonb not null default '[]'::jsonb,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(region, project_core)
);

create table if not exists ops_core.project_source_validation (
  id uuid primary key default gen_random_uuid(),
  region text not null default 'BR',
  project_core text not null,
  project_id uuid references ops_core.projects(id) on delete set null,
  source_system text not null,
  status text not null default 'not_checked',
  source_count integer not null default 0,
  core_count integer not null default 0,
  missing_in_source jsonb not null default '[]'::jsonb,
  source_only jsonb not null default '[]'::jsonb,
  mismatches jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now(),
  unique(region, project_core, source_system)
);

create index if not exists idx_ops_core_fcb_profiles_project
  on ops_core.fcb_project_profiles(region, project_core);
create index if not exists idx_ops_core_source_validation_project
  on ops_core.project_source_validation(region, project_core, source_system);

alter table ops_core.fcb_project_profiles enable row level security;
alter table ops_core.project_source_validation enable row level security;
revoke all on table ops_core.fcb_project_profiles from public, anon, authenticated;
revoke all on table ops_core.project_source_validation from public, anon, authenticated;
grant select, insert, update, delete on table ops_core.fcb_project_profiles to service_role;
grant select, insert, update, delete on table ops_core.project_source_validation to service_role;

create or replace function ops_core.fcb_cell(p_raw jsonb, p_pattern text)
returns text
language sql
immutable
as $$
  select nullif(btrim(x.value), '')
  from jsonb_each_text(coalesce(p_raw, '{}'::jsonb)) x
  where regexp_replace(lower(x.key), '[^a-z0-9]+', '', 'g') like
        '%' || regexp_replace(lower(coalesce(p_pattern, '')), '[^a-z0-9]+', '', 'g') || '%'
  order by length(x.key), x.key
  limit 1;
$$;

create or replace function ops_core.fcb_flag(p_raw jsonb, p_pattern text)
returns boolean
language sql
immutable
as $$
  select case
    when lower(regexp_replace(coalesce(ops_core.fcb_cell(p_raw,p_pattern),''), '[^a-z0-9]+', '', 'g'))
      in ('sim','yes','y','true','1','required','x') then true
    when lower(regexp_replace(coalesce(ops_core.fcb_cell(p_raw,p_pattern),''), '[^a-z0-9]+', '', 'g'))
      in ('nao','no','n','false','0','notrequired') then false
    else null
  end;
$$;

create or replace function ops_core.refresh_fcb_project_profile(p_project_core text)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,ops_panel,public
as $$
declare
  v_core text := ops_core.normalize_project_core(p_project_core);
  v_project_id uuid;
  v_count integer := 0;
  v_latest_revision text;
  v_latest_row bigint;
  v_latest_version bigint;
  v_profile jsonb;
  v_documents jsonb;
begin
  select p.id into v_project_id
  from ops_core.projects p
  where p.region='BR' and p.project_core=v_core
  limit 1;

  select count(*)::integer into v_count
  from ops_panel.drawings_current d
  where d.is_fcb=true
    and ops_core.normalize_project_core(d.project_key)=v_core;

  select d.current_revision,d.source_row_id,d.source_version
    into v_latest_revision,v_latest_row,v_latest_version
  from ops_panel.drawings_current d
  where d.is_fcb=true
    and ops_core.normalize_project_core(d.project_key)=v_core
  order by ops_core.revision_rank(d.current_revision) desc,
           d.source_version desc nulls last,
           d.synced_at desc nulls last,
           d.source_row_id desc
  limit 1;

  select jsonb_build_object(
    'technical_authority','FCB',
    'fcb_count',v_count,
    'requires_assembly_simulation',count(*) filter(where ops_core.fcb_flag(d.raw_cells,'assembly')),
    'requires_3d_scan',count(*) filter(where ops_core.fcb_flag(d.raw_cells,'3dscan')),
    'requires_fbe',count(*) filter(where ops_core.fcb_flag(d.raw_cells,'fbe')),
    'requires_hdg',count(*) filter(where ops_core.fcb_flag(d.raw_cells,'hdg')),
    'requires_th',count(*) filter(where ops_core.fcb_flag(d.raw_cells,'hydro') or ops_core.fcb_flag(d.raw_cells,'th')),
    'requires_rx',count(*) filter(where ops_core.fcb_flag(d.raw_cells,'rx') or ops_core.fcb_flag(d.raw_cells,'nde')),
    'checked_at',now()
  ) into v_profile
  from ops_panel.drawings_current d
  where d.is_fcb=true
    and ops_core.normalize_project_core(d.project_key)=v_core;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.revision_rank,x.source_row_id),'[]'::jsonb)
    into v_documents
  from (
    select d.source_row_id,d.source_version,d.project_key,d.drawing_number,d.document_title,
           d.current_revision,d.current_status,d.raw_cells,
           ops_core.revision_rank(d.current_revision) revision_rank
    from ops_panel.drawings_current d
    where d.is_fcb=true
      and ops_core.normalize_project_core(d.project_key)=v_core
  ) x;

  insert into ops_core.fcb_project_profiles(
    region,project_core,project_id,fcb_count,latest_revision,latest_source_row_id,
    source_version,technical_profile,documents,checked_at,updated_at
  ) values (
    'BR',v_core,v_project_id,v_count,v_latest_revision,v_latest_row,v_latest_version,
    coalesce(v_profile,'{}'::jsonb),coalesce(v_documents,'[]'::jsonb),now(),now()
  )
  on conflict(region,project_core) do update set
    project_id=excluded.project_id,
    fcb_count=excluded.fcb_count,
    latest_revision=excluded.latest_revision,
    latest_source_row_id=excluded.latest_source_row_id,
    source_version=excluded.source_version,
    technical_profile=excluded.technical_profile,
    documents=excluded.documents,
    checked_at=excluded.checked_at,
    updated_at=now();

  return jsonb_build_object(
    'project_core',v_core,
    'fcb_count',v_count,
    'latest_revision',v_latest_revision,
    'latest_source_row_id',v_latest_row,
    'technical_profile',coalesce(v_profile,'{}'::jsonb),
    'checked_at',now()
  );
end;
$$;

create or replace function ops_core.refresh_project_tracking_validation(p_project_core text)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,ops_panel,public
as $$
declare
  v_core text := ops_core.normalize_project_core(p_project_core);
  v_project_id uuid;
  v_fcb_count integer := 0;
  v_fcb_items integer := 0;
  v_tracking_items integer := 0;
  v_missing jsonb := '[]'::jsonb;
  v_source_only jsonb := '[]'::jsonb;
  v_status text := 'not_checked';
begin
  select p.id into v_project_id
  from ops_core.projects p
  where p.region='BR' and p.project_core=v_core
  limit 1;

  select count(*)::integer into v_fcb_count
  from ops_panel.drawings_current d
  where d.is_fcb=true and ops_core.normalize_project_core(d.project_key)=v_core;

  with fcb as (
    select distinct coalesce(
      ops_core.normalize_item_key(ops_core.clean_drawing_identity(d.drawing_number)),
      ops_core.normalize_item_key(nullif(btrim(d.document_title),'')),
      'DRAWING'||d.source_row_id::text
    ) item_key
    from ops_panel.drawings_current d
    where d.is_fcb=true and ops_core.normalize_project_core(d.project_key)=v_core
      and (
        upper(coalesce(d.raw_cells->>'UNIT','')) like '%SPOOL%'
        or upper(coalesce(d.raw_cells->>'UNIT','')) like '%SUPPORT%'
        or upper(coalesce(d.raw_cells->>'UNIT','')) like '%STR%'
        or upper(coalesce(d.raw_cells->>'UNIT','')) like '%KG%'
        or upper(coalesce(d.drawing_number,'')) like '%-ISO-%'
        or upper(coalesce(d.drawing_number,'')) like '%-SUP-%'
        or upper(coalesce(d.drawing_number,'')) like '%-STR-%'
      )
  ) select count(*)::integer into v_fcb_items from fcb;

  with tracking as (
    select distinct ops_core.normalize_item_key(t.item_key) item_key
    from ops_panel.tracking_current_items t
    where ops_core.normalize_project_core(t.project_key)=v_core
      and nullif(ops_core.normalize_item_key(t.item_key),'') is not null
  ) select count(*)::integer into v_tracking_items from tracking;

  if v_fcb_count=0 then
    v_status:='not_checked';
  elsif v_tracking_items=0 then
    v_status:='not_found';
  else
    with fcb as (
      select distinct coalesce(
        ops_core.normalize_item_key(ops_core.clean_drawing_identity(d.drawing_number)),
        ops_core.normalize_item_key(nullif(btrim(d.document_title),'')),
        'DRAWING'||d.source_row_id::text
      ) item_key
      from ops_panel.drawings_current d
      where d.is_fcb=true and ops_core.normalize_project_core(d.project_key)=v_core
        and (
          upper(coalesce(d.raw_cells->>'UNIT','')) like '%SPOOL%'
          or upper(coalesce(d.raw_cells->>'UNIT','')) like '%SUPPORT%'
          or upper(coalesce(d.raw_cells->>'UNIT','')) like '%STR%'
          or upper(coalesce(d.raw_cells->>'UNIT','')) like '%KG%'
          or upper(coalesce(d.drawing_number,'')) like '%-ISO-%'
          or upper(coalesce(d.drawing_number,'')) like '%-SUP-%'
          or upper(coalesce(d.drawing_number,'')) like '%-STR-%'
        )
    ), tracking as (
      select distinct ops_core.normalize_item_key(t.item_key) item_key
      from ops_panel.tracking_current_items t
      where ops_core.normalize_project_core(t.project_key)=v_core
    )
    select
      coalesce(jsonb_agg(f.item_key order by f.item_key) filter(where t.item_key is null),'[]'::jsonb),
      coalesce(jsonb_agg(t.item_key order by t.item_key) filter(where f.item_key is null),'[]'::jsonb)
    into v_missing,v_source_only
    from fcb f full join tracking t on t.item_key=f.item_key;
    v_status:=case when jsonb_array_length(v_missing)=0 and jsonb_array_length(v_source_only)=0 then 'matched' else 'mismatch' end;
  end if;

  insert into ops_core.project_source_validation(
    region,project_core,project_id,source_system,status,source_count,core_count,
    missing_in_source,source_only,mismatches,metadata,checked_at
  ) values (
    'BR',v_core,v_project_id,'tracking',v_status,v_tracking_items,v_fcb_items,
    v_missing,v_source_only,'[]'::jsonb,
    jsonb_build_object(
      'fcb_is_authority',true,
      'tracking_is_validation_only',true,
      'fcb_document_count',v_fcb_count,
      'checked_at',now()
    ),now()
  )
  on conflict(region,project_core,source_system) do update set
    project_id=excluded.project_id,
    status=excluded.status,
    source_count=excluded.source_count,
    core_count=excluded.core_count,
    missing_in_source=excluded.missing_in_source,
    source_only=excluded.source_only,
    mismatches=excluded.mismatches,
    metadata=excluded.metadata,
    checked_at=excluded.checked_at;

  return jsonb_build_object(
    'source_system','tracking',
    'status',v_status,
    'tracking_item_count',v_tracking_items,
    'fcb_item_count',v_fcb_items,
    'missing_in_tracking',v_missing,
    'tracking_only',v_source_only,
    'fcb_is_authority',true,
    'tracking_is_validation_only',true,
    'checked_at',now()
  );
end;
$$;

create or replace function ops_core.enforce_fcb_first_registration()
returns jsonb
language plpgsql
security definer
set search_path=ops_core,ops_panel,public
as $$
declare
  r record;
  v_profile jsonb;
  v_tracking jsonb;
  v_detected integer := 0;
  v_waiting integer := 0;
begin
  for r in
    select distinct ops_core.normalize_project_core(d.project_key) project_core
    from ops_panel.drawings_current d
    where d.is_fcb=true
      and ops_core.is_valid_project_core(ops_core.normalize_project_core(d.project_key))
  loop
    v_profile:=ops_core.refresh_fcb_project_profile(r.project_core);
    v_tracking:=ops_core.refresh_project_tracking_validation(r.project_core);

    update ops_core.registration_candidates c
    set source_systems=array( select distinct unnest(array_append(coalesce(c.source_systems,'{}'::text[]),'fcb')) order by 1 ),
        suggested_data=coalesce(c.suggested_data,'{}'::jsonb)
          || jsonb_build_object(
            'fcb',v_profile || jsonb_build_object('status','detected'),
            'tracking_validation',v_tracking,
            'technical_authority','FCB',
            'panel_mode',jsonb_build_object('mode','observation','panel_mutation_allowed',false,'checked_at',now()),
            'detection',jsonb_build_object(
              'new_project',not exists(select 1 from ops_core.projects p where p.region=c.region and p.project_core=c.project_core and p.active),
              'source','fcb',
              'checked_current_tracking',true,
              'detected_at',coalesce(c.suggested_data #>> '{detection,detected_at}',now()::text)
            ),
            'fcb_first',true
          ),
        candidate_status=case when c.validated_project_id is null then 'validation_required' else c.candidate_status end,
        last_seen_at=now()
    where c.region='BR' and c.project_core=r.project_core;
    v_detected:=v_detected+1;
  end loop;

  update ops_core.registration_candidates c
  set suggested_data=coalesce(c.suggested_data,'{}'::jsonb)
        || jsonb_build_object(
          'fcb',jsonb_build_object('status','awaiting_fcb','checked_at',now(),'source','drawing_documentation_control'),
          'technical_authority','FCB',
          'fcb_first',true,
          'panel_mode',jsonb_build_object('mode','observation','panel_mutation_allowed',false,'checked_at',now())
        ),
      last_seen_at=now()
  where c.region='BR'
    and c.validated_project_id is null
    and 'drawing'=any(coalesce(c.source_systems,'{}'::text[]))
    and not exists (
      select 1 from ops_panel.drawings_current d
      where d.is_fcb=true and ops_core.normalize_project_core(d.project_key)=c.project_core
    );
  get diagnostics v_waiting=row_count;

  return jsonb_build_object('ok',true,'fcb_projects',v_detected,'awaiting_fcb',v_waiting,'refreshed_at',now());
end;
$$;

create or replace function ops_core.materialize_fcb_candidate(
  p_project_core text,
  p_actor text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,ops_panel,public
as $$
declare
  v_core text:=ops_core.normalize_project_core(p_project_core);
  c ops_core.registration_candidates%rowtype;
  p ops_core.projects%rowtype;
  v_fcb jsonb;
  v_created boolean:=false;
  v_items integer:=0;
  v_documents integer:=0;
begin
  v_fcb:=public.ops_core_fcb_status(v_core);
  if not coalesce((v_fcb->>'has_fcb')::boolean,false) then
    return jsonb_build_object('ok',true,'registered',false,'awaiting_fcb',true,'fcb',v_fcb,'technical_authority','FCB');
  end if;

  select * into c from ops_core.registration_candidates
  where region='BR' and project_core=v_core for update;
  if not found then raise exception 'Candidato % não encontrado.',p_project_core; end if;

  select * into p from ops_core.projects
  where region='BR' and project_core=v_core limit 1;

  if not found then
    insert into ops_core.projects(
      region,project_core,project_prefix,display_code,client,vessel,pm,customer_po,
      project_status,acceptance_date,contractual_date,deadline_date,drawing_approval_date,
      source_mode,validation_status,source_metadata
    ) values (
      'BR',v_core,ops_core.detect_prefix(c.display_code),coalesce(nullif(c.display_code,''),v_core),
      coalesce(nullif(c.suggested_data #>> '{wip,client}',''),nullif(c.suggested_data #>> '{job_order,client}',''),nullif(c.suggested_data #>> '{drawing,client}','')),
      nullif(c.suggested_data #>> '{wip,vessel}',''),
      coalesce(nullif(c.suggested_data #>> '{wip,pm}',''),nullif(c.suggested_data #>> '{job_order,pm}',''),nullif(c.suggested_data #>> '{drawing,pm}','')),
      coalesce(nullif(c.suggested_data #>> '{wip,customer_po}',''),nullif(c.suggested_data #>> '{job_order,po_numbers}',''),nullif(c.suggested_data #>> '{drawing,po_number}','')),
      coalesce(nullif(c.suggested_data #>> '{wip,project_status}',''),'PENDING VALIDATION'),
      public.tracking_parse_date(c.suggested_data #>> '{wip,acceptance_date}'),
      public.tracking_parse_date(c.suggested_data #>> '{wip,contractual_date}'),
      public.tracking_parse_date(c.suggested_data #>> '{wip,deadline_date}'),
      public.tracking_parse_date(c.suggested_data #>> '{wip,drawing_approval_date}'),
      'pending_validation','validation_required',
      jsonb_build_object('created_from_candidate',c.id,'created_by',coalesce(nullif(p_actor,''),'system'),'technical_authority','FCB','fcb',v_fcb,'panel_mode','observation','panel_mutation_allowed',false)
    ) returning * into p;
    v_created:=true;
  else
    update ops_core.projects set
      client=coalesce(p.client,nullif(c.suggested_data #>> '{wip,client}',''),nullif(c.suggested_data #>> '{job_order,client}','')),
      vessel=coalesce(p.vessel,nullif(c.suggested_data #>> '{wip,vessel}','')),
      pm=coalesce(p.pm,nullif(c.suggested_data #>> '{wip,pm}',''),nullif(c.suggested_data #>> '{job_order,pm}','')),
      customer_po=coalesce(p.customer_po,nullif(c.suggested_data #>> '{wip,customer_po}',''),nullif(c.suggested_data #>> '{job_order,po_numbers}','')),
      validation_status='validation_required',
      source_metadata=coalesce(p.source_metadata,'{}'::jsonb)||jsonb_build_object('technical_authority','FCB','fcb',v_fcb,'panel_mode','observation','panel_mutation_allowed',false),
      updated_at=now()
    where id=p.id
    returning * into p;
  end if;

  perform ops_core.register_project_alias(p.id,'BR',p.project_core,'canonical');
  perform ops_core.register_project_alias(p.id,'BR',p.display_code,'candidate');

  -- Preserve old rows for audit, but make them explicitly non-authoritative.
  update ops_core.items i set source_metadata=coalesce(i.source_metadata,'{}'::jsonb)||jsonb_build_object('technical_authority','DRAWING_PROVISIONAL','fcb_superseded',true,'fcb_superseded_at',now()),updated_at=now()
  where i.project_id=p.id and not i.removed_from_scope
    and coalesce(i.source_metadata->>'technical_authority','')<>'FCB'
    and coalesce(i.source_metadata->>'candidate_materialized','false')='true';
  update ops_core.documents d set metadata=coalesce(d.metadata,'{}'::jsonb)||jsonb_build_object('technical_authority','DRAWING_PROVISIONAL','fcb_superseded',true,'fcb_superseded_at',now()),updated_at=now()
  where d.project_id=p.id and d.source_system='drawing'
    and not exists(select 1 from ops_panel.drawings_current f where f.is_fcb=true and f.source_row_id=d.source_row_id);

  with rows as (
    select distinct on (item_key)
      d.source_row_id,d.source_version,d.raw_cells,
      ops_core.clean_drawing_identity(d.drawing_number) drawing_number,
      nullif(btrim(d.document_title),'') document_title,
      coalesce(ops_core.clean_drawing_identity(d.drawing_number),nullif(btrim(d.document_title),''),'DRAWING-'||d.source_row_id::text) effective_code,
      coalesce(nullif(btrim(d.current_revision),''),'UNSPECIFIED') current_revision,
      upper(coalesce(d.raw_cells->>'UNIT','')) unit,
      public.tracking_parse_number(coalesce(ops_core.fcb_cell(d.raw_cells,'weight'),ops_core.fcb_cell(d.raw_cells,'quantity'))) raw_number,
      ops_core.fcb_cell(d.raw_cells,'material') material,
      ops_core.fcb_cell(d.raw_cells,'size') size_value,
      ops_core.fcb_cell(d.raw_cells,'schedule') schedule_value,
      t.requires_3d_scan,t.requires_assembly_simulation,
      ops_core.fcb_flag(d.raw_cells,'fbe') fbe_required,
      coalesce(ops_core.normalize_item_key(ops_core.clean_drawing_identity(d.drawing_number)),ops_core.normalize_item_key(nullif(btrim(d.document_title),'')),'DRAWING'||d.source_row_id::text) item_key
    from ops_panel.drawings_current d
    left join ops_panel.drawing_technical_profile t on t.source_row_id=d.source_row_id
    where d.is_fcb=true and ops_core.normalize_project_core(d.project_key)=v_core
      and (upper(coalesce(d.raw_cells->>'UNIT','')) like '%SPOOL%' or upper(coalesce(d.raw_cells->>'UNIT','')) like '%SUPPORT%' or upper(coalesce(d.raw_cells->>'UNIT','')) like '%STR%' or upper(coalesce(d.raw_cells->>'UNIT','')) like '%KG%' or upper(coalesce(d.drawing_number,'')) like '%-ISO-%' or upper(coalesce(d.drawing_number,'')) like '%-SUP-%' or upper(coalesce(d.drawing_number,'')) like '%-STR-%')
    order by item_key,d.source_version desc nulls last,d.source_row_id desc
  )
  insert into ops_core.items(project_id,item_key,item_type,iso_code,drawing_code,description,material,size,schedule,weight_kg,quantity,fbe_required,requires_3d,requires_assembly_simulation,current_stage_key,current_status,overall_progress,source_metadata)
  select p.id,r.item_key,ops_core.infer_item_type(r.unit,r.effective_code,r.document_title),case when r.unit like '%SPOOL%' or upper(r.effective_code) like '%-ISO-%' then r.effective_code end,r.effective_code,r.document_title,r.material,r.size_value,r.schedule_value,case when r.unit like '%KG%' then r.raw_number else public.tracking_parse_number(ops_core.fcb_cell(r.raw_cells,'weight')) end,case when r.unit like '%KG%' then 1 else coalesce(r.raw_number,1) end,r.fbe_required,r.requires_3d_scan,r.requires_assembly_simulation,'drawing','validation_required',0,jsonb_build_object('candidate_materialized',true,'technical_authority','FCB','fcb_source_row_id',r.source_row_id,'fcb_revision',r.current_revision,'provisional_breakdown',case when r.unit like '%KG%' then false else coalesce(r.raw_number,1)>1 end)
  from rows r
  on conflict(project_id,item_key) do update set
    item_type=excluded.item_type,iso_code=coalesce(excluded.iso_code,ops_core.items.iso_code),drawing_code=coalesce(excluded.drawing_code,ops_core.items.drawing_code),description=coalesce(excluded.description,ops_core.items.description),material=coalesce(excluded.material,ops_core.items.material),size=coalesce(excluded.size,ops_core.items.size),schedule=coalesce(excluded.schedule,ops_core.items.schedule),weight_kg=coalesce(excluded.weight_kg,ops_core.items.weight_kg),quantity=coalesce(excluded.quantity,ops_core.items.quantity),fbe_required=coalesce(excluded.fbe_required,ops_core.items.fbe_required),requires_3d=coalesce(excluded.requires_3d,ops_core.items.requires_3d),requires_assembly_simulation=coalesce(excluded.requires_assembly_simulation,ops_core.items.requires_assembly_simulation),source_metadata=(ops_core.items.source_metadata||excluded.source_metadata)||jsonb_build_object('technical_authority','FCB','fcb_superseded',false),updated_at=now();
  get diagnostics v_items=row_count;

  perform ops_core.ensure_item_stages(i.id) from ops_core.items i where i.project_id=p.id and not i.removed_from_scope;

  with docs as (
    select distinct on (document_key) d.source_row_id,d.source_version,d.drawing_number,d.document_title,d.current_revision,d.current_status,d.raw_cells,coalesce(ops_core.normalize_alias(ops_core.clean_drawing_identity(d.drawing_number)),ops_core.normalize_alias(nullif(btrim(d.document_title),'')),d.source_row_id::text) document_key
    from ops_panel.drawings_current d
    where d.is_fcb=true and ops_core.normalize_project_core(d.project_key)=v_core
    order by document_key,d.source_version desc nulls last,d.source_row_id desc
  )
  insert into ops_core.documents(project_id,document_key,document_type,document_number,title,current_revision,current_status,requires_3d,requires_assembly_simulation,source_system,source_row_id,source_version,metadata)
  select p.id,r.document_key,'FCB',ops_core.clean_drawing_identity(r.drawing_number),r.document_title,coalesce(nullif(btrim(r.current_revision),''),'UNSPECIFIED'),r.current_status,t.requires_3d_scan,t.requires_assembly_simulation,'drawing',r.source_row_id,r.source_version,jsonb_build_object('raw_cells',coalesce(r.raw_cells,'{}'::jsonb),'technical_authority','FCB')
  from docs r left join ops_panel.drawing_technical_profile t on t.source_row_id=r.source_row_id
  on conflict(project_id,document_key) do update set document_type='FCB',document_number=excluded.document_number,title=excluded.title,current_revision=excluded.current_revision,current_status=excluded.current_status,requires_3d=excluded.requires_3d,requires_assembly_simulation=excluded.requires_assembly_simulation,source_row_id=excluded.source_row_id,source_version=excluded.source_version,metadata=excluded.metadata,updated_at=now();
  get diagnostics v_documents=row_count;

  insert into ops_core.document_item_links(document_id,item_id,link_type)
  select distinct d.id,i.id,'fcb' from ops_core.documents d join ops_core.items i on i.project_id=d.project_id and not i.removed_from_scope
  where d.project_id=p.id and d.document_type='FCB' and ops_core.normalize_document_item_key(coalesce(i.drawing_code,i.iso_code,i.item_key),v_core)=ops_core.normalize_document_item_key(coalesce(d.document_number,d.title,d.document_key),v_core)
  on conflict do nothing;

  update ops_core.registration_candidates set candidate_status='reconciled',validated_project_id=p.id,last_seen_at=now() where id=c.id;
  insert into ops_core.audit_events(project_id,entity_type,entity_id,action,actor_email,source_system,after_data) values(p.id,'project',p.id::text,case when v_created then 'project.materialized_from_fcb' else 'project.fcb_refreshed' end,coalesce(nullif(p_actor,''),'system'),'ops_core',jsonb_build_object('project_core',p.project_core,'items',v_items,'documents',v_documents,'technical_authority','FCB','tracking_is_validation_only',true));

  return jsonb_build_object('ok',true,'created',v_created,'registered',true,'awaiting_fcb',false,'project_id',p.id,'project_core',p.project_core,'display_code',p.display_code,'items',(select count(*) from ops_core.items where project_id=p.id and not removed_from_scope and coalesce(source_metadata->>'fcb_superseded','false')<>'true'),'documents',v_documents,'technical_authority','FCB');
end;
$$;

create or replace function ops_core.materialize_candidate(p_project_core text,p_actor text default 'system')
returns jsonb language sql security definer set search_path=ops_core,ops_panel,public
as $$ select ops_core.materialize_fcb_candidate(p_project_core,p_actor); $$;

create or replace function public.ops_core_materialize_candidate(p_project_key text,p_actor text)
returns jsonb language sql security definer set search_path=public,ops_core,ops_panel
as $$ select ops_core.materialize_fcb_candidate(p_project_key,p_actor); $$;

create or replace function public.ops_core_list_candidates(p_status text default 'validation_required',p_limit integer default 200)
returns jsonb language sql stable security definer set search_path=public,ops_core
as $$
select coalesce(jsonb_agg(to_jsonb(q) order by (q.fcb_status='detected') desc,q.last_seen_at desc,q.project_core),'[]'::jsonb)
from (
  select c.*,p.source_mode,p.validation_status,p.client,p.vessel,p.pm,p.project_status,
    c.suggested_data #>> '{fcb,status}' fcb_status,
    c.suggested_data->'tracking_validation' tracking_validation,
    c.suggested_data->>'technical_authority' technical_authority,
    (select count(*) from ops_core.items i where i.project_id=p.id and not i.removed_from_scope and coalesce(i.source_metadata->>'fcb_superseded','false')<>'true') item_count,
    (select count(*) from ops_core.documents d where d.project_id=p.id and coalesce(d.metadata->>'fcb_superseded','false')<>'true') document_count
  from ops_core.registration_candidates c left join ops_core.projects p on p.region=c.region and p.project_core=c.project_core
  where ops_core.is_valid_project_core(c.project_core) and (p_status is null or p_status='' or c.candidate_status=p_status)
  order by (c.suggested_data #>> '{fcb,status}')='detected' desc,c.last_seen_at desc,c.project_core
  limit greatest(1,least(coalesce(p_limit,200),1000))
) q;
$$;

create or replace function public.ops_core_project_validation_report(p_project_key text)
returns jsonb language sql stable security definer set search_path=public,ops_core
as $$
with p as (select * from ops_core.projects where region='BR' and project_core=ops_core.normalize_project_core(p_project_key) limit 1),
stats as (select count(*) item_count,count(*) filter(where i.weight_kg is null) missing_weight,count(*) filter(where i.material is null or btrim(i.material)='') missing_material,count(*) filter(where i.item_type='OTHER') unclassified_items,count(*) filter(where coalesce((i.source_metadata->>'provisional_breakdown')::boolean,false)) provisional_breakdown,count(*) filter(where not exists(select 1 from ops_core.item_stages s where s.item_id=i.id)) items_without_workflow from ops_core.items i join p on i.project_id=p.id where not i.removed_from_scope and coalesce(i.source_metadata->>'fcb_superseded','false')<>'true'),
docs as (select count(*) document_count,count(*) filter(where current_revision is null or current_revision='UNSPECIFIED') missing_revision,count(*) filter(where source_row_id is not null) source_linked from ops_core.documents d join p on d.project_id=p.id where coalesce(d.metadata->>'fcb_superseded','false')<>'true'),
fcb as (select public.ops_core_fcb_status(p_project_key) data),tracking as (select coalesce(to_jsonb(v),'{}'::jsonb) data from ops_core.project_source_validation v where v.region='BR' and v.project_core=ops_core.normalize_project_core(p_project_key) and v.source_system='tracking')
select jsonb_build_object('project',(select to_jsonb(p) from p),'items',to_jsonb(stats),'documents',to_jsonb(docs),'fcb',(select data from fcb),'tracking_validation',(select data from tracking),'technical_authority','FCB','blocking_issues',(case when not coalesce(((select data from fcb)->>'has_fcb')::boolean,false) then jsonb_build_array('FCB vigente ainda não disponível. O cadastro técnico deve aguardar o FCB.') else '[]'::jsonb end)||(case when (select item_count from stats)=0 and coalesce(((select data from fcb)->>'has_fcb')::boolean,false) then jsonb_build_array('FCB detectado, mas os itens técnicos ainda não foram importados.') else '[]'::jsonb end)||(case when (select items_without_workflow from stats)>0 then jsonb_build_array('Há itens sem workflow.') else '[]'::jsonb end)||(case when (select missing_weight from stats)>0 then jsonb_build_array('Há itens FCB sem peso.') else '[]'::jsonb end)||(case when (select missing_material from stats)>0 then jsonb_build_array('Há itens FCB sem material.') else '[]'::jsonb end),'warnings',jsonb_build_object('missing_weight',(select missing_weight from stats),'missing_material',(select missing_material from stats),'unclassified_items',(select unclassified_items from stats),'provisional_breakdown',(select provisional_breakdown from stats),'documents_without_revision',(select missing_revision from docs),'provisional_drawing_items',(select count(*) from ops_core.items i join p on i.project_id=p.id where not i.removed_from_scope and coalesce(i.source_metadata->>'fcb_superseded','false')='true'),'tracking_mismatch',case when (select data from tracking)->>'status'='mismatch' then 1 else 0 end),'ready_for_cutover',(coalesce(((select data from fcb)->>'has_fcb')::boolean,false) and (select item_count from stats)>0 and (select items_without_workflow from stats)=0 and (select missing_weight from stats)=0 and (select missing_material from stats)=0),'generated_at',now()) from stats,docs;
$$;

create or replace function public.ops_core_refresh_registration()
returns jsonb language plpgsql security definer set search_path=public,ops_core
as $$
declare v_base jsonb; v_fcb jsonb;
begin v_base:=ops_core.refresh_registration_candidates(); v_fcb:=ops_core.enforce_fcb_first_registration(); return jsonb_build_object('ok',true,'base',v_base,'fcb_first',v_fcb,'refreshed_at',now()); end;
$$;

grant execute on function ops_core.refresh_fcb_project_profile(text) to service_role;
grant execute on function ops_core.refresh_project_tracking_validation(text) to service_role;
grant execute on function ops_core.enforce_fcb_first_registration() to service_role;
grant execute on function ops_core.materialize_fcb_candidate(text,text) to service_role;
grant execute on function ops_core.materialize_candidate(text,text) to service_role;
grant execute on function public.ops_core_list_candidates(text,integer) to service_role;
grant execute on function public.ops_core_project_validation_report(text) to service_role;
grant execute on function public.ops_core_materialize_candidate(text,text) to service_role;
grant execute on function public.ops_core_refresh_registration() to service_role;

select ops_core.enforce_fcb_first_registration();
