'use strict';
/**
 * git-language.test.js — el arnés entiende a git en cualquier idioma.
 *
 * El arnés reconoce varios errores de git por su texto en inglés, y git los traduce según el idioma de la máquina. En
 * una Mac con git en castellano el ok de guardar no salió: `raizDe` esperaba «not a git repository» y git dijo «no es
 * un repositorio git». El idioma de git se fija en un solo lugar, `idiomaFijo` de scripts/lib/clean-git-env.js, y una
 * lista (git-language-inventory.js) avisa si aparece un script que compara una frase sin usarla.
 *
 * El git de Apple no trae traducciones: con LANG=es_AR sigue en inglés. Por eso las pruebas de punta a punta usan un git
 * sustituto (fixtures/git-in-spanish/git) que contesta en castellano salvo con idioma C. Es un guion de shell: en
 * Windows Node no lo lanza desde el PATH, y T4 y T5 se saltean (lo cubre T8); T3 lo corre con bash.
 *
 * Correr:  node --test scripts/tests/git-language.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { idiomaFijo, IDIOMA_DE_GIT, sinGitDelPadre } = require('../lib/clean-git-env.js');
const INV = require('./git-language-inventory.js');

const REPO = path.resolve(__dirname, '..', '..');
const SUSTITUTO_DIR = path.join(__dirname, 'fixtures', 'git-in-spanish');
const SUSTITUTO = path.join(SUSTITUTO_DIR, 'git');
const WINDOWS = process.platform === 'win32';
const SIN_SUSTITUTO = WINDOWS ? 'el git sustituto no corre en Windows: lo cubre T8' : false;

/** La ruta del git de verdad, buscada en el PATH (sin el sustituto). */
function gitDeVerdad() {
  const nombres = WINDOWS ? ['git.exe', 'git.cmd'] : ['git'];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir || path.resolve(dir) === SUSTITUTO_DIR) continue;
    for (const n of nombres) {
      const p = path.join(dir, n);
      try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch (_) { /* sigo */ }
    }
  }
  throw new Error('no encontré git en el PATH');
}
const GIT = gitDeVerdad();

/** El entorno de partida, sin idioma ni las variables de un hook de git ni el canal de `node --test`. */
function entornoLimpio(extra = {}) {
  const env = sinGitDelPadre();
  for (const k of ['LC_ALL', 'LC_MESSAGES', 'LANGUAGE', 'LANG', 'NODE_TEST_CONTEXT']) delete env[k];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, ...extra };
}
/** Con el sustituto primero en el PATH y git en castellano (o en C, con `idioma: 'C'`). */
function entornoSustituto({ idioma = 'castellano', extra = {} } = {}) {
  const env = entornoLimpio({ GIT_DE_VERDAD: GIT, PATH: `${SUSTITUTO_DIR}${path.delimiter}${process.env.PATH || ''}`, LANG: 'es_AR.UTF-8', ...extra });
  if (idioma === 'C') env.LC_ALL = 'C';
  return env;
}

