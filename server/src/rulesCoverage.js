const fs = require('fs');
const path = require('path');
const { getContentBundle } = require('./contentData');

const STATUS = {
  IMPLEMENTED: 'implemented',
  PARTIAL: 'partial',
  DEFERRED: 'deferred',
  NOT_EXPOSED: 'not_exposed',
};

const STATUS_VALUES = new Set(Object.values(STATUS));
const CATALOG_PATH = path.join(__dirname, '../data/rules_coverage_catalog.json');
const DEFAULT_CATALOG = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));

const ACTION_ORDER = [
  'attack',
  'dash',
  'disengage',
  'dodge',
  'grapple',
  'help',
  'hide',
  'influence',
  'magic',
  'object_interaction',
  'opportunity_attack',
  'ready',
  'search',
  'shove',
  'study',
  'utilize',
];

const CORE_CONDITIONS = [
  'blinded',
  'charmed',
  'deafened',
  'exhaustion',
  'frightened',
  'grappled',
  'hidden',
  'incapacitated',
  'invisible',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
];

const WEAPON_PROPERTY_RULES = [
  'ammunition',
  'finesse',
  'heavy',
  'light',
  'loading',
  'reach',
  'thrown',
  'two_handed',
  'versatile',
];

const WEAPON_MASTERY_RULES = [
  'cleave',
  'graze',
  'nick',
  'push',
  'sap',
  'slow',
  'topple',
  'vex',
];

const FIGHTING_STYLE_RULES = [
  'archery',
  'blind_fighting',
  'defense',
  'dueling',
  'great_weapon_fighting',
  'interception',
  'protection',
  'thrown_weapon_fighting',
  'two_weapon_fighting',
  'unarmed_fighting',
];

function buildRulesCoverageMatrix({ content = getContentBundle(), catalog = DEFAULT_CATALOG } = {}) {
  const matrix = {
    version: catalog.version || '4C.6-A',
    generated_at: new Date().toISOString(),
    status_definitions: catalog.status_definitions || {},
    sections: {
      actions: buildSection('actions', ACTION_ORDER.map((id) => actionEntry(id, catalog))),
      conditions: buildSection('conditions', CORE_CONDITIONS.map((id) => simpleEntry('condition', id, titleCase(id), statusFrom(catalog.conditions?.[id])))),
      resources: buildSection('resources', Object.entries(catalog.resources || {}).map(([id, status]) => simpleEntry('resource', id, titleCase(id), statusFrom(status)))),
      classes: buildSection('classes', (content.classes || []).map((item) => classEntry(item, catalog))),
      species: buildSection('species', (content.species || []).map((item) => speciesEntry(item, catalog))),
      origin_feats: buildSection('origin_feats', (content.feats || []).map((item) => featEntry(item, catalog))),
      spells: buildSection('spells', (content.spells || []).map((item) => spellEntry(item, catalog))),
      equipment: buildSection('equipment', (content.equipment || []).map((item) => equipmentEntry(item, catalog))),
      equipment_rules: buildSection('equipment_rules', buildEquipmentRuleEntries(content, catalog)),
      weapon_masteries: buildSection('weapon_masteries', buildWeaponMasteryEntries(catalog)),
      fighting_styles: buildSection('fighting_styles', buildFightingStyleEntries(catalog)),
    },
  };

  matrix.summary = summarizeCoverage(matrix);
  return matrix;
}

function actionEntry(id, catalog) {
  const override = catalog.actions?.[id] || {};
  return {
    category: 'action',
    id,
    name: titleCase(id),
    status: statusFrom(override.status),
    exposed: true,
    implementation: override.implementation || 'Tracked for action economy and rules coverage.',
    gaps: gapsForStatus(override.status, 'Action needs full runtime coverage.'),
  };
}

function simpleEntry(category, id, name, status, extra = {}) {
  return {
    category,
    id,
    name,
    status: statusFrom(status),
    exposed: statusFrom(status) !== STATUS.NOT_EXPOSED,
    implementation: extra.implementation || '',
    gaps: extra.gaps || gapsForStatus(status, `${name} needs complete runtime coverage.`),
    ...extra,
  };
}

