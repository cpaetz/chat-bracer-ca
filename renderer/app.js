'use strict';

/**
 * app.js — Bracer Chat renderer process.
 * Communicates with main process exclusively via window.bracerChat (context bridge).
 * No Node.js or Electron APIs used directly.
 *
 * Rocket.Chat message format:
 *   { _id, rid, msg, ts (ISO string), u: { _id, username, name }, attachments, tmid, ... }
 */

// ── Constants ──────────────────────────────────────────────────────────────
const RETENTION_MS    = 24 * 60 * 60 * 1000;
const PINNED_STORAGE_KEY = 'bracerChat_pinnedMessages';

// ── State ──────────────────────────────────────────────────────────────────
let sessionInfo  = null;
let activeRoomId = null;
let ctxTargetMsgId = null; // _id of the message the context menu opened on
const renderedBroadcastIds = new Set();

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
const elTypingInd   = document.getElementById('typing-indicator');
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
const elBtnPinWindow     = document.getElementById('btn-pin-window');
const elReplyBar         = document.getElementById('reply-bar');
const elReplyBarLabel    = document.getElementById('reply-bar-label');
const elReplyBarCancel   = document.getElementById('reply-bar-cancel');
const elBtnEmoji         = document.getElementById('btn-emoji');
const elEmojiPicker      = document.getElementById('emoji-picker');
const elEmojiGrid        = document.getElementById('emoji-grid');
const elEmojiRecentGrid  = document.getElementById('emoji-recent-grid');
const elEmojiRecentSec   = document.getElementById('emoji-recent-section');

// ── Reply state ────────────────────────────────────────────────────────────

let replyToMessage = null;

function setReply(message) {
  replyToMessage = message;
  const sender  = senderLabel(message);
  const body    = message.msg || (hasImage(message) ? '[image]' : '[attachment]');
  const preview = body.length > 80 ? body.slice(0, 80) + '...' : body;
  elReplyBarLabel.textContent = `${sender}: ${preview}`;
  elReplyBar.classList.add('visible');
  elMsgInput.focus();
}

function clearReply() {
  replyToMessage = null;
  elReplyBar.classList.remove('visible');
}

elReplyBarCancel.addEventListener('click', clearReply);

// ── Pinned messages (localStorage) ─────────────────────────────────────────

function loadPinned() {
  try {
    return JSON.parse(localStorage.getItem(PINNED_STORAGE_KEY) || '[]');
  } catch { return []; }
}

function savePinned(pins) {
  localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(pins));
}

function isPinned(msgId) {
  return loadPinned().some(p => p._id === msgId);
}

function pinMessageLocal(message) {
  const pins = loadPinned();
  if (pins.some(p => p._id === message._id)) return;
  pins.push({
    _id     : message._id,
    sender  : message.u?.username || '',
    body    : message.msg || '[attachment]',
    ts      : message.ts,
    pinnedAt: Date.now()
  });
  savePinned(pins);
  renderPinnedPanel();
  const bubble = findBubbleById(message._id);
  if (bubble) bubble.classList.add('pinned-highlight');
  // Push to RC server
  if (message._id) {
    window.bracerChat.pinMessage(message._id).catch(() => {});
  }
}

function unpinMessageLocal(msgId) {
  const pins = loadPinned().filter(p => p._id !== msgId);
  savePinned(pins);
  renderPinnedPanel();
  const bubble = findBubbleById(msgId);
  if (bubble) bubble.classList.remove('pinned-highlight');
  if (msgId) {
    window.bracerChat.unpinMessage(msgId).catch(() => {});
  }
}

function findBubbleById(msgId) {
  for (const el of elMessages.querySelectorAll('[data-msg-id]')) {
    if (el.dataset.msgId === msgId) return el;
  }
  return null;
}

/** Sync pinned messages from RC server into local storage. */
async function syncPinsFromServer(roomId) {
  try {
    const serverPins = await window.bracerChat.getPinnedEvents(roomId);
    if (!serverPins || !serverPins.length) return;
    const localPins = loadPinned();
    const localIds  = new Set(localPins.map(p => p._id));
    let changed = false;
    for (const msg of serverPins) {
      if (!localIds.has(msg._id)) {
        localPins.push({
          _id     : msg._id,
          sender  : msg.u?.username || '',
          body    : msg.msg || '[attachment]',
          ts      : msg.ts,
          pinnedAt: Date.now()
        });
        changed = true;
      }
    }
    // Remove local pins not on server
    const serverIds = new Set(serverPins.map(m => m._id));
    const merged = localPins.filter(p => serverIds.has(p._id));
    if (changed || merged.length !== localPins.length) {
      savePinned(merged);
      renderPinnedPanel();
    }
  } catch (err) {
    console.warn('[pins] syncPinsFromServer failed:', err.message);
  }
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
    sender.textContent = pin.sender;

    const body = document.createElement('span');
    body.className   = 'pin-body';
    body.textContent = pin.body.length > 80 ? pin.body.slice(0, 80) + '...' : pin.body;

    const removeBtn = document.createElement('button');
    removeBtn.className   = 'pin-remove';
    removeBtn.textContent = '\u00D7';
    removeBtn.title       = 'Unpin';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      unpinMessageLocal(pin._id);
    });

    item.appendChild(sender);
    item.appendChild(body);
    item.appendChild(removeBtn);

    item.addEventListener('click', async () => {
      let bubble = findBubbleById(pin._id);
      if (!bubble) {
        try {
          const msg = await window.bracerChat.getRoomEvent(activeRoomId, pin._id);
          if (msg) {
            renderMessage(msg);
            bubble = findBubbleById(pin._id);
          }
        } catch (_) {}
      }
      if (bubble) bubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    elPinnedList.appendChild(item);
  }
}

