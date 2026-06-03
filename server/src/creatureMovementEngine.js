const {
  getCombatantDistanceFeet,
  getFeetPerHex,
  getHexPosition,
  getWeaponReach,
  hexDistance,
  sameMap,
  setHexPosition,
} = require('./combatPositionEngine');
const { buildCreatureLeavesReachReaction } = require('./reactionEngine');
const {
  getPlayerOpportunityReach,
  resolvePlayerOpportunityAttack,
} = require('./playerOpportunityAttackEngine');

const HEX_DIRECTIONS = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

function resolveCreatureMovementBeforeAction({
  actor = {},
  player = {},
  combat = {},
  worldState = {},
  characterSheet = {},
  allowReactionWindow = false,
} = {}) {
  const movement = buildCreatureMovementPlan({ actor, player, combat, characterSheet });
  if (!movement) return noMovement({ actor, player, combat, worldState });
  if (!movement.ok) {
    return {
      actor,
      player,
      combat,
      worldState,
      lines: [movement.reply],
      actionAvailable: true,
    };
  }

  if (movement.provokes && allowReactionWindow) {
    const pendingReaction = buildCreatureLeavesReachReaction({
      actor,
      player,
      movement,
      worldState: { ...worldState, combat_state: combat },
      characterSheet,
    });
    if (pendingReaction) {
      return {
        actor,
        player,
        combat,
        worldState,
        lines: [`${actor.name} starts to move ${movement.directionText}.`],
        pendingReaction,
        movement,
        actionAvailable: false,
      };
    }
  }

  return applyCreatureMovement({ actor, player, combat, worldState, movement });
}

function resumeCreatureMovementAfterReaction({
  actor = {},
  player = {},
  combat = {},
  worldState = {},
  characterSheet = {},
  pendingReaction = {},
  rollDie = defaultRollDie,
} = {}) {
  const movement = pendingReaction.resume?.creature_movement;
  if (!movement) return noMovement({ actor, player, combat, worldState });

  let nextActor = actor;
  let nextPlayer = player;
  let nextCombat = combat;
  let nextWorldState = { ...worldState, combat_state: combat };
  const lines = [];

  if (pendingReaction.chosen_option?.type === 'weapon_attack') {
    const attack = resolvePlayerOpportunityAttack({
      worldState: nextWorldState,
      characterSheet,
      combat: nextCombat,
      player: nextPlayer,
      target: nextActor,
      rollDie,
    });
    nextWorldState = attack.worldState;
    nextCombat = attack.combat;
    nextPlayer = attack.player;
    nextActor = attack.target;
    lines.push(...attack.lines);
    if (Number(nextActor.hp || 0) <= 0) {
      return {
        actor: nextActor,
        player: nextPlayer,
        combat: nextCombat,
        worldState: nextWorldState,
        lines,
        actionAvailable: false,
      };
    }
  }

  const moved = applyCreatureMovement({
    actor: nextActor,
    player: nextPlayer,
    combat: nextCombat,
    worldState: nextWorldState,
    movement,
  });
  return {
    ...moved,
    lines: [...lines, ...moved.lines],
  };
}

function buildCreatureMovementPlan({
  actor = {},
  player = {},
  combat = {},
  characterSheet = {},
} = {}) {
  const explicit = normalizeExplicitMovement(actor);
  if (explicit) return finalizeMovementPlan({ actor, player, combat, characterSheet, movement: explicit });

  if (isFleeing(actor)) {
    return finalizeMovementPlan({
      actor,
      player,
      combat,
      characterSheet,
      movement: {
        type: 'move',
        reason: 'fleeing',
        direction: 'away',
        feet: getCreatureSpeed(actor),
        ends_turn: true,
      },
    });
  }

  const distance = getCombatantDistanceFeet(actor, player);
  const reach = getWeaponReach(actor.attack || {});
  if (isMeleeAttack(actor.attack) && Number.isFinite(distance) && distance > reach) {
    return finalizeMovementPlan({
      actor,
      player,
      combat,
      characterSheet,
      movement: {
        type: 'move',
        reason: 'closing',
        direction: 'toward',
        feet: getCreatureSpeed(actor),
        attack_after_movement: true,
      },
    });
  }

  return null;
}

