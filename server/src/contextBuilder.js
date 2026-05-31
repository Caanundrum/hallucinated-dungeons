// ── DM1 context assembler ──────────────────────────────────────────────────
// Builds the system prompt and messages array for each DM1 API call.
// Implements the three-tier memory system (spec Section 4) and token
// budget trimming (spec Section 7.3).

const db             = require('./db');
const { estimateTokens } = require('./tokenUtils');
const { getContentBundle, byId } = require('./contentData');
const { filterActivePartyPresenceRows } = require('./partyPresence');
const { buildRulesContext, summarizeRulesContextForPrompt } = require('./rulesContext');

const TOKEN_BUDGET = 8000; // trim if total estimated input exceeds this
const CAMPAIGN_LOG_TOKEN_BUDGET = 2000;

/**
 * Assemble the full DM1 context for a player action.
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.dm1Prompt   — contents of dm1.txt
 * @param {string} opts.playerMessage — current player input (not yet saved)
 * @param {string[]|Set<string>|null} [opts.liveCharacterIds] — connected characters to include in party presence
 * @returns {{ systemPrompt: string, messages: Array<{role,content}> }}
 */
async function build({ sessionId, dm1Prompt, playerMessage, liveCharacterIds = null }) {
  // ── Fetch all context components in parallel ──────────────────────────
  const [worldStateRow, campaignLog, chapterSummaries, rollingWindowRows, partyPresence, activeCharacter] =
    await Promise.all([
      db.getWorldState(sessionId),
      db.getCampaignLog(sessionId),
      db.getChapterSummaries(sessionId),
      db.getRollingWindow(sessionId, 40), // 20 pairs = 40 rows
      db.getCharacterPresenceForCampaign().catch(() => []),
      db.getCharacterForSession(sessionId).catch(() => null),
    ]);

  const worldState = worldStateRow?.state || db.DEFAULT_WORLD_STATE;

  // ── Assemble static system prompt parts ──────────────────────────────
  // These are always included regardless of token budget.
  let staticSystemPrompt = dm1Prompt.trimEnd() + '\n\n';

  // Tier: world state block
  staticSystemPrompt += '## CURRENT WORLD STATE\n';
  staticSystemPrompt += JSON.stringify(worldState, null, 2) + '\n\n';
  staticSystemPrompt += '## SPATIAL CONTRACT\n';
  staticSystemPrompt += [
    `Current location is authoritative: ${worldState.current_location || 'not yet established'}.`,
    `Exact scene location is authoritative: ${worldState.scene_presence?.exact_location || worldState.current_location || 'not yet established'}.`,
    `Present NPCs: ${formatSceneList(worldState.scene_presence?.present_npcs)}.`,
    `Present objects: ${formatSceneList(worldState.scene_presence?.present_objects)}.`,
    `Available exits: ${formatSceneList(worldState.scene_presence?.available_exits)}.`,
    `Practical time: ${formatTimeState(worldState.time_state)}.`,
    `Active world effects: ${formatActiveEffects(worldState.active_effects)}.`,
    `Nearby but not present locations: ${formatSceneList(worldState.scene_presence?.nearby_locations)}.`,
    'Do not resolve interactions with NPCs, buildings, objects, or rooms unless they are present in the current location or the player explicitly travels to them first.',
    'If the player asks for an absent target, ask whether they head there instead of moving them silently.',
  ].join('\n');
  staticSystemPrompt += '\n\n';

  const activePartyPresence = filterActivePartyPresenceRows(partyPresence, { liveCharacterIds });
  const rulesContext = buildRulesContext({
    sessionId,
    worldState,
    characterSheet: activeCharacter?.character_sheet,
    partyPresence: activePartyPresence,
    liveCharacterIds,
  });
  staticSystemPrompt += '## RULES CONTEXT SNAPSHOT\n';
  staticSystemPrompt += summarizeRulesContextForPrompt(rulesContext) + '\n\n';

  const partyPresenceText = buildPartyPresenceText(activePartyPresence);
  if (partyPresenceText) {
    staticSystemPrompt += '## ACTIVE PARTY PRESENCE\n';
    staticSystemPrompt += partyPresenceText + '\n\n';
  }

  const characterSheetText = buildActiveCharacterText(activeCharacter?.character_sheet);
  if (characterSheetText) {
    staticSystemPrompt += '## ACTIVE CHARACTER SHEET\n';
    staticSystemPrompt += characterSheetText + '\n\n';
  }

  // Tier 2: campaign log (latest entries only, capped so long campaigns keep breathing)
  const campaignLogForPrompt = trimCampaignLog(campaignLog);
  if (campaignLogForPrompt.length > 0) {
    staticSystemPrompt += '## CAMPAIGN LOG\n';
    staticSystemPrompt += campaignLogForPrompt
      .map((e, i) => `${i + 1}. [Turn ${e.turn_number}] ${e.summary}`)
      .join('\n');
    staticSystemPrompt += '\n\n';
  }

  // ── Build rolling window messages array ───────────────────────────────
  let messages = buildMessagesArray(rollingWindowRows);
  // Append current player input
  messages.push({ role: 'user', content: playerMessage });

  // ── Tier 3: chapter summaries — trimmed oldest-first if over budget ───
  let summaries = [...chapterSummaries]; // oldest-first from DB

  // Calculate initial token estimate
  let chapterText   = buildChapterSummariesText(summaries);
  let systemPrompt  = staticSystemPrompt + chapterText;
  let msgTokens     = messages.reduce((a, m) => a + estimateTokens(m.content), 0);
  let totalTokens   = estimateTokens(systemPrompt) + msgTokens;

  // Drop oldest chapter summaries first
  while (totalTokens > TOKEN_BUDGET && summaries.length > 0) {
    summaries.shift();
    chapterText  = buildChapterSummariesText(summaries);
    systemPrompt = staticSystemPrompt + chapterText;
    totalTokens  = estimateTokens(systemPrompt) + msgTokens;
  }

  // If still over budget, trim oldest rolling window pairs from front
  while (totalTokens > TOKEN_BUDGET && messages.length > 1) {
    const removed = messages.splice(0, 2); // remove oldest user+assistant pair
    msgTokens    -= removed.reduce((a, m) => a + estimateTokens(m.content), 0);
    totalTokens   = estimateTokens(systemPrompt) + msgTokens;
  }

  // Ensure messages array starts with a user-role message
  while (messages.length > 0 && messages[0].role !== 'user') {
    const removed = messages.shift();
    msgTokens -= estimateTokens(removed.content);
  }

  return { systemPrompt, messages };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildChapterSummariesText(summaries) {
  if (summaries.length === 0) return '';
  let text = '## STORY SO FAR\n';
  text += summaries
    .map((s) => `[Turns ${s.turn_start}–${s.turn_end}] ${s.summary}`)
    .join('\n\n');
  return text + '\n\n';
}

function trimCampaignLog(entries) {
  const selected = [];
  let tokens = 0;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const entryText = `[Turn ${entry.turn_number}] ${entry.summary}`;
    const entryTokens = estimateTokens(entryText);
    if (selected.length > 0 && tokens + entryTokens > CAMPAIGN_LOG_TOKEN_BUDGET) {
      break;
    }
    selected.unshift(entry);
    tokens += entryTokens;
  }

  return selected;
}

