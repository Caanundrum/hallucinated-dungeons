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
      ? { ...combatant, hp: player.hp, conditions: clearPlayerTurnConditions(combatant.conditions) }
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
  const skipReason = getTurnSkipReason(actor);
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
  const first = rollDie(20);
  const second = playerDodging ? rollDie(20) : null;
  const natural = playerDodging ? Math.min(first, second) : first;
  const attackBonus = Number(attack.attack_bonus || 0);
  const attackTotal = natural + attackBonus;
  const ac = Number(player.ac || getArmorClass(characterSheet, worldState));
  const rollText = playerDodging
    ? `${first}/${second} with disadvantage, using ${natural}${formatSigned(attackBonus)} = ${attackTotal}`
    : `${natural}${formatSigned(attackBonus)} = ${attackTotal}`;
  const criticalHit = natural === 20;
  const criticalMiss = natural === 1;

  if (!criticalMiss && (criticalHit || attackTotal >= ac)) {
    const damage = rollDamage(attack.damage_formula || '1d6+1', rollDie, criticalHit);
    const before = Number(player.hp ?? getCurrentHp(characterSheet, worldState));
    const nextHp = Math.max(0, before - damage.total);
    return {
      actor,
      player: { ...player, hp: nextHp },
      lines: [`${actor.name} uses ${attack.name}: rolls ${rollText} vs AC ${ac}. ${criticalHit ? '**Critical hit.** ' : ''}Hit for ${damage.total} damage. ${player.name}: (${before} -> ${nextHp} HP).`],
      damageEvents: [{
        target: 'player',
        source: actor.name,
        amount: damage.total,
      }],
    };
  }

  if (criticalMiss) {
    return {
      actor,
      player,
      lines: [`${actor.name} uses ${attack.name}: rolls ${rollText} vs AC ${ac}. **Critical miss.** Even the initiative tracker winces.`],
    };
  }

  return {
    actor,
    player,
    lines: [`${actor.name} uses ${attack.name}: rolls ${rollText} vs AC ${ac}. Miss.`],
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

function getTurnSkipReason(actor = {}) {
  const conditions = (actor.conditions || []).map((condition) => String(condition).toLowerCase());
  if (conditions.some((condition) => ['incapacitated', 'unconscious', 'sleep', 'asleep', 'stunned', 'paralyzed'].includes(condition))) {
    return 'it is unable to act';
  }
  if (conditions.includes('command')) {
    return 'Command overrides its action for this round';
  }
  if (conditions.includes('charm_person') || conditions.includes('charmed')) {
    return 'it is charmed and cannot attack you right now';
  }
  return null;
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
    name: identity.name || stats.name || 'You',
    initiative: Number(derived.initiative || 0),
    hp,
    max_hp: Number(stats.max_hp ?? derived.max_hp ?? hp),
    ac: Number(stats.armor_class ?? derived.armor_class ?? 10),
    conditions: derived.conditions || stats.conditions || [],
    is_player: true,
  };
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
  return Math.floor(Math.random() * Number(sides)) + 1;
}

function formatSigned(value) {
  const number = Number(value || 0);
  return number >= 0 ? `+${number}` : String(number);
}

module.exports = {
  resolveCreatureTurns,
  getActingIndexes,
  getTurnSkipReason,
};