function classEntry(item, catalog) {
  const featureEntries = (item.class_features || []).map((feature) => {
    const status = statusFrom(catalog.class_features?.[feature.id]);
    return simpleEntry('class_feature', feature.id, feature.name, status, {
      description: feature.description || '',
      parent_id: item.id,
      parent_name: item.name,
    });
  });
  const status = aggregateStatus(featureEntries);
  return simpleEntry('class', item.id, item.name, status, {
    implementation: 'Level 1 character creation is validated; runtime feature coverage is tracked per feature.',
    children: featureEntries,
    spellcasting: item.spellcasting ? {
      ability: item.spellcasting.ability,
      cantrips: item.spellcasting.cantrips || 0,
      prepared_spells: item.spellcasting.prepared_spells || 0,
      spellbook_spells: item.spellcasting.spellbook_spells || 0,
      slots: item.spellcasting.slots || {},
    } : null,
  });
}

function speciesEntry(item, catalog) {
  const traitEntries = (item.traits || []).map((trait) => {
    const traitId = normalizeId(trait.name);
    const status = statusFrom(catalog.species_traits?.[`${item.id}.${traitId}`] || inferTraitStatus(trait));
    return simpleEntry('species_trait', traitId, trait.name, status, {
      description: trait.description || '',
      parent_id: item.id,
      parent_name: item.name,
    });
  });
  return simpleEntry('species', item.id, item.name, aggregateStatus(traitEntries), {
    implementation: 'Species creation choices are validated; runtime trait coverage is tracked per trait.',
    children: traitEntries,
  });
}

function featEntry(item, catalog) {
  const status = statusFrom(catalog.origin_feats?.[item.id]);
  return simpleEntry('origin_feat', item.id, item.name, status, {
    description: item.description || '',
    implementation: status === STATUS.IMPLEMENTED
      ? 'Creation and/or derived-stat effects are enforced for current scope.'
      : 'Feat is exposed through character creation and needs runtime feature support.',
    choice: item.choice || null,
  });
}

function spellEntry(item, catalog) {
  const status = statusFrom(catalog.spells?.[item.id] || inferSpellStatus(item));
  return simpleEntry('spell', item.id, item.name, status, {
    level: Number(item.level || 0),
    classes: item.classes || [],
    casting_time: item.casting_time || '',
    duration: item.duration || '',
    concentration: Boolean(item.concentration),
    attack_type: item.attack_type || 'utility',
    implementation: spellImplementationText(status),
  });
}

function equipmentEntry(item, catalog) {
  const status = statusFrom(catalog.equipment_items?.[item.id] || catalog.equipment_types?.[item.type] || STATUS.PARTIAL);
  return simpleEntry('equipment', item.id, item.name, status, {
    type: item.type || 'item',
    weapon_category: item.weapon_category || null,
    properties: item.properties || [],
    mastery: item.mastery || null,
    implementation: equipmentImplementationText(item, status),
  });
}

function buildEquipmentRuleEntries(content, catalog) {
  const effectRules = (content.itemEffects || []).map((item) => simpleEntry(
    'equipment_rule',
    item.target,
    titleCase(item.target),
    statusFrom(catalog.equipment_rules?.[item.target] || STATUS.PARTIAL),
    { description: item.description || '' },
  ));
  const propertyRules = WEAPON_PROPERTY_RULES.map((id) => simpleEntry(
    'equipment_rule',
    id,
    titleCase(id),
    statusFrom(catalog.equipment_rules?.[id] || STATUS.DEFERRED),
    { description: 'Weapon property rule coverage.' },
  ));
  return [...effectRules, ...propertyRules];
}

function buildFightingStyleEntries(catalog) {
  return FIGHTING_STYLE_RULES.map((id) => simpleEntry(
    'fighting_style',
    id,
    titleCase(id),
    statusFrom(catalog.fighting_styles?.[id] || STATUS.DEFERRED),
    { description: 'Fighting Style feat rule coverage.' },
  ));
}

function buildWeaponMasteryEntries(catalog) {
  return WEAPON_MASTERY_RULES.map((id) => simpleEntry(
    'weapon_mastery',
    id,
    titleCase(id),
    statusFrom(catalog.weapon_masteries?.[id] || STATUS.DEFERRED),
    { description: 'Weapon mastery rule coverage.' },
  ));
}

