process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getContentBundle } = require('../src/contentData');
const {
  resolveSpellCast,
  tickActiveEffects,
} = require('../src/spellEffectEngine');

const content = getContentBundle();

function paladinSheet(overrides = {}) {
  const base = {
    identity: { name: 'Ari', level: 1, class: 'paladin', class_name: 'Paladin' },
    derived_stats: {
      armor_class: 18,
      armor_class_breakdown: [
        { label: 'Chain Mail', value: 16 },
        { label: 'Shield', value: 2 },
      ],
      active_spell_effects: [],
      ...overrides.derived_stats,
    },
    spellcasting: {
      ability: 'cha',
      cantrips_known: [],
      spells_prepared: ['bless', 'shield_of_faith'],
      slots: { 1: 2 },
    },
  };
  return {
    ...base,
    ...overrides,
    derived_stats: {
      ...base.derived_stats,
      ...(overrides.derived_stats || {}),
    },
    spellcasting: {
      ...base.spellcasting,
      ...(overrides.spellcasting || {}),
    },
  };
}

function worldState(overrides = {}) {
  return {
    player_stats: {
      armor_class: 18,
      base_armor_class: 18,
      spell_slots: { 1: 2 },
    },
    active_effects: [],
    time_state: { elapsed_rounds: 0, elapsed_minutes: 0, scene_time: '' },
    ...overrides,
  };
}

test('casts Shield of Faith by spending a slot and applying the AC effect', () => {
  const result = resolveSpellCast({
    message: 'I cast Shield of Faith on myself.',
    content,
    characterSheet: paladinSheet(),
    worldState: worldState(),
  });

  assert.equal(result.blocked, false);
  assert.equal(result.characterSheet.spellcasting.slots[1], 1);
  assert.equal(result.characterSheet.derived_stats.armor_class, 20);
  assert.equal(result.worldState.player_stats.armor_class, 20);
  assert.equal(result.worldState.active_effects[0].id, 'shield_of_faith');
  assert.equal(result.worldState.active_effects[0].remaining_rounds, 100);
  assert.equal(result.worldState.active_effects[0].concentration, true);
});

test('new concentration spell replaces prior concentration and removes its AC bonus', () => {
  const shield = resolveSpellCast({
    message: 'I cast Shield of Faith.',
    content,
    characterSheet: paladinSheet(),
    worldState: worldState(),
  });
  const bless = resolveSpellCast({
    message: 'I cast Bless.',
    content,
    characterSheet: shield.characterSheet,
    worldState: shield.worldState,
  });

  assert.equal(bless.characterSheet.spellcasting.slots[1], 0);
  assert.deepEqual(bless.worldState.active_effects.map((effect) => effect.id), ['bless']);
  assert.equal(bless.characterSheet.derived_stats.armor_class, 18);
  assert.equal(bless.worldState.player_stats.armor_class, 18);
});

test('blocks class spell when no matching slot remains', () => {
  const result = resolveSpellCast({
    message: 'I cast Bless.',
    content,
    characterSheet: paladinSheet({ spellcasting: { slots: { 1: 0 } } }),
    worldState: worldState({ player_stats: { armor_class: 18, base_armor_class: 18, spell_slots: { 1: 0 } } }),
  });

  assert.equal(result.blocked, true);
  assert.match(result.reply, /do not have a level 1 spell slot left/);
});

test('ticking active effects expires Shield of Faith and restores base AC', () => {
  const shield = resolveSpellCast({
    message: 'I cast Shield of Faith.',
    content,
    characterSheet: paladinSheet(),
    worldState: worldState(),
  });
  const ticked = tickActiveEffects(shield.worldState, { rounds: 100 });

  assert.deepEqual(ticked.expiredEffects.map((effect) => effect.id), ['shield_of_faith']);
  assert.deepEqual(ticked.worldState.active_effects, []);
  assert.equal(ticked.worldState.player_stats.armor_class, 18);
});
