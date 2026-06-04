const crypto = require('crypto');
const { resolveIntent } = require('./intentResolver');
const { getContentBundle } = require('./contentData');
const {
  tickActiveEffects,
  applyActiveEffectsToWorldState,
  applyStartOfTurnEffects,
  consumeActiveEffects,
  getActiveBonusDice,
  getActiveD20AdvantageSources,
  getActiveDamageBonuses,
  getActiveDamageDice,
  formatBonusDieTag,
} = require('./spellEffectEngine');
const {
  beginPlayerTurn,
  continuePlayerTurn,
  setTurnFlag,
  spendTurnResource,
} = require('./actionEconomy');
const { resolveCreatureTurns, resumeCreatureTurns } = require('./creatureTurnEngine');
const {
  formatPendingReactionPrompt,
  resolvePendingReactionChoice,
} = require('./reactionEngine');
const { checkSpatialAction } = require('./spatialGuard');
const {
  resolveD20Test,
} = require('./d20RollEngine');
const {
  rollDamageFormula,
} = require('./damageHealingEngine');
const {
  applyPendingRollResourceIntent,
  completeLongRestResources,
  completeShortRestResources,
  getAutoD20RerollRules,
  mergeWorldResources,
} = require('./resourceEngine');
const {
  getAttackMode,
  getAttackModeSources,
  getD20ConditionMode,
  getD20ConditionSources,
  getTurnBlockReason,
  resolveSavingThrow,
} = require('./conditionEngine');
const { resolveFeatureAction } = require('./classFeatureEngine');
const {
  getSpeciesD20AdvantageSources,
  resolveSpeciesFeatureAction,
} = require('./speciesFeatureEngine');
const {
  applyLuckyToImmediateD20,
  buildUnarmedAttack,
  isUnarmedAttackIntent,
  resolveOriginFeatAction,
  rollWeaponDamage,
} = require('./originFeatEngine');
const {
  applyHelpToAttack,
  applyHelpToPendingCheck,
  resolveHelpAction,
} = require('./helpActionEngine');
const {
  applyHideCheckOutcome,
  clearPlayerHidden,
  isHideActionCheck,
} = require('./hiddenStateEngine');
const {
  applySocialCheckOutcome,
  buildSocialPendingMetadata,
} = require('./socialStateEngine');
const {
  applyDiscoveryCheckOutcome,
  buildDiscoveryPendingMetadata,
} = require('./discoveryStateEngine');
const {
  applyObjectChallengeOutcome,
  resolveObjectChallenge,
  resolveObjectInteraction,
} = require('./objectInteractionEngine');
const {
  applyWeaponMasteryOnHit,
  applyWeaponMasteryOnMiss,
  consumeVexAdvantage,
  expireMasteryEffects,
  getWeaponDamageFormula,
  getWeaponMasteryAdvantageSources,
  getWeaponPropertyAttackMode,
  getWeaponPropertyAttackSources,
  prepareWeaponAttack,
} = require('./weaponRulesEngine');
const {
  applyFightingStyleToAttack,
  getFightingStyleDamageBonus,
  getRuntimeArmorClass,
} = require('./fightingStyleEngine');
const {
  getLightExtraAttack,
} = require('./lightWeaponEngine');
const {
  getCleaveExtraAttack,
  markCleaveUsed,
} = require('./cleaveMasteryEngine');
const {
  checkAmmunitionAttack,
  recoverSpentAmmunition,
  spendAmmunitionForAttack,
} = require('./ammunitionEngine');
const {
  applyGiantAncestryOnHit,
  expireGiantAncestryEffects,
} = require('./giantAncestryEngine');
const {
  resolveCombatMovement,
  resolveDashAction,
  resolveDisengageAction,
  resumeCombatMovement,
} = require('./combatMovementEngine');
const { resolveReadyAction } = require('./readyActionEngine');

const DEFAULT_CHECK_DC = 15;

function adjudicate({ message, worldState = {}, characterSheet = null, currentTurn = 0, rollDie = defaultRollDie } = {}) {
  const text = String(message || '').trim();
  if (!text) return null;

  const intent = resolveIntent(text);
  const state = normalizeWorldState(worldState);
  const sheet = characterSheet || {};

  if (state.pending_reaction) {
    return resolvePendingReaction({ message: text, worldState: state, characterSheet: sheet, rollDie });
  }

  if (intent.isRollResult || parseRollRequest(text)) {
    return resolvePendingRoll({ message: text, worldState: state, characterSheet: sheet, rollDie });
  }

  if (state.pending_roll) {
    const resourceIntent = applyPendingRollResourceIntent({ message: text, worldState: state, characterSheet: sheet });
    if (resourceIntent) return resourceIntent;
    return remindPendingRoll({ worldState: state });
  }

  if (state.combat_state?.active && getCurrentHp(sheet, state) <= 0) {
    const deathStatus = getDeathSaveStatus(state);
    if (deathStatus === 'dying') return promptDeathSave({ worldState: state, characterSheet: sheet, currentTurn });
    return {
      handled: true,
      logType: 'referee_incapacitated',
      worldState: state,
      reply: deathStatus === 'dead'
        ? 'Your character is dead. The rules are not taking action requests from that side of the veil.'
        : 'You are stable but unconscious at 0 HP. You cannot act until healing or another effect brings you back into the fight.',
    };
  }

  const restIntent = getRestIntent(text);
  if (restIntent) {
    return resolveRest({ restIntent, worldState: state, characterSheet: sheet, rollDie });
  }

  if (wantsAmmunitionRecovery(text)) {
    return resolveAmmunitionRecovery({ worldState: state });
  }

  const timeIntent = getTimePassageIntent(text);
  if (timeIntent) {
    return resolveTimePassage({ timeIntent, worldState: state });
  }

  const featureAction = resolveFeatureAction({ message: text, worldState: state, characterSheet: sheet, rollDie });
  if (featureAction) return finishPlayerCombatAction({ result: featureAction, characterSheet: sheet });

  const speciesFeatureAction = resolveSpeciesFeatureAction({ message: text, worldState: state, characterSheet: sheet, rollDie });
  if (speciesFeatureAction) {
    return finishSpeciesFeatureAction({ result: speciesFeatureAction, characterSheet: sheet });
  }

  const originFeatAction = resolveOriginFeatAction({ message: text, worldState: state, characterSheet: sheet, rollDie });
  if (originFeatAction) return finishPlayerCombatAction({ result: originFeatAction, characterSheet: sheet });

  if (!state.combat_state?.active && isCombatStarter(text)) {
    const targetIssue = validateCombatStartTarget({ message: text, worldState: state });
    if (targetIssue) return targetIssue;
    return promptInitiative({ message: text, worldState: state, characterSheet: sheet, currentTurn });
  }

  if (intent.save) {
    return promptSavingThrow({ intent, worldState: state, characterSheet: sheet, currentTurn, inCombat: Boolean(state.combat_state?.active) });
  }

  if (!state.combat_state?.active) {
    const objectChallenge = resolveObjectChallengeAction({
      message: text,
      worldState: state,
      characterSheet: sheet,
      currentTurn,
      inCombat: false,
    });
    if (objectChallenge) return objectChallenge;
  }

  if (state.combat_state?.active) {
    return resolveCombatAction({ message: text, intent, worldState: state, characterSheet: sheet, currentTurn, rollDie });
  }

  if (intent.check) {
    return promptCheck({ intent, worldState: state, characterSheet: sheet, currentTurn, inCombat: false });
  }

  return null;
}

function normalizeWorldState(worldState = {}) {
  const combatState = clearResolvedCombat(worldState.combat_state);
  return {
    ...worldState,
    combat_state: combatState,
    player_stats: {
      ...(worldState.player_stats || {}),
    },
    time_state: {
      ...(worldState.time_state || {}),
    },
  };
}

function clearResolvedCombat(combatState) {
  if (!combatState?.active) return combatState;
  const enemiesAlive = (combatState.combatants || [])
    .some((combatant) => !combatant.is_player && Number(combatant.hp || 0) > 0);
  return enemiesAlive ? combatState : null;
}

function defaultRollDie(sides) {
  return crypto.randomInt(1, Number(sides) + 1);
}

function parseRollResult(message) {
  const totalMatch = String(message || '').match(/^\s*\[ROLL RESULT:\s*(-?\d+)\]/i);
  if (!totalMatch) return null;
  const naturalMatch = String(message || '').match(/\bnatural\s+(\d+)\b/i);
  return {
    total: Number(totalMatch[1]),
    natural: naturalMatch ? Number(naturalMatch[1]) : null,
  };
}

function parseRollRequest(message) {
  const match = String(message || '').match(/^\s*\[ROLL REQUEST:\s*([a-zA-Z0-9_-]+)\]/i);
  if (!match) return null;
  return { id: match[1] };
}

function promptCheck({ intent, worldState, characterSheet, currentTurn = 0, inCombat }) {
  const check = intent.check;
  let nextWorldState = worldState;
  if (inCombat) {
    const spent = spendTurnResource(worldState, 'action', `${check.label} check`, characterSheet);
    if (!spent.ok) {
      return {
        handled: true,
        logType: 'referee_action_unavailable',
        worldState: spent.worldState,
        reply: spent.reply,
      };
    }
    nextWorldState = spent.worldState;
  }

  const modifier = getCheckModifier(characterSheet, check);
  const bonus = getActiveBonusDice(worldState, 'check', { skill: check.skill })[0] || null;
  const hideAction = isHideActionCheck({ rule_action: intent.ruleAction, skill: check.skill, intent: intent.raw });
  const dc = hideAction ? 15 : chooseDc(intent.raw, check, worldState, inCombat);
  const conditionSubject = getPlayerConditionSubject(characterSheet, worldState);
  const conditionMode = getD20ConditionMode({
    subject: conditionSubject,
    testType: check.skill ? 'skill_check' : 'ability_check',
    ability: check.ability,
    skill: check.skill,
  });
  const conditionSources = getD20ConditionSources({
    subject: conditionSubject,
    testType: check.skill ? 'skill_check' : 'ability_check',
    ability: check.ability,
    skill: check.skill,
  });
  const activeAdvantageSources = getActiveD20AdvantageSources(worldState, {
    testType: check.skill ? 'skill_check' : 'ability_check',
    ability: check.ability,
    skill: check.skill,
  });
  const advantageMode = combineAdvantageModes(conditionMode, activeAdvantageSources.length ? 'advantage' : null);
  const advantageSources = [...conditionSources, ...activeAdvantageSources];
  let pendingRoll = {
    id: `roll_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: check.skill ? 'skill_check' : 'ability_check',
    skill: check.skill,
    ability: check.ability,
    label: check.label,
    formula: `1d20${formatSigned(modifier.total)}`,
    modifier: modifier.total,
    modifier_breakdown: modifier.breakdown,
    bonus_die: bonus?.die || null,
    bonus_source: bonus?.label || null,
    bonus_effect_ids: bonus?.expiresOnUse ? [bonus.effectId] : [],
    reroll_rules: getAutoD20RerollRules(characterSheet),
    advantage_mode: advantageMode,
    advantage_sources: advantageSources,
    dc,
    dc_source: buildDcSource(dc, intent.raw, inCombat, { hideAction }),
    intent: intent.raw,
    rule_action: hideAction ? 'hide' : intent.ruleAction || null,
    ...buildDiscoveryPendingMetadata({ intent, worldState }),
    ...buildSocialPendingMetadata({ intent, worldState }),
    consumes: inCombat ? 'action' : 'exploration',
    combat: Boolean(inCombat),
    created_turn: currentTurn,
    success_result: successTextFor(check),
    failure_result: failureTextFor(check),
  };
  const helped = applyHelpToPendingCheck({ worldState: nextWorldState, pendingRoll, characterSheet });
  nextWorldState = helped.worldState;
  pendingRoll = helped.pendingRoll;

  return {
    handled: true,
    logType: 'referee_pending_roll',
    worldState: {
      ...nextWorldState,
      pending_roll: pendingRoll,
    },
    reply: `Make a DC ${dc} ${check.label}.${formatAdvantageModeText(pendingRoll.advantage_mode, pendingRoll.advantage_sources)}${bonus ? ` Add ${bonus.die} from ${bonus.label}.` : ''}${inCombat ? ' This uses your Action.' : ''} [CHECK: id=${pendingRoll.id}${check.skill ? ` skill=${check.skill}` : ''} ability=${check.ability} modifier=${modifier.total} breakdown="${sanitizeTagValue(modifier.breakdown)}"${formatBonusDieTag(bonus)}]`,
  };
}

function promptSavingThrow({ intent, worldState, characterSheet, currentTurn = 0, inCombat }) {
  const save = intent.save;
  const modifier = getSavingThrowModifier(characterSheet, save.ability);
  const bonus = getActiveBonusDice(worldState, 'save')[0] || null;
  const dc = chooseDc(intent.raw, save, worldState, inCombat);
  const conditionSubject = getPlayerConditionSubject(characterSheet, worldState);
  const conditionMode = getD20ConditionMode({
    subject: conditionSubject,
    testType: 'saving_throw',
    ability: save.ability,
  });
  const conditionSources = getD20ConditionSources({
    subject: conditionSubject,
    testType: 'saving_throw',
    ability: save.ability,
  });
  const activeAdvantageSources = getActiveD20AdvantageSources(worldState, {
    testType: 'saving_throw',
    ability: save.ability,
  });
  const speciesAdvantageSources = getSpeciesD20AdvantageSources({
    characterSheet,
    testType: 'saving_throw',
    ability: save.ability,
    reason: intent.raw,
  });
  const advantageMode = combineAdvantageModes(conditionMode, [...activeAdvantageSources, ...speciesAdvantageSources].length ? 'advantage' : null);
  const advantageSources = [...conditionSources, ...activeAdvantageSources, ...speciesAdvantageSources];
  const pendingRoll = {
    id: `roll_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'saving_throw',
    ability: save.ability,
    label: save.label,
    formula: `1d20${formatSigned(modifier.total)}`,
    modifier: modifier.total,
    modifier_breakdown: modifier.breakdown,
    bonus_die: bonus?.die || null,
    bonus_source: bonus?.label || null,
    bonus_effect_ids: bonus?.expiresOnUse ? [bonus.effectId] : [],
    reroll_rules: getAutoD20RerollRules(characterSheet),
    advantage_mode: advantageMode,
    advantage_sources: advantageSources,
    dc,
    dc_source: buildDcSource(dc, intent.raw, inCombat),
    intent: intent.raw,
    consumes: 'forced_save',
    combat: Boolean(inCombat),
    created_turn: currentTurn,
    success_result: `${save.label} succeeds. You resist the immediate danger or reduce its impact as the scene allows.`,
    failure_result: `${save.label} fails. The danger lands cleanly enough to matter.`,
  };

  return {
    handled: true,
    logType: 'referee_pending_save',
    worldState: {
      ...worldState,
      pending_roll: pendingRoll,
    },
    reply: `Make a DC ${dc} ${save.label}.${formatAdvantageModeText(advantageMode, advantageSources)}${bonus ? ` Add ${bonus.die} from ${bonus.label}.` : ''} [SAVE: id=${pendingRoll.id} ability=${save.ability} modifier=${modifier.total} breakdown="${sanitizeTagValue(modifier.breakdown)}"${formatBonusDieTag(bonus)}]`,
  };
}

