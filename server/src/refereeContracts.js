const crypto = require('crypto');

const REFEREE_CONTRACT_VERSION = '4C.6-H24';

const REACTION_TRIGGERS = freezeValues({
  ATTACK_HIT: 'attack_hit',
  DAMAGE_TAKEN: 'damage_taken',
  MAGIC_MISSILE_TARGETED: 'magic_missile_targeted',
  CREATURE_FALLS: 'creature_falls',
  CREATURE_LEAVES_REACH: 'creature_leaves_reach',
});

const REACTION_RESUME_STAGES = freezeValues({
  BEFORE_ATTACK: 'before_attack',
  AFTER_ATTACK: 'after_attack',
  BEFORE_MOVEMENT: 'before_movement',
  AFTER_MOVEMENT: 'after_movement',
});

const REACTION_RESUME_TYPES = freezeValues({
  CREATURE_TURNS: 'creature_turns',
  COMBAT_MOVEMENT: 'combat_movement',
});

const ENTITY_TYPES = freezeValues({
  PC: 'pc',
  NPC: 'npc',
  CREATURE: 'creature',
  OBJECT: 'object',
  HAZARD: 'hazard',
  LOCATION_EXIT: 'location_exit',
  KNOWN_LOCATION: 'known_location',
  ACTIVE_EFFECT: 'active_effect',
});

const RULES_EFFECT_TARGETS = freezeValues({
  ABILITY_CHECK_ADVANTAGE: 'ability_check_advantage',
  ABILITY_CHECK_BONUS_DIE: 'ability_check_bonus_die',
  ARMOR_CLASS_BONUS: 'armor_class_bonus',
  ARMOR_FORMULA: 'armor_formula',
  ATTACK_ROLL_BONUS_DIE: 'attack_roll_bonus_die',
  BARDIC_INSPIRATION_DIE: 'bardic_inspiration_die',
  DAMAGE_RESISTANCE: 'damage_resistance',
  DARKVISION_OVERRIDE: 'darkvision_override',
  FEAR_IMMUNITY: 'fear_immunity',
  INITIATIVE_BONUS: 'initiative_bonus',
  INITIATIVE_PROFICIENCY: 'initiative_proficiency',
  MAX_HP_PER_LEVEL_BONUS: 'max_hp_per_level_bonus',
  MELEE_RETALIATION_DAMAGE: 'melee_retaliation_damage',
  SAVING_THROW_ADVANTAGE: 'saving_throw_advantage',
  SAVING_THROW_BONUS: 'saving_throw_bonus',
  SAVING_THROW_BONUS_DIE: 'saving_throw_bonus_die',
  SHIELD_BONUS: 'shield_bonus',
  SKILL_ADVANTAGE: 'skill_advantage',
  SKILL_CHECK_BONUS: 'skill_check_bonus',
  SPELL_ATTACK_ADVANTAGE: 'spell_attack_advantage',
  SPELL_ATTACK_BONUS: 'spell_attack_bonus',
  SPELL_SAVE_DC_BONUS: 'spell_save_dc_bonus',
  SPEED_BONUS: 'speed_bonus',
  TEMP_HP: 'temp_hp',
  TEMP_HP_EACH_TURN: 'temp_hp_each_turn',
  TREMORSENSE: 'tremorsense',
  WEAPON_ATTACK_BONUS: 'weapon_attack_bonus',
  WEAPON_DAMAGE_BONUS: 'weapon_damage_bonus',
  WEAPON_DAMAGE_BONUS_DIE: 'weapon_damage_bonus_die',
});

function defineReactionDefinition(definition = {}) {
  assertNonEmptyString(definition.id, 'Reaction definition id');
  assertEnum(definition.trigger, REACTION_TRIGGERS, `Reaction ${definition.id} trigger`);
  assertNonEmptyString(definition.label, `Reaction ${definition.id} label`);
  if (definition.spellId !== undefined) {
    assertNonEmptyString(definition.spellId, `Reaction ${definition.id} spellId`);
  }
  if (definition.canOffer !== undefined && typeof definition.canOffer !== 'function') {
    throw new TypeError(`Reaction ${definition.id} canOffer must be a function.`);
  }
  return Object.freeze({ ...definition });
}

function buildPendingReactionWindow({
  id = createFrameId('reaction'),
  trigger,
  triggerLabel,
  triggerPrompt,
  resumeStage = REACTION_RESUME_STAGES.BEFORE_ATTACK,
  options = [],
  ...extra
} = {}) {
  const window = {
    id,
    kind: 'player_reaction',
    trigger,
    trigger_label: triggerLabel,
    trigger_prompt: triggerPrompt,
    resume_stage: resumeStage,
    options,
    ...extra,
  };
  assertValidPendingReaction(window);
  return window;
}

function buildReactionResume({
  type,
  stage = REACTION_RESUME_STAGES.BEFORE_ATTACK,
  ...payload
} = {}) {
  assertEnum(type, REACTION_RESUME_TYPES, 'Reaction resume type');
  assertEnum(stage, REACTION_RESUME_STAGES, 'Reaction resume stage');
  return {
    type,
    stage,
    ...payload,
  };
}

function assertValidPendingReaction(window = {}) {
  const errors = validatePendingReaction(window);
  if (errors.length > 0) {
    throw new TypeError(`Invalid pending Reaction window: ${errors.join(' ')}`);
  }
  return window;
}

