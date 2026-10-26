'use strict';
/**
 * node-floor.test.js — el piso de Node del arnés.
 *
 * POR QUÉ. Con Node 12 en el PATH, cada hook y cada comando que el paso le manda correr al modelo moría con un
 * `SyntaxError` («non-blocking»): los frenos no corrían y nada lo decía. `scripts/lib/node-floor.js` es lo único que un
 * Node viejo tiene que poder leer: decide si se corre acá, si se vuelve a lanzar con el Node del arnés o si se dice en una
 * línea qué pasa.
 *
 * QUÉ MIDE. La decisión con una versión vieja y con una buena (T6, T7); los frenos con un Node viejo salen 2 y los avisos
 * una vez por sesión (T10); cada script que las instrucciones mandan correr con `node <ruta>` arranca por el piso (T9).
 * Lo real con un Node 12 de verdad está en node-old-real.test.sh (T8, T12).
 *
 * Correr:   node --test scripts/tests/node-floor.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const FLOOR = path.join(ROOT, 'scripts', 'lib', 'node-floor.js');

function home(t, { withNode = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'node-floor-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const tyconHome = path.join(base, '.tycon');
  const bin = process.platform === 'win32' ? path.join(tyconHome, 'node', 'current', 'node.exe') : path.join(tyconHome, 'node', 'current', 'bin', 'node');
  if (withNode) {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.copyFileSync(process.execPath, bin);
    fs.chmodSync(bin, 0o755);
  }
  return { base, tyconHome, bin };
}

// ── T6 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T6 NodeFloor_NodeViejo_ReEjecutaConElDelArnes @story-8.93 @ac-4', (t) => {
  const floor = require(FLOOR);
  const H = home(t);
  const env = { TYCON_HOME: H.tyconHome };
  assert.deepStrictEqual(floor.decide({ version: 'v12.11.1', env }).action, 'relaunch');
  assert.strictEqual(floor.decide({ version: 'v12.11.1', env }).bin, H.bin);
  assert.strictEqual(floor.decide({ version: 'v22.3.0', env }).action, 'run');
  assert.strictEqual(floor.decide({ version: 'v20.0.0', env }).action, 'run');
  assert.strictEqual(floor.decide({ version: 'v19.9.0', env }).action, 'relaunch');

  // de punta a punta: un guion que dice con qué Node corrió, lanzado por el piso como si el Node fuera el 12
  const script = path.join(H.base, 'dice-version.js');
  fs.writeFileSync(script, "process.stdout.write(process.argv.slice(2).join(',') + '|' + (require.main === module) + '|' + require('fs').readFileSync(0,'utf8'));process.exit(7);\n");
  const r = spawnSync(process.execPath, [FLOOR, script, 'a', 'b'], { encoding: 'utf8', input: 'entrada', env: Object.assign({}, process.env, env, { TYCON_NODE_FLOOR_FAKE_VERSION: 'v12.11.1' }) });
  assert.strictEqual(r.status, 7, r.stderr);
  assert.strictEqual(r.stdout, 'a,b|true|entrada', 'mismos argumentos, misma entrada, el guion es el principal');
  // una entrada grande (más que un búfer) llega entera al relanzado: un freno no evalúa un evento trunco
  const big = 'x'.repeat(300000);
  const cuenta = path.join(H.base, 'cuenta.js');
  fs.writeFileSync(cuenta, "process.stdout.write(String(require('fs').readFileSync(0).length));\n");
  const rb = spawnSync(process.execPath, [FLOOR, '--gate', cuenta], { encoding: 'utf8', input: big, env: Object.assign({}, process.env, env, { TYCON_NODE_FLOOR_FAKE_VERSION: 'v12.11.1' }) });
  assert.strictEqual(rb.stdout, String(big.length), `llegó ${rb.stdout} de ${big.length}: ${rb.stderr}`);
  // el relanzado sale sin leer la entrada (escribírsela da EPIPE): no es una falla al lanzar, vale su código de salida
  const sinLeer = path.join(H.base, 'sin-leer.js');
  fs.writeFileSync(sinLeer, 'process.exit(3);\n');
  const re = spawnSync(process.execPath, [FLOOR, '--gate', sinLeer], { encoding: 'utf8', input: big, env: Object.assign({}, process.env, env, { TYCON_NODE_FLOOR_FAKE_VERSION: 'v12.11.1' }) });
  assert.strictEqual(re.status, 3, `sale con el código del guion: ${re.stderr}`);
  assert.doesNotMatch(re.stderr, /no pude lanzar/);
});

// ── T7 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T7 NodeFloor_SinNodeDelArnes_LineaLegible @story-8.93 @ac-4', (t) => {
  const floor = require(FLOOR);
  const H = home(t, { withNode: false });
  const d = floor.decide({ version: 'v12.11.1', env: { TYCON_HOME: H.tyconHome } });
  assert.strictEqual(d.action, 'fail');
  // un comando del modelo: la entrada de un guion que arranca por el piso
  const main = path.join(H.base, 'nada-main.js');
  fs.writeFileSync(main, 'process.exit(0);\n');
  const entry = path.join(H.base, 'nada.js');
  fs.writeFileSync(entry, `require(${JSON.stringify(FLOOR)}).launch(${JSON.stringify(main)});\n`);
  const r = spawnSync(process.execPath, [entry], { encoding: 'utf8', env: Object.assign({}, process.env, { TYCON_HOME: H.tyconHome, TYCON_NODE_FLOOR_FAKE_VERSION: 'v12.11.1' }) });
  assert.strictEqual(r.status, 1);
  const lines = r.stderr.trim().split('\n');
  assert.strictEqual(lines.length, 1, `una sola línea: ${r.stderr}`);
  assert.match(lines[0], /Node 12\.11\.1: el arnés necesita Node 20 o más; corré `.+install-tycon-hooks\.(sh|ps1).*`/);
  assert.doesNotMatch(r.stderr, /SyntaxError/);
});

// ── T10 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T10 NodeFloor_FrenoConNodeViejo_SaleDos @story-8.93 @ac-5', (t) => {
  const H = home(t, { withNode: false });
  const script = path.join(H.base, 'hook.js');
  fs.writeFileSync(script, 'process.exit(0);\n');
  const env = Object.assign({}, process.env, { TYCON_HOME: H.tyconHome, TYCON_NODE_FLOOR_FAKE_VERSION: 'v12.11.1' });
  const evento = JSON.stringify({ session_id: 'sesion-de-juguete', hook_event_name: 'PreToolUse' });
  // un freno antes de una herramienta: cerrado
  const gate = spawnSync(process.execPath, [FLOOR, '--gate', script], { encoding: 'utf8', input: evento, env });
  assert.strictEqual(gate.status, 2, 'el freno falla cerrado');
  assert.match(gate.stderr, /Node 12\.11\.1: el arnés necesita Node 20 o más/);
  // un Stop o un hook que no frena: 0, con la línea la primera vez y sin ella la segunda en la misma sesión
  const first = spawnSync(process.execPath, [FLOOR, script], { encoding: 'utf8', input: evento, env });
  assert.strictEqual(first.status, 0);
  assert.match(first.stderr, /Node 12\.11\.1/);
  const second = spawnSync(process.execPath, [FLOOR, script], { encoding: 'utf8', input: evento, env });
  assert.strictEqual(second.status, 0);
  assert.strictEqual(second.stderr, '', 'la segunda vez de la misma sesión no repite el aviso');
  assert.ok(fs.existsSync(path.join(H.tyconHome, 'state', 'node-floor', 'sesion-de-juguete')));
  // otra sesión vuelve a avisar
  const other = spawnSync(process.execPath, [FLOOR, script], { encoding: 'utf8', input: JSON.stringify({ session_id: 'otra' }), env });
  assert.match(other.stderr, /Node 12\.11\.1/);
});

// ── T10 (bordes: señal, bucle, versión falsa, sin sesión) ───────────────────────────────────────────────────────────
test('T10 NodeFloor_FrenoRelanzado_MuertoPorSenal_BucleYVersionFalsa @story-8.93 @ac-5', { skip: process.platform === 'win32' && 'las señales y el envoltorio de shell se miden en la 182' }, (t) => {
  const H = home(t, { withNode: false });
  const bin = H.bin;
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const script = path.join(H.base, 'hook.js');
  fs.writeFileSync(script, 'process.exit(0);\n');
  const base = Object.assign({}, process.env, { TYCON_HOME: H.tyconHome, TYCON_NODE_FLOOR_FAKE_VERSION: 'v12.11.1' });
  const evento = JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse' });
  // el Node del arnés muere por una señal: en un freno, cerrado (2) y dicho
  fs.writeFileSync(bin, '#!/bin/sh\nkill -9 $$\n'); fs.chmodSync(bin, 0o755);
  const killed = spawnSync(process.execPath, [FLOOR, '--gate', script], { encoding: 'utf8', input: evento, env: base });
  assert.strictEqual(killed.status, 2, `un freno cuyo relanzado muere no queda abierto: ${killed.status}`);
  assert.match(killed.stderr, /se cortó|señal/);
  // el Node del arnés está pero no se puede lanzar (sin permiso de ejecución): en un freno, cerrado
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n'); fs.chmodSync(bin, 0o644);
  const noexec = spawnSync(process.execPath, [FLOOR, '--gate', script], { encoding: 'utf8', input: evento, env: base });
  assert.strictEqual(noexec.status, 2, 'un Node del arnés que no arranca no abre el freno');
  assert.match(noexec.stderr, /no pude lanzar el Node del arnés/);
  // el «Node del arnés» también es viejo: una sola vuelta y la línea legible, nunca un bucle
  fs.writeFileSync(bin, `#!/bin/sh\nexport TYCON_NODE_FLOOR_FAKE_VERSION=v12.11.1\nexec "${process.execPath}" "$@"\n`); fs.chmodSync(bin, 0o755);
  const loop = spawnSync(process.execPath, [FLOOR, '--gate', script], { encoding: 'utf8', input: evento, env: base, timeout: 20000 });
  assert.strictEqual(loop.status, 2, 'sin bucle: el freno falla cerrado');
  assert.match(loop.stderr, /el Node del arnés también es viejo|Node 12\.11\.1/);
  // la versión falsa sólo baja: con un Node viejo de verdad no puede hacer de cuenta que es nuevo
  const floor = require(FLOOR);
  assert.strictEqual(floor.effectiveVersion({ TYCON_NODE_FLOOR_FAKE_VERSION: 'v99.0.0' }, 'v12.11.1'), 'v12.11.1');
  assert.strictEqual(floor.effectiveVersion({ TYCON_NODE_FLOOR_FAKE_VERSION: 'v12.11.1' }, 'v24.1.0'), 'v12.11.1');
  // un evento sin session_id: el aviso de un no-freno sale una vez por día
  const H2 = home(t, { withNode: false });
  const env2 = Object.assign({}, process.env, { TYCON_HOME: H2.tyconHome, TYCON_NODE_FLOOR_FAKE_VERSION: 'v12.11.1' });
  const a = spawnSync(process.execPath, [FLOOR, script], { encoding: 'utf8', input: '{}', env: env2 });
  const b = spawnSync(process.execPath, [FLOOR, script], { encoding: 'utf8', input: '{}', env: env2 });
  assert.match(a.stderr, /Node 12\.11\.1/);
  assert.strictEqual(b.stderr, '', 'sin sesión, una vez por día');
  assert.ok(fs.readdirSync(path.join(H2.tyconHome, 'state', 'node-floor')).some((n) => n.startsWith('dia-')));
  // con un Node bueno, la marca de relanzado no se hereda a lo que el guion lance después
  const hereda = path.join(H2.base, 'hereda.js');
  fs.writeFileSync(hereda, `require(${JSON.stringify(FLOOR)}).guard(); process.stdout.write(String(process.env.TYCON_NODE_FLOOR_RELAUNCHED));\n`);
  const rh = spawnSync(process.execPath, [hereda], { encoding: 'utf8', env: Object.assign({}, process.env, { TYCON_NODE_FLOOR_RELAUNCHED: '1' }) });
  assert.strictEqual(rh.stdout, 'undefined');
  // guard({ onlyReexec }) sin Node del arnés no dice nada: el guion dice lo suyo
  const own = path.join(H2.base, 'own.js');
  fs.writeFileSync(own, `require(${JSON.stringify(FLOOR)}).guard({ onlyReexec: true }); process.stdout.write('sigue');\n`);
  const r = spawnSync(process.execPath, [own], { encoding: 'utf8', env: env2 });
  assert.strictEqual(r.stdout, 'sigue');
  assert.strictEqual(r.status, 0);
});

// ── T9 (semántica de lo reescrito) ──────────────────────────────────────────────────────────────────────────────────
test('T9 Reescritura_SinSintaxisNueva_MismaSemantica @story-8.93 @ac-4', () => {
  // los `??` reescritos para que un Node viejo lea el guion conservan la semántica exacta: sólo null y undefined toman el
  // valor por defecto; 0, '' y false se quedan (con `||` se perderían)
  const files = ['scripts/nightly/watcher/vigilante.js', 'skills/tycon-pipeline/scripts/lib/story-discovery.js', 'scripts/tools/work-in-progress.js'];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const m = text.match(/function nn\(v, d\) \{[^\n]*\}/) || text.match(/const nn = \(v, d\) => \([^\n]*\);/);
    assert.ok(m, `${rel}: trae su ayudante nn`);
    const nn = new Function(`${m[0]}; return nn;`)();
    for (const keep of [0, '', false, NaN]) assert.ok(Object.is(nn(keep, 'def'), keep), `${rel}: nn(${String(keep)}) se queda`);
    for (const nil of [null, undefined]) assert.strictEqual(nn(nil, 'def'), 'def', `${rel}: nn(${String(nil)}) toma el defecto`);
  }
  // marker.js y pipeline.js: isNil, nn y at (el reemplazo de `?.`) con la misma semántica
  for (const rel of ['skills/tycon-pipeline/scripts/marker.js', 'skills/tycon-pipeline/scripts/pipeline.js']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const m = text.match(/const isNil = [^\n]*\nconst nn = [^\n]*\nconst at = [^\n]*/);
    assert.ok(m, `${rel}: trae isNil, nn y at`);
    const { nn, at } = new Function(`${m[0]}; return { nn, at };`)();
    for (const keep of [0, '', false]) {
      assert.ok(Object.is(nn(keep, 'def'), keep), `${rel}: nn(${JSON.stringify(keep)}) se queda`);
      assert.ok(Object.is(at({ k: keep }, 'k'), keep), `${rel}: at() devuelve ${JSON.stringify(keep)} tal cual`);
      assert.strictEqual(at(keep === false ? null : undefined, 'k'), undefined);
    }
    assert.strictEqual(nn(null, 'def'), 'def');
    assert.strictEqual(nn(undefined, 'def'), 'def');
    assert.strictEqual(at('', 'length'), 0, 'un string vacío no es «no hay»: `?.` lo lee igual');
  }
  // y los reemplazos sin ayudante usan el chequeo explícito, nunca `||` sobre el valor que reemplaza a un `??`
  for (const rel of ['scripts/instincts/instinct-promote.js', 'scripts/instincts/instinct-observer.js', 'skills/tycon-pipeline/scripts/mockup.js', 'scripts/nightly/dashboard/dashboard.js', 'skills/tycon-pipeline/scripts/step-7c-macro.js']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(text, /=== undefined \|\| [^\n]* === null \?/, `${rel}: el chequeo explícito de null o undefined`);
  }
});

