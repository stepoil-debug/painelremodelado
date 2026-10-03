create or replace function public.ops_fcb_dispatch_pending(p_limit integer default 40)
returns jsonb
language plpgsql
security definer
set search_path = public, ops_core, ops_panel, net
as $$
declare
  v_secret text;
  v_limit integer:=greatest(1,least(coalesce(p_limit,40),100));
  v_dispatched integer:=0;
  v_requests jsonb:='[]'::jsonb;
  r record;
  v_request_id bigint;
begin
  select value into v_secret from ops_panel.settings where key='cron_secret';
  if coalesce(v_secret,'')='' then
    return jsonb_build_object('ok',false,'error','Segredo de sincronização não configurado.','dispatched',0);
  end if;

  for r in
    select d.source_row_id,d.project_key,d.source_version
    from ops_panel.drawings_current d
    where ops_core.is_valid_project_core(ops_core.normalize_project_core(d.project_key))
      and (
        coalesce(d.is_fcb,false)
        or ops_core.detect_fcb_text(concat_ws(' ',d.drawing_number,d.document_title,d.raw_cells->>'UNIT'))
        or (
          upper(coalesce(d.drawing_number,'')) ~ '(^|[- _])(FCB|ISO|SUP|STR)([- _]|$)'
          and ops_core.detect_fcb_text(coalesce(d.document_title,''))
        )
      )
      and upper(coalesce(d.document_title,'')) not like '%CANCEL%'
      and upper(coalesce(d.current_status,'')) not in ('CANCELLED','CANCELED')
      and not exists (
        select 1 from ops_core.fcb_ingestions i
        where i.is_current=true
          and i.status in ('applied','validated')
          and i.drawing_source_row_id=d.source_row_id
          and coalesce(i.drawing_source_version,0)>=coalesce(d.source_version,0)
      )
    order by d.synced_at desc nulls last,d.source_row_id
    limit v_limit
  loop
    select net.http_post(
      url:='https://qxmxtbjxkhecqilpnhgq.supabase.co/functions/v1/ops-fcb-ingest',
      headers:=jsonb_build_object('Content-Type','application/json','x-ops-sync-key',v_secret),
      body:=jsonb_build_object('projectCore',r.project_key,'sourceRowId',r.source_row_id,'actor','system:fcb-auto'),
      timeout_milliseconds:=120000
    ) into v_request_id;
    v_requests:=v_requests||jsonb_build_array(jsonb_build_object('project_core',ops_core.normalize_project_core(r.project_key),'source_row_id',r.source_row_id,'request_id',v_request_id));
    v_dispatched:=v_dispatched+1;
  end loop;

  return jsonb_build_object('ok',true,'dispatched',v_dispatched,'requests',v_requests,'checked_at',now());
end;
$$;

revoke all on function public.ops_fcb_dispatch_pending(integer) from public,anon,authenticated;
grant execute on function public.ops_fcb_dispatch_pending(integer) to service_role;

update ops_core.registration_candidates
set candidate_status='rejected',
    suggested_data=coalesce(suggested_data,'{}'::jsonb)||jsonb_build_object(
      'data_quality',jsonb_build_object('status','invalid_project_core','message','Código de projeto não segue o padrão operacional e foi retirado da fila automática.','checked_at',now())
    ),
    last_seen_at=now()
where region='BR'
  and candidate_status='validation_required'
  and not ops_core.is_valid_project_core(project_core);
