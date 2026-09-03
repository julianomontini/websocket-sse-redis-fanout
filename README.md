# long-lived-connections POC

Proof of concept for pushing messages to connected clients across **multiple
instances** of a client-facing API, using **Redis Pub/Sub** as the backbone
between a "worker" (any backend that wants to notify a client) and however many
API instances are running.

It implements the same feature set over **two transports** so they can be
compared:

| Transport | Endpoint | Client |
|-----------|----------|--------|
| **Socket.IO** (WebSocket) | `ws://localhost:3000` (handshake path `/socket.io`) | `socket.io-client`, Postman |
| **SSE** (Server-Sent Events) | `GET http://localhost:3000/events` | browser `EventSource`, `curl -N` |

Both support the same two message types:

- **targeted** — delivered only to a specific `userId`
- **broadcast** — delivered to every connected client, on every instance

---

## Architecture

```
                                          ┌───────────── client-api (instance 1) ──────────── client
  POST /broadcast          publish         │   • Socket.IO server  (rooms = userId)
  POST /message/:userId  ───────────▶ redis ┤   • SSE endpoint      (Map<userId, streams>)
worker ──────────────▶            (pub/sub) │   both subscribe to Redis and relay locally
                                          └───────────── client-api (instance N) ──────────── client
```

- **worker** — simulates a backend service that wants to push a message to a
  client. Exposes `POST /broadcast` and `POST /message/:userId`. On every call
  it publishes to Redis on **both** transport channels.
- **client-api** — the client-facing service. Clients connect here (Socket.IO
  **or** SSE). Every instance subscribes to Redis; when a message arrives it is
  relayed to the matching local connections only.
- **redis** — plain Pub/Sub. No persistence, no queue. Every instance receives
  every message and decides locally whether it has the target connection.

### Why this works with N instances

A client is connected to exactly one `client-api` instance, and that live
socket/stream cannot be moved or serialized. So instead of routing, **every
instance receives every published message** and acts only if it holds the
target connection:

- **Socket.IO side** uses `@socket.io/redis-adapter`. Each connection does
  `socket.join(userId)`; the worker uses `@socket.io/redis-emitter` to publish,
  and the adapter delivers `io.to(userId)` / `io.emit()` to whichever instance
  has the socket.
- **SSE side** needs no adapter. Each instance keeps its own
  `Map<userId, Set<response stream>>` and subscribes to the plain Redis channel
  `sse:events`. On each message it writes to its local streams for that `userId`
  (or all streams, for a broadcast).

---

## Services

| Service     | Port | Notes |
|-------------|------|-------|
| client-api  | 3000 | Socket.IO + SSE |
| worker      | 3001 | publishes to Redis |
| redis       | 6379 | Pub/Sub only |

---

## Prerequisites

- Docker + Docker Compose (Docker Desktop on Windows/macOS).

Nothing else — Node, dependencies and TypeScript all run inside the containers.

---

## Running

```bash
docker compose up --build
```

Source is bind-mounted into each container and run with `ts-node-dev`
(`--respawn --poll`), so edits under `client-api/src` or `worker/src` reload
automatically — no image rebuild needed for code changes.

**Rebuild is only needed when a `package.json` changes.** Because `node_modules`
lives in an anonymous volume, also drop it so the new dependency is installed:

```bash
docker compose down -v
docker compose up --build
```

---

## Endpoints

### client-api (port 3000)

**Socket.IO** — connect with a `userid`:

| Where | How |
|-------|-----|
| Browser / `socket.io-client` | `io("http://localhost:3000", { auth: { userid: "1234" } })` |
| Or via query | `io("http://localhost:3000", { query: { userid: "1234" } })` |
| Non-browser only | `userid` request header |

The handshake is rejected (`connect_error: "missing userId"`) if no `userid` is
supplied. Messages arrive as the `message` event.

**SSE** — `GET /events?userid=1234`

- `Content-Type: text/event-stream`, one long-lived response.
- Each message is sent as `data: <json>\n\n` (the JSON is the `message` value).
- `: ping` comment lines every 25s as a heartbeat.
- `401` if `userid` is missing.

