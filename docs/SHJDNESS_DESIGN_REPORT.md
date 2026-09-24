# Shjdness 个人网站设计与架构报告

更新时间：2026-09-24  
当前仓库：`Shjdness/Shjdness.github.io`  
基础项目：开源博客项目 Rin

## 1. 项目定位

本项目从 Rin 的个人博客程序演进为一个分成两个空间的个人网站：

```text
Home
├── Blog：公开内容、文章、日记、时间线、标签、影集、写作
└── Life：仅本人/受信任账户可见的生活记录与阅读工作台
```

核心原则是：Blog 负责公开表达，Life 负责私人记录；两者共用同一套登录、API、数据库和部署管线，但在导航、权限和数据边界上分开。

## 2. 从 Rin 继承的基础能力

Rin 原本是 Cloudflare 全家桶博客：静态前端、Cloudflare Worker 后端、D1 数据库、R2/S3 兼容对象存储。当前项目保留了这些稳定能力：

- GitHub OAuth 登录、Owner 权限和普通用户角色。
- 文章创建、编辑、草稿、仅自己可见、置顶、别名和是否列出。
- Markdown 编辑与预览、代码高亮、数学公式、Mermaid、图片粘贴/上传。
- 标签解析、标签页面、文章搜索、文章时间线、评论和 Webhook 通知。
- 第一张图片作为文章卡片头图、文章访问量统计、SEO 相关接口。
- Cloudflare Pages/Worker/D1/R2 的部署方式及 GitHub Actions 自动化。

原 Rin 中的朋友/友链模块曾经存在，但已不再作为本项目产品功能使用；当前页面导航已按 Blog/Life 重构。部分旧的国际化依赖仍被老组件引用，但用户可见语言入口已经收束为简体中文。

## 3. 当前产品结构

```text
/
├── Home
│
├── /blog                         Blog 空间
│   ├── /blog                     普通文章首页
│   ├── /blog/articles            文章列表
│   ├── /blog/timeline            普通文章时间线
│   ├── /blog/diary               独立日记页
│   ├── /blog/tags                标签索引
│   ├── /blog/tag/:name           标签结果
│   ├── /blog/gallery             影集入口/图片集合
│   ├── /blog/search/:keyword     搜索
│   ├── /blog/writing             新建文章
│   ├── /blog/writing/:id         编辑文章
│   └── /blog/feed/:id            文章详情
│
└── /life                         Private Life 空间
    ├── /life                     Overview
    ├── /life/habits              习惯
    ├── /life/calendar            月历与日记录聚合
    ├── /life/year                年度视图/热力图
    ├── /life/pomodoro            番茄钟
    ├── /life/rss                 独立 RSS 阅读器
    └── /life/guide               HowToLiveBetter 生活指南
```

旧地址如 `/timeline`、`/rss`、`/writing`、`/:alias` 保留跳转，以免旧书签失效。

## 4. Blog 结构重构

### 4.1 普通文章与日记分流

当前兼容旧文章数据，使用 `tags.includes("日记")` 判断日记；同时在数据层统一了普通文章和日记的读取逻辑。

- 普通 Blog 首页、文章列表、Timeline、普通标签结果排除日记。
- `/blog/diary` 只显示日记，按时间倒序。
- 标签页点击“日记”直接进入 Diary。
- 写作页选择日记标签后，会固定为私人/不列出内容。
- 未来可以迁移到显式 `type: diary`，但不要求一次性修改旧数据。

### 4.2 视觉与交互

- 首页、Blog、Life 使用不同背景和玻璃卡片层。
- 深夜模式采用深蓝背景、浅色正文、粉色强调色。
- 首页文章卡片支持上下滑入/滑出动画。
- Tag 结果使用较小标题，避免长标题撑破卡片。
- Gallery 支持图片集合、时间排序、预览、大图和返回。

## 5. Life 私人空间

### 5.1 权限模型

权限由 Worker 和前端双重检查：

```text
visitor  -> 只能访问公开 Blog
member   -> 普通登录用户
trusted  -> 可使用自己的 Life 数据
owner    -> 网站所有者，可管理站点和自己的 Life 数据
```

所有习惯、番茄钟、RSS、Today、日历数据都带 `owner_id`，接口读取和写入始终按当前用户隔离。受信任账户可以操作自己的数据，不能改动 Owner 的私有记录。

### 5.2 访客账户

已加入安全码登录的访客账户：

- 固定名称“悲若兮”。
- 使用独立头像。
- 由服务端安全码、IP 限流和固定 guest openid 控制。
- 具备受信任 Life 权限，但不能执行 Owner 级别的站点管理操作。
- 访客数据属于访客自身，不写入 Owner 的文章、账号或私有记录。

### 5.3 Habit、Today、Calendar

- Habit 支持新增、编辑、停用、永久删除和每日打卡。
- 删除习惯时同步清理其历史打卡记录。
- Today 每天最多三项，支持勾选、编辑和删除。
- Today 条目在服务端增加 owner/date/content 唯一索引，并清理历史重复数据，防止刷新后递归复制。
- 日历聚合 Today、习惯完成、Pomodoro、RSS 已读/收藏和日记便签。
- 日历下拉只显示启用中的习惯，停用/删除项目不再污染选择框。
- 日便签支持保存和清除。
- 年视图显示年度活动热力图，已移除不必要的横向白色选择条。

