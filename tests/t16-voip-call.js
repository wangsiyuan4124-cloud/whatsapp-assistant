// WhatsApp 网页版通话（2026-11 实测的做法）：不走 WebRTC 音轨。
// 麦克风：getUserMedia({audio:{sampleRate:16000,…}}) → 插件交回「虚拟麦克风」；
// 对方声音：AudioWorklet「voip-shared-buffer-playback-processor」接到扬声器 → 插件另接一路出字幕。
// 这里在本地页面上照着做一遍，用 fake 引擎，不打真电话。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const code = fs.readFileSync(process.env.SCRIPT || path.join(__dirname, '..', 'whatsapp-assistant.user.js'), 'utf8');

function assert(cond, msg) {
  if (!cond) { console.log('FAIL', msg); process.exitCode = 1; }
  else console.log('ok', msg);
}
const VOIP = { video: false, audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleSize: 16 } };
const WORKLET = [
  'class P extends AudioWorkletProcessor { constructor(){super();this.p=0;this.a=0.3;this.port.onmessage=(e)=>{this.a=e.data;};}',
  '  process(i,o){const ch=o[0][0];for(let k=0;k<ch.length;k++){ch[k]=this.a*Math.sin(this.p);this.p+=2*Math.PI*440/sampleRate;}return true;} }',
  "registerProcessor('voip-shared-buffer-playback-processor', P);",
  'class C extends AudioWorkletProcessor { process(){return true;} }',
  "registerProcessor('voip-shared-buffer-capture-processor', C);",
].join('\n');

