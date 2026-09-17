export type SectorKey =
  | 'engenharia'
  | 'pcp'
  | 'caldeiraria'
  | 'solda'
  | 'qualidade'
  | 'pintura'
  | 'expedicao';

export type DemandStatus =
  | 'new'
  | 'in_progress'
  | 'waiting'
  | 'blocked'
  | 'late'
  | 'completed'
  | 'upcoming';

export type Priority = 'critical' | 'high' | 'normal' | 'low';

export interface Sector {
  key: SectorKey;
  name: string;
  shortName: string;
}

export interface Demand {
  id: string;
  bsp: string;
  iso: string;
  project?: string;
  client?: string;
  stage: string;
  sector: SectorKey;
  originSector?: SectorKey;
  nextSector?: SectorKey;
  assignedTo?: string;
  priority: Priority;
  status: DemandStatus;
  enteredAt: string;
  slaDueAt?: string;
  progress: number;
  hhMinutes?: number;
  photoEvidence: number;
  source: 'mock' | 'hh_readonly';
  activityKey?: string;
  note?: string;
}

export interface NotificationItem {
  id: string;
  title: string;
  message: string;
  sector: SectorKey;
  demandId?: string;
  createdAt: string;
  read: boolean;
  severity: 'info' | 'warning' | 'danger' | 'success';
}
