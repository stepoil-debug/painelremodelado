import type { Demand, NotificationItem, Sector } from '../types';

export const sectors: Sector[] = [
  { key: 'engenharia', name: 'Engenharia', shortName: 'ENG' },
  { key: 'pcp', name: 'PCP', shortName: 'PCP' },
  { key: 'caldeiraria', name: 'Caldeiraria', shortName: 'CAL' },
  { key: 'solda', name: 'Solda', shortName: 'SOL' },
  { key: 'qualidade', name: 'Qualidade', shortName: 'QLD' },
  { key: 'pintura', name: 'Pintura', shortName: 'PNT' },
  { key: 'expedicao', name: 'Expedição', shortName: 'EXP' },
];

export const mockDemands: Demand[] = [
  {
    id: 'dem-001', bsp: 'BSP-26-345', iso: 'ISO-004', project: 'YINSON', client: 'Yinson',
    stage: 'Inspeção Dimensional', sector: 'qualidade', originSector: 'solda', nextSector: 'pintura',
    priority: 'high', status: 'new', enteredAt: '2026-09-17T12:48:00-03:00', slaDueAt: '2026-09-17T16:00:00-03:00',
    progress: 0, photoEvidence: 2, hhMinutes: 196, source: 'mock', note: 'Solda finalizada e liberada para inspeção.'
  },
  {
    id: 'dem-002', bsp: 'BSP-26-392', iso: 'ISO-002', project: 'YINSON', client: 'Yinson',
    stage: 'Inspeção Visual', sector: 'qualidade', originSector: 'caldeiraria', nextSector: 'solda',
    assignedTo: 'Carlos Souza', priority: 'normal', status: 'in_progress', enteredAt: '2026-09-17T11:10:00-03:00', slaDueAt: '2026-09-17T15:30:00-03:00',
    progress: 50, photoEvidence: 2, hhMinutes: 144, source: 'mock'
  },
  {
    id: 'dem-003', bsp: 'BSP-25-1086', iso: 'ISO-001', project: 'FPSO', client: 'Cliente',
    stage: 'Hydro Test', sector: 'qualidade', originSector: 'solda', nextSector: 'pintura',
    assignedTo: 'João Silva', priority: 'critical', status: 'late', enteredAt: '2026-09-17T08:12:00-03:00', slaDueAt: '2026-09-17T12:00:00-03:00',
    progress: 25, photoEvidence: 4, hhMinutes: 290, source: 'mock', note: 'Prioridade crítica do projeto.'
  },
  {
    id: 'dem-004', bsp: 'BSP-26-511', iso: 'ISO-012', project: 'YINSON', client: 'Yinson',
    stage: 'Inspeção de Solda', sector: 'qualidade', originSector: 'solda', nextSector: 'pintura',
    priority: 'normal', status: 'blocked', enteredAt: '2026-09-17T09:40:00-03:00',
    progress: 0, photoEvidence: 2, hhMinutes: 210, source: 'mock', note: 'Aguardando retorno da Engenharia.'
  },
  {
    id: 'dem-005', bsp: 'BSP-26-390', iso: 'ISO-003', project: 'YINSON', client: 'Yinson',
    stage: 'Solda', sector: 'solda', originSector: 'caldeiraria', nextSector: 'qualidade',
    assignedTo: 'Equipe Solda 02', priority: 'high', status: 'upcoming', enteredAt: '2026-09-17T10:25:00-03:00',
    progress: 75, photoEvidence: 1, hhMinutes: 165, source: 'mock', note: 'Próxima para Qualidade após conclusão da solda.'
  },
  {
    id: 'dem-006', bsp: 'BSP-26-401', iso: 'ISO-008', project: 'YINSON', client: 'Yinson',
    stage: 'Solda', sector: 'solda', originSector: 'caldeiraria', nextSector: 'qualidade',
    assignedTo: 'Equipe Solda 01', priority: 'normal', status: 'upcoming', enteredAt: '2026-09-17T12:05:00-03:00',
    progress: 50, photoEvidence: 1, hhMinutes: 88, source: 'mock'
  },
  {
    id: 'dem-007', bsp: 'BSP-26-455', iso: 'ISO-005', project: 'YINSON', client: 'Yinson',
    stage: 'Pintura', sector: 'pintura', originSector: 'qualidade', nextSector: 'expedicao',
    assignedTo: 'Equipe Pintura', priority: 'normal', status: 'in_progress', enteredAt: '2026-09-17T09:18:00-03:00',
    progress: 50, photoEvidence: 2, hhMinutes: 132, source: 'mock'
  },
  {
    id: 'dem-008', bsp: 'BSP-26-470', iso: 'ISO-006', project: 'YINSON', client: 'Yinson',
    stage: 'Revisão de desenho', sector: 'engenharia', originSector: 'qualidade', nextSector: 'qualidade',
    assignedTo: 'Engenharia', priority: 'high', status: 'waiting', enteredAt: '2026-09-17T11:55:00-03:00',
    progress: 0, photoEvidence: 0, source: 'mock', note: 'Retorno solicitado pela Qualidade.'
  }
];

export const mockNotifications: NotificationItem[] = [
  {
    id: 'ntf-001', title: 'Nova demanda recebida', message: 'BSP-26-345 / ISO-004 foi liberada pela Solda.',
    sector: 'qualidade', demandId: 'dem-001', createdAt: '2026-09-17T12:48:00-03:00', read: false, severity: 'info'
  },
  {
    id: 'ntf-002', title: 'SLA ultrapassado', message: 'BSP-25-1086 / ISO-001 ultrapassou o SLA de Qualidade.',
    sector: 'qualidade', demandId: 'dem-003', createdAt: '2026-09-17T12:01:00-03:00', read: false, severity: 'danger'
  },
  {
    id: 'ntf-003', title: 'Demanda bloqueada', message: 'BSP-26-511 / ISO-012 aguarda retorno da Engenharia.',
    sector: 'qualidade', demandId: 'dem-004', createdAt: '2026-09-17T10:02:00-03:00', read: true, severity: 'warning'
  }
];
