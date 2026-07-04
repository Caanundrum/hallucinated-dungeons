process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  adjudicate,
  advanceEnemyTurns,
} = require('../src/refereeCore');
const { resolveCombatMovement } = require('../src/combatMovementEngine');
const { getReactionOptions, resolvePendingReactionChoice } = require('../src/reactionEngine');

const wizardSheet = {
  identity: { name: 'Mira', level: 1, class: 'wizard', class_name: 'Wizard' },
  abilities: { modifiers: { dex: 2, int: 3 } },
  derived_stats: {
    hp: 8,
    max_hp: 8,
    armor_class: 12,
    initiative: 2,
  },
  spellcasting: {
    ability: 'int',
    cantrips_known: ['fire_bolt'],
    spells_prepared: ['shield'],
    slots: { 1: 1 },
  },
};

const warlockSheet = {
  identity: { name: 'Vex', level: 1, class: 'warlock', class_name: 'Warlock' },
  abilities: { modifiers: { dex: 1, cha: 3 } },
  derived_stats: {
    hp: 8,
    max_hp: 8,
    armor_class: 12,
    initiative: 1,
    spell_save_dc: 13,
  },
  spellcasting: {
    ability: 'cha',
    spells_prepared: ['hellish_rebuke'],
    slots: { 1: 1 },
  },
};

const dualReactionSheet = {
  ...warlockSheet,
  spellcasting: {
    ...warlockSheet.spellcasting,
    spells_prepared: ['shield', 'hellish_rebuke'],
    slots: { 1: 2 },
  },
};

const fighterSheet = {
  identity: { name: 'Bran', level: 1, class: 'fighter', class_name: 'Fighter' },
  abilities: { modifiers: { str: 3, dex: 1 } },
  derived_stats: {
    hp: 12,
    max_hp: 12,
    armor_class: 16,
    initiative: 1,
    attack_breakdowns: [
      { weapon_id: 'longsword', name: 'Longsword', ability: 'str', attack_total: 5, damage_formula: '1d8+3' },
    ],
  },
  equipped: { main_hand: 'longsword', off_hand: null },
};

function combatant(name, initiative, overrides = {}) {
  return {
    name,
    initiative,
    hp: 8,
    max_hp: 8,
    ac: 12,
    conditions: [],
    is_player: false,
    attack: { name: 'claw', attack_bonus: 3, damage_formula: '1d4+1' },
    ...overrides,
  };
}

function combatWorld({ slots = 1, combatants = null, turnIndex = 0 } = {}) {
  return {
    active_effects: [],
    player_stats: {
      hp: 8,
      max_hp: 8,
      armor_class: 12,
      base_armor_class: 12,
      spell_slots: { 1: slots },
    },
    combat_state: {
      active: true,
      round: 1,
      turn_index: turnIndex,
      turn_resources: {
        actor: 'player',
        action_available: false,
        bonus_action_available: true,
        reaction_available: true,
        movement_remaining: 30,
        used: [{ resource: 'action', label: 'Fire Bolt' }],
      },
      combatants: combatants || [
        { name: 'Mira', initiative: 18, hp: 8, max_hp: 8, ac: 12, is_player: true, conditions: [] },
        combatant('Skeleton', 8),
      ],
    },
  };
}

function sequenceRolls(values) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 1;
}

function warlockWorld({ slots = 1, combatants = null } = {}) {
  const world = combatWorld({
    slots,
    combatants: combatants || [
      { name: 'Vex', initiative: 18, hp: 8, max_hp: 8, ac: 12, is_player: true, conditions: [] },
      combatant('Skeleton', 8, { hp: 30, max_hp: 30 }),
    ],
  });
  world.player_stats.spell_slots = { 1: slots };
  return world;
}

function fighterWorld({ combatants = null } = {}) {
  return {
    active_effects: [],
    player_stats: {
      hp: 12,
      max_hp: 12,
      armor_class: 16,
    },
    combat_state: {
      active: true,
      round: 1,
      turn_index: 0,
      turn_resources: {
        actor: 'player',
        action_available: false,
        bonus_action_available: true,
        reaction_available: true,
        movement_remaining: 30,
        used: [{ resource: 'action', label: 'Attack' }],
      },
      combatants: combatants || [
        { name: 'Bran', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [], position: { map_id: 'road', q: 0, r: 0 } },
        combatant('Skeleton', 8, {
          hp: 8,
          max_hp: 8,
          behavior: 'fleeing',
          speed: 30,
          position: { map_id: 'road', q: 1, r: 0 },
        }),
      ],
    },
  };
}

test('Shield pauses a creature hit, spends the Reaction and slot, then turns the hit into a miss', () => {
  const pending = advanceEnemyTurns({
    worldState: combatWorld(),
    characterSheet: wizardSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12]),
  });
  const resolved = adjudicate({
    message: 'Cast Shield.',
    worldState: pending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([4]),
  });

  assert.equal(pending.worldState.combat_state.round, 1);
  assert.equal(pending.worldState.player_stats.hp, 8);
  assert.equal(pending.worldState.pending_reaction.trigger, 'attack_hit');
  assert.match(pending.reply, /Reaction window/);
  assert.equal(resolved.worldState.player_stats.hp, 8);
  assert.equal(resolved.worldState.player_stats.spell_slots[1], 0);
  assert.equal(resolved.worldState.combat_state.round, 2);
  assert.equal(resolved.worldState.combat_state.turn_resources.reaction_available, true);
  assert.equal(resolved.worldState.player_stats.armor_class, 12);
  assert.deepEqual(resolved.worldState.active_effects, []);
  assert.match(resolved.reply, /Shield turns the triggering hit into a miss/);
});

