-- Prefer the authoritative current Tracking item over stale manual
-- reconciliation rows created while the Tracking feed was incomplete.
-- Drawing-only candidates keep their normal zero-progress behavior; this
-- migration only removes stale manual rows when a live Tracking row exists.

with stale_manual_items as (
  select
    i.id as item_id,
    t.item_key as authoritative_item_key,
    t.source_row_id as authoritative_source_row_id,
    t.source_version as authoritative_source_version
  from ops_core.items i
  join ops_core.projects p
    on p.id=i.project_id
  join ops_panel.tracking_current_items t
    on ops_core.normalize_project_core(t.project_key)=p.project_core
   and (
     ops_core.normalize_item_key(t.drawing)=ops_core.normalize_item_key(i.drawing_code)
     or ops_core.normalize_item_key(i.drawing_code) like ops_core.normalize_item_key(t.drawing) || '%'
   )
  where p.region='BR'
    and p.active=true
    and i.removed_from_scope=false
    and i.source_metadata->>'origin'='legacy_tracking_manual_reconciliation'
    and t.item_key is not null
)
update ops_core.items i
set removed_from_scope=true,
    current_status='removed_from_scope',
    overall_progress=0,
    source_metadata=coalesce(i.source_metadata,'{}'::jsonb)
      || jsonb_build_object(
        'deduplicated_at',now(),
        'deduplicated_reason','live Tracking item is authoritative',
        'authoritative_source','tracking',
        'replaced_by_item_key',s.authoritative_item_key,
        'authoritative_source_row_id',s.authoritative_source_row_id,
        'authoritative_source_version',s.authoritative_source_version
      ),
    updated_at=now()
from stale_manual_items s
where i.id=s.item_id;

select ops_core.refresh_demand_feed_cache();
