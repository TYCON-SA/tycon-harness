'use strict';
/**
 * tool-names.test.js — el control de los nombres de las herramientas de horas fuera de su lugar (scripts/ci/tool-names.js).
 * stable-data: los commits de los repos de juguete van con fecha fija y sin mantenimiento.
 *
 * POR QUÉ. El núcleo del arnés no nombra herramientas (guides/constitucion.md): lo propio de cada una vive en su
 * integración. Sin un control que cuente, un nombre vuelve a entrar con el próximo arreglo apurado y nadie lo ve.
 *
 * QUÉ MIDE. Que sólo cuenta lo del núcleo (no las zonas permitidas ni las rutas que apuntan a una integración) y que un
 * commit sobre el techo no pasa, con archivo, línea y regla (T62); que una excepción sin motivo o que ya no encuentra el
 * nombre frena, y que una excepción sólo abre su archivo (T63); y que el árbol real cabe en su techo, con lo liviano ya
 * sin el nombre (T64). Los nombres de las pruebas de juguete son inventados: salen del manifiesto, como en el árbol real.
 *
 * Correr:   node --test scripts/tests/tool-names.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'scripts', 'ci', 'tool-names.js');
const TN = require(TOOL);
const FIXED = { GIT_AUTHOR_DATE: '2026-10-22T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-22T00:00:00Z' };

function git(dir, args) {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@acme.example', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { encoding: 'utf8', env: { ...process.env, ...FIXED } });
}
/** Un repo de juguete con una integración de horas «acmetime» (y su skill «acmeclock»), sus reglas y sus archivos. */
function toyRepo(files, rules) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-names-'));
  git(dir, ['init', '-q', '-b', 'main']);
  const all = {
    'integrations/acmetime/integration.json': JSON.stringify({ name: 'acmetime', label: 'Acme', kind: 'timeTracking', hooks: [], dispatch: [], skills: ['skills/acmeclock'], settings: [] }),
    'integrations/acmenote/integration.json': JSON.stringify({ name: 'acmenote', label: 'Avisos', kind: 'notify', hooks: [], dispatch: [], skills: [], settings: [] }),
    'scripts/ci/tool-names.json': JSON.stringify(rules),
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git(dir, ['add', '-A']);
  return dir;
}
const cli = (dir) => spawnSync(process.execPath, [TOOL, '--repo', dir], { encoding: 'utf8' });

