'use strict';
/**
 * suites-coverage.test.js — que la lista de suites y el disco digan lo mismo (2026-09-06).
 *
 * EL AGUJERO QUE CIERRA. `scripts/tests/suites.json` es la ÚNICA lista que enumera el nocturno
 * (`pipelines/azure-pipelines-banco.yml`) y el instalador. Un test que no está ahí no corre en ningún lado
 * — y no da error: da silencio, que es la forma de falla que este arnés persigue.
 *
 * Medido el 2026-09-06: 52 archivos `*.test.*` en `scripts/tests/`, 47 registrados. Los cinco
 * huérfanos (`dashboard-metrics`, `engram-autoheal`, `engram-drift`, `vigilante` y
 * `roster-validate-parity`) **nunca habían corrido desde que nacieron** — verificado por
 * `git log -S` sobre el instalador y el job: cero commits para los cinco. El último es, encima,
 * el que el portón de CI declara como su garantía de paridad.
 *
 * 🔴 SE MIRA EN LOS DOS SENTIDOS, y el segundo no es simetría de adorno:
 *    · huérfano en disco  → un test escrito que nunca corre (el caso medido);
 *    · entrada fantasma   → una ruta registrada que no existe. El corredor del nocturno saltea
 *      lo que no encuentra, así que una entrada fantasma se ve EXACTAMENTE igual que una suite
 *      que pasó — la lista diría 60 y correrían 59.
 *
 * 🔴 "No pude mirar" nunca es "coincide": si el árbol de agent-skills no está en esta máquina, su
 *    mitad se declara NO MEDIDA en la salida y no se juzga. Verde por ausencia es el modo de
 *    falla que el arnés ya pagó cinco veces.
 *
 * 🔴 rojo previo verificado: correrlo ANTES de registrar los cinco → los nombra y falla.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const DIR_TESTS = path.join(RAIZ, 'scripts', 'tests');
const SUITES = path.join(DIR_TESTS, 'suites.json');

const cfg = JSON.parse(fs.readFileSync(SUITES, 'utf8'));
const entradas = [].concat(cfg.diarias || [], cfg.semanales || []);

const esTest = (f) => /\.test\.[cm]?js$/.test(f) || /\.test\.sh$/.test(f);

// Suites que existen y NO están en suites.json A PROPÓSITO — cada una con su motivo, como las excepciones de T8.
// Una excepción sin motivo, o de un archivo que no existe, o de una suite que SÍ está registrada, es un agujero.
const A_MANO = Object.freeze({
  'packs-update-keeps-pieces.test.sh': 'story 8.41: es la entrada a mano de la prueba de actualización de los paquetes; la prueba misma vive en windows-guided-lab.test.js (PacksUpdate_*), que ya está registrada y corre sola: registrar este envoltorio la correría dos veces.',
  'portable-suites.test.sh': 'story 8.3, decisión del dev (2026-09-26): corre TODAS las portables otra vez (~100 suites, 5-6 min) y para el equipo no puede haber más espera en el portón ni en el nocturno. Se corre a mano (bash scripts/tests/portable-suites.test.sh) y en el gate del commit de toda story que toque suites.json o el instalador.',
});

// Las suites PARTIDAS (story 8.22, tramo F): el archivo entero no se registra —correría entero y por partes—; se registran
// sus partes, `<suite>.p<k>.test.<js|sh>`. Cuáles son lo dice scripts/tests/suite-parts.json, y que cada una tenga sus
// partes 1 a N registradas lo mide suite-parts.test.js (T42). Acá: el entero no cuenta como huérfano, y no puede estar.
// Un árbol que trae esta suite SIN la biblioteca no es un clon del arnés: es un laboratorio (export.test.js copia sólo este
// archivo a un repo de juguete y lo corre en la copia exportada), y ahí no hay suites partidas. Con la biblioteca, un
// registro que no se deja leer corta la suite: «no pude mirar» no es «ninguna está partida».
const PARTS_LIB = path.join(DIR_TESTS, 'lib', 'suite-parts.js');
const PARTIDAS = fs.existsSync(PARTS_LIB) ? require(PARTS_LIB).partitioned(DIR_TESTS) : new Map();

test('todo *.test.* de scripts/tests/ está registrado en suites.json (o declarado a mano, con motivo)', () => {
  const enDisco = fs.readdirSync(DIR_TESTS).filter(esTest).sort();
  const registrados = new Set(
    entradas.filter((e) => e && e.raiz === 'arnes').map((e) => path.basename(String(e.ruta))));
  const huerfanos = enDisco.filter((f) => !registrados.has(f) && !A_MANO[f] && !PARTIDAS.has(f));
  for (const [f, partes] of PARTIDAS) {
    assert.ok(!registrados.has(f), `${f}: está partida en ${partes} y sigue registrada entera — correría dos veces`);
    for (let k = 1; k <= partes; k++) {
      const parte = f.replace(/\.test\.(js|sh)$/, `.p${k}.test.$1`);
      assert.ok(registrados.has(parte), `${f}: está partida y su parte ${parte} no está registrada — esas pruebas no las corre nadie`);
    }
  }
  assert.deepEqual(huerfanos, [],
    `estos tests existen y NO los corre nadie (ni el nocturno ni el instalador): ${huerfanos.join(', ')}. ` +
    'Registralos en scripts/tests/suites.json, o declará por qué no van (A_MANO, con motivo).');
  for (const [f, motivo] of Object.entries(A_MANO)) {
    assert.ok(motivo && motivo.length > 40, `${f}: la excepción no dice por qué se corre a mano`);
    assert.ok(fs.existsSync(path.join(DIR_TESTS, f)), `${f}: declarada a mano y no existe en disco`);
    assert.ok(!registrados.has(f), `${f}: declarada a mano Y registrada en suites.json — una de las dos sobra`);
  }
});

// ── Las raíces (story 8.18, AC 13) ───────────────────────────────────────────────────────────────────────────────
// El MISMO árbol que ejecutan los corredores (lib/run-suites-json.js, scripts/ci/suites-for-change.js): si juzgaran
// árboles distintos, una suite nueva de agent-skills se vería fantasma acá mientras corre bien allá (story 2.19). Y
// desde la 8.18 ese árbol lo contesta UNA función para todos —`resolveSkillsDirs()`: la variable › el propio clon si
// es unido › lo instalado—, no una ruta escrita en cada lector.
const SKILLS_DIR_LIB = path.join(RAIZ, 'scripts', 'lib', 'skills-dir.js');
function rootsOfThisMachine() {
  let skills;
  if (fs.existsSync(SKILLS_DIR_LIB)) {
    const d = require(SKILLS_DIR_LIB).resolveSkillsDirs(process.env.TYCON_SKILLS_DIR || '');
    skills = { dir: d.skills, source: d.source };
  } else if (process.env.TYCON_SKILLS_DIR) {
    // Un árbol que trae esta suite SIN la biblioteca no es un clon del arnés: es un laboratorio (export.test.js copia
    // sólo este archivo a un repo de juguete y lo corre en la copia exportada). Ahí, lo de antes de la 8.18.
    skills = { dir: process.env.TYCON_SKILLS_DIR, source: 'variable' };
  } else {
    skills = { dir: path.join(process.env.HOME || '', '.claude', 'agent-skills', 'skills'), source: 'installed' };
  }
  return { arnes: { dir: path.join(RAIZ, 'scripts'), source: 'own-clone' }, 'agent-skills': skills };
}

/**
 * Cada entrada contra el disco: `phantoms` (registrada y no existe: el corredor la saltea y se ve igual que una que
 * pasó) y `unmeasured` (su RAÍZ no existe: no se pudo mirar, con el motivo). Una no medida nunca cuenta como «coincide».
 */
