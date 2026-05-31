process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getContentBundle } = require('../src/contentData');
const { STATUS, buildRulesCoverageMatrix } = require('../src/rulesCoverage');

test('builds a machine-readable coverage matrix for all exposed content catalogs', () => {
  const content = getContentBundle();
  const matrix = buildRulesCoverageMatrix({ content });

  assert.equal(matrix.version, '4C.6-H10');
  assert.equal(matrix.sections.classes.entries.length, content.classes.length);
  assert.equal(matrix.sections.species.entries.length, content.species.length);
  assert.equal(matrix.sections.origin_feats.entries.length, content.feats.length);
  assert.equal(matrix.sections.spells.entries.length, content.spells.length);
  assert.equal(matrix.sections.equipment.entries.length, content.equipment.length);
  assert.ok(matrix.sections.actions.entries.length >= 12);
  assert.ok(matrix.sections.conditions.entries.length >= 16);
  assert.ok(matrix.sections.resources.entries.length >= 12);
  assert.equal(matrix.sections.weapon_masteries.entries.length, 8);
  assert.equal(matrix.sections.fighting_styles.entries.length, 10);
  assert.ok(matrix.summary.exposed_total > 0);
});

test('coverage entries only use known statuses and include gaps for incomplete rules', () => {
  const matrix = buildRulesCoverageMatrix();
  const allowed = new Set(Object.values(STATUS));
  const allEntries = Object.values(matrix.sections).flatMap((section) => (
    section.entries.flatMap((entry) => [entry, ...(entry.children || [])])
  ));

  assert.ok(allEntries.length > 100);
  for (const entry of allEntries) {
    assert.ok(allowed.has(entry.status), `${entry.category}:${entry.id} has bad status ${entry.status}`);
    if (entry.status !== STATUS.IMPLEMENTED) {
      assert.ok(Array.isArray(entry.gaps), `${entry.category}:${entry.id} should include gaps`);
      assert.ok(entry.gaps.length > 0, `${entry.category}:${entry.id} should name at least one gap`);
    }
  }
});

test('matrix flags the foundation gaps that block leveling work', () => {
  const matrix = buildRulesCoverageMatrix();
  const resources = new Map(matrix.sections.resources.entries.map((entry) => [entry.id, entry]));
  const feats = new Map(matrix.sections.origin_feats.entries.map((entry) => [entry.id, entry]));
  const classes = new Map(matrix.sections.classes.entries.map((entry) => [entry.id, entry]));
  const human = matrix.sections.species.entries.find((entry) => entry.id === 'human');
  const resourceful = human.children.find((entry) => entry.id === 'resourceful');

  assert.equal(resources.get('heroic_inspiration').status, STATUS.PARTIAL);
  assert.equal(feats.get('lucky').status, STATUS.PARTIAL);
  assert.equal(resourceful.status, STATUS.IMPLEMENTED);
  assert.equal(classes.get('paladin').status, STATUS.PARTIAL);
  assert.equal(classes.get('wizard').status, STATUS.PARTIAL);
});
