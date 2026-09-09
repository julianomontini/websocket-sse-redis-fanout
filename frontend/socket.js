// socket.js
//
// Thin wrapper around socket.io-client (loaded globally via the CDN
// <script> tag in index.html, which exposes a global `io` function). As with
// sse.js, there is NO manual reconnect logic here: socket.io-client
// reconnects on its own by default, and the server closes connections during
// its shutdown in a way that's indistinguishable from a network drop
// specifically so that default behavior kicks in — see the "Graceful
// shutdown" comment in client-api/src/index.ts for why that distinction
// (closing the transport vs. calling socket.disconnect()) matters.

let socket = null;

/**
 * @param {string} baseUrl  client-api base URL, e.g. "http://localhost:3000"
 * @param {string} userId
 * @param {{
 *   onStatusChange: (status: "connecting" | "connected" | "disconnected") => void,
 *   onMessage: (data: unknown) => void,
 *   onShutdownNotice: (data: unknown) => void,
 * }} handlers
 */
export function connectSocket(baseUrl, userId, handlers) {
  if (socket) disconnectSocket();

  handlers.onStatusChange('connecting');
  // transports: ['websocket'] must match the server (see the matching
  // comment on the `io = new Server(...)` call in client-api/src/index.ts)
  // — otherwise the client's default polling-first handshake breaks behind
  // the nginx lb in docker-compose.replicas.yml, which load-balances
  // across more than one instance with no session affinity.
  socket = io(baseUrl, { auth: { userid: userId }, transports: ['websocket'] });

  socket.on('connect', () => handlers.onStatusChange('connected'));

  // A drop while the client's built-in reconnection logic is still trying
  // (the default). It only gives up after `reconnect_failed`, below.
  socket.on('disconnect', () => handlers.onStatusChange('connecting'));
  socket.on('connect_error', () => handlers.onStatusChange('connecting'));
  socket.on('reconnect_failed', () => handlers.onStatusChange('disconnected'));

  // Regular pushed message from the worker.
  socket.on('message', (data) => handlers.onMessage(data));

  // Custom event the server emits just before it closes the transport as
  // part of its own graceful shutdown. Purely informational for the UI — the
  // reconnect itself is handled automatically by socket.io-client, above.
  socket.on('shutdown', (data) => handlers.onShutdownNotice(data));
}

export function disconnectSocket() {
  if (!socket) return;
  socket.disconnect();
  socket = null;
}
