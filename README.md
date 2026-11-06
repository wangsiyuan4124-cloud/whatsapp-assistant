# WhatsApp 助手（Tampermonkey 用户脚本）

在 WhatsApp Business 网页版上提供：中外文自动翻译、AI 客户分析与回复建议、独立 AI 助手、PI 形式发票（英文 / 西语 PDF）生成。

- 安装 / 更新：在装了 Tampermonkey 的 Chrome 里打开
  https://raw.githubusercontent.com/wangsiyuan4124-cloud/whatsapp-assistant/main/whatsapp-assistant.user.js
- 开发交接说明：见 [HANDOFF.md](HANDOFF.md)
- 测试：`cd tests && npm install && npx playwright install chromium && npm test`

注意：本仓库公开，API Key、银行信息、公章、Logo 只保存在使用者浏览器的插件设置里，不要提交到仓库。
