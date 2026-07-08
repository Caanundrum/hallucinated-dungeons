process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getContentBundle } = require('../src/contentData');
const { applyLevelUp, getLevelUpPreview } = require('../src/levelUpEngine');
const { buildQaLevelFourRoster } = require('../src/qaLevelFourFixtures');
const { getXpThreshold, setCharacterXp } = require('../src/progressionEngine');

const SESSION_ID = '00000000-0000-4000-8000-000000000888';
const CAMPAIGN_ID = '00000000-0000-4000-8000-000000000001';

function completeChoices(characterSheet, content) {
  const choices = {};
  for (let pass = 0; pass < 80; pass += 1) {
    const preview = getLevelUpPreview(characterSheet, content, { choices });
    const missing = preview.requiredChoices.find((choice) => choice.active && !choices[choice.id]);
    if (!missing) return choices;
    const available = (missing.options || []).filter((option) => {
      const requirement = option.requires_choice;
      return !option.disabled && (!requirement || (choices[requirement.choice_id] || []).includes(requirement.option_id));
    });
    choices[missing.id] = available.slice(0, Number(missing.count || 0)).map((option) => option.id);
  }
  throw new Error('Mid-level choice completion exceeded its safety limit.');
}

function advanceToTen(startingSheet, content) {
  let sheet = startingSheet;
  const history = new Map();
  for (let targetLevel = 5; targetLevel <= 10; targetLevel += 1) {
    sheet = setCharacterXp(sheet, getXpThreshold(targetLevel), { sourceId: `test:${sheet.identity.class}:level_${targetLevel}` });
    const choices = completeChoices(sheet, content);
    const preview = getLevelUpPreview(sheet, content, { choices });
    assert.equal(preview.canApply, true, `${sheet.identity.class} L${targetLevel}: ${preview.blockers.map((entry) => entry.message).join(' | ')}`);
    const result = applyLevelUp({ characterSheet: sheet, content, payload: { choices } });
    assert.equal(result.ok, true, `${sheet.identity.class} L${targetLevel}`);
    sheet = result.characterSheet;
    history.set(targetLevel, sheet);
  }
  return { sheet, history };
}

function advanceToTwenty(startingSheet, content) {
  let { sheet, history } = advanceToTen(startingSheet, content);
  for (let targetLevel = 11; targetLevel <= 20; targetLevel += 1) {
    sheet = setCharacterXp(sheet, getXpThreshold(targetLevel), { sourceId: `test:${sheet.identity.class}:level_${targetLevel}` });
    const choices = completeChoices(sheet, content);
    const preview = getLevelUpPreview(sheet, content, { choices });
    assert.equal(preview.canApply, true, `${sheet.identity.class} L${targetLevel}: ${preview.blockers.map((entry) => entry.message).join(' | ')}`);
    const result = applyLevelUp({ characterSheet: sheet, content, payload: { choices } });
    assert.equal(result.ok, true, `${sheet.identity.class} L${targetLevel}`);
    sheet = result.characterSheet;
    history.set(targetLevel, sheet);
  }
  return { sheet, history };
}

test('all twelve classes advance coherently through every level from 6 to 10', () => {
  const content = getContentBundle();
  const roster = buildQaLevelFourRoster({ sessionId: SESSION_ID, campaignId: CAMPAIGN_ID, content });

  for (const fixture of roster) {
    const { sheet, history } = advanceToTen(fixture.characterSheet, content);
    assert.equal(sheet.identity.level, 10, fixture.classId);
    assert.equal(sheet.derived_stats.proficiency_bonus, 4, fixture.classId);
    assert.equal(sheet.progression.next_level_xp, 85000, fixture.classId);
    assert.equal(history.size, 6, fixture.classId);
    for (let level = 5; level <= 10; level += 1) assert.equal(history.get(level).identity.level, level, `${fixture.classId} L${level}`);
    if (fixture.classId === 'druid') assert.equal(history.get(6).resources.wild_shape.max, 3);
  }
});

