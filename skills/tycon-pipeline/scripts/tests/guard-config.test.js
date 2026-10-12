'use strict';

/**
 * guard-config.test.js —la superficie de config del repo: de dónde la lee un FRENO (FIX-1) y qué
 * pasa cuando está mal escrita (FIX-3). 2026-08-25.
 *
 * La regla que fija esta suite, en una frase: **aflojar exige commit, apretar vale al toque.**
 * De ahí salen dos modos y cada llave usa el que le corresponde por su DIRECCIÓN:
 *   · `companion_repos` y `qa_guide` AFLOJAN  → sólo lo commiteado.
 *   · `stories.id_pattern` y `fe_paths` DELIMITAN → unión de commiteado y carpeta.
 *
 * El caso `union-no-es-ignorar-la-config` es el que impide la implementación perezosa: si la unión
 * se hiciera "ignorando el yaml", los repos que recortan a propósito (material de un banco de evals
 * que sólo LUCE como story) empezarían a comerse el freno entero y nadie lo notaría hasta el ruido.
 *
 * Lanza git → throttle DIARIO, no en cada arranque.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const cs = require('../lib/config-source.js');
const { storiesConfigForGate } = require('../lib/story-discovery.js');
const ec = require('../lib/evidence-config.js');
const ui = require('../lib/ui-signal.js');

function git(dir, ...args) { spawnSync('git', ['-C', dir, ...args], { stdio: 'ignore' }); }

/** Repo de laboratorio: `commiteado` va al commit, `carpeta` queda sin commitear (null = sin archivo). */
function repo({ commiteado, carpeta }) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgfreno-'));
  fs.mkdirSync(path.join(d, '.tycon'), { recursive: true });
  git(d, 'init', '-q', '-b', 'main', '.');
  fs.writeFileSync(path.join(d, 'a.txt'), 'x\n');
  if (commiteado != null) fs.writeFileSync(path.join(d, '.tycon', 'advisors.yaml'), commiteado);
  git(d, 'add', 'a.txt', '.tycon');
  git(d, '-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base');
  if (carpeta === null) { try { fs.unlinkSync(path.join(d, '.tycon', 'advisors.yaml')); } catch (_e) { /* no estaba */ } }
  else if (carpeta !== undefined) fs.writeFileSync(path.join(d, '.tycon', 'advisors.yaml'), carpeta);
  cs.limpiarCache();
  return d;
}

const PAT_ZZZ = 'stories:\n  id_pattern: ^ZZZ-[0-9]+$\n';
const PAT_EV = 'stories:\n  id_pattern: ^EV-[0-9]+$\n';

// ── stories.id_pattern — UNIÓN ────────────────────────────────────────────────────────────────
test('un id_pattern imposible SIN commitear no saca a la story del freno', () => {
  const d = repo({ commiteado: null, carpeta: PAT_ZZZ });
  const cfg = storiesConfigForGate(d);
  assert.ok(cfg.idPattern.test('4.2'), 'la 4.2 tiene que seguir siendo una story de trabajo');
  assert.equal(cfg.difieren, true);
  assert.ok(cfg.warnings.some((w) => /DIFIERE/.test(w)), 'la diferencia se avisa, no se traga');
});

test('un recorte COMMITEADO sí saca a la story del freno (union ≠ ignorar la config)', () => {
  const d = repo({ commiteado: PAT_EV, carpeta: PAT_EV });
  const cfg = storiesConfigForGate(d);
  assert.equal(cfg.idPattern.test('4.2'), false, 'el repo declaró que acá "4.2" no es trabajo — commiteado, vale');
  assert.ok(cfg.idPattern.test('EV-1'));
  assert.equal(cfg.difieren, false);
  assert.equal(cfg.warnings.length, 0, 'sin diferencia no hay ruido');
});

