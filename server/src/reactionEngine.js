const { spendTurnResource } = require('./actionEconomy');
const { getCombatantDistanceFeet } = require('./combatPositionEngine');
const { getContentBundle } = require('./contentData');
const { canMakePlayerOpportunityAttack } = require('./playerOpportunityAttackEngine');
const { resolveSavingThrow } = require('./conditionEngine');
const { applyDamage, rollDamageFormula } = require('./damageHealingEngine');
const { resolveSpellCast, resolveSpellOutcome } = require('./spellEffectEngine');
const { getKnownSpellInfo } = require('./spellcastingEngine');
const {
  buildResourceState,
  spendResource,
} = require('./resourceEngine');
const {
  REACTION_RESUME_STAGES,
  REACTION_TRIGGERS,
  buildPendingReactionWindow,
  defineReactionDefinition,
} = require('./refereeContracts');
const { isLoreBard } = require('./subclassFeatureEngine');

const REACTION_DEFINITIONS = {
  shield: defineReactionDefinition({
    id: 'shield',
    trigger: REACTION_TRIGGERS.ATTACK_HIT,
    spellId: 'shield',
    label: 'Cast Shield',
    canOffer({ worldState }) {
      return !(worldState.active_effects || []).some((effect) => effect.id === 'shield');
    },
    reply: 'You spend your **Reaction** and cast **Shield**. Your AC rises by 5 until the start of your next turn, including against the interrupted attack.',
  }),
  hellish_rebuke: defineReactionDefinition({
    id: 'hellish_rebuke',
    trigger: REACTION_TRIGGERS.DAMAGE_TAKEN,
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
  }),
  cutting_words: defineReactionDefinition({
    id: 'cutting_words',
    trigger: REACTION_TRIGGERS.ATTACK_HIT,
    label: 'Use Cutting Words',
    optionType: 'feature_reaction',
    canOffer({ characterSheet }) {
      return isLoreBard(characterSheet) && getCharacterLevel(characterSheet) >= 3;
    },
  }),
  cutting_words_damage: defineReactionDefinition({
    id: 'cutting_words_damage',
    trigger: REACTION_TRIGGERS.DAMAGE_TAKEN,
    label: 'Use Cutting Words on Damage',
    aliases: ['Cutting Words', 'Cutting Words on the damage'],
    optionType: 'feature_reaction',
    canOffer({ context, characterSheet }) {
      return isLoreBard(characterSheet)
        && getCharacterLevel(characterSheet) >= 3
        && Number(context.damageTaken || 0) > 0;
    },
  }),
  deflect_attacks: defineReactionDefinition({
    id: 'deflect_attacks',
    trigger: REACTION_TRIGGERS.DAMAGE_TAKEN,
    label: 'Use Deflect Attacks',
    optionType: 'feature_reaction',
    canOffer({ context, characterSheet }) {
      const type = normalizeText(context.attack?.damage_type || context.attack?.damageType || 'physical');
      return normalizeText(characterSheet.identity?.class) === 'monk'
        && getCharacterLevel(characterSheet) >= 3
        && Number(context.damageTaken || 0) > 0
        && ['physical', 'bludgeoning', 'piercing', 'slashing', ''].includes(type);
    },
  }),
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
    trigger: REACTION_TRIGGERS.ATTACK_HIT,
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
    trigger: REACTION_TRIGGERS.DAMAGE_TAKEN,
    triggerLabel: `${actor.name || 'Creature'}'s ${attack.name || 'attack'}`,
    triggerPrompt: `${actor.name || 'A creature'} dealt ${Number(damageTaken || 0)} damage.`,
    resumeStage: REACTION_RESUME_STAGES.AFTER_ATTACK,
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
      damage_frame: {
        damage_taken: Number(damageTaken || 0),
        player_before_reaction: player,
        attack,
      },
    },
  });
}

function buildCreatureLeavesReachReaction({
  actor = {},
  player = {},
  movement = {},
  worldState = {},
  characterSheet = {},
} = {}) {
  if (!canMakePlayerOpportunityAttack({ worldState, characterSheet, player, target: actor })) return null;
  return buildPendingReactionWindow({
    trigger: REACTION_TRIGGERS.CREATURE_LEAVES_REACH,
    triggerLabel: `${actor.name || 'Creature'} leaves your reach`,
    triggerPrompt: `${actor.name || 'A creature'} is leaving your reach.`,
    resumeStage: REACTION_RESUME_STAGES.BEFORE_MOVEMENT,
    options: [{
      id: 'opportunity_attack',
      reaction_id: 'opportunity_attack',
      type: 'weapon_attack',
      label: 'Make Opportunity Attack',
    }],
    source_actor: {
      id: actor.id || null,
      name: actor.name || 'Creature',
    },
    movement_frame: movement,
  });
}

