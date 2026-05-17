require('dotenv').config({ override: true });
const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const cors      = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');

const ai                   = require('./aiClient');
const db                   = require('./db');
const contextBuilder       = require('./contextBuilder');
const worldStateExtractor  = require('./worldStateExtractor');
const campaignLogExtractor = require('./campaignLogExtractor');
const chapterSummarizer    = require('./chapterSummarizer');
const { DM1_MODEL, UTILITY_MODEL } = require('./models');
const { retryWithBackoff } = require('./retryUtils');
const { getContentBundle } = require('./contentData');
const { validateCharacter } = require('./characterValidator');
const { checkSpatialAction } = require('./spatialGuard');

// ── Setup ──────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

const configuredOrigins = [
  process.env.CLIENT_URL,
  process.env.ALLOWED_ORIGINS,
  process.env.NODE_ENV === 'production' ? null : 'http://localhost:5173,http://127.0.0.1:5173',
]
  .filter(Boolean)
  .flatMap((value) => value.split(','))
  .map((value) => value.trim())
  .filter(Boolean);
const allowedOrigins = new Set(configuredOrigins.length ? configuredOrigins : ['http://localhost:5173']);
const corsOrigin = (origin, callback) => {
  if (!origin || allowedOrigins.has(origin)) {
    callback(null, true);
    return;
  }
  callback(new Error(`Origin ${origin} is not allowed by CORS`));
};

const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
});

app.use(cors({ origin: corsOrigin }));
app.use(express.json());

const activeDm1Sessions = new Set();
const characterRollAttempts = new Map();

if ((process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT) && !process.env.SESSION_TOKEN_SECRET) {
  throw new Error('SESSION_TOKEN_SECRET is required in production.');
}

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
// utility model calls complete, the next DM1 context will be one turn behind on
// world state and campaign log. Acceptable for Phase 2 single player.
async function runPostResponsePipeline(sessionId, playerMessage, dm1Reply, newTurn) {
  await Promise.allSettled([
    worldStateExtractor.extract(sessionId, playerMessage, dm1Reply),
    campaignLogExtractor.extract(sessionId, playerMessage, dm1Reply, newTurn),
  ]);

  if (newTurn > 0 && newTurn % 50 === 0) {
    await chapterSummarizer.summarize(sessionId, newTurn).catch(console.error);
  }
}

async function moderateUserMessage(socket, errorEvent, message) {
  const moderation = await ai.moderateText(message);
  if (moderation.ok) return true;

  console.warn('User input blocked by moderation:', moderation.flaggedCategories.join(', '));
  socket.emit(errorEvent, { message: moderation.publicMessage, code: 'moderation_blocked' });
  return false;
}

async function moderateAssistantReply(reply, fallbackReply) {
  const moderation = await ai.moderateText(reply);
  if (moderation.ok) return reply;

  console.warn('Assistant output replaced by moderation:', moderation.flaggedCategories.join(', '));
  return fallbackReply;
}

function getSessionSecret() {
  return process.env.SESSION_TOKEN_SECRET || 'local-dev-session-secret';
}

function signSessionToken(sessionId) {
  const secret = getSessionSecret();
  const signature = crypto
    .createHmac('sha256', secret)
    .update(sessionId)
    .digest('hex');
  return `${sessionId}.${signature}`;
}

function isValidSessionToken(sessionId, token) {
  if (!sessionId || !token) return false;
  const expected = signSessionToken(sessionId);
  const expectedBuffer = Buffer.from(expected);
  const tokenBuffer = Buffer.from(token);
  if (expectedBuffer.length !== tokenBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, tokenBuffer);
}

