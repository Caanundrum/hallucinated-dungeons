const HEX_DIRECTIONS = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

function getHexPosition(combatant = {}) {
  const position = combatant.position || combatant.map_position || null;
  if (!position || position.q === null || position.q === undefined || position.r === null || position.r === undefined) return null;
  const q = Number(position.q);
  const r = Number(position.r);
  if (!Number.isFinite(q) || !Number.isFinite(r)) return null;
  return { ...position, q, r };
}

function sameMap(...positions) {
  const ids = positions.map((position) => position?.map_id).filter(Boolean);
  return new Set(ids).size <= 1;
}

function hexDistance(left, right) {
  const dq = Number(left.q) - Number(right.q);
  const dr = Number(left.r) - Number(right.r);
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

function getFeetPerHex(...positions) {
  return Number(positions.find((position) => Number(position?.feet_per_hex) > 0)?.feet_per_hex || 5);
}

function getCombatantDistanceFeet(left = {}, right = {}) {
  const leftPosition = getHexPosition(left);
  const rightPosition = getHexPosition(right);
  if (!leftPosition || !rightPosition) return null;
  if (!sameMap(leftPosition, rightPosition)) return Number.POSITIVE_INFINITY;
  return hexDistance(leftPosition, rightPosition) * getFeetPerHex(leftPosition, rightPosition);
}

function getWeaponReach(attack = {}) {
  return (attack.properties || []).includes('reach') ? 10 : 5;
}

function pushCombatantAway({ source = {}, target = {}, feet = 0 } = {}) {
  const sourcePosition = getHexPosition(source);
  const targetPosition = getHexPosition(target);
  const pushedFeet = Math.max(0, Number(feet || 0));
  if (!sourcePosition || !targetPosition || !sameMap(sourcePosition, targetPosition)) {
    target.forced_movement = {
      feet: pushedFeet,
      direction: 'away_from_player',
      source: 'Push mastery',
      mode: 'scene_zone_assumption',
    };
    return target.forced_movement;
  }

  const feetPerHex = getFeetPerHex(sourcePosition, targetPosition);
  const steps = Math.floor(pushedFeet / feetPerHex);
  const direction = getAwayDirection(sourcePosition, targetPosition);
  const destination = {
    ...targetPosition,
    q: targetPosition.q + (direction.q * steps),
    r: targetPosition.r + (direction.r * steps),
  };
  setHexPosition(target, destination);
  target.forced_movement = {
    feet: steps * feetPerHex,
    direction: 'away_from_player',
    source: 'Push mastery',
    mode: 'hex',
    from: targetPosition,
    to: destination,
  };
  return target.forced_movement;
}

function getAwayDirection(sourcePosition, targetPosition) {
  return HEX_DIRECTIONS.reduce((best, direction) => {
    const candidate = {
      q: targetPosition.q + direction.q,
      r: targetPosition.r + direction.r,
    };
    return hexDistance(sourcePosition, candidate) > hexDistance(sourcePosition, {
      q: targetPosition.q + best.q,
      r: targetPosition.r + best.r,
    })
      ? direction
      : best;
  }, HEX_DIRECTIONS[0]);
}

function setHexPosition(combatant, position) {
  if (combatant.position) {
    combatant.position = position;
  } else {
    combatant.map_position = position;
  }
}

module.exports = {
  getCombatantDistanceFeet,
  getFeetPerHex,
  getHexPosition,
  getWeaponReach,
  hexDistance,
  pushCombatantAway,
  sameMap,
  setHexPosition,
};