test('declining a Shield window resumes the stored attack and applies damage', () => {
  const pending = advanceEnemyTurns({
    worldState: combatWorld(),
    characterSheet: wizardSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12]),
  });
  const resolved = adjudicate({
    message: 'Decline reaction.',
    worldState: pending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([3]),
  });

  assert.equal(resolved.worldState.player_stats.hp, 4);
  assert.equal(resolved.worldState.player_stats.spell_slots[1], 1);
  assert.match(resolved.reply, /decline the Reaction/);
  assert.match(resolved.reply, /Hit for 4 damage/);
});

test('an unrelated action cannot skip an open Reaction window', () => {
  const pending = advanceEnemyTurns({
    worldState: combatWorld(),
    characterSheet: wizardSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12]),
  });
  const blocked = adjudicate({
    message: 'I attack the skeleton.',
    worldState: pending.worldState,
    characterSheet: wizardSheet,
  });

  assert.equal(blocked.worldState.pending_reaction.id, pending.worldState.pending_reaction.id);
  assert.match(blocked.reply, /Reaction window/);
});

test('Shield cannot cancel a creature critical hit', () => {
  const pending = advanceEnemyTurns({
    worldState: combatWorld(),
    characterSheet: wizardSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([20]),
  });
  const resolved = adjudicate({
    message: 'Use Shield.',
    worldState: pending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([2, 3]),
  });

  assert.equal(resolved.worldState.player_stats.hp, 2);
  assert.match(resolved.reply, /Critical hit/);
});

test('Shield protects against later creature attacks until the player turn starts', () => {
  const pending = advanceEnemyTurns({
    worldState: combatWorld({
      combatants: [
        { name: 'Mira', initiative: 18, hp: 8, max_hp: 8, ac: 12, is_player: true, conditions: [] },
        combatant('Skeleton', 8),
        combatant('Cultist', 6),
      ],
    }),
    characterSheet: wizardSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12]),
  });
  const resolved = adjudicate({
    message: 'Cast Shield.',
    worldState: pending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([12]),
  });

  assert.equal(resolved.worldState.player_stats.hp, 8);
  assert.match(resolved.reply, /Skeleton uses claw: rolls 12\+3 = 15 vs AC 17/);
  assert.match(resolved.reply, /Cultist uses claw: rolls 12\+3 = 15 vs AC 17.*Miss/);
});

test('Shield expires when enemy-first initiative reaches the player without advancing the round', () => {
  const pending = advanceEnemyTurns({
    worldState: combatWorld({
      combatants: [
        combatant('Skeleton', 18),
        { name: 'Mira', initiative: 8, hp: 8, max_hp: 8, ac: 12, is_player: true, conditions: [] },
      ],
      turnIndex: 0,
    }),
    characterSheet: wizardSheet,
    playerTurnNote: 'Skeleton moves first.',
    advanceRound: false,
    rollDie: sequenceRolls([12]),
  });
  const resolved = adjudicate({
    message: 'Cast Shield.',
    worldState: pending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([4]),
  });

  assert.equal(resolved.worldState.combat_state.round, 1);
  assert.equal(resolved.worldState.player_stats.armor_class, 12);
  assert.deepEqual(resolved.worldState.active_effects, []);
  assert.match(resolved.reply, /Round 1 begins\. It is your turn/);
});

test('a creature hit resolves normally when Shield has no remaining slot', () => {
  const resolved = advanceEnemyTurns({
    worldState: combatWorld({ slots: 0 }),
    characterSheet: {
      ...wizardSheet,
      spellcasting: { ...wizardSheet.spellcasting, slots: { 1: 0 } },
    },
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12, 3]),
  });

  assert.equal(resolved.worldState.pending_reaction, null);
  assert.equal(resolved.worldState.player_stats.hp, 4);
  assert.match(resolved.reply, /Hit for 4 damage/);
});

test('damage before a later Reaction pause still prompts the eventual concentration save', () => {
  const state = combatWorld({
    combatants: [
      { name: 'Mira', initiative: 18, hp: 8, max_hp: 8, ac: 12, is_player: true, conditions: [] },
      combatant('Skeleton', 8),
      combatant('Cultist', 6),
    ],
  });
  state.active_effects = [{
    id: 'detect_magic',
    name: 'Detect Magic',
    concentration: true,
    remaining_rounds: 100,
  }];
  const firstPending = advanceEnemyTurns({
    worldState: state,
    characterSheet: wizardSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12]),
  });
  const secondPending = adjudicate({
    message: 'Decline reaction.',
    worldState: firstPending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([3, 12]),
  });
  const resolved = adjudicate({
    message: 'Cast Shield.',
    worldState: secondPending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([4]),
  });

  assert.equal(secondPending.worldState.player_stats.hp, 4);
  assert.equal(secondPending.worldState.pending_reaction.trigger, 'attack_hit');
  assert.equal(resolved.worldState.pending_roll.kind, 'concentration_save');
  assert.match(resolved.reply, /Concentration is at risk/);
});

