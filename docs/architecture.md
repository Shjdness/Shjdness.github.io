# Shjdshy Site Architecture

本仓库是一个静态前端与无服务器 API 分离的个人 Blog / Life 系统。当前架构只保留实际运行能力；原始上游项目名只用于历史与 MIT 许可归属，不再作为产品命名。

## 产品边界

```text
Home                         /
├── Blog                     /blog
│   ├── Articles             /blog/articles
│   ├── Timeline             /blog/timeline
│   ├── Diary                /blog/diary
│   ├── Memo                 /blog/memos
│   ├── Drafts               /blog/drafts
│   ├── Gallery              /blog/gallery
│   ├── Writing              /blog/writing/:id?
│   └── Article              /blog/feed/:id 或 /blog/:alias
└── Life                     /life
    ├── Overview / Todos     /life、/life/todos
    ├── Habits               /life/habits
    ├── Calendar / Year      /life/calendar、/life/year
    ├── Pomodoro             /life/pomodoro
    └── RSS (YouTube only)   /life/rss
```

Blog、Life、RSS、Writing 的业务样式分别位于 `client/src/styles/`；`index.css` 只承载站点壳层与通用组件，`base.css` 只承载 Tailwind 基础工具。页面不得再新建全局样式入口。Life 页面入口只负责鉴权和路由，实际功能位于 `client/src/features/life/`。

## 前端分层

```text
client/src/
├── page/                    路由级页面
├── features/life/
│   ├── model.ts             类型、日期与 API 客户端
│   ├── sync.ts              离线写入映射与队列发送器
│   ├── layout.tsx           Life 壳层与同步状态
│   ├── overview.tsx         总览、待办、今日三件事
│   ├── habits.tsx           习惯与当天记录
│   ├── calendar.tsx         月历与年历
│   ├── pomodoro.tsx         番茄钟页面
│   └── rss.tsx              YouTube 阅读器
├── state/                   Profile、外观、全局番茄钟
├── data/local-first.ts      IndexedDB 缓存与统一同步队列
└── styles/                  Blog、Life、RSS、Writing 样式
```

Life 读取采用 Local-first：先展示 IndexedDB 缓存，再拉取 Worker/D1；本地修改立即写缓存与 `sync_queue`，联网后由统一发送器重试。不要在各页面另建独立离线队列。

## 后端分层

```text
server/src/
├── services/                HTTP 服务与业务模块
│   └── rss/
│       ├── youtube.ts       频道地址识别、Feed 解析
│       ├── sync.ts          入库、去重、刷新与错误记录
│       ├── websub.ts        WebSub 订阅握手
│       └── routes.ts        鉴权、验证与 HTTP 路由
├── db/schema.ts             Drizzle 数据模型
├── utils/                   权限、缓存、存储等共享策略
└── _worker.ts               Cloudflare Worker 与定时入口
```

RSS 仅支持 YouTube 官方 Atom Feed。WebSub 负责低延迟通知，定时刷新负责补偿；图片和视频本体不写入 D1。

## 权限边界

- 已发布 Blog 内容公开；草稿、日记和备忘录为私有内容。
- 私有文章仅所有者或管理员可读；写作者只能修改自己的内容。
- Life 仅 `owner` 与 `trusted` 可访问，所有 Life 数据按认证用户 ID 隔离。
- 关键权限判断集中于共享策略函数，并由测试覆盖，不在路由中复制条件表达式。

## 数据库与部署

`server/sql/` 是不可重写的迁移历史。即使某功能已退役，创建过相关表或做过清理的迁移仍用于从空库重建，因此不得作为废文件删除。

涉及 D1 结构变更时，先部署 Worker/迁移，再发布 Pages；纯前端变更只需 Pages。部署入口为：

- `.github/workflows/deploy.yaml`：Worker 与 D1
- `.github/workflows/pages.yaml`：测试、类型检查、前端构建与 Pages
- `.github/workflows/youtube-sync.yaml`：YouTube 补偿同步

## 数据与兼容边界

- `listed=0` 不等于可删除的旧数据：日记和备忘录依然使用该可见性字段，业务读取必须同时按 `kind` 分类。
- 旧 `unlisted` 列表路由已移除，这一代码变更不删除任何 D1 记录；日记、备忘录和草稿仍使用各自的显式路由。后端部署前会对生产 D1 做只读分类统计；发现非 `diary`/`memo` 的私有历史记录时立即中止部署。
- 线上 Worker 的现有 `workers.dev` 子域名是部署资源标识，为避免中断前端、WebSub 和同步任务，在完成 Cloudflare 资源迁移前保留。

## 依赖与文件治理

- 依赖必须由源码、构建配置或测试直接引用；仅因历史存在不构成保留理由。
- 跨 workspace 使用的包必须声明在真正的消费者中，不依赖 Bun 偶然的 hoist 结果。
- `server/sql/` 、许可证与历史设计报告属于可追溯资产，不按“当前无 import”删除。
- 删除文件前先用 `rg` 确认无 import、无路由、无构建入口，再通过类型检查、测试和生产构建验证。

## 可靠性基线

根目录测试覆盖番茄钟状态机、草稿/私有文章权限和同步队列。合并或部署前至少执行：

```bash
node node_modules/vitest/vitest.mjs run
bunx tsc --noEmit --project server/tsconfig.json
bun run b
```
