# OpenCode Relay

基于 `opencode-bun-native-example` 独立创建的 **FastAPI + Bun + Vue 3** 项目。
前端提供实时模型列表与 Chat 请求测试，API 使用 OpenAI 兼容的 **Chat Completions** 协议。

```text
Vue 页面 / OpenAI 兼容客户端
          │ HTTP · /v1/models · /v1/chat/completions
          ▼
       FastAPI
          │ 管理 Bun 子进程 · stdin JSON / stdout 响应
          ▼
   Bun 原生 fetch
          │ 参考项目的身份请求头与请求体
          ▼
   OpenCode 上游接口
```

上游 HTTPS 请求由 Bun 发出。Python 负责 HTTP 接口、校验、可选鉴权、并发限制和子进程管理。
新项目已复制必要的原生模块，不依赖参考项目的绝对路径，原项目无需修改。

## 快速开始

### Docker 部署（推荐）

只需安装 Docker 和 Docker Compose，无需在宿主机安装 Python、Bun 或 Node.js。

```sh
git clone https://github.com/coferkim/Opencode-Relay.git
cd Opencode-Relay
docker compose up -d --build
```

> 您如果只使用免费模型那么不用进行任何配置

默认使用 `public` 上游 Key；无需创建 `.env` 即可启动。免费模型和可用额度以实际的上游返回为准。

- Web 页面：`http://127.0.0.1:8948`
- API 地址：`http://127.0.0.1:8949/v1`
- API 文档：`http://127.0.0.1:8949/docs`，也可从 Web 页右上角打开。

Web 使用非 root Nginx 提供 Vue 静态页面，并将 `/v1`、`/api` 和文档请求代理至 FastAPI；SSE 关闭代理缓冲。
API 容器包含 Python 和 Bun，每次上游请求仍由独立的 Bun 原生进程发起。两个容器均有健康检查。

```sh
docker compose logs -f       # 查看运行日志（不记录密钥和请求正文）
docker compose down          # 停止服务
docker compose up -d --build # 更新源码后重新构建并启动
```

默认仅绑定宿主机 `127.0.0.1`。需要局域网或远程访问时，在 `.env` 设置 `BIND_ADDRESS=0.0.0.0`，
同时设置 `RELAY_API_KEY`，通过 HTTPS 反向代理访问，并按需限制防火墙；不要裸露未鉴权的网关。
本仓库为私有仓库，克隆前需要使用有权限的 GitHub 账号登录。

### API Key 配置

点击页面右上角 **API Key 配置**：

- **OpenCode API Key**：用于需要权限或余额的上游模型；留空使用服务端配置，默认支持免费模型。
- **Relay API Key**：只有管理员在服务端设置了 `RELAY_API_KEY` 才需要填写，与上游 Key 无关。

页面填写的密钥仅保留在当前页面内存，不写入 localStorage、sessionStorage、URL 或镜像；刷新页面后清除。
上游 Key 通过 `X-OpenCode-API-Key` 请求头传给 FastAPI，再传给该请求专用的 Bun 子进程，
不会修改服务端默认值或影响其他用户。远程访问时务必使用 HTTPS。

需要持久配置服务端默认值时，复制 `.env.example` 为 `.env`，修改 `OPENCODE_API_KEY`；
Docker 使用 `docker compose up -d --force-recreate` 应用修改，本地开发则重启后端。
`.env` 已从 Git 和 Docker 构建上下文中排除，**不要提交真实密钥**。

### 本地开发

需要 **Bun 1.4.4+**、**Node.js 22.12+**、**Python 3.11+** 和 **uv**。项目验证使用 Python 3.13。

```powershell
cd Opencode-Relay
uv sync --python 3.13
bun install
bun run dev
```

- 前端：`http://127.0.0.1:8948`
- API：`http://127.0.0.1:8949/v1`
- Swagger：`http://127.0.0.1:8949/docs`

`bun run dev` 同时启动 FastAPI 和 Vite，按 Ctrl+C 关闭两个服务。
前端开发期间自动更新；修改 Python 文件后需要重启后端。
Windows 上避免使用 Uvicorn 的 `--reload` / 多 worker 默认事件循环配置：Bun 子进程需要支持 subprocess 的事件循环。

默认使用参考项目的 `public` 上游 Key，直接启动即可。需要自定义配置时：

```powershell
Copy-Item .env.example .env
```

## 构建并由 FastAPI 托管前端

```powershell
bun run build
bun run start
```

打开 `http://127.0.0.1:8949`。此方式由同一个 FastAPI 服务提供页面和 API；Docker 方式始终保留 Web 8948 / API 8949 两个入口。

## 页面功能

- 实时获取支持 Chat Completions 的模型；默认查看免费模型，可切换全部、搜索、刷新。
- 模型可选不代表该 Key 一定有额度；付费模型需要有效的上游 Key 和余额。
- 选择模型，编辑系统提示词和用户消息，设置最大输出 tokens。
- 流式 SSE 或非流式 JSON 请求；停止请求时取消关联的 Bun 子进程。
- 显示回答、可折叠思考过程、真实模型标识、首个 token 耗时、请求耗时及 tokens 用量。
- 查看并复制请求 JSON 和原始响应。每次发送为独立的示例请求，不保存聊天历史。
- 通过页面“API Key 配置”输入上游密钥和可选网关密钥；仅存于页面内存。

