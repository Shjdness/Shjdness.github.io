import { useEffect, useMemo, useState } from "react";
import { Helmet } from "react-helmet";
import { FeedCard } from "../components/feed_card";
import { Waiting } from "../components/loading";
import { diaryTimestamp } from "../data/blog";
import { client } from "../main";
import { headersWithAuth } from "../utils/auth";

export function DiaryPage() {
  const [feeds, setFeeds] = useState<any[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    setFeeds(null);
    setLoadError(false);
    client.feed.diary
      .get({ headers: headersWithAuth() })
      .then(({ data, error }: any) => {
        if (error || !Array.isArray(data)) throw new Error("Diary request failed");
        if (!cancelled) setFeeds(
          [...data].sort(
            (a: any, b: any) => diaryTimestamp(b) - diaryTimestamp(a),
          ),
        );
      })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [retry]);
  const tagNames = useMemo(
    () =>
      [
        ...new Set(
          (feeds || []).flatMap(
            (feed) => feed.hashtags?.map((tag: any) => tag.name) || [],
          ),
        ),
      ].sort() as string[],
    [feeds],
  );
  const visible = useMemo(
    () =>
      (feeds || []).filter(
        (feed) =>
          selectedTags.length === 0 ||
          selectedTags.every((name) =>
            feed.hashtags?.some((tag: any) => tag.name === name),
          ),
      ),
    [feeds, selectedTags],
  );
  const groups = useMemo(() => {
    const result = new Map<number, Map<number, Map<number, any[]>>>();
    for (const feed of visible) {
      const date = new Date(diaryTimestamp(feed));
      const year = date.getFullYear();
      const month = date.getMonth() + 1;
      const week = isoWeek(date);
      if (!result.has(year)) result.set(year, new Map());
      if (!result.get(year)!.has(month))
        result.get(year)!.set(month, new Map());
      if (!result.get(year)!.get(month)!.has(week))
        result.get(year)!.get(month)!.set(week, []);
      result.get(year)!.get(month)!.get(week)!.push(feed);
    }
    return result;
  }, [visible]);
  const current = new Date();
  return (
    <>
      <Helmet>
        <title>日记 - {process.env.NAME}</title>
      </Helmet>
      {loadError ? (
        <main className="diary-page ani-show">
          <header><p>PRIVATE JOURNAL</p><h1>日记</h1></header>
          <p role="alert">暂时无法读取云端日记，请检查网络后重试。页面空白不代表记录已丢失。</p>
          <button type="button" onClick={() => setRetry(value => value + 1)}>重新加载</button>
        </main>
      ) : <Waiting for={feeds !== null}>
        <main className="diary-page ani-show">
          <header>
            <p>PRIVATE JOURNAL</p>
            <h1>日记</h1>
            <span>私人日记按日期由近到远排列。</span>
          </header>
          {tagNames.length > 0 && (
            <div className="inline-tag-filter">
              {tagNames.map((name) => (
                <button
                  key={name}
                  className={selectedTags.includes(name) ? "active" : ""}
                  onClick={() =>
                    setSelectedTags((value) =>
                      value.includes(name)
                        ? value.filter((item) => item !== name)
                        : [...value, name],
                    )
                  }
                >
                  #{name}
                </button>
              ))}
              {selectedTags.length > 0 && (
                <button onClick={() => setSelectedTags([])}>清除筛选</button>
              )}
            </div>
          )}
          <button
            className="diary-index-toggle"
            onClick={() =>
              document.querySelector(".diary-index")?.classList.toggle("open")
            }
          >
            时间检查表 <i className="ri-calendar-line" />
          </button>
          <div className="diary-layout">
            <aside className="diary-index">
              <strong>时间检查表</strong>
              {[...groups.entries()].map(([year, months]) => (
                <details key={year} open={year === current.getFullYear()}>
                  <summary>{year}</summary>
                  {[...months.entries()].map(([month, weeks]) => (
                    <details key={month}>
                      <summary>{String(month).padStart(2, "0")} 月</summary>
                      {[...weeks.entries()].map(([week, entries]) => (
                        <a key={week} href={`#diary-${entries[0].id}`}>
                          Week {week}
                          <small>{entries.length}</small>
                        </a>
                      ))}
                    </details>
                  ))}
                </details>
              ))}
            </aside>
            <section className="diary-list">
              {visible.map(({ id, title, ...feed }) => (
                <div id={`diary-${id}`} key={id}>
                  <FeedCard id={id} title={title || "未命名日记"} {...feed} />
                </div>
              ))}
              {visible.length === 0 && (
                <p className="life-coming-soon">暂时没有符合条件的日记。</p>
              )}
            </section>
          </div>
        </main>
      </Waiting>}
    </>
  );
}

function isoWeek(date: Date) {
  const target = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil(
    ((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
}
