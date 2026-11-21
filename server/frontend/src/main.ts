import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./style.css";

import {
  ApiError,
  apiJSON,
  listModels,
  sendChat,
  type ChatChunk,
  type ChatRequest,
  type Model,
} from "./api";
import { $, $$, esc } from "./dom";
import { icon } from "./icons";
import { createSettings } from "./settings";

const DEFAULT_PROMPT = "用一句话介绍你自己，并告诉我你能帮助我做什么。";
const DEFAULT_SYSTEM = "你是一位简洁、友好的助手。请使用中文回答。";

type View = "playground" | "settings";
type Tab = "response" | "request" | "raw";
type RequestState = "idle" | "running" | "success" | "cancelled" | "error";

const state = {
  view: (location.hash === "#settings" ? "settings" : "playground") as View,
  authenticated: false,
  sessionReady: false,
  sessionError: "",
  models: [] as Model[],
  modelLoading: false,
  modelError: "",
  search: "",
  freeOnly: true,
  selectedId: "",
  updatedAt: null as Date | null,
  prompt: DEFAULT_PROMPT,
  systemPrompt: DEFAULT_SYSTEM,
  maxTokens: 512,
  stream: true,
  mobilePanel: "models" as "models" | "request",
  tab: "response" as Tab,
  running: false,
  content: "",
  reasoning: "",
  chunks: [] as ChatChunk[],
  requestError: "",
  requestState: "idle" as RequestState,
  statusCode: null as number | null,
  elapsed: 0,
  firstToken: null as number | null,
  servedModel: "",
  finishReason: "",
  usage: undefined as ChatChunk["usage"],
  sentRequest: null as ChatRequest | null,
  copied: "",
};

let modelController: AbortController | null = null;
let chatController: AbortController | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let copyTimer: ReturnType<typeof setTimeout> | undefined;

const settingsView = createSettings({
  onAuthenticated() {
    state.authenticated = true;
    state.view = "settings";
    renderPage();
    void refreshModels();
  },
  onChanged() {
    void refreshModels();
  },
  onLogout() {
    state.authenticated = false;
    state.models = [];
    state.selectedId = "";
    state.view = "settings";
    location.hash = "settings";
    renderPage();
  },
});

function selected(): Model | undefined {
  return state.models.find((model) => model.id === state.selectedId);
}

function canSend(): boolean {
  return (
    state.authenticated &&
    Boolean(selected()) &&
    Boolean(state.prompt.trim()) &&
    !state.running &&
    Number.isInteger(Number(state.maxTokens)) &&
    Number(state.maxTokens) > 0
  );
}

function requestPayload(): ChatRequest {
  return {
    model: state.selectedId,
    messages: [
      ...(state.systemPrompt.trim()
        ? [{ role: "system" as const, content: state.systemPrompt }]
        : []),
      { role: "user", content: state.prompt },
    ],
    max_completion_tokens: Number(state.maxTokens),
    stream: state.stream,
  };
}

function requestJson(): string {
  return JSON.stringify(state.sentRequest ?? requestPayload(), null, 2);
}

function rawJson(): string {
  return state.chunks.map((chunk) => JSON.stringify(chunk, null, 2)).join("\n\n");
}

function provider(model: Model): string {
  if (model.owned_by) return model.owned_by;
  const value = model.provider;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "name" in value) return String(value.name);
  return "OpenCode";
}

function formatLimit(model: Model): string {
  const context = model.limit?.context ?? model.context_length;
  return typeof context === "number"
    ? `${new Intl.NumberFormat("zh-CN").format(context)} tokens`
    : "Chat Completions";
}

