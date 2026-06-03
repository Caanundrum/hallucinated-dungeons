const { continuePlayerTurn, spendTurnResource } = require('./actionEconomy');
const { getCombatantDistanceFeet } = require('./combatPositionEngine');

function resolveHelpAction({
  message = '',
  intent = {},
  worldState = {},
  characterSheet = {},
} = {}) {
  if (!worldState.combat_state?.active) return null;
  if (!isHelpIntent(message, intent)) return null;

  const combat = clone(worldState.combat_state);
  const helper = combat.combatants?.find((combatant) => combatant.is_player) || {};
  const kind = getHelpKind(message, intent);
  if (!kind) {
    return {
      handled: true,
      logType: 'referee_help_action_needs_detail',
      worldState,
      reply: 'Help needs a clear beneficiary and task. Try **I help Rowan attack the Goblin** or **I help Rowan search the room**. The Help action is generous, but not psychic.',
    };
  }

  const helpAction = kind === 'attack'
    ? buildAttackHelp({ message, combat, helper, characterSheet })
    : buildCheckHelp({ message, intent, helper, characterSheet });
  if (!helpAction.ok) {
    return {
      handled: true,
      logType: helpAction.logType || 'referee_help_action_blocked',
      worldState,
      reply: helpAction.reply,
    };
  }

  const spent = spendTurnResource(worldState, 'action', 'Help', characterSheet);
  if (!spent.ok) {
    return {
      handled: true,
      logType: 'referee_action_unavailable',
      worldState: spent.worldState,
      reply: spent.reply,
    };
  }

  const nextState = addHelpAction(spent.worldState, helpAction.action);
  const targetText = helpAction.action.target_name ? ` against ${helpAction.action.target_name}` : '';
  const beneficiaryText = helpAction.action.beneficiary_name
    ? ` for ${helpAction.action.beneficiary_name}`
    : '';
  const taskText = helpAction.action.type === 'attack'
    ? `the next matching attack${targetText}${beneficiaryText}`
    : `the next matching ${helpAction.action.label}${beneficiaryText}`;
  const continued = continuePlayerTurn(
    nextState,
    `You take the **Help** action. ${capitalize(taskText)} has Advantage if it happens before your next turn.`,
    characterSheet,
  );
  return {
    handled: true,
    logType: 'referee_help_action',
    ...continued,
  };
}

function applyHelpToPendingCheck({
  worldState = {},
  pendingRoll = {},
  characterSheet = {},
} = {}) {
  const resources = worldState.combat_state?.turn_resources;
  const actions = resources?.help_actions || [];
  if (!actions.length) return { worldState, pendingRoll, used: null };

  const actorName = getCharacterName(characterSheet, worldState);
  const index = actions.findIndex((action) => {
    if (action.type !== 'check') return false;
    if (!nameMatches(action.beneficiary_name, actorName)) return false;
    if (action.skill && action.skill !== pendingRoll.skill) return false;
    if (action.ability && action.ability !== pendingRoll.ability) return false;
    return true;
  });
  if (index < 0) return { worldState, pendingRoll, used: null };

  const used = actions[index];
  return {
    worldState: removeHelpAction(worldState, index),
    pendingRoll: {
      ...pendingRoll,
      advantage_mode: combineAdvantageModes(pendingRoll.advantage_mode || null, 'advantage'),
      advantage_sources: [...new Set([...(pendingRoll.advantage_sources || []), 'Help'])],
      help_action_id: used.id,
    },
    used,
  };
}

function applyHelpToAttack({
  worldState = {},
  combat = {},
  attacker = {},
  target = {},
  advantageMode = null,
  sources = [],
} = {}) {
  const resources = combat.turn_resources || worldState.combat_state?.turn_resources || {};
  const actions = resources.help_actions || [];
  if (!actions.length) {
    return { worldState, combat, attacker, target, advantageMode, sources, used: null };
  }

  const index = actions.findIndex((action) => {
    if (action.type !== 'attack') return false;
    if (!nameMatches(action.beneficiary_name, attacker.name)) return false;
    if (!nameMatches(action.target_name, target.name)) return false;
    return true;
  });
  if (index < 0) {
    return { worldState, combat, attacker, target, advantageMode, sources, used: null };
  }

  const used = actions[index];
  const nextCombat = removeHelpActionFromCombat(combat, index);
  const nextWorldState = {
    ...worldState,
    combat_state: nextCombat,
  };
  return {
    worldState: nextWorldState,
    combat: nextCombat,
    attacker: nextCombat.combatants?.find((combatant) => combatant.is_player) || attacker,
    target: findCombatantByName(nextCombat, target.name) || target,
    advantageMode: combineAdvantageModes(advantageMode, 'advantage'),
    sources: [...new Set([...(sources || []), 'Help'])],
    used,
  };
}

function addHelpAction(worldState = {}, helpAction = {}) {
  const resources = worldState.combat_state?.turn_resources || {};
  return {
    ...worldState,
    combat_state: {
      ...worldState.combat_state,
      turn_resources: {
        ...resources,
        help_actions: [
          ...(resources.help_actions || []),
          helpAction,
        ],
      },
    },
  };
}

function removeHelpAction(worldState = {}, index = -1) {
  if (!worldState.combat_state?.active || index < 0) return worldState;
  return {
    ...worldState,
    combat_state: removeHelpActionFromCombat(worldState.combat_state, index),
  };
}

