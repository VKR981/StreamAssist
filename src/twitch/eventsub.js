/**
 * Twitch EventSub WebSocket client.
 * Manages WebSocket connection, subscription, keepalive watchdog,
 * reconnect handover, exponential backoff, and chat message ingestion.
 */

const TWITCH_EVENTSUB_WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
const TWITCH_EVENTSUB_SUBSCRIPTIONS_URL = 'https://api.twitch.tv/helix/eventsub/subscriptions';

export class EventSubClient {
  /**
   * @param {object} options
   * @param {string} options.clientId
   * @param {string} options.accessToken
   * @param {string} options.broadcasterId
   * @param {string} options.userId
   * @param {import('../state/message-buffer.js').MessageBuffer} options.buffer
   * @param {import('../filter/message-filter.js').MessageFilter} options.filter
   * @param {object} [options.customWebSocket]
   * @param {string} [options.wsUrl]
   */
  constructor(options) {
    this.clientId = options.clientId;
    this.accessToken = options.accessToken;
    this.broadcasterId = options.broadcasterId;
    this.userId = options.userId;
    this.buffer = options.buffer;
    this.filter = options.filter;
    this.WebSocketClass = options.customWebSocket || globalThis.WebSocket;
    this.wsUrl = options.wsUrl || TWITCH_EVENTSUB_WS_URL;

    this.ws = null;
    this.handoverWs = null;
    this.sessionId = null;
    this.subscriptionId = null;
    this.connected = false;
    this.revoked = false;
    this.revocationReason = null;
    this.keepaliveTimeoutSeconds = 10;
    this.keepaliveWatchdogTimer = null;
    this.reconnectTimer = null;
    this.handshakeTimeoutTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectDelayMs = 30000;
    this.explicitDisconnect = false;
    this.statusListeners = new Set();
    this.activeSocketGeneration = 0;
    this._seenEvents = new Map();
    this._pendingMessages = 0;
  }

  onStatusChange(fn) {
    this.statusListeners.add(fn);
  }

