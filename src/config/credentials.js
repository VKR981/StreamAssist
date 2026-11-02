import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Returns the default configuration directory for credentials.
 */
export function getDefaultConfigDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'twitch-copilot');
  }
  const home = os.homedir();
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(configHome, 'twitch-copilot');
}

/**
 * Returns the default credentials file path.
 */
export function getDefaultCredentialsPath() {
  return path.join(getDefaultConfigDir(), 'credentials.json');
}

/**
 * Returns the resolved path to the credentials file.
 * Prioritizes TWITCH_COPILOT_CONFIG env var.
 */
export function getCredentialsPath() {
  if (process.env.TWITCH_COPILOT_CONFIG && process.env.TWITCH_COPILOT_CONFIG.trim() !== '') {
    return path.resolve(process.env.TWITCH_COPILOT_CONFIG.trim());
  }
  return getDefaultCredentialsPath();
}

/**
 * Normalizes Twitch token by stripping 'oauth:' prefix if present.
 */
function sanitizeToken(token) {
  if (typeof token !== 'string') return '';
  if (token.startsWith('oauth:')) {
    return token.slice(6).trim();
  }
  return token.trim();
}

/**
 * Loads credentials from environment variables or local configuration file.
 *
 * @returns {{ clientId: string, accessToken: string, source: string } | null}
 */
export function loadCredentials() {
  // 1. Check environment variables
  const envClientId = process.env.TWITCH_CLIENT_ID?.trim();
  const envToken = process.env.TWITCH_ACCESS_TOKEN?.trim();

  if (envClientId && envToken) {
    return {
      clientId: envClientId,
      accessToken: sanitizeToken(envToken),
      source: 'environment',
    };
  }

  // 2. Check config file
  const credPath = getCredentialsPath();
  if (fs.existsSync(credPath)) {
    // Refuse symlinks to prevent arbitrary file reading/writing
    const lstats = fs.lstatSync(credPath);
    if (lstats.isSymbolicLink()) {
      throw new Error(`Refusing to load credentials from symbolic link: ${credPath}`);
    }

    // Verify POSIX permissions
    if (process.platform !== 'win32') {
      const mode = lstats.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        try {
          fs.chmodSync(credPath, 0o600);
        } catch {
          throw new Error(
            `Insecure file permissions on ${credPath} (mode: 0${mode.toString(8)}). File must be readable only by owner (0600).`
          );
        }
      }
    }

    let raw;
    try {
      raw = fs.readFileSync(credPath, 'utf8');
    } catch {
      throw new Error(`Failed to read credentials file at ${credPath}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Never include err.message as it may echo token fragments
      throw new Error(`Failed to parse credentials file at ${credPath}: invalid JSON format`);
    }

    if (parsed && typeof parsed.clientId === 'string' && typeof parsed.accessToken === 'string') {
      const cId = parsed.clientId.trim();
      const aTok = sanitizeToken(parsed.accessToken);
      if (cId && aTok) {
        return {
          clientId: cId,
          accessToken: aTok,
          ...(typeof parsed.refreshToken === 'string' ? { refreshToken: parsed.refreshToken } : {}),
          ...(Number.isFinite(parsed.expiresAt) ? { expiresAt: parsed.expiresAt } : {}),
          source: credPath,
        };
      }
    }
  }

  return null;
}

/**
 * Saves credentials securely with 0700 dir (default dir only) and 0600 file permissions.
 * Refuses symlinks.
 *
 * @param {string} clientId
 * @param {string} accessToken
 * @param {string} [customPath]
 */
export function saveCredentials(clientId, accessToken, customPath, metadata = {}) {
  if (!clientId || typeof clientId !== 'string' || !clientId.trim()) {
    throw new Error('Client ID must not be empty');
  }
  if (!accessToken || typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error('Access Token must not be empty');
  }

  const targetPath = customPath ? path.resolve(customPath) : getDefaultCredentialsPath();
  const isCustom = targetPath !== getDefaultCredentialsPath();
  const targetDir = path.dirname(targetPath);

  // If target already exists, refuse symlinks
  if (fs.existsSync(targetPath)) {
    const lstats = fs.lstatSync(targetPath);
    if (lstats.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symbolic link credentials file: ${targetPath}`);
    }
  }

  // If creating default directory, secure it with 0700
  if (!isCustom) {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    }
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(targetDir, 0o700);
      } catch {
        // non-fatal
      }
    }
  } else {
    // For custom paths, ensure parent directory exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
  }

  const payload = JSON.stringify(
    {
      clientId: clientId.trim(),
      accessToken: sanitizeToken(accessToken),
      ...(typeof metadata.refreshToken === 'string' && metadata.refreshToken ? { refreshToken: metadata.refreshToken } : {}),
      ...(Number.isFinite(metadata.expiresAt) ? { expiresAt: metadata.expiresAt } : {}),
      updatedAt: new Date().toISOString(),
    },
    null,
    2
  );

  // Write file with 0600 mode
  fs.writeFileSync(targetPath, payload, { mode: 0o600, encoding: 'utf8' });

  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(targetPath, 0o600);
    } catch {
      throw new Error(`Failed to secure credentials file permissions (0600) at ${targetPath}`);
    }
  }

  return targetPath;
}

/**
 * Safe status display that never reveals token content or partial characters.
 */
export function getCredentialStatus() {
  try {
    const creds = loadCredentials();
    if (!creds) {
      return { configured: false, source: null };
    }
    return {
      configured: true,
      source: creds.source === 'environment' ? 'environment' : 'config_file',
      clientId: creds.clientId,
      tokenConfigured: true,
    };
  } catch {
    return { configured: false, error: 'Failed to load credentials safely' };
  }
}
