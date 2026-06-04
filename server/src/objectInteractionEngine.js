const PORTABLE_HINTS = /\b(note|letter|coin|key|token|ring|vial|book|paper|parchment|scroll|satchel|bag|gem|bottle|map|journal|seal|ash|tooth|pouch|packet)\b/i;
const OPENABLE_HINTS = /\b(door|chest|box|gate|satchel|bag|drawer|container|envelope|note|letter|book|scroll|packet|pouch)\b/i;
const READABLE_HINTS = /\b(note|letter|book|paper|parchment|scroll|sign|notice|writing|symbol|rune|map|journal|ledger|posting)\b/i;
const LOCKABLE_HINTS = /\b(door|chest|box|gate|drawer|lock|container|coffer|case)\b/i;

function resolveObjectInteraction({ message = '', worldState = {} } = {}) {
  const intent = parseObjectInteraction(message);
  if (!intent) return null;

  const target = findObjectTarget({ targetText: intent.targetText, message, worldState });
  if (!target) return null;

  const challenge = resolveObjectChallengeFromIntent({ intent, target, worldState });
  if (challenge?.handled) {
    return {
      handled: true,
      logType: challenge.logType,
      worldState,
      response: challenge.response,
      intent,
      target,
    };
  }
  if (challenge?.requiresRoll) {
    return {
      handled: true,
      logType: 'object_interaction_requires_referee_check',
      worldState,
      response: `${target.name} needs a DC ${challenge.dc} ${challenge.label} before that can resolve. The referee should call for that check instead of narrating past it.`,
      intent,
      target,
      challenge,
    };
  }

  const support = checkSupportedInteraction(intent.action, target.name);
  if (!support.ok) {
    return {
      handled: true,
      logType: 'object_interaction_blocked',
      worldState,
      response: support.reply,
      intent,
      target,
    };
  }

  const nextState = applyObjectInteraction({ intent, target, worldState });
  return {
    handled: false,
    logType: 'object_interaction_state',
    worldState: nextState,
    skipSpatialGuard: true,
    narrativeFrame: buildObjectInteractionFrame({ intent, target }),
    intent,
    target,
  };
}

