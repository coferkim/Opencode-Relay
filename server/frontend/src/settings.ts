import { ApiError, apiJSON, type RelaySettings } from "./api";
import { esc } from "./dom";
import { icon } from "./icons";

export interface SettingsCallbacks {
  onAuthenticated(): void;
  onChanged(): void;
  onLogout(): void;
}

export interface SettingsView {
  render(container: HTMLElement, authenticated: boolean): void;
}

export function createSettings(callbacks: SettingsCallbacks): SettingsView {
  let root: HTMLElement | null = null;
  let settings: RelaySettings | null = null;
  let lastAuth = false;
  let requested = false;
  let busy = "";
  let error = "";
  let notice = "";
  let newKey = "";
  let showNewKey = false;
  let copied = "";
  let confirmRotate = false;
  let confirmFree = false;
  let loginDraft = "";
  let upstreamDraft = "";
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let bound = false;

  const apiBase = `${window.location.origin}/v1`;
  const example = `curl ${apiBase}/chat/completions \\
  -H "Authorization: Bearer YOUR_RELAY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"MODEL_ID","messages":[{"role":"user","content":"你好"}],"stream":true}'`;

  function paint(): void {
    if (!root) return;
    root.innerHTML = viewHtml();
  }

  function viewHtml(): string {
    if (!lastAuth) {
      return `<div class="settings-content">
        <p class="settings-alert error" role="alert" ${error ? "" : "hidden"}>${esc(error)}</p>
        <section class="settings-card login-card" aria-labelledby="login-heading">
          <h2 id="login-heading">${icon("shieldCheck", 18)}解锁工作台</h2>
          <p>输入已创建的调用 API Key，登录后即可管理设置和测试请求。</p>
          <form data-form="login">
            <div class="field"><label for="login-key">调用 API Key</label>
              <input id="login-key" type="password" autocomplete="current-password" placeholder="sk-relay-…" required value="${esc(loginDraft)}" />
            </div>
            <button class="button primary" type="submit" ${busy ? "disabled" : ""}>
              ${busy ? icon("loader", 14, "spinning") : ""}登录
            </button>
          </form>
        </section>
      </div>`;
    }

    if (!settings) {
      return `<div class="settings-content">
        <p class="settings-alert error" role="alert" ${error ? "" : "hidden"}>${esc(error)}</p>
        ${busy ? `<p class="settings-loading">${icon("loader", 16, "spinning")}正在读取设置…</p>` : `<button class="button" data-action="load-settings">重新读取设置</button>`}
      </div>`;
    }

    const prefix = settings.api_key.prefix ?? "sk-relay-";
    const updated = settings.api_key.updated_at
      ? new Date(settings.api_key.updated_at * 1000).toLocaleString("zh-CN", { hour12: false })
      : "—";
    const keySection = settings.api_key.exists
      ? `<div class="key-record"><div><code>${esc(prefix)}••••••••</code><span>最近更新 ${esc(updated)}</span></div><span class="key-active"><span class="status-dot"></span>使用中</span></div>`
      : `<div class="key-empty"><span>尚未创建调用密钥</span><button class="button primary" data-action="create-key" ${busy ? "disabled" : ""}>${icon("keyRound", 14)}创建唯一 API Key</button></div>`;

    const issued = newKey
      ? `<div class="issued-key" role="status">
          <label for="issued-key">完整密钥仅显示这一次，请立即复制保存。</label>
          <div class="issued-key-row">
            <input id="issued-key" value="${esc(newKey)}" type="${showNewKey ? "text" : "password"}" readonly autocomplete="off" spellcheck="false" />
            <button class="icon-button reveal-key" data-action="toggle-reveal" aria-label="${showNewKey ? "隐藏完整调用密钥" : "显示完整调用密钥"}">${showNewKey ? icon("eyeOff", 16) : icon("eye", 16)}</button>
            <button class="button" data-action="copy-key" aria-label="复制调用 API Key">${copied === "key" ? icon("check", 14) + "已复制" : icon("clipboard", 14) + "复制"}</button>
          </div>
          <button class="text-button" data-action="hide-key">我已保存，隐藏密钥</button>
        </div>`
      : "";

    const rotate = settings.api_key.exists
      ? confirmRotate
        ? `<div class="key-reset"><p>重置后，旧密钥和其他浏览器会话立即失效。继续重置？</p><div><button class="button danger-button" data-action="confirm-rotate" ${busy ? "disabled" : ""}>确认重置密钥</button><button class="button" data-action="cancel-rotate" ${busy ? "disabled" : ""}>取消</button></div></div>`
        : `<div class="key-reset"><span>需要更换密钥时，重置现有这一条。</span><button class="text-button danger-text" data-action="rotate-key" ${busy ? "disabled" : ""}>${icon("refresh", 13)}重置密钥</button></div>`
      : "";

    const freeConfirm = confirmFree
      ? `<div class="free-confirm"><p>清除保存的上游密钥，恢复 public 免费模式？</p><button class="button" type="button" data-action="reset-free" ${busy ? "disabled" : ""}>确认恢复免费模式</button><button class="text-button" type="button" data-action="cancel-free">取消</button></div>`
      : "";

    return `<div class="page-heading">
        <div><h1>设置</h1><p>管理唯一的调用密钥和 OpenCode 上游连接。</p></div>
        ${settings.api_key.exists ? `<button class="button" data-action="logout" ${busy ? "disabled" : ""}>${icon("logOut", 14)}退出登录</button>` : ""}
      </div>
      <div class="settings-content">
        <p class="settings-alert error" role="alert" ${error ? "" : "hidden"}>${esc(error)}</p>
        <p class="settings-alert success" role="status" ${notice ? "" : "hidden"}>${icon("check", 15)}${esc(notice)}</p>

        <section class="settings-card" aria-labelledby="relay-key-heading">
          <div class="settings-card-heading"><h2 id="relay-key-heading">${icon("keyRound", 18)}调用 API Key</h2><span class="key-count">${settings.api_key.exists ? "1 / 1" : "0 / 1"}</span></div>
          <p>其他客户端使用这条密钥调用本服务。最多一条，也用于登录工作台。</p>
          ${keySection}
          ${issued}
          ${rotate}
        </section>

        <section class="settings-card" aria-labelledby="upstream-heading">
          <div class="settings-card-heading"><h2 id="upstream-heading">${icon("zap", 18)}OpenCode 上游</h2><span class="upstream-state">${settings.upstream.configured ? "已配置上游密钥" : "免费模式 · public"}</span></div>
          <p>您如果只使用免费模型那么不用进行任何配置</p>
          <form data-form="upstream">
            <div class="field"><label for="upstream-key">OpenCode API Key <span>仅服务端使用</span></label>
              <input id="upstream-key" type="password" placeholder="输入新的上游 Key，保存后立即生效" autocomplete="off" spellcheck="false" value="${esc(upstreamDraft)}" />
            </div>
            <div class="settings-form-footer"><span>保存后持久生效，上游密钥不会回传给客户端。</span><div>
              <button class="button" type="button" data-action="confirm-free" ${busy || !settings.upstream.configured ? "disabled" : ""}>恢复免费模式</button>
              <button class="button" type="submit" ${busy ? "disabled" : ""}>保存上游 Key</button>
            </div></div>
            ${freeConfirm}
          </form>
        </section>

        <section class="settings-card connection-card" aria-labelledby="connection-heading">
          <h2 id="connection-heading">接入其他客户端</h2>
          <dl class="connection-details">
            <div><dt>Base URL</dt><dd><code>${esc(apiBase)}</code><button class="icon-button" data-action="copy-base" aria-label="复制 Base URL">${copied === "base" ? icon("check", 14) : icon("clipboard", 14)}</button></dd></div>
            <div><dt>API Key</dt><dd>填写上方生成的调用 API Key</dd></div>
            <div><dt>协议</dt><dd>OpenAI Chat Completions</dd></div>
          </dl>
          <details class="connection-example"><summary>查看请求示例</summary><pre>${esc(example)}</pre></details>
        </section>
      </div>`;
  }

  function failed(reason: unknown): void {
    error = reason instanceof Error ? reason.message : "操作失败，请重试。";
    if (reason instanceof ApiError && reason.authRequired) {
      settings = null;
      newKey = "";
      upstreamDraft = "";
      callbacks.onLogout();
    }
  }

  async function load(): Promise<void> {
    busy = "load";
    error = "";
    notice = "";
    paint();
    try {
      settings = await apiJSON<RelaySettings>("/api/settings");
    } catch (reason) {
      requested = false;
      settings = null;
      failed(reason);
    } finally {
      busy = "";
      paint();
    }
  }

  async function login(): Promise<void> {
    if (!loginDraft.trim()) return;
    busy = "login";
    error = "";
    paint();
    try {
      await apiJSON("/api/session", "POST", { api_key: loginDraft });
      loginDraft = "";
      callbacks.onAuthenticated();
    } catch (reason) {
      failed(reason);
    } finally {
      busy = "";
      paint();
    }
  }

  async function issue(rotate: boolean): Promise<void> {
    busy = "key";
    error = "";
    notice = "";
    copied = "";
    try {
      const result = await apiJSON<{ api_key: string }>(
        `/api/settings/api-key${rotate ? "/rotate" : ""}`,
        "POST",
      );
      newKey = result.api_key;
      showNewKey = false;
      confirmRotate = false;
      settings = await apiJSON<RelaySettings>("/api/settings");
      notice = rotate ? "密钥已重置，旧密钥已失效。" : "调用 API Key 已创建。";
      callbacks.onChanged();
    } catch (reason) {
      failed(reason);
    } finally {
      busy = "";
      paint();
    }
  }

  async function saveUpstream(reset: boolean): Promise<void> {
    const value = reset ? "" : upstreamDraft;
    if (!reset && !value.trim()) return;
    busy = "upstream";
    error = "";
    notice = "";
    paint();
    try {
      settings = await apiJSON<RelaySettings>("/api/settings/upstream", "PUT", {
        api_key: value,
      });
      if (!reset) upstreamDraft = "";
      confirmFree = false;
      notice = reset ? "已恢复免费模式。" : "OpenCode API Key 已保存，新请求立即生效。";
      callbacks.onChanged();
    } catch (reason) {
      failed(reason);
    } finally {
      busy = "";
      paint();
    }
  }

  async function logout(): Promise<void> {
    busy = "logout";
    error = "";
    paint();
    try {
      await apiJSON("/api/session", "DELETE");
      settings = null;
      newKey = "";
      upstreamDraft = "";
      callbacks.onLogout();
    } catch (reason) {
      failed(reason);
    } finally {
      busy = "";
      paint();
    }
  }

  async function copy(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      copied = label;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copied = "";
        paint();
      }, 1800);
    } catch {
      error = "复制失败，请手动选择并复制。";
    }
    paint();
  }

  function bind(container: HTMLElement): void {
    if (bound) return;
    bound = true;
    container.addEventListener("input", (event) => {
      const target = event.target as HTMLInputElement;
      if (target.id === "login-key") loginDraft = target.value;
      if (target.id === "upstream-key") upstreamDraft = target.value;
    });
    container.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = (event.target as HTMLElement).closest<HTMLFormElement>("form");
      if (form?.dataset.form === "login") void login();
      if (form?.dataset.form === "upstream") void saveUpstream(false);
    });
    container.addEventListener("click", (event) => {
      const element = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
      switch (element?.dataset.action) {
        case "load-settings":
          requested = true;
          void load();
          break;
        case "create-key":
          void issue(false);
          break;
        case "rotate-key":
          confirmRotate = true;
          paint();
          break;
        case "confirm-rotate":
          void issue(true);
          break;
        case "cancel-rotate":
          confirmRotate = false;
          paint();
          break;
        case "toggle-reveal":
          showNewKey = !showNewKey;
          paint();
          break;
        case "copy-key":
          void copy(newKey, "key");
          break;
        case "hide-key":
          newKey = "";
          paint();
          break;
        case "confirm-free":
          confirmFree = true;
          paint();
          break;
        case "cancel-free":
          confirmFree = false;
          paint();
          break;
        case "reset-free":
          void saveUpstream(true);
          break;
        case "copy-base":
          void copy(apiBase, "base");
          break;
        case "logout":
          void logout();
          break;
      }
    });
  }

  return {
    render(container: HTMLElement, authenticated: boolean): void {
      root = container;
      if (authenticated !== lastAuth) {
        lastAuth = authenticated;
        settings = null;
        requested = false;
        busy = "";
        error = "";
        notice = "";
        newKey = "";
        showNewKey = false;
        copied = "";
        confirmRotate = false;
        confirmFree = false;
        loginDraft = "";
        upstreamDraft = "";
      }
      bind(container);
      if (authenticated && !settings && !requested && !busy) {
        requested = true;
        void load();
        return;
      }
      paint();
    },
  };
}
