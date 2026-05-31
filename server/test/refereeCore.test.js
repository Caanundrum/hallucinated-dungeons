process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { adjudicate, advanceEnemyTurns, advanceNarrativeTime } = require('../src/refereeCore');

const characterSheet = {
  identity: { name: 'Sir Testalot', level: 1 },
  abilities: {
    modifiers: { str: 3, dex: 1, wis: 2, cha: 1 },
  },
  derived_stats: {
    hp: 12,
    max_hp: 12,
    armor_class: 16,
    initiative: 1,
    skill_modifiers: {
      insight: { total: 4, ability: 'wis', proficient: true },
      stealth: { total: 3, ability: 'dex', proficient: true },
    },
    saving_throw_modifiers: {
      con: { total: 2, proficient: false },
      dex: { total: 3, proficient: true },
      wis: { total: 2, proficient: false },
    },
    attack_breakdowns: [
      { name: 'Longsword', attack_total: 5, damage_formula: '1d8+3' },
    ],
  },
};

function worldState(overrides = {}) {
  return {
    current_location: 'Morrowgate',
    scene_presence: {
      exact_location: 'town hall steps',
      present_npcs: ['clerk', 'guard'],
      present_objects: [],
      available_exits: ['square'],
    },
    player_stats: {
      hp: 12,
      max_hp: 12,
      armor_class: 16,
    },
    pending_roll: null,
    combat_state: null,
    ...overrides,
  };
}

function sequenceRolls(values) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 10;
}

test('creates a server-owned pending skill check with a DC', () => {
  const result = adjudicate({
    message: "I study the clerk's face.",
    worldState: worldState(),
    characterSheet,
    currentTurn: 4,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.kind, 'skill_check');
  assert.equal(result.worldState.pending_roll.dc, 15);
  assert.equal(result.worldState.pending_roll.created_turn, 4);
  assert.match(result.reply, /DC 15 Wisdom \(Insight\)/);
  assert.match(result.reply, /\[CHECK: id=.*skill=insight ability=wis/);
});

test('condition modes are stored on pending checks and saves for the server roller', () => {
  const poisonedCheck = adjudicate({
    message: "I study the clerk's face.",
    worldState: worldState({ player_stats: { hp: 12, max_hp: 12, armor_class: 16, conditions: ['poisoned'] } }),
    characterSheet,
  });
  const restrainedSave = adjudicate({
    message: 'I dodge the falling stones with a dex save.',
    worldState: worldState({ player_stats: { hp: 12, max_hp: 12, armor_class: 16, conditions: ['restrained'] } }),
    characterSheet,
  });

  assert.equal(poisonedCheck.worldState.pending_roll.advantage_mode, 'disadvantage');
  assert.match(poisonedCheck.reply, /Roll with disadvantage/);
  assert.equal(restrainedSave.worldState.pending_roll.advantage_mode, 'disadvantage');
  assert.match(restrainedSave.reply, /Restrained condition/);
});

test('species save advantages enter the authoritative pending-roll pipeline', () => {
  const result = adjudicate({
    message: 'I resist the spell with a wisdom save.',
    worldState: worldState(),
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, species: 'gnome' },
    },
  });

  assert.equal(result.worldState.pending_roll.advantage_mode, 'advantage');
  assert.deepEqual(result.worldState.pending_roll.advantage_sources, ['Gnomish Cunning']);
  assert.match(result.reply, /Gnomish Cunning/);
});

