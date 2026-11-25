'use strict';
/**
 * test-run-isolation.test.js — una prueba en vivo no escribe en la máquina real (historia 8.314).
 *
 * Un humo comparado, y uno cuyo programa es un guion de laboratorio, corren con una casa aparte, sin las variables que
 * apuntan a la casa de la cuenta y con la red de escritura puesta (`isolated-run.js`); el humo común sigue como hoy. Un
 * guion de laboratorio se niega a arrancar con la casa real (`lab-home.js`). La coordinación dice si hay una designación
 * sin confirmar, y las guías dicen la regla.
 *
 * Nada toca la casa real: cada caso arma con `mkdtemp` su casa y también la «casa de la cuenta», que una precarga
 * simula reemplazando `os.userInfo` en toda la cadena de procesos (va en `NODE_OPTIONS`). La red de las pruebas
 * (`lib/real-home-guard.js`) frena lo que se escape.
 * Correr: node --test scripts/tests/test-run-isolation.test.js
 */
const GUARD = require('./lib/real-home-guard.js');   // primera línea que hace algo: frena y anota
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const SK = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts');
const SMOKE = path.join(SK, 'smoke-run.sh');
const ISO = path.join(SK, 'lib', 'isolated-run.js');
const LAB = path.join(RAIZ, 'scripts', 'lib', 'lab-home.js');
const POSIX = process.platform !== 'win32';

// la casa de la cuenta, simulada en cada proceso de la cadena: smoke-run.sh, isolated-run.js y el comando
const PRECARGA = "const os = require('os'); const h = process.env.TEST_ACCOUNT_HOME; if (h) os.userInfo = () => ({ homedir: h, username: 'prueba', uid: 1, gid: 1, shell: null });\n";

function carpeta(t, prefijo = 'aislada-') {
  const b = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefijo)));
  t.after(() => { try { fs.chmodSync(b, 0o700); } catch (_) { /* ya no está */ } fs.rmSync(b, { recursive: true, force: true }); });
  return b;
}
/** Una «casa de la cuenta» de juguete, con su estado, y la precarga que la hace pasar por la real. */
function cuenta(t) {
  const b = carpeta(t);
  const casa = path.join(b, 'cuenta');
  fs.mkdirSync(path.join(casa, '.tycon', 'state'), { recursive: true });
  const pre = path.join(b, 'precarga.js');
  fs.writeFileSync(pre, PRECARGA);
  return { b, casa, pre, userInfo: () => ({ homedir: casa }) };
}
function ambiente(c, extra = {}) {
  const e = { ...process.env };
  delete e.NODE_TEST_CONTEXT;
  delete e.CLAUDE_CODE_SESSION_ID;
  delete e.TYCON_TEST_RUN;
  const previas = String(e.NODE_OPTIONS || '').trim();
  return { ...e, HOME: c.casa, USERPROFILE: c.casa, TYCON_HOME: '', TEST_ACCOUNT_HOME: c.casa, CLAUDE_CODE_SESSION_ID: 'ses-8314',
    NODE_OPTIONS: `${previas ? `${previas} ` : ''}--require "${c.pre}"`, ...extra };
}
// fecha fija y sin mantenimiento automático: el repo de juguete da siempre el mismo commit
const FECHA = '2026-11-19T00:00:00Z';
const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=prueba', '-c', 'user.email=prueba@acme.test', '-c', 'commit.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA } });
/** Un repo de juguete con sus archivos, commiteado. */
function repo(dir, archivos) {
  for (const [rel, texto] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), texto);
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'inicio');
  return dir;
}
const humo = (smoke, ev, id, args, { cwd, env }) => spawnSync('bash', [smoke, ev, id, ...args], { cwd, env, encoding: 'utf8' });
const salida = (r) => `${r.stdout || ''}${r.stderr || ''}`;

// imprime lo que ve del ambiente y escribe en su HOME
const GUION_AMBIENTE = [
  "const fs = require('fs'); const path = require('path');",
  "const o = {}; for (const k of ['HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'TYCON_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'TYCON_TEST_RUN']) o[k] = process.env[k] === undefined ? null : process.env[k];",
  "console.log('AMBIENTE ' + JSON.stringify(o));",
  "try { fs.writeFileSync(path.join(process.env.HOME, 'escrito.txt'), 'x'); } catch (e) { console.log('no escribí: ' + e.code); }",
  'process.exitCode = Number(process.env.TEST_EXIT || 0);',
  '',
].join('\n');
function ambienteDe(texto) {
  const l = String(texto).split('\n').find((x) => x.startsWith('AMBIENTE '));
  return l ? JSON.parse(l.slice('AMBIENTE '.length)) : null;
}
const renglones = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
const espejo = (c) => renglones(path.join(c.casa, '.claude', '.tycon-pipeline', 'gates.log')).filter((g) => g.type === 'smoke-run');
const iso = () => require(ISO);

// ── La pasada de un humo comparado ────────────────────────────────────────────────────────────────────────────────

