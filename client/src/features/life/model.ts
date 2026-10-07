import { endpoint } from '../../main';
import { withTimeout } from '../../data/local-first';
import { headersWithAuth } from '../../utils/auth';

export type LifeSection = 'life' | 'todos' | 'habits' | 'calendar' | 'year' | 'pomodoro' | 'rss';
export type Habit = { id: number; name: string; description: string; color: string; active: number; clientKey?: string | null };
export type Log = { habitId: number; date: string; completed: number };
export type DailyNote = { id?: number; date: string; content: string; updatedAt: Date | string };
export type DailyBasic = { id: number; date: string; content: string; completed: number; sortOrder: number; clientKey?: string | null };
export type LifeTodo = { id: number; content: string; type: 'task' | 'learn'; completed: number; clientKey?: string | null; updatedAt?: Date | string };
export type PomodoroSession = { id: number; startedAt: Date; endedAt: Date; focusMinutes: number; roundIndex: number; completed: number; taskName?: string; completedEarly?: number };
export type RssSubscription = { id: number; feedUrl: string; sourceUrl: string; title: string; alias: string; description: string; category: string; provider: string; platform: string; siteUrl: string; favicon: string; lastFetchedAt: Date | null; lastError: string };
export type RssGroup = { id: number; name: string; sortOrder: number };
export type RssItem = { id: number; subscriptionId: number; externalId?: string; title: string; url: string; summary: string; author: string; publishedAt: Date; read: number; starred: number; readAt?: Date | null; starredAt?: Date | null; embedUrl: string; thumbnailUrl: string };
export type RssData = { subscriptions: RssSubscription[]; groups?: RssGroup[]; items: RssItem[]; counts: { all: number; unread: number; starred: number }; page?: { limit: number; offset: number; total: number; hasMore: boolean } };
export type RssStorage = { backend: { usedBytes: number; limitBytes: number }; rssBytes: number; local?: { usedBytes: number; limitBytes: number } };
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
  const timeout = timeoutOverride ?? ((init?.method || 'GET').toUpperCase() === 'GET' ? READ_TIMEOUT : WRITE_TIMEOUT);
  const response = await withTimeout(fetch(`${endpoint}${path}`, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...headersWithAuth(), ...(init?.headers || {}) } }), timeout);
  if (!response.ok) throw new Error((await response.text()) || `Request failed: ${response.status}`);
  const body = await response.text();
  const trimmed = body.trim();
  if (trimmed && response.headers.get('content-type')?.includes('application/json')) {
    try { return JSON.parse(trimmed) as T; } catch { return trimmed as T; }
  }
  return (trimmed || null) as T;
}

