'use strict';

/**
 * rocketchat-client.js
 * Thin Rocket.Chat client — REST API + DDP WebSocket for real-time.
 * No SDK dependencies; uses Node built-in https and WebSocket.
 *
 * Replaces matrix-client.js for the Bracer Chat v2 migration.
 *
 * Auth model:  X-Auth-Token + X-User-Id headers on every REST request.
 * Real-time:   DDP WebSocket subscriptions (stream-room-messages, typing).
 * Room types:  Works with channels (c), groups/private (p), and DMs (d)
 *              by using type-agnostic endpoints where possible.
 */

const https = require('https');
const http  = require('http');
const { URL } = require('url');

class RocketChatClient {
  /**
   * @param {object} opts
   * @param {string} opts.serverUrl   e.g. "https://chat.bracer.ca"
   * @param {string} opts.authToken   RC personal access token or login token
   * @param {string} opts.userId      RC user ID (e.g. "E2gCM7Z8tfGpnrgbw")
   */
  constructor({ serverUrl, authToken, userId }) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.authToken = authToken;
    this.userId    = userId;
    this.username  = null; // set after first /me call or from session
    this.name      = null; // RC display name (e.g. "BSI-SPK-P14S (chris.paetz)")

    // DDP state
    this._ws              = null;
    this._ddpConnected    = false;
    this._ddpId           = 0;
    this._ddpCallbacks    = new Map(); // id -> { resolve, reject }
    this._reconnectDelay  = 1000;
    this._reconnectTimer  = null;
    this._pingTimer       = null;
    this._shouldReconnect = false;
    this._subscribedRooms = new Set();

    // Event handlers
    this._messageHandlers = [];
    this._deleteHandlers  = [];
    this._typingHandlers  = [];
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  _nextDdpId() {
    return String(++this._ddpId);
  }

  /**
   * Parse the server URL to determine protocol (http vs https).
   * Supports both for Tailscale (http) and public (https) access.
   */
  _getRequestModule() {
    return this.serverUrl.startsWith('https') ? https : http;
  }

