const { rollDie } = require('./dice');
const { rollD20WithMode } = require('./d20RollEngine');
const {
  formatDamageAdjustment,
  rollDamageFormula,
} = require('./damageHealingEngine');
const { applyDamageToPlayer } = require('./playerDamageEngine');
const {
  getAttackMode,
  getAttackModeSources,
  getConditionD20Modifier,
  formatConditionD20Sources,
  getTurnBlockReason,
} = require('./conditionEngine');
const { getActiveDamageResistances } = require('./spellEffectEngine');
const { consumeSapAfterAttack } = require('./weaponRulesEngine');
const { getRuntimeArmorClass } = require('./fightingStyleEngine');
const {
  applyPrimedGiantAncestryDamageReduction,
  applyPrimedGiantAncestryRetaliation,
} = require('./giantAncestryEngine');
const {
  buildAttackHitReaction,
  buildDamageTakenReaction,
} = require('./reactionEngine');
const {
  resolveCreatureMovementBeforeAction,
  resumeCreatureMovementAfterReaction,
} = require('./creatureMovementEngine');
const { resolveReadiedActionTrigger } = require('./readyActionEngine');
const {
  REACTION_RESUME_STAGES,
  REACTION_RESUME_TYPES,
  buildReactionResume,
} = require('./refereeContracts');