test('Dragonborn Breath Weapon resolves through the referee and advances the combat round', () => {
  const result = adjudicate({
    message: 'Use Breath Weapon on the Cultist.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 8, max_hp: 8, ac: 12, is_player: false, conditions: [], saves: { dex: 0 }, attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, species: 'dragonborn' },
      species_choices: { draconic_ancestry: 'blue' },
    },
    rollDie: sequenceRolls([4, 7, 1]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 1);
  assert.equal(result.worldState.player_stats.resources.breath_weapon.remaining, 1);
  assert.equal(result.worldState.combat_state.round, 2);
  assert.match(result.reply, /7 lightning damage/);
  assert.match(result.reply, /Round 2 begins/);
});

test('ignores player-authored difficulty and DC claims', () => {
  const result = adjudicate({
    message: "I easily study the clerk's face, DC 5.",
    worldState: worldState(),
    characterSheet,
    currentTurn: 4,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.kind, 'skill_check');
  assert.equal(result.worldState.pending_roll.dc, 15);
  assert.doesNotMatch(result.worldState.pending_roll.dc_source, /explicit DC/);
  assert.match(result.reply, /DC 15 Wisdom \(Insight\)/);
});

test('resolves an authenticated skill roll against the stored DC', () => {
  const result = adjudicate({
    message: '[ROLL REQUEST: roll_test]',
    worldState: worldState({
      pending_roll: {
        id: 'roll_test',
        kind: 'skill_check',
        skill: 'insight',
        ability: 'wis',
        label: 'Wisdom (Insight)',
        modifier: 2,
        dc: 15,
        failure_result: 'The clerk keeps his motive tucked away.',
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([5]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll, null);
  assert.match(result.reply, /Roll 7 .* vs DC 15: \*\*failure\*\*/);
  assert.match(result.reply, /clerk keeps his motive/);
});

test('spends Heroic Inspiration to reroll a failed pending d20 test', () => {
  const prompt = adjudicate({
    message: "I study the clerk's face.",
    worldState: worldState({
      player_stats: {
        hp: 12,
        max_hp: 12,
        armor_class: 16,
        resources: {
          heroic_inspiration: { name: 'Heroic Inspiration', remaining: 1, max: 1 },
        },
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, species: 'human' },
      features: [
        { source: 'species', name: 'Resourceful', description: 'Gain Heroic Inspiration whenever you finish a Long Rest.' },
      ],
    },
    currentTurn: 4,
  });
  const primed = adjudicate({
    message: 'Use heroic inspiration.',
    worldState: prompt.worldState,
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, species: 'human' },
      features: [
        { source: 'species', name: 'Resourceful', description: 'Gain Heroic Inspiration whenever you finish a Long Rest.' },
      ],
    },
  });
  const result = adjudicate({
    message: `[ROLL REQUEST: ${primed.worldState.pending_roll.id}]`,
    worldState: primed.worldState,
    characterSheet,
    rollDie: sequenceRolls([4, 16]),
  });

  assert.equal(primed.worldState.player_stats.resources.heroic_inspiration.remaining, 0);
  assert.equal(result.handled, true);
  assert.match(result.reply, /Heroic Inspiration reroll 4->16/);
  assert.match(result.reply, /\*\*success\*\*/);
});

test('Halfling Luck automatically rerolls a natural 1 on a pending d20 test', () => {
  const prompt = adjudicate({
    message: "I study the clerk's face.",
    worldState: worldState(),
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, species: 'halfling' },
    },
    currentTurn: 4,
  });
  const result = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet,
    rollDie: sequenceRolls([1, 14]),
  });

  assert.equal(result.handled, true);
  assert.match(result.reply, /Halfling Luck rerolled 1->14/);
  assert.match(result.reply, /\*\*success\*\*/);
});

test('blocks new actions until a pending roll is resolved', () => {
  const result = adjudicate({
    message: 'I attack the goblin instead.',
    worldState: worldState({
      pending_roll: {
        kind: 'skill_check',
        skill: 'insight',
        ability: 'wis',
        label: 'Wisdom (Insight)',
        formula: '1d20+4',
        dc: 15,
      },
    }),
    characterSheet,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.kind, 'skill_check');
  assert.match(result.reply, /Resolve the pending Wisdom \(Insight\)/);
  assert.match(result.reply, /\[CHECK: skill=insight ability=wis/);
});

test('clears stale combat with no living enemies before prompting checks', () => {
  const result = adjudicate({
    message: "I study the injured lantern-figure's face.",
    worldState: worldState({
      combat_state: {
        active: true,
        round: 2,
        turn_index: 0,
        combatants: [
          { name: 'Old Fighter', hp: 14, max_hp: 14, ac: 18, is_player: true },
          { name: 'Unknown lantern-figure', hp: 0, max_hp: 8, ac: 10, is_player: false },
        ],
      },
    }),
    characterSheet,
    currentTurn: 9,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.combat_state, null);
  assert.equal(result.worldState.pending_roll.kind, 'skill_check');
  assert.equal(result.worldState.pending_roll.combat, false);
  assert.match(result.reply, /Wisdom \(Insight\)/);
});

test('maps declared rule actions to the required check instead of asking the DM to improvise', () => {
  const result = adjudicate({
    message: 'I take the Hide action.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet,
    currentTurn: 5,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.skill, 'stealth');
  assert.equal(result.worldState.pending_roll.modifier, 3);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, false);
  assert.match(result.reply, /Dexterity \(Stealth\)/);
});

test('prompts deterministic saving throws with character save modifiers', () => {
  const result = adjudicate({
    message: 'I dive away from the falling rocks.',
    worldState: worldState(),
    characterSheet,
    currentTurn: 6,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.kind, 'saving_throw');
  assert.equal(result.worldState.pending_roll.ability, 'dex');
  assert.equal(result.worldState.pending_roll.modifier, 3);
  assert.match(result.reply, /DC 15 Dexterity Saving Throw/);
  assert.match(result.reply, /\[SAVE: id=.*ability=dex/);
});

test('prompts a social check for speeches meant to change minds', () => {
  const result = adjudicate({
    message: 'I give a speech to convince the frightened guards to hold the gate.',
    worldState: worldState(),
    characterSheet,
    currentTurn: 7,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.skill, 'persuasion');
  assert.equal(result.worldState.pending_roll.modifier, 1);
  assert.match(result.reply, /Charisma \(Persuasion\)/);
});

test('combat saving throws do not consume the player action or advance enemy turns', () => {
  const prompt = adjudicate({
    message: 'I dive away from the falling rocks.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet,
    currentTurn: 6,
  });
  const result = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet,
    rollDie: sequenceRolls([9]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll, null);
  assert.equal(result.worldState.combat_state.round, 1);
  assert.doesNotMatch(result.reply, /Goblin uses/);
  assert.match(result.reply, /Dexterity Saving Throw 12 .* vs DC 15: \*\*failure\*\*/);
});

test('starts combat by asking for initiative instead of narrating a free attack', () => {
  const result = adjudicate({
    message: 'I attack the hooded stranger.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'town gate',
        present_npcs: ['hooded stranger'],
        present_objects: ['muddy road'],
      },
    }),
    characterSheet,
    currentTurn: 8,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.kind, 'initiative');
  assert.equal(result.worldState.pending_roll.created_turn, 8);
  assert.match(result.reply, /Combat begins/);
  assert.match(result.reply, /\[ROLL: id=.* 1d20\+1\]/);
});

test('starts unarmed combat without folding a Tavern Brawler push rider into the target name', () => {
  const result = adjudicate({
    message: 'Punch the cultist and push him back.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'town square',
        present_npcs: ['cultist'],
        present_objects: [],
        available_exits: ['gate'],
      },
    }),
    characterSheet: {
      ...characterSheet,
      origin: { background_feat: 'tavern_brawler' },
    },
  });

  assert.equal(result.worldState.pending_roll.kind, 'initiative');
  assert.equal(result.worldState.pending_roll.enemy.name, 'Cultist');
});

test('combat starter preserves explicit hostile target instead of falling back to scene NPCs', () => {
  const result = adjudicate({
    message: 'I draw my longsword and attack a hostile shadow emerging from the tree line.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'inn overhang',
        present_npcs: ['sealed-parchment guards (2)', 'reeve', 'hostile shadow'],
        present_objects: ['sealed parchment'],
        available_exits: ['tree line'],
      },
    }),
    characterSheet,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.enemy.name, 'Hostile Shadow');
});

test('blocks combat against absent service NPCs before initiative starts', () => {
  const result = adjudicate({
    message: 'I attack the innkeeper.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'Morrowgate town gate',
        present_npcs: ['older gate guard', 'younger gate guard'],
        present_objects: ['palisade gate'],
      },
    }),
    characterSheet,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll, null);
  assert.match(result.reply, /innkeeper is not here/);
});

