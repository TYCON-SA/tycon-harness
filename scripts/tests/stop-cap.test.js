'use strict';
// stop-cap.test.js — el tope de cierres seguidos de los frenos del cierre del turno cuando no pueden llevar su propia
// cuenta (scripts/lib/stop-cap.js). Sin él, el portón de la prueba en vivo, retro-pending y unpushed-work-notice
// retenían en cada cierre con su contador ilegible o con un repo que git no contesta, y la sesión quedaba en un lazo.
// Todo en el laboratorio de la matriz de fallas: casa y carpeta del tope temporales.
// Correr: cd scripts/tests && HOME=$(mktemp -d) node --test stop-cap.test.js < /dev/null

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const HL = require('./lib/hook-failure-lab.js');
const { CASOS } = require('./lib/hook-failure-cases.js');
const tope = require('../lib/stop-cap.js');

const P = (rel) => path.join(HL.ROOT, rel);
const STOP_DOD = P('skills/tycon-pipeline/scripts/on-stop-dod-gate.js');
const RETRO = P('scripts/hooks/retro-pending.js');
const UNPUSHED = P('scripts/hooks/unpushed-work-notice.js');
const SID = 's1';
const stop = (extra = {}) => JSON.stringify({ hook_event_name: 'Stop', session_id: SID, stop_hook_active: false, ...extra });

// cada camino que retenía sin fin, armado con su caso de la matriz; `cerrar` vuelve a cerrar el mismo turno
const CAMINOS = {
  'portón de la prueba en vivo, contador ilegible': (L) => {
    CASOS['on-stop-dod-gate.js']['contador-de-frenos-ilegible-retiene'](L);
    return (extra) => L.correr(STOP_DOD, JSON.stringify({ session_id: SID, ...extra }));
  },
  'retro-pending, contador ilegible': (L) => {
    CASOS['retro-pending.js']['contador-de-bloqueos-ilegible'](L);
    const dir = path.join(L.dir, 'no-es-repo');
    return (extra) => L.correr(RETRO, stop({ cwd: dir, ...extra }), { cwd: dir, extra: { TYCON_RETRO_ASK_PR: '0' } });
  },
  'unpushed-work-notice, repo que git no contesta': (L) => {
    CASOS['unpushed-work-notice.js']['repo-no-escaneado-retiene'](L);
    return (extra) => L.correr(UNPUSHED, stop(extra));
  },
  'unpushed-work-notice, lo avisado no se guarda': (L) => {
    CASOS['unpushed-work-notice.js']['estado-de-avisados-no-anotable-retiene'](L);
    return (extra) => L.correr(UNPUSHED, stop(extra));
  },
};

// 🔴 Falla con: el portón, retro-pending o unpushed-work-notice que retienen también el cuarto cierre seguido.
test('StopCap_UnreadableState_HoldsThreeClosesThenLetsClose — sin poder leer su estado, retiene tres cierres seguidos y el siguiente deja cerrar, diciéndolo', (t) => {
  for (const [nombre, armar] of Object.entries(CAMINOS)) {
    const L = HL.lab(t);
    const cerrar = armar(L);
    // el caso ya cerró una o dos veces: se cuenta desde la cuenta del tope
    const hechas = (() => { try { return JSON.parse(fs.readFileSync(path.join(L.dir, 'stop-cap', fs.readdirSync(path.join(L.dir, 'stop-cap'))[0]), 'utf8')).vueltas; } catch (_) { return 0; } })();
    for (let i = hechas + 1; i <= tope.MAX_SEGUIDOS; i++) assert.strictEqual(HL.resultado(cerrar()), 'frena', `${nombre}: el cierre ${i} retiene`);
    const cuarto = cerrar();
    assert.strictEqual(HL.resultado(cuarto), 'pasa', `${nombre}: pasado el tope deja cerrar (${(cuarto.err || cuarto.out).replace(/\s+/g, ' ').slice(0, 200)})`);
    assert.match(cuarto.err + cuarto.out, /cierres seguidos/, `${nombre}: dice por qué deja cerrar`);
  }
});

// 🔴 Falla con: sin poder anotar tampoco la cuenta del tope, el freno que retiene en cada cierre.
test('StopCap_CapDirUnwritable_LetsCloseWhenTheStopComesFromAHook — sin la cuenta del tope, deja cerrar si el cierre ya viene de un freno del cierre', (t) => {
  for (const [nombre, armar] of Object.entries(CAMINOS)) {
    const L = HL.lab(t);
    // la carpeta del tope es un archivo: no se puede anotar
    const noEsCarpeta = path.join(L.dir, 'tope-roto');
    fs.writeFileSync(noEsCarpeta, '');
    armar(L);
    const primero = L.correr(...argsDe(nombre, L, false, noEsCarpeta));
    const encadenado = L.correr(...argsDe(nombre, L, true, noEsCarpeta));
    assert.strictEqual(HL.resultado(primero), 'frena', `${nombre}: el primer cierre retiene`);
    assert.strictEqual(HL.resultado(encadenado), 'pasa', `${nombre}: un cierre que viene de un freno del cierre deja cerrar (${(encadenado.err || encadenado.out).replace(/\s+/g, ' ').slice(0, 200)})`);
  }
});

