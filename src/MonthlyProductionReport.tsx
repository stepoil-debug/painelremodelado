import { useEffect, useState } from 'react';
import { CalendarDays, Download, FileSpreadsheet, PackageCheck, RefreshCcw, Ruler, Users, Weight } from 'lucide-react';
import * as XLSX from 'xlsx';
import type { HubMonthlyProductionEvent, HubMonthlyProductionReport } from './services/opsPanelHub';

function number(value: number | null | undefined, maximumFractionDigits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits }).format(Number(value));
}

function date(value: string | null | undefined, withTime = false) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('pt-BR', withTime
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' }).format(parsed);
}

function monthLabel(value: string) {
  const [year, month] = value.split('-').map(Number);
  if (!year || !month) return value;
  return new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1));
}

function eventLabel(event: HubMonthlyProductionEvent) {
  return event.event_type === 'stage.complete' ? 'Etapa concluída' : event.event_type === 'stage.start' ? 'Etapa iniciada' : 'Avanço registrado';
}

function exportReport(report: HubMonthlyProductionReport) {
  const period = `${report.period.year}-${String(report.period.month).padStart(2, '0')}`;
  const summaryRows = report.stages.map((stage) => ({
    Etapa: stage.stage_label,
    Setor: stage.sector,
    'Itens produzidos': stage.item_count,
    'Registros de avanço': stage.event_count,
    'Pontos de avanço': stage.total_progress_points,
    'Peso produzido (kg)': stage.produced_weight_kg,
    'Área produzida (m²)': stage.produced_m2,
    'Itens sem peso': stage.missing_weight_count,
    'Itens sem m²': stage.missing_m2_count,
    'Primeiro registro': date(stage.first_event_at, true),
    'Último registro': date(stage.last_event_at, true),
  }));
  const detailRows = report.events.map((event) => ({
    Data: date(event.created_at, true),
    Fonte: event.source === 'ops_core' ? 'OPS CORE' : 'Tracking legado',
    BSP: event.project_number,
    Projeto: event.project_display,
    Cliente: event.client,
    Embarcação: event.vessel,
    PM: event.pm,
    'ISO / Tag': event.iso,
    'Chave do item': event.item_key,
    Etapa: event.stage_label,
    Setor: event.sector,
    Evento: eventLabel(event),
    'Avanço anterior (%)': event.progress_from,
    'Avanço novo (%)': event.progress_to,
    'Avanço do mês (%)': event.progress_delta,
    'Peso do item (kg)': event.weight_kg,
    'Peso produzido (kg)': event.produced_weight_kg,
    'm² do item': event.m2,
    'm² produzido': event.produced_m2,
    'Executado por': event.actor_name,
    Login: event.actor_email,
  }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), 'Resumo por etapa');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(detailRows), 'Detalhamento');
  XLSX.writeFile(workbook, `producao-mensal-${period}.xlsx`);
}

