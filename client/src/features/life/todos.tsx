import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { getCookie } from 'typescript-cookie';
import { accountIdFromToken, enqueueMutation, getCached, getSyncQueue, setCached } from '../../data/local-first';
import { usePomodoro } from '../../state/pomodoro';
import { LifeLayout } from './layout';
import { CLOUD_REFRESH_EVENT, lifeApi, type LifeTodo, type TodoType } from './model';
import { ACTION_WINDOW_MS, countdown, TODO_COLUMNS, todoColumn, todosInColumn } from './todo-workspace';

type Patch = { content?: string; type?: TodoType; completed?: boolean; deadlineAt?: string | null; completedAt?: string | null; sortOrder?: number };
const CACHE_KEY = 'life:todos';

function useTodos() {
  const [items, setItems] = useState<LifeTodo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const current = useRef<LifeTodo[]>([]);
  const revision = useRef(0);
  const jobs = useRef<Array<() => Promise<void>>>([]);
  const saving = useRef(false);
  const mounted = useRef(true);
  const ownerId = useRef(accountIdFromToken(getCookie('token')));

  const drain = async () => {
    if (saving.current) return;
    saving.current = true;
    try {
      while (jobs.current.length) {
        await jobs.current[0]();
        jobs.current.shift();
      }
      if (mounted.current) setError('');
    } catch {
      if (mounted.current) setError('本机保存未完成，请保持页面打开并重试保存。');
    } finally { saving.current = false; }
  };
  const commit = (next: LifeTodo[], action: string, payload: unknown) => {
    revision.current++;
    current.current = next;
    setItems(next);
    // Persist both the snapshot and the mutation before relying on the network.
    jobs.current.push(async () => {
      if (!ownerId.current || accountIdFromToken(getCookie('token')) !== ownerId.current) throw new Error('Account changed');
      await setCached(CACHE_KEY, next);
      if (accountIdFromToken(getCookie('token')) !== ownerId.current) throw new Error('Account changed');
      await enqueueMutation('todo', action, payload);
    });
    void drain();
  };
  useEffect(() => {
    mounted.current = true;
    let active = true;
    let request = 0;
    const load = async () => {
      const thisRequest = ++request;
      const startedRevision = revision.current;
      const canApply = () => active && request === thisRequest && revision.current === startedRevision && !jobs.current.length;
      try {
        const cached = await getCached<LifeTodo[]>(CACHE_KEY);
        if (cached && canApply()) { current.current = cached.value; setItems(cached.value); setLoading(false); }
        const cloud = await lifeApi<LifeTodo[]>('/life/todos');
        if (Array.isArray(cloud) && canApply() && !(await getSyncQueue()).some(item => item.entity === 'todo') && canApply()) {
          current.current = cloud; setItems(cloud); await setCached(CACHE_KEY, cloud);
        }
      } catch { /* Cached records and queued changes remain available offline. */ }
      finally { if (active) setLoading(false); }
    };
    void load();
    const refresh = () => { void load(); };
    window.addEventListener(CLOUD_REFRESH_EVENT, refresh);
    return () => { active = false; mounted.current = false; window.removeEventListener(CLOUD_REFRESH_EVENT, refresh); };
  }, []);

  const add = (content: string, type: TodoType) => {
    const text = content.trim(); if (!text) return;
    const now = new Date().toISOString();
    const localId = Math.min(-Date.now(), ...current.current.filter(item => item.id < 0).map(item => item.id - 1));
    const clientKey = crypto.randomUUID();
    const deadlineAt = type === 'task' ? new Date(Date.now() + ACTION_WINDOW_MS).toISOString() : null;
    const completedAt = type === 'success' ? now : null;
    const sortOrder = Math.min(1000000, Math.max(0, ...current.current.filter(item => item.type === 'daily').map(item => item.sortOrder || 0)) + 1);
    const value: LifeTodo = { id: localId, content: text, type, clientKey, createdAt: now, updatedAt: now, completed: type === 'success' ? 1 : 0, deadlineAt, completedAt, sortOrder };
    commit([...current.current, value], 'create', { localId, clientKey, content: text, type, deadlineAt, completedAt, sortOrder });
  };
  const update = (item: LifeTodo, patch: Patch) => {
    const next = current.current.map(value => value.id === item.id ? { ...value, ...patch, completed: patch.completed === undefined ? value.completed : Number(patch.completed), updatedAt: new Date().toISOString() } : value);
    commit(next, 'update', { id: item.id, ...patch });
  };
  const move = (item: LifeTodo, type: TodoType) => {
    const patch: Patch = { type, completed: type === 'success', completedAt: type === 'success' ? new Date().toISOString() : null, deadlineAt: type === 'task' ? new Date(Date.now() + ACTION_WINDOW_MS).toISOString() : null };
    if (type === 'daily') patch.sortOrder = Math.min(1000000, Math.max(0, ...current.current.filter(value => value.type === 'daily').map(value => value.sortOrder || 0)) + 1);
    update(item, patch);
  };
  const remove = (item: LifeTodo) => {
    if (!window.confirm(`删除「${item.content.slice(0, 80)}」？`)) return;
    commit(current.current.filter(value => value.id !== item.id), 'delete', { id: item.id });
  };
  const reorder = (item: LifeTodo, direction: -1 | 1) => {
    const ordered = todosInColumn(current.current, 'daily');
    const index = ordered.findIndex(value => value.id === item.id);
    const other = ordered[index + direction]; if (!other) return;
    // Normalize legacy equal positions, then exchange the adjacent pair.
    [ordered[index], ordered[index + direction]] = [ordered[index + direction], ordered[index]];
    ordered.forEach((value, position) => {
      if ((value.sortOrder || 0) !== position + 1) update(value, { sortOrder: position + 1 });
    });
  };
  return { items, loading, error, retry: () => void drain(), add, update, move, remove, reorder };
}
type TodoStore = ReturnType<typeof useTodos>;

function useMinuteClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const timer = window.setInterval(refresh, 60000);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return now;
}
function SaveError({ store }: { store: TodoStore }) {
  return store.error ? <p className="todo-save-error" role="alert">{store.error}<button onClick={store.retry}>重试保存</button></p> : null;
}
function AddTodo({ type, store, compact = false }: { type: TodoType; store: TodoStore; compact?: boolean }) {
  const [value, setValue] = useState('');
  const column = TODO_COLUMNS.find(item => item.type === type)!;
  return <form className={compact ? 'todo-compose todo-compact-compose' : 'todo-column-compose'} onSubmit={event => { event.preventDefault(); if (value.trim()) { store.add(value, type); setValue(''); } }}>
    {compact ? <input aria-label="新增待办" value={value} maxLength={500} placeholder="下一件要推进的事" onChange={event => setValue(event.target.value)} />
      : <textarea aria-label={`新增${column.title}`} value={value} maxLength={500} rows={2} placeholder={column.placeholder} onChange={event => setValue(event.target.value)} />}
    <button disabled={!value.trim()}>{type === 'success' ? '记下成功' : '添加'}</button>
  </form>;
}

function TodoEntry({ item, store, now, compact = false }: { item: LifeTodo; store: TodoStore; now: number; compact?: boolean }) {
  const [draft, setDraft] = useState(item.content);
  const field = useRef<HTMLTextAreaElement>(null);
  const [, navigate] = useLocation();
  const { timer, setTimer } = usePomodoro();
  const column = todoColumn(item);
  const clock = countdown(item, now);
  useEffect(() => setDraft(item.content), [item.content]);
  useLayoutEffect(() => { if (field.current) { field.current.style.height = 'auto'; field.current.style.height = `${field.current.scrollHeight}px`; } }, [draft]);
  const focus = () => {
    setTimer(current => ({ ...current, taskName: item.content.slice(0, 160), todoId: item.id, todoClientKey: item.clientKey || undefined }));
    navigate('/life/pomodoro');
  };
  const complete = () => store.update(item, { completed: true, completedAt: new Date().toISOString() });
  const successDate = item.completedAt || item.updatedAt || item.createdAt;
  return <article className={`todo-entry todo-entry--${column}`}>
    {column === 'task' && <div className={`todo-deadline ${clock.level}`} title={clock.deadline ? `截止 ${clock.deadline}` : undefined}><strong>{clock.label}</strong>{clock.deadline && <small>截止 {clock.deadline}</small>}</div>}
    {column === 'success' && <p className="todo-record-date">{item.type === 'success' ? '主动记录' : '完成事项'}{successDate && ` · ${new Date(successDate).toLocaleDateString('zh-CN')}`}</p>}
    <textarea ref={field} value={draft} maxLength={500} rows={2} aria-label="清单内容" onChange={event => setDraft(event.target.value)} onBlur={() => { const content = draft.trim(); if (!content) setDraft(item.content); else if (content !== item.content) store.update(item, { content }); }} />
    <div className="todo-entry-actions">
      {column === 'task' && <><button className="todo-primary" onClick={complete}>完成</button><button onClick={focus} disabled={Boolean(timer.startedAt) || timer.mode === 'break'}>专注{item.focusMinutes ? ` · ${item.focusMinutes} 分` : ''}</button>{clock.level === 'expired' && <button onClick={() => store.update(item, { deadlineAt: new Date(Date.now() + ACTION_WINDOW_MS).toISOString() })}>重新安排 72h</button>}</>}
      {column === 'learn' && <button className="todo-primary" onClick={() => store.move(item, 'task')}>开始 72 小时</button>}
      {column === 'success' && item.type !== 'success' && <button onClick={() => store.update(item, { completed: false, completedAt: null })}>撤销完成</button>}
      {column === 'daily' && <><button onClick={() => store.reorder(item, -1)} aria-label="上移每日执行项目">↑ 上移</button><button onClick={() => store.reorder(item, 1)} aria-label="下移每日执行项目">↓ 下移</button></>}
      {!compact && <select aria-label="移动清单项目" value="" onChange={event => store.move(item, event.target.value as TodoType)}><option value="" disabled>移动到…</option>{TODO_COLUMNS.filter(value => value.type !== column).map(value => <option key={value.type} value={value.type}>{value.title}</option>)}</select>}
      <button className="todo-delete" onClick={() => store.remove(item)} aria-label="删除清单项目">删除</button>
    </div>
  </article>;
}

