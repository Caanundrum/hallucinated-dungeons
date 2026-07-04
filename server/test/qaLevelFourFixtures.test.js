process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getContentBundle } = require('../src/contentData');
const { applyLevelUp, getLevelUpPreview } = require('../src/levelUpEngine');
const {
  buildQaLevelFourCharacter,
  buildQaLevelFourRoster,
  isQaLevelFourFixtureName,
  qaLevelFourFixtureName,
} = require('../src/qaLevelFourFixtures');

const SESSION_ID = '00000000-0000-4000-8000-000000000777';
const CAMPAIGN_ID = '00000000-0000-4000-8000-000000000001';

test('protected QA roster builds one valid level 4 fixture per class ready for level 5', () => {
  const content = getContentBundle();
  const roster = buildQaLevelFourRoster({ sessionId: SESSION_ID, campaignId: CAMPAIGN_ID, content });

  assert.equal(roster.length, 12);
  assert.deepEqual(roster.map((entry) => entry.classId).sort(), content.classes.map((entry) => entry.id).sort());
  for (const fixture of roster) {
    const sheet = fixture.characterSheet;
    const preview = getLevelUpPreview(sheet, content);
    assert.equal(sheet.identity.level, 4, fixture.classId);
    assert.equal(sheet.progression.experience_points, 6500, fixture.classId);
    assert.equal(sheet.progression.next_level_xp, 6500, fixture.classId);
    assert.equal(sheet.progression.level_up_available.ready, true, fixture.classId);
    assert.equal(sheet.derived_stats.hp, sheet.derived_stats.max_hp, fixture.classId);
    assert.equal(sheet.notes.qa_fixture.id, `level_four_${fixture.classId}`, fixture.classId);
    assert.equal(preview.canLevelUp, true, fixture.classId);
    assert.equal(preview.nextLevel, 5, fixture.classId);
  }
});

test('QA level 4 fixtures retain real creation equipment, subclasses, and spellcasting', () => {
  const content = getContentBundle();
  const roster = buildQaLevelFourRoster({ sessionId: SESSION_ID, campaignId: CAMPAIGN_ID, content });

  for (const { classId, characterSheet: sheet } of roster) {
    assert(sheet.inventory.length > 0, `${classId} inventory`);
    assert(sheet.identity.subclass, `${classId} subclass`);
    assert(sheet.features.length > 0, `${classId} features`);
    if (content.classes.find((entry) => entry.id === classId).spellcasting) {
      assert(sheet.spellcasting, `${classId} spellcasting`);
      assert(Object.values(sheet.spellcasting.slots_max || {}).some((value) => Number(value) > 0), `${classId} slots`);
    }
  }
});

test('every seeded fixture can complete its real level 5 choices and advance', () => {
  const content = getContentBundle();
  const roster = buildQaLevelFourRoster({ sessionId: SESSION_ID, campaignId: CAMPAIGN_ID, content });

  for (const { classId, characterSheet } of roster) {
    const choices = completeChoices(characterSheet, content);
    const preview = getLevelUpPreview(characterSheet, content, { choices });
    const result = applyLevelUp({ characterSheet, content, payload: { choices } });
    assert.equal(preview.canApply, true, `${classId}: ${preview.blockers.map((entry) => entry.message).join(' | ')}`);
    assert.equal(result.ok, true, classId);
    assert.equal(result.characterSheet.identity.level, 5, classId);
  }
});

test('fixture names are deterministic and reject ordinary QA or player names', () => {
  assert.equal(qaLevelFourFixtureName('fighter'), 'QA L4 Fighter');
  assert.equal(qaLevelFourFixtureName('not_a_class'), null);
  assert.equal(isQaLevelFourFixtureName('QA L4 Wizard'), true);
  assert.equal(isQaLevelFourFixtureName('QA Smoke'), false);
  assert.equal(isQaLevelFourFixtureName('Ari the Fighter'), false);
});

test('a single QA fixture can be regenerated without retaining spent state', () => {
  const sheet = buildQaLevelFourCharacter({
    classId: 'fighter',
    sessionId: SESSION_ID,
    campaignId: CAMPAIGN_ID,
  });

  assert.equal(sheet.identity.name, 'QA L4 Fighter');
  assert.equal(sheet.derived_stats.hp, sheet.derived_stats.max_hp);
  assert.equal(sheet.resources.second_wind.remaining, sheet.resources.second_wind.max);
  assert.equal(sheet.active_effects.some((effect) => effect.duration || effect.remaining_rounds), false);
});

function completeChoices(characterSheet, content) {
  const choices = {};
  for (let pass = 0; pass < 30; pass += 1) {
    const preview = getLevelUpPreview(characterSheet, content, { choices });
    const missing = preview.requiredChoices.find((choice) => choice.active && !choices[choice.id]);
    if (!missing) return choices;
    const available = (missing.options || []).filter((option) => {
      const requirement = option.requires_choice;
      return !option.disabled && (!requirement || (choices[requirement.choice_id] || []).includes(requirement.option_id));
    });
    choices[missing.id] = available.slice(0, Number(missing.count || 0)).map((option) => option.id);
  }
  throw new Error('Level 5 fixture choice completion exceeded its safety limit.');
}
