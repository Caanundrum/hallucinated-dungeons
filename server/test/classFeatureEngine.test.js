process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveFeatureAction } = require('../src/classFeatureEngine');

function sheet(classId, overrides = {}) {
  return {
    identity: { name: 'Ari', class: classId, level: 1 },
    abilities: { modifiers: { str: 3, dex: 1, con: 2, wis: 3, cha: 3 } },
    spellcasting: { ability: 'wis' },
    derived_stats: { hp: 12, max_hp: 12, armor_class: 16, proficiency_bonus: 2, spell_save_dc: 13 },
    ...overrides,
  };
}

function combatWorld(overrides = {}) {
  return {
    player_stats: { hp: 5, max_hp: 12, armor_class: 16 },
    combat_state: {
      active: true,
      round: 1,
      turn_index: 0,
      combatants: [
        { name: 'Ari', hp: 5, max_hp: 12, ac: 16, is_player: true },
        { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
      ],
    },
    active_effects: [],
    ...overrides,
  };
}

function sequenceRolls(values) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 1;
}

test('Rage spends a Bonus Action and creates a rules-readable active effect', () => {
  const result = resolveFeatureAction({
    message: 'I enter Rage.',
    worldState: combatWorld(),
    characterSheet: sheet('barbarian'),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.rage.remaining, 1);
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, false);
  assert.equal(result.worldState.active_effects[0].id, 'rage');
  assert.equal(result.worldState.active_effects[0].rules_effects.some((rule) => rule.target === 'damage_resistance'), true);
  assert.match(result.reply, /physical damage resistance/);
});

