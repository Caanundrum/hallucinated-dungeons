const {
  grantMovement,
  spendMovement,
  spendTurnResource,
} = require('./actionEconomy');
const {
  getCombatantDistanceFeet,
  getFeetPerHex,
  getHexPosition,
  hexDistance,
  sameMap,
  setHexPosition,
} = require('./combatPositionEngine');
const { applyConditionSpeedPenalty, getTurnBlockReason } = require('./conditionEngine');
const {
  resolveCreatureAction,
  resolveCreatureAttackHit,
} = require('./creatureTurnEngine');
const { formatPendingReactionPrompt } = require('./reactionEngine');
const {
  REACTION_RESUME_STAGES,
  REACTION_RESUME_TYPES,
  buildReactionResume,
} = require('./refereeContracts');

function resolveDashAction({
  message = '',
  worldState = {},
  characterSheet = {},
  rollDie = defaultRollDie,
  destination = null,
} = {}) {
  const spent = spendTurnResource(worldState, 'action', 'Dash', characterSheet);
  if (!spent.ok) return blocked(spent.worldState, spent.reply);

  const speed = getSpeed(characterSheet, spent.worldState);
  const granted = grantMovement(spent.worldState, speed, 'Dash', characterSheet);
  const lines = [`You take the **Dash** action and gain ${speed} feet of movement for this turn.`];
  if (!hasDeclaredMovement(message, destination)) {
    lines.push(`${getRemainingMovement(granted.worldState)} feet of movement remain. You can move, use a Bonus Action, or end your turn.`);
    return resolved('referee_combat_dash', granted.worldState, lines);
  }

  return mergeActionWithMovement({
    logType: 'referee_combat_dash',
    lines,
    movement: resolveCombatMovement({
      message,
      worldState: granted.worldState,
      characterSheet,
      rollDie,
      destination,
    }),
  });
}

function resolveDisengageAction({
  message = '',
  worldState = {},
  characterSheet = {},
  rollDie = defaultRollDie,
  destination = null,
} = {}) {
  const spent = spendTurnResource(worldState, 'action', 'Disengage', characterSheet);
  if (!spent.ok) return blocked(spent.worldState, spent.reply);

  const disengaged = markDisengaged(spent.worldState);
  const lines = ['You take the **Disengage** action. Your movement does not provoke Opportunity Attacks for the rest of this turn.'];
  if (!hasDeclaredMovement(message, destination)) {
    lines.push(`${getRemainingMovement(disengaged)} feet of movement remain. You can move, use a Bonus Action, or end your turn.`);
    return resolved('referee_combat_disengage', disengaged, lines);
  }

  return mergeActionWithMovement({
    logType: 'referee_combat_disengage',
    lines,
    movement: resolveCombatMovement({
      message,
      worldState: disengaged,
      characterSheet,
      rollDie,
      destination,
    }),
  });
}

function resolveCombatMovement({
  message = '',
  worldState = {},
  characterSheet = {},
  rollDie = defaultRollDie,
  destination = null,
} = {}) {
  if (!worldState.combat_state?.active) return null;

  const combat = clone(worldState.combat_state);
  const playerIndex = combat.combatants.findIndex((combatant) => combatant.is_player);
  const player = combat.combatants[playerIndex];
  if (!player) return blocked(worldState, 'Combat movement needs an active character in the initiative tracker.');

  const movement = getMovementRecord({ message, combat, player, destination });
  if (!movement.ok) return blocked(worldState, movement.reply);

  const available = spendMovement(worldState, movement.feet, 'combat movement', characterSheet);
  if (!available.ok) return blocked(available.worldState, available.reply);

  const opportunity = resolveOpportunityAttacks({
    message,
    worldState: { ...worldState, combat_state: combat },
    characterSheet,
    rollDie,
    destination: movement.to,
    allowReactionWindow: true,
  });
  if (opportunity.paused) {
    return pauseCombatMovement({ opportunity, movement });
  }
  return finishCombatMovement({ opportunity, movement, characterSheet });
}

function resumeCombatMovement({
  worldState = {},
  characterSheet = {},
  rollDie = defaultRollDie,
  pendingReaction = null,
  reactionNote = '',
} = {}) {
  if (pendingReaction?.resume?.type !== REACTION_RESUME_TYPES.COMBAT_MOVEMENT) return null;

  const movement = pendingReaction.resume.movement;
  if (!movement) return null;
  const opportunity = resolveOpportunityAttacks({
    message: pendingReaction.resume.message,
    worldState,
    characterSheet,
    rollDie,
    destination: pendingReaction.resume.destination,
    allowReactionWindow: true,
    resumeReaction: pendingReaction,
  });
  opportunity.lines = [reactionNote, ...opportunity.lines].filter(Boolean);
  if (opportunity.paused) {
    return pauseCombatMovement({ opportunity, movement });
  }
  return finishCombatMovement({ opportunity, movement, characterSheet });
}

