const { resolveSavingThrow } = require('./conditionEngine');

const LARGE_OR_SMALLER = new Set(['tiny', 'small', 'medium', 'large']);

function getWeaponPropertyAttackMode({ attack = {}, characterSheet = {} } = {}) {
  if (!hasProperty(attack, 'heavy')) return null;
  const ability = attack.attackKind === 'ranged' ? 'dex' : 'str';
  return getAbilityScore(characterSheet, ability) < 13 ? 'disadvantage' : null;
}

function getWeaponPropertyAttackSources({ attack = {}, characterSheet = {} } = {}) {
  return getWeaponPropertyAttackMode({ attack, characterSheet })
    ? ['Heavy weapon minimum ability score']
    : [];
}

function getWeaponDamageFormula({ attack = {}, message = '' } = {}) {
  if (!attack.isWeapon || !hasProperty(attack, 'versatile') || !wantsTwoHandedUse(message)) {
    return attack.damageFormula;
  }
  return replaceDamageDice(attack.damageFormula, attack.versatileDamage);
}

function getWeaponMasteryAdvantageSources(target = {}) {
  return getMasteryEffects(target).some((effect) => effect.type === 'vex')
    ? ['Vex mastery']
    : [];
}

function consumeVexAdvantage(target = {}) {
  return removeMasteryEffects(target, (effect) => effect.type === 'vex');
}

function applyWeaponMasteryOnHit({
  attack = {},
  target = {},
  combat = {},
  characterSheet = {},
  damageDealt = 0,
  rollDie = defaultRollDie,
} = {}) {
  const mastery = getSelectedWeaponMastery(characterSheet, attack);
  if (!mastery || Number(target.hp || 0) <= 0) return { lines: [], mastery: null };

  if (mastery === 'push') {
    if (!canPushTarget(target)) return { lines: [], mastery };
    target.forced_movement = { feet: 10, direction: 'away_from_player', source: 'Push mastery' };
    return { lines: [`**Push mastery:** ${target.name} is pushed up to 10 feet straight away, subject to available space in the scene.`], mastery };
  }

  if (mastery === 'sap') {
    addMasteryEffect(target, {
      type: 'sap',
      source: 'player',
      expires: 'after_next_attack',
      fallback_expires: 'start_of_player_turn',
      expires_round: Number(combat.round || 1) + 1,
    });
    target.conditions = addCondition(target.conditions, 'sapped');
    return { lines: [`**Sap mastery:** ${target.name} has Disadvantage on its next attack before the start of your next turn.`], mastery };
  }

  if (mastery === 'slow') {
    if (Number(damageDealt || 0) <= 0) return { lines: [], mastery };
    addMasteryEffect(target, {
      type: 'slow',
      source: 'player',
      speed_penalty: 10,
      expires: 'start_of_player_turn',
      expires_round: Number(combat.round || 1) + 1,
    });
    target.conditions = addCondition(target.conditions, 'slowed');
    target.speed_penalty = Math.max(Number(target.speed_penalty || 0), 10);
    return { lines: [`**Slow mastery:** ${target.name}'s Speed is reduced by 10 feet until the start of your next turn.`], mastery };
  }

  if (mastery === 'topple') {
    const abilityModifier = getAttackAbilityModifier(characterSheet, attack);
    const dc = 8 + abilityModifier + getProficiencyBonus(characterSheet);
    const bonus = getCreatureSaveBonus(target, 'con');
    const save = resolveSavingThrow({ target, ability: 'con', dc, bonus, rollDie });
    const saveText = save.automaticFailure ? save.text : `${save.text} vs DC ${dc}`;
    if (save.success) {
      return { lines: [`**Topple mastery:** ${target.name} makes a CON save (${saveText}) and stays upright.`], mastery };
    }
    target.conditions = addCondition(target.conditions, 'prone');
    return { lines: [`**Topple mastery:** ${target.name} makes a CON save (${saveText}) and falls **prone**.`], mastery };
  }

  if (mastery === 'vex') {
    if (Number(damageDealt || 0) <= 0) return { lines: [], mastery };
    addMasteryEffect(target, {
      type: 'vex',
      source: 'player',
      expires: 'end_of_player_turn',
      expires_round: Number(combat.round || 1) + 1,
    });
    return { lines: [`**Vex mastery:** your next attack against ${target.name} has Advantage before the end of your next turn.`], mastery };
  }

  return { lines: [], mastery };
}

