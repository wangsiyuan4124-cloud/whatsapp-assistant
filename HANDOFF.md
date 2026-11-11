# WhatsApp 助手：项目交接说明

这份文档写给接手开发的人（或 AI 编程助手）。读完它和 `whatsapp-assistant.user.js`，就能接着改。

## 1. 这是什么

一个 Tampermonkey 用户脚本，运行在 **WhatsApp Business 网页版**（web.whatsapp.com，Chrome）上。使用者是奇瑞威麟（Chery RELY）汽车出口经销商，客户主要在中美洲和加勒比（伯利兹、多米尼加、巴拿马、洪都拉斯等），说英语或西班牙语。

当前版本：**v1.7.9**，一个文件，约 2100 行，没有构建步骤。

## 2. 功能清单

| 功能 | 说明 |
|---|---|
| 发送翻译 | 输入中文按回车，自动翻译成本聊天的语言后发送；Ctrl+Enter 只翻译不发送。默认引擎「AI 翻译」：DeepSeek 结合最近 8 条聊天，翻成地道说法（美式英语 / 拉美西语），避免中式直译；没填 Key 或 AI 失败（15 秒超时、译文含中文等）自动换谷歌，再换微软 Edge，并在状态行提示。工具栏也可以改成只用谷歌或微软。中文输入法选词时的回车不拦截。 |
| 术语表 | 设置 → 基本设置。每行「中文 = 英文 \| 西语」（西语可省，`#` 开头是注释）。AI 翻译时作为必须遵守的译法；谷歌 / 微软翻译前先把原文里的术语替换成目标语言（只支持英语、西语）。 |
| 接收翻译 | 对方发来的外语消息，在原文下方显示「译：中文」。先用谷歌 / 微软显示，填了 Key 且开着「对方消息用 AI 翻译」（设置 → 基本设置，默认开）时，每个聊天最近 20 条再交给 DeepSeek，结合上下文翻译（会理解 80 = 8 万公里、纠正 ti → to 这类笔误），回来后替换成「译(AI)：」。多条合成一次请求（每批最多 8 条），结果存在 `aiTrCache`（最多 600 条），不重复翻。AI 出错保留机器译文，并暂停 1 分钟。选中任意文字可点「译成中文」（仍用机器翻译）。 |
| 每个聊天单独记语言 | 手动选的优先；否则按对方最新消息自动识别。 |
| 三栏布局 | 打开右栏时，把 WhatsApp 的 `#app` 宽度缩小，右边空出一栏（400px，可加宽到 650px）。状态会被记住。 |
| 工具栏 | 三栏时放在右栏顶部；关闭右栏时浮动，可拖动（拖 🌐）、可收起（–）。 |
| 客户分析 | **手动点「分析客户」才分析**（DeepSeek）。输出级别 A/B/C/D、个人还是经销商、理由、已知和还缺的信息、**1 条**建议回复、下一步。对话有新内容才会重新分析，否则提示「已是最新」。 |
| 自动加入列表 | 分析后把聊天加入 WhatsApp Business 的「A 马上成交 / B 有需求 / C 了解中 / D 无效」列表（用户已在 WhatsApp 里建好）。 |
| 学习你的回复方式 | 自动收集：消息发出那一刻（回车没被拦下、或点了发送按钮）记下「客户上一句 → 中文原文 → 发出的外语」；点过「填入」AI 稿又改了再发，记下 AI 原稿（原样发出记 `aiKept`）；「和 AI 改一改」里的要求记进 `refineAsks`；每 5 秒把当前聊天里已加载的「客户说 → 我方回」补录（含手机上发的）。设置 →「AI 学到的」：「学习我的风格」让 DeepSeek 总结风格说明 + 长期偏好规则（可手改），可删样本、导出 JSON。写建议（分析 / 改一改 / 换一条）时附上：风格、规则、按关键词找的 6 条其他客户的相似真实回复、按关键词找的 3 条「原样采用的 AI 回复」（正面例子）、最近 3 条 AI 稿改动（纠正例子）。「学习我的风格」把改过的、原样采用的分开交给 AI。「AI 学到的」页显示 AI 稿原样采用率（全部 / 最近 20 次）。真实回复满 30 条后，通用种子话术不再交给 AI。 |
| 建议回复操作 | 填入、和 AI 多轮修改（子页面，有「← 返回」）、换一条、收藏到话术库。 |
| AI 助手 | 右栏第二个标签页。**独立对话，和客户无关**（像豆包 / DeepSeek App），有新对话、历史、加宽、「📎 引用当前客户聊天」（只附在下一条提问）。纯文本回答；只有用户明确要回复客户时，才用【可发给客户】…【/可发给客户】标记附上可填入的回复。 |
| PI 形式发票 | AI 从聊天提取 → 右栏表单（缺的标黄）→ 预览 → 生成 A4 PDF 加一张 JPG → 粘贴进 WhatsApp 发送预览（不会自动发送）。英文版和西语版，金额大写，编号 `PI-YYYYMMDD-NNN`，按客户存草稿。开票公司：BOUNDLESS AUTOMOTIVE LIMITED（無界汽車有限公司，香港）。 |
| 发车型资料 | 右栏「🚗 发车型资料」（子页面）：选车型组（柴油 / 汽油 / EV，按聊天内容猜一个默认值）→ ① 介绍文字（「标准介绍」用资料包里的卖点；「AI 按客户需求写」挑和客户相关的卖点；「✎ 和 AI 改一改」进修改话术页，`openRefine` 的 `opts.back` 让「← 用这条，返回」/ 页头「← 返回」把草稿带回发车型资料页）→ 填入聊天；每个「聊天 | 车型组」的介绍、照片和视频选择、规格书选项记在 `catState`（刷新页面后清空）；② 点选照片；③ 规格书 PDF（英 / 西，可带 CIF 到港价，附一张 JPG 预览图）；④ 视频 → 一次粘贴进发送预览（不会自动发送）。规格书页眉的 logo：资料包根目录的 `logo*.png` 优先（导入时存进 `catalog.logo`），其次用 PI 设置里的 logo。资料包是本地文件夹（见第 10 节），在「设置 → 车型资料」导入：一个 `.json` + 根目录 `logo.png` + 按子文件夹名（如 `diesel+gasoline`、`ev`）分组的照片和视频；照片导入时压缩到 1600px JPG，照片视频存在 IndexedDB `wat-media`。CIF：按版本手动填的优先（用户填的就是含运费的到港价，不需要再填运费）；没填的才用 FOB + 每台运费 + 每台保险费。对外只出现 CIF，不出现 FOB。带价格时：规格书表格下方有一行说明「CIF 只含到港海运费和保险，不含进口关税、当地税费、港杂费和内陆运输」（英 / 西），标准介绍的价格行也带简短说明；车型参数和 CIF 价会加进所有 AI 提示词（`catalogContext`，不含 FOB），并要求 AI 报价时说明 CIF 不含哪些费用、不估落地价。 |
| 设置 | ⚙ 打开，标签页：基本设置（DeepSeek Key、业务介绍、价格表与交易条款、分级标准、自动加入列表开关）、PI 发票（公司、银行、Logo、公章、默认条款）、话术库。 |