function formatSceneList(value) {
  return Array.isArray(value) && value.length > 0 ? value.join(', ') : 'none established';
}

function formatTimeState(value) {
  if (!value || typeof value !== 'object') return 'not yet established';
  const parts = [];
  if (value.scene_time) parts.push(value.scene_time);
  if (Number(value.elapsed_rounds) > 0) parts.push(`${value.elapsed_rounds} rounds elapsed`);
  if (Number(value.elapsed_minutes) > 0) parts.push(`${value.elapsed_minutes} minutes elapsed`);
  return parts.join(', ') || 'not yet established';
}

function formatActiveEffects(value) {
  if (!Array.isArray(value) || value.length === 0) return 'none';
  return value
    .map((effect) => {
      const remaining = effect.remaining_rounds != null
        ? `${effect.remaining_rounds} rounds left`
        : effect.remaining_minutes != null
          ? `${effect.remaining_minutes} minutes left`
          : effect.duration || 'duration unknown';
      return `${effect.name || effect.id || 'effect'} on ${effect.target || 'unknown target'} (${effect.mechanical_effect || 'effect tracked'}, ${remaining}${effect.concentration ? ', concentration' : ''})`;
    })
    .join('; ');
}

function buildPartyPresenceText(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  return rows
    .map((row) => {
      const sheet = row.characters?.character_sheet || {};
      const identity = sheet.identity || {};
      const derived = sheet.derived_stats || {};
      const name = row.characters?.name || identity.name || row.character_id;
      const className = identity.class_name || identity.class || 'unknown class';
      const level = identity.level || derived.level || 1;
      const combatNote = row.in_combat
        ? ' In combat: character remains present and vulnerable until combat ends.'
        : '';
      return `- ${name}: ${row.presence}; ${className} level ${level}.${combatNote}`;
    })
    .join('\n');
}

