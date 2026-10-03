import { createClient } from "npm:@supabase/supabase-js@2";
import { createHash, randomBytes } from "node:crypto";

const STEP_ONE_LOGIN_URL = "https://intranet.step-og.com/api/auth/login";
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

function hasOperationsAccess(user: Record<string, unknown>) {
  const modules = Array.isArray(user.allowedModules)
    ? user.allowedModules.filter((v): v is string => typeof v === "string").map(v => v.trim().toLowerCase())
    : [];
  return user.canManageAccess === true
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

  let stepResponse: Response;
  try {
    stepResponse = await fetch(STEP_ONE_LOGIN_URL, {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": request.headers.get("user-agent") || "STEP-Operational-Panel/1.0",
      },
      body: JSON.stringify({ identifier, password }),
    });
  } catch {
    return json(request, { ok: false, error: "Não foi possível validar o acesso no STEP One." }, 502);
  }

  const stepPayload = await stepResponse.json().catch(() => ({})) as Record<string, unknown>;

  if (!stepResponse.ok || !stepPayload.user) {
    const upstreamError = typeof stepPayload.error === "string"
      ? stepPayload.error
      : "Login ou senha inválidos.";
    const safeStatus = stepResponse.status === 429 ? 429 : stepResponse.status === 403 ? 403 : 401;
    return json(request, { ok: false, error: upstreamError }, safeStatus);
  }

  const profile = stepPayload.user as Record<string, unknown>;
  if (!hasOperationsAccess(profile)) {
    return json(request, { ok: false, error: "Seu perfil não possui acesso ao módulo de Operações e Projetos." }, 403);
  }

  const userId = String(profile.id || "").trim();
  const username = String(profile.login || identifier).trim();
  const userName = String(profile.name || profile.login || "Usuário STEP").trim();
  const sector = String(profile.department || "").trim();
  const region = String(profile.unit || "BR").trim() || "BR";

  if (!userId) {
    return json(request, { ok: false, error: "O STEP One autenticou o acesso, mas não retornou o identificador do usuário." }, 502);
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hash(token);
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();

  const forwarded = request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip")
    || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || "unknown";

  const { error: sessionError } = await admin.rpc("ops_panel_session_create", {
    p_token_hash: tokenHash,
    p_user_id: userId,
    p_username: username,
    p_user_name: userName,
    p_sector: sector,
    p_operation_region: region,
    p_expires_at: expiresAt,
    p_user_agent: request.headers.get("user-agent") || "",
    p_ip_hash: hash(forwarded),
  });

  if (sessionError) return json(request, { ok: false, error: "Não foi possível iniciar a sessão do Painel Operacional." }, 500);

  return json(request, {
    ok: true,
    token,
    expiresAt,
    user: {
      id: userId,
      username,
      name: userName,
      email: String(profile.corporateEmail || profile.email || ""),
      role: String(profile.role || "Colaborador"),
      sector,
      operationRegion: region,
    },
  });
});