test('Shield pauses an Opportunity Attack before movement and resumes the original movement after the miss', () => {
  const pending = adjudicate({
    message: 'I retreat 10 feet away from the skeleton.',
    worldState: combatWorld(),
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([12]),
  });
  const skeletonBefore = pending.worldState.combat_state.combatants.find((entry) => entry.name === 'Skeleton');
  const resolved = adjudicate({
    message: 'Cast Shield.',
    worldState: pending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([4]),
  });
  const skeletonAfter = resolved.worldState.combat_state.combatants.find((entry) => entry.name === 'Skeleton');

  assert.equal(pending.worldState.pending_reaction.resume.type, 'combat_movement');
  assert.equal(pending.worldState.combat_state.turn_resources.movement_remaining, 30);
  assert.equal(pending.worldState.player_stats.last_movement, undefined);
  assert.equal(skeletonBefore.reaction_available, false);
  assert.equal(resolved.worldState.pending_reaction, null);
  assert.equal(resolved.worldState.player_stats.hp, 8);
  assert.equal(resolved.worldState.player_stats.spell_slots[1], 0);
  assert.equal(resolved.worldState.player_stats.armor_class, 17);
  assert.equal(resolved.worldState.combat_state.turn_resources.reaction_available, false);
  assert.equal(resolved.worldState.combat_state.turn_resources.movement_remaining, 20);
  assert.equal(resolved.worldState.player_stats.last_movement.feet, 10);
  assert.equal(skeletonAfter.reaction_available, false);
  assert.match(resolved.reply, /Shield turns the triggering hit into a miss/);
  assert.match(resolved.reply, /You move 10 feet/);
});

test('hex movement does not update the player position until a Shielded Opportunity Attack resolves', () => {
  const destination = { map_id: 'crypt', q: -2, r: 0 };
  const pending = resolveCombatMovement({
    message: 'I retreat from the skeleton.',
    worldState: combatWorld({
      combatants: [
        { name: 'Mira', initiative: 18, hp: 8, max_hp: 8, ac: 12, is_player: true, conditions: [], position: { map_id: 'crypt', q: 0, r: 0 } },
        combatant('Skeleton', 8, { position: { map_id: 'crypt', q: 1, r: 0 } }),
      ],
    }),
    characterSheet: wizardSheet,
    destination,
    rollDie: sequenceRolls([12]),
  });
  const before = pending.worldState.combat_state.combatants.find((entry) => entry.is_player);
  const resolved = adjudicate({
    message: 'Cast Shield.',
    worldState: pending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([4]),
  });
  const after = resolved.worldState.combat_state.combatants.find((entry) => entry.is_player);

  assert.deepEqual(before.position, { map_id: 'crypt', q: 0, r: 0 });
  assert.deepEqual(after.position, destination);
  assert.equal(resolved.worldState.player_stats.last_movement.mode, 'hex');
});

test('declining an Opportunity Attack that drops the player stops movement before spending feet', () => {
  const state = combatWorld();
  state.player_stats.hp = 3;
  state.combat_state.combatants[0].hp = 3;
  const pending = adjudicate({
    message: 'I flee 10 feet away from the skeleton.',
    worldState: state,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([12]),
  });
  const resolved = adjudicate({
    message: 'Decline reaction.',
    worldState: pending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([4]),
  });

  assert.equal(resolved.worldState.player_stats.hp, 0);
  assert.equal(resolved.worldState.combat_state.turn_resources.movement_remaining, 30);
  assert.equal(resolved.worldState.player_stats.last_movement, undefined);
  assert.match(resolved.reply, /stops your movement before you leave reach/);
});

test('declining one Opportunity Attack can open a later Shield window without losing the original movement', () => {
  const state = combatWorld({
    combatants: [
      { name: 'Mira', initiative: 18, hp: 8, max_hp: 8, ac: 12, is_player: true, conditions: [] },
      combatant('Skeleton', 8),
      combatant('Cultist', 6),
    ],
  });
  const firstPending = adjudicate({
    message: 'I retreat 10 feet away.',
    worldState: state,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([12]),
  });
  const secondPending = adjudicate({
    message: 'Decline reaction.',
    worldState: firstPending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([2, 12]),
  });
  const resolved = adjudicate({
    message: 'Cast Shield.',
    worldState: secondPending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([4]),
  });

  assert.equal(secondPending.worldState.player_stats.hp, 5);
  assert.equal(secondPending.worldState.combat_state.turn_resources.movement_remaining, 30);
  assert.equal(secondPending.worldState.pending_reaction.resume.movement.feet, 10);
  assert.equal(resolved.worldState.player_stats.hp, 5);
  assert.equal(resolved.worldState.combat_state.turn_resources.movement_remaining, 20);
  assert.equal(resolved.worldState.player_stats.last_movement.feet, 10);
  assert.match(resolved.reply, /Cultist uses claw/);
  assert.match(resolved.reply, /You move 10 feet/);
});

