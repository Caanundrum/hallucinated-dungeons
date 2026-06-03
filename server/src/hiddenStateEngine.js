function isHideActionCheck(pending = {}) {
  if (pending.rule_action === 'hide') return true;
  if (pending.skill !== 'stealth') return false;
  return /\b(?:hide|sneak|stealth|blend into shadows|avoid notice)\b/i.test(String(pending.intent || ''));
}

function applyHideCheckOutcome({
  pending = {},
  result = {},
  outcome = '',
  worldState = {},
  characterSheet = {},
} = {}) {
  if (!worldState.combat_state?.active || !isHideActionCheck(pending)) {
    return { worldState, lines: [] };
  }
  if (outcome !== 'success') {
    return {
      worldState,
      lines: ['**Hide:** you are not hidden. Anyone tracking the fight can still follow you. Very rude of visibility, but legally sound.'],
    };
  }

  const hiddenState = {
    active: true,
    source: 'Hide',
    check_total: Number(result.total || 0),
    dc: Number(pending.dc || 15),
    round: Number(worldState.combat_state.round || 1),
    ends_on: ['attack', 'spell', 'loud noise', 'loss of cover'],
  };
  const nextState = setPlayerHidden(worldState, hiddenState, characterSheet);
  return {
    worldState: nextState,
    lines: [`**Hidden:** you are concealed from enemies that do not already have a clean way to perceive you. Your attacks have Advantage while this lasts, and attacks against you have Disadvantage until you reveal yourself.`],
  };
}

function setPlayerHidden(worldState = {}, hiddenState = {}, characterSheet = {}) {
  if (!worldState.combat_state?.active) return worldState;
  const combat = cloneCombat(worldState.combat_state);
  const playerIndex = combat.combatants.findIndex((combatant) => combatant.is_player);
  if (playerIndex < 0) return worldState;

  const player = combat.combatants[playerIndex];
  combat.combatants[playerIndex] = {
    ...player,
    conditions: addCondition(player.conditions, 'hidden'),
    hidden_state: hiddenState,
  };

  return {
    ...worldState,
    combat_state: combat,
    player_stats: {
      ...(worldState.player_stats || {}),
      hidden: hiddenState,
    },
  };
}

function clearPlayerHidden({ worldState = {}, reason = 'revealed' } = {}) {
  if (!worldState.combat_state?.active) {
    return { worldState, combat: worldState.combat_state || null, revealed: false, line: '' };
  }

  const combat = cloneCombat(worldState.combat_state);
  const playerIndex = combat.combatants.findIndex((combatant) => combatant.is_player);
  if (playerIndex < 0) {
    return { worldState, combat, revealed: false, line: '' };
  }

  const player = combat.combatants[playerIndex];
  if (!isHidden(player, worldState)) {
    return { worldState, combat, revealed: false, line: '' };
  }

  const { hidden_state: _hiddenState, ...restPlayer } = player;
  combat.combatants[playerIndex] = {
    ...restPlayer,
    conditions: removeCondition(player.conditions, 'hidden'),
  };
  const { hidden: _hidden, ...restPlayerStats } = worldState.player_stats || {};
  const nextState = {
    ...worldState,
    combat_state: combat,
    player_stats: restPlayerStats,
  };

  return {
    worldState: nextState,
    combat,
    revealed: true,
    line: `**Hidden ends:** ${formatRevealReason(reason)}.`,
  };
}

function isHidden(player = {}, worldState = {}) {
  return (player.conditions || []).map(normalizeCondition).includes('hidden')
    || Boolean(player.hidden_state?.active)
    || Boolean(worldState.player_stats?.hidden?.active);
}

function addCondition(conditions = [], condition) {
  return [...new Set([...(conditions || []), condition].filter(Boolean))];
}

function removeCondition(conditions = [], condition) {
  const target = normalizeCondition(condition);
  return (conditions || []).filter((entry) => normalizeCondition(entry) !== target);
}

function normalizeCondition(value = '') {
  return String(value || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
}

function formatRevealReason(reason = '') {
  const normalized = String(reason || '').toLowerCase();
  if (normalized === 'attack') return 'you reveal yourself by attacking';
  if (normalized === 'spell') return 'you reveal yourself by casting a spell';
  if (normalized === 'failed_hide') return 'the Hide attempt fails to conceal you';
  return 'you reveal yourself';
}

function cloneCombat(combat = {}) {
  return JSON.parse(JSON.stringify(combat || { active: true, combatants: [] }));
}

module.exports = {
  applyHideCheckOutcome,
  clearPlayerHidden,
  isHideActionCheck,
};
