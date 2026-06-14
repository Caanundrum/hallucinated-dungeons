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

test('syncing new character equipment ignores stale armor baselines from a prior sheet', () => {
  const synced = syncEquipmentEffectsToWorldState({
    player_stats: {
      armor_class: 19,
      base_armor_class: 19,
      natural_base_armor_class: 19,
      defense_fighting_style_applied: true,
    },
    active_effects: [
      { id: 'equipment_chain_mail', name: 'Chain Mail', source_type: 'equipment', rules_effects: [{ target: 'armor_formula', base: 16, dex_cap: 0, label: 'Chain Mail' }] },
      { id: 'equipment_shield', name: 'Shield', source_type: 'equipment', rules_effects: [{ target: 'shield_bonus', value: 2, label: 'Shield' }] },
    ],
    combat_state: {
      active: true,
      combatants: [
        { name: 'QA Rogue', hp: 17, max_hp: 17, ac: 19, is_player: true },
        { name: 'Hostile Shape', hp: 8, max_hp: 8, ac: 12, is_player: false },
      ],
    },
  }, {
    identity: { name: 'QA Rogue', class: 'rogue', class_name: 'Rogue', level: 2 },
    abilities: { modifiers: { dex: 3 } },
    equipped: { armor: 'leather_armor', off_hand: null },
    derived_stats: {
      armor_class: 14,
      base_armor_class: 14,
      natural_base_armor_class: 14,
    },
  });

  assert.equal(synced.player_stats.armor_class, 14);
  assert.equal(synced.player_stats.base_armor_class, 14);
  assert.equal(synced.player_stats.natural_base_armor_class, 14);
  assert.equal(synced.combat_state.combatants.find((entry) => entry.is_player).ac, 14);
  assert.deepEqual(synced.active_effects.map((effect) => effect.id), ['equipment_leather_armor']);
});

test('current armor formula repairs stale derived armor on the active sheet', () => {
  const leatherEffect = buildEquipmentActiveEffects({
    equipped: { armor: 'leather_armor' },
  });
  const sheet = applyActiveEffectsToCharacterSheet({
    identity: { name: 'QA Rogue', class: 'rogue', class_name: 'Rogue', level: 2 },
    abilities: { modifiers: { dex: 3 } },
    equipped: { armor: 'leather_armor' },
    derived_stats: {
      armor_class: 19,
      base_armor_class: 19,
      natural_base_armor_class: 19,
      armor_class_breakdown: [
        { label: 'Leather Armor', value: 11 },
        { label: 'DEX modifier', value: 3 },
      ],
      active_spell_effects: [],
    },
  }, leatherEffect);

  assert.equal(sheet.derived_stats.armor_class, 14);
  assert.equal(sheet.derived_stats.base_armor_class, 14);
  assert.equal(sheet.derived_stats.natural_base_armor_class, 14);
  assert.deepEqual(sheet.derived_stats.armor_class_breakdown, [
    { label: 'Leather Armor', value: 11 },
    { label: 'DEX modifier', value: 3 },
  ]);
});

test('current armor formula preserves shield and Defense style bonuses', () => {
  const effects = buildEquipmentActiveEffects({
    equipped: { armor: 'chain_mail', off_hand: 'shield' },
  });
  const sheet = applyActiveEffectsToCharacterSheet({
    identity: { name: 'QA Fighter', class: 'fighter', class_name: 'Fighter', level: 2 },
    abilities: { modifiers: { dex: 3 } },
    class_choices: { fighting_style: 'defense' },
    equipped: { armor: 'chain_mail', off_hand: 'shield' },
    derived_stats: {
      armor_class: 19,
      base_armor_class: 19,
      natural_base_armor_class: 19,
      armor_class_breakdown: [
        { label: 'Chain Mail', value: 16 },
        { label: 'Shield', value: 2 },
        { label: 'Defense Fighting Style', value: 1 },
      ],
      active_spell_effects: [],
    },
  }, effects);

  assert.equal(sheet.derived_stats.armor_class, 19);
  assert.equal(sheet.derived_stats.base_armor_class, 19);
  assert.equal(sheet.derived_stats.natural_base_armor_class, 19);
  assert.deepEqual(sheet.derived_stats.armor_class_breakdown, [
    { label: 'Chain Mail', value: 16 },
    { label: 'DEX modifier (cap 0)', value: 0 },
    { label: 'Shield', value: 2 },
    { label: 'Defense Fighting Style', value: 1 },
  ]);
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
