'use strict';

// 通话同传中转。长期 Key 只放在这里。
// 阿里云：浏览器连 /aliyun，本服务再去连北京百炼（浏览器加不了 Authorization 头）。
// OpenAI：POST /session 换一个短时密钥，语音不经过这里。
//
//   RELAY_KEY=密码 DASHSCOPE_API_KEY=百炼Key ALIYUN_WORKSPACE=业务空间 node server.js
//
// 插件「中转地址」填 http://你的服务器:8787/session ，中转密钥填同一个 RELAY_KEY。

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const { acceptBrowser, connectUpstream, aliyunUpstreamUrl } = require('./wsutil');

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

/* ---------- 阿里云 HTTP 通道 ----------
 * WhatsApp 网页的安全策略（connect-src）不允许连到我们的服务器，网页里的 WebSocket 会被拦。
 * 插件改用 Tampermonkey 的 GM_xmlhttpRequest（不受网页策略限制）走这几个 HTTP 接口：
 *   POST /aliyun/open          → 本服务去连阿里云，返回 {id}
 *   POST /aliyun/send?id=      → body 是 JSON 字符串数组，逐条转给阿里云
 *   POST /aliyun/poll?id=      → 长轮询，等最多 POLL_MS，返回 {events:[阿里云原文…], closed}
 *   POST /aliyun/close?id=     → 关掉
 * 鉴权都用 Authorization: Bearer <RELAY_KEY>。60 秒没人来取/送就自动关掉。
 */
const POLL_MS = 20000;
const IDLE_MS = 60000;
const MAX_SESSIONS = 8;
const MAX_QUEUE = 3000;

function makeHub(deps) {
  const sessions = new Map();
  const wake = (s) => {
    if (!s.waiter) return;
    const w = s.waiter;
    s.waiter = null;
    clearTimeout(w.timer);
    w.flush();
  };
  const finish = (s) => {
    if (s.closed) return;
    s.closed = true;
    try { if (s.upstream) s.upstream.close(); } catch (e) {}
    wake(s);
  };
  const push = (s, text) => {
    s.queue.push(text);
    if (s.queue.length > MAX_QUEUE) { s.queue.splice(0, s.queue.length - MAX_QUEUE); finish(s); }
    wake(s);
  };
  const timer = setInterval(() => {
    const now = Date.now();
    sessions.forEach((s, id) => {
      if (now - s.lastSeen > IDLE_MS) { finish(s); sessions.delete(id); }
      else if (s.closed && !s.waiter && !s.queue.length && now - s.lastSeen > 5000) sessions.delete(id);
    });
  }, 5000);
  if (timer.unref) timer.unref();

  function open() {
    const upstreamUrl = deps.aliyunUrl || aliyunUpstreamUrl(deps.aliyunWorkspace, deps.aliyunModel);
    if (!upstreamUrl || !deps.dashscopeKey) return { status: 503, body: { error: 'aliyun not configured' } };
    if (sessions.size >= MAX_SESSIONS) return { status: 429, body: { error: 'too many sessions' } };
    const id = crypto.randomBytes(12).toString('hex');
    const s = { id, queue: [], waiter: null, upstream: null, pending: [], closed: false, lastSeen: Date.now() };
    sessions.set(id, s);
    const connect = deps.connectUpstream || connectUpstream;
    connect(upstreamUrl, { Authorization: 'Bearer ' + deps.dashscopeKey }).then((up) => {
      if (s.closed) { try { up.close(); } catch (e) {} return; }
      s.upstream = up;
      s.pending.splice(0).forEach((t) => up.send(t));
      up.onFrame((t) => push(s, t));
      up.onClose(() => finish(s));
    }).catch((e) => {
      push(s, JSON.stringify({ type: 'error', error: { message: 'relay: ' + ((e && e.message) || 'upstream failed') } }));
      finish(s);
    });
    return { status: 200, body: { id } };
  }
  function get(id) {
    const s = sessions.get(String(id || ''));
    if (s) s.lastSeen = Date.now();
    return s;
  }
  function sendMany(s, list) {
    list.forEach((t) => {
      if (typeof t !== 'string') t = JSON.stringify(t);
      if (s.upstream) s.upstream.send(t);
      else if (s.pending.length < 400) s.pending.push(t);
    });
  }
  function poll(s, res) {
    if (s.waiter) wake(s); // 同一时间只留一个等待中的请求
    const flush = () => {
      const events = s.queue.splice(0);
      const closed = s.closed && !s.queue.length;
      s.lastSeen = Date.now();
      send(res, 200, { events, closed });
      if (closed) sessions.delete(s.id);
    };
    if (s.queue.length || s.closed) { flush(); return; }
    const w = { flush, timer: setTimeout(() => { if (s.waiter === w) { s.waiter = null; flush(); } }, POLL_MS) };
    s.waiter = w;
    res.on('close', () => { if (s.waiter === w) { s.waiter = null; clearTimeout(w.timer); } });
  }
  function close(s) { finish(s); sessions.delete(s.id); }
  // 关服务时把所有会话（以及到阿里云的连接）一起关掉
  const stop = () => { clearInterval(timer); sessions.forEach((s) => finish(s)); sessions.clear(); };
  return { open, get, sendMany, poll, close, sessions, stop };
}

