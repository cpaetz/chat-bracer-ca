'use strict';

/**
 * app.js — Bracer Chat renderer process.
 * Communicates with main process exclusively via window.bracerChat (context bridge).
 * No Node.js or Electron APIs used directly.
 */

// ── Constants ──────────────────────────────────────────────────────────────
const RETENTION_MS    = 24 * 60 * 60 * 1000;
const PINNED_STORAGE_KEY = 'bracerChat_pinnedMessages';

// ── State ──────────────────────────────────────────────────────────────────
let sessionInfo  = null;
let activeRoomId = null;
let ctxTargetEventId = null; // event_id of the message the context menu opened on
const renderedBroadcastIds = new Set(); // dedup broadcast events

// ── DOM refs ───────────────────────────────────────────────────────────────
const elRoomName    = document.getElementById('room-name');
const elConnStatus  = document.getElementById('connection-status');
const elMessages    = document.getElementById('messages');
const elMsgInput    = document.getElementById('msg-input');
const elBtnSend     = document.getElementById('btn-send');
const elBtnAttach   = document.getElementById('btn-attach');
const elBtnShot     = document.getElementById('btn-screenshot');
const elScreenPicker       = document.getElementById('screen-picker');
const elScreenPickerMap    = document.getElementById('screen-picker-map');
const elScreenPickerCancel = document.getElementById('screen-picker-cancel');
const elBtnTicket   = document.getElementById('btn-ticket');
const elStatusBar   = document.getElementById('status-bar');
const elDragOverlay = document.querySelector('.drag-overlay');
const elPinnedPanel = document.getElementById('pinned-panel');
const elPinnedHeader= document.getElementById('pinned-header');
const elPinnedList  = document.getElementById('pinned-list');
const elPinnedCount = document.getElementById('pinned-count');
const elCtxMenu     = document.getElementById('ctx-menu');
const elCtxPin      = document.getElementById('ctx-pin');
const elSearchInput = document.getElementById('search-input');
const elSearchClear = document.getElementById('search-clear');
const elBtnEmoji         = document.getElementById('btn-emoji');
const elEmojiPicker      = document.getElementById('emoji-picker');
const elEmojiGrid        = document.getElementById('emoji-grid');
const elEmojiRecentGrid  = document.getElementById('emoji-recent-grid');
const elEmojiRecentSec   = document.getElementById('emoji-recent-section');

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

// ── Linkify ────────────────────────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s<>"']+/g;

/**
 * Populates `el` with text and clickable links parsed from `text`.
 * Safe: builds DOM nodes directly — no innerHTML.
 */
