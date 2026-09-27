import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { endpoint } from '../main';
import { enqueueMutation } from '../data/local-first';
import { headersWithAuth } from '../utils/auth';

export type TimerState = { mode: 'focus' | 'break'; round: number; remaining: number; targetAt: number | null; startedAt: string | null; taskName: string };
export type PomodoroPreferences = { focusMinutes: number; breakMinutes: number; rounds: number; autoStartFocus: boolean };

const TIMER_KEY = 'rin-life-pomodoro';
const PREFERENCES_KEY = 'rin-life-pomodoro-preferences';
export const defaultPomodoroPreferences: PomodoroPreferences = { focusMinutes: 25, breakMinutes: 5, rounds: 4, autoStartFocus: false };

type PomodoroContextValue = {
  timer: TimerState;
  preferences: PomodoroPreferences;
  running: boolean;
  clock: string;
  setTimer: React.Dispatch<React.SetStateAction<TimerState>>;
  setPreferences: React.Dispatch<React.SetStateAction<PomodoroPreferences>>;
  start: () => void;
  pause: () => void;
  stop: () => void;
  finishStage: (completedEarly?: boolean) => Promise<void>;
};

const PomodoroContext = createContext<PomodoroContextValue | null>(null);

const initialPreferences = () => {
  try { return { ...defaultPomodoroPreferences, ...JSON.parse(localStorage.getItem(PREFERENCES_KEY) || '{}') }; }
  catch { return defaultPomodoroPreferences; }
};

const initialTimer = (preferences: PomodoroPreferences): TimerState => {
  try {
    const saved = JSON.parse(localStorage.getItem(TIMER_KEY) || 'null') as TimerState | null;
    if (saved) return { ...saved, taskName: saved.taskName || '', remaining: saved.targetAt ? Math.max(0, Math.ceil((saved.targetAt - Date.now()) / 1000)) : saved.remaining };
  } catch { /* Start from a clean timer when old local state is invalid. */ }
  return { mode: 'focus', round: 1, remaining: preferences.focusMinutes * 60, targetAt: null, startedAt: null, taskName: '' };
};

async function saveSession(session: Record<string, unknown>) {
  try {
    const response = await fetch(`${endpoint}/pomodoro/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headersWithAuth() }, body: JSON.stringify(session) });
    if (!response.ok) throw new Error(await response.text());
  } catch {
    await enqueueMutation('pomodoro', 'create', session);
  }
}

export function PomodoroProvider({ children }: { children: React.ReactNode }) {
  const [preferences, setPreferences] = useState<PomodoroPreferences>(initialPreferences);
  const [timer, setTimer] = useState<TimerState>(() => initialTimer(preferences));
  const finishing = useRef(false);
  const timerRef = useRef(timer);
  const preferencesRef = useRef(preferences);

  useEffect(() => { timerRef.current = timer; localStorage.setItem(TIMER_KEY, JSON.stringify(timer)); }, [timer]);
  useEffect(() => { preferencesRef.current = preferences; localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)); }, [preferences]);
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
    const endedAt = new Date();
    if (current.mode === 'focus' && current.startedAt) {
      const actualMinutes = Math.max(1, Math.ceil((endedAt.getTime() - new Date(current.startedAt).getTime()) / 60000));
      const session = { startedAt: current.startedAt, endedAt: endedAt.toISOString(), focusMinutes: completedEarly ? actualMinutes : prefs.focusMinutes, breakMinutes: prefs.breakMinutes, roundIndex: current.round, completed: true, taskName: current.taskName.trim(), completedEarly };
      const hasNextRound = current.round < prefs.rounds;
      setTimer(hasNextRound
        ? { mode: 'break', round: current.round, remaining: prefs.breakMinutes * 60, targetAt: Date.now() + prefs.breakMinutes * 60 * 1000, startedAt: null, taskName: current.taskName }
        : { mode: 'focus', round: 1, remaining: prefs.focusMinutes * 60, targetAt: null, startedAt: null, taskName: current.taskName });
      if (session.focusMinutes >= 5) await saveSession(session);
      finishing.current = false;
      return;
    }
    if (current.mode === 'break') {
      const nextRound = Math.min(prefs.rounds, current.round + 1);
      const autoStart = prefs.autoStartFocus;
      setTimer({ mode: 'focus', round: nextRound, remaining: prefs.focusMinutes * 60, targetAt: autoStart ? Date.now() + prefs.focusMinutes * 60 * 1000 : null, startedAt: autoStart ? new Date().toISOString() : null, taskName: current.taskName });
    }
    finishing.current = false;
  };

  useEffect(() => { if (timer.remaining === 0 && timer.targetAt) void finishStage(); }, [timer.remaining, timer.targetAt]);

  const start = () => setTimer(current => ({ ...current, targetAt: Date.now() + current.remaining * 1000, startedAt: current.mode === 'focus' ? current.startedAt || new Date().toISOString() : null }));
  const pause = () => setTimer(current => ({ ...current, targetAt: null }));
  const stop = () => setTimer(current => ({ mode: 'focus', round: 1, remaining: preferencesRef.current.focusMinutes * 60, targetAt: null, startedAt: null, taskName: current.taskName }));
  const clock = `${String(Math.floor(timer.remaining / 60)).padStart(2, '0')}:${String(timer.remaining % 60).padStart(2, '0')}`;

  return <PomodoroContext.Provider value={{ timer, preferences, running: timer.targetAt !== null, clock, setTimer, setPreferences, start, pause, stop, finishStage }}>{children}</PomodoroContext.Provider>;
}

export function usePomodoro() {
  const value = useContext(PomodoroContext);
  if (!value) throw new Error('usePomodoro must be used inside PomodoroProvider');
  return value;
}
