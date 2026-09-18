import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Eye,
  Filter,
  ImagePlus,
  Inbox,
  ListChecks,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  Search,
  ShieldCheck,
  Truck,
  UserCheck,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import { seedNotifications } from './data/mock';
import { liveHHReadOnlyEnabled, loadHHSessionsReadOnly } from './services/hhReadOnly';
import { loadOperationalState, resetOperationalState, saveOperationalState, uid } from './store';
import type {
  Demand,
  DemandStatus,
  EvidenceType,
  NotificationItem,
  OperationalState,
  SectorKey,
} from './types';
import {
  getNextStage,
  getStage,
  photoPolicyLabel,
  sectorName,
  sectors,
  workflowStages,
} from './workflow';

type ViewKey = 'queue' | 'flow' | 'live' | 'blocks' | 'notifications' | 'analytics';
type QueueFilter = 'all' | DemandStatus;
type Banner = { tone: 'success' | 'warning' | 'danger'; text: string } | null;

const statusLabel: Record<DemandStatus, string> = {
  new: 'Nova',
  in_progress: 'Em execução',
  waiting: 'Aguardando',
  blocked: 'Bloqueada',
  late: 'Atrasada',
  completed: 'Concluída',
};

const priorityLabel = {
  critical: 'Crítica',
  high: 'Alta',
  normal: 'Normal',
  low: 'Baixa',
};

const blockerLabel = {
  material: 'Material',
  engineering: 'Engenharia',
  client: 'Cliente',
  access: 'Acesso',
  quality: 'Qualidade',
  other: 'Outro',
};

const priorityWeight = { critical: 4, high: 3, normal: 2, low: 1 };

function effectiveStatus(demand: Demand): DemandStatus {
  if (demand.status === 'completed' || demand.status === 'blocked' || demand.status === 'waiting') return demand.status;
  if (demand.status === 'late') return 'late';
  if (demand.slaDueAt && Date.now() > new Date(demand.slaDueAt).getTime()) return 'late';
  return demand.status;
}

function elapsedMinutes(date: string) {
  return Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60_000));
}

function elapsedLabel(date: string) {
  const minutes = elapsedMinutes(date);
  if (minutes < 60) return minutes + ' min';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? hours + 'h ' + rest + 'min' : hours + 'h';
  return Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h';
}

function dateTimeLabel(date?: string) {
  if (!date) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
}

