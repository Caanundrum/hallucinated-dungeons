// ── World state extractor ──────────────────────────────────────────────────
// After each DM1 response, asks Haiku to extract a JSON patch of world state
// changes and merges it into the persisted state using the explicit per-field
// merge strategy from spec Section 5.2.
// All failures are silent — the game continues unchanged.

require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const db        = require('./db');
const { HAIKU } = require('./models');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a world state extractor for a D&D 5e adventure game.
Given a player action and the DM's narrative response, extract any changes to the world state as a JSON patch.

Return ONLY the fields that changed. Do not include unchanged fields.
Available fields:
- current_location: string (new location name if the player moved)
- locations_visited: string[] (NEW location names to add — not the full list)
- npcs_encountered: object[] (NEW or UPDATED NPCs only: { name, disposition, last_seen })
- story_flags: object (new or updated flag keys only: { "flag_name": value })
- active_quest: string (new quest description if the active quest changed)

If nothing changed, return: {}
Return ONLY valid JSON. No markdown, no explanation, no code blocks.`;

/**
 * Extract world state changes from a DM1 exchange and apply them to the DB.
 * Silent failure — never throws.
 */
async function extract(sessionId, playerMessage, dm1Reply) {
  try {
    const worldStateRow = await db.getWorldState(sessionId);
    const currentState  = worldStateRow?.state || db.DEFAULT_WORLD_STATE;

    const userContent = [
      `Player action: ${playerMessage}`,
      `DM response: ${dm1Reply}`,
      `Current world state: ${JSON.stringify(currentState)}`,
    ].join('\n\n');

    const response = await anthropic.messages.create({
      model:      HAIKU,
      max_tokens: 512,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userContent }],
    });

    const rawText = response.content[0].text.trim();

    // Log the extraction call
    await db.logDmCall({
      sessionId,
      dm:           'world_state',
      model:        HAIKU,
      playerInput:  playerMessage,
      fullPrompt:   SYSTEM_PROMPT + '\n\n' + userContent,
      dmResponse:   rawText,
      inputTokens:  response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    }).catch(() => {});

    // Parse JSON patch
    let patch;
    try {
      const cleaned = rawText.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '');
      patch = JSON.parse(cleaned);
    } catch {
      console.warn('worldStateExtractor: JSON parse failed, skipping update');
      return;
    }

    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
    if (Object.keys(patch).length === 0) return; // nothing changed

    // Apply per-field merge strategy (spec §5.2)
    const newState = mergeWorldState(currentState, patch);
    await db.updateWorldState(sessionId, newState);

  } catch (err) {
    // Silent failure per spec §12
    console.error('worldStateExtractor error (silent):', err.message);
  }
}

// ── Merge strategy ─────────────────────────────────────────────────────────

/**
 * Merge a Haiku-returned patch into the current world state.
 * NEVER uses naive Object.assign() on the full state — each field has its own
 * merge rule to prevent wiping arrays. (spec §5.2)
 */
function mergeWorldState(current, patch) {
  const merged = { ...current };

  // current_location — replace
  if (patch.current_location !== undefined && patch.current_location !== null) {
    merged.current_location = patch.current_location;
  }

  // locations_visited — append + deduplicate
  if (Array.isArray(patch.locations_visited) && patch.locations_visited.length > 0) {
    const existing = new Set(merged.locations_visited || []);
    for (const loc of patch.locations_visited) {
      if (loc) existing.add(loc);
    }
    merged.locations_visited = [...existing];
  }

  // npcs_encountered — append new NPCs or update existing by name
  if (Array.isArray(patch.npcs_encountered) && patch.npcs_encountered.length > 0) {
    const npcMap = {};
    for (const npc of (merged.npcs_encountered || [])) {
      if (npc?.name) npcMap[npc.name] = { ...npc };
    }
    for (const npc of patch.npcs_encountered) {
      if (!npc?.name) continue;
      if (npcMap[npc.name]) {
        npcMap[npc.name] = { ...npcMap[npc.name], ...npc };
      } else {
        npcMap[npc.name] = npc;
      }
    }
    merged.npcs_encountered = Object.values(npcMap);
  }

  // story_flags — key-merge (never replace the whole object)
  if (patch.story_flags && typeof patch.story_flags === 'object' && !Array.isArray(patch.story_flags)) {
    merged.story_flags = { ...(merged.story_flags || {}), ...patch.story_flags };
  }

  // active_quest — replace if provided
  if (patch.active_quest !== undefined && patch.active_quest !== null) {
    merged.active_quest = patch.active_quest;
  }

  // session_turn — NEVER set by Haiku; always managed by backend (preserved via spread above)

  return merged;
}

module.exports = { extract };
