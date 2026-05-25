const { resolveIntent } = require('./intentResolver');

function resolvePreNarration({ message, worldState }) {
  const intent = resolveIntent(message);
  if (intent.isRollResult) {
    const rollFrame = [
      '[MECHANICS: This is a fallback/manual dice result from the client. Server-owned pending rolls use [ROLL REQUEST] and are resolved before narration. If no deterministic pending roll exists, you may use this fallback result for the roll the Game Master just requested; preserve natural 1/20 text when present. Apply 2024 RAW: natural 20/1 automatically matters for attack rolls, and death saves have their special natural 20/1 rules; ordinary ability checks and saving throws use the total against the DC unless a specific rule says otherwise.]',
      buildCombatFrame(intent, worldState, { resolvingRoll: true }),
    ].filter(Boolean).join('\n');

    return {
      intent,
      handled: false,
      skipSpatialGuard: true,
      narrativeFrame: rollFrame,
    };
  }

  return {
    intent,
    handled: false,
    skipSpatialGuard: intent.isMechanicsAction,
    narrativeFrame: buildNarrativeFrame(intent, worldState),
  };
}

function buildNarrativeFrame(intent, worldState = {}) {
  const frames = [];
  if (intent.ruleAction) {
    frames.push(`[MECHANICS: The player declared the ${intent.ruleAction.toUpperCase()} action. Treat that action as spent under combat action economy if combat is active. Do not ask for unrelated spatial clarification about the action name.]`);
  }
  if (intent.castsSpell) {
    frames.push('[MECHANICS: The player is attempting to cast a spell. Use the active character sheet as the authority for spell availability, action timing, duration, concentration, and effects.]');
  }
  frames.push(buildCombatFrame(intent, worldState));
  return frames.join('\n');
}

function buildCombatFrame(intent, worldState = {}, options = {}) {
  const combat = worldState.combat_state;
  if (!combat?.active) return '';

  const frames = [
    `[MECHANICS: Combat is active. Preserve initiative order, action economy, HP changes, active effects, and round/turn progression. Current round: ${combat.round || 1}.]`,
  ];

  if (options.resolvingRoll) {
    frames.push('[MECHANICS: This roll resolves a pending combat check, save, damage roll, or initiative step. After resolving it, continue initiative instead of switching to free exploration. If the resolved roll completes the player turn, immediately resolve every non-player combatant turn in order, update HP/effects/round as needed, and end only at the start of the next player character turn.]');
    return frames.join('\n');
  }

  if (intent.ruleAction && consumesCombatTurn(intent.ruleAction)) {
    frames.push('[MECHANICS: This declared action completes the player character turn unless you must first request one required player roll. If no player roll is pending, immediately advance initiative, resolve every non-player combatant turn in order, update HP/effects/round as needed, and end only at the start of the next player character turn. Do not end with an NPC or monster "up next" while asking the player what they do.]');
  } else if (intent.mayNeedSpatialGuard) {
    frames.push('[MECHANICS: The player is trying to move or interact while combat is active. Do not allow ordinary exploration travel, searching, or scene transition unless combat has ended or the player spends the appropriate movement/action. If the player leaves a hostile creature\'s reach without Disengaging, adjudicate opportunity attacks. Resolve the combat turn before returning control.]');
  } else {
    frames.push('[MECHANICS: The player acted while combat is active. Treat any meaningful action as happening within the current turn, apply action economy, and do not drift into free narration until initiative advances or combat ends.]');
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
