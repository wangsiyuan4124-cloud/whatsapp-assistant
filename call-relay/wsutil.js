'use strict';

// 很小的 WebSocket 帧处理。浏览器连到中转时不能自己加 Authorization，
// 所以由这里带着服务器上的密钥去连阿里云，再把 JSON 原文转过去。

const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(opcode, payload, mask) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const maskBit = mask ? 0x80 : 0;
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, maskBit | data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = maskBit | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = maskBit | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(data.length, 6);
  }
  if (!mask) return Buffer.concat([header, data]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ key[i % 4];
  return Buffer.concat([header, key, masked]);
}

function tryParse(buf, expectMask) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const hi = buf.readUInt32BE(2);
    const lo = buf.readUInt32BE(6);
    if (hi !== 0) return null;
    len = lo;
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  let payload = buf.slice(offset + maskLen, offset + maskLen + len);
  if (masked) {
    const key = buf.slice(offset, offset + 4);
    const out = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ key[i % 4];
    payload = out;
  }
  if (expectMask && !masked && opcode !== 0) {
    // 浏览器发来的数据帧必须带掩码。控制帧也一样。不带就当坏帧丢掉这条连接。
    return { bytes: offset + maskLen + len, opcode: 8, payload: Buffer.alloc(0), bad: true };
  }
  return { bytes: offset + maskLen + len, opcode, payload };
}

function wrapSocket(socket, expectMask, initial) {
  let buf = initial && initial.length ? Buffer.from(initial) : Buffer.alloc(0);
  let dead = false;
  const frameFns = [];
  const closeFns = [];
  const fail = () => {
    if (dead) return;
    dead = true;
    closeFns.forEach((fn) => { try { fn(); } catch (e) {} });
    try { socket.destroy(); } catch (e) {}
  };
  const pump = () => {
    if (buf.length > 8 * 1024 * 1024) { fail(); return; }
    while (!dead) {
      const frame = tryParse(buf, expectMask);
      if (!frame) break;
      buf = buf.slice(frame.bytes);
      if (frame.bad || frame.opcode === 8) { fail(); return; }
      if (frame.opcode === 9) {
        try { socket.write(encodeFrame(10, frame.payload, !expectMask)); } catch (e) { fail(); }
        continue;
      }
      if (frame.opcode === 10) continue;
      if (frame.opcode === 1) {
        const text = frame.payload.toString('utf8');
        frameFns.forEach((fn) => { try { fn(text); } catch (e) {} });
      }
    }
  };
  socket.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); pump(); });
  if (buf.length) process.nextTick(pump);
  socket.on('close', fail);
  socket.on('error', fail);
  return {
    send(text) {
      if (dead) return;
      try { socket.write(encodeFrame(1, text, !expectMask)); } catch (e) { fail(); }
    },
    close() { fail(); },
    onFrame(fn) { frameFns.push(fn); },
    onClose(fn) { closeFns.push(fn); },
  };
}

function acceptBrowser(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return null; }
  const accept = crypto.createHash('sha1').update(String(key) + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  return wrapSocket(socket, true, head);
}

function connectUpstream(url, headers) {
  const u = new URL(url);
  const secure = u.protocol === 'wss:';
  const port = Number(u.port || (secure ? 443 : 80));
  const key = crypto.randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const socket = (secure ? tls : net).connect({
      host: u.hostname, port, servername: secure ? u.hostname : undefined,
    });
    let headerBuf = Buffer.alloc(0);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (e) {}
      reject(err instanceof Error ? err : new Error(String(err || 'upstream failed')));
    };
    socket.setTimeout(20000, () => fail(new Error('upstream timeout')));
    socket.on('error', fail);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      const lines = [
        'GET ' + u.pathname + u.search + ' HTTP/1.1',
        'Host: ' + u.host,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: ' + key,
        'Sec-WebSocket-Version: 13',
      ];
      Object.keys(headers || {}).forEach((name) => { lines.push(name + ': ' + headers[name]); });
      lines.push('', '');
      socket.write(lines.join('\r\n'));
    });
    socket.on('data', (chunk) => {
      if (settled) return;
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const idx = headerBuf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = headerBuf.slice(0, idx).toString('utf8');
      const rest = headerBuf.slice(idx + 4);
      if (!/^HTTP\/1\.[01] 101\b/.test(head)) {
        fail(new Error(head.split('\r\n')[0] || 'upstream rejected'));
        return;
      }
      settled = true;
      socket.setTimeout(0);
      socket.removeAllListeners('data');
      const peer = wrapSocket(socket, false, rest);
      resolve(peer);
    });
  });
}

function aliyunUpstreamUrl(workspace, model) {
  const id = String(workspace || '').trim();
  const name = String(model || 'qwen3.8-livetranslate-flash-realtime').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return '';
  return 'wss://' + id + '.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=' + encodeURIComponent(name);
}

module.exports = { encodeFrame, tryParse, acceptBrowser, connectUpstream, aliyunUpstreamUrl, wrapSocket };
