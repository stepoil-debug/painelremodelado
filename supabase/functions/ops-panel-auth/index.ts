import { createClient } from "npm:@supabase/supabase-js@2";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const DUMMY_PASSWORD_HASH = "scrypt$00112233445566778899aabbccddeeff$125662a2478727eef9e77fec4325ba3c24120995db4a10b3b14c0d5c4f809465";
const SESSION_HOURS = 12;

function allowedOrigin(request: Request) {
  const origin = request.headers.get("origin") || "";
  if (origin === "https://stepoil-debug.github.io") return origin;
  if (/^https:\/\/[^/]+\.vercel\.app$/i.test(origin)) return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return origin;
  return "https://stepoil-debug.github.io";
}

function headers(request: Request) {
  return {
    "Access-Control-Allow-Origin": allowedOrigin(request),
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Vary": "Origin",
  };
}

function json(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers(request), "Content-Type": "application/json; charset=utf-8" },
  });
}

function normalize(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeRole(value: unknown) {
  return normalize(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");
}

function verifyPassword(password: string, storedHash: unknown) {
  if (typeof storedHash !== "string") return false;
  const [algorithm, saltHex, expectedHex, extra] = storedHash.split("$");
  if (algorithm !== "scrypt" || !saltHex || !expectedHex || extra) return false;
  if (!/^[a-f0-9]+$/i.test(saltHex) || !/^[a-f0-9]+$/i.test(expectedHex) || expectedHex.length % 2 !== 0) return false;
  try {
    const expected = Buffer.from(expectedHex, "hex");
    const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function hasOperationsAccess(user: Record<string, unknown>) {
  const modules = Array.isArray(user.allowed_modules)
    ? user.allowed_modules.filter((v): v is string => typeof v === "string").map(v => v.trim().toLowerCase())
    : [];
  const role = normalizeRole(user.role);
  const adminRoles = new Set(["admin","administrator","administrador","administradora","superadmin","master","owner","root"]);
  return user.can_manage_access === true
    || adminRoles.has(role)
    || modules.includes("*")
    || modules.includes("operacoes-projetos")
    || modules.some(item => item.startsWith("operacoes-projetos:"));
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function bearer(request: Request) {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: headers(request) });
  if (request.method !== "POST") return json(request, { ok: false, error: "Use POST." }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json(request, { ok: false, error: "Backend não configurado." }, 503);

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { body = {}; }
  const action = String(body.action || "login");

  if (action === "session") {
    const token = bearer(request);
    if (!token) return json(request, { ok: false, error: "Sessão ausente." }, 401);
    const { data, error } = await admin.rpc("ops_panel_session_validate", { p_token_hash: hash(token) });
    if (error || !data) return json(request, { ok: false, error: "Sessão inválida ou expirada." }, 401);
    return json(request, { ok: true, user: data });
  }

  if (action === "logout") {
    const token = bearer(request);
    if (token) {
      await admin.rpc("ops_panel_session_revoke", { p_token_hash: hash(token) }).catch(() => null);
    }
    return json(request, { ok: true });
  }

  if (action !== "login") return json(request, { ok: false, error: "Ação inválida." }, 400);

  const identifier = normalize(body.identifier);
  const password = typeof body.password === "string" ? body.password : "";
  if (!identifier || !password || identifier.length > 254 || password.length > 512) {
    return json(request, { ok: false, error: "Login ou senha inválidos." }, 401);
  }

  const forwarded = request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip")
    || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || "unknown";
  const ipHash = hash(forwarded);
  const guardKey = hash(identifier + "|" + ipHash);

  const { data: guard } = await admin.rpc("ops_panel_login_guard_check", { p_guard_key: guardKey });
  if (guard?.locked) {
    return json(request, {
      ok: false,
      error: "Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.",
      lockedUntil: guard.locked_until || null,
    }, 429);
  }

  const { data: userData, error: userError } = await admin.rpc("ops_panel_find_login_user", {
    p_identifier: identifier,
  });
  const user = userData && typeof userData === "object" ? userData as Record<string, unknown> : null;

  const validPassword = verifyPassword(password, user?.password_hash || DUMMY_PASSWORD_HASH);
  if (userError || !user || !validPassword) {
    const { data: failure } = await admin.rpc("ops_panel_login_guard_failure", { p_guard_key: guardKey });
    if (failure?.locked) {
      return json(request, {
        ok: false,
        error: "Muitas tentativas. Acesso temporariamente bloqueado.",
        lockedUntil: failure.locked_until || null,
      }, 429);
    }
    return json(request, { ok: false, error: "Login ou senha inválidos." }, 401);
  }

  const registration = normalize(user.intranet_registration_status);
  if (user.active === false || ["pendente","rejeitado","bloqueado"].includes(registration)) {
    return json(request, { ok: false, error: "Este cadastro não está liberado para acesso." }, 403);
  }
  if (user.must_change_password === true) {
    return json(request, { ok: false, error: "Altere sua senha no STEP One antes de acessar este painel." }, 403);
  }
  if (!hasOperationsAccess(user)) {
    return json(request, { ok: false, error: "Seu perfil não possui acesso ao módulo de Operações e Projetos." }, 403);
  }

  await admin.rpc("ops_panel_login_guard_success", { p_guard_key: guardKey }).catch(() => null);

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hash(token);
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();

  const userName = String(user.name || user.username || "Usuário STEP").trim();
  const sector = String(user.sector || "").trim();
  const region = String(user.operation_region || user.site_key || user.portal_site || "BR").trim() || "BR";
  const username = String(user.username || "").trim();
  const userId = String(user.id || "");

  const { error: sessionError } = await admin.rpc("ops_panel_session_create", {
    p_token_hash: tokenHash,
    p_user_id: userId,
    p_username: username,
    p_user_name: userName,
    p_sector: sector,
    p_operation_region: region,
    p_expires_at: expiresAt,
    p_user_agent: request.headers.get("user-agent") || "",
    p_ip_hash: ipHash,
  });
  if (sessionError) return json(request, { ok: false, error: "Não foi possível iniciar a sessão." }, 500);

  await admin.from("users").update({
    last_login_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  }).eq("id", userId).catch(() => null);

  return json(request, {
    ok: true,
    token,
    expiresAt,
    user: {
      id: userId,
      username,
      name: userName,
      email: String(user.email || ""),
      role: String(user.job_title || user.role || "Colaborador"),
      sector,
      operationRegion: region,
    },
  });
});
