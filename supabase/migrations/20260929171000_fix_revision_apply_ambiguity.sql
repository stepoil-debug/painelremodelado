-- Fix the PL/pgSQL variable/table alias ambiguity in the revision apply RPC.
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
  v_doc ops_core.documents%rowtype;
  v_sync jsonb;
  v_revision text;
  v_changed jsonb := '{}'::jsonb;
  v_applied integer := 0;
begin
  select * into r
  from ops_panel.source_rows
  where source_key='drawing' and source_row_id=p_source_row_id and active=true
  order by source_version desc limit 1;
  if not found then raise exception 'Linha do Drawing não encontrada ou inativa: %', p_source_row_id; end if;

  v_revision := coalesce(nullif(btrim(r.payload #>> '{derived,current_revision}'),''),'UNSPECIFIED');
  v_sync := ops_core.sync_drawing_source_row(p_source_row_id);

  update ops_panel.drawing_revision_events
  set review_status='applied', reviewed_by=coalesce(nullif(btrim(p_actor),''),'system'),
      reviewed_at=now(), review_note=coalesce(nullif(btrim(p_note),''),'Revisão aplicada ao OPS Core.')
  where source_row_id=p_source_row_id and coalesce(to_revision,'')=v_revision and review_status='pending';
  get diagnostics v_applied = row_count;

  select doc.* into v_doc
  from ops_core.documents doc
  where doc.source_row_id=p_source_row_id
  order by doc.updated_at desc limit 1;

  if v_doc.id is not null then
    select coalesce(dr.changed_fields,'{}'::jsonb) into v_changed
    from ops_core.document_revisions dr
    where dr.document_id=v_doc.id and dr.revision=v_revision and dr.source_version=v_doc.source_version
    order by dr.detected_at desc limit 1;

    update ops_core.document_revision_reviews rv
    set review_status='approved', reviewed_by=coalesce(nullif(btrim(p_actor),''),'system'),
        reviewed_at=now(), note=coalesce(nullif(btrim(p_note),''),'Revisão aplicada ao OPS Core.'),
        diff_snapshot=coalesce(rv.diff_snapshot,v_changed)
    from ops_core.document_revisions dr
    where rv.revision_id=dr.id and dr.document_id=v_doc.id and dr.revision=v_revision
      and dr.source_version=v_doc.source_version;

    insert into ops_core.audit_events(
      project_id,document_id,entity_type,entity_id,action,actor_email,source_system,
      before_data,after_data,metadata
    )
    values(
      v_doc.project_id,v_doc.id,'document',v_doc.id::text,'document.revision_applied',
      coalesce(nullif(btrim(p_actor),''),'system'),'ops_core',
      jsonb_build_object('revision',v_revision,'source_row_id',p_source_row_id),
      jsonb_build_object('revision',v_revision,'source_version',r.source_version),
      jsonb_build_object('changed_fields',v_changed,'note',p_note,'events_applied',v_applied)
    );
  end if;

  return jsonb_build_object('ok',true,'source_row_id',p_source_row_id,'revision',v_revision,
    'events_applied',v_applied,'changed_fields',v_changed,'sync',v_sync);
end;
$$;

revoke all on function public.ops_core_apply_drawing_revision(bigint,text,text) from public,anon,authenticated;
grant execute on function public.ops_core_apply_drawing_revision(bigint,text,text) to service_role;
