const dayMs = 86_400_000;
const hourMs = 3_600_000;

function dayEpoch(value: string): number {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date.getTime() : NaN;
}

export function validLifeDaySpan(from: string, to: string, maxDays: number): boolean {
    const span = dayEpoch(to) - dayEpoch(from);
    return span >= 0 && span < maxDays * dayMs;
}

function instant(value: string): number {
    if (value.length === 10) return dayEpoch(value);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
    return Number.isFinite(dayEpoch(value.slice(0, 10))) ? Date.parse(value) : NaN;
}

export function lifeOverviewWindow(query: { day: string; dayStart: string; dayEnd: string; weekStart: string; weekEnd: string }) {
    const day = dayEpoch(query.day);
    const start = instant(query.dayStart), end = instant(query.dayEnd);
    const shanghaiStart = day - 8 * hourMs;
    // The installed client sends device-local midnights and a Shanghai day.
    // Both days include the current instant, including when their labels differ.
    if (!(end > start && end - start <= 26 * hourMs && start < shanghaiStart + dayMs && end > shanghaiStart)) return null;
    if (!validLifeDaySpan(query.weekStart, query.weekEnd, 7)
        || dayEpoch(query.weekStart) > day + dayMs || dayEpoch(query.weekEnd) < day - dayMs) return null;
    return { start: new Date(start), end: new Date(end) };
}

export function lifeCalendarWindow(period: string, startValue: string, endValue: string) {
    const month = period.length === 7;
    const firstDay = month ? `${period}-01` : `${period}-01-01`;
    const first = dayEpoch(firstDay);
    const next = new Date(first);
    if (month) next.setUTCMonth(next.getUTCMonth() + 1);
    else next.setUTCFullYear(next.getUTCFullYear() + 1);

    const start = instant(startValue), end = instant(endValue);
    // The legacy client computes each boundary in its own timezone. Allow
    // timezone offsets and DST without permitting an unrelated query window.
    const validBoundary = (value: number, expected: number) => value >= expected - 14 * hourMs && value <= expected + 12 * hourMs;
    if (!(end > start && validBoundary(start, first) && validBoundary(end, next.getTime()))) return null;
    return { start: new Date(start), end: new Date(end), firstDay, lastDay: new Date(next.getTime() - dayMs).toISOString().slice(0, 10) };
}