test('AMPLIAR el alcance vale al toque, sin esperar al commit', () => {
  // El commit que INTRODUCE un patrón nuevo (caso del backend de un producto del equipo: 18 stories AP-*/CO-*) no puede
  // dejar esas stories fuera del freno justo en ese commit — de ahí que sea unión y no "manda HEAD".
  const d = repo({ commiteado: null, carpeta: 'stories:\n  id_pattern: ^(AP|CO)-[0-9]+$\n' });
  const cfg = storiesConfigForGate(d);
  assert.ok(cfg.idPattern.test('AP-7'), 'la story nueva entra al freno en el mismo commit que la declara');
  assert.ok(cfg.idPattern.test('4.2'), 'y las de siempre no se pierden');
});

test('sin config no hay costo ni cambio de comportamiento', () => {
  const d = repo({ commiteado: null, carpeta: null });
  const cfg = storiesConfigForGate(d);
  assert.equal(cfg.idPattern, null, 'ninguno declara patrón → la forma por default de siempre');
  assert.equal(cfg.warnings.length, 0);
});

test('sin historia git todavía, se cae a la carpeta (fail-open explícito)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgfreno-nohist-'));
  fs.mkdirSync(path.join(d, '.tycon'), { recursive: true });
  git(d, 'init', '-q', '-b', 'main', '.');
  fs.writeFileSync(path.join(d, '.tycon', 'advisors.yaml'), PAT_EV);
  cs.limpiarCache();
  assert.equal(cs.leerAmbas(d).hayHistoria, false);
  assert.equal(storiesConfigForGate(d).idPattern.test('4.2'), false, 'sin commit contra el cual contrastar, manda la carpeta');
});

// ── evidence.companion_repos — SÓLO COMMITEADO ────────────────────────────────────────────────
test('un repo hermano declarado sin commitear NO aporta evidencia, y se avisa', () => {
  const d = repo({ commiteado: null, carpeta: 'evidence:\n  companion_repos:\n    - Hermano\n' });
  const cfg = ec.parseEvidenceConfig(d, { freno: true });
  assert.deepEqual(cfg.roots, [], 'declarar un hermano AFLOJA: sin commit, no cuenta');
  assert.deepEqual(cfg.missing, [], 'tampoco entra por la puerta de "declarado pero no existe"');
  assert.ok(cfg.warnings.some((w) => /AFLOJA el freno/.test(w)),
    'el efecto de borde (rojo hasta commitear) se dice, no se deja adivinar');
});

test('el hermano COMMITEADO sí se toma', () => {
  const yaml = 'evidence:\n  companion_repos:\n    - Hermano\n';
  const d = repo({ commiteado: yaml, carpeta: yaml });
  fs.mkdirSync(path.join(path.dirname(d), 'Hermano', '.advisors', 'dod-runtime'), { recursive: true });
  cs.limpiarCache();
  const cfg = ec.parseEvidenceConfig(d, { freno: true });
  assert.equal(cfg.roots.length, 1, 'commiteado y existente → cuenta');
  assert.equal(cfg.warnings.length, 0);
});

test('sin modo freno (descubrimiento/reportes) se sigue leyendo SÓLO la carpeta', () => {
  // Commiteado y carpeta declaran cosas DISTINTAS a propósito: si fueran iguales, el caso no
  // podría distinguir el modo freno del modo normal y pasaría siempre.
  const d = repo({
    commiteado: 'evidence:\n  fe_paths:\n    - viejo\n',
    carpeta: 'evidence:\n  fe_paths:\n    - nuevo\n',
  });
  assert.deepEqual(ec.parseEvidenceConfig(d).fePaths, ['nuevo'],
    'el modo freno es opt-in: los consumidores que no gatean leen la carpeta, como siempre');
  assert.deepEqual(ec.parseEvidenceConfig(d, { freno: true }).fePaths.sort(), ['nuevo', 'viejo'],
    'y el modo freno sí toma los dos');
});

