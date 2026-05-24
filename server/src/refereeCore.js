const crypto = require('crypto');
const { resolveIntent } = require('./intentResolver');
const { tickActiveEffects } = require('./spellEffectEngine');
const {
  beginPlayerTurn,
  spendTurnResource,
} = require('./actionEconomy');
const { resolveCreatureTurns } = require('./creatureTurnEngine');

const DEFAULT_CHECK_DC = 15;

function adjudicate({ message, worldState = {}, characterSheet = null, currentTurn = 0, rollDie = defaultRollDie } = {}) {
  const text = String(message || '').trim();
  if (!text) return null;

  const intent = resolveIntent(text);
  const state = normalizeWorldState(worldState);
  const sheet = characterSheet || {};

  if (intent.isRollResult) {
    return resolvePendingRoll({ message: text, worldState: state, characterSheet: sheet, rollDie });
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
  return {
    ...worldState,
    player_stats: {
      ...(worldState.player_stats || {}),
    },
    time_state: {
      ...(worldState.time_state || {}),
    },
  };
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
    reply: `Make a DC ${dc} ${check.label}.${inCombat ? ' This uses your Action.' : ''} [CHECK:${check.skill ? ` skill=${check.skill}` : ''} ability=${check.ability}]`,
  };
}

function promptSavingThrow({ intent, worldState, characterSheet, currentTurn = 0, inCombat }) {
  const save = intent.save;
  const modifier = getSavingThrowModifier(characterSheet, save.ability);
  const dc = chooseDc(intent.raw, save, worldState, inCombat);
  const pendingRoll = {
    id: `roll_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'saving_throw',
    ability: save.ability,
    label: save.label,
    formula: `1d20${formatSigned(modifier.total)}`,
    modifier: modifier.total,
    modifier_breakdown: modifier.breakdown,
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
    reply: `Make a DC ${dc} ${save.label}. [SAVE: ability=${save.ability}]`,
  };
}

function promptDeathSave({ worldState, currentTurn = 0 }) {
  if (worldState.pending_roll?.kind === 'death_save') {
    return {
      handled: true,
      logType: 'referee_death_save_pending',
      worldState,
      reply: 'You are still at 0 HP. Resolve the pending death saving throw before doing anything else. The afterlife paperwork has a queue. [ROLL: 1d20]',
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
    reply: 'You are at 0 HP. Make a death saving throw. [ROLL: 1d20]',
  };
}

function resolvePendingRoll({ message, worldState, characterSheet, rollDie }) {
  const result = parseRollResult(message);
  if (!result) return null;

  const pending = worldState.pending_roll;
  if (!pending) return null;

  if (pending.kind === 'initiative') {
    return resolveInitiative({ pending, result, worldState, characterSheet, rollDie });
  }

  if (pending.kind === 'skill_check' || pending.kind === 'ability_check' || pending.kind === 'saving_throw') {
    return resolveCheckRoll({ pending, result, worldState, characterSheet, rollDie });
  }

  if (pending.kind === 'death_save') {
    return resolveDeathSave({ pending, result, worldState, characterSheet, rollDie });
  }

  return null;
}

function resolveCheckRoll({ pending, result, worldState, characterSheet, rollDie }) {
  const margin = result.total - Number(pending.dc || DEFAULT_CHECK_DC);
  const outcome = getRollOutcome({ pending, margin });
  const nextState = {
    ...worldState,
    pending_roll: null,
  };

  let reply = buildCheckResolutionReply(pending, result, outcome);
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

function getRollOutcome({ pending, margin }) {
  if (pending.kind === 'saving_throw') {
    return margin >= 0 ? 'success' : 'failure';
  }
  if (margin >= 0) return 'success';
  if (margin >= -2) return 'near_miss';
  return 'failure';
}

function getDeathSaveStatus(worldState = {}) {
  const saves = worldState.player_stats?.death_saves || { successes: 0, failures: 0 };
  if (Number(saves.failures || 0) >= 3) return 'dead';
  if (Number(saves.successes || 0) >= 3) return 'stable';
  return 'dying';
}

function buildCheckResolutionReply(pending, result, outcome) {
  const dc = Number(pending.dc || DEFAULT_CHECK_DC);
  const label = pending.kind === 'saving_throw' ? pending.label || 'Saving throw' : 'Roll';
  const rollLine = `${label} ${result.total} vs DC ${dc}: ${outcome === 'success' ? '**success**' : outcome === 'near_miss' ? '**near miss**' : '**failure**'}.`;
  if (outcome === 'success') return `${rollLine}\n\n${pending.success_result || 'You accomplish what you set out to do.'}`;
  if (outcome === 'near_miss') {
    return `${rollLine}\n\nYou do not get the clean result you wanted, but you catch enough to keep moving: ${pending.failure_result || 'the attempt does not fully work.'}`;
  }
  return `${rollLine}\n\n${pending.failure_result || 'The attempt fails, and the world refuses to politely pretend otherwise.'}`;
}

function isCombatStarter(text) {
  return /\b(?:attack|hit|strike|stab|swing at|shoot|charge|draw (?:my|a|the).*(?:weapon|sword|bow)|start (?:a )?fight)\b/i.test(text);
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
    reply: `Combat begins. Roll initiative. [ROLL: 1d20${formatSigned(initiative)}]`,
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

  const attack = getPrimaryAttack(characterSheet);
  const natural = rollDie(20);
  const attackTotal = natural + attack.attackBonus;
  const isCrit = natural === 20;
  const criticalMiss = natural === 1;
  const hit = !criticalMiss && (isCrit || attackTotal >= Number(target.ac || 10));
  const lines = [
    `You attack ${target.name} with ${attack.name}. Attack roll: ${natural}${formatSigned(attack.attackBonus)} = ${attackTotal} vs AC ${target.ac}.`,
  ];

  if (hit) {
    const damage = rollDamage(attack.damageFormula, rollDie, isCrit);
    const before = Number(target.hp || 0);
    target.hp = Math.max(0, before - damage.total);
    lines.push(`${isCrit ? '**Critical hit.** ' : ''}Hit for ${damage.total} damage. ${target.name}: (${before} -> ${target.hp} HP).`);
  } else if (criticalMiss) {
    lines.push('**Critical miss.** The attack fails no matter how pretty the math looked in the margins.');
  } else {
    lines.push('Miss. The attack fails to connect, which is rude but rules-compliant.');
  }

  if (Number(target.hp) <= 0) {
    const nextState = {
      ...spent.worldState,
      combat_state: null,
      pending_roll: null,
    };
    return {
      handled: true,
      logType: 'referee_combat_attack',
      worldState: nextState,
      reply: `${lines.join('\n\n')}\n\n${target.name} falls. **Combat ends.**`,
    };
  }

  const nextState = {
    ...spent.worldState,
    combat_state: combat,
  };
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
      armor_class: player.ac,
    },
    time_state: {
      ...(worldState.time_state || {}),
      elapsed_rounds: Number(worldState.time_state?.elapsed_rounds || 0) + creatureTurns.roundsElapsed,
      scene_time: `round ${combat.round}`,
    },
  };
  nextState = beginPlayerTurn(nextState, characterSheet);
  const ticked = tickActiveEffects(nextState, { rounds: creatureTurns.roundsElapsed });
  nextState = ticked.worldState;

  const endLine = player.hp <= 0
    ? '**You drop to 0 HP.** Death saves are now the next thing on the table.'
    : `**Round ${combat.round} begins. It is your turn.**`;
  if (ticked.expiredEffects.length > 0) {
    lines.push(`Expired effects: ${ticked.expiredEffects.map((effect) => effect.name || effect.id).join(', ')}.`);
  }

  return {
    worldState: nextState,
    reply: `${lines.join('\n\n')}\n\n${endLine}`,
  };
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

function chooseDc(text, check, worldState, inCombat) {
  const lower = String(text || '').toLowerCase();
  const explicitDc = lower.match(/\bdc\s*(\d{1,2})\b/);
  if (explicitDc) return Math.max(5, Math.min(30, Number(explicitDc[1])));

  let dc = DEFAULT_CHECK_DC;
  if (/\b(?:easy|simple|obvious|routine)\b/.test(lower)) dc -= 5;
  if (/\b(?:hard|difficult|alert|hostile|hidden|careful|guarded|suspicious)\b/.test(lower)) dc += 5;
  if (/\b(?:very hard|extreme|nearly impossible|overwhelming|deadly)\b/.test(lower)) dc += 5;
  if (inCombat && ['stealth', 'sleight_of_hand', 'persuasion', 'deception', 'intimidation'].includes(check.skill)) dc += 2;
  return Math.max(5, Math.min(30, dc));
}

function buildDcSource(dc, text, inCombat) {
  if (/\bdc\s*\d{1,2}\b/i.test(text || '')) return 'explicit DC declared by referee context';
  const parts = [`base adventuring DC ${DEFAULT_CHECK_DC}`];
  if (dc < DEFAULT_CHECK_DC) parts.push('reduced for simple circumstances');
  if (dc > DEFAULT_CHECK_DC) parts.push('increased for pressure, opposition, or difficult circumstances');
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
    name: identity.name || stats.name || 'You',
    initiative: Number(derived.initiative || 0),
    hp,
    max_hp: Number(stats.max_hp ?? derived.max_hp ?? hp),
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

function formatSigned(value) {
  const number = Number(value || 0);
  return number >= 0 ? `+${number}` : String(number);
}

module.exports = {
  adjudicate,
  resolveRefereeAction: adjudicate,
  advanceEnemyTurns,
  parseRollResult,
  promptCheck,
  chooseDc,
  rollDamage,
};
