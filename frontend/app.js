// app.js
//
// Entry point: reads the config inputs, wires the SSE / Socket.IO / publish
// modules to the DOM, and renders everything into the log panel. No
// framework, no state library — direct DOM updates only, on purpose, so
// there's nothing to learn beyond this file and the three it imports.

import { connectSse, disconnectSse } from './sse.js';
import { connectSocket, disconnectSocket } from './socket.js';
import { publish } from './publish.js';

const $ = (id) => document.getElementById(id);

const clientApiUrlInput = $('clientApiUrl');
const workerUrlInput = $('workerUrl');
const userIdInput = $('userId');

const logEl = $('log');

function log(line) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(el, status) {
  el.textContent = status;
  el.className = `status status-${status}`;
}

// --- SSE wiring ---

const sseStatusEl = $('sse-status');

$('sse-connect').addEventListener('click', () => {
  log('[sse] connecting...');
  connectSse(clientApiUrlInput.value, userIdInput.value, {
    onStatusChange: (status) => setStatus(sseStatusEl, status),
    onMessage: (data) => log(`[sse] message: ${JSON.stringify(data)}`),
    onShutdownNotice: (data) =>
      log(`[sse] server is shutting down (${JSON.stringify(data)}) — reconnecting automatically`),
  });
});

$('sse-disconnect').addEventListener('click', () => {
  disconnectSse();
  setStatus(sseStatusEl, 'disconnected');
  log('[sse] disconnected (manual)');
});

// --- Socket.IO wiring ---

const wsStatusEl = $('ws-status');

$('ws-connect').addEventListener('click', () => {
  log('[ws] connecting...');
  connectSocket(clientApiUrlInput.value, userIdInput.value, {
    onStatusChange: (status) => setStatus(wsStatusEl, status),
    onMessage: (data) => log(`[ws] message: ${JSON.stringify(data)}`),
    onShutdownNotice: (data) =>
      log(`[ws] server is shutting down (${JSON.stringify(data)}) — reconnecting automatically`),
  });
});

$('ws-disconnect').addEventListener('click', () => {
  disconnectSocket();
  setStatus(wsStatusEl, 'disconnected');
  log('[ws] disconnected (manual)');
});

// --- Publish wiring ---

$('pub-send').addEventListener('click', async () => {
  const message = $('pub-message').value;
  const target = $('pub-target').value.trim();
  try {
    const result = await publish(workerUrlInput.value, message, target || undefined);
    log(`[publish] sent: ${JSON.stringify(result)}`);
  } catch (err) {
    log(`[publish] failed: ${err.message}`);
  }
});

// --- Log ---

$('log-clear').addEventListener('click', () => {
  logEl.textContent = '';
});

log('ready — set your config above, then connect SSE and/or Socket.IO.');