function shellHtml(): string {
  return `<div class="app-shell" id="shell">
  <aside class="sidebar" aria-label="工作台导航">
    <a class="brand" href="/" aria-label="OpenCode Relay 首页">
      <svg class="relay-mark" width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <path d="M4 8h9l4 6-4 6H4M15 8h9v12h-9M8 14h13" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      </svg>
      <span>OpenCode <span class="brand-light">Relay</span></span>
    </a>
    <nav class="side-nav" aria-label="主导航">
      <a href="#playground" data-nav="playground">${icon("terminal", 17)}请求测试</a>
      <a href="#settings" data-nav="settings">${icon("settings", 17)}设置</a>
    </nav>
    <div class="catalog-area" id="catalog-area">
      <div class="catalog-heading"><h2>模型列表</h2><span class="catalog-total" id="model-count">0</span></div>
      <div class="model-search">${icon("search", 15)}<input id="model-search" aria-label="搜索模型" placeholder="搜索模型…" /></div>
      <div class="catalog-tabs" aria-label="模型范围">
        <button data-action="free-only" data-free="true" class="active">免费 <span id="free-count">0</span></button>
        <button data-action="free-only" data-free="false">全部 <span id="all-count">0</span></button>
        <button class="icon-button refresh-button" data-action="refresh-models" aria-label="刷新模型列表" id="refresh-models">${icon("refresh", 14)}</button>
      </div>
      <div class="model-list" id="model-list" aria-busy="false"></div>
      <div class="catalog-footer">
        <span id="catalog-status"><span class="status-dot" id="catalog-dot"></span><span id="catalog-status-text">等待连接</span></span>
        <span id="catalog-time">—</span>
      </div>
    </div>
    <div class="sidebar-footer" id="settings-footer" hidden><span class="status-dot" id="settings-dot"></span><span id="settings-footer-text">等待登录</span><span>Chat Completions</span></div>
  </aside>

  <div class="workspace" id="workspace">
    <header class="topbar">
      <div class="breadcrumbs">
        <button class="mobile-back icon-button" data-action="mobile-back" aria-label="返回模型列表">${icon("arrowRight", 17)}</button>
        <span>工作台</span>${icon("chevronRight", 13)}<strong id="breadcrumb-current">请求测试</strong>
      </div>
      <a href="/docs" target="_blank" rel="noreferrer" class="docs-link">API 文档 ${icon("externalLink", 13)}</a>
    </header>
    <main class="sheet">
      <p class="settings-alert error" id="session-error" role="alert" hidden></p>
      <p class="settings-loading" id="session-loading">${icon("loader", 16, "spinning")}正在连接工作台…</p>
      <section id="settings-page" hidden></section>
      <section id="playground-page" hidden>
        <div class="page-heading">
          <div><h1>请求测试</h1><p>选择一个模型，发送 Chat 请求。</p></div>
          <button class="button" data-action="go-settings">${icon("settings", 14)}设置</button>
        </div>
        <p class="free-notice">${icon("zap", 14)}<span>您如果只使用免费模型那么不用进行任何配置</span></p>
        <p class="settings-alert error" id="auth-alert" hidden>请先到设置页登录工作台。<button class="text-button" data-action="go-settings">前往设置</button></p>
        <div class="endpoint-strip"><span class="method">POST</span><code>/v1/chat/completions</code><span class="protocol-note">OpenAI Chat 兼容</span></div>
        <div class="playground-grid">
          <section class="request-panel" aria-labelledby="request-heading">
            <div class="section-heading"><h2 id="request-heading">请求设置</h2><span>Request</span></div>
            <div class="field">
              <label for="model-select">模型</label>
              <select id="model-select"></select>
              <div class="field-caption"><span id="model-caption">从左侧列表选择模型</span><span class="free-label" id="free-label" hidden>免费模型</span></div>
            </div>
            <div class="field"><label for="system-prompt">系统提示词 <span>可选</span></label><textarea id="system-prompt" rows="3" placeholder="设置助手的角色和回答风格…"></textarea></div>
            <div class="field">
              <div class="label-row"><label for="user-prompt">用户消息</label><button class="text-button" data-action="example">${icon("zap", 12)}填入示例</button></div>
              <textarea id="user-prompt" class="user-message" rows="6" placeholder="你想问模型什么？"></textarea>
            </div>
            <div class="parameter-row">
              <div class="token-field"><label for="max-tokens">最大输出 tokens</label><input id="max-tokens" type="number" min="1" step="1" /></div>
              <div class="stream-field"><label for="stream-toggle">流式输出</label>
                <div class="toggle-row"><button id="stream-toggle" type="button" class="toggle enabled" role="switch" aria-checked="true"><span></span></button><span id="stream-label">开启 SSE</span></div>
              </div>
            </div>
            <div class="send-row" id="send-row"></div>
            <p class="billing-note" id="billing-note" hidden>所选模型按量计费，需要上游账户具备相应权限。</p>
          </section>

          <section class="response-panel" aria-label="请求和响应">
            <div class="response-tabs" role="tablist" aria-label="响应视图">
              <button role="tab" data-action="tab" data-tab="response" class="active">响应结果</button>
              <button role="tab" data-action="tab" data-tab="request">请求 JSON</button>
              <button role="tab" data-action="tab" data-tab="raw">原始响应</button>
              <button class="icon-button copy-button" data-action="copy" aria-label="复制当前内容">${icon("clipboard", 14)}</button>
            </div>
            <div class="response-status" id="response-status"></div>
            <div class="response-content" id="response-content" role="tabpanel"></div>
            <div class="response-footer" id="response-footer"></div>
          </section>
        </div>
        <footer class="page-footer"><span>${icon("code2", 13)}Chat Completions</span><span>OpenCode Relay <span class="footer-divider">/</span> <span id="mode-label">SSE streaming</span></span></footer>
      </section>
    </main>
  </div>
  <div class="mobile-start" id="mobile-start" hidden><button class="button primary" data-action="mobile-request">开始请求 ${icon("arrowRight", 16)}</button></div>
</div>
<div class="copy-toast" id="copy-toast" role="status" hidden></div>`;
}

