import { useEffect, useMemo, useState } from 'react';
import { Archive, BarChart3, CalendarDays, Database, RefreshCcw, Search } from 'lucide-react';
import {
  loadAnnualSummary,
  loadArchivedProjects,
  loadHistoryHealth,
  type HubAnnualSummary,
  type HubArchivedProject,
  type HubHistoryHealth,
} from './services/opsPanelHub';

function fmtNumber(value: number | string | null | undefined, digits = 0) {
  const numeric = Number(value || 0);
  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number.isFinite(numeric) ? numeric : 0);
}

function fmtDateOnly(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value + (value.length <= 10 ? 'T12:00:00' : ''));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

export default function ArchivePage() {
  const [items, setItems] = useState<HubArchivedProject[]>([]);
  const [summary, setSummary] = useState<HubAnnualSummary[]>([]);
  const [health, setHealth] = useState<HubHistoryHealth | null>(null);
  const [search, setSearch] = useState('');
  const [year, setYear] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([loadAnnualSummary(), loadHistoryHealth()])
      .then(([annual, history]) => {
        if (!active) return;
        setSummary(annual);
        setHealth(history);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Falha ao carregar histórico.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setListLoading(true);
      loadArchivedProjects(year, search, 2000)
        .then((rows) => {
          if (active) {
            setItems(rows);
            setError('');
          }
        })
        .catch((err) => {
          if (active) setError(err instanceof Error ? err.message : 'Falha ao carregar projetos arquivados.');
        })
        .finally(() => {
          if (active) setListLoading(false);
        });
    }, 250);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [year, search]);

  const years = useMemo(
    () => [...summary].map((row) => Number(row.reporting_year)).filter(Boolean).sort((a, b) => b - a),
    [summary],
  );

  const selectedSummary = year
    ? summary.find((row) => Number(row.reporting_year) === year)
    : null;

  const totalProjects = selectedSummary
    ? Number(selectedSummary.projects || 0)
    : Number(health?.archived_projects || items.length);

  return (
    <>
      <section className="portfolio-head">
        <div>
          <span className="eyebrow">Base histórica operacional</span>
          <h1>Arquivados</h1>
          <p>Projetos concluídos permanecem no banco para auditoria, comparativos e relatórios anuais.</p>
        </div>
        <div className="head-actions">
          <span className="sync-chip archive-chip"><Archive size={13} /> Banco histórico STEP</span>
        </div>
      </section>

      {error && <div className="reference-warning"><Database size={17} /><div><strong>Falha na leitura do histórico</strong><p>{error}</p></div></div>}

      <section className="overview-strip archive-overview">
        <div className="overview-icon"><Archive size={25} /></div>
        <div className="overview-copy">
          <strong>{year ? 'Relatório anual · ' + year : 'Histórico consolidado'}</strong>
          <span>Tracking atual, Trackings antigos, ON HOLD e projetos futuros do OPS CORE.</span>
        </div>
        <div className="overview-metric"><strong>{loading ? '...' : fmtNumber(totalProjects)}</strong><span>Projetos arquivados</span></div>
        <div className="overview-metric"><strong>{loading ? '...' : fmtNumber(selectedSummary?.items ?? health?.legacy_history_rows ?? 0)}</strong><span>{year ? 'Itens no ano' : 'Registros históricos'}</span></div>
        <div className="overview-metric"><strong>{loading ? '...' : fmtNumber(selectedSummary?.total_weight_kg ?? 0, 0)}</strong><span>Peso concluído kg</span></div>
        <div className="overview-metric"><strong>{loading ? '...' : fmtNumber(selectedSummary?.hold_days ?? 0, 1)}</strong><span>Dias em ON HOLD</span></div>
        <div className="overview-metric"><strong>{loading ? '...' : fmtNumber(health?.metric_quality_rows ?? 0)}</strong><span>Dados para conferir</span></div>
      </section>

      <section className="section-card archive-year-card">
        <div className="section-card-head">
          <div><span className="section-mono">Relatórios anuais</span><h2>Histórico por ano</h2></div>
          <BarChart3 size={18} />
        </div>
        <div className="archive-year-grid">
          {[...summary].sort((a, b) => Number(b.reporting_year) - Number(a.reporting_year)).map((row) => (
            <button
              type="button"
              key={row.reporting_year}
              className={year === Number(row.reporting_year) ? 'active' : ''}
              onClick={() => setYear((current) => current === Number(row.reporting_year) ? null : Number(row.reporting_year))}
            >
              <span>{row.reporting_year}</span>
              <strong>{fmtNumber(row.projects)} projetos</strong>
              <small>{fmtNumber(row.items)} itens · {fmtNumber(row.total_weight_kg, 0)} kg</small>
              {Number(row.metric_quality_issues || 0) > 0 && <em>{fmtNumber(row.metric_quality_issues)} dado(s) em conferência</em>}
            </button>
          ))}
        </div>
      </section>

      <section className="filters-bar archive-filters">
        <label className="filter-field search-field">
          <Search size={15} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar BSP, cliente, vessel ou PM..." />
          {search && <button type="button" className="search-clear" onClick={() => setSearch('')}>Limpar</button>}
        </label>
        <label className="filter-field select-filter status-filter">
          <CalendarDays size={14} />
          <span>Ano</span>
          <select value={year ?? ''} onChange={(e) => setYear(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Todos</option>
            {years.map((value) => <option value={value} key={value}>{value}</option>)}
          </select>
        </label>
        <button className="soft-btn" onClick={() => { setSearch(''); setYear(null); }}><RefreshCcw size={14} /> Limpar filtros</button>
      </section>

      <section className="archive-table-wrap">
        <div className="archive-table-head">
          <span>BSP</span>
          <span>Cliente / Vessel</span>
          <span>Conclusão</span>
          <span>Itens</span>
          <span>Peso</span>
          <span>M²</span>
          <span>ON HOLD</span>
          <span>Origem</span>
          <span>Status</span>
        </div>

        {items.map((row) => (
          <div className="archive-table-row" key={row.origin + ':' + row.project_core}>
            <span><strong>{row.project_display || row.project_core}</strong><small>{row.project_type || 'Projeto'}</small></span>
            <span><strong>{row.client || 'Não informado'}</strong><small>{row.vessel || '—'}{row.pm ? ' · ' + row.pm : ''}</small></span>
            <span><strong>{fmtDateOnly(row.completed_on)}</strong><small>{row.reporting_year || '—'}</small></span>
            <span><strong>{fmtNumber(row.item_count)}</strong><small>itens</small></span>
            <span><strong>{fmtNumber(row.total_weight_kg, 0)}</strong><small>kg</small></span>
            <span><strong>{fmtNumber(row.total_m2, 1)}</strong><small>m²</small></span>
            <span><strong>{fmtNumber(row.hold_days, 1)}</strong><small>dias</small></span>
            <span><strong>{row.origin === 'OPS_CORE' ? 'OPS CORE' : 'Tracking'}</strong><small>{row.archive_source || 'Histórico'}</small></span>
            <span>
              <span className="status-ref archived"><i />Arquivado</span>
              {Number(row.metric_quality_issues || 0) > 0 && <small className="archive-quality-warning">Conferir {row.metric_quality_issues}</small>}
            </span>
          </div>
        ))}

        {!items.length && (
          <div className="empty-reference">
            {listLoading ? <RefreshCcw size={28} className="spin" /> : <Archive size={28} />}
            <strong>{listLoading ? 'Carregando histórico...' : 'Nenhum projeto arquivado nesta visão.'}</strong>
            <span>{listLoading ? 'Consultando a base histórica.' : 'Altere o ano ou a busca.'}</span>
          </div>
        )}
      </section>
    </>
  );
}
