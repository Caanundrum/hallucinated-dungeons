process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyPendingRollResourceIntent,
  buildResourceState,
  completeLongRestResources,
  completeShortRestResources,
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

test('Lucky spends a point to grant Advantage before the pending d20 test', () => {
  const result = applyPendingRollResourceIntent({
    message: 'Use lucky.',
    characterSheet: humanSheet(),
    worldState: {
      player_stats: {
        resources: {
          luck_points: { name: 'Luck Points', remaining: 2, max: 2, reset: 'long_rest' },
        },
      },
      pending_roll: {
        id: 'roll_lucky',
        kind: 'skill_check',
        label: 'Wisdom (Insight)',
        ability: 'wis',
        modifier: 2,
        dc: 15,
      },
    },
  });

  assert.equal(result.worldState.player_stats.resources.luck_points.remaining, 1);
  assert.equal(result.worldState.pending_roll.advantage_mode, 'advantage');
  assert.deepEqual(result.worldState.pending_roll.advantage_sources, ['Lucky']);
  assert.equal(result.worldState.pending_roll.reroll_rules, undefined);
});

test('stale Luck Point state cannot grant Lucky to a character without the feat', () => {
  const result = applyPendingRollResourceIntent({
    message: 'Use lucky.',
    characterSheet: { identity: { species: 'orc' } },
    worldState: {
      player_stats: {
        resources: {
          luck_points: { name: 'Luck Points', remaining: 2, max: 2, reset: 'long_rest' },
        },
      },
      pending_roll: {
        id: 'roll_stale_lucky',
        kind: 'skill_check',
      },
    },
  });

  assert.equal(result.worldState.player_stats.resources.luck_points.remaining, 2);
  assert.match(result.reply, /not on this character sheet/);
});

test('detects automatic d20 reroll features such as Halfling Luck', () => {
  const rules = getAutoD20RerollRules({
    identity: { species: 'halfling' },
  });

  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 'halfling_luck');
});

test('builds level 1 class feature resources from the character sheet', () => {
  const fighter = buildResourceState({
    identity: { class: 'fighter', level: 1 },
    derived_stats: { proficiency_bonus: 2 },
  });
  const paladin = buildResourceState({
    identity: { class: 'paladin', level: 1 },
  });
  const bard = buildResourceState({
    identity: { class: 'bard', level: 1 },
    abilities: { modifiers: { cha: 3 } },
  });

  assert.equal(fighter.second_wind.remaining, 2);
  assert.equal(fighter.action_surge, undefined);
  assert.equal(paladin.lay_on_hands.max, 5);
  assert.equal(bard.bardic_inspiration.max, 3);
});

test('builds Fighter Action Surge resource starting at level 2', () => {
  const fighter = buildResourceState({
    identity: { class: 'fighter', level: 2 },
    derived_stats: { proficiency_bonus: 2 },
  });

  assert.equal(fighter.action_surge.remaining, 1);
  assert.equal(fighter.action_surge.reset, 'short_rest');
});

test("builds Paladin's Smite free use starting at level 2", () => {
  const levelOne = buildResourceState({ identity: { class: 'paladin', level: 1 } });
  const levelTwo = buildResourceState({ identity: { class: 'paladin', level: 2 } });

  assert.equal(levelOne.paladins_smite, undefined);
  assert.equal(levelTwo.paladins_smite.remaining, 1);
  assert.equal(levelTwo.paladins_smite.max, 1);
  assert.equal(levelTwo.paladins_smite.reset, 'long_rest');
});

test('builds Cleric Channel Divinity and Druid Wild Shape resources starting at level 2', () => {
  const cleric = buildResourceState({
    identity: { class: 'cleric', level: 2 },
    derived_stats: { proficiency_bonus: 2 },
  });
  const druid = buildResourceState({
    identity: { class: 'druid', level: 2 },
    derived_stats: { proficiency_bonus: 2 },
  });

  assert.equal(cleric.channel_divinity.remaining, 2);
  assert.equal(cleric.channel_divinity.reset, 'short_rest');
  assert.equal(druid.wild_shape.remaining, 2);
  assert.equal(druid.wild_shape.reset, 'short_rest');
});

test('builds level 2 Monk Focus resources and restores Focus Points on short rest', () => {
  const monk = {
    identity: { class: 'monk', level: 2 },
    derived_stats: { proficiency_bonus: 2 },
  };
  const resources = buildResourceState(monk);
  const rested = completeShortRestResources({
    characterSheet: monk,
    worldState: {
      player_stats: {
        resources: {
          focus_points: { name: 'Focus Points', remaining: 0, max: 2, reset: 'short_rest' },
          uncanny_metabolism: { name: 'Uncanny Metabolism', remaining: 0, max: 1, reset: 'long_rest' },
        },
      },
    },
  });

  assert.equal(resources.focus_points.remaining, 2);
  assert.equal(resources.uncanny_metabolism.remaining, 1);
  assert.equal(rested.resources.focus_points.remaining, 2);
  assert.equal(rested.resources.uncanny_metabolism.remaining, 0);
});

test('short and long rests recover class feature resources', () => {
  const shortRest = completeShortRestResources({
    characterSheet: { identity: { class: 'fighter', level: 1 } },
    worldState: {
      player_stats: {
        resources: {
          second_wind: { name: 'Second Wind', remaining: 0, max: 2, reset: 'long_rest', recover_on_short_rest: 1 },
        },
      },
    },
  });
  const longRest = completeLongRestResources({
    characterSheet: { identity: { class: 'barbarian', level: 1 } },
    worldState: {
      player_stats: {
        resources: {
          rage: { name: 'Rage', remaining: 0, max: 2, reset: 'long_rest' },
        },
      },
    },
  });

  assert.equal(shortRest.resources.second_wind.remaining, 1);
  assert.match(shortRest.notes.join(' '), /Second Wind recovers 1 use/);
  assert.equal(longRest.resources.rage.remaining, 2);
});

test('builds proficiency-scaled species resources and restores short-rest species uses on either rest', () => {
  const orc = {
    identity: { species: 'orc', level: 1 },
    derived_stats: { proficiency_bonus: 2 },
  };
  const resources = buildResourceState(orc);
  assert.equal(resources.adrenaline_rush.max, 2);
  assert.equal(resources.relentless_endurance.max, 1);

  const spentWorld = {
    player_stats: {
      resources: {
        adrenaline_rush: { name: 'Adrenaline Rush', remaining: 0, max: 2, reset: 'short_rest' },
      },
    },
  };
  assert.equal(completeShortRestResources({ characterSheet: orc, worldState: spentWorld }).resources.adrenaline_rush.remaining, 2);
  assert.equal(completeLongRestResources({ characterSheet: orc, worldState: spentWorld }).resources.adrenaline_rush.remaining, 2);
});

test('builds proficiency-scaled Dragonborn, Dwarf, and Goliath species resources', () => {
  const derived_stats = { proficiency_bonus: 2 };
  assert.equal(buildResourceState({ identity: { species: 'dragonborn' }, derived_stats }).breath_weapon.max, 2);
  assert.equal(buildResourceState({ identity: { species: 'dwarf' }, derived_stats }).stonecunning.max, 2);
  assert.equal(buildResourceState({ identity: { species: 'goliath' }, derived_stats }).giant_ancestry.max, 2);
});
