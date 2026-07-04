process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  beginPlayerTurn,
  continuePlayerTurn,
  ensureTurnResources,
  grantActionSurgeAction,
  grantMovement,
  spendAttackAction,
  setTurnFlag,
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

test('turn resources reset when the active combat character changes', () => {
  const staleMonkTurn = combatWorld({
    player_stats: { speed: 30, character_id: 'char_bard', name: 'QA Bard' },
    combat_state: {
      active: true,
      round: 1,
      turn_index: 0,
      combatants: [],
      turn_resources: {
        actor: 'player',
        character_id: 'char_monk',
        character_name: 'QA Monk',
        action_available: true,
        bonus_action_available: false,
        reaction_available: true,
        movement_remaining: 40,
        used: [{ resource: 'bonus_action', label: 'Flurry of Blows' }],
      },
    },
  });
  const bardSheet = {
    identity: { name: 'QA Bard', character_id: 'char_bard' },
    derived_stats: { character_id: 'char_bard', speed: 30 },
  };

  const reset = ensureTurnResources(staleMonkTurn, bardSheet);
  const resources = reset.combat_state.turn_resources;

  assert.equal(resources.character_id, 'char_bard');
  assert.equal(resources.bonus_action_available, true);
  assert.equal(resources.movement_remaining, 30);
  assert.deepEqual(resources.used, []);
});

test('Action Surge grants one extra non-Magic action after the regular action is spent', () => {
  const started = beginPlayerTurn(combatWorld(), characterSheet);
  const attacked = spendTurnResource(started, 'action', 'Attack', characterSheet);
  const surged = grantActionSurgeAction(attacked.worldState, characterSheet);
  const magic = spendTurnResource(surged.worldState, 'action', 'Magic Missile', characterSheet, { actionType: 'magic' });
  const secondAttack = spendTurnResource(magic.worldState, 'action', 'Attack', characterSheet);

  assert.equal(surged.ok, true);
  assert.equal(surged.worldState.combat_state.turn_resources.extra_action_available, true);
  assert.equal(magic.ok, false);
  assert.match(magic.reply, /cannot be the Magic action/);
  assert.equal(secondAttack.ok, true);
  assert.equal(secondAttack.worldState.combat_state.turn_resources.extra_action_available, false);
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

test('Exhaustion reduces combat movement resources', () => {
  const exhausted = beginPlayerTurn(combatWorld({
    player_stats: { speed: 30, conditions: ['exhaustion_2'] },
  }), characterSheet);
  const dashed = grantMovement(exhausted, exhausted.combat_state.turn_resources.movement_remaining, 'Dash', characterSheet);

  assert.equal(exhausted.combat_state.turn_resources.movement_remaining, 20);
  assert.equal(dashed.worldState.combat_state.turn_resources.movement_remaining, 40);
});

test('turn flags persist until the next player turn reset', () => {
  const started = beginPlayerTurn(combatWorld(), characterSheet);
  const flagged = setTurnFlag(started, 'dodging', true, characterSheet);
  const reset = beginPlayerTurn(flagged, characterSheet);

  assert.equal(flagged.combat_state.turn_resources.dodging, true);
  assert.equal(reset.combat_state.turn_resources.dodging, undefined);
});

test('combat continuation reports the remaining turn resources', () => {
  const spent = spendTurnResource(beginPlayerTurn(combatWorld(), characterSheet), 'action', 'Attack', characterSheet);
  const continued = continuePlayerTurn(spent.worldState, 'Attack resolved.', characterSheet);

  assert.equal(continued.worldState.combat_state.turn_resources.action_available, false);
  assert.match(continued.reply, /Your turn remains open/);
  assert.match(continued.reply, /Bonus Action, Reaction, 30 ft movement/);
  assert.match(continued.reply, /end turn/);
});

test('combat continuation does not advertise player actions during a Reaction window', () => {
  const state = {
    ...beginPlayerTurn(combatWorld(), characterSheet),
    pending_reaction: { id: 'reaction_test' },
  };
  const continued = continuePlayerTurn(state, 'Attack interrupted.', characterSheet);

  assert.equal(continued.worldState, state);
  assert.equal(continued.reply, 'Attack interrupted.');
});

test('spell casting times map to combat resources', () => {
  assert.equal(getSpellActionResource({ casting_time: 'Action' }), 'action');
  assert.equal(getSpellActionResource({ casting_time: 'Bonus Action' }), 'bonus_action');
  assert.equal(getSpellActionResource({ casting_time: 'Reaction' }), 'reaction');
  assert.equal(getSpellActionResource({ casting_time: '1 minute' }), null);
});

test('level 5 Extra Attack spends one Action across two attacks', () => {
  const fighter = { identity: { class: 'fighter', level: 5 }, derived_stats: { speed: 30, attacks_per_action: 2 } };
  const started = beginPlayerTurn(combatWorld(), fighter);
  const first = spendAttackAction(started, fighter, { name: 'Longsword' });
  const second = spendAttackAction(first.worldState, fighter, { name: 'Longsword' });
  const third = spendAttackAction(second.worldState, fighter, { name: 'Longsword' });

  assert.equal(first.ok, true);
  assert.equal(first.worldState.combat_state.turn_resources.attack_action_attacks_remaining, 1);
  assert.equal(second.ok, true);
  assert.equal(second.extraAttack, true);
  assert.equal(second.worldState.combat_state.turn_resources.attack_action_attacks_remaining, 0);
  assert.equal(third.ok, false);
});

test('Thirsting Blade grants Extra Attack only with the pact weapon', () => {
  const warlock = {
    identity: { class: 'warlock', level: 5 },
    class_choices: { eldritch_invocations: ['pact_of_the_blade', 'thirsting_blade'] },
    derived_stats: { speed: 30 },
  };
  const pact = spendAttackAction(beginPlayerTurn(combatWorld(), warlock), warlock, { pact_weapon: true });
  const ordinary = spendAttackAction(beginPlayerTurn(combatWorld(), warlock), warlock, { pact_weapon: false });

  assert.equal(pact.worldState.combat_state.turn_resources.attack_action_attacks_remaining, 1);
  assert.equal(ordinary.worldState.combat_state.turn_resources.attack_action_attacks_remaining, 0);
});
