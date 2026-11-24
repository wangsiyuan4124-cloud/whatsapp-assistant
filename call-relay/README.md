# 通话同传中转

浏览器不能把长期 API Key 放在网页里，也不能在 WebSocket 握手上自己加 `Authorization`。这个小服务跑在你自己的云服务器上（旁边已有 Java / PostgreSQL 没关系，它不用数据库）：

- `POST /session`：用 OpenAI Key 换一个短时密钥。只有还要用 OpenAI 引擎时才需要。
- `GET /aliyun`（WebSocket）：浏览器把音频 JSON 发到这里，服务器带上百炼 Key 去连北京的实时翻译，再把结果转回来。语音经过这台机器，Key 不进浏览器。

## 百炼（默认）

1. 阿里云实名，开通百炼，地域选华北 2（北京）。
2. 创建 API Key，抄下业务空间 ID（WorkspaceId）。
3. 控制台把免费额度设成用完即停。新用户常见额度是 100 万 Token / 90 天，以页面显示为准。
4. 服务器安装 Node.js 18 或更新（这台开发机用的是 22）。

```bash
cd call-relay
RELAY_KEY='自己设一串长密码' \
DASHSCOPE_API_KEY='百炼的长期 Key' \
ALIYUN_WORKSPACE='业务空间 ID' \
node server.js
```

默认模型 `qwen3.8-livetranslate-flash-realtime`，地址是 `wss://<业务空间>.cn-beijing.maas.aliyuncs.com/...`。不要把 Key 写进代码或提交到仓库。

前面用 Nginx 或 Caddy 做 HTTPS，并打开 WebSocket 升级（`Upgrade` / `Connection`）。插件「中转地址」填 `https://你的域名/session`，「中转密钥」填同一个 `RELAY_KEY`。插件会自己把地址换成 `wss://你的域名/aliyun?k=...`。

## OpenAI（可选）

```bash
RELAY_KEY='同一串密码' OPENAI_API_KEY='sk-...' node server.js
```

两个 Key 可以同时配。插件里把引擎从「阿里云百炼」改成 OpenAI 即可。

## 自测

```bash
node server.test.js
```
