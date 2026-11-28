'use strict';
// deny-permissions.js — las reglas deny del arnés en `permissions.deny` de ~/.claude/settings.json.
//
// El freno de mano (scripts/hooks/safety-guard-pre.sh) es un gancho: si alguien apaga los ganchos, o el gancho no corre,
// no frena nada. Una regla deny de Claude Code frena igual, antes de lanzar el gancho, y ningún gancho puede dejarla
// pasar. Por eso va sólo lo que nunca necesita la salida de emergencia del freno (la firma de la persona en su terminal):
// borrar la raíz del disco y la carpeta personal entera. La lista, con el porqué de cada una y lo que queda afuera, es
// RULES, abajo (va en el módulo: la copia fija del programa trae sólo los .js de esta carpeta). El freno sigue como
// segunda red: frena lo mismo con el mismo id.
//
// Codex no lee `permissions.deny`: lee sus propias reglas, y build/deploy-codex-rules.js le escribe éstas mismas en
// `<CODEX_HOME>/rules/harness-deny.rules`. Cursor no tiene nada equivalente: ahí sigue sólo el freno.
//
// El mismo patrón que read-permissions.js (y usa sus funciones de lista): se suma sólo lo que falta, al final y sin
// reordenar; una regla igual que ya tenía el dev es suya (no se anota y al desinstalar queda); al desinstalar se saca
// sólo lo anotado. Cada regla es una pieza `setting` con id `permissions.deny:<regla>` y la regla en `value`.
// Se suma en el perfil completo; `TYCON_NO_DENY_RULES=1` la apaga.
//
// Lo usan: shared.js (sumar y anotar), managed.js (¿está en su lugar?), remove.js (desinstalar) y el plan de harness.js.
// Casos: scripts/tests/deny-permissions.test.js.

const RP = require('./read-permissions.js');

/** El comienzo del id de cada pieza: `permissions.deny:Bash(rm -rf /)`. */
const PREFIX = 'permissions.deny:';
/** El interruptor: `=1` no suma ni anota reglas deny. */
const OFF_ENV = 'TYCON_NO_DENY_RULES';
const LIST = 'deny';

const isRuleId = (id) => typeof id === 'string' && id.startsWith(PREFIX) && id.length > PREFIX.length;
const ruleOf = (id) => (isRuleId(id) ? id.slice(PREFIX.length) : null);
const pieceId = (rule) => `${PREFIX}${rule}`;

/**
 * Las reglas deny del arnés: sólo lo que nunca necesita la salida de emergencia del freno de mano. Cada regla es la forma
 * exacta, sin comodín: un * después de / frenaría también un borrado de /tmp/x. Quedan sólo en el freno, con su
 * emergencia, curl|bash (Claude Code parte el comando en el «|», y la regla tendría que frenar «bash» solo) y el borrado
 * de una base entera (SQL-C1: se autoriza para recrear una base de desarrollo, y va adentro de un cliente de SQL sin forma
 * fija).
 */
const RULES = {
  flags: ['-rf', '-fr', '-Rf', '-rF', '-fR', '-RF', '-FR', '-r -f', '-f -r', '-R -f', '-f -R'],
  reglas: [
    { id: 'FS-C2', que: 'borrar la raíz del disco', porque: 'ninguna tarea pide borrar el disco entero: no hay nada que la emergencia tenga que dejar pasar', destinos: ['/'] },
    { id: 'FS-C3', que: 'borrar la carpeta personal entera', porque: 'ninguna tarea pide borrar la carpeta personal entera; limpiar algo de adentro se nombra (~/.cache/x) y esto no lo frena', destinos: ['~', '~/', '$HOME', '$HOME/'] },
  ],
};

/** La lista declarada: `[{ id, que, porque, deny: [<regla>…] }]`, cada regla en la forma exacta de Claude Code. */
function catalog(j = RULES) {
  const flags = Array.isArray(j.flags) ? j.flags : [];
  return (Array.isArray(j.reglas) ? j.reglas : []).map((r) => ({
    id: r.id, que: r.que, porque: r.porque,
    deny: flags.flatMap((f) => (Array.isArray(r.destinos) ? r.destinos : []).map((d) => `Bash(rm ${f} ${d})`)),
  }));
}

/** Las reglas del arnés, sin repetir y en el orden de la lista. */
function ourRules(j) {
  const out = [];
  for (const r of catalog(j)) for (const d of r.deny) if (!out.includes(d)) out.push(d);
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

module.exports = { RULES, PREFIX, OFF_ENV, LIST, catalog, ourRules, apply, hasRule, removeRule, notes, isRuleId, ruleOf, pieceId };
