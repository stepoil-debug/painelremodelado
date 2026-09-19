import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Bell,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Eye,
  EyeOff,
  FileText,
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
import { liveHHReadOnlyEnabled, loadHHSessionsReadOnly } from './services/hhReadOnly';
import { hubConfigured, loadHubDemands, loadHubEvidence, loadHubProject, type HubHHEvidence, type HubHHEvidencePhoto, type HubHHSession } from './services/opsPanelHub';
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

type PageKey = 'portfolio' | 'live' | 'blocks' | 'notifications' | 'analytics';
type ListMode = 'table' | 'board';
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

function elapsedLabel(date: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60_000));
  if (minutes < 60) return minutes + ' min';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ' + (minutes % 60) + 'min';
  return Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h';
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
  const [statusFilter, setStatusFilter] = useState<'all' | DemandStatus>('all');
  const [priorityOnly, setPriorityOnly] = useState(false);
  const [lateOnly, setLateOnly] = useState(false);
  const [loadingHH, setLoadingHH] = useState(!hubConfigured && liveHHReadOnlyEnabled);
  const [loadingHub, setLoadingHub] = useState(false);
  const [hubError, setHubError] = useState<string | null>(null);
  const [panelUser, setPanelUser] = useState<PanelUser | null>(null);
  const [authLoading, setAuthLoading] = useState(hubConfigured);
  const [authError, setAuthError] = useState('');
  const [projectDetail, setProjectDetail] = useState<Awaited<ReturnType<typeof loadHubProject>> | null>(null);
  const [hhEvidence, setHhEvidence] = useState<HubHHEvidence | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
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
    else if (normalized.includes('pcp') || normalized.includes('projeto')) setSector('pcp');
    else if (normalized.includes('supr')) setSector('suprimentos');
    else if (normalized.includes('pint')) setSector('pintura');
    else if (normalized.includes('log') || normalized.includes('exped')) setSector('expedicao');
  }, [panelUser]);

  async function refreshHub(showBanner = false) {
    if (!hubConfigured || !panelUser) return;
    setLoadingHub(true);
    setHubError(null);
    try {
      const region = panelUser.operationRegion || 'BR';
      const rows = await loadHubDemands(region, 3000);
      setState(hubRowsToOperationalState(rows));
      setSelectedId(null);
      setExpandedId(null);
      if (showBanner) setBanner(rows.length + ' itens reais carregados do Tracking.');
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

  useEffect(() => {
    if (!hubConfigured || !panelUser) return;
    void refreshHub(false);
  }, [panelUser]);

  useEffect(() => {
    if (!hubConfigured || !panelUser || !selected || selected.source !== 'hub_readonly') {
      setProjectDetail(null);
      setHhEvidence(null);
      setDetailLoading(false);
      setEvidenceLoading(false);
      return;
    }

    let active = true;
    setDetailLoading(true);
    setEvidenceLoading(true);

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

  function assumeDemand(id: string) {
    const demand = demands.find((d) => d.id === id);
    if (!demand || demand.source !== 'demo') return;
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

  function progressDemand(id: string) {
    const demand = demands.find((d) => d.id === id);
    if (!demand || demand.source !== 'demo') return;
    const progress = Math.min(75, Math.max(25, demand.progress + 25));
    updateDemand(id, (d) => ({
      ...d,
      progress,
      status: 'in_progress',
      history: appendHistory(d, 'progress', 'Avanço registrado', 'Progresso atualizado para ' + progress + '%.'),
    }));
    setBanner('Avanço atualizado para ' + progress + '%.');
  }

  function waitDemand(id: string) {
    const demand = demands.find((d) => d.id === id);
    if (!demand || demand.source !== 'demo') return;
    updateDemand(id, (d) => ({
      ...d,
      status: 'waiting',
      history: appendHistory(d, 'waiting', 'Demanda aguardando', 'Demanda colocada em espera temporária.'),
    }));
    setBanner(demand.bsp + ' movida para Aguardando.');
  }

  function resumeDemand(id: string) {
    const demand = demands.find((d) => d.id === id);
    if (!demand || demand.source !== 'demo') return;
    updateDemand(id, (d) => ({
      ...d,
      status: d.assignedTo ? 'in_progress' : 'new',
      blocker: undefined,
      history: appendHistory(d, 'resumed', 'Demanda retomada', 'Demanda liberada para continuidade.'),
    }));
    setBanner(demand.bsp + ' retomada.');
  }

  function blockDemand(id: string) {
    const demand = demands.find((d) => d.id === id);
    if (!demand || demand.source !== 'demo') return;
    const note = window.prompt('Descreva o motivo do bloqueio:', demand.blocker?.note ?? 'Aguardando retorno da Engenharia.');
    if (note === null) return;
    const notification = createNotification(demand.sector, demand, 'Demanda bloqueada', demand.bsp + ' / ' + demand.iso + ' · ' + note, 'warning');
    updateDemand(id, (d) => ({
      ...d,
      status: 'blocked',
      blocker: { reason: 'engineering', note: note || 'Bloqueio operacional.', createdAt: new Date().toISOString() },
      history: appendHistory(d, 'blocked', 'Bloqueio aberto', note || 'Bloqueio operacional.'),
    }), notification);
    setBanner(demand.bsp + ' bloqueada.');
  }

  function addEvidence(id: string, type: EvidenceType) {
    const demand = demands.find((d) => d.id === id);
    if (!demand || demand.source !== 'demo') return;
    const label = type === 'start' ? 'Foto inicial' : type === 'finish' ? 'Foto final' : 'Evidência extra';
    updateDemand(id, (d) => ({
      ...d,
      evidences: [...d.evidences, { id: uid('evd'), type, label: label + ' · demonstração', at: new Date().toISOString(), source: 'demo' }],
      history: appendHistory(d, 'evidence', 'Evidência adicionada', label + ' registrada na etapa atual.'),
    }));
    setBanner(label + ' adicionada.');
  }

  function completeDemand(id: string) {
    const demand = demands.find((d) => d.id === id);
    if (!demand || demand.source !== 'demo') return;
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

  function resetDemo() {
    if (hubConfigured) {
      void refreshHub(true);
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
          <button className={page === 'analytics' ? 'active' : ''} onClick={() => { setPage('analytics'); setSelectedId(null); }}>Indicadores</button>
        </nav>
        <span className="clock">{clock.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
        <button className="header-bell" onClick={() => { setPage('notifications'); setSelectedId(null); }}><Bell size={16} />{unread > 0 && <b>{unread}</b>}</button>
        <div className="user-chip"><span>{panelUser ? initials(panelUser.name) : 'UD'}</span><small>{panelUser?.name || 'Usuário Demo'}</small></div>
        {panelUser && <button className="header-logout" title="Sair do painel" onClick={() => void handlePanelLogout()}><LogOut size={15} /></button>}
      </header>

      {banner && <div className="floating-banner">{banner}</div>}

      <main className="workspace">
        {selected ? (
          <DemandDetail
            demand={selected}
            onBack={() => setSelectedId(null)}
            onAssume={() => assumeDemand(selected.id)}
            onProgress={() => progressDemand(selected.id)}
            onWait={() => waitDemand(selected.id)}
            onResume={() => resumeDemand(selected.id)}
            onBlock={() => blockDemand(selected.id)}
            onEvidence={(type) => addEvidence(selected.id, type)}
            onComplete={() => completeDemand(selected.id)}
            hubDetail={projectDetail}
            hhEvidence={hhEvidence}
            detailLoading={detailLoading}
            evidenceLoading={evidenceLoading}
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
            error={hubError}
          />
        ) : page === 'live' ? (
          <LivePage demands={demands} loading={loadingHub || loadingHH} onOpen={setSelectedId} />
        ) : page === 'blocks' ? (
          <BlocksPage demands={demands} onOpen={setSelectedId} onResume={resumeDemand} />
        ) : page === 'notifications' ? (
          <NotificationsPage state={state} setState={setState} onOpen={setSelectedId} />
        ) : (
          <AnalyticsPage demands={demands} />
        )}
      </main>

      <footer className="status-bar">
        <span>{selected ? 'Arquivo operacional aberto' : (sector === 'all' ? 'Todos os setores · visão completa da etapa atual' : sectorName(sector) + ' · visibilidade por responsabilidade atual')}</span>
        <span>{hubConfigured ? 'Dados reais · Tracking/Smartsheet · somente leitura' : 'Demonstração pública · sem escrita no Apontamento HH'}</span>
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
        <div className="real-source-loading"><RefreshCcw size={18} className="spin" /> Buscando fotos privadas do Apontamento HH...</div>
      </div>
    );
  }

  if (!evidence || (!evidence.sessions.length && !evidence.photos.length)) {
    return (
      <div className="section-card hh-evidence-card">
        <div className="section-card-head">
          <div><span className="section-mono">Apontamento HH</span><h2>Evidências fotográficas</h2></div>
          <span className="count-ref">0</span>
        </div>
        <div className="hh-empty-evidence">
          <ImagePlus size={22} />
          <div><strong>Nenhuma foto encontrada para este ISO/SPL.</strong><span>O vínculo é feito por BSP + ISO/SPL sem alterar o apontamento.</span></div>
        </div>
      </div>
    );
  }

  const groups = buildPhotoStageGroups(evidence);

  return (
    <div className="section-card hh-evidence-card">
      <div className="section-card-head">
        <div><span className="section-mono">Apontamento HH</span><h2>Evidências por etapa do processo</h2></div>
        <span className="live-source-badge"><i /> {evidence.photos.length} FOTO(S) · {groups.length} ETAPA(S)</span>
      </div>

      <div className="hh-stage-groups">
        {groups.map((group, groupIndex) => {
          const totalHH = group.sessions.reduce((sum, session) => sum + Number(session.total_hh || 0), 0);
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
                  {totalHH > 0 && <span><Clock3 size={13} /> {totalHH.toFixed(2)} HH</span>}
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

function RealSourcesPanel({ detail, loading }: {
  detail: Awaited<ReturnType<typeof loadHubProject>> | null;
  loading: boolean;
}) {
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
  const drawings = asRecords(detail.drawings);
  const revisions = asRecords(detail.drawing_revisions);
  const jobs = asRecords(detail.job_orders);
  const dimensional = asRecords(detail.dimensional);
  const logistics = asRecords(detail.logistics);

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
        <div><span>Dimensional</span><strong>{dimensional.length}</strong></div>
        <div><span>Logística</span><strong>{logistics.length}</strong></div>
      </div>

      {project && (
        <div className="source-project-summary">
          <SummaryField label="Status WIP" value={project.project_status || project.wip_progress_text || '—'} />
          <SummaryField label="Customer PO" value={project.customer_po || project.po_numbers || '—'} />
          <SummaryField label="Job Order" value={project.job_order_ids || '—'} />
          <SummaryField label="Valor da PO" value={money(project.po_value)} />
          <SummaryField label="Faturado" value={money(project.billed_value)} />
          <SummaryField label="Saldo contratual" value={money(project.contractual_balance)} />
          <SummaryField label="Última revisão desenho" value={project.latest_drawing_revision || '—'} />
          <SummaryField label="Atualização consolidada" value={fmtDate(project.data_updated_at || undefined)} />
        </div>
      )}

      {drawings.length > 0 && (
        <div className="source-block">
          <div className="source-block-head">
            <strong>Drawing / FCB</strong>
            <span>{drawings.length} documento(s) · {revisions.length} revisão(ões)</span>
          </div>

          <div className="drawing-revision-list">
            {drawings.slice(0, 20).map((row, index) => {
              const rowId = row.source_row_id;
              const rowRevisions = revisionsForDrawing(revisions, rowId);
              const currentRevision = textField(
                row,
                'current_revision',
                rowRevisions.length ? String(rowRevisions[rowRevisions.length - 1].revision || '—') : '—',
              );

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

                  <RevisionHistory
                    revisions={rowRevisions}
                    currentRevision={currentRevision}
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
          <div className="source-block-head"><strong>3D / Dimensional</strong><span>{dimensional.length} registro(s)</span></div>
          <div className="source-mini-table dimensional-source-table">
            <div className="source-mini-head"><span>Referência</span><span>Spool</span><span>Etapa</span><span>Status</span></div>
            {dimensional.slice(0, 10).map((row, index) => (
              <div className="source-mini-row" key={String(row.source_row_id || index)}>
                <span>{textField(row, 'sob_reference')}</span>
                <span>{textField(row, 'spool')}</span>
                <span>{textField(row, 'inspection_stage')}</span>
                <span>{textField(row, 'status')}</span>
              </div>
            ))}
          </div>
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
    const normalizedBsp = demand.bsp.trim().toUpperCase();
    const key = normalizedBsp || demand.bsp || demand.id;
    const items = map.get(key) ?? [];
    items.push(demand);
    map.set(key, items);
  }

  return [...map.entries()]
    .map(([key, items]) => ({
      key,
      bsp: items[0]?.bsp ?? key,
      demands: [...items].sort((a, b) =>
        a.iso.localeCompare(b.iso, 'pt-BR', { numeric: true, sensitivity: 'base' })
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

function groupOwnerLabel(demands: Demand[]) {
  const owners = [...new Set(demands.map((d) => d.assignedTo).filter((value): value is string => Boolean(value)))];
  if (!owners.length) return 'Não atribuída';
  if (owners.length === 1) return owners[0];
  return owners.length + ' responsáveis';
}

function normalizeSearchValue(value: unknown) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function matchesDemandSearch(demand: Demand, rawQuery: string) {
  const query = rawQuery.trim();
  if (!query) return true;

  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) return true;

  const identifierFields = [
    demand.bsp,
    demand.iso,
  ].map(normalizeSearchValue).filter(Boolean);

  const isIdentifierLike = /^[\d\s\-_/\.]+$/.test(query)
    || /^(bsp|iso|spl)[\s\-_/\.]*[a-z0-9\s\-_/\.]*/i.test(query);

  if (isIdentifierLike) {
    const compactIdentifierQuery = normalizedQuery
      .replace(/^bsp/, '')
      .replace(/^iso/, '')
      .replace(/^spl/, '');

    return identifierFields.some((field) => {
      const comparable = field
        .replace(/^bsp/, '')
        .replace(/^iso/, '')
        .replace(/^spl/, '');
      return comparable.includes(compactIdentifierQuery);
    });
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
  statusFilter: 'all' | DemandStatus;
  setStatusFilter: (value: 'all' | DemandStatus) => void;
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
  error: string | null;
}) {
  const filtered = useMemo(() => {
    return props.demands
      .filter((d) => props.sector === 'all' || d.sector === props.sector)
      .filter((d) => props.statusFilter === 'all' || effectiveStatus(d) === props.statusFilter)
      .filter((d) => !props.priorityOnly || d.priority === 'critical' || d.priority === 'high')
      .filter((d) => !props.lateOnly || effectiveStatus(d) === 'late')
      .filter((d) => matchesDemandSearch(d, props.search))
      .sort((a, b) => priorityWeight[b.priority] - priorityWeight[a.priority] || new Date(a.enteredAt).getTime() - new Date(b.enteredAt).getTime());
  }, [props.demands, props.sector, props.statusFilter, props.priorityOnly, props.lateOnly, props.search]);

  const grouped = useMemo(() => groupDemandsByBsp(filtered), [filtered]);
  const current = props.sector === 'all' ? props.demands : props.demands.filter((d) => d.sector === props.sector);
  const currentGroups = groupDemandsByBsp(current);
  const active = current.filter((d) => d.status !== 'completed');
  const activeGroups = currentGroups.filter((group) => group.demands.some((d) => d.status !== 'completed'));
  const late = currentGroups.filter((group) => group.demands.some((d) => effectiveStatus(d) === 'late')).length;
  const blocked = currentGroups.filter((group) => group.demands.some((d) => d.status === 'blocked')).length;
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
          <span className="sync-chip"><i /> {props.liveData ? 'Dados reais · leitura' : 'Ambiente isolado'}</span>
          <button className="soft-btn" onClick={props.onReset} disabled={props.loading}><RefreshCcw size={15} /> {props.loading ? 'Sincronizando...' : props.liveData ? 'Atualizar dados' : 'Restaurar demo'}</button>
        </div>
      </section>

      {props.error && <div className="reference-warning"><AlertTriangle size={17} /><div><strong>Falha na leitura do hub</strong><p>{props.error}</p></div></div>}

      <section className="overview-strip">
        <div className="overview-icon"><BarChart3 size={25} /></div>
        <div className="overview-copy">
          <strong>{props.sector === 'all' ? 'Visão geral da carteira · Todos os setores' : 'Visão geral da caixa · ' + sectorName(props.sector)}</strong>
          <span>{props.sector === 'all' ? 'Veja onde cada BSP / ISO está no fluxo operacional completo.' : 'Responsabilidade atual do setor e carga prevista pelo fluxo.'}</span>
        </div>
        <Metric value={activeGroups.length} label="BSPs na caixa" />
        <Metric value={late} label="Atrasadas" danger={late > 0} />
        <Metric value={blocked} label="Bloqueadas" warning={blocked > 0} />
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
            placeholder="BSP ou ISO: 26-955, 26955, ISO001..."
          />
          {props.search && <button type="button" className="search-clear" onClick={() => props.setSearch('')}>Limpar</button>}
        </label>
        <label className="filter-field"><span>Setor</span><select value={props.sector} onChange={(e) => props.setSector(e.target.value as SectorFilter)}><option value="all">Todos os setores</option>{sectors.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}</select></label>
        <label className="filter-field"><span>Status</span><select value={props.statusFilter} onChange={(e) => props.setStatusFilter(e.target.value as 'all' | DemandStatus)}><option value="all">Todos</option><option value="new">Novas</option><option value="in_progress">Em execução</option><option value="waiting">Aguardando</option><option value="blocked">Bloqueadas</option><option value="late">Atrasadas</option><option value="completed">Concluídas</option></select></label>
        <button className={'flag-filter ' + (props.lateOnly ? 'active danger' : '')} onClick={() => props.setLateOnly(!props.lateOnly)}><AlertTriangle size={14} /> Só atrasadas</button>
        <button className={'flag-filter ' + (props.priorityOnly ? 'active' : '')} onClick={() => props.setPriorityOnly(!props.priorityOnly)}><CircleDot size={14} /> Prioridade</button>
        {props.search && <div className="search-feedback"><strong>{grouped.length}</strong> BSP(s) encontrada(s) para <span>“{props.search}”</span></div>}
      </section>

      {props.mode === 'table' ? (
        <div className="demand-table">
          <div className="table-head">
            <span>BSP / ISO</span><span>Projeto / Cliente</span><span>Etapa atual</span><span>Responsável</span><span>Avanço</span><span>Status</span><span />
          </div>
          {grouped.map((group) => (
            <BspTreeRow
              key={group.key}
              group={group}
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
  expanded,
  onToggle,
  onOpen,
}: {
  group: BspGroup;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
}) {
  const first = group.demands[0];
  const status = groupStatus(group.demands);
  const priority = groupPriority(group.demands);
  const progress = groupProgress(group.demands);
  const stageLabel = groupStageLabel(group.demands);
  const sectorLabel = groupSectorLabel(group.demands);
  const ownerLabel = groupOwnerLabel(group.demands);
  const differentStages = new Set(group.demands.map((d) => d.stage)).size > 1;

  return (
    <article className={'reference-row bsp-tree-row ' + (expanded ? 'expanded' : '')}>
      <button className="row-main bsp-parent-row" onClick={onToggle}>
        <div className="bsp-cell">
          <div className="bsp-orb">BSP</div>
          <div>
            <strong>{group.bsp}</strong>
            <span>{group.demands.length} ISO/SPL {group.demands.length === 1 ? 'vinculado' : 'vinculados'}</span>
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
        <div className="owner-ref">
          <strong>{ownerLabel}</strong>
          <span>{group.demands.length} item(ns) na árvore</span>
        </div>
        <div className="progress-ref">
          <strong>{progress}%</strong>
          <div><i style={{ width: progress + '%' }} /></div>
        </div>
        <div><StatusPill status={status} /><PriorityPill priority={priority} /></div>
        <ChevronDown className={expanded ? 'rotate' : ''} size={17} />
      </button>

      {expanded && (
        <div className="bsp-tree-children">
          <div className="bsp-tree-heading">
            <span>Árvore da BSP</span>
            <strong>{group.demands.length} ISO/SPL</strong>
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
                    <span>{sectorName(demand.sector)} · há {elapsedLabel(demand.enteredAt)}</span>
                  </div>
                  <div className="owner-ref">
                    <strong>{demand.assignedTo ?? 'Não atribuída'}</strong>
                    <span>Responsável atual</span>
                  </div>
                  <div className="progress-ref">
                    <strong>{demand.progress}%</strong>
                    <div><i style={{ width: demand.progress + '%' }} /></div>
                  </div>
                  <div className="bsp-child-status">
                    <StatusPill status={childStatus} />
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
                <footer><StatusPill status={groupStatus(group.demands)} /><span>{progress}%</span></footer>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function DemandDetail(props: {
  demand: Demand;
  onBack: () => void;
  onAssume: () => void;
  onProgress: () => void;
  onWait: () => void;
  onResume: () => void;
  onBlock: () => void;
  onEvidence: (type: EvidenceType) => void;
  onComplete: () => void;
  hubDetail: Awaited<ReturnType<typeof loadHubProject>> | null;
  hhEvidence: HubHHEvidence | null;
  detailLoading: boolean;
  evidenceLoading: boolean;
}) {
  const { demand } = props;
  const status = effectiveStatus(demand);
  const currentIndex = getStageIndex(demand.stageKey);
  const [phaseKey, setPhaseKey] = useState(demand.stageKey);
  const [photoModalIndex, setPhotoModalIndex] = useState<number | null>(null);
  const phase = getStage(phaseKey) ?? getStage(demand.stageKey)!;
  const phaseIndex = getStageIndex(phase.key);
  const isCurrent = phase.key === demand.stageKey;
  const next = getNextStage(demand.stageKey);
  const hhPhotos = props.hhEvidence?.photos ?? [];
  const hhSessions = props.hhEvidence?.sessions ?? [];
  const hhStartPhotos = hhPhotos.filter((photo) => photoMoment(photo) === 'start');
  const hhFinishPhotos = hhPhotos.filter((photo) => photoMoment(photo) === 'finish');
  const hhExtraPhotos = hhPhotos.filter((photo) => photoMoment(photo) === 'extra');
  const hasStart = demand.evidences.some((e) => e.type === 'start') || hhStartPhotos.length > 0;
  const hasFinish = demand.evidences.some((e) => e.type === 'finish') || hhFinishPhotos.length > 0;
  const totalEvidence = demand.evidences.length + hhPhotos.length;
  const hhTotal = hhSessions.reduce((sum, session) => sum + Number(session.total_hh || 0), 0);
  const readOnly = demand.source !== 'demo';

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

  return (
    <>
      <section className="detail-top">
        <button className="back-link" onClick={props.onBack}><ArrowLeft size={15} /> Voltar à carteira</button>
        <div className="detail-title-row">
          <div className="detail-bsp"><span>BSP / ISO</span><strong>{demand.bsp}</strong><em>{demand.iso}</em></div>
          <div className="detail-title-copy"><h1>{demand.project}</h1><p>{demand.client} · {sectorName(demand.sector)}</p></div>
          <StatusPill status={status} />
          <PriorityPill priority={demand.priority} />
        </div>
        <div className="detail-summary-grid">
          <SummaryField label="Etapa atual" value={demand.stage} />
          <SummaryField label="Responsável" value={demand.assignedTo ?? 'Não atribuída'} />
          <SummaryField label="Entrada no setor" value={fmtDate(demand.enteredAt)} />
          <SummaryField label="SLA da etapa" value={fmtDate(demand.slaDueAt)} />
          <SummaryField label="Evidências" value={props.evidenceLoading ? '...' : String(totalEvidence)} />
          <SummaryField label="HH / duração" value={hhTotal > 0 ? hhTotal.toFixed(2) + ' HH' : demand.hhMinutes ? demand.hhMinutes + ' min' : '—'} />
        </div>
      </section>

      <section className="phases-wrap">
        <span className="eyebrow">Fases do processo</span>
        <div className="phase-strip">
          {workflowStages.map((stage, index) => {
            const done = index < currentIndex;
            const current = index === currentIndex;
            const future = index > currentIndex;
            const pct = done ? 100 : current ? demand.progress : 0;
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
              <SummaryField label="Apontamento HH" value={phase.usesPointing ? 'Vinculado ao apontador' : 'Não obrigatório'} />
              <SummaryField label="SLA configurado" value={Math.round(phase.slaMinutes / 60 * 10) / 10 + ' horas'} />
              <SummaryField label="Próximo destino" value={isCurrent ? (next ? sectorName(next.sector) : 'Encerramento') : '—'} />
            </div>

            {isCurrent && (
              <>
                <div className="detail-progress-block"><div><span>Avanço da etapa</span><strong>{demand.progress}%</strong></div><div className="detail-progress"><i style={{ width: demand.progress + '%' }} /></div></div>
                {demand.blocker && <div className="reference-warning"><AlertTriangle size={17} /><div><strong>Bloqueio ativo</strong><p>{demand.blocker.note}</p></div></div>}
                <div className="evidence-reference">
                  <div className={hasStart ? 'ready' : ''}><ImagePlus size={16} /><span>Foto inicial</span><strong>{props.evidenceLoading ? '...' : hasStart ? hhStartPhotos.length + ' disponível(is)' : 'Pendente'}</strong></div>
                  <div className={hasFinish ? 'ready' : ''}><ImagePlus size={16} /><span>Foto final</span><strong>{props.evidenceLoading ? '...' : hasFinish ? hhFinishPhotos.length + ' disponível(is)' : 'Pendente'}</strong></div>
                  <div><FileText size={16} /><span>Extras</span><strong>{props.evidenceLoading ? '...' : hhExtraPhotos.length + demand.evidences.filter((e) => e.type === 'extra').length}</strong></div>
                </div>

                {!readOnly && demand.status !== 'completed' && (
                  <div className="detail-actions">
                    {demand.status === 'new' && <button className="primary-ref" onClick={props.onAssume}><UserCheck size={14} /> Assumir demanda</button>}
                    {demand.status === 'in_progress' && <button className="soft-btn" onClick={props.onProgress}><Activity size={14} /> Avançar 25%</button>}
                    {demand.status === 'in_progress' && <button className="soft-btn" onClick={props.onWait}><PauseCircle size={14} /> Aguardar</button>}
                    {(demand.status === 'waiting' || demand.status === 'blocked') && <button className="soft-btn" onClick={props.onResume}><PlayCircle size={14} /> Retomar</button>}
                    {demand.status !== 'blocked' && <button className="danger-ref" onClick={props.onBlock}><XCircle size={14} /> Bloquear</button>}
                    {!hasStart && <button className="soft-btn" onClick={() => props.onEvidence('start')}><ImagePlus size={14} /> Foto início</button>}
                    {!hasFinish && <button className="soft-btn" onClick={() => props.onEvidence('finish')}><ImagePlus size={14} /> Foto fim</button>}
                    {(demand.status === 'in_progress' || demand.status === 'waiting' || demand.status === 'late') && <button className="success-ref" onClick={props.onComplete}><CheckCircle2 size={14} /> Concluir etapa e enviar</button>}
                  </div>
                )}
              </>
            )}
          </div>

          {demand.source === 'hub_readonly' && (
            <HHEvidenceGallery evidence={props.hhEvidence} loading={props.evidenceLoading} onOpenPhoto={openPhoto} />
          )}

          {demand.source === 'hub_readonly' && (
            <RealSourcesPanel detail={props.hubDetail} loading={props.detailLoading} />
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
              <div><span>Fonte</span><strong>{demand.source === 'hub_readonly' ? 'Tracking + Apontamento HH' : demand.source === 'hh_readonly' ? 'HH · leitura' : 'Demonstração'}</strong></div>
            </div>
          </div>

          <div className="side-section">
            <span className="section-mono">Evidências e anexos</span>
            <div className="docs-list">
              {hhPhotos.slice(0, 6).map((photo) => (
                <button className="side-photo-link" type="button" onClick={() => openPhoto(photo.id)} key={photo.id}>
                  <img src={photo.signed_url} alt={photoLabel(photo)} loading="lazy" />
                  <div><strong>{photoStageLabel(props.hhEvidence, photo.id) || photoLabel(photo)}</strong><small>{photoLabel(photo)} · {fmtDate(photo.taken_at || undefined)}</small></div>
                </button>
              ))}
              {demand.evidences.map((e) => <div key={e.id}><span>IMG</span><div><strong>{e.label}</strong><small>{fmtDate(e.at)}</small></div></div>)}
              {!props.evidenceLoading && !hhPhotos.length && !demand.evidences.length && <p className="muted-side">Nenhuma evidência vinculada a este ISO/SPL.</p>}
              {props.evidenceLoading && <p className="muted-side">Buscando imagens do Apontamento HH...</p>}
            </div>
          </div>

          <div className="secure-note"><ShieldCheck size={17} /><div><strong>{demand.source === 'hub_readonly' ? 'Dados reais · somente leitura' : 'Ambiente isolado'}</strong><span>{demand.source === 'hub_readonly' ? 'Os dados vêm do hub operacional e esta tela não escreve no Smartsheet.' : 'As ações da demo não escrevem no Apontamento HH.'}</span></div></div>
        </aside>
      </section>

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

function StatusPill({ status }: { status: DemandStatus }) {
  return <span className={'status-ref ' + status}><i />{statusLabel[status]}</span>;
}

function PriorityPill({ priority }: { priority: Priority }) {
  return <span className={'priority-ref ' + priority}>{priorityLabel[priority]}</span>;
}

function LivePage({ demands, loading, onOpen }: { demands: Demand[]; loading: boolean; onOpen: (id: string) => void }) {
  const live = demands.filter((d) => getStage(d.stageKey)?.usesPointing && d.status !== 'completed');
  return <GenericPage title="Produção ao Vivo" subtitle="Atividades que dependem do apontamento, mantendo a mesma leitura de carteira."><div className="section-card"><div className="section-card-head"><div><span className="section-mono">Apontamento HH</span><h2>Sessões em acompanhamento</h2></div><span className="count-ref">{loading ? '...' : live.length}</span></div><div className="simple-table"><div className="simple-head"><span>BSP / ISO</span><span>Atividade</span><span>Setor</span><span>Avanço</span><span>Evidências</span></div>{live.map((d) => <button key={d.id} onClick={() => onOpen(d.id)}><span><strong>{d.bsp}</strong><small>{d.iso}</small></span><span>{d.stage}</span><span>{sectorName(d.sector)}</span><span>{d.progress}%</span><span>{d.evidences.length}</span></button>)}</div></div></GenericPage>;
}

function BlocksPage({ demands, onOpen, onResume }: { demands: Demand[]; onOpen: (id: string) => void; onResume: (id: string) => void }) {
  const blocked = demands.filter((d) => d.status === 'blocked');
  return <GenericPage title="Bloqueios Operacionais" subtitle="Pendências que impedem a demanda de avançar para o próximo setor."><div className="section-card"><div className="simple-table"><div className="simple-head blocked-head"><span>BSP / ISO</span><span>Setor</span><span>Motivo</span><span>Desde</span><span>Ações</span></div>{blocked.map((d) => <div className="simple-block-row" key={d.id}><span><strong>{d.bsp}</strong><small>{d.iso}</small></span><span>{sectorName(d.sector)}</span><span>{d.blocker?.note ?? 'Bloqueio operacional'}</span><span>{fmtDate(d.blocker?.createdAt)}</span><span><button className="soft-btn" onClick={() => onOpen(d.id)}><Eye size={13} /> Abrir</button>{d.source === 'demo' && <button className="success-ref" onClick={() => onResume(d.id)}><Check size={13} /> Resolver</button>}</span></div>)}</div></div></GenericPage>;
}

function NotificationsPage({ state, setState, onOpen }: { state: OperationalState; setState: React.Dispatch<React.SetStateAction<OperationalState>>; onOpen: (id: string) => void }) {
  const items = [...state.notifications].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  function read(id: string) { setState((current) => ({ ...current, notifications: current.notifications.map((n) => n.id === id ? { ...n, read: true } : n) })); }
  return <GenericPage title="Notificações" subtitle="Handoffs, alertas de execução e eventos relevantes do fluxo operacional."><div className="section-card notification-reference-list">{items.map((n) => <button key={n.id} className={!n.read ? 'unread' : ''} onClick={() => { read(n.id); if (n.demandId) onOpen(n.demandId); }}><div className={'notification-icon-ref ' + n.severity}><Bell size={15} /></div><div><strong>{n.title}</strong><p>{n.message}</p><span>{fmtDate(n.createdAt)} · {sectorName(n.sector)}</span></div>{!n.read && <i />}</button>)}</div></GenericPage>;
}

function AnalyticsPage({ demands }: { demands: Demand[] }) {
  const active = demands.filter((d) => d.status !== 'completed');
  const bySector = sectors.map((s) => ({ ...s, count: active.filter((d) => d.sector === s.key).length }));
  const max = Math.max(1, ...bySector.map((s) => s.count));
  return <GenericPage title="Indicadores Operacionais" subtitle="Leitura da carteira, WIP e distribuição da carga por setor."><section className="overview-strip analytics-overview"><div className="overview-icon"><BarChart3 size={25} /></div><div className="overview-copy"><strong>Consolidado operacional</strong><span>Estado atual da carteira.</span></div><Metric value={active.length} label="WIP" /><Metric value={active.filter((d) => effectiveStatus(d) === 'late').length} label="Atrasadas" danger /><Metric value={active.filter((d) => d.status === 'blocked').length} label="Bloqueadas" warning /><Metric value={demands.filter((d) => d.status === 'completed').length} label="Concluídas" /></section><div className="section-card"><div className="section-card-head"><div><span className="section-mono">WIP por setor</span><h2>Distribuição atual</h2></div></div><div className="analytics-bars">{bySector.map((s) => <div key={s.key}><div><strong>{s.name}</strong><span>{s.count}</span></div><i><em style={{ width: (s.count / max * 100) + '%' }} /></i></div>)}</div></div></GenericPage>;
}

function GenericPage({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return <><section className="portfolio-head generic-head"><div><span className="eyebrow">Portal operacional</span><h1>{title}</h1><p>{subtitle}</p></div></section>{children}</>;
}
