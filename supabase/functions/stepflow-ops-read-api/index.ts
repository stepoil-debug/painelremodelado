import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-step-client-key, x-step-integration-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Método não permitido." }, 405);

  const clientKey = req.headers.get("x-step-client-key") || "";
  const integrationKey = req.headers.get("x-step-integration-key") || "";
  if (!clientKey || !integrationKey) return json({ ok: false, error: "Não autorizado." }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: allowed, error: authError } = await admin.rpc("ops_read_validate_key", {
    p_client_key: clientKey,
    p_token: integrationKey,
  });
  if (authError || allowed !== true) return json({ ok: false, error: "Não autorizado." }, 401);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "").trim();

  if (action === "health") {
    const { data, error } = await admin.from("data_versions")
      .select("module_key,version,updated_at")
      .in("module_key", ["suprimentos", "materiais-alugados", "manutencao", "gestao-contratos"])
      .order("module_key", { ascending: true });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data: data || [], generatedAt: new Date().toISOString() });
  }

  if (action === "project") {
    const projectKey = String(body.projectKey || "").trim();
    if (!projectKey) return json({ ok: false, error: "projectKey é obrigatório." }, 400);
    const requestedLimit = Number(body.limit || 200);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(Math.trunc(requestedLimit), 500)) : 200;
    const { data, error } = await admin.rpc("ops_read_stepflow_project", { p_project_key: projectKey, p_limit: limit });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data, generatedAt: new Date().toISOString() });
  }

  return json({ ok: false, error: "Ação inválida." }, 400);
});
