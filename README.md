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

It also includes a minimal browser **frontend** (framework-free) to drive both
transports by hand, and **graceful shutdown** on `client-api` so that when an
instance is terminated (a rolling restart, `docker stop`), its clients are
told to move to another instance *before* it disappears, instead of finding
out via a dead connection. See [Graceful shutdown](#graceful-shutdown) for
the mechanism, and
[Multiple replicas via Docker Compose](#multiple-replicas-via-docker-compose)
to see it actually run a rolling restart across several instances.

---

## Architecture

```
                                          ┌───────────── client-api (instance 1) ──────────── client
  POST /broadcast          publish         │   • Socket.IO server  (rooms = userId)           (frontend/,
  POST /message/:userId  ───────────▶ redis ┤   • SSE endpoint      (Map<userId, streams>)      or any
worker ──────────────▶            (pub/sub) │   both subscribe to Redis and relay locally        client)
                              ▲           └───────────── client-api (instance N) ──────────── client
                              │
                    frontend/ also calls worker directly (POST /broadcast, /message/:userId)
```

- **worker** — simulates a backend service that wants to push a message to a
  client. Exposes `POST /broadcast` and `POST /message/:userId`. On every call
  it publishes to Redis on **both** transport channels.
- **client-api** — the client-facing service. Clients connect here (Socket.IO
  **or** SSE). Every instance subscribes to Redis; when a message arrives it is
  relayed to the matching local connections only. Also handles its own graceful
  shutdown — see below.
- **redis** — plain Pub/Sub. No persistence, no queue. Every instance receives
  every message and decides locally whether it has the target connection.
- **frontend** — a static, no-framework test page. Connects to `client-api` over
  SSE and/or Socket.IO, and can call `worker` to publish messages — everything
  in this README's "Try it" section, but clickable.

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
| client-api  | 3000 | Socket.IO + SSE, `/healthz` + `/readyz` |
| worker      | 3001 | publishes to Redis |
| redis       | 6379 | Pub/Sub only |
| frontend    | 8080 | static test page, see [Frontend](#frontend) |
| lb          | 3000 | only exists when running multiple replicas — see [below](#multiple-replicas-via-docker-compose); takes over port 3000 from client-api |

---

## Prerequisites

- Docker + Docker Compose (Docker Desktop on Windows/macOS).

Nothing else — Node, dependencies and TypeScript all run inside the containers.

---

## Running

```bash
docker compose up --build
```

Then open **http://localhost:8080** — the frontend — or use the `curl`/Postman
examples in [Try it](#try-it) directly.

(This is actually two files — `docker-compose.yml` plus
`docker-compose.override.yml`, merged automatically since no `-f` flag is
given. See [Multiple replicas via Docker Compose](#multiple-replicas-via-docker-compose)
for why they're split, and what layering a third file over them gets you.)

Source is bind-mounted into each container and run with `ts-node-dev`
(`--respawn --poll`), so edits under `client-api/src` or `worker/src` reload
automatically — no image rebuild needed for code changes.

**Rebuild is only needed when a `package.json` changes.** Because `node_modules`
lives in an anonymous volume, also drop it so the new dependency is installed:

```bash
docker compose down -v
docker compose up --build
```

The `frontend` service is different: it's static files baked into an nginx
image at build time (no bind mount, nothing to hot-reload), so any edit under
`frontend/` needs `docker compose up --build frontend` to take effect.

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
supplied. Messages arrive as the `message` event. A `shutdown` event means
the server is about to close the connection as part of a graceful shutdown —
see [Graceful shutdown](#graceful-shutdown). `socket.io-client`'s default
reconnection logic handles reconnecting on its own; no client action is
required.

The server only accepts the **WebSocket** transport (`transports:
['websocket']`), not socket.io's default HTTP long-polling fallback — a
client must pass the same option (`frontend/socket.js` does). This isn't
about performance: long-polling makes several separate HTTP requests per
session, which needs sticky sessions to keep them all on the same instance
once there's more than one — something the `lb` service below doesn't
provide out of the box. A WebSocket connection is a single long-lived
connection instead, routed once, so it needs no session affinity at all —
see [Multiple replicas via Docker Compose](#multiple-replicas-via-docker-compose).

**SSE** — `GET /events?userid=1234`

- `Content-Type: text/event-stream`, one long-lived response.
- Each message is sent as `data: <json>\n\n` (the JSON is the `message` value).
- `: ping` comment lines every 25s as a heartbeat.
- `401` if `userid` is missing.
- If a `shutdown` event arrives (`event: shutdown\ndata: {...}\n\n`), the
  server is about to close this stream as part of a graceful shutdown — see
  [Graceful shutdown](#graceful-shutdown). A plain `EventSource` reconnects
  automatically; no client action is required.

**Health/readiness** — generic endpoints any health check or load balancer can poll:

| Path | Meaning |
|------|---------|
| `GET /healthz` | liveness — 200 once the process is up |
| `GET /readyz` | readiness — 200 normally, 503 while draining for shutdown |

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

## Frontend

A deliberately minimal, framework-free static page under `frontend/`, so
there's nothing between you and what's actually happening on the wire:

```
frontend/
  index.html   page structure — three sections: config, connections, publish, log
  style.css    styling only
  sse.js       wraps the browser's native EventSource for GET /events
  socket.js    wraps socket.io-client (loaded globally via a CDN <script> tag)
  publish.js   wraps fetch() calls to worker's POST /broadcast, /message/:userId
  app.js       entry point — wires the three modules above to the DOM
  Dockerfile   nginx:alpine serving the files above, no build step
```

No bundler, no npm install for the frontend itself — the only external
dependency is `socket.io-client`, loaded straight from `cdn.socket.io` via a
`<script>` tag in `index.html`; everything else is plain ES modules the
browser resolves natively (`import` in `app.js`).

Open it at **http://localhost:8080** (via `docker compose`). It has three
config fields (client-api URL, worker URL, userId), Connect/Disconnect
buttons for each transport, a form
that calls `worker`, and a log of everything that happens, including
`shutdown` notices from client-api and the automatic reconnect that follows.

Neither `sse.js` nor `socket.js` contain any manual reconnect code — that's
intentional, see [Graceful shutdown](#graceful-shutdown) for why the browser
already does the right thing on its own once client-api closes a connection
the right way.

---

## Graceful shutdown

`docker stop` / `docker compose down` terminates a container by sending
**`SIGTERM`**, then following up with `SIGKILL` after a grace period if the
process hasn't exited by then. Killing client-api that
way, with no handler, just drops every connection it's holding — clients
recover eventually (see previous section), but only after they notice.

`client-api/src/index.ts` installs a `SIGTERM`/`SIGINT` handler that instead
**drains** the instance — see the "Graceful shutdown" comment block at the
bottom of that file for the full reasoning. In short, on receiving the
signal it:

1. Flips a `shuttingDown` flag — `/readyz` immediately starts returning `503`
   (so the load balancer stops routing new clients here).
2. Stops the HTTP server from accepting new connections.
3. For every SSE stream and Socket.IO connection it currently holds: sends a
   `shutdown` notice, then closes the connection — spread out over a few
   seconds of random jitter, so many instances shutting down together (a
   rolling deploy) don't all dump their clients on the survivors at once.
4. Closes its Redis connections and exits — or force-exits after a timeout if
   something got stuck, so it never eats the whole `SIGKILL` grace period.

The close in step 3 is deliberately done in a way that looks like a **network
drop** rather than an intentional disconnect:

- **SSE**: ending the response stream is exactly what a `EventSource` already
  auto-reconnects from — nothing special needed.
- **Socket.IO**: closing the transport (`socket.conn.close()`) rather than
  the socket (`socket.disconnect()`) matters — the latter is reported to the
  client as `"io server disconnect"`, which `socket.io-client`'s default
  reconnection logic treats as intentional and does **not** retry. The former
  is reported as `"transport close"`, indistinguishable from a dropped
  network, which **does** auto-reconnect.

That's why `frontend/sse.js` and `frontend/socket.js` contain no reconnect
logic at all — the `shutdown` event they log is just a heads-up for the UI;
the actual recovery is the browser/library's default behavior, working as
designed.

### A footgun this surfaced: `npm run dev` eats the signal

Confirmed by hand while building this: if client-api is run the way
`docker-compose.yml` normally runs it — `npm run dev`, i.e.
`ts-node-dev --respawn --poll` watching for file changes — sending it
`SIGTERM` logs the handler's *first* line ("draining connections...") and
then the container just dies anyway, mid-drain. `ts-node-dev` manages the
real script as a child process for its respawn-on-change feature, and does
not wait for that child to finish handling the signal before exiting itself,
taking the whole container down with it.

That's exactly the scenario this feature is for, so it can't be left broken.
Fix, in `client-api/Dockerfile` and `worker/Dockerfile`:

- `tini` as `ENTRYPOINT` (general good practice for signal handling / zombie
  reaping in any container).
- The image's **default** `CMD` is the plain compiled output —
  `node dist/index.js` — not `npm run dev`. Plain `node` has no
  respawn-wrapper in the way, so there's nothing to race against. This is
  the command `docker-compose.replicas.yml` actually runs (no override).
- `docker-compose.override.yml` explicitly overrides `command: ["npm", "run",
  "dev"]` for `client-api` (`worker`'s equivalent override is inline in the
  base file, since worker never needs to be scale-safe), opting back into the
  dev/hot-reload behavior for local iteration — that override is *only*
  about which command Compose happens to run; it doesn't change the image's
  default.

Net effect: normal `docker compose up` still hot-reloads on file changes,
exactly as before. But it also means **that same `docker compose up`
container is not a reliable way to test the SIGTERM handler** — it's
running the dev/respawn command on purpose. The next section is where to
actually see it run, against the image's default (production-style)
command instead.

---

## Multiple replicas via Docker Compose

The easiest way to see everything above actually happen — several
instances, one of them going away, its clients migrating. Confirmed working
by hand, including the exact commands below.

### Why a load balancer is needed

Plain `docker compose up --scale client-api=3` gives you 3 containers, but
**no single address that distributes across them** — Compose doesn't
provide one on its own. Without one, a fixed host port
can only ever be held by one of the three replicas anyway (Compose refuses
to even start the others), so the frontend would always talk to the same
one instance, defeating the point.

`docker-compose.replicas.yml` (an opt-in overlay — see its own comment for
exactly what it changes) adds a tiny `lb` service instead: `nginx:alpine`
with the config at `lb/nginx.conf`, published on the same host port 3000
the frontend already expects. It resolves the `client-api` hostname via
Docker's own embedded DNS, re-resolving every 10s so it picks up replicas
that get restarted, without needing a reload. One consequence worth
knowing: this doesn't give the HTTP-long-polling transport the sticky
sessions it would need across replicas, which is the whole reason
client-api and the frontend are configured **WebSocket-only** — see the
Socket.IO note under [Endpoints](#endpoints).

### Start it

```bash
docker compose -f docker-compose.yml -f docker-compose.replicas.yml up -d --build --scale client-api=3
```

This intentionally does *not* merge `docker-compose.override.yml` (the file
that gives plain `docker compose up` its fixed container name / bind mount /
hot-reload command) — passing explicit `-f` flags makes Compose skip
auto-loading it, which is what leaves `client-api` scalable. Confirm the
shape of things:

```bash
docker compose -f docker-compose.yml -f docker-compose.replicas.yml ps
```

Three `client-api` replicas with no published port of their own, one `lb`
on `0.0.0.0:3000`. Open the frontend at **http://localhost:8080** (or
`curl -N "http://localhost:3000/events?userid=1234"`) exactly as usual —
same port, now backed by three instances instead of one.

### Ungraceful: kill one outright

```bash
docker compose -f docker-compose.yml -f docker-compose.replicas.yml ps client-api
docker kill <one-of-the-three-container-names>
```

The client recovers, but only after it notices the connection is dead —
no `shutdown` notice, no `[shutdown]` log lines, since `SIGKILL` gives the
process no chance to run anything.

### Graceful: a rolling restart

```powershell
.\rolling-restart.ps1
```

This restarts each of the three replicas **one at a time**, waiting for
each to answer `/readyz` again before moving to the next — see the script's
own comment for exactly how. With the frontend (or a `curl -N` SSE session)
connected beforehand, watch it live: a `shutdown` notice, then a reconnect,
right when the replica it happened to be on gets cycled — the *other* two
replicas keep serving the whole time, which is realistic; that's the point
of running more than one instance. Confirmed by hand: the SSE stream
plainly shows `: connected` → `: ping` → `event: shutdown` → the stream
ending, in that order, with no gaps.

### Cleanup / back to normal

```bash
docker compose -f docker-compose.yml -f docker-compose.replicas.yml down
docker compose up --build
```

The second command goes back to the single-instance hot-reload setup —
`docker-compose.override.yml` merges automatically again once no other `-f`
flags are given.

---

## Development notes

- **File watching:** `ts-node-dev` runs with `--poll` because inotify events do
  not cross the Windows/macOS → Linux-container bind-mount boundary. Without it,
  code changes are not picked up until the container restarts.
- **Adapter debug logs:** `client-api` sets
  `DEBUG=socket.io:adapter,socket.io-redis` in `docker-compose.yml`. Remove it
  to quieten the logs.
- **Image default command vs. the dev override:** `client-api`'s and
  `worker`'s Dockerfiles default to `node dist/index.js` (production-style;
  what `docker-compose.replicas.yml` relies on getting unmodified).
  `docker-compose.override.yml` overrides that to the `npm run dev`
  hot-reload command, plus the fixed container name / host port / bind
  mount, for local iteration — Compose auto-merges that file whenever no
  `-f` flag is given, which is also exactly why `docker-compose.replicas.yml`
  passes explicit `-f`/skips it. See [Graceful shutdown](#graceful-shutdown)
  for why the command had to actually differ, not just add a flag to the
  same one.
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
  This is still true for the reconnect *window* during a graceful shutdown —
  it's shortened by draining proactively, not eliminated.
- No backpressure handling on slow consumers.
- The worker publishes to both transport channels on every call purely so the
  two can be demoed side by side; a real system would pick one.
- **Graceful shutdown only covers `SIGTERM`.** A hard crash, OOM-kill, or
  `SIGKILL` gives the process no chance to run any handler — clients still
  recover in that case (see "Ungraceful: kill one outright" under
  [Multiple replicas via Docker Compose](#multiple-replicas-via-docker-compose)),
  just without the proactive notice or the reconnect jitter, the same as
  before this feature existed.
- **Socket.IO is WebSocket-only** (`transports: ['websocket']`, both server
  and frontend) — see the note under [Endpoints](#endpoints). A client on a
  network that blocks WebSocket entirely (rare, but some restrictive
  corporate proxies do) has no long-polling fallback to fall back to here.
- CORS is wide open (`Access-Control-Allow-Origin: *`) on both `client-api`
  and `worker`, to let the static frontend call them from a different origin
  with no configuration. A real deployment would restrict this to the actual
  frontend origin(s).

---

## Project layout

```
client-api/
  src/index.ts     Socket.IO server + Redis adapter + SSE endpoint + graceful shutdown
  Dockerfile
  package.json
worker/
  src/index.ts     POST /broadcast + POST /message/:userId -> Redis
  Dockerfile
  package.json
frontend/
  index.html       page structure
  style.css        styling
  sse.js           EventSource wrapper
  socket.js        socket.io-client wrapper
  publish.js       fetch() wrapper for worker's endpoints
  app.js           entry point, wires the above to the DOM
  Dockerfile       nginx:alpine serving the static files, no build step
lb/
  nginx.conf       load balancer config for docker-compose.replicas.yml
docker-compose.yml           base file — minimal/scale-safe client-api, see its own comment
docker-compose.override.yml  auto-merged dev overlay (hot reload, fixed name/port)
docker-compose.replicas.yml  opt-in overlay for multiple client-api replicas + the lb service
rolling-restart.ps1          simulates a rolling restart across replicas, see Multiple replicas via Docker Compose
```
