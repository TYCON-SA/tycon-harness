#!/usr/bin/env node
/**
 * deep-review-shared-surface.test.js — el pase adversarial corre aunque el diff sea chico cuando
 * toca la superficie compartida que el repo declaró, y el repo que NO la declaró lo dice.
 *
 * Por qué: el gate mide TAMAÑO de diff (≤6 archivos → LOW → skip). Los defectos de la
 * superficie compartida no son función del tamaño sino de quién ejecuta el código roto —
 * terminan en terminación del proceso del host, o sea que se llevan puestos a todos los plugins.
 * Un skip por tamaño dejaría pasar la regresión.
 *
 * La 2da mitad del test es igual de importante que la 1ra: la lista es opt-in por repo, así que un
 * repo que nunca la declaró NO está cubierto — y sin constancia eso se lee igual que "no hacía
 * falta". Se declara por repo, y la ausencia deja rastro.
 *
 * Correr: node --test .../scripts/tests/deep-review-shared-surface.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');

// 🔴 Cada laboratorio es un repo git: el portón mide la densidad de cada archivo en SU repo, y un archivo
//    fuera de todo repo git no se cuenta entero en silencio (lo dice y corta). Sin commits, los archivos son nuevos.
function mkRepo(yaml) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-'));
  spawnSync('git', ['-C', r, '-c', 'maintenance.auto=false', 'init', '-q'], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  fs.mkdirSync(path.join(r, 'Services', 'Plugins'), { recursive: true });
  fs.mkdirSync(path.join(r, 'src', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(r, 'Services', 'Plugins', 'PluginManager.cs'), '// x\n');
  fs.writeFileSync(path.join(r, 'Services', 'Plugins', 'EndpointRegistrar.cs'), '// x\n');
  fs.writeFileSync(path.join(r, 'src', 'ui', 'Boton.tsx'), '// x\n');
  fs.writeFileSync(path.join(r, 'story.md'),
    ['---', 'story: 9.3', 'epic: 9', 'status: in-progress', '---', '', '## Acceptance Criteria', '- AC1: x', ''].join('\n'));
  if (yaml !== null) {
    fs.mkdirSync(path.join(r, '.tycon'), { recursive: true });
    fs.writeFileSync(path.join(r, '.tycon', 'advisors.yaml'), yaml);
  }
  return r;
}

// 🔴 HOME temporal SIEMPRE: el gate escribe una constancia en `~/.claude/.tycon-pipeline/gates.log`
// cuando el repo no declaró superficie. Sin HOME temporal, el log REAL del dev se ensuciaría con
// entradas de repos temporales, y ese log es de donde la retrospectiva saca sus métricas. Un test que contamina lo que otro control mide
// es un "instrumento que miente".
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-home-'));

function gate(repo, ...files) {
  const r = spawnSync(process.execPath,
    [PIPELINE, 'deep-review-gate', '--repo', repo, '--story', path.join(repo, 'story.md'), '--files', ...files],
    { encoding: 'utf8', env: { ...process.env, HOME } });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const YAML_CON_LISTA = `# config del repo
deep_review_always_paths:
  - Services/Plugins/**
  - src/Abstractions/**

e2e:
  gate: scripts/e2e-gate.sh
`;

// ── El caso: un diff chico sobre la superficie ──────────────────────────────────────────────────

test('diff CHICO que toca la superficie declarada → corre igual', () => {
  const repo = mkRepo(YAML_CON_LISTA);
  const out = gate(repo, 'Services/Plugins/PluginManager.cs', 'Services/Plugins/EndpointRegistrar.cs');
  assert.equal(out.run, true, '2 archivos = LOW por tamaño, pero es el cargador de plugins');
  assert.equal(out.risk, 'shared-surface');
  assert.equal(out.shared_surface.pattern, 'Services/Plugins/**');
  assert.match(out.reason, /proceso del host/);
});

test('diff chico que NO toca la superficie declarada → sigue salteando (el ahorro no se pierde)', () => {
  const repo = mkRepo(YAML_CON_LISTA);
  const out = gate(repo, 'src/ui/Boton.tsx');
  assert.equal(out.run, false, 'una pantalla no es superficie compartida');
  assert.equal(out.shared_surface_declared, true, 'el repo declaró: el skip es una decisión informada');
  assert.equal(out.shared_surface_note, undefined);
});

// ── La ausencia deja rastro ────────────────────────

test('repo SIN la lista → saltea, pero deja escrito que decidió a ciegas', () => {
  const repo = mkRepo('e2e:\n  gate: scripts/e2e-gate.sh\n');
  const out = gate(repo, 'Services/Plugins/PluginManager.cs');
  assert.equal(out.run, false);
  assert.equal(out.shared_surface_declared, false);
  assert.match(out.shared_surface_note, /NO declaró/);
  assert.match(out.shared_surface_note, /S[ÓO]LO por tamaño de diff/i);
});

test('repo sin .tycon/advisors.yaml → mismo rastro, sin romperse', () => {
  const repo = mkRepo(null);
  const out = gate(repo, 'Services/Plugins/PluginManager.cs');
  assert.equal(out.run, false);
  assert.equal(out.shared_surface_declared, false);
});

// ── Lo que NO cambia ──────────────────────────────────────────────────

test('NORMAL sigue corriendo por su propio criterio, sin pasar por la lista', () => {
  const repo = mkRepo(YAML_CON_LISTA);
  const out = gate(repo, ...Array.from({ length: 7 }, () => 'src/ui/Boton.tsx'));
  assert.equal(out.run, true);
  assert.equal(out.risk, 'NORMAL', 'no lo decidió la superficie compartida');
});

test('el kill-switch sigue ganando sobre la superficie compartida', () => {
  const repo = mkRepo(YAML_CON_LISTA);
  const r = spawnSync(process.execPath,
    [PIPELINE, 'deep-review-gate', '--repo', repo, '--story', path.join(repo, 'story.md'),
      '--no-deep-review', '--files', 'Services/Plugins/PluginManager.cs'],
    { encoding: 'utf8', env: { ...process.env, HOME } });
  const out = JSON.parse(r.stdout);
  assert.equal(out.run, false, 'el kill-switch del dev gana sobre todo, incluida la lista nueva');
});

test('`deep_review: off` del repo sigue ganando sobre la superficie compartida', () => {
  const repo = mkRepo(`deep_review: off\n${YAML_CON_LISTA}`);
  const out = gate(repo, 'Services/Plugins/PluginManager.cs');
  assert.equal(out.run, false);
  assert.match(out.reason, /deep_review: off/);
});

// ── La llave no puede quedar fuera del lint de config ──────────────────

test('el lint de config NO reporta `deep_review_always_paths` como llave desconocida', () => {
  const repo = mkRepo(YAML_CON_LISTA);
  const r = spawnSync(process.execPath, [PIPELINE, 'lint-config', '--repo', repo], { encoding: 'utf8' });
  const salida = r.stdout + r.stderr;
  assert.doesNotMatch(salida, /deep_review_always_paths/,
    'una llave legítima reportada como desconocida hace que el lint se apague');
});

// ── Las formas de escribir la lista (todas las que YAML acepta) ──────────────
// Un parser que entienda SÓLO el bloque con guiones descarta las otras formas EN SILENCIO: el repo
// declara, el pase se saltea igual, y el veredicto afirma que no hay nada declarado. Cada forma de
// la lista está probada por separado.

const FORMAS = {
  'bloque con guiones': 'deep_review_always_paths:\n  - Services/Plugins/**\n\ne2e:\n  gate: x\n',
  'bloque + comentario al final del item': 'deep_review_always_paths:\n  - Services/Plugins/**   # el cargador\n',
  'lista inline [a]': 'deep_review_always_paths: [Services/Plugins/**]\n\ne2e:\n  gate: x\n',
  'lista inline [a, b]': 'deep_review_always_paths: [Services/Plugins/**, src/Abs/**]\n',
  'escalar en el mismo renglón': 'deep_review_always_paths: Services/Plugins/**\n',
  'con comillas y comentario': 'deep_review_always_paths:\n  - "Services/Plugins/**"  # x\n',
  'lista cortada por otra llave': 'deep_review_always_paths:\n  - Services/Plugins/**\ne2e:\n  gate: x\n  frontend_dir: y\n',
};

for (const [nombre, yaml] of Object.entries(FORMAS)) {
  test(`la lista escrita como ${nombre} SÍ surte efecto`, () => {
    const repo = mkRepo(yaml);
    const out = gate(repo, 'Services/Plugins/PluginManager.cs');
    assert.equal(out.run, true, `la forma "${nombre}" se leyó vacía → el control quedó inerte en silencio`);
    assert.equal(out.risk, 'shared-surface');
  });
}

test('la lista cortada por otra llave NO se come las llaves siguientes', () => {
  const repo = mkRepo(FORMAS['lista cortada por otra llave']);
  const out = gate(repo, 'src/ui/Boton.tsx');
  assert.equal(out.run, false, 'un archivo fuera de la superficie no debe matchear `gate: x` como si fuera un glob');
});

test('un path ABSOLUTO del diff matchea igual que uno relativo', () => {
  const repo = mkRepo(YAML_CON_LISTA);
  const out = gate(repo, path.join(repo, 'Services', 'Plugins', 'PluginManager.cs'));
  assert.equal(out.run, true, 'el orquestador pasa absolutos en varios steps');
  assert.equal(out.risk, 'shared-surface');
});

test('`./` adelante tampoco rompe el matcheo', () => {
  const repo = mkRepo(YAML_CON_LISTA);
  const out = gate(repo, './Services/Plugins/PluginManager.cs');
  assert.equal(out.run, true);
});

test('`deep_review: off` con lista declarada lo DICE, no mata en silencio', () => {
  const repo = mkRepo(`deep_review: off\n${YAML_CON_LISTA}`);
  const out = gate(repo, 'Services/Plugins/PluginManager.cs');
  assert.equal(out.run, false, 'el off del repo sigue ganando: es la decisión explícita del dueño');
  assert.match(out.reason, /superficie compartida/i,
    'pero tiene que avisar que está apagando una superficie declarada, o la regla queda publicada y muerta');
});

test('@story-7.26 story de dos repos: un archivo del repo hermano se juzga contra la superficie que declara SU repo', () => {
  // 🔴 Sin esto, el archivo del hermano se saltea («fuera del repo») y un cambio en su superficie
  //    compartida no pide el pase adversarial.
  const a = mkRepo(null);
  const b = mkRepo(YAML_CON_LISTA);
  const out = gate(a, path.join(b, 'Services', 'Plugins', 'PluginManager.cs'));
  assert.equal(out.run, true, JSON.stringify(out));
  assert.equal(out.risk, 'shared-surface');
  assert.equal(out.shared_surface.pattern, 'Services/Plugins/**');
  assert.equal(fs.realpathSync(out.shared_surface.repo), fs.realpathSync(b));
});