function removeHelpActionFromCombat(combat = {}, index = -1) {
  const resources = combat.turn_resources || {};
  const helpActions = [...(resources.help_actions || [])];
  if (index < 0 || index >= helpActions.length) return combat;
  helpActions.splice(index, 1);
  const nextResources = {
    ...resources,
    help_actions: helpActions,
  };
  if (!helpActions.length) delete nextResources.help_actions;
  return {
    ...combat,
    turn_resources: nextResources,
  };
}

function buildAttackHelp({ message = '', combat = {}, helper = {}, characterSheet = {} } = {}) {
  const target = findHelpAttackTarget(combat, message);
  if (!target) {
    return {
      ok: false,
      logType: 'referee_help_action_no_target',
      reply: 'Name a hostile creature to distract, or get one clearly into the scene first. Help cannot glare meaningfully at a blank initiative slot.',
    };
  }
  const distance = getCombatantDistanceFeet(helper, target);
  if (distance !== null && distance > 5) {
    return {
      ok: false,
      logType: 'referee_help_action_out_of_reach',
      reply: `Help with an attack needs you within 5 feet of ${target.name}. Current distance: ${distance} ft. Move closer first, then begin the heroic nuisance work.`,
    };
  }
  return {
    ok: true,
    action: {
      id: buildId('help_attack'),
      type: 'attack',
      helper_name: helper.name || getCharacterName(characterSheet),
      beneficiary_name: parseBeneficiaryName(message),
      target_name: target.name,
      source_message: message,
      created_round: Number(combat.round || 1),
      expires: 'start_of_helper_turn',
    },
  };
}

function buildCheckHelp({ message = '', intent = {}, helper = {}, characterSheet = {} } = {}) {
  const check = intent.check;
  if (!check) {
    return {
      ok: false,
      logType: 'referee_help_action_needs_task',
      reply: 'Help with a check needs the task named: Search, Study, Hide, Influence, or a specific ability/skill check. The rules clipboard is hovering expectantly.',
    };
  }
  return {
    ok: true,
    action: {
      id: buildId('help_check'),
      type: 'check',
      helper_name: helper.name || getCharacterName(characterSheet),
      beneficiary_name: parseBeneficiaryName(message),
      skill: check.skill || null,
      ability: check.ability || null,
      label: check.label || 'check',
      source_message: message,
      created_round: Number(intent.round || 1),
      expires: 'start_of_helper_turn',
    },
  };
}

function getHelpKind(message = '', intent = {}) {
  const text = String(message || '');
  if (/\b(?:attack|strike|hit|shoot|shot|distract|feint)\b/i.test(text)) return 'attack';
  if (intent.check || /\b(?:check|search|study|hide|sneak|persuade|convince|investigate|look|listen|track)\b/i.test(text)) return 'check';
  return null;
}

function isHelpIntent(message = '', intent = {}) {
  const text = String(message || '');
  return intent.ruleAction === 'help'
    || /\b(?:help|assist|aid)\b/i.test(text)
    || /\b(?:distract|feint)\b/i.test(text) && /\b(?:to|so|for)\b/i.test(text);
}

function findHelpAttackTarget(combat = {}, message = '') {
  const enemies = (combat.combatants || []).filter((combatant) => !combatant.is_player && Number(combatant.hp || 0) > 0);
  if (!enemies.length) return null;
  const normalizedMessage = normalizeName(message);
  const direct = enemies.find((enemy) => normalizedMessage.includes(normalizeName(enemy.name)));
  if (direct) return direct;
  return enemies.length === 1 ? enemies[0] : null;
}

function parseBeneficiaryName(message = '') {
  const text = String(message || '');
  const explicit = text.match(/\b(?:help|assist|aid)\s+(?!action\b)(?:the\s+)?([a-z][a-z' -]{1,40}?)(?:\s+(?:to|with|attack|strike|hit|shoot|search|study|hide|sneak|persuade|convince|investigate|make|roll)\b|[,.!?]|$)/i);
  const forTarget = text.match(/\bfor\s+(?:the\s+)?([a-z][a-z' -]{1,40}?)(?:\s+(?:to|with|attack|strike|hit|shoot|search|study|hide|sneak|persuade|convince|investigate|make|roll)\b|[,.!?]|$)/i);
  return cleanName(explicit?.[1] || forTarget?.[1]);
}

function getCharacterName(characterSheet = {}, worldState = {}) {
  return characterSheet.identity?.name
    || worldState.combat_state?.combatants?.find((combatant) => combatant.is_player)?.name
    || null;
}

function nameMatches(expected = '', actual = '') {
  const left = normalizeName(expected);
  if (!left) return true;
  const right = normalizeName(actual);
  if (!right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function findCombatantByName(combat = {}, name = '') {
  const target = normalizeName(name);
  return (combat.combatants || []).find((combatant) => normalizeName(combatant.name) === target) || null;
}

function cleanName(value = '') {
  return String(value || '')
    .replace(/\b(?:the|a|an|my|their|his|her|our)\b/gi, ' ')
    .replace(/\b(?:action|check|attack|strike|hit|shoot|search|study|hide|sneak|persuade|convince|investigate|make|roll)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function combineAdvantageModes(left = null, right = null) {
  if (left && right && left !== right) return null;
  return left || right || null;
}

function buildId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function capitalize(value = '') {
  const text = String(value || '');
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

module.exports = {
  applyHelpToAttack,
  applyHelpToPendingCheck,
  resolveHelpAction,
};
