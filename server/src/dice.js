const crypto = require('crypto');

function rollDie(sides = 20) {
  const dieSides = Math.max(1, Math.floor(Number(sides) || 20));
  return crypto.randomInt(1, dieSides + 1);
}

module.exports = {
  rollDie,
};
