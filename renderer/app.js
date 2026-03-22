'use strict';

/**
 * app.js — Bracer Chat renderer process.
 * Communicates with main process exclusively via window.bracerChat (context bridge).
 * No Node.js or Electron APIs used directly.
 */

// ── Constants ──────────────────────────────────────────────────────────────
const THIRTY_DAYS_MS  = 30 * 24 * 60 * 60 * 1000;
const PINNED_STORAGE_KEY = 'bracerChat_pinnedMessages';

// ── State ──────────────────────────────────────────────────────────────────
let sessionInfo  = null;
let activeRoomId = null;
let ctxTargetEventId = null; // event_id of the message the context menu opened on

// ── DOM refs ───────────────────────────────────────────────────────────────
const elRoomName    = document.getElementById('room-name');
const elConnStatus  = document.getElementById('connection-status');
const elMessages    = document.getElementById('messages');
const elMsgInput    = document.getElementById('msg-input');
const elBtnSend     = document.getElementById('btn-send');
const elBtnAttach   = document.getElementById('btn-attach');
const elBtnShot     = document.getElementById('btn-screenshot');
const elBtnTicket   = document.getElementById('btn-ticket');
const elStatusBar   = document.getElementById('status-bar');
const elDragOverlay = document.querySelector('.drag-overlay');
const elPinnedPanel = document.getElementById('pinned-panel');
const elPinnedHeader= document.getElementById('pinned-header');
const elPinnedList  = document.getElementById('pinned-list');
const elPinnedCount = document.getElementById('pinned-count');
const elCtxMenu     = document.getElementById('ctx-menu');
const elCtxPin      = document.getElementById('ctx-pin');

// ── Pinned messages (localStorage) ─────────────────────────────────────────

function loadPinned() {
  try {
    return JSON.parse(localStorage.getItem(PINNED_STORAGE_KEY) || '[]');
  } catch { return []; }
}

function savePinned(pins) {
  localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(pins));
}

function isPinned(eventId) {
  return loadPinned().some(p => p.event_id === eventId);
}

function pinMessage(event) {
  const pins = loadPinned();
  if (pins.some(p => p.event_id === event.event_id)) return; // already pinned
  pins.push({
    event_id: event.event_id,
    sender  : event.sender,
    body    : event.content && event.content.body ? event.content.body : '[attachment]',
    ts      : event.origin_server_ts,
    pinnedAt: Date.now()
  });
  savePinned(pins);
  renderPinnedPanel();
  // Highlight the message bubble
  const bubble = document.querySelector(`[data-event-id="${event.event_id}"]`);
  if (bubble) bubble.classList.add('pinned-highlight');
}

function unpinMessage(eventId) {
  const pins = loadPinned().filter(p => p.event_id !== eventId);
  savePinned(pins);
  renderPinnedPanel();
  const bubble = document.querySelector(`[data-event-id="${eventId}"]`);
  if (bubble) bubble.classList.remove('pinned-highlight');
}

function renderPinnedPanel() {
  const pins = loadPinned();
  elPinnedCount.textContent = pins.length;

  if (pins.length === 0) {
    elPinnedPanel.classList.add('empty');
    return;
  }
  elPinnedPanel.classList.remove('empty');

  elPinnedList.innerHTML = '';
  for (const pin of pins) {
    const item = document.createElement('div');
    item.className = 'pinned-item';

    const sender = document.createElement('span');
    sender.className   = 'pin-sender';
    sender.textContent = senderLabel(pin.sender);

    const body = document.createElement('span');
    body.className   = 'pin-body';
    body.textContent = pin.body.length > 80 ? pin.body.slice(0, 80) + '…' : pin.body;

    const removeBtn = document.createElement('button');
    removeBtn.className   = 'pin-remove';
    removeBtn.textContent = '×';
    removeBtn.title       = 'Unpin';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      unpinMessage(pin.event_id);
    });

    item.appendChild(sender);
    item.appendChild(body);
    item.appendChild(removeBtn);

    // Click item → scroll to that message bubble
    item.addEventListener('click', () => {
      const bubble = document.querySelector(`[data-event-id="${pin.event_id}"]`);
      if (bubble) bubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    elPinnedList.appendChild(item);
  }
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  try {
    sessionInfo  = await window.bracerChat.getSessionInfo();
    activeRoomId = sessionInfo.machineRoomId;

    elRoomName.textContent   = `Support — ${sessionInfo.hostname}`;
    elConnStatus.textContent = 'Loading history…';

    renderPinnedPanel();
    await loadHistory();

    elConnStatus.textContent = 'Connected';

    // Start listening for new messages delivered by the sync loop
    window.bracerChat.onNewMessage(handleIncomingMessage);

  } catch (err) {
    elConnStatus.textContent = 'Error';
    showStatus('Failed to load: ' + err.message);
    console.error('[app] Init error:', err);
  }
}

