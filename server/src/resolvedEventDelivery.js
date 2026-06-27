function normalizeGeneration(value) {
  if (typeof value === 'string') {
    return { text: value, inputTokens: null, outputTokens: null };
  }
  return {
    text: String(value?.text || ''),
    inputTokens: value?.inputTokens ?? null,
    outputTokens: value?.outputTokens ?? null,
  };
}

function normalizeComparableText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[*_`#>[\](){}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUsableNarration(text, fallbackReply = '') {
  const narration = normalizeComparableText(text);
  if (!narration) return false;
  const fallback = normalizeComparableText(fallbackReply);
  return !fallback || narration !== fallback;
}

async function completeResolvedEventDelivery({
  primaryGenerate,
  recoveryGenerate,
  moderate,
  fallbackReply,
  persist,
  emit,
} = {}) {
  const fallback = String(fallbackReply || '').trim()
    || 'The rules resolve the action, but its narration is temporarily unavailable.';
  const errors = [];
  let generation = null;
  let source = 'primary';

  try {
    generation = normalizeGeneration(await primaryGenerate());
    if (!isUsableNarration(generation.text, fallback)) {
      throw new Error(generation.text.trim() ? 'Primary narration echoed the deterministic fallback.' : 'Primary narration was empty.');
    }
  } catch (error) {
    errors.push(`primary: ${error.message || String(error)}`);
    generation = null;
  }

  if (!generation && recoveryGenerate) {
    source = 'recovery';
    try {
      generation = normalizeGeneration(await recoveryGenerate());
      if (!isUsableNarration(generation.text, fallback)) {
        throw new Error(generation.text.trim() ? 'Recovery narration echoed the deterministic fallback.' : 'Recovery narration was empty.');
      }
    } catch (error) {
      errors.push(`recovery: ${error.message || String(error)}`);
      generation = null;
    }
  }

  let reply = generation?.text?.trim() || fallback;
  if (!generation) source = 'deterministic_fallback';

  if (generation && moderate) {
    try {
      const moderated = String(await moderate(reply, fallback) || '').trim();
      if (!isUsableNarration(moderated, fallback)) {
        source = 'moderation_fallback';
        reply = fallback;
      } else {
        reply = moderated;
      }
    } catch (error) {
      errors.push(`moderation: ${error.message || String(error)}`);
      source = 'moderation_fallback';
      reply = fallback;
    }
  }

  if (!reply.trim()) {
    source = 'deterministic_fallback';
    reply = fallback;
  }

  const metadata = {
    source,
    errors,
    inputTokens: generation?.inputTokens ?? null,
    outputTokens: generation?.outputTokens ?? null,
  };
  const persistenceResult = await persist(reply, metadata);
  await emit(reply, metadata);

  return { reply, ...metadata, persistenceResult };
}

module.exports = {
  completeResolvedEventDelivery,
  isUsableNarration,
};
