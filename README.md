# AnyDoor

这是一个零依赖的 Node.js API 中转 MVP，把多个 OpenAI-compatible 上游统一成一个端点：一把令牌，任意通行。现在已经包含“注册账号 → 自动发放 Bearer token → 调用 OpenAI-compatible API”的最小闭环，适合先上线小规模 beta，再逐步补齐计费和后台。

## 线上部署（不开电脑也能用）

- **控制台（GitHub Pages 静态托管）**：<https://cochranek.github.io/anydoor/> —— 打开即注册，注册成功自动发放 `gw_` 令牌。
- **API（腾讯云 CloudBase 云函数）**：`https://cris-d6gkkzled0d106625.service.tcloudbase.com/anydoorApi`，OpenAI 兼容（`/v1/chat/completions`、`/v1/models`），也提供 `/auth/register`、`/auth/login`、`/auth/me`。
- 账号/密码/令牌存 CloudBase 文档数据库（密码 scrypt 加盐哈希、令牌只存哈希）；上游 API Key 只存在云函数目录的 `api.txt`（不进 Git）。
- 部署、更新、密钥位置说明见 [cloudbase/DEPLOY.md](cloudbase/DEPLOY.md)。

## 已实现

- `GET /health`：存活检查。
- `GET /console/`：注册、登录、令牌复制、模型列表和测试调用控制台。
- `POST /auth/register`：用邮箱和密码注册，成功后立即返回一次明文 token。
- `POST /auth/login`：登录并轮换 token，旧 token 会失效。
- `GET /auth/me`：查看当前账号信息。
- `POST /auth/tokens`：用户轮换自己的 token；管理员 `GATEWAY_KEY` 可带 `{ "email": "..." }` 为指定账号补发 token。
- `GET /v1/models`：列出已配置的 provider 和当日用量摘要。
- `POST /v1/chat/completions`：通过 `x-provider` 选择上游；支持 Kimi、Qwen、FreeLLMAPI 及 `api.txt` 中配置的其他 OpenAI 兼容 provider。
- 账号密码使用 Node `scrypt` 哈希；持久化文件只保存密码哈希和 token 哈希，不保存明文 token。
- `GATEWAY_KEY` 是管理员/兼容入口；用户调用统一使用 `Authorization: Bearer gw_...`。
- 每 IP 每分钟限流、请求体大小限制、每日 token 上限、上游 60 秒超时。
- 不把上游密钥写入响应或日志；上游密钥只在服务端读取。
- provider 可写入仓库根目录 `api.txt` 的 `[provider.<name>]` 段；`API_CONFIG_FILE` 可指定其他路径，环境变量优先覆盖文件值。文件可以包含 `vendor`、`api_key`、`auth`（无鉴权上游用 `none`）、`base_url`、`model`、`models`、`enabled`、`min_output_tokens`、`config_url`、`docs_url` 等字段。
- 上游网络策略：除 FreeLLMAPI 的 `localhost`/`127.0.0.1`/`::1` 外，所有 provider 的 `base_url` 必须使用 HTTPS。
- `MOCK_UPSTREAM=true` 可在没有任何外部密钥时验收完整链路。

## 本地运行

```powershell
$env:MOCK_UPSTREAM='true'
$env:AUTH_REQUIRE_TOKEN='true'
node .\gateway\server.mjs
start http://127.0.0.1:8787/console/
node .\gateway\test.mjs
```

也可以直接用 API 注册（密码至少 8 位）：

```powershell
$account = Invoke-RestMethod http://127.0.0.1:8787/auth/register -Method Post -ContentType 'application/json' -Body '{"email":"you@example.com","password":"correct horse battery staple"}'
$account.token
```

