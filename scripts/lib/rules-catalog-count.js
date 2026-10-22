#!/usr/bin/env node
'use strict';
// rules-catalog-count.js — el conteo del catálogo real de reglas (el caso C5 de scripts/tests/rules-catalog.test.sh),
// en un solo lugar.
//
// Los números que se publican salen de acá, no de una lista tipeada en dos sitios. Lo usan dos: la prueba
// (C5, que imprime cada control) y el freno de antes del commit (scripts/ci/check-staged-ci-rules.js), que lo corre
// sobre el catálogo del índice cuando el commit toca agents/ o el catálogo. Lee con el único parser del catálogo
// (scripts/lib/rules-catalog.js).
//
// Los tres números exactos son los del NÚCLEO y se miden en los dos lados: en el repo del equipo se leen sin las
// secciones de los revisores que declara su paquete de clientes (packs/clients/pack.json), que el público no cuenta.
//
// USO
//   node scripts/lib/rules-catalog-count.js [--root <raíz>] [--catalog <ruta>]
//   → una línea «  ok   — …» o «  MAL  — …» por control. Exit: 0 = todo bien o saltado · 1 = algún MAL · 2 = no pude medir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { leer } = require('./rules-catalog.js');

const CATALOG = path.join('guides', 'advisor-rules-catalog.md');
const REVIEWERS = path.join('adapters', 'codex', 'agents');
const CLIENT_PACK = path.join('packs', 'clients', 'pack.json');

// Los números cambian cuando una regla se agrega, se retira o se une a otra: se actualizan acá junto con el catálogo.
const EXPECTED = {
  filas: 362,
  reglas: 361,
  identificadores: 359,
  i18n: 7,
  sinVerificacion: 8,
  retiradas: ['ACCOV-C9', 'REAL-C5', 'REAL-W5', 'SPEC-W8'],
};
const WHERE = 'scripts/lib/rules-catalog-count.js (EXPECTED)';

/** Los revisores del paquete de clientes, o [] si el repo no lo trae. Lanza si existe y no se puede leer. */
function clientReviewers(root) {
  const f = path.join(root, CLIENT_PACK);
  if (!fs.existsSync(f)) return [];
  const pack = JSON.parse(fs.readFileSync(f, 'utf8'));
  return [...new Set((pack.reviewers || []).map((r) => r.agent))].sort();
}

