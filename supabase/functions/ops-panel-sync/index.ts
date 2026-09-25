import { createClient } from "npm:@supabase/supabase-js@2";

type Source = {
  source_key: string;
  sheet_id: number;
  sheet_name: string;
  last_synced_version: number | null;
  current_version: number | null;
  config?: Record<string, unknown>;
};

const API = "https://api.smartsheet.com/2.0";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type,x-ops-sync-key",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}

function textValue(cell: any): string {
  if (!cell) return "";
  const raw = cell.value;
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (cell.displayValue != null) return String(cell.displayValue);
  if (cell.objectValue != null) {
    try { return JSON.stringify(cell.objectValue); } catch { return String(cell.objectValue); }
  }
  return "";
}

function displayValue(cell: any): string {
  if (!cell) return "";
  if (cell.displayValue != null) return String(cell.displayValue);
  return textValue(cell);
}

function normalizeTitle(title: string) {
  return title.trim().toLowerCase();
}

function pickCell(cells: Map<string, any>, title: string) {
  return cells.get(normalizeTitle(title));
}

function raw(cells: Map<string, any>, title: string) {
  return textValue(pickCell(cells, title)).trim();
}

function display(cells: Map<string, any>, title: string) {
  return displayValue(pickCell(cells, title)).trim();
}

function isFcbDocument(value: string) {
  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return /\bfcb\b/.test(normalized)
    || /fabrication\s+control\s+book/.test(normalized)
    || /controle\s+de\s+fabricacao/.test(normalized)
    || /control\s+book/.test(normalized);
}

function revisionField(title: string): string | null {
  const t = title.toLowerCase();
  if (t.includes("internally approved")) return "internally_sent_pm";
  if (t.includes("last client comments")) return "client_comments_date";
  if (t.includes("origin review")) return "origin_review";
  if (t.includes("last revision") && t.includes("start")) return "last_revision_start";
  if (t.includes("drawings start date")) return "start_date";
  if (t.includes("drawing number")) return "drawing_number";
  if (t.includes("draftman")) return t.includes("hh") ? "draftman_hh" : "draftman";
  if (t.includes("reviewer")) {
    if (t.includes("approval")) return "reviewer_approval";
    return t.includes("hh") ? "reviewer_hh" : "reviewer";
  }
  if (t.includes("approver")) {
    if (t.includes("approval")) return "approver_approval";
    return t.includes("hh") ? "approver_hh" : "approver";
  }
  if (t.includes("pm approval")) return "pm_approval";
  return null;
}

function deriveDrawing(cells: Map<string, any>, cellDisplay: Record<string, string>) {
  const groups = new Map<string, Record<string, unknown>>();
  for (const [titleLower, cell] of cells.entries()) {
    const m = titleLower.match(/\(rev\.\s*([a-z])\)/i);
    if (!m) continue;
    const value = displayValue(cell).trim();
    if (!value) continue;
    const revision = m[1].toUpperCase();
    const current = groups.get(revision) ?? { revision, raw: {} as Record<string, string> };
    const rawObj = current.raw as Record<string, string>;
    rawObj[titleLower] = value;
    const canonical = revisionField(titleLower);
    if (canonical) current[canonical] = textValue(cell).trim() || value;
    groups.set(revision, current);
  }

  const revisions = [...groups.values()].sort((a, b) => String(a.revision).localeCompare(String(b.revision)));
  const currentRevision = revisions.length ? String(revisions[revisions.length - 1].revision) : "";
  const projectKey = raw(cells, "Project Number")
    || display(cells, "Project Number")
    || display(cells, "Task Name (BSP, GASP, ICSP,SP)");

  const identifiers = [
    display(cells, "Task Name (BSP, GASP, ICSP,SP)"),
    display(cells, "Doc. Ref.Client / Title"),
    display(cells, "Drawing Number (Rev. A)"),
    ...Object.values(cellDisplay),
  ].join(" ");

  return {
    project_key: projectKey,
    client: display(cells, "Client"),
    task_name: display(cells, "Task Name (BSP, GASP, ICSP,SP)"),
    priority: display(cells, "Priority"),
    pm: display(cells, "PM Responsible"),
    po_number: display(cells, "Nº P.O."),
    document_title: display(cells, "Doc. Ref.Client / Title"),
    current_status: display(cells, "Current Drawing Status"),
    drawing_number: display(cells, "Drawing Number (Rev. A)"),
    approval_date: raw(cells, "Approval Date"),
    current_revision: currentRevision,
    is_fcb: isFcbDocument(identifiers),
    revisions,
  };
}

