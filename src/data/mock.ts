import type { Demand, DemandEvent, Evidence, NotificationItem, OperationalState, SectorKey } from '../types';
import { getNextStage, getStage } from '../workflow';

const now = Date.now();
const at = (minutesFromNow: number) => new Date(now + minutesFromNow * 60_000).toISOString();
const eventId = (suffix: string) => 'evt-' + suffix;
const evidenceId = (suffix: string) => 'evd-' + suffix;

function history(
  id: string,
  sector: SectorKey,
  stage: string,
  enteredMinutesAgo: number,
  accepted = false,
): DemandEvent[] {
  const items: DemandEvent[] = [
    {
      id: eventId(id + '-created'),
      type: 'created',
      title: 'Demanda recebida',
      description: stage + ' entrou na caixa do setor.',
      at: at(-enteredMinutesAgo),
      actor: 'Motor de fluxo · demo',
      sector,
    },
  ];
  if (accepted) {
    items.push({
      id: eventId(id + '-accepted'),
      type: 'accepted',
      title: 'Demanda assumida',
      description: 'Responsabilidade assumida no ambiente demonstrativo.',
      at: at(-Math.max(1, enteredMinutesAgo - 12)),
      actor: 'Usuário Demo',
      sector,
    });
  }
  return items;
}

function evidences(id: string, mode: 'none' | 'start' | 'both'): Evidence[] {
  if (mode === 'none') return [];
  const list: Evidence[] = [{
    id: evidenceId(id + '-start'),
    type: 'start',
    label: 'Foto inicial · demonstração',
    at: at(-95),
    source: 'demo',
  }];
  if (mode === 'both') {
    list.push({
      id: evidenceId(id + '-finish'),
      type: 'finish',
      label: 'Foto final · demonstração',
      at: at(-20),
      source: 'demo',
    });
  }
  return list;
}

function demand(input: {
  id: string;
  bsp: string;
  iso: string;
  stageKey: string;
  status: Demand['status'];
  priority?: Demand['priority'];
  enteredMinutesAgo: number;
  progress?: number;
  assignedTo?: string;
  evidenceMode?: 'none' | 'start' | 'both';
  note?: string;
  project?: string;
  client?: string;
  blocker?: Demand['blocker'];
}): Demand {
  const stage = getStage(input.stageKey)!;
  const next = getNextStage(input.stageKey);
  return {
    id: input.id,
    bsp: input.bsp,
    iso: input.iso,
    project: input.project ?? 'Projeto Demo',
    client: input.client ?? 'Cliente Demo',
    stageKey: input.stageKey,
    stage: stage.label,
    sector: stage.sector,
    originSector: undefined,
    assignedTo: input.assignedTo,
    priority: input.priority ?? 'normal',
    status: input.status,
    enteredAt: at(-input.enteredMinutesAgo),
    acceptedAt: input.assignedTo ? at(-Math.max(1, input.enteredMinutesAgo - 12)) : undefined,
    startedAt: input.status === 'in_progress' ? at(-Math.max(1, input.enteredMinutesAgo - 14)) : undefined,
    slaDueAt: at(-input.enteredMinutesAgo + stage.slaMinutes),
    progress: input.progress ?? 0,
    hhMinutes: stage.usesPointing ? Math.max(20, Math.round(input.enteredMinutesAgo * 0.72)) : undefined,
    source: 'demo',
    note: input.note,
    blocker: input.blocker,
    evidences: evidences(input.id, input.evidenceMode ?? 'none'),
    history: history(input.id, stage.sector, stage.label, input.enteredMinutesAgo, Boolean(input.assignedTo)),
  };
}

