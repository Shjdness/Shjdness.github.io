import { useEffect, useMemo, useState } from "react"
import { Helmet } from 'react-helmet'
import { Link } from "wouter"
import { endpoint } from "../main"
import { siteName } from "../utils/constants"
import { useTranslation } from "react-i18next";

type TimelineFeed = { id: number; title: string | null; createdAt: string }
type TimelinePageData = { items: TimelineFeed[]; next: string | null }
type TimelineOptions = { years: string[]; tags: string[] }
type TimelineActivity = { days: { day: string; count: number }[] }

async function readTimeline<T>(path: string, signal: AbortSignal): Promise<T> {
    const response = await fetch(`${endpoint}/feed/timeline/${path}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    })
    if (!response.ok) throw new Error('读取时间轴失败')
    return response.json()
}

export function TimelinePage() {
    const [options, setOptions] = useState<TimelineOptions | null>(null)
    const [year, setYear] = useState('')
    const [selectedTags, setSelectedTags] = useState<string[]>([])
    const [cursor, setCursor] = useState<string>()
    const [page, setPage] = useState<TimelinePageData | null>(null)
    const [activity, setActivity] = useState<TimelineActivity | null>(null)
    const [optionsError, setOptionsError] = useState(false)
    const [activityError, setActivityError] = useState(false)
    const [pageError, setPageError] = useState(false)
    const [attempt, retry] = useState(0)
    const { t } = useTranslation()
    const changeYear = (value: string) => {
        setYear(value)
        setCursor(undefined)
        setPage(null)
        setActivity(null)
    }

    useEffect(() => {
        if (options) return
        const controller = new AbortController()
        setOptionsError(false)
        void readTimeline<TimelineOptions>('options', controller.signal).then(data => {
            if (controller.signal.aborted) return
            setOptions(data)
            setYear(data.years[0] ?? '')
        }).catch(() => { if (!controller.signal.aborted) setOptionsError(true) })
        return () => controller.abort()
    }, [attempt, options])

    useEffect(() => {
        if (!year || activity) return
        const controller = new AbortController()
        setActivityError(false)
        void readTimeline<TimelineActivity>(`activity?year=${year}`, controller.signal).then(data => {
            if (!controller.signal.aborted) setActivity(data)
        }).catch(() => { if (!controller.signal.aborted) setActivityError(true) })
        return () => controller.abort()
    }, [year, attempt, activity])

    useEffect(() => {
        if (!year) return
        const controller = new AbortController()
        const query = new URLSearchParams({ year })
        if (cursor) query.set('before', cursor)
        if (selectedTags.length) query.set('tags', JSON.stringify(selectedTags))
        setPageError(false)
        void readTimeline<TimelinePageData>(`page?${query}`, controller.signal).then(data => {
            if (controller.signal.aborted) return
            setPage(previous => cursor && previous && previous.next === cursor
                ? { ...data, items: [...previous.items, ...data.items] }
                : cursor && previous ? previous : data)
        }).catch(() => { if (!controller.signal.aborted) setPageError(true) })
        return () => controller.abort()
    }, [year, cursor, selectedTags, attempt])

    const heatmapDays = useMemo(() => {
        if (!year || !activity) return []
        const counts = new Map(activity.days.map(row => [row.day, row.count]))
        const first = Date.parse(`${year}-01-01T00:00:00Z`)
        const cells: ({ day: string; count: number } | null)[] = Array(new Date(first).getUTCDay()).fill(null)
        for (let date = first; ; date += 86400000) {
            const day = new Date(date).toISOString().slice(0, 10)
            if (!day.startsWith(year)) break
            cells.push({ day, count: counts.get(day) ?? 0 })
        }
        while (cells.length % 7 !== 0) cells.push(null)
        return cells
    }, [activity, year])

    const changeTags = (tags: string[]) => {
        setSelectedTags(tags)
        setCursor(undefined)
        setPage(null)
    }

    return (
        <>
            <Helmet>
                <title>{`${t('timeline')} - ${process.env.NAME}`}</title>
                <meta property="og:site_name" content={siteName} />
                <meta property="og:title" content={t('timeline')} />
                <meta property="og:image" content={process.env.AVATAR} />
                <meta property="og:type" content="article" />
                <meta property="og:url" content={document.URL} />
            </Helmet>
            <main className="w-full flex flex-col items-center mb-8 ani-show">
                <header className="wauto py-4"><h1 className="text-4xl font-bold">{t('timeline')}</h1></header>
                {(optionsError || pageError || activityError) && <p className="wauto" role="status">
                    {optionsError ? '归档选项读取失败' : pageError ? '文章读取失败' : '热力图读取失败'} <button type="button" onClick={() => retry(value => value + 1)}>重试</button>
                </p>}
                {!options && !optionsError && <p role="status">正在读取归档…</p>}
                {options && !options.years.length && <p>暂无公开文章</p>}
                {year && <section className="heatmap-panel wauto" aria-label={t('heatmap.title')}>
                    <div className="heatmap-heading">
                        <h2>{t('heatmap.title')}</h2>
                        <select value={year} onChange={event => changeYear(event.target.value)} aria-label={t('heatmap.year')}>
                            {options?.years.map(value => <option key={value} value={value}>{value}</option>)}
                        </select>
                    </div>
                    {activity && <div className="heatmap-grid" role="img" aria-label={`${year} ${t('heatmap.title')}`}>
                        {heatmapDays.map((day, index) => day
                            ? <span key={day.day} className={`heatmap-day level-${Math.min(4, day.count)}`}
                                title={`${day.day} · ${day.count} ${t('heatmap.posts')}`} />
                            : <span key={`blank-${index}`} className="heatmap-day is-empty" />)}
                    </div>}
                </section>}
                {year && !!options?.tags.length && <div className="inline-tag-filter wauto">
                    {options.tags.map(name => <button key={name} type="button" aria-pressed={selectedTags.includes(name)}
                        className={selectedTags.includes(name) ? 'active' : ''}
                        disabled={selectedTags.length >= 30 && !selectedTags.includes(name)}
                        onClick={() => changeTags(selectedTags.includes(name) ? selectedTags.filter(tag => tag !== name) : [...selectedTags, name])}>#{name}</button>)}
                    {!!selectedTags.length && <button type="button" onClick={() => changeTags([])}>清除筛选</button>}
                </div>}
                {year && <section className="wauto">
                    <h2 className="text-2xl font-bold">{t('year$year', { year })}</h2>
                    {!page && !pageError && <p role="status">正在读取文章…</p>}
                    {page && !page.items.length && <p>该年份暂无符合筛选的文章</p>}
                    <div className="w-full my-4">
                        {page?.items.map(({ id, title, createdAt }) => (
                            <FeedItem key={id} id={String(id)} title={title || t('untitled')} createdAt={new Date(createdAt)} />
                        ))}
                    </div>
                    {page?.next && <button className="site-nav-link" type="button" disabled={cursor === page.next}
                        onClick={() => setCursor(page.next ?? undefined)}>{cursor === page.next && !pageError ? '正在读取…' : '加载更多'}</button>}
                </section>}
            </main>
        </>
    )
}

export function FeedItem({ id, title, createdAt }: { id: string, title: string, createdAt: Date }) {
    const formatter = new Intl.DateTimeFormat('en-US', { day: '2-digit', month: '2-digit', timeZone: 'Asia/Shanghai' });
    return (
        <div className="flex flex-row pl-8">
            <div className="flex flex-row items-center">
                <div className="w-2 h-2 bg-theme rounded-full"></div>
            </div>
            <div className="flex-1 rounded-2xl m-2 duration-300 flex flex-row items-center space-x-4   ">
                <span className="t-secondary text-sm" title={new Date(createdAt).toLocaleString()}>
                    {formatter.format(new Date(createdAt))}
                </span>
                <Link href={`/blog/feed/${id}`} target="_blank" className="text-base t-primary hover:text-theme text-pretty overflow-hidden">
                    {title}
                </Link>
            </div>
        </div>
    )
}
