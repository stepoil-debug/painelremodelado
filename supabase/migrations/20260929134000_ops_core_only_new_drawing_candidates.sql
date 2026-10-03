-- Keep the historical candidate registry for audit, but expose only new
-- Drawing/FCB detections in the operational pre-registration queue.

create or replace function public.ops_core_list_candidates(
  p_status text default 'validation_required',
  p_limit integer default 200
)
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core
as $function$
select coalesce(jsonb_agg(to_jsonb(q) order by (q.fcb_status='detected') desc,q.last_seen_at desc,q.project_core),'[]'::jsonb)
from (
  select c.*,p.source_mode,p.validation_status,p.client,p.vessel,p.pm,p.project_status,
    c.suggested_data #>> '{fcb,status}' fcb_status,
    c.suggested_data->'tracking_validation' tracking_validation,
    c.suggested_data->>'technical_authority' technical_authority,
    (select count(*) from ops_core.items i where i.project_id=p.id and not i.removed_from_scope and coalesce(i.source_metadata->>'fcb_superseded','false')<>'true') item_count,
    (select count(*) from ops_core.documents d where d.project_id=p.id and coalesce(d.metadata->>'fcb_superseded','false')<>'true') document_count
  from ops_core.registration_candidates c
  left join ops_core.projects p on p.region=c.region and p.project_core=c.project_core
  where ops_core.is_valid_project_core(c.project_core)
    and (p_status is null or p_status='' or c.candidate_status=p_status)
    and c.suggested_data #>> '{detection,new_project}'='true'
    and c.suggested_data #>> '{detection,source}' in ('drawing','fcb')
    and not ('legacy_snapshot'=any(coalesce(c.source_systems,'{}'::text[])))
  order by (c.suggested_data #>> '{fcb,status}')='detected' desc,c.last_seen_at desc,c.project_core
  limit greatest(1,least(coalesce(p_limit,200),1000))
) q;
$function$;

create or replace function public.ops_core_migration_status()
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core
as $function$
with p as (
  select count(*) total,count(*) filter(where source_mode='ops_core') cutover,
    count(*) filter(where source_mode='legacy_tracking') legacy,
    count(*) filter(where validation_status='validation_required') validation_required
  from ops_core.projects where active=true and region='BR'
), i as (
  select count(*) total,count(*) filter(where p.source_mode='ops_core') cutover,
    count(*) filter(where p.source_mode='legacy_tracking') legacy,count(*) filter(where i.removed_from_scope) removed
  from ops_core.items i join ops_core.projects p on p.id=i.project_id where p.active=true and p.region='BR'
), c as (
  select count(*) total,
    count(*) filter(where candidate_status='validation_required') pending,
    count(*) filter(where candidate_status='validated') validated
  from ops_core.registration_candidates
  where region='BR'
    and suggested_data #>> '{detection,new_project}'='true'
    and suggested_data #>> '{detection,source}' in ('drawing','fcb')
    and not ('legacy_snapshot'=any(coalesce(source_systems,'{}'::text[])))
)
select jsonb_build_object('projects',to_jsonb(p),'items',to_jsonb(i),'candidates',to_jsonb(c),'generated_at',now())
from p,i,c;
$function$;