function judgeEntries(list, roots) {
  const phantoms = [];
  const unmeasured = [];
  for (const e of list) {
    if (!e || !e.raiz || !e.ruta) { phantoms.push(JSON.stringify(e)); continue; }
    const root = roots[e.raiz];
    if (!root) { phantoms.push(`${e.ruta} (raíz desconocida «${e.raiz}»)`); continue; }
    if (!fs.existsSync(root.dir)) {
      unmeasured.push({ entry: `${e.raiz}:${e.ruta}`, reason: `la raíz ${e.raiz} no existe: ${root.dir} (salió de: ${root.source})` });
      continue;
    }
    if (!fs.existsSync(path.join(root.dir, e.ruta))) phantoms.push(`${e.raiz}:${e.ruta}`);
  }
  return { phantoms, unmeasured };
}
const PHANTOMS_MESSAGE = 'entradas registradas que no existen en disco — el corredor las saltea y se ven igual que una suite que pasó';

test('ninguna entrada de suites.json apunta a un archivo que no existe — las del arnés', () => {
  const { phantoms, unmeasured } = judgeEntries(entradas.filter((e) => !e || e.raiz !== 'agent-skills'), rootsOfThisMachine());
  assert.deepEqual(unmeasured, [], 'la raíz del arnés es este clon: siempre se puede mirar');
  assert.deepEqual(phantoms, [], `${PHANTOMS_MESSAGE}: ${phantoms.join(', ')}`);
});