function nextSectorFor(demand: Demand) {
  return getNextStage(demand.stageKey)?.sector;
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
  const [view, setView] = useState<ViewKey>('queue');
  const [sector, setSector] = useState<SectorKey>('qualidade');
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingHH, setLoadingHH] = useState(liveHHReadOnlyEnabled);
  const [hhError, setHHError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [blockTarget, setBlockTarget] = useState<string | null>(null);
  const [blockReason, setBlockReason] = useState<keyof typeof blockerLabel>('engineering');
  const [blockNote, setBlockNote] = useState('');

  const demands = state.demands;
  const selected = selectedId ? demands.find((item) => item.id === selectedId) ?? null : null;

  useEffect(() => {
    saveOperationalState(state);
  }, [state]);

  useEffect(() => {
    if (!banner) return;
    const timer = window.setTimeout(() => setBanner(null), 4200);
    return () => window.clearTimeout(timer);
  }, [banner]);

  useEffect(() => {
    if (!liveHHReadOnlyEnabled) return;
    loadHHSessionsReadOnly()
      .then((live) => {
        if (!live.length) return;
        setState((current) => {
          const demoOnly = current.demands.filter((item) => item.source !== 'hh_readonly');
          return { ...current, demands: [...live, ...demoOnly] };
        });
      })
      .catch((error: unknown) => setHHError(error instanceof Error ? error.message : 'Falha ao ler o HH.'))
      .finally(() => setLoadingHH(false));
  }, []);

  const current = useMemo(
    () => demands.filter((item) => item.sector === sector),
    [demands, sector],
  );

  const upcoming = useMemo(
    () => demands.filter((item) => {
      const next = getNextStage(item.stageKey);
      return item.status !== 'completed' && item.sector !== sector && next?.sector === sector;
    }),
    [demands, sector],
  );

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return current
      .filter((item) => {
        const status = effectiveStatus(item);
        const matchesFilter = filter === 'all' || status === filter;
        const matchesSearch = !term || [
          item.bsp,
          item.iso,
          item.stage,
          item.project,
          item.client,
          item.assignedTo,
        ].filter(Boolean).some((value) => String(value).toLowerCase().includes(term));
        return matchesFilter && matchesSearch;
      })
      .sort((a, b) => {
        const statusOrder = (value: Demand) => {
          const status = effectiveStatus(value);
          if (status === 'late') return 5;
          if (status === 'blocked') return 4;
          if (status === 'new') return 3;
          if (status === 'in_progress') return 2;
          if (status === 'waiting') return 1;
          return 0;
        };
        return statusOrder(b) - statusOrder(a)
          || priorityWeight[b.priority] - priorityWeight[a.priority]
          || new Date(a.enteredAt).getTime() - new Date(b.enteredAt).getTime();
      });
  }, [current, filter, search]);

  const notifications = useMemo(
    () => state.notifications.filter((item) => item.sector === sector)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [state.notifications, sector],
  );

  const counts = useMemo(() => {
    const statuses = current.map(effectiveStatus);
    return {
      total: current.filter((item) => item.status !== 'completed').length,
      new: statuses.filter((value) => value === 'new').length,
      inProgress: statuses.filter((value) => value === 'in_progress').length,
      blocked: statuses.filter((value) => value === 'blocked').length,
      late: statuses.filter((value) => value === 'late').length,
    };
  }, [current]);

  function updateDemand(id: string, updater: (demand: Demand) => Demand, notification?: NotificationItem) {
    setState((currentState) => ({
      ...currentState,
      demands: currentState.demands.map((item) => item.id === id ? updater(item) : item),
      notifications: notification ? [notification, ...currentState.notifications] : currentState.notifications,
    }));
  }

  function appendHistory(
    demand: Demand,
    type: Demand['history'][number]['type'],
    title: string,
    description: string,
    sectorOverride?: SectorKey,
  ) {
    return [
      ...demand.history,
      {
        id: uid('evt'),
        type,
        title,
        description,
        at: new Date().toISOString(),
        actor: 'Usuário Demo',
        sector: sectorOverride ?? demand.sector,
      },
    ];
  }

  function assumeDemand(id: string) {
    const demand = demands.find((item) => item.id === id);
    if (!demand || demand.source === 'hh_readonly') return;
    const now = new Date().toISOString();
    updateDemand(id, (item) => ({
      ...item,
      status: 'in_progress',
      assignedTo: 'Usuário Demo',
      acceptedAt: now,
      startedAt: item.startedAt ?? now,
      history: appendHistory(item, 'accepted', 'Demanda assumida', 'Responsabilidade assumida pelo usuário de demonstração.'),
    }));
    setBanner({ tone: 'success', text: demand.bsp + ' assumida. A demanda agora está em execução.' });
  }

  function advanceProgress(id: string) {
    const demand = demands.find((item) => item.id === id);
    if (!demand || demand.source === 'hh_readonly') return;
    const nextProgress = Math.min(75, Math.max(25, demand.progress + 25));
    updateDemand(id, (item) => ({
      ...item,
      progress: nextProgress,
      status: 'in_progress',
      history: appendHistory(item, 'progress', 'Progresso atualizado', 'Avanço demonstrativo registrado em ' + nextProgress + '%.'),
    }));
    setBanner({ tone: 'success', text: 'Progresso atualizado para ' + nextProgress + '%.' });
  }

  function setWaiting(id: string) {
    const demand = demands.find((item) => item.id === id);
    if (!demand || demand.source === 'hh_readonly') return;
    updateDemand(id, (item) => ({
      ...item,
      status: 'waiting',
      history: appendHistory(item, 'waiting', 'Demanda em espera', 'Execução pausada temporariamente.'),
    }));
    setBanner({ tone: 'warning', text: demand.bsp + ' movida para Aguardando.' });
  }

  function resumeDemand(id: string) {
    const demand = demands.find((item) => item.id === id);
    if (!demand || demand.source === 'hh_readonly') return;
    updateDemand(id, (item) => ({
      ...item,
      status: item.assignedTo ? 'in_progress' : 'new',
      history: appendHistory(item, 'resumed', 'Demanda retomada', 'Demanda liberada para continuidade.'),
    }));
    setBanner({ tone: 'success', text: demand.bsp + ' retomada.' });
  }

  function addEvidence(id: string, type: EvidenceType) {
    const demand = demands.find((item) => item.id === id);
    if (!demand || demand.source === 'hh_readonly') return;
    const label = type === 'start' ? 'Foto inicial · demonstração' : type === 'finish' ? 'Foto final · demonstração' : 'Evidência extra · demonstração';
    updateDemand(id, (item) => ({
      ...item,
      evidences: [
        ...item.evidences,
        { id: uid('evd'), type, label, at: new Date().toISOString(), source: 'demo' },
      ],
      history: appendHistory(item, 'evidence', 'Evidência adicionada', label + ' adicionada ao estágio atual.'),
    }));
    setBanner({ tone: 'success', text: label + ' adicionada.' });
  }

  function openBlock(id: string) {
    setBlockTarget(id);
    setBlockReason('engineering');
    setBlockNote('');
  }

  function confirmBlock() {
    if (!blockTarget) return;
    const demand = demands.find((item) => item.id === blockTarget);
    if (!demand || demand.source === 'hh_readonly') return;
    const note = blockNote.trim() || 'Bloqueio aberto no ambiente demonstrativo.';
    const notification = createNotification(
      demand.sector,
      demand,
      'Demanda bloqueada',
      demand.bsp + ' / ' + demand.iso + ' · ' + blockerLabel[blockReason] + ': ' + note,
      'warning',
    );
    updateDemand(blockTarget, (item) => ({
      ...item,
      status: 'blocked',
      blocker: { reason: blockReason, note, createdAt: new Date().toISOString() },
      history: appendHistory(item, 'blocked', 'Bloqueio aberto', blockerLabel[blockReason] + ': ' + note),
    }), notification);
    setBlockTarget(null);
    setBlockNote('');
    setBanner({ tone: 'warning', text: demand.bsp + ' foi bloqueada e sinalizada ao setor.' });
  }

  function unblockDemand(id: string) {
    const demand = demands.find((item) => item.id === id);
    if (!demand || demand.source === 'hh_readonly') return;
    updateDemand(id, (item) => ({
      ...item,
      status: item.assignedTo ? 'in_progress' : 'new',
      blocker: undefined,
      history: appendHistory(item, 'unblocked', 'Bloqueio resolvido', 'Demanda liberada para continuidade.'),
    }));
    setBanner({ tone: 'success', text: demand.bsp + ' foi desbloqueada.' });
  }

  function completeDemand(id: string) {
    const demand = demands.find((item) => item.id === id);
    if (!demand || demand.source === 'hh_readonly') return;
    const stage = getStage(demand.stageKey);
    if (!stage) return;

    if (stage.photoPolicy === 'required_start_finish') {
      const hasStart = demand.evidences.some((item) => item.type === 'start');
      const hasFinish = demand.evidences.some((item) => item.type === 'finish');
      if (!hasStart || !hasFinish) {
        setBanner({ tone: 'danger', text: 'Esta etapa depende do apontamento: adicione foto inicial e foto final antes de concluir.' });
        return;
      }
    }

    const next = getNextStage(demand.stageKey);
    const now = new Date().toISOString();

    if (!next) {
      const notification = createNotification(
        demand.sector,
        demand,
        'Demanda concluída',
        demand.bsp + ' / ' + demand.iso + ' encerrou o fluxo operacional.',
        'success',
      );
      updateDemand(id, (item) => ({
        ...item,
        status: 'completed',
        progress: 100,
        completedAt: now,
        history: appendHistory(item, 'completed', 'Fluxo concluído', stage.label + ' concluída e demanda encerrada.'),
      }), notification);
      setBanner({ tone: 'success', text: demand.bsp + ' concluiu todo o fluxo operacional.' });
      return;
    }

    const completedHistory = appendHistory(
      demand,
      'completed',
      'Etapa concluída',
      stage.label + ' concluída com sucesso.',
    );
    const handoffHistory = [
      ...completedHistory,
      {
        id: uid('evt'),
        type: 'handoff' as const,
        title: 'Handoff realizado',
        description: 'Demanda enviada de ' + sectorName(demand.sector) + ' para ' + sectorName(next.sector) + '.',
        at: now,
        actor: 'Motor de fluxo · demo',
        sector: next.sector,
      },
    ];
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
      history: handoffHistory,
    };
    const notification = createNotification(
      next.sector,
      updated,
      'Nova demanda na sua caixa',
      updated.bsp + ' / ' + updated.iso + ' chegou de ' + sectorName(demand.sector) + ' para ' + next.label + '.',
      'info',
    );
    updateDemand(id, () => updated, notification);
    setSelectedId(id);
    setBanner({ tone: 'success', text: 'Handoff concluído: ' + sectorName(demand.sector) + ' → ' + sectorName(next.sector) + '.' });
  }

  function markNotificationRead(id: string) {
    setState((currentState) => ({
      ...currentState,
      notifications: currentState.notifications.map((item) => item.id === id ? { ...item, read: true } : item),
    }));
  }

  function markAllNotificationsRead() {
    setState((currentState) => ({
      ...currentState,
      notifications: currentState.notifications.map((item) => item.sector === sector ? { ...item, read: true } : item),
    }));
  }

  function resetDemo() {
    if (!window.confirm('Restaurar todos os dados e ações da demonstração?')) return;
    setState(resetOperationalState());
    setSelectedId(null);
    setFilter('all');
    setSearch('');
    setBanner({ tone: 'success', text: 'Demonstração restaurada para o estado inicial.' });
  }

  const sectorInfo = sectors.find((item) => item.key === sector)!;
  const unreadCount = state.notifications.filter((item) => item.sector === sector && !item.read).length;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">S</div>
          <div><strong>STEP</strong><span>Operational Flow</span></div>
        </div>

        <nav>
          <NavButton active={view === 'queue'} onClick={() => setView('queue')} icon={<Inbox size={19} />} label="Minha Caixa" />
          <NavButton active={view === 'flow'} onClick={() => setView('flow')} icon={<Boxes size={19} />} label="Fluxo Operacional" />
          <NavButton active={view === 'live'} onClick={() => setView('live')} icon={<Activity size={19} />} label="Produção ao Vivo" />
          <NavButton active={view === 'blocks'} onClick={() => setView('blocks')} icon={<AlertTriangle size={19} />} label="Bloqueios" />
          <NavButton active={view === 'notifications'} onClick={() => setView('notifications')} icon={<Bell size={19} />} label="Notificações" badge={unreadCount} />
          <NavButton active={view === 'analytics'} onClick={() => setView('analytics')} icon={<BarChart3 size={19} />} label="Indicadores" />
        </nav>

        <div className="sidebar-foot">
          <ShieldCheck size={18} />
          <div><strong>Ambiente de demonstração</strong><span>Persistência local. Sem escrita no HH ou Tracking.</span></div>
        </div>
        <button className="sidebar-reset" onClick={resetDemo}><RotateCcw size={15} /> Restaurar demo</button>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <span className="eyebrow">PAINEL OPERACIONAL</span>
            <h1>{pageTitle(view, sectorInfo.name)}</h1>
            <p className="page-subtitle">{pageSubtitle(view)}</p>
          </div>
          <div className="top-actions">
            <label className="sector-switcher">
              <span>Visualizar setor</span>
              <select value={sector} onChange={(event) => setSector(event.target.value as SectorKey)}>
                {sectors.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}
              </select>
            </label>
            <button className="icon-button" title="Notificações" onClick={() => setView('notifications')}>
              <Bell size={20} />
              {unreadCount > 0 && <span className="notification-count">{unreadCount > 9 ? '9+' : unreadCount}</span>}
            </button>
          </div>
        </header>

        <div className="demo-banner">
          <ShieldCheck size={18} />
          <div>
            <strong>Demonstração pública segura.</strong>
            <span> Os dados exibidos são fictícios. O Supabase operacional foi validado somente para leitura administrativa e continua protegido por RLS.</span>
          </div>
        </div>

        {hhError && <div className="error-banner"><AlertTriangle size={18} /> {hhError} O painel segue disponível no modo demonstrativo.</div>}
        {banner && <div className={'action-banner ' + banner.tone}>{banner.text}<button onClick={() => setBanner(null)}><X size={15} /></button></div>}

        {view === 'queue' && (
          <>
            <section className="kpi-grid">
              <Kpi label="Com meu setor" value={counts.total} icon={<Inbox size={20} />} tone="blue" />
              <Kpi label="Novas" value={counts.new} icon={<ListChecks size={20} />} tone="cyan" />
              <Kpi label="Em execução" value={counts.inProgress} icon={<Activity size={20} />} tone="green" />
              <Kpi label="Bloqueadas" value={counts.blocked} icon={<AlertTriangle size={20} />} tone="amber" />
              <Kpi label="Atrasadas" value={counts.late} icon={<Clock3 size={20} />} tone="red" />
            </section>

            <section className="panel">
              <div className="panel-head queue-head">
                <div>
                  <span className="eyebrow">DEMANDAS ATUAIS</span>
                  <h2>O que {sectorInfo.name} precisa resolver agora</h2>
                  <p>A caixa mostra somente demandas cujo dono operacional atual é este setor.</p>
                </div>
                <div className="search-box">
                  <Search size={17} />
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="BSP, ISO, etapa, projeto..." />
                </div>
              </div>

              <div className="filter-row">
                <Filter size={16} />
                {([
                  ['all', 'Todas'],
                  ['new', 'Novas'],
                  ['in_progress', 'Em execução'],
                  ['waiting', 'Aguardando'],
                  ['blocked', 'Bloqueadas'],
                  ['late', 'Atrasadas'],
                  ['completed', 'Concluídas'],
                ] as [QueueFilter, string][]).map(([key, label]) => (
                  <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>
                ))}
              </div>

              <div className="demand-list">
                {visible.map((demand) => (
                  <DemandCard
                    key={demand.id}
                    demand={demand}
                    onOpen={() => setSelectedId(demand.id)}
                    onAssume={() => assumeDemand(demand.id)}
                  />
                ))}
                {!visible.length && (
                  <div className="empty-state">
                    <CheckCircle2 size={30} />
                    <strong>Nenhuma demanda nesta visão.</strong>
                    <span>Altere o filtro ou a busca para consultar outras demandas.</span>
                  </div>
                )}
              </div>
            </section>

            <section className="panel upcoming-panel">
              <div className="panel-head">
                <div>
                  <span className="eyebrow">PRÓXIMAS PARA O SETOR</span>
                  <h2>Carga a caminho de {sectorInfo.name}</h2>
                  <p>O setor consegue se antecipar antes do handoff oficial.</p>
                </div>
                <span className="count-chip">{upcoming.length} previstas</span>
              </div>
              <div className="upcoming-grid">
                {upcoming.map((item) => (
                  <button className="upcoming-card" key={item.id} onClick={() => setSelectedId(item.id)}>
                    <div className="upcoming-top">
                      <div><strong>{item.bsp}</strong><span>{item.iso}</span></div>
                      <span className={'priority ' + item.priority}>{priorityLabel[item.priority]}</span>
                    </div>
                    <div className="progress-line"><i style={{ width: item.progress + '%' }} /></div>
                    <div className="upcoming-meta">
                      <span>{sectorName(item.sector)} · {item.stage} · {item.progress}%</span>
                      <ChevronRight size={16} />
                    </div>
                  </button>
                ))}
                {!upcoming.length && <div className="empty-inline">Nenhuma demanda prevista para este setor.</div>}
              </div>
            </section>
          </>
        )}

        {view === 'flow' && <FlowBoard demands={demands} onOpen={setSelectedId} onSector={(value) => { setSector(value); setView('queue'); }} />}
        {view === 'live' && <LiveProduction demands={demands} loading={loadingHH} onOpen={setSelectedId} />}
        {view === 'blocks' && <BlocksView demands={demands} onOpen={setSelectedId} onUnblock={unblockDemand} />}
        {view === 'notifications' && (
          <NotificationsView
            items={notifications}
            onRead={markNotificationRead}
            onReadAll={markAllNotificationsRead}
            onOpen={(id) => { setSelectedId(id); }}
          />
        )}
        {view === 'analytics' && <Analytics demands={demands} />}
      </main>

      {selected && (
        <DemandDrawer
          demand={selected}
          onClose={() => setSelectedId(null)}
          onAssume={() => assumeDemand(selected.id)}
          onProgress={() => advanceProgress(selected.id)}
          onWaiting={() => setWaiting(selected.id)}
          onResume={() => resumeDemand(selected.id)}
          onBlock={() => openBlock(selected.id)}
          onUnblock={() => unblockDemand(selected.id)}
          onEvidence={(type) => addEvidence(selected.id, type)}
          onComplete={() => completeDemand(selected.id)}
        />
      )}

      {blockTarget && (
        <BlockDialog
          reason={blockReason}
          note={blockNote}
          onReason={setBlockReason}
          onNote={setBlockNote}
          onClose={() => setBlockTarget(null)}
          onConfirm={confirmBlock}
        />
      )}
    </div>
  );
}