function promptDeathSave({ worldState, characterSheet = {}, currentTurn = 0 }) {
  if (worldState.pending_roll?.kind === 'death_save') {
    return {
      handled: true,
      logType: 'referee_death_save_pending',
      worldState,
      reply: `You are still at 0 HP. Resolve the pending death saving throw before doing anything else. The afterlife paperwork has a queue. ${rollTagForPending(worldState.pending_roll)}`,
    };
  }

  const pendingRoll = {
    id: `roll_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'death_save',
    formula: '1d20',
    modifier: 0,
    dc: 10,
    dc_source: 'death saving throw: 10 or higher succeeds; natural 1 counts as two failures; natural 20 restores 1 HP',
    reroll_rules: getAutoD20RerollRules(characterSheet),
    consumes: 'death_save',
    combat: true,
    created_turn: currentTurn,
  };

  return {
    handled: true,
    logType: 'referee_death_save_prompt',
    worldState: {
      ...worldState,
      pending_roll: pendingRoll,
    },
    reply: `You are at 0 HP. Make a death saving throw. ${rollTagForPending(pendingRoll)}`,
  };
}

function resolvePendingRoll({ message, worldState, characterSheet, rollDie }) {
  const request = parseRollRequest(message);
  const clientResult = parseRollResult(message);
  if (!request && !clientResult) return null;

  const pending = worldState.pending_roll;
  if (!pending) {
    if (request) {
      return {
        handled: true,
        logType: 'referee_no_pending_roll',
        worldState,
        reply: 'There is no pending roll to resolve. Declare an action first, then the Game Master will call for dice when the rules want their dramatic little entrance.',
      };
    }
    return null;
  }

  if (!request) {
    return {
      handled: true,
      logType: 'referee_client_roll_rejected',
      worldState,
      reply: `Use the Roll button for the pending ${pending.label || pending.kind || 'roll'} so the server can roll it authoritatively. Typed results are not accepted; the dice union was very firm about this.${rollTagForPending(pending) ? ` ${rollTagForPending(pending)}` : ''}`,
    };
  }

  if (pending.id && request.id !== pending.id) {
    return {
      handled: true,
      logType: 'referee_roll_id_mismatch',
      worldState,
      reply: `That roll request does not match the pending ${pending.label || pending.kind || 'roll'}. Use the current Roll button.${rollTagForPending(pending) ? ` ${rollTagForPending(pending)}` : ''}`,
    };
  }

  const result = rollPendingRequest(pending, rollDie);

  if (pending.kind === 'initiative') {
    return resolveInitiative({ pending, result, worldState, characterSheet, rollDie });
  }

  if (pending.kind === 'skill_check' || pending.kind === 'ability_check' || pending.kind === 'saving_throw') {
    return resolveCheckRoll({ pending, result, worldState, characterSheet });
  }

  if (pending.kind === 'death_save') {
    return resolveDeathSave({ pending, result, worldState, characterSheet, rollDie });
  }

  if (pending.kind === 'concentration_save') {
    return resolveConcentrationSave({ pending, result, worldState, characterSheet });
  }

  return null;
}

function rollPendingRequest(pending = {}, rollDie = defaultRollDie) {
  return resolveD20Test({
    kind: pending.kind,
    modifier: Number(pending.modifier || 0),
    dc: pending.dc ?? null,
    advantageMode: pending.advantage_mode || null,
    bonusDice: pending.bonus_die
      ? [{
        die: pending.bonus_die,
        label: pending.bonus_source || 'bonus',
        effectId: pending.bonus_effect_ids?.[0],
        expiresOnUse: Boolean(pending.bonus_effect_ids?.length),
      }]
      : [],
    rerollRules: pending.reroll_rules || [],
    rollDie,
  });
}

function remindPendingRoll({ worldState }) {
  const pending = worldState.pending_roll;
  const tag = rollTagForPending(pending);
  const label = pending.label || pending.kind || 'roll';
  return {
    handled: true,
    logType: 'referee_pending_roll_required',
    worldState,
    reply: `Resolve the pending ${label} before taking another action. The dice are already on stage and refusing to leave.${tag ? ` ${tag}` : ''}`,
  };
}

function resolveCheckRoll({ pending, result, worldState, characterSheet }) {
  const margin = result.total - Number(pending.dc || DEFAULT_CHECK_DC);
  const outcome = getRollOutcome({ pending, margin });
  let nextState = {
    ...worldState,
    pending_roll: null,
  };
  if (pending.bonus_effect_ids?.length) {
    nextState = consumeActiveEffects(nextState, pending.bonus_effect_ids, characterSheet);
  }

  let reply = buildCheckResolutionReply(pending, result, outcome);
  const hiddenOutcome = applyHideCheckOutcome({
    pending,
    result,
    outcome,
    worldState: nextState,
    characterSheet,
  });
  nextState = hiddenOutcome.worldState;
  if (hiddenOutcome.lines.length) reply += `\n\n${hiddenOutcome.lines.join('\n\n')}`;
  const socialOutcome = applySocialCheckOutcome({
    pending,
    result,
    outcome,
    worldState: nextState,
  });
  nextState = socialOutcome.worldState;
  if (socialOutcome.lines.length) reply += `\n\n${socialOutcome.lines.join('\n\n')}`;
  const discoveryOutcome = applyDiscoveryCheckOutcome({
    pending,
    result,
    outcome,
    worldState: nextState,
  });
  nextState = discoveryOutcome.worldState;
  if (discoveryOutcome.lines.length) reply += `\n\n${discoveryOutcome.lines.join('\n\n')}`;
  const objectOutcome = applyObjectChallengeOutcome({
    pending,
    result,
    outcome,
    worldState: nextState,
  });
  nextState = objectOutcome.worldState;
  if (objectOutcome.lines.length) reply += `\n\n${objectOutcome.lines.join('\n\n')}`;
  if (!pending.combat) {
    const advanced = advanceNarrativeTime({
      message: pending.intent || '',
      worldState: nextState,
      characterSheet,
      defaultElapsed: { minutes: 1 },
    });
    nextState = advanced.worldState;
    if (advanced.replySuffix) reply += advanced.replySuffix;
  }
  if (pending.combat && worldState.combat_state?.active) {
    const continued = continuePlayerTurn(nextState, reply, characterSheet);
    return {
      handled: true,
      logType: 'referee_roll_resolution_combat',
      worldState: continued.worldState,
      reply: continued.reply,
    };
  }

  return {
    handled: true,
    logType: 'referee_roll_resolution',
    worldState: nextState,
    reply,
  };
}

function resolveDeathSave({ result, worldState, characterSheet, rollDie }) {
  const current = worldState.player_stats?.death_saves || { successes: 0, failures: 0 };
  const natural = Number(result.natural || result.total || 0);
  let successes = Number(current.successes || 0);
  let failures = Number(current.failures || 0);
  let nextState = {
    ...worldState,
    pending_roll: null,
  };
  let reply;

  if (natural === 20) {
    nextState = updatePlayerHp({
      worldState: nextState,
      hp: 1,
      deathSaves: { successes: 0, failures: 0 },
    });
    reply = '**Natural 20.** You regain 1 HP and consciousness. The grave will have to reschedule.';
  } else {
    if (natural === 1) failures += 2;
    else if (result.total >= 10) successes += 1;
    else failures += 1;

    const deathSaves = { successes: Math.min(successes, 3), failures: Math.min(failures, 3) };
    nextState = updatePlayerHp({ worldState: nextState, hp: 0, deathSaves });
    if (deathSaves.failures >= 3) {
      reply = `Death saving throw ${result.total}: **failure**. Death saves: ${deathSaves.successes} successes, ${deathSaves.failures} failures. **Your character dies.**`;
    } else if (deathSaves.successes >= 3) {
      reply = `Death saving throw ${result.total}: **success**. Death saves: 3 successes, ${deathSaves.failures} failures. You are stable at 0 HP.`;
    } else {
      const outcome = result.total >= 10 ? '**success**' : '**failure**';
      const naturalText = natural === 1 ? ' Natural 1 counts as two failures.' : '';
      reply = `Death saving throw ${result.total}: ${outcome}.${naturalText} Death saves: ${deathSaves.successes} successes, ${deathSaves.failures} failures.`;
    }
  }

  if (worldState.combat_state?.active && getDeathSaveStatus(nextState) === 'dying') {
    const combatResult = advanceEnemyTurns({
      worldState: nextState,
      characterSheet,
      rollDie,
      playerTurnNote: reply,
      playerDodging: false,
    });
    return {
      handled: true,
      logType: 'referee_death_save_resolution_combat',
      worldState: combatResult.worldState,
      reply: combatResult.reply,
    };
  }

  return {
    handled: true,
    logType: 'referee_death_save_resolution',
    worldState: nextState,
    reply,
  };
}

function resolveConcentrationSave({ pending, result, worldState, characterSheet }) {
  const dc = Number(pending.dc || 10);
  const succeeded = Number(result.total || 0) >= dc;
  let nextState = {
    ...worldState,
    pending_roll: null,
  };

  if (succeeded) {
    return {
      handled: true,
      logType: 'referee_concentration_save',
      worldState: nextState,
      reply: `Concentration saving throw ${result.total} vs DC ${dc}: **success**.\n\nYou maintain concentration on ${formatList(pending.effect_names)}. It is your turn.`,
    };
  }

  const ended = endConcentration(nextState, characterSheet);
  nextState = ended.worldState;
  return {
    handled: true,
    logType: 'referee_concentration_save',
    worldState: nextState,
    reply: `Concentration saving throw ${result.total} vs DC ${dc}: **failure**.\n\nConcentration ends on ${formatList(ended.endedEffects.map((effect) => effect.name || effect.id))}. It is your turn.`,
  };
}

function getRollOutcome({ pending, margin }) {
  if (pending.kind === 'saving_throw') {
    return margin >= 0 ? 'success' : 'failure';
  }
  if (margin >= 0) return 'success';
  if (margin >= -2) return 'near_miss';
  return 'failure';
}

function getDeathSaveStatus(worldState = {}) {
  if (Number(worldState.player_stats?.hp || 0) > 0) return 'conscious';
  const saves = worldState.player_stats?.death_saves || { successes: 0, failures: 0 };
  if (Number(saves.failures || 0) >= 3) return 'dead';
  if (Number(saves.successes || 0) >= 3) return 'stable';
  return 'dying';
}

function buildCheckResolutionReply(pending, result, outcome) {
  const dc = Number(pending.dc || DEFAULT_CHECK_DC);
  const label = pending.kind === 'saving_throw' ? pending.label || 'Saving throw' : 'Roll';
  const rolled = result.rollText || String(result.total);
  const rollLine = `${label} ${rolled} vs DC ${dc}: ${outcome === 'success' ? '**success**' : outcome === 'near_miss' ? '**near miss**' : '**failure**'}.`;
  if (outcome === 'success') return `${rollLine}\n\n${pending.success_result || 'You accomplish what you set out to do.'}`;
  if (outcome === 'near_miss') {
    return `${rollLine}\n\nYou do not get the clean result you wanted, but you catch enough to keep moving: ${pending.failure_result || 'the attempt does not fully work.'}`;
  }
  return `${rollLine}\n\n${pending.failure_result || 'The attempt fails, and the world refuses to politely pretend otherwise.'}`;
}

function isCombatStarter(text) {
  return /\b(?:attack|hit|strike|stab|swing at|shoot|charge|punch|kick|headbutt|elbow|start (?:a )?fight)\b/i.test(text);
}

function validateCombatStartTarget({ message, worldState }) {
  if (!worldState.scene_presence?.exact_location) return null;

  const target = extractCombatStartTarget(message);
  if (!target) {
    const present = formatScenePresence(worldState);
    return {
      handled: true,
      logType: 'referee_combat_target_needed',
      worldState,
      reply: `Combat needs a target. Who are you attacking here${present ? `? Present: ${present}.` : '?'}`,
    };
  }

  const spatialIssue = checkSpatialAction(message, worldState);
  if (!spatialIssue && combatTargetAppearsPresent(worldState, target)) return null;

  return {
    handled: true,
    logType: 'referee_combat_spatial_block',
    worldState,
    reply: spatialIssue?.message || `You are currently at ${currentSceneLocation(worldState)}, and ${target} is not here. ${missingTargetPrompt(target)}`,
  };
}

function combatTargetAppearsPresent(worldState = {}, target = '') {
  const scene = worldState.scene_presence || {};
  return targetMatchesSceneList([...(scene.present_npcs || []), ...(scene.present_objects || [])], target);
}

function targetMatchesSceneList(list = [], target = '') {
  const normalizedTarget = singularizeTarget(normalizeTargetPhrase(target));
  if (!normalizedTarget) return false;
  return list.some((item) => {
    const normalizedItem = singularizeTarget(normalizeTargetPhrase(item));
    if (!normalizedItem) return false;
    return normalizedItem === normalizedTarget
      || normalizedItem.includes(normalizedTarget)
      || normalizedTarget.includes(normalizedItem)
      || targetTokensOverlap(normalizedItem, normalizedTarget);
  });
}

function targetTokensOverlap(left, right) {
  const leftTokens = new Set(left.split(' ').filter(isTargetToken));
  const rightTokens = right.split(' ').filter(isTargetToken);
  return rightTokens.some((token) => leftTokens.has(token));
}

function isTargetToken(token) {
  return token.length >= 4 && !['with', 'that', 'this', 'from', 'near', 'away', 'toward'].includes(token);
}

function singularizeTarget(value) {
  return value.endsWith('s') && value.length > 3 ? value.slice(0, -1) : value;
}

function currentSceneLocation(worldState = {}) {
  return String(worldState.scene_presence?.exact_location || worldState.current_location || 'your current location');
}

function missingTargetPrompt(target = '') {
  if (targetLooksAnimate(target)) {
    return 'Do you look for them, move toward where they might be, or clarify who you mean?';
  }
  return 'Do you look around for it, or clarify where you mean?';
}

function targetLooksAnimate(target = '') {
  return /\b(?:acolyte|bandit|blacksmith|boy|clerk|creature|cultist|dragon|enemy|figure|girl|goblin|guard|hostile|innkeeper|keeper|man|merchant|monster|orc|person|priest|reeve|shadow|shopkeeper|stranger|thug|watchman|watchwoman|wolf|woman)\b/i.test(String(target));
}

function formatScenePresence(worldState = {}) {
  const scene = worldState.scene_presence || {};
  return [...(scene.present_npcs || []), ...(scene.present_objects || [])]
    .filter(Boolean)
    .slice(0, 5)
    .join(', ');
}

function getRestIntent(text) {
  const lower = String(text || '').toLowerCase();
  if (/\b(long rest|sleep for the night|rest for the night|make camp and sleep)\b/.test(lower)) {
    return { type: 'long', minutes: 8 * 60 };
  }
  if (/\b(short rest|take a breather|rest for an hour|rest 1 hour)\b/.test(lower)) {
    return { type: 'short', minutes: 60 };
  }
  return null;
}

function getTimePassageIntent(text) {
  const lower = String(text || '').toLowerCase();
  const match = lower.match(/\b(?:wait|watch|keep watch|linger|spend|pass)\s+(?:for\s+)?(\d+)\s*(rounds?|minutes?|hours?)\b/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (unit.startsWith('round')) return { rounds: amount, label: `${amount} round${amount === 1 ? '' : 's'}` };
  if (unit.startsWith('hour')) return { minutes: amount * 60, label: `${amount} hour${amount === 1 ? '' : 's'}` };
  return { minutes: amount, label: `${amount} minute${amount === 1 ? '' : 's'}` };
}

function wantsAmmunitionRecovery(text) {
  return /\b(?:recover|retrieve|collect|gather|search(?:ing)?(?: the battlefield)? for|pick up)\b.*\b(?:ammunition|arrows?|bolts?|needles?|sling bullets?)\b/i
    .test(String(text || ''));
}

function resolveAmmunitionRecovery({ worldState }) {
  const recovered = recoverSpentAmmunition(worldState);
  if (!recovered.ok) {
    return {
      handled: true,
      logType: 'referee_ammunition_recovery_blocked',
      worldState,
      reply: recovered.reply,
    };
  }
  const timed = resolveTimePassage({
    timeIntent: { minutes: 1, label: '1 minute' },
    worldState: recovered.worldState,
  });
  const timeNote = timed.reply.replace(/^You let \*\*1 minute\*\* pass\. /, '');
  const summary = recovered.recoveries.length
    ? recovered.recoveries.map((entry) => `${entry.quantity} ${formatRecoveredAmmunition(entry.id, entry.quantity)}`).join(', ')
    : 'no usable ammunition';
  return {
    handled: true,
    logType: 'referee_ammunition_recovery',
    worldState: timed.worldState,
    reply: `You spend **1 minute** searching the battlefield and recover ${summary}. Bent shafts, vanished shots, and dramatic shrubbery claim the rest. ${timeNote}`,
  };
}

function formatRecoveredAmmunition(id, quantity) {
  const name = String(id || 'ammunition').replaceAll('_', ' ');
  return Number(quantity) === 1 && name.endsWith('s') ? name.slice(0, -1) : name;
}

function resolveRest({ restIntent, worldState, characterSheet, rollDie = defaultRollDie }) {
  if (worldState.combat_state?.active) {
    return {
      handled: true,
      logType: 'referee_rest_blocked_combat',
      worldState,
      reply: 'Combat is active. You cannot rest while initiative is running unless everyone hostile agrees to a snack break, and they have not signed the form.',
    };
  }

  const ticked = tickActiveEffects(worldState, { minutes: restIntent.minutes });
  const baseState = {
    ...ticked.worldState,
    time_state: {
      ...(ticked.worldState.time_state || {}),
      elapsed_minutes: Number(ticked.worldState.time_state?.elapsed_minutes || 0) + restIntent.minutes,
      scene_time: restIntent.type === 'long' ? 'after a long rest' : 'after a short rest',
    },
  };

  const restResult = restIntent.type === 'long'
    ? completeLongRest(baseState, characterSheet)
    : completeShortRest(baseState, characterSheet, rollDie);
  const nextState = restResult.worldState;
  const expired = ticked.expiredEffects.length
    ? ` Expired effects: ${ticked.expiredEffects.map((effect) => effect.name || effect.id).join(', ')}.`
    : '';
  const reply = restIntent.type === 'long'
    ? `You complete a **long rest**. HP, death saves, spell slots, and once-per-rest spell uses reset.${restResult.note ? ` ${restResult.note}` : ''}${expired}`
    : `You complete a **short rest**. Time passes, short-rest resources refresh where your sheet supports them, and active durations tick down.${restResult.note ? ` ${restResult.note}` : ''}${expired}`;

  return {
    handled: true,
    logType: `referee_${restIntent.type}_rest`,
    worldState: nextState,
    reply,
  };
}

function resolveTimePassage({ timeIntent, worldState }) {
  if (worldState.combat_state?.active) {
    return {
      handled: true,
      logType: 'referee_time_blocked_combat',
      worldState,
      reply: 'Combat is active. Time is already measured in rounds; use your turn action instead of free-waiting through danger.',
    };
  }

  const ticked = tickActiveEffects(worldState, {
    rounds: timeIntent.rounds || 0,
    minutes: timeIntent.minutes || 0,
  });
  const elapsedMinutes = Number(ticked.worldState.time_state?.elapsed_minutes || 0) + Number(timeIntent.minutes || 0);
  const elapsedRounds = Number(ticked.worldState.time_state?.elapsed_rounds || 0) + Number(timeIntent.rounds || 0);
  const expired = ticked.expiredEffects.length
    ? ` Expired effects: ${ticked.expiredEffects.map((effect) => effect.name || effect.id).join(', ')}.`
    : '';
  return {
    handled: true,
    logType: 'referee_time_passage',
    worldState: {
      ...ticked.worldState,
      time_state: {
        ...(ticked.worldState.time_state || {}),
        elapsed_minutes: elapsedMinutes,
        elapsed_rounds: elapsedRounds,
        scene_time: `${timeIntent.label} later`,
      },
    },
    reply: `You let **${timeIntent.label}** pass. Active durations tick down.${expired}`,
  };
}

function completeLongRest(worldState, characterSheet = {}) {
  const maxHp = Number(characterSheet?.derived_stats?.max_hp ?? worldState.player_stats?.max_hp ?? worldState.player_stats?.hp ?? 1);
  const maxSlots = getMaxSpellSlots(characterSheet);
  const hitDice = getHitDiceState(characterSheet, worldState);
  const resourceResult = completeLongRestResources({ characterSheet, worldState });
  return {
    worldState: mergeWorldResources({
      ...worldState,
      active_effects: [],
      pending_roll: null,
      player_stats: {
        ...(worldState.player_stats || {}),
        hp: maxHp,
        max_hp: maxHp,
        temp_hp: 0,
        death_saves: { successes: 0, failures: 0 },
        conditions: [],
        spell_slots: maxSlots,
        reset_spell_uses: true,
        hit_dice: {
          die: hitDice.die,
          remaining: hitDice.max,
          max: hitDice.max,
        },
        hit_dice_remaining: hitDice.max,
      },
    }, resourceResult.resources),
    note: resourceResult.notes.join(' '),
  };
}

function completeShortRest(worldState, characterSheet = {}, rollDie = defaultRollDie) {
  let resourceResult = completeShortRestResources({ characterSheet, worldState });
  const classId = characterSheet?.identity?.class;
  let nextSlots = classId === 'warlock'
    ? getMaxSpellSlots(characterSheet)
    : worldState.player_stats?.spell_slots;
  const arcaneRecovery = applyArcaneRecovery({ characterSheet, worldState, resources: resourceResult.resources, spellSlots: nextSlots });
  resourceResult = {
    resources: arcaneRecovery.resources,
    notes: [...resourceResult.notes, ...arcaneRecovery.notes],
  };
  nextSlots = arcaneRecovery.spellSlots;
  const hitDice = getHitDiceState(characterSheet, worldState);
  const maxHp = Number(characterSheet?.derived_stats?.max_hp ?? worldState.player_stats?.max_hp ?? worldState.player_stats?.hp ?? 1);
  let hp = Number(worldState.player_stats?.hp ?? characterSheet?.derived_stats?.hp ?? maxHp);
  let remainingHitDice = hitDice.remaining;
  const conMod = Number(characterSheet?.abilities?.modifiers?.con || 0);
  const rolls = [];
  while (hp < maxHp && remainingHitDice > 0) {
    const roll = rollDie(hitDice.die);
    const heal = Math.max(1, roll + conMod);
    rolls.push({ roll, heal });
    hp = Math.min(maxHp, hp + heal);
    remainingHitDice -= 1;
  }

  const note = rolls.length
    ? `Spent ${rolls.length} Hit ${rolls.length === 1 ? 'Die' : 'Dice'} (d${hitDice.die}${formatSigned(conMod)}): ${rolls.map((item) => item.heal).join(', ')} healing. HP is now ${hp}/${maxHp}.`
    : hp >= maxHp
      ? `No Hit Dice spent because HP is already full (${hp}/${maxHp}).`
      : 'No Hit Dice remain to spend for healing.';

  return {
    worldState: mergeWorldResources({
      ...worldState,
      player_stats: {
        ...(worldState.player_stats || {}),
        hp,
        max_hp: maxHp,
        spell_slots: nextSlots,
        hit_dice: {
          die: hitDice.die,
          remaining: remainingHitDice,
          max: hitDice.max,
        },
        hit_dice_remaining: remainingHitDice,
      },
    }, resourceResult.resources),
    note: [note, ...resourceResult.notes].filter(Boolean).join(' '),
  };
}

function applyArcaneRecovery({ characterSheet = {}, worldState = {}, resources = {}, spellSlots = {} } = {}) {
  if (normalizeTargetPhrase(characterSheet.identity?.class) !== 'wizard') {
    return { resources, spellSlots, notes: [] };
  }
  const recovery = resources.arcane_recovery;
  if (!recovery || Number(recovery.remaining || 0) <= 0) {
    return { resources, spellSlots, notes: [] };
  }

  const maxSlots = getMaxSpellSlots(characterSheet);
  const currentSlots = { ...(spellSlots || worldState.player_stats?.spell_slots || {}) };
  const maxFirstLevel = Number(maxSlots[1] ?? maxSlots['1'] ?? 0);
  const currentFirstLevel = Number(currentSlots[1] ?? currentSlots['1'] ?? 0);
  if (maxFirstLevel <= 0 || currentFirstLevel >= maxFirstLevel) {
    return { resources, spellSlots: currentSlots, notes: [] };
  }

  return {
    resources: {
      ...resources,
      arcane_recovery: {
        ...recovery,
        remaining: Math.max(0, Number(recovery.remaining || 0) - 1),
      },
    },
    spellSlots: {
      ...currentSlots,
      1: Math.min(maxFirstLevel, currentFirstLevel + 1),
    },
    notes: ['Arcane Recovery restores one expended level 1 spell slot.'],
  };
}

function getMaxSpellSlots(characterSheet = {}) {
  const classId = characterSheet?.identity?.class;
  const content = getContentBundle();
  const classData = content.classes.find((item) => item.id === classId);
  return classData?.spellcasting?.slots || characterSheet?.spellcasting?.slots || {};
}

function getHitDiceState(characterSheet = {}, worldState = {}) {
  const classId = characterSheet?.identity?.class;
  const content = getContentBundle();
  const classData = content.classes.find((item) => item.id === classId);
  const die = Number(
    worldState.player_stats?.hit_dice?.die
      ?? characterSheet.resources?.hit_dice?.die
      ?? classData?.hit_die
      ?? 8,
  );
  const max = Number(
    worldState.player_stats?.hit_dice?.max
      ?? characterSheet.resources?.hit_dice?.max
      ?? characterSheet?.identity?.level
      ?? characterSheet?.derived_stats?.level
      ?? 1,
  );
  const remaining = Number(
    worldState.player_stats?.hit_dice?.remaining
      ?? worldState.player_stats?.hit_dice_remaining
      ?? characterSheet.resources?.hit_dice?.remaining
      ?? max,
  );
  return {
    die,
    max: Math.max(1, max),
    remaining: Math.max(0, Math.min(Math.max(1, max), remaining)),
  };
}

function promptInitiative({ message, worldState, characterSheet, currentTurn = 0 }) {
  const initiative = Number(characterSheet?.derived_stats?.initiative ?? characterSheet?.abilities?.modifiers?.dex ?? 0);
  const enemyName = inferEnemyName(worldState, message);
  const pendingRoll = {
    id: `roll_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'initiative',
    formula: `1d20${formatSigned(initiative)}`,
    modifier: initiative,
    intent: message,
    created_turn: currentTurn,
    enemy: buildDefaultEnemy(enemyName),
  };

  return {
    handled: true,
    logType: 'referee_initiative_prompt',
    worldState: {
      ...worldState,
      pending_roll: pendingRoll,
    },
    reply: `Combat begins. Roll initiative. ${rollTagForPending(pendingRoll)}`,
  };
}

