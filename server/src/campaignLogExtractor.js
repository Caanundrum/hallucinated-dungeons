// ── Campaign log extractor ─────────────────────────────────────────────────
// After each DM1 response, asks Haiku whether anything story-defining happened.
// If yes, saves a one-to-two sentence entry to the campaign_log table.
// Also triggers AI-powered compression if the 60-entry cap is reached (BUG-015).
// All failures are silent — the game continues unchanged.

const anthropic            = require('./anthropic');
const db                   = require('./db');
const { HAIKU }            = require('./models');
const { retryWithBackoff } = require('./retryUtils');

const NOTABILITY_SYSTEM_PROMPT = `You are a campaign historian for a D&D 5e adventure game.
Given a player action, the DM's narrative response, and the current world state, determine if anything story-defining happened.

Story-defining events include:
- A significant decision by the player with lasting consequences
- A deal, oath, or agreement made with an NPC
- A major NPC introduced for the first time, killed, or whose relationship changed significantly
- A revelation, prophecy, or discovery that changes the stakes
- A character death, near-death, or significant injury
- A faction's attitude toward the player changing in a lasting way

Routine events (moving between rooms, standard combat turns, mundane dialogue, re-encountering already-known NPCs without change) are NOT story-defining.

Use the current world state to distinguish first-time events from repeated ones (e.g. an NPC already in npcs_encountered is not "newly introduced").

If something story-defining happened, respond with:
{"notable": true, "summary": "One to two sentence summary of the notable event."}

If nothing notable happened, respond with:
{"notable": false}

Return ONLY valid JSON. No markdown, no explanation, no code blocks.`;

const COMPRESSION_SYSTEM_PROMPT = `You are a campaign archivist for a D&D 5e adventure game.
Given a sequence of campaign log entries, write a concise two-to-three sentence narrative summary that captures the most important story beats, decisions, and events.

Write in past tense, third person. Preserve names, locations, and key outcomes. Do not list every entry — synthesize into a readable summary.
Return ONLY the summary paragraph. No JSON, no labels, no markdown.`;

/**
 * Extract a campaign log entry from a DM1 exchange and save it if notable.
 * After saving, check entry count and trigger AI compression if cap is reached.
 * Silent failure — never throws.
 *
 * @param {string} sessionId
 * @param {string} playerMessage
 * @param {string} dm1Reply
 * @param {number} turnNumber  — the session_turn value after increment
 */
async function extract(sessionId, playerMessage, dm1Reply, turnNumber) {
  try {
    // Fetch current world state for context (BUG-016)
    const worldStateRow = await db.getWorldState(sessionId).catch(() => null);
    const worldState    = worldStateRow?.state || db.DEFAULT_WORLD_STATE;

    const worldContext = JSON.stringify({
      current_location:  worldState.current_location,
      npcs_encountered:  worldState.npcs_encountered,
      story_flags:       worldState.story_flags,
      active_quest:      worldState.active_quest,
    });

    const userContent = [
      `Player action: ${playerMessage}`,
      `DM response: ${dm1Reply}`,
      `Current world state: ${worldContext}`,
    ].join('\n\n');

    const response = await retryWithBackoff(() => anthropic.messages.create({
      model:      HAIKU,
      max_tokens: 256,
      system:     NOTABILITY_SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userContent }],
    }));

    const rawText = response.content[0].text.trim();

    // Log regardless of outcome
    await db.logDmCall({
      sessionId,
      dm:           'campaign_log',
      model:        HAIKU,
      playerInput:  playerMessage,
      fullPrompt:   NOTABILITY_SYSTEM_PROMPT + '\n\n' + userContent,
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

      // Check cap and compress if needed (BUG-015)
      await compressIfNeeded(sessionId);
    }

  } catch (err) {
    // Silent failure per spec §12
    console.error('campaignLogExtractor error (silent):', err.message);
  }
}

// ── AI-powered compression ─────────────────────────────────────────────────

/**
 * If the campaign log has reached the 60-entry cap, compress the oldest 10
 * entries into a single AI-generated archive entry.
 * Silent failure — never throws.
 */
async function compressIfNeeded(sessionId) {
  try {
    const count = await db.getCampaignLogCount(sessionId);
    if (count < 60) return;

    const entries = await db.getOldestCampaignEntries(sessionId, 10);
    if (entries.length === 0) return;

    const entriesText = entries.map((e, i) => `${i + 1}. ${e.summary}`).join('\n');

    const response = await retryWithBackoff(() => anthropic.messages.create({
      model:      HAIKU,
      max_tokens: 256,
      system:     COMPRESSION_SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: `Campaign log entries to archive:\n\n${entriesText}` }],
    }));

    const archiveSummary = response.content[0].text.trim();

    await db.logDmCall({
      sessionId,
      dm:           'campaign_log_compress',
      model:        HAIKU,
      playerInput:  null,
      fullPrompt:   COMPRESSION_SYSTEM_PROMPT + '\n\nCampaign log entries to archive:\n\n' + entriesText,
      dmResponse:   archiveSummary,
      inputTokens:  response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    }).catch(() => {});

    await db.compressCampaignLog(sessionId, entries, archiveSummary);

  } catch (err) {
    // Silent failure per spec §12
    console.error('campaignLogExtractor compressIfNeeded error (silent):', err.message);
  }
}

module.exports = { extract };
