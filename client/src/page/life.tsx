import { useContext } from 'react';
import { ProfileContext } from '../state/profile';
import { CalendarView } from '../features/life/calendar';
import { HabitView } from '../features/life/habits';
import { LifeDenied } from '../features/life/layout';
import { mayAccessLife, type LifeSection } from '../features/life/model';
import { LifeOverview, TodoView } from '../features/life/overview';
import { PomodoroView } from '../features/life/pomodoro';
import { RssView } from '../features/life/rss';

export function PrivateLifePage({ section }: { section: LifeSection }) {
  const profile = useContext(ProfileContext);
  if (!mayAccessLife(profile?.role)) return <LifeDenied />;
  if (section === 'life') return <LifeOverview />;
  if (section === 'todos') return <TodoView />;
  if (section === 'habits') return <HabitView />;
  if (section === 'calendar' || section === 'year') return <CalendarView year={section === 'year'} />;
  if (section === 'pomodoro') return <PomodoroView />;
  return <RssView />;
}
