import { XMLParser } from "fast-xml-parser";

export const FEED = "https://www.youtube.com/feeds/videos.xml?channel_id=";
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});
const list = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const clean = (value: unknown, max = 4000) =>
  text(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

function channelIdFromFeed(value: string) {
  try {
    return new URL(value).searchParams.get("channel_id") || "";
  } catch {
    return "";
  }
}

export function channelIdFromUrl(value: string) {
  try {
    const source = new URL(value);
    return (
      source.searchParams.get("channel_id") ||
      source.pathname.match(/^\/channel\/(UC[\w-]+)/)?.[1] ||
      ""
    );
  } catch {
    return "";
  }
}

export function isChannelId(value: string) {
  return /^UC[\w-]{20,}$/.test(value);
}

export function parseYouTubeFeed(xml: string) {
  const root = parser.parse(xml)?.feed || {};
  const author = clean(root.author?.name, 200);
  const videos = list<Record<string, any>>(root.entry)
    .map((entry) => {
      const id = clean(
        entry["yt:videoId"] || text(entry.id).replace("yt:video:", ""),
        100,
      );
      const media = entry["media:group"] || {};
      const alternate = list<Record<string, any>>(entry.link).find(
        (link) => link?.["@_rel"] === "alternate",
      );
      const url =
        text(alternate?.["@_href"]) || `https://www.youtube.com/watch?v=${id}`;
      return {
        externalId: id,
        title: clean(entry.title || media["media:title"] || "未命名视频", 500),
        url,
        summary: clean(media["media:description"] || entry.content || "", 4000),
        author: clean(entry.author?.name || author, 200),
        publishedAt: new Date(entry.published || entry.updated || Date.now()),
        thumbnailUrl:
          text(media["media:thumbnail"]?.["@_url"]) ||
          `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
      };
    })
    .filter(
      (video) =>
        video.externalId &&
        !/youtube\.com\/shorts\//i.test(video.url) &&
        !/(^|\s)#shorts?(\s|$)/i.test(`${video.title} ${video.summary}`),
    );
  const self = list<Record<string, any>>(root.link).find(
    (link) => link?.["@_rel"] === "self",
  );
  return {
    channelId: clean(
      root["yt:channelId"] || channelIdFromFeed(text(self?.["@_href"])),
      100,
    ),
    title: clean(root.title || author || "YouTube", 160),
    videos,
  };
}

export async function fetchText(
  url: string,
  accept = "application/atom+xml,text/html",
) {
  let lastStatus = 0;
  // YouTube's Atom endpoint intermittently returns 404/5xx for an otherwise
  // valid channel (including from non-browser data-centre egress). Treat every
  // non-success response as transient for a few short attempts; a genuinely
  // missing channel will still fail with the last status.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        Accept: accept,
        "User-Agent": "Mozilla/5.0",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok)
      return { body: await response.text(), finalUrl: response.url };
    lastStatus = response.status;
    if (response.status === 401 || response.status === 403) break;
    await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
  }
  throw new Error(`YouTube 返回 ${lastStatus || "网络错误"}`);
}

export async function resolveChannelId(input: string) {
  let source: URL;
  try {
    source = new URL(input.trim());
  } catch {
    throw new Error("请粘贴 YouTube 频道或官方 Feed 地址");
  }
  if (
    source.protocol !== "https:" ||
    !/(^|\.)youtube\.com$/.test(source.hostname)
  )
    throw new Error("目前仅支持 YouTube 频道");
  const fromFeed =
    source.pathname === "/feeds/videos.xml"
      ? source.searchParams.get("channel_id")
      : "";
  const fromChannel =
    source.pathname.match(/^\/channel\/(UC[\w-]+)/)?.[1] || "";
  if (fromFeed || fromChannel)
    return { channelId: fromFeed || fromChannel, sourceUrl: source.toString() };
  const page = await fetchText(source.toString(), "text/html");
  const id =
    page.body.match(/"channelId":"(UC[\w-]+)"/)?.[1] ||
    page.body.match(/<meta itemprop="channelId" content="(UC[\w-]+)"/)?.[1] ||
    page.body.match(/youtube\.com\/channel\/(UC[\w-]+)/)?.[1];
  if (!id)
    throw new Error(
      "无法识别频道 ID；请使用 /channel/UC… 或 feeds/videos.xml?channel_id=UC…",
    );
  return { channelId: id, sourceUrl: source.toString() };
}

export async function resolveYouTubeSource(input: string) {
  const { channelId, sourceUrl } = await resolveChannelId(input);
  const feedUrl = `${FEED}${channelId}`;
  const parsed = parseYouTubeFeed((await fetchText(feedUrl)).body);
  return {
    sourceUrl,
    feedUrl,
    provider: "native",
    platform: "youtube",
    externalId: channelId,
    title: parsed.title,
    description: "",
    siteUrl: `https://www.youtube.com/channel/${channelId}`,
    icon: "",
    category: "视频",
    preview: parsed.videos
      .slice(0, 3)
      .map((video) => ({ ...video })),
  };
}
