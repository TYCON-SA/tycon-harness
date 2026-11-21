'use strict';
// deny-permissions.js — las reglas deny del arnés en `permissions.deny` de ~/.claude/settings.json.
//
// El freno de mano (scripts/hooks/safety-guard-pre.sh) es un gancho: si alguien apaga los ganchos, o el gancho no corre,
// no frena nada. Una regla deny de Claude Code frena igual, antes de lanzar el gancho, y ningún gancho puede dejarla
// pasar. Por eso va sólo lo que nunca necesita la salida de emergencia del freno (la firma de la persona en su terminal):
// borrar la raíz del disco y la carpeta personal entera. La lista, con el porqué de cada una y lo que queda afuera, es
// deny-rules.json, al lado de este archivo. El freno sigue como segunda red: frena lo mismo con el mismo id.
//
// Codex no lee `permissions.deny`: ahí sigue el freno de hoy, que corre igual. Cursor, también.
//
// El mismo patrón que read-permissions.js (y usa sus funciones de lista): se suma sólo lo que falta, al final y sin
// reordenar; una regla igual que ya tenía el dev es suya (no se anota y al desinstalar queda); al desinstalar se saca
// sólo lo anotado. Cada regla es una pieza `setting` con id `permissions.deny:<regla>` y la regla en `value`.
// Se suma en el perfil completo; `TYCON_NO_DENY_RULES=1` la apaga.
//
// Lo usan: shared.js (sumar y anotar), managed.js (¿está en su lugar?), remove.js (desinstalar) y el plan de harness.js.
// Casos: scripts/tests/deny-permissions.test.js.

const path = require('path');
const RP = require('./read-permissions.js');

/** El comienzo del id de cada pieza: `permissions.deny:Bash(rm -rf /)`. */
const PREFIX = 'permissions.deny:';
/** El interruptor: `=1` no suma ni anota reglas deny. */
const OFF_ENV = 'TYCON_NO_DENY_RULES';
const LIST = 'deny';

const isRuleId = (id) => typeof id === 'string' && id.startsWith(PREFIX) && id.length > PREFIX.length;
const ruleOf = (id) => (isRuleId(id) ? id.slice(PREFIX.length) : null);
const pieceId = (rule) => `${PREFIX}${rule}`;

/** La lista declarada: `[{ id, que, porque, deny: [<regla>…] }]`, cada regla en la forma exacta de Claude Code. */
function catalog(file = path.join(__dirname, 'deny-rules.json')) {
  const j = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  const flags = Array.isArray(j.flags) ? j.flags : [];
  return (Array.isArray(j.reglas) ? j.reglas : []).map((r) => ({
    id: r.id, que: r.que, porque: r.porque,
    deny: flags.flatMap((f) => (Array.isArray(r.destinos) ? r.destinos : []).map((d) => `Bash(rm ${f} ${d})`)),
  }));
}

/** Las reglas del arnés, sin repetir y en el orden de la lista. */
function ourRules(file) {
  const out = [];
  for (const r of catalog(file)) for (const d of r.deny) if (!out.includes(d)) out.push(d);
  return out;
}

const apply = (settings, rules, { previous = [] } = {}) => RP.apply(settings, rules, { previous, list: LIST, ruleOfPiece: ruleOf });
const hasRule = (settings, rule) => RP.hasRule(settings, rule, LIST);
const removeRule = (settings, rule) => RP.removeRule(settings, rule, LIST);

/** La nota en llano de lo que se sumó y se sacó (vacía si nada). */
function notes({ added, dropped }, file) {
  const out = [];
  if (added.length) out.push(`sumé a ${file} ${added.length} regla(s) que niegan borrar la raíz del disco o la carpeta personal entera (permissions.deny)`);
  if (dropped.length) out.push(`saqué de ${file} ${dropped.length} regla(s) deny que ya no son del arnés: ${dropped.join(', ')}`);
  return out;
}

module.exports = { PREFIX, OFF_ENV, LIST, catalog, ourRules, apply, hasRule, removeRule, notes, isRuleId, ruleOf, pieceId };
