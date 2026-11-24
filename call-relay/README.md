# 通话同传中转（可选）

浏览器插件不要长期保存 OpenAI 的主 Key 时，用这个小服务换一个十几分钟有效的临时密钥。语音直接在浏览器和 OpenAI 之间走，不经过这台机器。

不部署也可以：在插件「设置 → 通话同传」里直接填 OpenAI Key（只存在你这台电脑的浏览器里）。

## 运行

需要 Node.js 18 或更新。没有第三方依赖。

```bash
cd call-relay
OPENAI_API_KEY=sk-你的密钥 RELAY_KEY=自己设一串长密码 node server.js
```

默认监听 `8787`。换端口：`PORT=9000`。

- `GET /health` 返回 `{"ok":true}`
- `POST /session`，请求头 `Authorization: Bearer <RELAY_KEY>`，正文：

```json
{ "url": "https://api.openai.com/v1/realtime/translations/client_secrets", "body": { "session": {} } }
```

只允许转到 `https://api.openai.com/v1/realtime/` 下面的地址。主 Key 只留在服务器环境变量里，不要写进代码、不要提交到仓库。

插件里「中转地址」填 `https://你的域名/session`，「中转密钥」填同一个 `RELAY_KEY`。本机试听可以先用 `http://127.0.0.1:8787/session`，WhatsApp 网页是 https，正式用时要给中转加 https，否则浏览器会拦住。

## 自测

```bash
node server.test.js
```
