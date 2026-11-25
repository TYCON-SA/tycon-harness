'use strict';

/**
 * El freno de escrituras por consola partido por responsabilidad (on-bash-write-gate.js y sus módulos `lib/bash-gate-*.js`):
 * el banco de controles da en sus casos los mismos veredictos que antes de partir (T8), el despachador queda debajo del
 * tope (AC 8) y lo que carga de nuevo es sensible (T16).
 *
 * La foto del banco de antes (`fixtures/split-contract/bash-gate-bench-before.json`) se graba con
 * `BASH_GATE_BENCH_RECORD=1` sobre el freno sin partir: corre los casos del banco que nombran el freno, con las dos
 * herramientas y una casa de prueba, y guarda el veredicto de cada caso por herramienta. Sin la foto, T8 da rojo sin correr
 * nada. La lista de lo que el freno cargaba antes (`bash-gate-requires-before.json`) es la de T16.
 *
 * Correr: cd skills/tycon-pipeline/scripts/tests && HOME=$(mktemp -d) node --test bash-gate-split.test.js < /dev/null
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const LIB = path.join(SCRIPTS, 'lib');
const ROOT = path.resolve(SCRIPTS, '..', '..', '..');
const GATE = path.join(SCRIPTS, 'on-bash-write-gate.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'split-contract');
const FOTO_BANCO = path.join(FIXTURES, 'bash-gate-bench-before.json');
const FOTO_REQUIRES = path.join(FIXTURES, 'bash-gate-requires-before.json');
const GRABAR = process.env.BASH_GATE_BENCH_RECORD === '1';
const TOPE = 90000;

/** Los módulos de la partición del freno. */
const modulos = () => fs.readdirSync(LIB).filter((f) => /^bash-gate-.+\.js$/.test(f)).sort();

/** Los `require` locales de un archivo, como rutas relativas a la carpeta de los guiones del pipeline. */
function requiresLocales(archivo) {
  const texto = fs.readFileSync(archivo, 'utf8');
  const out = new Set();
  const dir = path.dirname(archivo);
  for (const m of texto.matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)) out.add(path.relative(SCRIPTS, path.resolve(dir, m[1])).split(path.sep).join('/'));
  for (const m of texto.matchAll(/require\(path\.join\(__dirname,\s*([^)]*)\)\)/g)) {
    const partes = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    if (partes.every((p) => /^[\w.-]+$/.test(p))) out.add(path.relative(SCRIPTS, path.resolve(dir, ...partes)).split(path.sep).join('/'));
  }
  return [...out];
}

/** El veredicto de cada caso del banco que nombra el freno, por herramienta, con una casa de prueba. */
function bancoDelFreno() {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-gate-banco-casa-'));
  const informe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bash-gate-banco-')), 'informe.json');
  try {
    spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'controls-bench', 'runner.js'), '--tool', 'both', '--only', 'on-bash-write-gate.js', '--json', informe],
      { cwd: ROOT, encoding: 'utf8', input: '', env: { ...process.env, HOME: casa, USERPROFILE: casa }, maxBuffer: 256 * 1024 * 1024 });
    const r = JSON.parse(fs.readFileSync(informe, 'utf8'));
    const veredicto = (t) => (!t ? 'ausente' : t.skipped ? 'salteado' : t.nomedido ? 'no-medido' : t.pass ? 'verde' : 'rojo');
    return Object.fromEntries(Object.entries(r.results || {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, { claude: veredicto(v.tools && v.tools.claude), codex: veredicto(v.tools && v.tools.codex) }]));
  } finally {
    fs.rmSync(casa, { recursive: true, force: true });
  }
}

// 🔴 Falla con: un corte que cambia el veredicto de un caso del banco (el freno deja pasar o frena distinto).
test('T8 BashGate_BenchUnchanged @story-8.163 @ac-8 — los casos del banco del freno dan lo mismo que antes de partir', { timeout: 30 * 60 * 1000 }, () => {
  if (GRABAR) {
    const foto = bancoDelFreno();
    assert.ok(Object.keys(foto).length > 50, `la foto trae los casos del freno (${Object.keys(foto).length})`);
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(FOTO_BANCO, JSON.stringify({ casos: foto }, null, 2) + '\n');
    return;
  }
  assert.ok(fs.existsSync(FOTO_BANCO), `falta la foto del banco de antes de partir (${path.relative(ROOT, FOTO_BANCO)}): se graba con BASH_GATE_BENCH_RECORD=1 sobre el freno sin partir`);
  const antes = JSON.parse(fs.readFileSync(FOTO_BANCO, 'utf8')).casos;
  const ahora = bancoDelFreno();
  const distintos = Object.keys({ ...antes, ...ahora }).sort()
    .filter((k) => JSON.stringify(antes[k]) !== JSON.stringify(ahora[k]))
    .map((k) => `${k}: antes ${JSON.stringify(antes[k] || null)}, ahora ${JSON.stringify(ahora[k] || null)}`);
  assert.deepStrictEqual(distintos, [], 'ningún caso del banco cambia de veredicto al partir el freno');
});

// 🔴 Falla con: el freno entero en un solo archivo de más de 90 mil letras, que el propio freno no puede leer entero.
test('BashGate_UnderLimit @story-8.163 @ac-8 — el despachador y cada módulo quedan debajo de 90 mil letras', () => {
  for (const f of [GATE, ...modulos().map((m) => path.join(LIB, m))]) {
    const letras = fs.readFileSync(f, 'utf8').length;
    assert.ok(letras < TOPE, `${path.relative(ROOT, f)}: ${letras} letras (tope ${TOPE})`);
  }
});

// 🔴 Falla con: un módulo nuevo del freno que no es sensible (un cambio a él pasaría con el ok delegado).
test('T16 Split_BashGateModulesAreSensitive @story-8.163 @ac-16 — lo nuevo que carga el freno partido es sensible', () => {
  const { esSensible } = require(path.join(LIB, 'save-ok.js'));
  const antes = JSON.parse(fs.readFileSync(FOTO_REQUIRES, 'utf8')).requires.map((r) => path.relative(SCRIPTS, path.resolve(SCRIPTS, r)).split(path.sep).join('/'));
  assert.ok(antes.length >= 30, `la foto de antes trae lo que cargaba el freno (${antes.length})`);
  assert.ok(modulos().length > 0, 'hay módulos de la partición del freno (lib/bash-gate-*.js)');
  const archivos = [GATE, ...modulos().map((m) => path.join(LIB, m))];
  const nuevos = [...new Set(archivos.flatMap(requiresLocales))].filter((r) => !antes.includes(r));
  const noSensibles = nuevos.filter((r) => !esSensible(`skills/tycon-pipeline/scripts/${r}`)).sort();
  assert.deepStrictEqual(noSensibles, [], 'todo lo nuevo que carga el freno es sensible');
  for (const m of modulos()) assert.ok(esSensible(`skills/tycon-pipeline/scripts/lib/${m}`), `lib/${m} es sensible`);
});
