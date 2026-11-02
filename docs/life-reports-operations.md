# Life 报表启用与恢复操作说明

本说明不执行生产迁移、恢复、密钥轮换或发送。功能分支的模拟/D1演练不代表真实提供商已验证。当前备份界面提供导出、加密和文件校验，未开放生产批量恢复接口；恢复演练在临时库进行。

## 启用边界

- 日报/周报统计、自动数字分析、邮件是三个独立同意，不因访问页面、配置Key或保存时间而自动开启。
- 数字分析只允许固定整数指标，沿用站点共享每月1000分预留上限与价格复核截止；日记/任务名称/正文/日期/邮箱/owner标识不提交DeepSeek。固定结果只生成一次，失败未知不退预留、不重发。
- 邮件必须先通过自己的收件箱验证，再明确启用；邮箱不是来自公开仓库或静态站点配置。受理不是送达，更不是本人已读；本站不跟踪已读。
- 工厂支持Resend的原始体HMAC回调和Brevo的Bearer header认证回调；配置本身不代替账户/发件人/收件人验证。Resend测试域不是长期正式通道。Brevo是否允许特定已验证发件人且是否替换发件域，取决于实际账户和提供商政策，未进行真实通道验收，不承诺个人邮箱可直接长期发信。用户仍需自行开通合法服务并验证发件人；不提取个人邮箱凭据、不自动注册/购买域名或服务。

## 后端配置（不在前端填写密钥）

| 配置 | 类型与用途 |
| --- | --- |
| `DEEPSEEK_API_KEY` | Worker Secret，用户报告已配置；存在不等于当前API有效 |
| `REPORT_OUTBOUND_PAUSED` | 普通变量，精确值`true`暂停新手动/自动AI与邮件提交；默认未开启此维护闸 |
| `REPORT_MAIL_ENABLED` | 普通变量，只有精确`true`且其余配置有效才允许发送；默认关闭 |
| `REPORT_MAIL_PROVIDER` | `resend`或`brevo`，必须与实际账户及回调协议一致 |
| `REPORT_MAIL_PROVIDER_ID` | 1–64位字母/数字/下划线/连字符的提供商账户版本标识；不填邮箱/用户ID |
| `REPORT_MAIL_FROM` | 已在提供商验证并获准发送的单个地址，不支持自定义显示名/抄送/列表 |
| `REPORT_MAIL_API_KEY` | 独立Worker Secret，不复用JWT、DeepSeek、RSS、S3或其他凭据 |
| `REPORT_MAIL_VAULT_KEY` | 独立随机32字节的base64 Worker Secret，用于owner绑定的AES-GCM地址及HMAC指纹；不复用业务/会话密钥 |
| `REPORT_MAIL_WEBHOOK_SECRET` | Resend为提供商颁发的独立Svix Secret；Brevo为独立随机32字节base64url Bearer token（43–128字符，不接受whsec_前缀），都不得复用其他密钥 |

Secret只能进入Cloudflare的Secret字段，不发聊天、不写Git/静态资源/日志。不要在本次功能上线中生成、读取或轮换现有生产Secret。初次邮件启用前，按独立配置流程完成合法通道与备份恢复准备。

Resend回调为后端`/life/reports/mail/webhook/resend`，POST原始体HMAC通过后才访问D1。Brevo为`/life/reports/mail/webhook/brevo`，配置transactional单事件JSON回调并设置auth.type=bearer、auth.token为独立Secret；不使用URL携带用户名/密码，不用批量数组模式。Bearer通过TLS认证调用方，不声称提供原始体签名；认证前不读body或D1。两种入口都不走前端代理，不能向另一提供商路径发送事件。全局暂停仍接收合法旧回调，以保存退信/投诉抑制。发件账户/提供商变更属于单独迁移：先暂停、对账、保留旧回调接收及抑制证明，再评审账户版本方案。当前单接收配置不能自动并行迁移旧新账户，不能直接换ID/Secret后把旧未知消息绑到新账户重发。

## 个人备份与操作账本

个人备份v1/v2保留原清单（v1允许历史可选标签选项）；v3增加报告/时间设置，v4增加当前owner的持久AI结果。AES-GCM外层v1/v2保持兼容。固定版本拒绝未知表，包括重算过checksum的伪造操作性表；新业务模块应增加显式格式版本。

下列内容不导入个人备份：地址密文、邮箱验证token/摘要、投递消息/事件、发送准入、全站AI消费预留、自动AI同意时刻、调度队列/游标、Secret。它们不能随个人数据回滚，不能借导入清空预算或重开同意。

隔离恢复必须满足：

