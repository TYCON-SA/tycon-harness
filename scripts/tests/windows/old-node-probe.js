'use strict';
/**
 * old-node-probe.js — con un Node viejo primero en el PATH, ¿el respaldo en PowerShell del arranque elige uno de 22 o más?
 *
 * ── POR QUÉ EXISTE ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * En un Windows con nvm-windows y la 12 por defecto, el arranque corría con esa 12: bootstrap.js no llega a correr y la
 * sesión caía al respaldo. bootstrap-fallback.ps1 busca entonces un Node de 22 o más: el propio del arnés
 * (<casa>\node\current\node.exe) o uno de nvm-windows (NVM_HOME\v<versión>\node.exe), y vuelve a correr bootstrap.js con
 * ése. En la Mac eso se prueba con nodos de mentira (harness-bootstrap.test.sh, T14c); esta sonda lo MIDE en el agente
 * Windows con binarios reales: baja un Node 12 portátil, lo pone primero en el PATH y corre el respaldo tres veces.
 *
 *   own   con el Node propio del arnés en la casa: el respaldo corre bootstrap.js con ése y el registro lo dice.
 *   nvm   sin el propio, con NVM_HOME que tiene la 12 y una de 22 o más: corre con la de 22 o más.
 *   none  sin ninguno: no corre bootstrap.js con otro y el registro dice qué instalar.
 *
 * El respaldo se corre desde una copia junto a un bootstrap.js de prueba que sólo anota con qué Node lo corrieron: se
 * mide la elección del Node, no el arranque entero (eso lo miden los otros escenarios). El Node «bueno» es el que corre
 * esta sonda; si es de menos de 22, si no se puede bajar el Node 12 o si el PATH no lo deja primero, el paso sale NO MEDIDO, nunca verde.
 *
 * Fuera de Windows no mide nada (no medido). Uso: node scripts/tests/windows/old-node-probe.js --lab <laboratorio> --out <carpeta del reporte> [--allow-temp]
 */
const fs = require('fs');
const path = require('path');
const L = require('./lab.js');

const NAME = 'old-node';
const FALLBACK = path.join(__dirname, '..', '..', 'setup', 'harness', 'bootstrap-fallback.ps1');
const OLD_VERSION = 'v12.22.12';
const OLD_ZIP = `https://nodejs.org/dist/${OLD_VERSION}/node-${OLD_VERSION}-win-x64.zip`;
const MARK_ENV = 'TYCON_OLD_NODE_PROBE_MARK';
const say = (s) => process.stdout.write(`${s}\n`);
const major = (v) => { const m = /^v?(\d+)\./.exec(String(v || '')); return m ? Number(m[1]) : 0; };
const readOrNull = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; } };
const lastLine = (text) => String(text || '').split(/\r?\n/).filter(Boolean).pop() || '';

/**
 * Qué salió mal en las tres corridas: la lista de hallazgos `{ id, detail, severity }`. Cada corrida trae `ran` (el
 * Node con que corrió el bootstrap.js de prueba, o null), `log` (la última línea de startup.log) y `rc`.
 */
function judge({ own, nvm, none, expected }) {
  const out = [];
  const same = (a, b) => Boolean(a) && Boolean(b) && L.samePath(a, b, 'win32');
  if (!own.ran || !same(own.ran.execPath, expected.own)) {
    out.push({ id: 'old-node:own-not-chosen', severity: 'breaks', detail: `con el Node propio en la casa, el respaldo no corrió con él (corrió con ${own.ran ? own.ran.execPath : 'ninguno'}; registro: ${own.log || '—'})` });
  } else if (!own.log.includes(OLD_VERSION) || !own.log.includes('corrió con')) {
    out.push({ id: 'old-node:own-log-silent', severity: 'loses-control', detail: `corrió con el Node propio pero el registro no dice por qué: ${own.log || '—'}` });
  }
  if (!nvm.ran || !same(nvm.ran.execPath, expected.nvm)) {
    out.push({ id: 'old-node:nvm-not-chosen', severity: 'breaks', detail: `con nvm-windows (la 12 y una de ${major(process.version)}), el respaldo no corrió con la nueva (corrió con ${nvm.ran ? nvm.ran.execPath : 'ninguno'}; registro: ${nvm.log || '—'})` });
  }
  if (none.ran) {
    out.push({ id: 'old-node:none-ran-anyway', severity: 'breaks', detail: `sin otro Node, el respaldo igual corrió bootstrap.js con ${none.ran.execPath}` });
  } else if (!none.log.includes(OLD_VERSION) || !none.log.includes('nvm install 22')) {
    out.push({ id: 'old-node:none-no-hint', severity: 'loses-control', detail: `sin otro Node, el registro no dice qué instalar: ${none.log || '—'}` });
  }
  return out;
}

