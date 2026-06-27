/** Session + CSRF cookie names and mutating-verb set, shared by Clicksy & Meetsy. */
export const SESSION_COOKIE = 'clickup_sync_sid';
export const CSRF_COOKIE = 'csrf';
export const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