test('ninguna entrada de suites.json apunta a un archivo que no existe — las de agent-skills', (t) => {
  // 🔴 «No pude mirar» no es verde: si la raíz no está en esta máquina, esta mitad sale NO MEDIDA con su motivo
  //    (antes dejaba una línea informativa y el test pasaba).
  const { phantoms, unmeasured } = judgeEntries(entradas.filter((e) => e && e.raiz === 'agent-skills'), rootsOfThisMachine());
  if (unmeasured.length) { t.skip(`NO MEDIDO — ${unmeasured.length} entrada(s) sin juzgar: ${unmeasured[0].reason}`); return; }
  assert.deepEqual(phantoms, [], `${PHANTOMS_MESSAGE}: ${phantoms.join(', ')}`);
});

test('T12 Suites_MissingRoot_NotMeasuredWithReason — una raíz agent-skills que no existe: «no medida» con su motivo, nunca verde ni fantasma', () => {
  // 🔴 rojo previo: `if (!fs.existsSync(base)) continue` sin anotar nada → 33 entradas sin mirar y el resultado
  //    igual al de «todas existen».
  const nowhere = path.join(RAIZ, 'no-such-skills-root');
  assert.ok(!fs.existsSync(nowhere));
  const roots = { ...rootsOfThisMachine(), 'agent-skills': { dir: nowhere, source: 'installed' } };
  const fromSkills = entradas.filter((e) => e && e.raiz === 'agent-skills');
  const list = fromSkills.length ? entradas : entradas.concat([{ raiz: 'agent-skills', ruta: 'x/tests/y.test.js', requiere: [] }]);
  const r = judgeEntries(list, roots);
  const expected = list.filter((e) => e && e.raiz === 'agent-skills');
  assert.equal(r.unmeasured.length, expected.length, 'cada suite de esa raíz sale no medida: ninguna se saltea callada');
  for (const n of r.unmeasured) {
    assert.match(n.entry, /^agent-skills:/);
    assert.ok(n.reason.includes(nowhere), `el motivo nombra la raíz que se buscó: ${n.reason}`);
    assert.match(n.reason, /no existe.*salió de: installed/, 'y de qué regla salió');
  }
  assert.ok(!r.phantoms.some((f) => f.startsWith('agent-skills:')), 'no medida no es fantasma: no se la acusa de no existir');
  // el espejo: con la raíz en su lugar no hay nada «no medido», y una entrada que no existe SÍ es fantasma
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'suites-coverage-'));
  try {
    fs.mkdirSync(path.join(tmp, 'x', 'tests'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'x', 'tests', 'real.test.js'), '');
    const healthy = judgeEntries(
      [{ raiz: 'agent-skills', ruta: 'x/tests/real.test.js' }, { raiz: 'agent-skills', ruta: 'x/tests/ghost.test.js' }],
      { 'agent-skills': { dir: tmp, source: 'variable' } });
    assert.deepEqual(healthy, { phantoms: ['agent-skills:x/tests/ghost.test.js'], unmeasured: [] });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('T12 — `__raices` de suites.json describe la regla: una función para todos los lectores, y «no medida» si la raíz no existe', (t) => {
  // 🔴 rojo previo: `__raices` fijaba agent-skills en "$HOME/.claude/agent-skills/skills".
  // Un árbol sin la función (un laboratorio con su suites.json de juguete, como el de export.test.js) no tiene regla
  // que describir: ahí no se mide, y se dice.
  if (!fs.existsSync(SKILLS_DIR_LIB)) { t.skip('NO MEDIDO — este árbol no trae scripts/lib/skills-dir.js: no es un clon del arnés'); return; }
  const text = String((cfg.__raices || {})['agent-skills'] || '');
  assert.match(text, /resolveSkillsDirs\(\)/, 'nombra LA función');
  const order = ['TYCON_SKILLS_DIR', 'propio clon', '.claude/agent-skills/skills'].map((s) => text.indexOf(s));
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], `dice el orden (la variable › el propio clon › lo instalado): ${text}`);
  assert.match(text, /NO MEDIDA/, 'y qué pasa si la raíz no existe');
});

