process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveFeatureAction } = require('../src/classFeatureEngine');
const { adjudicate } = require('../src/refereeCore');
const { resolveSpeciesFeatureAction } = require('../src/speciesFeatureEngine');
const {
  buildResolvedEventNarrativeFrame,
  createResolvedEventNarrationAction,
  shouldNarrateResolvedEvent,
} = require('../src/resolvedEventNarration');

const fighter = {
  identity: { name: 'Ari', class: 'fighter', level: 1 },
  abilities: { modifiers: { str: 3, dex: 1, con: 2, wis: 2, cha: 1 } },
  derived_stats: {
    hp: 12,
    max_hp: 12,
    armor_class: 16,
    proficiency_bonus: 2,
    skill_modifiers: { perception: { total: 4, ability: 'wis', proficient: true } },
    attack_breakdowns: [{ name: 'Longsword', attack_total: 5, damage_formula: '1d8+3' }],
  },
};

function combatWorld(overrides = {}) {
  return {
    current_location: 'Lantern Bridge',
    scene_presence: { exact_location: 'Lantern Bridge', present_npcs: ['Wolf'], present_objects: ['bridge rail'] },
    player_stats: { hp: 5, max_hp: 12, armor_class: 16 },
    active_effects: [],
    combat_state: {
      active: true,
      round: 1,
      turn_index: 0,
      combatants: [
        { name: 'Ari', hp: 5, max_hp: 12, ac: 16, is_player: true },
        { name: 'Wolf', hp: 20, max_hp: 20, ac: 12, is_player: false },
      ],
    },
    ...overrides,
  };
}

function sequenceRolls(values) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 10;
}

test('completed class, species, combat, and rest events all enter shared narration', () => {
  const secondWind = resolveFeatureAction({
    message: 'I use Second Wind.',
    worldState: combatWorld(),
    characterSheet: fighter,
    rollDie: sequenceRolls([6]),
  });
  const adrenalineRush = resolveSpeciesFeatureAction({
    message: 'I use Adrenaline Rush.',
    worldState: combatWorld(),
    characterSheet: {
      ...fighter,
      identity: { ...fighter.identity, species: 'orc' },
    },
  });
  const attack = adjudicate({
    message: 'I attack the Wolf with my Longsword.',
    worldState: combatWorld(),
    characterSheet: fighter,
    rollDie: sequenceRolls([12, 4]),
  });
  const rest = adjudicate({
    message: 'I take a short rest.',
    worldState: {
      current_location: 'Lantern Bridge',
      player_stats: { hp: 5, max_hp: 12, armor_class: 16 },
      active_effects: [],
      combat_state: null,
    },
    characterSheet: fighter,
    rollDie: sequenceRolls([5]),
  });

  for (const result of [secondWind, adrenalineRush, attack, rest]) {
    assert.equal(result.handled, true);
    assert.equal(shouldNarrateResolvedEvent({ result }), true, result.logType);
    assert.ok(createResolvedEventNarrationAction({ message: 'player action', result, characterSheet: fighter }));
  }
});

test('prompts, unresolved choices, and blocked mechanics stay deterministic', () => {
  const pendingCheck = adjudicate({
    message: 'I look around for danger.',
    worldState: {
      current_location: 'Lantern Bridge',
      scene_presence: { exact_location: 'Lantern Bridge', present_npcs: [], present_objects: ['bridge rail'] },
      player_stats: { hp: 12, max_hp: 12, armor_class: 16 },
      pending_roll: null,
      combat_state: null,
    },
    characterSheet: fighter,
  });
  const unavailable = resolveFeatureAction({
    message: 'I use Second Wind.',
    worldState: combatWorld({
      player_stats: {
        hp: 5,
        max_hp: 12,
        armor_class: 16,
        resources: { second_wind: { name: 'Second Wind', remaining: 0, max: 2 } },
      },
    }),
    characterSheet: fighter,
  });

  assert.ok(pendingCheck.worldState.pending_roll);
  assert.equal(shouldNarrateResolvedEvent({ result: pendingCheck }), false);
  assert.equal(shouldNarrateResolvedEvent({ result: unavailable }), false);
  assert.equal(createResolvedEventNarrationAction({ message: 'I use Second Wind.', result: unavailable }), null);
});

test('shared narration frame preserves authoritative mechanics and forbids a second ruling', () => {
  const result = {
    handled: true,
    logType: 'spell_healing',
    reply: 'You restore 7 HP. HP: (5 -> 12).',
    worldState: combatWorld({ player_stats: { hp: 12, max_hp: 12, armor_class: 16 } }),
    narrationGuidance: 'Describe warm light gathering around the wound.',
  };
  const frame = buildResolvedEventNarrativeFrame({
    message: 'I cast Cure Wounds on myself.',
    result,
    worldState: result.worldState,
    characterSheet: fighter,
  });

  assert.match(frame, /Authoritative rules outcome: You restore 7 HP/);
  assert.match(frame, /preserve every stated result/i);
  assert.match(frame, /do not request another roll/i);
  assert.match(frame, /do not invent player speech/i);
  assert.match(frame, /warm light gathering around the wound/i);
});
