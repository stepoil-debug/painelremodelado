export interface HubSourceStatus {
  source_key: string;
  sheet_id: number | null;
  sheet_name: string;
  source_kind: 'smartsheet' | 'existing_cache';
  sync_enabled: boolean;
  current_version: number | null;
  last_synced_version: number | null;
  last_synced_at: string | null;
  last_status: string;
  row_count: number;
}

export interface HubProject {
  project_key: string;
  client?: string | null;
  vessel?: string | null;
  pm?: string | null;
  customer_po?: string | null;
  project_status?: string | null;
  wip_progress_text?: string | null;
  tracking_progress?: number | null;
  planned_start?: string | null;
  planned_finish?: string | null;
  replanned_finish?: string | null;
  acceptance_date?: string | null;
  contractual_date?: string | null;
  deadline_date?: string | null;
  drawing_approval_date?: string | null;
  drawing_count?: number | null;
  fcb_count?: number | null;
  approved_drawing_count?: number | null;
  released_drawing_count?: number | null;
  latest_drawing_revision?: string | null;
  po_numbers?: string | null;
  job_order_ids?: string | null;
  po_value?: number | null;
  billed_value?: number | null;
  contractual_balance?: number | null;
  billing_status?: string | null;
  dimensional_report_count?: number | null;
  dimensional_fcb_reference_count?: number | null;
  dimensional_open_count?: number | null;
  logistics_movement_count?: number | null;
  latest_logistics_movement_date?: string | null;
  pt_progress?: number | null;
  pt_status?: string | null;
  data_updated_at?: string | null;
}

export interface HubSnapshot {
  sources: HubSourceStatus[];
  projects: HubProject[];
}

export interface HubStepflowSummary {
  compras: number;
  diligenciamentos: number;
  rm_itens: number;
  materiais_alugados: number;
  compras_abertas: number;
  diligenciamentos_abertos: number;
  rm_pendentes: number;
}

export interface HubStepflowProject {
  project_key: string;
  summary: HubStepflowSummary;
  compras: unknown[];
  diligenciamentos: unknown[];
  rm_itens: unknown[];
  rm_status: unknown[];
  materiais_alugados: unknown[];
  versions: unknown[];
  generated_at?: string | null;
}

export interface HubProjectDetail {
  project: HubProject | null;
  core?: HubCoreProjectDetail | null;
  wip: unknown[];
  drawings: unknown[];
  drawing_revisions: unknown[];
  job_orders: unknown[];
  tracking_isos: unknown[];
  dimensional: unknown[];
  logistics: unknown[];
  production_pt: unknown[];
  stepflow?: HubStepflowProject | null;
  stepflow_error?: string | null;
}

export interface HubHealth {
  ok: boolean;
  sources: HubSourceStatus[];
  projectCount: number;
  generatedAt: string;
}

import { getPanelToken } from './panelAuth';

const envProxy = (import.meta.env.VITE_OPS_PANEL_PROXY_URL as string | undefined)?.trim() || '';
const directEdgeApi = 'https://qxmxtbjxkhecqilpnhgq.supabase.co/functions/v1/ops-panel-api';
const demoOnly = import.meta.env.VITE_OPS_PANEL_DEMO === 'true';
const proxyUrl = demoOnly ? '' : (envProxy || directEdgeApi);

export const hubConfigured = Boolean(proxyUrl);

async function requestHub<T>(payload: Record<string, unknown>): Promise<T> {
  if (!proxyUrl) throw new Error('Hub operacional não configurado neste ambiente.');

  const response = await fetch(proxyUrl, {
    method: 'POST',
    credentials: proxyUrl === directEdgeApi ? 'omit' : 'include',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(getPanelToken() ? { Authorization: 'Bearer ' + getPanelToken() } : {}),
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; data?: unknown };
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || 'Não foi possível consultar o hub operacional.');
  }
  return data as T;
}

