const METAMAGIC = {
  careful_spell: { name: 'Careful Spell', cost: 1 },
  distant_spell: { name: 'Distant Spell', cost: 1 },
  empowered_spell: { name: 'Empowered Spell', cost: 1, compatible: true },
  extended_spell: { name: 'Extended Spell', cost: 1 },
  heightened_spell: { name: 'Heightened Spell', cost: 2 },
  quickened_spell: { name: 'Quickened Spell', cost: 2 },
  seeking_spell: { name: 'Seeking Spell', cost: 1, compatible: true },
  subtle_spell: { name: 'Subtle Spell', cost: 1 },
  transmuted_spell: { name: 'Transmuted Spell', cost: 1 },
  twinned_spell: { name: 'Twinned Spell', cost: 1 },
};

const DAMAGE_TYPES = ['acid', 'cold', 'fire', 'lightning', 'poison', 'thunder'];
const TRANSMUTABLE_SPELLS = new Set([
  'burning_hands',
  'chromatic_orb',
  'fire_bolt',
  'hellish_rebuke',
  'ice_knife',
  'poison_spray',
  'ray_of_frost',
  'ray_of_sickness',
  'shocking_grasp',
  'sorcerous_burst',
  'thunderclap',
  'thunderwave',
  'witch_bolt',
]);

function applyMetamagicToCast({ message = '', spell = {}, characterSheet = {} } = {}) {
  const requested = getRequestedMetamagic(message);
  if (!requested.length) return { ok: true, spell, characterSheet, notes: [] };

  if (normalizeId(characterSheet.identity?.class) !== 'sorcerer' || getLevel(characterSheet) < 2) {
    return blocked('Metamagic is a level 2 Sorcerer feature. No spell slot or Sorcery Point is spent.', spell, characterSheet);
  }

  const selected = new Set((characterSheet.class_choices?.metamagic || []).map(normalizeId));
  const unavailable = requested.filter((id) => !selected.has(id));
  if (unavailable.length) {
    return blocked(`${METAMAGIC[unavailable[0]].name} is not selected on this character sheet. No resources are spent.`, spell, characterSheet);
  }

  if (requested.length > 1 && requested.filter((id) => !METAMAGIC[id].compatible).length > 1) {
    return blocked('Only one Metamagic option can normally modify a spell; Empowered Spell and Seeking Spell are the exceptions. No resources are spent.', spell, characterSheet);
  }

  const validation = validateRequestedMetamagic(requested, message, spell);
  if (validation) return blocked(validation, spell, characterSheet);

  const cost = requested.reduce((sum, id) => sum + METAMAGIC[id].cost, 0);
  const resource = characterSheet.resources?.sorcery_points || { name: 'Sorcery Points', remaining: 0, max: getLevel(characterSheet), reset: 'long_rest' };
  if (Number(resource.remaining || 0) < cost) {
    return blocked(`That Metamagic combination costs ${cost} Sorcery Point${cost === 1 ? '' : 's'}, but only ${Number(resource.remaining || 0)} remain. No resources are spent.`, spell, characterSheet);
  }

  const metamagic = {
    options: requested,
    names: requested.map((id) => METAMAGIC[id].name),
    cost,
  };
  let modifiedSpell = { ...spell, metamagic };
  if (requested.includes('quickened_spell')) modifiedSpell.casting_time = 'Bonus Action';
  if (requested.includes('distant_spell')) modifiedSpell.range = extendRange(spell.range);
  if (requested.includes('extended_spell')) modifiedSpell.duration = extendDuration(spell.duration);
  if (requested.includes('heightened_spell')) modifiedSpell.metamagic.save_disadvantage = true;
  if (requested.includes('seeking_spell')) modifiedSpell.metamagic.seeking_reroll = true;
  if (requested.includes('empowered_spell')) modifiedSpell.metamagic.empowered_rerolls = Math.max(1, Number(characterSheet.abilities?.modifiers?.cha || 1));
  if (requested.includes('careful_spell')) modifiedSpell.metamagic.careful_spell = true;
  if (requested.includes('twinned_spell')) modifiedSpell.metamagic.twinned_spell = true;
  if (requested.includes('subtle_spell')) modifiedSpell.metamagic.subtle_spell = true;
  if (requested.includes('transmuted_spell')) modifiedSpell.metamagic.damage_type = inferDamageType(message);

  const nextSheet = {
    ...characterSheet,
    resources: {
      ...(characterSheet.resources || {}),
      sorcery_points: {
        ...resource,
        remaining: Number(resource.remaining || 0) - cost,
        max: Number(resource.max || getLevel(characterSheet)),
      },
    },
  };
  return {
    ok: true,
    spell: modifiedSpell,
    characterSheet: nextSheet,
    notes: [`${metamagic.names.join(' and ')} spends ${cost} Sorcery Point${cost === 1 ? '' : 's'} (${nextSheet.resources.sorcery_points.remaining}/${nextSheet.resources.sorcery_points.max} remaining).`],
  };
}