test('T1 Compare_PrimeraPasada_CorreConCasaAparte @story-8.314 @ac-1', { skip: !POSIX }, (t) => {
  const c = cuenta(t);
  const r = repo(path.join(c.b, 'repo'), { 'tool.js': GUION_AMBIENTE });
  const env = ambiente(c, { TYCON_HOME: path.join(c.b, 'otra-casa'), CLAUDE_CONFIG_DIR: path.join(c.b, 'cfg'), CODEX_HOME: path.join(c.b, 'codex') });
  const s = humo(SMOKE, path.join(r, '.advisors', 'dod-runtime'), '9.1', ['--compare', '--', process.execPath, '{raiz}/tool.js'], { cwd: r, env });
  const a = ambienteDe(salida(s));
  assert.ok(a, salida(s));
  assert.notStrictEqual(a.HOME, c.casa);
  assert.ok(!a.HOME.startsWith(c.casa + path.sep), `la casa aparte queda fuera de la de la cuenta: ${a.HOME}`);
  assert.strictEqual(a.USERPROFILE, a.HOME);
  for (const k of ['TMPDIR', 'TMP', 'TEMP']) assert.ok(a[k] && a[k].startsWith(path.dirname(a.HOME) + path.sep), `${k}=${a[k]}`);
  for (const k of ['TYCON_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) assert.strictEqual(a[k], null, k);
  assert.strictEqual(a.TYCON_TEST_RUN, '1');
  assert.ok(!fs.existsSync(path.join(c.casa, 'escrito.txt')), 'nada escrito en la casa de la cuenta');
  assert.ok(!fs.existsSync(path.dirname(a.HOME)), 'la carpeta aparte se borró al terminar');
});

test('T2 Compare_LaEvidenciaSigueContando @story-8.314 @ac-1 @ac-18', { skip: !POSIX }, (t) => {
  const c = cuenta(t);
  const r = repo(path.join(c.b, 'repo'), { 'tool.js': GUION_AMBIENTE });
  const ev = path.join(r, '.advisors', 'dod-runtime');
  const s = humo(SMOKE, ev, '9.2', ['--acs', '1', '--pass-if', 'imprime su ambiente', '--compare', '--', process.execPath, '{raiz}/tool.js'], { cwd: r, env: ambiente(c) });
  assert.strictEqual(s.status, 0, salida(s));
  const [renglon] = renglones(path.join(ev, '9.2-smoke-ledger.jsonl'));
  assert.ok(renglon, 'el renglón del registro');
  assert.strictEqual(renglon.exit, 0);
  assert.strictEqual(renglon.v, 2);
  assert.match(renglon.cmd, /\{raiz\}\/tool\.js/);
  const e = espejo(c).find((g) => g.ts === renglon.ts && g.story === '9.2');
  assert.ok(e, 'el espejo en el gates.log de la casa de la cuenta');
  assert.strictEqual(e.exit, 0);
  assert.deepStrictEqual(e.acs, [1]);
});

test('T3 Aislada_EscribirEnLaCasaReal_NoPasa @story-8.314 @ac-2', { skip: !POSIX }, (t) => {
  const c = cuenta(t);
  const destino = path.join(c.casa, '.tycon', 'state', 'gates.log');
  fs.writeFileSync(destino, 'antes\n');
  const r = repo(path.join(c.b, 'repo'), {
    '.advisors/dod-runtime/g.js': [
      "const fs = require('fs'); const path = require('path'); const { spawnSync } = require('child_process');",
      `const d = ${JSON.stringify(destino)};`,
      "try { fs.appendFileSync(d, 'directo\\n'); } catch (_) { /* se traga el error */ }",
      "spawnSync(process.execPath, [path.join(__dirname, 'hijo.js'), d], { stdio: 'inherit' });",
      "console.log('terminé');",
    ].join('\n'),
    '.advisors/dod-runtime/hijo.js': "try { require('fs').appendFileSync(process.argv[2], 'hijo\\n'); } catch (_) { /* también */ }\n",
  });
  const s = humo(SMOKE, path.join(r, '.advisors', 'dod-runtime'), '9.3', ['--', process.execPath, '.advisors/dod-runtime/g.js'], { cwd: r, env: ambiente(c) });
  assert.notStrictEqual(s.status, 0, salida(s));
  assert.ok(salida(s).includes(destino), `la salida nombra la ruta: ${salida(s)}`);
  assert.strictEqual(fs.readFileSync(destino, 'utf8'), 'antes\n', 'el archivo no cambió');
});

// Un hijo que el guion lanza con el ambiente mínimo pierde la red de escritura (vive en
// NODE_OPTIONS). Si escribe en una carpeta vigilada, el encierro del sistema lo mata y lo anota, y el humo falla con eso
// aunque el guion se trague el error. Una negación fuera de las carpetas vigiladas no lo hace fallar.
const ENCIERRO = process.platform === 'darwin'
  && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore', timeout: 5000 }).status === 0;
test('Aislada_HijoSinRed_ElEncierroLoAnota @story-8.314 @ac-2', { skip: ENCIERRO ? false : 'sin el encierro del sistema' }, (t) => {
  const c = cuenta(t);
  const destino = path.join(c.casa, '.tycon', 'state', 'intentos-del-hijo.txt');
  fs.writeFileSync(destino, 'antes\n');
  const afuera = path.join(c.b, 'afuera');
  fs.mkdirSync(afuera);
  const r = repo(path.join(c.b, 'repo'), {
    '.advisors/dod-runtime/g.js': [
      "const path = require('path'); const { spawnSync } = require('child_process');",
      // el hijo va con el ambiente mínimo: sin NODE_OPTIONS no lleva la red de escritura
      "spawnSync(process.execPath, [path.join(__dirname, 'hijo.js'), process.argv[2]], { stdio: 'inherit', env: { PATH: process.env.PATH } });",
      "console.log('terminé');",
    ].join('\n'),
    '.advisors/dod-runtime/hijo.js': "try { require('fs').appendFileSync(process.argv[2], 'hijo\\n'); } catch (_) { /* se traga el error */ }\n",
  });
  const ev = path.join(r, '.advisors', 'dod-runtime');
  const correr = (d) => humo(SMOKE, ev, '9.31', ['--', process.execPath, '.advisors/dod-runtime/g.js', d], { cwd: r, env: ambiente(c) });
  const enLaCasa = correr(destino);
  assert.match(salida(enLaCasa), /terminé/);
  assert.notStrictEqual(enLaCasa.status, 0, salida(enLaCasa));
  assert.ok(salida(enLaCasa).includes(destino), `la salida nombra la ruta: ${salida(enLaCasa)}`);
  assert.strictEqual(fs.readFileSync(destino, 'utf8'), 'antes\n', 'el archivo no cambió');
  // control: fuera de las carpetas vigiladas el encierro niega igual, pero no mata ni hace fallar el humo
  const fuera = correr(path.join(afuera, 'f.txt'));
  assert.strictEqual(fuera.status, 0, salida(fuera));
  assert.ok(!fs.existsSync(path.join(afuera, 'f.txt')), 'el encierro lo negó');
  // control: en su repo, el hijo escribe
  const adentro = correr(path.join(r, 'f.txt'));
  assert.strictEqual(adentro.status, 0, salida(adentro));
  assert.ok(fs.existsSync(path.join(r, 'f.txt')), 'escribió en su repo');
});

test('F161b Aislada_EscrituraNegadaFueraDeLoAdmitido_LoDiceEnUnaLinea: un comando que falla porque el encierro le negó escribir fuera de su casa y de su repo se lleva una línea con qué hacer', { skip: ENCIERRO ? false : 'sin el encierro del sistema' }, (t) => {
  // un here document de bash o un temporal de mktemp con otra carpeta dan un «Operation not permitted» suelto: el
  // encierro no se abre, y la línea dice que esa suite va como humo común
  const c = cuenta(t);
  const afuera = path.join(c.b, 'afuera');
  fs.mkdirSync(afuera);
  const r = repo(path.join(c.b, 'repo'), {
    '.advisors/dod-runtime/g.js': [
      "const { spawnSync } = require('child_process');",
      "const h = spawnSync('/bin/sh', ['-c', 'echo x > \"$1\"', 'sh', process.argv[2]], { stdio: 'inherit' });",
      'process.exit(h.status === null ? 1 : h.status);',
    ].join('\n'),
    '.advisors/dod-runtime/falla.js': "console.error('esperaba 2, vino 3'); process.exit(1);\n",
  });
  const ev = path.join(r, '.advisors', 'dod-runtime');
  const correr = (d) => humo(SMOKE, ev, '9.32', ['--', process.execPath, '.advisors/dod-runtime/g.js', d], { cwd: r, env: ambiente(c) });
  const negada = correr(path.join(afuera, 'f.txt'));
  assert.notStrictEqual(negada.status, 0, salida(negada));
  assert.ok(!fs.existsSync(path.join(afuera, 'f.txt')), 'el encierro lo negó');
  const lineas = salida(negada).split('\n').filter((l) => l.includes('humo común'));
  assert.strictEqual(lineas.length, 1, `una línea que dice qué hacer: ${salida(negada)}`);
  assert.match(lineas[0], /\[smoke-run\]/);
  assert.match(lineas[0], /no se abre/);
  // la línea no repite el texto del sistema que se busca en la salida
  assert.doesNotMatch(lineas[0], /Operation not permitted|cannot create temp file/);
  // gemelo: el mismo comando que escribe en su repo sale 0 y no se lleva la línea
  const bien = correr(path.join(r, 'f.txt'));
  assert.strictEqual(bien.status, 0, salida(bien));
  assert.ok(!salida(bien).includes('humo común'), salida(bien));
  // gemelo: un comando que falla por otra cosa (una aserción, sin nada negado) tampoco
  const otro = humo(SMOKE, ev, '9.32', ['--', process.execPath, '.advisors/dod-runtime/falla.js'], { cwd: r, env: ambiente(c) });
  assert.notStrictEqual(otro.status, 0, salida(otro));
  assert.ok(!salida(otro).includes('humo común'), salida(otro));
});

test('F174 Aislada_HereDocDeBash_Anda: en el encierro, desde una carpeta no admitida, el bash del sistema escribe el temporal de su here document; otra escritura ahí sigue negada', { skip: ENCIERRO ? false : 'sin el encierro del sistema' }, (t) => {
  // fila 174: el bash 3.2 de macOS no mira TMPDIR para un here document; si no puede escribir en /var/tmp ni en /tmp (el
  // encierro se lo niega), lo escribe en la carpeta actual como «sh-thd-<n>». Negado, un freno de bash que lo usa no
  // decide y falla cerrado. El humo corre desde la carpeta de la sesión, que no es una raíz admitida.
  const c = cuenta(t);
  const sesion = path.join(c.b, 'sesion');
  fs.mkdirSync(sesion);
  const r = repo(path.join(c.b, 'repo'), {
    '.advisors/dod-runtime/g.js': [
      "const { spawnSync } = require('child_process');",
      "const h = spawnSync('/bin/bash', ['-c', 'cat <<FIN\\nheredoc-ok\\nFIN'], { encoding: 'utf8' });",
      "console.log('HEREDOC ' + (h.stdout || '').trim() + ' ' + (h.stderr || '').trim());",
      "const o = spawnSync('/bin/bash', ['-c', 'echo x > otro.txt'], { encoding: 'utf8' });",
      "console.log('OTRO ' + o.status);",
      // el nombre del temporal no sirve para escribir fuera de la carpeta actual
      "const f = spawnSync('/bin/bash', ['-c', 'echo x > ' + process.argv[2] + '/sh-thd-777'], { encoding: 'utf8' });",
      "console.log('AFUERA ' + f.status);",
    ].join('\n'),
  });
  const afuera = path.join(c.b, 'afuera');
  fs.mkdirSync(afuera);
  const g = path.join(r, '.advisors', 'dod-runtime', 'g.js');
  const s = humo(SMOKE, path.join(r, '.advisors', 'dod-runtime'), '9.32', ['--', process.execPath, g, afuera], { cwd: sesion, env: ambiente(c) });
  assert.match(salida(s), /HEREDOC heredoc-ok/, salida(s));
  assert.doesNotMatch(salida(s), /cannot create temp file/, salida(s));
  assert.match(salida(s), /OTRO [1-9]/, salida(s));
  assert.ok(!fs.existsSync(path.join(sesion, 'otro.txt')), 'otra escritura en la carpeta de la sesión sigue negada');
  assert.deepStrictEqual(fs.readdirSync(sesion).filter((f) => f.startsWith('sh-thd-')), [], 'bash borra su temporal');
  assert.match(salida(s), /AFUERA [1-9]/, salida(s));
  assert.ok(!fs.existsSync(path.join(afuera, 'sh-thd-777')), 'el nombre del temporal en otra carpeta sigue negado');
  // un enlace duro con ese nombre que ya estaba en la carpeta actual no sirve para escribir el archivo al que apunta: con
  // un sh-thd-<n> ya presente, la carpeta no se admite
  const victima = path.join(afuera, 'victima.txt');
  fs.writeFileSync(victima, 'intacto\n');
  fs.linkSync(victima, path.join(sesion, 'sh-thd-11'));
  const enlace = repo(path.join(c.b, 'repo2'), {
    '.advisors/dod-runtime/g.js': "const r = require('child_process').spawnSync('/bin/bash', ['-c', 'echo PWNED > sh-thd-11'], { encoding: 'utf8' }); console.log('ENLACE ' + r.status);\n",
  });
  const s2 = humo(SMOKE, path.join(enlace, '.advisors', 'dod-runtime'), '9.32', ['--', process.execPath, path.join(enlace, '.advisors', 'dod-runtime', 'g.js')], { cwd: sesion, env: ambiente(c) });
  assert.match(salida(s2), /ENLACE [1-9]/, salida(s2));
  assert.strictEqual(fs.readFileSync(victima, 'utf8'), 'intacto\n', 'el archivo del enlace no cambió');
  assert.match(salida(s2), /sh-thd/, `dice por qué el here document queda negado: ${salida(s2)}`);
});

// fila 214: el freno de la consola corre dentro de la corrida aislada desde una carpeta que no es la de lanzamiento (la
// prueba en vivo lo corre en el árbol público). El bash 3.2 de macOS escribe el temporal de un here-string en /var/tmp,
// /tmp o la carpeta actual, y el encierro se los niega: el freno no leía lo que le contestaban sus lectores y, según el
// lugar, negaba o dejaba pasar. El freno no usa here-strings; el encierro no se afloja (admitir /var/tmp dejaba pisar el
// here document de un bash de afuera, como el freno de otra sesión).
const GUARD_PRE = path.join(RAIZ, 'scripts', 'hooks', 'safety-guard-pre.sh');
test('F214 Freno_SinHereStrings: el freno de la consola no usa here-strings ni here documents', () => {
  const malos = fs.readFileSync(GUARD_PRE, 'utf8').split('\n')
    .map((l, i) => ({ l, i: i + 1 }))
    // un `<<<` o un `<<PALABRA` (con comillas, barra o guion) fuera de una cadena: lo que el freno sólo analiza como texto
    // va entre comillas
    .filter(({ l }) => !/^\s*#/.test(l) && /(^|[^<'"])<<(<(?!"\s*$)|-?\s*(\\|['"])?[A-Za-z_][A-Za-z0-9_]*)/.test(l))
    .map(({ l, i }) => `${i}: ${l.trim()}`);
  assert.deepStrictEqual(malos, []);
});

test('F214 Aislada_ElFrenoDesdeOtraCarpeta_Decide: dentro del encierro, el freno corrido desde una carpeta no admitida lee a sus lectores', { skip: ENCIERRO ? false : 'sin el encierro del sistema' }, (t) => {
  const c = cuenta(t);
  const afuera = path.join(c.b, 'afuera');
  fs.mkdirSync(afuera);
  const r = repo(path.join(c.b, 'repo'), {
    '.advisors/dod-runtime/g.js': [
      "const { spawnSync } = require('child_process');",
      // un comando que pasa por los lectores del freno: su respuesta se lee renglón por renglón
      "const ev = JSON.stringify({ tool_name: 'Bash', session_id: 's214', cwd: process.argv[2], tool_input: { command: 'gh pr merge 12 --merge' } });",
      "const h = spawnSync('/bin/bash', [process.argv[3]], { cwd: process.argv[2], input: ev, encoding: 'utf8' });",
      "console.log('FRENO ' + h.status + ' ' + ((h.stderr || '').match(/GIT-C[0-9]+/) || ['sin-regla'])[0] + ' ' + (h.stderr || '').split('\\n').filter((x) => /temp file|here document/.test(x)).join(' | '));",
    ].join('\n'),
  });
  const g = path.join(r, '.advisors', 'dod-runtime', 'g.js');
  const s = humo(SMOKE, path.join(r, '.advisors', 'dod-runtime'), '9.33', ['--', process.execPath, g, afuera, GUARD_PRE], { cwd: r, env: ambiente(c) });
  // sin leer a sus lectores, el freno dejaba pasar este merge (salía 0); leyéndolos, lo frena con su regla
  assert.match(salida(s), /FRENO 2 GIT-C7/, salida(s));
  assert.doesNotMatch(salida(s), /cannot create temp file/, salida(s));
  assert.deepStrictEqual(fs.readdirSync(afuera).filter((f) => /^sh-thd-/i.test(f)), [], 'nada en la carpeta de afuera');
});

test('F214 T2 Aislada_EnlacePlantadoConOtraCaja_NoSeAdmite: un enlace duro «SH-THD-<n>» en la carpeta de lanzamiento cuenta igual que en minúsculas', { skip: ENCIERRO ? false : 'sin el encierro del sistema' }, (t) => {
  // el encierro y el disco de la Mac no distinguen mayúsculas (y pliegan «ſ» en «s»): el chequeo tampoco
  const c = cuenta(t);
  const sesion = path.join(c.b, 'sesion');
  fs.mkdirSync(sesion);
  const afuera = path.join(c.b, 'afuera');
  fs.mkdirSync(afuera);
  const victima = path.join(afuera, 'victima.txt');
  fs.writeFileSync(victima, 'intacto\n');
  for (const nombre of ['SH-THD-31', 'ſh-thd-32']) {
    fs.linkSync(victima, path.join(sesion, nombre));
    const r = repo(path.join(c.b, `repo-${nombre.length}-${nombre.charCodeAt(0)}`), {
      '.advisors/dod-runtime/g.js': `const r = require('child_process').spawnSync('/bin/bash', ['-c', 'echo PWNED > ${nombre.toLowerCase()}'], { encoding: 'utf8' }); console.log('ENLACE ' + r.status);\n`,
    });
    const s = humo(SMOKE, path.join(r, '.advisors', 'dod-runtime'), '9.33', ['--', process.execPath, path.join(r, '.advisors', 'dod-runtime', 'g.js')], { cwd: sesion, env: ambiente(c) });
    assert.match(salida(s), /ENLACE [1-9]/, `${nombre}: ${salida(s)}`);
    assert.strictEqual(fs.readFileSync(victima, 'utf8'), 'intacto\n', `${nombre}: el archivo del enlace no cambió`);
    assert.match(salida(s), /sh-thd/, `${nombre}: dice por qué: ${salida(s)}`);
    fs.rmSync(path.join(sesion, nombre), { force: true });
  }
});

// fila 218: la ventana de permiso corre run-base-controls.sh con bash para clasificar y prechequear la firma de un cambio
// de control. Le pasaba su programa a node con un here document, y dentro del encierro, desde una carpeta que no es la
// de lanzamiento, bash no podía crear su temporal: la firma se negaba con ese error. Se lo pasa sin archivo temporal.
const BASE_CONTROLS = path.join(RAIZ, 'scripts', 'ci', 'run-base-controls.sh');
test('F218 BaseControls_SinHereDocument: lo que bash corre de run-base-controls.sh no usa here documents ni here-strings', () => {
  const lineas = fs.readFileSync(BASE_CONTROLS, 'utf8').split('\n');
  // bash corre lo de antes de la marca del programa (el exec lo reemplaza antes de llegar): ahí no hay ningún `<<`, ni
  // siquiera dentro de una cadena, así ninguna forma de here document o here-string se escapa
  const fin = lineas.indexOf(": <<'JS'");
  assert.ok(fin > 0, 'encuentro la marca del programa');
  const malos = lineas.slice(0, fin)
    .map((l, i) => ({ l, i: i + 1 }))
    .filter(({ l }) => !/^\s*#/.test(l) && l.includes('<<'))
    .map(({ l, i }) => `${i}: ${l.trim()}`);
  assert.deepStrictEqual(malos, []);
});

test('F218 BaseControls_PorTuberia_NoSaleVerde: lanzado desde una tubería, no termina en 0 sin correr nada', { skip: !POSIX }, (t) => {
  // sed abre la misma fuente que bash: si es una tubería, se comía lo que a bash le faltaba leer y bash terminaba en 0
  const c = cuenta(t);
  // la tubería la arma bash, en un guion propio (la entrada que pone node es un socket en Linux, y /dev/stdin no se abre
  // sobre un socket); el guion y la carpeta le llegan como argumentos
  const lanzar = (nombre, renglon) => {
    const guion = path.join(c.b, nombre);
    fs.writeFileSync(guion, `${renglon}\n`);
    return spawnSync('bash', [guion, BASE_CONTROLS, c.b], { cwd: c.b, encoding: 'utf8' });
  };
  const porTuberia = lanzar('por-tuberia.sh', 'cat "$1" | bash /dev/stdin check-inventory --root "$2"');
  assert.strictEqual(porTuberia.status, 9, `cat … | bash /dev/stdin: ${porTuberia.stdout}${porTuberia.stderr}`);
  const porSustitucion = lanzar('por-sustitucion.sh', 'bash <(cat "$1") check-inventory --root "$2"');
  assert.strictEqual(porSustitucion.status, 9, `bash <(cat …): ${porSustitucion.stdout}${porSustitucion.stderr}`);
  assert.match(porSustitucion.stdout, /no pude correr/);
});

test('F218 BaseControls_SinElPrograma_NoPudeCorrer: si no encuentra su programa sale 9, nunca 0 con un programa vacío', { skip: !POSIX }, (t) => {
  const c = cuenta(t);
  const copia = path.join(c.b, 'run-base-controls.sh');
  fs.writeFileSync(copia, fs.readFileSync(BASE_CONTROLS, 'utf8').replace(/^: <<'JS'\n/m, ''));
  const r = spawnSync('bash', [copia, 'check-inventory', '--root', c.b], { cwd: c.b, encoding: 'utf8' });
  assert.strictEqual(r.status, 9, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /no pude correr: no pude leer el programa de node/);
});

test('F218 Aislada_BaseControlsDesdeOtraCarpeta_LlegaANode: dentro del encierro, run-base-controls.sh corrido desde una carpeta no admitida le pasa su programa a node', { skip: ENCIERRO ? false : 'sin el encierro del sistema' }, (t) => {
  const c = cuenta(t);
  const afuera = path.join(c.b, 'afuera');
  fs.mkdirSync(afuera);
  const r = repo(path.join(c.b, 'repo'), {
    '.advisors/dod-runtime/g.js': [
      "const { spawnSync } = require('child_process');",
      // un pedido mal escrito: lo contesta el programa de node, así que llegar a esa respuesta prueba que lo recibió
      "const h = spawnSync('/bin/bash', [process.argv[3], 'classify', '--root', process.argv[2], '--base', 'HEAD', '--entries', 'no-es-json'], { cwd: process.argv[2], encoding: 'utf8' });",
      "console.log('CONTROLES ' + h.status + ' ' + ((h.stdout || '') + (h.stderr || '')).split('\\n').filter((x) => /no es JSON|temp file|here document/.test(x)).join(' | '));",
    ].join('\n'),
  });
  const g = path.join(r, '.advisors', 'dod-runtime', 'g.js');
  const s = humo(SMOKE, path.join(r, '.advisors', 'dod-runtime'), '9.33', ['--', process.execPath, g, afuera, BASE_CONTROLS], { cwd: r, env: ambiente(c) });
  assert.match(salida(s), /CONTROLES 2 .*--entries no es JSON/, salida(s));
  assert.doesNotMatch(salida(s), /cannot create temp file/, salida(s));
  assert.deepStrictEqual(fs.readdirSync(afuera).filter((f) => /^sh-thd-/i.test(f)), [], 'nada en la carpeta de afuera');
});

test('F174 T2 Aislada_HijoSinLasVariablesDeLaRed_EscribeEnSuLaboratorio: un hijo con HOME de juguete y sin las variables TYCON_ escribe en su casa de juguete; la casa de la cuenta sigue frenada', { skip: !POSIX }, (t) => {
  // fila 174: un guion de laboratorio limpia lo que empieza con TYCON_ para su hijo y deja NODE_OPTIONS; el hijo carga la
  // red sin sus raíces y no tiene que tomar su HOME de juguete por la casa real
  const c = cuenta(t);
  const destinoReal = path.join(c.casa, '.tycon', 'state', 'del-hijo.txt');
  const r = repo(path.join(c.b, 'repo'), {
    '.advisors/dod-runtime/g.js': [
      "const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawnSync } = require('child_process');",
      "const juguete = fs.mkdtempSync(path.join(os.tmpdir(), 'juguete-'));",
      "const env = {}; for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_')) env[k] = v;",
      "Object.assign(env, { HOME: juguete, USERPROFILE: juguete });",
      "const hijo = \"const fs = require('fs'); const path = require('path'); fs.mkdirSync(path.join(process.env.HOME, '.claude', '.tycon-pipeline'), { recursive: true }); fs.writeFileSync(path.join(process.env.HOME, '.claude', '.tycon-pipeline', 'x.jsonl'), 'x'); console.log('LAB ok'); try { fs.writeFileSync(process.argv[1], 'x'); console.log('REAL escribió'); } catch (e) { console.log('REAL ' + e.code); }\";",
      "const h = spawnSync(process.execPath, ['-e', hijo, process.argv[2]], { env, encoding: 'utf8' });",
      "console.log('HIJO ' + h.status + ' ' + (h.stdout || '').trim().replace(/\\n/g, ' | ') + ' ' + (h.stderr || '').trim().split('\\n')[0]);",
    ].join('\n'),
  });
  const s = humo(SMOKE, path.join(r, '.advisors', 'dod-runtime'), '9.33', ['--', process.execPath, '.advisors/dod-runtime/g.js', destinoReal], { cwd: r, env: ambiente(c) });
  assert.match(salida(s), /LAB ok/, salida(s));
  // la casa de la cuenta de esta prueba es una carpeta temporal que llega por HOME. Sin el encierro del sistema (Linux,
  // Windows), el hijo sin sus variables protege la casa de la cuenta del sistema (os.userInfo), que acá es otra: sólo
  // con el encierro se puede ver que la de la prueba sigue frenada, sin escribir en la de verdad
  if (process.platform !== 'darwin' || /sin el encierro del sistema/.test(salida(s))) return;
  assert.doesNotMatch(salida(s), /REAL escribió/, salida(s));
  assert.ok(!fs.existsSync(destinoReal), 'la casa de la cuenta sigue frenada');
});

// 🔴 Falla con: la corrida lee el registro del sistema una sola vez al terminar; con la máquina cargada la negación todavía
// no llegó, la lectura sale vacía y la corrida da verde aunque un proceso quiso escribir en la casa (fila 170)
test('Aislada_RegistroAtrasado_EsperaLaMarcaDeCierre @story-8.314 @ac-2: lo negado se lee aunque el registro llegue tarde', () => {
  const { negadasDelEncierro } = require(ISO);
  const marca = 'tycon-aislada-1-abc';
  const negada = `Sandbox: node(9) deny(1) file-write-create /casa/.tycon/state/x\n${marca}`;
  const cierre = `Sandbox: touch(10) deny(1) file-write-create /base/cierre/x\n${marca}-cierre`;
  let reloj = 0;
  const opts = (vueltas) => {
    let n = 0;
    return { espera: 10000, pausa: 100, ahora: () => reloj, dormir: (ms) => { reloj += ms; }, leer: () => { n += 1; return { eventos: n < vueltas ? [] : [negada, cierre] }; } };
  };
  // las dos primeras lecturas todavía no traen nada: espera la marca de cierre y encuentra la negada
  assert.deepStrictEqual(negadasDelEncierro(marca, 0, opts(3)), ['/casa/.tycon/state/x']);
  // con la marca de cierre y sin negadas, ninguna
  reloj = 0;
  assert.deepStrictEqual(negadasDelEncierro(marca, 0, { ...opts(1), leer: () => ({ eventos: [cierre] }) }), []);
});

test('Aislada_RegistroSinMarcaDeCierre_NoEsVerde @story-8.314 @ac-2: si la marca de cierre no llega, no se sabe y no da verde', () => {
  const { negadasDelEncierro } = require(ISO);
  let reloj = 0;
  let lecturas = 0;
  const r = negadasDelEncierro('tycon-aislada-2-def', 0, { espera: 1000, pausa: 100, ahora: () => reloj, dormir: (ms) => { reloj += ms; }, leer: () => { lecturas += 1; return { eventos: [] }; } });
  assert.ok(r && r.error, `sin la marca de cierre tiene que decir que no sabe: ${JSON.stringify(r)}`);
  assert.match(r.error, /marca de cierre/);
  assert.ok(lecturas > 1, 'volvió a leer mientras esperaba');
  // un registro que no se puede leer tampoco es «ninguna»
  assert.ok(negadasDelEncierro('m', 0, { leer: () => ({ error: 'salió 1' }) }).error);
});

test('T4 Aislada_RepoDentroDeLoVigilado_SeEscribe @story-8.314 @ac-2', { skip: !POSIX }, (t) => {
  const c = cuenta(t);
  const r = repo(path.join(c.casa, '.claude', 'worktrees', 'r'), {
    '.advisors/dod-runtime/g.js': "require('fs').writeFileSync(require('path').join(__dirname, '..', '..', 'escrito.txt'), 'x'); console.log('escribí');\n",
  });
  const s = humo(SMOKE, path.join(r, '.advisors', 'dod-runtime'), '9.4', ['--', process.execPath, '.advisors/dod-runtime/g.js'], { cwd: r, env: ambiente(c) });
  assert.strictEqual(s.status, 0, salida(s));
  assert.ok(fs.existsSync(path.join(r, 'escrito.txt')), 'escribió en la raíz de su repo');
});

test('T5 Compare_NombraLaCasaReal_NoCorre @story-8.314 @ac-3', { skip: !POSIX }, (t) => {
  const c = cuenta(t);
  const r = repo(path.join(c.b, 'repo'), { 'tool.js': GUION_AMBIENTE });
  const ev = path.join(r, '.advisors', 'dod-runtime');
  const registro = path.join(ev, '9.5-smoke-ledger.jsonl');
  const testigo = path.join(c.b, 'testigo5');
  const tocar = `require('fs').writeFileSync(${JSON.stringify(testigo)}, 'x')`;
  for (const cmd of [[process.execPath, '-e', tocar, path.join(c.casa, 'algo.txt')], ['sudo', 'touch', testigo]]) {
    const s = humo(SMOKE, ev, '9.5', ['--compare', '--', ...cmd], { cwd: r, env: ambiente(c) });
    assert.strictEqual(s.status, 2, `${cmd.join(' ')}: ${salida(s)}`);
    assert.ok(!fs.existsSync(testigo), `${cmd[0]}: no corrió`);
    assert.ok(!fs.existsSync(registro), `${cmd[0]}: no dejó renglón`);
    assert.match(s.stderr, /\{raiz\}/, 'dice cómo escribirlo');
  }
  // la raíz real cae bajo la casa, pero el comando la nombra con {raiz}: corre
  const bajo = repo(path.join(c.casa, 'proyecto'), { 'tool.js': GUION_AMBIENTE });
  const enCasa = humo(SMOKE, path.join(bajo, '.advisors', 'dod-runtime'), '9.5', ['--compare', '--', process.execPath, '{raiz}/tool.js'], { cwd: bajo, env: ambiente(c) });
  assert.strictEqual(enCasa.status, 0, salida(enCasa));
  assert.ok(ambienteDe(salida(enCasa)), salida(enCasa));
  // el intérprete vive bajo la casa: su ruta no cuenta
  fs.mkdirSync(path.join(c.casa, 'bin'), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(c.casa, 'bin', 'node'));
  const interprete = humo(SMOKE, ev, '9.5', ['--compare', '--', path.join(c.casa, 'bin', 'node'), 'tool.js'], { cwd: r, env: ambiente(c) });
  assert.strictEqual(interprete.status, 0, salida(interprete));
  assert.ok(fs.existsSync(registro), 'éste sí deja su renglón');
});

test('T6 Aislada_SinCasaOSinRed_NoCorre @story-8.314 @ac-4', { skip: !POSIX }, (t) => {
  const c = cuenta(t);
  const testigo = path.join(c.b, 'testigo6');
  const tocar = `require('fs').writeFileSync(${JSON.stringify(testigo)}, 'x');\n`;
  const r = repo(path.join(c.b, 'repo'), { '.advisors/dod-runtime/g.js': tocar });
  const ev = path.join(r, '.advisors', 'dod-runtime');
  const lab = [process.execPath, '.advisors/dod-runtime/g.js'];
  // una carpeta temporal que no se puede escribir: no hay dónde crear la casa
  const cerrada = path.join(c.b, 'cerrada');
  fs.mkdirSync(cerrada);
  fs.chmodSync(cerrada, 0o500);
  const sinCasa = humo(SMOKE, ev, '9.6', ['--', ...lab], { cwd: r, env: ambiente(c, { TMPDIR: cerrada }) });
  fs.chmodSync(cerrada, 0o700);
  assert.strictEqual(sinCasa.status, 2, salida(sinCasa));
  assert.ok(!fs.existsSync(testigo), 'sin casa no corrió');
  // un arnés sin la red de escritura
  const copia = require('./lib/harness-copy.js').harnessCopy();
  fs.rmSync(path.join(copia, 'scripts', 'tests', 'lib', 'real-home-guard.js'));
  const smokeCopia = path.join(copia, 'skills', 'tycon-pipeline', 'scripts', 'smoke-run.sh');
  for (const args of [['--', ...lab], ['--compare', '--', ...lab]]) {
    const s = humo(smokeCopia, ev, '9.6', args, { cwd: r, env: ambiente(c) });
    assert.strictEqual(s.status, 2, `sin la red (${args[0]}): ${salida(s)}`);
    assert.ok(!fs.existsSync(testigo), 'sin la red no corrió');
  }
  // smoke-run.sh copiado sin isolated-run.js: no sabe aislar
  const sin = path.join(c.b, 'sin-aislar');
  fs.mkdirSync(path.join(sin, 'lib'), { recursive: true });
  fs.copyFileSync(SMOKE, path.join(sin, 'smoke-run.sh'));
  fs.copyFileSync(path.join(SK, 'lib', 'evidence-key.js'), path.join(sin, 'lib', 'evidence-key.js'));
  for (const args of [['--compare', '--', process.execPath, '-e', tocar], ['--', process.execPath, path.join(ev, 'g.js')]]) {
    const s = humo(path.join(sin, 'smoke-run.sh'), ev, '9.6', args, { cwd: r, env: ambiente(c) });
    assert.strictEqual(s.status, 2, `sin isolated-run.js (${args[0]}): ${salida(s)}`);
    assert.ok(!fs.existsSync(testigo), 'sin isolated-run.js no corrió');
  }
});

// ── Los guiones de laboratorio ────────────────────────────────────────────────────────────────────────────────────

test('T7 Laboratorio_CorreAislado @story-8.314 @ac-5', { skip: !POSIX }, (t) => {
  const c = cuenta(t);
  const r = repo(path.join(c.b, 'repo'), { '.advisors/dod-runtime/g.js': GUION_AMBIENTE, 'scripts/p.js': GUION_AMBIENTE });
  const ev = path.join(r, '.advisors', 'dod-runtime');
  const conCasaAparte = (s) => { const a = ambienteDe(salida(s)); assert.ok(a, salida(s)); return a.HOME !== c.casa; };
  assert.ok(conCasaAparte(humo(SMOKE, ev, '9.7', ['--', process.execPath, '.advisors/dod-runtime/g.js'], { cwd: r, env: ambiente(c) })), 'el de .advisors/dod-runtime');
  // un guion suelto en la carpeta temporal: aislado, y escribe en su carpeta
  const suelto = carpeta(t, 'lab-suelto-');
  fs.writeFileSync(path.join(suelto, 'g.js'), `${GUION_AMBIENTE}require('fs').writeFileSync(require('path').join(__dirname, 'junto.txt'), 'x');\n`);
  const directo = humo(SMOKE, ev, '9.7', ['--', process.execPath, path.join(suelto, 'g.js')], { cwd: r, env: ambiente(c) });
  assert.ok(conCasaAparte(directo), 'el suelto, directo');
  assert.ok(fs.existsSync(path.join(suelto, 'junto.txt')), 'el suelto escribe en su carpeta');
  const conCd = humo(SMOKE, ev, '9.7', ['--', 'bash', '-c', `cd '${suelto}' && '${process.execPath}' g.js`], { cwd: r, env: ambiente(c) });
  assert.ok(conCasaAparte(conCd), 'adentro de bash -c, después de un cd');
  const decidir = (argv, cwd = r) => iso().decide({ argv, cwd, env: ambiente(c), userInfo: c.userInfo }).modo;
  assert.strictEqual(decidir(['env', 'FOO=1', process.execPath, path.join(suelto, 'g.js')]), 'aislada', 'detrás de env');
  assert.strictEqual(decidir(['timeout', '60', process.execPath, path.join(suelto, 'g.js')]), 'aislada', 'detrás de timeout');
  assert.strictEqual(decidir(['sh', '-c', `cd '${suelto}' && node g.js`]), 'aislada', 'adentro de sh -c');
  // un programa de un repo que está en la carpeta temporal, y un sh -c que sólo escribe en un temporal: comunes
  assert.strictEqual(decidir([process.execPath, 'scripts/p.js']), 'comun');
  assert.strictEqual(decidir(['sh', '-c', `echo x > '${path.join(suelto, 'f.txt')}'`]), 'comun');
  assert.ok(!conCasaAparte(humo(SMOKE, ev, '9.7', ['--', process.execPath, 'scripts/p.js'], { cwd: r, env: ambiente(c) })), 'el de scripts/, con la casa de siempre');
});

test('T8 LabHome_ConLaCasaReal_SeNiega @story-8.314 @ac-6', (t) => {
  const c = cuenta(t);
  const lh = require(LAB);
  const salio = (env) => {
    try { lh.refuseRealHome('prueba', { env, userInfo: c.userInfo, exit: (n) => { throw Object.assign(new Error('salió'), { salida: n }); }, err: () => {} }); return null; } catch (e) { if (e.salida === undefined) throw e; return e.salida; }
  };
  assert.strictEqual(salio({ HOME: c.casa }), 3, 'con la casa de la cuenta');
  assert.strictEqual(salio({ HOME: path.join(c.casa, 'sub') }), 3, 'adentro de ella');
  assert.strictEqual(salio({ HOME: path.join(c.b, 'afuera') }), null, 'afuera sigue');
  // el guion de verdad: sale 3 antes de escribir nada
  const testigo = path.join(c.b, 'testigo8');
  const guion = path.join(c.b, 'guion8.js');
  fs.writeFileSync(guion, `require(${JSON.stringify(LAB)}).refuseRealHome('guion8');\nrequire('fs').writeFileSync(${JSON.stringify(testigo)}, 'x');\n`);
  const conCasa = spawnSync(process.execPath, [guion], { env: ambiente(c), encoding: 'utf8' });
  assert.strictEqual(conCasa.status, 3, salida(conCasa));
  assert.match(conCasa.stderr, /mktemp/, 'dice cómo correrlo');
  assert.ok(!fs.existsSync(testigo));
  const afuera = spawnSync(process.execPath, [guion], { env: ambiente(c, { HOME: path.join(c.b, 'afuera') }), encoding: 'utf8' });
  assert.strictEqual(afuera.status, 0, salida(afuera));
  assert.ok(fs.existsSync(testigo));
  const check = spawnSync(process.execPath, [LAB, 'check', 'guion-sh'], { env: ambiente(c), encoding: 'utf8' });
  assert.strictEqual(check.status, 3, salida(check));
});

test('T9 LabHome_CreaLaCasaAfuera @story-8.314 @ac-6', (t) => {
  const c = cuenta(t);
  const lh = require(LAB);
  const afuera = path.join(c.b, 'tmp-afuera');
  fs.mkdirSync(afuera);
  const casa = lh.labHouse('prueba', { env: { TMPDIR: afuera }, userInfo: c.userInfo });
  assert.ok(fs.statSync(casa).isDirectory());
  assert.ok(casa.startsWith(fs.realpathSync(afuera) + path.sep), casa);
  assert.notStrictEqual(lh.labHouse('prueba', { env: { TMPDIR: afuera }, userInfo: c.userInfo }), casa, 'una nueva cada vez');
  const adentro = path.join(c.casa, 'tmp');
  fs.mkdirSync(adentro);
  assert.throws(() => lh.labHouse('prueba', { env: { TMPDIR: adentro }, userInfo: c.userInfo }), /adentro de la casa de la cuenta/);
});

// ── No-regresión ──────────────────────────────────────────────────────────────────────────────────────────────────

test('T20 HumoComun_SigueIgual @story-8.314 @ac-14 @ac-18', { skip: !POSIX }, (t) => {
  const c = cuenta(t);
  const testigo = path.join(c.b, 'testigo20');
  const r = repo(path.join(c.b, 'repo'), { 'scripts/p.js': `${GUION_AMBIENTE}require('fs').writeFileSync(${JSON.stringify(testigo)}, 'x');\n` });
  const ev = path.join(r, '.advisors', 'dod-runtime');
  const env = ambiente(c, { TEST_EXIT: '4' });
  const s = humo(SMOKE, ev, '9.20', ['--', process.execPath, 'scripts/p.js'], { cwd: r, env });
  assert.strictEqual(s.status, 4, salida(s));
  const a = ambienteDe(salida(s));
  assert.strictEqual(a.HOME, c.casa, 'la misma casa');
  assert.strictEqual(a.TMPDIR, env.TMPDIR === undefined ? null : env.TMPDIR, 'el mismo TMPDIR');
  assert.strictEqual(a.TYCON_TEST_RUN, '1', 'sólo suma la variable');
  assert.ok(fs.existsSync(path.join(c.casa, 'escrito.txt')), 'escribe en su casa, como siempre');
  // sin carpeta temporal, y con smoke-run.sh copiado sin isolated-run.js: el comando corre igual
  fs.rmSync(testigo);
  const sinTmp = humo(SMOKE, ev, '9.20', ['--', process.execPath, 'scripts/p.js'], { cwd: r, env: ambiente(c, { TEST_EXIT: '4', TMPDIR: path.join(c.b, 'no-existe') }) });
  assert.strictEqual(sinTmp.status, 4, salida(sinTmp));
  assert.ok(fs.existsSync(testigo), 'sin temporal corrió');
  fs.rmSync(testigo);
  const sin = path.join(c.b, 'sin-aislar');
  fs.mkdirSync(path.join(sin, 'lib'), { recursive: true });
  fs.copyFileSync(SMOKE, path.join(sin, 'smoke-run.sh'));
  fs.copyFileSync(path.join(SK, 'lib', 'evidence-key.js'), path.join(sin, 'lib', 'evidence-key.js'));
  const copia = humo(path.join(sin, 'smoke-run.sh'), ev, '9.20', ['--', process.execPath, 'scripts/p.js'], { cwd: r, env });
  assert.strictEqual(copia.status, 4, salida(copia));
  assert.ok(fs.existsSync(testigo), 'sin isolated-run.js corrió');
});

// ── Quién es la coordinadora, desde la coordinación ───────────────────────────────────────────────────────────────

test('T22 Status_DiceLaPendiente @story-8.314 @ac-12', (t) => {
  const c = cuenta(t);
  const ds = require(path.join(RAIZ, 'scripts', 'lib', 'delegated-signing.js'));
  const coordination = require(path.join(RAIZ, 'scripts', 'tools', 'coordination.js'));
  const gates = path.join(c.casa, '.tycon', 'state', 'gates.log');
  const real = { name: 'relay-designation', status: 'ok', ts: '2026-11-18T22:00:00.000Z', sesion: 'ses-real', rol: 'coordinadora', quien: 'la persona', via: 'click' };
  fs.writeFileSync(gates, `${JSON.stringify(real)}\n${JSON.stringify(ds.confirmationRecord(real, '2026-11-18T22:00:01.000Z', { via: 'click' }))}\n`);
  const texto = () => coordination.statusText(coordination.status({ home: c.casa, env: {}, noTranscripts: true }));
  assert.doesNotMatch(texto(), /sin confirmar/);
  const suelta = { name: 'relay-designation', status: 'ok', ts: '2026-11-18T22:25:00.000Z', sesion: 'ses-otra', rol: 'coordinadora', quien: 'el dueño', cita: 'Esta sesión es la coordinadora' };
  fs.appendFileSync(gates, `${JSON.stringify(suelta)}\n`);
  const d = new Date(suelta.ts);
  const hora = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const linea = texto().split('\n').find((l) => /sin confirmar/.test(l));
  assert.ok(linea, texto());
  assert.ok(linea.includes('ses-otra') && linea.includes(hora), linea);
  assert.match(linea, /no cuenta hasta que el dueño la confirme/);
});

// ── Las guías ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('T23 Guias_DicenLaRegla @story-8.314 @ac-20', () => {
  const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
  const paso = leer('skills/tycon-pipeline/steps/step-10-live-check.md');
  assert.match(paso, /casa aparte/);
  assert.match(paso, /lab-home\.js/);
  assert.match(paso, /refuseRealHome/);
  for (const rel of ['guides/coordination.md', 'guides/coordination.en.md']) {
    const g = leer(rel);
    for (const palabra of ['board.js backups', 'board.js restore', '--allow-shrink']) assert.ok(g.includes(palabra), `${rel}: ${palabra}`);
  }
  assert.match(leer('guides/coordination.md'), /sin confirmar/);
  assert.match(leer('guides/coordination.en.md'), /unconfirmed/);
  assert.match(leer('guides/owner-signatures.md'), /sin confirmar no desplaza/);
});

// ── Los hallazgos del pase adversarial (vuelta 1) ─────────────────────────────────────────────────────────────────

test('Pase_LaboratorioEscondidoEnElComando_SeAisla @story-8.314 @ac-5', { skip: !POSIX }, (t) => {
  const c = cuenta(t);
  const lab = carpeta(t, 'lab-pase-');
  for (const f of ['g.js', 'pre.js', 'x.ts']) fs.writeFileSync(path.join(lab, f), "console.log('lab');\n");
  fs.writeFileSync(path.join(lab, 'run.sh'), 'node g.js\n');
  const otro = carpeta(t, 'no-lab-');
  const decidir = (argv) => iso().decide({ argv, cwd: otro, env: ambiente(c), userInfo: c.userInfo }).modo;
  const g = path.join(lab, 'g.js');
  const casos = [
    ['letras juntas con -o', ['bash', '-euo', 'pipefail', '-c', `node '${g}'`]],
    ['guion de shell con -euo', ['bash', '-euo', 'pipefail', path.join(lab, 'run.sh')]],
    ['adentro de un for', ['bash', '-c', `for i in 1; do node '${g}'; done`]],
    ['adentro de un if', ['bash', '-c', `if true; then node '${g}'; fi`]],
    ['detrás de !', ['bash', '-c', `! node '${g}'`]],
    ['con la variable de la carpeta temporal', ['bash', '-c', 'node "$TMPDIR/g.js"']],
    ['detrás de dos intérpretes', ['npx', 'tsx', path.join(lab, 'x.ts')]],
    ['detrás de una opción con valor', [process.execPath, '-r', path.join(lab, 'pre.js'), g]],
    ['con env -C', ['env', '-C', lab, process.execPath, 'g.js']],
  ];
  for (const [caso, argv] of casos) assert.strictEqual(decidir(argv), 'aislada', caso);
  // lo que sólo escribe en un temporal sigue siendo común
  assert.strictEqual(decidir(['sh', '-c', `echo x > '${path.join(lab, 'nuevo.txt')}'`]), 'comun');
});

test('Pase_InterpreteDetrasDeUnPrefijo_NoNombraLaCasa @story-8.314 @ac-3', { skip: !POSIX }, (t) => {
  const c = cuenta(t);
  const r = repo(path.join(c.b, 'repo'), { 'tool.js': GUION_AMBIENTE });
  const node = path.join(c.casa, 'bin', 'node');
  const d = iso().decide({ argv: ['env', 'FOO=1', node, 'tool.js'], compare: true, cwd: r, env: ambiente(c), userInfo: c.userInfo });
  assert.strictEqual(d.codigo, undefined, d.motivo);
  assert.strictEqual(d.modo, 'aislada');
  // un prefijo que sí nombra la casa sigue frenando
  const conCasa = iso().decide({ argv: ['env', `FOO=${path.join(c.casa, 'x')}`, node, 'tool.js'], compare: true, cwd: r, env: ambiente(c), userInfo: c.userInfo });
  assert.strictEqual(conCasa.codigo, 2);
});

test('Pase_CasaDeLaboratorioEnWindows_NoSeNiega @story-8.314 @ac-6', (t) => {
  const c = cuenta(t);
  const lh = require(LAB);
  const salio = (env) => {
    try { lh.refuseRealHome('prueba', { env, userInfo: c.userInfo, platform: 'win32', exit: (n) => { throw Object.assign(new Error('salió'), { salida: n }); }, err: () => {} }); return null; } catch (e) { if (e.salida === undefined) throw e; return e.salida; }
  };
  assert.strictEqual(salio({ USERPROFILE: path.join(c.casa, 'AppData', 'Local', 'Temp', 'tycon-lab-prueba-x') }), null, 'la que da labHouse');
  assert.strictEqual(salio({ USERPROFILE: c.casa }), 3, 'la casa de la cuenta');
  assert.strictEqual(salio({ USERPROFILE: path.join(c.casa, 'Documents') }), 3, 'adentro, fuera del temporal');
});

// 🔴 mutación: que la red viaje sólo en variables del ambiente. Un comando que las limpia pierde lo que vigila la red,
// el registro que mira `exec` y las carpetas admitidas.
test('T8 IsolatedRun_CarriesRootsWithGuard @story-8.321 @ac-1 @ac-3', { skip: !POSIX }, async (t) => {
  const c = cuenta(t);
  const fuera = carpeta(t, 'aislada-ve-');
  const visto = path.join(fuera, 'visto.json');
  const guion = path.join(fuera, 've.js');
  fs.writeFileSync(guion, `require('fs').writeFileSync(${JSON.stringify(visto)}, JSON.stringify(process[Symbol.for('tycon.real-home-guard')] || null));\n`);
  const codigo = await iso().exec({ argv: [process.execPath, guion], raices: [fuera], env: ambiente(c), userInfo: c.userInfo, cwd: fuera, err: () => {} });
  assert.strictEqual(codigo, 0);
  const red = JSON.parse(fs.readFileSync(visto, 'utf8'));
  assert.ok(red, 'la red viaja con lo que vigila');
  for (const d of ['.tycon', '.claude', '.codex']) assert.ok(red.roots.includes(path.join(c.casa, d)), `vigila ${d}: ${red.roots}`);
  assert.match(red.log, /intentos\.jsonl$/);
  assert.ok(red.allow.includes(fuera), `admite la raíz del humo: ${red.allow}`);
});

// fila 226: lo mismo que el freno (214) en los demás guiones de bash del camino de los controles. Un here document o un
// here-string pide un temporal que el bash 3.2 de macOS escribe en /var/tmp, /tmp o la carpeta actual, y dentro de la
// corrida aislada, desde otra carpeta, el encierro se los niega. scripts/ci/public-ci.sh queda afuera: corre sólo en la
// CI y nunca dentro del encierro.
const SIN_HERE_DOCUMENTS = [
  '.githooks/pre-commit-checks',
  'skills/tycon-pipeline/scripts/smoke-run.sh',
  'skills/tycon-pipeline/scripts/test-gate.sh',
  'skills/tycon-pipeline/scripts/e2e-gate.sh',
  'scripts/hooks/git-post-commit-global.sh',
  'scripts/hooks/git-pre-push-global.sh',
  'scripts/hooks/engram-pre-commit.sh',
  'scripts/lib/legacy-names.sh',
  'scripts/ci/check-bash32-quoting.sh',
];
test('F226 GuionesDeLosControles_SinHereDocuments: los guiones de bash del camino de los controles no usan here documents ni here-strings', () => {
  const malos = [];
  for (const rel of SIN_HERE_DOCUMENTS) {
    fs.readFileSync(path.join(RAIZ, rel), 'utf8').split('\n').forEach((l, i) => {
      if (!/^\s*#/.test(l) && l.includes('<<')) malos.push(`${rel}:${i + 1}: ${l.trim()}`);
    });
  }
  assert.deepStrictEqual(malos, []);
});

test('F226 Aislada_LegacyNamesDesdeOtraCarpeta_Encuentra: dentro del encierro, desde una carpeta no admitida, la biblioteca de nombres viejos encuentra su entrada', { skip: ENCIERRO ? false : 'sin el encierro del sistema' }, (t) => {
  const c = cuenta(t);
  const afuera = path.join(c.b, 'afuera');
  fs.mkdirSync(afuera);
  const r = repo(path.join(c.b, 'repo'), {
    '.advisors/dod-runtime/g.js': [
      "const { spawnSync } = require('child_process');",
      "const lineas = ['env', 'TYCON_OLD_SAMPLE', 'TYCON_NEW_SAMPLE', '0'].join('\\t');",
      "const h = spawnSync('/bin/bash', ['-c', '. \"$1\"; _LEGACY_NAMES_LINES=\"$2\"; _legacy_names_find env old TYCON_OLD_SAMPLE', 'bash', process.argv[3], lineas], { cwd: process.argv[2], encoding: 'utf8' });",
      "console.log('LEGADO ' + h.status + ' ' + JSON.stringify(h.stdout) + ' ' + (h.stderr || '').split('\\n').filter((x) => /temp file|here document/.test(x)).join(' | '));",
    ].join('\n'),
  });
  const g = path.join(r, '.advisors', 'dod-runtime', 'g.js');
  const s = humo(SMOKE, path.join(r, '.advisors', 'dod-runtime'), '9.33', ['--', process.execPath, g, afuera, path.join(RAIZ, 'scripts', 'lib', 'legacy-names.sh')], { cwd: r, env: ambiente(c) });
  assert.match(salida(s), /LEGADO 0 "TYCON_OLD_SAMPLE\\tTYCON_NEW_SAMPLE\\t0"/, salida(s));
  assert.doesNotMatch(salida(s), /cannot create temp file/, salida(s));
});

test('T99 RedDeLasPruebas_NadaTocoLaCasaReal @story-8.314', () => {
  assert.deepStrictEqual(GUARD.attempts(), [], GUARD.describe());
});
