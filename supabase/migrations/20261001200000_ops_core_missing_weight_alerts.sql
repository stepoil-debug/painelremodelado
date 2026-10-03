create or replace function public.ops_core_sync_missing_weight_alerts(
  p_region text default 'BR'
)
returns jsonb
language plpgsql
security definer
set search_path=public,ops_core
as $$
declare
  v_region text := upper(coalesce(nullif(btrim(p_region),''),'BR'));
  v_active_count integer := 0;
  v_touched_count integer := 0;
  v_resolved_count integer := 0;
begin
  with missing as (
    select distinct
      d.region,
      d.project_number,
      d.iso_key,
      d.iso,
      d.project_display,
      d.core_project_id,
      d.core_item_id,
      lower(recipient.email) as recipient_email,
      'missing-weight:'
        || upper(d.region)
        || ':' || ops_core.normalize_project_core(d.project_number)
        || ':' || ops_core.normalize_alias(coalesce(d.iso_key,d.iso))
        || ':' || lower(recipient.email) as dedup_key
    from ops_core.demand_feed_cache d
    cross join (
      values
        ('douglas.tabella@step-og.com'::text),
        ('cristian.valente@step-og.com'::text)
    ) as recipient(email)
    where upper(coalesce(d.region,''))=v_region
      and coalesce(d.weight_kg,0)<=0
      and nullif(btrim(coalesce(d.project_number,'')),'') is not null
      and nullif(btrim(coalesce(d.iso_key,d.iso,'')),'') is not null
  ), inserted as (
    insert into ops_core.notifications as target(
      project_id,
      item_id,
      sector_key,
      recipient_email,
      notification_type,
      title,
      message,
      severity,
      dedup_key,
      read_at,
      resolved_at
    )
    select
      nullif(m.core_project_id::text,'')::uuid,
      nullif(m.core_item_id::text,'')::uuid,
      'pcp',
      m.recipient_email,
      'data.missing_weight',
      'Peso do material não informado',
      concat(
        coalesce(m.project_display,'BSP ' || m.project_number),
        ' / ',
        coalesce(m.iso, m.iso_key),
        ' está sem peso do material. Verifique o cadastro.'
      ),
      'warning',
      m.dedup_key,
      null,
      null
    from missing m
    on conflict (dedup_key) do update
      set resolved_at=null,
      read_at=case
            when target.resolved_at is not null then null
            else target.read_at
          end
    returning 1
  )
  select count(*) into v_touched_count from inserted;

  update ops_core.notifications n
  set resolved_at=coalesce(n.resolved_at,now())
  where n.notification_type='data.missing_weight'
    and n.resolved_at is null
    and split_part(n.dedup_key,':',2)=v_region
    and not exists (
      select 1
      from ops_core.demand_feed_cache d
      cross join (
        values
          ('douglas.tabella@step-og.com'::text),
          ('cristian.valente@step-og.com'::text)
      ) as recipient(email)
      where upper(coalesce(d.region,''))=v_region
        and coalesce(d.weight_kg,0)<=0
        and lower(n.recipient_email)=lower(recipient.email)
        and n.dedup_key=(
          'missing-weight:'
          || upper(d.region)
          || ':' || ops_core.normalize_project_core(d.project_number)
          || ':' || ops_core.normalize_alias(coalesce(d.iso_key,d.iso))
          || ':' || lower(recipient.email)
        )
    );

  get diagnostics v_resolved_count = row_count;

  select count(*) into v_active_count
  from ops_core.notifications n
  where n.notification_type='data.missing_weight'
    and n.resolved_at is null
    and split_part(n.dedup_key,':',2)=v_region;

  return jsonb_build_object(
    'ok',true,
    'region',v_region,
    'active_missing_weight_alerts',v_active_count,
    'touched_alerts',v_touched_count,
    'resolved_alerts',v_resolved_count
  );
end;
$$;

create or replace function public.ops_core_notifications(
  p_sector text default null,
  p_user text default null,
  p_limit integer default 200
)
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core
as $$
select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc),'[]'::jsonb)
from (
  select n.*,p.display_code project_display,
         coalesce(i.spool_code,i.iso_code,i.drawing_code,i.item_key) item_display
  from ops_core.notifications n
  left join ops_core.projects p on p.id=n.project_id
  left join ops_core.items i on i.id=n.item_id
  where (p_sector is null or n.sector_key=ops_core.normalize_sector_key(p_sector))
    and (n.recipient_email is null or p_user is null or lower(n.recipient_email)=lower(p_user))
    and (n.notification_type<>'data.missing_weight' or n.resolved_at is null)
  order by n.created_at desc
  limit greatest(1,least(coalesce(p_limit,200),1000))
) q;
$$;

grant execute on function public.ops_core_sync_missing_weight_alerts(text) to service_role;
