const RESOURCE_KEYS = {
  action: 'action_available',
  bonus_action: 'bonus_action_available',
  reaction: 'reaction_available',
};

const { applyConditionSpeedPenalty } = require('./conditionEngine');

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

function spendTurnResource(worldState = {}, resource, label = 'that action', characterSheet = {}, options = {}) {
  if (!resource || !worldState.combat_state?.active) {
    return { ok: true, worldState };
  }

  if (!RESOURCE_KEYS[resource]) {
    return { ok: true, worldState };
  }

  const readyState = ensureTurnResources(worldState, characterSheet);
  const resources = readyState.combat_state.turn_resources;
  if (resource === 'action' && !resources.action_available && resources.extra_action_available) {
    if (options.actionType === 'magic') {
      return {
        ok: false,
        worldState: readyState,
        reply: 'Action Surge grants an extra action, but that extra action cannot be the Magic action. Use it for a non-Magic action, or save the spell for a regular action.',
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
            extra_action_available: false,
            used: [
              ...(resources.used || []),
              {
                resource,
                label,
                source: 'Action Surge',
              },
            ],
          },
        },
      },
    };
  }

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

function grantActionSurgeAction(worldState = {}, characterSheet = {}) {
  if (!worldState.combat_state?.active) {
    return {
      ok: false,
      worldState,
      reply: 'Action Surge matters during your turn in combat. Outside combat, the world is already letting you act without counting every heartbeat.',
    };
  }

  const readyState = ensureTurnResources(worldState, characterSheet);
  const resources = readyState.combat_state.turn_resources;
  if (resources.extra_action_available) {
    return {
      ok: false,
      worldState: readyState,
      reply: 'Action Surge is already granting an extra action this turn. Use that one before trying to stack more tactical enthusiasm on top.',
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
          extra_action_available: true,
          used: [
            ...(resources.used || []),
            {
              resource: 'action_surge',
              label: 'Action Surge',
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

function grantMovement(worldState = {}, feet, label = 'Dash', characterSheet = {}) {
  if (!worldState.combat_state?.active) return { ok: true, worldState };

  const readyState = ensureTurnResources(worldState, characterSheet);
  const resources = readyState.combat_state.turn_resources;
  const granted = Math.max(0, Number(feet || 0));
  return {
    ok: true,
    worldState: {
      ...readyState,
      combat_state: {
        ...readyState.combat_state,
        turn_resources: {
          ...resources,
          movement_remaining: Number(resources.movement_remaining || 0) + granted,
          used: [
            ...(resources.used || []),
            {
              resource: 'movement_grant',
              label,
              feet: granted,
            },
          ],
        },
      },
    },
  };
}

function setTurnFlag(worldState = {}, flag, value = true, characterSheet = {}) {
  if (!flag || !worldState.combat_state?.active) return worldState;

  const readyState = ensureTurnResources(worldState, characterSheet);
  return {
    ...readyState,
    combat_state: {
      ...readyState.combat_state,
      turn_resources: {
        ...readyState.combat_state.turn_resources,
        [flag]: value,
      },
    },
  };
}

function continuePlayerTurn(worldState = {}, reply = '', characterSheet = {}) {
  if (!worldState.combat_state?.active || worldState.pending_roll || worldState.pending_reaction) {
    return { worldState, reply };
  }

  const readyState = ensureTurnResources(worldState, characterSheet);
  const available = describeAvailableResources(readyState.combat_state.turn_resources);
  return {
    worldState: readyState,
    reply: `${reply}\n\n**Your turn remains open.** Available now: ${available}. Use another available option, or say **end turn** when you are finished.`,
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
  if (resources.extra_action_available) available.push('Action Surge action');
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
    extra_action_available: false,
    bonus_action_available: true,
    reaction_available: true,
    movement_remaining: getSpeed(characterSheet, worldState),
    used: [],
  };
}

function getSpeed(characterSheet = {}, worldState = {}) {
  const baseSpeed = Number(
    worldState.player_stats?.speed
      ?? characterSheet.derived_stats?.speed
      ?? 30,
  );
  return applyConditionSpeedPenalty(baseSpeed, getPlayerConditionSubject(characterSheet, worldState));
}

function getPlayerConditionSubject(characterSheet = {}, worldState = {}) {
  return {
    conditions: [
      ...(characterSheet.derived_stats?.conditions || []),
      ...(worldState.player_stats?.conditions || []),
    ],
    exhaustion_level: worldState.player_stats?.exhaustion_level ?? characterSheet.derived_stats?.exhaustion_level,
  };
}

module.exports = {
  beginPlayerTurn,
  continuePlayerTurn,
  describeAvailableResources,
  ensureTurnResources,
  grantActionSurgeAction,
  spendTurnResource,
  spendMovement,
  grantMovement,
  getSpellActionResource,
  setTurnFlag,
};
