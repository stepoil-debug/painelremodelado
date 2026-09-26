import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx@0.18.5";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ops-sync-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function textValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("; ");
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    return textValue(v.value ?? v.title ?? v.name ?? v.label ?? v.text ?? v.id ?? "");
  }
  return String(value).trim();
}

function compact(value: unknown) {
  return textValue(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeHeader(value: unknown) {
  return textValue(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeProjectCore(value: unknown): string {
  let raw = textValue(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/^\s*BSP\s*[-:#]?\s*/i, "")
    .trim();

  const match = raw.match(/\d{2,3}\s*[-./ ]\s*\d{2,4}(?:\s*[-./ ]\s*\d{1,3})?/);
  if (match) {
    return match[0].replace(/\s*[-./ ]\s*/g, "-");
  }

  return raw.replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function safeDate(value: unknown): string | null {
  const raw = textValue(value);
  if (!raw) return null;
  const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (br) {
    const [, d, m, y, hh = "00", mm = "00", ss = "00"] = br;
    const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${hh.padStart(2, "0")}:${mm}:${ss}`;
    const dt = new Date(iso);
    if (!Number.isNaN(dt.getTime())) return dt.toISOString();
  }
  const dt = new Date(raw);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function mapFromRow(row: Record<string, unknown>) {
  const map = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row)) {
    map.set(normalizeHeader(key), value);
  }
  return map;
}

function collectNamedFields(node: unknown, out = new Map<string, unknown>(), depth = 0): Map<string, unknown> {
  if (node == null || depth > 7) return out;
  if (Array.isArray(node)) {
    for (const item of node) collectNamedFields(item, out, depth + 1);
    return out;
  }
  if (typeof node !== "object") return out;

  const obj = node as Record<string, unknown>;
  const label = textValue(obj.title ?? obj.label ?? obj.fieldName ?? obj.name);
  const namedValue = obj.value ?? obj.answer ?? obj.fieldValue ?? obj.values ?? obj.content ?? obj.selectedValues;
  if (label && namedValue != null && textValue(namedValue)) {
    out.set(normalizeHeader(label), namedValue);
  }

  for (const [key, value] of Object.entries(obj)) {
    if (value == null) continue;
    if (typeof value !== "object" && textValue(value)) {
      const normalized = normalizeHeader(key);
      if (!out.has(normalized)) out.set(normalized, value);
    } else {
      collectNamedFields(value, out, depth + 1);
    }
  }
  return out;
}

function pick(map: Map<string, unknown>, aliases: string[]): unknown {
  for (const alias of aliases) {
    const key = normalizeHeader(alias);
    if (map.has(key)) return map.get(key);
  }
  for (const alias of aliases) {
    const key = normalizeHeader(alias);
    for (const [candidate, value] of map.entries()) {
      if (candidate.includes(key) || key.includes(candidate)) return value;
    }
  }
  return null;
}

function toStringArray(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((v) => {
      if (typeof v === "object" && v) {
        const obj = v as Record<string, unknown>;
        return [textValue(obj.title ?? obj.name ?? obj.label ?? obj.value ?? obj.id)];
      }
      return [textValue(v)];
    }).filter(Boolean))];
  }
  const raw = textValue(value);
  if (!raw) return [];
  return [...new Set(raw.split(/[\n;,|]+/).map((v) => v.trim()).filter(Boolean))];
}

function itemKey(value: unknown) {
  return compact(value);
}

function extractItems(itemsValue: unknown, relationValue: unknown) {
  const result: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  const add = (label: string, source: string, relationId = "") => {
    const key = itemKey(label);
    if (!key || seen.has(source + ":" + key)) return;
    seen.add(source + ":" + key);
    result.push({
      item_key: key,
      item_label: label,
      relation_id: relationId || null,
      source_field: source,
      item_type: /SUP/i.test(label) ? "SUPPORT" : /STR/i.test(label) ? "STRUCTURE" : /(ISO|SPL|SPOOL)/i.test(label) ? "SPOOL" : null,
      quantity: null,
    });
  };

  if (Array.isArray(relationValue)) {
    for (const entry of relationValue) {
      if (entry && typeof entry === "object") {
        const obj = entry as Record<string, unknown>;
        const label = textValue(obj.title ?? obj.name ?? obj.label ?? obj.value ?? obj.text ?? obj.id);
        if (label) add(label, "Itens Brasfels", textValue(obj.id ?? obj.valueId ?? obj.registerId));
      } else {
        const label = textValue(entry);
        if (label) add(label, "Itens Brasfels");
      }
    }
  } else {
    for (const label of toStringArray(relationValue)) add(label, "Itens Brasfels");
  }

  const itemsText = textValue(itemsValue);
  const explicit = itemsText.match(/(?:BSP[-\s]*)?\d{2,3}[-./\s]*\d{2,4}(?:[-./\s]*\d{1,3})?[-./\s]*(?:ISO|SPL|STR|SUP|SPOOL)[-./\s]*[A-Z0-9-]+/gi) ?? [];
  if (explicit.length) {
    explicit.forEach((label) => add(label.replace(/[./\s]+/g, "-"), "ITEMS"));
  } else {
    toStringArray(itemsValue)
      .filter((label) => /(ISO|SPL|STR|SUP|SPOOL)/i.test(label))
      .forEach((label) => add(label, "ITEMS"));
  }

  return result;
}

function materialScope(tags: string[], itemsText: string, map: Map<string, unknown>) {
  const full = [tags.join(" "), itemsText, textValue(pick(map, ["DN PARA", "TIPO", "TIPO MATERIAL", "MATERIAL"]))].join(" ").toUpperCase();
  const loose = /LOOSE|LOOSEMATERIAL|MATERIALAVULSO/.test(compact(full));
  const spool = /SPOOL|ISO|TUBULACAO/.test(compact(full));
  if (loose && spool) return "mixed";
  if (loose) return "loose";
  if (spool) return "spool";
  return full.trim() ? "other" : "unknown";
}

function extractHistory(detail: unknown) {
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  function walk(node: unknown, parentKey = "", depth = 0) {
    if (node == null || depth > 7) return;
    if (Array.isArray(node)) {
      if (/HISTORY|HISTOR|MOVEMENT|PHASE|FASE|TIMELINE/i.test(parentKey)) {
        for (const entry of node) {
          if (!entry || typeof entry !== "object") continue;
          const obj = entry as Record<string, unknown>;
          const phaseObj = (obj.phase && typeof obj.phase === "object" ? obj.phase : null) as Record<string, unknown> | null;
          const phaseName = textValue(obj.phaseName ?? obj.phaseTitle ?? phaseObj?.title ?? phaseObj?.name ?? obj.title ?? obj.name);
          if (!phaseName) continue;
          const entered = safeDate(obj.enteredAt ?? obj.startAt ?? obj.createdAt ?? obj.date ?? obj.movedAt);
          const exited = safeDate(obj.exitedAt ?? obj.endAt ?? obj.finishedAt);
          const phaseId = textValue(obj.phaseId ?? phaseObj?.id);
          const sig = [phaseId, phaseName, entered, exited].join("|");
          if (seen.has(sig)) continue;
          seen.add(sig);
          rows.push({
            phase_id: phaseId || null,
            phase_name: phaseName,
            phase_order: Number(obj.index ?? obj.order ?? phaseObj?.index ?? 0) || null,
            entered_at: entered,
            exited_at: exited,
            duration_minutes: Number(obj.durationMinutes ?? obj.minutes ?? 0) || null,
            raw: obj,
          });
        }
      }
      for (const entry of node) walk(entry, parentKey, depth + 1);
      return;
    }
    if (typeof node === "object") {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        walk(value, key, depth + 1);
      }
    }
  }

  walk(detail);
  return rows;
}

function phaseFromTop(detail: Record<string, unknown>, map: Map<string, unknown>) {
  const candidates = [detail.currentPhase, detail.phase, detail.current_phase];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      const obj = candidate as Record<string, unknown>;
      const name = textValue(obj.title ?? obj.name ?? obj.label);
      if (name) return { id: textValue(obj.id) || null, name, index: Number(obj.index ?? 0) || null };
    }
  }
  return {
    id: textValue(pick(map, ["PHASE ID", "FASE ID"])) || null,
    name: textValue(pick(map, ["Fase atual", "Current Phase", "Phase"])) || "",
    index: null,
  };
}

function normalizeCard(raw: Record<string, unknown>, boardId: string, source: "report" | "api") {
  const map = source === "report" ? mapFromRow(raw) : collectNamedFields(raw);
  const phase = phaseFromTop(raw, map);
  const tags = toStringArray(raw.tags ?? pick(map, ["Etiquetas", "Tags", "Tag"]));
  const dnNumber = textValue(pick(map, ["DN#", "DN Nº", "DN", "Delivery Note", "Numero DN"]));
  const projectDisplay = textValue(pick(map, ["BSP#", "BSP", "BSP Number", "Projeto", "Project"]));
  const projectCore = normalizeProjectCore(projectDisplay);
  const itemsValue = pick(map, ["ITEMS", "Itens", "Itens DN", "Materiais"]);
  const relationValue = pick(map, ["Itens Brasfels", "Brasfels Items", "Itens da Brasfels"]);
  const itemsText = textValue(itemsValue);
  const history = source === "api" ? extractHistory(raw) : [];
  const phaseNorm = compact(phase.name);
  const tagNorm = compact(tags.join(" "));
  const shippedHistory = history.find((h) => /EXPEDIDO|DESPACHADO|ENVIADO/.test(compact(h.phase_name)));
  const readyHistory = history.find((h) => /PRONTAPARAENVIO|PRONTOPARAENVIO/.test(compact(h.phase_name)));
  const isShipped = Boolean(shippedHistory) || /EXPEDIDO|DESPACHADO|ENVIADO/.test(phaseNorm) || /MATERIALENVIADO|EXPEDIDO/.test(tagNorm);
  const isReady = isShipped || Boolean(readyHistory) || /PRONTAPARAENVIO|PRONTOPARAENVIO/.test(phaseNorm);

  const topId = textValue(raw.id ?? raw.cardId ?? raw.card_id);
  const fallbackId = ["report", projectCore, dnNumber, textValue(raw.title ?? pick(map, ["Título do Card", "Card Title"]))].map(compact).filter(Boolean).join(":");

  return {
    card_id: topId || fallbackId,
    board_id: boardId,
    project_core: projectCore || null,
    project_display: projectDisplay || null,
    dn_number: dnNumber || null,
    card_title: textValue(raw.title ?? pick(map, ["Título do Card", "Card Title", "Título"])) || null,
    phase_id: phase.id,
    phase_name: phase.name || null,
    phase_index: phase.index,
    client: textValue(pick(map, ["Cliente", "Client"])) || null,
    project_manager: textValue(pick(map, ["Project Manager", "PM", "Gerente Projeto"])) || null,
    destination: textValue(pick(map, ["Destino", "Destination"])) || null,
    dn_for: textValue(pick(map, ["DN PARA", "DN For"])) || null,
    po_number: textValue(pick(map, ["PO", "PO#", "Purchase Order"])) || null,
    items_text: itemsText || null,
    brasfels_items: Array.isArray(relationValue) ? relationValue : toStringArray(relationValue),
    tags,
    invoice_number: textValue(pick(map, ["Nota Fiscal", "NF", "Invoice", "Invoice Number"])) || null,
    invoice_url: textValue(pick(map, ["Link NF", "NF Protocolada", "Nota Fiscal Link", "Invoice URL"])) || null,
    created_at_source: safeDate(raw.createdAt ?? pick(map, ["Criado em", "Created At"])),
    updated_at_source: safeDate(raw.updatedAt ?? pick(map, ["Ultima atualização", "Última atualização", "Updated At"])),
    date_in_current_phase: safeDate(raw.dateInCurrentPhase ?? pick(map, ["Data na fase atual", "Date in Current Phase"])),
    finished_at_source: safeDate(raw.finishedAt ?? pick(map, ["Concluído em", "Finished At"])),
    ready_at: readyHistory?.entered_at ?? (isReady ? safeDate(raw.dateInCurrentPhase ?? pick(map, ["Data na fase atual"])) : null),
    shipped_at: shippedHistory?.entered_at ?? (isShipped ? safeDate(raw.finishedAt ?? raw.dateInCurrentPhase ?? pick(map, ["Concluído em", "Data na fase atual"])) : null),
    is_ready: isReady,
    is_shipped: isShipped,
    material_scope: materialScope(tags, itemsText, map),
    items: extractItems(itemsValue, relationValue),
    phase_history: history,
    raw,
  };
}

async function goalfyFetch(url: string, token: string, sessionId: string) {
  let lastStatus = 0;
  let lastBody = "";

  // Goalfy installations in use by this board expose the same read API with
  // either the legacy Token scheme or the standard Bearer scheme. Try the
  // legacy scheme first and transparently fall back on an auth rejection.
  for (const scheme of ["Token", "Bearer"]) {
    const response = await fetch(url, {
      headers: {
        Authorization: `${scheme} ${token}`,
        "X-Session-Id": sessionId,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (response.ok) return response.json();

    lastStatus = response.status;
    lastBody = await response.text().catch(() => "");
    if (response.status !== 401 && response.status !== 403) break;
  }

  throw new Error(`Goalfy ${lastStatus}: ${lastBody || "Request failed"}`);
}

async function fetchDirectCards(boardId: string, token: string) {
  const sessionId = crypto.randomUUID();
  const cards: Record<string, unknown>[] = [];
  let page = 0;
  const limit = 100;
  let total = Infinity;

  while (page * limit < total && page < 50) {
    const payload = await goalfyFetch(
      `https://api.goalfy.com.br/api/cards/board/${boardId}/filter?limit=${limit}&offset=${page}&search=`,
      token,
      sessionId,
    );
    const body = payload && typeof payload === "object" && payload.data && typeof payload.data === "object"
      ? payload.data as Record<string, unknown>
      : payload as Record<string, unknown>;
    const batch = Array.isArray(payload)
      ? payload
      : Array.isArray(body?.cards)
        ? body.cards
        : [];
    total = Number(body?.cardsCount ?? body?.total ?? body?.count ?? batch.length);
    cards.push(...batch);
    if (!batch.length || batch.length < limit) break;
    page += 1;
  }

  const details: Record<string, unknown>[] = [];
  const concurrency = 8;
  for (let i = 0; i < cards.length; i += concurrency) {
    const slice = cards.slice(i, i + concurrency);
    const chunk = await Promise.all(slice.map(async (card) => {
      const id = textValue(card.id ?? card.cardId ?? card.card_id);
      if (!id) return card;
      try {
        return await goalfyFetch(`https://api.goalfy.com.br/api/cards/view/${id}`, token, sessionId);
      } catch {
        return card;
      }
    }));
    details.push(...chunk);
  }
  return { cards: details, total: Number.isFinite(total) ? total : details.length };
}

async function fetchExternalReport(reportId: string, apiKey: string) {
  const url = `https://api.goalfy.com.br/api/reports/createExcelDownload/${encodeURIComponent(reportId)}/external?apiKey=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`Relatório Goalfy ${response.status}: ${await response.text().catch(() => "")}`);
  const buffer = await response.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("Relatório Goalfy sem planilha.");
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
}

async function fetchReportCatalog(boardId: string, apiKey: string) {
  const response = await fetch(
    `https://api.goalfy.com.br/api/reports/board/${boardId}?apiKey=${encodeURIComponent(apiKey)}`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) },
  );
  if (!response.ok) throw new Error(`Goalfy reports ${response.status}`);
  const payload = await response.json();
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.reports)
        ? payload.reports
        : [];
  return rows
    .map((row) => ({
      id: textValue(row?.id ?? row?.reportId),
      name: textValue(row?.name ?? row?.title),
    }))
    .filter((row) => row.id);
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "Supabase não configurado." }, 503);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const candidate = (request.headers.get("x-ops-sync-key") || "").trim();
  const { data: authorized, error: authError } = await admin.rpc("ops_panel_sync_auth", { p_candidate: candidate });
  if (authError || authorized !== true) return json({ ok: false, error: "Não autorizado." }, 401);

  const { data: runtimeConfig, error: configError } = await admin.rpc("ops_goalfy_runtime_config");
  if (configError) return json({ ok: false, error: configError.message }, 500);

  const runtime = (runtimeConfig || {}) as Record<string, unknown>;
  const boardId = String(runtime.board_id || Deno.env.get("GOALFY_BOARD_ID") || "").trim();
  const accessToken = String(runtime.access_token || Deno.env.get("GOALFY_ACCESS_TOKEN") || "").trim();
  const reportId = String(runtime.report_id || Deno.env.get("GOALFY_REPORT_ID") || "").trim();
  const apiKey = String(runtime.api_key || Deno.env.get("GOALFY_API_KEY") || "").trim();

  if (!boardId) return json({ ok: false, error: "GOALFY_BOARD_ID não configurado." }, 503);

  const mode = reportId && apiKey ? "report_external" : "cards_api";
  let reportCandidates: Array<{ id: string; name: string }> = [];
  const { data: runId, error: beginError } = await admin.rpc("ops_goalfy_begin_sync", {
    p_board_id: boardId,
    p_mode: mode,
    p_total_cards: null,
    p_metadata: { observation_mode: true, source: "Goalfy" },
  });
  if (beginError || !runId) return json({ ok: false, error: beginError?.message || "Falha ao iniciar sync Goalfy." }, 500);

  try {
    let phases: unknown[] = [];
    if (accessToken) {
      try {
        const phasePayload = await goalfyFetch(
          `https://api.goalfy.com.br/api/phases/board/${boardId}`,
          accessToken,
          crypto.randomUUID(),
        );
        phases = Array.isArray(phasePayload) ? phasePayload : [];
        await admin.rpc("ops_goalfy_ingest_phases", { p_board_id: boardId, p_phases: phases });
      } catch (error) {
        console.warn("Goalfy phases unavailable:", error instanceof Error ? error.message : String(error));
      }
    }

    let rawCards: Record<string, unknown>[] = [];
    let totalCards = 0;

    if (reportId && apiKey) {
      rawCards = await fetchExternalReport(reportId, apiKey);
      totalCards = rawCards.length;
    } else if (accessToken) {
      try {
        const direct = await fetchDirectCards(boardId, accessToken);
        rawCards = direct.cards;
        totalCards = direct.total || rawCards.length;
      } catch (error) {
        if (error instanceof Error && /Goalfy 401|Goalfy 403/.test(error.message)) {
          try {
            reportCandidates = await fetchReportCatalog(boardId, accessToken);
          } catch {
            // Keep the original authentication error when catalog access is
            // unavailable as well.
          }
        }
        throw error;
      }
    } else {
      throw new Error("Credencial Goalfy não configurada. Defina GOALFY_ACCESS_TOKEN ou GOALFY_REPORT_ID + GOALFY_API_KEY.");
    }

    const normalized = rawCards
      .map((row) => normalizeCard(row, boardId, mode === "report_external" ? "report" : "api"))
      .filter((row) => row.card_id);

    const batchSize = 100;
    for (let i = 0; i < normalized.length; i += batchSize) {
      const batch = normalized.slice(i, i + batchSize);
      const { error } = await admin.rpc("ops_goalfy_ingest_cards", {
        p_run_id: runId,
        p_cards: batch,
      });
      if (error) throw new Error(error.message);
    }

    const { data: finished, error: finishError } = await admin.rpc("ops_goalfy_finish_sync", {
      p_run_id: runId,
      p_success: true,
      p_error: null,
      p_total_cards: totalCards,
      p_metadata: {
        normalized_cards: normalized.length,
        phases: phases.length,
        observation_mode: true,
      },
    });
    if (finishError) throw new Error(finishError.message);

    return json({
      ok: true,
      data: finished,
      mode,
      board_id: boardId,
      observation_mode: true,
      message: "Goalfy sincronizado em modo leitura. Nenhum progresso operacional foi alterado.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await admin.rpc("ops_goalfy_finish_sync", {
        p_run_id: runId,
        p_success: false,
        p_error: message,
        p_total_cards: null,
        p_metadata: { observation_mode: true },
      });
    } catch {
      // Preserve the original sync error if the failure bookkeeping itself
      // cannot be completed.
    }

    const needsReportConfig = /401|Unauthorized|Credencial Goalfy/.test(message);
    return json({
      ok: false,
      error: message,
      needs_report_config: needsReportConfig,
      report_candidates: reportCandidates,
      observation_mode: true,
      setup_hint: needsReportConfig
        ? "Configure GOALFY_REPORT_ID e GOALFY_API_KEY para usar o relatório externo oficial."
        : null,
    }, needsReportConfig ? 424 : 500);
  }
});
