#!/usr/bin/env node
'use strict';
/**
 * inherited-reds.js — lo que la puerta encontró rojo y ya estaba rojo en el nocturno de esa mañana avisa, no frena.
 *
 * La validación de cada pedido juzga contra la última foto nocturna (scripts/ci/pr-verdict.js): un rojo que ya estaba
 * en la foto avisa, y sólo frena lo nuevo. La puerta de la máquina juzgaba contra cero, y cada rojo heredado de main se
 * pagaba repitiendo la suite, el portón entero o con una firma. Acá la puerta pasa su resumen por ese mismo juez, con la
 * foto que viaja en el árbol que mide (scripts/controls-bench/ultimo-suites.json): la regla es una sola. Se compara por
 * suite, como el juez: un caso nuevo dentro de una suite que ya estaba roja pasa como heredado.
 *
 * Lo heredado sale de `fallas` y de `ausentes` del resumen de run-suites-json.js y pasa a `inherited`, con la fecha de
 * la foto: el informe y la lista de «repetir primero» ven sólo lo nuevo, y lo heredado queda escrito.
 *
 * Sin foto o sin juez en el árbol (el repo público solo), no aplica y la puerta juzga como siempre. Si el juez no puede
 * decidir (foto ilegible, suites sin medir), el resumen no se toca: no decidir no es verde. Tampoco se perdona con una
 * foto con cambios sin commitear en el árbol, ni con una de más de 36 horas.
 *
 * CLI: node inherited-reds.js apply <árbol> <resumen suites.json>
 *   0 todo lo rojo ya estaba en la foto · 1 queda algún rojo nuevo · 2 el juez no pudo decidir · 10 no aplica
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SNAPSHOT = path.join('scripts', 'controls-bench', 'ultimo-suites.json');
const JUDGE = path.join('scripts', 'ci', 'pr-verdict.js');
// El nocturno corre de madrugada: 36 horas cubren el día entero de esa foto y no el siguiente.
const MAX_AGE_MS = 36 * 3600 * 1000;

const nombre = (ruta) => path.basename(String(ruta));

/** Lo que el juez imprime con `--json`: el objeto va primero, y después sus avisos. */
function salidaDelJuez(texto) {
  const fin = texto.indexOf('\n}\n');
  if (!texto.startsWith('{') || fin < 0) throw new Error('el juez no imprimió su resultado');
  return JSON.parse(texto.slice(0, fin + 2));
}

function apply(tree, summaryPath) {
  const judge = path.join(tree, JUDGE);
  const snapshot = path.join(tree, SNAPSHOT);
  if (!fs.existsSync(judge) || !fs.existsSync(snapshot)) {
    return { code: 10, lines: ['sin foto nocturna o sin el juez de los pedidos en el árbol: lo rojo se juzga como siempre'] };
  }
  let summary;
  try { summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')); } catch (e) {
    return { code: 2, lines: [`el resumen de la corrida no se deja leer (${e.message}): no se perdona nada`] };
  }
  // La foto vale tal como llegó en el árbol y si es de esa mañana: una editada a mano, o de hace días, perdonaría lo que
  // el nocturno no vio.
  const tocada = spawnSync('git', ['-C', tree, 'status', '--porcelain', '--', SNAPSHOT], { encoding: 'utf8' });
  if (tocada.status !== 0) {
    return { code: 2, lines: ['no pude ver si la foto nocturna tiene cambios en el árbol: no se perdona nada'] };
  }
  if (tocada.stdout.trim()) {
    return { code: 2, lines: ['la foto nocturna tiene cambios sin commitear en el árbol: no se perdona nada'] };
  }
  let snap;
  try { snap = JSON.parse(fs.readFileSync(snapshot, 'utf8')); } catch (e) {
    return { code: 2, lines: [`la foto nocturna no se deja leer (${e.message}): no se perdona nada`] };
  }
  const edad = Date.now() - Date.parse(snap && snap.ts);
  if (!(edad <= MAX_AGE_MS)) {
    return { code: 2, lines: [`la foto nocturna es de ${(snap && snap.ts) || 'fecha ilegible'}, no de esta mañana: no se perdona nada`] };
  }
  const unmeasured = Array.isArray(summary.unmeasured_suites) ? summary.unmeasured_suites : [];
  if (summary.no_medido || unmeasured.length) {
    return { code: 2, lines: [`la corrida tiene suites sin medir: no medido no es verde, no se perdona nada`] };
  }
  const fallas = Array.isArray(summary.fallas) ? summary.fallas : [];
  const ausentes = Array.isArray(summary.ausentes) ? summary.ausentes : [];
  const rojos = [...new Set([...fallas.map((f) => nombre(f && f.ruta)), ...ausentes.map(nombre)])];
  if (!rojos.length) return { code: 0, lines: [] };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heredados-'));
  try {
    const actual = path.join(dir, 'suites.json');
    fs.writeFileSync(actual, JSON.stringify({ kind: 'bash-tests', ts: new Date().toISOString(), failures: rojos }));
    const r = spawnSync(process.execPath, [judge, '--tcg', tree, '--suites-actual', actual, '--suites-snapshot', snapshot, '--json'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0 && r.status !== 1) {
      const ultima = String(r.stdout || r.stderr || '').trim().split('\n').pop();
      return { code: 2, lines: [`el juez de los pedidos no pudo decidir (${ultima || `salió ${r.status}`}): no se perdona nada`] };
    }
    const viejos = new Set(salidaDelJuez(r.stdout).viejos.map((t) => t.replace(/^suite /, '').replace(/ \(.*\)$/, '')));
    const heredadas = [
      ...fallas.filter((f) => viejos.has(nombre(f && f.ruta))),
      ...ausentes.filter((a) => viejos.has(nombre(a))).map((a) => ({ ruta: a, ausente: true })),
    ];
    if (heredadas.length) {
      summary.fallas = fallas.filter((f) => !viejos.has(nombre(f && f.ruta)));
      summary.ausentes = ausentes.filter((a) => !viejos.has(nombre(a)));
      summary.inherited = { snapshot_ts: snap.ts || null, snapshot_build: snap.build || null, suites: heredadas };
      const tmpOut = `${summaryPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpOut, `${JSON.stringify(summary, null, 2)}\n`);
      fs.renameSync(tmpOut, summaryPath);
    }
    const quedan = summary.fallas.length + summary.ausentes.length;
    const lines = heredadas.map((h) => `ya estaba rojo en el nocturno (${snap.ts || 'fecha ilegible'}): ${nombre(h.ruta)} — avisa, no frena`);
    return { code: quedan ? 1 : 0, lines };
  } catch (e) {
    return { code: 2, lines: [`no pude leer lo que decidió el juez de los pedidos (${e.message}): no se perdona nada`] };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { apply };

if (require.main === module) {
  const [cmd, tree, summaryPath] = process.argv.slice(2);
  if (cmd !== 'apply' || !tree || !summaryPath) {
    process.stderr.write('uso: node inherited-reds.js apply <árbol> <resumen suites.json>\n');
    process.exitCode = 2;
  } else {
    const r = apply(tree, summaryPath);
    for (const l of r.lines) process.stderr.write(`🟡 [test-gate] ${l}\n`);
    process.exitCode = r.code;
  }
}
