import axios from 'axios';

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

export const apiClient = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

// The active workspace id, set by WorkspaceProvider. Appended to every request
// so the backend scopes admin/reports/clickup data to the chosen workspace.
// Backend endpoints that aren't workspace-scoped simply ignore the param.
let activeWorkspaceId: string | null = null;
export function setActiveWorkspaceId(id: string | null) {
  activeWorkspaceId = id;
}

apiClient.interceptors.request.use((config) => {
  const method = (config.method ?? 'get').toUpperCase();
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
    const csrf = readCookie('csrf');
    if (csrf) config.headers['x-csrf-token'] = csrf;
  }
  // Attach the active workspace unless the caller set one explicitly.
  if (activeWorkspaceId) {
    config.params = { workspaceId: activeWorkspaceId, ...(config.params ?? {}) };
  }
  return config;
});

// Public routes a logged-out visitor is allowed to sit on. A 401 here (e.g. the
// AuthProvider's `/auth/me` probe finding no session) must NOT bounce them to
// /login — otherwise invite/signup links are unusable.
const PUBLIC_ROUTE = /^\/(login|signup|invite)(\/|$)/;

apiClient.interceptors.response.use(
  (r) => r,
  (error) => {
    const url: string = error.config?.url ?? '';
    // `/auth/me` is an auth *probe*: a 401 just means "not logged in" and is
    // handled by AuthProvider's catch. Never hard-redirect on it.
    const isAuthProbe = url.includes('/auth/me');
    if (
      error.response?.status === 401 &&
      !isAuthProbe &&
      !PUBLIC_ROUTE.test(location.pathname)
    ) {
      location.href = '/login';
    }
    return Promise.reject(error);
  },
);