function tmp(t, prefijo) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefijo)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
// un autor con correo `noreply` de GitHub: el freno de empujes de T11 no lo cuenta como hallazgo
const QUIEN = { name: 'Mantenedor De Prueba', email: '4242+mantenedor@users.noreply.github.com' };
// fecha fija y sin el mantenimiento automático de git: los commits del laboratorio salen iguales en cada corrida
const FECHA = '2026-01-01T00:00:00Z';
function git(cwd, args) {
  const r = spawnSync(GIT, ['-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8', env: entornoLimpio({
    LC_ALL: 'C', GIT_AUTHOR_NAME: QUIEN.name, GIT_AUTHOR_EMAIL: QUIEN.email, GIT_COMMITTER_NAME: QUIEN.name,
    GIT_COMMITTER_EMAIL: QUIEN.email, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA,
  }) });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} salió ${r.status}: ${r.stderr}`);
  return String(r.stdout).trim();
}
function escribir(dir, rel, contenido) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), contenido);
}

/**
 * Lo que dice el git del PATH fuera de un repo, con el entorno del sustituto. Si no dice «no es un repositorio git»,
 * el sustituto no está en el PATH o no es ejecutable, y la prueba que lo usa no puede dar verde con el git de verdad.
 */
function dichoFueraDeUnRepo(t, idioma) {
  const d = tmp(t, 'git-idioma-suelto-');
  const env = entornoSustituto({ idioma, extra: { GIT_CEILING_DIRECTORIES: path.dirname(d) } });
  const r = WINDOWS
    ? spawnSync('bash', [SUSTITUTO, 'rev-parse', '--show-toplevel'], { cwd: d, encoding: 'utf8', env })
    : spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: d, encoding: 'utf8', env });
  return `${r.stderr || ''}${r.error ? r.error.message : ''}`;
}
function exigirSustituto(t) {
  const dicho = dichoFueraDeUnRepo(t, 'castellano');
  assert.match(dicho, /no es un repositorio git/,
    `el git sustituto (${path.relative(REPO, SUSTITUTO)}) no habla castellano: no está en el PATH o no es ejecutable. Dijo: ${dicho.trim()}`);
}

test('T1 IdiomaFijo_PisaElIdiomaYNoCambiaLaBase', () => {
  const base = { LANG: 'es_AR.UTF-8', LC_ALL: 'es_AR.UTF-8', LC_MESSAGES: 'es_AR.UTF-8', LANGUAGE: 'es', PROPIA: 'sí' };
  const antes = { ...base };
  const env = idiomaFijo(base, { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'es_AR' }, null, undefined);
  assert.strictEqual(env.LC_ALL, 'C');
  assert.strictEqual(env.LANG, 'C');
  assert.ok(!('LANGUAGE' in env), 'LANGUAGE tiene que salir');
  assert.ok(!('LC_MESSAGES' in env), 'LC_MESSAGES tiene que salir');
  assert.strictEqual(env.GIT_TERMINAL_PROMPT, '0');
  assert.strictEqual(env.PROPIA, 'sí');
  assert.deepStrictEqual(base, antes, 'la base no cambia');
  assert.notStrictEqual(env, base, 'devuelve una copia');
});

test('T2 IdiomaFijo_SinBaseParteDelEntorno', (t) => {
  const previa = process.env.GIT_LANGUAGE_T2;
  process.env.GIT_LANGUAGE_T2 = 'propia';
  t.after(() => { if (previa === undefined) delete process.env.GIT_LANGUAGE_T2; else process.env.GIT_LANGUAGE_T2 = previa; });
  for (const base of [undefined, null]) {
    const env = base === undefined ? idiomaFijo() : idiomaFijo(base);
    assert.strictEqual(env.GIT_LANGUAGE_T2, 'propia', `sin base (${base}) parte de process.env`);
    assert.strictEqual(env.LC_ALL, 'C');
    assert.strictEqual(env.LANG, 'C');
  }
  assert.ok(Object.isFrozen(IDIOMA_DE_GIT), 'IDIOMA_DE_GIT congelado');
  assert.deepStrictEqual({ ...IDIOMA_DE_GIT }, { LC_ALL: 'C', LANG: 'C' });
});

test('T3 GitSustituto_HablaCastellanoSalvoConC', (t) => {
  exigirSustituto(t);
  assert.match(dichoFueraDeUnRepo(t, 'C'), /not a git repository/, 'con idioma C el sustituto contesta en inglés');
});

test('T4 RaizDe_CarpetaSuelta_GitEnCastellano_DaNull', { skip: SIN_SUSTITUTO }, (t) => {
  exigirSustituto(t);
  const d = tmp(t, 'git-idioma-raiz-');
  const codigo = `const s = require(${JSON.stringify(path.join(REPO, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'save-ok.js'))});
