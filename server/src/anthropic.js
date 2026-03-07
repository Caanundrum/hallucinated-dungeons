// ── Shared Anthropic client singleton ──────────────────────────────────────
// All server modules import this instead of instantiating their own client.
// dotenv is loaded in index.js (line 1) before any require() calls, so
// process.env.ANTHROPIC_API_KEY is guaranteed to be set when this module loads.

const Anthropic = require('@anthropic-ai/sdk');

module.exports = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