function pageTitle(view: ViewKey, sector: string) {
  if (view === 'queue') return sector + ' · Minha Caixa';
  if (view === 'flow') return 'Fluxo Operacional';
  if (view === 'live') return 'Produção ao Vivo';
  if (view === 'blocks') return 'Central de Bloqueios';
  if (view === 'notifications') return 'Central de Notificações';
  return 'Indicadores Operacionais';
}

function pageSubtitle(view: ViewKey) {
  if (view === 'queue') return 'Demandas atuais, próximas entradas e responsabilidade do setor.';
  if (view === 'flow') return 'Visão ponta a ponta da demanda entre os setores.';
  if (view === 'live') return 'Atividades dependentes do apontamento e progresso de execução.';
  if (view === 'blocks') return 'Pendências que impedem o fluxo e exigem tratamento.';
  if (view === 'notifications') return 'Eventos, handoffs, alertas e mudanças relevantes.';
  return 'Leitura do WIP, filas, SLA e gargalos do estado atual.';
}

function NavButton({ active, onClick, icon, label, badge }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: number }) {
  return (
    <button className={active ? 'active' : ''} onClick={onClick}>
      {icon}<span>{label}</span>{Boolean(badge) && <i className="nav-badge">{badge! > 9 ? '9+' : badge}</i>}
    </button>
  );
}