export function TodoBoard() {
  const store = useTodos();
  const now = useMinuteClock();
  const items = todosInColumn(store.items, 'task');
  return <div className="todo-compact"><p className="todo-compact-hint">{items.length} 件待办 · 按截止时间排列</p><SaveError store={store} /><AddTodo store={store} type="task" compact /><div className="todo-entries">{items.map(item => <TodoEntry key={item.id} item={item} store={store} now={now} compact />)}</div>{!items.length && <p className="todo-empty">{store.loading ? '正在读取清单…' : '这里暂时没有待办。构想、成功记录和每日执行可在四栏工作台查看。'}</p>}</div>;
}

export function TodoView() {
  const store = useTodos();
  const now = useMinuteClock();
  const [active, setActive] = useState<TodoType>('task');
  const [query, setQuery] = useState('');
  return <LifeLayout section="todos" title="待办与记录" intro="把想法变成行动，把做成的事留下，把日常交给清单。">
    <div className="todo-workspace">
      <SaveError store={store} />
      <div className="todo-workspace-tools"><span>72 小时从创建开始，超时后仍保留，供你继续推进或重新安排。</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索四栏内容" aria-label="搜索四栏内容" /></div>
      <nav className="todo-workspace-tabs" aria-label="清单栏目">{TODO_COLUMNS.map(column => <button key={column.type} aria-pressed={active === column.type} onClick={() => setActive(column.type)}>{column.title}<span>{todosInColumn(store.items, column.type).length}</span></button>)}</nav>
      <div className="todo-columns">{TODO_COLUMNS.map(column => {
        const items = todosInColumn(store.items, column.type, query);
        return <section key={column.type} className={`todo-column todo-column--${column.type}`} data-active={active === column.type}>
          <header><div><h2>{column.title}</h2><span>{todosInColumn(store.items, column.type).length}</span></div><p>{column.intro}</p></header>
          <AddTodo type={column.type} store={store} />
          <div className="todo-entries">{items.map(item => <TodoEntry key={item.id} item={item} store={store} now={now} />)}</div>
          {!items.length && <p className="todo-empty">{store.loading ? '正在读取…' : query ? '没有匹配内容' : column.type === 'success' ? '每一件做成的小事，都值得留下。' : '从第一条记录开始。'}</p>}
        </section>;
      })}</div>
    </div>
  </LifeLayout>;
}