function buildSection(id, entries) {
  const normalized = entries.map((entry) => ({
    ...entry,
    status: statusFrom(entry.status),
  }));
  return {
    id,
    entries: normalized,
    summary: countStatuses(normalized),
  };
}

function summarizeCoverage(matrix) {
  const sectionSummary = {};
  const totals = emptyStatusCounts();
  for (const [sectionId, section] of Object.entries(matrix.sections || {})) {
    const counts = countStatuses(section.entries || []);
    sectionSummary[sectionId] = counts;
    for (const [status, count] of Object.entries(counts)) {
      totals[status] = (totals[status] || 0) + count;
    }
  }
  return {
    totals,
    sections: sectionSummary,
    exposed_total: Object.entries(totals)
      .filter(([status]) => status !== STATUS.NOT_EXPOSED)
      .reduce((sum, [, count]) => sum + count, 0),
  };
}

function countStatuses(entries) {
  const counts = emptyStatusCounts();
  for (const entry of entries || []) {
    counts[statusFrom(entry.status)] += 1;
    for (const child of entry.children || []) {
      counts[statusFrom(child.status)] += 1;
    }
  }
  return counts;
}

function emptyStatusCounts() {
  return Object.fromEntries(Object.values(STATUS).map((status) => [status, 0]));
}

function aggregateStatus(entries = []) {
  const statuses = new Set(entries.map((entry) => statusFrom(entry.status)));
  if (statuses.has(STATUS.DEFERRED)) return STATUS.PARTIAL;
  if (statuses.has(STATUS.PARTIAL)) return STATUS.PARTIAL;
  if (statuses.has(STATUS.IMPLEMENTED)) return STATUS.IMPLEMENTED;
  return STATUS.DEFERRED;
}

function statusFrom(value) {
  const status = String(value || STATUS.PARTIAL).toLowerCase();
  return STATUS_VALUES.has(status) ? status : STATUS.PARTIAL;
}

function gapsForStatus(status, fallback) {
  const normalized = statusFrom(status);
  if (normalized === STATUS.IMPLEMENTED) return [];
  if (normalized === STATUS.NOT_EXPOSED) return ['Not exposed to current public play.'];
  if (normalized === STATUS.DEFERRED) return [fallback || 'Deferred for a later rules pass.'];
  return [fallback || 'Partial rules coverage; needs audit before leveling.'];
}

function inferTraitStatus(trait = {}) {
  if (Array.isArray(trait.effects) && trait.effects.length > 0) return STATUS.PARTIAL;
  if (Array.isArray(trait.spells) && trait.spells.length > 0) return STATUS.PARTIAL;
  if (Array.isArray(trait.resistances) && trait.resistances.length > 0) return STATUS.PARTIAL;
  if (/\bproficiency|language|speed|darkvision\b/i.test(trait.description || '')) return STATUS.PARTIAL;
  return STATUS.DEFERRED;
}

function inferSpellStatus(spell = {}) {
  if (Number(spell.level || 0) === 0 || Number(spell.level || 0) === 1) return STATUS.PARTIAL;
  return STATUS.NOT_EXPOSED;
}

function spellImplementationText(status) {
  if (status === STATUS.IMPLEMENTED) return 'Specific spell legality and outcome are mechanically enforced for current scope.';
  if (status === STATUS.DEFERRED) return 'Spell appears in data but needs dedicated runtime mechanics before full reliability.';
  return 'Spell slot/known-spell legality exists; unique spell outcome may still need complete mechanics.';
}

function equipmentImplementationText(item, status) {
  if (status === STATUS.IMPLEMENTED) return 'Equipment effect is included in derived character math for current scope.';
  if (item.type === 'weapon') return 'Weapon attacks exist, but full property/mastery coverage is incomplete.';
  if (item.type === 'tool') return 'Tool proficiency is tracked, but tool-use resolution is incomplete.';
  return 'Equipment is tracked in inventory; interaction/economy rules need follow-up coverage.';
}

function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function titleCase(value) {
  return String(value || '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

module.exports = {
  STATUS,
  buildRulesCoverageMatrix,
  summarizeCoverage,
};
