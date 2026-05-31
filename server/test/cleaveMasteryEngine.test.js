process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkCleaveSpatialEligibility,
  getCleaveExtraAttack,
  markCleaveUsed,
} = require('../src/cleaveMasteryEngine');

function sheet() {
  return {
    abilities: { modifiers: { str: 3 } },
    weapon_masteries: [{ weapon_id: 'greataxe', mastery: 'cleave' }],
  };
}

function attack(overrides = {}) {
  return {
    name: 'Greataxe',
    weaponId: 'greataxe',
    ability: 'str',
    attackKind: 'melee',
    damageFormula: '1d12 + 3',
    properties: ['heavy', 'two-handed'],
    isWeapon: true,
    ...overrides,
  };
}

function combat(overrides = {}) {
  return {
    turn_resources: {},
    combatants: [
      { name: 'Ari', hp: 12, is_player: true },
      { name: 'Cultist', hp: 12, is_player: false },
      { name: 'Guard', hp: 12, is_player: false },
    ],
    ...overrides,
  };
}

test('Cleave builds a declared second attack with weapon damage but no positive ability modifier', () => {
  const state = combat();
  const result = getCleaveExtraAttack({
    characterSheet: sheet(),
    attack: attack(),
    primaryTarget: state.combatants[1],
    combat: state,
    message: 'Attack the Cultist and cleave the Guard.',
  });

  assert.equal(result.ok, true);
  assert.equal(result.target.name, 'Guard');
  assert.equal(result.attack.damageFormula, '1d12');
  assert.equal(result.spatial.mode, 'scene_zone_assumption');
});

test('Cleave enforces second-target adjacency and weapon reach when hex coordinates exist', () => {
  const player = { position: { map_id: 'crypt', q: 0, r: 0 } };
  const primaryTarget = { position: { map_id: 'crypt', q: 1, r: 0 } };
  const secondaryTarget = { position: { map_id: 'crypt', q: 2, r: 0 } };
  const greataxe = checkCleaveSpatialEligibility({ player, primaryTarget, secondaryTarget, attack: attack() });
  const halberd = checkCleaveSpatialEligibility({
    player,
    primaryTarget,
    secondaryTarget,
    attack: attack({ properties: ['heavy', 'reach', 'two-handed'] }),
  });

  assert.equal(greataxe.ok, false);
  assert.equal(halberd.ok, true);
});

test('Cleave is explicitly limited to once per player turn', () => {
  const state = combat();
  const used = markCleaveUsed(state);
  const result = getCleaveExtraAttack({
    characterSheet: sheet(),
    attack: attack(),
    primaryTarget: used.combatants[1],
    combat: used,
    message: 'Attack the Cultist and cleave the Guard.',
  });

  assert.equal(result.ok, false);
  assert.match(result.reply, /already been used this turn/);
});