function validatePendingReaction(window = {}) {
  const errors = [];
  if (!isNonEmptyString(window.id)) errors.push('id is required.');
  if (window.kind !== 'player_reaction') errors.push('kind must be player_reaction.');
  if (!enumIncludes(REACTION_TRIGGERS, window.trigger)) errors.push(`unknown trigger ${String(window.trigger)}.`);
  if (!enumIncludes(REACTION_RESUME_STAGES, window.resume_stage)) errors.push(`unknown resume stage ${String(window.resume_stage)}.`);
  if (!Array.isArray(window.options) || window.options.length === 0) {
    errors.push('at least one option is required.');
  } else {
    for (const option of window.options) {
      if (!isNonEmptyString(option?.id)) errors.push('each option needs an id.');
      if (!isNonEmptyString(option?.label)) errors.push(`option ${String(option?.id)} needs a label.`);
      if (!isNonEmptyString(option?.type)) errors.push(`option ${String(option?.id)} needs a type.`);
    }
  }
  if (window.resume) {
    if (!enumIncludes(REACTION_RESUME_TYPES, window.resume.type)) errors.push(`unknown resume type ${String(window.resume.type)}.`);
    if (!enumIncludes(REACTION_RESUME_STAGES, window.resume.stage)) errors.push(`unknown resume stage ${String(window.resume.stage)}.`);
  }
  return errors;
}

function assertValidEntity(entity = {}) {
  const errors = validateEntity(entity);
  if (errors.length > 0) {
    throw new TypeError(`Invalid referee entity: ${errors.join(' ')}`);
  }
  return entity;
}

function validateEntity(entity = {}) {
  const errors = [];
  if (!isNonEmptyString(entity.id)) errors.push('id is required.');
  if (!enumIncludes(ENTITY_TYPES, entity.type)) errors.push(`unknown type ${String(entity.type)}.`);
  if (!isNonEmptyString(entity.name)) errors.push('name is required.');
  if (entity.aliases !== undefined && !Array.isArray(entity.aliases)) errors.push('aliases must be an array.');
  if (entity.visibility !== undefined && !isPlainObject(entity.visibility)) errors.push('visibility must be an object.');
  if (entity.interactions !== undefined && !isPlainObject(entity.interactions)) errors.push('interactions must be an object.');
  if (entity.position !== undefined && !isPlainObject(entity.position)) errors.push('position must be an object.');
  return errors;
}

function assertValidRulesEffects(rulesEffects = [], source = 'rules effect') {
  const errors = validateRulesEffects(rulesEffects);
  if (errors.length > 0) {
    throw new TypeError(`Invalid ${source}: ${errors.join(' ')}`);
  }
  return rulesEffects;
}

function validateRulesEffects(rulesEffects = []) {
  if (!Array.isArray(rulesEffects)) return ['rules effects must be an array.'];
  const errors = [];
  for (const rule of rulesEffects) {
    if (!isPlainObject(rule)) {
      errors.push('each rules effect must be an object.');
      continue;
    }
    if (!enumIncludes(RULES_EFFECT_TARGETS, rule.target)) {
      errors.push(`unknown target ${String(rule.target)}.`);
    }
  }
  return errors;
}

function assertValidAuthoritativeState(worldState = {}) {
  const errors = validateAuthoritativeState(worldState);
  if (errors.length > 0) {
    throw new TypeError(`Invalid authoritative world state: ${errors.join(' ')}`);
  }
  return worldState;
}

function validateAuthoritativeState(worldState = {}) {
  const errors = [];
  if (!isPlainObject(worldState)) return ['world state must be an object.'];
  if (worldState.pending_roll && worldState.pending_reaction) {
    errors.push('pending_roll and pending_reaction cannot both be open.');
  }
  if (worldState.pending_reaction) errors.push(...validatePendingReaction(worldState.pending_reaction));
  if (worldState.active_effects !== undefined && !Array.isArray(worldState.active_effects)) {
    errors.push('active_effects must be an array.');
  } else {
    for (const effect of worldState.active_effects || []) {
      if (effect?.rules_effects !== undefined) errors.push(...validateRulesEffects(effect.rules_effects));
    }
  }
  if (worldState.combat_state !== undefined && worldState.combat_state !== null && !isPlainObject(worldState.combat_state)) {
    errors.push('combat_state must be an object or null.');
  }
  if (worldState.object_states !== undefined && !isPlainObject(worldState.object_states)) {
    errors.push('object_states must be an object.');
  }
  if (worldState.inventory_state !== undefined) {
    if (!isPlainObject(worldState.inventory_state)) {
      errors.push('inventory_state must be an object.');
    } else if (
      worldState.inventory_state.carried_objects !== undefined
      && !Array.isArray(worldState.inventory_state.carried_objects)
    ) {
      errors.push('inventory_state.carried_objects must be an array.');
    }
  }
  return errors;
}

function createFrameId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function assertNonEmptyString(value, label) {
  if (!isNonEmptyString(value)) throw new TypeError(`${label} is required.`);
}

function assertEnum(value, enumObject, label) {
  if (!enumIncludes(enumObject, value)) {
    throw new TypeError(`${label} must be one of: ${Object.values(enumObject).join(', ')}.`);
  }
}

function enumIncludes(enumObject, value) {
  return Object.values(enumObject).includes(value);
}

function freezeValues(values) {
  return Object.freeze({ ...values });
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
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
  validateEntity,
  validatePendingReaction,
  validateRulesEffects,
};
