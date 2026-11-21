# OpenCode Relay

**Bun 全栈**：单个 `Bun.serve` 进程同时提供原生前端页面与三套兼容接口 —— OpenAI Chat Completions、Anthropic Messages、OpenAI Responses。把 OpenCode 模型接入任何 OpenAI / Anthropic 客户端。

> 只使用免费模型时无需任何配置，启动即可用。

## 429 说明

上游的 `429 FreeUsageLimitError` 不只表示配额用尽——它同样是"这个请求不像官方客户端"的拒绝，两种情况的报文完全相同。本中继按 OpenCode 2.x CLI 的线缆形状整形请求：

| 维度 | 整形内容 |
| --- | --- |
| User-Agent | `opencode/latest/<version>/cli`（v2 形状，整串匹配） |
| 会话头 | `x-opencode-session` / `x-opencode-session-id` / `x-session-affinity` / `x-session-id` 四头同值 |
| 会话 ID | 慢钟铸造的 `ses_` 形状，内嵌可信的近期时间戳（哈希派生的 1970 日期会被 429） |
| 工具名 | 调用方工具统一改名为 `mcp_<sha256[:12]>`，描述中的空格替换为 NBSP，响应侧还原 |
| 工具集 | 追加官方 13 工具全集（chat 线带 `strict: false`） |
| 系统上下文 | 注入 `<env>` 环境块 + skills 列表；**不注入人设提示词**（见下） |
| 请求体 | 按客户端键序编码，补 `stream_options.include_usage` 与 `max_completion_tokens` |

关于系统提示词的实测结论（2026-11-21，同一会话/请求头/工具集，只改 system 消息）：

| system 消息 | 结果 |
| --- | --- |
| 完整官方 CLI 提示词 | 200 |
| 仅 `<env>` 环境块 | 200 |
| 普通文本（无 `<env>`） | 429 |
| 无 system 消息 | 429 |

闸门读取的是 `<env>` 块，不是人设。因此本中继只注入环境块，调用方自己的 system 提示词原样保留、紧随其后。触发闸门的整形仍会得到 429，这与真实配额耗尽的报文无法区分，属于上游策略。

## 界面

![模型列表与 Chat 请求测试](.github/images/playground.png)

<details>
<summary>API Key 配置</summary>

![API Key 配置面板](.github/images/api-key.png)

</details>

## Docker 部署

```sh
git clone https://github.com/coferkim/Opencode-Relay.git
cd Opencode-Relay
docker compose up -d --build
```

| 入口 | 地址 |
| --- | --- |
| Web / API | http://127.0.0.1:8948 |
| OpenAI Base URL | http://127.0.0.1:8948/v1 |
| Anthropic Base URL | http://127.0.0.1:8948 |
| API 文档 | http://127.0.0.1:8948/docs |

默认仅本机可访问。首次启动请先在设置页创建调用 Key，再开放远程访问（`.env` 设置 `BIND_ADDRESS=0.0.0.0` 并配置 HTTPS）。

## API Key

打开侧边栏 **设置**：

- **调用 API Key**：只能创建一条，完整值仅在创建/重置时提供，请立即复制；重置后旧 Key 和其他登录会话失效。
- **OpenCode API Key**：只在 Web 修改并保存在服务端，付费模型按需配置；「恢复免费模式」使用 `public`。

其他客户端和 Web 登录都使用**调用 Key**，不是 OpenCode Key。网页使用 HttpOnly 会话，无需每次粘贴密钥。
配置持久保存到 Docker 的 `relay-data` 卷，本地为 `data/`；不要删除数据卷或将其提交到 Git。
数据目录下是两个 JSON 分片，可直接查看和手工编辑：

- `config.json` — 调用 Key 的哈希与前缀、Key 时间戳、上游 Key。**只保存哈希，不保存明文 Key。**
- `sessions.json` — 浏览器会话（`token 哈希 → 过期时间`），登出或过期自动清理。