function linkify(el, text) {
  let last = 0;
  let match;
  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    // Text before the URL
    if (match.index > last) {
      el.appendChild(document.createTextNode(text.slice(last, match.index)));
    }
    // The URL itself
    const url = match[0];
    const a   = document.createElement('a');
    a.textContent = url;
    a.href        = '#';
    a.className   = 'msg-link';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.bracerChat.openExternal(url);
    });
    el.appendChild(a);
    last = match.index + url.length;
  }
  // Remaining text after last URL
  if (last < text.length) {
    el.appendChild(document.createTextNode(text.slice(last)));
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Yield to the browser event loop so it can process pending tasks. */
function yieldToEventLoop() {
  return new Promise(r => setTimeout(r, 0));
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  try {
    sessionInfo  = await window.bracerChat.getSessionInfo();
    activeRoomId = sessionInfo.machineRoomId;

    elRoomName.textContent   = `Support — ${sessionInfo.hostname}`;
    elConnStatus.textContent = 'Loading history…';
    console.log('[app] sessionInfo:', JSON.stringify(sessionInfo));

    renderPinnedPanel();
    await loadHistory();

    elConnStatus.textContent = 'Connected';

    // Start listening for new messages delivered by the sync loop
    window.bracerChat.onNewMessage(handleIncomingMessage);

    // When window is shown due to an incoming message: expand pinned panel
    // and scroll to the triggering message
    window.bracerChat.onFocusMessage(({ eventId }) => {
      // Expand pinned panel if there are any pins
      const pins = loadPinned();
      if (pins.length > 0) {
        elPinnedPanel.classList.remove('collapsed');
      }
      // Scroll to the new message bubble (may not be rendered yet — retry briefly)
      const scrollToEvent = (id, attempts = 0) => {
        const bubble = document.querySelector(`[data-event-id="${id}"]`);
        if (bubble) {
          bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
        } else if (attempts < 10) {
          setTimeout(() => scrollToEvent(id, attempts + 1), 150);
        }
      };
      scrollToEvent(eventId);
    });

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
function renderMessage(event, prepend = false) {
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

  let imgElForCopy = null; // set in m.image case so copy button can grab the loaded image

  switch (content.msgtype) {
    case 'm.text': {
      linkify(bodyEl, content.body || '');
      break;
    }

    case 'm.image': {
      if (content.url) {
        const img = document.createElement('img');
        img.alt   = content.body || 'image';
        img.style.cursor = 'pointer';
        img.addEventListener('click', () => {
          window.bracerChat.openImageInApp(content.url, content.body || 'image.png');
        });
        bodyEl.appendChild(img);
        imgElForCopy = img; // reference for copy button
        // Resolve URL async without blocking bubble render
        window.bracerChat.resolveMediaUrl(content.url).then(httpUrl => {
          if (httpUrl) {
            img.addEventListener('load', scrollToBottom);
            img.src = httpUrl;
          }
        });
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
        const fileName = content.body || 'file';
        link.addEventListener('click', async (e) => {
          e.preventDefault();
          link.textContent = 'Downloading…';
          try {
            await window.bracerChat.downloadFile(content.url, fileName);
          } catch (err) {
            showStatus('Download failed: ' + err.message);
          } finally {
            link.textContent = fileName;
          }
        });
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

  // Pin button (hover to reveal; always visible when pinned)
  const pinBtn = makePinBtn(event);
  if (pinBtn) wrap.appendChild(pinBtn);

  // Copy button
  wrap.appendChild(makeCopyBtn(event, undefined, imgElForCopy));

  // Store event data on the element for context menu and ordering
  wrap._matrixEvent = event;

  if (prepend) {
    elMessages.insertBefore(wrap, elMessages.firstChild);
  } else {
    // Insert in chronological order by timestamp rather than always appending.
    // This keeps optimistic renders and sync-delivered messages in the right order.
    const ts = event.origin_server_ts || 0;
    let insertBefore = null;
    const bubbles = elMessages.children;
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const sibTs = bubbles[i]._matrixEvent && bubbles[i]._matrixEvent.origin_server_ts || 0;
      if (sibTs <= ts) {
        insertBefore = bubbles[i].nextSibling;
        break;
      }
      insertBefore = bubbles[i];
    }
    elMessages.insertBefore(wrap, insertBefore);
  }
}

async function loadHistory() {
  elMessages.innerHTML = '';
  const cutoff    = Date.now() - RETENTION_MS;
  const pinnedIds = new Set(loadPinned().map(p => p.event_id));

  // Load machine room messages
  const machineEvents = await window.bracerChat.getRoomHistory(activeRoomId);
  let renderCount = 0;
  for (const event of machineEvents) {
    if (POLL_START_TYPES.includes(event.type)) {
      renderPoll(event);
      if (++renderCount % 20 === 0) await yieldToEventLoop();
      continue;
    }
    if (event.type !== 'm.room.message') continue;
    const isImage = event.content && event.content.msgtype === 'm.image';
    const isFile  = event.content && event.content.msgtype === 'm.file';
    URL_REGEX.lastIndex = 0;
    const hasLink = event.content && event.content.body && URL_REGEX.test(event.content.body);
    if (event.origin_server_ts >= cutoff || pinnedIds.has(event.event_id) || isImage || isFile || hasLink) {
      renderMessage(event);
      if (++renderCount % 20 === 0) await yieldToEventLoop();
    }
  }

  // Load broadcast room history and render as broadcast announcements
  if (sessionInfo && sessionInfo.broadcastRoomId) {
    try {
      const bcastEvents = await window.bracerChat.getRoomHistory(sessionInfo.broadcastRoomId);
      renderCount = 0;
      for (const event of bcastEvents) {
        if (event.origin_server_ts < cutoff) continue;
        if (event.type === 'm.room.message' || event.type === 'm.room.encrypted') {
          renderBroadcast(event, 'Bracer Systems Broadcast');
          if (++renderCount % 20 === 0) await yieldToEventLoop();
        }
      }
    } catch (err) {
      console.warn('[app] Could not load broadcast history:', err.message);
    }
  }
  if (sessionInfo && sessionInfo.companyRoomId) {
    try {
      const coEvents = await window.bracerChat.getRoomHistory(sessionInfo.companyRoomId);
      renderCount = 0;
      for (const event of coEvents) {
        if (event.origin_server_ts < cutoff) continue;
        if (event.type === 'm.room.message' || event.type === 'm.room.encrypted') {
          renderBroadcast(event, `${sessionInfo.companyName} Broadcast`);
          if (++renderCount % 20 === 0) await yieldToEventLoop();
        }
      }
    } catch (err) {
      console.warn('[app] Could not load company broadcast history:', err.message);
    }
  }

  scrollToBottom();
}

function scrollToBottom() {
  elMessages.scrollTop = elMessages.scrollHeight;
}

// ── Notification sound ─────────────────────────────────────────────────────

let audioCtx = null;

function playNotificationSound() {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    // AudioContext may be suspended until a user gesture has occurred
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.type            = 'sine';
    osc.frequency.value = 880; // A5 — soft, high ding

    const t = audioCtx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.01); // quick attack
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4); // decay

    osc.start(t);
    osc.stop(t + 0.4);
  } catch (err) {
    // Audio not available — fail silently
  }
}

// ── Incoming messages (from sync loop) ────────────────────────────────────

// ── Poll rendering ─────────────────────────────────────────────────────────

const POLL_START_TYPES = ['m.poll.start', 'org.matrix.msc3381.poll.start'];

// Extract text from any of the various Matrix poll text formats
function _pollText(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  // Stable array format: { "m.text": [{ "body": "..." }] }
  const mt = obj['m.text'];
  if (Array.isArray(mt))        return mt[0]?.body || mt[0] || '';
  if (typeof mt === 'string')   return mt;
  // Unstable text field
  const ut = obj['org.matrix.msc3381.text'];
  if (ut) return typeof ut === 'string' ? ut : (ut[0]?.body || '');
  // Plain body fallback
  return obj.body || '';
}

function parsePollContent(event) {
  const c = event.content || {};

  // Stable: m.poll (Matrix 1.6+, Element Web 1.11+)
  if (c['m.poll']) {
    const p = c['m.poll'];
    const question = _pollText(p.question);
    const answers  = (p.answers || []).map(a => ({
      id  : a.id || '',
      text: _pollText(a)
    })).filter(a => a.text);
    return { question, answers };
  }

  // Unstable: org.matrix.msc3381.poll.start
  // Element Web sends answers with text in 'org.matrix.msc1767.text' (MSC1767 extensible events)
  const u = c['org.matrix.msc3381.poll.start'];
  if (u) {
    const question = _pollText(u.question);
    const answers  = (u.answers || []).map(a => ({
      id  : a.id || '',
      text: a['org.matrix.msc1767.text'] || _pollText(a['org.matrix.msc3381.poll.answer']) || _pollText(a)
    })).filter(a => a.text);
    return { question, answers };
  }

  return null;
}

function renderPoll(event, prepend = false) {
  if (!event || !event.content) return;
  const poll = parsePollContent(event);
  if (!poll) return;

  const isOwn = sessionInfo && event.sender === sessionInfo.userId;

  const wrap = document.createElement('div');
  wrap.className       = `message poll-message ${isOwn ? 'own' : 'other'}`;
  wrap.dataset.eventId = event.event_id || '';
  wrap._matrixEvent    = event;

  if (event.event_id && isPinned(event.event_id)) wrap.classList.add('pinned-highlight');

  const senderEl = document.createElement('div');
  senderEl.className   = 'sender';
  senderEl.textContent = senderLabel(event.sender);
  wrap.appendChild(senderEl);

  const card = document.createElement('div');
  card.className = 'poll-card';

  const headerEl = document.createElement('div');
  headerEl.className   = 'poll-header';
  headerEl.textContent = '📊 Poll';
  card.appendChild(headerEl);

  const questionEl = document.createElement('div');
  questionEl.className   = 'poll-question';
  questionEl.textContent = poll.question;
  card.appendChild(questionEl);

  const optionsEl = document.createElement('ul');
  optionsEl.className = 'poll-options';
  poll.answers.forEach(({ id, text }) => {
    const li = document.createElement('li');
    li.textContent       = text;
    li.dataset.answerId  = id;
    li.title             = 'Click to vote';
    li.addEventListener('click', async () => {
      if (li.classList.contains('poll-voted')) return; // already voted
      try {
        await window.bracerChat.sendPollResponse(activeRoomId, event.event_id, id);
        // Visually mark the selected option
        optionsEl.querySelectorAll('li').forEach(el => el.classList.remove('poll-selected'));
        li.classList.add('poll-selected', 'poll-voted');
      } catch (err) {
        console.error('[Poll] Vote failed:', err);
      }
    });
    optionsEl.appendChild(li);
  });
  card.appendChild(optionsEl);

  wrap.appendChild(card);

  const timeEl = document.createElement('div');
  timeEl.className   = 'time';
  timeEl.textContent = formatTime(event.origin_server_ts);
  wrap.appendChild(timeEl);

  const pinBtn = makePinBtn(event);
  if (pinBtn) wrap.appendChild(pinBtn);

  const copyText = poll.question + '\n' + poll.answers.map((a, i) => `${i + 1}. ${a.text}`).join('\n');
  wrap.appendChild(makeCopyBtn(event, copyText));

  if (prepend) {
    elMessages.insertBefore(wrap, elMessages.firstChild);
  } else {
    const ts = event.origin_server_ts || 0;
    let insertBefore = null;
    const bubbles = elMessages.children;
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const sibTs = bubbles[i]._matrixEvent?.origin_server_ts || 0;
      if (sibTs <= ts) { insertBefore = bubbles[i].nextSibling; break; }
      insertBefore = bubbles[i];
    }
    elMessages.insertBefore(wrap, insertBefore);
  }
}

async function handleIncomingMessage({ roomId, event }) {
  if (event.event_id && document.querySelector(`[data-event-id="${event.event_id}"]`)) return;

  // Broadcast rooms — render as announcement above the chat
  if (sessionInfo && roomId === sessionInfo.broadcastRoomId) {
    playNotificationSound();
    renderBroadcast(event, 'Bracer Systems Broadcast');
    scrollToBottom();
    return;
  }
  if (sessionInfo && roomId === sessionInfo.companyRoomId) {
    playNotificationSound();
    renderBroadcast(event, `${sessionInfo.companyName} Broadcast`);
    scrollToBottom();
    return;
  }

  if (roomId !== activeRoomId) return;

  const isOwn = sessionInfo && event.sender === sessionInfo.userId;
  if (!isOwn) playNotificationSound();

  if (POLL_START_TYPES.includes(event.type)) {
    renderPoll(event);
  } else {
    renderMessage(event);
  }
  applySearch();
  scrollToBottom();
}

function makePinBtn(event) {
  if (!event.event_id) return null;
  const btn = document.createElement('button');
  btn.className = 'pin-btn';

  function updateState() {
    const pinned = isPinned(event.event_id);
    btn.textContent = '📌';
    btn.title       = pinned ? 'Unpin message' : 'Pin message';
    btn.classList.toggle('pinned', pinned);
  }
  updateState();

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isPinned(event.event_id)) {
      unpinMessage(event.event_id);
    } else {
      pinMessage(event);
    }
    updateState();
  });

  return btn;
}

