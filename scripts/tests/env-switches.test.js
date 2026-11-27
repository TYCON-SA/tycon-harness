'use strict';
/*
 * env-switches.test.js — la lista única de las variables de entorno que lee el arnés (scripts/lib/env-switches.json).
 *
 * La lista dice, por variable, qué valor la apaga de verdad, quién la lee y si la noche la cuenta como escape. La leen
 * `apaga()` (la configuración, HARNESS-C2) y la revisión de la noche; los dos frenos de bash (ESC-C1 y HARNESS-C1) siguen
 * con su texto y estas pruebas los atan a la lista. Cada caso con su casa de juguete: nada toca la máquina.
 * Correr: node --test scripts/tests/env-switches.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const ES = require(path.join(ROOT, 'scripts', 'lib', 'env-switches.js'));
const GUARD = path.join(ROOT, 'scripts', 'hooks', 'safety-guard-pre.sh');
const ATDD = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'on-atdd-preedit.js');

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const CLASES = ['debilita-evidencia', 'kill-switch', 'escape-de-diseno', 'configuracion', 'mas-control', 'sin-lector'];

/** Lo que una función escribe por la salida de error mientras corre. */
function conError(fn) {
  const orig = process.stderr.write;
  let err = '';
  process.stderr.write = (s) => { err += s; return true; };
  try { return { valor: fn(), err }; } finally { process.stderr.write = orig; }
}

// T1 EnvSwitches_SchemaAndReportVariables @story-8.256 @ac-1 @ac-7
// 🔴 Falla con: una entrada sin alguno de sus campos, una clase fuera de las seis, una variable del informe que falta, o
//    TYCON_ADVISORS_GATE dada por sin lector cuando la lee el gancho del commit.
test('T1 EnvSwitches_SchemaAndReportVariables @story-8.256 @ac-1 @ac-7', () => {
  const l = ES.leer();
  assert.ok(l.ok, l.error);
  for (const e of l.entradas) {
    assert.match(e.nombre, /^(TYCON_[A-Z0-9_]+|DOD_BYPASS|STOP_AUTONOMY)$/, JSON.stringify(e));
    assert.ok(Array.isArray(e.apagan), `${e.nombre}: apagan`);
    assert.ok(Array.isArray(e.lectores), `${e.nombre}: lectores`);
    assert.ok(['entorno', 'comando'].includes(e.lectura), `${e.nombre}: lectura`);
    assert.ok(['hook', 'agente', 'git-hook', 'ninguno'].includes(e.proceso), `${e.nombre}: proceso`);
    assert.ok(CLASES.includes(e.clase), `${e.nombre}: clase ${e.clase}`);
    for (const k of ['firma', 'noche']) assert.strictEqual(typeof e[k], 'boolean', `${e.nombre}: ${k}`);
    assert.ok(e.en_configuracion === null || e.en_configuracion === 'cualquiera', `${e.nombre}: en_configuracion`);
  }
  const nombres = new Set(l.entradas.map((e) => e.nombre));
  for (const v of ['TYCON_MUTATION_CHECK', 'TYCON_RUNTIME_MATRIX_LEGACY', 'TYCON_RUNTIME_MATRIX_NO_MUTATION_CHECK',
    'TYCON_STORY_REVIEW', 'TYCON_ATDD_PREEDIT_GATE', 'TYCON_COVERAGE_MIN', 'TYCON_NO_LIVENESS_PRECOMMIT', 'TYCON_ADVISORS_GATE',
    'TYCON_COMPARE_SANDBOX', 'TYCON_SMOKE_REDACT', 'TYCON_NO_RUN_CHANGE', 'TYCON_5B_EARLY', 'TYCON_GATE_ALL_SUITES',
    'TYCON_PIPELINE_NO_AUTONOMOUS']) assert.ok(nombres.has(v), v);
  const adv = ES.entrada('TYCON_ADVISORS_GATE');
  assert.strictEqual(adv.clase, 'kill-switch');
  assert.ok(adv.lectores.some((f) => f.endsWith('on-pre-commit.js')), adv.lectores.join(','));
  assert.deepStrictEqual(adv.apagan, ['off']);
  const stop = ES.entrada('STOP_AUTONOMY');
  assert.deepStrictEqual([stop.apagan, stop.noche, stop.en_configuracion], [['1'], true, 'cualquiera']);
});

