# AnyDoor 云部署说明（腾讯云 CloudBase + GitHub Pages）

## 架构

- **后端（API 中转）**：腾讯云 CloudBase 云函数 `anydoorApi`（Node.js 20），
  代码在 `cloudbase/anydoorApi/`。账号数据存 CloudBase 文档数据库
  （`anydoor_users` / `anydoor_tokens` 两个集合，全部用文档 ID 读写）。
- **前端（控制台）**：`gateway/` 下的纯静态页面，发布在 GitHub Pages
  （`gh-pages` 分支根目录），打开即用：注册 → 自动发放 `gw_` 令牌 → 用令牌调中转接口。

## 线上地址

- 控制台（GitHub Pages）：`https://cochranek.github.io/anydoor/`
- API（CloudBase HTTP 访问）：`https://cris-d6gkkzled0d106625.service.tcloudbase.com/anydoorApi`
  - OpenAI 兼容端点：`/v1/chat/completions`、`/v1/models`
  - 账号端点：`/auth/register`、`/auth/login`、`/auth/me`
- 环境 ID：`cris-d6gkkzled0d106625`（ap-shanghai，与 CRIS 项目同一环境）

## 密钥与数据放在哪

- **你的上游 API Key**：只存在云函数目录里的 `cloudbase/anydoorApi/api.txt`
  （已被 `.gitignore` 排除，不会进 GitHub）。更新后重新部署函数即可生效。
- **管理员密钥 GATEWAY_KEY**：写在云函数环境变量里（见 `cloudbaserc.json`，
  同样不进 GitHub）。本地文件 `api.txt` 里也有同样一份，仅本地网关使用。
- **用户账号/密码/令牌**：存 CloudBase 数据库。密码用 scrypt 加盐哈希，
  令牌只存 sha256 哈希，数据库泄露也拿不到明文。

## 重新部署后端

```powershell
# 在仓库根目录（需要已登录腾讯云 tcb CLI）
Set-Location D:\2026\anydoor
powershell -File cloudbase\sync-gateway.ps1      # 把最新 gateway 代码同步进函数包
$null | tcb fn deploy anydoorApi --force          # 交互提示直接回车选默认
```

冒烟测试（注册→令牌→模型列表→对话，全部走线上）：

```powershell
node cloudbase/live-smoke.js
```

## 重新部署前端（GitHub Pages）

```powershell
Set-Location D:\2026\anydoor
git checkout gh-pages
# gh-pages 分支根目录只放三个静态文件（+ .nojekyll），从 main 的 gateway/ 复制：
git checkout main -- gateway
Copy-Item gateway\index.html, gateway\app.js, gateway\styles.css . 
git rm -r --cached gateway; Remove-Item -Recurse -Force gateway
git add -A; git commit -m "pages: sync console"; git push origin gh-pages
```

（如果只想快速同步，也可以直接在工作区改完后把三个文件复制到分支根目录提交。）

## 云函数环境变量

在 `cloudbaserc.json` 的 `functionConfig.envVariables` 中（已配置）：

- `GATEWAY_KEY`：管理员密钥（`x-gateway-key` 头或 `Authorization` 头可用）。
- `ALLOWED_ORIGINS`：允许跨域的前端地址，当前为 `https://cochranek.github.io`。
- `AUTH_REQUIRE_TOKEN=true`：所有数据接口必须带用户令牌或管理员密钥。
- `UPSTREAM_TIMEOUT_MS=25000`：上游超时。

## 本地跑（不依赖云）

```powershell
Set-Location D:\2026\anydoor
# 需要根目录有 api.txt（从 api.txt.example 复制后填 key）
node gateway/server.mjs   # 默认 127.0.0.1:8797，控制台同址
node gateway/test.mjs     # 离线自测（临时目录，不碰真实数据）
```

## 已知注意事项

- CloudBase 文档数据库：云函数内 `.where()` 查询会被安全规则拒绝，
  所以 auth-db.js 只用文档 ID（`doc(id).get()/set()`）读写，勿改成 where 查询。
- `freellm` 供应商指向本机 `127.0.0.1`，云端函数里保持 `enabled = false`。
- HTTP 访问路由由 `tcb fn deploy anydoorApi --force --path /anydoorApi` 创建；
  `*.ap-shanghai.app.tcloudbase.com` 系统域名不允许手动加路由。
