/* AnyDoor account and API console. It intentionally uses the gateway's small JSON contract. */
const STORAGE_KEY = "anydoor-gateway-token";
const REMEMBER_KEY = "anydoor-gateway-remember";
const API_KEY = "anydoor-gateway-api-base";
const $ = (id) => document.getElementById(id);

const state = {
  mode: "login",
  token: "",
  user: null,
  remember: false,
  tokenRevealed: false,
  snippet: "curl",
  models: [],
  apiBase: "",
};

function storageGet(storage, key) {
  try { return storage.getItem(key) || ""; } catch { return ""; }
}
function storageSet(storage, key, value) {
  try { storage.setItem(key, value); } catch { /* private browsing can reject storage */ }
}
function storageRemove(storage, key) {
  try { storage.removeItem(key); } catch { /* ignore unavailable storage */ }
}
function loadToken() {
  return storageGet(sessionStorage, STORAGE_KEY) || storageGet(localStorage, STORAGE_KEY);
}
function saveToken(token, remember) {
  storageRemove(sessionStorage, STORAGE_KEY);
  storageRemove(localStorage, STORAGE_KEY);
  if (!token) return;
  storageSet(remember ? localStorage : sessionStorage, STORAGE_KEY, token);
  storageSet(localStorage, REMEMBER_KEY, remember ? "1" : "0");
}
function clearToken() {
  storageRemove(sessionStorage, STORAGE_KEY);
  storageRemove(localStorage, STORAGE_KEY);
}
function normalizeBase(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, window.location.href);
    if (!/^https?:$/.test(url.protocol)) return "";
    return url.href.replace(/\/$/, "");
  } catch { return ""; }
}
function defaultApiBase() {
  const queryBase = new URLSearchParams(window.location.search).get("api");
  if (queryBase) return normalizeBase(queryBase);
  // The public demo copy lives on GitHub Pages and talks to the CloudBase function.
  if (window.location.hostname.endsWith(".github.io")) {
    return "https://cris-d6gkkzled0d106625.service.tcloudbase.com/anydoorApi";
  }
  // A gateway-hosted page is always same-origin. Copies hosted elsewhere use
  // the ?api= override or the 连接设置 field; never guess a fixed port.
  return "";
}
function apiUrl(path) {
  return `${state.apiBase}${path}`;
}
function setConnection(kind, label) {
  $("connection-state").dataset.state = kind;
  $("connection-label").textContent = label;
}
function setMessage(id, message, success = false) {
  const node = $(id);
  node.textContent = message || "";
  node.classList.toggle("success", Boolean(success));
}
function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  if (label) button.dataset.idleLabel = label;
  const text = button.querySelector("#auth-submit-label");
  if (text) text.textContent = busy ? "处理中…" : (button.dataset.idleLabel || "提交");
}
async function readResponse(response) {
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text }; }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || payload?.error || `请求失败（${response.status}）`;
    const error = new Error(String(message));
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return { payload, response };
}
async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("accept", "application/json");
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (state.token && !headers.has("authorization")) headers.set("authorization", `Bearer ${state.token}`);
  const response = await fetch(apiUrl(path), { ...options, headers, cache: "no-store" });
  return readResponse(response);
}
function pickUser(payload) {
  return payload?.user || payload?.data?.user || (payload?.email ? payload : null);
}
function pickToken(payload) {
  return payload?.token || payload?.access_token || payload?.data?.token || payload?.data?.access_token || "";
}
function userLabel(user) {
  return String(user?.name || user?.email?.split("@")[0] || "开发者");
}
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\\"'\\\"'")}'`;
}
function selectedModel() {
  return state.models.find((model) => model.provider === $("provider-input").value) || state.models[0] || {};
}
function renderToken() {
  const token = state.token;
  $("token-value").textContent = state.tokenRevealed && token ? token : "••••••••••••••••";
  $("reveal-token-btn").textContent = state.tokenRevealed ? "◌" : "◉";
  $("reveal-token-btn").title = state.tokenRevealed ? "隐藏令牌" : "显示令牌";
  $("reveal-token-btn").setAttribute("aria-label", state.tokenRevealed ? "隐藏令牌" : "显示令牌");
  $("token-storage").textContent = state.remember ? "此设备（本地）" : "当前会话";
}
function renderUser() {
  $("user-name").textContent = userLabel(state.user);
  $("user-email").textContent = state.user?.email || "—";
}
function showWorkspace() {
  $("auth-view").hidden = true;
  $("workspace-view").hidden = false;
  $("logout-btn").hidden = false;
  renderUser();
  renderToken();
  renderSnippets();
  setConnection("online", "已连接");
}
function showAuth() {
  $("auth-view").hidden = false;
  $("workspace-view").hidden = true;
  $("logout-btn").hidden = true;
  setConnection("idle", "未连接");
}
function setMode(mode) {
  state.mode = mode === "register" ? "register" : "login";
  const register = state.mode === "register";
  $("name-field").hidden = !register;
  $("password-input").autocomplete = register ? "new-password" : "current-password";
  $("auth-submit-label").textContent = register ? "创建账号" : "登录";
  $("login-tab").classList.toggle("active", !register);
  $("register-tab").classList.toggle("active", register);
  $("login-tab").setAttribute("aria-selected", String(!register));
  $("register-tab").setAttribute("aria-selected", String(register));
  setMessage("auth-message", "");
}
function showNewToken(token) {
  $("new-token-value").textContent = token;
  $("new-token-banner").hidden = false;
  setMessage("new-token-message", "", false);
}
async function copyText(text, messageId, successMessage = "已复制") {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text; area.style.position = "fixed"; area.style.opacity = "0";
    document.body.append(area); area.select(); document.execCommand("copy"); area.remove();
  }
  if (messageId) setMessage(messageId, successMessage, true);
  showToast(successMessage);
  return true;
}
function snippetValues() {
  const base = state.apiBase || window.location.origin;
  const model = selectedModel().id || "your-model";
  const provider = $("provider-input").value;
  const providerHeader = provider ? `\n  -H 'x-provider: ${provider}'` : "";
  const prompt = $("prompt-input").value.trim() || "Hello from AnyDoor";
  const token = state.token || "YOUR_TOKEN";
  const promptJson = JSON.stringify(prompt);
  const bodyJson = JSON.stringify({ model, messages: [{ role: "user", content: prompt }] });
  return { base, model, provider, providerHeader, promptJson, bodyJson, token };
}
function renderSnippets() {
  const { base, model, provider, providerHeader, promptJson, bodyJson, token } = snippetValues();
  const snippets = {
    curl: [`curl ${base}/v1/chat/completions \\`, `  -H 'Authorization: Bearer ${token}' \\`, `  -H 'Content-Type: application/json'${providerHeader} \\`, `  -d ${shellQuote(bodyJson)}`].join("\n"),
    javascript: `const response = await fetch("${base}/v1/chat/completions", {\n  method: "POST",\n  headers: {\n    "Authorization": "Bearer ${token}",\n    "Content-Type": "application/json"${provider ? `,\n    "x-provider": "${provider}"` : ""}\n  },\n  body: JSON.stringify({\n    model: "${model}",\n    messages: [{ role: "user", content: ${promptJson} }]\n  })\n});\nconst data = await response.json();`,
    python: `import requests\n\nresponse = requests.post(\n    "${base}/v1/chat/completions",\n    headers={"Authorization": "Bearer ${token}"${provider ? `, "x-provider": "${provider}"` : ""}},\n    json={"model": "${model}", "messages": [{"role": "user", "content": ${promptJson}}]},\n)\nprint(response.json())`,
  };
  $("snippet-code").textContent = snippets[state.snippet] || snippets.curl;
  $("snippet-code").dataset.raw = snippets[state.snippet] || snippets.curl;
}
function configuredModelList(fallback) {
  const seenModels = new Set();
  const modelIds = [];
  for (const m of state.models) {
    if (!m || !m.id || m.enabled === false || m.configured === false || seenModels.has(m.id)) continue;
    seenModels.add(m.id);
    modelIds.push(m.id);
  }
  return modelIds.slice(0, 12).join(", ") || fallback;
}
function renderAiSetup() {
  const { base, model, token } = snippetValues();
  const node = $("ai-setup-code");
  if (!node) return;
  const prompt = `请帮我把 AnyDoor 接入 WorkBuddy，作为自定义模型（OpenAI 兼容 API 中转站）：\n\n- 接口地址 / Base URL：${base}/v1\n- API Key：${token}\n- 模型名：${model}\n\n请在 WorkBuddy 的设置里找到「自定义模型 / OpenAI 兼容 Provider / 模型服务」之类的入口，把上面的信息填进去；如果它的地址栏要求不带 /v1 的根地址，就填 ${base}。配置好后请发一句简单对话测试连通性。\n\n说明：可用模型：${configuredModelList(model)}，可按需添加多个模型条目。`;
  node.textContent = prompt;
  node.dataset.raw = prompt;
}
function renderModels(payload) {
  const models = Array.isArray(payload?.data) ? payload.data : [];
  state.models = models;
  const list = $("models-list");
  if (!models.length) {
    list.innerHTML = "<div class=\"empty-state\">暂时没有可用模型</div>";
  } else {
    list.innerHTML = models.map((model, index) => {
      const rank = index + 1;
      const disabled = model.enabled === false;
      const badge = disabled ? "已停用" : (model.configured === false ? "未配置" : "可用");
      const label = model.vendor || model.provider || "gateway";
      return `<div class="model-row"><span class="model-rank${rank <= 3 ? ` rank-${rank}` : ""}">${String(rank).padStart(2, "0")}</span><div class="model-info"><strong>${escapeHtml(model.id || "unknown")}</strong><small>${escapeHtml(label)}</small></div>${quota ? `<span class="model-quota">${escapeHtml(quota)}</span>` : ""}<span class="model-badge${info.cls ? ` ${info.cls}` : ""}">${info.text}</span></div>`;
    }).join("");
  }
  const usage = payload?.usage;
  $("models-usage").textContent = usage ? `今日 ${Number(usage.requests_today || 0)} 次请求 · ${Number(usage.tokens_today || 0).toLocaleString()} tokens` : "";
  const providerSelect = $("provider-input");
  const current = providerSelect.value;
  const providers = [];
  const seen = new Set();
  for (const model of models) {
    const provider = String(model.provider || "").trim();
    if (!provider || seen.has(provider) || model.enabled === false || model.configured === false) continue;
    seen.add(provider);
    providers.push({ provider, label: model.vendor || provider, model: model.id || "" });
  }
  providerSelect.innerHTML = `<option value="">自动选择</option>${providers.map((item) => `<option value="${escapeAttr(item.provider)}">${escapeHtml(item.label)} · ${escapeHtml(item.model)}</option>`).join("")}`;
  if (providers.some((item) => item.provider === current)) providerSelect.value = current;
  renderSnippets();
  renderAiSetup();
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
function escapeAttr(value) { return escapeHtml(value); }
function showToast(message) {
  const toast = $("toast"); toast.textContent = message; toast.hidden = false;
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { toast.hidden = true; }, 2400);
}
async function submitAuth(event) {
  event.preventDefault();
  const email = $("email-input").value.trim();
  const password = $("password-input").value;
  const name = $("name-input").value.trim();
  const remember = $("remember-input").checked;
  if (!email || !$("email-input").validity.valid) { setMessage("auth-message", "请输入有效邮箱"); $("email-input").focus(); return; }
  if (!password || password.length < 8) { setMessage("auth-message", "密码至少需要 8 位"); $("password-input").focus(); return; }
  const button = $("auth-submit"); setBusy(button, true, state.mode === "register" ? "创建账号" : "登录"); setMessage("auth-message", "");
  try {
    const body = state.mode === "register" ? { email, password, ...(name ? { name } : {}) } : { email, password };
    const { payload } = await request(state.mode === "register" ? "/auth/register" : "/auth/login", { method: "POST", body: JSON.stringify(body) });
    const token = pickToken(payload);
    if (!token) throw new Error("服务器没有返回令牌");
    state.token = token; state.remember = remember; state.user = pickUser(payload) || { email, name };
    saveToken(token, remember);
    showWorkspace();
    if (state.mode === "register") showNewToken(token);
    await Promise.all([loadModels(), checkHealth()]);
    $("password-input").value = "";
    showToast(state.mode === "register" ? "账号创建成功" : "登录成功");
  } catch (error) {
    setConnection("error", "连接失败");
    setMessage("auth-message", error.message || "请求失败");
  } finally { setBusy(button, false, state.mode === "register" ? "创建账号" : "登录"); }
}
async function restoreSession() {
  state.token = loadToken();
  state.remember = storageGet(localStorage, REMEMBER_KEY) === "1" && Boolean(storageGet(localStorage, STORAGE_KEY));
  if (!state.token) return showAuth();
  try {
    const { payload } = await request("/auth/me");
    state.user = pickUser(payload) || payload;
    showWorkspace();
    await Promise.all([loadModels(), checkHealth()]);
  } catch {
    clearToken(); state.token = ""; state.user = null; showAuth();
    setMessage("auth-message", "登录已失效，请重新登录");
  }
}
async function loadModels() {
  $("models-list").innerHTML = "<div class=\"loading-state\">正在读取模型…</div>";
  try {
    const { payload } = await request("/v1/models"); renderModels(payload);
  } catch (error) {
    $("models-list").innerHTML = `<div class="empty-state">模型读取失败：${escapeHtml(error.message)}</div>`;
  }
}
async function checkHealth() {
  $("endpoint-status").textContent = "检查中…"; setConnection("idle", "检查中…");
  try {
    const { payload } = await request("/health");
    $("endpoint-status").textContent = "正常"; $("endpoint-status").style.color = "#267d5d";
    $("health-detail").textContent = payload?.service ? `${payload.service} · ${payload.day || "在线"}` : "网关在线";
    setConnection("online", "已连接");
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      $("endpoint-status").textContent = "正常"; $("endpoint-status").style.color = "#267d5d";
      $("health-detail").textContent = "网关在线 · 请先注册或登录"; setConnection("online", "已连接");
    } else {
      $("endpoint-status").textContent = "不可用"; $("endpoint-status").style.color = "#a44848";
      $("health-detail").textContent = error.message || "无法连接网关"; setConnection("error", "连接失败");
    }
  }
}
async function sendTest() {
  const prompt = $("prompt-input").value.trim();
  if (!prompt) { $("prompt-input").focus(); $("test-status").textContent = "请输入一条消息"; return; }
  const button = $("send-test-btn"); button.disabled = true; $("test-status").textContent = "请求中…"; $("test-result-wrap").hidden = true;
  const provider = $("provider-input").value;
  try {
    const headers = provider ? { "x-provider": provider } : {};
    const { payload, response } = await request("/v1/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: selectedModel().id || "", messages: [{ role: "user", content: prompt }], max_tokens: 300 }) });
    const content = payload?.choices?.[0]?.message?.content;
    $("test-result").textContent = content || JSON.stringify(payload, null, 2);
    $("test-result-wrap").hidden = false; $("test-status").textContent = `${response.headers.get("x-gateway-provider") || provider || "gateway"} · 完成`;
  } catch (error) {
    $("test-result").textContent = error.message || "请求失败"; $("test-result-wrap").hidden = false; $("test-status").textContent = "请求失败";
  } finally { button.disabled = false; }
}
function logout() {
  clearToken(); state.token = ""; state.user = null; state.models = []; state.tokenRevealed = false; $("new-token-banner").hidden = true; showAuth(); setMode("login"); $("auth-form").reset(); showToast("已退出登录");
}

$("login-tab").addEventListener("click", () => setMode("login"));
$("register-tab").addEventListener("click", () => setMode("register"));
$("auth-form").addEventListener("submit", submitAuth);
$("password-toggle").addEventListener("click", () => { const input = $("password-input"); const visible = input.type === "text"; input.type = visible ? "password" : "text"; $("password-toggle").textContent = visible ? "◉" : "◌"; $("password-toggle").title = visible ? "显示密码" : "隐藏密码"; });
$("logout-btn").addEventListener("click", logout);
$("reveal-token-btn").addEventListener("click", () => { state.tokenRevealed = !state.tokenRevealed; renderToken(); });
$("copy-token-btn").addEventListener("click", () => copyText(state.token, "token-message", "令牌已复制"));
$("copy-new-token-btn").addEventListener("click", () => copyText($("new-token-value").textContent, "new-token-message", "令牌已复制"));
$("dismiss-token-btn").addEventListener("click", () => { $("new-token-banner").hidden = true; });
$("api-base-input").addEventListener("change", () => { const normalized = normalizeBase($("api-base-input").value); state.apiBase = normalized; $("api-base-input").value = normalized; storageSet(localStorage, API_KEY, normalized); renderSnippets(); renderAiSetup(); checkHealth(); });
$("check-health-btn").addEventListener("click", checkHealth);
$("refresh-all-btn").addEventListener("click", async () => { await Promise.all([checkHealth(), loadModels()]); showToast("状态已刷新"); });
$("refresh-models-btn").addEventListener("click", loadModels);
$("provider-input").addEventListener("change", () => { renderSnippets(); renderAiSetup(); });
$("prompt-input").addEventListener("input", renderSnippets);
document.querySelectorAll(".snippet-tab").forEach((tab) => tab.addEventListener("click", () => { state.snippet = tab.dataset.snippet; document.querySelectorAll(".snippet-tab").forEach((item) => { const active = item === tab; item.classList.toggle("active", active); item.setAttribute("aria-selected", String(active)); }); renderSnippets(); }));
$("copy-snippet-btn").addEventListener("click", () => copyText($("snippet-code").dataset.raw || $("snippet-code").textContent, null, "调用示例已复制"));
$("copy-ai-btn").addEventListener("click", () => copyText($("ai-setup-code").dataset.raw || $("ai-setup-code").textContent, null, "配置提示词已复制"));
$("send-test-btn").addEventListener("click", sendTest);
$("copy-result-btn").addEventListener("click", () => copyText($("test-result").textContent, null, "响应已复制"));

state.apiBase = normalizeBase(storageGet(localStorage, API_KEY)) || defaultApiBase();
$("api-base-input").value = state.apiBase || window.location.origin;
$("remember-input").checked = storageGet(localStorage, REMEMBER_KEY) === "1";
renderSnippets();
renderAiSetup();
restoreSession();
