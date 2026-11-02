/**
 * Structured chat message filtering engine.
 * Viewer text is treated as strictly untrusted string data.
 * Viewer inputs are NEVER compiled into regular expressions (prevents ReDoS).
 */

const COMMON_QUESTION_WORDS = new Set([
  'what', "what's", 'how', "how's", 'why', 'where', "where's", 'when',
  'who', "who's", 'which', 'can', 'could', 'would', 'should', 'is', 'are',
  'do', 'does', 'did', 'will', 'have', 'has', 'anyone', 'anybody'
]);

/**
 * Validates that an Ollama endpoint is strictly a local loopback HTTP URL.
 * Prevents SSRF attacks.
 */
export function validateLoopbackUrl(endpoint) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`Invalid semantic filter endpoint: "${endpoint}" is not a valid URL.`);
  }

  if (parsed.protocol !== 'http:') {
    throw new Error(`Invalid semantic filter endpoint: protocol must be "http:", got "${parsed.protocol}"`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  if (!isLoopback) {
    throw new Error(`Invalid semantic filter endpoint: must target local loopback (127.0.0.1 or localhost), got "${hostname}"`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('Invalid semantic filter endpoint: user credentials in URL are forbidden.');
  }

  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Normalizes text for comparison without regex injection.
 */
function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text.toLowerCase().trim();
}

/**
 * Checks if a string contains a word/substring safely without RegExp.
 */
function containsKeyword(normalizedText, keyword) {
  const normKey = normalizeText(keyword);
  if (!normKey) return false;
  return normalizedText.includes(normKey);
}

/**
 * Determines whether a message text represents a question.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isQuestion(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  // Ends with question mark (handles multiple punctuation e.g. ??? or ?!)
  if (/[?？]+$/.test(trimmed)) {
    return true;
  }

  // Check if first word indicates a question
  const words = trimmed.toLowerCase().split(/\s+/);
  if (words.length > 0 && COMMON_QUESTION_WORDS.has(words[0].replace(/[^a-z']/g, ''))) {
    return true;
  }

  return false;
}

/**
 * Class representing the active chat filter configuration.
 */
export class MessageFilter {
  /**
   * @param {object} [config]
   * @param {string[]} [config.include_keywords]
   * @param {string[]} [config.exclude_keywords]
   * @param {boolean} [config.questions_only]
   * @param {string[]} [config.command_prefixes]
   * @param {{ enabled: boolean, model?: string, prompt?: string, endpoint?: string }} [config.semantic_filter]
   */
  constructor(config = {}) {
    this.includeKeywords = (config.include_keywords || []).map(s => String(s).trim()).filter(Boolean);
    this.excludeKeywords = (config.exclude_keywords || []).map(s => String(s).trim()).filter(Boolean);
    this.questionsOnly = Boolean(config.questions_only);
    this.commandPrefixes = (config.command_prefixes || []).map(s => String(s).trim()).filter(Boolean);

    this.semanticFilter = { enabled: false };
    if (config.semantic_filter?.enabled) {
      this._setSemanticFilter(config.semantic_filter);
    }

    // Mutex queue to serialize and bound async semantic model evaluations
    this._semanticQueue = Promise.resolve();
    this._pendingSemantic = 0;
    this.revision = 0;
  }

  _setSemanticFilter(cfg) {
    const endpoint = validateLoopbackUrl(cfg.endpoint || 'http://127.0.0.1:11434');
    const model = (cfg.model || 'llama3.2').trim();
    if (!model || /[\r\n\0]/.test(model)) {
      throw new Error('Invalid model name specified for semantic filter.');
    }

    this.semanticFilter = {
      enabled: Boolean(cfg.enabled),
      model,
      prompt: cfg.prompt || 'Is this viewer chat message asking a relevant question about coding, setup, or stream topics? Answer YES or NO.',
      endpoint,
    };
  }

  /**
   * Updates filter configuration.
   */
  update(config = {}) {
    // Validate the whole semantic configuration before mutating any active rule.
    const semantic = config.semantic_filter !== undefined
      ? new MessageFilter({ semantic_filter: config.semantic_filter }).semanticFilter
      : this.semanticFilter;
    if (config.include_keywords !== undefined) {
      this.includeKeywords = config.include_keywords.map(s => String(s).trim()).filter(Boolean);
    }
    if (config.exclude_keywords !== undefined) {
      this.excludeKeywords = config.exclude_keywords.map(s => String(s).trim()).filter(Boolean);
    }
    if (config.questions_only !== undefined) {
      this.questionsOnly = Boolean(config.questions_only);
    }
    if (config.command_prefixes !== undefined) {
      this.commandPrefixes = config.command_prefixes.map(s => String(s).trim()).filter(Boolean);
    }
    this.semanticFilter = semantic;
    this.revision++;
  }

  /**
   * Synchronously evaluates fast structural filters.
   *
   * @param {object} message
   * @param {string} message.text
   * @returns {{ match: boolean, reason?: string }}
   */
  matchesBasic(message) {
    const rawText = message?.text || '';
    const norm = normalizeText(rawText);

    // 1. Exclude keywords check
    for (const kw of this.excludeKeywords) {
      if (containsKeyword(norm, kw)) {
        return { match: false, reason: `Matches exclude keyword: "${kw}"` };
      }
    }

    // 2. Command prefix check (if prefixes specified, message must start with one)
    if (this.commandPrefixes.length > 0) {
      const trimmedText = rawText.trim();
      const hasPrefix = this.commandPrefixes.some(prefix => trimmedText.startsWith(prefix));
      if (!hasPrefix) {
        return { match: false, reason: `Does not match any required prefix [${this.commandPrefixes.join(', ')}]` };
      }
    }

    // 3. Questions-only check
    if (this.questionsOnly && !isQuestion(rawText)) {
      return { match: false, reason: 'Questions-only filter active and message is not a question' };
    }

    // 4. Include keywords check (if specified, at least one must match)
    if (this.includeKeywords.length > 0) {
      const matched = this.includeKeywords.some(kw => containsKeyword(norm, kw));
      if (!matched) {
        return { match: false, reason: `Does not match any include keywords [${this.includeKeywords.join(', ')}]` };
      }
    }

    return { match: true };
  }

  /**
   * Asynchronously evaluates the message.
   * If semantic filter is enabled, serializes the check to prevent unbounded parallel model requests.
   * If semantic evaluation errors, FAILS CLOSED with explicit error (does NOT pass message as match).
   *
   * @param {object} message
   * @returns {Promise<{ match: boolean, reason?: string, semanticEvaluated?: boolean }>}
   */
  async matches(message) {
    const basicResult = this.matchesBasic(message);
    if (!basicResult.match) {
      return basicResult;
    }

    if (!this.semanticFilter.enabled) {
      return { match: true };
    }

    if (this._pendingSemantic >= 20) throw new Error('Semantic filter queue full; message skipped. Narrow the filter or use a faster model.');
    const revision = this.revision;
    this._pendingSemantic++;
    const result = this._semanticQueue.then(async () => {
      if (revision !== this.revision) throw new Error('Filter changed while this message was queued; message skipped.');
      const match = await this.evaluateSemantic(message.text);
      if (revision !== this.revision) throw new Error('Filter changed during classification; message skipped.');
      return match;
    });
    this._semanticQueue = result.catch(() => {});
    try { return await result; } finally { this._pendingSemantic--; }
  }

  /**
   * Evaluates text using local Ollama model.
   * Enforces strict YES/NO parsing and fail-closed security.
   */
  async evaluateSemantic(text) {
    const { endpoint, model, prompt } = this.semanticFilter;
    const url = `${endpoint}/api/generate`;

    // Treat viewer text strictly as data in prompt JSON payload
    const systemInstruction = `${prompt}\nRespond with strictly the word YES or NO. Do not add explanations or punctuation.`;
    const userMessageContent = `[UNTRUSTED_VIEWER_MESSAGE_DATA_START]\n${String(text || '').slice(0, 500)}\n[UNTRUSTED_VIEWER_MESSAGE_DATA_END]`;

    let response;
    try {
      response = await fetch(url, {
        redirect: 'error',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: `${systemInstruction}\n\n${userMessageContent}\nDecision:`,
          stream: false,
          options: { temperature: 0.0, num_predict: 5 }
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch (err) {
      throw new Error(
        `Semantic filter error: failed to connect to local Ollama at ${url} (model: ${model}). ` +
        `Ensure Ollama is running ('ollama serve') and model is pulled, or disable semantic_filter. (${err.message})`
      );
    }

    if (!response.ok) {
      throw new Error(`Semantic filter error: Ollama returned HTTP ${response.status}`);
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('Semantic filter error: failed to parse Ollama JSON response');
    }

    const rawAnswer = (data.response || '').trim();
    // Strict YES / NO checking without loose substring matching
    if (/^YES\b/i.test(rawAnswer)) {
      return { match: true, reason: 'Semantic filter approved', semanticEvaluated: true };
    } else if (/^NO\b/i.test(rawAnswer)) {
      return { match: false, reason: 'Semantic filter rejected: message not deemed relevant', semanticEvaluated: true };
    } else {
      // Model returned ambiguous/invalid response - fail closed
      throw new Error(`Semantic filter error: model returned non-YES/NO response: "${rawAnswer.slice(0, 50)}"`);
    }
  }

  toJSON() {
    return {
      include_keywords: this.includeKeywords,
      exclude_keywords: this.excludeKeywords,
      questions_only: this.questionsOnly,
      command_prefixes: this.commandPrefixes,
      semantic_filter: {
        enabled: this.semanticFilter.enabled,
        model: this.semanticFilter.model || null,
        endpoint: this.semanticFilter.endpoint || null,
      },
    };
  }
}
