create or replace function ops_core.resolve_fcb_ingest_attempt(p_source_row_id bigint)
returns jsonb
language sql
security definer
set search_path = ops_core, public
as $$
  update ops_core.fcb_ingest_attempts
  set status='resolved',last_error=null,next_attempt_at=now(),updated_at=now()
  where source_row_id=p_source_row_id
  returning jsonb_build_object('ok',true,'source_row_id',source_row_id,'status',status);
$$;

revoke all on function ops_core.resolve_fcb_ingest_attempt(bigint) from public,anon,authenticated;
grant execute on function ops_core.resolve_fcb_ingest_attempt(bigint) to service_role;
