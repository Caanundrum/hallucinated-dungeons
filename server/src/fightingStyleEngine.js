const { getCombatantDistanceFeet } = require('./combatPositionEngine');

function getFightingStyle(characterSheet = {}) {
  return normalizeId(characterSheet.class_choices?.fighting_style);
}

function getFightingStyleArmorBonus({ styleId, wearingArmor = false } = {}) {
  return normalizeId(styleId) === 'defense' && wearingArmor ? 1 : 0;
}

function getFightingStyleAttackBonus({ styleId, attack = {} } = {}) {
  return normalizeId(styleId) === 'archery' && attack.attackKind === 'ranged' ? 2 : 0;
}

function getRuntimeArmorClass({ characterSheet = {}, armorClass = null, defenseApplied = false } = {}) {
  const numericArmorClass = Number(armorClass ?? characterSheet.derived_stats?.armor_class ?? 10);
  const hasDefense = getFightingStyle(characterSheet) === 'defense';
  const wearingArmor = Boolean(characterSheet.equipped?.armor);
  const sheetIncludesDefense = (characterSheet.derived_stats?.armor_class_breakdown || [])
    .some((entry) => entry.label === 'Defense Fighting Style');
  const shouldAddLegacyBonus = hasDefense && wearingArmor && !sheetIncludesDefense && !defenseApplied;
  return {
    armorClass: numericArmorClass + (shouldAddLegacyBonus ? 1 : 0),
    defenseApplied: defenseApplied || sheetIncludesDefense || shouldAddLegacyBonus,
    addedLegacyBonus: shouldAddLegacyBonus,
  };
}

function getFightingStyleDamageBonus({ characterSheet = {}, attack = {}, message = '' } = {}) {
  const styleId = getFightingStyle(characterSheet);
  if (styleId === 'dueling' && isDuelingAttack({ characterSheet, attack, message })) {
    return { total: 2, label: 'Dueling' };
  }
  if (styleId === 'thrown_weapon_fighting' && isThrownAttack(attack, message)) {
    return { total: 2, label: 'Thrown Weapon Fighting' };
  }
  return { total: 0, label: null };
}

function getFightingStyleSenses(characterSheet = {}) {
  return getFightingStyle(characterSheet) === 'blind_fighting'
    ? [{ type: 'blindsight', range_feet: 10, source: 'Blind Fighting' }]
    : [];
}

function getBlindFightingAttackOptions({
  characterSheet = {},
  attack = {},
  attacker = {},
  target = {},
  spatialMode = null,
} = {}) {
  if (getFightingStyle(characterSheet) !== 'blind_fighting') return emptyAttackOptions();
  if (!isWithinBlindFightingRange({ attack, attacker, target, spatialMode })) return emptyAttackOptions();

  const attackerConditions = normalizeConditionSet(attacker.conditions);
  const targetConditions = normalizeConditionSet(target.conditions);
  const ignoreAttackerConditions = attackerConditions.has('blinded') ? ['blinded'] : [];
  const ignoreTargetConditions = ['hidden', 'invisible'].filter((condition) => targetConditions.has(condition));
  if (!ignoreAttackerConditions.length && !ignoreTargetConditions.length) return emptyAttackOptions();

  return {
    ignoreAttackerConditions,
    ignoreTargetConditions,
    sources: ['Blind Fighting'],
    note: 'Blind Fighting lets you treat that sight-blocking target within 10 feet as seen.',
  };
}

function applyFightingStyleToAttack({ characterSheet = {}, attack = {}, message = '' } = {}) {
  const styleId = getFightingStyle(characterSheet);
  const expectedAttackBonus = getFightingStyleAttackBonus({ styleId, attack });
  const includedAttackBonus = Number(attack.fightingStyleAttackBonus || 0);
  const bonusToApply = Math.max(0, expectedAttackBonus - includedAttackBonus);
  const greatWeaponFighting = styleId === 'great_weapon_fighting' && isHeldWithTwoHands(attack, message, characterSheet);
  return {
    ...attack,
    attackBonus: Number(attack.attackBonus || 0) + bonusToApply,
    minimumDamageDieRoll: greatWeaponFighting ? 3 : attack.minimumDamageDieRoll,
    fightingStyleAttackBonus: includedAttackBonus + bonusToApply,
  };
}

function buildUnarmedFightingAttack({ characterSheet = {}, proficiency = 0 } = {}) {
  if (getFightingStyle(characterSheet) !== 'unarmed_fighting') return null;
  const modifier = Number(characterSheet.abilities?.modifiers?.str || 0);
  return {
    name: 'Unarmed Strike',
    ability: 'str',
    attackBonus: modifier + Number(proficiency || 0),
    damageFormula: `1d6+${modifier}`,
    isWeapon: false,
    isUnarmed: true,
    properties: [],
    weaponCategory: null,
  };
}

function isDuelingAttack({ characterSheet = {}, attack = {}, message = '' } = {}) {
  if (!attack.isWeapon || attack.attackKind !== 'melee' || wantsTwoHandedUse(message)) return false;
  const offHand = normalizeId(characterSheet.equipped?.off_hand);
  return !offHand || offHand === 'shield';
}

function isThrownAttack(attack = {}, message = '') {
  if (!(attack.properties || []).includes('thrown')) return false;
  return attack.attackKind === 'ranged' || /\b(?:throw(?:s|ing)?|thrown|hurl(?:s|ing)?|toss(?:es|ing)?|fling(?:s|ing)?)\b/i.test(String(message || ''));
}

function isHeldWithTwoHands(attack = {}, message = '', characterSheet = {}) {
  const properties = attack.properties || [];
  if (attack.attackKind !== 'melee') return false;
  if (characterSheet.equipped?.off_hand) return false;
  if (properties.includes('two-handed')) return true;
  return properties.includes('versatile') && wantsTwoHandedUse(message);
}

function wantsTwoHandedUse(message = '') {
  return /\b(?:two[- ]handed|with (?:my |both )?hands|in both hands|using both hands)\b/i.test(String(message || ''));
}

function isWithinBlindFightingRange({ attack = {}, attacker = {}, target = {}, spatialMode = null } = {}) {
  const distance = getCombatantDistanceFeet(attacker, target);
  if (Number.isFinite(distance)) return distance <= 10;
  if (distance === Number.POSITIVE_INFINITY) return false;
  return spatialMode === 'scene_zone_assumption' && attack.attackKind === 'melee';
}

function emptyAttackOptions() {
  return {
    ignoreAttackerConditions: [],
    ignoreTargetConditions: [],
    sources: [],
    note: '',
  };
}

function normalizeConditionSet(conditions = []) {
  return new Set((conditions || []).map(normalizeId));
}

function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

module.exports = {
  applyFightingStyleToAttack,
  buildUnarmedFightingAttack,
  getBlindFightingAttackOptions,
  getFightingStyle,
  getFightingStyleArmorBonus,
  getFightingStyleAttackBonus,
  getFightingStyleDamageBonus,
  getFightingStyleSenses,
  getRuntimeArmorClass,
  isHeldWithTwoHands,
  isThrownAttack,
};
