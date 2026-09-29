-- The production function was refined after the initial rollout so that a
-- document created before the first Drawing row is not reported as a
-- negative lead time. Keep the correction in migration history as well as
-- in the consolidated source-timeline migration.
create or replace function public.ops_panel_get_project(p_project_key text)
returns jsonb
language sql
stable
security definer
set search_path=public,ops_panel
as $$
with key as (
  select ops_panel.normalize_project_key(p_project_key) as project_key
),
source_project as (
  select d.project_key,d.source_row_id,d.drawing_number,d.document_title,d.is_fcb,d.current_revision,d.approval_date,
    sr.first_seen_at,
    case when nullif(sr.payload->>'createdAt','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then (sr.payload->>'createdAt')::timestamptz end as source_created_at,
    case when nullif(sr.payload->'cells'->>'Date of request','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then ((sr.payload->'cells'->>'Date of request') || 'T00:00:00Z')::timestamptz end as request_date
  from ops_panel.drawings_current d
  join ops_panel.source_rows sr on sr.source_key='drawing' and sr.source_row_id=d.source_row_id
  join key k on k.project_key=d.project_key
  where sr.active=true
),
drawing_candidates as (
  select source_row_id,coalesce(source_created_at,request_date,first_seen_at) as registered_at,first_seen_at as detected_at,source_created_at,request_date
  from source_project
  where not is_fcb and nullif(btrim(coalesce(drawing_number,document_title,'')),'') is not null
),
drawing_timeline as (
  select min(registered_at) as registered_at,min(detected_at) as detected_at,min(source_created_at) as source_created_at,min(request_date) as request_date
  from drawing_candidates
),
fcb_candidates as (
  select source_row_id,drawing_number,current_revision,
    coalesce(case when approval_date is not null then (approval_date::text || 'T00:00:00Z')::timestamptz end,source_created_at,first_seen_at) as issued_at,
    first_seen_at as detected_at,
    case when approval_date is not null then 'Approval Date' when source_created_at is not null then 'createdAt do FCB' else 'primeira identificação pelo painel' end as issued_basis
  from source_project where is_fcb
),
fcb_timeline as (
  select count(*)::integer as fcb_count,min(issued_at) as issued_at,min(detected_at) as detected_at from fcb_candidates
),
fcb_primary as (
  select fc.source_row_id,fc.drawing_number,fc.current_revision,fc.issued_at,fc.issued_basis
  from fcb_candidates fc cross join drawing_timeline dt
  order by (dt.registered_at is not null and fc.issued_at >= dt.registered_at) desc,fc.issued_at nulls last,fc.source_row_id
  limit 1
),
revision_alerts as (
  select distinct on (e.source_row_id) e.*
  from ops_panel.drawing_revision_events e
  join key k on ops_panel.normalize_project_key(e.project_key)=k.project_key
  where e.change_type='revision_change' and coalesce(e.review_status,'pending')='pending'
  order by e.source_row_id,e.source_version desc,e.detected_at desc,e.id desc
),
timeline as (
  select jsonb_build_object(
    'status',case when dt.registered_at is null then 'awaiting_drawing' when ft.fcb_count=0 then 'awaiting_fcb' else 'fcb_detected' end,
    'drawing_registered_at',dt.registered_at,'drawing_detected_at',dt.detected_at,'drawing_source_created_at',dt.source_created_at,'drawing_request_date',dt.request_date,
    'fcb_count',coalesce(ft.fcb_count,0),'fcb_issued_at',fp.issued_at,'fcb_detected_at',ft.detected_at,'fcb_source_row_id',fp.source_row_id,'fcb_drawing_number',fp.drawing_number,'fcb_revision',fp.current_revision,'fcb_issued_basis',fp.issued_basis,
    'lead_time_status',case when dt.registered_at is null then 'missing_drawing_date' when fp.issued_at is null then 'awaiting_fcb' when fp.issued_at < dt.registered_at then 'source_dates_need_review' else 'measured' end,
    'lead_time_hours',case when dt.registered_at is not null and fp.issued_at is not null and fp.issued_at >= dt.registered_at then round((extract(epoch from(fp.issued_at-dt.registered_at))/3600.0)::numeric,2) end,
    'lead_time_days',case when dt.registered_at is not null and fp.issued_at is not null and fp.issued_at >= dt.registered_at then round((extract(epoch from(fp.issued_at-dt.registered_at))/86400.0)::numeric,2) end
  ) as data
  from drawing_timeline dt cross join fcb_timeline ft left join fcb_primary fp on true
)
select jsonb_build_object(
 'project',(select to_jsonb(p) from ops_panel.portfolio p,key k where p.project_key=k.project_key limit 1),
 'wip',coalesce((select jsonb_agg(to_jsonb(w)) from ops_panel.wip_current w,key k where w.project_key=k.project_key),'[]'::jsonb),
 'drawings',coalesce((select jsonb_agg(to_jsonb(d) order by d.is_fcb desc,d.drawing_number) from ops_panel.drawings_current d,key k where d.project_key=k.project_key),'[]'::jsonb),
 'drawing_revisions',coalesce((select jsonb_agg(to_jsonb(r) order by r.drawing_row_id,r.revision) from ops_panel.drawing_revisions r,key k where r.project_key=k.project_key),'[]'::jsonb),
 'drawing_revision_alerts',coalesce((select jsonb_agg(to_jsonb(a) order by a.detected_at desc) from revision_alerts a),'[]'::jsonb),
 'source_timeline',coalesce((select data from timeline),'{}'::jsonb),
 'job_orders',coalesce((select jsonb_agg(to_jsonb(j)) from ops_panel.job_order_current j,key k where j.project_key=k.project_key),'[]'::jsonb),
 'tracking_isos',coalesce((select jsonb_agg(to_jsonb(i) order by i.iso) from public.tracking_isos i,key k where ops_panel.normalize_project_key(i.project_number)=k.project_key and i.active=true),'[]'::jsonb),
 'dimensional',coalesce((select jsonb_agg(to_jsonb(d) order by d.request_date desc nulls last) from ops_panel.dimensional_current d,key k where d.project_key=k.project_key),'[]'::jsonb),
 'logistics',coalesce((select jsonb_agg(to_jsonb(l) order by l.movement_date desc nulls last) from ops_panel.logistics_current l,key k where l.project_key=k.project_key),'[]'::jsonb),
 'production_pt',coalesce((select jsonb_agg(to_jsonb(p)) from ops_panel.production_pt_current p,key k where p.project_key=k.project_key),'[]'::jsonb)
);
$$;
revoke all on function public.ops_panel_get_project(text) from public,anon,authenticated;
grant execute on function public.ops_panel_get_project(text) to service_role;
