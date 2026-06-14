const { rollDie } = require('./dice');
const { rollD20WithMode } = require('./d20RollEngine');
const {
  applyDamage,
  applyHealing,
  formatDamageAdjustment,
  rollDamageFormula,
} = require('./damageHealingEngine');
const {
  resolveSpellCastLegality,
  inferGuidanceSkill,
  formatGuidanceLabel,
  getSpellActionResource,
} = require('./spellcastingEngine');
const {
  getAttackMode,
  getAttackModeSources,
  getConditionD20Modifier,
  formatConditionD20Sources,
  resolveSavingThrow,
} = require('./conditionEngine');
const {
  applyLuckyToImmediateD20,
  hasOriginFeat,
} = require('./originFeatEngine');
const { applyGiantAncestryOnHit } = require('./giantAncestryEngine');
const { clearPlayerHidden } = require('./hiddenStateEngine');
const { assertValidRulesEffects } = require('./refereeContracts');

const CONCENTRATION_DURATIONS = {
  bless: 'Concentration, up to 1 minute',
  dancing_lights: 'Concentration, up to 1 minute',
  detect_magic: 'Concentration, up to 10 minutes',
  faerie_fire: 'Concentration, up to 1 minute',
  guidance: 'Concentration, up to 1 minute',
  hex: 'Concentration, up to 1 hour',
  hunter_mark: 'Concentration, up to 1 hour',
  searing_smite: 'Concentration, up to 1 minute',
  shield_of_faith: 'Concentration, up to 10 minutes',
};

const SPELL_OUTCOMES = {
  chill_touch: { type: 'spell_attack', damage: '1d10', damage_type: 'necrotic' },
  fire_bolt: { type: 'spell_attack', damage: '1d10', damage_type: 'fire' },
  guiding_bolt: { type: 'spell_attack', damage: '4d6', damage_type: 'radiant', condition_on_hit: 'guiding_bolt_advantage', rider: 'The next attack against the target has advantage before the end of your next turn.' },
  produce_flame: { type: 'spell_attack', damage: '1d8', damage_type: 'fire' },
  magic_missile: { type: 'automatic_damage', darts: 3, damage: '1d4+1', damage_type: 'force' },
  cure_wounds: { type: 'healing', healing: '2d8+spell_mod' },
  healing_word: { type: 'healing', healing: '2d4+spell_mod' },
  hellish_rebuke: { type: 'saving_throw', save: 'dex', damage: '2d10', damage_type: 'fire', half_on_success: true },
  poison_spray: { type: 'saving_throw', save: 'con', damage: '1d12', damage_type: 'poison', half_on_success: false },
  sacred_flame: { type: 'saving_throw', save: 'dex', damage: '1d8', damage_type: 'radiant', half_on_success: false },
  thunderwave: { type: 'saving_throw', save: 'con', damage: '2d8', damage_type: 'thunder', half_on_success: true },
  command: { type: 'save_effect', save: 'wis', effect: 'The target obeys a one-word command on its next turn if the command is valid and not directly harmful.' },
  charm_person: { type: 'save_effect', save: 'wis', effect: 'The humanoid is charmed by you if it fails the save.' },
  faerie_fire: { type: 'save_effect', save: 'dex', effect: 'Failed targets are outlined, cannot benefit from invisibility, and attacks against them have advantage.' },
  sleep: { type: 'sleep_pool', dice: '5d8' },
};

const BONUS_DIE_RULES = {
  attack_roll_bonus_die: 'attack',
  saving_throw_bonus_die: 'save',
  ability_check_bonus_die: 'check',
};

function resolveSpellCast({ message, content, characterSheet, worldState = {} }) {
  const castWorldState = clearResolvedCombatState(worldState);
  const legality = resolveSpellCastLegality({ message, content, characterSheet, worldState: castWorldState });
  if (!legality) return null;
  if (legality.blocked) return legality;

  const { spell, known } = legality;
  let nextSheet = legality.characterSheet;
  let nextWorldState = {
    ...castWorldState,
    player_stats: {
      ...(castWorldState.player_stats || {}),
      spell_slots: nextSheet.spellcasting?.slots || castWorldState.player_stats?.spell_slots || {},
    },
  };

  const currentEffects = normalizeEffects(
    Array.isArray(castWorldState.active_effects)
      ? castWorldState.active_effects
      : nextSheet.derived_stats?.active_spell_effects || [],
  );
  const spellEffect = buildSpellEffect(nextSheet, spell, known, message, castWorldState);
  const targetBlock = validateRequiredSpellTarget({
    spell,
    spellEffect,
    message,
    worldState: castWorldState,
    characterSheet,
  });
  if (targetBlock) {
    return {
      matched: true,
      blocked: true,
      spell,
      known,
      characterSheet,
      reply: targetBlock.reply,
    };
  }

  if (spellEffect) {
    const retainedEffects = spellEffect.concentration
      ? currentEffects.filter((effect) => !effect.concentration)
      : currentEffects.filter((effect) => effect.id !== spell.id);
    const nextEffects = [...retainedEffects, spellEffect];
    nextSheet = applyActiveEffectsToCharacterSheet(nextSheet, nextEffects);
    nextWorldState = applyActiveEffectsToWorldState(nextWorldState, nextEffects, nextSheet);
  } else {
    nextSheet = applyActiveEffectsToCharacterSheet(nextSheet, currentEffects);
    nextWorldState = applyActiveEffectsToWorldState(nextWorldState, currentEffects, nextSheet);
  }

  return {
    matched: true,
    blocked: false,
    message,
    spell,
    characterSheet: nextSheet,
    worldState: nextWorldState,
    resourceNote: legality.resourceNote,
  };
}

function resolveSpellOutcome({ spellCast, characterSheet, worldState = {}, rollDie = defaultRollDie } = {}) {
  const spell = spellCast?.spell;
  if (!spell) return null;

  const rule = SPELL_OUTCOMES[spell.id];
  const stateWithMessage = clearResolvedCombatState({
    ...worldState,
    __spell_message: spellCast.message || '',
  });

  if (!rule) {
    return resolveUtilitySpell({ spell, worldState: stateWithMessage });
  }

  if (rule.type === 'spell_attack') {
    return resolveSpellAttack({ spell, rule, characterSheet, worldState: stateWithMessage, rollDie });
  }
  if (rule.type === 'automatic_damage') {
    return resolveAutomaticDamageSpell({ spell, rule, worldState: stateWithMessage, rollDie });
  }
  if (rule.type === 'saving_throw') {
    return resolveSavingThrowSpell({ spell, rule, characterSheet, worldState: stateWithMessage, rollDie });
  }
  if (rule.type === 'save_effect') {
    return resolveSaveEffectSpell({ spell, rule, characterSheet, worldState: stateWithMessage, rollDie });
  }
  if (rule.type === 'healing') {
    return resolveHealingSpell({ spell, rule, characterSheet, worldState: stateWithMessage, rollDie });
  }
  if (rule.type === 'sleep_pool') {
    return resolveSleepSpell({ spell, rule, worldState: stateWithMessage, rollDie });
  }

  return null;
}

