import { useEffect, useMemo, useState } from "react"
import { Helmet } from "react-helmet"
import { Link } from "wouter"
import Lightbox from "yet-another-react-lightbox"
import Counter from "yet-another-react-lightbox/plugins/counter"
import Download from "yet-another-react-lightbox/plugins/download"
import Zoom from "yet-another-react-lightbox/plugins/zoom"
import "yet-another-react-lightbox/styles.css"
import { client } from "../main"
import { headersWithAuth } from "../utils/auth"
import { siteName } from "../utils/constants"

const LEGACY_ASSET_ORIGIN = "https://shjdbucket.shjdshy.cc"
const CURRENT_ASSET_ORIGIN = "https://pub-6b7dbaf76cfd4a81a8445a368adad8ad.r2.dev"

type GalleryImage = {
  src: string
  title: string
  createdAt: Date
  feedId?: number
  order: number
}

type FeedSummary = {
  id: number
  title: string | null
  createdAt: Date
}

const normalizeAssetUrl = (url: string) =>
  url.replace(LEGACY_ASSET_ORIGIN, CURRENT_ASSET_ORIGIN)

function extractImageUrls(content: string) {
  const urls: string[] = []
  const markdownImage = /!\[[^\]]*\]\((?:<)?([^\s)>]+)(?:>)?(?:\s+["'][^"']*["'])?\)/g
  const htmlImage = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi

  for (const match of content.matchAll(markdownImage)) urls.push(match[1])
  for (const match of content.matchAll(htmlImage)) urls.push(match[1])

  return [...new Set(urls.map(normalizeAssetUrl))]
}

const featuredImages: GalleryImage[] = [
  {
    src: "/background-home-v2.jpg",
    title: "首页 · 花园",
    createdAt: new Date("2026-09-18T00:00:00+08:00"),
    order: 0,
  },
  {
    src: "/background-inner.jpg",
    title: "内页 · 海与晨昏",
    createdAt: new Date("2026-09-17T00:00:00+08:00"),
    order: 1,
  },
]

export function GalleryPage() {
  const [remoteImages, setRemoteImages] = useState<GalleryImage[]>([])
  const [loading, setLoading] = useState(true)
  const [backendUnavailable, setBackendUnavailable] = useState(false)
  const [openIndex, setOpenIndex] = useState(-1)

  useEffect(() => {
    let cancelled = false

    async function loadGallery() {
      try {
        const feeds: FeedSummary[] = []
        let page = 1
        let hasNext = true

        while (hasNext) {
          const { data } = await client.feed.index.get({
            query: { page, limit: 50, type: "normal" },
            headers: headersWithAuth(),
          })

          if (!data || typeof data === "string") break
          feeds.push(...(data.data as FeedSummary[]))
          hasNext = data.hasNext
          page += 1
        }

        const posts = await Promise.all(
          feeds.map(async (summary) => {
            const { data } = await client.feed({ id: summary.id }).get({
              headers: headersWithAuth(),
            })

            if (!data || typeof data === "string") return []
            return extractImageUrls(data.content).map((src, order) => ({
              src,
              title: data.title || "未命名文章",
              createdAt: new Date(data.createdAt),
              feedId: data.id,
              order,
            }))
          }),
        )

        if (!cancelled) setRemoteImages(posts.flat())
      } catch {
        if (!cancelled) setBackendUnavailable(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadGallery()
    return () => {
      cancelled = true
    }
  }, [])

  const images = useMemo(() => {
    const seen = new Set<string>()
    return [...featuredImages, ...remoteImages]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.order - b.order)
      .filter(({ src }) => {
        if (seen.has(src)) return false
        seen.add(src)
        return true
      })
  }, [remoteImages])

  const slides = images.map(({ src, title, createdAt }) => ({
    src,
    title,
    description: createdAt.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
  }))

  return (
    <>
      <Helmet>
        <title>{`影集 - ${process.env.NAME}`}</title>
        <meta property="og:site_name" content={siteName} />
        <meta property="og:title" content="影集 Gallery" />
        <meta property="og:image" content="/background-home-v2.jpg" />
      </Helmet>

      <main className="gallery-page wauto mx-auto pb-12 ani-show">
        <div className="gallery-heading">
          <div>
            <p className="gallery-kicker">VISUAL ARCHIVE</p>
            <h1>影集 <span>Gallery</span></h1>
            <p className="gallery-subtitle">沿时间倒序，收藏那些曾在这里出现的画面。</p>
          </div>
          <Link href="/timeline" className="gallery-back">
            <i className="ri-arrow-left-line" aria-hidden="true" />
            返回时间线
          </Link>
        </div>

        {backendUnavailable && (
          <p className="gallery-notice">文章图片暂时未能载入，站点背景仍可正常浏览。</p>
        )}

        <section className="gallery-grid" aria-busy={loading} aria-label="图片集合">
          {images.map((image, index) => (
            <button
              key={`${image.src}-${image.feedId ?? "featured"}`}
              className="gallery-card group"
              onClick={() => setOpenIndex(index)}
              aria-label={`查看大图：${image.title}`}
            >
              <img src={image.src} alt={image.title} loading={index < 4 ? "eager" : "lazy"} />
              <span className="gallery-card__veil" />
              <span className="gallery-card__meta">
                <span className="gallery-card__date">
                  {image.createdAt.toLocaleDateString("zh-CN", {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                  })}
                </span>
                <span className="gallery-card__title">{image.title}</span>
              </span>
              <span className="gallery-card__open" aria-hidden="true">
                <i className="ri-expand-diagonal-line" />
              </span>
            </button>
          ))}

          {loading && (
            <div className="gallery-card gallery-card--loading" aria-label="正在载入文章图片">
              <i className="ri-loader-4-line" />
              <span>正在整理图片…</span>
            </div>
          )}
        </section>
      </main>

      <Lightbox
        open={openIndex >= 0}
        close={() => setOpenIndex(-1)}
        index={openIndex}
        slides={slides}
        plugins={[Counter, Zoom, Download]}
        carousel={{ finite: true }}
        controller={{ closeOnBackdropClick: true }}
        animation={{ fade: 280, swipe: 360 }}
        zoom={{ maxZoomPixelRatio: 4, scrollToZoom: true }}
      />
    </>
  )
}