console.log(JSON.stringify(s.raizDe(${JSON.stringify(path.join(d, 'x.txt'))})));`;
  const r = spawnSync(process.execPath, ['-e', codigo], { encoding: 'utf8', env: entornoSustituto({ extra: { GIT_CEILING_DIRECTORIES: path.dirname(d) } }) });
  assert.strictEqual(r.status, 0, `raizDe tiró con git en castellano:\n${r.stderr}`);
  assert.strictEqual(r.stdout.trim(), 'null');
});

test('T5 PendientesStaged_SinRegistro_IgualQueEnIngles', { skip: SIN_SUSTITUTO }, (t) => {
  exigirSustituto(t);
  const repo = tmp(t, 'git-idioma-pendientes-');
  const home = tmp(t, 'git-idioma-home-');
  git(repo, ['init', '-q', '-b', 'main']);
  escribir(repo, 'LEEME.md', 'un repo de juguete\n');
  git(repo, ['add', 'LEEME.md']);
  git(repo, ['commit', '-q', '-m', 'base']);
  escribir(repo, 'tasks/todo.md', '- [ ] algo\n');
  git(repo, ['add', 'tasks/todo.md']);
  const correr = (idioma) => {
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'ci', 'check-pending-approvals.js'), '--staged', '--repo', repo], {
      encoding: 'utf8', env: entornoSustituto({ idioma, extra: { HOME: home, USERPROFILE: home } }),
    });
    return { status: r.status, salida: `${r.stdout}${r.stderr}`.split(repo).join('<repo>') };
  };
  const enC = correr('C');
  const enCastellano = correr('castellano');
  assert.strictEqual(enC.status, 1, `con git en inglés tenía que encontrar el pendiente sin aprobar (1):\n${enC.salida}`);
  assert.deepStrictEqual(enCastellano, enC, 'con git en castellano tiene que dar lo mismo que en inglés');
});

test('T6 CleanGitEnv_SinDependencias', (t) => {
  const d = tmp(t, 'git-idioma-sola-');
  fs.copyFileSync(path.join(REPO, 'scripts', 'lib', 'clean-git-env.js'), path.join(d, 'clean-git-env.js'));
  const codigo = `const L = require(${JSON.stringify(path.join(d, 'clean-git-env.js'))});
