'use strict';

/**
 * config-lint.test.js — el chequeo determinístico de `.tycon/advisors.yaml`.
 *
 * Los tres modos de falla que cubre son todos SILENCIOSOS: una llave que nadie lee, una regla
 * declarada que no puede disparar, y una cobertura que se achica de a una línea por vez.
 *
 * 🔴 El caso que mide el catálogo contra las configuraciones REALES de la máquina vive aparte, en
 * `config-lint-real-configs.test.js`: depende del disco del dev, y en la suite del
 * arranque un proyecto viejo frenaba la actualización del arnés entero.
 *
 * Parte PURA (sin git, sin spawns, sin mirar el disco del dev) — corre en cada arranque.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cl = require('../lib/config-lint.js');

function labConSpec(contenidoSpec) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clint-'));
  fs.mkdirSync(path.join(d, 'tests', 'e2e'), { recursive: true });
  fs.writeFileSync(path.join(d, 'tests', 'e2e', 'a.spec.ts'), contenidoSpec);
  return d;
}

// ── (1) llaves que nadie lee ──────────────────────────────────────────────────────────────────
test('una llave de primer nivel que nadie lee se nombra', () => {
  // Un repo puede declarar `advisors:` con la lista de revisores.
  // Ninguna parte del arnés la consulta — el set lo computa el pipeline a partir del diff.
  const h = cl.lintEsquema('advisors:\n  - tycon-story-validator\ni18n:\n  required: false\n');
  assert.equal(h.length, 1);
  assert.equal(h[0].tipo, 'llave-desconocida');
  assert.match(h[0].mensaje, /advisors:/);
});

test('una llave hija mal escrita se nombra con su bloque', () => {
  const h = cl.lintEsquema('e2e:\n  gate: x.sh\n  critical_manifiest: y.txt\n');
  assert.equal(h.length, 1);
  assert.match(h[0].llave, /^e2e\.critical_manifiest$/);
});

test('una llave anidada de más se reporta como fuera de lugar', () => {
  const h = cl.lintEsquema('e2e:\n  gate: x.sh\n  forms:\n    UTAU:\n      critical_manifest: y.txt\n');
  assert.ok(h.some((x) => x.tipo === 'llave-desconocida' && /forms/.test(x.llave)));
  assert.ok(h.some((x) => x.tipo === 'llave-anidada'));
});

test('un mapa que define el PROYECTO no se reporta como anidado', () => {
  // `i18n.audiences` es audiencia→idioma: lo de adentro lo elige el repo, no el arnés.
  assert.deepEqual(cl.lintEsquema('i18n:\n  required: true\n  audiences:\n    operator: es\n    lis_integration: en\n'), []);
});

test('merge.mode (modo PR) y pipeline.story_skill_gate son llaves conocidas', () => {
  // Un backend puede declarar `merge: mode: pr` (lo lee tycon-merge-to-main); si el catálogo no la tiene, es un
  // falso positivo en cada arranque. Ídem el kill-switch por repo del freno de story-a-mano.
  const h = cl.lintEsquema('merge:\n  mode: pr\npipeline:\n  story_gate: true\n  story_skill_gate: false\n');
  assert.deepEqual(h, []);
  // y una hija inventada dentro de merge sí se acusa
  assert.equal(cl.lintEsquema('merge:\n  strategy: squash\n').length, 1);
});

test('merge.check (el control que espera un pedido de GitHub) es una llave conocida', () => {
  // Un repo que vive en GitHub declara el nombre exacto del control de su validación (lo lee scripts/tools/merge-pr.js
  // del arnés). Sin la llave en el catálogo, cada repo que la declare vería «llave desconocida» en cada arranque.
  assert.deepEqual(cl.lintEsquema('merge:\n  mode: pr\n  check: "validacion (Veredicto del cambio)"\n'), []);
  // y la inventada de al lado se sigue acusando
  assert.equal(cl.lintEsquema('merge:\n  mode: pr\n  check: x\n  checks: [a, b]\n').length, 1);
});

test('las llaves del PORTÓN E2E no se acusan: bundle (con sus tres hijas) y required_env', () => {
  // 🔴 Sin las dos llaves en el catálogo, este mismo texto daría 5 hallazgos —dos «llave que nadie
  // lee» y TRES «movela al primer nivel» por las hijas de `bundle`—, o sea que el lint mandaría a
  // romper una config legítima. Las dos llaves las lee `e2e-gate.sh`, no `e2eConfig`, que es
  // exactamente el descuido que el catálogo tiene que atajar cuando el arnés crece.
  const yaml = 'e2e:\n  gate: scripts/e2e-gate.sh\n  frontend_dir: app\n  required_env:\n'
    + '    - E2E_AUDIT_REQUIRED\n  bundle:\n    artifact: dist/form.dev.js\n    sources: src\n'
    + '    rebuild: npm run build:dev\n';
  assert.deepEqual(cl.lintEsquema(yaml), []);
  // y una hija inventada dentro de e2e se sigue acusando (el arreglo no aflojó el bloque entero)
  assert.equal(cl.lintEsquema('e2e:\n  llave_inventada: 1\n').length, 1);
});

// ── el catálogo se audita a sí mismo ────────────────────────────────────────────
// 🔴 EL CASO: al catálogo se le pueden escapar llaves propias (`e2e.bundle`, `e2e.required_env`, leídas por
// `e2e-gate.sh`). Un repo que las declare se comería cinco avisos, tres diciéndole que moviera líneas que están
// bien. El caso de los configs reales no lo ve porque sólo mira lo que los repos YA declaran. Estos tres casos
// cierran eso: miden el catálogo contra el CÓDIGO que lee la config, no contra los repos.

function falsoArnes(contenido) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-lint-'));
  fs.writeFileSync(path.join(dir, 'lector.sh'), contenido);
  return dir;
}

test('🔴 una llave nueva que el arnés parsea y el catálogo no registra sale en rojo', () => {
  // El lector falso hace lo mismo que `e2e-gate.sh`: awk anclado sobre el yaml de la config.
  const dir = falsoArnes('# lee .tycon/advisors.yaml\nawk \'/^[[:space:]]*llave_nueva:[[:space:]]*$/ { en=1 }\'\n');
  const faltan = cl.llavesSinRegistrar(dir);
  assert.deepEqual(faltan.map((f) => f.llave), ['llave_nueva']);
  assert.deepEqual(faltan[0].archivos, ['lector.sh'], 'el rojo tiene que decir DÓNDE se lee la llave');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('una llave ya registrada no molesta, y un archivo que no lee la config se ignora', () => {
  const ok = falsoArnes('# lee .tycon/advisors.yaml\nawk \'/^[[:space:]]*preconditions:[[:space:]]*$/ { en=1 }\'\n');
  assert.deepEqual(cl.llavesSinRegistrar(ok), []);
  fs.rmSync(ok, { recursive: true, force: true });
  // sin la mención de la config, el archivo no es un lector: no se le escanean llaves
  const ajeno = falsoArnes('awk \'/^[[:space:]]*otra_cosa:[[:space:]]*$/ { en=1 }\'\n');
  assert.deepEqual(cl.llavesSinRegistrar(ajeno), []);
  fs.rmSync(ajeno, { recursive: true, force: true });
});

test('el catálogo está al día contra el arnés de verdad', () => {
  const scripts = path.join(__dirname, '..');
  const faltan = cl.llavesSinRegistrar(scripts);
  assert.deepEqual(faltan, [],
    `hay llaves que el arnés lee y ESQUEMA no registra: ${faltan.map((f) => `${f.llave} (${f.archivos.join(', ')})`).join(' · ')}`
    + ' — agregalas al catálogo de config-lint.js con su lector, o a NO_SON_DE_LA_CONFIG si no vienen del yaml');
});

// ── (2) regla publicada y muerta ──────────────────────────────────────────────────────────────
test('un patrón de costura que no matchea ningún spec se reporta como regla muerta', () => {
  const d = labConSpec("test('x', async ({page}) => { await page.goto('/'); });\n");
  const h = cl.lintSeamMuerta("e2e_realness:\n  dev_seam_pattern: 'window\\.__ceibo\\w*Store'\n", d);
  assert.equal(h.length, 1);
  assert.equal(h[0].tipo, 'regla-muerta');
  assert.match(h[0].mensaje, /REAL-C3/);
});

test('si el patrón SÍ matchea, no se dice nada', () => {
  const d = labConSpec("await page.evaluate(() => window.__ceiboPanelStore.open());\n");
  assert.deepEqual(cl.lintSeamMuerta("e2e_realness:\n  dev_seam_pattern: 'window\\.__ceibo\\w*Store'\n", d), []);
});

test('un repo SIN specs no se acusa de tener una regla muerta', () => {
  // Sin specs no hay nada que afirmar: acusar ahí sería ruido en todo repo de backend.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clint-vacio-'));
  assert.deepEqual(cl.lintSeamMuerta("e2e_realness:\n  dev_seam_pattern: 'x'\n", d), []);
});

test('un patrón que no es una expresión regular válida se reporta', () => {
  const d = labConSpec('nada\n');
  const h = cl.lintSeamMuerta("e2e_realness:\n  dev_seam_pattern: '([unclosed'\n", d);
  assert.equal(h[0].tipo, 'seam-invalida');
});

// ── (3) la cobertura que se achica ────────────────────────────────────────────────────────────
const EXCL = (...xs) => `e2e_realness:\n  business_endpoint_excludes:\n${xs.map((x) => `    - ${x}`).join('\n')}\n`;

test('una exclusión nueva respecto de lo commiteado se nombra', () => {
  const h = cl.lintExclusionesQueCrecen(EXCL('/api/legacy/', '/api/pedidos/'), EXCL('/api/legacy/'));
  assert.equal(h.length, 1);
  assert.equal(h[0].tipo, 'cobertura-que-baja');
  assert.match(h[0].mensaje, /\/api\/pedidos\//);
  assert.match(h[0].mensaje, /REAL-C2 y REAL-C7/, 'tiene que decir QUÉ afloja, no sólo que cambió');
});

test('sacar una exclusión (subir cobertura) no dispara nada', () => {
  assert.deepEqual(cl.lintExclusionesQueCrecen(EXCL('/api/legacy/'), EXCL('/api/legacy/', '/api/pedidos/')), []);
});

test('sin versión commiteada contra la cual comparar, el chequeo no corre', () => {
  assert.deepEqual(cl.lintExclusionesQueCrecen(EXCL('/api/x/'), null), []);
});

// ── el disparador ─────────────────────────────────────────────────────────────────────────────
test('el hook sólo se activa sobre .tycon/advisors.yaml', () => {
  const { esConfigTycon } = require('../on-config-lint.js');
  assert.equal(esConfigTycon('/r/.tycon/advisors.yaml'), true);
  assert.equal(esConfigTycon('/r/.tycon/advisors.yml'), true);
  assert.equal(esConfigTycon('/r/.tycon/e2e-critical-specs.txt'), false);
  assert.equal(esConfigTycon('/r/src/advisors.yaml'), false, 'un yaml con el mismo nombre fuera de .tycon no es la config del arnés');
  assert.equal(esConfigTycon(''), false);
});
