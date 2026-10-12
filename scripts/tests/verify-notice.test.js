'use strict';

/**
 * verify-notice.test.js — el texto del aviso de la verificación de lo publicado (story 8.26, tanda F2 · AC 24 · T66).
 *
 * La verificación de noche (`mirror.js verify`) deja su informe en un archivo; scripts/ci/verify-notice.js arma con él
 * el aviso que el pipeline le manda al dueño. Lo que no puede pasar:
 *   · que avise en verde (un aviso de todos los días se deja de leer), o que CALLE con hallazgos o con «no pude mirar»;
 *   · que calle porque el informe no está o no se deja leer habiendo fallado la verificación: eso es «no pude mirar»;
 *   · que el aviso traiga algo que el informe no trae, o que un lugar escrito por un tercero (una ruta de un pedido)
 *     meta saltos de línea, caracteres de control o un texto sin tope en el mensaje.
 *
 * Sin red: el guion sólo lee un archivo y escribe por su salida. Los informes de acá son inventados.
 *
 * Correr: node --test scripts/tests/verify-notice.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'ci', 'verify-notice.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-notice-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let serial = 0;
/** Corre el guion con ese informe (un objeto, un texto crudo, o null: no hay archivo) y ese código de `verify`. */
function notice(report, exit, extra = []) {
  const file = path.join(tmp, `informe-${++serial}.json`);
  if (report !== null) fs.writeFileSync(file, typeof report === 'string' ? report : JSON.stringify(report));
  const r = spawnSync(process.execPath, [SCRIPT, '--report', file, '--exit', String(exit), ...extra], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const finding = (over = {}) => ({ part: 'l', category: 'cliente', place: 'el pedido nº 7 (título)', action: 'delete-and-purge', rotateFirst: false, todo: 'está en un pedido…', ...over });
const report = (over = {}) => ({ command: 'verify', exit: 0, message: 'sin hallazgos', findings: [], couldNotLook: [], notMeasured: [], notApplicable: [], ...over });

test('T66_Green_IsSilent', () => {
  const r = notice(report(), 0);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, '', 'en verde no hay nada que avisar');
  // en verde con partes sin medir o que no aplican (un repo privado, el modo directo): tampoco
  assert.strictEqual(notice(report({ notMeasured: [{ part: 'g', reason: 'sin token' }], notApplicable: [{ part: 'f', reason: '--direct' }] }), 0).out, '');
});

test('T66_Findings_AreSent_WithThePlaceAndWhatToDo_GroupedByAction_SecretFirst', () => {
  const r = notice(report({
    exit: 1,
    findings: [
      finding({ part: 'c', place: 'el commit 0123456789ab (mensaje, línea 2)', action: 'delete', todo: 'cuelga sólo de una rama…' }),
      finding(),
      finding({ part: 'm', category: 'secreto', place: 'el comentario con id 31 (en el pedido o issue nº 7) (línea 1)', rotateFirst: true }),
      finding({ part: 'd', place: 'la descripción del repo', action: 'edit' }),
      finding({ part: 'f', category: 'foreign-change', place: 'el commit abc de main', action: 'see-guide' }),
    ],
  }), 1, ['--run', '20261010.3']);
  assert.strictEqual(r.code, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.match(lines[0], /verificación de lo publicado/i);
  assert.match(lines[0], /5 hallazgo\(s\)/);
  assert.match(lines[0], /corrida 20261010\.3/);
  // el secreto, primero, bajo su propio título; después lo que además se purga, lo que sólo se borra, lo que se corrige
  const titles = lines.filter((l) => /:$/.test(l));
  assert.deepStrictEqual(titles.map((t) => t.replace(/ \(\d+\):$/, '')), ['Rotar PRIMERO (es un secreto), y después borrar y pedir la purga', 'Borrar, y además pedir la purga al soporte de GitHub',
    'Borrar (la rama, la marca o la versión)', 'Corregir en la configuración del repo', 'Ver la guía']);
  assert.ok(lines.indexOf('· (m) [secreto] el comentario con id 31 (en el pedido o issue nº 7) (línea 1)') === lines.indexOf(titles[0]) + 1, r.out);
  for (const f of ['· (l) [cliente] el pedido nº 7 (título)', '· (c) [cliente] el commit 0123456789ab (mensaje, línea 2)', '· (d) [cliente] la descripción del repo', '· (f) [foreign-change] el commit abc de main']) {
    assert.ok(lines.includes(f), `falta «${f}»\n${r.out}`);
  }
  assert.match(r.out, /guides\/publicacion-espejo\.md/);
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(r.out), 'sin emojis: es un aviso al dueño');
});

test('T66_CouldNotLook_IsSentToo_AndSoIsAFailedVerifyWithoutAReadableReport', () => {
  // «no pude mirar»: las partes y el motivo
  let r = notice(report({ exit: 2, message: 'no pude mirar (k): la API contestó 500 al leer las versiones (página 1)', couldNotLook: [{ part: 'k', reason: 'la API contestó 500 al leer las versiones (página 1)' }] }), 2);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /NO PUDO MIRAR/);
  assert.match(r.out, /\(k\)/);
  assert.match(r.out, /la API contestó 500/);
  assert.match(r.out, /no es «limpio»/);
  // hallazgos Y partes sin mirar: las dos cosas
  r = notice(report({ exit: 1, findings: [finding()], couldNotLook: [{ part: 'm', reason: 'la API contestó 500' }] }), 1);
  assert.match(r.out, /1 hallazgo\(s\)/);
  assert.match(r.out, /Además no se pudo mirar: \(m\)/);
  // `verify` frenó antes de mirar nada (sin la lista): el informe trae sólo el código y el motivo
  r = notice({ command: 'verify', exit: 2, message: 'no pude mirar: lo publicado se revisa con la lista privada, y scripts/publishing/denylist.json no sirve' }, 2);
  assert.match(r.out, /NO PUDO MIRAR/);
  assert.match(r.out, /la lista privada/);
  // 🔴 el informe no está, está vacío, o no es un informe: se avisa, diciéndolo — salga la verificación con el código
  // que salga. También con 0: `verify` deja siempre su informe, así que un 0 sin informe no es «verde», es «no se sabe
  // qué miró» (sin esto, un informe que no llegó a escribirse callaba el aviso)
  const unreadable = [['no hay archivo', null], ['vacío', ''], ['no es JSON', '{ a medias'], ['es una lista', '[]'], ['es de otro comando', JSON.stringify({ command: 'sync', exit: 0 })],
    ['sus hallazgos no son una lista', JSON.stringify(report({ findings: 'ninguno' }))], ['lo que no pudo mirar no es una lista', JSON.stringify(report({ couldNotLook: { part: 'k' } }))]];
  for (const [what, body] of unreadable) {
    for (const exit of [0, 1, 2, 137]) {
      const x = notice(body, exit);
      assert.strictEqual(x.code, 0, `${what}/${exit}: ${x.err}`);
      assert.match(x.out, /NO PUDO MIRAR — terminó con código \d+ y no dejó un informe que se pueda leer/, `${what}/${exit}\n${x.out}`);
    }
  }
  // una parte sin mirar que no se puede leer (no es un objeto) no se pierde: cuenta, y el aviso sale
  r = notice(report({ exit: 2, couldNotLook: ['k'] }), 2);
  assert.match(r.out, /NO PUDO MIRAR \(\?\)/);
  // un informe que trae sólo el veredicto —sin las listas— es el de un `verify` que frenó antes: vale, y con 0 calla
  assert.strictEqual(notice({ command: 'verify', exit: 0, message: 'sin hallazgos' }, 0).out, '');
  // un informe que dice «verde» con una verificación que salió mal no tapa la falla (manda el código de la corrida)
  r = notice(report(), 2);
  assert.match(r.out, /NO PUDO MIRAR/);
  r = notice(report({ exit: 0 }), 1);
  assert.match(r.out, /terminó con código 1/);
  // y al revés: salió 0 pero el informe trae hallazgos — algo no cierra, y eso no es silencio: los dice, y dice el código
  r = notice(report({ exit: 1, findings: [finding()] }), 0);
  assert.match(r.out, /1 hallazgo\(s\)/);
  assert.match(r.out, /^\(La verificación terminó con código 0\.\)$/m);
  assert.match(notice(report({ exit: 1, findings: [finding()] }), 2).out, /^\(La verificación terminó con código 2\.\)$/m);
  assert.doesNotMatch(notice(report({ exit: 1, findings: [finding()] }), 1).out, /La verificación terminó con código/, 'con 1 —lo esperado con hallazgos— no hace falta decirlo');
  // salió 0 y el informe dice otro código, sin hallazgos ni partes: tampoco es verde
  r = notice(report({ exit: 2 }), 0);
  assert.match(r.out, /NO PUDO MIRAR — terminó con código 0 y su informe \(que dice 2\)/);
});

