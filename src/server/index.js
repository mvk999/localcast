import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { isAddressOnSubnet, selectLanInterface } from './network.js';
import { SessionStore } from './session-store.js';

const PORT = 8000;
const MAX_PAIR_ATTEMPTS = 5;
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../web');
const files = new Map([
  ['/', 'sender.html'],
  ['/sender.js', 'sender.js'],
  ['/tv', 'receiver.html'],
  ['/receiver.js', 'receiver.js'],
  ['/diagnostics.js', 'diagnostics.js'],
  ['/styles.css', 'styles.css']
]);

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function send(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function close(socket) {
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) socket.close();
}

function isValidDescription(value, expectedType) {
  return value && value.type === expectedType && typeof value.sdp === 'string' && value.sdp.length > 0 && value.sdp.length <= 48_000;
}

function isSafeHostCandidate(candidate, source, lan) {
  if (!candidate || typeof candidate.candidate !== 'string' || candidate.candidate.length > 1_500) return false;
  const parts = candidate.candidate.trim().split(/\s+/);
  const typ = parts.indexOf('typ');
  if (typ < 0 || parts[typ + 1] !== 'host' || parts.length < 6) return false;
  const address = parts[4];
  // Browsers often mask host IPs as .local mDNS names. These stay on the LAN.
  if (/^[a-z0-9-]+\.local$/i.test(address)) return true;
  return source === 'sender' ? address === lan.address : isAddressOnSubnet(address, lan);
}

function parseMessage(raw) {
  if (raw.length > 65_536) return undefined;
  try {
    const parsed = JSON.parse(raw.toString());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.type === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isDebugLog(message) {
  return message.type === 'debug-log'
    && ['info', 'warn', 'error'].includes(message.level)
    && typeof message.message === 'string'
    && message.message.length > 0
    && message.message.length <= 240
    && (message.details === undefined || (message.details && typeof message.details === 'object' && !Array.isArray(message.details)));
}

function logClientDebug(role, message) {
  const details = message.details ? JSON.stringify(message.details, (key, value) => (key.toLowerCase() === 'sdp' || /code/i.test(key) ? '[redacted]' : value)).slice(0, 1_500) : '';
  const level = message.level === 'error' ? 'error' : message.level === 'warn' ? 'warn' : 'info';
  console[level](`[${role.toUpperCase()}] ${message.message}${details ? ` ${details}` : ''}`);
}
function parseOptions(argv) {
  const hostIndex = argv.indexOf('--host');
  return { host: hostIndex >= 0 ? argv[hostIndex + 1] : undefined };
}

async function serveFile(req, res, kind) {
  const requested = files.get(new URL(req.url, 'http://local').pathname);
  const isSenderResource = requested === 'sender.html' || requested === 'sender.js';
  const isTvResource = requested === 'receiver.html' || requested === 'receiver.js';
  if (!requested || (kind === 'lan' && isSenderResource) || (kind === 'loopback' && isTvResource)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const content = await fs.readFile(path.join(webRoot, requested));
    const type = requested.endsWith('.html') ? 'text/html; charset=utf-8'
      : requested.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws:; img-src 'none'; media-src blob:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    }).end(content);
  } catch {
    res.writeHead(500).end('LocalCast asset unavailable');
  }
}

function createHttpServer(kind, lan) {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
    const remote = req.socket.remoteAddress?.replace(/^::ffff:/, '');
    const sourceAllowed = kind === 'loopback' ? isLoopback(req.socket.remoteAddress) : isAddressOnSubnet(remote ?? '', lan);
    if (!sourceAllowed) return res.writeHead(403).end();
    serveFile(req, res, kind);
  });
}