/** El catálogo del núcleo: el real sin las secciones (de un «## … — `dueño`» al siguiente «## ») de esos revisores. */
function coreCatalog(text, outside) {
  const out = [];
  let skip = false;
  for (const l of text.split('\n')) {
    if (l.startsWith('## ')) {
      const m = /`([^`]+)`\s*$/.exec(l);
      skip = Boolean(m && outside.includes(m[1]));
    }
    if (!skip) out.push(l);
  }
  return out.join('\n');
}

/**
 * Los controles del conteo, sobre `catalogPath` (por omisión, el del repo) y el padrón de revisores del repo.
 * → { skipped: motivo | null, error: motivo | null, notes: [texto], checks: [{ ok, msg }] }
 */
function check({ root, catalogPath } = {}) {
  const res = { skipped: null, error: null, notes: [], checks: [] };
  const cat = catalogPath || path.join(root, CATALOG);
  const rev = path.join(root, REVIEWERS);
  if (!fs.existsSync(cat) || !fs.existsSync(rev)) {
    res.skipped = 'no están el catálogo real o el padrón de revisores (constancia, no verde)';
    return res;
  }
  let outside;
  try { outside = clientReviewers(root); } catch (e) {
    res.error = `no pude leer el manifiesto del paquete de clientes (${e.message}) — sin él, los números del núcleo no se pueden separar`;
    return res;
  }
  const add = (ok, okMsg, badMsg) => res.checks.push({ ok, msg: ok ? okMsg : badMsg });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-catalog-count-'));
  try {
    const coreFile = path.join(tmp, 'catalogo-nucleo.md');
    fs.writeFileSync(coreFile, coreCatalog(fs.readFileSync(cat, 'utf8'), outside));
    if (outside.length) res.notes.push(`sin las secciones del paquete de clientes: ${outside.join(' ')}`);
    const core = leer({ catalogo: coreFile, revisores: rev });
    if (core.estado === 'no_medido') { res.error = `el lector no pudo medir el catálogo del núcleo: ${core.motivo}`; return res; }
    const E = EXPECTED;
    add(core.filas === E.filas, `${E.filas} filas en el catálogo del núcleo`,
      `filas=${core.filas}, esperaba ${E.filas} — si el catálogo creció, actualizá el número en ${WHERE} Y el de la story en el mismo commit; en el repo del equipo, mirá también que su copia del catálogo no haya quedado atrás de la del público`);
    add(core.reglas === E.reglas, `${E.reglas} reglas = pares (dueño, regla), que es la unidad de la tabla`,
      `reglas=${core.reglas}, esperaba ${E.reglas} — si el catálogo creció, actualizá ${WHERE}; rojo previo (números de 2026-09-16): contar identificadores fusiona SEC-C1/SEC-C2; contar filas duplica PIPE-C5`);
    add(core.identificadores === E.identificadores, `${E.identificadores} identificadores distintos (con ACCOV-C1-EXT)`,
      `identificadores=${core.identificadores}, esperaba ${E.identificadores} — si el catálogo creció, actualizá ${WHERE}; rojo previo: con el regex viejo daba 7 menos (las 7 de I18N invisibles)`);

    // el resto se mide sobre el catálogo real entero
    const all = leer({ catalogo: cat, revisores: rev });
    if (all.estado === 'no_medido') { res.error = `el lector no pudo medir el catálogo real: ${all.motivo}`; return res; }
    const i18n = all.lista.filter((r) => r.regla.startsWith('I18N-')).length;
    add(i18n === E.i18n, `las ${E.i18n} reglas del área con dígito están`,
      `I18N tiene ${i18n} reglas, esperaba ${E.i18n} — rojo previo: el defecto que la story 2.9 existe para cerrar`);
    const svr = all.lista.filter((r) => r.sin_verificacion).length;
    add(svr === E.sinVerificacion, `${E.sinVerificacion} reglas del banco llevan «sin verificación», como dice el catálogo`,
      `sin_verificacion=${svr}, esperaba ${E.sinVerificacion} — la prosa del catálogo dice que sólo BANCO-W3 la verifica un guion`);
    const reused = all.reutilizadas || [];
    add(reused.length === 0, 'ningún identificador reutilizado en el catálogo real (SEC-W4 es viva; su «retirada» era un ejemplo)',
      `reutilizadas=${JSON.stringify(reused)}, esperaba [] — rojo previo: el ejemplo de la guía se leía como retirada`);
    const retired = (all.retiradas || []).map((r) => r.regla);
    add(JSON.stringify(retired) === JSON.stringify(E.retiradas), 'retirados: ACCOV-C9 (story 7.2), los dos reservados de la prosa y SPEC-W8',
      `retiradas=${JSON.stringify(retired)}, esperaba ${JSON.stringify(E.retiradas)}`);
    const noReviewer = all.lista.filter((r) => !r.esRevisor).length;
    add(noReviewer > 0, `hay ${noReviewer} regla(s) sin revisor, y se dicen`,
      '0 reglas sin revisor — rojo previo: el catálogo tiene dueños que no son revisores (freno de mano, pipeline, banco); darlos por cubiertos es verde falso');
    return res;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
  const root = path.resolve(arg('--root') || path.join(__dirname, '..', '..'));
  const r = check({ root, catalogPath: arg('--catalog') });
  if (r.skipped) { console.log(`  ok   — C5 · saltado: ${r.skipped}`); process.exit(0); }
  if (r.error) { console.log(`  MAL  — C5 · ${r.error}`); process.exit(2); }
  for (const n of r.notes) console.log(`  ·    — C5 · ${n}`);
  for (const c of r.checks) console.log(`  ${c.ok ? 'ok  ' : 'MAL '} — C5 · ${c.msg}`);
  process.exit(r.checks.every((c) => c.ok) ? 0 : 1);
}

module.exports = { EXPECTED, CATALOG, coreCatalog, clientReviewers, check };
