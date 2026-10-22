export type TodoType = 'task' | 'learn' | 'success' | 'daily';
export const ACTION_WINDOW = 72 * 60 * 60 * 1000;

type StoredTodo = { type: string; completed: number; deadlineAt?: Date | null; completedAt?: Date | null; sortOrder?: number };
export type TodoPatch = { type?: TodoType; completed?: boolean; deadlineAt?: string | null; completedAt?: string | null; sortOrder?: number };

// Editing content preserves deadlines and completion dates. Explicitly starting
// an idea, or restarting a task, is the only way to open a new action window.
export function todoState(existing: StoredTodo | undefined, patch: TodoPatch, now = new Date()) {
  const type = patch.type ?? (existing?.type as TodoType) ?? 'task';
  const changedType = existing && type !== existing.type;
  const completed = type === 'success' ? true : type === 'daily' ? false
    : patch.completed ?? (changedType ? false : existing?.completed === 1);
  const deadlineAt = type !== 'task' ? null : patch.deadlineAt
    ? new Date(patch.deadlineAt)
    : existing?.type === 'task' && existing.deadlineAt
      ? existing.deadlineAt : new Date(now.getTime() + ACTION_WINDOW);
  const completedAt = !completed ? null : patch.completedAt
    ? new Date(patch.completedAt) : existing?.completedAt ?? now;
  return { type, completed: completed ? 1 : 0, deadlineAt, completedAt, sortOrder: patch.sortOrder ?? existing?.sortOrder ?? 0 };
}
