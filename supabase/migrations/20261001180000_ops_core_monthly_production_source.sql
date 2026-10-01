create or replace function public.ops_core_monthly_production_source(
  p_region text,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = public, ops_core
as $$
with core_events as (
  select e.id, e.project_id, e.item_id, e.stage_key, e.event_type,
         e.progress_from, e.progress_to, e.actor_email, e.actor_name,
         e.source_system, e.created_at, e.payload
  from ops_core.stage_events e
  where e.created_at >= p_from
    and e.created_at < p_to
    and e.event_type in ('stage.start', 'stage.progress', 'stage.complete')
),
legacy_events as (
  select e.id, e.advance_id, e.region, e.project_row_id, e.project_number,
         e.iso_key, e.event_type, e.progress_from, e.progress_to,
         e.actor_email, e.actor_name, e.note, e.payload, e.created_at
  from ops_core.panel_legacy_stage_events e
  where e.region = coalesce(nullif(btrim(p_region), ''), 'BR')
    and e.created_at >= p_from
    and e.created_at < p_to
    and e.event_type in ('stage.start', 'stage.progress', 'stage.complete')
),
core_items as (
  select i.id, i.project_id, i.item_key, i.iso_code, i.spool_code,
         i.tag_number, i.weight_kg, i.painting_m2,
         i.legacy_project_row_id, i.legacy_iso_key
  from ops_core.items i
  where exists (select 1 from core_events e where e.item_id = i.id)
),
core_projects as (
  select p.id, p.region, p.project_core, p.display_code, p.client,
         p.vessel, p.pm, p.source_mode, p.legacy_project_row_id
  from ops_core.projects p
  where exists (select 1 from core_events e where e.project_id = p.id)
),
legacy_advances as (
  select a.id, a.iso, a.stage_key, a.tracking_stage_key
  from ops_core.panel_legacy_stage_advances a
  where exists (select 1 from legacy_events e where e.advance_id = a.id)
),
legacy_project_row_ids as (
  select distinct e.project_row_id
  from legacy_events e
),
legacy_isos as (
  select t.region, t.project_row_id, t.iso_key, t.iso, t.drawing,
         t.weight_kg, t.m2, t.project_number
  from public.tracking_isos t
  where t.region = coalesce(nullif(btrim(p_region), ''), 'BR')
    and exists (
      select 1 from legacy_project_row_ids e
      where e.project_row_id = t.project_row_id
    )
),
legacy_projects as (
  select t.region, t.project_row_id, t.project_number,
         t.project_display, t.client, t.vessel, t.pm, t.project_type
  from public.tracking_projects t
  where t.region = coalesce(nullif(btrim(p_region), ''), 'BR')
    and exists (
      select 1 from legacy_project_row_ids e
      where e.project_row_id = t.project_row_id
    )
)
select jsonb_build_object(
  'core_events', coalesce((select jsonb_agg(to_jsonb(x)) from core_events x), '[]'::jsonb),
  'legacy_events', coalesce((select jsonb_agg(to_jsonb(x)) from legacy_events x), '[]'::jsonb),
  'core_items', coalesce((select jsonb_agg(to_jsonb(x)) from core_items x), '[]'::jsonb),
  'core_projects', coalesce((select jsonb_agg(to_jsonb(x)) from core_projects x), '[]'::jsonb),
  'legacy_advances', coalesce((select jsonb_agg(to_jsonb(x)) from legacy_advances x), '[]'::jsonb),
  'legacy_isos', coalesce((select jsonb_agg(to_jsonb(x)) from legacy_isos x), '[]'::jsonb),
  'legacy_projects', coalesce((select jsonb_agg(to_jsonb(x)) from legacy_projects x), '[]'::jsonb)
);
$$;

revoke all on function public.ops_core_monthly_production_source(text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.ops_core_monthly_production_source(text, timestamptz, timestamptz) to service_role;
