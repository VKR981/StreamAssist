import { validateToken } from './auth.js';
import { saveCredentials, getCredentialsPath } from '../config/credentials.js';

const DEFAULT_CLIENT_ID = 'o9sm5e0yo9i7bi7250k2cvhun61dsx';
const REQUIRED_SCOPES = 'user:read:chat user:write:chat';
const DEVICE_ENDPOINT = 'https://id.twitch.tv/oauth2/device';
const TOKEN_ENDPOINT = 'https://id.twitch.tv/oauth2/token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const REQUEST_TIMEOUT_MS = 10000;

export class DeviceAuthFlow {
  #clientId;
  #fetchImpl;
  #now;
  #validate;
  #save;
  #credentialsPath;
  #attempt = null;
  #generation = 0;
  #abortController = null;
  #completing = false;

  constructor(options = {}) {
    this.#clientId = options.clientId || process.env.TWITCH_CLIENT_ID || DEFAULT_CLIENT_ID;
    this.#fetchImpl = options.fetchImpl || globalThis.fetch;
    this.#now = typeof options.now === 'function' ? options.now : Date.now;
    this.#validate = typeof options.validate === 'function' ? options.validate : validateToken;
    this.#save = typeof options.save === 'function' ? options.save : saveCredentials;
    this.#credentialsPath = options.credentialsPath !== undefined ? options.credentialsPath : getCredentialsPath();
  }

  get clientId() {
    return this.#clientId;
  }

  get credentialsPath() {
    return this.#credentialsPath;
  }

