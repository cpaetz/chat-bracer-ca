'use strict';

/**
 * app.js — Bracer Chat renderer process.
 * Communicates with main process exclusively via window.bracerChat (context bridge).
 * No Node.js or Electron APIs used directly.
 */

// ── State ──────────────────────────────────────────────────────────────────
let sessionInfo  = null;
let activeRoomId = null;

// ── DOM refs ───────────────────────────────────────────────────────────────
const elRoomName    = document.getElementById('room-name');
const elConnStatus  = document.getElementById('connection-status');
const elMessages    = document.getElementById('messages');
const elMsgInput    = document.getElementById('msg-input');
const elBtnSend     = document.getElementById('btn-send');
const elBtnAttach   = document.getElementById('btn-attach');
const elBtnShot     = document.getElementById('btn-screenshot');
const elFileInput   = document.getElementById('file-input');
const elStatusBar   = document.getElementById('status-bar');
const elDragOverlay = document.querySelector('.drag-overlay');

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  try {
    sessionInfo  = await window.bracerChat.getSessionInfo();
    activeRoomId = sessionInfo.machineRoomId;

    elRoomName.textContent   = `Support — ${sessionInfo.hostname}`;
    elConnStatus.textContent = 'Loading history…';

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
 * Async because image/file body elements may need to resolve mxc:// URLs.
 */
async function renderMessage(event, prepend = false) {
  if (!event || !event.content) return;

  const isOwn  = sessionInfo && event.sender === sessionInfo.userId;
  const content = event.content;

  const wrap = document.createElement('div');
  wrap.className       = `message ${isOwn ? 'own' : 'other'}`;
  wrap.dataset.eventId = event.event_id || '';

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
          // Click to open full-size in browser
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

  if (prepend) {
    elMessages.insertBefore(wrap, elMessages.firstChild);
  } else {
    elMessages.appendChild(wrap);
  }
}

async function loadHistory() {
  elMessages.innerHTML = '';
  const events = await window.bracerChat.getRoomHistory(activeRoomId);
  for (const event of events) {
    if (event.type === 'm.room.message') {
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
  // Only render messages for the currently viewed room
  if (roomId !== activeRoomId) return;

  // Deduplicate (sync may occasionally deliver an event twice)
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
    elMsgInput.value = text; // Restore on failure
  } finally {
    elBtnSend.disabled = false;
    elMsgInput.focus();
  }
}

// ── Send file ──────────────────────────────────────────────────────────────

async function sendFile(file) {
  const MAX = 100 * 1024 * 1024; // 100 MB
  if (file.size > MAX) {
    showStatus(`File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB (max 100 MB)`);
    return;
  }

  showStatus(`Uploading ${file.name}…`);
  elBtnAttach.disabled = true;

  try {
    const arrayBuffer = await file.arrayBuffer();
    const mimeType    = file.type || 'application/octet-stream';
    await window.bracerChat.sendFile(activeRoomId, arrayBuffer, file.name, mimeType);
    hideStatus();
  } catch (err) {
    showStatus('Upload failed: ' + err.message);
  } finally {
    elBtnAttach.disabled = false;
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
    showStatus('Screenshot failed: ' + err.message);
  } finally {
    elBtnShot.disabled = false;
  }
}

// ── Status bar ─────────────────────────────────────────────────────────────

let statusTimer = null;

function showStatus(msg, autoDismissMs = 0) {
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

// ── Event listeners ────────────────────────────────────────────────────────

elBtnSend.addEventListener('click', sendMessage);

elMsgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

elMsgInput.addEventListener('input', autoResizeTextarea);

elBtnAttach.addEventListener('click', () => elFileInput.click());

elFileInput.addEventListener('change', () => {
  const file = elFileInput.files[0];
  if (file) {
    sendFile(file);
    elFileInput.value = ''; // Reset so same file can be re-sent
  }
});

elBtnShot.addEventListener('click', sendScreenshot);

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
  if (file) sendFile(file);
});

// ── Boot ───────────────────────────────────────────────────────────────────
init();
