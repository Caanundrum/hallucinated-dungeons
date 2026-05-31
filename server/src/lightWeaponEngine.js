const { getContentBundle } = require('./contentData');
const { getFightingStyle } = require('./fightingStyleEngine');
const { getSelectedWeaponMastery } = require('./weaponRulesEngine');

function getLightExtraAttack({
  characterSheet = {},
  primaryAttack = {},
  message = '',
  content = getContentBundle(),
} = {}) {
  if (!hasProperty(primaryAttack, 'light')) return null;

  const primaryWeaponId = normalizeId(primaryAttack.weaponId);
  const weapon = getEquippedWeapons(characterSheet, content)
    .find((item) => normalizeId(item.id) !== primaryWeaponId && hasProperty(item, 'light'));
  if (!weapon || (!wantsLightExtraAttack(message) && !mentionsBothWeapons(message, primaryAttack, weapon))) return null;

  const attack = buildLightExtraAttack({ characterSheet, weapon });
  const mastery = getSelectedWeaponMastery(characterSheet, attack);
  return {
    attack,
    mastery,
    usesBonusAction: mastery !== 'nick',
    twoWeaponFighting: getFightingStyle(characterSheet) === 'two_weapon_fighting',
  };
}

function buildLightExtraAttack({ characterSheet = {}, weapon = {} } = {}) {
  const breakdown = (characterSheet.derived_stats?.attack_breakdowns || [])
    .find((entry) => normalizeId(entry.weapon_id || entry.weaponId) === normalizeId(weapon.id));
  const ability = breakdown?.ability || getWeaponAttackAbility(weapon, characterSheet);
  const modifier = Number(characterSheet.abilities?.modifiers?.[ability] || 0);
  const proficiency = Number(characterSheet.derived_stats?.proficiency_bonus || 2);
  const includeAbilityModifier = modifier < 0 || getFightingStyle(characterSheet) === 'two_weapon_fighting';
  const damageFormula = stripPositiveAbilityModifier(
    breakdown?.damage_formula || `${weapon.damage} + ${modifier}`,
    modifier,
    includeAbilityModifier,
  );

  return {
    name: weapon.name || breakdown?.name || 'Light weapon',
    weaponId: weapon.id,
    ability,
    properties: weapon.properties || breakdown?.properties || [],
    weaponCategory: weapon.weapon_category || breakdown?.weapon_category || null,
    attackKind: weapon.attack_kind || breakdown?.attack_kind || 'melee',
    attackBonus: Number(breakdown?.attack_total ?? modifier + proficiency),
    fightingStyleAttackBonus: Number(breakdown?.fighting_style_attack_bonus || 0),
    damageFormula,
    damageType: weapon.damage_type || breakdown?.damage_type || null,
    mastery: weapon.mastery || breakdown?.mastery || null,
    versatileDamage: weapon.versatile_damage || breakdown?.versatile_damage || null,
    isWeapon: true,
    isLightExtraAttack: true,
    includesLightAttackAbilityModifier: includeAbilityModifier,
  };
}

function wantsLightExtraAttack(message = '') {
  return /\b(?:both weapons|both of my weapons|two[- ]weapon|dual[- ]wield|off[- ]hand|follow[- ]?up|extra attack|attack with (?:my )?[^,.]+ and (?:my )?[^,.]+)\b/i
    .test(String(message || ''));
}

function mentionsBothWeapons(message = '', primaryAttack = {}, extraWeapon = {}) {
  const text = normalizePhrase(message);
  return [primaryAttack.name, primaryAttack.weaponId].filter(Boolean).some((value) => text.includes(normalizePhrase(value)))
    && [extraWeapon.name, extraWeapon.id].filter(Boolean).some((value) => text.includes(normalizePhrase(value)));
}

function getEquippedWeapons(characterSheet = {}, content = getContentBundle()) {
  return [...new Set([characterSheet.equipped?.main_hand, characterSheet.equipped?.off_hand].filter(Boolean))]
    .map((weaponId) => content.equipment.find((item) => normalizeId(item.id) === normalizeId(weaponId)))
    .filter((item) => item?.type === 'weapon');
}

function getWeaponAttackAbility(weapon = {}, characterSheet = {}) {
  const modifiers = characterSheet.abilities?.modifiers || {};
  if ((weapon.properties || []).includes('finesse')) {
    return Number(modifiers.dex || 0) > Number(modifiers.str || 0) ? 'dex' : 'str';
  }
  return weapon.ability || 'str';
}

function stripPositiveAbilityModifier(formula, modifier, includeAbilityModifier) {
  if (includeAbilityModifier || modifier <= 0) return String(formula || '');
  const match = String(formula || '').match(/^(.*?)(?:\s*\+\s*)(\d+)\s*$/);
  if (!match) return String(formula || '');
  const adjusted = Number(match[2]) - modifier;
  return adjusted ? `${match[1].trim()} + ${adjusted}` : match[1].trim();
}

function hasProperty(item = {}, property) {
  return (item.properties || []).map(normalizeId).includes(normalizeId(property));
}

function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizePhrase(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

module.exports = {
  buildLightExtraAttack,
  getEquippedWeapons,
  getLightExtraAttack,
  stripPositiveAbilityModifier,
  wantsLightExtraAttack,
};
