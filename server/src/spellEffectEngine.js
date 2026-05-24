const CONCENTRATION_DURATIONS = {
  bless: 'Concentration, up to 1 minute',
  dancing_lights: 'Concentration, up to 1 minute',
  detect_magic: 'Concentration, up to 10 minutes',
  divine_favor: 'Concentration, up to 1 minute',
  faerie_fire: 'Concentration, up to 1 minute',
  guidance: 'Concentration, up to 1 minute',
  hex: 'Concentration, up to 1 hour',
  hunter_mark: 'Concentration, up to 1 hour',
  searing_smite: 'Concentration, up to 1 minute',
  shield_of_faith: 'Concentration, up to 10 minutes',
};

function resolveSpellCast({ message, content, characterSheet, worldState = {} }) {
  const spell = getCastSpellFromMessage(message, content);
  if (!spell) return null;

  const known = getKnownSpellInfo(characterSheet, spell);
  if (spell.unknown || !known.known) {
    return {
      matched: true,
      blocked: true,
      reply: `You reach for ${spell.name}, but it is not on your current character sheet. At level ${characterSheet?.identity?.level || 1}, you can work with: ${summarizeKnownSpells(characterSheet, content)}. The magic shelves are not self-service.`,
    };
  }

  const resource = spendSpellResource(characterSheet, spell, known);
  if (!resource.ok) {
    return {
      matched: true,
      blocked: true,
      reply: resource.reply,
    };
  }

  let nextSheet = resource.characterSheet;
  let nextWorldState = {
    ...worldState,
    player_stats: {
      ...(worldState.player_stats || {}),
      spell_slots: nextSheet.spellcasting?.slots || worldState.player_stats?.spell_slots || {},
    },
  };

  const currentEffects = normalizeEffects(
    Array.isArray(worldState.active_effects)
      ? worldState.active_effects
      : nextSheet.derived_stats?.active_spell_effects || [],
  );
  const spellEffect = buildSpellEffect(nextSheet, spell, known);
  if (spellEffect) {
    const retainedEffects = spellEffect.concentration
      ? currentEffects.filter((effect) => !effect.concentration)
      : currentEffects.filter((effect) => effect.id !== spell.id);
    const nextEffects = [...retainedEffects, spellEffect];
    nextSheet = applyActiveEffectsToCharacterSheet(nextSheet, nextEffects);
    nextWorldState = applyActiveEffectsToWorldState(nextWorldState, nextEffects, nextSheet);
  } else {
    nextSheet = applyActiveEffectsToCharacterSheet(nextSheet, currentEffects);
    nextWorldState = applyActiveEffectsToWorldState(nextWorldState, currentEffects, nextSheet);
  }

  return {
    matched: true,
    blocked: false,
    spell,
    characterSheet: nextSheet,
    worldState: nextWorldState,
    resourceNote: resource.note,
  };
}

