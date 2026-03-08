require('dotenv').config({ override: true });
const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const cors      = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs        = require('fs');
const path      = require('path');

const anthropic            = require('./anthropic');
const db                   = require('./db');
const contextBuilder       = require('./contextBuilder');
const worldStateExtractor  = require('./worldStateExtractor');
const campaignLogExtractor = require('./campaignLogExtractor');
const chapterSummarizer    = require('./chapterSummarizer');
const { SONNET, HAIKU }    = require('./models');
const { retryWithBackoff } = require('./retryUtils');

// ── Setup ──────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

const io = new Server(server, {
  cors: { origin: CLIENT_URL, methods: ['GET', 'POST'] },
});

app.use(cors({ origin: CLIENT_URL }));
app.use(express.json());

// ── Load prompts ───────────────────────────────────────────────────────────
const DM1_PROMPT = fs.readFileSync(
  path.join(__dirname, '../prompts/dm1.txt'), 'utf8'
);
const DM2_PROMPT = fs.readFileSync(
  path.join(__dirname, '../prompts/dm2.txt'), 'utf8'
);

// ── Async post-response pipeline ───────────────────────────────────────────
// Fires after DM1 response is already emitted to the client.
// All steps have silent failure — never blocks gameplay.
// Known race condition: if a player submits their next action before these
// Haiku calls complete, the next DM1 context will be one turn behind on
// world state and campaign log. Acceptable for Phase 2 single player.
async function runPostResponsePipeline(sessionId, playerMessage, dm1Reply, newTurn) {
  await Promise.allSettled([
    worldStateExtractor.extract(sessionId, playerMessage, dm1Reply),
    campaignLogExtractor.extract(sessionId, playerMessage, dm1Reply, newTurn),
  ]);

  if (newTurn % 50 === 0) {
    await chapterSummarizer.summarize(sessionId, newTurn).catch(console.error);
  }
}

