-- An FCB PDF is the technical authority after successful ingestion. It may be
-- attached to a normal Drawing row, so the authority cannot depend only on
-- drawings_current.is_fcb.
create or replace function public.ops_core_fcb_status(p_project_key text)
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core,ops_panel
as $$
with all_fcb as (
  select
    d.source_row_id::text source_key,
    d.source_row_id,
    d.drawing_number,
    d.document_title,
    d.current_revision,
    d.current_status,
    d.source_version,
    d.synced_at,
    'drawing'::text source_system
  from ops_panel.drawings_current d
  where ops_core.normalize_project_core(d.project_key)=ops_core.normalize_project_core(p_project_key)
    and d.is_fcb=true
  union all
  select
    'ingestion:'||i.id::text source_key,
    i.drawing_source_row_id source_row_id,
    i.fcb_code drawing_number,
    i.document_title,
    i.revision current_revision,
    i.status current_status,
    i.drawing_source_version source_version,
    i.applied_at synced_at,
    'fcb_ingestion'::text source_system
  from ops_core.fcb_ingestions i
  where ops_core.normalize_project_core(i.project_core)=ops_core.normalize_project_core(p_project_key)
    and i.is_current=true
    and i.status in ('parsed','applied','validated')
), x as (
  select distinct on (source_key) * from all_fcb order by source_key,source_version desc nulls last,synced_at desc nulls last
)
select jsonb_build_object(
  'project_core',ops_core.normalize_project_core(p_project_key),
  'fcb_count',count(*),
  'has_fcb',count(*)>0,
  'status',case when count(*)>0 then 'detected' else 'awaiting_fcb' end,
  'latest_revision',(select current_revision from x order by ops_core.revision_rank(current_revision) desc,source_version desc nulls last,synced_at desc nulls last limit 1),
  'latest_source_row_id',(select source_row_id from x order by ops_core.revision_rank(current_revision) desc,source_version desc nulls last,synced_at desc nulls last limit 1),
  'documents',coalesce(jsonb_agg(to_jsonb(x) order by ops_core.revision_rank(x.current_revision),x.source_row_id),'[]'::jsonb)
)
from x;
$$;

create or replace function ops_core.refresh_fcb_project_profile(p_project_core text)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,ops_panel,public
as $$
declare
  v_core text:=ops_core.normalize_project_core(p_project_core);
  v_project_id uuid;
  v_status jsonb;
  v_profile jsonb;
  v_documents jsonb;
  v_count integer:=0;
  v_latest_revision text;
  v_latest_row bigint;
  v_latest_version bigint;
begin
  select p.id into v_project_id from ops_core.projects p where p.region='BR' and p.project_core=v_core limit 1;
  v_status:=public.ops_core_fcb_status(v_core);
  v_count:=coalesce((v_status->>'fcb_count')::integer,0);
  v_latest_revision:=v_status->>'latest_revision';
  v_latest_row:=nullif(v_status->>'latest_source_row_id','')::bigint;
  select max(i.drawing_source_version) into v_latest_version
  from ops_core.fcb_ingestions i
  where ops_core.normalize_project_core(i.project_core)=v_core and i.is_current=true and i.status in ('parsed','applied','validated');
  v_profile:=jsonb_build_object(
    'technical_authority','FCB',
    'fcb_count',v_count,
    'ingested_count',(select count(*) from ops_core.fcb_ingestions i where ops_core.normalize_project_core(i.project_core)=v_core and i.is_current=true and i.status in ('parsed','applied','validated')),
    'checked_at',now()
  );
  select coalesce(jsonb_agg(to_jsonb(i) order by i.fcb_code,i.revision),'[]'::jsonb) into v_documents
  from ops_core.fcb_ingestions i
  where ops_core.normalize_project_core(i.project_core)=v_core and i.is_current=true and i.status in ('parsed','applied','validated');
  insert into ops_core.fcb_project_profiles(region,project_core,project_id,fcb_count,latest_revision,latest_source_row_id,source_version,technical_profile,documents,checked_at,updated_at)
  values('BR',v_core,v_project_id,v_count,v_latest_revision,v_latest_row,v_latest_version,v_profile,v_documents,now(),now())
  on conflict(region,project_core) do update set
    project_id=excluded.project_id,fcb_count=excluded.fcb_count,latest_revision=excluded.latest_revision,
    latest_source_row_id=excluded.latest_source_row_id,source_version=excluded.source_version,
    technical_profile=excluded.technical_profile,documents=excluded.documents,checked_at=excluded.checked_at,updated_at=now();
  return v_profile||jsonb_build_object('project_core',v_core,'latest_revision',v_latest_revision,'latest_source_row_id',v_latest_row,'checked_at',now());
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
  v_detected integer:=0;
  v_waiting integer:=0;
