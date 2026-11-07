'use strict';
/**
 * signature-question.test.js — la pregunta de cada firma dice qué se aprueba (owner-approvals.js `cuadroDe`,
 * owner-window.js `cuadroPara` y signature-sources.js).
 *
 * El caso: la pregunta del plan decía «¿Aprobás aprobar el plan de una story? Detalle: la cita: …» y el dueño no podía
 * decidir con eso. La pregunta empieza con lo que se aprueba, nombra la historia con su título, dice qué
 * hace en hasta 3 líneas, qué archivos toca y dónde está lo completo, trae el «si sale mal» de esa firma y deja la cita de
 * la sesión al final. El click queda atado a lo que se mostró: si la fuente cambia, la huella cambia. Sin red.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ow = require('../lib/owner-window.js');
const oa = require('../lib/owner-approvals.js');
const sig = require('../lib/signatures.js');

const RAIZ = path.join(__dirname, '..', '..');
const MARKER = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const PIPELINE = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js');
const CONTROLES = path.join(RAIZ, 'scripts', 'ci', 'run-base-controls.sh');
const pl = require(PIPELINE);

const TITULO = 'La coordinadora se nombra con un click';

function temporal(t, prefijo) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/**
 * Una casa con la sesión `ses-a` corriendo la historia 9.99 en un repo propio, con su carpeta de corrida. `titulo: null`
 * escribe la historia sin título; `historia: false` no escribe el archivo. `criterios`: los criterios de la historia
 * (`[{ n, texto }]`) en lugar de los dos de siempre, todos cubiertos por T1.
 */
function corrida(t, { titulo = TITULO, historia = true, story = '9.99', extraHistoria = [], criterios = null } = {}) {
  const casa = temporal(t, 'sigq-casa-');
  const repo = temporal(t, 'sigq-repo-');
  const estado = path.join(casa, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  // la matriz de criterios busca la raíz del repo por git
  spawnSync('git', ['init', '-q', repo]);
  const ruta = path.join(repo, 'specs', `story-${story}-prueba.md`);
  if (historia) {
    fs.writeFileSync(ruta, ['---', `story: "${story}"`, ...(titulo ? [`title: "${titulo}"`] : []), 'status: in-progress', ...extraHistoria, '---', '',
      `# Story ${story}`, '', '## Acceptance Criteria', '',
      ...(criterios ? criterios.map((x) => `${x.n}. ${x.texto}`) : ['1. **Given** un pedido **Then** el aviso queda en el servicio externo.',
        '2. **Given** otro pedido **Then** se ve en la lista.']), '', '### Tests', '', '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|',
      `| T1 | \`Aviso_QuedaRegistrado\` | ${criterios ? criterios.map((x) => x.n).join(', ') : 1} | unit | x | y |`, ''].join('\n'));
    fs.mkdirSync(path.join(repo, '.advisors'), { recursive: true });
    // stable-data: la matriz compara el resultado de las pruebas con la hora del código de la historia, que es la de ahora
    fs.writeFileSync(path.join(repo, '.advisors', 'tests-result.json'), JSON.stringify({ ts: new Date().toISOString(), story_id: story, suite_green: true }));
  }
  fs.writeFileSync(path.join(estado, 'active', 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: story, storyPath: ruta, repoPath: repo,
    startedAt: '2026-11-04T12:00:00Z' }));
  const runDir = historia ? pl.resolveRunDir(repo, story, true, ruta) : null;
  return { casa, repo, estado, ruta, runDir };
}

const cuadro = (c, cmd, o = {}) => ow.cuadroPara({ firma: o.firma, comando: cmd, palabras: ow.canonica(cmd), destino: 'ses-a', sesion: 'ses-a', cwd: o.cwd || c.repo, casa: c.casa });
const conFirma = (firma) => (c, cmd) => ow.cuadroPara({ firma, comando: cmd, palabras: ow.canonica(cmd), destino: 'ses-a', sesion: 'ses-a', cwd: c.repo, casa: c.casa });

const PLAN = ['# Plan', '', '## Qué hace', '', 'Nombra a la coordinadora con un click.', 'Las preguntas de firma dicen qué se aprueba.', '',
  '## Archivos', '', '- scripts/lib/owner-window.js', '- scripts/lib/signatures.js', '', '## Pasos', '', '1. uno', ''].join('\n');
const escribirPlan = (c, texto = PLAN) => { const f = path.join(c.runDir, 'step-02-bmad-plan.md'); fs.writeFileSync(f, texto); return f; };
const APRUEBA_PLAN = `node ${MARKER} complete-step approve-plan --approved "pido el click del dueño para el plan de la opción A"`;
const posicion = (texto, parte) => { const i = texto.indexOf(parte); assert.ok(i >= 0, `falta «${parte}» en: ${texto}`); return i; };

// 🔴 Falla con: una pregunta que empieza con «¿Aprobás», o un `approves` que no empieza con su verbo.
test('SignatureQuestion_EveryFirma_VerbOnce_NoAprobas (T32)', (t) => {
  const c = corrida(t);
  escribirPlan(c);
  for (const s of sig.SIGNATURES) {
    assert.match(s.approves.split(/\s+/)[0], /^\p{Ll}+(ar|er|ir)(se|le|la|lo)?$/u, `${s.id}: «${s.approves}» no empieza con un infinitivo`);
    const q = oa.cuadroDe({ firma: s.id, destino: 'ses-a', que: s.approves, queHace: ['algo'], siSaleMal: s.ifWrong, huella: 'ab12cd34' });
    const esperada = `¿${s.approves[0].toUpperCase()}${s.approves.slice(1)}?`;
    assert.ok(q.pregunta.startsWith(esperada), `${s.id}: ${q.pregunta}`);
    assert.doesNotMatch(q.pregunta, /Aprobás/, s.id);
  }
  // y la que arma el freno para el plan, de punta a punta
  const p = cuadro(c, APRUEBA_PLAN, { firma: 'plan-approval' });
  assert.ok(p.pregunta.startsWith('¿Aprobar el plan de una story?'), p.pregunta);
});

// 🔴 Falla con: la historia nombrada sólo por su número, o una línea de historia sin corrida.
test('SignatureQuestion_StoryWithTitle_NamesTitle (T33)', (t) => {
  const save = conFirma('save');
  const con = corrida(t);
  assert.match(save(con, `node ${MARKER} approve-save`).pregunta, new RegExp(`Historia 9\\.99, «${TITULO}», sesión ses-a\\.`));
  const sin = corrida(t, { titulo: null });
  assert.match(save(sin, `node ${MARKER} approve-save`).pregunta, /Historia 9\.99 \(sin título en su archivo\), sesión ses-a\./);
  // sin corrida no hay historia que nombrar, pero sí la sesión sobre la que se firma
  const ninguna = corrida(t);
  fs.rmSync(path.join(ninguna.estado, 'active', 'ses-a.json'));
  const q = save(ninguna, `node ${MARKER} approve-save`).pregunta;
  assert.doesNotMatch(q, /Historia/);
  assert.match(q, /\? Sesión ses-a\./);
});