  /**
   * Makes an authenticated REST request to the RC API.
   * @param {string}              method      HTTP method
   * @param {string}              urlPath     Path including query string (e.g. "/api/v1/me")
   * @param {object|Buffer|null}  body        Request body
   * @param {string}              contentType Defaults to 'application/json'
   * @param {number}              timeoutMs   Request timeout
   * @returns {Promise<object>}   Parsed JSON response
   */
  _request(method, urlPath, body = null, contentType = 'application/json', timeoutMs = 12_000) {
    return new Promise((resolve, reject) => {
      const parsed    = new URL(this.serverUrl + urlPath);
      const isBuffer  = body instanceof Buffer;
      let   bodyBytes = null;

      if (body !== null && !(body instanceof Buffer) && typeof body !== 'string') {
        bodyBytes = Buffer.from(JSON.stringify(body), 'utf8');
      } else if (body instanceof Buffer) {
        bodyBytes = body;
      }

      const reqOptions = {
        hostname : parsed.hostname,
        port     : parsed.port || (parsed.protocol === 'https:' ? 443 : 3000),
        path     : parsed.pathname + parsed.search,
        method,
        timeout  : timeoutMs,
        headers  : {
          'X-Auth-Token': this.authToken,
          'X-User-Id'   : this.userId,
          ...(bodyBytes ? {
            'Content-Type'  : contentType,
            'Content-Length' : bodyBytes.length
          } : {})
        }
      };

      const mod = this._getRequestModule();
      const req = mod.request(reqOptions, (res) => {
        const chunks = [];
        res.on('data',  chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            let errMsg = `RC ${res.statusCode}`;
            try {
              const errJson = JSON.parse(raw);
              if (errJson.error)       errMsg += `: ${String(errJson.error).slice(0, 120)}`;
              else if (errJson.message) errMsg += `: ${String(errJson.message).slice(0, 120)}`;
            } catch { errMsg += ` (non-JSON, ${raw.length} bytes)`; }
            reject(new Error(errMsg));
            return;
          }
          try   { resolve(JSON.parse(raw)); }
          catch { resolve(raw); }
        });
      });

      req.on('error',   reject);
      req.on('timeout', () => req.destroy(new Error(`Request timed out (${timeoutMs}ms)`)));

      if (bodyBytes) req.write(bodyBytes);
      req.end();
    });
  }

  /**
   * Multipart file upload to RC rooms.upload endpoint.
   * @param {string} roomId
   * @param {Buffer} fileBuffer
   * @param {string} fileName
   * @param {string} mimeType
   * @param {string} [description]  Optional message text
   * @returns {Promise<object>}  RC response with message + file info
   */
  _uploadMultipart(roomId, fileBuffer, fileName, mimeType, description = '') {
    return new Promise((resolve, reject) => {
      const boundary = `----BracerUpload${Date.now()}`;
      const parsed   = new URL(`${this.serverUrl}/api/v1/rooms.upload/${encodeURIComponent(roomId)}`);

      // Build multipart body
      const parts = [];

      // File part
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`
      ));
      parts.push(fileBuffer);
      parts.push(Buffer.from('\r\n'));

      // Description part (optional message text)
      if (description) {
        parts.push(Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="description"\r\n\r\n` +
          `${description}\r\n`
        ));
      }

      // Closing boundary
      parts.push(Buffer.from(`--${boundary}--\r\n`));

      const bodyBuffer = Buffer.concat(parts);

      const reqOptions = {
        hostname : parsed.hostname,
        port     : parsed.port || (parsed.protocol === 'https:' ? 443 : 3000),
        path     : parsed.pathname,
        method   : 'POST',
        timeout  : 120_000, // 2-minute timeout for large files
        headers  : {
          'X-Auth-Token'  : this.authToken,
          'X-User-Id'     : this.userId,
          'Content-Type'  : `multipart/form-data; boundary=${boundary}`,
          'Content-Length' : bodyBuffer.length
        }
      };

      const mod = this._getRequestModule();
      const req = mod.request(reqOptions, (res) => {
        const chunks = [];
        res.on('data',  chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            reject(new Error(`RC upload ${res.statusCode}: ${raw.slice(0, 200)}`));
            return;
          }
          try   { resolve(JSON.parse(raw)); }
          catch { resolve(raw); }
        });
      });

      req.on('error',   reject);
      req.on('timeout', () => req.destroy(new Error('File upload timed out')));

      req.write(bodyBuffer);
      req.end();
    });
  }

  // ── Public REST API ──────────────────────────────────────────────────────

  /** Get current user info. Sets this.username as side effect. */
  async getMe() {
    const data = await this._request('GET', '/api/v1/me');
    if (data.username) this.username = data.username;
    if (data.name)     this.name     = data.name;
    return data;
  }

  /** Send a plain-text message to a room. Returns the message object. */
  async sendMessage(roomId, text) {
    const data = await this._request('POST', '/api/v1/chat.sendMessage', {
      message: { rid: roomId, msg: text }
    });
    return data.message;
  }

  /**
   * Send a notice-style message (used for bot/diagnostic responses).
   * RC doesn't have a native "notice" type, so we use a regular message
   * with an alias to visually distinguish it.
   */
  async sendNotice(roomId, text) {
    const data = await this._request('POST', '/api/v1/chat.sendMessage', {
      message: { rid: roomId, msg: text }
    });
    return data.message;
  }

  /**
   * Send a reply in a thread. Uses tmid (thread message ID) to link.
   * @param {string} roomId
   * @param {string} text
   * @param {object} replyToMsg  The RC message object being replied to
   */
  async sendReply(roomId, text, replyToMsg) {
    const data = await this._request('POST', '/api/v1/chat.sendMessage', {
      message: {
        rid : roomId,
        msg : text,
        tmid: replyToMsg._id  // thread parent message ID
      }
    });
    return data.message;
  }

  /**
   * Upload a file and send it as a message. Returns the RC response.
   * Works for any file type — RC auto-detects images.
   */
  async sendFile(roomId, fileBuffer, fileName, mimeType) {
    const data = await this._uploadMultipart(roomId, fileBuffer, fileName, mimeType);
    return data.message;
  }

  /**
   * Upload an image and send it as a message. Same as sendFile —
   * RC handles image rendering automatically based on mime type.
   */
  async sendImage(roomId, imageBuffer, fileName, mimeType = 'image/png') {
    return this.sendFile(roomId, imageBuffer, fileName, mimeType);
  }

  /**
   * Fetch a single message by ID. Returns the message object or null.
   */
  async getMessage(messageId) {
    try {
      const data = await this._request('GET',
        `/api/v1/chat.getMessage?msgId=${encodeURIComponent(messageId)}`
      );
      return data.message || null;
    } catch {
      return null;
    }
  }

  /**
   * Get room info by ID. Works for any room type.
   * @returns {{ _id, name, fname, t, ... } | null}
   */
  async getRoomInfo(roomId) {
    try {
      const data = await this._request('GET',
        `/api/v1/rooms.info?roomId=${encodeURIComponent(roomId)}`
      );
      return data.room || null;
    } catch {
      return null;
    }
  }

  /**
   * Get the display name of a room. Returns fname or name, or null.
   */
  async getRoomName(roomId) {
    const room = await this.getRoomInfo(roomId);
    if (!room) return null;
    return room.fname || room.name || null;
  }

  /**
   * Fetch room message history. Returns messages in chronological order (oldest first).
   * Pages backward until sinceTs is reached.
   * @param {string} roomId
   * @param {number} sinceTs  Millisecond epoch timestamp (0 = fetch all)
   * @returns {Promise<object[]>}  Array of RC message objects
   */
  async getRoomMessages(roomId, sinceTs = 0) {
    const pageSize   = 100;
    let allMessages  = [];
    let offset       = 0;
    const oldestDate = sinceTs ? new Date(sinceTs).toISOString() : undefined;

    while (true) {
      let url = `/api/v1/channels.history?roomId=${encodeURIComponent(roomId)}&count=${pageSize}&offset=${offset}`;
      if (oldestDate) url += `&oldest=${encodeURIComponent(oldestDate)}`;

      let data;
      try {
        data = await this._request('GET', url);
      } catch (err) {
        // If channels.history fails (wrong room type), try groups.history
        if (err.message && err.message.includes('error-room-not-found')) {
          url = url.replace('channels.history', 'groups.history');
          data = await this._request('GET', url);
        } else {
          throw err;
        }
      }

      const msgs = data.messages || [];
      if (msgs.length === 0) break;

      allMessages = allMessages.concat(msgs);

      // RC returns newest-first; stop if we've gone past sinceTs
      if (sinceTs > 0) {
        const oldestMsg = msgs[msgs.length - 1];
        const msgTs     = new Date(oldestMsg.ts).getTime();
        if (msgTs <= sinceTs) break;
      }

      // Stop if no more pages
      if (msgs.length < pageSize) break;

      offset += pageSize;
    }

    // RC returns newest-first; reverse to chronological
    return allMessages.reverse();
  }

  /**
   * Build the authenticated download URL for an RC file.
   * RC file URLs are relative paths like /file-upload/id/filename.
   * Returns full URL with server prefix, or null for invalid input.
   */
  resolveFileUrl(fileUrl) {
    if (!fileUrl) return null;
    // Already absolute URL
    if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) return fileUrl;
    // Relative RC path
    return `${this.serverUrl}${fileUrl.startsWith('/') ? '' : '/'}${fileUrl}`;
  }

  /**
   * Download a file from RC with auth headers. Returns buffer + mimeType.
   * @param {string} fileUrl  Absolute or relative file URL
   * @returns {Promise<{ buffer: Buffer, mimeType: string }>}
   */
  fetchMedia(fileUrl) {
    const fullUrl = this.resolveFileUrl(fileUrl);
    if (!fullUrl) return Promise.reject(new Error('Invalid file URL'));

    return new Promise((resolve, reject) => {
      const parsed = new URL(fullUrl);
      const mod    = parsed.protocol === 'https:' ? https : http;

      const reqOptions = {
        hostname : parsed.hostname,
        port     : parsed.port || (parsed.protocol === 'https:' ? 443 : 3000),
        path     : parsed.pathname + parsed.search,
        method   : 'GET',
        timeout  : 60_000,
        headers  : {
          'X-Auth-Token': this.authToken,
          'X-User-Id'   : this.userId
        }
      };

      const req = mod.request(reqOptions, (res) => {
        // Follow redirects (RC sometimes 302s to CDN)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.fetchMedia(res.headers.location).then(resolve).catch(reject);
          return;
        }

        const chunks = [];
        res.on('data',  chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`Media fetch ${res.statusCode}`));
            return;
          }
          resolve({
            buffer  : Buffer.concat(chunks),
            mimeType: res.headers['content-type'] || 'application/octet-stream'
          });
        });
      });

      req.on('error',   reject);
      req.on('timeout', () => req.destroy(new Error('Media fetch timeout')));
      req.end();
    });
  }

  /** Send a read receipt for a room (marks all messages as read). */
  async sendReadReceipt(roomId) {
    await this._request('POST', '/api/v1/subscriptions.read', { rid: roomId });
  }

  /**
   * Get pinned messages for a room.
   * @returns {Promise<object[]>}  Array of pinned message objects
   */
  async getPinnedMessages(roomId) {
    try {
      const data = await this._request('GET',
        `/api/v1/chat.getPinnedMessages?roomId=${encodeURIComponent(roomId)}&count=50`
      );
      return data.messages || [];
    } catch {
      return [];
    }
  }

  /** Pin a message by ID. Returns true on success, false on permission error. */
  async pinMessage(messageId) {
    try {
      await this._request('POST', '/api/v1/chat.pinMessage', { messageId });
      return true;
    } catch (err) {
      if (err.message && (err.message.includes('403') || err.message.includes('not-authorized'))) {
        return false;
      }
      throw err;
    }
  }

  /** Unpin a message by ID. Returns true on success, false on permission error. */
  async unpinMessage(messageId) {
    try {
      await this._request('POST', '/api/v1/chat.unPinMessage', { messageId });
      return true;
    } catch (err) {
      if (err.message && (err.message.includes('403') || err.message.includes('not-authorized'))) {
        return false;
      }
      throw err;
    }
  }

  // ── DDP WebSocket ────────────────────────────────────────────────────────

  /** Register a callback for incoming messages. Called with { roomId, message }. */
  onMessage(handler) {
    this._messageHandlers.push(handler);
  }

  /** Register a callback for deleted messages. Called with { roomId, messageId }. */
  onDelete(handler) {
    this._deleteHandlers.push(handler);
  }

  /** Register a callback for typing updates. Called with { roomId, usernames }. */
  onTyping(handler) {
    this._typingHandlers.push(handler);
  }

  /**
   * Connect the DDP WebSocket for real-time events.
   * @param {string[]} roomIds  Room IDs to subscribe to
   */
  async connectDDP(roomIds) {
    this._shouldReconnect = true;
    this._roomIdsToSubscribe = roomIds;
    await this._ddpConnect();
  }

  /** Disconnect the DDP WebSocket. */
  disconnectDDP() {
    this._shouldReconnect = false;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._pingTimer);
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._ddpConnected = false;
    this._subscribedRooms.clear();
  }

  /** Send typing indicator via DDP. */
  sendTyping(roomId, typing) {
    if (!this._ddpConnected) return;
    const username = this.username || this.userId;
    this._ddpSend({
      msg    : 'method',
      id     : this._nextDdpId(),
      method : 'stream-notify-room',
      params : [`${roomId}/typing`, username, typing]
    });
  }

  // ── DDP internals ───────────────────────────────────────────────────────

  _ddpConnect() {
    return new Promise((resolve, reject) => {
      const wsUrl = this.serverUrl
        .replace('https://', 'wss://')
        .replace('http://', 'ws://') + '/websocket';

      try {
        this._ws = new WebSocket(wsUrl);
      } catch (err) {
        reject(err);
        return;
      }

      let resolved = false;

      this._ws.onopen = () => {
        // Send DDP connect message
        this._ddpSend({ msg: 'connect', version: '1', support: ['1'] });
      };

      this._ws.onmessage = (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }

        switch (data.msg) {
          case 'connected':
            this._ddpConnected   = true;
            this._reconnectDelay = 1000; // reset backoff
            this._ddpLogin().then(() => {
              this._subscribeToRooms();
              this._startPingInterval();
              if (!resolved) { resolved = true; resolve(); }
            }).catch(err => {
              console.error('[RCClient] DDP login failed:', err.message);
              if (!resolved) { resolved = true; reject(err); }
            });
            break;

          case 'ping':
            this._ddpSend({ msg: 'pong' });
            break;

          case 'result':
            this._handleDdpResult(data);
            break;

          case 'changed':
            this._handleDdpChanged(data);
            break;

          case 'ready':
            // Subscription confirmed — no action needed
            break;

          case 'nosub':
            console.warn('[RCClient] Subscription rejected:', data.id);
            break;

          case 'failed':
            console.error('[RCClient] DDP connection failed');
            if (!resolved) { resolved = true; reject(new Error('DDP version negotiation failed')); }
            break;
        }
      };

      this._ws.onerror = (err) => {
        console.error('[RCClient] WebSocket error:', err.message || err);
      };

      this._ws.onclose = () => {
        this._ddpConnected = false;
        this._subscribedRooms.clear();
        clearInterval(this._pingTimer);

        if (this._shouldReconnect) {
          console.log(`[RCClient] WebSocket closed, reconnecting in ${this._reconnectDelay}ms...`);
          this._reconnectTimer = setTimeout(() => {
            this._ddpConnect().catch(err => {
              console.error('[RCClient] Reconnect failed:', err.message);
            });
          }, this._reconnectDelay);

          // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
          this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30_000);
        }
      };

      // Timeout for initial connection
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('DDP connection timeout'));
        }
      }, 15_000);
    });
  }

  _ddpSend(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  /** Authenticate the DDP session with a resume token. */
  _ddpLogin() {
    return new Promise((resolve, reject) => {
      const id = this._nextDdpId();
      this._ddpCallbacks.set(id, { resolve, reject });

      this._ddpSend({
        msg    : 'method',
        id,
        method : 'login',
        params : [{ resume: this.authToken }]
      });

      // Timeout
      setTimeout(() => {
        if (this._ddpCallbacks.has(id)) {
          this._ddpCallbacks.delete(id);
          reject(new Error('DDP login timeout'));
        }
      }, 10_000);
    });
  }

  /** Subscribe to real-time messages and typing for each room. */
  _subscribeToRooms() {
    const rooms = this._roomIdsToSubscribe || [];
    for (const roomId of rooms) {
      if (this._subscribedRooms.has(roomId)) continue;

      // Subscribe to messages
      const msgSubId = this._nextDdpId();
      this._ddpSend({
        msg    : 'sub',
        id     : msgSubId,
        name   : 'stream-room-messages',
        params : [roomId, false]
      });

      // Subscribe to typing notifications
      const typSubId = this._nextDdpId();
      this._ddpSend({
        msg    : 'sub',
        id     : typSubId,
        name   : 'stream-notify-room',
        params : [`${roomId}/typing`, false]
      });

      // Subscribe to message deletion notifications
      const delSubId = this._nextDdpId();
      this._ddpSend({
        msg    : 'sub',
        id     : delSubId,
        name   : 'stream-notify-room',
        params : [`${roomId}/deleteMessage`, false]
      });

      this._subscribedRooms.add(roomId);
    }
  }

  /** Client-side ping to keep WebSocket alive. */
  _startPingInterval() {
    clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => {
      this._ddpSend({ msg: 'ping' });
    }, 25_000); // every 25s
  }

  /** Handle DDP method results (login, etc.). */
  _handleDdpResult(data) {
    const cb = this._ddpCallbacks.get(data.id);
    if (!cb) return;
    this._ddpCallbacks.delete(data.id);

    if (data.error) {
      cb.reject(new Error(data.error.message || data.error.reason || 'DDP method error'));
    } else {
      cb.resolve(data.result);
    }
  }

  /**
   * Handle DDP 'changed' events — these carry real-time messages and typing.
   *
   * stream-room-messages: fields.args = [messageObject]
   * stream-notify-room:  fields.args = [username, isTyping]
   *                      fields.eventName = "roomId/typing"
   */
  _handleDdpChanged(data) {
    if (!data.fields) return;
    const collection = data.collection;
    const args       = data.fields.args || [];
    const eventName  = data.fields.eventName || '';

    if (collection === 'stream-room-messages' && args.length > 0) {
      const message = args[0];
      if (!message || !message.rid) return;

      // Message deleted — check for t:'rm' or _hidden flag
      if (message.t === 'rm' || message._hidden === true) {
        for (const handler of this._deleteHandlers) {
          handler({ roomId: message.rid, messageId: message._id });
        }
        return;
      }

      // Skip own messages (rendered optimistically on send)
      if (message.u && message.u._id === this.userId) return;

      // Skip system messages (user joined, left, etc.)
      if (message.t) return;

      for (const handler of this._messageHandlers) {
        handler({ roomId: message.rid, message });
      }
    }

    // Handle delete notifications via stream-notify-room deleteMessage/deleteMessageBulk
    if (collection === 'stream-notify-room' && (eventName.endsWith('/deleteMessage') || eventName.endsWith('/deleteMessageBulk'))) {
      const roomId = eventName.split('/')[0];
      // deleteMessage or deleteMessageBulk event
      if (eventName.endsWith('/deleteMessage') && args[0]) {
        const msgId = args[0]._id || args[0];
        for (const handler of this._deleteHandlers) {
          handler({ roomId, messageId: msgId });
        }
      } else if (eventName.endsWith('/deleteMessageBulk') && Array.isArray(args[0])) {
        for (const msgId of args[0]) {
          for (const handler of this._deleteHandlers) {
            handler({ roomId, messageId: msgId });
          }
        }
      }
      return;
    }

    if (collection === 'stream-notify-room' && eventName.endsWith('/typing')) {
      const roomId    = eventName.replace('/typing', '');
      const username  = args[0];
      const isTyping  = args[1];

      // Filter out own typing
      if (username === this.username) return;

      for (const handler of this._typingHandlers) {
        handler({ roomId, username, isTyping });
      }
    }
  }
}

module.exports = { RocketChatClient };