async function handleAliyunHttp(req, res, deps, path) {
  if (!deps.relayKey || bearer(req) !== deps.relayKey) { send(res, 401, { error: 'bad relay key' }); return; }
  const hub = deps.hub;
  if (path === '/aliyun/open') { const r = hub.open(); send(res, r.status, r.body); return; }
  let id = '';
  try { id = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('id') || ''; } catch (e) { id = ''; }
  const s = hub.get(id);
  if (!s) { send(res, 404, { error: 'no such session', closed: true }); return; }
  if (path === '/aliyun/send') {
    let list;
    try { list = JSON.parse(await readBody(req, 4 * 1024 * 1024) || '[]'); } catch (e) { send(res, 400, { error: 'bad json' }); return; }
    if (!Array.isArray(list)) list = [list];
    if (s.closed) { send(res, 410, { error: 'closed', closed: true }); return; }
    hub.sendMany(s, list);
    send(res, 200, { ok: true });
    return;
  }
  if (path === '/aliyun/poll') { hub.poll(s, res); return; }
  if (path === '/aliyun/close') { hub.close(s); send(res, 200, { ok: true }); return; }
  send(res, 404, { error: 'not found' });
}

async function handle(req, res, deps) {
  if (req.method === 'OPTIONS') { send(res, 204, ''); return; }
  const path = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && (path === '/' || path === '/health')) {
    send(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && path.indexOf('/aliyun/') === 0 && deps.hub) {
    await handleAliyunHttp(req, res, deps, path);
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

function relayKeyFrom(req) {
  const header = bearer(req);
  if (header) return header;
  try {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    return u.searchParams.get('k') || '';
  } catch (e) { return ''; }
}

function attachAliyun(server, deps) {
  server.on('upgrade', (req, socket) => {
    const path = (req.url || '/').split('?')[0];
    if (path !== '/aliyun') { socket.destroy(); return; }
    if (!deps.relayKey || relayKeyFrom(req) !== deps.relayKey) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const upstreamUrl = deps.aliyunUrl || aliyunUpstreamUrl(deps.aliyunWorkspace, deps.aliyunModel);
    if (!upstreamUrl || !deps.dashscopeKey) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const browser = acceptBrowser(req, socket);
    if (!browser) return;
    const pending = [];
    let upstreamPeer = null;
    browser.onFrame((text) => {
      if (upstreamPeer) upstreamPeer.send(text);
      else pending.push(text);
    });
    const connect = deps.connectUpstream || connectUpstream;
    connect(upstreamUrl, { Authorization: 'Bearer ' + deps.dashscopeKey }).then((upstream) => {
      upstreamPeer = upstream;
      pending.splice(0).forEach((text) => upstream.send(text));
      const closeBoth = () => { try { browser.close(); } catch (e) {} try { upstream.close(); } catch (e) {} };
      upstream.onFrame((text) => browser.send(text));
      browser.onClose(closeBoth);
      upstream.onClose(closeBoth);
    }).catch(() => { try { browser.close(); } catch (e) {} });
  });
  return server;
}

function createServer(deps) {
  deps = deps || {};
  if (!deps.hub) deps.hub = makeHub(deps);
  const server = http.createServer((req, res) => {
    handle(req, res, deps).catch((e) => {
      if (!res.headersSent) send(res, 500, { error: e.message || 'error' });
    });
  });
  attachAliyun(server, deps);
  server.hub = deps.hub;
  server.on('close', () => { try { deps.hub.stop(); } catch (e) {} });
  return server;
}

if (require.main === module) {
  const openaiKey = process.env.OPENAI_API_KEY || '';
  const relayKey = process.env.RELAY_KEY || '';
  const dashscopeKey = process.env.DASHSCOPE_API_KEY || '';
  const aliyunWorkspace = process.env.ALIYUN_WORKSPACE || '';
  const aliyunModel = process.env.ALIYUN_MODEL || 'qwen3.8-livetranslate-flash-realtime';
  const port = Number(process.env.PORT || 8787);
  const hasAliyun = !!(dashscopeKey && aliyunWorkspace);
  if (!relayKey || (!openaiKey && !hasAliyun)) {
    console.error('请设置 RELAY_KEY，以及 OPENAI_API_KEY 或 DASHSCOPE_API_KEY + ALIYUN_WORKSPACE。不要把 Key 写进代码。');
    process.exit(1);
  }
  const server = createServer({
    openaiKey, relayKey, forward: forwardOpenAI, dashscopeKey, aliyunWorkspace, aliyunModel,
  });
  server.listen(port, () => {
    console.log('通话同传中转已监听 http://127.0.0.1:' + port + '/session 和 /aliyun');
  });
}

module.exports = { allowedTarget, createServer, handle, aliyunUpstreamUrl };