test('uses person-friendly wording for absent combat targets near a matching location', () => {
  const result = adjudicate({
    message: 'I attack the innkeeper.',
    worldState: worldState({
      scene_presence: {
        exact_location: "Mason's Rest, tavern eaves and square entrance",
        location_type: 'tavern exterior',
        present_npcs: ['ink-stained man'],
        present_objects: ['tavern door'],
      },
    }),
    characterSheet,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll, null);
  assert.match(result.reply, /innkeeper is not here/);
  assert.match(result.reply, /look for them/);
  assert.doesNotMatch(result.reply, /look around for it/);
});

test('blocks invented hostile targets that are not established in the scene', () => {
  const result = adjudicate({
    message: 'I attack a hostile shadow emerging from the tree line.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'Morrowgate town gate',
        present_npcs: ['older gate guard', 'younger gate guard'],
        present_objects: ['palisade gate'],
        available_exits: ['tree line'],
      },
    }),
    characterSheet,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll, null);
  assert.match(result.reply, /hostile shadow is not here/);
});

test('drawing a weapon alone does not conjure combat', () => {
  const result = adjudicate({
    message: 'I draw my longsword.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'Morrowgate town gate',
        present_npcs: ['older gate guard', 'younger gate guard'],
        present_objects: ['palisade gate'],
      },
    }),
    characterSheet,
  });

  assert.equal(result, null);
});

