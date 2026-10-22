import { describe, expect, it } from 'vitest';
import { countdown, todoColumn, todosInColumn } from './todo-workspace';
import type { LifeTodo } from './model';
const item = (id: number, patch: Partial<LifeTodo> = {}): LifeTodo => ({ id, type: 'task', completed: 0, content: `item ${id}`, ...patch });
describe('todo workspace views', () => {
  it('shows historical completed tasks and ideas once in successes', () => {
    const values = [item(1), item(2, { type: 'learn' }), item(3, { completed: 1 }), item(4, { type: 'learn', completed: 1 }), item(5, { type: 'success', completed: 1 }), item(6, { type: 'daily' })];
    expect(todosInColumn(values, 'success').map(value => value.id).sort()).toEqual([3,4,5]);
    expect(todosInColumn(values, 'task').map(value => value.id)).toEqual([1]);
    expect(todoColumn(values[5])).toBe('daily');
  });
  it('orders urgent tasks first and preserves daily reference ordering', () => {
    expect(todosInColumn([item(1, { deadlineAt: '2026-10-25' }), item(2, { deadlineAt: '2026-10-23' })], 'task').map(value => value.id)).toEqual([2,1]);
    expect(todosInColumn([item(1, { type: 'daily', sortOrder: 2 }), item(2, { type: 'daily', sortOrder: 1 })], 'daily').map(value => value.id)).toEqual([2,1]);
  });
  it('handles threshold, expiration, reload-time calculation and missing deadlines', () => {
    const task = { deadlineAt: '2026-10-25T10:00:00Z' };
    expect(countdown(task, Date.parse('2026-10-22T10:00:00Z')).label).toBe('剩余 72 小时 0 分');
    expect(countdown(task, Date.parse('2026-10-25T08:00:00Z')).level).toBe('urgent');
    expect(countdown(task, Date.parse('2026-10-25T11:00:00Z')).label).toBe('已超时 1 小时 0 分');
    expect(countdown({}, Date.now()).level).toBe('pending');
  });
});
