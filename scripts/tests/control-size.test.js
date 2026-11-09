#!/usr/bin/env node
'use strict';
// control-size.test.js — el tamaño de los controles y el aviso que no frena (scripts/ci/control-size.js).
//
// Cada prueba arma un árbol de juguete en una carpeta temporal, con su propio `git init`, y corre el guion como
// proceso aparte. stable-data: no lee el reloj; los commits de los repos de prueba llevan fechas fijas.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'scripts', 'ci', 'control-size.js');
const REAL_GATE = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'on-bash-write-gate.js');

const temporales = [];
after(() => {
  for (const d of temporales) {
    try { fs.chmodSync(path.join(d, 'scripts', 'ci', 'cerrado.js'), 0o644); } catch { /* no estaba */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: 'prueba', GIT_AUTHOR_EMAIL: 'prueba@example.com', GIT_COMMITTER_NAME: 'prueba', GIT_COMMITTER_EMAIL: 'prueba@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete GIT_ENV[k];

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { env: GIT_ENV, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Un árbol de juguete: `{ 'ruta': 'texto' }`, con git y todo agregado al índice. */
function arbol(archivos) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'control-size-')));
  temporales.push(d);
  for (const [rel, texto] of Object.entries(archivos)) escribir(d, rel, texto);
  git(d, 'init', '-q');
  git(d, 'add', '-A');
  return d;
}
function escribir(d, rel, texto) {
  fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
  fs.writeFileSync(path.join(d, rel), texto);
}
/** Un texto de exactamente `n` letras que empieza con `cabeza`. */
const relleno = (cabeza, n) => cabeza + '\n' + '/'.repeat(n - cabeza.length - 1);

function correr(root, ...args) {
  const r = spawnSync(process.execPath, [TOOL, '--root', root, ...args], { env: GIT_ENV, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function datos(root, ...args) {
  const r = correr(root, '--json', ...args);
  assert.strictEqual(r.code, 0, `sale 0 (salió ${r.code}): ${r.err}`);
  return JSON.parse(r.out);
}
const control = (j, ruta) => j.controles.find((c) => c.ruta === ruta);

const PIPE = 'skills/tycon-pipeline/scripts';
// un freno de juguete con la forma del real: los dos cortes dentro de guionesEnArchivo
const FRENO = (niveles, modulos) => [
  'function guionesEnArchivo(cmd) {',
  '  const agregar = (real, hondo = 0) => {',
  `    if (hondo > 0 && modulos[cuenta]++ >= ${modulos}) return;`,
  `    if (hondo >= ${niveles}) return;`,
  '  };',
  '}',
  'function otra() { return hondo >= 9; }',
  '',
].join('\n');

test('T1 ControlSize_ListsBySize — @story-8.163 @ac-1: de mayor a menor, con letras, subcomandos y quién los llama', () => {
  const root = arbol({
    [`${PIPE}/grande.js`]: relleno("const cmd = process.argv[2];\nswitch (cmd) { case 'a': break; case 'b': break; }", 3000),
    // dentro de una función, `$1` es el argumento de la función, no el subcomando del guion: no cuenta
    'scripts/ci/mediano.sh': relleno('ayuda() {\n  case "$1" in\n    otra) ;;\n  esac\n}\ncase "$1" in\n  uno) ;;\n  dos|tres) ;;\n  *) ;;\nesac', 2000),
    // un gancho que usa `cmd` para otra cosa: no es su subcomando
    'scripts/hooks/chico.js': relleno("const cmd = leerEvento().command;\nif (cmd === 'git') salir();\nswitch (cmd) { case 'rm': break; }", 1000),
    'scripts/hooks/chico.test.js': '// una prueba no es un control\n',
    'scripts/ci/lib/ayudante.js': '// una biblioteca en una subcarpeta no es un control\n',
    [`${PIPE}/tests/otra.test.js`]: '// tampoco\n',
    // quién llama: un .json cuenta; un .md, una prueba y un nombre más largo que lo contiene, no
    'config/hooks.json': '{ "command": "node scripts/hooks/chico.js" }\n',
    'README.md': 'chico.js y grande.js\n',
    'tests/algo.test.js': "require('../scripts/hooks/chico.js'); // grande.js\n",
    'otra/lista.json': '["on-grande.js", "grande.json"]\n',
  });
  const j = datos(root);
  assert.deepStrictEqual(j.controles.map((c) => c.ruta), [`${PIPE}/grande.js`, 'scripts/ci/mediano.sh', 'scripts/hooks/chico.js']);
  assert.deepStrictEqual(j.controles.map((c) => c.letras), [3000, 2000, 1000]);
  assert.strictEqual(control(j, `${PIPE}/grande.js`).subcomandos, 2);
  assert.strictEqual(control(j, 'scripts/ci/mediano.sh').subcomandos, 3);
  assert.strictEqual(control(j, 'scripts/hooks/chico.js').subcomandos, null, 'sin subcomando leído de los argumentos: «—», no 0');
  assert.strictEqual(control(j, 'scripts/hooks/chico.js').llamadores, 1);
  assert.strictEqual(control(j, `${PIPE}/grande.js`).llamadores, 0);
  assert.deepStrictEqual(j.no_medidos, []);
  // la salida de texto dice lo mismo, con «—» y la aclaración de que la cuenta es aproximada
  const r = correr(root);
  assert.strictEqual(r.code, 0);
  const filas = r.out.split('\n').filter((l) => /\.(js|sh)\s*$/.test(l));
  assert.deepStrictEqual(filas.map((l) => l.trim().split(/\s+/).pop()), [`${PIPE}/grande.js`, 'scripts/ci/mediano.sh', 'scripts/hooks/chico.js']);
  assert.match(filas[2], /—/);
  assert.match(r.out, /aproximad/);
  assert.doesNotMatch(r.out, /chico\.test\.js|ayudante\.js|otra\.test\.js/);
});

test('T2 ControlSize_OverLimit_WarnsNotBlocks — @story-8.163 @ac-2: avisa por tamaño y por recorrido, y sale 0', () => {
  const root = arbol({
    'scripts/ci/enorme.js': relleno('// un control enorme', 95000),
    [`${PIPE}/on-bash-write-gate.js`]: FRENO(2, 4),
    // un despachador que carga cuatro módulos en tres niveles: pasa el umbral (4 × 0,75 = 3 módulos; 2 × 0,75 = 1,5 niveles)
    [`${PIPE}/marker.js`]: "require('./lib/m1.js');\n",
    [`${PIPE}/lib/m1.js`]: "require('./m2.js'); require('./m3');\n",
    [`${PIPE}/lib/m2.js`]: "require('./m4.js');\n",
    [`${PIPE}/lib/m3.js`]: '',
    [`${PIPE}/lib/m4.js`]: '',
    // otro despachador con un solo módulo: no avisa
    [`${PIPE}/pipeline.js`]: "require('./lib/m3.js');\n",
  });
  const j = datos(root);
  assert.deepStrictEqual(j.recorrido.tope, { niveles: 2, modulos: 4 });
  const marker = j.recorrido.despachadores.find((x) => x.ruta === `${PIPE}/marker.js`);
  assert.deepStrictEqual({ modulos: marker.modulos, niveles: marker.niveles }, { modulos: 4, niveles: 3 });
  const avisos = j.avisos;
  assert.strictEqual(avisos.length, 2, avisos.join('\n'));
  assert.match(avisos.find((a) => a.includes('enorme.js')), /scripts\/ci\/enorme\.js.*95\.000.*90\.000/);
  const delRecorrido = avisos.find((a) => a.includes('marker.js'));
  assert.match(delRecorrido, /4 módulos locales en 3 niveles/);
  assert.match(delRecorrido, /módulo 4 de cada cuenta/);
  assert.match(delRecorrido, /nivel 2/);
  assert.ok(!avisos.some((a) => a.includes('pipeline.js')), 'un despachador por debajo del umbral no avisa');
  // en texto: cada aviso en su renglón, con el prefijo que levanta la CI; y sale 0
  const r = correr(root);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out.split('\n').filter((l) => l.startsWith('⚠️ control-size: ')).length, 2);
});

test('T2 ControlSize_OverLimit_WarnsNotBlocks — @story-8.163 @ac-2: el tope sale del freno real del árbol', () => {
  const root = arbol({ 'scripts/ci/uno.js': '// nada\n' });
  const j = datos(root, '--gate', REAL_GATE);
  assert.deepStrictEqual(j.recorrido.tope, { niveles: 2, modulos: 20 });
});

test('T2 ControlSize_OverLimit_WarnsNotBlocks — @story-8.163 @ac-2: un freno sin los dos números es «no medido», nunca silencio', () => {
  const root = arbol({ [`${PIPE}/on-bash-write-gate.js`]: 'function guionesEnArchivo() { return 1; }\n' });
  const j = datos(root);
  assert.strictEqual(j.recorrido.tope, null);
  assert.match(j.recorrido.motivo, /no encontré el tope del recorrido en el freno/);
  assert.ok(j.avisos.some((a) => /no medido: no encontré el tope del recorrido en el freno/.test(a)), j.avisos.join('\n'));
});

test('T2 ControlSize_OverLimit_WarnsNotBlocks — @story-8.163 @ac-2: con --range sólo avisa lo que el rango toca y creció', () => {
  const root = arbol({
    'scripts/ci/crece.js': relleno('// crece', 91000),
    'scripts/ci/quieto.js': relleno('// no se toca', 99000),
    'scripts/ci/achica.js': relleno('// se achica pero sigue grande', 98000),
  });
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'tag', 'base');
  escribir(root, 'scripts/ci/crece.js', relleno('// crece', 93000));
  escribir(root, 'scripts/ci/achica.js', relleno('// se achica pero sigue grande', 97000));
  git(root, 'commit', '-q', '-am', 'el pedido');
  const j = datos(root, '--range', 'base...HEAD');
  const deTamano = j.avisos.filter((a) => /letras/.test(a));
  assert.strictEqual(deTamano.length, 1, deTamano.join('\n'));
  assert.match(deTamano[0], /scripts\/ci\/crece\.js.*93\.000/);
  // sin rango, los tres que pasan el tope
  assert.strictEqual(datos(root).avisos.filter((a) => /letras/.test(a)).length, 3);
  // un rango que no se lee no esconde nada: lo dice y avisa como sin rango
  const malo = datos(root, '--range', 'no-existe...HEAD');
  assert.match(malo.rango_motivo, /no medido/);
  assert.strictEqual(malo.avisos.filter((a) => /letras/.test(a)).length, 3);
});

test('T9 ControlSize_Unreadable_NotMeasured — @story-8.163 @ac-9: lo que no se lee es «no medido» con el motivo', () => {
  const root = arbol({ 'scripts/ci/bueno.js': '// se lee\n' });
  fs.symlinkSync(path.join(root, 'no-existe.js'), path.join(root, 'scripts', 'ci', 'roto.js'));
  const comoRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (!comoRoot) {
    escribir(root, 'scripts/ci/cerrado.js', '// sin permiso de lectura\n');
    fs.chmodSync(path.join(root, 'scripts', 'ci', 'cerrado.js'), 0o000);
  }
  const j = datos(root);
  const esperados = comoRoot ? ['scripts/ci/roto.js'] : ['scripts/ci/cerrado.js', 'scripts/ci/roto.js'];
  assert.deepStrictEqual(j.no_medidos.map((n) => n.ruta).sort(), esperados);
  for (const n of j.no_medidos) assert.match(n.motivo, /no se pudo leer/);
  assert.ok(!j.controles.some((c) => esperados.includes(c.ruta)), 'un control no medido no se cuenta como chico');
  const r = correr(root);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /no medido[^\n]*roto\.js|roto\.js[^\n]*no se pudo leer/);
});

// ── regresiones del pase adversarial ─────────────────────────────────────────────────────────────────────────────

test('ControlSize_GateDepth_DepthFirstLikeTheGate — @story-8.163 @ac-2: los niveles se miden como los recorre el freno, en profundidad', () => {
  // el freno entra a b.js por a→c→e→b (nivel 4) y no sigue lo que carga: f.js queda en el nivel 5, fuera de su vista.
  // En anchura b.js estaría en el nivel 1 y el recorrido daría 3 niveles, por debajo del umbral (4 × 0,75 = 3)
  const root = arbol({
    [`${PIPE}/on-bash-write-gate.js`]: FRENO(4, 20),
    [`${PIPE}/marker.js`]: "require('./lib/a.js');\nrequire('./lib/b.js');\n",
    [`${PIPE}/lib/a.js`]: "require('./c.js');\n",
    [`${PIPE}/lib/c.js`]: "require('./e.js');\n",
    [`${PIPE}/lib/e.js`]: "require('./b.js');\n",
    [`${PIPE}/lib/b.js`]: "require('./f.js');\n",
    [`${PIPE}/lib/f.js`]: '',
  });
  const j = datos(root);
  const marker = j.recorrido.despachadores.find((x) => x.ruta === `${PIPE}/marker.js`);
  assert.deepStrictEqual({ modulos: marker.modulos, niveles: marker.niveles }, { modulos: 5, niveles: 5 });
  assert.ok(j.avisos.some((a) => a.includes('marker.js') && /5 módulos locales en 5 niveles/.test(a)), j.avisos.join('\n'));
});

test('ControlSize_Range_RenameIsNotGrowth — @story-8.163 @ac-2: un control que sólo se mueve no avisa como si hubiera crecido', () => {
  const root = arbol({ 'scripts/hooks/grande.js': relleno('// grande', 95000), 'scripts/ci/otro.js': '// la carpeta destino existe\n' });
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'tag', 'base');
  git(root, 'mv', 'scripts/hooks/grande.js', 'scripts/ci/grande.js');
  git(root, 'commit', '-q', '-m', 'lo mueve sin cambiarlo');
  const j = datos(root, '--range', 'base...HEAD');
  assert.deepStrictEqual(j.avisos.filter((a) => /letras/.test(a)), []);
});