function getCastSpellFromMessage(message, content) {
  const match = String(message || '').match(/\bcast\s+(?:the\s+)?([a-z][a-z' -]{2,40})/i);
  if (!match) return null;
  const spoken = normalizeSpellName(match[1].replace(/\b(on|at|toward|towards|to|for|with|and)\b.*$/i, ''));
  if (!spoken) return null;
  const spell = content.spells.find((item) => normalizeSpellName(item.name) === spoken || normalizeSpellName(item.id) === spoken);
  return spell || { id: spoken.replaceAll(' ', '_'), name: spoken.replace(/\b\w/g, (char) => char.toUpperCase()), unknown: true };
}

function normalizeSpellName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getKnownSpellInfo(characterSheet = {}, spell = {}) {
  if (!spell || spell.unknown) return { known: false };
  const cantrips = new Set(characterSheet.spellcasting?.cantrips_known || []);
  const classSpells = new Set(characterSheet.spellcasting?.spells_prepared || characterSheet.spellcasting?.spells_known || []);
  const speciesSpell = (characterSheet.species_spells || []).find((entry) => (entry.id || entry) === spell.id);
  const originEntry = Object.entries(characterSheet.origin?.magic_initiate || {})
    .find(([, choice]) => (choice.cantrips || []).includes(spell.id) || choice.spell === spell.id);

  if (cantrips.has(spell.id)) return { known: true, type: 'class_cantrip', label: 'class cantrip' };
  if (classSpells.has(spell.id)) return { known: true, type: 'class_spell', label: 'prepared class spell' };
  if (speciesSpell) return { known: true, type: 'species_spell', label: `${speciesSpell.source || 'species'} spell` };
  if (originEntry) {
    const [source, choice] = originEntry;
    const isCantrip = (choice.cantrips || []).includes(spell.id);
    return {
      known: true,
      type: isCantrip ? 'origin_cantrip' : 'origin_spell',
      source,
      label: isCantrip ? 'Origin feat cantrip' : 'Origin feat spell',
    };
  }
  return { known: false };
}

function getKnownSpellIds(characterSheet = {}) {
  const ids = new Set([
    ...(characterSheet.spellcasting?.cantrips_known || []),
    ...(characterSheet.spellcasting?.spells_prepared || characterSheet.spellcasting?.spells_known || []),
    ...(characterSheet.species_spells || []).map((spell) => spell.id || spell),
  ]);
  for (const choice of Object.values(characterSheet.origin?.magic_initiate || {})) {
    for (const cantrip of choice.cantrips || []) ids.add(cantrip);
    if (choice.spell) ids.add(choice.spell);
  }
  return ids;
}

function summarizeKnownSpells(characterSheet, content) {
  const ids = [...getKnownSpellIds(characterSheet)];
  return ids.map((id) => content.spells.find((spell) => spell.id === id)?.name || id).join(', ') || 'no spells';
}

function spendSpellResource(characterSheet = {}, spell = {}, known = {}) {
  if (Number(spell.level || 0) <= 0) {
    return { ok: true, characterSheet, note: 'cantrip/no slot' };
  }

  const slotKey = String(spell.level);
  const currentSlots = characterSheet.spellcasting?.slots || {};
  const remainingSlots = Number(currentSlots[slotKey] || 0);
  if (remainingSlots > 0) {
    return {
      ok: true,
      note: `spent level ${slotKey} spell slot`,
      characterSheet: {
        ...characterSheet,
        spellcasting: {
          ...(characterSheet.spellcasting || {}),
          slots: {
            ...currentSlots,
            [slotKey]: remainingSlots - 1,
          },
        },
      },
    };
  }

  if (known.type === 'origin_spell' || known.type === 'species_spell') {
    return spendLimitedSpellUse(characterSheet, spell, known);
  }

  return {
    ok: false,
    reply: `You know ${spell.name}, but you do not have a level ${slotKey} spell slot left to cast it. Even magic keeps receipts.`,
  };
}

function spendLimitedSpellUse(characterSheet, spell, known) {
  const resourceKey = `${known.type}:${known.source || 'default'}:${spell.id}`;
  const spellUses = characterSheet.resources?.spell_uses || {};
  const currentUse = spellUses[resourceKey] || {
    name: spell.name,
    remaining: 1,
    max: 1,
    reset: 'long_rest',
  };
  if (Number(currentUse.remaining || 0) <= 0) {
    return {
      ok: false,
      reply: `${spell.name} is available through ${known.label}, but that once-per-rest use is already spent. The spell politely refuses to be double-booked.`,
    };
  }
  return {
    ok: true,
    note: `spent ${known.label}`,
    characterSheet: {
      ...characterSheet,
      resources: {
        ...(characterSheet.resources || {}),
        spell_uses: {
          ...spellUses,
          [resourceKey]: {
            ...currentUse,
            remaining: Number(currentUse.remaining || 0) - 1,
          },
        },
      },
    },
  };
}

function buildSpellEffect(characterSheet, spell, known) {
  if (!spellHasDuration(spell)) return null;
  const actor = characterSheet.identity?.name || 'active character';
  const duration = normalizeSpellDuration(spell);
  return {
    id: spell.id,
    name: spell.name,
    source: actor,
    source_type: 'spell',
    spell_source: known.label,
    target: spell.range === 'Self' ? actor : 'current scene target',
    duration,
    concentration: isConcentrationDuration(duration),
    mechanical_effect: spell.description,
    rules_effects: getRulesEffectsForSpell(spell),
    ...durationToRemaining(duration),
  };
}

function spellHasDuration(spell) {
  return spell?.duration && !/^instant$/i.test(spell.duration);
}

function normalizeSpellDuration(spell) {
  if (!spell) return '';
  if (/^concentration$/i.test(spell.duration || '') && CONCENTRATION_DURATIONS[spell.id]) {
    return CONCENTRATION_DURATIONS[spell.id];
  }
  return spell.duration || '';
}

function isConcentrationDuration(duration = '') {
  return /concentration/i.test(duration);
}

function durationToRemaining(duration = '') {
  const minuteMatch = duration.match(/(\d+)\s*minute/i);
  if (minuteMatch) {
    const minutes = Number(minuteMatch[1]);
    return { remaining_minutes: minutes, remaining_rounds: minutes * 10 };
  }
  const hourMatch = duration.match(/(\d+)\s*hour/i);
  if (hourMatch) {
    const hours = Number(hourMatch[1]);
    return { remaining_minutes: hours * 60, remaining_rounds: hours * 600 };
  }
  if (/1 round/i.test(duration)) return { remaining_rounds: 1 };
  return {};
}

function getRulesEffectsForSpell(spell) {
  if (spell.id === 'shield_of_faith') {
    return [{ target: 'armor_class_bonus', value: 2, label: 'Shield of Faith' }];
  }
  return [];
}

function tickActiveEffects(worldState = {}, { rounds = 0, minutes = 0 } = {}) {
  const effects = normalizeEffects(worldState.active_effects || []);
  if (effects.length === 0 || (rounds <= 0 && minutes <= 0)) {
    return { worldState, expiredEffects: [] };
  }

  const elapsedRounds = Number(rounds || 0) + Number(minutes || 0) * 10;
  const expiredEffects = [];
  const nextEffects = [];

  for (const effect of effects) {
    const nextEffect = { ...effect };
    if (nextEffect.remaining_rounds != null) {
      nextEffect.remaining_rounds = Math.max(0, Number(nextEffect.remaining_rounds) - elapsedRounds);
      nextEffect.remaining_minutes = Math.ceil(nextEffect.remaining_rounds / 10);
    } else if (nextEffect.remaining_minutes != null && minutes > 0) {
      nextEffect.remaining_minutes = Math.max(0, Number(nextEffect.remaining_minutes) - Number(minutes));
    }

    if (nextEffect.remaining_rounds === 0 || nextEffect.remaining_minutes === 0) {
      expiredEffects.push(nextEffect);
    } else {
      nextEffects.push(nextEffect);
    }
  }

  return {
    worldState: applyActiveEffectsToWorldState(worldState, nextEffects),
    expiredEffects,
  };
}

function applyActiveEffectsToCharacterSheet(characterSheet = {}, effects = []) {
  const normalizedEffects = normalizeEffects(effects);
  const derived = characterSheet.derived_stats || {};
  const currentBreakdown = derived.armor_class_breakdown || [];
  const currentSpellArmorBonus = sumSpellArmorBreakdown(currentBreakdown);
  const baseArmorClass = Number(
    derived.base_armor_class
      ?? (Number(derived.armor_class || 10) - currentSpellArmorBonus),
  );
  const spellArmorBonus = sumArmorBonusEffects(normalizedEffects);
  return {
    ...characterSheet,
    derived_stats: {
      ...derived,
      base_armor_class: baseArmorClass,
      armor_class: baseArmorClass + spellArmorBonus,
      armor_class_breakdown: [
        ...currentBreakdown.filter((part) => !isSpellArmorBreakdown(part)),
        ...buildSpellArmorBreakdown(normalizedEffects),
      ],
      active_spell_effects: normalizedEffects,
    },
  };
}

function applyActiveEffectsToWorldState(worldState = {}, effects = [], characterSheet = null) {
  const normalizedEffects = normalizeEffects(effects);
  const stats = worldState.player_stats || {};
  const currentSpellArmorBonus = sumArmorBonusEffects(worldState.active_effects || []);
  const sheetArmor = characterSheet?.derived_stats?.armor_class;
  const baseArmorClass = Number(
    stats.base_armor_class
      ?? characterSheet?.derived_stats?.base_armor_class
      ?? ((stats.armor_class ?? sheetArmor ?? 10) - currentSpellArmorBonus),
  );
  const spellArmorBonus = sumArmorBonusEffects(normalizedEffects);
  return {
    ...worldState,
    active_effects: normalizedEffects,
    player_stats: {
      ...stats,
      base_armor_class: baseArmorClass,
      armor_class: baseArmorClass + spellArmorBonus,
      spell_slots: characterSheet?.spellcasting?.slots || stats.spell_slots || {},
    },
  };
}

function normalizeEffects(effects = []) {
  return (Array.isArray(effects) ? effects : []).map((effect) => ({
    ...effect,
    rules_effects: Array.isArray(effect.rules_effects) ? effect.rules_effects : getRulesEffectsForSpell(effect),
  }));
}

function sumArmorBonusEffects(effects = []) {
  return normalizeEffects(effects)
    .flatMap((effect) => effect.rules_effects || [])
    .filter((effect) => effect.target === 'armor_class_bonus')
    .reduce((sum, effect) => sum + Number(effect.value || 0), 0);
}

function buildSpellArmorBreakdown(effects = []) {
  return normalizeEffects(effects)
    .flatMap((effect) => (effect.rules_effects || [])
      .filter((rule) => rule.target === 'armor_class_bonus')
      .map((rule) => ({
        label: rule.label || effect.name || 'Spell effect',
        value: Number(rule.value || 0),
        source: 'spell_effect',
        effect_id: effect.id,
      })));
}

function sumSpellArmorBreakdown(parts = []) {
  return parts
    .filter(isSpellArmorBreakdown)
    .reduce((sum, part) => sum + Number(part.value || 0), 0);
}

function isSpellArmorBreakdown(part = {}) {
  return part.source === 'spell_effect'
    || Boolean(part.effect_id)
    || part.label === 'Shield of Faith';
}

module.exports = {
  resolveSpellCast,
  getCastSpellFromMessage,
  getKnownSpellIds,
  summarizeKnownSpells,
  tickActiveEffects,
  applyActiveEffectsToCharacterSheet,
  applyActiveEffectsToWorldState,
  durationToRemaining,
};