/** Los argumentos de `L.correr` para cerrar con `stop_hook_active` y la carpeta del tope que no se puede usar. */
function argsDe(nombre, L, activo, carpetaRota) {
  const extra = { TYCON_STOP_CAP_DIR: carpetaRota };
  if (nombre.startsWith('portón')) return [STOP_DOD, JSON.stringify({ session_id: SID, stop_hook_active: activo }), { extra }];
  if (nombre.startsWith('retro')) {
    const dir = path.join(L.dir, 'no-es-repo');
    return [RETRO, stop({ cwd: dir, stop_hook_active: activo }), { cwd: dir, extra: { ...extra, TYCON_RETRO_ASK_PR: '0' } }];
  }
  return [UNPUSHED, stop({ stop_hook_active: activo }), { extra }];
}

// 🔴 Falla con: el tope que toca lo que ya andaba: el contador legible de retro-pending y el aviso único de unpushed.
test('StopCap_NormalHolds_Untouched — con su estado legible, cada freno retiene como siempre', (t) => {
  // retro-pending con su contador: tres bloqueos y deja cerrar, contados por él
  const L = HL.lab(t);
  const dir = path.join(L.dir, 'no-es-repo');
  fs.mkdirSync(dir, { recursive: true });
  // stable-data: el merge propio tiene que ser reciente para que el freno lo reclame; la hora no se compara
  fs.writeFileSync(path.join(L.estado, 'retro-pending.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), sessionId: SID, repoPath: dir, sha: 'a'.repeat(40), branch: 'main' })}\n`);
  const r = [1, 2, 3, 4].map(() => HL.resultado(L.correr(RETRO, stop({ cwd: dir }), { cwd: dir, extra: { TYCON_RETRO_ASK_PR: '0' } })));
  assert.deepStrictEqual(r, ['frena', 'frena', 'frena', 'pasa'], 'retro-pending cuenta con su contador');
  assert.ok(!fs.existsSync(path.join(L.dir, 'stop-cap')) || fs.readdirSync(path.join(L.dir, 'stop-cap')).length === 0, 'con su contador legible no usa el tope');
  // unpushed-work-notice con trabajo sin subir: retiene una vez y después deja cerrar, como siempre
  const L2 = HL.lab(t);
  const rp = L2.repo();
  const remoto = path.join(L2.dir, 'remoto.git');
  require('child_process').spawnSync('git', ['init', '-q', '--bare', remoto]);
  rp.git('remote', 'add', 'origin', remoto);
  rp.git('push', '-q', '-u', 'origin', 'main');
  fs.writeFileSync(path.join(rp.dir, 'b.txt'), 'b\n');
  rp.git('add', 'b.txt');
  rp.git('commit', '-q', '-m', 'sin subir');
  fs.writeFileSync(path.join(L2.estado, `unpushed-commits-${SID}.jsonl`), `${JSON.stringify({ kind: 'commit', repo: rp.dir, sha: rp.git('rev-parse', 'HEAD').stdout.trim() })}\n`);
  assert.deepStrictEqual([1, 2].map(() => HL.resultado(L2.correr(UNPUSHED, stop()))), ['frena', 'pasa'], 'unpushed avisa una vez por rama');
});

test('StopCap_Lib_CountsExpiresAndReleases — la cuenta sube, vence a la media hora y se suelta', (t) => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'stop-cap-lib-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { TYCON_STOP_CAP_DIR: dir };
  const AHORA = Date.parse('2026-11-21T12:00:00Z');
  const v = (ahora = AHORA) => tope.otraVuelta({ freno: 'f', sesion: 's', ahora, env });
  assert.deepStrictEqual([v().vuelta, v().vuelta, v().vuelta], [1, 2, 3]);
  assert.strictEqual(v().retener, false, 'el cuarto deja cerrar');
  assert.strictEqual(v().vuelta, 1, 'y la cuenta vuelve a empezar');
  assert.strictEqual(v(AHORA + 31 * 60 * 1000).vuelta, 1, 'una cuenta de hace más de media hora no se suma');
  v(); tope.soltar({ freno: 'f', sesion: 's', env });
  assert.strictEqual(v().vuelta, 1, 'soltar la pone en cero');
});

// 🔴 Falla con: el portón que no suelta la cuenta del tope cuando su contador vuelve a andar (una falla nueva, minutos
// después, se soltaría antes del tercer cierre).
test('StopCap_GateCounterWorksAgain_CountStartsOver — con el contador sano de nuevo, la próxima falla vuelve a retener tres cierres', (t) => {
  const L = HL.lab(t);
  CASOS['on-stop-dod-gate.js']['contador-de-frenos-ilegible-retiene'](L);   // dos cierres retenidos sin contador
  const contador = path.join(L.estado, 'lost-run-stop', `${SID}.json`);
  fs.rmSync(contador, { recursive: true, force: true });
  const cerrar = () => L.correr(STOP_DOD, JSON.stringify({ session_id: SID }));
  cerrar();                                                                   // con el contador sano
  fs.rmSync(contador, { recursive: true, force: true });
  fs.mkdirSync(contador, { recursive: true });                                // vuelve a fallar
  const r = [1, 2, 3, 4].map(() => HL.resultado(cerrar()));
  assert.deepStrictEqual(r, ['frena', 'frena', 'frena', 'pasa'], 'la cuenta empezó de cero');
});