export default function MonthlyProductionReport({
  report,
  month,
  loading,
  error,
  onMonthChange,
}: {
  report: HubMonthlyProductionReport | null;
  month: string;
  loading: boolean;
  error: string | null;
  onMonthChange: (value: string) => void;
}) {
  const [selectedStageKey, setSelectedStageKey] = useState('');
  const selectedStage = report?.stages.find((stage) => stage.stage_key === selectedStageKey) || report?.stages[0] || null;
  const detailEvents = report?.events.filter((event) => !selectedStage || event.stage_key === selectedStage.stage_key) || [];
  const hasReport = Boolean(report);

  useEffect(() => {
    setSelectedStageKey(report?.stages[0]?.stage_key || '');
  }, [report?.period.year, report?.period.month, report?.stages]);

  return (
    <section className="section-card monthly-production-card">
      <div className="section-card-head monthly-production-head">
        <div>
          <span className="section-mono">Produção realizada</span>
          <h2>Relatório mensal por etapa</h2>
          <p>Resumo geral consolidado por tag única. Os cartões abaixo mostram o peso produzido em cada etapa e podem repetir uma mesma tag entre etapas.</p>
        </div>
        <div className="monthly-production-actions">
          <label className="monthly-production-month">
            <CalendarDays size={14} />
            <span>Mês de referência</span>
            <input type="month" value={month} onChange={(event) => onMonthChange(event.target.value)} />
          </label>
          <button className="portfolio-export-button monthly-production-export" onClick={() => report && exportReport(report)} disabled={!report || loading || !report.events.length}>
            <FileSpreadsheet size={15} />
            <span>Baixar Excel</span>
            <Download size={13} />
          </button>
        </div>
      </div>

      {loading && <div className="monthly-production-loading"><RefreshCcw size={17} className="spin" /> Carregando produção de {monthLabel(month)}...</div>}
      {error && <div className="monthly-production-error"><PackageCheck size={17} /><div><strong>Não foi possível carregar o relatório mensal.</strong><span>{error}</span></div></div>}

      {!loading && !error && hasReport && (
        <>
          <div className="monthly-production-summary">
            <div><PackageCheck size={17} /><span>Tags únicas produzidas</span><strong>{number(report!.summary.item_count, 0)}</strong><small>{number(report!.summary.event_count, 0)} registros de etapa consolidados</small></div>
            <div><Weight size={17} /><span>Peso produzido único</span><strong>{number(report!.summary.total_weight_kg)} kg</strong><small>cada tag contabilizada uma vez</small></div>
            <div><Ruler size={17} /><span>Área produzida</span><strong>{number(report!.summary.total_m2)} m²</strong><small>Rateada por avanço de cada item</small></div>
            <div><Users size={17} /><span>Etapas trabalhadas</span><strong>{number(report!.summary.stage_count, 0)}</strong><small>{report!.summary.missing_weight_count ? `${report!.summary.missing_weight_count} registro(s) sem peso` : 'Peso preenchido nos registros'}</small></div>
          </div>

          {report!.stages.length ? (
            <div className="monthly-production-stage-list">
              {report!.stages.map((stage, index) => (
                <button className={'monthly-production-stage ' + (selectedStage?.stage_key === stage.stage_key ? 'selected' : '')} key={stage.stage_key} onClick={() => setSelectedStageKey(stage.stage_key)}>
                  <div className="monthly-production-stage-number">{String(index + 1).padStart(2, '0')}</div>
                  <div className="monthly-production-stage-main">
                    <div className="monthly-production-stage-title"><span>{stage.sector}</span><strong>{stage.stage_label}</strong></div>
                    <div className="monthly-production-stage-meta"><span>{number(stage.item_count, 0)} itens</span><span>{number(stage.event_count, 0)} avanços</span><span>{number(stage.total_progress_points)}% acumulado</span><span>{date(stage.first_event_at)} — {date(stage.last_event_at)}</span></div>
                  </div>
                  <div className="monthly-production-stage-measures"><strong>{number(stage.produced_weight_kg)} kg</strong><small>{number(stage.produced_m2)} m²</small></div>
                </button>
              ))}
            </div>
          ) : (
            <div className="monthly-production-empty"><PackageCheck size={24} /><strong>Nenhuma produção registrada em {monthLabel(month)}.</strong><span>Os registros aparecerão aqui quando houver avanço positivo ou conclusão de etapa no painel.</span></div>
          )}

          {report!.events.length > 0 && (
            <div className="monthly-production-details">
              <div className="monthly-production-details-head"><div><span className="section-mono">Rastreamento do período</span><h3>Detalhamento · {selectedStage?.stage_label || 'Etapa'}</h3></div><span>{detailEvents.length} registro(s) · clique em outra etapa acima para trocar</span></div>
              <div className="monthly-production-table">
                <div className="monthly-production-table-head"><span>Data</span><span>BSP / ISO</span><span>Etapa</span><span>Avanço</span><span>Peso produzido</span><span>m² produzido</span><span>Responsável</span></div>
                {detailEvents.slice(0, 200).map((event) => (
                  <div className="monthly-production-table-row" key={event.id}>
                    <span>{date(event.created_at, true)}</span>
                    <span><strong>{event.project_number}</strong><small>{event.iso}</small></span>
                    <span><strong>{event.stage_label}</strong><small>{eventLabel(event)}</small></span>
                    <span><b>+{number(event.progress_delta)}%</b><small>{number(event.progress_from)}% → {number(event.progress_to)}%</small></span>
                    <span>{event.produced_weight_kg == null ? '—' : number(event.produced_weight_kg) + ' kg'}</span>
                    <span>{event.produced_m2 == null ? '—' : number(event.produced_m2) + ' m²'}</span>
                    <span><strong>{event.actor_name}</strong><small>{event.actor_email}</small></span>
                  </div>
                ))}
              </div>
              {detailEvents.length > 200 && <p className="monthly-production-more">Mostrando 200 registros na tela. O Excel contém todos os {detailEvents.length} lançamentos.</p>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
