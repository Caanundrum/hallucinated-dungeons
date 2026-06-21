process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatRulesEquipmentEffects,
  summarizeCharacterSheetForRules,
} = require('../src/rulesSheetSummary');

test('DM2 sheet summary lists exact AC sources including Defense style', () => {
  const summary = summarizeCharacterSheetForRules({
    identity: {
      name: 'Ser Brightly',
      species_name: 'Human',
      class_name: 'Fighter',
      level: 1,
      experience_points: 125,
      next_level_xp: 300,
    },
    derived_stats: {
      hp: 12,
      max_hp: 12,
      armor_class: 19,
      speed: 30,
      initiative: 0,
      proficiency_bonus: 2,
      armor_class_breakdown: [
        { label: 'Chain Mail', value: 16 },
        { label: 'DEX modifier (cap 0)', value: 0 },
        { label: 'Shield', value: 2 },
        { label: 'Defense Fighting Style', value: 1 },
      ],
    },
  });

  assert.match(summary, /AC sources: Chain Mail: 16/);
  assert.match(summary, /Progression: XP 125\/300/);
  assert.match(summary, /Shield: \+2/);
  assert.match(summary, /Fighting Style: Defense \+1 while wearing armor/);
  assert.match(summary, /Total AC 19/);
});

test('equipment rule summary does not expose raw armor formula tokens', () => {
  const summary = formatRulesEquipmentEffects([
    {
      id: 'equipment_chain_mail',
      name: 'Chain Mail',
      source_type: 'equipment',
      rules_effects: [{ target: 'armor_formula', base: 16, dex_cap: 0, label: 'Chain Mail' }],
    },
    {
      id: 'equipment_shield',
      name: 'Shield',
      source_type: 'equipment',
      rules_effects: [{ target: 'shield_bonus', value: 2, label: 'Shield' }],
    },
  ]);

  assert.match(summary, /Chain Mail: base AC 16, Dex cap 0/);
  assert.match(summary, /Shield: AC \+2/);
  assert.doesNotMatch(summary, /armor_formula/);
});

test('DM2 sheet summary exposes the selected Pact of the Blade weapon', () => {
  const summary = summarizeCharacterSheetForRules({
    identity: { name: 'Vex', class: 'warlock', class_name: 'Warlock', level: 2 },
    derived_stats: {},
    class_choice_details: { pact_of_the_blade: { pact_weapon: 'longsword' } },
  });

  assert.match(summary, /Pact weapon: longsword/);
  assert.match(summary, /uses Charisma for attack and damage/);
});

test('DM2 sheet summary distinguishes a Wizard spellbook from prepared spells', () => {
  const summary = summarizeCharacterSheetForRules({
    identity: { name: 'Mira', class: 'wizard', class_name: 'Wizard', level: 2 },
    derived_stats: { spell_attack_bonus: 5, spell_save_dc: 13 },
    spellcasting: {
      ability: 'int',
      slots: { 1: 3 },
      spellbook_spells: ['magic_missile', 'shield', 'identify'],
      spells_prepared: ['magic_missile', 'shield'],
    },
  });

  assert.match(summary, /Spellbook: magic_missile, shield, identify/);
  assert.match(summary, /Prepared from spellbook: magic_missile, shield/);
});