test('damage from a declined Opportunity Attack still prompts concentration after resumed movement', () => {
  const state = combatWorld();
  state.active_effects = [{
    id: 'detect_magic',
    name: 'Detect Magic',
    concentration: true,
    remaining_rounds: 100,
  }];
  const pending = adjudicate({
    message: 'I retreat 10 feet away from the skeleton.',
    worldState: state,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([12]),
  });
  const resolved = adjudicate({
    message: 'Decline reaction.',
    worldState: pending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([2]),
  });

  assert.equal(resolved.worldState.player_stats.hp, 5);
  assert.equal(resolved.worldState.player_stats.last_movement.feet, 10);
  assert.equal(resolved.worldState.pending_roll.kind, 'concentration_save');
  assert.match(resolved.reply, /Concentration is at risk/);
});

test('Dash keeps its granted movement through a Shielded Opportunity Attack and spends distance once', () => {
  const state = combatWorld();
  state.combat_state.turn_resources = {
    actor: 'player',
    action_available: true,
    bonus_action_available: true,
    reaction_available: true,
    movement_remaining: 30,
    used: [],
  };
  const pending = adjudicate({
    message: 'I Dash and retreat 40 feet away from the skeleton.',
    worldState: state,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([12]),
  });
  const resolved = adjudicate({
    message: 'Cast Shield.',
    worldState: pending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([4]),
  });

  assert.equal(pending.worldState.combat_state.turn_resources.action_available, false);
  assert.equal(pending.worldState.combat_state.turn_resources.movement_remaining, 60);
  assert.equal(resolved.worldState.combat_state.turn_resources.movement_remaining, 20);
  assert.equal(resolved.worldState.player_stats.last_movement.feet, 40);
  assert.match(resolved.reply, /You move 40 feet/);
});

test('Hellish Rebuke opens after creature damage and resumes without replaying the triggering attack', () => {
  const pending = advanceEnemyTurns({
    worldState: warlockWorld(),
    characterSheet: warlockSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12, 3]),
  });
  const resolved = adjudicate({
    message: 'Cast Hellish Rebuke.',
    worldState: pending.worldState,
    characterSheet: warlockSheet,
    rollDie: sequenceRolls([2, 6, 7]),
  });
  const skeleton = resolved.worldState.combat_state.combatants.find((entry) => entry.name === 'Skeleton');

  assert.equal(pending.worldState.pending_reaction.trigger, 'damage_taken');
  assert.equal(pending.worldState.pending_reaction.resume.stage, 'after_attack');
  assert.equal(pending.worldState.player_stats.hp, 4);
  assert.equal(resolved.worldState.player_stats.hp, 4);
  assert.equal(resolved.worldState.player_stats.spell_slots[1], 0);
  assert.equal(skeleton.hp, 17);
  assert.match(resolved.reply, /Hellish Rebuke/);
  assert.match(resolved.reply, /Save fails/);
});

test('declining Hellish Rebuke continues the creature round without applying the same hit twice', () => {
  const pending = advanceEnemyTurns({
    worldState: warlockWorld(),
    characterSheet: warlockSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12, 3]),
  });
  const resolved = adjudicate({
    message: 'Decline reaction.',
    worldState: pending.worldState,
    characterSheet: warlockSheet,
  });

  assert.equal(resolved.worldState.player_stats.hp, 4);
  assert.equal(resolved.worldState.player_stats.spell_slots[1], 1);
  assert.match(resolved.reply, /decline the Reaction/);
});

test('Hellish Rebuke damages the creature that triggered it instead of the first enemy in initiative', () => {
  const pending = advanceEnemyTurns({
    worldState: warlockWorld({
      combatants: [
        { name: 'Vex', initiative: 18, hp: 8, max_hp: 8, ac: 12, is_player: true, conditions: [] },
        combatant('Skeleton', 8, { hp: 30, max_hp: 30 }),
        combatant('Cultist', 6, { hp: 30, max_hp: 30 }),
      ],
    }),
    characterSheet: warlockSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([1, 12, 3]),
  });
  const resolved = adjudicate({
    message: 'Use Hellish Rebuke.',
    worldState: pending.worldState,
    characterSheet: warlockSheet,
    rollDie: sequenceRolls([2, 6, 7]),
  });
  const skeleton = resolved.worldState.combat_state.combatants.find((entry) => entry.name === 'Skeleton');
  const cultist = resolved.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(pending.worldState.pending_reaction.source_actor.name, 'Cultist');
  assert.equal(skeleton.hp, 30);
  assert.equal(cultist.hp, 17);
});

test('Hellish Rebuke can interrupt an Opportunity Attack and movement resumes after retaliation', () => {
  const pending = adjudicate({
    message: 'I retreat 10 feet away from the skeleton.',
    worldState: warlockWorld(),
    characterSheet: warlockSheet,
    rollDie: sequenceRolls([12, 3]),
  });
  const resolved = adjudicate({
    message: 'Cast Hellish Rebuke.',
    worldState: pending.worldState,
    characterSheet: warlockSheet,
    rollDie: sequenceRolls([2, 6, 7]),
  });
  const skeleton = resolved.worldState.combat_state.combatants.find((entry) => entry.name === 'Skeleton');

  assert.equal(pending.worldState.pending_reaction.resume.type, 'combat_movement');
  assert.equal(pending.worldState.pending_reaction.resume.stage, 'after_attack');
  assert.equal(pending.worldState.player_stats.last_movement, undefined);
  assert.equal(resolved.worldState.player_stats.hp, 4);
  assert.equal(resolved.worldState.player_stats.last_movement.feet, 10);
  assert.equal(resolved.worldState.combat_state.turn_resources.movement_remaining, 20);
  assert.equal(skeleton.hp, 17);
  assert.match(resolved.reply, /You move 10 feet/);
});

