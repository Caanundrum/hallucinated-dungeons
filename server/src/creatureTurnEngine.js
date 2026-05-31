const crypto = require('crypto');
const { rollD20WithMode } = require('./d20RollEngine');
const {
  applyDamage,
  formatDamageAdjustment,
  rollDamageFormula,
} = require('./damageHealingEngine');
const {
  getAttackMode,
  getAttackModeSources,
  getTurnBlockReason,
} = require('./conditionEngine');
const { getActiveDamageResistances } = require('./spellEffectEngine');
const {
  buildResourceState,
  spendResource,
} = require('./resourceEngine');
const { consumeSapAfterAttack } = require('./weaponRulesEngine');
const { getRuntimeArmorClass } = require('./fightingStyleEngine');
const {
  applyPrimedGiantAncestryDamageReduction,
  applyPrimedGiantAncestryRetaliation,
} = require('./giantAncestryEngine');

function resolveCreatureTurns({
  worldState = {},
  characterSheet = {},
  rollDie = defaultRollDie,
  playerDodging = false,
  advanceRound = true,
} = {}) {
  const combat = cloneCombatState(worldState.combat_state);
  const combatants = Array.isArray(combat.combatants) ? combat.combatants : [];
  let playerIndex = combatants.findIndex((combatant) => combatant.is_player);
  if (playerIndex < 0) {
    combatants.unshift(buildPlayerCombatant(characterSheet, worldState));
    playerIndex = 0;
  } else if (!combatantMatchesCharacter(combatants[playerIndex], characterSheet, worldState)) {
    const activePlayer = buildPlayerCombatant(characterSheet, worldState);
    combatants[playerIndex] = {
      ...combatants[playerIndex],
      ...activePlayer,
      initiative: combatants[playerIndex].initiative ?? activePlayer.initiative,
    };
  } else {
    combatants[playerIndex] = mergeActivePlayerDefenses(combatants[playerIndex], characterSheet, worldState);
  }

  let player = combatants[playerIndex];
  let nextWorldState = worldState;
  const actingIndexes = getActingIndexes(combatants, combat.turn_index, playerIndex, advanceRound);
  const lines = [];
  const damageEvents = [];

  for (const index of actingIndexes) {
    const actor = combatants[index];
    if (!actor || actor.is_player || Number(actor.hp || 0) <= 0) continue;

    const action = resolveCreatureAction({
      actor: {
        ...actor,
        reaction_available: true,
      },
      player,
      characterSheet,
      worldState: nextWorldState,
      rollDie,
      playerDodging,
    });
    combatants[index] = action.actor;
    player = action.player;
    nextWorldState = action.worldState || nextWorldState;
    lines.push(...action.lines);
    damageEvents.push(...(action.damageEvents || []));
    if (Number(player.hp || 0) <= 0) break;
  }

  combat.round = Number(combat.round || 1) + (advanceRound ? 1 : 0);
  combat.turn_index = playerIndex;
  combat.combatants = combatants.map((combatant, index) => (
    index === playerIndex
      ? {
          ...combatant,
          hp: player.hp,
          temp_hp: player.temp_hp,
          conditions: clearPlayerTurnConditions(player.conditions || combatant.conditions),
          resistances: player.resistances || combatant.resistances,
          vulnerabilities: player.vulnerabilities || combatant.vulnerabilities,
          immunities: player.immunities || combatant.immunities,
        }
      : combatant
  ));

  return {
    combat,
    player,
    lines,
    damageEvents,
    roundsElapsed: advanceRound ? 1 : 0,
    worldState: nextWorldState,
  };
}