function resolveInitiative({ pending, result, worldState, characterSheet, rollDie }) {
  const player = buildPlayerCombatant(characterSheet, worldState);
  player.initiative = result.total;
  const enemy = {
    ...buildDefaultEnemy(pending.enemy?.name || inferEnemyName(worldState, pending.intent)),
    initiative: rollDie(20) + Number(pending.enemy?.initiative_bonus ?? 1),
  };

  const combatants = [player, enemy].sort((a, b) => b.initiative - a.initiative);
  const playerIndex = combatants.findIndex((combatant) => combatant.is_player);
  const combatState = {
    active: true,
    round: 1,
    turn_index: playerIndex === 0 ? playerIndex : 0,
    combatants,
  };

  let nextState = {
    ...worldState,
    pending_roll: null,
    combat_state: combatState,
    player_stats: {
      ...(worldState.player_stats || {}),
      hp: player.hp,
      max_hp: player.max_hp,
      temp_hp: player.temp_hp,
      armor_class: player.ac,
      defense_fighting_style_applied: player.defense_fighting_style_applied,
    },
  };
  if (playerIndex === 0) {
    nextState = beginPlayerTurn(nextState, characterSheet);
  }

  const order = combatants.map((combatant) => `${combatant.name} (${combatant.initiative})`).join(', ');
  if (playerIndex === 0) {
    return {
      handled: true,
      logType: 'referee_initiative_resolution',
      worldState: nextState,
      reply: `Initiative order: ${order}. **Round 1 begins. It is your turn.**`,
    };
  }

  const enemyResult = advanceEnemyTurns({
    worldState: nextState,
    characterSheet,
    rollDie,
    playerTurnNote: `Initiative order: ${order}. **Round 1 begins.** ${enemy.name} moves first.`,
    playerDodging: false,
    advanceRound: false,
  });
  return {
    handled: true,
    logType: 'referee_initiative_resolution',
    worldState: enemyResult.worldState,
    reply: enemyResult.reply,
  };
}