模型列表来自上游，不内置演示模型。免费标记根据上游价格字段判断，不推断账户余额或剩余额度。
未返回的统计数据显示为 `—`。

## API

### 获取模型

```text
GET /v1/models
GET /v1/models?free_only=true
```

返回 `{ "object": "list", "data": [...] }`。保留上游模型元数据，增加 `is_free` 字段。
仅返回支持 Chat Completions 的模型，排除图片/embedding 专用模型。

### Chat Completions

```powershell
$body = @{
  model = 'big-pickle' # 或从 /v1/models 实时获取的其他模型 id
  messages = @(@{ role = 'user'; content = '用一句话介绍你自己。' })
  max_completion_tokens = 128
  stream = $false
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Uri 'http://127.0.0.1:8949/v1/chat/completions' `
  -Method Post -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
```

OpenAI SDK 配置 `base_url="http://127.0.0.1:8949/v1"`；未启用网关鉴权时 API Key 可用任意非空值。
启用网关鉴权后使用 `RELAY_API_KEY`，不是上游 `OPENCODE_API_KEY`。
按请求指定上游 Key 时，添加 `X-OpenCode-API-Key` 请求头（SDK 可用 `default_headers`）；
该值仅覆盖本次请求，空值回退到服务端默认配置。

- `stream: true`：透传 Chat SSE chunks、usage 事件和 `[DONE]`。
- `stream: false` 或省略：Bun 消费上游 SSE，聚合为 `chat.completion` JSON；保留 finish reason、tool calls、reasoning 和 usage。
- 上游始终按参考项目要求发送流式请求，并补全环境 system 消息、`read` 工具定义、usage 开关及身份请求头。
- 接受 `max_tokens` 并转换为 `max_completion_tokens`，后者优先；其他 Chat 字段透传。
- 不执行上游返回的工具调用。模型返回 tool calls 时，客户端负责后续交互。
- 请求头之前的上游错误保留 HTTP 状态和 `Retry-After`；流开始后的网关错误使用 SSE error 对象报告。
- 不自动重试、换模型或轮换账户。

### 健康状态

`GET /api/health` 返回网关存活状态及是否启用鉴权，不发送上游请求。

## 环境变量

| 变量 | 默认值 / 用途 |
| --- | --- |
| `OPENCODE_API_KEY` | `public`，服务端默认上游 Key，可被页面的请求级 Key 覆盖 |
| `OPENCODE_BASE_URL` | `https://opencode.ai/inference/openai/v1` |
| `OPENCODE_MODELS_URL` | 自动推导：默认 `https://opencode.ai/inference/v1/models` |
| `OPENCODE_CLIENT` | `desktop` |
| `OPENCODE_VERSION` | `2.2.5`，沿用参考项目身份头版本 |
| `OPENCODE_TIMEOUT_SECONDS` | `120`，整个上游请求的超时 |
| `OPENCODE_MAX_CONCURRENT_REQUESTS` | `8`，同时运行的 Bun 请求数量 |
| `BUN_EXECUTABLE` | 自动查找 PATH 中的 Bun，也可指定绝对路径 |
| `RELAY_API_KEY` | 默认关闭；设置后要求 `/v1/*` 提供对应 Bearer token |
| `BIND_ADDRESS` | Docker 默认 `127.0.0.1`，控制宿主机端口绑定；远程访问可显式设为 `0.0.0.0` |

每次上游请求独立使用 Bun 子进程，响应结束、超时或客户端断开后回收。
并发超过配置值时等待可用位置。本地开发默认仅监听 `127.0.0.1`；容器内部监听 `0.0.0.0`，宿主机端口默认仍仅绑定本机。
网关不会打印 API Key 或请求消息。

## 项目结构

```text
backend/              FastAPI 接口、配置与 Bun 生命周期管理
bridge/worker.ts      stdin/stdout 桥接与 Bun 原生上游请求
bridge/aggregate.ts   Chat SSE → JSON 聚合
bridge/native/        从参考项目复制的请求规范化、身份、SSE 与类型
frontend/src/         Vue 3 + TypeScript 页面
scripts/dev.ts        一键开发启动器
tests/test_gateway.py FastAPI → Bun → 本地模拟上游集成测试
tests/bridge/         请求规范化、聚合与前端 SSE 解析测试
Dockerfile            API / Web 多阶段镜像构建
compose.yaml          一键启动 API 8949 与 Web 8948
docker/nginx.conf     Vue 静态页面、API / 文档与 SSE 代理
.github/workflows/    测试、前端构建和 Docker 启动健康检查
```

## 检查

```powershell
uv run pytest -q
uv run ruff check backend tests
bun run test:bridge
bun run check
bun run build
```

集成测试运行真实 Bun 子进程，请求本地模拟上游，不消耗真实模型额度。
GitHub Actions 另外构建并启动两个 Docker 容器，验证前端、直连 API、Web 反代 API 和 OpenAPI 文档。
生产页面采用 Framed sheet 浅色工作台样式（seed `1998996448`），蓝灰框架、IBM Plex 字体和 Chat 请求/响应双栏；手机分为模型选择与请求视图。
