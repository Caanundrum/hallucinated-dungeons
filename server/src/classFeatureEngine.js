const {
  grantMovement,
  grantActionSurgeAction,
  setTurnFlag,
  spendTurnResource,
} = require('./actionEconomy');
const { rollDie } = require('./dice');
const {
  buildResourceState,
  mergeWorldResources,
  spendResource,
} = require('./resourceEngine');
const {
  applyActiveEffectsToWorldState,
} = require('./spellEffectEngine');
const {
  applyHealing,
  applyDamage,
  formatDamageAdjustment,
  rollDamageFormula,
} = require('./damageHealingEngine');
const {
  resolveSavingThrow,
} = require('./conditionEngine');
const { assertValidRulesEffects } = require('./refereeContracts');

function resolveFeatureAction({ message = '', worldState = {}, characterSheet = {}, rollDie = defaultRollDie } = {}) {
  const intent = getFeatureIntent(message);
  if (!intent) return null;

  if (intent.id === 'rage') return resolveRage({ worldState, characterSheet });
  if (intent.id === 'action_surge') return resolveActionSurge({ worldState, characterSheet });
  if (intent.id === 'second_wind') return resolveSecondWind({ worldState, characterSheet, rollDie });
  if (intent.id === 'lay_on_hands') return resolveLayOnHands({ message, worldState, characterSheet });
  if (intent.id === 'channel_divinity') return resolveChannelDivinityChoice({ worldState, characterSheet });
  if (intent.id === 'divine_spark') return resolveDivineSpark({ message, worldState, characterSheet, rollDie });
  if (intent.id === 'turn_undead') return resolveTurnUndead({ worldState, characterSheet, rollDie });
  if (intent.id === 'innate_sorcery') return resolveInnateSorcery({ worldState, characterSheet });
  if (intent.id === 'font_of_magic') return resolveFontOfMagic({ message, worldState, characterSheet });
  if (intent.id === 'magical_cunning') return resolveMagicalCunning({ worldState, characterSheet });
  if (intent.id === 'pact_of_the_blade') return resolvePactOfTheBlade({ worldState, characterSheet });
  if (intent.id === 'wild_companion') return resolveWildCompanion({ message, worldState, characterSheet });
  if (intent.id === 'wild_shape') return resolveWildShape({ message, worldState, characterSheet });
  if (intent.id === 'bardic_inspiration') return resolveBardicInspiration({ message, worldState, characterSheet });
  if (intent.id === 'patient_defense') return resolvePatientDefense({ worldState, characterSheet });
  if (intent.id === 'step_of_the_wind') return resolveStepOfTheWind({ worldState, characterSheet });
  if (intent.id === 'uncanny_metabolism') return resolveUncannyMetabolism({ worldState, characterSheet, rollDie });
  if (intent.id === 'arcane_recovery') {
    return {
      handled: true,
      logType: 'feature_arcane_recovery_rest_required',
      worldState,
      reply: 'Arcane Recovery happens when you finish a Short Rest. Take a Short Rest and the referee will restore an eligible expended spell slot automatically if the resource is available.',
    };
  }

  return null;
}

function getFeatureIntent(message = '') {
  const text = String(message || '').toLowerCase();
  if (/\b(?:enter|use|start|activate|go into)?\s*rage\b/.test(text)) return { id: 'rage' };
  if (/\baction\s+surge\s+action\b/.test(text)) return null;
  if (/\baction\s+surge\b/.test(text)) return { id: 'action_surge' };
  if (/\bsecond\s+wind\b/.test(text)) return { id: 'second_wind' };
  if (/\blay\s+on\s+hands\b/.test(text)) return { id: 'lay_on_hands' };
  if (/\bdivine\s+spark\b/.test(text)) return { id: 'divine_spark' };
  if (/\bturn\s+undead\b/.test(text)) return { id: 'turn_undead' };
  if (/\bchannel\s+divinity\b/.test(text)) return { id: 'channel_divinity' };
  if (/\binnate\s+sorcery\b/.test(text)) return { id: 'innate_sorcery' };
  if (/\bfont\s+of\s+magic\b|\bconvert\b.*\b(?:sorcery points?|spell slots?)\b|\bcreate\b.*\bspell slot\b.*\bsorcery\b/.test(text)) return { id: 'font_of_magic' };
  if (/\bmagical\s+cunning\b/.test(text)) return { id: 'magical_cunning' };
  if (/\b(?:conjure|summon|create|call|manifest|bind)\b.*\b(?:pact of the blade|pact weapon)\b|\bpact of the blade\b.*\b(?:weapon|conjure|summon|manifest)\b/.test(text)) return { id: 'pact_of_the_blade' };
  if (isWildCompanionDismissal(text)) return { id: 'wild_companion' };
  if (/\bwild\s+companion\b|\bfind\s+familiar\b.*\bwild\s*shape\b|\bwild\s*shape\b.*\bfind\s+familiar\b/.test(text)) return { id: 'wild_companion' };
  if (/\bwild\s*shape\b|\bshape\s*change\b|\bturn\s+into\s+(?:a|an|the)?\s*(?:wolf|cat|badger|spider|rat|dog|mastiff|goat|boar|scouting beast|[a-z -]*beast)\b/.test(text)) return { id: 'wild_shape' };
  if (/\bbardic\s+inspiration\b/.test(text)) return { id: 'bardic_inspiration' };
  if (/\bpatient\s+defense\b|\bfocus(?:ed)?\s+dodge\b/.test(text)) return { id: 'patient_defense' };
  if (/\bstep\s+of\s+the\s+wind\b|\bfocus(?:ed)?\s+(?:dash|disengage)\b/.test(text)) return { id: 'step_of_the_wind' };
  if (/\buncanny\s+metabolism\b/.test(text)) return { id: 'uncanny_metabolism' };
  if (/\barcane\s+recovery\b/.test(text)) return { id: 'arcane_recovery' };
  return null;
}

function resolveActionSurge({ worldState = {}, characterSheet = {} } = {}) {
  if (!isClass(characterSheet, 'fighter')) return wrongClass('Action Surge', 'Fighter', worldState);
  if (getCharacterLevel(characterSheet) < 2) {
    return {
      handled: true,
      logType: 'feature_action_surge_level_required',
      worldState,
      reply: 'Action Surge is a level 2 Fighter feature. At level 1, the tactical lightning has not been installed yet.',
    };
  }

  const resources = buildResourceState(characterSheet, worldState);
  if (Number(resources.action_surge?.remaining || 0) <= 0) {
    return {
      handled: true,
      logType: 'feature_action_surge_unavailable',
      worldState: mergeWorldResources(worldState, resources),
      reply: 'Action Surge has no uses left until a Short or Long Rest restores it.',
    };
  }

  const surged = grantActionSurgeAction(worldState, characterSheet);
  if (!surged.ok) {
    return {
      handled: true,
      logType: 'feature_action_surge_unavailable',
      worldState: surged.worldState,
      reply: surged.reply,
    };
  }

  const spent = spendResource({ worldState: surged.worldState, characterSheet, resource: 'action_surge' });
  return {
    handled: true,
    logType: 'feature_action_surge',
    worldState: spent.worldState,
    reply: `You use **Action Surge** and gain one extra action this turn. The extra action cannot be the Magic action. Uses left: ${remainingResourceText(spent.worldState, characterSheet, 'action_surge')}.`,
  };
}