function showToast(message: string): void {
  const toast = $("#copy-toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    toast.hidden = true;
  }, 1800);
}

async function copy(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    state.copied = label;
    showToast(label);
  } catch {
    showToast("复制失败");
  }
}

function renderChrome(): void {
  const shell = $("#shell");
  shell.classList.toggle("settings-mode", state.view === "settings");
  shell.classList.toggle("mobile-detail", state.mobilePanel === "request");
  $("#catalog-area").hidden = state.view !== "playground";
  $("#catalog-area").classList.toggle(
    "mobile-hidden",
    state.view === "playground" && state.mobilePanel === "request",
  );
  $("#workspace").classList.toggle(
    "mobile-hidden",
    state.view === "playground" && state.mobilePanel === "models",
  );
  for (const link of $$<HTMLAnchorElement>("[data-nav]")) {
    const active = link.getAttribute("data-nav") === state.view;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  $("#breadcrumb-current").textContent = state.view === "settings" ? "设置" : "请求测试";
  $("#settings-footer").hidden = state.view !== "settings";
  $("#settings-footer-text").textContent = state.authenticated ? "工作台已连接" : "等待登录";
  $("#settings-dot").classList.toggle("offline", !state.authenticated);
  $("#mobile-start").hidden = !(
    state.view === "playground" && state.mobilePanel === "models"
  );
  $<HTMLButtonElement>("#mobile-start button").disabled = !selected();
}

function renderModels(): void {
  const query = state.search.trim().toLowerCase();
  const visible = state.models.filter(
    (model) =>
      (!state.freeOnly || model.is_free) &&
      `${model.id} ${model.name ?? ""} ${provider(model)}`.toLowerCase().includes(query),
  );
  const selectedId = state.selectedId;
  const list = $("#model-list");
  list.setAttribute("aria-busy", String(state.modelLoading));
  if (state.modelLoading && state.models.length === 0) {
    list.innerHTML = `<div class="model-skeleton"><span></span><span></span></div>`.repeat(6);
  } else if (state.modelError) {
    list.innerHTML = `<div class="catalog-error" role="alert"><p>${esc(state.modelError)}</p><button class="text-button" data-action="refresh-models">重新获取 ${icon("refresh", 13)}</button></div>`;
  } else if (visible.length === 0) {
    list.innerHTML = `<p class="empty-list">没有匹配的 Chat 模型。</p>`;
  } else {
    list.innerHTML = visible
      .map(
        (model) => `<button class="model-row${selectedId === model.id ? " selected" : ""}" data-action="choose-model" data-model-id="${esc(model.id)}" ${state.running ? "disabled" : ""} aria-pressed="${selectedId === model.id}">
          <span class="model-row-top"><span class="model-name" title="${esc(model.name ?? model.id)}">${esc(model.name || model.id)}</span>${selectedId === model.id ? icon("check", 14) : ""}</span>
          <span class="model-id" title="${esc(model.id)}">${esc(model.id)}</span>
          <span class="model-row-bottom"><span>${esc(provider(model))}</span><span>${model.is_free ? "免费" : "按量计费"}</span></span>
        </button>`,
      )
      .join("");
  }

  $("#model-count").textContent = String(state.models.length);
  $("#free-count").textContent = String(state.models.filter((model) => model.is_free).length);
  $("#all-count").textContent = String(state.models.length);
  for (const tab of $$<HTMLButtonElement>("[data-free]")) {
    tab.classList.toggle("active", tab.dataset.free === String(state.freeOnly));
  }
  const refresh = $<HTMLButtonElement>("#refresh-models");
  refresh.disabled = state.modelLoading;
  refresh.querySelector("svg")?.classList.toggle("spinning", state.modelLoading);

  $("#catalog-status-text").textContent = state.modelLoading
    ? "正在同步模型"
    : state.modelError
      ? "模型同步失败"
      : state.updatedAt
        ? "模型已同步"
        : "等待连接";
  $("#catalog-dot").classList.toggle("offline", Boolean(state.modelError));
  $("#catalog-time").textContent = state.updatedAt
    ? state.updatedAt.toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "—";
}

function renderRequestPanel(): void {
  const current = selected();
  const select = $<HTMLSelectElement>("#model-select");
  select.innerHTML = state.models.length
    ? state.models
        .map(
          (model) =>
            `<option value="${esc(model.id)}">${esc(model.id)}${model.is_free ? " · 免费" : ""}</option>`,
        )
        .join("")
    : `<option value="">等待模型列表…</option>`;
  select.value = state.selectedId;
  select.disabled = state.running || state.models.length === 0;

  $("#model-caption").textContent = current
    ? formatLimit(current)
    : "从左侧列表选择模型";
  $("#free-label").hidden = !current?.is_free;
  $("#billing-note").hidden = !current || current.is_free;

  const toggle = $<HTMLButtonElement>("#stream-toggle");
  toggle.classList.toggle("enabled", state.stream);
  toggle.setAttribute("aria-checked", String(state.stream));
  toggle.disabled = state.running;
  $("#stream-label").textContent = state.stream ? "开启 SSE" : "JSON 响应";
  $("#mode-label").textContent = state.stream ? "SSE streaming" : "JSON response";

  $("#send-row").innerHTML = state.running
    ? `<button class="button primary" data-action="stop">${icon("square", 13)}停止生成</button><span class="shortcut">Ctrl / ⌘ + Enter</span>`
    : `<button class="button primary" data-action="submit" ${canSend() ? "" : "disabled"}>${icon("send", 15)}发送请求${icon("cornerDownLeft", 13, "send-enter")}</button><span class="shortcut">Ctrl / ⌘ + Enter</span>`;

  $("#auth-alert").hidden = state.authenticated;
  $<HTMLTextAreaElement>("#system-prompt").disabled = state.running;
  $<HTMLTextAreaElement>("#user-prompt").disabled = state.running;
  $<HTMLInputElement>("#max-tokens").disabled = state.running;
}

function renderStatus(): void {
  const labels: Record<RequestState, string> = {
    idle: "等待请求",
    running: "正在生成",
    success: "请求完成",
    cancelled: "已停止",
    error: "请求失败",
  };
  const indicator = state.running
    ? icon("loader", 13, "spinning")
    : `<span class="status-dot"></span>`;
  $("#response-status").innerHTML = `<span class="request-state ${state.requestState}">${indicator}${labels[state.requestState]}</span>
    <div class="status-metrics">${state.statusCode ? `<span>HTTP ${state.statusCode}</span>` : ""}${state.requestState !== "idle" ? `<span class="num">${(state.elapsed / 1000).toFixed(2)} s</span>` : ""}</div>`;
}

function responsePaneHtml(): string {
  if (state.requestState === "idle") {
    return `<div class="response-empty">${icon("terminal", 26, "")}<h3>让一个想法，得到回应。</h3><p>在左侧选择模型并发送消息。<br/>模型的回答将在这里实时显示。</p><div class="empty-code"><span>messages</span>${icon("chevronRight", 12)}<span>completion</span></div></div>`;
  }
  let html = "";
  if (state.requestError) {
    html += `<div class="request-error" role="alert">${icon("x", 15)}<p>${esc(state.requestError)}</p></div>`;
  }
  if (state.reasoning) {
    html += `<details class="reasoning"><summary>思考过程 <span>${state.reasoning.length.toLocaleString()} 字符</span></summary><pre>${esc(state.reasoning)}</pre></details>`;
  }
  if (state.content) {
    html += `<div class="answer" aria-live="polite">${esc(state.content)}${state.running ? '<span class="typing-cursor"></span>' : ""}</div>`;
  } else if (state.running) {
    html += `<p class="waiting">${icon("loader", 15, "spinning")}${state.reasoning ? "模型正在思考…" : "等待模型响应…"}</p>`;
  } else if (state.requestState === "success") {
    html += `<p class="empty-response">模型未返回文本内容。请查看原始响应中的工具调用或完成原因。</p>`;
  } else if (state.requestState === "cancelled" && !state.reasoning) {
    html += `<p class="empty-response">请求已停止。你可以调整消息后重新发送。</p>`;
  }
  if (state.finishReason === "length") {
    html += `<div class="limit-notice">已达到输出上限，可增大最大输出 tokens 后重试。</div>`;
  }
  return html;
}

function renderResponse(): void {
  for (const tab of $$<HTMLButtonElement>("[data-tab]")) {
    tab.classList.toggle("active", tab.dataset.tab === state.tab);
    tab.setAttribute("aria-selected", String(tab.dataset.tab === state.tab));
  }
  renderStatus();
  const content = $("#response-content");
  if (state.tab === "request") {
    content.innerHTML = `<pre class="json-view">${esc(requestJson())}</pre>`;
  } else if (state.tab === "raw") {
    content.innerHTML = `<pre class="json-view">${esc(rawJson() || "// 发送请求后，原始 Chat 响应将显示在这里。")}</pre>`;
  } else {
    content.innerHTML = responsePaneHtml();
  }
  $("#response-footer").innerHTML = `<div><span>实际模型</span><code title="${esc(state.servedModel)}">${esc(state.servedModel || "—")}</code></div>
    <div><span>首个 token</span><strong class="num">${state.firstToken === null ? "—" : `${(state.firstToken / 1000).toFixed(2)} s`}</strong></div>
    <div><span>总 tokens</span><strong class="num">${state.usage?.total_tokens?.toLocaleString() ?? "—"}</strong></div>`;
}

function renderPage(): void {
  $("#session-loading").hidden = state.sessionReady;
  const error = $("#session-error");
  error.hidden = !state.sessionError;
  if (state.sessionError) {
    error.innerHTML = `${esc(state.sessionError)} <button class="text-button" data-action="reconnect">重新连接</button>`;
  }
  $("#playground-page").hidden = !(state.sessionReady && state.view === "playground");
  $("#settings-page").hidden = !(state.sessionReady && state.view === "settings");
  if (state.sessionReady && state.view === "settings") {
    settingsView.render($("#settings-page"), state.authenticated);
  }
  if (state.sessionReady && state.view === "playground") {
    renderModels();
    renderRequestPanel();
    renderResponse();
  }
  renderChrome();
}

function navigate(view: View): void {
  state.view = view;
  location.hash = view;
  renderPage();
}

async function refreshModels(): Promise<void> {
  if (!state.authenticated) return;
  modelController?.abort();
  const current = new AbortController();
  modelController = current;
  state.modelLoading = true;
  state.modelError = "";
  renderModels();
  renderRequestPanel();
  try {
    state.models = await listModels(current.signal);
    state.updatedAt = new Date();
    if (!state.models.some((model) => model.id === state.selectedId)) {
      state.selectedId =
        state.models.find((model) => model.is_free)?.id ?? state.models[0]?.id ?? "";
    }
  } catch (error) {
    if (!current.signal.aborted) {
      state.modelError = error instanceof Error ? error.message : "模型获取失败。";
      if (error instanceof ApiError && error.authRequired) lock();
    }
  } finally {
    if (modelController === current) state.modelLoading = false;
    renderModels();
    renderRequestPanel();
    renderChrome();
  }
}

function lock(): void {
  state.authenticated = false;
  state.models = [];
  state.selectedId = "";
  modelController?.abort();
  chatController?.abort();
  navigate("settings");
}

async function submit(): Promise<void> {
  if (!canSend()) return;
  state.content = "";
  state.reasoning = "";
  state.chunks = [];
  state.requestError = "";
  state.statusCode = null;
  state.elapsed = 0;
  state.firstToken = null;
  state.servedModel = "";
  state.finishReason = "";
  state.usage = undefined;
  state.sentRequest = structuredClone(requestPayload());
  state.tab = "response";
  state.running = true;
  state.requestState = "running";

  const current = new AbortController();
  chatController = current;
  const start = performance.now();
  timer = setInterval(() => {
    state.elapsed = performance.now() - start;
    renderStatus();
  }, 50);
  renderRequestPanel();
  renderResponse();

  try {
    await sendChat(
      state.sentRequest,
      current.signal,
      (chunk) => {
        state.chunks.push(chunk);
        if (chunk.model) state.servedModel = chunk.model;
        if (chunk.usage) state.usage = chunk.usage;
        const choice = chunk.choices?.find((item) => (item.index ?? 0) === 0);
        const delta = choice?.delta ?? choice?.message;
        if (
          state.sentRequest?.stream &&
          (delta?.content || delta?.reasoning_content || delta?.tool_calls)
        ) {
          state.firstToken ??= performance.now() - start;
        }
        state.content += delta?.content ?? "";
        state.reasoning += delta?.reasoning_content ?? "";
        if (choice?.finish_reason) state.finishReason = choice.finish_reason;
        renderResponse();
      },
      (response) => {
        state.statusCode = response.status;
        state.servedModel = response.headers.get("x-zen-model") ?? "";
      },
    );
    state.requestState = "success";
  } catch (error) {
    if (current.signal.aborted) {
      state.requestState = "cancelled";
    } else {
      state.requestState = "error";
      state.requestError = error instanceof Error ? error.message : "请求失败，请重试。";
      if (error instanceof ApiError && error.authRequired) lock();
    }
  } finally {
    state.elapsed = performance.now() - start;
    clearInterval(timer);
    state.running = false;
    chatController = null;
    renderRequestPanel();
    renderResponse();
  }
}

async function initialize(): Promise<void> {
  state.sessionError = "";
  state.sessionReady = false;
  renderPage();
  try {
    const session = await apiJSON<{ authenticated: boolean; api_key_created: boolean }>(
      "/api/session",
    );
    state.authenticated = session.authenticated;
    if (!session.authenticated && !session.api_key_created) {
      await apiJSON("/api/session", "POST", {});
      state.authenticated = true;
    }
    if (!state.authenticated) navigate("settings");
  } catch (error) {
    state.sessionError = error instanceof Error ? error.message : "无法连接服务。";
  } finally {
    state.sessionReady = true;
    renderPage();
  }
  if (state.authenticated) await refreshModels();
}

function bindEvents(): void {
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const nav = target.closest<HTMLAnchorElement>("[data-nav]");
    if (nav) {
      event.preventDefault();
      navigate(nav.dataset.nav === "settings" ? "settings" : "playground");
      return;
    }
    const element = target.closest<HTMLElement>("[data-action]");
    if (!element) return;
    switch (element.dataset.action) {
      case "choose-model":
        if (state.running) return;
        state.selectedId = element.dataset.modelId ?? "";
        state.mobilePanel = "request";
        renderModels();
        renderRequestPanel();
        renderChrome();
        break;
      case "free-only":
        state.freeOnly = element.dataset.free === "true";
        renderModels();
        break;
      case "refresh-models":
        void refreshModels();
        break;
      case "go-settings":
        navigate("settings");
        break;
      case "example":
        state.prompt =
          "请用三个要点解释什么是 REST API，每个要点不超过 30 字。";
        $<HTMLTextAreaElement>("#user-prompt").value = state.prompt;
        renderRequestPanel();
        break;
      case "toggle-stream":
        state.stream = !state.stream;
        renderRequestPanel();
        break;
      case "submit":
        void submit();
        break;
      case "stop":
        chatController?.abort();
        break;
      case "tab":
        state.tab = (element.dataset.tab as Tab) ?? "response";
        renderResponse();
        break;
      case "copy": {
        const text =
          state.tab === "request"
            ? requestJson()
            : state.tab === "raw"
              ? rawJson()
              : state.content;
        void copy(text, "已复制");
        break;
      }
      case "mobile-request":
        state.mobilePanel = "request";
        renderChrome();
        break;
      case "mobile-back":
        state.mobilePanel = "models";
        renderChrome();
        break;
      case "reconnect":
        void initialize();
        break;
    }
  });

  document.addEventListener("keydown", (event) => {
    if (
      state.view === "playground" &&
      (event.ctrlKey || event.metaKey) &&
      event.key === "Enter"
    ) {
      event.preventDefault();
      void submit();
    }
  });

  window.addEventListener("hashchange", () => {
    const view: View = location.hash === "#settings" ? "settings" : "playground";
    if (view !== state.view) {
      state.view = view;
      renderPage();
    }
  });

  $("#model-search").addEventListener("input", (event) => {
    state.search = (event.target as HTMLInputElement).value;
    renderModels();
  });
  $("#system-prompt").addEventListener("input", (event) => {
    state.systemPrompt = (event.target as HTMLTextAreaElement).value;
    renderRequestPanel();
  });
  $("#user-prompt").addEventListener("input", (event) => {
    state.prompt = (event.target as HTMLTextAreaElement).value;
    renderRequestPanel();
  });
  $("#max-tokens").addEventListener("input", (event) => {
    state.maxTokens = Number((event.target as HTMLInputElement).value);
    renderRequestPanel();
  });
  $("#model-select").addEventListener("change", (event) => {
    state.selectedId = (event.target as HTMLSelectElement).value;
    renderModels();
    renderRequestPanel();
    renderChrome();
  });
  $("#stream-toggle").addEventListener("click", () => {
    state.stream = !state.stream;
    renderRequestPanel();
  });
}

$("#app").innerHTML = shellHtml();
$<HTMLTextAreaElement>("#system-prompt").value = state.systemPrompt;
$<HTMLTextAreaElement>("#user-prompt").value = state.prompt;
$<HTMLInputElement>("#max-tokens").value = String(state.maxTokens);
bindEvents();
renderPage();
void initialize();

window.addEventListener("beforeunload", () => {
  modelController?.abort();
  chatController?.abort();
  clearInterval(timer);
  clearTimeout(copyTimer);
});