function resolveCreatureAction({ actor, player, characterSheet, worldState, rollDie, playerDodging }) {
  const skipReason = getTurnBlockReason(actor);
  if (skipReason) {
    return {
      actor: {
        ...actor,
        conditions: clearCreatureTurnConditions(actor.conditions),
      },
      player,
      lines: [`${actor.name} loses its turn: ${skipReason}.`],
    };
  }

  if (Number(player.hp || 0) <= 0) {
    return {
      actor,
      player,
      lines: [`${actor.name} has no useful attack to make while you are already at 0 HP.`],
    };
  }

  const attack = actor.attack || { name: 'attack', attack_bonus: 3, damage_formula: '1d6+1' };
  const luckyDefensePrimed = Boolean(worldState.player_stats?.lucky_defense_primed);
  const attackMode = getAttackMode({ attacker: actor, target: player, defenderDodging: playerDodging || luckyDefensePrimed });
  const attackRoll = rollD20WithMode(rollDie, attackMode);
  const natural = attackRoll.natural;
  const attackBonus = Number(attack.attack_bonus || 0);
  const attackTotal = natural + attackBonus;
  const ac = Number(player.ac || getArmorClass(characterSheet, worldState));
  const rollText = playerDodging
    ? `${attackRoll.text}${formatSigned(attackBonus)} = ${attackTotal}`
    : `${attackRoll.text}${formatSigned(attackBonus)} = ${attackTotal}`;
  const conditionSources = [
    ...getAttackModeSources({ attacker: actor, target: player, defenderDodging: playerDodging }),
    ...(luckyDefensePrimed ? ['Lucky'] : []),
  ];
  const modeText = attackMode ? ` (${attackMode}: ${conditionSources.join(', ')})` : '';
  const nextWorldState = consumeLuckyDefense(worldState, luckyDefensePrimed);
  const criticalHit = natural === 20;
  const criticalMiss = natural === 1;

  if (!criticalMiss && (criticalHit || attackTotal >= ac)) {
    const damage = rollDamage(attack.damage_formula || '1d6+1', rollDie, { crit: criticalHit });
    const before = Number(player.hp ?? getCurrentHp(characterSheet, worldState));
    const reduction = applyPrimedGiantAncestryDamageReduction({
      player,
      worldState: nextWorldState,
      characterSheet,
      incomingDamage: damage.total,
      rollDie,
    });
    const applied = applyDamageToPlayer({
      player,
      characterSheet,
      worldState: reduction.worldState,
      damage: reduction.incomingDamage,
      damageType: attack.damage_type || attack.damageType || null,
    });
    const thunder = applyPrimedGiantAncestryRetaliation({
      actor,
      worldState: reduction.worldState,
      characterSheet,
      damageTaken: applied.amount,
      rollDie,
    });
    const endurance = applyRelentlessEndurance({
      player: applied.player,
      characterSheet,
      worldState: thunder.worldState,
    });
    const retaliation = getMeleeRetaliation(worldState, applied.beforeTempHp);
    const nextActor = retaliation
      ? { ...thunder.actor, hp: Math.max(0, Number(thunder.actor.hp || 0) - retaliation.damage) }
      : thunder.actor;
    const resolvedActor = consumeSapAfterAttack(nextActor);
    const retaliationLine = retaliation
      ? ` ${retaliation.label} lashes back for ${retaliation.damage} ${retaliation.damageType} damage. ${actor.name}: (${actor.hp} -> ${nextActor.hp} HP).`
      : '';
    return {
      actor: resolvedActor,
      player: endurance.player,
      worldState: endurance.worldState,
      lines: [
        `${actor.name} uses ${attack.name}: rolls ${rollText} vs AC ${ac}${modeText}. ${criticalHit ? '**Critical hit.** ' : ''}Hit for ${applied.amount} damage${formatDamageAdjustment(applied.adjustment)}${applied.absorbed ? ` (${applied.absorbed} absorbed by temporary HP)` : ''}. ${player.name}: (${before} -> ${endurance.player.hp} HP).${endurance.line}${retaliationLine}`,
        ...reduction.lines,
        ...thunder.lines,
      ],
      damageEvents: [{
        target: 'player',
        source: actor.name,
        amount: applied.amount,
      }],
    };
  }

  if (criticalMiss) {
    return {
      actor: consumeSapAfterAttack(actor),
      player,
      worldState: nextWorldState,
      lines: [`${actor.name} uses ${attack.name}: rolls ${rollText} vs AC ${ac}${modeText}. **Critical miss.** Even the initiative tracker winces.`],
    };
  }

  return {
    actor: consumeSapAfterAttack(actor),
    player,
    worldState: nextWorldState,
    lines: [`${actor.name} uses ${attack.name}: rolls ${rollText} vs AC ${ac}${modeText}. Miss.`],
  };
}