function resolveSpellAttack({ spell, rule, characterSheet, worldState, rollDie }) {
  const context = getSpellTargetContext({ spell, spellCastMessage: worldState.__spell_message, worldState, characterSheet });
  if (!context?.target) return noSpellTarget(worldState, spell);
  let { combat, target } = context;
  const { activeCombat } = context;

  const attacker = getPlayerCombatant(combat, characterSheet, worldState);
  const baseAttackBonus = Number(characterSheet?.derived_stats?.spell_attack_bonus || 0);
  const activeAttackBonus = getActiveSpellAttackBonus(worldState, characterSheet);
  const conditionAttackBonus = getConditionD20Modifier(attacker);
  const attackBonus = baseAttackBonus + activeAttackBonus + conditionAttackBonus;
  const conditionMode = getAttackMode({ attacker, target });
  const activeAdvantageSources = getActiveSpellAttackAdvantageSources(worldState, characterSheet);
  const attackSources = [
    ...getAttackModeSources({ attacker, target }),
    ...activeAdvantageSources,
  ];
  const lucky = applyLuckyToImmediateD20({
    message: worldState.__spell_message,
    worldState,
    characterSheet,
    advantageMode: combineAdvantageModes(conditionMode, activeAdvantageSources.length ? 'advantage' : null),
    sources: attackSources,
  });
  const attackMode = lucky.advantageMode;
  const attackRoll = rollD20WithMode(rollDie, attackMode);
  const natural = attackRoll.natural;
  const total = natural + attackBonus;
  const criticalHit = natural === 20;
  const criticalMiss = natural === 1;
  const hit = !criticalMiss && (criticalHit || total >= Number(target.ac || 10));
  const lines = [
    `You cast **${spell.name}** at ${target.name}. Spell attack: ${attackRoll.text}${formatSigned(attackBonus)} = ${total} vs AC ${target.ac}.`,
  ];
  if (activeAttackBonus) {
    lines.push(`Active spell attack bonus: ${getActiveSpellAttackSources(worldState, characterSheet).join(', ')} ${formatSigned(activeAttackBonus)}.`);
  }
  if (conditionAttackBonus) {
    lines.push(`Condition modifier: ${formatConditionD20Sources(attacker).join(', ')}.`);
  }
  if (attackMode) {
    lines.push(`Spell attack has ${attackMode} from ${formatList(lucky.sources)}.`);
  }
  if (lucky.note) lines.push(lucky.note);
  let outcomeWorldState = lucky.worldState;

  if (hit) {
    const damage = rollFormula(rule.damage, rollDie, { crit: criticalHit });
    const applied = applyDamage({ target, amount: damage.total, damageType: rule.damage_type, source: spell.name });
    Object.assign(target, applied.target);
    lines.push(`${criticalHit ? '**Critical hit.** ' : ''}Hit for ${applied.amount} ${rule.damage_type} damage${formatDamageAdjustment(applied.adjustment)}. ${target.name}: (${applied.beforeHp} -> ${target.hp} HP).`);
    const ancestry = applyGiantAncestryOnHit({
      message: worldState.__spell_message,
      target,
      combat,
      worldState: { ...outcomeWorldState, combat_state: combat },
      characterSheet,
      damageDealt: applied.amount,
      crit: criticalHit,
      rollDie,
    });
    combat = ancestry.combat;
    outcomeWorldState = activeCombat
      ? ancestry.worldState
      : { ...ancestry.worldState, combat_state: lucky.worldState.combat_state || null };
    lines.push(...ancestry.lines);
    if (rule.condition_on_hit && Number(target.hp) > 0) {
      target.conditions = addCondition(target.conditions, rule.condition_on_hit);
    }
    if (rule.rider) lines.push(rule.rider);
  } else if (criticalMiss) {
    lines.push('**Critical miss.** The spell goes wide, and magic pretends it meant to do that.');
  } else {
    lines.push('Miss.');
  }

  return finishSpellAction({ spell, worldState: outcomeWorldState, combat, lines, activeCombat });
}

function resolveAutomaticDamageSpell({ spell, rule, worldState, rollDie }) {
  const context = getSpellTargetContext({ spell, spellCastMessage: worldState.__spell_message, worldState });
  if (!context?.target) return noSpellTarget(worldState, spell);
  const { combat, target, activeCombat } = context;

  const rolls = Array.from({ length: Number(rule.darts || 1) }, () => rollFormula(rule.damage, rollDie));
  const total = rolls.reduce((sum, roll) => sum + roll.total, 0);
  const applied = applyDamage({ target, amount: total, damageType: rule.damage_type, source: spell.name });
  Object.assign(target, applied.target);
  const lines = [
    `You cast **${spell.name}** at ${target.name}. The spell hits automatically for ${applied.amount} ${rule.damage_type} damage${formatDamageAdjustment(applied.adjustment)}. ${target.name}: (${applied.beforeHp} -> ${target.hp} HP).`,
  ];

  return finishSpellAction({ spell, worldState, combat, lines, activeCombat });
}

function resolveSavingThrowSpell({ spell, rule, characterSheet, worldState, rollDie }) {
  const context = getSpellTargetContext({ spell, spellCastMessage: worldState.__spell_message, worldState });
  if (!context?.target) return noSpellTarget(worldState, spell);
  const { combat, target, activeCombat } = context;

  const dcBonus = getActiveSpellSaveDcBonus(worldState, characterSheet);
  const dc = Number(characterSheet?.derived_stats?.spell_save_dc || 10) + dcBonus;
  const saveBonus = getTargetSaveBonus(target, rule.save);
  const save = resolveSavingThrow({ target, ability: rule.save, dc, rollDie, bonus: saveBonus });
  const success = save.success;
  const damage = rollFormula(rule.damage, rollDie);
  const appliedDamage = success && rule.half_on_success ? Math.floor(damage.total / 2) : success ? 0 : damage.total;
  const applied = applyDamage({ target, amount: appliedDamage, damageType: rule.damage_type, source: spell.name });
  Object.assign(target, applied.target);

  const lines = [
    `You cast **${spell.name}** at ${target.name}. ${target.name} rolls a ${rule.save.toUpperCase()} save: ${save.automaticFailure ? save.text : `${save.text} vs DC ${dc}`}.`,
    success
      ? `Save succeeds.${applied.amount ? ` ${target.name} still takes ${applied.amount} ${rule.damage_type} damage${formatDamageAdjustment(applied.adjustment)}. ${target.name}: (${applied.beforeHp} -> ${target.hp} HP).` : ' No damage is applied.'}`
      : `Save fails. ${target.name} takes ${applied.amount} ${rule.damage_type} damage${formatDamageAdjustment(applied.adjustment)}. ${target.name}: (${applied.beforeHp} -> ${target.hp} HP).`,
  ];
  if (dcBonus) lines.push(`Spell save DC includes ${formatSigned(dcBonus)} from ${formatList(getActiveSpellSaveDcSources(worldState, characterSheet))}.`);

  return finishSpellAction({ spell, worldState, combat, lines, activeCombat });
}