function finalizeMovementPlan({ actor, player, combat, characterSheet, movement }) {
  const from = getHexPosition(actor);
  const playerPosition = getHexPosition(player);
  const speed = getCreatureSpeed(actor);
  const feet = Math.max(0, Math.min(Number(movement.feet || speed), speed));
  const direction = movement.direction || (movement.destination || movement.to ? 'planned' : 'toward');
  const disengage = Boolean(movement.disengage || movement.action === 'disengage');
  let to = normalizeDestination(movement.destination || movement.to);
  let mode = 'scene_zone_assumption';
  let destinationText = direction === 'away' ? 'away from you' : 'toward you';
  let actionAvailable = movement.attack_after_movement !== false && !movement.ends_turn && !disengage;

  if (from && playerPosition && sameMap(from, playerPosition)) {
    mode = 'hex';
    if (!to) {
      to = direction === 'away'
        ? computeStepDestination({ from, reference: playerPosition, feet, mode: 'away' })
        : computeStepDestination({ from, reference: playerPosition, feet, mode: 'toward', stopReach: getWeaponReach(actor.attack || {}) });
    }
    if (!to) {
      return { ok: false, reply: `${actor.name} cannot find a legal space to move to.` };
    }
    if (!sameMap(from, to)) return { ok: false, reply: `${actor.name} cannot move to a different map layer during this turn.` };
    if (isOccupied(combat, to, actor)) return { ok: false, reply: `${actor.name}'s chosen destination is occupied, so it stays put.` };
    const actualFeet = hexDistance(from, to) * getFeetPerHex(from, to);
    if (actualFeet > speed) return { ok: false, reply: `${actor.name} cannot move ${actualFeet} feet with only ${speed} feet of Speed.` };
    destinationText = `to hex (${Number(to.q)}, ${Number(to.r)})`;
    const afterDistance = getDistanceFromPosition(playerPosition, to);
    actionAvailable = actionAvailable && (!isMeleeAttack(actor.attack) || afterDistance <= getWeaponReach(actor.attack || {}));
  } else if (direction === 'toward') {
    actionAvailable = true;
  } else if (direction === 'away') {
    actionAvailable = false;
  }

  const provokes = !disengage && leavesPlayerReach({
    actor,
    player,
    characterSheet,
    movement: { mode, from, to, direction },
  });

  return {
    ok: true,
    type: 'creature_movement',
    actor_name: actor.name || 'Creature',
    reason: movement.reason || direction,
    mode,
    from,
    to,
    feet: mode === 'hex' && from && to ? hexDistance(from, to) * getFeetPerHex(from, to) : feet,
    direction,
    directionText: destinationText,
    destinationText,
    provokes,
    disengage,
    actionAvailable,
  };
}

function applyCreatureMovement({ actor = {}, player = {}, combat = {}, worldState = {}, movement = {} } = {}) {
  const nextCombat = clone(combat);
  const nextActor = findCombatantByName(nextCombat, actor.name) || actor;
  const lines = [];
  if (movement.disengage) {
    lines.push(`${nextActor.name} takes the **Disengage** action before moving. No Opportunity Attack is provoked.`);
  }
  if (movement.mode === 'hex' && movement.to) {
    setHexPosition(nextActor, movement.to);
  } else if (movement.direction === 'away') {
    nextActor.melee_engaged = false;
  } else if (movement.direction === 'toward') {
    nextActor.melee_engaged = true;
  }
  nextActor.last_movement = movement;
  lines.push(`${nextActor.name} moves ${movement.feet} feet ${movement.destinationText}.`);
  return {
    actor: nextActor,
    player: nextCombat.combatants?.find((combatant) => combatant.is_player) || player,
    combat: nextCombat,
    worldState: {
      ...worldState,
      combat_state: nextCombat,
    },
    lines,
    actionAvailable: Boolean(movement.actionAvailable),
  };
}

function leavesPlayerReach({ actor = {}, player = {}, characterSheet = {}, movement = {} } = {}) {
  if (movement.direction === 'toward') return false;
  const playerReach = getPlayerOpportunityReach(characterSheet);
  const before = getCombatantDistanceFeet(player, actor);
  if (Number.isFinite(before)) {
    if (before > playerReach) return false;
    if (!movement.to) return true;
    const playerPosition = getHexPosition(player);
    const after = playerPosition ? getDistanceFromPosition(playerPosition, movement.to) : Number.POSITIVE_INFINITY;
    return after > playerReach;
  }
  return actor.melee_engaged !== false && movement.direction === 'away';
}

