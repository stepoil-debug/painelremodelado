-- Applied to the operational Supabase project.
-- Service-role only helpers used by ops-panel-api to locate Drawing rows
-- without exposing the isolated ops_panel schema to frontend roles.
create or replace function public.ops_panel_get_drawing_rows_for_attachments(p_project_key text)
returns jsonb
language sql
stable
security definer
set search_path=public,ops_panel
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'source_row_id', d.source_row_id,
    'project_key', d.project_key,
    'drawing_number', d.drawing_number,
    'document_title', d.document_title,
    'current_revision', d.current_revision,
    'current_status', d.current_status,
    'is_fcb', d.is_fcb
  ) order by d.source_row_id), '[]'::jsonb)
  from ops_panel.drawings_current d
  where d.project_key = ops_panel.normalize_project_key(p_project_key);
$$;

create or replace function public.ops_panel_drawing_attachment_parent_allowed(
  p_project_key text,
  p_parent_id bigint
)
returns boolean
language sql
stable
security definer
set search_path=public,ops_panel
as $$
  select exists(
    select 1
    from ops_panel.drawings_current d
    where d.project_key = ops_panel.normalize_project_key(p_project_key)
      and d.source_row_id = p_parent_id
  );
$$;