function makeCopyBtn(event, textOverride, imgEl) {
  const btn = document.createElement('button');
  btn.className   = 'copy-btn';
  btn.textContent = 'Copy';
  btn.title       = imgEl ? 'Copy image to clipboard' : 'Copy message text';

  btn.addEventListener('click', (e) => {
    e.stopPropagation();

    if (imgEl && imgEl.src && imgEl.src.startsWith('data:')) {
      // Copy full-res image via Electron native clipboard
      window.bracerChat.clipboardWriteImage(imgEl.src).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
      }).catch(() => {});
      return;
    }

    // Copy text via execCommand
    const body = textOverride !== undefined ? textOverride
      : (event.content && event.content.body ? event.content.body : '');
    const ts   = event.origin_server_ts ? `[${formatTime(event.origin_server_ts)}] ` : '';
    const text = ts + body;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
  });
  return btn;
}

function renderBroadcast(event, label) {
  if (!event.content) return;
  // Deduplicate — same event can arrive via both history load and live sync
  const dedupKey = event.event_id || `${event.origin_server_ts}_${event.sender}`;
  if (renderedBroadcastIds.has(dedupKey)) return;
  renderedBroadcastIds.add(dedupKey);

  const wrap = document.createElement('div');
  wrap.className       = 'broadcast-message';
  wrap.dataset.eventId = event.event_id || '';
  wrap._matrixEvent    = event;

  const labelEl = document.createElement('div');
  labelEl.className   = 'broadcast-label';
  labelEl.textContent = label + ':';

  const box = document.createElement('div');
  box.className = 'broadcast-box';

  const bodyEl = document.createElement('div');
  bodyEl.className = 'broadcast-body';
  const bodyText = event.type === 'm.room.message'
    ? (event.content.body || '')
    : '[Encrypted broadcast — message cannot be displayed. Ask your admin to disable encryption on this room.]';
  linkify(bodyEl, bodyText);

  const timeEl = document.createElement('div');
  timeEl.className   = 'time';
  timeEl.textContent = formatTime(event.origin_server_ts);

  box.appendChild(bodyEl);
  box.appendChild(timeEl);
  const broadcastPinBtn = makePinBtn(event);
  if (broadcastPinBtn) box.appendChild(broadcastPinBtn);
  box.appendChild(makeCopyBtn(event, bodyText));
  wrap.appendChild(labelEl);
  wrap.appendChild(box);
  elMessages.appendChild(wrap);
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

    // Optimistic render — show own message immediately without waiting for sync
    const localEventId = `local-${Date.now()}`;
    renderMessage({
      type             : 'm.room.message',
      sender           : sessionInfo.userId,
      event_id         : localEventId,
      content          : { msgtype: 'm.text', body: text },
      origin_server_ts : Date.now()
    });
    scrollToBottom();

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

async function sendFileByPath({ name, mimeType, data }) {
  const MAX = 100 * 1024 * 1024;
  if (data.byteLength > MAX) {
    showStatus(`File too large: ${(data.byteLength / 1024 / 1024).toFixed(1)} MB (max 100 MB)`);
    return;
  }
  showStatus(`Uploading ${name}…`);
  try {
    const { mxcUri, fileName, mimeType: resolvedMime } =
      await window.bracerChat.sendFile(activeRoomId, data, name, mimeType);
    hideStatus();

    // Optimistic render — show file/image immediately without waiting for sync
    const isImage   = resolvedMime && resolvedMime.startsWith('image/');
    const msgtype   = isImage ? 'm.image' : 'm.file';
    renderMessage({
      type             : 'm.room.message',
      sender           : sessionInfo.userId,
      event_id         : `local-${Date.now()}`,
      content          : { msgtype, body: fileName, url: mxcUri },
      origin_server_ts : Date.now()
    });
    scrollToBottom();
  } catch (err) {
    showStatus('Upload failed: ' + err.message);
  }
}

// ── Screen picker ──────────────────────────────────────────────────────────

function hideScreenPicker() {
  elScreenPicker.classList.remove('visible');
}

// Renders the screen picker with displays laid out proportionally to match
// their physical arrangement in Windows display settings.
// Each display element stores its sourceId as ._sourceId so thumbnails can
// be patched in later without rebuilding the whole picker.
function showScreenPicker(screens, onSelect) {
  elScreenPickerMap.innerHTML = '';

  // Compute bounding box of all displays in virtual screen coordinates.
  const minX = Math.min(...screens.map(s => s.bounds.x));
  const minY = Math.min(...screens.map(s => s.bounds.y));
  const maxX = Math.max(...screens.map(s => s.bounds.x + s.bounds.width));
  const maxY = Math.max(...screens.map(s => s.bounds.y + s.bounds.height));

  const virtualW = maxX - minX;
  const virtualH = maxY - minY;

  // Scale to fit within the 266px wide map area (290px picker − 24px padding).
  const mapW    = 266;
  const scale   = mapW / virtualW;
  const mapH    = Math.round(virtualH * scale);

  elScreenPickerMap.style.height = mapH + 'px';

  screens.forEach((s, i) => {
    const el = document.createElement('div');
    el.className    = 'screen-picker-display';
    el._sourceId    = s.id;   // updated later when thumbnails arrive
    el.dataset.idx  = i;

    // Position and size proportionally.
    el.style.left   = Math.round((s.bounds.x - minX) * scale) + 'px';
    el.style.top    = Math.round((s.bounds.y - minY) * scale) + 'px';
    el.style.width  = Math.round(s.bounds.width  * scale) + 'px';
    el.style.height = Math.round(s.bounds.height * scale) + 'px';

    // Thumbnail preview (may be null on first render — patched in async).
    if (s.thumbnail) {
      const img = document.createElement('img');
      img.src = s.thumbnail;
      img.alt = s.label;
      el.appendChild(img);
    }

    // Label bar.
    const label = document.createElement('div');
    label.className   = 'screen-picker-label';
    label.textContent = s.label;
    el.appendChild(label);

    // Click handler reads ._sourceId at click time so async updates work.
    el.addEventListener('click', () => {
      hideScreenPicker();
      onSelect(el._sourceId);
    });

    elScreenPickerMap.appendChild(el);
  });

  elScreenPicker.classList.add('visible');
}

// Patches thumbnails and sourceIds into an already-visible picker.
function updateScreenPickerThumbnails(screens) {
  const els = elScreenPickerMap.querySelectorAll('.screen-picker-display');
  screens.forEach((s, i) => {
    const el = els[i];
    if (!el) return;
    el._sourceId = s.id; // update sourceId for click handler
    if (s.thumbnail) {
      let img = el.querySelector('img');
      if (!img) {
        img = document.createElement('img');
        img.alt = s.label;
        el.insertBefore(img, el.querySelector('.screen-picker-label'));
      }
      img.src = s.thumbnail;
    }
  });
}

// ── Send screenshot ────────────────────────────────────────────────────────

async function captureAndSend(sourceId) {
  elBtnShot.disabled = true;
  showStatus('Capturing screenshot…');
  try {
    const { mxcUri, fileName } = await window.bracerChat.sendScreenshot(activeRoomId, sourceId);
    hideStatus();
    // Optimistic render — show screenshot immediately without waiting for sync
    renderMessage({
      type             : 'm.room.message',
      sender           : sessionInfo.userId,
      event_id         : `local-${Date.now()}`,
      content          : { msgtype: 'm.image', body: fileName, url: mxcUri },
      origin_server_ts : Date.now()
    });
    scrollToBottom();
  } catch (err) {
    showStatus('Screenshot failed: ' + err.message, 0); // persistent
    console.error('[app] Screenshot error:', err);
  } finally {
    elBtnShot.disabled = false;
  }
}

async function sendScreenshot() {
  // Get layout instantly (no thumbnail capture) so the picker appears immediately.
  const layout = await window.bracerChat.getScreenLayout();

  if (layout.length <= 1) {
    // Single screen — skip picker, go straight to capture.
    await captureAndSend(null);
    return;
  }

  // Show picker right away with placeholder boxes (no thumbnails yet).
  showScreenPicker(layout, (sourceId) => captureAndSend(sourceId));

  // Give the user 200ms to cancel before starting thumbnail capture.
  // If cancelled in that window, skip the heavy getSources() call entirely
  // so the main process stays free and the app feels responsive.
  await new Promise(r => setTimeout(r, 200));
  if (!elScreenPicker.classList.contains('visible')) return;

  // Load thumbnails in the background and patch them in if picker is still open.
  window.bracerChat.getScreens().then(screens => {
    if (elScreenPicker.classList.contains('visible')) {
      updateScreenPickerThumbnails(screens);
    }
  }).catch(() => {});
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
  const bubble = e.target.closest('.message') || e.target.closest('.broadcast-message');
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

document.addEventListener('click', (e) => {
  hideCtxMenu();
  // Close screen picker if clicking outside it
  if (!elScreenPicker.contains(e.target) && e.target !== elBtnShot) {
    hideScreenPicker();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideCtxMenu();
    hideScreenPicker();
  }
});

elScreenPickerCancel.addEventListener('click', (e) => {
  e.stopPropagation();
  hideScreenPicker();
});

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

// Paste image from clipboard (e.g. Win+Shift+S snip, or copy image from browser)
elMsgInput.addEventListener('paste', (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const imageItem = items.find(i => i.type.startsWith('image/'));
  if (!imageItem) return; // no image — let normal text paste proceed
  e.preventDefault();
  const file = imageItem.getAsFile();
  if (!file) return;
  const ext  = file.type === 'image/png' ? 'png'
             : file.type === 'image/jpeg' ? 'jpg'
             : file.type === 'image/gif'  ? 'gif'
             : file.type === 'image/webp' ? 'webp'
             : 'png';
  const name = `paste-${Date.now()}.${ext}`;
  const reader = new FileReader();
  reader.onload = async () => {
    await sendFileByPath({ name, mimeType: file.type, data: reader.result });
  };
  reader.readAsDataURL(file);
});

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

// ── Emoji picker ───────────────────────────────────────────────────────────

const EMOJIS = [
  // Smileys
  '😀','😃','😄','😁','😆','😅','😂','🤣',
  '😊','😇','🙂','😉','😌','😍','🥰','😘',
  '😋','😛','😜','🤪','😎','🤩','🥳','😏',
  '😐','😑','😶','🙄','😯','😲','😴','🤔',
  '😭','😢','😤','😠','😡','🤬','😱','😨',
  '😰','😓','🤗','🤭','🤫','😷','🤒','🤕',
  // Gestures & people
  '👍','👎','👌','🤙','👋','🤝','🙏','💪',
  '👏','🤦','🤷','🙌','👀','💀','🎉','🔥',
  // Hearts & symbols
  '❤️','🧡','💛','💚','💙','💜','🖤','💔',
  '💯','✅','❌','⚠️','❓','❗','💡','🔗',
  // Work & misc
  '📎','📋','📁','📧','📞','🖥️','⌨️','🖱️',
  '🔒','🔓','🔑','⭐','🚀','🛑','✔️','➡️'
];

const RECENT_EMOJI_KEY = 'bracerChat_recentEmojis';
const MAX_RECENT       = 16;

function loadRecentEmojis() {
  try { return JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY) || '[]'); }
  catch { localStorage.removeItem(RECENT_EMOJI_KEY); return []; }
}