test('Hellish Rebuke does not open a Reaction window without a remaining spell slot', () => {
  const world = warlockWorld({ slots: 0 });
  const resolved = advanceEnemyTurns({
    worldState: world,
    characterSheet: {
      ...warlockSheet,
      spellcasting: { ...warlockSheet.spellcasting, slots: { 1: 0 } },
    },
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12, 3]),
  });

  assert.equal(resolved.worldState.pending_reaction, null);
  assert.equal(resolved.worldState.player_stats.hp, 4);
  assert.match(resolved.reply, /Hit for 4 damage/);
});

test('Hellish Rebuke ending the last attacker also ends combat after the saved continuation resumes', () => {
  const pending = advanceEnemyTurns({
    worldState: warlockWorld({
      combatants: [
        { name: 'Vex', initiative: 18, hp: 8, max_hp: 8, ac: 12, is_player: true, conditions: [] },
        combatant('Skeleton', 8, { hp: 5, max_hp: 5 }),
      ],
    }),
    characterSheet: warlockSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12, 3]),
  });
  const resolved = adjudicate({
    message: 'Cast Hellish Rebuke.',
    worldState: pending.worldState,
    characterSheet: warlockSheet,
    rollDie: sequenceRolls([2, 6, 7]),
  });

  assert.equal(resolved.worldState.combat_state, null);
  assert.match(resolved.reply, /Combat ends/);
  assert.doesNotMatch(resolved.reply, /Round 2 begins/);
});

test('declining Shield can open a chained Hellish Rebuke window after the resumed hit', () => {
  const firstPending = advanceEnemyTurns({
    worldState: warlockWorld({ slots: 2 }),
    characterSheet: dualReactionSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12]),
  });
  const secondPending = adjudicate({
    message: 'Decline reaction.',
    worldState: firstPending.worldState,
    characterSheet: dualReactionSheet,
    rollDie: sequenceRolls([3]),
  });
  const resolved = adjudicate({
    message: 'Cast Hellish Rebuke.',
    worldState: secondPending.worldState,
    characterSheet: dualReactionSheet,
    rollDie: sequenceRolls([2, 6, 7]),
  });
  const skeleton = resolved.worldState.combat_state.combatants.find((entry) => entry.name === 'Skeleton');

  assert.equal(firstPending.worldState.pending_reaction.trigger, 'attack_hit');
  assert.equal(secondPending.worldState.pending_reaction.trigger, 'damage_taken');
  assert.equal(secondPending.worldState.player_stats.hp, 4);
  assert.equal(resolved.worldState.player_stats.hp, 4);
  assert.equal(resolved.worldState.player_stats.spell_slots[1], 1);
  assert.equal(skeleton.hp, 17);
});

test('Opportunity Attack movement survives chained Shield decline and Hellish Rebuke windows', () => {
  const firstPending = adjudicate({
    message: 'I retreat 10 feet away from the skeleton.',
    worldState: warlockWorld({ slots: 2 }),
    characterSheet: dualReactionSheet,
    rollDie: sequenceRolls([12]),
  });
  const secondPending = adjudicate({
    message: 'Decline reaction.',
    worldState: firstPending.worldState,
    characterSheet: dualReactionSheet,
    rollDie: sequenceRolls([3]),
  });
  const resolved = adjudicate({
    message: 'Cast Hellish Rebuke.',
    worldState: secondPending.worldState,
    characterSheet: dualReactionSheet,
    rollDie: sequenceRolls([2, 6, 7]),
  });

  assert.equal(firstPending.worldState.pending_reaction.trigger, 'attack_hit');
  assert.equal(secondPending.worldState.pending_reaction.trigger, 'damage_taken');
  assert.equal(secondPending.worldState.player_stats.last_movement, undefined);
  assert.equal(resolved.worldState.player_stats.hp, 4);
  assert.equal(resolved.worldState.player_stats.last_movement.feet, 10);
  assert.equal(resolved.worldState.combat_state.turn_resources.movement_remaining, 20);
});

test('Hellish Rebuke deals half damage when the triggering creature succeeds on its Dexterity save', () => {
  const pending = advanceEnemyTurns({
    worldState: warlockWorld(),
    characterSheet: warlockSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12, 3]),
  });
  const resolved = adjudicate({
    message: 'Cast Hellish Rebuke.',
    worldState: pending.worldState,
    characterSheet: warlockSheet,
    rollDie: sequenceRolls([20, 6, 7]),
  });
  const skeleton = resolved.worldState.combat_state.combatants.find((entry) => entry.name === 'Skeleton');

  assert.equal(skeleton.hp, 24);
  assert.match(resolved.reply, /Save succeeds/);
  assert.match(resolved.reply, /6 fire damage/);
});