test('T66_DidNotFinish_TheVerificationHadToRunAndLeftNothing_IsSentAsCouldNotLook', () => {
  // La corrida tenía que verificar y la verificación no dejó ni su código (el paso anterior falló, o la cortó el tope
  // del trabajo): no hay informe ni código que pasar, y eso no puede terminar en silencio.
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  const r = run(['--did-not-finish', '--run', '20261010.3']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /NO PUDO MIRAR — tenía que correr en esta corrida y no llegó a terminar/);
  assert.match(r.stdout, /corrida 20261010\.3/);
  assert.match(r.stdout, /NO es «limpio»/);
  assert.match(run(['--did-not-finish']).stdout, /NO PUDO MIRAR/);
  // no se mezcla con un informe o un código: o hay verificación terminada, o no la hay
  for (const args of [['--did-not-finish', '--exit', '0'], ['--did-not-finish', '--report', 'x'], ['--report', 'x', '--exit', '0', '--did-not-finish']]) {
    const bad = run(args);
    assert.strictEqual(bad.status, 2, args.join(' '));
    assert.strictEqual(bad.stdout, '');
  }
});

test('T66_WhatAThirdPartyWrote_CannotBreakTheMessage_AndLongListsAreCapped', () => {
  const hostile = `docs/una\nruta con\ttabuladores y \u001b[31mcolores\u001b[0m ${'x'.repeat(900)}`;
  const many = Array.from({ length: 200 }, (_, i) => finding({ place: `el issue nº ${i + 1} (título)` }));
  const r = notice(report({ exit: 1, findings: [finding({ place: hostile }), ...many], couldNotLook: [{ part: 'k', reason: `un motivo\ncon saltos ${'y'.repeat(900)}` }] }), 1);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.out.length <= 3900, `el aviso entra en un mensaje (${r.out.length} caracteres)`);
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(r.out), 'sin caracteres de control');
  assert.ok(!r.out.includes('x'.repeat(301)), 'un lugar largo se corta');
  assert.match(r.out, /… y \d+ más \(están en el registro de la corrida\)/);
  assert.match(r.out, /201 hallazgo\(s\)/, 'la cuenta es la de verdad, no la de los que entraron');
  // un campo que no es texto, o un hallazgo que no es un objeto, no rompe el aviso ni se imprime como vino
  const odd = notice(report({ exit: 1, findings: [null, 7, { part: { a: 1 }, category: ['x'], place: { html: '<b>' } }, finding()] }), 1);
  assert.strictEqual(odd.code, 0, odd.err);
  assert.match(odd.out, /4 hallazgo\(s\)/);
  assert.ok(!odd.out.includes('[object Object]') && !odd.out.includes('<b>'), odd.out);
  // el número de corrida es un dato de afuera: si no tiene forma de número de corrida, no se imprime
  assert.ok(!notice(report({ exit: 1, findings: [finding()] }), 1, ['--run', 'una corrida\nrara $(x)']).out.includes('rara'));
});