function getRequestedMetamagic(message = '') {
  const text = normalizeWords(message);
  return Object.entries(METAMAGIC)
    .filter(([id, option]) => text.includes(normalizeWords(option.name)) || text.includes(normalizeWords(id.replaceAll('_', ' '))))
    .map(([id]) => id);
}

function validateRequestedMetamagic(requested, message, spell) {
  if (requested.includes('quickened_spell') && !/^action$/i.test(String(spell.casting_time || ''))) {
    return `Quickened Spell requires a spell with an Action casting time; ${spell.name} uses ${spell.casting_time || 'another casting time'}. No resources are spent.`;
  }
  if (requested.includes('extended_spell') && !hasTimedDuration(spell.duration)) {
    return `Extended Spell requires a spell lasting at least 1 minute; ${spell.name} is ${spell.duration || 'instantaneous'}. No resources are spent.`;
  }
  if (requested.includes('heightened_spell') && !isSavingThrowSpell(spell)) {
    return `Heightened Spell requires a spell that forces a saving throw; ${spell.name} does not use one in the current rules catalog. No resources are spent.`;
  }
  if (requested.includes('seeking_spell') && !isSpellAttack(spell)) {
    return `Seeking Spell requires a spell attack roll; ${spell.name} does not make one. No resources are spent.`;
  }
  if (requested.includes('transmuted_spell') && !TRANSMUTABLE_SPELLS.has(normalizeId(spell.id))) {
    return `Transmuted Spell requires a spell dealing acid, cold, fire, lightning, poison, or thunder damage; ${spell.name} does not qualify. No resources are spent.`;
  }
  if (requested.includes('transmuted_spell') && !inferDamageType(message)) {
    return `Transmuted Spell needs a new damage type: ${DAMAGE_TYPES.join(', ')}. No resources are spent.`;
  }
  if (requested.includes('careful_spell')) {
    return 'Careful Spell requires explicit protected creatures inside a multi-target area. That target model is not exposed in the current mapless scene rules, so this cast is blocked and no resources are spent.';
  }
  if (requested.includes('twinned_spell')) {
    return 'Twinned Spell requires a qualifying higher-level extra-target rule and two explicit targets. That multi-target spell path is not exposed yet, so this cast is blocked and no resources are spent.';
  }
  return null;
}

function isSpellAttack(spell = {}) {
  return spell.attack_type === 'spell_attack';
}

function isSavingThrowSpell(spell = {}) {
  return spell.attack_type === 'save';
}

function hasTimedDuration(duration = '') {
  return /(?:minute|hour|day)/i.test(duration) && !/^instant/i.test(duration);
}

function inferDamageType(message = '') {
  const text = normalizeWords(message);
  return DAMAGE_TYPES.find((type) => new RegExp(`(?:as|into|to|with) ${type}(?: damage)?(?: |$)`).test(text)) || null;
}

function extendRange(range = '') {
  if (/touch/i.test(range)) return '30 ft';
  const match = String(range).match(/(\d+)\s*ft/i);
  return match ? String(range).replace(match[0], `${Number(match[1]) * 2} ft`) : range;
}

function extendDuration(duration = '') {
  return String(duration || '').replace(/(\d+)\s*(minute|hour|day)s?/i, (_, count, unit) => {
    const normalizedUnit = unit.toLowerCase();
    const minutesPerUnit = normalizedUnit === 'day' ? 1440 : normalizedUnit === 'hour' ? 60 : 1;
    const doubledMinutes = Math.min(Number(count) * minutesPerUnit * 2, 1440);
    if (doubledMinutes === 1440) return '1 day';
    if (doubledMinutes % 60 === 0) return `${doubledMinutes / 60} hours`;
    return `${doubledMinutes} minutes`;
  });
}

function blocked(reply, spell, characterSheet) {
  return { ok: false, blocked: true, reply, spell, characterSheet };
}

function getLevel(characterSheet = {}) {
  return Number(characterSheet.identity?.level || characterSheet.derived_stats?.level || 1);
}

function normalizeWords(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeId(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

module.exports = {
  METAMAGIC,
  applyMetamagicToCast,
  getRequestedMetamagic,
};
