const { spendTurnResource } = require('./actionEconomy');
const { getCombatantDistanceFeet, getFeetPerHex, getHexPosition, hexDistance, sameMap } = require('./combatPositionEngine');
const { applyDamage, formatDamageAdjustment, rollDamageFormula } = require('./damageHealingEngine');
const { buildResourceState, spendResource } = require('./resourceEngine');

const HIT_RIDERS = new Set(['fire', 'frost', 'hill']);
const REACTIONS = new Set(['stone', 'storm']);
const LARGE_OR_SMALLER = new Set(['tiny', 'small', 'medium', 'large']);

const ANCESTRIES = {
  cloud: { name: "Cloud's Jaunt" },
  fire: { name: "Fire's Burn" },
  frost: { name: "Frost's Chill" },
  hill: { name: "Hill's Tumble" },
  stone: { name: "Stone's Endurance" },
  storm: { name: "Storm's Thunder" },
};

function resolveGiantAncestryAction({
  message = '',
  worldState = {},
  characterSheet = {},
  destination = null,
} = {}) {
  const intent = getGiantAncestryIntent(message, characterSheet);
  if (!intent) return null;
  if (!isGoliath(characterSheet)) return wrongSpecies(worldState);

  const selected = getSelectedGiantAncestry(characterSheet);
  if (!selected) {
    return blocked(worldState, 'Choose a Giant Ancestry boon on the character sheet before trying to use one.');
  }
  if (intent.id !== selected) {
    return blocked(worldState, `${ancestryName(intent.id)} is not this Goliath's chosen Giant Ancestry boon. Your sheet carries **${ancestryName(selected)}**.`);
  }

  if (intent.id === 'cloud') {
    return resolveCloudJaunt({ message, worldState, characterSheet, destination });
  }
  if (REACTIONS.has(intent.id)) {
    return primeGiantAncestryReaction({ ancestry: intent.id, worldState, characterSheet });
  }
  if (HIT_RIDERS.has(intent.id) && !hasAttackDeclaration(message)) {
    return {
      handled: true,
      logType: 'species_giant_ancestry_hit_rider_instruction',
      worldState,
      reply: `Declare **${ancestryName(intent.id)}** as part of an attack. The referee will spend the use only if the attack roll hits and deals damage.`,
    };
  }
  return null;
}

function applyGiantAncestryOnHit({
  message = '',
  target = {},
  combat = {},
  worldState = {},
  characterSheet = {},
  damageDealt = 0,
  crit = false,
  rollDie = defaultRollDie,
} = {}) {
  const requested = getRequestedHitRider(message, characterSheet);
  if (!requested || Number(damageDealt || 0) <= 0 || Number(target.hp || 0) <= 0) {
    return unchanged({ combat, worldState });
  }
  if (!isGoliath(characterSheet)) {
    return unchanged({ combat, worldState, lines: ['**Giant Ancestry:** that boon is not on this character sheet.'] });
  }

  const selected = getSelectedGiantAncestry(characterSheet);
  if (requested !== selected) {
    return unchanged({
      combat,
      worldState,
      lines: [`**Giant Ancestry:** ${ancestryName(requested)} is not your chosen boon. Your sheet carries **${ancestryName(selected)}**.`],
    });
  }
  if (worldState.combat_state?.turn_resources?.giant_ancestry_hit_rider_used) {
    return unchanged({ combat, worldState });
  }
  if (requested === 'hill' && !canTumble(target)) {
    return unchanged({
      combat,
      worldState,
      lines: [`**Hill's Tumble:** ${target.name} is too large to knock Prone with this boon, so the use is not spent.`],
    });
  }

  const spent = spendGiantAncestryUse({ worldState, characterSheet });
  if (!spent.ok) {
    return unchanged({ combat, worldState, lines: [`**${ancestryName(requested)}:** no Giant Ancestry uses remain until a Long Rest.`] });
  }

  const nextState = markHitRiderUsed(spent.worldState);
  if (requested === 'fire') {
    const damage = rollDamageFormula('1d10', rollDie, { crit });
    const applied = applyDamage({ target, amount: damage.total, damageType: 'fire', source: ancestryName(requested) });
    Object.assign(target, applied.target);
    return {
      combat: nextState.combat_state || combat,
      worldState: nextState,
      lines: [`**Fire's Burn:** giant fire adds ${applied.amount} fire damage${formatDamageAdjustment(applied.adjustment)}. ${target.name}: (${applied.beforeHp} -> ${applied.afterHp} HP).`],
    };
  }
  if (requested === 'frost') {
    const damage = rollDamageFormula('1d6', rollDie, { crit });
    const applied = applyDamage({ target, amount: damage.total, damageType: 'cold', source: ancestryName(requested) });
    Object.assign(target, applied.target);
    addFrostChill(target, combat);
    return {
      combat: nextState.combat_state || combat,
      worldState: nextState,
      lines: [`**Frost's Chill:** giant cold adds ${applied.amount} cold damage${formatDamageAdjustment(applied.adjustment)} and reduces ${target.name}'s Speed by 10 feet until the start of your next turn. ${target.name}: (${applied.beforeHp} -> ${applied.afterHp} HP).`],
    };
  }

  target.conditions = uniqueValues([...(target.conditions || []), 'prone']);
  return {
    combat: nextState.combat_state || combat,
    worldState: nextState,
    lines: [`**Hill's Tumble:** ${target.name} falls **prone**.`],
  };
}