function deriveWip(cells: Map<string, any>) {
  return {
    project_key: raw(cells, "Project BSP/BPP/B3D*") || display(cells, "Project BSP/BPP/B3D*") || display(cells, "BSP"),
    bsp: display(cells, "BSP"),
    client: display(cells, "Cliente*"),
    vessel: display(cells, "Vessel*"),
    pm: display(cells, "PM*"),
    customer_po: display(cells, "Customer PO*"),
    acceptance_date: raw(cells, "Acceptance Date - PO date to be updated*"),
    contractual_date: raw(cells, "Contractual  PO Date*"),
    deadline_date: raw(cells, "Deadline Date as Agreeded with Client*"),
    drawing_approval_date: raw(cells, "Drawing Approval Date*"),
    progress_text: display(cells, "% Complete - Advance*"),
    overall_status: display(cells, "Overall Project Status*"),
    job_order_po: display(cells, "PO_Number (Job Order)"),
    po_value: raw(cells, "Valor da OC"),
    open_po_value: raw(cells, "Open PO Value"),
    modified_at: raw(cells, "Modified"),
  };
}

function deriveDimensional(cells: Map<string, any>, cellDisplay: Record<string, string>) {
  const identifiers = [
    display(cells, "Projeto - BSP"),
    display(cells, "Relatorio SOB referencia"),
    display(cells, "Spool"),
    ...Object.values(cellDisplay),
  ].join(" ");

  return {
    project_key: raw(cells, "Projeto - BSP") || display(cells, "Projeto - BSP"),
    client: display(cells, "Client"),
    unit: display(cells, "Unit"),
    pm: display(cells, "P.M. Responsavel"),
    sob_reference: display(cells, "Relatorio SOB referencia"),
    spool: display(cells, "Spool"),
    inspection_stage: display(cells, "Pré Solda ou Pós Solda"),
    requester: display(cells, "Requisitante"),
    request_date: raw(cells, "Data da Requisição"),
    status: display(cells, "STATUS"),
    report_date: raw(cells, "Data da Emissão Relatório"),
    need_date: raw(cells, "Data de Necessidade"),
    executor: display(cells, "EXECUTOR DO LAUDO"),
    hh: display(cells, "HH (00:00)"),
    approval: display(cells, "Laudo Aprovação"),
    repair_date: raw(cells, "DATA DE REPARO"),
    is_fcb: /\bFCB\b/i.test(identifiers),
  };
}

function deriveLogistics(cells: Map<string, any>) {
  return {
    project_key: raw(cells, "BSP") || display(cells, "BSP"),
    month: display(cells, "MÊS"),
    day: display(cells, "DIA"),
    movement_date: raw(cells, "DATA"),
    movement: display(cells, "MOV"),
    cost_center: display(cells, "CUSTOS"),
    client_supplier: display(cells, "CLIENTE/FORNEC"),
    pm: display(cells, "PM"),
    requester: display(cells, "SOLICITANTE"),
    reference: display(cells, "RM/DN/DI"),
    invoice: display(cells, "NF"),
    po: display(cells, "PO"),
    quality_release_date: raw(cells, "DATA LIB QUALIDADE"),
    quality_release_time: display(cells, "HORA - QUALIDADE"),
    fiscal_date: raw(cells, "DATA FISCAL"),
    fiscal_time: display(cells, "HORA FISCAL"),
    start_time: display(cells, "HORA INICIO"),
    end_time: display(cells, "HORA FINAL"),
    freight: display(cells, "FRETE"),
    driver: display(cells, "MOTORISTA"),
    plate: display(cells, "PLACA"),
    origin: display(cells, "ORIGEM"),
    destination: display(cells, "DESTINO"),
    freight_value: raw(cells, "VALOR FRETE"),
    amount_due: raw(cells, "VALOR DEVIDO"),
    cte: display(cells, "CT-E"),
    occurrence: display(cells, "OCORRENCIA"),
    observation: display(cells, "OBS"),
  };
}