function Kpi({ label, value, icon, tone }: { label: string; value: number; icon: React.ReactNode; tone: string }) {
  return <div className={'kpi ' + tone}><div className="kpi-icon">{icon}</div><div><span>{label}</span><strong>{value}</strong></div></div>;
}

function DemandCard({ demand, onOpen, onAssume }: { demand: Demand; onOpen: () => void; onAssume: () => void }) {
  const status = effectiveStatus(demand);
  const next = getNextStage(demand.stageKey);
  return (
    <article className={'demand-card status-' + status}>
      <div className="demand-identity">
        <div className="status-rail" />
        <div>
          <div className="demand-title"><strong>{demand.bsp}</strong><span>{demand.iso}</span></div>
          <span className="subtle">{demand.project ?? 'Projeto'} · {demand.client ?? 'Cliente'}</span>
        </div>
      </div>
      <div className="stage-cell">
        <span>Etapa atual</span>
        <strong>{demand.stage}</strong>
        <small>{demand.originSector ? 'Veio de ' + sectorName(demand.originSector) : 'Setor ' + sectorName(demand.sector)}</small>
      </div>
      <div className="owner-cell">
        <span>Responsável</span>
        <strong>{demand.assignedTo ?? 'Não atribuída'}</strong>
        <small>Na caixa há {elapsedLabel(demand.enteredAt)}</small>
      </div>
      <div className="next-cell">
        <span>Próximo destino</span>
        <strong>{next ? sectorName(next.sector) : 'Encerramento'}</strong>
        <small>{next?.label ?? 'Fim do fluxo'}</small>
      </div>
      <div className="badges">
        <span className={'status-badge ' + status}>{statusLabel[status]}</span>
        <span className={'priority ' + demand.priority}>{priorityLabel[demand.priority]}</span>
      </div>
      <div className="actions">
        {demand.status === 'new' && demand.source === 'demo' && <button className="primary small" onClick={onAssume}><UserCheck size={16} /> Assumir</button>}
        <button className="secondary small" onClick={onOpen}><Eye size={16} /> Detalhes</button>
      </div>
    </article>
  );
}