// ── T9 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// el inventario lo comparte con node-old-real.test.sh, que lee cada script con un Node 12 de verdad
const INV = require('./node-floor-inventory.js');
/** `?.` o `??` fuera de un comentario: lo que un Node viejo no puede leer (lo real lo mide node-old-real.test.sh). */
const modernLines = (text) => text.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => !/^\s*(\/\/|\*|\/\*)/.test(l) && /\?\.|\?\?/.test(l.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''")));

test('T9 Inventario_CadaNodeDeLasInstrucciones_TienePiso @story-8.93 @ac-4', () => {
  const named = INV.namedInInstructions();
  assert.ok(named.size >= 15, `encontré ${named.size} scripts nombrados en las instrucciones`);
  const sinPiso = [];
  // un script de otro repo (bmad, terceros) no está en este árbol: el inventario no lo trae
  for (const { rel, where, pending } of INV.inventory()) {
    if (pending) continue;
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (!/require\([^)]*node-floor(\.js)?['"]\)/.test(text)) sinPiso.push(`${rel} (nombrado en ${where})`);
    // la guarda antes de cualquier otro require: si no, un módulo con sintaxis nueva revienta antes de llegar a ella
    else if (text.search(/require\(\s*['"][^'"]*node-floor/) > text.search(/require\(\s*['"](?![^'"]*node-floor)/) && text.search(/require\(\s*['"](?![^'"]*node-floor)/) >= 0) sinPiso.push(`${rel}: la guarda no es el primer require`);
    // con piso, el archivo mismo tiene que poder leerlo un Node viejo: si no, muere antes de llegar a la guarda
    for (const [n] of modernLines(text)) sinPiso.push(`${rel}:${n} usa ?. o ?? (un Node viejo no lo lee)`);
  }
  assert.deepStrictEqual(sinPiso, [], 'cada script nombrado arranca por el piso');
});

// el inventario mide el guion que la instrucción manda correr: por la ruta que nombra, no un atajo viejo ni un archivo
// que se llama igual en otra carpeta; si ningún archivo calza con esa ruta, los que se llaman igual
test('T9 Inventario_BuscaPorLaRutaQueNombraLaInstruccion @story-8.135', () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'node-floor-inv-'));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(lab, rel)), { recursive: true }); fs.writeFileSync(path.join(lab, rel), text); };
  put('commands/lab.md', 'Correr `node <arnés>/scripts/new/tool.js` y después `node $SKILL_DIR/loose.js`.\n');
  put('scripts/new/tool.js', "const fs = require('fs');\n");
  put('scripts/tool.js', '// atajo viejo\n');
  put('tasks/x/tool.js', '// otro archivo que se llama igual\n');
  put('scripts/a/loose.js', '// sin ruta que calce\n');
  put('scripts/b/loose.js', '// sin ruta que calce\n');
  spawnSync('git', ['init', '-q'], { cwd: lab });
  const rels = INV.inventory(lab).map((s) => s.rel).sort();
  assert.deepStrictEqual(rels, ['scripts/a/loose.js', 'scripts/b/loose.js', 'scripts/new/tool.js'], 'por la ruta nombrada; por el nombre si ninguna calza');
  fs.rmSync(lab, { recursive: true, force: true });
});