async function requestHubBlob(payload: Record<string, unknown>): Promise<Blob> {
  if (!proxyUrl) throw new Error('Hub operacional não configurado neste ambiente.');

  const response = await fetch(proxyUrl, {
    method: 'POST',
    credentials: proxyUrl === directEdgeApi ? 'omit' : 'include',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(getPanelToken() ? { Authorization: 'Bearer ' + getPanelToken() } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error || 'Não foi possível carregar o PDF.');
    }
    throw new Error('Não foi possível carregar o PDF.');
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/pdf')) {
    throw new Error('O arquivo recebido não é um PDF válido.');
  }

  return response.blob();
}

export async function loadHubHealth() {
  return requestHub<HubHealth>({ action: 'health' });
}

export interface HubSyncSourceStatus {
  source_key: string;
  sheet_name: string;
  last_status: string;
  last_synced_at?: string | null;
  current_version?: number | null;
  last_synced_version?: number | null;
  row_count?: number | null;
}

export interface HubSyncStatus {
  last_synced_at?: string | null;
  sources: HubSyncSourceStatus[];
}

export async function loadHubSyncStatus(): Promise<HubSyncStatus> {
  const response = await requestHub<{ ok: true; data: HubSyncStatus }>({
    action: 'sync_status',
  });
  return response.data;
}

export async function triggerDrawingSync(): Promise<{
  request_id: number;
  source: string;
  forced: boolean;
  started_at: string;
  previous_version?: number | null;
  previous_synced_at?: string | null;
}> {
  const response = await requestHub<{
    ok: true;
    data: {
      request_id: number;
      source: string;
      forced: boolean;
      started_at: string;
      previous_version?: number | null;
      previous_synced_at?: string | null;
    };
  }>({
    action: 'drawing_sync_now',
  });
  return response.data;
}

export async function triggerHubSync(): Promise<{ request_id: number; started_at: string; mode: string }> {
  const response = await requestHub<{ ok: true; data: { request_id: number; started_at: string; mode: string } }>({
    action: 'sync_now',
  });
  return response.data;
}

export async function loadHubSnapshot(): Promise<HubSnapshot> {
  const response = await requestHub<{ ok: true; data: HubSnapshot }>({ action: 'snapshot' });
  return response.data;
}

export async function loadHubProject(projectKey: string): Promise<HubProjectDetail> {
  const response = await requestHub<{ ok: true; data: HubProjectDetail }>({
    action: 'project',
    projectKey,
  });
  return response.data;
}


export interface HubDemandRow {
  region: string;
  iso_key: string;
  project_row_id: string;
  project_number: string;
  iso: string;
  drawing?: string | null;
  line_number?: string | null;
  description?: string | null;
  client_tag?: string | null;
  project_type?: string | null;
  current_stage?: string | null;
  current_status?: string | null;
  planned_start?: string | null;
  planned_finish?: string | null;
  fabrication_start?: string | null;
  overall_progress?: number | null;
  weight_kg?: number | null;
  m2?: number | null;
  source_version?: string | null;
  source_updated_at?: string | null;
  synced_at?: string | null;
  project_display?: string | null;
  client?: string | null;
  vessel?: string | null;
  pm?: string | null;
  project_status?: string | null;
  replanned_finish?: string | null;
  archived?: boolean | null;
  archive_source?: string | null;
  archive_rank?: number | null;
  source_mode?: 'legacy_tracking' | 'ops_core' | 'archived' | 'pending_validation' | null;
  core_project_id?: string | null;
  core_item_id?: string | null;
  hh_session_id?: string | null;
  hh_status?: string | null;
  hh_activity_key?: string | null;
  hh_activity_name?: string | null;
  hh_progress_percent?: number | null;
  hh_progress_status?: string | null;
  hh_progress_stage_key?: string | null;
  hh_progress_sector?: string | null;
  hh_work_state?: string | null;
  hh_start_at?: string | null;
  hh_end_at?: string | null;
  hh_finish_status?: string | null;
  hh_total_workers?: number | null;
  hh_total_hh?: number | null;
  hh_created_by_name?: string | null;
  hh_finished_by_name?: string | null;
  hh_progress_updated_by_name?: string | null;
  hh_execution_updated_at?: string | null;
  hh_tracking_stage_key?: string | null;
  hh_tracking_stage_name?: string | null;
  hh_tracking_stage_order?: number | null;
  hh_source_progress_column?: string | null;
  hh_source_actual_column?: string | null;
}

