// ── Campaign log extractor ─────────────────────────────────────────────────
// After each DM1 response, asks Haiku whether anything story-defining happened.
// If yes, saves a one-to-two sentence entry to the campaign_log table.
// Also triggers compression if the 60-entry cap is reached (handled in db.js).
// All failures are silent — the game continues unchanged.

require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const db                   = require('./db');
const { HAIKU }            = require('./models');
const { retryWithBackoff } = require('./retryUtils');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a campaign historian for a D&D 5e adventure game.
Given a player action and the DM's narrative response, determine if anything story-defining happened.

Story-defining events include:
- A significant decision by the player with lasting consequences
- A deal, oath, or agreement made with an NPC
- A major NPC introduced, killed, or whose relationship changed significantly
- A revelation, prophecy, or discovery that changes the stakes
- A character death, near-death, or significant injury
- A faction's attitude toward the player changing in a lasting way

Routine events (moving between rooms, standard combat turns, mundane dialogue) are NOT story-defining.

If something story-defining happened, respond with:
{"notable": true, "summary": "One to two sentence summary of the notable event."}

If nothing notable happened, respond with:
{"notable": false}

Return ONLY valid JSON. No markdown, no explanation, no code blocks.`;

/**
 * Extract a campaign log entry from a DM1 exchange and save it if notable.
 * Silent failure — never throws.
 *
 * @param {string} sessionId
 * @param {string} playerMessage
 * @param {string} dm1Reply
 * @param {number} turnNumber  — the session_turn value after increment
 */
async function extract(sessionId, playerMessage, dm1Reply, turnNumber) {
  try {
    const userContent = `Player action: ${playerMessage}\n\nDM response: ${dm1Reply}`;

    const response = await retryWithBackoff(() => anthropic.messages.create({
      model:      HAIKU,
      max_tokens: 256,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userContent }],
    }));

    const rawText = response.content[0].text.trim();

    // Log regardless of outcome
    await db.logDmCall({
      sessionId,
      dm:           'campaign_log',
      model:        HAIKU,
      playerInput:  playerMessage,
      fullPrompt:   SYSTEM_PROMPT + '\n\n' + userContent,
      dmResponse:   rawText,
      inputTokens:  response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    }).catch(() => {});

    // Parse result
    let result;
    try {
      const cleaned = rawText.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '');
      result = JSON.parse(cleaned);
    } catch {
      console.warn('campaignLogExtractor: JSON parse failed, skipping entry');
      return;
    }

    if (result?.notable && result?.summary) {
      await db.addCampaignLogEntry(sessionId, turnNumber, result.summary);
    }

  } catch (err) {
    // Silent failure per spec §12
    console.error('campaignLogExtractor error (silent):', err.message);
  }
}

module.exports = { extract };
