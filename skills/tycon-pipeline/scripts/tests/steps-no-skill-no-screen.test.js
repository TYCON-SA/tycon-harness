#!/usr/bin/env node
/**
 * steps-no-skill-no-screen.test.js — «Armar el plan» y «Probar en vivo» dicen qué hacer en los casos donde un
 * modelo chico se trababa.
 *
 * El caso: midiendo gemma con la historia de juguete (una función `resta`), con Codex copió la invocación de Claude
 * Code (`Skill(…, args: "Cargar story en …")`) y corrió la skill como programa con `node`; con Claude Code se trabó dos
 * veces en «Probar en vivo», porque el paso no traía la prueba real de una función sin pantalla ni servidor.
 *
 * T1-T3 leen los pasos. T4 y T5 corren el ejemplo de «Probar en vivo», sacado del paso tal cual, sobre un repo de
 * juguete con HOME temporal: smoke-run.sh y runtime-matrix.js de verdad.
 *
 * Las del final fijan que el plan y la implementación los hace el orquestador, sin las skills de BMAD.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/steps-no-skill-no-screen.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const STEPS = path.join(SCRIPTS, '..', 'steps');
const leer = (f) => fs.readFileSync(path.join(STEPS, f), 'utf8');

// el cuerpo de una sección hasta la próxima del mismo nivel o mayor; un `#` dentro de un bloque de código no es título
function seccion(texto, titulo) {
  const i = texto.indexOf(titulo);
  assert.ok(i !== -1, `falta la sección «${titulo}»`);
  const nivel = /^#+/.exec(titulo)[0].length;
  const lineas = texto.slice(i + titulo.length).split('\n');
  let enBloque = false;
  const fin = lineas.findIndex((l) => {
    if (/^\s*```/.test(l)) enBloque = !enBloque;
    return !enBloque && new RegExp(`^#{1,${nivel}} `).test(l);
  });
  return (fin === -1 ? lineas : lineas.slice(0, fin)).join('\n');
}

test('Plan_ConCodex_SinHerramientaSkill @story-8.114 @ac-1', () => {
  const inv = seccion(leer('step-03-plan.md'), '## Invocación');
  assert.match(inv, /Codex/);
  assert.doesNotMatch(inv, /Skill\(/, 'no hay ninguna skill que invocar');
  assert.doesNotMatch(inv, /node [^\n`]*index\.js/, 'nada invita a correr una skill como programa');
});

test('Plan_SinMetodo_LoEscribeElOrquestador @story-8.114 @ac-2', () => {
  const inv = seccion(leer('step-03-plan.md'), '## Invocación');
  assert.doesNotMatch(inv, /_bmad\/bmm\/config\.yaml/, 'vale con o sin la configuración de BMAD');
  assert.match(inv, /lo escribe el orquestador/);
  assert.match(inv, /step-02-bmad-plan\.md/);
  assert.match(inv, /node ~\/\.claude\/agent-skills\/skills\/tycon-pipeline\/scripts\/pipeline\.js run-dir --story <ruta> --repo <repo> --create/);
});

const ejemplo = () => {
  const s = seccion(leer('step-10-live-check.md'), '#### Una función sin pantalla ni servidor');
  const m = s.match(/```bash\n([\s\S]*?)```/);
  assert.ok(m, 'el apartado trae su ejemplo en un bloque de código');
  return { texto: s, comando: m[1].split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n') };
};

test('EnVivo_FuncionSinPantalla_Ejemplo @story-8.114 @ac-3', () => {
  const { texto, comando } = ejemplo();
  assert.match(comando, /smoke-run\.sh <evidence-dir> <ruta-de-la-story\.md> --acs 1/);
  assert.match(comando, /--pass-if '/);
  assert.match(comando, /-- node -e "/);
  assert.match(texto, /después del último cambio de código/);
  assert.match(texto, /`node --test`[^\n]*no cuenta/);
  assert.match(texto, /no es una salida/);
  assert.match(texto, /runtime_not_verifiable:/);
});

// un repo de juguete con `resta` y una story de dos criterios; corre el ejemplo con cada criterio y devuelve la matriz
function juguete(armarComando) {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'en-vivo-8114-')));
  const casa = path.join(raiz, 'casa');
  const repo = path.join(raiz, 'repo');
  fs.mkdirSync(casa, { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'resta.js'), "'use strict';\nfunction resta(a, b) { return a - b; }\nmodule.exports = { resta };\n");
  const story = path.join(repo, 'specs', 'story-1.1.md');
  fs.writeFileSync(story, ['---', 'epic: 1', 'story: "1.1"', 'title: "Restar"', 'status: in-progress', '---', '# Story 1.1: Restar', '',
    '## Acceptance Criteria', '', '1. **Given** dos números **When** se llama a `resta(5, 3)` **Then** devuelve 2.',
    '2. **Given** un resultado negativo **When** se llama a `resta(2, 5)` **Then** devuelve -3.', ''].join('\n'));
  spawnSync('git', ['init', '-q', repo]);
  const env = { ...process.env, HOME: casa, USERPROFILE: casa };
  delete env.CLAUDE_CODE_SESSION_ID; delete env.CODEX_SESSION_ID; delete env.TYCON_SESSION_ID;
  const evid = path.join(repo, '.advisors', 'dod-runtime');
  for (const [ac, args] of [[1, '5, 3'], [2, '2, 5']]) {
    const cmd = armarComando(ac, args)
      .replace('~/.claude/agent-skills/skills/tycon-pipeline/scripts/smoke-run.sh', path.join(SCRIPTS, 'smoke-run.sh'))
      .replace('<evidence-dir>', evid).replace('<ruta-de-la-story.md>', story);
    const r = spawnSync('bash', ['-c', cmd], { cwd: repo, env, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0, `el humo del criterio ${ac}: ${r.stdout}${r.stderr}`);
  }
  return spawnSync(process.execPath, [path.join(SCRIPTS, 'runtime-matrix.js'), '--story', story], { cwd: repo, env, encoding: 'utf8', timeout: 60000 });
}

test('EnVivo_ElEjemploDaVerde @story-8.114 @ac-4', () => {
  const { comando } = ejemplo();
  // el ejemplo, tal cual: para el criterio 2 cambian el número de criterio y los datos de ejemplo
  const m = juguete((ac, args) => comando.replace('--acs 1', `--acs ${ac}`).split('5, 3').join(args));
  assert.strictEqual(m.status, 0, m.stdout + m.stderr);
  assert.match(m.stdout + m.stderr, /2\/2 ACs corridos en runtime/);
});

test('EnVivo_NodeTestNoCuenta @story-8.114 @ac-3', () => {
  // el mismo humo con una prueba unitaria como comando: la matriz no lo da por corrido
  const m = juguete((ac) => `bash ~/.claude/agent-skills/skills/tycon-pipeline/scripts/smoke-run.sh <evidence-dir> <ruta-de-la-story.md> --acs ${ac} --pass-if 'las pruebas pasan' -- node --test --test-reporter=dot src/resta.js`);
  assert.notStrictEqual(m.status, 0, `una prueba unitaria no cuenta como ejecución:\n${m.stdout}`);
  assert.doesNotMatch(m.stdout + m.stderr, /2\/2 ACs corridos en runtime/);
});

// ── el plan y la implementación los hace el orquestador, sin las skills de BMAD ─────────────────────────────────────
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const delArnes = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const enUnaLinea = (rel) => delArnes(rel).replace(/\s+/g, ' ');
const pipeline = () => require(path.join(SCRIPTS, 'pipeline.js'));
const PASO_DEL_PLAN = 'skills/tycon-pipeline/steps/step-03-plan.md';
const PASO_DE_APROBAR = 'skills/tycon-pipeline/steps/step-04-approve-plan.md';
const PASO_DE_IMPLEMENTAR = 'skills/tycon-pipeline/steps/step-05-implement.md';
const PASO_DE_REVISORES = 'skills/tycon-pipeline/steps/step-07-reviewers.md';
const PASO_DE_PREPARAR = 'skills/tycon-pipeline/steps/step-11-prepare-commit.md';
const PORTON_DE_CARRIL = 'skills/tycon-pipeline/scripts/lib/story-gate.js';
const ARCHIVO_DEL_PLAN = 'step-02-bmad-plan.md';

test('T1 PasoDelPlan_NoInvocaSkillsDeBmad @story-8.305 @ac-1', () => {
  const crudo = delArnes(PASO_DEL_PLAN);
  assert.doesNotMatch(crudo, /Skill\(/);
  assert.doesNotMatch(crudo.split(ARCHIVO_DEL_PLAN).join(''), /bmad/i);
  const paso = enUnaLinea(PASO_DEL_PLAN);
  for (const dicho of [/lo escribe el orquestador/, /`step-02-bmad-plan\.md`/, /## Qué hace/, /## Archivos/, /con Claude Code y con Codex/,
    /Lecciones previas del repo/, /Herramientas de código disponibles/, /`project-context\.md`/, /no modifica archivos/,
    /análisis de la historia/i, /tareas numeradas/i, /riesgos o ambigüedades/i,
    /\[EXTRACT\]/, /\[ADAPT\]/, /\[EXTEND\]/, /\[CREATE\]/, /quick-flow/,
    /historia es ambigua[^.]*consulta/, /no se puede implementar[^.]*no pasa a «Aprobar el plan»[^.]*termina/i]) {
    assert.match(paso, dicho);
  }
});

test('T2 PasoDeImplementar_NoInvocaSkillsDeBmad_YTraeSusReglas @story-8.305 @ac-2 @ac-8', () => {
  const crudo = delArnes(PASO_DE_IMPLEMENTAR);
  assert.doesNotMatch(crudo, /Skill\(/);
  assert.doesNotMatch(crudo, /bmad_skill_name|bmad-dev-story|bmad-agent-dev|bmad-agent-quick-flow/);
  const paso = enUnaLinea(PASO_DE_IMPLEMENTAR);
  const reglas = {
    'lee antes de escribir': [/historia entera/, /`project-context\.md`/],
    'el estado y el índice': [/encabezado de la historia/, /implementation_artifacts/, /story-index\.js --repo <repo> --mode/, /`in-progress`/,
      /sin tocar los demás/, /`generated`[^.]*no se edita/, /aviso, falla o no está[^.]*no se edita/, /no se encuentra[^.]*una línea/],
    'los seguimientos primero': [/## Review Follow-ups \(Advisors\)/, /«\(AI\)»/, /«Senior Developer Review \(AI\)»/,
      /lo tilda y lo anota en `Completion Notes List` y `Change Log`/],
    'las tareas': [/en orden/, /pruebas primero/, /sin pausar/, /nada que no esté en una tarea/],
    'el cambio más chico': [/cambio más chico que cumple la historia/, /sin fusionar bloques parecidos que cambian por razones distintas/,
      /ningún refactor más allá del que el cambio necesita/i, /`tasks\/todo\.md` con formato DEF/],
    'nada sin declarar': [/excepciones, campos de respuesta, filtros ni servicios/, /filtro de seguridad[^.]*`Change Log`/],
    'las pruebas': [/pruebas escritas y en verde/, /pruebas acotadas/, /lint/, /suite completa[^.]*«Correr las pruebas»/],
    'cuándo frena': [/tarea es ambigua/, /dependencia que ni la historia ni `project-context\.md`/, /configuración necesaria/, /tres fallas seguidas/, /validación falla/],
    'cuándo no termina': [/tareas incompletas, regresiones o la `File List` incompleta/],
    'qué toca de la historia': [/Sólo cambia las tildes, el `Dev Agent Record`, la `File List` y el `Change Log`, salvo lo que apruebe el portón/],
    'la compilación': [/la corrige el orquestador con el error a la vista/],
    'el registro': [/`Agent Model Used`/, /`Debug Log References`/, /`Completion Notes List`/, /`File List`/, /`Change Log`/],
  };
  for (const [regla, dichos] of Object.entries(reglas)) for (const dicho of dichos) assert.match(paso, dicho, regla);

  const preparar = enUnaLinea(PASO_DE_PREPARAR);
  for (const dicho of [/implementation_artifacts/, /story-index\.js --repo <repo> --mode/, /`review`/, /`generated`[^.]*no se edita/,
    /aviso, falla o no está, tampoco/, /no se encuentra[^.]*una línea/]) {
    assert.match(preparar, dicho);
  }
});

test('T3 Arranque_SinConfigDeBmad_NoAvisaNada @story-8.305 @ac-3', () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'sin-bmad-'));
  try {
    const faltas = pipeline().computeMissingBeforeStart({ repo: lab, fm: {}, env: { TYCON_TIME_TRACKING: 'none' }, home: lab });
    assert.ok(!faltas.some((f) => f.id === 'bmad'), JSON.stringify(faltas));
    assert.doesNotMatch(JSON.stringify(faltas), /bmad-init/);
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
});

test('T4 ToolingEsperado_SinLasSkillsDeBmadDelPipeline @story-8.305 @ac-4', () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'tooling-sin-bmad-'));
  try {
    const manifestPath = path.join(RAIZ, 'scripts', 'publishing', 'third-party-skills.json');
    const nombres = pipeline().computeToolingExpected(lab, { integrations: null, manifestPath, skillsDir: lab }).expected.map((e) => e.name);
    for (const fuera of ['bmad-dev-story', 'bmad-agent-dev', 'bmad-agent-quick-flow-solo-dev']) assert.ok(!nombres.includes(`skill:${fuera}`), fuera);
    for (const sigue of ['bmad-agent-analyst', 'bmad-code-review']) assert.ok(nombres.includes(`skill:${sigue}`), sigue);
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
});

test('T5 CorridaAbierta_ConservaElArchivoDelPlan @story-8.305 @ac-5', () => {
  for (const lector of ['skills/tycon-pipeline/scripts/lib/plan-review.js', 'skills/tycon-pipeline/scripts/lib/plan-display.js',
    'skills/tycon-pipeline/scripts/lib/browser-test.js', 'scripts/lib/signature-sources.js']) {
    assert.ok(delArnes(lector).includes(`'${ARCHIVO_DEL_PLAN}'`), lector);
  }
  const plan = delArnes(PASO_DEL_PLAN);
  assert.ok(plan.includes(ARCHIVO_DEL_PLAN));
  assert.doesNotMatch(plan, /Sin el método configurado/);
  const propios = new Set(['step-03-plan.md', 'step-04-approve-plan.md', ARCHIVO_DEL_PLAN]);
  for (const paso of [PASO_DE_APROBAR, PASO_DE_IMPLEMENTAR]) {
    const otros = (delArnes(paso).match(/\bstep-\d+[\w-]*plan[\w-]*\.md/g) || []).filter((f) => !propios.has(f));
    assert.deepStrictEqual(otros, [], paso);
  }
});

test('T7 MedicionPendiente_TraeLaBaseYLaRegla @story-8.305 @ac-6', () => {
  const guia = enUnaLinea('guides/maintaining/bmad-contract.md');
  for (const dicho of [/tres primeras corridas reales/, /149 resultados/, /22 rechazados/, /126 aprobados/, /1 sin veredicto/, /2 o más rechazos de 3/, /muestra chica/]) {
    assert.match(guia, dicho);
  }
});

test('T8 PipelineSinBmadComoEjecutor @story-8.305 @ac-9', () => {
  // las únicas menciones que quedan: dicen de dónde salió una regla o qué skill sigue disponible, no quién trabaja
  const citas = {
    [PASO_DE_IMPLEMENTAR]: [
      ['`bmad-testarch-atdd`', 'skill que se usa a mano, fuera del pipeline'],
      ['`_bmad/tea/config.yaml`', 'lo que pide esa misma skill'],
      ['`_bmad/bmm/config.yaml`', 'el archivo donde el repo dice en qué carpeta tiene su índice'],
    ],
    [PASO_DE_REVISORES]: [
      ['Opt-in `bmad-code-review`', 'revisión que se pide a mano'],
      ['`bmad-contract.md`', 'la guía donde está el permiso de esa revisión'],
      ['`bmad-dev-story` cierra con un tip', 'de dónde salió la idea de variar el modelo'],
    ],
    [PORTON_DE_CARRIL]: [['Skill(skill="bmad-agent-analyst"', 'la skill sugerida para definir una historia']],
  };
  for (const rel of ['skills/tycon-pipeline/SKILL.md', PASO_DEL_PLAN, PASO_DE_APROBAR, PASO_DE_IMPLEMENTAR, PASO_DE_REVISORES,
    PORTON_DE_CARRIL, 'skills/tycon-pipeline/scripts/visual-plan.js']) {
    const permitidas = (citas[rel] || []).map(([texto]) => texto);
    const sobran = delArnes(rel).split('\n')
      .filter((l) => /bmad/i.test(l.split(ARCHIVO_DEL_PLAN).join('')) && !permitidas.some((c) => l.includes(c)));
    assert.deepStrictEqual(sobran, [], rel);
  }
  assert.doesNotMatch(delArnes('guides/what-the-harness-does.md'), /BMAD planifica/);
});