test('T66_BadArguments_AreTwo', () => {
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  for (const args of [[], ['--report', 'x'], ['--exit', '1'], ['--report', 'x', '--exit', 'uno'], ['--report', 'x', '--exit', '1', '--unknown'], ['--report', 'x', '--exit', '-1'], ['--report', '--exit', '1']]) {
    const r = run(args);
    assert.strictEqual(r.status, 2, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
    assert.strictEqual(r.stdout, '', 'sin argumentos válidos no escribe un aviso');
  }
});

// ── T68 (story 8.26, tanda F3 · AC 57) ───────────────────────────────────────────────────────────────────────
// Con el repo PRIVADO, lo que quedó en la historia de `main` está aceptado hasta el corte (guides/publicacion-espejo.md,
// §«Si `verify` da 1»): el aviso lo cuenta aparte y sale sólo si hay algo más. Es código que calla, así que lo que no
// puede pasar es que calle de más: cualquier duda —el repo no dice ser privado, un hallazgo que no se deja leer, un
// código que no cierra— avisa todo, como antes.
const QUIET = 3;   // el código con que el guion dice «callé a propósito»: el paso del pipeline lo exige para aceptar el silencio
const SET_ASIDE = /^Aparte: (\d+) hallazgo\(s\) en la historia del repo privado, aceptados hasta el corte \(no se listan\)\.$/m;
/** Un hallazgo de la historia de `main`: lo que la parte (a') encuentra en un commit viejo. */
const old = (over = {}) => finding({ part: "a'", place: 'guides/una-guia.md:12 (el objeto 4c0bc9701739, en la historia o en otra ref)', reach: 'main', todo: 'llegó a main…', ...over });
const privateReport = (over = {}) => report({ private: true, strict: true, exit: 1, ...over });

test('T68_PrivateRepo_OnlyAcceptedHistory_IsSilent_LeavesTheCount_ExitsThree', () => {
  const r = notice(privateReport({ findings: [old(), old({ category: 'interno' }), old({ category: 'ruta-de-maquina' })] }), 1, ['--run', '20261010.3']);
  assert.strictEqual(r.out, '', `no hay aviso\n${r.out}`);
  assert.strictEqual(r.code, QUIET, `calló a propósito, y lo dice con su código\n${r.err}`);
  assert.match(r.err, /^▸ 3 hallazgo\(s\) en la historia del repo privado, aceptados hasta el corte: no se avisan/);
  assert.strictEqual(r.err.trim().split('\n').length, 1, 'una línea para el registro');
  assert.ok(!r.err.includes('una-guia') && !r.err.includes('4c0bc'), 'la línea es una cuenta: sin lugares');
  // partes sin medir que no cuentan para --strict (el informe las trae como «no aplica») no cambian nada
  assert.strictEqual(notice(privateReport({ findings: [old()], notApplicable: [{ part: 'g', reason: 'el repo es privado' }] }), 1).code, QUIET);
  // en verde, con el repo privado, todo sigue igual: ni aviso, ni línea, ni el código de callar
  const green = notice(report({ private: true, strict: true }), 0);
  assert.deepStrictEqual([green.code, green.out, green.err], [0, '', '']);
});

test('T68_PrivateRepo_SomethingElse_IsSent_WithoutTheAccepted_AndSaysHowManyWereSetAside', () => {
  const accepted = [old(), old({ place: 'README.md:3 (el objeto 52c4e1e011fe, en la historia o en otra ref)' })];
  const others = [
    ['un secreto en la historia', old({ category: 'secreto', rotateFirst: true, place: 'config/llaves.md:1 (el objeto aaaa11112222, en la historia o en otra ref)' }), /^Rotar PRIMERO/m],
    // 🔴 lo que nadie leyó no es «un nombre aceptado»: en un binario o en un submódulo de la historia puede haber cualquier
    // cosa, también un secreto. Se avisa (revisor de fallos silenciosos, vuelta 1 de la tanda)
    ['un binario de la historia que nadie leyó', old({ category: 'sin-leer', place: 'vendor/herramienta.bin (el objeto dddd11112222, en la historia o en otra ref)' }), /^Repo privado, sin purga/m],
    ['algo de la historia que está en un pedido', old({ reach: 'pull', place: 'docs/pedido.md:2 (el objeto bbbb11112222, en la historia o en otra ref)' }), /^Repo privado, sin purga/m],
    ['algo que cuelga sólo de una rama', old({ reach: 'ref', action: 'delete', place: 'docs/rama.md:2 (el objeto cccc11112222, en la historia o en otra ref)' }), /^Borrar \(la rama, la marca o la versión\)/m],
    ['algo que main sirve hoy', finding({ part: 'a', reach: 'main', place: 'guides/hoy.md:9' }), /^Repo privado, sin purga/m],
    ['algo en un comentario', finding({ part: 'm', reach: 'conversation', place: 'el comentario con id 31 (en el pedido o issue nº 7) (línea 1)' }), /^Repo privado, sin purga/m],
  ];
  for (const [what, extra, title] of others) {
    const r = notice(privateReport({ findings: [accepted[0], extra, accepted[1]] }), 1);
    assert.strictEqual(r.code, 0, `${what}: ${r.err}`);
    assert.match(r.out, /: 1 hallazgo\(s\)\./, `${what}: la cuenta es la de lo que se avisa\n${r.out}`);
    assert.ok(r.out.includes(`· (${extra.part}) [${extra.category}] ${extra.place}`), `${what}: su lugar\n${r.out}`);
    assert.ok(!r.out.includes('una-guia') && !r.out.includes('README.md'), `${what}: lo aceptado no se lista\n${r.out}`);
    assert.match(r.out, title, `${what}: su título\n${r.out}`);
    assert.strictEqual(Number((SET_ASIDE.exec(r.out) || [])[1]), 2, `${what}: dice cuántos quedaron aparte\n${r.out}`);
    assert.doesNotMatch(r.out, /pedir la purga/, `${what}: con el repo privado no se pide purga`);
    assert.match(r.err, /^▸ 2 hallazgo\(s\) en la historia del repo privado, aceptados hasta el corte: no van en el aviso/, `${what}: la línea del registro`);
  }
  // una parte que no se pudo mirar: el aviso sale por eso, sin hallazgos que listar, y dice lo que quedó aparte
  let r = notice(privateReport({ findings: accepted, couldNotLook: [{ part: 'l', reason: 'la API contestó 403 al leer los pedidos y los issues (página 1)' }] }), 1);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /NO PUDO MIRAR \(l\)/);
  assert.match(r.out, /la API contestó 403/);
  assert.match(r.out, SET_ASIDE);
  assert.doesNotMatch(r.out, /hallazgo\(s\)\. Lo publicado/, 'no anuncia hallazgos: lo único que hay está aceptado');
  // un «no medido» con --strict: hasta esta tanda no se nombraba si además había hallazgos
  r = notice(privateReport({ findings: accepted, notMeasured: [{ part: 'g', reason: 'sin un token que lea alertas' }] }), 1);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /quedó sin medir.*\(g\).*sin un token que lea alertas/);
  assert.match(r.out, SET_ASIDE);
  // …y si además hay otro hallazgo o una parte sin mirar, lo no medido va en su renglón: no se pierde detrás de lo otro
  const also = /^Además quedó sin medir: \(g\) — sin un token que lea alertas$/m;
  r = notice(privateReport({ findings: [...accepted, finding({ part: 'd', reach: 'about', action: 'edit', place: 'la descripción del repo' })], notMeasured: [{ part: 'g', reason: 'sin un token que lea alertas' }] }), 1);
  assert.match(r.out, /: 1 hallazgo\(s\)\./);
  assert.match(r.out, also, r.out);
  r = notice(privateReport({ findings: accepted, couldNotLook: [{ part: 'l', reason: 'la API contestó 403' }], notMeasured: [{ part: 'g', reason: 'sin un token que lea alertas' }] }), 1);
  assert.match(r.out, /NO PUDO MIRAR \(l\)/);
  assert.match(r.out, also, r.out);
  // sin --strict un «no medido» no es «algo más»: la verificación misma no lo cuenta
  assert.strictEqual(notice(privateReport({ strict: false, findings: accepted, notMeasured: [{ part: 'g', reason: 'sin token' }] }), 1).code, QUIET);
});