function resolveCombatAction({ message, intent, worldState, characterSheet, currentTurn, rollDie }) {
  const readyAction = resolveReadyAction({ message, worldState, characterSheet });
  if (readyAction) return readyAction;

  const helpAction = resolveHelpAction({ message, intent, worldState, characterSheet });
  if (helpAction) return helpAction;

  const objectChallenge = resolveObjectChallengeAction({
    message,
    worldState,
    characterSheet,
    currentTurn,
    inCombat: true,
  });
  if (objectChallenge) return objectChallenge;

  const objectInteraction = resolveObjectInteraction({ message, worldState });
  if (objectInteraction?.handled) {
    return {
      handled: true,
      logType: objectInteraction.logType,
      worldState: objectInteraction.worldState,
      reply: objectInteraction.response,
    };
  }
  if (objectInteraction) {
    const spent = spendTurnResource(worldState, 'action', 'Utilize', characterSheet);
    if (!spent.ok) {
      return { handled: true, logType: 'referee_action_unavailable', worldState: spent.worldState, reply: spent.reply };
    }
    const applied = resolveObjectInteraction({ message, worldState: spent.worldState });
    const continued = continuePlayerTurn(
      applied.worldState,
      `You take the **Utilize** action to ${applied.intent.action} ${applied.target.name}. Object state is updated for narration.`,
      characterSheet,
    );
    return { handled: true, logType: 'referee_combat_object_interaction', ...continued };
  }

  if (intent.castsSpell) return null;

  const maneuver = isUnarmedAttackIntent(message) ? null : getCombatManeuverIntent(message);
  if (maneuver) {
    return resolveCombatManeuver({ maneuver, message, worldState, characterSheet, rollDie });
  }

  if (intent.check && shouldPromptCombatCheck(intent)) {
    return promptCheck({ intent, worldState, characterSheet, currentTurn, inCombat: true });
  }

  if (/\b(?:dodge|defend|guard myself|guarded stance)\b/i.test(message)) {
    const spent = spendTurnResource(worldState, 'action', 'Dodge', characterSheet);
    if (!spent.ok) {
      return { handled: true, logType: 'referee_action_unavailable', worldState: spent.worldState, reply: spent.reply };
    }
    const dodging = setTurnFlag(spent.worldState, 'dodging', true, characterSheet);
    const continued = continuePlayerTurn(
      dodging,
      'You take the **Dodge** action, making yourself much harder to hit until your next turn.',
      characterSheet,
    );
    return { handled: true, logType: 'referee_combat_dodge', ...continued };
  }

  if (/\b(?:disengage|carefully withdraw|withdraw safely)\b/i.test(message)) {
    return finishCombatMovementAction({
      result: resolveDisengageAction({ message, worldState, characterSheet, rollDie }),
      characterSheet,
    });
  }

  if (/\b(?:dash|sprint)\b/i.test(message)) {
    return finishCombatMovementAction({
      result: resolveDashAction({ message, worldState, characterSheet, rollDie }),
      characterSheet,
    });
  }

  if (/\b(?:end|finish)\s+(?:my\s+)?turn\b|\b(?:wait|done)\s*$/i.test(message)) {
    const result = advanceEnemyTurns({
      worldState,
      characterSheet,
      rollDie,
      playerTurnNote: 'You end your turn.',
    });
    return { handled: true, logType: 'referee_combat_end_turn', ...result };
  }

  if (isCombatStarter(message) || /\battack\b/i.test(message) || isUnarmedAttackIntent(message)) {
    return resolvePlayerAttack({ message, worldState, characterSheet, rollDie });
  }

  if (isMovementIntent(message)) {
    return finishCombatMovementAction({
      result: resolveCombatMovement({ message, worldState, characterSheet, rollDie }),
      characterSheet,
    });
  }

  return {
    handled: true,
    logType: 'referee_combat_action_needed',
    worldState,
    reply: 'Combat is active and initiative is running. What action do you take this turn: **Attack**, **Shove**, **Grapple**, **Dodge**, **Disengage**, **Hide**, **Search**, **Study**, **Help**, **Ready**, **Utilize**, or a valid spell/action from your sheet?',
  };
}

