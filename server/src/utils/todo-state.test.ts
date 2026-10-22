import { describe, expect, it } from 'vitest';
import { ACTION_WINDOW, todoState } from './todo-state';

const now = new Date('2026-10-22T10:00:00Z');
describe('todo workspace state transitions', () => {
  it('starts a 72-hour window and preserves it during content edits', () => {
    const state = todoState(undefined, { type: 'task' }, now);
    expect(state.deadlineAt?.getTime()).toBe(now.getTime() + ACTION_WINDOW);
    expect(todoState(state, {}, new Date(now.getTime() + ACTION_WINDOW * 2)).deadlineAt).toEqual(state.deadlineAt);
  });
  it('keeps offline timestamps rather than restarting at synchronization', () => {
    const deadlineAt = '2026-10-20T10:00:00Z';
    expect(todoState(undefined, { type: 'task', deadlineAt }, now).deadlineAt).toEqual(new Date(deadlineAt));
  });
  it('starts ideas explicitly and records completion without changing task identity', () => {
    const idea = todoState(undefined, { type: 'learn' }, now);
    expect(idea.deadlineAt).toBeNull();
    const task = todoState(idea, { type: 'task' }, now);
    const completed = todoState(task, { completed: true }, now);
    expect(completed.type).toBe('task');
    expect(completed.completedAt).toEqual(now);
    expect(todoState(completed, {}, new Date('2026-10-25T00:00Z')).completedAt).toEqual(now);
    expect(todoState(completed, { completed: false }, now).completedAt).toBeNull();
  });
  it('records independent successes and keeps daily reference lists unticked', () => {
    expect(todoState(undefined, { type: 'success' }, now).completed).toBe(1);
    const daily = todoState(undefined, { type: 'daily', completed: true, sortOrder: 4 }, now);
    expect(daily).toMatchObject({ completed: 0, completedAt: null, deadlineAt: null, sortOrder: 4 });
  });
});
