const { spendTurnResource } = require('./actionEconomy');
const { getCombatantDistanceFeet } = require('./combatPositionEngine');
const { getContentBundle } = require('./contentData');
const { resolveSpellCast, resolveSpellOutcome } = require('./spellEffectEngine');
const { getKnownSpellInfo } = require('./spellcastingEngine');

const REACTION_DEFINITIONS = {
  shield: {
    id: 'shield',
    trigger: 'attack_hit',
    spellId: 'shield',
    label: 'Cast Shield',
    canOffer({ worldState }) {
      return !(worldState.active_effects || []).some((effect) => effect.id === 'shield');
    },
    reply: 'You spend your **Reaction** and cast **Shield**. Your AC rises by 5 until the start of your next turn, including against the interrupted attack.',
  },
  hellish_rebuke: {
    id: 'hellish_rebuke',
    trigger: 'damage_taken',
    spellId: 'hellish_rebuke',
    label: 'Cast Hellish Rebuke',
    resolveOutcome: true,
    canOffer({ context }) {
      const actor = context.actor || {};
      const distance = getCombatantDistanceFeet(context.player || {}, actor);
      return Number(context.damageTaken || 0) > 0
        && !actor.is_player
        && Number(actor.hp || 0) > 0
        && actor.visible !== false
        && (distance === null || distance <= 60);
    },
  },
};

function buildAttackHitReaction({
  actor = {},
  attack = {},
  attackRoll = {},
  attackTotal = 0,
  ac = 10,
  rollText = '',
  modeText = '',
  criticalHit = false,
  worldState = {},
  characterSheet = {},
} = {}) {
  return buildReactionWindow({
    trigger: 'attack_hit',
    triggerLabel: `${actor.name || 'Creature'}'s ${attack.name || 'attack'}`,
    triggerPrompt: `${actor.name || 'A creature'}'s ${attack.name || 'attack'} would hit.`,
    worldState,
    characterSheet,
    context: { actor, attack },
    extra: {
      attack_frame: {
        attack,
        attack_roll: attackRoll,
        attack_total: Number(attackTotal || 0),
        ac_before: Number(ac || 10),
        roll_text: rollText,
        mode_text: modeText,
        critical_hit: Boolean(criticalHit),
      },
    },
  });
}

function buildDamageTakenReaction({
  actor = {},
  attack = {},
  player = {},
  damageTaken = 0,
  worldState = {},
  characterSheet = {},
} = {}) {
  return buildReactionWindow({
    trigger: 'damage_taken',
    triggerLabel: `${actor.name || 'Creature'}'s ${attack.name || 'attack'}`,
    triggerPrompt: `${actor.name || 'A creature'} dealt ${Number(damageTaken || 0)} damage.`,
    resumeStage: 'after_attack',
    worldState,
    characterSheet,
    context: {
      actor,
      attack,
      player,
      damageTaken: Number(damageTaken || 0),
    },
    extra: {
      source_actor: {
        id: actor.id || null,
        name: actor.name || 'Creature',
      },
    },
  });
}

