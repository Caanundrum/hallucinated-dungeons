const crypto = require('crypto');
const { resolveIntent } = require('./intentResolver');
const { getContentBundle } = require('./contentData');
const {
  tickActiveEffects,
  applyActiveEffectsToWorldState,
  applyStartOfTurnEffects,
  consumeActiveEffects,
  getActiveBonusDice,
  getActiveDamageDice,
  formatBonusDieTag,
} = require('./spellEffectEngine');
const {
  beginPlayerTurn,
  spendTurnResource,
} = require('./actionEconomy');
const { resolveCreatureTurns } = require('./creatureTurnEngine');
const {
  getAttackMode,
  getAttackModeSources,
  getTurnBlockReason,
} = require('./conditionEngine');

const DEFAULT_CHECK_DC = 15;

function adjudicate({ message, worldState = {}, characterSheet = null, currentTurn = 0, rollDie = defaultRollDie } = {}) {
  const text = String(message || '').trim();
  if (!text) return null;

  const intent = resolveIntent(text);
  const state = normalizeWorldState(worldState);
  const sheet = characterSheet || {};

  if (intent.isRollResult || parseRollRequest(text)) {
    return resolvePendingRoll({ message: text, worldState: state, characterSheet: sheet, rollDie });
  }

  if (state.pending_roll) {
    return remindPendingRoll({ worldState: state });
  }

  if (state.combat_state?.active && getCurrentHp(sheet, state) <= 0) {
    const deathStatus = getDeathSaveStatus(state);
    if (deathStatus === 'dying') return promptDeathSave({ worldState: state, currentTurn });
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

  const timeIntent = getTimePassageIntent(text);
  if (timeIntent) {
    return resolveTimePassage({ timeIntent, worldState: state });
  }

  if (!state.combat_state?.active && isCombatStarter(text)) {
    return promptInitiative({ message: text, worldState: state, characterSheet: sheet, currentTurn });
  }

  if (intent.save) {
    return promptSavingThrow({ intent, worldState: state, characterSheet: sheet, currentTurn, inCombat: Boolean(state.combat_state?.active) });
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
  const bonus = getActiveBonusDice(worldState, 'check')[0] || null;
  const dc = chooseDc(intent.raw, check, worldState, inCombat);
  const pendingRoll = {
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
    dc,
    dc_source: buildDcSource(dc, intent.raw, inCombat),
    intent: intent.raw,
    consumes: inCombat ? 'action' : 'exploration',
    combat: Boolean(inCombat),
    created_turn: currentTurn,
    success_result: successTextFor(check),
    failure_result: failureTextFor(check),
  };

  return {
    handled: true,
    logType: 'referee_pending_roll',
    worldState: {
      ...nextWorldState,
      pending_roll: pendingRoll,
    },
    reply: `Make a DC ${dc} ${check.label}.${bonus ? ` Add ${bonus.die} from ${bonus.label}.` : ''}${inCombat ? ' This uses your Action.' : ''} [CHECK: id=${pendingRoll.id}${check.skill ? ` skill=${check.skill}` : ''} ability=${check.ability} modifier=${modifier.total} breakdown="${sanitizeTagValue(modifier.breakdown)}"${formatBonusDieTag(bonus)}]`,
  };
}

function promptSavingThrow({ intent, worldState, characterSheet, currentTurn = 0, inCombat }) {
  const save = intent.save;
  const modifier = getSavingThrowModifier(characterSheet, save.ability);
  const bonus = getActiveBonusDice(worldState, 'save')[0] || null;
  const dc = chooseDc(intent.raw, save, worldState, inCombat);
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
    dc,
    dc_source: buildDcSource(dc, intent.raw, inCombat),
    intent: intent.raw,
    consumes: 'forced_save',
    combat: Boolean(inCombat),
    ends_turn: false,
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
    reply: `Make a DC ${dc} ${save.label}.${bonus ? ` Add ${bonus.die} from ${bonus.label}.` : ''} [SAVE: id=${pendingRoll.id} ability=${save.ability} modifier=${modifier.total} breakdown="${sanitizeTagValue(modifier.breakdown)}"${formatBonusDieTag(bonus)}]`,
  };
}

function promptDeathSave({ worldState, currentTurn = 0 }) {
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
    consumes: 'death_save',
    combat: true,
    ends_turn: true,
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
        reply: 'There is no pending roll to resolve. Declare an action first, then the DM will call for dice when the rules want their dramatic little entrance.',
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
    return resolveCheckRoll({ pending, result, worldState, characterSheet, rollDie });
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
  const natural = rollDie(20);
  let total = natural + Number(pending.modifier || 0);
  const parts = [`natural ${natural}`, `1d20${formatSigned(pending.modifier || 0)}=${natural + Number(pending.modifier || 0)}`];

  if (pending.bonus_die) {
    const bonus = rollDiceExpression(pending.bonus_die, rollDie);
    if (bonus) {
      total += bonus.total;
      parts.push(`${pending.bonus_source || 'bonus'} ${pending.bonus_die}=${bonus.total}`);
    }
  }

  return {
    total,
    natural,
    rollText: `${total} (${parts.join('; ')})`,
  };
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

function resolveCheckRoll({ pending, result, worldState, characterSheet, rollDie }) {
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
  if (pending.combat && pending.ends_turn !== false && worldState.combat_state?.active) {
    const combatResult = advanceEnemyTurns({
      worldState: nextState,
      characterSheet,
      rollDie,
      playerTurnNote: reply,
      playerDodging: false,
    });
    return {
      handled: true,
      logType: 'referee_roll_resolution_combat',
      worldState: combatResult.worldState,
      reply: combatResult.reply,
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
  return /\b(?:attack|hit|strike|stab|swing at|shoot|charge|draw (?:my|a|the).*(?:weapon|sword|bow)|start (?:a )?fight)\b/i.test(text);
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
    ? { worldState: completeLongRest(baseState, characterSheet), note: '' }
    : completeShortRest(baseState, characterSheet, rollDie);
  const nextState = restResult.worldState;
  const expired = ticked.expiredEffects.length
    ? ` Expired effects: ${ticked.expiredEffects.map((effect) => effect.name || effect.id).join(', ')}.`
    : '';
  const reply = restIntent.type === 'long'
    ? `You complete a **long rest**. HP, death saves, spell slots, and once-per-rest spell uses reset.${expired}`
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
  return {
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
  };
}

function completeShortRest(worldState, characterSheet = {}, rollDie = defaultRollDie) {
  const classId = characterSheet?.identity?.class;
  const nextSlots = classId === 'warlock'
    ? getMaxSpellSlots(characterSheet)
    : worldState.player_stats?.spell_slots;
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
    worldState: {
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
    },
    note,
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
  if (intent.castsSpell) return null;

  if (intent.check && shouldPromptCombatCheck(intent)) {
    return promptCheck({ intent, worldState, characterSheet, currentTurn, inCombat: true });
  }

  if (/\b(?:dodge|defend|guard myself|guarded stance)\b/i.test(message)) {
    const spent = spendTurnResource(worldState, 'action', 'Dodge', characterSheet);
    if (!spent.ok) {
      return { handled: true, logType: 'referee_action_unavailable', worldState: spent.worldState, reply: spent.reply };
    }
    const result = advanceEnemyTurns({
      worldState: spent.worldState,
      characterSheet,
      rollDie,
      playerTurnNote: 'You take the **Dodge** action, making yourself much harder to hit until your next turn.',
      playerDodging: true,
    });
    return { handled: true, logType: 'referee_combat_dodge', ...result };
  }

  if (/\b(?:disengage|carefully withdraw|withdraw safely)\b/i.test(message)) {
    const spent = spendTurnResource(worldState, 'action', 'Disengage', characterSheet);
    if (!spent.ok) {
      return { handled: true, logType: 'referee_action_unavailable', worldState: spent.worldState, reply: spent.reply };
    }
    const result = advanceEnemyTurns({
      worldState: spent.worldState,
      characterSheet,
      rollDie,
      playerTurnNote: 'You take the **Disengage** action and move without giving nearby enemies a free swing.',
      playerDodging: false,
    });
    return { handled: true, logType: 'referee_combat_disengage', ...result };
  }

  if (isCombatStarter(message) || /\battack\b/i.test(message)) {
    return resolvePlayerAttack({ worldState, characterSheet, rollDie });
  }

  if (isMovementIntent(message)) {
    return {
      handled: true,
      logType: 'referee_combat_movement_block',
      worldState,
      reply: 'Combat is still active. You can move as part of your turn, but you cannot slip into free exploration while an enemy is still trying to rearrange your skeleton. Choose an action such as **Attack**, **Dodge**, **Disengage**, **Hide**, **Search**, **Study**, or **Help**.',
    };
  }

  return {
    handled: true,
    logType: 'referee_combat_action_needed',
    worldState,
    reply: 'Combat is active and initiative is running. What action do you take this turn: **Attack**, **Dodge**, **Disengage**, **Hide**, **Search**, **Study**, **Help**, **Ready**, or a valid spell/action from your sheet?',
  };
}

function shouldPromptCombatCheck(intent) {
  return ['hide', 'search', 'study', 'influence'].includes(intent.ruleAction) || Boolean(intent.check);
}

function resolvePlayerAttack({ worldState, characterSheet, rollDie }) {
  const spent = spendTurnResource(worldState, 'action', 'Attack', characterSheet);
  if (!spent.ok) {
    return {
      handled: true,
      logType: 'referee_action_unavailable',
      worldState: spent.worldState,
      reply: spent.reply,
    };
  }

  const combat = cloneCombatState(spent.worldState.combat_state);
  const player = combat.combatants.find((combatant) => combatant.is_player);
  const target = combat.combatants.find((combatant) => !combatant.is_player && Number(combatant.hp) > 0);
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

  const attack = getPrimaryAttack(characterSheet);
  const advantageMode = getAttackAdvantageMode(player, target);
  const attackRoll = rollD20WithMode(rollDie, advantageMode);
  const natural = attackRoll.natural;
  const attackBonusDice = rollBonusDice(getActiveBonusDice(spent.worldState, 'attack'), rollDie);
  const attackTotal = natural + attack.attackBonus + attackBonusDice.total;
  const isCrit = natural === 20;
  const criticalMiss = natural === 1;
  const hit = !criticalMiss && (isCrit || attackTotal >= Number(target.ac || 10));
  const bonusText = attackBonusDice.total
    ? ` + ${attackBonusDice.summary}`
    : '';
  const lines = [
    `You attack ${target.name} with ${attack.name}. Attack roll: ${attackRoll.text}${formatSigned(attack.attackBonus)}${bonusText} = ${attackTotal} vs AC ${target.ac}.`,
  ];
  if (advantageMode) lines.push(`Attack roll has ${advantageMode} from ${formatList(getAttackAdvantageSources(player, target))}.`);

  const consumeEffectIds = [];
  if (hit) {
    const damage = rollDamage(attack.damageFormula, rollDie, isCrit);
    const bonusDamage = rollBonusDice(getActiveDamageDice(spent.worldState, target), rollDie);
    const totalDamage = damage.total + bonusDamage.total;
    const before = Number(target.hp || 0);
    target.hp = Math.max(0, before - totalDamage);
    lines.push(`${isCrit ? '**Critical hit.** ' : ''}Hit for ${totalDamage} damage${bonusDamage.total ? ` (${damage.total} weapon + ${bonusDamage.summary})` : ''}. ${target.name}: (${before} -> ${target.hp} HP).`);
    consumeEffectIds.push(...bonusDamage.expireEffectIds);
    if ((target.conditions || []).includes('sleep')) {
      target.conditions = (target.conditions || []).filter((condition) => condition !== 'sleep' && condition !== 'unconscious');
      consumeEffectIds.push('sleep');
      if (Number(target.hp) > 0) lines.push(`${target.name} wakes as the damage lands. Extremely rude alarm clock, but effective.`);
    }
  } else if (criticalMiss) {
    lines.push('**Critical miss.** The attack fails no matter how pretty the math looked in the margins.');
  } else {
    lines.push('Miss. The attack fails to connect, which is rude but rules-compliant.');
  }
  consumeEffectIds.push(...attackBonusDice.expireEffectIds);
  if ((target.conditions || []).includes('guiding_bolt_advantage')) {
    target.conditions = (target.conditions || []).filter((condition) => condition !== 'guiding_bolt_advantage');
  }

  if (Number(target.hp) <= 0) {
    let nextState = {
      ...spent.worldState,
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
      reply: `${lines.join('\n\n')}\n\n${target.name} falls. **Combat ends.**`,
    };
  }

  let nextState = {
    ...spent.worldState,
    combat_state: combat,
  };
  if (consumeEffectIds.length) {
    nextState = consumeActiveEffects(nextState, consumeEffectIds, characterSheet);
  }
  const enemyResult = advanceEnemyTurns({
    worldState: nextState,
    characterSheet,
    rollDie,
    playerTurnNote: lines.join('\n\n'),
    playerDodging: false,
  });
  return {
    handled: true,
    logType: 'referee_combat_attack',
    worldState: enemyResult.worldState,
    reply: enemyResult.reply,
  };
}

function advanceEnemyTurns({ worldState, characterSheet, rollDie = defaultRollDie, playerTurnNote, playerDodging = false, advanceRound = true }) {
  const creatureTurns = resolveCreatureTurns({
    worldState,
    characterSheet,
    rollDie,
    playerDodging,
    advanceRound,
  });
  const combat = creatureTurns.combat;
  const player = creatureTurns.player;
  const lines = [playerTurnNote, ...creatureTurns.lines].filter(Boolean);

  let nextState = {
    ...worldState,
    pending_roll: null,
    combat_state: combat,
    player_stats: {
      ...(worldState.player_stats || {}),
      hp: player.hp,
      max_hp: player.max_hp,
      temp_hp: player.temp_hp,
      armor_class: player.ac,
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

  const endLine = player.hp <= 0
    ? '**You drop to 0 HP.** Death saves are now the next thing on the table.'
    : nextState.pending_roll?.kind === 'concentration_save'
      ? '**Resolve the concentration save before taking your turn.**'
      : `**Round ${combat.round} begins. It is your turn.**`;
  if (ticked.expiredEffects.length > 0) {
    lines.push(`Expired effects: ${ticked.expiredEffects.map((effect) => effect.name || effect.id).join(', ')}.`);
  }

  return {
    worldState: nextState,
    reply: `${lines.join('\n\n')}\n\n${endLine}`,
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
  return {
    pendingRoll: {
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
      dc,
      dc_source: `Concentration save after damage from ${source}; DC is max(10, half damage)`,
      effect_ids: concentrationEffects.map((effect) => effect.id),
      effect_names: effectNames,
      consumes: 'forced_save',
      combat: true,
      ends_turn: false,
    },
    reply: `Concentration is at risk from ${source}. Make a DC ${dc} Constitution Saving Throw to maintain ${formatList(effectNames)}.${bonus ? ` Add ${bonus.die} from ${bonus.label}.` : ''} [SAVE: ability=con modifier=${modifier.total} breakdown="${sanitizeTagValue(modifier.breakdown)}"${formatBonusDieTag(bonus)}]`,
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

function buildDcSource(dc, _text, inCombat) {
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
  return {
    character_id: stats.character_id || derived.character_id || null,
    name: identity.name || stats.name || 'You',
    initiative: Number(derived.initiative || 0),
    hp,
    max_hp: Number(stats.max_hp ?? derived.max_hp ?? hp),
    temp_hp: Number(stats.temp_hp ?? derived.temp_hp ?? 0),
    ac: Number(stats.armor_class ?? derived.armor_class ?? 10),
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
  const targetMatch = String(message || '').match(/\b(?:attack|hit|strike|stab|swing at|shoot|charge)\s+(?:the\s+|a\s+|an\s+)?([a-z][a-z' -]{2,40}?)(?:\s+(?:with|using|because|if|when)\b|[.!?]|$)/i);
  if (targetMatch?.[1]) return titleCase(cleanTarget(targetMatch[1]));
  const likelyNpc = sceneNpcs.find((name) => /\b(stranger|figure|enemy|guard|creature|bandit|cultist|goblin|orc|thug)\b/i.test(String(name)))
    || sceneNpcs.find(Boolean);
  return likelyNpc ? String(likelyNpc) : 'Opponent';
}

function cleanTarget(value) {
  return String(value || '').replace(/\b(with|using|because|if|when)\b.*$/i, '').trim();
}

function titleCase(value) {
  return String(value || '').replace(/\b\w/g, (char) => char.toUpperCase());
}

function getPrimaryAttack(characterSheet) {
  const attack = characterSheet?.derived_stats?.attack_breakdowns?.[0];
  return {
    name: attack?.name || 'weapon',
    attackBonus: Number(attack?.attack_total ?? 3),
    damageFormula: attack?.damage_formula || '1d8+3',
  };
}

function getAttackAdvantageMode(attacker = {}, target = {}) {
  const conditionMode = getAttackMode({ attacker, target });
  const spellAdvantage = getSpellAttackAdvantageSources(target).length > 0;
  if (conditionMode === 'disadvantage' && spellAdvantage) return null;
  if (conditionMode) return conditionMode;
  return spellAdvantage ? 'advantage' : null;
}

function getAttackAdvantageSources(attacker = {}, target = {}) {
  return [
    ...getAttackModeSources({ attacker, target }),
    ...getSpellAttackAdvantageSources(target),
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
  const parsed = String(formula || '1d6').match(/(\d+)d(\d+)([+-]\d+)?/i);
  if (!parsed) return { total: 1, rolls: [1] };
  const diceCount = Number(parsed[1]);
  const dieSides = Number(parsed[2]);
  const modifier = parsed[3] ? Number(parsed[3]) : 0;
  const rollCount = crit ? diceCount * 2 : diceCount;
  const rolls = Array.from({ length: rollCount }, () => rollDie(dieSides));
  return {
    total: rolls.reduce((sum, roll) => sum + roll, 0) + modifier,
    rolls,
  };
}

function getCurrentHp(characterSheet, worldState) {
  return Number(worldState.player_stats?.hp ?? characterSheet?.derived_stats?.hp ?? characterSheet?.derived_stats?.max_hp ?? 10);
}

function isMovementIntent(message) {
  return /\b(?:go|walk|head|travel|move|return|enter|leave|approach|step|run|ride|follow|continue|flee|escape)\b/i.test(message);
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
  rollDamage,
};
