process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getContentBundle } = require('../src/contentData');
const { validateCharacter } = require('../src/characterValidator');

function baseDraft(overrides = {}) {
  return {
    name: 'Rulecheck',
    speciesId: 'human',
    classId: 'fighter',
    backgroundId: 'farmer',
    abilityMethod: 'standard_array',
    abilityScores: {
      str: 15,
      dex: 13,
      con: 14,
      int: 8,
      wis: 12,
      cha: 10,
      backgroundBonus: { str: 2, con: 1 },
    },
    selectedSkills: ['athletics', 'intimidation'],
    equipmentChoice: 'pack',
    humanSkillId: 'perception',
    humanOriginFeatId: 'alert',
    featSkillChoices: {},
    magicInitiateChoices: {},
    cantripsKnown: [],
    spellsKnown: [],
    ...overrides,
  };
}

function originChoicesFor(background) {
  const content = getContentBundle();
  const feat = content.feats.find((item) => item.id === background.origin_feat);
  if (!feat) return {};
  if (feat.choice?.type === 'skills') {
    const skills = content.skills
      .map((skill) => skill.id)
      .filter((skillId) => !(background.skills || []).includes(skillId))
      .slice(0, feat.choice.count);
    return { featSkillChoices: { background_feat: skills } };
  }
  if (feat.magic_list) {
    const cantrips = content.spells
      .filter((spell) => spell.level === 0 && spell.classes.includes(feat.magic_list))
      .map((spell) => spell.id)
      .slice(0, 2);
    const spell = content.spells.find((item) => item.level === 1 && item.classes.includes(feat.magic_list))?.id;
    return { magicInitiateChoices: { background_feat: { cantrips, spell } } };
  }
  return {};
}

function fighterSkillsExcluding(excluded) {
  return ['acrobatics', 'animal_handling', 'athletics', 'history', 'insight', 'intimidation', 'perception', 'survival']
    .filter((skillId) => !excluded.has(skillId))
    .slice(0, 2);
}

test('applies Human Skillful, Human Versatile, background Origin feat, and static math', () => {
  const sheet = validateCharacter(baseDraft(), getContentBundle());

  assert.equal(sheet.origin.background_feat, 'tough');
  assert.equal(sheet.origin.human_origin_feat, 'alert');
  assert.equal(sheet.origin.human_skill, 'perception');
  assert.equal(sheet.derived_stats.max_hp, 14);
  assert.equal(sheet.derived_stats.initiative, 3);
  assert.deepEqual(
    sheet.derived_stats.initiative_breakdown.map((part) => part.label),
    ['DEX modifier', 'Alert proficiency'],
  );
  assert.equal(sheet.derived_stats.skill_modifiers.perception.proficient, true);
  assert.equal(sheet.proficiencies.skills.includes('animal_handling'), true);
  assert.equal(sheet.proficiencies.skills.includes('athletics'), true);
});

test('requires Magic Initiate choices granted by a background Origin feat', () => {
  assert.throws(
    () => validateCharacter(baseDraft({
      speciesId: 'elf_high',
      backgroundId: 'acolyte',
      abilityScores: {
        str: 15,
        dex: 13,
        con: 14,
        int: 10,
        wis: 12,
        cha: 8,
        backgroundBonus: { wis: 2, int: 1 },
      },
      selectedSkills: ['athletics', 'perception'],
      humanSkillId: '',
      humanOriginFeatId: '',
    }), getContentBundle()),
    /Magic Initiate.*two cantrips/,
  );

  const sheet = validateCharacter(baseDraft({
    speciesId: 'elf_high',
    backgroundId: 'acolyte',
    abilityScores: {
      str: 15,
      dex: 13,
      con: 14,
      int: 10,
      wis: 12,
      cha: 8,
      backgroundBonus: { wis: 2, int: 1 },
    },
    selectedSkills: ['athletics', 'perception'],
    humanSkillId: '',
    humanOriginFeatId: '',
    magicInitiateChoices: {
      background_feat: { cantrips: ['light', 'guidance'], spell: 'bless' },
    },
  }), getContentBundle());

  assert.deepEqual(sheet.origin.magic_initiate.background_feat, {
    list: 'cleric',
    cantrips: ['light', 'guidance'],
    spell: 'bless',
  });
});

test('rejects duplicate non-repeatable Human Origin feats and duplicate granted skills', () => {
  assert.throws(
    () => validateCharacter(baseDraft({ humanOriginFeatId: 'tough' }), getContentBundle()),
    /different Origin feat/,
  );

  assert.throws(
    () => validateCharacter(baseDraft({ humanSkillId: 'animal_handling' }), getContentBundle()),
    /not already granted by the background/,
  );

  assert.throws(
    () => validateCharacter(baseDraft({ selectedSkills: ['athletics', 'perception'] }), getContentBundle()),
    /must not duplicate/,
  );
});

test('validates every 2024 background with its Origin feat requirements', () => {
  const content = getContentBundle();
  for (const background of content.backgrounds) {
    const [first, second] = background.asi_options;
    const originChoiceDraft = originChoicesFor(background);
    const originSkillChoices = Object.values(originChoiceDraft.featSkillChoices || {}).flat();
    const excluded = new Set([...(background.skills || []), ...originSkillChoices]);
    const sheet = validateCharacter(baseDraft({
      speciesId: 'elf_high',
      backgroundId: background.id,
      abilityScores: {
        str: 15,
        dex: 13,
        con: 14,
        int: 10,
        wis: 12,
        cha: 8,
        backgroundBonus: { [first]: 2, [second]: 1 },
      },
      selectedSkills: fighterSkillsExcluding(excluded),
      humanSkillId: '',
      humanOriginFeatId: '',
      ...originChoiceDraft,
    }), content);

    assert.equal(sheet.origin.background_feat, background.origin_feat);
    assert.equal(sheet.identity.background, background.id);
  }
});
