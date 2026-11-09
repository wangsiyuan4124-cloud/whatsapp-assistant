// ==UserScript==
// @name         WhatsApp 发送翻译助手（中文→外语）
// @namespace    rely-whatsapp-translator
// @version      1.7.4
// @description  在 WhatsApp 网页版输入中文，自动翻译成英文/其他语言再发送；对方发来的外语自动在原文下方显示中文译文；AI 分析客户级别并给出回复建议；一键生成 PI 形式发票。
// @match        https://web.whatsapp.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      translate.googleapis.com
// @connect      edge.microsoft.com
// @connect      api-edge.cognitive.microsofttranslator.com
// @connect      api.deepseek.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/wangsiyuan4124-cloud/whatsapp-assistant/main/whatsapp-assistant.user.js
// @downloadURL  https://raw.githubusercontent.com/wangsiyuan4124-cloud/whatsapp-assistant/main/whatsapp-assistant.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ---------------- 配置 ---------------- */
  const LANGS = [
    ['en', 'English 英语'],
    ['es', 'Español 西班牙语'],
    ['ar', 'العربية 阿拉伯语'],
    ['ru', 'Русский 俄语'],
    ['fr', 'Français 法语'],
    ['pt', 'Português 葡萄牙语'],
    ['vi', 'Tiếng Việt 越南语'],
    ['th', 'ไทย 泰语'],
    ['id', 'Indonesia 印尼语'],
    ['tr', 'Türkçe 土耳其语'],
    ['fa', 'فارسی 波斯语'],
    ['ur', 'اردو 乌尔都语'],
    ['uz', 'Oʻzbek 乌兹别克语'],
    ['kk', 'Қазақ 哈萨克语'],
    ['de', 'Deutsch 德语'],
    ['ja', '日本語 日语'],
    ['ko', '한국어 韩语'],
  ];
  // 微软接口的语言代码与谷歌个别不同
  const MS_CODE = { 'zh-CN': 'zh-Hans', 'zh': 'zh-Hans' };

  const store = {
    get(k, d) { try { const v = GM_getValue(k); return v === undefined ? d : v; } catch (e) { return d; } },
    set(k, v) { try { GM_setValue(k, v); } catch (e) {} },
  };
  const settings = {
    get defaultLang() { return store.get('defaultLang', 'en'); },
    set defaultLang(v) { store.set('defaultLang', v); },
    get autoSend() { return store.get('autoSend', true); },
    set autoSend(v) { store.set('autoSend', v); },
    get engine() { return store.get('engine', 'ai'); }, // ai：发送用 DeepSeek 翻译；接收翻译始终用谷歌/微软
    set engine(v) { store.set('engine', v); },
    get enabled() { return store.get('enabled', true); },
    set enabled(v) { store.set('enabled', v); },
    get autoIn() { return store.get('autoIn', true); },
    set autoIn(v) { store.set('autoIn', v); },
    chatLangs() { return store.get('chatLangs', {}); },
  };

  /* ---------------- 翻译接口 ---------------- */
  function request(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest(Object.assign({
        timeout: 10000,
        onload: (r) => (r.status >= 200 && r.status < 300) ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status)),
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('请求超时')),
      }, opts));
    });
  }

  async function googleTranslate(text, to) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=' +
      encodeURIComponent(to) + '&q=' + encodeURIComponent(text);
    const data = JSON.parse(await request({ method: 'GET', url }));
    const out = (data[0] || []).map((seg) => seg[0] || '').join('');
    if (!out) throw new Error('谷歌返回为空');
    return { text: out, from: data[2] || '' };
  }

  let msToken = null, msTokenAt = 0;
  async function microsoftTranslate(text, to) {
    if (!msToken || Date.now() - msTokenAt > 8 * 60 * 1000) {
      msToken = (await request({ method: 'GET', url: 'https://edge.microsoft.com/translate/auth' })).trim();
      msTokenAt = Date.now();
    }
    const url = 'https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to=' +
      encodeURIComponent(MS_CODE[to] || to);
    const data = JSON.parse(await request({
      method: 'POST', url,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + msToken },
      data: JSON.stringify([{ Text: text }]),
    }));
    const out = data && data[0] && data[0].translations && data[0].translations[0] && data[0].translations[0].text;
    if (!out) throw new Error('微软返回为空');
    return { text: out, from: (data[0].detectedLanguage || {}).language || '' };
  }

  // 首选引擎失败时自动换另一个
  async function translate(text, to) {
    const order = settings.engine === 'microsoft'
      ? [microsoftTranslate, googleTranslate]
      : [googleTranslate, microsoftTranslate];
    let lastErr;
    for (const fn of order) {
      try { return await fn(text, to); } catch (e) { lastErr = e; if (fn === microsoftTranslate) msToken = null; }
    }
    throw lastErr || new Error('翻译失败');
  }

  /* ---------------- 发送翻译：AI（DeepSeek）结合上下文翻译 + 术语表 ---------------- */
  // 术语表：每行「中文 = 英文译法 | 西语译法」，西语部分可省略
  function glossary() {
    return String(store.get('glossary', '') || '').split('\n').map((l) => {
      const m = l.match(/^\s*([^=＝#]+?)\s*[=＝]\s*(.+?)\s*$/);
      if (!m) return null;
      const [en, es] = m[2].split(/\s*[|｜]\s*/);
      return { zh: m[1], en: en || '', es: es || '' };
    }).filter((g) => g && (g.en || g.es));
  }
  // 机器翻译前，先把术语换成目标语言的说法（只支持英语、西语）
  function applyGlossary(text, lang) {
    const key = lang === 'es' ? 'es' : lang === 'en' ? 'en' : '';
    if (!key) return text;
    let out = text;
    glossary().filter((g) => g[key]).sort((a, b) => b.zh.length - a.zh.length)
      .forEach((g) => { out = out.split(g.zh).join(' ' + g[key] + ' '); });
    return out.replace(/ {2,}/g, ' ').trim();
  }
  const langName = (code) => ((LANGS.find(([c]) => c === code) || [])[1] || code);

  async function aiTranslateOut(text, lang) {
    const gl = glossary();
    const conv = readConversation(8);
    const system = [
      '你是专业的外贸汽车销售翻译。把销售写的中文消息翻译成「' + langName(lang) + '」，在 WhatsApp 上直接发给客户。客户在中美洲和加勒比地区，聊的是汽车生意。',
      '【要求】',
      '1. 意思必须忠实：不增加、不删除信息；严格保留人称和谁对谁做什么（我/你/我们、给/要、问/答），问句仍然是问句。不要自己加价格、优惠、承诺或客套话。',
      '2. 用母语者在 WhatsApp 上自然的说法，不要逐字直译，不要中式英语；可以调整语序和句式。英语用美式说法，西班牙语用拉美说法。',
      '3. 汽车行业用当地常用词，例如：二手车 = used car（西语 carro usado / vehículo usado），落地价 = landed price，定金 = deposit，现车 = in stock。',
      '4. 聊天记录只用来理解上下文（指代、车型、话题），不要翻译它，也不要替销售回答客户。',
      '5. 保留原文的换行、数字、型号和表情。',
      '6. 只输出译文本身，不要引号、不要解释、不要中文。',
      gl.length ? '【术语表（必须按这里的译法）】\n' + gl.map((g) => '- ' + g.zh + '：' + [g.en && '英语 ' + g.en, g.es && '西语 ' + g.es].filter(Boolean).join('；')).join('\n') : '',
    ].filter(Boolean).join('\n');
    const user = (conv.length ? '【最近的聊天记录（只作参考）】\n' + conv.map((m) => m.from + '：' + m.text.slice(0, 300)).join('\n') + '\n\n' : '') +
      '【要翻译的中文】\n' + text;
    const res = await callDeepSeek([{ role: 'system', content: system }, { role: 'user', content: user }], 600, { json: false, timeout: 15000 });
    const out = res.text.trim().replace(/^(译文|翻译|Translation)\s*[:：]\s*/i, '').replace(/^["“'「]([\s\S]*)["”'」]$/, '$1').trim();
    if (!out || res.truncated) throw new Error('AI 没有返回完整译文');
    if (hasChinese(out)) throw new Error('AI 译文里还有中文');
    return out;
  }

  // 发送用的翻译：选了 AI 且填了 Key 就用 AI，失败自动换谷歌/微软
  let noKeyTipShown = false;
  async function translateOut(text, lang) {
    if (settings.engine === 'ai') {
      if (store.get('dsKey', '')) {
        try { return { text: await aiTranslateOut(text, lang), via: 'AI' }; } catch (e) {
          const r = await translate(applyGlossary(text, lang), lang);
          return { text: r.text, via: '机器', note: 'AI 翻译失败（' + e.message + '），已改用谷歌/微软翻译' };
        }
      }
      const r = await translate(applyGlossary(text, lang), lang);
      const note = noKeyTipShown ? '' : '没有填 DeepSeek Key，已用谷歌翻译（在 ⚙ 设置里填 Key 后可用 AI 翻译）';
      noKeyTipShown = true;
      return { text: r.text, via: '机器', note };
    }
    const r = await translate(applyGlossary(text, lang), lang);
    return { text: r.text, via: '机器' };
  }

  /* ---------------- WhatsApp 页面元素 ---------------- */
  const hasChinese = (s) => /[\u3400-\u9fff\uf900-\ufaff]/.test(s);

  function getInput() {
    return document.querySelector('#main footer div[contenteditable="true"]');
  }
  function getInputText(el) {
    return (el.innerText || '').replace(/\u00a0/g, ' ').replace(/\n{2,}/g, '\n').trim();
  }
  function getChatName() {
    const h = document.querySelector('#main header span[dir="auto"]') ||
              document.querySelector('#main header span[title]');
    return h ? (h.getAttribute('title') || h.textContent || '').trim() : '';
  }
  // 每个聊天的回复语言：手动设置 > 根据对方消息自动识别 > 默认
  const autoLangs = {};
  function getChatLang() {
    const name = getChatName();
    const map = settings.chatLangs();
    return (name && (map[name] || autoLangs[name])) || settings.defaultLang;
  }
  function setChatLang(lang) {
    const name = getChatName();
    if (name) {
      const map = settings.chatLangs();
      map[name] = lang;
      store.set('chatLangs', map);
    } else {
      settings.defaultLang = lang;
    }
  }

  function selectAllIn(el) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // 用"粘贴"方式替换输入框内容（WhatsApp 的编辑器能正确识别），失败再用 insertText
  async function replaceInputText(el, text) {
    selectAllIn(el);
    await sleep(40); // 等编辑器同步选区，否则会追加而不是替换
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch (e) { /* ignore */ }
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    await sleep(30);
    if (norm(getInputText(el)) === norm(text)) return true;

    selectAllIn(el);
    await sleep(40);
    document.execCommand('insertText', false, text);
    await sleep(30);
    return norm(getInputText(el)) === norm(text);
  }

  function clickSend() {
    const icon = document.querySelector(
      '#main footer span[data-icon="send"], #main footer span[data-icon="wds-ic-send-filled"], #main footer span[data-icon*="send"]'
    );
    const btn = (icon && icon.closest('button')) ||
      document.querySelector('#main footer button[aria-label="Send"], #main footer button[aria-label="发送"], #main footer button[aria-label="傳送"]');
    if (btn) { btn.click(); return true; }
    if (icon) { icon.click(); return true; }
    // 兜底：模拟回车
    const el = getInput();
    if (!el) return false;
    bypassNextEnter = true;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    return true;
  }

  /* ---------------- 核心流程 ---------------- */
  let busy = false;
  let dragging = null; // 正在拖动工具栏
  let bypassNextEnter = false;
  let lastTranslated = ''; // 已翻译过的内容，回车时不再重复翻译

  async function translateInput(andSend) {
    const el = getInput();
    if (!el || busy) return;
    const original = getInputText(el);
    if (!original) return;
    const lang = getChatLang();
    busy = true;
    ui.setBusy(true);
    try {
      const res = await translateOut(original, lang);
      if (getInputText(el) !== original) { toast('输入内容已改变，已取消本次翻译', true); return; }
      if (!(await replaceInputText(el, res.text))) { toast('无法写入输入框，请刷新页面后重试', true); return; }
      lastTranslated = getInputText(el);
      if (andSend) {
        await sleep(120);
        if (!clickSend()) toast('未找到发送按钮，请手动按回车', true);
        else if (res.note) toast(res.note);
      } else {
        toast((res.note ? res.note + '。' : '') + '已翻译为 ' + lang.toUpperCase() + '（' + res.via + '），检查后按回车发送');
      }
    } catch (e) {
      toast('翻译失败：' + e.message + '（原文未发送）', true);
    } finally {
      busy = false;
      ui.setBusy(false);
    }
  }

  document.addEventListener('keydown', (e) => {
    if (!settings.enabled) return;
    const el = getInput();
    if (!el || !el.contains(e.target)) return;
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return; // 中文输入法选词时的回车不拦截

    // Ctrl/⌘ + Enter：只翻译不发送
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault(); e.stopImmediatePropagation();
      translateInput(false);
      return;
    }
    if (e.shiftKey || e.altKey) return; // Shift+Enter 换行
    if (bypassNextEnter) { bypassNextEnter = false; return; }
    if (busy) { e.preventDefault(); e.stopImmediatePropagation(); return; }

    // 回车：含中文且开启了自动模式 → 翻译后发送
    const cur = getInputText(el);
    if (settings.autoSend && hasChinese(cur) && cur !== lastTranslated) {
      e.preventDefault(); e.stopImmediatePropagation();
      translateInput(true);
    }
  }, true);

  /* ---------------- 选中对方消息 → 翻译成中文 ---------------- */
  const chip = document.createElement('div');
  chip.id = 'wat-chip';
  document.documentElement.appendChild(chip);
  let chipText = '';

  document.addEventListener('mouseup', (e) => {
    if (chip.contains(e.target)) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      const main = document.querySelector('#main');
      const footer = document.querySelector('#main footer');
      if (!text || !main || !sel.anchorNode || !main.contains(sel.anchorNode) ||
          (footer && footer.contains(sel.anchorNode)) || text.length > 3000) {
        chip.style.display = 'none';
        return;
      }
      chipText = text;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      chip.textContent = '译成中文';
      chip.className = 'wat-chip-btn';
      chip.style.left = Math.max(8, Math.min(window.innerWidth - 120, r.left)) + 'px';
      chip.style.top = Math.max(8, r.top - 34) + 'px';
      chip.style.display = 'block';
    }, 10);
  });
  chip.addEventListener('mousedown', (e) => e.preventDefault());
  chip.addEventListener('click', async () => {
    if (chip.className !== 'wat-chip-btn') { chip.style.display = 'none'; return; }
    chip.textContent = '翻译中…';
    try {
      const res = await translate(chipText, 'zh-CN');
      chip.className = 'wat-chip-result';
      chip.textContent = res.text + (res.from ? '  〔' + res.from + '〕' : '');
      // 顺便提示：对方语言可设为本聊天的发送语言
      const base = (res.from || '').split('-')[0];
      if (base && base !== 'zh' && LANGS.some(([c]) => c === base) && base !== getChatLang()) {
        const btn = document.createElement('button');
        btn.textContent = '本聊天改用该语言回复';
        btn.onclick = (ev) => { ev.stopPropagation(); setChatLang(base); ui.refresh(); chip.style.display = 'none'; toast('本聊天发送语言已设为 ' + base.toUpperCase()); };
        chip.appendChild(document.createElement('br'));
        chip.appendChild(btn);
      }
    } catch (e) {
      chip.className = 'wat-chip-result';
      chip.textContent = '翻译失败：' + e.message;
    }
  });

  /* ---------------- 对方消息自动翻译成中文（显示在原文下方） ---------------- */
  const trCache = new Map();     // 原文 -> {text, from} 或 {err, at}
  const pending = new Set();
  const queue = [];
  let running = 0;
  const MAX_PARALLEL = 2;

  // 主要是中文、或者没有文字（纯表情/数字）的消息不翻译
  function needsTranslate(text) {
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (!letters) return false;
    const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    return cjk / letters < 0.3;
  }

  function isIncoming(row, mainRect) {
    if (row.classList.contains('message-in') || row.querySelector('.message-in, [data-icon="tail-in"]')) return true;
    if (row.classList.contains('message-out') || row.querySelector('.message-out, [data-icon="tail-out"]')) return false;
    const c = row.querySelector('[data-testid="msg-container"]');
    if (!c) return false;
    const r = c.getBoundingClientRect();
    return (r.left - mainRect.left) < (mainRect.right - r.right);
  }

  function getMsgTextSpan(row) {
    const spans = row.querySelectorAll('.copyable-text [data-testid="selectable-text"], .copyable-text span.selectable-text');
    for (const s of spans) {
      if (s.closest('[data-testid="quoted-message"], [role="button"]')) continue; // 跳过引用回复里被引用的那条
      return s;
    }
    return null;
  }

  function trBoxOf(span) {
    const host = span.parentElement;
    return host && host.parentElement ? host.parentElement.querySelector(':scope > .wat-tr') : null;
  }

  function renderTr(span, text, res) {
    const host = span.parentElement;
    if (!host || !host.parentElement) return;
    let box = trBoxOf(span);
    if (!box) {
      box = document.createElement('div');
      box.className = 'wat-tr';
      host.insertAdjacentElement('afterend', box);
    }
    box.dataset.src = text;
    box.dataset.kind = res.ai ? 'ai' : res.err ? 'err' : 'mt';
    box.textContent = res.err ? '（翻译失败，稍后自动重试）' : res.text;
    box.classList.toggle('wat-tr-err', !!res.err);
    box.classList.toggle('wat-tr-ai', !!res.ai);
  }

  /* ---------- 对方消息的 AI 翻译：先显示机器翻译，AI 结果回来后替换 ---------- */
  // 只翻每个聊天最近 AI_IN_RECENT 条客户消息；多条合成一次请求；结果存起来，不重复翻
  const AI_IN_RECENT = 20, AI_IN_BATCH = 8, AI_IN_CACHE_MAX = 600;
  const aiInOn = () => store.get('aiIn', true) && !!store.get('dsKey', '');
  let aiTrStore = null;
  const aiTr = {
    all() { if (!aiTrStore) aiTrStore = store.get('aiTrCache', {}) || {}; return aiTrStore; },
    get(t) { return aiTr.all()[t]; },
    put(pairs) {
      const all = aiTr.all();
      pairs.forEach(([t, zh]) => { delete all[t]; all[t] = zh; });
      const keys = Object.keys(all);
      keys.slice(0, Math.max(0, keys.length - AI_IN_CACHE_MAX)).forEach((k) => delete all[k]);
      store.set('aiTrCache', all);
    },
  };
  const aiErr = new Map();   // 原文 -> 失败时间（2 分钟后再试）
  const aiPending = new Set();
  let aiQueue = [];          // { text, chat }
  let aiTimer = null, aiRunning = false, aiBackoffUntil = 0;

  function aiEnqueue(text, chat) {
    if (aiPending.has(text) || aiTr.get(text) || text.length > 1500) return;
    const e = aiErr.get(text);
    if (e && Date.now() - e < 120000) return;
    aiPending.add(text);
    aiQueue.push({ text, chat });
    if (!aiTimer) aiTimer = setTimeout(aiFlush, 600);
  }

  async function aiFlush() {
    aiTimer = null;
    if (aiRunning) return;
    const chat = getChatName();
    // 切换了聊天：别的聊天的排队消息先丢掉，回到那个聊天时会重新排队
    aiQueue.filter((q) => q.chat !== chat).forEach((q) => aiPending.delete(q.text));
    aiQueue = aiQueue.filter((q) => q.chat === chat);
    if (!aiQueue.length || !aiInOn()) { aiQueue.forEach((q) => aiPending.delete(q.text)); aiQueue = []; return; }
    if (Date.now() < aiBackoffUntil) { aiTimer = setTimeout(aiFlush, aiBackoffUntil - Date.now()); return; }
    const batch = aiQueue.splice(0, AI_IN_BATCH);
    aiRunning = true;
    try {
      const got = await aiTranslateIn(batch.map((q) => q.text), chat);
      const ok = [];
      batch.forEach((q, i) => { if (got[i]) ok.push([q.text, got[i]]); else aiErr.set(q.text, Date.now()); });
      if (ok.length) aiTr.put(ok);
    } catch (e) {
      batch.forEach((q) => aiErr.set(q.text, Date.now()));
      aiBackoffUntil = Date.now() + 60000; // 出错（余额不足、网络等）先停 1 分钟，避免反复请求
    } finally {
      batch.forEach((q) => aiPending.delete(q.text));
      aiRunning = false;
      scanIncoming();
      if (aiQueue.length && !aiTimer) aiTimer = setTimeout(aiFlush, 300);
    }
  }

  async function aiTranslateIn(texts, chatName) {
    const gl = glossary();
    const conv = readConversation(12);
    const system = [
      '你是外贸汽车销售的翻译助手。把客户发来的 WhatsApp 消息翻译成简体中文，给中国销售看。客户在中美洲和加勒比地区，聊的是汽车生意。',
      '【要求】',
      '1. 忠实原文，逐句翻译，严格保留人称和谁对谁做什么（I/you/we、给/要、问/答），问句仍然是问句。不要总结、不要加建议、不要替销售回答。',
      '2. 结合聊天上下文理解指代、车型和数字。数字的单位能从上下文确定时，可以在括号里简短补充，例如「80（指 8 万公里）是上限」。',
      '3. 客户的拼写错误和缩写按本意翻译（如 ti → to、milage → mileage、pls → please），不用指出。',
      '4. 译文要像中国人说话一样自然，不要翻译腔。',
      '5. 原文有歧义时，按最可能的意思翻译，再在括号里用一句话注明另一种理解。',
      gl.length ? '【术语表（外语译成中文时用左边的中文说法）】\n' + gl.map((g) => '- ' + [g.en, g.es].filter(Boolean).join(' / ') + ' → ' + g.zh).join('\n') : '',
      '6. 只输出 JSON：{"items":[{"id":1,"zh":"中文译文"}]}，id 和下面的编号一一对应，每条都要有。',
    ].filter(Boolean).join('\n');
    const user = (conv.length ? '【最近的聊天记录（只作参考，不要翻译）】\n' + convText(conv, chatName) + '\n\n' : '') +
      '【需要翻译的客户消息】\n' + texts.map((t, i) => (i + 1) + '. ' + t).join('\n');
    const { json } = await callDeepSeek([{ role: 'system', content: system }, { role: 'user', content: user }], 1500, { timeout: 30000 });
    const items = (json && Array.isArray(json.items)) ? json.items : [];
    return texts.map((t, i) => {
      const it = items.find((x) => Number(x && x.id) === i + 1);
      const zh = it && String(it.zh || '').trim();
      return zh && hasChinese(zh) ? zh : '';
    });
  }

  function pump() {
    while (running < MAX_PARALLEL && queue.length) {
      const text = queue.shift();
      running++;
      translate(text, 'zh-CN')
        .then((res) => { trCache.set(text, res); })
        .catch(() => { trCache.set(text, { err: true, at: Date.now() }); })
        .finally(() => { running--; pending.delete(text); scanIncoming(); pump(); });
    }
  }

  function scanIncoming() {
    const main = document.querySelector('#main');
    if (!main) return;
    const on = settings.enabled && settings.autoIn;
    main.querySelectorAll('.wat-tr').forEach((b) => { b.style.display = on ? '' : 'none'; });
    if (!on) return;
    const mainRect = main.getBoundingClientRect();
    let lastInText = '';
    const useAi = aiInOn();
    const toTranslate = [];
    main.querySelectorAll('[data-testid^="conv-msg-"], .message-in').forEach((row) => {
      if (!isIncoming(row, mainRect)) return;
      const span = getMsgTextSpan(row);
      if (!span) return;
      const text = (span.innerText || '').trim();
      if (!text || text.length > 3000) return;
      if (/\p{L}/u.test(text)) lastInText = text; // 纯表情不算
      if (!needsTranslate(text)) return;
      toTranslate.push(text);
      const cached = trCache.get(text);
      if (cached && cached.err && Date.now() - cached.at > 30000) trCache.delete(text);
      const c = trCache.get(text);
      const aiText = useAi && aiTr.get(text);
      // 显示优先级：AI 译文 > 机器译文 > 失败提示
      const show = aiText ? { text: aiText, ai: true } : c;
      if (show) {
        const box = trBoxOf(span);
        const kind = show.ai ? 'ai' : show.err ? 'err' : 'mt';
        if (!box || box.dataset.src !== text || box.dataset.kind !== kind) renderTr(span, text, show);
      }
      // 机器翻译照常进行（用来识别客户语言，也是 AI 失败时的兜底）
      if (!c && !pending.has(text)) { pending.add(text); queue.push(text); }
    });
    if (useAi) {
      const chat = getChatName();
      [...new Set(toTranslate)].slice(-AI_IN_RECENT).forEach((t) => aiEnqueue(t, chat));
    }
    // 按对方最新一条消息的语言，自动设定本聊天的回复语言（手动选过的不覆盖）
    const last = lastInText && trCache.get(lastInText);
    const base = last && last.from ? last.from.split('-')[0] : '';
    const name = getChatName();
    if (name && base && base !== 'zh' && LANGS.some(([c]) => c === base) && !settings.chatLangs()[name] &&
        autoLangs[name] !== base) {
      autoLangs[name] = base;
      ui.refresh();
    }
    pump();
  }

  let scanTimer = null;
  new MutationObserver(() => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scanIncoming(); }, 300);
  }).observe(document.body, { childList: true, subtree: true });

  /* ---------------- 悬浮控制条 ---------------- */
  const style = document.createElement('style');
  style.textContent = `
  #wat-bar{position:fixed;z-index:10004;display:none;align-items:center;gap:6px;padding:4px 8px;
    background:#fff;color:#111;border:1px solid #d1d7db;border-radius:16px;font:12px/1.4 system-ui,"Microsoft YaHei",sans-serif;
    box-shadow:0 2px 8px rgba(0,0,0,.12)}
  #wat-bar select{font:inherit;border:1px solid #d1d7db;border-radius:8px;padding:1px 2px;background:#fff;color:#111;max-width:150px}
  #wat-bar label{display:flex;align-items:center;gap:3px;cursor:pointer;white-space:nowrap}
  #wat-bar button{white-space:nowrap;font:inherit;border:0;border-radius:10px;padding:2px 8px;background:#25d366;color:#fff;cursor:pointer}
  #wat-bar button:disabled{opacity:.5;cursor:default}
  #wat-handle{cursor:move;user-select:none;padding:0 2px}
  #wat-bar.mini > :not(#wat-handle):not(#wat-min){display:none !important}
  #wat-bar.in-panel{flex-wrap:wrap;border-radius:0;border:0;border-bottom:1px solid #e9edef;box-shadow:none;padding:8px 14px;box-sizing:border-box}
  #wat-bar.in-panel #wat-handle,#wat-bar.in-panel #wat-min{display:none}
  .wp-slot{flex:none}
  #wat-bar .wat-off{background:#8696a0}
  #wat-toast{position:fixed;z-index:10000;right:16px;bottom:16px;max-width:360px;white-space:pre-wrap;
    background:#111b21;color:#fff;padding:8px 14px;border-radius:10px;font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif;
    box-shadow:0 4px 14px rgba(0,0,0,.25);display:none}
  #wat-toast.err{background:#c62828}
  .wat-tr{direction:ltr;text-align:left;unicode-bidi:plaintext;margin-top:4px;padding-top:4px;border-top:1px dashed rgba(0,0,0,.18);color:#027eb5;font-size:.93em;line-height:1.45;white-space:pre-wrap;word-break:break-word}
  .wat-tr::before{content:"译：";color:#8696a0}
  .wat-tr.wat-tr-err{color:#c62828}
  .wat-tr.wat-tr-ai::before{content:"译(AI)："}
  .wat-lv{display:inline-block;font:500 11px/1.5 system-ui,"Microsoft YaHei",sans-serif;padding:0 6px;border-radius:6px;margin-left:6px;vertical-align:middle}
  .wat-lv.big{font-size:13px;padding:2px 8px;margin-left:0}
  .wat-lv-A{background:#d9fdd3;color:#0b6b3a}.wat-lv-B{background:#dbeefc;color:#0b4f7c}.wat-lv-C{background:#fdf0cc;color:#7a5200}.wat-lv-D{background:#e9edef;color:#54656f}
  html.wat-docked #app{width:calc(100% - var(--wat-pw)) !important;max-width:calc(100% - var(--wat-pw)) !important;overflow:hidden !important}
  html.wat-docked #app > div{width:100% !important;min-width:0 !important}
  #wat-panel{position:fixed;z-index:10002;display:none;flex-direction:column;right:0;top:0;bottom:0;width:var(--wat-pw);box-sizing:border-box;background:#fff;color:#111b21;
    border-left:1px solid #d1d7db;font:13px/1.55 system-ui,"Microsoft YaHei",sans-serif}
  #wat-panel .wp-head{padding:12px 14px 8px;margin:0;border-bottom:1px solid #e9edef}
  #wat-panel .wp-body{flex:1;overflow:auto;padding:10px 14px 16px}
  .wr-draft,.wr-ask{width:100%;box-sizing:border-box;border:1px solid #d1d7db;border-radius:8px;padding:6px 8px;font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif;resize:vertical}
  .wr-thread{max-height:240px;overflow:auto;display:flex;flex-direction:column;gap:6px;margin-bottom:6px}
  .wr-me{align-self:flex-end;background:#d9fdd3;border-radius:8px;padding:4px 8px;max-width:85%}
  .wr-ai{align-self:flex-start;background:#f0f2f5;border-radius:8px;padding:4px 8px;max-width:85%}
  .wr-err{color:#c62828}
  .wr-quick{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}
  #wat-panel button.chip{background:#f0f2f5;color:#3b4a54;border-radius:12px;padding:2px 8px;font-size:11px}
  .wr-input{display:flex;gap:6px;align-items:flex-end}
  #wat-panel button:disabled{opacity:.5;cursor:default}
  #wat-panel button,#wat-settings button{white-space:nowrap;font:inherit;font-size:12px;border:0;border-radius:8px;padding:3px 10px;background:#25d366;color:#fff;cursor:pointer}
  #wat-panel button.sec,#wat-settings button.sec{background:#e9edef;color:#3b4a54}
  .wp-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}.wp-head b{font-size:14px}
  .wp-sub{color:#667781;font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #wat-panel .wp-x,#wat-settings .wp-x{background:none;color:#667781;font-size:18px;padding:0 4px}
  .wp-tags{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
  .wp-tag{display:inline-block;background:#f0f2f5;color:#3b4a54;border-radius:6px;padding:0 6px;font-size:11px}
  .wp-reason{margin-top:6px;color:#3b4a54}
  .wp-sec{margin:12px 0 4px;color:#667781;font-size:12px}
  .wp-known .ok{color:#0b6b3a}.wp-missing{margin-top:4px}.wp-missing .warn{color:#b26a00}
  .wp-sug{border:1px solid #e9edef;border-radius:8px;padding:8px;margin-bottom:8px}
  .wp-goal{color:#667781;font-size:12px}.wp-reply{margin:4px 0;white-space:pre-wrap}.wp-zh{color:#027eb5;font-size:12px}
  .wp-btns{display:flex;gap:6px;margin-top:6px}.wp-foot{display:flex;gap:6px;margin-top:12px;flex-wrap:wrap}
  .wp-muted{color:#8696a0;font-size:12px}
  #wat-settings{position:fixed;inset:0;z-index:10006;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.35)}
  .ws-card{width:520px;max-width:92vw;max-height:88vh;overflow:auto;background:#fff;color:#111b21;border-radius:12px;padding:16px 18px;font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif}
  .ws-card label{display:block;margin:10px 0 4px;color:#3b4a54;font-size:12px}
  .ws-card label.ws-inline{display:flex;align-items:center;gap:6px}
  .ws-card input[type=password],.ws-card input[type=text],.ws-card textarea{width:100%;box-sizing:border-box;border:1px solid #d1d7db;border-radius:8px;padding:6px 8px;font:12px/1.5 system-ui,"Microsoft YaHei",sans-serif;resize:vertical}
  .ws-pb{max-height:220px;overflow:auto;border:1px solid #e9edef;border-radius:8px;padding:4px}
  .ws-pbi{display:flex;gap:6px;align-items:flex-start;padding:4px;border-bottom:1px solid #f0f2f5}
  .ws-pbt{flex:1;font-size:12px}
  .pi-ed .pi-f{display:block;margin:4px 0}.pi-ed .pi-f > span{display:block;font-size:11px;color:#667781}
  .pi-ed .pi-row{display:flex;gap:8px}.pi-ed .pi-f.half{flex:1;min-width:0}
  .pi-in{width:100%;box-sizing:border-box;border:1px solid #d1d7db;border-radius:6px;padding:4px 6px;font:12px/1.4 system-ui,"Microsoft YaHei",sans-serif;background:#fff;color:#111b21;resize:vertical}
  .pi-in.pi-miss{background:#fff4d6;border-color:#e8c46a}
  .pi-item{border:1px solid #e9edef;border-radius:8px;padding:6px 8px;margin-bottom:6px}
  .pi-item-h{display:flex;justify-content:space-between;align-items:center}
  .pi-total{margin:8px 0;padding:6px 10px;background:#0f2a44;color:#fff;border-radius:6px;font-weight:600;text-align:right}
  .pi-actions button{font-size:13px !important;padding:5px 12px !important}
  #wat-pi-modal{position:fixed;inset:0;z-index:10007;display:none;background:rgba(17,27,33,.75);overflow:auto;padding:16px 0}
  #wat-pi-modal .pim-bar{display:flex;justify-content:center;gap:16px;align-items:center;color:#fff;margin-bottom:10px;font:13px system-ui,"Microsoft YaHei",sans-serif}
  #wat-pi-modal .pim-bar button{border:0;border-radius:8px;padding:4px 14px;background:#fff;color:#111b21;cursor:pointer}
  .ws-pi{margin-top:4px}
  .ws-tabs{display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid #e9edef;padding-bottom:8px;margin-bottom:4px}
  #wat-settings button.ws-tab{background:#f0f2f5;color:#3b4a54}#wat-settings button.ws-tab.on{background:#0f2a44;color:#fff}
  .ws-save{position:sticky;bottom:-16px;background:#fff;padding:8px 0}
  #wat-panel button.wp-back{background:#f0f2f5;color:#3b4a54;padding:3px 10px}
  .wp-tabs{display:flex;gap:0;border-bottom:1px solid #e9edef;flex:none;padding:0 14px}
  #wat-panel button.wp-tab{background:none;color:#667781;border-radius:0;padding:8px 14px;font-size:13px;border-bottom:2px solid transparent}
  #wat-panel button.wp-tab.on{color:#0f2a44;font-weight:600;border-bottom-color:#25d366}
  #wat-panel .wp-body.ask{display:flex;flex-direction:column;overflow:hidden;padding-bottom:10px}
  .ask-top{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;flex:none}
  .ask-title{font-weight:600;color:#3b4a54;margin:2px 0 4px;flex:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ask-attach{align-items:center;gap:6px;background:#e7f3ff;color:#0b4f7c;border-radius:8px;padding:4px 8px;margin-bottom:6px;font-size:12px;flex:none}
  .ask-ctx{font-size:11px;color:#3b6b47;margin-bottom:3px}
  .ask-hist{display:flex;align-items:center;gap:6px;border:1px solid #e9edef;border-radius:8px;padding:8px;margin-bottom:6px;cursor:pointer}
  .ask-hist.on{border-color:#25d366;background:#f4fff6}
  .ask-hist-main{flex:1;min-width:0}.ask-hist-t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #wat-panel .ask-hist button.ws-close{color:#8696a0;font-size:12px}
  .ask-thread{flex:1;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:4px 0 8px}
  .ask-me{align-self:flex-end;background:#d9fdd3;border-radius:10px;padding:6px 10px;max-width:88%;white-space:pre-wrap}
  .ask-ai{align-self:flex-start;background:#f0f2f5;border-radius:10px;padding:8px 10px;max-width:94%;white-space:pre-wrap}
  .ask-reply{margin-top:8px;background:#fff;border:1px solid #d1d7db;border-radius:8px;padding:6px 8px}
  .ask-input{display:flex;gap:6px;align-items:flex-end;flex:none;border-top:1px solid #e9edef;padding-top:8px}
  .ask-input textarea{flex:1;box-sizing:border-box;border:1px solid #d1d7db;border-radius:8px;padding:6px 8px;font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif;resize:none}
  .wp-status{padding:6px 14px;border-bottom:1px solid #e9edef;font-size:12px;flex:none}
  .wp-status .ws-line{display:flex;align-items:center;gap:6px;color:#54656f}
  .wp-status .ws-line.ok{color:#0b6b3a}.wp-status .ws-line.busy{color:#027eb5}.wp-status .ws-line.warn{color:#9a6700}
  .wp-status .ws-line.err{color:#c62828;background:#fdecea;border-radius:6px;padding:3px 6px;margin-top:3px}
  #wat-panel button.ws-close{background:none;color:#c62828;padding:0 4px;margin-left:auto;font-size:14px}
  .pi-warn{background:#fff4d6;border:1px solid #e8c46a;border-radius:8px;padding:6px 8px;margin:6px 0;font-size:12px}
  #wat-chip{position:fixed;z-index:10000;display:none;max-width:420px;padding:6px 10px;border-radius:10px;
    font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.2);cursor:pointer;white-space:pre-wrap}
  #wat-chip.wat-chip-btn{background:#25d366;color:#fff}
  #wat-chip.wat-chip-result{background:#fffbe6;color:#111;border:1px solid #e8d48a}
  #wat-chip button{margin-top:4px;font:inherit;border:0;border-radius:8px;padding:2px 8px;background:#25d366;color:#fff;cursor:pointer}
  @media (prefers-color-scheme: dark){
    #wat-bar{background:#202c33;color:#e9edef;border-color:#3b4a54}
    #wat-bar select{background:#2a3942;color:#e9edef;border-color:#3b4a54}
    .wat-tr{color:#53bdeb;border-top-color:rgba(255,255,255,.2)}
  }`;
  document.documentElement.appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'wat-bar';
  bar.innerHTML = `
    <span id="wat-handle" title="按住拖动工具栏；双击恢复默认位置">🌐</span>
    <select id="wat-lang" title="本聊天发送语言（每个聊天单独记忆）">${LANGS.map(([c, n]) => `<option value="${c}">${n}</option>`).join('')}</select>
    <label title="开启后：输入含中文时按回车，自动翻译并发送"><input type="checkbox" id="wat-auto">回车自动翻译发送</label>
    <label title="对方发来的外语消息，在原文下方自动显示中文译文"><input type="checkbox" id="wat-in">对方消息译中文</label>
    <select id="wat-engine" title="发送翻译引擎。AI：结合聊天上下文、说法更地道（需要 DeepSeek Key，失败自动换谷歌）。对方消息的中文译文始终用谷歌/微软"><option value="ai">AI 翻译</option><option value="google">谷歌</option><option value="microsoft">微软</option></select>
    <button id="wat-analyze" title="AI 分析当前客户的级别并给出回复建议" style="background:#027eb5">分析客户</button>
    <button id="wat-set" title="设置（API Key、价格表、话术库）" style="background:#8696a0">⚙</button>
    <button id="wat-go" title="只翻译不发送（快捷键 Ctrl+Enter）">翻译</button>
    <button id="wat-power" title="暂停/启用翻译助手">开</button>
    <button id="wat-min" title="收起/展开工具栏" style="background:#e9edef;color:#3b4a54">–</button>`;
  document.documentElement.appendChild(bar);

  const $ = (id) => bar.querySelector('#' + id);
  const toastEl = document.createElement('div');
  toastEl.id = 'wat-toast';
  document.documentElement.appendChild(toastEl);
  let toastTimer;
  function toast(msg, isErr) {
    try { if (typeof panelNotice === 'function' && panelNotice(msg, isErr)) return; } catch (e) { /* 面板还没初始化 */ }
    toastEl.textContent = msg;
    toastEl.className = isErr ? 'err' : '';
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, isErr ? 5000 : 3000);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const ui = {
    lastChat: null,
    refresh() {
      $('wat-lang').value = getChatLang();
      $('wat-auto').checked = settings.autoSend;
      $('wat-in').checked = settings.autoIn;
      $('wat-in').disabled = !settings.enabled;
      $('wat-engine').value = settings.engine;
      const on = settings.enabled;
      $('wat-power').textContent = on ? '开' : '关';
      $('wat-power').className = on ? '' : 'wat-off';
      $('wat-auto').disabled = !on;
      $('wat-go').disabled = !on || busy;
    },
    setBusy(b) { $('wat-go').disabled = b || !settings.enabled; $('wat-go').textContent = b ? '翻译中…' : '翻译'; },
    position() {
      const slot = document.documentElement.classList.contains('wat-docked') && document.getElementById('wat-barslot');
      if (slot) {
        // 三栏模式：工具栏放在右栏顶部，不挡聊天
        const sr = slot.getBoundingClientRect();
        bar.classList.add('in-panel');
        bar.classList.remove('mini');
        bar.style.display = 'flex';
        bar.style.width = sr.width + 'px';
        bar.style.left = sr.left + 'px';
        bar.style.top = sr.top + 'px';
        const hh = bar.offsetHeight + 'px';
        if (slot.style.height !== hh) slot.style.height = hh;
      } else {
        const footer = document.querySelector('#main footer');
        if (!footer) { bar.style.display = 'none'; return; }
        bar.classList.remove('in-panel');
        bar.classList.toggle('mini', !!store.get('barMin', false));
        bar.style.width = '';
        bar.style.display = 'flex';
        if (dragging) return;
        const pos = store.get('barPos', null);
        let left, top;
        if (pos) {
          left = window.innerWidth - pos.r - bar.offsetWidth;
          top = window.innerHeight - pos.b - bar.offsetHeight;
        } else {
          const r = footer.getBoundingClientRect();
          left = r.right - bar.offsetWidth - 12;
          top = r.top - bar.offsetHeight - 6;
        }
        bar.style.left = Math.min(Math.max(0, left), window.innerWidth - bar.offsetWidth) + 'px';
        bar.style.top = Math.min(Math.max(0, top), window.innerHeight - bar.offsetHeight) + 'px';
      }
      const chat = getChatName();
      if (chat !== ui.lastChat) { ui.lastChat = chat; ui.refresh(); }
    },
  };

  $('wat-lang').addEventListener('change', (e) => { setChatLang(e.target.value); toast('本聊天发送语言：' + e.target.value.toUpperCase()); });
  $('wat-auto').addEventListener('change', (e) => { settings.autoSend = e.target.checked; });
  $('wat-in').addEventListener('change', (e) => { settings.autoIn = e.target.checked; scanIncoming(); });
  $('wat-engine').addEventListener('change', (e) => { settings.engine = e.target.value; msToken = null; });
  $('wat-go').addEventListener('click', () => translateInput(false));
  $('wat-analyze').addEventListener('click', () => analyzeCurrent(false));
  $('wat-set').addEventListener('click', () => openSettings());
  $('wat-power').addEventListener('click', () => { settings.enabled = !settings.enabled; ui.refresh(); scanIncoming(); toast(settings.enabled ? '翻译助手已启用' : '翻译助手已暂停'); });


  /* ======================================================================
   *  客户分析（DeepSeek）
   * ==================================================================== */
  const DEFAULT_BIZ = '我们是奇瑞威麟（Chery RELY）汽车出口经销商。主要市场：中美洲和加勒比（伯利兹、多米尼加、巴拿马、洪都拉斯、萨尔瓦多、尼加拉瓜、阿鲁巴、库拉索等）。主推车型：R8 等。客户既有个人买家，也有当地经销商。广告里不写价格，引导客户私信询价。';
  const DEFAULT_RULES = [
    'A 马上成交：1～2 周内可能下单。信号：问了具体车型、价格、运到当地的落地价、付款方式、交期；给了收货地址或公司信息；主动说要付款/定车。',
    'B 有明确需求：在比价，需要跟进。信号：问了车型和价格，但没谈付款和时间；或经销商在问批量价、合作条件。',
    'C 初步了解：刚看完广告来问问。信号：只发了 "Price?"、"More info" 之类，没有回答我方追问。',
    'D 无效：同行、骚扰、明显买不起、答非所问，或很久不回复。',
  ].join('\n');
  const SEED_PLAYBOOK = [
    ['首次咨询', "Hi! Thanks for your interest in the Chery RELY. To give you the best price, may I know which country you're in and whether it's for personal use or for your business?"],
    ['首次咨询', "Hello! Thanks for reaching out 😊 Which model are you interested in, and which city would you like it delivered to?"],
    ['只问价格', "Good question! The price depends on the version and the delivery port. Which version do you prefer and which city are you in? Then I can send you an accurate landed price."],
    ['只问价格', "Sure! Before I send the quote — are you looking for 1 unit or more? We have special pricing for dealers and fleet orders."],
    ['嫌贵/比价', "I understand, it's smart to compare. Which model and version are you comparing with? Specs can differ a lot, and I want you to compare like for like."],
    ['嫌贵/比价', "Thanks for being honest. What price did you get elsewhere? Let me check what I can do for you."],
    ['运费/落地价', "We can ship to your nearest port. Which port or city works best for you? I'll calculate the landed cost for you."],
    ['付款', "Which payment method works best for you? Once I know, I'll prepare the details for you."],
    ['经销商合作', "Thanks! We're looking for partners in your area. Could you tell me a bit about your business — do you have a showroom, and how many cars do you sell per month?"],
    ['经销商合作', "For dealer orders we can offer wholesale pricing and spare parts support. How many units are you planning for the first order?"],
    ['不回复跟进-第1天', "Hi! Just checking if you received the info about the car? Happy to answer any questions 😊"],
    ['不回复跟进-第3天', "Hi! We're planning the next shipment. Would you like me to keep a unit for you?"],
    ['不回复跟进-第7天', "Hi, I don't want to bother you — just let me know if you're still interested, or if the timing isn't right. I'm happy to help anytime."],
    ['推进成交', "To prepare your proforma invoice, I just need your full name, city and the version/color you prefer. Shall we go ahead?"],
    ['推进成交', "Would you like a quick video call? I can show you the car in detail."],
  ];
  const PANEL_W = 400;

  const ai = {
    get apiKey() { return store.get('dsKey', ''); },
    set apiKey(v) { store.set('dsKey', v); },
    get biz() { return store.get('bizInfo', DEFAULT_BIZ); },
    set biz(v) { store.set('bizInfo', v); },
    get prices() { return store.get('priceTable', ''); },
    set prices(v) { store.set('priceTable', v); },
    get rules() { return store.get('gradeRules', DEFAULT_RULES); },
    set rules(v) { store.set('gradeRules', v); },
    get autoLabel() { return store.get('autoLabel', true); },
    set autoLabel(v) { store.set('autoLabel', v); },
    playbook() {
      let pb = store.get('playbook', null);
      if (!pb) {
        pb = SEED_PLAYBOOK.map(([scene, text], i) => ({ id: 'seed' + i, scene, text, seed: true, at: 0 }));
        store.set('playbook', pb);
      }
      // 旧版种子里那条带"[按实际付款方式修改]"的付款话术，换成不预设条件的问法
      const old = pb.find((p) => p.id === 'seed7' && /\[按实际/.test(p.text));
      if (old) { old.text = SEED_PLAYBOOK[7][1]; store.set('playbook', pb); }
      return pb;
    },
    savePlaybook(pb) { store.set('playbook', pb); },
    analyses() { return store.get('analyses', {}); },
    saveAnalysis(name, result, fp) {
      const all = ai.analyses();
      all[name] = { level: result.level, result, at: Date.now(), fp: fp || '' };
      store.set('analyses', all);
    },
  };
  const LEVEL_NAME = { A: '马上成交', B: '有需求', C: '了解中', D: '无效' };

  // 读取当前聊天记录（只读已加载到页面上的消息）
  function readConversation(maxMsgs) {
    const main = document.querySelector('#main');
    if (!main) return [];
    const mainRect = main.getBoundingClientRect();
    const out = [];
    main.querySelectorAll('[data-testid^="conv-msg-"], .message-in, .message-out').forEach((row) => {
      if (row.parentElement && row.parentElement.closest('[data-testid^="conv-msg-"]')) return;
      const incoming = isIncoming(row, mainRect);
      const span = getMsgTextSpan(row);
      const pre = row.querySelector('.copyable-text[data-pre-plain-text]');
      const time = pre ? (pre.getAttribute('data-pre-plain-text').match(/^\[([^\]]+)\]/) || [])[1] || '' : '';
      let text = span ? (span.innerText || '').trim() : '';
      if (!text) {
        if (row.querySelector('img[src^="blob:"], [data-icon*="image"]')) text = '[图片]';
        else if (row.querySelector('[data-icon*="audio"], [data-icon*="ptt"], audio')) text = '[语音]';
        else if (row.querySelector('[data-icon*="video"], video')) text = '[视频]';
        else if (row.querySelector('[data-icon*="document"], [data-icon*="doc"]')) text = '[文件]';
        else return;
      }
      out.push({ from: incoming ? '客户' : '我方', time, text: text.slice(0, 1200) });
    });
    return out.slice(-(maxMsgs || 60));
  }

  // 公共背景：业务、分级标准、价格与条款、话术库、硬规则
  function baseContext() {
    const pb = ai.playbook().filter((p) => !/\[[^\]]*\]/.test(p.text)); // 带方括号备注的话术不交给 AI
    const pbSorted = pb.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 40);
    const prices = ai.prices.trim();
    return [
      '你是一名资深的外贸汽车销售顾问，帮助中国经销商处理 WhatsApp 客户。',
      '【我方业务】\n' + ai.biz,
      '【客户分级标准】\n' + ai.rules,
      '【价格表与交易条款】\n' + (prices || '（暂无。）'),
      '【话术库（参考风格和推进思路，可改写）】\n' + pbSorted.map((p) => '- [' + p.scene + '] ' + p.text).join('\n'),
      '【硬规则】',
      '- 价格、优惠、付款方式、定金比例、交期、船期、库存、质保等具体条件，只能来自上面的【我方业务】和【价格表与交易条款】，或者聊天记录里我方已经说过的内容。没有依据的一律不要写，改为向客户提问或说明会尽快确认。',
      '- 回复用客户使用的语言，像 WhatsApp 聊天一样简短自然。',
    ].join('\n\n');
  }
  function convText(conv, chatName) {
    return '客户：' + (chatName || '未知') + '\n聊天记录（按时间顺序）：\n' +
      conv.map((m) => (m.time ? '[' + m.time + '] ' : '') + m.from + '：' + m.text).join('\n');
  }

  function buildPrompt(conv, chatName) {
    const system = baseContext() + '\n\n' + [
      '【本次任务：分析客户并给出回复建议】',
      '1. 只根据聊天内容判断，没提到的信息填"未知"，不要猜。',
      '2. 只给 1 条你认为此刻最合适的建议回复（不超过 60 个单词），要推进一个具体目标：补齐缺失信息、消除顾虑或推进成交。如果最后一条是我方发的、客户还没回，就给跟进话术。',
      '2.1 建议必须接着聊天的最新进展往下走：客户已经回答过的问题不要再问，我方已经发过的话不要重复或换个说法再发；最重要的是回应客户最新的一条消息。',
      '3. 只输出 JSON，不要任何其他文字。格式：',
      '{"level":"A|B|C|D","customer_type":"个人|经销商|未知","language":"客户语言，如 English/Español",' +
        '"reason":"一句话中文理由","known":{"国家":"","车型":"","数量":"","预算":"","付款方式":"","购买时间":""},' +
        '"missing":["还缺的关键信息，中文"],"suggestions":[{"scene":"场景，中文","goal":"这条回复的目的，中文","reply":"客户语言的回复原文","reply_zh":"中文意思"}],' +
        '"next_followup":{"when":"建议跟进时间，如 明天上午","action":"中文，跟进做什么"}}',
    ].join('\n');
    return { system, user: convText(conv, chatName) };
  }

  // opts.json=false：普通文字回答（AI 助手用）；默认要求 JSON
  function deepSeekOnce(messages, maxTokens, json, timeout) {
    return new Promise((resolve, reject) => {
      const body = { model: 'deepseek-chat', messages, temperature: json ? 0.4 : 0.3, max_tokens: maxTokens || 1500 };
      if (json) body.response_format = { type: 'json_object' };
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.deepseek.com/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ai.apiKey },
        data: JSON.stringify(body),
        timeout: timeout || 120000,
        onload: (r) => {
          if (r.status === 401) return reject(new Error('API Key 不正确，请在设置里检查'));
          if (r.status === 402) return reject(new Error('DeepSeek 账户余额不足，请充值'));
          if (r.status === 429) return reject(new Error('请求太频繁，请稍等几秒再试'));
          if (r.status < 200 || r.status >= 300) return reject(new Error('DeepSeek 返回错误 HTTP ' + r.status));
          try {
            const data = JSON.parse(r.responseText);
            resolve({ txt: String((data.choices[0].message && data.choices[0].message.content) || ''), finish: data.choices[0].finish_reason });
          } catch (e) { reject(new Error('DeepSeek 返回的数据格式不对')); }
        },
        onerror: () => reject(new Error('连不上 DeepSeek，请检查网络')),
        ontimeout: () => reject(new Error('DeepSeek 响应超时，请重试')),
      });
    });
  }
  function parseJsonLoose(txt) {
    const t = String(txt || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(t); } catch (e) { /* 继续尝试 */ }
    const m = t.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e) { /* ignore */ } }
    return null;
  }
  async function callDeepSeek(messages, maxTokens, opts) {
    const json = !(opts && opts.json === false);
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) { // 偶尔返回空内容或格式不对，自动重试一次
      const { txt, finish } = await deepSeekOnce(messages, maxTokens, json, opts && opts.timeout);
      if (!json) {
        if (txt.trim()) return { text: txt, raw: txt, truncated: finish === 'length' };
        lastErr = new Error('AI 没有返回内容，请重试');
        continue;
      }
      const obj = parseJsonLoose(txt);
      if (obj) return { json: obj, raw: txt };
      lastErr = new Error(finish === 'length' ? 'AI 回答太长被截断了，请把问题拆小一点' : 'AI 返回的内容无法解析，请重试');
    }
    throw lastErr;
  }


  function normalizeResult(r) {
    r = r || {};
    const lv = String(r.level || '').trim().toUpperCase().charAt(0);
    r.level = 'ABCD'.includes(lv) && lv ? lv : 'C';
    r.known = r.known && typeof r.known === 'object' ? r.known : {};
    r.missing = Array.isArray(r.missing) ? r.missing : [];
    r.suggestions = Array.isArray(r.suggestions) ? r.suggestions.filter((s) => s && s.reply).slice(0, 1) : [];
    r.next_followup = r.next_followup || {};
    return r;
  }

  /* ---------- 自动加入 WhatsApp Business 列表（A/B/C/D） ---------- */
  // 聊天顶部的「添加到列表」按钮；加过列表后它会显示列表名（如「A 马上成交」）
  function findListButton() {
    const cands = [...document.querySelectorAll('#main header [role="button"], #main header button')];
    return cands.find((b) => /添加到列表|加入列表|Add to list|列表|list/i.test(b.getAttribute('aria-label') || '')) ||
      cands.find((b) => /^\s*[ABCD](\s|级)/.test(b.innerText || ''));
  }
  const menuEl = () => document.querySelector('[role="menu"]');
  async function openListMenu() {
    const btn = findListButton();
    if (!btn) return null;
    if (!menuEl()) btn.click();
    for (let i = 0; i < 15; i++) {
      await sleep(100);
      const m = menuEl();
      if (m && m.querySelector('[role="menuitemcheckbox"]')) return m;
    }
    return null;
  }
  // 关闭菜单：绝不发送 Esc 键（WhatsApp 里 Esc 会把整个聊天关掉）。
  // 先在插件自己的面板上模拟一次"点外面"，不行再点一次列表按钮把菜单收起。
  async function closeMenu() {
    for (let i = 0; i < 2 && menuEl(); i++) {
      if (i === 0) {
        const t = panel && panel.isConnected ? panel : document.documentElement;
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
          try { t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })); } catch (e) { /* ignore */ }
        });
      } else {
        const btn = findListButton();
        if (btn) btn.click();
      }
      for (let k = 0; k < 6 && menuEl(); k++) await sleep(80);
    }
  }
  const levelOfItem = (li) => {
    const m = (li.innerText || '').trim().match(/^([ABCD])(?:\s|级|$)/i);
    return m ? m[1].toUpperCase() : null;
  };
  // chatName：开始时的聊天；中途发现切换了聊天就立即停止，避免标错人
  async function applyLevelList(level, chatName) {
    const stillSame = () => getChatName() === chatName;
    const switched = { ok: false, msg: '聊天已切换，已停止加入列表，请回到该客户重新分析' };
    for (let round = 0; round < 4; round++) {
      if (!stillSame()) { await closeMenu(); return switched; }
      const menu = await openListMenu();
      if (!menu) return { ok: false, msg: '没找到「添加到列表」按钮，请手动加入列表' };
      if (!stillSame()) { await closeMenu(); return switched; }
      const items = () => [...(menuEl() || menu).querySelectorAll('[role="menuitemcheckbox"]')].filter(levelOfItem);
      if (!items().length) { await closeMenu(); return { ok: false, msg: '没找到 A/B/C/D 列表，请先在 WhatsApp 里建好' }; }
      const isWrong = (li) => (levelOfItem(li) === level) !== (li.getAttribute('aria-checked') === 'true');
      // 菜单开着的时候，把需要改的项依次点掉（菜单如果点一下就自动关了，就下一轮再开）
      let clicked = 0;
      while (menuEl() && clicked < 5) {
        const wrong = items().find(isWrong);
        if (!wrong) break;
        wrong.click();
        clicked++;
        await sleep(400);
      }
      if (menuEl()) {
        const done = !items().find(isWrong);
        await closeMenu();
        if (done) return { ok: true };
      }
      await sleep(300);
    }
    await closeMenu();
    return { ok: false, msg: '加入列表没有成功，请手动加入' };
  }

  /* ---------- 右侧第三栏 ---------- */
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'style') el.style.cssText = attrs[k];
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), attrs[k]);
      else el.setAttribute(k, attrs[k]);
    }
    kids.flat().forEach((c) => { if (c != null && c !== false) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  };

  const panel = h('div', { id: 'wat-panel' });
  document.documentElement.appendChild(panel);
  const PANEL_W_WIDE = 650;
  const applyPanelWidth = () => document.documentElement.style.setProperty('--wat-pw', (store.get('panelWide', false) ? PANEL_W_WIDE : PANEL_W) + 'px');
  applyPanelWidth();
  let panelChat = '';
  let panelView = 'result'; // result | refine

  function dock(on) {
    const was = document.documentElement.classList.contains('wat-docked');
    document.documentElement.classList.toggle('wat-docked', on);
    panel.style.display = on ? 'flex' : 'none';
    store.set('docked', on); // 记住三栏状态，下次打开 WhatsApp 自动恢复
    if (was !== on) window.dispatchEvent(new Event('resize'));
    ui.position();
  }

  function showPanel(content, title) {
    panel.innerHTML = '';
    const sub = panelView === 'refine' || panelView === 'pi';
    panel.appendChild(h('div', { class: 'wp-head' },
      sub ? h('button', { class: 'wp-back', title: '返回客户分析', onclick: backToResult }, '← 返回') : null,
      h('b', null, title || '客户分析'),
      h('span', { class: 'wp-sub' }, panelView === 'ask' ? '' : panelChat),
      h('button', { class: 'wp-x', title: '关闭整个右栏', onclick: () => dock(false) }, '×')));
    panel.appendChild(h('div', { class: 'wp-slot', id: 'wat-barslot' }));
    if (!sub) {
      lastTab = panelView === 'ask' ? 'ask' : 'result';
      panel.appendChild(h('div', { class: 'wp-tabs' },
        h('button', { class: 'wp-tab' + (lastTab === 'result' ? ' on' : ''), onclick: () => { if (panelView !== 'result') backToResult(); } }, '客户分析'),
        h('button', { class: 'wp-tab' + (lastTab === 'ask' ? ' on' : ''), onclick: () => { if (panelView !== 'ask') openAsk(); } }, 'AI 助手')));
    }
    panel.appendChild(statusEl);
    panel.appendChild(h('div', { class: 'wp-body' + (panelView === 'ask' ? ' ask' : '') }, content));
    renderStatus();
    dock(true);
  }

  /* ---------- 右栏顶部状态行（分析状态 + 提示，替代盖住聊天的弹窗） ---------- */
  const statusEl = h('div', { class: 'wp-status' });
  let statusText = '', statusKind = '';
  let notice = null, noticeTimer = null;
  function setStatus(text, kind) { statusText = text || ''; statusKind = kind || ''; renderStatus(); }
  function renderStatus() {
    statusEl.innerHTML = '';
    if (statusText) statusEl.appendChild(h('div', { class: 'ws-line ' + statusKind }, statusText));
    if (notice) {
      statusEl.appendChild(h('div', { class: 'ws-line ' + (notice.err ? 'err' : 'ok') }, notice.msg,
        notice.err ? h('button', { class: 'ws-close', title: '知道了', onclick: () => { notice = null; renderStatus(); } }, '×') : null));
    }
    statusEl.style.display = statusEl.firstChild ? '' : 'none';
  }
  // 三栏打开时，提示显示在右栏顶部；成功类提示 4 秒后消失，错误要手动关掉
  function panelNotice(msg, isErr) {
    if (!document.documentElement.classList.contains('wat-docked') || panel.style.display === 'none') return false;
    notice = { msg, err: !!isErr };
    clearTimeout(noticeTimer);
    if (!isErr) noticeTimer = setTimeout(() => { notice = null; renderStatus(); }, 4000);
    renderStatus();
    return true;
  }

  /* ---------- 对话指纹：判断分析之后对话有没有新内容 ---------- */
  function convFingerprint() {
    const conv = readConversation(6);
    return conv.map((m) => m.from + '|' + m.time + '|' + m.text.slice(0, 80)).join('\n');
  }
  function chatScroller() {
    const any = document.querySelector('#main [data-testid^="conv-msg-"], #main .message-in, #main .message-out');
    let el = any && any.parentElement;
    while (el && el !== document.body) {
      const st = getComputedStyle(el);
      if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 10) return el;
      el = el.parentElement;
    }
    return null;
  }
  // 只有聊天停在最底部时才认为看到的是最新消息（往上翻历史时不触发）
  function atBottom() {
    const sc = chatScroller();
    return !sc || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 300;
  }
  const fmtTime = (ts) => new Date(ts).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  async function fillInput(text) {
    const el = getInput();
    if (!el) { toast('请先打开聊天', true); return; }
    if (await replaceInputText(el, String(text))) { lastTranslated = getInputText(el); el.focus(); toast('已填入输入框，检查后按回车发送'); }
    else toast('填入失败，请手动复制', true);
  }
  function savePb(text, zh, scene, level, btn) {
    const pb = ai.playbook();
    if (pb.some((p) => p.text === text)) { toast('话术库里已经有这条了'); return; }
    pb.push({ id: 'u' + Date.now(), scene: scene || '自定义', text, zh: zh || '', level: level || '', at: Date.now() });
    ai.savePlaybook(pb);
    if (btn) btn.textContent = '已收藏';
    toast('已收藏到话术库（共 ' + pb.length + ' 条）');
  }

  function renderResult(r, at) {
    const box = h('div', null);
    box.appendChild(h('div', { class: 'wp-tags' },
      h('span', { class: 'wat-lv wat-lv-' + r.level + ' big' }, r.level + ' ' + LEVEL_NAME[r.level]),
      r.customer_type ? h('span', { class: 'wp-tag' }, String(r.customer_type)) : null,
      r.language ? h('span', { class: 'wp-tag' }, String(r.language)) : null));
    if (r.reason) box.appendChild(h('div', { class: 'wp-reason' }, String(r.reason)));

    const known = Object.entries(r.known).filter(([, v]) => v && !/^未知|unknown$/i.test(String(v).trim()));
    box.appendChild(h('div', { class: 'wp-sec' }, '已知信息'));
    box.appendChild(h('div', { class: 'wp-known' }, known.length
      ? known.map(([k, v]) => h('div', null, h('span', { class: 'ok' }, '✓ '), k + '：' + v))
      : h('div', { class: 'wp-muted' }, '暂无')));
    if (r.missing.length) {
      box.appendChild(h('div', { class: 'wp-missing' }, h('span', { class: 'warn' }, '？ '), '还缺：' + r.missing.join('、')));
    }

    box.appendChild(h('div', { class: 'wp-sec' }, '建议回复'));
    if (!r.suggestions.length) box.appendChild(h('div', { class: 'wp-muted' }, 'AI 没有给出建议，请重试'));
    r.suggestions.forEach((s) => {
      const saveBtn = h('button', { class: 'sec', onclick: () => savePb(s.reply, s.reply_zh, s.scene, r.level, saveBtn) }, '☆ 收藏');
      const altBtn = h('button', { class: 'sec', onclick: () => anotherSuggestion(s, r, altBtn) }, '↻ 换一条');
      box.appendChild(h('div', { class: 'wp-sug' },
        h('div', { class: 'wp-goal' }, (s.scene ? '【' + s.scene + '】' : '') + (s.goal || '')),
        h('div', { class: 'wp-reply' }, String(s.reply)),
        s.reply_zh ? h('div', { class: 'wp-zh' }, '中文：' + s.reply_zh) : null,
        h('div', { class: 'wp-btns' },
          h('button', { onclick: () => fillInput(s.reply) }, '填入'),
          h('button', { class: 'sec', onclick: () => openRefine(s, r) }, '✎ 和 AI 改一改'),
          altBtn, saveBtn)));
    });

    const nf = r.next_followup || {};
    if (nf.when || nf.action) {
      box.appendChild(h('div', { class: 'wp-sec' }, '下一步'));
      box.appendChild(h('div', null, '⏰ ' + [nf.when, nf.action].filter(Boolean).join(' · ')));
    }
    box.appendChild(h('div', { class: 'wp-foot' },
      h('button', { onclick: () => openPI(false) }, '📄 生成 PI'),
      h('button', { class: 'sec', onclick: () => openRefine({ reply: '', reply_zh: '', scene: '自定义' }, r) }, '✎ 让 AI 写一条'),
      h('button', { class: 'sec', onclick: saveMyLastMessage }, '☆ 收藏我发的最后一条'),
      h('button', { class: 'sec', onclick: () => analyzeCurrent(true) }, '重新分析')));
    if (at) box.appendChild(h('div', { class: 'wp-muted', style: 'margin-top:6px' }, '分析时间：' + new Date(at).toLocaleString()));
    return box;
  }

  /* ---------- 和 AI 多轮修改话术 ---------- */
  function openRefine(sug, result) {
    panelView = 'refine';
    const chatName = getChatName();
    const conv = readConversation(40);
    const lang = (result && result.language) || '客户使用的语言';
    const system = baseContext() + '\n\n' + [
      '【本次任务：和销售一起修改一条准备发给客户的 WhatsApp 回复】',
      '- 销售会给出当前草稿（可能为空）和中文修改要求，你按要求改写。草稿里销售手动改过的内容要保留，除非要求里说要改。',
      '- 回复语言：' + lang + '。简短自然，像真人聊天。',
      '- 只输出 JSON：{"reply":"客户语言的回复","reply_zh":"中文意思","note":"这次改了什么，一句中文"}',
      '',
      convText(conv, chatName),
    ].join('\n');
    const history = [{ role: 'system', content: system }];
    let draftZh = sug.reply_zh || '';

    const draft = h('textarea', { class: 'wr-draft', rows: '5', placeholder: '还没有草稿。在下面告诉 AI 想写什么，比如：告诉客户下周有船，问他要不要先付定金锁车' });
    draft.value = sug.reply || '';
    const zhLine = h('div', { class: 'wp-zh' }, draftZh ? '中文：' + draftZh : '');
    const thread = h('div', { class: 'wr-thread' });
    const ask = h('textarea', { class: 'wr-ask', rows: '2', placeholder: '告诉 AI 怎么改，比如：语气热情一点 / 改短一点 / 加上可以视频看车（Enter 发送，Shift+Enter 换行）' });
    const sendBtn = h('button', null, '发送');
    const quick = ['更热情一点', '更简短', '更专业正式', '加一个问题推进成交', '换个说法'];

    async function send(textOverride) {
      const req = (textOverride || ask.value).trim();
      if (!req) { ask.focus(); return; }
      if (!ai.apiKey) { toast('请先在 ⚙ 设置里填写 DeepSeek API Key', true); return; }
      ask.value = '';
      thread.appendChild(h('div', { class: 'wr-me' }, req));
      const wait = h('div', { class: 'wr-ai wp-muted' }, 'AI 正在修改…');
      thread.appendChild(wait);
      thread.scrollTop = thread.scrollHeight;
      sendBtn.disabled = true;
      history.push({ role: 'user', content: '当前草稿：\n' + (draft.value.trim() || '（空）') + '\n\n修改要求：' + req });
      try {
        const { json, raw } = await callDeepSeek(history, 800);
        if (!json.reply) throw new Error('AI 没有给出新草稿，请换个说法再试');
        history.push({ role: 'assistant', content: raw });
        draft.value = String(json.reply);
        draftZh = String(json.reply_zh || '');
        zhLine.textContent = draftZh ? '中文：' + draftZh : '';
        wait.className = 'wr-ai';
        wait.textContent = '✓ ' + (json.note || '已修改') ;
      } catch (e) {
        if (history[history.length - 1].role === 'user') history.pop();
        wait.className = 'wr-ai wr-err';
        wait.textContent = '失败：' + e.message;
      } finally {
        sendBtn.disabled = false;
        thread.scrollTop = thread.scrollHeight;
      }
    }
    sendBtn.addEventListener('click', () => send());
    ask.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
    });

    const saveBtn = h('button', { class: 'sec', onclick: () => {
      if (!draft.value.trim()) { toast('草稿是空的', true); return; }
      savePb(draft.value.trim(), draftZh, sug.scene || '自定义', result && result.level, saveBtn);
    } }, '☆ 收藏');

    const box = h('div', { class: 'wr' },
      h('div', { class: 'wp-sec', style: 'margin-top:0' }, '草稿（可以直接手改）'),
      draft, zhLine,
      h('div', { class: 'wp-btns' },
        h('button', { onclick: () => { if (draft.value.trim()) fillInput(draft.value.trim()); else toast('草稿是空的', true); } }, '填入聊天'),
        saveBtn,
        h('button', { class: 'sec', onclick: backToResult }, '← 返回分析')),
      h('div', { class: 'wp-sec' }, '和 AI 对话修改'),
      thread,
      h('div', { class: 'wr-quick' }, quick.map((q) => h('button', { class: 'chip', onclick: () => send(q) }, q))),
      h('div', { class: 'wr-input' }, ask, sendBtn));
    showPanel(box, '修改话术');
    (draft.value ? ask : ask).focus();
  }

  function backToResult() {
    panelView = 'result';
    lastTab = 'result';
    if (!getChatName()) { panelChat = ''; setStatus(''); showPanel(h('div', { class: 'wp-muted', style: 'padding:24px 0;text-align:center' }, '打开一个客户聊天，这里会显示分析')); return; }
    panelChat = getChatName();
    const saved = ai.analyses()[getChatName()];
    if (saved) {
      showPanel(renderResult(normalizeResult(saved.result), saved.at));
      staleStatus(saved);
    } else { setStatus(''); showNotAnalyzed(); }
  }

  function showNotAnalyzed() {
    panelView = 'result';
    showPanel(h('div', { style: 'padding:24px 0;text-align:center' },
      h('div', { class: 'wp-muted', style: 'margin-bottom:10px' }, '这个客户还没有分析'),
      h('button', { onclick: () => analyzeCurrent(true) }, '分析客户'), ' ',
      h('button', { class: 'sec', onclick: () => openPI(false) }, '📄 生成 PI')));
  }

  function saveMyLastMessage() {
    const mine = readConversation(80).filter((m) => m.from === '我方' && !/^\[(图片|语音|视频|文件)\]$/.test(m.text));
    const last = mine[mine.length - 1];
    if (!last) { toast('这个聊天里没有找到你发的文字消息', true); return; }
    const rec = ai.analyses()[getChatName()];
    savePb(last.text, '', '我的回复', rec ? rec.level : '');
  }

  let analyzing = false;
  let pendingLabel = null; // 级别变了但用户正在输入，等输入框清空再更新列表
  // force：强制重新分析；auto：对话有新消息时自动触发
  async function analyzeCurrent(force, auto) {
    const name = getChatName();
    if (!document.querySelector('#main') || !name) { toast('请先打开一个聊天', true); return; }
    panelChat = name;
    panelView = 'result';
    if (!ai.apiKey) {
      showPanel(h('div', null, h('p', null, '还没有填写 DeepSeek API Key。'), h('button', { onclick: () => openSettings() }, '打开设置')));
      return;
    }
    const saved = ai.analyses()[name];
    const fp = convFingerprint();
    if (saved && !force && saved.fp === fp) {
      showPanel(renderResult(normalizeResult(saved.result), saved.at));
      setStatus('对话没有新内容，这已是最新分析（' + fmtTime(saved.at) + '）', 'ok');
      return;
    }
    if (analyzing) return;
    const conv = readConversation(60);
    if (!conv.length) { toast('这个聊天里没有可分析的文字消息', true); return; }
    analyzing = true;
    if (saved) {
      // 已有旧结果：先留着旧内容，顶部提示正在更新，不清空页面
      if (!panel.querySelector('.wp-tags')) showPanel(renderResult(normalizeResult(saved.result), saved.at));
      setStatus(auto ? '对话有新消息，正在重新分析…' : '正在重新分析…', 'busy');
    } else {
      showPanel(h('div', { class: 'wp-muted', style: 'padding:20px 0;text-align:center' }, '正在分析 ' + conv.length + ' 条消息…'));
      setStatus('正在分析…', 'busy');
    }
    const prevLevel = saved && saved.level;
    try {
      const { system, user } = buildPrompt(conv, name);
      const r = normalizeResult((await callDeepSeek([{ role: 'system', content: system }, { role: 'user', content: user }])).json);
      ai.saveAnalysis(name, r, fp);
      const last = conv[conv.length - 1];
      if (getChatName() === name && panelView === 'result') {
        showPanel(renderResult(r, Date.now()));
        setStatus('已是最新分析（' + fmtTime(Date.now()) + (last ? '，最新：' + last.from + (last.time ? ' ' + last.time.split(',')[0] : '') : '') + '）' +
          (prevLevel && prevLevel !== r.level ? '　级别 ' + prevLevel + ' → ' + r.level : ''), 'ok');
      } else if (getChatName() === name) {
        setStatus('分析已更新，返回分析页查看', 'ok');
      }
      // 列表标签：级别没变就不动；用户正在输入时延后，避免打断打字
      if (ai.autoLabel && getChatName() === name && (!auto || prevLevel !== r.level)) {
        const el = getInput();
        if (el && getInputText(el)) pendingLabel = { name, level: r.level };
        else {
          let res;
          try { res = await applyLevelList(r.level, name); } catch (e) { res = { ok: false, msg: '加入列表出错：' + e.message + '，请手动加入' }; }
          if (!res.ok) toast(res.msg, true);
          else if (prevLevel !== r.level) toast('已加入列表「' + r.level + ' ' + LEVEL_NAME[r.level] + '」');
        }
      }
    } catch (e) {
      if (getChatName() === name && !saved) showPanel(h('div', null, h('p', { style: 'color:#c62828' }, '分析失败：' + e.message), h('button', { onclick: () => analyzeCurrent(true) }, '重试')));
      setStatus('');
      toast('分析失败：' + e.message, true);
    } finally {
      analyzing = false;
    }
  }

  let lastTab = 'result';

  /* ---------- 换一条建议 ---------- */
  async function anotherSuggestion(s, r, btn) {
    const name = getChatName();
    if (!ai.apiKey) { toast('请先在 ⚙ 设置里填写 DeepSeek API Key', true); return; }
    const old = btn.textContent; btn.disabled = true; btn.textContent = '生成中…';
    try {
      const { system, user } = buildPrompt(readConversation(60), name);
      const { json } = await callDeepSeek([
        { role: 'system', content: system },
        { role: 'user', content: user },
        { role: 'user', content: '换一个思路，重新给 1 条建议回复，不要和这条相同或相近：\n' + s.reply +
          '\n只输出 JSON：{"scene":"场景，中文","goal":"目的，中文","reply":"客户语言的回复","reply_zh":"中文意思"}' },
      ], 600);
      const ns = json && (json.reply ? json : (json.suggestions && json.suggestions[0]));
      if (!ns || !ns.reply) throw new Error('AI 没有给出新的建议，请再试一次');
      const all = ai.analyses();
      if (all[name]) {
        all[name].result.suggestions = [ns];
        store.set('analyses', all);
        if (getChatName() === name && panelView === 'result') showPanel(renderResult(normalizeResult(all[name].result), all[name].at));
      }
    } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = old; }
  }

  /* ---------- AI 助手（独立对话，和客户无关；像豆包 / DeepSeek App） ---------- */
  const chats = {
    all() { return store.get('aiChats', []); },
    save(list) { store.set('aiChats', list.slice(-50)); },
    get(id) { return chats.all().find((c) => c.id === id); },
    put(chat) { const l = chats.all().filter((c) => c.id !== chat.id); l.push(chat); chats.save(l); },
    remove(id) { chats.save(chats.all().filter((c) => c.id !== id)); },
    get currentId() { return store.get('aiCurrent', ''); },
    set currentId(v) { store.set('aiCurrent', v); },
  };
  let askMode = 'chat'; // chat | history
  function assistantSystem() {
    const prices = ai.prices.trim();
    return [
      '你是一个通用 AI 助手，像豆包、DeepSeek 一样，什么问题都可以回答。',
      '【用户背景，仅在问题和他的生意有关时参考；不要因为这个背景去改变任何原文的意思】他是中国汽车出口经销商。' + ai.biz + (prices ? '\n他的价格表与交易条款：' + prices : ''),
      '【回答规则】',
      '1. 严格按用户这句话的要求回答，只做他让你做的事，不要自作主张给销售建议、不要主动替他写回复。',
      '2. 用户只粘贴了一段文字、没说要做什么时：如果是外语，就翻译成中文；如果是中文，就简要概括。然后用一句话问他需要怎么处理。不要分析、不要给建议。',
      '2.1 翻译时必须忠实原文：逐句翻译，严格保留人称和谁对谁做什么（I/you/we、给/要、问/答），不要根据上下文或常识去猜测、"纠正"或改写意思。原文有歧义或语病时，照字面翻译，再用一句话单独注明可能的其他理解。',
      '2.2 用户说你翻译错了时，先逐句对照原文检查哪里错了、说明错在哪，再给出改正后的译文；不要只是换个说法重复。',
      '3. 默认用中文回答；先给结论，简洁实用。不要使用 Markdown 的 # 标题和 ** 加粗。',
      '4. 关税、法规、汇率、海运时效、地理位置等外部信息，按你所知回答；不确定的要说明，涉及钱和法规的提醒以官方或货代确认为准，不要编造。',
      '5. 用户引用了客户的 WhatsApp 聊天时，结合那段聊天回答他的问题。涉及价格、付款、交期等具体条件，只用上面价格表里有的，没有的不要编数字。',
      '6. 只有当用户明确要你写一段发给客户的话（比如"帮我回复他""怎么回""写一段话发给他"）时，才在回答最后附上：',
      '【可发给客户】这里放用客户语言写的原文【/可发给客户】',
      '【中文】这里放中文意思【/中文】',
      '   其他情况不要输出这两个标记。',
    ].join('\n');
  }
  // 从 AI 的文字回答里拆出"可发给客户"的部分
  function splitAnswer(txt) {
    const t = String(txt || '');
    const r = t.match(/【可发给客户】([\s\S]*?)【\/可发给客户】/);
    const z = t.match(/【中文】([\s\S]*?)【\/中文】/);
    const answer = t.replace(/【可发给客户】[\s\S]*?【\/可发给客户】/g, '').replace(/【中文】[\s\S]*?【\/中文】/g, '').replace(/\*\*/g, '').replace(/^#+\s*/gm, '').trim();
    return { answer, reply: r ? r[1].trim() : '', reply_zh: z ? z[1].trim() : '' };
  }


  function openAsk() {
    panelChat = getChatName() || '';
    panelView = 'ask';
    lastTab = 'ask';
    setStatus('');
    if (askMode === 'history') return showPanel(renderHistory(), 'AI 助手');
    let chat = chats.get(chats.currentId);
    const thread = h('div', { class: 'ask-thread' });
    const input = h('textarea', { rows: '2', placeholder: '问点什么…（Enter 发送，Shift+Enter 换行）' });
    const sendBtn = h('button', null, '发送');
    let attach = null; // { name, conv }
    const attachChip = h('div', { class: 'ask-attach', style: 'display:none' });
    const renderAttach = () => {
      attachChip.innerHTML = '';
      if (!attach) { attachChip.style.display = 'none'; return; }
      attachChip.style.display = 'flex';
      attachChip.appendChild(h('span', null, '📎 将引用「' + attach.name + '」的聊天（' + attach.count + ' 条消息）'));
      attachChip.appendChild(h('button', { class: 'ws-close', title: '取消引用', onclick: () => { attach = null; renderAttach(); } }, '×'));
    };
    const quoteBtn = h('button', { class: 'sec', title: '把当前打开的客户聊天一起发给 AI（只附在下一条提问里）' }, '📎 引用当前客户聊天');
    quoteBtn.onclick = () => {
      const name = getChatName();
      if (!name) { toast('请先在左边打开一个客户聊天', true); return; }
      const conv = readConversation(60);
      if (!conv.length) { toast('这个聊天里没有可引用的文字消息', true); return; }
      attach = { name, count: conv.length, text: convText(conv, name) };
      renderAttach();
      input.focus();
    };

    const addBubble = (m) => {
      if (m.role === 'user') {
        thread.appendChild(h('div', { class: 'ask-me' }, m.ctxName ? h('div', { class: 'ask-ctx' }, '📎 引用了「' + m.ctxName + '」的聊天') : null, m.content));
        return;
      }
      const b = h('div', { class: 'ask-ai' }, String(m.answer || '').replace(/\*\*/g, ''));
      if (m.reply) {
        const saveBtn = h('button', { class: 'sec' }, '☆ 收藏');
        saveBtn.onclick = () => savePb(m.reply, m.reply_zh, 'AI 助手', '', saveBtn);
        b.appendChild(h('div', { class: 'ask-reply' },
          h('div', { class: 'wp-goal' }, '可以发给客户：'),
          h('div', { class: 'wp-reply' }, m.reply),
          m.reply_zh ? h('div', { class: 'wp-zh' }, '中文：' + m.reply_zh) : null,
          h('div', { class: 'wp-btns' }, h('button', { onclick: () => fillInput(m.reply) }, '填入聊天'), saveBtn)));
      }
      thread.appendChild(b);
    };
    if (!chat || !chat.msgs.length) {
      thread.appendChild(h('div', { class: 'wp-muted', style: 'text-align:center;padding:24px 0' },
        '这是独立的 AI 助手，和客户聊天无关，切换客户也不会影响这里。需要它参考某个客户时，点下面的「📎 引用当前客户聊天」。'));
    } else chat.msgs.forEach(addBubble);

    async function send() {
      const q = input.value.trim();
      if (!q) { input.focus(); return; }
      if (!ai.apiKey) { toast('请先在 ⚙ 设置里填写 DeepSeek API Key', true); return; }
      input.value = '';
      if (!chat) { chat = { id: 'c' + Date.now(), title: q.slice(0, 24), at: Date.now(), msgs: [] }; chats.currentId = chat.id; }
      const userMsg = { role: 'user', content: q, at: Date.now() };
      if (attach) { userMsg.ctxName = attach.name; userMsg.ctx = attach.text; attach = null; renderAttach(); }
      chat.msgs.push(userMsg); chat.at = Date.now(); chats.put(chat);
      if (thread.firstChild && thread.firstChild.classList.contains('wp-muted')) thread.innerHTML = '';
      addBubble(userMsg);
      const wait = h('div', { class: 'ask-ai wp-muted' }, 'AI 正在思考…');
      thread.appendChild(wait); thread.scrollTop = thread.scrollHeight;
      sendBtn.disabled = true;
      const chatId = chat.id;
      try {
        const msgs = [{ role: 'system', content: assistantSystem() }];
        chat.msgs.slice(-24).forEach((m) => msgs.push(m.role === 'user'
          ? { role: 'user', content: (m.ctx ? '【我引用的客户聊天】\n' + m.ctx + '\n\n【我的问题】\n' : '') + m.content }
          : { role: 'assistant', content: m.raw || m.answer || '' }));
        const res = await callDeepSeek(msgs, 3000, { json: false });
        const parts = splitAnswer(res.text);
        const ans = { role: 'assistant', raw: res.text, answer: parts.answer + (res.truncated ? '\n\n（回答太长被截断了，可以说"继续"）' : ''), reply: parts.reply, reply_zh: parts.reply_zh, at: Date.now() };
        const c2 = chats.get(chatId) || chat;
        c2.msgs.push(ans); c2.at = Date.now(); chats.put(c2); chat = c2;
        wait.remove();
        if (panelView === 'ask' && chats.currentId === chatId) addBubble(ans);
      } catch (e) {
        wait.className = 'ask-ai wr-err'; wait.textContent = '失败：' + e.message + '（问题已保留，可以再发一次）';
        const c2 = chats.get(chatId);
        if (c2 && c2.msgs.length && c2.msgs[c2.msgs.length - 1].role === 'user') { const last = c2.msgs.pop(); chats.put(c2); chat = c2; input.value = last.content; }
      } finally {
        sendBtn.disabled = false;
        thread.scrollTop = thread.scrollHeight;
      }
    }
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
    });

    const wide = store.get('panelWide', false);
    const top = h('div', { class: 'ask-top' },
      h('button', { onclick: () => { chats.currentId = ''; openAsk(); } }, '＋ 新对话'),
      h('button', { class: 'sec', onclick: () => { askMode = 'history'; openAsk(); } }, '🕘 历史对话（' + chats.all().length + '）'),
      h('button', { class: 'sec', title: '把右栏加宽或恢复', onclick: () => { store.set('panelWide', !wide); applyPanelWidth(); window.dispatchEvent(new Event('resize')); openAsk(); } }, wide ? '⇔ 恢复宽度' : '⇔ 加宽'));
    const box = h('div', { style: 'display:flex;flex-direction:column;height:100%;min-height:0' },
      top,
      chat && chat.msgs.length ? h('div', { class: 'ask-title' }, chat.title) : null,
      thread,
      attachChip,
      h('div', { class: 'ask-input' }, input, sendBtn),
      h('div', { style: 'margin-top:6px' }, quoteBtn));
    showPanel(box, 'AI 助手');
    thread.scrollTop = thread.scrollHeight;
    input.focus();
  }

  function renderHistory() {
    const list = chats.all().slice().sort((a, b) => b.at - a.at);
    const box = h('div', { style: 'height:100%;overflow:auto' },
      h('div', { class: 'ask-top' },
        h('button', { class: 'sec', onclick: () => { askMode = 'chat'; openAsk(); } }, '← 返回当前对话'),
        h('button', { onclick: () => { chats.currentId = ''; askMode = 'chat'; openAsk(); } }, '＋ 新对话')));
    if (!list.length) box.appendChild(h('div', { class: 'wp-muted', style: 'padding:20px 0;text-align:center' }, '还没有历史对话'));
    list.forEach((c) => {
      box.appendChild(h('div', { class: 'ask-hist' + (c.id === chats.currentId ? ' on' : '') },
        h('div', { class: 'ask-hist-main', onclick: () => { chats.currentId = c.id; askMode = 'chat'; openAsk(); } },
          h('div', { class: 'ask-hist-t' }, c.title || '（无标题）'),
          h('div', { class: 'wp-muted' }, fmtTime(c.at) + ' · ' + c.msgs.filter((m) => m.role === 'user').length + ' 个问题')),
        h('button', { class: 'ws-close', title: '删除这段对话（再点一次确认）', onclick: (e) => {
          e.stopPropagation();
          if (confirmInline(null, '将删除「' + (c.title || '').slice(0, 12) + '」')) { chats.remove(c.id); if (chats.currentId === c.id) chats.currentId = ''; openAsk(); }
        } }, '删除')));
    });
    return box;
  }

  // 分析结果是否过期：只提示，不自动分析（由你点「分析客户」更新）
  function staleStatus(saved) {
    if (!saved) { setStatus(''); return; }
    if (saved.fp === convFingerprint()) setStatus('已是最新分析（' + fmtTime(saved.at) + '）', 'ok');
    else setStatus('对话有新消息，这是 ' + fmtTime(saved.at) + ' 的分析。点「分析客户」更新', 'warn');
  }
  setInterval(async () => {
    if (!document.documentElement.classList.contains('wat-docked')) return;
    const name = getChatName();
    if (!name || name !== panelChat || analyzing) return;
    // 延后的列表标签：输入框清空后再更新
    if (pendingLabel && pendingLabel.name === name) {
      const el = getInput();
      if (el && !getInputText(el)) {
        const pl = pendingLabel; pendingLabel = null;
        let res;
        try { res = await applyLevelList(pl.level, name); } catch (e) { res = { ok: false, msg: '加入列表出错：' + e.message }; }
        if (res.ok) toast('已加入列表「' + pl.level + ' ' + LEVEL_NAME[pl.level] + '」'); else toast(res.msg, true);
      }
    }
    // 只更新顶部状态提示（不调用 AI）
    if (panelView === 'result' && atBottom() && !notice) {
      const saved = ai.analyses()[name];
      if (saved) {
        const stale = saved.fp !== convFingerprint();
        if (stale !== (statusKind === 'warn')) staleStatus(saved);
      }
    }
  }, 2000);

  function syncPanel() {
    const name = getChatName();
    if (!document.documentElement.classList.contains('wat-docked')) return;
    if (lastTab === 'ask' && panelView === 'ask') {
      // AI 助手和客户无关：切换客户不刷新，只更新标题里的客户名
      if (name !== panelChat) panelChat = name || '';
      return;
    }
    if (!name) {
      // 没打开聊天（或页面正在重新排版）时不收起第三栏，只显示提示
      if (panelChat !== '' || !panel.firstChild) {
        panelChat = '';
        showPanel(h('div', { class: 'wp-muted', style: 'padding:24px 0;text-align:center' }, '打开一个客户聊天，这里会显示分析'));
      }
      return;
    }
    if (name === panelChat) return;
    panelChat = name;
    notice = null;
    panelView = 'result';
    const saved = ai.analyses()[name];
    if (saved) {
      showPanel(renderResult(normalizeResult(saved.result), saved.at));
      staleStatus(saved);
    } else { setStatus(''); showNotAnalyzed(); }
  }
  setInterval(syncPanel, 700);
  if (store.get('docked', false)) { document.documentElement.classList.add('wat-docked'); panel.style.display = 'flex'; syncPanel(); }

  /* ---------- 设置面板 ---------- */
  const setDlg = h('div', { id: 'wat-settings' });
  document.documentElement.appendChild(setDlg);

  function openSettings(tab) {
    setDlg.innerHTML = '';
    const keyIn = h('input', { type: 'password', placeholder: 'sk-…', autocomplete: 'off' });
    keyIn.value = ai.apiKey;
    const bizIn = h('textarea', { rows: '4' }); bizIn.value = ai.biz;
    const priceIn = h('textarea', { rows: '5', placeholder: '例：R8 标准版 FOB 上海 USD xxxx；运到伯利兹城落地价 USD xxxx；付款：T/T 30% 定金，70% 发货前付清；交期：付款后 xx 天（留空则 AI 不提任何价格和条件）' }); priceIn.value = ai.prices;
    const rulesIn = h('textarea', { rows: '5' }); rulesIn.value = ai.rules;
    const labelIn = h('input', { type: 'checkbox' }); labelIn.checked = ai.autoLabel;
    const glossIn = h('textarea', { rows: '4', placeholder: '每行一条：中文 = 英文 | 西语（西语可省略）\n二手车 = used car | carro usado\n落地价 = landed price | precio puesto en destino' });
    glossIn.value = store.get('glossary', '');
    const aiInIn = h('input', { type: 'checkbox' }); aiInIn.checked = store.get('aiIn', true);
    const piSec = piSettingsSection();
    const pbBox = h('div', { class: 'ws-pb' });
    const renderPb = () => {
      pbBox.innerHTML = '';
      ai.playbook().slice().reverse().forEach((p) => {
        pbBox.appendChild(h('div', { class: 'ws-pbi' },
          h('span', { class: 'wp-tag' }, p.scene + (p.level ? ' · ' + p.level : '')),
          h('span', { class: 'ws-pbt' }, p.text),
          h('button', { class: 'sec', title: '删除', onclick: () => { ai.savePlaybook(ai.playbook().filter((x) => x.id !== p.id)); renderPb(); } }, '删')));
      });
    };
    renderPb();
    const pages = {
      basic: h('div', null,
        h('label', null, 'DeepSeek API Key（只保存在这台电脑的浏览器里）'), keyIn,
        h('label', null, '我方业务介绍'), bizIn,
        h('label', null, '价格表与交易条款（价格、付款方式、交期等，AI 只会引用这里写的）'), priceIn,
        h('label', null, '客户分级标准'), rulesIn,
        h('label', null, '翻译术语表（发送翻译时固定用这些译法；AI 翻译和谷歌/微软都生效）'), glossIn,
        h('label', { class: 'ws-inline' }, aiInIn, ' 对方消息用 AI 翻译成中文（每个聊天最近 20 条；先显示谷歌/微软译文，AI 结果回来后替换）'),
        h('label', { class: 'ws-inline' }, labelIn, ' 分析后自动加入 WhatsApp 的 A/B/C/D 列表')),
      pi: piSec,
      pb: h('div', null, h('label', null, '话术库（共 ' + ai.playbook().length + ' 条，新收藏的在上面；带 [方括号备注] 的不会交给 AI）'), pbBox),
    };
    const tabBtns = {};
    const showTab = (k) => {
      Object.keys(pages).forEach((x) => { pages[x].style.display = x === k ? '' : 'none'; tabBtns[x].classList.toggle('on', x === k); });
    };
    [['basic', '基本设置'], ['pi', 'PI 发票（公司 / 银行 / 公章 / Logo）'], ['pb', '话术库']].forEach(([k, t]) => {
      tabBtns[k] = h('button', { class: 'ws-tab', onclick: () => showTab(k) }, t);
    });
    setDlg.appendChild(h('div', { class: 'ws-card' },
      h('div', { class: 'wp-head' }, h('b', null, '翻译助手设置'), h('button', { class: 'wp-x', onclick: () => { setDlg.style.display = 'none'; } }, '×')),
      h('div', { class: 'ws-tabs' }, Object.values(tabBtns)),
      pages.basic, pages.pi, pages.pb,
      h('div', { class: 'wp-btns ws-save', style: 'justify-content:flex-end;margin-top:10px' },
        h('button', { class: 'sec', onclick: () => {
          const data = JSON.stringify(ai.playbook(), null, 2);
          navigator.clipboard.writeText(data).then(() => toast('话术库已复制到剪贴板，可粘贴到记事本保存'), () => toast('复制失败', true));
        } }, '导出话术库'),
        h('button', { onclick: () => {
          ai.apiKey = keyIn.value.trim();
          ai.biz = bizIn.value.trim() || DEFAULT_BIZ;
          ai.prices = priceIn.value;
          ai.rules = rulesIn.value.trim() || DEFAULT_RULES;
          ai.autoLabel = labelIn.checked;
          store.set('glossary', glossIn.value.trim());
          store.set('aiIn', aiInIn.checked);
          scanIncoming();
          piSec.save();
          setDlg.style.display = 'none';
          toast('设置已保存');
          if (panelView === 'pi' && getChatName()) openPI(false); // 刷新 PI 表单上方的提醒
        } }, '保存'))));
    showTab(pages[tab] ? tab : 'basic');
    setDlg.style.display = 'flex';
  }

  /* ======================================================================
   *  PI 形式发票：从聊天提取 → 编辑 → 生成 PDF → 放进 WhatsApp 发送预览
   * ==================================================================== */
  const SELLER_DEFAULT = {
    name: 'BOUNDLESS AUTOMOTIVE LIMITED',
    nameCn: '無界汽車有限公司',
    address: 'Rm 11, 13/F, Block C, Wong King Industrial Building, 192-198 Choi Hung Road, San Po Kong, Kowloon, Hong Kong',
    phone: '', email: '', web: 'cheryamc.com', contact: '',
    bankBeneficiary: 'BOUNDLESS AUTOMOTIVE LIMITED', bankName: '', bankAddress: '', bankSwift: '', bankAccount: '',
    logo: '', seal: '',
    payment: '', delivery: '', warranty: '', remarks: '',
    pol: 'Shanghai, China', incoterm: 'CIF', validDays: 15, prefix: 'PI',
  };
  const piCfg = {
    get() { return Object.assign({}, SELLER_DEFAULT, store.get('piSeller', {})); },
    set(v) { store.set('piSeller', v); },
  };

  const PI_T = {
    en: {
      title: 'PROFORMA INVOICE', no: 'PI No.', date: 'Date', valid: 'Valid until', seller: 'Seller', buyer: 'Buyer',
      desc: 'Description', color: 'Color', qty: 'Qty', unit: 'Unit price', amount: 'Amount',
      term: 'Trade term', pol: 'Port of loading', pod: 'Port of destination',
      subtotal: 'Subtotal', freight: 'Freight', insurance: 'Insurance', discount: 'Discount', total: 'TOTAL',
      terms: 'Terms', payment: 'Payment', delivery: 'Delivery', warranty: 'Warranty', remarks: 'Remarks',
      bank: 'Bank information', beneficiary: 'Beneficiary', bankName: 'Bank', bankAddr: 'Bank address', swift: 'SWIFT', account: 'Account No.',
      contact: 'Contact', sign: 'Authorized signature', included: 'Included',
      note: 'Prices are valid until the date above. Local taxes and customs duties at destination are paid by the buyer.',
    },
    es: {
      title: 'FACTURA PROFORMA', no: 'N.º PI', date: 'Fecha', valid: 'Válida hasta', seller: 'Vendedor', buyer: 'Comprador',
      desc: 'Descripción', color: 'Color', qty: 'Cant.', unit: 'Precio unitario', amount: 'Importe',
      term: 'Incoterm', pol: 'Puerto de carga', pod: 'Puerto de destino',
      subtotal: 'Subtotal', freight: 'Flete', insurance: 'Seguro', discount: 'Descuento', total: 'TOTAL',
      terms: 'Condiciones', payment: 'Pago', delivery: 'Entrega', warranty: 'Garantía', remarks: 'Observaciones',
      bank: 'Información bancaria', beneficiary: 'Beneficiario', bankName: 'Banco', bankAddr: 'Dirección del banco', swift: 'SWIFT', account: 'N.º de cuenta',
      contact: 'Contacto', sign: 'Firma autorizada', included: 'Incluido',
      note: 'Los precios son válidos hasta la fecha indicada. Los impuestos y aranceles locales en destino corren por cuenta del comprador.',
    },
  };

  /* ---------- 金额大写（英文 / 西班牙文） ---------- */
  function wordsEn(n) {
    const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const t = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const lt1000 = (x) => {
      let s = '';
      if (x >= 100) { s += a[Math.floor(x / 100)] + ' Hundred'; x %= 100; if (x) s += ' '; }
      if (x >= 20) { s += t[Math.floor(x / 10)]; if (x % 10) s += '-' + a[x % 10]; } else if (x) s += a[x];
      return s;
    };
    if (n === 0) return 'Zero';
    const parts = [];
    [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand'], [1, '']].forEach(([u, w]) => {
      const q = Math.floor(n / u); n %= u;
      if (q) parts.push(lt1000(q) + (w ? ' ' + w : ''));
    });
    return parts.join(' ');
  }
  function wordsEs(n) {
    const u = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
    const d = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
    const c = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];
    const lt100 = (x) => (x < 30 ? u[x] : d[Math.floor(x / 10)] + (x % 10 ? ' y ' + u[x % 10] : ''));
    const lt1000 = (x) => {
      if (x === 100) return 'cien';
      const h = Math.floor(x / 100), r = x % 100;
      return [c[h], r ? lt100(r) : ''].filter(Boolean).join(' ');
    };
    if (n === 0) return 'cero';
    let s = [];
    const mil = Math.floor(n / 1e6), th = Math.floor((n % 1e6) / 1000), rest = n % 1000;
    if (mil) s.push(mil === 1 ? 'un millón' : lt1000(mil).replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un') + ' millones');
    if (th) s.push(th === 1 ? 'mil' : lt1000(th).replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un') + ' mil');
    if (rest) s.push(lt1000(rest));
    return s.join(' ');
  }
  function amountWords(total, lang, cur) {
    const whole = Math.floor(total + 1e-9), cents = Math.round((total - whole) * 100);
    if (lang === 'es') {
      // 名词前：uno→un，veintiuno→veintiún；整百万后加 de
      let w = wordsEs(whole).replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un');
      if (/(millón|millones)$/.test(w)) w += ' de';
      const unit = cur === 'USD' ? (whole === 1 ? 'dólar estadounidense' : 'dólares estadounidenses') : cur;
      return 'Son: ' + w.charAt(0).toUpperCase() + w.slice(1) + ' ' + unit + ' con ' + String(cents).padStart(2, '0') + '/100.';
    }
    return 'Say ' + (cur === 'USD' ? 'US Dollars' : cur) + ' ' + wordsEn(whole) + (cents ? ' and Cents ' + wordsEn(cents) : '') + ' Only.';
  }

  const num = (v) => { const x = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(x) ? null : x; };
  const money = (v) => (v == null ? '' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const fmtDate = (d, lang) => d.toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  function piTotals(pi) {
    const subtotal = pi.items.reduce((s, it) => s + (num(it.qty) || 0) * (num(it.price) || 0), 0);
    const f = num(pi.freight), ins = num(pi.insurance), dis = num(pi.discount);
    return { subtotal, freight: f, insurance: ins, discount: dis, total: subtotal + (f || 0) + (ins || 0) - (dis || 0) };
  }

  function nextPiNo() {
    const cfg = piCfg.get();
    const d = new Date();
    const ds = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const seq = store.get('piSeq', {});
    const n = (seq[ds] || 0) + 1;
    return { no: (cfg.prefix || 'PI') + '-' + ds + '-' + String(n).padStart(3, '0'), ds, n };
  }
  function commitPiNo(no) {
    const m = no.match(/-(\d{8})-(\d+)$/);
    if (!m) return;
    const seq = store.get('piSeq', {});
    seq[m[1]] = Math.max(seq[m[1]] || 0, parseInt(m[2], 10));
    store.set('piSeq', seq);
  }

  /* ---------- 渲染 PI（客户看到的样子；全部内联样式，避免受 WhatsApp 样式影响） ---------- */
  function renderPiPage(pi, cfg) {
    const T = PI_T[pi.lang] || PI_T.en;
    const NAVY = '#0f2a44', GRAY = '#52606d', LIGHT = '#7b8794', LINE = '#e4e7eb';
    const lab = (t) => h('span', { style: 'font-size:10px;letter-spacing:.06em;color:' + LIGHT + ';text-transform:uppercase' }, t);
    const box = (title, ...kids) => h('div', { style: 'border:1px solid ' + LINE + ';border-radius:4px;padding:10px 12px' },
      h('div', { style: 'margin-bottom:4px' }, lab(title)), ...kids);
    const line = (k, v) => (v ? h('div', null, h('b', null, k + ': '), String(v)) : null);
    const tot = piTotals(pi);
    const cur = pi.currency || 'USD';
    const date = new Date(pi.dateTs || Date.now());
    const valid = new Date(date.getTime() + (num(pi.validDays) || 15) * 86400000);

    const page = h('div', { style: 'all:initial;display:block;box-sizing:border-box;width:794px;min-height:1123px;background:#fff;color:#1f2933;' +
      'font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;padding:40px 44px;position:relative' });

    // 顶部
    page.appendChild(h('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid ' + NAVY + ';padding-bottom:14px' },
      h('div', { style: 'display:flex;gap:12px;align-items:center;max-width:430px' },
        cfg.logo ? h('img', { src: cfg.logo, style: 'width:56px;height:56px;object-fit:contain' }) : null,
        h('div', null,
          h('div', { style: 'font-size:16px;font-weight:700;color:' + NAVY }, cfg.name),
          cfg.nameCn ? h('div', { style: 'color:' + GRAY }, cfg.nameCn) : null,
          h('div', { style: 'color:' + GRAY + ';font-size:11px' }, cfg.address),
          h('div', { style: 'color:' + GRAY + ';font-size:11px' }, [cfg.phone, cfg.email, cfg.web].filter(Boolean).join(' · ')))),
      h('div', { style: 'text-align:right' },
        h('div', { style: 'font-size:24px;font-weight:700;letter-spacing:.04em;color:' + NAVY }, T.title),
        h('table', { style: 'margin-left:auto;margin-top:4px;border-collapse:collapse' },
          h('tr', null, h('td', { style: 'padding-right:10px' }, lab(T.no)), h('td', { style: 'font-weight:700' }, pi.no)),
          h('tr', null, h('td', { style: 'padding-right:10px' }, lab(T.date)), h('td', null, fmtDate(date, pi.lang))),
          h('tr', null, h('td', { style: 'padding-right:10px' }, lab(T.valid)), h('td', null, fmtDate(valid, pi.lang)))))));

    // 买卖双方
    const b = pi.buyer || {};
    page.appendChild(h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:16px 0' },
      box(T.seller, h('div', { style: 'font-weight:700' }, cfg.name),
        cfg.contact ? h('div', { style: 'color:' + GRAY }, T.contact + ': ' + cfg.contact) : null,
        cfg.phone ? h('div', { style: 'color:' + GRAY }, cfg.phone) : null),
      box(T.buyer, h('div', { style: 'font-weight:700' }, [b.name, b.company].filter(Boolean).join(' · ') || '-'),
        h('div', { style: 'color:' + GRAY }, [b.address, b.city, b.country].filter(Boolean).join(', ')),
        h('div', { style: 'color:' + GRAY }, [b.phone, b.email].filter(Boolean).join(' · ')))));

    // 明细表
    const th = (t, right, w) => h('th', { style: 'background:' + NAVY + ';color:#fff;font-weight:500;font-size:11px;padding:8px;text-align:' + (right ? 'right' : 'left') + (w ? ';width:' + w : '') }, t);
    const td = (c, right, bold) => h('td', { style: 'padding:10px 8px;border-bottom:1px solid ' + LINE + ';vertical-align:top;text-align:' + (right ? 'right' : 'left') + (bold ? ';font-weight:700' : '') }, c);
    const table = h('table', { style: 'width:100%;border-collapse:collapse' },
      h('tr', null, th('#', false, '28px'), th(T.desc), th(T.color, false, '80px'), th(T.qty, true, '44px'), th(T.unit, true, '96px'), th(T.amount, true, '104px')));
    pi.items.forEach((it, i) => {
      const q = num(it.qty) || 0, p = num(it.price);
      table.appendChild(h('tr', null,
        td(String(i + 1)),
        td(h('div', null, h('div', { style: 'font-weight:700' }, it.model || ''), it.spec ? h('div', { style: 'color:' + GRAY }, it.spec) : null)),
        td(it.color || ''), td(String(q), true), td(money(p), true), td(money(p == null ? null : p * q), true, true)));
    });
    page.appendChild(table);

    // 条款 + 汇总
    const sumRow = (k, v) => h('tr', null, h('td', { style: 'color:' + GRAY + ';padding:3px 0' }, k), h('td', { style: 'text-align:right' }, v));
    const fv = (raw, n) => (n != null ? money(n) : (raw ? (/includ|incluid/i.test(raw) ? T.included : String(raw)) : null));
    const sumTable = h('table', { style: 'width:260px;border-collapse:collapse' }, sumRow(T.subtotal, money(tot.subtotal)));
    [[T.freight, fv(pi.freight, tot.freight)], [T.insurance, fv(pi.insurance, tot.insurance)], [T.discount, tot.discount ? '-' + money(tot.discount) : null]]
      .forEach(([k, v]) => { if (v) sumTable.appendChild(sumRow(k, v)); });
    sumTable.appendChild(h('tr', null, h('td', { colspan: '2', style: 'padding:0' },
      h('div', { style: 'background:' + NAVY + ';color:#fff;border-radius:4px;padding:9px 12px;margin-top:6px;display:flex;justify-content:space-between;align-items:baseline' },
        h('span', { style: 'font-size:10px;letter-spacing:.06em' }, T.total + ' (' + cur + ')'),
        h('span', { style: 'font-size:18px;font-weight:700' }, money(tot.total))))));
    page.appendChild(h('div', { style: 'display:flex;justify-content:space-between;gap:16px;margin-top:12px' },
      h('div', { style: 'flex:1;color:' + GRAY },
        pi.incoterm ? h('div', null, lab(T.term), ' ' + pi.incoterm + (pi.pod ? ' ' + pi.pod : '')) : null,
        pi.pol ? h('div', null, lab(T.pol), ' ' + pi.pol) : null,
        h('div', { style: 'margin-top:6px;font-style:italic' }, amountWords(tot.total, pi.lang, cur))),
      sumTable));

    page.appendChild(h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:18px' },
      box(T.terms, line(T.payment, pi.payment), line(T.delivery, pi.delivery), line(T.warranty, pi.warranty), line(T.remarks, pi.remarks)),
      box(T.bank, line(T.beneficiary, cfg.bankBeneficiary), line(T.bankName, cfg.bankName), line(T.bankAddr, cfg.bankAddress),
        line(T.swift, cfg.bankSwift), line(T.account, cfg.bankAccount))));

    page.appendChild(h('div', { style: 'display:flex;justify-content:space-between;align-items:flex-end;margin-top:26px' },
      h('div', { style: 'color:' + LIGHT + ';font-size:10px;max-width:380px' }, T.note),
      h('div', { style: 'text-align:center;width:200px;position:relative' },
        cfg.seal ? h('img', { src: cfg.seal, style: 'width:120px;height:120px;object-fit:contain;display:block;margin:0 auto -12px;opacity:.92' }) : h('div', { style: 'height:60px' }),
        h('div', { style: 'border-top:1px solid #1f2933;padding-top:3px;font-size:10px;color:' + GRAY }, T.sign))));
    return page;
  }

  /* ---------- 生成 PDF ---------- */
  async function makePiFiles(pi, cfg, baseName) {
    if (typeof html2canvas !== 'function' || !window.jspdf) throw new Error('PDF 组件没有加载成功，请刷新页面重试');
    const holder = h('div', { style: 'position:fixed;left:-20000px;top:0;z-index:-1' });
    const page = renderPiPage(pi, cfg);
    holder.appendChild(page);
    document.body.appendChild(holder);
    try {
      await Promise.all([...page.querySelectorAll('img')].map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; }))));
      const canvas = await html2canvas(page, { scale: 2, backgroundColor: '#ffffff', logging: false, windowWidth: 794, useCORS: true });
      // 图片版：客户在聊天里不用点开就能看到 PI
      const imgBlob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
      const pw = 210, ph = 297;
      const imgH = canvas.height * pw / canvas.width;
      if (imgH <= ph + 0.5) {
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pw, imgH);
      } else {
        // 内容超过一页：按 A4 高度切片
        const sliceH = Math.floor(canvas.width * ph / pw);
        for (let y = 0, first = true; y < canvas.height; y += sliceH, first = false) {
          const c = document.createElement('canvas');
          c.width = canvas.width; c.height = Math.min(sliceH, canvas.height - y);
          const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(canvas, 0, y, c.width, c.height, 0, 0, c.width, c.height);
          if (!first) pdf.addPage();
          pdf.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pw, c.height * pw / c.width);
        }
      }
      return {
        pdf: new File([pdf.output('blob')], baseName + '.pdf', { type: 'application/pdf' }),
        img: new File([imgBlob], baseName + '.jpg', { type: 'image/jpeg' }),
      };
    } finally {
      holder.remove();
    }
  }

  // 把文件放进 WhatsApp 的发送预览（不会自动发送）
  async function attachToChat(files) {
    const el = getInput();
    if (!el) throw new Error('请先打开客户聊天');
    el.focus();
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  }

  // 含中文的字段，翻译成 PI 语言
  async function localizeFields(pi) {
    const out = JSON.parse(JSON.stringify(pi));
    const to = pi.lang === 'es' ? 'es' : 'en';
    const tr = async (s) => (s && hasChinese(String(s)) ? (await translate(String(s), to)).text : s);
    for (const k of ['payment', 'delivery', 'warranty', 'remarks', 'pol', 'pod', 'freight', 'insurance']) out[k] = await tr(out[k]);
    for (const k of Object.keys(out.buyer || {})) out.buyer[k] = await tr(out.buyer[k]);
    for (const it of out.items) { it.model = await tr(it.model); it.spec = await tr(it.spec); it.color = await tr(it.color); }
    return out;
  }

  /* ---------- AI 从聊天提取 ---------- */
  async function extractPiFromChat(conv, chatName) {
    const system = [
      '你帮中国汽车出口经销商从 WhatsApp 聊天中提取形式发票（PI）需要的信息。',
      '【我方业务】\n' + ai.biz,
      '【规则】',
      '- 只提取聊天里明确出现的内容，没有的填 null，不要猜。',
      '- 单价只取我方在聊天里报过的价格（数字，不带货币符号）；没报过就 null。',
      '- 文字字段用英文填写；如果客户主要用西班牙语交流，lang 填 "es" 且文字字段用西班牙语，否则 lang 填 "en"。',
      '- 只输出 JSON：{"lang":"en|es","buyer":{"name":null,"company":null,"address":null,"city":null,"country":null,"phone":null,"email":null},' +
        '"items":[{"model":"品牌车型，如 Chery RELY R8","spec":"配置：发动机/燃料/变速箱/驱动/年款等","color":null,"qty":1,"price":null}],' +
        '"currency":"USD","incoterm":"CIF/FOB/EXW 等，没有则 null","pol":"起运港","pod":"目的港",' +
        '"freight":"运费数字，或 included，或 null","insurance":"保险费数字，或 included，或 null","payment":null,"delivery":null,"remarks":null}',
    ].join('\n');
    const { json } = await callDeepSeek([{ role: 'system', content: system }, { role: 'user', content: convText(conv, chatName) }], 1200);
    return json || {};
  }

  function blankPi(chatName) {
    const cfg = piCfg.get();
    const phoneLike = /^\+?[\d\s\-()]{7,}$/.test(chatName || '');
    return {
      lang: 'en', no: nextPiNo().no, dateTs: Date.now(), validDays: cfg.validDays || 15, currency: 'USD',
      buyer: { name: phoneLike ? '' : (chatName || ''), company: '', address: '', city: '', country: '', phone: phoneLike ? chatName : '', email: '' },
      items: [{ model: '', spec: '', color: '', qty: 1, price: '' }],
      incoterm: cfg.incoterm || '', pol: cfg.pol || '', pod: '', freight: '', insurance: '', discount: '',
      payment: cfg.payment || '', delivery: cfg.delivery || '', warranty: cfg.warranty || '', remarks: cfg.remarks || '',
    };
  }
  function mergeExtracted(pi, x) {
    const pick = (v) => (v == null || v === '' || /^null|unknown|未知$/i.test(String(v)) ? '' : v);
    if (x.lang === 'es' || x.lang === 'en') pi.lang = x.lang;
    const xb = x.buyer || {};
    Object.keys(pi.buyer).forEach((k) => { const v = pick(xb[k]); if (v) pi.buyer[k] = String(v); });
    if (Array.isArray(x.items) && x.items.length) {
      pi.items = x.items.map((it) => ({ model: pick(it.model), spec: pick(it.spec), color: pick(it.color), qty: pick(it.qty) || 1, price: pick(it.price) }));
    }
    ['currency', 'incoterm', 'pol', 'pod', 'freight', 'insurance', 'payment', 'delivery', 'remarks'].forEach((k) => { const v = pick(x[k]); if (v) pi[k] = String(v); });
    return pi;
  }

  /* ---------- PI 编辑界面（右栏） ---------- */
  async function openPI(fresh) {
    const chatName = getChatName();
    if (!chatName) { toast('请先打开客户聊天', true); return; }
    panelChat = chatName;
    panelView = 'pi';
    const drafts = store.get('piDrafts', {});
    if (drafts[chatName] && !fresh) { renderPiEditor(drafts[chatName], false); return; }
    let pi = blankPi(chatName);
    if (!ai.apiKey) { renderPiEditor(pi, true); toast('没有填 DeepSeek Key，只能手动填写', true); return; }
    showPanel(h('div', { class: 'wp-muted', style: 'padding:24px 0;text-align:center' }, 'AI 正在从聊天中提取 PI 信息…'), '生成 PI');
    try {
      pi = mergeExtracted(pi, await extractPiFromChat(readConversation(80), chatName));
    } catch (e) { toast('提取失败：' + e.message + '，请手动填写', true); }
    if (getChatName() === chatName && panelView === 'pi') renderPiEditor(pi, true);
  }

  function renderPiEditor(pi, isNew) {
    const chatName = getChatName();
    const save = () => { const d = store.get('piDrafts', {}); d[chatName] = pi; store.set('piDrafts', d); };
    const field = (label, obj, key, opts) => {
      opts = opts || {};
      const inp = h(opts.area ? 'textarea' : 'input', { class: 'pi-in', rows: opts.area ? '2' : null, placeholder: opts.ph || '' });
      if (!opts.area) inp.type = 'text';
      inp.value = obj[key] == null ? '' : obj[key];
      const mark = () => inp.classList.toggle('pi-miss', !String(inp.value).trim() && !opts.optional);
      inp.addEventListener('input', () => { obj[key] = inp.value; mark(); save(); refreshTotal(); });
      mark();
      return h('label', { class: 'pi-f' + (opts.half ? ' half' : '') }, h('span', null, label), inp);
    };
    const totalEl = h('div', { class: 'pi-total' });
    const refreshTotal = () => { const t = piTotals(pi); totalEl.textContent = '合计 ' + (pi.currency || 'USD') + ' ' + money(t.total); };

    const itemsBox = h('div');
    const renderItems = () => {
      itemsBox.innerHTML = '';
      pi.items.forEach((it, i) => {
        itemsBox.appendChild(h('div', { class: 'pi-item' },
          h('div', { class: 'pi-item-h' }, h('b', null, '车辆 ' + (i + 1)),
            pi.items.length > 1 ? h('button', { class: 'sec', onclick: () => { pi.items.splice(i, 1); save(); renderItems(); refreshTotal(); } }, '删除') : null),
          field('车型', it, 'model', { ph: 'Chery RELY R8' }),
          field('配置', it, 'spec', { ph: '2.0T Diesel · 8AT · 4x4 · 2026', optional: false }),
          h('div', { class: 'pi-row' },
            field('颜色', it, 'color', { half: true }),
            field('数量', it, 'qty', { half: true })),
          field('单价', it, 'price', { ph: '25000' })));
      });
      itemsBox.appendChild(h('button', { class: 'sec', onclick: () => { pi.items.push({ model: '', spec: '', color: '', qty: 1, price: '' }); save(); renderItems(); } }, '+ 添加车辆'));
    };
    renderItems();
    refreshTotal();

    const langSel = h('select', { class: 'pi-in' }, h('option', { value: 'en' }, 'English 英文版'), h('option', { value: 'es' }, 'Español 西班牙语版'));
    langSel.value = pi.lang || 'en';
    langSel.addEventListener('change', () => { pi.lang = langSel.value; save(); });

    const busyBtn = (btn, fn) => async () => {
      const old = btn.textContent; btn.disabled = true; btn.textContent = '处理中…';
      try { await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.textContent = old; }
    };
    const build = async () => {
      const cfg = piCfg.get();
      if (!cfg.bankAccount || !cfg.bankName) toast('提醒：设置里还没填银行信息', true);
      const loc = await localizeFields(pi);
      const safe = (pi.buyer.name || pi.buyer.phone || 'customer').replace(/[^\w\-]+/g, '_').slice(0, 40);
      return makePiFiles(loc, cfg, pi.no + '_' + safe);
    };
    const recordSent = () => {
      commitPiNo(pi.no);
      const rec = store.get('piRecords', []);
      rec.push({ no: pi.no, chat: chatName, at: Date.now(), total: piTotals(pi).total, currency: pi.currency || 'USD', lang: pi.lang });
      store.set('piRecords', rec.slice(-500));
      save();
    };
    const previewBtn = h('button', { class: 'sec' }, '预览');
    previewBtn.onclick = busyBtn(previewBtn, async () => { showPiPreview(renderPiPage(await localizeFields(pi), piCfg.get())); });
    const withImg = h('input', { type: 'checkbox' });
    withImg.checked = store.get('piWithImg', true);
    withImg.addEventListener('change', () => store.set('piWithImg', withImg.checked));
    const sendBtn = h('button', null, '生成并放进聊天');
    sendBtn.onclick = busyBtn(sendBtn, async () => {
      const f = await build();
      await attachToChat(withImg.checked ? [f.img, f.pdf] : [f.pdf]);
      recordSent();
      toast((withImg.checked ? 'PI 图片和 PDF' : 'PDF') + ' 已放进发送预览，确认后点发送');
    });
    const dlBtn = h('button', { class: 'sec' }, '下载 PDF');
    dlBtn.onclick = busyBtn(dlBtn, async () => {
      const file = (await build()).pdf;
      const a = h('a', { href: URL.createObjectURL(file), download: file.name });
      document.body.appendChild(a); a.click(); a.remove();
      recordSent();
    });

    const b = pi.buyer;
    const cfgNow = piCfg.get();
    const missingCfg = [
      !cfgNow.logo && 'Logo', !cfgNow.seal && '公章',
      !(cfgNow.bankName && cfgNow.bankAccount && cfgNow.bankSwift) && '银行信息',
      !(cfgNow.phone || cfgNow.email) && '公司电话/邮箱',
    ].filter(Boolean);
    const box = h('div', { class: 'pi-ed' },
      missingCfg.length ? h('div', { class: 'pi-warn' }, '还没设置：' + missingCfg.join('、') + '。',
        h('button', { class: 'sec', style: 'margin-left:6px', onclick: () => openSettings('pi') }, '去设置')) : null,
      h('div', { class: 'wp-muted' }, (isNew ? 'AI 已从聊天中提取，' : '这是上次保存的 PI，') + '黄色框是需要你补充的内容。中文也可以，生成时会自动翻译。'),
      h('div', { class: 'pi-row' }, field('PI 编号', pi, 'no', { half: true }), h('label', { class: 'pi-f half' }, h('span', null, '语言'), langSel)),
      h('div', { class: 'wp-sec' }, '买方'),
      field('姓名', b, 'name'), field('公司（可选）', b, 'company', { optional: true }),
      field('地址', b, 'address'),
      h('div', { class: 'pi-row' }, field('城市', b, 'city', { half: true }), field('国家', b, 'country', { half: true })),
      h('div', { class: 'pi-row' }, field('电话/WhatsApp', b, 'phone', { half: true }), field('邮箱（可选）', b, 'email', { half: true, optional: true })),
      h('div', { class: 'wp-sec' }, '车辆明细'), itemsBox,
      h('div', { class: 'wp-sec' }, '价格条款'),
      h('div', { class: 'pi-row' }, field('币种', pi, 'currency', { half: true }), field('贸易术语', pi, 'incoterm', { half: true, ph: 'CIF' })),
      h('div', { class: 'pi-row' }, field('起运港', pi, 'pol', { half: true }), field('目的港', pi, 'pod', { half: true, ph: 'Belize City' })),
      h('div', { class: 'pi-row' }, field('运费', pi, 'freight', { half: true, optional: true, ph: '数字或 included' }), field('保险费', pi, 'insurance', { half: true, optional: true, ph: '数字或 included' })),
      h('div', { class: 'pi-row' }, field('折扣', pi, 'discount', { half: true, optional: true }), field('有效天数', pi, 'validDays', { half: true })),
      totalEl,
      h('div', { class: 'wp-sec' }, '条款'),
      field('付款方式', pi, 'payment', { area: true }), field('交期', pi, 'delivery', { area: true }),
      field('质保', pi, 'warranty', { area: true, optional: true }), field('备注', pi, 'remarks', { area: true, optional: true }),
      h('label', { class: 'ws-inline', style: 'display:flex;gap:6px;align-items:center;margin-top:10px;font-size:12px' }, withImg, '同时附一张 PI 图片（客户在聊天里直接能看到）'),
      h('div', { class: 'wp-foot pi-actions' }, sendBtn, previewBtn, dlBtn),
      h('div', { class: 'wp-foot' },
        h('button', { class: 'sec', onclick: () => { if (confirmInline(box, '重新从聊天提取会覆盖当前内容')) openPI(true); } }, '重新从聊天提取'),
        h('button', { class: 'sec', onclick: () => { pi.no = nextPiNo().no; pi.dateTs = Date.now(); save(); renderPiEditor(pi, false); toast('已换新编号 ' + pi.no); } }, '新编号（改版重发）'),
        h('button', { class: 'sec', onclick: () => openSettings('pi') }, '⚙ 公司/银行/公章'),
        h('button', { class: 'sec', onclick: backToResult }, '← 返回分析')));
    save();
    showPanel(box, '生成 PI');
  }
  // 简单的二次确认：第一次点提示，3 秒内再点才执行
  let confirmAt = 0;
  function confirmInline(_box, msg) {
    if (Date.now() - confirmAt < 3000) { confirmAt = 0; return true; }
    confirmAt = Date.now(); toast(msg + '，再点一次确认'); return false;
  }

  const piModal = h('div', { id: 'wat-pi-modal' });
  document.documentElement.appendChild(piModal);
  function showPiPreview(page) {
    piModal.innerHTML = '';
    const scale = Math.min(1, (window.innerHeight - 80) / 1123);
    const wrap = h('div', { style: 'transform:scale(' + scale + ');transform-origin:top center;box-shadow:0 8px 30px rgba(0,0,0,.3)' }, page);
    piModal.appendChild(h('div', { class: 'pim-bar' }, h('span', null, 'PI 预览（客户看到的样子）'), h('button', { onclick: () => { piModal.style.display = 'none'; } }, '关闭')));
    piModal.appendChild(h('div', { style: 'height:' + Math.ceil(1123 * scale) + 'px;display:flex;justify-content:center' }, wrap));
    piModal.style.display = 'block';
  }

  /* ---------- PI 设置 ---------- */
  function piSettingsSection() {
    const cfg = piCfg.get();
    const inputs = {};
    const f = (label, key, opts) => {
      opts = opts || {};
      const el = h(opts.area ? 'textarea' : 'input', { rows: opts.area ? '2' : null, placeholder: opts.ph || '', autocomplete: 'off' });
      if (!opts.area) el.type = 'text';
      el.value = cfg[key] == null ? '' : cfg[key];
      inputs[key] = el;
      return h('div', null, h('label', null, label), el);
    };
    const imgField = (label, key) => {
      const prev = h('img', { style: 'max-width:90px;max-height:90px;display:' + (cfg[key] ? 'block' : 'none') + ';margin-top:4px' });
      if (cfg[key]) prev.src = cfg[key];
      const file = h('input', { type: 'file', accept: 'image/*' });
      file.addEventListener('change', () => {
        const fl = file.files[0]; if (!fl) return;
        const rd = new FileReader();
        rd.onload = () => { cfg[key] = rd.result; prev.src = rd.result; prev.style.display = 'block'; };
        rd.readAsDataURL(fl);
      });
      const clear = h('button', { class: 'sec', onclick: () => { cfg[key] = ''; prev.style.display = 'none'; } }, '清除');
      return h('div', null, h('label', null, label), h('div', { style: 'display:flex;gap:8px;align-items:center' }, file, clear), prev);
    };
    const sec = h('div', { class: 'ws-pi' },
      h('div', { class: 'wp-muted' }, '这里填一次就行，以后每张 PI 都会自动带出。只保存在这台电脑的浏览器里。'),
      f('公司英文名', 'name'), f('公司中文名', 'nameCn'), f('公司地址', 'address', { area: true }),
      f('电话', 'phone'), f('邮箱', 'email'), f('网站', 'web'), f('联系人（显示在卖方栏）', 'contact'),
      imgField('Logo（可选）', 'logo'), imgField('公章图片（PNG 透明底效果最好）', 'seal'),
      f('收款人', 'bankBeneficiary'), f('开户银行', 'bankName'), f('银行地址', 'bankAddress'), f('SWIFT', 'bankSwift'), f('银行账号', 'bankAccount'),
      f('默认付款方式（可写中文）', 'payment', { area: true, ph: '如：30% T/T 定金，70% 发货前付清' }),
      f('默认交期（可写中文）', 'delivery', { area: true, ph: '如：收到定金后 30 天内发货' }),
      f('默认质保（可写中文）', 'warranty', { area: true }),
      f('默认起运港', 'pol'), f('默认贸易术语', 'incoterm'), f('PI 有效天数', 'validDays'), f('PI 编号前缀', 'prefix'));
    sec.save = () => {
      Object.keys(inputs).forEach((k) => { cfg[k] = inputs[k].value.trim(); });
      cfg.validDays = parseInt(cfg.validDays, 10) || 15;
      piCfg.set(cfg);
    };
    return sec;
  }

  /* ---------- 工具栏拖动 / 收起 ---------- */
  $('wat-handle').addEventListener('mousedown', (e) => {
    if (bar.classList.contains('in-panel')) return;
    e.preventDefault();
    const r = bar.getBoundingClientRect();
    dragging = { dx: e.clientX - r.left, dy: e.clientY - r.top };
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const left = Math.min(Math.max(0, e.clientX - dragging.dx), window.innerWidth - bar.offsetWidth);
    const top = Math.min(Math.max(0, e.clientY - dragging.dy), window.innerHeight - bar.offsetHeight);
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = null;
    const r = bar.getBoundingClientRect();
    store.set('barPos', { r: Math.round(window.innerWidth - r.right), b: Math.round(window.innerHeight - r.bottom) });
  });
  $('wat-handle').addEventListener('dblclick', () => { store.set('barPos', null); ui.position(); toast('工具栏已恢复默认位置'); });
  $('wat-min').addEventListener('click', () => {
    const v = !store.get('barMin', false);
    store.set('barMin', v);
    $('wat-min').textContent = v ? '+' : '–';
    ui.position();
  });
  $('wat-min').textContent = store.get('barMin', false) ? '+' : '–';

  ui.refresh();
  setInterval(ui.position, 500);
  scanIncoming();
  setInterval(scanIncoming, 3000); // 兜底：定时检查新消息/失败重试
  window.addEventListener('resize', ui.position);
})();
