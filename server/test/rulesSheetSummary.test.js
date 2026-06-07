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
