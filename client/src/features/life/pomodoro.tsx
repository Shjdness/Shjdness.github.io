import { useEffect, useState } from 'react';
import { usePomodoro } from '../../state/pomodoro';
import { getCached, getSyncQueue } from '../../data/local-first';
import { LifeLayout } from './layout';
import { lifeApi, type LifeTodo } from './model';

const boundedNumber = (value: string, fallback: number, min: number, max: number) => { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= min ? Math.min(max, Math.round(parsed)) : fallback; };
export function PomodoroView() {
  const { timer, preferences, running, clock, saveError, setTimer, setPreferences, start, pause, stop, finishStage } = usePomodoro();
  const [drafts, setDrafts] = useState(() => ({ focus: String(preferences.focusMinutes), break: String(preferences.breakMinutes), rounds: String(preferences.rounds) }));
  const [todos, setTodos] = useState<LifeTodo[]>([]);
  useEffect(() => {
    let active = true;
    void (async () => {
      const cached = await getCached<LifeTodo[]>('life:todos');
      if (active && cached) setTodos(cached.value);
      try {
        const cloud = await lifeApi<LifeTodo[]>('/life/todos');
        if (active && Array.isArray(cloud) && !(await getSyncQueue()).some(item => item.entity === 'todo')) setTodos(cloud);
      } catch { /* The cached list remains usable offline. */ }
    })();
    return () => { active = false; };
  }, []);
  const { focusMinutes, breakMinutes, rounds } = preferences;
  const commitSetting = (kind: 'focus' | 'break' | 'rounds') => { const limits = kind === 'focus' ? [1, 180] : kind === 'break' ? [1, 60] : [1, 20]; const key: 'focusMinutes' | 'breakMinutes' | 'rounds' = kind === 'focus' ? 'focusMinutes' : kind === 'break' ? 'breakMinutes' : 'rounds'; const value = boundedNumber(drafts[kind], preferences[key], limits[0], limits[1]); setDrafts(current => ({ ...current, [kind]: String(value) })); setPreferences(current => ({ ...current, [key]: value })); if (!timer.startedAt && ((kind === 'focus' && timer.mode === 'focus') || (kind === 'break' && timer.mode === 'break'))) setTimer(current => ({ ...current, remaining: value * 60 })); };
  const selectedTodo = todos.find(item => item.id === timer.todoId && !item.completed);
  const chooseTodo = (id: number) => {
    const todo = todos.find(item => item.id === id && !item.completed);
    setTimer(current => ({ ...current, taskName: todo?.content.slice(0, 160) ?? current.taskName, todoId: todo?.id, todoClientKey: todo?.clientKey || undefined }));
  };
  return <LifeLayout section="pomodoro" title="番茄钟" intro="休息只出现在两轮专注之间；最后一轮结束后，本组计时自然完成。"><label className="pomodoro-task">关联待办<select value={selectedTodo?.id ?? ''} disabled={Boolean(timer.startedAt) || timer.mode === 'break'} onChange={e => chooseTodo(Number(e.target.value))}><option value="">不关联待办</option>{todos.filter(item => !item.completed).map(item => <option key={item.id} value={item.id}>{item.content}</option>)}</select></label><label className="pomodoro-task">当前任务<input value={timer.taskName} maxLength={160} placeholder="" disabled={Boolean(timer.startedAt) || timer.mode === 'break'} onChange={e => setTimer(current => ({ ...current, taskName: e.target.value, todoId: undefined, todoClientKey: undefined }))} /></label><div className={`pomodoro ${timer.mode}`}><p>{timer.mode === 'focus' ? 'FOCUS' : 'BREAK'}</p><strong>{clock}</strong><span>{timer.mode === 'focus' ? `第 ${timer.round} / ${rounds} 轮` : `第 ${timer.round} 轮完成 · 接下来第 ${timer.round + 1} 轮`}</span><div>{running ? <button onClick={pause}>暂停</button> : <button onClick={start}>{timer.remaining === (timer.mode === 'focus' ? focusMinutes : breakMinutes) * 60 ? '开始' : '继续'}</button>}{timer.mode === 'focus' && timer.startedAt && <button onClick={() => void finishStage(true)}>{saveError ? '重试保存' : '提前完成'}</button>}{timer.mode === 'break' && <button onClick={() => void finishStage(true)}>跳过休息</button>}<button className="secondary" onClick={stop} disabled={Boolean(saveError)}>停止</button></div>{saveError && <span role="alert">{saveError}</span>}</div><div className="pomodoro-settings"><label>专注时长<input inputMode="numeric" value={drafts.focus} disabled={Boolean(timer.startedAt) || timer.mode === 'break'} onChange={e => setDrafts(current => ({ ...current, focus: e.target.value }))} onBlur={() => commitSetting('focus')} /></label><label>休息时长<input inputMode="numeric" value={drafts.break} disabled={Boolean(timer.startedAt) || timer.mode === 'break'} onChange={e => setDrafts(current => ({ ...current, break: e.target.value }))} onBlur={() => commitSetting('break')} /></label><label>轮数<input inputMode="numeric" value={drafts.rounds} disabled={Boolean(timer.startedAt) || timer.mode === 'break'} onChange={e => setDrafts(current => ({ ...current, rounds: e.target.value }))} onBlur={() => commitSetting('rounds')} /></label></div></LifeLayout>;
}

