(function () {
  "use strict";

  // ── Config ──────────────────────────────────────────────────────────────────
  var CHAT_SERVER = "https://chat.bracer.ca";
  var HEARTBEAT_INTERVAL = 5 * 60 * 1000; // 5 min
  var SYNC_TIMEOUT = 30000;
  var TYPING_TIMEOUT = 4000;
  var ALLOWED_EXTENSIONS = [
    ".docx", ".xlsx", ".pptx", ".pdf", ".txt",
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg", ".tiff", ".heic"
  ];
  var MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

  // ── State ───────────────────────────────────────────────────────────────────
  var session = null;     // { user_id, access_token, room_id, homeserver }
  var syncToken = null;
  var syncAbort = null;
  var heartbeatTimer = null;
  var typingTimer = null;
  var isOpen = false;
  var isConnecting = false;
  var unreadCount = 0;

  // ── Inject CSS ──────────────────────────────────────────────────────────────
  var css = `
    #bracer-chat-widget * { box-sizing: border-box; margin: 0; padding: 0; }
    #bracer-chat-widget {
      position: fixed; bottom: 24px; right: 24px; z-index: 999999;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      font-size: 14px; color: #333;
    }

    /* Floating button */
    #bcw-btn {
      width: 60px; height: 60px; border-radius: 50%; border: none; cursor: pointer;
      background: #2099c6; color: #fff; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 12px rgba(32,153,198,0.4);
      transition: transform 0.2s, box-shadow 0.2s;
    }
    #bcw-btn:hover { transform: scale(1.08); box-shadow: 0 6px 16px rgba(32,153,198,0.5); }
    #bcw-btn svg { width: 28px; height: 28px; }
    #bcw-badge {
      position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px;
      background: #f8941b; color: #fff; font-size: 11px; font-weight: 700;
      border-radius: 10px; display: none; align-items: center; justify-content: center;
      padding: 0 5px;
    }

    /* Panel */
    #bcw-panel {
      display: none; flex-direction: column;
      width: 370px; height: 520px; max-height: calc(100vh - 100px);
      background: #fff; border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18);
      overflow: hidden;
    }
    #bcw-panel.bcw-open { display: flex; }

    /* Header */
    #bcw-header {
      background: #2099c6; color: #fff; padding: 16px; display: flex;
      align-items: center; gap: 12px; flex-shrink: 0;
    }
    #bcw-header-logo { width: 36px; height: 36px; border-radius: 50%; background: #fff; padding: 4px; }
    #bcw-header-logo img { width: 100%; height: 100%; object-fit: contain; }
    #bcw-header-text h3 { font-size: 15px; font-weight: 700; margin: 0; }
    #bcw-header-text p { font-size: 12px; opacity: 0.85; margin: 0; }
    #bcw-close {
      margin-left: auto; background: none; border: none; color: #fff;
      cursor: pointer; font-size: 20px; line-height: 1; padding: 4px;
      opacity: 0.8; transition: opacity 0.2s;
    }
    #bcw-close:hover { opacity: 1; }

    /* Pre-chat form */
    #bcw-prechat {
      flex: 1; display: flex; flex-direction: column; align-items: center;
      justify-content: center; padding: 32px; gap: 16px; text-align: center;
    }
    #bcw-prechat h3 { font-size: 18px; color: #333; }
    #bcw-prechat p { font-size: 13px; color: #666; }
    #bcw-name-input {
      width: 100%; padding: 10px 14px; border: 1px solid #e0e0e0; border-radius: 6px;
      font-size: 14px; font-family: inherit; outline: none;
      transition: border-color 0.2s;
    }
    #bcw-name-input:focus { border-color: #2099c6; }
    #bcw-start-btn {
      width: 100%; padding: 12px; border: none; border-radius: 6px; cursor: pointer;
      background: #f8941b; color: #fff; font-size: 14px; font-weight: 600;
      font-family: inherit; transition: background 0.2s;
    }
    #bcw-start-btn:hover { background: #d67d14; }
    #bcw-start-btn:disabled { background: #ccc; cursor: not-allowed; }

    /* Messages area */
    #bcw-messages {
      flex: 1; overflow-y: auto; padding: 16px; display: flex;
      flex-direction: column; gap: 8px; background: #f4f7f6;
    }
    #bcw-messages::-webkit-scrollbar { width: 6px; }
    #bcw-messages::-webkit-scrollbar-thumb { background: #ccc; border-radius: 3px; }

    .bcw-msg {
      max-width: 80%; padding: 12px 16px; border-radius: 12px;
      font-size: 13px; line-height: 1.5; word-break: break-word;
    }
    .bcw-msg-mine {
      align-self: flex-end; background: #2099c6; color: #fff;
      border-bottom-right-radius: 4px;
    }
    .bcw-msg-theirs {
      align-self: flex-start; background: #fff; color: #333;
      border: 1px solid #e0e0e0; border-bottom-left-radius: 4px;
    }
    .bcw-msg-sender {
      font-size: 11px; font-weight: 600; color: #2099c6; margin-bottom: 2px;
    }
    .bcw-msg-time {
      font-size: 10px; opacity: 0.6; margin-top: 4px;
    }
    .bcw-msg-system {
      align-self: center; background: none; color: #999; font-size: 12px;
      font-style: italic; padding: 4px 0;
    }
    .bcw-msg-image {
      max-width: 100%; max-height: 200px; border-radius: 8px; margin-top: 6px;
      cursor: pointer; object-fit: contain;
    }
    .bcw-msg-file-link {
      display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px;
      background: rgba(0,0,0,0.05); border-radius: 6px; margin-top: 6px;
      color: inherit; text-decoration: none; font-size: 12px;
    }
    .bcw-msg-file-link:hover { background: rgba(0,0,0,0.1); }
    .bcw-msg-mine .bcw-msg-file-link { background: rgba(255,255,255,0.2); color: #fff; }

    #bcw-typing {
      padding: 0 16px 4px; font-size: 12px; color: #999; font-style: italic;
      min-height: 18px; background: #f4f7f6;
    }

    /* Compose */
    #bcw-compose {
      display: flex; align-items: flex-end; gap: 8px; padding: 12px;
      border-top: 1px solid #e0e0e0; background: #fff; flex-shrink: 0;
    }
    #bcw-input {
      flex: 1; padding: 10px 12px; border: 1px solid #e0e0e0; border-radius: 8px;
      font-size: 14px; font-family: inherit; resize: none; outline: none;
      max-height: 100px; min-height: 38px; line-height: 1.4;
      transition: border-color 0.2s;
    }
    #bcw-input:focus { border-color: #2099c6; }
    #bcw-attach-btn, #bcw-send-btn {
      width: 38px; height: 38px; border-radius: 50%; border: none;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; transition: background 0.2s;
    }
    #bcw-attach-btn { background: #f4f7f6; color: #666; }
    #bcw-attach-btn:hover { background: #e0e0e0; }
    #bcw-send-btn { background: #2099c6; color: #fff; }
    #bcw-send-btn:hover { background: #187aa0; }
    #bcw-send-btn svg, #bcw-attach-btn svg { width: 18px; height: 18px; }
    #bcw-file-input { display: none; }

    /* Powered by */
    #bcw-powered {
      text-align: center; padding: 6px; font-size: 10px; color: #999;
      background: #fff; border-top: 1px solid #f0f0f0;
    }
    #bcw-powered a { color: #2099c6; text-decoration: none; }

    /* Connection status */
    #bcw-status {
      padding: 6px 16px; font-size: 11px; text-align: center;
      background: #fff3cd; color: #856404; display: none;
    }
    #bcw-status.bcw-error { background: #f8d7da; color: #721c24; }
    #bcw-status.bcw-connected { display: none; }

    @media (max-width: 420px) {
      #bcw-panel { width: calc(100vw - 16px); height: calc(100vh - 80px); border-radius: 8px; }
      #bracer-chat-widget { bottom: 8px; right: 8px; }
    }
  `;

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // ── Inject HTML ─────────────────────────────────────────────────────────────
  var container = document.createElement("div");
  container.id = "bracer-chat-widget";
  container.innerHTML = `
    <div id="bcw-panel">
      <div id="bcw-header">
        <div id="bcw-header-logo">
          <img src="${CHAT_SERVER}/widget/bracer-icon.png" alt="Bracer">
        </div>
        <div id="bcw-header-text">
          <h3>Bracer Support</h3>
          <p>We typically reply within minutes</p>
        </div>
        <button id="bcw-close" aria-label="Close chat">&times;</button>
      </div>

      <div id="bcw-status"></div>

      <div id="bcw-prechat">
        <h3>Chat with us</h3>
        <p>Enter your name to start a conversation with our support team.</p>
        <input id="bcw-name-input" type="text" placeholder="Your name" maxlength="64" autocomplete="name">
        <button id="bcw-start-btn">Start Chat</button>
      </div>

      <div id="bcw-messages" style="display:none;"></div>
      <div id="bcw-typing" style="display:none;"></div>
      <div id="bcw-compose" style="display:none;">
        <button id="bcw-attach-btn" title="Attach file">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <input id="bcw-file-input" type="file">
        <textarea id="bcw-input" rows="1" placeholder="Type a message..."></textarea>
        <button id="bcw-send-btn" title="Send">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
      <div id="bcw-powered" style="display:none;">
        Chat by <a href="https://bracer.ca" target="_blank" rel="noopener">Bracer Systems</a>
      </div>
    </div>

    <button id="bcw-btn" aria-label="Open chat">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/><path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg>
      <span id="bcw-badge">0</span>
    </button>
  `;
  document.body.appendChild(container);

  // ── DOM refs ────────────────────────────────────────────────────────────────
  var $btn     = document.getElementById("bcw-btn");
  var $badge   = document.getElementById("bcw-badge");
  var $panel   = document.getElementById("bcw-panel");
  var $close   = document.getElementById("bcw-close");
  var $prechat = document.getElementById("bcw-prechat");
  var $nameIn  = document.getElementById("bcw-name-input");
  var $startBtn= document.getElementById("bcw-start-btn");
  var $msgs    = document.getElementById("bcw-messages");
  var $typing  = document.getElementById("bcw-typing");
  var $compose = document.getElementById("bcw-compose");
  var $input   = document.getElementById("bcw-input");
  var $send    = document.getElementById("bcw-send-btn");
  var $attach  = document.getElementById("bcw-attach-btn");
  var $fileIn  = document.getElementById("bcw-file-input");
  var $powered = document.getElementById("bcw-powered");
  var $status  = document.getElementById("bcw-status");

  // ── Helpers ─────────────────────────────────────────────────────────────────
  var txnCounter = 0;
  function txnId() { return "bcw-" + Date.now() + "-" + (++txnCounter); }

  function formatTime(ts) {
    var d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function fileExtension(name) {
    var i = name.lastIndexOf(".");
    return i >= 0 ? name.substring(i).toLowerCase() : "";
  }

  function isAllowedFile(name) {
    return ALLOWED_EXTENSIONS.indexOf(fileExtension(name)) >= 0;
  }

  function isImageFile(name) {
    var ext = fileExtension(name);
    return [".jpg",".jpeg",".png",".gif",".bmp",".webp",".svg",".tiff",".heic"].indexOf(ext) >= 0;
  }

  function showStatus(msg, isError) {
    $status.textContent = msg;
    $status.className = isError ? "bcw-error" : "";
    $status.style.display = "block";
  }
  function hideStatus() { $status.style.display = "none"; }

  function scrollToBottom() {
    setTimeout(function() { $msgs.scrollTop = $msgs.scrollHeight; }, 50);
  }

  // ── Matrix API helpers ──────────────────────────────────────────────────────
  function matrixFetch(method, path, body) {
    var url = CHAT_SERVER + path;
    var opts = {
      method: method,
      headers: {}
    };
    if (session && session.access_token) {
      opts.headers["Authorization"] = "Bearer " + session.access_token;
    }
    if (body && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    } else if (body) {
      opts.body = body;
    }
    return fetch(url, opts).then(function(r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function sendMessage(text) {
    return matrixFetch("PUT",
      "/_matrix/client/v3/rooms/" + encodeURIComponent(session.room_id) +
      "/send/m.room.message/" + txnId(),
      { msgtype: "m.text", body: text }
    );
  }

  function uploadFile(file) {
    var url = CHAT_SERVER + "/_matrix/media/v3/upload?filename=" + encodeURIComponent(file.name);
    return fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + session.access_token,
        "Content-Type": file.type || "application/octet-stream"
      },
      body: file
    }).then(function(r) {
      if (!r.ok) throw new Error("Upload failed: HTTP " + r.status);
      return r.json();
    });
  }

  function sendFileMessage(file, mxcUrl) {
    var msgtype = isImageFile(file.name) ? "m.image" : "m.file";
    var content = {
      msgtype: msgtype,
      body: file.name,
      url: mxcUrl,
      info: { mimetype: file.type || "application/octet-stream", size: file.size }
    };
    if (msgtype === "m.image") {
      // Attempt to get dimensions for images
      content.info.w = 0;
      content.info.h = 0;
    }
    return matrixFetch("PUT",
      "/_matrix/client/v3/rooms/" + encodeURIComponent(session.room_id) +
      "/send/m.room.message/" + txnId(),
      content
    );
  }

  function sendTyping(typing) {
    return matrixFetch("PUT",
      "/_matrix/client/v3/rooms/" + encodeURIComponent(session.room_id) +
      "/typing/" + encodeURIComponent(session.user_id),
      { typing: typing, timeout: typing ? TYPING_TIMEOUT : undefined }
    ).catch(function() {});
  }

  function mxcToUrl(mxcUri) {
    // mxc://server/media_id -> authenticated client v1 media endpoint
    if (!mxcUri || !mxcUri.startsWith("mxc://")) return "";
    var parts = mxcUri.substring(6).split("/");
    return CHAT_SERVER + "/_matrix/client/v1/media/download/" + parts[0] + "/" + parts[1];
  }

  function mxcToThumbnail(mxcUri, width, height) {
    // mxc://server/media_id -> authenticated client v1 thumbnail endpoint
    if (!mxcUri || !mxcUri.startsWith("mxc://")) return "";
    var parts = mxcUri.substring(6).split("/");
    return CHAT_SERVER + "/_matrix/client/v1/media/thumbnail/" + parts[0] + "/" + parts[1] +
      "?width=" + (width || 320) + "&height=" + (height || 240) + "&method=scale";
  }

  // ── Sync loop ───────────────────────────────────────────────────────────────
  function startSync() {
    doSync();
  }

  function stopSync() {
    if (syncAbort) { syncAbort.abort(); syncAbort = null; }
  }

  function doSync() {
    if (!session) return;

    var url = CHAT_SERVER + "/_matrix/client/v3/sync?timeout=" + SYNC_TIMEOUT;
    if (syncToken) url += "&since=" + syncToken;
    // Filter to only our room
    var filter = {
      room: {
        rooms: [session.room_id],
        timeline: { limit: 50 },
        state: { lazy_load_members: true }
      },
      presence: { types: [] },
      account_data: { types: [] }
    };
    url += "&filter=" + encodeURIComponent(JSON.stringify(filter));

    syncAbort = new AbortController();
    fetch(url, {
      headers: { "Authorization": "Bearer " + session.access_token },
      signal: syncAbort.signal
    })
    .then(function(r) {
      if (!r.ok) throw new Error("Sync HTTP " + r.status);
      return r.json();
    })
    .then(function(data) {
      syncToken = data.next_batch;
      hideStatus();
      processSyncData(data);
      doSync();
    })
    .catch(function(err) {
      if (err.name === "AbortError") return;
      showStatus("Connection lost. Reconnecting...", true);
      setTimeout(doSync, 5000);
    });
  }

  function processSyncData(data) {
    var rooms = (data.rooms || {}).join || {};
    var roomData = rooms[session.room_id];
    if (!roomData) return;

    // Timeline events
    var events = (roomData.timeline || {}).events || [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.type === "m.room.message" && ev.content && ev.content.body) {
        renderMessage(ev);
      }
      if (ev.type === "m.room.member" && ev.content) {
        handleMemberEvent(ev);
      }
    }

    // Typing
    var ephemeral = (roomData.ephemeral || {}).events || [];
    for (var j = 0; j < ephemeral.length; j++) {
      if (ephemeral[j].type === "m.typing") {
        handleTyping(ephemeral[j].content.user_ids || []);
      }
    }
  }

  var seenEvents = {};

  function renderMessage(ev) {
    if (seenEvents[ev.event_id]) return;
    seenEvents[ev.event_id] = true;

    var isMine = ev.sender === session.user_id;
    var content = ev.content;

    var msgDiv = document.createElement("div");
    msgDiv.className = "bcw-msg " + (isMine ? "bcw-msg-mine" : "bcw-msg-theirs");

    // Sender name for staff messages
    if (!isMine) {
      var senderDiv = document.createElement("div");
      senderDiv.className = "bcw-msg-sender";
      // Clean up display — use displayname from content or parse sender
      var senderName = ev.sender.replace(/@(.+):.*/, "$1").replace(/\./g, " ");
      senderName = senderName.charAt(0).toUpperCase() + senderName.slice(1);
      senderDiv.textContent = senderName;
      msgDiv.appendChild(senderDiv);
    }

    // Message body
    if (content.msgtype === "m.image" && content.url) {
      var img = document.createElement("img");
      img.className = "bcw-msg-image";
      img.alt = content.body || "Image";
      img.loading = "lazy";
      // Fetch thumbnail with auth header and create blob URL
      (function(imgEl, mxcUrl) {
        var thumbUrl = mxcToThumbnail(mxcUrl, 320, 240);
        var fullUrl = mxcToUrl(mxcUrl);
        fetch(thumbUrl, {
          headers: { "Authorization": "Bearer " + session.access_token }
        }).then(function(r) {
          if (!r.ok) {
            // Fall back to full download if thumbnail fails
            return fetch(fullUrl, {
              headers: { "Authorization": "Bearer " + session.access_token }
            });
          }
          return r;
        }).then(function(r) { return r.blob(); })
        .then(function(blob) {
          imgEl.src = URL.createObjectURL(blob);
        }).catch(function() {
          imgEl.alt = "[Image failed to load]";
        });
        imgEl.onclick = function() {
          // Download full image with auth for viewing
          fetch(fullUrl, {
            headers: { "Authorization": "Bearer " + session.access_token }
          }).then(function(r) { return r.blob(); })
          .then(function(blob) {
            var url = URL.createObjectURL(blob);
            window.open(url, "_blank");
          });
        };
      })(img, content.url);
      msgDiv.appendChild(img);
    } else if (content.msgtype === "m.file" && content.url) {
      var link = document.createElement("a");
      link.className = "bcw-msg-file-link";
      link.href = mxcToUrl(content.url);
      link.target = "_blank";
      link.rel = "noopener";
      link.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z"/></svg>';
      link.appendChild(document.createTextNode(" " + (content.body || "File")));
      msgDiv.appendChild(link);
    } else {
      var textNode = document.createElement("div");
      textNode.textContent = content.body;
      msgDiv.appendChild(textNode);
    }

    // Timestamp
    var timeDiv = document.createElement("div");
    timeDiv.className = "bcw-msg-time";
    timeDiv.textContent = formatTime(ev.origin_server_ts);
    msgDiv.appendChild(timeDiv);

    $msgs.appendChild(msgDiv);
    scrollToBottom();

    // Badge if panel closed
    if (!isOpen && !isMine) {
      unreadCount++;
      $badge.textContent = unreadCount;
      $badge.style.display = "flex";
    }
  }

  function handleMemberEvent(ev) {
    // Show join/leave for staff only
    if (ev.sender && ev.sender.startsWith("@guest-")) return;
    if (ev.sender === "@bracer-register:chat.bracer.ca") return;
    if (ev.content.membership === "join") {
      var sysMsg = document.createElement("div");
      sysMsg.className = "bcw-msg bcw-msg-system";
      var name = (ev.content.displayname || ev.sender.replace(/@(.+):.*/, "$1")).replace(/\./g, " ");
      sysMsg.textContent = name + " joined the chat";
      $msgs.appendChild(sysMsg);
      scrollToBottom();
    }
  }

  function handleTyping(userIds) {
    var others = userIds.filter(function(u) { return u !== session.user_id; });
    if (others.length > 0) {
      $typing.textContent = "Support is typing...";
      $typing.style.display = "block";
    } else {
      $typing.textContent = "";
      $typing.style.display = "none";
    }
  }

  // ── Session management ──────────────────────────────────────────────────────
  function startSession(name) {
    if (isConnecting) return;
    isConnecting = true;
    $startBtn.disabled = true;
    $startBtn.textContent = "Connecting...";

    fetch(CHAT_SERVER + "/api/guest/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name || "Visitor" })
    })
    .then(function(r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function(data) {
      session = data;
      isConnecting = false;

      // Save to sessionStorage so refresh doesn't lose chat.
      // SECURITY NOTE: any script on the embedding origin can read this token.
      // Guest tokens are short-lived and scoped to a single room, limiting exposure.
      // The server should enforce Origin validation on /api/guest/start.
      try { sessionStorage.setItem("bcw_session", JSON.stringify(session)); } catch(e) {}

      showChatUI();
      startSync();
      startHeartbeat();
    })
    .catch(function(err) {
      isConnecting = false;
      $startBtn.disabled = false;
      $startBtn.textContent = "Start Chat";
      showStatus("Could not connect. Please try again.", true);
    });
  }

  function showChatUI() {
    $prechat.style.display = "none";
    $msgs.style.display = "flex";
    $typing.style.display = "none";
    $compose.style.display = "flex";
    $powered.style.display = "block";
    $input.focus();
  }

  function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(function() {
      if (!session) return;
      fetch(CHAT_SERVER + "/api/guest/heartbeat", {
        method: "POST",
        headers: { "Authorization": "Bearer " + session.access_token }
      }).catch(function() {});
    }, HEARTBEAT_INTERVAL);
  }

  // ── Restore session on page load ───────────────────────────────────────────
  function tryRestoreSession() {
    try {
      var saved = sessionStorage.getItem("bcw_session");
      if (!saved) return false;
      session = JSON.parse(saved);
      // Verify the token is still valid
      fetch(CHAT_SERVER + "/_matrix/client/v3/account/whoami", {
        headers: { "Authorization": "Bearer " + session.access_token }
      }).then(function(r) {
        if (r.ok) {
          showChatUI();
          startSync();
          startHeartbeat();
        } else {
          session = null;
          sessionStorage.removeItem("bcw_session");
        }
      }).catch(function() {
        session = null;
        sessionStorage.removeItem("bcw_session");
      });
      return true;
    } catch(e) { return false; }
  }

  // ── Event handlers ──────────────────────────────────────────────────────────
  $btn.addEventListener("click", function() {
    isOpen = !isOpen;
    if (isOpen) {
      $panel.classList.add("bcw-open");
      $btn.style.display = "none";
      unreadCount = 0;
      $badge.style.display = "none";
      if (session) { $input.focus(); }
      else { $nameIn.focus(); }
    }
  });

  $close.addEventListener("click", function() {
    isOpen = false;
    $panel.classList.remove("bcw-open");
    $btn.style.display = "flex";
  });

  $startBtn.addEventListener("click", function() {
    startSession($nameIn.value.trim());
  });

  $nameIn.addEventListener("keydown", function(e) {
    if (e.key === "Enter") { e.preventDefault(); startSession($nameIn.value.trim()); }
  });

  // Send on Enter (Shift+Enter for newline)
  $input.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });

  // Auto-resize textarea
  $input.addEventListener("input", function() {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 100) + "px";

    // Send typing notification
    sendTyping(true);
    clearTimeout(typingTimer);
    typingTimer = setTimeout(function() { sendTyping(false); }, TYPING_TIMEOUT);
  });

  $send.addEventListener("click", doSend);

  function doSend() {
    var text = $input.value.trim();
    if (!text || !session) return;
    $input.value = "";
    $input.style.height = "auto";
    sendTyping(false);
    sendMessage(text).catch(function(err) {
      showStatus("Failed to send message", true);
    });
  }

  // File upload
  $attach.addEventListener("click", function() { $fileIn.click(); });

  // Build accept attribute from allowed extensions
  $fileIn.setAttribute("accept", ALLOWED_EXTENSIONS.join(","));

  $fileIn.addEventListener("change", function() {
    if (!this.files || !this.files[0] || !session) return;
    handleFileUpload(this.files[0]);
    this.value = "";
  });

  // Paste screenshot support
  $input.addEventListener("paste", function(e) {
    if (!session) return;
    var items = (e.clipboardData || {}).items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf("image/") === 0) {
        e.preventDefault();
        var file = items[i].getAsFile();
        if (file) {
          // Give it a proper name
          var ext = file.type.split("/")[1] || "png";
          if (ext === "jpeg") ext = "jpg";
          var namedFile = new File([file], "screenshot." + ext, { type: file.type });
          handleFileUpload(namedFile);
        }
        return;
      }
    }
  });

  function handleFileUpload(file) {
    if (!isAllowedFile(file.name)) {
      showStatus("File type not allowed. Accepted: images, PDF, Word, Excel, PowerPoint, text.", false);
      setTimeout(hideStatus, 5000);
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      showStatus("File too large (max 25 MB).", false);
      setTimeout(hideStatus, 5000);
      return;
    }

    showStatus("Uploading " + file.name + "...", false);

    uploadFile(file)
      .then(function(resp) {
        hideStatus();
        return sendFileMessage(file, resp.content_uri);
      })
      .catch(function(err) {
        showStatus("Upload failed. Please try again.", true);
        setTimeout(hideStatus, 5000);
      });
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  tryRestoreSession();

})();
