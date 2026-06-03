const SOCIAL_SKILLS = new Set(['persuasion', 'deception', 'intimidation', 'performance']);

function buildSocialPendingMetadata({ intent = {}, worldState = {} } = {}) {
  const check = intent.check || {};
  if (!SOCIAL_SKILLS.has(check.skill)) return {};
  const targetName = inferSocialTarget({ message: intent.raw, worldState });
  return {
    social: true,
    social_skill: check.skill,
    social_target_name: targetName,
  };
}

function applySocialCheckOutcome({
  pending = {},
  result = {},
  outcome = '',
  worldState = {},
} = {}) {
  if (!isSocialInfluenceCheck(pending)) return { worldState, lines: [] };

  const targetName = pending.social_target_name || inferSocialTarget({ message: pending.intent, worldState });
  if (!targetName) {
    return {
      worldState,
      lines: ['**Influence:** no specific present NPC was identified, so no lasting attitude state changes. The social ledger refuses to write "miscellaneous vibes."'],
    };
  }

  const nextState = upsertNpcInfluenceState({
    worldState,
    targetName,
    skill: pending.skill || pending.social_skill,
    outcome,
    total: result.total,
    dc: pending.dc,
    intent: pending.intent,
  });
  const npcState = getNpcState(nextState, targetName);
  return {
    worldState: nextState,
    lines: [`**Influence:** ${targetName} is now ${npcState.attitude}. Leverage: ${npcState.leverage}.`],
  };
}

function isSocialInfluenceCheck(pending = {}) {
  return Boolean(pending.social) || SOCIAL_SKILLS.has(pending.skill);
}

function upsertNpcInfluenceState({
  worldState = {},
  targetName = '',
  skill = '',
  outcome = '',
  total = null,
  dc = null,
  intent = '',
} = {}) {
  const key = npcKey(targetName);
  if (!key) return worldState;

  const currentStates = worldState.npc_states || {};
  const existing = currentStates[key] || {};
  const nextInfluence = buildInfluence({ skill, outcome });
  const history = [
    ...(existing.influence_history || []),
    {
      skill,
      outcome,
      total: Number(total || 0),
      dc: Number(dc || 0),
      intent: String(intent || '').slice(0, 240),
    },
  ].slice(-5);

  const nextNpcState = {
    ...existing,
    name: existing.name || targetName,
    attitude: nextInfluence.attitude,
    leverage: nextInfluence.leverage,
    last_influence: {
      skill,
      outcome,
      total: Number(total || 0),
      dc: Number(dc || 0),
    },
    influence_history: history,
  };

  return {
    ...worldState,
    npc_states: {
      ...currentStates,
      [key]: nextNpcState,
    },
    npcs_encountered: upsertEncounteredNpc(worldState.npcs_encountered, nextNpcState),
  };
}

function buildInfluence({ skill = '', outcome = '' } = {}) {
  const success = outcome === 'success';
  const nearMiss = outcome === 'near_miss';
  if (skill === 'intimidation') {
    if (success) return { attitude: 'pressured', leverage: 'intimidated into short-term cooperation' };
    if (nearMiss) return { attitude: 'guarded', leverage: 'unsettled but not yielding' };
    return { attitude: 'hostile', leverage: 'resentful after failed intimidation' };
  }
  if (skill === 'deception') {
    if (success) return { attitude: 'misled', leverage: 'believes the current falsehood for now' };
    if (nearMiss) return { attitude: 'suspicious', leverage: 'not fully convinced' };
    return { attitude: 'distrustful', leverage: 'caught or resisted the deception' };
  }
  if (skill === 'performance') {
    if (success) return { attitude: 'impressed', leverage: 'favorably distracted or entertained' };
    if (nearMiss) return { attitude: 'neutral', leverage: 'noticed the attempt without being moved' };
    return { attitude: 'unmoved', leverage: 'performance failed to shift them' };
  }
  if (success) return { attitude: 'cooperative', leverage: 'more willing to help within reason' };
  if (nearMiss) return { attitude: 'neutral', leverage: 'not opposed, but not persuaded' };
  return { attitude: 'unconvinced', leverage: 'not moved by the appeal' };
}

function inferSocialTarget({ message = '', worldState = {} } = {}) {
  const present = (worldState.scene_presence?.present_npcs || []).filter(Boolean);
  if (!present.length) return null;
  const normalizedMessage = normalizeName(message);
  const direct = present.find((name) => {
    const candidate = normalizeName(name);
    const singular = singularize(candidate);
    return hasWholePhrase(normalizedMessage, candidate) || hasWholePhrase(normalizedMessage, singular);
  });
  if (direct) return direct;

  const explicit = String(message || '').match(/\b(?:to|with|at|convince|persuade|reassure|calm|intimidate|threaten|deceive|lie to|perform for)\s+(?:the\s+|a\s+|an\s+)?([a-z][a-z' -]{1,40}?)(?:\s+(?:to|that|about|into|with|by|for)\b|[,.!?]|$)/i);
  if (explicit?.[1]) {
    const cleaned = cleanTarget(explicit[1]);
    const match = present.find((name) => namesMatch(name, cleaned));
    if (match) return match;
  }

  return present.length === 1 ? present[0] : null;
}

function upsertEncounteredNpc(existing = [], npcState = {}) {
  const list = Array.isArray(existing) ? existing : [];
  const key = npcKey(npcState.name);
  const nextEntry = {
    name: npcState.name,
    disposition: npcState.attitude,
    last_seen: npcState.last_seen || '',
  };
  let found = false;
  const updated = list.map((entry) => {
    if (npcKey(entry?.name) !== key) return entry;
    found = true;
    return { ...entry, ...nextEntry };
  });
  if (!found) updated.push(nextEntry);
  return updated;
}

function getNpcState(worldState = {}, targetName = '') {
  return worldState.npc_states?.[npcKey(targetName)] || {};
}

function namesMatch(left = '', right = '') {
  const l = normalizeName(left);
  const r = normalizeName(right);
  if (!l || !r) return false;
  return l === r || l.includes(r) || r.includes(l) || singularize(l) === singularize(r);
}

function cleanTarget(value = '') {
  return String(value || '')
    .replace(/\b(?:the|a|an|my|their|his|her|our|frightened|angry|hostile|friendly)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function npcKey(name = '') {
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
  applySocialCheckOutcome,
  buildSocialPendingMetadata,
  inferSocialTarget,
  isSocialInfluenceCheck,
};
