export type TimerState = {
  mode: 'focus' | 'break';
  round: number;
  remaining: number;
  targetAt: number | null;
  startedAt: string | null;
  taskName: string;
};

export type PomodoroPreferences = {
  focusMinutes: number;
  breakMinutes: number;
  rounds: number;
};

export type CompletedFocus = {
  session: {
    startedAt: string;
    endedAt: string;
    focusMinutes: number;
    breakMinutes: number;
    roundIndex: number;
    completed: true;
    taskName: string;
    completedEarly: boolean;
  } | null;
  next: TimerState;
};

export const defaultPomodoroPreferences: PomodoroPreferences = {
  focusMinutes: 25,
  breakMinutes: 5,
  rounds: 4,
};

export function completePomodoroStage(
  current: TimerState,
  preferences: PomodoroPreferences,
  now: Date,
  completedEarly = false,
): CompletedFocus {
  const nowMs = now.getTime();
  if (current.mode === 'break') {
    const nextRound = Math.min(preferences.rounds, current.round + 1);
    return {
      session: null,
      next: {
        mode: 'focus',
        round: nextRound,
        remaining: preferences.focusMinutes * 60,
        targetAt: nowMs + preferences.focusMinutes * 60 * 1000,
        startedAt: now.toISOString(),
        taskName: current.taskName,
      },
    };
  }

  const actualMinutes = current.startedAt
    ? Math.max(1, Math.ceil((nowMs - new Date(current.startedAt).getTime()) / 60000))
    : preferences.focusMinutes;
  const session = current.startedAt
    ? {
        startedAt: current.startedAt,
        endedAt: now.toISOString(),
        focusMinutes: completedEarly ? actualMinutes : preferences.focusMinutes,
        breakMinutes: preferences.breakMinutes,
        roundIndex: current.round,
        completed: true as const,
        taskName: current.taskName.trim(),
        completedEarly,
      }
    : null;

  if (current.round < preferences.rounds) {
    return {
      session,
      next: {
        mode: 'break',
        round: current.round,
        remaining: preferences.breakMinutes * 60,
        targetAt: nowMs + preferences.breakMinutes * 60 * 1000,
        startedAt: null,
        taskName: current.taskName,
      },
    };
  }

  return {
    session,
    next: {
      mode: 'focus',
      round: 1,
      remaining: preferences.focusMinutes * 60,
      targetAt: null,
      startedAt: null,
      taskName: current.taskName,
    },
  };
}
