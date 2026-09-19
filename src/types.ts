export type SectorKey =
  | 'engenharia'
  | 'pcp'
  | 'suprimentos'
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
  | 'completed';

export type Priority = 'critical' | 'high' | 'normal' | 'low';
export type PhotoPolicy = 'required_start_finish' | 'optional' | 'none';
export type EvidenceType = 'start' | 'finish' | 'extra';
export type DemandSource = 'demo' | 'hh_readonly' | 'hub_readonly';

export interface Sector {
  key: SectorKey;
  name: string;
  shortName: string;
}

export interface StageDefinition {
  key: string;
  label: string;
  sector: SectorKey;
  slaMinutes: number;
  photoPolicy: PhotoPolicy;
  usesPointing: boolean;
}

export interface DemandEvent {
  id: string;
  type: 'created' | 'accepted' | 'progress' | 'blocked' | 'unblocked' | 'waiting' | 'resumed' | 'evidence' | 'completed' | 'handoff';
  title: string;
  description: string;
  at: string;
  actor: string;
  sector: SectorKey;
}

export interface Evidence {
  id: string;
  type: EvidenceType;
  label: string;
  at: string;
  source: 'demo' | 'hh';
}

export interface DemandBlocker {
  reason: 'material' | 'engineering' | 'client' | 'access' | 'quality' | 'other';
  note: string;
  createdAt: string;
}

export interface Demand {
  id: string;
  bsp: string;
  projectGroupKey?: string;
  iso: string;
  project?: string;
  client?: string;
  stageKey: string;
  stage: string;
  sector: SectorKey;
  originSector?: SectorKey;
  assignedTo?: string;
  priority: Priority;
  status: DemandStatus;
  enteredAt: string;
  acceptedAt?: string;
  startedAt?: string;
  completedAt?: string;
  slaDueAt?: string;
  progress: number;
  hhMinutes?: number;
  source: DemandSource;
  archived?: boolean;
  archiveSource?: string;
  activityKey?: string;
  note?: string;
  blocker?: DemandBlocker;
  evidences: Evidence[];
  history: DemandEvent[];
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

export interface OperationalState {
  version: number;
  demands: Demand[];
  notifications: NotificationItem[];
}
