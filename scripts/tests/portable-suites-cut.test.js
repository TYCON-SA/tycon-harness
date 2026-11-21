#!/usr/bin/env node
/**
 * portable-suites-cut.test.js — cortar el corredor de las portables corta también sus suites.
 *
 * Lo que no se puede perder: si alguien corta la corrida (un vigilante de memoria que mata al bash, un Ctrl-C, un
 * kill al proceso que reparte), no queda vivo ni el que reparte ni ninguna suite con sus hijos. Cada suite corre en su
 * propio grupo de procesos, así que nadie más la alcanza: si el corredor no la corta, sigue reteniendo memoria y el
 * que reparte sigue lanzando las siguientes.
 *
 * 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la mutación que lo pone en rojo.
 *
 * stable-data: los casos esperan con el reloj porque miden procesos vivos; no leen fechas.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PORTABLES = path.join(ROOT, 'scripts', 'tests', 'portable-suites.test.sh');
const SIN_GRUPOS = process.platform === 'win32' && 'en Windows no hay grupos de procesos: lo cubren las señales';

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const leerPid = (f) => { try { return Number(fs.readFileSync(f, 'utf8').trim()) || null; } catch { return null; } };

async function esperar(cond, ms) {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

/** Una raíz de juguete con la copia del corredor y una portable que anota sus pids y duerme. */
function juguete() {
  const root = tmp('portable-suites-cut-');
  fs.mkdirSync(path.join(root, 'scripts', 'tests'), { recursive: true });
  fs.copyFileSync(PORTABLES, path.join(root, 'scripts', 'tests', 'portable-suites.test.sh'));
  fs.writeFileSync(path.join(root, 'scripts', 'tests', 'suites.json'), JSON.stringify({ diarias: [
    { raiz: 'arnes', ruta: 'tests/duerme.test.sh', requiere: [] },
  ], semanales: [] }));
  const pids = path.join(root, 'pids');
  fs.mkdirSync(pids);
  fs.writeFileSync(path.join(root, 'scripts', 'tests', 'duerme.test.sh'), [
    `echo $PPID > ${JSON.stringify(path.join(pids, 'reparte'))}`,
    'sleep 120 &',
    `echo $! > ${JSON.stringify(path.join(pids, 'hijo'))}`,
    `echo $$ > ${JSON.stringify(path.join(pids, 'suite'))}`,
    'wait',
  ].join('\n'));
  return { root, pids };
}

function lanzar(j) {
  const env = { ...process.env };
  for (const k of ['NODE_TEST_CONTEXT', 'TYCON_PORTABLE_ONLY', 'TYCON_PORTABLE_SHARD', 'TYCON_PORTABLE_SKIP', 'TYCON_PUBLIC_CI_OUT']) delete env[k];
  Object.assign(env, { HOME: path.join(j.root, 'casa-real'), TYCON_PORTABLE_HOME: path.join(j.root, 'casa'), TYCON_SUITE_TIMES: 'off' });
  fs.mkdirSync(env.HOME);
  const p = spawn('bash', [path.join(j.root, 'scripts', 'tests', 'portable-suites.test.sh')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let salida = '';
  p.stdout.on('data', (d) => { salida += d; });
  p.stderr.on('data', (d) => { salida += d; });
  return { p, salida: () => salida };
}

/** Lanza el corredor, espera a que la suite arranque y devuelve sus pids; al terminar, mata lo que haya quedado. */
async function enMarcha(t) {
  const j = juguete();
  const c = lanzar(j);
  const pid = (n) => leerPid(path.join(j.pids, n));
  t.after(() => {
    for (const n of ['hijo', 'suite', 'reparte']) { const x = pid(n); if (x && vivo(x)) try { process.kill(x, 'SIGKILL'); } catch { /* ya murió */ } }
    try { c.p.kill('SIGKILL'); } catch { /* ya murió */ }
    fs.rmSync(j.root, { recursive: true, force: true });
  });
  const arranco = await esperar(() => pid('reparte') && pid('hijo') && pid('suite'), 30000);
  assert.ok(arranco, `la suite de juguete no arrancó:\n${c.salida()}`);
  return { c, reparte: pid('reparte'), suite: pid('suite'), hijo: pid('hijo') };
}

test('T1 CortarElBash_NoQuedaNiElQueReparteNiLaSuite — el corte del vigilante de memoria corta todo', { skip: SIN_GRUPOS }, async (t) => {
  // 🔴 mutación: sacar el vigía del bash que lo lanzó (el setInterval sobre el padre) o el corte de `enCurso`.
  const m = await enMarcha(t);
  process.kill(m.c.p.pid, 'SIGTERM');
  const limpio = await esperar(() => !vivo(m.reparte) && !vivo(m.suite) && !vivo(m.hijo), 10000);
  assert.ok(limpio, `quedaron vivos: reparte ${vivo(m.reparte)} · suite ${vivo(m.suite)} · hijo de la suite ${vivo(m.hijo)}\n${m.c.salida()}`);
});

test('T2 CortarAlQueReparte_CortaSusSuitesYLoDice — una señal al que reparte mata cada suite en curso', { skip: SIN_GRUPOS }, async (t) => {
  // 🔴 mutación: sacar los `process.on` de SIGTERM/SIGINT/SIGHUP, o matar sólo al bash de la suite (sin el grupo).
  const m = await enMarcha(t);
  process.kill(m.reparte, 'SIGTERM');
  const limpio = await esperar(() => !vivo(m.suite) && !vivo(m.hijo), 10000);
  assert.ok(limpio, `quedaron vivos: suite ${vivo(m.suite)} · hijo de la suite ${vivo(m.hijo)}\n${m.c.salida()}`);
  await esperar(() => m.c.p.exitCode !== null, 10000);
  assert.notStrictEqual(m.c.p.exitCode, 0, 'una corrida cortada no es verde');
  assert.match(m.c.salida(), /me cortaron \(SIGTERM\): corté 1 suite\(s\) en curso/);
});