test('Hellish Rebuke requires a visible triggering creature within 60 feet', () => {
  const player = { name: 'Vex', initiative: 18, hp: 8, max_hp: 8, ac: 12, is_player: true, conditions: [], position: { map_id: 'road', q: 0, r: 0 } };
  const distant = advanceEnemyTurns({
    worldState: warlockWorld({
      combatants: [
        player,
        combatant('Distant Archer', 8, {
          hp: 30,
          max_hp: 30,
          position: { map_id: 'road', q: 13, r: 0 },
          attack: { name: 'shortbow shot', attack_kind: 'ranged', attack_bonus: 3, damage_formula: '1d4+1' },
        }),
      ],
    }),
    characterSheet: warlockSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12, 3]),
  });
  const hidden = advanceEnemyTurns({
    worldState: warlockWorld({
      combatants: [
        player,
        combatant('Hidden Archer', 8, { hp: 30, max_hp: 30, visible: false }),
      ],
    }),
    characterSheet: warlockSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12, 3]),
  });

  assert.equal(distant.worldState.pending_reaction, null);
  assert.equal(hidden.worldState.pending_reaction, null);
  assert.equal(distant.worldState.player_stats.hp, 4);
  assert.equal(hidden.worldState.player_stats.hp, 4);
});

test('a creature leaving player reach opens an Opportunity Attack before movement completes', () => {
  const pending = advanceEnemyTurns({
    worldState: fighterWorld(),
    characterSheet: fighterSheet,
    playerTurnNote: 'You end your turn.',
  });
  const before = pending.worldState.combat_state.combatants.find((entry) => entry.name === 'Skeleton');
  const resolved = adjudicate({
    message: 'Opportunity attack.',
    worldState: pending.worldState,
    characterSheet: fighterSheet,
    rollDie: sequenceRolls([10, 4]),
  });
  const after = resolved.worldState.combat_state.combatants.find((entry) => entry.name === 'Skeleton');

  assert.equal(pending.worldState.pending_reaction.trigger, 'creature_leaves_reach');
  assert.equal(pending.worldState.pending_reaction.resume.stage, 'before_movement');
  assert.deepEqual(before.position, { map_id: 'road', q: 1, r: 0 });
  assert.equal(after.hp, 1);
  assert.deepEqual(after.position, { map_id: 'road', q: 7, r: 0 });
  assert.equal(resolved.worldState.combat_state.round, 2);
  assert.equal(resolved.worldState.combat_state.turn_resources.reaction_available, true);
  assert.match(resolved.reply, /Opportunity Attack/);
  assert.match(resolved.reply, /Hit for 7 damage/);
  assert.match(resolved.reply, /Skeleton moves 30 feet to hex \(7, 0\)/);
});

test('Blind Fighting applies to player Opportunity Attacks against nearby unseen targets', () => {
  const blindFighter = {
    ...fighterSheet,
    class_choices: { fighting_style: 'blind_fighting' },
  };
  const pending = advanceEnemyTurns({
    worldState: fighterWorld({
      combatants: [
        { name: 'Bran', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: ['blinded'], position: { map_id: 'road', q: 0, r: 0 } },
        combatant('Skeleton', 8, {
          hp: 8,
          max_hp: 8,
          behavior: 'fleeing',
          speed: 30,
          conditions: ['invisible', 'hidden'],
          position: { map_id: 'road', q: 1, r: 0 },
        }),
      ],
    }),
    characterSheet: blindFighter,
    playerTurnNote: 'You end your turn.',
  });
  const resolved = adjudicate({
    message: 'Opportunity attack.',
    worldState: pending.worldState,
    characterSheet: blindFighter,
    rollDie: sequenceRolls([9, 2, 2]),
  });
  const skeleton = resolved.worldState.combat_state.combatants.find((entry) => entry.name === 'Skeleton');

  assert.equal(skeleton.hp, 3);
  assert.match(resolved.reply, /Blind Fighting lets you treat that sight-blocking target within 10 feet as seen/);
  assert.doesNotMatch(resolved.reply, /Opportunity Attack has disadvantage/);
  assert.match(resolved.reply, /Attack roll: 14 \(natural 9; 9\+5=14\) vs AC 12/);
});

test('declining a creature movement Reaction lets the original movement continue without an attack', () => {
  const pending = advanceEnemyTurns({
    worldState: fighterWorld(),
    characterSheet: fighterSheet,
    playerTurnNote: 'You end your turn.',
  });
  const resolved = adjudicate({
    message: 'Decline reaction.',
    worldState: pending.worldState,
    characterSheet: fighterSheet,
  });
  const skeleton = resolved.worldState.combat_state.combatants.find((entry) => entry.name === 'Skeleton');

  assert.equal(skeleton.hp, 8);
  assert.deepEqual(skeleton.position, { map_id: 'road', q: 7, r: 0 });
  assert.match(resolved.reply, /decline the Reaction/);
  assert.doesNotMatch(resolved.reply, /Hit for/);
});

test('an Opportunity Attack that drops the moving creature stops its movement and can end combat', () => {
  const pending = advanceEnemyTurns({
    worldState: fighterWorld({
      combatants: [
        { name: 'Bran', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [], position: { map_id: 'road', q: 0, r: 0 } },
        combatant('Skeleton', 8, {
          hp: 6,
          max_hp: 6,
          behavior: 'fleeing',
          speed: 30,
          position: { map_id: 'road', q: 1, r: 0 },
        }),
      ],
    }),
    characterSheet: fighterSheet,
    playerTurnNote: 'You end your turn.',
  });
  const resolved = adjudicate({
    message: 'Make Opportunity Attack.',
    worldState: pending.worldState,
    characterSheet: fighterSheet,
    rollDie: sequenceRolls([10, 4]),
  });

  assert.equal(resolved.worldState.combat_state, null);
  assert.match(resolved.reply, /falls before leaving your reach/);
  assert.match(resolved.reply, /Combat ends/);
  assert.doesNotMatch(resolved.reply, /Skeleton moves 30 feet/);
});