export async function loadHubDemands(region = 'BR', limit = 2000, search = ''): Promise<HubDemandRow[]> {
  const response = await requestHub<{ ok: true; data: HubDemandRow[] }>({
    action: 'demands',
    region,
    limit,
    search,
  });
  return Array.isArray(response.data) ? response.data : [];
}


export interface HubCoreMigrationStatus {
  projects: {
    total: number;
    cutover: number;
    legacy: number;
    validation_required: number;
  };
  items: {
    total: number;
    cutover: number;
    legacy: number;
    removed: number;
  };
  candidates: {
    total: number;
    pending: number;
    validated: number;
  };
  generated_at?: string;
}

export interface HubRegistrationCandidate {
  id: string;
  region: string;
  project_core: string;
  display_code: string;
  candidate_status: 'discovered' | 'collecting' | 'parsed' | 'reconciled' | 'validation_required' | 'validated' | 'rejected';
  source_systems: string[];
  suggested_data: Record<string, unknown>;
  conflicts: unknown[];
  discovered_at: string;
  last_seen_at: string;
  validated_project_id?: string | null;
  source_mode?: 'legacy_tracking' | 'ops_core' | 'archived' | 'pending_validation' | null;
  validation_status?: string | null;
  client?: string | null;
  vessel?: string | null;
  pm?: string | null;
  project_status?: string | null;
  item_count?: number | null;
  document_count?: number | null;
}

export interface HubCoreValidationReport {
  project: Record<string, unknown> | null;
  fcb?: {
    project_core?: string | null;
    fcb_count: number;
    has_fcb: boolean;
    status: 'awaiting_fcb' | 'detected';
    latest_revision?: string | null;
    latest_source_row_id?: number | string | null;
    documents?: Array<Record<string, unknown>>;
  };
  items: {
    item_count: number;
    missing_weight: number;
    missing_material: number;
    unclassified_items: number;
    provisional_breakdown?: number;
    items_without_workflow: number;
  };
  documents: {
    document_count: number;
    missing_revision: number;
    source_linked: number;
  };
  blocking_issues: string[];
  warnings: Record<string, number>;
  ready_for_cutover: boolean;
  generated_at?: string;
}

export interface HubCoreProjectDetail {
  project: Record<string, unknown> | null;
  aliases: unknown[];
  items: unknown[];
  stages: unknown[];
  documents: unknown[];
  handoffs: unknown[];
  notifications: unknown[];
}

export async function loadCoreMigrationStatus(): Promise<HubCoreMigrationStatus> {
  const response = await requestHub<{ ok: true; data: HubCoreMigrationStatus }>({
    action: 'migration_status',
  });
  return response.data;
}

export async function loadRegistrationCandidates(
  status: HubRegistrationCandidate['candidate_status'] | '' = 'validation_required',
  limit = 250,
): Promise<HubRegistrationCandidate[]> {
  const response = await requestHub<{ ok: true; data: HubRegistrationCandidate[] }>({
    action: 'registration_candidates',
    status,
    limit,
  });
  return Array.isArray(response.data) ? response.data : [];
}

export interface HubCoreRegistrationDetail {
  project: Record<string, unknown> | null;
  items: Array<Record<string, unknown>>;
}

export async function loadCoreRegistrationDetail(projectKey: string): Promise<HubCoreRegistrationDetail> {
  const response = await requestHub<{ ok: true; data: HubCoreRegistrationDetail }>({
    action: 'core_registration_detail',
    projectKey,
  });
  return response.data;
}

