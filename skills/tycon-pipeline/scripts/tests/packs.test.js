'use strict';

/**
 * packs.test.js — los paquetes de revisores.
 *
 * EL AGUJERO QUE CIERRA: los revisores de Bizuit y de clientes vivían escritos en el código del
 * pipeline. Para publicar el núcleo hay que sacarlos, y sacarlos a mano tiene un modo de falla que
 * no da error: un revisor que deja de correr da MENOS hallazgos, no un rojo. Estas pruebas sostienen
 * las dos mitades: (1) un paquete instalado entra al set exactamente como lo declara su manifiesto;
 * (2) un paquete roto, un nombre que no existe o una clave fuera del vocabulario FRENAN el comando
 * nombrando archivo, revisor y motivo — nunca degradan a «sin ese paquete».
 *
 * Cubre T1–T9, T12 y T14. Lanza `pipeline.js` → HOME y sesión aislados (mismo patrón que
 * `advisor-set-config.test.js`: sin esto cada invocación deja una marca `step5-start` falsa en el
 * registro de la sesión viva).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');       // agent-skills
const PACKS_REALES = path.join(RAIZ, 'packs');
const HOME_AISLADO = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-home-'));
// La copia pública sale sin el paquete de clientes. Lo que tres casos miden contra ese paquete REAL
// no se puede medir ahí, y se dice; en el repo del equipo `SKIP_PUBLIC` es false y se mide todo, como siempre.
const { SKIP_PUBLIC, clientPackReviewers, packReviewers } = require('./lib/public-copy.js');

const TC ='tycon-plugin-tests-coverage';
const SB = 'tycon-plugin-security-basics';

function tmp(prefijo) { return fs.mkdtempSync(path.join(os.tmpdir(), prefijo)); }

// ── sin `packs:` en el repo, los paquetes activos los dice `packs.default` (AC 8, T37) ──
// El default lo responde el lector de configuración del arnés (`scripts/lib/tycon-config.js`), ubicado con
// lib/harness-path.js. El arnés de esta máquina se ubica ANTES de aislar la HOME (con la HOME de laboratorio el enlace
// no existe). Las pruebas no le preguntan al arnés real: arman uno de laboratorio con SU lector (copiado) y el perfil
// que cada caso declara: una prueba que cuenta con «todos los instalados» lo declara.
const ARNES_DE_LA_MAQUINA = require('../lib/harness-path.js').rutaArnesHook().dir;
const LECTOR_REAL = ARNES_DE_LA_MAQUINA ? path.join(ARNES_DE_LA_MAQUINA, 'scripts', 'lib', 'tycon-config.js') : null;
/** ¿El lector del arnés de esta máquina ya conoce `packs.default`? (uno más viejo no: NO MEDIDO, nunca verde) */
const LECTOR_CONOCE_LA_CLAVE = (() => {
  try { const v = require(LECTOR_REAL).VOCABULARIO; return !!(v && v.packs && v.packs.default); } catch (_e) { return false; }
})();
/** Un arnés de laboratorio: la marca de clon que pide harness-path, el lector (`real` = copia del de la máquina; un
 *  texto = ése tal cual) y, si se pasa, su `perfil-equipo.json`. */
