<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  ArrowRight, Check, ChevronRight, Clipboard, Code2, CornerDownLeft,
  ExternalLink, LoaderCircle, RefreshCw, Search, Send, Settings, Square, Terminal,
  X, Zap,
} from "@lucide/vue";
import { ApiError, apiJSON, listModels, sendChat, type ChatChunk, type ChatRequest, type Model } from "./api";
import SettingsPage from "./SettingsPage.vue";

const models = ref<Model[]>([]);
const modelLoading = ref(false);
const modelError = ref("");
const search = ref("");
const freeOnly = ref(true);
const selectedId = ref("");
const updatedAt = ref<Date | null>(null);
const prompt = ref("用一句话介绍你自己，并告诉我你能帮助我做什么。");
const systemPrompt = ref("你是一位简洁、友好的助手。请使用中文回答。");
const maxTokens = ref(512);
const stream = ref(true);
const authenticated = ref(false);
const sessionReady = ref(false);
const sessionError = ref("");
const view = ref<"playground" | "settings">(location.hash === "#settings" ? "settings" : "playground");
const mobilePanel = ref<"models" | "request">("models");
const mobileScreen = ref(window.innerWidth <= 760);
const tab = ref<"response" | "request" | "raw">("response");
const running = ref(false);
const content = ref("");
const reasoning = ref("");
const chunks = ref<ChatChunk[]>([]);
const requestError = ref("");
const requestState = ref<"idle" | "running" | "success" | "cancelled" | "error">("idle");
const statusCode = ref<number | null>(null);
const elapsed = ref(0);
const firstToken = ref<number | null>(null);
const servedModel = ref("");
const finishReason = ref("");
const usage = ref<ChatChunk["usage"]>();
const sentRequest = ref<ChatRequest | null>(null);
const copied = ref("");
let controller: AbortController | null = null;
let modelController: AbortController | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let copyTimer: ReturnType<typeof setTimeout> | undefined;

const selected = computed(() => models.value.find((model) => model.id === selectedId.value));
const freeCount = computed(() => models.value.filter((model) => model.is_free).length);
const visibleModels = computed(() => {
  const query = search.value.trim().toLowerCase();
  return models.value.filter((model) => (!freeOnly.value || model.is_free)
    && `${model.id} ${model.name ?? ""} ${provider(model)}`.toLowerCase().includes(query));
});
const requestPayload = computed<ChatRequest>(() => ({
  model: selectedId.value,
  messages: [
    ...(systemPrompt.value.trim() ? [{ role: "system" as const, content: systemPrompt.value }] : []),
    { role: "user", content: prompt.value },
  ],
  max_completion_tokens: Number(maxTokens.value),
  stream: stream.value,
}));
const requestJSON = computed(() => JSON.stringify(sentRequest.value ?? requestPayload.value, null, 2));
const rawJSON = computed(() => chunks.value.map((chunk) => JSON.stringify(chunk, null, 2)).join("\n\n"));
const canSend = computed(() => authenticated.value && selected.value && prompt.value.trim() && !running.value
  && Number.isInteger(Number(maxTokens.value)) && Number(maxTokens.value) > 0);
const stateLabel = computed(() => ({
  idle: "等待请求", running: "正在生成", success: "请求完成", cancelled: "已停止", error: "请求失败",
})[requestState.value]);

function provider(model: Model): string {
  if (model.owned_by) return model.owned_by;
  const value = model.provider;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "name" in value) return String(value.name);
  return "OpenCode";
}

function formatLimit(model: Model): string {
  const context = model.limit?.context ?? model.context_length;
  return typeof context === "number" ? `${new Intl.NumberFormat("zh-CN").format(context)} tokens` : "Chat Completions";
}