console.log(JSON.stringify({ fija: L.idiomaFijo().LC_ALL, padre: L.sinGitDelPadre({ X: '1' }) }));`;
  const r = spawnSync(process.execPath, ['-e', codigo], { cwd: d, encoding: 'utf8', env: entornoLimpio({ LANG: 'es_AR.UTF-8' }) });
  assert.strictEqual(r.status, 0, `clean-git-env.js sola no carga:\n${r.stderr}`);
  const o = JSON.parse(r.stdout);
  assert.strictEqual(o.fija, 'C');
  assert.strictEqual(o.padre.X, '1');
  assert.strictEqual(o.padre.LANG, 'es_AR.UTF-8', 'sinGitDelPadre no toca el idioma');
  assert.ok(!('LC_ALL' in o.padre), 'sinGitDelPadre no agrega LC_ALL');
});

test('T7 Inventario_DetectaLosCasosArmados', (t) => {
  const d = tmp(t, 'git-idioma-inventario-');
  git(d, ['init', '-q', '-b', 'main']);
  escribir(d, 'scripts/a.js', [
    "const { spawnSync } = require('child_process');",
    "const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });",
    'if (/not a git repository/i.test(r.stderr)) console.log(null);',
    '',
  ].join('\n'));
  escribir(d, 'scripts/b.js', [
    "const { spawnSync } = require('child_process');",
    "spawnSync('git', ['status'], { env: { ...process.env, LC_ALL: 'C' } });",
    '',
  ].join('\n'));
  escribir(d, 'scripts/c.js', [
    "const { spawnSync } = require('child_process');",
    "const { idiomaFijo } = require('./lib/clean-git-env.js');",
    "const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', env: idiomaFijo() });",
    'if (/not a git repository/i.test(r.stderr)) console.log(null);',
    '',
  ].join('\n'));
  // los que encontró el pase adversarial: git en un guion de shell, git en un comando de texto, la función nombrada sólo
  // en un comentario, y comentarios de bloque (con la frase adentro, o con código después en la misma línea)
  escribir(d, 'scripts/e.sh', [
    '#!/bin/sh',
    '# llamá a git con idiomaFijo, dice un comentario',
    'if git -C "$1" rev-parse 2>&1 | grep -q "not a git repository"; then exit 0; fi',
    '',
  ].join('\n'));
  escribir(d, 'scripts/f.js', [
    "const { execSync } = require('child_process');",
    'try { execSync(`git -C ${process.argv[2]} rev-parse`); } catch (e) {',
    '  if (/not a git repository/.test(String(e.stderr))) process.exit(0);',
    '}',
    '',
  ].join('\n'));
  escribir(d, 'scripts/g.js', [
    '// usar IDIOMA_DE_GIT acá algún día, o idiomaFijo()',
    "const r = require('child_process').spawnSync('git', ['rev-parse'], { encoding: 'utf8' });",
    'if (/not a git repository/.test(r.stderr)) process.exit(0);',
    '',
  ].join('\n'));
  escribir(d, 'scripts/h.js', [
    "const r = require('child_process').spawnSync('git', ['status'], { encoding: 'utf8' });",
    '/*',
    '   antes fallaba con "not a git repository": ya no se lee ese error',
    '*/',
    'console.log(r.status);',
    '',
  ].join('\n'));
  escribir(d, 'scripts/i.js', [
    "const r = require('child_process').spawnSync('git', ['status'], { encoding: 'utf8' });",
    '/* lo de git */ if (/not a git repository/.test(r.stderr)) process.exit(0);',
    '',
  ].join('\n'));
  escribir(d, 'scripts/j.js', [
    "function d(k) { switch (k) { case 'LC_ALL': return 'idioma'; default: return k; } }",
    "module.exports = { d, otro: (k) => (k ? 'LC_ALL' : 'LANG') };",
    '',
  ].join('\n'));
  // los del segundo pase: un `/*` dentro de una expresión regular o de un texto de varias líneas no abre un comentario,
  // y en shell lo que va después de un `#` no cuenta (un LC_ALL=C escrito en el comentario no fija nada)
  escribir(d, 'scripts/k.js', [
    "const limpio = (p) => p.replace(/\\/*$/, '');",
    "const r = require('child_process').spawnSync('git', ['rev-parse'], { encoding: 'utf8' });",
    'if (/not a git repository/.test(r.stderr)) process.exit(limpio("x"));',
    '',
  ].join('\n'));
  escribir(d, 'scripts/l.js', [
    'const AYUDA = `uso: l.js',
    '  borra los temporales de tmp/*.json`;',
    "const r = require('child_process').spawnSync('git', ['rev-parse'], { encoding: 'utf8' });",
    'if (/not a git repository/.test(r.stderr)) console.log(AYUDA);',
    '',
  ].join('\n'));
  escribir(d, 'scripts/m.sh', [
    '#!/bin/sh',
    'git -C "$1" rev-parse 2>&1 | grep -q "not a git repository" && exit 0   # con LC_ALL=C',
    '',
  ].join('\n'));
  // los del tercer pase: git como método de otro módulo o encadenado en un comando de texto; la constante sólo traída en
  // el require; un LC_ALL=C de sort en shell; LC_ALL asignado o como clave calculada; un texto entre acentos graves
  // dentro del `${…}` de otro (con la frase en un comentario después, o con un `/*` de texto antes de la llamada)
  escribir(d, 'scripts/n.js', [
    "const SRC = require('./fuentes.js');",
    "const r = SRC.git(process.cwd(), ['rev-parse', '--show-toplevel']);",
    'if (!r.ok && /not a git repository/i.test(r.err)) process.exit(0);',
    '',
  ].join('\n'));
  escribir(d, 'scripts/o.js', [
    "const { execSync } = require('child_process');",
    "try { execSync('cd ' + process.argv[2] + ' && git rev-parse --show-toplevel'); } catch (e) {",
    '  if (/not a git repository/i.test(String(e.stderr))) process.exit(0);',
    '}',
    '',
  ].join('\n'));
  escribir(d, 'scripts/p.js', [
    "const { IDIOMA_DE_GIT } = require('./lib/clean-git-env.js');",
    "const r = require('child_process').spawnSync('git', ['show', 'x'], { encoding: 'utf8' });",
    'if (/does not exist/.test(r.stderr)) process.exit(0);',
    '',
  ].join('\n'));
  escribir(d, 'scripts/q.sh', [
    '#!/bin/sh',
    'LC_ALL=C sort "$1" > /dev/null',
    'if git show x 2>&1 | grep -q "does not exist"; then exit 0; fi',
    '',
  ].join('\n'));
  escribir(d, 'scripts/r.js', [
    'const env = Object.assign({}, process.env);',
    "env.LC_ALL = 'C';",
    "module.exports = { env, igual: env.LC_ALL === 'C' };",
    '',
  ].join('\n'));
  escribir(d, 'scripts/s.js', [
    "module.exports = { ...process.env, ['LC_ALL']: 'C' };",
    '',
  ].join('\n'));
  escribir(d, 'scripts/t.js', [
    "const q = (s) => `'${s.replace(/'/g, `'\\\\''`)}'`;",
    'const glob = `src/*.js`;',
    "const r = require('child_process').spawnSync('git', ['status'], { encoding: 'utf8' });",
    'if (/not a git repository/.test(r.stderr)) console.log(q(glob));',
    '',
  ].join('\n'));
  escribir(d, 'scripts/u.js', [
    "const q = (s) => `'${s.replace(/'/g, `'\\\\''`)}'`;",
    '// si git dice not a git repository, da igual',
    "require('child_process').execFileSync('git', ['status']);",
    'module.exports = q;',
    '',
  ].join('\n'));
  escribir(d, 'scripts/v.sh', [
    '#!/bin/sh',
    'if LC_ALL=C GIT_PAGER=cat git show x 2>&1 | grep -q "does not exist"; then exit 0; fi',
    '',
  ].join('\n'));
  git(d, ['add', '-A']);
  const r = INV.revisar(d, { excepciones: { 'scripts/d.js': 'una excepción que ya no existe' } });
  assert.deepStrictEqual(r.sinFijar, [
    { archivo: 'scripts/a.js', linea: 3 }, { archivo: 'scripts/e.sh', linea: 3 }, { archivo: 'scripts/f.js', linea: 3 },
    { archivo: 'scripts/g.js', linea: 3 }, { archivo: 'scripts/i.js', linea: 2 }, { archivo: 'scripts/k.js', linea: 3 },
    { archivo: 'scripts/l.js', linea: 4 }, { archivo: 'scripts/m.sh', linea: 2 }, { archivo: 'scripts/n.js', linea: 3 },
    { archivo: 'scripts/o.js', linea: 3 }, { archivo: 'scripts/p.js', linea: 3 }, { archivo: 'scripts/q.sh', linea: 3 },
    { archivo: 'scripts/t.js', linea: 4 },
  ]);
  assert.ok(r.leen.some((l) => l.archivo === 'scripts/v.sh' && l.fija), 'LC_ALL=C puesto a git, con otra variable en el medio, fija');
  assert.ok(!r.leen.some((l) => l.archivo === 'scripts/u.js'), 'la frase sólo en un comentario no es leer palabras de git');
  assert.deepStrictEqual(r.aMano, [
    { archivo: 'scripts/b.js', linea: 2 }, { archivo: 'scripts/r.js', linea: 2 }, { archivo: 'scripts/s.js', linea: 1 },
  ]);
  assert.deepStrictEqual(r.excepcionesMuertas, ['scripts/d.js']);
  const dicho = INV.explicar(r).join('\n');
  assert.match(dicho, /scripts\/a\.js:3: .*llamá a git con idiomaFijo de scripts\/lib\/clean-git-env\.js/);
  assert.match(dicho, /scripts\/b\.js:2: escribe LC_ALL a mano/);
  assert.match(dicho, /scripts\/d\.js: está en EXCEPCIONES/);
  assert.ok(!/scripts\/c\.js/.test(dicho), 'el que usa la función no se marca');
  // suelto: mide y sale 0 aunque haya alguno sin fijar
  const suelto = spawnSync(process.execPath, [path.join(__dirname, 'git-language-inventory.js'), d], { encoding: 'utf8', env: entornoLimpio() });
  assert.strictEqual(suelto.status, 0, suelto.stderr);
  assert.match(suelto.stdout, /^NO fija\s+scripts\/a\.js$/m);
  assert.match(suelto.stdout, /^fija\s+scripts\/c\.js$/m);
});

test('T8 Inventario_ElArnesNoTieneNinguno', (t) => {
  if (!fs.existsSync(path.join(REPO, '.git'))) { t.skip('una copia sin .git: no hay lista de archivos de git que medir'); return; }
  const r = INV.revisar(REPO);
  const dicho = INV.explicar(r).join('\n');
  assert.deepStrictEqual(r.sinFijar, [], dicho);
  assert.deepStrictEqual(r.aMano, [], dicho);
  assert.deepStrictEqual(r.excepcionesMuertas, [], dicho);
  const copia = 'scripts/production/guard-libs/lib/legacy-names.js';
  assert.ok(Object.prototype.hasOwnProperty.call(INV.EXCEPCIONES, copia), 'la copia del freno de producción está en EXCEPCIONES');
  assert.match(fs.readFileSync(path.join(REPO, copia), 'utf8'), /LC_ALL: 'C'/, 'la copia del freno de producción sigue con su idioma propio');
  // los casos del banco que copian suelto un guion que carga la biblioteca la copian también: sin ella el guion calla,
  // frena o dice «git no contestó», y el caso mide otra cosa (lo encontró el pase adversarial en el aviso de engram)
  const sinBiblioteca = casosDelBancoSinLaBiblioteca(path.join(REPO, 'scripts', 'controls-bench', 'cases'));
  assert.deepStrictEqual(sinBiblioteca, [], `casos del banco que copian un guion sin scripts/lib/clean-git-env.js:\n${sinBiblioteca.join('\n')}`);
});

// no necesitan la copia: retro-pending.js la carga sólo si está y sin ella hace lo mismo; legacy-names.js la carga sólo
// en `gitAt` (la medición de usos de los nombres viejos), que ningún gancho llama
const CARGA_OPCIONAL = new Set(['scripts/hooks/retro-pending.js', 'scripts/lib/legacy-names.js']);
/** Los pasos de preparación del banco que copian un guion que carga clean-git-env.js sin copiar la biblioteca. */
function casosDelBancoSinLaBiblioteca(dir) {
  const fuera = [];
  const cargaLaBiblioteca = new Map();
  const carga = (rel) => {
    if (!cargaLaBiblioteca.has(rel)) {
      let txt = '';
      try { txt = fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch (e) {
        if (!e || e.code !== 'ENOENT') throw e;   // sólo «no está» es «no carga nada»: no poder leerlo no es medir
      }
      cargaLaBiblioteca.set(rel, !CARGA_OPCIONAL.has(rel) && /clean-git-env\.js/.test(txt));
    }
    return cargaLaBiblioteca.get(rel);
  };
  const recorrer = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { recorrer(p); continue; }
      if (!e.name.endsWith('.json')) continue;
      const lineas = fs.readFileSync(p, 'utf8').split('\n');
      lineas.forEach((l, i) => {
        if (/\$TCG\/scripts\/lib\/clean-git-env\.js|cp -R \$TCG\/scripts\/lib\b|cp -R \$TCG\/scripts\b/.test(l)) return;
        // sólo lo que un `cp` copia (el último argumento es el destino); un guion que se corre en su lugar tiene su lib/
        const copiados = l.split(/&&|;|\\n/).filter((c) => /^\s*cp\s/.test(c))
          .flatMap((c) => [...c.matchAll(/\$TCG\/((?:scripts|skills)\/[\w./-]+\.js)\b/g)].map((m) => m[1]));
        const malos = copiados.filter(carga);
        if (malos.length) fuera.push(`${path.relative(REPO, p)}:${i + 1}: ${malos.join(', ')}`);
      });
    }
  };
  recorrer(dir);
  return fuera;
}