function resolveCreatureTurns({
  worldState = {},
  characterSheet = {},
  rollDie = defaultRollDie,
  playerDodging = false,
  advanceRound = true,
  resumeReaction = null,
} = {}) {
  const combat = cloneCombatState(worldState.combat_state);
  let combatants = Array.isArray(combat.combatants) ? combat.combatants : [];
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
  const continuation = resumeReaction?.resume?.type === REACTION_RESUME_TYPES.CREATURE_TURNS
    ? resumeReaction.resume
    : null;
  const actingIndexes = continuation?.acting_indexes
    || getActingIndexes(combatants, combat.turn_index, playerIndex, advanceRound);
  const lines = [];
  const damageEvents = [...(continuation?.damage_events || [])];

  let startOffset = 0;
  if (continuation) {
    const actorIndex = Number(continuation.actor_index);
    const actor = combatants[actorIndex];
    if (continuation.creature_movement && actor && !actor.is_player && Number(actor.hp || 0) > 0) {
      const movement = resumeCreatureMovementAfterReaction({
        actor,
        player,
        combat,
        worldState: nextWorldState,
        characterSheet,
        pendingReaction: resumeReaction,
        rollDie,
      });
      combat.combatants = movement.combat.combatants;
      combatants = combat.combatants;
      combatants[actorIndex] = movement.actor;
      player = movement.player;
      nextWorldState = movement.worldState || nextWorldState;
      lines.push(...movement.lines);

      if (
        movement.actionAvailable
        && Number(movement.actor?.hp || 0) > 0
        && Number(player.hp || 0) > 0
      ) {
        const readied = resolveReadiedActionTrigger({
          worldState: nextWorldState,
          combat,
          player,
          actor: movement.actor,
          characterSheet,
          rollDie,
          trigger: 'after creature movement',
        });
        combat.combatants = readied.combat.combatants;
        combatants = combat.combatants;
        combatants[actorIndex] = readied.actor;
        player = readied.player;
        nextWorldState = readied.worldState || nextWorldState;
        lines.push(...readied.lines);
        if (Number(readied.actor?.hp || 0) > 0 && Number(player.hp || 0) > 0) {
          const action = resolveCreatureAction({
            actor: readied.actor,
            player,
            characterSheet,
            worldState: nextWorldState,
            rollDie,
            playerDodging,
            allowReactionWindow: true,
          });
          combatants[actorIndex] = action.actor;
          player = action.player;
          nextWorldState = action.worldState || nextWorldState;
          lines.push(...action.lines);
          damageEvents.push(...(action.damageEvents || []));
          if (action.pendingReaction) {
            return pauseCreatureTurns({
              combat,
              combatants,
              player,
              lines,
              damageEvents,
              nextWorldState,
              pendingReaction: action.pendingReaction,
              actorIndex,
              actingIndexes,
              nextOffset: Number(continuation.next_offset || 0),
              advanceRound,
              playerDodging,
            });
          }
        }
      }
    } else if (
      continuation.stage !== REACTION_RESUME_STAGES.AFTER_ATTACK
      && actor
      && !actor.is_player
      && Number(actor.hp || 0) > 0
    ) {
      const action = resolveCreatureAttackHit({
        actor,
        player,
        characterSheet,
        worldState: nextWorldState,
        rollDie,
        frame: resumeReaction.attack_frame,
        allowReactionWindow: true,
      });
      combatants[actorIndex] = action.actor;
      player = action.player;
      nextWorldState = action.worldState || nextWorldState;
      lines.push(...action.lines);
      damageEvents.push(...(action.damageEvents || []));
      if (action.pendingReaction) {
        return pauseCreatureTurns({
          combat,
          combatants,
          player,
          lines,
          damageEvents,
          nextWorldState,
          pendingReaction: action.pendingReaction,
          actorIndex,
          actingIndexes,
          nextOffset: Number(continuation.next_offset || 0),
          advanceRound,
          playerDodging,
        });
      }
    }
    startOffset = Number(continuation.next_offset || 0);
  }

  for (let offset = startOffset; offset < actingIndexes.length; offset += 1) {
    const index = actingIndexes[offset];
    const actor = combatants[index];
    if (!actor || actor.is_player || Number(actor.hp || 0) <= 0) continue;

    if (!getTurnBlockReason(actor)) {
      const movement = resolveCreatureMovementBeforeAction({
        actor,
        player,
        combat,
        worldState: nextWorldState,
        characterSheet,
        rollDie,
        allowReactionWindow: true,
      });
      combat.combatants = movement.combat.combatants;
      combatants = combat.combatants;
      combatants[index] = movement.actor;
      player = movement.player;
      nextWorldState = movement.worldState || nextWorldState;
      lines.push(...movement.lines);
      if (movement.pendingReaction) {
        return pauseCreatureTurns({
          combat,
          combatants,
          player,
          lines,
          damageEvents,
          nextWorldState,
          pendingReaction: movement.pendingReaction,
          actorIndex: index,
          actingIndexes,
          nextOffset: offset + 1,
          advanceRound,
          playerDodging,
          resumePayload: {
            creature_movement: movement.movement,
          },
        });
      }
      if (!movement.actionAvailable || Number(movement.actor?.hp || 0) <= 0) {
        if (Number(player.hp || 0) <= 0) break;
        continue;
      }
    }

    const readied = resolveReadiedActionTrigger({
      worldState: nextWorldState,
      combat,
      player,
      actor: combatants[index],
      characterSheet,
      rollDie,
      trigger: 'creature turn',
    });
    combat.combatants = readied.combat.combatants;
    combatants = combat.combatants;
    combatants[index] = readied.actor;
    player = readied.player;
    nextWorldState = readied.worldState || nextWorldState;
    lines.push(...readied.lines);
    if (Number(readied.actor?.hp || 0) <= 0) {
      if (Number(player.hp || 0) <= 0) break;
      continue;
    }

    const action = resolveCreatureAction({
      actor: {
        ...combatants[index],
        reaction_available: true,
      },
      player,
      characterSheet,
      worldState: nextWorldState,
      rollDie,
      playerDodging,
      allowReactionWindow: true,
    });
    combatants[index] = action.actor;
    player = action.player;
    nextWorldState = action.worldState || nextWorldState;
    lines.push(...action.lines);
    damageEvents.push(...(action.damageEvents || []));
    if (action.pendingReaction) {
      return pauseCreatureTurns({
        combat,
        combatants,
        player,
        lines,
        damageEvents,
        nextWorldState,
        pendingReaction: action.pendingReaction,
        actorIndex: index,
        actingIndexes,
        nextOffset: offset + 1,
        advanceRound,
        playerDodging,
      });
    }
    if (Number(player.hp || 0) <= 0) break;
  }

  combat.round = Number(combat.round || 1) + (advanceRound ? 1 : 0);
  combat.turn_index = playerIndex;
  combat.combatants = syncPlayerCombatant(combatants, playerIndex, player, { clearTurnConditions: true });

  return {
    combat,
    player,
    lines,
    damageEvents,
    roundsElapsed: advanceRound ? 1 : 0,
    worldState: nextWorldState,
  };
}

