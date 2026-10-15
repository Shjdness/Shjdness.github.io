import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { accountStorageKey, enqueueMutation } from '../data/local-first';
import { completePomodoroStage, defaultPomodoroPreferences, type PomodoroPreferences, type TimerState } from './pomodoro-machine';

export type { PomodoroPreferences, TimerState } from './pomodoro-machine';

const TIMER_KEY = 'shjdshy-life-pomodoro';
const PREFERENCES_KEY = 'shjdshy-life-pomodoro-preferences';
const LEGACY_PREFERENCES_KEY = 'rin-life-pomodoro-preferences';
export { defaultPomodoroPreferences } from './pomodoro-machine';

type PomodoroContextValue = {
  timer: TimerState;
  preferences: PomodoroPreferences;
  running: boolean;
  clock: string;
  saveError: string | null;
  setTimer: React.Dispatch<React.SetStateAction<TimerState>>;
  setPreferences: React.Dispatch<React.SetStateAction<PomodoroPreferences>>;
  start: () => void;
  pause: () => void;
  stop: () => void;
  finishStage: (completedEarly?: boolean) => Promise<void>;
};

const PomodoroContext = createContext<PomodoroContextValue | null>(null);

const initialPreferences = () => {
  try {
    const stored = localStorage.getItem(PREFERENCES_KEY) ?? localStorage.getItem(LEGACY_PREFERENCES_KEY);
    return { ...defaultPomodoroPreferences, ...JSON.parse(stored || '{}') };
  }
  catch { return defaultPomodoroPreferences; }
};

const initialTimer = (preferences: PomodoroPreferences, ownerId: number | null): TimerState => {
  try {
    const stored = ownerId ? localStorage.getItem(accountStorageKey(TIMER_KEY, ownerId)) : null;
    const saved = JSON.parse(stored || 'null') as TimerState | null;
    if (saved) return { ...saved, taskName: saved.taskName || '', remaining: saved.targetAt ? Math.max(0, Math.ceil((saved.targetAt - Date.now()) / 1000)) : saved.remaining };
  } catch { /* Start from a clean timer when old local state is invalid. */ }
  return { mode: 'focus', round: 1, remaining: preferences.focusMinutes * 60, targetAt: null, startedAt: null, taskName: '' };
};

async function saveSession(session: Record<string, unknown>) {
  await enqueueMutation('pomodoro', 'create', session);
}

export function PomodoroProvider({ children, ownerId }: { children: React.ReactNode; ownerId: number | null }) {
  const [preferences, setPreferences] = useState<PomodoroPreferences>(initialPreferences);
  const [timer, setTimer] = useState<TimerState>(() => initialTimer(preferences, ownerId));
  const [saveError, setSaveError] = useState<string | null>(null);
  const finishing = useRef(false);
  const timerRef = useRef(timer);
  const preferencesRef = useRef(preferences);

  useEffect(() => {
    timerRef.current = timer;
    if (ownerId) localStorage.setItem(accountStorageKey(TIMER_KEY, ownerId), JSON.stringify(timer));
  }, [timer, ownerId]);
  useEffect(() => {
    preferencesRef.current = preferences;
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
    localStorage.removeItem(LEGACY_PREFERENCES_KEY);
  }, [preferences]);
  useEffect(() => {
    if (!timer.targetAt) return;
    const tick = () => setTimer(current => current.targetAt ? { ...current, remaining: Math.max(0, Math.ceil((current.targetAt - Date.now()) / 1000)) } : current);
    tick();
    const interval = window.setInterval(tick, 500);
    const resume = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', resume);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', resume); };
  }, [timer.targetAt]);

  const finishStage = async (completedEarly = false) => {
    if (finishing.current) return;
    const current = timerRef.current;
    const prefs = preferencesRef.current;
    finishing.current = true;
    try {
      const transition = completePomodoroStage(current, prefs, new Date(), completedEarly);
      if (transition.session && transition.session.focusMinutes >= 5) await saveSession(transition.session);
      setSaveError(null);
      setTimer(transition.next);
    } catch {
      setSaveError('专注记录未能保存到本机，请检查浏览器存储空间并重试');
    } finally {
      finishing.current = false;
    }
  };

  useEffect(() => { if (timer.remaining === 0 && timer.targetAt) void finishStage(); }, [timer.remaining, timer.targetAt]);

  const start = () => setTimer(current => ({ ...current, targetAt: Date.now() + current.remaining * 1000, startedAt: current.mode === 'focus' ? current.startedAt || new Date().toISOString() : null }));
  const pause = () => setTimer(current => ({ ...current, targetAt: null }));
  const stop = () => { if (!saveError) setTimer(current => ({ mode: 'focus', round: 1, remaining: preferencesRef.current.focusMinutes * 60, targetAt: null, startedAt: null, taskName: current.taskName, ...(current.todoId ? { todoId: current.todoId } : {}), ...(current.todoClientKey ? { todoClientKey: current.todoClientKey } : {}) })); };
  const clock = `${String(Math.floor(timer.remaining / 60)).padStart(2, '0')}:${String(timer.remaining % 60).padStart(2, '0')}`;

  return <PomodoroContext.Provider value={{ timer, preferences, running: timer.targetAt !== null, clock, saveError, setTimer, setPreferences, start, pause, stop, finishStage }}>{children}</PomodoroContext.Provider>;
}

export function usePomodoro() {
  const value = useContext(PomodoroContext);
  if (!value) throw new Error('usePomodoro must be used inside PomodoroProvider');
  return value;
}
