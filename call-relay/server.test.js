'use strict';

const http = require('http');
const { allowedTarget, createServer, aliyunUpstreamUrl } = require('./server');
const { acceptBrowser } = require('./wsutil');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL', msg); process.exitCode = 1; }
  else console.log('ok', msg);
}

function once(server, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, method, path, headers: headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

(async () => {
  const ok = allowedTarget('https://api.openai.com/v1/realtime/translations/client_secrets');
  assert(ok && ok.pathname.indexOf('/v1/realtime/') === 0, 'allows realtime client secret url');
  assert(!allowedTarget('http://api.openai.com/v1/realtime/client_secrets'), 'rejects http');
  assert(!allowedTarget('https://evil.example/v1/realtime/client_secrets'), 'rejects other host');
  assert(!allowedTarget('https://api.openai.com/v1/chat/completions'), 'rejects non-realtime path');

  const seen = [];
  const server = createServer({
    openaiKey: 'sk-test',
    relayKey: 'secret',
    forward: async (target, key, body) => {
      seen.push({ href: target.href, key, model: body.session && body.session.model });
      return { status: 200, body: JSON.stringify({ value: 'ek_test' }) };
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const health = await once(server, 'GET', '/health');
    assert(health.status === 200 && JSON.parse(health.body).ok === true, 'health');
    const denied = await once(server, 'POST', '/session', { 'Content-Type': 'application/json' }, '{}');
    assert(denied.status === 401, 'rejects missing relay key');
    const bad = await once(server, 'POST', '/session', {
      'Content-Type': 'application/json', Authorization: 'Bearer secret',
    }, JSON.stringify({ url: 'https://example.com/steal', body: {} }));
    assert(bad.status === 400, 'rejects non-openai url');
    const minted = await once(server, 'POST', '/session', {
      'Content-Type': 'application/json', Authorization: 'Bearer secret',
    }, JSON.stringify({
      url: 'https://api.openai.com/v1/realtime/translations/client_secrets',
      body: { session: { model: 'gpt-realtime-translate' } },
    }));
    assert(minted.status === 200 && JSON.parse(minted.body).value === 'ek_test', 'mints ephemeral token');
    assert(seen.length === 1 && seen[0].key === 'sk-test' && seen[0].model === 'gpt-realtime-translate', 'forwards openai key and body');
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert(aliyunUpstreamUrl('ws-abc', 'qwen3.8-livetranslate-flash-realtime').indexOf('wss://ws-abc.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=') === 0, 'beijing workspace url');
  assert(!aliyunUpstreamUrl('bad host'), 'rejects workspace with spaces');

  const upstream = http.createServer();
  const seenAuth = [];
  const seenMsg = [];
  upstream.on('upgrade', (req, socket) => {
    seenAuth.push(req.headers.authorization || '');
    const peer = acceptBrowser(req, socket);
    if (!peer) return;
    peer.onFrame((text) => {
      seenMsg.push(text);
      peer.send(JSON.stringify({ type: 'session.created', echo: JSON.parse(text).type }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const relay = createServer({
    relayKey: 'secret',
    dashscopeKey: 'sk-aliyun',
    aliyunUrl: 'ws://127.0.0.1:' + upstream.address().port + '/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime',
  });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  try {
    const deniedWs = await new Promise((resolve) => {
      const ws = new WebSocket('ws://127.0.0.1:' + relay.address().port + '/aliyun?k=wrong');
      ws.onopen = () => resolve('open');
      ws.onerror = () => resolve('error');
      ws.onclose = () => resolve('close');
    });
    assert(deniedWs !== 'open', 'aliyun proxy rejects bad relay key');
    const forwarded = await new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:' + relay.address().port + '/aliyun?k=secret');
      const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('aliyun proxy timeout')); }, 3000);
      ws.onmessage = (ev) => { clearTimeout(timer); resolve(JSON.parse(ev.data)); try { ws.close(); } catch (e) {} };
      ws.onopen = () => ws.send(JSON.stringify({ type: 'session.update', session: { output_modalities: ['text'] } }));
      ws.onerror = () => { clearTimeout(timer); try { ws.close(); } catch (e) {} reject(new Error('aliyun proxy failed')); };
    });
    assert(forwarded.type === 'session.created', 'proxies aliyun events');
    assert(seenAuth.indexOf('Bearer sk-aliyun') >= 0, 'upstream sees the server key, not the relay key');
    assert(seenMsg.some((t) => t.indexOf('session.update') >= 0), 'forwards client session.update');
  } finally {
    await new Promise((r) => relay.close(r));
    await new Promise((r) => upstream.close(r));
  }
  if (process.exitCode) process.exit(process.exitCode);
  console.log('relay tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
