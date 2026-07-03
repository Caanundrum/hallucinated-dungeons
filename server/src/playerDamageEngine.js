const { applyDamage } = require('./damageHealingEngine');
const { buildResourceState, spendResource } = require('./resourceEngine');
const { spendTurnResource } = require('./actionEconomy');

function applyDamageToPlayer({
  player = {},
  characterSheet = {},
  worldState = {},
  damage = 0,
  damageType = null,
  source = null,
} = {}) {
  const slowFall = applySlowFall({ characterSheet, worldState, damage, source });
  const target = buildPlayerDamageTarget({ player, characterSheet, worldState: slowFall.worldState });
  const applied = applyDamage({ target, amount: slowFall.damage, damageType, source });
  const safeguarded = applyFatalPlayerDamageSafeguards({
    player: applied.target,
    characterSheet,
    worldState: slowFall.worldState,
    damageResult: applied,
  });

  return {
    ...applied,
    player: safeguarded.player,
    worldState: safeguarded.worldState,
    safeguardLines: [...slowFall.lines, ...safeguarded.lines],
    safeguards: [...slowFall.safeguards, ...safeguarded.safeguards],
  };
}

function applySlowFall({ characterSheet = {}, worldState = {}, damage = 0, source = null } = {}) {
  const level = Number(characterSheet.identity?.level || characterSheet.derived_stats?.level || 1);
  const rawDamage = Math.max(0, Number(damage || 0));
  if (
    normalizeId(characterSheet.identity?.class || characterSheet.identity?.class_name) !== 'monk'
    || level < 4
    || rawDamage <= 0
    || !isFallingDamage(source)
  ) {
    return { damage: rawDamage, worldState, lines: [], safeguards: [] };
  }

  const reaction = spendTurnResource(worldState, 'reaction', 'Slow Fall', characterSheet);
  if (!reaction.ok) {
    return { damage: rawDamage, worldState: reaction.worldState, lines: [], safeguards: [] };
  }

  const reduction = Math.min(rawDamage, level * 5);
  return {
    damage: rawDamage - reduction,
    worldState: reaction.worldState,
    lines: [` **Slow Fall** uses your Reaction and reduces the falling damage by ${reduction} (${level} x 5).`],
    safeguards: [{ id: 'monk.slow_fall', reaction_spent: Boolean(worldState.combat_state?.active), damage_reduced: reduction }],
  };
}

function isFallingDamage(source) {
  return /\b(?:fall|falling|fell|dropped|plummet)\b/i.test(String(source || ''));
}

function applyFatalPlayerDamageSafeguards({
  player = {},
  characterSheet = {},
  worldState = {},
  damageResult = {},
} = {}) {
  const relentless = applyRelentlessEndurance({
    player,
    characterSheet,
    worldState,
    damageResult,
  });
  if (relentless.applied) {
    return {
      player: relentless.player,
      worldState: relentless.worldState,
      lines: [relentless.line],
      safeguards: [relentless.safeguard],
    };
  }

  return {
    player,
    worldState,
    lines: [],
    safeguards: [],
  };
}

function applyRelentlessEndurance({
  player = {},
  characterSheet = {},
  worldState = {},
  damageResult = {},
} = {}) {
  if (!shouldApplyRelentlessEndurance({ player, characterSheet, damageResult })) {
    return { applied: false, player, worldState };
  }

  const resources = buildResourceState(characterSheet, worldState);
  if (Number(resources.relentless_endurance?.remaining || 0) <= 0) {
    return { applied: false, player, worldState };
  }

  const spent = spendResource({ worldState, characterSheet, resource: 'relentless_endurance' });
  if (!spent.ok) return { applied: false, player, worldState };

  return {
    applied: true,
    player: {
      ...player,
      hp: 1,
    },
    worldState: spent.worldState,
    line: ' **Relentless Endurance** keeps you at 1 HP instead of dropping to 0.',
    safeguard: {
      id: 'orc.relentless_endurance',
      resource: 'relentless_endurance',
      prevented_zero_hp: true,
    },
  };
}

function shouldApplyRelentlessEndurance({ player = {}, characterSheet = {}, damageResult = {} } = {}) {
  if (normalizeId(characterSheet.identity?.species) !== 'orc') return false;
  if (Number(damageResult.beforeHp || 0) <= 0) return false;
  if (Number(player.hp || 0) > 0) return false;
  if (isKilledOutright({ player, characterSheet, damageResult })) return false;
  return true;
}

function isKilledOutright({ player = {}, characterSheet = {}, damageResult = {} } = {}) {
  const maxHp = Number(player.max_hp ?? characterSheet.derived_stats?.max_hp ?? damageResult.beforeHp ?? 0);
  if (maxHp <= 0) return false;
  const overflow = Number(damageResult.hpDamage || 0) - Number(damageResult.beforeHp || 0);
  return overflow >= maxHp;
}

function buildPlayerDamageTarget({ player = {}, characterSheet = {}, worldState = {} } = {}) {
  return {
    ...player,
    hp: player.hp ?? getCurrentHp(characterSheet, worldState),
    max_hp: player.max_hp ?? worldState.player_stats?.max_hp ?? characterSheet.derived_stats?.max_hp,
    temp_hp: player.temp_hp ?? worldState.player_stats?.temp_hp ?? characterSheet.derived_stats?.temp_hp ?? 0,
    resistances: player.resistances || worldState.player_stats?.resistances || characterSheet.resistances || [],
    vulnerabilities: player.vulnerabilities || worldState.player_stats?.vulnerabilities || characterSheet.vulnerabilities || [],
    immunities: player.immunities || worldState.player_stats?.immunities || characterSheet.immunities || [],
  };
}

function getCurrentHp(characterSheet, worldState) {
  return Number(worldState.player_stats?.hp ?? characterSheet?.derived_stats?.hp ?? characterSheet?.derived_stats?.max_hp ?? 10);
}

function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

module.exports = {
  applyDamageToPlayer,
  applySlowFall,
  applyFatalPlayerDamageSafeguards,
  isKilledOutright,
};
