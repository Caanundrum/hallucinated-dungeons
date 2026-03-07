// ── DM1 context assembler ──────────────────────────────────────────────────
// Builds the system prompt and messages array for each DM1 API call.
// Implements the three-tier memory system (spec Section 4) and token
// budget trimming (spec Section 7.3).

const db             = require('./db');
const { estimateTokens } = require('./tokenUtils');

const TOKEN_BUDGET = 8000; // trim if total estimated input exceeds this

/**
 * Assemble the full DM1 context for a player action.
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.dm1Prompt   — contents of dm1.txt
 * @param {string} opts.playerMessage — current player input (not yet saved)
 * @returns {{ systemPrompt: string, messages: Array<{role,content}> }}
 */
async function build({ sessionId, dm1Prompt, playerMessage }) {
  // ── Fetch all context components in parallel ──────────────────────────
  const [worldStateRow, campaignLog, chapterSummaries, rollingWindowRows] =
    await Promise.all([
      db.getWorldState(sessionId),
      db.getCampaignLog(sessionId),
      db.getChapterSummaries(sessionId),
      db.getRollingWindow(sessionId, 40), // 20 pairs = 40 rows
    ]);

  const worldState = worldStateRow?.state || db.DEFAULT_WORLD_STATE;

  // ── Assemble static system prompt parts ──────────────────────────────
  // These are always included regardless of token budget.
  let staticSystemPrompt = dm1Prompt.trimEnd() + '\n\n';

  // Tier: world state block
  staticSystemPrompt += '## CURRENT WORLD STATE\n';
  staticSystemPrompt += JSON.stringify(worldState, null, 2) + '\n\n';

  // Tier 2: campaign log (always included, never trimmed at assembly time)
  if (campaignLog.length > 0) {
    staticSystemPrompt += '## CAMPAIGN LOG\n';
    staticSystemPrompt += campaignLog
      .map((e, i) => `${i + 1}. [Turn ${e.turn_number}] ${e.summary}`)
      .join('\n');
    staticSystemPrompt += '\n\n';
  }

  // ── Build rolling window messages array ───────────────────────────────
  let messages = buildMessagesArray(rollingWindowRows);
  // Append current player input
  messages.push({ role: 'user', content: playerMessage });

  // ── Tier 3: chapter summaries — trimmed oldest-first if over budget ───
  let summaries = [...chapterSummaries]; // oldest-first from DB

  // Calculate initial token estimate
  let chapterText   = buildChapterSummariesText(summaries);
  let systemPrompt  = staticSystemPrompt + chapterText;
  let msgTokens     = messages.reduce((a, m) => a + estimateTokens(m.content), 0);
  let totalTokens   = estimateTokens(systemPrompt) + msgTokens;

  // Drop oldest chapter summaries first
  while (totalTokens > TOKEN_BUDGET && summaries.length > 0) {
    summaries.shift();
    chapterText  = buildChapterSummariesText(summaries);
    systemPrompt = staticSystemPrompt + chapterText;
    totalTokens  = estimateTokens(systemPrompt) + msgTokens;
  }

  // If still over budget, trim oldest rolling window pairs from front
  while (totalTokens > TOKEN_BUDGET && messages.length > 1) {
    const removed = messages.splice(0, 2); // remove oldest user+assistant pair
    msgTokens    -= removed.reduce((a, m) => a + estimateTokens(m.content), 0);
    totalTokens   = estimateTokens(systemPrompt) + msgTokens;
  }

  // Ensure messages array starts with a user-role message
  while (messages.length > 0 && messages[0].role !== 'user') {
    const removed = messages.shift();
    msgTokens -= estimateTokens(removed.content);
  }

  return { systemPrompt, messages };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildChapterSummariesText(summaries) {
  if (summaries.length === 0) return '';
  let text = '## STORY SO FAR\n';
  text += summaries
    .map((s) => `[Turns ${s.turn_start}–${s.turn_end}] ${s.summary}`)
    .join('\n\n');
  return text + '\n\n';
}

/**
 * Convert DB message rows (player_dm1, dm1) to API messages array.
 * Enforces strict user/assistant alternation by merging consecutive same-role
 * messages — this handles orphaned player_dm1 rows (see spec Section 12).
 */
function buildMessagesArray(dbRows) {
  const raw = [];
  for (const row of dbRows) {
    if (row.role === 'player_dm1') {
      raw.push({ role: 'user', content: row.content });
    } else if (row.role === 'dm1') {
      raw.push({ role: 'assistant', content: row.content });
    }
    // Ignore player_dm2, dm2 rows — DM2 context is never fed to DM1
  }
  return enforceAlternation(raw);
}

/**
 * Merge consecutive same-role messages so the array strictly alternates.
 * An orphaned user message (no DM response) will be merged with the next
 * user message — DM1 may then address both in its response (spec §12).
 */
function enforceAlternation(messages) {
  if (messages.length === 0) return [];
  const result = [];
  for (const msg of messages) {
    if (result.length > 0 && result[result.length - 1].role === msg.role) {
      result[result.length - 1] = {
        role:    msg.role,
        content: result[result.length - 1].content + '\n\n' + msg.content,
      };
    } else {
      result.push({ ...msg });
    }
  }
  return result;
}

module.exports = { build };