### 5.4 Pomodoro

- Focus/Break/Rounds 可调并保存在本地偏好。
- 数字输入允许暂时清空，失焦或启动时再校验。
- 当前任务名可填写，不再显示预置的干扰性示例文本。
- Focus 完成后自动进入 Break；支持提前完成、跳过休息和停止。
- 少于 5 分钟的事件不保存、不进入日历。
- session 记录任务名、实际专注时长、轮次和是否提前完成。

## 6. RSS 阅读器

RSS 是当前改动最大的模块，定位为桌面端媒体阅读工作台，而不是普通列表页。

### 6.1 页面布局

```text
RSS 独立页面
├── 左侧：来源、分组、未读、收藏、类型筛选
└── 右侧：卡片网格或单条阅读器
```

- 从 Life 导航进入，但进入后隐藏全局 Header、头像、账号、Footer。
- 页面固定在视口内，左栏独立滚动。
- 左栏可扩大、收起和管理来源分组。
- 视频以卡片网格展示，点击后进入大播放器。
- 文章阅读区可滚动，视频/图片阅读区尽量固定无滚动条。
- 视频操作按钮位于播放器下方：返回、收藏、原始链接。
- 图片支持缩放、下载和 `Esc` 关闭。
- 未读支持一键清除；不再保留不需要的“全部/今日”入口。
- 右侧不再显示重复的来源大标题、条数和设置栏。

### 6.2 支持的来源

直接支持：

- RSS 2.0
- Atom
- JSON Feed
- 具有标准 `<link rel="alternate">` 的普通网站自动发现
- YouTube 官方频道 Feed、频道主页、`/channel/UC...` 地址和部分 Handle 页面
- RSSHub 路由
- Bilibili 用户空间地址
- X/Twitter 用户主页

媒体识别支持文章、视频、图片和音频；YouTube 使用 `youtube-nocookie.com` 嵌入，Bilibili 视频按 BV 号生成播放器地址。

### 6.3 抓取与存储策略

- Worker 只抓取 Feed XML/JSON 和缩略图地址，不下载视频原文件。
- 每次来源最多保存最近 250 条，数据库以 subscription + externalId 去重。
- 前端一次读取最多 200 条，并支持加载更早内容。
- YouTube 缩略图使用较小规格并懒加载。
- 刷新不再一次并发请求全部来源，而是最多 3 个并发任务，返回具体失败来源。
- Worker 增加每 6 小时一次的 scheduled refresh，让来源逐步积累历史内容。

### 6.4 RSSHub 限制与内部实例接口

公共 `rsshub.app` 可能返回 Cloudflare 人机验证、403 或资源超限，Worker 无法安全绕过。当前代码会把这类错误明确显示为“公共 RSSHub 拒绝服务器访问”，而不是伪装成成功。

已经预留：

```text
RSSHUB_BASE_URL=https://你的自建实例
```

切换后，Bilibili/X 路由和以 `/...` 开头的 RSSHub 路由使用该实例；原有公共 `rsshub.app` 地址也会在刷新时迁移到新实例的同一路径。自建 RSSHub 应部署在适合运行 Node/Docker 的 VPS、Render、Railway 等环境，不建议直接塞进 Cloudflare Worker。

## 7. HowToLiveBetter 生活指南

仓库 `Shjdness/HowToLiveBetter` 在构建阶段被转换为静态 `life-guide.json`：

```text
GitHub 仓库 Markdown
        ↓
pages workflow 构建脚本
        ↓
client/public/life-guide.json
        ↓
Service Worker / IndexedDB
        ↓
本地搜索、分类、收藏
```

当前定位是 Life 的低打扰知识层：Overview 可以展示每日一条，Guide 页面按关键词和分类搜索，收藏状态保存在本地。它不自动写入日历，也不自动创建习惯；如需转为习惯，应由用户确认后创建。

## 8. Local-first 与同步设计

### 8.1 三层结构

```text
静态资源缓存
├── App Shell
├── CSS/JS/字体/背景
├── manifest.webmanifest
└── Service Worker

IndexedDB
├── cache
├── sync_queue
└── saved_advice

Cloudflare Worker + D1
└── 最终云端数据与跨设备同步
```

### 8.2 写入流程

```text
用户操作
  ↓
立即更新界面
  ↓
写入 IndexedDB
  ↓
加入 sync_queue
  ↓
网络恢复后重试 Worker
  ↓
Worker 写入 D1
  ↓
队列删除/标记完成
```

习惯打卡、Today、Pomodoro 和 RSS 收藏/已读均使用这一思路。请求有超时，网络不通时保留本地显示，不因一次 Worker 失败清空页面。

### 8.3 同步可靠性注意

