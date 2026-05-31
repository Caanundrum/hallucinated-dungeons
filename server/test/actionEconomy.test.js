process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  beginPlayerTurn,
  grantMovement,
  spendTurnResource,
  spendMovement,
  getSpellActionResource,
} = require('../src/actionEconomy');

const characterSheet = {
  derived_stats: {
    speed: 35,
  },
};

function combatWorld(overrides = {}) {
  return {
    player_stats: { speed: 30 },
    combat_state: {
      active: true,
      round: 1,
      turn_index: 0,
      combatants: [],
      ...(overrides.combat_state || {}),
    },
    ...overrides,
  };
}

test('beginPlayerTurn resets action, bonus action, reaction, and movement', () => {
  const result = beginPlayerTurn(combatWorld(), characterSheet);
  const resources = result.combat_state.turn_resources;

  assert.equal(resources.action_available, true);
  assert.equal(resources.bonus_action_available, true);
  assert.equal(resources.reaction_available, true);
  assert.equal(resources.movement_remaining, 30);
  assert.deepEqual(resources.used, []);
});

test('spending an action blocks a second action before the next turn', () => {
  const first = spendTurnResource(beginPlayerTurn(combatWorld(), characterSheet), 'action', 'Attack', characterSheet);
  const second = spendTurnResource(first.worldState, 'action', 'Dodge', characterSheet);

  assert.equal(first.ok, true);
  assert.equal(first.worldState.combat_state.turn_resources.action_available, false);
  assert.equal(second.ok, false);
  assert.match(second.reply, /Action is already spent/);
});

test('bonus action and action are tracked separately', () => {
  const started = beginPlayerTurn(combatWorld(), characterSheet);
  const bonus = spendTurnResource(started, 'bonus_action', 'Shield of Faith', characterSheet);
  const action = spendTurnResource(bonus.worldState, 'action', 'Attack', characterSheet);

  assert.equal(bonus.ok, true);
  assert.equal(action.ok, true);
  assert.equal(action.worldState.combat_state.turn_resources.bonus_action_available, false);
  assert.equal(action.worldState.combat_state.turn_resources.action_available, false);
});

test('movement spend reduces remaining movement without consuming the action', () => {
  const started = beginPlayerTurn(combatWorld(), characterSheet);
  const moved = spendMovement(started, 10, 'step behind cover', characterSheet);

  assert.equal(moved.ok, true);
  assert.equal(moved.worldState.combat_state.turn_resources.movement_remaining, 20);
  assert.equal(moved.worldState.combat_state.turn_resources.action_available, true);
});

test('movement grants add Dash distance without consuming the action', () => {
  const started = beginPlayerTurn(combatWorld(), characterSheet);
  const dashed = grantMovement(started, 30, 'Adrenaline Rush Dash', characterSheet);

  assert.equal(dashed.ok, true);
  assert.equal(dashed.worldState.combat_state.turn_resources.movement_remaining, 60);
  assert.equal(dashed.worldState.combat_state.turn_resources.action_available, true);
});

test('spell casting times map to combat resources', () => {
  assert.equal(getSpellActionResource({ casting_time: 'Action' }), 'action');
  assert.equal(getSpellActionResource({ casting_time: 'Bonus Action' }), 'bonus_action');
  assert.equal(getSpellActionResource({ casting_time: 'Reaction' }), 'reaction');
  assert.equal(getSpellActionResource({ casting_time: '1 minute' }), null);
});
