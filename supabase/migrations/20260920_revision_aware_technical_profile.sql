-- Revision-aware Drawing/FCB watch and technical profile
create table if not exists ops_panel.drawing_revision_events (
  id bigserial primary key,
  source_row_id bigint not null,
  project_key text,
  drawing_number text,
  is_fcb boolean not null default false,
  from_revision text,
  to_revision text,
  change_type text not null default 'technical_update',
  changed_fields jsonb not null default '{}'::jsonb,
  source_version bigint not null,
  detected_at timestamptz not null default now(),
  unique (source_row_id, source_version)
);

create index if not exists drawing_revision_events_project_idx
  on ops_panel.drawing_revision_events(project_key, detected_at desc);

create index if not exists drawing_revision_events_row_idx
  on ops_panel.drawing_revision_events(source_row_id, detected_at desc);

create or replace function ops_panel.capture_drawing_revision_change()
returns trigger
language plpgsql
security definer
set search_path=ops_panel,public
as $$
declare
  v_old_rev text;
  v_new_rev text;
  v_old_sim text;
  v_new_sim text;
  v_old_scan text;
  v_new_scan text;
  v_old_status text;
  v_new_status text;
  v_changes jsonb := '{}'::jsonb;
  v_project_key text;
  v_drawing_number text;
  v_is_fcb boolean := false;
  v_change_type text := 'technical_update';
begin
  if new.source_key <> 'drawing' or old.row_hash is not distinct from new.row_hash then
    return new;
  end if;

  v_old_rev := nullif(btrim(old.payload #>> '{derived,current_revision}'),'');
  v_new_rev := nullif(btrim(new.payload #>> '{derived,current_revision}'),'');
  v_old_sim := nullif(btrim(old.payload->'cells'->>'Necessita Simulação de Montagem'),'');
  v_new_sim := nullif(btrim(new.payload->'cells'->>'Necessita Simulação de Montagem'),'');
  v_old_scan := nullif(btrim(old.payload->'cells'->>'3D Scan    (yes/no)'),'');
  v_new_scan := nullif(btrim(new.payload->'cells'->>'3D Scan    (yes/no)'),'');
  v_old_status := nullif(btrim(old.payload #>> '{derived,current_status}'),'');
  v_new_status := nullif(btrim(new.payload #>> '{derived,current_status}'),'');

  if v_old_rev is distinct from v_new_rev then
    v_changes := v_changes || jsonb_build_object(
      'revision', jsonb_build_object('from',v_old_rev,'to',v_new_rev)
    );
    v_change_type := 'revision_change';
  end if;

  if v_old_sim is distinct from v_new_sim then
    v_changes := v_changes || jsonb_build_object(
      'assembly_simulation', jsonb_build_object('from',v_old_sim,'to',v_new_sim)
    );
  end if;

  if v_old_scan is distinct from v_new_scan then
    v_changes := v_changes || jsonb_build_object(
      'scan_3d', jsonb_build_object('from',v_old_scan,'to',v_new_scan)
    );
  end if;

  if v_old_status is distinct from v_new_status then
    v_changes := v_changes || jsonb_build_object(
      'drawing_status', jsonb_build_object('from',v_old_status,'to',v_new_status)
    );
  end if;

  if v_changes = '{}'::jsonb then
    return new;
  end if;

  select project_key,drawing_number,is_fcb
    into v_project_key,v_drawing_number,v_is_fcb
  from (
    select
      (select ep.project_key
         from ops_panel.extract_project_keys(new.payload #>> '{derived,project_key}') ep
         limit 1) as project_key,
      new.payload #>> '{derived,drawing_number}' as drawing_number,
      coalesce((new.payload #>> '{derived,is_fcb}')::boolean,false) as is_fcb
  ) q;

  insert into ops_panel.drawing_revision_events(
    source_row_id,project_key,drawing_number,is_fcb,
    from_revision,to_revision,change_type,changed_fields,
    source_version,detected_at
  )
  values(
    new.source_row_id,v_project_key,v_drawing_number,coalesce(v_is_fcb,false),
    v_old_rev,v_new_rev,v_change_type,v_changes,
    new.source_version,now()
  )
  on conflict (source_row_id,source_version) do update
  set project_key=excluded.project_key,
      drawing_number=excluded.drawing_number,
      is_fcb=excluded.is_fcb,
      from_revision=excluded.from_revision,
      to_revision=excluded.to_revision,
      change_type=excluded.change_type,
      changed_fields=excluded.changed_fields,
      detected_at=excluded.detected_at;

  return new;
end;
$$;

drop trigger if exists trg_capture_drawing_revision_change on ops_panel.source_rows;
create trigger trg_capture_drawing_revision_change
after update of payload,row_hash,source_version on ops_panel.source_rows
for each row execute function ops_panel.capture_drawing_revision_change();

create or replace view ops_panel.drawing_technical_profile as
select
  d.source_row_id,
  d.source_version,
  d.synced_at,
  d.project_key,
  d.task_name,
  d.drawing_number,
  d.document_title,
  d.is_fcb,
  d.current_revision,
  d.current_status,
  case
    when lower(btrim(coalesce(d.raw_cells->>'Necessita Simulação de Montagem',''))) in ('sim','yes','y','true','1') then true
    when lower(btrim(coalesce(d.raw_cells->>'Necessita Simulação de Montagem',''))) in ('não','nao','no','n','false','0') then false
    else null
  end as requires_assembly_simulation,
  nullif(btrim(d.raw_cells->>'Necessita Simulação de Montagem'),'') as assembly_simulation_source_value,
  case
    when lower(btrim(coalesce(d.raw_cells->>'3D Scan    (yes/no)',''))) in ('sim','yes','y','true','1') then true
    when lower(btrim(coalesce(d.raw_cells->>'3D Scan    (yes/no)',''))) in ('não','nao','no','n','false','0') then false
    else null
  end as requires_3d_scan,
  nullif(btrim(d.raw_cells->>'3D Scan    (yes/no)'),'') as scan_3d_source_value,
  d.raw_cells
from ops_panel.drawings_current d;

do $$
declare v_jobid bigint;
begin
  select jobid into v_jobid
  from cron.job
  where jobname='ops-panel-critical-sources-watch'
  limit 1;

  if v_jobid is not null then
    perform cron.unschedule(v_jobid);
  end if;

  perform cron.schedule(
    'ops-panel-critical-sources-watch',
    '*/5 * * * *',
    $cron$select public.ops_panel_dispatch_sync_sources(array['drawing','tracking'], false);$cron$
  );
end $$;
