const { resolveIntent } = require('./intentResolver');

function resolvePreNarration({ message, worldState }) {
  const intent = resolveIntent(message);
  if (intent.isRollResult) {
    return {
      intent,
      handled: false,
      skipSpatialGuard: true,
      narrativeFrame: '[MECHANICS: This is an authenticated dice-roller result because it starts with [ROLL RESULT:]. Accept it as official even if the final total is 0 or negative after modifiers. Resolve the pending check, save, damage roll, or other requested roll from this result.]',
    };
  }

  if (intent.check && shouldGateCheck(intent, worldState)) {
    return {
      intent,
      handled: true,
      skipSpatialGuard: true,
      response: buildCheckPrompt(intent.check),
      logType: 'mechanics_check_gate',
    };
  }

  return {
    intent,
    handled: false,
    skipSpatialGuard: intent.isMechanicsAction,
    narrativeFrame: buildNarrativeFrame(intent, worldState),
  };
}

function shouldGateCheck(intent, worldState = {}) {
  const text = intent.raw.toLowerCase();
  const combatActive = Boolean(worldState.combat_state?.active);

  if (combatActive && intent.ruleAction && !['hide', 'search', 'study', 'influence'].includes(intent.ruleAction)) {
    return false;
  }

  if (/\b(?:just|only)\s+(?:look|glance|say hello|wave)\b/i.test(text)) return false;
  return true;
}

function buildCheckPrompt(check) {
  return `Make a ${check.label} check. [CHECK: skill=${check.skill} ability=${check.ability}]`;
}

function buildNarrativeFrame(intent, worldState = {}) {
  const frames = [];
  if (intent.ruleAction) {
    frames.push(`[MECHANICS: The player declared the ${intent.ruleAction.toUpperCase()} action. Treat that action as spent under combat action economy if combat is active. Do not ask for unrelated spatial clarification about the action name.]`);
  }
  if (intent.castsSpell) {
    frames.push('[MECHANICS: The player is attempting to cast a spell. Use the active character sheet as the authority for spell availability, action timing, duration, concentration, and effects.]');
  }
  if (worldState.combat_state?.active) {
    frames.push(`[MECHANICS: Combat is active. Preserve initiative order, action economy, HP changes, active effects, and round/turn progression. Current round: ${worldState.combat_state.round || 1}.]`);
    if (intent.ruleAction && consumesCombatTurn(intent.ruleAction)) {
      frames.push('[MECHANICS: This declared action completes the player character turn unless you must first request one required player roll. If no player roll is pending, immediately advance initiative, resolve every non-player combatant turn in order, update HP/effects/round as needed, and end only at the start of the next player character turn. Do not end with an NPC or monster "up next" while asking the player what they do.]');
    }
  }
  return frames.join('\n');
}

function consumesCombatTurn(ruleAction) {
  return [
    'attack',
    'dash',
    'disengage',
    'dodge',
    'help',
    'hide',
    'influence',
    'magic',
    'ready',
    'search',
    'study',
    'utilize',
  ].includes(ruleAction);
}

module.exports = {
  resolvePreNarration,
  consumesCombatTurn,
};