Local-first 不是“只保存在浏览器”。IndexedDB 是断网时的即时层，D1 才是跨设备长期同步层。换设备前必须让待同步队列成功发送；如果 Worker 网络被阻断，页面会保留 pending 状态，恢复网络后自动重试。

## 9. 后端与数据架构

```text
server/src/_worker.ts          Worker fetch/scheduled 入口
server/src/server.ts           Elysia 应用与路由组合
server/src/services/
├── user.ts                    OAuth、访客登录、权限
├── feed.ts                    文章、草稿、标签
├── comments.ts                评论与通知
├── storage.ts                 R2/S3 图片
├── appearance.ts              外观偏好
├── habit.ts                   习惯与打卡
├── pomodoro.ts                专注 session
├── life.ts                    Overview/Calendar/Year/Today/Notes
└── rss.ts                     订阅、解析、刷新、阅读状态
server/src/db/schema.ts        Drizzle D1 schema
server/sql/                   单调递增 SQL migrations
```

主要数据表：

```text
users / feeds / hashtags / comments / visits
appearance_preferences
habits / habit_logs
life_daily_notes / daily_basics
pomodoro_sessions
rss_subscriptions / rss_source_groups / rss_items
info
```

迁移文件只追加、不修改已部署版本；当前新增的 Today 唯一约束迁移为 `0014-life-entry-integrity.sql`。

## 10. 部署链路

```text
GitHub main
├── Pages workflow
│   ├── 构建 Life Guide
│   ├── 构建 client/dist
│   └── 发布 GitHub Pages
│
└── Worker workflow
    ├── 生成 wrangler.toml
    ├── 创建/绑定 D1
    ├── 执行 SQL migrations
    ├── 上传 Secrets/Variables
    └── 发布 Cloudflare Worker
```

当前后端工作流已支持 `main` 上 server、迁移脚本或部署配置变动时自动触发；前端工作流随 main 推送触发。必要的 Cloudflare 账号令牌只存 GitHub Secrets，不进入代码或对话。

## 11. 当前已验证状态

- 前端 Vite production build 成功。
- Worker Wrangler dry-run 成功。
- GitHub Pages 部署成功。
- Cloudflare Worker、D1 migration 和 scheduled 配置部署成功。
- 线上静态 CSS 已确认包含 RSS 独立布局。
- 本地直连 Worker 可能因网络环境超时，这不等同于线上部署失败；应以 GitHub Actions 和浏览器实际访问结果为准。

## 12. 尚需外部条件的部分

以下不是前端代码缺陷，而是外部服务条件：

1. Bilibili、Pixiv、X 等 RSSHub 路由的稳定性取决于 RSSHub 实例、目标站点登录限制和 Cookie/代理配置。
2. 公共 RSSHub 的 403/人机验证不能由网站合法绕过，需要自建 RSSHub 并设置 `RSSHUB_BASE_URL`。
3. YouTube 官方 Feed 本身只提供有限的最新条目；想获得完整历史需要长期定时抓取、RSSHub 或 YouTube Data API。
4. 本地离线数据只有在同步队列成功后才会跨设备出现；应在设置或状态栏提示最后同步时间和 pending 数量。
5. 项目仍保留部分 Rin 的历史国际化/兼容代码，后续可在确认没有旧路由依赖后再做代码级清理。

## 13. 可复用的实施方法

给其他个人网站做类似改造时，建议按以下顺序：

1. 先保留原博客数据模型和公开 URL，建立新空间路由。
2. 先做服务端权限隔离，再做前端隐藏；不要只靠 CSS 隐藏私密入口。
3. 所有私人实体增加 owner_id，所有查询和写入都带 owner 条件。
4. 复杂模块先做稳定的数据 API，再做视觉重构。
5. 离线功能只建立一个共享 IndexedDB/sync queue，不要每个页面各写一套同步逻辑。
6. 对外部 Feed 做格式解析、超时、大小限制、重定向限制和失败可见性。
7. 外部服务失败时保留缓存内容，不要用空响应覆盖本地数据。
8. 数据库变更使用追加迁移，部署顺序固定为 Worker/迁移后 Pages。
9. 大媒体只保存 URL、缩略图和嵌入信息，避免把视频文件搬进自己的存储。
10. 每次上线至少验证：构建、迁移、公开页面、登录、私有页面、离线写入、恢复同步和旧链接跳转。

## 14. 后续优先级

```text
高：部署自建 RSSHub，设置 RSSHUB_BASE_URL，验证 Bilibili/Pixiv/X
高：RSS 状态栏显示最后同步时间、待同步数和失败来源
中：彻底移除不再使用的旧友链/多语言兼容代码
中：把 RSS 分组、收藏和订阅设置纳入更完整的跨设备同步
低：Guide 转 Habit 的确认式流程、更多 Life 聚合卡片
低：YouTube Data API 或更长历史抓取
```

总体上，这个项目已经从“Rin 博客换皮”变成了“Blog + Private Life + Local-first 阅读工作台”。最重要的架构边界是：公开内容继续简单稳定，私人数据始终按用户隔离，外部平台只做云端抓取，浏览器本地负责快速显示和暂存。
