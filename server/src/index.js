require('dotenv').config({ override: true });
const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const cors      = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');

const ai                   = require('./aiClient');
const db                   = require('./db');
const contextBuilder       = require('./contextBuilder');
const worldStateExtractor  = require('./worldStateExtractor');
const campaignLogExtractor = require('./campaignLogExtractor');
const chapterSummarizer    = require('./chapterSummarizer');
const { DM1_MODEL, UTILITY_MODEL } = require('./models');
const { retryWithBackoff } = require('./retryUtils');
const { getContentBundle } = require('./contentData');
const { validateCharacter } = require('./characterValidator');
const { checkSpatialAction } = require('./spatialGuard');
const { resolvePreNarration } = require('./mechanicsResolver');
const { resolveRefereeAction, advanceEnemyTurns, advanceNarrativeTime } = require('./refereeCore');
const { filterActivePartyPresenceRows } = require('./partyPresence');
const {
  resolveSpellCast,
  resolveSpellOutcome,
  getCastSpellFromMessage,
  applyActiveEffectsToCharacterSheet,
} = require('./spellEffectEngine');
const {
  spendTurnResource,
  getSpellActionResource,
} = require('./actionEconomy');

// ── Setup ──────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

const configuredOrigins = [
  process.env.CLIENT_URL,
  process.env.ALLOWED_ORIGINS,
  process.env.NODE_ENV === 'production' ? null : 'http://localhost:5173,http://127.0.0.1:5173',
]
  .filter(Boolean)
  .flatMap((value) => value.split(','))
  .map((value) => value.trim())
  .filter(Boolean);
const allowedOrigins = new Set(configuredOrigins.length ? configuredOrigins : ['http://localhost:5173']);
const corsOrigin = (origin, callback) => {
  if (!origin || allowedOrigins.has(origin)) {
    callback(null, true);
    return;
  }
  callback(new Error(`Origin ${origin} is not allowed by CORS`));
};

const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
});

app.use(cors({ origin: corsOrigin }));
app.use(express.json());

const activeDm1Sessions = new Set();
const characterRollAttempts = new Map();
const liveCharacterSockets = new Map();

if ((process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT) && !process.env.SESSION_TOKEN_SECRET) {
  throw new Error('SESSION_TOKEN_SECRET is required in production.');
}

function trackSocketCharacter(socket, characterId) {
  const previousId = socket.currentCharacterId;
  if (previousId && previousId !== characterId) {
    untrackSocketCharacter(socket, previousId);
  }

  socket.currentCharacterId = characterId || null;
  if (!characterId) return;

  const key = String(characterId);
  const sockets = liveCharacterSockets.get(key) || new Set();
  sockets.add(socket.id);
  liveCharacterSockets.set(key, sockets);
}

function untrackSocketCharacter(socket, characterId = socket.currentCharacterId) {
  if (!characterId) {
    socket.currentCharacterId = null;
    return;
  }

  const key = String(characterId);
  const sockets = liveCharacterSockets.get(key);
  if (sockets) {
    sockets.delete(socket.id);
    if (sockets.size === 0) liveCharacterSockets.delete(key);
  }

  if (socket.currentCharacterId === characterId) {
    socket.currentCharacterId = null;
  }
}

function hasLiveCharacterSocket(characterId) {
  return Boolean(characterId && liveCharacterSockets.has(String(characterId)));
}

function getLiveCharacterIds() {
  return [...liveCharacterSockets.keys()];
}

function getPartyPresenceOptions(extra = {}) {
  return {
    liveCharacterIds: getLiveCharacterIds(),
    ...extra,
  };
}

// ── Load prompts ───────────────────────────────────────────────────────────
const DM1_PROMPT = fs.readFileSync(
  path.join(__dirname, '../prompts/dm1.txt'), 'utf8'
);
const DM2_PROMPT = fs.readFileSync(
  path.join(__dirname, '../prompts/dm2.txt'), 'utf8'
);

// ── Async post-response pipeline ───────────────────────────────────────────
// Fires after DM1 response is already emitted to the client.
// All steps have silent failure — never blocks gameplay.
// Known race condition: if a player submits their next action before these
// utility model calls complete, the next DM1 context will be one turn behind on
// world state and campaign log. Acceptable for Phase 2 single player.
async function runPostResponsePipeline(sessionId, playerMessage, dm1Reply, newTurn, socket = null) {
  await Promise.allSettled([
    worldStateExtractor.extract(sessionId, playerMessage, dm1Reply),
    campaignLogExtractor.extract(sessionId, playerMessage, dm1Reply, newTurn),
  ]);

  if (socket) {
    await syncCharacterFromWorldState(socket, sessionId).catch(console.error);
  }

  if (newTurn > 0 && newTurn % 50 === 0) {
    await chapterSummarizer.summarize(sessionId, newTurn).catch(console.error);
  }
}

function recentNarrationForSpatialGuard(history = []) {
  return (history || [])
    .filter((row) => row.role === 'dm1')
    .map((row) => String(row.content || ''))
    .filter((content) => content.trim())
    .filter((content) => !/\b(?:is not here|are not here|no specific .* established|do you look around for it|clarify where you mean)\b/i.test(content))
    .slice(-3)
    .join('\n\n');
}

async function moderateUserMessage(socket, errorEvent, message) {
  const moderation = await ai.moderateText(message);
  if (moderation.ok) return true;

  console.warn('User input blocked by moderation:', moderation.flaggedCategories.join(', '));
  socket.emit(errorEvent, { message: moderation.publicMessage, code: 'moderation_blocked' });
  return false;
}

async function moderateAssistantReply(reply, fallbackReply) {
  const moderation = await ai.moderateText(reply);
  if (moderation.ok) return reply;

  console.warn('Assistant output replaced by moderation:', moderation.flaggedCategories.join(', '));
  return fallbackReply;
}

function getSessionSecret() {
  return process.env.SESSION_TOKEN_SECRET || 'local-dev-session-secret';
}

function signSessionToken(sessionId) {
  const secret = getSessionSecret();
  const signature = crypto
    .createHmac('sha256', secret)
    .update(sessionId)
    .digest('hex');
  return `${sessionId}.${signature}`;
}

function isValidSessionToken(sessionId, token) {
  if (!sessionId || !token) return false;
  const expected = signSessionToken(sessionId);
  const expectedBuffer = Buffer.from(expected);
  const tokenBuffer = Buffer.from(token);
  if (expectedBuffer.length !== tokenBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, tokenBuffer);
}

function characterSheetToWorldStats(characterSheet, characterId = null) {
  const stats = characterSheet.derived_stats || {};
  const identity = characterSheet.identity || {};
  const details = characterSheet.character_details || {};
  const modifiers = characterSheet.abilities?.modifiers || {};
  const primaryAttack = stats.attack_breakdowns?.[0];
  return {
    character_id: characterId || stats.character_id || null,
    name: identity.name || '',
    class: identity.class_name || '',
    level: stats.level || identity.level || 1,
    hp: stats.hp ?? null,
    max_hp: stats.max_hp ?? null,
    temp_hp: stats.temp_hp || 0,
    armor_class: stats.armor_class || 10,
    base_armor_class: stats.base_armor_class ?? stats.armor_class ?? 10,
    speed: stats.speed || 30,
    alignment: details.alignment || '',
    appearance: details.appearance || '',
    personality: details.personality || '',
    backstory: details.backstory || '',
    languages: characterSheet.languages || characterSheet.proficiencies?.languages || [],
    tools: characterSheet.proficiencies?.tools || [],
    resistances: characterSheet.resistances || [],
    species_spells: (characterSheet.species_spells || []).map((spell) => spell.id || spell),
    class_cantrips: characterSheet.spellcasting?.cantrips_known || [],
    class_spells: characterSheet.spellcasting?.spells_prepared || [],
    class_choice_spells: characterSheet.class_choice_spells || characterSheet.spellcasting?.class_choice_spells || [],
    origin_magic: characterSheet.origin?.magic_initiate || {},
    conditions: stats.conditions || [],
    spell_slots: characterSheet.spellcasting?.slots || {},
    hit_dice: characterSheet.resources?.hit_dice || null,
    ammunition: buildCharacterAmmunitionState(characterSheet),
    weapon_name: primaryAttack?.name || '',
    ability_scores: modifiers,
  };
}

