// ==UserScript==
// @name         WhatsApp 发送翻译助手（中文→外语）
// @namespace    rely-whatsapp-translator
// @version      1.1.1
// @description  在 WhatsApp 网页版输入中文，自动翻译成英文/其他语言再发送；对方发来的外语自动在原文下方显示中文译文。
// @match        https://web.whatsapp.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      translate.googleapis.com
// @connect      edge.microsoft.com
// @connect      api-edge.cognitive.microsofttranslator.com
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
    get engine() { return store.get('engine', 'google'); },
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
      const res = await translate(original, lang);
      if (getInputText(el) !== original) { toast('输入内容已改变，已取消本次翻译', true); return; }
      if (!(await replaceInputText(el, res.text))) { toast('无法写入输入框，请刷新页面后重试', true); return; }
      lastTranslated = getInputText(el);
      if (andSend) {
        await sleep(120);
        if (!clickSend()) toast('未找到发送按钮，请手动按回车', true);
        else toast('已发送（' + lang.toUpperCase() + '）：' + res.text + '\n原文：' + original);
      } else {
        toast('已翻译为 ' + lang.toUpperCase() + '，检查后按回车发送');
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
    box.textContent = res.err ? '（翻译失败，稍后自动重试）' : res.text;
    box.classList.toggle('wat-tr-err', !!res.err);
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
    main.querySelectorAll('[data-testid^="conv-msg-"], .message-in').forEach((row) => {
      if (!isIncoming(row, mainRect)) return;
      const span = getMsgTextSpan(row);
      if (!span) return;
      const text = (span.innerText || '').trim();
      if (!text || text.length > 3000) return;
      if (/\p{L}/u.test(text)) lastInText = text; // 纯表情不算
      if (!needsTranslate(text)) return;
      const cached = trCache.get(text);
      if (cached && cached.err && Date.now() - cached.at > 30000) trCache.delete(text);
      const c = trCache.get(text);
      if (c) {
        const box = trBoxOf(span);
        if (!box || box.dataset.src !== text) renderTr(span, text, c);
        return;
      }
      if (!pending.has(text)) { pending.add(text); queue.push(text); }
    });
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
  #wat-bar{position:fixed;z-index:9999;display:none;align-items:center;gap:6px;padding:4px 8px;
    background:#fff;color:#111;border:1px solid #d1d7db;border-radius:16px;font:12px/1.4 system-ui,"Microsoft YaHei",sans-serif;
    box-shadow:0 2px 8px rgba(0,0,0,.12)}
  #wat-bar select{font:inherit;border:1px solid #d1d7db;border-radius:8px;padding:1px 2px;background:#fff;color:#111;max-width:150px}
  #wat-bar label{display:flex;align-items:center;gap:3px;cursor:pointer;white-space:nowrap}
  #wat-bar button{white-space:nowrap;font:inherit;border:0;border-radius:10px;padding:2px 8px;background:#25d366;color:#fff;cursor:pointer}
  #wat-bar button:disabled{opacity:.5;cursor:default}
  #wat-bar .wat-off{background:#8696a0}
  #wat-toast{position:fixed;z-index:10000;left:50%;bottom:90px;transform:translateX(-50%);max-width:60vw;white-space:pre-wrap;
    background:#111b21;color:#fff;padding:8px 14px;border-radius:10px;font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif;
    box-shadow:0 4px 14px rgba(0,0,0,.25);display:none}
  #wat-toast.err{background:#c62828}
  .wat-tr{direction:ltr;text-align:left;unicode-bidi:plaintext;margin-top:4px;padding-top:4px;border-top:1px dashed rgba(0,0,0,.18);color:#027eb5;font-size:.93em;line-height:1.45;white-space:pre-wrap;word-break:break-word}
  .wat-tr::before{content:"译：";color:#8696a0}
  .wat-tr.wat-tr-err{color:#c62828}
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
    <span title="WhatsApp 发送翻译">🌐</span>
    <select id="wat-lang" title="本聊天发送语言（每个聊天单独记忆）">${LANGS.map(([c, n]) => `<option value="${c}">${n}</option>`).join('')}</select>
    <label title="开启后：输入含中文时按回车，自动翻译并发送"><input type="checkbox" id="wat-auto">回车自动翻译发送</label>
    <label title="对方发来的外语消息，在原文下方自动显示中文译文"><input type="checkbox" id="wat-in">对方消息译中文</label>
    <select id="wat-engine" title="翻译引擎（失败会自动换另一个）"><option value="google">谷歌</option><option value="microsoft">微软</option></select>
    <button id="wat-go" title="只翻译不发送（快捷键 Ctrl+Enter）">翻译</button>
    <button id="wat-power" title="暂停/启用翻译助手">开</button>`;
  document.documentElement.appendChild(bar);

  const $ = (id) => bar.querySelector('#' + id);
  const toastEl = document.createElement('div');
  toastEl.id = 'wat-toast';
  document.documentElement.appendChild(toastEl);
  let toastTimer;
  function toast(msg, isErr) {
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
      const footer = document.querySelector('#main footer');
      if (!footer) { bar.style.display = 'none'; return; }
      const r = footer.getBoundingClientRect();
      bar.style.display = 'flex';
      bar.style.top = Math.max(0, r.top - bar.offsetHeight - 6) + 'px';
      bar.style.left = (r.right - bar.offsetWidth - 12) + 'px';
      const chat = getChatName();
      if (chat !== ui.lastChat) { ui.lastChat = chat; ui.refresh(); }
    },
  };

  $('wat-lang').addEventListener('change', (e) => { setChatLang(e.target.value); toast('本聊天发送语言：' + e.target.value.toUpperCase()); });
  $('wat-auto').addEventListener('change', (e) => { settings.autoSend = e.target.checked; });
  $('wat-in').addEventListener('change', (e) => { settings.autoIn = e.target.checked; scanIncoming(); });
  $('wat-engine').addEventListener('change', (e) => { settings.engine = e.target.value; msToken = null; });
  $('wat-go').addEventListener('click', () => translateInput(false));
  $('wat-power').addEventListener('click', () => { settings.enabled = !settings.enabled; ui.refresh(); scanIncoming(); toast(settings.enabled ? '翻译助手已启用' : '翻译助手已暂停'); });

  ui.refresh();
  setInterval(ui.position, 500);
  scanIncoming();
  setInterval(scanIncoming, 3000); // 兜底：定时检查新消息/失败重试
  window.addEventListener('resize', ui.position);
})();
