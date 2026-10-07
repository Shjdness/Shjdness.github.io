import { describe, expect, it } from 'vitest';
import { completePomodoroStage, type PomodoroPreferences, type TimerState } from './pomodoro-machine';

const preferences: PomodoroPreferences = { focusMinutes: 25, breakMinutes: 5, rounds: 2 };
const now = new Date('2026-10-07T12:25:00.000Z');

describe('pomodoro state machine', () => {
  it('starts the configured break automatically after a focus round', () => {
    const current: TimerState = { mode: 'focus', round: 1, remaining: 0, targetAt: now.getTime(), startedAt: '2026-10-07T12:00:00.000Z', taskName: '阅读' };
    const result = completePomodoroStage(current, preferences, now);
    expect(result.session?.focusMinutes).toBe(25);
    expect(result.next).toMatchObject({ mode: 'break', round: 1, remaining: 300, startedAt: null });
    expect(result.next.targetAt).toBe(now.getTime() + 300_000);
  });

  it('starts the next focus automatically after a break', () => {
    const current: TimerState = { mode: 'break', round: 1, remaining: 0, targetAt: now.getTime(), startedAt: null, taskName: '阅读' };
    const result = completePomodoroStage(current, preferences, now);
    expect(result.session).toBeNull();
    expect(result.next).toMatchObject({ mode: 'focus', round: 2, remaining: 1500, startedAt: now.toISOString() });
  });

  it('returns to an idle first round after the final focus', () => {
    const current: TimerState = { mode: 'focus', round: 2, remaining: 0, targetAt: now.getTime(), startedAt: '2026-10-07T12:00:00.000Z', taskName: '' };
    expect(completePomodoroStage(current, preferences, now).next).toEqual({ mode: 'focus', round: 1, remaining: 1500, targetAt: null, startedAt: null, taskName: '' });
  });

  it('records actual duration for an early finish', () => {
    const current: TimerState = { mode: 'focus', round: 1, remaining: 1200, targetAt: now.getTime(), startedAt: '2026-10-07T12:20:00.000Z', taskName: '  整理  ' };
    const result = completePomodoroStage(current, preferences, now, true);
    expect(result.session).toMatchObject({ focusMinutes: 5, completedEarly: true, taskName: '整理' });
  });
});