test('keeps round 1 when enemies beat player initiative and act first', () => {
  const result = adjudicate({
    message: '[ROLL REQUEST: roll_init]',
    worldState: worldState({
      pending_roll: {
        id: 'roll_init',
        kind: 'initiative',
        modifier: 1,
        enemy: { name: 'Bandit', initiative_bonus: 1 },
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([11, 18, 8]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll, null);
  assert.equal(result.worldState.combat_state.active, true);
  assert.equal(result.worldState.combat_state.round, 1);
  assert.match(result.reply, /Bandit moves first/);
  assert.match(result.reply, /Round 1 begins\. It is your turn/);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, true);
});

test('initializes action economy when the player wins initiative', () => {
  const result = adjudicate({
    message: '[ROLL REQUEST: roll_init]',
    worldState: worldState({
      pending_roll: {
        id: 'roll_init',
        kind: 'initiative',
        modifier: 1,
        enemy: { name: 'Bandit', initiative_bonus: 1 },
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([19, 2]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.combat_state.round, 1);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, true);
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, true);
  assert.equal(result.worldState.combat_state.turn_resources.reaction_available, true);
});

test('natural 1 on an attack is an automatic miss even with a high bonus', () => {
  const result = adjudicate({
    message: 'I attack the goblin.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false, attack: { name: 'scimitar', attack_bonus: 3, damage_formula: '1d6+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { name: 'Very Convincing Sword', attack_total: 99, damage_formula: '1d8+3' },
        ],
      },
    },
    rollDie: sequenceRolls([1, 5]),
  });

  const goblin = result.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Goblin');
  assert.equal(result.handled, true);
  assert.equal(goblin.hp, 8);
  assert.match(result.reply, /Critical miss/);
});

test('blocks free exploration movement while combat is active', () => {
  const result = adjudicate({
    message: 'I leave the fight and go into the forest.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Wolf', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet,
  });

  assert.equal(result.handled, true);
  assert.match(result.reply, /Combat is still active/);
  assert.match(result.reply, /cannot slip into free exploration/);
});

test('combat skill checks spend the player action until the roll resolves', () => {
  const result = adjudicate({
    message: "I study the goblin's face.",
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet,
    currentTurn: 10,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.kind, 'skill_check');
  assert.equal(result.worldState.combat_state.turn_resources.action_available, false);
  assert.match(result.reply, /uses your Action/);
});

test('blocks a second action in the same combat turn', () => {
  const result = adjudicate({
    message: 'I attack the goblin.',
    worldState: worldState({
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
          used: [{ resource: 'action', label: 'Hide' }],
        },
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.combat_state.round, 1);
  assert.match(result.reply, /Action is already spent/);
});

test('shove is handled as an Attack action option with target save', () => {
  const result = adjudicate({
    message: 'I try to shove the hostile wolf away from the reeve with my shield.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 2,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Hostile Guard', hp: 11, max_hp: 11, ac: 14, is_player: false, saves: { str: 3, dex: 1 } },
          { name: 'Hostile Wolf', hp: 5, max_hp: 8, ac: 12, is_player: false, saves: { str: 0, dex: 1 } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      derived_stats: {
        ...characterSheet.derived_stats,
        proficiency_bonus: 2,
      },
    },
    rollDie: sequenceRolls([4, 2, 2]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, true);
  assert.match(result.reply, /Shove/);
  assert.match(result.reply, /against Hostile Wolf/);
  assert.match(result.reply, /DEX save: 4\+1 = 5 vs DC 13/);
  assert.match(result.reply, /Hostile Wolf is shoved 5 feet/);
  assert.match(result.reply, /Hostile Wolf uses attack/);
});

test('shove can knock a target prone and affect its next attack', () => {
  const result = adjudicate({
    message: 'I shove the goblin prone.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false, saves: { str: 0, dex: 0 } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      derived_stats: {
        ...characterSheet.derived_stats,
        proficiency_bonus: 2,
      },
    },
    rollDie: sequenceRolls([3, 12, 6]),
  });

  const goblin = result.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Goblin');
  assert.equal(result.handled, true);
  assert.equal(goblin.conditions.includes('prone'), true);
  assert.match(result.reply, /knocked \*\*prone\*\*/);
  assert.match(result.reply, /disadvantage: Prone on attacker/);
});

test('grapple is handled as an Attack action option and tracks escape DC', () => {
  const result = adjudicate({
    message: 'I grab the cultist before he can run.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Cultist', hp: 7, max_hp: 7, ac: 12, is_player: false, saves: { str: 0, dex: 1 } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      derived_stats: {
        ...characterSheet.derived_stats,
        proficiency_bonus: 2,
      },
    },
    rollDie: sequenceRolls([4, 2]),
  });

  const cultist = result.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Cultist');
  assert.equal(result.handled, true);
  assert.equal(cultist.conditions.includes('grappled'), true);
  assert.equal(cultist.grapple_escape_dc, 13);
  assert.match(result.reply, /Grapple/);
  assert.match(result.reply, /DEX save: 4\+1 = 5 vs DC 13/);
});

test('prompts death saves at 0 HP and applies natural 1 as two failures', () => {
  const prompt = adjudicate({
    message: 'I try to crawl away.',
    worldState: worldState({
      player_stats: {
        hp: 0,
        max_hp: 12,
        armor_class: 16,
        death_saves: { successes: 0, failures: 0 },
      },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 0, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet,
    currentTurn: 12,
  });
  const result = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet,
    rollDie: sequenceRolls([1, 10]),
  });

  assert.equal(prompt.worldState.pending_roll.kind, 'death_save');
  assert.equal(result.worldState.player_stats.death_saves.failures, 2);
  assert.equal(result.worldState.combat_state.round, 2);
  assert.match(result.reply, /Natural 1 counts as two failures/);
});

test('natural 20 on a death save restores 1 HP and clears death saves', () => {
  const result = adjudicate({
    message: '[ROLL REQUEST: death_roll]',
    worldState: worldState({
      player_stats: {
        hp: 0,
        max_hp: 12,
        armor_class: 16,
        death_saves: { successes: 0, failures: 2 },
      },
      pending_roll: {
        id: 'death_roll',
        kind: 'death_save',
      },
      combat_state: {
        active: true,
        round: 3,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 0, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([20]),
  });

  assert.equal(result.worldState.player_stats.hp, 1);
  assert.deepEqual(result.worldState.player_stats.death_saves, { successes: 0, failures: 0 });
  assert.equal(result.worldState.combat_state.combatants[0].hp, 1);
  assert.match(result.reply, /Natural 20/);
});

test('damage while concentrating prompts a concentration save and failure ends the effect', () => {
  const shield = {
    id: 'shield_of_faith',
    name: 'Shield of Faith',
    concentration: true,
    remaining_rounds: 100,
    rules_effects: [{ target: 'armor_class_bonus', value: 2, label: 'Shield of Faith' }],
  };
  const damaged = advanceEnemyTurns({
    worldState: worldState({
      active_effects: [shield],
      player_stats: {
        hp: 12,
        max_hp: 12,
        armor_class: 20,
        base_armor_class: 18,
      },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 20, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false, attack: { name: 'scimitar', attack_bonus: 3, damage_formula: '1d6+1' } },
        ],
      },
    }),
    characterSheet,
    playerTurnNote: 'You hold the line.',
    rollDie: sequenceRolls([18, 4]),
  });
  const failed = adjudicate({
    message: `[ROLL REQUEST: ${damaged.worldState.pending_roll.id}]`,
    worldState: damaged.worldState,
    characterSheet,
    rollDie: sequenceRolls([6]),
  });

  assert.equal(damaged.worldState.pending_roll.kind, 'concentration_save');
  assert.equal(damaged.worldState.pending_roll.dc, 10);
  assert.match(damaged.reply, /Concentration is at risk/);
  assert.match(damaged.reply, new RegExp(`\\[SAVE: id=${damaged.worldState.pending_roll.id} ability=con`));
  assert.deepEqual(failed.worldState.active_effects, []);
  assert.equal(failed.worldState.player_stats.armor_class, 18);
  assert.equal(failed.worldState.combat_state.combatants[0].ac, 18);
  assert.match(failed.reply, /Concentration ends on Shield of Faith/);
});

test('successful concentration save keeps the active effect', () => {
  const shield = {
    id: 'shield_of_faith',
    name: 'Shield of Faith',
    concentration: true,
    remaining_rounds: 100,
    rules_effects: [{ target: 'armor_class_bonus', value: 2, label: 'Shield of Faith' }],
  };
  const result = adjudicate({
    message: '[ROLL REQUEST: concentration_roll]',
    worldState: worldState({
      active_effects: [shield],
      player_stats: {
        hp: 7,
        max_hp: 12,
        armor_class: 20,
        base_armor_class: 18,
      },
      pending_roll: {
        id: 'concentration_roll',
        kind: 'concentration_save',
        modifier: 2,
        ability: 'con',
        label: 'Constitution Saving Throw (Concentration)',
        dc: 10,
        effect_names: ['Shield of Faith'],
      },
      combat_state: {
        active: true,
        round: 2,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 7, max_hp: 12, ac: 20, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([12]),
  });

  assert.equal(result.worldState.pending_roll, null);
  assert.deepEqual(result.worldState.active_effects.map((effect) => effect.id), ['shield_of_faith']);
  assert.equal(result.worldState.combat_state.combatants[0].ac, 20);
  assert.match(result.reply, /maintain concentration/);
});

test('Guidance adds a bonus die only to its chosen skill and persists for the duration', () => {
  const guidance = {
    id: 'guidance',
    name: 'Guidance',
    concentration: true,
    remaining_rounds: 10,
    rules_effects: [{ target: 'ability_check_bonus_die', die: '1d4', label: 'Guidance (stealth)', skill: 'stealth' }],
  };
  const prompt = adjudicate({
    message: 'I hide behind the overturned table.',
    worldState: worldState({
      active_effects: [guidance],
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet,
  });
  const result = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet,
    rollDie: sequenceRolls([12, 2]),
  });

  assert.equal(prompt.worldState.pending_roll.bonus_die, '1d4');
  assert.match(prompt.reply, /bonus_die=1d4/);
  assert.deepEqual(result.worldState.active_effects.map((effect) => effect.id), ['guidance']);

  const otherSkillPrompt = adjudicate({
    message: "I study the clerk's face.",
    worldState: worldState({ active_effects: [guidance] }),
    characterSheet,
  });
  assert.equal(otherSkillPrompt.worldState.pending_roll.bonus_die, null);
});

test('Bless adds a bonus die to weapon attacks', () => {
  const bless = {
    id: 'bless',
    name: 'Bless',
    concentration: true,
    remaining_rounds: 10,
    rules_effects: [{ target: 'attack_roll_bonus_die', die: '1d4', label: 'Bless' }],
  };
  const result = adjudicate({
    message: 'I attack the goblin.',
    worldState: worldState({
      active_effects: [bless],
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 18, is_player: false, attack: { name: 'scimitar', attack_bonus: 3, damage_formula: '1d6+1' } },
        ],
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([10, 4, 2, 5]),
  });
  const goblin = result.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Goblin');

  assert.equal(goblin.hp, 3);
  assert.match(result.reply, /Bless 1d4=4/);
});

test('long rest resets HP, death saves, spell slots, and active effects', () => {
  const result = adjudicate({
    message: 'We take a long rest.',
    worldState: worldState({
      active_effects: [{ id: 'shield_of_faith', name: 'Shield of Faith', rules_effects: [{ target: 'armor_class_bonus', value: 2 }] }],
      player_stats: {
        hp: 4,
        max_hp: 12,
        armor_class: 18,
        spell_slots: { 1: 0 },
        death_saves: { successes: 1, failures: 1 },
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, class: 'paladin', class_name: 'Paladin' },
      spellcasting: { ability: 'cha', slots: { 1: 0 } },
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.hp, 12);
  assert.deepEqual(result.worldState.player_stats.death_saves, { successes: 0, failures: 0 });
  assert.deepEqual(result.worldState.player_stats.spell_slots, { 1: 2 });
  assert.deepEqual(result.worldState.active_effects, []);
  assert.match(result.reply, /long rest/);
});

test('server rejects typed roll results for pending rolls', () => {
  const result = adjudicate({
    message: '[ROLL RESULT: 99] I rolled very honestly.',
    worldState: worldState({
      pending_roll: {
        id: 'roll_test',
        kind: 'skill_check',
        skill: 'insight',
        ability: 'wis',
        label: 'Wisdom (Insight)',
        dc: 15,
      },
    }),
    characterSheet,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.id, 'roll_test');
  assert.match(result.reply, /Typed results are not accepted/);
});

test('narrative time ticks active effects outside combat', () => {
  const result = advanceNarrativeTime({
    message: 'I ask the clerk what he knows.',
    worldState: worldState({
      active_effects: [{
        id: 'shield_of_faith',
        name: 'Shield of Faith',
        concentration: true,
        remaining_rounds: 1,
        rules_effects: [{ target: 'armor_class_bonus', value: 2, label: 'Shield of Faith' }],
      }],
      player_stats: {
        hp: 12,
        max_hp: 12,
        armor_class: 18,
        base_armor_class: 16,
      },
      time_state: { elapsed_rounds: 0, elapsed_minutes: 0 },
    }),
    characterSheet,
  });

  assert.deepEqual(result.worldState.active_effects, []);
  assert.equal(result.worldState.player_stats.armor_class, 16);
  assert.equal(result.worldState.time_state.elapsed_rounds, 1);
  assert.match(result.replySuffix, /Shield of Faith/);
});

test('short rest spends available Hit Dice for healing', () => {
  const result = adjudicate({
    message: 'We take a short rest.',
    worldState: worldState({
      player_stats: {
        hp: 3,
        max_hp: 12,
        armor_class: 16,
        hit_dice: { die: 10, remaining: 1, max: 1 },
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, class: 'fighter', class_name: 'Fighter', level: 1 },
      abilities: {
        ...characterSheet.abilities,
        modifiers: { ...characterSheet.abilities.modifiers, con: 2 },
      },
    },
    rollDie: sequenceRolls([6]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.hp, 11);
  assert.equal(result.worldState.player_stats.hit_dice.remaining, 0);
  assert.match(result.reply, /Spent 1 Hit Die/);
});

test('long rest grants Human Resourceful Heroic Inspiration', () => {
  const result = adjudicate({
    message: 'We take a long rest.',
    worldState: worldState({
      player_stats: {
        hp: 3,
        max_hp: 12,
        armor_class: 16,
        resources: {
          heroic_inspiration: { name: 'Heroic Inspiration', remaining: 0, max: 1 },
        },
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, species: 'human', class: 'fighter', class_name: 'Fighter', level: 1 },
      features: [
        { source: 'species', name: 'Resourceful', description: 'Gain Heroic Inspiration whenever you finish a Long Rest.' },
      ],
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.heroic_inspiration.remaining, 1);
  assert.match(result.reply, /Human Resourceful grants Heroic Inspiration/);
});

test('class feature bonus actions resolve during combat without ending the player turn', () => {
  const result = adjudicate({
    message: 'I enter Rage.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 14, max_hp: 14, ac: 14, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Ari', class: 'barbarian', class_name: 'Barbarian', level: 1 },
      derived_stats: { ...characterSheet.derived_stats, hp: 14, max_hp: 14, armor_class: 14 },
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.combat_state.round, 1);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, true);
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, false);
  assert.equal(result.worldState.active_effects[0].id, 'rage');
  assert.doesNotMatch(result.reply, /Goblin uses/);
});

test('Arcane Recovery restores an expended level 1 wizard slot during a short rest', () => {
  const result = adjudicate({
    message: 'We take a short rest.',
    worldState: worldState({
      player_stats: {
        hp: 8,
        max_hp: 8,
        armor_class: 12,
        spell_slots: { 1: 0 },
        resources: {
          arcane_recovery: { name: 'Arcane Recovery', remaining: 1, max: 1, reset: 'long_rest' },
        },
      },
    }),
    characterSheet: {
      identity: { name: 'Mira', class: 'wizard', class_name: 'Wizard', level: 1 },
      derived_stats: { hp: 8, max_hp: 8, armor_class: 12 },
      spellcasting: { ability: 'int', slots: { 1: 2 } },
      resources: {},
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.spell_slots[1], 1);
  assert.equal(result.worldState.player_stats.resources.arcane_recovery.remaining, 0);
  assert.match(result.reply, /Arcane Recovery restores one expended level 1 spell slot/);
});

test('rogue Sneak Attack adds damage when a finesse attack has advantage', () => {
  const result = adjudicate({
    message: 'I attack the goblin.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 10, max_hp: 10, ac: 14, is_player: true },
          { name: 'Goblin', hp: 20, max_hp: 20, ac: 12, is_player: false, conditions: ['guiding_bolt_advantage'], attack: { name: 'scimitar', attack_bonus: 3, damage_formula: '1d6+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Ari', class: 'rogue', class_name: 'Rogue', level: 1 },
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'shortsword', name: 'Shortsword', attack_total: 5, damage_formula: '1d6 + 3' },
        ],
      },
    },
    rollDie: sequenceRolls([12, 5, 4, 3, 2]),
  });

  const goblin = result.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Goblin');
  assert.equal(result.handled, true);
  assert.equal(goblin.hp, 10);
  assert.match(result.reply, /Sneak Attack 1d6=3/);
});

test('Tavern Brawler unarmed strike rerolls damage die results of 1 and records a requested push', () => {
  const result = adjudicate({
    message: 'Punch the Cultist and push him back.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 12, max_hp: 12, ac: 10, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      origin: { background_feat: 'tavern_brawler' },
    },
    rollDie: sequenceRolls([10, 1, 3, 1]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 6);
  assert.deepEqual(cultist.forced_movement, { feet: 5, direction: 'away_from_player', source: 'Tavern Brawler' });
  assert.match(result.reply, /Unarmed Strike/);
  assert.match(result.reply, /Tavern Brawler/);
});

test('Savage Attacker uses the better of two weapon damage rolls', () => {
  const result = adjudicate({
    message: 'Attack the Cultist.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 10, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      origin: { background_feat: 'savage_attacker' },
    },
    rollDie: sequenceRolls([10, 2, 7, 1]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 10);
  assert.match(result.reply, /Savage Attacker rolled weapon damage twice \(5\/10\) and used 10/);
});

test('Lucky can be spent explicitly on an immediate weapon attack roll', () => {
  const result = adjudicate({
    message: 'Attack the Cultist using Lucky.',
    worldState: worldState({
      player_stats: {
        hp: 12,
        max_hp: 12,
        armor_class: 16,
        resources: {
          luck_points: { name: 'Luck Points', remaining: 2, max: 2, reset: 'long_rest' },
        },
      },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 12, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      origin: { background_feat: 'lucky' },
    },
    rollDie: sequenceRolls([2, 15, 4, 1]),
  });

  assert.equal(result.worldState.player_stats.resources.luck_points.remaining, 1);
  assert.match(result.reply, /advantage from Lucky/);
  assert.match(result.reply, /Lucky spends 1 Luck Point/);
});

test('selected Graze mastery applies through the referee attack loop on a miss', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my greatsword.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 8, max_hp: 8, ac: 20, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      weapon_masteries: [{ weapon_id: 'greatsword', mastery: 'graze' }],
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'greatsword', name: 'Greatsword', ability: 'str', attack_total: 5, damage_formula: '2d6+3' },
        ],
      },
    },
    rollDie: sequenceRolls([2, 1]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 5);
  assert.match(result.reply, /Graze mastery/);
});

test('selected Sap mastery gives the enemy next attack disadvantage and then clears', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my longsword.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 12, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      weapon_masteries: [{ weapon_id: 'longsword', mastery: 'sap' }],
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'longsword', name: 'Longsword', ability: 'str', attack_total: 5, damage_formula: '1d8+3' },
        ],
      },
    },
    rollDie: sequenceRolls([10, 3, 18, 2]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.conditions.includes('sapped'), false);
  assert.match(result.reply, /Sap mastery/);
  assert.match(result.reply, /disadvantage: Sapped on attacker/);
});

test('Dueling Fighting Style adds one-handed melee damage through the referee loop', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my longsword.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 12, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      class_choices: { fighting_style: 'dueling' },
      equipped: { main_hand: 'longsword', off_hand: 'shield' },
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'longsword', name: 'Longsword', ability: 'str', attack_total: 5, damage_formula: '1d8+3' },
        ],
      },
    },
    rollDie: sequenceRolls([10, 4, 1]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 11);
  assert.match(result.reply, /Dueling \+2/);
});

test('Great Weapon Fighting raises low melee weapon damage dice through the referee loop', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my greatsword.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 12, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      class_choices: { fighting_style: 'great_weapon_fighting' },
      equipped: { main_hand: 'greatsword', off_hand: null },
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'greatsword', name: 'Greatsword', ability: 'str', attack_total: 5, damage_formula: '2d6+3' },
        ],
      },
    },
    rollDie: sequenceRolls([10, 1, 2, 1]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 11);
  assert.match(result.reply, /Great Weapon Fighting treats low weapon damage die rolls as 3 \(1, 2 -> 3, 3\)/);
});