// ── evidence.fe_paths — UNIÓN (caso C9) ───────────────────────────────────────────────────────
test('sacar un nombre de carpeta del frente NO apaga la exigencia hasta commitearlo', () => {
  const d = repo({
    commiteado: 'evidence:\n  fe_paths:\n    - ceibo-deposito\n',
    carpeta: 'evidence:\n  fe_paths: []\n',
  });
  const cfg = ec.parseEvidenceConfig(d, { freno: true });
  assert.deepEqual(cfg.fePaths, ['ceibo-deposito'], 'recortar la lista es aflojar: espera al commit');
  // 🔴 La story se escribe SIN ninguna señal genérica (nada de `.tsx`, `src/app/`, `frontend`, ni
  // escenarios Playwright): su única marca de interfaz es el token DECLARADO. Si tuviera una señal
  // genérica, el caso daría verde igual con el arreglo revertido — o sea, no probaría nada.
  const story = '---\nstory: "1.1"\nfiles:\n  - ceibo-deposito/Panel.razor\n---\n# x\n';
  assert.equal(ui.storyTouchesUi(story, d), true, 'sigue siendo story de interfaz → sigue exigiendo navegador');
});

// Story 7.18: el nombre declarado se busca en las LISTAS de archivos; en la prosa (driver, título) sólo
// cuando la story no declara archivos a tocar. Antes, nombrarlo en el driver de una story de backend
// encendía la exigencia de navegador.
test('la prosa del frontmatter no enciende la exigencia de navegador cuando hay listas; el nombre declarado en una lista sí', () => {
  const d = repo({ commiteado: 'evidence:\n  fe_paths:\n    - acme-deposito\n', carpeta: 'evidence:\n  fe_paths:\n    - acme-deposito\n' });
  const enProsa = '---\nstory: "1.1"\ndriver: "el panel de acme-deposito necesita este endpoint"\nfiles:\n  - src/Backend/Endpoint.cs\n---\n# x\n';
  assert.equal(ui.storyTouchesUi(enProsa, d), false, 'el nombre sólo en el driver, con listas de backend: no es pantalla');
  const enLista = '---\nstory: "1.1"\nfiles:\n  - src/Backend/Endpoint.cs\n  - acme-deposito/Panel.razor\n---\n# x\n';
  assert.equal(ui.storyTouchesUi(enLista, d), true, 'el nombre en un item de la lista: sigue siendo pantalla');
});

test('agregar un nombre de carpeta al frente vale al toque', () => {
  const d = repo({ commiteado: 'evidence:\n  fe_paths: []\n', carpeta: 'evidence:\n  fe_paths:\n    - totora-encargos\n' });
  assert.deepEqual(ec.parseEvidenceConfig(d, { freno: true }).fePaths, ['totora-encargos']);
});

// ── qa_guide — SÓLO COMMITEADO (C8 parte 2) ───────────────────────────────────────────────────
test('qa_guide: off sin commitear no apaga nada; commiteado sí', () => {
  const atdd = require('../lib/atdd-commit-gate.js');
  const sinCommitear = repo({ commiteado: null, carpeta: 'qa_guide: off\n' });
  assert.equal(atdd.qaGuideMode(cs.textoParaFreno(sinCommitear)), 'auto', 'apagar es aflojar: sin commit, no');
  const commiteado = repo({ commiteado: 'qa_guide: off\n', carpeta: 'qa_guide: off\n' });
  assert.equal(atdd.qaGuideMode(cs.textoParaFreno(commiteado)), 'off', 'commiteado, el escape del repo funciona');
});

// ── FIX-3 — el lector de config: primer nivel, y avisar ante llaves desconocidas ───────────────
//
// El lector del bloque `e2e:` aceptaba llaves a CUALQUIER profundidad. El caso real (el frontend de un producto del equipo):
// un bloque `forms:` anidado por error hacía que la lista de specs críticos de UN formulario se
// tomara como la del repo entero — y las pruebas de un formulario terminaban apuntando al otro,
// donde ese archivo no existe. No daba error: daba una config que no era la que el repo creía tener.

