const RESOURCE_ALIASES = {
  second_wind: ['second wind', 'tactical mind'],
  action_surge: ['action surge'],
  rage: ['rage'],
  lay_on_hands: ['lay on hands', 'healing pool'],
  bardic_inspiration: ['bardic inspiration'],
  innate_sorcery: ['innate sorcery'],
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
  const match = findRequestedResource(text, resources);
  if (!match) return '';

  const resource = resources[match.key] || {};
  const name = resource.name || titleCase(match.key);
  const remaining = formatNumber(resource.remaining);
  const max = resource.max !== undefined && resource.max !== null
    ? `/${formatNumber(resource.max)}`
    : '';
  const unit = resource.unit ? ` ${resource.unit}` : ' uses';
  const reset = resource.reset ? ` It resets on ${humanize(resource.reset)}.` : '';
  const tacticalMindNote = match.key === 'second_wind' && text.includes('tactical mind')
    ? ' Tactical Mind uses this same Second Wind resource only if its d10 turns the failed check into a success.'
    : '';

  return `Current sheet state: **${name} ${remaining}${max}${unit} left.**${reset}${tacticalMindNote}`;
}

function isResourceQuestion(text = '') {
  return /\b(?:how many|how much|uses?|left|remaining|available|resource|resources|spent|spend|after)\b/.test(text);
}

function findRequestedResource(text = '', resources = {}) {
  for (const key of Object.keys(resources || {})) {
    if (key === 'spell_uses') continue;
    const aliases = [
      key,
      humanize(key),
      resources[key]?.name,
      ...(RESOURCE_ALIASES[key] || []),
    ].filter(Boolean);
    if (aliases.some((alias) => includesPhrase(text, alias))) {
      return { key };
    }
  }

  if (text.includes('tactical mind') && resources.second_wind) {
    return { key: 'second_wind' };
  }
  return null;
}

function includesPhrase(text, phrase) {
  const normalized = normalizeText(phrase);
  return normalized && new RegExp(`(?:^| )${escapeRegExp(normalized)}(?: |$)`).test(text);
}

function normalizeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