test('all twelve classes advance coherently through every level from 11 to 20', () => {
  const content = getContentBundle();
  const roster = buildQaLevelFourRoster({ sessionId: SESSION_ID, campaignId: CAMPAIGN_ID, content });

  for (const fixture of roster) {
    const { sheet, history } = advanceToTwenty(fixture.characterSheet, content);
    assert.equal(sheet.identity.level, 20, fixture.classId);
    assert.equal(sheet.derived_stats.proficiency_bonus, 6, fixture.classId);
    assert.equal(history.size, 16, fixture.classId);
    for (let level = 11; level <= 20; level += 1) assert.equal(history.get(level).identity.level, level, `${fixture.classId} L${level}`);
    if (fixture.classId === 'fighter') {
      assert.equal(sheet.derived_stats.attacks_per_action, 4);
      assert.equal(sheet.derived_stats.weapon_critical_threshold, 18);
    }
    if (fixture.classId === 'rogue') {
      assert.equal(sheet.derived_stats.sneak_attack_dice, '10d6');
    }
  }
});

test('levels 6 through 10 apply the class tables and subclass milestones', () => {
  const content = getContentBundle();
  const results = new Map(buildQaLevelFourRoster({ sessionId: SESSION_ID, campaignId: CAMPAIGN_ID, content })
    .map((fixture) => [fixture.classId, advanceToTen(fixture.characterSheet, content).sheet]));

  assert.equal(results.get('barbarian').resources.rage.max, 4);
  assert.equal(results.get('barbarian').derived_stats.rage_damage_bonus, 3);
  assert(results.get('barbarian').features.some((entry) => entry.name === 'Retaliation'));

  assert.equal(results.get('bard').resources.bardic_inspiration.die, '1d10');
  assert.equal(results.get('bard').spellcasting.prepared_spells_count, 15);
  assert.equal(results.get('bard').class_choices.magical_discoveries.length, 2);

  assert.equal(results.get('cleric').resources.channel_divinity.max, 3);
  assert.equal(results.get('cleric').spellcasting.slots_max[5], 2);
  assert(results.get('cleric').features.some((entry) => entry.name === 'Divine Intervention'));

  assert.equal(results.get('druid').resources.wild_shape.max, 3);
  assert.equal(results.get('druid').derived_stats.wild_shape_max_cr, 1);
  assert(results.get('druid').condition_immunities.includes('poisoned'));
  assert(results.get('druid').features.some((entry) => entry.name === "Nature's Ward"));

  assert.equal(results.get('fighter').resources.second_wind.max, 4);
  assert.equal(results.get('fighter').resources.indomitable.max, 1);
  assert.equal(results.get('fighter').class_choices.additional_fighting_styles.length, 1);

  assert.equal(results.get('monk').resources.focus_points.max, 10);
  assert.equal(results.get('monk').derived_stats.unarmored_movement_bonus, 20);
  assert.equal(results.get('monk').resources.wholeness_of_body.max > 0, true);

  assert.equal(results.get('paladin').resources.lay_on_hands.max, 50);
  assert.equal(results.get('paladin').derived_stats.aura_frightened_immunity, true);
  assert(results.get('paladin').condition_immunities.includes('charmed'));
  assert(results.get('paladin').condition_immunities.includes('frightened'));
  assert.equal(results.get('paladin').spellcasting.slots_max[3], 2);

  assert.equal(results.get('ranger').derived_stats.climb_speed, results.get('ranger').derived_stats.speed);
  assert.equal(results.get('ranger').resources.tireless.max > 0, true);
  assert.equal(results.get('ranger').resources.spell_uses['class_feature:favored_enemy:hunter_mark'].max, 4);

  assert.equal(results.get('rogue').derived_stats.sneak_attack_dice, '5d6');
  assert.equal(results.get('rogue').derived_stats.reliable_talent_floor, 10);
  assert(results.get('rogue').features.some((entry) => entry.name === 'Supreme Sneak'));

  assert.equal(results.get('sorcerer').resources.sorcery_points.max, 10);
  assert.equal(results.get('sorcerer').class_choices.metamagic.length, 4);
  assert(results.get('sorcerer').class_choices.draconic_affinity);
  assert(results.get('sorcerer').resistances.includes(results.get('sorcerer').class_choices.draconic_affinity));

  assert.equal(results.get('warlock').spellcasting.pact_slot_level, 5);
  assert.equal(results.get('warlock').spellcasting.slots_max[5], 2);
  assert(results.get('warlock').spellcasting.always_prepared_spells.includes('contact_other_plane'));
  assert(results.get('warlock').resistances.includes(results.get('warlock').class_choices.fiendish_resilience));

  assert.equal(results.get('wizard').spellcasting.spellbook_spells.length, 28);
  assert.equal(results.get('wizard').spellcasting.prepared_spells_count, 15);
  assert(results.get('wizard').features.some((entry) => entry.name === 'Empowered Evocation'));
});