begin
  for r in
    select distinct project_core from (
      select ops_core.normalize_project_core(d.project_key) project_core from ops_panel.drawings_current d where d.is_fcb=true
      union
      select ops_core.normalize_project_core(i.project_core) from ops_core.fcb_ingestions i where i.is_current=true and i.status in ('parsed','applied','validated')
    ) x
    where ops_core.is_valid_project_core(project_core)
  loop
    v_profile:=ops_core.refresh_fcb_project_profile(r.project_core);
    v_tracking:=ops_core.refresh_project_tracking_validation(r.project_core);
    update ops_core.registration_candidates c
    set source_systems=array(select distinct unnest(array_append(coalesce(c.source_systems,'{}'::text[]),'fcb')) order by 1),
        suggested_data=coalesce(c.suggested_data,'{}'::jsonb)||jsonb_build_object(
          'fcb',v_profile||jsonb_build_object('status','detected'),
          'tracking_validation',v_tracking,
          'technical_authority','FCB',
          'panel_mode',jsonb_build_object('mode','observation','panel_mutation_allowed',false,'checked_at',now()),
          'detection',jsonb_build_object('new_project',not exists(select 1 from ops_core.projects p where p.region=c.region and p.project_core=c.project_core and p.active),'source','fcb','checked_current_tracking',true,'detected_at',coalesce(c.suggested_data #>> '{detection,detected_at}',now()::text)),
          'fcb_first',true
        ),
        candidate_status=case when c.validated_project_id is null then 'validation_required' else c.candidate_status end,
        last_seen_at=now()
    where c.region='BR' and c.project_core=r.project_core;
    v_detected:=v_detected+1;
  end loop;
  update ops_core.registration_candidates c
  set suggested_data=coalesce(c.suggested_data,'{}'::jsonb)||jsonb_build_object('fcb',jsonb_build_object('status','awaiting_fcb','checked_at',now(),'source','drawing_documentation_control'),'technical_authority','FCB','fcb_first',true,'panel_mode',jsonb_build_object('mode','observation','panel_mutation_allowed',false,'checked_at',now())),last_seen_at=now()
  where c.region='BR' and c.validated_project_id is null and 'drawing'=any(coalesce(c.source_systems,'{}'::text[]))
    and not exists(select 1 from ops_panel.drawings_current d where d.is_fcb=true and ops_core.normalize_project_core(d.project_key)=c.project_core)
    and not exists(select 1 from ops_core.fcb_ingestions i where i.is_current=true and i.status in ('parsed','applied','validated') and ops_core.normalize_project_core(i.project_core)=c.project_core);
  get diagnostics v_waiting=row_count;
  return jsonb_build_object('ok',true,'fcb_projects',v_detected,'awaiting_fcb',v_waiting,'refreshed_at',now());
end;
$$;

revoke execute on function public.ops_core_fcb_status(text) from public,anon,authenticated;
grant execute on function public.ops_core_fcb_status(text) to service_role;
grant execute on function ops_core.refresh_fcb_project_profile(text) to service_role;
grant execute on function ops_core.enforce_fcb_first_registration() to service_role;

select ops_core.enforce_fcb_first_registration();