// 🔴 Falla con: la pregunta del plan sin lo que dice el plan, o en otro orden.
test('SignatureQuestion_PlanApproval_FromThePlan (T34)', (t) => {
  const c = corrida(t);
  const f = escribirPlan(c);
  const q = cuadro(c, APRUEBA_PLAN, { firma: 'plan-approval' }).pregunta;
  const orden = ['¿Aprobar el plan de una story?', `Historia 9.99, «${TITULO}», sesión ses-a.`,
    'Qué hace: Nombra a la coordinadora con un click · Las preguntas de firma dicen qué se aprueba.',
    'Archivos: scripts/lib/owner-window.js, scripts/lib/signatures.js.', `Completo en: ${f}.`, 'Si sale mal: ', 'Cita de la sesión: «pido el click', '(firma plan-approval'];
  const pos = orden.map((p) => posicion(q, p));
  assert.deepStrictEqual(pos, [...pos].sort((a, b) => a - b), `fuera de orden: ${q}`);
});

// 🔴 Falla con: un plan sin sus dos secciones que llega a la ventana y gasta el click.
// 🔴 Falla con: un plan sin su resumen que llega al dueño sin aviso, o que frena las corridas de planes de antes.
test('ApprovePlan_PlanWithoutSections_BoxSaysWhatIsMissing_DoesNotBlock (T35)', (t) => {
  const casos = [
    // cada aviso dice qué sección falta y cómo agregarla
    [PLAN.replace(/## Qué hace[\s\S]*?(?=## Archivos)/, ''), /Qué hace: el plan no dice qué hace en hasta 3 líneas: falta la sección «## Qué hace»\. Agregala/],
    [PLAN.replace(/## Archivos[\s\S]*?(?=## Pasos)/, ''), /Qué hace: el plan no dice qué archivos toca: falta la sección «## Archivos»\. Agregala .*«- ruta»/],
    [PLAN.replace('Las preguntas de firma dicen qué se aprueba.', 'dos\ntres\ncuatro'), /su sección «## Qué hace» tiene 4\. Dejala en 3/],
    [null, /Qué hace: no encuentro el plan escrito en /],
  ];
  for (const [texto, aviso] of casos) {
    const c = corrida(t);
    fs.writeFileSync(path.join(c.estado, 'active', 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', storyPath: c.ruta, repoPath: c.repo,
      startedAt: '2026-11-04T12:00:00Z', stepScheme: 2, stepsCompleted: ['validate-story', 'plan'], stepsPending: ['approve-plan', 'implement'] }));
    if (texto !== null) escribirPlan(c, texto);
    assert.match(cuadro(c, APRUEBA_PLAN, { firma: 'plan-approval' }).pregunta, aviso);
    // el guion no lo niega por eso: el aviso va en la pregunta, y el dueño decide
    const r = ow.comprobarConElGuion({ palabras: ow.canonica(APRUEBA_PLAN), cwd: c.repo, sesion: 'ses-a', casa: c.casa });
    assert.ok(!(r && r.niega && /## Qué hace|## Archivos|plan escrito/.test(r.niega)), JSON.stringify(r));
  }
});

// 🔴 Falla con: el cambio de control sin el tamaño del cambio, sin sus rutas o sin el archivo del diff.
test('SignatureQuestion_ControlChange_DiffStatAndDiffFile (T36)', (t) => {
  const c = corrida(t);
  const fecha = '2026-11-04T12:00:00Z';
  const git = (...a) => spawnSync('git', ['-C', c.repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'maintenance.auto=false', ...a],
    { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha } });
  fs.mkdirSync(path.join(c.repo, 'scripts', 'ci'), { recursive: true });
  fs.writeFileSync(path.join(c.repo, 'scripts', 'ci', 'a.sh'), 'uno\n');
  fs.writeFileSync(path.join(c.repo, 'scripts', 'ci', 'b.sh'), 'dos\ntres\n');
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  fs.writeFileSync(path.join(c.repo, 'scripts', 'ci', 'a.sh'), 'uno\nnuevo\n');
  fs.writeFileSync(path.join(c.repo, 'scripts', 'ci', 'b.sh'), 'dos\n');
  git('commit', '-qam', 'cambio');
  const blob = (p) => git('rev-parse', `HEAD:${p}`).stdout.trim();
  const entries = JSON.stringify(['scripts/ci/a.sh', 'scripts/ci/b.sh'].map((p) => ({ path: p, blob: blob(p) })));
  const q = conFirma('control-change')(c, `bash ${CONTROLES} approve --root ${c.repo} --base ${base} --entries '${entries}'`).pregunta;
  assert.match(q, /Qué hace: Cambia 2 archivo\(s\) de control: \+1 −1 líneas\./);
  assert.match(q, /Archivos: scripts\/ci\/a\.sh, scripts\/ci\/b\.sh\./);
  const ruta = (q.match(/Completo en: (\S+\.patch)\./) || [])[1];
  assert.ok(ruta && fs.existsSync(ruta), q);
  const diff = fs.readFileSync(ruta, 'utf8');
  assert.match(diff, /\+nuevo/);
  assert.match(diff, /-tres/);
  // sin --base no hay contra qué comparar, y lo dice
  const sinBase = conFirma('control-change')(c, `bash ${CONTROLES} approve --root ${c.repo} --entries '${entries}'`).pregunta;
  assert.match(sinBase, /Firma 2 archivo\(s\) de control en su versión de la punta \(sin base para comparar\)/);
});

/** Un repo con scripts/ci/ctl.sh en las versiones dadas, un commit por versión y fechas fijas. */
function repoDeControles(t, versiones) {
  const c = corrida(t);
  const fecha = '2026-11-04T12:00:00Z';
  const git = (...a) => spawnSync('git', ['-C', c.repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'maintenance.auto=false', ...a],
    { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha } });
  fs.mkdirSync(path.join(c.repo, 'scripts', 'ci'), { recursive: true });
  git('init', '-q');
  for (const v of versiones) { fs.writeFileSync(path.join(c.repo, 'scripts', 'ci', 'ctl.sh'), v); git('add', 'scripts'); git('commit', '-qm', v.trim()); }
  return { c, git };
}

// 🔴 Falla con: una versión que la sesión escribió leída por git como opción (`--output=` pisa un archivo al armar el cuadro).
test('SignatureQuestion_ControlChange_RevisionIsNeverAnOption', (t) => {
  const { c } = repoDeControles(t, ['a=1\n', 'a=2\n']);
  const victima = path.join(c.repo, 'victima.txt');
  fs.writeFileSync(victima, 'DATOS\n');
  const entries = JSON.stringify([{ path: 'scripts/ci/ctl.sh', blob: 'x' }]);
  // --rev con --file, y --base con --entries: los dos salen de lo que escribió la sesión
  for (const [opcion, resto] of [['--rev', '--file scripts/ci/ctl.sh'], ['--base', `--entries '${entries}'`]]) {
    const q = conFirma('control-change')(c, `bash ${CONTROLES} approve --root ${c.repo} ${opcion} --output=${victima} ${resto}`).pregunta;
    assert.strictEqual(fs.readFileSync(victima, 'utf8'), 'DATOS\n', `${opcion}: git pisó el archivo al armar el cuadro`);
    assert.match(q, /Qué hace: no pude leer el cambio de 1 archivo\(s\) de control: «--output=/, `${opcion}: ${q}`);
  }
  // una carpeta que no es un repo: git no pudo contestar, que no es lo mismo que una versión que no existe
  const suelta = temporal(t, 'sigq-suelta-');
  const q = conFirma('control-change')(c, `bash ${CONTROLES} approve --root ${suelta} --file scripts/ci/ctl.sh`).pregunta;
  assert.match(q, /no pude leer el cambio de 1 archivo\(s\) de control: git no pudo leer /, q);
  assert.doesNotMatch(q, /no es una versión/);
});

// 🔴 Falla con: con --file, una pregunta que muestra otra versión de la que se firma, o que no cambia cuando cambia el archivo.
test('SignatureQuestion_ControlChange_FileShowsTheSignedVersion', (t) => {
  const { c } = repoDeControles(t, ['a=1\n', 'a=2\n', 'a=999\n', 'a=5\n']);
  const preguntar = (extra) => conFirma('control-change')(c, `bash ${CONTROLES} approve --root ${c.repo} --file scripts/ci/ctl.sh ${extra}`);
  // sin --rev firma la punta: muestra el cambio de la punta (a=999 → a=5)
  const punta = preguntar('');
  const diffDe = (q) => fs.readFileSync((q.pregunta.match(/Completo en: (\S+\.patch)\./) || [])[1], 'utf8');
  assert.match(diffDe(punta), /-a=999\n\+a=5/, punta.pregunta);
  // con --rev y --base, lo que se firma es --rev: se muestra su cambio (a=1 → a=2), no el de --base a la punta
  const conRev = preguntar('--rev HEAD~2 --base HEAD~3');
  assert.match(diffDe(conRev), /-a=1\n\+a=2/, conRev.pregunta);
  // en un repo de un solo commit no hay padre: la huella lleva el contenido, y cambia si el archivo cambia
  const solo = repoDeControles(t, ['a=1\n']);
  const una = conFirma('control-change')(solo.c, `bash ${CONTROLES} approve --root ${solo.c.repo} --file scripts/ci/ctl.sh`);
  assert.match(una.pregunta, /en su versión de [0-9a-f]{12} \(sin base para comparar\)/);
  fs.writeFileSync(path.join(solo.c.repo, 'scripts', 'ci', 'ctl.sh'), 'a=2\n');
  solo.git('commit', '-qam', 'a=2', '--amend');
  assert.notStrictEqual(conFirma('control-change')(solo.c, `bash ${CONTROLES} approve --root ${solo.c.repo} --file scripts/ci/ctl.sh`).sello, una.sello);
});

// 🔴 Falla con: una exención o una vuelta extra que no dice qué exime ni dónde está lo completo.
test('SignatureQuestion_WaiversAndExtraRound_FromTheirSource (T37)', (t) => {
  const c = corrida(t, { extraHistoria: ['runtime_not_verifiable:', '  - ac: 1', '    reason: "el servicio externo no tiene ambiente de prueba"', '    covered_by: T1'] });
  const rw = conFirma('runtime-waiver')(c, `node ${MARKER} runtime-waiver ${c.ruta} --acs 1`).pregunta;
  assert.match(rw, /Qué hace: AC 1: .*servicio externo/);
  assert.ok(rw.includes(`Completo en: ${c.ruta}.`), rw);
  const mt = conFirma('manual-test')(c, `node ${MARKER} mark-tested --acs 2`).pregunta;
  assert.match(mt, /Qué hace: AC 2: .*se ve en la lista/);
  assert.ok(mt.includes(`Completo en: ${c.ruta}.`), mt);
  // el crítico: sin informe, sin coincidencia, con una y con varias
  const crit = (cmd) => conFirma('critical-waiver')(c, `node ${MARKER} waive-critical ${cmd} --reason "lo cubre otra capa"`).pregunta;
  assert.match(crit('--rule SEC-C1 --file a.js'), /Qué hace: Eximir SEC-C1 en a\.js: no hay informe de hallazgos en esta ejecución\./);
  const informe = path.join(c.runDir, 'findings.json');
  const hallazgo = (n, file) => ({ rule_id: 'SEC-C1', severity: 'CRITICAL', file, summary: `secreto en el código ${n}`, disposition: 'open' });
  fs.writeFileSync(informe, JSON.stringify([hallazgo(1, 'a.js'), ...[2, 3, 4, 5].map((n) => hallazgo(n, 'b.js')), hallazgo(6, undefined)]));
  assert.match(crit('--rule SEC-C9 --file a.js'), /Eximir SEC-C9 en a\.js: no está en el informe de hallazgos\./);
  const una = crit('--rule SEC-C1 --file a.js');
  assert.match(una, /Qué hace: SEC-C1 en a\.js: secreto en el código 1\./);
  assert.ok(una.includes(`Completo en: ${informe}.`), una);
  assert.match(crit('--rule SEC-C1 --file b.js'), /secreto en el código 2 · SEC-C1 en b\.js: secreto en el código 3 · SEC-C1 en b\.js: secreto en el código 4 · y 1 más\./);
  // sin --file la exención se anota sin archivo (regla|): sólo exime, y sólo muestra, los hallazgos sin archivo
  const sinArchivo = crit('--rule SEC-C1');
  assert.match(sinArchivo, /Qué hace: SEC-C1: secreto en el código 6\./);
  assert.doesNotMatch(sinArchivo, /a\.js|b\.js/);
  // la vuelta extra: con su nota, y sin ella
  const extra = () => conFirma('extra-round')(c, `node ${PIPELINE} smart-reloop --iter 3 --extra-round`).pregunta;
  assert.match(extra(), /Qué hace: Una vuelta 3 de revisores sobre lo que quedó abierto\./);
  assert.ok(extra().includes(`Completo en: ${c.runDir}.`), extra());
  const nota = path.join(c.runDir, 'rethink', 'iter-3.json');
  fs.mkdirSync(path.dirname(nota), { recursive: true });
  fs.writeFileSync(nota, JSON.stringify({ iter: 3, repeated: 'vuelve el hallazgo del tope', change: 'se parte el archivo en dos' }));
  assert.match(extra(), /Qué hace: Se repitió: vuelve el hallazgo del tope · Cambia: se parte el archivo en dos\./);
  assert.ok(extra().includes(`Completo en: ${nota}.`), extra());
});

// Criterios largos que la matriz da por no verificables en vivo: con su razón y la prueba que los cubre
const largo = (n) => `**Given** el criterio ${n} **Then** ${'pasa algo que se explica con muchas palabras '.repeat(9)}`;
const eximibles = (ns) => ({
  criterios: ns.map((n) => ({ n, texto: largo(n) })),
  extraHistoria: ['runtime_not_verifiable:', ...ns.flatMap((n) => [`  - ac: ${n}`, `    reason: "el criterio ${n} no tiene ambiente de prueba ${'y lo explica largo '.repeat(6)}"`, '    covered_by: T1'])],
});
const lineaDeCriterios = (q) => (q.match(/Criterios: [^.]*\./) || [null])[0];

// 🔴 Falla con: un cuadro de exención con criterios largos que no nombra a todos (el caso de la 8.198: el AC 63 no se vio).
test('SignatureQuestion_WaiverTresCriteriosLargos_NombraLosTres', (t) => {
  const c = corrida(t, eximibles([32, 56, 63]));
  const q = conFirma('runtime-waiver')(c, `node ${MARKER} runtime-waiver ${c.ruta}`);
  assert.ok(!q.error, q.error);
  for (const s of [q.pregunta, q.texto]) {
    assert.strictEqual(lineaDeCriterios(s), 'Criterios: AC 32, 56 y 63.', s);
    assert.ok(posicion(s, 'Criterios: AC') < posicion(s, 'Qué hace:'), s);
  }
});

// 🔴 Falla con: del cuarto criterio en adelante sólo se ve «y N más», sin los números.
test('SignatureQuestion_WaiverCincoCriterios_NombraLosCincoAunqueResuma', (t) => {
  const c = corrida(t, eximibles([2, 7, 9, 13, 40]));
  const r = conFirma('runtime-waiver')(c, `node ${MARKER} runtime-waiver ${c.ruta} --acs 9,2,40,7,13`);
  assert.ok(!r.error, r.error);
  const q = r.pregunta;
  assert.strictEqual(lineaDeCriterios(q), 'Criterios: AC 2, 7, 9, 13 y 40.', q);
  assert.match(q, /Qué hace: .* · y 2 más\./);
  escribirPlan(c);
  assert.doesNotMatch(conFirma('plan-approval')(c, APRUEBA_PLAN).pregunta, /Criterios:/);
});

// Criterios declarados no verificables en vivo, cada uno con su razón: `razones` es `{ <n>: <razón o null> }`
const conRazones = (razones) => {
  const ns = Object.keys(razones).map(Number);
  return {
    criterios: ns.map((n) => ({ n, texto: `**Given** el criterio ${n} **Then** pasa algo` })),
    extraHistoria: ['runtime_not_verifiable:', ...ns.flatMap((n) => [`  - ac: ${n}`, ...(razones[n] === null ? [] : [`    reason: "${razones[n]}"`]), '    covered_by: T1'])],
  };
};
// lo que se aprueba: la pregunta hasta el «?» que la cierra (las razones de estas pruebas no traen «? »)
const tituloDe = (q) => q.slice(0, q.indexOf('? ') + 1);
const OTRA_CORRIDA = 'se prueba en la corrida de su propia historia, no en la de esta tanda';
// los criterios como los entrega la matriz: `{ <n>: <razón o null> }`
const excepciones = (razones) => Object.keys(razones).map(Number).map((ac) => ({ ac, reason: razones[ac], coveredBy: 'T1', text: `el criterio ${ac}` }));
// el título que arma el cuadro con lo que se aprueba (el mismo recorte a 200 y los signos)
const tituloCon = (razones) => tituloDe(oa.cuadroDe({ firma: 'runtime-waiver', que: ow.queDeLaExcepcion(excepciones(razones)), queHace: ['x'], archivos: [] }).pregunta);

// 🔴 Falla con: el título de siempre («¿Aceptar un criterio imposible de probar en vivo?») aunque la razón sea otra.
test('OwnerWindow_WaiverOneReason_TitleSaysTheReason (T6) @story-8.237 @ac-6 @ac-8', () => {
  assert.strictEqual(tituloCon({ 5: OTRA_CORRIDA }), `¿Aceptar sin prueba en vivo el AC 5, porque «${OTRA_CORRIDA}»?`);
  assert.strictEqual(tituloCon({ 3: OTRA_CORRIDA, 1: OTRA_CORRIDA, 2: OTRA_CORRIDA }), `¿Aceptar sin prueba en vivo los AC 1, 2 y 3, porque «${OTRA_CORRIDA}»?`);
  // una razón larga se recorta antes de que el cuadro la corte: el cierre queda
  const larga = 'la prueba la corre la CI de Windows del pedido y no esta máquina '.repeat(5).trim();
  const tl = tituloCon({ 7: larga });
  assert.ok(tl.length <= 202, `${tl.length}: ${tl}`);
  assert.ok(tl.endsWith('…»?'), tl);
  assert.ok(tl.startsWith('¿Aceptar sin prueba en vivo el AC 7, porque «la prueba la corre la CI de Windows'), tl);
  // muchos criterios: se cuentan en vez de nombrarse, y el título no pasa del largo
  const muchos = Object.fromEntries(Array.from({ length: 30 }, (_, k) => [k + 100, OTRA_CORRIDA]));
  assert.ok(tituloCon(muchos).startsWith('¿Aceptar sin prueba en vivo 30 criterios, porque «'), tituloCon(muchos));
  assert.ok(tituloCon(muchos).length <= 202, tituloCon(muchos));
  // sin razón declarada, o con la razón de relleno de la matriz
  assert.strictEqual(tituloCon({ 4: null }), '¿Aceptar sin prueba en vivo el AC 4, sin razón declarada?');
  assert.strictEqual(tituloCon({ 4: '(sin razón declarada)' }), '¿Aceptar sin prueba en vivo el AC 4, sin razón declarada?');
  for (const r of [{ 5: OTRA_CORRIDA }, { 7: larga }, { 4: null }]) assert.doesNotMatch(tituloCon(r), /imposible/);
});

// 🔴 Falla con: la razón al final del renglón, cortada por el largo del renglón («(por qué n…»).
test('OwnerWindow_WaiverManyReasons_EachLineStartsWithItsReason (T7) @story-8.237 @ac-7', () => {
  const razon = (n) => `razón ${n}: ${'la prueba depende de un servicio que esta máquina no tiene y que se prueba en otra corrida'.slice(0, 140)}`;
  const lista = excepciones({ 1: razon(1), 2: razon(2), 3: razon(3) });
  assert.strictEqual(tituloCon({ 1: razon(1), 2: razon(2), 3: razon(3) }), '¿Aceptar sin prueba en vivo los AC 1, 2 y 3, cada uno por la razón que declaró?');
  const cuadro = oa.cuadroDe({ firma: 'runtime-waiver', que: ow.queDeLaExcepcion(lista), queHace: lista.map(ow.renglonDeLaExcepcion), archivos: [] }).pregunta;
  for (const n of [1, 2, 3]) {
    assert.ok(razon(n).length <= 150, razon(n).length);
    assert.ok(cuadro.includes(`AC ${n}: por qué no se prueba en vivo: ${razon(n)}; lo cubre:`), `AC ${n}: ${cuadro}`);
  }
});

// 🔴 Falla con: un cuadro que cambia entre el pedido y el click (la huella no coincidiría y el click no valdría), o un
// cuadro que no usa la razón declarada en la historia.
test('OwnerWindow_WaiverBox_SameQuestionAndPrintTwice (T8) @story-8.237 @ac-6 @ac-9', (t) => {
  const c = corrida(t, conRazones({ 2: OTRA_CORRIDA }));
  const cmd = `node ${MARKER} runtime-waiver ${c.ruta}`;
  const a = conFirma('runtime-waiver')(c, cmd);
  const b = conFirma('runtime-waiver')(c, cmd);
  assert.ok(!a.error, a.error);
  assert.strictEqual(tituloDe(a.pregunta), `¿Aceptar sin prueba en vivo el AC 2, porque «${OTRA_CORRIDA}»?`);
  assert.strictEqual(a.pregunta, b.pregunta);
  assert.strictEqual(a.sello, b.sello);
  // la aprobación dada sobre el cuadro del pedido vale contra el que se arma al validarla
  assert.ok(oa.traeElSello(`Te pido esto: ${a.pregunta}`, { sello: b.sello, destino: 'ses-a', pregunta: b.pregunta }));
});

// 🔴 Falla con: la ruta del guion metida en la huella (la misma firma pedida desde otro puesto daría otro código), o un
// guion en una carpeta con apóstrofo que el freno deja de reconocer.
test('OwnerWindow_ControlChangeBox_SamePrintWithFullOrRelativePath (T9) @story-8.237 @ac-1 @ac-5', (t) => {
  const c = corrida(t);
  const entries = "'[{\"path\":\"scripts/ci/x.sh\",\"blob\":\"0000000000000000000000000000000000000000\"}]'";
  const resto = `approve --root ${c.repo} --entries ${entries}`;
  const formas = [`bash scripts/ci/run-base-controls.sh ${resto}`, `bash /un/puesto/scripts/ci/run-base-controls.sh ${resto}`,
    `bash '/otro puesto/scripts/ci/run-base-controls.sh' ${resto}`, `bash 'C:\\Users\\Ana\\arnés\\scripts\\ci\\run-base-controls.sh' ${resto}`];
  const codigos = formas.map((cmd) => { const q = conFirma('control-change')(c, cmd); assert.ok(!q.error, `${cmd}: ${q.error}`); return q.sello.split('código ')[1]; });
  assert.deepStrictEqual(new Set(codigos).size, 1, codigos.join(' '));
  const obrien = `bash '/tmp/arnés de O'\\''Brien/scripts/ci/run-base-controls.sh' ${resto}`;
  assert.strictEqual((ow.canonicaDe(obrien) || {}).id, 'control-change', obrien);
});

const fuentes = require('../lib/signature-sources.js');
const SIN_QUE_HACE = PLAN.replace(/## Qué hace[\s\S]*?(?=## Archivos)/, '');
const SIN_LAS_DOS = SIN_QUE_HACE.replace(/## Archivos[\s\S]*?(?=## Pasos)/, '');
const LARGO_SIN_ARCHIVOS = PLAN.replace('Las preguntas de firma dicen qué se aprueba.', 'dos\ntres\ncuatro\ncinco').replace(/## Archivos[\s\S]*?(?=## Pasos)/, '');

// 🔴 Falla con: un plan sin las dos secciones que sólo nombra la primera (la sesión se entera de la otra en la vuelta siguiente).
test('SignatureQuestion_PlanMissingTwoSections_NamesBoth (T10) @story-8.237 @ac-10', () => {
  const s = fuentes.seccionesDelPlan(SIN_LAS_DOS);
  assert.match(s.error, /«## Qué hace»/);
  assert.match(s.error, /«## Archivos»/);
  assert.strictEqual(s.errores.length, 2, JSON.stringify(s.errores));
  assert.match(s.errores[0], /«## Qué hace»\. Agregala/);
  assert.match(s.errores[1], /«## Archivos»\. Agregala .*«- ruta»/);
});

// 🔴 Falla con: el largo de «Qué hace» dicho solo, sin la sección que falta.
test('SignatureQuestion_LongPlanWithoutFiles_SaysBoth (T11) @story-8.237 @ac-11', () => {
  const s = fuentes.seccionesDelPlan(LARGO_SIN_ARCHIVOS);
  assert.match(s.error, /tiene 5\. Dejala en 3/);
  assert.match(s.error, /«## Archivos»/);
  assert.strictEqual(s.errores.length, 2, JSON.stringify(s.errores));
});

// 🔴 Falla con: un plan completo que deja de dar su resumen y sus archivos.
test('SignatureQuestion_CompletePlan_AsBefore (T12) @story-8.237 @ac-13', () => {
  assert.deepStrictEqual(fuentes.seccionesDelPlan(PLAN), { queHace: ['Nombra a la coordinadora con un click.', 'Las preguntas de firma dicen qué se aprueba.'],
    archivos: ['scripts/lib/owner-window.js', 'scripts/lib/signatures.js'] });
  // una sola falta: el renglón de siempre
  assert.deepStrictEqual(fuentes.seccionesDelPlan(SIN_QUE_HACE).errores, [fuentes.seccionesDelPlan(SIN_QUE_HACE).error]);
});

// 🔴 Falla con: las dos faltas en un solo renglón, que el cuadro corta a 200 y deja la segunda a medias.
test('ApprovePlan_PlanWithoutTwoSections_BoxNamesBoth_DoesNotBlock (T13) @story-8.237 @ac-12', (t) => {
  for (const texto of [SIN_LAS_DOS, LARGO_SIN_ARCHIVOS]) {
    const c = corrida(t);
    fs.writeFileSync(path.join(c.estado, 'active', 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', storyPath: c.ruta, repoPath: c.repo,
      startedAt: '2026-11-04T12:00:00Z', stepScheme: 2, stepsCompleted: ['validate-story', 'plan'], stepsPending: ['approve-plan', 'implement'] }));
    escribirPlan(c, texto);
    const q = cuadro(c, APRUEBA_PLAN, { firma: 'plan-approval' }).pregunta;
    for (const e of fuentes.seccionesDelPlan(texto).errores) assert.ok(q.includes(e), `falta «${e}» entero en: ${q}`);
    const r = ow.comprobarConElGuion({ palabras: ow.canonica(APRUEBA_PLAN), cwd: c.repo, sesion: 'ses-a', casa: c.casa });
    assert.ok(!(r && r.niega && /## Qué hace|## Archivos/.test(r.niega)), JSON.stringify(r));
  }
});

// 🔴 Falla con: la prueba a mano que no nombra todos sus criterios.
test('SignatureQuestion_PruebaAMano_NombraTodos', (t) => {
  const c = corrida(t, { criterios: [1, 4, 5, 8].map((n) => ({ n, texto: largo(n) })) });
  const q = conFirma('manual-test')(c, `node ${MARKER} mark-tested --acs 1,4,5,8`).pregunta;
  assert.strictEqual(lineaDeCriterios(q), 'Criterios: AC 1, 4, 5 y 8.', q);
});

// 🔴 Falla con: una prueba a mano sin historia en el marcador que muestra una línea de criterios sin dónde leerlos.
test('SignatureQuestion_PruebaAManoSinHistoria_ComoHoy', (t) => {
  const c = corrida(t);
  const marcador = path.join(c.estado, 'active', 'ses-a.json');
  const { storyPath, ...sinHistoria } = JSON.parse(fs.readFileSync(marcador, 'utf8'));
  fs.writeFileSync(marcador, JSON.stringify(sinHistoria));
  const q = conFirma('manual-test')(c, `node ${MARKER} mark-tested --acs 1,4`).pregunta;
  assert.doesNotMatch(q, /Criterios:/);
  assert.match(q, /Qué hace: /);
});

// 🔴 Falla con: una prueba a mano sin criterios que muestra una línea vacía.
test('SignatureQuestion_PruebaAManoSinAcs_ComoHoy', (t) => {
  const c = corrida(t);
  const q = conFirma('manual-test')(c, `node ${MARKER} mark-tested`).pregunta;
  assert.doesNotMatch(q, /Criterios:/);
  assert.match(q, /Qué hace: /);
});

// 🔴 Falla con: un informe o una nota rotos que la pregunta presenta como si no existieran.
test('SignatureQuestion_BrokenSource_SaysItCouldNotRead', (t) => {
  const c = corrida(t);
  fs.writeFileSync(path.join(c.runDir, 'findings.json'), '{ roto');
  const crit = conFirma('critical-waiver')(c, `node ${MARKER} waive-critical --rule SEC-C1 --file a.js --reason "x"`).pregunta;
  assert.match(crit, /Eximir SEC-C1 en a\.js: no pude leer el informe de hallazgos \(no se entiende: .*Completo en: .*findings\.json\./);
  assert.doesNotMatch(crit, /no hay informe/);
  fs.mkdirSync(path.join(c.runDir, 'rethink'), { recursive: true });
  fs.writeFileSync(path.join(c.runDir, 'rethink', 'iter-2.json'), '{ roto');
  const vuelta = conFirma('extra-round')(c, `node ${PIPELINE} smart-reloop --iter 2 --extra-round`).pregunta;
  assert.match(vuelta, /Una vuelta 2 de revisores sobre lo que quedó abierto \(su nota no se entiende: .*Completo en: .*iter-2\.json\./);
  // un plan que es una carpeta: está, pero no se puede leer
  fs.mkdirSync(path.join(c.runDir, 'step-02-bmad-plan.md'));
  assert.match(cuadro(c, APRUEBA_PLAN, { firma: 'plan-approval' }).pregunta, /no encuentro el plan escrito en .*step-02-bmad-plan\.md \(no pude leerlo: EISDIR\)/);
});

// 🔴 Falla con: una ruta larga que empuja la nota «(no pude leerlo…)» del plan fuera del recorte de «Qué hace».
test('SignatureQuestion_PlanIlegibleRutaLarga_NotaVisible', (t) => {
  const largo = temporal(t, `sigq-${'r'.repeat(120)}-`);
  const antes = process.env.TMPDIR;
  process.env.TMPDIR = largo;
  t.after(() => { if (antes === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = antes; });
  const c = corrida(t);
  fs.mkdirSync(path.join(c.runDir, 'step-02-bmad-plan.md'));
  const q = cuadro(c, APRUEBA_PLAN, { firma: 'plan-approval' }).pregunta;
  assert.ok(`no encuentro el plan escrito en ${path.join(c.runDir, 'step-02-bmad-plan.md')}`.length > 200, 'la ruta tiene que pasar el recorte');
  assert.ok(q.includes('step-02-bmad-plan.md (no pude leerlo: EISDIR).') || q.includes('… (no pude leerlo: EISDIR).'), q);
});

// 🔴 Falla con: un «si sale mal» igual para dos firmas que arriesgan cosas distintas.
test('Signatures_IfWrong_DistinctAcrossCovers (T38)', () => {
  const vistos = new Map();
  for (const s of sig.SIGNATURES) {
    const clave = s.covers.join(',');
    const otro = vistos.get(s.ifWrong);
    assert.ok(!otro || otro === clave, `«${s.ifWrong}» lo repiten ${s.id} y otra firma de distinto alcance (${otro})`);
    vistos.set(s.ifWrong, clave);
  }
  assert.ok(!('SI_SALE_MAL_ESCAPE' in sig), 'el texto común de los escapes desaparece');
  assert.ok(!fs.readFileSync(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'), 'utf8').includes('SI_SALE_MAL_ESCAPE'));
});

// 🔴 Falla con: «Qué hace» armado con la cita de la sesión, o la cita antes de lo que sale de la fuente.
test('SignatureQuestion_SessionQuote_GoesLast (T39)', (t) => {
  const c = corrida(t);
  escribirPlan(c);
  const casos = [
    ['plan-approval', APRUEBA_PLAN, 'pido el click del dueño para el plan de la opción A'],
    ['critical-waiver', `node ${MARKER} waive-critical --rule SEC-C1 --file a.js --reason "lo cubre otra capa"`, 'lo cubre otra capa'],
    ['adhoc-lane', `node ${MARKER} adhoc set '{"reason":"arreglo el aviso roto de la noche"}'`, 'arreglo el aviso roto de la noche'],
  ];
  for (const [firma, cmd, cita] of casos) {
    const q = conFirma(firma)(c, cmd).pregunta;
    const que = q.slice(q.indexOf('Qué hace:'), q.indexOf('Si sale mal:'));
    assert.ok(!que.includes(cita), `${firma}: «Qué hace» no sale de la cita: ${q}`);
    assert.ok(posicion(q, `Cita de la sesión: «${cita}»`) > posicion(q, 'Si sale mal:'), q);
  }
});

// 🔴 Falla con: la ventana, el cuadro y la lista diciendo cosas distintas para la misma firma.
test('SignatureQuestion_WindowBoxAndList_SameText (T40)', (t) => {
  const c = corrida(t);
  escribirPlan(c);
  const q = cuadro(c, APRUEBA_PLAN, { firma: 'plan-approval' });
  assert.strictEqual(q.pregunta, `${q.texto} (${q.sello})`);
  const herramienta = { pid: 100, ppid: 1, inicio: 'Tue Nov 03 10:00:00 2026', comando: '/Applications/x/native-binary/claude --output-format stream-json --verbose' };
  const arbol = [{ pid: 1, ppid: 0, inicio: 'Mon Nov 02 08:00:00 2026', comando: '/sbin/launchd' }, herramienta,
    { pid: 200, ppid: 100, inicio: herramienta.inicio, comando: '/bin/bash /h/scripts/hooks/safety-guard-pre.sh' },
    { pid: 201, ppid: 200, inicio: herramienta.inicio, comando: 'node /h/scripts/lib/owner-window.js gate' }];
  const r = ow.decidir({ evento: { session_id: 'ses-a', tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: APRUEBA_PLAN }, cwd: c.repo },
    arbol, pid: 201, casa: c.casa, ahora: Date.parse('2026-11-04T12:30:00Z'), delegacion: () => ({ ok: false, motivo: 'sin delegación' }), clasificar: () => null, comprobar: () => null });
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.ok(r.texto.includes(q.texto), `la ventana no dice la pregunta del cuadro:\n${r.texto}\n${q.texto}`);
  assert.doesNotMatch(r.texto, /Detalle:/);
  // la lista de firmas pendientes rearma con cuadroPara: la misma pregunta
  const lista = require('../lib/signature-list.js');
  const fila = { firma: 'plan-approval', comando: APRUEBA_PLAN, destino: 'ses-a', cwd: c.repo };
  assert.strictEqual(lista.cuadroDeLaFila(fila, c.casa).pregunta, q.pregunta);
});

// 🔴 Falla con: el caso de la 8.205 que vuelve: «¿Aprobás aprobar…?», sin título y con la cita como único detalle.
test('SignatureQuestion_Case8205_IsDecidable (T41)', (t) => {
  const c = corrida(t, { story: '8.205', titulo: 'El click del dueño vale en sesiones sin foto' });
  const f = escribirPlan(c);
  const q = cuadro(c, `node ${MARKER} complete-step approve-plan --approved "pido el click del dueño para el plan de la opción A"`, { firma: 'plan-approval' }).pregunta;
  assert.doesNotMatch(q, /¿Aprobás aprobar/);
  assert.match(q, /Historia 8\.205, «El click del dueño vale en sesiones sin foto», sesión ses-a\./);
  assert.match(q, /Qué hace: Nombra a la coordinadora con un click/);
  assert.ok(q.includes(`Completo en: ${f}.`), q);
  assert.ok(q.indexOf('Cita de la sesión: «pido el click del dueño para el plan de la opción A»') > q.indexOf('Si sale mal:'), q);
});

// 🔴 Falla con: un click que firma un plan distinto del que se mostró.
test('SignatureQuestion_SourceChangedAfterBox_ClickDoesNotCount (T43)', (t) => {
  const c = corrida(t);
  const f = escribirPlan(c);
  const antes = cuadro(c, APRUEBA_PLAN, { firma: 'plan-approval' });
  assert.strictEqual(cuadro(c, APRUEBA_PLAN, { firma: 'plan-approval' }).sello, antes.sello, 'la misma fuente da el mismo sello');
  fs.writeFileSync(f, PLAN.replace('Nombra a la coordinadora con un click.', 'Borra la frase de respaldo.'));
  const despues = cuadro(c, APRUEBA_PLAN, { firma: 'plan-approval' });
  assert.notStrictEqual(despues.sello, antes.sello, 'el plan cambió y el sello también');
  // un click dado al cuadro de antes, en la conversación de la sesión, no contesta el de después
  const ts = '2026-11-04T12:59:00.000Z';
  const ruta = path.join(c.casa, 'transcripcion.jsonl');
  fs.writeFileSync(ruta, [
    { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input: { questions: [{ question: antes.pregunta }] } }] } },
    { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      toolUseResult: { questions: [{ question: antes.pregunta, options: antes.opciones.map((label) => ({ label })) }], answers: { [antes.pregunta]: antes.opciones[0] } },
      permissionDecision: { decision: 'accept', source: 'user_temporary' } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const click = { tipo: 'click', sesion: 'ses-a', ts, tool_use_id: 'toolu_1', pregunta: antes.pregunta, respuesta: antes.opciones[0] };
  assert.strictEqual(oa.clickEnLaTranscripcion(ruta, click, { pregunta: antes.pregunta, opciones: antes.opciones }).ok, true, 'el click vale para lo que se mostró');
  const v = oa.clickEnLaTranscripcion(ruta, click, { pregunta: despues.pregunta, opciones: despues.opciones });
  assert.strictEqual(v.ok, false);
  assert.match(v.motivo, /no es la que armó el guion/);
  // por el camino de la firma: el click anotado en la sesión no vale, y el guion dice por qué con la frase del AC 38
  const ahora = Date.parse(ts) + 60000;
  oa.anotar(c.casa, { id: 'click-1', ...click });
  const r = oa.buscar({ casa: c.casa, sesion: 'ses-a', cuadro: despues, ahora, validar: () => ({ ok: true }) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motivo, 'lo que se mostró cambió: pedí el cuadro de nuevo');
  // y para el mismo cuadro de antes, el click sí se encuentra
  assert.strictEqual(oa.buscar({ casa: c.casa, sesion: 'ses-a', cuadro: antes, ahora, validar: () => ({ ok: true }) }).ok, true);
  // ídem con el diff de un control: otro contenido en la punta, otro sello y la misma frase
  const { c: cc, git } = repoDeControles(t, ['a=1\n', 'a=2\n']);
  const cmd = `bash ${CONTROLES} approve --root ${cc.repo} --file scripts/ci/ctl.sh`;
  const visto = conFirma('control-change')(cc, cmd);
  fs.writeFileSync(path.join(cc.repo, 'scripts', 'ci', 'ctl.sh'), 'a=3\n');
  git('commit', '-qam', 'a=3');
  const firmado = conFirma('control-change')(cc, cmd);
  assert.notStrictEqual(firmado.sello, visto.sello);
  oa.anotar(cc.casa, { id: 'click-2', tipo: 'click', sesion: 'ses-a', ts, tool_use_id: 'toolu_2', pregunta: visto.pregunta, respuesta: visto.opciones[0] });
  assert.strictEqual(oa.buscar({ casa: cc.casa, sesion: 'ses-a', cuadro: firmado, ahora, validar: () => ({ ok: true }) }).motivo, 'lo que se mostró cambió: pedí el cuadro de nuevo');
});

// 🔴 Falla con: un corte que no se ve: una línea larga o una lista de archivos que se cae sin aviso.
test('SignatureQuestion_LongFields_CutWithMark (T44)', () => {
  const larga = 'x'.repeat(300);
  const archivos = Array.from({ length: 14 }, (_, i) => `a${i}.js`);
  const q = oa.cuadroDe({ firma: 'save', destino: 'ses-a', que: 'guardar la story', queHace: [larga], archivos, siSaleMal: 'se revierte', huella: 'ab12cd34' }).pregunta;
  assert.ok(q.includes(`Qué hace: ${'x'.repeat(200)}….`), q);
  assert.ok(q.includes(`Archivos: ${archivos.slice(0, 10).join(', ')} y 4 más.`), q);
});

const pideControl = (c, base, ruta = 'scripts/ci/ctl.sh') => conFirma('control-change')(c, `bash ${CONTROLES} approve --root ${c.repo} --base ${base} --entries '${JSON.stringify([{ path: ruta, blob: 'x' }])}'`);

// 🔴 Falla con: armar el cuadro de un cambio de control con el diff vacío (la sesión soltó su puesto y la punta volvió a
//    la base): el dueño firmaría «+0 −0 líneas» a ciegas.
test('SignatureQuestion_ControlChange_EmptyDiff_NoBox (T45) @fix-T-227 @story-8.235 @ac-1', (t) => {
  const { c, git } = repoDeControles(t, ['a=1\n']);
  const sinCambio = pideControl(c, git('rev-parse', 'HEAD').stdout.trim());
  assert.ok(!sinCambio.pregunta, 'sin cuadro');
  assert.match(String(sinCambio.error), /^el cambio de control está vacío entre [0-9a-f]{12} y [0-9a-f]{12}: no hay nada que firmar\. Pedí la firma desde la carpeta donde está el cambio$/);
  // y el freno niega sin darle a la sesión un cuadro para mostrar
  const r = ow.negarSinVentana('sin ventana', ['control-change'], 'ses-a', sinCambio);
  assert.strictEqual(r.decision, 'deny');
  assert.ok(!r.cuadro, r.texto);
  // con --file, un commit que no toca el control tampoco trae nada que firmar
  fs.writeFileSync(path.join(c.repo, 'LEEME.md'), 'x\n');
  git('add', 'LEEME.md'); git('commit', '-qm', 'otro');
  const conArchivo = conFirma('control-change')(c, `bash ${CONTROLES} approve --root ${c.repo} --file scripts/ci/ctl.sh --rev HEAD`);
  assert.match(String(conArchivo.error), /está vacío/);
});

// 🔴 Falla con: tomar por vacío un cambio que suma 0 líneas pero trae diff (un cambio de modo, un renombre, el borrado
//    de un archivo vacío): se siguen firmando como hoy.
test('SignatureQuestion_ControlChange_ZeroLinesButDiff_StillAsks (T46) @fix-T-227 @story-8.235 @ac-2', (t) => {
  const casos = [
    ['modo', (c, git) => { fs.chmodSync(path.join(c.repo, 'scripts', 'ci', 'ctl.sh'), 0o755); git('add', 'scripts/ci/ctl.sh'); }, 'scripts/ci/ctl.sh'],
    ['renombre', (c, git) => git('mv', 'scripts/ci/ctl.sh', 'scripts/ci/otro.sh'), 'scripts/ci/otro.sh'],
    ['borrado de un vacío', (c, git) => git('rm', '-q', 'scripts/ci/vacio.sh'), 'scripts/ci/vacio.sh'],
  ];
  for (const [nombre, cambio, ruta] of casos) {
    const { c, git } = repoDeControles(t, ['a=1\n']);
    // el archivo vacío entra en un commit propio: repoDeControles usa el contenido como mensaje
    if (nombre === 'borrado de un vacío') { fs.writeFileSync(path.join(c.repo, 'scripts', 'ci', 'vacio.sh'), ''); git('add', 'scripts'); git('commit', '-qm', 'vacío'); }
    const base = git('rev-parse', 'HEAD').stdout.trim();
    cambio(c, git);
    git('commit', '-qm', nombre);
    const q = pideControl(c, base, ruta);
    assert.ok(!q.error, `${nombre}: ${q.error}`);
    // el renombre se ve como el archivo nuevo (git sin detectar renombres): +1; los otros dos suman 0 líneas
    assert.match(q.pregunta, nombre === 'renombre' ? /Qué hace: Cambia 1 archivo\(s\) de control: \+1 −0 líneas\./ : /Qué hace: Cambia 1 archivo\(s\) de control: \+0 −0 líneas\./, nombre);
  }
});

// 🔴 Falla con: que la negativa del cambio vacío alcance a un cambio con líneas.
test('SignatureQuestion_ControlChange_WithLines_AsToday (T47) @fix-T-227 @story-8.235 @ac-3', (t) => {
  const { c, git } = repoDeControles(t, ['a=1\n', 'a=1\nb=2\n']);
  const q = pideControl(c, git('rev-parse', 'HEAD~1').stdout.trim());
  assert.ok(!q.error, q.error);
  assert.match(q.pregunta, /Qué hace: Cambia 1 archivo\(s\) de control: \+1 −0 líneas\./);
});