function applyPrimedGiantAncestryDamageReduction({
  player = {},
  worldState = {},
  characterSheet = {},
  incomingDamage = 0,
  rollDie = defaultRollDie,
} = {}) {
  const primed = getPrimedReaction(worldState);
  if (!primed || primed.ancestry !== 'stone' || Number(incomingDamage || 0) <= 0) {
    return { player, worldState, incomingDamage, lines: [] };
  }
  const spent = spendGiantAncestryReaction({ worldState, characterSheet, ancestry: 'stone' });
  if (!spent.ok) return { player, worldState, incomingDamage, lines: spent.lines };

  const roll = rollDamageFormula('1d12', rollDie);
  const con = Number(characterSheet.abilities?.modifiers?.con || 0);
  const reduction = Math.max(0, roll.total + con);
  return {
    player,
    worldState: spent.worldState,
    incomingDamage: Math.max(0, Number(incomingDamage || 0) - reduction),
    lines: [`**Stone's Endurance:** your Reaction reduces the incoming damage by ${reduction} (${roll.total}${formatSigned(con)}).`],
  };
}

function applyPrimedGiantAncestryRetaliation({
  actor = {},
  worldState = {},
  characterSheet = {},
  damageTaken = 0,
  rollDie = defaultRollDie,
} = {}) {
  const primed = getPrimedReaction(worldState);
  if (!primed || primed.ancestry !== 'storm' || Number(damageTaken || 0) <= 0 || !isWithinStormRange(actor, worldState)) {
    return { actor, worldState, lines: [] };
  }
  const spent = spendGiantAncestryReaction({ worldState, characterSheet, ancestry: 'storm' });
  if (!spent.ok) return { actor, worldState, lines: spent.lines };

  const damage = rollDamageFormula('1d8', rollDie);
  const applied = applyDamage({ target: actor, amount: damage.total, damageType: 'thunder', source: ancestryName('storm') });
  return {
    actor: applied.target,
    worldState: spent.worldState,
    lines: [`**Storm's Thunder:** your Reaction answers with ${applied.amount} thunder damage${formatDamageAdjustment(applied.adjustment)}. ${actor.name}: (${applied.beforeHp} -> ${applied.afterHp} HP).`],
  };
}

function expireGiantAncestryEffects(combat = {}, { timing, round } = {}) {
  return {
    ...combat,
    combatants: (combat.combatants || []).map((combatant) => {
      const current = combatant.ancestry_effects || [];
      const retained = (combatant.ancestry_effects || []).filter((effect) => !(
        effect.expires === timing && Number(effect.expires_round || 0) <= Number(round || 0)
      ));
      if (current.length === 0) return combatant;
      return {
        ...combatant,
        ancestry_effects: retained,
        speed_penalty: getCombinedSpeedPenalty({ ...combatant, ancestry_effects: retained }),
      };
    }),
  };
}