// ── Socket.io events ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // ── join_session ──────────────────────────────────────────────────────
  socket.on('join_session', async ({ sessionId }) => {
    try {
      let id       = sessionId;
      let isResume = false;

      if (id) {
        const existing = await db.getSession(id);
        if (existing) {
          isResume = true;
        } else {
          console.log(`Session ${id} not found in DB, creating new session`);
          id = uuidv4();
        }
      } else {
        id = uuidv4();
      }

      if (!isResume) {
        await db.createSession(id);
        await db.initWorldState(id);
      }

      await db.updateLastActive(id);
      socket.join(id);
      socket.sessionId = id;
      console.log(`Socket ${socket.id} ${isResume ? 'resumed' : 'joined'} session ${id}`);

      if (isResume) {
        const history = await db.getSessionHistory(id);
        socket.emit('session_resumed', { sessionId: id, history });
      } else {
        socket.emit('session_joined', { sessionId: id });
      }

    } catch (err) {
      console.error('join_session error:', err);
      const fallbackId = uuidv4();
      try {
        await db.createSession(fallbackId);
        await db.initWorldState(fallbackId);
      } catch (dbErr) {
        console.error('join_session fallback DB error:', dbErr);
      }
      socket.join(fallbackId);
      socket.sessionId = fallbackId;
      socket.emit('session_joined', { sessionId: fallbackId });
    }
  });

  // ── session_start ─────────────────────────────────────────────────────
  // Generates the DM1 campaign opening for genuinely new sessions.
  // Guard: only valid on new sessions (history must be empty).
  // Never emit this on resume/reload — the session_resumed flow handles that.
  socket.on('session_start', async () => {
    const sessionId = socket.sessionId;
    if (!sessionId) return;

    try {
      // Safety guard — if there is already history, ignore this event
      const history = await db.getSessionHistory(sessionId);
      const narrativeHistory = history.filter((m) => m.role === 'player_dm1' || m.role === 'dm1');
      if (narrativeHistory.length > 0) {
        console.log(`session_start ignored — session ${sessionId} already has history`);
        return;
      }

      socket.emit('dm1_typing', true);

      const openingPrompt = 'Begin the campaign. Set the scene, establish the world and tone, and drop the player into their first moment of the adventure. End with an open prompt that invites their first action.';

      const { systemPrompt, messages } = await contextBuilder.build({
        sessionId,
        dm1Prompt:     DM1_PROMPT,
        playerMessage: openingPrompt,
      });

      let dm1Reply, inputTokens, outputTokens;
      try {
        const response = await retryWithBackoff(() => anthropic.messages.create({
          model:      SONNET,
          max_tokens: 2048,
          system:     systemPrompt,
          messages,
        }));
        dm1Reply     = response.content[0].text;
        inputTokens  = response.usage?.input_tokens;
        outputTokens = response.usage?.output_tokens;
      } catch (apiErr) {
        console.error('session_start DM1 API error:', apiErr.message);
        socket.emit('dm1_typing', false);
        socket.emit('error', { message: 'The Dungeon Master encountered an error starting your session. Please refresh.' });
        return;
      }

      // Save the opening as a DM1 message (no player_dm1 counterpart)
      await db.saveMessage(sessionId, 'dm1', dm1Reply, 0);

      socket.emit('dm1_typing', false);
      socket.emit('dm1_response', { message: dm1Reply });

      await db.logDmCall({
        sessionId,
        dm:           'dm1',
        model:        SONNET,
        playerInput:  '[session_start]',
        fullPrompt:   systemPrompt + '\n\n[MESSAGES]: ' + JSON.stringify(messages),
        dmResponse:   dm1Reply,
        inputTokens,
        outputTokens,
      }).catch(console.error);

    } catch (err) {
      console.error('session_start error:', err);
      socket.emit('dm1_typing', false);
      socket.emit('error', { message: 'The Dungeon Master encountered an error. Please refresh.' });
    }
  });

  // ── story_input ───────────────────────────────────────────────────────
  socket.on('story_input', async ({ message }) => {
    const sessionId = socket.sessionId;
    if (!sessionId) {
      socket.emit('error', { message: 'No active session. Please refresh.' });
      return;
    }

    try {
      await db.updateLastActive(sessionId);

      // Get pre-increment session_turn — both messages for this exchange share it
      const worldStateRow = await db.getWorldState(sessionId);
      const currentTurn   = worldStateRow?.state?.session_turn ?? 0;

      // Save player message with pre-increment turn_number
      await db.saveMessage(sessionId, 'player_dm1', message, currentTurn);

      // Assemble three-tier DM1 context
      const { systemPrompt, messages } = await contextBuilder.build({
        sessionId,
        dm1Prompt:     DM1_PROMPT,
        playerMessage: message,
      });

      socket.emit('dm1_typing', true);

      let dm1Reply, inputTokens, outputTokens;
      try {
        const response = await retryWithBackoff(() => anthropic.messages.create({
          model:      SONNET,
          max_tokens: 2048,
          system:     systemPrompt,
          messages,
        }));
        dm1Reply     = response.content[0].text;
        inputTokens  = response.usage?.input_tokens;
        outputTokens = response.usage?.output_tokens;

      } catch (apiErr) {
        // DM1 API failure — emit error, leave orphaned player_dm1 in DB,
        // do NOT increment session_turn (spec §12).
        console.error('DM1 API error:', apiErr.message);
        socket.emit('dm1_typing', false);
        socket.emit('error', { message: 'The Dungeon Master encountered an error. Please try again.' });

        // Store assembled prompt; append error details (spec §12)
        const fullPromptForLog = [
          systemPrompt,
          '[MESSAGES]: ' + JSON.stringify(messages),
          '[ERROR]: '    + (apiErr.message || String(apiErr)),
        ].join('\n\n');

        await db.logDmCall({
          sessionId,
          dm:           'dm1',
          model:        SONNET,
          playerInput:  message,
          fullPrompt:   fullPromptForLog,
          dmResponse:   null,
          inputTokens:  null,
          outputTokens: null,
        }).catch(console.error);
        return;
      }

      // Save DM1 response with the SAME pre-increment turn_number (spec §3.2)
      await db.saveMessage(sessionId, 'dm1', dm1Reply, currentTurn);

      // Increment session_turn AFTER both messages are saved (spec §10.2)
      const newTurn = await db.incrementSessionTurn(sessionId);

      socket.emit('dm1_typing', false);
      socket.emit('dm1_response', { message: dm1Reply });

      await db.logDmCall({
        sessionId,
        dm:           'dm1',
        model:        SONNET,
        playerInput:  message,
        fullPrompt:   systemPrompt + '\n\n[MESSAGES]: ' + JSON.stringify(messages),
        dmResponse:   dm1Reply,
        inputTokens,
        outputTokens,
      }).catch(console.error);

      // Fire async post-response pipeline — do NOT await (would add latency)
      runPostResponsePipeline(sessionId, message, dm1Reply, newTurn).catch(console.error);

    } catch (err) {
      console.error('story_input error:', err);
      socket.emit('dm1_typing', false);
      socket.emit('error', { message: 'The Dungeon Master encountered an error. Please try again.' });
    }
  });

  // ── rules_input ───────────────────────────────────────────────────────
  socket.on('rules_input', async ({ message }) => {
    const sessionId = socket.sessionId;
    if (!sessionId) {
      socket.emit('dm2_error', { message: 'No active session. Please refresh.' });
      return;
    }

    try {
      // Step 1: update last active
      try {
        await db.updateLastActive(sessionId);
      } catch (dbErr) {
        console.error('rules_input: db.updateLastActive failed:', dbErr.message);
        throw dbErr;
      }

      // Step 2: save player DM2 message — no turn_number (DM2 is stateless)
      try {
        await db.saveMessage(sessionId, 'player_dm2', message, null);
      } catch (dbErr) {
        console.error('rules_input: db.saveMessage(player_dm2) failed:', dbErr.message);
        throw dbErr;
      }

      // Step 3: Fetch world state for context injection (spec §8.5)
      // If this fails, fall back gracefully — DM2 still answers without context.
      let worldStateContext = '';
      try {
        const worldStateRow = await db.getWorldState(sessionId);
        const ws = worldStateRow?.state;
        if (ws) {
          const contextParts = [];
          if (ws.current_location) {
            contextParts.push(`Current location: ${ws.current_location}`);
          }
          const activeNpcs = (ws.npcs_encountered || []).filter((n) => n?.name);
          if (activeNpcs.length > 0) {
            contextParts.push(`NPCs present: ${activeNpcs.map((n) => `${n.name} (${n.disposition || 'unknown'})`).join(', ')}`);
          }
          if (ws.combat_state && ws.combat_state.active) {
            contextParts.push(`COMBAT ACTIVE — Round ${ws.combat_state.round}. Combatants: ${
              (ws.combat_state.combatants || [])
                .map((c) => `${c.name} (HP: ${c.hp}/${c.max_hp}, Initiative: ${c.initiative}${c.conditions?.length ? ', conditions: ' + c.conditions.join(', ') : ''})`)
                .join('; ')
            }`);
          }
          if (ws.player_stats) {
            const ps = ws.player_stats;
            const statParts = [];
            if (ps.name) statParts.push(`Name: ${ps.name}`);
            if (ps.class) statParts.push(`Class: ${ps.class} (level ${ps.level || 1})`);
            if (ps.hp !== null) statParts.push(`HP: ${ps.hp}/${ps.max_hp}`);
            if (ps.armor_class) statParts.push(`AC: ${ps.armor_class}`);
            if (ps.speed) statParts.push(`Speed: ${ps.speed} ft`);
            if (ps.conditions?.length) statParts.push(`Conditions: ${ps.conditions.join(', ')}`);
            // BUG-023: weapon and ability scores so DM2 can answer damage/attack questions without asking
            if (ps.weapon_name) statParts.push(`Weapon: ${ps.weapon_name}`);
            if (ps.ability_scores && Object.keys(ps.ability_scores).length > 0) {
              const modStr = Object.entries(ps.ability_scores)
                .map(([k, v]) => `${k.toUpperCase()} ${v >= 0 ? '+' : ''}${v}`)
                .join(', ');
              statParts.push(`Ability modifiers: ${modStr}`);
            }
            if (statParts.length > 0) contextParts.push(`Player: ${statParts.join(', ')}`);
          }
          if (contextParts.length > 0) {
            worldStateContext = '\n\n[CURRENT GAME CONTEXT]\n' + contextParts.join('\n');
          }
        }
      } catch (wsErr) {
        console.warn('rules_input: world state fetch failed (non-fatal):', wsErr.message);
      }

      // Step 4: Call DM2 (Haiku — with world state context injected)
      socket.emit('dm2_typing', true);

      let response;
      try {
        const dm2UserMessage = message + worldStateContext;
        response = await retryWithBackoff(() => anthropic.messages.create({
          model:      HAIKU,
          max_tokens: 1024,
          system:     DM2_PROMPT,
          messages:   [{ role: 'user', content: dm2UserMessage }],
        }));
      } catch (apiErr) {
        console.error('rules_input: anthropic.messages.create failed:', apiErr.message, '| status:', apiErr.status, '| error:', JSON.stringify(apiErr.error));
        socket.emit('dm2_typing', false);
        socket.emit('dm2_error', { message: 'The Rules Arbiter encountered an error. Please try again.' });
        await db.logDmCall({
          sessionId,
          dm:           'dm2',
          model:        HAIKU,
          playerInput:  message,
          fullPrompt:   DM2_PROMPT + '\n\n' + message + worldStateContext + '\n\n[ERROR]: ' + (apiErr.message || String(apiErr)),
          dmResponse:   null,
          inputTokens:  null,
          outputTokens: null,
        }).catch(console.error);
        return;
      }

      const reply     = response.content[0].text;
      const inputTok  = response.usage?.input_tokens;
      const outputTok = response.usage?.output_tokens;

      // Step 5: save DM2 response
      try {
        await db.saveMessage(sessionId, 'dm2', reply, null);
      } catch (dbErr) {
        console.error('rules_input: db.saveMessage(dm2) failed:', dbErr.message);
        // Non-fatal: response was received — still emit to client
      }

      socket.emit('dm2_typing', false);
      socket.emit('dm2_response', { message: reply });

      await db.logDmCall({
        sessionId,
        dm:           'dm2',
        model:        HAIKU,
        playerInput:  message,
        fullPrompt:   DM2_PROMPT + '\n\n' + message + worldStateContext,
        dmResponse:   reply,
        inputTokens:  inputTok,
        outputTokens: outputTok,
      }).catch(console.error);

    } catch (err) {
      console.error('rules_input error:', err.message, err);
      socket.emit('dm2_typing', false);
      socket.emit('dm2_error', { message: 'The Rules Arbiter encountered an error. Please try again.' });
    }
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Start server ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Hallucinated Dungeons server running on port ${PORT}`);
});
