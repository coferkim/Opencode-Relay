<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Check, Clipboard, Eye, EyeOff, KeyRound, LoaderCircle, LogOut, RefreshCw, ShieldCheck, Zap } from "@lucide/vue";
import { ApiError, apiJSON, type RelaySettings } from "./api";

const props = defineProps<{ authenticated: boolean }>();
const emit = defineEmits<{ authenticated: []; changed: []; logout: [] }>();
const settings = ref<RelaySettings | null>(null);
const loginKey = ref("");
const upstreamKey = ref("");
const newKey = ref("");
const showNewKey = ref(false);
const busy = ref("");
const error = ref("");
const notice = ref("");
const confirmRotate = ref(false);
const confirmFree = ref(false);
const copied = ref("");
const apiBase = computed(() => {
  const url = new URL(window.location.origin);
  if (url.port === "8948") url.port = "8949";
  return `${url.origin}/v1`;
});
const example = computed(() => `curl ${apiBase.value}/chat/completions \\\n  -H "Authorization: Bearer YOUR_RELAY_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"MODEL_ID","messages":[{"role":"user","content":"你好"}],"stream":true}'`);

function failed(reason: unknown) {
  error.value = reason instanceof Error ? reason.message : "操作失败，请重试。";
  if (reason instanceof ApiError && reason.authRequired) {
    settings.value = null; newKey.value = ""; upstreamKey.value = "";
    emit("logout");
  }
}

async function load() {
  busy.value = "load"; error.value = ""; notice.value = "";
  try { settings.value = await apiJSON<RelaySettings>("/api/settings"); }
  catch (reason) { failed(reason); }
  finally { busy.value = ""; }
}

async function login() {
  busy.value = "login"; error.value = "";
  try {
    await apiJSON("/api/session", "POST", { api_key: loginKey.value });
    loginKey.value = "";
    emit("authenticated");
  } catch (reason) { failed(reason); }
  finally { busy.value = ""; }
}

async function issue(rotate = false) {
  busy.value = "key"; error.value = ""; notice.value = ""; copied.value = "";
  try {
    const result = await apiJSON<{ api_key: string }>(`/api/settings/api-key${rotate ? "/rotate" : ""}`, "POST");
    newKey.value = result.api_key;
    showNewKey.value = false;
    confirmRotate.value = false;
    settings.value = await apiJSON<RelaySettings>("/api/settings");
    notice.value = rotate ? "密钥已重置，旧密钥已失效。" : "调用 API Key 已创建。";
    emit("changed");
  } catch (reason) { failed(reason); }
  finally { busy.value = ""; }
}

async function saveUpstream(reset = false) {
  busy.value = "upstream"; error.value = ""; notice.value = "";
  try {
    settings.value = await apiJSON<RelaySettings>("/api/settings/upstream", "PUT", { api_key: reset ? "" : upstreamKey.value });
    upstreamKey.value = "";
    confirmFree.value = false;
    notice.value = reset ? "已恢复免费模式。" : "OpenCode API Key 已保存，新请求立即生效。";
    emit("changed");
  } catch (reason) { failed(reason); }
  finally { busy.value = ""; }
}

async function logout() {
  busy.value = "logout"; error.value = "";
  try {
    await apiJSON("/api/session", "DELETE");
    newKey.value = ""; upstreamKey.value = ""; settings.value = null;
    emit("logout");
  } catch (reason) { failed(reason); }
  finally { busy.value = ""; }
}

async function copy(value: string, name: string) {
  try { await navigator.clipboard.writeText(value); copied.value = name; }
  catch { error.value = "复制失败，请手动选择并复制。"; }
}

watch(() => props.authenticated, (value) => {
  if (value) void load();
  else { settings.value = null; newKey.value = ""; upstreamKey.value = ""; }
});
onMounted(() => { if (props.authenticated) void load(); });
</script>