export async function loadCoreValidationReport(projectKey: string): Promise<HubCoreValidationReport> {
  const response = await requestHub<{ ok: true; data: HubCoreValidationReport }>({
    action: 'validation_report',
    projectKey,
  });
  return response.data;
}

export async function cutoverCoreProject(projectKey: string) {
  const response = await requestHub<{ ok: true; data: Record<string, unknown>; report: HubCoreValidationReport; message?: string }>({
    action: 'core_cutover',
    projectKey,
  });
  return response;
}

export async function revertCoreProject(projectKey: string) {
  const response = await requestHub<{ ok: true; data: Record<string, unknown> }>({
    action: 'core_revert',
    projectKey,
  });
  return response.data;
}

export async function refreshCoreRegistration() {
  const response = await requestHub<{ ok: true; data: Record<string, unknown> }>({
    action: 'core_refresh_registration',
  });
  return response.data;
}


export async function materializeCoreCandidate(projectKey: string) {
  const response = await requestHub<{
    ok: true;
    data: Record<string, unknown>;
    report?: HubCoreValidationReport;
  }>({
    action: 'core_materialize_candidate',
    projectKey,
  });
  return response;
}

export interface HubAutoRegisterResult {
  ok: boolean;
  registered: boolean;
  activated: boolean;
  ready_for_activation?: boolean;
  observation_mode?: boolean;
  pending_detail?: boolean;
  awaiting_fcb?: boolean;
  fcb_detected?: boolean;
  fcb?: Record<string, unknown>;
  materialized?: Record<string, unknown>;
  report?: HubCoreValidationReport;
  cutover?: Record<string, unknown>;
}

export async function autoRegisterCoreCandidate(projectKey: string): Promise<HubAutoRegisterResult> {
  const response = await requestHub<{ ok: true; data: HubAutoRegisterResult }>({
    action: 'core_register_candidate_auto',
    projectKey,
  });
  return response.data;
}

export interface HubCoreItemInput {
  id?: string | null;
  item_key?: string | null;
  iso_code?: string | null;
  spool_code?: string | null;
  drawing_code?: string | null;
  item_type?: 'SPOOL' | 'SUPPORT' | 'STRUCTURE' | 'FRAME' | 'OTHER';
  description?: string | null;
  line_number?: string | null;
  material?: string | null;
  size?: string | null;
  schedule?: string | null;
  weight_kg?: number | null;
  painting_m2?: number | null;
  quantity?: number | null;
  joints?: number | null;
  requires_3d?: boolean | null;
  requires_assembly_simulation?: boolean | null;
}

export async function upsertCoreItem(projectKey: string, item: HubCoreItemInput) {
  const response = await requestHub<{
    ok: true;
    data: { ok: true; item: Record<string, unknown> };
    report?: HubCoreValidationReport;
  }>({
    action: 'core_upsert_item',
    projectKey,
    item,
  });
  return response;
}




export interface HubArchiveDetail {
  ok: true;
  origin: 'LEGACY_TRACKING' | 'OPS_CORE';
  project: Record<string, unknown>;
  metrics: {
    item_count: number;
    total_weight_kg: number;
    total_m2: number;
    project_start_date?: string | null;
    actual_start_date?: string | null;
    fabrication_start_date?: string | null;
    completed_on?: string | null;
    lead_time_days?: number | null;
    fabrication_calendar_days?: number | null;
    hold_days?: number | null;
    effective_fabrication_days?: number | null;
    avg_item_fabrication_days?: number | null;
    weight_per_calendar_day?: number | null;
    weight_per_effective_day?: number | null;
    items_per_effective_day?: number | null;
    total_hh?: number | null;
    kg_per_hh?: number | null;
    data_completeness?: Record<string, boolean>;
  };
  items: Array<Record<string, unknown>>;
  hold_periods: Array<Record<string, unknown>>;
  stage_metrics: Array<Record<string, unknown>>;
  hh_summary: Array<Record<string, unknown>>;
  documents: Array<Record<string, unknown>>;
}

