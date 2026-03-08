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
    .insert({ id: sessionId });
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

// ── world_state ────────────────────────────────────────────────────────────

const DEFAULT_WORLD_STATE = {
  current_location:  '',
  locations_visited: [],
  npcs_encountered:  [],
  story_flags:       {},
  active_quest:      '',
  session_turn:      0,
  player_stats: {
    name:         '',
    class:        '',
    level:        1,
    hp:           null,
    max_hp:       null,
    temp_hp:      0,
    armor_class:  10,
    speed:        30,
    conditions:   [],
    spell_slots:  {},
    death_saves:  { successes: 0, failures: 0 },
  },
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
  // Compression is now triggered from campaignLogExtractor after insertion (spec §BUG-015).
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
 * Log a Claude API call. Never throws — logging failures must not disrupt gameplay.
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