test('T62 ToolNames_CountsOutsideZones_BlocksAboveCeiling @story-7.40 @ac-28', () => {
  const dir = toyRepo({
    'scripts/lib/a.js': '// abre el reloj de AcmeTime\nconst x = "acmetime";\n',
    'guides/z.md': 'La guía está en `guides/integrations/acmetime.md`; el guion, en `integrations/acmetime/scripts/x.js` y `@int:acmetime/scripts/x.js`.\n',
    'guides/integrations/acmetime.md': 'acmetime acmeclock\n',
    'scripts/tests/y.test.js': 'acmetime\n',
    'skills/s/scripts/tests/z.js': 'acmeclock\n',
    'scripts/controls-bench/cases/c.json': '"acmetime"\n',
    'docs/avisos.md': 'acmenote no es de horas\n',
  }, { exceptions: [], ceiling: { 'scripts/lib/a.js': 2 } });
  assert.deepStrictEqual(TN.termsOf(dir), ['acmeclock', 'acmetime'], 'los nombres salen de los manifiestos de horas (nombre y skills)');
  const r = TN.check({ repo: dir });
  assert.deepStrictEqual(r.perFile, { 'scripts/lib/a.js': 2 }, 'sólo cuenta lo del núcleo, sin rutas ni zonas permitidas');
  assert.strictEqual(r.ok, true, r.problems.join('\n'));
  assert.strictEqual(cli(dir).status, 0);
  // una mención nueva en el mismo archivo, y un archivo nuevo: frenan con archivo, línea y regla
  fs.appendFileSync(path.join(dir, 'scripts/lib/a.js'), 'const y = "AcmeClock";\n');
  fs.writeFileSync(path.join(dir, 'INDEX.md'), 'Instalar acmetime (opcional)\n');
  git(dir, ['add', '-A']);
  const bad = cli(dir);
  assert.strictEqual(bad.status, 1, bad.stdout + bad.stderr);
  const out = bad.stdout + bad.stderr;
  assert.match(out, /scripts\/lib\/a\.js:3/);
  assert.match(out, /INDEX\.md:1/);
  assert.match(out, /techo/);
  // una ruta con `\` (Windows, o doble en un texto JSON) es la misma dirección; una que no empieza en borde de palabra, o
  // que sale de la integración con `..`, no es una ruta; una palabra que sólo empieza igual no nombra la herramienta; un
  // archivo que se llama como una clave del prototipo es un archivo más; el color forzado de git no cambia nada
  const edge = toyRepo({
    'docs/win.md': 'pwsh ~\\.claude\\tycon-harness\\integrations\\acmetime\\scripts\\x.ps1 y "C:\\\\x\\\\integrations\\\\acmetime\\\\y.js"\n',
    'docs/no.md': "const a = 'myintegrations/acmetime-api';\nrequire('../../integrations/../scripts/acmetime.js');\n",
    'docs/words.md': 'acmeclocking no es el nombre; ACMETIME_KEY y acmetimeApi sí lo son\n',
    // en la raíz: el nombre del archivo es exactamente la clave del prototipo (la clave computada la deja como propia)
    ['__proto__']: 'acmetime\n',
  }, { exceptions: [], ceiling: { 'docs/no.md': 2, 'docs/words.md': 2, ['__proto__']: 1 } });
  const e = TN.check({ repo: edge });
  assert.deepStrictEqual(e.perFile, { 'docs/no.md': 2, 'docs/words.md': 2, ['__proto__']: 1 }, JSON.stringify(e.perFile));
  // sin su techo, el archivo `__proto__` frena como cualquier otro (no hereda un techo del prototipo)
  const sinTecho = toyRepo({ ['__proto__']: 'acmetime\n' }, { exceptions: [], ceiling: {} });
  assert.ok(TN.check({ repo: sinTecho }).problems.some((p) => p.startsWith('__proto__:')));
  // reglas con un techo o un mínimo que no son enteros: no pude mirar
  for (const bad of [{ ceiling: { 'a.js': 'dos' } }, { ceiling: [] }, { terms_at_least: -1 }]) {
    const b = toyRepo({}, bad);
    assert.strictEqual(cli(b).status, 2, JSON.stringify(bad));
  }
  assert.strictEqual(e.ok, true, e.problems.join('\n'));
  const colored = spawnSync(process.execPath, [TOOL, '--repo', edge], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'color.grep', GIT_CONFIG_VALUE_0: 'always', GIT_CONFIG_KEY_1: 'color.ui', GIT_CONFIG_VALUE_1: 'always' } });
  assert.strictEqual(colored.status, 0, colored.stdout + colored.stderr);
  // lo que cuenta es lo que va al commit (el índice), no lo que quedó sin agregar
  git(dir, ['reset', '-q', 'INDEX.md']);
  git(dir, ['checkout', '-q', '--', 'scripts/lib/a.js']);
  assert.strictEqual(cli(dir).status, 1, 'INDEX.md sin agregar no cuenta, pero a.js en el índice sí');
});