export async function loadArchivedProjectDetail(projectCore: string): Promise<HubArchiveDetail> {
  const response = await requestHub<{ ok: true; data: HubArchiveDetail }>({
    action: 'archive_detail',
    projectCore,
  });
  return response.data;
}

export interface HubArchivedProject {
  origin: 'LEGACY_TRACKING' | 'OPS_CORE';
  project_id?: string | null;
  project_core: string;
  project_display?: string | null;
  client?: string | null;
  vessel?: string | null;
  pm?: string | null;
  project_type?: string | null;
  completed_on?: string | null;
  reporting_year?: number | null;
  item_count: number;
  total_weight_kg: number;
  total_m2: number;
  archive_source?: string | null;
  hold_days: number;
  metric_quality_issues?: number;
}

export interface HubAnnualSummary {
  reporting_year: number;
  projects: number;
  clients: number;
  items: number;
  total_weight_kg: number;
  total_m2: number;
  hold_days: number;
  metric_quality_issues?: number;
}

export interface HubHistoryHealth {
  legacy_history_rows: number;
  legacy_archive_rows: number;
  legacy_current_rows: number;
  on_hold_periods: number;
  invalid_date_rows: number;
  metric_quality_rows: number;
  archived_projects: number;
  years: number[];
}

export async function loadArchivedProjects(year?: number | null, search = '', limit = 1000): Promise<HubArchivedProject[]> {
  const response = await requestHub<{ ok: true; data: HubArchivedProject[] }>({
    action: 'archive_catalog',
    year: year ?? null,
    search,
    limit,
  });
  return Array.isArray(response.data) ? response.data : [];
}

export async function loadAnnualSummary(): Promise<HubAnnualSummary[]> {
  const response = await requestHub<{ ok: true; data: HubAnnualSummary[] }>({
    action: 'annual_summary',
  });
  return Array.isArray(response.data) ? response.data : [];
}

export async function loadHistoryHealth(): Promise<HubHistoryHealth> {
  const response = await requestHub<{ ok: true; data: HubHistoryHealth }>({
    action: 'history_health',
  });
  return response.data;
}

export type CoreDemandAction = 'accept' | 'start' | 'progress' | 'wait' | 'resume' | 'block' | 'complete';

export async function mutateCoreDemand(
  itemId: string,
  operation: CoreDemandAction,
  options: { progress?: number | null; note?: string } = {},
) {
  const response = await requestHub<{ ok: true; data: Record<string, unknown> }>({
    action: 'core_stage_action',
    itemId,
    operation,
    progress: options.progress ?? null,
    note: options.note || '',
  });
  return response.data;
}

export interface HubNewBspAlert {
  id: string;
  notification_type: string;
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'danger' | 'success';
  created_at: string;
  read_at?: string | null;
  project_core: string;
  display_code: string;
  source_systems?: string[];
  suggested_data?: Record<string, unknown>;
}

export async function loadNewBspAlerts(limit = 10): Promise<HubNewBspAlert[]> {
  const response = await requestHub<{ ok: true; data: HubNewBspAlert[] }>({
    action: 'new_bsp_alerts',
    limit,
  });
  return Array.isArray(response.data) ? response.data : [];
}

export interface HubCoreNotification {
  id: string;
  project_id?: string | null;
  item_id?: string | null;
  handoff_id?: string | null;
  sector_key?: string | null;
  recipient_email?: string | null;
  notification_type: string;
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'danger' | 'success';
  created_at: string;
  read_at?: string | null;
  acknowledged_at?: string | null;
  resolved_at?: string | null;
  project_display?: string | null;
  item_display?: string | null;
}

export async function loadCoreNotifications(sector = '', user = '', limit = 200): Promise<HubCoreNotification[]> {
  const response = await requestHub<{ ok: true; data: HubCoreNotification[] }>({
    action: 'core_notifications',
    sector,
    user,
    limit,
  });
  return Array.isArray(response.data) ? response.data : [];
}