async function refreshModels() {
  if (!authenticated.value) return;
  modelController?.abort();
  const current = new AbortController();
  modelController = current;
  modelLoading.value = true;
  modelError.value = "";
  try {
    models.value = await listModels(current.signal);
    updatedAt.value = new Date();
    if (!models.value.some((model) => model.id === selectedId.value)) {
      selectedId.value = models.value.find((model) => model.is_free)?.id ?? models.value[0]?.id ?? "";
    }
  } catch (error) {
    if (!current.signal.aborted) {
      modelError.value = error instanceof Error ? error.message : "模型获取失败。";
      if (error instanceof ApiError && error.authRequired) lock();
    }
  } finally {
    if (modelController === current) modelLoading.value = false;
  }
}

function choose(model: Model) {
  if (running.value) return;
  selectedId.value = model.id;
  mobilePanel.value = "request";
}

async function submit() {
  if (!canSend.value) return;
  content.value = ""; reasoning.value = ""; chunks.value = []; requestError.value = "";
  statusCode.value = null; elapsed.value = 0; firstToken.value = null;
  servedModel.value = ""; finishReason.value = ""; usage.value = undefined;
  sentRequest.value = structuredClone(requestPayload.value);
  tab.value = "response"; running.value = true; requestState.value = "running";
  const current = new AbortController();
  controller = current;
  const start = performance.now();
  timer = setInterval(() => { elapsed.value = performance.now() - start; }, 50);
  try {
    await sendChat(sentRequest.value, current.signal, (chunk) => {
      chunks.value.push(chunk);
      if (chunk.model) servedModel.value = chunk.model;
      if (chunk.usage) usage.value = chunk.usage;
      const choice = chunk.choices?.find((item) => (item.index ?? 0) === 0);
      const delta = choice?.delta ?? choice?.message;
      if (sentRequest.value?.stream && (delta?.content || delta?.reasoning_content || delta?.tool_calls)) {
        firstToken.value ??= performance.now() - start;
      }
      content.value += delta?.content ?? "";
      reasoning.value += delta?.reasoning_content ?? "";
      if (choice?.finish_reason) finishReason.value = choice.finish_reason;
    }, (response) => {
      statusCode.value = response.status;
      servedModel.value = response.headers.get("x-zen-model") ?? "";
    });
    requestState.value = "success";
  } catch (error) {
    if (current.signal.aborted) requestState.value = "cancelled";
    else {
      requestState.value = "error";
      requestError.value = error instanceof Error ? error.message : "请求失败，请重试。";
      if (error instanceof ApiError && error.authRequired) lock();
    }
  } finally {
    elapsed.value = performance.now() - start;
    clearInterval(timer);
    running.value = false;
    controller = null;
  }
}

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = label;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = ""; }, 1800);
  } catch { copied.value = "复制失败"; }
}

function example() {
  prompt.value = "请用三个要点解释什么是 REST API，每个要点不超过 30 字。";
}

