import { useContext, useEffect, useRef, useState } from "react"
import { Helmet } from 'react-helmet'
import { Link, useSearch } from "wouter"
import { FeedCard } from "../components/feed_card"
import { Waiting } from "../components/loading"
import { client } from "../main"
import { ProfileContext } from "../state/profile"
import { headersWithAuth } from "../utils/auth"
import { siteName } from "../utils/constants"
import { tryInt } from "../utils/int"
import { useTranslation } from "react-i18next";
import { useAlert, useConfirm } from "../components/dialog";
import { Cache } from "../utils/cache";
import { getCookie } from "typescript-cookie";
import { writingAccountId } from "../utils/writing-access";

type FeedsData = {
    size: number,
    data: any[],
    hasNext: boolean
}

type FeedType = 'draft' | 'normal'

type FeedsMap = {
    [key in FeedType]: FeedsData
}

const feedTypeFromQuery = (value: string | null): FeedType => value === 'draft' ? 'draft' : 'normal'

export function FeedsPage({ fixedType }: { fixedType?: FeedType } = {}) {
    const { t } = useTranslation()
    const query = new URLSearchParams(useSearch());
    const profile = useContext(ProfileContext);
    const [listState, _setListState] = useState<FeedType>(fixedType || feedTypeFromQuery(query.get("type")))
    const [status, setStatus] = useState<'loading' | 'idle'>('idle')
    const [feeds, setFeeds] = useState<FeedsMap>({
        draft: { size: 0, data: [], hasNext: false },
        normal: { size: 0, data: [], hasNext: false }
    })
    const page = tryInt(1, query.get("page"))
    const limit = tryInt(10, query.get("limit"), process.env.PAGE_SIZE)
    const ref = useRef("")
    const { showAlert, AlertUI } = useAlert()
    const { showConfirm, ConfirmUI } = useConfirm()
    const deleteDraft = (id: string) => {
        const token = getCookie('token');
        const ownerId = writingAccountId(profile, token);
        if (ownerId === null) return;
        showConfirm('删除草稿', '这篇草稿将从云端永久删除，其他设备也无法再继续编辑。确定删除吗？', async () => {
            if (getCookie('token') !== token) return;
            const { error } = await client.feed({ id: Number(id) }).delete(null, { query: { draftOnly: '1' }, headers: headersWithAuth() })
            if (error) {
                showAlert(typeof error.value === 'string' ? error.value : '删除失败，请稍后重试')
                return
            }
            Cache.forAccount(ownerId, Number(id)).clear()
            if (getCookie('token') !== token) return;
            setFeeds(current => {
                const data = current.draft.data.filter(item => String(item.id) !== id)
                return { ...current, draft: { ...current.draft, data, size: data.length } }
            })
        })
    }
    function fetchFeeds(type: FeedType) {
        if (type === 'draft') {
            client.feed.drafts.get({ headers: headersWithAuth() }).then(({ data }) => {
                const drafts = data && typeof data !== 'string' ? data : []
                setFeeds(current => ({ ...current, draft: { size: drafts.length, data: drafts, hasNext: false } }))
                setStatus('idle')
            }).catch(() => setStatus('idle'))
            return
        }
        client.feed.get({
            query: {
                page: page,
                limit: limit,
                type: type,
                contentType: type === 'normal' ? 'normal' : undefined
            },
            headers: headersWithAuth()
        }).then(({ data }) => {
            if (data && typeof data !== 'string') {
                setFeeds(current => ({
                    ...current,
                    [type]: data
                }))
                setStatus('idle')
            }
        }).catch(() => setStatus('idle'))
    }
    useEffect(() => {
        const key = `${query.get("page")} ${query.get("type")}`
        if (ref.current == key) return
        const type = fixedType || feedTypeFromQuery(query.get("type"))
        if (type !== listState) {
            _setListState(type)
        }
        setStatus('loading')
        fetchFeeds(type)
        ref.current = key
    }, [query.get("page"), query.get("type")])
    return (
        <>
            <Helmet>
                <title>{`${t('article.title')} - ${process.env.NAME}`}</title>
                <meta property="og:site_name" content={siteName} />
                <meta property="og:title" content={t('article.title')} />
                <meta property="og:image" content={process.env.AVATAR} />
                <meta property="og:type" content="article" />
                <meta property="og:url" content={document.URL} />
            </Helmet>
            <Waiting for={feeds.draft.size + feeds.normal.size > 0 || status === 'idle'}>
                <main className="mb-8">
                    <section className="article-library-content">
                    <div className="wauto text-start text-black dark:text-white py-4 text-4xl font-bold">
                        <p>
                            {listState === 'draft' ? t('draft_bin') : t('article.title')}
                        </p>
                        {listState === 'normal' && <details className="article-archive-links text-sm font-normal mt-4">
                            <summary>归档</summary>
                            <Link href="/blog/timeline">按年份和标签浏览</Link>
                            <Link href="/blog/gallery">影集</Link>
                        </details>}
                        <div className="flex flex-row justify-between">
                            <p className="text-sm mt-4 text-neutral-500 font-normal">
                                {t('article.total$count', { count: feeds[listState]?.size })}
                            </p>
                            {profile?.canWrite && !fixedType &&
                                <div className="flex flex-row space-x-4">
                                    <Link href={listState === 'draft' ? '/blog/articles?type=normal' : '/blog/articles?type=draft'} className={`mobile-secondary text-sm mt-4 text-neutral-500 font-normal ${listState === 'draft' ? "text-theme" : ""}`}>
                                        {t('draft_bin')}
                                    </Link>
                                </div>
                            }
                        </div>
                    </div>
                    <Waiting for={status === 'idle'}>
                        <div className="wauto flex flex-col ani-show">
                            {feeds[listState].data.map(({ id, ...feed }: any) => (
                                <FeedCard key={id} id={id} {...feed} onDelete={listState === 'draft' ? deleteDraft : undefined} />
                            ))}
                        </div>
                        <div className="wauto flex flex-row items-center mt-4 ani-show">
                            {page > 1 &&
                                <Link href={`/blog/articles?type=${listState}&page=${(page - 1)}`}
                                    className={`text-sm font-normal rounded-full px-4 py-2 text-white bg-theme`}>
                                    {t('previous')}
                                </Link>
                            }
                            <div className="flex-1" />
                            {feeds[listState]?.hasNext &&
                                <Link href={`/blog/articles?type=${listState}&page=${(page + 1)}`}
                                    className={`text-sm font-normal rounded-full px-4 py-2 text-white bg-theme`}>
                                    {t('next')}
                                </Link>
                            }
                        </div>
                    </Waiting>
                    </section>
                </main>
            </Waiting>
            <AlertUI />
            <ConfirmUI />
        </>
    )
}
