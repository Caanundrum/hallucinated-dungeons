function hasSubclass(characterSheet = {}, subclassId = '') {
  const selected = normalizeId(
    characterSheet.identity?.subclass
      || characterSheet.identity?.subclass_name
      || characterSheet.class_choices?.subclass,
  );
  return selected === normalizeId(subclassId);
}

function hasSubclassFeature(characterSheet = {}, featureId = '') {
  const wanted = normalizeId(featureId);
  return (characterSheet.features || []).some((feature) => normalizeId(feature.id || feature.name) === wanted);
}

function isChampion(characterSheet = {}) {
  return hasSubclass(characterSheet, 'champion')
    || hasSubclassFeature(characterSheet, 'improved_critical');
}

function isThief(characterSheet = {}) {
  return hasSubclass(characterSheet, 'thief')
    || hasSubclassFeature(characterSheet, 'fast_hands');
}

function getWeaponCriticalThreshold(characterSheet = {}) {
  return isChampion(characterSheet) && getCharacterLevel(characterSheet) >= 3 ? 19 : 20;
}

function getSubclassD20AdvantageSources({ characterSheet = {}, testType = '', ability = '', skill = '' } = {}) {
  if (!isChampion(characterSheet) || getCharacterLevel(characterSheet) < 3) return [];
  if (testType === 'initiative') return ['Remarkable Athlete'];
  if (testType === 'skill_check' && normalizeId(ability) === 'str' && normalizeId(skill) === 'athletics') {
    return ['Remarkable Athlete'];
  }
  return [];
}

function getSneakAttackDice(characterSheet = {}) {
  if (normalizeId(characterSheet.identity?.class || characterSheet.identity?.class_name) !== 'rogue') return 0;
  return Math.max(1, Math.ceil(getCharacterLevel(characterSheet) / 2));
}

function canUseFastHands(characterSheet = {}) {
  return isThief(characterSheet) && getCharacterLevel(characterSheet) >= 3;
}

function grantRemarkableAthleteMovement(worldState = {}, characterSheet = {}) {
  if (!worldState.combat_state?.active || !isChampion(characterSheet)) return worldState;
  const speed = Number(worldState.player_stats?.speed ?? characterSheet.derived_stats?.speed ?? 30);
  const granted = Math.max(0, Math.floor(speed / 2));
  const resources = worldState.combat_state.turn_resources || {};
  return {
    ...worldState,
    combat_state: {
      ...worldState.combat_state,
      turn_resources: {
        ...resources,
        remarkable_athlete_movement_remaining: Number(resources.remarkable_athlete_movement_remaining || 0) + granted,
        used: [
          ...(resources.used || []),
          { resource: 'movement_grant', label: 'Remarkable Athlete', feet: granted },
        ],
      },
    },
  };
}

function getRemarkableAthleteMovement(worldState = {}) {
  return Math.max(0, Number(worldState.combat_state?.turn_resources?.remarkable_athlete_movement_remaining || 0));
}

function spendRemarkableAthleteMovement(worldState = {}, feet = 0) {
  const available = getRemarkableAthleteMovement(worldState);
  const spent = Math.min(available, Math.max(0, Number(feet || 0)));
  if (!spent) return { worldState, spent: 0 };
  const resources = worldState.combat_state?.turn_resources || {};
  return {
    spent,
    worldState: {
      ...worldState,
      combat_state: {
        ...worldState.combat_state,
        turn_resources: {
          ...resources,
          remarkable_athlete_movement_remaining: available - spent,
        },
      },
    },
  };
}

function getCharacterLevel(characterSheet = {}) {
  return Number(characterSheet.identity?.level || characterSheet.derived_stats?.level || 1);
}

function normalizeId(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

module.exports = {
  canUseFastHands,
  getRemarkableAthleteMovement,
  getSneakAttackDice,
  getSubclassD20AdvantageSources,
  getWeaponCriticalThreshold,
  grantRemarkableAthleteMovement,
  hasSubclass,
  isChampion,
  isThief,
  spendRemarkableAthleteMovement,
};