## 3. 代码结构（按文件里的分节注释）

- 配置、存储、翻译接口（谷歌 / 微软）；发送翻译 `translateOut`（AI 翻译 `aiTranslateOut`，术语表 `glossary` / `applyGlossary`，失败退回机器翻译）
- WhatsApp 页面元素：`getInput`、`getChatName`、`replaceInputText`、`clickSend`
- 发送翻译核心流程、选中翻译、接收翻译（`scanIncoming`，MutationObserver + 定时兜底；AI 部分是 `aiEnqueue` / `aiFlush` / `aiTranslateIn`，译文框用 `data-kind` = mt / ai / err 区分）
- 悬浮工具栏 `ui`（`ui.position` 每 500ms 执行一次：三栏时贴在右栏的 `#wat-barslot` 位置）
- **学习模块**（在客户分析模块前面）：`recordSentFromInput`、`harvestHistory`、`recordAsk`、`similarSamples`、`styleContext`、`learnStyle`；设置页 `learnSettingsSection`
- **客户分析模块**：`baseContext(conv, chatName)`（传了 conv 才附相似回复）、`buildPrompt`、`callDeepSeek`（带重试和宽松 JSON 解析）、`applyLevelList`、`showPanel`、状态行 `setStatus` / `panelNotice`、`convFingerprint`、`renderResult`、`openRefine`、`anotherSuggestion`、AI 助手 `openAsk` / `renderHistory`、`analyzeCurrent`、`syncPanel`、设置面板 `openSettings(tab)`
- **PI 模块**：`renderPiPage`（全部内联样式，794px 宽）、`makePdfFiles`（通用：html2canvas 生成图片，再用 jsPDF 生成 PDF，超过一页自动分页；`makePiFiles` 调它）、`attachToChat`、`extractPiFromChat`、`renderPiEditor`、`piSettingsSection`
- **车型资料模块**：`catStore`、`cifOf`、`mediaDb`（IndexedDB）、`importCatalogFolder`、`catalogContext`、`renderSpecPage`（规格书，内联样式，表格要显式写字号）、`openCatalog` / `renderCatalogPanel`、`catalogSettingsSection`
- 工具栏拖动、启动

