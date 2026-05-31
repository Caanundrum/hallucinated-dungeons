process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildStartingAmmunitionItems,
  checkAmmunitionAttack,
  recoverSpentAmmunition,
  spendAmmunitionForAttack,
} = require('../src/ammunitionEngine');
const { getContentBundle } = require('../src/contentData');

function longbow(overrides = {}) {
  return {
    name: 'Longbow',
    weaponId: 'longbow',
    properties: ['ammunition', 'heavy', 'two-handed'],
    ammunitionType: 'arrows',
    ammunitionBundleQuantity: 20,
    ...overrides,
  };
}

function handCrossbow(overrides = {}) {
  return {
    name: 'Hand Crossbow',
    weaponId: 'hand_crossbow',
    properties: ['ammunition', 'light', 'loading'],
    ammunitionType: 'bolts',
    ammunitionBundleQuantity: 20,
    ...overrides,
  };
}

test('starting ranged weapons seed their matching ammunition bundle', () => {
  const content = getContentBundle();
  const weapon = content.equipment.find((item) => item.id === 'longbow');
  const items = buildStartingAmmunitionItems([weapon], content);

  assert.deepEqual(items.map((item) => [item.id, item.quantity]), [['arrows', 20]]);
});

test('each ammunition weapon attack spends one piece and records battlefield recovery', () => {
  const spent = spendAmmunitionForAttack({
    attack: longbow(),
    worldState: { player_stats: {} },
  });

  assert.equal(spent.ok, true);
  assert.equal(spent.worldState.player_stats.ammunition.arrows.remaining, 19);
  assert.equal(spent.worldState.player_stats.ammunition_spent_since_recovery.arrows, 1);
});

test('one-handed ammunition weapons require a free hand to load', () => {
  const result = checkAmmunitionAttack({
    attack: handCrossbow(),
    characterSheet: { equipped: { main_hand: 'hand_crossbow', off_hand: 'dagger' } },
  });

  assert.equal(result.ok, false);
  assert.match(result.reply, /needs a free hand/);
});

test('Loading permits only one shot from the weapon for the same action resource', () => {
  const worldState = {
    combat_state: {
      active: true,
      turn_resources: {},
    },
    player_stats: {},
  };
  const first = spendAmmunitionForAttack({ attack: handCrossbow(), worldState, actionResource: 'action' });
  const blocked = checkAmmunitionAttack({
    attack: handCrossbow(),
    worldState: first.worldState,
    actionResource: 'action',
  });
  const bonusAction = checkAmmunitionAttack({
    attack: handCrossbow(),
    worldState: first.worldState,
    actionResource: 'bonus_action',
  });

  assert.equal(blocked.ok, false);
  assert.match(blocked.reply, /Loading property/);
  assert.equal(bonusAction.ok, true);
});

test('battlefield search recovers half of expended ammunition rounded down', () => {
  const recovered = recoverSpentAmmunition({
    player_stats: {
      ammunition: { arrows: { id: 'arrows', name: 'Arrows', remaining: 13 } },
      ammunition_spent_since_recovery: { arrows: 7 },
    },
  });

  assert.equal(recovered.ok, true);
  assert.equal(recovered.worldState.player_stats.ammunition.arrows.remaining, 16);
  assert.deepEqual(recovered.worldState.player_stats.ammunition_spent_since_recovery, {});
});