function resolveObjectChallengeAction({ message, worldState, characterSheet, currentTurn = 0, inCombat = false } = {}) {
  const challenge = resolveObjectChallenge({ message, worldState });
  if (!challenge) return null;
  if (challenge.handled) {
    return {
      handled: true,
      logType: challenge.logType,
      worldState,
      reply: challenge.response,
    };
  }

  let nextWorldState = worldState;
  if (inCombat) {
    const spent = spendTurnResource(worldState, 'action', 'Utilize', characterSheet);
    if (!spent.ok) {
      return { handled: true, logType: 'referee_action_unavailable', worldState: spent.worldState, reply: spent.reply };
    }
    nextWorldState = spent.worldState;
  }

  const modifier = getObjectChallengeModifier(characterSheet, challenge);
  const conditionSubject = getPlayerConditionSubject(characterSheet, worldState);
  const conditionMode = getD20ConditionMode({
    subject: conditionSubject,
    testType: 'ability_check',
    ability: 'dex',
  });
  const conditionSources = getD20ConditionSources({
    subject: conditionSubject,
    testType: 'ability_check',
    ability: 'dex',
  });
  const activeAdvantageSources = getActiveD20AdvantageSources(worldState, {
    testType: 'ability_check',
    ability: 'dex',
  });
  const advantageMode = combineAdvantageModes(conditionMode, activeAdvantageSources.length ? 'advantage' : null);
  const advantageSources = [...conditionSources, ...activeAdvantageSources];
  const pendingRoll = {
    id: `roll_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'ability_check',
    ability: 'dex',
    label: challenge.label,
    formula: `1d20${formatSigned(modifier.total)}`,
    modifier: modifier.total,
    modifier_breakdown: modifier.breakdown,
    reroll_rules: getAutoD20RerollRules(characterSheet),
    advantage_mode: advantageMode,
    advantage_sources: advantageSources,
    dc: challenge.dc,
    dc_source: `${challenge.type === 'trap' ? 'trap disarm' : 'lock'} DC from object state; default 15`,
    intent: message,
    consumes: inCombat ? 'action' : 'exploration',
    combat: Boolean(inCombat),
    created_turn: currentTurn,
    success_result: challenge.successResult,
    failure_result: challenge.failureResult,
    object_challenge: true,
    object_challenge_type: challenge.type,
    object_action: challenge.action,
    object_target_key: challenge.target.key,
    object_target_name: challenge.target.name,
  };

  return {
    handled: true,
    logType: 'referee_object_challenge_pending',
    worldState: {
      ...nextWorldState,
      pending_roll: pendingRoll,
    },
    reply: `Make a DC ${challenge.dc} ${challenge.label} to ${challenge.action} ${challenge.target.name}.${formatAdvantageModeText(advantageMode, advantageSources)}${inCombat ? ' This uses your Action as the **Utilize** action.' : ''} [CHECK: id=${pendingRoll.id} ability=dex modifier=${modifier.total} breakdown="${sanitizeTagValue(modifier.breakdown)}"]`,
  };
}

function getObjectChallengeModifier(characterSheet = {}, challenge = {}) {
  const abilityMod = Number(characterSheet.abilities?.modifiers?.dex || 0);
  const toolId = challenge.tool || 'thieves_tools';
  const toolName = toolId === 'thieves_tools' ? "Thieves' Tools" : titleCase(toolId.replaceAll('_', ' '));
  const hasToolProficiency = (characterSheet.proficiencies?.tools || []).includes(toolId);
  const proficiency = Number(characterSheet.derived_stats?.proficiency_bonus || proficiencyBonus(characterSheet.identity?.level || characterSheet.derived_stats?.level || 1));
  const toolBonus = hasToolProficiency ? proficiency : 0;
  return {
    total: abilityMod + toolBonus,
    breakdown: hasToolProficiency
      ? `DEX modifier ${formatSigned(abilityMod)} + ${toolName} proficiency ${formatSigned(proficiency)} = ${formatSigned(abilityMod + toolBonus)}`
      : `DEX modifier ${formatSigned(abilityMod)}; no ${toolName} proficiency = ${formatSigned(abilityMod)}`,
  };
}

function finishCombatMovementAction({ result, characterSheet }) {
  if (!result?.handled || !result.worldState) return result;

  let nextState = result.worldState;
  const lines = [result.reply];
  if (nextState.pending_reaction) return result;

  const hp = Number(nextState.player_stats?.hp ?? getCurrentHp(characterSheet, nextState));
  if (hp <= 0) {
    const ended = endConcentration(nextState, characterSheet);
    nextState = ended.worldState;
    if (ended.endedEffects.length > 0) {
      lines.push(`Concentration ends: ${ended.endedEffects.map((effect) => effect.name || effect.id).join(', ')}.`);
    }
  } else {
    const concentrationPrompt = buildConcentrationPrompt({
      worldState: nextState,
      characterSheet,
      damageEvents: result.damageEvents || [],
    });
    if (concentrationPrompt) {
      nextState = {
        ...nextState,
        pending_roll: concentrationPrompt.pendingRoll,
      };
      lines.push(concentrationPrompt.reply);
    }
  }
  if (nextState.combat_state?.active && !hasLivingEnemies(nextState.combat_state)) {
    nextState = {
      ...nextState,
      combat_state: null,
    };
    lines.push('All active enemies are down. **Combat ends.**');
  }

  return {
    ...result,
    worldState: nextState,
    reply: lines.filter(Boolean).join('\n\n'),
  };
}

function hasLivingEnemies(combat = {}) {
  return (combat.combatants || []).some((combatant) => !combatant.is_player && Number(combatant.hp) > 0);
}

function shouldPromptCombatCheck(intent) {
  return ['hide', 'search', 'study', 'influence'].includes(intent.ruleAction) || Boolean(intent.check);
}

function resolvePlayerAttack({ message = '', worldState, characterSheet, rollDie }) {
  const spent = spendTurnResource(worldState, 'action', 'Attack', characterSheet);
  if (!spent.ok) {
    return {
      handled: true,
      logType: 'referee_action_unavailable',
      worldState: spent.worldState,
      reply: spent.reply,
    };
  }

  let combat = cloneCombatState(spent.worldState.combat_state);
  let player = combat.combatants.find((combatant) => combatant.is_player);
  let target = findCombatTarget(combat, message) || getLivingEnemy(combat);
  if (!player || !target) {
    return endCombat(worldState, 'There is no active enemy left to attack. Combat ends before the initiative tracker has to file a complaint.');
  }

  const blocked = getTurnBlockReason(player);
  if (blocked) {
    return {
      handled: true,
      logType: 'referee_player_condition_blocked',
      worldState: spent.worldState,
      reply: `You cannot attack right now: ${blocked}.`,
    };
  }

  const preparedAttack = prepareWeaponAttack({
    attack: getPrimaryAttack(characterSheet, message),
    message,
    characterSheet,
    player,
    target,
  });
  if (!preparedAttack.ok) {
    return {
      handled: true,
      logType: 'referee_weapon_attack_unavailable',
      worldState,
      reply: preparedAttack.reply,
    };
  }
  const ammunitionCheck = checkAmmunitionAttack({
    attack: preparedAttack.attack,
    worldState: spent.worldState,
    characterSheet,
    actionResource: 'action',
  });
  if (!ammunitionCheck.ok) {
    return {
      handled: true,
      logType: 'referee_weapon_attack_unavailable',
      worldState,
      reply: ammunitionCheck.reply,
    };
  }
  const ammunitionSpent = spendAmmunitionForAttack({
    attack: preparedAttack.attack,
    worldState: spent.worldState,
    characterSheet,
    actionResource: 'action',
  });
  combat = cloneCombatState(ammunitionSpent.worldState.combat_state);
  player = combat.combatants.find((combatant) => combatant.is_player);
  target = findCombatTarget(combat, message) || getLivingEnemy(combat);
  const attack = applyFightingStyleToAttack({
    attack: preparedAttack.attack,
    characterSheet,
    message,
  });
  const lightExtra = getLightExtraAttack({ characterSheet, primaryAttack: attack, message });
  const propertyMode = getWeaponPropertyAttackMode({ attack, characterSheet, player, target, combat });
  const propertySources = getWeaponPropertyAttackSources({ attack, characterSheet, player, target, combat });
  const helped = applyHelpToAttack({
    worldState: ammunitionSpent.worldState,
    combat,
    attacker: player,
    target,
    advantageMode: combineAdvantageModes(getAttackAdvantageMode(player, target), propertyMode),
    sources: [...getAttackAdvantageSources(player, target), ...propertySources],
  });
  combat = helped.combat;
  player = helped.attacker;
  target = helped.target;
  const lucky = applyLuckyToImmediateD20({
    message,
    worldState: helped.worldState,
    characterSheet,
    advantageMode: helped.advantageMode,
    sources: helped.sources,
  });
  let attackState = lucky.worldState;
  const advantageMode = lucky.advantageMode;
  const attackRoll = resolveD20Test({
    kind: 'attack',
    modifier: attack.attackBonus,
    dc: Number(target.ac || 10),
    advantageMode,
    bonusDice: getActiveBonusDice(attackState, 'attack'),
    rerollRules: getAutoD20RerollRules(characterSheet),
    rollDie,
  });
  const natural = attackRoll.natural;
  const attackBonusDice = attackRoll.bonusDice;
  const attackTotal = attackRoll.total;
  const isCrit = natural === 20;
  const criticalMiss = natural === 1;
  const hit = !criticalMiss && (isCrit || attackTotal >= Number(target.ac || 10));
  const lines = [
    `You attack ${target.name} with ${attack.name}. Attack roll: ${attackRoll.rollText} vs AC ${target.ac}.`,
    ...ammunitionSpent.lines,
  ];
  if (advantageMode) lines.push(`Attack roll has ${advantageMode} from ${formatList(lucky.sources)}.`);
  if (lucky.note) lines.push(lucky.note);
  const reveal = clearPlayerHidden({ worldState: attackState, reason: 'attack' });
  if (reveal.revealed) {
    attackState = reveal.worldState;
    combat = cloneCombatState(reveal.combat);
    player = combat.combatants.find((combatant) => combatant.is_player);
    target = findCombatTarget(combat, target.name) || target;
    lines.push(reveal.line);
  }

  const consumeEffectIds = [];
  let sneakAttackUsed = false;
  let savageAttackerUsed = false;
  let cleaveExtra = null;
  Object.assign(target, consumeVexAdvantage(target));
  if (hit) {
    const damage = rollWeaponDamage({ formula: getWeaponDamageFormula({ attack, message, characterSheet }), characterSheet, rollDie, crit: isCrit, attack });
    savageAttackerUsed = Boolean(damage.savageAttacker);
    const bonusDamage = rollBonusDice(getActiveDamageDice(attackState, target), rollDie);
    const flatBonuses = getActiveDamageBonuses(attackState, { attack, characterSheet });
    const fightingStyleBonus = getFightingStyleDamageBonus({ characterSheet, attack, message });
    const flatBonusTotal = flatBonuses.reduce((sum, bonus) => sum + Number(bonus.value || 0), 0) + fightingStyleBonus.total;
    const sneakAttack = getSneakAttackDamage({ characterSheet, attack, advantageMode, rollDie, crit: isCrit });
    sneakAttackUsed = sneakAttack.total > 0;
    const totalDamage = damage.total + bonusDamage.total + flatBonusTotal + sneakAttack.total;
    const before = Number(target.hp || 0);
    target.hp = Math.max(0, before - totalDamage);
    const damageParts = [
      `${damage.total} ${attack.isWeapon ? 'weapon' : 'unarmed'}`,
      bonusDamage.total ? bonusDamage.summary : '',
      flatBonuses.length ? flatBonuses.map((bonus) => `${bonus.label} ${formatSigned(bonus.value)}`).join(' + ') : '',
      fightingStyleBonus.total ? `${fightingStyleBonus.label} ${formatSigned(fightingStyleBonus.total)}` : '',
      sneakAttack.total ? `Sneak Attack ${sneakAttack.die}=${sneakAttack.total}` : '',
    ].filter(Boolean);
    lines.push(`${isCrit ? '**Critical hit.** ' : ''}Hit for ${totalDamage} damage${damageParts.length > 1 ? ` (${damageParts.join(' + ')})` : ''}. ${target.name}: (${before} -> ${target.hp} HP).`);
    if (damage.note) lines.push(damage.note);
    if (attack.tavernBrawlerPush && Number(target.hp) > 0) {
      target.forced_movement = { feet: 5, direction: 'away_from_player', source: 'Tavern Brawler' };
      lines.push(`**Tavern Brawler** pushes ${target.name} 5 feet away, subject to available space in the scene.`);
    }
    consumeEffectIds.push(...bonusDamage.expireEffectIds);
    if ((target.conditions || []).includes('sleep')) {
      target.conditions = (target.conditions || []).filter((condition) => condition !== 'sleep' && condition !== 'unconscious');
      consumeEffectIds.push('sleep');
      if (Number(target.hp) > 0) lines.push(`${target.name} wakes as the damage lands. Extremely rude alarm clock, but effective.`);
    }
    lines.push(...applyWeaponMasteryOnHit({ attack, target, combat, characterSheet, damageDealt: totalDamage, rollDie }).lines);
    const ancestry = applyGiantAncestryOnHit({
      message,
      target,
      combat,
      worldState: { ...attackState, combat_state: combat },
      characterSheet,
      damageDealt: totalDamage,
      crit: isCrit,
      rollDie,
    });
    combat = ancestry.combat;
    attackState = ancestry.worldState;
    target = findCombatTarget(combat, target.name) || target;
    lines.push(...ancestry.lines);
    cleaveExtra = getCleaveExtraAttack({ characterSheet, attack, primaryTarget: target, combat, message });
  } else if (criticalMiss) {
    lines.push('**Critical miss.** The attack fails no matter how pretty the math looked in the margins.');
    lines.push(...applyWeaponMasteryOnMiss({ attack, target, characterSheet }).lines);
  } else {
    lines.push('Miss. The attack fails to connect, which is rude but rules-compliant.');
    lines.push(...applyWeaponMasteryOnMiss({ attack, target, characterSheet }).lines);
  }
  consumeEffectIds.push(...attackBonusDice.expireEffectIds);
  if ((target.conditions || []).includes('guiding_bolt_advantage')) {
    target.conditions = (target.conditions || []).filter((condition) => condition !== 'guiding_bolt_advantage');
  }

  if (Number(target.hp) <= 0) lines.push(`${target.name} falls.`);

  if (cleaveExtra?.ok) {
    combat = markCleaveUsed(combat);
    lines.push(`**Cleave mastery:** you make one extra attack against ${cleaveExtra.target.name}.${cleaveExtra.spatial.reply ? ` ${cleaveExtra.spatial.reply}` : ''}`);
    const cleaveResult = resolveExtraWeaponAttackRoll({
      attack: cleaveExtra.attack,
      target: cleaveExtra.target,
      combat,
      worldState: { ...attackState, combat_state: combat },
      characterSheet,
      message,
      rollDie,
      attackLabel: 'Cleave attack',
      resultLabel: 'Cleave attack',
      includeDamageRiders: false,
      applyMastery: false,
      sneakAttackAvailable: false,
      savageAttackerAvailable: false,
      actionResource: 'action',
    });
    combat = cleaveResult.combat;
    attackState = cleaveResult.worldState;
    lines.push(...cleaveResult.lines);
    consumeEffectIds.push(...cleaveResult.consumeEffectIds);
  } else if (cleaveExtra) {
    lines.push(`**Cleave mastery:** ${cleaveExtra.reply}`);
  }

  if (lightExtra && getLivingEnemy(combat)) {
    const lightActionResource = lightExtra.usesBonusAction ? 'bonus_action' : 'action';
    const lightAttack = applyFightingStyleToAttack({
      attack: lightExtra.attack,
      characterSheet,
      message,
    });
    const lightTarget = getLivingEnemy(combat);
    const lightPlayer = combat.combatants.find((combatant) => combatant.is_player);
    const lightPrepared = prepareWeaponAttack({
      attack: lightAttack,
      message,
      characterSheet,
      player: lightPlayer,
      target: lightTarget,
    });
    const lightAmmunition = lightPrepared.ok
      ? checkAmmunitionAttack({
          attack: lightPrepared.attack,
          worldState: { ...attackState, combat_state: combat },
          characterSheet,
          actionResource: lightActionResource,
        })
      : lightPrepared;
    if (!lightAmmunition.ok) {
      lines.push(`**Light property:** ${lightAmmunition.reply}`);
    } else {
      const extraSpent = lightExtra.usesBonusAction
        ? spendTurnResource({ ...attackState, combat_state: combat }, 'bonus_action', 'Light weapon extra attack', characterSheet)
        : { ok: true, worldState: { ...attackState, combat_state: combat } };
      if (!extraSpent.ok) {
        lines.push(extraSpent.reply);
      } else {
        combat = cloneCombatState(extraSpent.worldState.combat_state);
        const extraTarget = getLivingEnemy(combat);
        lines.push(lightExtra.usesBonusAction
          ? '**Light property:** you spend your Bonus Action to make one extra attack with a different Light weapon.'
          : '**Nick mastery:** your Light-property extra attack folds into the Attack action, leaving your Bonus Action available.');
        const extraResult = resolveExtraWeaponAttackRoll({
          attack: lightPrepared.attack,
          target: extraTarget,
          combat,
          worldState: extraSpent.worldState,
          characterSheet,
          message,
          rollDie,
          sneakAttackAvailable: !sneakAttackUsed,
          savageAttackerAvailable: !savageAttackerUsed,
          actionResource: lightActionResource,
        });
        combat = extraResult.combat;
        attackState = extraResult.worldState;
        lines.push(...extraResult.lines);
        consumeEffectIds.push(...extraResult.consumeEffectIds);
      }
    }
  }

  if (!getLivingEnemy(combat)) {
    let nextState = {
      ...attackState,
      combat_state: null,
      pending_roll: null,
    };
    if (consumeEffectIds.length) {
      nextState = consumeActiveEffects(nextState, consumeEffectIds, characterSheet);
    }
    return {
      handled: true,
      logType: 'referee_combat_attack',
      worldState: nextState,
      reply: `${lines.join('\n\n')}\n\n**Combat ends.**`,
    };
  }

  let nextState = {
    ...attackState,
    combat_state: combat,
  };
  if (consumeEffectIds.length) {
    nextState = consumeActiveEffects(nextState, consumeEffectIds, characterSheet);
  }
  const continued = continuePlayerTurn(nextState, lines.join('\n\n'), characterSheet);
  return {
    handled: true,
    logType: 'referee_combat_attack',
    worldState: continued.worldState,
    reply: continued.reply,
  };
}

function resolveExtraWeaponAttackRoll({
  attack,
  target,
  combat,
  worldState,
  characterSheet,
  message,
  rollDie,
  sneakAttackAvailable = true,
  savageAttackerAvailable = true,
  includeDamageRiders = true,
  applyMastery = true,
  attackLabel = 'extra attack',
  resultLabel = 'Extra attack',
  actionResource = 'action',
}) {
  if (!target) return { lines: [], consumeEffectIds: [], combat, worldState };

  let player = combat.combatants.find((combatant) => combatant.is_player);
  const preparedAttack = prepareWeaponAttack({
    attack,
    message,
    characterSheet,
    player,
    target,
  });
  if (!preparedAttack.ok) {
    return {
      lines: [`**${resultLabel}:** ${preparedAttack.reply}`],
      consumeEffectIds: [],
      combat,
      worldState,
    };
  }
  const ammunitionSpent = spendAmmunitionForAttack({
    attack: preparedAttack.attack,
    worldState: { ...worldState, combat_state: combat },
    characterSheet,
    actionResource,
  });
  if (!ammunitionSpent.ok) {
    return {
      lines: [`**${resultLabel}:** ${ammunitionSpent.reply}`],
      consumeEffectIds: [],
      combat,
      worldState,
    };
  }
  attack = preparedAttack.attack;
  worldState = ammunitionSpent.worldState;
  combat = cloneCombatState(worldState.combat_state);
  player = combat.combatants.find((combatant) => combatant.is_player);
  target = findCombatTarget(combat, target.name) || target;
  const propertyMode = getWeaponPropertyAttackMode({ attack, characterSheet, player, target, combat });
  let sources = [
    ...getAttackAdvantageSources(player, target),
    ...getWeaponPropertyAttackSources({ attack, characterSheet, player, target, combat }),
  ];
  const helped = applyHelpToAttack({
    worldState,
    combat,
    attacker: player,
    target,
    advantageMode: combineAdvantageModes(getAttackAdvantageMode(player, target), propertyMode),
    sources,
  });
  worldState = helped.worldState;
  combat = helped.combat;
  player = helped.attacker;
  target = helped.target;
  sources = helped.sources;
  const advantageMode = helped.advantageMode;
  const attackRoll = resolveD20Test({
    kind: 'attack',
    modifier: attack.attackBonus,
    dc: Number(target.ac || 10),
    advantageMode,
    bonusDice: getActiveBonusDice(worldState, 'attack'),
    rerollRules: getAutoD20RerollRules(characterSheet),
    rollDie,
  });
  const natural = attackRoll.natural;
  const isCrit = natural === 20;
  const criticalMiss = natural === 1;
  const hit = !criticalMiss && (isCrit || attackRoll.total >= Number(target.ac || 10));
  const lines = [
    `You make the ${attackLabel} against ${target.name} with ${attack.name}. Attack roll: ${attackRoll.rollText} vs AC ${target.ac}.`,
    ...ammunitionSpent.lines,
  ];
  if (advantageMode) lines.push(`${resultLabel} has ${advantageMode} from ${formatList(sources)}.`);
  const reveal = clearPlayerHidden({ worldState, reason: 'attack' });
  if (reveal.revealed) {
    worldState = reveal.worldState;
    combat = cloneCombatState(reveal.combat);
    player = combat.combatants.find((combatant) => combatant.is_player);
    target = findCombatTarget(combat, target.name) || target;
    lines.push(reveal.line);
  }

  const consumeEffectIds = [...attackRoll.bonusDice.expireEffectIds];
  Object.assign(target, consumeVexAdvantage(target));
  if (hit) {
    const damage = rollWeaponDamage({
      formula: attack.damageFormula,
      characterSheet,
      rollDie,
      crit: isCrit,
      attack: { ...attack, allowSavageAttacker: savageAttackerAvailable },
    });
    const bonusDamage = includeDamageRiders ? rollBonusDice(getActiveDamageDice(worldState, target), rollDie) : { total: 0, summary: '', expireEffectIds: [] };
    const flatBonuses = includeDamageRiders ? getActiveDamageBonuses(worldState, { attack, characterSheet }) : [];
    const fightingStyleBonus = includeDamageRiders ? getFightingStyleDamageBonus({ characterSheet, attack, message }) : { total: 0, label: null };
    const flatBonusTotal = flatBonuses.reduce((sum, bonus) => sum + Number(bonus.value || 0), 0) + fightingStyleBonus.total;
    const sneakAttack = includeDamageRiders && sneakAttackAvailable
      ? getSneakAttackDamage({ characterSheet, attack, advantageMode, rollDie, crit: isCrit })
      : { total: 0, die: '1d6' };
    const totalDamage = damage.total + bonusDamage.total + flatBonusTotal + sneakAttack.total;
    const before = Number(target.hp || 0);
    target.hp = Math.max(0, before - totalDamage);
    const damageParts = [
      `${damage.total} weapon`,
      bonusDamage.total ? bonusDamage.summary : '',
      flatBonuses.length ? flatBonuses.map((bonus) => `${bonus.label} ${formatSigned(bonus.value)}`).join(' + ') : '',
      fightingStyleBonus.total ? `${fightingStyleBonus.label} ${formatSigned(fightingStyleBonus.total)}` : '',
      sneakAttack.total ? `Sneak Attack ${sneakAttack.die}=${sneakAttack.total}` : '',
    ].filter(Boolean);
    lines.push(`${isCrit ? '**Critical hit.** ' : ''}${resultLabel} hits for ${totalDamage} damage${damageParts.length > 1 ? ` (${damageParts.join(' + ')})` : ''}. ${target.name}: (${before} -> ${target.hp} HP).`);
    if (damage.note) lines.push(damage.note);
    consumeEffectIds.push(...bonusDamage.expireEffectIds);
    if ((target.conditions || []).includes('sleep')) {
      target.conditions = (target.conditions || []).filter((condition) => condition !== 'sleep' && condition !== 'unconscious');
      consumeEffectIds.push('sleep');
      if (Number(target.hp) > 0) lines.push(`${target.name} wakes as the damage lands. Apparently paired weapons are not a soothing bedtime routine.`);
    }
    if (applyMastery) lines.push(...applyWeaponMasteryOnHit({ attack, target, combat, characterSheet, damageDealt: totalDamage, rollDie }).lines);
    if (includeDamageRiders) {
      const ancestry = applyGiantAncestryOnHit({
        message,
        target,
        combat,
        worldState,
        characterSheet,
        damageDealt: totalDamage,
        crit: isCrit,
        rollDie,
      });
      combat = ancestry.combat;
      worldState = ancestry.worldState;
      target = findCombatTarget(combat, target.name) || target;
      lines.push(...ancestry.lines);
    }
  } else if (criticalMiss) {
    lines.push(`**Critical miss.** The ${attackLabel} fails no matter how enthusiastically it joined the meeting.`);
    if (applyMastery) lines.push(...applyWeaponMasteryOnMiss({ attack, target, characterSheet }).lines);
  } else {
    lines.push(`The ${attackLabel} misses.`);
    if (applyMastery) lines.push(...applyWeaponMasteryOnMiss({ attack, target, characterSheet }).lines);
  }
  if ((target.conditions || []).includes('guiding_bolt_advantage')) {
    target.conditions = (target.conditions || []).filter((condition) => condition !== 'guiding_bolt_advantage');
  }
  if (Number(target.hp) <= 0) lines.push(`${target.name} falls.`);

  return { lines, consumeEffectIds, combat, worldState };
}

function getLivingEnemy(combat = {}) {
  return (combat.combatants || []).find((combatant) => !combatant.is_player && Number(combatant.hp) > 0) || null;
}

function getCombatManeuverIntent(message = '') {
  const text = String(message || '');
  if (/\b(?:grapple|grab|seize|wrestle|hold down|pin)\b/i.test(text)) {
    return { type: 'grapple' };
  }
  if (/\b(?:shove|push|knock (?:it|him|her|them|the [a-z' -]+)?\s*(?:down|prone)|trip|shoulder check)\b/i.test(text)) {
    const prone = /\b(?:prone|trip|knock .*(?:down|over)|floor|ground)\b/i.test(text);
    return { type: 'shove', mode: prone ? 'prone' : 'push' };
  }
  return null;
}

function resolveCombatManeuver({ maneuver, message, worldState, characterSheet, rollDie }) {
  const label = maneuver.type === 'grapple' ? 'Grapple' : 'Shove';
  if (maneuver.type === 'grapple' && !hasFreeHandForGrapple(characterSheet)) {
    return {
      handled: true,
      logType: 'referee_combat_grapple_blocked',
      worldState,
      reply: 'Grapple needs a free hand. Stow or drop something first, then the hands can begin their legal argument.',
    };
  }

  const spent = spendTurnResource(worldState, 'action', label, characterSheet);
  if (!spent.ok) {
    return { handled: true, logType: 'referee_action_unavailable', worldState: spent.worldState, reply: spent.reply };
  }

  const combat = cloneCombatState(spent.worldState.combat_state);
  const player = combat.combatants.find((combatant) => combatant.is_player);
  const target = findCombatTarget(combat, message) || combat.combatants.find((combatant) => !combatant.is_player && Number(combatant.hp) > 0);
  if (!player || !target) {
    return endCombat(worldState, 'There is no active enemy left for that maneuver. Combat ends before anyone has to explain the footwork.');
  }

  const dc = getUnarmedStrikeSaveDc(characterSheet);
  const saveChoice = chooseBestSave(target, ['str', 'dex']);
  const save = resolveSavingThrow({ target, ability: saveChoice.ability, dc, rollDie, bonus: saveChoice.bonus });
  const lines = [
    `You use the **${label}** option of the Attack action against ${target.name}. ${target.name} makes a ${saveChoice.ability.toUpperCase()} save: ${save.automaticFailure ? save.text : `${save.text} vs DC ${dc}`}.`,
  ];

  if (save.success) {
    lines.push(`${target.name} resists the ${label.toLowerCase()}.`);
  } else if (maneuver.type === 'grapple') {
    target.conditions = addCondition(target.conditions, 'grappled');
    target.grapple_escape_dc = dc;
    lines.push(`${target.name} is **grappled**. Escape DC ${dc}.`);
  } else if (maneuver.mode === 'prone') {
    target.conditions = addCondition(target.conditions, 'prone');
    lines.push(`${target.name} is knocked **prone**.`);
  } else {
    lines.push(`${target.name} is shoved 5 feet, assuming there is room in the scene for that movement.`);
  }

  const continued = continuePlayerTurn({
    ...spent.worldState,
    combat_state: combat,
  }, lines.join('\n\n'), characterSheet);
  return { handled: true, logType: `referee_combat_${maneuver.type}`, ...continued };
}

function hasFreeHandForGrapple(characterSheet = {}) {
  const equipped = characterSheet.equipped || {};
  return !(equipped.main_hand && equipped.off_hand);
}

function getUnarmedStrikeSaveDc(characterSheet = {}) {
  const strMod = Number(characterSheet.abilities?.modifiers?.str || 0);
  const pb = Number(characterSheet.derived_stats?.proficiency_bonus || proficiencyBonus(characterSheet.identity?.level || characterSheet.derived_stats?.level || 1));
  return 8 + strMod + pb;
}

function chooseBestSave(target = {}, abilities = []) {
  return abilities
    .map((ability) => ({ ability, bonus: getCreatureSaveBonus(target, ability) }))
    .sort((left, right) => right.bonus - left.bonus)[0] || { ability: 'str', bonus: 0 };
}

function getCreatureSaveBonus(target = {}, ability) {
  return Number(
    target.saves?.[ability]
      ?? target.save_modifiers?.[ability]
      ?? target.ability_modifiers?.[ability]
      ?? 0,
  );
}

function addCondition(conditions = [], condition) {
  return [...new Set([...(conditions || []), condition].filter(Boolean))];
}

function findCombatTarget(combat = {}, message = '') {
  const enemies = (combat.combatants || []).filter((combatant) => !combatant.is_player && Number(combatant.hp) > 0);
  if (!enemies.length) return null;

  const normalizedMessage = normalizeTargetPhrase(message);
  const directMatch = enemies.map((enemy) => {
    const enemyName = normalizeTargetPhrase(enemy.name);
    return { enemy, index: enemyName ? normalizedMessage.indexOf(enemyName) : -1 };
  })
    .filter((match) => match.index >= 0)
    .sort((left, right) => left.index - right.index)[0]?.enemy;
  if (directMatch) return directMatch;

  const inferred = normalizeTargetPhrase(inferEnemyName({ scene_presence: { present_npcs: [] } }, message));
  if (!inferred || inferred === 'opponent') return null;
  return enemies.find((enemy) => {
    const enemyName = normalizeTargetPhrase(enemy.name);
    return enemyName === inferred || enemyName.endsWith(` ${inferred}`) || inferred.endsWith(` ${enemyName}`);
  }) || null;
}

function advanceEnemyTurns({ worldState, characterSheet, rollDie = defaultRollDie, playerTurnNote, playerDodging = null, advanceRound = true }) {
  const defenderDodging = playerDodging ?? Boolean(worldState.combat_state?.turn_resources?.dodging);
  const playerTurnEnded = {
    ...worldState,
    combat_state: expireGiantAncestryEffects(expireMasteryEffects(worldState.combat_state, {
      timing: 'end_of_player_turn',
      round: worldState.combat_state?.round,
    }), {
      timing: 'end_of_player_turn',
      round: worldState.combat_state?.round,
    }),
  };
  const creatureTurns = resolveCreatureTurns({
    worldState: playerTurnEnded,
    characterSheet,
    rollDie,
    playerDodging: defenderDodging,
    advanceRound,
  });
  return finishCreatureTurns({
    creatureTurns,
    worldState: playerTurnEnded,
    characterSheet,
    playerTurnNote,
  });
}

function resolvePendingReaction({ message, worldState, characterSheet, rollDie = defaultRollDie }) {
  const reaction = resolvePendingReactionChoice({ message, worldState, characterSheet, rollDie });
  if (!reaction?.resolved) return reaction;

  if (reaction.pendingReaction?.resume?.type === 'combat_movement') {
    const movement = resumeCombatMovement({
      worldState: reaction.worldState,
      characterSheet,
      rollDie,
      pendingReaction: reaction.pendingReaction,
      reactionNote: reaction.reply,
    });
    if (!movement) return failedReactionResume({ worldState });
    return {
      ...finishCombatMovementAction({ result: movement, characterSheet }),
      handled: true,
      logType: reaction.logType,
    };
  }

  const creatureTurns = resumeCreatureTurns({
    worldState: reaction.worldState,
    characterSheet,
    rollDie,
    pendingReaction: reaction.pendingReaction,
  });
  if (!creatureTurns) return failedReactionResume({ worldState });

  const resumed = finishCreatureTurns({
    creatureTurns,
    worldState: reaction.worldState,
    characterSheet,
    playerTurnNote: reaction.reply,
  });
  return {
    handled: true,
    logType: reaction.logType,
    ...resumed,
  };
}

function failedReactionResume({ worldState }) {
  return {
    handled: true,
    logType: 'referee_reaction_resume_failed',
    worldState,
    reply: 'The Reaction window could not resume its interrupted action. The referee stopped combat state here instead of guessing.',
  };
}

function finishCreatureTurns({ creatureTurns, worldState, characterSheet, playerTurnNote }) {
  const player = creatureTurns.player;
  const lines = [playerTurnNote, ...creatureTurns.lines].filter(Boolean);
  if (creatureTurns.paused) {
    const pausedState = syncCreatureTurnState({
      worldState: creatureTurns.worldState || worldState,
      combat: creatureTurns.combat,
      player,
      pendingReaction: creatureTurns.pendingReaction,
    });
    return {
      worldState: pausedState,
      reply: [...lines, formatPendingReactionPrompt(creatureTurns.pendingReaction)].join('\n\n'),
    };
  }

  const combat = expireGiantAncestryEffects(expireMasteryEffects(creatureTurns.combat, {
    timing: 'start_of_player_turn',
    round: creatureTurns.combat.round,
  }), {
    timing: 'start_of_player_turn',
    round: creatureTurns.combat.round,
  });

  let nextState = {
    ...(creatureTurns.worldState || worldState),
    pending_roll: null,
    pending_reaction: null,
    combat_state: combat,
    player_stats: {
      ...((creatureTurns.worldState || worldState).player_stats || {}),
      hp: player.hp,
      max_hp: player.max_hp,
      temp_hp: player.temp_hp,
      armor_class: player.ac,
      defense_fighting_style_applied: player.defense_fighting_style_applied,
    },
    time_state: {
      ...(worldState.time_state || {}),
      elapsed_rounds: Number(worldState.time_state?.elapsed_rounds || 0) + creatureTurns.roundsElapsed,
      scene_time: `round ${combat.round}`,
    },
  };
  const ticked = tickActiveEffects(nextState, { rounds: creatureTurns.roundsElapsed });
  nextState = applyStartOfTurnEffects(beginPlayerTurn(ticked.worldState, characterSheet), characterSheet);

  if (player.hp <= 0) {
    const ended = endConcentration(nextState, characterSheet);
    nextState = ended.worldState;
    if (ended.endedEffects.length > 0) {
      lines.push(`Concentration ends: ${ended.endedEffects.map((effect) => effect.name || effect.id).join(', ')}.`);
    }
  } else {
    const concentrationPrompt = buildConcentrationPrompt({
      worldState: nextState,
      characterSheet,
      damageEvents: creatureTurns.damageEvents,
    });
    if (concentrationPrompt) {
      nextState = {
        ...nextState,
        pending_roll: concentrationPrompt.pendingRoll,
      };
      lines.push(concentrationPrompt.reply);
    }
  }

  const combatEnded = !hasLivingEnemies(combat);
  if (combatEnded) {
    nextState = {
      ...nextState,
      combat_state: null,
    };
    lines.push('All active enemies are down. **Combat ends.**');
  }

  const endLine = player.hp <= 0
    ? '**You drop to 0 HP.** Death saves are now the next thing on the table.'
    : nextState.pending_roll?.kind === 'concentration_save'
      ? '**Resolve the concentration save before taking your turn.**'
      : combatEnded
        ? ''
        : `**Round ${combat.round} begins. It is your turn.**`;
  if (ticked.expiredEffects.length > 0) {
    lines.push(`Expired effects: ${ticked.expiredEffects.map((effect) => effect.name || effect.id).join(', ')}.`);
  }

  return {
    worldState: nextState,
    reply: [lines.join('\n\n'), endLine].filter(Boolean).join('\n\n'),
  };
}

function syncCreatureTurnState({ worldState, combat, player, pendingReaction = null }) {
  return {
    ...worldState,
    pending_roll: null,
    pending_reaction: pendingReaction,
    combat_state: combat,
    player_stats: {
      ...(worldState.player_stats || {}),
      hp: player.hp,
      max_hp: player.max_hp,
      temp_hp: player.temp_hp,
      armor_class: player.ac,
      defense_fighting_style_applied: player.defense_fighting_style_applied,
    },
  };
}

function finishSpeciesFeatureAction({ result, characterSheet }) {
  if (!result?.worldState?.combat_state?.active) return result;
  const hasLivingEnemy = (result.worldState.combat_state.combatants || [])
    .some((combatant) => !combatant.is_player && Number(combatant.hp || 0) > 0);
  if (!hasLivingEnemy) {
    return {
      ...result,
      worldState: {
        ...result.worldState,
        combat_state: null,
      },
      reply: `${result.reply}\n\nThe last enemy falls. **Combat ends.**`,
    };
  }
  return finishPlayerCombatAction({ result, characterSheet });
}

function finishPlayerCombatAction({ result, characterSheet = {} }) {
  if (!result?.worldState?.combat_state?.active || result.worldState.pending_roll) return result;
  const continued = continuePlayerTurn(result.worldState, result.reply, characterSheet);
  return {
    ...result,
    worldState: continued.worldState,
    reply: continued.reply,
  };
}

function buildConcentrationPrompt({ worldState, characterSheet = {}, damageEvents = [] }) {
  const concentrationEffects = getConcentrationEffects(worldState);
  const playerDamage = damageEvents.filter((event) => event.target === 'player' && Number(event.amount || 0) > 0);
  if (concentrationEffects.length === 0 || playerDamage.length === 0) return null;

  const modifier = getSavingThrowModifier(characterSheet, 'con');
  const bonus = getActiveBonusDice(worldState, 'save')[0] || null;
  const highestDamage = Math.max(...playerDamage.map((event) => Number(event.amount || 0)));
  const dc = Math.max(10, Math.floor(highestDamage / 2));
  const source = playerDamage.map((event) => event.source).filter(Boolean).join(', ') || 'damage';
  const effectNames = concentrationEffects.map((effect) => effect.name || effect.id);
  const conditionSubject = getPlayerConditionSubject(characterSheet, worldState);
  const conditionMode = getD20ConditionMode({
    subject: conditionSubject,
    testType: 'concentration_save',
    ability: 'con',
  });
  const conditionSources = getD20ConditionSources({
    subject: conditionSubject,
    testType: 'concentration_save',
    ability: 'con',
  });
  const activeAdvantageSources = getActiveD20AdvantageSources(worldState, {
    testType: 'concentration_save',
    ability: 'con',
  });
  const advantageMode = combineAdvantageModes(conditionMode, activeAdvantageSources.length ? 'advantage' : null);
  const advantageSources = [...conditionSources, ...activeAdvantageSources];
  const pendingRoll = {
    id: `roll_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'concentration_save',
    ability: 'con',
    label: 'Constitution Saving Throw (Concentration)',
    formula: `1d20${formatSigned(modifier.total)}`,
    modifier: modifier.total,
    modifier_breakdown: modifier.breakdown,
    bonus_die: bonus?.die || null,
    bonus_source: bonus?.label || null,
    bonus_effect_ids: bonus?.expiresOnUse ? [bonus.effectId] : [],
    reroll_rules: getAutoD20RerollRules(characterSheet),
    advantage_mode: advantageMode,
    advantage_sources: advantageSources,
    dc,
    dc_source: `Concentration save after damage from ${source}; DC is max(10, half damage)`,
    effect_ids: concentrationEffects.map((effect) => effect.id),
    effect_names: effectNames,
    consumes: 'forced_save',
    combat: true,
  };
  return {
    pendingRoll,
    reply: `Concentration is at risk from ${source}. Make a DC ${dc} Constitution Saving Throw to maintain ${formatList(effectNames)}.${formatAdvantageModeText(advantageMode, advantageSources)}${bonus ? ` Add ${bonus.die} from ${bonus.label}.` : ''} ${rollTagForPending(pendingRoll)}`,
  };
}