function consumeLuckyDefense(worldState = {}, shouldConsume = false) {
  if (!shouldConsume) return worldState;
  return {
    ...worldState,
    player_stats: {
      ...(worldState.player_stats || {}),
      lucky_defense_primed: false,
    },
  };
}

function applyRelentlessEndurance({ player = {}, characterSheet = {}, worldState = {} } = {}) {
  if (Number(player.hp || 0) > 0 || normalizeId(characterSheet.identity?.species) !== 'orc') {
    return { player, worldState, line: '' };
  }

  const resources = buildResourceState(characterSheet, worldState);
  if (Number(resources.relentless_endurance?.remaining || 0) <= 0) {
    return { player, worldState, line: '' };
  }

  const spent = spendResource({ worldState, characterSheet, resource: 'relentless_endurance' });
  if (!spent.ok) return { player, worldState, line: '' };
  return {
    player: {
      ...player,
      hp: 1,
    },
    worldState: spent.worldState,
    line: ' **Relentless Endurance** keeps you at 1 HP instead of dropping to 0.',
  };
}

function getActingIndexes(combatants, turnIndex, playerIndex, advanceRound) {
  if (combatants.length === 0 || playerIndex < 0) return [];

  if (!advanceRound) {
    const start = Number.isInteger(turnIndex) ? turnIndex : 0;
    const indexes = [];
    for (let index = start; index < combatants.length && index !== playerIndex; index += 1) {
      indexes.push(index);
    }
    return indexes;
  }

  const indexes = [];
  let index = (playerIndex + 1) % combatants.length;
  while (index !== playerIndex) {
    indexes.push(index);
    index = (index + 1) % combatants.length;
  }
  return indexes;
}

function clearPlayerTurnConditions(conditions = []) {
  return (conditions || []).filter((condition) => !/^dodg/i.test(String(condition)));
}

function clearCreatureTurnConditions(conditions = []) {
  return (conditions || []).filter((condition) => !/^command$/i.test(String(condition)));
}

function buildPlayerCombatant(characterSheet, worldState) {
  const identity = characterSheet?.identity || {};
  const derived = characterSheet?.derived_stats || {};
  const stats = worldState.player_stats || {};
  const hp = Number(stats.hp ?? derived.hp ?? derived.max_hp ?? 10);
  const armor = getRuntimeArmorClass({
    characterSheet,
    armorClass: stats.armor_class ?? derived.armor_class ?? 10,
    defenseApplied: Boolean(stats.defense_fighting_style_applied),
  });
  return {
    character_id: stats.character_id || derived.character_id || null,
    name: identity.name || stats.name || 'You',
    initiative: Number(derived.initiative || 0),
    hp,
    max_hp: Number(stats.max_hp ?? derived.max_hp ?? hp),
    temp_hp: Number(stats.temp_hp ?? derived.temp_hp ?? 0),
    ac: armor.armorClass,
    defense_fighting_style_applied: armor.defenseApplied,
    conditions: uniqueValues([...(derived.conditions || []), ...(stats.conditions || [])]),
    resistances: uniqueValues([...(characterSheet.resistances || []), ...(stats.resistances || []), ...getActiveDamageResistances(worldState)]),
    vulnerabilities: uniqueValues([...(characterSheet.vulnerabilities || []), ...(stats.vulnerabilities || [])]),
    immunities: uniqueValues([...(characterSheet.immunities || []), ...(stats.immunities || [])]),
    is_player: true,
  };
}

