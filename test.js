const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

const PORT = 18999;
const TOKEN = 'test-token-abcd';

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, method: 'POST', path,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Authorization': `Bearer ${TOKEN}` },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function waitConn(ws) {
  return new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
}
function nextMsg(ws) {
  return new Promise((res) => ws.once('message', (d) => res(JSON.parse(d.toString()))));
}
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const server = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT), TOGETHER_TOKEN: TOKEN, PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}` },
  });
  server.stdout.on('data', (d) => console.log('[relay]', d.toString().trim()));
  server.stderr.on('data', (d) => console.error('[relay-err]', d.toString().trim()));
  await delay(1200);

  // 1. Crear sesión (host)
  const created = await post('/v1/together/sessions', { hostDisplayName: 'Host Test', settings: { allowGuestsToAddTracks: true, allowGuestsToControlPlayback: false, requireHostApprovalToJoin: false } });
  console.log('CREATE status:', created.status);
  if (created.status !== 201) { server.kill(); process.exit(1); }
  const session = created.body;
  console.log('SESSION:', JSON.stringify(session));
  console.log('CODE length:', session.code.length, 'is6digit:', /^\d{6}$/.test(session.code));
  console.log('wsUrl:', session.wsUrl);

  // 2. Resolver código (guest)
  const resolved = await post('/v1/together/sessions/resolve', { code: session.code });
  console.log('RESOLVE status:', resolved.status, 'guestKeyOK:', resolved.body.guestKey === session.guestKey);

  // 3. Host conecta por WS
  const hostWs = new WebSocket(session.wsUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
  await waitConn(hostWs);
  hostWs.send(JSON.stringify({ type: 'client_hello', protocolVersion: 1, sessionId: session.sessionId, sessionKey: session.hostKey, clientId: 'host-cid', displayName: 'Host Test' }));
  const hostWelcome = await nextMsg(hostWs);
  console.log('HOST welcome:', JSON.stringify(hostWelcome));
  if (hostWelcome.type !== 'server_welcome' || hostWelcome.role !== 'HOST') { server.kill(); process.exit(1); }

  // 4. Guest conecta por WS con su guestKey
  const guestWs = new WebSocket(resolved.body.wsUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
  await waitConn(guestWs);
  guestWs.send(JSON.stringify({ type: 'client_hello', protocolVersion: 1, sessionId: session.sessionId, sessionKey: session.guestKey, clientId: 'guest-cid', displayName: 'Guest Test' }));
  const guestWelcome = await nextMsg(guestWs);
  console.log('GUEST welcome:', JSON.stringify(guestWelcome));
  if (guestWelcome.type !== 'server_welcome' || guestWelcome.role !== 'GUEST') { server.kill(); process.exit(1); }

  // 5. El host debe recibir participant_joined
  const hostGotJoin = await nextMsg(hostWs);
  console.log('HOST notified:', JSON.stringify(hostGotJoin));
  if (hostGotJoin.type !== 'participant_joined') { server.kill(); process.exit(1); }

  // 6. Guest envía control_request -> host debe recibirlo (reenvío)
  guestWs.send(JSON.stringify({ type: 'control_request', sessionId: session.sessionId, participantId: guestWelcome.participantId, action: { type: 'play' } }));
  const hostGotControl = await nextMsg(hostWs);
  console.log('HOST received control:', JSON.stringify(hostGotControl));
  if (hostGotControl.type !== 'control_request') { server.kill(); process.exit(1); }

  // 7. Host envía room_state -> guest debe recibirlo (reenvío)
  hostWs.send(JSON.stringify({ type: 'room_state', state: { sessionId: session.sessionId, hostId: 'h', participants: [], settings: {}, queue: [], isPlaying: false, positionMs: 0 } }));
  const guestGotState = await nextMsg(guestWs);
  console.log('GUEST received state:', JSON.stringify(guestGotState));
  if (guestGotState.type !== 'room_state') { server.kill(); process.exit(1); }

  // 8. Heartbeat ping -> pong
  guestWs.send(JSON.stringify({ type: 'heartbeat_ping', sessionId: session.sessionId, pingId: 42, clientElapsedRealtimeMs: 100 }));
  const pong = await nextMsg(guestWs);
  console.log('GUEST heartbeat pong:', JSON.stringify(pong));
  if (pong.type !== 'heartbeat_pong' || pong.pingId !== 42) { server.kill(); process.exit(1); }

  hostWs.close(); guestWs.close();

  // ===== Flujo con aprobación requerida =====
  const created2 = await post('/v1/together/sessions', { hostDisplayName: 'Host Aprobar', settings: { allowGuestsToAddTracks: true, allowGuestsToControlPlayback: false, requireHostApprovalToJoin: true } });
  if (created2.status !== 201) { server.kill(); process.exit(1); }
  const s2 = created2.body;
  const host2 = new WebSocket(s2.wsUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
  await waitConn(host2);
  host2.send(JSON.stringify({ type: 'client_hello', protocolVersion: 1, sessionId: s2.sessionId, sessionKey: s2.hostKey, clientId: 'h2', displayName: 'Host 2' }));
  const h2w = await nextMsg(host2);
  if (h2w.role !== 'HOST') { server.kill(); process.exit(1); }

  const guest2 = new WebSocket(s2.wsUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
  await waitConn(guest2);
  guest2.send(JSON.stringify({ type: 'client_hello', protocolVersion: 1, sessionId: s2.sessionId, sessionKey: s2.guestKey, clientId: 'g2', displayName: 'Guest 2' }));
  const g2w = await nextMsg(guest2);
  console.log('GUEST2 welcome (pending):', JSON.stringify({ role: g2w.role, isPending: g2w.isPending }));
  if (g2w.isPending !== true) { server.kill(); process.exit(1); }

  // El host recibe join_request
  const h2JoinReq = await nextMsg(host2);
  console.log('HOST2 join_request:', JSON.stringify(h2JoinReq));
  if (h2JoinReq.type !== 'join_request') { server.kill(); process.exit(1); }

  // Host aprueba -> guest recibe join_decision approved
  const gid = g2w.participantId;
  host2.send(JSON.stringify({ type: 'join_decision', sessionId: s2.sessionId, participantId: gid, approved: true }));
  const g2Decision = await nextMsg(guest2);
  console.log('GUEST2 decision:', JSON.stringify(g2Decision));
  if (g2Decision.type !== 'join_decision' || g2Decision.approved !== true) { server.kill(); process.exit(1); }

  host2.close(); guest2.close();
  server.kill();
  console.log('\nALL TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
