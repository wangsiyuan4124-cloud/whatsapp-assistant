// 通话同传：关闭时不改音轨；打开后换成混音；翻译断开后回到原麦克风。
// 不打真 WhatsApp 电话，也不连 OpenAI。文件页才有 __WAT_CALL__。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(process.env.SCRIPT || path.join(__dirname, '..', 'whatsapp-assistant.user.js'), 'utf8');

function assert(cond, msg) {
  if (!cond) {
    console.log('FAIL', msg);
    process.exitCode = 1;
  } else console.log('ok', msg);
}

(async () => {
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERR', e.message));
  await page.goto('file://' + path.join(__dirname, 'page.html'));
  await page.addScriptTag({ content: code });
  await page.waitForSelector('#wat-call');

  assert(await page.evaluate(() => document.getElementById('wat-call').checked === false), 'toggle default off');
  assert(await page.evaluate(() => document.getElementById('wat-engine').value === 'ai'), 'text engine still ai');
  assert(await page.evaluate(() => !document.getElementById('wat-callbox')), 'overlay hidden until enabled');

  const pass = await page.evaluate(async () => {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    if (ctx.state === 'suspended') await ctx.resume();
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const track = dest.stream.getAudioTracks()[0];
    const pc = new RTCPeerConnection();
    pc.addTrack(track, dest.stream);
    const sender = pc.getSenders()[0];
    const id = sender.track.id;
    await sender.replaceTrack(track);
    const offer = await pc.createOffer();
    window.__pc = pc;
    window.__micId = id;
    window.__ctx = ctx;
    return {
      hooked: !!(window.__WAT_RTC__ && window.__WAT_RTC__.hooked),
      same: !!(sender.track && sender.track.id === id),
      offer: !!(offer && offer.sdp && offer.sdp.indexOf('m=audio') >= 0),
      state: ctx.state,
    };
  });
  assert(pass.hooked, 'hook installed');
  assert(pass.same, 'feature off keeps the mic track');
  assert(pass.offer, 'feature off can still negotiate audio');
  console.log('audio context', pass.state);

  const langs = await page.evaluate(() => {
    const d = window.__WAT_CALL__.detectLang;
    return {
      en: d('How much is the price for this car?'),
      es: d('¿Cuánto cuesta el carro usado?'),
      fr: d('Bonjour, quel est le prix de la voiture ?'),
      zh: d('这台瑞虎多少钱啊'),
      short: d('hello'),
    };
  });
  assert(langs.en === 'en', 'detect English ' + JSON.stringify(langs));
  assert(langs.es === 'es', 'detect Spanish ' + JSON.stringify(langs));
  assert(langs.fr === 'fr', 'detect French ' + JSON.stringify(langs));
  assert(langs.zh === 'zh', 'detect Chinese ' + JSON.stringify(langs));
  assert(langs.short === '', 'short text ignored ' + JSON.stringify(langs));

  await page.evaluate(() => GM_setValue('glossary', '二手车 = used car | carro usado | voiture d\'occasion'));
  const terms = await page.evaluate(() => window.__WAT_CALL__.terms());
  assert(terms.indexOf('Chery') >= 0 && terms.indexOf('used car') >= 0 && terms.indexOf('voiture d\'occasion') >= 0, 'terms merge glossary ' + terms.join(','));

  await page.click('#wat-set');
  await page.click('#wat-settings button.ws-tab >> text=通话同传');
  await page.fill('#wat-call-relay', 'https://relay.example/session');
  await page.fill('#wat-call-duck', '0');
  await page.fill('#wat-call-silence', '300');
  await page.fill('#wat-call-terms', 'Tiggo\n瑞虎');
  const save = page.locator('#wat-settings button', { hasText: '保存' }).last();
  await save.click();
  const saved = await page.evaluate(() => ({
    relay: GM_getValue('callRelay'),
    duck: GM_getValue('callDuck'),
    silence: GM_getValue('callSilenceMs'),
    terms: GM_getValue('callTerms'),
    on: GM_getValue('callOn') || false,
  }));
  assert(saved.relay === 'https://relay.example/session', 'relay saved ' + saved.relay);
  assert(saved.duck === 0, 'duck 0 saved ' + saved.duck);
  assert(saved.silence === 300, 'silence saved ' + saved.silence);
  assert(String(saved.terms).indexOf('瑞虎') >= 0, 'call terms saved');
  assert(saved.on === false, 'saving settings does not turn the feature on');

  await page.evaluate(() => {
    GM_setValue('callOutProvider', 'fake');
    GM_setValue('callInProvider', 'fake');
    window.__WAT_CALL__.setOn(true);
  });
  await page.waitForTimeout(200);
  const idle = await page.evaluate(() => window.__WAT_CALL__.state());
  assert(idle.enabled && /未检测到/.test(idle.status), 'no call yet: ' + idle.status);
  assert(/耳机/.test(idle.overlay), 'headphones warning visible');

  await page.evaluate(() => window.__WAT_CALL__.attach(window.__pc));
  await page.waitForTimeout(80);
  await page.mouse.click(20, 20);
  let live = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    live = await page.evaluate(() => {
      const s = window.__WAT_CALL__.state();
      return Object.assign({}, s, { micId: window.__micId });
    });
    if (live.mixed && live.senderTrackId && live.senderTrackId !== live.micId) break;
    await page.waitForTimeout(50);
  }
  const mixedOk = !!(live && live.mixed && live.senderTrackId && live.senderTrackId !== live.micId);
  if (!mixedOk) console.log('state while waiting for mix', JSON.stringify(live));
  assert(mixedOk, 'outgoing track replaced with the mix');

  await page.evaluate(() => window.__WAT_CALL__.failOut());
  let back = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 3000) {
    back = await page.evaluate(() => {
      const s = window.__WAT_CALL__.state();
      return Object.assign({}, s, { micId: window.__micId });
    });
    if (back.fallback && back.senderTrackId === back.micId && !back.mixed) break;
    await page.waitForTimeout(50);
  }
  if (!(back && back.fallback && !back.mixed)) console.log('state after fail', JSON.stringify(back));
  assert(back && back.fallback && back.senderTrackId === back.micId && !back.mixed, 'failure restores the original mic');
  assert(/原声/.test(back.status), 'status tells Leo the customer hears him ' + back.status);

  await page.evaluate(() => window.__WAT_CALL__.setOn(false));
  await page.waitForTimeout(100);
  const off = await page.evaluate(async () => {
    const s = window.__WAT_CALL__.state();
    const box = document.getElementById('wat-callbox');
    const sender = window.__pc.getSenders()[0];
    const otherCtx = window.__ctx;
    const osc = otherCtx.createOscillator();
    const dest = otherCtx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const other = dest.stream.getAudioTracks()[0];
    await sender.replaceTrack(other);
    return {
      hidden: !box || box.style.display === 'none',
      enabled: s.enabled,
      stuck: sender.track && sender.track.id === other.id,
    };
  });
  assert(off.hidden && off.enabled === false, 'overlay hides when off');
  assert(off.stuck, 'after off, replaceTrack is not forced back to the mix');

  await browser.close();
  if (process.exitCode) process.exit(process.exitCode);
  console.log('t14 passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