test('T68_FailsClosed_WhenThePrivateFlagTheFindingOrTheExitCodeAreNotExactlyWhatIsAccepted', () => {
  const three = [old(), old(), old()];
  const everything = (r, what) => {
    assert.strictEqual(r.code, 0, `${what}: ${r.err}`);
    assert.match(r.out, /: 3 hallazgo\(s\)\./, `${what}: avisa todo\n${r.out}`);
    assert.doesNotMatch(r.out, /Aparte:/, `${what}: nada queda aparte`);
    assert.strictEqual(r.err, '', `${what}: sin línea de «aceptados»`);
  };
  // «privado» es exactamente `true` en el informe: con el repo público, sin saberlo (null: no se pudo leer la parte
  // (d)), sin el campo, o con otra cosa, se avisa como siempre —y con el consejo del repo público
  for (const [what, flag] of [['público', { private: false }], ['no se sabe', { private: null }], ['sin el campo', {}], ['un texto', { private: 'true' }], ['un número', { private: 1 }], ['un objeto', { private: {} }]]) {
    const r = notice(report({ strict: true, exit: 1, findings: three, ...flag }), 1);
    everything(r, what);
    assert.match(r.out, /^Borrar, y además pedir la purga al soporte de GitHub \(3\):$/m, `${what}: el título de siempre`);
  }
  // un hallazgo que no es exactamente uno aceptado va con lo que se avisa (los otros dos quedan aparte)
  const odd = [
    ['sin hasta dónde llegó', old({ reach: undefined })], ['con otro alcance', old({ reach: 'MAIN' })], ['el alcance no es un texto', old({ reach: ['main'] })],
    ['sin decir si es un secreto', old({ rotateFirst: undefined })], ['«false» como texto', old({ rotateFirst: 'false' })], ['un secreto que no se marcó', old({ category: 'secreto' })],
    ['una alerta de secreto', old({ category: 'secret-alert' })], ['sin categoría', old({ category: undefined })], ['de otra parte', old({ part: 'a' })], ['la parte no es un texto', old({ part: ["a'"] })],
    ['sin la parte', old({ part: undefined })], ['la categoría no es un texto', old({ category: ['cliente'] })], ['sin leer', old({ category: 'sin-leer' })],
    ['no es un objeto', null], ['es una lista', [old()]], ['es un texto', "a'"],
  ];
  for (const [what, f] of odd) {
    const r = notice(privateReport({ findings: [old(), f, old()] }), 1);
    assert.strictEqual(r.code, 0, `${what}: ${r.err}`);
    assert.match(r.out, /: 1 hallazgo\(s\)\./, `${what}: ese se avisa\n${r.out}`);
    assert.strictEqual(Number((SET_ASIDE.exec(r.out) || [])[1]), 2, `${what}\n${r.out}`);
  }
  // el código de la corrida manda: si no es 1, o no es el que dice el informe, nada se da por aceptado
  for (const [what, said, exit] of [['la corrida salió 2', 1, 2], ['la corrida salió 0', 1, 0], ['el informe dice 2', 2, 1], ['el informe dice 0', 0, 1], ['la cortaron', 1, 137]]) {
    everything(notice(privateReport({ exit: said, findings: three }), exit), what);
  }
  // un «no medido» que no se puede leer, o un informe que no dice si corrió con --strict: no se calla sobre eso
  let r = notice(privateReport({ findings: three, notMeasured: 'ninguno' }), 1);
  everything(r, 'lo no medido no es una lista');
  r = notice(privateReport({ strict: undefined, findings: three, notMeasured: [{ part: 'g', reason: 'sin token' }] }), 1);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /quedó sin medir/, 'sin saber si era --strict, un «no medido» se dice');
  // la verificación no terminó: no hay informe del que separar nada
  const cut = spawnSync(process.execPath, [SCRIPT, '--did-not-finish'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.deepStrictEqual([cut.status, cut.stderr], [0, '']);
  assert.match(cut.stdout, /NO PUDO MIRAR/);
});

test('T68_SetAsideAndCompose_Directly_TheRuleIsPerFinding', () => {
  // las dos funciones que el guion exporta, sin lanzarlo: qué queda aparte y qué texto sale
  const { setAside, compose, QUIET_EXIT } = require(SCRIPT);
  assert.strictEqual(QUIET_EXIT, QUIET);
  const data = privateReport({ findings: [old(), old({ category: 'secreto', rotateFirst: true }), old(), null] });
  const split = setAside({ exit: 1 }, data, data.findings);
  assert.strictEqual(split.accepted, 2);
  assert.deepStrictEqual(split.rest, [data.findings[1], null], 'lo que se avisa conserva su orden; lo aceptado no está');
  // la regla es por hallazgo: el que no es exactamente lo aceptado se avisa él, y los demás quedan aparte
  assert.deepStrictEqual(setAside({ exit: 1 }, data, [old(), {}]), { rest: [{}], accepted: 1 });
  // …y las tres condiciones de la corrida son de todo o nada
  for (const [what, args, report] of [['el repo no dice ser privado', { exit: 1 }, { ...data, private: null }], ['la corrida no salió 1', { exit: 2 }, data], ['el informe no dice 1', { exit: 1 }, { ...data, exit: 0 }]]) {
    assert.deepStrictEqual(setAside(args, report, data.findings), { rest: data.findings, accepted: 0 }, what);
  }
  const quiet = compose({ exit: 1, run: null }, privateReport({ findings: [old(), old()] }));
  assert.deepStrictEqual(quiet, { text: '', accepted: 2 });
  const sent = compose({ exit: 1, run: '7' }, data);
  assert.strictEqual(sent.accepted, 2);
  assert.match(sent.text, /\(corrida 7\): 2 hallazgo\(s\)\./);
  assert.match(sent.text, SET_ASIDE);
});

test('T68_ManyAccepted_NeverCrowdOutWhatIsSent_AndTheMessageStillFits', () => {
  // la corrida de verdad trajo miles: el aviso no los lista, y lo que sí avisa entra entero
  const thousands = Array.from({ length: 5000 }, (_, i) => old({ place: `guides/g-${i}.md:1 (el objeto 4c0bc9701739, en la historia o en otra ref)` }));
  let r = notice(privateReport({ findings: [...thousands, finding({ part: 'd', reach: 'about', action: 'edit', place: 'la descripción del repo' })] }), 1);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.out.length < 700, `un hallazgo y la cuenta: un aviso corto (${r.out.length})`);
  assert.match(r.out, /: 1 hallazgo\(s\)\./);
  assert.ok(r.out.includes('· (d) [cliente] la descripción del repo'), r.out);
  assert.strictEqual(Number((SET_ASIDE.exec(r.out) || [])[1]), 5000);
  // con muchos que sí se avisan, el renglón de lo que quedó aparte no se pierde en el recorte
  const many = Array.from({ length: 300 }, (_, i) => finding({ part: 'l', reach: 'conversation', place: `el issue nº ${i + 1} (título)` }));
  r = notice(privateReport({ findings: [...many, ...thousands], couldNotLook: [{ part: 'm', reason: 'la API contestó 500' }] }), 1);
  assert.ok(r.out.length <= 3900, `entra en un mensaje (${r.out.length})`);
  assert.match(r.out, /: 300 hallazgo\(s\)\./);
  assert.match(r.out, /… y \d+ más/);
  assert.match(r.out, /Además no se pudo mirar: \(m\)/);
  assert.strictEqual(Number((SET_ASIDE.exec(r.out) || [])[1]), 5000);
  // sólo los miles: calla
  r = notice(privateReport({ findings: thousands }), 1);
  assert.deepStrictEqual([r.code, r.out], [QUIET, '']);
  assert.match(r.err, /^▸ 5000 hallazgo\(s\)/);
});
