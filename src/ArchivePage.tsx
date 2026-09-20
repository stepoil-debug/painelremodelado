import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  BarChart3,
  Boxes,
  CalendarDays,
  Clock3,
  Database,
  Factory,
  Gauge,
  RefreshCcw,
  Search,
  Weight,
} from 'lucide-react';
import {
  loadAnnualSummary,
  loadArchivedProjectDetail,
  loadArchivedProjects,
  loadHistoryHealth,
  type HubAnnualSummary,
  type HubArchiveDetail,
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

function textValue(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function numValue(record: Record<string, unknown>, key: string) {
  const value = Number(record[key] || 0);
  return Number.isFinite(value) ? value : 0;
}

function ArchiveDetail({ projectCore, onBack }: { projectCore: string; onBack: () => void }) {
  const [detail, setDetail] = useState<HubArchiveDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    loadArchivedProjectDetail(projectCore)
      .then((data) => {
        if (active) setDetail(data);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Falha ao abrir projeto arquivado.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [projectCore]);

  if (loading) {
    return <div className="archive-detail-loading"><RefreshCcw className="spin" size={24} /><strong>Carregando histórico completo...</strong></div>;
  }

  if (error || !detail) {
    return (
      <div className="archive-detail-loading">
        <Database size={24} />
        <strong>{error || 'Projeto arquivado não encontrado.'}</strong>
        <button className="soft-btn" onClick={onBack}><ArrowLeft size={14} /> Voltar</button>
      </div>
    );
  }

  const project = detail.project;
  const metrics = detail.metrics;
  const items = detail.items;
  const stageMetrics = detail.stage_metrics;
  const hhSummary = detail.hh_summary;
  const holds = detail.hold_periods;
  const documents = detail.documents;

  return (
    <>
      <section className="archive-detail-head">
        <button className="soft-btn" onClick={onBack}><ArrowLeft size={14} /> Arquivados</button>
        <div>
          <span className="eyebrow">Dossiê histórico completo</span>
          <h1>{textValue(project, 'project_display')}</h1>
          <p>{textValue(project, 'client')} · {textValue(project, 'vessel')} · PM {textValue(project, 'pm')}</p>
        </div>
        <span className="status-ref archived"><i />Arquivado</span>
      </section>

      <section className="archive-detail-dates section-card">
        <div><span>Início do projeto</span><strong>{fmtDateOnly(metrics.project_start_date)}</strong></div>
        <div><span>Início real</span><strong>{fmtDateOnly(metrics.actual_start_date)}</strong></div>
        <div><span>Início fabricação</span><strong>{fmtDateOnly(metrics.fabrication_start_date)}</strong></div>
        <div><span>Conclusão</span><strong>{fmtDateOnly(metrics.completed_on)}</strong></div>
        <div><span>Prazo contratual</span><strong>{fmtDateOnly(project.contractual_date as string | null)}</strong></div>
        <div><span>Prazo replanejado</span><strong>{fmtDateOnly(project.replanned_finish as string | null)}</strong></div>
      </section>

      <section className="archive-kpi-grid">
        <div className="archive-kpi"><Clock3 size={18} /><span>Lead time total</span><strong>{metrics.lead_time_days ? fmtNumber(metrics.lead_time_days) + ' dias' : '—'}</strong></div>
        <div className="archive-kpi"><Factory size={18} /><span>Tempo fabricação</span><strong>{metrics.fabrication_calendar_days ? fmtNumber(metrics.fabrication_calendar_days) + ' dias' : '—'}</strong></div>
        <div className="archive-kpi"><Clock3 size={18} /><span>Dias efetivos</span><strong>{metrics.effective_fabrication_days ? fmtNumber(metrics.effective_fabrication_days, 1) + ' dias' : '—'}</strong><small>descontando ON HOLD</small></div>
        <div className="archive-kpi"><Weight size={18} /><span>Peso produzido</span><strong>{fmtNumber(metrics.total_weight_kg, 0)} kg</strong></div>
        <div className="archive-kpi"><Gauge size={18} /><span>Produtividade</span><strong>{metrics.weight_per_effective_day ? fmtNumber(metrics.weight_per_effective_day, 1) + ' kg/dia' : '—'}</strong><small>por dia efetivo</small></div>
        <div className="archive-kpi"><Boxes size={18} /><span>Itens por dia</span><strong>{metrics.items_per_effective_day ? fmtNumber(metrics.items_per_effective_day, 2) : '—'}</strong></div>
        <div className="archive-kpi"><Clock3 size={18} /><span>Média por item</span><strong>{metrics.avg_item_fabrication_days ? fmtNumber(metrics.avg_item_fabrication_days, 1) + ' dias' : '—'}</strong></div>
        <div className="archive-kpi"><Clock3 size={18} /><span>ON HOLD</span><strong>{fmtNumber(metrics.hold_days, 1)} dias</strong></div>
        <div className="archive-kpi"><Gauge size={18} /><span>HH total</span><strong>{metrics.total_hh ? fmtNumber(metrics.total_hh, 1) + ' HH' : '—'}</strong></div>
        <div className="archive-kpi"><Gauge size={18} /><span>Eficiência HH</span><strong>{metrics.kg_per_hh ? fmtNumber(metrics.kg_per_hh, 2) + ' kg/HH' : '—'}</strong></div>
      </section>

      <section className="archive-info-grid">
        <div className="section-card">
          <div className="section-card-head"><div><span className="section-mono">Projeto</span><h2>Dados gerais</h2></div></div>
          <div className="archive-info-list">
            <div><span>Tipo</span><strong>{textValue(project, 'project_type')}</strong></div>
            <div><span>PO</span><strong>{textValue(project, 'customer_po')}</strong></div>
            <div><span>Referência cliente</span><strong>{textValue(project, 'client_reference')}</strong></div>
            <div><span>Prioridade</span><strong>{textValue(project, 'priority')}</strong></div>
            <div><span>Acceptance Date</span><strong>{fmtDateOnly(project.acceptance_date as string | null)}</strong></div>
            <div><span>Drawing Approval</span><strong>{fmtDateOnly(project.drawing_approval_date as string | null)}</strong></div>
            <div><span>Itens</span><strong>{fmtNumber(metrics.item_count)}</strong></div>
            <div><span>M²</span><strong>{fmtNumber(metrics.total_m2, 1)}</strong></div>
            <div><span>Origem</span><strong>{detail.origin === 'OPS_CORE' ? 'OPS CORE' : 'Tracking histórico'}</strong></div>
          </div>
        </div>

        <div className="section-card">
          <div className="section-card-head"><div><span className="section-mono">Disponibilidade</span><h2>Qualidade dos indicadores</h2></div></div>
          <div className="archive-info-list">
            {Object.entries(metrics.data_completeness || {}).map(([key, value]) => (
              <div key={key}><span>{key.replace(/^has_/, '').replaceAll('_', ' ')}</span><strong>{value ? 'Disponível' : 'Não disponível'}</strong></div>
            ))}
          </div>
        </div>
      </section>

      {stageMetrics.length > 0 && (
        <section className="section-card archive-detail-section">
          <div className="section-card-head"><div><span className="section-mono">Processo</span><h2>Média por etapa</h2></div></div>
          <div className="archive-stage-table">
            <div className="archive-stage-head"><span>Etapa</span><span>Setor</span><span>Itens concluídos</span><span>Fila média</span><span>Execução média</span><span>Total médio</span></div>
            {stageMetrics.map((raw, index) => {
              const row = raw as Record<string, unknown>;
              return <div className="archive-stage-row" key={textValue(row, 'stage_key') + index}>
                <span><strong>{textValue(row, 'stage_name')}</strong></span>
                <span>{textValue(row, 'sector_key')}</span>
                <span>{fmtNumber(numValue(row, 'completed_items'))}</span>
                <span>{row.avg_queue_hours == null ? '—' : fmtNumber(numValue(row, 'avg_queue_hours'), 1) + ' h'}</span>
                <span>{row.avg_execution_hours == null ? '—' : fmtNumber(numValue(row, 'avg_execution_hours'), 1) + ' h'}</span>
                <span>{row.avg_total_hours == null ? '—' : fmtNumber(numValue(row, 'avg_total_hours'), 1) + ' h'}</span>
              </div>;
            })}
          </div>
        </section>
      )}

      {hhSummary.length > 0 && (
        <section className="section-card archive-detail-section">
          <div className="section-card-head"><div><span className="section-mono">Apontamento HH</span><h2>Produtividade por atividade</h2></div></div>
          <div className="archive-stage-table archive-hh-table">
            <div className="archive-stage-head"><span>Atividade</span><span>Sessões</span><span>Tempo</span><span>HH</span><span>Primeiro início</span><span>Último fim</span></div>
            {hhSummary.map((raw, index) => {
              const row = raw as Record<string, unknown>;
              return <div className="archive-stage-row" key={textValue(row, 'activity_name') + index}>
                <span><strong>{textValue(row, 'activity_name')}</strong></span>
                <span>{fmtNumber(numValue(row, 'sessions'))}</span>
                <span>{fmtNumber(numValue(row, 'elapsed_hours'), 1)} h</span>
                <span>{fmtNumber(numValue(row, 'total_hh'), 1)}</span>
                <span>{fmtDateOnly(row.first_start as string | null)}</span>
                <span>{fmtDateOnly(row.last_finish as string | null)}</span>
              </div>;
            })}
          </div>
        </section>
      )}

      <section className="section-card archive-detail-section">
        <div className="section-card-head"><div><span className="section-mono">Produção</span><h2>Itens da BSP</h2></div><strong>{items.length}</strong></div>
        <div className="archive-items-table">
          <div className="archive-items-head"><span>Item</span><span>Drawing / Linha</span><span>Início</span><span>Início fabricação</span><span>Fim</span><span>Peso</span><span>M²</span><span>Status</span></div>
          {items.map((raw, index) => {
            const row = raw as Record<string, unknown>;
            return <div className="archive-items-row" key={textValue(row, 'item_key') + index}>
              <span><strong>{textValue(row, 'item_display')}</strong><small>{textValue(row, 'item_type')}</small></span>
              <span><strong>{textValue(row, 'drawing_code')}</strong><small>{textValue(row, 'line_number')}</small></span>
              <span>{fmtDateOnly(row.start_date as string | null)}</span>
              <span>{fmtDateOnly(row.fabrication_start as string | null)}</span>
              <span>{fmtDateOnly(row.finish_date as string | null)}</span>
              <span>{fmtNumber(numValue(row, 'weight_kg'), 1)} kg</span>
              <span>{row.m2 == null ? '—' : fmtNumber(numValue(row, 'm2'), 1)}</span>
              <span><span className="status-ref archived"><i />{textValue(row, 'current_status')}</span></span>
            </div>;
          })}
        </div>
      </section>

      {holds.length > 0 && (
        <section className="section-card archive-detail-section">
          <div className="section-card-head"><div><span className="section-mono">ON HOLD</span><h2>Períodos de suspensão</h2></div></div>
          <div className="archive-stage-table archive-hold-table">
            <div className="archive-stage-head"><span>Item</span><span>Início</span><span>Fim</span><span>Duração</span><span>Motivo</span><span>Origem</span></div>
            {holds.map((raw, index) => {
              const row = raw as Record<string, unknown>;
              return <div className="archive-stage-row" key={textValue(row, 'id') + index}>
                <span>{textValue(row, 'iso')}</span>
                <span>{fmtDateOnly(row.started_at as string | null)}</span>
                <span>{fmtDateOnly(row.ended_at as string | null)}</span>
                <span>{fmtNumber(numValue(row, 'duration_hours') / 24, 1)} dias</span>
                <span>{textValue(row, 'reason')}</span>
                <span>{textValue(row, 'source_system')}</span>
              </div>;
            })}
          </div>
        </section>
      )}

      {documents.length > 0 && (
        <section className="section-card archive-detail-section">
          <div className="section-card-head"><div><span className="section-mono">Engenharia</span><h2>Documentos e revisões</h2></div></div>
          <div className="archive-document-grid">
            {documents.map((raw, index) => {
              const row = raw as Record<string, unknown>;
              const revisions = Array.isArray(row.revisions) ? row.revisions : [];
              return <div className="archive-document-card" key={textValue(row, 'id') + index}>
                <span>{textValue(row, 'document_type')}</span>
                <strong>{textValue(row, 'document_number')}</strong>
                <small>{textValue(row, 'title')}</small>
                <p>Revisão vigente: <b>{textValue(row, 'current_revision')}</b></p>
                <em>{revisions.length} revisão(ões) registradas</em>
              </div>;
            })}
          </div>
        </section>
      )}
    </>
  );
}

export default function ArchivePage() {
  const [items, setItems] = useState<HubArchivedProject[]>([]);
  const [summary, setSummary] = useState<HubAnnualSummary[]>([]);
  const [health, setHealth] = useState<HubHistoryHealth | null>(null);
  const [search, setSearch] = useState('');
  const [year, setYear] = useState<number | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
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

  if (selectedProject) {
    return <ArchiveDetail projectCore={selectedProject} onBack={() => setSelectedProject(null)} />;
  }

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
          <p>Projetos concluídos permanecem completos no banco para auditoria, produtividade e relatórios anuais.</p>
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
          <button
            type="button"
            className="archive-table-row archive-table-button"
            key={row.origin + ':' + row.project_core}
            onClick={() => setSelectedProject(row.project_core)}
          >
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
          </button>
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
