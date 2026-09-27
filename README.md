# Shjdshy · Blog & Life

这是 `shjdness.github.io` 的实际源码仓库。项目最初基于开源项目 Rin，现已演进为一个简体中文、静态优先的个人 Blog 与 Private Life 工作台。

## 当前结构

```text
Home
├── Blog
│   ├── 文章 / 时间轴 / 日记 / 标签 / 写作
│   └── Gallery
└── Life
    ├── 总览 / 习惯 / 日历 / 年历 / 番茄钟
    ├── RSS 桌面阅读器
    └── Guide / Saved Advice
```

## 技术边界

- `client/`：React + Vite 静态前端，发布到 GitHub Pages。
- `server/`：Cloudflare Worker API 与 D1 数据层。
- `server/sql/`：按顺序执行的 D1 数据库迁移。
- `scripts/`：部署、迁移及定时 RSSHub 同步脚本。
- `.github/workflows/`：前端、后端与 RSSHub 定时任务。
- `docs/`：当前架构、环境变量和设计记录。

Life 数据采用 Local-first：界面优先读取 IndexedDB，本地操作立即生效，再通过统一同步队列写入 Worker/D1。RSS 的 Bilibili 与 X 来源由 GitHub Actions 在新加坡时间 07:00、11:00、14:00、17:00 临时启动 RSSHub 抓取；任务结束即释放实例，不依赖公共 RSSHub 或长期服务器。YouTube 使用官方频道 Feed；Pixiv 接入已停用。

## 部署

- 前端：`.github/workflows/pages.yaml`
- Worker 与 D1：`.github/workflows/deploy.yaml`
- RSSHub 抓取：`.github/workflows/rss-sync.yaml`

部署所需变量见 [docs/ENV.md](docs/ENV.md)，系统设计见 [docs/architecture.md](docs/architecture.md)。密钥只保存在 GitHub Actions Secrets 与 Cloudflare Worker Secrets 中，不应提交到仓库。

## 本地验证

```bash
bun install --frozen-lockfile
bun run check
bun run b
```

## 许可与来源

项目保留 Rin 的 MIT 许可与版权声明，详见 [LICENSE](LICENSE)。当前站点的私人内容、图片与部署凭据不因开源许可而获得额外授权。
