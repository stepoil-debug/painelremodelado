import type {
  Demand,
  DemandStatus,
  OperationalState,
  Priority,
  SectorKey,
} from '../types';
import type { HubDemandRow } from './opsPanelHub';

type StageMap = {
  stageKey: string;
  sector: SectorKey;
  label: string;
};

const originBySector: Partial<Record<SectorKey, SectorKey>> = {
  pcp: 'engenharia',
  suprimentos: 'pcp',
  caldeiraria: 'suprimentos',
  solda: 'caldeiraria',
  qualidade: 'solda',
  pintura: 'qualidade',
  expedicao: 'pintura',
};

function projectKeyFromRow(row: HubDemandRow) {
  const direct = String(row.project_number || '').trim();
  if (direct) return direct;

  const candidate = String(row.iso || row.drawing || '').toUpperCase();
  const match = candidate.match(/(?:BSP|BEP|BPP|B3D)[\s-]*([0-9]{2}-[0-9]{3,4}(?:-[0-9]{2})?)/i);
  if (match?.[1]) return match[1];

  return 'SEM-BSP-' + String(row.iso_key || 'REGISTRO');
}

function normalize(value?: string | null) {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function stageMap(row: HubDemandRow): StageMap {
  const group = normalize(row.current_stage);
  const status = normalize(row.current_status);

  if (group.includes('engenharia')) {
    return { stageKey: 'engineering_release', sector: 'engenharia', label: row.current_status || 'Engenharia' };
  }
  if (group.includes('pcp')) {
    return { stageKey: 'pcp_planning', sector: 'pcp', label: row.current_status || 'PCP' };
  }
  if (group.includes('suprimentos')) {
    return { stageKey: 'material_separation', sector: 'suprimentos', label: row.current_status || 'Suprimentos' };
  }
  if (group.includes('caldeiraria')) {
    return { stageKey: 'fitup', sector: 'caldeiraria', label: row.current_status || 'Caldeiraria / Fit-up' };
  }
  if (group.includes('solda')) {
    return { stageKey: 'welding', sector: 'solda', label: row.current_status || 'Solda' };
  }
  if (group.includes('on hold')) {
    return { stageKey: 'pcp_planning', sector: 'pcp', label: 'On Hold' };
  }
  if (group.includes('producao')) {
    if (status.includes('solda')) return { stageKey: 'welding', sector: 'solda', label: row.current_status || 'Solda' };
    if (status.includes('pre') && status.includes('mont')) return { stageKey: 'fitup', sector: 'caldeiraria', label: row.current_status || 'Pré-Montagem' };
    if (status.includes('corte') || status.includes('limpeza')) return { stageKey: 'cutting', sector: 'caldeiraria', label: row.current_status || 'Corte e Limpeza' };
    return { stageKey: 'fitup', sector: 'caldeiraria', label: row.current_status || 'Produção' };
  }
  if (group.includes('qualidade')) {
    if (status === 'th' || status.includes('hidro')) return { stageKey: 'hydro_test', sector: 'qualidade', label: row.current_status || 'TH' };
    if (status.includes('dimensional') || status.includes('3d')) return { stageKey: 'quality_dimensional', sector: 'qualidade', label: row.current_status || 'Inspeção Dimensional' };
    if (status.includes('end')) return { stageKey: 'quality_visual', sector: 'qualidade', label: row.current_status || 'Aguardando END' };
    return { stageKey: 'quality_visual', sector: 'qualidade', label: row.current_status || 'Qualidade' };
  }
  if (group.includes('pintura')) {
    return { stageKey: 'painting', sector: 'pintura', label: row.current_status || 'Pintura' };
  }
  if (group.includes('logistica') || group.includes('expedicao')) {
    return { stageKey: 'dispatch', sector: 'expedicao', label: row.current_status || 'Expedição' };
  }
  if (group.includes('enviado')) {
    return { stageKey: 'dispatch', sector: 'expedicao', label: 'Enviado' };
  }

  return { stageKey: 'pcp_planning', sector: 'pcp', label: row.current_status || row.current_stage || 'Planejamento' };
}

function compactIso(row: HubDemandRow) {
  const value = (row.iso || row.drawing || '').trim();
  if (!value) return '—';
  const isoMatch = value.match(/(ISO[\s-]*\d+.*)$/i);
  if (isoMatch) return isoMatch[1].replace(/\s+/g, ' ').trim();
  return value;
}

function dateAtEndOfDay(value?: string | null) {
  if (!value) return undefined;
  if (value.includes('T')) return value;
  return value + 'T23:59:59-03:00';
}

function statusFor(row: HubDemandRow): DemandStatus {
  const group = normalize(row.current_stage);
  const status = normalize(row.current_status);
  const progress = Number(row.overall_progress || 0);

  if (
    group.includes('enviado')
    || status.includes('finalizado')
    || normalize(row.project_status).includes('finished')
    || normalize(row.project_status).includes('enviado')
  ) return 'completed';
  if (group.includes('on hold') || status.includes('on hold') || status.startsWith('aguardando')) return 'waiting';

  const finish = row.replanned_finish || row.planned_finish;
  if (finish) {
    const due = new Date(dateAtEndOfDay(finish) || finish).getTime();
    if (Number.isFinite(due) && due < Date.now()) return 'late';
  }

  if (progress > 0 || row.fabrication_start) return 'in_progress';
  return 'new';
}

function priorityFor(row: HubDemandRow, status: DemandStatus): Priority {
  if (normalize(row.current_stage).includes('on hold')) return 'high';
  if (status === 'late') return 'high';
  return 'normal';
}

function progressFor(row: HubDemandRow) {
  const raw = Number(row.overall_progress || 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, Math.round(raw * 10) / 10));
}

