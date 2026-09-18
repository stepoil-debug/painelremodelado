import type { Sector, SectorKey, StageDefinition } from './types';

export const sectors: Sector[] = [
  { key: 'engenharia', name: 'Engenharia', shortName: 'ENG' },
  { key: 'pcp', name: 'PCP', shortName: 'PCP' },
  { key: 'suprimentos', name: 'Suprimentos', shortName: 'SUP' },
  { key: 'caldeiraria', name: 'Caldeiraria', shortName: 'CAL' },
  { key: 'solda', name: 'Solda', shortName: 'SOL' },
  { key: 'qualidade', name: 'Qualidade', shortName: 'QLD' },
  { key: 'pintura', name: 'Pintura', shortName: 'PNT' },
  { key: 'expedicao', name: 'Expedição', shortName: 'EXP' },
];

export const workflowStages: StageDefinition[] = [
  { key: 'engineering_release', label: 'Liberação de Engenharia', sector: 'engenharia', slaMinutes: 480, photoPolicy: 'none', usesPointing: false },
  { key: 'pcp_planning', label: 'Planejamento / Sequenciamento', sector: 'pcp', slaMinutes: 240, photoPolicy: 'none', usesPointing: false },
  { key: 'material_separation', label: 'Separação de Material', sector: 'suprimentos', slaMinutes: 360, photoPolicy: 'none', usesPointing: false },
  { key: 'cutting', label: 'Corte e Preparação', sector: 'caldeiraria', slaMinutes: 300, photoPolicy: 'required_start_finish', usesPointing: true },
  { key: 'fitup', label: 'Caldeiraria / Fit-up', sector: 'caldeiraria', slaMinutes: 360, photoPolicy: 'required_start_finish', usesPointing: true },
  { key: 'welding', label: 'Soldagem', sector: 'solda', slaMinutes: 480, photoPolicy: 'required_start_finish', usesPointing: true },
  { key: 'quality_visual', label: 'Inspeção Visual', sector: 'qualidade', slaMinutes: 180, photoPolicy: 'optional', usesPointing: false },
  { key: 'quality_dimensional', label: 'Inspeção Dimensional', sector: 'qualidade', slaMinutes: 180, photoPolicy: 'optional', usesPointing: false },
  { key: 'hydro_test', label: 'Hydro Test', sector: 'qualidade', slaMinutes: 240, photoPolicy: 'optional', usesPointing: false },
  { key: 'painting', label: 'Pintura / Revestimento', sector: 'pintura', slaMinutes: 480, photoPolicy: 'required_start_finish', usesPointing: true },
  { key: 'final_inspection', label: 'Inspeção Final', sector: 'qualidade', slaMinutes: 180, photoPolicy: 'optional', usesPointing: false },
  { key: 'dispatch', label: 'Liberação / Expedição', sector: 'expedicao', slaMinutes: 240, photoPolicy: 'none', usesPointing: false },
];

export function getStage(key: string) {
  return workflowStages.find((stage) => stage.key === key);
}

export function getStageIndex(key: string) {
  return workflowStages.findIndex((stage) => stage.key === key);
}

export function getNextStage(key: string) {
  const index = getStageIndex(key);
  return index >= 0 ? workflowStages[index + 1] : undefined;
}

export function getPreviousStage(key: string) {
  const index = getStageIndex(key);
  return index > 0 ? workflowStages[index - 1] : undefined;
}

export function sectorName(key?: SectorKey) {
  return sectors.find((sector) => sector.key === key)?.name ?? '—';
}

export function sectorShortName(key?: SectorKey) {
  return sectors.find((sector) => sector.key === key)?.shortName ?? '—';
}

export function photoPolicyLabel(policy: StageDefinition['photoPolicy']) {
  if (policy === 'required_start_finish') return 'Foto inicial e final obrigatórias';
  if (policy === 'optional') return 'Evidências opcionais';
  return 'Sem foto obrigatória';
}
