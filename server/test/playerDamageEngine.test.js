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
