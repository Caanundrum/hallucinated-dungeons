const RESOURCE_KEYS = {
  action: 'action_available',
  bonus_action: 'bonus_action_available',
  reaction: 'reaction_available',
};

const RESOURCE_LABELS = {
  action: 'Action',
  bonus_action: 'Bonus Action',
  reaction: 'Reaction',
};

function ensureTurnResources(worldState = {}, characterSheet = {}) {
  const combat = worldState.combat_state;
  if (!combat?.active) return worldState;

  const existing = combat.turn_resources || {};
  const fresh = buildFreshTurnResources(characterSheet, worldState);
  return {
    ...worldState,
    combat_state: {
      ...combat,
      turn_resources: {
        ...fresh,
        ...existing,
        used: Array.isArray(existing.used) ? existing.used : [],
      },
    },
  };
}

function beginPlayerTurn(worldState = {}, characterSheet = {}) {
  const combat = worldState.combat_state;
  if (!combat?.active) return worldState;

  return {
    ...worldState,
    combat_state: {
      ...combat,
      turn_resources: buildFreshTurnResources(characterSheet, worldState),
    },
  };
}

function spendTurnResource(worldState = {}, resource, label = 'that action', characterSheet = {}) {
  if (!resource || !worldState.combat_state?.active) {
    return { ok: true, worldState };
  }

  if (!RESOURCE_KEYS[resource]) {
    return { ok: true, worldState };
  }

  const readyState = ensureTurnResources(worldState, characterSheet);
  const resources = readyState.combat_state.turn_resources;
  const key = RESOURCE_KEYS[resource];
  if (!resources[key]) {
    const resourceLabel = RESOURCE_LABELS[resource] || resource;
    return {
      ok: false,
      worldState: readyState,
      reply: `Your ${resourceLabel} is already spent this turn, so ${label} has to wait. Available now: ${describeAvailableResources(resources)}. The action economy is a tiny accountant with a very sharp pencil.`,
    };
  }

  return {
    ok: true,
    worldState: {
      ...readyState,
      combat_state: {
        ...readyState.combat_state,
        turn_resources: {
          ...resources,
          [key]: false,
          used: [
            ...(resources.used || []),
            {
              resource,
              label,
            },
          ],
        },
      },
    },
  };
}

function spendMovement(worldState = {}, feet, label = 'movement', characterSheet = {}) {
  if (!worldState.combat_state?.active) return { ok: true, worldState };

  const readyState = ensureTurnResources(worldState, characterSheet);
  const resources = readyState.combat_state.turn_resources;
  const requested = Math.max(0, Number(feet || 0));
  const remaining = Number(resources.movement_remaining || 0);
  if (requested > remaining) {
    return {
      ok: false,
      worldState: readyState,
      reply: `You only have ${remaining} ft of movement left this turn, so ${label} needs a shorter path, a Dash, or a very persuasive floor plan.`,
    };
  }

  return {
    ok: true,
    worldState: {
      ...readyState,
      combat_state: {
        ...readyState.combat_state,
        turn_resources: {
          ...resources,
          movement_remaining: remaining - requested,
          used: [
            ...(resources.used || []),
            {
              resource: 'movement',
              label,
              feet: requested,
            },
          ],
        },
      },
    },
  };
}

function getSpellActionResource(spell = {}) {
  const castingTime = String(spell.casting_time || '').toLowerCase().trim();
  if (!castingTime) return null;
  if (/\breaction\b/.test(castingTime)) return 'reaction';
  if (/\bbonus\s+action\b/.test(castingTime)) return 'bonus_action';
  if (/^action$/.test(castingTime) || /\baction\b/.test(castingTime)) return 'action';
  return null;
}

function describeAvailableResources(resources = {}) {
  const available = [];
  if (resources.action_available) available.push('Action');
  if (resources.bonus_action_available) available.push('Bonus Action');
  if (resources.reaction_available) available.push('Reaction');
  if (Number(resources.movement_remaining || 0) > 0) {
    available.push(`${Number(resources.movement_remaining)} ft movement`);
  }
  return available.length ? available.join(', ') : 'no major combat resources';
}

function buildFreshTurnResources(characterSheet = {}, worldState = {}) {
  return {
    actor: 'player',
    action_available: true,
    bonus_action_available: true,
    reaction_available: true,
    movement_remaining: getSpeed(characterSheet, worldState),
    used: [],
  };
}

function getSpeed(characterSheet = {}, worldState = {}) {
  return Number(
    worldState.player_stats?.speed
      ?? characterSheet.derived_stats?.speed
      ?? 30,
  );
}

module.exports = {
  beginPlayerTurn,
  spendTurnResource,
  spendMovement,
  getSpellActionResource,
};
