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

function canManageCore(user: Record<string, unknown> | null) {
  if (!user) return false;
  const role = String(user.role || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const sector = String(user.sector || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const modules = Array.isArray(user.allowed_modules) ? user.allowed_modules.map((item) => String(item).toLowerCase()) : [];
  return (
    ["admin","administrator","administrador","administradora","superadmin","master","owner","root"].includes(role)
    || sector === "pcp"
    || modules.includes("*")
    || modules.includes("operacoes-projetos:pcp")
  );
}

const PANEL_PROGRESS_STEPS = new Set([25, 50, 75, 100]);

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ ok: false, error: "Backend não configurado." }, 503);

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const refreshDemandCache = async () => {
    const { error } = await admin.rpc("ops_core_refresh_demand_feed_cache");
    if (error) console.error("demand cache refresh error:", error.message);
  };

  let authorized = false;
  let authorizedByBackend = false;
  let authorizedByOidc = false;
  let sessionUser: Record<string, unknown> | null = null;

  const backendKey = (request.headers.get("x-step-backend-key") || "").trim();
  if (backendKey) {
    const { data, error } = await admin.rpc("ops_panel_api_auth", { p_candidate: backendKey });
    authorizedByBackend = !error && data === true;
    authorized = authorizedByBackend;
  }

  const auth = request.headers.get("authorization") || "";
  const bearerToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (!authorized && bearerToken) {
    try {
      const tokenHash = createHash("sha256").update(bearerToken).digest("hex");
      const { data, error: sessionError } = await admin.rpc("ops_panel_session_validate", {
        p_token_hash: tokenHash,
      });
      sessionUser = !sessionError && data && typeof data === "object"
        ? data as Record<string, unknown>
        : null;
      authorized = Boolean(sessionUser);
    } catch {
      authorized = false;
      sessionUser = null;
    }
  }

  if (!authorized && bearerToken && bearerToken.includes(".")) {
    try {
      authorizedByOidc = await verifyVercelOidc(bearerToken);
      authorized = authorizedByOidc;
    } catch {
      authorized = false;
      authorizedByOidc = false;
    }
  }

  if (!authorized) return json({ ok: false, error: "Sessão inválida ou backend não autorizado." }, 401);

  const trustedSystem = authorizedByBackend || authorizedByOidc;
  const actor = sessionUser
    ? String(sessionUser.email || sessionUser.username || sessionUser.name || "step-user")
    : "system-backend";
  const mayManageCore = trustedSystem || canManageCore(sessionUser);

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


  if (action === "overview") {
    const { data, error } = await admin.rpc("ops_panel_project_overview");
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data, generatedAt: new Date().toISOString() });
  }

  if (action === "sync_status") {
    const { data, error } = await admin.rpc("ops_panel_sync_status");
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data, generatedAt: new Date().toISOString() });
  }

  if (action === "sync_now") {
    const { data: migration, error: migrationError } = await admin.rpc("ops_core_migration_status");
    if (migrationError) return json({ ok: false, error: migrationError.message }, 500);

    const legacyProjects = Number((migration as any)?.projects?.legacy || 0);
    const baseSources = ["wip", "drawing", "dimensional", "logistics", "production_pt_2026"];
    const sources = legacyProjects > 0 ? [...baseSources, "tracking"] : baseSources;

    const { data: requestId, error: dispatchError } = await admin.rpc("ops_panel_dispatch_sync_sources", {
      p_sources: sources,
      p_force: false,
    });
    if (dispatchError) return json({ ok: false, error: dispatchError.message }, 500);

    return json({
      ok: true,
      data: {
        request_id: requestId,
        started_at: new Date().toISOString(),
        mode: legacyProjects > 0 ? "ops_core_hybrid" : "ops_core_only",
        sources,
        legacy_projects: legacyProjects,
      },
      message: legacyProjects > 0
        ? "Atualização solicitada. A reconciliação ocorrerá ao concluir o sync das fontes."
        : "Atualização solicitada somente nas fontes operacionais. Tracking está fora do fluxo ativo.",
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

    const [
      { data, error },
      { data: core, error: coreError },
      { data: stepflowConfig, error: stepflowConfigError },
    ] = await Promise.all([
      admin.rpc("ops_panel_get_project", { p_project_key: projectKey }),
      admin.rpc("ops_core_project_detail", { p_project_key: projectKey }),
      admin.rpc("ops_panel_stepflow_config"),
    ]);

    if (error) return json({ ok: false, error: error.message }, 500);
    if (coreError) console.error("ops_core project detail error:", coreError.message);

    let stepflow: unknown = null;
    let stepflowError: string | null = null;

    if (!stepflowConfigError && stepflowConfig?.url && stepflowConfig?.key) {
      try {
        const response = await fetch(String(stepflowConfig.url), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-step-client-key": "ops-panel",
            "x-step-integration-key": String(stepflowConfig.key),
          },
          body: JSON.stringify({
            action: "project",
            projectKey,
            limit: 250,
          }),
          signal: AbortSignal.timeout(12000),
        });

        const payload = await response.json().catch(() => ({}));
        if (response.ok && payload?.ok !== false) {
          stepflow = payload?.data ?? null;
        } else {
          stepflowError = String(payload?.error || "Falha na leitura do STEP Flow.");
        }
      } catch (error) {
        stepflowError = error instanceof Error ? error.message : "Falha na leitura do STEP Flow.";
      }
    } else if (stepflowConfigError) {
      stepflowError = stepflowConfigError.message;
    }

    return json({
      ok: true,
      data: {
        ...(data && typeof data === "object" ? data : {}),
        core: coreError ? null : core,
        stepflow,
        stepflow_error: stepflowError,
      },
      generatedAt: new Date().toISOString(),
    });
  }

  if (action === "drawing_revision_apply") {
    if (!mayManageCore) return json({ ok: false, error: "Somente PCP ou administrador pode aplicar uma revisão." }, 403);

    const sourceRowId = Number(body.sourceRowId || 0);
    if (!Number.isSafeInteger(sourceRowId) || sourceRowId <= 0) {
      return json({ ok: false, error: "sourceRowId é obrigatório." }, 400);
    }

    const note = body.note == null ? null : String(body.note).trim().slice(0, 500);
    const { data, error } = await admin.rpc("ops_core_apply_drawing_revision", {
      p_source_row_id: sourceRowId,
      p_actor: actor,
      p_note: note,
    });
    if (error) return json({ ok: false, error: error.message }, 500);

    return json({
      ok: true,
      data,
      message: "Revisão aplicada ao OPS Core e registrada no histórico.",
      generatedAt: new Date().toISOString(),
    });
  }


  if (action === "goalfy_connection_status") {
    const { data, error } = await admin.rpc("ops_goalfy_connection_status");
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data, generatedAt: new Date().toISOString() });
  }

  if (action === "goalfy_save_credentials") {
    if (!mayManageCore) return json({ ok: false, error: "Somente PCP ou administrador pode configurar o Goalfy." }, 403);

    const accessToken = String(body.accessToken || "").trim();
    const reportId = body.reportId == null ? null : String(body.reportId).trim();
    const apiKey = String(body.apiKey || "").trim();

    const { data, error } = await admin.rpc("ops_goalfy_save_credentials", {
      p_access_token: accessToken || null,
      p_report_id: reportId,
      p_api_key: apiKey || null,
    });
    if (error) return json({ ok: false, error: error.message }, 500);

    return json({
      ok: true,
      data,
      message: "Credenciais Goalfy armazenadas com segurança no Vault.",
      generatedAt: new Date().toISOString(),
    });
  }

  if (action === "goalfy_shipping") {
    const projectKey = String(body.projectKey || "").trim();
    if (!projectKey) return json({ ok: false, error: "projectKey é obrigatório." }, 400);

    const { data, error } = await admin.rpc("ops_goalfy_project_shipping", {
      p_project_key: projectKey,
    });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data, generatedAt: new Date().toISOString() });
  }

  if (action === "goalfy_sync_status") {
    const { data, error } = await admin.rpc("ops_goalfy_sync_status");
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data, generatedAt: new Date().toISOString() });
  }

  if (action === "goalfy_sync_now") {
    if (!mayManageCore) return json({ ok: false, error: "Somente PCP ou administrador pode atualizar o Goalfy." }, 403);

    const { data: requestId, error } = await admin.rpc("ops_goalfy_dispatch_sync", {
      p_force: body.force === true,
    });
    if (error) return json({ ok: false, error: error.message }, 500);

    return json({
      ok: true,
      data: { request_id: requestId, started_at: new Date().toISOString(), observation_mode: true },
      message: "Sincronização Goalfy solicitada em modo leitura. Nenhum progresso operacional será alterado.",
      generatedAt: new Date().toISOString(),
    });
  }

  if (action === "evidence") {
    const bsp = String(body.bsp || "").trim();
    const iso = String(body.iso || "").trim();
    if (!bsp || !iso) return json({ ok: false, error: "BSP e ISO são obrigatórios." }, 400);

    const compact = (value: unknown) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const bspKey = compact(bsp);
    const isoKey = compact(iso);
    const safeBspSearch = bsp.replace(/[%_]/g, "").slice(0, 80);

    const { data: sessionRows, error: sessionsError } = await admin
      .from("hh_sessions")
      .select("id,status,bsp_number,iso,activity_key,activity_name,start_at,end_at,elapsed_minutes,total_hh,finish_status,created_by_name,finished_by_name,created_at")
      .ilike("bsp_number", "%" + safeBspSearch + "%")
      .order("start_at", { ascending: false })
      .limit(120);

    if (sessionsError) return json({ ok: false, error: sessionsError.message }, 500);

    const sessions = (sessionRows || []).filter((session: Record<string, unknown>) => {
      const sessionBsp = compact(session.bsp_number);
      const sessionIso = compact(session.iso);
      const sameBsp = sessionBsp === bspKey || sessionBsp.endsWith(bspKey) || bspKey.endsWith(sessionBsp);
      const sameIso = sessionIso === isoKey || sessionIso.endsWith(isoKey) || isoKey.endsWith(sessionIso);
      return sameBsp && sameIso;
    });

    if (!sessions.length) {
      return json({
        ok: true,
        data: { bsp, iso, sessions: [], photos: [], generatedAt: new Date().toISOString() },
      });
    }

    const sessionIds = sessions.map((session: Record<string, unknown>) => String(session.id));

    const [{ data: photoRows, error: photosError }, { data: workerRows, error: workersError }] = await Promise.all([
      admin
        .from("hh_session_photos")
        .select("id,session_id,photo_type,storage_bucket,storage_path,public_url,caption,taken_at,visible_to_client,content_type,file_size_bytes,metadata,uploaded_by_name,created_at")
        .in("session_id", sessionIds)
        .order("taken_at", { ascending: true })
        .limit(200),
      admin
        .from("hh_session_workers")
        .select("id,session_id,worker_name,worker_registration,worker_role,participation_type,joined_at,left_at,hh_minutes,hh_value")
        .in("session_id", sessionIds)
        .order("joined_at", { ascending: true })
        .limit(300),
    ]);

    if (photosError) return json({ ok: false, error: photosError.message }, 500);
    if (workersError) return json({ ok: false, error: workersError.message }, 500);

    const photos = await Promise.all((photoRows || []).map(async (photo: Record<string, unknown>) => {
      let signedUrl = typeof photo.public_url === "string" ? photo.public_url : "";
      const bucket = String(photo.storage_bucket || "hh-photos");
      const path = String(photo.storage_path || "");

      if (path) {
        const { data: signed, error: signedError } = await admin.storage
          .from(bucket)
          .createSignedUrl(path, 4 * 60 * 60);
        if (!signedError && signed?.signedUrl) signedUrl = signed.signedUrl;
      }

      return {
        id: photo.id,
        session_id: photo.session_id,
        photo_type: photo.photo_type,
        caption: photo.caption,
        taken_at: photo.taken_at || photo.created_at,
        visible_to_client: photo.visible_to_client,
        content_type: photo.content_type,
        file_size_bytes: photo.file_size_bytes,
        metadata: photo.metadata,
        uploaded_by_name: photo.uploaded_by_name,
        signed_url: signedUrl,
      };
    }));

    const workersBySession = new Map<string, Record<string, unknown>[]>();
    for (const worker of workerRows || []) {
      const sessionId = String(worker.session_id || "");
      const list = workersBySession.get(sessionId) || [];
      list.push(worker as Record<string, unknown>);
      workersBySession.set(sessionId, list);
    }

    return json({
      ok: true,
      data: {
        bsp,
        iso,
        sessions: sessions.map((session: Record<string, unknown>) => ({
          ...session,
          workers: workersBySession.get(String(session.id)) || [],
        })),
        photos,
        generatedAt: new Date().toISOString(),
      },
    });
  }


  if (action === "drawing_attachments") {
    const projectKey = String(body.projectKey || "").trim();
    const iso = String(body.iso || "").trim();
    if (!projectKey) return json({ ok: false, error: "projectKey é obrigatório." }, 400);

    const smartsheetToken = Deno.env.get("SMARTSHEET_ACCESS_TOKEN");
    if (!smartsheetToken) return json({ ok: false, error: "Integração Smartsheet não configurada." }, 503);

    const { data: drawingRowsRaw, error: drawingsError } = await admin.rpc(
      "ops_panel_get_drawing_rows_for_attachments",
      { p_project_key: projectKey }
    );

    if (drawingsError) return json({ ok: false, error: drawingsError.message }, 500);
    const allDrawingRows = Array.isArray(drawingRowsRaw) ? drawingRowsRaw : [];

    const compact = (value: unknown) =>
      String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

    const itemSuffix = (value: unknown) => {
      let normalized = compact(value);
      normalized = normalized.replace(/^(BSP|BEP|BPP|B3D)/, "");

      const projectCompact = compact(projectKey).replace(/^(BSP|BEP|BPP|B3D)/, "");
      if (projectCompact && normalized.startsWith(projectCompact)) {
        normalized = normalized.slice(projectCompact.length);
      }

      return normalized;
    };

    const requestedItem = itemSuffix(iso);
    const drawingRows = requestedItem
      ? allDrawingRows.filter((row: Record<string, unknown>) => {
          const candidates = [
            itemSuffix(row.drawing_number),
            itemSuffix(row.document_title),
          ].filter(Boolean);

          return candidates.some((candidate) =>
            candidate === requestedItem
            || requestedItem.startsWith(candidate)
            || candidate.startsWith(requestedItem)
          );
        })
      : allDrawingRows;

    const DRAWING_SHEET_ID = 2580648465590148;
    const API = "https://api.smartsheet.com/2.0";

    async function sheetGet(path: string) {
      const response = await fetch(API + path, {
        headers: {
          Authorization: "Bearer " + smartsheetToken,
          "Content-Type": "application/json",
          "smartsheet-integration-source": "APPLICATION,STEP Oil & Gas,Painel Operacional Remodelado",
        },
      });
      const raw = await response.text();
      if (!response.ok) throw new Error("Smartsheet " + response.status + ": " + raw.slice(0, 500));
      return JSON.parse(raw);
    }

    function inferRevision(name: string, fallback: string) {
      const match = name.match(/(?:REV(?:ISION)?|R)[_\s.\-]*([A-Z0-9]{1,3})(?:\b|[_\s.\-])/i);
      if (match?.[1]) return String(match[1]).toUpperCase();
      return fallback || "";
    }

    const groups = await Promise.all((drawingRows || []).map(async (row: Record<string, unknown>) => {
      const rowId = Number(row.source_row_id);
      if (!rowId) return { ...row, attachments: [] };

      const listing = await sheetGet(
        "/sheets/" + DRAWING_SHEET_ID + "/rows/" + rowId + "/attachments?pageSize=100&page=1"
      ).catch(() => ({ data: [] }));

      const attachments = (Array.isArray(listing.data) ? listing.data : [])
        .filter((attachment: Record<string, unknown>) => {
          const mime = String(attachment.mimeType || "").toLowerCase();
          const name = String(attachment.name || "").toLowerCase();
          return mime === "application/pdf" || name.endsWith(".pdf");
        })
        .map((attachment: Record<string, unknown>) => ({
          id: attachment.id,
          parent_id: attachment.parentId,
          name: attachment.name,
          mime_type: attachment.mimeType,
          size_kb: attachment.sizeInKb,
          created_at: attachment.createdAt,
          created_by: attachment.createdBy || null,
          revision: inferRevision(String(attachment.name || ""), String(row.current_revision || "")),
        }));

      return { ...row, attachments };
    }));

    return json({
      ok: true,
      data: {
        project_key: projectKey,
        iso,
        sheet_id: DRAWING_SHEET_ID,
        rows: groups,
        attachment_count: groups.reduce((sum, row: any) => sum + (row.attachments?.length || 0), 0),
      },
      generatedAt: new Date().toISOString(),
    });
  }


  if (action === "drawing_attachment_pdf") {
    const projectKey = String(body.projectKey || "").trim();
    const attachmentId = Number(body.attachmentId || 0);
    if (!projectKey || !attachmentId) {
      return json({ ok: false, error: "projectKey e attachmentId são obrigatórios." }, 400);
    }

    const smartsheetToken = Deno.env.get("SMARTSHEET_ACCESS_TOKEN");
    if (!smartsheetToken) {
      return json({ ok: false, error: "Integração Smartsheet não configurada." }, 503);
    }

    const DRAWING_SHEET_ID = 2580648465590148;
    const metadataResponse = await fetch(
      "https://api.smartsheet.com/2.0/sheets/" + DRAWING_SHEET_ID + "/attachments/" + attachmentId,
      {
        headers: {
          Authorization: "Bearer " + smartsheetToken,
          "Content-Type": "application/json",
          "smartsheet-integration-source": "APPLICATION,STEP Oil & Gas,Painel Operacional Remodelado",
        },
      }
    );

    const metadataRaw = await metadataResponse.text();
    if (!metadataResponse.ok) {
      return json({ ok: false, error: "Não foi possível localizar o PDF no Smartsheet." }, 502);
    }

    const attachment = JSON.parse(metadataRaw) as Record<string, unknown>;
    const parentId = Number(attachment.parentId || 0);

    const { data: allowedRow, error: rowError } = await admin.rpc(
      "ops_panel_drawing_attachment_parent_allowed",
      { p_project_key: projectKey, p_parent_id: parentId }
    );

    if (rowError || allowedRow !== true) {
      return json({ ok: false, error: "Este anexo não pertence ao projeto selecionado." }, 403);
    }

    const sourceUrl = String(attachment.url || "");
    if (!sourceUrl) {
      return json({ ok: false, error: "O Smartsheet não retornou URL temporária para este PDF." }, 502);
    }

    const pdfResponse = await fetch(sourceUrl, {
      redirect: "follow",
      headers: { "Accept": "application/pdf,*/*;q=0.8" },
    });

    if (!pdfResponse.ok) {
      return json({ ok: false, error: "Não foi possível carregar o conteúdo do PDF." }, 502);
    }

    const bytes = await pdfResponse.arrayBuffer();
    const name = String(attachment.name || "drawing.pdf").replace(/[\r\n"]/g, "_");

    return new Response(bytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="' + name + '"',
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  if (action === "drawing_attachment_url") {
    const projectKey = String(body.projectKey || "").trim();
    const attachmentId = Number(body.attachmentId || 0);
    if (!projectKey || !attachmentId) {
      return json({ ok: false, error: "projectKey e attachmentId são obrigatórios." }, 400);
    }

    const smartsheetToken = Deno.env.get("SMARTSHEET_ACCESS_TOKEN");
    if (!smartsheetToken) return json({ ok: false, error: "Integração Smartsheet não configurada." }, 503);

    const DRAWING_SHEET_ID = 2580648465590148;
    const response = await fetch(
      "https://api.smartsheet.com/2.0/sheets/" + DRAWING_SHEET_ID + "/attachments/" + attachmentId,
      {
        headers: {
          Authorization: "Bearer " + smartsheetToken,
          "Content-Type": "application/json",
          "smartsheet-integration-source": "APPLICATION,STEP Oil & Gas,Painel Operacional Remodelado",
        },
      }
    );
    const raw = await response.text();
    if (!response.ok) return json({ ok: false, error: "Não foi possível abrir o PDF no Smartsheet." }, 502);

    const attachment = JSON.parse(raw) as Record<string, unknown>;
    const parentId = Number(attachment.parentId || 0);

    const { data: allowedRow, error: rowError } = await admin.rpc(
      "ops_panel_drawing_attachment_parent_allowed",
      { p_project_key: projectKey, p_parent_id: parentId }
    );

    if (rowError || allowedRow !== true) {
      return json({ ok: false, error: "Este anexo não pertence ao projeto selecionado." }, 403);
    }

    const url = String(attachment.url || "");
    if (!url) return json({ ok: false, error: "O Smartsheet não retornou URL temporária para este PDF." }, 502);

    return json({
      ok: true,
      data: {
        id: attachment.id,
        parent_id: attachment.parentId,
        name: attachment.name,
        mime_type: attachment.mimeType,
        size_kb: attachment.sizeInKb,
        created_at: attachment.createdAt,
        created_by: attachment.createdBy || null,
        url,
        url_expires_in_millis: attachment.urlExpiresInMillis || null,
      },
      generatedAt: new Date().toISOString(),
    });
  }

  if (action === "migration_status") {
    const { data, error } = await admin.rpc("ops_core_migration_status");
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data, generatedAt: new Date().toISOString() });
  }

  if (action === "registration_candidates") {
    const status = String(body.status || "validation_required").trim();
    const requestedLimit = Number(body.limit || 200);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(Math.trunc(requestedLimit), 1000)) : 200;
    const { data, error } = await admin.rpc("ops_core_list_candidates", {
      p_status: status,
      p_limit: limit,
    });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data: Array.isArray(data) ? data : [], generatedAt: new Date().toISOString() });
  }

  if (action === "core_registration_detail") {
    const projectKey = String(body.projectKey || "").trim();
    if (!projectKey) return json({ ok: false, error: "projectKey é obrigatório." }, 400);

    const { data, error } = await admin.rpc("ops_core_registration_detail", {
      p_project_key: projectKey,
    });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data: data || { project: null, items: [] }, generatedAt: new Date().toISOString() });
  }

  if (action === "validation_report") {
    const projectKey = String(body.projectKey || "").trim();
    if (!projectKey) return json({ ok: false, error: "projectKey é obrigatório." }, 400);
    const { data, error } = await admin.rpc("ops_core_project_validation_report", {
      p_project_key: projectKey,
    });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data, generatedAt: new Date().toISOString() });
  }

  if (action === "core_register_candidate_auto") {
    if (!mayManageCore) return json({ ok: false, error: "Somente PCP ou administrador pode cadastrar uma nova BSP." }, 403);
    const projectKey = String(body.projectKey || "").trim();
    if (!projectKey) return json({ ok: false, error: "projectKey é obrigatório." }, 400);

    const { data, error } = await admin.rpc("ops_core_register_candidate_auto", {
      p_project_key: projectKey,
      p_actor: actor,
    });
    if (error) return json({ ok: false, error: error.message }, 500);

    return json({
      ok: true,
      data,
      message: (data as any)?.awaiting_fcb
        ? "BSP pendente em modo observação. O cadastro técnico aguardará o FCB vigente e nenhum painel operacional será alterado."
        : "Cadastro atualizado em modo observação. Nenhum painel operacional foi alterado.",
      generatedAt: new Date().toISOString(),
    });
  }

  if (action === "core_materialize_candidate") {
    if (!mayManageCore) return json({ ok: false, error: "Somente PCP ou administrador pode criar uma BSP a partir da fila de validação." }, 403);
    const projectKey = String(body.projectKey || "").trim();
    if (!projectKey) return json({ ok: false, error: "projectKey é obrigatório." }, 400);
    const { data, error } = await admin.rpc("ops_core_materialize_candidate", {
      p_project_key: projectKey,
      p_actor: actor,
    });
    if (error) return json({ ok: false, error: error.message }, 500);
    const { data: report } = await admin.rpc("ops_core_project_validation_report", {
      p_project_key: projectKey,
    });
    return json({ ok: true, data, report, generatedAt: new Date().toISOString() });
  }

  if (action === "core_upsert_item") {
    if (!mayManageCore) return json({ ok: false, error: "Somente PCP ou administrador pode editar o cadastro operacional." }, 403);
    const projectKey = String(body.projectKey || "").trim();
    if (!projectKey) return json({ ok: false, error: "projectKey é obrigatório." }, 400);
    const item = body.item && typeof body.item === "object"
      ? body.item as Record<string, unknown>
      : {};
    const numberOrNull = (value: unknown) => {
      if (value === null || value === undefined || value === "") return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const boolOrNull = (value: unknown) =>
      value === true ? true : value === false ? false : null;

    const { data, error } = await admin.rpc("ops_core_upsert_item", {
      p_project_key: projectKey,
      p_item_id: item.id || null,
      p_item_key: item.item_key || null,
      p_iso_code: item.iso_code || null,
      p_spool_code: item.spool_code || null,
      p_drawing_code: item.drawing_code || null,
      p_item_type: item.item_type || "SPOOL",
      p_description: item.description || null,
      p_line_number: item.line_number || null,
      p_material: item.material || null,
      p_size: item.size || null,
      p_schedule: item.schedule || null,
      p_weight_kg: numberOrNull(item.weight_kg),
      p_painting_m2: numberOrNull(item.painting_m2),
      p_quantity: numberOrNull(item.quantity),
      p_joints: numberOrNull(item.joints),
      p_requires_3d: boolOrNull(item.requires_3d),
      p_requires_assembly_simulation: boolOrNull(item.requires_assembly_simulation),
      p_actor: actor,
    });
    if (error) return json({ ok: false, error: error.message }, 500);
    const { data: report } = await admin.rpc("ops_core_project_validation_report", {
      p_project_key: projectKey,
    });
    return json({ ok: true, data, report, generatedAt: new Date().toISOString() });
  }

  if (action === "core_remove_item") {
    if (!mayManageCore) return json({ ok: false, error: "Somente PCP ou administrador pode retirar itens do escopo." }, 403);
    const projectKey = String(body.projectKey || "").trim();
    const itemId = String(body.itemId || "").trim();
    if (!projectKey || !itemId) return json({ ok: false, error: "projectKey e itemId são obrigatórios." }, 400);
    const { data, error } = await admin.rpc("ops_core_remove_item", {
      p_project_key: projectKey,
      p_item_id: itemId,
      p_reason: String(body.reason || "").trim(),
      p_actor: actor,
    });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data, generatedAt: new Date().toISOString() });
  }

  if (action === "core_cutover") {
    return json({
      ok: false,
      error: "Modo observação ativo. A ativação de BSPs nos painéis operacionais está bloqueada nesta fase.",
      observationMode: true,
    }, 423);
  }

  if (action === "core_revert") {
    return json({
      ok: false,
      error: "Modo observação ativo. Alterações de fonte dos painéis operacionais estão bloqueadas nesta fase.",
      observationMode: true,
    }, 423);
  }

  if (action === "drawing_sync_now") {
    if (!mayManageCore) return json({ ok: false, error: "Somente PCP ou administrador pode forçar a atualização do Drawing." }, 403);

    const { data: before, error: beforeError } = await admin.rpc("ops_panel_sync_status");
    if (beforeError) return json({ ok: false, error: beforeError.message }, 500);

    const { data: requestId, error: dispatchError } = await admin.rpc("ops_panel_dispatch_sync_sources", {
      p_sources: ["drawing"],
      p_force: true,
    });
    if (dispatchError) return json({ ok: false, error: dispatchError.message }, 500);

    const drawingBefore = Array.isArray((before as any)?.sources)
      ? (before as any).sources.find((row: any) => row?.source_key === "drawing") || null
      : null;

    return json({
      ok: true,
      data: {
        request_id: requestId,
        source: "drawing",
        forced: true,
        started_at: new Date().toISOString(),
        previous_version: drawingBefore?.last_synced_version ?? null,
        previous_synced_at: drawingBefore?.last_synced_at ?? null,
      },
      message: "Atualização manual do Drawing solicitada.",
      generatedAt: new Date().toISOString(),
    });
  }

  if (action === "core_refresh_registration") {
    if (!mayManageCore) return json({ ok: false, error: "Somente PCP ou administrador pode atualizar a fila de validação." }, 403);
    const { data, error } = await admin.rpc("ops_core_refresh_registration");
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data, generatedAt: new Date().toISOString() });
  }

  if (action === "stage_evidence" || action === "stage_evidence_upload") {
    const itemId = String(body.itemId || "").trim();
    if (!itemId) return json({ ok: false, error: "itemId é obrigatório." }, 400);

    const { data: item, error: itemError } = await admin
      .schema("ops_core")
      .from("items")
      .select("id,current_stage_key,project_id")
      .eq("id", itemId)
      .maybeSingle();
    if (itemError) return json({ ok: false, error: itemError.message }, 500);
    if (!item) return json({ ok: false, error: "Item operacional não encontrado." }, 404);

    const { data: stage, error: stageError } = await admin
      .schema("ops_core")
      .from("item_stages")
      .select("id,stage_key")
      .eq("item_id", itemId)
      .eq("stage_key", String(item.current_stage_key || ""))
      .maybeSingle();
    if (stageError) return json({ ok: false, error: stageError.message }, 500);
    if (!stage) return json({ ok: false, error: "Etapa atual do item não encontrada." }, 409);

    if (action === "stage_evidence_upload") {
      if (!mayManageCore) return json({ ok: false, error: "Somente PCP ou administrador pode anexar evidências." }, 403);

      const photoType = String(body.photoType || "extra").trim().toLowerCase();
      if (!["start", "finish", "extra"].includes(photoType)) return json({ ok: false, error: "Tipo de foto inválido." }, 400);

      const content = String(body.content || "");
      const match = content.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
      if (!match) return json({ ok: false, error: "Envie uma imagem JPG, PNG ou WebP válida." }, 400);
      if (content.length > 12_000_000) return json({ ok: false, error: "A foto excede o limite de 8 MB." }, 413);

      const binary = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0));
      if (binary.byteLength > 8 * 1024 * 1024) return json({ ok: false, error: "A foto excede o limite de 8 MB." }, 413);

      const originalName = String(body.fileName || "foto").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
      const storagePath = `${itemId}/${String(stage.id)}/${crypto.randomUUID()}-${originalName}`;
      const bucket = "ops-evidence";
      const { error: uploadError } = await admin.storage.from(bucket).upload(storagePath, binary, {
        contentType: match[1],
        upsert: false,
      });
      if (uploadError) return json({ ok: false, error: uploadError.message }, 500);

      const actorName = sessionUser
        ? String(sessionUser.name || sessionUser.username || sessionUser.email || actor)
        : "system-backend";
      const { data: inserted, error: insertError } = await admin
        .schema("ops_core")
        .from("stage_evidence")
        .insert({
          item_id: itemId,
          item_stage_id: stage.id,
          photo_type: photoType,
          storage_bucket: bucket,
          storage_path: storagePath,
          caption: String(body.caption || "").trim().slice(0, 200) || null,
          uploaded_by_email: actor,
          uploaded_by_name: actorName,
          content_type: match[1],
          file_size_bytes: binary.byteLength,
        })
        .select("id,item_id,item_stage_id,photo_type,caption,taken_at,uploaded_by_name,content_type,file_size_bytes,storage_bucket,storage_path")
        .single();
      if (insertError) {
        await admin.storage.from(bucket).remove([storagePath]);
        return json({ ok: false, error: insertError.message }, 500);
      }

      const { data: signed, error: signedError } = await admin.storage.from(bucket).createSignedUrl(storagePath, 4 * 60 * 60);
      if (signedError || !signed?.signedUrl) return json({ ok: false, error: signedError?.message || "Foto salva, mas não foi possível gerar a visualização." }, 500);

      return json({
        ok: true,
        data: { ...inserted, signed_url: signed.signedUrl },
        generatedAt: new Date().toISOString(),
      });
    }

    const { data: rows, error: rowsError } = await admin
      .schema("ops_core")
      .from("stage_evidence")
      .select("id,item_id,item_stage_id,photo_type,caption,taken_at,uploaded_by_name,content_type,file_size_bytes,storage_bucket,storage_path")
      .eq("item_id", itemId)
      .eq("item_stage_id", stage.id)
      .order("taken_at", { ascending: true })
      .limit(100);
    if (rowsError) return json({ ok: false, error: rowsError.message }, 500);

    const photos = await Promise.all((rows || []).map(async (row: Record<string, unknown>) => {
      const bucket = String(row.storage_bucket || "ops-evidence");
      const path = String(row.storage_path || "");
      const { data: signed, error: signedError } = await admin.storage.from(bucket).createSignedUrl(path, 4 * 60 * 60);
      return {
        id: row.id,
        item_id: row.item_id,
        item_stage_id: row.item_stage_id,
        photo_type: row.photo_type,
        caption: row.caption,
        taken_at: row.taken_at,
        uploaded_by_name: row.uploaded_by_name,
        content_type: row.content_type,
        file_size_bytes: row.file_size_bytes,
        signed_url: signedError ? "" : signed?.signedUrl || "",
      };
    }));

    return json({ ok: true, data: { item_id: itemId, item_stage_id: stage.id, photos, generatedAt: new Date().toISOString() } });
  }


  if (action === "core_stage_action") {
    const itemId = String(body.itemId || "").trim();
    const stageKey = String(body.stageKey || "").trim();
    const operation = String(body.operation || "").trim().toLowerCase();
    const note = String(body.note || "").trim();
    const progressRaw = body.progress;
    const progress = progressRaw === null || progressRaw === undefined || progressRaw === ""
      ? null
      : Number(progressRaw);

    if (!itemId || !operation) {
      return json({ ok: false, error: "itemId e operation são obrigatórios." }, 400);
    }
    if (progress !== null && !Number.isFinite(progress)) {
      return json({ ok: false, error: "Progress inválido." }, 400);
    }

    const actorName = sessionUser
      ? String(sessionUser.name || sessionUser.username || sessionUser.email || actor)
      : "system-backend";
    const actorRole = String(sessionUser?.role || "").toLowerCase();
    const actorSector = sessionUser
      ? (["admin", "administrator", "administrador"].includes(actorRole)
        ? "admin"
        : String(sessionUser.sector || ""))
      : String(body.actorSector || "");

    const rpcName = stageKey ? "ops_core_stage_action_for_stage" : "ops_core_stage_action";
    const { data, error } = await admin.rpc(rpcName, {
      p_item_id: itemId,
      ...(stageKey ? { p_stage_key: stageKey } : {}),
      p_action: operation,
      p_actor_email: actor,
      p_actor_name: actorName,
      p_actor_sector: actorSector,
      p_progress: progress,
      p_note: note || null,
    });
    if (error) return json({ ok: false, error: error.message }, 409);
    await refreshDemandCache();

    return json({ ok: true, data, generatedAt: new Date().toISOString() });
  }

  if (action === "legacy_stage_action") {
    if (!mayManageCore) return json({ ok: false, error: "Somente PCP ou administrador pode editar os avanços operacionais." }, 403);

    const region = String(body.region || "BR").trim() || "BR";
    const projectRowId = String(body.projectRowId || "").trim();
    const projectNumber = String(body.projectNumber || "").trim();
    const iso = String(body.iso || "").trim();
    const stageKey = String(body.stageKey || "").trim();
    const trackingStageKey = String(body.trackingStageKey || "").trim();
    const operation = String(body.operation || "").trim().toLowerCase();
    const note = String(body.note || "").trim().slice(0, 500);
    const progressRaw = body.progress;
    const progress = progressRaw === null || progressRaw === undefined || progressRaw === ""
      ? null
      : Number(progressRaw);

    if (!projectRowId || !iso || !operation || !stageKey || !trackingStageKey) {
      return json({ ok: false, error: "projectRowId, iso, stageKey, trackingStageKey e operation são obrigatórios." }, 400);
    }
    if (progress !== null && !Number.isFinite(progress)) {
      return json({ ok: false, error: "Progress inválido." }, 400);
    }
    if ((operation === "start" || operation === "progress") &&
      (progress === null || !PANEL_PROGRESS_STEPS.has(progress))) {
      return json({ ok: false, error: "O avanço pelo painel deve ser 25%, 50%, 75% ou 100%." }, 400);
    }
    if (operation === "complete" && progress !== null && progress !== 100) {
      return json({ ok: false, error: "A conclusão da etapa deve registrar 100%." }, 400);
    }

    const actorName = sessionUser
      ? String(sessionUser.name || sessionUser.username || sessionUser.email || actor)
      : "system-backend";
    const { data, error } = await admin.rpc("ops_core_apply_panel_legacy_stage_action", {
      p_region: region,
      p_project_row_id: projectRowId,
      p_project_number: projectNumber,
      p_iso: iso,
      p_stage_key: stageKey,
      p_tracking_stage_key: trackingStageKey,
      p_action: operation,
      p_actor_email: actor,
      p_actor_name: actorName,
      p_progress: progress,
      p_note: note || null,
    });
    if (error) return json({ ok: false, error: error.message }, 409);

    await refreshDemandCache();
    return json({
      ok: true,
      data: {
        ...(data && typeof data === "object" ? data : { result: data }),
      },
      generatedAt: new Date().toISOString(),
    });
  }

  if (action === "new_bsp_alerts") {
    if (!mayManageCore) return json({ ok: true, data: [], generatedAt: new Date().toISOString() });

    const requestedLimit = Number(body.limit || 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.trunc(requestedLimit), 50))
      : 10;

    const { data, error } = await admin.rpc("ops_core_new_bsp_alerts", {
      p_limit: limit,
    });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data: Array.isArray(data) ? data : [], generatedAt: new Date().toISOString() });
  }

  if (action === "core_notifications") {
    const requestedSector = String(body.sector || "").trim();
    const actorSector = sessionUser ? String(sessionUser.sector || "") : requestedSector;
    const role = String(sessionUser?.role || "").toLowerCase();
    const canReadAnySector = trustedSystem || role === "admin" || role === "administrator" || role === "administrador";
    const requestedSectorNorm = requestedSector
      .normalize("NFD")
      .replace(/[\\u0300-\\u036f]/g, "")
      .toLowerCase();
    const requestedAll = !requestedSector || ["all", "todos", "all sectors", "todos os setores"].includes(requestedSectorNorm);
    const sector = canReadAnySector
      ? (requestedAll ? null : requestedSector)
      : (actorSector || null);
    const userEmail = sessionUser ? String(sessionUser.email || sessionUser.username || "") : String(body.user || "");

    const requestedLimit = Number(body.limit || 200);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.trunc(requestedLimit), 1000))
      : 200;

    const { data, error } = await admin.rpc("ops_core_notifications", {
      p_sector: sector,
      p_user: userEmail || null,
      p_limit: limit,
    });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data: Array.isArray(data) ? data : [], generatedAt: new Date().toISOString() });
  }

  if (action === "core_notification_read") {
    const notificationId = String(body.notificationId || "").trim();
    if (!notificationId) return json({ ok: false, error: "notificationId é obrigatório." }, 400);

    const { data, error } = await admin.rpc("ops_core_notification_read", {
      p_notification_id: notificationId,
      p_actor: actor,
    });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data, generatedAt: new Date().toISOString() });
  }



  if (action === "archive_detail") {
    const projectCore = String(body.projectCore || "").trim();
    if (!projectCore) return json({ ok: false, error: "projectCore é obrigatório." }, 400);

    const { data, error } = await admin.rpc("ops_core_archive_detail", {
      p_project_core: projectCore,
    });
    if (error) return json({ ok: false, error: error.message }, 500);
    if (!data || data.ok === false) return json({ ok: false, error: "Projeto arquivado não encontrado.", data }, 404);
    return json({ ok: true, data, generatedAt: new Date().toISOString() });
  }

  if (action === "archive_catalog") {
    const yearRaw = body.year;
    const year = yearRaw === null || yearRaw === undefined || yearRaw === "" ? null : Number(yearRaw);
    const search = String(body.search || "").trim();
    const requestedLimit = Number(body.limit || 1000);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.trunc(requestedLimit), 5000))
      : 1000;

    if (year !== null && (!Number.isInteger(year) || year < 2000 || year > 2100)) {
      return json({ ok: false, error: "Ano inválido." }, 400);
    }

    const { data, error } = await admin.rpc("ops_core_archive_catalog", {
      p_year: year,
      p_search: search || null,
      p_limit: limit,
    });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data: Array.isArray(data) ? data : [], generatedAt: new Date().toISOString() });
  }

  if (action === "annual_summary") {
    const { data, error } = await admin.rpc("ops_core_annual_summary");
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data: Array.isArray(data) ? data : [], generatedAt: new Date().toISOString() });
  }

  if (action === "history_health") {
    const { data, error } = await admin.rpc("ops_core_history_health");
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, data: data || {}, generatedAt: new Date().toISOString() });
  }

  if (action === "demands") {
    const region = String(body.region || "BR").trim() || "BR";
    const search = String(body.search || "").trim();
    const requestedLimit = Number(body.limit || 2000);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.trunc(requestedLimit), search ? 2000 : 5000))
      : 2000;

    const rpcName = search ? "ops_core_search_demands" : "ops_core_get_demands";
    const rpcArgs = search
      ? { p_region: region, p_search: search, p_limit: limit }
      : { p_region: region, p_limit: limit };

    const [{ data, error }, { data: executionOverlay, error: executionError }, { data: panelAdvanceOverlay, error: panelAdvanceError }, { data: activeProjectRows, error: activeProjectsError }] = await Promise.all([
      admin.rpc(rpcName, rpcArgs),
      admin.rpc("ops_panel_get_execution_overlay"),
      admin.rpc("ops_core_get_panel_legacy_stage_advances", { p_region: region }),
      admin
        .from("tracking_projects")
        .select("region,project_row_id,project_number,project_display,client,vessel,project_type,project_status,pm,planned_start,planned_finish,replanned_finish,fabrication_start,overall_progress,weight_kg,m2,source_version,source_updated_at,synced_at")
        .eq("region", region)
        .eq("active", true),
    ]);

    if (error) return json({ ok: false, error: error.message }, 500);
    if (executionError) console.error("execution overlay error:", executionError.message);
    if (panelAdvanceError) console.error("panel advance overlay error:", panelAdvanceError.message);
    if (activeProjectsError) return json({ ok: false, error: activeProjectsError.message }, 500);

    const activeProjects = Array.isArray(activeProjectRows) ? activeProjectRows as Record<string, unknown>[] : [];
    const activeProjectIds = new Set(activeProjects.map((project) => String(project.project_row_id || "")).filter(Boolean));
    const projectByRowId = new Map(activeProjects.map((project) => [String(project.project_row_id || ""), project]));
    const { data: activeTrackingIsoRows, error: activeTrackingIsosError } = activeProjectIds.size
      ? await admin
        .from("tracking_isos")
        .select("region,project_row_id,iso_key,project_number,iso,drawing,line_number,description,client_tag,project_type,current_stage,current_status,planned_start,planned_finish,fabrication_start,overall_progress,weight_kg,m2,source_version,source_updated_at,synced_at,active")
        .eq("region", region)
        .eq("active", true)
        .in("project_row_id", Array.from(activeProjectIds))
      : { data: [], error: null };

    if (activeTrackingIsosError) return json({ ok: false, error: activeTrackingIsosError.message }, 500);

    const compact = (value: unknown) =>
      String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

    // Tracking contains legacy aliases for some tags.  In particular, PS-011
    // and PS-11 refer to the same logical tag even though their raw keys differ.
    // Keep the displayed value from the preferred row, but use this canonical
    // form only for identity/deduplication.
    const canonicalIso = (value: unknown) =>
      compact(value).replace(/PS0+([0-9]+)/g, "PS$1");

    const rowIdentity = (item: Record<string, unknown>) => {
      const projectRowId = String(item.project_row_id || "");
      const projectKey = compact(item.project_number);
      const isoNorm = compact(item.iso_key || item.drawing || item.iso);
      return projectRowId && isoNorm
        ? "row:" + projectRowId + ":" + isoNorm
        : "project:" + projectKey + ":" + isoNorm;
    };

    const logicalRowIdentity = (item: Record<string, unknown>) => {
      const projectRowId = String(item.project_row_id || "");
      const projectKey = compact(item.project_number);
      const isoNorm = canonicalIso(item.iso_key || item.drawing || item.iso);
      return projectRowId && isoNorm
        ? "row:" + projectRowId + ":" + isoNorm
        : "project:" + projectKey + ":" + isoNorm;
    };

    const rpcRows = Array.isArray(data) ? data as Record<string, unknown>[] : [];
    const eligibleRpcRows = rpcRows.filter((item) => {
      // OPS CORE records are already part of the new operational source. Legacy
      // records must still belong to an active Tracking project in the main view.
      return item.source_mode === "ops_core" || activeProjectIds.has(String(item.project_row_id || ""));
    });
    const normalizedSearch = search.toLowerCase();
    const trackingRows = (Array.isArray(activeTrackingIsoRows) ? activeTrackingIsoRows as Record<string, unknown>[] : [])
      .map((iso) => {
        const project = projectByRowId.get(String(iso.project_row_id || "")) || {};
        return {
          ...iso,
          project_display: project.project_display || null,
          client: project.client || null,
          vessel: project.vessel || null,
          pm: project.pm || null,
          project_status: project.project_status || null,
          replanned_finish: project.replanned_finish || null,
          archived: false,
          archive_source: null,
          archive_rank: null,
          source_mode: "legacy_tracking",
          core_project_id: null,
          core_item_id: null,
        };
      });
    const liveTrackingByIdentity = new Map(trackingRows.map((row) => [rowIdentity(row), row]));

    const sourceVersion = (row: Record<string, unknown>) => {
      const value = Number(row.source_version);
      return Number.isFinite(value) ? value : null;
    };

    const sourceTime = (row: Record<string, unknown>) => {
      const value = Date.parse(String(row.source_updated_at || row.synced_at || ""));
      return Number.isFinite(value) ? value : null;
    };

    // The RPC is refreshed from the latest Tracking source rows. The public
    // tracking_isos table is a legacy mirror and can lag one or more source
    // versions behind. Never let that mirror replace a newer RPC row.
    const preferLiveRow = (item: Record<string, unknown>, live: Record<string, unknown>) => {
      const itemVersion = sourceVersion(item);
      const liveVersion = sourceVersion(live);
      if (itemVersion !== null && liveVersion !== null && itemVersion !== liveVersion) {
        return itemVersion > liveVersion ? item : { ...item, ...live };
      }

      const itemTime = sourceTime(item);
      const liveTime = sourceTime(live);
      if (itemTime !== null && liveTime !== null && itemTime >= liveTime) return item;
      return { ...item, ...live };
    };

    const progressValue = (row: Record<string, unknown>) => {
      const value = Number(row.overall_progress ?? row.progress ?? 0);
      return Number.isFinite(value) ? value : 0;
    };

    const preferLogicalRow = (current: Record<string, unknown>, candidate: Record<string, unknown>) => {
      if (current.source_mode !== candidate.source_mode) {
        if (candidate.source_mode === "ops_core") return candidate;
        if (current.source_mode === "ops_core") return current;
      }
      const currentProgress = progressValue(current);
      const candidateProgress = progressValue(candidate);
      if (candidateProgress !== currentProgress) return candidateProgress > currentProgress ? candidate : current;

      const currentVersion = sourceVersion(current) ?? -1;
      const candidateVersion = sourceVersion(candidate) ?? -1;
      if (candidateVersion !== currentVersion) return candidateVersion > currentVersion ? candidate : current;

      const currentTime = sourceTime(current) ?? -1;
      const candidateTime = sourceTime(candidate) ?? -1;
      if (candidateTime !== currentTime) return candidateTime > currentTime ? candidate : current;
      return current;
    };

    const dedupeLogicalRows = (rows: Record<string, unknown>[]) => {
      const byIdentity = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const identity = logicalRowIdentity(row);
        const existing = byIdentity.get(identity);
        byIdentity.set(identity, existing ? preferLogicalRow(existing, row) : row);
      }
      return Array.from(byIdentity.values());
    };

    // The cache and the live Tracking table can use different casing or
    // punctuation in iso_key (for example BSP...ISO001SP01 vs bsp...iso001sp01).
    // Match on a canonical identity and prefer the live active Tracking row for
    // legacy items, otherwise the same ISO is returned twice with two statuses
    // and two progress values.
    const currentRows = dedupeLogicalRows(eligibleRpcRows.map((item) => {
      if (item.source_mode === "ops_core") return item;
      const live = liveTrackingByIdentity.get(rowIdentity(item));
      return live ? preferLiveRow(item, live) : item;
    }));
    const representedIdentities = new Set(currentRows.map(logicalRowIdentity));
    const trackingIsoFallbackRows = trackingRows
      .filter((iso) => {
        const project = projectByRowId.get(String(iso.project_row_id || ""));
        if (!project || representedIdentities.has(logicalRowIdentity(iso))) return false;
        if (!normalizedSearch) return true;
        return [
          project.project_number,
          project.project_display,
          project.client,
          project.vessel,
          project.project_type,
          project.project_status,
          project.pm,
          iso.iso_key,
          iso.project_number,
          iso.iso,
          iso.drawing,
          iso.current_stage,
          iso.current_status,
        ].some((value) => String(value || "").toLowerCase().includes(normalizedSearch));
      });
    const representedProjectIds = new Set([
      ...currentRows,
      ...trackingIsoFallbackRows,
    ].map((item) => String(item.project_row_id || "")).filter(Boolean));
    const missingProjectRows = activeProjects
      .filter((project) => !representedProjectIds.has(String(project.project_row_id || "")))
      .filter((project) => {
        if (!normalizedSearch) return true;
        return [
          project.project_number,
          project.project_display,
          project.client,
          project.vessel,
          project.project_type,
          project.project_status,
          project.pm,
        ].some((value) => String(value || "").toLowerCase().includes(normalizedSearch));
      })
      .map((project) => ({
        region: project.region || region,
        iso_key: "project-only:" + String(project.project_row_id),
        project_row_id: project.project_row_id,
        project_number: project.project_number,
        iso: "",
        drawing: null,
        line_number: null,
        description: "Projeto ativo sem ISO vinculada no feed atual.",
        client_tag: null,
        project_type: project.project_type || null,
        current_stage: String(project.project_status || "").toUpperCase() === "ON HOLD" ? "On Hold" : null,
        current_status: project.project_status || "Sem demanda vinculada",
        planned_start: project.planned_start || null,
        planned_finish: project.planned_finish || null,
        fabrication_start: project.fabrication_start || null,
        overall_progress: project.overall_progress ?? 0,
        weight_kg: project.weight_kg || null,
        m2: project.m2 || null,
        source_version: project.source_version || null,
        source_updated_at: project.source_updated_at || null,
        synced_at: project.synced_at || null,
        project_display: project.project_display || null,
        client: project.client || null,
        vessel: project.vessel || null,
        pm: project.pm || null,
        project_status: project.project_status || null,
        replanned_finish: project.replanned_finish || null,
        archived: false,
        archive_source: null,
        archive_rank: null,
        source_mode: "legacy_tracking",
        core_project_id: null,
        core_item_id: null,
      }));
    const baseRows = dedupeLogicalRows([...currentRows, ...trackingIsoFallbackRows, ...missingProjectRows]);

    const overlayRows = Array.isArray(executionOverlay) ? executionOverlay : [];
    const overlayMap = new Map<string, Record<string, unknown>>();

    for (const item of overlayRows) {
      const row = item as Record<string, unknown>;
      const projectRowId = String(row.project_row_id || "");
      const projectKey = compact(row.project_key || row.bsp_number);
      const isoNorm = canonicalIso(row.iso_norm || row.iso);

      if (projectRowId && isoNorm) overlayMap.set("row:" + projectRowId + ":" + isoNorm, row);
      if (projectKey && isoNorm) overlayMap.set("project:" + projectKey + ":" + isoNorm, row);
    }

    const panelAdvanceRows = Array.isArray(panelAdvanceOverlay) ? panelAdvanceOverlay : [];
    const panelAdvanceMap = new Map<string, Record<string, unknown>>();
    for (const item of panelAdvanceRows) {
      const row = item as Record<string, unknown>;
      const projectRowId = String(row.project_row_id || "");
      const projectKey = compact(row.project_number);
      const isoNorm = canonicalIso(row.iso_key || row.drawing || row.iso);
      if (projectRowId && isoNorm) panelAdvanceMap.set("row:" + projectRowId + ":" + isoNorm, row);
      if (projectKey && isoNorm) panelAdvanceMap.set("project:" + projectKey + ":" + isoNorm, row);
    }

    const merged = baseRows.map((item: Record<string, unknown>) => {
      const projectRowId = String(item.project_row_id || "");
      const projectKey = compact(item.project_number);
      const isoNorm = canonicalIso(item.iso_key || item.drawing || item.iso);
      const execution =
        overlayMap.get("row:" + projectRowId + ":" + isoNorm)
        || overlayMap.get("project:" + projectKey + ":" + isoNorm);
      const panelAdvance =
        panelAdvanceMap.get("row:" + projectRowId + ":" + isoNorm)
        || panelAdvanceMap.get("project:" + projectKey + ":" + isoNorm);

      const withPanelAdvance = panelAdvance
        ? {
            ...item,
            panel_stage_overrides: Array.isArray(panelAdvance.stage_overrides) ? panelAdvance.stage_overrides : [],
          }
        : item;

      if (!execution) return withPanelAdvance;

      return {
        ...withPanelAdvance,
        hh_session_id: execution.session_id || null,
        hh_status: execution.hh_status || null,
        hh_activity_key: execution.activity_key || null,
        hh_activity_name: execution.activity_name || null,
        hh_progress_percent: execution.progress_percent ?? null,
        hh_progress_status: execution.progress_status || null,
        hh_progress_stage_key: execution.progress_stage_key || null,
        hh_progress_sector: execution.progress_sector || null,
        hh_work_state: execution.work_state || null,
        hh_start_at: execution.start_at || null,
        hh_end_at: execution.end_at || null,
        hh_finish_status: execution.finish_status || null,
        hh_total_workers: execution.total_workers ?? null,
        hh_total_hh: execution.total_hh ?? null,
        hh_created_by_name: execution.created_by_name || null,
        hh_finished_by_name: execution.finished_by_name || null,
        hh_progress_updated_by_name: execution.progress_updated_by_name || null,
        hh_execution_updated_at: execution.execution_updated_at || null,
        hh_tracking_stage_key: execution.tracking_stage_key || null,
        hh_tracking_stage_name: execution.tracking_stage_name || null,
        hh_tracking_stage_order: execution.tracking_stage_order ?? null,
        hh_source_progress_column: execution.source_progress_column || null,
        hh_source_actual_column: execution.source_actual_column || null,
      };
    });

    return json({
      ok: true,
      data: merged,
      search,
      generatedAt: new Date().toISOString(),
    });
  }

  return json({ ok: false, error: "Ação inválida." }, 400);
});