  _notifyStatus(status) {
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        // ignore listener errors
      }
    }
  }

  /**
   * Connects to Twitch EventSub WebSocket with a finite handshake timeout.
   * Rejects if pre-welcome close or subscription fails.
   */
  async connect() {
    this.explicitDisconnect = false;
    this.revoked = false;
    this.revocationReason = null;
    this._cleanupTimers();

    const generation = ++this.activeSocketGeneration;

    return new Promise((resolve, reject) => {
      let isSettled = false;

      const finishReject = (err) => {
        if (!isSettled) {
          isSettled = true;
          this._cleanupHandshake();
          this.connected = false;
          this._cancelConnect = null;
          reject(err);
        }
      };

      const finishResolve = () => {
        if (generation !== this.activeSocketGeneration || this.explicitDisconnect) return;
        if (!isSettled) {
          isSettled = true;
          this._cleanupHandshake();
          this.connected = true;
          this._cancelConnect = null;
          resolve();
        }
      };
      this._cancelConnect = () => finishReject(new Error('Connection cancelled by streamer.'));

      // Finite handshake timeout (10 seconds)
      this.handshakeTimeoutTimer = setTimeout(() => {
        finishReject(new Error('EventSub connection handshake timed out after 10 seconds.'));
        try {
          this.ws?.close(4001, 'Handshake timeout');
        } catch {
          // ignore
        }
      }, 10000);

      if (typeof this.handshakeTimeoutTimer.unref === 'function') {
        this.handshakeTimeoutTimer.unref();
      }

      try {
        this.ws = new this.WebSocketClass(this.wsUrl);
      } catch (err) {
        return finishReject(new Error(`Failed to initialize WebSocket: ${err.message}`));
      }

      this.ws.onopen = () => {
        // Connected at transport layer, wait for session_welcome and subscription
      };

      this.ws.onmessage = async (event) => {
        if (this.activeSocketGeneration !== generation) return;

        try {
          const raw = typeof event.data === 'string' ? event.data : event.data.toString();
          const message = JSON.parse(raw);
          await this._handleMessage(message, finishResolve, finishReject);
        } catch (err) {
          if (!isSettled) {
            finishReject(err);
          }
        }
      };

      this.ws.onerror = (err) => {
        if (this.activeSocketGeneration !== generation) return;
        const msg = err?.message || 'WebSocket error';
        if (!isSettled) {
          finishReject(new Error(`EventSub WebSocket error: ${msg}`));
        }
      };

      this.ws.onclose = (event) => {
        if (this.activeSocketGeneration !== generation) return;
        this.connected = false;
        this._cleanupWatchdog();

        if (!isSettled) {
          finishReject(new Error(`EventSub closed before completing handshake (code: ${event?.code || 1006})`));
        } else {
          this._notifyStatus({ connected: false, code: event?.code, reason: event?.reason });
          if (!this.explicitDisconnect && !this.revoked) {
            this._scheduleReconnect();
          }
        }
      };
    });
  }

  async _handleMessage(data, onFirstWelcome, onSubscribeError) {
    const { metadata, payload } = data;
    const messageType = metadata?.message_type;

    this._resetWatchdog();

    switch (messageType) {
      case 'session_welcome': {
        this.sessionId = payload.session.id;
        this.keepaliveTimeoutSeconds = payload.session.keepalive_timeout_seconds || 10;
        this._resetWatchdog();

        // Subscribe to channel.chat.message
        try {
          await this._createChatSubscription(this.sessionId);
          if (this.explicitDisconnect) return;
          this.reconnectAttempts = 0;
          this.connected = true;
          this._notifyStatus({ connected: true, sessionId: this.sessionId });
          if (onFirstWelcome) {
            onFirstWelcome();
          }
        } catch (subErr) {
          this.connected = false;
          if (onSubscribeError) {
            onSubscribeError(subErr);
          }
          try {
            this.ws?.close(4002, 'Subscription failed');
          } catch {
            // ignore
          }
        }
        break;
      }

      case 'session_keepalive': {
        // Watchdog was reset above
        break;
      }

      case 'session_reconnect': {
        const reconnectUrl = payload?.session?.reconnect_url;
        if (reconnectUrl) {
          await this._handleReconnectHandover(reconnectUrl);
        }
        break;
      }

      case 'notification': {
        const subscriptionType = metadata?.subscription_type;
        if (subscriptionType === 'channel.chat.message') {
          await this._handleChatMessage(metadata, payload);
        }
        break;
      }

      case 'revocation': {
        const status = payload?.subscription?.status;
        this.revoked = true;
        this.revocationReason = status || 'revoked';
        this.connected = false;
        this._cleanupTimers();

        this._notifyStatus({
          connected: false,
          revoked: true,
          status,
          type: metadata?.subscription_type,
        });

        // If authorization revoked, close and do NOT reconnect
        try {
          this.ws?.close(4003, 'Subscription revoked');
        } catch {
          // ignore
        }
        break;
      }

      default:
        break;
    }
  }

  async _createChatSubscription(sessionId) {
    const url = TWITCH_EVENTSUB_SUBSCRIPTIONS_URL;
    const body = {
      type: 'channel.chat.message',
      version: '1',
      condition: {
        broadcaster_user_id: this.broadcasterId,
        user_id: this.userId,
      },
      transport: {
        method: 'websocket',
        session_id: sessionId,
      },
    };

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Client-Id': this.clientId,
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      throw new Error(`Failed to contact Twitch EventSub subscriptions API: ${err.message}`);
    }

    if (!response.ok) {
      let details = '';
      try {
        const errJson = await response.json();
        details = errJson.message || '';
      } catch {
        // ignore
      }
      throw new Error(`EventSub subscription failed (HTTP ${response.status}): ${details}`);
    }

    const data = await response.json();
    this.subscriptionId = data?.data?.[0]?.id || null;
    if (!this.subscriptionId) throw new Error('Twitch did not return an EventSub subscription ID.');
  }

  async _handleChatMessage(metadata, payload) {
    const generation = this.activeSocketGeneration;
    const event = payload?.event;
    if (!event) return;

    const eventId = metadata?.message_id;
    const messageId = event.message_id;
    const chatterId = event.chatter_user_id;
    const chatterLogin = event.chatter_user_login;
    const chatterName = event.chatter_user_name || chatterLogin;
    const text = event.message?.text || '';
    const timestamp = metadata?.message_timestamp || new Date().toISOString();

    // 1. Dedup & Echo checks BEFORE invoking any async semantic model
    if (messageId && this.buffer.isDuplicate(messageId)) return;
    if (eventId && this.buffer.isDuplicate(eventId)) return;
    if (this.buffer.isEcho(chatterId, chatterLogin || chatterName, text)) return;
    const keys = [eventId && `event:${eventId}`, messageId && `message:${messageId}`].filter(Boolean);
    if (keys.some(key => this._seenEvents.has(key))) return;
    for (const key of keys) this._seenEvents.set(key, true);
    while (this._seenEvents.size > 2000) this._seenEvents.delete(this._seenEvents.keys().next().value);
    if (this._pendingMessages >= 50) {
      this._notifyStatus({ filterError: 'Chat processing queue full; message skipped.' });
      return;
    }
    this._pendingMessages++;

    const candidate = {
      id: messageId,
      eventId,
      chatter: chatterName,
      chatterId,
      chatterLogin,
      text,
      timestamp,
      inReplyTo: event.reply?.parent_message_id || null,
    };

    // 2. Filter check: fail closed on errors
    let matchResult;
    try {
      matchResult = await this.filter.matches(candidate);
    } catch (filterErr) {
      // Semantic filter error: fail closed, do not buffer as matching
      this._notifyStatus({
        filterError: filterErr.message,
        text: text.slice(0, 30),
      });
      return;
    } finally {
      this._pendingMessages--;
    }

    if (!matchResult.match || this.explicitDisconnect || generation !== this.activeSocketGeneration) {
      return;
    }

    this.buffer.push(candidate);
  }

  async _handleReconnectHandover(reconnectUrl) {
    const oldWs = this.ws;
    if (!oldWs) return;

    return new Promise((resolve) => {
      let newWs;
      let handoverTimeoutTimer;

      const cleanupHandover = () => {
        if (handoverTimeoutTimer) clearTimeout(handoverTimeoutTimer);
        this.handoverWs = null;
        this._cancelHandover = null;
      };
      this._cancelHandover = () => { cleanupHandover(); resolve(); };

      try {
        newWs = new this.WebSocketClass(reconnectUrl);
        this.handoverWs = newWs;
      } catch {
        return resolve();
      }

      // Bound handover timeout (15s)
      handoverTimeoutTimer = setTimeout(() => {
        cleanupHandover();
        try {
          newWs.close(4004, 'Handover timeout');
        } catch {
          // ignore
        }
        resolve();
      }, 15000);

      newWs.onopen = () => {
        // Socket opened
      };

      newWs.onmessage = async (event) => {
        if (this.explicitDisconnect || this.revoked || (this.ws !== newWs && this.handoverWs !== newWs)) return;
        try {
          const raw = typeof event.data === 'string' ? event.data : event.data.toString();
          const message = JSON.parse(raw);

          if (message.metadata?.message_type === 'session_welcome') {
            // Handover success: detach old socket close/error handlers
            oldWs.onclose = null;
            oldWs.onerror = null;
            oldWs.onmessage = null;

            try {
              oldWs.close(1000, 'Handover complete');
            } catch {
              // ignore
            }

            // Install standard handlers on new socket
            this.ws = newWs;
            this.connected = true;
            this.sessionId = message.payload.session.id;
            this.keepaliveTimeoutSeconds = message.payload.session.keepalive_timeout_seconds || 10;
            this._resetWatchdog();

            newWs.onclose = (closeEvt) => {
              if (this.ws !== newWs || this.explicitDisconnect) return;
              this.connected = false;
              this._cleanupWatchdog();
              this._notifyStatus({ connected: false, code: closeEvt?.code });
              if (!this.explicitDisconnect && !this.revoked) {
                this._scheduleReconnect();
              }
            };

            newWs.onerror = () => {
              // Standard socket error handler
            };

            cleanupHandover();
            this._notifyStatus({ connected: true, sessionId: this.sessionId, mode: 'reconnect_handover' });
            resolve();
            return;
          }

          // Handle regular message on new socket
          await this._handleMessage(message);
        } catch {
          // ignore
        }
      };

      newWs.onerror = () => {
        cleanupHandover();
        try { newWs.close(); } catch {}
        resolve();
      };

      newWs.onclose = () => {
        cleanupHandover();
        resolve();
      };
    });
  }

  _resetWatchdog() {
    this._cleanupWatchdog();
    const graceMs = (this.keepaliveTimeoutSeconds + 3) * 1000;
    this.keepaliveWatchdogTimer = setTimeout(() => {
      if (this.connected && !this.explicitDisconnect) {
        try {
          this.ws?.close(4000, 'Keepalive watchdog timeout');
        } catch {
          // ignore
        }
      }
    }, graceMs);

    if (typeof this.keepaliveWatchdogTimer.unref === 'function') {
      this.keepaliveWatchdogTimer.unref();
    }
  }

  _scheduleReconnect() {
    if (this.explicitDisconnect || this.revoked || this.reconnectTimer) return;

    // Fresh disconnect reconnect: clear old subscriptionId to force resubscribe
    this.subscriptionId = null;

    this.reconnectAttempts += 1;
    const baseDelay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelayMs);
    const jitter = Math.floor(Math.random() * 500);
    const delay = baseDelay + jitter;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch {
        this._scheduleReconnect();
      }
    }, delay);

    if (typeof this.reconnectTimer.unref === 'function') {
      this.reconnectTimer.unref();
    }
  }

  _cleanupHandshake() {
    if (this.handshakeTimeoutTimer) {
      clearTimeout(this.handshakeTimeoutTimer);
      this.handshakeTimeoutTimer = null;
    }
  }

  _cleanupWatchdog() {
    if (this.keepaliveWatchdogTimer) {
      clearTimeout(this.keepaliveWatchdogTimer);
      this.keepaliveWatchdogTimer = null;
    }
  }

  _cleanupTimers() {
    this._cleanupHandshake();
    this._cleanupWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  disconnect() {
    this.explicitDisconnect = true;
    this.activeSocketGeneration++;
    this._cancelConnect?.();
    this.connected = false;
    this._cleanupTimers();

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try {
        this.ws.close(1000, 'Normal client disconnect');
      } catch {
        // ignore
      }
      this.ws = null;
    }

    if (this.handoverWs) {
      this.handoverWs.onclose = null;
      this.handoverWs.onerror = null;
      this.handoverWs.onmessage = null;
      try {
        this.handoverWs.close(1000, 'Handover aborted');
      } catch {
        // ignore
      }
      this.handoverWs = null;
    }
    this._cancelHandover?.();

    this.sessionId = null;
    this.subscriptionId = null;
    this.buffer.clearWaiters('Client disconnected');
    this._notifyStatus({ connected: false, mode: 'disconnected' });
  }
}