function pctValue(cells: Map<string, any>, title: string): number | null {
  const value = (raw(cells, title) || display(cells, title)).trim();
  if (!value) return null;
  const normalized = value.replace("%", "").replace(",", ".").trim().toUpperCase();
  if (["N/A","NA","#N/A"].includes(normalized)) return 100;
  const number = Number(normalized);
  if (!Number.isFinite(number)) return null;
  if (value.includes("%")) return Math.max(0, Math.min(100, number));
  if (number >= 0 && number <= 1.0001) return Math.max(0, Math.min(100, number * 100));
  return Math.max(0, Math.min(100, number));
}

function truthySheet(value: string) {
  const normalized = value.trim().toLowerCase();
  return ["true","1","yes","sim","complete","completed","finished","project finished","finished and delivered"].includes(normalized);
}

function deriveTrackingArchive(source: Source, cells: Map<string, any>) {
  const projectKey = raw(cells, "Project") || display(cells, "Project");
  const drawing = display(cells, "Drawing");
  const item = display(cells, "Item");
  const projectType = display(cells, "Project Type");
  const statusText = [
    display(cells, "Status"),
    display(cells, "Spool Process Status"),
    display(cells, "Job Process Status"),
    display(cells, "Overall Project Status"),
    display(cells, "PROJECT STATUS"),
    display(cells, "FABRICATION STATUS"),
  ].filter(Boolean).join(" · ");

  const packagePct = pctValue(cells, "Package and Delivered");
  const finalInspectionPct = pctValue(cells, "Final Inspection");
  const overallPct = pctValue(cells, "% Individual Progress")
    ?? pctValue(cells, "% Complete - Advance")
    ?? pctValue(cells, "% Overall Progress")
    ?? 0;

  const finishedFlag = display(cells, "Project Finished?");
  const projectFinishDate = raw(cells, "Project Finish Date");
  const explicitFinishedStatus =
    /project finished|finished and delivered|projeto finalizado|projeto conclu[ií]do|finalizado|conclu[ií]do/i.test(statusText);

  // "Package and Delivered" é o nome de uma etapa do Tracking e NÃO significa,
  // sozinho, que o item/projeto foi entregue. A conclusão só é aceita quando
  // existe flag explícita, data final, status terminal inequívoco ou 100% real
  // na etapa de Package and Delivered.
  const isFinished =
    truthySheet(finishedFlag)
    || Boolean(projectFinishDate)
    || explicitFinishedStatus
    || packagePct === 100;

  const isHold = /\bon\s*hold\b|\bhold\b/i.test(statusText);

  const stageDefs = [
    ["Drawing Execution Advance%", "Engenharia", "Liberação de Engenharia"],
    ["Procuremnt Status %", "Suprimentos", "Procurement"],
    ["Material Separation", "Suprimentos", "Separação de Material"],
    ["Material Release to Fabrication", "Suprimentos", "Liberação para Fabricação"],
    ["Withdrew Material", "Caldeiraria", "Retirada de Material"],
    ["Welding Preparation", "Caldeiraria", "Preparação para Solda"],
    ["Spool Assemble and tack weld", "Caldeiraria", "Caldeiraria / Fit-up"],
    ["Full welding execution", "Solda", "Soldagem"],
    ["Initial Dimensional Inspection/3D", "Qualidade", "Inspeção Dimensional Inicial / 3D"],
    ["Final Dimensional Inpection/3D (QC)", "Qualidade", "Inspeção Dimensional Final / 3D"],
    ["Non Destructive Examination (QC)", "Qualidade", "END"],
    ["Hydro Test Pressure (QC)", "Qualidade", "Hydro Test"],
    ["HDG", "Pintura", "HDG"],
    ["FBE", "Pintura", "FBE"],
    ["HDG / FBE.  (PAINT)", "Pintura", "HDG / FBE"],
    ["Surface preparation and/or coating", "Pintura", "Pintura / Revestimento"],
    ["Final Inspection", "Qualidade", "Inspeção Final"],
    ["Package and Delivered", "Expedição", "Liberação / Expedição"],
  ] as const;

  let currentStage = "PCP";
  let currentStatus = "Planejamento / Sequenciamento";
  for (const [column, stage, label] of stageDefs) {
    const pct = pctValue(cells, column);
    if (pct == null) continue;
    if (pct < 100) {
      currentStage = stage;
      currentStatus = label;
      break;
    }
    currentStage = stage;
    currentStatus = label;
  }

  if (isHold) {
    currentStage = "On Hold";
    currentStatus = statusText || "On Hold";
  } else if (isFinished) {
    currentStage = "Enviado";
    currentStatus = "Projeto finalizado / arquivado";
  } else if (finalInspectionPct === 100 && packagePct !== 100) {
    currentStage = "Expedição";
    currentStatus = "Aguardando Expedição";
  }

  const genericDrawing = /^(ISO|DRAWING|LINE NUM|N\/A|NA)$/i.test(drawing.trim());
  const isDetail = Boolean(drawing && !genericDrawing);

  return {
    project_key: projectKey,
    item,
    client: display(cells, "Client"),
    vessel: display(cells, "Vessel"),
    start_date: raw(cells, "Start Date"),
    finish_date: raw(cells, "Finish Date"),
    project_type: projectType,
    drawing,
    line_number: display(cells, "Line Nº"),
    observations: display(cells, "OBSERVATIONS") || display(cells, "Observations"),
    pm: display(cells, "PM"),
    priority: display(cells, "Priority"),
    current_stage: currentStage,
    current_status: currentStatus,
    overall_progress: isFinished ? 100 : overallPct,
    project_finished: isFinished,
    status_text: statusText,
    project_finish_date: projectFinishDate,
    fabrication_start: raw(cells, "Fabrication Start Date"),
    weight_kg: raw(cells, "Kilos"),
    m2: raw(cells, "M2 Painting"),
    source_archive: String(source.config?.archive_label ?? source.sheet_name),
    archive_rank: Number(source.config?.archive_rank ?? 0),
    archived_source: Boolean(source.config?.archive ?? false),
    is_detail: isDetail,
  };
}

