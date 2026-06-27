const NON_NARRATED_LOG_TYPE = /(?:^|_)(?:blocked|unavailable|needed|required|prompt|pending|rejected|mismatch|wrong|missing|failed|no_target|target_needed|choice|level_required|combat_required|rest_required|already_active|not_active|full_hp|slots_full|points_full|no_focus|limit|unsupported|incapacitated|no_combat|form_blocked|stone_needed|instruction)(?:_|$)/i;

const NON_NARRATED_EXACT = new Set([
  'manual_roll_rejected',
  'referee_combat_action_needed',
  'referee_reaction_declined',
  'referee_resource_primed',
  'origin_lucky_defense_primed',
  'species_giant_ancestry_reaction_primed',
]);

function shouldNarrateResolvedEvent({ result = null } = {}) {
  if (!result?.handled || !String(result.reply || '').trim()) return false;
  if (result.narration === 'always') return true;
  if (result.narration === 'never') return false;

  const logType = String(result.logType || '').trim();
  if (!logType || NON_NARRATED_EXACT.has(logType) || NON_NARRATED_LOG_TYPE.test(logType)) return false;

  const state = result.worldState || {};
  if (state.pending_roll || state.pending_reaction || state.pending_tactical_mind) return false;
  if (/\[(?:ROLL_REQUEST|REACTION_REQUEST|SAVE_REQUEST)\b/i.test(String(result.reply || ''))) return false;

  return true;
}

function buildResolvedEventNarrativeFrame({
  message = '',
  result = {},
  worldState = {},
  characterSheet = {},
} = {}) {
  const identity = characterSheet.identity || {};
  const scene = worldState.scene_presence || {};
  const combat = worldState.combat_state;
  const lines = [
    '[RESOLVED RULES EVENT]',
    `Player declaration: ${String(message || '').trim() || 'not recorded'}`,
    `Resolved event type: ${String(result.logType || 'rules_event')}`,
    `Active character: ${identity.name || worldState.player_stats?.name || 'active character'}`,
    `Current location: ${scene.exact_location || worldState.current_location || 'not established'}`,
    `Authoritative rules outcome: ${String(result.reply || '').trim()}`,
    combat?.active
      ? `Combat state after resolution: round ${combat.round || 1}; current turn index ${combat.turn_index ?? 0}.`
      : 'Combat state after resolution: no active initiative unless the authoritative outcome explicitly says combat just ended.',
    'The referee has already resolved legality, dice, DCs, damage, healing, resources, action economy, duration, movement, conditions, targets, combat progression, and XP. Preserve every stated result and the supplied world state exactly.',
    'Narrate the completed outcome in-world with concise sensory and character-facing detail. Translate mechanics into fiction instead of reciting a status receipt, while retaining important player-visible totals when they help the player understand the result.',
    'Use the player declaration as the authority for their intent, exact words, and chosen manner. Do not invent player speech, decisions, movement, targets, attacks, spell effects, conditions, consequences, or mechanical benefits.',
    'Do not request another roll, repeat the resolved action, spend another resource, advance time again, advance initiative again, or contradict the authoritative outcome.',
    'End at the situation produced by the resolved event. If the authoritative outcome leaves actions or movement available, make that clear naturally; otherwise return control without inventing a menu of precise actions.',
  ];

  const guidance = String(result.narrationGuidance || result.narrativeFrame || '').trim();
  if (guidance) {
    lines.push(`Event-specific narration guidance:\n${guidance}`);
  }

  return lines.join('\n');
}

function createResolvedEventNarrationAction({ message = '', result = {}, characterSheet = {} } = {}) {
  if (!shouldNarrateResolvedEvent({ result })) return null;
  const worldState = result.worldState || {};
  return {
    matched: true,
    handled: false,
    worldState,
    skipPreNarration: true,
    skipSpatialGuard: true,
    skipNarrativeClock: true,
    fallbackReply: result.reply,
    deliveryRequirements: result.narrationRequirements || null,
    narrativeFrame: buildResolvedEventNarrativeFrame({
      message,
      result,
      worldState,
      characterSheet,
    }),
  };
}

module.exports = {
  shouldNarrateResolvedEvent,
  buildResolvedEventNarrativeFrame,
  createResolvedEventNarrationAction,
};