function resolveRage({ worldState = {}, characterSheet = {} } = {}) {
  if (!isClass(characterSheet, 'barbarian')) return wrongClass('Rage', 'Barbarian', worldState);
  if (hasActiveEffect(worldState, 'rage')) {
    return {
      handled: true,
      logType: 'feature_rage_already_active',
      worldState,
      reply: 'Rage is already active. The fury drawer is open; no need to open a second fury drawer.',
    };
  }

  const spent = spendFeatureCost({ worldState, characterSheet, actionResource: 'bonus_action', actionLabel: 'Rage', resource: 'rage' });
  if (!spent.ok) return spent.result;

  const effect = {
    id: 'rage',
    name: 'Rage',
    source: actorName(characterSheet, spent.worldState),
    source_type: 'class_feature',
    target: actorName(characterSheet, spent.worldState),
    duration: 'up to 10 minutes',
    concentration: false,
    remaining_minutes: 10,
    remaining_rounds: 100,
    mechanical_effect: 'Physical damage resistance, advantage on Strength tests, and extra Strength-based weapon damage while active.',
    rules_effects: [
      { target: 'damage_resistance', damage_types: ['bludgeoning', 'piercing', 'slashing'], label: 'Rage' },
      { target: 'ability_check_advantage', ability: 'str', label: 'Rage' },
      { target: 'saving_throw_advantage', ability: 'str', label: 'Rage' },
      { target: 'weapon_damage_bonus', value: 2, ability: 'str', label: 'Rage' },
    ],
  };
  const nextState = addOrReplaceFeatureEffect(spent.worldState, effect, characterSheet);

  return {
    handled: true,
    logType: 'feature_rage',
    worldState: nextState,
    reply: `You enter **Rage** as a Bonus Action. You gain physical damage resistance, Strength advantage, and +2 damage on Strength-based weapon attacks while it lasts. Rage uses left: ${remainingResourceText(nextState, characterSheet, 'rage')}.`,
  };
}

function resolveSecondWind({ worldState = {}, characterSheet = {}, rollDie = defaultRollDie } = {}) {
  if (!isClass(characterSheet, 'fighter')) return wrongClass('Second Wind', 'Fighter', worldState);
  const missingHp = getMissingHp(worldState, characterSheet);
  if (missingHp <= 0) {
    return {
      handled: true,
      logType: 'feature_second_wind_full_hp',
      worldState: mergeWorldResources(worldState, buildResourceState(characterSheet, worldState)),
      reply: 'You are already at full HP, so **Second Wind** would not restore anything. No use is spent; save the heroic inhale for when something has actually dented you.',
    };
  }

  const spent = spendFeatureCost({ worldState, characterSheet, actionResource: 'bonus_action', actionLabel: 'Second Wind', resource: 'second_wind' });
  if (!spent.ok) return spent.result;

  const level = getCharacterLevel(characterSheet);
  const healingRoll = rollDamageFormula(`1d10+${level}`, rollDie);
  const healed = healActiveCharacter(spent.worldState, characterSheet, healingRoll.total);

  return {
    handled: true,
    logType: 'feature_second_wind',
    worldState: healed.worldState,
    reply: `You use **Second Wind** as a Bonus Action and regain ${healed.applied} HP (${healingRoll.rolls.join(' + ')} + ${level}). HP: ${healed.beforeHp} -> ${healed.afterHp}. Uses left: ${remainingResourceText(healed.worldState, characterSheet, 'second_wind')}.`,
  };
}

function resolveLayOnHands({ message = '', worldState = {}, characterSheet = {} } = {}) {
  if (!isClass(characterSheet, 'paladin')) return wrongClass('Lay on Hands', 'Paladin', worldState);
  if (targetsSomeoneElse(message)) {
    return {
      handled: true,
      logType: 'feature_lay_on_hands_target_needed',
      worldState,
      reply: 'Lay on Hands can heal another creature, but this phase only has deterministic HP tracking for the active character. Use it on yourself for now, or wait for party/map targeting before healing someone else without making the rules wear a fake mustache.',
    };
  }

  const resources = buildResourceState(characterSheet, worldState);
  const pool = Number(resources.lay_on_hands?.remaining || 0);
  const missingHp = getMissingHp(worldState, characterSheet);
  const requested = parseHealingAmount(message) || missingHp || Math.min(pool, 1);
  const amount = Math.min(pool, Math.max(0, requested), Math.max(1, missingHp || requested));
  if (amount <= 0 || pool <= 0) {
    return {
      handled: true,
      logType: 'feature_lay_on_hands_unavailable',
      worldState: mergeWorldResources(worldState, resources),
      reply: pool <= 0
        ? 'Lay on Hands has no healing pool left until a Long Rest.'
        : 'You are already at full HP, so Lay on Hands has nothing useful to patch. Very tidy of you.',
    };
  }

  const spent = spendFeatureCost({ worldState, characterSheet, actionResource: 'bonus_action', actionLabel: 'Lay on Hands', resource: 'lay_on_hands', amount });
  if (!spent.ok) return spent.result;

  const healed = healActiveCharacter(spent.worldState, characterSheet, amount);
  return {
    handled: true,
    logType: 'feature_lay_on_hands',
    worldState: healed.worldState,
    reply: `You use **Lay on Hands** as a Bonus Action and restore ${healed.applied} HP. HP: ${healed.beforeHp} -> ${healed.afterHp}. Healing pool left: ${remainingResourceText(healed.worldState, characterSheet, 'lay_on_hands')} HP.`,
  };
}

function resolveChannelDivinityChoice({ worldState = {}, characterSheet = {} } = {}) {
  const requirement = requireClericChannelDivinity('Channel Divinity', worldState, characterSheet);
  if (requirement) return requirement;

  return {
    handled: true,
    logType: 'feature_channel_divinity_choice',
    worldState: mergeWorldResources(worldState, buildResourceState(characterSheet, worldState)),
    reply: 'Channel Divinity is ready. At level 2, use it as **Divine Spark** to heal yourself or harm an established target, or **Turn Undead** when undead are actually present. The holy switchboard refuses vague calls.',
  };
}

function resolveDivineSpark({ message = '', worldState = {}, characterSheet = {}, rollDie = defaultRollDie } = {}) {
  const requirement = requireClericChannelDivinity('Divine Spark', worldState, characterSheet);
  if (requirement) return requirement;

  const mode = getDivineSparkMode(message);
  if (!mode) {
    return {
      handled: true,
      logType: 'feature_divine_spark_mode_needed',
      worldState: mergeWorldResources(worldState, buildResourceState(characterSheet, worldState)),
      reply: 'Divine Spark needs a clear mode: heal yourself, or harm a valid creature you can target. The divine current is available; it just wants the socket labeled.',
    };
  }

  if (mode === 'heal') return resolveDivineSparkHealing({ worldState, characterSheet, rollDie });
  return resolveDivineSparkDamage({ message, worldState, characterSheet, rollDie });
}

function resolveDivineSparkHealing({ worldState = {}, characterSheet = {}, rollDie = defaultRollDie } = {}) {
  const missingHp = getMissingHp(worldState, characterSheet);
  if (missingHp <= 0) {
    return {
      handled: true,
      logType: 'feature_divine_spark_full_hp',
      worldState: mergeWorldResources(worldState, buildResourceState(characterSheet, worldState)),
      reply: 'Divine Spark can heal, but you are already at full HP. No Channel Divinity use is spent; the divine battery keeps its charge.',
    };
  }

  const spent = spendFeatureCost({
    worldState,
    characterSheet,
    actionResource: 'action',
    actionLabel: 'Divine Spark',
    resource: 'channel_divinity',
  });
  if (!spent.ok) return spent.result;

  const modifier = getSpellcastingModifier(characterSheet);
  const healing = rollDamageFormula(`1d8${formatSigned(modifier)}`, rollDie);
  const healed = healActiveCharacter(spent.worldState, characterSheet, healing.total);
  return {
    handled: true,
    logType: 'feature_divine_spark_healing',
    worldState: healed.worldState,
    reply: `You use **Divine Spark** to heal yourself. Healing: ${healing.rolls.join(' + ')}${formatSigned(modifier)} = ${healing.total}; ${healed.applied} HP restored. HP: ${healed.beforeHp} -> ${healed.afterHp}. Channel Divinity left: ${remainingResourceText(healed.worldState, characterSheet, 'channel_divinity')}.`,
  };
}

