-- Preserve project identifiers with four digits (for example 25-1150),
-- expose the last sync timestamp to the incremental worker, and allow the
-- FCB pipeline to probe PDFs attached to ordinary SUP/STR drawing rows.

create or replace function ops_panel.extract_project_keys(value text)
returns table(project_key text)
language sql
immutable
as $function$
  with matches as (
    select m[1] as raw_key
    from regexp_matches(
      upper(coalesce(value,'')),
      '((?:BSP[- ]?|BEP[- ]?|BPP[- ]?|B3D[- ]?|SP[- ]?)?[0-9]{2}-[0-9]{3,4}(?:-[0-9]{1,2}[A-Z]?)?)',
      'g'
    ) as m
  ),
  normalized as (
    select case
      when raw_key ~ '^SP[0-9]{2}-' then regexp_replace(raw_key, '^SP', 'SP-')
      else raw_key
    end as raw_key
    from matches
  )
  select distinct ops_panel.normalize_project_key(raw_key)
  from normalized
  where ops_panel.is_valid_project_key(ops_panel.normalize_project_key(raw_key));
$function$;

create or replace function public.ops_panel_sync_sources()
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'ops_panel'
as $function$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'source_key', source_key,
        'sheet_id', sheet_id,
        'sheet_name', sheet_name,
        'last_synced_version', last_synced_version,
        'current_version', current_version,
        'last_synced_at', last_synced_at,
        'config', config
      )
      order by source_key
    ),
    '[]'::jsonb
  )
  from ops_panel.source_registry
  where source_kind = 'smartsheet'
    and sync_enabled = true;
$function$;