function endConcentration(worldState, characterSheet) {
  const activeEffects = Array.isArray(worldState.active_effects) ? worldState.active_effects : [];
  const endedEffects = activeEffects.filter((effect) => effect.concentration);
  if (endedEffects.length === 0) return { worldState, endedEffects };

  const retainedEffects = activeEffects.filter((effect) => !effect.concentration);
  return {
    endedEffects,
    worldState: applyActiveEffectsToWorldState(worldState, retainedEffects, characterSheet),
  };
}

function getConcentrationEffects(worldState = {}) {
  return (Array.isArray(worldState.active_effects) ? worldState.active_effects : [])
    .filter((effect) => effect.concentration);
}

function rollTagForPending(pending = {}) {
  const idPart = pending.id ? `id=${pending.id} ` : '';
  if (pending.kind === 'initiative' || pending.kind === 'death_save') {
    return `[ROLL: ${idPart}${pending.formula || '1d20'}]`;
  }
  if (pending.kind === 'saving_throw' || pending.kind === 'concentration_save') {
    return `[SAVE: ${idPart}ability=${pending.ability || 'con'} modifier=${Number(pending.modifier || 0)}${pending.modifier_breakdown ? ` breakdown="${sanitizeTagValue(pending.modifier_breakdown)}"` : ''}${pending.bonus_die ? ` bonus_die=${pending.bonus_die} bonus_source="${sanitizeTagValue(pending.bonus_source || 'bonus')}"` : ''}]`;
  }
  if (pending.kind === 'skill_check' || pending.kind === 'ability_check') {
    return `[CHECK: ${idPart}${pending.skill ? `skill=${pending.skill} ` : ''}ability=${pending.ability} modifier=${Number(pending.modifier || 0)}${pending.modifier_breakdown ? ` breakdown="${sanitizeTagValue(pending.modifier_breakdown)}"` : ''}${pending.bonus_die ? ` bonus_die=${pending.bonus_die} bonus_source="${sanitizeTagValue(pending.bonus_source || 'bonus')}"` : ''}]`;
  }
  return '';
}

