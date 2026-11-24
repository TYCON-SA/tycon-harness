#!/usr/bin/env node
'use strict';
/**
 * test-gate-scope.js — si el portón de pruebas corre en la máquina sólo lo que el cambio toca, según el propio repo.
 *
 * Un repo cuya suite entera corre en una CI antes del merge (el control obligatorio de la cola) lo declara en
 * `.test-gate.yaml`, en su raíz (fuera de `.tycon/`, que en el arnés no se publica):
 *
 *   test_gate:
 *     scope: touched
 *     full_suite_by: "la CI de GitHub del pedido (control obligatorio de la cola de merge)"
 *
 * Con eso test-gate.sh corre en la máquina sólo las suites que leen lo tocado (run-suites-json.js --scoped-by-repo) y
 * el cierre dice quién corre la completa. `max_local_suites: <n>` (opcional) cambia el tope de suites que corren en la
 * máquina: pasado el tope corren las más cercanas al cambio y las demás quedan para esa CI. Sin la clave, o con la clave mal escrita, corre todo como siempre: un valor
 * que no se entiende no acota. `full_suite_by` es obligatorio: acotar sin decir quién corre la completa no vale.
 *
 * Un repo cuya suite no debe correr en la máquina (le pega a la base de otra persona, a un servicio compartido) lo
 * declara con `scope: none`, quién la corre (`full_suite_by`) y por qué (`reason`): test-gate.sh no corre nada en ese
 * repo y sale 3, «sin medir», con el motivo. Sin alguno de los dos, corre todo.
 *
 * Esta clave AFLOJA el portón, así que se lee de lo COMMITEADO (config-source.js, `archivoParaFreno`): escribirla en la
 * carpeta sin commitearla no cambia nada, y el cambio se ve en el diff del pedido.
 *
 * Uso: node test-gate-scope.js <repo> → imprime `full_suite_by` y sale 0 si acota; con `none` imprime `full_suite_by` y
 * el motivo separados por \x1f y sale 11; sale 10 si corre todo (el motivo de una clave mal escrita va a stderr).
 */
const SCOPES = ['touched', 'full', 'none'];
const FILE = '.test-gate.yaml';

/** `{ scope: 'touched', fullSuiteBy }` o `{ scope: 'full', problem? }` a partir del texto del yaml. */
function parseScope(txt) {
  if (!txt) return { scope: 'full' };
  const lines = String(txt).split(/\r?\n/);
  const start = lines.findIndex((l) => /^test_gate:\s*(#.*)?$/.test(l));
  if (start < 0) {
    if (lines.some((l) => /^test_gate:/.test(l))) return { scope: 'full', problem: 'test_gate tiene que ser un bloque con scope y full_suite_by' };
    return { scope: 'full' };
  }
  const clean = (s) => s.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  const block = {};
  for (const l of lines.slice(start + 1)) {
    if (!l.trim() || /^\s*#/.test(l)) continue;
    if (!/^\s/.test(l)) break;
    const m = l.match(/^\s+([a-z_]+):\s*(.*)$/);
    if (m) block[m[1]] = clean(m[2]);
  }
  if (!SCOPES.includes(block.scope)) return { scope: 'full', problem: `test_gate.scope tiene que ser ${SCOPES.join(' o ')}, no ${JSON.stringify(block.scope || '')}` };
  if (block.scope === 'full') return { scope: 'full' };
  if (block.scope === 'none') {
    if (!block.full_suite_by) return { scope: 'full', problem: 'test_gate.scope: none pide full_suite_by (quién corre la suite, que en la máquina no corre)' };
    if (!block.reason) return { scope: 'full', problem: 'test_gate.scope: none pide reason (por qué la suite no corre en la máquina)' };
    return { scope: 'none', fullSuiteBy: block.full_suite_by, reason: block.reason };
  }
  if (!block.full_suite_by) return { scope: 'full', problem: 'test_gate.scope: touched pide full_suite_by (quién corre la suite completa antes del merge)' };
  // el tope de suites de la máquina (opcional): un entero mayor que cero; mal escrito, rige el de fábrica y se dice
  const max = block.max_local_suites;
  if (max === undefined || max === '') return { scope: 'touched', fullSuiteBy: block.full_suite_by };
  if (!/^[1-9]\d{0,3}$/.test(max)) return { scope: 'touched', fullSuiteBy: block.full_suite_by, problem: `test_gate.max_local_suites tiene que ser un entero de 1 a 9999, no ${JSON.stringify(max)}: rige el tope de fábrica` };
  return { scope: 'touched', fullSuiteBy: block.full_suite_by, maxLocalSuites: Number(max) };
}

/** La decisión para un repo, leída de lo commiteado. */
function scopeOf(repoRoot) {
  let txt = null;
  try { txt = require('./config-source.js').archivoParaFreno(repoRoot, FILE); } catch (e) { return { scope: 'full', problem: `no pude leer ${FILE} (${e.message})` }; }
  return parseScope(txt);
}

module.exports = { parseScope, scopeOf, FILE };

if (require.main === module) {
  const repo = process.argv[2];
  if (!repo) { console.error('uso: test-gate-scope.js <repo>'); process.exit(2); }
  const r = scopeOf(repo);
  if (r.problem) console.error(`[test-gate] ⚠️  ${r.problem}${r.scope === 'touched' ? '' : ': corre la suite entera'}`);
  if (r.scope === 'none') { process.stdout.write(`${r.fullSuiteBy}\x1f${r.reason}`); process.exit(11); }
  if (r.scope !== 'touched') process.exit(10);
  process.stdout.write(r.fullSuiteBy);
}
