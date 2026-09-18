import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "npm:jose@5.9.6";
import { createHash } from "node:crypto";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,content-type,x-step-backend-key",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const VERCEL_TEAM_SLUG = "douglas-6d4f";
const VERCEL_PROJECT_NAME = "step-painel-operacional-real";
const VERCEL_AUDIENCE = "https://vercel.com/" + VERCEL_TEAM_SLUG;
const ALLOWED_VERCEL_ISSUERS = new Set([
  "https://oidc.vercel.com",
  "https://oidc.vercel.com/" + VERCEL_TEAM_SLUG,
]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function verifyVercelOidc(token: string) {
  const preview = decodeJwt(token);
  const issuer = String(preview.iss || "");
  if (!ALLOWED_VERCEL_ISSUERS.has(issuer)) return false;

  const discoveryUrl = issuer.replace(/\/$/, "") + "/.well-known/openid-configuration";
  const discoveryResponse = await fetch(discoveryUrl, { headers: { "Accept": "application/json" } });
  if (!discoveryResponse.ok) return false;
  const discovery = await discoveryResponse.json() as { jwks_uri?: string };
  if (!discovery.jwks_uri) return false;

  const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience: VERCEL_AUDIENCE,
  });

  const subject = String(payload.sub || "");
  const allowedSubjects = new Set([
    "owner:" + VERCEL_TEAM_SLUG + ":project:" + VERCEL_PROJECT_NAME + ":environment:production",
    "owner:" + VERCEL_TEAM_SLUG + ":project:" + VERCEL_PROJECT_NAME + ":environment:preview",
  ]);
  return allowedSubjects.has(subject);
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ ok: false, error: "Backend não configurado." }, 503);

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let authorized = false;
  const backendKey = (request.headers.get("x-step-backend-key") || "").trim();
  if (backendKey) {
    const { data, error } = await admin.rpc("ops_panel_api_auth", { p_candidate: backendKey });
    authorized = !error && data === true;
  }

  const auth = request.headers.get("authorization") || "";
  const bearerToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (!authorized && bearerToken) {
    try {
      const tokenHash = createHash("sha256").update(bearerToken).digest("hex");
      const { data: sessionUser, error: sessionError } = await admin.rpc("ops_panel_session_validate", {
        p_token_hash: tokenHash,
      });
      authorized = !sessionError && Boolean(sessionUser);
    } catch {
      authorized = false;
    }
  }

  if (!authorized && bearerToken && bearerToken.includes(".")) {
    try {
      authorized = await verifyVercelOidc(bearerToken);
    } catch {
      authorized = false;
    }
  }

  if (!authorized) return json({ ok: false, error: "Sessão inválida ou backend não autorizado." }, 401);

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { body = {}; }
  const action = String(body.action || "health");

  if (action === "health") {
    const { data, error } = await admin.rpc("ops_panel_get_snapshot");
    if (error) return json({ ok: false, error: error.message }, 500);
    const snapshot = (data ?? {}) as Record<string, unknown>;
    const projects = Array.isArray(snapshot.projects) ? snapshot.projects : [];
    return json({
      ok: true,
      sources: snapshot.sources ?? [],
      projectCount: projects.length,
      generatedAt: new Date().toISOString(),
    });
  }

  if (action === "snapshot") {
    const { data, error } = await admin.rpc("ops_panel_get_snapshot");
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data, generatedAt: new Date().toISOString() });
  }

  if (action === "project") {
    const projectKey = String(body.projectKey || "").trim();
    if (!projectKey) return json({ ok: false, error: "projectKey é obrigatório." }, 400);
    const { data, error } = await admin.rpc("ops_panel_get_project", {
      p_project_key: projectKey,
    });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data, generatedAt: new Date().toISOString() });
  }

  if (action === "demands") {
    const region = String(body.region || "BR").trim() || "BR";
    const requestedLimit = Number(body.limit || 2000);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.trunc(requestedLimit), 5000))
      : 2000;
    const { data, error } = await admin.rpc("ops_panel_get_demands", {
      p_region: region,
      p_limit: limit,
    });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data: Array.isArray(data) ? data : [], generatedAt: new Date().toISOString() });
  }

  return json({ ok: false, error: "Ação inválida." }, 400);
});