function resolveDivineSparkDamage({ message = '', worldState = {}, characterSheet = {}, rollDie = defaultRollDie } = {}) {
  const context = getFeatureTargetContext({ message, worldState, allowFallback: true });
  if (!context?.target) {
    return {
      handled: true,
      logType: 'feature_divine_spark_no_target',
      worldState,
      reply: 'Divine Spark needs a valid creature target in the current scene. Name an established target; the heavens are powerful, not omnidirectionally sloppy.',
    };
  }

  const spent = spendFeatureCost({
    worldState,
    characterSheet,
    actionResource: 'action',
    actionLabel: 'Divine Spark',
    resource: 'channel_divinity',
  });
  if (!spent.ok) return spent.result;

  const liveContext = getFeatureTargetContext({ message, worldState: spent.worldState, allowFallback: true }) || context;
  const combat = liveContext.combat;
  const target = liveContext.target;
  const damageType = /\bnecrotic\b/i.test(message) ? 'necrotic' : 'radiant';
  const modifier = getSpellcastingModifier(characterSheet);
  const dc = getSpellSaveDc(characterSheet);
  const save = resolveSavingThrow({
    target,
    ability: 'con',
    dc,
    rollDie,
    bonus: Number(target.saves?.con || 0),
  });
  const damage = rollDamageFormula(`1d8${formatSigned(modifier)}`, rollDie);
  const appliedAmount = save.success ? 0 : damage.total;
  const applied = applyDamage({ target, amount: appliedAmount, damageType, source: 'Divine Spark' });
  Object.assign(target, applied.target);
  const lines = [
    `You use **Divine Spark** on ${target.name}. ${target.name} makes a CON save: ${save.automaticFailure ? save.text : `${save.text} vs DC ${dc}`}.`,
    save.success
      ? `Save succeeds. No ${damageType} damage is applied. Channel Divinity left: ${remainingResourceText(spent.worldState, characterSheet, 'channel_divinity')}.`
      : `Save fails. Divine Spark deals ${applied.amount} ${damageType} damage${formatDamageAdjustment(applied.adjustment)} (${damage.rolls.join(' + ')}${formatSigned(modifier)}). ${target.name}: (${applied.beforeHp} -> ${target.hp} HP). Channel Divinity left: ${remainingResourceText(spent.worldState, characterSheet, 'channel_divinity')}.`,
  ];

  const nextWorldState = syncFeatureTargetCombat(spent.worldState, combat, liveContext.activeCombat);
  return {
    handled: true,
    logType: 'feature_divine_spark_damage',
    worldState: nextWorldState,
    reply: lines.join('\n\n'),
  };
}

function resolveTurnUndead({ worldState = {}, characterSheet = {}, rollDie = defaultRollDie } = {}) {
  const requirement = requireClericChannelDivinity('Turn Undead', worldState, characterSheet);
  if (requirement) return requirement;

  const combat = cloneCombat(worldState.combat_state || {});
  if (!combat.active) {
    return {
      handled: true,
      logType: 'feature_turn_undead_combat_required',
      worldState: mergeWorldResources(worldState, buildResourceState(characterSheet, worldState)),
      reply: 'Turn Undead needs active combat with an established undead creature. The symbol is ready; the target list is currently a blank pew.',
    };
  }
  const targets = (combat.combatants || [])
    .filter((combatant) => !combatant.is_player && Number(combatant.hp || 0) > 0 && isUndeadCombatant(combatant));
  if (targets.length === 0) {
    return {
      handled: true,
      logType: 'feature_turn_undead_no_targets',
      worldState: mergeWorldResources(worldState, buildResourceState(characterSheet, worldState)),
      reply: 'Turn Undead finds no established undead creature in the fight. It does not work on vibes, suspicious dampness, or regular rude people.',
    };
  }

  const spent = spendFeatureCost({
    worldState,
    characterSheet,
    actionResource: 'action',
    actionLabel: 'Turn Undead',
    resource: 'channel_divinity',
  });
  if (!spent.ok) return spent.result;

  const liveCombat = cloneCombat(spent.worldState.combat_state || combat);
  const dc = getSpellSaveDc(characterSheet);
  const lines = [`You present your holy symbol and use **Turn Undead**. Channel Divinity left: ${remainingResourceText(spent.worldState, characterSheet, 'channel_divinity')}.`];
  let turnedAny = false;
  liveCombat.combatants = (liveCombat.combatants || []).map((combatant) => {
    if (combatant.is_player || Number(combatant.hp || 0) <= 0 || !isUndeadCombatant(combatant)) return combatant;
    const save = resolveSavingThrow({
      target: combatant,
      ability: 'wis',
      dc,
      rollDie,
      bonus: Number(combatant.saves?.wis || 0),
    });
    if (save.success) {
      lines.push(`${combatant.name} makes a WIS save: ${save.automaticFailure ? save.text : `${save.text} vs DC ${dc}`}. Save succeeds; it is not turned.`);
      return combatant;
    }
    turnedAny = true;
    lines.push(`${combatant.name} makes a WIS save: ${save.automaticFailure ? save.text : `${save.text} vs DC ${dc}`}. Save fails; it is **turned** for 1 minute or until damaged.`);
    return {
      ...combatant,
      conditions: addCondition(combatant.conditions, 'turn_undead'),
    };
  });

  let nextState = {
    ...spent.worldState,
    combat_state: liveCombat,
  };
  if (turnedAny) {
    nextState = addOrReplaceFeatureEffect(nextState, {
      id: 'turn_undead',
      name: 'Turn Undead',
      source: actorName(characterSheet, spent.worldState),
      source_type: 'class_feature',
      target: 'undead creatures that failed the save',
      duration: '1 minute',
      concentration: false,
      remaining_minutes: 1,
      remaining_rounds: 10,
      mechanical_effect: 'Turned undead cannot act until the condition ends or they are damaged.',
      rules_effects: [],
    }, characterSheet);
  }

  return {
    handled: true,
    logType: 'feature_turn_undead',
    worldState: nextState,
    reply: lines.join('\n\n'),
  };
}

function resolveInnateSorcery({ worldState = {}, characterSheet = {} } = {}) {
  if (!isClass(characterSheet, 'sorcerer')) return wrongClass('Innate Sorcery', 'Sorcerer', worldState);
  if (hasActiveEffect(worldState, 'innate_sorcery')) {
    return {
      handled: true,
      logType: 'feature_innate_sorcery_already_active',
      worldState,
      reply: 'Innate Sorcery is already active. The magic is awake and making eye contact.',
    };
  }

  const spent = spendFeatureCost({ worldState, characterSheet, actionResource: 'bonus_action', actionLabel: 'Innate Sorcery', resource: 'innate_sorcery' });
  if (!spent.ok) return spent.result;

  const effect = {
    id: 'innate_sorcery',
    name: 'Innate Sorcery',
    source: actorName(characterSheet, spent.worldState),
    source_type: 'class_feature',
    target: actorName(characterSheet, spent.worldState),
    duration: '1 minute',
    concentration: false,
    remaining_minutes: 1,
    remaining_rounds: 10,
    mechanical_effect: 'Sorcerer spell save DC increases by 1 and Sorcerer spell attacks have advantage.',
    rules_effects: [
      { target: 'spell_save_dc_bonus', class_id: 'sorcerer', value: 1, label: 'Innate Sorcery' },
      { target: 'spell_attack_advantage', class_id: 'sorcerer', label: 'Innate Sorcery' },
    ],
  };
  const nextState = addOrReplaceFeatureEffect(spent.worldState, effect, characterSheet);

  return {
    handled: true,
    logType: 'feature_innate_sorcery',
    worldState: nextState,
    reply: `You activate **Innate Sorcery** as a Bonus Action. For 1 minute, your Sorcerer spell save DC is +1 and your Sorcerer spell attacks have Advantage. Uses left: ${remainingResourceText(nextState, characterSheet, 'innate_sorcery')}.`,
  };
}

