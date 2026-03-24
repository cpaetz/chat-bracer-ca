'use strict';

/**
 * matrix-client.js
 * Thin Matrix REST API client — no SDK, no E2E encryption (TLS-only, matching
 * server config). Uses Node's built-in https module for all requests.
 *
 * Supported operations: sync (long-poll), sendMessage, sendFile, sendImage,
 * uploadFile, setDisplayName, getRoomMessages, resolveMediaUrl.
 */

const https = require('https');
const { URL } = require('url');

class MatrixClient {
  /**
   * @param {object} opts
   * @param {string} opts.homeserverUrl  e.g. "https://chat.bracer.ca"
   * @param {string} opts.accessToken
   * @param {string} opts.userId         e.g. "@hostname:chat.bracer.ca"
   */
  constructor({ homeserverUrl, accessToken, userId }) {
    this.homeserverUrl    = homeserverUrl.replace(/\/$/, '');
    this.accessToken      = accessToken;
    this.userId           = userId;
    this.syncToken        = null;
    this.running          = false;
    this._initialSyncDone = false;
    this._messageHandlers = [];
    this._txnCounter      = Date.now();
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  _nextTxnId() {
    return `bc-${++this._txnCounter}`;
  }

  /**
   * Makes an authenticated HTTPS request.
   * @param {string}         method
   * @param {string}         urlPath   Full path including query string
   * @param {object|Buffer|null} body
   * @param {string}         contentType  Defaults to application/json
   * @param {number}         timeoutMs
   * @returns {Promise<object>}  Parsed JSON response
   */
  _request(method, urlPath, body = null, contentType = 'application/json', timeoutMs = 12_000) {
    return new Promise((resolve, reject) => {
      const parsed     = new URL(this.homeserverUrl + urlPath);
      const isBuffer   = body instanceof Buffer;
      let   bodyBytes  = null;

      if (body !== null) {
        bodyBytes = isBuffer ? body : Buffer.from(JSON.stringify(body), 'utf8');
      }

      const reqOptions = {
        hostname : parsed.hostname,
        port     : parsed.port || 443,
        path     : parsed.pathname + parsed.search,
        method,
        timeout  : timeoutMs,
        headers  : {
          'Authorization': `Bearer ${this.accessToken}`,
          ...(bodyBytes ? {
            'Content-Type'   : contentType,
            'Content-Length' : bodyBytes.length
          } : {})
        }
      };

      const req = https.request(reqOptions, (res) => {
        const chunks = [];
        res.on('data',  chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            reject(new Error(`Matrix ${res.statusCode}: ${raw.slice(0, 300)}`));
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

  // ── Public API ───────────────────────────────────────────────────────────

  /** Update the Matrix display name for this account. */
  async setDisplayName(displayName) {
    const uid = encodeURIComponent(this.userId);
    await this._request(
      'PUT',
      `/_matrix/client/v3/profile/${uid}/displayname`,
      { displayname: displayName }
    );
  }

  /** Send a poll response (vote) for a given poll event. */
  async sendPollResponse(roomId, pollEventId, answerId) {
    const rid   = encodeURIComponent(roomId);
    const txnId = this._nextTxnId();
    await this._request(
      'PUT',
      `/_matrix/client/v3/rooms/${rid}/send/org.matrix.msc3381.poll.response/${txnId}`,
      {
        'org.matrix.msc3381.poll.response': { answers: [answerId] },
        'm.relates_to': { rel_type: 'm.reference', event_id: pollEventId }
      }
    );
  }

  /** Send a reply to a specific event. Includes Matrix fallback quote in body. */
  async sendReply(roomId, text, replyToEvent) {
    const rid        = encodeURIComponent(roomId);
    const txnId      = this._nextTxnId();
    const origSender = replyToEvent.sender || '';
    const origBody   = (replyToEvent.content && replyToEvent.content.body) || '[attachment]';
    // Matrix reply fallback format: "> <@sender:server> original text\n\nreply text"
    const quotedLines = origBody.split('\n').map((l, i) =>
      i === 0 ? `> <${origSender}> ${l}` : `> ${l}`
    );
    const fallbackBody = `${quotedLines.join('\n')}\n\n${text}`;
    await this._request(
      'PUT',
      `/_matrix/client/v3/rooms/${rid}/send/m.room.message/${txnId}`,
      {
        msgtype       : 'm.text',
        body          : fallbackBody,
        'm.relates_to': { 'm.in_reply_to': { event_id: replyToEvent.event_id } }
      }
    );
  }

  /** Send a plain-text message to a room. */
  async sendMessage(roomId, text) {
    const rid   = encodeURIComponent(roomId);
    const txnId = this._nextTxnId();
    await this._request(
      'PUT',
      `/_matrix/client/v3/rooms/${rid}/send/m.room.message/${txnId}`,
      { msgtype: 'm.text', body: text }
    );
  }

  /**
   * Upload a file buffer to the media repository.
   * Returns the mxc:// URI.
   */
  async uploadFile(fileBuffer, mimeType, fileName) {
    const data = await this._request(
      'POST',
      `/_matrix/media/v3/upload?filename=${encodeURIComponent(fileName)}`,
      fileBuffer,
      mimeType,
      120_000 // 2-minute timeout for large files
    );
    return data.content_uri;
  }

  /** Upload a file and send an m.file event. Returns the mxc:// URI. */
  async sendFile(roomId, fileBuffer, fileName, mimeType) {
    const mxcUri = await this.uploadFile(fileBuffer, mimeType, fileName);
    const rid    = encodeURIComponent(roomId);
    const txnId  = this._nextTxnId();
    await this._request(
      'PUT',
      `/_matrix/client/v3/rooms/${rid}/send/m.room.message/${txnId}`,
      {
        msgtype : 'm.file',
        body    : fileName,
        url     : mxcUri,
        info    : { mimetype: mimeType, size: fileBuffer.length }
      }
    );
    return mxcUri;
  }

  /** Upload an image buffer and send an m.image event. Returns the mxc:// URI. */
  async sendImage(roomId, imageBuffer, fileName, mimeType = 'image/png') {
    const mxcUri = await this.uploadFile(imageBuffer, mimeType, fileName);
    const rid    = encodeURIComponent(roomId);
    const txnId  = this._nextTxnId();

    // Read PNG dimensions from header (bytes 16-23) so Element renders a thumbnail.
    // Falls back to 0x0 if buffer is too short or not a PNG.
    let w = 0, h = 0;
    if (mimeType === 'image/png' && imageBuffer.length >= 24) {
      try { w = imageBuffer.readUInt32BE(16); h = imageBuffer.readUInt32BE(20); } catch (_) {}
    }

    await this._request(
      'PUT',
      `/_matrix/client/v3/rooms/${rid}/send/m.room.message/${txnId}`,
      {
        msgtype : 'm.image',
        body    : fileName,
        url     : mxcUri,
        info    : { mimetype: mimeType, size: imageBuffer.length, w, h }
      }
    );
    return mxcUri;
  }

  /** Fetch a single event by ID. Returns the event object or null if not found. */
  async getEvent(roomId, eventId) {
    try {
      const rid = encodeURIComponent(roomId);
      const eid = encodeURIComponent(eventId);
      return await this._request('GET', `/_matrix/client/v3/rooms/${rid}/event/${eid}`);
    } catch {
      return null;
    }
  }

  /** Get the m.room.name state for a room. Returns the name string or null. */
  async getRoomName(roomId) {
    try {
      const rid  = encodeURIComponent(roomId);
      const data = await this._request('GET',
        `/_matrix/client/v3/rooms/${rid}/state/m.room.name/`
      );
      return data.name || null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch the most recent messages in a room (returns in chronological order).
   */
  /**
   * Fetch all room messages back to sinceTs (ms epoch).
   * Pages through the Matrix /messages API (100 per page) until the oldest
   * event in a page is before sinceTs, then returns everything in
   * chronological order (oldest first).
   */
  async getRoomMessages(roomId, sinceTs = 0) {
    const rid      = encodeURIComponent(roomId);
    const pageSize = 100;
    let allEvents  = [];
    let from       = null;

    while (true) {
      let url = `/_matrix/client/v3/rooms/${rid}/messages?dir=b&limit=${pageSize}`;
      if (from) url += `&from=${encodeURIComponent(from)}`;

      const data  = await this._request('GET', url);
      const chunk = data.chunk || [];
      if (chunk.length === 0) break;

      allEvents = allEvents.concat(chunk);

      // Stop if the oldest event in this page is before the cutoff
      const oldest = chunk[chunk.length - 1];
      if (oldest.origin_server_ts !== undefined && oldest.origin_server_ts < sinceTs) break;

      // Stop if there are no more pages
      if (!data.end || data.end === data.start) break;

      from = data.end;
    }

    return allEvents.reverse(); // chronological order
  }

  /**
   * Convert mxc://server/mediaId → authenticated https download URL.
   * Uses the /_matrix/client/v1/media/download endpoint (requires auth header).
   * Returns null for invalid URIs.
   */
  resolveMediaUrl(mxcUri) {
    if (!mxcUri) return null;
    const m = mxcUri.match(/^mxc:\/\/([^/]+)\/(.+)$/);
    if (!m) return null;
    return `${this.homeserverUrl}/_matrix/client/v1/media/download/${m[1]}/${m[2]}`;
  }

  /**
   * Download media with auth headers and return as a Buffer.
   * @param {string} mxcUri  mxc:// URI
   * @returns {Promise<{buffer: Buffer, mimeType: string}>}
   */
  fetchMedia(mxcUri) {
    const httpUrl = this.resolveMediaUrl(mxcUri);
    if (!httpUrl) return Promise.reject(new Error('Invalid mxc URI'));

    return new Promise((resolve, reject) => {
      const parsed = new URL(httpUrl);
      const reqOptions = {
        hostname : parsed.hostname,
        port     : parsed.port || 443,
        path     : parsed.pathname + parsed.search,
        method   : 'GET',
        timeout  : 60_000,
        headers  : { 'Authorization': `Bearer ${this.accessToken}` }
      };

      const req = https.request(reqOptions, (res) => {
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

  // ── Sync loop ────────────────────────────────────────────────────────────

  /** Register a callback for incoming messages (from other users). */
  onMessage(handler) {
    this._messageHandlers.push(handler);
  }

  /** Start the sync loop (non-blocking). */
  startSync() {
    this.running = true;
    this._syncLoop();
  }

  /** Stop the sync loop. */
  stopSync() {
    this.running = false;
  }

  async _syncLoop() {
    // Compact filter: only timeline events, limit history on first sync
    const filter = encodeURIComponent(JSON.stringify({
      room: { timeline: { limit: 20 } }
    }));

    while (this.running) {
      try {
        // First sync: timeout=0 → get current token without waiting for events.
        // Subsequent syncs: timeout=30000 → long-poll.
        const matrixTimeout = this._initialSyncDone ? 30_000 : 0;
        const since         = this.syncToken
          ? `&since=${encodeURIComponent(this.syncToken)}`
          : '';

        const data = await this._request(
          'GET',
          `/_matrix/client/v3/sync?timeout=${matrixTimeout}${since}&filter=${filter}`,
          null,
          'application/json',
          matrixTimeout + 15_000 // HTTP timeout = matrix timeout + 15s buffer
        );

        this.syncToken = data.next_batch;

        // Emit events only after initial sync (avoid popups for old messages).
        // Own messages are excluded — they are rendered optimistically on send.
        // m.room.encrypted is included as a trigger so encrypted rooms still
        // cause the popup even though we can't decrypt the content.
        if (this._initialSyncDone && data.rooms && data.rooms.join) {
          for (const [roomId, roomData] of Object.entries(data.rooms.join)) {
            const events = roomData.timeline && roomData.timeline.events || [];
            for (const event of events) {
              const isMessage   = event.type === 'm.room.message';
              const isEncrypted = event.type === 'm.room.encrypted';
              const isPoll      = event.type === 'm.poll.start' ||
                                  event.type === 'org.matrix.msc3381.poll.start';
              const fromOther   = event.sender !== this.userId;
              if ((isMessage || isEncrypted) && fromOther) {
                for (const handler of this._messageHandlers) {
                  handler({ roomId, event });
                }
              } else if (isPoll) {
                // Polls show for everyone including own sender
                for (const handler of this._messageHandlers) {
                  handler({ roomId, event });
                }
              }
            }
          }
        }

        this._initialSyncDone = true;

      } catch (err) {
        if (!this.running) break;
        console.error('[MatrixClient] Sync error:', err.message);
        // Back off before retrying to avoid hammering the server on repeated failures
        await new Promise(r => setTimeout(r, 5_000));
      }
    }
  }

  /**
   * Fetch the pinned event IDs for a room from the m.room.pinned_events state.
   * Returns an array of event ID strings, or [] if none / not set.
   */
  async getPinnedEvents(roomId) {
    const rid = encodeURIComponent(roomId);
    try {
      const data = await this._request(
        'GET',
        `/_matrix/client/v3/rooms/${rid}/state/m.room.pinned_events/`
      );
      return Array.isArray(data.pinned) ? data.pinned : [];
    } catch (err) {
      if (err.message && err.message.includes('Matrix 404')) return []; // state event doesn't exist yet
      throw err;
    }
  }

  /**
   * Set the pinned event IDs for a room (overwrites the full list).
   * Requires the user to have sufficient power level to send state events.
   * Returns false if the server rejects it (e.g. M_FORBIDDEN — insufficient power level).
   * @returns {boolean} true on success, false on permission error
   */
  async setPinnedEvents(roomId, pinnedIds) {
    const rid = encodeURIComponent(roomId);
    try {
      await this._request(
        'PUT',
        `/_matrix/client/v3/rooms/${rid}/state/m.room.pinned_events/`,
        { pinned: pinnedIds }
      );
      return true;
    } catch (err) {
      if (err.message && err.message.includes('Matrix 403')) return false; // insufficient power level
      throw err;
    }
  }
}

module.exports = { MatrixClient };
