import { getCached, getSyncQueue, setCached } from '../../data/local-first';
import type { DailyBasic, DailyNote, Habit, Log, PomodoroSession } from './model';
import { lifeApi } from './model';

export async function sendQueuedMutation(item: { entity: string; action: string; payload: unknown }) {
  if (item.entity === 'habit' && item.action === 'create') {
    const payload = item.payload as { localId: number; name: string; description?: string; color?: string; clientKey: string };
    const data = await lifeApi<{ insertedId: number }>('/habit', { method: 'POST', body: JSON.stringify({ name: payload.name, description: payload.description, color: payload.color, clientKey: payload.clientKey }) });
    if (!data?.insertedId) return false;
    const mapping = (await getCached<Record<string, number>>('life:habit-id-map'))?.value || {};
    mapping[String(payload.localId)] = data.insertedId;
    await setCached('life:habit-id-map', mapping);
    return true;
  }
  if (item.entity === 'habit' && (item.action === 'update' || item.action === 'archive')) {
    const payload = item.payload as { id: number; patch: { name?: string; description?: string; color?: string; active?: boolean } };
    const id = await resolveHabitId(payload.id);
    await lifeApi(`/habit/${id}`, { method: 'POST', body: JSON.stringify(payload.patch) });
    return true;
  }
  if (item.entity === 'habit' && item.action === 'delete') {
    const payload = item.payload as { id: number };
    const id = await resolveHabitId(payload.id);
    await lifeApi(`/habit/${id}`, { method: 'DELETE' });
    return true;
  }
  if (item.entity === 'habit' && item.action === 'toggle') {
    const payload = item.payload as { id: number; date: string; completed: boolean };
    const id = await resolveHabitId(payload.id);
    await lifeApi(`/habit/${id}/toggle`, { method: 'POST', body: JSON.stringify({ date: payload.date, completed: payload.completed }) });
    return true;
  }
  if (item.entity === 'note' && item.action === 'save') {
    const payload = item.payload as { date: string; content: string; updatedAt: string };
    await lifeApi(`/life/notes/${payload.date}`, { method: 'POST', body: JSON.stringify({ content: payload.content, updatedAt: payload.updatedAt }) });
    return true;
  }
  if (item.entity === 'note' && item.action === 'delete') {
    const payload = item.payload as { date: string };
    await lifeApi(`/life/notes/${payload.date}`, { method: 'DELETE' });
    return true;
  }
  if (item.entity === 'basic') {
    const payload = item.payload as { localId?: number; id?: number; date?: string; content?: string; completed?: boolean; sortOrder?: number; clientKey?: string };
    if (item.action === 'create') {
      const result = await lifeApi<{ insertedId: number }>('/life/basics', { method: 'POST', body: JSON.stringify({ date: payload.date, content: payload.content, sortOrder: payload.sortOrder, clientKey: payload.clientKey }) });
      if (!result.insertedId || payload.localId === undefined) return false;
      const mapping = (await getCached<Record<string, number>>('life:basic-id-map'))?.value || {};
      mapping[String(payload.localId)] = result.insertedId;
      await setCached('life:basic-id-map', mapping);
      return true;
    }
    const id = await resolveBasicId(payload.id || 0);
    if (item.action === 'delete') await lifeApi(`/life/basics/${id}`, { method: 'DELETE' });
    else await lifeApi(`/life/basics/${id}`, { method: 'POST', body: JSON.stringify({ content: payload.content, completed: payload.completed, sortOrder: payload.sortOrder }) });
    return true;
  }
  if (item.entity === 'todo') {
    const payload = item.payload as { localId?: number; id?: number; content?: string; type?: 'task' | 'learn'; completed?: boolean; clientKey?: string };
    if (item.action === 'create') {
      const result = await lifeApi<{ insertedId: number }>('/life/todos', { method: 'POST', body: JSON.stringify({ content: payload.content, type: payload.type, clientKey: payload.clientKey }) });
      if (!result.insertedId || payload.localId === undefined) return false;
      await rememberLocalId('life:todo-id-map', payload.localId, result.insertedId);
      return true;
    }
    const id = await resolveTodoId(payload.id || 0);
    if (item.action === 'delete') await lifeApi(`/life/todos/${id}`, { method: 'DELETE' });
    else await lifeApi(`/life/todos/${id}`, { method: 'POST', body: JSON.stringify({ content: payload.content, type: payload.type, completed: payload.completed }) });
    return true;
  }
  if (item.entity === 'pomodoro' && item.action === 'create') {
    const payload = item.payload as { startedAt: string; focusMinutes?: number };
    if ((payload.focusMinutes || 0) < 5) return true;
    const month = payload.startedAt.slice(0, 7);
    const existing = await lifeApi<PomodoroSession[]>(`/pomodoro/sessions?month=${encodeURIComponent(month)}`);
    if (Array.isArray(existing) && existing.some(session => new Date(session.startedAt).toISOString() === new Date(payload.startedAt).toISOString())) return true;
    await lifeApi('/pomodoro/sessions', { method: 'POST', body: JSON.stringify(item.payload) });
    return true;
  }
  if (item.entity === 'rss' && item.action === 'update') {
    const payload = item.payload as { id: number; patch: { read?: boolean; starred?: boolean } };
    await lifeApi(`/rss/items/${payload.id}`, { method: 'POST', body: JSON.stringify(payload.patch) });
    return true;
  }
  if (item.entity === 'rss' && item.action === 'mark-all-read') {
    await lifeApi('/rss/items/mark-all-read', { method: 'POST' });
    return true;
  }
  throw new Error(`Unsupported queued mutation: ${item.entity}/${item.action}`);
}