function characterSheetToWorldStats(characterSheet) {
  const stats = characterSheet.derived_stats || {};
  const identity = characterSheet.identity || {};
  const modifiers = characterSheet.abilities?.modifiers || {};
  const primaryAttack = stats.attack_breakdowns?.[0];
  return {
    name: identity.name || '',
    class: identity.class_name || '',
    level: stats.level || identity.level || 1,
    hp: stats.hp ?? null,
    max_hp: stats.max_hp ?? null,
    temp_hp: stats.temp_hp || 0,
    armor_class: stats.armor_class || 10,
    speed: stats.speed || 30,
    conditions: stats.conditions || [],
    weapon_name: primaryAttack?.name || '',
    ability_scores: modifiers,
  };
}

async function syncCharacterToWorldState(sessionId, characterSheet) {
  const row = await db.getWorldState(sessionId);
  const current = row?.state || db.DEFAULT_WORLD_STATE;
  await db.updateWorldState(sessionId, {
    ...current,
    player_stats: {
      ...(current.player_stats || db.DEFAULT_WORLD_STATE.player_stats),
      ...characterSheetToWorldStats(characterSheet),
    },
  });
}

function hasValidSocketSession(socket, sessionId, sessionToken) {
  return Boolean(
    socket.sessionId
    && sessionId
    && socket.sessionId === sessionId
    && isValidSessionToken(sessionId, sessionToken)
  );
}

function rollD6() {
  return crypto.randomInt(1, 7);
}

function rollAbilityStat() {
  const dice = Array.from({ length: 4 }, rollD6).sort((a, b) => a - b);
  return {
    dice,
    total: dice.slice(1).reduce((sum, value) => sum + value, 0),
  };
}

function signRollSet(sessionId, attemptsUsed, acceptedSet) {
  const payload = JSON.stringify({ sessionId, attemptsUsed, acceptedSet });
  return crypto
    .createHmac('sha256', getSessionSecret())
    .update(payload)
    .digest('hex');
}

function verifyRollSet(sessionId, rolledStats = {}) {
  const acceptedSet = Array.isArray(rolledStats.acceptedSet) ? rolledStats.acceptedSet.map(Number) : [];
  const attemptsUsed = Number(rolledStats.attemptsUsed);
  const rollToken = String(rolledStats.rollToken || '');
  if (!sessionId || acceptedSet.length !== 6 || !Number.isInteger(attemptsUsed) || attemptsUsed < 1 || attemptsUsed > 3 || !rollToken) {
    return false;
  }
  const expected = signRollSet(sessionId, attemptsUsed, acceptedSet);
  const expectedBuffer = Buffer.from(expected);
  const tokenBuffer = Buffer.from(rollToken);
  if (expectedBuffer.length !== tokenBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, tokenBuffer);
}