function parseObjectInteraction(message = '') {
  const text = String(message || '');
  const patterns = [
    { action: 'unlock', pattern: /\b(?:pick|work|disable)\s+(?:the\s+)?lock\s+(?:on|of)\s+(?:the\s+|that\s+|a\s+|an\s+)?([a-z][a-z' -]{1,60}?)(?:\s+(?:with|carefully|quietly)\b|[,.!?]|$)/i },
    { action: 'unlock', pattern: /\b(?:unlock|pick open)\s+(?:the\s+|that\s+|a\s+|an\s+)?([a-z][a-z' -]{1,60}?)(?:\s+(?:with|carefully|quietly)\b|[,.!?]|$)/i },
    { action: 'disarm', pattern: /\b(?:disarm|disable|jam)\s+(?:the\s+)?trap\s+(?:on|in|inside|of)\s+(?:the\s+|that\s+|a\s+|an\s+)?([a-z][a-z' -]{1,60}?)(?:\s+(?:with|carefully|quietly)\b|[,.!?]|$)/i },
    { action: 'disarm', pattern: /\b(?:disarm|disable|jam)\s+(?:the\s+|that\s+|a\s+|an\s+)?([a-z][a-z' -]{1,60}?)(?:\s+(?:with|carefully|quietly)\b|[,.!?]|$)/i },
    { action: 'take', pattern: /\b(?:take|grab|pick up|collect|retrieve|remove)\s+(?:the\s+|that\s+|a\s+|an\s+)?([a-z][a-z' -]{1,60}?)(?:\s+(?:from|off|out of|with|carefully|closely|quietly)\b|[,.!?]|$)/i },
    { action: 'open', pattern: /\b(?:open|unseal|unfold|unwrap)\s+(?:the\s+|that\s+|a\s+|an\s+)?([a-z][a-z' -]{1,60}?)(?:\s+(?:from|off|out of|with|carefully|closely|quietly)\b|[,.!?]|$)/i },
    { action: 'close', pattern: /\b(?:close|shut|seal|fold|wrap)\s+(?:the\s+|that\s+|a\s+|an\s+)?([a-z][a-z' -]{1,60}?)(?:\s+(?:with|carefully|closely|quietly)\b|[,.!?]|$)/i },
    { action: 'read', pattern: /\b(?:read|consult)\s+(?:the\s+|that\s+|a\s+|an\s+)?([a-z][a-z' -]{1,60}?)(?:\s+(?:from|on|about|carefully|closely|again|aloud|quietly)\b|[,.!?]|$)/i },
    { action: 'use', pattern: /\b(?:use|touch|press|pull|turn)\s+(?:the\s+|that\s+|a\s+|an\s+)?([a-z][a-z' -]{1,60}?)(?:\s+(?:with|on|for|carefully|closely|quietly)\b|[,.!?]|$)/i },
  ];

  for (const entry of patterns) {
    const match = text.match(entry.pattern);
    const targetText = cleanTarget(match?.[1]);
    if (targetText) return { action: entry.action, targetText, raw: text };
  }
  return null;
}

function applyObjectInteraction({ intent, target, worldState = {} } = {}) {
  const key = objectKey(target.name);
  const currentObjects = normalizeObjectStates(worldState.object_states);
  const currentEntry = currentObjects[key] || {};
  const location = target.carried
    ? currentEntry.location || 'carried_by_player'
    : worldState.scene_presence?.exact_location || worldState.current_location || currentEntry.location || '';
  const entry = {
    ...currentEntry,
    name: currentEntry.name || target.name,
    location,
    present: !target.carried,
    carried_by: target.carried ? 'player' : currentEntry.carried_by || null,
    last_interaction: intent.action,
    interaction_history: [
      ...(currentEntry.interaction_history || []),
      { action: intent.action, turn_location: worldState.scene_presence?.exact_location || worldState.current_location || '', raw: String(intent.raw || '').slice(0, 180) },
    ].slice(-8),
  };

  if (intent.action === 'take') {
    entry.present = false;
    entry.carried_by = 'player';
    entry.location = 'carried_by_player';
    entry.taken = true;
  }
  if (intent.action === 'open') entry.is_open = true;
  if (intent.action === 'close') entry.is_open = false;
  if (intent.action === 'read') entry.is_read = true;
  if (intent.action === 'use') entry.used = true;

  const nextState = {
    ...worldState,
    object_states: {
      ...currentObjects,
      [key]: entry,
    },
  };

  if (intent.action === 'take') {
    nextState.inventory_state = addCarriedObject(worldState.inventory_state, {
      name: target.name,
      source_location: worldState.scene_presence?.exact_location || worldState.current_location || '',
    });
    nextState.scene_presence = removePresentObject(worldState.scene_presence, target.name);
  }

  return nextState;
}

function findObjectTarget({ targetText = '', message = '', worldState = {} } = {}) {
  const sceneObjects = (worldState.scene_presence?.present_objects || []).filter(Boolean);
  const carriedObjects = getCarriedObjects(worldState);
  const stateObjects = getPresentStateObjects(worldState);
  const candidates = [
    ...sceneObjects.map((name) => ({ name, carried: false, objectState: objectStateForName(worldState, name) })),
    ...carriedObjects.map((item) => ({ name: item.name, carried: true, objectState: objectStateForName(worldState, item.name) })),
    ...stateObjects.map((entry) => ({ name: entry.name, carried: entry.carried_by === 'player', objectState: entry })),
  ];
  if (!candidates.length) return null;

  const uniqueCandidates = dedupeTargets(candidates);
  const direct = uniqueCandidates.find((candidate) => namesMatch(candidate.name, targetText));
  if (direct) return direct;

  const normalizedMessage = normalizeName(message);
  return uniqueCandidates.find((candidate) => mentionsName(normalizedMessage, candidate.name)) || null;
}

function checkSupportedInteraction(action, targetName) {
  if (action === 'take' && !PORTABLE_HINTS.test(targetName)) {
    return { ok: false, reply: `${targetName} is present, but it is not a portable object. You can inspect it, use it if that makes sense, or describe another approach. The backpack refuses architectural acquisitions.` };
  }
  if ((action === 'open' || action === 'close') && !OPENABLE_HINTS.test(targetName)) {
    return { ok: false, reply: `${targetName} is present, but the object rules do not treat it as something openable or closable. Describe a different interaction.` };
  }
  if (action === 'read' && !READABLE_HINTS.test(targetName)) {
    return { ok: false, reply: `${targetName} is present, but it is not a readable object. You can inspect it instead if you want clues from its appearance.` };
  }
  if (action === 'unlock' && !LOCKABLE_HINTS.test(targetName)) {
    return { ok: false, reply: `${targetName} is present, but the object rules do not treat it as lockable. Describe a different interaction.` };
  }
  return { ok: true };
}

function resolveObjectChallenge({ message = '', worldState = {} } = {}) {
  const intent = parseObjectInteraction(message);
  if (!intent) return null;
  const target = findObjectTarget({ targetText: intent.targetText, message, worldState })
    || findSingleChallengeTarget({ intent, worldState });
  if (!target) return null;
  return resolveObjectChallengeFromIntent({ intent, target, worldState });
}

function resolveObjectChallengeFromIntent({ intent, target, worldState = {} } = {}) {
  const objectState = target.objectState || objectStateForName(worldState, target.name) || {};
  const locked = isLocked(objectState);
  const armedTrap = getKnownArmedTrap(objectState);

  if (intent.action === 'disarm') {
    if (!armedTrap) {
      return {
        handled: true,
        logType: 'object_interaction_no_trap',
        response: `${target.name} does not have an established armed trap in the current state. You can inspect it, open it if possible, or describe a different approach. The trap budget remains unspent.`,
      };
    }
    return objectChallenge({
      type: 'trap',
      action: 'disarm',
      target,
      dc: armedTrap.dc || objectState.trap_dc || objectState.dc || 15,
      label: "Dexterity (Thieves' Tools)",
      tool: 'thieves_tools',
      successResult: `${target.name}'s trap is disarmed.`,
      failureResult: `${target.name}'s trap remains armed.`,
    });
  }

  if (intent.action === 'open' && armedTrap) {
    return {
      handled: true,
      logType: 'object_interaction_trap_blocks_open',
      response: `${target.name} has an established armed trap. Disarm it or describe how you avoid it before opening it. The hinge is not getting a surprise round.`,
    };
  }

  if ((intent.action === 'open' || intent.action === 'unlock') && locked) {
    return objectChallenge({
      type: 'lock',
      action: 'unlock',
      target,
      dc: lockDc(objectState),
      label: "Dexterity (Thieves' Tools)",
      tool: 'thieves_tools',
      successResult: `${target.name} is unlocked.`,
      failureResult: `${target.name} remains locked.`,
    });
  }

  if (intent.action === 'unlock') {
    return {
      handled: true,
      logType: 'object_interaction_not_locked',
      response: `${target.name} is not established as locked. You can open it if it is openable, or inspect it for more detail.`,
    };
  }

  return null;
}

function applyObjectChallengeOutcome({ pending = {}, result = {}, outcome = 'failure', worldState = {} } = {}) {
  if (!pending.object_challenge) return { worldState, lines: [] };

  const key = pending.object_target_key || objectKey(pending.object_target_name);
  const currentObjects = normalizeObjectStates(worldState.object_states);
  const currentEntry = currentObjects[key] || { name: pending.object_target_name };
  const entry = {
    ...currentEntry,
    name: currentEntry.name || pending.object_target_name,
    last_interaction: pending.object_action,
    interaction_history: [
      ...(currentEntry.interaction_history || []),
      {
        action: pending.object_action,
        result: outcome,
        roll_total: result.total,
        dc: pending.dc,
        raw: String(pending.intent || '').slice(0, 180),
      },
    ].slice(-8),
  };
  const success = outcome === 'success';
  const lines = [];

  if (pending.object_challenge_type === 'lock') {
    entry.lock_attempts = {
      ...(currentEntry.lock_attempts || {}),
      successes: Number(currentEntry.lock_attempts?.successes || 0) + (success ? 1 : 0),
      failures: Number(currentEntry.lock_attempts?.failures || 0) + (success ? 0 : 1),
    };
    if (success) {
      entry.locked = false;
      entry.is_locked = false;
      entry.unlocked = true;
      entry.lock = { ...(currentEntry.lock || {}), locked: false, unlocked: true };
      lines.push(`${entry.name} is now unlocked. It can be opened by a later object interaction if nothing else blocks it.`);
    } else {
      entry.locked = true;
      entry.is_locked = true;
      entry.lock = { ...(currentEntry.lock || {}), locked: true };
      lines.push(`${entry.name} remains locked. Another attempt or a different approach is required; sternly glaring at the lock is still not a tool proficiency.`);
    }
  }

  if (pending.object_challenge_type === 'trap') {
    entry.trap_attempts = {
      ...(currentEntry.trap_attempts || {}),
      successes: Number(currentEntry.trap_attempts?.successes || 0) + (success ? 1 : 0),
      failures: Number(currentEntry.trap_attempts?.failures || 0) + (success ? 0 : 1),
    };
    if (success) {
      entry.trapped = false;
      entry.trap_armed = false;
      entry.trap = { ...(currentEntry.trap || {}), armed: false, disarmed: true };
      lines.push(`${entry.name}'s trap is disarmed. The object remains present and can be handled normally unless another rule blocks it.`);
    } else {
      entry.trapped = true;
      entry.trap_armed = true;
      entry.trap = { ...(currentEntry.trap || {}), armed: true };
      lines.push(`${entry.name}'s trap remains armed. The referee has not resolved trap damage or a triggered effect here, so do not narrate one unless another rule supplies it.`);
    }
  }

  return {
    worldState: {
      ...worldState,
      object_states: {
        ...currentObjects,
        [key]: entry,
      },
    },
    lines,
  };
}

function objectChallenge({ type, action, target, dc, label, tool, successResult, failureResult }) {
  return {
    requiresRoll: true,
    type,
    action,
    target: {
      ...target,
      key: objectKey(target.name),
    },
    dc: Number(dc || 15),
    label,
    tool,
    successResult,
    failureResult,
  };
}

function buildObjectInteractionFrame({ intent, target }) {
  const lines = [
    `[OBJECT INTERACTION: The player ${intent.action}s "${target.name}". This target has been verified as ${target.carried ? 'carried by the player' : 'present in the current scene'} and object state has been updated before narration.]`,
  ];
  if (intent.action === 'take') {
    lines.push('[OBJECT INTERACTION: Narrate the character taking the object. It is now carried by the player and should not remain on the ground, board, table, or container unless the narration explicitly duplicates or replaces it.]');
  } else if (intent.action === 'read') {
    lines.push('[OBJECT INTERACTION: Narrate visible text or readable meaning from established scene/campaign facts. Do not invent a rules effect, spell, map shortcut, or secret answer unless already established.]');
  } else if (intent.action === 'open') {
    lines.push('[OBJECT INTERACTION: Narrate the object opening and only reveal contents or access that are plausible from the established scene. If it is locked, trapped, sealed by magic, or requires a check, say so and ask for the needed approach.]');
  } else if (intent.action === 'use') {
    lines.push('[OBJECT INTERACTION: Narrate the mundane use only. Do not grant new magic, flight, telepathy, damage, healing, or a bypass unless the object state, character sheet, or scene already establishes that capability.]');
  }
  return lines.join('\n');
}

function getCarriedObjects(worldState = {}) {
  const listed = Array.isArray(worldState.inventory_state?.carried_objects)
    ? worldState.inventory_state.carried_objects
    : [];
  const objectStateCarried = Object.values(normalizeObjectStates(worldState.object_states))
    .filter((entry) => entry?.carried_by === 'player')
    .map((entry) => ({ name: entry.name, source_location: entry.location || '' }));
  const byKey = new Map();
  for (const item of [...listed, ...objectStateCarried]) {
    if (!item?.name) continue;
    byKey.set(objectKey(item.name), { name: item.name, source_location: item.source_location || '' });
  }
  return [...byKey.values()];
}

function getPresentStateObjects(worldState = {}) {
  return Object.values(normalizeObjectStates(worldState.object_states))
    .filter((entry) => entry?.name && (entry.present === true || entry.carried_by === 'player'));
}

function findSingleChallengeTarget({ intent = {}, worldState = {} } = {}) {
  const candidates = getPresentStateObjects(worldState)
    .filter((entry) => {
      if (intent.action === 'disarm') return Boolean(getKnownArmedTrap(entry));
      if (intent.action === 'unlock') return isLocked(entry);
      return false;
    })
    .map((entry) => ({ name: entry.name, carried: entry.carried_by === 'player', objectState: entry }));
  return candidates.length === 1 ? candidates[0] : null;
}

function objectStateForName(worldState = {}, name = '') {
  const states = normalizeObjectStates(worldState.object_states);
  const direct = states[objectKey(name)];
  if (direct) return direct;
  return Object.values(states).find((entry) => entry?.name && namesMatch(entry.name, name)) || null;
}

function dedupeTargets(candidates = []) {
  const byKey = new Map();
  for (const candidate of candidates) {
    if (!candidate?.name) continue;
    const key = objectKey(candidate.name);
    if (!byKey.has(key)) byKey.set(key, candidate);
    else byKey.set(key, { ...byKey.get(key), ...candidate, objectState: candidate.objectState || byKey.get(key).objectState });
  }
  return [...byKey.values()];
}

function addCarriedObject(inventoryState = {}, item = {}) {
  const existing = Array.isArray(inventoryState?.carried_objects) ? inventoryState.carried_objects : [];
  const byKey = new Map(existing.filter((entry) => entry?.name).map((entry) => [objectKey(entry.name), entry]));
  byKey.set(objectKey(item.name), item);
  return {
    ...(inventoryState && typeof inventoryState === 'object' && !Array.isArray(inventoryState) ? inventoryState : {}),
    carried_objects: [...byKey.values()],
  };
}

function removePresentObject(scenePresence = {}, targetName = '') {
  if (!scenePresence || typeof scenePresence !== 'object') return scenePresence;
  return {
    ...scenePresence,
    present_objects: (scenePresence.present_objects || []).filter((name) => !namesMatch(name, targetName)),
  };
}

function normalizeObjectStates(value = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isLocked(entry = {}) {
  return entry.locked === true || entry.is_locked === true || entry.lock?.locked === true;
}

function lockDc(entry = {}) {
  return Number(entry.lock_dc || entry.lock?.dc || entry.dc || 15);
}

function getKnownArmedTrap(entry = {}) {
  const trap = entry.trap && typeof entry.trap === 'object' && !Array.isArray(entry.trap)
    ? entry.trap
    : null;
  const armed = entry.trap_armed === true
    || entry.trapped === true
    || (trap && trap.armed !== false && trap.disarmed !== true);
  const known = entry.trap_known === true
    || entry.trap_discovered === true
    || entry.trapped === true
    || entry.trap_armed === true
    || trap?.known === true
    || trap?.discovered === true
    || trap?.visible === true;
  return armed && known ? (trap || { dc: entry.trap_dc || entry.dc || 15 }) : null;
}

function cleanTarget(value = '') {
  return String(value || '')
    .replace(/\b(?:the|that|a|an|my|their|his|her|our|carefully|closely|quietly|aloud|again)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function namesMatch(left = '', right = '') {
  const l = normalizeName(left);
  const r = normalizeName(right);
  if (!l || !r) return false;
  return l === r || hasWholePhrase(l, r) || hasWholePhrase(r, l) || singularize(l) === singularize(r);
}

function mentionsName(normalizedMessage = '', name = '') {
  const normalized = normalizeName(name);
  const singular = singularize(normalized);
  return hasWholePhrase(normalizedMessage, normalized) || hasWholePhrase(normalizedMessage, singular);
}

function objectKey(name = '') {
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
  applyObjectChallengeOutcome,
  resolveObjectInteraction,
  resolveObjectChallenge,
  parseObjectInteraction,
  findObjectTarget,
};