// ── Linkify ────────────────────────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s<>"']+/g;

function linkify(el, text) {
  let last = 0;
  let match;
  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    if (match.index > last) {
      el.appendChild(document.createTextNode(text.slice(last, match.index)));
    }
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
  if (last < text.length) {
    el.appendChild(document.createTextNode(text.slice(last)));
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function yieldToEventLoop() {
  return new Promise(r => setTimeout(r, 0));
}

/** Check if an RC message has a quote attachment (reply via web UI). */
function hasQuoteAttachment(message) {
  return message.attachments?.some(a => a.message_link);
}

/** Get the quote attachment from an RC message. */
function getQuoteAttachment(message) {
  return message.attachments?.find(a => a.message_link);
}

/**
 * Strip RC's invisible quote link from msg text.
 * RC prepends "[ ](https://chat.bracer.ca/...?msg=xxx) " to quoted messages.
 */
function stripQuoteLink(text) {
  return text.replace(/^\[\s*\]\([^)]+\)\s*/, '');
}

/** Check if an RC message has an image attachment (excludes quote attachments). */
function hasImage(message) {
  return message.attachments?.some(a => !a.message_link && (a.image_url || (a.image_type && a.image_type.startsWith('image/'))));
}

/** Check if an RC message has a file attachment (excludes quote attachments). */
function hasFile(message) {
  return message.file || message.attachments?.some(a => !a.message_link && a.title_link);
}

/** Get the file URL from an RC message's attachment. */
function getFileUrl(message) {
  if (message.attachments?.length > 0) {
    const att = message.attachments[0];
    return att.image_url || att.title_link || null;
  }
  return null;
}

/** Get the file name from an RC message. */
function getFileName(message) {
  if (message.file) return message.file.name || 'file';
  if (message.attachments?.length > 0) {
    return message.attachments[0].title || message.attachments[0].description || 'file';
  }
  return 'file';
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  try {
    const pinPrefs = await window.bracerChat.getPinState();
    applyPinButtonState(pinPrefs.pinned);

    sessionInfo  = await window.bracerChat.getSessionInfo();
    activeRoomId = sessionInfo.machineRoomId;

    elRoomName.textContent   = `Support \u2014 ${sessionInfo.hostname}`;
    elConnStatus.textContent = 'Loading history\u2026';
    console.log('[app] sessionInfo:', JSON.stringify(sessionInfo));

    await syncPinsFromServer(activeRoomId);

    renderPinnedPanel();
    await loadHistory();

    elConnStatus.textContent = 'Connected';

    window.bracerChat.onNewMessage(handleIncomingMessage);

    window.bracerChat.onMessageDeleted(({ roomId, messageId }) => {
      console.log('[app] message-deleted:', roomId, messageId);
      const el = document.querySelector(`[data-msg-id="${messageId}"]`);
      if (el) {
        el.remove();
        console.log('[app] removed message element:', messageId);
      }
    });

    window.bracerChat.onSessionUpdate((update) => {
      console.log('[app] session-update received:', JSON.stringify(update));
      if (update.broadcastRoomId) sessionInfo.broadcastRoomId = update.broadcastRoomId;
      if (update.companyRoomId)   sessionInfo.companyRoomId   = update.companyRoomId;
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scrollToBottom(true);
    });

    window.bracerChat.onFocusMessage(({ messageId }) => {
      const pins = loadPinned();
      if (pins.length > 0) {
        elPinnedPanel.classList.remove('collapsed');
      }
      const scrollToMsg = (id, attempts = 0) => {
        const bubble = findBubbleById(id);
        if (bubble) {
          bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
        } else if (attempts < 10) {
          setTimeout(() => scrollToMsg(id, attempts + 1), 150);
        }
      };
      scrollToMsg(messageId);
    });

  } catch (err) {
    elConnStatus.textContent = 'Error';
    showStatus('Failed to load: ' + err.message);
    console.error('[app] Init error:', err);
  }
}

// ── Message rendering ──────────────────────────────────────────────────────

/**
 * Parse an RC timestamp to ms epoch. Handles:
 *  - ISO string: "2026-04-03T04:03:30.873Z"
 *  - EJSON date:  { "$date": 1775189010873 }
 *  - ms number:   1775189010873
 */
function parseTs(ts) {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') return new Date(ts).getTime() || 0;
  if (ts.$date) return typeof ts.$date === 'number' ? ts.$date : new Date(ts.$date).getTime() || 0;
  return 0;
}

function formatTime(ts) {
  const ms = parseTs(ts);
  if (!ms) return '';
  const d = new Date(ms);
  const date = d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${date} ${time}`;
}

/** Get timestamp in ms from an RC message. */
function getMsgTs(message) {
  return parseTs(message.ts);
}

/** Extract a readable display name from an RC message's user object. */
function senderLabel(message) {
  if (typeof message === 'string') {
    // Backward compat: if called with a plain string (username)
    return message || 'Unknown';
  }
  // For own messages, always use the current display name (overrides stale name in old messages)
  if (sessionInfo && message.u?._id === sessionInfo.userId && sessionInfo.displayName) {
    return sessionInfo.displayName;
  }
  return message.u?.name || message.u?.username || 'Unknown';
}

/** Scroll to a message by _id and briefly flash it. */
function scrollToMessage(msgId) {
  const el = findBubbleById(msgId);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('message-highlight');
  setTimeout(() => el.classList.remove('message-highlight'), 1500);
}

/**
 * Async: fetch the original message and repopulate the quote block with the
 * sender's name plus the real content (text preview or image thumbnail).
 */
async function enrichQuoteBlock(quoteEl, messageId) {
  let msg;
  try {
    msg = await window.bracerChat.getRoomEvent(activeRoomId, messageId);
  } catch (e) { return; }
  if (!msg) return;

  quoteEl.textContent = '';

  const senderEl = document.createElement('span');
  senderEl.className   = 'reply-quote-sender';
  senderEl.textContent = senderLabel(msg);
  quoteEl.appendChild(senderEl);

  if (hasImage(msg)) {
    const fileUrl = getFileUrl(msg);
    if (fileUrl) {
      const img     = document.createElement('img');
      img.className = 'reply-quote-img';
      img.alt       = msg.msg || 'image';
      quoteEl.appendChild(img);
      window.bracerChat.resolveMediaUrl(fileUrl).then(url => { if (url) img.src = url; });
    }
  } else {
    const bodyText = msg.msg || getFileName(msg) || '[attachment]';
    const textEl   = document.createElement('span');
    textEl.className   = 'reply-quote-text';
    textEl.textContent = bodyText.length > 120 ? bodyText.slice(0, 120) + '...' : bodyText;
    quoteEl.appendChild(textEl);
  }
}

/**
 * Builds and appends (or prepends) a message bubble.
 * Accepts an RC message object: { _id, msg, ts, u, attachments, tmid, ... }
 */
function renderMessage(message, prepend = false) {
  if (!message) return;

  // Skip system messages (user joined, topic changed, etc.)
  if (message.t) return;

  const isOwn   = sessionInfo && (message.u?._id === (sessionInfo.userId || sessionInfo.username));
  const msgText = message.msg || '';

  const wrap = document.createElement('div');
  wrap.className     = `message ${isOwn ? 'own' : 'other'}`;
  wrap.dataset.msgId = message._id || '';

  // Highlight if pinned
  if (message._id && isPinned(message._id)) {
    wrap.classList.add('pinned-highlight');
  }

  // Sender label (hidden for own messages via CSS)
  const senderEl = document.createElement('div');
  senderEl.className   = 'sender';
  senderEl.textContent = senderLabel(message);
  wrap.appendChild(senderEl);

  // Body
  const bodyEl = document.createElement('div');
  bodyEl.className = 'body';

  let imgElForCopy = null;

  // Determine message type from content
  const isImage = hasImage(message);
  const isFile  = hasFile(message) && !isImage;
  const fileUrl = getFileUrl(message);

  // RC quote link pattern: "[ ](https://chat.bracer.ca/.../room?msg=MSGID)" at start of msg
  const quoteLinkMatch = msgText.match(/^\[\s*\]\(https?:\/\/[^)]*[?&]msg=([a-zA-Z0-9]+)[^)]*\)/);

  if (quoteLinkMatch || hasQuoteAttachment(message)) {
    // Quote — either inline link in msg text or attachment with message_link
    const quotedMsgId = quoteLinkMatch
      ? quoteLinkMatch[1]
      : getQuoteAttachment(message)?.message_link?.match(/msg=([a-zA-Z0-9]+)/)?.[1];

    const quoteEl = document.createElement('div');
    quoteEl.className = 'reply-quote';

    if (quotedMsgId) {
      quoteEl.dataset.replyTo = quotedMsgId;
      quoteEl.title           = 'Click to jump to original message';
      quoteEl.style.cursor    = 'pointer';
      quoteEl.addEventListener('click', () => scrollToMessage(quotedMsgId));
      quoteEl.textContent = '...';
      enrichQuoteBlock(quoteEl, quotedMsgId);
    }

    // If quote attachment has text, use it as fallback
    if (!quotedMsgId && hasQuoteAttachment(message)) {
      const qa = getQuoteAttachment(message);
      if (qa.author_name) {
        const senderSpan = document.createElement('span');
        senderSpan.className   = 'reply-quote-sender';
        senderSpan.textContent = qa.author_name;
        quoteEl.appendChild(senderSpan);
      }
      const quoteText = qa.text || qa.description || '[attachment]';
      const textSpan   = document.createElement('span');
      textSpan.className   = 'reply-quote-text';
      textSpan.textContent = quoteText.length > 120 ? quoteText.slice(0, 120) + '...' : quoteText;
      quoteEl.appendChild(textSpan);
    }

    bodyEl.appendChild(quoteEl);

    // The actual reply text (strip the invisible quote link RC prepends)
    const replyText = stripQuoteLink(msgText);
    if (replyText) {
      linkify(bodyEl, replyText);
    }
  } else if (message.tmid && msgText) {
    // Reply message — has thread parent (tmid)
    const quoteEl = document.createElement('div');
    quoteEl.className       = 'reply-quote';
    quoteEl.dataset.replyTo = message.tmid;
    quoteEl.title           = 'Click to jump to original message';
    quoteEl.style.cursor    = 'pointer';
    quoteEl.addEventListener('click', () => scrollToMessage(message.tmid));
    quoteEl.textContent = '...';

    enrichQuoteBlock(quoteEl, message.tmid);

    bodyEl.appendChild(quoteEl);
    linkify(bodyEl, msgText);
  } else if (isImage && fileUrl) {
    // Image message
    const img = document.createElement('img');
    img.alt   = message.msg || getFileName(message) || 'image';
    img.style.cursor = 'pointer';
    img.addEventListener('click', () => {
      window.bracerChat.openImageInApp(fileUrl, getFileName(message) || 'image.png');
    });
    bodyEl.appendChild(img);
    imgElForCopy = img;
    window.bracerChat.resolveMediaUrl(fileUrl).then(httpUrl => {
      if (httpUrl) {
        img.addEventListener('load', scrollToBottom);
        img.src = httpUrl;
      }
    });
    // Also show text if present alongside image
    if (msgText) {
      const textEl = document.createElement('div');
      linkify(textEl, msgText);
      bodyEl.appendChild(textEl);
    }
  } else if (isFile && fileUrl) {
    // File message
    const fileName = getFileName(message);
    const link = document.createElement('a');
    link.className   = 'file-link';
    link.textContent = fileName;
    link.href        = '#';
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      link.textContent = 'Downloading\u2026';
      try {
        await window.bracerChat.downloadFile(fileUrl, fileName);
      } catch (err) {
        showStatus('Download failed: ' + err.message);
      } finally {
        link.textContent = fileName;
      }
    });
    bodyEl.appendChild(link);
    if (msgText) {
      const textEl = document.createElement('div');
      linkify(textEl, msgText);
      bodyEl.appendChild(textEl);
    }
  } else if (msgText) {
    // Plain text message
    linkify(bodyEl, msgText);
  } else {
    bodyEl.textContent = '[unsupported message type]';
  }

  wrap.appendChild(bodyEl);

  // Timestamp
  const timeEl = document.createElement('div');
  timeEl.className   = 'time';
  timeEl.textContent = formatTime(message.ts);
  wrap.appendChild(timeEl);

  // Reply button
  wrap.appendChild(makeReplyBtn(message));

  // Pin button
  const pinBtn = makePinBtn(message);
  if (pinBtn) wrap.appendChild(pinBtn);

  // Copy button
  wrap.appendChild(makeCopyBtn(message, undefined, imgElForCopy));

  // Store message data on the element
  wrap._message = message;

  if (prepend) {
    elMessages.insertBefore(wrap, elMessages.firstChild);
  } else {
    const ts = getMsgTs(message);
    let insertBefore = null;
    const bubbles = elMessages.children;
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const sibTs = bubbles[i]._message ? getMsgTs(bubbles[i]._message) : 0;
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
  const pinnedIds = new Set(loadPinned().map(p => p._id));

  // Load machine room messages
  const messages = await window.bracerChat.getRoomHistory(activeRoomId, cutoff);
  let renderCount = 0;
  for (const msg of messages) {
    if (msg.t) continue; // skip system messages
    const msgTs = getMsgTs(msg);
    const isImg = hasImage(msg);
    const isFl  = hasFile(msg);
    URL_REGEX.lastIndex = 0;
    const hasLink = msg.msg && URL_REGEX.test(msg.msg);
    if (msgTs >= cutoff || pinnedIds.has(msg._id) || isImg || isFl || hasLink) {
      renderMessage(msg);
      if (++renderCount % 20 === 0) await yieldToEventLoop();
    }
  }

  // Load broadcast room history
  if (sessionInfo && sessionInfo.broadcastRoomId) {
    try {
      const bcastMsgs = await window.bracerChat.getRoomHistory(sessionInfo.broadcastRoomId, cutoff);
      renderCount = 0;
      for (const msg of bcastMsgs) {
        if (getMsgTs(msg) < cutoff) continue;
        if (!msg.t) {
          renderBroadcast(msg, 'Bracer Systems Broadcast');
          if (++renderCount % 20 === 0) await yieldToEventLoop();
        }
      }
    } catch (err) {
      console.warn('[app] Could not load broadcast history:', err.message);
    }
  }
  if (sessionInfo && sessionInfo.companyRoomId) {
    try {
      const coMsgs = await window.bracerChat.getRoomHistory(sessionInfo.companyRoomId, cutoff);
      renderCount = 0;
      for (const msg of coMsgs) {
        if (getMsgTs(msg) < cutoff) continue;
        if (!msg.t) {
          renderBroadcast(msg, `${sessionInfo.companyName} Broadcast`);
          if (++renderCount % 20 === 0) await yieldToEventLoop();
        }
      }
    } catch (err) {
      console.warn('[app] Could not load company broadcast history:', err.message);
    }
  }

  scrollToBottom(true);
}

function isNearBottom() {
  return elMessages.scrollHeight - elMessages.scrollTop - elMessages.clientHeight < 150;
}

function scrollToBottom(force = false) {
  if (force || isNearBottom()) {
    elMessages.scrollTop = elMessages.scrollHeight;
  }
}

// ── Notification sound ─────────────────────────────────────────────────────

let audioCtx = null;

function playNotificationSound() {
  if (!document.hidden) return;
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.type            = 'sine';
    osc.frequency.value = 880;

    const t = audioCtx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);

    osc.start(t);
    osc.stop(t + 0.4);
  } catch (err) {
    // Audio not available
  }
}

// ── Incoming messages (from DDP WebSocket) ───────────────────────────────

async function handleIncomingMessage({ roomId, message }) {
  if (message._id && findBubbleById(message._id)) {
    return; // already rendered (dedup)
  }

  // Broadcast rooms — render as announcement
  if (sessionInfo && roomId === sessionInfo.broadcastRoomId) {
    playNotificationSound();
    renderBroadcast(message, 'Bracer Systems Broadcast');
    scrollToBottom();
    return;
  }
  if (sessionInfo && roomId === sessionInfo.companyRoomId) {
    playNotificationSound();
    renderBroadcast(message, `${sessionInfo.companyName} Broadcast`);
    scrollToBottom();
    return;
  }

  if (roomId !== activeRoomId) {
    return;
  }

  const isOwn = sessionInfo && message.u?._id === sessionInfo.userId;
  if (!isOwn) playNotificationSound();

  const wasNearBottom = isNearBottom();
  renderMessage(message);
  applySearch();
  scrollToBottom(wasNearBottom);
  if (!document.hidden && message._id) {
    scheduleReadReceipt();
  }
}

function makePinBtn(message) {
  if (!message._id) return null;
  const btn = document.createElement('button');
  btn.className = 'pin-btn';

  function updateState() {
    const pinned = isPinned(message._id);
    btn.textContent = '\uD83D\uDCCC'; // pin emoji
    btn.title       = pinned ? 'Unpin message' : 'Pin message';
    btn.classList.toggle('pinned', pinned);
  }
  updateState();

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isPinned(message._id)) {
      unpinMessageLocal(message._id);
    } else {
      pinMessageLocal(message);
    }
    updateState();
  });

  return btn;
}

function makeCopyBtn(message, textOverride, imgEl) {
  const btn = document.createElement('button');
  btn.className   = 'copy-btn';
  btn.textContent = 'Copy';
  btn.title       = imgEl ? 'Copy image to clipboard' : 'Copy message text';

  btn.addEventListener('click', (e) => {
    e.stopPropagation();

    if (imgEl && imgEl.src && imgEl.src.startsWith('data:')) {
      window.bracerChat.clipboardWriteImage(imgEl.src).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
      }).catch(() => {});
      return;
    }

    const body = textOverride !== undefined ? textOverride : (message.msg || '');
    const ts   = message.ts ? `[${formatTime(message.ts)}] ` : '';
    const text = ts + body;
    window.bracerChat.clipboardWrite(text);
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
  });
  return btn;
}

function makeReplyBtn(message) {
  const btn = document.createElement('button');
  btn.className   = 'reply-btn';
  btn.textContent = '\u21A9'; // reply arrow
  btn.title       = 'Reply to this message';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setReply(message);
  });
  return btn;
}

function renderBroadcast(message, label) {
  if (!message || !message.msg) {
    console.warn('[app] renderBroadcast: message empty, skipping', message?._id);
    return;
  }
  const dedupKey = message._id || `${message.ts}_${message.u?.username}`;
  if (renderedBroadcastIds.has(dedupKey)) {
    return;
  }
  renderedBroadcastIds.add(dedupKey);

  const wrap = document.createElement('div');
  wrap.className     = 'broadcast-message';
  wrap.dataset.msgId = message._id || '';
  wrap._message      = message;

  const labelEl = document.createElement('div');
  labelEl.className   = 'broadcast-label';
  labelEl.textContent = label + ':';

  const box = document.createElement('div');
  box.className = 'broadcast-box';

  const bodyEl = document.createElement('div');
  bodyEl.className = 'broadcast-body';
  linkify(bodyEl, message.msg);

  const timeEl = document.createElement('div');
  timeEl.className   = 'time';
  timeEl.textContent = formatTime(message.ts);

  box.appendChild(bodyEl);
  box.appendChild(timeEl);
  const broadcastPinBtn = makePinBtn(message);
  if (broadcastPinBtn) box.appendChild(broadcastPinBtn);
  box.appendChild(makeCopyBtn(message, message.msg));
  wrap.appendChild(labelEl);
  wrap.appendChild(box);

  // Insert in chronological order (same as renderMessage)
  const ts = getMsgTs(message);
  let insertBefore = null;
  const bubbles = elMessages.children;
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const sibTs = bubbles[i]._message ? getMsgTs(bubbles[i]._message) : 0;
    if (sibTs <= ts) {
      insertBefore = bubbles[i].nextSibling;
      break;
    }
    insertBefore = bubbles[i];
  }
  elMessages.insertBefore(wrap, insertBefore);
}

// ── Send message ───────────────────────────────────────────────────────────

async function sendMessage() {
  const text = elMsgInput.value.trim();
  if (!text) return;

  const replyTarget = replyToMessage;
  elMsgInput.value = '';
  autoResizeTextarea();
  clearReply();
  if (_isTyping) {
    _isTyping = false;
    clearTimeout(_typingTimer);
    window.bracerChat.sendTyping(activeRoomId, false).catch(() => {});
  }
  elBtnSend.disabled = true;

  try {
    if (replyTarget) {
      await window.bracerChat.sendReply(activeRoomId, text, replyTarget);
      // Optimistic render
      renderMessage({
        _id : `local-${Date.now()}`,
        msg : text,
        tmid: replyTarget._id,
        ts  : new Date().toISOString(),
        u   : { _id: sessionInfo.userId, username: sessionInfo.username || '', name: sessionInfo.displayName || '' }
      });
    } else {
      await window.bracerChat.sendMessage(activeRoomId, text);
      renderMessage({
        _id : `local-${Date.now()}`,
        msg : text,
        ts  : new Date().toISOString(),
        u   : { _id: sessionInfo.userId, username: sessionInfo.username || '', name: sessionInfo.displayName || '' }
      });
    }
    scrollToBottom(true);

  } catch (err) {
    showStatus('Send failed: ' + err.message);
    elMsgInput.value = text;
    if (replyTarget) setReply(replyTarget);
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
    if (!result) return;
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
  showStatus(`Uploading ${name}\u2026`);
  try {
    const { fileUrl, fileName, mimeType: resolvedMime } =
      await window.bracerChat.sendFile(activeRoomId, data, name, mimeType);
    hideStatus();

    // Optimistic render
    const isImage = resolvedMime && resolvedMime.startsWith('image/');
    const msg = {
      _id : `local-${Date.now()}`,
      msg : fileName,
      ts  : new Date().toISOString(),
      u   : { _id: sessionInfo.userId, username: sessionInfo.username || '', name: sessionInfo.displayName || '' }
    };
    if (fileUrl) {
      msg.attachments = [{
        title     : fileName,
        title_link: fileUrl,
        ...(isImage ? { image_url: fileUrl } : {})
      }];
    }
    renderMessage(msg);
    scrollToBottom(true);
  } catch (err) {
    showStatus('Upload failed: ' + err.message);
  }
}

// ── Screen picker ──────────────────────────────────────────────────────────

function hideScreenPicker() {
  elScreenPicker.classList.remove('visible');
}

function showScreenPicker(screens, onSelect) {
  elScreenPickerMap.innerHTML = '';

  const minX = Math.min(...screens.map(s => s.bounds.x));
  const minY = Math.min(...screens.map(s => s.bounds.y));
  const maxX = Math.max(...screens.map(s => s.bounds.x + s.bounds.width));
  const maxY = Math.max(...screens.map(s => s.bounds.y + s.bounds.height));

  const virtualW = maxX - minX;
  const virtualH = maxY - minY;

  const mapW    = 266;
  const scale   = mapW / virtualW;
  const mapH    = Math.round(virtualH * scale);

  elScreenPickerMap.style.height = mapH + 'px';

  screens.forEach((s, i) => {
    const el = document.createElement('div');
    el.className    = 'screen-picker-display';
    el._sourceId    = s.id;
    el.dataset.idx  = i;

    el.style.left   = Math.round((s.bounds.x - minX) * scale) + 'px';
    el.style.top    = Math.round((s.bounds.y - minY) * scale) + 'px';
    el.style.width  = Math.round(s.bounds.width  * scale) + 'px';
    el.style.height = Math.round(s.bounds.height * scale) + 'px';

    if (s.thumbnail) {
      const img = document.createElement('img');
      img.src = s.thumbnail;
      img.alt = s.label;
      el.appendChild(img);
    }

    const label = document.createElement('div');
    label.className   = 'screen-picker-label';
    label.textContent = s.label;
    el.appendChild(label);

    el.addEventListener('click', () => {
      hideScreenPicker();
      onSelect(el._sourceId);
    });

    elScreenPickerMap.appendChild(el);
  });

  elScreenPicker.classList.add('visible');
}

function updateScreenPickerThumbnails(screens) {
  const els = elScreenPickerMap.querySelectorAll('.screen-picker-display');
  screens.forEach((s, i) => {
    const el = els[i];
    if (!el) return;
    el._sourceId = s.id;
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
  showStatus('Capturing screenshot\u2026');
  try {
    const { fileUrl, fileName } = await window.bracerChat.sendScreenshot(activeRoomId, sourceId);
    hideStatus();
    renderMessage({
      _id : `local-${Date.now()}`,
      msg : fileName,
      ts  : new Date().toISOString(),
      u   : { _id: sessionInfo.userId, username: sessionInfo.username || '', name: sessionInfo.displayName || '' },
      attachments: fileUrl ? [{ title: fileName, title_link: fileUrl, image_url: fileUrl }] : []
    });
    scrollToBottom(true);
  } catch (err) {
    showStatus('Screenshot failed: ' + err.message, 0);
    console.error('[app] Screenshot error:', err);
  } finally {
    elBtnShot.disabled = false;
  }
}

async function sendScreenshot() {
  const layout = await window.bracerChat.getScreenLayout();

  if (layout.length <= 1) {
    await captureAndSend(null);
    return;
  }

  showScreenPicker(layout, (sourceId) => captureAndSend(sourceId));

  await new Promise(r => setTimeout(r, 200));
  if (!elScreenPicker.classList.contains('visible')) return;

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
  ctxTargetMsgId = null;
}

elMessages.addEventListener('contextmenu', (e) => {
  const bubble = e.target.closest('.message') || e.target.closest('.broadcast-message');
  if (!bubble || !bubble._message) return;

  e.preventDefault();
  ctxTargetMsgId = bubble._message._id;

  const pinned = isPinned(ctxTargetMsgId);
  elCtxPin.textContent = pinned ? '\uD83D\uDCCC Unpin message' : '\uD83D\uDCCC Pin message';

  const menuW = 160, menuH = 40;
  let x = e.clientX, y = e.clientY;
  if (x + menuW > window.innerWidth)  x = window.innerWidth  - menuW - 4;
  if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 4;

  elCtxMenu.style.left = x + 'px';
  elCtxMenu.style.top  = y + 'px';
  elCtxMenu.classList.add('visible');
});

elCtxPin.addEventListener('click', () => {
  if (!ctxTargetMsgId) return;
  if (isPinned(ctxTargetMsgId)) {
    unpinMessageLocal(ctxTargetMsgId);
  } else {
    const bubble = findBubbleById(ctxTargetMsgId);
    if (bubble && bubble._message) pinMessageLocal(bubble._message);
  }
  hideCtxMenu();
});

document.addEventListener('click', (e) => {
  hideCtxMenu();
  if (!elScreenPicker.contains(e.target) && e.target !== elBtnShot) {
    hideScreenPicker();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideCtxMenu();
    hideScreenPicker();
    clearReply();
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

// ── Typing indicator — outbound ─────────────────────────────────────────
let _typingTimer = null;
let _isTyping    = false;
elMsgInput.addEventListener('input', () => {
  if (!activeRoomId) return;
  if (!_isTyping) {
    _isTyping = true;
    window.bracerChat.sendTyping(activeRoomId, true).catch(() => {});
  }
  clearTimeout(_typingTimer);
  _typingTimer = setTimeout(() => {
    _isTyping = false;
    window.bracerChat.sendTyping(activeRoomId, false).catch(() => {});
  }, 4000);
});

// ── Typing indicator — inbound ──────────────────────────────────────────
// main.js now sends accumulated usernames (not individual events)
window.bracerChat.onTypingUpdate(({ roomId, usernames }) => {
  if (roomId !== activeRoomId) return;
  if (!usernames || usernames.length === 0) {
    elTypingInd.textContent = '';
  } else if (usernames.length === 1) {
    elTypingInd.textContent = `${usernames[0]} is typing...`;
  } else {
    elTypingInd.textContent = 'Several people are typing...';
  }
});

// ── Read receipts ───────────────────────────────────────────────────────
let _readReceiptTimer   = null;
function scheduleReadReceipt() {
  clearTimeout(_readReceiptTimer);
  if (document.hidden || !activeRoomId) return;
  _readReceiptTimer = setTimeout(() => {
    // RC read receipt marks the entire room as read (no per-message ID needed)
    window.bracerChat.sendReadReceipt(activeRoomId).catch(() => {});
  }, 3000);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(_readReceiptTimer);
  } else {
    scheduleReadReceipt();
  }
});
window.addEventListener('focus', () => scheduleReadReceipt());

// Right-click context menu on compose textarea
elMsgInput.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.bracerChat.showInputContextMenu();
});

// Helper: upload a base64 PNG string from the Electron clipboard API
async function pasteClipboardImageB64(b64) {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  await sendFileByPath({ name: `paste-${Date.now()}.png`, mimeType: 'image/png', data: bytes.buffer });
}

elMsgInput.addEventListener('paste', async (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const imageItem = items.find(i => i.type.startsWith('image/'));
  if (!imageItem) return;
  e.preventDefault();
  const b64 = await window.bracerChat.readClipboardImage();
  if (b64) {
    await pasteClipboardImageB64(b64);
  }
});

window.bracerChat.onPasteClipboardImage(async (b64) => {
  await pasteClipboardImageB64(b64);
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
  '\uD83D\uDE00','\uD83D\uDE03','\uD83D\uDE04','\uD83D\uDE01','\uD83D\uDE06','\uD83D\uDE05','\uD83D\uDE02','\uD83E\uDD23',
  '\uD83D\uDE0A','\uD83D\uDE07','\uD83D\uDE42','\uD83D\uDE09','\uD83D\uDE0C','\uD83D\uDE0D','\uD83E\uDD70','\uD83D\uDE18',
  '\uD83D\uDE0B','\uD83D\uDE1B','\uD83D\uDE1C','\uD83E\uDD2A','\uD83D\uDE0E','\uD83E\uDD29','\uD83E\uDD73','\uD83D\uDE0F',
  '\uD83D\uDE10','\uD83D\uDE11','\uD83D\uDE36','\uD83D\uDE44','\uD83D\uDE2F','\uD83D\uDE32','\uD83D\uDE34','\uD83E\uDD14',
  '\uD83D\uDE2D','\uD83D\uDE22','\uD83D\uDE24','\uD83D\uDE20','\uD83D\uDE21','\uD83E\uDD2C','\uD83D\uDE31','\uD83D\uDE28',
  '\uD83D\uDE30','\uD83D\uDE13','\uD83E\uDD17','\uD83E\uDD2D','\uD83E\uDD2B','\uD83D\uDE37','\uD83E\uDD12','\uD83E\uDD15',
  '\uD83D\uDC4D','\uD83D\uDC4E','\uD83D\uDC4C','\uD83E\uDD19','\uD83D\uDC4B','\uD83E\uDD1D','\uD83D\uDE4F','\uD83D\uDCAA',
  '\uD83D\uDC4F','\uD83E\uDD26','\uD83E\uDD37','\uD83D\uDE4C','\uD83D\uDC40','\uD83D\uDC80','\uD83C\uDF89','\uD83D\uDD25',
  '\u2764\uFE0F','\uD83E\uDDE1','\uD83D\uDC9B','\uD83D\uDC9A','\uD83D\uDC99','\uD83D\uDC9C','\uD83D\uDDA4','\uD83D\uDC94',
  '\uD83D\uDCAF','\u2705','\u274C','\u26A0\uFE0F','\u2753','\u2757','\uD83D\uDCA1','\uD83D\uDD17',
  '\uD83D\uDCCE','\uD83D\uDCCB','\uD83D\uDCC1','\uD83D\uDCE7','\uD83D\uDCDE','\uD83D\uDDA5\uFE0F','\u2328\uFE0F','\uD83D\uDDB1\uFE0F',
  '\uD83D\uDD12','\uD83D\uDD13','\uD83D\uDD11','\u2B50','\uD83D\uDE80','\uD83D\uDED1','\u2714\uFE0F','\u27A1\uFE0F'
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

function makeEmojiBtn(emoji) {
  const btn = document.createElement('button');
  btn.textContent = emoji;
  btn.title       = emoji;
  return btn;
}

for (const emoji of EMOJIS) {
  const btn = makeEmojiBtn(emoji);
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
  elBtnExport.textContent = 'Exporting\u2026';
  try {
    const bubbles = elMessages.querySelectorAll('.message, .broadcast-message');
    const rows = [];
    for (const b of bubbles) {
      if (b.classList.contains('search-hidden')) continue;
      const msg     = b._message;
      const sender  = msg ? senderLabel(msg) : '';
      const time    = msg ? formatTime(msg.ts) : '';
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
<title>Bracer Chat Export \u2014 ${escHtml(hostname)}</title>
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

// ── Window pin ─────────────────────────────────────────────────────────────

function applyPinButtonState(pinned) {
  elBtnPinWindow.classList.toggle('pinned', pinned);
  elBtnPinWindow.setAttribute('aria-pressed', String(pinned));
  elBtnPinWindow.title = pinned ? 'Unpin window (click to let it return home)' : 'Pin window position';
}

elBtnPinWindow.addEventListener('click', async () => {
  const current = elBtnPinWindow.classList.contains('pinned');
  const next    = !current;
  applyPinButtonState(next);
  await window.bracerChat.setPinState(next);
});

// ── Boot ───────────────────────────────────────────────────────────────────
init();
