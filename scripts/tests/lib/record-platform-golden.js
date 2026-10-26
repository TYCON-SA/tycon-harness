#!/usr/bin/env node
'use strict';
// record-platform-golden.js — la foto de cómo habla hoy el arnés con Azure DevOps, para comparar contra ella después de
// cada cambio de la capa de plataforma: si la foto cambia, Azure DevOps nota el cambio.
//
// Tres partes, cada una en su archivo de scripts/tests/fixtures/platform-golden/:
//   · hard-signals-baseline.json: cuántas líneas con una señal dura de Azure DevOps (un comando o una dirección real)
//     tiene cada archivo del núcleo, fuera de integrations/, guides/integrations/ y las pruebas.
//   · <suite>.calls: las llamadas que hace cada suite que corre contra el az de mentira (scripts/tests/lib/fake-az.sh,
//     que las copia con TYCON_AZ_SNAPSHOT), sin repetir y en orden, con las rutas temporales y las fechas reemplazadas.
//   · az-commands.json: los comandos az escritos en el núcleo y en las integraciones, sin repetir.
//
// Uso:
//   node scripts/tests/lib/record-platform-golden.js record [--without-suites]   escribe las tres partes
//   node scripts/tests/lib/record-platform-golden.js compare [--without-suites]  compara contra lo grabado; sale 1 si cambió
// `--without-suites` saltea la foto de las suites (tarda: corre seis suites de a una).
//
// Casos: scripts/tests/platform-golden.test.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DIR = path.join(ROOT, 'scripts', 'tests', 'fixtures', 'platform-golden');

// La señal dura, la misma de la medición de la story: un comando o una dirección de Azure DevOps
const DURA = /\baz\s+(boards|repos|pipelines|devops|rest)\b|dev\.azure\.com|visualstudio\.com|_apis\/|System\.(Title|State|AssignedTo|WorkItemType|Tags|TeamProject)\b|Microsoft\.VSTS|ado-config|AZURE_DEVOPS|SYSTEM_ACCESSTOKEN|\baz-pr\b/;
// Fuera del núcleo: las integraciones, sus guías, las pruebas, y la nube donde corre el sitio (dice Azure y no es ADO)
const AFUERA = [/^integrations\//, /^guides\/integrations\//, /^scripts\/tests\//, /\.test\./, /(^|\/)fixtures\//, /^scripts\/controls-bench\/cases\//,
  /^scripts\/site\/cloud\/azure\.js$/, /^scripts\/site\/deploy\/azure-container-apps\.js$/];
const TEXTO = /\.(js|cjs|mjs|sh|ps1|md|json|yml|yaml|toml|py)$/;
const LITERAL = /\baz\s+(boards|repos|pipelines|devops|rest)\b/;
// Las suites que corren guiones de verdad contra el az de mentira
const SUITES = ['open-prs.test.sh', 'assigned-items.test.js', 'work-items.test.sh', 'work-item-status.test.sh', 'work-items-type.test.sh', 'nightly-deployments.test.js'];

// los archivos del núcleo que no se pudieron leer: la foto no se arma sin ellos (contarlos como 0 la achicaría en silencio)
const ilegibles = [];
function leer(f, root = ROOT) { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch (e) { ilegibles.push(`${f} (${(e && e.code) || 'error'})`); return null; } }

const IH = () => require(path.join(ROOT, 'scripts', 'publishing', 'internal-history.js'));

// En el árbol armado de los nocturnos el núcleo es sólo lo que viaja al público; sin superposición, el árbol entero.
function nucleo(root = ROOT) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return IH().travelling(root, out.split('\0').filter((f) => f && TEXTO.test(f) && !AFUERA.some((rx) => rx.test(f))), 'el núcleo');
}

/** Por archivo, cuántas líneas distintas tienen una señal dura. */
function senales() {
  const archivos = {};
  for (const f of nucleo()) {
    const t = leer(f); if (t === null) continue;
    const n = new Set(t.split('\n').filter((l) => DURA.test(l)).map((l) => l.trim())).size;
    if (n) archivos[f] = n;
  }
  const lineas = Object.values(archivos).reduce((a, b) => a + b, 0);
  return { archivos: Object.keys(archivos).length, lineas, porArchivo: archivos };
}

/** Los archivos de las integraciones (donde se mudan los comandos de una plataforma a su conector). */
function deIntegraciones(root = ROOT) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--others', '--cached', '--exclude-standard', 'integrations'], { encoding: 'utf8' });
  // el manifiesto declara los comandos crudos de su plataforma (para los frenos): es una lista, no una llamada
  const lista = out.split('\0').filter((f) => f && TEXTO.test(f) && !/(^|\/)integration\.json$/.test(f));
  // sin integraciones no hay nada que contar; con integraciones y ninguna que viaje, la foto no las miró: rojo
  return lista.length ? IH().travelling(root, lista, 'las integraciones') : [];
}

/**
 * Por archivo, los comandos az escritos (la línea, sin espacios a los lados), sin repetir: los del núcleo y los de las
 * integraciones, así un comando que se muda a su conector sigue en la foto.
 */