test('T63 ToolNames_Exceptions_ReasonAndStale @story-7.40 @ac-29', () => {
  const files = {
    'scripts/lib/legacy.js': 'lee la llave vieja acmetime\n',
    'scripts/lib/otra.js': 'acmetime\n',
    'scripts/lib/limpio.js': 'nada\n',
  };
  const ok = toyRepo(files, { exceptions: [{ path: 'scripts/lib/legacy.js', reason: 'lee la llave vieja de las máquinas de hoy' }], ceiling: { 'scripts/lib/otra.js': 1 } });
  assert.strictEqual(TN.check({ repo: ok }).ok, true, 'la excepción con motivo deja pasar su archivo');
  const sinMotivo = toyRepo(files, { exceptions: [{ path: 'scripts/lib/legacy.js', reason: '' }], ceiling: { 'scripts/lib/otra.js': 1 } });
  const a = TN.check({ repo: sinMotivo });
  assert.ok(!a.ok && a.problems.some((p) => /scripts\/lib\/legacy\.js.*sin motivo/.test(p)), a.problems.join('\n'));
  const vieja = toyRepo(files, { exceptions: [{ path: 'scripts/lib/legacy.js', reason: 'x' }, { path: 'scripts/lib/limpio.js', reason: 'ya no hace falta' }], ceiling: { 'scripts/lib/otra.js': 1 } });
  const b = TN.check({ repo: vieja });
  assert.ok(!b.ok && b.problems.some((p) => /scripts\/lib\/limpio\.js.*ya no/.test(p)), b.problems.join('\n'));
  // una excepción no abre otro archivo: sin techo, otra.js frena aunque legacy.js esté exceptuado
  const sola = toyRepo(files, { exceptions: [{ path: 'scripts/lib/legacy.js', reason: 'x' }], ceiling: {} });
  const c = TN.check({ repo: sola });
  assert.ok(!c.ok && c.problems.some((p) => /scripts\/lib\/otra\.js:1/.test(p)), c.problems.join('\n'));
  // una excepción con comodines no vale: abriría archivos que nadie miró
  const comodin = toyRepo(files, { exceptions: [{ path: 'scripts/lib/*.js', reason: 'x' }], ceiling: {} });
  assert.ok(TN.check({ repo: comodin }).problems.some((p) => /comod/.test(p)));
  // una excepción sin archivo frena
  const sinPath = toyRepo(files, { exceptions: [{ reason: 'x' }], ceiling: { 'scripts/lib/otra.js': 1, 'scripts/lib/legacy.js': 1 } });
  assert.ok(TN.check({ repo: sinPath }).problems.some((p) => /sin «path»/.test(p)));
  // unas reglas que no se leen no son «no hay reglas»
  const rotas = toyRepo(files, {});
  fs.writeFileSync(path.join(rotas, 'scripts/ci/tool-names.json'), '{ no es json');
  git(rotas, ['add', '-A']);
  assert.strictEqual(cli(rotas).status, 2, 'no pude mirar: sale 2');
  // «no pude mirar» no es «cero»: un manifiesto ilegible, uno de horas sin nombre, o menos nombres que los que esperan
  // las reglas (un manifiesto de horas que se borró o cambió de tipo) salen 2
  const ilegible = toyRepo(files, { exceptions: [], ceiling: {} });
  fs.writeFileSync(path.join(ilegible, 'integrations/acmetime/integration.json'), '{ roto');
  git(ilegible, ['add', '-A']);
  assert.strictEqual(cli(ilegible).status, 2);
  const sinNombre = toyRepo({ ...files, 'integrations/otra/integration.json': JSON.stringify({ kind: 'timeTracking', name: '' }) }, { exceptions: [], ceiling: {} });
  assert.strictEqual(cli(sinNombre).status, 2);
  // un nombre que git leería como una opción no llega a git
  const opcion = toyRepo({ ...files, 'integrations/otra/integration.json': JSON.stringify({ kind: 'timeTracking', name: '--open-files-in-pager=touch' }) }, { exceptions: [], ceiling: {} });
  const o = cli(opcion);
  assert.strictEqual(o.status, 2, o.stdout + o.stderr);
  assert.match(o.stderr, /no es un nombre de integración/);
  const menos = toyRepo(files, { terms_at_least: 3, exceptions: [], ceiling: { 'scripts/lib/otra.js': 1, 'scripts/lib/legacy.js': 1 } });
  const m = cli(menos);
  assert.strictEqual(m.status, 2, m.stdout + m.stderr);
  assert.match(m.stderr, /al menos 3/);
  // un archivo que git toma por binario (con un NUL) también se lee; una imagen no
  const binario = toyRepo({ 'scripts/lib/raro.dat': 'a\0b acmetime\n', 'docs/foto.png': 'acmetime' }, { exceptions: [], ceiling: {} });
  const r = TN.check({ repo: binario });
  assert.deepStrictEqual(Object.keys(r.perFile), ['scripts/lib/raro.dat'], JSON.stringify(r.perFile));
});

