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

export interface HubProjectDetail {
  project: HubProject | null;
  wip: unknown[];
  drawings: unknown[];
  drawing_revisions: unknown[];
  job_orders: unknown[];
  tracking_isos: unknown[];
  dimensional: unknown[];
  logistics: unknown[];
  production_pt: unknown[];
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

export interface HubProjectOverview {
  totalProjects: number;
  startedProjects: number;
  startedTags: number;
  notStartedProjects: number;
  notStartedTags: number;
  onHoldProjects: number;
  onHoldTags: number;
  productionProjects: number;
  productionTags: number;
  qualityProjects: number;
  qualityTags: number;
  paintingProjects: number;
  paintingTags: number;
  readyProjects: number;
  readyTags: number;
  sentProjects: number;
  programmedWeightKg: number;
  weldedWeightKg: number;
  sentWeightKg: number;
  pendingWeightKg: number;
  sourceUpdatedAt?: string | null;
  sourceVersion?: string | null;
}

export async function loadHubProjectOverview(): Promise<HubProjectOverview> {
  const response = await requestHub<{ ok: true; data: HubProjectOverview }>({
    action: 'overview',
  });
  return response.data;
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
