const { getContentBundle } = require('./contentData');
const { assertValidRulesEffects } = require('./refereeContracts');
const { applyActiveEffectsToWorldState } = require('./spellEffectEngine');

function buildEquipmentActiveEffects(characterSheet = {}, content = getContentBundle()) {
  const equipment = content.equipment || [];
  const equipped = characterSheet.equipped || {};
  const attuned = new Set((equipped.attuned || []).map(normalizeId).filter(Boolean));
  const itemIds = [
    equipped.main_hand,
    equipped.off_hand,
    equipped.armor,
    ...(equipped.attuned || []),
  ].map(normalizeId).filter(Boolean);
  const uniqueIds = [...new Set(itemIds)];

  return uniqueIds
    .map((id) => equipment.find((item) => normalizeId(item.id) === id))
    .filter((item) => item && Array.isArray(item.effects) && item.effects.length > 0)
    .filter((item) => !item.requires_attunement || attuned.has(normalizeId(item.id)))
    .map((item) => buildEquipmentEffect(item));
}

function syncEquipmentEffectsToWorldState(worldState = {}, characterSheet = {}, content = getContentBundle()) {
  const equipmentEffects = buildEquipmentActiveEffects(characterSheet, content);
  const retainedEffects = (Array.isArray(worldState.active_effects) ? worldState.active_effects : [])
    .filter((effect) => !isEquipmentEffect(effect));
  const nextEffects = [...retainedEffects, ...equipmentEffects];
  return applyActiveEffectsToWorldState(
    {
      ...worldState,
      active_effects: nextEffects,
    },
    nextEffects,
    characterSheet,
  );
}

function isEquipmentEffect(effect = {}) {
  return effect.source_type === 'equipment'
    || String(effect.id || '').startsWith('equipment_');
}

function buildEquipmentEffect(item = {}) {
  const rulesEffects = (item.effects || []).map((effect) => ({
    ...effect,
    label: effect.label || item.name,
    source_item_id: item.id,
    source_item_name: item.name,
  }));
  assertValidRulesEffects(rulesEffects, `equipment effects for ${item.id || item.name}`);
  return {
    id: `equipment_${item.id}`,
    name: item.name,
    source_type: 'equipment',
    source_item_id: item.id,
    source_item_name: item.name,
    permanent: true,
    requires_attunement: Boolean(item.requires_attunement),
    rules_effects: rulesEffects,
  };
}

function normalizeId(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

module.exports = {
  buildEquipmentActiveEffects,
  syncEquipmentEffectsToWorldState,
  isEquipmentEffect,
};