function arnesDeLaboratorio({ lector = 'real', perfil } = {}) {
  const d = tmp('packs-arnes-');
  fs.mkdirSync(path.join(d, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(d, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/sh\n');
  const texto = lector === 'real' ? fs.readFileSync(LECTOR_REAL, 'utf8') : lector;
  fs.writeFileSync(path.join(d, 'scripts', 'lib', 'tycon-config.js'), texto);
  if (perfil !== undefined) fs.writeFileSync(path.join(d, 'perfil-equipo.json'), JSON.stringify(perfil, null, 2) + '\n');
  return d;
}
// Un lector más viejo: no conoce la clave (compatibilidad de orden de merge entre los dos repos).
const LECTOR_ANTERIOR = "'use strict';\nmodule.exports = { VOCABULARIO: { update: { channel: 'opcion:latest|stable' } } };\n";
// El default que declaran las pruebas de siempre: «todos los instalados».
const ARNES_TODOS = LECTOR_CONOCE_LA_CLAVE ? arnesDeLaboratorio({ perfil: { packs: { default: 'all' } } }) : arnesDeLaboratorio({ lector: LECTOR_ANTERIOR });
function git(dir, ...args) { spawnSync('git', ['-C', dir, ...args], { stdio: 'ignore' }); }

/** Carpeta de agentes de mentira: un `.md` por nombre. */
function agentes(...nombres) {
  const d = tmp('packs-agents-');
  for (const n of nombres) fs.writeFileSync(path.join(d, `${n}.md`), `---\nname: ${n}\n---\n# ${n}\n`);
  return d;
}

/**
 * Carpeta de paquetes: `{ nombre: manifiesto }` (objeto → JSON; string → tal cual, para romperlo). Las instrucciones de
 * cada revisor de prueba (`AGENTES_PRUEBA`) van en la carpeta de agentes de su paquete, que es donde las busca el
 * validador; un revisor que no es de prueba (uno inventado para que falte) queda sin su `.md`.
 */
function paquetes(mapa) {
  const d = tmp('packs-dir-');
  for (const [nombre, contenido] of Object.entries(mapa)) {
    fs.mkdirSync(path.join(d, nombre));
    fs.writeFileSync(path.join(d, nombre, 'pack.json'),
      typeof contenido === 'string' ? contenido : JSON.stringify(contenido, null, 2) + '\n');
    // con las claves de hoy o con las de antes del renombre
    const revisores = typeof contenido === 'object' ? (contenido.reviewers || contenido.revisores) : null;
    if (!Array.isArray(revisores)) continue;
    const carpeta = path.join(d, nombre, typeof contenido.agents === 'string' && contenido.agents ? contenido.agents : 'agents');
    for (const a of new Set(revisores.map((r) => r && (r.agent || r.agente)).filter((a) => [...AGENTES_PRUEBA, 'rev-cableado'].includes(a)))) {
      fs.mkdirSync(carpeta, { recursive: true });
      fs.writeFileSync(path.join(carpeta, `${a}.md`), `---\nname: ${a}\n---\n# ${a}\n`);
    }
  }
  return d;
}

/** El paquete de prueba de la story: un revisor por grupo. */
const PRUEBA = {
  name: 'prueba',
  description: 'paquete de prueba de packs.test.js',
  guides: ['guides/prueba.md'],
  reviewers: [
    {
      agent: 'rev-base', group: 'base',
      when: { detection: 'csModified' },
      surface: { paths: ['**/*.cs'] }, depth: 'lean', prefixes: ['RVB'],
    },
    {
      agent: 'rev-cond', group: 'condicional',
      when: { added: { pattern: 'MagiaNegra', extensions: ['.cs'] } },
      surface: { paths: ['**/*.cs'], excludePaths: ['**/tests/**'] }, depth: 'deep', prefixes: ['RC'],
      needsStory: true,
    },
    {
      agent: 'rev-val', group: 'validacion',
      when: { detection: 'csModified' },
      prompt: 'Modo pre. Validar la story {story_path} contra el repo {repo_path}.',
      model: 'sonnet', prefixes: ['RV'],
    },
  ],
};

/** El mismo manifiesto con las claves anteriores a las del inglés: salen de la tabla del puente, nunca escritas acá
 *  (el freno y el termómetro cuentan los nombres de todo lo que se publica, pruebas incluidas). */
const { OWN_PACK_KEYS } = require('../lib/legacy-names.js');
const VIEJA_DE = new Map(Object.entries(OWN_PACK_KEYS).map(([viejo, nuevo]) => [nuevo, viejo]));
function conClavesViejas(v) {
  if (Array.isArray(v)) return v.map(conClavesViejas);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [VIEJA_DE.get(k) || k, conClavesViejas(x)]));
}
/** Con el arnés, leer una clave vieja anota el uso en la HOME: en las pruebas, la de laboratorio (nunca la de la máquina). */
function enHomeAislada(fn) {
  const antes = process.env.HOME;
  process.env.HOME = tmp('packs-home-uso-');
  try { return fn(); } finally { process.env.HOME = antes; }
}
const AGENTES_PRUEBA = ['rev-base', 'rev-cond', 'rev-val', 'rev-otro'];

function repo({ yaml, deps } = {}) {
  const d = tmp('packs-repo-');
  fs.mkdirSync(path.join(d, 'src'), { recursive: true });
  fs.writeFileSync(path.join(d, 'src', 'A.cs'), 'class A {}\n');
  fs.writeFileSync(path.join(d, 'src', 'b.ts'), 'export const b = 1;\n');
  fs.writeFileSync(path.join(d, 'README.md'), 'doc\n');
  if (deps) fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', dependencies: deps }, null, 2) + '\n');
  if (yaml != null) {
    fs.mkdirSync(path.join(d, '.tycon'));
    fs.writeFileSync(path.join(d, '.tycon', 'advisors.yaml'), yaml);
  }
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base');
  return d;
}

/** Diff sin commitear: agrega líneas a un archivo del repo. */
function agregar(d, archivo, texto) {
  fs.appendFileSync(path.join(d, archivo), texto);
}

function pipeline(cmd, args, env = {}) {
  const r = spawnSync(process.execPath, [PIPELINE, cmd, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      PATH: process.env.PATH,
      HOME: HOME_AISLADO,
      LANG: 'en_US.UTF-8',
      TYCON_SESSION_ID: 'packs-test',
      // estas pruebas cuentan con «todos los instalados» en un repo sin `packs:` — lo declaran
      TYCON_GUIDES_DIR: ARNES_TODOS,
      ...env,
    },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_e) { /* salida no-JSON: el caso lo mira */ }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

function advisors(d, files, env) {
  return pipeline('advisors', ['--repo', d, '--files', ...files], env);
}

const ordenado = (a) => (a || []).slice().sort();

// ── T1 · AC 1 — el manifiesto suma revisores por grupo, con superficie y profundidad ─────────────
test('Pack_ManifiestoValido_SumaRevisoresPorGrupo', () => {
  const packsDir = paquetes({ prueba: PRUEBA });
  const agentsDir = agentes();
  const d = repo();
  agregar(d, 'src/A.cs', 'class MagiaNegra {}\n');
  const r = advisors(d, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir, TYCON_PIPELINE_COST_TIER: 'lean' });
  assert.equal(r.status, 0, r.stderr);
  const j = r.json;
  assert.ok(j.base.includes('rev-base'), `rev-base entra al grupo base: ${JSON.stringify(j.base)}`);
  assert.ok(j.conditional.includes('rev-cond'), `rev-cond entra al grupo condicional: ${JSON.stringify(j.conditional)}`);
  assert.ok(!j.base.includes('rev-cond') && !j.conditional.includes('rev-base'), 'cada uno en SU grupo');
  assert.ok(!j.all.includes('rev-val'), 'el grupo validacion no entra al set del paso 5');
  // superficie y profundidad declaradas aparecen en la salida
  const prueba = j.packs.find((p) => p.nombre === 'prueba');
  assert.ok(prueba, `la salida lista el paquete: ${JSON.stringify(j.packs)}`);
  const rb = prueba.revisores.find((x) => x.agente === 'rev-base');
  assert.deepEqual(rb.superficie, { paths: ['**/*.cs'] });
  assert.equal(rb.profundidad, 'lean');
  assert.deepEqual(rb.prefijos, ['RVB']);
  // la profundidad manda en las indicaciones de modelo (lean → haiku con --cost-tier lean)
  assert.equal(j.model_hints['rev-base'], 'haiku');
  assert.ok(!('rev-cond' in (j.model_hints || {})), 'deep no recibe hint en modo lean');
  // el que necesita la story completa se anuncia
  assert.ok(j.story_path_para.includes('rev-cond'), `necesitaStory → story_path_para: ${JSON.stringify(j.story_path_para)}`);
  assert.ok(j.story_path_para.includes('tycon-spec-first-checker'), 'el del núcleo sigue ahí');
  // sin el disparador de contenido, el condicional no entra
  const d2 = repo();
  agregar(d2, 'src/A.cs', 'class Nada {}\n');
  const r2 = advisors(d2, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
  assert.ok(r2.json.base.includes('rev-base'));
  assert.ok(!r2.json.conditional.includes('rev-cond'));
});

// ── superficie del manifiesto gobierna las vueltas (advisorAffectedByDelta) ──────────────────────
test('Pack_Superficie_GobiernaLasVueltas', () => {
  const packsDir = paquetes({ prueba: PRUEBA });
  const agentsDir = agentes();
  process.env.TYCON_PACKS_DIR = packsDir;
  process.env.TYCON_AGENTS_DIR = agentsDir;
  try {
    require('../lib/packs.js').resetCache();
    const { advisorAffectedByDelta } = require('../pipeline.js');
    assert.equal(advisorAffectedByDelta('rev-base', ['src/Foo.cs']).affected, true);
    assert.equal(advisorAffectedByDelta('rev-base', ['src/foo.ts']).affected, false);
    assert.equal(advisorAffectedByDelta('rev-cond', ['src/tests/Foo.cs']).affected, false, 'excludePaths del manifiesto');
  } finally {
    delete process.env.TYCON_PACKS_DIR;
    delete process.env.TYCON_AGENTS_DIR;
    require('../lib/packs.js').resetCache();
  }
});

// ── T2 · AC 2 — el vocabulario de condiciones, todas las formas ─────────────────────────────────
test('Pack_VocabularioDeCondiciones_TodasLasFormas', () => {
  const { evaluarCondicion } = require('../lib/packs.js');
  const ctx = {
    det: { csModified: true, tsxModified: false, hasNext: false, hasReact: true, depChanged: false, pluginCfgModified: true },
    files: ['src/A.cs', 'src/adapters/tienda/x.ts', 'plugin.json'],
    agregado: (exts) => [
      { file: 'src/A.cs', content: 'public class FooPlugin : IBackendPlugin {}' },
      { file: 'src/adapters/tienda/x.ts', content: 'const seller = "1";' },
    ].filter((c) => exts.some((e) => c.file.endsWith(e))),
  };
  const tabla = [
    [{ detection: 'csModified' }, true],
    [{ detection: 'tsxModified' }, false],
    [{ no: { detection: 'tsxModified' } }, true],
    [{ files: '(^|/)src/adapters/tienda/' }, true],
    [{ files: '(^|/)src/api/compare/orchestrator\\.ts$' }, false],
    [{ added: { pattern: ':\\s*IBackendPlugin\\b', extensions: ['.cs'] } }, true],
    [{ added: { pattern: ':\\s*IBackendPlugin\\b', extensions: ['.ts'] } }, false],
    [{ added: { pattern: 'seller', extensions: ['.ts', '.tsx'] } }, true],
    [{ all: [{ detection: 'csModified' }, { detection: 'hasReact' }] }, true],
    [{ all: [{ detection: 'csModified' }, { detection: 'hasNext' }] }, false],
    [{ any: [{ detection: 'hasNext' }, { detection: 'hasReact' }] }, true],
    [{ any: [{ detection: 'hasNext' }, { detection: 'depChanged' }] }, false],
    // anidadas: la matriz de hoy para el revisor .NET: cs O (config de plugin Y NO tsx)
    [{ any: [{ detection: 'csModified' }, { all: [{ detection: 'pluginCfgModified' }, { no: { detection: 'tsxModified' } }] }] }, true],
    [{ all: [{ no: { detection: 'csModified' } }, { any: [{ detection: 'hasNext' }, { no: { no: { detection: 'hasReact' } } }] }] }, false],
    [{ any: [] }, false],
    [{ all: [] }, true],
  ];
  for (const [cuando, esperado] of tabla) {
    assert.equal(evaluarCondicion(cuando, ctx), esperado, JSON.stringify(cuando));
  }
});

// ── T3 · AC 2, 5 — clave o bandera desconocida = manifiesto inválido, nunca «falso» ─────────────
test('Pack_ClaveOBanderaDesconocida_ManifiestoInvalido', () => {
  const packs = require('../lib/packs.js');
  const agentsDir = agentes();
  const conClaveRota = JSON.parse(JSON.stringify(PRUEBA));
  conClaveRota.reviewers[0].when = { file: '\\.cs$' };              // falta la s
  const conBanderaRota = JSON.parse(JSON.stringify(PRUEBA));
  conBanderaRota.reviewers[0].when = { detection: 'csModifed' };   // typo
  const casos = [
    [conClaveRota, /«file»/],
    [conBanderaRota, /csModifed/],
  ];
  for (const [manifiesto, re] of casos) {
    const packsDir = paquetes({ prueba: manifiesto });
    packs.resetCache();
    assert.throws(
      () => packs.cargarPaquetes({ packsDir, agentsDir, nucleo: [TC, SB], banderas: ['csModified', 'tsxModified'] }),
      (e) => {
        assert.ok(e instanceof packs.PackError, 'es un PackError');
        assert.ok(e.errores.length >= 1);
        const err = e.errores[0];
        assert.equal(err.archivo, path.join(packsDir, 'prueba', 'pack.json'));
        assert.equal(err.revisor, 'rev-base');
        assert.match(err.motivo, re);
        return true;
      },
    );
  }
  // una clave desconocida en el manifiesto o en el revisor también invalida
  const conClaveExtra = JSON.parse(JSON.stringify(PRUEBA));
  conClaveExtra.reviewers[0].condition = { detection: 'csModified' };
  const packsDir = paquetes({ prueba: conClaveExtra });
  packs.resetCache();
  assert.throws(
    () => packs.cargarPaquetes({ packsDir, agentsDir, nucleo: [TC, SB], banderas: ['csModified'] }),
    (e) => /condition/.test(e.errores[0].motivo) && e.errores[0].revisor === 'rev-base',
  );
  // el mismo agente en base Y condicional del mismo paquete: dos superficies posibles, se rechaza
  const enDos = JSON.parse(JSON.stringify(PRUEBA));
  enDos.reviewers.push({ ...enDos.reviewers[0], group: 'condicional' });
  const packsDir2 = paquetes({ prueba: enDos });
  packs.resetCache();
  assert.throws(
    () => packs.cargarPaquetes({ packsDir: packsDir2, agentsDir, nucleo: [TC, SB], banderas: ['csModified'] }),
    (e) => e.errores.some((x) => x.revisor === 'rev-base' && /base.*condicional/.test(x.motivo)),
  );
  // y el vocabulario cerrado está publicado (lo lee la guía y el lint)
  assert.ok(Array.isArray(packs.VOCABULARIO.condicion));
  assert.deepEqual(packs.VOCABULARIO.condicion.slice().sort(), ['added', 'all', 'any', 'detection', 'files', 'no']);
  assert.deepEqual(packs.VOCABULARIO.grupos.slice().sort(), ['base', 'condicional', 'validacion']);
});

// ── Los hermanos del corral del banco viven en su paquete ─────
test('Pack_Siblings_FieldValidatedAndDelivered', () => {
  const packs = require('../lib/packs.js');
  const agentsDir = agentes();
  assert.ok(packs.VOCABULARIO.manifiesto.includes('siblings'), 'el vocabulario del manifiesto conoce «siblings»');
  const conHermanos = JSON.parse(JSON.stringify(PRUEBA));
  conHermanos.siblings = [
    { path: 'AcmeCorp/Backend/src/AcmeCorpBackend', name: 'AcmeCorp' },
    { path: 'Zorblax/Backend/src/ZorblaxBackend', name: 'Zorblax' },
  ];
  packs.resetCache();
  const cargados = packs.cargarPaquetes({ packsDir: paquetes({ prueba: conHermanos }), agentsDir, nucleo: [TC, SB], banderas: ['csModified'] });
  // lo que entrega la biblioteca conserva su forma de siempre: ruta y nombre
  assert.deepEqual(cargados[0].hermanos, conClavesViejas(conHermanos.siblings), 'el paquete entrega sus hermanos tal cual');
  packs.resetCache();
  const sin = packs.cargarPaquetes({ packsDir: paquetes({ prueba: PRUEBA }), agentsDir, nucleo: [TC, SB], banderas: ['csModified'] });
  assert.deepEqual(sin[0].hermanos, [], 'sin el campo, una lista vacía');
  const rotos = [
    [{ ...conHermanos, siblings: 'AcmeCorp' }, /siblings.*lista/],
    [{ ...conHermanos, siblings: [{ path: '../fuera/AcmeCorpBackend', name: 'AcmeCorp' }] }, /siblings.*ruta/],
    [{ ...conHermanos, siblings: [{ path: '/abs/AcmeCorpBackend', name: 'AcmeCorp' }] }, /siblings.*ruta/],
    [{ ...conHermanos, siblings: [{ path: 'AcmeCorp/Backend', name: 'Acme Corp' }] }, /siblings.*nombre/],
    [{ ...conHermanos, siblings: [{ path: 'AcmeCorp/Backend', name: 'AcmeCorp', extra: 1 }] }, /siblings.*extra/],
  ];
  for (const [manifiesto, re] of rotos) {
    packs.resetCache();
    assert.throws(
      () => packs.cargarPaquetes({ packsDir: paquetes({ prueba: manifiesto }), agentsDir, nucleo: [TC, SB], banderas: ['csModified'] }),
      (e) => e instanceof packs.PackError && e.errores.some((x) => re.test(x.motivo)),
      `un «siblings» mal formado frena: ${re}`,
    );
  }
});

// ── Las claves del manifiesto en inglés; uno de afuera con las de antes sigue andando ──
test('D1 Pack_OldKeysOutsideTheRepo_SameAsNew — un manifiesto en TYCON_PACKS_DIR con las claves viejas carga igual que el nuevo', () => {
  const packs = require('../lib/packs.js');
  const agentsDir = agentes();
  const conHermanos = { ...JSON.parse(JSON.stringify(PRUEBA)), siblings: [{ path: 'AcmeCorp/Backend/src/AcmeCorpBackend', name: 'AcmeCorp' }] };
  const viejo = conClavesViejas(conHermanos);
  assert.ok(!('reviewers' in viejo) && Object.keys(viejo).length === Object.keys(conHermanos).length, 'el de laboratorio está escrito con las claves de antes');
  const cargar = (manifiesto) => {
    packs.resetCache();
    return enHomeAislada(() => packs.cargarPaquetes({ packsDir: paquetes({ prueba: manifiesto }), agentsDir, nucleo: [TC, SB], banderas: ['csModified'] }));
  };
  const sinRutas = (ps) => ps.map(({ dir, archivo, agentes: _a, ...resto }) => resto);
  // en este proceso, el puente va por el arnés de la máquina (TYCON_GUIDES_DIR o el enlace: al día o atrasado, según su
  // mapa); en el hijo de abajo, sin arnés (la tabla propia)
  const nuevo = sinRutas(cargar(conHermanos));
  assert.deepEqual(sinRutas(cargar(viejo)), nuevo, 'con las claves viejas: el mismo paquete, revisor por revisor');
  const sinArnes = spawnSync(process.execPath, ['-e', `
    const packs = require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'packs.js'))});
    const r = packs.cargarPaquetes({ packsDir: process.argv[1], agentsDir: process.argv[2], nucleo: [], banderas: ['csModified'] });
    process.stdout.write(JSON.stringify(r.map(({ dir, archivo, agentes, ...resto }) => resto)));`, paquetes({ prueba: viejo }), agentsDir],
  { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp('packs-home-'), TYCON_GUIDES_DIR: path.join(tmp('packs-nada-'), 'no-existe') } });
  assert.equal(sinArnes.status, 0, sinArnes.stderr);
  assert.deepEqual(JSON.parse(sinArnes.stdout), nuevo, 'sin arnés (o uno anterior a la D1): la tabla propia del puente traduce igual');
  // y por el pipeline: la salida de `advisors` es la misma, con sus claves de siempre
  const d = repo();
  agregar(d, 'src/A.cs', 'class MagiaNegra {}\n');
  const env = (m) => ({ TYCON_PACKS_DIR: paquetes({ prueba: m }), TYCON_AGENTS_DIR: agentsDir });
  const rNuevo = advisors(d, ['src/A.cs'], env(conHermanos));
  const rViejo = advisors(d, ['src/A.cs'], env(viejo));
  assert.equal(rViejo.status, 0, rViejo.stderr);
  assert.deepEqual([rViejo.json.base, rViejo.json.conditional], [rNuevo.json.base, rNuevo.json.conditional], 'el mismo set');
  assert.deepEqual(rViejo.json.packs.map(({ dir, agentes, ...p }) => p), rNuevo.json.packs.map(({ dir, agentes, ...p }) => p), 'la misma salida');
  assert.ok(rNuevo.json.packs[0].revisores[0].agente, 'la salida conserva sus claves de siempre (pregunta decidida 2)');
});

test('D1 Pack_OldAndNewKeyDiffer_BrokenPack — la clave vieja y la nueva con valores distintos es un paquete roto', () => {
  const packs = require('../lib/packs.js');
  const agentsDir = agentes();
  const viejaDe = (nuevo) => VIEJA_DE.get(nuevo);
  const casos = [
    // arriba: la descripción con sus dos nombres
    { ...PRUEBA, [viejaDe('description')]: 'otra descripción' },
    // anidada: un revisor con la profundidad por los dos nombres
    { ...PRUEBA, reviewers: [{ ...PRUEBA.reviewers[0], [viejaDe('depth')]: 'deep' }, ...PRUEBA.reviewers.slice(1)] },
  ];
  for (const manifiesto of casos) {
    const packsDir = paquetes({ prueba: manifiesto });
    packs.resetCache();
    assert.throws(
      () => enHomeAislada(() => packs.cargarPaquetes({ packsDir, agentsDir, nucleo: [TC, SB], banderas: ['csModified'] })),
      (e) => e instanceof packs.PackError && e.errores.length === 1
        && e.errores[0].archivo === path.join(packsDir, 'prueba', 'pack.json') && /valores distintos/.test(e.errores[0].motivo),
      'frena como un paquete roto, nombrando el archivo',
    );
    // por el pipeline: exit ≠ 0 y sin set a medias (nunca «sin ese paquete»)
    const d = repo();
    agregar(d, 'src/A.cs', 'class X {}\n');
    const r = advisors(d, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
    assert.notEqual(r.status, 0);
    assert.equal(r.json, null);
    assert.ok(r.stderr.includes(path.join(packsDir, 'prueba', 'pack.json')), r.stderr);
  }
  // con los dos nombres y el MISMO valor no hay conflicto: queda la nueva
  packs.resetCache();
  const iguales = { ...PRUEBA, [viejaDe('description')]: PRUEBA.description };
  assert.equal(enHomeAislada(() => packs.cargarPaquetes({ packsDir: paquetes({ prueba: iguales }), agentsDir, nucleo: [TC, SB], banderas: ['csModified'] }))[0].descripcion, PRUEBA.description);
});

test('D1 Bridge_OwnPackKeysEqualTheMap — la tabla propia de claves del manifiesto es la del mapa del arnés', (t) => {
  const candidatos = [process.env.TYCON_GUIDES_DIR, path.join(os.homedir(), '.claude', 'tycon-harness'), path.join(os.homedir(), '.claude', 'tycon-claude-guides')].filter(Boolean);
  const { PACK_KEYS_WHERE } = require('../lib/legacy-names.js');
  let entradas = null;
  for (const dir of candidatos) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'scripts', 'lib', 'renames.json'), 'utf8'));
      const es = m.entries.filter((e) => e && e.kind === 'key' && e.where === PACK_KEYS_WHERE);
      if (es.length) { entradas = es; break; }
    } catch (_) { /* no está o es anterior a la D1 */ }
  }
  if (!entradas) { t.skip(`no hay en esta máquina un arnés cuyo mapa tenga las claves de ${PACK_KEYS_WHERE}`); return; }
  assert.deepEqual(entradas.map((e) => `${e.old}>${e.new}`).sort(), Object.entries(OWN_PACK_KEYS).map(([o, n]) => `${o}>${n}`).sort());
  assert.ok(entradas.every((e) => e.repo === 'agent-skills'), 'las entradas son de agent-skills');
});