function keyboard(event: KeyboardEvent) {
  if (view.value === "playground" && (event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void submit();
  }
}

function resize() { mobileScreen.value = window.innerWidth <= 760; }

function navigate(next: "playground" | "settings") {
  view.value = next;
  location.hash = next;
}

function hashChange() { view.value = location.hash === "#settings" ? "settings" : "playground"; }

function lock() {
  authenticated.value = false; models.value = []; selectedId.value = "";
  modelController?.abort(); controller?.abort();
  navigate("settings");
}

async function loggedIn() {
  authenticated.value = true;
  await refreshModels();
}

async function initialize() {
  sessionError.value = ""; sessionReady.value = false;
  try {
    const session = await apiJSON<{ authenticated: boolean; api_key_created: boolean }>("/api/session");
    authenticated.value = session.authenticated;
    if (!session.authenticated && !session.api_key_created) {
      await apiJSON("/api/session", "POST", {});
      authenticated.value = true;
    }
    if (!authenticated.value) navigate("settings");
  } catch (error) {
    sessionError.value = error instanceof Error ? error.message : "无法连接服务。";
  } finally { sessionReady.value = true; }
  if (authenticated.value) await refreshModels();
}

onMounted(async () => {
  window.addEventListener("keydown", keyboard);
  window.addEventListener("resize", resize);
  window.addEventListener("hashchange", hashChange);
  await initialize();
});
onUnmounted(() => {
  controller?.abort(); modelController?.abort(); clearInterval(timer); clearTimeout(copyTimer);
  window.removeEventListener("keydown", keyboard);
  window.removeEventListener("resize", resize);
  window.removeEventListener("hashchange", hashChange);
});
</script>

<template>
  <div class="app-shell" :class="{ 'settings-mode': view === 'settings', 'mobile-detail': mobilePanel === 'request' }">
    <aside class="sidebar" aria-label="工作台导航">
      <a class="brand" href="/" aria-label="OpenCode Relay 首页">
        <svg class="relay-mark" width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
          <path d="M4 8h9l4 6-4 6H4M15 8h9v12h-9M8 14h13" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
        </svg>
        <span>OpenCode <span class="brand-light">Relay</span></span>
      </a>
      <nav class="side-nav" aria-label="主导航">
        <a href="#playground" :class="{ active: view === 'playground' }" :aria-current="view === 'playground' ? 'page' : undefined" @click.prevent="navigate('playground')"><Terminal :size="17"/>请求测试</a>
        <a href="#settings" :class="{ active: view === 'settings' }" :aria-current="view === 'settings' ? 'page' : undefined" @click.prevent="navigate('settings')"><Settings :size="17"/>设置</a>
      </nav>
      <div v-show="view === 'playground'" class="catalog-area" :class="{ 'mobile-hidden': mobilePanel === 'request' }">
      <div class="catalog-heading"><component :is="mobileScreen && view === 'playground' && mobilePanel === 'models' ? 'h1' : 'h2'">模型列表</component><span class="catalog-total">{{ models.length }}</span></div>
      <div class="model-search"><Search :size="15" aria-hidden="true" /><input v-model="search" aria-label="搜索模型" placeholder="搜索模型…" /></div>
      <div class="catalog-tabs" aria-label="模型范围">
        <button :class="{ active: freeOnly }" @click="freeOnly = true">免费 <span>{{ freeCount }}</span></button>
        <button :class="{ active: !freeOnly }" @click="freeOnly = false">全部 <span>{{ models.length }}</span></button>
        <button class="icon-button refresh-button" :disabled="modelLoading" aria-label="刷新模型列表" @click="refreshModels"><RefreshCw :size="14" :class="{ spinning: modelLoading }" /></button>
      </div>
      <div class="model-list" :aria-busy="modelLoading">
        <div v-if="modelError" class="catalog-error" role="alert"><p>{{ modelError }}</p><button class="text-button" @click="refreshModels">重新获取 <RefreshCw :size="13" /></button></div>
        <template v-if="modelLoading && models.length === 0"><div v-for="n in 6" :key="n" class="model-skeleton"><span></span><span></span></div></template>
        <button v-for="model in visibleModels" :key="model.id" class="model-row" :class="{ selected: selectedId === model.id }" :disabled="running" :aria-pressed="selectedId === model.id" @click="choose(model)">
          <span class="model-row-top"><span class="model-name" :title="model.name ?? model.id">{{ model.name || model.id }}</span><Check v-if="selectedId === model.id" :size="14" /></span>
          <span class="model-id" :title="model.id">{{ model.id }}</span>
          <span class="model-row-bottom"><span>{{ provider(model) }}</span><span>{{ model.is_free ? '免费' : '按量计费' }}</span></span>
        </button>
        <p v-if="!modelLoading && !modelError && visibleModels.length === 0" class="empty-list">没有匹配的 Chat 模型。</p>
      </div>
      <div class="catalog-footer">
        <span><span class="status-dot" :class="{ offline: modelError }"></span>{{ modelLoading ? '正在同步模型' : modelError ? '模型同步失败' : updatedAt ? '模型已同步' : '等待连接' }}</span>
        <span>{{ updatedAt?.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) ?? '—' }}</span>
      </div>
      </div>
      <div v-if="view === 'settings'" class="sidebar-footer"><span class="status-dot" :class="{ offline: !authenticated }"></span>{{ authenticated ? '工作台已连接' : '等待登录' }}<span>Chat Completions</span></div>
    </aside>

    <div class="workspace" :class="{ 'mobile-hidden': view === 'playground' && mobilePanel === 'models' }">
      <header class="topbar"><div class="breadcrumbs"><button v-if="view === 'playground'" class="mobile-back icon-button" aria-label="返回模型列表" @click="mobilePanel = 'models'"><ArrowRight :size="17" /></button><span>工作台</span><ChevronRight :size="13"/><strong>{{ view === 'settings' ? '设置' : '请求测试' }}</strong></div><a href="/docs" target="_blank" rel="noreferrer" class="docs-link">API 文档 <ExternalLink :size="13"/></a></header>
      <main class="sheet">
        <p v-if="sessionError" class="settings-alert error" role="alert">{{ sessionError }}<button class="text-button" @click="initialize">重新连接</button></p>
        <p v-if="!sessionReady" class="settings-loading"><LoaderCircle :size="16" class="spinning"/>正在连接工作台…</p>
        <SettingsPage v-else-if="view === 'settings'" :authenticated="authenticated" @authenticated="loggedIn" @changed="refreshModels" @logout="lock"/>
        <template v-else>
        <div class="page-heading"><div><h1>请求测试</h1><p>选择一个模型，发送 Chat 请求。</p></div><button class="button" @click="navigate('settings')"><Settings :size="14"/>设置</button></div>
        <p class="free-notice"><Zap :size="14" aria-hidden="true"/><span>您如果只使用免费模型那么不用进行任何配置</span></p>
        <p v-if="!authenticated" class="settings-alert error">请先到设置页登录工作台。<button class="text-button" @click="navigate('settings')">前往设置</button></p>
        <div class="endpoint-strip"><span class="method">POST</span><code>/v1/chat/completions</code><span class="protocol-note">OpenAI Chat 兼容</span></div>

        <div class="playground-grid">
          <section class="request-panel" aria-labelledby="request-heading">
            <div class="section-heading"><h2 id="request-heading">请求设置</h2><span>Request</span></div>
            <div class="field"><label for="model-select">模型</label><select id="model-select" v-model="selectedId" :disabled="running || !models.length"><option v-if="!models.length" value="">等待模型列表…</option><option v-for="model in models" :key="model.id" :value="model.id">{{ model.id }}{{ model.is_free ? ' · 免费' : '' }}</option></select><div class="field-caption"><span>{{ selected ? formatLimit(selected) : '从左侧列表选择模型' }}</span><span v-if="selected?.is_free" class="free-label">免费模型</span></div></div>
            <div class="field"><label for="system-prompt">系统提示词 <span>可选</span></label><textarea id="system-prompt" v-model="systemPrompt" :disabled="running" rows="3" placeholder="设置助手的角色和回答风格…"></textarea></div>
            <div class="field"><div class="label-row"><label for="user-prompt">用户消息</label><button class="text-button" :disabled="running" @click="example"><Zap :size="12"/>填入示例</button></div><textarea id="user-prompt" v-model="prompt" :disabled="running" class="user-message" rows="6" placeholder="你想问模型什么？"></textarea></div>
            <div class="parameter-row"><div class="token-field"><label for="max-tokens">最大输出 tokens</label><input id="max-tokens" v-model.number="maxTokens" type="number" min="1" step="1" :disabled="running" /></div><div class="stream-field"><label for="stream-toggle">流式输出</label><div class="toggle-row"><button id="stream-toggle" type="button" class="toggle" :class="{ enabled: stream }" role="switch" :aria-checked="stream" :disabled="running" @click="stream = !stream"><span></span></button><span>{{ stream ? '开启 SSE' : 'JSON 响应' }}</span></div></div></div>
            <div class="send-row"><button v-if="running" class="button primary" @click="controller?.abort()"><Square :size="13"/>停止生成</button><button v-else class="button primary" :disabled="!canSend" @click="submit"><Send :size="15"/>发送请求<CornerDownLeft :size="13" class="send-enter"/></button><span class="shortcut">Ctrl / ⌘ + Enter</span></div>
            <p class="billing-note" v-if="selected && !selected.is_free">所选模型按量计费，需要上游账户具备相应权限。</p>
          </section>

          <section class="response-panel" aria-label="请求和响应">
            <div class="response-tabs" role="tablist" aria-label="响应视图"><button role="tab" :aria-selected="tab === 'response'" :class="{ active: tab === 'response' }" @click="tab = 'response'">响应结果</button><button role="tab" :aria-selected="tab === 'request'" :class="{ active: tab === 'request' }" @click="tab = 'request'">请求 JSON</button><button role="tab" :aria-selected="tab === 'raw'" :class="{ active: tab === 'raw' }" @click="tab = 'raw'">原始响应</button><button class="icon-button copy-button" :aria-label="copied ? copied : '复制当前内容'" @click="copy(tab === 'request' ? requestJSON : tab === 'raw' ? rawJSON : content, '已复制')"><Check v-if="copied === '已复制'" :size="14"/><Clipboard v-else :size="14"/></button></div>
            <div class="response-status"><span class="request-state" :class="requestState"><LoaderCircle v-if="running" :size="13" class="spinning"/><span v-else class="status-dot"></span>{{ stateLabel }}</span><div class="status-metrics"><span v-if="statusCode">HTTP {{ statusCode }}</span><span v-if="requestState !== 'idle'" class="num">{{ (elapsed / 1000).toFixed(2) }} s</span></div></div>
            <div class="response-content" role="tabpanel" :aria-busy="running">
              <template v-if="tab === 'response'">
                <div v-if="requestState === 'idle'" class="response-empty"><Terminal :size="26" :stroke-width="1.3"/><h3>让一个想法，得到回应。</h3><p>在左侧选择模型并发送消息。<br/>模型的回答将在这里实时显示。</p><div class="empty-code"><span>messages</span><ChevronRight :size="12"/><span>completion</span></div></div>
                <div v-if="requestError" class="request-error" role="alert"><X :size="15"/><p>{{ requestError }}</p></div>
                <details v-if="reasoning" class="reasoning"><summary>思考过程 <span>{{ reasoning.length.toLocaleString() }} 字符</span></summary><pre>{{ reasoning }}</pre></details>
                <div v-if="content" class="answer" aria-live="polite">{{ content }}<span v-if="running" class="typing-cursor"></span></div>
                <p v-else-if="running" class="waiting"><LoaderCircle :size="15" class="spinning"/>{{ reasoning ? '模型正在思考…' : '等待模型响应…' }}</p>
                <p v-else-if="requestState === 'success'" class="empty-response">模型未返回文本内容。请查看原始响应中的工具调用或完成原因。</p>
                <p v-else-if="requestState === 'cancelled' && !reasoning" class="empty-response">请求已停止。你可以调整消息后重新发送。</p>
                <div v-if="finishReason === 'length'" class="limit-notice">已达到输出上限，可增大最大输出 tokens 后重试。</div>
              </template>
              <pre v-else class="json-view">{{ tab === 'request' ? requestJSON : (rawJSON || '// 发送请求后，原始 Chat 响应将显示在这里。') }}</pre>
            </div>
            <div class="response-footer"><div><span>实际模型</span><code :title="servedModel">{{ servedModel || '—' }}</code></div><div><span>首个 token</span><strong class="num">{{ firstToken === null ? '—' : `${(firstToken / 1000).toFixed(2)} s` }}</strong></div><div><span>总 tokens</span><strong class="num">{{ usage?.total_tokens?.toLocaleString() ?? '—' }}</strong></div></div>
          </section>
        </div>
        <footer class="page-footer"><span><Code2 :size="13"/>Chat Completions</span><span>OpenCode Relay <span class="footer-divider">/</span> {{ stream ? 'SSE streaming' : 'JSON response' }}</span></footer>
        </template>
      </main>
    </div>
    <div class="mobile-start" v-if="view === 'playground' && mobilePanel === 'models'"><button class="button primary" :disabled="!selected" @click="mobilePanel = 'request'">开始请求 <ArrowRight :size="16"/></button></div>
    <div v-if="copied" class="copy-toast" role="status">{{ copied }}</div>
  </div>
</template>
