process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getContentBundle } = require('../src/contentData');
const {
  getKnownSpellInfo,
  resolveSpellCastLegality,
  spendSpellResource,
} = require('../src/spellcastingEngine');

const content = getContentBundle();

function spell(id) {
  return content.spells.find((item) => item.id === id);
}

function wizardSheet(overrides = {}) {
  return {
    identity: { name: 'Mira', level: 1, class: 'wizard', class_name: 'Wizard' },
    spellcasting: {
      ability: 'int',
      cantrips_known: ['fire_bolt'],
      spellbook_spells: ['magic_missile', 'shield', 'detect_magic', 'identify', 'mage_armor', 'sleep'],
      spells_prepared: ['magic_missile', 'shield', 'detect_magic', 'sleep'],
      slots: { 1: 2 },
    },
    ...overrides,
  };
}

test('prepared class spells spend slots while cantrips do not', () => {
  const prepared = resolveSpellCastLegality({
    message: 'I cast Magic Missile at the skeleton.',
    content,
    characterSheet: wizardSheet(),
    worldState: {},
  });
  const cantrip = resolveSpellCastLegality({
    message: 'I cast Fire Bolt at the skeleton.',
    content,
    characterSheet: wizardSheet(),
    worldState: {},
  });

  assert.equal(prepared.blocked, false);
  assert.equal(prepared.characterSheet.spellcasting.slots[1], 1);
  assert.equal(cantrip.blocked, false);
  assert.equal(cantrip.characterSheet.spellcasting.slots[1], 2);
});

test('wizard spellbook spells are blocked when not prepared unless castable as rituals', () => {
  const mageArmor = resolveSpellCastLegality({
    message: 'I cast Mage Armor.',
    content,
    characterSheet: wizardSheet(),
    worldState: {},
  });
  const identify = resolveSpellCastLegality({
    message: 'I cast Identify as a ritual.',
    content,
    characterSheet: wizardSheet(),
    worldState: {},
  });

  assert.equal(mageArmor.blocked, true);
  assert.match(mageArmor.reply, /not prepared/);
  assert.equal(identify.blocked, false);
  assert.equal(identify.resourceNote, 'ritual/no slot');
  assert.equal(identify.characterSheet.spellcasting.slots[1], 2);
});

test('always-prepared class spells use slots unless a limited class feature use exists', () => {
  const druid = {
    identity: { name: 'Fern', level: 1, class: 'druid', class_name: 'Druid' },
    spellcasting: {
      ability: 'wis',
      cantrips_known: [],
      always_prepared_spells: ['speak_with_animals'],
      spells_prepared: ['cure_wounds', 'speak_with_animals'],
      slots: { 1: 2 },
    },
  };
  const ranger = {
    identity: { name: 'Bryn', level: 1, class: 'ranger', class_name: 'Ranger' },
    spellcasting: {
      ability: 'wis',
      always_prepared_spells: ['hunter_mark'],
      spells_prepared: ['hunter_mark'],
      slots: { 1: 2 },
    },
    resources: {
      spell_uses: {
        'class_feature:favored_enemy:hunter_mark': {
          name: "Hunter's Mark",
          spell_id: 'hunter_mark',
          source: 'favored_enemy',
          source_name: 'Favored Enemy',
          remaining: 2,
          max: 2,
          reset: 'long_rest',
        },
      },
    },
  };

  const druidKnown = getKnownSpellInfo(druid, spell('speak_with_animals'));
  const rangerKnown = getKnownSpellInfo(ranger, spell('hunter_mark'));
  const druidSpent = spendSpellResource(druid, spell('speak_with_animals'), druidKnown);
  const rangerSpent = spendSpellResource(ranger, spell('hunter_mark'), rangerKnown);

  assert.equal(druidSpent.note, 'spent level 1 spell slot');
  assert.equal(druidSpent.characterSheet.spellcasting.slots[1], 1);
  assert.equal(rangerSpent.note, 'spent Favored Enemy');
  assert.equal(rangerSpent.characterSheet.spellcasting.slots[1], 2);
  assert.equal(rangerSpent.characterSheet.resources.spell_uses['class_feature:favored_enemy:hunter_mark'].remaining, 1);
});

test('reaction spells and long casting times are blocked before resources are spent', () => {
  const reaction = resolveSpellCastLegality({
    message: 'I cast Shield.',
    content,
    characterSheet: wizardSheet(),
    worldState: { combat_state: { active: true, combatants: [{ is_player: true }, { is_player: false, hp: 5 }] } },
  });
  const longCast = resolveSpellCastLegality({
    message: 'I cast Identify as a ritual.',
    content,
    characterSheet: wizardSheet(),
    worldState: { combat_state: { active: true, combatants: [{ is_player: true }, { is_player: false, hp: 5 }] } },
  });

  assert.equal(reaction.blocked, true);
  assert.match(reaction.reply, /Reaction spell/);
  assert.equal(longCast.blocked, true);
  assert.match(longCast.reply, /not a single combat action/);
});