test('ControlSize_Range_RootBelowGitTop — @story-8.163 @ac-2: con --root debajo de la raíz de git, el rango igual encuentra lo tocado', () => {
  const top = arbol({ 'arnes/scripts/ci/crece.js': relleno('// crece', 91000), 'otro/leeme.txt': 'x\n' });
  git(top, 'commit', '-q', '-m', 'base');
  git(top, 'tag', 'base');
  escribir(top, 'arnes/scripts/ci/crece.js', relleno('// crece', 93000));
  git(top, 'commit', '-q', '-am', 'el pedido');
  const j = datos(path.join(top, 'arnes'), '--range', 'base...HEAD');
  const deTamano = j.avisos.filter((a) => /letras/.test(a));
  assert.strictEqual(deTamano.length, 1, deTamano.join('\n'));
  assert.match(deTamano[0], /scripts\/ci\/crece\.js.*93\.000/);
});

test('ControlSize_Subcommands_ShellRequiredArgForm — @story-8.163 @ac-1: en un .sh cuenta la forma `X="${1:?…}"; shift`', () => {
  const root = arbol({
    'scripts/ci/pide.sh': 'cmd="${1:?uso: pide.sh <uno|dos>}"; shift\ncase "$cmd" in\n  uno) ;;\n  dos) ;;\nesac\n',
  });
  assert.strictEqual(control(datos(root), 'scripts/ci/pide.sh').subcomandos, 2);
});

