const DISCOVERY_SKILLS = new Set(['insight', 'investigation', 'perception', 'survival']);

function buildDiscoveryPendingMetadata({ intent = {}, worldState = {} } = {}) {
  const check = intent.check || {};
  if (!DISCOVERY_SKILLS.has(check.skill)) return {};
  const action = inferDiscoveryAction(intent);
  if (!action) return {};
  const target = inferDiscoveryTarget({ message: intent.raw, action, skill: check.skill, worldState });
  return {
    discovery: true,
    discovery_action: action,
    discovery_target: target.name,
    discovery_target_type: target.type,
    discovery_subject: extractDiscoverySubject(intent.raw),
  };
}

function applyDiscoveryCheckOutcome({
  pending = {},
  result = {},
  outcome = '',
  worldState = {},
} = {}) {
  if (!isDiscoveryCheck(pending)) return { worldState, lines: [] };

  const action = pending.discovery_action || inferDiscoveryAction({ raw: pending.intent, ruleAction: pending.rule_action, check: pending });
  if (!action) return { worldState, lines: [] };

  const target = {
    name: pending.discovery_target || inferDiscoveryTarget({
      message: pending.intent,
      action,
      skill: pending.skill,
      worldState,
    }).name,
    type: pending.discovery_target_type || 'unknown',
  };
  const subject = pending.discovery_subject || extractDiscoverySubject(pending.intent);
  if (!target.name) {
    return {
      worldState,
      lines: ['**Discovery:** no clear searchable or studyable target was identified, so no lasting discovery state changes. The clue cabinet remains politely unfiled.'],
    };
  }

  const nextState = upsertDiscoveryState({
    worldState,
    action,
    target,
    skill: pending.skill,
    outcome,
    total: result.total,
    dc: pending.dc,
    intent: pending.intent,
    subject,
  });
  return {
    worldState: nextState,
    lines: [formatDiscoveryLine({ action, targetName: target.name, outcome, subject })],
  };
}

function isDiscoveryCheck(pending = {}) {
  return Boolean(pending.discovery) || Boolean(inferDiscoveryAction({
    raw: pending.intent,
    ruleAction: pending.rule_action,
    check: pending,
  }));
}

function resolveKnownDiscoveryFollowup({ message = '', worldState = {} } = {}) {
  const normalizedMessage = normalizeName(message);
  if (!isDiscoveryFollowupMessage(normalizedMessage)) return null;

  const discoveries = getSuccessfulDiscoveries(worldState.discovery_state);
  if (discoveries.length === 0) return null;

  const matchedDiscovery = discoveries.find((entry) => followupMentionsDiscovery(normalizedMessage, entry))
    || (discoveries.length === 1 && isGenericDiscoveryContinuation(normalizedMessage) ? discoveries[0] : null);
  if (!matchedDiscovery) return null;

  return {
    handled: true,
    logType: 'discovery_followup',
    worldState,
    reply: formatKnownDiscoveryFollowup(matchedDiscovery),
  };
}

function inferDiscoveryAction(intent = {}) {
  const raw = String(intent.raw || intent.intent || '');
  const ruleAction = intent.ruleAction || intent.rule_action || null;
  const skill = intent.check?.skill || intent.skill || null;
  if (ruleAction === 'search' || ruleAction === 'study') return ruleAction;
  if (/\b(?:search|scan|look around|listen|watch for|keep watch|check the area|track|tracks|trail|footprints|spoor)\b/i.test(raw)) return 'search';
  if (/\b(?:study|investigate|examine|inspect|read|judge|size up|sense|gauge)\b/i.test(raw)) return 'study';
  if (skill === 'perception' || skill === 'survival') return 'search';
  if (skill === 'insight' || skill === 'investigation') return 'study';
  return null;
}

function upsertDiscoveryState({
  worldState = {},
  action = '',
  target = {},
  skill = '',
  outcome = '',
  total = null,
  dc = null,
  intent = '',
  subject = '',
} = {}) {
  const key = discoveryKey(target.name);
  if (!key) return worldState;
  const bucket = action === 'search' ? 'searches' : 'studies';
  const currentState = normalizeDiscoveryState(worldState.discovery_state);
  const existing = currentState[bucket][key] || {};
  const success = outcome === 'success';
  const nearMiss = outcome === 'near_miss';
  const entry = {
    ...existing,
    target: existing.target || target.name,
    target_type: existing.target_type || target.type || 'unknown',
    subject: subject || existing.subject || '',
    location: worldState.scene_presence?.exact_location || worldState.current_location || existing.location || '',
    last_outcome: outcome,
    best_outcome: bestOutcome(existing.best_outcome, outcome),
    discovered: Boolean(existing.discovered || success),
    partial: Boolean(existing.partial || nearMiss),
    attempts: Number(existing.attempts || 0) + 1,
    last_check: {
      skill,
      total: Number(total || 0),
      dc: Number(dc || 0),
      outcome,
    },
    history: [
      ...(existing.history || []),
      {
        skill,
        total: Number(total || 0),
        dc: Number(dc || 0),
        outcome,
        intent: String(intent || '').slice(0, 240),
        subject: String(subject || '').slice(0, 120),
      },
    ].slice(-5),
  };

  return {
    ...worldState,
    discovery_state: {
      ...currentState,
      [bucket]: {
        ...currentState[bucket],
        [key]: entry,
      },
    },
  };
}