function attachSignaling(server, kind, lan, store) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65_536 });
  const expectedOrigin = kind === 'loopback'
    ? new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`])
    : new Set([`http://${lan.address}:${PORT}`]);

  const endSession = (session, reason, except) => {
    if (!store.invalidate(session.id)) return;
    console.info(`session ended (${reason})`);
    for (const socket of [session.senderSocket, session.tvSocket]) {
      if (socket && socket !== except) {
        send(socket, { type: 'session-ended', reason });
      close(socket);
      }
    }
  };

  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const remote = req.socket.remoteAddress;
    const sourceAllowed = kind === 'loopback' ? isLoopback(remote) : isAddressOnSubnet(remote?.replace(/^::ffff:/, '') ?? '', lan);
    if (new URL(req.url, 'http://local').pathname !== '/signal' || !sourceAllowed || !expectedOrigin.has(origin)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (socket) => {
    socket.role = undefined;
    socket.sessionId = undefined;
    socket.attempts = 0;
    console.info(`${kind} WebSocket connected`);
    socket.on('error', (error) => console.warn(`${socket.role ?? kind} WebSocket error: ${error.message}`));

    socket.on('message', (raw) => {
      const message = parseMessage(raw);
      if (!message) {
        console.warn(`${socket.role ?? kind} WebSocket closed: invalid message`);
        return close(socket);
      }

      if (!socket.role) {
        const expectedHello = kind === 'loopback' ? 'sender-hello' : 'tv-hello';
        if (message.type !== expectedHello) {
          console.warn(`${kind} WebSocket closed: expected ${expectedHello}, received ${message.type}`);
          return close(socket);
        }
        socket.role = kind === 'loopback' ? 'sender' : 'tv';
        if (socket.role === 'tv') {
          const session = store.create();
          session.tvSocket = socket;
          socket.sessionId = session.id;
          console.info('TV session created');
          send(socket, { type: 'session-created', code: session.code, expiresAt: session.expiresAt });
        } else {
          send(socket, { type: 'sender-ready', maxAttempts: MAX_PAIR_ATTEMPTS });
        }
        return;
      }

      if (isDebugLog(message)) {
        logClientDebug(socket.role, message);
        return;
      }
      if (socket.role === 'sender' && message.type === 'pair') {
        if (socket.sessionId) return send(socket, { type: 'pairing-denied', reason: 'already_paired' });
        if (!/^\d{6}$/.test(message.code ?? '')) return send(socket, { type: 'pairing-denied', reason: 'invalid_format' });
        if (socket.attempts >= MAX_PAIR_ATTEMPTS) return send(socket, { type: 'pairing-denied', reason: 'attempts_exceeded' });
        const paired = store.authorize(message.code);
        if (!paired.ok) {
          socket.attempts += 1;
          return send(socket, { type: 'pairing-denied', reason: 'invalid_or_expired', remaining: MAX_PAIR_ATTEMPTS - socket.attempts });
        }
        const { session } = paired;
        if (session.tvSocket?.readyState !== WebSocket.OPEN) {
          store.invalidate(session.id);
          return send(socket, { type: 'pairing-denied', reason: 'receiver_disconnected' });
        }
        session.senderSocket = socket;
        socket.sessionId = session.id;
        console.info('TV authorized');
        send(socket, { type: 'paired' });
        send(session.tvSocket, { type: 'authorized' });
        return;
      }

      const session = socket.sessionId && store.get(socket.sessionId);
      if (!session || !session.authorized) {
        console.warn(`${socket.role} WebSocket closed: no authorized session for message ${message.type}`);
        return close(socket);
      }

      if (socket.role === 'sender' && message.type === 'stop') {
        endSession(session, 'stopped');
        return;
      }

      if (socket.role === 'sender' && message.type === 'offer' && isValidDescription(message.description, 'offer')) {
        console.info('offer forwarded to TV');
        send(session.tvSocket, { type: 'offer', description: message.description });
        return;
      }
      if (socket.role === 'tv' && message.type === 'answer' && isValidDescription(message.description, 'answer')) {
        console.info('answer forwarded to sender');
        send(session.senderSocket, { type: 'answer', description: message.description });
        return;
      }
      if (message.type === 'candidate') {
        if (!isSafeHostCandidate(message.candidate, socket.role, lan)) {
          console.warn(`ICE candidate ignored (${socket.role}; not an allowed local host candidate)`);
          return;
        }
        console.info(`ICE host candidate forwarded (${socket.role})`);
        const peer = socket.role === 'sender' ? session.tvSocket : session.senderSocket;
        send(peer, { type: 'candidate', candidate: message.candidate });
        return;
      }
      if (message.type === 'ice-complete') {
        const peer = socket.role === 'sender' ? session.tvSocket : session.senderSocket;
        send(peer, { type: 'ice-complete' });
        return;
      }
      console.warn(`${socket.role} WebSocket closed: unsupported message ${message.type}`);
      close(socket);
    });
    socket.on('close', (code, reason) => {
      console.info(`${socket.role ?? kind} WebSocket closed (code ${code}${reason.length ? `, ${reason.toString()}` : ''})`);
      const session = socket.sessionId && store.get(socket.sessionId);
      if (!session) return;
      if (socket.role === 'tv') endSession(session, 'receiver_disconnected', socket);
      if (socket.role === 'sender') endSession(session, 'sender_disconnected', socket);
    });
  });
}

async function listen(server, port, host) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
}

async function main() {
  const lan = selectLanInterface(parseOptions(process.argv.slice(2)));
  const store = new SessionStore();
  const loopbackServer = createHttpServer('loopback', lan);
  const lanServer = createHttpServer('lan', lan);
  attachSignaling(loopbackServer, 'loopback', lan, store);
  attachSignaling(lanServer, 'lan', lan, store);
  setInterval(() => {
    for (const session of store.prune()) {
      console.info('TV session expired');
      send(session.senderSocket, { type: 'session-ended', reason: 'expired' });
      send(session.tvSocket, { type: 'session-ended', reason: 'expired' });
      close(session.senderSocket);
      close(session.tvSocket);
    }
  }, 1_000).unref();

  await Promise.all([listen(loopbackServer, PORT, '127.0.0.1'), listen(lanServer, PORT, lan.address)]);
  console.info('\nLocalCast iniciado.\n');
  console.info(`No notebook: http://localhost:${PORT}`);
  console.info(`Na TV:       http://${lan.address}:${PORT}/tv\n`);
  console.info(`Interface LAN: ${lan.name} (${lan.address}) — IPv4 privado somente; sem STUN/TURN.`);
}

main().catch((error) => {
  console.error(`LocalCast não iniciou: ${error.message}`);
  process.exitCode = 1;
});
