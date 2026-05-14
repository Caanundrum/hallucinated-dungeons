// Shared AI provider adapter.
// Keep provider-specific code here so the game logic can stay model-agnostic.

const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

module.exports = { generateText };