test('ControlSize_Callers_SameNameElsewhereDoesNotCount — @story-8.163 @ac-1: otro archivo con el mismo nombre no suma llamadores', () => {
  const root = arbol({
    'scripts/hooks/chico.js': '// un control\n',
    'vendor/chico.js': '// otro archivo, mismo nombre\n',
    'config/hooks.json': '{ "command": "node scripts/hooks/chico.js" }\n',
    'otra/usa.json': '["vendor/chico.js"]\n',
  });
  assert.strictEqual(control(datos(root), 'scripts/hooks/chico.js').llamadores, 1);
});

test('ControlSize_WarningText_SaysAboveThreshold — @story-8.163 @ac-2: el aviso dice «más de» el umbral, que es lo que el código mide', () => {
  const root = arbol({
    [`${PIPE}/on-bash-write-gate.js`]: FRENO(2, 4),
    [`${PIPE}/marker.js`]: "require('./lib/m1.js');\nrequire('./lib/m2.js');\nrequire('./lib/m3.js');\nrequire('./lib/m4.js');\n",
    [`${PIPE}/lib/m1.js`]: '', [`${PIPE}/lib/m2.js`]: '', [`${PIPE}/lib/m3.js`]: '', [`${PIPE}/lib/m4.js`]: '',
  });
  const a = datos(root).avisos.find((x) => x.includes('marker.js'));
  assert.match(a, /con más de 3 módulos o más de 1,5 niveles/);
});

test('ControlSize_BadArgument — un argumento que no entiende sale 2 y lo dice', () => {
  const root = arbol({ 'scripts/ci/uno.js': '' });
  const r = correr(root, '--unknown-flag');
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /--unknown-flag/);
});