function deriveProductionPt(cells: Map<string, any>) {
  return {
    project_key: raw(cells, "Project") || display(cells, "Project"),
    started: display(cells, "Started"),
    vessel: display(cells, "Vessel"),
    start_date: raw(cells, "Start Date"),
    end_date: raw(cells, "End Date"),
    day_delay: raw(cells, "DAY DELAY"),
    status: display(cells, "Status"),
    duration: raw(cells, "Duration"),
    percent_complete: raw(cells, "% Complete"),
    pm: display(cells, "PM"),
    po_date: raw(cells, "PO Date"),
    baseline_start: raw(cells, "Início da referência"),
    baseline_end: raw(cells, "Fim da referência"),
    variance: raw(cells, "Variância"),
  };
}

function derive(source: Source, cells: Map<string, any>, cellDisplay: Record<string, string>) {
  let data: Record<string, unknown>;
  switch (source.source_key) {
    case "drawing":
      data = deriveDrawing(cells, cellDisplay);
      break;
    case "wip":
      data = deriveWip(cells);
      break;
    case "dimensional":
      data = deriveDimensional(cells, cellDisplay);
      break;
    case "logistics":
      data = deriveLogistics(cells);
      break;
    case "production_pt_2026":
      data = deriveProductionPt(cells);
      break;
    default:
      data = (source.source_key === "tracking" || source.source_key.startsWith("tracking_old_"))
        ? deriveTrackingArchive(source, cells)
        : {};
  }
  return {
    ...data,
    region: String(source.config?.region ?? "BR"),
  };
}

