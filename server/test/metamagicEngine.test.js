process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyMetamagicToCast } = require('../src/metamagicEngine');

function sorcerer(options, remaining = 2) {
  return {
    identity: { name: 'Mira', class: 'sorcerer', class_name: 'Sorcerer', level: 2 },
    abilities: { modifiers: { cha: 3 } },
    class_choices: { metamagic: options },
    resources: { sorcery_points: { name: 'Sorcery Points', remaining, max: 2, reset: 'long_rest' } },
  };
}

test('Distant Spell doubles numeric range and spends one Sorcery Point', () => {
  const result = applyMetamagicToCast({
    message: 'I cast Fire Bolt at the skeleton with Distant Spell.',
    spell: { id: 'fire_bolt', name: 'Fire Bolt', casting_time: 'Action', range: '120 ft', duration: 'Instant', attack_type: 'spell_attack' },
    characterSheet: sorcerer(['distant_spell', 'subtle_spell']),
  });

  assert.equal(result.ok, true);
  assert.equal(result.spell.range, '240 ft');
  assert.equal(result.characterSheet.resources.sorcery_points.remaining, 1);
});

test('Extended Spell doubles duration with a 24-hour cap', () => {
  const result = applyMetamagicToCast({
    message: 'I cast Hex with Extended Spell.',
    spell: { id: 'hex', name: 'Hex', casting_time: 'Bonus Action', range: '90 ft', duration: 'Concentration, up to 1 hour', attack_type: 'damage' },
    characterSheet: sorcerer(['extended_spell', 'subtle_spell']),
  });

  assert.equal(result.ok, true);
  assert.match(result.spell.duration, /2 hours/);
});

test('Transmuted Spell requires eligible damage and an explicit replacement type', () => {
  const sheet = sorcerer(['transmuted_spell', 'subtle_spell']);
  const valid = applyMetamagicToCast({
    message: 'I cast Fire Bolt at the skeleton with Transmuted Spell into cold damage.',
    spell: { id: 'fire_bolt', name: 'Fire Bolt', casting_time: 'Action', range: '120 ft', duration: 'Instant', attack_type: 'spell_attack' },
    characterSheet: sheet,
  });
  const invalid = applyMetamagicToCast({
    message: 'I cast Magic Missile with Transmuted Spell into cold damage.',
    spell: { id: 'magic_missile', name: 'Magic Missile', casting_time: 'Action', range: '120 ft', duration: 'Instant', attack_type: 'damage' },
    characterSheet: sheet,
  });

  assert.equal(valid.spell.metamagic.damage_type, 'cold');
  assert.equal(invalid.ok, false);
  assert.equal(sheet.resources.sorcery_points.remaining, 2);
});

test('unsupported map-dependent Metamagic blocks before spending resources', () => {
  const sheet = sorcerer(['careful_spell', 'twinned_spell']);
  const result = applyMetamagicToCast({
    message: 'I cast Thunderwave with Careful Spell.',
    spell: { id: 'thunderwave', name: 'Thunderwave', casting_time: 'Action', range: 'Self', duration: 'Instant', attack_type: 'save' },
    characterSheet: sheet,
  });

  assert.equal(result.ok, false);
  assert.match(result.reply, /multi-target/);
  assert.equal(sheet.resources.sorcery_points.remaining, 2);
});