function summarizeCharacterForClient(row) {
  const sheet = row.character_sheet || {};
  const identity = sheet.identity || {};
  const derived = sheet.derived_stats || {};
  return {
    id: row.id,
    name: row.name || identity.name || 'Unnamed Character',
    status: row.status,
    isActiveForSession: Boolean(row.session_id),
    identity,
    summary: {
      species: identity.species_name || identity.species || '',
      className: identity.class_name || identity.class || '',
      level: identity.level || derived.level || 1,
      hp: derived.hp ?? null,
      maxHp: derived.max_hp ?? null,
      armorClass: derived.armor_class ?? null,
    },
    character: sheet,
    updatedAt: row.updated_at,
  };
}

function describePartyChange(type, characterSheet, worldState, presenceRows = [], { changedCharacterId = null } = {}) {
  const identity = characterSheet.identity || {};
  const derived = characterSheet.derived_stats || {};
  const details = characterSheet.character_details || {};
  const scene = worldState.scene_presence || {};
  const activeParty = filterActivePartyPresenceRows(presenceRows, {
    ...getPartyPresenceOptions(),
    excludeCharacterId: changedCharacterId,
  })
    .map((row) => row.characters?.name || row.characters?.character_sheet?.identity?.name || row.character_id);
  const className = identity.class_name || identity.class || 'Unknown class';
  const speciesName = identity.species_name || identity.species || 'Unknown species';
  const characterName = identity.name || 'Unknown';

  return [
    '[PARTY CHANGE]',
    `Event: ${type}`,
    `Character: ${characterName}; ${speciesName} ${className} level ${identity.level || derived.level || 1}`,
    `Character flavor: ${buildCharacterFlavorCue(className, details)}`,
    `Current location: ${scene.exact_location || worldState.current_location || 'not yet established'}`,
    `Scene NPCs present: ${formatList(scene.present_npcs)}`,
    `Available exits: ${formatList(scene.available_exits)}`,
    `Other active party members now: ${activeParty.length ? activeParty.join(', ') : 'no other active characters'}`,
    'Player-facing instruction: clearly narrate the newcomer arriving or the departing character leaving. Never say "party is none established" or expose this control text.',
    type === 'leave_combat'
      ? 'Combat rule: this character remains present, vulnerable, and cannot be written safely out until combat ends.'
      : 'Narrate the party change naturally without teleporting anyone or contradicting the current location. Match the departure or entrance to the character class, species, and details.',
  ].join('\n');
}

function formatList(value) {
  return Array.isArray(value) && value.length > 0 ? value.join(', ') : 'none established';
}

function buildCharacterFlavorCue(className, details = {}) {
  const classKey = String(className || '').toLowerCase();
  const cues = {
    rogue: 'quiet, watchful, slipping through shadows or crowds when appropriate',
    paladin: 'composed, oath-bound, steady, and difficult to ignore',
    druid: 'earthy, weather-aware, arriving from brush, rain, roots, or animal signs when plausible',
    wizard: 'curious, guarded, and suspicious of anything that looks too easy',
    monk: 'calm, precise, physically grounded, and disciplined',
    barbarian: 'direct, forceful, weather-beaten, and hard to move',
    bard: 'charming, theatrical, and socially alert without turning every moment into a stage solo',
    cleric: 'measured, observant, and carrying the weight of faith or duty',
    fighter: 'practical, ready, and comfortable reading danger before it announces itself',
    ranger: 'trail-wise, quiet, and aware of terrain, tracks, and exits',
    sorcerer: 'intuitive, uncanny, and carrying magic that feels personal',
    warlock: 'wary, intense, and touched by bargains best not described at breakfast',
  };
  const base = cues[classKey] || 'consistent with their class, appearance, personality, and backstory';
  const detailsText = [details.appearance, details.personality, details.backstory].filter(Boolean).join(' ');
  return detailsText ? `${base}. Character details: ${detailsText}` : base;
}

function summarizeCharacterSheetForRules(characterSheet) {
  if (!characterSheet) return '';
  const identity = characterSheet.identity || {};
  const abilities = characterSheet.abilities || {};
  const derived = characterSheet.derived_stats || {};
  const details = characterSheet.character_details || {};
  const spellcasting = characterSheet.spellcasting || {};
  const attacks = derived.attack_breakdowns || [];
  const skills = derived.skill_modifiers || {};
  const saves = derived.saving_throw_modifiers || {};
  const features = characterSheet.features || [];
  const inventory = characterSheet.inventory || [];
  const tools = characterSheet.proficiencies?.tools || [];
  const lines = [];

  lines.push(`Name: ${identity.name || 'Unnamed'}`);
  lines.push(`Build: ${identity.species_name || identity.species || 'Unknown species'} ${identity.class_name || identity.class || 'Unknown class'} level ${identity.level || derived.level || 1}`);
  lines.push(`Core stats: HP ${derived.hp ?? '--'}/${derived.max_hp ?? '--'}, AC ${derived.armor_class ?? '--'}, Speed ${derived.speed ?? '--'} ft, Initiative ${fmtSigned(derived.initiative)}, Proficiency ${fmtSigned(derived.proficiency_bonus)}`);
  if (abilities.final_scores) {
    lines.push(`Ability scores: ${Object.entries(abilities.final_scores).map(([key, score]) => `${key.toUpperCase()} ${score} (${fmtSigned(abilities.modifiers?.[key])})`).join(', ')}`);
  }
  if (Object.keys(saves).length) {
    lines.push(`Saving throws: ${Object.entries(saves).map(([key, save]) => `${key.toUpperCase()} ${fmtSigned(save.total)}${save.proficient ? ' proficient' : ''}`).join(', ')}`);
  }
  if (Object.keys(skills).length) {
    lines.push(`Skills: ${Object.entries(skills).map(([key, skill]) => `${key.replaceAll('_', ' ')} ${fmtSigned(skill.total)}${skill.proficient ? ' proficient' : ''}`).join(', ')}`);
  }
  if (attacks.length) {
    lines.push(`Attacks: ${attacks.map((attack) => `${attack.name} hit ${fmtSigned(attack.attack_total)}, damage ${attack.damage_formula}`).join('; ')}`);
  }
  if (Array.isArray(derived.active_spell_effects) && derived.active_spell_effects.length) {
    lines.push(`Active effects: ${formatRulesActiveEffects(derived.active_spell_effects)}`);
  }
  if (features.length) {
    lines.push(`Features: ${features.map((feature) => `${feature.name} (${feature.source || 'feature'})`).join('; ')}`);
  }
  if (inventory.length) {
    lines.push(`Equipment: ${inventory.map((item) => Number(item.quantity || 0) > 1 ? `${item.name} x${item.quantity}` : item.name).join(', ')}`);
  }
  if (spellcasting.ability) {
    const cantrips = spellcasting.cantrips_known || [];
    const spells = spellcasting.spells_prepared || [];
    lines.push(`Spellcasting: ${spellcasting.ability.toUpperCase()}, attack ${fmtSigned(derived.spell_attack_bonus)}, DC ${derived.spell_save_dc ?? '--'}, slots ${formatSpellSlots(spellcasting.slots)}, cantrips ${formatList(cantrips)}, level 1 ${formatList(spells)}`);
    if ((spellcasting.class_choice_spells || characterSheet.class_choice_spells || []).length) {
      lines.push(`Class choice spells: ${(spellcasting.class_choice_spells || characterSheet.class_choice_spells).map((entry) => `${entry.id} from ${entry.source || 'class choice'}`).join(', ')}`);
    }
  }
  const languages = characterSheet.languages || characterSheet.proficiencies?.languages || [];
  if (languages.length) lines.push(`Languages: ${languages.join(', ')}`);
  if (tools.length) lines.push(`Tool proficiencies: ${tools.join(', ')}`);
  if (details.alignment || details.personality || details.backstory) {
    lines.push(`Character details: ${[details.alignment, details.personality, details.backstory].filter(Boolean).join(' ')}`);
  }
  return lines.join('\n');
}