// ── Message rendering ──────────────────────────────────────────────────────

function formatTime(tsMs) {
  if (!tsMs) return '';
  return new Date(tsMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Extract a readable display name from a Matrix user ID (@user:server). */
function senderLabel(userId) {
  const m = userId && userId.match(/^@([^:]+):/);
  return m ? m[1] : (userId || 'Unknown');
}

/**
 * Builds and appends (or prepends) a message bubble.
 */
async function renderMessage(event, prepend = false) {
  if (!event || !event.content) return;

  const isOwn  = sessionInfo && event.sender === sessionInfo.userId;
  const content = event.content;

  const wrap = document.createElement('div');
  wrap.className       = `message ${isOwn ? 'own' : 'other'}`;
  wrap.dataset.eventId = event.event_id || '';

  // Highlight if pinned
  if (event.event_id && isPinned(event.event_id)) {
    wrap.classList.add('pinned-highlight');
  }

  // Sender label (hidden for own messages via CSS)
  const senderEl = document.createElement('div');
  senderEl.className   = 'sender';
  senderEl.textContent = senderLabel(event.sender);
  wrap.appendChild(senderEl);

  // Body
  const bodyEl = document.createElement('div');
  bodyEl.className = 'body';

  switch (content.msgtype) {
    case 'm.text': {
      bodyEl.textContent = content.body || '';
      break;
    }

    case 'm.image': {
      if (content.url) {
        const img = document.createElement('img');
        img.alt   = content.body || 'image';
        const httpUrl = await window.bracerChat.resolveMediaUrl(content.url);
        if (httpUrl) {
          img.src = httpUrl;
          img.addEventListener('click', () => window.bracerChat.openExternal(httpUrl));
        }
        bodyEl.appendChild(img);
      } else {
        bodyEl.textContent = content.body || '[image]';
      }
      break;
    }

    case 'm.file': {
      const link = document.createElement('a');
      link.className   = 'file-link';
      link.textContent = content.body || 'Download file';
      link.href        = '#';
      if (content.url) {
        const httpUrl = await window.bracerChat.resolveMediaUrl(content.url);
        if (httpUrl) {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            window.bracerChat.openExternal(httpUrl);
          });
        }
      }
      bodyEl.appendChild(link);
      break;
    }

    default:
      bodyEl.textContent = content.body || '[unsupported message type]';
  }

  wrap.appendChild(bodyEl);

  // Timestamp
  const timeEl = document.createElement('div');
  timeEl.className   = 'time';
  timeEl.textContent = formatTime(event.origin_server_ts);
  wrap.appendChild(timeEl);

  // Store event data on the element for context menu
  wrap._matrixEvent = event;

  if (prepend) {
    elMessages.insertBefore(wrap, elMessages.firstChild);
  } else {
    elMessages.appendChild(wrap);
  }
}

async function loadHistory() {
  elMessages.innerHTML = '';
  const events      = await window.bracerChat.getRoomHistory(activeRoomId);
  const cutoff      = Date.now() - THIRTY_DAYS_MS;
  const pinnedIds   = new Set(loadPinned().map(p => p.event_id));

  for (const event of events) {
    if (event.type !== 'm.room.message') continue;
    // Show if within 30 days OR pinned
    if (event.origin_server_ts >= cutoff || pinnedIds.has(event.event_id)) {
      await renderMessage(event);
    }
  }
  scrollToBottom();
}

function scrollToBottom() {
  elMessages.scrollTop = elMessages.scrollHeight;
}

// ── Incoming messages (from sync loop) ────────────────────────────────────

async function handleIncomingMessage({ roomId, event }) {
  if (roomId !== activeRoomId) return;
  if (event.event_id && document.querySelector(`[data-event-id="${event.event_id}"]`)) return;
  await renderMessage(event);
  scrollToBottom();
}

// ── Send message ───────────────────────────────────────────────────────────

async function sendMessage() {
  const text = elMsgInput.value.trim();
  if (!text) return;

  elMsgInput.value = '';
  autoResizeTextarea();
  elBtnSend.disabled = true;

  try {
    await window.bracerChat.sendMessage(activeRoomId, text);
  } catch (err) {
    showStatus('Send failed: ' + err.message);
    elMsgInput.value = text;
  } finally {
    elBtnSend.disabled = false;
    elMsgInput.focus();
  }
}

// ── Attach file (native dialog) ────────────────────────────────────────────

async function attachFile() {
  elBtnAttach.disabled = true;
  try {
    const result = await window.bracerChat.openFileDialog();
    if (!result) return; // user cancelled
    await sendFileByPath(result);
  } catch (err) {
    showStatus('Attach failed: ' + err.message);
  } finally {
    elBtnAttach.disabled = false;
  }
}