// el respaldo por nombre se decide por cada ruta nombrada, y una ruta relativa a la carpeta de la skill calza con el
// archivo que termina en ella: un guion nombrado así no se cae del inventario porque otro que se llama igual calce
test('T9 Inventario_CadaRutaNombradaCuentaPorSuCuenta @story-8.135', () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'node-floor-inv-'));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(lab, rel)), { recursive: true }); fs.writeFileSync(path.join(lab, rel), text); };
  put('skills/a/SKILL.md', 'Correr `node skills/a/scripts/run.js`.\n');
  put('skills/b/SKILL.md', 'Correr `node <skill>/scripts/run.js`.\n');
  put('skills/a/scripts/run.js', '// a\n');
  put('skills/b/scripts/run.js', '// b\n');
  put('skills/s/SKILL.md', 'Correr `node lib/discovery.js`.\n');
  put('lib/discovery.js', '// el que se llama igual en la raíz\n');
  put('skills/s/scripts/lib/discovery.js', '// el que corre la skill\n');
  spawnSync('git', ['init', '-q'], { cwd: lab });
  const rels = INV.inventory(lab).map((s) => s.rel).sort();
  assert.deepStrictEqual(rels, ['lib/discovery.js', 'skills/a/scripts/run.js', 'skills/b/scripts/run.js', 'skills/s/scripts/lib/discovery.js'], 'cada ruta nombrada trae lo suyo');
  fs.rmSync(lab, { recursive: true, force: true });
});
