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

  it('keeps the todo link through focus, break and the next round', () => {
    const current: TimerState = { mode: 'focus', round: 1, remaining: 0, targetAt: now.getTime(), startedAt: '2026-10-07T12:00:00.000Z', taskName: '阅读', todoId: 8, todoClientKey: 'todo-8' };
    const focus = completePomodoroStage(current, preferences, now);
    expect(focus.session).toMatchObject({ todoId: 8, todoClientKey: 'todo-8', taskName: '阅读' });
    expect(focus.next).toMatchObject({ todoId: 8, todoClientKey: 'todo-8' });
    const afterBreak = completePomodoroStage(focus.next, preferences, now);
    expect(afterBreak.next).toMatchObject({ todoId: 8, todoClientKey: 'todo-8' });
  });

  it('sends only the client key for an offline todo', () => {
    const current: TimerState = { mode: 'focus', round: 1, remaining: 0, targetAt: now.getTime(), startedAt: '2026-10-07T12:00:00.000Z', taskName: '阅读', todoId: -5, todoClientKey: 'offline-5' };
    const session = completePomodoroStage(current, preferences, now).session;
    expect(session).toMatchObject({ todoClientKey: 'offline-5' });
    expect(session).not.toHaveProperty('todoId');
  });

  it('keeps a delayed early completion within the server accepted duration', () => {
    const current: TimerState = { mode: 'focus', round: 1, remaining: 1, targetAt: null, startedAt: '2026-10-07T08:00:00.000Z', taskName: '整理' };
    expect(completePomodoroStage(current, preferences, now, true).session?.focusMinutes).toBe(180);
  });
});