function literales({ root = ROOT } = {}) {
  const porArchivo = {};
  for (const f of [...nucleo(root), ...deIntegraciones(root)]) {
    const t = leer(f, root); if (t === null) continue;
    const ls = [...new Set(t.split('\n').filter((l) => LITERAL.test(l)).map((l) => l.trim()))].sort();
    if (ls.length) porArchivo[f] = ls;
  }
  return porArchivo;
}

/**
 * De la foto grabada, los archivos que viajan: en el árbol armado, un archivo donde el privado tiene su propia versión
 * no trae la del público, y sus comandos no se pueden comparar ahí (los compara la CI del público).
 */
function grabadosQueViajan(porArchivo, root = ROOT) {
  const viaja = IH().travels(root);
  return Object.fromEntries(Object.entries(porArchivo).filter(([f]) => viaja(f)));
}

// las rutas temporales y las fechas cambian en cada corrida: se reemplazan para que la foto sea la misma
const TMP = new RegExp(`(${[os.tmpdir(), '/tmp', '/private/var', '/var/folders'].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[^"\\s]*`, 'g');
function normalizar(linea) {
  return linea.replace(TMP, '<tmp>').replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?/g, '<fecha>');
}

/** Las llamadas de una suite, normalizadas, sin repetir y en orden; null si la suite no corrió bien. */
function llamadasDe(suite) {
  const foto = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foto-az-')), 'calls');
  fs.writeFileSync(foto, '');
  const file = path.join(ROOT, 'scripts', 'tests', suite);
  const cmd = suite.endsWith('.sh') ? ['bash', [file]] : [process.execPath, ['--test', file]];
  const r = spawnSync(cmd[0], cmd[1], { cwd: ROOT, env: { ...process.env, TYCON_AZ_SNAPSHOT: foto }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return { error: `la suite ${suite} salió ${r.status}: la foto de una suite roja no sirve de vara` };
  const lineas = [...new Set(fs.readFileSync(foto, 'utf8').split('\n').filter(Boolean).map(normalizar))].sort();
  // una suite que no llamó a az no saca foto: el az de mentira no se usó, o la variable no le llegó
  if (!lineas.length) return { error: `la suite ${suite} no hizo ninguna llamada a az: la foto vacía no sirve de vara` };
  return { lineas };
}

function leerJson(f) { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); }
function escribir(f, contenido) { fs.writeFileSync(path.join(DIR, f), contenido); }

function main(argv) {
  const [modo, ...resto] = argv;
  const sinSuites = resto.includes('--without-suites');
  if (!['record', 'compare'].includes(modo)) { process.stderr.write('uso: record-platform-golden.js record|compare [--without-suites]\n'); return 2; }
  // en el árbol armado la foto saldría de lo que viaja más lo que el privado tiene igual: se graba en el público solo
  if (modo === 'record' && IH().broughtByOverlay(ROOT)) { process.stderr.write('✗ esto es el árbol armado de los nocturnos: la foto se graba en el público solo\n'); return 1; }
  fs.mkdirSync(DIR, { recursive: true });
  const problemas = [];
  const s = senales(); const l = literales();
  for (const f of ilegibles) problemas.push(`no pude leer ${f}: la foto no se arma sin él`);
  if (modo === 'record' && ilegibles.length) { for (const p of problemas) process.stdout.write(`✗ ${p}\n`); return 1; }
  if (modo === 'record') {
    escribir('hard-signals-baseline.json', `${JSON.stringify(s, null, 2)}\n`);
    escribir('az-commands.json', `${JSON.stringify(l, null, 2)}\n`);
  } else {
    // los comandos se comparan como conjunto, sin el archivo: mudar un guion a su conector no cambia lo que pide
    const antes = new Set(Object.values(grabadosQueViajan(leerJson('az-commands.json'))).flat());
    const ahora = new Set(Object.values(l).flat());
    for (const x of antes) if (!ahora.has(x)) problemas.push(`un comando az que ya no está: ${x}`);
    for (const x of ahora) if (!antes.has(x)) problemas.push(`un comando az nuevo: ${x}`);
  }
  if (!sinSuites) {
    for (const suite of SUITES) {
      const r = llamadasDe(suite);
      if (r.error) { problemas.push(r.error); continue; }
      const f = `${suite.replace(/\.test\.(js|sh)$/, '')}.calls`;
      if (modo === 'record') escribir(f, `${r.lineas.join('\n')}\n`);
      else {
        const antes = fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(Boolean);
        const a = new Set(antes); const b = new Set(r.lineas);
        for (const x of a) if (!b.has(x)) problemas.push(`${suite}: ya no llama ${x}`);
        for (const x of b) if (!a.has(x)) problemas.push(`${suite}: llama algo nuevo ${x}`);
      }
    }
  }
  if (modo === 'record') process.stdout.write(`foto grabada en ${path.relative(ROOT, DIR)}: ${s.archivos} archivos del núcleo con ${s.lineas} líneas duras, ${Object.keys(l).length} con comandos az${sinSuites ? '' : `, ${SUITES.length} suites`}\n`);
  for (const p of problemas) process.stdout.write(`✗ ${p}\n`);
  if (modo === 'compare' && !problemas.length) process.stdout.write('✓ la foto de llamadas a Azure DevOps no cambió\n');
  return problemas.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { senales, literales, nucleo, deIntegraciones, grabadosQueViajan, normalizar, DURA, AFUERA, SUITES };
