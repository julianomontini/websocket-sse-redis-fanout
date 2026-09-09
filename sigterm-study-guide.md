# Study guide: SIGTERM & graceful shutdown

A learning path through the concepts behind this repo's graceful-shutdown
feature, in the order it makes sense to learn them. Each section says what
to understand, points at exactly where it shows up in this codebase (so you
have a working example to poke at, not just theory), and links further
reading. The README documents *how to run* things; this is about *why they
work*.

Rough time budget if you read linearly: 1–2 hours for sections 1–5 (the
core), another 20–30 minutes for section 6.

---

## 1. Unix signals — the foundation

A signal is an asynchronous notification the kernel delivers to a process —
not data, just "something happened, react if you want to." A process can
install a handler for most signals, ignore them, or do nothing (accept the
kernel's default action for that signal, which for most is "terminate").

The three that matter here:

| Signal | Number | Default action | Catchable? | Typical source |
|--------|--------|-----------------|------------|-----------------|
| `SIGINT`  | 2  | terminate | yes | Ctrl+C at a terminal |
| `SIGTERM` | 15 | terminate | yes | `kill` (default signal), Docker, process managers |
| `SIGKILL` | 9  | terminate | **no** | `kill -9`, Docker after a grace period expires |

The whole feature in this repo exists because of one fact: `SIGTERM` is a
**polite request** a process can catch and react to (run cleanup, then exit
on its own terms), while `SIGKILL` is the kernel forcibly tearing the
process down with **no notification given** — un-catchable, un-ignorable,
instant. Everything downstream (graceful shutdown, drain windows, grace
periods) is different strategies for using the SIGTERM window well before a
SIGKILL can arrive.

**Read:** [`signal(7)`](https://man7.org/linux/man-pages/man7/signal.7.html)
— the canonical reference; skim the signal list and the "standard actions"
column.

**Try it, using this repo:** the README's
["Ungraceful: kill one outright"](README.md#ungraceful-kill-one-outright)
vs. `.\rolling-restart.ps1` (which uses `docker restart`, SIGTERM-first) —
same instance disappearing, very different experience for a connected
client, purely because of which signal was used.

---

## 2. Processes in containers — PID 1 and the init problem

Two things are unusual about being PID 1 (the first process a container
runs) versus being an ordinary process:

1. **Default signal dispositions don't apply to PID 1** the same way. An
   ordinary process with no `SIGTERM` handler just dies when it receives
   one; PID 1 with no handler can simply **ignore** it, on some systems —
   which is part of why containers can seem to "hang" on `docker stop`
   until the grace period expires and `SIGKILL` finishes the job.
2. **Nothing reaps zombie processes** except PID 1. A real init system
   (`systemd`, etc.) does this on a normal machine; inside a container,
   unless *something* takes on that role, orphaned child processes can pile
   up as zombies.

This is why a container's PID 1 usually shouldn't be an application
directly — it should be a minimal init process that (a) correctly forwards
signals to the real application and (b) reaps zombies, then runs the real
app as its child.

**This bit for real, in this repo:** `docker-compose.override.yml` runs
client-api as `npm run dev` → `ts-node-dev --respawn` → (forks) the actual
Node process running `src/index.ts`. Confirmed by hand while building this:
sending `SIGTERM` to that container logged the shutdown handler's first
line and then the *container* died anyway, mid-drain — `ts-node-dev`
doesn't wait for its child to finish handling the signal before exiting
itself. See the comment starting `# tini as PID 1` in
[`client-api/Dockerfile`](client-api/Dockerfile) and the deeper writeup in
the README's ["A footgun this surfaced"](README.md#a-footgun-this-surfaced-npm-run-dev-eats-the-signal)
section for the full story, including the fix (`tini` as `ENTRYPOINT`, and
making the image's *default* command a plain `node dist/index.js` with no
wrapper in front of it at all).

**Read:** [`krallin/tini`](https://github.com/krallin/tini)'s own README
explains the problem and fix better than most blog posts do, in a few
paragraphs. If you want the long version with diagrams, "Container Init
Process" on devopsdirective.com is a solid deep dive.

**Try it:** `docker exec llc-client-api ps aux` (or, if you're on the
replicas stack, any `client-api-N` container name) and look at the process
tree — compare `tini -- npm run dev` (with its three extra layers under
`tini`) against `tini -- node dist/index.js` if you spin up
`docker-compose.replicas.yml` (single layer, no wrapper).

---

## 3. Node.js signal handling

Node exposes signals as ordinary events on the global `process` object.
Installing a listener changes Node's own default behavior for that signal:
with no listener, `SIGTERM` just kills the process (exit code 143); with a
listener, Node runs *your* code instead and does **not** exit on its own —
you're now responsible for calling `process.exit()` yourself, whenever
you're actually done.

Two subtleties that make the pattern in this repo work at all:

- A signal handler is just a normal (synchronous-entry) callback — but it's
  completely normal for it to *schedule* async work (`setTimeout`,
  promises) and return immediately. The process doesn't exit while there's
  still a pending timer or unresolved promise keeping the event loop alive
  — which is exactly what buys the handler time to actually drain
  connections instead of racing to finish before the process disappears.
- `process.exit(code)` is abrupt: it does not wait for pending I/O (open
  sockets, in-flight writes) to flush. That's why the code explicitly
  `await`s the Redis clients' `.quit()` calls *before* calling
  `process.exit(0)`, rather than trusting it to happen on its own.

**In this repo:** [`client-api/src/index.ts:231-281`](client-api/src/index.ts#L231-L281)
is the whole thing — `gracefulShutdown()`, and the two
`process.on('SIGTERM'/'SIGINT', gracefulShutdown)` calls at the bottom that
wire it up.

**Read:** [Node.js `process` docs](https://nodejs.org/api/process.html) —
the "Signal Events" section, and separately the entry for `process.exit()`.

---

## 4. The graceful shutdown pattern

Take signals and Node's event model out of it for a second — this is a
general server-design pattern, independent of language or framework:

1. **Stop accepting new work.** Whatever "new work" means for your server
   (new connections, new requests, new jobs off a queue) — turn it off
   first, before touching anything already in flight.
2. **Let what's in flight finish, or actively wrap it up.** For a
   short-lived request that's often just "let it complete." For a
   *long-lived* connection — the whole subject of this repo — there's
   nothing to "complete," so this step becomes "tell the other end and
   close deliberately" instead.
3. **Release held resources** (database/cache connections, file handles).
4. **Exit.**
5. **A hard timeout, running the entire time, that forces the issue** if
   any of the above hangs — because being killed anyway, ungracefully, is
   still better than never exiting and eating a `SIGKILL` at an
   unpredictable moment with zero cleanup done.

**Mapped onto this repo's code**, inside `gracefulShutdown()`:

| Step | Where |
|------|-------|
| 1. Stop accepting new work | the `shuttingDown` flag ([L34](client-api/src/index.ts#L34)), read by `/readyz` ([L176](client-api/src/index.ts#L176)) so the load balancer stops routing here; `httpServer.close()` ([L246](client-api/src/index.ts#L246)) stops new connections at this instance directly |
| 2. Wrap up in-flight work | the SSE loop ([L248-261](client-api/src/index.ts#L248-L261)) and Socket.IO loop ([L263-268](client-api/src/index.ts#L263-L268)) — see section 5 for *why* each does what it does |
| 3. Release resources | `pubClient.quit()` / `subClient.quit()` / `sseSub.quit()` ([L274](client-api/src/index.ts#L274)) |
| 4. Exit | `process.exit(0)` ([L276](client-api/src/index.ts#L276)) |
| 5. Hard timeout | `forceExit` ([L238-241](client-api/src/index.ts#L238-L241)) |

One detail worth understanding on its own: the **random jitter**
(`Math.random() * DRAIN_JITTER_MS`, [L228](client-api/src/index.ts#L228))
before each connection actually closes. This isn't about this one instance
— it's about what happens when *several* instances shut down together (a
rolling restart touches every replica, one after another, but each
individual instance's own drain is still its own event). Without jitter,
every connection on an instance closes at the exact same millisecond,
producing a synchronized burst of reconnects hitting the survivors (and
Redis) all at once — a small-scale version of what's usually called a
"thundering herd." Spreading the closes out over a few seconds turns one
spike into a trickle. This is a general distributed-systems technique, not
specific to SIGTERM — the same idea shows up in retry backoff, cache
expiry, and cron-job scheduling.

**Try it:** watch the log sequence live —
`docker compose -f docker-compose.yml -f docker-compose.replicas.yml logs -f client-api`
in one terminal, `.\rolling-restart.ps1` in another.

---

## 5. Client-side reconnection semantics

This is the part that's specific to *this* repo's two transports, and the
single most non-obvious fact in the whole feature: **how** you close a
connection changes what the client does next, even though "the connection
is now closed" is true either way.

- **SSE (`EventSource`)**: reconnection is built into the browser, per
  spec — when the underlying connection closes, for *any* reason, the
  browser reconnects on its own after a short delay. There's nothing to
  configure and no way to opt out (the app-level `shutdown` event this repo
  sends first, before closing, is purely an informational courtesy for the
  UI — see [`frontend/sse.js`](frontend/sse.js)).
- **Socket.IO** is more subtle, and getting it wrong is an easy mistake:
  `socket.io-client`'s default reconnection logic inspects *why* it
  disconnected. If the server called `socket.disconnect()`, the client
  receives reason `"io server disconnect"` and — by design — does **not**
  automatically reconnect, on the theory that the server meant to end the
  session for good. If instead the underlying transport just closes (a
  dropped WebSocket, a network blip), the client receives
  `"transport close"` and **does** reconnect automatically.

  `gracefulShutdown()` deliberately calls `socket.conn.close()` — closing
  the transport — rather than `socket.disconnect()`, specifically to get
  the second behavior instead of the first. See the comment at
  [`client-api/src/index.ts:207-217`](client-api/src/index.ts#L207-L217)
  for the full reasoning, and the actual calls at
  [L254-255](client-api/src/index.ts#L254-L255) (SSE) and
  [L266-267](client-api/src/index.ts#L266-L267) (Socket.IO).

The payoff of getting this right: [`frontend/sse.js`](frontend/sse.js) and
[`frontend/socket.js`](frontend/socket.js) contain **zero** manual
reconnect code. They just listen and log. The reconnect itself is the
browser/library's own default behavior, working as designed, because the
server closed things the way that behavior expects.

**Read:** [MDN, "Using server-sent events"](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
(reconnection section); [Socket.IO client docs, disconnection reasons](https://socket.io/docs/v4/client-socket-instance/)
(search the page for "io server disconnect").

---

## 6. Load balancers and connection draining, generally

This repo's `/readyz` mechanism (section 4, step 1) is one instance of a
much more general concept: **connection draining** — stop sending an
instance new work before you take it away, and give existing work a window
to finish or migrate. The same idea, different vocabulary, shows up
everywhere you'll encounter a load balancer:

- AWS ALB/NLB: "deregistration delay"
- nginx (used as the `lb` service in `docker-compose.replicas.yml`, see
  [`lb/nginx.conf`](lb/nginx.conf)): `nginx -s quit` (graceful) vs.
  `nginx -s stop` (immediate) — the same graceful/ungraceful distinction as
  `SIGTERM`/`SIGKILL`, one layer up
- Any rolling-deploy tool, really — the pattern is the same everywhere:
  *stop routing new traffic → let/help existing work finish → then remove
  the instance*.

Once you recognize this shape, section 4's five-step pattern generalizes
past "a Node process handling SIGTERM" to "basically any stateful service
being taken out of a pool while it's live."

---

## Suggested reading order

**If you only do one pass:** sections 1 → 3 → 4 → 5, in that order, reading
each "in this repo" pointer against the actual file open in your editor.
That's the complete story for *this* codebase specifically.

**If you want the fuller picture:** add 2 (the PID 1 bug is a genuinely
common real-world footgun, worth recognizing on sight).

Section 6 is a five-minute "oh, it's this pattern again" pass once the rest
has sunk in.
