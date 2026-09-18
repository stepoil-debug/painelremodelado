import { useEffect, useMemo, useState } from 'react';
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
  FileText,
  Filter,
  ImagePlus,
  LayoutGrid,
  List,
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
  const [state, setState] = useState<OperationalState>(() => loadOperationalState());
  const [page, setPage] = useState<PageKey>('portfolio');
  const [sector, setSector] = useState<SectorKey>('qualidade');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [mode, setMode] = useState<ListMode>('table');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | DemandStatus>('all');
  const [priorityOnly, setPriorityOnly] = useState(false);
  const [lateOnly, setLateOnly] = useState(false);
  const [loadingHH, setLoadingHH] = useState(liveHHReadOnlyEnabled);
  const [banner, setBanner] = useState<string | null>(null);
  const [clock, setClock] = useState(new Date());

  const demands = state.demands;
  const selected = selectedId ? demands.find((d) => d.id === selectedId) ?? null : null;

  useEffect(() => saveOperationalState(state), [state]);

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
    if (!liveHHReadOnlyEnabled) return;
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
    if (!demand || demand.source === 'hh_readonly') return;
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
    if (!demand || demand.source === 'hh_readonly') return;
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
    if (!demand || demand.source === 'hh_readonly') return;
    updateDemand(id, (d) => ({
      ...d,
      status: 'waiting',
      history: appendHistory(d, 'waiting', 'Demanda aguardando', 'Demanda colocada em espera temporária.'),
    }));
    setBanner(demand.bsp + ' movida para Aguardando.');
  }

  function resumeDemand(id: string) {
    const demand = demands.find((d) => d.id === id);
    if (!demand || demand.source === 'hh_readonly') return;
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
    if (!demand || demand.source === 'hh_readonly') return;
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
    if (!demand || demand.source === 'hh_readonly') return;
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
    if (!demand || demand.source === 'hh_readonly') return;
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

  function resetDemo() {
    if (!window.confirm('Restaurar a demonstração para o estado inicial?')) return;
    setState(resetOperationalState());
    setSelectedId(null);
    setExpandedId(null);
    setBanner('Demonstração restaurada.');
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
        <div className="user-chip"><span>UD</span><small>Usuário Demo</small></div>
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
          />
        ) : page === 'live' ? (
          <LivePage demands={demands} loading={loadingHH} onOpen={setSelectedId} />
        ) : page === 'blocks' ? (
          <BlocksPage demands={demands} onOpen={setSelectedId} onResume={resumeDemand} />
        ) : page === 'notifications' ? (
          <NotificationsPage state={state} setState={setState} onOpen={setSelectedId} />
        ) : (
          <AnalyticsPage demands={demands} />
        )}
      </main>

      <footer className="status-bar">
        <span>{selected ? 'Arquivo operacional aberto' : sectorName(sector) + ' · visibilidade por responsabilidade atual'}</span>
        <span>Demonstração pública · sem escrita no Apontamento HH</span>
      </footer>
    </div>
  );
}

