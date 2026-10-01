create table if not exists public.ops_panel_comments (
  id uuid primary key default gen_random_uuid(),
  region text not null default 'BR',
  project_key text not null,
  project_number text not null,
  target_type text not null check (target_type in ('bsp', 'tag')),
  target_key text not null,
  comment text not null check (char_length(comment) <= 2000),
  created_by_email text,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_by_email text,
  updated_by_name text,
  updated_at timestamptz not null default now(),
  unique (region, project_key, target_type, target_key)
);

alter table public.ops_panel_comments enable row level security;
revoke all on table public.ops_panel_comments from public, anon, authenticated;
grant select, insert, update, delete on table public.ops_panel_comments to service_role;

create or replace function public.ops_panel_save_comment(
  p_region text,
  p_project_number text,
  p_iso_key text,
  p_comment text,
  p_actor_email text,
  p_actor_name text
)
returns jsonb
language plpgsql
as $$
declare
  v_region text := coalesce(nullif(btrim(p_region), ''), 'BR');
  v_project_number text := btrim(coalesce(p_project_number, ''));
  v_project_key text := regexp_replace(upper(v_project_number), '[^A-Z0-9]', '', 'g');
  v_iso_key text := btrim(coalesce(p_iso_key, ''));
  v_target_type text := case when v_iso_key = '' then 'bsp' else 'tag' end;
  v_target_key text := case
    when v_target_type = 'bsp' then '__BSP__'
    else regexp_replace(upper(v_iso_key), '[^A-Z0-9]', '', 'g')
  end;
  v_comment text := left(btrim(coalesce(p_comment, '')), 2000);
  v_id uuid;
begin
  if v_project_number = '' then
    raise exception 'project_number é obrigatório';
  end if;

  v_project_key := regexp_replace(v_project_key, '^(BSP|BEP|BPP|B3D)', '');
  if v_project_key = '' then
    raise exception 'project_number inválido';
  end if;

  if v_target_type = 'tag' and v_target_key = '' then
    raise exception 'iso_key é obrigatório para comentário de tag';
  end if;

  if v_comment = '' then
    delete from public.ops_panel_comments
    where region = v_region
      and project_key = v_project_key
      and target_type = v_target_type
      and target_key = v_target_key;

    return jsonb_build_object(
      'deleted', true,
      'region', v_region,
      'project_key', v_project_key,
      'target_type', v_target_type,
      'target_key', v_target_key
    );
  end if;

  insert into public.ops_panel_comments (
    region,
    project_key,
    project_number,
    target_type,
    target_key,
    comment,
    created_by_email,
    created_by_name,
    updated_by_email,
    updated_by_name
  ) values (
    v_region,
    v_project_key,
    v_project_number,
    v_target_type,
    v_target_key,
    v_comment,
    nullif(btrim(p_actor_email), ''),
    nullif(btrim(p_actor_name), ''),
    nullif(btrim(p_actor_email), ''),
    nullif(btrim(p_actor_name), '')
  )
  on conflict (region, project_key, target_type, target_key)
  do update set
    project_number = excluded.project_number,
    comment = excluded.comment,
    updated_by_email = excluded.updated_by_email,
    updated_by_name = excluded.updated_by_name,
    updated_at = now()
  returning id into v_id;

  return jsonb_build_object(
    'id', v_id,
    'deleted', false,
    'region', v_region,
    'project_key', v_project_key,
    'target_type', v_target_type,
    'target_key', v_target_key,
    'updated_at', now()
  );
end;
$$;

revoke all on function public.ops_panel_save_comment(text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.ops_panel_save_comment(text, text, text, text, text, text) to service_role;
