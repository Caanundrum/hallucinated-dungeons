// ── Retry utility ──────────────────────────────────────────────────────────
// Wraps an async function with exponential backoff retry logic for transient
// Anthropic API errors (HTTP 429 Too Many Requests, 529 Overloaded).

/**
 * Call fn(), retrying on 429/529 with exponential backoff.
 *
 * @param {Function} fn           - async function to call (no args; use closure)
 * @param {object}   opts
 * @param {number}   opts.maxAttempts  - total attempts including the first (default 3)
 * @param {number}   opts.baseDelayMs - delay before attempt 2, in ms (default 1000)
 *                                      attempt 3 waits baseDelayMs * 2, etc.
 * @returns {Promise} resolved value of fn()
 * @throws  last error if all attempts are exhausted or error is non-retryable
 */
async function retryWithBackoff(fn, { maxAttempts = 3, baseDelayMs = 1000 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status ?? err.statusCode;
      const isRetryable = status === 429 || status === 529;

      if (!isRetryable || attempt === maxAttempts) {
        throw err;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * baseDelayMs);
      console.warn(
        `retryWithBackoff: attempt ${attempt}/${maxAttempts} got HTTP ${status}, ` +
        `retrying in ${delayMs}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

module.exports = { retryWithBackoff };
