# OpenCode Relay

**FastAPI + Bun + Vue 3**，将 OpenCode 模型接入 OpenAI 兼容的 Chat Completions 接口。

> 您如果只使用免费模型那么不用进行任何配置

## 功能

- 实时模型列表，支持免费筛选、搜索与刷新。
- Chat 协议，支持 SSE 流式与 JSON 响应。
- 模拟 OpenCode 客户端请求头、会话标识与请求格式，由 Bun 原生发送请求。
- 网页测试请求，查看回答、思考过程、耗时与 tokens 用量。
- 侧边栏分为「请求测试」和「设置」，Docker Compose 一键部署。
- 页面可配置自己的 API Key，默认免费模型无需配置。
- 仅允许一条调用 API Key；上游 OpenCode Key 单独保存，客户端无需填写。

**429 说明：** 已加入 OpenCode 客户端协议模拟，用于绕过上游 429 限制；实际效果仍取决于上游策略、账户额度与请求频率。

## 界面

![模型列表与 Chat 请求测试](docs/images/playground.png)

<details>
<summary>API Key 配置</summary>

![API Key 配置面板](docs/images/api-key.png)

</details>

## Docker 部署

```sh
git clone https://github.com/coferkim/Opencode-Relay.git
cd Opencode-Relay
docker compose up -d --build
```

| 入口 | 地址 |
| --- | --- |
| Web | http://127.0.0.1:8948 |
| API Base URL | http://127.0.0.1:8949/v1 |
| API 文档 | http://127.0.0.1:8949/docs |

默认仅本机可访问。首次启动请先在设置页创建调用 Key，再开放远程访问（`.env` 设置 `BIND_ADDRESS=0.0.0.0` 并配置 HTTPS）。

## API Key

打开侧边栏 **设置**：

- **调用 API Key**：只能创建一条，完整值仅在创建/重置时提供，请立即复制；重置后旧 Key 和其他登录会话失效。
- **OpenCode API Key**：只在 Web 修改并保存在服务端，付费模型按需配置；「恢复免费模式」使用 `public`。

其他客户端和 Web 登录都使用**调用 Key**，不是 OpenCode Key。网页使用 HttpOnly 会话，无需每次粘贴密钥。
配置持久保存到 Docker 的 `relay-data` 卷，本地为 `data/`；不要删除数据卷或将其提交到 Git。
已有 `.env` 的 `RELAY_API_KEY` 仅在首次初始化时导入，之后以 Web 设置为准。

## API

- `GET /v1/models`：获取可用 Chat 模型。
- `POST /v1/chat/completions`：发送 Chat 请求，`stream: true` 开启流式输出。

OpenAI 兼容客户端填写上面的 Base URL 和设置页生成的调用 Key（`Authorization: Bearer sk-relay-…`）。
外部调用必须提供有效 Key；不再接受 `X-OpenCode-API-Key` 覆盖上游配置。

## 本地运行

安装 Python 3.13、uv、Bun 1.4.4+ 和 Node.js 22.12+：

```sh
uv sync --python 3.13
bun install
bun run dev
```
