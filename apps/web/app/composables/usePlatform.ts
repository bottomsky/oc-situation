import type { UserRole } from '@ais/contracts';
import { errorLabel, businessError } from '../utils/display';
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
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      body?: unknown;
      idempotent?: boolean;
      idempotencyKey?: string;
      signal?: AbortSignal;
      timeoutMs?: 15000 | 30000;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.method && options.method !== 'GET')
      headers['X-CSRF-Token'] = session.value?.csrfToken ?? '';
    if (options.idempotencyKey || options.idempotent)
      headers['Idempotency-Key'] = options.idempotencyKey ?? crypto.randomUUID();
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 15000);
    const response = await fetch(`/api/v1${path}`, {
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
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
      const skillError = path.startsWith('/agent/skills')
        ? ((await response.json().catch(() => null)) as { error?: { message?: unknown } } | null)
        : null;
      const skillMessage = skillError?.error?.message;
      const business = /^\/(routes|operational-events)(\/|\?|$)/.test(path)
        ? ((await response.json().catch(() => null)) as { error?: { message?: unknown } } | null)
        : null;
      const mapped = businessError(business?.error?.message, response.status);
      throw Object.assign(
        new Error(
          typeof skillMessage === 'string' && [400, 409].includes(response.status)
            ? skillMessage
            : business
              ? mapped.message
              : errorLabel(response.status, path),
        ),
        {
          status: response.status,
          ...(business ? { businessCode: mapped.code } : {}),
        },
      );
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