test('no hay entradas duplicadas', () => {
  const claves = entradas.map((e) => `${e && e.raiz}:${e && e.ruta}`);
  const dup = claves.filter((c, i) => claves.indexOf(c) !== i);
  assert.deepEqual(dup, [], `duplicadas: ${dup.join(', ')}`);
});

// ── T12 · cada suite declara qué necesita (story 8.3, AC 12) ─────────────────────────────────────
// `requiere` es una lista, vacía (portable: corre en una HOME vacía sin ningún servicio) o con valores
// de este vocabulario CERRADO. Vive acá, en código, a propósito: si viviera en el JSON, agregar «jira» al
// vocabulario sería tan fácil como agregarlo a una suite, y la prueba se verificaría a sí misma.
//   agent-skills     → necesita el CONTENIDO del equipo en agent-skills (paquetes bizuit/clientes, repos
//                      hermanos), no la carpeta: tycon-pipeline vive ahí y es núcleo público
//   ado · engram · codegraph · telegram · clockify · buzon · codex → el servicio o su CLI de verdad
//   modelo           → el CLI `claude` o `codex` en el PATH (sesiones LLM reales)
//   repos-del-equipo → los repos de los productos bajo la raíz de repos
//   red              → internet de verdad (GitHub): los orígenes de las skills de terceros (story 8.5); sin red
//                      la suite sale NO MEDIDO, así que no puede declararse portable
//   docker           → el servicio de Docker andando en la máquina: la suite construye imágenes y levanta contenedores
//                      (story 8.7, tanda C: la máquina limpia); sin él sale NO MEDIDO, nunca verde
// Una suite sin `requiere` o con un valor fuera del vocabulario hace fallar ESTA prueba nombrándola; las
// portables las corre `portable-suites.test.sh` (T13) en una HOME vacía y sin las herramientas en el PATH.
const VOCABULARIO_REQUIERE = Object.freeze(['agent-skills', 'ado', 'engram', 'codegraph', 'telegram', 'clockify', 'buzon', 'codex', 'modelo', 'repos-del-equipo', 'red', 'docker']);

/** Los problemas de `requiere` en una lista de suites (vacío = todas declaran, con el vocabulario). */
function validarRequiere(cfgSuites) {
  const errores = [];
  for (const [familia, lista] of [['diarias', cfgSuites.diarias || []], ['semanales', cfgSuites.semanales || []]]) {
    for (const e of lista) {
      if (!e || !e.ruta) continue;
      const id = `${familia} · ${e.raiz}:${e.ruta}`;
      if (!Array.isArray(e.requiere)) { errores.push(`${id} — sin «requiere» (lista vacía = portable; si no, qué necesita)`); continue; }
      for (const r of e.requiere) {
        if (!VOCABULARIO_REQUIERE.includes(r)) errores.push(`${id} — requiere «${r}», que no está en el vocabulario (${VOCABULARIO_REQUIERE.join(', ')})`);
      }
    }
  }
  return errores;
}

test('T12 Suites_TodasDeclaranRequisitos — cada entrada de suites.json declara `requiere` con el vocabulario cerrado', () => {
  const errores = validarRequiere(cfg);
  assert.deepEqual(errores, [], `suites sin requisitos declarados o con un valor inventado:\n  ${errores.join('\n  ')}`);
});