function saveRecentEmoji(emoji) {
  const recent = [emoji, ...loadRecentEmojis().filter(e => e !== emoji)].slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(recent));
}

function renderRecentEmojis() {
  const recent = loadRecentEmojis();
  elEmojiRecentSec.style.display = recent.length ? '' : 'none';
  elEmojiRecentGrid.innerHTML = '';
  for (const emoji of recent) {
    const btn = makeEmojiBtn(emoji);
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      insertAtCursor(elMsgInput, emoji);
      saveRecentEmoji(emoji);
      renderRecentEmojis();
      closeEmojiPicker();
      document.removeEventListener('click', onOutsideClick);
      elMsgInput.focus();
      autoResizeTextarea();
    });
    elEmojiRecentGrid.appendChild(btn);
  }
}

function insertAtCursor(el, text) {
  const start = el.selectionStart ?? el.value.length;
  const end   = el.selectionEnd   ?? el.value.length;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const pos = start + text.length;
  el.setSelectionRange(pos, pos);
}

function closeEmojiPicker() {
  elEmojiPicker.classList.remove('visible');
}

function openEmojiPicker() {
  renderRecentEmojis();
  elEmojiPicker.classList.add('visible');
  // Delay outside-click listener by one tick so the opening click doesn't trigger it
  setTimeout(() => {
    document.addEventListener('click', onOutsideClick);
  }, 0);
}

