const { spendTurnResource } = require('./actionEconomy');
const { getContentBundle } = require('./contentData');
const { resolveSpellCast } = require('./spellEffectEngine');
const { getKnownSpellInfo } = require('./spellcastingEngine');

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
  if (!canOfferShieldReaction({ worldState, characterSheet })) return null;

  return {
    id: `reaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'player_reaction',
    trigger: 'attack_hit',
    trigger_label: `${actor.name || 'Creature'}'s ${attack.name || 'attack'}`,
    options: [{
      id: 'shield',
      type: 'cast_spell',
      spell_id: 'shield',
      label: 'Cast Shield',
    }],
    attack_frame: {
      attack,
      attack_roll: attackRoll,
      attack_total: Number(attackTotal || 0),
      ac_before: Number(ac || 10),
      roll_text: rollText,
      mode_text: modeText,
      critical_hit: Boolean(criticalHit),
    },
  };
}

function canOfferShieldReaction({ worldState = {}, characterSheet = {} } = {}) {
  if (!worldState.combat_state?.active) return false;
  if (worldState.combat_state.turn_resources?.reaction_available === false) return false;
  if ((worldState.active_effects || []).some((effect) => effect.id === 'shield')) return false;

  const shield = getShieldSpell();
  if (!shield || !getKnownSpellInfo(characterSheet, shield).known) return false;
  return Number(getAuthoritativeSpellSlots(worldState, characterSheet)[String(shield.level)] || 0) > 0;
}

function resolvePendingReactionChoice({ message = '', worldState = {}, characterSheet = {} } = {}) {
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
      reply: 'You decline the Reaction. The interrupted attack continues.',
    };
  }

  if (choice === 'shield') {
    return castShieldReaction({ worldState, characterSheet, pendingReaction });
  }

  return null;
}

function castShieldReaction({ worldState = {}, characterSheet = {}, pendingReaction } = {}) {
  const spent = spendTurnResource(worldState, 'reaction', 'Shield', characterSheet);
  if (!spent.ok) {
    return {
      handled: true,
      resolved: false,
      logType: 'referee_reaction_unavailable',
      pendingReaction,
      worldState,
      reply: `${spent.reply}\n\n${formatPendingReactionPrompt(pendingReaction)}`,
    };
  }

  const spellCast = resolveSpellCast({
    message: 'I cast Shield.',
    content: getContentBundle(),
    characterSheet: withAuthoritativeSpellSlots(characterSheet, spent.worldState),
    worldState: spent.worldState,
  });
  if (!spellCast || spellCast.blocked) {
    return {
      handled: true,
      resolved: false,
      logType: 'referee_reaction_unavailable',
      pendingReaction,
      worldState,
      reply: `${spellCast?.reply || 'Shield cannot be cast for this trigger.'}\n\n${formatPendingReactionPrompt(pendingReaction)}`,
    };
  }

  return {
    handled: true,
    resolved: true,
    logType: 'referee_reaction_shield',
    pendingReaction,
    worldState: {
      ...spellCast.worldState,
      pending_reaction: null,
    },
    reply: 'You spend your **Reaction** and cast **Shield**. Your AC rises by 5 until the start of your next turn, including against the interrupted attack.',
  };
}

function parsePendingReactionChoice(message = '', pendingReaction = {}) {
  const text = String(message || '').trim();
  if (/\b(?:decline|skip|pass|no|do not|don't)\b/i.test(text)) return 'decline';
  if (
    pendingReaction.options?.some((option) => option.id === 'shield')
    && /\b(?:(?:cast|use)\s+(?:my\s+)?shield|shield)\b/i.test(text)
  ) {
    return 'shield';
  }
  return null;
}

function formatPendingReactionPrompt(pendingReaction = {}) {
  const optionLabels = (pendingReaction.options || []).map((option) => `**${option.label}**`);
  const choices = optionLabels.length ? optionLabels.join(' or ') : '**decline reaction**';
  return `**Reaction window:** ${pendingReaction.trigger_label || 'An attack'} would hit. Choose ${choices}, or say **decline reaction**. The interrupted attack is waiting politely, which is unusual but rules-compliant.`;
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

function getShieldSpell() {
  return getContentBundle().spells.find((spell) => spell.id === 'shield') || null;
}

module.exports = {
  buildAttackHitReaction,
  canOfferShieldReaction,
  formatPendingReactionPrompt,
  resolvePendingReactionChoice,
};
