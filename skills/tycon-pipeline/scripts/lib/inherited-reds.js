#!/usr/bin/env node
'use strict';
/**
 * inherited-reds.js — lo que la puerta encontró rojo y ya estaba rojo antes del cambio avisa, no frena.
 *
 * Dos jueces, en este orden:
 *
 * 1. LA FOTO NOCTURNA. La validación de cada pedido juzga contra la última foto nocturna (scripts/ci/pr-verdict.js): un
 *    rojo que ya estaba en la foto avisa, y sólo frena lo nuevo. La puerta pasa su resumen por ese mismo juez, con la
 *    foto que viaja en el árbol que mide (scripts/controls-bench/ultimo-suites.json): la regla es una sola. Se compara
 *    por suite, como el juez: un caso nuevo dentro de una suite que ya estaba roja pasa como heredado. La foto vale tal
 *    como llegó en el árbol (sin cambios sin commitear) y si es de esa mañana (36 horas).
 *
 * 2. LA BASE, EN EL MOMENTO. Lo que la foto no perdonó —o todo, si no hay foto o no sirve— se corre
 *    solo sobre la base, sin el cambio: la bifurcación de HEAD con `origin/main`, armada como un árbol aparte
 *    (`git worktree add --detach`) una vez por corrida y borrada al terminar. Cada suite corre con el mismo corredor de
 *    la puerta (run-suites-json.js --suite) dentro de scripts/ci/run-capped.js, que la corta entera al llegar al tope.
 *    El veredicto sale de la marca del tope y de la salida, nada más: la marca → «no medido: pasó el tope»; salida 0 →
 *    no heredada; salida 1 con la suite en las fallas del resumen de la base → heredada; cualquier otra cosa → «no
 *    medido». Nadie la declara a mano: lo decide la medición. Una sola corrida alcanza: una suite de azar que da rojo en
 *    la base queda heredada acá, y la validación del pedido la sigue juzgando contra la foto.
 *    No se mide (cada roja dice «no medido» y su motivo): sin `origin/main`; con el árbol igual a la base y sin cambios;
 *    en el árbol armado del privado (`--assembled`: mezcla dos repos); en una carpeta que no es git; la suite que no está
 *    en la base; una ausente (no existe en el cambio); las que pasan del tope de suites. En la base la suite corre sin
 *    TYCON_SKILLS_DIR: las skills son las de la base, no las del cambio. Si el árbol que se mide es una subcarpeta del
 *    repo, en la base se mide la misma subcarpeta. Límite conocido: el árbol de la base trae sólo lo commiteado (sin lo
 *    que git ignora, como `node_modules`); una suite que necesita eso da rojo en la base por el entorno y queda
 *    heredada. Las suites del arnés no lo necesitan.
 *    Topes: TYCON_INHERITED_BASE_MAX suites por corrida (3; 0 apaga esta parte y deja todo como antes) y
 *    TYCON_INHERITED_BASE_TIMEOUT_S segundos por suite (600).
 *
 * Lo heredado sale de `fallas` y de `ausentes` del resumen de run-suites-json.js y pasa a `inherited.suites`, cada una
 * con `measured_on` (`snapshot` o `base`). La cabecera `inherited` lleva la fecha de la foto (null sin foto que
 * perdonara) y, si alguna salió de la base, `base: {sha, at}`. Lo medido en la base queda en `base_check`, con el
 * veredicto y el motivo de cada suite. El informe y la lista de «repetir primero» ven sólo lo nuevo.
 *
 * Con suites sin medir en la corrida no se perdona nada: no decidir no es verde.
 *
 * CLI: node inherited-reds.js apply <árbol> <resumen suites.json> [--assembled]
 *   0 todo lo rojo ya estaba rojo · 1 queda algún rojo nuevo (o sin medir) · 2 no se pudo decidir · 10 no aplica (sin
 *   foto y con la medición en la base apagada)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SNAPSHOT = path.join('scripts', 'controls-bench', 'ultimo-suites.json');
const JUDGE = path.join('scripts', 'ci', 'pr-verdict.js');
// El nocturno corre de madrugada: 36 horas cubren el día entero de esa foto y no el siguiente.
const MAX_AGE_MS = 36 * 3600 * 1000;
const RUNNER = path.join(__dirname, 'run-suites-json.js');
// El corte por tope es el del repo de este guion: los árboles que se miden no siempre lo traen.
const RUN_CAPPED = path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'ci', 'run-capped.js');

const nombre = (ruta) => path.basename(String(ruta));
const rutaDe = (f) => (f && f.entrada && typeof f.entrada.ruta === 'string' ? f.entrada.ruta : null);

/** Un tope de la variable `clave`; uno que no es un entero ≥ 0 vale el de por defecto y se dice en `avisos`. */
function entero(clave, porDefecto, avisos) {
  const v = process.env[clave];
  if (v === undefined || v === '') return porDefecto;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 0) return n;
  avisos.push(`${clave}=${v} no es un entero ≥ 0: uso ${porDefecto}`);
  return porDefecto;
}