function resolveCreatureAction({
  actor,
  player,
  characterSheet,
  worldState,
  rollDie,
  playerDodging,
  allowReactionWindow = false,
}) {
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
  const conditionAttackModifier = getConditionD20Modifier(actor);
  const attackBonus = Number(attack.attack_bonus || 0) + conditionAttackModifier;
  const attackTotal = natural + attackBonus;
  const ac = Number(player.ac || getArmorClass(characterSheet, worldState));
  const rollText = playerDodging
    ? `${attackRoll.text}${formatSigned(attackBonus)} = ${attackTotal}`
    : `${attackRoll.text}${formatSigned(attackBonus)} = ${attackTotal}`;
  const conditionSources = [
    ...getAttackModeSources({ attacker: actor, target: player, defenderDodging: playerDodging }),
    ...(luckyDefensePrimed ? ['Lucky'] : []),
    ...formatConditionD20Sources(actor),
  ];
  const modeText = attackMode
    ? ` (${attackMode}: ${conditionSources.join(', ')})`
    : conditionAttackModifier
      ? ` (${conditionSources.join(', ')})`
      : '';
  const nextWorldState = consumeLuckyDefense(worldState, luckyDefensePrimed);
  const criticalHit = natural === 20;
  const criticalMiss = natural === 1;

  if (!criticalMiss && (criticalHit || attackTotal >= ac)) {
    const frame = {
      attack,
      attack_roll: attackRoll,
      attack_total: attackTotal,
      ac_before: ac,
      roll_text: rollText,
      mode_text: modeText,
      critical_hit: criticalHit,
    };
    const pendingReaction = allowReactionWindow
      ? buildAttackHitReaction({
          actor,
          attack,
          attackRoll,
          attackTotal,
          ac,
          rollText,
          modeText,
          criticalHit,
          worldState: nextWorldState,
          characterSheet,
        })
      : null;
    if (pendingReaction) {
      return {
        actor,
        player,
        worldState: nextWorldState,
        pendingReaction,
        lines: [`${actor.name} uses ${attack.name}: rolls ${rollText} vs AC ${ac}${modeText}. **Hit pending.**`],
      };
    }
    return resolveCreatureAttackHit({
      actor,
      player,
      characterSheet,
      worldState: nextWorldState,
      rollDie,
      frame,
      allowReactionWindow,
    });
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

function resolveCreatureAttackHit({
  actor,
  player,
  characterSheet,
  worldState,
  rollDie,
  frame = {},
  allowReactionWindow = false,
}) {
  const attack = frame.attack || actor.attack || { name: 'attack', damage_formula: '1d6+1' };
  const ac = Number(player.ac || getArmorClass(characterSheet, worldState));
  const criticalHit = Boolean(frame.critical_hit);
  const stillHits = criticalHit || Number(frame.attack_total || 0) >= ac;
  if (!stillHits) {
    return {
      actor: consumeSapAfterAttack(actor),
      player,
      worldState,
      lines: [`${actor.name} uses ${attack.name}: rolls ${frame.roll_text} vs AC ${ac}${frame.mode_text || ''}. **Shield turns the triggering hit into a miss.**`],
    };
  }

  const damage = rollDamage(attack.damage_formula || '1d6+1', rollDie, { crit: criticalHit });
  const before = Number(player.hp ?? getCurrentHp(characterSheet, worldState));
  const reduction = applyPrimedGiantAncestryDamageReduction({
    player,
    worldState,
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
    source: actor.name,
  });
  const thunder = applyPrimedGiantAncestryRetaliation({
    actor,
    worldState: applied.worldState,
    characterSheet,
    damageTaken: applied.amount,
    rollDie,
  });
  const retaliation = getMeleeRetaliation(worldState, applied.beforeTempHp);
  const nextActor = retaliation
    ? { ...thunder.actor, hp: Math.max(0, Number(thunder.actor.hp || 0) - retaliation.damage) }
    : thunder.actor;
  const resolvedActor = consumeSapAfterAttack(nextActor);
  const safeguardLine = applied.safeguardLines.join('');
  const retaliationLine = retaliation
    ? ` ${retaliation.label} lashes back for ${retaliation.damage} ${retaliation.damageType} damage. ${actor.name}: (${actor.hp} -> ${nextActor.hp} HP).`
    : '';
  const pendingReaction = allowReactionWindow && Number(applied.player.hp || 0) > 0
    ? buildDamageTakenReaction({
        actor: resolvedActor,
        attack,
        player: applied.player,
        damageTaken: applied.amount,
        worldState: thunder.worldState,
        characterSheet,
      })
    : null;
  return {
    actor: resolvedActor,
    player: applied.player,
    worldState: thunder.worldState,
    lines: [
      `${actor.name} uses ${attack.name}: rolls ${frame.roll_text} vs AC ${ac}${frame.mode_text || ''}. ${criticalHit ? '**Critical hit.** ' : ''}Hit for ${applied.amount} damage${formatDamageAdjustment(applied.adjustment)}${applied.absorbed ? ` (${applied.absorbed} absorbed by temporary HP)` : ''}. ${player.name}: (${before} -> ${applied.player.hp} HP).${safeguardLine}${retaliationLine}`,
      ...reduction.lines,
      ...thunder.lines,
    ],
    damageEvents: [{
      target: 'player',
      source: actor.name,
      amount: applied.amount,
    }],
    pendingReaction,
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

function pauseCreatureTurns({
  combat,
  combatants,
  player,
  lines,
  damageEvents,
  nextWorldState,
  pendingReaction,
  actorIndex,
  actingIndexes,
  nextOffset,
  advanceRound,
  playerDodging,
  resumePayload = {},
}) {
  const playerIndex = combatants.findIndex((combatant) => combatant.is_player);
  combat.turn_index = actorIndex;
  combat.combatants = syncPlayerCombatant(combatants, playerIndex, player);
  return {
    combat,
    player,
    lines,
    damageEvents,
    paused: true,
    roundsElapsed: 0,
    worldState: nextWorldState,
    pendingReaction: {
      ...pendingReaction,
      resume: buildReactionResume({
        type: REACTION_RESUME_TYPES.CREATURE_TURNS,
        acting_indexes: actingIndexes,
        next_offset: nextOffset,
        actor_index: actorIndex,
        advance_round: Boolean(advanceRound),
        player_dodging: Boolean(playerDodging),
        damage_events: damageEvents,
        stage: pendingReaction.resume_stage || REACTION_RESUME_STAGES.BEFORE_ATTACK,
        ...resumePayload,
      }),
    },
  };
}

function resumeCreatureTurns({ worldState = {}, characterSheet = {}, rollDie = defaultRollDie, pendingReaction = null } = {}) {
  if (!pendingReaction?.resume) return null;
  return resolveCreatureTurns({
    worldState,
    characterSheet,
    rollDie,
    playerDodging: Boolean(pendingReaction.resume.player_dodging),
    advanceRound: Boolean(pendingReaction.resume.advance_round),
    resumeReaction: pendingReaction,
  });
}

function syncPlayerCombatant(combatants = [], playerIndex, player = {}, { clearTurnConditions = false } = {}) {
  return combatants.map((combatant, index) => (
    index === playerIndex
      ? {
          ...combatant,
          hp: player.hp,
          temp_hp: player.temp_hp,
          ac: player.ac ?? combatant.ac,
          conditions: clearTurnConditions
            ? clearPlayerTurnConditions(player.conditions || combatant.conditions)
            : player.conditions || combatant.conditions,
          resistances: player.resistances || combatant.resistances,
          vulnerabilities: player.vulnerabilities || combatant.vulnerabilities,
          immunities: player.immunities || combatant.immunities,
        }
      : combatant
  ));
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
  return rollDie(sides);
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
  resumeCreatureTurns,
  resolveCreatureAction,
  resolveCreatureAttackHit,
  getActingIndexes,
  getTurnSkipReason: getTurnBlockReason,
};
