const { getContentBundle } = require('./contentData');

const RESOURCE_ALIASES = {
  second_wind: ['second wind', 'tactical mind'],
  action_surge: ['action surge'],
  rage: ['rage'],
  lay_on_hands: ['lay on hands', 'healing pool'],
  paladins_smite: ["paladin's smite", 'paladin smite', 'divine smite'],
  bardic_inspiration: ['bardic inspiration'],
  innate_sorcery: ['innate sorcery'],
  sorcery_points: ['sorcery point', 'sorcery points', 'font of magic'],
  magical_cunning: ['magical cunning'],
  arcane_recovery: ['arcane recovery'],
  heroic_inspiration: ['heroic inspiration'],
  luck_points: ['luck point', 'luck points', 'lucky'],
  healing_hands: ['healing hands'],
  relentless_endurance: ['relentless endurance'],
  adrenaline_rush: ['adrenaline rush'],
  breath_weapon: ['breath weapon'],
  stonecunning: ['stonecunning', 'stone cunning'],
  giant_ancestry: ['giant ancestry'],
};

function answerResourceCountQuestion(message = '', worldState = {}) {
  const text = normalizeText(message);
  if (!isResourceQuestion(text)) return '';

  const resources = worldState.player_stats?.resources || {};
  const resourceMatches = findRequestedResources(text, resources)
    .map((match) => ({
      index: match.index,
      entry: formatResourceEntry(match.key, match.resource, text),
    }));
  const spellSlotMatch = findRequestedSpellSlots(text, worldState);
  const matches = [
    ...resourceMatches,
    ...(spellSlotMatch ? [spellSlotMatch] : []),
  ].sort((a, b) => a.index - b.index);

  if (!matches.length) return '';

  const entries = matches.map((match) => match.entry);
  if (entries.length > 1) {
    return `Current sheet state:\n${entries.map((entry) => `- ${entry}`).join('\n')}`;
  }

  return `Current sheet state: ${entries[0]}`;
}

function formatResourceEntry(key, resource = {}, text = '') {
  const name = resource.name || titleCase(key);
  const remaining = formatNumber(resource.remaining);
  const max = resource.max !== undefined && resource.max !== null
    ? `/${formatNumber(resource.max)}`
    : '';
  const unit = resource.unit ? ` ${resource.unit}` : ' uses';
  const reset = resource.reset ? ` It resets on ${humanize(resource.reset)}.` : '';
  const tacticalMindNote = key === 'second_wind' && text.includes('tactical mind')
    ? ' Tactical Mind uses this same Second Wind resource only if its d10 turns the failed check into a success.'
    : '';

  return `**${name} ${remaining}${max}${unit} left.**${reset}${tacticalMindNote}`;
}

function isResourceQuestion(text = '') {
  return /\b(?:how many|how much|uses?|left|remaining|available|resource|resources|spent|spend|after)\b/.test(text)
    || /\bspell slots?\b/.test(text);
}

function findRequestedResources(text = '', resources = {}) {
  const matches = [];
  for (const key of Object.keys(resources || {})) {
    if (key === 'spell_uses') continue;
    const aliases = [
      key,
      humanize(key),
      resources[key]?.name,
      ...(RESOURCE_ALIASES[key] || []),
    ].filter(Boolean);
    const index = firstAliasIndex(text, aliases);
    if (index !== -1) {
      matches.push({ key, index, resource: resources[key] });
    }
  }

  for (const [key, resource] of Object.entries(resources.spell_uses || {})) {
    const aliases = [
      key,
      humanize(key),
      resource?.name,
    ].filter(Boolean);
    const index = firstAliasIndex(text, aliases);
    if (index !== -1) {
      matches.push({ key, index, resource });
    }
  }

  if (text.includes('tactical mind') && resources.second_wind && !matches.some((match) => match.key === 'second_wind')) {
    matches.push({ key: 'second_wind', index: text.indexOf('tactical mind'), resource: resources.second_wind });
  }
  return matches.sort((a, b) => a.index - b.index);
}

