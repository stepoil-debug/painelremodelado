-- Revision review workflow for Drawing / FCB updates.
-- Source synchronization may observe a revision, but the operational review
-- remains explicit and auditable before it is marked as applied.

alter table ops_panel.drawing_revision_events
  add column if not exists review_status text not null default 'pending'
    check (review_status in ('pending','applied','ignored')),
  add column if not exists reviewed_by text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text;

create index if not exists drawing_revision_events_review_idx
  on ops_panel.drawing_revision_events(project_key, review_status, detected_at desc);

-- The history already collected before this workflow was deployed is retained.
-- Only the latest recent revision per Drawing is opened for review; older
-- historical events remain available but do not create a false backlog.
with latest as (
  select distinct on (source_row_id) id
  from ops_panel.drawing_revision_events
  where change_type = 'revision_change'
  order by source_row_id, source_version desc, detected_at desc, id desc
)
update ops_panel.drawing_revision_events e
set review_status = case
      when e.id = latest.id and e.detected_at >= now() - interval '14 days' then 'pending'
      else 'applied'
    end,
    reviewed_by = case
      when e.id = latest.id and e.detected_at >= now() - interval '14 days' then null
      else coalesce(e.reviewed_by,'system-bootstrap')
    end,
    reviewed_at = case
      when e.id = latest.id and e.detected_at >= now() - interval '14 days' then null
      else coalesce(e.reviewed_at,now())
    end
from latest
where e.id = latest.id or e.review_status is null;

create or replace function public.ops_core_apply_drawing_revision(
  p_source_row_id bigint,
  p_actor text default 'system',
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path=public,ops_core,ops_panel
as $$
declare
  r ops_panel.source_rows%rowtype;
  d ops_core.documents%rowtype;
  v_doc ops_core.documents%rowtype;
  v_sync jsonb;
  v_revision text;
  v_changed jsonb := '{}'::jsonb;
  v_applied integer := 0;
begin
  select * into r
  from ops_panel.source_rows
  where source_key='drawing'
    and source_row_id=p_source_row_id
    and active=true
  order by source_version desc
  limit 1;

  if not found then
    raise exception 'Linha do Drawing não encontrada ou inativa: %', p_source_row_id;
  end if;

  v_revision := coalesce(nullif(btrim(r.payload #>> '{derived,current_revision}'),''),'UNSPECIFIED');
  v_sync := ops_core.sync_drawing_source_row(p_source_row_id);

  update ops_panel.drawing_revision_events
  set review_status='applied',
      reviewed_by=coalesce(nullif(btrim(p_actor),''),'system'),
      reviewed_at=now(),
      review_note=coalesce(nullif(btrim(p_note),''),'Revisão aplicada ao OPS Core.')
  where source_row_id=p_source_row_id
    and coalesce(to_revision,'')=v_revision
    and review_status='pending';
  get diagnostics v_applied = row_count;

  select doc.* into v_doc
  from ops_core.documents doc
  where doc.source_row_id=p_source_row_id
  order by doc.updated_at desc
  limit 1;

  if v_doc.id is not null then
    select coalesce(dr.changed_fields,'{}'::jsonb)
      into v_changed
    from ops_core.document_revisions dr
    where dr.document_id=v_doc.id
      and dr.revision=v_revision
      and dr.source_version=v_doc.source_version
    order by dr.detected_at desc
    limit 1;

    update ops_core.document_revision_reviews rv
    set review_status='approved',
        reviewed_by=coalesce(nullif(btrim(p_actor),''),'system'),
        reviewed_at=now(),
        note=coalesce(nullif(btrim(p_note),''),'Revisão aplicada ao OPS Core.'),
        diff_snapshot=coalesce(rv.diff_snapshot,v_changed)
    from ops_core.document_revisions dr
    where rv.revision_id=dr.id
      and dr.document_id=v_doc.id
      and dr.revision=v_revision
      and dr.source_version=v_doc.source_version;

    insert into ops_core.audit_events(
      project_id,document_id,entity_type,entity_id,action,actor_email,
      source_system,before_data,after_data,metadata
    )
    select v_doc.project_id,v_doc.id,'document',v_doc.id::text,'document.revision_applied',
      coalesce(nullif(btrim(p_actor),''),'system'),'ops_core',
      jsonb_build_object('revision',v_revision,'source_row_id',p_source_row_id),
      jsonb_build_object('revision',v_revision,'source_version',r.source_version),
      jsonb_build_object('changed_fields',v_changed,'note',p_note,'events_applied',v_applied);
  end if;

  return jsonb_build_object(
    'ok',true,
    'source_row_id',p_source_row_id,
    'revision',v_revision,
    'events_applied',v_applied,
    'changed_fields',v_changed,
    'sync',v_sync
  );
end;
$$;

revoke all on function public.ops_core_apply_drawing_revision(bigint,text,text) from public,anon,authenticated;
grant execute on function public.ops_core_apply_drawing_revision(bigint,text,text) to service_role;

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
revision_alerts as (
  select distinct on (e.source_row_id)
    e.*
  from ops_panel.drawing_revision_events e
  join key k on ops_panel.normalize_project_key(e.project_key)=k.project_key
  where e.change_type='revision_change'
    and coalesce(e.review_status,'pending')='pending'
  order by e.source_row_id,e.source_version desc,e.detected_at desc,e.id desc
)
select jsonb_build_object(
 'project',(select to_jsonb(p) from ops_panel.portfolio p,key k where p.project_key=k.project_key limit 1),
 'wip',coalesce((select jsonb_agg(to_jsonb(w)) from ops_panel.wip_current w,key k where w.project_key=k.project_key),'[]'::jsonb),
 'drawings',coalesce((select jsonb_agg(to_jsonb(d) order by d.is_fcb desc,d.drawing_number) from ops_panel.drawings_current d,key k where d.project_key=k.project_key),'[]'::jsonb),
 'drawing_revisions',coalesce((select jsonb_agg(to_jsonb(r) order by r.drawing_row_id,r.revision) from ops_panel.drawing_revisions r,key k where r.project_key=k.project_key),'[]'::jsonb),
 'drawing_revision_alerts',coalesce((select jsonb_agg(to_jsonb(a) order by a.detected_at desc) from revision_alerts a),'[]'::jsonb),
 'job_orders',coalesce((select jsonb_agg(to_jsonb(j)) from ops_panel.job_order_current j,key k where j.project_key=k.project_key),'[]'::jsonb),
 'tracking_isos',coalesce((select jsonb_agg(to_jsonb(i) order by i.iso) from public.tracking_isos i,key k where ops_panel.normalize_project_key(i.project_number)=k.project_key and i.active=true),'[]'::jsonb),
 'dimensional',coalesce((select jsonb_agg(to_jsonb(d) order by d.request_date desc nulls last) from ops_panel.dimensional_current d,key k where d.project_key=k.project_key),'[]'::jsonb),
 'logistics',coalesce((select jsonb_agg(to_jsonb(l) order by l.movement_date desc nulls last) from ops_panel.logistics_current l,key k where l.project_key=k.project_key),'[]'::jsonb),
 'production_pt',coalesce((select jsonb_agg(to_jsonb(p)) from ops_panel.production_pt_current p,key k where p.project_key=k.project_key),'[]'::jsonb)
);
$$;

revoke all on function public.ops_panel_get_project(text) from public,anon,authenticated;
grant execute on function public.ops_panel_get_project(text) to service_role;