依赖：通过 `@require` 从 cdnjs 加载 html2canvas 1.4.1 和 jsPDF 2.5.1。`@connect` 允许访问谷歌翻译、微软翻译、api.deepseek.com。

### 存储（GM_setValue，只存在用户这台电脑的 Chrome 里）

`dsKey`（API Key）、`glossary`（术语表）、`aiIn`（对方消息 AI 翻译开关）、`aiTrCache`（对方消息 AI 译文缓存）、`myReplies`（你的回复样本，最多 800 条：`{at, chat, cust, zh?, sent, ai?, aiKept?, src: live|history}`）、`refineAsks`（修改要求，最多 200 条）、`styleProfile`（`{style, rules, at, n}`）、`catalog`（车型资料包，含 FOB）、`catPrice`（`{port, freight, insurance, override}`）、`bizInfo`、`priceTable`、`gradeRules`、`autoLabel`、`playbook`、`analyses`（按聊天名，含 `fp` 指纹）、`aiChats` / `aiCurrent`、`piSeller`（公司、银行、logo 和公章的 dataURL）、`piDrafts`、`piRecords`、`piSeq`、`piWithImg`、`docked`、`panelWide`、`barPos`、`barMin`、`chatLangs`、`defaultLang`、`autoSend`、`autoIn`、`engine`（`ai` / `google` / `microsoft`，默认 `ai`；只影响发送翻译；接收翻译由 `aiIn` 控制）、`enabled`。

**仓库是公开的**：代码里绝不能放 API Key、银行信息、公章或 Logo 图片。

## 4. 依赖的 WhatsApp 页面元素（2026-11 实测）

- 当前聊天：`#main`；聊天名：`#main header span[dir="auto"]`（`title` 属性）
- 输入框：`#main footer div[contenteditable="true"]`（Lexical 编辑器）
- 发送按钮：`#main footer button[aria-label="发送"]`（中文界面；没有 `data-icon`）
- 消息行：`[data-testid^="conv-msg-"]`；气泡：`[data-testid="msg-container"]`；正文：`.copyable-text [data-testid="selectable-text"]`；时间和发送人：`.copyable-text[data-pre-plain-text]`，格式是 `[下午4:07, 2026年11月5日] 名字: `
- 区分收发：消息里的 `[data-icon="tail-in"]` / `tail-out`（只有一组连续消息的第一条有），没有的话按气泡偏左还是偏右判断
- 引用回复里被引用的那条：在 `[role="button"]` 里，要跳过
- 聊天列表：`#pane-side [role="row"]`，标题 `[data-testid="cell-frame-title"] span[title]`
- 列表按钮：聊天顶部 `aria-label="添加到列表"`，加过列表后按钮上显示列表名。菜单是 `[role="menu"]`，选项是 `li[role="menuitemcheckbox"]`（`aria-checked`）
- 附件：在输入框上触发 `paste` 事件，`clipboardData` 里放 File（可以多个），WhatsApp 会打开发送预览。PDF 在预览里显示「暂无预览」，所以同时附一张 JPG。

## 5. 踩过的坑（一定要遵守）

1. **绝不能发送 Esc 键事件**。在 WhatsApp 里 Esc 会关闭当前聊天。关列表菜单的方法是：在插件自己的面板上模拟一次「点外面」，不行再点一次列表按钮。
2. **Tampermonkey 沙箱里 `window` 不是真正的 Window**。`new MouseEvent(type, { view: window })` 会直接报错。不要传 `view`；测试要用沙箱模拟（见 `tests/t08`、`t09` 的写法）。
3. **Lexical 输入框替换文字**：先选中全部内容，等约 40ms（Lexical 是异步同步选区的），再触发 `paste` 事件；不行再用 `execCommand('insertText')`。替换后要核对内容是否正确。
4. 「填入」或翻译后会记下 `lastTranslated`，按回车时不会再翻译一遍。
5. DeepSeek 的 JSON 模式偶尔返回空内容，或者在 JSON 外面加说明文字。`callDeepSeek` 会宽松解析并重试一次。AI 助手用纯文本模式（`{ json: false }`）。
6. GitHub 的 raw 下载地址有大约 5 分钟缓存。发布后要确认 raw 地址拿到的已经是新版本号，再通知用户更新。
7. AI 翻译时要忠实原文、保留人称（曾经把「Can I give you an estimate」翻成「能给我报价吗」）。
8. 谷歌 / 微软是逐字直译，会出中式英语（例：「二手车」→ second-hand car，当地说 used car）。所以发送翻译默认用 AI，术语表兜底。

## 6. 产品决定和用户偏好

