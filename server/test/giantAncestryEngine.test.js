process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyGiantAncestryOnHit,
  applyPrimedGiantAncestryDamageReduction,
  applyPrimedGiantAncestryRetaliation,
  expireGiantAncestryEffects,
  resolveGiantAncestryAction,
} = require('../src/giantAncestryEngine');

function sheet(ancestry) {
  return {
    identity: { name: 'Ari', species: 'goliath', level: 1 },
    species_choices: { giant_ancestry: ancestry },
    abilities: { modifiers: { con: 2 } },
    derived_stats: { proficiency_bonus: 2, speed: 35 },
  };
}

function combatWorld(overrides = {}) {
  return {
    player_stats: { hp: 12, max_hp: 12, speed: 35 },
    combat_state: {
      active: true,
      round: 1,
      turn_index: 0,
      combatants: [
        { name: 'Ari', hp: 12, max_hp: 12, ac: 15, is_player: true, conditions: [] },
        { name: 'Cultist', hp: 20, max_hp: 20, ac: 12, is_player: false, conditions: [] },
      ],
    },
    ...overrides,
  };
}

test("Cloud's Jaunt spends a Bonus Action and records a structured teleport", () => {
  const result = resolveGiantAncestryAction({
    message: "Use Cloud's Jaunt to teleport 20 feet.",
    worldState: combatWorld(),
    characterSheet: sheet('cloud'),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.giant_ancestry.remaining, 1);
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, false);
  assert.deepEqual(result.worldState.player_stats.last_movement, {
    type: 'teleport',
    source: "Cloud's Jaunt",
    feet: 20,
    mode: 'scene_zone_assumption',
    from: null,
    to: null,
  });
});

test("Cloud's Jaunt updates a future hex destination and blocks an occupied one", () => {
  const worldState = combatWorld({
    combat_state: {
      active: true,
      round: 1,
      turn_index: 0,
      combatants: [
        { name: 'Ari', hp: 12, max_hp: 12, ac: 15, is_player: true, position: { map_id: 'crypt', q: 0, r: 0 } },
        { name: 'Cultist', hp: 20, max_hp: 20, ac: 12, is_player: false, position: { map_id: 'crypt', q: 2, r: 0 } },
      ],
    },
  });
  const blocked = resolveGiantAncestryAction({
    message: "Use Cloud's Jaunt.",
    worldState,
    characterSheet: sheet('cloud'),
    destination: { map_id: 'crypt', q: 2, r: 0 },
  });
  const result = resolveGiantAncestryAction({
    message: "Use Cloud's Jaunt.",
    worldState,
    characterSheet: sheet('cloud'),
    destination: { map_id: 'crypt', q: 3, r: 0 },
  });
  const player = result.worldState.combat_state.combatants.find((entry) => entry.is_player);

  assert.match(blocked.reply, /unoccupied destination/);
  assert.deepEqual(player.position, { map_id: 'crypt', q: 3, r: 0 });
  assert.equal(result.worldState.player_stats.last_movement.mode, 'hex');
});

test("Fire's Burn spends one use and applies typed damage after a qualifying hit", () => {
  const worldState = combatWorld();
  const combat = worldState.combat_state;
  const target = { name: 'Cultist', hp: 20, resistances: ['fire'] };
  const result = applyGiantAncestryOnHit({
    message: "Attack the Cultist and use Fire's Burn.",
    target,
    combat,
    worldState,
    characterSheet: sheet('fire'),
    damageDealt: 4,
    rollDie: () => 10,
  });

  assert.equal(target.hp, 15);
  assert.equal(result.worldState.player_stats.resources.giant_ancestry.remaining, 1);
  assert.equal(result.worldState.combat_state.turn_resources.giant_ancestry_hit_rider_used, true);
  assert.match(result.lines[0], /5 fire damage after fire resistance/);
});

test("Fire's Burn doubles its extra damage dice on a Critical Hit", () => {
  const worldState = combatWorld();
  const rolls = [4, 5];
  const target = { name: 'Cultist', hp: 20 };
  const result = applyGiantAncestryOnHit({
    message: "Attack the Cultist and use Fire's Burn.",
    target,
    combat: worldState.combat_state,
    worldState,
    characterSheet: sheet('fire'),
    damageDealt: 4,
    crit: true,
    rollDie: () => rolls.shift(),
  });

  assert.equal(target.hp, 11);
  assert.equal(result.worldState.player_stats.resources.giant_ancestry.remaining, 1);
  assert.match(result.lines[0], /9 fire damage/);
});