function buildReactionWindow({
  trigger,
  triggerLabel,
  triggerPrompt,
  resumeStage = REACTION_RESUME_STAGES.BEFORE_ATTACK,
  worldState = {},
  characterSheet = {},
  context = {},
  extra = {},
} = {}) {
  const options = getReactionOptions({ trigger, worldState, characterSheet, context });
  if (options.length === 0) return null;

  return buildPendingReactionWindow({
    trigger,
    triggerLabel,
    triggerPrompt,
    resumeStage,
    options,
    ...extra,
  });
}

function getReactionOptions({ trigger, worldState = {}, characterSheet = {}, context = {} } = {}) {
  return Object.values(REACTION_DEFINITIONS)
    .filter((definition) => definition.trigger === trigger)
    .filter((definition) => canOfferReaction({ definition, worldState, characterSheet, context }))
    .map((definition) => ({
      id: definition.id,
      reaction_id: definition.id,
      type: definition.optionType || 'cast_spell',
      spell_id: definition.spellId,
      label: definition.label,
      aliases: definition.aliases || [],
    }));
}

function canOfferReaction({ definition, worldState = {}, characterSheet = {}, context = {} } = {}) {
  if (!definition || !worldState.combat_state?.active) return false;
  if (worldState.combat_state.turn_resources?.reaction_available === false) return false;
  const spell = definition.spellId ? getReactionSpell(definition) : null;
  if (definition.spellId && (!spell || !getKnownSpellInfo(characterSheet, spell).known)) return false;
  if (spell && Number(getAuthoritativeSpellSlots(worldState, characterSheet)[String(spell.level)] || 0) <= 0) return false;
  if (definition.id.startsWith('cutting_words') && Number(buildResourceState(characterSheet, worldState).bardic_inspiration?.remaining || 0) <= 0) return false;
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

  if (option?.type === 'weapon_attack') {
    return spendWeaponReaction({ option, worldState, characterSheet, pendingReaction });
  }

  if (option?.type === 'feature_reaction') {
    return resolveFeatureReaction({ option, message, worldState, characterSheet, pendingReaction, rollDie });
  }

  return null;
}

