/**
 * Twitch OAuth2 token validation and user identity resolution.
 */

const TWITCH_VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const TWITCH_USERS_URL = 'https://api.twitch.tv/helix/users';

/**
 * Validates a user access token with Twitch OAuth API.
 *
 * @param {string} clientId
 * @param {string} accessToken
 * @param {object} [options]
 * @param {number} [options.timeoutMs=30000]
 * @returns {Promise<{ userId: string, login: string, clientId: string, scopes: string[], expiresIn: number }>}
 */
export async function validateToken(clientId, accessToken, options = {}) {
  const timeoutMs = options.timeoutMs || 30000;

  let response;
  try {
    response = await fetch(TWITCH_VALIDATE_URL, {
      method: 'GET',
      headers: {
        Authorization: `OAuth ${accessToken}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error(`Twitch auth validation timed out after ${timeoutMs}ms. Check network connection.`);
    }
    throw new Error(`Network error contacting Twitch auth service: ${err.message}`);
  }

  if (response.status === 401) {
    throw new Error(
      'Twitch access token is invalid or expired (HTTP 401). Please re-authenticate using "pnpm run setup-auth" or generate a new token with scopes "user:read:chat user:write:chat".'
    );
  }

  if (!response.ok) {
    throw new Error(`Twitch auth validation failed with status ${response.status}. Please verify your credentials.`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Failed to parse Twitch OAuth validation response as JSON.');
  }

  if (!data.user_id || !data.login) {
    throw new Error('Twitch OAuth token validation returned no user ID or login. Expected user access token.');
  }

  // Verify client ID matches
  if (clientId && data.client_id !== clientId) {
    throw new Error(
      `Client ID mismatch: token belongs to client "${data.client_id}", but configured client ID is "${clientId}".`
    );
  }

  const scopes = Array.isArray(data.scopes) ? data.scopes : [];
  const hasReadScope = scopes.includes('user:read:chat');
  if (!hasReadScope) {
    throw new Error(
      `Twitch access token is missing required scope "user:read:chat". Current scopes: [${scopes.join(', ')}]. Run "pnpm run setup-auth" to update.`
    );
  }

  return {
    userId: data.user_id,
    login: data.login,
    clientId: data.client_id,
    scopes,
    hasWriteScope: scopes.includes('user:write:chat'),
    expiresIn: data.expires_in,
  };
}

/**
 * Resolves a broadcaster's user info by login name via Twitch Helix API.
 *
 * @param {string} clientId
 * @param {string} accessToken
 * @param {string} login
 * @param {object} [options]
 * @returns {Promise<{ id: string, login: string, displayName: string }>}
 */
export async function getBroadcasterByLogin(clientId, accessToken, login, options = {}) {
  const timeoutMs = options.timeoutMs || 30000;
  const cleanLogin = login.replace(/^#/, '').toLowerCase().trim();

  let response;
  try {
    const url = `${TWITCH_USERS_URL}?login=${encodeURIComponent(cleanLogin)}`;
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'Client-Id': clientId,
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error(`Twitch user lookup timed out for channel "${cleanLogin}".`);
    }
    throw new Error(`Failed to lookup channel "${cleanLogin}": ${err.message}`);
  }

  if (response.status === 401) {
    throw new Error('Twitch authentication failed (HTTP 401) during user lookup. Token may be expired.');
  }

  if (!response.ok) {
    throw new Error(`Twitch user lookup failed for "${cleanLogin}" with status ${response.status}.`);
  }

  const data = await response.json();
  if (!data.data || data.data.length === 0) {
    throw new Error(`Twitch channel "${cleanLogin}" was not found.`);
  }

  const user = data.data[0];
  return {
    id: user.id,
    login: user.login,
    displayName: user.display_name,
  };
}