async function smartsheet(token: string, path: string) {
  const response = await fetch(API + path, {
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "smartsheet-integration-source": "APPLICATION,STEP Oil & Gas,Painel Operacional Remodelado",
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error("Smartsheet " + response.status + ": " + body.slice(0, 1200));
  return JSON.parse(body);
}

async function sheetVersion(token: string, sheetId: number): Promise<number> {
  const data = await smartsheet(token, "/sheets/" + sheetId + "/version");
  return Number(data.version ?? 0);
}

async function loadSheet(token: string, source: Source) {
  const pageSize = 500;
  let page = 1;
  let totalRowCount = 0;
  let columns: any[] = [];
  const rows: any[] = [];

  while (true) {
    const data = await smartsheet(
      token,
      "/sheets/" + source.sheet_id + "?pageSize=" + pageSize + "&page=" + page + "&include=objectValue"
    );
    if (!columns.length && Array.isArray(data.columns)) columns = data.columns;
    const batch = Array.isArray(data.rows) ? data.rows : [];
    rows.push(...batch);
    totalRowCount = Number(data.totalRowCount ?? rows.length);
    if (!batch.length || rows.length >= totalRowCount || batch.length < pageSize) break;
    page += 1;
    if (page > 100) throw new Error("Limite de paginação excedido para " + source.source_key);
  }

  const titleById = new Map<number, string>(columns.map((c: any) => [Number(c.id), String(c.title ?? "")]));

  const compact = rows.map((row: any, idx: number) => {
    const byTitle = new Map<string, any>();
    const cellDisplay: Record<string, string> = {};
    for (const cell of row.cells ?? []) {
      const title = titleById.get(Number(cell.columnId));
      if (!title) continue;
      const value = displayValue(cell).trim();
      const rawValue = textValue(cell).trim();
      if (!value && !rawValue) continue;
      byTitle.set(normalizeTitle(title), cell);
      cellDisplay[title] = value || rawValue;
    }

    const derived = derive(source, byTitle, cellDisplay);
    const revisions = source.source_key === "drawing" && Array.isArray((derived as any).revisions)
      ? (derived as any).revisions
      : [];

    return {
      rowId: Number(row.id),
      rowNumber: Number(row.rowNumber ?? idx + 1),
      parentId: row.parentId ? Number(row.parentId) : null,
      createdAt: row.createdAt ?? null,
      modifiedAt: row.modifiedAt ?? null,
      cells: cellDisplay,
      derived: Object.fromEntries(Object.entries(derived).filter(([k]) => k !== "revisions")),
      revisions,
    };
  });

  return {
    columns: columns.map((c: any) => ({
      id: Number(c.id),
      title: String(c.title ?? ""),
      type: String(c.type ?? ""),
      primary: Boolean(c.primary),
    })),
    rows: compact,
    totalRowCount,
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const token = Deno.env.get("SMARTSHEET_ACCESS_TOKEN");
  if (!url || !serviceKey || !token) return json({ ok: false, error: "Backend não configurado." }, 503);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const candidate = (request.headers.get("x-ops-sync-key") || "").trim();
  const { data: authorized, error: authError } = await admin.rpc("ops_panel_sync_auth", { p_candidate: candidate });
  if (authError || authorized !== true) return json({ ok: false, error: "Não autorizado." }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { body = {}; }
  const force = body.force === true;
  let requestedKeys = Array.isArray(body.sources) ? new Set(body.sources.map(String)) : null;

  const { data: migration } = await admin.rpc("ops_core_migration_status");
  const legacyProjects = Number((migration as any)?.projects?.legacy || 0);
  const nonTrackingSources = new Set(["wip", "drawing", "dimensional", "logistics", "production_pt_2026"]);

  if (legacyProjects === 0) {
    if (!requestedKeys) requestedKeys = nonTrackingSources;
    else {
      requestedKeys = new Set([...requestedKeys].filter((key) => !key.startsWith("tracking")));
    }
  }

  const { data: sourceData, error: sourceError } = await admin.rpc("ops_panel_sync_sources");
  if (sourceError) return json({ ok: false, error: sourceError.message }, 500);
  const sources = (Array.isArray(sourceData) ? sourceData : []) as Source[];
  const results: any[] = [];

  for (const source of sources) {
    if (requestedKeys && !requestedKeys.has(source.source_key)) continue;
    let version = 0;
    try {
      version = await sheetVersion(token, source.sheet_id);
      if (!force && source.last_synced_version != null && Number(source.last_synced_version) === version) {
        results.push({ source: source.source_key, status: "unchanged", version });
        continue;
      }

      const sheet = await loadSheet(token, source);
      const { data: runId, error: beginError } = await admin.rpc("ops_panel_begin_sync", {
        p_source_key: source.source_key,
        p_source_version: version,
        p_metadata: {
          sheet_id: source.sheet_id,
          sheet_name: source.sheet_name,
          columns: sheet.columns,
          total_row_count: sheet.totalRowCount,
        },
      });
      if (beginError || !runId) throw new Error(beginError?.message || "Falha ao iniciar sync.");

      const batchSize = 200;
      for (let i = 0; i < sheet.rows.length; i += batchSize) {
        const batch = sheet.rows.slice(i, i + batchSize);
        const { error: batchError } = await admin.rpc("ops_panel_ingest_batch", {
          p_run_id: runId,
          p_source_key: source.source_key,
          p_source_version: version,
          p_rows: batch,
        });
        if (batchError) throw new Error(batchError.message);
      }

      const { data: finish, error: finishError } = await admin.rpc("ops_panel_finish_sync", {
        p_run_id: runId,
        p_source_key: source.source_key,
        p_source_version: version,
        p_total_row_count: sheet.totalRowCount,
      });
      if (finishError) throw new Error(finishError.message);
      results.push({ source: source.source_key, status: "synced", ...finish });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await admin.rpc("ops_panel_mark_sync_error", {
        p_source_key: source.source_key,
        p_source_version: version || null,
        p_error: message,
      });
      results.push({ source: source.source_key, status: "error", version, error: message });
    }
  }

  let drawingDetection: unknown = null;
  if (results.some((row) => row.source === "drawing" && row.status !== "error")) {
    const { data: detected, error: detectionError } = await admin.rpc("ops_core_detect_new_drawing_projects");
    drawingDetection = detectionError
      ? { ok: false, error: detectionError.message }
      : detected;
  }

  let legacyReconciliation: unknown = null;
  if (results.some((row) => row.source === "tracking" && row.status !== "error")) {
    const { data: reconciled, error: reconciliationError } = await admin.rpc("ops_core_sync_legacy_tracking_current_items", {
      p_region: "BR",
    });
    legacyReconciliation = reconciliationError
      ? { ok: false, error: reconciliationError.message }
      : reconciled;
  }

  if (results.some((row) => row.source === "wip" || row.source === "drawing" || row.source === "tracking")) {
    await admin.rpc("ops_core_refresh_registration").catch(() => null);
  }

  let demandCache: unknown = null;
  if (results.some((row) => ["tracking", "wip", "drawing"].includes(String(row.source || "")) && row.status !== "error")) {
    const { data: cacheData, error: cacheError } = await admin.rpc("ops_core_refresh_demand_feed_cache");
    demandCache = cacheError ? { ok: false, error: cacheError.message } : cacheData;
  }

  return json({
    ok: results.every((r) => r.status !== "error"),
    results,
    drawing_detection: drawingDetection,
    legacy_reconciliation: legacyReconciliation,
    demand_cache: demandCache,
    migration_mode: legacyProjects > 0 ? "ops_core_hybrid" : "ops_core_only",
    legacy_projects: legacyProjects,
  });
});