test('T10 GanchosDeAviso_SinLaBiblioteca_NoSeCaen', (t) => {
  const arbol = tmp(t, 'git-idioma-ganchos-');
  const home = tmp(t, 'git-idioma-ganchos-home-');
  for (const g of ['branch-guard-notice.js', 'dev-behind-main-notice.js']) {
    fs.mkdirSync(path.join(arbol, 'scripts', 'hooks'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'scripts', 'hooks', g), path.join(arbol, 'scripts', 'hooks', g));
  }
  // el árbol es un clon fuera de main: con git a mano, el aviso de rama lo diría
  git(arbol, ['init', '-q', '-b', 'otra']);
  git(arbol, ['add', '-A']);
  git(arbol, ['commit', '-q', '-m', 'base']);
  const registro = path.join(home, 'llamadas-a-git.txt');
  const extra = { HOME: home, USERPROFILE: home, ...(WINDOWS ? {} : { GIT_SUSTITUTO_LOG: registro }) };
  for (const g of ['branch-guard-notice.js', 'dev-behind-main-notice.js']) {
    const r = spawnSync(process.execPath, [path.join(arbol, 'scripts', 'hooks', g)], {
      cwd: arbol, input: JSON.stringify({ cwd: arbol, hook_event_name: 'SessionStart' }), encoding: 'utf8',
      env: WINDOWS ? entornoLimpio(extra) : entornoSustituto({ extra }),
    });
    assert.strictEqual(r.status, 0, `${g} salió ${r.status}:\n${r.stderr}`);
    assert.ok(!/Error|\n\s+at /.test(r.stderr), `${g} dejó una traza:\n${r.stderr}`);
    assert.strictEqual(r.stdout.trim(), '', `${g} avisó sin poder fijar el idioma de git:\n${r.stdout}`);
  }
  if (!WINDOWS && fs.existsSync(registro)) {
    const sinIdioma = fs.readFileSync(registro, 'utf8').split('\n').filter(Boolean).filter((l) => !/^(?:C|C\..*|POSIX)\t/.test(l));
    assert.deepStrictEqual(sinIdioma, [], 'un gancho lanzó git sin el idioma fijo');
  }
  // el control: con la biblioteca al lado, el mismo árbol sí avisa (el silencio de arriba es por la biblioteca)
  fs.mkdirSync(path.join(arbol, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'scripts', 'lib', 'clean-git-env.js'), path.join(arbol, 'scripts', 'lib', 'clean-git-env.js'));
  const conBiblioteca = spawnSync(process.execPath, [path.join(arbol, 'scripts', 'hooks', 'branch-guard-notice.js')], {
    cwd: arbol, input: JSON.stringify({ cwd: arbol, hook_event_name: 'SessionStart' }), encoding: 'utf8',
    env: WINDOWS ? entornoLimpio(extra) : entornoSustituto({ extra }),
  });
  assert.strictEqual(conBiblioteca.status, 0, conBiblioteca.stderr);
  assert.notStrictEqual(conBiblioteca.stdout.trim(), '', `con la biblioteca, el aviso de rama tenía que hablar:\n${conBiblioteca.stderr}`);
});

