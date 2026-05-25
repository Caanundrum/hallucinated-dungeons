const crypto = require('crypto');
const {
  getAttackMode,
  getAttackModeSources,
  getTurnBlockReason,
} = require('./conditionEngine');

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
  }

  let player = combatants[playerIndex];
  const actingIndexes = getActingIndexes(combatants, combat.turn_index, playerIndex, advanceRound);
  const lines = [];
  const damageEvents = [];

  for (const index of actingIndexes) {
    const actor = combatants[index];
    if (!actor || actor.is_player || Number(actor.hp || 0) <= 0) continue;

    const action = resolveCreatureAction({
      actor,
      player,
      characterSheet,
      worldState,
      rollDie,
      playerDodging,
    });
    combatants[index] = action.actor;
    player = action.player;
    lines.push(...action.lines);
    damageEvents.push(...(action.damageEvents || []));
    if (Number(player.hp || 0) <= 0) break;
  }

  combat.round = Number(combat.round || 1) + (advanceRound ? 1 : 0);
  combat.turn_index = playerIndex;
  combat.combatants = combatants.map((combatant, index) => (
    index === playerIndex
      ? { ...combatant, hp: player.hp, temp_hp: player.temp_hp, conditions: clearPlayerTurnConditions(combatant.conditions) }
      : combatant
  ));

  return {
    combat,
    player,
    lines,
    damageEvents,
    roundsElapsed: advanceRound ? 1 : 0,
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
  const attackMode = getAttackMode({ attacker: actor, target: player, defenderDodging: playerDodging });
  const attackRoll = rollD20WithMode(rollDie, attackMode);
  const natural = attackRoll.natural;
  const attackBonus = Number(attack.attack_bonus || 0);
  const attackTotal = natural + attackBonus;
  const ac = Number(player.ac || getArmorClass(characterSheet, worldState));
  const rollText = playerDodging
    ? `${attackRoll.text}${formatSigned(attackBonus)} = ${attackTotal}`
    : `${attackRoll.text}${formatSigned(attackBonus)} = ${attackTotal}`;
  const conditionSources = getAttackModeSources({ attacker: actor, target: player, defenderDodging: playerDodging });
  const modeText = attackMode ? ` (${attackMode}: ${conditionSources.join(', ')})` : '';
  const criticalHit = natural === 20;
  const criticalMiss = natural === 1;

  if (!criticalMiss && (criticalHit || attackTotal >= ac)) {
    const damage = rollDamage(attack.damage_formula || '1d6+1', rollDie, criticalHit);
    const before = Number(player.hp ?? getCurrentHp(characterSheet, worldState));
    const applied = applyDamageToPlayer({ player, characterSheet, worldState, damage: damage.total });
    const retaliation = getMeleeRetaliation(worldState, applied.beforeTempHp);
    const nextActor = retaliation
      ? { ...actor, hp: Math.max(0, Number(actor.hp || 0) - retaliation.damage) }
      : actor;
    const retaliationLine = retaliation
      ? ` ${retaliation.label} lashes back for ${retaliation.damage} ${retaliation.damageType} damage. ${actor.name}: (${actor.hp} -> ${nextActor.hp} HP).`
      : '';
    return {
      actor: nextActor,
      player: applied.player,
      lines: [`${actor.name} uses ${attack.name}: rolls ${rollText} vs AC ${ac}${modeText}. ${criticalHit ? '**Critical hit.** ' : ''}Hit for ${damage.total} damage${applied.absorbed ? ` (${applied.absorbed} absorbed by temporary HP)` : ''}. ${player.name}: (${before} -> ${applied.player.hp} HP).${retaliationLine}`],
      damageEvents: [{
        target: 'player',
        source: actor.name,
        amount: applied.hpDamage,
      }],
    };
  }

  if (criticalMiss) {
    return {
      actor,
      player,
      lines: [`${actor.name} uses ${attack.name}: rolls ${rollText} vs AC ${ac}${modeText}. **Critical miss.** Even the initiative tracker winces.`],
    };
  }

  return {
    actor,
    player,
    lines: [`${actor.name} uses ${attack.name}: rolls ${rollText} vs AC ${ac}${modeText}. Miss.`],
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
  return {
    character_id: stats.character_id || derived.character_id || null,
    name: identity.name || stats.name || 'You',
    initiative: Number(derived.initiative || 0),
    hp,
    max_hp: Number(stats.max_hp ?? derived.max_hp ?? hp),
    temp_hp: Number(stats.temp_hp ?? derived.temp_hp ?? 0),
    ac: Number(stats.armor_class ?? derived.armor_class ?? 10),
    conditions: derived.conditions || stats.conditions || [],
    is_player: true,
  };
}

function combatantMatchesCharacter(combatant = {}, characterSheet = {}, worldState = {}) {
  const expectedId = worldState.player_stats?.character_id || characterSheet?.derived_stats?.character_id || null;
  const expectedName = characterSheet?.identity?.name || worldState.player_stats?.name || '';
  if (expectedId && combatant.character_id !== expectedId) return false;
  if (!combatant.character_id && expectedName && combatant.name && combatant.name !== expectedName) return false;
  return true;
}

function applyDamageToPlayer({ player, characterSheet, worldState, damage }) {
  const beforeTempHp = Number(player.temp_hp ?? worldState.player_stats?.temp_hp ?? characterSheet.derived_stats?.temp_hp ?? 0);
  const absorbed = Math.min(beforeTempHp, Number(damage || 0));
  const hpDamage = Math.max(0, Number(damage || 0) - absorbed);
  const beforeHp = Number(player.hp ?? getCurrentHp(characterSheet, worldState));
  return {
    beforeTempHp,
    absorbed,
    hpDamage,
    player: {
      ...player,
      temp_hp: Math.max(0, beforeTempHp - absorbed),
      hp: Math.max(0, beforeHp - hpDamage),
    },
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

function rollD20WithMode(rollDie, mode = null) {
  if (mode === 'advantage' || mode === 'disadvantage') {
    const first = rollDie(20);
    const second = rollDie(20);
    const natural = mode === 'advantage' ? Math.max(first, second) : Math.min(first, second);
    return {
      natural,
      text: `${first}/${second} with ${mode}, using ${natural}`,
    };
  }
  const natural = rollDie(20);
  return { natural, text: String(natural) };
}

function rollDamage(formula, rollDie, crit = false) {
  const parsed = String(formula || '1d6').match(/(\d+)d(\d+)([+-]\d+)?/i);
  if (!parsed) return { total: 1, rolls: [1] };
  const diceCount = Number(parsed[1]);
  const dieSides = Number(parsed[2]);
  const modifier = parsed[3] ? Number(parsed[3]) : 0;
  const rollCount = crit ? diceCount * 2 : diceCount;
  const rolls = Array.from({ length: rollCount }, () => rollDie(dieSides));
  return {
    total: rolls.reduce((sum, roll) => sum + roll, 0) + modifier,
    rolls,
  };
}

function cloneCombatState(combatState) {
  return JSON.parse(JSON.stringify(combatState || { active: true, round: 1, turn_index: 0, combatants: [] }));
}

function getCurrentHp(characterSheet, worldState) {
  return Number(worldState.player_stats?.hp ?? characterSheet?.derived_stats?.hp ?? characterSheet?.derived_stats?.max_hp ?? 10);
}

function getArmorClass(characterSheet, worldState) {
  return Number(worldState.player_stats?.armor_class ?? characterSheet?.derived_stats?.armor_class ?? 10);
}

function defaultRollDie(sides) {
  return crypto.randomInt(1, Number(sides) + 1);
}

function formatSigned(value) {
  const number = Number(value || 0);
  return number >= 0 ? `+${number}` : String(number);
}

module.exports = {
  resolveCreatureTurns,
  getActingIndexes,
  getTurnSkipReason: getTurnBlockReason,
};
