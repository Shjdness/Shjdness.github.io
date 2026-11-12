import { useEffect, useMemo, useRef, useState } from 'react';
import { accountIdFromToken, enqueueMutation, getCached, setCached, getSyncQueue } from '../../data/local-first';
import { getCookie } from 'typescript-cookie';
import { addDays, CLOUD_REFRESH_EVENT, isoDay, lifeApi, mondayOf, type CalendarData, type DailyNote, type Habit, type Log } from './model';
import { assertCurrentAccount, mergePendingHabitData } from './sync';
import { LifeLayout } from './layout';

type HabitWeekData = { habits: Habit[]; logs: Log[]; notes: DailyNote[] };

export function HabitView() {
  const [weekStart, setWeekStart] = useState(mondayOf());
  const ownerId = accountIdFromToken(getCookie('token'));
  return ownerId ? <HabitWeek key={`${ownerId}:${isoDay(weekStart)}`} {...{ ownerId, weekStart, setWeekStart }} /> : null;
}

function HabitWeek({ ownerId, weekStart, setWeekStart }: {
  ownerId: number; weekStart: Date; setWeekStart: (date: Date) => void;
}) {
  const [data, setData] = useState<HabitWeekData | null>(null);
  const { habits, logs, notes } = data ?? { habits: [], logs: [], notes: [] };
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selectedDate, setSelectedDate] = useState(isoDay());
  const [noteDraft, setNoteDraft] = useState('');
  const [editing, setEditing] = useState<Habit | null>(null);
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);
  const from = isoDay(days[0]), to = isoDay(days[6]);
  const cacheKey = `life:habits:${from}:${to}`;
  const revision = useRef(0);
  const hydrated = useRef(false);
  const saving = useRef(false);
  const deferredRefresh = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const load = async () => {
      if (saving.current) { deferredRefresh.current = true; return; }
      const version = ++revision.current;
      const token = getCookie('token');
      const current = () => mounted.current && version === revision.current && getCookie('token') === token &&
        accountIdFromToken(token) === ownerId;
      const inWeek = (item: { date: string }) => item.date >= from && item.date <= to;
      const apply = (next: HabitWeekData) => {
        if (!current()) return;
        hydrated.current = true;
        setData({ ...next, logs: next.logs.filter(inWeek), notes: next.notes.filter(inWeek) });
        setError('');
      };
      try {
        const [cached, before] = await Promise.all([
          getCached<HabitWeekData>(cacheKey, ownerId).catch(() => null),
          getSyncQueue(ownerId).catch(() => []),
        ]);
        if (!current()) return;
        if (!hydrated.current && cached) {
          const snapshot = { ...cached.value, notes: cached.value.notes || [] };
          apply(await mergePendingHabitData(snapshot, snapshot, ownerId, before).catch(() => snapshot));
        }
        if (!current()) return;
        const query = new URLSearchParams({ from, to });
        const [week, noteResult] = await Promise.all([
          lifeApi<Pick<HabitWeekData, 'habits' | 'logs'>>(`/habit/range?${query}`),
          lifeApi<DailyNote[]>(`/life/notes?${query}`).catch(() => null),
        ]);
        if (!current()) return;
        if (!Array.isArray(week?.habits) || !Array.isArray(week?.logs)) throw new Error('无效的习惯列表');
        const after = await getSyncQueue(ownerId).catch(() => []);
        // A sync can acknowledge a write while this read is still in flight.
        const pending = [...new Map([...before, ...after].map(item => [item.id, item])).values()];
        const next = await mergePendingHabitData({
          ...week, notes: Array.isArray(noteResult) ? noteResult : cached?.value.notes ?? [],
        }, cached?.value ?? null, ownerId, pending);
        if (!current()) return;
        const snapshot = { ...next, logs: next.logs.filter(inWeek), notes: next.notes.filter(inWeek) };
        apply(snapshot);
        await setCached(cacheKey, snapshot, ownerId);
      } catch {
        if (current() && !hydrated.current) setError('习惯暂时无法读取，请连接网络后重试。');
      }
    };
    const handler = () => { void load(); };
    void load();
    const protectPendingSave = (event: BeforeUnloadEvent) => {
      if (saving.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener(CLOUD_REFRESH_EVENT, handler);
    window.addEventListener('beforeunload', protectPendingSave);
    return () => {
      mounted.current = false;
      revision.current++;
      window.removeEventListener(CLOUD_REFRESH_EVENT, handler);
      window.removeEventListener('beforeunload', protectPendingSave);
    };
  }, [cacheKey, from, to, ownerId]);

  const selectedNote = notes.find(note => note.date === selectedDate)?.content ?? '';
  useEffect(() => { setNoteDraft(selectedNote); }, [selectedDate, selectedNote]);

  const save = async (
    entity: 'habit' | 'note', action: string, payload: unknown, next: HabitWeekData,
    calendar?: { date: string; update: (value: CalendarData) => CalendarData },
  ) => {
    if (!data || saving.current || accountIdFromToken(getCookie('token')) !== ownerId) return false;
    const token = getCookie('token');
    const current = () => mounted.current && getCookie('token') === token;
    saving.current = true;
    revision.current++;
    setBusy(true);
    setError('');
    try {
      await enqueueMutation(entity, action, payload, ownerId, {
        key: cacheKey, value: next,
        related: calendar && { key: `life:calendar:${calendar.date.slice(0, 7)}`, update: calendar.update },
      });
      if (!current()) return false;
      setData(next);
      return true;
    } catch {
      if (current()) setError('本机保存失败，请保留页面并重试。');
      return false;
    } finally {
      saving.current = false;
      if (current()) {
        setBusy(false);
        if (deferredRefresh.current) {
          deferredRefresh.current = false;
          window.dispatchEvent(new CustomEvent(CLOUD_REFRESH_EVENT));
        }
      }
    }
  };

  const create = async () => {
    if (!name.trim()) return;
    const localId = -Date.now(), clientKey = crypto.randomUUID();
    const local: Habit = { id: localId, name: name.trim(), description: '', color: '#e11d62', active: 1, clientKey };
    if (await save('habit', 'create', { localId, name: local.name, clientKey }, { habits: [local, ...habits], logs, notes })) setName('');
  };
  const updateHabit = async (habit: Habit, patch: { name: string; description: string; active?: boolean }) => {
    const next = habits.map(item => item.id === habit.id
      ? { ...item, name: patch.name, description: patch.description, active: patch.active === false ? 0 : item.active }
      : item);
    if (await save('habit', patch.active === false ? 'archive' : 'update', { id: habit.id, patch }, { habits: next, logs, notes })) setEditing(null);
  };
  const removeHabit = async (habit: Habit) => {
    if (!window.confirm(`永久删除「${habit.name}」及其过往打卡记录？`)) return;
    const next = { habits: habits.filter(item => item.id !== habit.id), logs: logs.filter(log => log.habitId !== habit.id), notes };
    if (await save('habit', 'delete', { id: habit.id }, next)) setEditing(null);
  };
  const toggle = async (habitId: number, date: string) => {
    const match = (log: Log) => log.habitId === habitId && log.date === date;
    const completed = !logs.some(log => match(log) && log.completed);
    const nextLog = { habitId, date, completed: Number(completed) };
    const next = { habits, logs: [...logs.filter(log => !match(log)), nextLog], notes };
    if (await save('habit', 'toggle', { id: habitId, date, completed }, next, {
      date, update: value => ({ ...value, logs: [...value.logs.filter(log => !match(log)), nextLog] }),
    })) setSelectedDate(date);
  };
  const saveNote = async () => {
    const note: DailyNote = { date: selectedDate, content: noteDraft.trim(), updatedAt: new Date().toISOString() };
    const replaceNote = (existing: DailyNote[]) => [...existing.filter(item => item.date !== selectedDate), note];
    await save('note', 'save', note, { habits, logs, notes: replaceNote(notes) }, {
      date: selectedDate, update: value => ({ ...value, notes: replaceNote(value.notes || []) }),
    });
  };
  const removeNote = async () => {
    if (!noteDraft.trim() || !window.confirm(`清除 ${selectedDate} 的当天记录？`)) return;
    const withoutNote = (existing: DailyNote[]) => existing.filter(item => item.date !== selectedDate);
    if (await save('note', 'delete', { date: selectedDate }, { habits, logs, notes: withoutNote(notes) }, {
      date: selectedDate, update: value => ({ ...value, notes: withoutNote(value.notes || []) }),
    })) setNoteDraft('');
  };
  const activeHabits = habits.filter(habit => habit.active);
  return <LifeLayout section="habits" title="习惯">{error && <p role="status">{error}</p>}<div className="habit-week-tools"><button onClick={() => setWeekStart(addDays(weekStart, -7))}><i className="ri-arrow-left-line" /> 上一周</button><strong>{isoDay(days[0])} — {isoDay(days[6])}</strong><button onClick={() => setWeekStart(mondayOf())}>本周</button><button onClick={() => setWeekStart(addDays(weekStart, 7))}>下一周 <i className="ri-arrow-right-line" /></button></div><div className="habit-week" role="grid"><div className="habit-week-head"><span>习惯</span>{days.map(day => { const date = isoDay(day); return <button key={date} className={selectedDate === date ? 'selected' : ''} onClick={() => setSelectedDate(date)}><b>{['日','一','二','三','四','五','六'][day.getDay()]}</b><small>{day.getDate()}</small></button>; })}</div>{activeHabits.map(habit => <div className="habit-week-row" key={habit.id}><span><strong>{habit.name}</strong><small>{habit.description}</small><button className="habit-edit-button" onClick={() => setEditing(habit)} title="编辑习惯"><i className="ri-edit-line" /></button></span>{days.map(day => { const date = isoDay(day); const done = logs.some(log => log.habitId === habit.id && log.date === date && log.completed); return <button key={date} className={done ? 'done' : ''} aria-label={`${habit.name} ${date} ${done ? '已完成' : '未完成'}`} disabled={busy} onClick={() => void toggle(habit.id, date)}><i className={done ? 'ri-check-line' : ''} /></button>; })}</div>)}</div><div className="life-add"><input value={name} maxLength={80} placeholder="添加习惯" onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void create(); }} /><button onClick={create} disabled={busy || !data}>添加</button></div><section className="daily-note"><div><small>DAILY NOTE</small><strong>{selectedDate}</strong></div><textarea value={noteDraft} maxLength={2000} placeholder="今天做了什么 / 有什么想记下来……" onChange={event => setNoteDraft(event.target.value)} /><div className="daily-note-actions"><button className="secondary" disabled={busy || !data || !noteDraft.trim()} onClick={() => void removeNote()}>清除</button><button disabled={busy || !data} onClick={saveNote}>保存当天记录</button></div></section>{editing && <HabitEditor habit={editing} onClose={() => setEditing(null)} onDelete={() => void removeHabit(editing)} onSave={patch => void updateHabit(editing, patch)} />}</LifeLayout>;
}