function resolveSaveEffectSpell({ spell, rule, characterSheet, worldState, rollDie }) {
  const context = getSpellTargetContext({ spell, spellCastMessage: worldState.__spell_message, worldState });
  if (!context?.target) return noSpellTarget(worldState, spell);
  const { combat, target, activeCombat } = context;

  const dcBonus = getActiveSpellSaveDcBonus(worldState, characterSheet);
  const dc = Number(characterSheet?.derived_stats?.spell_save_dc || 10) + dcBonus;
  const saveBonus = getTargetSaveBonus(target, rule.save);
  const save = resolveSavingThrow({ target, ability: rule.save, dc, rollDie, bonus: saveBonus });
  const success = save.success;
  const lines = [
    `You cast **${spell.name}** at ${target.name}. ${target.name} rolls a ${rule.save.toUpperCase()} save: ${save.automaticFailure ? save.text : `${save.text} vs DC ${dc}`}.`,
    success ? 'Save succeeds. The spell does not take hold.' : `Save fails. ${rule.effect}`,
  ];
  if (dcBonus) lines.push(`Spell save DC includes ${formatSigned(dcBonus)} from ${formatList(getActiveSpellSaveDcSources(worldState, characterSheet))}.`);
  if (!success) {
    target.conditions = addCondition(target.conditions, spell.id);
  }
  const effectState = !success && spellHasDuration(spell)
    ? addSpellEffectToWorldState({
        worldState: { ...worldState, combat_state: combat },
        spell,
        effect: {
          id: spell.id,
          name: spell.name,
          source_type: 'spell',
          target: target.name,
          target_combatant_id: target.id || null,
          duration: normalizeSpellDuration(spell),
          concentration: isConcentrationDuration(normalizeSpellDuration(spell)),
          mechanical_effect: rule.effect,
          rules_effects: [],
          ...durationToRemaining(normalizeSpellDuration(spell)),
        },
      })
    : { ...worldState, combat_state: combat };

  return finishSpellAction({ spell, worldState: effectState, combat: effectState.combat_state, lines, activeCombat });
}

function resolveSleepSpell({ spell, rule, worldState, rollDie }) {
  const context = getSpellTargetContext({ spell, spellCastMessage: worldState.__spell_message, worldState, allowMultiple: true });
  if (!context?.target) return noSpellTarget(worldState, spell);
  const { combat, activeCombat } = context;

  const pool = rollFormula(rule.dice, rollDie);
  let remainingPool = pool.total;
  const eligibleTargets = (combat.combatants || [])
    .filter((combatant) => !combatant.is_player && Number(combatant.hp) > 0)
    .sort((a, b) => Number(a.hp || 0) - Number(b.hp || 0));
  const affected = [];
  const lines = [
    `You cast **${spell.name}**. Sleep pool: ${pool.rolls.join(' + ')} = ${pool.total} HP.`,
  ];

  for (const target of eligibleTargets) {
    const hp = Number(target.hp || 0);
    if (hp > remainingPool) continue;
    target.conditions = addCondition(target.conditions, 'sleep');
    affected.push(target);
    remainingPool -= hp;
  }

  if (affected.length > 0) {
    const targetText = affected.map((target) => `${target.name} (${target.hp} HP)`).join(', ');
    lines.push(`${targetText} ${affected.length === 1 ? 'falls' : 'fall'} **unconscious** until damaged, shaken awake, or the spell ends.`);
  } else {
    lines.push('No eligible creature has low enough current HP for the spell pool. Sleep does not take hold.');
  }

  const effectState = affected.length > 0
    ? addSpellEffectToWorldState({
        worldState: { ...worldState, combat_state: combat },
        effect: {
          id: 'sleep',
          name: 'Sleep',
          source_type: 'spell',
          target: affected.map((target) => target.name).join(', '),
          targets: affected.map((target) => ({ name: target.name, id: target.id || null })),
          duration: spell.duration || '1 minute',
          concentration: false,
          mechanical_effect: 'The target is asleep until damaged, awakened, or the spell ends.',
          rules_effects: [],
          ...durationToRemaining(spell.duration || '1 minute'),
        },
      })
    : { ...worldState, combat_state: combat };

  return finishSpellAction({ spell, worldState: effectState, combat: effectState.combat_state, lines, activeCombat });
}

function resolveHealingSpell({ spell, rule, characterSheet, worldState, rollDie }) {
  const combat = cloneCombatState(worldState.combat_state);
  const player = combat.combatants.find((combatant) => combatant.is_player) || null;
  const spellMod = getSpellcastingModifier(characterSheet);
  const healing = rollFormula(rule.healing, rollDie, {
    spellMod,
    rerollOnes: hasOriginFeat(characterSheet, 'healer'),
  });
  const stats = worldState.player_stats || {};
  const healingTarget = player || {
    hp: stats.hp ?? characterSheet?.derived_stats?.hp ?? 0,
    max_hp: stats.max_hp ?? characterSheet?.derived_stats?.max_hp ?? stats.hp ?? 0,
  };
  const healed = applyHealing({
    target: healingTarget,
    amount: healing.total,
    maxHp: player?.max_hp ?? stats.max_hp ?? characterSheet?.derived_stats?.max_hp,
  });
  if (player) player.hp = healed.target.hp;

  const nextState = {
    ...stripInternalState(worldState),
    combat_state: combat.active ? combat : worldState.combat_state,
    player_stats: {
      ...stats,
      hp: healed.target.hp,
      max_hp: healed.target.max_hp,
    },
  };
  const lines = [
    `You cast **${spell.name}** and restore ${healing.total} HP. HP: (${healed.beforeHp} -> ${healed.afterHp}).`,
  ];

  return {
    handled: true,
    logType: 'spell_healing',
    spell,
    worldState: nextState,
    reply: lines.join('\n\n'),
    consumesTurn: consumesCombatTurn(spell),
  };
}

function resolveUtilitySpell({ spell, worldState }) {
  const effectSummary = formatUtilitySpellEffectSummary(spell, worldState);
  return {
    handled: true,
    logType: 'spell_utility',
    spell,
    worldState: stripInternalState(worldState),
    reply: `You cast **${spell.name}**.${effectSummary ? ` ${effectSummary}` : ''} Its effect is now active in the scene: ${spell.description}`,
    consumesTurn: consumesCombatTurn(spell),
  };
}

function formatUtilitySpellEffectSummary(spell = {}, worldState = {}) {
  const effect = normalizeEffects(worldState.active_effects || []).find((item) => item.id === spell.id);
  if (!effect) return '';

  const rules = effect.rules_effects || [];
  const targetText = effect.target ? ` on ${effect.target}` : '';
  const armorBonus = rules.find((rule) => rule.target === 'armor_class_bonus');
  if (armorBonus) {
    const ac = worldState.player_stats?.armor_class;
    return `A defensive effect settles${targetText}; AC is now ${ac ?? `increased by ${formatSigned(Number(armorBonus.value || 0))}`} while it lasts.`;
  }

  const tempHp = rules.find((rule) => rule.target === 'temp_hp');
  if (tempHp) {
    const temp = worldState.player_stats?.temp_hp;
    return `Protective force gathers${targetText}; temporary HP is now ${temp ?? tempHp.value}.`;
  }

  const bonusDice = rules
    .filter((rule) => rule.die)
    .map((rule) => `${rule.die} ${String(rule.target || 'bonus').replaceAll('_', ' ')}`);
  if (bonusDice.length) return `The active benefit is ${bonusDice.join(', ')}${targetText}.`;

  return targetText ? `It is now affecting${targetText}.` : '';
}

function finishSpellAction({ spell, worldState, combat, lines, activeCombat }) {
  if (!activeCombat) {
    return {
      handled: true,
      logType: 'spell_scene',
      spell,
      worldState: stripInternalState(persistSceneTargetStates({ ...worldState, combat_state: worldState.combat_state || null }, combat)),
      reply: lines.join('\n\n'),
      consumesTurn: false,
    };
  }

  const reveal = clearPlayerHidden({ worldState: { ...worldState, combat_state: combat }, reason: 'spell' });
  if (reveal.revealed) {
    worldState = reveal.worldState;
    combat = reveal.combat;
    lines.push(reveal.line);
  }

  const enemiesAlive = combat.combatants.some((combatant) => !combatant.is_player && Number(combatant.hp) > 0);
  const preserveCombatState = Boolean(worldState.__preserve_combat_state);
  const nextState = {
    ...stripInternalState(worldState),
    combat_state: enemiesAlive || preserveCombatState ? combat : null,
  };
  const reply = enemiesAlive || preserveCombatState
    ? lines.join('\n\n')
    : `${lines.join('\n\n')}\n\nAll active enemies are down. **Combat ends.**`;

  return {
    handled: true,
    logType: 'spell_combat',
    spell,
    worldState: nextState,
    reply,
    consumesTurn: enemiesAlive && consumesCombatTurn(spell),
  };
}

