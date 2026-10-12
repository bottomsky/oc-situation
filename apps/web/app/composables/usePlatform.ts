import type { UserRole } from '@ais/contracts';
import { errorLabel } from '../utils/display';
export interface Session {
  user: { id: string; username: string; role: UserRole };
  csrfToken: string;
  expiresAt: string;
}
export function usePlatform() {
  const session = useState<Session | null>('session', () => null);
  const notice = useState<string>('notice', () => '');
  async function api<T>(
    path: string,
    options: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: unknown;
      idempotent?: boolean;
      idempotencyKey?: string;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.method && options.method !== 'GET')
      headers['X-CSRF-Token'] = session.value?.csrfToken ?? '';
    if (options.idempotencyKey || options.idempotent)
      headers['Idempotency-Key'] = options.idempotencyKey ?? crypto.randomUUID();
    const response = await fetch(`/api/v1${path}`, {
      signal: AbortSignal.timeout(15000),
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers: {
        ...headers,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    }).catch(() => {
      throw new Error('网络连接失败或请求超时，请检查连接后重试');
    });
    if (!response.ok) {
      if (response.status === 401) {
        session.value = null;
        if (path !== '/auth/login') await navigateTo('/login');
      }
      throw new Error(errorLabel(response.status, path));
    }
    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
  }
  async function restore() {
    if (!session.value) session.value = await api<Session>('/auth/me');
  }
  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    session.value = null;
    await navigateTo('/login');
  }
  return { api, session, notice, restore, logout };
}
