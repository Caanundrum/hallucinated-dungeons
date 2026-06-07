function shouldAllowModerationFalsePositive(message = '', flaggedCategories = []) {
  if (!Array.isArray(flaggedCategories) || flaggedCategories.length === 0) return false;
  if (!flaggedCategories.every((category) => String(category).startsWith('self-harm'))) return false;

  const text = String(message || '').toLowerCase();
  if (!/\b(?:tie|secure|fasten|anchor|attach|loop)\b/.test(text) || !/\brope\b/.test(text)) return false;
  if (/\b(?:suicide|kill myself|harm myself|hang myself|noose|neck|strangle|choke)\b/.test(text)) return false;

  return /\b(?:bridge|rail|support|tree|post|piton|hook|pack|climb|leaning over|lower myself|safety|anchor)\b/.test(text);
}

module.exports = {
  shouldAllowModerationFalsePositive,
};