-- The regular batch ingest is intentionally reused for deltas. It upserts
-- only the rows returned by Smartsheet and never deactivates rows absent from
-- a delta response; the full-snapshot finish function remains unchanged.
create or replace function public.ops_panel_finish_incremental_sync(
  p_run_id uuid,
  p_source_key text,
  p_source_version bigint,
  p_total_row_count integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'ops_panel'
as $function$
declare
  v_received integer := 0;
  v_changed integer := 0;
begin
  update ops_panel.sync_runs
     set status = 'success',
         finished_at = now(),
         rows_removed = 0
   where id = p_run_id
     and source_key = p_source_key
     and status = 'running'
   returning rows_received, rows_changed
        into v_received, v_changed;

  if not found then
    raise exception 'Sync incremental inválido ou encerrado.';
  end if;

  update ops_panel.source_registry
     set current_version = p_source_version,
         last_synced_version = p_source_version,
         last_synced_at = now(),
         last_status = 'success',
         last_error = null,
         row_count = coalesce(nullif(p_total_row_count, 0), row_count, 0),
         updated_at = now()
   where source_key = p_source_key;

  return jsonb_build_object(
    'ok', true,
    'mode', 'incremental',
    'run_id', p_run_id,
    'source_key', p_source_key,
    'version', p_source_version,
    'rows_received', v_received,
    'rows_changed', v_changed,
    'rows_removed', 0
  );
end;
$function$;

revoke all on function public.ops_panel_finish_incremental_sync(uuid,text,bigint,integer) from public, anon, authenticated;
grant execute on function public.ops_panel_finish_incremental_sync(uuid,text,bigint,integer) to service_role;

-- Keep the normal one-argument function limited to confirmed FCB rows for
-- display. The second argument is used only by the attachment probe worker.
create or replace function public.ops_core_fcb_sources(
  p_project_key text,
  p_include_attachment_candidates boolean
)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'ops_core', 'ops_panel'
as $function$
  select coalesce(jsonb_agg(to_jsonb(q) order by q.source_row_id), '[]'::jsonb)
  from (
    select
      d.source_row_id,
      d.source_version,
      d.project_key,
      d.drawing_number,
      d.document_title,
      d.current_revision,
      d.current_status,
      d.raw_cells->>'UNIT' as unit,
      d.synced_at,
      d.is_fcb
    from ops_panel.drawings_current d
    where ops_core.normalize_project_core(d.project_key)=ops_core.normalize_project_core(p_project_key)
      and ops_core.is_valid_project_core(ops_core.normalize_project_core(d.project_key))
      and (
        coalesce(d.is_fcb,false)
        or ops_core.detect_fcb_text(concat_ws(' ', d.drawing_number, d.document_title, d.raw_cells->>'UNIT'))
        or (
          upper(coalesce(d.drawing_number,'')) ~ '(^|[- _])(FCB|ISO|SUP|STR|SPL)([- _]|$)'
          and ops_core.detect_fcb_text(coalesce(d.document_title,''))
        )
        or (
          coalesce(p_include_attachment_candidates,false)
          and upper(coalesce(d.drawing_number,'')) ~ '(^|[- _])(SUP|STR|SPL)([- _]|$)'
        )
      )
      and upper(coalesce(d.document_title,'')) not like '%CANCEL%'
      and upper(coalesce(d.current_status,'')) not in ('CANCELLED','CANCELED')
  ) q;
$function$;

revoke all on function public.ops_core_fcb_sources(text,boolean) from public, anon, authenticated;
grant execute on function public.ops_core_fcb_sources(text,boolean) to service_role;

-- Dispatch both explicit FCB rows and eligible drawing rows that may carry an
-- FCB PDF as an attachment. Failed probes are backed off by the existing
-- fcb_ingest_attempts table, while a new source version is retried.
create or replace function public.ops_fcb_dispatch_pending(p_limit integer default 40)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'ops_core', 'ops_panel', 'net'
as $function$
declare
  v_secret text;
  v_limit integer := greatest(1, least(coalesce(p_limit,40),100));
  v_dispatched integer := 0;
  v_requests jsonb := '[]'::jsonb;
  r record;
  v_request_id bigint;
begin
  select value into v_secret from ops_panel.settings where key='cron_secret';
  if coalesce(v_secret,'')='' then
    return jsonb_build_object('ok',false,'error','Segredo de sincronização não configurado.','dispatched',0);
  end if;

  for r in
    select d.source_row_id,d.project_key,d.source_version,
           case when coalesce(d.is_fcb,false) then 0 else 1 end as probe_priority
    from ops_panel.drawings_current d
    where ops_core.is_valid_project_core(ops_core.normalize_project_core(d.project_key))
      and (
        coalesce(d.is_fcb,false)
        or ops_core.detect_fcb_text(concat_ws(' ',d.drawing_number,d.document_title,d.raw_cells->>'UNIT'))
        or (
          upper(coalesce(d.drawing_number,'')) ~ '(^|[- _])(FCB|ISO|SUP|STR|SPL)([- _]|$)'
          and ops_core.detect_fcb_text(coalesce(d.document_title,''))
        )
        or upper(coalesce(d.drawing_number,'')) ~ '(^|[- _])(SUP|STR|SPL)([- _]|$)'
      )
      and upper(coalesce(d.document_title,'')) not like '%CANCEL%'
      and upper(coalesce(d.current_status,'')) not in ('CANCELLED','CANCELED')
      and not exists (
        select 1
        from ops_core.fcb_ingestions i
        where i.is_current=true
          and i.status in ('applied','validated','review_required')
          and i.drawing_source_row_id=d.source_row_id
          and coalesce(i.drawing_source_version,0)>=coalesce(d.source_version,0)
      )
      and not exists (
        select 1
        from ops_core.fcb_ingest_attempts a
        where a.source_row_id=d.source_row_id
          and coalesce(a.source_version,0)>=coalesce(d.source_version,0)
          and a.next_attempt_at>now()
      )
    order by probe_priority,d.synced_at desc nulls last,d.source_row_id
    limit v_limit
  loop
    insert into ops_core.fcb_ingest_attempts(
      source_row_id,project_core,source_version,status,last_error,attempts,
      last_attempt_at,next_attempt_at,updated_at
    ) values(
      r.source_row_id,ops_core.normalize_project_core(r.project_key),r.source_version,
      'failed','Despachado para importação automática.',1,now(),now()+interval '15 minutes',now()
    )
    on conflict(source_row_id) do update set
      project_core=excluded.project_core,
      source_version=excluded.source_version,
      status='failed',
      last_error=excluded.last_error,
      attempts=ops_core.fcb_ingest_attempts.attempts+1,
      last_attempt_at=now(),
      next_attempt_at=now()+interval '15 minutes',
      updated_at=now();

    select net.http_post(
      url:='https://qxmxtbjxkhecqilpnhgq.supabase.co/functions/v1/ops-fcb-ingest',
      headers:=jsonb_build_object('Content-Type','application/json','x-ops-sync-key',v_secret),
      body:=jsonb_build_object('projectCore',r.project_key,'sourceRowId',r.source_row_id,'actor','system:fcb-auto'),
      timeout_milliseconds:=120000
    ) into v_request_id;
    v_requests:=v_requests||jsonb_build_array(jsonb_build_object(
      'project_core',ops_core.normalize_project_core(r.project_key),
      'source_row_id',r.source_row_id,
      'request_id',v_request_id
    ));
    v_dispatched:=v_dispatched+1;
  end loop;

  return jsonb_build_object('ok',true,'dispatched',v_dispatched,'requests',v_requests,'checked_at',now());
end;
$function$;

revoke all on function public.ops_fcb_dispatch_pending(integer) from public, anon, authenticated;
grant execute on function public.ops_fcb_dispatch_pending(integer) to service_role;

-- One-time/project-scoped recovery entry point used to reprocess a known
-- project without waiting for the global probe queue.
create or replace function public.ops_fcb_dispatch_project(
  p_project_core text,
  p_limit integer default 40
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'ops_core', 'ops_panel', 'net'
as $function$
declare
  v_secret text;
  v_limit integer := greatest(1, least(coalesce(p_limit,40),100));
  v_dispatched integer := 0;
  v_requests jsonb := '[]'::jsonb;
  r record;
  v_request_id bigint;
begin
  select value into v_secret from ops_panel.settings where key='cron_secret';
  if coalesce(v_secret,'')='' then
    return jsonb_build_object('ok',false,'error','Segredo de sincronização não configurado.','dispatched',0);
  end if;
  if not ops_core.is_valid_project_core(ops_core.normalize_project_core(p_project_core)) then
    return jsonb_build_object('ok',false,'error','Projeto inválido.','dispatched',0);
  end if;

  for r in
    select d.source_row_id,d.project_key,d.source_version
    from ops_panel.drawings_current d
    where ops_core.normalize_project_core(d.project_key)=ops_core.normalize_project_core(p_project_core)
      and upper(coalesce(d.drawing_number,'')) ~ '(^|[- _])(FCB|ISO|SUP|STR|SPL)([- _]|$)'
      and upper(coalesce(d.document_title,'')) not like '%CANCEL%'
      and upper(coalesce(d.current_status,'')) not in ('CANCELLED','CANCELED')
      and not exists (
        select 1 from ops_core.fcb_ingestions i
        where i.is_current=true and i.status in ('applied','validated','review_required')
          and i.drawing_source_row_id=d.source_row_id
          and coalesce(i.drawing_source_version,0)>=coalesce(d.source_version,0)
      )
      and not exists (
        select 1 from ops_core.fcb_ingest_attempts a
        where a.source_row_id=d.source_row_id
          and coalesce(a.source_version,0)>=coalesce(d.source_version,0)
          and a.next_attempt_at>now()
      )
    order by coalesce(d.is_fcb,false) desc,d.source_row_id
    limit v_limit
  loop
    insert into ops_core.fcb_ingest_attempts(
      source_row_id,project_core,source_version,status,last_error,attempts,
      last_attempt_at,next_attempt_at,updated_at
    ) values(
      r.source_row_id,ops_core.normalize_project_core(r.project_key),r.source_version,
      'failed','Despachado para recuperação do projeto.',1,now(),now()+interval '15 minutes',now()
    )
    on conflict(source_row_id) do update set
      project_core=excluded.project_core,source_version=excluded.source_version,status='failed',
      last_error=excluded.last_error,attempts=ops_core.fcb_ingest_attempts.attempts+1,
      last_attempt_at=now(),next_attempt_at=now()+interval '15 minutes',updated_at=now();

    select net.http_post(
      url:='https://qxmxtbjxkhecqilpnhgq.supabase.co/functions/v1/ops-fcb-ingest',
      headers:=jsonb_build_object('Content-Type','application/json','x-ops-sync-key',v_secret),
      body:=jsonb_build_object('projectCore',r.project_key,'sourceRowId',r.source_row_id,'actor','system:fcb-recovery'),
      timeout_milliseconds:=120000
    ) into v_request_id;
    v_requests:=v_requests||jsonb_build_array(jsonb_build_object('source_row_id',r.source_row_id,'request_id',v_request_id));
    v_dispatched:=v_dispatched+1;
  end loop;

  return jsonb_build_object('ok',true,'project_core',ops_core.normalize_project_core(p_project_core),
    'dispatched',v_dispatched,'requests',v_requests,'checked_at',now());
end;
$function$;

revoke all on function public.ops_fcb_dispatch_project(text,integer) from public, anon, authenticated;
grant execute on function public.ops_fcb_dispatch_project(text,integer) to service_role;
