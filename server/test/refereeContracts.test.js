process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ENTITY_TYPES,
  REACTION_RESUME_STAGES,
  REACTION_RESUME_TYPES,
  REACTION_TRIGGERS,
  REFEREE_CONTRACT_VERSION,
  RULES_EFFECT_TARGETS,
  assertValidAuthoritativeState,
  assertValidEntity,
  assertValidPendingReaction,
  assertValidRulesEffects,
  buildPendingReactionWindow,
  buildReactionResume,
  defineReactionDefinition,
  validateAuthoritativeState,
} = require('../src/refereeContracts');
const { getContentBundle } = require('../src/contentData');

test('referee contract exposes one versioned vocabulary for current and planned engine seams', () => {
  assert.equal(REFEREE_CONTRACT_VERSION, '4C.6-H19');
  assert.equal(REACTION_TRIGGERS.ATTACK_HIT, 'attack_hit');
  assert.equal(REACTION_TRIGGERS.DAMAGE_TAKEN, 'damage_taken');
  assert.equal(REACTION_TRIGGERS.CREATURE_LEAVES_REACH, 'creature_leaves_reach');
  assert.equal(REACTION_RESUME_STAGES.BEFORE_MOVEMENT, 'before_movement');
  assert.equal(REACTION_RESUME_TYPES.COMBAT_MOVEMENT, 'combat_movement');
  assert.equal(ENTITY_TYPES.ACTIVE_EFFECT, 'active_effect');
  assert.equal(RULES_EFFECT_TARGETS.ARMOR_CLASS_BONUS, 'armor_class_bonus');
});

test('reaction definitions reject untracked trigger families instead of silently inventing rules', () => {
  assert.throws(() => defineReactionDefinition({
    id: 'mystery_button',
    trigger: 'whenever_the_vibes_shift',
    label: 'Press Mystery Button',
  }), /must be one of/);
});

test('pending Reaction windows and resume frames validate their persisted transaction shape', () => {
  const resume = buildReactionResume({
    type: REACTION_RESUME_TYPES.COMBAT_MOVEMENT,
    stage: REACTION_RESUME_STAGES.AFTER_ATTACK,
    destination: { map_id: 'crypt', q: -2, r: 0 },
    movement: { feet: 10 },
  });
  const window = buildPendingReactionWindow({
    trigger: REACTION_TRIGGERS.DAMAGE_TAKEN,
    triggerLabel: 'Skeleton claw',
    triggerPrompt: 'Skeleton dealt 4 damage.',
    resumeStage: REACTION_RESUME_STAGES.AFTER_ATTACK,
    options: [{ id: 'hellish_rebuke', type: 'cast_spell', label: 'Cast Hellish Rebuke' }],
    resume,
  });

  assert.equal(assertValidPendingReaction(window), window);
  assert.equal(window.resume.type, 'combat_movement');
  assert.equal(window.resume.stage, 'after_attack');
  assert.deepEqual(window.resume.destination, { map_id: 'crypt', q: -2, r: 0 });
});

test('invalid persisted Reaction frames fail validation before they can corrupt a continuation', () => {
  assert.throws(() => buildReactionResume({
    type: 'teleport_somewhere_probably',
  }), /Reaction resume type must be one of/);
  assert.throws(() => assertValidPendingReaction({
    id: 'reaction_bad',
    kind: 'player_reaction',
    trigger: REACTION_TRIGGERS.ATTACK_HIT,
    resume_stage: 'after_lunch',
    options: [],
  }), /unknown resume stage.*at least one option/s);
});

test('entities validate the common identity, position, visibility, and interaction envelope', () => {
  const creature = {
    id: 'creature:gate_wolf',
    type: ENTITY_TYPES.CREATURE,
    name: 'Gate Wolf',
    aliases: ['wolf'],
    position: { mode: 'hex', map_id: 'gate', q: 1, r: 0 },
    visibility: { visible: true },
    interactions: { attack: true, target_spell: true },
  };

  assert.equal(assertValidEntity(creature), creature);
  assert.throws(() => assertValidEntity({
    id: 'plot_device:ominous_spoon',
    type: 'plot_device',
    name: 'Ominous Spoon',
  }), /unknown type/);
});

test('deterministic rules effects use registered primitives while narration remains free-form', () => {
  const rules = [
    { target: RULES_EFFECT_TARGETS.ARMOR_CLASS_BONUS, value: 2, label: 'Protective shimmer' },
    { target: RULES_EFFECT_TARGETS.WEAPON_DAMAGE_BONUS_DIE, die: '1d4', damage_type: 'radiant' },
  ];

  assert.equal(assertValidRulesEffects(rules), rules);
  assert.throws(() => assertValidRulesEffects([
    { target: 'become_king_of_the_moon', value: true },
  ]), /unknown target/);
});

test('exposed content data only uses registered rules-effect primitives', () => {
  const content = getContentBundle();
  const rules = collectRulesEffects([
    ...(content.equipment || []),
    ...(content.feats || []),
    ...(content.species || []),
  ]);

  assert.ok(rules.length > 0);
  assert.equal(assertValidRulesEffects(rules, 'exposed content effects'), rules);
});

test('authoritative state allows one blocking interrupt at a time', () => {
  const reaction = buildPendingReactionWindow({
    trigger: REACTION_TRIGGERS.ATTACK_HIT,
    triggerLabel: 'Skeleton claw',
    options: [{ id: 'shield', type: 'cast_spell', label: 'Cast Shield' }],
  });
  const invalid = {
    active_effects: [],
    pending_roll: { id: 'roll_1', kind: 'saving_throw' },
    pending_reaction: reaction,
  };

  assert.deepEqual(validateAuthoritativeState(invalid), ['pending_roll and pending_reaction cannot both be open.']);
  assert.throws(() => assertValidAuthoritativeState(invalid), /cannot both be open/);
});

function collectRulesEffects(values = []) {
  const rules = [];
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value.effects)) rules.push(...value.effects);
    for (const nested of Object.values(value)) {
      if (Array.isArray(nested)) rules.push(...collectRulesEffects(nested));
    }
  }
  return rules;
}