function onOutsideClick(e) {
  if (!elEmojiPicker.contains(e.target) && e.target !== elBtnEmoji) {
    closeEmojiPicker();
    document.removeEventListener('click', onOutsideClick);
  }
}

/**
 * Convert a Unicode emoji to its Twemoji CDN SVG URL.
 * Strips variation selector U+FE0F; preserves ZWJ (U+200D) for compound emojis.
 */
function emojiToTwemojiUrl(emoji) {
  const cps = [];
  for (const char of emoji) {
    const cp = char.codePointAt(0);
    if (cp === 0xFE0F) continue; // variation selector — excluded from filename
    cps.push(cp.toString(16));
  }
  const code = cps.join('-');
  return `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/${code}.svg`;
}

function makeEmojiBtn(emoji) {
  const btn = document.createElement('button');
  btn.textContent = emoji;
  btn.title       = emoji;
  return btn;
}

// Build the grid once
for (const emoji of EMOJIS) {
  const btn = makeEmojiBtn(emoji);
  // Use mousedown + preventDefault so the textarea doesn't lose focus/cursor position
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    insertAtCursor(elMsgInput, emoji);
    saveRecentEmoji(emoji);
    closeEmojiPicker();
    document.removeEventListener('click', onOutsideClick);
    elMsgInput.focus();
    autoResizeTextarea();
  });
  elEmojiGrid.appendChild(btn);
}

