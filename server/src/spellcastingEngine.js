const { getSpellActionResource } = require('./actionEconomy');
const { applyMetamagicToCast } = require('./metamagicEngine');

const GUIDANCE_SKILLS = [
  ['animal_handling', /\banimal\s+handling\b/i],
  ['sleight_of_hand', /\bsleight\s+of\s+hand\b/i],
  ['acrobatics', /\bacrobatics?\b/i],
  ['arcana', /\barcana\b/i],
  ['athletics', /\bathletics?\b/i],
  ['deception', /\bdeception\b/i],
  ['history', /\bhistory\b/i],
  ['insight', /\binsight\b/i],
  ['intimidation', /\bintimidation\b/i],
  ['investigation', /\binvestigation\b/i],
  ['medicine', /\bmedicine\b/i],
  ['nature', /\bnature\b/i],
  ['perception', /\bperception\b/i],
  ['performance', /\bperformance\b/i],
  ['persuasion', /\bpersuasion\b/i],
  ['religion', /\breligion\b/i],
  ['stealth', /\bstealth\b/i],
  ['survival', /\bsurvival\b/i],
];

function resolveSpellCastLegality({ message, content = {}, characterSheet = {}, worldState = {} } = {}) {
  const spell = getCastSpellFromMessage(message, content);
  if (!spell) return null;

  const known = getKnownSpellInfo(characterSheet, spell);
  if (spell.unknown || !known.known) {
    return {
      matched: true,
      blocked: true,
      spell,
      known,
      reply: buildUnknownSpellReply({ spell, known, characterSheet, content }),
    };
  }

  const metamagic = applyMetamagicToCast({ message, spell, characterSheet, worldState });
  if (!metamagic.ok) {
    return {
      matched: true,
      blocked: true,
      spell,
      known,
      reply: metamagic.reply,
    };
  }
  const modifiedSpell = metamagic.spell;
  const timingBlock = validateSpellTiming({ spell: modifiedSpell, message, worldState, characterSheet: metamagic.characterSheet });
  if (timingBlock) {
    return {
      matched: true,
      blocked: true,
      spell: modifiedSpell,
      known,
      reply: timingBlock,
    };
  }

  const resource = spendSpellResource(metamagic.characterSheet, modifiedSpell, known, { message });
  if (!resource.ok) {
    return {
      matched: true,
      blocked: true,
      spell: modifiedSpell,
      known,
      reply: resource.reply,
    };
  }

  if (/^spent level \d+ spell slot$/i.test(resource.note || '') && worldState.combat_state?.turn_resources?.spell_slot_spent) {
    return {
      matched: true,
      blocked: true,
      spell: modifiedSpell,
      known,
      reply: 'You have already expended a spell slot on this turn. You can still cast a cantrip if your action economy permits it, but another slotted spell must wait until a later turn.',
    };
  }

  return {
    matched: true,
    blocked: false,
    message,
    spell: modifiedSpell,
    known,
    characterSheet: resource.characterSheet,
    resourceNote: [resource.note, ...(metamagic.notes || [])].filter(Boolean).join(' '),
  };
}