function mergeActivePlayerDefenses(player = {}, characterSheet = {}, worldState = {}) {
  const activePlayer = buildPlayerCombatant(characterSheet, worldState);
  return {
    ...player,
    ac: activePlayer.ac,
    defense_fighting_style_applied: activePlayer.defense_fighting_style_applied,
    temp_hp: player.temp_hp ?? activePlayer.temp_hp,
    conditions: uniqueValues([...(activePlayer.conditions || []), ...(player.conditions || [])]),
    resistances: uniqueValues([...(activePlayer.resistances || []), ...(player.resistances || [])]),
    vulnerabilities: uniqueValues([...(activePlayer.vulnerabilities || []), ...(player.vulnerabilities || [])]),
    immunities: uniqueValues([...(activePlayer.immunities || []), ...(player.immunities || [])]),
  };
}

function combatantMatchesCharacter(combatant = {}, characterSheet = {}, worldState = {}) {
  const expectedId = worldState.player_stats?.character_id || characterSheet?.derived_stats?.character_id || null;
  const expectedName = characterSheet?.identity?.name || worldState.player_stats?.name || '';
  if (expectedId && combatant.character_id !== expectedId) return false;
  if (!combatant.character_id && expectedName && combatant.name && combatant.name !== expectedName) return false;
  return true;
}

function applyDamageToPlayer({ player, characterSheet, worldState, damage, damageType = null }) {
  const target = {
    ...player,
    hp: player.hp ?? getCurrentHp(characterSheet, worldState),
    temp_hp: player.temp_hp ?? worldState.player_stats?.temp_hp ?? characterSheet.derived_stats?.temp_hp ?? 0,
    resistances: player.resistances || worldState.player_stats?.resistances || characterSheet.resistances || [],
    vulnerabilities: player.vulnerabilities || worldState.player_stats?.vulnerabilities || characterSheet.vulnerabilities || [],
    immunities: player.immunities || worldState.player_stats?.immunities || characterSheet.immunities || [],
  };
  const applied = applyDamage({ target, amount: damage, damageType });
  return {
    ...applied,
    beforeTempHp: applied.beforeTempHp,
    absorbed: applied.absorbed,
    hpDamage: applied.hpDamage,
    player: applied.target,
  };
}

function getMeleeRetaliation(worldState = {}, beforeTempHp = 0) {
  if (Number(beforeTempHp || 0) <= 0) return null;
  const activeEffects = Array.isArray(worldState.active_effects) ? worldState.active_effects : [];
  for (const effect of activeEffects) {
    for (const rule of effect.rules_effects || []) {
      if (rule.target === 'melee_retaliation_damage') {
        return {
          damage: Number(rule.value || 0),
          damageType: rule.damage_type || 'damage',
          label: rule.label || effect.name || 'Retaliation',
        };
      }
    }
  }
  return null;
}

function rollDamage(formula, rollDie, { crit = false } = {}) {
  return rollDamageFormula(formula, rollDie, { crit });
}

function cloneCombatState(combatState) {
  return JSON.parse(JSON.stringify(combatState || { active: true, round: 1, turn_index: 0, combatants: [] }));
}

function getCurrentHp(characterSheet, worldState) {
  return Number(worldState.player_stats?.hp ?? characterSheet?.derived_stats?.hp ?? characterSheet?.derived_stats?.max_hp ?? 10);
}

function getArmorClass(characterSheet, worldState) {
  return getRuntimeArmorClass({
    characterSheet,
    armorClass: worldState.player_stats?.armor_class ?? characterSheet?.derived_stats?.armor_class ?? 10,
    defenseApplied: Boolean(worldState.player_stats?.defense_fighting_style_applied),
  }).armorClass;
}

function defaultRollDie(sides) {
  return crypto.randomInt(1, Number(sides) + 1);
}

function formatSigned(value) {
  const number = Number(value || 0);
  return number >= 0 ? `+${number}` : String(number);
}

function uniqueValues(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

module.exports = {
  resolveCreatureTurns,
  resolveCreatureAction,
  getActingIndexes,
  getTurnSkipReason: getTurnBlockReason,
};