function findRequestedSpellSlots(text = '', worldState = {}) {
  const index = spellSlotIndex(text);
  if (index === -1) return null;
  return {
    index,
    entry: formatSpellSlotEntry(worldState),
  };
}

function spellSlotIndex(text = '') {
  const direct = firstAliasIndex(text, ['spell slot', 'spell slots']);
  if (direct !== -1) return direct;
  const pactMagic = /\bpact magic slots?\b/.exec(text);
  if (pactMagic) return pactMagic.index;
  const levelSlot = /\blevel \d+ slots?\b/.exec(text);
  if (levelSlot) return levelSlot.index;
  const slots = phraseIndex(text, 'slots');
  if (slots !== -1 && /\b(?:spell|spells|cast|casting)\b/.test(text)) return slots;
  return -1;
}

function formatSpellSlotEntry(worldState = {}) {
  const spellSlots = normalizeSlotMap(worldState.player_stats?.spell_slots || {});
  const maxSlots = normalizeSlotMap(
    worldState.player_stats?.spell_slots_max
    || deriveSpellSlotMaximums(worldState)
  );
  const levels = [...new Set([
    ...Object.keys(spellSlots),
    ...Object.keys(maxSlots),
  ])].sort((a, b) => Number(a) - Number(b));

  const entries = levels
    .filter((level) => spellSlots[level] !== undefined || maxSlots[level] !== undefined)
    .map((level) => {
      const remaining = spellSlots[level] !== undefined ? spellSlots[level] : '?';
      const max = maxSlots[level];
      if (max === undefined) return `level ${level}: ${formatNumber(remaining)}`;
      return `level ${level}: ${formatNumber(remaining)}/${formatNumber(max)}`;
    });

  if (!entries.length) return '**Spell slots: none recorded on the current sheet.**';
  return `**Spell slots remaining: ${entries.join(', ')}.**`;
}

function deriveSpellSlotMaximums(worldState = {}) {
  const playerStats = worldState.player_stats || {};
  const classId = resolveClassId(playerStats);
  const characterLevel = Number(playerStats.level || 1);
  if (!classId || !Number.isFinite(characterLevel) || characterLevel < 1) return {};

  const content = getContentBundle();
  const classData = (content.classes || []).find((entry) => entry.id === classId);
  const maxSlots = normalizeSlotMap(classData?.spellcasting?.slots || {});
  const classLevels = content.classAdvancement?.levels?.[classId] || {};
  for (let level = 2; level <= characterLevel; level += 1) {
    const advancementSlots = classLevels[String(level)]?.spellcasting?.slots;
    if (advancementSlots) {
      Object.assign(maxSlots, normalizeSlotMap(advancementSlots));
    }
  }
  return maxSlots;
}

function resolveClassId(playerStats = {}) {
  const content = getContentBundle();
  const direct = normalizeId(playerStats.class_id || playerStats.class);
  if (!direct) return '';
  const directMatch = (content.classes || []).find((entry) => entry.id === direct);
  if (directMatch) return directMatch.id;
  const nameMatch = (content.classes || []).find((entry) => normalizeId(entry.name) === direct);
  return nameMatch?.id || direct;
}

function normalizeSlotMap(slots = {}) {
  return Object.fromEntries(
    Object.entries(slots || {})
      .filter(([level, value]) => level !== '' && value !== null && value !== undefined)
      .map(([level, value]) => [String(level), value])
  );
}

function firstAliasIndex(text, aliases = []) {
  return aliases.reduce((lowest, alias) => {
    const index = phraseIndex(text, alias);
    if (index === -1) return lowest;
    return lowest === -1 ? index : Math.min(lowest, index);
  }, -1);
}

function phraseIndex(text, phrase) {
  const normalized = normalizeText(phrase);
  if (!normalized) return -1;
  const match = new RegExp(`(?:^| )${escapeRegExp(normalized)}(?: |$)`).exec(text);
  return match ? match.index : -1;
}

function normalizeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeId(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function humanize(value = '') {
  return String(value || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleCase(value = '') {
  return humanize(value).replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatNumber(value) {
  if (value === undefined || value === null || value === '') return '?';
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : String(value);
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  answerResourceCountQuestion,
};
