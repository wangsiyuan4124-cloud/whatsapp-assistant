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
    window.__sockets = [];
    function FakeWS(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      window.__sockets.push(this);
      const self = this;
      setTimeout(() => {
        self.readyState = 1;
        if (self.onopen) self.onopen();
        if (self.onmessage) self.onmessage({ data: JSON.stringify({ type: 'session.created' }) });
      }, 15);
    }
    FakeWS.prototype.send = function (data) {
      const msg = JSON.parse(data);
      this.sent.push(msg);
      if (msg.type === 'session.update' && this.onmessage) {
        const self = this;
        setTimeout(() => self.onmessage({ data: JSON.stringify({ type: 'session.updated', session: msg.session }) }), 5);
      }
    };
    FakeWS.prototype.close = function () {
      this.readyState = 3;
      if (this.onclose) this.onclose();
    };
    FakeWS.prototype.server = function (obj) {
      if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
    };
    window.WebSocket = FakeWS;
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
  const url = await page.evaluate(() => window.__sockets[0].url);
  assert(url.indexOf('wss://relay.example/aliyun?k=secret') === 0, 'connects via the relay ' + url);

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

  await browser.close();
  if (process.exitCode) process.exit(process.exitCode);
  console.log('t15 passed');
})().catch((e) => { console.error(e); process.exit(1); });