function addSpellEffectToWorldState({ worldState, effect }) {
  const currentEffects = normalizeEffects(worldState.active_effects || []);
  const retainedEffects = effect.concentration
    ? currentEffects.filter((item) => !item.concentration)
    : currentEffects.filter((item) => item.id !== effect.id);
  return applyActiveEffectsToWorldState(worldState, [...retainedEffects, effect]);
}

function addCondition(conditions = [], condition) {
  return [...new Set([...(conditions || []), condition].filter(Boolean))];
}

function validateRequiredSpellTarget({ spell, spellEffect, message = '', worldState = {}, characterSheet = {} } = {}) {
  const rule = SPELL_OUTCOMES[spell.id];
  const ruleRequiresTarget = ['spell_attack', 'automatic_damage', 'saving_throw', 'save_effect', 'sleep_pool'].includes(rule?.type);
  const effectRequiresTarget = (spellEffect?.rules_effects || []).some((effect) => effect.target_bound);
  if (!ruleRequiresTarget && !effectRequiresTarget) return null;

  const context = getSpellTargetContext({
    spell,
    spellCastMessage: message,
    worldState,
    characterSheet,
    allowMultiple: rule?.type === 'sleep_pool',
  });
  return context?.target ? null : noSpellTarget(worldState, spell);
}

function getSpellTargetContext({ spell, spellCastMessage = '', worldState = {}, characterSheet = {}, allowMultiple = false } = {}) {
  if (worldState.combat_state?.active) {
    const combat = cloneCombatState(worldState.combat_state);
    const requestedId = normalizeName(worldState.__spell_target_id);
    const requestedName = normalizeName(worldState.__spell_target_name || inferSpellTargetName(spellCastMessage, worldState, spell));
    const hasRequestedTarget = Boolean(requestedId || requestedName);
    const target = (combat.combatants || []).find((combatant) => (
      !combatant.is_player
      && Number(combatant.hp) > 0
      && (
        (requestedId && normalizeName(combatant.id) === requestedId)
        || (requestedName && targetNamesMatch(combatant.name, requestedName))
      )
    ));
    if (target) return { combat, target, activeCombat: true };
    if (hasRequestedTarget) return null;
    const fallback = firstEnemy(combat);
    if (fallback) return { combat, target: fallback, activeCombat: true };
  }

  const explicitTarget = inferSpellTargetName(spellCastMessage, worldState, spell);
  const targetNames = getSceneSpellTargets({ explicitTarget, worldState, allowMultiple });
  if (targetNames.length === 0) return null;

  const combatants = targetNames.map((name) => buildSceneTargetCombatant(name, worldState));
  return {
    combat: {
      active: false,
      round: 0,
      turn_index: 0,
      combatants,
    },
    target: combatants[0],
    activeCombat: false,
  };
}

function getSceneSpellTargets({ explicitTarget, worldState = {}, allowMultiple = false }) {
  const presentNpcs = (worldState.scene_presence?.present_npcs || []).filter(Boolean);
  const trackedTargets = (worldState.scene_target_states || []).map((target) => target.name).filter(Boolean);
  const candidates = [...new Set([...presentNpcs, ...trackedTargets])];

  if (explicitTarget) {
    const matched = candidates.find((candidate) => targetNamesMatch(candidate, explicitTarget));
    if (matched) return [matched];
    return [];
  }

  if (allowMultiple && candidates.length > 0) return candidates;
  if (candidates.length === 1) return [candidates[0]];
  return [];
}

function buildSceneTargetCombatant(name, worldState = {}) {
  const existing = (worldState.scene_target_states || []).find((target) => targetNamesMatch(target.name, name)) || {};
  return {
    id: existing.id || normalizeName(name),
    name,
    hp: Number(existing.hp ?? existing.max_hp ?? 8),
    max_hp: Number(existing.max_hp ?? existing.hp ?? 8),
    ac: Number(existing.ac ?? 10),
    conditions: Array.isArray(existing.conditions) ? existing.conditions : [],
    resistances: existing.resistances || existing.damage_resistances || [],
    vulnerabilities: existing.vulnerabilities || existing.damage_vulnerabilities || [],
    immunities: existing.immunities || existing.damage_immunities || [],
    saves: existing.saves || { dex: 1, con: 1, wis: 0, str: 1, int: 0, cha: 0 },
    is_player: false,
    scene_target: true,
  };
}

function getPlayerCombatant(combat, characterSheet = {}, worldState = {}) {
  return (combat.combatants || []).find((combatant) => combatant.is_player) || {
    character_id: worldState.player_stats?.character_id || characterSheet?.derived_stats?.character_id || null,
    name: characterSheet?.identity?.name || worldState.player_stats?.name || 'You',
    conditions: uniqueValues([...(characterSheet?.derived_stats?.conditions || []), ...(worldState.player_stats?.conditions || [])]),
    exhaustion_level: worldState.player_stats?.exhaustion_level ?? characterSheet?.derived_stats?.exhaustion_level ?? null,
    resistances: uniqueValues([...(characterSheet.resistances || []), ...(worldState.player_stats?.resistances || [])]),
    is_player: true,
  };
}

function persistSceneTargetStates(worldState = {}, combat = {}) {
  const sceneTargets = (combat.combatants || []).filter((combatant) => !combatant.is_player && combatant.scene_target);
  if (sceneTargets.length === 0) return worldState;

  const existing = Array.isArray(worldState.scene_target_states) ? worldState.scene_target_states : [];
  const byName = new Map(existing.map((target) => [normalizeName(target.name), target]));
  for (const target of sceneTargets) {
    byName.set(normalizeName(target.name), {
      ...(byName.get(normalizeName(target.name)) || {}),
      id: target.id || normalizeName(target.name),
      name: target.name,
      hp: Number(target.hp || 0),
      max_hp: Number(target.max_hp || target.hp || 0),
      ac: Number(target.ac || 10),
      conditions: target.conditions || [],
      resistances: target.resistances || [],
      vulnerabilities: target.vulnerabilities || [],
      immunities: target.immunities || [],
      saves: target.saves || {},
    });
  }

  return {
    ...worldState,
    scene_target_states: [...byName.values()],
  };
}