test('T12 — una copia con una suite SIN requiere falla nombrando la suite', () => {
  const copia = JSON.parse(JSON.stringify(cfg));
  const sinRequiere = { raiz: 'arnes', ruta: 'tests/inventada-sin-requiere.test.sh' };
  copia.diarias.push(sinRequiere);
  const errores = validarRequiere(copia);
  assert.equal(errores.length, 1, `esperaba UN error (la inventada), no ${errores.length}: ${errores.join(' · ')}`);
  assert.match(errores[0], /inventada-sin-requiere\.test\.sh/);
  assert.match(errores[0], /sin «requiere»/);
});

test('T12 — una copia con requiere: ["jira"] falla nombrando la suite y el valor', () => {
  const copia = JSON.parse(JSON.stringify(cfg));
  copia.semanales = copia.semanales || [];
  copia.semanales.push({ raiz: 'arnes', ruta: 'tests/inventada-jira.test.sh', requiere: ['jira'] });
  const errores = validarRequiere(copia);
  assert.equal(errores.length, 1, `esperaba UN error (la inventada), no ${errores.length}: ${errores.join(' · ')}`);
  assert.match(errores[0], /inventada-jira\.test\.sh/);
  assert.match(errores[0], /«jira».*vocabulario/);
});

// ── T33 · la prueba en contenedor declara lo que pide (story 8.7, tanda C · AC 26) ──────────────────
test('T33 SuitesCobertura_DockerEnElVocabulario — `docker` está en el vocabulario, y clean-machine.test.sh lo declara junto con `red` y corre sola', () => {
  // 🔴 rojo previo: sin `docker` en el vocabulario y sin la entrada, falla en la primera afirmación y, puesta la
  //    palabra, en «está en la lista».
  assert.ok(VOCABULARIO_REQUIERE.includes('docker'), '`docker` tiene que estar en el vocabulario cerrado de `requiere`');
  // el validador lo acepta, y sigue rechazando lo que no está (otro motor de contenedores no entra de regalo)
  const copia = { diarias: [
    { raiz: 'arnes', ruta: 'tests/inventada-docker.test.sh', requiere: ['docker', 'red'] },
    { raiz: 'arnes', ruta: 'tests/inventada-podman.test.sh', requiere: ['podman'] },
  ] };
  const errores = validarRequiere(copia);
  assert.equal(errores.length, 1, `esperaba UN error (la de podman), no ${errores.length}: ${errores.join(' · ')}`);
  assert.match(errores[0], /inventada-podman\.test\.sh.*«podman».*vocabulario/);
  // Donde el archivo está (el repo del equipo y la copia pública: viaja), la entrada tiene que estar y bien formada.
  if (!fs.existsSync(path.join(DIR_TESTS, 'clean-machine.test.sh'))) return;
  const mias = entradas.filter((e) => e && /(^|\/)clean-machine\.test\.sh$/.test(String(e.ruta)));
  assert.equal(mias.length, 1, `clean-machine.test.sh está en la lista una vez (está ${mias.length})`);
  const cm = mias[0];
  assert.ok((cfg.diarias || []).includes(cm), 'va en `diarias`: el nocturno la mide todas las noches');
  assert.deepEqual([cm.raiz, cm.ruta], ['arnes', 'tests/clean-machine.test.sh']);
  assert.deepEqual(cm.requiere, ['docker', 'red'], 'pide docker (construye imágenes) y red (baja imágenes, paquetes, skills y el plugin de ejemplo)');
  assert.strictEqual(cm.exclusive, true, 'cuando corre, corre sola: construye imágenes y levanta contenedores');
  assert.deepEqual(validarCamposDelGate({ diarias: [cm] }), [], 'sus campos del gate están bien formados');
  assert.ok(!('gate_only_when_touching' in cm), 'no se difiere en el gate: sin la llave tarda segundos (T34) y dice NO MEDIDO');
});

