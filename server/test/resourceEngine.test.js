process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyPendingRollResourceIntent,
  buildResourceState,
  completeLongRestResources,
  getAutoD20RerollRules,
  spendResource,
} = require('../src/resourceEngine');

function humanSheet(overrides = {}) {
  return {
    identity: { name: 'Ari', species: 'human', class: 'fighter', level: 1 },
    derived_stats: { proficiency_bonus: 2 },
    features: [
      { source: 'species', name: 'Resourceful', description: 'Gain Heroic Inspiration whenever you finish a Long Rest.' },
      { source: 'origin', name: 'Lucky', description: 'You gain luck you can spend.' },
    ],
    origin: { background_feat: 'lucky' },
    resources: {},
    ...overrides,
  };
}

test('builds resource state for Heroic Inspiration and Lucky without requiring old sheet fields', () => {
  const resources = buildResourceState(humanSheet(), {});

  assert.equal(resources.heroic_inspiration.name, 'Heroic Inspiration');
  assert.equal(resources.heroic_inspiration.remaining, 0);
  assert.equal(resources.luck_points.max, 2);
  assert.equal(resources.luck_points.remaining, 2);
});

test('long rest grants Human Resourceful Heroic Inspiration and resets luck', () => {
  const result = completeLongRestResources({
    characterSheet: humanSheet(),
    worldState: {
      player_stats: {
        resources: {
          heroic_inspiration: { name: 'Heroic Inspiration', remaining: 0, max: 1 },
          luck_points: { name: 'Luck Points', remaining: 0, max: 2, reset: 'long_rest' },
        },
      },
    },
  });

  assert.equal(result.resources.heroic_inspiration.remaining, 1);
  assert.equal(result.resources.luck_points.remaining, 2);
  assert.match(result.notes.join(' '), /Human Resourceful/);
});

test('spends a resource into world_state player resources', () => {
  const spent = spendResource({
    characterSheet: humanSheet(),
    worldState: {
      player_stats: {
        resources: {
          heroic_inspiration: { name: 'Heroic Inspiration', remaining: 1, max: 1 },
        },
      },
    },
    resource: 'heroic_inspiration',
  });

  assert.equal(spent.ok, true);
  assert.equal(spent.worldState.player_stats.resources.heroic_inspiration.remaining, 0);
});

test('primes Heroic Inspiration on a pending roll as a failed-total reroll', () => {
  const result = applyPendingRollResourceIntent({
    message: 'Use heroic inspiration.',
    characterSheet: humanSheet(),
    worldState: {
      player_stats: {
        resources: {
          heroic_inspiration: { name: 'Heroic Inspiration', remaining: 1, max: 1 },
        },
      },
      pending_roll: {
        id: 'roll_test',
        kind: 'skill_check',
        label: 'Wisdom (Insight)',
        ability: 'wis',
        modifier: 2,
        dc: 15,
      },
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.heroic_inspiration.remaining, 0);
  assert.equal(result.worldState.pending_roll.reroll_rules[0].trigger, 'failed_total');
});

test('detects automatic d20 reroll features such as Halfling Luck', () => {
  const rules = getAutoD20RerollRules({
    identity: { species: 'halfling' },
  });

  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 'halfling_luck');
});
