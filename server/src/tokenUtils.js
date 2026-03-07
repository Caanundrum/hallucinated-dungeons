// ── Token utilities ────────────────────────────────────────────────────────
// Lightweight token estimation using length/4 (accurate to ~10-15%).
// Exact counts from API usage objects are stored in dm_logs.

/**
 * Estimate token count for a string.
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

module.exports = { estimateTokens };