test('Archery Fighting Style updates older ranged sheets during referee attack resolution', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my longbow.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 14, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      abilities: {
        final_scores: { str: 10, dex: 14 },
        modifiers: { str: 0, dex: 2 },
      },
      class_choices: { fighting_style: 'archery' },
      equipped: { main_hand: 'longbow', off_hand: null },
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'longbow', name: 'Longbow', ability: 'dex', attack_total: 4, damage_formula: '1d8+1' },
        ],
      },
    },
    rollDie: sequenceRolls([8, 4, 1]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 15);
  assert.match(result.reply, /Attack roll: 14 \(natural 8; 8\+6=14\) vs AC 14/);
});

test('declared paired Light weapons resolve a Nick extra attack inside the Attack action', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my shortsword and dagger.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 10, max_hp: 10, ac: 14, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 30, max_hp: 30, ac: 10, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Ari', class: 'rogue', class_name: 'Rogue', level: 1 },
      abilities: { modifiers: { str: 0, dex: 3 } },
      equipped: { main_hand: 'shortsword', off_hand: 'dagger' },
      weapon_masteries: [{ weapon_id: 'dagger', mastery: 'nick' }],
      derived_stats: {
        ...characterSheet.derived_stats,
        proficiency_bonus: 2,
        attack_breakdowns: [
          { weapon_id: 'shortsword', name: 'Shortsword', ability: 'dex', attack_total: 5, damage_formula: '1d6 + 3' },
          { weapon_id: 'dagger', name: 'Dagger', ability: 'dex', attack_total: 5, damage_formula: '1d4 + 3' },
        ],
      },
    },
    rollDie: sequenceRolls([10, 4, 10, 3, 1]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 20);
  assert.match(result.reply, /Nick mastery/);
  assert.match(result.reply, /extra attack.*Dagger/i);
});

