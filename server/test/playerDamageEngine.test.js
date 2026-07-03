process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyDamageToPlayer,
  isKilledOutright,
} = require('../src/playerDamageEngine');

const orcSheet = {
  identity: { name: 'Ari', species: 'orc', level: 1 },
  derived_stats: { hp: 12, max_hp: 12, proficiency_bonus: 2 },
};

test('Orc Relentless Endurance is a shared fatal player damage safeguard', () => {
  const result = applyDamageToPlayer({
    player: { name: 'Ari', hp: 4, max_hp: 12, temp_hp: 0 },
    characterSheet: orcSheet,
    worldState: { player_stats: { hp: 4, max_hp: 12 } },
    damage: 8,
    damageType: 'bludgeoning',
    source: 'falling stone',
  });

  assert.equal(result.player.hp, 1);
  assert.equal(result.worldState.player_stats.resources.relentless_endurance.remaining, 0);
  assert.deepEqual(result.safeguards[0], {
    id: 'orc.relentless_endurance',
    resource: 'relentless_endurance',
    prevented_zero_hp: true,
  });
  assert.match(result.safeguardLines[0], /Relentless Endurance/);
});

test('Relentless Endurance does not stop instant death overflow', () => {
  const result = applyDamageToPlayer({
    player: { name: 'Ari', hp: 4, max_hp: 12 },
    characterSheet: orcSheet,
    worldState: { player_stats: { hp: 4, max_hp: 12 } },
    damage: 16,
    damageType: 'bludgeoning',
    source: 'catastrophic trap',
  });

  assert.equal(result.player.hp, 0);
  assert.equal(result.worldState.player_stats.resources, undefined);
  assert.equal(result.safeguards.length, 0);
  assert.equal(isKilledOutright({
    player: { hp: 0, max_hp: 12 },
    characterSheet: orcSheet,
    damageResult: { beforeHp: 4, hpDamage: 16 },
  }), true);
});

test('Monk Slow Fall reduces falling damage and spends the combat Reaction', () => {
  const result = applyDamageToPlayer({
    player: { name: 'Mira', hp: 30, max_hp: 30 },
    characterSheet: {
      identity: { name: 'Mira', class: 'monk', level: 4 },
      derived_stats: { hp: 30, max_hp: 30, level: 4 },
    },
    worldState: {
      player_stats: { hp: 30, max_hp: 30 },
      combat_state: {
        active: true,
        combatants: [{ name: 'Mira', hp: 30, max_hp: 30, is_player: true }],
        turn_resources: {
          action_available: true,
          bonus_action_available: true,
          reaction_available: true,
          movement_remaining: 40,
          used: [],
        },
      },
    },
    damage: 26,
    damageType: 'bludgeoning',
    source: 'falling from the ruined tower',
  });

  assert.equal(result.amount, 6);
  assert.equal(result.player.hp, 24);
  assert.equal(result.worldState.combat_state.turn_resources.reaction_available, false);
  assert.match(result.safeguardLines.join(' '), /reduces the falling damage by 20/);
});

test('Slow Fall cannot apply after the Reaction is spent', () => {
  const result = applyDamageToPlayer({
    player: { name: 'Mira', hp: 30, max_hp: 30 },
    characterSheet: {
      identity: { name: 'Mira', class: 'monk', level: 4 },
      derived_stats: { hp: 30, max_hp: 30, level: 4 },
    },
    worldState: {
      player_stats: { hp: 30, max_hp: 30 },
      combat_state: {
        active: true,
        combatants: [{ name: 'Mira', hp: 30, max_hp: 30, is_player: true }],
        turn_resources: {
          action_available: true,
          bonus_action_available: true,
          reaction_available: false,
          movement_remaining: 40,
          used: [],
        },
      },
    },
    damage: 12,
    damageType: 'bludgeoning',
    source: 'fall damage',
  });

  assert.equal(result.amount, 12);
  assert.equal(result.player.hp, 18);
  assert.equal(result.safeguards.length, 0);
});
