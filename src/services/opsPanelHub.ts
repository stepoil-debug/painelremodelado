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

const proxyUrl = (import.meta.env.VITE_OPS_PANEL_PROXY_URL as string | undefined)?.trim() || '';

export const hubConfigured = Boolean(proxyUrl);

async function requestHub<T>(payload: Record<string, unknown>): Promise<T> {
  if (!proxyUrl) throw new Error('Hub operacional não configurado neste ambiente.');

  const response = await fetch(proxyUrl, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; data?: unknown };
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || 'Não foi possível consultar o hub operacional.');
  }
  return data as T;
}

export async function loadHubHealth() {
  return requestHub<HubHealth>({ action: 'health' });
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