// T28 EnvSwitches_InventoryMatchesReaders @story-8.256 @ac-2
// 🔴 Falla con: una variable que el arnés lee y la lista no trae, o una entrada sin lector que no se declara sin lector.
test('T28 EnvSwitches_InventoryMatchesReaders @story-8.256 @ac-2', () => {
  const lecturas = ES.lecturas(ROOT);
  const l = ES.leer();
  assert.deepStrictEqual(ES.faltantes(l.entradas, lecturas), []);
  assert.deepStrictEqual(ES.sinLector(l.entradas, ROOT, lecturas), []);
  // una copia de la lista sin una variable que se lee: la nombra
  const sinMut = l.entradas.filter((e) => e.nombre !== 'TYCON_MUTATION_CHECK');
  assert.deepStrictEqual(ES.faltantes(sinMut, lecturas), ['TYCON_MUTATION_CHECK']);
  // una entrada que nadie lee y no se declara sin lector: la nombra
  const fantasma = { nombre: 'TYCON_NOBODY_READS_IT', apagan: ['0'], lectores: [], lectura: 'entorno', proceso: 'ninguno', clase: 'kill-switch', firma: false, noche: false, en_configuracion: null };
  assert.deepStrictEqual(ES.sinLector([...l.entradas, fantasma], ROOT, lecturas), ['TYCON_NOBODY_READS_IT']);
  assert.deepStrictEqual(ES.sinLector([...l.entradas, { ...fantasma, clase: 'sin-lector' }], ROOT, lecturas), []);
  // las formas que cuentan como lectura, en un árbol de juguete
  const d = tmp('es-formas-');
  fs.mkdirSync(path.join(d, 'scripts'));
  fs.writeFileSync(path.join(d, 'scripts', 'a.js'), "const a = process.env.TYCON_ONE; const b = process.env['TYCON_TWO']; const c = env.TYCON_THREE; readEnv('TYCON_FOUR');\n");
  // un guion lee también por el node que lleva adentro, y un `test-*.js` suelto es código, no una prueba
  fs.writeFileSync(path.join(d, 'scripts', 'b.sh'), 'X="${TYCON_FIVE:-}"; echo $TYCON_SIX\nnode -e "const s = process.env.TYCON_SEVEN"\n');
  fs.writeFileSync(path.join(d, 'scripts', 'test-scope.js'), 'process.env.TYCON_EIGHT;\n');
  fs.mkdirSync(path.join(d, 'scripts', 'tests'));
  fs.writeFileSync(path.join(d, 'scripts', 'tests', 'c.test.js'), 'process.env.TYCON_TEST_ONLY;\n');
  fs.writeFileSync(path.join(d, 'scripts', 'd.test.js'), 'process.env.TYCON_TEST_ONLY;\n');
  assert.deepStrictEqual([...ES.lecturas(d).keys()].sort(), ['TYCON_EIGHT', 'TYCON_FIVE', 'TYCON_FOUR', 'TYCON_ONE', 'TYCON_SEVEN', 'TYCON_SIX', 'TYCON_THREE', 'TYCON_TWO']);
});

// 🔴 Falla con: TYCON_INTERNAL_HISTORY apaga el control de historia interna y no estaba en la lista (el control no la ve
//    porque el guion la nombra por una constante, `env[SWITCH]`).
test('EnvSwitches_InternalHistory_IsDeclared — la variable que apaga el control de historia interna está en la lista', () => {
  const e = ES.leer().entradas.find((x) => x.nombre === 'TYCON_INTERNAL_HISTORY');
  assert.ok(e, 'la lista la declara');
  assert.deepStrictEqual(e.lectores, ['scripts/publishing/internal-history.js']);
  assert.strictEqual(e.clase, 'kill-switch', 'apaga un control');
});