function Portfolio(props: {
  demands: Demand[];
  sector: SectorKey;
  setSector: (value: SectorKey) => void;
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
}) {
  const filtered = useMemo(() => {
    const term = props.search.trim().toLowerCase();
    return props.demands
      .filter((d) => d.sector === props.sector)
      .filter((d) => props.statusFilter === 'all' || effectiveStatus(d) === props.statusFilter)
      .filter((d) => !props.priorityOnly || d.priority === 'critical' || d.priority === 'high')
      .filter((d) => !props.lateOnly || effectiveStatus(d) === 'late')
      .filter((d) => !term || [d.bsp, d.iso, d.stage, d.project, d.client, d.assignedTo].filter(Boolean).some((v) => String(v).toLowerCase().includes(term)))
      .sort((a, b) => priorityWeight[b.priority] - priorityWeight[a.priority] || new Date(a.enteredAt).getTime() - new Date(b.enteredAt).getTime());
  }, [props.demands, props.sector, props.statusFilter, props.priorityOnly, props.lateOnly, props.search]);

  const current = props.demands.filter((d) => d.sector === props.sector);
  const active = current.filter((d) => d.status !== 'completed');
  const late = current.filter((d) => effectiveStatus(d) === 'late').length;
  const blocked = current.filter((d) => d.status === 'blocked').length;
  const avg = active.length ? Math.round(active.reduce((sum, d) => sum + d.progress, 0) / active.length) : 0;
  const incoming = props.demands.filter((d) => d.status !== 'completed' && d.sector !== props.sector && getNextStage(d.stageKey)?.sector === props.sector).length;

  return (
    <>
      <section className="portfolio-head">
        <div>
          <span className="eyebrow">Portal operacional</span>
          <h1>Carteira de Demandas</h1>
          <p>Demandas alocadas ao setor, com avanço, responsável, histórico e arquivo operacional de cada BSP / ISO.</p>
        </div>
        <div className="head-actions">
          <span className="sync-chip"><i /> Ambiente isolado</span>
          <button className="soft-btn" onClick={props.onReset}><RefreshCcw size={15} /> Restaurar demo</button>
        </div>
      </section>

      <section className="overview-strip">
        <div className="overview-icon"><BarChart3 size={25} /></div>
        <div className="overview-copy">
          <strong>Visão geral da caixa · {sectorName(props.sector)}</strong>
          <span>Responsabilidade atual do setor e carga prevista pelo fluxo.</span>
        </div>
        <Metric value={active.length} label="Na caixa" />
        <Metric value={late} label="Atrasadas" danger={late > 0} />
        <Metric value={blocked} label="Bloqueadas" warning={blocked > 0} />
        <Metric value={avg + '%'} label="Avanço médio" />
        <Metric value={incoming} label="Próximas" />
      </section>

      <section className="portfolio-title-row">
        <div>
          <span className="eyebrow">Sua operação</span>
          <h2>Demandas alocadas</h2>
          <p>{filtered.length} registro(s) · clique na linha para expandir; abra o arquivo para ver todas as fases.</p>
        </div>
        <div className="mode-toggle">
          <button className={props.mode === 'table' ? 'active' : ''} onClick={() => props.setMode('table')}><List size={14} /> Tabela</button>
          <button className={props.mode === 'board' ? 'active' : ''} onClick={() => props.setMode('board')}><LayoutGrid size={14} /> Quadros</button>
        </div>
      </section>

      <section className="filters-bar">
        <label className="filter-field search-field"><Search size={15} /><input value={props.search} onChange={(e) => props.setSearch(e.target.value)} placeholder="Buscar BSP, ISO, projeto, etapa..." /></label>
        <label className="filter-field"><span>Setor</span><select value={props.sector} onChange={(e) => props.setSector(e.target.value as SectorKey)}>{sectors.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}</select></label>
        <label className="filter-field"><span>Status</span><select value={props.statusFilter} onChange={(e) => props.setStatusFilter(e.target.value as 'all' | DemandStatus)}><option value="all">Todos</option><option value="new">Novas</option><option value="in_progress">Em execução</option><option value="waiting">Aguardando</option><option value="blocked">Bloqueadas</option><option value="late">Atrasadas</option><option value="completed">Concluídas</option></select></label>
        <button className={'flag-filter ' + (props.lateOnly ? 'active danger' : '')} onClick={() => props.setLateOnly(!props.lateOnly)}><AlertTriangle size={14} /> Só atrasadas</button>
        <button className={'flag-filter ' + (props.priorityOnly ? 'active' : '')} onClick={() => props.setPriorityOnly(!props.priorityOnly)}><CircleDot size={14} /> Prioridade</button>
      </section>

      {props.mode === 'table' ? (
        <div className="demand-table">
          <div className="table-head">
            <span>BSP / ISO</span><span>Projeto / Cliente</span><span>Etapa atual</span><span>Responsável</span><span>Avanço</span><span>Status</span><span />
          </div>
          {filtered.map((d) => (
            <DemandRow
              key={d.id}
              demand={d}
              expanded={props.expandedId === d.id}
              onToggle={() => props.setExpandedId(props.expandedId === d.id ? null : d.id)}
              onOpen={() => props.onOpen(d.id)}
              onAssume={() => props.onAssume(d.id)}
            />
          ))}
          {!filtered.length && <div className="empty-reference"><CheckCircle2 size={28} /><strong>Nenhuma demanda nesta visão.</strong><span>Altere os filtros ou selecione outro setor.</span></div>}
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

function DemandRow({ demand, expanded, onToggle, onOpen, onAssume }: { demand: Demand; expanded: boolean; onToggle: () => void; onOpen: () => void; onAssume: () => void }) {
  const status = effectiveStatus(demand);
  const latest = [...demand.history].reverse().slice(0, 3);
  const next = getNextStage(demand.stageKey);

  return (
    <article className={'reference-row ' + (expanded ? 'expanded' : '')}>
      <button className="row-main" onClick={onToggle}>
        <div className="bsp-cell">
          <div className="bsp-orb">BSP</div>
          <div><strong>{demand.bsp}</strong><span>{demand.iso}</span></div>
        </div>
        <div className="project-cell"><strong>{demand.project ?? 'Projeto'}</strong><span>{demand.client ?? 'Cliente'}</span></div>
        <div className="stage-ref"><strong>{demand.stage}</strong><span>{sectorName(demand.sector)} · há {elapsedLabel(demand.enteredAt)}</span></div>
        <div className="owner-ref"><strong>{demand.assignedTo ?? 'Não atribuída'}</strong><span>{demand.assignedTo ? 'Responsável atual' : 'Aguardando aceite'}</span></div>
        <div className="progress-ref"><strong>{demand.progress}%</strong><div><i style={{ width: demand.progress + '%' }} /></div></div>
        <div><StatusPill status={status} /><PriorityPill priority={demand.priority} /></div>
        <ChevronDown className={expanded ? 'rotate' : ''} size={17} />
      </button>

      {expanded && (
        <div className="row-expanded">
          <div className="expanded-updates">
            <span className="section-mono">Últimas atualizações</span>
            {latest.map((u) => <div className="mini-update" key={u.id}><i /><div><strong>{u.title}</strong><p>{u.description}</p><span>{fmtDate(u.at)} · {u.actor}</span></div></div>)}
          </div>
          <div className="expanded-steps">
            <span className="section-mono">Fluxo da demanda</span>
            <div className="mini-flow"><div><span>Origem</span><strong>{sectorName(demand.originSector)}</strong></div><ChevronRight size={14} /><div className="current"><span>Agora</span><strong>{sectorName(demand.sector)}</strong></div><ChevronRight size={14} /><div><span>Próximo</span><strong>{next ? sectorName(next.sector) : 'Encerramento'}</strong></div></div>
            <div className="expanded-kpis">
              <div><span>Evidências</span><strong>{demand.evidences.length}</strong></div>
              <div><span>HH</span><strong>{demand.hhMinutes ? demand.hhMinutes + ' min' : '—'}</strong></div>
              <div><span>SLA</span><strong>{fmtDate(demand.slaDueAt)}</strong></div>
            </div>
          </div>
          <div className="expanded-actions">
            {demand.status === 'new' && demand.source === 'demo' && <button className="soft-btn" onClick={(e) => { e.stopPropagation(); onAssume(); }}><UserCheck size={14} /> Assumir</button>}
            <button className="primary-ref" onClick={(e) => { e.stopPropagation(); onOpen(); }}>Abrir arquivo operacional <ChevronRight size={14} /></button>
          </div>
        </div>
      )}
    </article>
  );
}

function BoardMode({ demands, onOpen }: { demands: Demand[]; onOpen: (id: string) => void }) {
  const groups = sectors.map((s) => ({ sector: s, items: demands.filter((d) => d.sector === s.key) })).filter((g) => g.items.length);
  return <div className="board-reference">{groups.map((g) => <section key={g.sector.key}><div className="board-group-head"><strong>{g.sector.name}</strong><i /><span>{g.items.length} demanda(s)</span></div><div className="board-grid">{g.items.map((d) => <button key={d.id} className="board-card" onClick={() => onOpen(d.id)}><div><strong>{d.bsp}</strong><span>{d.iso}</span></div><h3>{d.stage}</h3><p>{d.project} · {d.client}</p><div className="board-progress"><i style={{ width: d.progress + '%' }} /></div><footer><StatusPill status={effectiveStatus(d)} /><span>{d.progress}%</span></footer></button>)}</div></section>)}</div>;
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
}) {
  const { demand } = props;
  const status = effectiveStatus(demand);
  const currentIndex = getStageIndex(demand.stageKey);
  const [phaseKey, setPhaseKey] = useState(demand.stageKey);
  const phase = getStage(phaseKey) ?? getStage(demand.stageKey)!;
  const phaseIndex = getStageIndex(phase.key);
  const isCurrent = phase.key === demand.stageKey;
  const next = getNextStage(demand.stageKey);
  const hasStart = demand.evidences.some((e) => e.type === 'start');
  const hasFinish = demand.evidences.some((e) => e.type === 'finish');
  const readOnly = demand.source === 'hh_readonly';

  useEffect(() => setPhaseKey(demand.stageKey), [demand.stageKey]);

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
          <SummaryField label="Evidências" value={String(demand.evidences.length)} />
          <SummaryField label="HH / duração" value={demand.hhMinutes ? demand.hhMinutes + ' min' : '—'} />
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
                  <div className={hasStart ? 'ready' : ''}><ImagePlus size={16} /><span>Foto inicial</span><strong>{hasStart ? 'Disponível' : 'Pendente'}</strong></div>
                  <div className={hasFinish ? 'ready' : ''}><ImagePlus size={16} /><span>Foto final</span><strong>{hasFinish ? 'Disponível' : 'Pendente'}</strong></div>
                  <div><FileText size={16} /><span>Extras</span><strong>{demand.evidences.filter((e) => e.type === 'extra').length}</strong></div>
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
              <div><span>Fonte</span><strong>{demand.source === 'hh_readonly' ? 'HH · leitura' : 'Demonstração'}</strong></div>
            </div>
          </div>

          <div className="side-section">
            <span className="section-mono">Evidências e anexos</span>
            <div className="docs-list">
              {demand.evidences.map((e) => <div key={e.id}><span>IMG</span><div><strong>{e.label}</strong><small>{fmtDate(e.at)}</small></div></div>)}
              {!demand.evidences.length && <p className="muted-side">Nenhuma evidência nesta etapa.</p>}
            </div>
          </div>

          <div className="secure-note"><ShieldCheck size={17} /><div><strong>Ambiente isolado</strong><span>As ações da demo não escrevem no Apontamento HH.</span></div></div>
        </aside>
      </section>
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
  return <GenericPage title="Indicadores Operacionais" subtitle="Leitura da carteira, WIP e distribuição da carga por setor."><section className="overview-strip analytics-overview"><div className="overview-icon"><BarChart3 size={25} /></div><div className="overview-copy"><strong>Consolidado operacional</strong><span>Estado atual da demonstração.</span></div><Metric value={active.length} label="WIP" /><Metric value={active.filter((d) => effectiveStatus(d) === 'late').length} label="Atrasadas" danger /><Metric value={active.filter((d) => d.status === 'blocked').length} label="Bloqueadas" warning /><Metric value={demands.filter((d) => d.status === 'completed').length} label="Concluídas" /></section><div className="section-card"><div className="section-card-head"><div><span className="section-mono">WIP por setor</span><h2>Distribuição atual</h2></div></div><div className="analytics-bars">{bySector.map((s) => <div key={s.key}><div><strong>{s.name}</strong><span>{s.count}</span></div><i><em style={{ width: (s.count / max * 100) + '%' }} /></i></div>)}</div></div></GenericPage>;
}

function GenericPage({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return <><section className="portfolio-head generic-head"><div><span className="eyebrow">Portal operacional</span><h1>{title}</h1><p>{subtitle}</p></div></section>{children}</>;
}
