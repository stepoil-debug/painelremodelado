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
    const [{ data: normalized, error: normalizedError }, { data: requestId, error }] = await Promise.all([
      admin.rpc("sync_tracking_normalized_if_needed", { p_region: "BR" }),
      admin.rpc("ops_panel_dispatch_sync", { p_force: false }),
    ]);

    if (normalizedError) return json({ ok: false, error: normalizedError.message }, 500);
    if (error) return json({ ok: false, error: error.message }, 500);

    return json({
      ok: true,
      data: {
        request_id: requestId,
        started_at: new Date().toISOString(),
        mode: "canonical_tracking_plus_integrations",
        tracking: normalized,
      },
      message: "Atualização solicitada. Tracking normalizado e integrações serão verificadas por versão.",
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

  if (action === "demands") {
    const region = String(body.region || "BR").trim() || "BR";
    const search = String(body.search || "").trim();
    const requestedLimit = Number(body.limit || 2000);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.trunc(requestedLimit), search ? 2000 : 5000))
      : 2000;

    const rpcName = search ? "ops_panel_search_demands" : "ops_panel_get_demands";
    const rpcArgs = search
      ? { p_region: region, p_search: search, p_limit: limit }
      : { p_region: region, p_limit: limit };

    const [{ data, error }, { data: executionOverlay, error: executionError }] = await Promise.all([
      admin.rpc(rpcName, rpcArgs),
      admin.rpc("ops_panel_get_execution_overlay"),
    ]);

    if (error) return json({ ok: false, error: error.message }, 500);
    if (executionError) console.error("execution overlay error:", executionError.message);

    const compact = (value: unknown) =>
      String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

    const overlayRows = Array.isArray(executionOverlay) ? executionOverlay : [];
    const overlayMap = new Map<string, Record<string, unknown>>();

    for (const item of overlayRows) {
      const row = item as Record<string, unknown>;
      const projectRowId = String(row.project_row_id || "");
      const projectKey = compact(row.project_key || row.bsp_number);
      const isoNorm = compact(row.iso_norm || row.iso);

      if (projectRowId && isoNorm) overlayMap.set("row:" + projectRowId + ":" + isoNorm, row);
      if (projectKey && isoNorm) overlayMap.set("project:" + projectKey + ":" + isoNorm, row);
    }

    const merged = (Array.isArray(data) ? data : []).map((item: Record<string, unknown>) => {
      const projectRowId = String(item.project_row_id || "");
      const projectKey = compact(item.project_number);
      const isoNorm = compact(item.drawing || item.iso);
      const execution =
        overlayMap.get("row:" + projectRowId + ":" + isoNorm)
        || overlayMap.get("project:" + projectKey + ":" + isoNorm);

      if (!execution) return item;

      return {
        ...item,
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
