// ── Supabase client & all database operations ──────────────────────────────
require('dotenv').config({ override: true });
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

  // Check cap and compress if needed
  await compressCampaignLogIfNeeded(sessionId);
}

async function compressCampaignLogIfNeeded(sessionId) {
  const { count, error } = await supabase
    .from('campaign_log')
    .select('*', { count: 'exact', head: true })
    .eq('session_id', sessionId);
  if (error || count === null) return;

  if (count >= 60) {
    await compressCampaignLog(sessionId);
  }
}

async function compressCampaignLog(sessionId) {
  // Select oldest entry-type records (up to 10 — or all if fewer than 10 exist)
  const { data: entries, error } = await supabase
    .from('campaign_log')
    .select('*')
    .eq('session_id', sessionId)
    .eq('type', 'entry')
    .order('created_at', { ascending: true })
    .limit(10);

  if (error || !entries || entries.length === 0) return;

  // Build archive summary by concatenating entry text
  const minTurn = entries[0].turn_number;
  const maxTurn = entries[entries.length - 1].turn_number;
  const combined = entries.map((e) => e.summary).join(' ');
  const archiveSummary = `[Archive turns ${minTurn}–${maxTurn}] ${combined}`;

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
      summary:     archiveSummary,
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
  // chapter_summaries
  getChapterSummaries,
  addChapterSummary,
  // dm_logs
  logDmCall,
};
