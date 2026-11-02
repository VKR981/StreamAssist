/**
 * Thread-safe, bounded in-memory message buffer with cursor pagination,
 * deduplication, echo suppression, and async wait queues.
 */

export class MessageBuffer {
  /**
   * @param {object} [options]
   * @param {number} [options.capacity=500] Maximum messages stored before oldest dropped
   * @param {number} [options.dedupCapacity=1000] Maximum message/event IDs tracked for deduplication
   * @param {number} [options.maxWaiters=10] Maximum concurrent waiting calls allowed
   * @param {string} [options.botUserId] Bot/Streamer user ID for echo suppression
   * @param {string} [options.botLogin] Bot/Streamer login name for echo suppression
   */
  constructor(options = {}) {
    this.capacity = options.capacity || 500;
    this.dedupCapacity = options.dedupCapacity || 1000;
    this.maxWaiters = options.maxWaiters || 10;
    this.botUserId = options.botUserId || null;
    this.botLogin = options.botLogin ? options.botLogin.toLowerCase() : null;

    this.messages = [];
    this.currentSeq = 0;
    this.oldestSeq = 1;
    this.truncatedCount = 0;

    // Deduplication sets
    this.seenIds = new Set();
    this.seenIdsList = [];

    // Active async waiters
    this.waiters = new Set();
  }

  setBotIdentity(userId, login) {
    this.botUserId = userId ? String(userId) : null;
    this.botLogin = login ? String(login).toLowerCase() : null;
  }

  isDuplicate(id) {
    if (!id) return false;
    return this.seenIds.has(String(id));
  }

  markSeen(id) {
    if (!id) return;
    const strId = String(id);
    if (this.seenIds.has(strId)) return;

    this.seenIds.add(strId);
    this.seenIdsList.push(strId);
    if (this.seenIdsList.length > this.dedupCapacity) {
      const oldest = this.seenIdsList.shift();
      this.seenIds.delete(oldest);
    }
  }

  isEcho(chatterId, chatterLogin, text = '') {
    // Streamers can test the assistant from their own account. Outgoing
    // assistant replies cannot use this reserved prefix (ReplyPolicyManager).
    const isCommand = /^\s*!ask(?:\s|$)/i.test(text);
    if (this.botUserId && chatterId && String(chatterId) === this.botUserId) {
      return !isCommand;
    }
    if (this.botLogin && chatterLogin && chatterLogin.toLowerCase() === this.botLogin) {
      return !isCommand;
    }
    return false;
  }

  push(item) {
    const messageId = item.id;
    const eventId = item.eventId;

    // Deduplication check
    if (messageId && this.isDuplicate(messageId)) {
      return { accepted: false, reason: 'Duplicate message ID suppressed' };
    }
    if (eventId && this.isDuplicate(eventId)) {
      return { accepted: false, reason: 'Duplicate event ID suppressed' };
    }

    // Echo suppression
    if (this.isEcho(item.chatterId, item.chatterLogin || item.chatter, item.text)) {
      return { accepted: false, reason: 'Bot self-echo suppressed' };
    }

    if (messageId) this.markSeen(messageId);
    if (eventId) this.markSeen(eventId);

    this.currentSeq += 1;
    const seq = this.currentSeq;

    const storedMessage = {
      seq,
      id: messageId || `synth-${seq}`,
      chatter: item.chatter || 'Anonymous',
      chatterId: item.chatterId || null,
      text: item.text,
      timestamp: item.timestamp || new Date().toISOString(),
      inReplyTo: item.inReplyTo || null,
    };

    this.messages.push(storedMessage);

    // Enforce ring buffer capacity
    if (this.messages.length > this.capacity) {
      this.messages.shift();
      this.truncatedCount += 1;
      this.oldestSeq = this.messages[0].seq;
    }

    this.notifyWaiters();

    return { accepted: true, seq };
  }

  /**
   * Reads messages beyond a given cursor.
   *
   * Truncation semantics:
   * - If cursor == 0 and truncatedCount > 0: client requested from beginning but history was truncated -> true
   * - If cursor > 0 and cursor < oldestSeq - 1: client cursor has a gap behind current buffer -> true
   * - If cursor >= oldestSeq - 1: client cursor has no gap -> false
   */
  read(cursor = 0, limit = 50) {
    const effectiveLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    const startCursor = Number(cursor) || 0;

    let isTruncated = false;
    if (this.truncatedCount > 0) {
      if (startCursor === 0) {
        isTruncated = true;
      } else if (startCursor < this.oldestSeq - 1) {
        isTruncated = true;
      }
    }

    const available = this.messages.filter(m => m.seq > startCursor);
    const sliced = available.slice(0, effectiveLimit);

    const nextCursor = sliced.length > 0 ? sliced[sliced.length - 1].seq : Math.max(startCursor, this.currentSeq);
    const hasMore = available.length > effectiveLimit;

    return {
      messages: sliced,
      next_cursor: nextCursor,
      truncated: isTruncated,
      has_more: hasMore,
    };
  }

  /**
   * Asynchronously waits for new messages beyond cursor, capped at <= 25 seconds.
   */
  async waitForMessages(cursor = 0, timeoutSeconds = 10) {
    const startCursor = Number(cursor) || 0;
    const cappedTimeout = Math.max(1, Math.min(Number(timeoutSeconds) || 10, 25));

    // Return immediately if messages are already available
    const immediate = this.read(startCursor, 50);
    if (immediate.messages.length > 0) {
      return {
        ...immediate,
        timed_out: false,
      };
    }

    // Enforce concurrent waiter limit
    if (this.waiters.size >= this.maxWaiters) {
      throw new Error(`Maximum concurrent wait_for_messages calls (${this.maxWaiters}) exceeded.`);
    }

    return new Promise((resolve) => {
      let waiterRecord;

      const timer = setTimeout(() => {
        this.waiters.delete(waiterRecord);
        const result = this.read(startCursor, 50);
        resolve({
          ...result,
          timed_out: true,
        });
      }, cappedTimeout * 1000);

      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      waiterRecord = {
        cursor: startCursor,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      };

      this.waiters.add(waiterRecord);
    });
  }

  notifyWaiters() {
    if (this.waiters.size === 0) return;

    for (const waiter of Array.from(this.waiters)) {
      const readResult = this.read(waiter.cursor, 50);
      if (readResult.messages.length > 0) {
        this.waiters.delete(waiter);
        waiter.resolve({
          ...readResult,
          timed_out: false,
        });
      }
    }
  }

  /**
   * Settles all waiters when disconnected or cleared.
   */
  clearWaiters(reason = 'Disconnected') {
    for (const waiter of this.waiters) {
      waiter.resolve({
        messages: [],
        next_cursor: this.currentSeq,
        truncated: false,
        has_more: false,
        timed_out: false,
        disconnected: true,
        reason,
      });
    }
    this.waiters.clear();
  }

  reset() {
    this.clearWaiters('Buffer reset');
    this.messages = [];
    this.currentSeq = 0;
    this.oldestSeq = 1;
    this.truncatedCount = 0;
    this.seenIds.clear();
    this.seenIdsList = [];
  }

  getStats() {
    return {
      totalReceived: this.currentSeq,
      bufferedCount: this.messages.length,
      capacity: this.capacity,
      truncatedCount: this.truncatedCount,
      oldestSeq: this.oldestSeq,
      currentSeq: this.currentSeq,
      activeWaiters: this.waiters.size,
    };
  }
}