export function hubRowsToOperationalState(rows: HubDemandRow[]): OperationalState {
  const demands: Demand[] = rows.map((row) => {
    const mapped = stageMap(row);
    const status = statusFor(row);
    const enteredAt = row.source_updated_at || row.synced_at || new Date().toISOString();
    const progress = progressFor(row);
    const vessel = row.vessel ? ' · ' + row.vessel : '';
    const sourceStatus = [row.current_stage, row.current_status].filter(Boolean).join(' / ');
    const bsp = projectKeyFromRow(row);

    return {
      id: 'hub-' + String(row.region || 'BR') + '-' + String(row.iso_key || bsp),
      bsp,
      projectGroupKey: String(row.project_row_id || bsp),
      iso: compactIso(row),
      project: row.project_display || ('BSP ' + bsp),
      client: row.client || '—',
      stageKey: mapped.stageKey,
      stage: mapped.label,
      sector: mapped.sector,
      originSector: originBySector[mapped.sector],
      assignedTo: row.pm ? 'PM · ' + row.pm : undefined,
      priority: priorityFor(row, status),
      status,
      enteredAt,
      startedAt: row.fabrication_start ? dateAtEndOfDay(row.fabrication_start) : undefined,
      completedAt: status === 'completed' ? enteredAt : undefined,
      slaDueAt: dateAtEndOfDay(row.replanned_finish || row.planned_finish),
      progress,
      source: 'hub_readonly',
      archived: Boolean(row.archived),
      archiveSource: row.archive_source || undefined,
      onHold: normalize(row.project_status) === 'on hold',
      note: [
        row.archived ? 'Arquivo histórico: ' + (row.archive_source || 'OLD') : '',
        sourceStatus ? 'Tracking: ' + sourceStatus : '',
        row.line_number ? 'Linha: ' + row.line_number : '',
        row.project_type ? 'Tipo: ' + row.project_type : '',
        row.source_version ? 'Versão: ' + row.source_version : '',
      ].filter(Boolean).join(' · '),
      blocker: normalize(row.current_stage).includes('on hold')
        ? {
            reason: 'other',
            note: 'Item marcado como ON HOLD no Tracking.',
            createdAt: enteredAt,
          }
        : undefined,
      evidences: [],
      history: [{
        id: 'hub-event-' + row.region + '-' + row.iso_key,
        type: status === 'completed' ? 'completed' : 'progress',
        title: status === 'completed' ? 'Item finalizado no Tracking' : 'Tracking sincronizado',
        description: (sourceStatus || 'Registro atualizado') + vessel + ' · avanço ' + progress + '%.',
        at: enteredAt,
        actor: row.archived ? 'Tracking histórico · ' + (row.archive_source || 'OLD') : 'Tracking · Smartsheet',
        sector: mapped.sector,
      }],
    };
  });

  return {
    version: 4,
    demands,
    notifications: [],
  };
}
