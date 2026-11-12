import { endpoint } from '../../main';
import { accountIdFromToken, currentWritePause, pauseWrites, SyncPauseError,SyncConflictError } from '../../data/local-first';
import { getCookie } from 'typescript-cookie';

export type LifeSection = 'life' | 'todos' | 'habits' | 'calendar' | 'year' | 'pomodoro' | 'rss' | 'reports' | 'check-in';
export type Habit = { id: number; name: string; description: string; color: string; active: number; clientKey?: string | null };
export type Log = { habitId: number; date: string; completed: number };
export type DailyNote = { id?: number; date: string; content: string; updatedAt: Date | string };
export type DailyBasic = { id: number; date: string; content: string; completed: number; sortOrder: number; clientKey?: string | null;todoId?:number|null;completedAt?:Date|string|null;revision?:number };
export type TodoType = 'task' | 'learn' | 'success' | 'daily';
export type LifeTodo = { id: number; content: string; type: TodoType; completed: number; clientKey?: string | null; createdAt?: Date | string; updatedAt?: Date | string; deadlineAt?: Date | string | null; completedAt?: Date | string | null; sortOrder?: number; focusMinutes?: number; focusRounds?: number };
export type PomodoroSession = { id: number; startedAt: Date; endedAt: Date; focusMinutes: number; roundIndex: number; completed: number; taskName?: string; todoId?: number | null; completedEarly?: number };
export type RssSubscription = { id: number; feedUrl: string; sourceUrl: string; title: string; alias: string; description: string; category: string; provider: string; platform: string; siteUrl: string; favicon: string; lastFetchedAt: Date | null; lastError: string; historyPolicy?: string; historyReason?: string; historyStatus?: string; historyError?: string };
export type RssGroup = { id: number; name: string; sortOrder: number };
export type RssItem = { id: number; subscriptionId: number; externalId?: string; title: string; url: string; summary: string; author: string; publishedAt: Date; publishedPrecision?: string; read: number; starred: number; readAt?: Date | null; starredAt?: Date | null; embedUrl: string; thumbnailUrl: string };
export type RssData = { subscriptions: RssSubscription[]; groups?: RssGroup[]; years?: string[]; items: RssItem[]; counts: { all: number; unread: number; starred: number }; page?: { limit: number; offset: number; total: number; hasMore: boolean } };
export type RssStorage = { backend: { usedBytes: number; limitBytes: number | null; measured?: boolean }; rssBytes: number; items?: number; metrics?: Array<{kind:string;added:number;updated:number;unchanged:number;rowsRead:number;rowsWritten:number;sizeBefore?:number;sizeAfter?:number}>; local?: { usedBytes: number; limitBytes: number } };
export type RssActivity = { id: number; title: string; url: string; readAt: Date | null; starredAt: Date | null };
export type CalendarData = { habits: Habit[]; logs: Log[]; sessions: PomodoroSession[]; notes: DailyNote[]; basics: DailyBasic[] };
export type LifeOverviewData = {
  summary: { habits: number; completed: number; focusMinutes: number; rounds: number; unread: number };
  habits: Array<{ id: number; name: string; days: string[] }>;
  recentRss: Array<{ id: number; title: string; url: string; publishedAt: Date; read: number }>;
  basics: DailyBasic[];
  todos: LifeTodo[];
};

export const mayAccessLife = (role?: string) => role === 'owner' || role === 'trusted';
export const isoDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const monthNow = () => isoDay().slice(0, 7);
export const addDays = (date: Date, count: number) => { const next = new Date(date); next.setDate(next.getDate() + count); return next; };
export const mondayOf = (date = new Date()) => { const next = new Date(date); const day = next.getDay() || 7; next.setDate(next.getDate() - day + 1); next.setHours(0, 0, 0, 0); return next; };
export const CLOUD_REFRESH_EVENT = 'shjdshy-cloud-refresh';
export const READ_TIMEOUT = 6000;
export const WRITE_TIMEOUT = 20000;

export async function lifeApi<T>(path: string, init?: RequestInit, timeoutOverride?: number): Promise<T> {
  const token = getCookie('token');
  const requestOwnerId = accountIdFromToken(token);
  const method = (init?.method || 'GET').toUpperCase();
  const timeout = timeoutOverride ?? (method === 'GET' ? READ_TIMEOUT : WRITE_TIMEOUT);
  const writePause = method === 'GET' ? 0 : currentWritePause();
  if (writePause > Date.now()) throw new SyncPauseError('今日数据库额度已暂停，本地更改已保留', writePause);
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const controller = new AbortController();
  const abort = () => controller.abort(init?.signal?.reason);
  if (init?.signal?.aborted) abort();
  else init?.signal?.addEventListener('abort', abort, { once: true });
  const timer = window.setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), timeout);
  try {
    controller.signal.throwIfAborted();
    const response = await fetch(`${endpoint}${path}`, { ...init, cache: 'no-store', headers, signal: controller.signal });
    const text = await response.text();
    controller.signal.throwIfAborted();
    const assertSession = () => {
      if (getCookie('token') !== token) throw new Error('会话已切换，请重新读取数据');
    };
    if (!response.ok) {
      let detail: { code?: string; retryAt?: number; message?: string } | undefined;
      try { detail = JSON.parse(text); } catch {}
      const hard = detail?.code === 'D1_QUOTA_PAUSED' || /exceeded D1.*daily.*limit/i.test(text);
      if (hard) {
        const now = new Date();
        const retryAt = detail?.retryAt || Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
        pauseWrites(retryAt, requestOwnerId);
        throw new SyncPauseError(detail?.message || '今日数据库额度已耗尽，本地更改已保留', retryAt);
      }
      assertSession();
      if (response.status === 409 && path.startsWith('/life/basics')) {
        throw new SyncConflictError(detail ?? { message: '每日事项需要核对，原始内容已保留' });
      }
      throw new Error(detail?.message || text || `Request failed: ${response.status}`);
    }
    assertSession();
    const trimmed = text.trim();
    if (trimmed && response.headers.get('content-type')?.includes('application/json')) {
      try { return JSON.parse(trimmed) as T; } catch { return trimmed as T; }
    }
    return (trimmed || null) as T;
  } finally {
    window.clearTimeout(timer);
    init?.signal?.removeEventListener('abort', abort);
  }
}
