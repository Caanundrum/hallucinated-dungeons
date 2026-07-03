const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');

function readJson(name) {
  const filePath = path.join(DATA_DIR, name);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function mergeAdvancementCatalogs(...catalogs) {
  const merged = { version: catalogs.map((catalog) => catalog.version).filter(Boolean).join('+'), levels: {} };
  for (const catalog of catalogs) {
    for (const [classId, levels] of Object.entries(catalog.levels || {})) {
      merged.levels[classId] = { ...(merged.levels[classId] || {}), ...levels };
    }
  }
  return merged;
}

const content = {
  species: readJson('species.json'),
  classes: readJson('classes.json'),
  backgrounds: readJson('backgrounds.json'),
  skills: readJson('skills.json'),
  languages: readJson('languages.json'),
  tools: readJson('tools.json'),
  equipment: readJson('equipment.json'),
  spells: readJson('spells.json'),
  feats: readJson('feats.json'),
  subclasses: readJson('subclasses.json'),
  xpThresholds: readJson('xp_thresholds.json'),
  classAdvancement: mergeAdvancementCatalogs(
    readJson('class_level_advancement.json'),
    readJson('level_3_advancement.json'),
    readJson('level_4_advancement.json'),
  ),
  itemEffects: readJson('item_effects.json'),
  abilityScoreMethods: [
    {
      id: 'standard_array',
      name: 'Standard Array',
      description: 'Assign the fixed values 15, 14, 13, 12, 10, and 8 once each.',
    },
    {
      id: 'point_buy',
      name: 'Point Buy',
      description: 'Start every ability at 8 and spend exactly 27 points. No score can exceed 15 before background bonuses.',
    },
    {
      id: 'rolled',
      name: 'Rolled Stats',
      description: 'Roll up to 3 attempts. Each attempt creates six scores using 4d6, drop the lowest die. Rolling again discards the previous set permanently.',
    },
  ],
  pointBuyCosts: {
    8: 0,
    9: 1,
    10: 2,
    11: 3,
    12: 4,
    13: 5,
    14: 7,
    15: 9,
  },
};

function byId(list, id) {
  return list.find((item) => item.id === id) || null;
}

function getContentBundle() {
  return content;
}

module.exports = {
  getContentBundle,
  byId,
};