function resolveFontOfMagic({ message = '', worldState = {}, characterSheet = {} } = {}) {
  if (!isClass(characterSheet, 'sorcerer')) return wrongClass('Font of Magic', 'Sorcerer', worldState);
  if (getCharacterLevel(characterSheet) < 2) {
    return levelRequired('Font of Magic', 'Sorcerer', 2, worldState);
  }

  const direction = inferFontConversion(message);
  if (!direction) {
    return {
      handled: true,
      logType: 'feature_font_of_magic_choice_required',
      worldState: mergeWorldResources(worldState, buildResourceState(characterSheet, worldState)),
      reply: 'Font of Magic needs a conversion direction: create a level 1 spell slot for 2 Sorcery Points, or turn one level 1 spell slot into 1 Sorcery Point.',
    };
  }

  const spentAction = spendTurnResource(worldState, 'bonus_action', 'Font of Magic', characterSheet);
  if (!spentAction.ok) {
    return { handled: true, logType: 'feature_font_of_magic_action_unavailable', worldState: spentAction.worldState, reply: spentAction.reply };
  }

  const resources = buildResourceState(characterSheet, spentAction.worldState);
  const sorcery = resources.sorcery_points || { name: 'Sorcery Points', remaining: 0, max: getCharacterLevel(characterSheet), reset: 'long_rest' };
  const slots = { ...(spentAction.worldState.player_stats?.spell_slots || characterSheet.spellcasting?.slots || {}) };
  const currentSlots = Number(slots['1'] || 0);

  if (direction === 'slot') {
    if (Number(sorcery.remaining || 0) < 2) {
      return {
        handled: true,
        logType: 'feature_font_of_magic_resource_unavailable',
        worldState: mergeWorldResources(worldState, resources),
        reply: 'Creating a level 1 spell slot costs 2 Sorcery Points, and you do not currently have enough. Your Bonus Action and resources are not spent.',
      };
    }
    const nextResources = {
      ...resources,
      sorcery_points: { ...sorcery, remaining: Number(sorcery.remaining) - 2 },
    };
    return {
      handled: true,
      logType: 'feature_font_of_magic_create_slot',
      worldState: mergeWorldResources({
        ...spentAction.worldState,
        player_stats: { ...(spentAction.worldState.player_stats || {}), spell_slots: { ...slots, 1: currentSlots + 1 } },
      }, nextResources),
      reply: `You use **Font of Magic** as a Bonus Action, spend 2 Sorcery Points, and create one level 1 spell slot. Sorcery Points: ${nextResources.sorcery_points.remaining}/${nextResources.sorcery_points.max}. Level 1 slots: ${currentSlots + 1}.`,
    };
  }

  if (currentSlots <= 0) {
    return {
      handled: true,
      logType: 'feature_font_of_magic_slot_unavailable',
      worldState: mergeWorldResources(worldState, resources),
      reply: 'You do not have a level 1 spell slot available to convert. Your Bonus Action and Sorcery Points are not spent.',
    };
  }
  if (Number(sorcery.remaining || 0) >= Number(sorcery.max || getCharacterLevel(characterSheet))) {
    return {
      handled: true,
      logType: 'feature_font_of_magic_points_full',
      worldState: mergeWorldResources(worldState, resources),
      reply: 'Your Sorcery Points are already full, so converting a spell slot would waste it. Nothing is spent.',
    };
  }

  const nextResources = {
    ...resources,
    sorcery_points: { ...sorcery, remaining: Math.min(Number(sorcery.max), Number(sorcery.remaining || 0) + 1) },
  };
  return {
    handled: true,
    logType: 'feature_font_of_magic_create_points',
    worldState: mergeWorldResources({
      ...spentAction.worldState,
      player_stats: { ...(spentAction.worldState.player_stats || {}), spell_slots: { ...slots, 1: currentSlots - 1 } },
    }, nextResources),
    reply: `You use **Font of Magic** as a Bonus Action, expend one level 1 spell slot, and regain 1 Sorcery Point. Sorcery Points: ${nextResources.sorcery_points.remaining}/${nextResources.sorcery_points.max}. Level 1 slots: ${currentSlots - 1}.`,
  };
}

function resolveMagicalCunning({ worldState = {}, characterSheet = {} } = {}) {
  if (!isClass(characterSheet, 'warlock')) return wrongClass('Magical Cunning', 'Warlock', worldState);
  if (getCharacterLevel(characterSheet) < 2) return levelRequired('Magical Cunning', 'Warlock', 2, worldState);
  if (worldState.combat_state?.active) {
    return {
      handled: true,
      logType: 'feature_magical_cunning_combat_blocked',
      worldState,
      reply: 'Magical Cunning requires a one-minute rite, so it cannot be completed during active combat. Initiative is famously hostile to quiet ritual breaks.',
    };
  }

  const resources = buildResourceState(characterSheet, worldState);
  const cunning = resources.magical_cunning;
  if (Number(cunning?.remaining || 0) <= 0) {
    return {
      handled: true,
      logType: 'feature_magical_cunning_unavailable',
      worldState: mergeWorldResources(worldState, resources),
      reply: 'Magical Cunning has already been used and returns after a Long Rest. The pact has reviewed the request and stamped it "later."',
    };
  }

  const maxSlots = Number(characterSheet.spellcasting?.slots_max?.['1'] || getWarlockLevelOneSlotMaximum(characterSheet));
  const slots = { ...(worldState.player_stats?.spell_slots || characterSheet.spellcasting?.slots || {}) };
  const current = Number(slots['1'] || 0);
  const recoverable = Math.ceil(maxSlots / 2);
  const restored = Math.min(recoverable, Math.max(0, maxSlots - current));
  if (restored <= 0) {
    return {
      handled: true,
      logType: 'feature_magical_cunning_slots_full',
      worldState: mergeWorldResources(worldState, resources),
      reply: `Your Pact Magic slots are already full (${current}/${maxSlots}), so Magical Cunning is not spent. The patron declines to refill a cup that is visibly full.`,
    };
  }

  const nextResources = {
    ...resources,
    magical_cunning: { ...cunning, remaining: Number(cunning.remaining) - 1 },
  };
  const elapsed = Number(worldState.time_state?.elapsed_minutes || 0) + 1;
  return {
    handled: true,
    logType: 'feature_magical_cunning',
    worldState: mergeWorldResources({
      ...worldState,
      time_state: { ...(worldState.time_state || {}), elapsed_minutes: elapsed, scene_time: 'after a one-minute Magical Cunning rite' },
      player_stats: { ...(worldState.player_stats || {}), spell_slots: { ...slots, 1: current + restored } },
    }, nextResources),
    reply: `You complete a one-minute **Magical Cunning** rite and recover ${restored} Pact Magic slot. Level 1 Pact slots: ${current + restored}/${maxSlots}. Uses left: ${nextResources.magical_cunning.remaining}/${nextResources.magical_cunning.max}.`,
  };
}

function resolvePactOfTheBlade({ worldState = {}, characterSheet = {} } = {}) {
  if (!isClass(characterSheet, 'warlock')) return wrongClass('Pact of the Blade', 'Warlock', worldState);
  if (!hasInvocation(characterSheet, 'pact_of_the_blade')) {
    return {
      handled: true,
      logType: 'feature_pact_blade_unavailable',
      worldState,
      reply: 'Pact of the Blade is not selected on this character sheet, so no pact weapon can be conjured.',
    };
  }

  const weaponId = getPactWeaponId(characterSheet);
  if (!weaponId) {
    return {
      handled: true,
      logType: 'feature_pact_blade_weapon_missing',
      worldState,
      reply: 'Pact of the Blade is selected, but its weapon form is missing from the character sheet. Nothing is spent or conjured.',
    };
  }

  const spent = spendTurnResource(worldState, 'bonus_action', 'Pact of the Blade', characterSheet);
  if (!spent.ok) {
    return { handled: true, logType: 'feature_pact_blade_action_unavailable', worldState: spent.worldState, reply: spent.reply };
  }

  const weaponName = titleCase(weaponId);
  return {
    handled: true,
    logType: 'feature_pact_blade_conjure',
    worldState: {
      ...spent.worldState,
      player_stats: {
        ...(spent.worldState.player_stats || {}),
        pact_weapon: { id: weaponId, name: weaponName, active: true },
      },
    },
    reply: `You use **Pact of the Blade**${spent.worldState.combat_state?.active ? ' as a Bonus Action' : ''} and conjure your chosen **${weaponName}**. It is now your active pact weapon and uses Charisma for its attack and damage rolls.`,
  };
}