- 界面和说明都用中文；**不要弹窗挡住聊天**，提示放在右栏顶部状态行（成功类 4 秒消失，出错的手动关掉）。
- 分析**只在手动点击时进行**（试过自动分析，用户不要）。
- 建议回复**只给 1 条**。
- AI 助手**不加常用问题的快捷按钮**；只做用户让它做的事，不主动给销售建议。
- 价格、付款、交期、库存等数字只能来自设置里的「价格表与交易条款」，没有就不编。
- 子页面要有「← 返回」；右上角 × 是关闭整个右栏。
- 用户说「先探讨」时，先讨论方案，确认后再写代码。

## 7. 发布流程

1. 改 `whatsapp-assistant.user.js`，**同时把 `@version` 加一**。
2. 跑测试：`cd tests && npm install && npx playwright install chromium && npm test`，核对输出。
3. 提交并推送到 `main`。
4. 确认 `https://raw.githubusercontent.com/wangsiyuan4124-cloud/whatsapp-assistant/main/whatsapp-assistant.user.js` 里的 `@version` 已经是新版本。
5. 用户在 Chrome 打开上面这个链接，在 Tampermonkey 页面点「更新 / Overwrite」，再刷新 WhatsApp。

## 8. 测试（tests/ 目录）

- `app.js` 用 Lexical 搭了一个模拟输入框（`npm run build` 打包成 `app.bundle.js`）。`page*.html` 是逐步加了功能的模拟 WhatsApp 页面：消息行、列表菜单、`GM_*` 函数、模拟的翻译和 DeepSeek 返回。
- `page6.html` 起，模拟页面会把「按 Esc 关聊天」计数（`chatClosed`）。`#keep` 参数模拟「点菜单项后菜单不关」的情况。
- `t01`–`t12` 是 Playwright 脚本（`t10` 测 AI 发送翻译、术语表和失败退回；`t11` 测对方消息 AI 翻译；`t12` 测学习你的回复方式；`t13` 测车型资料，用 `fixtures/catalog/` 里的假资料包，价格都是假的）。`t03`–`t10` 设置了 Key，所以先设 `aiIn=false`，免得对方消息的 AI 翻译打乱它们对 DeepSeek 调用次数的统计，输出关键结果，需要人工核对（不是断言式测试）。`t08`、`t09` 把脚本包在沙箱 Proxy 里运行，更接近 Tampermonkey 的真实环境。
- 环境变量 `SCRIPT` 可以指定要测的脚本文件。
- 模拟页面测不出 WhatsApp 改版的影响，重要改动发布后要请用户在真实页面上确认一次。

## 9. 待办和想法

- [ ] 「导出 / 导入全部设置」：备份 Key、PI 资料、话术库，方便换电脑（之前提过，用户还没确认）。
- [ ] 批量分析：依次打开没分析过的聊天并分析（讨论过，还没做）。
- [ ] 纠错词库：比如客户把 price 写成 prize。讨论过但用户还没拍板，曾有半成品，已撤回。
- [ ] 公章图片是从 MAF 扫描件里抠出来的，有几处浅色条纹。用户可以在白纸上重新盖章拍照，再重新处理。
- [ ] 以后计划：WhatsApp 官方 API（共存模式）加服务器上的自动回复机器人，复用同一套分级标准和话术库。这部分适合单独建一个后端项目。到时可以用「AI 学到的 → 导出学习数据」的 JSON，接 Mem0 / Letta 这类记忆框架，或样本够多后做微调。
- [ ] 不做：导入手机导出的聊天 txt（用户 2026-11 明确不要）。

## 10. 用户本地文件

- `D:\WhatsApp插件\`：脚本副本、`boundless-seal.png`（公章，已上传到插件设置）、`boundless-logo-pi.png`（Logo，已上传到插件设置）、`Boundless-Logo.zip`、`PI示例（测试数据）.pdf`
- `D:\威麟\`：公司资料（银行等信息由用户自己在插件设置里填写）。R8 配置表：`RELY  R8 Gasoline-Euro II Configuration and Pricing.xlsx`、`RELY R8 DIESEL Configurations and Prices.xlsx`（用「RELY R8 DIESEL 」表）、`RELY R8 EV Configurations and Prices.xlsx`，里面有 FOB 价
- `D:\威麟\WhatsApp资料包\`：车型资料包（**含 FOB 价，绝不能提交到仓库**）。`logo.png`（就是 `boundless-logo-pi.png`，白底用的图标；网站那个带字的 lockup 字是白色的，不适合白底）；`R8车型资料.json` 由 `tests/make-catalog.js` 从上面三份配置表生成（版本名、卖点文案、待确认事项写在脚本里）；`diesel+gasoline\`（网站用的 14 张照片，按显示顺序编号）、`ev\`（EV 照片 10 张 + EV 广告视频）、`diesel\`（柴油广告视频）。配置表或价格更新后：重新跑脚本 → 在插件「设置 → 车型资料」重新导入文件夹
