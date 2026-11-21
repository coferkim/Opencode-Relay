import type { Settings } from "./config";
import { RelayError } from "./errors";
import { log } from "./log";
import {
  buildChatBody,
  buildRequestHeaders,
  createIdentity,
  createIdentityFromSeed,
  ToolRenames,
} from "./protocol/request";
import type { ChatCompletionRequest } from "./protocol/types";

export interface ManagedResponse {
  response: Response;
  release: () => void;
  /** wire tool name -> caller tool name */
  toolNames: ToolRenames;
}

/** FIFO slot limiter; holds a slot for the lifetime of an upstream response. */
class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active += 1;
        resolve(this.releaser());
      };
      const onAbort = () => {
        const index = this.waiting.indexOf(wake);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(abortReason(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(wake);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiting.shift()?.();
    };
  }
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("Aborted", "AbortError");
}

/** Map transport failures; `null` means the client went away, so the status is irrelevant. */
export function toRelayError(error: unknown, clientSignal?: AbortSignal): RelayError | null {
  if (clientSignal?.aborted) return null;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new RelayError("上游请求超时。", 504, "upstream_timeout");
  }
  if (error instanceof TypeError) {
    return new RelayError("无法连接上游服务。", 502, "upstream_error");
  }
  return null;
}

export class Upstream {
  private readonly slots: Semaphore;

  constructor(private readonly settings: Settings) {
    this.slots = new Semaphore(settings.maxConcurrent);
  }

  private modelsUrl(): string {
    const base = this.settings.opencodeBaseUrl.replace(/\/+$/, "");
    const override = this.settings.opencodeModelsUrl?.trim();
    if (override) return override;
    return base.endsWith("/openai/v1")
      ? `${base.slice(0, -"/openai/v1".length)}/v1/models`
      : `${base}/models`;
  }

  private signal(clientSignal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(
      Math.max(1, Math.round(this.settings.timeoutSeconds * 1000)),
    );
    return clientSignal ? AbortSignal.any([clientSignal, timeout]) : timeout;
  }

  private async request(
    url: string,
    init: RequestInit,
    clientSignal?: AbortSignal,
  ): Promise<ManagedResponse> {
    const started = performance.now();
    const release = await this.slots.acquire(clientSignal);
    const waited = Math.round(performance.now() - started);
    if (waited > 50) log.debug("upstream.slot", { url, waited_ms: waited });
    try {
      const response = await fetch(url, { ...init, signal: this.signal(clientSignal) });
      log.debug("upstream.response", {
        method: init.method ?? "GET",
        url,
        status: response.status,
        ms: Math.round(performance.now() - started),
      });
      return { response, release, toolNames: new ToolRenames() };
    } catch (error) {
      release();
      const mapped = toRelayError(error, clientSignal);
      log.warn("upstream.transport", {
        url,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        ms: Math.round(performance.now() - started),
      });
      throw mapped ?? error;
    }
  }

  async openModels(apiKey: string, clientSignal?: AbortSignal): Promise<ManagedResponse> {
    return this.request(
      this.modelsUrl(),
      {
        method: "GET",
        headers: buildRequestHeaders({
          apiKey,
          identity: createIdentity({
            client: this.settings.opencodeClient,
            version: this.settings.opencodeVersion,
          }),
          accept: "application/json",
        }),
      },
      clientSignal,
    );
  }

  async openChat(
    request: ChatCompletionRequest,
    apiKey: string,
    identitySeed: string | null,
    clientSignal?: AbortSignal,
  ): Promise<ManagedResponse> {
    const identity = identitySeed
      ? createIdentityFromSeed(identitySeed, {
          client: this.settings.opencodeClient,
          version: this.settings.opencodeVersion,
        })
      : createIdentity({
          client: this.settings.opencodeClient,
          version: this.settings.opencodeVersion,
        });
    const built = buildChatBody(request);
    // The official 2.x client sends no explicit `accept` on chat requests; an
    // explicit value is one more byte that differs from the real client.
    const managed = await this.request(
      `${this.settings.opencodeBaseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: buildRequestHeaders({
          apiKey,
          identity,
          json: true,
        }),
        body: JSON.stringify(built.body),
      },
      clientSignal,
    );
    return { ...managed, toolNames: built.toolNames };
  }
}
