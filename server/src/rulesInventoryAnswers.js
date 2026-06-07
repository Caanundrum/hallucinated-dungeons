const COUNT_QUESTION = /\b(?:how many|count|left|remaining|do i have|have left)\b/i;

function answerInventoryCountQuestion(message = '', worldState = {}) {
  const text = String(message || '');
  if (!COUNT_QUESTION.test(text)) return '';

  const carried = Array.isArray(worldState.inventory_state?.carried_objects)
    ? worldState.inventory_state.carried_objects
    : [];
  if (!carried.length) return '';

  const target = findMentionedInventoryItem(text, carried);
  if (!target) return '';

  const quantity = Number(target.quantity ?? 1);
  const consumed = Number(target.consumed_quantity || 0);
  const container = target.source_container ? ` in your ${target.source_container}` : '';
  const unitName = quantity === 1 ? singularizeDisplayName(target.name) : target.name;
  const spentText = consumed > 0 ? ` You have used ${consumed} from that stack.` : '';

  return `You have **${quantity} ${unitName}** remaining${container}.${spentText}`;
}

function findMentionedInventoryItem(message = '', carried = []) {
  const normalizedMessage = normalizeName(message);
  const candidates = carried
    .filter((item) => item?.name && Number(item.quantity ?? 1) >= 0)
    .map((item) => ({
      item,
      score: matchScore(normalizedMessage, item.name),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.item || null;
}

function matchScore(normalizedMessage = '', itemName = '') {
  const normalizedItem = normalizeName(itemName);
  if (!normalizedMessage || !normalizedItem) return 0;
  if (hasWholePhrase(normalizedMessage, normalizedItem)) return 100;
  const singularItem = singularize(normalizedItem);
  if (hasWholePhrase(normalizedMessage, singularItem)) return 90;

  const itemTokens = normalizedItem.split(' ').filter(isUsefulToken);
  const messageTokens = new Set(normalizedMessage.split(' ').filter(isUsefulToken).map(singularize));
  const hits = itemTokens.filter((token) => messageTokens.has(singularize(token)));
  return hits.length ? hits.length * 10 : 0;
}

function formatCarriedInventoryForRules(carriedObjects = []) {
  if (!Array.isArray(carriedObjects) || carriedObjects.length === 0) return '';
  return carriedObjects
    .filter((item) => item?.name)
    .map((item) => {
      const quantity = Number(item.quantity ?? 1);
      const quantityText = ` x${quantity}`;
      const consumed = Number(item.consumed_quantity || 0);
      const consumedText = consumed > 0 ? `, ${consumed} used` : '';
      const container = item.source_container ? ` in ${item.source_container}` : '';
      const depleted = quantity <= 0 ? ', depleted' : '';
      return `${item.name}${quantityText}${container}${consumedText}${depleted}`;
    })
    .join(', ');
}

function normalizeName(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function singularize(value = '') {
  return String(value || '').replace(/\b([a-z]{3,})s\b/g, '$1');
}

function singularizeDisplayName(value = '') {
  return String(value || '').replace(/\b([A-Za-z]{3,})s\b/g, '$1');
}

function hasWholePhrase(normalizedMessage = '', normalizedPhrase = '') {
  if (!normalizedMessage || !normalizedPhrase) return false;
  return new RegExp(`(?:^| )${escapeRegExp(normalizedPhrase)}(?: |$)`).test(normalizedMessage);
}

function isUsefulToken(token = '') {
  return token.length >= 4 && !['from', 'with', 'left', 'have', 'many', 'after', 'that', 'this', 'your'].includes(token);
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  answerInventoryCountQuestion,
  formatCarriedInventoryForRules,
};
