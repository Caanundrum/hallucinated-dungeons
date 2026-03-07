// ── Chapter summarizer ─────────────────────────────────────────────────────
// Triggered when session_turn % 50 === 0 (after increment).
// Queries the messages table for the completed chapter's turn range,
// asks Haiku to write a paragraph summary, and saves it to chapter_summaries.
// All failures are silent — the game continues unchanged.
//
// Turn range formula (spec §4.5):
//   turn_end   = session_turn - 1
//   turn_start = session_turn - 50
// Example: at session_turn = 100, covers turns 50–99.

const anthropic            = require('./anthropic');
const db                   = require('./db');
const { HAIKU }            = require('./models');
const { retryWithBackoff } = require('./retryUtils');

const SYSTEM_PROMPT = `You are a campaign archivist for a D&D 5e adventure game.
Given a sequence of player actions and DM responses from one chapter of gameplay, write a concise paragraph-length narrative summary capturing the key events, decisions, and story developments.

Write in past tense, third person. Focus on story beats, character moments, and meaningful choices. Do not list every individual action — synthesize into a readable narrative arc.
Return ONLY the summary paragraph. No JSON, no labels, no markdown.`;

/**
 * Generate and save a chapter summary for the completed chapter.
 * Called after session_turn is incremented when session_turn % 50 === 0.
 *
 * @param {string} sessionId
 * @param {number} sessionTurn — the current (post-increment) session_turn value
 */
async function summarize(sessionId, sessionTurn) {
  try {
    const turnEnd   = sessionTurn - 1;
    const turnStart = sessionTurn - 50;

    const messages = await db.getMessagesByTurnRange(sessionId, turnStart, turnEnd);

    if (messages.length === 0) {
      console.log(`chapterSummarizer: no messages for turns ${turnStart}–${turnEnd}, skipping`);
      return;
    }

    // Build transcript
    const transcript = messages
      .map((m) => `${m.role === 'player_dm1' ? 'Player' : 'DM'}: ${m.content}`)
      .join('\n\n');

    const userContent = `Chapter covering turns ${turnStart} to ${turnEnd}:\n\n${transcript}`;

    const response = await retryWithBackoff(() => anthropic.messages.create({
      model:      HAIKU,
      max_tokens: 512,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userContent }],
    }));

    const summary = response.content[0].text.trim();

    await db.addChapterSummary(sessionId, turnStart, turnEnd, summary);

    await db.logDmCall({
      sessionId,
      dm:           'chapter_summary',
      model:        HAIKU,
      playerInput:  null,
      fullPrompt:   SYSTEM_PROMPT + '\n\n' + userContent,
      dmResponse:   summary,
      inputTokens:  response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    }).catch(() => {});

    console.log(`chapterSummarizer: saved summary for turns ${turnStart}–${turnEnd}`);

  } catch (err) {
    // Silent failure per spec §12
    console.error('chapterSummarizer error (silent):', err.message);
  }
}

module.exports = { summarize };