调用模型时把返回的 token 放进请求头：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/v1/chat/completions -Method Post -Headers @{ Authorization = "Bearer $($account.token)" } -ContentType 'application/json' -Body '{"messages":[{"role":"user","content":"你好"}]}'
```

默认账号文件是 `gateway/data/users.json`，也可通过 `AUTH_STORE_PATH` 指定。请把该文件加入备份策略并限制文件权限；多进程/多副本部署前应迁移到 SQLite 或 Postgres。

### 公网上线最小配置

```text
HOST=0.0.0.0
GATEWAY_KEY=<一段新的随机管理员密钥>
AUTH_REQUIRE_TOKEN=true
ALLOWED_ORIGINS=https://你的控制台域名
AUTH_STORE_PATH=/var/lib/anydoor/users.json
```

前面放 HTTPS 反向代理，再把 `https://你的控制台域名/console/` 给用户。注册接口当前没有邮箱验证、验证码和支付额度，适合受控 beta；开放公网前至少增加反滥用策略和每用户预算。

接入真实 provider 时，可以把密钥注入当前进程环境，也可以放在 `api.txt` 的 provider 段。这里的 `QWEN_API_KEY` 就是阿里云百炼的 DashScope API Key；诊断脚本为便于对照官方文档使用同一凭据的别名 `DASHSCOPE_API_KEY`。不要把 `api.txt`、真实 `.env` 或密钥写进 Git、前端或报告。

两个导入脚本可以自动补全 `api.txt`：`node gateway/import-api-config.mjs` 从本机 FreeLLMAPI 加密库导出，`node gateway/import-omniroute.mjs` 从本机 OmniRoute 加密库导出（自动跳过重复的 key、非 OpenAI 兼容的网页抓取类 provider，并对每个候选 key 先做一次真实 `/models` 验证再写入；同厂商的第二把 key 会记为 `<provider>-b`）。两个脚本都不会改动 `api.txt` 里已有内容。

示例（值仅为占位符）：

```ini
[provider.kimi]
vendor=Moonshot Kimi
api_key=replace-me
base_url=https://api.moonshot.cn/v1
protocol=chat
model=moonshot-v1-8k

[provider.freellm]
vendor=FreeLLMAPI
api_key=replace-me
base_url=http://127.0.0.1:18080/v1
protocol=chat
model=gpt-4o-mini
```

### 阿里云凭据诊断

百炼兼容接口需要在 Model Studio 的“密钥管理”里创建/复制 `DASHSCOPE_API_KEY`（通常是 `sk-...`）。`LTAI...` 形态是阿里云 AccessKey ID，不能直接当作 Bearer API Key。当前刷新后的 Key 已通过官方 `/v1/models` 和 `qwen-plus` 真实 smoke test；可在换 Key 后运行：

```powershell
$env:DASHSCOPE_API_KEY = 'sk-...'
powershell -ExecutionPolicy Bypass -File .\gateway\diagnose-dashscope.ps1
```

脚本只调用官方 `/models` 读接口，不会创建资源或修改账号。若 AccessKey 已暴露，应在阿里云控制台轮换/禁用；不要把它转换或复制到浏览器端。

## 变现路径

1. 内部版：给脚本/测验/小说流水线统一调用，先按月节省人工时间。
2. 小团队版：增加团队 key、用量面板和预算告警，按席位或 token 包收费。
3. 垂直版：针对短视频机构、培训师或独立开发者，卖“工作流 + 模型额度 + 模板”而不是裸转发。

## 生产前必须补齐

- 持久化用量账本与幂等请求 ID；Redis 限流；HTTPS 和反向代理；用逗号分隔的 `ALLOWED_ORIGINS` 配置明确的 CORS 来源白名单（默认无凭据模式为 `*`），只有在受控代理后才启用 `TRUST_PROXY=true`。
- 上游条款、隐私/跨境传输、内容安全、退款和税务流程。
- 真实计费单价配置与成本/毛利告警；流式响应和重试策略。
- 管理员轮换密钥、撤销 key、审计日志脱敏和数据删除接口。