function hasInvocation(characterSheet = {}, invocationId = '') {
  return [
    characterSheet.class_choices?.eldritch_invocation,
    ...(characterSheet.class_choices?.eldritch_invocations || []),
  ].map(normalizeId).filter(Boolean).includes(normalizeId(invocationId));
}

function getPactWeaponId(characterSheet = {}) {
  return normalizeId(
    characterSheet.class_choice_details?.pact_of_the_blade?.pact_weapon
      || characterSheet.class_choice_details?.eldritch_invocations?.pact_weapon
      || characterSheet.class_choice_details?.eldritch_invocation?.pact_weapon
  );
}

function getWarlockLevelOneSlotMaximum(characterSheet = {}) {
  return getCharacterLevel(characterSheet) >= 2 ? 2 : Number(characterSheet.spellcasting?.slots?.['1'] || 1);
}

function inferFontConversion(message = '') {
  const text = String(message || '').toLowerCase();
  if (/\b(?:create|make|restore|gain)\b.*\bspell slot\b|\bsorcery points?\b.*\b(?:into|for)\b.*\bspell slot\b/.test(text)) return 'slot';
  if (/\bspell slot\b.*\b(?:into|for|to gain|to restore)\b.*\bsorcery points?\b|\bconvert\b.*\bspell slot\b/.test(text)) return 'points';
  return null;
}

function levelRequired(feature, className, level, worldState) {
  return {
    handled: true,
    logType: `feature_${normalizeFeatureId(feature)}_level_required`,
    worldState,
    reply: `${feature} is a level ${level} ${className} feature. This character has not reached it yet.`,
  };
}