(async () => {
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERR', e.message));
  // 本地文件页里 AudioWorklet 不能加载模块，所以起一个只在本机的临时 http 服务给测试页
  const server = require('http').createServer((req, res) => {
    if (req.url.endsWith('/worklet.js')) { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(WORKLET); }
    const file = path.join(__dirname, path.basename(req.url.split('?')[0]) || 'page.html');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await page.goto('http://localhost:' + port + '/page.html');
  await page.addScriptTag({ content: code });
  await page.waitForSelector('#wat-call');
  const state = () => page.evaluate(() => window.__WAT_CALL__.state());
  const waitFor = async (pred, label, ms) => {
    const t = Date.now();
    let last = null;
    while (Date.now() - t < (ms || 4000)) {
      last = await state();
      if (pred(last)) return last;
      await page.waitForTimeout(50);
    }
    console.log('timeout state', label, JSON.stringify(last));
    return last;
  };

  // 关着同传：WhatsApp 要到的就是原麦克风
  const offMapped = await page.evaluate(async (c) => {
    const s = await navigator.mediaDevices.getUserMedia(c);
    const r = window.__WAT_CALL__.state().voipMapped;
    s.getAudioTracks()[0].stop();
    return r;
  }, VOIP);
  assert(offMapped === false, 'feature off: WhatsApp gets the real mic');

  await page.evaluate(() => {
    GM_setValue('callRelay', 'https://relay.example/session');
    GM_setValue('callOutProvider', 'fake');
    GM_setValue('callInProvider', 'fake');
    GM_setValue('callDuck', 15);
    window.__WAT_CALL__.setOn(true);
  });
  await page.waitForTimeout(200);
  let s = await state();
  assert(s.enabled && !s.boxVisible, 'on but no call: overlay hidden (does not cover the chat)');
  const tip = await page.evaluate(() => { const l = document.getElementById('wat-call').closest('label'); return l ? l.title : ''; });
  assert(/等您/.test(tip), 'waiting hint is in the toolbar tooltip');

  // 通话前 WhatsApp 先用 audio:true 探一下麦克风：不应被换掉
  const probe = await page.evaluate(async () => {
    const st = await navigator.mediaDevices.getUserMedia({ audio: true });
    const r = window.__WAT_CALL__.state().voipMapped;
    st.getAudioTracks()[0].stop();
    return r;
  });
  assert(probe === false, 'audio:true probe is left alone');

  // 打电话：照 WhatsApp 的样子要麦克风、建 16k 采集和播放
  const call = await page.evaluate(async (args) => {
    const st = await navigator.mediaDevices.getUserMedia(args.c);
    const t = st.getAudioTracks()[0];
    window.__waMic = t;
    const cap = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    const play = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    window.__cap = cap; window.__play = play;
    const url = '/worklet.js';
    await play.audioWorklet.addModule(url);
    await cap.audioWorklet.addModule(url);
    const capNode = new AudioWorkletNode(cap, 'voip-shared-buffer-capture-processor', { numberOfInputs: 1, numberOfOutputs: 0 });
    cap.createMediaStreamSource(st).connect(capNode);
    // 量一下 WhatsApp 拿到的这条「麦克风」有没有声音
    const an = cap.createAnalyser();
    cap.createMediaStreamSource(st).connect(an);
    window.__an = an;
    const node = new AudioWorkletNode(play, 'voip-shared-buffer-playback-processor', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    node.connect(play.destination);
    window.__playNode = node;
    return { id: t.id, isAwn: node instanceof AudioWorkletNode };
  }, { c: VOIP, w: WORKLET });
  assert(call.isAwn, 'WhatsApp worklet node is still a real AudioWorkletNode');
  s = await waitFor((x) => x.voipMapped && x.voipRemote && x.engaged && x.phase === 'live', 'engaged');
  assert(s.voip && s.voipMapped, 'virtual mic handed to WhatsApp');
  assert(s.originalTrackId && s.originalTrackId !== call.id, 'WhatsApp got the virtual mic, not the raw mic');
  assert(s.voipRemote, 'playback processor tapped for captions');
  assert(s.engaged && s.ttsGain === 1 && Math.abs(s.duckGain - 0.15) < 0.01, 'translation engaged: TTS on, original ducked ' + s.ttsGain + ' ' + s.duckGain);
  assert(s.boxVisible && /通话同传/.test(s.overlay), 'overlay shows during the call');
  const rep = await page.evaluate(() => window.__watCallDiag());
  assert(rep && rep.state && rep.state.voip && rep.counts && rep.log.some((x) => x[1] === 'voipBegin') && !('overlay' in rep.state), 'diagnostic report available on the page (no captions text) ' + JSON.stringify(rep.counts));

  const rms = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 300));
    const b = new Float32Array(window.__an.fftSize);
    window.__an.getFloatTimeDomainData(b);
    let x = 0; for (let i = 0; i < b.length; i++) x += b[i] * b[i];
    return Math.sqrt(x / b.length);
  });
  assert(rms > 0.01, 'WhatsApp hears audio on the virtual mic (rms ' + rms.toFixed(3) + ')');

  // 翻译断开：立刻改回 100% 原声，WhatsApp 那条麦克风不断
  await page.evaluate(() => window.__WAT_CALL__.failOut());
  s = await waitFor((x) => x.fallback && x.duckGain === 1 && x.ttsGain === 0, 'fallback');
  assert(s.fallback && s.duckGain === 1 && s.ttsGain === 0, 'translation failure: back to 100% original, TTS muted');
  assert(await page.evaluate(() => window.__waMic.readyState === 'live'), 'WhatsApp mic stays live after failure');

  // 通话中关掉同传：继续送原声；再打开：重新接上翻译
  await page.evaluate(() => window.__WAT_CALL__.setOn(false));
  await page.waitForTimeout(150);
  s = await state();
  assert(!s.boxVisible && s.duckGain === 1 && s.ttsGain === 0, 'switched off mid-call: original voice, overlay hidden');
  assert(await page.evaluate(() => window.__waMic.readyState === 'live'), 'WhatsApp mic still live after switching off');
  await page.evaluate(() => window.__WAT_CALL__.setOn(true));
  s = await waitFor((x) => x.engaged && x.ttsGain === 1, 're-engage');
  assert(s.engaged && s.boxVisible, 'switched back on mid-call: translation re-engaged');

  // 外放模式（没有耳机时用）：对方一出声，就不把麦克风送去翻译、送给对方的原声也静音；
  // 对方停口、过了尾音、Leo 开口后才恢复
  await page.evaluate(() => {
    GM_setValue('callSpeakerHangMs', 300);
    GM_setValue('callRemoteRms', 0.02);
    GM_setValue('callLocalRms', 0.03);
    const sel = document.getElementById('wat-call-audio');
    sel.value = 'speaker';
    sel.dispatchEvent(new Event('change'));
  });
  s = await waitFor((x) => x.audioMode === 'speaker' && x.remoteHot && x.gateOpen === false && x.duckGain === 0, 'speaker gate closes');
  assert(s.audioMode === 'speaker' && s.remoteHot && s.gateOpen === false, 'speaker: customer voice from the playback processor closes the gate ' + s.lastRemoteRms);
  assert(s.duckGain === 0, 'speaker: original voice to the customer muted while they speak (no echo back)');
  assert(s.feedTrackId && s.feedTrackId === s.gateTrackId && s.feedTrackId !== s.originalTrackId, 'speaker: translator gets the gated mic');
  await page.evaluate(() => window.__playNode.port.postMessage(0));
  s = await waitFor((x) => !x.remoteHot && x.heardRemote, 'remote quiet');
  assert(!s.remoteHot, 'speaker: customer stops, hot flag clears');
  // 假设备麦克风一直有「嘀」声，相当于 Leo 在说话：门应重新打开
  s = await waitFor((x) => x.gateOpen && x.leoHot, 'reopen', 3000);
  assert(s.gateOpen && s.leoHot && Math.abs(s.duckGain - 0.15) < 0.01, 'speaker: Leo speaks, gate reopens and ducked original returns ' + s.lastLocalRms);
  await page.evaluate(() => {
    window.__playNode.port.postMessage(0.3);
    const sel = document.getElementById('wat-call-audio');
    sel.value = 'headphone';
    sel.dispatchEvent(new Event('change'));
  });
  s = await waitFor((x) => x.audioMode === 'headphone' && x.gateOpen, 'back to headphone');
  assert(s.gateOpen, 'back to headphone mode: continuous capture');

  // 浮层：收起 / 右栏打开时放到右栏底部，不压在聊天上
  await page.click('#wat-call-mini');
  const mini = await page.evaluate(() => {
    const b = document.getElementById('wat-callbox');
    return { mini: b.classList.contains('mini'), h: b.getBoundingClientRect().height, saved: GM_getValue('callBoxMini') };
  });
  assert(mini.mini && mini.h < 60 && mini.saved === true, 'collapse button shrinks the overlay ' + JSON.stringify(mini));
  await page.click('#wat-call-mini');
  const dock = await page.evaluate(() => {
    document.documentElement.classList.add('wat-docked');
    document.documentElement.style.setProperty('--wat-pw', '360px');
    const r = document.getElementById('wat-callbox').getBoundingClientRect();
    const out = { left: r.left, right: r.right, bottom: r.bottom, w: innerWidth, h: innerHeight };
    document.documentElement.classList.remove('wat-docked');
    return out;
  });
  assert(Math.abs(dock.right - dock.w) < 2 && dock.left >= dock.w - 362 && Math.abs(dock.bottom - dock.h) < 2, 'docked: overlay sits at the bottom of the right panel ' + JSON.stringify(dock));
  await page.click('#wat-call-x');
  s = await state();
  assert(!s.boxVisible && s.engaged, '× hides the overlay for this call, translation keeps running');
  await page.waitForTimeout(800);
  s = await state();
  assert(!s.boxVisible, 'overlay stays hidden after × until the call ends');

  // 挂断：WhatsApp 停掉它的麦克风、关掉播放 AudioContext
  await page.evaluate(async () => { window.__waMic.stop(); await window.__cap.close(); await window.__play.close(); });
  s = await waitFor((x) => !x.voip && x.phase === 'idle', 'hangup', 3000);
  assert(!s.voip && s.phase === 'idle' && !s.engaged, 'hang-up detected, call shut down');
  assert(s.lastMicState === 'ended', 'raw mic released after hang-up ' + s.lastMicState);
  await page.waitForTimeout(3200);
  s = await state();
  assert(!s.boxVisible, 'overlay hidden after the call');

  await page.evaluate(() => window.__WAT_CALL__.setOn(false));
  await browser.close();
  server.close();
  if (process.exitCode) process.exit(process.exitCode);
  console.log('t16 passed');
})().catch((e) => { console.error(e); process.exit(1); });