test('a creature that Disengages before leaving reach does not open an Opportunity Attack', () => {
  const result = advanceEnemyTurns({
    worldState: fighterWorld({
      combatants: [
        { name: 'Bran', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [], position: { map_id: 'road', q: 0, r: 0 } },
        combatant('Skeleton', 8, {
          hp: 8,
          max_hp: 8,
          movement_plan: { direction: 'away', feet: 30, disengage: true, reason: 'disengage and retreat' },
          position: { map_id: 'road', q: 1, r: 0 },
        }),
      ],
    }),
    characterSheet: fighterSheet,
    playerTurnNote: 'You end your turn.',
  });
  const skeleton = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Skeleton');

  assert.equal(result.worldState.pending_reaction, null);
  assert.deepEqual(skeleton.position, { map_id: 'road', q: 7, r: 0 });
  assert.match(result.reply, /Disengage/);
});

test('a melee creature outside reach moves toward the player before attacking', () => {
  const result = advanceEnemyTurns({
    worldState: fighterWorld({
      combatants: [
        { name: 'Bran', initiative: 18, hp: 12, max_hp: 12, ac: 12, is_player: true, conditions: [], position: { map_id: 'road', q: 0, r: 0 } },
        combatant('Skeleton', 8, {
          hp: 8,
          max_hp: 8,
          speed: 10,
          position: { map_id: 'road', q: 3, r: 0 },
        }),
      ],
    }),
    characterSheet: fighterSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([17, 2]),
  });
  const skeleton = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Skeleton');

  assert.deepEqual(skeleton.position, { map_id: 'road', q: 1, r: 0 });
  assert.equal(result.worldState.player_stats.hp, 9);
  assert.match(result.reply, /Skeleton moves 10 feet to hex \(1, 0\)/);
  assert.match(result.reply, /Skeleton uses claw/);
});

test('College of Lore Cutting Words spends its Reaction and Bardic Inspiration to reduce a hit', () => {
  const bard = {
    identity: { name: 'Lyra', class: 'bard', level: 3, subclass: 'college_of_lore' },
    abilities: { modifiers: { cha: 3 } },
    derived_stats: { armor_class: 12 },
    resources: { bardic_inspiration: { name: 'Bardic Inspiration', remaining: 2, max: 3, reset: 'long_rest', die: '1d6' } },
  };
  const world = combatWorld();
  const options = getReactionOptions({ trigger: 'attack_hit', worldState: world, characterSheet: bard, context: { actor: combatant('Goblin', 8), attack: { name: 'blade' } } });
  const pending = {
    id: 'reaction_cutting', kind: 'player_reaction', trigger: 'attack_hit', trigger_label: 'Goblin blade', trigger_prompt: 'Goblin would hit.', resume_stage: 'before_attack',
    options, attack_frame: { attack_total: 14, roll_text: '11+3', critical_hit: false },
  };
  const result = resolvePendingReactionChoice({ message: 'I use Cutting Words.', worldState: { ...world, pending_reaction: pending }, characterSheet: bard, rollDie: sequenceRolls([4]) });

  assert.equal(result.resolved, true);
  assert.equal(result.pendingReaction.attack_frame.attack_total, 10);
  assert.equal(result.worldState.player_stats.resources.bardic_inspiration.remaining, 1);
  assert.equal(result.worldState.combat_state.turn_resources.reaction_available, false);
});

test('College of Lore Cutting Words can reduce a creature damage roll', () => {
  const bard = {
    identity: { name: 'Lyra', class: 'bard', level: 3, subclass: 'college_of_lore' },
    abilities: { modifiers: { cha: 3 } },
    derived_stats: { armor_class: 12, max_hp: 12 },
    resources: { bardic_inspiration: { name: 'Bardic Inspiration', remaining: 2, max: 3, reset: 'long_rest', die: '1d6' } },
  };
  const world = combatWorld();
  world.player_stats.hp = 5;
  world.player_stats.max_hp = 12;
  world.combat_state.combatants[0].hp = 5;
  world.combat_state.combatants[0].max_hp = 12;
  const options = getReactionOptions({ trigger: 'damage_taken', worldState: world, characterSheet: bard, context: { actor: combatant('Goblin', 8), attack: { name: 'blade' }, damageTaken: 6 } });
  const pending = {
    id: 'reaction_cutting_damage', kind: 'player_reaction', trigger: 'damage_taken', trigger_label: 'Goblin blade', trigger_prompt: 'Goblin dealt 6 damage.', resume_stage: 'after_attack',
    options, damage_frame: { damage_taken: 6, attack: { name: 'blade' } },
  };
  const result = resolvePendingReactionChoice({ message: 'I use Cutting Words on the damage.', worldState: { ...world, pending_reaction: pending }, characterSheet: bard, rollDie: sequenceRolls([4]) });

  assert.equal(result.resolved, true);
  assert.equal(result.worldState.player_stats.hp, 9);
  assert.equal(result.worldState.combat_state.combatants[0].hp, 9);
  assert.equal(result.worldState.player_stats.resources.bardic_inspiration.remaining, 1);
  assert.match(result.reply, /reducing the damage by 4/);
});

