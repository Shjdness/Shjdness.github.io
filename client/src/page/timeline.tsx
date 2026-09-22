import { useEffect, useMemo, useRef, useState } from "react"
import { Helmet } from 'react-helmet'
import { Link, useLocation } from "wouter"
import { Waiting } from "../components/loading"
import { client } from "../main"
import { headersWithAuth } from "../utils/auth"
import { siteName } from "../utils/constants"
import { useTranslation } from "react-i18next";

type TimelineFeed = { id: number; title: string | null; createdAt: Date }

export function TimelinePage() {
    const [feeds, setFeeds] = useState<Partial<Record<number, TimelineFeed[]>>>()
    const [length, setLength] = useState(0)
    const ref = useRef(false)
    const [, setLocation] = useLocation()
    const [heatmapYear, setHeatmapYear] = useState(new Date().getFullYear())
    const { t } = useTranslation()
    function fetchFeeds() {
        client.feed.timeline.get({
            headers: headersWithAuth()
        }).then(({ data }) => {
            if (data && typeof data !== 'string') {
                setLength(data.length)
                const groups = Object.groupBy(data, ({ createdAt }) => new Date(createdAt).getFullYear())
                setFeeds(groups)
                const latestYear = Math.max(...data.map(({ createdAt }) => new Date(createdAt).getFullYear()))
                if (Number.isFinite(latestYear)) setHeatmapYear(latestYear)
            }
        })
    }
    useEffect(() => {
        if (ref.current) return
        fetchFeeds()
        ref.current = true
    }, [])
    const allFeeds = useMemo(() => Object.values(feeds || {}).flat().filter((feed): feed is TimelineFeed => Boolean(feed)), [feeds])
    const years = useMemo(() => [...new Set(allFeeds.map(({ createdAt }) => new Date(createdAt).getFullYear()))].sort((a, b) => b - a), [allFeeds])
    const heatmapDays = useMemo(() => {
        const counts = new Map<string, number>()
        allFeeds.forEach(({ createdAt }) => {
            const date = new Date(createdAt)
            if (date.getFullYear() !== heatmapYear) return
            const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
            counts.set(key, (counts.get(key) || 0) + 1)
        })
        const first = new Date(heatmapYear, 0, 1)
        const last = new Date(heatmapYear, 11, 31)
        const cells: ({ date: Date; count: number } | null)[] = Array(first.getDay()).fill(null)
        for (let date = new Date(first); date <= last; date.setDate(date.getDate() + 1)) {
            const day = new Date(date)
            const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`
            cells.push({ date: day, count: counts.get(key) || 0 })
        }
        while (cells.length % 7 !== 0) cells.push(null)
        return cells
    }, [allFeeds, heatmapYear])

    function wanderRandomly() {
        if (allFeeds.length === 0) return
        const oldestFirst = [...allFeeds].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        const oldPool = oldestFirst.slice(0, Math.max(1, Math.ceil(oldestFirst.length * 0.8)))
        const selected = oldPool[Math.floor(Math.random() * oldPool.length)]
        setLocation(`/blog/feed/${selected.id}`)
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
            <Waiting for={feeds}>
                <main className="w-full flex flex-col justify-center items-center mb-8 ani-show">
                    <div className="wauto text-start text-black dark:text-white py-4 text-4xl font-bold">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                            <p>{t('timeline')}</p>
                            <div className="flex flex-wrap gap-2">
                                <button type="button" className="gallery-entry group" onClick={wanderRandomly}>
                                    <span className="text-sm font-semibold">{t('random_wander')}</span>
                                    <i className="ri-shuffle-line text-base" aria-hidden="true" />
                                </button>
                                <Link
                                    href="/blog/gallery"
                                    className="gallery-entry group"
                                    aria-label="浏览全部图片"
                                >
                                    <span className="text-sm font-semibold">影集 Gallery</span>
                                    <i className="ri-arrow-right-line text-base" aria-hidden="true" />
                                </Link>
                            </div>
                        </div>
                        <div className="flex flex-row justify-between">
                            <p className="text-sm mt-4 text-neutral-500 font-normal">
                                {t('article.total$count', { count: length })}
                            </p>
                        </div>
                    </div>
                    <section className="heatmap-panel wauto" aria-label={t('heatmap.title')}>
                        <div className="heatmap-heading">
                            <div>
                                <h2>{t('heatmap.title')}</h2>
                                <p>{t('heatmap.subtitle')}</p>
                            </div>
                            <select value={heatmapYear} onChange={(event) => setHeatmapYear(Number(event.target.value))} aria-label={t('heatmap.year')}>
                                {years.map(year => <option key={year} value={year}>{year}</option>)}
                            </select>
                        </div>
                        <div className="heatmap-grid" role="img" aria-label={`${heatmapYear} ${t('heatmap.title')}`}>
                            {heatmapDays.map((day, index) => day ? (
                                <span
                                    key={day.date.toISOString()}
                                    className={`heatmap-day level-${Math.min(4, day.count)}`}
                                    title={`${day.date.toLocaleDateString('zh-CN')} · ${day.count} ${t('heatmap.posts')}`}
                                />
                            ) : <span key={`blank-${index}`} className="heatmap-day is-empty" />)}
                        </div>
                    </section>
                    {feeds && Object.keys(feeds).sort((a, b) => parseInt(b) - parseInt(a)).map(year => (
                        <div key={year} className="wauto flex flex-col justify-center items-start">
                            <h1 className="flex flex-row items-center space-x-2">
                                <span className="text-2xl font-bold t-primary ">
                                    {t('year$year', { year: year })}
                                </span>
                                <span className="text-sm t-secondary">
                                    {t('article.total_short$count', { count: feeds[+year]?.length })}
                                    </span>
                            </h1>
                            <div className="w-full flex flex-col justify-center items-start my-4">
                                {feeds[+year]?.map(({ id, title, createdAt }) => (
                                    <FeedItem key={id} id={id.toString()} title={title || t('untitled')} createdAt={new Date(createdAt)} />
                                ))}
                            </div>
                        </div>
                    ))}
                </main>
            </Waiting>
        </>
    )
}

export function FeedItem({ id, title, createdAt }: { id: string, title: string, createdAt: Date }) {
    const formatter = new Intl.DateTimeFormat('en-US', { day: '2-digit', month: '2-digit' });
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