function normalizeFeatureId(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function resolveWildShape({ message = '', worldState = {}, characterSheet = {} } = {}) {
  const requirement = requireDruidWildShape('Wild Shape', worldState, characterSheet);
  if (requirement) return requirement;

  if (hasActiveEffect(worldState, 'wild_shape')) {
    return {
      handled: true,
      logType: 'feature_wild_shape_already_active',
      worldState: mergeWorldResources(worldState, buildResourceState(characterSheet, worldState)),
      reply: 'Wild Shape is already active. Reverting and changing forms cleanly is coming with the fuller form-state pass; for now, finish this form before wearing another animal hat.',
    };
  }

  const form = inferWildShapeForm(message);
  if (form.blocked) {
    return {
      handled: true,
      logType: 'feature_wild_shape_form_blocked',
      worldState: mergeWorldResources(worldState, buildResourceState(characterSheet, worldState)),
      reply: `${form.label} is not a supported level 2 Wild Shape form in this build. Choose a simple land beast such as wolf, cat, badger, spider, or a generic scouting beast. No use is spent; the nature door remains politely closed.`,
    };
  }

  const spent = spendFeatureCost({
    worldState,
    characterSheet,
    actionResource: 'bonus_action',
    actionLabel: 'Wild Shape',
    resource: 'wild_shape',
  });
  if (!spent.ok) return spent.result;

  const level = getCharacterLevel(characterSheet);
  const effect = {
    id: 'wild_shape',
    name: `Wild Shape (${form.label})`,
    source: actorName(characterSheet, spent.worldState),
    source_type: 'class_feature',
    target: actorName(characterSheet, spent.worldState),
    duration: '1 hour',
    concentration: false,
    remaining_minutes: 60,
    remaining_rounds: 600,
    form: form.id,
    mechanical_effect: 'Tracks Wild Shape form state, duration, and temporary HP. Detailed beast stat blocks are reserved for the future map/entity layer.',
    rules_effects: [
      { target: 'temp_hp', value: level, label: 'Wild Shape' },
    ],
  };
  const shaped = addOrReplaceFeatureEffect({
    ...spent.worldState,
    player_stats: {
      ...(spent.worldState.player_stats || {}),
      wild_shape: {
        active: true,
        form: form.id,
        label: form.label,
      },
    },
  }, effect, characterSheet);

  return {
    handled: true,
    logType: 'feature_wild_shape',
    worldState: shaped,
    reply: `You use **Wild Shape** as a Bonus Action and take the form of ${articleFor(form.label)} ${form.label}. You gain ${level} temporary HP and the form is tracked for 1 hour. Wild Shape uses left: ${remainingResourceText(shaped, characterSheet, 'wild_shape')}.`,
  };
}

function resolveWildCompanion({ message = '', worldState = {}, characterSheet = {} } = {}) {
  const requirement = requireDruidWildShape('Wild Companion', worldState, characterSheet);
  if (requirement) return requirement;

  if (isWildCompanionDismissal(message)) {
    return dismissWildCompanion({ worldState, characterSheet });
  }

  if (hasActiveEffect(worldState, 'wild_companion')) {
    return {
      handled: true,
      logType: 'feature_wild_companion_already_active',
      worldState: mergeWorldResources(worldState, buildResourceState(characterSheet, worldState)),
      reply: 'Wild Companion is already present. One familiar is enough bookkeeping until the map layer can hand out tiny name tags.',
    };
  }

  const spent = spendFeatureCost({
    worldState,
    characterSheet,
    actionResource: 'action',
    actionLabel: 'Wild Companion',
    resource: 'wild_shape',
  });
  if (!spent.ok) return spent.result;

  const companionName = inferFamiliarName(spent.worldState);
  const effect = {
    id: 'wild_companion',
    name: 'Wild Companion Familiar',
    source: actorName(characterSheet, spent.worldState),
    source_type: 'class_feature',
    target: companionName,
    duration: 'until dismissed',
    concentration: false,
    mechanical_effect: 'A familiar spirit is present in the scene. Full familiar actions and map position are reserved for the future companion/entity layer.',
    rules_effects: [],
  };
  const withCompanion = addOrReplaceFeatureEffect(addCompanionToWorldState(spent.worldState, companionName), effect, characterSheet);

  return {
    handled: true,
    logType: 'feature_wild_companion',
    worldState: withCompanion,
    reply: `You use **Wild Companion**, spending one Wild Shape use to call a familiar spirit into the scene. ${companionName} is now present for narration and future targeting. Wild Shape uses left: ${remainingResourceText(withCompanion, characterSheet, 'wild_shape')}.`,
  };
}

function dismissWildCompanion({ worldState = {}, characterSheet = {} } = {}) {
  const activeEffect = (worldState.active_effects || []).find((effect) => effect.id === 'wild_companion');
  const companion = (worldState.player_stats?.companions || [])
    .find((entry) => normalizeId(entry.id || entry.name) === 'wild_companion_familiar');
  if (!activeEffect && !companion) {
    return {
      handled: true,
      logType: 'feature_wild_companion_not_active',
      worldState: mergeWorldResources(worldState, buildResourceState(characterSheet, worldState)),
      reply: 'No Wild Companion familiar is currently present to dismiss.',
    };
  }

  const spentAction = spendTurnResource(worldState, 'action', 'Dismiss Wild Companion', characterSheet);
  if (!spentAction.ok) {
    return {
      handled: true,
      logType: 'feature_action_unavailable',
      worldState: spentAction.worldState,
      reply: spentAction.reply,
    };
  }

  const companionName = companion?.name || activeEffect?.target || 'familiar';
  const stripped = removeCompanionFromWorldState(spentAction.worldState, companionName);
  const retainedEffects = (stripped.active_effects || []).filter((effect) => effect.id !== 'wild_companion');
  const dismissed = applyActiveEffectsToWorldState(stripped, retainedEffects, characterSheet);

  return {
    handled: true,
    logType: 'feature_wild_companion_dismissed',
    worldState: dismissed,
    reply: `You dismiss your **Wild Companion**. ${companionName} vanishes from the scene. No Wild Shape use is spent.`,
  };
}

function resolveBardicInspiration({ message = '', worldState = {}, characterSheet = {} } = {}) {
  if (!isClass(characterSheet, 'bard')) return wrongClass('Bardic Inspiration', 'Bard', worldState);
  const target = inferBardicTarget(message, worldState);
  if (!target || isSelfTarget(target, characterSheet, worldState)) {
    return {
      handled: true,
      logType: 'feature_bardic_inspiration_target_needed',
      worldState,
      reply: 'Bardic Inspiration needs another creature you can inspire. Name an ally or NPC present in the scene; inspiring yourself is still handled by confidence, snacks, and questionable theater, not this feature.',
    };
  }

  const spent = spendFeatureCost({ worldState, characterSheet, actionResource: 'bonus_action', actionLabel: 'Bardic Inspiration', resource: 'bardic_inspiration' });
  if (!spent.ok) return spent.result;

  const effect = {
    id: `bardic_inspiration_${normalizeId(target)}`,
    name: 'Bardic Inspiration',
    source: actorName(characterSheet, spent.worldState),
    source_type: 'class_feature',
    target,
    duration: '1 hour',
    concentration: false,
    remaining_minutes: 60,
    remaining_rounds: 600,
    mechanical_effect: 'Another creature can add the Bardic Inspiration die to a failed D20 Test if it can turn the roll into a success.',
    rules_effects: [
      { target: 'bardic_inspiration_die', die: '1d6', label: 'Bardic Inspiration', target_bound: true },
    ],
  };
  const nextState = addOrReplaceFeatureEffect(spent.worldState, effect, characterSheet);
  return {
    handled: true,
    logType: 'feature_bardic_inspiration',
    worldState: nextState,
    reply: `You grant **Bardic Inspiration** to ${target} as a Bonus Action. They carry a d6 that can help a failed d20 test if it is enough to matter. Uses left: ${remainingResourceText(nextState, characterSheet, 'bardic_inspiration')}.`,
  };
}

function resolvePatientDefense({ worldState = {}, characterSheet = {} } = {}) {
  const requirement = requireMonkFocus('Patient Defense', worldState, characterSheet);
  if (requirement) return requirement;

  const spent = spendFeatureCost({
    worldState,
    characterSheet,
    actionResource: 'bonus_action',
    actionLabel: 'Patient Defense',
    resource: 'focus_points',
  });
  if (!spent.ok) return spent.result;

  const dodging = setTurnFlag(spent.worldState, 'dodging', true, characterSheet);
  return {
    handled: true,
    logType: 'feature_patient_defense',
    worldState: dodging,
    reply: `You spend 1 Focus Point for **Patient Defense** and take the Dodge action as a Bonus Action. Focus Points left: ${remainingResourceText(dodging, characterSheet, 'focus_points')}.`,
  };
}

function resolveStepOfTheWind({ worldState = {}, characterSheet = {} } = {}) {
  const requirement = requireMonkFocus('Step of the Wind', worldState, characterSheet);
  if (requirement) return requirement;

  const spent = spendFeatureCost({
    worldState,
    characterSheet,
    actionResource: 'bonus_action',
    actionLabel: 'Step of the Wind',
    resource: 'focus_points',
  });
  if (!spent.ok) return spent.result;

  const speed = Number(characterSheet.derived_stats?.speed || spent.worldState.player_stats?.speed || 30);
  const disengaged = setTurnFlag(spent.worldState, 'disengaged', true, characterSheet);
  const dashed = grantMovement(disengaged, speed, 'Step of the Wind', characterSheet);
  return {
    handled: true,
    logType: 'feature_step_of_the_wind',
    worldState: dashed.worldState,
    reply: `You spend 1 Focus Point for **Step of the Wind**. As a Bonus Action, you Dash and Disengage; your jump distance is doubled for the turn. Focus Points left: ${remainingResourceText(dashed.worldState, characterSheet, 'focus_points')}.`,
  };
}

function resolveUncannyMetabolism({ worldState = {}, characterSheet = {}, rollDie = defaultRollDie } = {}) {
  if (!isClass(characterSheet, 'monk')) return wrongClass('Uncanny Metabolism', 'Monk', worldState);
  if (getCharacterLevel(characterSheet) < 2) {
    return {
      handled: true,
      logType: 'feature_uncanny_metabolism_level_required',
      worldState,
      reply: 'Uncanny Metabolism is a level 2 Monk feature. The body has not learned that particular impossible trick yet.',
    };
  }
  if (!worldState.combat_state?.active) {
    return {
      handled: true,
      logType: 'feature_uncanny_metabolism_combat_required',
      worldState,
      reply: 'Uncanny Metabolism triggers when a fight begins. Start or enter combat first, then the monk engine can do its unsettlingly healthy thing.',
    };
  }

  const resources = buildResourceState(characterSheet, worldState);
  if (Number(resources.uncanny_metabolism?.remaining || 0) <= 0) {
    return {
      handled: true,
      logType: 'feature_uncanny_metabolism_unavailable',
      worldState: mergeWorldResources(worldState, resources),
      reply: 'Uncanny Metabolism has already been used and returns after a Long Rest.',
    };
  }

  const spent = spendResource({ worldState, characterSheet, resource: 'uncanny_metabolism' });
  const refreshedResources = buildResourceState(characterSheet, spent.worldState);
  if (refreshedResources.focus_points) {
    refreshedResources.focus_points = {
      ...refreshedResources.focus_points,
      remaining: Number(refreshedResources.focus_points.max || 0),
    };
  }
  const refreshedState = mergeWorldResources(spent.worldState, refreshedResources);
  const level = getCharacterLevel(characterSheet);
  const healingRoll = rollDamageFormula(`1d6+${level}`, rollDie);
  const healed = healActiveCharacter(refreshedState, characterSheet, healingRoll.total);
  return {
    handled: true,
    logType: 'feature_uncanny_metabolism',
    worldState: healed.worldState,
    reply: `You use **Uncanny Metabolism**. Your Focus Points refill to ${Number(refreshedResources.focus_points?.remaining || 0)}/${Number(refreshedResources.focus_points?.max || 0)}, and you regain ${healed.applied} HP (${healingRoll.rolls.join(' + ')} + ${level}). Uses left: ${remainingResourceText(healed.worldState, characterSheet, 'uncanny_metabolism')}.`,
  };
}

function requireMonkFocus(feature, worldState = {}, characterSheet = {}) {
  if (!isClass(characterSheet, 'monk')) return wrongClass(feature, 'Monk', worldState);
  if (getCharacterLevel(characterSheet) < 2) {
    return {
      handled: true,
      logType: 'feature_monk_focus_level_required',
      worldState,
      reply: `${feature} requires Monk level 2. At level 1, Focus Points are still politely waiting offstage.`,
    };
  }
  if (!worldState.combat_state?.active) {
    return {
      handled: true,
      logType: 'feature_monk_focus_combat_required',
      worldState,
      reply: `${feature} matters during combat turns. Outside combat, move and act normally unless the scene creates a specific challenge.`,
    };
  }
  return null;
}

function requireClericChannelDivinity(feature, worldState = {}, characterSheet = {}) {
  if (!isClass(characterSheet, 'cleric')) return wrongClass(feature, 'Cleric', worldState);
  if (getCharacterLevel(characterSheet) < 2) {
    return {
      handled: true,
      logType: 'feature_cleric_channel_level_required',
      worldState,
      reply: `${feature} requires Cleric level 2. Level 1 faith is real, but the Channel Divinity breaker is not installed yet.`,
    };
  }
  return null;
}

function requireDruidWildShape(feature, worldState = {}, characterSheet = {}) {
  if (!isClass(characterSheet, 'druid')) return wrongClass(feature, 'Druid', worldState);
  if (getCharacterLevel(characterSheet) < 2) {
    return {
      handled: true,
      logType: 'feature_druid_wild_shape_level_required',
      worldState,
      reply: `${feature} requires Druid level 2. At level 1, nature likes you, but it has not handed over the transformation keys.`,
    };
  }
  return null;
}

function spendFeatureCost({ worldState = {}, characterSheet = {}, actionResource, actionLabel, resource, amount = 1 } = {}) {
  const resources = buildResourceState(characterSheet, worldState);
  if (Number(resources[resource]?.remaining || 0) < Number(amount || 1)) {
    return {
      ok: false,
      result: {
        handled: true,
        logType: 'feature_resource_unavailable',
        worldState: mergeWorldResources(worldState, resources),
        reply: `${actionLabel} is not available right now; the resource is spent until the appropriate rest restores it.`,
      },
    };
  }

  const spentAction = spendTurnResource(worldState, actionResource, actionLabel, characterSheet);
  if (!spentAction.ok) {
    return {
      ok: false,
      result: {
        handled: true,
        logType: 'feature_action_unavailable',
        worldState: spentAction.worldState,
        reply: spentAction.reply,
      },
    };
  }

  const spentResource = spendResource({ worldState: spentAction.worldState, characterSheet, resource, amount });
  return { ok: true, worldState: spentResource.worldState };
}

function getDivineSparkMode(message = '') {
  const text = String(message || '').toLowerCase();
  if (/\b(?:heal|restore|mend|recover|life|myself|me)\b/.test(text) && !/\b(?:damage|harm|hurt|blast|strike|radiant|necrotic|enemy|foe|undead)\b/.test(text)) {
    return 'heal';
  }
  if (/\b(?:damage|harm|hurt|blast|strike|radiant|necrotic|enemy|foe|undead|at|against)\b/.test(text)) {
    return 'damage';
  }
  return null;
}

function getFeatureTargetContext({ message = '', worldState = {}, allowFallback = false } = {}) {
  if (worldState.combat_state?.active) {
    const combat = cloneCombat(worldState.combat_state);
    const requested = normalizeId(inferTargetName(message));
    const hasRequestedTarget = Boolean(requested);
    const target = (combat.combatants || []).find((combatant) => (
      !combatant.is_player
      && Number(combatant.hp || 0) > 0
      && targetMatches(combatant, requested)
    ));
    if (target) return { combat, target, activeCombat: true };
    if (hasRequestedTarget) return null;
    const fallback = allowFallback
      ? (combat.combatants || []).find((combatant) => !combatant.is_player && Number(combatant.hp || 0) > 0)
      : null;
    return fallback ? { combat, target: fallback, activeCombat: true } : null;
  }

  const explicit = normalizeId(inferTargetName(message));
  const candidates = [
    ...(worldState.scene_presence?.present_npcs || []),
    ...(worldState.scene_target_states || []).map((target) => target.name),
  ].filter(Boolean);
  const matchedName = explicit
    ? candidates.find((candidate) => normalizeId(candidate) === explicit || normalizeId(candidate).includes(explicit) || explicit.includes(normalizeId(candidate)))
    : candidates.length === 1 ? candidates[0] : null;
  if (!matchedName) return null;
  const target = buildSceneFeatureTarget(matchedName, worldState);
  return {
    combat: { active: false, round: 0, turn_index: 0, combatants: [target] },
    target,
    activeCombat: false,
  };
}

function inferTargetName(message = '') {
  const match = String(message || '').match(/\b(?:at|to|on|against|targeting|harm|damage|blast|strike)\s+(?:the\s+|a\s+|an\s+)?([a-z][a-z' -]{1,40}?)(?:[.!?]|$|\s+(?:with|using|for|before|after|and|while|because)\b)/i);
  return cleanTargetName(match?.[1] || '');
}

function targetMatches(combatant = {}, requested = '') {
  if (!requested) return false;
  const names = [
    combatant.id,
    combatant.name,
    ...(combatant.aliases || []),
  ].map(normalizeId).filter(Boolean);
  return names.some((name) => name === requested || name.includes(requested) || requested.includes(name));
}

function buildSceneFeatureTarget(name, worldState = {}) {
  const existing = (worldState.scene_target_states || []).find((target) => normalizeId(target.name) === normalizeId(name)) || {};
  return {
    id: existing.id || normalizeId(name),
    name,
    hp: Number(existing.hp ?? existing.max_hp ?? 8),
    max_hp: Number(existing.max_hp ?? existing.hp ?? 8),
    ac: Number(existing.ac ?? 10),
    conditions: Array.isArray(existing.conditions) ? existing.conditions : [],
    saves: existing.saves || { str: 1, dex: 1, con: 1, int: 0, wis: 0, cha: 0 },
    resistances: existing.resistances || existing.damage_resistances || [],
    vulnerabilities: existing.vulnerabilities || existing.damage_vulnerabilities || [],
    immunities: existing.immunities || existing.damage_immunities || [],
    is_player: false,
    scene_target: true,
  };
}

function syncFeatureTargetCombat(worldState = {}, combat = {}, activeCombat = false) {
  if (activeCombat) {
    const enemiesAlive = (combat.combatants || []).some((combatant) => !combatant.is_player && Number(combatant.hp || 0) > 0);
    return {
      ...worldState,
      combat_state: enemiesAlive ? combat : null,
    };
  }

  const target = (combat.combatants || []).find((combatant) => !combatant.is_player);
  if (!target?.scene_target) return worldState;
  const existing = Array.isArray(worldState.scene_target_states) ? worldState.scene_target_states : [];
  const retained = existing.filter((item) => normalizeId(item.name) !== normalizeId(target.name));
  return {
    ...worldState,
    scene_target_states: [
      ...retained,
      {
        id: target.id || normalizeId(target.name),
        name: target.name,
        hp: target.hp,
        max_hp: target.max_hp,
        ac: target.ac,
        conditions: target.conditions || [],
        saves: target.saves || {},
      },
    ],
  };
}

function isUndeadCombatant(combatant = {}) {
  const values = [
    combatant.creature_type,
    combatant.type,
    combatant.kind,
    ...(combatant.tags || []),
    combatant.name,
  ].map(normalizeId).filter(Boolean);
  return values.some((value) => (
    value.includes('undead')
    || /\b(?:skeleton|zombie|wight|ghoul|ghost|specter|spectre|mummy|wraith|vampire)\b/.test(value.replaceAll('_', ' '))
  ));
}

function inferWildShapeForm(message = '') {
  const text = String(message || '').toLowerCase();
  const blocked = [
    ['dragon', 'dragon'],
    ['bear', 'bear'],
    ['eagle', 'eagle'],
    ['hawk', 'hawk'],
    ['raven', 'raven'],
    ['fish', 'fish'],
    ['shark', 'shark'],
    ['octopus', 'octopus'],
  ].find(([id]) => new RegExp(`\\b${id}\\b`).test(text));
  if (blocked) return { id: blocked[0], label: blocked[1], blocked: true };

  const allowed = [
    ['badger', 'badger'],
    ['cat', 'cat'],
    ['dog', 'dog'],
    ['mastiff', 'mastiff'],
    ['rat', 'rat'],
    ['spider', 'spider'],
    ['wolf', 'wolf'],
    ['goat', 'goat'],
    ['boar', 'boar'],
    ['scout_beast', 'scouting beast'],
  ];
  const found = allowed.find(([id, label]) => new RegExp(`\\b${id.replace('_', ' ')}\\b|\\b${label}\\b`).test(text));
  if (found) return { id: found[0], label: found[1], blocked: false };
  return { id: 'scout_beast', label: 'scouting beast', blocked: false };
}

function addCompanionToWorldState(worldState = {}, companionName = 'familiar') {
  const scene = worldState.scene_presence || {};
  const currentCompanions = Array.isArray(worldState.player_stats?.companions) ? worldState.player_stats.companions : [];
  return {
    ...worldState,
    player_stats: {
      ...(worldState.player_stats || {}),
      companions: [
        ...currentCompanions.filter((companion) => normalizeId(companion.id || companion.name) !== 'wild_companion_familiar'),
        { id: 'wild_companion_familiar', name: companionName, type: 'familiar', source: 'Wild Companion' },
      ],
    },
    scene_presence: scene.exact_location
      ? {
          ...scene,
          present_npcs: [...new Set([...(scene.present_npcs || []), companionName])],
        }
      : scene,
  };
}

function removeCompanionFromWorldState(worldState = {}, companionName = 'familiar') {
  const scene = worldState.scene_presence || {};
  const normalizedName = normalizeId(companionName);
  return {
    ...worldState,
    player_stats: {
      ...(worldState.player_stats || {}),
      companions: (worldState.player_stats?.companions || []).filter((companion) => (
        normalizeId(companion.id || companion.name) !== 'wild_companion_familiar'
      )),
    },
    scene_presence: {
      ...scene,
      present_npcs: (scene.present_npcs || []).filter((name) => normalizeId(name) !== normalizedName),
    },
  };
}

function isWildCompanionDismissal(message = '') {
  const text = String(message || '').toLowerCase();
  const hasFamiliarTarget = /\b(?:wild\s+companion|familiar)\b/.test(text);
  const hasDismissalVerb = /\b(?:dismiss|release|banish)\b/.test(text)
    || /\bsend\b.*\b(?:away|home|back)\b/.test(text);
  return hasFamiliarTarget && hasDismissalVerb;
}

function inferFamiliarName(worldState = {}) {
  const existing = worldState.player_stats?.companions?.find((companion) => companion.id === 'wild_companion_familiar');
  return existing?.name || 'familiar';
}

function healActiveCharacter(worldState = {}, characterSheet = {}, amount = 0) {
  const stats = worldState.player_stats || {};
  const combat = worldState.combat_state?.active ? cloneCombat(worldState.combat_state) : worldState.combat_state;
  const player = combat?.active ? combat.combatants.find((combatant) => combatant.is_player) : null;
  const maxHp = Number(player?.max_hp ?? stats.max_hp ?? characterSheet.derived_stats?.max_hp ?? stats.hp ?? 1);
  const target = player || {
    hp: stats.hp ?? characterSheet.derived_stats?.hp ?? maxHp,
    max_hp: maxHp,
  };
  const healed = applyHealing({ target, amount, maxHp });
  if (player) Object.assign(player, healed.target);

  return {
    ...healed,
    worldState: {
      ...worldState,
      combat_state: combat,
      player_stats: {
        ...stats,
        hp: healed.target.hp,
        max_hp: healed.target.max_hp,
      },
    },
  };
}

function addOrReplaceFeatureEffect(worldState = {}, effect, characterSheet = {}) {
  assertValidRulesEffects(effect.rules_effects || [], `rules effects for ${effect.id || 'class feature'}`);
  const activeEffects = Array.isArray(worldState.active_effects) ? worldState.active_effects : [];
  const retained = activeEffects.filter((item) => item.id !== effect.id);
  return applyActiveEffectsToWorldState(worldState, [...retained, effect], characterSheet);
}

function hasActiveEffect(worldState = {}, effectId) {
  return (worldState.active_effects || []).some((effect) => effect.id === effectId);
}

function remainingResourceText(worldState = {}, characterSheet = {}, resource) {
  const resources = buildResourceState(characterSheet, worldState);
  return String(Number(resources[resource]?.remaining || 0));
}

function parseHealingAmount(message = '') {
  const match = String(message || '').match(/\b(?:heal|restore|spend|use)\s+(\d+)\b|\b(\d+)\s*(?:hp|hit points?)\b/i);
  return Number(match?.[1] || match?.[2] || 0);
}

function getMissingHp(worldState = {}, characterSheet = {}) {
  const stats = worldState.player_stats || {};
  const hp = Number(stats.hp ?? characterSheet.derived_stats?.hp ?? characterSheet.derived_stats?.max_hp ?? 0);
  const maxHp = Number(stats.max_hp ?? characterSheet.derived_stats?.max_hp ?? hp);
  return Math.max(0, maxHp - hp);
}

function targetsSomeoneElse(message = '') {
  const text = String(message || '').toLowerCase();
  return /\b(?:on|to|heal)\s+(?:the\s+|a\s+|an\s+)?(guard|clerk|ally|friend|companion|npc|boy|girl|woman|man|reeve|innkeeper|priest)\b/.test(text)
    && !/\b(?:myself|me|self)\b/.test(text);
}

function inferBardicTarget(message = '', worldState = {}) {
  const match = String(message || '').match(/\b(?:inspire|bardic inspiration (?:to|on|for)|give bardic inspiration to)\s+(?:the\s+|a\s+|an\s+|my\s+|our\s+)?([a-z][a-z' -]{1,40}?)(?:[.!?]|$|\s+(?:with|before|after|and|while|because)\b)/i);
  if (match?.[1]) return cleanTargetName(match[1]);
  const present = [
    ...(worldState.scene_presence?.present_npcs || []),
    ...(worldState.scene_presence?.present_characters || []),
  ].filter(Boolean);
  return present.length === 1 ? present[0] : '';
}

function isSelfTarget(target = '', characterSheet = {}, worldState = {}) {
  const normalized = normalizeId(target);
  return ['self', 'me', 'myself', 'you'].includes(normalized)
    || normalized === normalizeId(actorName(characterSheet, worldState));
}

function wrongClass(feature, className, worldState = {}) {
  return {
    handled: true,
    logType: 'feature_wrong_class',
    worldState,
    reply: `${feature} is a ${className} feature and is not on this character sheet. The referee checked the pockets twice.`,
  };
}

function isClass(characterSheet = {}, classId) {
  return normalizeId(characterSheet.identity?.class || characterSheet.identity?.class_name) === classId;
}

function getCharacterLevel(characterSheet = {}) {
  return Number(characterSheet.identity?.level || characterSheet.derived_stats?.level || 1);
}

function actorName(characterSheet = {}, worldState = {}) {
  return characterSheet.identity?.name || worldState.player_stats?.name || 'You';
}

function cloneCombat(combatState = {}) {
  return JSON.parse(JSON.stringify(combatState));
}

function cleanTargetName(value = '') {
  return String(value || '')
    .replace(/\b(?:the|a|an|my|our)\b/gi, '')
    .trim();
}

function addCondition(conditions = [], condition) {
  return [...new Set([...(conditions || []), condition].filter(Boolean))];
}

function getSpellcastingModifier(characterSheet = {}) {
  const ability = characterSheet.spellcasting?.ability || 'wis';
  return Number(characterSheet.abilities?.modifiers?.[ability] || 0);
}

function getSpellSaveDc(characterSheet = {}) {
  return Number(characterSheet.derived_stats?.spell_save_dc || (8 + getSpellcastingModifier(characterSheet) + Number(characterSheet.derived_stats?.proficiency_bonus || 2)));
}

function formatSigned(value) {
  const number = Number(value || 0);
  return number >= 0 ? `+${number}` : String(number);
}

function articleFor(value = '') {
  return /^[aeiou]/i.test(String(value || '')) ? 'an' : 'a';
}

function titleCase(value = '') {
  return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function defaultRollDie(sides) {
  return rollDie(sides);
}

module.exports = {
  getFeatureIntent,
  resolveFeatureAction,
};