export async function resolveHabitId(id: number) {
  if (id >= 0) return id;
  const mapping = (await getCached<Record<string, number>>('life:habit-id-map'))?.value || {};
  if (!mapping[String(id)]) throw new Error('Habit is waiting to be created');
  return mapping[String(id)];
}

export async function resolveBasicId(id: number) {
  if (id >= 0) return id;
  const mapping = (await getCached<Record<string, number>>('life:basic-id-map'))?.value || {};
  if (!mapping[String(id)]) throw new Error('Today item is waiting to be created');
  return mapping[String(id)];
}

export async function resolveTodoId(id: number) {
  if (id >= 0) return id;
  const mapping = (await getCached<Record<string, number>>('life:todo-id-map'))?.value || {};
  if (!mapping[String(id)]) throw new Error('Todo is waiting to be created');
  return mapping[String(id)];
}

export async function rememberLocalId(cacheKey: string, localId: number, cloudId: number) {
  const mapping = (await getCached<Record<string, number>>(cacheKey))?.value || {};
  mapping[String(localId)] = cloudId;
  await setCached(cacheKey, mapping);
}

export function normalizeBasics(values: DailyBasic[]) {
  const unique = new Map<string, DailyBasic>();
  for (const value of values) {
    const key = `${value.date}:${value.content.trim().replace(/\s+/g, ' ').toLowerCase()}`;
    const current = unique.get(key);
    if (!current || (current.id < 0 && value.id >= 0)) unique.set(key, value);
  }
  return [...unique.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

export async function mergePendingBasics(date: string, cloud: DailyBasic[], cached: DailyBasic[] = []) {
  const queue = (await getSyncQueue()).filter(item => item.entity === 'basic');
  const dayCloud = normalizeBasics(cloud.filter(value => value.date === date));
  const dayCached = normalizeBasics(cached.filter(value => value.date === date));
  if (!queue.length) return dayCloud;
  const mapping = (await getCached<Record<string, number>>('life:basic-id-map'))?.value || {};
  let result = [...dayCloud];
  for (const item of queue) {
    const payload = item.payload as { localId?: number; id?: number; date?: string; content?: string; completed?: boolean; sortOrder?: number; clientKey?: string };
    if (item.action === 'create' && payload.date === date && payload.localId !== undefined) {
      const mappedId = mapping[String(payload.localId)];
      const alreadyCloud = result.some(value => value.clientKey === payload.clientKey || value.id === mappedId);
      if (!alreadyCloud) {
        const local = dayCached.find(value => value.id === payload.localId || value.clientKey === payload.clientKey);
        result.push(local || { id: payload.localId, date, content: payload.content || '', completed: 0, sortOrder: payload.sortOrder || 0, clientKey: payload.clientKey });
      }
      continue;
    }
    if (payload.id === undefined) continue;
    const mappedId = payload.id < 0 ? mapping[String(payload.id)] : payload.id;
    const targetId = mappedId || payload.id;
    if (item.action === 'delete') result = result.filter(value => value.id !== targetId && value.id !== payload.id);
    if (item.action === 'update') {
      const local = dayCached.find(value => value.id === payload.id || value.id === targetId);
      if (!result.some(value => value.id === targetId) && local?.date === date) result.push(local);
      result = result.map(value => value.id === targetId || value.id === payload.id ? { ...value, ...(payload.content === undefined ? {} : { content: payload.content }), ...(payload.completed === undefined ? {} : { completed: payload.completed ? 1 : 0 }), ...(payload.sortOrder === undefined ? {} : { sortOrder: payload.sortOrder }) } : value);
    }
  }
  return normalizeBasics(result.filter(value => value.date === date));
}

export async function mergePendingHabitData(
  cloud: { habits: Habit[]; logs: Log[]; notes: DailyNote[] },
  cached: { habits: Habit[]; logs: Log[]; notes: DailyNote[] } | null,
) {
  const queue = await getSyncQueue();
  if (!queue.length) return cloud;
  const mapping = (await getCached<Record<string, number>>('life:habit-id-map'))?.value || {};
  let habits = [...cloud.habits]; let logs = [...cloud.logs]; let notes = [...cloud.notes];
  for (const queued of queue) {
    if (queued.entity === 'habit' && queued.action === 'create') {
      const payload = queued.payload as { localId: number; name: string; description?: string; color?: string; clientKey: string };
      const cloudId = mapping[String(payload.localId)];
      if (!habits.some(value => value.id === cloudId || value.clientKey === payload.clientKey)) {
        habits.unshift(cached?.habits.find(value => value.id === payload.localId || value.clientKey === payload.clientKey) || { id: payload.localId, name: payload.name, description: payload.description || '', color: payload.color || '#e11d62', active: 1, clientKey: payload.clientKey });
      }
    }
    if (queued.entity === 'habit' && (queued.action === 'update' || queued.action === 'archive')) {
      const payload = queued.payload as { id: number; patch: { name?: string; description?: string; color?: string; active?: boolean } };
      const id = payload.id < 0 ? mapping[String(payload.id)] || payload.id : payload.id;
      if (!habits.some(value => value.id === id)) { const local = cached?.habits.find(value => value.id === payload.id); if (local) habits.push(local); }
      habits = habits.map(value => value.id === id || value.id === payload.id ? { ...value, ...payload.patch, active: payload.patch.active === undefined ? value.active : payload.patch.active ? 1 : 0 } : value);
    }
    if (queued.entity === 'habit' && queued.action === 'delete') {
      const payload = queued.payload as { id: number };
      const id = payload.id < 0 ? mapping[String(payload.id)] || payload.id : payload.id;
      habits = habits.filter(value => value.id !== id && value.id !== payload.id);
      logs = logs.filter(value => value.habitId !== id && value.habitId !== payload.id);
    }
    if (queued.entity === 'habit' && queued.action === 'toggle') {
      const payload = queued.payload as { id: number; date: string; completed: boolean };
      const id = payload.id < 0 ? mapping[String(payload.id)] || payload.id : payload.id;
      logs = [...logs.filter(value => !(value.habitId === id && value.date === payload.date)), { habitId: id, date: payload.date, completed: payload.completed ? 1 : 0 }];
    }
    if (queued.entity === 'note' && queued.action === 'save') {
      const note = queued.payload as DailyNote;
      notes = [...notes.filter(value => value.date !== note.date), note];
    }
    if (queued.entity === 'note' && queued.action === 'delete') {
      const payload = queued.payload as { date: string };
      notes = notes.filter(value => value.date !== payload.date);
    }
  }
  return { habits, logs, notes };
}
