'use strict';

/**
 * El freno de escrituras por consola partido por responsabilidad (on-bash-write-gate.js y sus módulos `lib/bash-gate-*.js`):
 * el banco de controles da en sus casos los mismos veredictos que antes de partir (T8), el despachador queda debajo del
 * tope (AC 8) y lo que carga de nuevo es sensible (T16).
 *
 * La foto del banco de antes (`fixtures/split-contract/bash-gate-bench-before.json`) se graba con
 * `BASH_GATE_BENCH_RECORD=1` sobre el freno sin partir: corre los casos del banco que nombran el freno, con las dos
 * herramientas y una casa de prueba, y guarda el veredicto de cada caso por herramienta. Sin la foto, T8 da rojo sin correr
 * nada. T8 corre a pedido (BASH_GATE_BENCH=1). La lista de lo que el freno cargaba antes
 * (`bash-gate-requires-before.json`) es la de T16.
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
// Corre a pedido (BASH_GATE_BENCH=1): es el contrato del momento de partir, con una foto de una máquina. De ahí en más
// los veredictos los cuida el banco nocturno contra su línea de base, y un cambio de veredicto a propósito no deja este
// caso en rojo para siempre.
const A_PEDIDO = !GRABAR && process.env.BASH_GATE_BENCH !== '1' && 'el banco del freno contra la foto de antes de partir corre a pedido: BASH_GATE_BENCH=1';
test('T8 BashGate_BenchUnchanged @story-8.163 @ac-8 — los casos del banco del freno dan lo mismo que antes de partir', { timeout: 30 * 60 * 1000, skip: A_PEDIDO }, () => {
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

/** Una copia del freno con lo que carga (los guiones del pipeline sin sus pruebas, scripts/lib y scripts/setup). */
function copiaDelFreno() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-gate-copia-'));
  const sinPruebas = (src) => !src.split(path.sep).includes('tests');
  fs.cpSync(SCRIPTS, path.join(raiz, 'skills', 'tycon-pipeline', 'scripts'), { recursive: true, filter: sinPruebas });
  for (const d of ['lib', 'setup']) fs.cpSync(path.join(ROOT, 'scripts', d), path.join(raiz, 'scripts', d), { recursive: true, filter: sinPruebas });
  return raiz;
}

/** El registro de fallas que quedó en la casa, dondequiera que esté su carpeta del estado ('' si no hay). */
function registroDe(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const t = registroDe(p); if (t) return t; } else if (e.name === 'hook-errors.log') return fs.readFileSync(p, 'utf8');
  }
  return '';
}

function correrCopia(raiz, comando) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-gate-copia-casa-'));
  try {
    const r = spawnSync(process.execPath, [path.join(raiz, 'skills', 'tycon-pipeline', 'scripts', 'on-bash-write-gate.js')], {
      input: JSON.stringify({ session_id: 'ses-partes', cwd: raiz, tool_name: 'Bash', tool_input: { command: comando } }),
      encoding: 'utf8', cwd: raiz, env: { ...process.env, HOME: casa, USERPROFILE: casa }, timeout: 60000,
    });
    r.registro = registroDe(casa);
    return r;
  } finally {
    fs.rmSync(casa, { recursive: true, force: true });
  }
}

// 🔴 Falla con: un freno que, sin una de sus partes, deja pasar el comando por la red de fallas o se cae sin decir cuál.
test('BashGate_MissingPart_BlocksAndNamesIt @story-8.163 @ac-10 — sin una parte, el freno frena y la nombra', () => {
  const raiz = copiaDelFreno();
  try {
    const entero = correrCopia(raiz, 'ls');
    assert.strictEqual(entero.status, 0, `con todas sus partes, un comando que no escribe pasa (${entero.stderr})`);
    for (const parte of ['bash-gate-net.js', 'bash-gate-targets.js', 'bash-gate-records.js']) {
      const archivo = path.join(raiz, 'skills', 'tycon-pipeline', 'scripts', 'lib', parte);
      const guardado = fs.readFileSync(archivo);
      fs.rmSync(archivo);
      try {
        const r = correrCopia(raiz, 'ls');
        assert.strictEqual(r.status, 2, `sin lib/${parte}, frena (salió ${r.status}: ${r.stderr})`);
        assert.ok(r.stderr.includes(`lib/${parte}`), `sin lib/${parte}, el mensaje la nombra (${r.stderr})`);
        // también la red, que carga antes que la carpeta del estado: el aviso de arranque cuenta las fallas por este renglón
        assert.match(r.registro, new RegExp(`on-bash-write-gate FRENÓ POR FALLA:[\\s\\S]*${parte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
          `sin lib/${parte}, deja su renglón en hook-errors.log (${r.registro.slice(0, 300) || 'vacío'})`);
      } finally {
        fs.writeFileSync(archivo, guardado);
      }
    }
  } finally {
    fs.rmSync(raiz, { recursive: true, force: true });
  }
});

// 🔴 Falla con: un freno cargado como biblioteca (un aviso que usa sus funciones) que, sin una parte, termina el proceso
// de quien lo carga en vez de tirar un error que ese proceso pueda atrapar.
test('BashGate_MissingPart_AsLibraryThrows @story-8.163 @ac-10 — cargado como biblioteca, sin una parte tira y la nombra', () => {
  const raiz = copiaDelFreno();
  try {
    fs.rmSync(path.join(raiz, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'bash-gate-targets.js'));
    const gate = path.join(raiz, 'skills', 'tycon-pipeline', 'scripts', 'on-bash-write-gate.js');
    const programa = `try { require(${JSON.stringify(gate)}); console.log('cargó'); } catch (e) { console.log('atrapado: ' + e.message); }`;
    const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-gate-copia-casa-'));
    try {
      const r = spawnSync(process.execPath, ['-e', programa], { encoding: 'utf8', cwd: raiz, env: { ...process.env, HOME: casa, USERPROFILE: casa }, timeout: 60000 });
      assert.strictEqual(r.status, 0, `quien carga el freno sigue vivo (salió ${r.status}: ${r.stderr})`);
      assert.match(r.stdout, /^atrapado: .*lib\/bash-gate-targets\.js/m, `el error se atrapa y nombra la parte (${r.stdout}${r.stderr})`);
    } finally {
      fs.rmSync(casa, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(raiz, { recursive: true, force: true });
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