// lo que el freno de empujes necesita para correr, sin clean-git-env.js (como el laboratorio de public-push-guard.test.js)
const PIEZAS_DEL_FRENO = ['scripts/hooks/public-push-guard.js', 'scripts/lib/az-pr.js', 'scripts/lib/gh-pr.js', 'scripts/lib/harness-repo.js',
  'scripts/lib/legacy-names.js', 'scripts/lib/guard-record.js', 'scripts/publishing/detector.js', 'scripts/setup/harness/tycon-home.js',
  'scripts/publishing/internal-history.js'];

test('T11 FrenoDeEmpujes_SinLaBiblioteca_Frena', (t) => {
  const root = tmp(t, 'git-idioma-freno-');
  const arnes = path.join(root, 'arnes');
  for (const p of PIEZAS_DEL_FRENO) {
    fs.mkdirSync(path.dirname(path.join(arnes, p)), { recursive: true });
    fs.copyFileSync(path.join(REPO, p), path.join(arnes, p));
  }
  assert.ok(!fs.existsSync(path.join(arnes, 'scripts', 'lib', 'clean-git-env.js')));
  fs.writeFileSync(path.join(arnes, 'perfil-equipo.json'), '{}\n');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.tycon'), { recursive: true });
  const publico = path.join(root, 'publico');
  const remoto = path.join(publico, 'remoto.git');
  fs.mkdirSync(publico);
  git(root, ['init', '-q', '--bare', '-b', 'main', remoto]);
  const trabajo = path.join(root, 'trabajo');
  git(root, ['init', '-q', '-b', 'main', trabajo]);
  escribir(trabajo, 'scripts/install-tycon-hooks.sh', '#!/bin/sh\n');
  escribir(trabajo, 'README.md', 'un repo de juguete\n');
  git(trabajo, ['add', '-A']);
  git(trabajo, ['commit', '-q', '-m', 'base']);
  git(trabajo, ['remote', 'add', 'origin', remoto]);
  git(trabajo, ['push', '-q', 'origin', 'main']);
  escribir(trabajo, 'nuevo.md', 'un cambio\n');
  git(trabajo, ['add', '-A']);
  git(trabajo, ['commit', '-q', '-m', 'un cambio']);
  const sha = git(trabajo, ['rev-parse', 'HEAD']);
  const lista = path.join(root, 'lista.json');
  fs.writeFileSync(lista, `${JSON.stringify({ terminos: [{ patron: 'acme-secreto', categoria: 'cliente' }], permitidos: [] })}\n`);
  const r = spawnSync(process.execPath, [path.join(arnes, 'scripts/hooks/public-push-guard.js'), 'pre-push', 'origin', remoto, '--json'], {
    cwd: trabajo, input: `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`, encoding: 'utf8',
    env: entornoLimpio({ HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon'), GIT_ALLOW_PROTOCOL: 'file',
      TYCON_PUBLIC_PUSH_TREAT_AS_PUBLIC: publico, TYCON_PUBLISH_DENYLIST: lista }),
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { json = null; }
  assert.strictEqual(r.status, 2, `sin la biblioteca el freno tenía que frenar sin mirar (2), salió ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.strictEqual(json && json.verdict, 'blind', r.stdout);
  // por la biblioteca, no por otro «no pude…» del freno
  assert.match(String(json.reason), /no pude cargar scripts\/lib\/clean-git-env\.js/);
});