function formatRulesActiveEffects(effects = []) {
  if (!Array.isArray(effects) || effects.length === 0) return 'none';
  return effects.map((effect) => {
    const remaining = effect.remaining_rounds != null
      ? `${effect.remaining_rounds} rounds left`
      : effect.remaining_minutes != null
        ? `${effect.remaining_minutes} minutes left`
        : effect.duration || 'duration unknown';
    const rules = (effect.rules_effects || [])
      .map((rule) => `${rule.label || rule.target}: ${rule.value != null ? formatRuleValue(rule.value) : rule.die || rule.target}`)
      .join(', ');
    return [
      effect.name || effect.id || 'effect',
      `target ${effect.target || 'self/scene'}`,
      effect.mechanical_effect || null,
      rules || null,
      remaining,
      effect.concentration ? 'concentration' : null,
    ].filter(Boolean).join(' | ');
  }).join('; ');
}

function formatRuleValue(value) {
  return typeof value === 'number' && value >= 0 ? `+${value}` : String(value);
}

function fmtSigned(value) {
  const number = Number(value || 0);
  return number >= 0 ? `+${number}` : String(number);
}

function formatSpellSlots(slots = {}) {
  const entries = Object.entries(slots || {});
  if (entries.length === 0) return 'none';
  return entries.map(([level, count]) => `L${level}:${count}`).join(', ');
}

async function handleDeterministicSpellAction(socket, sessionId, message) {
  const content = getContentBundle();

  const character = await db.getCharacterForSession(sessionId);
  const sheet = character?.character_sheet;
  if (!character || !sheet) return { matched: false };

  const worldStateRow = await db.getWorldState(sessionId);
  const currentWorldState = normalizeActiveCharacterWorldState(worldStateRow?.state || db.DEFAULT_WORLD_STATE, sheet, character.id);
  const spellForEconomy = getCastSpellFromMessage(message, content);
  let actionWorldState = currentWorldState;
  if (spellForEconomy && currentWorldState.combat_state?.active) {
    const actionResource = getSpellActionResource(spellForEconomy);
    const spent = spendTurnResource(currentWorldState, actionResource, spellForEconomy.name, sheet);
    if (!spent.ok) {
      const currentTurn = currentWorldState.session_turn ?? 0;
      await db.saveMessage(sessionId, 'player_dm1', message, currentTurn);
      await db.saveMessage(sessionId, 'dm1', spent.reply, currentTurn);
      await db.incrementSessionTurn(sessionId);
      socket.emit('dm1_response', { message: spent.reply });
      return { matched: true, handled: true };
    }
    actionWorldState = spent.worldState;
  }

  const result = resolveSpellCast({
    message,
    content,
    characterSheet: sheet,
    worldState: actionWorldState,
  });
  if (!result?.matched) return { matched: false };

  if (result.blocked) {
    const currentTurn = currentWorldState.session_turn ?? 0;
    await db.saveMessage(sessionId, 'player_dm1', message, currentTurn);
    await db.saveMessage(sessionId, 'dm1', result.reply, currentTurn);
    await db.incrementSessionTurn(sessionId);
    socket.emit('dm1_response', { message: result.reply });
    return { matched: true, handled: true };
  }

  const spellOutcome = resolveSpellOutcome({
    spellCast: result,
    characterSheet: result.characterSheet,
    worldState: result.worldState,
  });
  if (spellOutcome?.handled && spellOutcome.logType === 'spell_no_target') {
    const currentTurn = currentWorldState.session_turn ?? 0;
    await db.saveMessage(sessionId, 'player_dm1', message, currentTurn);
    await db.saveMessage(sessionId, 'dm1', spellOutcome.reply, currentTurn);
    await db.incrementSessionTurn(sessionId);
    socket.emit('dm1_response', { message: spellOutcome.reply });
    await db.logDmCall({
      sessionId,
      dm:           spellOutcome.logType,
      model:        'deterministic',
      playerInput:  message,
      fullPrompt:   JSON.stringify({ spell: result.spell, worldState: currentWorldState }),
      dmResponse:   spellOutcome.reply,
      inputTokens:  null,
      outputTokens: null,
    }).catch(console.error);
    return { matched: true, handled: true };
  }

  const saved = await db.updateCharacterSheet(character.id, result.characterSheet);
  if (spellOutcome?.handled) {
    let finalWorldState = spellOutcome.worldState;
    let reply = spellOutcome.reply;
    if (spellOutcome.consumesTurn && finalWorldState.combat_state?.active) {
      const enemyTurns = advanceEnemyTurns({
        worldState: finalWorldState,
        characterSheet: saved.character_sheet,
        playerTurnNote: reply,
      });
      finalWorldState = enemyTurns.worldState;
      reply = enemyTurns.reply;
    }

    const currentTurn = currentWorldState.session_turn ?? 0;
    await db.updateWorldState(sessionId, finalWorldState);
    await db.saveMessage(sessionId, 'player_dm1', message, currentTurn);
    await db.saveMessage(sessionId, 'dm1', reply, currentTurn);
    await db.incrementSessionTurn(sessionId);
    socket.emit('dm1_response', { message: reply });
    await db.logDmCall({
      sessionId,
      dm:           spellOutcome.logType || 'spell_referee',
      model:        'deterministic',
      playerInput:  message,
      fullPrompt:   JSON.stringify({ spell: result.spell, worldState: finalWorldState }),
      dmResponse:   reply,
      inputTokens:  null,
      outputTokens: null,
    }).catch(console.error);
    await syncCharacterFromWorldState(socket, sessionId, { forceEmit: true }).catch(console.error);
    return { matched: true, handled: true };
  }

  await db.updateWorldState(sessionId, result.worldState);
  socket.emit('character_ready', {
    characterId: saved.id,
    character: saved.character_sheet,
    shouldStartSession: false,
  });
  return { matched: true, handled: false, worldState: result.worldState };
}

async function syncCharacterFromWorldState(socket, sessionId, { forceEmit = false } = {}) {
  const [character, worldStateRow] = await Promise.all([
    db.getCharacterForSession(sessionId),
    db.getWorldState(sessionId),
  ]);
  const sheet = character?.character_sheet;
  const worldState = worldStateRow?.state;
  if (!character || !sheet || !worldState?.player_stats) return;

  const stats = worldState.player_stats;
  if (stats.character_id && stats.character_id !== character.id) return;
  const derived = sheet.derived_stats || {};
  const nextDerived = { ...derived };
  let changed = false;

  for (const [worldKey, sheetKey] of [
    ['hp', 'hp'],
    ['max_hp', 'max_hp'],
    ['temp_hp', 'temp_hp'],
    ['armor_class', 'armor_class'],
    ['speed', 'speed'],
  ]) {
    if (stats[worldKey] !== undefined && stats[worldKey] !== null && nextDerived[sheetKey] !== stats[worldKey]) {
      nextDerived[sheetKey] = stats[worldKey];
      changed = true;
    }
  }

  if (Array.isArray(stats.conditions) && JSON.stringify(nextDerived.conditions || []) !== JSON.stringify(stats.conditions)) {
    nextDerived.conditions = stats.conditions;
    changed = true;
  }

  const worldEffects = Array.isArray(worldState.active_effects) ? worldState.active_effects : [];
  if (JSON.stringify(nextDerived.active_spell_effects || []) !== JSON.stringify(worldEffects)) {
    const adjustedSheet = applyActiveEffectsToCharacterSheet({ ...sheet, derived_stats: nextDerived }, worldEffects);
    Object.assign(nextDerived, adjustedSheet.derived_stats || {});
    changed = true;
  }

  let nextSheet = changed ? { ...sheet, derived_stats: nextDerived } : sheet;
  if (stats.spell_slots && typeof stats.spell_slots === 'object' && !Array.isArray(stats.spell_slots)) {
    const currentSlots = sheet.spellcasting?.slots || {};
    const nextSlots = { ...currentSlots, ...stats.spell_slots };
    if (JSON.stringify(currentSlots) !== JSON.stringify(nextSlots)) {
      nextSheet = {
        ...nextSheet,
        spellcasting: { ...(nextSheet.spellcasting || {}), slots: nextSlots },
      };
      changed = true;
    }
  }

  if (stats.reset_spell_uses && nextSheet.resources?.spell_uses) {
    const spellUses = Object.fromEntries(Object.entries(nextSheet.resources.spell_uses).map(([key, use]) => [
      key,
      { ...use, remaining: Number(use.max ?? 1) },
    ]));
    nextSheet = {
      ...nextSheet,
      resources: {
        ...(nextSheet.resources || {}),
        spell_uses: spellUses,
      },
    };
    changed = true;
  }

  if (stats.hit_dice && typeof stats.hit_dice === 'object' && !Array.isArray(stats.hit_dice)) {
    nextSheet = {
      ...nextSheet,
      resources: {
        ...(nextSheet.resources || {}),
        hit_dice: {
          ...(nextSheet.resources?.hit_dice || {}),
          ...stats.hit_dice,
        },
      },
    };
    changed = true;
  }

  if (stats.resources && typeof stats.resources === 'object' && !Array.isArray(stats.resources)) {
    nextSheet = {
      ...nextSheet,
      resources: mergeSheetResources(nextSheet.resources || {}, stats.resources),
    };
    changed = true;
  }

  if (!changed) {
    if (forceEmit) {
      socket.emit('character_ready', {
        characterId: character.id,
        character: sheet,
        shouldStartSession: false,
      });
    }
    return;
  }
  const saved = await db.updateCharacterSheet(character.id, nextSheet);
  socket.emit('character_ready', {
    characterId: saved.id,
    character: saved.character_sheet,
    shouldStartSession: false,
  });
}

