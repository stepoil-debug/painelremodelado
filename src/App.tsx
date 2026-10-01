import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  Bell,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Eye,
  EyeOff,
  FileText,
  FileSpreadsheet,
  Filter,
  ImagePlus,
  LayoutGrid,
  List,
  LockKeyhole,
  LogOut,
  PauseCircle,
  PlayCircle,
  RefreshCcw,
  Search,
  ShieldCheck,
  UserCheck,
  Users,
  XCircle,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import ArchivePage from './ArchivePage';
import CoreMigrationPage from './CoreMigrationPage';
import { liveHHReadOnlyEnabled, loadHHSessionsReadOnly } from './services/hhReadOnly';
import {
  hubConfigured,
  loadHubDemands,
  loadHubDrawingAttachments,
  loadHubDrawingAttachmentPdf,
  applyHubDrawingRevision,
  loadHubEvidence,
  loadStageEvidence,
  loadHubProject,
  loadHubSyncStatus,
  loadGoalfyShipping,
  loadGoalfySyncStatus,
  loadGoalfyConnectionStatus,
  loadNewBspAlerts,
  loadCoreNotifications,
  markCoreNotificationRead,
  mutateCoreDemand,
  mutateLegacyDemand,
  uploadStageEvidence,
  triggerHubSync,
  triggerGoalfySync,
  saveGoalfyCredentials,
  type HubDrawingAttachment,
  type HubDrawingAttachments,
  type HubHHEvidence,
  type HubStageEvidence,
  type HubGoalfyShipping,
  type HubGoalfyConnectionStatus,
  type HubNewBspAlert,
  type HubHHEvidencePhoto,
  type HubHHSession,
} from './services/opsPanelHub';
import { hubRowsToOperationalState } from './services/hubDemandAdapter';
import {
  clearPanelSession,
  getRememberedPanelLogin,
  loginPanel,
  logoutPanel,
  restorePanelSession,
  type PanelUser,
} from './services/panelAuth';
import { loadOperationalState, resetOperationalState, saveOperationalState, uid } from './store';
import type {
  Demand,
  DemandStatus,
  EvidenceType,
  NotificationItem,
  OperationalState,
  Priority,
  SectorKey,
} from './types';
import {
  getNextStage,
  getStage,
  getStageIndex,
  photoPolicyLabel,
  sectorName,
  sectors,
  workflowStages,
} from './workflow';

type PageKey = 'portfolio' | 'live' | 'blocks' | 'notifications' | 'analytics' | 'archive' | 'migration';
type ListMode = 'table' | 'board';
type PortfolioStatusFilter = 'all' | DemandStatus | 'on_hold';
type SectorFilter = 'all' | SectorKey;

const statusLabel: Record<DemandStatus, string> = {
  new: 'Nova',
  in_progress: 'Em execução',
  waiting: 'Aguardando',
  blocked: 'Bloqueada',
  late: 'Atrasada',
  completed: 'Concluída',
};

const priorityLabel: Record<Priority, string> = {
  critical: 'Crítica',
  high: 'Alta',
  normal: 'Normal',
  low: 'Baixa',
};

const priorityWeight: Record<Priority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

function effectiveStatus(demand: Demand): DemandStatus {
  if (['completed', 'blocked', 'waiting'].includes(demand.status)) return demand.status;
  if (demand.status === 'late') return 'late';
  if (demand.slaDueAt && Date.now() > new Date(demand.slaDueAt).getTime()) return 'late';
  return demand.status;
}

function fmtDate(date?: string) {
  if (!date) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
}

function fmtNumber(value: number | string | null | undefined, digits = 2) {
  if (value == null || value === '') return '—';
  const number = Number(value);
  return Number.isFinite(number)
    ? number.toLocaleString('pt-BR', { maximumFractionDigits: digits })
    : '—';
}

