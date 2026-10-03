-- Keep the read-only Goalfy shipping mirror fresh without requiring the panel to be open.
-- The dispatcher uses the existing ops_panel.settings.cron_secret and invokes the
-- ops-goalfy-sync Edge Function, which keeps Goalfy credentials inside Vault.
do $$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid
  from cron.job
  where jobname='ops-goalfy-shipping-sync-5m'
  limit 1;

  if v_jobid is not null then
    perform cron.unschedule(v_jobid);
  end if;

  perform cron.schedule(
    'ops-goalfy-shipping-sync-5m',
    '*/5 * * * *',
    'select public.ops_goalfy_dispatch_sync(false);'
  );
end $$;