/**
 * ¿El archivo nombra la variable en su código? Por las formas que cuenta `lecturas()` o como texto entre comillas: una
 * constante con el nombre, o un ayudante que la recibe por nombre (`readEnv('X')`). Los comentarios no cuentan. Un
 * archivo que no está es «no».
 */
function nombraEnCodigo(raiz, rel, nombre) {
  let texto;
  try { texto = fs.readFileSync(path.join(raiz, rel), 'utf8'); } catch (_e) { return false; }
  const codigo = texto.split('\n').filter((l) => !/^\s*(\/\/|\/?\*|#)/.test(l)).join('\n');
  const formas = rel.endsWith('.json') ? [`optin:${nombre}\\b`, `"${nombre}"`]
    : rel.endsWith('.sh') ? [`\\$\\{?${nombre}\\b`, `\\benv\\.${nombre}\\b`, `['"]${nombre}['"]`, `\\b${nombre}=`]
      : [`\\benv\\.${nombre}\\b`, `\\benv\\[\\s*['"]${nombre}['"]`, `['"\`]${nombre}['"\`]`];
  return formas.some((f) => new RegExp(f).test(codigo));
}

/** Los lectores declarados que no nombran su variable en el código, y los archivos que la leen sin estar declarados. */
function lectoresQueNoCoinciden(entradas, raiz, lecturasDelArbol) {
  const declaradosQueNoLeen = [];
  const leenSinDeclarar = [];
  for (const e of entradas) {
    if (e.lectura === 'comando') continue;   // la lee el comando que la pone delante: la mira sinLector
    for (const f of e.lectores) if (!nombraEnCodigo(raiz, f, e.nombre)) declaradosQueNoLeen.push(`${e.nombre}: ${f}`);
    // `lecturas()` cuenta también un comentario (un ejemplo de uso): ése no es un lector
    for (const f of lecturasDelArbol.get(e.nombre) || []) if (!e.lectores.includes(f) && nombraEnCodigo(raiz, f, e.nombre)) leenSinDeclarar.push(`${e.nombre}: ${f}`);
  }
  return { declaradosQueNoLeen: declaradosQueNoLeen.sort(), leenSinDeclarar: leenSinDeclarar.sort() };
}

// EnvSwitches_DeclaredReadersMatchTheTree
// 🔴 Falla con: un lector declarado que no nombra su variable (una función que se mudó al partir un guion y la lista
//    siguió nombrando el archivo viejo), o un archivo que la lee y la lista no nombra entre sus lectores.
test('EnvSwitches_DeclaredReadersMatchTheTree — cada lector declarado lee su variable, y cada lector del árbol está declarado', () => {
  const r = lectoresQueNoCoinciden(ES.leer().entradas, ROOT, ES.lecturas(ROOT));
  assert.deepStrictEqual(r.declaradosQueNoLeen, [], 'lectores declarados que no nombran la variable en su código');
  assert.deepStrictEqual(r.leenSinDeclarar, [], 'archivos que leen la variable y la lista no los nombra');
  // en un árbol de juguete: un lector que sólo la nombra en un comentario no cuenta, uno con una constante sí, y un
  // archivo que la lee sin estar en la lista se nombra
  const d = tmp('es-lectores-');
  fs.mkdirSync(path.join(d, 'scripts'));
  fs.writeFileSync(path.join(d, 'scripts', 'comentario.js'), '// se apaga con TYCON_ONE=0\n');
  fs.writeFileSync(path.join(d, 'scripts', 'constante.js'), "const OFF = 'TYCON_ONE';\nmodule.exports = (env) => env[OFF] !== '0';\n");
  fs.writeFileSync(path.join(d, 'scripts', 'suelto.sh'), 'echo "${TYCON_ONE:-}"\n');
  // un atajo de nombre viejo generado (la marca en la segunda línea) no es un lector: su lectura es la de la plantilla,
  // que vive en legacy-names.js y está declarada ahí. El privado trae decenas en el árbol armado
  fs.writeFileSync(path.join(d, 'scripts', 'viejo.js'), "#!/usr/bin/env node\n// tycon-legacy-shim: scripts/constante.js\nconst x = process.env.TYCON_ONE;\n");
  fs.writeFileSync(path.join(d, 'scripts', 'viejo.sh'), '#!/bin/sh\n# tycon-legacy-shim: scripts/suelto.sh\necho "${TYCON_ONE:-}"\n');
  const entrada = { nombre: 'TYCON_ONE', lectores: ['scripts/comentario.js', 'scripts/constante.js'], lectura: 'entorno' };
  assert.deepStrictEqual(lectoresQueNoCoinciden([entrada], d, ES.lecturas(d)), {
    declaradosQueNoLeen: ['TYCON_ONE: scripts/comentario.js'],
    leenSinDeclarar: ['TYCON_ONE: scripts/suelto.sh'],
  });
});

// T4 CrossCheck_EscC1AndHarnessC1MatchTheList @story-8.256 @ac-5
// 🔴 Falla con: ESC-C1 o las firmas por variable que no coinciden con la lista, o un apagado de la lista que escrito en
//    el archivo de arranque del shell no frena.
test('T4 CrossCheck_EscC1AndHarnessC1MatchTheList @story-8.256 @ac-5', () => {
  const guard = fs.readFileSync(GUARD, 'utf8');
  const m = guard.match(/^for _esc in ([A-Z0-9_ ]+); do$/m);
  assert.ok(m, 'no encontré el for _esc de ESC-C1');
  assert.deepStrictEqual(m[1].trim().split(/\s+/).sort(), ES.conFirma().sort());
  // las que HARNESS-C1 toma con cualquier valor que no sea 0: las `cualquiera` de la lista
  const rc = guard.match(/^_RC_CUALQUIERA="([A-Z0-9_|]+)"$/m);
  assert.ok(rc, 'no encontré _RC_CUALQUIERA de HARNESS-C1');
  assert.deepStrictEqual(rc[1].split('|').sort(), ES.cualquiera().sort());
  // las firmas por variable del catálogo (POR_VARIABLE de signatures.js, que la publica como `<VAR>=<valor> <comando>`):
  // cada una en la lista, con su valor entre los que apagan
  const porVariable = require(path.join(ROOT, 'scripts', 'lib', 'signatures.js')).SIGNATURES
    .map((s) => /^escape:([A-Z0-9_]+)$/.test(s.id) && String(s.command).match(/^([A-Z0-9_]+)=(\S+) <comando>$/)).filter(Boolean).map((x) => [x[1], x[2]]);
  assert.ok(porVariable.length >= 7, `firmas por variable: ${porVariable.length}`);
  for (const [nombre, valor] of porVariable) {
    const e = ES.entrada(nombre);
    assert.ok(e, `${nombre} no está en la lista`);
    assert.ok(e.apagan.includes(valor), `${nombre}=${valor} no está entre los que apagan (${e.apagan})`);
  }
  // Cada valor que apaga, y en mayúsculas cuando es una palabra (los lectores comparan sin mayúsculas): `ci` del chequeo
  // de vida y `Off` se escapaban del freno.
  const h = tmp('es-rc-');
  for (const e of ES.leer().entradas.filter((x) => ES.apagaUnControl(x) && ['agente', 'hook', 'git-hook'].includes(x.proceso))) {
    const valores = e.en_configuracion === 'cualquiera' ? ['1'] : e.apagan.flatMap((v) => (/[a-z]/.test(v) ? [v, v.toUpperCase(), v[0].toUpperCase() + v.slice(1)] : [v]));
    for (const valor of valores) {
      const cmd = `echo 'export ${e.nombre}=${valor}' >> ~/.zshrc`;
      const input = JSON.stringify({ session_id: 's-es', tool_name: 'Bash', tool_input: { command: cmd }, cwd: h, permission_mode: 'bypassPermissions' });
      const r = spawnSync('bash', [GUARD], { input, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: h, USERPROFILE: h } });
      assert.strictEqual(r.status, 2, `${cmd} no frenó\n${r.stderr}`);
      // las de ESC-C1 las frena antes la firma; las demás, HARNESS-C1
      assert.match(r.stderr, e.firma ? /HARNESS-C1|ESC-C1/ : /HARNESS-C1/, cmd);
    }
  }
});

// T7 AtddPreedit_OffWritesOncePerSessionAndDay @story-8.256 @ac-6
// 🔴 Falla con: el portón de pruebas primero apagado sin renglón, o un renglón por cada edición.
test('T7 AtddPreedit_OffWritesOncePerSessionAndDay @story-8.256 @ac-6', () => {
  const st = tmp('es-atdd-');
  fs.mkdirSync(path.join(st, 'active'));
  for (const sid of ['s-uno', 's-dos']) fs.writeFileSync(path.join(st, 'active', `${sid}.json`), JSON.stringify({ storyId: '9.9', repoPath: st }));
  const antes = process.env.TYCON_ATDD_PREEDIT_GATE;
  process.env.TYCON_ATDD_PREEDIT_GATE = 'off';
  try {
    delete require.cache[require.resolve(ATDD)];
    const { handle } = require(ATDD);
    for (const sid of ['s-uno', 's-uno', 's-dos']) {
      assert.strictEqual(handle({ session_id: sid, tool_input: { file_path: path.join(st, 'a.js') } }, { stateDir: st }), null);
    }
  } finally { if (antes === undefined) delete process.env.TYCON_ATDD_PREEDIT_GATE; else process.env.TYCON_ATDD_PREEDIT_GATE = antes; }
  const lineas = fs.readFileSync(path.join(st, 'bypass.log'), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.deepStrictEqual(lineas.map((x) => `${x.kind}:${x.sessionId}`).sort(), ['ATDD_PREEDIT_GATE_OFF:s-dos', 'ATDD_PREEDIT_GATE_OFF:s-uno']);
  // seis procesos a la par con la misma sesión y la misma clave: un solo renglón (la marca se toma de una sola vez)
  const par = tmp('es-par-');
  const uno = `require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'env-switches.js'))}).anotarEscape({ stateDir: ${JSON.stringify(par)}, sessionId: 's-par', kind: 'ATDD_PREEDIT_GATE_OFF', variable: 'TYCON_ATDD_PREEDIT_GATE', unaVez: 'gate' })`;
  const guion = `const { spawn } = require('child_process'); let n = 0; for (let i = 0; i < 6; i++) spawn(process.execPath, ['-e', ${JSON.stringify(uno)}]).on('exit', () => { n++; });`;
  const r = spawnSync(process.execPath, ['-e', guion], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(par, 'bypass.log'), 'utf8').trim().split('\n').length, 1);
});

/**
 * Las skills en un clon aparte, como las instala el arnés en una máquina: sin `scripts/` al lado, y una HOME de juguete
 * con el enlace al arnés que deja el instalador (`~/.claude/tycon-harness`).
 */
function skillsAparte() {
  const d = tmp('es-aparte-');
  const salta = (src) => !/[\\/](tests|__tests__|node_modules)([\\/]|$)/.test(src);
  const scripts = path.join(d, 'agent-skills', 'skills', 'tycon-pipeline', 'scripts');
  fs.cpSync(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts'), scripts, { recursive: true, filter: salta });
  const home = path.join(d, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(ROOT, path.join(home, '.claude', 'tycon-harness'));
  return { scripts, home, env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_HOME: '' } };
}

// 🔴 Falla con: el freno de ATDD apagado, con las skills en un clon aparte, buscando la lista de variables en la ruta del
//    árbol unido: el require tira y el gancho se cae en vez de anotar el escape.
test('EnvSwitches_SkillsAparte_AtddAnotaElEscape', () => {
  const { scripts, env } = skillsAparte();
  const st = tmp('es-aparte-st-');
  fs.mkdirSync(path.join(st, 'active'));
  fs.writeFileSync(path.join(st, 'active', 's-ap.json'), JSON.stringify({ storyId: '9.9', repoPath: st }));
  const prog = `const { handle } = require(${JSON.stringify(path.join(scripts, 'on-atdd-preedit.js'))});
    process.stdout.write(JSON.stringify(handle({ session_id: 's-ap', tool_input: { file_path: ${JSON.stringify(path.join(st, 'a.js'))} } }, { stateDir: ${JSON.stringify(st)} })));`;
  const r = spawnSync(process.execPath, ['-e', prog], { encoding: 'utf8', env: { ...env, TYCON_ATDD_PREEDIT_GATE: 'off' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, 'null');
  assert.match(fs.readFileSync(path.join(st, 'bypass.log'), 'utf8'), /ATDD_PREEDIT_GATE_OFF/);
});

// 🔴 Falla con: la matriz por criterio con una escotilla puesta, en un clon aparte: el require de la ruta del árbol unido
//    tira y la matriz no se calcula.
test('EnvSwitches_SkillsAparte_MatrizAnotaLaEscotilla', () => {
  const { scripts, home, env } = skillsAparte();
  const repo = tmp('es-aparte-repo-');
  spawnSync('git', ['init', '-q', repo]);
  const story = path.join(repo, 'story-9.9-x.md');
  fs.writeFileSync(story, '---\nstory: 9.9\nstatus: in-progress\n---\n# x\n\n## Acceptance Criteria\n\n1. algo\n\n### Tests\n\n| # | Test | AC |\n|---|---|---|\n| T1 | `T1` | 1 |\n');
  const r = spawnSync(process.execPath, [path.join(scripts, 'runtime-matrix.js'), '--story', story, '--no-write'], { encoding: 'utf8', cwd: repo, env: { ...env, TYCON_RUNTIME_MATRIX_LEGACY: '1', CLAUDE_CODE_SESSION_ID: 's-mx' } });
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /Cannot find module/, r.stderr);
  const log = [path.join(home, '.tycon', 'state'), path.join(home, '.claude', '.tycon-pipeline')].map((x) => path.join(x, 'bypass.log')).find((f) => fs.existsSync(f));
  assert.ok(log, `no quedó bypass.log\n${r.stderr.slice(0, 600)}`);
  assert.match(fs.readFileSync(log, 'utf8'), /RUNTIME_MATRIX_LEGACY/);
});

/** Una copia del árbol del arnés (sin pruebas) para romperle la lista sin tocar el clon. */
function copiaSinLista() {
  const d = tmp('es-copia-');
  const salta = (src) => !/[\\/](tests|__tests__|controls-bench|fixtures|node_modules)([\\/]|$)/.test(src);
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(d, 'scripts'), { recursive: true, filter: salta });
  fs.cpSync(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts'), path.join(d, 'skills', 'tycon-pipeline', 'scripts'), { recursive: true, filter: salta });
  fs.renameSync(path.join(d, 'scripts', 'lib', 'env-switches.json'), path.join(d, 'scripts', 'lib', 'env-switches.json.aparte'));
  return d;
}

// T9 EnvSwitches_Unreadable_FailsClosedAndNightNotMeasured @story-8.256 @ac-8
// 🔴 Falla con: sin la lista, un apagado desconocido que pasa en la configuración, o la noche que da cero escapes.
test('T9 EnvSwitches_Unreadable_FailsClosedAndNightNotMeasured @story-8.256 @ac-8', () => {
  const d = copiaSinLista();
  const prog = `
    const CO = require(${JSON.stringify(path.join(d, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'controls-off.js'))});
    const R = require(${JSON.stringify(path.join(d, 'scripts', 'nightly', 'runs-review', 'rules.js'))});
    const motivos = CO.apagados({ env: {} }, { env: { TYCON_ANY: 'x' } });
    const r = R.revisar({ volcado: { archivedAt: '2026-11-16T10:00:00Z', marker: { storyId: '1.1', sessionId: 's', stepsCompleted: [], stepsPending: [], checks: {} } },
      lineasHilo: [], registros: { bypass: [], cobertura: { fuentes: { bypass: { estado: 'medido' } } } } });
    process.stdout.write(JSON.stringify({ apaga: CO.apaga('TYCON_ANY', 'x'), vacio: CO.apaga('TYCON_ANY', ''), motivos, escapes: r.escapes_registro }));`;
  const r = spawnSync(process.execPath, ['-e', prog], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.strictEqual(o.apaga, true);
  assert.strictEqual(o.vacio, false);
  assert.ok(o.motivos.some((x) => /no pude leer la lista de interruptores/.test(x)), o.motivos.join(' | '));
  assert.strictEqual(o.escapes, 'no_medido');
  // una lista que se lee pero trae una entrada mal armada cuenta como ilegible: no explota después
  const mala = path.join(tmp('es-mala-'), 'env-switches.json');
  fs.writeFileSync(mala, JSON.stringify({ entradas: [{ nombre: 'TYCON_ONE', lectores: [], lectura: 'entorno', proceso: 'agente', clase: 'kill-switch', firma: false, noche: true, en_configuracion: null }] }));
  const l = ES.leer({ ruta: mala });
  assert.strictEqual(l.ok, false);
  assert.match(l.error, /TYCON_ONE/);
});

// T10 Readers_BypassLogNotWritable_WarnAndGoOn @story-8.256 @ac-9
// 🔴 Falla con: un escape que no se pudo anotar tragado en silencio, o el lector que se traba por eso.
test('T10 Readers_BypassLogNotWritable_WarnAndGoOn @story-8.256 @ac-9', () => {
  const st = tmp('es-noescribe-');
  fs.mkdirSync(path.join(st, 'bypass.log'));
  const { valor, err } = conError(() => ES.anotarEscape({ stateDir: st, sessionId: 's', kind: 'STORY_REVIEW_OFF', variable: 'TYCON_STORY_REVIEW' }));
  assert.strictEqual(valor, false);
  assert.match(err, /no pude anotar el escape TYCON_STORY_REVIEW en bypass\.log \(.+\)/);
  // el lector sigue: el portón de pruebas primero devuelve lo de siempre
  fs.mkdirSync(path.join(st, 'active'));
  fs.writeFileSync(path.join(st, 'active', 's.json'), JSON.stringify({ storyId: '9.9', repoPath: st }));
  const antes = process.env.TYCON_ATDD_PREEDIT_GATE;
  process.env.TYCON_ATDD_PREEDIT_GATE = 'off';
  try {
    delete require.cache[require.resolve(ATDD)];
    const { handle } = require(ATDD);
    const r = conError(() => handle({ session_id: 's', tool_input: { file_path: path.join(st, 'a.js') } }, { stateDir: st }));
    assert.strictEqual(r.valor, null);
    assert.match(r.err, /no pude anotar el escape TYCON_ATDD_PREEDIT_GATE en bypass\.log/);
  } finally { if (antes === undefined) delete process.env.TYCON_ATDD_PREEDIT_GATE; else process.env.TYCON_ATDD_PREEDIT_GATE = antes; }
});