function e2eCfg(repoDir) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'e2e-config', '--repo', repoDir],
    { encoding: 'utf8', timeout: 20000 });
  return { json: JSON.parse(r.stdout || '{}'), stderr: r.stderr || '' };
}

function repoConE2e(yaml) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'e2ecfg-'));
  fs.mkdirSync(path.join(d, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(d, '.tycon', 'advisors.yaml'), yaml);
  return d;
}

test('una llave anidada por error NO se lee, y se avisa', () => {
  const d = repoConE2e([
    'e2e:',
    '  gate: scripts/e2e-gate.sh',
    '  frontend_dirs:',
    '    - UTAU_FormA',
    '    - UTAU_FormB',
    '  forms:',
    '    UTAU_FormB:',
    '      critical_manifest: .tycon/formb-critical.txt',
    '',
  ].join('\n'));
  const { json, stderr } = e2eCfg(d);
  assert.equal(json.critical_manifest, null,
    'la lista de specs críticos de UN formulario no puede pasar por la del repo entero');
  assert.equal(json.config_warnings.length, 2, 'una llave desconocida + una anidada');
  assert.match(stderr, /ANIDADA/, 'el aviso sale por stderr: una config muda es el modo de falla que se está cerrando');
});

test('una llave mal escrita se avisa en vez de ignorarse en silencio', () => {
  const d = repoConE2e('e2e:\n  gate: scripts/g.sh\n  frontend_dir: app\n  critical_manifiest: .tycon/x.txt\n');
  const { json } = e2eCfg(d);
  assert.equal(json.critical_manifest, null);
  assert.ok(json.config_warnings.some((w) => /critical_manifiest/.test(w)),
    'el typo tiene que nombrarse: "se ignora y el repo queda sin la config que cree tener"');
});

// ── `e2e.bundle`: dos controles del mismo arnés se contradecían (2026-09-22) ─────────────────
// `e2e-gate.sh` LEE y USA esta llave —está documentada en su cabecera, `leer_bundle` parsea sus
// hijas `artifact`/`sources`/`rebuild`, y con `rebuild:` recompila sola antes de correr— pero el
// validador de config no la conocía: le decía al dev que su configuración no servía, y de yapa que
// moviera las hijas al primer nivel, que es exactamente al revés de lo que el gate parsea.
// El dev que obedecía el aviso ROMPÍA una configuración correcta.
//
// Lo destapó la Story CA-1 de Totora: la autodetección del bundle apuntó a `dev-credentials.js`
// —un archivo de agosto que no es el bundle— porque `dev.html` carga el suyo con un `import()`
// dinámico que ninguna heurística de `<script src>` puede ver. El escape documentado para ese caso
// es justo esta llave. Hallazgo: `tasks/hallazgo-e2e-bundle-clave-desconocida-2026-09-22.md`.
// 🔴 rojo previo: dos avisos ("NO conoce `bundle`" + "`artifact`… están ANIDADAS").
test('e2e.bundle es una llave conocida y sus hijas viven anidadas a propósito', () => {
  const d = repoConE2e([
    'e2e:',
    '  gate: scripts/e2e-gate.sh',
    '  frontend_dir: app',
    '  bundle:',
    '    artifact: dist/form.dev.js',
    '    sources: src',
    '    rebuild: npm run build:dev',
    '',
  ].join('\n'));
  const { json } = e2eCfg(d);
  assert.deepEqual(json.config_warnings, [],
    `una config que el gate SÍ lee no puede recibir avisos: ${JSON.stringify(json.config_warnings)}`);
});