/** Baja el Node 12 portátil y lo descomprime en `dir`; devuelve la carpeta de su node.exe o `{ problem }`. */
function fetchOldNode(dir, ps, env) {
  const zip = path.join(dir, 'old-node.zip');
  const script = `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '${OLD_ZIP}' -OutFile '${zip}'; Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${dir}'`;
  const r = L.run(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env, timeoutMs: 300000 });
  const bin = path.join(dir, `node-${OLD_VERSION}-win-x64`);
  if (r.exit !== 0 || !fs.existsSync(path.join(bin, 'node.exe'))) return { problem: `no pude bajar el Node ${OLD_VERSION} (${OLD_ZIP}): ${L.firstLine(r.stderr || r.stdout) || `salió ${r.exit}`}` };
  return { bin };
}

/** El ambiente de una corrida: la casa del laboratorio, sin el nvm ni la casa de quien lanza, y el Node 12 primero en el PATH. */
function runEnv({ home, oldBin, nvmHome, mark, base }) {
  const env = L.labEnv(home, { base, extra: { NVM_HOME: nvmHome || null, NVM_SYMLINK: null, TYCON_HOME: null, [MARK_ENV]: mark } });
  const key = L.pathKey(env);
  env[key] = `${oldBin};${env[key] || ''}`;
  return env;
}

/**
 * Lo que el respaldo va a ver como «el node del PATH»: la ruta y la versión, con el mismo ambiente de las corridas. Si no
 * es el Node 12 bajado, el montaje falló y las corridas no medirían el respaldo: devuelve el motivo, o null si está bien.
 */
function pathNodeProblem({ ps, home, oldBin, base }) {
  const env = runEnv({ home, oldBin, nvmHome: null, mark: '', base });
  const r = L.run(ps, ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command node).Source; node --version'], { env, timeoutMs: 60000 });
  const [source = '', version = ''] = String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (r.exit === 0 && L.samePath(path.dirname(source), oldBin, 'win32') && version === OLD_VERSION) return null;
  return `el node del PATH no quedó el ${OLD_VERSION} bajado (PowerShell ve ${source || 'ninguno'}, ${version || 'sin versión'}): el montaje falló, no el respaldo`;
}

/** Una corrida del respaldo: devuelve `{ rc, ran, log }`. */
function runFallback({ ps, script, home, oldBin, nvmHome, mark, logFile, base }) {
  fs.rmSync(mark, { force: true });
  const env = runEnv({ home, oldBin, nvmHome, mark, base });
  const r = L.run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { env, timeoutMs: 180000 });
  const raw = readOrNull(mark);
  let ran = null;
  if (raw) { try { ran = JSON.parse(raw); } catch (_) { ran = { execPath: `(no se pudo leer: ${raw.slice(0, 80)})` }; } }
  return { rc: r.exit, ran, log: lastLine(readOrNull(logFile)) };
}

