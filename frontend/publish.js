// publish.js
//
// Thin wrapper around the worker's HTTP API: POST /broadcast and
// POST /message/:userId. This is what triggers a message that then arrives
// on the client-api connections via Redis pub/sub — see the top-level
// README's Architecture section.

/**
 * @param {string} baseUrl          worker base URL, e.g. "http://localhost:3001"
 * @param {string} message
 * @param {string} [targetUserId]   omit/blank to broadcast to everyone
 */
export async function publish(baseUrl, message, targetUserId) {
  const path = targetUserId
    ? `/message/${encodeURIComponent(targetUserId)}`
    : '/broadcast';

  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`worker responded ${res.status}: ${body}`);
  }

  return res.json();
}