function buildReactionWindow({
  trigger,
  triggerLabel,
  triggerPrompt,
  resumeStage = 'before_attack',
  worldState = {},
  characterSheet = {},
  context = {},
  extra = {},
} = {}) {
  const options = getReactionOptions({ trigger, worldState, characterSheet, context });
  if (options.length === 0) return null;

  return {
    id: `reaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'player_reaction',
    trigger,
    trigger_label: triggerLabel,
    trigger_prompt: triggerPrompt,
    resume_stage: resumeStage,
    options,
    ...extra,
  };
}

function getReactionOptions({ trigger, worldState = {}, characterSheet = {}, context = {} } = {}) {
  return Object.values(REACTION_DEFINITIONS)
    .filter((definition) => definition.trigger === trigger)
    .filter((definition) => canOfferReaction({ definition, worldState, characterSheet, context }))
    .map((definition) => ({
      id: definition.id,
      reaction_id: definition.id,
      type: 'cast_spell',
      spell_id: definition.spellId,
      label: definition.label,
    }));
}

function canOfferReaction({ definition, worldState = {}, characterSheet = {}, context = {} } = {}) {
  if (!definition || !worldState.combat_state?.active) return false;
  if (worldState.combat_state.turn_resources?.reaction_available === false) return false;
  const spell = getReactionSpell(definition);
  if (!spell || !getKnownSpellInfo(characterSheet, spell).known) return false;
  if (Number(getAuthoritativeSpellSlots(worldState, characterSheet)[String(spell.level)] || 0) <= 0) return false;
  return definition.canOffer ? definition.canOffer({ worldState, characterSheet, context, spell }) : true;
}

function canOfferShieldReaction({ worldState = {}, characterSheet = {} } = {}) {
  return canOfferReaction({
    definition: REACTION_DEFINITIONS.shield,
    worldState,
    characterSheet,
  });
}

function resolvePendingReactionChoice({
  message = '',
  worldState = {},
  characterSheet = {},
  rollDie,
} = {}) {
  const pendingReaction = worldState.pending_reaction;
  if (!pendingReaction) return null;

  const choice = parsePendingReactionChoice(message, pendingReaction);
  if (!choice) {
    return {
      handled: true,
      resolved: false,
      logType: 'referee_reaction_required',
      pendingReaction,
      worldState,
      reply: formatPendingReactionPrompt(pendingReaction),
    };
  }

  if (choice === 'decline') {
    return {
      handled: true,
      resolved: true,
      logType: 'referee_reaction_declined',
      pendingReaction,
      worldState: {
        ...worldState,
        pending_reaction: null,
      },
      reply: 'You decline the Reaction. The interrupted action continues.',
    };
  }

  const option = pendingReaction.options?.find((entry) => entry.id === choice);
  if (option?.type === 'cast_spell') {
    return castSpellReaction({ option, worldState, characterSheet, pendingReaction, rollDie });
  }

  return null;
}

function castSpellReaction({
  option = {},
  worldState = {},
  characterSheet = {},
  pendingReaction,
  rollDie,
} = {}) {
  const definition = REACTION_DEFINITIONS[option.reaction_id || option.id];
  const spell = getReactionSpell(definition);
  if (!definition || !spell) return unavailableReaction({ worldState, pendingReaction });

  const spent = spendTurnResource(worldState, 'reaction', spell.name, characterSheet);
  if (!spent.ok) {
    return unavailableReaction({ worldState, pendingReaction, reply: spent.reply });
  }

  const spellCast = resolveSpellCast({
    message: `I cast ${spell.name}.`,
    content: getContentBundle(),
    characterSheet: withAuthoritativeSpellSlots(characterSheet, spent.worldState),
    worldState: spent.worldState,
  });
  if (!spellCast || spellCast.blocked) {
    return unavailableReaction({
      worldState,
      pendingReaction,
      reply: spellCast?.reply || `${spell.name} cannot be cast for this trigger.`,
    });
  }

  let nextWorldState = {
    ...spellCast.worldState,
    pending_reaction: null,
  };
  let reply = definition.reply || `You spend your **Reaction** and cast **${spell.name}**.`;
  if (definition.resolveOutcome) {
    const outcome = resolveSpellOutcome({
      spellCast,
      characterSheet: spellCast.characterSheet,
      worldState: {
        ...nextWorldState,
        __preserve_combat_state: true,
        __spell_target_id: pendingReaction.source_actor?.id || null,
        __spell_target_name: pendingReaction.source_actor?.name || null,
      },
      rollDie,
    });
    if (!outcome) {
      return unavailableReaction({
        worldState,
        pendingReaction,
        reply: `${spell.name} could not resolve its triggered effect.`,
      });
    }
    nextWorldState = outcome.worldState;
    reply = `${reply}\n\n${outcome.reply}`;
  }

  return {
    handled: true,
    resolved: true,
    logType: `referee_reaction_${definition.id}`,
    pendingReaction,
    worldState: nextWorldState,
    reply,
  };
}

function unavailableReaction({ worldState, pendingReaction, reply = 'That Reaction is not available.' } = {}) {
  return {
    handled: true,
    resolved: false,
    logType: 'referee_reaction_unavailable',
    pendingReaction,
    worldState,
    reply: `${reply}\n\n${formatPendingReactionPrompt(pendingReaction)}`,
  };
}

function parsePendingReactionChoice(message = '', pendingReaction = {}) {
  const text = String(message || '').trim();
  if (/\b(?:decline|skip|pass|no|do not|don't)\b/i.test(text)) return 'decline';
  const normalized = normalizeText(text);
  const option = pendingReaction.options?.find((entry) => (
    [entry.id, entry.spell_id, entry.label]
      .map(normalizeText)
      .filter(Boolean)
      .some((candidate) => normalized.includes(candidate.replace(/^cast /, '')))
  ));
  return option?.id || null;
}

function formatPendingReactionPrompt(pendingReaction = {}) {
  const optionLabels = (pendingReaction.options || []).map((option) => `**${option.label}**`);
  const choices = optionLabels.length ? optionLabels.join(' or ') : '**decline reaction**';
  const trigger = pendingReaction.trigger_prompt || `${pendingReaction.trigger_label || 'An attack'} would hit.`;
  return `**Reaction window:** ${trigger} Choose ${choices}, or say **decline reaction**. The interrupted action is waiting politely, which is unusual but rules-compliant.`;
}

function withAuthoritativeSpellSlots(characterSheet = {}, worldState = {}) {
  return {
    ...characterSheet,
    spellcasting: {
      ...(characterSheet.spellcasting || {}),
      slots: {
        ...(characterSheet.spellcasting?.slots || {}),
        ...getAuthoritativeSpellSlots(worldState, characterSheet),
      },
    },
  };
}

function getAuthoritativeSpellSlots(worldState = {}, characterSheet = {}) {
  const worldSlots = worldState.player_stats?.spell_slots;
  return worldSlots && Object.keys(worldSlots).length > 0
    ? worldSlots
    : characterSheet.spellcasting?.slots || {};
}

function getReactionSpell(definition = {}) {
  return getContentBundle().spells.find((spell) => spell.id === definition.spellId) || null;
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

module.exports = {
  buildAttackHitReaction,
  buildDamageTakenReaction,
  canOfferShieldReaction,
  formatPendingReactionPrompt,
  getReactionOptions,
  resolvePendingReactionChoice,
};
