// AI model constants.
// Override these in Railway/local env if you want to tune quality or cost.

const DM1_MODEL     = process.env.DM1_MODEL     || 'gpt-5.4-mini';
const UTILITY_MODEL = process.env.UTILITY_MODEL || 'gpt-5.4-nano';

module.exports = { DM1_MODEL, UTILITY_MODEL };
