const {
  getSelectedWeaponMastery,
  stripPositiveAbilityModifier,
} = require('./weaponRulesEngine');

function getCleaveExtraAttack({
  characterSheet = {},
  attack = {},
  primaryTarget = null,
  combat = {},
  message = '',
} = {}) {
  if (!wantsCleaveAttack(message)) return null;
  if (getSelectedWeaponMastery(characterSheet, attack) !== 'cleave' || attack.attackKind !== 'melee') {
    return blocked('That attack cannot use Cleave. Choose a melee weapon whose Cleave mastery is unlocked on this character sheet.');
  }
  if (combat.turn_resources?.cleave_used) {
    return blocked('Cleave has already been used this turn. The axe has submitted its one permitted sequel.');
  }

  const target = findDeclaredCleaveTarget(combat, message, primaryTarget);
  if (!target) {
    return blocked('Cleave needs a named second creature. Declare which other nearby combatant you want to attack.');
  }

  const spatial = checkCleaveSpatialEligibility({
    player: (combat.combatants || []).find((combatant) => combatant.is_player),
    primaryTarget,
    secondaryTarget: target,
    attack,
  });
  if (!spatial.ok) return blocked(spatial.reply);

  const abilityModifier = Number(characterSheet.abilities?.modifiers?.[attack.ability] || 0);
  return {
    ok: true,
    target,
    spatial,
    attack: {
      ...attack,
      damageFormula: stripPositiveAbilityModifier(attack.damageFormula, abilityModifier, abilityModifier < 0),
      isCleaveExtraAttack: true,
    },
  };
}

function markCleaveUsed(combat = {}) {
  return {
    ...combat,
    turn_resources: {
      ...(combat.turn_resources || {}),
      cleave_used: true,
    },
  };
}

function findDeclaredCleaveTarget(combat = {}, message = '', primaryTarget = null) {
  const text = normalizePhrase(message);
  return (combat.combatants || [])
    .filter((combatant) => !combatant.is_player && combatant !== primaryTarget && Number(combatant.hp) > 0)
    .find((combatant) => text.includes(normalizePhrase(combatant.name))) || null;
}

function checkCleaveSpatialEligibility({ player = {}, primaryTarget = {}, secondaryTarget = {}, attack = {} } = {}) {
  const playerPosition = getHexPosition(player);
  const primaryPosition = getHexPosition(primaryTarget);
  const secondaryPosition = getHexPosition(secondaryTarget);
  if (!playerPosition || !primaryPosition || !secondaryPosition) {
    return {
      ok: true,
      mode: 'scene_zone_assumption',
      reply: 'Map coordinates are not active, so the referee treats the declared second combatant as nearby for this scene.',
    };
  }
  if (!sameMap(playerPosition, primaryPosition, secondaryPosition)) {
    return {
      ok: false,
      mode: 'hex',
      reply: 'Cleave cannot reach a creature on a different map or encounter layer.',
    };
  }

  const adjacentToPrimary = hexDistance(primaryPosition, secondaryPosition) <= 1;
  const withinReach = hexDistance(playerPosition, secondaryPosition) * getFeetPerHex(secondaryPosition) <= getWeaponReach(attack);
  if (!adjacentToPrimary || !withinReach) {
    return {
      ok: false,
      mode: 'hex',
      reply: 'Cleave needs the second creature within 5 feet of the first creature and within your weapon reach.',
    };
  }
  return { ok: true, mode: 'hex' };
}

function wantsCleaveAttack(message = '') {
  return /\b(?:cleave|cleaving|sweep|sweeping|follow through)\b/i.test(String(message || ''));
}

function getHexPosition(combatant = {}) {
  const position = combatant.position || combatant.map_position || null;
  if (!position || position.q === null || position.q === undefined || position.r === null || position.r === undefined) return null;
  const q = Number(position.q);
  const r = Number(position.r);
  if (!Number.isFinite(q) || !Number.isFinite(r)) return null;
  return { ...position, q, r };
}

function sameMap(...positions) {
  const ids = positions.map((position) => position.map_id).filter(Boolean);
  return new Set(ids).size <= 1;
}

function hexDistance(left, right) {
  const dq = Number(left.q) - Number(right.q);
  const dr = Number(left.r) - Number(right.r);
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

function getFeetPerHex(position = {}) {
  return Number(position.feet_per_hex || 5);
}

function getWeaponReach(attack = {}) {
  return (attack.properties || []).includes('reach') ? 10 : 5;
}

function blocked(reply) {
  return { ok: false, reply };
}

function normalizePhrase(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

module.exports = {
  checkCleaveSpatialEligibility,
  findDeclaredCleaveTarget,
  getCleaveExtraAttack,
  hexDistance,
  markCleaveUsed,
  wantsCleaveAttack,
};