function formatList(items = []) {
  const list = (items || []).filter(Boolean);
  if (list.length === 0) return 'the active effect';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function endCombat(worldState, reply) {
  return {
    handled: true,
    logType: 'referee_combat_end',
    worldState: {
      ...worldState,
      combat_state: null,
      pending_roll: null,
    },
    reply,
  };
}

function cloneCombatState(combatState) {
  return JSON.parse(JSON.stringify(combatState || { active: true, round: 1, turn_index: 0, combatants: [] }));
}

function getCheckModifier(characterSheet, check) {
  const skillData = check.skill ? characterSheet?.derived_stats?.skill_modifiers?.[check.skill] : null;
  if (skillData) {
    return {
      total: Number(skillData.total || 0),
      breakdown: `${String(skillData.ability || check.ability).toUpperCase()} ${skillData.proficient ? '+ proficiency' : 'only'} = ${formatSigned(skillData.total)}`,
    };
  }

  const abilityMod = Number(characterSheet?.abilities?.modifiers?.[check.ability] || 0);
  return {
    total: abilityMod,
    breakdown: `${check.ability.toUpperCase()} modifier ${formatSigned(abilityMod)}`,
  };
}

function getSavingThrowModifier(characterSheet, ability) {
  const saveData = characterSheet?.derived_stats?.saving_throw_modifiers?.[ability];
  if (saveData) {
    return {
      total: Number(saveData.total || 0),
      breakdown: `${ability.toUpperCase()} ${saveData.proficient ? '+ proficiency' : 'only'} = ${formatSigned(saveData.total)}`,
    };
  }

  const abilityMod = Number(characterSheet?.abilities?.modifiers?.[ability] || 0);
  return {
    total: abilityMod,
    breakdown: `${ability.toUpperCase()} modifier ${formatSigned(abilityMod)}`,
  };
}

function chooseDc(_text, check, worldState, inCombat) {
  const sceneText = JSON.stringify({
    location_type: worldState?.scene_presence?.location_type,
    present_npcs: worldState?.scene_presence?.present_npcs,
    present_objects: worldState?.scene_presence?.present_objects,
    npc_states: worldState?.npc_states,
    current_location: worldState?.current_location,
  }).toLowerCase();
  let dc = DEFAULT_CHECK_DC;
  if (/\b(?:alert|hostile|hidden|careful|guarded|suspicious|locked|obscured)\b/.test(sceneText)) dc += 5;
  if (inCombat && ['stealth', 'sleight_of_hand', 'persuasion', 'deception', 'intimidation'].includes(check.skill)) dc += 2;
  return Math.max(5, Math.min(30, dc));
}

function buildDcSource(dc, _text, inCombat, options = {}) {
  if (options.hideAction) return 'Hide action fixed DC 15';
  const parts = [`base adventuring DC ${DEFAULT_CHECK_DC}`];
  if (dc > DEFAULT_CHECK_DC) parts.push('increased for scene pressure, opposition, or difficult circumstances');
  if (inCombat) parts.push('combat pressure applies');
  return parts.join('; ');
}

function successTextFor(check) {
  const map = {
    insight: 'You read the situation correctly and gain the useful tell the scene can fairly give you.',
    stealth: 'You become hidden or pass unnoticed in a way that fits the available cover.',
    sleight_of_hand: 'Your fingers do the quiet work without drawing immediate attention.',
    survival: 'You follow the signs and keep the trail from becoming decorative mud trivia.',
    investigation: 'You piece together the clue or mechanism with enough clarity to act on it.',
    perception: 'You notice the important visible or audible detail before it becomes a problem with teeth.',
    persuasion: 'Your words land. The target becomes more cooperative, within reason.',
    deception: 'Your lie holds together well enough to pass the moment.',
    intimidation: 'Your pressure works. The target yields, hesitates, or gives ground.',
    performance: 'Your performance draws the intended attention and shifts the room.',
  };
  return map[check.skill] || 'You succeed at the attempted check.';
}

function failureTextFor(check) {
  const map = {
    insight: 'You cannot get a reliable read. If there is a hidden motive here, it keeps its hat pulled low.',
    stealth: 'You fail to disappear. Anyone watching still has a fair chance to track you.',
    sleight_of_hand: 'The attempt fails before you can secure the object cleanly.',
    survival: 'The trail does not resolve into anything reliable yet.',
    investigation: 'The clue or mechanism refuses to make sense under the current approach.',
    perception: 'You do not notice anything beyond the obvious scene details.',
    persuasion: 'Your words do not move the target the way you hoped.',
    deception: 'The falsehood does not hold cleanly.',
    intimidation: 'The pressure fails to produce the result you wanted.',
    performance: 'The performance does not shift the room in your favor.',
  };
  return map[check.skill] || 'The attempted check fails.';
}

function updatePlayerHp({ worldState, hp, deathSaves }) {
  const combat = worldState.combat_state
    ? {
        ...worldState.combat_state,
        combatants: (worldState.combat_state.combatants || []).map((combatant) => (
          combatant.is_player ? { ...combatant, hp } : combatant
        )),
      }
    : worldState.combat_state;

  return {
    ...worldState,
    combat_state: combat,
    player_stats: {
      ...(worldState.player_stats || {}),
      hp,
      death_saves: deathSaves,
    },
  };
}

function buildPlayerCombatant(characterSheet, worldState) {
  const identity = characterSheet?.identity || {};
  const derived = characterSheet?.derived_stats || {};
  const stats = worldState.player_stats || {};
  const hp = Number(stats.hp ?? derived.hp ?? derived.max_hp ?? 10);
  const armor = getRuntimeArmorClass({
    characterSheet,
    armorClass: stats.armor_class ?? derived.armor_class ?? 10,
    defenseApplied: Boolean(stats.defense_fighting_style_applied),
  });
  return {
    character_id: stats.character_id || derived.character_id || null,
    name: identity.name || stats.name || 'You',
    initiative: Number(derived.initiative || 0),
    hp,
    max_hp: Number(stats.max_hp ?? derived.max_hp ?? hp),
    temp_hp: Number(stats.temp_hp ?? derived.temp_hp ?? 0),
    ac: armor.armorClass,
    defense_fighting_style_applied: armor.defenseApplied,
    conditions: derived.conditions || stats.conditions || [],
    is_player: true,
  };
}

function buildDefaultEnemy(name = 'Opponent') {
  return {
    name,
    initiative: 0,
    initiative_bonus: 1,
    initiative_group: name,
    hp: 8,
    max_hp: 8,
    ac: 12,
    conditions: [],
    is_player: false,
    attack: {
      name: 'weapon attack',
      attack_bonus: 3,
      damage_formula: '1d6+1',
    },
  };
}

function inferEnemyName(worldState = {}, message = '') {
  const sceneNpcs = worldState.scene_presence?.present_npcs || [];
  const cleanedTarget = extractCombatStartTarget(message);
  if (cleanedTarget) return titleCase(cleanedTarget);
  const explicitHostile = extractHostileTarget(message);
  if (explicitHostile) return titleCase(explicitHostile);
  const likelyNpc = sceneNpcs.find((name) => /\b(stranger|figure|enemy|guard|creature|bandit|cultist|goblin|orc|thug)\b/i.test(String(name)))
    || sceneNpcs.find(Boolean);
  return likelyNpc ? String(likelyNpc) : 'Opponent';
}

function extractCombatStartTarget(message = '') {
  const targetMatch = String(message || '').match(/\b(?:attack|hit|strike|stab|swing at|shoot|charge|punch|kick|headbutt|elbow|shove|push|grapple|grab|seize|trip)\s+(?:the\s+|a\s+|an\s+)?([a-z][a-z' -]{2,50}?)(?:\s+(?:and|with|using|because|if|when|while|as|from|near|beside|behind|emerging|coming|rushing|charging|away|toward|towards|not)\b|[.!?]|$)/i);
  return cleanTarget(targetMatch?.[1]);
}

function cleanTarget(value) {
  return String(value || '')
    .replace(/\b(and|with|using|because|if|when|while|as|from|near|beside|behind|emerging|coming|rushing|charging|away|toward|towards|not)\b.*$/i, '')
    .replace(/\b(?:the|a|an)\b/gi, '')
    .trim();
}

function extractHostileTarget(message = '') {
  const match = String(message || '').match(/\b(?:hostile|enemy|attacking|aggressive)\s+([a-z][a-z' -]{1,35}?)(?:\s+(?:emerging|rush(?:es|ing)?|comes?|coming|moves?|moving|charges?|charging|from|near|beside|behind|toward|towards|with|while|that|who|not)\b|[,.!?]|$)/i);
  return cleanTarget(match?.[1]);
}

function proficiencyBonus(level) {
  return Math.floor((Number(level || 1) - 1) / 4) + 2;
}

function titleCase(value) {
  return String(value || '').replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeTargetPhrase(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9' -]/g, ' ')
    .replace(/\b(?:the|a|an|hostile|enemy|aggressive|attacking)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getPrimaryAttack(characterSheet, message = '') {
  const unarmed = buildUnarmedAttack({ characterSheet, message });
  if (unarmed) return unarmed;
  const attackBreakdowns = characterSheet?.derived_stats?.attack_breakdowns || [];
  const attack = attackBreakdowns.find((entry) => attackNameAppearsInMessage(entry, message))
    || attackBreakdowns[0];
  return buildAttackFromBreakdown(attack);
}

function buildAttackFromBreakdown(attack = {}) {
  const weaponId = attack?.weapon_id || attack?.weaponId || null;
  const weapon = weaponId
    ? getContentBundle().equipment.find((item) => item.id === weaponId)
    : null;
  return {
    name: attack?.name || 'weapon',
    weaponId,
    ability: attack?.ability || weapon?.ability || null,
    properties: weapon?.properties || attack?.properties || [],
    weaponCategory: weapon?.weapon_category || attack?.weapon_category || null,
    attackKind: weapon?.attack_kind || attack?.attack_kind || 'melee',
    attackBonus: Number(attack?.attack_total ?? 3),
    fightingStyleAttackBonus: Number(attack?.fighting_style_attack_bonus || 0),
    damageFormula: attack?.damage_formula || '1d8+3',
    damageType: weapon?.damage_type || attack?.damage_type || null,
    mastery: weapon?.mastery || attack?.mastery || null,
    versatileDamage: weapon?.versatile_damage || attack?.versatile_damage || null,
    ammunitionType: weapon?.ammunition_type || attack?.ammunition_type || null,
    ammunitionBundleQuantity: getContentBundle().equipment.find((item) => item.id === (weapon?.ammunition_type || attack?.ammunition_type))?.bundle_quantity || null,
    range: weapon?.range || attack?.range || null,
    isWeapon: true,
  };
}

function attackNameAppearsInMessage(attack = {}, message = '') {
  const text = normalizeTargetPhrase(message);
  return [attack.weapon_id, attack.weaponId, attack.name]
    .filter(Boolean)
    .some((value) => text.includes(normalizeTargetPhrase(value)));
}

function getSneakAttackDamage({ characterSheet = {}, attack = {}, advantageMode = null, rollDie = defaultRollDie, crit = false } = {}) {
  if (normalizeTargetPhrase(characterSheet.identity?.class) !== 'rogue') return { total: 0, die: '1d6' };
  if (advantageMode !== 'advantage') return { total: 0, die: '1d6' };
  if (!isSneakAttackWeapon(attack)) return { total: 0, die: '1d6' };

  const damage = rollDamageFormula('1d6', rollDie, { crit });
  return {
    total: damage.total,
    die: crit ? '2d6' : '1d6',
  };
}

function isSneakAttackWeapon(attack = {}) {
  const properties = attack.properties || [];
  return properties.includes('finesse') || properties.includes('ammunition') || attack.weaponCategory === 'ranged';
}

function getAttackAdvantageMode(attacker = {}, target = {}) {
  const conditionMode = getAttackMode({ attacker, target });
  const spellAdvantage = [...getSpellAttackAdvantageSources(target), ...getWeaponMasteryAdvantageSources(target)].length > 0;
  if (conditionMode === 'disadvantage' && spellAdvantage) return null;
  if (conditionMode) return conditionMode;
  return spellAdvantage ? 'advantage' : null;
}

function getAttackAdvantageSources(attacker = {}, target = {}) {
  return [
    ...getAttackModeSources({ attacker, target }),
    ...getSpellAttackAdvantageSources(target),
    ...getWeaponMasteryAdvantageSources(target),
  ];
}

function getSpellAttackAdvantageSources(target = {}) {
  const conditions = target.conditions || [];
  const sources = [];
  if (conditions.includes('faerie_fire')) sources.push('Faerie Fire');
  if (conditions.includes('guiding_bolt_advantage')) sources.push('Guiding Bolt');
  if (conditions.includes('sleep') || conditions.includes('unconscious')) sources.push('unconscious target');
  return sources;
}

function rollBonusDice(bonuses = [], rollDie) {
  const parts = [];
  const expireEffectIds = [];
  let total = 0;
  for (const bonus of bonuses || []) {
    const rolled = rollDiceExpression(bonus.die, rollDie);
    if (!rolled) continue;
    total += rolled.total;
    parts.push(`${bonus.label} ${bonus.die}=${rolled.total}`);
    if (bonus.expiresOnUse || bonus.expiresOnHit) expireEffectIds.push(bonus.effectId);
  }
  return {
    total,
    summary: parts.join(' + '),
    expireEffectIds,
  };
}

function rollDiceExpression(expression, rollDie) {
  const parsed = String(expression || '').match(/^(\d+)d(\d+)$/i);
  if (!parsed) return null;
  const diceCount = Number(parsed[1]);
  const dieSides = Number(parsed[2]);
  const rolls = Array.from({ length: diceCount }, () => rollDie(dieSides));
  return {
    total: rolls.reduce((sum, value) => sum + value, 0),
    rolls,
  };
}

function rollDamage(formula, rollDie, crit = false) {
  return rollDamageFormula(formula, rollDie, { crit });
}

function getCurrentHp(characterSheet, worldState) {
  return Number(worldState.player_stats?.hp ?? characterSheet?.derived_stats?.hp ?? characterSheet?.derived_stats?.max_hp ?? 10);
}

function getPlayerConditionSubject(characterSheet = {}, worldState = {}) {
  const stats = worldState.player_stats || {};
  const derived = characterSheet.derived_stats || {};
  const combatPlayer = (worldState.combat_state?.combatants || []).find((combatant) => combatant.is_player) || {};
  return {
    conditions: [
      ...(derived.conditions || []),
      ...(stats.conditions || []),
      ...(combatPlayer.conditions || []),
    ],
  };
}

function formatAdvantageModeText(mode = null, sources = []) {
  if (!mode) return '';
  const sourceText = sources?.length ? ` from ${formatList(sources)}` : '';
  return ` Roll with ${mode}${sourceText}.`;
}

function combineAdvantageModes(left = null, right = null) {
  if (left && right && left !== right) return null;
  return left || right || null;
}

function isMovementIntent(message) {
  return /\b(?:go|walk|head|travel|move|return|enter|leave|approach|step|run|ride|follow|continue|flee|escape|retreat|withdraw|back away)\b/i.test(message);
}

function advanceNarrativeTime({ message = '', dmReply = '', worldState = {}, characterSheet = {}, defaultElapsed = null } = {}) {
  if (worldState.combat_state?.active || worldState.pending_roll) {
    return { worldState, replySuffix: '' };
  }

  const elapsed = defaultElapsed || estimateNarrativeElapsed(message, dmReply);
  const rounds = Number(elapsed.rounds || 0);
  const minutes = Number(elapsed.minutes || 0);
  if (rounds <= 0 && minutes <= 0) {
    return { worldState, replySuffix: '' };
  }

  const ticked = tickActiveEffects(worldState, { rounds, minutes });
  const nextWorldState = {
    ...ticked.worldState,
    time_state: {
      ...(ticked.worldState.time_state || {}),
      elapsed_rounds: Number(ticked.worldState.time_state?.elapsed_rounds || 0) + rounds,
      elapsed_minutes: Number(ticked.worldState.time_state?.elapsed_minutes || 0) + minutes,
      scene_time: elapsed.label || (minutes > 0 ? `${minutes} minute${minutes === 1 ? '' : 's'} later` : 'moments later'),
    },
  };
  const expired = ticked.expiredEffects.length
    ? `\n\n**Rules clock:** ${ticked.expiredEffects.map((effect) => effect.name || effect.id).join(', ')} ${ticked.expiredEffects.length === 1 ? 'expires' : 'expire'}.`
    : '';

  return {
    worldState: nextWorldState,
    characterSheet,
    replySuffix: expired,
  };
}

function estimateNarrativeElapsed(message = '', dmReply = '') {
  const text = `${message}\n${dmReply}`.toLowerCase();
  if (/\b(?:travel|walk|head|go|return|move|ride|follow)\b.*\b(?:road|town|inn|gate|forest|woods|square|temple|shop|hall|cellar|house)\b/.test(text)) {
    return { minutes: 5, label: 'about 5 minutes later' };
  }
  if (/\b(?:search|investigate|examine|inspect|look around|check the area|look for tracks|follow tracks)\b/.test(text)) {
    return { minutes: 1, label: 'about 1 minute later' };
  }
  if (/\b(?:conversation|talk|ask|answer|reply|speak|read|study|watch|listen)\b/.test(text)) {
    return { rounds: 1, label: 'moments later' };
  }
  return { rounds: 1, label: 'moments later' };
}

function formatSigned(value) {
  const number = Number(value || 0);
  return number >= 0 ? `+${number}` : String(number);
}

function sanitizeTagValue(value) {
  return String(value || '').replaceAll('"', '').replace(/\s+/g, ' ').trim();
}

module.exports = {
  adjudicate,
  resolveRefereeAction: adjudicate,
  advanceEnemyTurns,
  advanceNarrativeTime,
  finishPlayerCombatAction,
  rollDamage,
};