// ── Socket.io events ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // ── join_session ──────────────────────────────────────────────────────
  socket.on('join_session', async ({ sessionId, sessionToken }) => {
    try {
      await db.getOrCreateDefaultCampaign();
      let id       = sessionId;
      let isResume = false;

      if (id && isValidSessionToken(id, sessionToken)) {
        const existing = await db.getSession(id);
        if (existing) {
          isResume = true;
        } else {
          console.log(`Session ${id} not found in DB, creating new session`);
          id = uuidv4();
        }
      } else {
        if (id) console.warn(`Rejected unsigned session resume attempt for ${id}`);
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
        socket.emit('session_resumed', { sessionId: id, sessionToken: signSessionToken(id), history });
      } else {
        socket.emit('session_joined', { sessionId: id, sessionToken: signSessionToken(id) });
      }

    } catch (err) {
      console.error('join_session error:', err);
      const fallbackId = uuidv4();
      try {
        await db.createSession(fallbackId);
        await db.initWorldState(fallbackId);
      } catch (dbErr) {
        console.error('join_session fallback DB error:', dbErr);
        socket.emit('error', { message: 'The campaign database is unavailable. Please try again in a minute.' });
        return;
      }
      socket.join(fallbackId);
      socket.sessionId = fallbackId;
      socket.emit('session_joined', { sessionId: fallbackId, sessionToken: signSessionToken(fallbackId) });
    }
  });

  // ── session_start ─────────────────────────────────────────────────────
  // Generates the DM1 campaign opening for genuinely new sessions.
  // Guard: only valid on new sessions (history must be empty).
  // Never emit this on resume/reload — the session_resumed flow handles that.
  socket.on('session_start', async () => {
    const sessionId = socket.sessionId;
    if (!sessionId) return;

    if (activeDm1Sessions.has(sessionId)) return;
    activeDm1Sessions.add(sessionId);

    try {
      const existingCharacter = await db.getCharacterForSession(sessionId);
      if (!existingCharacter) {
        console.log(`session_start ignored — session ${sessionId} needs character creation first`);
        socket.emit('character_required', { message: 'Create a character before beginning the campaign.' });
        return;
      }

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
        const response = await retryWithBackoff(() => ai.generateText({
          model:     DM1_MODEL,
          maxTokens: 2048,
          system:    systemPrompt,
          messages,
        }));
        dm1Reply     = response.text;
        inputTokens  = response.inputTokens;
        outputTokens = response.outputTokens;
      } catch (apiErr) {
        console.error('session_start DM1 API error:', apiErr.message);
        socket.emit('dm1_typing', false);
        socket.emit('error', { message: 'The Dungeon Master encountered an error starting your session. Please refresh.' });
        return;
      }

      dm1Reply = await moderateAssistantReply(
        dm1Reply,
        'The road ahead is momentarily veiled. Try refreshing the adventure, and the Dungeon Master will gather the threads again.'
      );

      // Save the opening as a DM1 message (no player_dm1 counterpart)
      await db.saveMessage(sessionId, 'dm1', dm1Reply, 0);

      socket.emit('dm1_typing', false);
      socket.emit('dm1_response', { message: dm1Reply });

      await db.logDmCall({
        sessionId,
        dm:           'dm1',
        model:        DM1_MODEL,
        playerInput:  '[session_start]',
        fullPrompt:   systemPrompt + '\n\n[MESSAGES]: ' + JSON.stringify(messages),
        dmResponse:   dm1Reply,
        inputTokens,
        outputTokens,
      }).catch(console.error);

      socket.emit('dm1_typing', true);
      await runPostResponsePipeline(sessionId, openingPrompt, dm1Reply, 0).catch(console.error);
      socket.emit('dm1_typing', false);

    } catch (err) {
      console.error('session_start error:', err);
      socket.emit('dm1_typing', false);
      socket.emit('error', { message: 'The Dungeon Master encountered an error. Please refresh.' });
    } finally {
      activeDm1Sessions.delete(sessionId);
    }
  });

  socket.on('get_character_data', async ({ sessionId, sessionToken } = {}) => {
    if (!hasValidSocketSession(socket, sessionId, sessionToken)) {
      socket.emit('character_error', {
        step: 'session',
        field: 'sessionToken',
        message: 'Your character sheet could not be opened for this session. Please refresh.',
      });
      return;
    }

    try {
      const campaign = await db.getOrCreateDefaultCampaign();
      const character = await db.getCharacterForSession(sessionId);
      socket.emit('character_data', {
        campaign,
        content: getContentBundle(),
        character: character?.character_sheet || null,
      });
    } catch (err) {
      console.error('get_character_data error:', err);
      socket.emit('character_error', {
        step: 'load',
        field: 'content',
        message: 'Character creation data is unavailable. Please try again.',
      });
    }
  });

  socket.on('roll_character_stats', ({ sessionId, sessionToken } = {}) => {
    if (!hasValidSocketSession(socket, sessionId, sessionToken)) {
      socket.emit('character_error', {
        step: 'abilities',
        field: 'rolledStats',
        message: 'The dice tray lost your session. Refresh, then roll again.',
      });
      return;
    }

    const attemptsUsed = (characterRollAttempts.get(sessionId) || 0) + 1;
    if (attemptsUsed > 3) {
      socket.emit('character_error', {
        step: 'abilities',
        field: 'rolledStats',
        message: 'You have used all 3 stat roll attempts. The dice are now unionized.',
      });
      return;
    }

    const currentSet = Array.from({ length: 6 }, rollAbilityStat);
    const acceptedSet = currentSet.map((entry) => entry.total);
    characterRollAttempts.set(sessionId, attemptsUsed);
    socket.emit('character_roll', {
      attemptsUsed,
      currentSet,
      acceptedSet,
      rollToken: signRollSet(sessionId, attemptsUsed, acceptedSet),
    });
  });

  socket.on('save_character', async ({ sessionId, sessionToken, characterDraft } = {}) => {
    if (!hasValidSocketSession(socket, sessionId, sessionToken)) {
      socket.emit('character_error', {
        step: 'session',
        field: 'sessionToken',
        message: 'Your character could not be saved for this session. Please refresh.',
      });
      return;
    }

    try {
      const campaign = await db.getOrCreateDefaultCampaign();
      const characterSheet = validateCharacter(characterDraft, getContentBundle(), {
        sessionId,
        campaignId: campaign.id,
        verifyRolledStats: (rolledStats) => verifyRollSet(sessionId, rolledStats),
      });
      const saved = await db.saveCharacterForSession(sessionId, characterSheet);
      await syncCharacterToWorldState(sessionId, characterSheet).catch(console.error);
      socket.emit('character_ready', {
        campaign,
        character: saved.character_sheet,
      });
    } catch (err) {
      console.error('save_character error:', err);
      socket.emit('character_error', {
        step: err.step || 'review',
        field: err.field || 'character',
        message: err.message || 'Character validation failed.',
      });
    }
  });

  // ── story_input ───────────────────────────────────────────────────────
  socket.on('story_input', async ({ message }) => {
    const sessionId = socket.sessionId;
    if (!sessionId) {
      socket.emit('error', { message: 'No active session. Please refresh.' });
      return;
    }

    if (activeDm1Sessions.has(sessionId)) {
      socket.emit('error', { message: 'The Dungeon Master is still resolving your last action. Give the dice a second to stop clattering.' });
      return;
    }
    activeDm1Sessions.add(sessionId);

    try {
      await db.updateLastActive(sessionId);

      if (!(await moderateUserMessage(socket, 'error', message))) {
        return;
      }

      // Get pre-increment session_turn — both messages for this exchange share it
      const worldStateRow = await db.getWorldState(sessionId);
      const currentTurn   = worldStateRow?.state?.session_turn ?? 0;

      const spatialIssue = checkSpatialAction(message, worldStateRow?.state);
      if (spatialIssue) {
        await db.saveMessage(sessionId, 'player_dm1', message, currentTurn);
        await db.saveMessage(sessionId, 'dm1', spatialIssue.message, currentTurn);
        await db.incrementSessionTurn(sessionId);
        socket.emit('dm1_response', { message: spatialIssue.message });
        await db.logDmCall({
          sessionId,
          dm:           'spatial_guard',
          model:        'deterministic',
          playerInput:  message,
          fullPrompt:   JSON.stringify(worldStateRow?.state || {}),
          dmResponse:   spatialIssue.message,
          inputTokens:  null,
          outputTokens: null,
        }).catch(console.error);
        return;
      }

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
        const response = await retryWithBackoff(() => ai.generateText({
          model:     DM1_MODEL,
          maxTokens: 2048,
          system:    systemPrompt,
          messages,
        }));
        dm1Reply     = response.text;
        inputTokens  = response.inputTokens;
        outputTokens = response.outputTokens;

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
          model:        DM1_MODEL,
          playerInput:  message,
          fullPrompt:   fullPromptForLog,
          dmResponse:   null,
          inputTokens:  null,
          outputTokens: null,
        }).catch(console.error);
        return;
      }

      dm1Reply = await moderateAssistantReply(
        dm1Reply,
        'The Dungeon Master lowers the screen and stares at you over it. That idea has been denied entry to the campaign, the tavern, and polite society. Try something else.'
      );

      // Save DM1 response with the SAME pre-increment turn_number (spec §3.2)
      await db.saveMessage(sessionId, 'dm1', dm1Reply, currentTurn);

      // Increment session_turn AFTER both messages are saved (spec §10.2)
      const newTurn = await db.incrementSessionTurn(sessionId);

      socket.emit('dm1_typing', false);
      socket.emit('dm1_response', { message: dm1Reply });

      await db.logDmCall({
        sessionId,
        dm:           'dm1',
        model:        DM1_MODEL,
        playerInput:  message,
        fullPrompt:   systemPrompt + '\n\n[MESSAGES]: ' + JSON.stringify(messages),
        dmResponse:   dm1Reply,
        inputTokens,
        outputTokens,
      }).catch(console.error);

      // Keep the turn lock until world state catches up, after the reply is visible.
      socket.emit('dm1_typing', true);
      await runPostResponsePipeline(sessionId, message, dm1Reply, newTurn).catch(console.error);
      socket.emit('dm1_typing', false);

    } catch (err) {
      console.error('story_input error:', err);
      socket.emit('dm1_typing', false);
      socket.emit('error', { message: 'The Dungeon Master encountered an error. Please try again.' });
    } finally {
      activeDm1Sessions.delete(sessionId);
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
      if (!(await moderateUserMessage(socket, 'dm2_error', message))) {
        return;
      }

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
          if (ws.scene_presence?.exact_location) {
            const scene = ws.scene_presence;
            contextParts.push(`Exact scene: ${scene.exact_location}`);
            if (scene.present_npcs?.length) contextParts.push(`NPCs physically present: ${scene.present_npcs.join(', ')}`);
            if (scene.present_objects?.length) contextParts.push(`Objects present: ${scene.present_objects.join(', ')}`);
            if (scene.available_exits?.length) contextParts.push(`Available exits: ${scene.available_exits.join(', ')}`);
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

      // Step 4: Call DM2 (utility model — with world state context injected)
      socket.emit('dm2_typing', true);

      let response;
      try {
        const dm2UserMessage = message + worldStateContext;
        response = await retryWithBackoff(() => ai.generateText({
          model:     UTILITY_MODEL,
          maxTokens: 1024,
          system:    DM2_PROMPT,
          messages:  [{ role: 'user', content: dm2UserMessage }],
        }));
      } catch (apiErr) {
        console.error('rules_input: AI provider call failed:', apiErr.message, '| status:', apiErr.status, '| error:', JSON.stringify(apiErr.error));
        socket.emit('dm2_typing', false);
        socket.emit('dm2_error', { message: 'The Rules Arbiter encountered an error. Please try again.' });
        await db.logDmCall({
          sessionId,
          dm:           'dm2',
          model:        UTILITY_MODEL,
          playerInput:  message,
          fullPrompt:   DM2_PROMPT + '\n\n' + message + worldStateContext + '\n\n[ERROR]: ' + (apiErr.message || String(apiErr)),
          dmResponse:   null,
          inputTokens:  null,
          outputTokens: null,
        }).catch(console.error);
        return;
      }

      const reply     = response.text;
      const inputTok  = response.inputTokens;
      const outputTok = response.outputTokens;
      const safeReply = await moderateAssistantReply(
        reply,
        'The Rules Arbiter declines. Repeating the request will not unlock a secret answer; it will only make the silence more judgmental. Ask a fantasy rules question instead.'
      );

      // Step 5: save DM2 response
      try {
        await db.saveMessage(sessionId, 'dm2', safeReply, null);
      } catch (dbErr) {
        console.error('rules_input: db.saveMessage(dm2) failed:', dbErr.message);
        // Non-fatal: response was received — still emit to client
      }

      socket.emit('dm2_typing', false);
      socket.emit('dm2_response', { message: safeReply });

      await db.logDmCall({
        sessionId,
        dm:           'dm2',
        model:        UTILITY_MODEL,
        playerInput:  message,
        fullPrompt:   DM2_PROMPT + '\n\n' + message + worldStateContext,
        dmResponse:   safeReply,
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
