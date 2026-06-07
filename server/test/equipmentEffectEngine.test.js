process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEquipmentActiveEffects,
  syncEquipmentEffectsToWorldState,
} = require('../src/equipmentEffectEngine');
const { applyActiveEffectsToCharacterSheet } = require('../src/spellEffectEngine');

test('builds passive effects for equipped and attuned items only', () => {
  const effects = buildEquipmentActiveEffects({
    equipped: {
      main_hand: 'longsword_plus_1',
      attuned: ['cloak_of_quiet_steps'],
    },
  });

  assert.deepEqual(effects.map((effect) => effect.source_item_id).sort(), ['cloak_of_quiet_steps', 'longsword_plus_1']);
  assert.equal(effects.find((effect) => effect.source_item_id === 'cloak_of_quiet_steps').rules_effects[0].target, 'skill_check_bonus');
  assert.equal(effects.find((effect) => effect.source_item_id === 'longsword_plus_1').rules_effects[0].target, 'weapon_attack_bonus');
});

test('skips attunement-required effects when the item is not attuned', () => {
  const effects = buildEquipmentActiveEffects({
    equipped: {
      main_hand: 'longsword_plus_1',
      off_hand: 'cloak_of_quiet_steps',
      attuned: [],
    },
  });

  assert.deepEqual(effects.map((effect) => effect.source_item_id), ['longsword_plus_1']);
});

test('syncs equipment effects while preserving non-equipment active effects', () => {
  const worldState = {
    player_stats: { armor_class: 14 },
    active_effects: [
      { id: 'bless', name: 'Bless', source_type: 'spell', rules_effects: [{ target: 'attack_roll_bonus_die', die: '1d4', label: 'Bless' }] },
      { id: 'wand_spark', name: 'Wand Spark', source_type: 'item', rules_effects: [{ target: 'spell_attack_bonus', value: 1, label: 'Wand Spark' }] },
      { id: 'equipment_old_boots', name: 'Old Boots', source_type: 'equipment', rules_effects: [{ target: 'skill_check_bonus', skill: 'stealth', value: 99 }] },
    ],
  };
  const synced = syncEquipmentEffectsToWorldState(worldState, {
    equipped: {
      main_hand: 'longsword_plus_1',
      attuned: ['cloak_of_quiet_steps'],
    },
  });

  assert.deepEqual(synced.active_effects.map((effect) => effect.id).sort(), [
    'bless',
    'equipment_cloak_of_quiet_steps',
    'equipment_longsword_plus_1',
    'wand_spark',
  ]);
  assert.equal(synced.active_effects.some((effect) => effect.id === 'equipment_old_boots'), false);
});

test('equipment effects do not populate active spell effects on character sheet', () => {
  const equipmentEffect = {
    id: 'equipment_shield',
    name: 'Shield',
    source_type: 'equipment',
    rules_effects: [{ target: 'shield_bonus', value: 2, label: 'Shield' }],
  };
  const spellEffect = {
    id: 'shield_of_faith',
    name: 'Shield of Faith',
    source_type: 'spell',
    rules_effects: [{ target: 'armor_class_bonus', value: 2, label: 'Shield of Faith' }],
  };
  const sheet = applyActiveEffectsToCharacterSheet({
    derived_stats: {
      armor_class: 18,
      armor_class_breakdown: [],
      active_spell_effects: [],
    },
  }, [equipmentEffect, spellEffect]);

  assert.deepEqual(sheet.derived_stats.active_spell_effects.map((effect) => effect.id), ['shield_of_faith']);
  assert.equal(sheet.derived_stats.armor_class, 20);
});
