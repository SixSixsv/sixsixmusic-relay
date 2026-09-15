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

// ---- Jam join deep link (QR de la Jam online) ----
// La cámara del sistema solo hace clicable http/https, así que el QR apunta
// aquí y esta página abre la app mediante el deep link custom.
app.get('/join', (req, res) => {
  const code = (req.query.code || '').toString().trim();
  const host = (req.query.host || '').toString().trim();
  const deep = `sixsixmusic://together/online?code=${encodeURIComponent(code)}&host=${encodeURIComponent(host)}`;
  res.type('html').send(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unirse a la Jam - SixSixMusic</title>
</head>
<body style="margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0d0d0d;color:#f2f2f2;text-align:center;padding:48px 24px">
  <h2 style="font-weight:700">Unirse a la Jam</h2>
  <p style="opacity:.75">Abriendo SixSixMusic…</p>
  <a id="open" href="#" style="display:inline-block;margin-top:16px;padding:14px 26px;background:#1ed760;color:#000;border-radius:999px;text-decoration:none;font-weight:700">Abrir SixSixMusic</a>
  <p style="opacity:.5;font-size:13px;margin-top:24px">Si no se abre, toca el botón.</p>
  <script>
    var deep = ${JSON.stringify(deep)};
    document.getElementById('open').href = deep;
    setTimeout(function () { window.location.href = deep; }, 300);
  </script>
</body>
</html>`);
});

// ---- Android App Links ----
// Para que la cámara abra la app directamente (sin navegador). Incluye el
// paquete/fingerprint de la build instalada. La release se toma de la variable
// de entorno ANDROID_RELEASE_SHA256.
const ANDROID_PACKAGE_DEBUG = 'com.sixsixmusic.debug';
const ANDROID_PACKAGE_RELEASE = 'com.sixsixmusic';
const ANDROID_DEBUG_SHA256 = '23:00:80:54:9D:19:7B:62:51:19:AA:2C:BA:0D:52:45:2A:04:B0:86:5E:8E:EE:ED:3D:D8:5B:57:FE:75:1B:45';
const ANDROID_RELEASE_SHA256 = (process.env.ANDROID_RELEASE_SHA256 || '').trim();

app.get('/.well-known/assetlinks.json', (_req, res) => {
  const statements = [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: ANDROID_PACKAGE_DEBUG,
        sha256_cert_fingerprints: [ANDROID_DEBUG_SHA256],
      },
    },
  ];
  if (ANDROID_RELEASE_SHA256) {
    statements.push({
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: ANDROID_PACKAGE_RELEASE,
        sha256_cert_fingerprints: [ANDROID_RELEASE_SHA256],
      },
    });
  }
  res.type('application/json').send(JSON.stringify(statements, null, 2));
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
    hostName: hostDisplayName.trim(),
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

// Participantes conectados (host + invitados). No requiere clave de guest para invitar.
app.get('/v1/together/sessions/:id/participants', (req, res) => {
  if (!hasValidAuth(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

  const participants = [];
  if (session.hostParticipantId && session.hostName) {
    participants.push({
      id: session.hostParticipantId,
      name: session.hostName,
      isHost: true,
      isPending: false,
      isConnected: true,
    });
  }
  session.guests.forEach((g) => {
    participants.push({
      id: g.participantId,
      name: g.name,
      isHost: false,
      isPending: !!g.pending,
      isConnected: true,
    });
  });

  res.json({ ok: true, participants });
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