function normalizeExplicitMovement(actor = {}) {
  const movement = actor.movement_plan || actor.planned_movement || actor.next_movement || null;
  if (!movement) return null;
  if (typeof movement === 'string') {
    return { type: 'move', reason: movement, direction: normalizeDirection(movement), feet: getCreatureSpeed(actor) };
  }
  return {
    type: 'move',
    ...movement,
    direction: normalizeDirection(movement.direction || movement.type || movement.reason),
  };
}

function normalizeDirection(value = '') {
  const text = String(value || '').toLowerCase();
  if (/\b(?:away|flee|retreat|withdraw|escape)\b/.test(text)) return 'away';
  if (/\b(?:toward|close|approach|advance|engage)\b/.test(text)) return 'toward';
  return 'planned';
}

function isFleeing(actor = {}) {
  const text = [
    actor.behavior,
    actor.morale,
    actor.tactic,
    actor.intent,
    ...(actor.conditions || []),
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(?:fleeing|flee|retreating|retreat|withdraw|escape|routing|routed|fearful)\b/.test(text);
}

function computeStepDestination({ from, reference, feet, mode, stopReach = 0 }) {
  const feetPerHex = getFeetPerHex(from, reference);
  const steps = Math.floor(Number(feet || 0) / feetPerHex);
  if (steps <= 0) return { ...from };
  let current = { ...from };
  for (let index = 0; index < steps; index += 1) {
    const next = bestNeighbor(current, reference, mode);
    if (!next) break;
    current = { ...current, ...next };
    if (mode === 'toward' && hexDistance(current, reference) * feetPerHex <= stopReach) break;
  }
  return current;
}

function bestNeighbor(current, reference, mode) {
  return HEX_DIRECTIONS
    .map((direction) => ({
      ...current,
      q: Number(current.q) + direction.q,
      r: Number(current.r) + direction.r,
    }))
    .sort((left, right) => {
      const leftDistance = hexDistance(left, reference);
      const rightDistance = hexDistance(right, reference);
      return mode === 'away' ? rightDistance - leftDistance : leftDistance - rightDistance;
    })[0] || null;
}

function getDistanceFromPosition(sourcePosition, destination) {
  if (!sourcePosition || !destination || !sameMap(sourcePosition, destination)) return Number.POSITIVE_INFINITY;
  return hexDistance(sourcePosition, destination) * getFeetPerHex(sourcePosition, destination);
}

function isOccupied(combat = {}, destination = {}, mover = {}) {
  return (combat.combatants || []).some((combatant) => {
    if (combatant === mover || combatant.name === mover.name || Number(combatant.hp || 0) <= 0) return false;
    const position = getHexPosition(combatant);
    return position
      && sameMap(position, destination)
      && position.q === Number(destination.q)
      && position.r === Number(destination.r);
  });
}

function normalizeDestination(destination = null) {
  if (!destination || destination.q === undefined || destination.r === undefined) return null;
  return {
    ...destination,
    q: Number(destination.q),
    r: Number(destination.r),
  };
}

function isMeleeAttack(attack = {}) {
  const descriptor = String([
    attack.attack_kind,
    attack.attackKind,
    attack.kind,
    attack.type,
    attack.name,
  ].filter(Boolean).join(' ')).toLowerCase();
  return attack.melee !== false
    && !/\b(?:ranged|shortbow|longbow|crossbow|bow|sling|shot)\b/.test(descriptor);
}

function getCreatureSpeed(actor = {}) {
  const speed = Number(actor.speed ?? 30) - Number(actor.speed_penalty || 0);
  return Math.max(0, speed);
}

function findCombatantByName(combat = {}, name = '') {
  const target = normalizeText(name);
  return (combat.combatants || []).find((combatant) => normalizeText(combatant.name) === target) || null;
}

function noMovement({ actor, player, combat, worldState }) {
  return { actor, player, combat, worldState, lines: [], actionAvailable: true };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function defaultRollDie(sides) {
  return Math.ceil(Math.random() * Number(sides || 20));
}

module.exports = {
  buildCreatureMovementPlan,
  resolveCreatureMovementBeforeAction,
  resumeCreatureMovementAfterReaction,
};
