// sse.js
//
// Thin wrapper around the browser's native EventSource for client-api's
// GET /events endpoint. There is intentionally NO reconnect logic in here:
// EventSource reconnects on its own whenever the connection drops, whether
// that's a network blip or the server deliberately ending the stream during
// its graceful shutdown (see client-api/src/index.ts, "Graceful shutdown").
// This module just opens the connection and reports what happens through the
// callbacks passed in — app.js decides what to do with that.

let source = null;

/**
 * Open an SSE connection.
 *
 * @param {string} baseUrl  client-api base URL, e.g. "http://localhost:3000"
 * @param {string} userId
 * @param {{
 *   onStatusChange: (status: "connecting" | "connected" | "disconnected") => void,
 *   onMessage: (data: unknown) => void,
 *   onShutdownNotice: (data: unknown) => void,
 * }} handlers
 */
export function connectSse(baseUrl, userId, handlers) {
  if (source) disconnectSse();

  const url = `${baseUrl}/events?userid=${encodeURIComponent(userId)}`;
  source = new EventSource(url);
  handlers.onStatusChange('connecting');

  source.onopen = () => handlers.onStatusChange('connected');

  // Fires both on a genuine error and right before EventSource silently
  // starts retrying on its own (readyState becomes CONNECTING) — either way
  // we're not "connected" again until onopen fires.
  source.onerror = () => {
    if (!source) return;
    handlers.onStatusChange(
      source.readyState === EventSource.CONNECTING ? 'connecting' : 'disconnected'
    );
  };

  // Default (unnamed) SSE event — a regular pushed message from the worker.
  source.onmessage = (event) => {
    handlers.onMessage(safeParse(event.data));
  };

  // Named event the server sends just before it closes the stream as part of
  // its own graceful shutdown. This is purely informational for the UI — the
  // reconnect itself happens automatically, above, with no extra code.
  source.addEventListener('shutdown', (event) => {
    handlers.onShutdownNotice(safeParse(event.data));
  });
}

export function disconnectSse() {
  if (!source) return;
  source.close();
  source = null;
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
