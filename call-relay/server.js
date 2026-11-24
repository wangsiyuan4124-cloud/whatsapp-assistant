'use strict';

// 可选的通话同传中转。只做一件事：用你服务器上的 OpenAI Key 换一个短时密钥，
// 交给浏览器去连 OpenAI。语音不经过这里。
//
//   OPENAI_API_KEY=sk-... RELAY_KEY=一串自己设的密码 node server.js
//
// 浏览器插件里「中转地址」填 http://你的服务器:8787/session ，中转密钥填同一个 RELAY_KEY。

const http = require('http');
const https = require('https');

function allowedTarget(url) {
  let u;
  try { u = new URL(String(url || '')); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'api.openai.com') return null;
  if (u.pathname.indexOf('/v1/realtime/') !== 0) return null;
  return u;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, payload, extra) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const headers = Object.assign({
    'Content-Type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  }, extra || {});
  res.writeHead(status, headers);
  res.end(body);
}

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

function forwardOpenAI(target, openaiKey, body) {
  const data = Buffer.from(JSON.stringify(body || {}), 'utf8');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + openaiKey,
        'Content-Type': 'application/json',
        'Content-Length': data.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 500, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('openai timeout')); });
    req.end(data);
  });
}

async function handle(req, res, deps) {
  if (req.method === 'OPTIONS') { send(res, 204, ''); return; }
  const path = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && (path === '/' || path === '/health')) {
    send(res, 200, { ok: true });
    return;
  }
  if (req.method !== 'POST' || path !== '/session') {
    send(res, 404, { error: 'not found' });
    return;
  }
  if (!deps.relayKey || bearer(req) !== deps.relayKey) {
    send(res, 401, { error: 'bad relay key' });
    return;
  }
  let payload;
  try { payload = JSON.parse(await readBody(req, 65536) || '{}'); }
  catch (e) { send(res, 400, { error: 'bad json' }); return; }
  const target = allowedTarget(payload.url);
  if (!target) { send(res, 400, { error: 'url must be https://api.openai.com/v1/realtime/...' }); return; }
  try {
    const upstream = await deps.forward(target, deps.openaiKey, payload.body || {});
    res.writeHead(upstream.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(upstream.body);
  } catch (e) {
    send(res, 502, { error: e.message || 'upstream failed' });
  }
}

function createServer(deps) {
  return http.createServer((req, res) => {
    handle(req, res, deps).catch((e) => {
      if (!res.headersSent) send(res, 500, { error: e.message || 'error' });
    });
  });
}

if (require.main === module) {
  const openaiKey = process.env.OPENAI_API_KEY || '';
  const relayKey = process.env.RELAY_KEY || '';
  const port = Number(process.env.PORT || 8787);
  if (!openaiKey || !relayKey) {
    console.error('请设置环境变量 OPENAI_API_KEY 和 RELAY_KEY 后再启动。不要把 Key 写进代码。');
    process.exit(1);
  }
  const server = createServer({ openaiKey, relayKey, forward: forwardOpenAI });
  server.listen(port, () => {
    console.log('通话同传中转已监听 http://127.0.0.1:' + port + '/session');
  });
}

module.exports = { allowedTarget, createServer, handle };