function inferSpellTargetName(message = '', worldState = {}, spell = {}) {
  if (/self/i.test(spell.range || '') || /\b(?:myself|self|me)\b/i.test(message || '')) {
    return null;
  }

  const targetMatch = String(message || '').match(/\b(?:at|on|toward|towards|to)\s+(?:the\s+|a\s+|an\s+)?([a-z][a-z' -]{1,40}?)(?:\s+(?:with|while|because|before|after|and|then|using|for)\b|[.!?]|$)/i);
  const rawTarget = targetMatch?.[1] ? cleanTargetName(targetMatch[1]) : '';
  if (rawTarget) return rawTarget;

  const present = worldState.scene_presence?.present_npcs || [];
  if (present.length === 1) return present[0];
  return '';
}

function cleanTargetName(value) {
  return String(value || '')
    .replace(/\b(myself|self|me)\b/i, '')
    .replace(/\b(the|a|an)\b/gi, '')
    .trim();
}

function targetNamesMatch(a, b) {
  const leftNames = comparableTargetNames(a);
  const rightNames = comparableTargetNames(b);
  return leftNames.some((left) => rightNames.some((right) => (
    left === right || left.includes(right) || right.includes(left)
  )));
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeComparableId(value) {
  return normalizeName(value).replace(/\s+/g, '');
}

function isWeaponMagicAlreadyInSheet(characterSheet = {}, attack = {}, effect = {}) {
  const weaponKey = normalizeComparableId(attack.weaponId || attack.weapon_id || attack.name);
  const sourceKey = normalizeComparableId(effect.source_item_id || effect.sourceItemId || effect.source_item_name || effect.sourceItemName || effect.name);
  if (!weaponKey || !sourceKey) return false;
  if (!weaponKey.includes(sourceKey) && !sourceKey.includes(weaponKey)) return false;

  return (characterSheet?.derived_stats?.attack_breakdowns || [])
    .filter((entry) => {
      const entryKey = normalizeComparableId(entry.weapon_id || entry.weaponId || entry.name);
      return entryKey && (entryKey.includes(weaponKey) || weaponKey.includes(entryKey));
    })
    .some((entry) => [...(entry.attack_parts || []), ...(entry.damage_parts || [])]
      .some((part) => /weapon magic/i.test(String(part.label || part.source || ''))));
}

function comparableTargetNames(value) {
  const normalized = normalizeName(value);
  const stripped = normalized
    .replace(/\b(?:injured|wounded|collapsed|fallen|reeling|unknown|hooded)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...new Set([normalized, stripped].filter(Boolean))];
}

function uniqueValues(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

function stripInternalState(worldState = {}) {
  const {
    __preserve_combat_state: ignoredPreserve,
    __spell_message: ignoredMessage,
    __spell_target_id: ignoredTargetId,
    __spell_target_name: ignoredTargetName,
    ...clean
  } = worldState;
  return clean;
}

function formatList(items = []) {
  const list = (items || []).filter(Boolean);
  if (list.length === 0) return 'the rules';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function noSpellTarget(worldState, spell) {
  return {
    handled: true,
    logType: 'spell_no_target',
    spell,
    worldState: stripInternalState(worldState),
    reply: `${spell.name} needs a valid target in the current scene. Name who or what you are targeting before the magic gets ideas above its station.`,
    consumesTurn: false,
  };
}

function buildSpellEffect(characterSheet, spell, known, message = '', worldState = {}) {
  if (!spellHasDuration(spell)) return null;
  const outcomeRule = SPELL_OUTCOMES[spell.id];
  if (outcomeRule?.type === 'save_effect' || outcomeRule?.type === 'sleep_pool') return null;
  const actor = characterSheet.identity?.name || 'active character';
  const duration = normalizeSpellDuration(spell);
  const guidanceSkill = spell.id === 'guidance' ? inferGuidanceSkill(message) : null;
  const targetName = spell.range === 'Self' || isSelfTargetedSpellMessage(message)
    ? actor
    : inferSpellTargetName(message, worldState, spell) || firstEnemy(worldState.combat_state || {})?.name || 'current scene target';
  return {
    id: spell.id,
    name: spell.name,
    source: actor,
    source_type: 'spell',
    spell_source: known.label,
    target: targetName,
    duration,
    concentration: isConcentrationDuration(duration),
    guidance_skill: guidanceSkill,
    spellcasting_modifier: getSpellcastingModifier(characterSheet),
    mechanical_effect: spell.description,
    rules_effects: getRulesEffectsForSpell(spell, { message }),
    ...durationToRemaining(duration),
    ...(spell.id === 'shield' ? { expires_at_start_of_player_turn: true } : {}),
  };
}

function isSelfTargetedSpellMessage(message = '') {
  return /\b(?:myself|self|me)\b/i.test(message || '');
}

function spellHasDuration(spell) {
  return spell?.duration && !/^instant$/i.test(spell.duration);
}

function normalizeSpellDuration(spell) {
  if (!spell) return '';
  if (/^concentration$/i.test(spell.duration || '') && CONCENTRATION_DURATIONS[spell.id]) {
    return CONCENTRATION_DURATIONS[spell.id];
  }
  return spell.duration || '';
}

function isConcentrationDuration(duration = '') {
  return /concentration/i.test(duration);
}

function durationToRemaining(duration = '') {
  const minuteMatch = duration.match(/(\d+)\s*minute/i);
  if (minuteMatch) {
    const minutes = Number(minuteMatch[1]);
    return { remaining_minutes: minutes, remaining_rounds: minutes * 10 };
  }
  const hourMatch = duration.match(/(\d+)\s*hour/i);
  if (hourMatch) {
    const hours = Number(hourMatch[1]);
    return { remaining_minutes: hours * 60, remaining_rounds: hours * 600 };
  }
  if (/1 round/i.test(duration)) return { remaining_rounds: 1 };
  return {};
}

function getRulesEffectsForSpell(spell, { message = '' } = {}) {
  const guidanceSkill = spell.id === 'guidance'
    ? spell.guidance_skill || spell.skill || inferGuidanceSkill(message)
    : null;
  const effectsBySpell = {
    armor_of_agathys: [
      { target: 'temp_hp', value: 5, label: 'Armor of Agathys' },
      { target: 'melee_retaliation_damage', value: 5, damage_type: 'cold', label: 'Armor of Agathys' },
    ],
    bless: [
      { target: 'attack_roll_bonus_die', die: '1d4', label: 'Bless' },
      { target: 'saving_throw_bonus_die', die: '1d4', label: 'Bless' },
    ],
    divine_favor: [
      { target: 'weapon_damage_bonus_die', die: '1d4', damage_type: 'radiant', label: 'Divine Favor' },
    ],
    guidance: [
      { target: 'ability_check_bonus_die', die: '1d4', label: formatGuidanceLabel(guidanceSkill), skill: guidanceSkill },
    ],
    heroism: [
      { target: 'fear_immunity', label: 'Heroism' },
      { target: 'temp_hp_each_turn', value: 'spell_mod_min_1', label: 'Heroism' },
    ],
    hex: [
      { target: 'weapon_damage_bonus_die', die: '1d6', damage_type: 'necrotic', label: 'Hex', target_bound: true },
    ],
    hunter_mark: [
      { target: 'weapon_damage_bonus_die', die: '1d6', damage_type: 'force', label: "Hunter's Mark", target_bound: true },
    ],
    mage_armor: [
      { target: 'armor_formula', base: 13, dex_cap: null, label: 'Mage Armor' },
    ],
    searing_smite: [
      { target: 'weapon_damage_bonus_die', die: '1d6', damage_type: 'fire', label: 'Searing Smite', expires_on_hit: true },
    ],
    shield: [
      { target: 'armor_class_bonus', value: 5, label: 'Shield' },
    ],
    shield_of_faith: [
      { target: 'armor_class_bonus', value: 2, label: 'Shield of Faith' },
    ],
  };

  if (effectsBySpell[spell.id]) {
    return assertValidRulesEffects(effectsBySpell[spell.id], `rules effects for ${spell.id}`);
  }
  return [];
}

function tickActiveEffects(worldState = {}, { rounds = 0, minutes = 0 } = {}) {
  const effects = normalizeEffects(worldState.active_effects || []);
  if (effects.length === 0 || (rounds <= 0 && minutes <= 0)) {
    return { worldState, expiredEffects: [] };
  }

  const elapsedRounds = Number(rounds || 0) + Number(minutes || 0) * 10;
  const expiredEffects = [];
  const nextEffects = [];

  for (const effect of effects) {
    const nextEffect = { ...effect };
    if (nextEffect.remaining_rounds != null) {
      nextEffect.remaining_rounds = Math.max(0, Number(nextEffect.remaining_rounds) - elapsedRounds);
      nextEffect.remaining_minutes = Math.ceil(nextEffect.remaining_rounds / 10);
    } else if (nextEffect.remaining_minutes != null && minutes > 0) {
      nextEffect.remaining_minutes = Math.max(0, Number(nextEffect.remaining_minutes) - Number(minutes));
    }

    if (nextEffect.remaining_rounds === 0 || nextEffect.remaining_minutes === 0) {
      expiredEffects.push(nextEffect);
    } else {
      nextEffects.push(nextEffect);
    }
  }

  let nextWorldState = applyActiveEffectsToWorldState(worldState, nextEffects);
  if (expiredEffects.length > 0) {
    nextWorldState = clearExpiredEffectState(nextWorldState, expiredEffects);
  }

  return {
    worldState: nextWorldState,
    expiredEffects,
  };
}

function clearExpiredEffectState(worldState, expiredEffects = []) {
  const expiredIds = new Set(expiredEffects.map((effect) => effect.id).filter(Boolean));
  const expiredTempHp = expiredEffects.some((effect) => (
    normalizeEffects([effect]).flatMap((item) => item.rules_effects || [])
      .some((rule) => rule.target === 'temp_hp' || rule.target === 'temp_hp_each_turn')
  ));
  const clearConditions = (conditions = []) => (conditions || []).filter((condition) => !expiredIds.has(String(condition)));
  const combat = worldState.combat_state?.active
    ? {
        ...worldState.combat_state,
        combatants: (worldState.combat_state.combatants || []).map((combatant) => ({
          ...combatant,
          conditions: clearConditions(combatant.conditions),
          temp_hp: combatant.is_player && expiredTempHp ? 0 : combatant.temp_hp,
        })),
      }
    : worldState.combat_state;

  return {
    ...worldState,
    combat_state: combat,
    player_stats: {
      ...(worldState.player_stats || {}),
      conditions: clearConditions(worldState.player_stats?.conditions || []),
      temp_hp: expiredTempHp ? 0 : worldState.player_stats?.temp_hp,
    },
  };
}

function cloneCombatState(combatState) {
  return JSON.parse(JSON.stringify(combatState || { active: false, round: 1, turn_index: 0, combatants: [] }));
}

function clearResolvedCombatState(worldState = {}) {
  if (!worldState.combat_state?.active) return worldState;
  const enemiesAlive = (worldState.combat_state.combatants || [])
    .some((combatant) => !combatant.is_player && Number(combatant.hp || 0) > 0);
  return enemiesAlive ? worldState : { ...worldState, combat_state: null };
}

function firstEnemy(combat) {
  return (combat.combatants || []).find((combatant) => !combatant.is_player && Number(combatant.hp) > 0) || null;
}

function getTargetSaveBonus(target = {}, ability) {
  return Number(
    target.saves?.[ability]
      ?? target.save_modifiers?.[ability]
      ?? target.ability_modifiers?.[ability]
      ?? 1,
  );
}

function getSpellcastingModifier(characterSheet = {}) {
  const ability = characterSheet.spellcasting?.ability;
  return Number(characterSheet.abilities?.modifiers?.[ability] || 0);
}

function consumesCombatTurn(spell = {}) {
  return getSpellActionResource(spell) === 'action';
}

function rollFormula(formula, rollDie, { crit = false, spellMod = 0, rerollOnes = false } = {}) {
  return rollDamageFormula(formula, rollDie, { crit, spellMod, rerollOnes });
}

function defaultRollDie(sides) {
  return rollDie(sides);
}

function formatSigned(value) {
  const number = Number(value || 0);
  return number >= 0 ? `+${number}` : String(number);
}

function applyActiveEffectsToCharacterSheet(characterSheet = {}, effects = []) {
  const normalizedEffects = normalizeEffects(effects);
  const visibleActiveEffects = normalizedEffects.filter((effect) => !isEquipmentEffect(effect));
  const derived = characterSheet.derived_stats || {};
  const currentBreakdown = derived.armor_class_breakdown || [];
  const currentSpellArmorBonus = sumSpellArmorBreakdown(currentBreakdown);
  const naturalBaseArmorClass = Number(
    derived.natural_base_armor_class
      ?? derived.base_armor_class
      ?? (Number(derived.armor_class || 10) - currentSpellArmorBonus),
  );
  const baseArmorClass = Math.max(naturalBaseArmorClass, getArmorFormulaBase(normalizedEffects, characterSheet));
  const spellArmorBonus = sumArmorBonusEffects(normalizedEffects);
  return {
    ...characterSheet,
    derived_stats: {
      ...derived,
      natural_base_armor_class: naturalBaseArmorClass,
      base_armor_class: baseArmorClass,
      armor_class: baseArmorClass + spellArmorBonus,
      armor_class_breakdown: [
        ...currentBreakdown.filter((part) => !isSpellArmorBreakdown(part)),
        ...buildSpellArmorBreakdown(normalizedEffects),
      ],
      active_spell_effects: visibleActiveEffects,
    },
  };
}

function isEquipmentEffect(effect = {}) {
  return effect.source_type === 'equipment'
    || String(effect.id || '').startsWith('equipment_');
}

function applyActiveEffectsToWorldState(worldState = {}, effects = [], characterSheet = null) {
  const normalizedEffects = normalizeEffects(effects);
  const stats = worldState.player_stats || {};
  const currentSpellArmorBonus = sumArmorBonusEffects(worldState.active_effects || []);
  const sheetArmor = characterSheet?.derived_stats?.armor_class;
  const naturalBaseArmorClass = Number(
    characterSheet?.derived_stats?.natural_base_armor_class
      ?? characterSheet?.derived_stats?.base_armor_class
      ?? stats.natural_base_armor_class
      ?? stats.base_armor_class
      ?? ((stats.armor_class ?? sheetArmor ?? 10) - currentSpellArmorBonus),
  );
  const baseArmorClass = Math.max(naturalBaseArmorClass, getArmorFormulaBase(normalizedEffects, characterSheet));
  const spellArmorBonus = sumArmorBonusEffects(normalizedEffects);
  const nextArmorClass = baseArmorClass + spellArmorBonus;
  const previousEffectIds = new Set((worldState.active_effects || []).map((effect) => effect.id).filter(Boolean));
  const newlyAppliedEffects = normalizedEffects.filter((effect) => !previousEffectIds.has(effect.id));
  const tempHpEffect = getTempHpFromEffects(newlyAppliedEffects);
  const nextTempHp = tempHpEffect > 0
    ? Math.max(Number(stats.temp_hp || 0), tempHpEffect)
    : stats.temp_hp;
  const nextCombatState = worldState.combat_state?.active
    ? {
        ...worldState.combat_state,
        combatants: (worldState.combat_state.combatants || []).map((combatant) => (
          combatant.is_player ? { ...combatant, ac: nextArmorClass, temp_hp: nextTempHp } : combatant
        )),
      }
    : worldState.combat_state;

  return {
    ...worldState,
    active_effects: normalizedEffects,
    combat_state: nextCombatState,
    player_stats: {
      ...stats,
      natural_base_armor_class: naturalBaseArmorClass,
      base_armor_class: baseArmorClass,
      armor_class: nextArmorClass,
      temp_hp: nextTempHp,
      spell_slots: characterSheet?.spellcasting?.slots || stats.spell_slots || {},
    },
  };
}

function normalizeEffects(effects = []) {
  return (Array.isArray(effects) ? effects : []).map((effect) => ({
    ...effect,
    rules_effects: Array.isArray(effect.rules_effects) ? effect.rules_effects : getRulesEffectsForSpell(effect),
  }));
}

function sumArmorBonusEffects(effects = []) {
  return normalizeEffects(effects)
    .flatMap((effect) => effect.rules_effects || [])
    .filter((effect) => effect.target === 'armor_class_bonus')
    .reduce((sum, effect) => sum + Number(effect.value || 0), 0);
}

function getArmorFormulaBase(effects = [], characterSheet = {}) {
  const formulas = normalizeEffects(effects)
    .flatMap((effect) => effect.rules_effects || [])
    .filter((effect) => effect.target === 'armor_formula');
  if (formulas.length === 0) return 0;

  const dexMod = Number(characterSheet?.abilities?.modifiers?.dex || 0);
  return formulas.reduce((best, formula) => {
    const dexCap = formula.dex_cap;
    const dexApplied = dexCap === null || dexCap === undefined ? dexMod : Math.min(dexMod, Number(dexCap));
    return Math.max(best, Number(formula.base || 10) + dexApplied);
  }, 0);
}

function getTempHpFromEffects(effects = []) {
  return normalizeEffects(effects)
    .flatMap((effect) => (effect.rules_effects || []).map((rule) => ({ effect, rule })))
    .filter(({ rule }) => rule.target === 'temp_hp')
    .reduce((best, { rule, effect }) => Math.max(best, resolveRuleValue(rule.value, effect)), 0);
}

function resolveRuleValue(value, effect = {}) {
  if (value === 'spell_mod_min_1') return Math.max(1, Number(effect.spellcasting_modifier || 0));
  return Number(value || 0);
}

function buildSpellArmorBreakdown(effects = []) {
  return normalizeEffects(effects)
    .flatMap((effect) => (effect.rules_effects || [])
      .filter((rule) => rule.target === 'armor_class_bonus')
      .map((rule) => ({
        label: rule.label || effect.name || 'Spell effect',
        value: Number(rule.value || 0),
        source: 'spell_effect',
        effect_id: effect.id,
      })));
}

function sumSpellArmorBreakdown(parts = []) {
  return parts
    .filter(isSpellArmorBreakdown)
    .reduce((sum, part) => sum + Number(part.value || 0), 0);
}

function isSpellArmorBreakdown(part = {}) {
  return part.source === 'spell_effect'
    || Boolean(part.effect_id)
    || part.label === 'Shield of Faith';
}

function getActiveBonusDice(worldState = {}, bonusType, context = {}) {
  return normalizeEffects(worldState.active_effects || [])
    .flatMap((effect) => (effect.rules_effects || []).map((rule) => ({ effect, rule })))
    .filter(({ rule }) => BONUS_DIE_RULES[rule.target] === bonusType && rule.die)
    .filter(({ rule }) => !rule.skill || (context.skill && rule.skill === context.skill))
    .map(({ effect, rule }) => ({
      effectId: effect.id,
      die: rule.die,
      label: rule.label || effect.name || 'Active effect',
      expiresOnUse: Boolean(rule.expires_on_use),
    }));
}

function getActiveCheckBonuses(worldState = {}, context = {}) {
  const skill = normalizeName(context.skill);
  const ability = normalizeName(context.ability);
  return normalizeEffects(worldState.active_effects || [])
    .flatMap((effect) => (effect.rules_effects || []).map((rule) => ({ effect, rule })))
    .filter(({ rule }) => rule.target === 'skill_check_bonus')
    .filter(({ rule }) => !rule.skill || (skill && normalizeName(rule.skill) === skill))
    .filter(({ rule }) => !rule.ability || (ability && normalizeName(rule.ability) === ability))
    .map(({ effect, rule }) => ({
      effectId: effect.id,
      value: Number(rule.value || 0),
      label: rule.label || effect.name || 'Active effect',
    }))
    .filter((bonus) => bonus.value !== 0);
}

function getActiveSavingThrowBonuses(worldState = {}, context = {}) {
  const ability = normalizeName(context.ability);
  return normalizeEffects(worldState.active_effects || [])
    .flatMap((effect) => (effect.rules_effects || []).map((rule) => ({ effect, rule })))
    .filter(({ rule }) => rule.target === 'saving_throw_bonus')
    .filter(({ rule }) => !rule.ability || (ability && normalizeName(rule.ability) === ability))
    .map(({ effect, rule }) => ({
      effectId: effect.id,
      value: Number(rule.value || 0),
      label: rule.label || effect.name || 'Active effect',
    }))
    .filter((bonus) => bonus.value !== 0);
}

function getActiveAttackRollBonuses(worldState = {}, context = {}) {
  const attackAbility = normalizeName(context.attack?.ability);
  return normalizeEffects(worldState.active_effects || [])
    .flatMap((effect) => (effect.rules_effects || []).map((rule) => ({ effect, rule })))
    .filter(({ rule }) => rule.target === 'weapon_attack_bonus')
    .filter(({ rule }) => !rule.ability || (attackAbility && normalizeName(rule.ability) === attackAbility))
    .filter(({ effect }) => !isWeaponMagicAlreadyInSheet(context.characterSheet, context.attack, effect))
    .map(({ effect, rule }) => ({
      effectId: effect.id,
      value: Number(rule.value || 0),
      label: rule.label || effect.name || 'Active effect',
    }))
    .filter((bonus) => bonus.value !== 0);
}

function getActiveDamageDice(worldState = {}, target = null) {
  const targetName = normalizeName(typeof target === 'string' ? target : target?.name);
  return normalizeEffects(worldState.active_effects || [])
    .flatMap((effect) => (effect.rules_effects || []).map((rule) => ({ effect, rule })))
    .filter(({ rule }) => rule.target === 'weapon_damage_bonus_die' && rule.die)
    .filter(({ effect, rule }) => {
      if (!rule.target_bound && !effect.target_bound) return true;
      if (!targetName) return false;
      return normalizeName(effect.target) === targetName
        || (effect.targets || []).some((item) => normalizeName(item.name || item) === targetName);
    })
    .map(({ effect, rule }) => ({
      effectId: effect.id,
      die: rule.die,
      damageType: rule.damage_type || 'damage',
      label: rule.label || effect.name || 'Active effect',
      expiresOnHit: Boolean(rule.expires_on_hit),
    }));
}

function getActiveDamageBonuses(worldState = {}, context = {}) {
  const attackAbility = normalizeName(context.attack?.ability);
  return normalizeEffects(worldState.active_effects || [])
    .flatMap((effect) => (effect.rules_effects || []).map((rule) => ({ effect, rule })))
    .filter(({ rule }) => rule.target === 'weapon_damage_bonus')
    .filter(({ rule }) => !rule.ability || (attackAbility && normalizeName(rule.ability) === attackAbility))
    .filter(({ effect }) => !isWeaponMagicAlreadyInSheet(context.characterSheet, context.attack, effect))
    .map(({ effect, rule }) => ({
      effectId: effect.id,
      value: Number(rule.value || 0),
      label: rule.label || effect.name || 'Active effect',
    }))
    .filter((bonus) => bonus.value !== 0);
}

function getActiveDamageResistances(worldState = {}) {
  return normalizeEffects(worldState.active_effects || [])
    .flatMap((effect) => effect.rules_effects || [])
    .filter((rule) => rule.target === 'damage_resistance')
    .flatMap((rule) => rule.damage_types || rule.damage_type || [])
    .map(normalizeName)
    .filter(Boolean);
}

function getActiveD20AdvantageSources(worldState = {}, context = {}) {
  const ability = normalizeName(context.ability);
  const skill = normalizeName(context.skill);
  const testType = normalizeName(context.testType);
  return normalizeEffects(worldState.active_effects || [])
    .flatMap((effect) => (effect.rules_effects || []).map((rule) => ({ effect, rule })))
    .filter(({ rule }) => {
      if (rule.target === 'skill_advantage' && testType === 'skill_check') {
        return !rule.skill || (skill && normalizeName(rule.skill) === skill);
      }
      if (rule.target === 'ability_check_advantage' && (testType === 'ability_check' || testType === 'skill_check')) {
        return !rule.ability || normalizeName(rule.ability) === ability;
      }
      if (rule.target === 'saving_throw_advantage' && (testType === 'saving_throw' || testType === 'concentration_save')) {
        return !rule.ability || normalizeName(rule.ability) === ability;
      }
      return false;
    })
    .map(({ effect, rule }) => rule.label || effect.name || 'Active effect');
}

function getActiveSpellSaveDcBonus(worldState = {}, characterSheet = {}) {
  return getActiveSpellSaveDcBonuses(worldState, characterSheet)
    .reduce((sum, bonus) => sum + Number(bonus.value || 0), 0);
}

function getActiveSpellAttackBonus(worldState = {}, characterSheet = {}) {
  return getActiveSpellAttackBonuses(worldState, characterSheet)
    .reduce((sum, bonus) => sum + Number(bonus.value || 0), 0);
}

function getActiveSpellAttackSources(worldState = {}, characterSheet = {}) {
  return getActiveSpellAttackBonuses(worldState, characterSheet).map((bonus) => bonus.label);
}

function getActiveSpellAttackBonuses(worldState = {}, characterSheet = {}) {
  const classId = normalizeName(characterSheet.identity?.class || characterSheet.identity?.class_name);
  return normalizeEffects(worldState.active_effects || [])
    .flatMap((effect) => (effect.rules_effects || []).map((rule) => ({ effect, rule })))
    .filter(({ rule }) => rule.target === 'spell_attack_bonus')
    .filter(({ rule }) => !rule.class_id || normalizeName(rule.class_id) === classId)
    .map(({ effect, rule }) => ({
      value: Number(rule.value || 0),
      label: rule.label || effect.name || 'Active effect',
    }))
    .filter((bonus) => bonus.value !== 0);
}

function getActiveSpellSaveDcSources(worldState = {}, characterSheet = {}) {
  return getActiveSpellSaveDcBonuses(worldState, characterSheet).map((bonus) => bonus.label);
}

function getActiveSpellSaveDcBonuses(worldState = {}, characterSheet = {}) {
  const classId = normalizeName(characterSheet.identity?.class || characterSheet.identity?.class_name);
  return normalizeEffects(worldState.active_effects || [])
    .flatMap((effect) => (effect.rules_effects || []).map((rule) => ({ effect, rule })))
    .filter(({ rule }) => rule.target === 'spell_save_dc_bonus')
    .filter(({ rule }) => !rule.class_id || normalizeName(rule.class_id) === classId)
    .map(({ effect, rule }) => ({
      value: Number(rule.value || 0),
      label: rule.label || effect.name || 'Active effect',
    }));
}

function getActiveSpellAttackAdvantageSources(worldState = {}, characterSheet = {}) {
  const classId = normalizeName(characterSheet.identity?.class || characterSheet.identity?.class_name);
  return normalizeEffects(worldState.active_effects || [])
    .flatMap((effect) => (effect.rules_effects || []).map((rule) => ({ effect, rule })))
    .filter(({ rule }) => rule.target === 'spell_attack_advantage')
    .filter(({ rule }) => !rule.class_id || normalizeName(rule.class_id) === classId)
    .map(({ effect, rule }) => rule.label || effect.name || 'Active effect');
}

function consumeActiveEffects(worldState = {}, effectIds = [], characterSheet = null) {
  const consumeIds = new Set(effectIds.filter(Boolean));
  if (consumeIds.size === 0) return worldState;
  const activeEffects = normalizeEffects(worldState.active_effects || []);
  return applyActiveEffectsToWorldState(
    worldState,
    activeEffects.filter((effect) => !consumeIds.has(effect.id)),
    characterSheet,
  );
}

function applyStartOfTurnEffects(worldState = {}, characterSheet = null) {
  const activeEffects = normalizeEffects(worldState.active_effects || []);
  const retainedEffects = activeEffects.filter((effect) => !effect.expires_at_start_of_player_turn);
  let nextWorldState = retainedEffects.length === activeEffects.length
    ? worldState
    : applyActiveEffectsToWorldState(worldState, retainedEffects, characterSheet);
  const currentEffects = normalizeEffects(nextWorldState.active_effects || []);
  const tempHp = currentEffects
    .flatMap((effect) => (effect.rules_effects || []).map((rule) => ({ effect, rule })))
    .filter(({ rule }) => rule.target === 'temp_hp_each_turn')
    .reduce((best, { rule, effect }) => Math.max(best, resolveRuleValue(rule.value, effect)), 0);
  if (tempHp <= 0) return nextWorldState;

  const stats = nextWorldState.player_stats || {};
  const nextTempHp = Math.max(Number(stats.temp_hp || 0), tempHp);
  const combat = nextWorldState.combat_state?.active
    ? {
        ...nextWorldState.combat_state,
        combatants: (nextWorldState.combat_state.combatants || []).map((combatant) => (
          combatant.is_player ? { ...combatant, temp_hp: nextTempHp } : combatant
        )),
      }
    : nextWorldState.combat_state;
  return {
    ...nextWorldState,
    combat_state: combat,
    player_stats: {
      ...stats,
      temp_hp: nextTempHp,
    },
  };
}

function formatBonusDieTag(bonus = null) {
  if (!bonus?.die) return '';
  return ` bonus_die=${bonus.die} bonus_source="${String(bonus.label || 'bonus').replaceAll('"', '')}"`;
}

function combineAdvantageModes(left = null, right = null) {
  if (left && right && left !== right) return null;
  return left || right || null;
}

module.exports = {
  resolveSpellCast,
  resolveSpellOutcome,
  tickActiveEffects,
  applyActiveEffectsToCharacterSheet,
  applyActiveEffectsToWorldState,
  applyStartOfTurnEffects,
  consumeActiveEffects,
  getActiveBonusDice,
  getActiveCheckBonuses,
  getActiveSavingThrowBonuses,
  getActiveAttackRollBonuses,
  getActiveDamageDice,
  getActiveDamageBonuses,
  getActiveDamageResistances,
  getActiveD20AdvantageSources,
  getActiveSpellAttackBonus,
  getActiveSpellAttackSources,
  getActiveSpellAttackAdvantageSources,
  getActiveSpellSaveDcBonus,
  formatBonusDieTag,
};
