
create or replace function public.ops_goalfy_runtime_config()
returns jsonb
language sql
stable
security definer
set search_path=public,ops_panel,vault
as $$
select jsonb_build_object(
  'board_id',(select value from ops_panel.settings where key='goalfy_board_id'),
  'report_id',nullif((select value from ops_panel.settings where key='goalfy_report_id'),''),
  'access_token',(select decrypted_secret from vault.decrypted_secrets where name='goalfy_access_token' order by updated_at desc limit 1),
  'api_key',(select decrypted_secret from vault.decrypted_secrets where name='goalfy_api_key' order by updated_at desc limit 1)
);
$$;

create or replace function public.ops_goalfy_connection_status()
returns jsonb
language sql
stable
security definer
set search_path=public,ops_panel,vault
as $$
select jsonb_build_object(
  'board_id',(select value from ops_panel.settings where key='goalfy_board_id'),
  'has_access_token',exists(select 1 from vault.decrypted_secrets where name='goalfy_access_token' and coalesce(decrypted_secret,'')<>''),
  'report_id',nullif((select value from ops_panel.settings where key='goalfy_report_id'),''),
  'has_api_key',exists(select 1 from vault.decrypted_secrets where name='goalfy_api_key' and coalesce(decrypted_secret,'')<>''),
  'preferred_mode',case
    when nullif((select value from ops_panel.settings where key='goalfy_report_id'),'') is not null
      and exists(select 1 from vault.decrypted_secrets where name='goalfy_api_key' and coalesce(decrypted_secret,'')<>'')
    then 'report_external'
    when exists(select 1 from vault.decrypted_secrets where name='goalfy_access_token' and coalesce(decrypted_secret,'')<>'')
    then 'cards_api'
    else 'not_configured'
  end
);
$$;

create or replace function public.ops_goalfy_save_credentials(
  p_access_token text default null,
  p_report_id text default null,
  p_api_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path=public,ops_panel,vault
as $$
declare
  v_secret_id uuid;
begin
  if nullif(btrim(coalesce(p_access_token,'')),'') is not null then
    select id into v_secret_id from vault.secrets where name='goalfy_access_token' limit 1;
    if v_secret_id is null then
      perform vault.create_secret(btrim(p_access_token),'goalfy_access_token','Goalfy access token for STEP operational panel');
    else
      perform vault.update_secret(v_secret_id,btrim(p_access_token),'goalfy_access_token','Goalfy access token for STEP operational panel');
    end if;
  end if;

  if p_report_id is not null then
    insert into ops_panel.settings(key,value,updated_at)
    values('goalfy_report_id',btrim(p_report_id),now())
    on conflict(key) do update set value=excluded.value,updated_at=now();
  end if;

  if nullif(btrim(coalesce(p_api_key,'')),'') is not null then
    v_secret_id:=null;
    select id into v_secret_id from vault.secrets where name='goalfy_api_key' limit 1;
    if v_secret_id is null then
      perform vault.create_secret(btrim(p_api_key),'goalfy_api_key','Goalfy external report API key for STEP operational panel');
    else
      perform vault.update_secret(v_secret_id,btrim(p_api_key),'goalfy_api_key','Goalfy external report API key for STEP operational panel');
    end if;
  end if;

  return public.ops_goalfy_connection_status();
end $$;

revoke all on function public.ops_goalfy_runtime_config() from public,anon,authenticated;
revoke all on function public.ops_goalfy_connection_status() from public,anon,authenticated;
revoke all on function public.ops_goalfy_save_credentials(text,text,text) from public,anon,authenticated;

grant execute on function public.ops_goalfy_runtime_config() to service_role;
grant execute on function public.ops_goalfy_connection_status() to service_role;
grant execute on function public.ops_goalfy_save_credentials(text,text,text) to service_role;