function finishCombatMovement({ opportunity, movement, characterSheet }) {
  if (Number(opportunity.player?.hp || 0) <= 0) {
    return resolved('referee_combat_movement_stopped', opportunity.worldState, [
      ...opportunity.lines,
      'The Opportunity Attack stops your movement before you leave reach.',
    ], opportunity.damageEvents);
  }

  const spent = spendMovement(opportunity.worldState, movement.feet, 'combat movement', characterSheet);
  if (!spent.ok) return blocked(spent.worldState, spent.reply);
  const nextState = recordMovement(spent.worldState, movement);
  const assumption = opportunity.assumedSceneZone
    ? ' The referee treated the nearby melee enemy as engaged because the current encounter is still using theater-of-mind positioning.'
    : '';
  return resolved('referee_combat_movement', nextState, [
    ...opportunity.lines,
    `You move ${movement.feet} feet${movement.destinationText}. ${getRemainingMovement(nextState)} feet of movement remain.${assumption}`,
    'You can use another available combat resource or end your turn.',
  ], opportunity.damageEvents);
}

function pauseCombatMovement({ opportunity, movement }) {
  const pendingReaction = {
    ...opportunity.pendingReaction,
    resume: {
      ...(opportunity.pendingReaction?.resume || {}),
      movement,
    },
  };
  return resolved('referee_combat_movement_reaction', {
    ...opportunity.worldState,
    pending_reaction: pendingReaction,
  }, [
    ...opportunity.lines,
    formatPendingReactionPrompt(pendingReaction),
  ], opportunity.damageEvents);
}

function resolveOpportunityAttacks({
  message = '',
  worldState = {},
  characterSheet = {},
  rollDie = defaultRollDie,
  destination = null,
  allowReactionWindow = false,
  resumeReaction = null,
} = {}) {
  const combat = clone(worldState.combat_state);
  const combatants = combat.combatants || [];
  const playerIndex = combatants.findIndex((combatant) => combatant.is_player);
  let player = combatants[playerIndex];
  let nextWorldState = { ...worldState, combat_state: combat };
  const continuation = resumeReaction?.resume?.type === REACTION_RESUME_TYPES.COMBAT_MOVEMENT
    ? resumeReaction.resume
    : null;
  const lines = [];
  const damageEvents = [...(continuation?.damage_events || [])];
  let assumedSceneZone = Boolean(continuation?.assumed_scene_zone);
  const disengaged = Boolean(combat.turn_resources?.disengaged);

  if (!player || disengaged) {
    return { worldState: nextWorldState, combat, player, lines, damageEvents, assumedSceneZone };
  }

  let startIndex = 0;
  if (continuation) {
    const actorIndex = Number(continuation.actor_index);
    const actor = combatants[actorIndex];
    if (
      continuation.stage !== REACTION_RESUME_STAGES.AFTER_ATTACK
      && actor
      && !actor.is_player
      && Number(actor.hp || 0) > 0
    ) {
      const attack = resolveCreatureAttackHit({
        actor,
        player,
        characterSheet,
        worldState: nextWorldState,
        rollDie,
        frame: resumeReaction.attack_frame,
        allowReactionWindow: true,
      });
      combatants[actorIndex] = {
        ...attack.actor,
        reaction_available: false,
      };
      player = attack.player;
      nextWorldState = syncOpportunityAttackState({
        worldState: attack.worldState || nextWorldState,
        combat,
        player,
        playerIndex,
      });
      lines.push(`**Opportunity Attack:** ${attack.lines.join('\n\n')}`);
      damageEvents.push(...(attack.damageEvents || []));
      if (attack.pendingReaction) {
        return {
          worldState: nextWorldState,
          combat,
          player,
          lines,
          damageEvents,
          assumedSceneZone,
          paused: true,
          pendingReaction: {
            ...attack.pendingReaction,
            resume: buildReactionResume({
              type: REACTION_RESUME_TYPES.COMBAT_MOVEMENT,
              message: continuation.message,
              destination: continuation.destination,
              actor_index: actorIndex,
              next_index: Number(continuation.next_index || 0),
              assumed_scene_zone: assumedSceneZone,
              damage_events: damageEvents,
              stage: attack.pendingReaction.resume_stage || REACTION_RESUME_STAGES.BEFORE_ATTACK,
            }),
          },
        };
      }
    }
    startIndex = Number(continuation.next_index || 0);
    if (Number(player.hp || 0) <= 0) {
      return { worldState: nextWorldState, combat, player, lines, damageEvents, assumedSceneZone };
    }
  }

  for (let index = startIndex; index < combatants.length; index += 1) {
    const actor = combatants[index];
    const trigger = getOpportunityAttackTrigger({
      actor,
      player,
      message,
      destination,
    });
    if (!trigger.provokes) continue;
    assumedSceneZone ||= trigger.mode === 'scene_zone_assumption';

    const attack = resolveCreatureAction({
      actor,
      player,
      characterSheet,
      worldState: nextWorldState,
      rollDie,
      playerDodging: false,
      allowReactionWindow,
    });
    combatants[index] = {
      ...attack.actor,
      reaction_available: false,
    };
    player = attack.player;
    nextWorldState = syncOpportunityAttackState({
      worldState: attack.worldState || nextWorldState,
      combat,
      player,
      playerIndex,
    });
    lines.push(`**Opportunity Attack:** ${attack.lines.join('\n\n')}`);
    damageEvents.push(...(attack.damageEvents || []));
    if (attack.pendingReaction) {
      return {
        worldState: nextWorldState,
        combat,
        player,
        lines,
        damageEvents,
        assumedSceneZone,
        paused: true,
        pendingReaction: {
          ...attack.pendingReaction,
          resume: buildReactionResume({
            type: REACTION_RESUME_TYPES.COMBAT_MOVEMENT,
            message,
            destination,
            actor_index: index,
            next_index: index + 1,
            assumed_scene_zone: assumedSceneZone,
            damage_events: damageEvents,
            stage: attack.pendingReaction.resume_stage || REACTION_RESUME_STAGES.BEFORE_ATTACK,
          }),
        },
      };
    }
    if (Number(player.hp || 0) <= 0) break;
  }

  return { worldState: nextWorldState, combat, player, lines, damageEvents, assumedSceneZone };
}

