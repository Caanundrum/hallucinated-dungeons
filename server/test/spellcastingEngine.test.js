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
  summarizeKnownSpells,
} = require('../src/spellcastingEngine');
const { resolveSpellCast } = require('../src/spellEffectEngine');

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

test('Quickened Spell spends Sorcery Points and changes an Action spell to a Bonus Action', () => {
  const result = resolveSpellCastLegality({
    message: 'I cast Magic Missile at the skeleton with Quickened Spell.',
    content,
    characterSheet: {
      identity: { name: 'Mira', level: 2, class: 'sorcerer', class_name: 'Sorcerer' },
      class_choices: { metamagic: ['quickened_spell', 'transmuted_spell'] },
      resources: { sorcery_points: { name: 'Sorcery Points', remaining: 2, max: 2, reset: 'long_rest' } },
      spellcasting: { ability: 'cha', cantrips_known: [], spells_prepared: ['magic_missile'], slots: { 1: 3 } },
    },
    worldState: {},
  });

  assert.equal(result.blocked, false);
  assert.equal(result.spell.casting_time, 'Bonus Action');
  assert.equal(result.characterSheet.resources.sorcery_points.remaining, 0);
  assert.equal(result.characterSheet.spellcasting.slots[1], 2);
});

test('Quickened Spell persists authoritative Sorcery Points into both sheet and world state', () => {
  const result = resolveSpellCast({
    message: 'I cast Mage Armor with Quickened Spell.',
    content,
    characterSheet: {
      identity: { name: 'Mira', level: 2, class: 'sorcerer', class_name: 'Sorcerer' },
      abilities: { modifiers: { dex: 2, cha: 3 } },
      class_choices: { metamagic: ['quickened_spell', 'transmuted_spell'] },
      resources: { sorcery_points: { name: 'Sorcery Points', remaining: 2, max: 2, reset: 'long_rest' } },
      derived_stats: { armor_class: 12 },
      spellcasting: { ability: 'cha', cantrips_known: [], spells_prepared: ['mage_armor'], slots: { 1: 3 } },
    },
    worldState: {
      player_stats: {
        armor_class: 12,
        resources: { sorcery_points: { name: 'Sorcery Points', remaining: 2, max: 2, reset: 'long_rest' } },
      },
    },
  });

  assert.equal(result.blocked, false);
  assert.equal(result.characterSheet.resources.sorcery_points.remaining, 0);
  assert.equal(result.worldState.player_stats.resources.sorcery_points.remaining, 0);
  assert.equal(result.characterSheet.spellcasting.slots[1], 2);
});

test('unselected or invalid Metamagic spends no spell slot or Sorcery Points', () => {
  const sheet = {
    identity: { name: 'Mira', level: 2, class: 'sorcerer', class_name: 'Sorcerer' },
    class_choices: { metamagic: ['distant_spell', 'subtle_spell'] },
    resources: { sorcery_points: { name: 'Sorcery Points', remaining: 2, max: 2, reset: 'long_rest' } },
    spellcasting: { ability: 'cha', cantrips_known: [], spells_prepared: ['magic_missile'], slots: { 1: 3 } },
  };
  const result = resolveSpellCastLegality({
    message: 'I cast Magic Missile at the skeleton with Quickened Spell.',
    content,
    characterSheet: sheet,
    worldState: {},
  });

  assert.equal(result.blocked, true);
  assert.equal(sheet.resources.sorcery_points.remaining, 2);
  assert.equal(sheet.spellcasting.slots[1], 3);
});

test('a second spell-slot cast on the same combat turn is blocked while cantrips remain legal', () => {
  const characterSheet = {
    identity: { name: 'Mira', level: 2, class: 'sorcerer', class_name: 'Sorcerer' },
    spellcasting: {
      ability: 'cha',
      cantrips_known: ['fire_bolt'],
      spells_prepared: ['magic_missile'],
      slots: { 1: 2 },
    },
  };
  const worldState = {
    combat_state: { active: true, turn_resources: { spell_slot_spent: true } },
  };
  const slotted = resolveSpellCastLegality({ message: 'I cast Magic Missile at the skeleton.', content, characterSheet, worldState });
  const cantrip = resolveSpellCastLegality({ message: 'I cast Fire Bolt at the skeleton.', content, characterSheet, worldState });

  assert.equal(slotted.blocked, true);
  assert.match(slotted.reply, /already expended a spell slot/);
  assert.equal(cantrip.blocked, false);
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

test('Paladin Divine Smite is listed but direct casting redirects to the on-hit referee', () => {
  const paladin = {
    identity: { name: 'Ari', level: 2, class: 'paladin', class_name: 'Paladin' },
    spellcasting: {
      ability: 'cha',
      always_prepared_spells: ['divine_smite'],
      spells_prepared: ['bless', 'shield_of_faith'],
      slots: { 1: 2 },
    },
    resources: {
      paladins_smite: { name: "Paladin's Smite", remaining: 1, max: 1, reset: 'long_rest' },
    },
  };
  const result = resolveSpellCastLegality({
    message: 'I cast Divine Smite.',
    content,
    characterSheet: paladin,
    worldState: {},
  });

  assert.match(summarizeKnownSpells(paladin, content), /Divine Smite/);
  assert.equal(result.blocked, true);
  assert.match(result.reply, /immediately after a melee weapon hit/);
  assert.equal(paladin.resources.paladins_smite.remaining, 1);
  assert.equal(paladin.spellcasting.slots[1], 2);
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