function getCastSpellFromMessage(message, content = {}) {
  const match = String(message || '').match(/\bcast\s+(?:the\s+)?([a-z][a-z' -]{2,120})/i);
  if (!match) return null;
  const spokenTail = normalizeSpellName(match[1]);
  const knownPrefix = (content.spells || [])
    .map((spell) => ({ spell, names: [normalizeSpellName(spell.name), normalizeSpellName(spell.id)].filter(Boolean) }))
    .flatMap(({ spell, names }) => names.map((name) => ({ spell, name })))
    .filter(({ name }) => spokenTail === name || spokenTail.startsWith(`${name} `))
    .sort((left, right) => right.name.length - left.name.length)[0];
  if (knownPrefix) return knownPrefix.spell;

  const spoken = normalizeSpellName(match[1].replace(/\b(on|at|toward|towards|to|for|with|and|as|using)\b.*$/i, ''));
  if (!spoken) return null;
  const spell = (content.spells || []).find((item) => normalizeSpellName(item.name) === spoken || normalizeSpellName(item.id) === spoken);
  return spell || { id: spoken.replaceAll(' ', '_'), name: spoken.replace(/\b\w/g, (char) => char.toUpperCase()), unknown: true };
}

function normalizeSpellName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getKnownSpellInfo(characterSheet = {}, spell = {}) {
  if (!spell || spell.unknown) return { known: false, reason: 'unknown' };
  const spellcasting = characterSheet.spellcasting || {};
  const cantrips = new Set(spellcasting.cantrips_known || []);
  const alwaysPrepared = new Set(spellcasting.always_prepared_spells || []);
  const classSpells = new Set(spellcasting.spells_prepared || []);
  const spellbook = new Set(spellcasting.spellbook_spells || []);
  const ritualSpells = new Set(spellcasting.ritual_spells || []);
  const classChoiceSpell = [
    ...(characterSheet.class_choice_spells || []),
    ...(spellcasting.class_choice_spells || []),
  ].find((entry) => (entry.id || entry) === spell.id);
  const speciesSpell = (characterSheet.species_spells || []).find((entry) => (entry.id || entry) === spell.id);
  const originEntry = Object.entries(characterSheet.origin?.magic_initiate || {})
    .find(([, choice]) => (choice.cantrips || []).includes(spell.id) || choice.spell === spell.id);

  if (cantrips.has(spell.id)) return { known: true, type: 'class_cantrip', label: 'class cantrip' };
  if (alwaysPrepared.has(spell.id)) {
    const resourceEntry = findLimitedSpellUse(characterSheet, spell);
    if (resourceEntry) {
      return {
        known: true,
        type: 'class_feature_spell',
        source: resourceEntry[1].source || 'class_feature',
        label: resourceEntry[1].source_name || 'class feature',
      };
    }
    return { known: true, type: 'always_prepared_class_spell', label: 'always-prepared class spell' };
  }
  if (classSpells.has(spell.id)) return { known: true, type: 'class_spell', label: 'prepared class spell' };
  if (classChoiceSpell) {
    return {
      known: true,
      type: 'class_choice_spell',
      choiceType: classChoiceSpell.type,
      source: classChoiceSpell.source,
      label: `${classChoiceSpell.source || 'class choice'} spell`,
    };
  }
  if (speciesSpell) {
    return {
      known: true,
      type: 'species_spell',
      source: speciesSpell.source,
      ability: speciesSpell.ability || null,
      label: `${speciesSpell.source || 'species'} spell`,
    };
  }
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
  if (spell.ritual && (ritualSpells.has(spell.id) || isWizardSpellbookRitual(characterSheet, spell))) {
    return { known: true, type: 'ritual_spell', label: 'ritual spell', ritualOnly: true };
  }
  if (spellbook.has(spell.id)) {
    return {
      known: false,
      reason: 'not_prepared',
      label: 'spellbook spell',
    };
  }
  return { known: false, reason: 'not_known' };
}

function getKnownSpellIds(characterSheet = {}, { includeRitualOnly = true } = {}) {
  const spellcasting = characterSheet.spellcasting || {};
  const ids = new Set([
    ...(spellcasting.cantrips_known || []),
    ...(spellcasting.spells_prepared || []),
    ...(spellcasting.always_prepared_spells || []),
    ...(characterSheet.class_choice_spells || []).map((spell) => spell.id || spell),
    ...(spellcasting.class_choice_spells || []).map((spell) => spell.id || spell),
    ...(characterSheet.species_spells || []).map((spell) => spell.id || spell),
  ]);
  if (includeRitualOnly) {
    for (const id of spellcasting.ritual_spells || []) ids.add(id);
    for (const id of spellcasting.spellbook_spells || []) ids.add(id);
  }
  for (const choice of Object.values(characterSheet.origin?.magic_initiate || {})) {
    for (const cantrip of choice.cantrips || []) ids.add(cantrip);
    if (choice.spell) ids.add(choice.spell);
  }
  return ids;
}

function summarizeKnownSpells(characterSheet = {}, content = {}) {
  const ids = [...getKnownSpellIds(characterSheet, { includeRitualOnly: true })];
  return ids.map((id) => (content.spells || []).find((spell) => spell.id === id)?.name || id).join(', ') || 'no spells';
}

function validateSpellTiming({ spell, message, worldState = {}, characterSheet = {} }) {
  if (spell.id === 'divine_smite') {
    return 'Divine Smite is cast immediately after a melee weapon hit. Declare it with the attack, such as "I attack the cultist with my longsword and use Divine Smite." No resource is spent yet.';
  }

  if (spell.id === 'mage_armor' && characterSheet?.equipped?.armor) {
    return 'Mage Armor only works on a creature that is not wearing armor. Your current armor is already doing the job, and it is not interested in being replaced by sparkle math.';
  }

  if (spell.id === 'guidance' && !inferGuidanceSkill(message)) {
    return 'Guidance needs a specific skill in 2024 rules. Try something like "I cast Guidance for Stealth" or "Guidance for Persuasion." The gods are helpful, but they do enjoy a form field.';
  }

  if (worldState.combat_state?.active && /^\s*\d+\s*(?:minute|hour)/i.test(spell.casting_time || '')) {
    return `${spell.name} takes ${spell.casting_time} to cast. That is not a single combat action; you would need to spend the required rounds maintaining the casting. The initiative tracker has opinions about paperwork.`;
  }

  if (/reaction/i.test(spell.casting_time || '') && !hasMatchingReactionWindow(worldState, spell)) {
    return `${spell.name} is a Reaction spell. You can cast it when the referee opens its trigger window, not as a casual pre-emptive vibe check.`;
  }

  return null;
}

function hasMatchingReactionWindow(worldState = {}, spell = {}) {
  return Boolean(worldState.pending_reaction?.options?.some((option) => (
    option.type === 'cast_spell' && option.spell_id === spell.id
  )));
}

function spendSpellResource(characterSheet = {}, spell = {}, known = {}, { message = '' } = {}) {
  if (Number(spell.level || 0) <= 0) {
    return { ok: true, characterSheet, note: 'cantrip/no slot' };
  }
  if (known.type === 'class_choice_spell' && ['ritual', 'at_will'].includes(known.choiceType)) {
    return { ok: true, characterSheet, note: `${known.choiceType} class choice spell/no slot` };
  }
  if (known.type === 'ritual_spell' || isRitualCast({ message, spell, known })) {
    return { ok: true, characterSheet, note: 'ritual/no slot' };
  }

  let limitedFailure = null;
  if (known.type === 'origin_spell' || known.type === 'species_spell' || known.type === 'class_feature_spell') {
    const limited = spendLimitedSpellUse(characterSheet, spell, known);
    if (limited.ok) return limited;
    limitedFailure = limited;
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

  if (limitedFailure) return limitedFailure;

  return {
    ok: false,
    reply: `You know ${spell.name}, but you do not have a level ${slotKey} spell slot left to cast it. Even magic keeps receipts.`,
  };
}

function spendLimitedSpellUse(characterSheet = {}, spell = {}, known = {}) {
  const resourceType = known.type === 'class_feature_spell' ? 'class_feature' : known.type;
  const resourceKey = `${resourceType}:${known.source || 'default'}:${spell.id}`;
  const spellUses = characterSheet.resources?.spell_uses || {};
  const currentUse = spellUses[resourceKey] || {
    name: spell.name,
    spell_id: spell.id,
    source: known.source || 'default',
    source_name: known.label || 'limited spell use',
    remaining: 1,
    max: 1,
    reset: 'long_rest',
  };
  if (Number(currentUse.remaining || 0) <= 0) {
    const resetText = String(currentUse.reset || 'rest').replaceAll('_', ' ');
    return {
      ok: false,
      reply: `${spell.name} is available through ${known.label}, but that limited use is already spent until your next ${resetText}. The spell politely refuses to be double-booked.`,
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

function buildSpellcastingSnapshot(characterSheet = {}, content = {}) {
  const ids = [...getKnownSpellIds(characterSheet, { includeRitualOnly: true })];
  return {
    ability: characterSheet.spellcasting?.ability || null,
    slots: characterSheet.spellcasting?.slots || {},
    spells: ids.map((id) => {
      const spell = (content.spells || []).find((item) => item.id === id) || { id, name: id };
      const known = getKnownSpellInfo(characterSheet, spell);
      return {
        id,
        name: spell.name || id,
        level: spell.level,
        casting_time: spell.casting_time,
        ritual: Boolean(spell.ritual),
        prepared: known.known && !known.ritualOnly,
        ritual_only: Boolean(known.ritualOnly),
        label: known.label || null,
      };
    }),
  };
}

function buildUnknownSpellReply({ spell, known, characterSheet, content }) {
  if (known?.reason === 'not_prepared') {
    return `${spell.name} is in your spellbook, but it is not prepared right now${spell.ritual ? ' as a normal casting' : ''}. Prepare it after a Long Rest before casting it with a slot. The book may contain the recipe; your brain still needs the tab open.`;
  }
  return `You reach for ${spell.name}, but it is not on your current character sheet. At level ${characterSheet?.identity?.level || 1}, you can work with: ${summarizeKnownSpells(characterSheet, content)}. The magic shelves are not self-service.`;
}

function findLimitedSpellUse(characterSheet = {}, spell = {}) {
  return Object.entries(characterSheet.resources?.spell_uses || {})
    .find(([, use]) => use.spell_id === spell.id);
}

function isWizardSpellbookRitual(characterSheet = {}, spell = {}) {
  const identity = characterSheet.identity || {};
  return identity.class === 'wizard'
    && Boolean(spell.ritual)
    && (characterSheet.spellcasting?.spellbook_spells || []).includes(spell.id);
}

function isRitualCast({ message = '', spell = {}, known = {} } = {}) {
  if (!spell.ritual) return false;
  if (!/\britual\b/i.test(message || '')) return false;
  return ['class_spell', 'always_prepared_class_spell', 'ritual_spell'].includes(known.type);
}

function inferGuidanceSkill(message = '') {
  const text = String(message || '');
  const match = GUIDANCE_SKILLS.find(([, pattern]) => pattern.test(text));
  return match?.[0] || null;
}

function formatGuidanceLabel(skill = null) {
  if (!skill) return 'Guidance';
  return `Guidance (${skill.replaceAll('_', ' ')})`;
}

module.exports = {
  resolveSpellCastLegality,
  getCastSpellFromMessage,
  normalizeSpellName,
  getKnownSpellInfo,
  getKnownSpellIds,
  summarizeKnownSpells,
  validateSpellTiming,
  spendSpellResource,
  spendLimitedSpellUse,
  buildSpellcastingSnapshot,
  inferGuidanceSkill,
  formatGuidanceLabel,
  getSpellActionResource,
};
