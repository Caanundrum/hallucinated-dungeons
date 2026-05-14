// Shared AI provider adapter.
// Keep provider-specific code here so the game logic can stay model-agnostic.

const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODERATION_MODEL = process.env.MODERATION_MODEL || 'omni-moderation-latest';
const MODERATION_ENABLED = process.env.MODERATION_ENABLED !== 'false';

const BLOCKED_MODERATION_CATEGORIES = new Set([
  'harassment/threatening',
  'hate',
  'hate/threatening',
  'self-harm/intent',
  'self-harm/instructions',
  'sexual',
  'sexual/minors',
  'violence/graphic',
]);

const PUBLIC_SAFETY_MESSAGE = [
  'The Dungeon Master lowers the screen and stares at you over it.',
  'That idea has been denied entry to the campaign, the tavern, and polite society. Try something else.',
].join(' ');

function toResponseInput(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function getText(response) {
  if (response.output_text) return response.output_text;

  const parts = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) {
        parts.push(content.text);
      }
    }
  }
  return parts.join('\n').trim();
}

async function generateText({ model, system, messages, maxTokens }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const response = await openai.responses.create({
    model,
    instructions: system,
    input: toResponseInput(messages),
    max_output_tokens: maxTokens,
  });

  return {
    text: getText(response),
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens,
  };
}

async function moderateText(text) {
  if (!MODERATION_ENABLED || !text || !text.trim()) {
    return { ok: true, flaggedCategories: [] };
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const response = await openai.moderations.create({
    model: MODERATION_MODEL,
    input: text,
  });

  const result = response.results?.[0];
  const categories = result?.categories || {};
  const flaggedCategories = Object.entries(categories)
    .filter(([category, flagged]) => flagged && BLOCKED_MODERATION_CATEGORIES.has(category))
    .map(([category]) => category);

  return {
    ok: flaggedCategories.length === 0,
    flaggedCategories,
    publicMessage: PUBLIC_SAFETY_MESSAGE,
  };
}

module.exports = { generateText, moderateText };