// ── T4 · AC 3 — descubrimiento: la variable, o packs/ de agent-skills ──────────────────────────
test('Pack_Descubrimiento_VariableYDefault', (t) => {
  const packsDir = paquetes({ prueba: PRUEBA });
  const agentsDir = agentes();
  const d = repo();
  agregar(d, 'src/A.cs', 'class X {}\n');
  const conVariable = advisors(d, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
  assert.equal(conVariable.status, 0, conVariable.stderr);
  assert.deepEqual(conVariable.json.packs.map((p) => p.nombre), ['prueba']);
  assert.equal(conVariable.json.packs_dir, packsDir);
  // sin la variable: packs/ del árbol, donde viven los del equipo (la copia pública no trae ninguno: llegan con el perfil)
  const sinVariable = advisors(d, ['src/A.cs']);
  assert.equal(sinVariable.status, 0, sinVariable.stderr);
  assert.equal(sinVariable.json.packs_dir, PACKS_REALES);
  const delArbol = fs.existsSync(PACKS_REALES) ? fs.readdirSync(PACKS_REALES).filter((p) => fs.existsSync(path.join(PACKS_REALES, p, 'pack.json'))).sort() : [];
  assert.deepEqual(ordenado(sinVariable.json.packs.map((p) => p.nombre)), delArbol);
  if (SKIP_PUBLIC) assert.deepEqual(delArbol, [], 'el núcleo no trae paquetes');
  else assert.ok(['bizuit', 'clients', 'nextjs-postgres'].every((p) => delArbol.includes(p)), `los del equipo: ${delArbol.join(', ')}`);
  if (SKIP_PUBLIC) t.diagnostic(`NO MEDIDO: que los paquetes del equipo se descubren por defecto (${SKIP_PUBLIC}); se mide en el repo del equipo`);
});

// ── T5 · AC 4 — `packs:` del repo restringe, y un nombre que no está instalado frena ────────────
test('Pack_ListaDelRepo_RestringeYFallaSiFalta', () => {
  const otro = JSON.parse(JSON.stringify(PRUEBA));
  otro.name = 'otro';
  otro.reviewers = [{ agent: 'rev-otro', group: 'base', when: { detection: 'csModified' }, surface: { paths: ['**/*.cs'] }, depth: 'standard', prefixes: ['RO'] }];
  const packsDir = paquetes({ prueba: PRUEBA, otro });
  const agentsDir = agentes();

  // sin lista: los dos activos
  const todos = repo();
  agregar(todos, 'src/A.cs', 'class X {}\n');
  const rTodos = advisors(todos, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
  assert.deepEqual(ordenado(rTodos.json.packs.map((p) => p.nombre)), ['otro', 'prueba']);
  assert.ok(rTodos.json.base.includes('rev-otro') && rTodos.json.base.includes('rev-base'));

  // con lista: exactamente esa
  const soloPrueba = repo({ yaml: 'packs: [prueba]\n' });
  agregar(soloPrueba, 'src/A.cs', 'class X {}\n');
  const r1 = advisors(soloPrueba, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
  assert.equal(r1.status, 0, r1.stderr);
  assert.deepEqual(r1.json.packs.map((p) => p.nombre), ['prueba']);
  assert.ok(r1.json.base.includes('rev-base'));
  assert.ok(!r1.json.base.includes('rev-otro'), 'el paquete no listado no está activo');

  // lista en bloque y lista vacía
  const enBloque = repo({ yaml: 'repo_group: x\npacks:\n  - otro\n' });
  agregar(enBloque, 'src/A.cs', 'class X {}\n');
  const r2 = advisors(enBloque, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
  assert.deepEqual(r2.json.packs.map((p) => p.nombre), ['otro']);
  const vacia = repo({ yaml: 'packs: []\n' });
  agregar(vacia, 'src/A.cs', 'class X {}\n');
  const r3 = advisors(vacia, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
  assert.deepEqual(r3.json.packs, []);
  assert.deepEqual(ordenado(r3.json.base), [SB, TC]);

  // un nombre que no está instalado: exit ≠ 0, nombrando el paquete y dónde lo buscó
  const falta = repo({ yaml: 'packs: [prueba, inexistente]\n' });
  agregar(falta, 'src/A.cs', 'class X {}\n');
  const r4 = advisors(falta, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
  assert.notEqual(r4.status, 0, 'falla');
  assert.match(r4.stderr, /inexistente/);
  assert.ok(r4.stderr.includes(packsDir), `dice dónde buscó: ${r4.stderr}`);
  assert.equal(r4.json, null, 'sin set a medias en stdout');

  // formas YAML que no pueden dar CERO paquetes en silencio: ítems en columna 0
  // (`- inexistente` sin indentar tiene que frenar) y la clave sin lista
  const col0 = repo({ yaml: 'packs:\n- prueba\n- inexistente\n' });
  agregar(col0, 'src/A.cs', 'class X {}\n');
  const r6 = advisors(col0, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
  assert.notEqual(r6.status, 0, 'ítems en columna 0 se leen: el inexistente frena');
  assert.match(r6.stderr, /inexistente/);
  const col0ok = repo({ yaml: 'packs: # los del equipo\n- otro\n' });
  agregar(col0ok, 'src/A.cs', 'class X {}\n');
  const r7 = advisors(col0ok, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
  assert.equal(r7.status, 0, r7.stderr);
  assert.deepEqual(r7.json.packs.map((p) => p.nombre), ['otro']);
  assert.deepEqual(r7.json.packs_declarados, ['otro'], 'la salida dice qué restringió el repo');
  assert.equal(rTodos.json.packs_declarados, null, 'sin clave: null (no se confunde con «restringido a ninguno»)');
  assert.deepEqual(r3.json.packs_declarados, [], 'restringido a ninguno se ve como []');
  const nula = repo({ yaml: 'repo_group: x\npacks:\n' });
  agregar(nula, 'src/A.cs', 'class X {}\n');
  const r8 = advisors(nula, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
  assert.notEqual(r8.status, 0, 'una clave `packs:` sin lista no es «ninguno» ni «todos los paquetes»: frena');
  assert.match(r8.stderr, /sin lista/);
  assert.ok(r8.stderr.includes(path.join(nula, '.tycon', 'advisors.yaml')));

  // una configuración ILEGIBLE (no ausente) tampoco se toma como «sin restricción»: frena nombrándola
  // (un `packs:` que se ignora cambia el set sin que se vea)
  const ilegible = repo();
  fs.mkdirSync(path.join(ilegible, '.tycon', 'advisors.yaml'), { recursive: true });   // es una carpeta → EISDIR
  agregar(ilegible, 'src/A.cs', 'class X {}\n');
  const r5 = advisors(ilegible, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
  assert.notEqual(r5.status, 0, 'una config ilegible frena');
  assert.ok(r5.stderr.includes(path.join(ilegible, '.tycon', 'advisors.yaml')), r5.stderr);
  assert.equal(r5.json, null);
});

// ── `packs:` en todas las formas YAML que el equipo escribe ──
test('Pack_ListaDelRepo_FormasYaml', () => {
  const { paquetesDeclarados, PacksDeclaradosError, rendirPrompt } = require('../lib/packs.js');
  const tabla = [
    ['packs:\n  - bizuit\n  - clientes\n', ['bizuit', 'clientes']],
    ['packs:\n- bizuit\n- clientes\nmerge:\n  mode: pr\n', ['bizuit', 'clientes']],       // ítems en columna 0 (estilo Azure Pipelines)
    ['packs: [bizuit, "clientes"]\n', ['bizuit', 'clientes']],                            // comillas con espacio tras la coma
    ["packs: [ 'a', 'b' ]\n", ['a', 'b']],
    ['packs: [\n  bizuit,\n  clientes\n]\n', ['bizuit', 'clientes']],                       // flow en varias líneas
    ['packs: # los del equipo\n  - bizuit # el público\n', ['bizuit']],                    // comentario en la clave y en el ítem
    ['\uFEFFpacks: [bizuit]\n', ['bizuit']],                                               // BOM de un editor Windows
    ['packs: bizuit\n', ['bizuit']],
    ['packs: []\n', []],
    ['repo_group: x\n', null],
    ['e2e:\n  packs: [bizuit]\n', null],                                                   // anidada no es la top-level
  ];
  for (const [txt, esperado] of tabla) assert.deepEqual(paquetesDeclarados(txt), esperado, JSON.stringify(txt));
  // una clave sin lista NO es «ninguno» (apagaría todos los paquetes en silencio) ni «todos los paquetes»
  for (const txt of ['packs:\n', 'packs: ~\n', 'packs: null\n', 'packs:\n  # comentado\nmerge:\n  mode: pr\n', 'packs: [\n  bizuit\n']) {
    assert.throws(() => paquetesDeclarados(txt), PacksDeclaradosError, JSON.stringify(txt));
  }
  // un `$&` en una ruta no corrompe el prompt (reemplazo por función)
  assert.equal(rendirPrompt('Validar {story_path} en {repo_path}', { story_path: '/tmp/a$&b.md', repo_path: "/tmp/r$'" }), "Validar /tmp/a$&b.md en /tmp/r$'");
});

// ── T6 · AC 5 — un paquete roto frena nombrando archivo, revisor y motivo ───────────────────────
test('Pack_Roto_FallaNombrandoArchivoYMotivo', () => {
  const agentsDir = agentes();
  const sinAgente = JSON.parse(JSON.stringify(PRUEBA));
  sinAgente.reviewers[0].agent = 'rev-fantasma';
  const duplicaNucleo = JSON.parse(JSON.stringify(PRUEBA));
  duplicaNucleo.reviewers[0].agent = SB;
  const gemelo = JSON.parse(JSON.stringify(PRUEBA));
  gemelo.name = 'gemelo';

  const casos = [
    { nombre: 'json roto', packs: { prueba: '{ "name": "prueba", "reviewers": [ ' }, revisor: null, motivo: /JSON/i },
    { nombre: 'agente inexistente', packs: { prueba: sinAgente }, revisor: 'rev-fantasma', motivo: /no existe|no hay un agente/i },
    { nombre: 'duplicado con el núcleo', packs: { prueba: duplicaNucleo }, revisor: SB, motivo: /núcleo|nucleo/i },
    { nombre: 'duplicado entre paquetes', packs: { prueba: PRUEBA, gemelo }, revisor: 'rev-base', motivo: /otro paquete|ya lo declara/i },
  ];
  for (const caso of casos) {
    const packsDir = paquetes(caso.packs);
    const d = repo();
    agregar(d, 'src/A.cs', 'class X {}\n');
    const r = advisors(d, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
    assert.notEqual(r.status, 0, `${caso.nombre}: exit ≠ 0`);
    assert.ok(r.stderr.includes(path.join(packsDir, 'prueba', 'pack.json')) || r.stderr.includes(path.join(packsDir, 'gemelo', 'pack.json')),
      `${caso.nombre}: nombra el archivo — ${r.stderr}`);
    if (caso.revisor) assert.ok(r.stderr.includes(caso.revisor), `${caso.nombre}: nombra al revisor — ${r.stderr}`);
    assert.match(r.stderr, caso.motivo, `${caso.nombre}: dice el motivo`);
    assert.equal(r.json, null, `${caso.nombre}: no degrada a «sin ese paquete»`);
    // y los otros comandos que eligen revisores frenan igual
    const s = pipeline('smart-reloop', ['--iter', '2', '--repo', d, '--files', 'src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
    assert.notEqual(s.status, 0, `${caso.nombre}: smart-reloop también frena`);
  }
});

// ── T7 · AC 6 — la salida incluye los paquetes cargados ─────────────────────────────────────────
test('Advisors_SalidaIncluyePaquetesCargados', () => {
  const packsDir = paquetes({ prueba: PRUEBA });
  const agentsDir = agentes();
  const d = repo();
  agregar(d, 'src/A.cs', 'class X {}\n');
  const con = advisors(d, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
  assert.equal(con.json.packs.length, 1);
  assert.equal(con.json.packs[0].nombre, 'prueba');
  assert.deepEqual(con.json.packs[0].revisores.map((r) => [r.agente, r.grupo]),
    [['rev-base', 'base'], ['rev-cond', 'condicional'], ['rev-val', 'validacion']]);
  const sin = advisors(d, ['src/A.cs'], { TYCON_PACKS_DIR: tmp('packs-vacio-'), TYCON_AGENTS_DIR: agentsDir });
  assert.deepEqual(sin.json.packs, []);
  // el smart-reloop también los muestra (es el otro comando que elige revisores)
  const s = pipeline('smart-reloop', ['--iter', '1', '--repo', d, '--files', 'src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
  assert.equal(s.status, 0, s.stderr);
  assert.deepEqual(s.json.packs.map((p) => p.nombre), ['prueba']);
});

// ── T8 · AC 7 — el núcleo no nombra a los revisores de paquete (la copia pública ni trae paquetes) ─────────────────
// (los revisores de paquete no se escriben acá: son los que declaran los manifiestos instalados. La copia
// pública no trae ningún paquete (llegan con el perfil del equipo); el repo del equipo los suma leyéndolos de
// sus manifiestos — sacar o sumar uno allá no toca esta suite)
const LOS_DE_PAQUETE = packReviewers(PACKS_REALES);
function archivosDelNucleo() {
  const skill = path.resolve(SCRIPTS, '..');
  const out = [PIPELINE, path.join(skill, 'SKILL.md')];
  const walk = (dir, filtro) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, filtro);
      else if (filtro.test(e.name)) out.push(p);
    }
  };
  walk(path.join(SCRIPTS, 'lib'), /\.js$/);
  walk(path.join(skill, 'steps'), /\.md$/);
  return out;
}
test('Nucleo_SinNombresDePaquetes', (t) => {
  const apariciones = [];
  for (const f of archivosDelNucleo()) {
    const lineas = fs.readFileSync(f, 'utf8').split('\n');
    lineas.forEach((l, i) => {
      for (const n of LOS_DE_PAQUETE) if (l.includes(n)) apariciones.push(`${path.relative(RAIZ, f)}:${i + 1} ${n}`);
    });
  }
  assert.deepEqual(apariciones, [], `los revisores de paquete sólo viven en packs/:\n${apariciones.join('\n')}`);
  // (comparar la lista contra los mismos manifiestos de los que sale no mide nada)
  // lo que sí se mide: cada revisor que un manifiesto declara tiene su definición —en la carpeta de agentes de su paquete
  // (clave `agents`) o en la de la raíz—, y ninguno vive a la vez en agents/ del núcleo
  if (SKIP_PUBLIC) {
    assert.deepEqual(LOS_DE_PAQUETE, [], 'el núcleo no trae paquetes');
    t.diagnostic(`NO MEDIDO: que el núcleo no nombre a los revisores de los paquetes del equipo ni que sus manifiestos los declaren (${SKIP_PUBLIC}); se mide en el repo del equipo`);
    return;
  }
  for (const p of fs.readdirSync(PACKS_REALES).filter((x) => fs.existsSync(path.join(PACKS_REALES, x, 'pack.json')))) {
    const m = JSON.parse(fs.readFileSync(path.join(PACKS_REALES, p, 'pack.json'), 'utf8'));
    for (const r of m.reviewers) {
      const enPaquete = m.agents ? path.join(PACKS_REALES, p, m.agents, `${r.agent}.md`) : null;
      assert.ok((enPaquete && fs.existsSync(enPaquete)) || fs.existsSync(path.join(RAIZ, 'agents', `${r.agent}.md`)), `${r.agent}: lo declara el paquete ${p} y no tiene su definición`);
    }
  }
  // la lista sale de los manifiestos: que no se quede corta (los de clientes los dice su manifiesto, no un número escrito acá)
  for (const n of clientPackReviewers()) assert.ok(LOS_DE_PAQUETE.includes(n), `${n} del paquete de clientes`);
});

// ── T21 (AC 24): el núcleo no nombra a ningún revisor de un stack — cada revisor que pipeline.js escribe tiene su
//    definición en agents/ del núcleo; y el escalamiento de mech-check de una familia que no es del núcleo (WIRING) va al
//    revisor del paquete ACTIVO que declara ese prefijo, o queda sin escalar y se dice ───────────────────────────────────
test('T21 Pipeline_NamesNoneOfThirteen', () => {
  const texto = fs.readFileSync(PIPELINE, 'utf8');
  const nombrados = [...new Set([...texto.matchAll(/'((?:tycon-)?[a-z0-9]+(?:-[a-z0-9]+)*-(?:reviewer|checker|analyzer|conventions|security|basics|coverage|validator|audit|capturer|hunter))'/g)].map((m) => m[1]))];
  assert.ok(nombrados.length >= 10, `pipeline.js nombra revisores del núcleo: ${nombrados.join(', ')}`);
  const sinDefinicion = nombrados.filter((n) => !fs.existsSync(path.join(RAIZ, 'agents', `${n}.md`)));
  assert.deepEqual(sinDefinicion, [], 'cada revisor que pipeline.js nombra es del núcleo (los de un stack viven en su paquete)');
  // el control de commit que corre la paridad Codex y la vida del revisor tocado mira también los de un paquete
  const hook = path.join(RAIZ, '.githooks', 'pre-commit-checks');
  if (fs.existsSync(hook)) assert.match(fs.readFileSync(hook, 'utf8'), /git diff --cached --name-only -- 'agents\/\*\.md' 'packs\/\*\/agents\/\*\.md'/);
  // el escalamiento: un componente nuevo sin uso es un ambiguo WIRING-C1
  const d = repo();
  fs.writeFileSync(path.join(d, 'src', 'Nuevo.tsx'), 'export function Nuevo() { return null; }\n');
  const story = path.join(tmp('packs-story-wiring-'), 'story-1-1.md');
  fs.writeFileSync(story, ['---', 'epic: 1', 'story: "1.1"', 'title: "x"', 'status: in-progress', '---', '', '## Acceptance Criteria', '', '1. **Given** x **Then** y', ''].join('\n'));
  const mech = (env) => pipeline('mech-check', ['--repo', d, '--story', story, '--files', 'src/Nuevo.tsx'], env);
  const conPaquete = paquetes({ cableado: { name: 'cableado', description: 'paquete de juguete con el revisor de cableado', reviewers: [
    { agent: 'rev-cableado', group: 'condicional', when: { files: '\\.tsx$' }, surface: { paths: ['**/*.tsx'] }, depth: 'lean', prefixes: ['WIRING'] },
  ] } });
  const con = mech({ TYCON_PACKS_DIR: conPaquete, TYCON_AGENTS_DIR: agentes() });
  assert.ok(con.json, con.stderr);
  assert.ok(con.json.ambiguous.some((a) => a.rule === 'WIRING-C1'), JSON.stringify(con.json.ambiguous));
  assert.deepEqual(con.json.llm_escalation, ['rev-cableado']);
  const sin = mech({ TYCON_PACKS_DIR: tmp('packs-vacio-') });
  assert.deepEqual(sin.json.llm_escalation, []);
  assert.match(sin.json.note, /Sin escalar: WIRING \(ningún paquete activo trae su revisor\)/);
});

// ── T17 (AC 16, 17) y T19 (AC 19): las skills de un stack no viven en el núcleo, y las del núcleo no nombran a la
//    organización. Las nueve llegan en el paquete del perfil del equipo; que estén ahí lo mide el repo del equipo ──────
test('T17 Skills_LeavePublic_TravelInTeamLayer (lado público)', (t) => {
  const skillsDir = path.join(RAIZ, 'skills');
  const delNucleo = fs.readdirSync(skillsDir).filter((n) => fs.existsSync(path.join(skillsDir, n, 'SKILL.md')));
  // en el núcleo no queda una skill que hable del stack de una organización (BIZUIT, Dapper/SQL Server, el empaquetado de formularios)
  const MUDADAS = ['bizuit-backend-plugin-system', 'bizuit-custom-forms-system', 'bizuit-sdk-integration', 'bizuit-new-product',
    'dotnet-dapper-sqlserver', 'safe-query-builder', 'feature-based-crud-endpoints', 'tycon-new-migration', 'esbuild-bundling'];
  const delStack = delNucleo.filter((n) => MUDADAS.includes(n));
  assert.deepEqual(delStack, [], 'las skills de un stack viven en su paquete');
  // las que trae un paquete instalado (con el perfil del equipo encima) se llaman distinto que las del núcleo
  if (SKIP_PUBLIC) t.diagnostic(`NO MEDIDO: que el paquete del equipo traiga sus skills (${SKIP_PUBLIC}); se mide en el repo del equipo`);
  else {
    const enPaquetes = fs.readdirSync(PACKS_REALES).flatMap((p) => {
      const d = path.join(PACKS_REALES, p, 'skills');
      return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => fs.existsSync(path.join(d, n, 'SKILL.md'))) : [];
    });
    assert.ok(enPaquetes.length > 0, 'el paquete del equipo trae sus skills');
    assert.deepEqual(enPaquetes.filter((n) => delNucleo.includes(n)), [], 'ninguna está a la vez en un paquete y en el núcleo');
  }
});

test('T19 Clocki_DescriptionNeutral', () => {
  // la descripción de clocki dice qué hace para quien la use, sin el nombre de la organización
  // la skill vive en su integración (integrations/clockify/skills/clocki)
  const clocki = fs.readFileSync(path.join(RAIZ, 'integrations', 'clockify', 'skills', 'clocki', 'SKILL.md'), 'utf8');
  const descripcion = (/^description:\s*(.+)$/m.exec(clocki) || [])[1] || '';
  assert.ok(descripcion.length > 40, 'clocki tiene descripción');
  assert.doesNotMatch(descripcion, /\bTYCON\b/, 'el nombre de la organización (las skills del núcleo, como tycon-pipeline, conservan su nombre)');
});

// ── T9 · AC 8 — sin paquetes, un diff .cs conserva pruebas y seguridad, sin avisos ─────────────
test('Nucleo_SinPaquetes_CsTienePruebasYSeguridad', () => {
  const d = repo();
  agregar(d, 'src/A.cs', 'class X {}\n');
  const r = advisors(d, ['src/A.cs'], { TYCON_PACKS_DIR: tmp('packs-vacio-') });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ordenado(r.json.base), [SB, TC]);
  assert.deepEqual(r.json.packs, []);
  assert.equal(r.stderr, '', 'sin avisos');
  assert.ok(!('warning' in r.json.detection), 'sin aviso en la detección');
  // ni con .tsx, ni con la config de plugin: nunca queda sin revisor de pruebas ni de seguridad
  const d2 = repo({ deps: { react: '18.2.0' } });
  agregar(d2, 'src/b.ts', 'export const c = 2;\n');
  const r2 = advisors(d2, ['src/b.ts'], { TYCON_PACKS_DIR: tmp('packs-vacio-') });
  assert.deepEqual(ordenado(r2.json.base), [SB, TC]);
  // pero una TYCON_PACKS_DIR explícita que apunta a una carpeta inexistente SÍ frena (AC 3):
  // es configuración rota, no «sin paquetes». (La carpeta POR DEFECTO ausente es la máquina sin
  // agent-skills: cero paquetes, sin aviso — no se puede simular acá sin mover agent-skills.)
  const noExiste = path.join(tmp('packs-vacio-'), 'no-existe');
  const r3 = advisors(d, ['src/A.cs'], { TYCON_PACKS_DIR: noExiste });
  assert.notEqual(r3.status, 0, 'una variable explícita que apunta a una carpeta inexistente frena');
  assert.ok(r3.stderr.includes(noExiste), 'y la nombra');
  assert.equal(r3.json, null);
});

// ── T12 · AC 10 — los revisores de validación salen del comando ────────────────────────────────
function storyDeBackend() {
  const d = tmp('packs-story-');
  const p = path.join(d, 'story-1-1.md');
  fs.writeFileSync(p, [
    '---', 'epic: 1', 'story: "1.1"', 'title: "backend"', 'status: in-progress',
    'files_to_modify:', '  - src/Foo.cs', '---', '', '## Acceptance Criteria', '', '1. **Given** x **Then** y', '',
    '### Tests', '', '| # | Test | AC |', '|---|---|---|', '| T1 | `A` | 1 |', '',
  ].join('\n'));
  return p;
}
test('Validadores_ConYSinPaqueteClientes', (t) => {
  const story = storyDeBackend();
  const d = repo();
  // con el paquete de prueba: el validador + el de validación del paquete, con su prompt rendido
  const packsDir = paquetes({ prueba: PRUEBA });
  const agentsDir = agentes();
  const con = pipeline('validadores', ['--story', story, '--repo', d], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
  assert.equal(con.status, 0, con.stderr);
  assert.deepEqual(con.json.validadores, ['tycon-story-validator', 'rev-val']);
  const l = con.json.lanzamientos.find((x) => x.agente === 'rev-val');
  assert.equal(l.paquete, 'prueba');
  assert.equal(l.modelo, 'sonnet');
  assert.equal(l.prompt, `Modo pre. Validar la story ${story} contra el repo ${d}.`);
  // sin paquetes: sólo el validador
  const sin = pipeline('validadores', ['--story', story, '--repo', d], { TYCON_PACKS_DIR: tmp('packs-vacio-') });
  assert.equal(sin.status, 0, sin.stderr);
  assert.deepEqual(sin.json.validadores, ['tycon-story-validator']);
  assert.deepEqual(sin.json.lanzamientos, []);
  // una story sin .cs en un repo sin .csproj: el revisor de validación del paquete no aplica
  const storyFront = path.join(tmp('packs-story-'), 'story-1-2.md');
  fs.writeFileSync(storyFront, fs.readFileSync(story, 'utf8').replace('src/Foo.cs', 'src/foo.tsx'));
  const front = pipeline('validadores', ['--story', storyFront, '--repo', d], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
  assert.deepEqual(front.json.validadores, ['tycon-story-validator']);
  // pero un repo .NET (con *.csproj) la vuelve de backend aunque la story no nombre .cs
  fs.writeFileSync(path.join(d, 'src', 'Foo.csproj'), '<Project />\n');
  const back = pipeline('validadores', ['--story', storyFront, '--repo', d], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
  assert.deepEqual(back.json.validadores, ['tycon-story-validator', 'rev-val']);
  // una story o un repo que no existen no dan un set «válido» a medias: frenan
  const sinStory = pipeline('validadores', ['--story', path.join(d, 'no-existe.md'), '--repo', d], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
  assert.notEqual(sinStory.status, 0);
  assert.match(sinStory.stderr, /no se pudo leer la story/);
  const sinRepo = pipeline('validadores', ['--story', story, '--repo', path.join(d, 'no-existe')], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir });
  assert.notEqual(sinRepo.status, 0);
  assert.match(sinRepo.stderr, /--repo no es una carpeta/);
  // instalando el paquete real de clientes: el revisor de hermanos entra igual que hoy
  if (SKIP_PUBLIC) { t.diagnostic('NO MEDIDO: packs/clients no está (la copia pública no lo trae) — el paquete real de clientes se mide en el repo del equipo'); return; }
  const real = pipeline('validadores', ['--story', story, '--repo', d], { TYCON_PACKS_DIR: PACKS_REALES });
  assert.equal(real.status, 0, real.stderr);
  assert.ok(real.json.validadores.includes('tycon-sibling-pattern-reviewer'), JSON.stringify(real.json.validadores));
  const hermanos = real.json.lanzamientos.find((x) => x.agente === 'tycon-sibling-pattern-reviewer');
  assert.equal(hermanos.modelo, 'sonnet');
  assert.match(hermanos.prompt, /Modo pre/);
  assert.ok(hermanos.prompt.includes(story) && hermanos.prompt.includes(d));
  assert.match(hermanos.nota || '', /opus/i, 'la excepción de modelo viaja en el manifiesto');
});

// ── T14 · AC 13 — el lint de configuración conoce `packs:` ────────────────────────────────────
test('ConfigLint_ConoceClavePacks', () => {
  const { lintConfig } = require('../lib/config-lint.js');
  const packsDir = paquetes({ bizuit: PRUEBA });
  process.env.TYCON_PACKS_DIR = packsDir;
  try {
    const ok = lintConfig({ repoRoot: tmp('packs-lint-'), txtCarpeta: 'packs: [bizuit]\n' });
    assert.deepEqual(ok.hallazgos, [], JSON.stringify(ok.hallazgos));
    const okBloque = lintConfig({ repoRoot: tmp('packs-lint-'), txtCarpeta: 'packs:\n  - bizuit\n' });
    assert.deepEqual(okBloque.hallazgos, []);
    const mal = lintConfig({ repoRoot: tmp('packs-lint-'), txtCarpeta: 'packs: [nada]\n' });
    assert.equal(mal.hallazgos.length, 1);
    assert.equal(mal.hallazgos[0].llave, 'packs');
    assert.equal(mal.hallazgos[0].tipo, 'paquete-inexistente');
    assert.match(mal.hallazgos[0].mensaje, /nada/);
    assert.ok(mal.hallazgos[0].mensaje.includes(packsDir), 'dice dónde buscó');
    // ítems en columna 0 también se leen acá; una clave sin lista se avisa como tal
    const col0 = lintConfig({ repoRoot: tmp('packs-lint-'), txtCarpeta: 'packs:\n- nada\n' });
    assert.equal(col0.hallazgos.length, 1);
    assert.equal(col0.hallazgos[0].tipo, 'paquete-inexistente');
    const nula = lintConfig({ repoRoot: tmp('packs-lint-'), txtCarpeta: 'packs:\n' });
    assert.equal(nula.hallazgos.length, 1);
    assert.equal(nula.hallazgos[0].tipo, 'packs-sin-lista');
    // «no pude mirar la carpeta» se dice distinto de «no instalado»
    process.env.TYCON_PACKS_DIR = path.join(packsDir, 'no-existe');
    const ciego = lintConfig({ repoRoot: tmp('packs-lint-'), txtCarpeta: 'packs: [bizuit]\n' });
    assert.equal(ciego.hallazgos.length, 1);
    assert.equal(ciego.hallazgos[0].tipo, 'paquetes-ilegibles');
    assert.match(ciego.hallazgos[0].mensaje, /no se pudo leer/);
    // …pero la carpeta POR DEFECTO ausente (máquina sin paquetes, sin variable) es «ninguno instalado»,
    // no «no pude leer»
    delete process.env.TYCON_PACKS_DIR;
    const { lintPaquetes } = require('../lib/config-lint.js');
    const sinPaquetes = lintPaquetes('packs: [bizuit]\n', { packsDir: path.join(packsDir, 'no-existe'), explicito: false });
    assert.equal(sinPaquetes.length, 1);
    assert.equal(sinPaquetes[0].tipo, 'paquete-inexistente');
    assert.match(sinPaquetes[0].mensaje, /instalados: ninguno/);
  } finally {
    delete process.env.TYCON_PACKS_DIR;
  }
});

// ── T37 · AC 8 — el paquete opcional viene apagado por defecto ─────────
test('Packs_ApagadoPorDefectoSinPerfil', (t) => {
  const otro = { ...JSON.parse(JSON.stringify(PRUEBA)), name: 'otro' };
  otro.reviewers = [{ agent: 'rev-otro', group: 'base', when: { detection: 'csModified' }, surface: { paths: ['**/*.cs'] }, depth: 'standard', prefixes: ['RO'] }];
  const packsDir = paquetes({ prueba: PRUEBA, otro });
  const agentsDir = agentes();
  const conRepo = (yaml) => { const d = repo(yaml == null ? {} : { yaml }); agregar(d, 'src/A.cs', 'class X {}\n'); return d; };
  const correr = (d, env) => advisors(d, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir, ...env });
  const nombres = (r) => ordenado((r.json && r.json.packs || []).map((p) => p.nombre));
  const sinPacks = conRepo();

  // el arnés sin encontrar: exit 2 nombrándolo (nunca se lee como «ninguno» ni como «todos los instalados»)
  const perdido = correr(sinPacks, { TYCON_GUIDES_DIR: path.join(tmp('packs-nada-'), 'no-existe') });
  assert.equal(perdido.status, 2, perdido.stderr);
  assert.equal(perdido.json, null, 'sin set a medias');
  assert.match(perdido.stderr, /el arnés/, `nombra el arnés: ${perdido.stderr}`);
  assert.match(perdido.stderr, /packs\.default/, 'y dice para qué lo buscaba');

  // un arnés más viejo (su lector no conoce la clave): como siempre, todos — el orden de merge entre repos no le
  // quita los revisores del paquete a nadie
  const anterior = correr(sinPacks, { TYCON_GUIDES_DIR: arnesDeLaboratorio({ lector: LECTOR_ANTERIOR }) });
  assert.equal(anterior.status, 0, anterior.stderr);
  assert.deepEqual(nombres(anterior), ['otro', 'prueba']);

  // la variable manda sobre todo (la precedencia de tycon-config): puesta, no hace falta el arnés para saber el default;
  // un valor que no es all/none frena nombrando la variable, también sin arnés
  const sinArnes = path.join(tmp('packs-nada-'), 'no-existe');
  const porVariable = correr(sinPacks, { TYCON_GUIDES_DIR: sinArnes, TYCON_PACKS_DEFAULT: 'all' });
  assert.equal(porVariable.status, 0, porVariable.stderr);
  assert.deepEqual(nombres(porVariable), ['otro', 'prueba']);
  const ningunoPorVariable = correr(sinPacks, { TYCON_GUIDES_DIR: sinArnes, TYCON_PACKS_DEFAULT: 'none' });
  assert.equal(ningunoPorVariable.status, 0, ningunoPorVariable.stderr);
  assert.deepEqual(nombres(ningunoPorVariable), []);
  const variableMala = correr(sinPacks, { TYCON_GUIDES_DIR: sinArnes, TYCON_PACKS_DEFAULT: 'algunos' });
  assert.equal(variableMala.status, 2, variableMala.stderr);
  assert.match(variableMala.stderr, /TYCON_PACKS_DEFAULT/);
  // como la lee tycon-config.js: recortada, y sólo espacios = sin poner (va al arnés)
  const conEspacios = correr(sinPacks, { TYCON_GUIDES_DIR: sinArnes, TYCON_PACKS_DEFAULT: ' all ' });
  assert.equal(conEspacios.status, 0, conEspacios.stderr);
  assert.deepEqual(nombres(conEspacios), ['otro', 'prueba']);
  const blanca = correr(sinPacks, { TYCON_GUIDES_DIR: sinArnes, TYCON_PACKS_DEFAULT: '   ' });
  assert.equal(blanca.status, 2, 'sólo espacios es «sin poner»: busca el arnés y no lo encuentra');
  assert.match(blanca.stderr, /el arnés/);

  // un repo que declara `packs:` achica lo que activa la organización (AC 6): con la variable en all, ése; sin
  // arnés ni variable no se sabe qué activó la organización, y frena nombrando el arnés
  const declarado = correr(conRepo('packs: [prueba]\n'), { TYCON_GUIDES_DIR: path.join(tmp('packs-nada-'), 'no-existe'), TYCON_PACKS_DEFAULT: 'all' });
  assert.equal(declarado.status, 0, declarado.stderr);
  assert.deepEqual(nombres(declarado), ['prueba']);
  const declaradoSinArnes = correr(conRepo('packs: [prueba]\n'), { TYCON_GUIDES_DIR: path.join(tmp('packs-nada-'), 'no-existe') });
  assert.equal(declaradoSinArnes.status, 2, declaradoSinArnes.stderr);
  assert.match(declaradoSinArnes.stderr, /el arnés/);

  if (!LECTOR_CONOCE_LA_CLAVE) {
    // Guardia de arranque, no funcionalidad diferida: si el arnés de esta máquina todavía no conoce packs.default no se
    // puede medir, y se dice; con el arnés al día (TYCON_GUIDES_DIR) corre entero
    t.skip(`NO MEDIDO: el arnés de esta máquina (${ARNES_DE_LA_MAQUINA || 'no encontrado'}) no conoce packs.default — definí TYCON_GUIDES_DIR=<clon del arnés al día>`);
    return;
  }
  const sinConfig = arnesDeLaboratorio();
  const conTodos = arnesDeLaboratorio({ perfil: { packs: { default: 'all' } } });

  // un repo sin `packs:` y sin configuración: ninguno (el núcleo corre solo)
  const r1 = correr(sinPacks, { TYCON_GUIDES_DIR: sinConfig });
  assert.equal(r1.status, 0, r1.stderr);
  assert.deepEqual(nombres(r1), [], 'sin configuración, ningún paquete');
  assert.deepEqual(ordenado(r1.json.base), [SB, TC], 'el núcleo, entero');
  assert.equal(r1.json.packs_declarados, null);
  // con un perfil `packs.default: "all"`: todos
  const r2 = correr(sinPacks, { TYCON_GUIDES_DIR: conTodos });
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(nombres(r2), ['otro', 'prueba']);
  assert.ok(r2.json.base.includes('rev-base') && r2.json.base.includes('rev-otro'));
  // con ese perfil y TYCON_PACKS_DEFAULT=none: ninguno (la variable manda)
  const r3 = correr(sinPacks, { TYCON_GUIDES_DIR: conTodos, TYCON_PACKS_DEFAULT: 'none' });
  assert.equal(r3.status, 0, r3.stderr);
  assert.deepEqual(nombres(r3), []);
  // un repo con `packs: [prueba]` sin configuración (la organización no activó ninguno): frena diciendo dónde se activa
  // (el repo achica lo que activa la organización, nunca suma)
  const r4 = correr(conRepo('packs: [prueba]\n'), { TYCON_GUIDES_DIR: sinConfig });
  assert.equal(r4.status, 2, r4.stderr);
  assert.match(r4.stderr, /activalo en Configuración del sitio, sección Paquetes, o en el perfil del equipo/);
  // un repo con `packs: []` y el perfil en "all": ninguno
  const r5 = correr(conRepo('packs: []\n'), { TYCON_GUIDES_DIR: conTodos });
  assert.equal(r5.status, 0, r5.stderr);
  assert.deepEqual(nombres(r5), []);
  // `packs.default` con un valor inválido: exit 2 nombrando archivo y clave (una configuración rota nunca es «ninguno»)
  const malo = arnesDeLaboratorio({ perfil: { packs: { default: 'todos' } } });
  const r6 = correr(sinPacks, { TYCON_GUIDES_DIR: malo });
  assert.equal(r6.status, 2, r6.stderr);
  assert.equal(r6.json, null);
  assert.ok(r6.stderr.includes(path.join(malo, 'perfil-equipo.json')), `nombra el archivo: ${r6.stderr}`);
  assert.match(r6.stderr, /packs\.default/, 'y la clave');
  const r7 = correr(sinPacks, { TYCON_GUIDES_DIR: sinConfig, TYCON_PACKS_DEFAULT: 'algunos' });
  assert.equal(r7.status, 2, r7.stderr);
  assert.match(r7.stderr, /TYCON_PACKS_DEFAULT/);
  // los otros comandos que eligen revisores leen lo mismo
  const v = pipeline('validators', ['--story', storyDeBackend(), '--repo', sinPacks], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir, TYCON_GUIDES_DIR: sinConfig });
  assert.equal(v.status, 0, v.stderr);
  assert.deepEqual(v.json.validadores, ['tycon-story-validator'], 'apagado: el revisor de validación del paquete no entra');

  // con el perfil REAL del equipo (el arnés de esta máquina, HOME de laboratorio): el mismo set de la foto de la equivalencia
  // el perfil se llama team-profile.json; perfil-equipo.json es el nombre de antes, que sigue valiendo
  const perfilReal = ['team-profile.json', 'perfil-equipo.json'].map((n) => path.join(ARNES_DE_LA_MAQUINA, n)).find((p) => fs.existsSync(p));
  if (!perfilReal) { t.diagnostic(`NO MEDIDO: el perfil del equipo no está en ${ARNES_DE_LA_MAQUINA} (la copia pública no lo trae)`); return; }
  // en la copia pública, corrida en una máquina que SÍ tiene el arnés del equipo instalado, el perfil
  // está pero el paquete de clientes no: la foto de la equivalencia nombra a sus revisores y no se puede comparar. Se dice.
  if (SKIP_PUBLIC) { t.diagnostic(`NO MEDIDO: el set de la foto con el perfil del equipo (${SKIP_PUBLIC}); se mide en el repo del equipo`); return; }
  const { CASOS, medir, sinOrden, leerFoto } = require('../lib/equivalence-cases.js');
  const foto = leerFoto(path.join(__dirname, 'fixtures', 'equivalence-main.json'));   // la que viaja + la de cada paquete con casos
  // el perfil real, en un arnés sin los modelos por revisor de la organización (team-repos.json no se copia): la foto se
  // tomó sin ellos. Lleva la biblioteca entera del arnés, que valida todas las claves del perfil.
  const conPerfil = tmp('packs-arnes-perfil-');
  fs.cpSync(path.join(ARNES_DE_LA_MAQUINA, 'scripts', 'lib'), path.join(conPerfil, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(conPerfil, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/sh\n');
  fs.copyFileSync(perfilReal, path.join(conPerfil, path.basename(perfilReal)));
  for (const caso of CASOS) {
    const dir = tmp('packs-foto-');
    const { files } = caso.armar(dir);
    const nuevo = medir({ pipeline: PIPELINE, repo: dir, files,
      env: { HOME: tmp('packs-home-foto-'), TYCON_SESSION_ID: 'packs-test', TYCON_PACKS_DIR: PACKS_REALES, TYCON_GUIDES_DIR: conPerfil } });
    assert.deepEqual(sinOrden(nuevo), foto.casos[caso.nombre], `con el perfil del equipo, el caso «${caso.nombre}» da la foto de la 8.2`);
  }
});

// ── las banderas que el vocabulario acepta son exactamente las que produce detectStack ──────────
test('Pack_Banderas_SonLasDeDetectStack', () => {
  const { detectStack, BANDERAS_DETECCION } = require('../pipeline.js');
  const d = repo();
  const banderas = Object.keys(detectStack(d, ['src/A.cs'])).filter((k) => k !== 'warning').sort();
  assert.deepEqual(banderas, BANDERAS_DETECCION.slice().sort());
});

// «ningún paquete instalado» no es lo mismo que «ninguno activo». Sin esa distinción el pipeline diría «no hay paquetes
// instalados» con el paquete bizuit instalado y packs.default en none (el perfil del equipo no viajó): la salida tiene
// que decir cuál de las dos cosas pasa, en `packs_nota`.
test('Packs_NingunoActivo_SeDiceDistintoDeNingunoInstalado', (t) => {
  if (!LECTOR_CONOCE_LA_CLAVE) { t.skip('NO MEDIDO: el arnés de esta máquina no conoce packs.default'); return; }
  const otro = { ...JSON.parse(JSON.stringify(PRUEBA)), name: 'otro' };
  otro.reviewers = [{ agent: 'rev-otro', group: 'base', when: { detection: 'csModified' }, surface: { paths: ['**/*.cs'] }, depth: 'standard', prefixes: ['RO'] }];
  const packsDir = paquetes({ prueba: PRUEBA, otro });
  const agentsDir = agentes();
  const d = repo({}); agregar(d, 'src/A.cs', 'class X {}\n');
  const correr = (env) => advisors(d, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir, ...env });
  // instalados dos, packs.default none (el perfil) y el repo sin `packs:`: ninguno activo, y la nota lo dice con los nombres
  const ninguno = correr({ TYCON_GUIDES_DIR: arnesDeLaboratorio({ perfil: { packs: { default: 'none' } } }) });
  assert.equal(ninguno.status, 0, ninguno.stderr);
  assert.deepEqual(ninguno.json.packs, []);
  assert.match(String(ninguno.json.packs_nota), /^2 paquetes instalados \(otro, prueba\) y ninguno activo: packs\.default es none \(perfil\) y el repo no declara packs:/);
  // con todos activos no hay nota
  const todos = correr({ TYCON_GUIDES_DIR: arnesDeLaboratorio({ perfil: { packs: { default: 'all' } } }) });
  assert.equal(todos.status, 0, todos.stderr);
  assert.equal(todos.json.packs_nota, null);
  // sin ningún paquete instalado: la nota dice eso, con la carpeta donde buscó
  const vacio = tmp('packs-vacio-');
  const sin = advisors(d, ['src/A.cs'], { TYCON_PACKS_DIR: vacio, TYCON_AGENTS_DIR: agentsDir, TYCON_GUIDES_DIR: arnesDeLaboratorio({ perfil: { packs: { default: 'all' } } }) });
  assert.equal(sin.status, 0, sin.stderr);
  assert.deepEqual(sin.json.packs, []);
  assert.match(String(sin.json.packs_nota), /^ningún paquete instalado en /);
  assert.ok(String(sin.json.packs_nota).includes(vacio));
  // el repo que restringe a ninguno a propósito (`packs: []`) tampoco se confunde con «no instalados»
  const restringido = repo({ yaml: 'packs: []\n' }); agregar(restringido, 'src/A.cs', 'class X {}\n');
  const r = advisors(restringido, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir, TYCON_GUIDES_DIR: arnesDeLaboratorio({ perfil: { packs: { default: 'all' } } }) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(String(r.json.packs_nota), /^2 paquetes instalados \(otro, prueba\) y ninguno activo: el repo declara packs: \[\]/);
});

// El perfil del equipo gana sobre los paquetes que la máquina eligió al instalar. Una instalación con `--packs all`
// deja esa elección en el archivo de la máquina, y no le puede ganar al perfil. El pipeline no tiene
// orden propio (le pregunta al lector del arnés): esta prueba sostiene que lo que activa en un repo sin `packs:` es lo que
// dice el perfil, y que la nota de «ninguno activo» no le echa la culpa a un perfil ausente cuando el perfil está y dice none.
// Si ganara la máquina daría: ningún paquete en el primer caso, los dos en el segundo.
test('8.29 · T6 Packs_DefaultFollowsTheProfile @story-8.29 @ac-6 — en un repo sin packs:, los paquetes activos son los del perfil aunque la máquina diga otra cosa', (t) => {
  // el lector que se mide es el de ESTE árbol (el repo unido lo trae al lado; es el código que define la regla). El de la
  // máquina puede ser una versión instalada anterior a la regla: con ése no se puede medir, y se dice
  const delArbol = path.join(RAIZ, 'scripts', 'lib', 'tycon-config.js');
  const enElArbol = fs.existsSync(delArbol);
  const lector = enElArbol ? delArbol : LECTOR_REAL;
  const conoce = (m) => Array.isArray(m.PROFILE_WINS) && m.PROFILE_WINS.includes('packs.default');
  if (enElArbol) {
    // el lector que viaja con este árbol es el que define la regla: si no carga o perdió la regla, es ROJO, no «no medido»
    assert.ok(conoce(require(lector)), `${lector} no declara que el perfil gana en packs.default`);
  } else {
    let conoceLaRegla = false;
    try { conoceLaRegla = !!lector && conoce(require(lector)); } catch (_e) { conoceLaRegla = false; }
    if (!conoceLaRegla) { t.skip(`NO MEDIDO: este árbol no trae lector y el de la máquina (${lector || 'no encontrado'}) es anterior a la regla «el perfil gana en los paquetes»`); return; }
  }
  const textoDelLector = fs.readFileSync(lector, 'utf8');
  const arnesDeLaboratorio829 = ({ perfil } = {}) => arnesDeLaboratorio({ lector: textoDelLector, perfil });
  const otro = { ...JSON.parse(JSON.stringify(PRUEBA)), name: 'otro' };
  otro.reviewers = [{ agent: 'rev-otro', group: 'base', when: { detection: 'csModified' }, surface: { paths: ['**/*.cs'] }, depth: 'standard', prefixes: ['RO'] }];
  const packsDir = paquetes({ prueba: PRUEBA, otro });
  const agentsDir = agentes();
  const d = repo({}); agregar(d, 'src/A.cs', 'class X {}\n');
  /** Una carpeta de usuario cuyo archivo de configuración dice los paquetes que la máquina eligió al instalar. */
  const casaCon = (valor) => {
    const h = tmp('packs-home-maquina-');
    fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(h, '.claude', 'tycon.json'), JSON.stringify({ packs: { default: valor } }, null, 2) + '\n');
    return h;
  };
  const correr = (env) => advisors(d, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentsDir, ...env });

  // el perfil dice all y la máquina none: todos los instalados
  const todos = correr({ HOME: casaCon('none'), TYCON_GUIDES_DIR: arnesDeLaboratorio829({ perfil: { packs: { default: 'all' } } }) });
  assert.equal(todos.status, 0, todos.stderr);
  assert.deepEqual(ordenado((todos.json.packs || []).map((p) => p.nombre)), ['otro', 'prueba'], 'gana el perfil: los dos paquetes');
  assert.equal(todos.json.packs_nota, null);

  // el perfil dice none y la máquina all: ninguno, y la nota dice que lo fija el perfil (no que el perfil falta)
  const ninguno = correr({ HOME: casaCon('all'), TYCON_GUIDES_DIR: arnesDeLaboratorio829({ perfil: { packs: { default: 'none' } } }) });
  assert.equal(ninguno.status, 0, ninguno.stderr);
  assert.deepEqual(ninguno.json.packs, []);
  const nota = String(ninguno.json.packs_nota);
  assert.match(nota, /^2 paquetes instalados \(otro, prueba\) y ninguno activo: packs\.default es none \(perfil\) y el repo no declara packs:/);
  assert.match(nota, /lo fija el perfil del equipo/);
  assert.doesNotMatch(nota, /ausente/, 'el perfil está y dice none: no es un perfil ausente');

  // sin perfil, lo que eligió la máquina sigue valiendo (y ahí la nota de siempre, que nombra al perfil ausente, es cierta)
  const sinPerfil = correr({ HOME: casaCon('all'), TYCON_GUIDES_DIR: arnesDeLaboratorio829() });
  assert.equal(sinPerfil.status, 0, sinPerfil.stderr);
  assert.deepEqual(ordenado((sinPerfil.json.packs || []).map((p) => p.nombre)), ['otro', 'prueba']);
  const apagada = correr({ HOME: casaCon('none'), TYCON_GUIDES_DIR: arnesDeLaboratorio829() });
  assert.equal(apagada.status, 0, apagada.stderr);
  assert.match(String(apagada.json.packs_nota), /packs\.default es none \(maquina\)[^\n]*perfil del equipo ausente/);

  // …y la función misma, preguntada directo (en un proceso aparte, con su carpeta de usuario): valor Y origen
  const directo = (home, arnes, extra) => {
    const r = spawnSync(process.execPath, ['-e', `
      const packs = require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'packs.js'))});
      const { value, origin } = packs.packsDefault({ env: process.env });
      process.stdout.write(JSON.stringify({ value, origin }));`],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TYCON_GUIDES_DIR: arnes, ...(extra || {}) } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(directo(casaCon('none'), arnesDeLaboratorio829({ perfil: { packs: { default: 'all' } } })), { value: 'all', origin: 'perfil' });
  assert.deepEqual(directo(casaCon('all'), arnesDeLaboratorio829({ perfil: { packs: { default: 'none' } } })), { value: 'none', origin: 'perfil' });
  assert.deepEqual(directo(casaCon('none'), arnesDeLaboratorio829()), { value: 'none', origin: 'maquina' }, 'sin perfil: la máquina');
  assert.deepEqual(directo(casaCon('none'), arnesDeLaboratorio829({ perfil: { update: { apply: 'auto' } } })), { value: 'none', origin: 'maquina' }, 'un perfil que calla los paquetes no le gana a nadie');
  assert.deepEqual(directo(casaCon('all'), arnesDeLaboratorio829({ perfil: { packs: { default: 'none' } } }), { TYCON_PACKS_DEFAULT: 'all' }),
    { value: 'all', origin: 'TYCON_PACKS_DEFAULT' }, 'la variable le gana al perfil');
});

// ── un paquete activo que falta: el mensaje dice de dónde sale el pedido y qué hacer ──────
test('MissingActivePack_SaysWhatToDo', () => {
  const { queHacerSiFalta } = require('../lib/packs.js');
  const maquina = queHacerSiFalta('maquina');
  assert.match(maquina, /configuración de esta máquina/);
  assert.match(maquina, /repo del perfil/);
  assert.match(maquina, /harness\.js team-init --local/);
  assert.match(maquina, /packs\.default/);
  const perfil = queHacerSiFalta('perfil');
  assert.match(perfil, /perfil/);
  assert.match(perfil, /harness\.js update/);
  const variable = queHacerSiFalta('TYCON_PACKS_DEFAULT');
  assert.match(variable, /TYCON_PACKS_DEFAULT/);
  for (const m of [maquina, perfil, variable]) assert.doesNotMatch(m, /[A-Z]{3,}-[CW]\d|PackError|activosDeLaOrganizacion/);
  // por el comando real: con la variable pidiendo uno que no está, sale ≠ 0 con el origen y el paso
  const packsDir = paquetes({ prueba: PRUEBA });
  const d = repo();
  agregar(d, 'src/A.cs', 'class X {}\n');
  const r = advisors(d, ['src/A.cs'], { TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: agentes(), TYCON_PACKS_DEFAULT: 'mi-stack' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /mi-stack/);
  assert.match(r.stderr, /TYCON_PACKS_DEFAULT/);
});

// ── las instrucciones de un revisor viven en la carpeta de agentes de su paquete ──────
/** Un paquete `acme-x` con un revisor y su `.md` donde se pida: en la carpeta del paquete (`propia`) o en la raíz. */
function paqueteConRevisor({ declara = null, enElPaquete = true, enLaRaiz = false } = {}) {
  const packsDir = paquetes({ 'acme-x': { name: 'acme-x', description: 'x', ...(declara ? { agents: declara } : {}), reviewers: [{ agent: 'acme-x-reviewer', group: 'base', when: { detection: 'csModified' }, surface: { paths: ['**/*.x'] }, depth: 'lean', prefixes: ['ACMEX'] }] } });
  const raiz = agentes(...(enLaRaiz ? ['acme-x-reviewer'] : []));
  if (enElPaquete) {
    const carpeta = path.join(packsDir, 'acme-x', declara || 'agents');
    fs.mkdirSync(carpeta, { recursive: true });
    fs.writeFileSync(path.join(carpeta, 'acme-x-reviewer.md'), '---\nname: acme-x-reviewer\n---\n# acme-x-reviewer\n');
  }
  return { packsDir, agentsDir: raiz };
}

test('T13 Instrucciones_FueraDeSuPaquete_Problema @story-2.63 @ac-9 — un revisor que sólo está en agents/ de la raíz es un problema que dice dónde va', () => {
  const { validateTree } = require('../lib/packs.js');
  // sin carpeta declarada, la del paquete es «agents»
  const sinDeclarar = paqueteConRevisor({ enElPaquete: false, enLaRaiz: true });
  const e1 = validateTree(sinDeclarar);
  assert.strictEqual(e1.length, 1, JSON.stringify(e1));
  assert.strictEqual(e1[0].revisor, 'acme-x-reviewer');
  assert.strictEqual(e1[0].motivo, 'las instrucciones de acme-x-reviewer tienen que estar en packs/acme-x/agents/acme-x-reviewer.md (hoy están en agents/acme-x-reviewer.md)');
  // con una carpeta declarada, ésa
  const declarada = paqueteConRevisor({ declara: 'revisores', enElPaquete: false, enLaRaiz: true });
  assert.match(validateTree(declarada).map((e) => e.motivo).join(' · '), /tienen que estar en packs\/acme-x\/revisores\/acme-x-reviewer\.md \(hoy están en agents\/acme-x-reviewer\.md\)/);
  // en ningún lado: «no existe», con la ruta del paquete
  assert.match(validateTree(paqueteConRevisor({ enElPaquete: false })).map((e) => e.motivo).join(' · '), /no existe el agente .*acme-x\/agents\/acme-x-reviewer\.md$/);
  // en los dos lugares sigue siendo un problema
  assert.match(validateTree(paqueteConRevisor({ enLaRaiz: true })).map((e) => e.motivo).join(' · '), /dos lugares/);
});

test('T14 Instrucciones_EnSuPaquete_Pasa @story-2.63 @ac-9 @ac-14 — en la carpeta de su paquete pasa, declarada o no; el ejemplo del árbol también', () => {
  const { validateTree } = require('../lib/packs.js');
  assert.deepStrictEqual(validateTree(paqueteConRevisor()), [], 'sin declarar: packs/<p>/agents/');
  assert.deepStrictEqual(validateTree(paqueteConRevisor({ declara: 'revisores' })), [], 'declarada');
  // el paquete de ejemplo del árbol
  const ejemplos = path.join(RAIZ, 'examples', 'packs');
  if (fs.existsSync(ejemplos)) assert.deepStrictEqual(validateTree({ packsDir: ejemplos, agentsDir: path.join(RAIZ, 'agents') }), [], 'examples/packs');
  // y los paquetes instalados del árbol, si los trae (el árbol armado con el perfil del equipo: bizuit, clients…)
  assert.deepStrictEqual(validateTree({ packsDir: PACKS_REALES, agentsDir: path.join(RAIZ, 'agents') }), [], 'packs/ del árbol');
  // el enlazador de piezas toma la misma carpeta: un paquete sin «agents» declarado enlaza los de su agents/
  const PP = require(path.join(RAIZ, 'scripts', 'lib', 'pack-pieces.js'));
  const { packsDir, agentsDir } = paqueteConRevisor();
  const piezas = PP.piecesOf({ packsDir, agentsDir, coreSkillsDir: tmp('packs-skills-'), names: ['acme-x'] });
  assert.deepStrictEqual(piezas.agents.map((a) => [a.pack, a.name]), [['acme-x', 'acme-x-reviewer.md']]);
  assert.deepStrictEqual(piezas.errores, []);
  // y el cargador del pipeline dice esa carpeta como la de los agentes del paquete
  const { cargarPaquetes, resetCache, BANDERAS } = require('../lib/packs.js');
  resetCache();
  const [p] = cargarPaquetes({ packsDir, agentsDir, banderas: BANDERAS });
  assert.strictEqual(p.agentes, path.join(packsDir, 'acme-x', 'agents'));
});

// el validador de antes de la regla de la carpeta del paquete: el de main justo antes de que entrara
const VALIDADOR_ANTERIOR = '3a97d3898d6b5d2bb9426a441feb513bac3d105e';
test('T15 ClientesMudado_LeenLasDosVersiones @story-2.63 @ac-10 — el paquete con su revisor mudado lo leen el validador anterior y el nuevo', (t) => {
  const mudado = paqueteConRevisor({ declara: 'agents' });
  // el validador anterior, sacado de la historia del repo a una carpeta aparte (con el módulo que pide)
  const leer = (ruta) => spawnSync('git', ['-C', RAIZ, 'show', `${VALIDADOR_ANTERIOR}:${ruta}`], { encoding: 'utf8' });
  const viejo = leer('skills/tycon-pipeline/scripts/lib/packs.js');
  // la CI del público baja la historia entera: ahí no tenerla es un rojo, no un salteo
  if (viejo.status !== 0 && process.env.GITHUB_ACTIONS === 'true') assert.fail(`la CI no trae el commit ${VALIDADOR_ANTERIOR.slice(0, 7)}: ${viejo.stderr}`);
  if (viejo.status !== 0) return t.skip(`NO MEDIDO: este árbol no tiene la historia con el validador anterior (${VALIDADOR_ANTERIOR.slice(0, 7)})`);
  const dir = tmp('packs-anterior-');
  fs.writeFileSync(path.join(dir, 'packs.js'), viejo.stdout);
  fs.writeFileSync(path.join(dir, 'legacy-names.js'), leer('skills/tycon-pipeline/scripts/lib/legacy-names.js').stdout);
  const anterior = require(path.join(dir, 'packs.js'));
  assert.deepStrictEqual(anterior.validateTree(mudado), [], 'el validador anterior');
  assert.deepStrictEqual(require('../lib/packs.js').validateTree(mudado), [], 'el nuevo');
  // y el anterior aceptaba el revisor en la raíz, que el nuevo ya no
  assert.deepStrictEqual(anterior.validateTree(paqueteConRevisor({ enElPaquete: false, enLaRaiz: true })), []);
});