test("Frost's Chill adds cold damage and expires its Speed penalty at the next player turn", () => {
  const worldState = combatWorld();
  const combat = worldState.combat_state;
  const target = { name: 'Cultist', hp: 20, conditions: [] };
  const result = applyGiantAncestryOnHit({
    message: "Attack the Cultist with Frost's Chill.",
    target,
    combat,
    worldState,
    characterSheet: sheet('frost'),
    damageDealt: 4,
    rollDie: () => 6,
  });
  const expired = expireGiantAncestryEffects({ ...combat, combatants: [target] }, {
    timing: 'start_of_player_turn',
    round: 2,
  });

  assert.equal(target.hp, 14);
  assert.equal(target.speed_penalty, 10);
  assert.equal(expired.combatants[0].speed_penalty, 0);
});

test("Hill's Tumble knocks a Large or smaller target Prone without spending a use on a Huge target", () => {
  const eligibleWorld = combatWorld();
  const eligible = { name: 'Cultist', hp: 20, size: 'large', conditions: [] };
  const result = applyGiantAncestryOnHit({
    message: "Attack the Cultist with Hill's Tumble.",
    target: eligible,
    combat: eligibleWorld.combat_state,
    worldState: eligibleWorld,
    characterSheet: sheet('hill'),
    damageDealt: 4,
  });
  const hugeWorld = combatWorld();
  const huge = { name: 'Giant', hp: 40, size: 'huge', conditions: [] };
  const blocked = applyGiantAncestryOnHit({
    message: "Attack the Giant with Hill's Tumble.",
    target: huge,
    combat: hugeWorld.combat_state,
    worldState: hugeWorld,
    characterSheet: sheet('hill'),
    damageDealt: 4,
  });

  assert.deepEqual(eligible.conditions, ['prone']);
  assert.equal(result.worldState.player_stats.resources.giant_ancestry.remaining, 1);
  assert.equal(blocked.worldState.player_stats.resources, undefined);
  assert.match(blocked.lines[0], /too large/);
});

test("Stone's Endurance primes and spends its Reaction only when damage arrives", () => {
  const primed = resolveGiantAncestryAction({
    message: "Prime Stone's Endurance if I take damage.",
    worldState: combatWorld(),
    characterSheet: sheet('stone'),
  });
  const result = applyPrimedGiantAncestryDamageReduction({
    player: { name: 'Ari' },
    worldState: primed.worldState,
    characterSheet: sheet('stone'),
    incomingDamage: 12,
    rollDie: () => 6,
  });

  assert.equal(primed.worldState.player_stats.resources, undefined);
  assert.equal(result.incomingDamage, 4);
  assert.equal(result.worldState.player_stats.resources.giant_ancestry.remaining, 1);
  assert.equal(result.worldState.combat_state.turn_resources.reaction_available, false);
  assert.equal(result.worldState.player_stats.giant_ancestry_reaction, null);
});

test("Storm's Thunder retaliates against a triggering creature within 60 feet", () => {
  const worldState = combatWorld({
    combat_state: {
      active: true,
      round: 1,
      turn_index: 0,
      combatants: [
        { name: 'Ari', hp: 12, max_hp: 12, ac: 15, is_player: true, position: { map_id: 'crypt', q: 0, r: 0 } },
        { name: 'Cultist', hp: 20, max_hp: 20, ac: 12, is_player: false, position: { map_id: 'crypt', q: 6, r: 0 } },
      ],
    },
  });
  const primed = resolveGiantAncestryAction({
    message: "Prime Storm's Thunder if I take damage.",
    worldState,
    characterSheet: sheet('storm'),
  });
  const actor = primed.worldState.combat_state.combatants.find((entry) => !entry.is_player);
  const result = applyPrimedGiantAncestryRetaliation({
    actor,
    worldState: primed.worldState,
    characterSheet: sheet('storm'),
    damageTaken: 3,
    rollDie: () => 8,
  });

  assert.equal(result.actor.hp, 12);
  assert.equal(result.worldState.player_stats.resources.giant_ancestry.remaining, 1);
  assert.equal(result.worldState.combat_state.turn_resources.reaction_available, false);
  assert.match(result.lines[0], /8 thunder damage/);
});