// …y la salvaguarda: lo que hizo nacer el chequeo de anidamiento sigue avisando. Una hija de
// `bundle` escrita al primer nivel es un error real (el gate no la lee de ahí), y una llave anidada
// bajo OTRA que no admite hijas también.
test('el permiso de anidar es SÓLO para las hijas de bundle', () => {
  const plana = repoConE2e('e2e:\n  gate: g.sh\n  frontend_dir: app\n  artifact: dist/x.js\n');
  assert.ok(e2eCfg(plana).json.config_warnings.some((w) => /artifact/.test(w)),
    'una hija de bundle escrita al primer nivel es un error: el gate la lee anidada');
  const ajena = repoConE2e('e2e:\n  gate: g.sh\n  frontend_dir: app\n  forms:\n    UTAU:\n      critical_manifest: x.txt\n');
  assert.ok(e2eCfg(ajena).json.config_warnings.some((w) => /ANIDADA/.test(w)),
    'anidar bajo una llave que no admite hijas sigue avisando (el caso de URUTAU que lo originó)');
});

test('una config bien escrita no produce ni un aviso', () => {
  const d = repoConE2e([
    'e2e:',
    '  gate: scripts/e2e-gate.sh',
    '  frontend_dirs:',
    '    - app-a',
    '    - app-b',
    '  critical_manifest: .tycon/critical.txt',
    '  shared_paths:',
    '    - shared',
    '    - .tycon',
    '  preconditions:',
    '    - "http://localhost:5001/api/health|DevHost"',
    '',
  ].join('\n'));
  const { json, stderr } = e2eCfg(d);
  assert.deepEqual(json.config_warnings, [], 'un gate que grita sobre config legítima se apaga');
  assert.equal(stderr.trim(), '');
  assert.equal(json.frontend_dirs.length, 2);
  assert.deepEqual(json.shared_paths, ['shared', '.tycon']);
});

// Los repos de verdad de ESTA máquina: toda carpeta con `.tycon/advisors.yaml` bajo la raíz de repos (la única variable
// del arnés para eso, `TYCON_REPOS_ROOT`; sin ella, `~/SourceCode`), hasta dos niveles. Sin nombres escritos: la lista de
// repos de un equipo no vive en una prueba (story 8.10.3, tanda C — la lista de antes nombraba cuatro repos y, al quedar
// todos con nombres inventados, la prueba pasaba sin mirar nada).
function reposConConfig(raiz) {
  const out = [];
  const ilegibles = [];
  const tiene = (d) => fs.existsSync(path.join(d, '.tycon', 'advisors.yaml'));
  const hijos = (d) => {
    try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e) => path.join(d, e.name)); } catch (e) { ilegibles.push(`${path.relative(raiz, d)} (${e.code || e.message})`); return []; }
  };
  // «no pude mirar» no es «no hay»: la raíz que no existe y la que no se deja leer se dicen, cada una con su motivo
  let primeros;
  try { primeros = fs.readdirSync(raiz); } catch (e) {
    return { repos: [], ilegibles: [], motivo: e.code === 'ENOENT' ? `no existe ${raiz}` : `${raiz} no se deja leer (${e.code || e.message})` };
  }
  void primeros;
  for (const a of hijos(raiz)) {
    if (tiene(a)) out.push(a);
    for (const b of hijos(a)) if (tiene(b)) out.push(b);
  }
  return { repos: out.sort(), ilegibles, motivo: null };
}