test('T64 ToolNames_RealTree_UnderCeiling @story-7.40 @ac-28 @ac-30', (t) => {
  // el repo de mantenimiento adelgazado no se publica: con --skip-thin (lo pasa sólo su pre-commit propio) el control lo
  // dice y no cuenta; sin la opción, el archivo del árbol no alcanza para apagarlo (un commit al público podría agregarlo)
  const thin = toyRepo({ '.tycon/internal-forms.json': JSON.stringify({ layout: 'thin' }), 'specs/s.md': 'acmetime\n' }, { exceptions: [], ceiling: {} });
  const th = TN.check({ repo: thin, skipThin: true });
  assert.ok(th.ok && th.skipped && /no se publica/.test(th.notes.join(' ')), JSON.stringify(th));
  assert.ok(!TN.check({ repo: thin }).ok, 'sin --skip-thin cuenta igual');
  const skipped = spawnSync(process.execPath, [TOOL, '--repo', thin, '--skip-thin'], { encoding: 'utf8' });
  assert.ok(skipped.status === 0 && /SALTEADO/.test(skipped.stdout) && !/✅/.test(skipped.stdout), skipped.stdout);
  const r = TN.check({ repo: ROOT, skipThin: true });
  if (r.skipped) { t.skip('el árbol es el repo de mantenimiento adelgazado: lo mide la copia del público'); return; }
  assert.strictEqual(r.ok, true, r.problems.join('\n'));
  assert.deepStrictEqual(r.notes, [], 'el techo está justo: ninguno quedó por encima de lo que cuenta su archivo');
  assert.ok(TN.termsOf(ROOT).length >= 2, 'el árbol real tiene integraciones de horas');
  // el control corre en el pre-commit y desde la base en la CI
  assert.match(fs.readFileSync(path.join(ROOT, '.githooks', 'pre-commit-checks'), 'utf8'), /^(?!\s*#).*scripts\/ci\/tool-names\.js/m, 'en una línea que corre, no en un comentario');
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'controls-from-base.json'), 'utf8'));
  assert.ok(base.controls.some((c) => c.script === 'scripts/ci/tool-names.js' && c.rules.includes('scripts/ci/tool-names.json')), 'en el inventario de controles desde la base, con su regla');
  // lo liviano (E1) ya no nombra la herramienta: las guías del núcleo y los textos que ve el agente (las capturas del
  // sitio sacan los nombres de lo que lee el núcleo, y se limpian con él en la E2)
  const light = ['INDEX.md', 'guides/constitucion.md', 'guides/workflow-orchestration.md', 'guides/git-worktrees.md',
    'guides/harness-cost-tiering.md', 'guides/piezas-del-arnes.md', 'guides/maintaining/piezas-en-detalle.md',
    'skills/tycon-pipeline/scripts/on-prompt.js', 'skills/tycon-pipeline/steps/step-00-preflight.md'];
  for (const f of light) assert.ok(!r.perFile[f], `${f} todavía nombra la herramienta (${r.perFile[f]})`);
  assert.ok(!fs.existsSync(path.join(ROOT, 'scripts', 'setup', 'install-clockify-mcp.sh')) && fs.existsSync(path.join(ROOT, 'integrations', 'clockify', 'scripts', 'install-mcp.sh')), 'el instalador del MCP vive en su integración');
});
