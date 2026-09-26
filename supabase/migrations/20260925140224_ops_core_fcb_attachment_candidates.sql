-- FCB PDFs are attached to support/structure drawing rows in the Drawing
-- Documentation Control sheet. The row itself may not contain the literal
-- words FCB, so expose those rows as parser candidates. The PDF parser remains
-- the authority: a candidate becomes an FCB only after the attachment passes
-- revision/project/technical validation.
create or replace function public.ops_core_fcb_sources(p_project_key text)
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core,ops_panel
as $$
select coalesce(jsonb_agg(to_jsonb(q) order by q.source_row_id),'[]'::jsonb)
from (
  select
    d.source_row_id,
    d.source_version,
    d.project_key,
    d.drawing_number,
    d.document_title,
    d.current_revision,
    d.current_status,
    d.raw_cells->>'UNIT' unit,
    d.synced_at
  from ops_panel.drawings_current d
  where ops_core.normalize_project_core(d.project_key)=ops_core.normalize_project_core(p_project_key)
    and (
      coalesce(d.is_fcb,false)
      or upper(coalesce(d.drawing_number,'')) like '%FCB%'
      or upper(coalesce(d.document_title,'')) like '%FCB%'
      or upper(coalesce(d.drawing_number,'')) like '%-SUP-%'
      or upper(coalesce(d.drawing_number,'')) like '%-STR-%'
      or upper(coalesce(d.raw_cells->>'UNIT','')) like '%(STR)%'
    )
    and upper(coalesce(d.document_title,'')) not like '%CANCEL%'
    and upper(coalesce(d.current_status,'')) not in ('CANCELLED','CANCELED')
    and nullif(btrim(coalesce(d.current_revision,'')),'') is not null
) q;
$$;

revoke execute on function public.ops_core_fcb_sources(text) from public, anon, authenticated;
revoke execute on function public.ops_core_fcb_status(text) from public, anon, authenticated;
revoke execute on function public.ops_core_apply_fcb_payload(jsonb,text) from public, anon, authenticated;
grant execute on function public.ops_core_fcb_sources(text) to service_role;
grant execute on function public.ops_core_fcb_status(text) to service_role;
grant execute on function public.ops_core_apply_fcb_payload(jsonb,text) to service_role;

revoke execute on function public.ops_core_list_candidates(text,integer) from public, anon, authenticated;
revoke execute on function public.ops_core_project_validation_report(text) from public, anon, authenticated;
revoke execute on function public.ops_core_materialize_candidate(text,text) from public, anon, authenticated;
revoke execute on function public.ops_core_refresh_registration() from public, anon, authenticated;
grant execute on function public.ops_core_list_candidates(text,integer) to service_role;
grant execute on function public.ops_core_project_validation_report(text) to service_role;
grant execute on function public.ops_core_materialize_candidate(text,text) to service_role;
grant execute on function public.ops_core_refresh_registration() to service_role;