function syncOpportunityAttackState({ worldState = {}, combat = {}, player = {}, playerIndex = -1 }) {
  combat.combatants[playerIndex] = {
    ...combat.combatants[playerIndex],
    hp: player.hp,
    temp_hp: player.temp_hp,
    ac: player.ac ?? combat.combatants[playerIndex]?.ac,
    conditions: player.conditions || combat.combatants[playerIndex]?.conditions,
  };
  return syncPlayerState({
    ...worldState,
    combat_state: combat,
  }, player);
}

function getOpportunityAttackTrigger({
  actor = {},
  player = {},
  message = '',
  destination = null,
} = {}) {
  if (!canMakeOpportunityAttack(actor)) return { provokes: false, mode: null };

  const before = getCombatantDistanceFeet(player, actor);
  const reach = getCreatureReach(actor);
  if (before !== null) {
    if (Number(before) > reach) return { provokes: false, mode: 'hex' };
    if (!destination) {
      return {
        provokes: !staysWithinReachBySceneAssumption(message),
        mode: 'scene_zone_assumption',
      };
    }
    const after = getDistanceFromDestination(actor, destination);
    return {
      provokes: Number(before) <= reach && Number(after) > reach,
      mode: 'hex',
    };
  }

  return {
    provokes: actor.melee_engaged !== false && !staysWithinReachBySceneAssumption(message),
    mode: 'scene_zone_assumption',
  };
}

function getMovementRecord({ message = '', combat = {}, player = {}, destination = null } = {}) {
  const from = getHexPosition(player);
  let feet = getDeclaredMovementFeet(message);
  let mode = 'scene_zone_assumption';
  let destinationText = '';

  if (destination) {
    if (!from) return { ok: false, reply: 'Map movement needs the active character to have a current hex position first.' };
    if (!sameMap(from, destination)) return { ok: false, reply: 'Combat movement cannot cross into a different map or encounter layer.' };
    if (isOccupied(combat, destination, player)) return { ok: false, reply: 'That destination is occupied. Choose an open space.' };
    feet = hexDistance(from, destination) * getFeetPerHex(from, destination);
    mode = 'hex';
    destinationText = ` to hex (${Number(destination.q)}, ${Number(destination.r)})`;
  }

  if (!Number.isFinite(feet) || feet <= 0) {
    return { ok: false, reply: 'Say how far you want to move in feet so the referee can apply movement and any Opportunity Attacks.' };
  }

  return {
    ok: true,
    type: 'movement',
    source: 'combat movement',
    feet,
    mode,
    from,
    to: destination ? { ...destination, q: Number(destination.q), r: Number(destination.r) } : null,
    destinationText,
  };
}

function recordMovement(worldState = {}, movement = {}) {
  const combat = clone(worldState.combat_state);
  const player = combat.combatants.find((combatant) => combatant.is_player);
  if (player && movement.to) setHexPosition(player, movement.to);
  if (player) player.last_movement = movement;
  return {
    ...worldState,
    combat_state: combat,
    player_stats: {
      ...(worldState.player_stats || {}),
      last_movement: movement,
    },
  };
}

