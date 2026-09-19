-- Applied to the operational Supabase project.
-- Session tokens are random opaque values; only SHA-256 hashes are stored.
create table if not exists ops_panel.web_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id text not null,
  username text not null,
  user_name text,
  sector text,
  operation_region text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  user_agent text,
  ip_hash text
);

create table if not exists ops_panel.login_guard (
  guard_key text primary key,
  failed_count integer not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

-- The deployed migration also defines service-role-only RPCs:
-- ops_panel_find_login_user
-- ops_panel_login_guard_check / failure / success
-- ops_panel_session_create / validate / revoke
-- They intentionally remain inaccessible to anon/authenticated database roles.
