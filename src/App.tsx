import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bell,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Eye,
  Filter,
  Inbox,
  Layers3,
  Search,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { mockDemands, mockNotifications, sectors } from './data/mock';
import { liveHHReadOnlyEnabled, loadHHSessionsReadOnly } from './services/hhReadOnly';
import type { Demand, DemandStatus, SectorKey } from './types';

type ViewKey = 'queue' | 'overview' | 'live' | 'notifications';
type QueueFilter = 'all' | DemandStatus;

const statusLabel: Record<DemandStatus, string> = {
  new: 'Nova',
  in_progress: 'Em execução',
  waiting: 'Aguardando',
  blocked: 'Bloqueada',
  late: 'Atrasada',
  completed: 'Concluída',
  upcoming: 'Próxima',
};

const priorityLabel = {
  critical: 'Crítica',
  high: 'Alta',
  normal: 'Normal',
  low: 'Baixa',
};

function sectorName(key?: SectorKey) {
  return sectors.find((sector) => sector.key === key)?.name ?? '—';
}

function elapsedLabel(date: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}min` : `${hours}h`;
}

function dateTimeLabel(date?: string) {
  if (!date) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(date));
}

export default function App() {
  const [view, setView] = useState<ViewKey>('queue');
  const [sector, setSector] = useState<SectorKey>('qualidade');
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [search, setSearch] = useState('');
  const [demands, setDemands] = useState<Demand[]>(mockDemands);
  const [selected, setSelected] = useState<Demand | null>(null);
  const [loadingHH, setLoadingHH] = useState(liveHHReadOnlyEnabled);
  const [hhError, setHHError] = useState<string | null>(null);

  useEffect(() => {
    if (!liveHHReadOnlyEnabled) return;
    loadHHSessionsReadOnly()
      .then((live) => {
        if (live.length) setDemands([...live, ...mockDemands]);
      })
      .catch((error: unknown) => setHHError(error instanceof Error ? error.message : 'Falha ao ler o HH.'))
      .finally(() => setLoadingHH(false));
  }, []);

  const current = useMemo(
    () => demands.filter((d) => d.sector === sector && d.status !== 'upcoming'),
    [demands, sector],
  );

  const upcoming = useMemo(
    () => demands.filter((d) => d.nextSector === sector && d.sector !== sector && d.status !== 'completed'),
    [demands, sector],
  );

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return current.filter((d) => {
      const matchesFilter = filter === 'all' || d.status === filter;
      const matchesSearch = !term || [d.bsp, d.iso, d.stage, d.project, d.assignedTo]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term));
      return matchesFilter && matchesSearch;
    });
  }, [current, filter, search]);

  const notifications = useMemo(
    () => mockNotifications.filter((item) => item.sector === sector),
    [sector],
  );

  const counts = useMemo(() => ({
    total: current.filter((d) => d.status !== 'completed').length,
    new: current.filter((d) => d.status === 'new').length,
    inProgress: current.filter((d) => d.status === 'in_progress').length,
    blocked: current.filter((d) => d.status === 'blocked').length,
    late: current.filter((d) => d.status === 'late').length,
  }), [current]);

  function simulateAssume(id: string) {
    setDemands((items) => items.map((item) => item.id === id
      ? { ...item, status: 'in_progress', assignedTo: 'Você · ambiente isolado' }
      : item));
    setSelected((item) => item?.id === id
      ? { ...item, status: 'in_progress', assignedTo: 'Você · ambiente isolado' }
      : item);
  }

  const sectorInfo = sectors.find((item) => item.key === sector)!;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">S</div>
          <div><strong>STEP</strong><span>Operational Flow</span></div>
        </div>

        <nav>
          <button className={view === 'queue' ? 'active' : ''} onClick={() => setView('queue')}><Inbox size={19} /> Minha Caixa</button>
          <button className={view === 'overview' ? 'active' : ''} onClick={() => setView('overview')}><Boxes size={19} /> Visão Geral</button>
          <button className={view === 'live' ? 'active' : ''} onClick={() => setView('live')}><Activity size={19} /> Produção ao Vivo</button>
          <button className={view === 'notifications' ? 'active' : ''} onClick={() => setView('notifications')}><Bell size={19} /> Notificações</button>
        </nav>

        <div className="sidebar-foot">
          <ShieldCheck size={18} />
          <div><strong>Ambiente isolado</strong><span>Nenhuma ação grava no HH.</span></div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <span className="eyebrow">PAINEL OPERACIONAL</span>
            <h1>{view === 'queue' ? `${sectorInfo.name} · Minha Caixa` : view === 'overview' ? 'Visão Geral da Operação' : view === 'live' ? 'Produção ao Vivo' : 'Central de Notificações'}</h1>
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
              {notifications.some((n) => !n.read) && <span className="notification-dot" />}
            </button>
          </div>
        </header>

        <div className="safety-banner">
          <ShieldCheck size={18} />
          <div><strong>Modo isolado ativo.</strong> O painel usa dados simulados por padrão. {liveHHReadOnlyEnabled ? 'A integração HH está habilitada somente para leitura.' : 'A integração HH real está desligada.'}</div>
        </div>

        {hhError && <div className="error-banner"><AlertTriangle size={18} /> {hhError} O painel continua em modo simulado.</div>}

        {view === 'queue' && (
          <>
            <section className="kpi-grid">
              <Kpi label="Com meu setor" value={counts.total} icon={<Inbox size={20} />} tone="blue" />
              <Kpi label="Novas" value={counts.new} icon={<Layers3 size={20} />} tone="cyan" />
              <Kpi label="Em execução" value={counts.inProgress} icon={<Activity size={20} />} tone="green" />
              <Kpi label="Bloqueadas" value={counts.blocked} icon={<AlertTriangle size={20} />} tone="amber" />
              <Kpi label="Atrasadas" value={counts.late} icon={<Clock3 size={20} />} tone="red" />
            </section>

            <section className="panel">
              <div className="panel-head queue-head">
                <div><span className="eyebrow">DEMANDAS ATUAIS</span><h2>O que {sectorInfo.name} precisa resolver agora</h2></div>
                <div className="search-box"><Search size={17} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="BSP, ISO, etapa, responsável..." /></div>
              </div>

              <div className="filter-row">
                <Filter size={16} />
                {([
                  ['all', 'Todas'], ['new', 'Novas'], ['in_progress', 'Em execução'], ['waiting', 'Aguardando'], ['blocked', 'Bloqueadas'], ['late', 'Atrasadas'], ['completed', 'Concluídas'],
                ] as [QueueFilter, string][]).map(([key, label]) => (
                  <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>
                ))}
              </div>

              <div className="demand-list">
                {visible.map((demand) => <DemandCard key={demand.id} demand={demand} onOpen={() => setSelected(demand)} onAssume={() => simulateAssume(demand.id)} />)}
                {!visible.length && <div className="empty-state"><CheckCircle2 size={28} /><strong>Nenhuma demanda nesta visão.</strong><span>Altere o filtro ou a busca para consultar outras demandas.</span></div>}
              </div>
            </section>

            <section className="panel upcoming-panel">
              <div className="panel-head">
                <div><span className="eyebrow">PRÓXIMAS</span><h2>Demandas a caminho de {sectorInfo.name}</h2><p>Antecipação da carga antes do handoff oficial.</p></div>
                <span className="count-chip">{upcoming.length} previstas</span>
              </div>
              <div className="upcoming-grid">
                {upcoming.map((item) => (
                  <button className="upcoming-card" key={item.id} onClick={() => setSelected(item)}>
                    <div><strong>{item.bsp}</strong><span>{item.iso}</span></div>
                    <div className="progress-line"><i style={{ width: `${item.progress}%` }} /></div>
                    <div className="upcoming-meta"><span>{sectorName(item.sector)} · {item.progress}%</span><ChevronRight size={16} /></div>
                  </button>
                ))}
                {!upcoming.length && <div className="empty-inline">Nenhuma demanda prevista para este setor.</div>}
              </div>
            </section>
          </>
        )}

        {view === 'overview' && <Overview demands={demands} onSector={setSector} onGoQueue={() => setView('queue')} />}
        {view === 'live' && <LiveProduction demands={demands} loading={loadingHH} onOpen={setSelected} />}
        {view === 'notifications' && <Notifications items={notifications} />}
      </main>

      {selected && <DemandDrawer demand={selected} onClose={() => setSelected(null)} onAssume={() => simulateAssume(selected.id)} />}
    </div>
  );
}

function Kpi({ label, value, icon, tone }: { label: string; value: number; icon: React.ReactNode; tone: string }) {
  return <div className={`kpi ${tone}`}><div className="kpi-icon">{icon}</div><div><span>{label}</span><strong>{value}</strong></div></div>;
}

function DemandCard({ demand, onOpen, onAssume }: { demand: Demand; onOpen: () => void; onAssume: () => void }) {
  return (
    <article className={`demand-card status-${demand.status}`}>
      <div className="demand-identity"><div className="status-rail" /><div><div className="demand-title"><strong>{demand.bsp}</strong><span>{demand.iso}</span></div><span className="subtle">{demand.project ?? 'Projeto'} · {demand.client ?? 'Cliente'}</span></div></div>
      <div className="stage-cell"><span>Etapa atual</span><strong>{demand.stage}</strong><small>{demand.originSector ? `Veio de ${sectorName(demand.originSector)}` : `Setor ${sectorName(demand.sector)}`}</small></div>
      <div className="owner-cell"><span>Responsável</span><strong>{demand.assignedTo ?? 'Não atribuída'}</strong><small>Na caixa há {elapsedLabel(demand.enteredAt)}</small></div>
      <div className="badges"><span className={`status-badge ${demand.status}`}>{statusLabel[demand.status]}</span><span className={`priority ${demand.priority}`}>{priorityLabel[demand.priority]}</span></div>
      <div className="actions">{demand.status === 'new' && <button className="primary small" onClick={onAssume}><Users size={16} /> Assumir</button>}<button className="secondary small" onClick={onOpen}><Eye size={16} /> Detalhes</button></div>
    </article>
  );
}

function Overview({ demands, onSector, onGoQueue }: { demands: Demand[]; onSector: (sector: SectorKey) => void; onGoQueue: () => void }) {
  return (
    <section className="panel">
      <div className="panel-head"><div><span className="eyebrow">FLUXO POR SETOR</span><h2>Distribuição atual das demandas</h2><p>Clique em um setor para abrir a respectiva caixa.</p></div></div>
      <div className="sector-grid">
        {sectors.map((sector) => {
          const items = demands.filter((d) => d.sector === sector.key && d.status !== 'completed' && d.status !== 'upcoming');
          const late = items.filter((d) => d.status === 'late').length;
          const blocked = items.filter((d) => d.status === 'blocked').length;
          return <button key={sector.key} className="sector-card" onClick={() => { onSector(sector.key); onGoQueue(); }}><div className="sector-card-head"><span>{sector.shortName}</span><ChevronRight size={18} /></div><strong>{sector.name}</strong><div className="sector-number">{items.length}</div><small>{late} atrasada(s) · {blocked} bloqueada(s)</small></button>;
        })}
      </div>
    </section>
  );
}

function LiveProduction({ demands, loading, onOpen }: { demands: Demand[]; loading: boolean; onOpen: (d: Demand) => void }) {
  const live = demands.filter((d) => d.status === 'in_progress' || d.source === 'hh_readonly').slice(0, 100);
  return <section className="panel"><div className="panel-head"><div><span className="eyebrow">APONTAMENTO HH</span><h2>Sessões e atividades em acompanhamento</h2><p>Quando habilitado, os dados reais entram somente por leitura.</p></div>{loading && <span className="count-chip">Lendo HH...</span>}</div><div className="live-table"><div className="live-row header"><span>BSP / ISO</span><span>Atividade</span><span>Setor</span><span>Progresso</span><span>Origem</span></div>{live.map((item) => <button className="live-row" key={item.id} onClick={() => onOpen(item)}><span><strong>{item.bsp}</strong><small>{item.iso}</small></span><span>{item.stage}</span><span>{sectorName(item.sector)}</span><span><div className="mini-progress"><i style={{ width: `${item.progress}%` }} /></div><small>{item.progress}%</small></span><span className={item.source === 'hh_readonly' ? 'source-live' : 'source-mock'}>{item.source === 'hh_readonly' ? 'HH leitura' : 'Simulado'}</span></button>)}</div></section>;
}

function Notifications({ items }: { items: typeof mockNotifications }) {
  return <section className="panel"><div className="panel-head"><div><span className="eyebrow">EVENTOS DO SETOR</span><h2>Notificações operacionais</h2><p>Na próxima fase, leitura, aceite e resolução serão persistidos no schema isolado.</p></div></div><div className="notification-list">{items.map((item) => <article key={item.id} className={`notification ${item.severity}`}><div className="notification-icon"><Bell size={18} /></div><div><strong>{item.title}</strong><p>{item.message}</p><span>{dateTimeLabel(item.createdAt)}</span></div>{!item.read && <i className="unread-dot" />}</article>)}{!items.length && <div className="empty-state"><Bell size={28} /><strong>Sem notificações para este setor.</strong></div>}</div></section>;
}

function DemandDrawer({ demand, onClose, onAssume }: { demand: Demand; onClose: () => void; onAssume: () => void }) {
  return <div className="drawer-backdrop" onMouseDown={onClose}><aside className="drawer" onMouseDown={(e) => e.stopPropagation()}><div className="drawer-head"><div><span className="eyebrow">DETALHE DA DEMANDA</span><h2>{demand.bsp} <span>/ {demand.iso}</span></h2></div><button className="icon-button" onClick={onClose}><X size={20} /></button></div><div className="drawer-status"><span className={`status-badge ${demand.status}`}>{statusLabel[demand.status]}</span><span className={`priority ${demand.priority}`}>{priorityLabel[demand.priority]}</span></div><div className="detail-section"><h3>Fluxo atual</h3><div className="flow-line"><div><span>Origem</span><strong>{sectorName(demand.originSector)}</strong></div><ChevronRight /><div className="current"><span>Agora</span><strong>{sectorName(demand.sector)}</strong></div><ChevronRight /><div><span>Próximo</span><strong>{sectorName(demand.nextSector)}</strong></div></div></div><div className="detail-grid"><Detail label="Etapa" value={demand.stage} /><Detail label="Responsável" value={demand.assignedTo ?? 'Não atribuída'} /><Detail label="Entrada no setor" value={dateTimeLabel(demand.enteredAt)} /><Detail label="SLA" value={dateTimeLabel(demand.slaDueAt)} /><Detail label="HH / duração" value={demand.hhMinutes ? `${demand.hhMinutes} min` : '—'} /><Detail label="Evidências" value={`${demand.photoEvidence} foto(s)`} /></div><div className="detail-section"><h3>Progresso</h3><div className="large-progress"><i style={{ width: `${demand.progress}%` }} /></div><span className="subtle">{demand.progress}% concluído</span></div>{demand.note && <div className="note-box"><strong>Observação</strong><p>{demand.note}</p></div>}<div className="read-only-box"><ShieldCheck size={18} /><div><strong>{demand.source === 'hh_readonly' ? 'Dado lido do Apontamento HH' : 'Dado do ambiente isolado'}</strong><span>Nenhuma alteração deste painel é gravada nas tabelas de HH.</span></div></div>{demand.status === 'new' && <button className="primary drawer-action" onClick={onAssume}><Users size={17} /> Simular assumir demanda</button>}</aside></div>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="detail-item"><span>{label}</span><strong>{value}</strong></div>;
}
