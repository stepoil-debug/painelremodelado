import type {
  Demand,
  DemandEvent,
  DemandStatus,
  OperationalState,
  Priority,
  SectorKey,
  StageMovementMeta,
} from '../types';
import { getStage } from '../workflow';
import type { HubDemandRow } from './opsPanelHub';

type StageMap = {
  stageKey: string;
  sector: SectorKey;
  label: string;
};

type PanelStageOverride = NonNullable<HubDemandRow['panel_stage_overrides']>[number];

function latestPanelOverrides(row: HubDemandRow) {
  return (row.panel_stage_overrides || [])
    .filter((item): item is PanelStageOverride => Boolean(item.stage_key))
    .reduce<Record<string, PanelStageOverride>>((acc, item) => {
      const key = String(item.stage_key);
      const previous = acc[key];
      if (!previous || String(item.updated_at || '').localeCompare(String(previous.updated_at || '')) >= 0) {
        acc[key] = item;
      }
      return acc;
    }, {});
}

function latestPanelOverride(row: HubDemandRow, stageKey?: string) {
  if (!stageKey) return undefined;
  const overrides = latestPanelOverrides(row);
  return overrides[stageKey] || Object.values(overrides).find((item) => uiStageKey(String(item.stage_key)) === stageKey);
}

const originBySector: Partial<Record<SectorKey, SectorKey>> = {
  suprimentos: 'engenharia',
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

function uiStageKey(stageKey: string) {
  const aliases: Record<string, string> = {
    drawing: 'engineering_release',
    stock: 'stock_check',
    material: 'material_separation',
    preassembly: 'fitup',
    'scan-initial': 'dma_va',
    nde: 'quality_visual',
    'scan-final': 'quality_dimensional',
    hydro: 'hydro_test',
    'final-inspection': 'final_inspection',
    package: 'dispatch',
  };
  return aliases[stageKey] || stageKey;
}

function stageMapFromTrackingKey(stageKey?: string | null, label?: string | null): StageMap | null {
  const key = normalize(stageKey);
  if (!key) return null;

  if (key === 'drawing') return { stageKey: 'engineering_release', sector: 'engenharia', label: label || 'Engenharia / Drawing' };
  if (key === 'stock') return { stageKey: 'stock_check', sector: 'suprimentos', label: label || 'Verificação de Estoque' };
  if (key === 'material') return { stageKey: 'material_separation', sector: 'suprimentos', label: label || 'Separação de Material' };
  if (key === 'preassembly') return { stageKey: 'fitup', sector: 'caldeiraria', label: 'Caldeiraria / Fit-up' };
  if (key === 'dma_va' || key === 'scan-initial') return { stageKey: 'dma_va', sector: 'caldeiraria', label: 'DMA/VA' };
  if (key === 'welding') return { stageKey: 'welding', sector: 'solda', label: 'Soldagem' };
  if (key === 'nde') return { stageKey: 'quality_visual', sector: 'qualidade', label: 'DMF/VF' };
  if (key === 'scan-final') return { stageKey: 'quality_dimensional', sector: 'qualidade', label: 'END' };
  if (key === 'hydro') return { stageKey: 'hydro_test', sector: 'qualidade', label: 'Hydro Test' };
  if (key === 'painting') return { stageKey: 'painting', sector: 'pintura', label: label || 'Pintura' };
  if (key === 'final-inspection') return { stageKey: 'final_inspection', sector: 'qualidade', label: label || 'Unitização e Inspeção' };
  if (key === 'package') return { stageKey: 'dispatch', sector: 'expedicao', label: label || 'Preparado para envio' };

  return null;
}

function hhStageMappingIsReliable(row: HubDemandRow) {
  if (row.hh_status !== 'open') return false;

  const activity = normalize(row.hh_activity_name);
  const key = normalize(row.hh_tracking_stage_key);

  if (!activity || !key) return false;
  if (activity === 'montagem' && key === 'preassembly') return true;
  if (activity === 'solda' && key === 'welding') return true;
  if ((activity.includes('hydro') || activity === 'th') && key === 'hydro') return true;
  if (activity.includes('pintura') && key === 'painting') return true;
  if (
    (activity.includes('qualidade') || activity.includes('inspecao'))
    && ['dma_va', 'scan-initial', 'nde', 'scan-final', 'hydro', 'final-inspection'].includes(key)
  ) return true;

  return false;
}

function trackingStageMap(row: HubDemandRow): StageMap {
  const group = normalize(row.current_stage);
  const status = normalize(row.current_status);
  const progress = Number(row.overall_progress || 0);
  const dispatchComplete = progress >= 100 && (
    group.includes('exped')
    || group.includes('logistica')
    || group.includes('enviado')
    || status.includes('enviado')
    || status.includes('finalizado')
  );

  if (row.source_mode === 'ops_core') {
    const coreStage = stageMapFromTrackingKey(row.current_stage, row.current_status);
    if (coreStage) return coreStage;
    if (group === 'assembly-simulation') {
      return { stageKey: 'quality_dimensional', sector: 'qualidade', label: 'END' };
    }
    if (group === 'completed') {
      return { stageKey: 'dispatch', sector: 'expedicao', label: 'Concluído' };
    }
  }

  if (hhStageMappingIsReliable(row)) {
    const hhStage = stageMapFromTrackingKey(row.hh_tracking_stage_key, row.hh_tracking_stage_name || row.hh_activity_name);
    if (hhStage) return hhStage;
  }

  if (group.includes('engenharia')) {
    return { stageKey: 'engineering_release', sector: 'engenharia', label: row.current_status || 'Engenharia' };
  }
  if (group.includes('suprimentos')) {
    return { stageKey: 'material_separation', sector: 'suprimentos', label: row.current_status || 'Suprimentos' };
  }
  if (group.includes('caldeiraria')) {
    if (status.includes('dma') || status.includes('va')) {
      return { stageKey: 'dma_va', sector: 'caldeiraria', label: 'DMA/VA' };
    }
    return { stageKey: 'fitup', sector: 'caldeiraria', label: row.current_status || 'Caldeiraria / Fit-up' };
  }
  if (group.includes('solda')) {
    return { stageKey: 'welding', sector: 'solda', label: 'Soldagem' };
  }
  if (group.includes('on hold')) {
    return { stageKey: 'on_hold', sector: 'on_hold', label: 'On Hold' };
  }
  if (group.includes('producao')) {
    if (status.includes('solda')) return { stageKey: 'welding', sector: 'solda', label: 'Soldagem' };
    if (status.includes('pre') && status.includes('mont')) return { stageKey: 'fitup', sector: 'caldeiraria', label: row.current_status || 'Pré-Montagem' };
    if (status.includes('corte') || status.includes('limpeza')) return { stageKey: 'cutting', sector: 'caldeiraria', label: row.current_status || 'Corte e Limpeza' };
    return { stageKey: 'fitup', sector: 'caldeiraria', label: row.current_status || 'Produção' };
  }
  if (group.includes('qualidade')) {
    if (status === 'th' || status.includes('hidro')) return { stageKey: 'hydro_test', sector: 'qualidade', label: 'Hydro Test' };
    if (status.includes('dimensional') || status.includes('3d') || status.includes('end')) return { stageKey: 'quality_dimensional', sector: 'qualidade', label: 'END' };
    if (status.includes('dmf') || status.includes('vf') || status.includes('visual')) return { stageKey: 'quality_visual', sector: 'qualidade', label: 'DMF/VF' };
    return { stageKey: 'quality_visual', sector: 'qualidade', label: row.current_status || 'DMF/VF' };
  }
  if (group.includes('pintura')) {
    return { stageKey: 'painting', sector: 'pintura', label: row.current_status || 'Pintura' };
  }
  if (group.includes('logistica') || group.includes('expedicao')) {
    return { stageKey: 'dispatch', sector: 'expedicao', label: dispatchComplete ? 'Enviado' : row.current_status || 'Expedição' };
  }
  if (group.includes('enviado')) {
    return { stageKey: 'dispatch', sector: 'expedicao', label: 'Enviado' };
  }

  return { stageKey: 'unclassified', sector: 'nao_classificado', label: row.current_status || row.current_stage || 'Etapa não classificada' };
}

function stageMap(row: HubDemandRow): StageMap {
  const panelStage = Object.values(latestPanelOverrides(row))
    .filter((item) => normalize(item.status) !== 'completed')
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .map((item) => getStage(uiStageKey(String(item.stage_key))))
    .find(Boolean);

  if (panelStage) {
    return {
      stageKey: panelStage.key,
      sector: panelStage.sector,
      label: panelStage.label,
    };
  }

  return trackingStageMap(row);
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

function statusFor(row: HubDemandRow, stageKey?: string): DemandStatus {
  const panelOverride = latestPanelOverride(row, stageKey);
  const overrideStatus = normalize(panelOverride?.status);
  if (panelOverride && ['new', 'available', 'accepted'].includes(overrideStatus)) return 'new';
  if (overrideStatus === 'blocked') return 'blocked';
  if (overrideStatus === 'waiting') return 'waiting';
  if (overrideStatus === 'completed') return 'completed';
  if (overrideStatus === 'in_progress') return 'in_progress';

  const group = normalize(row.current_stage);
  const status = normalize(row.current_status);
  const progress = Number(row.overall_progress || 0);
  const dispatchComplete = progress >= 100 && (
    group.includes('exped')
    || group.includes('logistica')
    || group.includes('enviado')
  );

  if (row.hh_status === 'open') {
    return 'in_progress';
  }

  if (status.includes('bloquead') || status.includes('blocked')) return 'blocked';
  if (status.includes('aguardando') || status.includes('waiting')) return 'waiting';

  if (
    group.includes('enviado')
    || status.includes('finalizado')
    || dispatchComplete
    || normalize(row.project_status).includes('finished')
    || normalize(row.project_status).includes('enviado')
  ) return 'completed';
  if (group.includes('on hold') || status.includes('on hold')) {
    return progress > 0 || row.fabrication_start ? 'in_progress' : 'new';
  }

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

function progressFor(row: HubDemandRow, stageKey?: string) {
  const overrideProgress = latestPanelOverride(row, stageKey)?.progress;
  if (overrideProgress != null && Number.isFinite(Number(overrideProgress))) {
    return Math.max(0, Math.min(100, Math.round(Number(overrideProgress) * 10) / 10));
  }
  const raw = hhStageMappingIsReliable(row) && row.hh_progress_percent != null
    ? Number(row.hh_progress_percent)
    : Number(row.overall_progress || 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, Math.round(raw * 10) / 10));
}

function numericOrNull(value: number | string | null | undefined) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function hubRowsToOperationalState(rows: HubDemandRow[]): OperationalState {
  const demands: Demand[] = rows.map((row) => {
    const mapped = stageMap(row);
    const status = statusFor(row, mapped.stageKey);
    const enteredAt = row.hh_status === 'open'
      ? (row.hh_start_at || row.hh_execution_updated_at || row.source_updated_at || row.synced_at || new Date().toISOString())
      : (row.source_updated_at || row.synced_at || new Date().toISOString());
    const progress = progressFor(row, mapped.stageKey);
    const overridesByStage = latestPanelOverrides(row);
    const stageMovement = Object.fromEntries(Object.entries(overridesByStage).map(([stageKey, item]) => [uiStageKey(stageKey), {
      enteredAt: item.stage_entered_at || item.created_at || null,
      lastMovedAt: item.updated_at || null,
      actorName: item.last_actor_name || item.last_actor || null,
      actorEmail: item.last_actor_email || null,
    }])) as Record<string, StageMovementMeta>;
    const currentStageMovement = stageMovement[mapped.stageKey];
    const stageProgress = Object.fromEntries(Object.entries(overridesByStage)
      .map(([stageKey, item]) => [uiStageKey(stageKey), Math.max(0, Math.min(100, Number(item.progress || 0)))]));
    const stageStatuses = Object.fromEntries(Object.entries(overridesByStage)
      .filter(([, item]) => item.status)
      .map(([stageKey, item]) => [uiStageKey(stageKey), String(item.status)]));
    const undoableStages = Object.fromEntries(Object.entries(overridesByStage)
      .map(([stageKey, item]) => [uiStageKey(stageKey), item.can_undo === true]));
    // Keep the source progress attached to the mapped stage as well. This
    // makes the phase strip and the ISO/SPL row use the same percentage when
    // there is no panel override for that stage yet.
    if (stageProgress[mapped.stageKey] == null) stageProgress[mapped.stageKey] = progress;
    if (stageStatuses[mapped.stageKey] == null) stageStatuses[mapped.stageKey] = status;
    const vessel = row.vessel ? ' · ' + row.vessel : '';
    const sourceStatus = [row.current_stage, row.current_status].filter(Boolean).join(' / ');
    const bsp = projectKeyFromRow(row);
    const panelHistory: DemandEvent[] = (row.panel_stage_history || [])
      .filter((event) => event.created_at)
      .map((event, index) => {
        const eventStage = getStage(uiStageKey(String(event.stage_key || '')));
        const eventType = normalize(event.event_type);
        const type: DemandEvent['type'] = eventType.includes('complete')
          ? 'completed'
          : eventType.includes('block')
            ? 'blocked'
            : eventType.includes('wait')
              ? 'waiting'
              : eventType.includes('resume')
                ? 'resumed'
                : 'progress';
        const progressTo = numericOrNull(event.progress_to);
        const progressLabel = progressTo == null ? '' : ' · avanço ' + progressTo + '%';
        return {
          id: String(event.id || 'panel-history-' + row.iso_key + '-' + index),
          type,
          title: 'Apontamento pelo painel · ' + (eventStage?.label || event.stage_key || 'Etapa'),
          description: (event.note || eventType || 'Etapa atualizada') + progressLabel,
          at: String(event.created_at),
          actor: [event.actor_name, event.actor_email].filter(Boolean).join(' · ') || 'Usuário do painel',
          sector: eventStage?.sector || mapped.sector,
        };
      });

    return {
      id: 'hub-' + String(row.region || 'BR') + '-' + String(row.iso_key || bsp),
      bsp,
      projectGroupKey: String(row.project_row_id || bsp),
      iso: compactIso(row),
      project: row.project_display || ('BSP ' + bsp),
      client: row.client || '—',
      pm: row.pm || undefined,
      stageKey: mapped.stageKey,
      stage: mapped.label,
      sector: mapped.sector,
      originSector: originBySector[mapped.sector],
      // The current responsible person is always the project PM. Human-hours
      // actors and activities belong only to the execution history/note and
      // must never replace the PM in the operational ownership field.
      assignedTo: row.pm ? 'PM · ' + row.pm : 'PM não informado',
      priority: priorityFor(row, status),
      status,
      enteredAt,
      startedAt: row.hh_status === 'open'
        ? (row.hh_start_at || undefined)
        : (row.fabrication_start ? dateAtEndOfDay(row.fabrication_start) : undefined),
      completedAt: status === 'completed' ? enteredAt : undefined,
      slaDueAt: dateAtEndOfDay(row.replanned_finish || row.planned_finish),
      progress,
      overallProgress: numericOrNull(row.overall_progress),
      stageProgress,
      stageStatuses,
      undoableStages,
      stageMovement,
      stageEnteredAt: currentStageMovement?.enteredAt || null,
      stageLastMovedAt: currentStageMovement?.lastMovedAt || null,
      stageMovedByName: currentStageMovement?.actorName || null,
      stageMovedByEmail: currentStageMovement?.actorEmail || null,
      weightKg: numericOrNull(row.weight_kg),
      m2: numericOrNull(row.m2),
      hhMinutes: row.hh_total_hh != null ? Math.round(Number(row.hh_total_hh) * 60) : undefined,
      activityKey: row.hh_activity_key || undefined,
      source: row.source_mode === 'ops_core' ? 'ops_core' : 'hub_readonly',
      sourceMode: row.source_mode || undefined,
      sourceRegion: row.region || undefined,
      legacyProjectRowId: row.project_row_id || undefined,
      legacyIsoKey: row.iso_key || undefined,
      coreProjectId: row.core_project_id || undefined,
      coreItemId: row.core_item_id || undefined,
      bspComment: row.bsp_comment || null,
      tagComment: row.tag_comment || null,
      commentUpdatedAt: row.bsp_comment_updated_at || row.tag_comment_updated_at || null,
      archived: Boolean(row.archived),
      archiveSource: row.archive_source || undefined,
      onHold: normalize(row.project_status) === 'on hold',
      note: [
        row.archived ? 'Arquivo histórico: ' + (row.archive_source || 'OLD') : '',
        row.hh_status === 'open'
          ? 'Apontamento em execução: ' + (row.hh_activity_name || row.hh_tracking_stage_name || 'atividade')
            + (hhStageMappingIsReliable(row) ? ' · ' + (row.hh_progress_percent ?? 0) + '%' : ' · etapa em validação')
            + (row.hh_total_workers ? ' · equipe ' + row.hh_total_workers : '')
          : '',
        sourceStatus ? (row.source_mode === 'ops_core' ? 'OPS CORE: ' : 'Tracking: ') + sourceStatus : '',
        row.line_number ? 'Linha: ' + row.line_number : '',
        row.project_type ? 'Tipo: ' + row.project_type : '',
        row.source_version ? 'Versão: ' + row.source_version : '',
      ].filter(Boolean).join(' · '),
      blocker: normalize(row.current_stage).includes('on hold')
        ? {
            reason: 'other',
            note: row.source_mode === 'ops_core' ? 'Item marcado como ON HOLD no OPS CORE.' : 'Item marcado como ON HOLD no Tracking.',
            createdAt: enteredAt,
          }
        : undefined,
      evidences: [],
      history: [{
        id: 'hub-event-' + row.region + '-' + row.iso_key,
        type: status === 'completed' ? 'completed' : 'progress',
        title: row.source_mode === 'ops_core'
          ? (status === 'completed' ? 'Item concluído no OPS CORE' : 'OPS CORE atualizado')
          : (status === 'completed' ? 'Item finalizado no Tracking' : 'Tracking sincronizado'),
        description: (sourceStatus || 'Registro atualizado') + vessel + ' · avanço ' + progress + '%.',
        at: enteredAt,
        actor: row.source_mode === 'ops_core'
          ? 'OPS CORE · STEP'
          : (row.archived ? 'Tracking histórico · ' + (row.archive_source || 'OLD') : 'Tracking · Smartsheet'),
        sector: mapped.sector,
      }, ...panelHistory, ...(panelHistory.length === 0 && currentStageMovement?.lastMovedAt ? [{
        id: 'panel-movement-' + row.region + '-' + row.iso_key + '-' + mapped.stageKey,
        type: 'progress' as const,
        title: 'Último apontamento pelo painel',
        description: mapped.label + ' · avanço ' + progress + '%.',
        at: currentStageMovement.lastMovedAt,
        actor: [currentStageMovement.actorName, currentStageMovement.actorEmail].filter(Boolean).join(' · ') || 'Usuário do painel',
        sector: mapped.sector,
      }] : [])],
    };
  });

  return {
    version: 4,
    demands,
    notifications: [],
  };
}