test('Second Wind heals the active fighter and spends its resource', () => {
  const result = resolveFeatureAction({
    message: 'I use Second Wind.',
    worldState: combatWorld(),
    characterSheet: sheet('fighter'),
    rollDie: sequenceRolls([6]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.hp, 12);
  assert.equal(result.worldState.combat_state.combatants[0].hp, 12);
  assert.equal(result.worldState.player_stats.resources.second_wind.remaining, 1);
  assert.match(result.reply, /Second Wind/);
});

test('unavailable feature resources do not spend the combat Bonus Action', () => {
  const result = resolveFeatureAction({
    message: 'I use Second Wind.',
    worldState: {
      ...combatWorld(),
      player_stats: {
        hp: 5,
        max_hp: 12,
        armor_class: 16,
        resources: {
          second_wind: { name: 'Second Wind', remaining: 0, max: 2, reset: 'long_rest', recover_on_short_rest: 1 },
        },
      },
    },
    characterSheet: sheet('fighter'),
    rollDie: sequenceRolls([6]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.hp, 5);
  assert.equal(result.worldState.combat_state.turn_resources, undefined);
  assert.match(result.reply, /not available/);
});

test('Second Wind at full HP does not spend the use or Bonus Action', () => {
  const result = resolveFeatureAction({
    message: 'I use Second Wind.',
    worldState: combatWorld({
      player_stats: { hp: 12, max_hp: 12, armor_class: 16 },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet: sheet('fighter'),
    rollDie: sequenceRolls([6]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.hp, 12);
  assert.equal(result.worldState.player_stats.resources.second_wind.remaining, 2);
  assert.equal(result.worldState.combat_state.turn_resources, undefined);
  assert.match(result.reply, /No use is spent/);
});

test('Action Surge grants an extra action and spends its level 2 resource', () => {
  const result = resolveFeatureAction({
    message: 'I use Action Surge.',
    worldState: combatWorld({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        turn_resources: {
          action_available: false,
          bonus_action_available: true,
          reaction_available: true,
          movement_remaining: 30,
          used: [{ resource: 'action', label: 'Attack' }],
        },
        combatants: [
          { name: 'Ari', hp: 5, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet: sheet('fighter', {
      identity: { name: 'Ari', class: 'fighter', level: 2 },
      resources: {
        action_surge: { name: 'Action Surge', remaining: 1, max: 1, reset: 'short_rest' },
      },
    }),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.action_surge.remaining, 0);
  assert.equal(result.worldState.combat_state.turn_resources.extra_action_available, true);
  assert.match(result.reply, /extra action/);
});

test('Action Surge action wording is treated as the granted action slot, not a fresh feature use', () => {
  const result = resolveFeatureAction({
    message: 'I attack the dark shape again with my longsword using my Action Surge action.',
    worldState: combatWorld({
      player_stats: {
        hp: 5,
        max_hp: 12,
        armor_class: 16,
        resources: {
          action_surge: { name: 'Action Surge', remaining: 0, max: 1, reset: 'short_rest' },
        },
      },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        turn_resources: {
          action_available: false,
          extra_action_available: true,
          bonus_action_available: true,
          reaction_available: true,
          movement_remaining: 30,
          used: [
            { resource: 'action', label: 'Attack' },
            { resource: 'action_surge', label: 'Action Surge' },
          ],
        },
        combatants: [
          { name: 'Ari', hp: 5, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet: sheet('fighter', {
      identity: { name: 'Ari', class: 'fighter', level: 2 },
    }),
  });

  assert.equal(result, null);
});


test('Lay on Hands spends healing pool without exceeding missing HP', () => {
  const result = resolveFeatureAction({
    message: 'I use Lay on Hands to heal 3 HP on myself.',
    worldState: combatWorld(),
    characterSheet: sheet('paladin'),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.hp, 8);
  assert.equal(result.worldState.player_stats.resources.lay_on_hands.remaining, 2);
  assert.match(result.reply, /Healing pool left: 2 HP/);
});

test('Innate Sorcery creates spell DC and spell attack advantage effects', () => {
  const result = resolveFeatureAction({
    message: 'I activate Innate Sorcery.',
    worldState: combatWorld(),
    characterSheet: sheet('sorcerer'),
  });

  const rules = result.worldState.active_effects[0].rules_effects;
  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.innate_sorcery.remaining, 1);
  assert.equal(rules.some((rule) => rule.target === 'spell_save_dc_bonus'), true);
  assert.equal(rules.some((rule) => rule.target === 'spell_attack_advantage'), true);
});

test('Font of Magic converts Sorcery Points into a level 1 spell slot', () => {
  const result = resolveFeatureAction({
    message: 'I use Font of Magic to create a level 1 spell slot from Sorcery Points.',
    worldState: {
      player_stats: {
        spell_slots: { 1: 1 },
        resources: { sorcery_points: { name: 'Sorcery Points', remaining: 2, max: 2, reset: 'long_rest' } },
      },
    },
    characterSheet: sheet('sorcerer', {
      identity: { name: 'Ari', class: 'sorcerer', level: 2 },
      spellcasting: { ability: 'cha', slots: { 1: 3 } },
    }),
  });

  assert.equal(result.worldState.player_stats.spell_slots[1], 2);
  assert.equal(result.worldState.player_stats.resources.sorcery_points.remaining, 0);
  assert.match(result.reply, /create one level 1 spell slot/i);
});

test('Font of Magic converts a level 1 spell slot into one Sorcery Point', () => {
  const result = resolveFeatureAction({
    message: 'I use Font of Magic to convert a spell slot into Sorcery Points.',
    worldState: {
      player_stats: {
        spell_slots: { 1: 2 },
        resources: { sorcery_points: { name: 'Sorcery Points', remaining: 0, max: 2, reset: 'long_rest' } },
      },
    },
    characterSheet: sheet('sorcerer', {
      identity: { name: 'Ari', class: 'sorcerer', level: 2 },
      spellcasting: { ability: 'cha', slots: { 1: 3 } },
    }),
  });

  assert.equal(result.worldState.player_stats.spell_slots[1], 1);
  assert.equal(result.worldState.player_stats.resources.sorcery_points.remaining, 1);
});

test('Magical Cunning restores one Pact slot after its one-minute rite', () => {
  const result = resolveFeatureAction({
    message: 'I use Magical Cunning.',
    worldState: {
      player_stats: {
        spell_slots: { 1: 0 },
        resources: { magical_cunning: { name: 'Magical Cunning', remaining: 1, max: 1, reset: 'long_rest' } },
      },
      time_state: { elapsed_minutes: 4 },
    },
    characterSheet: sheet('warlock', {
      identity: { name: 'Ari', class: 'warlock', level: 2 },
      spellcasting: { ability: 'cha', slots: { 1: 0 }, slots_max: { 1: 2 } },
    }),
  });

  assert.equal(result.worldState.player_stats.spell_slots[1], 1);
  assert.equal(result.worldState.player_stats.resources.magical_cunning.remaining, 0);
  assert.equal(result.worldState.time_state.elapsed_minutes, 5);
  assert.match(result.reply, /recover 1 Pact Magic slot/);
});

test('natural Pact of the Blade wording conjures the selected weapon without using the narrator', () => {
  const result = resolveFeatureAction({
    message: 'I conjure my Pact of the Blade weapon as the longsword I chose.',
    worldState: combatWorld(),
    characterSheet: sheet('warlock', {
      identity: { name: 'Ari', class: 'warlock', level: 2 },
      class_choices: { eldritch_invocations: ['armor_of_shadows', 'pact_of_the_blade', 'eldritch_mind'] },
      class_choice_details: { pact_of_the_blade: { pact_weapon: 'longsword' } },
    }),
  });

  assert.equal(result.handled, true);
  assert.equal(result.logType, 'feature_pact_blade_conjure');
  assert.equal(result.worldState.player_stats.pact_weapon.id, 'longsword');
  assert.equal(result.worldState.player_stats.pact_weapon.active, true);
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, false);
  assert.match(result.reply, /Longsword/);
});

test('Divine Spark healing spends Channel Divinity and restores HP', () => {
  const result = resolveFeatureAction({
    message: 'I use Divine Spark to heal myself.',
    worldState: combatWorld({
      player_stats: {
        hp: 4,
        max_hp: 12,
        resources: {
          channel_divinity: { name: 'Channel Divinity', remaining: 2, max: 2, reset: 'short_rest' },
        },
      },
    }),
    characterSheet: sheet('cleric', {
      identity: { name: 'Ari', class: 'cleric', level: 2 },
    }),
    rollDie: sequenceRolls([5]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.channel_divinity.remaining, 1);
  assert.equal(result.worldState.player_stats.hp, 12);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, false);
  assert.match(result.reply, /Divine Spark/);
});

test('Divine Spark damage blocks explicit absent targets instead of retargeting', () => {
  const result = resolveFeatureAction({
    message: 'I use Divine Spark to blast the dragon.',
    worldState: combatWorld({
      player_stats: {
        hp: 12,
        max_hp: 12,
        resources: {
          channel_divinity: { name: 'Channel Divinity', remaining: 2, max: 2, reset: 'short_rest' },
        },
      },
    }),
    characterSheet: sheet('cleric', {
      identity: { name: 'Ari', class: 'cleric', level: 2 },
    }),
    rollDie: sequenceRolls([3, 5]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.channel_divinity.remaining, 2);
  assert.equal(result.worldState.combat_state.turn_resources, undefined);
  assert.equal(result.worldState.combat_state.combatants[1].hp, 8);
  assert.match(result.reply, /valid creature target/);
});

test('Divine Spark damages an established combat target after a failed CON save', () => {
  const result = resolveFeatureAction({
    message: 'I use Divine Spark to blast the Goblin with radiant energy.',
    worldState: combatWorld({
      player_stats: {
        hp: 12,
        max_hp: 12,
        resources: {
          channel_divinity: { name: 'Channel Divinity', remaining: 2, max: 2, reset: 'short_rest' },
        },
      },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 12, max_hp: 12, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet: sheet('cleric', {
      identity: { name: 'Ari', class: 'cleric', level: 2 },
    }),
    rollDie: sequenceRolls([3, 5]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.channel_divinity.remaining, 1);
  assert.equal(result.worldState.combat_state.combatants[1].hp, 4);
  assert.match(result.reply, /Save fails/);
});

test('Turn Undead applies turn_undead condition to failed undead saves', () => {
  const result = resolveFeatureAction({
    message: 'I use Turn Undead.',
    worldState: combatWorld({
      player_stats: {
        hp: 12,
        max_hp: 12,
        resources: {
          channel_divinity: { name: 'Channel Divinity', remaining: 2, max: 2, reset: 'short_rest' },
        },
      },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Skeleton', creature_type: 'undead', hp: 8, max_hp: 8, ac: 13, saves: { wis: 0 }, is_player: false },
        ],
      },
    }),
    characterSheet: sheet('cleric', {
      identity: { name: 'Ari', class: 'cleric', level: 2 },
    }),
    rollDie: sequenceRolls([4]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.channel_divinity.remaining, 1);
  assert(result.worldState.combat_state.combatants[1].conditions.includes('turn_undead'));
  assert(result.worldState.active_effects.some((effect) => effect.id === 'turn_undead'));
});

test('Wild Shape spends Wild Shape, adds temp HP, and tracks the beast form', () => {
  const result = resolveFeatureAction({
    message: 'I turn into a wolf.',
    worldState: combatWorld({
      player_stats: {
        hp: 12,
        max_hp: 12,
        resources: {
          wild_shape: { name: 'Wild Shape', remaining: 2, max: 2, reset: 'short_rest' },
        },
      },
    }),
    characterSheet: sheet('druid', {
      identity: { name: 'Ari', class: 'druid', level: 2 },
    }),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.wild_shape.remaining, 1);
  assert.equal(result.worldState.player_stats.temp_hp, 2);
  assert.equal(result.worldState.player_stats.wild_shape.form, 'wolf');
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, false);
  assert(result.worldState.active_effects.some((effect) => effect.id === 'wild_shape'));
});

test('Wild Companion spends a Wild Shape use and adds a familiar to scene state', () => {
  const result = resolveFeatureAction({
    message: 'I use Wild Companion to cast Find Familiar.',
    worldState: combatWorld({
      player_stats: {
        hp: 12,
        max_hp: 12,
        resources: {
          wild_shape: { name: 'Wild Shape', remaining: 2, max: 2, reset: 'short_rest' },
        },
      },
      scene_presence: {
        exact_location: 'Lantern Bridge',
        present_npcs: [],
        present_objects: [],
      },
    }),
    characterSheet: sheet('druid', {
      identity: { name: 'Ari', class: 'druid', level: 2 },
    }),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.wild_shape.remaining, 1);
  assert(result.worldState.player_stats.companions.some((companion) => companion.id === 'wild_companion_familiar'));
  assert(result.worldState.scene_presence.present_npcs.includes('familiar'));
  assert.equal(result.worldState.combat_state.turn_resources.action_available, false);
});

test('Wild Companion dismissal preserves Wild Shape and permits a later resummon', () => {
  const druid = sheet('druid', {
    identity: { name: 'Ari', class: 'druid', level: 2 },
  });
  const initialState = {
    player_stats: {
      hp: 12,
      max_hp: 12,
      armor_class: 13,
      resources: {
        wild_shape: { name: 'Wild Shape', remaining: 2, max: 2, reset: 'short_rest' },
      },
    },
    scene_presence: {
      exact_location: 'Lantern Bridge',
      present_npcs: [],
      present_objects: [],
    },
    active_effects: [],
    combat_state: null,
  };

  const summoned = resolveFeatureAction({
    message: 'I use Wild Companion.',
    worldState: initialState,
    characterSheet: druid,
  });
  const dismissed = resolveFeatureAction({
    message: 'I dismiss my Wild Companion familiar.',
    worldState: summoned.worldState,
    characterSheet: druid,
  });
  const resummoned = resolveFeatureAction({
    message: 'I use Wild Companion again.',
    worldState: dismissed.worldState,
    characterSheet: druid,
  });

  assert.equal(summoned.worldState.player_stats.resources.wild_shape.remaining, 1);
  assert.equal(dismissed.logType, 'feature_wild_companion_dismissed');
  assert.equal(dismissed.worldState.player_stats.resources.wild_shape.remaining, 1);
  assert.equal(dismissed.worldState.active_effects.some((effect) => effect.id === 'wild_companion'), false);
  assert.equal(dismissed.worldState.player_stats.companions.length, 0);
  assert.equal(dismissed.worldState.scene_presence.present_npcs.includes('familiar'), false);
  assert.match(dismissed.reply, /No Wild Shape use is spent/);
  assert.equal(resummoned.worldState.player_stats.resources.wild_shape.remaining, 0);
  assert.equal(resummoned.worldState.active_effects.some((effect) => effect.id === 'wild_companion'), true);
});

test('dismissing Wild Companion in combat spends the Action but not Wild Shape', () => {
  const result = resolveFeatureAction({
    message: 'Send my familiar away.',
    worldState: combatWorld({
      player_stats: {
        hp: 12,
        max_hp: 12,
        armor_class: 13,
        resources: {
          wild_shape: { name: 'Wild Shape', remaining: 1, max: 2, reset: 'short_rest' },
        },
        companions: [
          { id: 'wild_companion_familiar', name: 'familiar', type: 'familiar', source: 'Wild Companion' },
        ],
      },
      scene_presence: {
        exact_location: 'Lantern Bridge',
        present_npcs: ['familiar'],
        present_objects: [],
      },
      active_effects: [
        {
          id: 'wild_companion',
          name: 'Wild Companion Familiar',
          target: 'familiar',
          duration: 'until dismissed',
          rules_effects: [],
        },
      ],
    }),
    characterSheet: sheet('druid', {
      identity: { name: 'Ari', class: 'druid', level: 2 },
    }),
  });

  assert.equal(result.logType, 'feature_wild_companion_dismissed');
  assert.equal(result.worldState.player_stats.resources.wild_shape.remaining, 1);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, false);
});

test('Bardic Inspiration requires another present creature target', () => {
  const noTarget = resolveFeatureAction({
    message: 'I use Bardic Inspiration.',
    worldState: combatWorld(),
    characterSheet: sheet('bard'),
  });
  const targeted = resolveFeatureAction({
    message: 'I give Bardic Inspiration to the guard.',
    worldState: {
      ...combatWorld(),
      scene_presence: { present_npcs: ['guard'] },
    },
    characterSheet: sheet('bard'),
  });

  assert.equal(noTarget.handled, true);
  assert.match(noTarget.reply, /needs another creature/);
  assert.equal(targeted.worldState.player_stats.resources.bardic_inspiration.remaining, 2);
  assert.equal(targeted.worldState.active_effects[0].target, 'guard');
});

test('Patient Defense spends Focus and marks the Monk as dodging', () => {
  const result = resolveFeatureAction({
    message: 'I use Patient Defense.',
    worldState: combatWorld({
      player_stats: {
        hp: 12,
        max_hp: 12,
        resources: {
          focus_points: { name: 'Focus Points', remaining: 2, max: 2, reset: 'short_rest' },
        },
      },
    }),
    characterSheet: sheet('monk', {
      identity: { name: 'Ari', class: 'monk', level: 2 },
      derived_stats: { hp: 12, max_hp: 12, armor_class: 16, proficiency_bonus: 2, speed: 40 },
    }),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.focus_points.remaining, 1);
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, false);
  assert.equal(result.worldState.combat_state.turn_resources.dodging, true);
  assert.match(result.reply, /Dodge action as a Bonus Action/);
});

test('Step of the Wind spends Focus, marks Disengage, and grants movement', () => {
  const result = resolveFeatureAction({
    message: 'I use Step of the Wind.',
    worldState: combatWorld({
      player_stats: {
        hp: 12,
        max_hp: 12,
        speed: 40,
        resources: {
          focus_points: { name: 'Focus Points', remaining: 2, max: 2, reset: 'short_rest' },
        },
      },
    }),
    characterSheet: sheet('monk', {
      identity: { name: 'Ari', class: 'monk', level: 2 },
      derived_stats: { hp: 12, max_hp: 12, armor_class: 16, proficiency_bonus: 2, speed: 40 },
    }),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.focus_points.remaining, 1);
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, false);
  assert.equal(result.worldState.combat_state.turn_resources.disengaged, true);
  assert.equal(result.worldState.combat_state.turn_resources.movement_remaining, 80);
  assert.match(result.reply, /Dash and Disengage/);
});

test('Uncanny Metabolism refills Monk Focus and heals once per long rest', () => {
  const result = resolveFeatureAction({
    message: 'I use Uncanny Metabolism.',
    worldState: combatWorld({
      player_stats: {
        hp: 5,
        max_hp: 20,
        resources: {
          focus_points: { name: 'Focus Points', remaining: 0, max: 2, reset: 'short_rest' },
          uncanny_metabolism: { name: 'Uncanny Metabolism', remaining: 1, max: 1, reset: 'long_rest' },
        },
      },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 5, max_hp: 20, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet: sheet('monk', {
      identity: { name: 'Ari', class: 'monk', level: 2 },
      derived_stats: { hp: 5, max_hp: 20, armor_class: 16, proficiency_bonus: 2, speed: 40 },
    }),
    rollDie: sequenceRolls([4]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.focus_points.remaining, 2);
  assert.equal(result.worldState.player_stats.resources.uncanny_metabolism.remaining, 0);
  assert.equal(result.worldState.player_stats.hp, 11);
  assert.match(result.reply, /Focus Points refill/);
});