  #createSignal(timeoutMs) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (!this.#abortController?.signal) {
      return timeoutSignal;
    }
    if (typeof AbortSignal.any === 'function') {
      return AbortSignal.any([this.#abortController.signal, timeoutSignal]);
    }
    const controller = new AbortController();
    if (this.#abortController.signal.aborted) {
      controller.abort(this.#abortController.signal.reason);
      return controller.signal;
    }
    const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
    this.#abortController.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        controller.abort(this.#abortController.signal.reason);
      },
      { once: true }
    );
    return controller.signal;
  }

  #sleep(ms) {
    if (ms <= 0 || this.#abortController?.signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const signal = this.#abortController?.signal;
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  async begin() {
    const now = this.#now();
    if (this.#attempt) {
      if (this.#attempt.expiresAt > now) {
        return {
          status: 'authorization_required',
          verification_url: this.#attempt.verificationUri,
          user_code: this.#attempt.userCode,
          expires_at: this.#attempt.expiresAt,
          poll_after_seconds: Math.max(0, Math.ceil((this.#attempt.nextPollAt - now) / 1000)),
        };
      }
      this.#attempt = null;
    }

    this.#generation++;
    if (this.#abortController) {
      this.#abortController.abort();
    }
    this.#abortController = new AbortController();
    const currentGen = this.#generation;
    const signal = this.#createSignal(REQUEST_TIMEOUT_MS);

    let res;
    try {
      const body = new URLSearchParams({
        client_id: this.#clientId,
        scopes: REQUIRED_SCOPES,
      });
      res = await this.#fetchImpl(DEVICE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal,
      });
    } catch {
      if (currentGen !== this.#generation) {
        throw new Error('Device authorization cancelled');
      }
      throw new Error('Failed to contact Twitch device authorization service');
    }

    if (currentGen !== this.#generation) {
      throw new Error('Device authorization cancelled');
    }

    if (!res.ok) {
      throw new Error('Twitch device authorization request failed');
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('Failed to parse Twitch device authorization response');
    }
    if (currentGen !== this.#generation) throw new Error('Device authorization cancelled');

    const { device_code, user_code, verification_uri, expires_in, interval } = data || {};
    if (
      typeof device_code !== 'string' ||
      !device_code.trim() ||
      typeof user_code !== 'string' ||
      !user_code.trim() ||
      typeof verification_uri !== 'string' ||
      !verification_uri.trim()
    ) {
      throw new Error('Twitch device authorization response missing required fields');
    }

    const expiresIn = Number(expires_in);
    const pollInterval = Number(interval);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0 || !Number.isFinite(pollInterval) || pollInterval <= 0) {
      throw new Error('Twitch device authorization returned invalid timers');
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(verification_uri);
    } catch {
      throw new Error('Twitch device authorization returned invalid verification URL');
    }

    const host = parsedUrl.hostname.toLowerCase();
    if (
      parsedUrl.protocol !== 'https:' ||
      (host !== 'twitch.tv' && host !== 'www.twitch.tv') ||
      parsedUrl.pathname !== '/activate' ||
      parsedUrl.username ||
      parsedUrl.password ||
      (parsedUrl.port && parsedUrl.port !== '443')
    ) {
      throw new Error('Untrusted verification URI in Twitch authorization response');
    }

    const startTime = this.#now();
    const expiresAt = startTime + expiresIn * 1000;
    const nextPollAt = startTime + pollInterval * 1000;

    this.#attempt = {
      deviceCode: device_code,
      userCode: user_code,
      verificationUri: verification_uri,
      expiresAt,
      interval: pollInterval,
      nextPollAt,
    };

    return {
      status: 'authorization_required',
      verification_url: verification_uri,
      user_code: user_code,
      expires_at: expiresAt,
      poll_after_seconds: pollInterval,
    };
  }

  async complete(options = {}) {
    if (this.#completing) {
      const pollAfter = this.#attempt
        ? Math.max(1, Math.ceil((this.#attempt.nextPollAt - this.#now()) / 1000))
        : 5;
      return { status: 'pending', poll_after_seconds: pollAfter };
    }

    this.#completing = true;
    try {
      return await this.#executeComplete(options);
    } finally {
      this.#completing = false;
    }
  }

  async #executeComplete(options = {}) {
    if (!this.#attempt) {
      return { status: 'not_started' };
    }

    if (this.#now() >= this.#attempt.expiresAt) {
      this.#attempt = null;
      return { status: 'expired', message: 'Device authorization code expired. Please restart sign-in.' };
    }

    const waitSeconds = Math.min(20, Math.max(0, Number(options?.waitSeconds) || 0));
    const currentGen = this.#generation;
    const deadline = this.#now() + waitSeconds * 1000;

    while (true) {
      if (currentGen !== this.#generation) {
        return { status: 'cancelled' };
      }
      if (!this.#attempt) {
        return { status: 'not_started' };
      }
      if (this.#now() >= this.#attempt.expiresAt) {
        this.#attempt = null;
        return { status: 'expired', message: 'Device authorization code expired. Please restart sign-in.' };
      }

      const now = this.#now();
      if (now < this.#attempt.nextPollAt) {
        if (waitSeconds === 0) {
          return {
            status: 'pending',
            poll_after_seconds: Math.max(1, Math.ceil((this.#attempt.nextPollAt - now) / 1000)),
          };
        }

        const waitMs = Math.min(this.#attempt.nextPollAt - now, deadline - now);
        if (waitMs > 0) {
          await this.#sleep(waitMs);
        }

        if (currentGen !== this.#generation) {
          return { status: 'cancelled' };
        }

        if (this.#now() < this.#attempt.nextPollAt || this.#now() >= deadline) {
          return {
            status: 'pending',
            poll_after_seconds: Math.max(1, Math.ceil((this.#attempt.nextPollAt - this.#now()) / 1000)),
          };
        }
      }

      const result = await this.#pollToken(currentGen);
      if (result.status !== 'pending' || this.#now() >= deadline || waitSeconds === 0) {
        return result;
      }
    }
  }

  async #pollToken(currentGen) {
    if (currentGen !== this.#generation) return { status: 'cancelled' };
    if (!this.#attempt) return { status: 'not_started' };

    const signal = this.#createSignal(REQUEST_TIMEOUT_MS);
    const body = new URLSearchParams({
      client_id: this.#clientId,
      scopes: REQUIRED_SCOPES,
      device_code: this.#attempt.deviceCode,
      grant_type: GRANT_TYPE,
    });

    let res;
    try {
      res = await this.#fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal,
      });
    } catch {
      if (currentGen !== this.#generation) return { status: 'cancelled' };
      const backoffSec = Math.min(30, Math.max(5, (this.#attempt?.interval || 5) * 2));
      if (this.#attempt) {
        this.#attempt.nextPollAt = this.#now() + backoffSec * 1000;
      }
      return { status: 'pending', poll_after_seconds: backoffSec };
    }

    if (currentGen !== this.#generation) return { status: 'cancelled' };

    if (res.status === 429) {
      let retryAfterSec = 0;
      try {
        const raw = res.headers?.get ? res.headers.get('retry-after') : res.headers?.['retry-after'];
        if (raw) retryAfterSec = parseInt(raw, 10);
      } catch {}
      const delaySec = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.max(this.#attempt.interval, Math.min(1800, retryAfterSec))
        : Math.max(5, this.#attempt.interval);
      this.#attempt.nextPollAt = this.#now() + delaySec * 1000;
      return { status: 'pending', poll_after_seconds: delaySec };
    }

    if (res.status >= 500 && res.status < 600) {
      const backoffSec = Math.min(30, Math.max(5, this.#attempt.interval * 2));
      this.#attempt.nextPollAt = this.#now() + backoffSec * 1000;
      return { status: 'pending', poll_after_seconds: backoffSec };
    }

    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (currentGen !== this.#generation) return { status: 'cancelled' };

    if (!res.ok) {
      const msg = String(data?.message || data?.error || data?.error_description || '').toLowerCase();

      if (msg.includes('authorization_pending')) {
        this.#attempt.nextPollAt = this.#now() + this.#attempt.interval * 1000;
        return { status: 'pending', poll_after_seconds: this.#attempt.interval };
      }

      if (msg.includes('slow_down')) {
        this.#attempt.interval += 5;
        this.#attempt.nextPollAt = this.#now() + this.#attempt.interval * 1000;
        return { status: 'pending', poll_after_seconds: this.#attempt.interval };
      }

      if (msg.includes('denied')) {
        this.#attempt = null;
        return { status: 'denied', message: 'User denied authorization.' };
      }

      if (msg.includes('expired')) {
        this.#attempt = null;
        return { status: 'expired', message: 'Device authorization code expired.' };
      }

      if (msg.includes('invalid') || msg.includes('incorrect') || msg.includes('not found')) {
        this.#attempt = null;
        return { status: 'invalid_code', message: 'Device authorization code is invalid.' };
      }

      this.#attempt = null;
      return { status: 'error', message: 'Device authorization failed.' };
    }

    if (!data?.access_token || typeof data.access_token !== 'string') {
      this.#attempt = null;
      return { status: 'error', message: 'Twitch token response missing access token.' };
    }

    let validated;
    try {
      validated = await this.#validate(this.#clientId, data.access_token);
    } catch {
      this.#attempt = null;
      return { status: 'error', message: 'Twitch access token validation failed.' };
    }

    if (currentGen !== this.#generation) return { status: 'cancelled' };

    const tokenExpiresIn = Number(data.expires_in) || validated?.expiresIn || 0;
    const tokenExpiresAt = tokenExpiresIn > 0 ? this.#now() + tokenExpiresIn * 1000 : null;

    try {
      await this.#save(this.#clientId, data.access_token, this.#credentialsPath, {
        refreshToken: data.refresh_token,
        expiresAt: tokenExpiresAt,
      });
    } catch {
      this.#attempt = null;
      return { status: 'error', message: 'Failed to save Twitch credentials.' };
    }

    if (currentGen !== this.#generation) return { status: 'cancelled' };

    this.#attempt = null;

    return {
      status: 'authorized',
      login: validated.login,
      user_id: validated.userId || validated.user_id,
      scopes: validated.scopes || [],
      expires_at: tokenExpiresAt,
    };
  }

  cancel() {
    this.#generation++;
    if (this.#abortController) {
      this.#abortController.abort();
      this.#abortController = null;
    }
    this.#attempt = null;
    return { status: 'cancelled' };
  }

  status() {
    if (!this.#attempt) {
      return { status: 'not_started' };
    }
    const now = this.#now();
    if (now >= this.#attempt.expiresAt) {
      this.#attempt = null;
      return { status: 'not_started' };
    }
    return {
      status: 'authorization_required',
      verification_url: this.#attempt.verificationUri,
      user_code: this.#attempt.userCode,
      expires_at: this.#attempt.expiresAt,
      poll_after_seconds: Math.max(0, Math.ceil((this.#attempt.nextPollAt - now) / 1000)),
    };
  }
}