function FlowBoard({ demands, onOpen, onSector }: { demands: Demand[]; onOpen: (id: string) => void; onSector: (sector: SectorKey) => void }) {
  return (
    <section className="panel flow-panel">
      <div className="panel-head">
        <div><span className="eyebrow">PIPELINE</span><h2>Onde cada demanda está agora</h2><p>Cada coluna representa o dono operacional atual da demanda.</p></div>
        <span className="count-chip">{demands.filter((item) => item.status !== 'completed').length} em fluxo</span>
      </div>
      <div className="flow-board">
        {sectors.map((sector) => {
          const items = demands.filter((item) => item.sector === sector.key && item.status !== 'completed')
            .sort((a, b) => priorityWeight[b.priority] - priorityWeight[a.priority]);
          return (
            <div className="flow-column" key={sector.key}>
              <button className="flow-column-head" onClick={() => onSector(sector.key)}>
                <div><span>{sector.shortName}</span><strong>{sector.name}</strong></div><b>{items.length}</b>
              </button>
              <div className="flow-column-body">
                {items.map((item) => {
                  const status = effectiveStatus(item);
                  return (
                    <button className={'flow-card status-' + status} key={item.id} onClick={() => onOpen(item.id)}>
                      <div><strong>{item.bsp}</strong><span>{item.iso}</span></div>
                      <p>{item.stage}</p>
                      <div className="flow-card-meta"><span className={'status-badge ' + status}>{statusLabel[status]}</span><small>{item.progress}%</small></div>
                    </button>
                  );
                })}
                {!items.length && <div className="flow-empty">Sem demandas</div>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function LiveProduction({ demands, loading, onOpen }: { demands: Demand[]; loading: boolean; onOpen: (id: string) => void }) {
  const live = demands.filter((item) => {
    const stage = getStage(item.stageKey);
    return stage?.usesPointing && item.status !== 'completed';
  }).sort((a, b) => {
    if (a.status === 'in_progress' && b.status !== 'in_progress') return -1;
    if (b.status === 'in_progress' && a.status !== 'in_progress') return 1;
    return new Date(a.enteredAt).getTime() - new Date(b.enteredAt).getTime();
  });

  return (
    <section className="panel">
      <div className="panel-head">
        <div><span className="eyebrow">APONTAMENTO</span><h2>Atividades de chão de fábrica</h2><p>Etapas configuradas para receber início/fim, HH e evidências do aplicativo de apontamento.</p></div>
        <span className="count-chip">{loading ? 'Lendo HH...' : live.length + ' atividades'}</span>
      </div>
      <div className="live-table">
        <div className="live-row header"><span>BSP / ISO</span><span>Atividade</span><span>Setor</span><span>Progresso</span><span>Evidências</span><span>Origem</span></div>
        {live.map((item) => (
          <button className="live-row" key={item.id} onClick={() => onOpen(item.id)}>
            <span><strong>{item.bsp}</strong><small>{item.iso}</small></span>
            <span>{item.stage}</span>
            <span>{sectorName(item.sector)}</span>
            <span><div className="mini-progress"><i style={{ width: item.progress + '%' }} /></div><small>{item.progress}%</small></span>
            <span>{item.evidences.filter((ev) => ev.type === 'start').length ? 'Início ✓' : 'Início —'} · {item.evidences.filter((ev) => ev.type === 'finish').length ? 'Fim ✓' : 'Fim —'}</span>
            <span className={item.source === 'hh_readonly' ? 'source-live' : 'source-mock'}>{item.source === 'hh_readonly' ? 'HH leitura' : 'Demo'}</span>
          </button>
        ))}
        {!live.length && <div className="empty-state"><Activity size={30} /><strong>Nenhuma atividade de apontamento em fluxo.</strong></div>}
      </div>
    </section>
  );
}

function BlocksView({ demands, onOpen, onUnblock }: { demands: Demand[]; onOpen: (id: string) => void; onUnblock: (id: string) => void }) {
  const blocked = demands.filter((item) => item.status === 'blocked').sort((a, b) => new Date(a.blocker?.createdAt ?? a.enteredAt).getTime() - new Date(b.blocker?.createdAt ?? b.enteredAt).getTime());
  return (
    <section className="panel">
      <div className="panel-head">
        <div><span className="eyebrow">EXCEÇÕES</span><h2>Demandas impedidas de avançar</h2><p>Visão única dos bloqueios, independentemente do setor.</p></div>
        <span className="count-chip warning">{blocked.length} bloqueadas</span>
      </div>
      <div className="block-list">
        {blocked.map((item) => (
          <article className="block-card" key={item.id}>
            <div className="block-icon"><AlertTriangle size={19} /></div>
            <div className="block-main">
              <div className="block-title"><strong>{item.bsp}</strong><span>{item.iso}</span><em>{sectorName(item.sector)}</em></div>
              <p>{item.blocker ? blockerLabel[item.blocker.reason] + ' · ' + item.blocker.note : 'Bloqueio sem observação.'}</p>
              <small>Aberto há {elapsedLabel(item.blocker?.createdAt ?? item.enteredAt)}</small>
            </div>
            <div className="actions">
              {item.source === 'demo' && <button className="primary small" onClick={() => onUnblock(item.id)}><PlayCircle size={15} /> Resolver</button>}
              <button className="secondary small" onClick={() => onOpen(item.id)}><Eye size={15} /> Detalhes</button>
            </div>
          </article>
        ))}
        {!blocked.length && <div className="empty-state"><CheckCircle2 size={30} /><strong>Nenhum bloqueio aberto.</strong></div>}
      </div>
    </section>
  );
}

function NotificationsView({ items, onRead, onReadAll, onOpen }: { items: NotificationItem[]; onRead: (id: string) => void; onReadAll: () => void; onOpen: (id: string) => void }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div><span className="eyebrow">EVENTOS DO SETOR</span><h2>Notificações operacionais</h2><p>Handoffs, alertas de execução, bloqueios e conclusões.</p></div>
        <button className="secondary compact" onClick={onReadAll}>Marcar todas como lidas</button>
      </div>
      <div className="notification-list">
        {items.map((item) => (
          <article key={item.id} className={'notification ' + item.severity + (!item.read ? ' unread' : '')}>
            <div className="notification-icon"><Bell size={18} /></div>
            <button className="notification-content" onClick={() => { onRead(item.id); if (item.demandId) onOpen(item.demandId); }}>
              <strong>{item.title}</strong>
              <p>{item.message}</p>
              <span>{dateTimeLabel(item.createdAt)}</span>
            </button>
            {!item.read && <button className="unread-button" title="Marcar como lida" onClick={() => onRead(item.id)} />}
          </article>
        ))}
        {!items.length && <div className="empty-state"><Bell size={30} /><strong>Sem notificações para este setor.</strong></div>}
      </div>
    </section>
  );
}

function Analytics({ demands }: { demands: Demand[] }) {
  const active = demands.filter((item) => item.status !== 'completed');
  const completed = demands.filter((item) => item.status === 'completed').length;
  const blocked = active.filter((item) => item.status === 'blocked').length;
  const late = active.filter((item) => effectiveStatus(item) === 'late').length;
  const ages = active.map((item) => elapsedMinutes(item.enteredAt));
  const avgAge = ages.length ? Math.round(ages.reduce((sum, value) => sum + value, 0) / ages.length) : 0;
  const bySector = sectors.map((sector) => ({
    sector,
    count: active.filter((item) => item.sector === sector.key).length,
    blocked: active.filter((item) => item.sector === sector.key && item.status === 'blocked').length,
  }));
  const max = Math.max(1, ...bySector.map((item) => item.count));

  return (
    <>
      <section className="kpi-grid analytics-kpis">
        <Kpi label="WIP total" value={active.length} icon={<Boxes size={20} />} tone="blue" />
        <Kpi label="Concluídas" value={completed} icon={<CheckCircle2 size={20} />} tone="green" />
        <Kpi label="Bloqueios" value={blocked} icon={<AlertTriangle size={20} />} tone="amber" />
        <Kpi label="Fora do SLA" value={late} icon={<Clock3 size={20} />} tone="red" />
        <Kpi label="Idade média (min)" value={avgAge} icon={<BarChart3 size={20} />} tone="cyan" />
      </section>
      <section className="analytics-grid">
        <div className="panel analytics-panel">
          <div className="panel-head"><div><span className="eyebrow">WIP POR SETOR</span><h2>Distribuição da carga atual</h2></div></div>
          <div className="bar-list">
            {bySector.map((item) => (
              <div className="bar-row" key={item.sector.key}>
                <div className="bar-label"><strong>{item.sector.name}</strong><span>{item.count} demanda(s){item.blocked ? ' · ' + item.blocked + ' bloqueada(s)' : ''}</span></div>
                <div className="bar-track"><i style={{ width: (item.count / max * 100) + '%' }} /></div>
                <b>{item.count}</b>
              </div>
            ))}
          </div>
        </div>
        <div className="panel analytics-panel">
          <div className="panel-head"><div><span className="eyebrow">REGRAS DO FLUXO</span><h2>Etapas e SLA configurados</h2></div></div>
          <div className="rules-list">
            {workflowStages.map((stage, index) => (
              <div className="rule-row" key={stage.key}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <div><strong>{stage.label}</strong><small>{sectorName(stage.sector)} · SLA {Math.round(stage.slaMinutes / 60 * 10) / 10}h · {photoPolicyLabel(stage.photoPolicy)}</small></div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function DemandDrawer(props: {
  demand: Demand;
  onClose: () => void;
  onAssume: () => void;
  onProgress: () => void;
  onWaiting: () => void;
  onResume: () => void;
  onBlock: () => void;
  onUnblock: () => void;
  onEvidence: (type: EvidenceType) => void;
  onComplete: () => void;
}) {
  const { demand } = props;
  const stage = getStage(demand.stageKey);
  const next = getNextStage(demand.stageKey);
  const status = effectiveStatus(demand);
  const readOnly = demand.source === 'hh_readonly';
  const hasStart = demand.evidences.some((item) => item.type === 'start');
  const hasFinish = demand.evidences.some((item) => item.type === 'finish');

  return (
    <div className="drawer-backdrop" onMouseDown={props.onClose}>
      <aside className="drawer" onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <div><span className="eyebrow">DETALHE DA DEMANDA</span><h2>{demand.bsp} <span>/ {demand.iso}</span></h2><p>{demand.project} · {demand.client}</p></div>
          <button className="icon-button" onClick={props.onClose}><X size={20} /></button>
        </div>

        <div className="drawer-status">
          <span className={'status-badge ' + status}>{statusLabel[status]}</span>
          <span className={'priority ' + demand.priority}>{priorityLabel[demand.priority]}</span>
          {stage?.usesPointing && <span className="pointing-chip">APONTAMENTO</span>}
        </div>

        <section className="detail-section">
          <h3>Fluxo atual</h3>
          <div className="flow-line">
            <div><span>Origem</span><strong>{sectorName(demand.originSector)}</strong></div>
            <ChevronRight />
            <div className="current"><span>Agora</span><strong>{sectorName(demand.sector)}</strong></div>
            <ChevronRight />
            <div><span>Próximo</span><strong>{next ? sectorName(next.sector) : 'Encerramento'}</strong></div>
          </div>
        </section>

        <div className="detail-grid">
          <Detail label="Etapa" value={demand.stage} />
          <Detail label="Responsável" value={demand.assignedTo ?? 'Não atribuída'} />
          <Detail label="Entrada no setor" value={dateTimeLabel(demand.enteredAt)} />
          <Detail label="Tempo na caixa" value={elapsedLabel(demand.enteredAt)} />
          <Detail label="SLA" value={dateTimeLabel(demand.slaDueAt)} />
          <Detail label="HH / duração" value={demand.hhMinutes ? demand.hhMinutes + ' min' : '—'} />
        </div>

        <section className="detail-section">
          <div className="section-title-row"><h3>Progresso</h3><strong>{demand.progress}%</strong></div>
          <div className="large-progress"><i style={{ width: demand.progress + '%' }} /></div>
          {stage && <p className="rule-note">{photoPolicyLabel(stage.photoPolicy)}{stage.usesPointing ? ' · etapa vinculada ao apontamento.' : ''}</p>}
        </section>

        {demand.blocker && (
          <div className="blocker-box">
            <AlertTriangle size={18} />
            <div><strong>Bloqueada por {blockerLabel[demand.blocker.reason]}</strong><p>{demand.blocker.note}</p><span>Desde {dateTimeLabel(demand.blocker.createdAt)}</span></div>
          </div>
        )}

        <section className="detail-section">
          <div className="section-title-row"><h3>Evidências da etapa atual</h3><span>{demand.evidences.length}</span></div>
          <div className="evidence-grid">
            <EvidenceState label="Foto inicial" ready={hasStart} />
            <EvidenceState label="Foto final" ready={hasFinish} />
            {demand.evidences.filter((item) => item.type === 'extra').map((item) => <EvidenceState key={item.id} label={item.label} ready />)}
          </div>
          {!readOnly && (
            <div className="evidence-actions">
              {!hasStart && <button className="secondary compact" onClick={() => props.onEvidence('start')}><ImagePlus size={15} /> Adicionar início</button>}
              {!hasFinish && <button className="secondary compact" onClick={() => props.onEvidence('finish')}><ImagePlus size={15} /> Adicionar fim</button>}
              <button className="secondary compact" onClick={() => props.onEvidence('extra')}><ImagePlus size={15} /> Extra</button>
            </div>
          )}
        </section>

        {demand.note && <div className="note-box"><strong>Observação</strong><p>{demand.note}</p></div>}

        <section className="detail-section">
          <h3>Rastreabilidade</h3>
          <div className="timeline">
            {[...demand.history].reverse().map((event) => (
              <div className="timeline-item" key={event.id}>
                <i />
                <div><strong>{event.title}</strong><p>{event.description}</p><span>{dateTimeLabel(event.at)} · {event.actor} · {sectorName(event.sector)}</span></div>
              </div>
            ))}
          </div>
        </section>

        <div className="read-only-box">
          <ShieldCheck size={18} />
          <div>
            <strong>{readOnly ? 'Registro lido do Apontamento HH' : 'Ação isolada da demonstração'}</strong>
            <span>{readOnly ? 'Este painel não oferece qualquer comando de escrita sobre o HH.' : 'As ações abaixo são salvas apenas no navegador e não alteram sistemas da STEP.'}</span>
          </div>
        </div>

        {!readOnly && demand.status !== 'completed' && (
          <div className="drawer-actions">
            {demand.status === 'new' && <button className="primary" onClick={props.onAssume}><UserCheck size={16} /> Assumir demanda</button>}
            {demand.status === 'in_progress' && <button className="secondary" onClick={props.onProgress}><Activity size={16} /> Avançar 25%</button>}
            {demand.status === 'in_progress' && <button className="secondary" onClick={props.onWaiting}><PauseCircle size={16} /> Aguardar</button>}
            {demand.status === 'waiting' && <button className="secondary" onClick={props.onResume}><PlayCircle size={16} /> Retomar</button>}
            {demand.status !== 'blocked' && <button className="danger-button" onClick={props.onBlock}><XCircle size={16} /> Bloquear</button>}
            {demand.status === 'blocked' && <button className="primary" onClick={props.onUnblock}><PlayCircle size={16} /> Resolver bloqueio</button>}
            {(demand.status === 'in_progress' || demand.status === 'waiting' || demand.status === 'late') && <button className="complete-button" onClick={props.onComplete}><CheckCircle2 size={16} /> Concluir etapa e enviar</button>}
          </div>
        )}
      </aside>
    </div>
  );
}

function EvidenceState({ label, ready }: { label: string; ready: boolean }) {
  return <div className={'evidence-state ' + (ready ? 'ready' : 'missing')}><div>{ready ? <CheckCircle2 size={17} /> : <ImagePlus size={17} />}</div><span>{label}</span><strong>{ready ? 'Disponível' : 'Pendente'}</strong></div>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="detail-item"><span>{label}</span><strong>{value}</strong></div>;
}

function BlockDialog(props: {
  reason: keyof typeof blockerLabel;
  note: string;
  onReason: (value: keyof typeof blockerLabel) => void;
  onNote: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div className="modal-card" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head"><div><span className="eyebrow">BLOQUEIO</span><h2>Sinalizar impedimento</h2></div><button className="icon-button" onClick={props.onClose}><X size={19} /></button></div>
        <label className="form-field"><span>Motivo</span><select value={props.reason} onChange={(event) => props.onReason(event.target.value as keyof typeof blockerLabel)}>{Object.entries(blockerLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="form-field"><span>Observação</span><textarea value={props.note} onChange={(event) => props.onNote(event.target.value)} placeholder="Descreva o que impede a continuidade..." rows={4} /></label>
        <div className="modal-actions"><button className="secondary" onClick={props.onClose}>Cancelar</button><button className="danger-button" onClick={props.onConfirm}><AlertTriangle size={16} /> Confirmar bloqueio</button></div>
      </div>
    </div>
  );
}