// Story 7.15 (2026-09-29): dos campos que lee SÓLO el test-gate (run-suites-json.js de agent-skills).
//   exclusive: true                        → la suite corre sola, al final (comparte estado con otras)
//   gate_only_when_touching: ["<dir>/**"]  → el gate de cada story la difiere si la story no toca esas carpetas
// Un valor mal escrito no rompe nada en el runner (hace lo conservador y avisa), pero ACÁ se pone rojo
// nombrando la suite: un `exclusive: "si"` o un patrón sin `/**` son errores de quien escribió la lista.
// La forma del patrón es la misma que acepta lib/touched-files.js (agent-skills): carpeta relativa + «/**».
const PATRON_CARPETA = /^(?!(?:.*\/)?\.{1,2}\/)(?:[^*?[\]{}\s/]+\/)*[^*?[\]{}\s/]+\/\*\*$/;

/** Los problemas de `exclusive` / `gate_only_when_touching` en una lista de suites. */
function validarCamposDelGate(cfgSuites) {
  const errores = [];
  for (const [familia, lista] of [['diarias', cfgSuites.diarias || []], ['semanales', cfgSuites.semanales || []]]) {
    for (const e of lista) {
      if (!e || !e.ruta) continue;
      const id = `${familia} · ${e.raiz}:${e.ruta}`;
      if ('exclusive' in e && typeof e.exclusive !== 'boolean') errores.push(`${id} — «exclusive» tiene que ser true o false, no ${JSON.stringify(e.exclusive)}`);
      if ('gate_only_when_touching' in e) {
        const g = e.gate_only_when_touching;
        if (!Array.isArray(g) || !g.length || !g.every((p) => typeof p === 'string' && PATRON_CARPETA.test(p))) {
          errores.push(`${id} — «gate_only_when_touching» tiene que ser una lista de «<carpeta>/**», no ${JSON.stringify(g)}`);
        }
      }
    }
  }
  return errores;
}

test('T19 SuitesJson_NewFieldsHaveValidShape — los campos del gate están bien formados, y exportador-real los lleva', () => {
  // 🔴 rojo previo: exportador-real sin los dos campos → el gate de cada story la sigue corriendo (24-41 min).
  const errores = validarCamposDelGate(cfg);
  assert.deepEqual(errores, [], `campos del gate mal formados:\n  ${errores.join('\n  ')}`);
  // En la copia pública exportador-real no sale (ni el archivo ni su entrada): ahí no hay nada que exigir.
  // Donde el archivo está, la entrada tiene que estar y llevar los dos campos.
  if (!fs.existsSync(path.join(__dirname, 'export-real.test.sh'))) return;
  const exp = [...(cfg.diarias || []), ...(cfg.semanales || [])].find((e) => e && /export-real\.test\.sh$/.test(e.ruta));
  assert.ok(exp, 'export-real.test.sh está en la lista');
  // la carpeta de publicación (story 8.9, tanda C4: toda la carpeta vive en scripts/publishing/; en la vieja quedan sólo
  // reemplazos generados, que nadie edita a mano), y nada más
  assert.deepEqual(exp.gate_only_when_touching, ['scripts/publishing/**'], 'sólo el gate de las stories que tocan publicación la corre');
  assert.equal(exp.exclusive, true, 'cuando corre, corre sola');
});

test('T19 — una copia con exclusive: 1 y un patrón sin /** falla nombrando cada suite', () => {
  // 🔴 rojo previo: validar sólo que el campo exista → `1` y «scripts/lab-folder» pasan.
  const copia = JSON.parse(JSON.stringify(cfg));
  copia.diarias.push({ raiz: 'arnes', ruta: 'tests/inventada-exclusiva.test.sh', requiere: [], exclusive: 1 });
  copia.diarias.push({ raiz: 'arnes', ruta: 'tests/inventada-patron.test.sh', requiere: [], gate_only_when_touching: ['scripts/lab-folder'] });
  const errores = validarCamposDelGate(copia);
  assert.equal(errores.length, 2, `esperaba DOS errores (las inventadas), no ${errores.length}: ${errores.join(' · ')}`);
  assert.match(errores[0], /inventada-exclusiva\.test\.sh.*exclusive/);
  assert.match(errores[1], /inventada-patron\.test\.sh.*gate_only_when_touching/);
});

module.exports = { validarRequiere, VOCABULARIO_REQUIERE, validarCamposDelGate };
