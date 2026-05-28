const test = require('node:test');
const assert = require('node:assert/strict');
const { filterActivePartyPresenceRows } = require('../src/partyPresence');

test('filters stale present rows when live socket registry is provided', () => {
  const rows = [
    { character_id: 'live-a', presence: 'present', in_combat: false },
    { character_id: 'stale-b', presence: 'present', in_combat: false },
    { character_id: 'away-c', presence: 'away', in_combat: false },
  ];

  const filtered = filterActivePartyPresenceRows(rows, { liveCharacterIds: ['live-a'] });

  assert.deepEqual(filtered.map((row) => row.character_id), ['live-a']);
});

test('keeps combat-locked characters even without a live socket', () => {
  const rows = [
    { character_id: 'stale-fighter', presence: 'present', in_combat: true },
    { character_id: 'stale-bard', presence: 'present', in_combat: false },
  ];

  const filtered = filterActivePartyPresenceRows(rows, { liveCharacterIds: [] });

  assert.deepEqual(filtered.map((row) => row.character_id), ['stale-fighter']);
});

test('can exclude the character whose entrance or exit is being narrated', () => {
  const rows = [
    { character_id: 'current', presence: 'present', in_combat: false },
    { character_id: 'other', presence: 'present', in_combat: false },
  ];

  const filtered = filterActivePartyPresenceRows(rows, {
    liveCharacterIds: ['current', 'other'],
    excludeCharacterId: 'current',
  });

  assert.deepEqual(filtered.map((row) => row.character_id), ['other']);
});
