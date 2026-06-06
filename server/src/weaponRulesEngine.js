const { resolveSavingThrow } = require('./conditionEngine');
const {
  getCombatantDistanceFeet,
  getWeaponReach,
  pushCombatantAway,
} = require('./combatPositionEngine');
const { rollDie } = require('./dice');

const LARGE_OR_SMALLER = new Set(['tiny', 'small', 'medium', 'large']);
const INCAPACITATING_CONDITIONS = new Set(['incapacitated', 'paralyzed', 'petrified', 'stunned', 'unconscious', 'sleep']);

function prepareWeaponAttack({
  attack = {},
  message = '',
  characterSheet = {},
  player = {},
  target = {},
} = {}) {
  const prepared = normalizeThrownAttack(attack, message);
  if (hasProperty(prepared, 'two-handed') && characterSheet.equipped?.off_hand && !canUseLanceOneHanded(prepared, player)) {
    return blocked(`${prepared.name} requires two hands when you attack with it. Your off hand is occupied, so choose another attack or free that hand first.`);
  }

  const distance = getCombatantDistanceFeet(player, target);
  if (distance === null) return { ok: true, attack: prepared, spatialMode: 'scene_zone_assumption' };
  if (!Number.isFinite(distance)) {
    return blocked(`${target.name || 'That target'} is on a different map or encounter layer.`);
  }
  if (prepared.attackKind === 'melee' && distance > getWeaponReach(prepared)) {
    return blocked(`${target.name || 'That target'} is ${distance} feet away, beyond ${prepared.name}'s ${getWeaponReach(prepared)}-foot melee reach.`);
  }
  if (prepared.attackKind === 'ranged' && Number(prepared.range?.long || 0) > 0 && distance > Number(prepared.range.long)) {
    return blocked(`${target.name || 'That target'} is ${distance} feet away, beyond ${prepared.name}'s ${prepared.range.long}-foot long range.`);
  }
  return { ok: true, attack: prepared, spatialMode: 'hex', distance };
}

function getWeaponPropertyAttackMode({ attack = {}, characterSheet = {}, player = {}, target = {}, combat = {} } = {}) {
  return getWeaponPropertyAttackSources({ attack, characterSheet, player, target, combat }).length
    ? 'disadvantage'
    : null;
}

function getWeaponPropertyAttackSources({ attack = {}, characterSheet = {}, player = {}, target = {}, combat = {} } = {}) {
  const sources = [];
  if (hasProperty(attack, 'heavy')) {
    const ability = attack.attackKind === 'ranged' ? 'dex' : 'str';
    if (getAbilityScore(characterSheet, ability) < 13) sources.push('Heavy weapon minimum ability score');
  }
  const distance = getCombatantDistanceFeet(player, target);
  if (attack.attackKind === 'ranged' && Number.isFinite(distance) && Number(attack.range?.normal || 0) > 0 && distance > Number(attack.range.normal)) {
    sources.push('Long range');
  }
  if (hasCloseCombatThreat({ attack, player, target, combat })) {
    sources.push('Ranged attack in close combat');
  }
  return sources;
}

function getWeaponDamageFormula({ attack = {}, message = '', characterSheet = {} } = {}) {
  if (!attack.isWeapon || !hasProperty(attack, 'versatile') || !wantsTwoHandedUse(message) || characterSheet.equipped?.off_hand) {
    return attack.damageFormula;
  }
  return replaceDamageDice(attack.damageFormula, attack.versatileDamage);
}

function stripPositiveAbilityModifier(formula, modifier, includeAbilityModifier = false) {
  if (includeAbilityModifier || Number(modifier || 0) <= 0) return String(formula || '');
  const match = String(formula || '').match(/^(.*?)(?:\s*\+\s*)(\d+)\s*$/);
  if (!match) return String(formula || '');
  const adjusted = Number(match[2]) - Number(modifier);
  if (adjusted > 0) return `${match[1].trim()} + ${adjusted}`;
  if (adjusted < 0) return `${match[1].trim()} - ${Math.abs(adjusted)}`;
  return match[1].trim();
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
    const movement = pushCombatantAway({
      source: (combat.combatants || []).find((combatant) => combatant.is_player),
      target,
      feet: 10,
    });
    const qualifier = movement.mode === 'hex'
      ? '.'
      : ', subject to available space in the scene.';
    return { lines: [`**Push mastery:** ${target.name} is pushed ${movement.feet} feet straight away${qualifier}`], mastery };
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
    target.speed_penalty = getAncestrySpeedPenalty(target) + 10;
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

function normalizeThrownAttack(attack = {}, message = '') {
  if (!hasProperty(attack, 'thrown') || attack.attackKind === 'ranged' || !wantsThrownUse(message)) return attack;
  return {
    ...attack,
    attackKind: 'ranged',
    isThrownAttack: true,
  };
}

function canUseLanceOneHanded(attack = {}, player = {}) {
  return attack.weaponId === 'lance' && Boolean(player.mounted);
}

function wantsThrownUse(message = '') {
  return /\b(?:throw(?:s|ing)?|thrown|hurl(?:s|ing)?|toss(?:es|ing)?|fling(?:s|ing)?)\b/i.test(String(message || ''));
}

function hasCloseCombatThreat({ attack = {}, player = {}, target = {}, combat = {} } = {}) {
  if (attack.attackKind !== 'ranged') return false;
  const enemies = Array.isArray(combat.combatants) && combat.combatants.length
    ? combat.combatants.filter((combatant) => !combatant.is_player)
    : [target];
  return enemies.some((enemy) => {
    const distance = getCombatantDistanceFeet(player, enemy);
    return Number(enemy.hp || 0) > 0
      && enemy.can_see_player !== false
      && !(enemy.conditions || []).some((condition) => INCAPACITATING_CONDITIONS.has(normalizeId(condition)))
      && Number.isFinite(distance)
      && distance <= 5;
  });
}

function blocked(reply) {
  return { ok: false, reply };
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
    next.speed_penalty = getAncestrySpeedPenalty(next);
  }
  return next;
}

function getMasteryEffects(target = {}) {
  return Array.isArray(target.mastery_effects) ? target.mastery_effects : [];
}

function getAncestrySpeedPenalty(target = {}) {
  return (target.ancestry_effects || [])
    .reduce((total, effect) => total + Number(effect.speed_penalty || 0), 0);
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
  return rollDie(sides);
}

module.exports = {
  applyWeaponMasteryOnHit,
  applyWeaponMasteryOnMiss,
  consumeSapAfterAttack,
  consumeVexAdvantage,
  expireMasteryEffects,
  getSelectedWeaponMastery,
  prepareWeaponAttack,
  getWeaponDamageFormula,
  getWeaponMasteryAdvantageSources,
  getWeaponPropertyAttackMode,
  getWeaponPropertyAttackSources,
  stripPositiveAbilityModifier,
};
