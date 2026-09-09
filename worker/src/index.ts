import express, { Request, Response } from 'express';
import Redis from 'ioredis';
import { Emitter } from '@socket.io/redis-emitter';

const app = express();
app.use(express.json());

// --- CORS ---
// The frontend (frontend/) calls this API directly from the browser, from a
// different origin/port, so every response needs CORS headers. This is a
// POC: allow any origin. A real deployment would restrict this to the known
// frontend origin(s).
app.use((req: Request, res: Response, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

const PORT = process.env.PORT || 3001;
const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';

// One plain Redis client, used two ways:
//  - handed to the Socket.IO Emitter (publishes on the redis-adapter channels)
//  - used directly to publish on our own plain channel for the SSE transport
const redis = new Redis(REDIS_URL);
const emitter = new Emitter(redis);

const SSE_CHANNEL = 'sse:events';

interface MessageBody {
  message?: unknown;
}

// Fan a message out on BOTH transports from a single trigger.
function dispatch(message: unknown, userId?: string): void {
  if (userId) {
    emitter.to(userId).emit('message', message);
    redis.publish(SSE_CHANNEL, JSON.stringify({ userId, message }));
  } else {
    emitter.emit('message', message);
    redis.publish(SSE_CHANNEL, JSON.stringify({ message }));
  }
}

// Broadcast to every connected client, on every client-api instance.
app.post('/broadcast', (req: Request<{}, {}, MessageBody>, res: Response) => {
  const { message } = req.body;
  if (message === undefined) {
    return res.status(400).json({ error: 'body must include "message"' });
  }
  dispatch(message);
  res.status(202).json({ delivered: 'broadcast' });
});

// Target a single user by id (the room / SSE key client-api uses per connection).
app.post('/message/:userId', (req: Request<{ userId: string }, {}, MessageBody>, res: Response) => {
  const { userId } = req.params;
  const { message } = req.body;
  if (message === undefined) {
    return res.status(400).json({ error: 'body must include "message"' });
  }
  dispatch(message, userId);
  res.status(202).json({ delivered: 'user', userId });
});

app.listen(PORT, () => {
  console.log(`worker listening on port ${PORT}`);
});