function inferDiscoveryTarget({ message = '', action = '', skill = '', worldState = {} } = {}) {
  const scene = worldState.scene_presence || {};
  const entities = [
    ...(scene.present_npcs || []).map((name) => ({ name, type: 'npc' })),
    ...(scene.present_objects || []).map((name) => ({ name, type: 'object' })),
  ].filter((entry) => entry.name);
  const normalizedMessage = normalizeName(message);
  const direct = entities.find((entry) => mentionsName(normalizedMessage, entry.name));
  if (direct) return direct;

  const explicit = extractExplicitTarget(message);
  if (explicit) {
    const match = entities.find((entry) => namesMatch(entry.name, explicit));
    if (match) return match;
    if (isCredibleExplicitTarget(explicit, action, skill)) {
      return {
        name: explicit,
        type: inferExplicitTargetType(explicit),
      };
    }
  }

  if (action === 'search' || isAreaSearch({ message, skill })) {
    return {
      name: scene.exact_location || worldState.current_location || 'current area',
      type: 'location',
    };
  }

  if (entities.length === 1) return entities[0];
  return { name: null, type: null };
}

function extractExplicitTarget(message = '') {
  const match = String(message || '').match(/\b(?:search|scan|study|investigate|examine|inspect|read|watch|listen to|judge|size up|sense|gauge)\s+(?:the\s+|that\s+|a\s+|an\s+|my\s+|their\s+|his\s+|her\s+|our\s+)?([a-z][a-z' -]{1,50}?)(?:\s+(?:and\s+(?:look|search|scan|study|investigate|examine|inspect|read|watch|listen)\b|for|to|with|about|carefully|closely|again|before|after)\b|[,.!?]|$)/i);
  if (!match?.[1]) return null;
  return cleanTarget(match[1]);
}

function extractDiscoverySubject(message = '') {
  const match = String(message || '').match(/\b(?:for|about|regarding|concerning)\s+(?:details?\s+(?:about\s+)?)?(?:the\s+|that\s+|a\s+|an\s+)?([a-z0-9][a-z0-9' -]{1,80}?)(?:[,.!?]|$)/i);
  if (!match?.[1]) return '';
  return cleanTarget(match[1])
    .replace(/\b(?:details?|information|clues?|signs?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCredibleExplicitTarget(target = '', action = '', skill = '') {
  const normalized = normalizeName(target);
  if (!normalized) return false;
  if (/\b(?:notice|board|sign|posting|note|letter|parchment|paper|book|scroll|door|gate|chest|box|satchel|bag|desk|table|altar|statue|body|corpse|bones|tracks?|trail|footprints?|rubble|wall|floor|ceiling|window|token|seal|symbol|mark|rune)\b/.test(normalized)) {
    return true;
  }
  return (action === 'search' || skill === 'perception' || skill === 'survival')
    && /\b(?:area|room|road|path|woods?|forest|ground|mud|brush|clearing)\b/.test(normalized);
}

function inferExplicitTargetType(target = '') {
  const normalized = normalizeName(target);
  if (/\b(?:area|room|road|path|woods?|forest|ground|mud|brush|clearing|trail|tracks?|footprints?)\b/.test(normalized)) return 'location';
  if (/\b(?:body|corpse|bones)\b/.test(normalized)) return 'creature';
  return 'object';
}

function isAreaSearch({ message = '', skill = '' } = {}) {
  return skill === 'perception'
    || skill === 'survival'
    || /\b(?:area|room|surroundings|around|tracks|trail|footprints|signs|clues)\b/i.test(String(message || ''));
}

function formatDiscoveryLine({ action, targetName, outcome, subject = '' }) {
  const subjectText = subject ? ` about ${subject}` : '';
  if (outcome === 'success') {
    return `**Discovery:** ${targetName} now has a successful ${action} result${subjectText} on record. The DM can reveal what that target or area can fairly provide.`;
  }
  if (outcome === 'near_miss') {
    return `**Discovery:** ${targetName} has a partial ${action} result${subjectText} on record, but no confirmed discovery yet. The trail is coughing, not singing.`;
  }
  return `**Discovery:** ${targetName} has a failed ${action} attempt${subjectText} on record. No reliable new discovery is established from this roll.`;
}

function bestOutcome(current = '', next = '') {
  const rank = { failure: 0, near_miss: 1, success: 2 };
  return (rank[next] || 0) > (rank[current] || 0) ? next : (current || next);
}

function normalizeDiscoveryState(value = {}) {
  const state = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    searches: { ...(state.searches || {}) },
    studies: { ...(state.studies || {}) },
  };
}

function getSuccessfulDiscoveries(discoveryState = {}) {
  const state = normalizeDiscoveryState(discoveryState);
  return [
    ...Object.entries(state.studies).map(([key, entry]) => ({ ...entry, key, action: 'study' })),
    ...Object.entries(state.searches).map(([key, entry]) => ({ ...entry, key, action: 'search' })),
  ].filter((entry) => entry.discovered || entry.best_outcome === 'success');
}

function isDiscoveryFollowupMessage(normalizedMessage = '') {
  return /\b(?:read|details?|review|recap|explain|summari[sz]e|reveal|inspect|study|examine|findings?|discovered|learned)\b/.test(normalizedMessage)
    || /\bwhat\b.*\b(?:found|learned|discovered|noticed|saw|says?|said)\b/.test(normalizedMessage);
}

function followupMentionsDiscovery(normalizedMessage = '', entry = {}) {
  if (mentionsName(normalizedMessage, entry.target)) return true;
  if (mentionsName(normalizedMessage, entry.subject)) return true;
  const messageTokens = new Set(normalizedMessage.split(' ').filter(Boolean));
  const entryTokens = significantDiscoveryTokens(entry);
  const overlappingTokens = entryTokens.filter((token) => messageTokens.has(token));
  return overlappingTokens.length > 0 && /\b(?:details?|read|review|what|reveal|inspect|study|examine|look)\b/.test(normalizedMessage);
}

function isGenericDiscoveryContinuation(normalizedMessage = '') {
  return /\b(?:read|details?|review|recap|reveal|findings?|discovered|learned)\b/.test(normalizedMessage)
    || /\bwhat\b.*\b(?:found|learned|discovered|noticed|saw|says?|said)\b/.test(normalizedMessage);
}

function significantDiscoveryTokens(entry = {}) {
  return normalizeName(`${entry.target || ''} ${entry.subject || ''}`)
    .split(' ')
    .filter((token) => token.length >= 4 && !DISCOVERY_STOP_WORDS.has(token));
}

function formatKnownDiscoveryFollowup(entry = {}) {
  const target = entry.target || 'that discovery';
  const subjectText = entry.subject ? ` about ${entry.subject}` : '';
  return `**Discovery:** ${target} already has a successful ${entry.action || 'discovery'} result${subjectText} on record. No new roll is needed; use the established result and reveal what that target can fairly provide.`;
}

const DISCOVERY_STOP_WORDS = new Set([
  'details',
  'detail',
  'information',
  'clues',
  'clue',
  'signs',
  'sign',
  'about',
  'from',
  'that',
  'this',
  'with',
  'read',
  'look',
  'study',
  'inspect',
  'examine',
]);

function mentionsName(normalizedMessage = '', name = '') {
  const normalized = normalizeName(name);
  const singular = singularize(normalized);
  return hasWholePhrase(normalizedMessage, normalized) || hasWholePhrase(normalizedMessage, singular);
}

function namesMatch(left = '', right = '') {
  const l = normalizeName(left);
  const r = normalizeName(right);
  if (!l || !r) return false;
  return l === r || hasWholePhrase(l, r) || hasWholePhrase(r, l) || singularize(l) === singularize(r);
}

function cleanTarget(value = '') {
  return String(value || '')
    .replace(/\band\s+(?:look|search|scan|study|investigate|examine|inspect|read|watch|listen)\b.*$/i, ' ')
    .replace(/\b(?:the|a|an|my|their|his|her|our|current|nearby|careful|closely)\b/gi, ' ')
    .replace(/\b(?:face|expression|demeanor|mood|room|area|surroundings)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function discoveryKey(name = '') {
  return normalizeName(name).replace(/\s+/g, '_');
}

function normalizeName(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function singularize(value = '') {
  return String(value || '').replace(/\b([a-z]{3,})s\b/g, '$1');
}

function hasWholePhrase(normalizedMessage = '', normalizedPhrase = '') {
  if (!normalizedMessage || !normalizedPhrase) return false;
  return new RegExp(`(?:^| )${escapeRegExp(normalizedPhrase)}(?: |$)`).test(normalizedMessage);
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  applyDiscoveryCheckOutcome,
  buildDiscoveryPendingMetadata,
  inferDiscoveryAction,
  inferDiscoveryTarget,
  isDiscoveryCheck,
  resolveKnownDiscoveryFollowup,
};
