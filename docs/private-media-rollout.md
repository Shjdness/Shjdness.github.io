# 私密图片发布与恢复

## 生产启用

1. 在 Cloudflare 准备专用 Standard R2 桶 `rin-private-media`。也可通过 GitHub 的 `PRIVATE_MEDIA_R2_BUCKET` 指定另一只已核验的专用桶。首次发布用空桶或已验收的恢复目标。将 `PRIVATE_MEDIA_WRITES_PAUSED` 留空或设为 `true`。Worker 每次发布前都会用现有发布权限只读核对专用桶、`r2.dev` 关闭和自定义域列表为空。
2. 首次迁移前自动记录 D1 Time Travel 书签。Worker CI 核对 0042 的触发器、0043 的修订列和 0044 的预算表。随后检查线上 `privateMediaV1=true`、`privateMediaAvailable=true`、`privateMediaWritesPaused=true`，并确认匿名私密图片请求返回 `401` 和 `private, no-store`。Pages 等到 Worker 接入专用桶后才发布。保持暂停并核对 Worker、Pages 和报告配置。
3. 确认绑定、迁移和前端均通过后，设置 `PRIVATE_MEDIA_WRITES_PAUSED=false`，重新运行 Worker deploy 工作流。核对新的能力响应及 CI。用户按需重新用原 GitHub 账号登录并在正常写作中使用私密上传。新私密图片功能需要绑定 GitHub 身份的会话，旧会话仍可使用原有功能。旧日记和草稿里的公开 URL 继续按原链接显示，旧对象迁移另有独立流程。

前端在缺少私有桶时会阻止私密上传，文字仍可保存，草稿可单独确认公开博客配图。为避免影响日记和备忘录插图，首次正式发布安排在专用桶就绪之后。已恢复图片的可读性依赖桶绑定，暂停时应保留绑定。

CI 通过 Wrangler 的 `keep_vars` 保留仪表盘维护的运行时变量。生成的配置管理写入开关与专用 R2 绑定。首次启用后保留当前桶名配置。

[Cloudflare R2 公开访问](https://developers.cloudflare.com/r2/buckets/public-buckets/) · [Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)

## 恢复和回退

1. 先将仓库变量 `PRIVATE_MEDIA_WRITES_PAUSED` 设为 `true` 并完成 Worker 部署。确认后端返回暂停状态，确认旧部署下已开始的写入已结束或完成对账。已接纳的请求可能晚于暂停提交。带图片的稿件新建、修改和删除暂停，既有图片读取及普通写作继续可用。若需取得整个 D1 的匹配快照，另行冻结可能影响该次快照的其他写入，并按 [报表运维](life-reports-operations.md) 处理邮件和 AI 账本。
2. 在独立的空白目标恢复。保护源 D1、旧 R2、密钥及既有账本。先复制对象并核对原所属账号、SHA-256、大小、类型和存储元数据，再恢复匹配的 D1。保留暂存对象，因为尚未同步的本机草稿也可能引用它。个人 JSON 包含正文及引用，图片文件另备份。
3. 临时以恢复目标的测试部署验收读权限、图片摘要、实际权限丢失后的拒绝、缺失图片提示及同日预算。预算无法保全时，在下一 UTC 日以前保持暂停。需要生产切换时使用已审阅的恢复路径和原快照对账。生产切换前保持两组资源可恢复。
4. 回退优先保留现有 Worker 路由与桶绑定并暂停写入。已出现生产私密图片引用后，早于私密媒体的版本无法预览这些图片。清理引用或对象会影响恢复，操作应留待独立评估。

本机验收已使用两个独立的合成 D1/R2 环境确认，写入暂停时既有图片可读，上传和稿件附件更改返回 503，预算及对象数量未改变。此验收覆盖私密媒体相关表和合成对象。全库 Time Travel、线上迁移与生产桶访问策略仍须依上面的步骤核验。
