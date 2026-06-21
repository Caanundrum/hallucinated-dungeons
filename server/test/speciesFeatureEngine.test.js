process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getSpeciesD20AdvantageSources,
  resolveSpeciesFeatureAction,
} = require('../src/speciesFeatureEngine');

function sequenceRolls(values) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 10;
}

function sheet(species, overrides = {}) {
  return {
    identity: { name: 'Ari', species, level: 1 },
    abilities: { modifiers: { con: 2 } },
    derived_stats: { hp: 12, max_hp: 12, armor_class: 14, proficiency_bonus: 2, speed: 30 },
    ...overrides,
  };
}

function combatWorld(overrides = {}) {
  return {
    player_stats: { hp: 7, max_hp: 12, armor_class: 14, speed: 30 },
    combat_state: {
      active: true,
      round: 1,
      turn_index: 0,
      combatants: [
        { name: 'Ari', hp: 7, max_hp: 12, ac: 14, is_player: true, conditions: [] },
        { name: 'Cultist', hp: 8, max_hp: 8, ac: 12, is_player: false, conditions: [], saves: { dex: 0 } },
      ],
    },
    ...overrides,
  };
}

test('Celestial-Touched Healing Hands spends its Magic Action and heals proficiency d4', () => {
  const result = resolveSpeciesFeatureAction({
    message: 'Use Healing Hands on myself.',
    worldState: combatWorld(),
    characterSheet: sheet('celestial_touched'),
    rollDie: sequenceRolls([2, 3]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.hp, 12);
  assert.equal(result.worldState.player_stats.resources.healing_hands.remaining, 0);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, false);
  assert.match(result.reply, /regain 5 HP/);
});

test('Celestial-Touched Healing Hands does not spend its action or use at full HP', () => {
  const worldState = combatWorld({
    player_stats: { hp: 12, max_hp: 12, armor_class: 14, speed: 30 },
    combat_state: {
      ...combatWorld().combat_state,
      combatants: combatWorld().combat_state.combatants.map((entry) => (
        entry.is_player ? { ...entry, hp: 12 } : entry
      )),
    },
  });
  const result = resolveSpeciesFeatureAction({
    message: 'Use Healing Hands on myself.',
    worldState,
    characterSheet: sheet('celestial_touched'),
  });

  assert.equal(result.worldState.player_stats.resources, undefined);
  assert.equal(result.worldState.combat_state.turn_resources, undefined);
  assert.match(result.reply, /not spent.*full HP/i);
});

test('Orc Adrenaline Rush spends a Bonus Action, grants Dash movement, and grants temporary HP', () => {
  const result = resolveSpeciesFeatureAction({
    message: 'Use Adrenaline Rush.',
    worldState: combatWorld(),
    characterSheet: sheet('orc'),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.adrenaline_rush.remaining, 1);
  assert.equal(result.worldState.player_stats.temp_hp, 2);
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, false);
  assert.equal(result.worldState.combat_state.turn_resources.movement_remaining, 60);
});

test('Dragonborn Breath Weapon spends an Action and applies ancestry damage after a save', () => {
  const result = resolveSpeciesFeatureAction({
    message: 'Use Breath Weapon on the Cultist.',
    worldState: combatWorld(),
    characterSheet: sheet('dragonborn', {
      species_choices: { draconic_ancestry: 'blue' },
    }),
    rollDie: sequenceRolls([4, 7]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(result.handled, true);
  assert.equal(result.consumesTurn, true);
  assert.equal(result.worldState.player_stats.resources.breath_weapon.remaining, 1);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, false);
  assert.equal(cultist.hp, 1);
  assert.match(result.reply, /7 lightning damage/);
});

test('Dragonborn Breath Weapon rejects an explicitly absent target without spending anything', () => {
  const result = resolveSpeciesFeatureAction({
    message: 'Use Breath Weapon on the dragon.',
    worldState: combatWorld(),
    characterSheet: sheet('dragonborn', {
      species_choices: { draconic_ancestry: 'blue' },
    }),
  });

  assert.equal(result.worldState.player_stats.resources, undefined);
  assert.equal(result.worldState.combat_state.turn_resources, undefined);
  assert.match(result.reply, /Name a living enemy/);
});

test('Dragonborn Breath Weapon enforces ancestry damage and future damage scaling', () => {
  const wrongType = resolveSpeciesFeatureAction({
    message: 'I breathe fire at the Cultist.',
    worldState: combatWorld(),
    characterSheet: sheet('dragonborn', {
      species_choices: { draconic_ancestry: 'blue' },
    }),
  });
  const scaled = resolveSpeciesFeatureAction({
    message: 'I breathe lightning at the Cultist.',
    worldState: combatWorld(),
    characterSheet: sheet('dragonborn', {
      identity: { name: 'Ari', species: 'dragonborn', level: 5 },
      species_choices: { draconic_ancestry: 'blue' },
    }),
    rollDie: sequenceRolls([4, 5, 6]),
  });

  assert.match(wrongType.reply, /lightning damage, not fire/i);
  assert.equal(wrongType.worldState.player_stats.resources, undefined);
  assert.match(scaled.reply, /2d10 rolls 11/);
});

test('Dwarf Stonecunning requires stone and adds a timed Tremorsense effect', () => {
  const blocked = resolveSpeciesFeatureAction({
    message: 'Use Stonecunning.',
    worldState: { current_location: 'grassy field' },
    characterSheet: sheet('dwarf'),
  });
  const result = resolveSpeciesFeatureAction({
    message: 'Use Stonecunning.',
    worldState: { current_location: 'old stone bridge' },
    characterSheet: sheet('dwarf'),
  });

  assert.match(blocked.reply, /needs stone/);
  assert.equal(result.worldState.active_effects[0].id, 'stonecunning');
  assert.equal(result.worldState.active_effects[0].remaining_minutes, 10);
  assert.equal(result.worldState.player_stats.resources.stonecunning.remaining, 1);
});

test('species passive save advantages are data-independent referee inputs', () => {
  assert.deepEqual(getSpeciesD20AdvantageSources({
    characterSheet: sheet('gnome'),
    testType: 'saving_throw',
    ability: 'wis',
  }), ['Gnomish Cunning']);
  assert.deepEqual(getSpeciesD20AdvantageSources({
    characterSheet: sheet('dwarf'),
    testType: 'saving_throw',
    ability: 'con',
    reason: 'save against poison',
  }), ['Dwarven Resilience']);
  assert.deepEqual(getSpeciesD20AdvantageSources({
    characterSheet: sheet('elf'),
    testType: 'saving_throw',
    ability: 'wis',
    reason: 'avoid being charmed',
  }), ['Fey Ancestry']);
  assert.deepEqual(getSpeciesD20AdvantageSources({
    characterSheet: sheet('halfling'),
    testType: 'saving_throw',
    ability: 'wis',
    reason: 'resist frightened',
  }), ['Brave']);
  assert.deepEqual(getSpeciesD20AdvantageSources({
    characterSheet: sheet('goliath'),
    testType: 'saving_throw',
    ability: 'dex',
    reason: 'escape the grappled condition',
  }), ['Powerful Build']);
});

test('Rock Gnome creates, limits, and dismantles deterministic clockwork devices', () => {
  const rockGnome = sheet('gnome', {
    species_choices: { gnomish_lineage: 'rock', lineage_spell_ability: 'int' },
  });
  let worldState = { time_state: { elapsed_minutes: 5 }, active_effects: [] };
  for (const message of [
    'I build a clockwork toy.',
    'I create a fire starter device.',
    'I assemble a music box.',
  ]) {
    const result = resolveSpeciesFeatureAction({ message, worldState, characterSheet: rockGnome });
    worldState = result.worldState;
  }
  const blocked = resolveSpeciesFeatureAction({
    message: 'I build another clockwork toy.',
    worldState,
    characterSheet: rockGnome,
  });
  const dismantled = resolveSpeciesFeatureAction({
    message: 'I dismantle the music box.',
    worldState,
    characterSheet: rockGnome,
  });

  assert.equal(worldState.active_effects.filter((effect) => effect.id.startsWith('rock_gnome_device_')).length, 3);
  assert.equal(worldState.time_state.elapsed_minutes, 35);
  assert.match(blocked.reply, /three active/);
  assert.equal(dismantled.worldState.active_effects.some((effect) => effect.device_type === 'music_box'), false);
});

test('Rock Gnome device creation takes ten minutes and is blocked during combat', () => {
  const rockGnome = sheet('gnome', {
    species_choices: { gnomish_lineage: 'rock', lineage_spell_ability: 'int' },
  });
  const result = resolveSpeciesFeatureAction({
    message: 'I create a fire starter device.',
    worldState: combatWorld(),
    characterSheet: rockGnome,
  });

  assert.match(result.reply, /takes 10 minutes/);
  assert.equal(result.worldState.active_effects, undefined);
});
