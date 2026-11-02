// Twitch moderation, scoped to the connected broadcaster. No automatic retries.
export const MODERATION_SCOPES = {
  delete: 'moderator:manage:chat_messages',
  timeout: 'moderator:manage:banned_users',
  ban: 'moderator:manage:banned_users',
  unban: 'moderator:manage:banned_users',
};
export class TwitchModerationClient {
  constructor({ clientId, accessToken, broadcasterId, moderatorId, scopes = [], fetchImpl = globalThis.fetch }) {
    Object.assign(this, { clientId, accessToken, broadcasterId, moderatorId, scopes, fetchImpl });
    this.controller = new AbortController();
    this.active = true;
    this.busy = false;
    this.backoffUntil = 0;
  }
  abort() { this.active = false; this.controller.abort(); }
  async execute(action, { message_id, user_id, duration_seconds, reason } = {}) {
    if (!this.active) throw new Error('Moderation connection ended.');
    if (!Object.hasOwn(MODERATION_SCOPES, action)) throw new Error('Unknown moderation action.');
    if (!this.scopes.includes(MODERATION_SCOPES[action])) throw new Error(`Sign in again to approve ${MODERATION_SCOPES[action]}.`);
    if (action === 'delete' && (typeof message_id !== 'string' || !message_id.trim())) throw new Error('A specific message_id is required. Clearing all chat is not supported.');
    if (action !== 'delete' && !/^\d+$/.test(user_id || '')) throw new Error('A numeric Twitch user_id is required.');
    if (action !== 'delete' && [this.broadcasterId, this.moderatorId].includes(user_id)) throw new Error('Cannot moderate the broadcaster or authenticated moderator.');
    if (action === 'timeout' && (!Number.isInteger(duration_seconds) || duration_seconds < 1 || duration_seconds > 1209600)) throw new Error('Timeout must be 1–1209600 seconds.');
    if (['timeout', 'ban'].includes(action) && (typeof reason !== 'string' || !reason.trim() || Array.from(reason).length > 500)) throw new Error('A reason of 1–500 characters is required.');
    if (this.busy) throw new Error('Moderation request already in progress.');
    if (Date.now() < this.backoffUntil) throw new Error('Twitch moderation rate limit active; wait before retrying.');
    const url = new URL(`https://api.twitch.tv/helix/moderation/${action === 'delete' ? 'chat' : 'bans'}`);
    url.searchParams.set('broadcaster_id', this.broadcasterId);
    url.searchParams.set('moderator_id', this.moderatorId);
    if (action === 'delete') url.searchParams.set('message_id', message_id.trim());
    if (action === 'unban') url.searchParams.set('user_id', user_id);
    const options = { method: ['delete', 'unban'].includes(action) ? 'DELETE' : 'POST', headers: { 'Client-Id': this.clientId, Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' }, signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10000)]) };
    if (options.method === 'POST') options.body = JSON.stringify({ data: { user_id, reason: reason.trim(), ...(action === 'timeout' ? { duration: duration_seconds } : {}) } });
    this.busy = true;
    try {
      let response;
      try { response = await this.fetchImpl(url, options); }
      catch { throw new Error('Moderation request interrupted or timed out; outcome unknown. Do not retry automatically.'); }
      if (response.status === 429) {
        const retry = Number(response.headers.get('retry-after')) || 10;
        this.backoffUntil = Date.now() + Math.max(1, retry) * 1000;
        throw new Error('Twitch moderation rate limit reached (429).');
      }
      const expected = options.method === 'DELETE' ? 204 : 200;
      if (response.status !== expected) throw new Error(`Twitch moderation failed (HTTP ${response.status}). Check permissions and target eligibility. No success confirmed.`);
      if (expected === 200) {
        let item;
        try { item = (await response.json())?.data?.[0]; } catch {}
        if (!item || item.user_id !== user_id || item.broadcaster_id !== this.broadcasterId) throw new Error('Twitch returned no matching moderation receipt; outcome unknown.');
      }
      return { status: 'confirmed', action, ...(message_id ? { message_id } : { user_id }), ...(action === 'timeout' ? { duration_seconds } : {}) };
    } finally { this.busy = false; }
  }
}