test('level 4 and 5 SRD spell catalog is exposed for every eligible class', () => {
  const content = getContentBundle();
  assert.equal(content.spells.filter((spell) => spell.level === 4).length, 34);
  assert.equal(content.spells.filter((spell) => spell.level === 5).length, 38);
  for (const classId of ['bard', 'cleric', 'druid', 'paladin', 'ranger', 'sorcerer', 'warlock', 'wizard']) {
    assert(content.spells.some((spell) => spell.level === 4 && spell.classes.includes(classId)), `${classId} level 4 spells`);
    assert(content.spells.some((spell) => spell.level === 5 && spell.classes.includes(classId)), `${classId} level 5 spells`);
  }
});

test('spent resources and spell slots stay spent while level 6 through 10 capacities grow', () => {
  const content = getContentBundle();
  const sorcerer = buildQaLevelFourRoster({ sessionId: SESSION_ID, campaignId: CAMPAIGN_ID, content })
    .find((entry) => entry.classId === 'sorcerer').characterSheet;
  sorcerer.resources.sorcery_points.remaining = 1;
  sorcerer.spellcasting.slots[1] = 1;
  const { sheet } = advanceToTen(sorcerer, content);

  assert.equal(sheet.resources.sorcery_points.max, 10);
  assert.equal(sheet.resources.sorcery_points.remaining, 7);
  assert.equal(sheet.spellcasting.slots_max[1], 4);
  assert.equal(sheet.spellcasting.slots[1], 1);
});

test('levels 11 through 20 apply the class tables and subclass milestones', () => {
  const content = getContentBundle();
  const results = new Map(buildQaLevelFourRoster({ sessionId: SESSION_ID, campaignId: CAMPAIGN_ID, content })
    .map((fixture) => [fixture.classId, advanceToTwenty(fixture.characterSheet, content).sheet]));

  assert.equal(results.get('barbarian').resources.rage.max, 6);
  assert.equal(results.get('barbarian').derived_stats.rage_damage_bonus, 4);
  assert(results.get('barbarian').features.some((entry) => entry.name === 'Primal Champion'));

  assert.equal(results.get('bard').resources.bardic_inspiration.die, '1d12');
  assert.equal(results.get('bard').spellcasting.prepared_spells_count, 22);

  assert.equal(results.get('cleric').spellcasting.slots_max[9], 1);
  assert(results.get('cleric').features.some((entry) => entry.name === 'Greater Divine Intervention'));

  assert.equal(results.get('druid').derived_stats.wild_shape_max_cr, 2);
  assert(results.get('druid').features.some((entry) => entry.name === 'Archdruid'));

  assert.equal(results.get('fighter').derived_stats.attacks_per_action, 4);
  assert.equal(results.get('fighter').derived_stats.weapon_critical_threshold, 18);
  assert.equal(results.get('fighter').resources.indomitable.max, 3);
  assert.equal(results.get('fighter').resources.action_surge.max, 2);

  assert.equal(results.get('monk').resources.focus_points.max, 20);
  assert.equal(results.get('monk').derived_stats.unarmored_movement_bonus, 30);

  assert.equal(results.get('paladin').resources.lay_on_hands.max, 100);
  assert.equal(results.get('paladin').derived_stats.aura_of_protection_range, 30);

  assert.equal(results.get('rogue').derived_stats.sneak_attack_dice, '10d6');
  assert(results.get('rogue').features.some((entry) => entry.name === 'Stroke of Luck'));

  assert.equal(results.get('sorcerer').resources.sorcery_points.max, 20);

  assert.equal(results.get('warlock').spellcasting.slots_max[5], 4);
  assert(results.get('warlock').features.some((entry) => entry.name === 'Eldritch Master'));

  assert.equal(results.get('wizard').spellcasting.prepared_spells_count, 22);
  assert(results.get('wizard').features.some((entry) => entry.name === 'Signature Spells'));
});