function mergeSheetResources(current = {}, incoming = {}) {
  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged[key] = {
        ...(current[key] && typeof current[key] === 'object' && !Array.isArray(current[key]) ? current[key] : {}),
        ...value,
      };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

async function syncCharacterToWorldState(sessionId, characterSheet, characterId = null) {
  const row = await db.getWorldState(sessionId);
  const current = row?.state || db.DEFAULT_WORLD_STATE;
  await db.updateWorldState(sessionId, normalizeActiveCharacterWorldState(current, characterSheet, characterId));
}

function normalizeActiveCharacterWorldState(worldState, characterSheet, characterId = null) {
  const stats = characterSheetToWorldStats(characterSheet, characterId);
  const currentPlayerStats = worldState.player_stats || db.DEFAULT_WORLD_STATE.player_stats;
  const sameCharacter = Boolean(stats.character_id && currentPlayerStats.character_id === stats.character_id);
  const nextPlayerStats = {
    ...currentPlayerStats,
    ...stats,
    ammunition: sameCharacter && currentPlayerStats.ammunition
      ? currentPlayerStats.ammunition
      : stats.ammunition,
    ammunition_spent_since_recovery: sameCharacter
      ? currentPlayerStats.ammunition_spent_since_recovery || {}
      : {},
  };
  return {
    ...worldState,
    active_effects: characterSheet.derived_stats?.active_spell_effects || worldState.active_effects || [],
    player_stats: nextPlayerStats,
    combat_state: alignCombatPlayerToCharacter(worldState.combat_state, characterSheet, nextPlayerStats),
  };
}

function buildCharacterAmmunitionState(characterSheet = {}) {
  return Object.fromEntries((characterSheet.inventory || [])
    .filter((item) => item.type === 'ammunition')
    .map((item) => [item.id, {
      id: item.id,
      name: item.name,
      remaining: Number(item.quantity || 0),
    }]));
}

function alignCombatPlayerToCharacter(combatState, characterSheet, playerStats) {
  if (!combatState?.active) return combatState;
  const derived = characterSheet.derived_stats || {};
  const identity = characterSheet.identity || {};
  const aligned = {
    ...combatState,
    combatants: (combatState.combatants || []).map((combatant) => (
      combatant.is_player
        ? {
            ...combatant,
            character_id: playerStats.character_id || combatant.character_id || null,
            name: identity.name || playerStats.name || combatant.name || 'You',
            initiative: Number(combatant.initiative ?? derived.initiative ?? 0),
            hp: Number(derived.hp ?? derived.max_hp ?? playerStats.hp ?? combatant.hp ?? 10),
            max_hp: Number(derived.max_hp ?? playerStats.max_hp ?? combatant.max_hp ?? 10),
            temp_hp: Number(derived.temp_hp ?? playerStats.temp_hp ?? combatant.temp_hp ?? 0),
            ac: Number(derived.armor_class ?? playerStats.armor_class ?? combatant.ac ?? 10),
            conditions: derived.conditions || playerStats.conditions || combatant.conditions || [],
          }
        : combatant
    )),
  };
  const enemiesAlive = (aligned.combatants || [])
    .some((combatant) => !combatant.is_player && Number(combatant.hp || 0) > 0);
  return enemiesAlive ? aligned : null;
}

function hasValidSocketSession(socket, sessionId, sessionToken) {
  return Boolean(
    socket.sessionId
    && sessionId
    && socket.sessionId === sessionId
    && isValidSessionToken(sessionId, sessionToken)
  );
}

async function getCombatActive(sessionId) {
  const row = await db.getWorldState(sessionId);
  return Boolean(row?.state?.combat_state?.active);
}

async function narratePartyChange(socket, sessionId, type, characterSheet, characterId = null) {
  const history = await db.getSessionHistory(sessionId);
  const narrativeHistory = history.filter((m) => m.role === 'player_dm1' || m.role === 'dm1');
  if (narrativeHistory.length === 0) return;
  if (activeDm1Sessions.has(sessionId)) return;
  activeDm1Sessions.add(sessionId);

  socket.emit('dm1_typing', true);
  try {
    const worldStateRow = await db.getWorldState(sessionId);
    const worldState = worldStateRow?.state || db.DEFAULT_WORLD_STATE;
    const presenceRows = await db.getCharacterPresenceForCampaign().catch(() => []);
    const partyPrompt = describePartyChange(type, characterSheet, worldState, presenceRows, {
      changedCharacterId: characterId,
    });
    const { systemPrompt, messages } = await contextBuilder.build({
      sessionId,
      dm1Prompt: DM1_PROMPT,
      playerMessage: partyPrompt,
      liveCharacterIds: getLiveCharacterIds(),
    });

    const response = await retryWithBackoff(() => ai.generateText({
      model: DM1_MODEL,
      maxTokens: 700,
      system: systemPrompt,
      messages,
    }));

    const safeReply = await moderateAssistantReply(
      response.text,
      'The party shifts position, but the moment refuses to settle cleanly. The Game Master keeps everyone anchored where the scene already placed them.'
    );
    const currentTurn = worldState.session_turn ?? 0;
    await db.saveMessage(sessionId, 'dm1', safeReply, currentTurn);
    socket.emit('dm1_response', { message: safeReply });
    await db.logDmCall({
      sessionId,
      dm: 'dm1',
      model: DM1_MODEL,
      playerInput: partyPrompt,
      fullPrompt: systemPrompt + '\n\n[MESSAGES]: ' + JSON.stringify(messages),
      dmResponse: safeReply,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    }).catch(console.error);
  } catch (err) {
    console.error('party change narration error:', err);
  } finally {
    socket.emit('dm1_typing', false);
    activeDm1Sessions.delete(sessionId);
  }
}

function rollD6() {
  return crypto.randomInt(1, 7);
}

function rollAbilityStat() {
  const dice = Array.from({ length: 4 }, rollD6).sort((a, b) => a - b);
  return {
    dice,
    total: dice.slice(1).reduce((sum, value) => sum + value, 0),
  };
}

function signRollSet(sessionId, attemptsUsed, acceptedSet) {
  const payload = JSON.stringify({ sessionId, attemptsUsed, acceptedSet });
  return crypto
    .createHmac('sha256', getSessionSecret())
    .update(payload)
    .digest('hex');
}

function verifyRollSet(sessionId, rolledStats = {}) {
  const acceptedSet = Array.isArray(rolledStats.acceptedSet) ? rolledStats.acceptedSet.map(Number) : [];
  const attemptsUsed = Number(rolledStats.attemptsUsed);
  const rollToken = String(rolledStats.rollToken || '');
  if (!sessionId || acceptedSet.length !== 6 || !Number.isInteger(attemptsUsed) || attemptsUsed < 1 || attemptsUsed > 3 || !rollToken) {
    return false;
  }
  const expected = signRollSet(sessionId, attemptsUsed, acceptedSet);
  const expectedBuffer = Buffer.from(expected);
  const tokenBuffer = Buffer.from(rollToken);
  if (expectedBuffer.length !== tokenBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, tokenBuffer);
}

// ── Socket.io events ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // ── join_session ──────────────────────────────────────────────────────
  socket.on('join_session', async ({ sessionId, sessionToken }) => {
    try {
      await db.getOrCreateDefaultCampaign();
      let id       = sessionId;
      let isResume = false;

      if (id && isValidSessionToken(id, sessionToken)) {
        const existing = await db.getSession(id);
        if (existing) {
          isResume = true;
        } else {
          console.log(`Session ${id} not found in DB, creating new session`);
          id = uuidv4();
        }
      } else {
        if (id) console.warn(`Rejected unsigned session resume attempt for ${id}`);
        id = uuidv4();
      }

      if (!isResume) {
        await db.createSession(id);
        await db.initWorldState(id);
      }

      await db.updateLastActive(id);
      socket.join(id);
      socket.sessionId = id;
      trackSocketCharacter(socket, null);
      console.log(`Socket ${socket.id} ${isResume ? 'resumed' : 'joined'} session ${id}`);

      if (isResume) {
        const history = await db.getSessionHistory(id);
        socket.emit('session_resumed', { sessionId: id, sessionToken: signSessionToken(id), history });
      } else {
        socket.emit('session_joined', { sessionId: id, sessionToken: signSessionToken(id) });
      }

    } catch (err) {
      console.error('join_session error:', err);
      if (sessionId && sessionToken && isValidSessionToken(sessionId, sessionToken)) {
        socket.emit('character_error', {
          step: 'session',
          field: 'sessionToken',
          message: 'The campaign connection hiccupped. Your session was not replaced; try again in a moment.',
        });
        return;
      }

      const fallbackId = uuidv4();
      try {
        await db.createSession(fallbackId);
        await db.initWorldState(fallbackId);
      } catch (dbErr) {
        console.error('join_session fallback DB error:', dbErr);
        socket.emit('error', { message: 'The campaign database is unavailable. Please try again in a minute.' });
        return;
      }
      socket.join(fallbackId);
      socket.sessionId = fallbackId;
      trackSocketCharacter(socket, null);
      socket.emit('session_joined', { sessionId: fallbackId, sessionToken: signSessionToken(fallbackId) });
    }
  });

  // ── session_start ─────────────────────────────────────────────────────
  // Generates the DM1 campaign opening for genuinely new sessions.
  // Guard: only valid on new sessions (history must be empty).
  // Never emit this on resume/reload — the session_resumed flow handles that.
  socket.on('session_start', async () => {
    const sessionId = socket.sessionId;
    if (!sessionId) return;

    if (activeDm1Sessions.has(sessionId)) return;
    activeDm1Sessions.add(sessionId);

    try {
      const existingCharacter = await db.getCharacterForSession(sessionId);
      if (!existingCharacter) {
        console.log(`session_start ignored — session ${sessionId} needs character creation first`);
        socket.emit('character_required', { message: 'Create a character before beginning the campaign.' });
        return;
      }

      // Safety guard — if there is already history, ignore this event
      const history = await db.getSessionHistory(sessionId);
      const narrativeHistory = history.filter((m) => m.role === 'player_dm1' || m.role === 'dm1');
      if (narrativeHistory.length > 0) {
        console.log(`session_start ignored — session ${sessionId} already has history`);
        return;
      }

      socket.emit('dm1_typing', true);

      const openingPrompt = 'Begin the campaign. Set the scene, establish the world and tone, and drop the player into their first moment of the adventure. End with an open prompt that invites their first action.';

      const { systemPrompt, messages } = await contextBuilder.build({
        sessionId,
        dm1Prompt:     DM1_PROMPT,
        playerMessage: openingPrompt,
        liveCharacterIds: getLiveCharacterIds(),
      });

      let dm1Reply, inputTokens, outputTokens;
      try {
        const response = await retryWithBackoff(() => ai.generateText({
          model:     DM1_MODEL,
          maxTokens: 2048,
          system:    systemPrompt,
          messages,
        }));
        dm1Reply     = response.text;
        inputTokens  = response.inputTokens;
        outputTokens = response.outputTokens;
      } catch (apiErr) {
        console.error('session_start DM1 API error:', apiErr.message);
        socket.emit('dm1_typing', false);
        socket.emit('error', { message: 'The Game Master encountered an error starting your session. Please refresh.' });
        return;
      }

      dm1Reply = await moderateAssistantReply(
        dm1Reply,
        'The road ahead is momentarily veiled. Try refreshing the adventure, and the Game Master will gather the threads again.'
      );

      // Save the opening as a DM1 message (no player_dm1 counterpart)
      await db.saveMessage(sessionId, 'dm1', dm1Reply, 0);

      socket.emit('dm1_typing', false);
      socket.emit('dm1_response', { message: dm1Reply });

      await db.logDmCall({
        sessionId,
        dm:           'dm1',
        model:        DM1_MODEL,
        playerInput:  '[session_start]',
        fullPrompt:   systemPrompt + '\n\n[MESSAGES]: ' + JSON.stringify(messages),
        dmResponse:   dm1Reply,
        inputTokens,
        outputTokens,
      }).catch(console.error);

      socket.emit('dm1_typing', true);
      await runPostResponsePipeline(sessionId, openingPrompt, dm1Reply, 0, socket).catch(console.error);
      socket.emit('dm1_typing', false);

    } catch (err) {
      console.error('session_start error:', err);
      socket.emit('dm1_typing', false);
      socket.emit('error', { message: 'The Game Master encountered an error. Please refresh.' });
    } finally {
      activeDm1Sessions.delete(sessionId);
    }
  });

  socket.on('get_character_data', async ({ sessionId, sessionToken } = {}) => {
    if (!hasValidSocketSession(socket, sessionId, sessionToken)) {
      socket.emit('character_error', {
        step: 'session',
        field: 'sessionToken',
        message: 'Your character sheet could not be opened for this session. Please refresh.',
      });
      return;
    }

    try {
      const campaign = await db.getOrCreateDefaultCampaign();
      const character = await db.getCharacterForSession(sessionId);
      const characters = await db.getAccessibleCharacters(sessionId);
      if (character) {
        trackSocketCharacter(socket, character.id);
        const inCombat = await getCombatActive(sessionId).catch(() => false);
        await db.upsertCharacterPresence({
          sessionId,
          characterId: character.id,
          presence: 'present',
          inCombat,
        }).catch(console.error);
        await syncCharacterToWorldState(sessionId, character.character_sheet, character.id).catch(console.error);
      } else {
        trackSocketCharacter(socket, null);
      }
      socket.emit('character_data', {
        campaign,
        content: getContentBundle(),
        characters: characters.map(summarizeCharacterForClient),
        character: character?.character_sheet || null,
        activeCharacterId: character?.id || null,
      });
    } catch (err) {
      console.error('get_character_data error:', err);
      socket.emit('character_error', {
        step: 'load',
        field: 'content',
        message: 'Character creation data is unavailable. Please try again.',
      });
    }
  });

  socket.on('roll_character_stats', ({ sessionId, sessionToken } = {}) => {
    if (!hasValidSocketSession(socket, sessionId, sessionToken)) {
      socket.emit('character_error', {
        step: 'abilities',
        field: 'rolledStats',
        message: 'The dice tray lost your session. Refresh, then roll again.',
      });
      return;
    }

    const attemptsUsed = (characterRollAttempts.get(sessionId) || 0) + 1;
    if (attemptsUsed > 3) {
      socket.emit('character_error', {
        step: 'abilities',
        field: 'rolledStats',
        message: 'You have used all 3 stat roll attempts. The dice are now unionized.',
      });
      return;
    }

    const currentSet = Array.from({ length: 6 }, rollAbilityStat);
    const acceptedSet = currentSet.map((entry) => entry.total);
    characterRollAttempts.set(sessionId, attemptsUsed);
    socket.emit('character_roll', {
      attemptsUsed,
      currentSet,
      acceptedSet,
      rollToken: signRollSet(sessionId, attemptsUsed, acceptedSet),
    });
  });

  socket.on('save_character', async ({ sessionId, sessionToken, characterDraft } = {}) => {
    if (!hasValidSocketSession(socket, sessionId, sessionToken)) {
      socket.emit('character_error', {
        step: 'session',
        field: 'sessionToken',
        message: 'Your character could not be saved for this session. Please refresh.',
      });
      return;
    }

    try {
      const campaign = await db.getOrCreateDefaultCampaign();
      const previousCharacter = await db.getCharacterForSession(sessionId).catch(() => null);
      const characterSheet = validateCharacter(characterDraft, getContentBundle(), {
        sessionId,
        campaignId: campaign.id,
        verifyRolledStats: (rolledStats) => verifyRollSet(sessionId, rolledStats),
      });
      const saved = await db.saveCharacterForSession(sessionId, characterSheet);
      const inCombat = await getCombatActive(sessionId);
      if (previousCharacter && previousCharacter.id !== saved.id) {
        untrackSocketCharacter(socket, previousCharacter.id);
        const previousStillLive = hasLiveCharacterSocket(previousCharacter.id);
        await db.upsertCharacterPresence({
          sessionId: inCombat || previousStillLive ? sessionId : null,
          characterId: previousCharacter.id,
          presence: inCombat || previousStillLive ? 'present' : 'away',
          inCombat,
        }).catch(console.error);
      }
      trackSocketCharacter(socket, saved.id);
      await db.upsertCharacterPresence({
        sessionId,
        characterId: saved.id,
        presence: 'present',
        inCombat,
      });
      await syncCharacterToWorldState(sessionId, saved.character_sheet, saved.id).catch(console.error);
      const history = await db.getSessionHistory(sessionId).catch(() => []);
      const shouldStartSession = !history.some((m) => m.role === 'player_dm1' || m.role === 'dm1');
      socket.emit('character_ready', {
        campaign,
        characterId: saved.id,
        character: saved.character_sheet,
        shouldStartSession,
      });
      if (!shouldStartSession) {
        await narratePartyChange(socket, sessionId, inCombat ? 'join_combat' : 'join', saved.character_sheet, saved.id);
      }
    } catch (err) {
      console.error('save_character error:', err);
      socket.emit('character_error', {
        step: err.step || 'review',
        field: err.field || 'character',
        message: err.message || 'Character validation failed.',
      });
    }
  });

  // ── story_input ───────────────────────────────────────────────────────
  // Phase 4B: character selection and party presence.
  socket.on('join_character', async ({ sessionId, sessionToken, characterId } = {}) => {
    if (!hasValidSocketSession(socket, sessionId, sessionToken)) {
      socket.emit('character_error', {
        step: 'select',
        field: 'sessionToken',
        message: 'Your character could not join this session. Please refresh.',
      });
      return;
    }

    try {
      const campaign = await db.getOrCreateDefaultCampaign();
      const previousCharacter = await db.getCharacterForSession(sessionId).catch(() => null);
      const character = await db.setActiveCharacterForSession(sessionId, characterId);
      if (!character) {
        socket.emit('character_error', {
          step: 'select',
          field: 'characterId',
          message: 'That character is not available to this session.',
        });
        return;
      }

      const inCombat = await getCombatActive(sessionId);
      if (previousCharacter && previousCharacter.id !== character.id) {
        untrackSocketCharacter(socket, previousCharacter.id);
        const previousStillLive = hasLiveCharacterSocket(previousCharacter.id);
        await db.upsertCharacterPresence({
          sessionId: inCombat || previousStillLive ? sessionId : null,
          characterId: previousCharacter.id,
          presence: inCombat || previousStillLive ? 'present' : 'away',
          inCombat,
        }).catch(console.error);
      }
      const previousPresence = await db.getCharacterPresence(character.id).catch(() => null);
      await db.upsertCharacterPresence({
        sessionId,
        characterId: character.id,
        presence: 'present',
        inCombat,
      });
      trackSocketCharacter(socket, character.id);
      await syncCharacterToWorldState(sessionId, character.character_sheet, character.id).catch(console.error);
      const history = await db.getSessionHistory(sessionId).catch(() => []);
      const shouldStartSession = !history.some((m) => m.role === 'player_dm1' || m.role === 'dm1');
      socket.emit('character_ready', {
        campaign,
        characterId: character.id,
        character: character.character_sheet,
        shouldStartSession,
      });

      const briefReconnect = previousPresence
        && previousPresence.session_id === sessionId
        && previousPresence.presence === 'away'
        && Date.now() - new Date(previousPresence.updated_at).getTime() < 5 * 60 * 1000;
      if (!briefReconnect && !shouldStartSession) {
        await narratePartyChange(socket, sessionId, inCombat ? 'join_combat' : 'join', character.character_sheet, character.id);
      }
    } catch (err) {
      console.error('join_character error:', err);
      socket.emit('character_error', {
        step: 'select',
        field: 'characterId',
        message: 'The character could not enter the scene. Try again.',
      });
    }
  });

  socket.on('leave_character', async ({ sessionId, sessionToken } = {}) => {
    if (!hasValidSocketSession(socket, sessionId, sessionToken)) {
      socket.emit('character_error', {
        step: 'select',
        field: 'sessionToken',
        message: 'Your character could not leave this session cleanly. Please refresh.',
      });
      return;
    }

    const characterId = socket.currentCharacterId;
    if (!characterId) return;

    try {
      const character = await db.getAccessibleCharacter(sessionId, characterId);
      if (!character) return;
      const inCombat = await getCombatActive(sessionId);
      untrackSocketCharacter(socket, characterId);
      const stillLive = hasLiveCharacterSocket(characterId);
      await db.upsertCharacterPresence({
        sessionId: inCombat || stillLive ? sessionId : null,
        characterId,
        presence: inCombat || stillLive ? 'present' : 'away',
        inCombat,
      });
      if (!inCombat && !stillLive) await db.clearActiveCharacterForSession(sessionId, characterId);
      socket.emit('character_left', { characterId, inCombat });
      await narratePartyChange(socket, sessionId, inCombat ? 'leave_combat' : 'leave', character.character_sheet, characterId);
    } catch (err) {
      console.error('leave_character error:', err);
    }
  });

  // Player narrative input.
  socket.on('story_input', async ({ message }) => {
    const sessionId = socket.sessionId;
    if (!sessionId) {
      socket.emit('error', { message: 'No active session. Please refresh.' });
      return;
    }

    if (activeDm1Sessions.has(sessionId)) {
      socket.emit('error', { message: 'The Game Master is still resolving your last action. Give the dice a second to stop clattering.' });
      return;
    }
    activeDm1Sessions.add(sessionId);

    try {
      await db.updateLastActive(sessionId);

      if (!(await moderateUserMessage(socket, 'error', message))) {
        return;
      }

      // Get pre-increment session_turn — both messages for this exchange share it
      const worldStateRow = await db.getWorldState(sessionId);
      const currentTurn   = worldStateRow?.state?.session_turn ?? 0;
      const activeCharacter = await db.getCharacterForSession(sessionId).catch(() => null);
      let activeWorldState = worldStateRow?.state || db.DEFAULT_WORLD_STATE;
      if (activeCharacter?.character_sheet) {
        trackSocketCharacter(socket, activeCharacter.id);
        await db.upsertCharacterPresence({
          sessionId,
          characterId: activeCharacter.id,
          presence: 'present',
          inCombat: Boolean(activeWorldState.combat_state?.active),
        }).catch(console.error);
        activeWorldState = normalizeActiveCharacterWorldState(activeWorldState, activeCharacter.character_sheet, activeCharacter.id);
        await db.updateWorldState(sessionId, activeWorldState);
      }

      const referee = resolveRefereeAction({
        message,
        worldState: activeWorldState,
        characterSheet: activeCharacter?.character_sheet || null,
        currentTurn,
      });
      if (referee?.handled) {
        await db.updateWorldState(sessionId, referee.worldState);
        await db.saveMessage(sessionId, 'player_dm1', message, currentTurn);
        await db.saveMessage(sessionId, 'dm1', referee.reply, currentTurn);
        const newTurn = await db.incrementSessionTurn(sessionId);
        socket.emit('dm1_response', { message: referee.reply });
        await db.logDmCall({
          sessionId,
          dm:           referee.logType || 'referee_core',
          model:        'deterministic',
          playerInput:  message,
          fullPrompt:   JSON.stringify({
            pending_roll: referee.worldState?.pending_roll || null,
            combat_state: referee.worldState?.combat_state || null,
            turn: currentTurn,
          }),
          dmResponse:   referee.reply,
          inputTokens:  null,
          outputTokens: null,
        }).catch(console.error);
        await syncCharacterFromWorldState(socket, sessionId).catch(console.error);
        if (newTurn > 0 && newTurn % 50 === 0) {
          await chapterSummarizer.summarize(sessionId, newTurn).catch(console.error);
        }
        return;
      }

      const spellAction = await handleDeterministicSpellAction(socket, sessionId, message);
      if (spellAction.handled) {
        return;
      }
      const effectiveWorldState = spellAction.worldState || activeWorldState;

      const mechanics = resolvePreNarration({ message, worldState: effectiveWorldState });
      if (mechanics.handled) {
        await db.saveMessage(sessionId, 'player_dm1', message, currentTurn);
        await db.saveMessage(sessionId, 'dm1', mechanics.response, currentTurn);
        await db.incrementSessionTurn(sessionId);
        socket.emit('dm1_response', { message: mechanics.response });
        await db.logDmCall({
          sessionId,
          dm:           mechanics.logType || 'mechanics_resolver',
          model:        'deterministic',
          playerInput:  message,
          fullPrompt:   JSON.stringify({ intent: mechanics.intent, worldState: effectiveWorldState || {} }),
          dmResponse:   mechanics.response,
          inputTokens:  null,
          outputTokens: null,
        }).catch(console.error);
        return;
      }

      if (!mechanics.skipSpatialGuard) {
        let spatialIssue = checkSpatialAction(message, effectiveWorldState);
        if (spatialIssue) {
          const recentHistory = await db.getRollingWindow(sessionId, 8).catch(() => []);
          const recentNarration = recentNarrationForSpatialGuard(recentHistory);
          if (recentNarration) {
            spatialIssue = checkSpatialAction(message, effectiveWorldState, { recentNarration });
          }
        }
        if (spatialIssue) {
          await db.saveMessage(sessionId, 'player_dm1', message, currentTurn);
          await db.saveMessage(sessionId, 'dm1', spatialIssue.message, currentTurn);
          await db.incrementSessionTurn(sessionId);
          socket.emit('dm1_response', { message: spatialIssue.message });
          await db.logDmCall({
            sessionId,
            dm:           'spatial_guard',
            model:        'deterministic',
            playerInput:  message,
            fullPrompt:   JSON.stringify({ intent: mechanics.intent, worldState: effectiveWorldState || {} }),
            dmResponse:   spatialIssue.message,
            inputTokens:  null,
            outputTokens: null,
          }).catch(console.error);
          return;
        }
      }

      // Save player message with pre-increment turn_number
      await db.saveMessage(sessionId, 'player_dm1', message, currentTurn);
      const dmPlayerMessage = mechanics.narrativeFrame
        ? `${message}\n\n${mechanics.narrativeFrame}`
        : message;

      // Assemble three-tier DM1 context
      const { systemPrompt, messages } = await contextBuilder.build({
        sessionId,
        dm1Prompt:     DM1_PROMPT,
        playerMessage: dmPlayerMessage,
        liveCharacterIds: getLiveCharacterIds(),
      });

      socket.emit('dm1_typing', true);

      let dm1Reply, inputTokens, outputTokens;
      try {
        const response = await retryWithBackoff(() => ai.generateText({
          model:     DM1_MODEL,
          maxTokens: 2048,
          system:    systemPrompt,
          messages,
        }));
        dm1Reply     = response.text;
        inputTokens  = response.inputTokens;
        outputTokens = response.outputTokens;

      } catch (apiErr) {
        // DM1 API failure — emit error, leave orphaned player_dm1 in DB,
        // do NOT increment session_turn (spec §12).
        console.error('DM1 API error:', apiErr.message);
        socket.emit('dm1_typing', false);
        socket.emit('error', { message: 'The Game Master encountered an error. Please try again.' });

        // Store assembled prompt; append error details (spec §12)
        const fullPromptForLog = [
          systemPrompt,
          '[MESSAGES]: ' + JSON.stringify(messages),
          '[ERROR]: '    + (apiErr.message || String(apiErr)),
        ].join('\n\n');

        await db.logDmCall({
          sessionId,
          dm:           'dm1',
          model:        DM1_MODEL,
          playerInput:  message,
          fullPrompt:   fullPromptForLog,
          dmResponse:   null,
          inputTokens:  null,
          outputTokens: null,
        }).catch(console.error);
        return;
      }

      dm1Reply = await moderateAssistantReply(
        dm1Reply,
        'The Game Master lowers the screen and stares at you over it. That idea has been denied entry to the campaign, the tavern, and polite society. Try something else.'
      );

      const narrativeClock = advanceNarrativeTime({
        message,
        dmReply: dm1Reply,
        worldState: effectiveWorldState || worldStateRow?.state || db.DEFAULT_WORLD_STATE,
        characterSheet: activeCharacter?.character_sheet || null,
      });
      if (narrativeClock.replySuffix) {
        dm1Reply += narrativeClock.replySuffix;
      }
      await db.updateWorldState(sessionId, narrativeClock.worldState);

      // Save DM1 response with the SAME pre-increment turn_number (spec §3.2)
      await db.saveMessage(sessionId, 'dm1', dm1Reply, currentTurn);

      // Increment session_turn AFTER both messages are saved (spec §10.2)
      const newTurn = await db.incrementSessionTurn(sessionId);

      socket.emit('dm1_typing', false);
      socket.emit('dm1_response', { message: dm1Reply });

      await db.logDmCall({
        sessionId,
        dm:           'dm1',
        model:        DM1_MODEL,
        playerInput:  message,
        fullPrompt:   systemPrompt + '\n\n[MESSAGES]: ' + JSON.stringify(messages),
        dmResponse:   dm1Reply,
        inputTokens,
        outputTokens,
      }).catch(console.error);

      // Keep the turn lock until world state catches up, after the reply is visible.
      socket.emit('dm1_typing', true);
      await runPostResponsePipeline(sessionId, message, dm1Reply, newTurn, socket).catch(console.error);
      socket.emit('dm1_typing', false);

    } catch (err) {
      console.error('story_input error:', err);
      socket.emit('dm1_typing', false);
      socket.emit('error', { message: 'The Game Master encountered an error. Please try again.' });
    } finally {
      activeDm1Sessions.delete(sessionId);
    }
  });

  // ── rules_input ───────────────────────────────────────────────────────
  socket.on('rules_input', async ({ message }) => {
    const sessionId = socket.sessionId;
    if (!sessionId) {
      socket.emit('dm2_error', { message: 'No active session. Please refresh.' });
      return;
    }

    try {
      if (!(await moderateUserMessage(socket, 'dm2_error', message))) {
        return;
      }

      // Step 1: update last active
      try {
        await db.updateLastActive(sessionId);
      } catch (dbErr) {
        console.error('rules_input: db.updateLastActive failed:', dbErr.message);
        throw dbErr;
      }

      // Step 2: save player DM2 message — no turn_number (DM2 is stateless)
      try {
        await db.saveMessage(sessionId, 'player_dm2', message, null);
      } catch (dbErr) {
        console.error('rules_input: db.saveMessage(player_dm2) failed:', dbErr.message);
        throw dbErr;
      }

      // Step 3: Fetch world state for context injection (spec §8.5)
      // If this fails, fall back gracefully — DM2 still answers without context.
      let worldStateContext = '';
      try {
        const worldStateRow = await db.getWorldState(sessionId);
        const ws = worldStateRow?.state;
        if (ws) {
          const contextParts = [];
          if (ws.current_location) {
            contextParts.push(`Current location: ${ws.current_location}`);
          }
          if (ws.scene_presence?.exact_location) {
            const scene = ws.scene_presence;
            contextParts.push(`Exact scene: ${scene.exact_location}`);
            if (scene.present_npcs?.length) contextParts.push(`NPCs physically present: ${scene.present_npcs.join(', ')}`);
            if (scene.present_objects?.length) contextParts.push(`Objects present: ${scene.present_objects.join(', ')}`);
            if (scene.available_exits?.length) contextParts.push(`Available exits: ${scene.available_exits.join(', ')}`);
          }
          const activeNpcs = (ws.npcs_encountered || []).filter((n) => n?.name);
          if (activeNpcs.length > 0) {
            contextParts.push(`NPCs present: ${activeNpcs.map((n) => `${n.name} (${n.disposition || 'unknown'})`).join(', ')}`);
          }
          if (ws.active_effects?.length) {
            contextParts.push(`Active effects: ${formatRulesActiveEffects(ws.active_effects)}`);
          }
          if (ws.combat_state && ws.combat_state.active) {
            contextParts.push(`COMBAT ACTIVE — Round ${ws.combat_state.round}. Combatants: ${
              (ws.combat_state.combatants || [])
                .map((c) => `${c.name} (HP: ${c.hp}/${c.max_hp}, Initiative: ${c.initiative}${c.conditions?.length ? ', conditions: ' + c.conditions.join(', ') : ''})`)
                .join('; ')
            }`);
          }
          if (ws.player_stats) {
            const ps = ws.player_stats;
            const statParts = [];
            if (ps.name) statParts.push(`Name: ${ps.name}`);
            if (ps.class) statParts.push(`Class: ${ps.class} (level ${ps.level || 1})`);
            if (ps.hp !== null) statParts.push(`HP: ${ps.hp}/${ps.max_hp}`);
            if (ps.armor_class) statParts.push(`AC: ${ps.armor_class}`);
            if (ps.speed) statParts.push(`Speed: ${ps.speed} ft`);
            if (ps.alignment) statParts.push(`Alignment: ${ps.alignment}`);
            if (ps.appearance) statParts.push(`Appearance: ${ps.appearance}`);
            if (ps.personality) statParts.push(`Personality: ${ps.personality}`);
            if (ps.backstory) statParts.push(`Backstory: ${ps.backstory}`);
            if (ps.languages?.length) statParts.push(`Languages: ${ps.languages.join(', ')}`);
            if (ps.resistances?.length) statParts.push(`Resistances: ${ps.resistances.join(', ')}`);
            if (ps.species_spells?.length) statParts.push(`Species spells: ${ps.species_spells.join(', ')}`);
            if (ps.class_cantrips?.length) statParts.push(`Class cantrips: ${ps.class_cantrips.join(', ')}`);
            if (ps.class_spells?.length) statParts.push(`Class spells: ${ps.class_spells.join(', ')}`);
            const originMagic = Object.values(ps.origin_magic || {});
            if (originMagic.length) {
              const originSpellText = originMagic.flatMap((choice) => [
                ...(choice.cantrips || []).map((spell) => `cantrip ${spell}`),
                choice.spell ? `level 1 ${choice.spell}` : null,
              ].filter(Boolean));
              if (originSpellText.length) statParts.push(`Origin magic: ${originSpellText.join(', ')}`);
            }
            if (ps.conditions?.length) statParts.push(`Conditions: ${ps.conditions.join(', ')}`);
            if (ps.ammunition && Object.keys(ps.ammunition).length > 0) {
              statParts.push(`Ammunition: ${Object.values(ps.ammunition).map((item) => `${item.name || item.id} ${item.remaining}`).join(', ')}`);
            }
            // Include weapon and ability scores so DM2 can answer damage/attack questions without asking.
            if (ps.weapon_name) statParts.push(`Weapon: ${ps.weapon_name}`);
            if (ps.ability_scores && Object.keys(ps.ability_scores).length > 0) {
              const modStr = Object.entries(ps.ability_scores)
                .map(([k, v]) => `${k.toUpperCase()} ${v >= 0 ? '+' : ''}${v}`)
                .join(', ');
              statParts.push(`Ability modifiers: ${modStr}`);
            }
            if (statParts.length > 0) contextParts.push(`Player: ${statParts.join(', ')}`);
          }
          if (contextParts.length > 0) {
            worldStateContext = '\n\n[CURRENT GAME CONTEXT]\n' + contextParts.join('\n');
          }
        }

        const activeCharacter = await db.getCharacterForSession(sessionId);
        if (activeCharacter?.id) {
          trackSocketCharacter(socket, activeCharacter.id);
          await db.upsertCharacterPresence({
            sessionId,
            characterId: activeCharacter.id,
            presence: 'present',
            inCombat: Boolean(ws?.combat_state?.active),
          }).catch(console.error);
        }
        const characterSheetContext = summarizeCharacterSheetForRules(activeCharacter?.character_sheet);
        if (characterSheetContext) {
          worldStateContext += '\n\n[ACTIVE CHARACTER SHEET]\n' + characterSheetContext;
        }
      } catch (wsErr) {
        console.warn('rules_input: world state fetch failed (non-fatal):', wsErr.message);
      }

      // Step 4: Call DM2 (utility model — with world state context injected)
      socket.emit('dm2_typing', true);

      let response;
      try {
        const dm2UserMessage = message + worldStateContext;
        response = await retryWithBackoff(() => ai.generateText({
          model:     UTILITY_MODEL,
          maxTokens: 1024,
          system:    DM2_PROMPT,
          messages:  [{ role: 'user', content: dm2UserMessage }],
        }));
      } catch (apiErr) {
        console.error('rules_input: AI provider call failed:', apiErr.message, '| status:', apiErr.status, '| error:', JSON.stringify(apiErr.error));
        socket.emit('dm2_typing', false);
        socket.emit('dm2_error', { message: 'The Rules Arbiter encountered an error. Please try again.' });
        await db.logDmCall({
          sessionId,
          dm:           'dm2',
          model:        UTILITY_MODEL,
          playerInput:  message,
          fullPrompt:   DM2_PROMPT + '\n\n' + message + worldStateContext + '\n\n[ERROR]: ' + (apiErr.message || String(apiErr)),
          dmResponse:   null,
          inputTokens:  null,
          outputTokens: null,
        }).catch(console.error);
        return;
      }

      const reply     = response.text;
      const inputTok  = response.inputTokens;
      const outputTok = response.outputTokens;
      const safeReply = await moderateAssistantReply(
        reply,
        'The Rules Arbiter declines. Repeating the request will not unlock a secret answer; it will only make the silence more judgmental. Ask a fantasy rules question instead.'
      );

      // Step 5: save DM2 response
      try {
        await db.saveMessage(sessionId, 'dm2', safeReply, null);
      } catch (dbErr) {
        console.error('rules_input: db.saveMessage(dm2) failed:', dbErr.message);
        // Non-fatal: response was received — still emit to client
      }

      socket.emit('dm2_typing', false);
      socket.emit('dm2_response', { message: safeReply });

      await db.logDmCall({
        sessionId,
        dm:           'dm2',
        model:        UTILITY_MODEL,
        playerInput:  message,
        fullPrompt:   DM2_PROMPT + '\n\n' + message + worldStateContext,
        dmResponse:   safeReply,
        inputTokens:  inputTok,
        outputTokens: outputTok,
      }).catch(console.error);

    } catch (err) {
      console.error('rules_input error:', err.message, err);
      socket.emit('dm2_typing', false);
      socket.emit('dm2_error', { message: 'The Rules Arbiter encountered an error. Please try again.' });
    }
  });

  socket.on('disconnect', async () => {
    console.log(`Client disconnected: ${socket.id}`);
    if (!socket.sessionId || !socket.currentCharacterId) return;

    try {
      const characterId = socket.currentCharacterId;
      untrackSocketCharacter(socket, characterId);
      const inCombat = await getCombatActive(socket.sessionId);
      if (!inCombat && hasLiveCharacterSocket(characterId)) return;
      await db.upsertCharacterPresence({
        sessionId: socket.sessionId,
        characterId,
        presence: inCombat ? 'present' : 'away',
        inCombat,
      });
    } catch (err) {
      console.error('disconnect presence error:', err);
    }
  });
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Start server ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Hallucinated Dungeons server running on port ${PORT}`);
});