test('reposConConfig encuentra los repos con configuración, a uno y dos niveles, y el control los mira', () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-root-'));
  const con = (rel, yaml) => { fs.mkdirSync(path.join(raiz, rel, '.tycon'), { recursive: true }); fs.writeFileSync(path.join(raiz, rel, '.tycon', 'advisors.yaml'), yaml); };
  con('uno', 'e2e:\n  gate: scripts/e2e-gate.sh\n');
  con(path.join('producto', 'front'), 'e2e:\n  gate: scripts/g.sh\n  frontend_dir: app\n  critical_manifiest: .tycon/x.txt\n');
  fs.mkdirSync(path.join(raiz, 'sin-config'), { recursive: true });
  const { repos, ilegibles, motivo } = reposConConfig(raiz);
  assert.deepEqual(repos.map((d) => path.relative(raiz, d)), [path.join('producto', 'front'), 'uno']);
  assert.deepEqual(ilegibles, []);
  assert.equal(motivo, null);
  // «no pude mirar» no es «no hay»: una raíz que no existe se dice, y una que existe y no se deja leer también
  const noEsta = reposConConfig(path.join(raiz, 'no-existe'));
  assert.deepEqual(noEsta.repos, []);
  assert.match(noEsta.motivo, /no existe/);
  const archivo = path.join(raiz, 'no-es-carpeta');
  fs.writeFileSync(archivo, 'x');
  const noSeLee = reposConConfig(archivo);
  assert.match(noSeLee.motivo, /no se deja leer/, 'una raíz que no se puede listar no es una raíz sin repos');
  // una SUBCARPETA que no se deja leer se nombra (relativa a la raíz: sin la ruta de la máquina), no se traga. Sin
  // permisos de POSIX (Windows) o como root no hay cómo armar el caso: ahí esta parte no se mide.
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
    const cerrada = path.join(raiz, 'producto', 'cerrada');
    fs.mkdirSync(cerrada);
    fs.chmodSync(cerrada, 0o000);
    try {
      const conCerrada = reposConConfig(raiz);
      assert.deepEqual(conCerrada.repos.map((d) => path.relative(raiz, d)), [path.join('producto', 'front'), 'uno'], 'lo demás se sigue viendo');
      assert.equal(conCerrada.ilegibles.length, 0, 'una carpeta de segundo nivel no se abre: no hay nada que leer adentro');
      fs.chmodSync(path.join(raiz, 'producto'), 0o000);
      const conProductoCerrado = reposConConfig(raiz);
      assert.equal(conProductoCerrado.ilegibles.length, 1, 'la carpeta de primer nivel que no se deja listar se nombra');
      assert.match(conProductoCerrado.ilegibles[0], /^producto \(E[A-Z]+\)$/, 'relativa a la raíz y con su código de error');
    } finally {
      fs.chmodSync(path.join(raiz, 'producto'), 0o755);
      fs.chmodSync(cerrada, 0o755);
    }
  }
  // el mismo control que corre sobre los reales SÍ avisa cuando hay algo que avisar: no pasa por no mirar
  const avisos = e2eCfg(path.join(raiz, 'producto', 'front')).json.config_warnings || [];
  assert.ok(avisos.length > 0, 'una clave mal escrita en un repo encontrado tiene que dar un aviso');
  fs.rmSync(raiz, { recursive: true, force: true });
});

test('los repos REALES del equipo no disparan ningún aviso', (t) => {
  // Un lint nuevo que pone en rojo a los repos que ya funcionan es un lint que alguien apaga.
  const raiz = process.env.TYCON_REPOS_ROOT || path.join(os.homedir(), 'SourceCode');
  const { repos: reales, ilegibles, motivo } = reposConConfig(raiz);
  // una raíz que EXISTE y no se deja leer es un rojo: ahí hay repos que nadie miró. Que no exista es otra máquina.
  assert.ok(!motivo || /no existe/.test(motivo), `no pude mirar los repos: ${motivo}`);
  for (const d of ilegibles) t.diagnostic(`no pude leer ${d} (bajo la raíz de repos): los repos de ahí adentro no se miraron`);
  if (!reales.length) { t.skip(`NO MEDIDO: ${motivo || `ningún repo con .tycon/advisors.yaml bajo ${raiz}`}`); return; }
  for (const d of reales) {
    assert.deepEqual(e2eCfg(d).json.config_warnings || [], [], `${path.relative(raiz, d)} no debería avisar nada`);
  }
});