export async function markCoreNotificationRead(notificationId: string) {
  const response = await requestHub<{ ok: true; data: Record<string, unknown> }>({
    action: 'core_notification_read',
    notificationId,
  });
  return response.data;
}

export async function removeCoreItem(projectKey: string, itemId: string, reason = '') {
  const response = await requestHub<{ ok: true; data: Record<string, unknown> }>({
    action: 'core_remove_item',
    projectKey,
    itemId,
    reason,
  });
  return response.data;
}


export interface HubHHWorker {
  id: string;
  session_id: string;
  worker_name: string;
  worker_registration?: string | null;
  worker_role?: string | null;
  participation_type?: string | null;
  joined_at?: string | null;
  left_at?: string | null;
  hh_minutes?: number | null;
  hh_value?: number | null;
}

export interface HubHHSession {
  id: string;
  status: string;
  bsp_number: string;
  iso: string;
  activity_key?: string | null;
  activity_name?: string | null;
  start_at?: string | null;
  end_at?: string | null;
  elapsed_minutes?: number | null;
  total_hh?: number | null;
  finish_status?: string | null;
  created_by_name?: string | null;
  finished_by_name?: string | null;
  created_at?: string | null;
  workers: HubHHWorker[];
}

export interface HubHHEvidencePhoto {
  id: string;
  session_id: string;
  photo_type: 'start' | 'finish' | 'extra' | string;
  caption?: string | null;
  taken_at?: string | null;
  visible_to_client?: boolean | null;
  content_type?: string | null;
  file_size_bytes?: number | null;
  metadata?: Record<string, unknown> | null;
  uploaded_by_name?: string | null;
  signed_url: string;
}

export interface HubHHEvidence {
  bsp: string;
  iso: string;
  sessions: HubHHSession[];
  photos: HubHHEvidencePhoto[];
  generatedAt?: string;
}

export async function loadHubEvidence(bsp: string, iso: string): Promise<HubHHEvidence> {
  const response = await requestHub<{ ok: true; data: HubHHEvidence }>({
    action: 'evidence',
    bsp,
    iso,
  });
  return response.data;
}


export interface HubDrawingAttachment {
  id: number;
  parent_id: number;
  name: string;
  mime_type?: string | null;
  size_kb?: number | null;
  created_at?: string | null;
  created_by?: { email?: string | null; name?: string | null } | null;
  revision?: string | null;
}

export interface HubDrawingAttachmentRow {
  source_row_id: number;
  project_key: string;
  drawing_number?: string | null;
  document_title?: string | null;
  current_revision?: string | null;
  current_status?: string | null;
  is_fcb?: boolean | null;
  attachments: HubDrawingAttachment[];
}

export interface HubDrawingAttachments {
  project_key: string;
  sheet_id: number;
  rows: HubDrawingAttachmentRow[];
  attachment_count: number;
}

export async function loadHubDrawingAttachments(projectKey: string, iso = ''): Promise<HubDrawingAttachments> {
  const response = await requestHub<{ ok: true; data: HubDrawingAttachments }>({
    action: 'drawing_attachments',
    projectKey,
    iso,
  });
  return response.data;
}

export async function loadHubDrawingAttachmentPdf(
  projectKey: string,
  attachmentId: number,
): Promise<Blob> {
  return requestHubBlob({
    action: 'drawing_attachment_pdf',
    projectKey,
    attachmentId,
  });
}

export async function loadHubDrawingAttachmentUrl(
  projectKey: string,
  attachmentId: number,
): Promise<{
  id: number;
  parent_id: number;
  name: string;
  mime_type?: string | null;
  size_kb?: number | null;
  created_at?: string | null;
  created_by?: { email?: string | null; name?: string | null } | null;
  url: string;
  url_expires_in_millis?: number | null;
}> {
  const response = await requestHub<{ ok: true; data: any }>({
    action: 'drawing_attachment_url',
    projectKey,
    attachmentId,
  });
  return response.data;
}