test('Monk Deflect Attacks restores prevented damage and spends the Reaction', () => {
  const monk = {
    identity: { name: 'Kai', class: 'monk', level: 3, subclass: 'warrior_of_the_open_hand' },
    abilities: { modifiers: { dex: 3, wis: 3 } },
    derived_stats: { armor_class: 16 },
    resources: { focus_points: { name: 'Focus Points', remaining: 3, max: 3, reset: 'short_rest' } },
  };
  const world = combatWorld();
  world.player_stats.hp = 3;
  world.combat_state.combatants[0].hp = 3;
  const options = getReactionOptions({ trigger: 'damage_taken', worldState: world, characterSheet: monk, context: { actor: combatant('Goblin', 8), attack: { name: 'blade', damage_type: 'slashing' }, damageTaken: 5 } });
  const pending = {
    id: 'reaction_deflect', kind: 'player_reaction', trigger: 'damage_taken', trigger_label: 'Goblin blade', trigger_prompt: 'Goblin dealt 5 damage.', resume_stage: 'after_attack',
    options, damage_frame: { damage_taken: 5, attack: { name: 'blade', damage_type: 'slashing' } },
  };
  const result = resolvePendingReactionChoice({ message: 'I use Deflect Attacks.', worldState: { ...world, pending_reaction: pending }, characterSheet: monk, rollDie: sequenceRolls([2]) });

  assert.equal(result.resolved, true);
  assert.equal(result.worldState.player_stats.hp, 8);
  assert.equal(result.worldState.combat_state.turn_resources.reaction_available, false);
});

test('Monk Deflect Attacks can spend Focus to damage the original attacker after reducing damage to zero', () => {
  const monk = {
    identity: { name: 'Kai', class: 'monk', level: 3, subclass: 'warrior_of_the_open_hand' },
    abilities: { modifiers: { dex: 3, wis: 3 } },
    derived_stats: { armor_class: 16, proficiency_bonus: 2, martial_arts_die: '1d6' },
    resources: { focus_points: { name: 'Focus Points', remaining: 3, max: 3, reset: 'short_rest' } },
  };
  const world = combatWorld();
  world.player_stats.hp = 3;
  world.combat_state.combatants[0].hp = 3;
  const goblin = world.combat_state.combatants.find((entry) => !entry.is_player);
  goblin.id = 'goblin-1';
  goblin.hp = 8;
  goblin.max_hp = 8;
  goblin.saves = { dex: 0 };
  const options = getReactionOptions({ trigger: 'damage_taken', worldState: world, characterSheet: monk, context: { actor: goblin, attack: { name: 'blade', damage_type: 'slashing' }, damageTaken: 5 } });
  const pending = {
    id: 'reaction_deflect_redirect', kind: 'player_reaction', trigger: 'damage_taken', trigger_label: 'Goblin blade', trigger_prompt: 'Goblin dealt 5 damage.', resume_stage: 'after_attack',
    source_actor: { id: 'goblin-1', name: 'Goblin' }, options,
    damage_frame: { damage_taken: 5, attack: { name: 'blade', damage_type: 'slashing' } },
  };
  const result = resolvePendingReactionChoice({
    message: 'I use Deflect Attacks and redirect it at the Goblin.',
    worldState: { ...world, pending_reaction: pending },
    characterSheet: monk,
    rollDie: sequenceRolls([2, 1, 4, 5]),
  });

  assert.equal(result.resolved, true);
  assert.equal(result.worldState.player_stats.resources.focus_points.remaining, 2);
  assert.equal(result.worldState.combat_state.combatants.find((entry) => entry.id === 'goblin-1').hp, 0);
  assert.match(result.reply, /fails its DEX save.*takes 12 damage/);
});

test('level 5 Rogue Uncanny Dodge halves one visible attack damage with its Reaction', () => {
  const rogue = {
    identity: { name: 'Shade', class: 'rogue', level: 5, subclass: 'thief' },
    abilities: { modifiers: { dex: 4 } },
    derived_stats: { armor_class: 15, max_hp: 30 },
  };
  const world = combatWorld();
  world.player_stats.hp = 18;
  world.player_stats.max_hp = 30;
  world.combat_state.combatants[0].hp = 18;
  world.combat_state.combatants[0].max_hp = 30;
  const goblin = world.combat_state.combatants.find((entry) => !entry.is_player);
  const options = getReactionOptions({ trigger: 'damage_taken', worldState: world, characterSheet: rogue, context: { actor: goblin, attack: { name: 'blade' }, damageTaken: 7 } });
  const pending = {
    id: 'reaction_uncanny_dodge', kind: 'player_reaction', trigger: 'damage_taken', trigger_label: 'Goblin blade', trigger_prompt: 'Goblin dealt 7 damage.', resume_stage: 'after_attack',
    options, damage_frame: { damage_taken: 7, attack: { name: 'blade' } },
  };
  const result = resolvePendingReactionChoice({ message: 'I use Uncanny Dodge.', worldState: { ...world, pending_reaction: pending }, characterSheet: rogue });

  assert.equal(result.resolved, true);
  assert.equal(result.worldState.player_stats.hp, 22);
  assert.equal(result.worldState.combat_state.combatants[0].hp, 22);
  assert.equal(result.worldState.combat_state.turn_resources.reaction_available, false);
  assert.match(result.reply, /from 7 to 3/);
});