function HabitEditor({ habit, onClose, onSave, onDelete }: { habit: Habit; onClose: () => void; onSave: (patch: { name: string; description: string; active?: boolean }) => void; onDelete: () => void }) {
  const [name, setName] = useState(habit.name); const [description, setDescription] = useState(habit.description);
  return <div className="habit-modal" role="dialog" aria-modal="true"><section><p>编辑习惯</p><h2>{habit.name}</h2><label>名称<input value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label><label>说明<input value={description} maxLength={240} onChange={event => setDescription(event.target.value)} /></label><div className="habit-editor-actions"><button className="habit-delete" onClick={onDelete}>删除</button><button className="habit-archive" onClick={() => { if (window.confirm('停用后将不再显示于每周面板，但历史记录会保留。继续吗？')) onSave({ name, description, active: false }); }}>停用</button><span /><button onClick={onClose}>取消</button><button disabled={!name.trim()} onClick={() => onSave({ name: name.trim(), description: description.trim() })}>保存</button></div></section></div>;
}

export async function patchCalendarCache(date: string, update: (value: CalendarData) => CalendarData, expectedOwnerId?: number) {
  assertCurrentAccount(expectedOwnerId);
  const key = `life:calendar:${date.slice(0, 7)}`; const cached = await getCached<CalendarData>(key, expectedOwnerId);
  assertCurrentAccount(expectedOwnerId);
  if (cached) await setCached(key, update(cached.value), expectedOwnerId);
  assertCurrentAccount(expectedOwnerId);
}