elBtnEmoji.addEventListener('click', (e) => {
  e.stopPropagation();
  if (elEmojiPicker.classList.contains('visible')) {
    closeEmojiPicker();
    document.removeEventListener('click', onOutsideClick);
  } else {
    openEmojiPicker();
  }
});

// ── Search ─────────────────────────────────────────────────────────────────

const elSearchCount = document.getElementById('search-count');
const elSearchNav   = document.getElementById('search-nav');
const elSearchPrev  = document.getElementById('search-prev');
const elSearchNext  = document.getElementById('search-next');

let searchMarks = [];
let searchIdx   = -1;

/** Remove all <mark> elements created by the last search, restoring original text nodes. */
function clearSearchMarks() {
  for (const mark of searchMarks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  }
  searchMarks = [];
  searchIdx   = -1;
}

/** Walk a DOM subtree and wrap every occurrence of `query` (lowercase) in a <mark>. */
function walkAndMark(node, query) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text  = node.textContent;
    const lower = text.toLowerCase();
    let pos = 0, idx;
    const frag  = document.createDocumentFragment();
    let   found = false;

    while ((idx = lower.indexOf(query, pos)) !== -1) {
      found = true;
      if (idx > pos) frag.appendChild(document.createTextNode(text.slice(pos, idx)));
      const mark = document.createElement('mark');
      mark.className   = 'search-highlight';
      mark.textContent = text.slice(idx, idx + query.length);
      frag.appendChild(mark);
      searchMarks.push(mark);
      pos = idx + query.length;
    }
    if (found) {
      if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
      node.parentNode.replaceChild(frag, node);
    }
    return;
  }
  if (node.nodeName === 'SCRIPT' || node.nodeName === 'STYLE' || node.nodeName === 'MARK') return;
  for (const child of Array.from(node.childNodes)) walkAndMark(child, query);
}

