import express, { Request, Response } from 'express';
import { Server } from "socket.io";
import { createServer } from 'http';
import Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';




const app = express();
app.use(express.json());

const httpServer = createServer(app);

const io = new Server(httpServer)


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

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`client-api listening on port ${PORT}`);
});
