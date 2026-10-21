import { sanitizeClientId } from './highlightEngine';

const CLIENT_ID_STORAGE_KEY = 'highlight_client_id_v2';
const OWNED_JOBS_STORAGE_KEY = 'highlight_owned_jobs_v2';
let memoryClientId: string | undefined;

function generateRandomClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `hc-${crypto.randomUUID()}`;
  }
  const randA = Math.random().toString(36).slice(2, 12);
  const randB = Math.random().toString(36).slice(2, 12);
  return `hc-${Date.now().toString(36)}-${randA}-${randB}`;
}

export function getOrCreateClientId(): string {
  if (typeof window === 'undefined') {
    return 'hc-ssr-placeholder-0000';
  }
  if (memoryClientId) return memoryClientId;
  try {
    const existing = sanitizeClientId(window.localStorage.getItem(CLIENT_ID_STORAGE_KEY));
    if (existing) {
      return (memoryClientId = existing);
    }
    const created = generateRandomClientId();
    window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, created);
    return (memoryClientId = created);
  } catch {
    return (memoryClientId = generateRandomClientId());
  }
}

export function getClientHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
  return {
    'X-Client-Id': getOrCreateClientId(),
    ...(extraHeaders || {}),
  };
}

export function getOwnedJobIds(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(OWNED_JOBS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((id): id is string => typeof id === 'string'));
    }
  } catch {
    // ignore storage errors
  }
  return new Set();
}

export function recordOwnedJobId(jobId: string): void {
  if (typeof window === 'undefined' || !jobId) return;
  try {
    const set = getOwnedJobIds();
    set.add(jobId);
    window.localStorage.setItem(OWNED_JOBS_STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // ignore storage errors
  }
}

export function removeOwnedJobId(jobId: string): void {
  if (typeof window === 'undefined' || !jobId) return;
  try {
    const set = getOwnedJobIds();
    set.delete(jobId);
    window.localStorage.setItem(OWNED_JOBS_STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // ignore storage errors
  }
}