/** Highlight the match at `idx` and scroll it into view. */
function activateMatch(idx) {
  for (const m of searchMarks) m.classList.remove('active');
  if (idx < 0 || idx >= searchMarks.length) return;
  searchMarks[idx].classList.add('active');
  searchMarks[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
  elSearchCount.textContent = `${idx + 1} / ${searchMarks.length}`;
}

function applySearch() {
  const query = elSearchInput.value.trim();
  clearSearchMarks();
  elSearchClear.classList.toggle('visible', query.length > 0);

  if (!query) {
    elSearchCount.textContent = '';
    elSearchNav.classList.remove('visible');
    return;
  }

  const lowerQuery = query.toLowerCase();
  const bodies = elMessages.querySelectorAll('.body, .broadcast-body');
  for (const body of bodies) walkAndMark(body, lowerQuery);

  if (searchMarks.length === 0) {
    elSearchCount.textContent = 'No results';
    elSearchNav.classList.remove('visible');
    return;
  }

  elSearchNav.classList.add('visible');
  searchIdx = 0;
  activateMatch(0);
}

elSearchInput.addEventListener('input', applySearch);

elSearchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (searchMarks.length === 0) return;
    if (e.shiftKey) {
      searchIdx = (searchIdx - 1 + searchMarks.length) % searchMarks.length;
    } else {
      searchIdx = (searchIdx + 1) % searchMarks.length;
    }
    activateMatch(searchIdx);
  } else if (e.key === 'Escape') {
    elSearchInput.value = '';
    applySearch();
  }
});