### worker (port 3001)

Both take a JSON body with a single key, `message` (string, number or object):

| Method & path | Effect |
|---------------|--------|
| `POST /broadcast` | send `message` to every connected client (both transports, all instances) |
| `POST /message/:userId` | send `message` only to connections for `:userId` |

Responses: `202` on success, `400` if `message` is missing.

---

## Try it

### SSE (no tooling needed)

Terminal 1 — subscribe as user `1234`:

```bash
curl -N "http://localhost:3000/events?userid=1234"
```

Terminal 2 — publish:

```bash
# targeted — shows up in terminal 1
curl -X POST http://localhost:3001/message/1234 \
  -H "content-type: application/json" -d "{\"message\":\"hi 1234\"}"

# broadcast — also shows up in terminal 1
curl -X POST http://localhost:3001/broadcast \
  -H "content-type: application/json" -d "{\"message\":\"hello everyone\"}"

# targeted at a different user — NOT shown in terminal 1
curl -X POST http://localhost:3001/message/9999 \
  -H "content-type: application/json" -d "{\"message\":\"nobody here\"}"
```

### Socket.IO

Use Postman's **Socket.IO** request (not raw WebSocket):

1. URL `http://localhost:3000`, handshake path `/socket.io`, client version v4.
2. Add a query param `userid = 1234` (Params tab).
3. Add a listener for the event name `message`.
4. Connect, then hit the same worker endpoints above — messages appear on the
   `message` event.

Or a throwaway Node client:

```js
const { io } = require("socket.io-client");
const s = io("http://localhost:3000", { auth: { userid: "1234" } });
s.on("message", (m) => console.log("message:", m));
s.on("connect_error", (e) => console.log("rejected:", e.message));
```

---

## Multi-instance / resilience test

Run more than one `client-api` (drop the fixed `container_name` first, or use a
Kubernetes Deployment):

```bash
docker compose up --scale client-api=3
```

Then:

1. Connect several clients (they land on different instances).
2. Publish targeted and broadcast messages — every client still receives what it
   should, regardless of which instance published or which instance holds it.
3. Kill the instance a client is on. The client (browser `EventSource`, or
   `socket.io-client`) reconnects to a surviving instance and keeps receiving
   messages.

---

## Development notes

- **File watching:** `ts-node-dev` runs with `--poll` because inotify events do
  not cross the Windows/macOS → Linux-container bind-mount boundary. Without it,
  code changes are not picked up until the container restarts.
- **Adapter debug logs:** `client-api` sets
  `DEBUG=socket.io:adapter,socket.io-redis` in `docker-compose.yml`. Remove it
  to quieten the logs.
- **Inspecting Redis:**

  ```bash
  docker compose exec redis redis-cli PUBSUB CHANNELS "*"
  docker compose exec redis redis-cli MONITOR
  ```

- Do **not** hand-craft `@socket.io/redis-adapter` messages with `redis-cli`.
  Its channel names and payload encoding (msgpack) are internal and version-
  specific. Publish through the worker (`@socket.io/redis-emitter`) instead. The
  `sse:events` channel *is* a plain JSON contract you own and can publish to
  directly if you want.

---

## Known simplifications (not production-ready)

- **Auth is client-asserted.** `userid` is taken straight from the handshake /
  query with no verification — any client can connect as any user. Real auth
  would verify a token (JWT / session cookie) in the Socket.IO `io.use()`
  middleware and on the SSE request, and derive `userId` from the verified
  claims.
- No message persistence or delivery guarantees — a client that is offline when
  a message is published simply misses it (Redis Pub/Sub is fire-and-forget).
- No backpressure handling on slow consumers.
- The worker publishes to both transport channels on every call purely so the
  two can be demoed side by side; a real system would pick one.

---

## Project layout

```
client-api/
  src/index.ts     Socket.IO server + Redis adapter + SSE endpoint
  Dockerfile
  package.json
worker/
  src/index.ts     POST /broadcast + POST /message/:userId -> Redis
  Dockerfile
  package.json
scripts/
  publish-user-1234.json   sample raw adapter payload (debugging only)
docker-compose.yml
```
