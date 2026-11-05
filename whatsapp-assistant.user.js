// ==UserScript==
// @name         WhatsApp 发送翻译助手（中文→外语）
// @namespace    rely-whatsapp-translator
// @version      1.3.1
// @description  在 WhatsApp 网页版输入中文，自动翻译成英文/其他语言再发送；对方发来的外语自动在原文下方显示中文译文；AI 分析客户级别并给出回复建议。
// @match        https://web.whatsapp.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      translate.googleapis.com
// @connect      edge.microsoft.com
// @connect      api-edge.cognitive.microsofttranslator.com
// @connect      api.deepseek.com
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
  #wat-toast{position:fixed;z-index:10000;left:50%;bottom:90px;transform:translateX(-50%);max-width:60vw;white-space:pre-wrap;
    background:#111b21;color:#fff;padding:8px 14px;border-radius:10px;font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif;
    box-shadow:0 4px 14px rgba(0,0,0,.25);display:none}
  #wat-toast.err{background:#c62828}
  .wat-tr{direction:ltr;text-align:left;unicode-bidi:plaintext;margin-top:4px;padding-top:4px;border-top:1px dashed rgba(0,0,0,.18);color:#027eb5;font-size:.93em;line-height:1.45;white-space:pre-wrap;word-break:break-word}
  .wat-tr::before{content:"译：";color:#8696a0}
  .wat-tr.wat-tr-err{color:#c62828}
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
  .ws-card input[type=password],.ws-card textarea{width:100%;box-sizing:border-box;border:1px solid #d1d7db;border-radius:8px;padding:6px 8px;font:12px/1.5 system-ui,"Microsoft YaHei",sans-serif;resize:vertical}
  .ws-pb{max-height:220px;overflow:auto;border:1px solid #e9edef;border-radius:8px;padding:4px}
  .ws-pbi{display:flex;gap:6px;align-items:flex-start;padding:4px;border-bottom:1px solid #f0f2f5}
  .ws-pbt{flex:1;font-size:12px}
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
    <select id="wat-engine" title="翻译引擎（失败会自动换另一个）"><option value="google">谷歌</option><option value="microsoft">微软</option></select>
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
    saveAnalysis(name, result) {
      const all = ai.analyses();
      all[name] = { level: result.level, result, at: Date.now() };
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
      '2. 给 2～3 条思路不同的建议回复（每条不超过 60 个单词），每条都要推进一个具体目标：补齐缺失信息、消除顾虑或推进成交。如果最后一条是我方发的、客户还没回，就给跟进话术。',
      '3. 只输出 JSON，不要任何其他文字。格式：',
      '{"level":"A|B|C|D","customer_type":"个人|经销商|未知","language":"客户语言，如 English/Español",' +
        '"reason":"一句话中文理由","known":{"国家":"","车型":"","数量":"","预算":"","付款方式":"","购买时间":""},' +
        '"missing":["还缺的关键信息，中文"],"suggestions":[{"scene":"场景，中文","goal":"这条回复的目的，中文","reply":"客户语言的回复原文","reply_zh":"中文意思"}],' +
        '"next_followup":{"when":"建议跟进时间，如 明天上午","action":"中文，跟进做什么"}}',
    ].join('\n');
    return { system, user: convText(conv, chatName) };
  }

  function callDeepSeek(messages, maxTokens) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.deepseek.com/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ai.apiKey },
        data: JSON.stringify({
          model: 'deepseek-chat',
          messages,
          response_format: { type: 'json_object' },
          temperature: 0.4,
          max_tokens: maxTokens || 1500,
        }),
        timeout: 90000,
        onload: (r) => {
          if (r.status === 401) return reject(new Error('API Key 不正确，请在设置里检查'));
          if (r.status === 402) return reject(new Error('DeepSeek 账户余额不足，请充值'));
          if (r.status < 200 || r.status >= 300) return reject(new Error('DeepSeek 返回错误 HTTP ' + r.status));
          try {
            const data = JSON.parse(r.responseText);
            const txt = data.choices[0].message.content;
            resolve({ json: JSON.parse(txt.replace(/^```(json)?|```$/g, '').trim()), raw: txt });
          } catch (e) { reject(new Error('AI 返回的内容无法解析，请重试')); }
        },
        onerror: () => reject(new Error('连不上 DeepSeek，请检查网络')),
        ontimeout: () => reject(new Error('DeepSeek 响应超时，请重试')),
      });
    });
  }

  function normalizeResult(r) {
    r = r || {};
    const lv = String(r.level || '').trim().toUpperCase().charAt(0);
    r.level = 'ABCD'.includes(lv) && lv ? lv : 'C';
    r.known = r.known && typeof r.known === 'object' ? r.known : {};
    r.missing = Array.isArray(r.missing) ? r.missing : [];
    r.suggestions = Array.isArray(r.suggestions) ? r.suggestions.filter((s) => s && s.reply).slice(0, 3) : [];
    r.next_followup = r.next_followup || {};
    return r;
  }

  /* ---------- 自动加入 WhatsApp Business 列表（A/B/C/D） ---------- */
  function findListButton() {
    return [...document.querySelectorAll('#main header [role="button"], #main header button')]
      .find((b) => /添加到列表|加入列表|Add to list/i.test(b.getAttribute('aria-label') || ''));
  }
  async function openListMenu() {
    const btn = findListButton();
    if (!btn) return null;
    btn.click();
    for (let i = 0; i < 15; i++) {
      await sleep(100);
      const m = document.querySelector('[role="menu"]');
      if (m && m.querySelector('[role="menuitemcheckbox"]')) return m;
    }
    return null;
  }
  function closeMenu() {
    const m = document.querySelector('[role="menu"]');
    if (!m) return;
    const ev = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', ev));
    m.dispatchEvent(new KeyboardEvent('keydown', ev));
  }
  const levelOfItem = (li) => {
    const m = (li.innerText || '').trim().match(/^([ABCD])(?:\s|级|$)/i);
    return m ? m[1].toUpperCase() : null;
  };
  // chatName：开始时的聊天；中途发现切换了聊天就立即停止，避免标错人
  async function applyLevelList(level, chatName) {
    const stillSame = () => getChatName() === chatName;
    for (let round = 0; round < 6; round++) {
      if (!stillSame()) { closeMenu(); return { ok: false, msg: '聊天已切换，已停止加入列表，请回到该客户重新分析' }; }
      const menu = await openListMenu();
      if (!menu) return { ok: false, msg: '没找到「添加到列表」按钮' };
      if (!stillSame()) { closeMenu(); return { ok: false, msg: '聊天已切换，已停止加入列表，请回到该客户重新分析' }; }
      const items = [...menu.querySelectorAll('[role="menuitemcheckbox"]')].filter(levelOfItem);
      if (!items.length) { closeMenu(); return { ok: false, msg: '没找到 A/B/C/D 列表，请先在 WhatsApp 里建好' }; }
      const wrong = items.find((li) => (levelOfItem(li) === level) !== (li.getAttribute('aria-checked') === 'true'));
      if (!wrong) { closeMenu(); await sleep(150); closeMenu(); return { ok: true }; }
      wrong.click();
      await sleep(500);
      closeMenu();
      await sleep(250);
    }
    closeMenu();
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
  document.documentElement.style.setProperty('--wat-pw', PANEL_W + 'px');
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
    panel.appendChild(h('div', { class: 'wp-head' },
      h('b', null, title || '客户分析'),
      h('span', { class: 'wp-sub' }, panelChat),
      h('button', { class: 'wp-x', title: '关闭第三栏', onclick: () => dock(false) }, '×')));
    panel.appendChild(h('div', { class: 'wp-slot', id: 'wat-barslot' }));
    panel.appendChild(h('div', { class: 'wp-body' }, content));
    dock(true);
  }

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
      box.appendChild(h('div', { class: 'wp-sug' },
        h('div', { class: 'wp-goal' }, (s.scene ? '【' + s.scene + '】' : '') + (s.goal || '')),
        h('div', { class: 'wp-reply' }, String(s.reply)),
        s.reply_zh ? h('div', { class: 'wp-zh' }, '中文：' + s.reply_zh) : null,
        h('div', { class: 'wp-btns' },
          h('button', { onclick: () => fillInput(s.reply) }, '填入'),
          h('button', { class: 'sec', onclick: () => openRefine(s, r) }, '✎ 和 AI 改一改'),
          saveBtn)));
    });

    const nf = r.next_followup || {};
    if (nf.when || nf.action) {
      box.appendChild(h('div', { class: 'wp-sec' }, '下一步'));
      box.appendChild(h('div', null, '⏰ ' + [nf.when, nf.action].filter(Boolean).join(' · ')));
    }
    box.appendChild(h('div', { class: 'wp-foot' },
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
    const saved = ai.analyses()[getChatName()];
    if (saved) showPanel(renderResult(normalizeResult(saved.result), saved.at));
    else showNotAnalyzed();
  }

  function showNotAnalyzed() {
    panelView = 'result';
    showPanel(h('div', { style: 'padding:24px 0;text-align:center' },
      h('div', { class: 'wp-muted', style: 'margin-bottom:10px' }, '这个客户还没有分析'),
      h('button', { onclick: () => analyzeCurrent(true) }, '分析客户')));
  }

  function saveMyLastMessage() {
    const mine = readConversation(80).filter((m) => m.from === '我方' && !/^\[(图片|语音|视频|文件)\]$/.test(m.text));
    const last = mine[mine.length - 1];
    if (!last) { toast('这个聊天里没有找到你发的文字消息', true); return; }
    const rec = ai.analyses()[getChatName()];
    savePb(last.text, '', '我的回复', rec ? rec.level : '');
  }

  let analyzing = false;
  async function analyzeCurrent(force) {
    const name = getChatName();
    if (!document.querySelector('#main') || !name) { toast('请先打开一个聊天', true); return; }
    panelChat = name;
    panelView = 'result';
    if (!ai.apiKey) {
      showPanel(h('div', null, h('p', null, '还没有填写 DeepSeek API Key。'), h('button', { onclick: openSettings }, '打开设置')));
      return;
    }
    const saved = ai.analyses()[name];
    if (saved && !force) { showPanel(renderResult(normalizeResult(saved.result), saved.at)); return; }
    if (analyzing) return;
    const conv = readConversation(60);
    if (!conv.length) { toast('这个聊天里没有可分析的文字消息', true); return; }
    analyzing = true;
    showPanel(h('div', { class: 'wp-muted', style: 'padding:20px 0;text-align:center' }, '正在分析 ' + conv.length + ' 条消息…'));
    try {
      const { system, user } = buildPrompt(conv, name);
      const r = normalizeResult((await callDeepSeek([{ role: 'system', content: system }, { role: 'user', content: user }])).json);
      ai.saveAnalysis(name, r);
      if (getChatName() === name && panelView === 'result') showPanel(renderResult(r, Date.now()));
      if (ai.autoLabel && getChatName() === name) {
        const res = await applyLevelList(r.level, name);
        toast(res.ok ? '已加入列表「' + r.level + ' ' + LEVEL_NAME[r.level] + '」' : res.msg, !res.ok);
      }
    } catch (e) {
      if (getChatName() === name) showPanel(h('div', null, h('p', { style: 'color:#c62828' }, '分析失败：' + e.message), h('button', { onclick: () => analyzeCurrent(true) }, '重试')));
      else toast('分析失败：' + e.message, true);
    } finally {
      analyzing = false;
    }
  }

  // 切换聊天时：第三栏跟着切换到该客户的分析结果
  function syncPanel() {
    const name = getChatName();
    if (!document.documentElement.classList.contains('wat-docked')) return;
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
    panelView = 'result';
    const saved = ai.analyses()[name];
    if (saved) showPanel(renderResult(normalizeResult(saved.result), saved.at));
    else showNotAnalyzed();
  }
  setInterval(syncPanel, 700);
  if (store.get('docked', false)) { document.documentElement.classList.add('wat-docked'); panel.style.display = 'flex'; syncPanel(); }

  /* ---------- 设置面板 ---------- */
  const setDlg = h('div', { id: 'wat-settings' });
  document.documentElement.appendChild(setDlg);

  function openSettings() {
    setDlg.innerHTML = '';
    const keyIn = h('input', { type: 'password', placeholder: 'sk-…', autocomplete: 'off' });
    keyIn.value = ai.apiKey;
    const bizIn = h('textarea', { rows: '4' }); bizIn.value = ai.biz;
    const priceIn = h('textarea', { rows: '5', placeholder: '例：R8 标准版 FOB 上海 USD xxxx；运到伯利兹城落地价 USD xxxx；付款：T/T 30% 定金，70% 发货前付清；交期：付款后 xx 天（留空则 AI 不提任何价格和条件）' }); priceIn.value = ai.prices;
    const rulesIn = h('textarea', { rows: '5' }); rulesIn.value = ai.rules;
    const labelIn = h('input', { type: 'checkbox' }); labelIn.checked = ai.autoLabel;
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
    setDlg.appendChild(h('div', { class: 'ws-card' },
      h('div', { class: 'wp-head' }, h('b', null, '翻译助手设置'), h('button', { class: 'wp-x', onclick: () => { setDlg.style.display = 'none'; } }, '×')),
      h('label', null, 'DeepSeek API Key（只保存在这台电脑的浏览器里）'), keyIn,
      h('label', null, '我方业务介绍'), bizIn,
      h('label', null, '价格表与交易条款（价格、付款方式、交期等，AI 只会引用这里写的）'), priceIn,
      h('label', null, '客户分级标准'), rulesIn,
      h('label', { class: 'ws-inline' }, labelIn, ' 分析后自动加入 WhatsApp 的 A/B/C/D 列表'),
      h('label', null, '话术库（共 ' + ai.playbook().length + ' 条，新收藏的在上面；带 [方括号备注] 的不会交给 AI）'), pbBox,
      h('div', { class: 'wp-btns', style: 'justify-content:flex-end;margin-top:10px' },
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
          setDlg.style.display = 'none';
          toast('设置已保存');
        } }, '保存'))));
    setDlg.style.display = 'flex';
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