function downloadPortfolioExcel(demands: Demand[]) {
  const rows = demands.map((demand) => ({
    BSP: demand.bsp,
    'ISO / SPL': demand.iso,
    Projeto: demand.project,
    Cliente: demand.client,
    'Etapa atual': demand.stage,
    Setor: sectorName(demand.sector),
    'Avanço (%)': demand.progress,
    Status: statusLabel[effectiveStatus(demand)],
    Prioridade: priorityLabel[demand.priority],
    'Peso (kg)': demand.weightKg ?? null,
    'Área (m²)': demand.m2 ?? null,
  }));

  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet['!cols'] = [
    { wch: 18 }, { wch: 30 }, { wch: 22 }, { wch: 20 }, { wch: 28 },
    { wch: 16 }, { wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 14 }, { wch: 14 },
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Carteira');
  const date = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(workbook, 'carteira-filtrada-' + date + '.xlsx');
}

function sectorKeyFromValue(value?: string | null): SectorKey {
  const normalized = (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  if (normalized.includes('engenharia')) return 'engenharia';
  if (normalized.includes('supr')) return 'suprimentos';
  if (normalized.includes('caldeir')) return 'caldeiraria';
  if (normalized.includes('solda')) return 'solda';
  if (normalized.includes('qualidade') || normalized.includes('inspec')) return 'qualidade';
  if (normalized.includes('pint')) return 'pintura';
  if (normalized.includes('log') || normalized.includes('exped')) return 'expedicao';
  if (normalized.includes('hold')) return 'on_hold';
  return 'nao_classificado';
}

function createNotification(
  sector: SectorKey,
  demand: Demand,
  title: string,
  message: string,
  severity: NotificationItem['severity'],
): NotificationItem {
  return {
    id: uid('ntf'),
    title,
    message,
    sector,
    demandId: demand.id,
    createdAt: new Date().toISOString(),
    read: false,
    severity,
  };
}

export default function App() {
  const [state, setState] = useState<OperationalState>(() => hubConfigured ? { version: 4, demands: [], notifications: [] } : loadOperationalState());
  const [page, setPage] = useState<PageKey>('portfolio');
  const [sector, setSector] = useState<SectorFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [mode, setMode] = useState<ListMode>('table');
  const [search, setSearch] = useState('');
  const [stageFilters, setStageFilters] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<PortfolioStatusFilter>('all');
  const [priorityOnly, setPriorityOnly] = useState(false);
  const [lateOnly, setLateOnly] = useState(false);
  const [loadingHH, setLoadingHH] = useState(!hubConfigured && liveHHReadOnlyEnabled);
  const [loadingHub, setLoadingHub] = useState(false);
  const [manualSyncing, setManualSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [hubError, setHubError] = useState<string | null>(null);
  const [panelUser, setPanelUser] = useState<PanelUser | null>(null);
  const [authLoading, setAuthLoading] = useState(hubConfigured);
  const [authError, setAuthError] = useState('');
  const [projectDetail, setProjectDetail] = useState<Awaited<ReturnType<typeof loadHubProject>> | null>(null);
  const [hhEvidence, setHhEvidence] = useState<HubHHEvidence | null>(null);
  const [stageEvidence, setStageEvidence] = useState<HubStageEvidence | null>(null);
  const [goalfyShipping, setGoalfyShipping] = useState<HubGoalfyShipping | null>(null);
  const [goalfyConnection, setGoalfyConnection] = useState<HubGoalfyConnectionStatus | null>(null);
  const [goalfyLoading, setGoalfyLoading] = useState(false);
  const [goalfySyncing, setGoalfySyncing] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [newBspPopup, setNewBspPopup] = useState<HubNewBspAlert | null>(null);
  const [clock, setClock] = useState(new Date());

  const demands = state.demands;
  const selected = selectedId ? demands.find((d) => d.id === selectedId) ?? null : null;

  useEffect(() => {
    if (!hubConfigured) saveOperationalState(state);
  }, [state]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!banner) return;
    const timer = window.setTimeout(() => setBanner(null), 3800);
    return () => window.clearTimeout(timer);
  }, [banner]);

  useEffect(() => {
    if (!hubConfigured) {
      setAuthLoading(false);
      return;
    }

    let active = true;
    restorePanelSession()
      .then((user) => {
        if (active) setPanelUser(user);
      })
      .finally(() => {
        if (active) setAuthLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!panelUser) return;
    const normalized = panelUser.sector
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    if (normalized === 'all' || normalized.includes('todos')) setSector('all');
    else if (normalized.includes('qualidade')) setSector('qualidade');
    else if (normalized.includes('solda')) setSector('solda');
    else if (normalized.includes('caldeir')) setSector('caldeiraria');
    else if (normalized.includes('engenharia')) setSector('engenharia');
    else if (normalized.includes('supr')) setSector('suprimentos');
    else if (normalized.includes('pint')) setSector('pintura');
    else if (normalized.includes('log') || normalized.includes('exped')) setSector('expedicao');
  }, [panelUser]);

  async function refreshHub(showBanner = false, searchQuery = '', preserveSelection = false) {
    if (!hubConfigured || !panelUser) return;
    setLoadingHub(true);
    setHubError(null);
    try {
      const region = panelUser.operationRegion || 'BR';
      const query = searchQuery.trim();
      const [rows, coreNotifications] = await Promise.all([
        loadHubDemands(region, query ? 1200 : 3000, query),
        loadCoreNotifications(panelUser.sector || '', panelUser.email || panelUser.username || '', 300).catch(() => []),
      ]);
      const nextState = hubRowsToOperationalState(rows);
      nextState.notifications = coreNotifications.map((notification) => {
        const demand = nextState.demands.find((item) => item.coreItemId === notification.item_id);
        return {
          id: notification.id,
          title: notification.title,
          message: notification.message,
          sector: sectorKeyFromValue(notification.sector_key),
          demandId: demand?.id,
          createdAt: notification.created_at,
          read: Boolean(notification.read_at),
          severity: notification.severity || 'info',
        };
      });
      setState(nextState);
      if (!preserveSelection) {
        setSelectedId(null);
        setExpandedId(null);
      }
      if (showBanner) setBanner(
        rows.length + (searchQuery.trim() ? ' item(ns) encontrados no banco operacional.' : ' itens reais carregados do OPS CORE + legado em transição.')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao carregar dados reais.';
      setHubError(message);
      if (/sessão inválida|não autorizado/i.test(message)) {
        clearPanelSession();
        setPanelUser(null);
        setAuthError('Sua sessão expirou. Entre novamente.');
      }
      if (showBanner) setBanner(message);
    } finally {
      setLoadingHub(false);
    }
  }

  async function refreshProjectDetail() {
    if (!selected || !['hub_readonly', 'ops_core'].includes(selected.source)) return;
    setDetailLoading(true);
    try {
      setProjectDetail(await loadHubProject(selected.bsp));
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    if (!hubConfigured || !panelUser) return;
    void loadHubSyncStatus()
      .then((status) => setLastSyncAt(status.last_synced_at || null))
      .catch(() => undefined);
  }, [panelUser]);

  useEffect(() => {
    if (!hubConfigured || !panelUser) return;

    let active = true;
    const checkNewBsp = async () => {
      try {
        const alerts = await loadNewBspAlerts(5);
        if (!active || !alerts.length) return;
        setNewBspPopup((current) => current || alerts[0]);
      } catch {
        // Popup é complementar; falha aqui não bloqueia a carteira.
      }
    };

    void checkNewBsp();
    const timer = window.setInterval(() => void checkNewBsp(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [panelUser]);

  async function closeNewBspPopup(openRegistration = false) {
    const alert = newBspPopup;
    if (!alert) return;
    setNewBspPopup(null);
    try {
      await markCoreNotificationRead(alert.id);
    } catch {
      // Não impede a navegação.
    }
    if (openRegistration) {
      setSelectedId(null);
      setExpandedId(null);
      setPage('migration');
    }
  }

  useEffect(() => {
    if (!hubConfigured || !panelUser) return;

    const timer = window.setTimeout(() => {
      void refreshHub(false, search);
    }, 350);

    return () => window.clearTimeout(timer);
  }, [search, panelUser]);

  useEffect(() => {
    if (!hubConfigured || !panelUser || !selected || !['hub_readonly', 'ops_core'].includes(selected.source)) {
      setProjectDetail(null);
      setHhEvidence(null);
      setStageEvidence(null);
      setGoalfyShipping(null);
      setGoalfyConnection(null);
      setGoalfyLoading(false);
      setDetailLoading(false);
      setEvidenceLoading(false);
      return;
    }

    let active = true;
    setDetailLoading(true);
    setEvidenceLoading(true);
    setGoalfyLoading(true);

    loadHubProject(selected.bsp)
      .then((detail) => {
        if (active) setProjectDetail(detail);
      })
      .catch(() => {
        if (active) setProjectDetail(null);
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });

    loadHubEvidence(selected.bsp, selected.iso)
      .then((evidence) => {
        if (active) setHhEvidence(evidence);
      })
      .catch(() => {
        if (active) setHhEvidence(null);
      })
      .finally(() => {
        if (active) setEvidenceLoading(false);
      });

    if (selected.source === 'ops_core' && selected.coreItemId) {
      loadStageEvidence(selected.coreItemId)
        .then((evidence) => {
          if (active) setStageEvidence(evidence);
        })
        .catch(() => {
          if (active) setStageEvidence(null);
        });
    } else {
      setStageEvidence(null);
    }

    Promise.all([
      loadGoalfyShipping(selected.bsp),
      loadGoalfyConnectionStatus().catch(() => null),
    ])
      .then(([shipping, connection]) => {
        if (!active) return;
        setGoalfyShipping(shipping);
        setGoalfyConnection(connection);
      })
      .catch(() => {
        if (!active) return;
        setGoalfyShipping(null);
      })
      .finally(() => {
        if (active) setGoalfyLoading(false);
      });

    return () => {
      active = false;
    };
  }, [panelUser, selectedId]);

  useEffect(() => {
    if (hubConfigured || !liveHHReadOnlyEnabled) return;
    loadHHSessionsReadOnly()
      .then((live) => {
        if (!live.length) return;
        setState((current) => ({
          ...current,
          demands: [...live, ...current.demands.filter((d) => d.source !== 'hh_readonly')],
        }));
      })
      .finally(() => setLoadingHH(false));
  }, []);

  async function saveGoalfyConnection(input: { accessToken?: string; reportId?: string | null; apiKey?: string }) {
    try {
      const status = await saveGoalfyCredentials(input);
      setGoalfyConnection(status);
      setBanner('Conexão Goalfy salva com segurança. Agora você pode sincronizar as DNs.');
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Não foi possível salvar a conexão Goalfy.';
      setBanner(message);
      return message;
    }
  }

  async function refreshGoalfyForSelected() {
    if (!selected || goalfySyncing) return;
    setGoalfySyncing(true);
    try {
      await triggerGoalfySync(true);
      setBanner('Atualização do Goalfy solicitada em modo leitura.');

      for (let attempt = 0; attempt < 8; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
        const status = await loadGoalfySyncStatus().catch(() => null);
        if (!status || status.status === 'running') continue;

        if (status.status === 'success') {
          const shipping = await loadGoalfyShipping(selected.bsp);
          setGoalfyShipping(shipping);
          setBanner('Goalfy atualizado. Nenhum avanço operacional foi alterado.');
        } else if (status.last_error) {
          setBanner('Goalfy: ' + status.last_error);
        }
        break;
      }
    } catch (error) {
      setBanner(error instanceof Error ? error.message : 'Não foi possível atualizar o Goalfy.');
    } finally {
      setGoalfySyncing(false);
    }
  }

  function updateDemand(id: string, updater: (d: Demand) => Demand, notification?: NotificationItem) {
    setState((current) => ({
      ...current,
      demands: current.demands.map((d) => d.id === id ? updater(d) : d),
      notifications: notification ? [notification, ...current.notifications] : current.notifications,
    }));
  }

  function appendHistory(demand: Demand, type: Demand['history'][number]['type'], title: string, description: string, sectorOverride?: SectorKey) {
    return [...demand.history, {
      id: uid('evt'),
      type,
      title,
      description,
      at: new Date().toISOString(),
      actor: 'Usuário Demo',
      sector: sectorOverride ?? demand.sector,
    }];
  }

  async function runCoreAction(
    demand: Demand,
    operation: 'accept' | 'start' | 'progress' | 'wait' | 'resume' | 'block' | 'complete',
    options: { progress?: number | null; note?: string; stageKey?: string; trackingStageKey?: string } = {},
    successMessage = 'Demanda atualizada.',
  ) {
    try {
      let result: Record<string, unknown>;
      if (demand.source === 'ops_core' && demand.coreItemId) {
        result = await mutateCoreDemand(demand.coreItemId, operation, options);
      } else if (demand.source === 'hub_readonly' && demand.legacyProjectRowId && demand.legacyIsoKey) {
        result = await mutateLegacyDemand({
          region: demand.sourceRegion,
          projectRowId: demand.legacyProjectRowId,
          projectNumber: demand.bsp,
          iso: demand.legacyIsoKey,
          stageKey: options.stageKey || demand.stageKey,
          trackingStageKey: options.trackingStageKey || demand.stageKey,
        }, operation, options);
      } else {
        setBanner('Este registro não possui um ISO ativo vinculado para edição.');
        return false;
      }
      await refreshHub(false, search, true);
      const projectArchive = result && typeof result === 'object'
        ? (result as { project_archive?: { archived?: boolean } }).project_archive
        : undefined;
      const smartsheetSync = result && typeof result === 'object'
        ? (result as { smartsheet_sync?: { ok?: boolean; skipped?: boolean; reason?: string } }).smartsheet_sync
        : undefined;
      if (smartsheetSync && smartsheetSync.ok === false) {
        setBanner(successMessage + ' O painel foi salvo, mas o Smartsheet não foi atualizado: ' + (smartsheetSync.reason || 'verifique a integração.'));
      } else if (smartsheetSync && smartsheetSync.skipped && smartsheetSync.reason) {
        setBanner(successMessage + ' Smartsheet: ' + smartsheetSync.reason);
      } else {
        setBanner(projectArchive?.archived
          ? demand.bsp + ' concluída e movida automaticamente para Arquivados.'
          : successMessage);
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Não foi possível atualizar a demanda.';
      setHubError(message);
      setBanner(message);
      return false;
    }
  }

  async function assumeDemand(id: string, targetStageKey?: string) {
    const demand = demands.find((d) => d.id === id);
    if (!demand) return;

    if (demand.source === 'ops_core' || demand.source === 'hub_readonly') {
      await runCoreAction(
        demand,
        'accept',
        { stageKey: targetStageKey || demand.stageKey, trackingStageKey: demand.stageKey },
        demand.bsp + ' assumida pelo setor ' + sectorName(demand.sector) + '.',
      );
      return;
    }
    if (demand.source !== 'demo') return;

    const now = new Date().toISOString();
    updateDemand(id, (d) => ({
      ...d,
      status: 'in_progress',
      assignedTo: 'Usuário Demo',
      acceptedAt: now,
      startedAt: d.startedAt ?? now,
      history: appendHistory(d, 'accepted', 'Demanda assumida', 'Responsabilidade assumida pelo setor.'),
    }));
    setBanner(demand.bsp + ' assumida pelo setor ' + sectorName(demand.sector) + '.');
  }

  async function progressDemand(id: string, requestedProgress?: number, targetStageKey?: string) {
    const demand = demands.find((d) => d.id === id);
    if (!demand) return;

    const stageKey = targetStageKey || demand.stageKey;
    const currentProgress = targetStageKey
      ? (demand.stageProgress?.[stageKey] ?? (stageKey === demand.stageKey ? demand.progress : 0))
      : demand.progress;
    const panelProgressSteps = [25, 50, 75, 100];
    if (requestedProgress != null && !panelProgressSteps.includes(requestedProgress)) {
      setBanner('O avanço pelo painel deve ser 25%, 50%, 75% ou 100%.');
      return;
    }
    const progress = requestedProgress == null
      ? Math.min(100, Math.max(25, currentProgress + 25))
      : Math.min(100, Math.max(currentProgress, requestedProgress));
    if (progress <= currentProgress) {
      setBanner('Escolha um avanço maior que o atual.');
      return;
    }
    if (progress === 100) {
      await completeDemand(id, stageKey);
      return;
    }
    if (demand.source === 'ops_core' || demand.source === 'hub_readonly') {
      await runCoreAction(demand, 'progress', { progress, stageKey, trackingStageKey: demand.stageKey }, 'Avanço da etapa atualizado para ' + progress + '%.');
      return;
    }
    if (demand.source !== 'demo') return;

    updateDemand(id, (d) => ({
      ...d,
      progress,
      stageProgress: { ...(d.stageProgress || {}), [stageKey]: progress },
      stageStatuses: { ...(d.stageStatuses || {}), [stageKey]: 'in_progress' },
      status: 'in_progress',
      history: appendHistory(d, 'progress', 'Avanço registrado', 'Progresso atualizado para ' + progress + '%.'),
    }));
    setBanner('Avanço atualizado para ' + progress + '%.');
  }

  async function waitDemand(id: string, targetStageKey?: string) {
    const demand = demands.find((d) => d.id === id);
    if (!demand) return;

    if (demand.source === 'ops_core' || demand.source === 'hub_readonly') {
      await runCoreAction(demand, 'wait', { stageKey: targetStageKey || demand.stageKey, trackingStageKey: demand.stageKey }, demand.bsp + ' movida para Aguardando.');
      return;
    }
    if (demand.source !== 'demo') return;

    updateDemand(id, (d) => ({
      ...d,
      status: 'waiting',
      history: appendHistory(d, 'waiting', 'Demanda aguardando', 'Demanda colocada em espera temporária.'),
    }));
    setBanner(demand.bsp + ' movida para Aguardando.');
  }

  async function resumeDemand(id: string, targetStageKey?: string) {
    const demand = demands.find((d) => d.id === id);
    if (!demand) return;

    if (demand.source === 'ops_core' || demand.source === 'hub_readonly') {
      await runCoreAction(demand, 'resume', { stageKey: targetStageKey || demand.stageKey, trackingStageKey: demand.stageKey }, demand.bsp + ' retomada.');
      return;
    }
    if (demand.source !== 'demo') return;

    updateDemand(id, (d) => ({
      ...d,
      status: d.assignedTo ? 'in_progress' : 'new',
      blocker: undefined,
      history: appendHistory(d, 'resumed', 'Demanda retomada', 'Demanda liberada para continuidade.'),
    }));
    setBanner(demand.bsp + ' retomada.');
  }

  async function blockDemand(id: string, targetStageKey?: string) {
    const demand = demands.find((d) => d.id === id);
    if (!demand) return;

    const note = window.prompt('Descreva o motivo do bloqueio:', demand.blocker?.note ?? 'Aguardando retorno da Engenharia.');
    if (note === null) return;

    if (demand.source === 'ops_core' || demand.source === 'hub_readonly') {
      await runCoreAction(demand, 'block', { note, stageKey: targetStageKey || demand.stageKey, trackingStageKey: demand.stageKey }, demand.bsp + ' bloqueada.');
      return;
    }
    if (demand.source !== 'demo') return;

    const notification = createNotification(demand.sector, demand, 'Demanda bloqueada', demand.bsp + ' / ' + demand.iso + ' · ' + note, 'warning');
    updateDemand(id, (d) => ({
      ...d,
      status: 'blocked',
      blocker: { reason: 'engineering', note: note || 'Bloqueio operacional.', createdAt: new Date().toISOString() },
      history: appendHistory(d, 'blocked', 'Bloqueio aberto', note || 'Bloqueio operacional.'),
    }), notification);
    setBanner(demand.bsp + ' bloqueada.');
  }

  async function addEvidence(id: string, type: EvidenceType, file?: File) {
    const demand = demands.find((d) => d.id === id);
    if (!demand) return;
    if (demand.source === 'ops_core') {
      if (!file || !demand.coreItemId) {
        setBanner('Selecione uma foto para registrar a evidência da etapa.');
        return;
      }
      if (!file.type.startsWith('image/')) {
        setBanner('Escolha um arquivo de imagem.');
        return;
      }
      setEvidenceLoading(true);
      try {
        await uploadStageEvidence(demand.coreItemId, type, file);
        setStageEvidence(await loadStageEvidence(demand.coreItemId));
        setBanner((type === 'start' ? 'Foto inicial' : type === 'finish' ? 'Foto final' : 'Evidência') + ' adicionada à etapa.');
      } catch (error) {
        setBanner(error instanceof Error ? error.message : 'Não foi possível salvar a foto.');
      } finally {
        setEvidenceLoading(false);
      }
      return;
    }
    if (demand.source !== 'demo') return;

    const label = type === 'start' ? 'Foto inicial' : type === 'finish' ? 'Foto final' : 'Evidência extra';
    updateDemand(id, (d) => ({
      ...d,
      evidences: [...d.evidences, { id: uid('evd'), type, label: label + ' · demonstração', at: new Date().toISOString(), source: 'demo' }],
      history: appendHistory(d, 'evidence', 'Evidência adicionada', label + ' registrada na etapa atual.'),
    }));
    setBanner(label + ' adicionada.');
  }

  async function completeDemand(id: string, targetStageKey?: string) {
    const demand = demands.find((d) => d.id === id);
    if (!demand) return;

    if (demand.source === 'ops_core' || demand.source === 'hub_readonly') {
      await runCoreAction(
        demand,
        'complete',
        { stageKey: targetStageKey || demand.stageKey, trackingStageKey: demand.stageKey },
        demand.bsp + ' · etapa concluída. O próximo setor foi atualizado automaticamente.',
      );
      return;
    }
    if (demand.source !== 'demo') return;

    const stage = getStage(demand.stageKey);
    if (!stage) return;

    if (stage.photoPolicy === 'required_start_finish') {
      const hasStart = demand.evidences.some((e) => e.type === 'start');
      const hasFinish = demand.evidences.some((e) => e.type === 'finish');
      if (!hasStart || !hasFinish) {
        setBanner('Foto inicial e final são obrigatórias nesta etapa.');
        return;
      }
    }

    const next = getNextStage(demand.stageKey);
    const now = new Date().toISOString();

    if (!next) {
      updateDemand(id, (d) => ({
        ...d,
        status: 'completed',
        progress: 100,
        completedAt: now,
        history: appendHistory(d, 'completed', 'Fluxo concluído', 'Demanda encerrada.'),
      }));
      setBanner(demand.bsp + ' concluída.');
      return;
    }

    const history = appendHistory(demand, 'completed', 'Etapa concluída', stage.label + ' concluída.');
    const updated: Demand = {
      ...demand,
      stageKey: next.key,
      stage: next.label,
      originSector: demand.sector,
      sector: next.sector,
      assignedTo: undefined,
      status: 'new',
      enteredAt: now,
      acceptedAt: undefined,
      startedAt: undefined,
      completedAt: undefined,
      slaDueAt: new Date(Date.now() + next.slaMinutes * 60_000).toISOString(),
      progress: 0,
      hhMinutes: undefined,
      blocker: undefined,
      evidences: [],
      note: 'Recebida automaticamente após conclusão de ' + stage.label + '.',
      history: [...history, {
        id: uid('evt'),
        type: 'handoff',
        title: 'Handoff realizado',
        description: sectorName(demand.sector) + ' → ' + sectorName(next.sector),
        at: now,
        actor: 'Motor de fluxo · demo',
        sector: next.sector,
      }],
    };
    const notification = createNotification(next.sector, updated, 'Nova demanda recebida', updated.bsp + ' / ' + updated.iso + ' entrou na sua caixa.', 'info');
    updateDemand(id, () => updated, notification);
    setSector(next.sector);
    setBanner('Handoff realizado para ' + sectorName(next.sector) + '.');
  }

  async function handlePanelLogin(identifier: string, password: string) {
    setAuthError('');
    try {
      const user = await loginPanel(identifier, password);
      setPanelUser(user);
      setState({ version: 4, demands: [], notifications: [] });
      setHubError(null);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Não foi possível entrar.';
      setAuthError(message);
      return message;
    }
  }

  async function handlePanelLogout() {
    await logoutPanel();
    setPanelUser(null);
    setState({ version: 4, demands: [], notifications: [] });
    setSelectedId(null);
    setExpandedId(null);
    setProjectDetail(null);
    setHhEvidence(null);
    setHubError(null);
    setAuthError('');
  }

  async function manualRefreshDatabase() {
    if (!hubConfigured || !panelUser || manualSyncing) return;

    setManualSyncing(true);
    setHubError(null);
    setBanner('Atualização do banco iniciada. Verificando versões no Smartsheet...');

    try {
      await triggerHubSync();
      await new Promise((resolve) => window.setTimeout(resolve, 2500));

      let latestStatus = await loadHubSyncStatus();
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const stillSyncing = latestStatus.sources.some((source) => source.last_status === 'syncing');
        if (!stillSyncing) break;
        await new Promise((resolve) => window.setTimeout(resolve, 2500));
        latestStatus = await loadHubSyncStatus();
      }

      setLastSyncAt(latestStatus.last_synced_at || new Date().toISOString());
      await refreshHub(false, search);
      setBanner('Banco atualizado. Dados do painel recarregados.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Não foi possível atualizar o banco.';
      setHubError(message);
      setBanner(message);
    } finally {
      setManualSyncing(false);
    }
  }

  function resetDemo() {
    if (hubConfigured) {
      void manualRefreshDatabase();
      return;
    }
    if (!window.confirm('Restaurar a demonstração para o estado inicial?')) return;
    setState(resetOperationalState());
    setSelectedId(null);
    setExpandedId(null);
    setBanner('Demonstração restaurada.');
  }

  if (hubConfigured && authLoading) {
    return <PanelLogin loadingMode />;
  }

  if (hubConfigured && !panelUser) {
    return <PanelLogin error={authError} onLogin={handlePanelLogin} />;
  }

  const unread = state.notifications.filter((n) => !n.read).length;

  return (
    <div className="reference-app">
      <header className="chrome-bar">
        <div className="window-dots"><i /><i /><i /></div>
        <img src={import.meta.env.BASE_URL + 'step-logo.jpg'} className="step-logo" alt="STEP Integrated Solutions" />
        <div className="header-divider" />
        <strong>Painel Operacional — Controle de Demandas</strong>
        <nav className="header-nav">
          <button className={page === 'portfolio' ? 'active' : ''} onClick={() => { setPage('portfolio'); setSelectedId(null); }}>Carteira</button>
          <button className={page === 'live' ? 'active' : ''} onClick={() => { setPage('live'); setSelectedId(null); }}>Produção</button>
          <button className={page === 'blocks' ? 'active' : ''} onClick={() => { setPage('blocks'); setSelectedId(null); }}>Bloqueios</button>
          <button className={page === 'analytics' ? 'active' : ''} onClick={() => { setPage('analytics'); setSelectedId(null); }}>Dashboard</button>
          <button className={page === 'archive' ? 'active' : ''} onClick={() => { setPage('archive'); setSelectedId(null); }}>Arquivados</button>
          <button className={page === 'migration' ? 'active' : ''} onClick={() => { setPage('migration'); setSelectedId(null); }}>Cadastro</button>
        </nav>
        <span className="clock">{clock.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
        <button className="header-bell" onClick={() => { setPage('notifications'); setSelectedId(null); }}><Bell size={16} />{unread > 0 && <b>{unread}</b>}</button>
        <div className="user-chip"><span>{panelUser ? initials(panelUser.name) : 'UD'}</span><small>{panelUser?.name || 'Usuário Demo'}</small></div>
        {panelUser && <button className="header-logout" title="Sair do painel" onClick={() => void handlePanelLogout()}><LogOut size={15} /></button>}
      </header>

      {banner && <div className="floating-banner">{banner}</div>}

      {newBspPopup && (
        <aside className="new-bsp-popup" role="alertdialog" aria-live="assertive">
          <button className="new-bsp-popup-close" onClick={() => void closeNewBspPopup(false)} aria-label="Fechar alerta">×</button>
          <div className="new-bsp-popup-icon"><Bell size={20} /></div>
          <div className="new-bsp-popup-copy">
            <span>NOVA BSP DETECTADA</span>
            <strong>{newBspPopup.display_code || newBspPopup.project_core}</strong>
            <p>{newBspPopup.message}</p>
            <small>{(newBspPopup.source_systems || []).join(' + ') || 'Drawing'}</small>
          </div>
          <div className="new-bsp-popup-actions">
            <button className="soft-btn" onClick={() => void closeNewBspPopup(false)}>Fechar</button>
            <button className="new-bsp-popup-primary" onClick={() => void closeNewBspPopup(true)}>Abrir cadastro</button>
          </div>
        </aside>
      )}

      <main className="workspace">
        {selected ? (
          <DemandDetail
            demand={selected}
            onBack={() => setSelectedId(null)}
            onAssume={() => assumeDemand(selected.id)}
            onProgress={(progress, stageKey) => progressDemand(selected.id, progress, stageKey)}
            onWait={(stageKey) => waitDemand(selected.id, stageKey)}
            onResume={(stageKey) => resumeDemand(selected.id, stageKey)}
            onBlock={(stageKey) => blockDemand(selected.id, stageKey)}
            onEvidence={(type, file) => addEvidence(selected.id, type, file)}
            onComplete={(stageKey) => completeDemand(selected.id, stageKey)}
            hubDetail={projectDetail}
            hhEvidence={hhEvidence}
            stageEvidence={stageEvidence}
            goalfyShipping={goalfyShipping}
            goalfyConnection={goalfyConnection}
            goalfyLoading={goalfyLoading}
            goalfySyncing={goalfySyncing}
            onRefreshGoalfy={() => void refreshGoalfyForSelected()}
            onSaveGoalfyConnection={saveGoalfyConnection}
            detailLoading={detailLoading}
            evidenceLoading={evidenceLoading}
            onRefreshProject={refreshProjectDetail}
          />
        ) : page === 'portfolio' ? (
          <Portfolio
            demands={demands}
            sector={sector}
            setSector={setSector}
            mode={mode}
            setMode={setMode}
            search={search}
            setSearch={setSearch}
            stageFilters={stageFilters}
            setStageFilters={setStageFilters}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            priorityOnly={priorityOnly}
            setPriorityOnly={setPriorityOnly}
            lateOnly={lateOnly}
            setLateOnly={setLateOnly}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
            onOpen={setSelectedId}
            onAssume={assumeDemand}
            onReset={resetDemo}
            liveData={hubConfigured}
            loading={loadingHub}
            syncing={manualSyncing}
            lastSyncAt={lastSyncAt}
            error={hubError}
          />
        ) : page === 'live' ? (
          <LivePage demands={demands} loading={loadingHub || loadingHH} onOpen={setSelectedId} />
        ) : page === 'blocks' ? (
          <BlocksPage demands={demands} onOpen={setSelectedId} onResume={resumeDemand} />
        ) : page === 'notifications' ? (
          <NotificationsPage state={state} setState={setState} onOpen={setSelectedId} />
        ) : page === 'migration' ? (
          <CoreMigrationPage />
        ) : page === 'archive' ? (
          <ArchivePage />
        ) : (
          <AnalyticsPage demands={demands} onOpen={setSelectedId} />
        )}
      </main>

      <footer className="status-bar">
        <span>{selected ? 'Arquivo operacional aberto' : (sector === 'all' ? 'Todos os setores · visão completa da etapa atual' : sectorName(sector) + ' · visibilidade por responsabilidade atual')}</span>
        <span>{hubConfigured ? 'OPS CORE · Tracking somente para BSPs ainda não validadas' : 'Demonstração pública · avanço e fotos em modo isolado'}</span>
      </footer>
    </div>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'ST';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function PanelLogin(props: {
  error?: string;
  loadingMode?: boolean;
  onLogin?: (identifier: string, password: string) => Promise<string | null>;
}) {
  const [identifier, setIdentifier] = useState(() => getRememberedPanelLogin());
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState('');

  if (props.loadingMode) {
    return (
      <main className="panel-login-page">
        <div className="panel-login-card panel-login-loading">
          <img src={import.meta.env.BASE_URL + 'step-logo.jpg'} alt="STEP Integrated Solutions" />
          <RefreshCcw size={24} className="spin" />
          <strong>Validando sessão STEP...</strong>
          <span>Preparando a carteira operacional.</span>
        </div>
      </main>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!props.onLogin || submitting) return;
    setSubmitting(true);
    setLocalError('');
    const error = await props.onLogin(identifier, password);
    if (error) setLocalError(error);
    else setPassword('');
    setSubmitting(false);
  }

  return (
    <main className="panel-login-page">
      <section className="panel-login-visual">
        <div className="panel-login-visual-mark">
          <img src={import.meta.env.BASE_URL + 'step-logo.jpg'} alt="STEP Integrated Solutions" />
        </div>
        <div>
          <span className="eyebrow">STEP Operational Flow</span>
          <h1>Controle operacional conectado à execução real.</h1>
          <p>Tracking, Work in Progress, Job Order, Drawing / FCB, revisões, dimensional e logística em uma única visão.</p>
          <div className="panel-login-features">
            <span><CheckCircle2 size={16} /> Dados sincronizados com as fontes STEP</span>
            <span><CheckCircle2 size={16} /> Acesso conforme permissões do STEP One</span>
            <span><ShieldCheck size={16} /> Somente leitura sobre as planilhas de origem</span>
          </div>
        </div>
      </section>

      <section className="panel-login-form-wrap">
        <form className="panel-login-card" onSubmit={submit} autoComplete="off">
          <div className="panel-login-heading">
            <span><LockKeyhole size={21} /></span>
            <div><small>Painel Operacional</small><h2>Acessar dados reais</h2></div>
          </div>
          <p>Use o mesmo login ou e-mail e a mesma senha cadastrados no STEP One.</p>

          <label>
            E-mail ou login
            <div className="panel-login-input">
              <Users size={17} />
              <input value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder="seu@email.com ou login" autoComplete="username" required />
            </div>
          </label>

          <label>
            Senha
            <div className="panel-login-input">
              <LockKeyhole size={17} />
              <input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Senha" autoComplete="current-password" required />
              <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}>
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </label>

          {(localError || props.error) && <div className="panel-login-error">{localError || props.error}</div>}

          <button className="panel-login-submit" type="submit" disabled={submitting}>
            {submitting ? <RefreshCcw size={16} className="spin" /> : <ShieldCheck size={16} />}
            {submitting ? 'Validando acesso...' : 'Entrar no Painel Operacional'}
          </button>

          <div className="panel-login-note">
            <ShieldCheck size={15} />
            <span>Somente usuários ativos com acesso a <strong>Operações e Projetos</strong> podem consultar esta carteira.</span>
          </div>
        </form>
      </section>
    </main>
  );
}

function textField(record: Record<string, unknown>, key: string, fallback = '—') {
  const value = record[key];
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function dimensionalIndicator(row: Record<string, unknown>) {
  const value = [row.approval, row.indicator, row.result, row.status]
    .map((item) => String(item ?? '').trim())
    .find(Boolean) || '';
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  if (!normalized) return '—';
  if (normalized.includes('HOLD') || normalized.includes('PEND') || normalized === '!') return 'HOLD';
  if (normalized === 'YES' || normalized === 'SIM' || normalized === 'OK' || normalized === '✓' || normalized === 'CHECK') return 'YES';
  if (normalized === 'NO' || normalized === 'NAO' || normalized === 'X' || normalized === '✕' || normalized === 'N') return 'NO';
  return value;
}

function dimensionalDate(row: Record<string, unknown>) {
  const value = row.report_date ?? row.report_issued_date ?? row.issue_date ?? row.emission_date;
  if (value === null || value === undefined || value === '') return 'Não emitido';

  const text = String(value).trim();
  const dayFirst = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (dayFirst) {
    const year = dayFirst[3].length === 2 ? 2000 + Number(dayFirst[3]) : Number(dayFirst[3]);
    return new Intl.DateTimeFormat('pt-BR').format(new Date(year, Number(dayFirst[2]) - 1, Number(dayFirst[1]), 12));
  }

  const isoDate = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoDate) {
    return new Intl.DateTimeFormat('pt-BR').format(new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]), 12));
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : new Intl.DateTimeFormat('pt-BR').format(parsed);
}

function dimensionalIndicatorClass(indicator: string) {
  if (indicator === 'YES') return 'dimensional-indicator yes';
  if (indicator === 'HOLD') return 'dimensional-indicator hold';
  if (indicator === 'NO') return 'dimensional-indicator no';
  return 'dimensional-indicator unknown';
}

function asRecords(value: unknown[] | undefined) {
  return (value || []).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

function money(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(number);
}

function photoMoment(photo: HubHHEvidencePhoto): 'start' | 'finish' | 'extra' {
  const metadataMoment = String(photo.metadata?.moment || '').toLowerCase();
  const type = String(photo.photo_type || '').toLowerCase();
  const caption = String(photo.caption || '').toLowerCase();

  if (metadataMoment === 'start' || type === 'start') return 'start';
  if (metadataMoment === 'finish' || type === 'finish' || caption.includes('fim da etapa')) return 'finish';
  return 'extra';
}

function photoLabel(photo: HubHHEvidencePhoto) {
  const moment = photoMoment(photo);
  if (moment === 'start') return 'Início';
  if (moment === 'finish') return 'Fim da etapa';
  return 'Evidência';
}

function sessionPhotos(evidence: HubHHEvidence, sessionId: string) {
  return evidence.photos.filter((photo) => photo.session_id === sessionId);
}

type StagedPhoto = {
  photo: HubHHEvidencePhoto;
  stage: string;
  session: HubHHSession | null;
};

type PhotoStageGroup = {
  stage: string;
  photos: StagedPhoto[];
  sessions: HubHHSession[];
};

function normalizeStageName(value: string) {
  const trimmed = value
    .replace(/^etapa\s*:?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const aliases: Record<string, string> = {
    'montagem': 'Montagem',
    'solda': 'Solda',
    'controle de qualidade': 'Controle de Qualidade',
    'controle de qualidade - solda': 'Controle de Qualidade - Solda',
    'inspecao dimensional': 'Inspeção Dimensional',
    'inspeção dimensional': 'Inspeção Dimensional',
    'hydro test': 'Hydro Test',
    'th': 'Hydro Test',
    'pintura': 'Pintura',
  };

  const key = trimmed
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  return aliases[key] || trimmed || 'Etapa não identificada';
}

function captionStageInfo(caption?: string | null) {
  const text = String(caption || '').trim();
  if (!text) return { stage: '', next: '' };

  const finishMatch = text.match(/fim\s+da\s+etapa\s*:\s*([^·]+?)(?:\s*·|$)/i);
  const nextMatch = text.match(/pr[oó]xima\s*:\s*(.+)$/i);
  const startMatch = text.match(/in[ií]cio(?:\s+da\s+etapa)?\s*:\s*([^·]+?)(?:\s*·|$)/i);

  return {
    stage: normalizeStageName(finishMatch?.[1] || startMatch?.[1] || ''),
    next: normalizeStageName(nextMatch?.[1] || ''),
  };
}

function buildPhotoStageGroups(evidence: HubHHEvidence): PhotoStageGroup[] {
  const sessionById = new Map(evidence.sessions.map((session) => [session.id, session]));
  const photos = [...evidence.photos].sort((a, b) => {
    const aTime = new Date(a.taken_at || 0).getTime();
    const bTime = new Date(b.taken_at || 0).getTime();
    return aTime - bTime;
  });

  const staged: StagedPhoto[] = [];
  const currentStageBySession = new Map<string, string>();

  for (const photo of photos) {
    const session = sessionById.get(photo.session_id) || null;
    const captionInfo = captionStageInfo(photo.caption);
    const metadataActivity = normalizeStageName(String(photo.metadata?.activity || ''));

    let stage = '';
    if (metadataActivity && metadataActivity !== 'Etapa não identificada') {
      stage = metadataActivity;
    } else if (captionInfo.stage && captionInfo.stage !== 'Etapa não identificada') {
      stage = captionInfo.stage;
    } else {
      stage = currentStageBySession.get(photo.session_id) || '';
    }

    if (!stage || stage === 'Etapa não identificada') {
      stage = normalizeStageName(
        String(session?.activity_name || session?.activity_key || 'Etapa não identificada')
      );
    }

    staged.push({ photo, stage, session });

    if (captionInfo.next && captionInfo.next !== 'Etapa não identificada') {
      currentStageBySession.set(photo.session_id, captionInfo.next);
    } else if (stage && stage !== 'Etapa não identificada') {
      currentStageBySession.set(photo.session_id, stage);
    }
  }

  const groups = new Map<string, PhotoStageGroup>();
  for (const item of staged) {
    const existing = groups.get(item.stage) || { stage: item.stage, photos: [], sessions: [] };
    existing.photos.push(item);
    if (item.session && !existing.sessions.some((session) => session.id === item.session?.id)) {
      existing.sessions.push(item.session);
    }
    groups.set(item.stage, existing);
  }

  return [...groups.values()];
}

function photoStageLabel(evidence: HubHHEvidence | null, photoId: string) {
  if (!evidence) return '';
  for (const group of buildPhotoStageGroups(evidence)) {
    if (group.photos.some((item) => item.photo.id === photoId)) return group.stage;
  }
  return '';
}

function HHEvidenceGallery({ evidence, loading, onOpenPhoto }: {
  evidence: HubHHEvidence | null;
  loading: boolean;
  onOpenPhoto: (photoId: string) => void;
}) {
  if (loading) {
    return (
      <div className="section-card hh-evidence-card">
        <div className="real-source-loading"><RefreshCcw size={18} className="spin" /> Buscando fotos históricas da etapa...</div>
      </div>
    );
  }

  if (!evidence || (!evidence.sessions.length && !evidence.photos.length)) {
    return (
      <div className="section-card hh-evidence-card">
        <div className="section-card-head">
          <div><span className="section-mono">Fonte histórica</span><h2>Evidências fotográficas</h2></div>
          <span className="count-ref">0</span>
        </div>
        <div className="hh-empty-evidence">
          <ImagePlus size={22} />
          <div><strong>Nenhuma foto encontrada para este ISO/SPL.</strong><span>O vínculo é feito por BSP + ISO/SPL sem alterar a fonte histórica.</span></div>
        </div>
      </div>
    );
  }

  const groups = buildPhotoStageGroups(evidence);

  return (
    <div className="section-card hh-evidence-card">
      <div className="section-card-head">
        <div><span className="section-mono">Fonte histórica</span><h2>Evidências por etapa do processo</h2></div>
        <span className="live-source-badge"><i /> {evidence.photos.length} FOTO(S) · {groups.length} ETAPA(S)</span>
      </div>

      <div className="hh-stage-groups">
        {groups.map((group, groupIndex) => {
          const workers = [...new Set(group.sessions.flatMap((session) => (session.workers || []).map((worker) => worker.worker_name)))];

          return (
            <section className="hh-stage-group" key={group.stage}>
              <div className="hh-stage-group-head">
                <div className="hh-stage-number">{String(groupIndex + 1).padStart(2, '0')}</div>
                <div className="hh-stage-title">
                  <span>Etapa</span>
                  <strong>{group.stage}</strong>
                </div>
                <div className="hh-stage-summary">
                  <span><ImagePlus size={13} /> {group.photos.length} foto(s)</span>
                  {workers.length > 0 && <span><Users size={13} /> {workers.length} pessoa(s)</span>}
                </div>
              </div>

              {workers.length > 0 && (
                <div className="hh-workers-line">
                  <strong>Equipe:</strong> {workers.join(', ')}
                </div>
              )}

              <div className="hh-photo-grid">
                {group.photos.map(({ photo }) => (
                  <button className="hh-photo-card" type="button" onClick={() => onOpenPhoto(photo.id)} key={photo.id}>
                    <div className="hh-photo-frame">
                      {photo.signed_url
                        ? <img src={photo.signed_url} alt={photoLabel(photo)} loading="lazy" />
                        : <div className="hh-photo-missing"><ImagePlus size={20} /> Imagem indisponível</div>}
                      <span className={'hh-photo-badge ' + photoMoment(photo)}>{photoLabel(photo)}</span>
                      <span className="hh-photo-stage-chip">{group.stage}</span>
                      <span className="hh-photo-open">Ver foto</span>
                    </div>
                    <div className="hh-photo-meta">
                      <strong>{photo.caption && !/\.jpg$/i.test(photo.caption) ? photo.caption : photoLabel(photo)}</strong>
                      <span>{fmtDate(photo.taken_at || undefined)}{photo.uploaded_by_name ? ' · ' + photo.uploaded_by_name : ''}</span>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function StageEvidenceGallery({ evidence, loading }: { evidence: HubStageEvidence | null; loading: boolean }) {
  const photos = evidence?.photos ?? [];
  return (
    <div className="section-card hh-evidence-card">
      <div className="section-card-head">
        <div><span className="section-mono">Evidência operacional</span><h2>Fotos da etapa</h2></div>
        <span className="live-source-badge"><i /> {photos.length} FOTO(S)</span>
      </div>
      {loading ? (
        <div className="hh-empty-evidence"><ImagePlus size={19} /><div><strong>Carregando fotos da etapa...</strong><span>Aguarde a leitura das evidências.</span></div></div>
      ) : !photos.length ? (
        <div className="hh-empty-evidence"><ImagePlus size={19} /><div><strong>Nenhuma foto registrada ainda.</strong><span>Use “Foto início” ou “Foto fim” para evidenciar o avanço.</span></div></div>
      ) : (
        <div className="hh-photo-grid stage-evidence-grid">
          {photos.map((photo) => (
            <a className="hh-photo-card" href={photo.signed_url} target="_blank" rel="noreferrer" key={photo.id}>
              <div className="hh-photo-frame"><img src={photo.signed_url} alt={photo.caption || 'Foto da etapa'} loading="lazy" /><span className={'hh-photo-badge ' + photo.photo_type}>{photo.photo_type === 'start' ? 'Foto inicial' : photo.photo_type === 'finish' ? 'Foto final' : 'Extra'}</span></div>
              <div className="hh-photo-meta"><strong>{photo.caption || 'Evidência da etapa'}</strong><span>{fmtDate(photo.taken_at || undefined)}{photo.uploaded_by_name ? ' · ' + photo.uploaded_by_name : ''}</span></div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function EvidencePhotoModal({
  photos,
  evidence,
  index,
  onClose,
  onPrevious,
  onNext,
}: {
  photos: HubHHEvidencePhoto[];
  evidence: HubHHEvidence | null;
  index: number;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const photo = photos[index];
  if (!photo) return null;
  const stage = photoStageLabel(evidence, photo.id);

  return (
    <div className="evidence-photo-modal" role="dialog" aria-modal="true" aria-label="Visualizador de evidências">
      <button className="evidence-photo-backdrop" type="button" aria-label="Fechar visualizador" onClick={onClose} />

      <div className="evidence-photo-dialog">
        <header className="evidence-photo-dialog-head">
          <div>
            <span>{stage ? stage + ' · ' + photoLabel(photo) : photoLabel(photo)}</span>
            <strong>{index + 1} de {photos.length}</strong>
          </div>
          <button className="evidence-photo-close" type="button" onClick={onClose} aria-label="Fechar">
            <XCircle size={22} />
          </button>
        </header>

        <div className="evidence-photo-stage">
          <button
            className="evidence-photo-nav previous"
            type="button"
            onClick={onPrevious}
            disabled={photos.length <= 1}
            aria-label="Foto anterior"
          >
            <ArrowLeft size={21} />
            <span>Anterior</span>
          </button>

          <div className="evidence-photo-image-wrap">
            {photo.signed_url
              ? <img src={photo.signed_url} alt={photoLabel(photo)} />
              : <div className="evidence-photo-unavailable"><ImagePlus size={32} /> Imagem indisponível</div>}
          </div>

          <button
            className="evidence-photo-nav next"
            type="button"
            onClick={onNext}
            disabled={photos.length <= 1}
            aria-label="Próxima foto"
          >
            <span>Próxima</span>
            <ChevronRight size={21} />
          </button>
        </div>

        <footer className="evidence-photo-dialog-footer">
          <div>
            <strong>{stage ? stage + ' · ' : ''}{photo.caption && !/\.jpg$/i.test(photo.caption) ? photo.caption : photoLabel(photo)}</strong>
            <span>{fmtDate(photo.taken_at || undefined)}{photo.uploaded_by_name ? ' · ' + photo.uploaded_by_name : ''}</span>
          </div>
          <small>Use ← → para navegar · Esc para fechar</small>
        </footer>
      </div>
    </div>
  );
}

function revisionsForDrawing(
  revisions: Record<string, unknown>[],
  drawingRowId: unknown,
) {
  return revisions
    .filter((revision) => String(revision.drawing_row_id ?? '') === String(drawingRowId ?? ''))
    .sort((a, b) =>
      String(a.revision ?? '').localeCompare(String(b.revision ?? ''), 'pt-BR', {
        numeric: true,
        sensitivity: 'base',
      })
    );
}

function revisionMetaValue(revision: Record<string, unknown>, key: string) {
  const value = revision[key];
  if (value === null || value === undefined || value === '') return '';
  return String(value);
}

function RevisionHistory({
  revisions,
  currentRevision,
}: {
  revisions: Record<string, unknown>[];
  currentRevision: string;
}) {
  if (!revisions.length) {
    return <div className="drawing-revision-empty">Sem histórico de revisão preenchido nesta linha do Drawing.</div>;
  }

  return (
    <div className="drawing-revision-history">
      <div className="drawing-revision-track" aria-hidden="true">
        {revisions.map((revision, index) => (
          <Fragment key={String(revision.revision || index)}>
            <i className={String(revision.revision || '') === currentRevision ? 'current' : ''}>
              {String(revision.revision || '—')}
            </i>
            {index < revisions.length - 1 && <b />}
          </Fragment>
        ))}
      </div>

      <div className="drawing-revision-cards">
        {revisions.map((revision, index) => {
          const revisionCode = String(revision.revision || '—');
          const isCurrent = revisionCode === currentRevision;
          const start = revisionMetaValue(revision, 'start_date');
          const sentPm = revisionMetaValue(revision, 'internally_sent_pm');
          const pmApproval = revisionMetaValue(revision, 'pm_approval');
          const clientComment = revisionMetaValue(revision, 'client_comments_date');
          const originReview = revisionMetaValue(revision, 'origin_review');
          const draftman = revisionMetaValue(revision, 'draftman');
          const reviewer = revisionMetaValue(revision, 'reviewer');
          const approver = revisionMetaValue(revision, 'approver');
          const drawingNumber = revisionMetaValue(revision, 'drawing_number');

          return (
            <div className={'drawing-revision-card ' + (isCurrent ? 'current' : '')} key={revisionCode + '-' + index}>
              <div className="drawing-revision-card-head">
                <strong>Rev. {revisionCode}</strong>
                {isCurrent && <span>ATUAL</span>}
              </div>
              {drawingNumber && <div className="revision-drawing-number">{drawingNumber}</div>}
              <div className="drawing-revision-data">
                <div><span>Início</span><strong>{start || '—'}</strong></div>
                <div><span>Desenhista</span><strong>{draftman || '—'}</strong></div>
                <div><span>Reviewer</span><strong>{reviewer || '—'}</strong></div>
                <div><span>Approver</span><strong>{approver || '—'}</strong></div>
                <div><span>Envio ao PM</span><strong>{sentPm || '—'}</strong></div>
                <div><span>Aprovação PM</span><strong>{pmApproval || '—'}</strong></div>
                <div><span>Comentário cliente</span><strong>{clientComment || '—'}</strong></div>
                <div><span>Origin Review</span><strong>{originReview || '—'}</strong></div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function attachmentSize(sizeKb?: number | null) {
  const value = Number(sizeKb || 0);
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1024) return (value / 1024).toFixed(1) + ' MB';
  return Math.round(value) + ' KB';
}

function DrawingAttachmentsPanel({
  rowId,
  loading,
  data,
  openingId,
  onOpen,
}: {
  rowId: number;
  loading: boolean;
  data: HubDrawingAttachments | null;
  openingId: number | null;
  onOpen: (attachment: HubDrawingAttachment) => void;
}) {
  const row = data?.rows.find((item) => Number(item.source_row_id) === Number(rowId));
  const attachments = row?.attachments ?? [];

  if (loading) {
    return <div className="drawing-attachments-loading"><RefreshCcw size={14} className="spin" /> Buscando PDFs anexados no Smartsheet...</div>;
  }
  if (!attachments.length) {
    return <div className="drawing-attachments-empty">Nenhum PDF anexado nesta linha do Drawing.</div>;
  }

  return (
    <div className="drawing-attachments">
      <div className="drawing-attachments-head">
        <div><FileText size={15} /><strong>PDFs anexados no Drawing</strong></div>
        <span>{attachments.length} arquivo(s)</span>
      </div>
      <div className="drawing-attachment-list">
        {attachments.map((attachment) => (
          <div className="drawing-attachment-row" key={attachment.id}>
            <div className="drawing-attachment-icon"><FileText size={17} /></div>
            <div className="drawing-attachment-name">
              <strong>{attachment.name}</strong>
              <span>
                {attachment.revision ? 'Rev. ' + attachment.revision + ' · ' : ''}
                {attachmentSize(attachment.size_kb)}
                {attachment.created_at ? ' · ' + fmtDate(attachment.created_at) : ''}
              </span>
            </div>
            <span className={'drawing-attachment-revision ' + (attachment.revision ? 'known' : 'unknown')}>
              {attachment.revision ? 'REV. ' + attachment.revision : 'REV. NÃO IDENTIFICADA'}
            </span>
            <button
              className="drawing-attachment-open"
              type="button"
              onClick={() => onOpen(attachment)}
              disabled={openingId !== null}
            >
              {openingId === attachment.id ? <RefreshCcw size={14} className="spin" /> : <Eye size={14} />}
              {openingId === attachment.id ? 'Abrindo...' : 'Visualizar PDF'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function DrawingPdfModal({
  name,
  revision,
  url,
  onClose,
}: {
  name: string;
  revision: string;
  url: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handler);
    };
  }, [onClose]);

  return (
    <div className="drawing-pdf-modal" role="dialog" aria-modal="true" aria-label="Visualizador de PDF do Drawing">
      <button className="drawing-pdf-backdrop" type="button" onClick={onClose} aria-label="Fechar PDF" />
      <div className="drawing-pdf-dialog">
        <header>
          <div>
            <span>Drawing Documentation Control</span>
            <strong>{name}</strong>
            <small>{revision ? 'Revisão ' + revision : 'Revisão não identificada no nome do arquivo'}</small>
          </div>
          <div className="drawing-pdf-actions">
            <a href={url} target="_blank" rel="noreferrer"><Eye size={14} /> Abrir em nova aba</a>
            <a href={url} download={name}><FileText size={14} /> Baixar PDF</a>
            <button type="button" onClick={onClose}><XCircle size={20} /></button>
          </div>
        </header>
        <div className="drawing-pdf-frame-wrap">
          <object data={url} type="application/pdf" className="drawing-pdf-frame" aria-label={name}>
            <div className="drawing-pdf-fallback">
              <FileText size={28} />
              <strong>O navegador não conseguiu renderizar o PDF.</strong>
              <span>Use “Abrir em nova aba” ou “Baixar PDF”.</span>
            </div>
          </object>
        </div>
      </div>
    </div>
  );
}

function compactDrawingIdentity(value: unknown) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function drawingItemSuffix(value: unknown, projectKey: string) {
  let normalized = compactDrawingIdentity(value).replace(/^(BSP|BEP|BPP|B3D)/, '');
  const project = compactDrawingIdentity(projectKey).replace(/^(BSP|BEP|BPP|B3D)/, '');

  if (project && normalized.startsWith(project)) {
    normalized = normalized.slice(project.length);
  }

  return normalized;
}

function drawingMatchesItem(
  row: Record<string, unknown>,
  selectedItem: string,
  projectKey: string,
) {
  const selectedSuffix = drawingItemSuffix(selectedItem, projectKey);
  if (!selectedSuffix) return false;

  const candidates = [
    drawingItemSuffix(row.drawing_number, projectKey),
    drawingItemSuffix(row.document_title, projectKey),
  ].filter(Boolean);

  return candidates.some((candidate) =>
    candidate === selectedSuffix
    || selectedSuffix.startsWith(candidate)
    || candidate.startsWith(selectedSuffix)
  );
}

function isSupportDrawing(row: Record<string, unknown>) {
  const rawCells = row.raw_cells && typeof row.raw_cells === 'object'
    ? row.raw_cells as Record<string, unknown>
    : {};
  const haystack = [
    row.drawing_number,
    row.document_title,
    rawCells['Doc. Ref.Client / Title'],
    rawCells['Drawing Number (Rev. A)'],
  ].map((value) => String(value ?? '').toUpperCase()).join(' ');
  const unit = String(rawCells.UNIT ?? '').toUpperCase();
  return /(^|-)SUP-/.test(haystack)
    || /(^|[^A-Z0-9])PS0?[1-6]([^A-Z0-9]|$)/.test(haystack)
    || unit.includes('KG (STR)');
}

function stepflowClosedPhase(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['po enviada', 'processos cancelados', 'recebido', 'cancelado', 'nao diligenciavel'].includes(normalized);
}

function StepFlowProjectBlock({ data, error }: {
  data: import('./services/opsPanelHub').HubStepflowProject | null | undefined;
  error?: string | null;
}) {
  if (!data && !error) return null;

  if (!data) {
    return (
      <div className="source-block stepflow-block">
        <div className="source-block-head">
          <strong>STEP Flow</strong>
          <span>Leitura indisponível</span>
        </div>
        <div className="stepflow-error">{error || 'Não foi possível consultar o STEP Flow.'}</div>
      </div>
    );
  }

  const compras = asRecords(data.compras);
  const diligenciamentos = asRecords(data.diligenciamentos);
  const rmStatus = asRecords(data.rm_status);
  const rentals = asRecords(data.materiais_alugados);
  const openCompras = compras.filter((row) => !stepflowClosedPhase(row.fase)).slice(0, 12);
  const openDilig = diligenciamentos.filter((row) => !stepflowClosedPhase(row.fase)).slice(0, 10);

  return (
    <div className="source-block stepflow-block">
      <div className="source-block-head">
        <strong>STEP Flow · Processos vinculados à BSP</strong>
        <span>{data.generated_at ? 'Leitura ' + fmtDate(data.generated_at) : 'Somente leitura'}</span>
      </div>

      <div className="stepflow-kpis">
        <div><span>Compras</span><strong>{data.summary?.compras ?? compras.length}</strong><small>{data.summary?.compras_abertas ?? 0} aberta(s)</small></div>
        <div><span>Diligenciamentos</span><strong>{data.summary?.diligenciamentos ?? diligenciamentos.length}</strong><small>{data.summary?.diligenciamentos_abertos ?? 0} aberto(s)</small></div>
        <div><span>Itens de RM</span><strong>{data.summary?.rm_itens ?? 0}</strong><small>{data.summary?.rm_pendentes ?? 0} pendente(s)</small></div>
        <div><span>Materiais alugados</span><strong>{data.summary?.materiais_alugados ?? rentals.length}</strong><small>vínculo por BSP</small></div>
      </div>

      {rmStatus.length > 0 && (
        <div className="stepflow-status-strip">
          {rmStatus.slice(0, 8).map((row, index) => (
            <span key={String(row.status || index)}>
              <strong>{textField(row, 'items', '0')}</strong> {textField(row, 'status')}
            </span>
          ))}
        </div>
      )}

      {openCompras.length > 0 && (
        <div className="stepflow-subsection">
          <div className="stepflow-subhead"><strong>Compras em andamento</strong><span>{openCompras.length} exibida(s)</span></div>
          <div className="stepflow-list">
            {openCompras.map((row, index) => (
              <div className="stepflow-row" key={String(row.id || index)}>
                <div>
                  <strong>{textField(row, 'fase')}</strong>
                  <small>RM {textField(row, 'numero_rm')} · Cotação {textField(row, 'numero_cotacao')}</small>
                </div>
                <div><span>Material</span><strong>{textField(row, 'classe_material')}</strong></div>
                <div><span>Comprador</span><strong>{textField(row, 'comprador_responsavel', textField(row, 'pm_responsavel'))}</strong></div>
                <div><span>PO / Entrega</span><strong>{textField(row, 'numero_po')}</strong><small>{textField(row, 'data_entrega_po', textField(row, 'previsao_entrega'))}</small></div>
              </div>
            ))}
          </div>
        </div>
      )}

      {openDilig.length > 0 && (
        <div className="stepflow-subsection">
          <div className="stepflow-subhead"><strong>Diligenciamento em aberto</strong><span>{openDilig.length} exibido(s)</span></div>
          <div className="stepflow-list">
            {openDilig.map((row, index) => (
              <div className="stepflow-row" key={String(row.id || index)}>
                <div>
                  <strong>{textField(row, 'fase')}</strong>
                  <small>RM {textField(row, 'numero_rm')} · OCM/PO {textField(row, 'numero_ocm')}</small>
                </div>
                <div><span>Fornecedor</span><strong>{textField(row, 'fornecedor_nome')}</strong></div>
                <div><span>Programado</span><strong>{textField(row, 'data_programada')}</strong></div>
                <div><span>Recebimento</span><strong>{textField(row, 'data_recebimento')}</strong></div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!openCompras.length && !openDilig.length && (
        <div className="drawing-attachments-empty">Nenhum processo aberto do STEP Flow encontrado para esta BSP.</div>
      )}
    </div>
  );
}

function RealSourcesPanel({ detail, loading, iso, onRefreshProject }: {
  detail: Awaited<ReturnType<typeof loadHubProject>> | null;
  loading: boolean;
  iso: string;
  onRefreshProject: () => Promise<void>;
}) {
  const projectKey = detail?.project?.project_key || '';
  const [drawingAttachments, setDrawingAttachments] = useState<HubDrawingAttachments | null>(null);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [attachmentError, setAttachmentError] = useState('');
  const [pdfViewer, setPdfViewer] = useState<{
    name: string;
    revision: string;
    url: string;
  } | null>(null);
  const [pdfLoadingId, setPdfLoadingId] = useState<number | null>(null);
  const [applyingRevisionId, setApplyingRevisionId] = useState<number | null>(null);
  const [revisionApplyError, setRevisionApplyError] = useState('');

  useEffect(() => {
    return () => {
      if (pdfViewer?.url?.startsWith('blob:')) URL.revokeObjectURL(pdfViewer.url);
    };
  }, [pdfViewer]);

  useEffect(() => {
    if (!projectKey) {
      setDrawingAttachments(null);
      return;
    }

    let active = true;
    setAttachmentsLoading(true);
    setAttachmentError('');

    loadHubDrawingAttachments(projectKey, iso)
      .then((data) => {
        if (active) setDrawingAttachments(data);
      })
      .catch((error) => {
        if (active) {
          setDrawingAttachments(null);
          setAttachmentError(error instanceof Error ? error.message : 'Não foi possível carregar os PDFs do Drawing.');
        }
      })
      .finally(() => {
        if (active) setAttachmentsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [projectKey, iso]);

  async function openDrawingPdf(attachment: HubDrawingAttachment) {
    if (!projectKey || pdfLoadingId !== null) return;
    setPdfLoadingId(attachment.id);
    setAttachmentError('');
    try {
      const blob = await loadHubDrawingAttachmentPdf(projectKey, attachment.id);
      const blobUrl = URL.createObjectURL(blob);

      setPdfViewer((current) => {
        if (current?.url?.startsWith('blob:')) URL.revokeObjectURL(current.url);
        return {
          name: attachment.name,
          revision: attachment.revision || '',
          url: blobUrl,
        };
      });
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : 'Não foi possível abrir o PDF.');
    } finally {
      setPdfLoadingId(null);
    }
  }

  async function applyRevision(sourceRowId: number) {
    if (!sourceRowId || applyingRevisionId !== null) return;
    setApplyingRevisionId(sourceRowId);
    setRevisionApplyError('');
    try {
      await applyHubDrawingRevision(sourceRowId);
      await onRefreshProject();
    } catch (error) {
      setRevisionApplyError(error instanceof Error ? error.message : 'Não foi possível aplicar a revisão.');
    } finally {
      setApplyingRevisionId(null);
    }
  }

  function closeDrawingPdf() {
    setPdfViewer((current) => {
      if (current?.url?.startsWith('blob:')) URL.revokeObjectURL(current.url);
      return null;
    });
  }

  if (loading) {
    return (
      <div className="section-card real-sources-card">
        <div className="real-source-loading"><RefreshCcw size={18} className="spin" /> Carregando WIP, Job Order, Drawing / FCB e inspeções...</div>
      </div>
    );
  }
  if (!detail) return null;

  const project = detail.project;
  const wip = asRecords(detail.wip);
  const allDrawings = asRecords(detail.drawings);
  const drawings = allDrawings.filter((row) => drawingMatchesItem(row, iso, projectKey));
  const supportOnly = drawings.length > 0 && drawings.every(isSupportDrawing);
  const drawingRowIds = new Set(drawings.map((row) => String(row.source_row_id ?? '')));
  const revisions = asRecords(detail.drawing_revisions)
    .filter((revision) => drawingRowIds.has(String(revision.drawing_row_id ?? '')));
  const revisionAlerts = asRecords(detail.drawing_revision_alerts);
  const alertByRow = new Map(revisionAlerts.map((alert) => [String(alert.source_row_id ?? ''), alert]));
  const jobs = asRecords(detail.job_orders);
  const dimensional = asRecords(detail.dimensional);
  const logistics = asRecords(detail.logistics);
  const sourceTimeline = detail.source_timeline;
  const leadTimeValue = sourceTimeline?.lead_time_status === 'source_dates_need_review'
    ? 'Revisar datas'
    : sourceTimeline?.lead_time_days != null
    ? `${fmtNumber(sourceTimeline.lead_time_days)} dias`
    : sourceTimeline?.lead_time_hours != null
      ? `${fmtNumber(sourceTimeline.lead_time_hours)} h`
      : 'Aguardando FCB';
  const timelineStatus = sourceTimeline?.lead_time_status === 'source_dates_need_review'
    ? 'Datas para revisar'
    : sourceTimeline?.status === 'fcb_detected'
    ? 'FCB identificado'
    : sourceTimeline?.status === 'awaiting_fcb'
      ? 'Aguardando FCB'
      : sourceTimeline?.status === 'awaiting_drawing'
      ? 'Aguardando Drawing'
      : sourceTimeline?.status === 'not_applicable'
        ? 'Não se aplica'
        : 'Sem informação';

  return (
    <div className="section-card real-sources-card">
      <div className="section-card-head">
        <div><span className="section-mono">Fontes integradas</span><h2>Dados reais consolidados do projeto</h2></div>
        <span className="live-source-badge"><i /> SINCRONIZADO</span>
      </div>

      <div className="source-count-grid">
        <div><span>WIP</span><strong>{wip.length}</strong></div>
        <div><span>Job Order</span><strong>{jobs.length}</strong></div>
        <div><span>Drawings</span><strong>{drawings.length}</strong></div>
        <div><span>FCBs</span><strong>{drawings.filter((row) => row.is_fcb === true).length}</strong></div>
        <div><span>Revisões</span><strong>{revisions.length}</strong></div>
        <div><span>PDFs Drawing</span><strong>{attachmentsLoading ? '…' : drawingAttachments?.attachment_count ?? 0}</strong></div>
        <div><span>Dimensional</span><strong>{dimensional.length}</strong></div>
        <div><span>Logística</span><strong>{logistics.length}</strong></div>
        <div><span>STEP Flow</span><strong>{detail.stepflow?.summary ? (detail.stepflow.summary.compras + detail.stepflow.summary.diligenciamentos) : 0}</strong></div>
      </div>

      {project && (
        <div className="source-project-summary">
          <SummaryField label="Status WIP" value={project.project_status || project.wip_progress_text || '—'} />
          <SummaryField label="Customer PO" value={project.customer_po || project.po_numbers || '—'} />
          <SummaryField label="Job Order" value={project.job_order_ids || '—'} />
          <SummaryField label="Valor da PO" value={money(project.po_value)} />
          <SummaryField label="Faturado" value={money(project.billed_value)} />
          <SummaryField label="Saldo contratual" value={money(project.contractual_balance)} />
          <SummaryField label="Revisão do ISO" value={
            drawings.length
              ? drawings.map((row) => textField(row, 'current_revision', '')).filter(Boolean).join(' / ') || '—'
              : '—'
          } />
          <SummaryField label="Atualização consolidada" value={fmtDate(project.data_updated_at || undefined)} />
        </div>
      )}

      {!supportOnly && sourceTimeline?.status !== 'not_applicable' && <div className="source-timeline">
        <div className="source-timeline-head">
          <div><span className="section-mono">Linha do tempo documental</span><strong>Drawing → FCB</strong></div>
          <span className={`source-timeline-status ${sourceTimeline?.status === 'fcb_detected' ? 'done' : 'pending'}`}>{timelineStatus}</span>
        </div>
        <div className="source-timeline-grid">
          <SummaryField label="Cadastro no Drawing" value={fmtDate(sourceTimeline?.drawing_registered_at || undefined)} />
          <SummaryField label="Identificado pelo painel" value={fmtDate(sourceTimeline?.drawing_detected_at || undefined)} />
          <SummaryField label="FCB emitido" value={fmtDate(sourceTimeline?.fcb_issued_at || undefined)} />
          <SummaryField label="Tempo até o FCB" value={leadTimeValue} />
        </div>
        {sourceTimeline?.fcb_drawing_number && (
          <small className="source-timeline-note">
            Referência: {sourceTimeline.fcb_drawing_number}{sourceTimeline.fcb_revision ? ` · Rev. ${sourceTimeline.fcb_revision}` : ''}
            {sourceTimeline.fcb_issued_basis ? ` · data baseada em ${sourceTimeline.fcb_issued_basis}` : ''}.
          </small>
        )}
        {sourceTimeline?.status === 'awaiting_fcb' && (
          <small className="source-timeline-note">O Drawing já foi identificado. O cronômetro será fechado automaticamente assim que o FCB aparecer na fonte sincronizada.</small>
        )}
      </div>}

      <StepFlowProjectBlock data={detail.stepflow} error={detail.stepflow_error} />

      {drawings.length === 0 && (
        <div className="source-block">
          <div className="source-block-head"><strong>Drawing / FCB</strong><span>ISO {iso}</span></div>
          <div className="drawing-attachments-empty">Nenhum Drawing vinculado especificamente a este ISO.</div>
        </div>
      )}

      {drawings.length > 0 && (
        <div className="source-block">
          <div className="source-block-head">
            <strong>Drawing / FCB</strong>
            <span>{drawings.length} documento(s) · {revisions.length} revisão(ões)</span>
          </div>

          {attachmentError && <div className="drawing-attachment-error">{attachmentError}</div>}
          {revisionApplyError && <div className="drawing-attachment-error">{revisionApplyError}</div>}

          <div className="drawing-revision-list">
            {drawings.slice(0, 20).map((row, index) => {
              const rowId = row.source_row_id;
              const rowRevisions = revisionsForDrawing(revisions, rowId);
              const currentRevision = textField(
                row,
                'current_revision',
                rowRevisions.length ? String(rowRevisions[rowRevisions.length - 1].revision || '—') : '—',
              );
              const revisionAlert = alertByRow.get(String(rowId ?? ''));
              const latestRevision = rowRevisions[rowRevisions.length - 1];
              const previousRevision = rowRevisions[rowRevisions.length - 2];
              const revisionDiff = revisionDiffEntries(previousRevision, latestRevision);

              return (
                <details className="drawing-revision-item" key={String(rowId || index)}>
                  <summary className="drawing-revision-summary">
                    <span className="drawing-doc-cell">
                      <strong>{textField(row, 'drawing_number', textField(row, 'document_title'))}</strong>
                      <small>{textField(row, 'document_title', '')}</small>
                    </span>

                    <span className="drawing-current-revision">
                      <small>Revisão atual</small>
                      <strong>Rev. {currentRevision}</strong>
                      <em>{rowRevisions.length} revisão(ões)</em>
                    </span>

                    <span className="drawing-status-cell">
                      <small>Status</small>
                      <strong>{textField(row, 'current_status')}</strong>
                    </span>

                    <span className="drawing-type-cell">
                      {row.is_fcb === true ? <b className="fcb-pill">FCB</b> : <b className="drawing-pill">Drawing</b>}
                    </span>

                    <ChevronDown className="drawing-revision-chevron" size={16} />
                  </summary>

                  {revisionAlert && (
                    <div className="drawing-revision-alert" role="alert">
                      <div className="drawing-revision-alert-head">
                        <div><AlertTriangle size={15} /><strong>Nova revisão detectada</strong></div>
                        <span>REV. {String(revisionAlert.from_revision || '—')} → REV. {String(revisionAlert.to_revision || currentRevision)}</span>
                      </div>
                      <p>O Drawing foi atualizado. Confira as alterações antes de aplicar esta revisão ao OPS Core.</p>
                      {!!revisionDiff.length && (
                        <div className="drawing-revision-diff">
                          {revisionDiff.map((entry) => (
                            <div key={entry.key}><span>{entry.label}</span><b>{entry.from}</b><em>→</em><strong>{entry.to}</strong></div>
                          ))}
                        </div>
                      )}
                      <button
                        className="drawing-revision-apply"
                        type="button"
                        onClick={() => void applyRevision(Number(rowId))}
                        disabled={applyingRevisionId !== null}
                      >
                        {applyingRevisionId === Number(rowId) ? <RefreshCcw size={14} className="spin" /> : <Check size={14} />}
                        {applyingRevisionId === Number(rowId) ? 'Aplicando revisão...' : 'Aplicar revisão ao painel'}
                      </button>
                    </div>
                  )}

                  <RevisionHistory
                    revisions={rowRevisions}
                    currentRevision={currentRevision}
                  />

                  <DrawingAttachmentsPanel
                    rowId={Number(rowId)}
                    loading={attachmentsLoading}
                    data={drawingAttachments}
                    openingId={pdfLoadingId}
                    onOpen={openDrawingPdf}
                  />
                </details>
              );
            })}
          </div>

          {drawings.length > 20 && <div className="source-more">+ {drawings.length - 20} documento(s) vinculados ao projeto.</div>}
        </div>
      )}

      {jobs.length > 0 && (
        <div className="source-block">
          <div className="source-block-head"><strong>Job Order / Comercial</strong><span>{jobs.length} registro(s)</span></div>
          <div className="source-card-grid">
            {jobs.slice(0, 4).map((row, index) => (
              <div className="source-data-card" key={String(row.project_key || index)}>
                <div><span>PO</span><strong>{textField(row, 'po_numbers')}</strong></div>
                <div><span>Job Order</span><strong>{textField(row, 'line_ids')}</strong></div>
                <div><span>Valor</span><strong>{money(row.po_value)}</strong></div>
                <div><span>Faturado</span><strong>{money(row.billed_value)}</strong></div>
                <div><span>Saldo</span><strong>{money(row.contractual_balance)}</strong></div>
                <div><span>Status</span><strong>{textField(row, 'billing_status')}</strong></div>
              </div>
            ))}
          </div>
        </div>
      )}

      {dimensional.length > 0 && (
        <div className="source-block">
          {(() => {
            const indicators = dimensional.map(dimensionalIndicator);
            const emitted = dimensional.filter((row) => dimensionalDate(row) !== 'Não emitido').length;
            const yes = indicators.filter((value) => value === 'YES').length;
            const hold = indicators.filter((value) => value === 'HOLD').length;
            const no = indicators.filter((value) => value === 'NO').length;

            return (
              <>
                <div className="source-block-head"><strong>3D / Dimensional Control · BSP</strong><span>{dimensional.length} registro(s) referenciado(s)</span></div>
                <div className="dimensional-summary" aria-label="Resumo dos relatórios dimensionais">
                  <div><span>Relatórios</span><strong>{dimensional.length}</strong></div>
                  <div><span>Emitidos</span><strong>{emitted}</strong></div>
                  <div className="yes"><span>YES</span><strong>{yes}</strong></div>
                  <div className="hold"><span>HOLD</span><strong>{hold}</strong></div>
                  <div className="no"><span>NO</span><strong>{no}</strong></div>
                </div>
                <div className="source-mini-table dimensional-source-table">
                  <div className="source-mini-head"><span>Relatório / referência</span><span>Spool</span><span>Etapa</span><span>Situação do relatório</span><span>Emissão</span><span>Indicador</span></div>
                  {dimensional.slice(0, 20).map((row, index) => {
                    const indicator = dimensionalIndicator(row);
                    return (
                      <div className="source-mini-row" key={String(row.source_row_id || index)}>
                        <span>{textField(row, 'sob_reference', textField(row, 'report_reference'))}</span>
                        <span>{textField(row, 'spool')}</span>
                        <span>{textField(row, 'inspection_stage')}</span>
                        <span>{textField(row, 'status')}</span>
                        <span>{dimensionalDate(row)}</span>
                        <span><b className={dimensionalIndicatorClass(indicator)}>{indicator}</b></span>
                      </div>
                    );
                  })}
                </div>
                {dimensional.length > 20 && <div className="source-more">+ {dimensional.length - 20} registro(s) dimensional(is) vinculados à BSP.</div>}
              </>
            );
          })()}
        </div>
      )}

      {logistics.length > 0 && (
        <div className="source-block">
          <div className="source-block-head"><strong>Logística</strong><span>{logistics.length} movimento(s)</span></div>
          <div className="source-mini-table logistics-source-table">
            <div className="source-mini-head"><span>Data</span><span>Movimento</span><span>Origem</span><span>Destino</span></div>
            {logistics.slice(0, 8).map((row, index) => (
              <div className="source-mini-row" key={String(row.source_row_id || index)}>
                <span>{textField(row, 'movement_date')}</span>
                <span>{textField(row, 'movement')}</span>
                <span>{textField(row, 'origin')}</span>
                <span>{textField(row, 'destination')}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {pdfViewer && (
        <DrawingPdfModal
          name={pdfViewer.name}
          revision={pdfViewer.revision}
          url={pdfViewer.url}
          onClose={closeDrawingPdf}
        />
      )}
    </div>
  );
}

type BspGroup = {
  key: string;
  bsp: string;
  demands: Demand[];
};

function groupDemandsByBsp(demands: Demand[]): BspGroup[] {
  const map = new Map<string, Demand[]>();

  for (const demand of demands) {
    const rawBsp = String(demand.bsp ?? '').trim();
    const normalizedBsp = rawBsp
      .toUpperCase()
      .replace(/^BSP[\s_-]*/i, '')
      .replace(/\s+/g, '')
      .trim();
    const key = normalizedBsp || String(demand.projectGroupKey || demand.id || 'sem-bsp');
    const items = map.get(key) ?? [];
    items.push(demand);
    map.set(key, items);
  }

  return [...map.entries()]
    .map(([key, items]) => ({
      key,
      bsp: String(items[0]?.bsp ?? key),
      demands: [...items].sort((a, b) =>
        String(a.iso ?? '').localeCompare(String(b.iso ?? ''), 'pt-BR', { numeric: true, sensitivity: 'base' })
      ),
    }))
    .sort((a, b) => {
      const aPriority = Math.max(...a.demands.map((d) => priorityWeight[d.priority]));
      const bPriority = Math.max(...b.demands.map((d) => priorityWeight[d.priority]));
      if (bPriority !== aPriority) return bPriority - aPriority;

      const aOldest = Math.min(...a.demands.map((d) => new Date(d.enteredAt).getTime()));
      const bOldest = Math.min(...b.demands.map((d) => new Date(d.enteredAt).getTime()));
      if (aOldest !== bOldest) return aOldest - bOldest;

      return a.bsp.localeCompare(b.bsp, 'pt-BR', { numeric: true, sensitivity: 'base' });
    });
}

function groupStatus(demands: Demand[]): DemandStatus {
  const rank: Record<DemandStatus, number> = {
    blocked: 7,
    late: 6,
    waiting: 5,
    in_progress: 4,
    new: 3,
    completed: 1,
  };

  return demands
    .map(effectiveStatus)
    .sort((a, b) => rank[b] - rank[a])[0] ?? 'new';
}

function groupPriority(demands: Demand[]): Priority {
  return [...demands]
    .sort((a, b) => priorityWeight[b.priority] - priorityWeight[a.priority])[0]?.priority ?? 'normal';
}

function groupProgress(demands: Demand[]) {
  if (!demands.length) return 0;
  return Math.round(demands.reduce((sum, demand) => sum + demand.progress, 0) / demands.length);
}

function groupStageLabel(demands: Demand[]) {
  const stages = [...new Set(demands.map((d) => d.stage).filter(Boolean))];
  if (!stages.length) return 'Etapa não informada';
  if (stages.length === 1) return stages[0];
  return stages.length + ' etapas ativas';
}

function groupSectorLabel(demands: Demand[]) {
  const sectorKeys = [...new Set(demands.map((d) => d.sector))];
  if (!sectorKeys.length) return '—';
  if (sectorKeys.length === 1) return sectorName(sectorKeys[0]);
  return sectorKeys.length + ' setores';
}

function pmOwnerLabel(demand: Pick<Demand, 'pm'>) {
  const label = pmDisplayLabel(demand.pm);
  return label === 'Sem PM' ? 'PM não informado' : 'PM · ' + label;
}

const revisionFieldLabels: Record<string, string> = {
  draftman: 'Desenhista',
  reviewer: 'Reviewer',
  approver: 'Approver',
  origin_review: 'Motivo da revisão',
  pm_approval: 'Aprovação PM',
  approver_approval: 'Aprovação do approver',
  reviewer_approval: 'Aprovação do reviewer',
  internally_sent_pm: 'Envio ao PM',
  last_revision_start: 'Início da revisão',
  client_comments_date: 'Comentários do cliente',
  draftman_hh: 'HH desenhista',
  reviewer_hh: 'HH reviewer',
  approver_hh: 'HH approver',
};

function revisionDiffEntries(previous: Record<string, unknown> | undefined, current: Record<string, unknown> | undefined) {
  if (!previous || !current) return [] as Array<{ key: string; label: string; from: string; to: string }>;
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...keys]
    .filter((key) => !['revision', 'raw', 'drawing_number'].includes(key))
    .map((key) => ({
      key,
      label: revisionFieldLabels[key] || key.replace(/_/g, ' '),
      from: revisionMetaValue(previous, key) || '—',
      to: revisionMetaValue(current, key) || '—',
    }))
    .filter((entry) => entry.from !== entry.to)
    .slice(0, 12);
}

function sumDemandMeasure(demands: Demand[], field: 'weightKg' | 'm2') {
  const values = demands
    .map((demand) => demand[field])
    .filter((value): value is number => value != null && Number.isFinite(Number(value)))
    .map(Number);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function formatMeasure(value: number | null | undefined, unit: 'kg' | 'm²') {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(Number(value)) + ' ' + unit;
}

function normalizeSearchValue(value: unknown) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function normalizeIdentifierSearch(value: unknown) {
  return normalizeSearchValue(value)
    .replace(/^bsp/, '')
    .replace(/^iso/, '')
    .replace(/^spl/, '');
}

function pmDisplayLabel(value: unknown) {
  let raw = String(value ?? '').trim().replace(/^PM\s*[·:\-]?\s*/i, '');
  if (!raw) return 'Sem PM';
  if (raw.includes('@')) {
    raw = raw.split('@')[0]
      .replace(/[._-]+/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }
  return raw;
}

function matchesDemandSearch(demand: Demand, rawQuery: string) {
  const query = rawQuery.trim();
  if (!query) return true;

  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) return true;

  const identifierQuery = normalizeIdentifierSearch(query);
  const identifierFields = [
    demand.bsp,
    demand.iso,
    demand.project,
    demand.projectGroupKey,
    String(demand.bsp ?? '') + String(demand.iso ?? ''),
  ]
    .map(normalizeIdentifierSearch)
    .filter(Boolean);

  // Identificadores são comparados sem pontuação/separadores.
  // Ex.: 25-481-STR-001 = 25481STR001 = 25.481.STR.001 = BSP-25-481-STR-001.
  if (identifierQuery && identifierFields.some((field) => field.includes(identifierQuery))) {
    return true;
  }

  const words = query
    .split(/\s+/)
    .map(normalizeSearchValue)
    .filter(Boolean);

  const haystack = [
    demand.bsp,
    demand.iso,
    demand.stage,
    demand.project,
    demand.client,
    demand.pm,
    demand.assignedTo,
    sectorName(demand.sector),
    demand.note,
  ]
    .map(normalizeSearchValue)
    .filter(Boolean)
    .join(' ');

  return words.every((word) => haystack.includes(word));
}

function Portfolio(props: {
  demands: Demand[];
  sector: SectorFilter;
  setSector: (value: SectorFilter) => void;
  mode: ListMode;
  setMode: (value: ListMode) => void;
  search: string;
  setSearch: (value: string) => void;
  stageFilters: string[];
  setStageFilters: (value: string[]) => void;
  statusFilter: PortfolioStatusFilter;
  setStatusFilter: (value: PortfolioStatusFilter) => void;
  priorityOnly: boolean;
  setPriorityOnly: (value: boolean) => void;
  lateOnly: boolean;
  setLateOnly: (value: boolean) => void;
  expandedId: string | null;
  setExpandedId: (value: string | null) => void;
  onOpen: (id: string) => void;
  onAssume: (id: string) => void;
  onReset: () => void;
  liveData: boolean;
  loading: boolean;
  syncing: boolean;
  lastSyncAt: string | null;
  error: string | null;
}) {
  const [progressSort, setProgressSort] = useState<'none' | 'desc' | 'asc'>('none');
  const [statusSort, setStatusSort] = useState<'none' | 'desc' | 'asc'>('none');
  const [stageFilterOpen, setStageFilterOpen] = useState(false);

  const stageOptions = useMemo(() => {
    const source = props.search.trim()
      ? props.demands.filter((demand) => matchesDemandSearch(demand, props.search))
      : props.demands;
    const options = new Map<string, { key: string; label: string }>();

    for (const demand of source) {
      const key = String(demand.stageKey || 'unclassified');
      const label = String(demand.stage || getStage(key)?.label || 'Etapa não classificada');
      const current = options.get(key);
      if (!current || label.length > current.label.length) options.set(key, { key, label });
    }

    return [...options.values()].sort((a, b) => {
      const aIndex = getStageIndex(a.key);
      const bIndex = getStageIndex(b.key);
      if (aIndex !== bIndex) return (aIndex < 0 ? 999 : aIndex) - (bIndex < 0 ? 999 : bIndex);
      return a.label.localeCompare(b.label, 'pt-BR', { sensitivity: 'base' });
    });
  }, [props.demands, props.search]);

  const filtered = useMemo(() => {
    return props.demands
      .filter((d) => !props.stageFilters.length || props.stageFilters.includes(String(d.stageKey || 'unclassified')))
      .filter((d) => props.sector === 'all' || d.sector === props.sector)
      .filter((d) =>
        props.statusFilter === 'all'
        || (props.statusFilter === 'on_hold' ? d.onHold === true : effectiveStatus(d) === props.statusFilter)
      )
      .filter((d) => !props.priorityOnly || d.priority === 'critical' || d.priority === 'high')
      .filter((d) => !props.lateOnly || effectiveStatus(d) === 'late')
      .filter((d) => matchesDemandSearch(d, props.search))
      .sort((a, b) => priorityWeight[b.priority] - priorityWeight[a.priority] || new Date(a.enteredAt).getTime() - new Date(b.enteredAt).getTime());
  }, [props.demands, props.stageFilters, props.sector, props.statusFilter, props.priorityOnly, props.lateOnly, props.search]);

  const searchScopeGroups = useMemo(() => {
    const source = props.search.trim()
      ? props.demands.filter((demand) => matchesDemandSearch(demand, props.search))
      : props.demands;
    return groupDemandsByBsp(source);
  }, [props.demands, props.search]);
  const selectedBspLabel = props.search.trim()
    ? searchScopeGroups.length === 1
      ? 'BSP ' + searchScopeGroups[0].bsp
      : searchScopeGroups.length + ' BSPs encontradas'
    : 'Todas as BSPs';
  const stageFilterSummary = props.stageFilters.length === 0
    ? 'Todas as etapas'
    : props.stageFilters.length === 1
      ? '1 etapa selecionada'
      : props.stageFilters.length + ' etapas selecionadas';

  useEffect(() => {
    const validStageKeys = new Set(stageOptions.map((option) => option.key));
    const nextStageFilters = props.stageFilters.filter((key) => validStageKeys.has(key));
    if (nextStageFilters.length !== props.stageFilters.length) props.setStageFilters(nextStageFilters);
  }, [props.stageFilters, props.setStageFilters, stageOptions]);

  const grouped = useMemo(() => {
    const groups = groupDemandsByBsp(filtered);

    if (statusSort !== 'none') {
      return [...groups].sort((a, b) => {
        const statusRank = (group: BspGroup) => {
          if (group.demands.some((d) => d.onHold === true)) return 7;
          const rank: Record<DemandStatus, number> = {
            blocked: 6,
            late: 5,
            waiting: 4,
            in_progress: 3,
            new: 2,
            completed: 1,
          };
          return rank[groupStatus(group.demands)] ?? 0;
        };

        const diff = statusRank(a) - statusRank(b);
        if (diff !== 0) return statusSort === 'asc' ? diff : -diff;
        return a.bsp.localeCompare(b.bsp, 'pt-BR', { numeric: true, sensitivity: 'base' });
      });
    }

    if (progressSort !== 'none') {
      return [...groups].sort((a, b) => {
        const progressDiff = groupProgress(a.demands) - groupProgress(b.demands);
        if (progressDiff !== 0) {
          return progressSort === 'asc' ? progressDiff : -progressDiff;
        }
        return a.bsp.localeCompare(b.bsp, 'pt-BR', { numeric: true, sensitivity: 'base' });
      });
    }

    return groups;
  }, [filtered, progressSort, statusSort]);

  const exportRows = useMemo(() => grouped.flatMap((group) => group.demands), [grouped]);

  const totalByGroup = useMemo(() => {
    const map = new Map<string, number>();
    for (const group of groupDemandsByBsp(props.demands)) {
      map.set(group.key, group.demands.length);
    }
    return map;
  }, [props.demands]);

  const linkedTotalForVisibleGroups = grouped.reduce(
    (sum, group) => sum + (totalByGroup.get(group.key) ?? group.demands.length),
    0,
  );

  const current = props.sector === 'all' ? props.demands : props.demands.filter((d) => d.sector === props.sector);
  const currentGroups = groupDemandsByBsp(current);
  const active = current.filter((d) => d.status !== 'completed');
  const activeGroups = currentGroups.filter((group) => group.demands.some((d) => d.status !== 'completed'));
  const late = currentGroups.filter((group) => group.demands.some((d) => effectiveStatus(d) === 'late')).length;
  const onHold = currentGroups.filter((group) => group.demands.some((d) => d.onHold === true)).length;
  const avg = active.length ? Math.round(active.reduce((sum, d) => sum + d.progress, 0) / active.length) : 0;
  const incoming = props.sector === 'all'
    ? new Set(active.map((d) => d.sector)).size
    : props.demands.filter((d) => d.status !== 'completed' && d.sector !== props.sector && getNextStage(d.stageKey)?.sector === props.sector).length;

  return (
    <>
      <section className="portfolio-head">
        <div>
          <span className="eyebrow">Portal operacional</span>
          <h1>Carteira de Demandas</h1>
          <p>Demandas alocadas ao setor, com avanço, responsável, histórico e arquivo operacional de cada BSP / ISO.</p>
        </div>
        <div className="head-actions">
          <div className="db-sync-state">
            <span className="sync-chip"><i /> {props.liveData ? 'Banco operacional · leitura' : 'Ambiente isolado'}</span>
            {props.liveData && <small>{props.lastSyncAt ? 'Última atualização: ' + fmtDate(props.lastSyncAt) : 'Aguardando primeira sincronização'}</small>}
          </div>
          <button className="soft-btn" onClick={props.onReset} disabled={props.syncing}>
            <RefreshCcw size={15} className={props.syncing ? 'spin' : ''} />
            {props.syncing ? 'Atualizando banco...' : props.liveData ? 'Atualizar dados' : 'Restaurar demo'}
          </button>
        </div>
      </section>

      {props.error && <div className="reference-warning"><AlertTriangle size={17} /><div><strong>Falha na leitura do hub</strong><p>{props.error}</p></div></div>}

      <section className="overview-strip">
        <div className="overview-icon"><BarChart3 size={25} /></div>
        <div className="overview-copy">
          <strong>{props.sector === 'all' ? 'Visão geral da carteira · Todos os setores' : 'Visão geral da caixa · ' + sectorName(props.sector)}</strong>
          <span>{props.sector === 'all' ? 'Veja onde cada BSP / ISO está no fluxo operacional completo.' : 'Responsabilidade atual do setor e carga prevista pelo fluxo.'}</span>
        </div>
        <Metric
          value={props.sector === 'all' ? currentGroups.length : activeGroups.length}
          label={props.sector === 'all' ? 'BSPs no Tracking' : 'BSPs na caixa'}
        />
        <Metric value={late} label="Atrasadas" danger={late > 0} />
        <Metric value={onHold} label="On Hold" warning={onHold > 0} />
        <Metric value={avg + '%'} label="Avanço médio" />
        <Metric value={incoming} label={props.sector === 'all' ? 'Setores ativos' : 'Próximas'} />
      </section>

      <section className="portfolio-title-row">
        <div>
          <span className="eyebrow">Sua operação</span>
          <h2>Demandas alocadas</h2>
          <p>{grouped.length} BSP(s) · {filtered.length} ISO/SPL(s) · {props.sector === 'all' ? 'carteira completa por etapa atual; ' : ''}expanda a BSP para visualizar a árvore de itens.</p>
        </div>
        <div className="mode-toggle">
          <button className={props.mode === 'table' ? 'active' : ''} onClick={() => props.setMode('table')}><List size={14} /> Tabela</button>
          <button className={props.mode === 'board' ? 'active' : ''} onClick={() => props.setMode('board')}><LayoutGrid size={14} /> Quadros</button>
        </div>
      </section>

      <section className="filters-bar">
        <label className="filter-field search-field">
          <Search size={15} />
          <input
            value={props.search}
            onChange={(e) => props.setSearch(e.target.value)}
            placeholder="BSP / ISO / SPL / STR / SUP: 25-481-STR-001 ou 25481STR001..."
          />
          {props.search && <button type="button" className="search-clear" onClick={() => props.setSearch('')}>Limpar</button>}
        </label>
        <div className="filter-field select-filter stage-filter-control">
          <span>Etapas</span>
          <button
            type="button"
            className="filter-trigger"
            aria-expanded={stageFilterOpen}
            onClick={() => setStageFilterOpen((open) => !open)}
            title="Pesquise uma BSP no campo de busca e selecione uma ou mais etapas"
          >
            <span>{stageFilterSummary}</span>
            <ChevronDown size={14} />
          </button>
          {stageFilterOpen && (
            <div className="stage-filter-menu">
              <div className="stage-filter-menu-head">
                <div>
                  <strong>{selectedBspLabel}</strong>
                  <small>{props.search.trim() ? 'Etapas da busca atual' : 'Digite uma BSP no campo de busca'}</small>
                </div>
                {props.stageFilters.length > 0 && (
                  <button type="button" onClick={() => props.setStageFilters([])}>Limpar</button>
                )}
              </div>
              <div className="stage-filter-options">
                {stageOptions.length ? stageOptions.map((option) => (
                  <label key={option.key} className="stage-filter-option">
                    <input
                      type="checkbox"
                      checked={props.stageFilters.includes(option.key)}
                      onChange={(event) => {
                        props.setStageFilters(event.target.checked
                          ? [...props.stageFilters, option.key]
                          : props.stageFilters.filter((key) => key !== option.key));
                      }}
                    />
                    <span>{option.label}</span>
                  </label>
                )) : (
                  <small className="stage-filter-empty">Nenhuma etapa disponível para esta BSP.</small>
                )}
              </div>
            </div>
          )}
        </div>
        <label className="filter-field select-filter sector-filter">
          <span>Setor</span>
          <select value={props.sector} onChange={(e) => props.setSector(e.target.value as SectorFilter)}>
            <option value="all">Todos os setores</option>
            {sectors.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
          </select>
        </label>
        <label className="filter-field select-filter status-filter">
          <span>Status</span>
          <select value={props.statusFilter} onChange={(e) => props.setStatusFilter(e.target.value as PortfolioStatusFilter)}>
            <option value="all">Todos</option>
            <option value="new">Novas</option>
            <option value="in_progress">Em execução</option>
            <option value="on_hold">On Hold</option>
            <option value="blocked">Bloqueadas</option>
            <option value="late">Atrasadas</option>
            <option value="completed">Concluídas</option>
          </select>
        </label>
        <button className={'flag-filter late-filter ' + (props.lateOnly ? 'active danger' : '')} onClick={() => props.setLateOnly(!props.lateOnly)}><AlertTriangle size={14} /> Só atrasadas</button>
        <button className={'flag-filter priority-filter ' + (props.priorityOnly ? 'active' : '')} onClick={() => props.setPriorityOnly(!props.priorityOnly)}><CircleDot size={14} /> Prioridade</button>
        <button
          className="portfolio-export-button"
          type="button"
          onClick={() => downloadPortfolioExcel(exportRows)}
          disabled={!exportRows.length}
          title="Baixar somente os itens que correspondem aos filtros atuais"
        >
          <FileSpreadsheet size={15} /> <span>Exportar Excel</span><b>{exportRows.length}</b>
        </button>
        {props.search && <div className="search-feedback">
          <strong>{grouped.length}</strong> BSP(s) encontrada(s) para <span>“{props.search}”</span>
          {linkedTotalForVisibleGroups > filtered.length && <em>{filtered.length} item(ns) visível(is) de {linkedTotalForVisibleGroups} vinculado(s)</em>}
        </div>}
      </section>

      {props.mode === 'table' ? (
        <div className="demand-table">
          <div className="table-head">
            <span>BSP / ISO</span>
            <span>Projeto / Cliente</span>
            <span>Etapa atual</span>
            <span>Peso / m²</span>
            <button
              type="button"
              className={'table-sort-button ' + (progressSort !== 'none' ? 'active' : '')}
              onClick={() => {
                setProgressSort((current) => current === 'desc' ? 'asc' : 'desc');
                setStatusSort('none');
              }}
              aria-label={progressSort === 'asc' ? 'Ordenar avanço do maior para o menor' : 'Ordenar avanço do menor para o maior'}
              title={progressSort === 'asc' ? 'Menor → maior. Clique para inverter.' : progressSort === 'desc' ? 'Maior → menor. Clique para inverter.' : 'Ordenar por avanço'}
            >
              <span>Avanço</span>
              {progressSort === 'desc' ? <ArrowDown size={12} /> : progressSort === 'asc' ? <ArrowUp size={12} /> : <ArrowUpDown size={12} />}
            </button>
            <button
              type="button"
              className={'table-sort-button ' + (statusSort !== 'none' ? 'active' : '')}
              onClick={() => {
                setStatusSort((current) => current === 'desc' ? 'asc' : 'desc');
                setProgressSort('none');
              }}
              aria-label={statusSort === 'asc' ? 'Inverter ordenação por status' : 'Ordenar por status operacional'}
              title={statusSort === 'asc'
                ? 'Concluído → On Hold. Clique para inverter.'
                : statusSort === 'desc'
                  ? 'On Hold → Concluído. Clique para inverter.'
                  : 'Ordenar por status'}
            >
              <span>Status</span>
              {statusSort === 'desc' ? <ArrowDown size={12} /> : statusSort === 'asc' ? <ArrowUp size={12} /> : <ArrowUpDown size={12} />}
            </button>
            <span />
          </div>
          {grouped.map((group) => (
            <BspTreeRow
              key={group.key}
              group={group}
              totalCount={totalByGroup.get(group.key) ?? group.demands.length}
              expanded={props.expandedId === group.key}
              onToggle={() => props.setExpandedId(props.expandedId === group.key ? null : group.key)}
              onOpen={props.onOpen}
            />
          ))}
          {!grouped.length && <div className="empty-reference">{props.loading ? <RefreshCcw size={28} /> : <CheckCircle2 size={28} />}<strong>{props.loading ? 'Sincronizando dados reais...' : 'Nenhuma demanda nesta visão.'}</strong><span>{props.loading ? 'Consultando o hub operacional.' : 'Altere os filtros ou selecione outro setor.'}</span></div>}
        </div>
      ) : (
        <BoardMode demands={filtered} onOpen={props.onOpen} />
      )}
    </>
  );
}

function Metric({ value, label, danger, warning }: { value: string | number; label: string; danger?: boolean; warning?: boolean }) {
  return <div className="overview-metric"><strong className={danger ? 'danger' : warning ? 'warning' : ''}>{value}</strong><span>{label}</span></div>;
}

function BspTreeRow({
  group,
  totalCount,
  expanded,
  onToggle,
  onOpen,
}: {
  group: BspGroup;
  totalCount: number;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
}) {
  const first = group.demands[0];
  const status = groupStatus(group.demands);
  const groupOnHold = group.demands.some((d) => d.onHold === true);
  const priority = groupPriority(group.demands);
  const progress = groupProgress(group.demands);
  const stageLabel = groupStageLabel(group.demands);
  const sectorLabel = groupSectorLabel(group.demands);
  const groupWeightKg = sumDemandMeasure(group.demands, 'weightKg');
  const groupM2 = sumDemandMeasure(group.demands, 'm2');
  const differentStages = new Set(group.demands.map((d) => d.stage)).size > 1;

  return (
    <article className={'reference-row bsp-tree-row ' + (expanded ? 'expanded' : '')}>
      <button className="row-main bsp-parent-row" onClick={onToggle}>
        <div className="bsp-cell">
          <div className="bsp-orb">BSP</div>
          <div>
            <strong>{group.bsp}</strong>
            <span>
              {totalCount > group.demands.length
                ? group.demands.length + ' visíveis de ' + totalCount + ' ISO/SPL vinculados'
                : group.demands.length + ' ISO/SPL ' + (group.demands.length === 1 ? 'vinculado' : 'vinculados')}
            </span>
          </div>
        </div>
        <div className="project-cell">
          <strong>{first?.project ?? 'Projeto'}</strong>
          <span>{first?.client ?? 'Cliente'}</span>
        </div>
        <div className="stage-ref">
          <strong>{stageLabel}</strong>
          <span>{differentStages ? 'Itens distribuídos em ' + sectorLabel : sectorLabel}</span>
        </div>
        <div className="measure-ref">
          <strong>{formatMeasure(groupWeightKg, 'kg')}</strong>
          <span>{formatMeasure(groupM2, 'm²')}</span>
        </div>
        <div className="progress-ref">
          <strong>{progress}%</strong>
          <div><i style={{ width: progress + '%' }} /></div>
        </div>
        <div><StatusPill status={status} onHold={groupOnHold} /><PriorityPill priority={priority} /></div>
        <ChevronDown className={expanded ? 'rotate' : ''} size={17} />
      </button>

      {expanded && (
        <div className="bsp-tree-children">
          <div className="bsp-tree-heading">
            <span>Árvore da BSP</span>
            <strong>{totalCount > group.demands.length ? group.demands.length + ' de ' + totalCount + ' ISO/SPL' : group.demands.length + ' ISO/SPL'}</strong>
          </div>
          {group.demands.map((demand, index) => {
            const childStatus = effectiveStatus(demand);
            return (
              <div className="bsp-child-row" key={demand.id}>
                <div className="tree-rail" aria-hidden="true">
                  <i className={index === group.demands.length - 1 ? 'last' : ''} />
                  <b />
                </div>
                <button className="bsp-child-main" onClick={() => onOpen(demand.id)}>
                  <div className="bsp-child-iso">
                    <span>ISO / SPL</span>
                    <strong>{demand.iso}</strong>
                  </div>
                  <div className="stage-ref">
                    <strong>{demand.stage}</strong>
                    <span>{demand.archived ? (demand.archiveSource || 'Arquivo OLD') + ' · histórico' : sectorName(demand.sector)}</span>
                  </div>
                  <div className="measure-ref">
                    <strong>{formatMeasure(demand.weightKg, 'kg')}</strong>
                    <span>{formatMeasure(demand.m2, 'm²')}</span>
                  </div>
                  <div className="progress-ref">
                    <strong>{demand.progress}%</strong>
                    <div><i style={{ width: demand.progress + '%' }} /></div>
                  </div>
                  <div className="bsp-child-status">
                    <StatusPill status={childStatus} onHold={demand.onHold === true} />
                    <PriorityPill priority={demand.priority} />
                  </div>
                  <span className="open-child">Abrir arquivo <ChevronRight size={14} /></span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

function BoardMode({ demands, onOpen }: { demands: Demand[]; onOpen: (id: string) => void }) {
  const bspGroups = groupDemandsByBsp(demands);

  return (
    <div className="board-reference">
      <section>
        <div className="board-group-head">
          <strong>BSPs</strong><i /><span>{bspGroups.length} BSP(s) · {demands.length} ISO/SPL(s)</span>
        </div>
        <div className="board-grid">
          {bspGroups.map((group) => {
            const first = group.demands[0];
            const progress = groupProgress(group.demands);
            return (
              <button key={group.key} className="board-card" onClick={() => first && onOpen(first.id)}>
                <div><strong>{group.bsp}</strong><span>{group.demands.length} ISO/SPL</span></div>
                <h3>{groupStageLabel(group.demands)}</h3>
                <p>{first?.project} · {first?.client}</p>
                <div className="board-progress"><i style={{ width: progress + '%' }} /></div>
                <footer><StatusPill status={groupStatus(group.demands)} onHold={group.demands.some((d) => d.onHold === true)} /><span>{progress}%</span></footer>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}


function shippingStatusLabel(status?: HubGoalfyShipping['summary']['shipping_status']) {
  switch (status) {
    case 'complete': return 'Enviado';
    case 'partial': return 'Enviado parcialmente';
    case 'shipping_evidence': return 'Enviado · cobertura pendente';
    case 'ready': return 'Pronta para envio';
    case 'processing': return 'Em processo';
    case 'no_dn': return 'Sem DN';
    default: return 'Sem leitura';
  }
}

function shippingScopeLabel(scope?: string | null) {
  if (scope === 'spool') return 'Spool';
  if (scope === 'loose') return 'Loose Material';
  if (scope === 'mixed') return 'Spool + Loose';
  if (scope === 'other') return 'Outros materiais';
  return 'Não classificado';
}

function GoalfyShippingPanel(props: {
  shipping: HubGoalfyShipping | null;
  connection: HubGoalfyConnectionStatus | null;
  loading: boolean;
  syncing: boolean;
  onRefresh: () => void;
  onSaveConnection: (input: { accessToken?: string; reportId?: string | null; apiKey?: string }) => Promise<string | null>;
}) {
  const summary = props.shipping?.summary;
  const dns = props.shipping?.dns ?? [];
  const sync = props.shipping?.sync;
  const coverage = summary?.coverage_percent;
  const syncError = sync?.status === 'error' ? sync.last_error : null;
  const tokenRejected = Boolean(syncError && /401|Unauthorized/i.test(syncError));
  const [showSetup, setShowSetup] = useState(false);
  const [accessToken, setAccessToken] = useState('');
  const [reportId, setReportId] = useState(props.connection?.report_id || '');
  const [apiKey, setApiKey] = useState('');
  const [savingConnection, setSavingConnection] = useState(false);
  const [setupError, setSetupError] = useState('');

  useEffect(() => {
    setReportId(props.connection?.report_id || '');
  }, [props.connection?.report_id]);

  const connectionLabel = props.connection?.preferred_mode === 'report_external'
    ? 'Relatório conectado'
    : props.connection?.preferred_mode === 'cards_api'
      ? tokenRejected ? 'Token rejeitado' : 'Token salvo'
      : 'Conexão pendente';

  async function saveConnection() {
    if (savingConnection) return;

    const hasNewReportPair = Boolean(reportId.trim() && apiKey.trim());
    const hasExistingReportPair = Boolean(reportId.trim() && props.connection?.has_api_key);
    const hasToken = Boolean(accessToken.trim() || props.connection?.has_access_token);

    if (!hasNewReportPair && !hasExistingReportPair && !hasToken) {
      setSetupError('Informe um Token de acesso ou o Report ID com a API Key.');
      return;
    }

    setSavingConnection(true);
    setSetupError('');
    const error = await props.onSaveConnection({
      accessToken: accessToken.trim() || undefined,
      reportId: reportId.trim(),
      apiKey: apiKey.trim() || undefined,
    });
    setSavingConnection(false);

    if (error) {
      setSetupError(error);
      return;
    }

    setAccessToken('');
    setApiKey('');
    setShowSetup(false);
  }

  return (
    <div className="section-card goalfy-shipping-card">
      <div className="section-card-head goalfy-shipping-head">
        <div>
          <span className="section-mono">Logística / Expedição</span>
          <h2>Delivery Notes · Goalfy</h2>
          <p className="goalfy-subtitle">Leitura independente para validar envio parcial ou completo. Não altera o avanço operacional.</p>
        </div>
        <div className="goalfy-head-actions">
          <span className={'goalfy-connection ' + (props.connection?.preferred_mode || 'not_configured')}>
            <i />
            {connectionLabel}
          </span>
          <span className={'goalfy-status ' + (summary?.shipping_status || 'no_dn')}>
            {shippingStatusLabel(summary?.shipping_status)}
          </span>
          <button className="soft-btn" onClick={() => setShowSetup((value) => !value)}>
            <LockKeyhole size={14} />
            Conexão
          </button>
          <button
            className="soft-btn"
            onClick={props.onRefresh}
            disabled={props.syncing || props.connection?.preferred_mode === 'not_configured'}
            title={props.connection?.preferred_mode === 'not_configured' ? 'Configure a conexão Goalfy antes de sincronizar.' : undefined}
          >
            <RefreshCcw size={14} className={props.syncing ? 'spin' : ''} />
            {props.syncing ? 'Atualizando...' : 'Atualizar Goalfy'}
          </button>
        </div>
      </div>

      {showSetup && (
        <div className="goalfy-setup">
          <div className="goalfy-setup-head">
            <div>
              <strong>Conexão segura com o Goalfy</strong>
              <span>As credenciais são gravadas no Vault do Supabase e nunca são exibidas novamente no navegador.</span>
            </div>
            <button type="button" onClick={() => setShowSetup(false)} aria-label="Fechar configuração">×</button>
          </div>

          <div className="goalfy-setup-mode recommended">
            <div>
              <span>RECOMENDADO</span>
              <strong>Relatório oficial + API Key</strong>
              <small>Mais estável para sincronizar todas as DNs e campos do board em lote.</small>
            </div>
            <div className="goalfy-setup-fields">
              <label>
                <span>Report ID</span>
                <input
                  value={reportId}
                  onChange={(event) => setReportId(event.target.value)}
                  placeholder="ID do relatório Goalfy"
                  autoComplete="off"
                />
              </label>
              <label>
                <span>API Key</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={props.connection?.has_api_key ? 'API Key já armazenada · deixe vazio para manter' : 'API Key do Goalfy'}
                  autoComplete="new-password"
                />
              </label>
            </div>
          </div>

          <div className="goalfy-setup-divider"><span>ou</span></div>

          <div className="goalfy-setup-mode">
            <div>
              <strong>Token de acesso</strong>
              <small>Fallback para leitura direta da API quando o token tiver permissão para os cards.</small>
            </div>
            <label>
              <span>Access Token</span>
              <input
                type="password"
                value={accessToken}
                onChange={(event) => setAccessToken(event.target.value)}
                placeholder={props.connection?.has_access_token ? 'Token já armazenado · deixe vazio para manter' : 'Token Goalfy'}
                autoComplete="new-password"
              />
            </label>
          </div>

          <div className="goalfy-setup-status">
            <span>Board</span><strong>{props.connection?.board_id || 'Não configurado'}</strong>
            <span>Token</span><strong>{props.connection?.has_access_token ? 'Armazenado' : 'Não informado'}</strong>
            <span>Relatório</span><strong>{props.connection?.report_id || 'Não informado'}</strong>
            <span>API Key</span><strong>{props.connection?.has_api_key ? 'Armazenada' : 'Não informada'}</strong>
          </div>

          {setupError && <div className="goalfy-setup-error"><AlertTriangle size={14} />{setupError}</div>}

          <div className="goalfy-setup-actions">
            <button className="soft-btn" type="button" onClick={() => setShowSetup(false)}>Cancelar</button>
            <button className="success-ref" type="button" onClick={() => void saveConnection()} disabled={savingConnection}>
              {savingConnection ? <RefreshCcw size={14} className="spin" /> : <ShieldCheck size={14} />}
              {savingConnection ? 'Salvando...' : 'Salvar conexão'}
            </button>
          </div>
        </div>
      )}

      {props.loading ? (
        <div className="goalfy-empty"><RefreshCcw size={18} className="spin" /><span>Carregando expedição da BSP...</span></div>
      ) : (
        <>
          <div className="goalfy-kpis">
            <div><span>DNs encontradas</span><strong>{summary?.dn_count ?? 0}</strong></div>
            <div><span>Expedidas</span><strong>{summary?.shipped_dn_count ?? 0}</strong></div>
            <div><span>Prontas</span><strong>{summary?.ready_dn_count ?? 0}</strong></div>
            <div>
              <span>Cobertura FCB</span>
              <strong>{coverage == null ? '—' : coverage.toFixed(1) + '%'}</strong>
              <small>{summary?.expected_item_count ? (summary.matched_expected_item_count + ' de ' + summary.expected_item_count + ' itens') : 'FCB técnico ainda não disponível'}</small>
            </div>
          </div>

          {syncError && (
            <div className="goalfy-warning">
              <AlertTriangle size={17} />
              <div>
                <strong>{tokenRejected ? 'Credencial Goalfy rejeitada' : 'Goalfy ainda não sincronizado'}</strong>
                <p>{tokenRejected
                  ? 'O token está salvo com segurança, mas expirou ou foi revogado pelo Goalfy. Gere um token novo e substitua-o na Conexão.'
                  : syncError}</p>
                <span>{tokenRejected
                  ? 'O acesso direto por API continua configurado; nenhum Report ID é obrigatório quando o token de cards estiver válido.'
                  : 'A integração está isolada e este erro não afeta Carteira, Produção ou Tracking.'}</span>
              </div>
            </div>
          )}

          {!syncError && !dns.length && (
            <div className="goalfy-empty">
              <Boxes size={18} />
              <div>
                <strong>Nenhuma DN sincronizada para esta BSP.</strong>
                <span>{props.connection?.preferred_mode === 'not_configured'
                  ? 'Configure a conexão Goalfy acima para iniciar a primeira sincronização.'
                  : sync?.status === 'never'
                    ? 'A fonte Goalfy ainda não executou a primeira sincronização.'
                    : 'Não há evidência de DN vinculada a esta BSP na última leitura.'}</span>
              </div>
            </div>
          )}

          {!!dns.length && (
            <div className="goalfy-dn-list">
              {dns.map((dn) => {
                const items = dn.items ?? [];
                const history = dn.phase_history ?? [];
                return (
                  <article className="goalfy-dn" key={dn.card_id}>
                    <header>
                      <div>
                        <span>DN</span>
                        <strong>{dn.dn_number || dn.card_title || 'Sem número'}</strong>
                        <small>{shippingScopeLabel(dn.material_scope)}</small>
                      </div>
                      <span className={'goalfy-dn-phase ' + (dn.is_shipped ? 'shipped' : dn.is_ready ? 'ready' : 'open')}>
                        {dn.phase_name || 'Fase não informada'}
                      </span>
                    </header>

                    <div className="goalfy-dn-grid">
                      <div><span>Destino</span><strong>{dn.destination || '—'}</strong></div>
                      <div><span>DN para</span><strong>{dn.dn_for || '—'}</strong></div>
                      <div><span>PO</span><strong>{dn.po_number || '—'}</strong></div>
                      <div><span>NF</span><strong>{dn.invoice_number || '—'}</strong></div>
                      <div><span>Expedição</span><strong>{dn.shipped_at ? fmtDate(dn.shipped_at) : dn.is_ready ? 'Aguardando saída' : 'Não expedida'}</strong></div>
                      <div><span>Itens vinculados</span><strong>{items.length || '—'}</strong></div>
                    </div>

                    {(dn.tags?.length ?? 0) > 0 && (
                      <div className="goalfy-tags">{dn.tags!.map((tag) => <span key={tag}>{tag}</span>)}</div>
                    )}

                    {!!items.length && (
                      <div className="goalfy-items">
                        {items.slice(0, 8).map((item) => (
                          <span key={item.id ?? item.item_key}>{item.item_label || item.item_key}</span>
                        ))}
                        {items.length > 8 && <em>+{items.length - 8} item(ns)</em>}
                      </div>
                    )}

                    {!!history.length && (
                      <div className="goalfy-history">
                        {[...history].slice(-5).map((step) => (
                          <div key={(step.id ?? step.phase_name) + ':' + (step.entered_at || '')}>
                            <i />
                            <span>{step.phase_name}</span>
                            <small>{step.entered_at ? fmtDate(step.entered_at) : '—'}</small>
                          </div>
                        ))}
                      </div>
                    )}

                    {dn.invoice_url && (
                      <footer>
                        <a href={dn.invoice_url} target="_blank" rel="noreferrer">Abrir documento / NF</a>
                      </footer>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GoalfyShippingSide({ shipping, loading }: { shipping: HubGoalfyShipping | null; loading: boolean }) {
  const summary = shipping?.summary;
  const sync = shipping?.sync;

  return (
    <div className="side-section goalfy-side">
      <span className="section-mono">Expedição · Goalfy</span>
      {loading ? (
        <p className="muted-side">Carregando DNs...</p>
      ) : (
        <div className="data-list">
          <div><span>Status</span><strong>{shippingStatusLabel(summary?.shipping_status)}</strong></div>
          <div><span>DNs</span><strong>{summary?.dn_count ?? 0}</strong></div>
          <div><span>Expedidas</span><strong>{summary?.shipped_dn_count ?? 0}</strong></div>
          <div><span>Prontas</span><strong>{summary?.ready_dn_count ?? 0}</strong></div>
          <div><span>Cobertura FCB</span><strong>{summary?.coverage_percent == null ? '—' : summary.coverage_percent.toFixed(1) + '%'}</strong></div>
          <div><span>Última expedição</span><strong>{summary?.latest_shipped_at ? fmtDate(summary.latest_shipped_at) : '—'}</strong></div>
          <div><span>Último sync</span><strong>{sync?.last_success_at ? fmtDate(sync.last_success_at) : sync?.status === 'error' ? 'Com erro' : '—'}</strong></div>
        </div>
      )}
      <div className="goalfy-readonly-note">Atualiza automaticamente o status de expedição neste painel; não altera o progresso operacional do Tracking.</div>
    </div>
  );
}

function DemandDetail(props: {
  demand: Demand;
  onBack: () => void;
  onAssume: (stageKey?: string) => void;
  onProgress: (progress: number, stageKey?: string) => void;
  onWait: (stageKey?: string) => void;
  onResume: (stageKey?: string) => void;
  onBlock: (stageKey?: string) => void;
  onEvidence: (type: EvidenceType, file?: File) => void | Promise<void>;
  onComplete: (stageKey?: string) => void | Promise<void>;
  hubDetail: Awaited<ReturnType<typeof loadHubProject>> | null;
  hhEvidence: HubHHEvidence | null;
  stageEvidence: HubStageEvidence | null;
  goalfyShipping: HubGoalfyShipping | null;
  goalfyConnection: HubGoalfyConnectionStatus | null;
  goalfyLoading: boolean;
  goalfySyncing: boolean;
  onRefreshGoalfy: () => void;
  onSaveGoalfyConnection: (input: { accessToken?: string; reportId?: string | null; apiKey?: string }) => Promise<string | null>;
  detailLoading: boolean;
  evidenceLoading: boolean;
  onRefreshProject: () => Promise<void>;
}) {
  const { demand } = props;
  const status = effectiveStatus(demand);
  const currentIndex = getStageIndex(demand.stageKey);
  const [phaseKey, setPhaseKey] = useState(demand.stageKey);
  const [photoModalIndex, setPhotoModalIndex] = useState<number | null>(null);
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [advanceProgress, setAdvanceProgress] = useState(25);
  const [completeConfirmOpen, setCompleteConfirmOpen] = useState(false);
  const [completeSubmitting, setCompleteSubmitting] = useState(false);
  const startPhotoInput = useRef<HTMLInputElement>(null);
  const finishPhotoInput = useRef<HTMLInputElement>(null);
  const fallbackPhase = {
    key: demand.stageKey || 'unclassified',
    label: demand.stage || 'Etapa não classificada',
    sector: demand.sector,
    slaMinutes: 0,
    photoPolicy: 'none' as const,
    usesPointing: false,
  };
  const phase = getStage(phaseKey) ?? getStage(demand.stageKey) ?? fallbackPhase;
  const phaseIndex = getStageIndex(phase.key);
  const isCurrent = phase.key === demand.stageKey;
  const phaseProgress = demand.stageProgress?.[phase.key] ?? (isCurrent ? demand.progress : 0);
  const phaseStatus = (demand.stageStatuses?.[phase.key] as DemandStatus | undefined) || (isCurrent ? demand.status : 'new');
  const phaseCompleted = phaseStatus === 'completed' || phaseProgress >= 100;
  const next = getNextStage(demand.stageKey);
  const hhPhotos = props.hhEvidence?.photos ?? [];
  const panelPhotos = props.stageEvidence?.photos ?? [];
  const panelStartPhotos = panelPhotos.filter((photo) => photo.photo_type === 'start');
  const panelFinishPhotos = panelPhotos.filter((photo) => photo.photo_type === 'finish');
  const panelExtraPhotos = panelPhotos.filter((photo) => photo.photo_type === 'extra');
  const hhStartPhotos = hhPhotos.filter((photo) => photoMoment(photo) === 'start');
  const hhFinishPhotos = hhPhotos.filter((photo) => photoMoment(photo) === 'finish');
  const hhExtraPhotos = hhPhotos.filter((photo) => photoMoment(photo) === 'extra');
  const demandStartPhotos = demand.evidences.filter((e) => e.type === 'start').length;
  const demandFinishPhotos = demand.evidences.filter((e) => e.type === 'finish').length;
  const demandExtraPhotos = demand.evidences.filter((e) => e.type === 'extra').length;
  const sourceStartPhotos = demand.source === 'ops_core' ? panelStartPhotos : hhStartPhotos;
  const sourceFinishPhotos = demand.source === 'ops_core' ? panelFinishPhotos : hhFinishPhotos;
  const sourceExtraPhotos = demand.source === 'ops_core' ? panelExtraPhotos : hhExtraPhotos;
  const hasStart = demandStartPhotos > 0 || sourceStartPhotos.length > 0;
  const hasFinish = demandFinishPhotos > 0 || sourceFinishPhotos.length > 0;
  const totalEvidence = demand.evidences.length + hhPhotos.length + panelPhotos.length;
  const canOperate = demand.source === 'demo'
    || demand.source === 'ops_core'
    || (demand.source === 'hub_readonly' && Boolean(demand.legacyProjectRowId && demand.legacyIsoKey && demand.iso));
  const canAdvance = phaseStatus === 'in_progress' || phaseStatus === 'late' || phaseProgress === 0;
  const phaseCanOperate = canOperate && !phaseCompleted;
  const progressChoices = [25, 50, 75, 100].filter((value) => value > phaseProgress);
  const goalfyStatus = props.goalfyShipping?.summary?.shipping_status;
  const goalfySent = goalfyStatus === 'complete' || goalfyStatus === 'partial' || goalfyStatus === 'shipping_evidence';

  useEffect(() => setPhaseKey(demand.stageKey), [demand.stageKey]);

  useEffect(() => {
    if (photoModalIndex === null) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setPhotoModalIndex(null);
        return;
      }
      if (!hhPhotos.length) return;
      if (event.key === 'ArrowRight') {
        setPhotoModalIndex((current) => current === null ? null : (current + 1) % hhPhotos.length);
      }
      if (event.key === 'ArrowLeft') {
        setPhotoModalIndex((current) => current === null ? null : (current - 1 + hhPhotos.length) % hhPhotos.length);
      }
    }

    window.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKey);
    };
  }, [photoModalIndex, hhPhotos.length]);

  function openPhoto(photoId: string) {
    const index = hhPhotos.findIndex((photo) => photo.id === photoId);
    if (index >= 0) setPhotoModalIndex(index);
  }

  function selectEvidence(type: EvidenceType, input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (file) void props.onEvidence(type, file);
  }

  async function confirmCompletion() {
    if (completeSubmitting) return;
    setCompleteSubmitting(true);
    try {
      await props.onComplete(phase.key);
      setCompleteConfirmOpen(false);
    } finally {
      setCompleteSubmitting(false);
    }
  }

  return (
    <>
      <section className="detail-top">
        <button className="back-link" onClick={props.onBack}><ArrowLeft size={15} /> Voltar à carteira</button>
        <div className="detail-title-row">
          <div className="detail-bsp"><span>BSP / ISO</span><strong>{demand.bsp}</strong><em>{demand.iso}</em></div>
          <div className="detail-title-copy"><h1>{demand.project}</h1><p>{demand.client} · {sectorName(demand.sector)}</p></div>
          <StatusPill status={status} onHold={demand.onHold === true} />
          {goalfySent && <span className={'goalfy-main-status ' + goalfyStatus}><CheckCircle2 size={13} /> {shippingStatusLabel(goalfyStatus)}</span>}
          <PriorityPill priority={demand.priority} />
        </div>
        <div className="detail-summary-grid">
          <SummaryField label="Etapa atual" value={demand.stage} />
          <SummaryField label="Responsável" value={pmOwnerLabel(demand)} />
          <SummaryField label="Entrada no setor" value={fmtDate(demand.enteredAt)} />
          <SummaryField label="SLA da etapa" value={fmtDate(demand.slaDueAt)} />
          <SummaryField label="Evidências" value={props.evidenceLoading ? '...' : String(totalEvidence)} />
          <SummaryField label="Fotos da etapa" value={props.evidenceLoading ? '...' : String(totalEvidence)} />
          <SummaryField label="Expedição Goalfy" value={goalfyStatus ? shippingStatusLabel(goalfyStatus) : 'Aguardando leitura'} />
        </div>
      </section>

      <section className="phases-wrap">
        <span className="eyebrow">Fases do processo</span>
        <div className="phase-strip">
          {workflowStages.map((stage, index) => {
            const finished = status === 'completed';
            const stageOverrideProgress = demand.stageProgress?.[stage.key];
            const stageOverrideStatus = demand.stageStatuses?.[stage.key];
            const done = finished || stageOverrideStatus === 'completed' || (stageOverrideProgress != null && stageOverrideProgress >= 100) || (stageOverrideProgress == null && index < currentIndex);
            const current = !finished && index === currentIndex;
            const future = index > currentIndex;
            const pct = finished ? 100 : stageOverrideProgress != null ? stageOverrideProgress : done ? 100 : current ? demand.progress : 0;
            return (
              <button key={stage.key} className={'phase-card ' + (phaseKey === stage.key ? 'selected ' : '') + (done ? 'done' : current ? 'current' : future ? 'future' : '')} onClick={() => setPhaseKey(stage.key)}>
                <div><small>{String(index + 1).padStart(2, '0')}</small><strong>{stage.label}</strong><b>{pct}%</b></div>
                <span>{sectorName(stage.sector)} · SLA {Math.round(stage.slaMinutes / 60 * 10) / 10}h</span>
                <i><em style={{ width: pct + '%' }} /></i>
              </button>
            );
          })}
        </div>
      </section>

      <section className="detail-content">
        <div className="detail-main-column">
          <div className="section-card">
            <div className="section-card-head"><div><span className="section-mono">{isCurrent ? 'Etapa atual' : phaseIndex < currentIndex ? 'Fase concluída' : 'Fase futura'}</span><h2>{phase.label}</h2></div><span className="phase-sector">{sectorName(phase.sector)}</span></div>
            <div className="phase-data-grid">
              <SummaryField label="Política de evidência" value={photoPolicyLabel(phase.photoPolicy)} />
              <SummaryField label="Controle do avanço" value="Painel operacional" />
              <SummaryField label="SLA configurado" value={Math.round(phase.slaMinutes / 60 * 10) / 10 + ' horas'} />
              <SummaryField label="Próximo destino" value={isCurrent ? (next ? sectorName(next.sector) : 'Encerramento') : '—'} />
            </div>

            {phaseCanOperate && (
              <>
                <div className="detail-progress-block"><div><span>Avanço da etapa</span><strong>{phaseProgress}%</strong></div><div className="detail-progress"><i style={{ width: phaseProgress + '%' }} /></div></div>
                {isCurrent && demand.blocker && <div className="reference-warning"><AlertTriangle size={17} /><div><strong>Bloqueio ativo</strong><p>{demand.blocker.note}</p></div></div>}
                {isCurrent && <div className="evidence-reference">
                  <div className={hasStart ? 'ready' : ''}><ImagePlus size={16} /><span>Foto inicial</span><strong>{props.evidenceLoading ? '...' : hasStart ? demandStartPhotos + sourceStartPhotos.length + ' disponível(is)' : 'Pendente'}</strong></div>
                  <div className={hasFinish ? 'ready' : ''}><ImagePlus size={16} /><span>Foto final</span><strong>{props.evidenceLoading ? '...' : hasFinish ? demandFinishPhotos + sourceFinishPhotos.length + ' disponível(is)' : 'Pendente'}</strong></div>
                  <div><FileText size={16} /><span>Extras</span><strong>{props.evidenceLoading ? '...' : sourceExtraPhotos.length + demandExtraPhotos}</strong></div>
                </div>}

                {phaseCanOperate && (
                  <div className="detail-actions">
                    {isCurrent && demand.status === 'new' && <button className="primary-ref" onClick={() => props.onAssume(phase.key)}><UserCheck size={14} /> Assumir demanda</button>}
                    {canAdvance && <button className="primary-ref" onClick={() => { setAdvanceProgress(progressChoices[0] ?? 100); setAdvanceOpen(true); }}><Activity size={14} /> {phaseProgress === 0 ? 'Iniciar etapa' : 'Avançar etapa'}</button>}
                    {(phaseStatus === 'in_progress' || phaseStatus === 'late') && <button className="soft-btn" onClick={() => props.onWait(phase.key)}><PauseCircle size={14} /> Aguardar</button>}
                    {(phaseStatus === 'waiting' || phaseStatus === 'blocked') && <button className="soft-btn" onClick={() => props.onResume(phase.key)}><PlayCircle size={14} /> Retomar</button>}
                    {phaseStatus !== 'blocked' && <button className="danger-ref" onClick={() => props.onBlock(phase.key)}><XCircle size={14} /> Bloquear</button>}
                    {isCurrent && (demand.source === 'demo' || demand.source === 'ops_core') && !hasStart && <button className="soft-btn" onClick={() => startPhotoInput.current?.click()}><ImagePlus size={14} /> Foto início</button>}
                    {isCurrent && (demand.source === 'demo' || demand.source === 'ops_core') && !hasFinish && <button className="soft-btn" onClick={() => finishPhotoInput.current?.click()}><ImagePlus size={14} /> Foto fim</button>}
                    {(phaseStatus === 'in_progress' || phaseStatus === 'waiting' || phaseStatus === 'late' || phaseProgress > 0) && <button className="success-ref" onClick={() => setCompleteConfirmOpen(true)} disabled={completeSubmitting}><CheckCircle2 size={14} /> Concluir etapa</button>}
                    {isCurrent && (demand.source === 'demo' || demand.source === 'ops_core') && <>
                      <input ref={startPhotoInput} className="hidden-file-input" type="file" accept="image/*" onChange={(event) => selectEvidence('start', event.currentTarget)} />
                      <input ref={finishPhotoInput} className="hidden-file-input" type="file" accept="image/*" onChange={(event) => selectEvidence('finish', event.currentTarget)} />
                    </>}
                  </div>
                )}
              </>
            )}
          </div>

          {demand.source === 'hub_readonly' && (
            <HHEvidenceGallery evidence={props.hhEvidence} loading={props.evidenceLoading} onOpenPhoto={openPhoto} />
          )}

          {demand.source === 'ops_core' && (
            <StageEvidenceGallery evidence={props.stageEvidence} loading={props.evidenceLoading} />
          )}

          {demand.source === 'hub_readonly' && (
            <RealSourcesPanel detail={props.hubDetail} loading={props.detailLoading} iso={demand.iso} onRefreshProject={props.onRefreshProject} />
          )}

          {demand.source !== 'demo' && (
            <GoalfyShippingPanel
              shipping={props.goalfyShipping}
              connection={props.goalfyConnection}
              loading={props.goalfyLoading}
              syncing={props.goalfySyncing}
              onRefresh={props.onRefreshGoalfy}
              onSaveConnection={props.onSaveGoalfyConnection}
            />
          )}

          <div className="section-card">
            <div className="section-card-head"><div><span className="section-mono">Rastreabilidade</span><h2>Histórico completo da demanda</h2></div><span className="count-ref">{demand.history.length}</span></div>
            <div className="full-timeline">
              {[...demand.history].reverse().map((u) => <div key={u.id}><i /><div><strong>{u.title}</strong><p>{u.description}</p><span>{fmtDate(u.at)} · {u.actor} · {sectorName(u.sector)}</span></div></div>)}
            </div>
          </div>
        </div>

        <aside className="detail-side-column">
          <div className="side-section">
            <span className="section-mono">Últimas atualizações</span>
            {[...demand.history].reverse().slice(0, 5).map((u) => <div className="side-update" key={u.id}><i /><div><p>{u.description}</p><span>{fmtDate(u.at)} · {u.actor}</span></div></div>)}
          </div>

          <div className="side-section">
            <span className="section-mono">Dados operacionais</span>
            <div className="data-list">
              <div><span>Setor atual</span><strong>{sectorName(demand.sector)}</strong></div>
              <div><span>Origem</span><strong>{sectorName(demand.originSector)}</strong></div>
              <div><span>Próximo setor</span><strong>{next ? sectorName(next.sector) : 'Encerramento'}</strong></div>
              <div><span>Prioridade</span><strong>{priorityLabel[demand.priority]}</strong></div>
              <div><span>Fonte</span><strong>{demand.archived ? 'Tracking histórico · ' + (demand.archiveSource || 'OLD') : demand.source === 'hub_readonly' ? 'Tracking legado · avanço pelo painel' : demand.source === 'ops_core' ? 'OPS Core · operacional' : demand.source === 'hh_readonly' ? 'Fonte histórica · leitura' : 'Demonstração'}</strong></div>
            </div>
          </div>

          {demand.source !== 'demo' && (
            <GoalfyShippingSide shipping={props.goalfyShipping} loading={props.goalfyLoading} />
          )}

          <div className="side-section">
            <span className="section-mono">Evidências e anexos</span>
            <div className="docs-list">
              {demand.source === 'ops_core' && panelPhotos.slice(0, 6).map((photo) => (
                <a className="side-photo-link" href={photo.signed_url} target="_blank" rel="noreferrer" key={photo.id}>
                  <img src={photo.signed_url} alt={photo.caption || 'Foto da etapa'} loading="lazy" />
                  <div><strong>{photo.caption || (photo.photo_type === 'start' ? 'Foto inicial' : photo.photo_type === 'finish' ? 'Foto final' : 'Evidência extra')}</strong><small>{fmtDate(photo.taken_at || undefined)}{photo.uploaded_by_name ? ' · ' + photo.uploaded_by_name : ''}</small></div>
                </a>
              ))}
              {demand.source !== 'ops_core' && hhPhotos.slice(0, 6).map((photo) => (
                <button className="side-photo-link" type="button" onClick={() => openPhoto(photo.id)} key={photo.id}>
                  <img src={photo.signed_url} alt={photoLabel(photo)} loading="lazy" />
                  <div><strong>{photoStageLabel(props.hhEvidence, photo.id) || photoLabel(photo)}</strong><small>{photoLabel(photo)} · {fmtDate(photo.taken_at || undefined)}</small></div>
                </button>
              ))}
              {demand.evidences.map((e) => <div key={e.id}><span>IMG</span><div><strong>{e.label}</strong><small>{fmtDate(e.at)}</small></div></div>)}
              {!props.evidenceLoading && !hhPhotos.length && !panelPhotos.length && !demand.evidences.length && <p className="muted-side">Nenhuma evidência vinculada a este ISO/SPL.</p>}
              {props.evidenceLoading && <p className="muted-side">Buscando fotos da etapa...</p>}
            </div>
          </div>

          <div className="secure-note"><ShieldCheck size={17} /><div><strong>{demand.source === 'hub_readonly' ? 'Dados reais · avanço controlado' : demand.source === 'ops_core' ? 'Dados reais · OPS Core' : 'Ambiente isolado'}</strong><span>{demand.source === 'hub_readonly' ? 'O Tracking permanece histórico; os avanços feitos aqui ficam registrados na camada operacional do painel.' : demand.source === 'ops_core' ? 'As ações passam pela API autenticada e ficam registradas no histórico.' : 'As ações da demo não escrevem em dados reais.'}</span></div></div>
        </aside>
      </section>

      {advanceOpen && (
        <div
          className="advance-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="advance-modal-title"
          onMouseDown={(event) => { if (event.currentTarget === event.target) setAdvanceOpen(false); }}
        >
          <div className="advance-dialog">
            <header>
              <div>
                <span className="section-mono">Atualizar etapa</span>
                <h2 id="advance-modal-title">{phase.label}</h2>
                <p>{demand.bsp} · {demand.iso}</p>
              </div>
              <button className="advance-close" onClick={() => setAdvanceOpen(false)} aria-label="Fechar">×</button>
            </header>
            <div className="advance-current"><span>Avanço atual da etapa</span><strong>{phaseProgress}%</strong></div>
            <div className="advance-choices" aria-label="Escolher avanço">
              {progressChoices.length ? progressChoices.map((value) => (
                <button key={value} className={advanceProgress === value ? 'selected' : ''} onClick={() => setAdvanceProgress(value)}>
                  <strong>{value}%</strong><span>Registrar avanço</span>
                </button>
              )) : <p className="advance-empty">A etapa já está no avanço máximo permitido. Conclua a etapa quando estiver pronta.</p>}
            </div>
            <p className="advance-note"><ShieldCheck size={14} /> A ação será registrada no histórico com seu usuário e horário.</p>
            <footer>
              <button className="soft-btn" onClick={() => setAdvanceOpen(false)}>Cancelar</button>
              <button className="primary-ref" disabled={!progressChoices.length || advanceProgress <= phaseProgress} onClick={() => { setAdvanceOpen(false); props.onProgress(advanceProgress, phase.key); }}><Activity size={14} /> {advanceProgress === 100 ? 'Concluir e avançar' : 'Salvar avanço'}</button>
            </footer>
          </div>
        </div>
      )}

      {completeConfirmOpen && (
        <div
          className="advance-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="complete-modal-title"
          onMouseDown={(event) => { if (!completeSubmitting && event.currentTarget === event.target) setCompleteConfirmOpen(false); }}
        >
          <div className="advance-dialog complete-confirm-dialog">
            <header>
              <div>
                <span className="section-mono">Confirmar conclusão</span>
                <h2 id="complete-modal-title">Concluir somente esta etapa?</h2>
                <p>{demand.bsp} · {demand.iso}</p>
              </div>
              <button className="advance-close" onClick={() => setCompleteConfirmOpen(false)} disabled={completeSubmitting} aria-label="Fechar">×</button>
            </header>
            <div className="complete-confirm-warning">
              <CheckCircle2 size={18} />
              <div>
                <strong>{phase.label}</strong>
                <span>Será marcada como concluída em 100%. As próximas etapas não serão alteradas.</span>
              </div>
            </div>
            <p className="advance-note"><ShieldCheck size={14} /> Esta ação será registrada no histórico com seu usuário e horário.</p>
            <footer>
              <button className="soft-btn" onClick={() => setCompleteConfirmOpen(false)} disabled={completeSubmitting}>Cancelar</button>
              <button className="primary-ref" onClick={() => void confirmCompletion()} disabled={completeSubmitting}>
                <CheckCircle2 size={14} /> {completeSubmitting ? 'Concluindo...' : 'Sim, concluir etapa'}
              </button>
            </footer>
          </div>
        </div>
      )}

      {photoModalIndex !== null && hhPhotos[photoModalIndex] && (
        <EvidencePhotoModal
          photos={hhPhotos}
          evidence={props.hhEvidence}
          index={photoModalIndex}
          onClose={() => setPhotoModalIndex(null)}
          onPrevious={() => setPhotoModalIndex((current) => current === null ? null : (current - 1 + hhPhotos.length) % hhPhotos.length)}
          onNext={() => setPhotoModalIndex((current) => current === null ? null : (current + 1) % hhPhotos.length)}
        />
      )}
    </>
  );
}

function SummaryField({ label, value }: { label: string; value: string }) {
  return <div className="summary-field"><span>{label}</span><strong>{value}</strong></div>;
}

function StatusPill({ status, onHold = false }: { status: DemandStatus; onHold?: boolean }) {
  if (onHold) return <span className="status-ref on_hold"><i />On Hold</span>;
  return <span className={'status-ref ' + status}><i />{statusLabel[status]}</span>;
}

function PriorityPill({ priority }: { priority: Priority }) {
  return <span className={'priority-ref ' + priority}>{priorityLabel[priority]}</span>;
}

function LivePage({ demands, loading, onOpen }: { demands: Demand[]; loading: boolean; onOpen: (id: string) => void }) {
  const live = demands.filter((d) => d.status === 'in_progress' || d.status === 'waiting' || d.status === 'late');
  return <GenericPage title="Produção ao Vivo" subtitle="Etapas em execução, com avanço e evidências pelo painel."><div className="section-card"><div className="section-card-head"><div><span className="section-mono">Execução operacional</span><h2>Etapas em acompanhamento</h2></div><span className="count-ref">{loading ? '...' : live.length}</span></div><div className="simple-table"><div className="simple-head"><span>BSP / ISO</span><span>Atividade</span><span>Setor</span><span>Avanço</span><span>Evidências</span></div>{live.map((d) => <button key={d.id} onClick={() => onOpen(d.id)}><span><strong>{d.bsp}</strong><small>{d.iso}</small></span><span>{d.stage}</span><span>{sectorName(d.sector)}</span><span>{d.progress}%</span><span>{d.evidences.length}</span></button>)}</div></div></GenericPage>;
}

function BlocksPage({ demands, onOpen, onResume }: { demands: Demand[]; onOpen: (id: string) => void; onResume: (id: string) => void }) {
  const blocked = demands.filter((d) => d.status === 'blocked');
  return <GenericPage title="Bloqueios Operacionais" subtitle="Pendências que impedem a demanda de avançar para o próximo setor."><div className="section-card"><div className="simple-table"><div className="simple-head blocked-head"><span>BSP / ISO</span><span>Setor</span><span>Motivo</span><span>Desde</span><span>Ações</span></div>{blocked.map((d) => <div className="simple-block-row" key={d.id}><span><strong>{d.bsp}</strong><small>{d.iso}</small></span><span>{sectorName(d.sector)}</span><span>{d.blocker?.note ?? 'Bloqueio operacional'}</span><span>{fmtDate(d.blocker?.createdAt)}</span><span><button className="soft-btn" onClick={() => onOpen(d.id)}><Eye size={13} /> Abrir</button>{(d.source === 'demo' || d.source === 'ops_core') && <button className="success-ref" onClick={() => void onResume(d.id)}><Check size={13} /> Resolver</button>}</span></div>)}</div></div></GenericPage>;
}

function NotificationsPage({ state, setState, onOpen }: { state: OperationalState; setState: React.Dispatch<React.SetStateAction<OperationalState>>; onOpen: (id: string) => void }) {
  const items = [...state.notifications].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  async function read(id: string) {
    setState((current) => ({
      ...current,
      notifications: current.notifications.map((n) => n.id === id ? { ...n, read: true } : n),
    }));
    if (hubConfigured) {
      await markCoreNotificationRead(id).catch(() => undefined);
    }
  }

  return <GenericPage title="Notificações" subtitle="Handoffs, alertas de execução e eventos relevantes do fluxo operacional."><div className="section-card notification-reference-list">{items.map((n) => <button key={n.id} className={!n.read ? 'unread' : ''} onClick={() => { void read(n.id); if (n.demandId) onOpen(n.demandId); }}><div className={'notification-icon-ref ' + n.severity}><Bell size={15} /></div><div><strong>{n.title}</strong><p>{n.message}</p><span>{fmtDate(n.createdAt)} · {sectorName(n.sector)}</span></div>{!n.read && <i />}</button>)}</div></GenericPage>;
}

function AnalyticsPage({ demands, onOpen }: { demands: Demand[]; onOpen: (id: string) => void }) {
  const [selectedStageKey, setSelectedStageKey] = useState<string | null>(null);
  const [expandedStageBspKey, setExpandedStageBspKey] = useState<string | null>(null);
  const active = useMemo(() => demands.filter((d) => d.status !== 'completed'), [demands]);
  const completed = useMemo(() => demands.filter((d) => d.status === 'completed'), [demands]);
  const projectKey = (demand: Demand) => demand.projectGroupKey || demand.bsp || demand.id;
  const countProjects = (rows: Demand[]) => new Set(rows.map(projectKey)).size;
  const totalProjects = countProjects(demands);
  const activeProjects = countProjects(active);
  const completedProjects = countProjects(completed);
  const averageProgress = active.length
    ? Math.round(active.reduce((sum, demand) => sum + Number(demand.progress || 0), 0) / active.length)
    : 0;

  const stageGroups = useMemo(() => {
    const known = workflowStages.map((stage, index) => {
      const rows = active.filter((demand) => demand.stageKey === stage.key);
      return {
        key: stage.key,
        label: stage.label,
        sector: sectorName(stage.sector),
        index: index + 1,
        rows,
        projects: countProjects(rows),
        late: rows.filter((demand) => effectiveStatus(demand) === 'late').length,
      };
    }).filter((group) => group.rows.length > 0);

    const unclassified = active.filter((demand) => !workflowStages.some((stage) => stage.key === demand.stageKey));
    if (unclassified.length) {
      known.push({
        key: 'unclassified',
        label: 'Etapa não classificada',
        sector: 'Não classificado',
        index: known.length + 1,
        rows: unclassified,
        projects: countProjects(unclassified),
        late: unclassified.filter((demand) => effectiveStatus(demand) === 'late').length,
      });
    }
    return known;
  }, [active]);

  const selectedStage = stageGroups.find((group) => group.key === selectedStageKey) || null;
  const selectedPendingRows = selectedStage?.rows.filter((demand) => effectiveStatus(demand) !== 'completed' && !demand.archived) ?? [];
  const selectedPendingGroups = groupDemandsByBsp(selectedPendingRows);
  const maxStageProjects = Math.max(1, ...stageGroups.map((group) => group.projects));
  const statusGroups = [
    { key: 'in_progress', label: 'Em execução', count: active.filter((demand) => demand.status === 'in_progress').length, className: 'in-progress' },
    { key: 'new', label: 'Novas', count: active.filter((demand) => demand.status === 'new').length, className: 'new' },
    { key: 'waiting', label: 'Aguardando', count: active.filter((demand) => demand.status === 'waiting').length, className: 'waiting' },
    { key: 'blocked', label: 'Bloqueadas', count: active.filter((demand) => demand.status === 'blocked').length, className: 'blocked' },
    { key: 'late', label: 'Atrasadas', count: active.filter((demand) => effectiveStatus(demand) === 'late').length, className: 'late' },
  ];
  const maxStatus = Math.max(1, ...statusGroups.map((group) => group.count));

  return <GenericPage title="Dashboard Operacional" subtitle="Visão executiva da carteira, com o total de projetos e a distribuição por etapa.">
    <section className="dashboard-banner">
      <div className="dashboard-banner-icon"><BarChart3 size={24} /></div>
      <div><span className="eyebrow">Painel de execução</span><strong>Acompanhamento em tempo real da carteira</strong><small>Os números seguem as linhas de projeto ativas do Tracking; os detalhes preservam cada ISO ou demanda.</small></div>
      <div className="dashboard-banner-progress"><span>Avanço médio ativo</span><strong>{averageProgress}%</strong><i><em style={{ width: averageProgress + '%' }} /></i></div>
    </section>

    <section className="dashboard-kpi-grid">
      <div className="dashboard-kpi primary"><span>1. Total de projetos</span><strong>{totalProjects}</strong><small>{activeProjects} ativos na carteira</small></div>
      <div className="dashboard-kpi blue"><span>2. Projetos em andamento</span><strong>{activeProjects}</strong><small>{active.length} demandas/ISOs ativos</small></div>
      <div className="dashboard-kpi amber"><span>3. Projetos em atraso</span><strong>{countProjects(active.filter((demand) => effectiveStatus(demand) === 'late'))}</strong><small>Requerem acompanhamento</small></div>
      <div className="dashboard-kpi red"><span>4. Projetos bloqueados</span><strong>{countProjects(active.filter((demand) => demand.status === 'blocked'))}</strong><small>Pendências impedindo avanço</small></div>
      <div className="dashboard-kpi green"><span>5. Projetos concluídos</span><strong>{completedProjects}</strong><small>{completed.length} demandas concluídas</small></div>
    </section>

    <div className="dashboard-grid">
      <section className="section-card dashboard-stage-card">
        <div className="section-card-head"><div><span className="section-mono">Distribuição da carteira</span><h2>Projetos por etapa</h2></div><span className="count-ref">{stageGroups.length} etapas ativas</span></div>
        <div className="dashboard-stage-grid">
          {stageGroups.map((group) => {
            const percentage = activeProjects ? Math.round(group.projects / activeProjects * 100) : 0;
            return <button key={group.key} className={'dashboard-stage-tile ' + (selectedStageKey === group.key ? 'selected' : '')} onClick={() => {
              setSelectedStageKey((current) => current === group.key ? null : group.key);
              setExpandedStageBspKey(null);
            }}>
              <span className="dashboard-stage-number">{String(group.index).padStart(2, '0')}</span>
              <div className="dashboard-stage-copy"><span>{group.sector}</span><strong>{group.label}</strong><small>{group.projects} BSP(s) · {group.rows.length} pendentes · {percentage}% da carteira</small><i><em style={{ width: Math.min(100, group.projects / maxStageProjects * 100) + '%' }} /></i></div>
              <b>{group.projects}</b>
            </button>;
          })}
        </div>
      </section>

      <aside className="section-card dashboard-status-card">
        <div className="section-card-head"><div><span className="section-mono">Status operacional</span><h2>Condição atual</h2></div></div>
        <div className="dashboard-status-list">{statusGroups.map((group) => <div key={group.key}><div><strong>{group.label}</strong><span>{group.count}</span></div><i className={group.className}><em style={{ width: (group.count / maxStatus * 100) + '%' }} /></i></div>)}</div>
        <div className="dashboard-status-foot"><span>Concluídos / arquivados</span><strong>{completedProjects}</strong></div>
      </aside>
    </div>

    {selectedStage && <section className="section-card dashboard-detail-card">
      <div className="section-card-head"><div><span className="section-mono">Pendências da etapa</span><h2>{selectedStage.label}</h2></div><span className="count-ref">{selectedPendingGroups.length} BSP(s) · {selectedPendingRows.length} tags</span></div>
      {selectedPendingGroups.length ? <div className="dashboard-stage-pending-list">{selectedPendingGroups.slice(0, 40).map((group) => {
        const expanded = expandedStageBspKey === group.key;
        const first = group.demands[0];
        return <div className={'dashboard-stage-project ' + (expanded ? 'expanded' : '')} key={group.key}>
          <button className="dashboard-stage-project-head" onClick={() => setExpandedStageBspKey((current) => current === group.key ? null : group.key)} aria-expanded={expanded}>
            <span className="dashboard-stage-project-bsp"><strong>{group.bsp}</strong><small>{group.demands.length} tag(s) pendente(s)</small></span>
            <span className="dashboard-stage-project-info"><strong>{first?.project || 'Projeto'}</strong><small>{first?.client || 'Cliente não informado'}</small></span>
            <span className="dashboard-stage-project-count">{group.demands.length}<small>tags</small></span>
            <ChevronDown className={expanded ? 'rotate' : ''} size={16} />
          </button>
          {expanded && <div className="dashboard-stage-tags" aria-label={'Tags pendentes da ' + group.bsp}>
            {group.demands.map((demand) => <button className="dashboard-stage-tag" key={demand.id} onClick={() => onOpen(demand.id)}>
              <span><strong>{demand.iso}</strong><small>{demand.stage}</small></span>
              <span className={'status-ref ' + effectiveStatus(demand)}><i />{statusLabel[effectiveStatus(demand)]}</span>
              <span className="dashboard-stage-tag-progress">{demand.progress}%</span>
              <ChevronRight size={14} />
            </button>)}
          </div>}
        </div>;
      })}</div> : <div className="dashboard-stage-empty">Nenhuma pendência nesta etapa.</div>}
      {selectedPendingGroups.length > 40 && <p className="dashboard-detail-more">Mostrando as primeiras 40 BSPs. Abra a Carteira para consultar todas.</p>}
    </section>}
  </GenericPage>;
}

function GenericPage({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return <><section className="portfolio-head generic-head"><div><span className="eyebrow">Portal operacional</span><h1>{title}</h1><p>{subtitle}</p></div></section>{children}</>;
}
