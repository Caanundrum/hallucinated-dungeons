const crypto = require('crypto');
const { getSpellActionResource } = require('./actionEconomy');
const {
  getAttackMode,
  getAttackModeSources,
  resolveSavingThrow,
} = require('./conditionEngine');

const CONCENTRATION_DURATIONS = {
  bless: 'Concentration, up to 1 minute',
  dancing_lights: 'Concentration, up to 1 minute',
  detect_magic: 'Concentration, up to 10 minutes',
  divine_favor: 'Concentration, up to 1 minute',
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
  const spell = getCastSpellFromMessage(message, content);
  if (!spell) return null;

  const known = getKnownSpellInfo(characterSheet, spell);
  if (spell.unknown || !known.known) {
    return {
      matched: true,
      blocked: true,
      reply: `You reach for ${spell.name}, but it is not on your current character sheet. At level ${characterSheet?.identity?.level || 1}, you can work with: ${summarizeKnownSpells(characterSheet, content)}. The magic shelves are not self-service.`,
    };
  }

  const timingBlock = validateSpellTiming({ spell, message, worldState: castWorldState, characterSheet });
  if (timingBlock) {
    return {
      matched: true,
      blocked: true,
      reply: timingBlock,
    };
  }

  const resource = spendSpellResource(characterSheet, spell, known);
  if (!resource.ok) {
    return {
      matched: true,
      blocked: true,
      reply: resource.reply,
    };
  }

  let nextSheet = resource.characterSheet;
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
    resourceNote: resource.note,
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

function validateSpellTiming({ spell, message, worldState = {}, characterSheet = {} }) {
  if (spell.id === 'mage_armor' && characterSheet?.equipped?.armor) {
    return 'Mage Armor only works on a creature that is not wearing armor. Your current armor is already doing the job, and it is not interested in being replaced by sparkle math.';
  }

  if (worldState.combat_state?.active && /^\s*\d+\s*minute/i.test(spell.casting_time || '')) {
    return `${spell.name} takes ${spell.casting_time} to cast. That is not a single combat action; you would need to spend the required rounds maintaining the casting. The initiative tracker has opinions about paperwork.`;
  }

  if (/reaction/i.test(spell.casting_time || '') && !/\b(reaction|trigger|when|being hit|gets hit|am hit|attacked|attack hits|hits me)\b/i.test(message || '')) {
    return `${spell.name} is a Reaction spell. You can cast it when its trigger happens, not as a casual pre-emptive vibe check.`;
  }

  return null;
}

function resolveSpellAttack({ spell, rule, characterSheet, worldState, rollDie }) {
  const context = getSpellTargetContext({ spell, spellCastMessage: worldState.__spell_message, worldState, characterSheet });
  if (!context?.target) return noSpellTarget(worldState, spell);
  const { combat, target, activeCombat } = context;

  const attackBonus = Number(characterSheet?.derived_stats?.spell_attack_bonus || 0);
  const attacker = getPlayerCombatant(combat, characterSheet, worldState);
  const attackMode = getAttackMode({ attacker, target });
  const attackRoll = rollD20WithMode(rollDie, attackMode);
  const natural = attackRoll.natural;
  const total = natural + attackBonus;
  const criticalHit = natural === 20;
  const criticalMiss = natural === 1;
  const hit = !criticalMiss && (criticalHit || total >= Number(target.ac || 10));
  const lines = [
    `You cast **${spell.name}** at ${target.name}. Spell attack: ${attackRoll.text}${formatSigned(attackBonus)} = ${total} vs AC ${target.ac}.`,
  ];
  if (attackMode) {
    lines.push(`Spell attack has ${attackMode} from ${formatList(getAttackModeSources({ attacker, target }))}.`);
  }

  if (hit) {
    const damage = rollFormula(rule.damage, rollDie, { crit: criticalHit });
    const before = Number(target.hp || 0);
    target.hp = Math.max(0, before - damage.total);
    lines.push(`${criticalHit ? '**Critical hit.** ' : ''}Hit for ${damage.total} ${rule.damage_type} damage. ${target.name}: (${before} -> ${target.hp} HP).`);
    if (rule.condition_on_hit && Number(target.hp) > 0) {
      target.conditions = addCondition(target.conditions, rule.condition_on_hit);
    }
    if (rule.rider) lines.push(rule.rider);
  } else if (criticalMiss) {
    lines.push('**Critical miss.** The spell goes wide, and magic pretends it meant to do that.');
  } else {
    lines.push('Miss.');
  }

  return finishSpellAction({ spell, worldState, combat, lines, activeCombat });
}

function resolveAutomaticDamageSpell({ spell, rule, worldState, rollDie }) {
  const context = getSpellTargetContext({ spell, spellCastMessage: worldState.__spell_message, worldState });
  if (!context?.target) return noSpellTarget(worldState, spell);
  const { combat, target, activeCombat } = context;

  const rolls = Array.from({ length: Number(rule.darts || 1) }, () => rollFormula(rule.damage, rollDie));
  const total = rolls.reduce((sum, roll) => sum + roll.total, 0);
  const before = Number(target.hp || 0);
  target.hp = Math.max(0, before - total);
  const lines = [
    `You cast **${spell.name}** at ${target.name}. The spell hits automatically for ${total} ${rule.damage_type} damage. ${target.name}: (${before} -> ${target.hp} HP).`,
  ];

  return finishSpellAction({ spell, worldState, combat, lines, activeCombat });
}

function resolveSavingThrowSpell({ spell, rule, characterSheet, worldState, rollDie }) {
  const context = getSpellTargetContext({ spell, spellCastMessage: worldState.__spell_message, worldState });
  if (!context?.target) return noSpellTarget(worldState, spell);
  const { combat, target, activeCombat } = context;

  const dc = Number(characterSheet?.derived_stats?.spell_save_dc || 10);
  const saveBonus = getTargetSaveBonus(target, rule.save);
  const save = resolveSavingThrow({ target, ability: rule.save, dc, rollDie, bonus: saveBonus });
  const success = save.success;
  const damage = rollFormula(rule.damage, rollDie);
  const appliedDamage = success && rule.half_on_success ? Math.floor(damage.total / 2) : success ? 0 : damage.total;
  const before = Number(target.hp || 0);
  target.hp = Math.max(0, before - appliedDamage);

  const lines = [
    `You cast **${spell.name}** at ${target.name}. ${target.name} rolls a ${rule.save.toUpperCase()} save: ${save.automaticFailure ? save.text : `${save.text} vs DC ${dc}`}.`,
    success
      ? `Save succeeds.${appliedDamage ? ` ${target.name} still takes ${appliedDamage} ${rule.damage_type} damage. ${target.name}: (${before} -> ${target.hp} HP).` : ' No damage is applied.'}`
      : `Save fails. ${target.name} takes ${appliedDamage} ${rule.damage_type} damage. ${target.name}: (${before} -> ${target.hp} HP).`,
  ];

  return finishSpellAction({ spell, worldState, combat, lines, activeCombat });
}

function resolveSaveEffectSpell({ spell, rule, characterSheet, worldState, rollDie }) {
  const context = getSpellTargetContext({ spell, spellCastMessage: worldState.__spell_message, worldState });
  if (!context?.target) return noSpellTarget(worldState, spell);
  const { combat, target, activeCombat } = context;

  const dc = Number(characterSheet?.derived_stats?.spell_save_dc || 10);
  const saveBonus = getTargetSaveBonus(target, rule.save);
  const save = resolveSavingThrow({ target, ability: rule.save, dc, rollDie, bonus: saveBonus });
  const success = save.success;
  const lines = [
    `You cast **${spell.name}** at ${target.name}. ${target.name} rolls a ${rule.save.toUpperCase()} save: ${save.automaticFailure ? save.text : `${save.text} vs DC ${dc}`}.`,
    success ? 'Save succeeds. The spell does not take hold.' : `Save fails. ${rule.effect}`,
  ];
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
  const healing = rollFormula(rule.healing, rollDie, { spellMod });
  const stats = worldState.player_stats || {};
  const before = Number(player?.hp ?? stats.hp ?? characterSheet?.derived_stats?.hp ?? 0);
  const maxHp = Number(player?.max_hp ?? stats.max_hp ?? characterSheet?.derived_stats?.max_hp ?? before);
  const after = Math.min(maxHp, before + healing.total);
  if (player) player.hp = after;

  const nextState = {
    ...stripInternalState(worldState),
    combat_state: combat.active ? combat : worldState.combat_state,
    player_stats: {
      ...stats,
      hp: after,
      max_hp: maxHp,
    },
  };
  const lines = [
    `You cast **${spell.name}** and restore ${healing.total} HP. HP: (${before} -> ${after}).`,
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
  return {
    handled: true,
    logType: 'spell_utility',
    spell,
    worldState: stripInternalState(worldState),
    reply: `You cast **${spell.name}**. Its effect is now active in the scene: ${spell.description}`,
    consumesTurn: consumesCombatTurn(spell),
  };
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

  const enemiesAlive = combat.combatants.some((combatant) => !combatant.is_player && Number(combatant.hp) > 0);
  const nextState = {
    ...stripInternalState(worldState),
    combat_state: enemiesAlive ? combat : null,
  };
  const reply = enemiesAlive
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

function getSpellTargetContext({ spell, spellCastMessage = '', worldState = {}, characterSheet = {}, allowMultiple = false } = {}) {
  if (worldState.combat_state?.active) {
    const combat = cloneCombatState(worldState.combat_state);
    const target = firstEnemy(combat);
    if (target) return { combat, target, activeCombat: true };
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
    if (presentNpcs.length === 0 && trackedTargets.length === 0) return [explicitTarget];
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
    saves: existing.saves || { dex: 1, con: 1, wis: 0, str: 1, int: 0, cha: 0 },
    is_player: false,
    scene_target: true,
  };
}

function getPlayerCombatant(combat, characterSheet = {}, worldState = {}) {
  return (combat.combatants || []).find((combatant) => combatant.is_player) || {
    character_id: worldState.player_stats?.character_id || characterSheet?.derived_stats?.character_id || null,
    name: characterSheet?.identity?.name || worldState.player_stats?.name || 'You',
    conditions: worldState.player_stats?.conditions || characterSheet?.derived_stats?.conditions || [],
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

function comparableTargetNames(value) {
  const normalized = normalizeName(value);
  const stripped = normalized
    .replace(/\b(?:injured|wounded|collapsed|fallen|reeling|unknown|hooded)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...new Set([normalized, stripped].filter(Boolean))];
}

function rollD20WithMode(rollDie, mode = null) {
  if (mode === 'advantage' || mode === 'disadvantage') {
    const first = rollDie(20);
    const second = rollDie(20);
    const natural = mode === 'advantage' ? Math.max(first, second) : Math.min(first, second);
    return {
      natural,
      text: `${first}/${second} with ${mode}, using ${natural}`,
    };
  }
  const natural = rollDie(20);
  return { natural, text: String(natural) };
}

function stripInternalState(worldState = {}) {
  const { __spell_message: ignored, ...clean } = worldState;
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

function getCastSpellFromMessage(message, content) {
  const match = String(message || '').match(/\bcast\s+(?:the\s+)?([a-z][a-z' -]{2,40})/i);
  if (!match) return null;
  const spoken = normalizeSpellName(match[1].replace(/\b(on|at|toward|towards|to|for|with|and)\b.*$/i, ''));
  if (!spoken) return null;
  const spell = content.spells.find((item) => normalizeSpellName(item.name) === spoken || normalizeSpellName(item.id) === spoken);
  return spell || { id: spoken.replaceAll(' ', '_'), name: spoken.replace(/\b\w/g, (char) => char.toUpperCase()), unknown: true };
}

function normalizeSpellName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getKnownSpellInfo(characterSheet = {}, spell = {}) {
  if (!spell || spell.unknown) return { known: false };
  const cantrips = new Set(characterSheet.spellcasting?.cantrips_known || []);
  const classSpells = new Set(characterSheet.spellcasting?.spells_prepared || characterSheet.spellcasting?.spells_known || []);
  const speciesSpell = (characterSheet.species_spells || []).find((entry) => (entry.id || entry) === spell.id);
  const originEntry = Object.entries(characterSheet.origin?.magic_initiate || {})
    .find(([, choice]) => (choice.cantrips || []).includes(spell.id) || choice.spell === spell.id);

  if (cantrips.has(spell.id)) return { known: true, type: 'class_cantrip', label: 'class cantrip' };
  if (classSpells.has(spell.id)) return { known: true, type: 'class_spell', label: 'prepared class spell' };
  if (speciesSpell) return { known: true, type: 'species_spell', label: `${speciesSpell.source || 'species'} spell` };
  if (originEntry) {
    const [source, choice] = originEntry;
    const isCantrip = (choice.cantrips || []).includes(spell.id);
    return {
      known: true,
      type: isCantrip ? 'origin_cantrip' : 'origin_spell',
      source,
      label: isCantrip ? 'Origin feat cantrip' : 'Origin feat spell',
    };
  }
  return { known: false };
}

function getKnownSpellIds(characterSheet = {}) {
  const ids = new Set([
    ...(characterSheet.spellcasting?.cantrips_known || []),
    ...(characterSheet.spellcasting?.spells_prepared || characterSheet.spellcasting?.spells_known || []),
    ...(characterSheet.species_spells || []).map((spell) => spell.id || spell),
  ]);
  for (const choice of Object.values(characterSheet.origin?.magic_initiate || {})) {
    for (const cantrip of choice.cantrips || []) ids.add(cantrip);
    if (choice.spell) ids.add(choice.spell);
  }
  return ids;
}

function summarizeKnownSpells(characterSheet, content) {
  const ids = [...getKnownSpellIds(characterSheet)];
  return ids.map((id) => content.spells.find((spell) => spell.id === id)?.name || id).join(', ') || 'no spells';
}

function spendSpellResource(characterSheet = {}, spell = {}, known = {}) {
  if (Number(spell.level || 0) <= 0) {
    return { ok: true, characterSheet, note: 'cantrip/no slot' };
  }

  const slotKey = String(spell.level);
  const currentSlots = characterSheet.spellcasting?.slots || {};
  const remainingSlots = Number(currentSlots[slotKey] || 0);
  if (remainingSlots > 0) {
    return {
      ok: true,
      note: `spent level ${slotKey} spell slot`,
      characterSheet: {
        ...characterSheet,
        spellcasting: {
          ...(characterSheet.spellcasting || {}),
          slots: {
            ...currentSlots,
            [slotKey]: remainingSlots - 1,
          },
        },
      },
    };
  }

  if (known.type === 'origin_spell' || known.type === 'species_spell') {
    return spendLimitedSpellUse(characterSheet, spell, known);
  }

  return {
    ok: false,
    reply: `You know ${spell.name}, but you do not have a level ${slotKey} spell slot left to cast it. Even magic keeps receipts.`,
  };
}

function spendLimitedSpellUse(characterSheet, spell, known) {
  const resourceKey = `${known.type}:${known.source || 'default'}:${spell.id}`;
  const spellUses = characterSheet.resources?.spell_uses || {};
  const currentUse = spellUses[resourceKey] || {
    name: spell.name,
    remaining: 1,
    max: 1,
    reset: 'long_rest',
  };
  if (Number(currentUse.remaining || 0) <= 0) {
    return {
      ok: false,
      reply: `${spell.name} is available through ${known.label}, but that once-per-rest use is already spent. The spell politely refuses to be double-booked.`,
    };
  }
  return {
    ok: true,
    note: `spent ${known.label}`,
    characterSheet: {
      ...characterSheet,
      resources: {
        ...(characterSheet.resources || {}),
        spell_uses: {
          ...spellUses,
          [resourceKey]: {
            ...currentUse,
            remaining: Number(currentUse.remaining || 0) - 1,
          },
        },
      },
    },
  };
}

function buildSpellEffect(characterSheet, spell, known, message = '', worldState = {}) {
  if (!spellHasDuration(spell)) return null;
  const outcomeRule = SPELL_OUTCOMES[spell.id];
  if (outcomeRule?.type === 'save_effect' || outcomeRule?.type === 'sleep_pool') return null;
  const actor = characterSheet.identity?.name || 'active character';
  const duration = normalizeSpellDuration(spell);
  const targetName = spell.range === 'Self'
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
    spellcasting_modifier: getSpellcastingModifier(characterSheet),
    mechanical_effect: spell.description,
    rules_effects: getRulesEffectsForSpell(spell),
    ...durationToRemaining(duration),
  };
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

function getRulesEffectsForSpell(spell) {
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
      { target: 'ability_check_bonus_die', die: '1d4', label: 'Guidance', expires_on_use: true },
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
    return effectsBySpell[spell.id];
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

function rollFormula(formula, rollDie, { crit = false, spellMod = 0 } = {}) {
  const normalized = String(formula || '1').replace(/spell_mod/g, String(spellMod));
  const match = normalized.match(/(\d+)d(\d+)((?:[+-]\d+)*)/i);
  if (!match) return { total: Number(normalized) || 0, rolls: [] };

  const diceCount = Number(match[1]);
  const dieSides = Number(match[2]);
  const modifierText = match[3] || '';
  const modifier = (modifierText.match(/[+-]\d+/g) || [])
    .reduce((sum, value) => sum + Number(value), 0);
  const rollCount = crit ? diceCount * 2 : diceCount;
  const rolls = Array.from({ length: rollCount }, () => rollDie(dieSides));
  return {
    total: rolls.reduce((sum, roll) => sum + roll, 0) + modifier,
    rolls,
    modifier,
  };
}

function defaultRollDie(sides) {
  return crypto.randomInt(1, Number(sides) + 1);
}

function formatSigned(value) {
  const number = Number(value || 0);
  return number >= 0 ? `+${number}` : String(number);
}

function applyActiveEffectsToCharacterSheet(characterSheet = {}, effects = []) {
  const normalizedEffects = normalizeEffects(effects);
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
      active_spell_effects: normalizedEffects,
    },
  };
}

function applyActiveEffectsToWorldState(worldState = {}, effects = [], characterSheet = null) {
  const normalizedEffects = normalizeEffects(effects);
  const stats = worldState.player_stats || {};
  const currentSpellArmorBonus = sumArmorBonusEffects(worldState.active_effects || []);
  const sheetArmor = characterSheet?.derived_stats?.armor_class;
  const naturalBaseArmorClass = Number(
    stats.natural_base_armor_class
      ?? characterSheet?.derived_stats?.natural_base_armor_class
      ?? stats.base_armor_class
      ?? characterSheet?.derived_stats?.base_armor_class
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

function getActiveBonusDice(worldState = {}, bonusType) {
  return normalizeEffects(worldState.active_effects || [])
    .flatMap((effect) => (effect.rules_effects || []).map((rule) => ({ effect, rule })))
    .filter(({ rule }) => BONUS_DIE_RULES[rule.target] === bonusType && rule.die)
    .map(({ effect, rule }) => ({
      effectId: effect.id,
      die: rule.die,
      label: rule.label || effect.name || 'Active effect',
      expiresOnUse: Boolean(rule.expires_on_use),
    }));
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
  const tempHp = activeEffects
    .flatMap((effect) => (effect.rules_effects || []).map((rule) => ({ effect, rule })))
    .filter(({ rule }) => rule.target === 'temp_hp_each_turn')
    .reduce((best, { rule, effect }) => Math.max(best, resolveRuleValue(rule.value, effect)), 0);
  if (tempHp <= 0) return worldState;

  const stats = worldState.player_stats || {};
  const nextTempHp = Math.max(Number(stats.temp_hp || 0), tempHp);
  const combat = worldState.combat_state?.active
    ? {
        ...worldState.combat_state,
        combatants: (worldState.combat_state.combatants || []).map((combatant) => (
          combatant.is_player ? { ...combatant, temp_hp: nextTempHp } : combatant
        )),
      }
    : worldState.combat_state;
  return {
    ...worldState,
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

module.exports = {
  resolveSpellCast,
  resolveSpellOutcome,
  getCastSpellFromMessage,
  getKnownSpellIds,
  summarizeKnownSpells,
  tickActiveEffects,
  applyActiveEffectsToCharacterSheet,
  applyActiveEffectsToWorldState,
  applyStartOfTurnEffects,
  consumeActiveEffects,
  durationToRemaining,
  getActiveBonusDice,
  getActiveDamageDice,
  formatBonusDieTag,
};
