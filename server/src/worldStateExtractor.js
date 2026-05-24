// ── World state extractor ──────────────────────────────────────────────────
// After each DM1 response, asks the utility model to extract a JSON patch of world state
// changes and merges it into the persisted state using the explicit per-field
// merge strategy from spec Section 5.2 (Phase 2) and Section 5.2 (Phase 3).
// All failures are silent — the game continues unchanged.

const ai                   = require('./aiClient');
const db                   = require('./db');
const { UTILITY_MODEL }    = require('./models');
const { retryWithBackoff } = require('./retryUtils');

const SYSTEM_PROMPT = `You are a world state extractor for a D&D 5e adventure game.
Given a player action and the DM's narrative response, extract any changes to the world state as a JSON patch.

Return ONLY the fields that changed. Do not include unchanged fields.

Available fields:

BASIC FIELDS:
- current_location: string (new location name if the player moved)
- scene_presence: object (FULL current visible scene, updated after every DM response if the scene is established)
- locations_visited: string[] (NEW location names to add — not the full list)
- npcs_encountered: object[] (NEW or UPDATED NPCs only: { name, disposition, last_seen })
- story_flags: object (new or updated flag keys only: { "flag_name": value })
- active_quest: string (new quest description if the active quest changed)
- time_state: object (changed practical time tracking: { "elapsed_rounds": number, "elapsed_minutes": number, "scene_time": string })
- active_effects: object[] (FULL current active magical/status effects array; use [] when none remain)

SCENE PRESENCE (scene_presence):
Return this as the FULL current scene whenever the DM response establishes or changes what is physically present.
This is the spatial source of truth for the next player action.
{
  "exact_location": "<specific location, e.g. Brackenford town gate, Ma Venn's taproom, old cellar>",
  "location_type": "<gate|street|tavern|shop|temple|forest|cellar|room|road|other>",
  "present_npcs": ["<NPCs visibly present or directly reachable right now>"],
  "present_objects": ["<objects, doors, counters, chests, signs, terrain features visibly present or reachable right now>"],
  "available_exits": ["<obvious exits or paths from here, e.g. town road, inn, forest path>"],
  "nearby_locations": ["<known nearby places not currently occupied, e.g. inn, smithy, temple, market>"]
}
Do not list NPCs, objects, or rooms merely because the player mentioned them. Only include what the DM response actually establishes as present or reachable.
If the DM response introduces a visible thing with a descriptive phrase, preserve useful aliases in the visible scene. Examples:
- "a notice board with missing-person notices and a charcoal bell scrap" means present_objects should include "notice board", "missing-person notice", and "charcoal bell scrap".
- "a lantern-figure", "hooded stranger", or "stranger under the awning" should be present_npcs with a stable usable name such as "hooded stranger" or "lantern-figure".
- If a DM response says houses, doors, a lit doorway, or a figure are directly reachable in the current lane, include those in present_objects or present_npcs for the next player action.

PLAYER STATS (player_stats):
Extract only the fields that changed. Use the HP narration standard "(before → after HP)" as your primary signal for hp changes.
- player_stats.name: string (player character's name, if mentioned)
- player_stats.class: string (player class, e.g. "Fighter", "Wizard")
- player_stats.level: integer (player level, if established or levelled up)
- player_stats.hp: integer (current HP — look for "(X → Y HP)" notation in DM narration)
- player_stats.max_hp: integer (maximum HP, if established or changed)
- player_stats.temp_hp: integer (temporary HP if gained or lost)
- player_stats.armor_class: integer (AC, if established or changed)
- player_stats.speed: integer (movement speed in feet, if changed by a condition or effect)
- player_stats.conditions: string[] (FULL current conditions array — replace entirely, do not append. Use [] if no conditions remain.)
- player_stats.spell_slots: object (changed slot levels only — e.g. {"1": 2} means level-1 slots now at 2)
- player_stats.death_saves: object (current totals — e.g. {"successes": 1, "failures": 0})
- player_stats.weapon_name: string (primary weapon name if mentioned or established — e.g. "longsword", "shortbow", "dagger")
- player_stats.ability_scores: object (ability modifiers as integers, only update if established — e.g. {"str": 3, "dex": 1, "con": 2, "int": -1, "wis": 0, "cha": 1}. Use modifier values not raw scores. Key-merge: only include ability keys that changed or were established.)

TIME AND ACTIVE EFFECTS:
Track practical D&D time when the DM response advances rounds, travel, searching, rests, spell durations, or scene time.
In combat, one round is about 6 seconds. Outside combat, estimate elapsed minutes from the narration.
active_effects schema:
[
  {
    "id": "<stable effect id, e.g. shield_of_faith>",
    "name": "<effect/spell name>",
    "source": "<caster or source>",
    "target": "<affected creature/object>",
    "duration": "<listed duration, e.g. 1 minute>",
    "remaining_rounds": <integer or null>,
    "remaining_minutes": <number or null>,
    "concentration": <boolean>,
    "mechanical_effect": "<plain effect, e.g. +2 AC>"
  }
]
Return active_effects as the FULL current array whenever an effect starts, ends, or duration changes. Use [] if all effects end.

COMBAT STATE (combat_state):
When combat is active, return the FULL updated combat_state object (full replace — never partial).
When combat ends (DM narration indicates all enemies defeated, fled, or surrendered), return combat_state: null.
When there is no combat and no combat change, omit combat_state entirely.

combat_state schema:
{
  "active": true,
  "round": <integer>,
  "turn_index": <integer>,
  "combatants": [
    {
      "name": "<string>",
      "initiative": <integer>,
      "initiative_group": "<string — monster group label, e.g. 'Goblins'; omit for player and unique NPCs>",
      "hp": <integer>,
      "max_hp": <integer>,
      "ac": <integer>,
      "conditions": ["<condition name>"],
      "is_player": <boolean>
    }
  ]
}

MERGE RULES:
- current_location: replace
- scene_presence: full replace when provided. If exact_location is omitted but current_location is known, use current_location as exact_location.
- locations_visited: append new values only
- npcs_encountered: upsert by name
- story_flags: key-merge (never replace entire object)
- active_quest: replace
- time_state: key-merge (only include changed keys)
- active_effects: FULL REPLACE when provided; OMIT if unchanged
- player_stats: key-merge (only include fields that changed)
- player_stats.conditions: FULL REPLACE — return the complete current conditions array
- player_stats.spell_slots: key-merge (only changed slot levels)
- player_stats.weapon_name: replace if established or changed
- player_stats.ability_scores: key-merge (only include ability keys that were established or changed)
- combat_state: FULL REPLACE when combat changes; null when combat ends; OMIT if unchanged

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

    const response = await retryWithBackoff(() => ai.generateText({
      model:     UTILITY_MODEL,
      maxTokens: 768,
      system:    SYSTEM_PROMPT,
      messages:  [{ role: 'user', content: userContent }],
    }));

    const rawText = response.text.trim();

    // Log the extraction call
    await db.logDmCall({
      sessionId,
      dm:           'world_state',
      model:        UTILITY_MODEL,
      playerInput:  playerMessage,
      fullPrompt:   SYSTEM_PROMPT + '\n\n' + userContent,
      dmResponse:   rawText,
      inputTokens:  response.inputTokens,
      outputTokens: response.outputTokens,
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

    // Apply per-field merge strategy (spec §5.2 Phase 2 + Phase 3)
    const newState = mergeWorldState(currentState, patch);
    await db.updateWorldState(sessionId, newState);

  } catch (err) {
    // Silent failure per spec §12
    console.error('worldStateExtractor error (silent):', err.message);
  }
}

// ── Merge strategy ─────────────────────────────────────────────────────────

/**
 * Merge a utility-model-returned patch into the current world state.
 * NEVER uses naive Object.assign() or spread on top-level — each field has its
 * own merge rule to prevent wiping arrays. (spec §5.2 Phase 2 + Phase 3)
 */
function mergeWorldState(current, patch) {
  const merged = { ...current };

  // current_location — replace
  if (patch.current_location !== undefined && patch.current_location !== null) {
    merged.current_location = patch.current_location;
  }

  // scene_presence - full replace when provided.
  if (patch.scene_presence && typeof patch.scene_presence === 'object' && !Array.isArray(patch.scene_presence)) {
    const currentScene = merged.scene_presence || db.DEFAULT_WORLD_STATE.scene_presence;
    merged.scene_presence = normalizeScenePresence({
      ...currentScene,
      ...patch.scene_presence,
      exact_location: patch.scene_presence.exact_location || patch.current_location || currentScene.exact_location || merged.current_location || '',
    });
    if (!merged.current_location && merged.scene_presence.exact_location) {
      merged.current_location = merged.scene_presence.exact_location;
    }
  } else if (
    patch.current_location !== undefined
    && patch.current_location !== null
    && (!merged.scene_presence || !merged.scene_presence.exact_location)
  ) {
    merged.scene_presence = normalizeScenePresence({
      ...(merged.scene_presence || db.DEFAULT_WORLD_STATE.scene_presence),
      exact_location: patch.current_location,
    });
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

  // session_turn — NEVER set by the utility model; always managed by backend (preserved via spread above)

  // ── Phase 3 fields ────────────────────────────────────────────────────

  // player_stats — key-merge with sub-field rules
  if (patch.time_state && typeof patch.time_state === 'object' && !Array.isArray(patch.time_state)) {
    merged.time_state = { ...(merged.time_state || db.DEFAULT_WORLD_STATE.time_state), ...patch.time_state };
  }

  if (Array.isArray(patch.active_effects)) {
    const currentEffects = Array.isArray(merged.active_effects) ? merged.active_effects : [];
    merged.active_effects = patch.active_effects.map((effect) => {
      const existing = currentEffects.find((current) => current.id === effect.id);
      return existing
        ? { ...existing, ...effect, rules_effects: effect.rules_effects || existing.rules_effects }
        : effect;
    });
  }

  if (patch.player_stats && typeof patch.player_stats === 'object' && !Array.isArray(patch.player_stats)) {
    const currentStats = merged.player_stats || db.DEFAULT_WORLD_STATE.player_stats;
    const patchStats   = patch.player_stats;

    const newStats = { ...currentStats };

    // Scalar fields — replace if present
    for (const scalar of ['name', 'class', 'level', 'hp', 'max_hp', 'temp_hp', 'armor_class', 'base_armor_class', 'speed', 'weapon_name']) {
      if (patchStats[scalar] !== undefined && patchStats[scalar] !== null) {
        newStats[scalar] = patchStats[scalar];
      }
    }

    // ability_scores — key-merge (only update established ability modifier keys)
    if (patchStats.ability_scores && typeof patchStats.ability_scores === 'object' && !Array.isArray(patchStats.ability_scores)) {
      newStats.ability_scores = { ...(currentStats.ability_scores || {}), ...patchStats.ability_scores };
    }

    // conditions — full replace if provided (never append)
    if (Array.isArray(patchStats.conditions)) {
      newStats.conditions = patchStats.conditions;
    }

    // spell_slots — key-merge (only changed levels)
    if (patchStats.spell_slots && typeof patchStats.spell_slots === 'object' && !Array.isArray(patchStats.spell_slots)) {
      newStats.spell_slots = { ...(currentStats.spell_slots || {}), ...patchStats.spell_slots };
    }

    // death_saves — key-merge
    if (patchStats.death_saves && typeof patchStats.death_saves === 'object') {
      newStats.death_saves = { ...(currentStats.death_saves || { successes: 0, failures: 0 }), ...patchStats.death_saves };
    }

    merged.player_stats = newStats;
  }

  // combat_state — full replace or null
  // The utility model either returns the full updated object, null, or omits it entirely.
  if ('combat_state' in patch) {
    if (patch.combat_state === null) {
      merged.combat_state = null;
    } else if (patch.combat_state && typeof patch.combat_state === 'object') {
      merged.combat_state = patch.combat_state;
    }
  }

  // active:false → null transition (spec §5.3)
  // If the utility model returned a combat_state with active:false, collapse it to null immediately.
  // Do not persist an active:false intermediate state to Supabase.
  if (merged.combat_state && merged.combat_state.active === false) {
    merged.combat_state = null;
  }

  return merged;
}

function normalizeScenePresence(scene) {
  return {
    exact_location: String(scene.exact_location || ''),
    location_type: String(scene.location_type || ''),
    present_npcs: normalizeStringList(scene.present_npcs),
    present_objects: normalizeStringList(scene.present_objects),
    available_exits: normalizeStringList(scene.available_exits),
    nearby_locations: normalizeStringList(scene.nearby_locations),
  };
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

module.exports = { extract, mergeWorldState };