elSearchPrev.addEventListener('click', () => {
  if (searchMarks.length === 0) return;
  searchIdx = (searchIdx - 1 + searchMarks.length) % searchMarks.length;
  activateMatch(searchIdx);
});

elSearchNext.addEventListener('click', () => {
  if (searchMarks.length === 0) return;
  searchIdx = (searchIdx + 1) % searchMarks.length;
  activateMatch(searchIdx);
});

elSearchClear.addEventListener('click', () => {
  elSearchInput.value = '';
  applySearch();
  elSearchInput.focus();
});

// ── Export chat ────────────────────────────────────────────────────────────

const elBtnExport = document.getElementById('btn-export');

async function exportChat() {
  elBtnExport.disabled = true;
  elBtnExport.textContent = 'Exporting…';
  try {
    const bubbles = elMessages.querySelectorAll('.message, .broadcast-message');
    const rows = [];
    for (const b of bubbles) {
      if (b.classList.contains('search-hidden')) continue;
      const ev      = b._matrixEvent;
      const sender  = ev ? senderLabel(ev.sender) : '';
      const time    = ev ? formatTime(ev.origin_server_ts) : '';
      const bodyEl  = b.querySelector('.body, .broadcast-body');
      const bodyTxt = bodyEl ? bodyEl.innerText : '';
      const isBcast = b.classList.contains('broadcast-message');
      const labelEl = b.querySelector('.broadcast-label');
      const label   = labelEl ? labelEl.textContent : '';
      rows.push({ sender, time, body: bodyTxt, isBcast, label });
    }

    const hostname = sessionInfo ? sessionInfo.hostname : 'Unknown';
    const exported = new Date().toLocaleString();

    const rowsHtml = rows.map(r => {
      if (r.isBcast) {
        return `<tr class="bcast"><td colspan="3"><strong>${escHtml(r.label)}</strong> ${escHtml(r.body)}</td><td>${escHtml(r.time)}</td></tr>`;
      }
      return `<tr><td>${escHtml(r.sender)}</td><td>${escHtml(r.body)}</td><td>${escHtml(r.time)}</td></tr>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Bracer Chat Export — ${escHtml(hostname)}</title>
<style>
  body { font-family: Segoe UI, Arial, sans-serif; font-size: 13px; color: #212121; margin: 24px; }
  h1 { font-size: 16px; color: #E65100; }
  p.meta { color: #757575; font-size: 12px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; }
  th { background: #E65100; color: #fff; padding: 6px 10px; text-align: left; font-size: 12px; }
  td { padding: 5px 10px; vertical-align: top; border-bottom: 1px solid #eee; }
  tr:nth-child(even) td { background: #FFF8F5; }
  tr.bcast td { background: #FFF5F5; color: #C62828; font-size: 12px; }
  td:last-child { white-space: nowrap; color: #757575; font-size: 11px; }
</style></head><body>
<h1>Bracer Chat Export</h1>
<p class="meta">Device: ${escHtml(hostname)} &nbsp;|&nbsp; Exported: ${escHtml(exported)}</p>
<table>
<thead><tr><th>From</th><th>Message</th><th>Time</th></tr></thead>
<tbody>
${rowsHtml}
</tbody></table>
</body></html>`;

    const defaultName = `bracer-chat-${hostname}-${new Date().toISOString().slice(0,10)}.html`;
    await window.bracerChat.saveTextFile({ content: html, defaultName });
  } catch (err) {
    showStatus('Export failed: ' + err.message);
  } finally {
    elBtnExport.disabled = false;
    elBtnExport.textContent = 'Export';
  }
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

elBtnExport.addEventListener('click', exportChat);

// ── Boot ───────────────────────────────────────────────────────────────────
init();
