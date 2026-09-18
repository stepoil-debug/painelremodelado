import type { OperationalState } from './types';
import { seedState } from './data/mock';

const STORAGE_KEY = 'step-operational-panel-demo-v3';

function cloneSeed(): OperationalState {
  return JSON.parse(JSON.stringify(seedState)) as OperationalState;
}

export function loadOperationalState(): OperationalState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneSeed();
    const parsed = JSON.parse(raw) as OperationalState;
    if (parsed.version !== seedState.version || !Array.isArray(parsed.demands) || !Array.isArray(parsed.notifications)) {
      return cloneSeed();
    }
    return parsed;
  } catch {
    return cloneSeed();
  }
}

export function saveOperationalState(state: OperationalState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // O painel continua funcional mesmo quando o navegador bloqueia armazenamento local.
  }
}

export function resetOperationalState() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignorado intencionalmente.
  }
  return cloneSeed();
}

export function uid(prefix: string) {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return prefix + '-' + random;
}
