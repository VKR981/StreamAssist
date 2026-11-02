/**
 * Twitch Chat API client and Streamer Reply Policy enforcer.
 * Handles rate limits, serialization, cooldowns, message length validation, and drop reasons.
 */

const TWITCH_CHAT_MESSAGES_URL = 'https://api.twitch.tv/helix/chat/messages';

/**
 * Counts unicode characters (code points) accurately.
 */
export function getUnicodeLength(str) {
  if (typeof str !== 'string') return 0;
  return Array.from(str).length;
}

/**
 * Enforces streamer-authorized reply policy.
 * Default: DISABLED.
 * Must be explicitly enabled by streamer instruction per connection.
 */
export class ReplyPolicyManager {
  /**
   * @param {object} [config]
   * @param {boolean} [config.enabled=false]
   * @param {number} [config.maxChars=250]
   * @param {number} [config.cooldownSeconds=5]
   * @param {number} [config.maxRepliesPerMinute=10]
   */
  constructor(config = {}) {
    this.enabled = Boolean(config.enabled ?? false);
    this.maxChars = Math.min(Math.max(Number(config.maxChars) || 250, 1), 500);
    this.cooldownSeconds = Math.max(Number(config.cooldownSeconds) || 5, 1);
    this.maxRepliesPerMinute = Math.max(Number(config.maxRepliesPerMinute) || 10, 1);

    this.lastReplyTimestamp = 0;
    this.recentReplyTimestamps = [];
    this.rateLimitResetUntil = 0;
  }

  /**
   * Resets policy for a new connection (disabled by default, rate limits cleared).
   */
  resetForNewConnection() {
    this.enabled = false;
    this.lastReplyTimestamp = 0;
    this.recentReplyTimestamps = [];
    this.rateLimitResetUntil = 0;
  }

  setPolicy(config = {}) {
    if (config.enabled !== undefined) {
      this.enabled = Boolean(config.enabled);
    }
    if (config.maxChars !== undefined) {
      this.maxChars = Math.min(Math.max(Number(config.maxChars) || 250, 1), 500);
    }
    if (config.cooldownSeconds !== undefined) {
      this.cooldownSeconds = Math.max(Number(config.cooldownSeconds) || 5, 1);
    }
    if (config.maxRepliesPerMinute !== undefined) {
      this.maxRepliesPerMinute = Math.max(Number(config.maxRepliesPerMinute) || 10, 1);
    }
  }

  canReply(messageText) {
    if (!this.enabled) {
      return {
        allowed: false,
        reason: 'Replies are currently disabled by streamer policy. Call set_reply_policy(enabled=true) to enable.',
      };
    }

    if (!messageText || typeof messageText !== 'string' || messageText.trim().length === 0) {
      return {
        allowed: false,
        reason: 'Reply message text must not be empty.',
      };
    }

    const charCount = getUnicodeLength(messageText);
    if (/^\s*!ask(?:\s|$)/i.test(messageText)) {
      return { allowed: false, reason: 'The !ask prefix is reserved for incoming commands. Replies must start with answer text to prevent self-reply loops.' };
    }
    if (charCount > this.maxChars) {
      return {
        allowed: false,
        reason: `Message length (${charCount} chars) exceeds maximum allowed (${this.maxChars} chars). Maximum Twitch limit is 500.`,
      };
    }

    const now = Date.now();

    // Check upstream 429 rate limit reset
    if (this.rateLimitResetUntil > now) {
      const waitSec = Math.ceil((this.rateLimitResetUntil - now) / 1000);
      return {
        allowed: false,
        reason: `Twitch API rate limit active. Please wait ${waitSec}s.`,
      };
    }

    // Check cooldown between replies
    const elapsedSeconds = (now - this.lastReplyTimestamp) / 1000;
    if (elapsedSeconds < this.cooldownSeconds) {
      const remaining = Math.ceil(this.cooldownSeconds - elapsedSeconds);
      return {
        allowed: false,
        reason: `Cooldown active: please wait ${remaining}s before sending another reply (cooldown: ${this.cooldownSeconds}s).`,
      };
    }

    // Check rate budget: max replies per minute
    const oneMinuteAgo = now - 60000;
    this.recentReplyTimestamps = this.recentReplyTimestamps.filter(ts => ts > oneMinuteAgo);
    if (this.recentReplyTimestamps.length >= this.maxRepliesPerMinute) {
      return {
        allowed: false,
        reason: `Rate limit budget reached: maximum ${this.maxRepliesPerMinute} replies per minute.`,
      };
    }

    return { allowed: true };
  }

  setRateLimitBackoff(seconds) {
    const sec = Math.max(1, Number(seconds) || 10);
    this.rateLimitResetUntil = Date.now() + (sec * 1000);
  }

  recordReplySent() {
    const now = Date.now();
    this.lastReplyTimestamp = now;
    this.recentReplyTimestamps.push(now);
  }

