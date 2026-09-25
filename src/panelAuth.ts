export interface PanelUser {
  id: string;
  username: string;
  name: string;
  email: string;
  role: string;
  sector: string;
  operationRegion: string;
  expiresAt?: string;
}

const AUTH_URL = 'https://qxmxtbjxkhecqilpnhgq.supabase.co/functions/v1/ops-panel-auth';
const TOKEN_KEY = 'step_ops_panel_session_v1';
const LOGIN_KEY = 'step_ops_panel_login_v1';

export function getPanelToken() {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function getRememberedPanelLogin() {
  try {
    return window.localStorage.getItem(LOGIN_KEY) || '';
  } catch {
    return '';
  }
}

export function rememberPanelLogin(identifier: string) {
  try {
    window.localStorage.setItem(LOGIN_KEY, identifier.trim().toLowerCase());
  } catch {
    // O login continua funcionando quando o armazenamento local está bloqueado.
  }
}

function storeToken(token: string) {
  try {
    window.sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    throw new Error('O navegador bloqueou o armazenamento seguro da sessão.');
  }
}

export function clearPanelSession() {
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Sem ação adicional.
  }
}

async function authRequest<T>(
  payload: Record<string, unknown>,
  token = '',
): Promise<T> {
  const response = await fetch(AUTH_URL, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({})) as {
    ok?: boolean;
    error?: string;
    token?: string;
    expiresAt?: string;
    user?: Record<string, unknown>;
  };

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || 'Não foi possível validar o acesso.');
  }

  return data as T;
}

function mapUser(value: Record<string, unknown>, expiresAt?: string): PanelUser {
  return {
    id: String(value.id || ''),
    username: String(value.username || ''),
    name: String(value.name || value.username || 'Usuário STEP'),
    email: String(value.email || ''),
    role: String(value.role || 'Colaborador'),
    sector: String(value.sector || ''),
    operationRegion: String(value.operationRegion || value.operation_region || 'BR'),
    expiresAt: expiresAt || String(value.expires_at || ''),
  };
}

export async function loginPanel(identifier: string, password: string) {
  const response = await authRequest<{
    ok: true;
    token: string;
    expiresAt: string;
    user: Record<string, unknown>;
  }>({
    action: 'login',
    identifier: identifier.trim().toLowerCase(),
    password,
  });

  if (!response.token) throw new Error('O servidor não retornou uma sessão válida.');
  storeToken(response.token);
  rememberPanelLogin(identifier);
  return mapUser(response.user, response.expiresAt);
}

export async function restorePanelSession() {
  const token = getPanelToken();
  if (!token) return null;

  try {
    const response = await authRequest<{
      ok: true;
      user: Record<string, unknown>;
    }>({ action: 'session' }, token);
    return mapUser(response.user);
  } catch {
    clearPanelSession();
    return null;
  }
}

export async function logoutPanel() {
  const token = getPanelToken();
  clearPanelSession();
  if (!token) return;
  try {
    await authRequest({ action: 'logout' }, token);
  } catch {
    // A sessão local já foi removida.
  }
}
