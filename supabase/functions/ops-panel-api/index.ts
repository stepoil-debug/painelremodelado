import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type,x-step-backend-key",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function trustedBackend(candidate: string) {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!candidate || !url) return false;
  if (serviceKey && candidate === serviceKey) return true;

  try {
    const verifier = createClient(url, candidate, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await verifier
      .from("users")
      .select("id", { head: true, count: "exact" })
      .limit(1);
    return !error;
  } catch {
    return false;
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ ok: false, error: "Backend não configurado." }, 503);

  const backendKey = (request.headers.get("x-step-backend-key") || "").trim();
  if (!(await trustedBackend(backendKey))) {
    return json({ ok: false, error: "Backend não autorizado." }, 401);
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

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

  return json({ ok: false, error: "Ação inválida." }, 400);
});
