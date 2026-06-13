const { continuePlayerTurn, spendTurnResource } = require('./actionEconomy');
const {
  canMakePlayerOpportunityAttack,
  resolvePlayerOpportunityAttack,
} = require('./playerOpportunityAttackEngine');

function resolveReadyAction({
  message = '',
  worldState = {},
  characterSheet = {},
} = {}) {
  if (!worldState.combat_state?.active) return null;
  if (!isReadyIntent(message)) return null;

  const response = parseReadyResponse(message);
  if (response.type !== 'weapon_attack') {
    return {
      handled: true,
      logType: 'referee_ready_action_unsupported',
      worldState,
      reply: 'Ready is supported for weapon attacks in this pass. Readied spells need their own concentration and slot handling before they get keys to the rules cabinet.',
    };
  }

  const spent = spendTurnResource(worldState, 'action', 'Ready', characterSheet);
  if (!spent.ok) {
    return {
      handled: true,
      logType: 'referee_action_unavailable',
      worldState: spent.worldState,
      reply: spent.reply,
    };
  }

  const readyState = setReadiedAction(spent.worldState, {
    id: `ready_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'weapon_attack',
    trigger_text: parseReadyTrigger(message),
    target_name: parseReadyTarget(message),
    source_message: message,
    created_round: Number(spent.worldState.combat_state?.round || 1),
    expires: 'start_of_player_turn',
  });
  const targetText = readyState.combat_state.turn_resources.readied_action.target_name
    ? ` against ${readyState.combat_state.turn_resources.readied_action.target_name}`
    : '';
  const continued = continuePlayerTurn(
    readyState,
    `You take the **Ready** action and prepare a weapon attack${targetText}. If the trigger happens before your next turn and you still have your Reaction, the referee will resolve the readied attack automatically.`,
    characterSheet,
  );
  return {
    handled: true,
    logType: 'referee_ready_action',
    ...continued,
  };
}

function resolveReadiedActionTrigger({
  worldState = {},
  combat = {},
  player = {},
  actor = {},
  characterSheet = {},
  rollDie,
  trigger = 'creature_turn',
} = {}) {
  const readiedAction = combat.turn_resources?.readied_action;
  if (!readiedAction || readiedAction.type !== 'weapon_attack') {
    return noReadiedAction({ worldState, combat, player, actor });
  }
  if (!targetMatches(readiedAction, actor)) {
    return noReadiedAction({ worldState, combat, player, actor });
  }

  const stateWithCombat = { ...worldState, combat_state: combat };
  if (!canMakePlayerOpportunityAttack({
    worldState: stateWithCombat,
    characterSheet,
    player,
    target: actor,
  })) {
    return noReadiedAction({ worldState, combat, player, actor });
  }

  const spent = spendTurnResource(stateWithCombat, 'reaction', 'Readied attack', characterSheet);
  const cleared = clearReadiedAction(spent.worldState || stateWithCombat);
  if (!spent.ok) {
    return {
      worldState: cleared,
      combat: cleared.combat_state || combat,
      player,
      actor,
      lines: ['Your readied attack trigger occurs, but your Reaction is no longer available, so the readied action is lost. The rules receipt is heartbreaking but valid.'],
      triggered: true,
    };
  }

  const attack = resolvePlayerOpportunityAttack({
    worldState: cleared,
    combat: cleared.combat_state || combat,
    player,
    target: actor,
    characterSheet,
    rollDie,
  });

  return {
    worldState: attack.worldState,
    combat: attack.combat,
    player: attack.player,
    actor: attack.target,
    lines: [
      `**Readied action (${trigger}):** your trigger occurs.`,
      ...attack.lines,
    ],
    triggered: true,
  };
}

function clearReadiedAction(worldState = {}) {
  if (!worldState.combat_state?.active) return worldState;
  const resources = worldState.combat_state.turn_resources || {};
  if (!resources.readied_action) return worldState;
  const { readied_action: _readiedAction, ...rest } = resources;
  return {
    ...worldState,
    combat_state: {
      ...worldState.combat_state,
      turn_resources: rest,
    },
  };
}

function setReadiedAction(worldState = {}, readiedAction = {}) {
  return {
    ...worldState,
    combat_state: {
      ...worldState.combat_state,
      turn_resources: {
        ...(worldState.combat_state?.turn_resources || {}),
        readied_action: readiedAction,
      },
    },
  };
}

function isReadyIntent(message = '') {
  const text = String(message || '');
  return /\b(?:ready|hold|prepare)\b/i.test(text)
    && (/\b(?:action|attack|strike|shot|swing|stab|hit|shoot|loose|fire|spell|cast)\b/i.test(text) || hasWeaponReadyPhrase(text));
}

function parseReadyResponse(message = '') {
  const text = String(message || '');
  if (/\b(?:cast|spell)\b/i.test(text)) return { type: 'spell' };
  if (/\b(?:attack|strike|shot|swing|stab|hit|shoot|loose|fire)\b/i.test(text) || hasWeaponReadyPhrase(text)) {
    return { type: 'weapon_attack' };
  }
  return { type: 'unknown' };
}

function hasWeaponReadyPhrase(message = '') {
  return /\b(?:weapon|shortsword|longsword|dagger|club|mace|quarterstaff|staff|spear|javelin|handaxe|axe|scimitar|rapier|sword|blade|bow|crossbow|sling)\b/i.test(String(message || ''));
}

function parseReadyTrigger(message = '') {
  const text = String(message || '');
  const match = text.match(/\b(?:if|when|whenever|until)\s+(.+)$/i);
  return match?.[1]?.trim() || 'a hostile creature creates the opening';
}

function parseReadyTarget(message = '') {
  const text = String(message || '');
  const explicit = text.match(/\b(?:against|at|on)\s+(?:the\s+|a\s+|an\s+)?([a-z][a-z' -]{1,40}?)(?:\s+(?:if|when|whenever|with|using|that|who|moves?|comes?|gets?|attacks?|approaches?)\b|[,.!?]|$)/i);
  const trigger = text.match(/\b(?:if|when|whenever)\s+(?:the\s+|a\s+|an\s+)?([a-z][a-z' -]{1,40}?)(?:\s+(?:moves?|comes?|gets?|attacks?|approaches?|enters?|leaves?|runs?|flees?)\b|[,.!?]|$)/i);
  return cleanTarget(explicit?.[1] || trigger?.[1]);
}

function targetMatches(readiedAction = {}, actor = {}) {
  const target = normalizeText(readiedAction.target_name);
  if (!target) return true;
  const names = [
    actor.name,
    actor.id,
    ...(actor.aliases || []),
  ].map(normalizeText).filter(Boolean);
  return names.some((name) => name === target || name.includes(target) || target.includes(name));
}

function cleanTarget(value = '') {
  return String(value || '')
    .replace(/\b(?:if|when|whenever|with|using|that|who|moves?|comes?|gets?|attacks?|approaches?|enters?|leaves?|runs?|flees?)\b.*$/i, '')
    .replace(/\b(?:the|a|an|my|their|his|her)\b/gi, '')
    .trim();
}

function noReadiedAction({ worldState, combat, player, actor }) {
  return { worldState, combat, player, actor, lines: [], triggered: false };
}

function normalizeText(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

module.exports = {
  clearReadiedAction,
  resolveReadyAction,
  resolveReadiedActionTrigger,
};