function markDisengaged(worldState = {}) {
  if (!worldState.combat_state?.active) return worldState;
  return {
    ...worldState,
    combat_state: {
      ...worldState.combat_state,
      turn_resources: {
        ...(worldState.combat_state.turn_resources || {}),
        disengaged: true,
      },
    },
  };
}

function mergeActionWithMovement({ logType, lines = [], movement }) {
  if (!movement) return null;
  return {
    ...movement,
    logType,
    reply: [...lines, movement.reply].filter(Boolean).join('\n\n'),
  };
}

function canMakeOpportunityAttack(actor = {}) {
  return !actor.is_player
    && Number(actor.hp || 0) > 0
    && actor.reaction_available !== false
    && actor.can_see_player !== false
    && isMeleeAttack(actor.attack)
    && !getTurnBlockReason(actor);
}

function isMeleeAttack(attack = {}) {
  const descriptor = normalizeId([
    attack.attack_kind,
    attack.kind,
    attack.type,
    attack.name,
  ].filter(Boolean).join(' '));
  return attack.melee !== false
    && !/\b(?:ranged|shortbow|longbow|crossbow|bow|sling|shot)\b/.test(descriptor.replaceAll('_', ' '));
}

function getCreatureReach(actor = {}) {
  const attack = actor.attack || {};
  const reach = Number(attack.reach_feet ?? attack.reach ?? actor.reach ?? 5);
  return Number.isFinite(reach) && reach > 0 ? reach : 5;
}

function getDistanceFromDestination(actor = {}, destination = null) {
  const actorPosition = getHexPosition(actor);
  if (!actorPosition || !destination || !sameMap(actorPosition, destination)) return Number.POSITIVE_INFINITY;
  return hexDistance(actorPosition, destination) * getFeetPerHex(actorPosition, destination);
}

function isOccupied(combat = {}, destination = {}, player = {}) {
  return (combat.combatants || []).some((combatant) => {
    if (combatant === player || Number(combatant.hp || 0) <= 0) return false;
    const position = getHexPosition(combatant);
    return position
      && sameMap(position, destination)
      && position.q === Number(destination.q)
      && position.r === Number(destination.r);
  });
}

function syncPlayerState(worldState = {}, player = {}) {
  return {
    ...worldState,
    player_stats: {
      ...(worldState.player_stats || {}),
      hp: player.hp,
      max_hp: player.max_hp,
      temp_hp: player.temp_hp,
    },
  };
}

function getSpeed(characterSheet = {}, worldState = {}) {
  const baseSpeed = Number(worldState.player_stats?.speed ?? characterSheet.derived_stats?.speed ?? 30);
  return applyConditionSpeedPenalty(baseSpeed, getPlayerConditionSubject(characterSheet, worldState));
}

function getPlayerConditionSubject(characterSheet = {}, worldState = {}) {
  return {
    conditions: [
      ...(characterSheet.derived_stats?.conditions || []),
      ...(worldState.player_stats?.conditions || []),
    ],
    exhaustion_level: worldState.player_stats?.exhaustion_level ?? characterSheet.derived_stats?.exhaustion_level,
  };
}

function getRemainingMovement(worldState = {}) {
  return Number(worldState.combat_state?.turn_resources?.movement_remaining || 0);
}

function getDeclaredMovementFeet(message = '') {
  const match = String(message || '').match(/\b(\d+)\s*(?:feet|foot|ft)\b/i);
  return match ? Number(match[1]) : 0;
}

function hasDeclaredMovement(message = '', destination = null) {
  return Boolean(destination) || getDeclaredMovementFeet(message) > 0;
}

function movesAwayFromEnemy(message = '') {
  return /\b(?:away|back|withdraw|retreat|flee|escape|leave|past|out of reach|toward the exit|towards the exit)\b/i.test(String(message || ''));
}

function staysWithinReachBySceneAssumption(message = '') {
  const text = String(message || '');
  if (movesAwayFromEnemy(text)) return false;
  return /\b(?:toward|towards|approach|closer|close in|circle|around|flank|adjacent|within reach)\b/i.test(text);
}

function resolved(logType, worldState, lines = [], damageEvents = []) {
  return {
    handled: true,
    logType,
    worldState,
    reply: lines.filter(Boolean).join('\n\n'),
    damageEvents,
  };
}

function blocked(worldState, reply) {
  return resolved('referee_combat_movement_blocked', worldState, [reply]);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function defaultRollDie(sides) {
  return Math.ceil(Math.random() * Number(sides || 20));
}

module.exports = {
  getDeclaredMovementFeet,
  getOpportunityAttackTrigger,
  markDisengaged,
  resolveCombatMovement,
  resolveDashAction,
  resolveDisengageAction,
  resolveOpportunityAttacks,
  resumeCombatMovement,
};
