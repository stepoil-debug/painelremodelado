-- The operational schema is intentionally private and is not exposed through
-- PostgREST. These service-role-only RPCs keep stage photo access behind the
-- authenticated ops-panel-api function without opening ops_core tables.

create or replace function public.ops_panel_stage_evidence_list(
  p_item_id uuid,
  p_stage_key text default null
)
returns jsonb
language sql
security definer
set search_path = ops_core, public
as $$
  select jsonb_build_object(
    'item_id', i.id,
    'item_stage_id', s.id,
    'stage_key', s.stage_key,
    'photos', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'item_id', e.item_id,
          'item_stage_id', e.item_stage_id,
          'photo_type', e.photo_type,
          'caption', e.caption,
          'taken_at', e.taken_at,
          'uploaded_by_name', e.uploaded_by_name,
          'content_type', e.content_type,
          'file_size_bytes', e.file_size_bytes,
          'storage_bucket', e.storage_bucket,
          'storage_path', e.storage_path
        ) order by e.taken_at asc
      )
      from ops_core.stage_evidence e
      where e.item_id = i.id and e.item_stage_id = s.id
    ), '[]'::jsonb)
  )
  from ops_core.items i
  left join ops_core.item_stages s
    on s.item_id = i.id
   and s.stage_key = coalesce(nullif(p_stage_key, ''), i.current_stage_key)
  where i.id = p_item_id;
$$;

create or replace function public.ops_panel_stage_evidence_insert(
  p_item_id uuid,
  p_stage_key text,
  p_photo_type text,
  p_storage_bucket text,
  p_storage_path text,
  p_caption text default null,
  p_uploaded_by_email text default null,
  p_uploaded_by_name text default null,
  p_content_type text default null,
  p_file_size_bytes integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ops_core, public
as $$
declare
  v_stage_id uuid;
  v_row ops_core.stage_evidence%rowtype;
begin
  if p_photo_type not in ('start', 'finish', 'extra') then
    raise exception 'Tipo de foto inválido.';
  end if;

  select s.id into v_stage_id
  from ops_core.item_stages s
  where s.item_id = p_item_id and s.stage_key = p_stage_key;

  if v_stage_id is null then
    raise exception 'Etapa do item não encontrada.';
  end if;

  insert into ops_core.stage_evidence(
    item_id, item_stage_id, photo_type, storage_bucket, storage_path,
    caption, uploaded_by_email, uploaded_by_name, content_type, file_size_bytes
  )
  values(
    p_item_id, v_stage_id, p_photo_type, p_storage_bucket, p_storage_path,
    nullif(left(coalesce(p_caption, ''), 200), ''), p_uploaded_by_email,
    p_uploaded_by_name, p_content_type, p_file_size_bytes
  )
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'item_id', v_row.item_id,
    'item_stage_id', v_row.item_stage_id,
    'photo_type', v_row.photo_type,
    'caption', v_row.caption,
    'taken_at', v_row.taken_at,
    'uploaded_by_name', v_row.uploaded_by_name,
    'content_type', v_row.content_type,
    'file_size_bytes', v_row.file_size_bytes,
    'storage_bucket', v_row.storage_bucket,
    'storage_path', v_row.storage_path
  );
end;
$$;

revoke all on function public.ops_panel_stage_evidence_list(uuid, text) from public, anon, authenticated;
revoke all on function public.ops_panel_stage_evidence_insert(uuid, text, text, text, text, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.ops_panel_stage_evidence_list(uuid, text) to service_role;
grant execute on function public.ops_panel_stage_evidence_insert(uuid, text, text, text, text, text, text, text, text, integer) to service_role;
