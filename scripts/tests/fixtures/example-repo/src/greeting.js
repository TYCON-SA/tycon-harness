'use strict';

/**
 * El saludo del repo de ejemplo.
 *
 * @param {string} [name] a quién se saluda; vacío, sólo espacios o ausente = «world»
 * @returns {string} `Hello, <name>!`
 */
function greet(name) {
  const who = typeof name === 'string' ? name.trim() : '';
  return `Hello, ${who || 'world'}!`;
}

module.exports = { greet };