test('Two-Weapon Fighting restores the ability modifier and spends the Light extra attack Bonus Action', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with both weapons.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Fia', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 30, max_hp: 30, ac: 10, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Fia', class: 'fighter', class_name: 'Fighter', level: 1 },
      abilities: { modifiers: { str: 0, dex: 3 } },
      class_choices: { fighting_style: 'two_weapon_fighting' },
      equipped: { main_hand: 'shortsword', off_hand: 'dagger' },
      derived_stats: {
        ...characterSheet.derived_stats,
        proficiency_bonus: 2,
        attack_breakdowns: [
          { weapon_id: 'shortsword', name: 'Shortsword', ability: 'dex', attack_total: 5, damage_formula: '1d6 + 3' },
          { weapon_id: 'dagger', name: 'Dagger', ability: 'dex', attack_total: 5, damage_formula: '1d4 + 3' },
        ],
      },
    },
    rollDie: sequenceRolls([10, 4, 10, 3, 1]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 17);
  assert.match(result.reply, /spend your Bonus Action/);
  assert.match(result.reply, /Extra attack hits for 6 damage/);
});

test('declared weapon name selects the matching calculated attack instead of the first sheet entry', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my dagger.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 10, max_hp: 10, ac: 14, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 10, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      abilities: { modifiers: { str: 0, dex: 3 } },
      equipped: { main_hand: 'shortsword', off_hand: 'dagger' },
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'shortsword', name: 'Shortsword', ability: 'dex', attack_total: 5, damage_formula: '1d6 + 3' },
          { weapon_id: 'dagger', name: 'Dagger', ability: 'dex', attack_total: 5, damage_formula: '1d4 + 3' },
        ],
      },
    },
    rollDie: sequenceRolls([10, 4, 1]),
  });

  assert.match(result.reply, /attack Cultist with Dagger/);
  assert.match(result.reply, /Hit for 7 damage/);
});

test('dropping one enemy does not end combat while another enemy remains', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my longsword.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 4, max_hp: 4, ac: 10, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
          { name: 'Guard', initiative: 6, hp: 8, max_hp: 8, ac: 12, is_player: false, conditions: [], attack: { name: 'spear', attack_bonus: 2, damage_formula: '1d6+1' } },
        ],
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([10, 4, 1]),
  });

  assert.equal(result.worldState.combat_state.active, true);
  assert.match(result.reply, /Cultist falls/);
  assert.doesNotMatch(result.reply, /Combat ends/);
});