<template>
  <div class="page-heading"><div><h1>设置</h1><p>管理唯一的调用密钥和 OpenCode 上游连接。</p></div><button v-if="authenticated && settings?.api_key.exists" class="button" :disabled="Boolean(busy)" @click="logout"><LogOut :size="14"/>退出登录</button></div>
  <div class="settings-content">
    <p v-if="error" class="settings-alert error" role="alert">{{ error }}</p>
    <p v-if="notice && authenticated" class="settings-alert success" role="status"><Check :size="15"/>{{ notice }}</p>
    <section v-if="!authenticated" class="settings-card login-card" aria-labelledby="login-heading">
      <h2 id="login-heading"><ShieldCheck :size="18"/>解锁工作台</h2>
      <p>输入已创建的调用 API Key，登录后即可管理设置和测试请求。</p>
      <form @submit.prevent="login">
        <div class="field"><label for="login-key">调用 API Key</label><input id="login-key" v-model="loginKey" type="password" autocomplete="current-password" placeholder="sk-relay-…" required /></div>
        <button class="button primary" type="submit" :disabled="Boolean(busy) || !loginKey.trim()"><LoaderCircle v-if="busy" :size="14" class="spinning"/>登录</button>
      </form>
    </section>
    <p v-else-if="!settings && busy" class="settings-loading"><LoaderCircle :size="16" class="spinning"/>正在读取设置…</p>
    <button v-else-if="!settings" class="button" @click="load">重新读取设置</button>
    <template v-else>
      <section class="settings-card" aria-labelledby="relay-key-heading">
        <div class="settings-card-heading"><h2 id="relay-key-heading"><KeyRound :size="18"/>调用 API Key</h2><span class="key-count">{{ settings.api_key.exists ? '1 / 1' : '0 / 1' }}</span></div>
        <p>其他客户端使用这条密钥调用本服务。最多一条，也用于登录工作台。</p>
        <div v-if="!settings.api_key.exists" class="key-empty"><span>尚未创建调用密钥</span><button id="create-key" class="button primary" :disabled="Boolean(busy)" @click="issue()"><KeyRound :size="14"/>创建唯一 API Key</button></div>
        <div v-else class="key-record"><div><code>{{ settings.api_key.prefix }}••••••••</code><span>最近更新 {{ settings.api_key.updated_at ? new Date(settings.api_key.updated_at * 1000).toLocaleString('zh-CN', { hour12: false }) : '—' }}</span></div><span class="key-active"><span class="status-dot"></span>使用中</span></div>
        <div v-if="newKey" class="issued-key" role="status"><label for="issued-key">完整密钥仅显示这一次，请立即复制保存。</label><div class="issued-key-row"><input id="issued-key" :value="newKey" :type="showNewKey ? 'text' : 'password'" readonly autocomplete="off" spellcheck="false" /><button class="icon-button reveal-key" :aria-label="showNewKey ? '隐藏完整调用密钥' : '显示完整调用密钥'" @click="showNewKey = !showNewKey"><EyeOff v-if="showNewKey" :size="16"/><Eye v-else :size="16"/></button><button class="button" aria-label="复制调用 API Key" @click="copy(newKey, 'key')"><Check v-if="copied === 'key'" :size="14"/><Clipboard v-else :size="14"/>{{ copied === 'key' ? '已复制' : '复制' }}</button></div><button class="text-button" @click="newKey = ''">我已保存，隐藏密钥</button></div>
        <div v-if="settings.api_key.exists" class="key-reset">
          <template v-if="confirmRotate"><p>重置后，旧密钥和其他浏览器会话立即失效。继续重置？</p><div><button class="button danger-button" :disabled="Boolean(busy)" @click="issue(true)">确认重置密钥</button><button class="button" :disabled="Boolean(busy)" @click="confirmRotate = false">取消</button></div></template>
          <template v-else><span>需要更换密钥时，重置现有这一条。</span><button class="text-button danger-text" :disabled="Boolean(busy)" @click="confirmRotate = true"><RefreshCw :size="13"/>重置密钥</button></template>
        </div>
      </section>

      <section class="settings-card" aria-labelledby="upstream-heading">
        <div class="settings-card-heading"><h2 id="upstream-heading"><Zap :size="18"/>OpenCode 上游</h2><span class="upstream-state">{{ settings.upstream.configured ? '已配置上游密钥' : '免费模式 · public' }}</span></div>
        <p>您如果只使用免费模型那么不用进行任何配置</p>
        <form @submit.prevent="saveUpstream()">
          <div class="field"><label for="upstream-key">OpenCode API Key <span>仅服务端使用</span></label><input id="upstream-key" v-model="upstreamKey" type="password" placeholder="输入新的上游 Key，保存后立即生效" autocomplete="off" spellcheck="false" /></div>
          <div class="settings-form-footer"><span>保存后持久生效，上游密钥不会回传给客户端。</span><div><button class="button" type="button" :disabled="Boolean(busy) || !settings.upstream.configured" @click="confirmFree = !confirmFree">恢复免费模式</button><button class="button" type="submit" :disabled="Boolean(busy) || !upstreamKey.trim()">保存上游 Key</button></div></div>
          <div v-if="confirmFree" class="free-confirm"><p>清除保存的上游密钥，恢复 public 免费模式？</p><button class="button" type="button" :disabled="Boolean(busy)" @click="saveUpstream(true)">确认恢复免费模式</button><button class="text-button" type="button" @click="confirmFree = false">取消</button></div>
        </form>
      </section>

      <section class="settings-card connection-card" aria-labelledby="connection-heading">
        <h2 id="connection-heading">接入其他客户端</h2>
        <dl class="connection-details"><div><dt>Base URL</dt><dd><code>{{ apiBase }}</code><button class="icon-button" aria-label="复制 Base URL" @click="copy(apiBase, 'base')"><Check v-if="copied === 'base'" :size="14"/><Clipboard v-else :size="14"/></button></dd></div><div><dt>API Key</dt><dd>填写上方生成的调用 API Key</dd></div><div><dt>协议</dt><dd>OpenAI Chat Completions</dd></div></dl>
        <details class="connection-example"><summary>查看请求示例</summary><pre>{{ example }}</pre></details>
      </section>
    </template>
  </div>
</template>
