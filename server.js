// SixSixMusic Together Relay
// Servidor intermedio para el modo online (código de 6 dígitos + WebSocket).
// Requisitos: Node.js 18+, WebSocket persistente (Railway / Render / VPS).
//
// Entorno:
//   PORT             puerto HTTP (Railway lo define automáticamente)
//   TOGETHER_TOKEN   token Bearer compartido con la app (BuildConfig.TOGETHER_BEARER_TOKEN)
//   PUBLIC_BASE_URL  URL pública del relay, SIN /v1 (ej. https://xxx.up.railway.app)
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const TOKEN = (process.env.TOGETHER_TOKEN || '').trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');

const PROTOCOL_VERSION = 1;

function randomId() {
  return crypto.randomUUID();
}

function randomCode() {
  // 6 dígitos, sin repetidos activos, sin empezar en 0 -> representación fija de 6.
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalizeSettings(s) {
  return {
    allowGuestsToAddTracks: s && typeof s.allowGuestsToAddTracks === 'boolean' ? s.allowGuestsToAddTracks : true,
    allowGuestsToControlPlayback: s && typeof s.allowGuestsToControlPlayback === 'boolean' ? s.allowGuestsToControlPlayback : false,
    requireHostApprovalToJoin: s && typeof s.requireHostApprovalToJoin === 'boolean' ? s.requireHostApprovalToJoin : false,
  };
}

// Estado en memoria: sessionId -> sesión
const sessions = new Map();
const codeToSessionId = new Map();

function wsUrlFor(baseUrl) {
  const b = (baseUrl || PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  let scheme = 'ws';
  let body = b;
  if (b.startsWith('https://')) { scheme = 'wss'; body = b.slice('https://'.length); }
  else if (b.startsWith('http://')) { body = b.slice('http://'.length); }
  const slash = body.indexOf('/');
  const hostPort = slash === -1 ? body : body.slice(0, slash);
  const basePath = slash === -1 ? '' : body.slice(slash).replace(/\/v1[\/]?$/, '');
  // hostPort puede contener una IP v4 (con puntos) sin problema al incluirla tal cual.
  return `${scheme}://${hostPort}${basePath}/v1/together/ws`;
}

// ---- Auth helper ----
function hasValidAuth(req) {
  if (TOKEN === '' || TOKEN === '**') return true;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${TOKEN}`;
}

// ---- App HTTP ----
const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'SixSixMusic-Together-Relay' });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

app.get('/v1/together/ws', (_req, res) => {
  res.json({ msg: 'Use the WebSocket connection.' });
});

// Crear sesión (host)
app.post('/v1/together/sessions', (req, res) => {
  if (!hasValidAuth(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const { hostDisplayName, settings } = req.body || {};
  if (!hostDisplayName) return res.status(400).json({ ok: false, error: 'hostDisplayName is required' });

  const sessionId = randomId();
  const hostKey = randomId();
  const guestKey = randomId();

  // Código de 6 dígitos único entre sesiones activas
  let code;
  do {
    code = randomCode();
  } while (codeToSessionId.has(code));

  const normalizedSettings = normalizeSettings(settings);

  sessions.set(sessionId, {
    sessionId,
    code,
    hostKey,
    guestKey,
    settings: normalizedSettings,
    hostSocket: null,
    hostParticipantId: null,
    guests: new Map(), // participantId -> { socket, participantId, name, pending }
  });
  codeToSessionId.set(code, sessionId);

  const wsUrl = wsUrlFor(PUBLIC_BASE_URL);
  res.status(201).json({
    sessionId,
    code,
    hostKey,
    guestKey,
    wsUrl,
    settings: normalizedSettings,
  });
});

// Resolver código (invitado)
app.post('/v1/together/sessions/resolve', (req, res) => {
  if (!hasValidAuth(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const { code } = req.body || {};
  const trimmed = (code || '').toString().trim();
  const sessionId = trimmed.length === 6 ? codeToSessionId.get(trimmed) : null;
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });
  const wsUrl = wsUrlFor(PUBLIC_BASE_URL);
  res.json({
    sessionId: session.sessionId,
    guestKey: session.guestKey,
    wsUrl,
    settings: session.settings,
  });
});

// Límite de sesiones huérfanas para evitar fugas de memoria (uso básico).
setInterval(() => {
  const now = Date.now();
  const expired = [];
  sessions.forEach((s, id) => {
    if (s.expiry && now > s.expiry) expired.push(id);
  });
  expired.forEach((id) => {
    const s = sessions.get(id);
    if (s && !s.hostSocket && s.guests.size === 0) {
      codeToSessionId.delete(s.code);
      sessions.delete(id);
    }
  });
}, 10 * 60 * 1000); // cada 10 min

// ---- WebSocket ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/v1/together/ws' });

function msg(type, payload) {
  return JSON.stringify({ type, ...payload });
}

function send(wsObject, type, payload) {
  if (wsObject && wsObject.readyState === 1) wsObject.send(msg(type, payload));
}

function sendRaw(wsObject, text) {
  if (wsObject && wsObject.readyState === 1) wsObject.send(text);
}

function notifyHost(session, type, payload) {
  if (session.hostSocket) sendRaw(session.hostSocket, msg(type, payload));
}

wss.on('connection', (socket, req) => {
  // Bearer opcional en la cabecera (lo manda la app)
  const auth = (req.headers.authorization || '').trim();
  if (TOKEN !== '' && TOKEN !== '**' && auth !== `Bearer ${TOKEN}`) {
    socket.close(4001, 'Unauthorized');
    return;
  }

  let session = null;
  let role = null; // 'HOST' | 'GUEST'
  let participantId = null;
  let guestName = '';
  let guestPending = false;
  let helloReceived = false;
  let registered = false;

  const cleanup = () => {
    if (!session) return;
    if (role === 'HOST' && session.hostSocket === socket) {
      session.hostSocket = null;
      session.hostParticipantId = null;
      // La sesión termina cuando el host se va
      if (registered) {
        const list = [...session.guests.keys()];
        session.guests.forEach((g) => {
          try { g.socket.close(4000, 'Session ended'); } catch (_) {}
        });
        session.guests.clear();
        for (const pid of list) {
          notifyHost(session, 'participant_left', { sessionId: session.sessionId, participantId: pid, reason: 'Session ended' });
        }
        codeToSessionId.delete(session.code);
        sessions.delete(session.sessionId);
      }
    } else if (role === 'GUEST' && session) {
      if (session.guests.delete(participantId) && registered) {
        notifyHost(session, 'participant_left', {
          sessionId: session.sessionId,
          participantId,
          reason: 'Disconnected',
        });
      }
      setExpiry(session);
    }
  };

  socket.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch (_) { return; }
    const type = data.type;

    // 1. Saludo inicial
    if (!helloReceived) {
      if (type !== 'client_hello') { socket.close(4002, 'Handshake required'); return; }
      helloReceived = true;
      const sid = data.sessionId;
      const key = data.sessionKey;
      const cand = sessions.get(sid);
      if (!cand) { socket.send(msg('server_error', { sessionId: sid, message: 'Session not found' })); socket.close(4004, 'No such session'); return; }
      session = cand;
      if (key === session.hostKey) role = 'HOST';
      else if (key === session.guestKey) role = 'GUEST';
      else { socket.send(msg('server_error', { sessionId: sid, message: 'Invalid session' })); socket.close(4003, 'Invalid session'); return; }

      if (data.protocolVersion !== PROTOCOL_VERSION) {
        socket.send(msg('server_error', { sessionId: sid, message: 'Unsupported protocol version' }));
        socket.close(4005, 'Unsupported protocol');
        return;
      }

      participantId = randomId();

      if (role === 'HOST') {
        // Reemplazar host previo si existiera
        if (session.hostSocket && session.hostSocket.readyState === 1) {
          try { session.hostSocket.close(4006, 'Host replaced'); } catch (_) {}
        }
        session.hostSocket = socket;
        session.hostParticipantId = participantId;
        session.expiry = null;
        registered = true;
        send(socket, 'server_welcome', {
          protocolVersion: PROTOCOL_VERSION,
          sessionId: session.sessionId,
          participantId,
          role: 'HOST',
          isPending: false,
          settings: session.settings,
        });
      } else {
        guestPending = session.settings.requireHostApprovalToJoin;
        const g = { socket, participantId, name: (data.displayName || 'Guest').trim() || 'Guest', pending: guestPending };
        session.guests.set(participantId, g);
        registered = true;
        setExpiry(session);
        send(socket, 'server_welcome', {
          protocolVersion: PROTOCOL_VERSION,
          sessionId: session.sessionId,
          participantId,
          role: 'GUEST',
          isPending: guestPending,
          settings: session.settings,
        });
        // Avisar al host
        const p = { id: participantId, name: g.name, isHost: false, isPending: guestPending, isConnected: true };
        notifyHost(session, guestPending ? 'join_request' : 'participant_joined', {
          sessionId: session.sessionId,
          participant: p,
        });
      }
      return;
    }

    if (!session) return;

    // Heartbeat -> responder pong (para latencia)
    if (type === 'heartbeat_ping') {
      send(socket, 'heartbeat_pong', {
        sessionId: session.sessionId,
        pingId: data.pingId,
        clientElapsedRealtimeMs: data.clientElapsedRealtimeMs,
        serverElapsedRealtimeMs: Date.now(),
      });
      return;
    }

    if (type === 'client_leave') {
      socket.close(4007, 'Left');
      return;
    }

    // Reenvío host -> guests (o a un guest concreto)
    if (role === 'HOST') {
      const text = raw.toString();
      if (type === 'join_decision') {
        const targetId = data.participantId;
        const target = session.guests.get(targetId);
        if (target) {
          if (data.approved === true) target.pending = false;
          sendRaw(target.socket, text);
        }
        return;
      }
      if (type === 'kick' || type === 'ban') {
        const target = session.guests.get(data.participantId);
        if (target) {
          sendRaw(target.socket, text);
          session.guests.delete(data.participantId);
          notifyHost(session, 'participant_left', {
            sessionId: session.sessionId,
            participantId: data.participantId,
            reason: data.reason || (type === 'kick' ? 'Kicked' : 'Banned'),
          });
          try { target.socket.close(4008, 'Removed'); } catch (_) {}
        }
        return;
      }
      if (type === 'room_state' || type === 'participant_left') {
        session.guests.forEach((g) => sendRaw(g.socket, text));
        return;
      }
      // Broadcast genérico host -> guests
      session.guests.forEach((g) => sendRaw(g.socket, text));
      return;
    }

    // Guest -> host
    if (role === 'GUEST') {
      sendRaw(session.hostSocket, raw.toString());
    }
  });

  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

function setExpiry(session) {
  // Si no hay host conectado, la sesión se poda a los 15 min de inactividad
  if (session.hostSocket && session.hostSocket.readyState === 1) {
    session.expiry = null;
  } else {
    session.expiry = Date.now() + 15 * 60 * 1000;
  }
}

server.listen(PORT, () => {
  console.log(`[relay] listening on ${PORT}`);
  console.log(`[relay] ws  -> ${PORT}`);
  if (PUBLIC_BASE_URL) console.log(`[relay] wsUrl -> ${wsUrlFor(PUBLIC_BASE_URL)}`);
  if (TOKEN === '' || TOKEN === '**') {
    console.log('[relay] WARNING: TOGETHER_TOKEN en blanco. Funciona, pero cualquiera podría crear sesiones.');
  }
});
