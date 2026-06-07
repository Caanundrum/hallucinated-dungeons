process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyProgressionAwards,
  detectCombatAwards,
  detectDiscoveryAwards,
  detectSocialAwards,
  formatProgressionAwardSummary,
  getXpThreshold,
} = require('../src/progressionEngine');

function sheet(overrides = {}) {
  return {
    identity: {
      name: 'Ari',
      level: 1,
      experience_points: 0,
      ...overrides.identity,
    },
    derived_stats: {
      level: 1,
      ...overrides.derived_stats,
    },
    progression: overrides.progression || {},
  };
}

test('combat ending awards server-owned XP and marks level-up availability at threshold', () => {
  const beforeWorldState = {
    session_turn: 12,
    combat_state: {
      active: true,
      round: 1,
      combatants: [
        { is_player: true, name: 'Ari', hp: 10 },
        { is_player: false, name: 'Skeleton', hp: 0, max_hp: 13, xp_value: 300 },
      ],
    },
  };
  const afterWorldState = {
    session_turn: 12,
    combat_state: null,
  };

  const result = applyProgressionAwards({
    beforeWorldState,
    afterWorldState,
    characterSheet: sheet(),
    currentTurn: 12,
  });

  assert.equal(result.awards.length, 1);
  assert.equal(result.awards[0].amount, 300);
  assert.equal(result.characterSheet.identity.experience_points, 300);
  assert.equal(result.characterSheet.identity.level_up_available, true);
  assert.equal(result.levelUpAvailable.next_level, 2);
  assert.equal(result.worldState.player_stats.experience_points, 300);
  assert.match(formatProgressionAwardSummary({
    awards: result.awards,
    characterSheet: result.characterSheet,
  }), /\*\*Level Up Available:\*\*/);
});

test('progression awards dedupe by source id', () => {
  const beforeWorldState = {
    session_turn: 4,
    combat_state: {
      active: true,
      combatants: [
        { is_player: true, name: 'Ari', hp: 10 },
        { is_player: false, name: 'Skeleton', hp: 0, max_hp: 8, xp_value: 25 },
      ],
    },
  };
  const once = applyProgressionAwards({
    beforeWorldState,
    afterWorldState: { session_turn: 4, combat_state: null },
    characterSheet: sheet(),
    currentTurn: 4,
  });
  const twice = applyProgressionAwards({
    beforeWorldState,
    afterWorldState: once.worldState,
    characterSheet: once.characterSheet,
    currentTurn: 4,
  });

  assert.equal(once.awards.length, 1);
  assert.equal(twice.awards.length, 0);
  assert.equal(twice.characterSheet.identity.experience_points, 25);
});

test('new successful discovery produces one exploration XP award', () => {
  const awards = detectDiscoveryAwards({
    beforeWorldState: { discovery_state: { studies: {}, searches: {} } },
    afterWorldState: {
      discovery_state: {
        studies: {
          notice_board: {
            target: 'notice board',
            subject: 'missing road-workers',
            discovered: true,
            best_outcome: 'success',
          },
        },
        searches: {},
      },
    },
  });

  assert.equal(awards.length, 1);
  assert.equal(awards[0].source_type, 'discovery');
  assert.equal(awards[0].amount, 25);
  assert.match(awards[0].reason, /notice board/);
});

test('new successful social influence produces one social XP award', () => {
  const awards = detectSocialAwards({
    beforeWorldState: { npc_states: {} },
    afterWorldState: {
      npc_states: {
        clerk: {
          name: 'clerk',
          attitude: 'cooperative',
          leverage: 'more willing to help within reason',
          last_influence: {
            skill: 'persuasion',
            outcome: 'success',
            total: 18,
            dc: 15,
          },
          influence_history: [{
            skill: 'persuasion',
            outcome: 'success',
            total: 18,
            dc: 15,
            intent: 'I reassure the clerk and ask for help.',
          }],
        },
      },
    },
  });

  assert.equal(awards.length, 1);
  assert.equal(awards[0].source_type, 'social');
  assert.equal(awards[0].amount, 25);
  assert.match(awards[0].reason, /persuasion/);
});

test('combat XP falls back to simple HP bands when no stat-card XP exists', () => {
  const awards = detectCombatAwards({
    beforeWorldState: {
      session_turn: 2,
      combat_state: {
        active: true,
        combatants: [
          { is_player: true, name: 'Ari' },
          { is_player: false, name: 'Bandit', hp: 0, max_hp: 8 },
          { is_player: false, name: 'Bruiser', hp: 0, max_hp: 18 },
        ],
      },
    },
    afterWorldState: { combat_state: null },
    currentTurn: 2,
  });

  assert.equal(awards.length, 1);
  assert.equal(awards[0].amount, 125);
});

test('XP thresholds load from the 2024 progression table', () => {
  assert.equal(getXpThreshold(2), 300);
  assert.equal(getXpThreshold(20), 355000);
  assert.equal(getXpThreshold(21), null);
});