写入采用「临时文件 + 原子重命名」，崩溃不会截断分片；外部手工修改这两个文件会在下一次请求时自动生效。从旧版本升级时，已有的 `relay.sqlite3` 会在首次启动时自动导入并重命名为 `relay.sqlite3.migrated`，之后不再读取。

已有 `.env` 的 `RELAY_API_KEY` 仅在首次初始化时导入，之后以 Web 设置为准。

## API

所有接口使用 `Authorization: Bearer sk-relay-…`（设置页生成的调用 Key）。

### OpenAI Chat Completions

- `GET /v1/models` — 模型列表，支持 `?free_only=true`。
- `GET /v1/models/{model}` — 单个模型，未知模型返回 404。
- `POST /v1/chat/completions` — Chat 请求，`stream: true` 开启 SSE。

```sh
curl http://127.0.0.1:8948/v1/chat/completions \
  -H "Authorization: Bearer sk-relay-…" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL_ID","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

### Anthropic Messages

- `POST /v1/messages` — Messages 请求，支持 `stream: true`；`thinking` 请求映射为 reasoning，响应侧输出 `thinking` 块。
- `POST /v1/messages/count_tokens` — 输入 token 估算，返回 `{ "input_tokens": N }`。

```sh
curl http://127.0.0.1:8948/v1/messages \
  -H "Authorization: Bearer sk-relay-…" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL_ID","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'
```

Anthropic 客户端把 Base URL 设为 `http://127.0.0.1:8948` 即可（SDK 会拼上 `/v1/messages`）。

### OpenAI Responses

- `POST /v1/responses` — Responses 请求，`input` 支持字符串或 item 数组，`stream: true` 输出 `response.*` 事件流。
- `GET /v1/responses/{id}` — 本网关不持久化 response，按规范返回 404 `not_found`。

```sh
curl http://127.0.0.1:8948/v1/responses \
  -H "Authorization: Bearer sk-relay-…" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL_ID","input":"你好","stream":true}'
```

错误响应按各自协议的规范信封返回：OpenAI 系为 `{"error":{message,type,param,code}}`，Anthropic 为 `{"type":"error","error":{type,message}}`。外部调用必须提供有效 Key；不接受 `X-OpenCode-API-Key` 覆盖上游配置。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8948` | 监听端口 |
| `OPENCODE_API_KEY` | `public` | 上游 Key（免费模型保持 `public`） |
| `OPENCODE_BASE_URL` | `https://opencode.ai/inference/openai/v1` | 上游地址 |
| `OPENCODE_MODELS_URL` | — | 覆盖模型列表地址 |
| `OPENCODE_CLIENT` | `cli` | 上报的客户端名 |
| `OPENCODE_VERSION` | `2.1.1` | 上报的客户端版本 |
| `OPENCODE_TIMEOUT_SECONDS` | `120` | 上游超时 |
| `OPENCODE_MAX_CONCURRENT_REQUESTS` | `8` | 上游并发上限 |
| `RELAY_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `off` |
| `RELAY_API_KEY` | — | 首次初始化时导入的调用 Key |
| `RELAY_DATA_DIR` | `./data` | 数据目录 |
| `BIND_ADDRESS` | `127.0.0.1` | Docker 发布地址 |

## 本地运行

需要 Bun 1.4.4+：

```sh
bun install
bun run dev
```

`bun run dev` 使用 Bun 的 HTML imports 与热更新，页面和 API 都在 http://127.0.0.1:8948。

## 测试

```sh
bun test          # 101 项：网关、设置、协议、接口规范、HTTP 语义、翻译接口、存储分片
bunx tsc --noEmit
```

测试覆盖三套接口的规范符合性（响应 schema、SSE 事件序列、错误信封、鉴权、同源、并发、断连恢复）与请求整形（工具改名、环境块注入、会话 ID 形状）。