function measure({ lab, platform = process.platform, baseEnv = process.env, allowTemp = false, rec }) {
  if (platform !== 'win32') return { status: L.STATUS.notMeasured, reason: 'sólo mide en Windows: el respaldo en PowerShell y las rutas de nvm-windows son de ahí' };
  if (major(process.version) < 22) return { status: L.STATUS.notMeasured, reason: `el Node que corre la sonda es ${process.version}: hace falta uno de 22 o más para ser el «bueno»` };
  const ps = L.scanPath('pwsh', { env: baseEnv })[0];
  if (!ps) return { status: L.STATUS.notMeasured, reason: 'no hay pwsh (PowerShell 7) en el PATH: el respaldo no corre sin él' };
  const dir = path.join(lab, NAME);
  const home = path.join(dir, 'home');
  const problem = L.labHomeProblem(home, { labRoot: lab, allowTemp });
  if (problem) return { status: L.STATUS.error, reason: problem };
  fs.mkdirSync(dir, { recursive: true });

  const old = fetchOldNode(dir, ps, L.labEnv(home, { base: baseEnv }));
  if (old.problem) return { status: L.STATUS.notMeasured, reason: old.problem };
  const setup = pathNodeProblem({ ps, home, oldBin: old.bin, base: baseEnv });
  if (setup) return { status: L.STATUS.notMeasured, reason: setup };

  // la copia del respaldo, con el bootstrap.js de prueba al lado (el respaldo lo corre desde su propia carpeta)
  const fallbackDir = path.join(dir, 'fallback');
  fs.mkdirSync(fallbackDir, { recursive: true });
  const script = path.join(fallbackDir, 'bootstrap-fallback.ps1');
  fs.copyFileSync(FALLBACK, script);
  fs.writeFileSync(path.join(fallbackDir, 'bootstrap.js'), `require('fs').writeFileSync(process.env.${MARK_ENV}, JSON.stringify({ execPath: process.execPath, version: process.version }));\n`);

  // la casa del laboratorio: con <casa>\state, el registro va a <casa>\state\harness\startup.log
  const own = path.join(home, '.tycon');
  fs.mkdirSync(path.join(own, 'state'), { recursive: true });
  const logFile = path.join(own, 'state', 'harness', 'startup.log');
  const mark = path.join(dir, 'ran.json');
  const ownNode = path.join(own, 'node', 'current', 'node.exe');
  const nvmHome = path.join(dir, 'nvm');
  const nvmNew = path.join(nvmHome, process.version, 'node.exe');
  const nvmOld = path.join(nvmHome, OLD_VERSION, 'node.exe');
  const common = { ps, script, home, oldBin: old.bin, mark, logFile, base: baseEnv };

  fs.mkdirSync(path.dirname(ownNode), { recursive: true });
  fs.copyFileSync(process.execPath, ownNode);
  const runOwn = rec.fact('own', runFallback(Object.assign({}, common, { nvmHome: null })));
  fs.rmSync(path.join(own, 'node'), { recursive: true, force: true });

  for (const [exe, from] of [[nvmOld, path.join(old.bin, 'node.exe')], [nvmNew, process.execPath]]) {
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.copyFileSync(from, exe);
  }
  const runNvm = rec.fact('nvm', runFallback(Object.assign({}, common, { nvmHome })));
  const runNone = rec.fact('none', runFallback(Object.assign({}, common, { nvmHome: null })));

  for (const f of judge({ own: runOwn, nvm: runNvm, none: runNone, expected: { own: ownNode, nvm: nvmNew } })) rec.finding(f.id, 'startup', f.detail, null, { severity: f.severity });
  return { status: L.STATUS.measured, reason: null };
}

function main(argv) {
  const args = L.parseArgs(argv, { '--lab': 'value', '--out': 'value', '--allow-temp': 'flag' });
  if (args.problem || !args.lab || !args.out) { process.stderr.write(`old-node-probe.js: ${args.problem || 'faltan --lab <laboratorio> y --out <carpeta del reporte>'}\n`); return 2; }
  const lab = path.resolve(args.lab);
  if (!fs.existsSync(path.join(lab, L.LAB_MARK))) { process.stderr.write(`old-node-probe.js: ${lab} no tiene la marca del laboratorio (${L.LAB_MARK}): no mido ni escribo nada\n`); return 2; }
  const rec = L.recorder(NAME, path.resolve(args.out));
  let result;
  try { result = measure({ lab, allowTemp: Boolean(args['allow-temp']), rec }); } catch (e) {
    result = { status: L.STATUS.error, reason: `no pude medir: el paso tiró: ${e.message}` };
  }
  rec.finish(result.status, result.reason);
  say(`${NAME}: ${result.status === L.STATUS.measured ? `medido — ${rec.step.findings.length} hallazgo(s)` : result.reason}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { NAME, OLD_VERSION, judge, measure };
