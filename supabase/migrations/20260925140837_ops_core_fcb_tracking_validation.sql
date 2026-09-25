create or replace function ops_core.refresh_project_tracking_validation(p_project_core text)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,ops_panel,public
as $$
declare
  v_core text:=ops_core.normalize_project_core(p_project_core);
  v_project_id uuid;
  v_fcb_count integer:=0;
  v_fcb_items integer:=0;
  v_tracking_items integer:=0;
  v_missing jsonb:='[]'::jsonb;
  v_source_only jsonb:='[]'::jsonb;
  v_status text:='not_checked';
begin
  select p.id into v_project_id from ops_core.projects p where p.region='BR' and p.project_core=v_core limit 1;
  select count(*)::integer into v_fcb_count from (
    select d.source_row_id::text source_key from ops_panel.drawings_current d where d.is_fcb=true and ops_core.normalize_project_core(d.project_key)=v_core
    union
    select 'ingestion:'||i.id::text from ops_core.fcb_ingestions i where i.is_current=true and i.status in ('parsed','applied','validated') and ops_core.normalize_project_core(i.project_core)=v_core
  ) x;
  select count(*)::integer into v_fcb_items from ops_core.items i join ops_core.projects p on p.id=i.project_id
  where p.region='BR' and p.project_core=v_core and not i.removed_from_scope and coalesce(i.source_metadata->>'technical_authority','')='FCB';
  select count(*)::integer into v_tracking_items from (select distinct ops_core.normalize_item_key(t.item_key) item_key from ops_panel.tracking_current_items t where ops_core.normalize_project_core(t.project_key)=v_core and nullif(ops_core.normalize_item_key(t.item_key),'') is not null) x;

  if v_fcb_count=0 then
    v_status:='not_checked';
  elsif v_tracking_items=0 then
    v_status:='not_found';
  else
    with fcb as (
      select distinct ops_core.normalize_item_key(coalesce(i.drawing_code,i.iso_code,i.item_key)) item_key
      from ops_core.items i join ops_core.projects p on p.id=i.project_id
      where p.region='BR' and p.project_core=v_core and not i.removed_from_scope and coalesce(i.source_metadata->>'technical_authority','')='FCB'
    ), tracking as (
      select distinct ops_core.normalize_item_key(t.item_key) item_key from ops_panel.tracking_current_items t where ops_core.normalize_project_core(t.project_key)=v_core
    )
    select coalesce(jsonb_agg(f.item_key order by f.item_key) filter(where t.item_key is null),'[]'::jsonb),coalesce(jsonb_agg(t.item_key order by t.item_key) filter(where f.item_key is null),'[]'::jsonb)
    into v_missing,v_source_only from fcb f full join tracking t on t.item_key=f.item_key;
    v_status:=case when jsonb_array_length(v_missing)=0 and jsonb_array_length(v_source_only)=0 then 'matched' else 'mismatch' end;
  end if;

  insert into ops_core.project_source_validation(region,project_core,project_id,source_system,status,source_count,core_count,missing_in_source,source_only,mismatches,metadata,checked_at)
  values('BR',v_core,v_project_id,'tracking',v_status,v_tracking_items,v_fcb_items,v_missing,v_source_only,'[]'::jsonb,jsonb_build_object('fcb_is_authority',true,'tracking_is_validation_only',true,'fcb_document_count',v_fcb_count,'checked_at',now()),now())
  on conflict(region,project_core,source_system) do update set project_id=excluded.project_id,status=excluded.status,source_count=excluded.source_count,core_count=excluded.core_count,missing_in_source=excluded.missing_in_source,source_only=excluded.source_only,mismatches=excluded.mismatches,metadata=excluded.metadata,checked_at=excluded.checked_at;
  return jsonb_build_object('source_system','tracking','status',v_status,'tracking_item_count',v_tracking_items,'fcb_item_count',v_fcb_items,'missing_in_tracking',v_missing,'tracking_only',v_source_only,'fcb_is_authority',true,'tracking_is_validation_only',true,'checked_at',now());
end;
$$;

grant execute on function ops_core.refresh_project_tracking_validation(text) to service_role;
select ops_core.enforce_fcb_first_registration();