function resolveCloudJaunt({ message, worldState, characterSheet, destination }) {
  const feet = getDeclaredFeet(message, 30);
  if (feet > 30) return blocked(worldState, "Cloud's Jaunt can teleport up to 30 feet. Choose a nearer destination.");

  const spentAction = spendTurnResource(worldState, 'bonus_action', "Cloud's Jaunt", characterSheet);
  if (!spentAction.ok) return blocked(spentAction.worldState, spentAction.reply);
  const spent = spendGiantAncestryUse({ worldState: spentAction.worldState, characterSheet });
  if (!spent.ok) return blocked(worldState, "Cloud's Jaunt has no Giant Ancestry uses left until a Long Rest.");

  const moved = recordTeleport({
    worldState: spent.worldState,
    destination,
    feet,
    source: ancestryName('cloud'),
  });
  if (!moved.ok) return blocked(worldState, moved.reply);
  return {
    handled: true,
    logType: 'species_giant_ancestry_cloud',
    worldState: moved.worldState,
    reply: `You use **Cloud's Jaunt** as a Bonus Action and magically teleport ${moved.feet} feet${moved.destinationText}. Uses left: ${remainingUses(moved.worldState, characterSheet)}.`,
  };
}

function primeGiantAncestryReaction({ ancestry, worldState, characterSheet }) {
  const resources = buildResourceState(characterSheet, worldState);
  if (Number(resources.giant_ancestry?.remaining || 0) <= 0) {
    return blocked(worldState, `${ancestryName(ancestry)} has no Giant Ancestry uses left until a Long Rest.`);
  }
  return {
    handled: true,
    logType: 'species_giant_ancestry_reaction_primed',
    worldState: {
      ...worldState,
      player_stats: {
        ...(worldState.player_stats || {}),
        giant_ancestry_reaction: {
          ancestry,
          name: ancestryName(ancestry),
          primed: true,
        },
      },
    },
    reply: `**${ancestryName(ancestry)}** is primed. The referee will spend your Reaction and one Giant Ancestry use when its damage trigger occurs.`,
  };
}

function spendGiantAncestryReaction({ worldState, characterSheet, ancestry }) {
  const resources = buildResourceState(characterSheet, worldState);
  if (Number(resources.giant_ancestry?.remaining || 0) <= 0) {
    return { ok: false, lines: [`**${ancestryName(ancestry)}:** no Giant Ancestry uses remain.`] };
  }
  const spentAction = spendTurnResource(worldState, 'reaction', ancestryName(ancestry), characterSheet);
  if (!spentAction.ok) return { ok: false, lines: [`**${ancestryName(ancestry)}:** ${spentAction.reply}`] };
  const spent = spendGiantAncestryUse({ worldState: spentAction.worldState, characterSheet });
  if (!spent.ok) return { ok: false, lines: [`**${ancestryName(ancestry)}:** no Giant Ancestry uses remain.`] };
  return {
    ok: true,
    worldState: clearPrimedReaction(spent.worldState),
    lines: [],
  };
}

function spendGiantAncestryUse({ worldState, characterSheet }) {
  return spendResource({ worldState, characterSheet, resource: 'giant_ancestry' });
}

function markHitRiderUsed(worldState = {}) {
  if (!worldState.combat_state?.active) return worldState;
  return {
    ...worldState,
    combat_state: {
      ...worldState.combat_state,
      turn_resources: {
        ...(worldState.combat_state.turn_resources || {}),
        giant_ancestry_hit_rider_used: true,
      },
    },
  };
}

function clearPrimedReaction(worldState = {}) {
  return {
    ...worldState,
    player_stats: {
      ...(worldState.player_stats || {}),
      giant_ancestry_reaction: null,
    },
  };
}

function getPrimedReaction(worldState = {}) {
  const reaction = worldState.player_stats?.giant_ancestry_reaction;
  return reaction?.primed ? reaction : null;
}

function recordTeleport({ worldState = {}, destination = null, feet = 0, source }) {
  const combat = worldState.combat_state?.active ? clone(worldState.combat_state) : worldState.combat_state;
  const player = combat?.active ? combat.combatants.find((combatant) => combatant.is_player) : null;
  const from = getHexPosition(player || {});
  let mode = 'scene_zone_assumption';
  let actualFeet = Number(feet || 0);
  let destinationText = ' to a visible unoccupied space';

  if (destination && from) {
    if (!sameMap(from, destination)) return { ok: false, reply: "Cloud's Jaunt cannot cross into a different map or encounter layer." };
    actualFeet = hexDistance(from, destination) * getFeetPerHex(from, destination);
    if (actualFeet > 30) return { ok: false, reply: "Cloud's Jaunt can teleport up to 30 feet. Choose a nearer destination." };
    if (isOccupied(combat, destination, player)) return { ok: false, reply: "Cloud's Jaunt needs an unoccupied destination." };
    player.position = { ...from, ...destination };
    mode = 'hex';
    destinationText = ` to hex (${destination.q}, ${destination.r})`;
  }

  const movement = { type: 'teleport', source, feet: actualFeet, mode, from, to: destination || null };
  if (player) player.last_movement = movement;
  return {
    ok: true,
    feet: actualFeet,
    destinationText,
    worldState: {
      ...worldState,
      combat_state: combat,
      player_stats: {
        ...(worldState.player_stats || {}),
        last_movement: movement,
      },
    },
  };
}