function buildActiveCharacterText(characterSheet) {
  if (!characterSheet) return '';
  const identity = characterSheet.identity || {};
  const abilities = characterSheet.abilities || {};
  const derived = characterSheet.derived_stats || {};
  const spellcasting = characterSheet.spellcasting || {};
  const attacks = derived.attack_breakdowns || [];
  const features = characterSheet.features || [];
  const inventory = characterSheet.inventory || [];
  const languages = characterSheet.languages || characterSheet.proficiencies?.languages || [];
  const tools = characterSheet.proficiencies?.tools || [];
  const lines = [];

  lines.push(`Name: ${identity.name || 'Unnamed'}`);
  lines.push(`Build: ${identity.species_name || identity.species || 'Unknown species'} ${identity.class_name || identity.class || 'Unknown class'} level ${identity.level || derived.level || 1}`);
  lines.push(`Core stats: HP ${derived.hp ?? '--'}/${derived.max_hp ?? '--'}, AC ${derived.armor_class ?? '--'}, Speed ${derived.speed ?? '--'} ft, Initiative ${fmtSigned(derived.initiative)}, Proficiency ${fmtSigned(derived.proficiency_bonus)}`);
  if (abilities.final_scores) {
    lines.push(`Ability modifiers: ${Object.entries(abilities.modifiers || {}).map(([key, value]) => `${key.toUpperCase()} ${fmtSigned(value)}`).join(', ')}`);
  }
  if (attacks.length) {
    lines.push(`Attacks: ${attacks.map((attack) => `${attack.name} hit ${fmtSigned(attack.attack_total)}, damage ${attack.damage_formula}`).join('; ')}`);
  }
  if (features.length) {
    lines.push(`Features: ${features.map((feature) => feature.name).join(', ')}`);
  }
  if (Array.isArray(derived.active_spell_effects) && derived.active_spell_effects.length) {
    lines.push(`Active spell effects: ${formatActiveEffects(derived.active_spell_effects)}`);
  }
  if (inventory.length) {
    lines.push(`Equipment: ${inventory.map((item) => Number(item.quantity || 0) > 1 ? `${item.name} x${item.quantity}` : item.name).join(', ')}`);
  }
  if (spellcasting.ability) {
    const content = getContentBundle();
    const cantrips = spellcasting.cantrips_known || [];
    const spells = spellcasting.spells_prepared || [];
    lines.push(`Spellcasting: ${spellcasting.ability.toUpperCase()}, slots ${formatSpellSlots(spellcasting.slots)}, cantrips ${formatSpellList(cantrips, content)}, level 1 prepared ${formatSpellList(spells, content)}`);
    if ((spellcasting.class_choice_spells || characterSheet.class_choice_spells || []).length) {
      lines.push(`Class choice spells: ${formatClassChoiceSpellList(spellcasting.class_choice_spells || characterSheet.class_choice_spells, content)}`);
    }
    lines.push('Spell rule: only these listed cantrips and level 1 prepared/known spells are currently castable. Do not allow unlisted spells or spells above level 1.');
  }
  if (languages.length) lines.push(`Languages: ${languages.join(', ')}`);
  if (tools.length) lines.push(`Tool proficiencies: ${tools.join(', ')}`);
  lines.push('Capability rule: only grant supernatural actions, flight, telepathy, special senses, spells, or class features that appear here, in current world state, or in established inventory.');
  return lines.join('\n');
}

function formatSpellList(ids, content) {
  if (!Array.isArray(ids) || ids.length === 0) return 'none established';
  return ids.map((id) => {
    const spell = byId(content.spells, id);
    return spell ? `${spell.name} (${spell.id}; level ${spell.level}; ${spell.description})` : id;
  }).join(', ');
}

function formatSpellSlots(slots = {}) {
  const entries = Object.entries(slots || {});
  if (entries.length === 0) return 'none';
  return entries.map(([level, count]) => `L${level}:${count}`).join(', ');
}

function formatClassChoiceSpellList(entries = [], content) {
  return (entries || [])
    .map((entry) => {
      const spell = byId(content.spells, entry.id);
      return `${spell?.name || entry.id} (${entry.source || 'class choice'}${entry.source_detail ? `: ${entry.source_detail}` : ''})`;
    })
    .join(', ');
}

function fmtSigned(value) {
  const number = Number(value || 0);
  return number >= 0 ? `+${number}` : String(number);
}

/**
 * Convert DB message rows (player_dm1, dm1) to API messages array.
 * Enforces strict user/assistant alternation by merging consecutive same-role
 * messages — this handles orphaned player_dm1 rows (see spec Section 12).
 */
function buildMessagesArray(dbRows) {
  const raw = [];
  for (const row of dbRows) {
    if (row.role === 'player_dm1') {
      raw.push({ role: 'user', content: row.content });
    } else if (row.role === 'dm1') {
      raw.push({ role: 'assistant', content: row.content });
    }
    // Ignore player_dm2, dm2 rows — DM2 context is never fed to DM1
  }
  return enforceAlternation(raw);
}

/**
 * Merge consecutive same-role messages so the array strictly alternates.
 * An orphaned user message (no DM response) will be merged with the next
 * user message — DM1 may then address both in its response (spec §12).
 */
function enforceAlternation(messages) {
  if (messages.length === 0) return [];
  const result = [];
  for (const msg of messages) {
    if (result.length > 0 && result[result.length - 1].role === msg.role) {
      result[result.length - 1] = {
        role:    msg.role,
        content: result[result.length - 1].content + '\n\n' + msg.content,
      };
    } else {
      result.push({ ...msg });
    }
  }
  return result;
}

module.exports = { build };