export const seedDemands: Demand[] = [
  demand({ id:'dem-001', bsp:'DEMO-26-001', iso:'ISO-001', stageKey:'quality_dimensional', status:'new', priority:'high', enteredMinutesAgo:42, evidenceMode:'both', note:'Soldagem liberada para inspeção dimensional.' }),
  demand({ id:'dem-002', bsp:'DEMO-26-002', iso:'ISO-003', stageKey:'quality_visual', status:'in_progress', priority:'normal', enteredMinutesAgo:98, progress:55, assignedTo:'Usuário Demo', evidenceMode:'both' }),
  demand({ id:'dem-003', bsp:'DEMO-26-003', iso:'ISO-002', stageKey:'hydro_test', status:'waiting', priority:'high', enteredMinutesAgo:150, progress:25, assignedTo:'Usuário Demo', evidenceMode:'both', note:'Aguardando janela do teste.' }),
  demand({ id:'dem-004', bsp:'DEMO-26-004', iso:'ISO-006', stageKey:'quality_visual', status:'blocked', priority:'critical', enteredMinutesAgo:320, progress:20, assignedTo:'Usuário Demo', blocker:{ reason:'engineering', note:'Divergência dimensional enviada para Engenharia.', createdAt:at(-88) } }),
  demand({ id:'dem-005', bsp:'DEMO-26-005', iso:'ISO-011', stageKey:'welding', status:'in_progress', priority:'high', enteredMinutesAgo:145, progress:75, assignedTo:'Equipe Solda A', evidenceMode:'start' }),
  demand({ id:'dem-006', bsp:'DEMO-26-006', iso:'ISO-004', stageKey:'welding', status:'new', priority:'normal', enteredMinutesAgo:35, evidenceMode:'start' }),
  demand({ id:'dem-007', bsp:'DEMO-26-007', iso:'ISO-007', stageKey:'fitup', status:'in_progress', priority:'normal', enteredMinutesAgo:74, progress:50, assignedTo:'Equipe Caldeiraria', evidenceMode:'start' }),
  demand({ id:'dem-008', bsp:'DEMO-26-008', iso:'ISO-008', stageKey:'cutting', status:'new', priority:'low', enteredMinutesAgo:18 }),
  demand({ id:'dem-009', bsp:'DEMO-26-009', iso:'ISO-014', stageKey:'painting', status:'in_progress', priority:'normal', enteredMinutesAgo:120, progress:50, assignedTo:'Equipe Pintura', evidenceMode:'start' }),
  demand({ id:'dem-010', bsp:'DEMO-26-010', iso:'ISO-005', stageKey:'material_separation', status:'in_progress', priority:'high', enteredMinutesAgo:210, progress:70, assignedTo:'Suprimentos', note:'Separação física em andamento.' }),
  demand({ id:'dem-011', bsp:'DEMO-26-011', iso:'ISO-002', stageKey:'pcp_planning', status:'new', priority:'normal', enteredMinutesAgo:27 }),
  demand({ id:'dem-012', bsp:'DEMO-26-012', iso:'ISO-009', stageKey:'engineering_release', status:'in_progress', priority:'critical', enteredMinutesAgo:390, progress:80, assignedTo:'Engenharia' }),
  demand({ id:'dem-013', bsp:'DEMO-26-013', iso:'ISO-001', stageKey:'dispatch', status:'new', priority:'high', enteredMinutesAgo:66 }),
  demand({ id:'dem-014', bsp:'DEMO-26-014', iso:'ISO-015', stageKey:'final_inspection', status:'in_progress', priority:'normal', enteredMinutesAgo:52, progress:60, assignedTo:'Qualidade' }),
  demand({ id:'dem-015', bsp:'DEMO-26-015', iso:'ISO-010', stageKey:'quality_dimensional', status:'completed', priority:'normal', enteredMinutesAgo:500, progress:100, assignedTo:'Qualidade', evidenceMode:'both' }),
  demand({ id:'dem-016', bsp:'DEMO-26-016', iso:'ISO-012', stageKey:'fitup', status:'blocked', priority:'high', enteredMinutesAgo:260, progress:25, assignedTo:'Caldeiraria', blocker:{ reason:'material', note:'Aguardando complemento de material.', createdAt:at(-130) }, evidenceMode:'start' }),
  demand({ id:'dem-017', bsp:'DEMO-26-017', iso:'ISO-016', stageKey:'painting', status:'new', priority:'normal', enteredMinutesAgo:44 }),
  demand({ id:'dem-018', bsp:'DEMO-26-018', iso:'ISO-018', stageKey:'material_separation', status:'new', priority:'low', enteredMinutesAgo:22 }),
];

export const seedNotifications: NotificationItem[] = [
  { id:'ntf-001', title:'Nova demanda recebida', message:'DEMO-26-001 / ISO-001 entrou na caixa da Qualidade.', sector:'qualidade', demandId:'dem-001', createdAt:at(-42), read:false, severity:'info' },
  { id:'ntf-002', title:'Bloqueio aberto', message:'DEMO-26-004 / ISO-006 aguarda retorno da Engenharia.', sector:'qualidade', demandId:'dem-004', createdAt:at(-88), read:false, severity:'warning' },
  { id:'ntf-003', title:'Soldagem em 75%', message:'DEMO-26-005 está próxima do handoff para a Qualidade.', sector:'qualidade', demandId:'dem-005', createdAt:at(-24), read:false, severity:'info' },
  { id:'ntf-004', title:'Material pendente', message:'DEMO-26-016 está bloqueada aguardando material.', sector:'caldeiraria', demandId:'dem-016', createdAt:at(-130), read:true, severity:'warning' },
];

export const seedState: OperationalState = {
  version: 3,
  demands: seedDemands,
  notifications: seedNotifications,
};
