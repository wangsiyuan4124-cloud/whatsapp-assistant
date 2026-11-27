// 阿里云百炼同声传译：假 WebSocket 走事件、60 秒错误后重连、对方方向只出文字。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const code = fs.readFileSync(process.env.SCRIPT || path.join(__dirname, '..', 'whatsapp-assistant.user.js'), 'utf8');

function assert(cond, msg) {
  if (!cond) { console.log('FAIL', msg); process.exitCode = 1; }
  else console.log('ok', msg);
}

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERR', e.message));
  await page.goto('file://' + path.join(__dirname, 'page.html'));
  await page.addScriptTag({ content: code });
  await page.waitForSelector('#wat-call');

  const phrases = await page.evaluate(() => {
    GM_setValue('glossary', '瑞虎 = Tiggo | Tiggo | Tiggo');
    GM_setValue('callTerms', 'Chery\nR8');
    const api = window.__WAT_CALL__;
    return {
      en: api.aliyunPhrases('en'),
      zh: api.aliyunPhrases('zh'),
      out: api.aliyunSession({ direction: 'out', lang: 'es', silenceMs: 400, phrases: api.aliyunPhrases('es') }),
      inn: api.aliyunSession({ direction: 'in', lang: 'zh', silenceMs: 400, phrases: api.aliyunPhrases('zh') }),
      url: api.aliyunWsUrl('https://relay.example/session', 'secret'),
      defaults: [api.state().outProvider, api.state().inProvider],
    };
  });
  assert(phrases.en['瑞虎'] === 'Tiggo' && phrases.en.Chery === 'Chery', 'glossary phrases for English ' + JSON.stringify(phrases.en));
  assert(phrases.zh.Tiggo === '瑞虎', 'incoming phrases map foreign names back to Chinese');
  assert(phrases.out.session.output_modalities.join(',') === 'text,audio', 'outgoing is text and audio');
  assert(phrases.out.session.translation.language === 'es', 'outgoing target follows the chosen language');
  assert(phrases.out.session.audio.output.voice === 'Tina', 'default voice is Tina');
  assert(phrases.out.session.audio.input.turn_detection.type === 'server_vad', 'uses server VAD');
  assert(phrases.inn.session.output_modalities.join(',') === 'text' && !phrases.inn.session.audio.output, 'incoming is text only');
  assert(phrases.url === 'wss://relay.example/aliyun?k=secret', 'relay url ' + phrases.url);
  assert(phrases.defaults[0] === 'aliyun' && phrases.defaults[1] === 'aliyun', 'default engine is Alibaba');

  await page.evaluate(() => {
    // 假中转：模拟 call-relay 的 HTTP 通道（open / send / poll / close），插件经 GM_xmlhttpRequest 访问。
    // WhatsApp 网页的 connect-src 会拦住网页自己的 WebSocket，所以这里一旦有人 new WebSocket 就记下来，最后检查为 0。
    window.__sockets = [];
    window.__wsCount = 0;
    const RealWS = window.WebSocket;
    window.WebSocket = function () { window.__wsCount++; return new RealWS(...arguments); };
    function Sess(url, auth) {
      this.url = url; this.auth = auth; this.sent = []; this.queue = []; this.waiter = null; this.closed = false;
      const self = this;
      setTimeout(() => self.push({ type: 'session.created' }), 15);
    }
    Sess.prototype.push = function (obj) {
      this.queue.push(JSON.stringify(obj));
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
    };
    Sess.prototype.server = function (obj) { this.push(obj); };
    const prevGM = window.GM_xmlhttpRequest;
    window.GM_xmlhttpRequest = (o) => {
      const m = /\/aliyun\/(open|send|poll|close)(?:\?id=(\d+))?$/.exec(o.url || '');
      if (!m) return prevGM(o);
      const reply = (status, body) => setTimeout(() => o.onload({ status, responseText: JSON.stringify(body) }), 2);
      const auth = (o.headers && o.headers.Authorization) || '';
      if (m[1] === 'open') {
        const s = new Sess(o.url, auth);
        window.__sockets.push(s);
        return reply(200, { id: String(window.__sockets.length - 1) });
      }
      const s = window.__sockets[Number(m[2])];
      if (!s || s.closed) return reply(404, { error: 'no such session' });
      if (m[1] === 'send') {
        JSON.parse(o.data).forEach((t) => {
          const msg = JSON.parse(t);
          s.sent.push(msg);
          if (msg.type === 'session.update') setTimeout(() => s.push({ type: 'session.updated', session: msg.session }), 5);
        });
        return reply(200, { ok: true });
      }
      if (m[1] === 'close') { s.closed = true; return reply(200, { ok: true }); }
      const flush = () => reply(200, { events: s.queue.splice(0), closed: s.closed });
      if (s.queue.length) return flush();
      s.waiter = flush;
      setTimeout(() => { if (s.waiter === flush) { s.waiter = null; flush(); } }, 300);
    };
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const pc = new RTCPeerConnection();
    pc.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
    window.__pc = pc;
    window.__remote = dest.stream.getAudioTracks()[0];
    GM_setValue('callRelay', 'https://relay.example/session');
    GM_setValue('callRelayKey', 'secret');
    GM_setValue('callOutProvider', 'aliyun');
    GM_setValue('callInProvider', 'aliyun');
    GM_setValue('callAudioMode', 'headphone');
    window.__WAT_CALL__.setOn(true);
    window.__WAT_CALL__.attach(pc);
  });

  const wait = async (pred, label) => {
    const t = Date.now();
    let last = null;
    while (Date.now() - t < 4000) {
      last = await page.evaluate(pred);
      if (last) return last;
      await page.waitForTimeout(40);
    }
    throw new Error(label + ' ' + JSON.stringify(last));
  };

  const outUpdate = await wait(() => {
    const sock = window.__sockets[0];
    if (!sock) return null;
    return sock.sent.find((m) => m.type === 'session.update') || null;
  }, 'outgoing session.update missing');
  assert(outUpdate.session.output_modalities.indexOf('audio') >= 0, 'live outgoing asks for audio');
  assert(outUpdate.session.translation.corpus.phrases['瑞虎'] === 'Tiggo', 'corpus sent on the socket');
  const first = await page.evaluate(() => ({ url: window.__sockets[0].url, auth: window.__sockets[0].auth, ws: window.__wsCount }));
  assert(first.url === 'https://relay.example/aliyun/open' && first.auth === 'Bearer secret', 'connects via the relay over GM_xmlhttpRequest ' + JSON.stringify(first));
  const audioSent = await wait(() => window.__sockets[0].sent.some((m) => m.type === 'input_audio_buffer.append'), 'no audio reached the relay');
  assert(audioSent, 'microphone audio is sent through the relay channel');

  await page.evaluate(() => {
    window.__sockets[0].server({ type: 'response.audio_transcript.delta', delta: 'The Tiggo is ready' });
    window.__sockets[0].server({ type: 'response.audio.delta', delta: btoa('aaaa') });
  });
  await page.waitForTimeout(80);
  const shown = await page.evaluate(() => window.__WAT_CALL__.state().overlay);
  assert(shown.indexOf('The Tiggo is ready') >= 0, 'outgoing transcript is shown');
  const stillUp = await page.evaluate(() => window.__WAT_CALL__.state());
  assert(stillUp.fallback === false && stillUp.engaged === true, 'audio delta does not drop the call');

  await page.evaluate(() => {
    window.__WAT_CALL__.watchRemote(window.__remote);
    window.__WAT_CALL__.attach(window.__pc);
  });
  const inn = await wait(() => {
    const sock = window.__sockets.find((s, i) => i > 0 && s.sent.some((m) => m.type === 'session.update' && m.session.output_modalities.join(',') === 'text'));
    if (!sock) return null;
    return sock.sent.find((m) => m.type === 'session.update');
  }, 'incoming text-only session missing');
  assert(inn.session.output_modalities.join(',') === 'text' && !inn.session.audio.output, 'incoming websocket is text only');
  await page.evaluate(() => {
    const sock = window.__sockets.find((s) => s.sent.some((m) => m.session && m.session.output_modalities && m.session.output_modalities.join(',') === 'text'));
    sock.server({ type: 'response.text.delta', delta: '客户说瑞虎' });
  });
  await page.waitForTimeout(50);
  const sub = await page.evaluate(() => window.__WAT_CALL__.state().overlay);
  assert(sub.indexOf('客户说瑞虎') >= 0, 'incoming subtitle uses the text delta');

  await page.evaluate(() => {
    window.__sockets[0].server({ type: 'error', error: { message: 'no semantic result after merged audio exceeded 60s' } });
  });
  const again = await wait(() => {
    if (window.__sockets.length < 3) return null;
    const fresh = window.__sockets[window.__sockets.length - 1];
    const upd = fresh.sent.find((m) => m.type === 'session.update');
    return upd && upd.session.output_modalities.indexOf('audio') >= 0 ? upd : null;
  }, 'did not reconnect after the 60s error');
  const after = await page.evaluate(() => window.__WAT_CALL__.state());
  assert(again.session.translation.language === 'en' || again.session.translation.language === 'es', 'reconnected session keeps a target language ' + again.session.translation.language);
  assert(after.fallback === false, '60s silence reconnect does not fall back to the raw mic ' + after.status);
  assert(await page.evaluate(() => window.__wsCount) === 0, 'never uses the page WebSocket (WhatsApp connect-src would block it)');

  // 中转连不上（会话一打开就被关掉）：要让启动失败并改回原声，不能一直卡在「正在连接」
  await page.evaluate(() => {
    const prev = window.GM_xmlhttpRequest;
    window.GM_xmlhttpRequest = (o) => {
      if (/\/aliyun\/open$/.test(o.url || '')) return setTimeout(() => o.onload({ status: 503, responseText: '{"error":"aliyun not configured"}' }), 2);
      return prev(o);
    };
    window.__WAT_CALL__.failOut && window.__WAT_CALL__.failOut();
    window.__sockets.forEach((s) => { s.closed = true; if (s.waiter) { const w = s.waiter; s.waiter = null; w(); } });
  });
  const down = await wait(() => {
    const st = window.__WAT_CALL__.state();
    return st.fallback ? st : null;
  }, 'relay down did not fall back to the original mic');
  assert(down.fallback === true && /原声/.test(down.status), 'relay down falls back to the original mic: ' + down.status);

  await browser.close();
  if (process.exitCode) process.exit(process.exitCode);
  console.log('t15 passed');
})().catch((e) => { console.error(e); process.exit(1); });