function isOccupied(combat = {}, destination, player) {
  return (combat.combatants || []).some((combatant) => {
    if (combatant === player || Number(combatant.hp || 0) <= 0) return false;
    const position = getHexPosition(combatant);
    return position && sameMap(position, destination) && position.q === Number(destination.q) && position.r === Number(destination.r);
  });
}

function getGiantAncestryIntent(message = '', characterSheet = {}) {
  const normalized = normalizeId(message);
  for (const id of Object.keys(ANCESTRIES)) {
    if (normalized.includes(normalizeId(ancestryName(id)))) return { id };
  }
  if (normalized.includes('giant_ancestry')) {
    const selected = getSelectedGiantAncestry(characterSheet);
    return selected ? { id: selected } : { id: null };
  }
  return null;
}

function getRequestedHitRider(message = '', characterSheet = {}) {
  const intent = getGiantAncestryIntent(message, characterSheet);
  return HIT_RIDERS.has(intent?.id) ? intent.id : null;
}

function getSelectedGiantAncestry(characterSheet = {}) {
  return normalizeId(characterSheet.species_choices?.giant_ancestry);
}

function addFrostChill(target, combat = {}) {
  const effect = {
    type: 'frost_chill',
    speed_penalty: 10,
    expires: 'start_of_player_turn',
    expires_round: Number(combat.round || 1) + 1,
  };
  target.ancestry_effects = [...(target.ancestry_effects || []).filter((item) => item.type !== effect.type), effect];
  target.speed_penalty = getCombinedSpeedPenalty(target);
}

function getCombinedSpeedPenalty(target = {}) {
  return [...(target.ancestry_effects || []), ...(target.mastery_effects || [])]
    .reduce((total, effect) => total + Number(effect.speed_penalty || 0), 0);
}

function isWithinStormRange(actor = {}, worldState = {}) {
  const player = worldState.combat_state?.combatants?.find((combatant) => combatant.is_player);
  const distance = getCombatantDistanceFeet(player || {}, actor);
  return distance === null || (Number.isFinite(distance) && distance <= 60);
}

function canTumble(target = {}) {
  const size = normalizeId(target.size);
  return !size || LARGE_OR_SMALLER.has(size);
}

function hasAttackDeclaration(message = '') {
  return /\b(?:attack|strike|hit|shoot|stab|slash|swing|throw|hurl|punch|kick|cast)\b/i.test(String(message || ''));
}

function getDeclaredFeet(message = '', fallback = 0) {
  const match = String(message || '').match(/\b(\d+)\s*(?:feet|foot|ft)\b/i);
  return match ? Number(match[1]) : Number(fallback || 0);
}

function remainingUses(worldState = {}, characterSheet = {}) {
  return Number(buildResourceState(characterSheet, worldState).giant_ancestry?.remaining || 0);
}

function ancestryName(id) {
  return ANCESTRIES[id]?.name || 'Giant Ancestry';
}

function wrongSpecies(worldState) {
  return blocked(worldState, 'Giant Ancestry is a Goliath feature and is not on this character sheet. The family tree checked its notes.');
}

function blocked(worldState, reply) {
  return { handled: true, logType: 'species_giant_ancestry_blocked', worldState, reply };
}

function unchanged({ combat, worldState, lines = [] }) {
  return { combat, worldState, lines };
}

function uniqueValues(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function formatSigned(value) {
  const number = Number(value || 0);
  return number >= 0 ? `+${number}` : String(number);
}

function isGoliath(characterSheet = {}) {
  return normalizeId(characterSheet.identity?.species) === 'goliath';
}

function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultRollDie(sides) {
  return Math.ceil(Math.random() * Number(sides || 20));
}

module.exports = {
  applyGiantAncestryOnHit,
  applyPrimedGiantAncestryDamageReduction,
  applyPrimedGiantAncestryRetaliation,
  expireGiantAncestryEffects,
  getGiantAncestryIntent,
  getSelectedGiantAncestry,
  resolveGiantAncestryAction,
};
