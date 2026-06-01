// ── Supabase client & all database operations ──────────────────────────────
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── sessions ───────────────────────────────────────────────────────────────

async function createSession(sessionId) {
  const { error } = await supabase
    .from('sessions')
    .insert({ id: sessionId, campaign_id: DEFAULT_CAMPAIGN_ID });
  if (error) throw error;
}

async function getSession(sessionId) {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', sessionId)
    .single();
  // PGRST116 = row not found — return null instead of throwing
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

async function updateLastActive(sessionId) {
  const { error } = await supabase
    .from('sessions')
    .update({ last_active_at: new Date().toISOString() })
    .eq('id', sessionId);
  if (error) throw error;
}

// ── campaigns / characters ─────────────────────────────────────────────────

const DEFAULT_CAMPAIGN_ID = '00000000-0000-4000-8000-000000000001';

async function getOrCreateDefaultCampaign() {
  const payload = {
    id: DEFAULT_CAMPAIGN_ID,
    slug: 'main',
    title: 'Hallucinated Dungeons',
    status: 'active',
  };
  const { data, error } = await supabase
    .from('campaigns')
    .upsert(payload, { onConflict: 'slug' })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function getCharacterForSession(sessionId) {
  const { data, error } = await supabase
    .from('characters')
    .select('*')
    .eq('session_id', sessionId)
    .eq('campaign_id', DEFAULT_CAMPAIGN_ID)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

async function getAccessibleCharacters(sessionId) {
  const { data, error } = await supabase
    .from('characters')
    .select('*')
    .eq('campaign_id', DEFAULT_CAMPAIGN_ID)
    .eq('status', 'active')
    .or(`owner_session_id.eq.${sessionId},session_id.eq.${sessionId}`)
    .order('updated_at', { ascending: false });
  if (error) throw error;

  const seen = new Set();
  return (data || []).filter((character) => {
    if (seen.has(character.id)) return false;
    seen.add(character.id);
    return true;
  });
}

async function getAccessibleCharacter(sessionId, characterId) {
  const characters = await getAccessibleCharacters(sessionId);
  return characters.find((character) => character.id === characterId) || null;
}

async function setActiveCharacterForSession(sessionId, characterId) {
  const character = await getAccessibleCharacter(sessionId, characterId);
  if (!character) return null;

  const timestamp = new Date().toISOString();
  const { error: clearError } = await supabase
    .from('characters')
    .update({ session_id: null, updated_at: timestamp })
    .eq('campaign_id', DEFAULT_CAMPAIGN_ID)
    .eq('session_id', sessionId);
  if (clearError) throw clearError;

  const { data, error } = await supabase
    .from('characters')
    .update({
      session_id: sessionId,
      owner_session_id: character.owner_session_id || sessionId,
      updated_at: timestamp,
    })
    .eq('id', characterId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function clearActiveCharacterForSession(sessionId, characterId = null) {
  let query = supabase
    .from('characters')
    .update({ session_id: null, updated_at: new Date().toISOString() })
    .eq('campaign_id', DEFAULT_CAMPAIGN_ID)
    .eq('session_id', sessionId);

  if (characterId) query = query.eq('id', characterId);
  const { error } = await query;
  if (error) throw error;
}

async function saveCharacterForSession(sessionId, characterSheet) {
  await getOrCreateDefaultCampaign();

  const timestamp = new Date().toISOString();
  const { error: clearError } = await supabase
    .from('characters')
    .update({ session_id: null, updated_at: timestamp })
    .eq('campaign_id', DEFAULT_CAMPAIGN_ID)
    .eq('session_id', sessionId);
  if (clearError) throw clearError;

  const { data, error } = await supabase
    .from('characters')
    .insert({
      session_id: sessionId,
      campaign_id: DEFAULT_CAMPAIGN_ID,
      owner_session_id: sessionId,
      name: characterSheet.identity.name,
      character_sheet: characterSheet,
      status: 'active',
      updated_at: timestamp,
    })
    .select('*')
    .single();
  if (error) throw error;

  const { error: linkError } = await supabase
    .from('campaign_characters')
    .upsert({
      campaign_id: DEFAULT_CAMPAIGN_ID,
      character_id: data.id,
      status: 'available',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'campaign_id,character_id' });
  if (linkError) throw linkError;

  return data;
}

async function updateCharacterSheet(characterId, characterSheet) {
  const { data, error } = await supabase
    .from('characters')
    .update({
      character_sheet: characterSheet,
      updated_at: new Date().toISOString(),
    })
    .eq('id', characterId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function upsertCharacterPresence({
  sessionId,
  characterId,
  presence = 'present',
  inCombat = false,
}) {
  const { data, error } = await supabase
    .from('character_presence')
    .upsert({
      campaign_id: DEFAULT_CAMPAIGN_ID,
      character_id: characterId,
      session_id: sessionId || null,
      presence,
      in_combat: Boolean(inCombat),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'campaign_id,character_id' })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function getCharacterPresenceForCampaign() {
  const { data, error } = await supabase
    .from('character_presence')
    .select('*, characters(name, character_sheet)')
    .eq('campaign_id', DEFAULT_CAMPAIGN_ID)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function getCharacterPresence(characterId) {
  const { data, error } = await supabase
    .from('character_presence')
    .select('*')
    .eq('campaign_id', DEFAULT_CAMPAIGN_ID)
    .eq('character_id', characterId)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

// ── world_state ────────────────────────────────────────────────────────────

const DEFAULT_WORLD_STATE = {
  current_location:  '',
  scene_presence: {
    exact_location:    '',
    location_type:     '',
    present_npcs:      [],
    present_objects:   [],
    available_exits:   [],
    nearby_locations:  [],
  },
  locations_visited: [],
  npcs_encountered:  [],
  story_flags:       {},
  active_quest:      '',
  session_turn:      0,
  time_state: {
    elapsed_rounds:  0,
    elapsed_minutes: 0,
    scene_time:      '',
  },
  active_effects:    [],
  player_stats: {
    name:           '',
    class:          '',
    level:          1,
    hp:             null,
    max_hp:         null,
    temp_hp:        0,
    armor_class:    10,
    base_armor_class: 10,
    speed:          30,
    conditions:     [],
    spell_slots:    {},
    death_saves:    { successes: 0, failures: 0 },
    weapon_name:    '',          // Primary weapon for DM2 context.
    ability_scores: {},          // Ability modifiers, e.g. { str: 3, dex: 1, ... }.
  },
  pending_roll: null,
  pending_reaction: null,
  combat_state: null,
};

async function initWorldState(sessionId) {
  const { error } = await supabase
    .from('world_state')
    .insert({ session_id: sessionId, state: DEFAULT_WORLD_STATE });
  if (error) throw error;
}

async function getWorldState(sessionId) {
  const { data, error } = await supabase
    .from('world_state')
    .select('*')
    .eq('session_id', sessionId)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

async function updateWorldState(sessionId, newState) {
  const { error } = await supabase
    .from('world_state')
    .update({ state: newState, updated_at: new Date().toISOString() })
    .eq('session_id', sessionId);
  if (error) throw error;
}

/**
 * Increment session_turn by 1. Called after both messages for a turn are saved.
 */
async function incrementSessionTurn(sessionId) {
  const row = await getWorldState(sessionId);
  if (!row) return;
  const newState = { ...row.state, session_turn: (row.state.session_turn || 0) + 1 };
  await updateWorldState(sessionId, newState);
  return newState.session_turn;
}

// ── messages ───────────────────────────────────────────────────────────────

async function saveMessage(sessionId, role, content, turnNumber = null) {
  const tokenEstimate = Math.ceil((content || '').length / 4);
  const { error } = await supabase
    .from('messages')
    .insert({
      session_id:     sessionId,
      role,
      content,
      turn_number:    turnNumber,
      token_estimate: tokenEstimate,
    });
  if (error) throw error;
}

/**
 * Get the most recent `limit` DM1-track messages, returned in chronological order.
 * Used to build the rolling window (limit = 40 = 20 pairs).
 */
async function getRollingWindow(sessionId, limit = 40) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('session_id', sessionId)
    .in('role', ['player_dm1', 'dm1'])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).reverse(); // chronological order
}

/**
 * Get DM1-track messages within a turn range (for chapter summarizer).
 */
async function getMessagesByTurnRange(sessionId, turnStart, turnEnd) {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content')
    .eq('session_id', sessionId)
    .in('role', ['player_dm1', 'dm1'])
    .gte('turn_number', turnStart)
    .lte('turn_number', turnEnd)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

/**
 * Get all messages for a session, ordered chronologically.
 * Used for session recovery — returns both DM tracks.
 */
async function getSessionHistory(sessionId) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// ── campaign_log ───────────────────────────────────────────────────────────

async function getCampaignLog(sessionId) {
  const { data, error } = await supabase
    .from('campaign_log')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function addCampaignLogEntry(sessionId, turnNumber, summary) {
  const { error } = await supabase
    .from('campaign_log')
    .insert({
      session_id:  sessionId,
      turn_number: turnNumber,
      summary,
      type:        'entry',
    });
  if (error) throw error;
  // Compression is now triggered from campaignLogExtractor after insertion.
}

/**
 * Returns the total number of campaign_log rows for a session.
 */
async function getCampaignLogCount(sessionId) {
  const { count, error } = await supabase
    .from('campaign_log')
    .select('*', { count: 'exact', head: true })
    .eq('session_id', sessionId);
  if (error) throw error;
  return count || 0;
}

/**
 * Returns the oldest `limit` entry-type campaign log rows, ascending by created_at.
 */
async function getOldestCampaignEntries(sessionId, limit = 10) {
  const { data, error } = await supabase
    .from('campaign_log')
    .select('*')
    .eq('session_id', sessionId)
    .eq('type', 'entry')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

/**
 * Delete `entries` and replace them with a single archive row using the
 * AI-generated `archiveSummary`. Caller is responsible for generating the summary.
 *
 * @param {string}   sessionId
 * @param {object[]} entries       — rows to compress (must include .id and .turn_number)
 * @param {string}   archiveSummary — AI-generated summary text
 */
async function compressCampaignLog(sessionId, entries, archiveSummary) {
  if (!entries || entries.length === 0) return;

  const minTurn = entries[0].turn_number;
  const maxTurn = entries[entries.length - 1].turn_number;
  const archiveText = `[Archive turns ${minTurn}–${maxTurn}] ${archiveSummary}`;

  // Delete the compressed entries
  const idsToDelete = entries.map((e) => e.id);
  const { error: delErr } = await supabase
    .from('campaign_log')
    .delete()
    .in('id', idsToDelete);
  if (delErr) throw delErr;

  // Insert single archive entry
  const { error: insErr } = await supabase
    .from('campaign_log')
    .insert({
      session_id:  sessionId,
      turn_number: minTurn,
      summary:     archiveText,
      type:        'archive',
    });
  if (insErr) throw insErr;
}

// ── chapter_summaries ──────────────────────────────────────────────────────

async function getChapterSummaries(sessionId) {
  const { data, error } = await supabase
    .from('chapter_summaries')
    .select('*')
    .eq('session_id', sessionId)
    .order('turn_start', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function addChapterSummary(sessionId, turnStart, turnEnd, summary) {
  const { error } = await supabase
    .from('chapter_summaries')
    .insert({
      session_id: sessionId,
      turn_start:  turnStart,
      turn_end:    turnEnd,
      summary,
    });
  if (error) throw error;
}

// ── dm_logs ────────────────────────────────────────────────────────────────

/**
 * Log an AI provider call. Never throws — logging failures must not disrupt gameplay.
 */
async function logDmCall({
  sessionId,
  dm,
  model,
  playerInput,
  fullPrompt,
  dmResponse,
  inputTokens,
  outputTokens,
}) {
  const { error } = await supabase
    .from('dm_logs')
    .insert({
      session_id:    sessionId,
      dm,
      model,
      player_input:  playerInput  || null,
      full_prompt:   fullPrompt,
      dm_response:   dmResponse   || null,
      input_tokens:  inputTokens  || null,
      output_tokens: outputTokens || null,
    });
  if (error) console.error('dm_logs insert error:', error.message);
}

module.exports = {
  // sessions
  createSession,
  getSession,
  updateLastActive,
  DEFAULT_CAMPAIGN_ID,
  getOrCreateDefaultCampaign,
  getCharacterForSession,
  getAccessibleCharacters,
  getAccessibleCharacter,
  setActiveCharacterForSession,
  clearActiveCharacterForSession,
  saveCharacterForSession,
  updateCharacterSheet,
  upsertCharacterPresence,
  getCharacterPresenceForCampaign,
  getCharacterPresence,
  // world_state
  initWorldState,
  getWorldState,
  updateWorldState,
  incrementSessionTurn,
  DEFAULT_WORLD_STATE,
  // messages
  saveMessage,
  getRollingWindow,
  getMessagesByTurnRange,
  getSessionHistory,
  // campaign_log
  getCampaignLog,
  addCampaignLogEntry,
  getCampaignLogCount,
  getOldestCampaignEntries,
  compressCampaignLog,
  // chapter_summaries
  getChapterSummaries,
  addChapterSummary,
  // dm_logs
  logDmCall,
};
