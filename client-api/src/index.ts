import express, { Request, Response } from 'express';
import { Server } from "socket.io";
import { createServer } from 'http';
import Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';




const app = express();
app.use(express.json());

// --- CORS ---
// The frontend (frontend/) is served from its own origin/port, so every
// response needs CORS headers for the browser to accept it. This is a POC:
// allow any origin. A real deployment would restrict this to the known
// frontend origin(s).
app.use((req: Request, res: Response, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, userid');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

const httpServer = createServer(app);

// Flips to true once SIGTERM/SIGINT is received (see the "Graceful shutdown"
// section at the bottom of this file). Read by /readyz, which is what tells
// the load balancer to stop routing new clients here.
let shuttingDown = false;

const io = new Server(httpServer, {
  // Same reasoning as the Express CORS middleware above — the socket.io
  // handshake bypasses normal Express routing, so it needs its own CORS
  // config independent of Express's.
  cors: { origin: '*' },
  // WebSocket only, no HTTP long-polling. socket.io's default transport
  // order starts with polling, which makes several *separate* HTTP
  // requests per session — fine behind a single instance, but it requires
  // every one of those requests to land back on the same instance ("sticky
  // sessions"), which the nginx load balancer in docker-compose.replicas.yml
  // doesn't provide out of the box (confirmed by hand: polling broke
  // immediately behind it with "xhr poll error" / "xhr post error"). A WebSocket
  // connection is a single long-lived connection instead — routed once,
  // same requirement this whole project already has for every other
  // connection here — so it needs no session affinity at all.
  transports: ['websocket'],
})


// --- Redis adapter: needs two clients (one can't sub + pub) ---
const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';
const pubClient = new Redis(REDIS_URL);
const subClient = pubClient.duplicate();

io.adapter(createAdapter(pubClient, subClient));

// --- pull userId from the handshake header ---
io.use((socket, next) => {
  const h = socket.handshake;
  const userId = h.auth.userid ?? h.query.userid ?? h.headers['userid'];
  if (typeof userId !== 'string' || !userId) return next(new Error('missing userId'));
  socket.data.userId = userId;
  next();
});

io.on('connection', (socket) => {
  const { userId } = socket.data;
  socket.join(userId); // room named after the user
  socket.on('disconnect', () => { /* room auto-cleaned */ });
});

// ---------------------------------------------------------------------------
// SSE transport — same feature set as the Socket.IO side (per-user + broadcast),
// same Redis fan-out across instances, but no upgrade/adapter/protocol layer.
//
// Each instance keeps its own registry of open response streams and subscribes
// to a plain Redis channel. Every instance receives every published message;
// an instance only writes to a stream it actually holds.
// ---------------------------------------------------------------------------

const SSE_CHANNEL = 'sse:events';

// userId -> set of open SSE response streams on THIS instance
const sseClients = new Map<string, Set<Response>>();

function addSseClient(userId: string, res: Response): void {
  let set = sseClients.get(userId);
  if (!set) sseClients.set(userId, (set = new Set()));
  set.add(res);
}

function removeSseClient(userId: string, res: Response): void {
  const set = sseClients.get(userId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) sseClients.delete(userId);
}

function writeEvent(res: Response, message: unknown): void {
  res.write(`data: ${JSON.stringify(message)}\n\n`);
}

// Dedicated subscriber connection (subClient is already owned by the adapter).
const sseSub = new Redis(REDIS_URL);
sseSub.subscribe(SSE_CHANNEL).catch((err) => console.error('sse subscribe failed', err));

sseSub.on('message', (_channel, raw) => {
  let evt: { userId?: string; message?: unknown };
  try {
    evt = JSON.parse(raw);
  } catch (err) {
    console.error('bad sse event payload', err);
    return;
  }

  if (evt.userId) {
    // targeted: only the instance holding that user does anything
    const set = sseClients.get(String(evt.userId));
    if (set) for (const res of set) writeEvent(res, evt.message);
  } else {
    // broadcast: every instance fans out to all its local streams
    for (const set of sseClients.values()) {
      for (const res of set) writeEvent(res, evt.message);
    }
  }
});

// Client subscribes here: GET /events?userid=1234
app.get('/events', (req: Request, res: Response) => {
  const userId = String(req.query.userid ?? '');
  if (!userId) {
    res.status(401).json({ error: 'missing userid query param' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // tell nginx not to buffer the stream
  });
  res.write(': connected\n\n'); // comment line opens the stream

  addSseClient(userId, res);

  // heartbeat so idle proxies/load balancers keep the connection open
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeSseClient(userId, res);
  });
});

// ---------------------------------------------------------------------------
// Health/readiness — generic endpoints any health check or load balancer can
// poll.
//
// - /healthz: liveness. Always 200 once the process is up; only fails if the
//   event loop is wedged (a caller polling this would restart the instance).
// - /readyz: readiness. 200 normally; 503 once we've started draining for
//   shutdown, so a load balancer stops routing *new* clients here while we
//   finish closing the old ones.
// ---------------------------------------------------------------------------

app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/readyz', (_req: Request, res: Response) => {
  if (shuttingDown) {
    res.status(503).json({ status: 'shutting down' });
    return;
  }
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`client-api listening on port ${PORT}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown — lets clients migrate to another instance *before* this
// one disappears, instead of finding out via a dead socket or a stalled
// stream. Docker (`stop`/`compose down`/`restart`) sends SIGTERM first and
// follows up with SIGKILL after a grace period, so everything here has to
// finish inside that window.
//
// On SIGTERM:
//   1. Flip `shuttingDown`. /readyz starts failing immediately, so a load
//      balancer stops sending new clients here (existing connections are
//      untouched by this step).
//   2. Stop accepting new connections at the HTTP server itself too, as a
//      second line of defense independent of the readiness probe.
//   3. Actively close every connection this instance is currently holding,
//      so clients migrate now rather than waiting to notice we're gone:
//        - SSE: write a named "shutdown" event, then end() the response.
//          A plain EventSource reconnects on its own the moment the stream
//          closes — no client-side reconnect code required.
//        - Socket.IO: emit a "shutdown" event, then close the transport
//          (`socket.conn.close()`) rather than the socket itself
//          (`socket.disconnect()`). This distinction matters: a
//          server-initiated `socket.disconnect()` is reported to the client
//          as reason "io server disconnect", which socket.io-client's
//          default reconnection logic treats as intentional and does NOT
//          retry. Closing the transport instead is reported as
//          "transport close" — indistinguishable from a network blip —
//          which DOES trigger the client's automatic reconnect. Net effect:
//          no client-side reconnect code needed here either; see
//          frontend/socket.js for how the client just listens and logs it.
//      Each close is delayed by a small random jitter so that when many
//      instances shut down together (a rolling restart touches every
//      replica), reconnects spread out instead of all landing on the
//      survivors — and on Redis — at once.
//   4. Once the drain window has elapsed, close the Redis connections and
//      exit cleanly.
//   5. A hard timeout forces process.exit() regardless, so one stuck
//      connection can't burn through the whole SIGKILL grace period.
// ---------------------------------------------------------------------------

const DRAIN_JITTER_MS = 4_000; // spread reconnects out over up to 4s
const FORCE_EXIT_MS = 12_000;  // must stay under whatever stop/restart grace period is used to run this (see rolling-restart.ps1)

function gracefulShutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining connections...`);

  // Safety net for the whole shutdown, started immediately so it bounds
  // everything below, not just the drain step.
  const forceExit = setTimeout(() => {
    console.warn('[shutdown] drain did not finish in time, forcing exit');
    process.exit(1);
  }, FORCE_EXIT_MS);

  // Stop accepting new connections. Existing ones are untouched by this
  // call; its callback only fires once every connection below has actually
  // closed, which is why we don't wait on it before exiting further down.
  httpServer.close(() => console.log('[shutdown] http server closed'));

  // --- SSE: notify + close each stream ---
  for (const set of sseClients.values()) {
    for (const res of set) {
      const delay = Math.random() * DRAIN_JITTER_MS;
      setTimeout(() => {
        try {
          res.write(`event: shutdown\ndata: ${JSON.stringify({ reason: 'server restarting' })}\n\n`);
          res.end();
        } catch {
          // stream may already be gone; nothing to do
        }
      }, delay);
    }
  }

  // --- Socket.IO: notify + close each transport ---
  for (const socket of io.of('/').sockets.values()) {
    const delay = Math.random() * DRAIN_JITTER_MS;
    socket.emit('shutdown', { reason: 'server restarting' });
    setTimeout(() => socket.conn.close(), delay);
  }

  // Give the jittered closes above time to run, then tear down Redis and
  // exit.
  setTimeout(async () => {
    clearTimeout(forceExit);
    await Promise.allSettled([pubClient.quit(), subClient.quit(), sseSub.quit()]);
    console.log('[shutdown] redis connections closed, exiting');
    process.exit(0);
  }, DRAIN_JITTER_MS + 500);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown); // Ctrl+C during local `docker compose up`