function applyWeaponMasteryOnMiss({ attack = {}, target = {}, characterSheet = {} } = {}) {
  const mastery = getSelectedWeaponMastery(characterSheet, attack);
  if (mastery !== 'graze' || Number(target.hp || 0) <= 0) return { lines: [], mastery };
  const damage = Math.max(0, getAttackAbilityModifier(characterSheet, attack));
  if (!damage) return { lines: [], mastery };
  const before = Number(target.hp || 0);
  target.hp = Math.max(0, before - damage);
  return {
    mastery,
    lines: [`**Graze mastery:** the miss still deals ${damage} ${attack.damageType || 'weapon'} damage from your ${String(attack.ability || 'attack').toUpperCase()} modifier. ${target.name}: (${before} -> ${target.hp} HP).`],
  };
}

function expireMasteryEffects(combat = {}, { timing, round } = {}) {
  return {
    ...combat,
    combatants: (combat.combatants || []).map((combatant) => {
      const effects = getMasteryEffects(combatant);
      const retained = effects.filter((effect) => !(
        (effect.expires === timing || effect.fallback_expires === timing)
        && Number(effect.expires_round || 0) <= Number(round || 0)
      ));
      return syncMasteryEffects(combatant, retained);
    }),
  };
}

function consumeSapAfterAttack(actor = {}) {
  return removeMasteryEffects(actor, (effect) => effect.type === 'sap');
}

function getSelectedWeaponMastery(characterSheet = {}, attack = {}) {
  if (!attack.isWeapon || !attack.weaponId) return null;
  const selected = (characterSheet.weapon_masteries || [])
    .find((entry) => normalizeId(entry.weapon_id || entry.weaponId) === normalizeId(attack.weaponId));
  return normalizeId(selected?.mastery) || null;
}

function getAttackAbilityModifier(characterSheet = {}, attack = {}) {
  return Number(characterSheet.abilities?.modifiers?.[attack.ability] || 0);
}

function getProficiencyBonus(characterSheet = {}) {
  const level = Number(characterSheet.identity?.level || characterSheet.derived_stats?.level || 1);
  return Number(characterSheet.derived_stats?.proficiency_bonus || Math.floor((level - 1) / 4) + 2);
}

function getCreatureSaveBonus(target = {}, ability) {
  return Number(
    target.saves?.[ability]
      ?? target.save_modifiers?.[ability]
      ?? target.ability_modifiers?.[ability]
      ?? 0,
  );
}

function getAbilityScore(characterSheet = {}, ability) {
  return Number(
    characterSheet.abilities?.final_scores?.[ability]
      ?? characterSheet.abilities?.scores?.[ability]
      ?? 10 + (2 * Number(characterSheet.abilities?.modifiers?.[ability] || 0)),
  );
}

function wantsTwoHandedUse(message = '') {
  return /\b(?:two[- ]handed|with (?:my |both )?hands|in both hands|using both hands)\b/i.test(String(message || ''));
}

function replaceDamageDice(formula, replacement) {
  if (!replacement) return formula;
  return String(formula || '').replace(/\d+d\d+/i, String(replacement));
}

function hasProperty(attack = {}, property) {
  return (attack.properties || []).map(normalizeId).includes(normalizeId(property));
}

function canPushTarget(target = {}) {
  const size = normalizeId(target.size);
  return !size || LARGE_OR_SMALLER.has(size);
}

function addMasteryEffect(target = {}, effect) {
  const retained = getMasteryEffects(target).filter((current) => current.type !== effect.type);
  target.mastery_effects = [...retained, effect];
}

function removeMasteryEffects(target = {}, predicate) {
  return syncMasteryEffects(target, getMasteryEffects(target).filter((effect) => !predicate(effect)));
}

function syncMasteryEffects(target = {}, effects = []) {
  const removedTypes = new Set(getMasteryEffects(target)
    .filter((effect) => !effects.includes(effect))
    .map((effect) => effect.type));
  const next = {
    ...target,
    mastery_effects: effects,
  };
  if (removedTypes.has('sap')) next.conditions = removeCondition(next.conditions, 'sapped');
  if (removedTypes.has('slow')) {
    next.conditions = removeCondition(next.conditions, 'slowed');
    next.speed_penalty = 0;
  }
  return next;
}

function getMasteryEffects(target = {}) {
  return Array.isArray(target.mastery_effects) ? target.mastery_effects : [];
}

function addCondition(conditions = [], condition) {
  return [...new Set([...(conditions || []), condition].filter(Boolean))];
}

function removeCondition(conditions = [], condition) {
  const target = normalizeId(condition);
  return (conditions || []).filter((entry) => normalizeId(entry) !== target);
}

function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function defaultRollDie(sides) {
  return Math.ceil(Math.random() * Number(sides || 20));
}

module.exports = {
  applyWeaponMasteryOnHit,
  applyWeaponMasteryOnMiss,
  consumeSapAfterAttack,
  consumeVexAdvantage,
  expireMasteryEffects,
  getSelectedWeaponMastery,
  getWeaponDamageFormula,
  getWeaponMasteryAdvantageSources,
  getWeaponPropertyAttackMode,
  getWeaponPropertyAttackSources,
};