  toJSON() {
    return {
      enabled: this.enabled,
      max_chars: this.maxChars,
      cooldown_seconds: this.cooldownSeconds,
      max_replies_per_minute: this.maxRepliesPerMinute,
    };
  }
}

/**
 * Outgoing Twitch Chat API client using Helix Send Chat Message.
 * Serializes sends through a queue to guarantee cooldown and rate budget enforcement.
 */
export class TwitchChatClient {
  /**
   * @param {object} options
   * @param {string} options.clientId
   * @param {string} options.accessToken
   * @param {string} options.broadcasterId
   * @param {string} options.senderId
   * @param {ReplyPolicyManager} options.replyPolicy
   */
  constructor(options) {
    this.clientId = options.clientId;
    this.accessToken = options.accessToken;
    this.broadcasterId = options.broadcasterId;
    this.senderId = options.senderId;
    this.replyPolicy = options.replyPolicy || new ReplyPolicyManager();

    this._sendQueue = Promise.resolve();
    this._abortController = new AbortController();
    this._active = true;
  }

  abort() {
    this._active = false;
    this._abortController.abort();
    this._abortController = new AbortController();
  }

  /**
   * Serialized send message to prevent concurrent sends from bypassing cooldown/rate limits.
   */
  async sendMessage(messageText, inReplyToMessageId) {
    if (this._pendingSends >= 10) return { success: false, isSent: false, reason: 'Reply queue full; request skipped.' };
    this._pendingSends = (this._pendingSends || 0) + 1;
    return new Promise((resolve) => {
      this._sendQueue = this._sendQueue
        .then(() => this._executeSend(messageText, inReplyToMessageId))
        .then(result => { this._pendingSends--; resolve(result); })
        .catch((err) => {
          this._pendingSends--;
          resolve({
            success: false,
            isSent: false,
            reason: 'Twitch send failed.',
          });
        });
    });
  }

  async _executeSend(messageText, inReplyToMessageId) {
    if (!this._active) {
      return {
        success: false,
        isSent: false,
        reason: 'Client disconnected: send aborted.',
      };
    }

    const check = this.replyPolicy.canReply(messageText);
    if (!check.allowed) {
      return {
        success: false,
        isSent: false,
        reason: check.reason,
      };
    }

    const payload = {
      broadcaster_id: this.broadcasterId,
      sender_id: this.senderId,
      message: messageText.trim(),
    };

    if (inReplyToMessageId && typeof inReplyToMessageId === 'string' && inReplyToMessageId.trim()) {
      payload.reply_parent_message_id = inReplyToMessageId.trim();
    }

    let response;
    try {
      const signal = AbortSignal.any
        ? AbortSignal.any([this._abortController.signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000);

      response = await fetch(TWITCH_CHAT_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'Client-Id': this.clientId,
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        return {
          success: false,
          isSent: false,
          reason: 'Send request was aborted due to disconnect or timeout.',
        };
      }
      return {
        success: false,
        isSent: false,
        reason: 'Network error communicating with Twitch chat service.',
      };
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const reset = Number(response.headers.get('ratelimit-reset'));
      const waitSec = Math.max(1, Math.ceil(retryAfter
        ? (Number(retryAfter) || (Date.parse(retryAfter) - Date.now()) / 1000 || 10)
        : (reset ? reset - Date.now() / 1000 : 10)));
      this.replyPolicy.setRateLimitBackoff(waitSec);
      return {
        success: false,
        isSent: false,
        reason: `Twitch rate limit exceeded (HTTP 429). Retry after ${waitSec}s.`,
      };
    }

    if (!response.ok) {
      return {
        success: false,
        isSent: false,
        reason: `Twitch Send Chat Message HTTP error: ${response.status}`,
      };
    }

    let data;
    try {
      data = await response.json();
    } catch {
      return {
        success: false,
        isSent: false,
        reason: 'Failed to parse Twitch chat response JSON.',
      };
    }

    const item = data?.data?.[0];
    if (!item) {
      return {
        success: false,
        isSent: false,
        reason: 'Empty response data received from Twitch Chat API.',
      };
    }

    // Explicitly verify is_sent === true (a missing is_sent is NOT a success)
    if (item.is_sent !== true) {
      const dropReasonMsg = item.drop_reason?.message || item.drop_reason?.code || 'Message dropped by Twitch moderation rules';
      return {
        success: false,
        isSent: false,
        messageId: item.message_id,
        dropReason: dropReasonMsg,
        reason: `Message accepted by Twitch server but dropped: ${dropReasonMsg}`,
      };
    }

    if (!this._active) return { success: false, isSent: false, reason: 'Connection ended before confirmation; delivery is unknown. Do not retry automatically.' };
    // Success confirmed
    this.replyPolicy.recordReplySent();
    return {
      success: true,
      isSent: true,
      messageId: item.message_id,
    };
  }
}
