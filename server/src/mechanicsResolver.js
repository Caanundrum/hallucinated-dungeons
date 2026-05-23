const { resolveIntent } = require('./intentResolver');

function resolvePreNarration({ message, worldState }) {
  const intent = resolveIntent(message);
  if (intent.isRollResult) {
    return { intent, handled: false, skipSpatialGuard: true, narrativeFrame: '' };
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
  }
  return frames.join('\n');
}

module.exports = {
  resolvePreNarration,
};
