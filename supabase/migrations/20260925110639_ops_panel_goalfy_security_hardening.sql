
revoke all on function public.ops_goalfy_begin_sync(text,text,integer,jsonb) from public,anon,authenticated;
revoke all on function public.ops_goalfy_ingest_phases(text,jsonb) from public,anon,authenticated;
revoke all on function public.ops_goalfy_ingest_cards(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.ops_goalfy_finish_sync(uuid,boolean,text,integer,jsonb) from public,anon,authenticated;
revoke all on function public.ops_goalfy_sync_status() from public,anon,authenticated;
revoke all on function public.ops_goalfy_project_shipping(text) from public,anon,authenticated;
revoke all on function public.ops_goalfy_board_config() from public,anon,authenticated;
revoke all on function public.ops_goalfy_dispatch_sync(boolean) from public,anon,authenticated;

grant execute on function public.ops_goalfy_begin_sync(text,text,integer,jsonb) to service_role;
grant execute on function public.ops_goalfy_ingest_phases(text,jsonb) to service_role;
grant execute on function public.ops_goalfy_ingest_cards(uuid,jsonb) to service_role;
grant execute on function public.ops_goalfy_finish_sync(uuid,boolean,text,integer,jsonb) to service_role;
grant execute on function public.ops_goalfy_sync_status() to service_role;
grant execute on function public.ops_goalfy_project_shipping(text) to service_role;
grant execute on function public.ops_goalfy_board_config() to service_role;
grant execute on function public.ops_goalfy_dispatch_sync(boolean) to service_role;

create index if not exists goalfy_dns_sync_run_idx
  on ops_panel.goalfy_dns(sync_run_id);