async function sendFileByPath({ path, name, mimeType, data }) {
  const MAX = 100 * 1024 * 1024;
  if (data.byteLength > MAX) {
    showStatus(`File too large: ${(data.byteLength / 1024 / 1024).toFixed(1)} MB (max 100 MB)`);
    return;
  }
  showStatus(`Uploading ${name}…`);
  try {
    await window.bracerChat.sendFile(activeRoomId, data, name, mimeType);
    hideStatus();
  } catch (err) {
    showStatus('Upload failed: ' + err.message);
  }
}

// ── Send screenshot ────────────────────────────────────────────────────────

async function sendScreenshot() {
  elBtnShot.disabled = true;
  showStatus('Capturing screenshot…');

  try {
    await window.bracerChat.sendScreenshot(activeRoomId);
    hideStatus();
  } catch (err) {
    showStatus('Screenshot failed: ' + err.message, 0); // persistent
    console.error('[app] Screenshot error:', err);
  } finally {
    elBtnShot.disabled = false;
  }
}

// ── Open Ticket ────────────────────────────────────────────────────────────

async function openTicket() {
  elBtnTicket.disabled = true;
  try {
    await window.bracerChat.sendMessage(activeRoomId, '!ticket');
  } catch (err) {
    showStatus('Failed to open ticket: ' + err.message);
  } finally {
    elBtnTicket.disabled = false;
    elMsgInput.focus();
  }
}

// ── Status bar ─────────────────────────────────────────────────────────────

let statusTimer = null;

function showStatus(msg, autoDismissMs = 5000) {
  elStatusBar.textContent = msg;
  elStatusBar.classList.add('visible');
  if (statusTimer) clearTimeout(statusTimer);
  if (autoDismissMs > 0) statusTimer = setTimeout(hideStatus, autoDismissMs);
}

function hideStatus() {
  elStatusBar.classList.remove('visible');
}

// ── Auto-resize textarea ───────────────────────────────────────────────────

function autoResizeTextarea() {
  elMsgInput.style.height = 'auto';
  elMsgInput.style.height = Math.min(elMsgInput.scrollHeight, 120) + 'px';
}

// ── Context menu ───────────────────────────────────────────────────────────

function hideCtxMenu() {
  elCtxMenu.classList.remove('visible');
  ctxTargetEventId = null;
}

elMessages.addEventListener('contextmenu', (e) => {
  const bubble = e.target.closest('.message');
  if (!bubble || !bubble._matrixEvent) return;

  e.preventDefault();
  ctxTargetEventId = bubble._matrixEvent.event_id;

  const pinned = isPinned(ctxTargetEventId);
  elCtxPin.textContent = pinned ? '📌 Unpin message' : '📌 Pin message';

  // Position near cursor, keep within viewport
  const menuW = 160, menuH = 40;
  let x = e.clientX, y = e.clientY;
  if (x + menuW > window.innerWidth)  x = window.innerWidth  - menuW - 4;
  if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 4;

  elCtxMenu.style.left = x + 'px';
  elCtxMenu.style.top  = y + 'px';
  elCtxMenu.classList.add('visible');
});

elCtxPin.addEventListener('click', () => {
  if (!ctxTargetEventId) return;
  if (isPinned(ctxTargetEventId)) {
    unpinMessage(ctxTargetEventId);
  } else {
    // Find the event from a rendered bubble
    const bubble = document.querySelector(`[data-event-id="${ctxTargetEventId}"]`);
    if (bubble && bubble._matrixEvent) pinMessage(bubble._matrixEvent);
  }
  hideCtxMenu();
});

document.addEventListener('click',    hideCtxMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });

// ── Pinned panel collapse/expand ───────────────────────────────────────────

elPinnedHeader.addEventListener('click', () => {
  elPinnedPanel.classList.toggle('collapsed');
});

// ── Event listeners ────────────────────────────────────────────────────────

elBtnSend.addEventListener('click', sendMessage);

elMsgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

elMsgInput.addEventListener('input', autoResizeTextarea);

elBtnAttach.addEventListener('click', attachFile);

elBtnShot.addEventListener('click', sendScreenshot);

elBtnTicket.addEventListener('click', openTicket);

// ── Drag-and-drop ──────────────────────────────────────────────────────────

let dragDepth = 0;

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (++dragDepth === 1) elDragOverlay.classList.add('active');
});

document.addEventListener('dragleave', () => {
  if (--dragDepth === 0) elDragOverlay.classList.remove('active');
});

document.addEventListener('dragover', (e) => e.preventDefault());

document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  elDragOverlay.classList.remove('active');
  const file = e.dataTransfer && e.dataTransfer.files[0];
  if (!file) return;
  // Read dropped file as ArrayBuffer and upload
  const reader = new FileReader();
  reader.onload = async () => {
    await sendFileByPath({
      data    : reader.result,
      name    : file.name,
      mimeType: file.type || 'application/octet-stream'
    });
  };
  reader.readAsArrayBuffer(file);
});

// ── Boot ───────────────────────────────────────────────────────────────────
init();
