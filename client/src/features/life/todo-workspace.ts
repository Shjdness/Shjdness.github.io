import type { LifeTodo, TodoType } from './model';

export const ACTION_WINDOW_MS = 72 * 60 * 60 * 1000;
export const TODO_COLUMNS: { type: TodoType; title: string; intro: string; placeholder: string }[] = [
  { type: 'task', title: '待办', intro: '给决定做的事 72 小时，先迈出第一步。', placeholder: '接下来要推进的具体事情' },
  { type: 'learn', title: '未来构想', intro: '收藏好奇、想法和可能性，准备好时再开始。', placeholder: '想尝试、了解或创造什么？' },
  { type: 'success', title: '成功的事汇总', intro: '记下自己做成的事，小小的进展也算数。', placeholder: '我做成了什么？采取了什么行动？' },
  { type: 'daily', title: '每日执行', intro: '每天看一眼的固定清单，辅助记忆，不打卡。', placeholder: '例如：起床后叠被子；晚饭后练琴' },
];
export function todoColumn(item: Pick<LifeTodo, 'type' | 'completed'>): TodoType {
  return item.type === 'success' || (item.completed === 1 && item.type !== 'daily') ? 'success' : item.type;
}
export function todoTime(value?: Date | string | null) {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : 0;
}
export function todosInColumn(items: LifeTodo[], type: TodoType, query = '') {
  const search = query.trim().toLocaleLowerCase();
  return items.filter(item => todoColumn(item) === type && item.content.toLocaleLowerCase().includes(search)).sort((a, b) => {
    if (type === 'task') return (todoTime(a.deadlineAt) || Infinity) - (todoTime(b.deadlineAt) || Infinity) || a.id - b.id;
    if (type === 'daily') return (a.sortOrder || 0) - (b.sortOrder || 0) || a.id - b.id;
    return todoTime(b.completedAt || b.updatedAt || b.createdAt) - todoTime(a.completedAt || a.updatedAt || a.createdAt);
  });
}
export function countdown(item: Pick<LifeTodo, 'deadlineAt'>, now: number) {
  const deadline = todoTime(item.deadlineAt);
  if (!deadline) return { level: 'pending', label: '同步后开始计时', deadline: '' };
  const remaining = deadline - now;
  const minutes = Math.ceil(Math.abs(remaining) / 60000);
  const hours = Math.floor(minutes / 60);
  const label = `${hours} 小时 ${minutes % 60} 分`;
  return {
    level: remaining <= 0 ? 'expired' : remaining <= 6 * 3600000 ? 'urgent' : remaining <= 24 * 3600000 ? 'soon' : 'normal',
    label: `${remaining <= 0 ? '已超时' : '剩余'} ${label}`,
    deadline: new Date(deadline).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }),
  };
}
