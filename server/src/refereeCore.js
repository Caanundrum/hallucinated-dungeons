const crypto = require('crypto');
const { resolveIntent } = require('./intentResolver');
const { tickActiveEffects } = require('./spellEffectEngine');

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

  if (!state.combat_state?.active && isCombatStarter(text)) {
    return promptInitiative({ message: text, worldState: state, characterSheet: sheet, currentTurn });
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
  const modifier = getCheckModifier(characterSheet, check);
  const dc = chooseDc(intent.raw, check, worldState, inCombat);
  const pendingRoll = {
    id: `roll_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'skill_check',
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
      ...worldState,
      pending_roll: pendingRoll,
    },
    reply: `Make a DC ${dc} ${check.label} check. [CHECK: skill=${check.skill} ability=${check.ability}]`,
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

  return null;
}

function resolveCheckRoll({ pending, result, worldState, characterSheet, rollDie }) {
  const margin = result.total - Number(pending.dc || DEFAULT_CHECK_DC);
  const succeeded = margin >= 0;
  const nearMiss = !succeeded && margin >= -2;
  const outcome = succeeded ? 'success' : nearMiss ? 'near_miss' : 'failure';
  const nextState = {
    ...worldState,
    pending_roll: null,
  };

  let reply = buildCheckResolutionReply(pending, result, outcome);
  if (pending.combat && worldState.combat_state?.active) {
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

function buildCheckResolutionReply(pending, result, outcome) {
  const dc = Number(pending.dc || DEFAULT_CHECK_DC);
  const rollLine = `Roll ${result.total} vs DC ${dc}: ${outcome === 'success' ? '**success**' : outcome === 'near_miss' ? '**near miss**' : '**failure**'}.`;
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
    turn_index: playerIndex,
    combatants,
  };

  const nextState = {
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
    const result = advanceEnemyTurns({
      worldState,
      characterSheet,
      rollDie,
      playerTurnNote: 'You take the **Dodge** action, making yourself much harder to hit until your next turn.',
      playerDodging: true,
    });
    return { handled: true, logType: 'referee_combat_dodge', ...result };
  }

  if (/\b(?:disengage|carefully withdraw|withdraw safely)\b/i.test(message)) {
    const result = advanceEnemyTurns({
      worldState,
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
  const combat = cloneCombatState(worldState.combat_state);
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
      ...worldState,
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
    ...worldState,
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
  const combat = cloneCombatState(worldState.combat_state);
  const player = combat.combatants.find((combatant) => combatant.is_player) || buildPlayerCombatant(characterSheet, worldState);
  const enemies = combat.combatants.filter((combatant) => !combatant.is_player && Number(combatant.hp) > 0);
  const lines = [playerTurnNote];

  for (const enemy of enemies) {
    const attack = enemy.attack || { name: 'attack', attack_bonus: 3, damage_formula: '1d6+1' };
    const first = rollDie(20);
    const second = playerDodging ? rollDie(20) : null;
    const natural = playerDodging ? Math.min(first, second) : first;
    const attackTotal = natural + Number(attack.attack_bonus || 0);
    const ac = Number(player.ac || getArmorClass(characterSheet, worldState));
    const rollText = playerDodging
      ? `${first}/${second} with disadvantage, using ${natural}${formatSigned(attack.attack_bonus)} = ${attackTotal}`
      : `${natural}${formatSigned(attack.attack_bonus)} = ${attackTotal}`;

    const criticalMiss = natural === 1;
    if (!criticalMiss && (attackTotal >= ac || natural === 20)) {
      const damage = rollDamage(attack.damage_formula || '1d6+1', rollDie, natural === 20);
      const before = Number(player.hp ?? getCurrentHp(characterSheet, worldState));
      player.hp = Math.max(0, before - damage.total);
      lines.push(`${enemy.name} uses ${attack.name}: rolls ${rollText} vs AC ${ac}. Hit for ${damage.total} damage. ${player.name}: (${before} -> ${player.hp} HP).`);
    } else if (criticalMiss) {
      lines.push(`${enemy.name} uses ${attack.name}: rolls ${rollText} vs AC ${ac}. **Critical miss.** Even the initiative tracker winces.`);
    } else {
      lines.push(`${enemy.name} uses ${attack.name}: rolls ${rollText} vs AC ${ac}. Miss.`);
    }
  }

  combat.round = advanceRound ? Number(combat.round || 1) + 1 : Number(combat.round || 1);
  combat.turn_index = combat.combatants.findIndex((combatant) => combatant.is_player);
  combat.combatants = combat.combatants.map((combatant) => (
    combatant.is_player ? { ...combatant, hp: player.hp, conditions: clearTurnConditions(combatant.conditions) } : combatant
  ));

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
      elapsed_rounds: Number(worldState.time_state?.elapsed_rounds || 0) + (advanceRound ? 1 : 0),
      scene_time: `round ${combat.round}`,
    },
  };
  const ticked = tickActiveEffects(nextState, { rounds: advanceRound ? 1 : 0 });
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

function clearTurnConditions(conditions = []) {
  return (conditions || []).filter((condition) => !/^dodg/i.test(String(condition)));
}

function getCheckModifier(characterSheet, check) {
  const skillData = characterSheet?.derived_stats?.skill_modifiers?.[check.skill];
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

function chooseDc(text, check, worldState, inCombat) {
  const lower = String(text || '').toLowerCase();
  let dc = DEFAULT_CHECK_DC;
  if (/\b(?:easy|simple|obvious|routine)\b/.test(lower)) dc -= 5;
  if (/\b(?:hard|difficult|alert|hostile|hidden|careful|guarded|suspicious)\b/.test(lower)) dc += 5;
  if (inCombat && ['stealth', 'sleight_of_hand', 'persuasion', 'deception', 'intimidation'].includes(check.skill)) dc += 2;
  return Math.max(5, Math.min(30, dc));
}

function buildDcSource(dc, text, inCombat) {
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

function getArmorClass(characterSheet, worldState) {
  return Number(worldState.player_stats?.armor_class ?? characterSheet?.derived_stats?.armor_class ?? 10);
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