function resolveFeatureReaction({ option = {}, message = '', worldState = {}, characterSheet = {}, pendingReaction = {}, rollDie }) {
  const spentReaction = spendTurnResource(worldState, 'reaction', option.label, characterSheet);
  if (!spentReaction.ok) return unavailableReaction({ worldState, pendingReaction, reply: spentReaction.reply });

  if (option.id === 'cutting_words') {
    const spent = spendResource({ worldState: spentReaction.worldState, characterSheet, resource: 'bardic_inspiration' });
    if (!spent.ok) return unavailableReaction({ worldState, pendingReaction, reply: 'Cutting Words needs a Bardic Inspiration use.' });
    const reduction = rollDie(6);
    const frame = { ...(pendingReaction.attack_frame || {}) };
    frame.attack_total = Number(frame.attack_total || 0) - reduction;
    frame.roll_text = `${frame.roll_text || 'attack'} - ${reduction} Cutting Words`;
    return {
      handled: true, resolved: true, logType: 'referee_reaction_cutting_words',
      pendingReaction: { ...pendingReaction, chosen_option: option, attack_frame: frame },
      worldState: { ...spent.worldState, pending_reaction: null },
      reply: `You spend your **Reaction** and one Bardic Inspiration use for **Cutting Words**. The attack roll is reduced by ${reduction}.`,
    };
  }

  if (option.id === 'cutting_words_damage') {
    const spent = spendResource({ worldState: spentReaction.worldState, characterSheet, resource: 'bardic_inspiration' });
    if (!spent.ok) return unavailableReaction({ worldState, pendingReaction, reply: 'Cutting Words needs a Bardic Inspiration use.' });
    const damageTaken = Number(pendingReaction.damage_frame?.damage_taken || 0);
    const reductionRoll = rollDie(6);
    const prevented = Math.min(damageTaken, reductionRoll);
    const combat = clone(spent.worldState.combat_state || {});
    const player = (combat.combatants || []).find((entry) => entry.is_player);
    if (player) player.hp = Math.min(Number(player.max_hp || player.hp || 0), Number(player.hp || 0) + prevented);
    const currentHp = Number(spent.worldState.player_stats?.hp || 0);
    const maxHp = Number(spent.worldState.player_stats?.max_hp || characterSheet.derived_stats?.max_hp || currentHp + prevented);
    return {
      handled: true,
      resolved: true,
      logType: 'referee_reaction_cutting_words_damage',
      pendingReaction: { ...pendingReaction, chosen_option: option },
      worldState: {
        ...spent.worldState,
        combat_state: combat,
        player_stats: { ...(spent.worldState.player_stats || {}), hp: Math.min(maxHp, currentHp + prevented) },
        pending_reaction: null,
      },
      reply: `You spend your **Reaction** and one Bardic Inspiration use for **Cutting Words**, reducing the damage by ${prevented} (d6 roll ${reductionRoll}).`,
    };
  }

  if (option.id === 'deflect_attacks') {
    const frame = pendingReaction.damage_frame || {};
    const damageTaken = Number(frame.damage_taken || 0);
    const reduction = rollDie(10) + Number(characterSheet.abilities?.modifiers?.dex || 0) + getCharacterLevel(characterSheet);
    const prevented = Math.min(damageTaken, reduction);
    let nextState = spentReaction.worldState;
    const combat = clone(nextState.combat_state || {});
    const player = (combat.combatants || []).find((entry) => entry.is_player);
    if (player) player.hp = Math.min(Number(player.max_hp || player.hp || 0), Number(player.hp || 0) + prevented);
    nextState = {
      ...nextState,
      combat_state: combat,
      player_stats: { ...(nextState.player_stats || {}), hp: Number(nextState.player_stats?.hp || 0) + prevented },
      pending_reaction: null,
    };
    let redirect = '';
    if (prevented === damageTaken && /\b(?:redirect|return|throw back)\b/i.test(message)) {
      const focus = spendResource({ worldState: nextState, characterSheet, resource: 'focus_points' });
      if (focus.ok) {
        nextState = focus.worldState;
        const combatAfterRedirect = clone(nextState.combat_state || {});
        const sourceId = pendingReaction.source_actor?.id;
        const sourceName = normalizeText(pendingReaction.source_actor?.name);
        const target = (combatAfterRedirect.combatants || []).find((entry) => (
          (!entry.is_player && sourceId && entry.id === sourceId)
          || (!entry.is_player && sourceName && normalizeText(entry.name) === sourceName)
        ));
        if (target && Number(target.hp || 0) > 0) {
          const dc = 8
            + Number(characterSheet.derived_stats?.proficiency_bonus || 2)
            + Number(characterSheet.abilities?.modifiers?.dex || 0);
          const save = resolveSavingThrow({ target, ability: 'dex', dc, bonus: Number(target.saves?.dex || 0), rollDie });
          if (save.success) {
            redirect = ` You spend 1 Focus Point to redirect the force, but ${target.name} succeeds on its DEX save (${save.total} vs DC ${dc}) and takes no damage.`;
          } else {
            const martialDie = characterSheet.derived_stats?.martial_arts_die || '1d6';
            const twoMartialDice = String(martialDie).replace(/^1d/i, '2d');
            const damageRoll = rollDamageFormula(`${twoMartialDice}+${Number(characterSheet.abilities?.modifiers?.dex || 0)}`, rollDie);
            const applied = applyDamage({ target, amount: damageRoll.total, damageType: frame.attack?.damage_type || frame.attack?.damageType || 'physical', source: 'Deflect Attacks' });
            Object.assign(target, applied.target);
            nextState = { ...nextState, combat_state: combatAfterRedirect };
            redirect = ` You spend 1 Focus Point to redirect the force. ${target.name} fails its DEX save (${save.total} vs DC ${dc}) and takes ${applied.amount} damage.`;
          }
        } else {
          redirect = ' You spend 1 Focus Point, but the original attacker is no longer a valid redirect target, so no redirected damage is applied.';
        }
      }
    }
    return {
      handled: true, resolved: true, logType: 'referee_reaction_deflect_attacks', pendingReaction: { ...pendingReaction, chosen_option: option }, worldState: nextState,
      reply: `You spend your **Reaction** for **Deflect Attacks**, reducing the damage by ${prevented} (${reduction} rolled reduction).${redirect}`,
    };
  }
  return unavailableReaction({ worldState, pendingReaction });
}

function spendWeaponReaction({
  option = {},
  worldState = {},
  characterSheet = {},
  pendingReaction,
} = {}) {
  const spent = spendTurnResource(worldState, 'reaction', option.label || 'Reaction attack', characterSheet);
  if (!spent.ok) {
    return unavailableReaction({ worldState, pendingReaction, reply: spent.reply });
  }
  return {
    handled: true,
    resolved: true,
    logType: `referee_reaction_${option.reaction_id || option.id}`,
    pendingReaction: {
      ...pendingReaction,
      chosen_option: option,
    },
    worldState: {
      ...spent.worldState,
      pending_reaction: null,
    },
    reply: `You spend your **Reaction** to make an **Opportunity Attack**. The fleeing party will be notified by blade.`,
  };
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
    [entry.id, entry.spell_id, entry.label, ...(entry.aliases || [])]
      .map(normalizeText)
      .filter(Boolean)
      .some((candidate) => {
        const stripped = candidate.replace(/^(?:cast|make|use)\s+/, '');
        return normalized.includes(candidate)
          || normalized.includes(stripped)
          || candidate.includes(normalized);
      })
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

function getCharacterLevel(characterSheet = {}) {
  return Number(characterSheet.identity?.level || characterSheet.derived_stats?.level || 1);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

module.exports = {
  buildAttackHitReaction,
  buildCreatureLeavesReachReaction,
  buildDamageTakenReaction,
  canOfferShieldReaction,
  formatPendingReactionPrompt,
  getReactionOptions,
  resolvePendingReactionChoice,
};
