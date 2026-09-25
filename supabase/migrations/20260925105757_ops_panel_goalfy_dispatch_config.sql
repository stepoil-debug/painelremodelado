
insert into ops_panel.settings(key,value,updated_at)
values('goalfy_board_id','e39f9ecc-0b45-4905-ad38-4ec55c1a1a1a',now())
on conflict(key) do update set value=excluded.value,updated_at=now();

create or replace function public.ops_goalfy_board_config()
returns jsonb
language sql
stable
security definer
set search_path=public,ops_panel
as $$
select jsonb_build_object(
  'board_id',(select value from ops_panel.settings where key='goalfy_board_id')
);
$$;

revoke all on function public.ops_goalfy_board_config() from public,anon,authenticated;
grant execute on function public.ops_goalfy_board_config() to service_role;

create or replace function public.ops_goalfy_dispatch_sync(p_force boolean default false)
returns bigint
language plpgsql
security definer
set search_path=public,ops_panel,net
as $$
declare
  v_secret text;
  v_request_id bigint;
begin
  select value into v_secret from ops_panel.settings where key='cron_secret';
  if coalesce(v_secret,'')='' then
    raise exception 'Segredo de sincronização não configurado.';
  end if;

  select net.http_post(
    url:='https://qxmxtbjxkhecqilpnhgq.supabase.co/functions/v1/ops-goalfy-sync',
    headers:=jsonb_build_object('Content-Type','application/json','x-ops-sync-key',v_secret),
    body:=jsonb_build_object('force',p_force),
    timeout_milliseconds:=120000
  ) into v_request_id;

  return v_request_id;
end $$;

grant execute on function public.ops_goalfy_dispatch_sync(boolean) to service_role;