1. 先校验口令、owner、清单、checksum、报告周期/摘要及AI结果归属，再开始同一事务；中途失败整批回滚，不能先清空目标库。
2. 当前目标日记、待办、其他owner记录保留。重复ID/周期先形成可审阅冲突清单，不直接覆盖或改用户ID。
3. 恢复报告时间可保留，但日/周自动、AI、邮件标记都恢复为关闭。待确认AI状态恢复为unknown，保留已验证结果。不得从备份伪造同意、邮箱验证、投递准入或重放pending任务。
4. 目标库已有的月消费、发送准入、unknown提交与退信/投诉抑制保持，不能用文件覆盖。重新允许自动功能必须产生新的同意时刻，过去任务不补发。
5. 操作证明/加密Key缺失时，不把原地址视为可验证/可发送。保持发送关闭，按新输入和新收件箱验证流程重建；旧unknown仍不可重发。

## 全库D1回滚或灾难恢复

全库Time Travel会同时回滚去重和预算，个人备份演练不能证明全库回滚安全。需要单独可审阅方案与恢复授权，不能在日常维护中自动执行。

1. **先在Worker设置`REPORT_OUTBOUND_PAUSED=true`并确认生效**。保留Key与合法回调配置，不通过更换会话或域名绕过维护。等待既有请求结束：已交给提供商的请求不可撤回；至少核对超过60秒的pending/提交中状态与供应商记录，不把超时当未发送。
2. 记录当前D1恢复书签，并独立保全当前操作账本和最新业务副本；它们包含私人元数据，不能写公开仓库/共享日志。Key由独立受控秘密管理保管；密文和密钥不能同库明文保存。没有Key副本不尝试绕过加密。
3. 优先在隔离库验证恢复点、所有权/关系/数量、摘要、回滚边界及失败回退，再批准生产动作。外发闸始终关闭，不能用真实邮件或收费AI来测试恢复。
4. 全库恢复后先合并恢复点之后已确认的AI预留、发送准入、消息结果与抑制证明；任何无法确认的提交保留unknown，不清表、不退款、不重新领取。只有旧快照且无法获得新账本时，不重开外发，先用供应商账单/事件对账，不能推断当前额度仍可用。
5. 业务副本验收不依赖外发，先只读核对报告、日记、待办、RSS阅读收藏、标签与离线数据；不得清空IndexedDB。恢复自动标记保持关闭，恢复后新同意不触发旧任务。
6. 只有数据验收、当前消费上限、去重证明、抑制与Key可用性均可证明，才评审取消维护闸。解除总闸不应代替用户的新同意/邮箱验证。

可在后台私密控制台只读核对未确认消息，切勿公开输出结果：

```sql
SELECT delivery_key, provider_identity, provider_id, state, message_sha256
FROM life_report_mail_deliveries
WHERE state IN ('submitting','unknown')
ORDER BY created_at
LIMIT 20;
```

提供商受理/送达事实需与固定delivery key、原提供商账户/消息ID绑定。现阶段支持认证回调对账；没有自动补发或管理员“重置为queued”按钮。无法证明未受理的消息不重试，未来扩展对账接口也须保留此边界。


Brevo发送API的尖括号Message-ID与回调的无括号形式归一化为同一标识；配置webhook的id不作为事件唯一键。只保留投递元数据摘要，收件地址/主题不落事件账本。认证后的合法延迟反馈可幂等应用；拒绝异常未来时间，忽略soft_bounce/deferred/open/click作为终态。既有complained抑制桶包括spam及unsubscribed，界面称收件人反馈（投诉或退订），不把退订说成垃圾邮件投诉。未知投递可由匹配准入/标签/提供商标识的认证回调对账恢复，不能重置发送claim或预算。

官方协议参考：[Brevo安全回调](https://developers.brevo.com/docs/secured-webhooks)、[事务事件](https://developers.brevo.com/docs/transactional-webhooks)、[发送接口](https://developers.brevo.com/reference/send-transac-email)。配置和模拟通过不证明账户权限、投递成功或当前免费政策。

## QQ个人邮箱 SMTP 通道

新增provider=qq-smtp，使用固定smtp.qq.com:465隐式TLS。独立授权码绑定为REPORT_QQ_SMTP_AUTH_CODE，唯一收件白名单为REPORT_MAIL_TO；配置值仅进Worker Secret，不写仓库或同库明文。无需第三方邮件API或回调Secret。报告地址仍须owner验证，代码不因配置自动开启用户计划。QQ SMTP接收后的250仅表示受理；没有已接入的送达/退信回调，不自动读取个人邮箱，未知结果不重发。收件邮箱或发件人改变会生成新的provider identity，旧queued不挪用。首次启用与无秘密操作步骤见life-reports-activation.md。

SMTP会话有独立12秒上限、外层15秒截止与abort关闭套接字、累计响应32KiB/单行512字节/每回复64行界限；只允许EHLO→AUTH LOGIN→单发件/单收件→DATA，最后250才记录受理。正文UTF-8 base64与安全折叠Subject防SMTP命令和邮件头注入，不输出原始服务端文本或凭据。此通道不能冒充支持Resend/Brevo反馈回调。