/** Lo que el juez imprime con `--json`: el objeto va primero, y después sus avisos. */
function salidaDelJuez(texto) {
  const fin = texto.indexOf('\n}\n');
  if (!texto.startsWith('{') || fin < 0) throw new Error('el juez no imprimió su resultado');
  return JSON.parse(texto.slice(0, fin + 2));
}

/** El juez de la foto: `{ ok: true, snap, viejos }` con los nombres que la foto ya traía rojos, o `{ ok: false, line }`. */
function porLaFoto(tree, rojos) {
  const judge = path.join(tree, JUDGE);
  const snapshot = path.join(tree, SNAPSHOT);
  const tocada = spawnSync('git', ['-C', tree, 'status', '--porcelain', '--', SNAPSHOT], { encoding: 'utf8' });
  if (tocada.status !== 0) return { ok: false, line: 'no pude ver si la foto nocturna tiene cambios en el árbol: no se perdona nada' };
  if (tocada.stdout.trim()) return { ok: false, line: 'la foto nocturna tiene cambios sin commitear en el árbol: no se perdona nada' };
  let snap;
  try { snap = JSON.parse(fs.readFileSync(snapshot, 'utf8')); } catch (e) {
    return { ok: false, line: `la foto nocturna no se deja leer (${e.message}): no se perdona nada` };
  }
  const edad = Date.now() - Date.parse(snap && snap.ts);
  if (!(edad <= MAX_AGE_MS)) {
    return { ok: false, line: `la foto nocturna es de ${(snap && snap.ts) || 'fecha ilegible'}, no de esta mañana: no se perdona nada` };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heredados-'));
  try {
    const actual = path.join(dir, 'suites.json');
    fs.writeFileSync(actual, JSON.stringify({ kind: 'bash-tests', ts: new Date().toISOString(), failures: rojos }));
    const r = spawnSync(process.execPath, [judge, '--tcg', tree, '--suites-actual', actual, '--suites-snapshot', snapshot, '--json'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0 && r.status !== 1) {
      const ultima = String(r.stdout || r.stderr || '').trim().split('\n').pop();
      return { ok: false, line: `el juez de los pedidos no pudo decidir (${ultima || `salió ${r.status}`}): no se perdona nada` };
    }
    const viejos = new Set(salidaDelJuez(r.stdout).viejos.map((t) => t.replace(/^suite /, '').replace(/ \(.*\)$/, '')));
    return { ok: true, snap, viejos };
  } catch (e) {
    return { ok: false, line: `no pude leer lo que decidió el juez de los pedidos (${e.message}): no se perdona nada` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Una sola línea de la salida de un comando, para el motivo. */
const ultimaLinea = (r) => String((r && (r.stderr || r.stdout)) || '').trim().split('\n').pop().slice(0, 200);

/**
 * Corre las fallas sobre la base. Devuelve `{ base, suites, heredadas }`: `suites` con el veredicto de cada una
 * (`heredada` · `no-heredada` · `no-medido`, con su motivo) y `heredadas` las fallas que dieron rojo también ahí.
 */
function medirEnLaBase(tree, fallas, ausentes, { max, timeout, assembled }) {
  const suites = [];
  const heredadas = [];
  const todas = (motivo) => {
    for (const f of fallas) suites.push({ ruta: rutaDe(f) || String(f && f.ruta), raiz: (f && f.entrada && f.entrada.raiz) || null, verdict: 'no-medido', motivo });
  };
  const fin = (base) => {
    for (const a of ausentes) suites.push({ ruta: String(a), raiz: null, verdict: 'no-medido', motivo: 'no medido: la suite no existe en el cambio' });
    return { base, suites, heredadas };
  };
  const g = (...a) => spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', tree, ...a], { encoding: 'utf8' });
  if (assembled) { todas('no medido: el árbol armado del privado mezcla dos repos'); return fin(null); }
  if (!fallas.length) return fin(null);
  if (g('rev-parse', '--is-inside-work-tree').status !== 0) { todas('no medido: el árbol no es un repo de git'); return fin(null); }
  if (g('rev-parse', '--verify', '--quiet', 'origin/main^{commit}').status !== 0) { todas('no medido: no hay origin/main contra qué medir'); return fin(null); }
  const mb = g('merge-base', 'HEAD', 'origin/main');
  const base = mb.status === 0 ? mb.stdout.trim() : '';
  if (!base) { todas(`no medido: no pude calcular la base (${ultimaLinea(mb) || `git salió ${mb.status}`})`); return fin(null); }
  const head = g('rev-parse', 'HEAD').stdout.trim();
  const sucio = g('status', '--porcelain');
  if (head === base && sucio.status === 0 && !sucio.stdout.trim()) { todas('no medido: el árbol es la base, sin cambios'); return fin(base); }

  const medibles = [];
  for (const f of fallas) {
    if (!rutaDe(f)) suites.push({ ruta: String(f && f.ruta), raiz: null, verdict: 'no-medido', motivo: 'no medido: la falla no trae su entrada de suites.json' });
    else if (medibles.length < max) medibles.push(f);
    else suites.push({ ruta: rutaDe(f), raiz: f.entrada.raiz || null, verdict: 'no-medido', motivo: `no medido: pasó del tope de ${max} suites` });
  }
  if (!medibles.length) return fin(base);
  if (!fs.existsSync(RUN_CAPPED)) {
    for (const f of medibles) suites.push({ ruta: rutaDe(f), raiz: f.entrada.raiz || null, verdict: 'no-medido', motivo: `no medido: falta ${RUN_CAPPED}` });
    return fin(base);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heredados-base-'));
  const arbolBase = path.join(dir, 'base');
  let armado = false;
  try {
    const wt = g('worktree', 'add', '--detach', '--quiet', arbolBase, base);
    if (wt.status !== 0) {
      for (const f of medibles) suites.push({ ruta: rutaDe(f), raiz: f.entrada.raiz || null, verdict: 'no-medido', motivo: `no medido: no se pudo armar la base (${ultimaLinea(wt)})` });
      return fin(base);
    }
    armado = true;
    // el árbol que se mide puede ser una subcarpeta del repo (el portón acotado a un proyecto): en la base, la misma
    const prefijo = g('rev-parse', '--show-prefix').stdout.trim();
    const raizBase = prefijo ? path.join(arbolBase, prefijo) : arbolBase;
    let enLaBase = null;
    let ilegible = '';
    try {
      const d = JSON.parse(fs.readFileSync(path.join(raizBase, 'scripts', 'tests', 'suites.json'), 'utf8'));
      enLaBase = [...(d.diarias || []), ...(d.semanales || [])];
    } catch (e) { ilegible = e.code === 'ENOENT' ? '' : e.message; enLaBase = e.code === 'ENOENT' ? [] : null; }
    if (!enLaBase) {
      for (const f of medibles) suites.push({ ruta: rutaDe(f), raiz: f.entrada.raiz || null, verdict: 'no-medido', motivo: `no medido: la lista de suites de la base no se deja leer (${ilegible})` });
      return fin(base);
    }
    // las skills de la base, no las del cambio: el corredor lee la variable antes que el clon
    const env = { ...process.env };
    delete env.TYCON_SKILLS_DIR;
    medibles.forEach((f, i) => {
      const ruta = rutaDe(f);
      const raiz = f.entrada.raiz || null;
      if (!enLaBase.some((s) => s && s.ruta === ruta && (s.raiz || null) === raiz)) {
        suites.push({ ruta, raiz, verdict: 'no-medido', motivo: 'no medido: la suite no está en la base' });
        return;
      }
      const out = path.join(dir, `resumen-${i}.json`);
      const marca = path.join(dir, `tope-${i}`);
      const r = spawnSync(process.execPath, [RUN_CAPPED, '--seconds', String(timeout), '--mark', marca, '--',
        process.execPath, RUNNER, raizBase, out, '--suite', ruta],
      { cwd: raizBase, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: (timeout + 60) * 1000 });
      if (fs.existsSync(marca)) { suites.push({ ruta, raiz, verdict: 'no-medido', motivo: `no medido: pasó el tope de ${timeout} s` }); return; }
      if (r.status === 0) { suites.push({ ruta, raiz, verdict: 'no-heredada', motivo: 'verde en la base: el rojo es del cambio' }); return; }
      let roja = false;
      if (r.status === 1) {
        try { roja = (JSON.parse(fs.readFileSync(out, 'utf8')).fallas || []).some((x) => rutaDe(x) === ruta); } catch (_) { roja = false; }
      }
      if (roja) {
        suites.push({ ruta, raiz, verdict: 'heredada', motivo: 'roja también en la base, sin el cambio' });
        heredadas.push(f);
      } else {
        const como = r.error ? r.error.message : (r.signal ? `cortada por ${r.signal}` : `salió ${r.status}`);
        suites.push({ ruta, raiz, verdict: 'no-medido', motivo: `no medido: en la base la suite ${como} sin dar un rojo legible` });
      }
    });
    return fin(base);
  } finally {
    if (armado) g('worktree', 'remove', '--force', arbolBase);
    fs.rmSync(dir, { recursive: true, force: true });
    g('worktree', 'prune');
  }
}

function apply(tree, summaryPath, { assembled = false } = {}) {
  const lines = [];
  const max = entero('TYCON_INHERITED_BASE_MAX', 3, lines);
  const timeout = entero('TYCON_INHERITED_BASE_TIMEOUT_S', 600, lines) || 600;
  const hayFoto = fs.existsSync(path.join(tree, JUDGE)) && fs.existsSync(path.join(tree, SNAPSHOT));
  if (!hayFoto && max === 0) {
    return { code: 10, lines: [...lines, 'sin foto nocturna o sin el juez de los pedidos en el árbol: lo rojo se juzga como siempre'] };
  }
  let summary;
  try { summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')); } catch (e) {
    return { code: 2, lines: [...lines, `el resumen de la corrida no se deja leer (${e.message}): no se perdona nada`] };
  }
  const unmeasured = Array.isArray(summary.unmeasured_suites) ? summary.unmeasured_suites : [];
  if (summary.no_medido || unmeasured.length) {
    return { code: 2, lines: [...lines, `la corrida tiene suites sin medir: no medido no es verde, no se perdona nada`] };
  }
  let fallas = Array.isArray(summary.fallas) ? summary.fallas : [];
  let ausentes = Array.isArray(summary.ausentes) ? summary.ausentes : [];
  const rojos = [...new Set([...fallas.map((f) => nombre(f && f.ruta)), ...ausentes.map(nombre)])];
  if (!rojos.length) return { code: 0, lines };

  const heredadas = [];
  let snap = null;
  if (hayFoto) {
    const foto = porLaFoto(tree, rojos);
    if (!foto.ok && max === 0) return { code: 2, lines: [...lines, foto.line] };
    if (!foto.ok) lines.push(`${foto.line}; lo rojo se mide en la base`);
    else {
      snap = foto.snap;
      const viejos = foto.viejos;
      heredadas.push(...fallas.filter((f) => viejos.has(nombre(f && f.ruta))).map((f) => ({ ...f, measured_on: 'snapshot' })));
      heredadas.push(...ausentes.filter((a) => viejos.has(nombre(a))).map((a) => ({ ruta: a, ausente: true, measured_on: 'snapshot' })));
      fallas = fallas.filter((f) => !viejos.has(nombre(f && f.ruta)));
      ausentes = ausentes.filter((a) => !viejos.has(nombre(a)));
      for (const h of heredadas) lines.push(`ya estaba rojo en el nocturno (${snap.ts || 'fecha ilegible'}): ${nombre(h.ruta)} — avisa, no frena`);
    }
  }
  let baseCheck = null;
  if (max > 0 && (fallas.length || ausentes.length)) {
    const m = medirEnLaBase(tree, fallas, ausentes, { max, timeout, assembled });
    const at = new Date().toISOString();
    baseCheck = { base: m.base, at, suites: m.suites };
    const vienen = new Set(m.heredadas);
    heredadas.push(...m.heredadas.map((f) => ({ ...f, measured_on: 'base' })));
    fallas = fallas.filter((f) => !vienen.has(f));
    for (const s of m.suites) {
      lines.push(s.verdict === 'heredada'
        ? `roja también en la base (${(m.base || '').slice(0, 10)}), sin el cambio: ${nombre(s.ruta)} — avisa, no frena`
        : `${nombre(s.ruta)}: ${s.motivo}`);
    }
    if (m.heredadas.length) baseCheck.inheritedBase = { sha: m.base, at };
  }
  if (heredadas.length || baseCheck) {
    summary.fallas = fallas;
    summary.ausentes = ausentes;
    if (heredadas.length) {
      summary.inherited = { snapshot_ts: snap ? snap.ts || null : null, snapshot_build: snap ? snap.build || null : null, suites: heredadas };
      if (baseCheck && baseCheck.inheritedBase) summary.inherited.base = baseCheck.inheritedBase;
    }
    if (baseCheck) {
      delete baseCheck.inheritedBase;
      summary.base_check = baseCheck;
    }
    const tmpOut = `${summaryPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpOut, `${JSON.stringify(summary, null, 2)}\n`);
    fs.renameSync(tmpOut, summaryPath);
  }
  return { code: fallas.length + ausentes.length ? 1 : 0, lines };
}

module.exports = { apply };

if (require.main === module) {
  const [cmd, tree, summaryPath, ...resto] = process.argv.slice(2);
  if (cmd !== 'apply' || !tree || !summaryPath || resto.some((a) => a !== '--assembled')) {
    process.stderr.write('uso: node inherited-reds.js apply <árbol> <resumen suites.json> [--assembled]\n');
    process.exitCode = 2;
  } else {
    const r = apply(tree, summaryPath, { assembled: resto.includes('--assembled') });
    for (const l of r.lines) process.stderr.write(`🟡 [test-gate] ${l}\n`);
    process.exitCode = r.code;
  }
}
