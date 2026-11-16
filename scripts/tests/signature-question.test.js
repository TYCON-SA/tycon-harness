'use strict';
/**
 * signature-question.test.js — la pregunta de cada firma dice qué se aprueba (owner-approvals.js `cuadroDe`,
 * owner-window.js `cuadroPara` y signature-sources.js).
 *
 * El caso: la pregunta del plan decía «¿Aprobás aprobar el plan de una story? Detalle: la cita: …» y el dueño no podía
 * decidir con eso. La pregunta empieza con lo que se aprueba, nombra la historia con su título, dice qué
 * hace en dos renglones, cuántos archivos toca y de qué zonas y dónde está lo completo (8.275: se lee en un teléfono), trae el «si sale mal» de esa firma y deja la cita de
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
  // el repo, solo en una carpeta propia: la matriz de criterios revisa los repos vecinos por evidencia de la historia, y
  // suelto en la carpeta temporal de la máquina revisaría miles de carpetas ajenas (unos 15 s por pregunta)
  const repo = path.join(temporal(t, 'sigq-repo-'), 'repo');
  fs.mkdirSync(repo);
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
  const r = cuadro(c, APRUEBA_PLAN, { firma: 'plan-approval' });
  const q = r.pregunta;
  // 8.275: los archivos en cantidad y zonas, «Completo en» en palabras (la ruta, en el detalle); el título, si entra
  const orden = ['¿Aprobar el plan de una story?', 'Historia 9.99', 'sesión ses-a.',
    'Qué hace: Nombra a la coordinadora con un click · Las preguntas de firma dicen qué se aprueba.',
    'Archivos: 2 archivos: 2 de código (owner-window y signatures).', 'Completo en: el plan, en la carpeta de la corrida.', 'Si sale mal: ', 'Cita de la sesión: «pido el click', '(firma plan-approval'];
  const pos = orden.map((p) => posicion(q, p));
  assert.deepStrictEqual(pos, [...pos].sort((a, b) => a - b), `fuera de orden: ${q}`);
  assert.ok(r.detalle.includes(`Completo en: ${f}`), JSON.stringify(r.detalle));
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
  assert.match(q, /Archivos: 2 archivos: 2 de código \(a y b\)\./);
  assert.ok(q.includes('Completo en: el cambio, en un archivo de la corrida.'), q);
  // 8.275: la ruta del diff, en el detalle
  const ruta = (conFirma('control-change')(c, `bash ${CONTROLES} approve --root ${c.repo} --base ${base} --entries '${entries}'`).detalle.find((l) => l.startsWith('Completo en: ')) || '').slice('Completo en: '.length);
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
  // 8.275: la ruta del diff está en el detalle, no en la pregunta
  const diffDe = (q) => fs.readFileSync((q.detalle.find((l) => l.startsWith('Completo en: ')) || '').slice('Completo en: '.length), 'utf8');
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
  // 8.275: «Completo en» en palabras; la ruta, en el detalle
  assert.ok(rw.includes('Completo en: la historia 9.99.'), rw);
  const mt = conFirma('manual-test')(c, `node ${MARKER} mark-tested --acs 2`).pregunta;
  assert.match(mt, /Qué hace: AC 2: .*se ve en la lista/);
  assert.ok(mt.includes('Completo en: la historia 9.99.'), mt);
  // el crítico: sin informe, sin coincidencia, con una y con varias
  const crit = (cmd) => conFirma('critical-waiver')(c, `node ${MARKER} waive-critical ${cmd} --reason "lo cubre otra capa"`).pregunta;
  assert.match(crit('--rule SEC-C1 --file a.js'), /Qué hace: Eximir SEC-C1 en a\.js: no hay informe de hallazgos en esta ejecución\./);
  const informe = path.join(c.runDir, 'findings.json');
  const hallazgo = (n, file) => ({ rule_id: 'SEC-C1', severity: 'CRITICAL', file, summary: `secreto en el código ${n}`, disposition: 'open' });
  fs.writeFileSync(informe, JSON.stringify([hallazgo(1, 'a.js'), ...[2, 3, 4, 5].map((n) => hallazgo(n, 'b.js')), hallazgo(6, undefined)]));
  assert.match(crit('--rule SEC-C9 --file a.js'), /Eximir SEC-C9 en a\.js: no está en el informe de hallazgos\./);
  const una = crit('--rule SEC-C1 --file a.js');
  assert.match(una, /Qué hace: SEC-C1 en a\.js: secreto en el código 1\./);
  assert.ok(una.includes('Completo en: el informe de hallazgos de la corrida.'), una);
  assert.match(crit('--rule SEC-C1 --file b.js'), /secreto en el código 2 · SEC-C1 en b\.js: secreto en el código 3 · y 2 más en el detalle\./);
  // sin --file la exención se anota sin archivo (regla|): sólo exime, y sólo muestra, los hallazgos sin archivo
  const sinArchivo = crit('--rule SEC-C1');
  assert.match(sinArchivo, /Qué hace: SEC-C1: secreto en el código 6\./);
  assert.doesNotMatch(sinArchivo, /a\.js|b\.js/);
  // la vuelta extra: la vuelta, lo abierto del informe y su nota, con ella y sin ella
  const extra = () => conFirma('extra-round')(c, `node ${PIPELINE} smart-reloop --iter 3 --extra-round`).pregunta;
  // 8.275: dos renglones, la vuelta con lo abierto y la nota
  assert.match(extra(), /Qué hace: Vuelta 3 de revisores: Sigue abierto: SEC-C1 en a\.js, bloquea; .* · Sin nota de repensar de la vuelta 3\./);
  assert.ok(extra().includes('Completo en: la carpeta de la corrida.'), extra());
  const nota = path.join(c.runDir, 'rethink', 'iter-3.json');
  fs.mkdirSync(path.dirname(nota), { recursive: true });
  fs.writeFileSync(nota, JSON.stringify({ iter: 3, repeated: 'vuelve el hallazgo del tope', change: 'se parte el archivo en dos' }));
  assert.match(extra(), / · Nota de la vuelta 3: Se repitió: vuelve el hallazgo del tope; Cambia: se parte el archivo en dos\./);
  assert.ok(extra().includes('Completo en: la nota de la vuelta, en la carpeta de la corrida.'), extra());
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
  // 8.275: dos renglones a la vista, y lo demás en el detalle
  assert.match(q, /Qué hace: .* · y 3 más en el detalle\./);
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
  // 8.275: el corte se ve sin «…»
  assert.ok(tl.endsWith('(sigue en el detalle)»?'), tl);
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
  const q = oa.cuadroDe({ firma: 'runtime-waiver', que: ow.queDeLaExcepcion(lista), queHace: lista.map(ow.renglonDeLaExcepcion), archivos: [] });
  const cuadro = q.pregunta;
  // 8.275: dos renglones a la vista, cada uno empieza con su razón; el renglón entero, en el detalle
  for (const n of [1, 2]) assert.ok(cuadro.includes(`AC ${n}: por qué no se prueba en vivo: razón ${n}`), `AC ${n}: ${cuadro}`);
  for (const n of [1, 2, 3]) {
    assert.ok(razon(n).length <= 150, razon(n).length);
    assert.ok(q.detalle.some((l) => l.includes(`AC ${n}: por qué no se prueba en vivo: ${razon(n)}; lo cubre:`)), `AC ${n}: ${JSON.stringify(q.detalle)}`);
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
    // 8.275: las dos faltas juntas en un renglón corto a la vista; cada una entera, en el detalle
    assert.ok(q.includes(texto === SIN_LAS_DOS ? 'al plan le faltan las secciones «## Qué hace» y «## Archivos»: agregalas antes de pedir la firma'
      : 'el plan: su «## Qué hace» tiene 5 líneas (van hasta 3) y le falta «## Archivos»: corregilo antes de pedir la firma'), q);
    const d = cuadro(c, APRUEBA_PLAN, { firma: 'plan-approval' }).detalle;
    for (const e of fuentes.seccionesDelPlan(texto).errores) assert.ok(d.some((l) => l.includes(e)), `falta «${e}» entero en el detalle: ${JSON.stringify(d)}`);
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
  assert.match(crit, /Eximir SEC-C1 en a\.js: no pude leer el informe de hallazgos \(no se entiende.*Completo en: el informe de hallazgos de la corrida\./);
  assert.doesNotMatch(crit, /no hay informe/);
  fs.mkdirSync(path.join(c.runDir, 'rethink'), { recursive: true });
  fs.writeFileSync(path.join(c.runDir, 'rethink', 'iter-2.json'), '{ roto');
  const vuelta = conFirma('extra-round')(c, `node ${PIPELINE} smart-reloop --iter 2 --extra-round`).pregunta;
  assert.match(vuelta, /Vuelta 2 de revisores: No pude leer el informe de hallazgos.* · Nota de la vuelta 2: no se entiende \(.*Completo en: la nota de la vuelta, en la carpeta de la corrida\./);
  // un plan que es una carpeta: está, pero no se puede leer
  fs.mkdirSync(path.join(c.runDir, 'step-02-bmad-plan.md'));
  // 8.275: la carpeta por su nombre (la ruta entera, en el detalle)
  assert.match(cuadro(c, APRUEBA_PLAN, { firma: 'plan-approval' }).pregunta, /no encuentro el plan escrito en step-02-bmad-plan\.md \(no pude leerlo: EISDIR\)/);
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
  // 8.275: el título si entra en el tope; «Completo en» en palabras, con la ruta en el detalle
  assert.match(q, /Historia 8\.205(, «El click del dueño vale en sesiones sin foto»)?, sesión ses-a\./);
  assert.match(q, /Qué hace: Nombra a la coordinadora con un click/);
  assert.ok(q.includes('Completo en: el plan, en la carpeta de la corrida.'), q);
  assert.ok(cuadro(c, `node ${MARKER} complete-step approve-plan --approved "pido el click del dueño para el plan de la opción A"`, { firma: 'plan-approval' }).detalle.includes(`Completo en: ${f}`));
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
  // 8.275: el corte dice «(sigue en el detalle)»; los archivos, en cantidad y zonas
  assert.match(q, /Qué hace: x+ \(sigue en el detalle\)\./);
  assert.ok(!q.includes('…'), q);
  assert.ok(q.includes('Archivos: 14 archivos: 14 de código (raíz).'), q);
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

// ── el cuadro de un cambio de control: lo que se ve es lo que se aprueba ─────────────────────────────────────────────

/** Un repo con `rutas` como archivos de control: una base y un commit que los cambia a todos. */
// `fijas`: archivos que están desde la base y no cambian. `config`: claves de git del repo, puestas antes del primer commit
function repoConArchivos(t, rutas, { fijas = [], config = [] } = {}) {
  const c = corrida(t);
  const fecha = '2026-11-04T12:00:00Z';
  const git = (...a) => spawnSync('git', ['-C', c.repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'maintenance.auto=false', ...a],
    { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha } });
  const escribir = (texto, lista = rutas) => { for (const r of lista) { fs.mkdirSync(path.dirname(path.join(c.repo, r)), { recursive: true }); fs.writeFileSync(path.join(c.repo, r), texto); } };
  git('init', '-q');
  for (const [k, v] of config) git('config', k, v);
  escribir('a=1\n'); escribir('fija\n', fijas); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  escribir('a=1\nb=2\n'); git('add', '.'); git('commit', '-qm', 'cambio');
  const entradas = (lista = rutas) => JSON.stringify(lista.map((p) => ({ path: p, blob: git('rev-parse', `HEAD:${p}`).stdout.trim() })));
  const comando = (lista, extra = '') => `bash ${CONTROLES} approve --root ${c.repo} --base ${base}${extra} --entries '${lista}'`;
  return { c, git, base, entradas, comando };
}
const archivosDe = (q) => (q.match(/Archivos: ([^]*?)\. (?:Completo en|Si sale mal)/) || [])[1];

// 🔴 Falla con: un cuadro que no nombra todas las rutas que se firman, o que no dice cuántas son.
test('8.176-Cuadro_NombraTodasLasRutas (T1) @story-8.176 @ac-1', (t) => {
  // 8.275 (D1, reemplaza este AC): el cuadro cuenta los archivos y dice sus zonas; ninguna ruta, ni en el detalle
  const rutas = ['scripts/ci/a.sh', 'scripts/ci/b.sh', 'scripts/lib/c.js'];
  const { c, entradas, comando } = repoConArchivos(t, rutas);
  const r = conFirma('control-change')(c, comando(entradas()));
  assert.match(r.pregunta, /Qué hace: Cambia 3 archivo\(s\) de control: \+3 −0 líneas\./);
  assert.strictEqual(archivosDe(r.pregunta), '3 archivos: 3 de código (a, b y c)', r.pregunta);
  for (const x of rutas) assert.ok(!r.pregunta.includes(x) && !r.detalle.some((l) => l.includes(x)), x);
  const uno = conFirma('control-change')(c, `bash ${CONTROLES} approve --root ${c.repo} --file scripts/ci/b.sh --rev HEAD`);
  assert.match(uno.pregunta, /Qué hace: Cambia 1 archivo\(s\) de control: \+1 −0 líneas\./);
  assert.strictEqual(archivosDe(uno.pregunta), '1 archivo: de código (b)', uno.pregunta);
  assert.ok(!uno.detalle.some((l) => l.includes('scripts/ci/b.sh')), JSON.stringify(uno.detalle));
});

// 🔴 Falla con: una ruta cortada con «…» en el cuadro, o un conteo que no cuenta todos los archivos.
test('8.176-Cuadro_MuchasRutas_NingunaCortada (T2) @story-8.176 @ac-2', (t) => {
  const cortas = Array.from({ length: 12 }, (_, i) => `scripts/ci/c${String(i).padStart(2, '0')}.sh`);
  const largas = [`scripts/ci/${'x'.repeat(120)}/${'y'.repeat(100)}.sh`, `scripts/lib/${'z'.repeat(110)}/${'w'.repeat(110)}.js`];
  const rutas = [...cortas.slice(0, 5), largas[0], ...cortas.slice(5), largas[1]];
  const { c, entradas, comando } = repoConArchivos(t, rutas);
  const q = conFirma('control-change')(c, comando(entradas())).pregunta;
  const vistos = archivosDe(q);
  assert.ok(vistos && !q.includes('…'), q);
  assert.ok(vistos.startsWith('14 archivos: 14 de código ('), q);
  // sin --base, «Completo en» dice el repo por su nombre
  const sinBase = conFirma('control-change')(c, `bash ${CONTROLES} approve --root ${c.repo} --entries '${entradas()}'`);
  assert.ok(!sinBase.pregunta.includes('…'), sinBase.pregunta);
  assert.ok(sinBase.pregunta.includes(`Completo en: el repo ${path.basename(c.repo)}.`), sinBase.pregunta);
  assert.ok(sinBase.detalle.includes(`Completo en: ${c.repo}`), JSON.stringify(sinBase.detalle));
  // el plan usa el mismo cuadro: cuenta todos, también los de rutas largas
  const plan = oa.cuadroDe({ firma: 'plan-approval', destino: 'ses-a', que: 'aprobar el plan', queHace: ['uno'], archivos: ['scripts/a.js', largas[0], 'scripts/b.js'], siSaleMal: 'se revierte', huella: 'ab12cd34' }).pregunta;
  // un nombre de más de 40 letras no se nombra: se cuenta
  assert.ok(plan.includes('Archivos: 3 archivos: 3 de código (scripts y 1 carpeta más).'), plan);
  // «Completo en» sin palabras: el nombre del archivo, recortado sin «…»
  const completoLargo = oa.cuadroDe({ firma: 'plan-approval', destino: 'ses-a', que: 'aprobar el plan', queHace: ['uno'], completo: `/r/${'c'.repeat(400)}`, siSaleMal: 'se revierte', huella: 'ab12cd34' }).pregunta;
  assert.ok(!completoLargo.includes('…'), completoLargo);
  assert.match(completoLargo, /Completo en: c+ \(sigue en el detalle\)\./);
});

// 🔴 Falla con: un cuadro que cambia según quién lo pide, desde dónde o cuándo: el click de la coordinadora no valdría
//    para el comando que corre la sesión.
test('8.176-Cuadro_MismoComandoMismaPregunta (T3) @story-8.176 @ac-3', (t) => {
  const { c, entradas, comando } = repoConArchivos(t, ['scripts/ci/a.sh', 'scripts/ci/b.sh']);
  const desde = (cmd, sesion, cwd) => ow.cuadroPara({ firma: 'control-change', comando: cmd, palabras: ow.canonica(cmd), destino: 'ses-a', sesion, cwd, casa: c.casa });
  const propia = desde(comando(entradas()), 'ses-a', c.repo);
  const ajena = desde(comando(entradas(), ' --for-session ses-a'), 'ses-coord', os.tmpdir());
  const despues = desde(comando(entradas()), 'ses-a', c.repo);
  assert.ok(propia.pregunta, propia.error);
  assert.strictEqual(ajena.pregunta, propia.pregunta);
  assert.strictEqual(ajena.sello, propia.sello);
  assert.strictEqual(despues.pregunta, propia.pregunta);
});

// ── el click de la persona, de punta a punta ─────────────────────────────────────────────────────────────────────────

const AHORA = Date.parse('2026-11-07T21:00:00Z');
const INICIO = 'Sat Nov  7 18:00:00 2026';
const HERRAMIENTA = { pid: 100, ppid: 1, inicio: INICIO, comando: '/Applications/x/native-binary/claude --output-format stream-json --verbose' };
const ARRANQUE = [{ pid: 1, ppid: 0, inicio: 'Sat Nov  7 08:00:00 2026', comando: '/sbin/launchd' }];
const arbolDelFreno = () => [...ARRANQUE, HERRAMIENTA,
  { pid: 200, ppid: 100, inicio: INICIO, comando: '/bin/bash /h/scripts/hooks/safety-guard-pre.sh' },
  { pid: 201, ppid: 200, inicio: INICIO, comando: 'node /h/scripts/lib/owner-window.js gate' }];
// la consola con la envoltura medida de la herramienta (owner-window.test.js `envolver`), y el guion
const arbolDelGuion = (casa, cmd) => [...ARRANQUE, HERRAMIENTA,
  { pid: 300, ppid: 100, inicio: INICIO, comando: `/bin/zsh -c source ${casa}/.claude/shell-snapshots/snapshot-zsh-1793030721191-z5n7vi.sh 2>/dev/null || true`
    + ' && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true'
    + " && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true"
    + ` && eval '${cmd.replace(/'/g, `'"'"'`)}' < /dev/null && pwd -P >| /tmp/claude-b725-cwd` },
  { pid: 301, ppid: 300, inicio: INICIO, comando: cmd }];
const { APPROVERS } = require('../lib/approver.js');
const DS = require('../lib/delegated-signing.js');
const HUELLA = 'a1b2c3d4e5f60718';
const PERFIL = { relay_session: 'coordinadora', delegated_signing: ['plan-approval', 'extra-round', 'refresh-after-main'], owner_only: ['control-change'], delegated_machines: [{ id: HUELLA, label: 'Mac de prueba' }] };
const delegacionReal = (o) => DS.delegaSinVentana({ ...o, perfil: () => PERFIL, huella: () => ({ huella: HUELLA }) });
// el click lo valida el gancho de la herramienta; acá, la aprobación anotada y su búsqueda de verdad
const aprobaciones = { buscar: (o) => oa.buscar({ ...o, validar: () => ({ ok: true }) }), consumir: oa.consumir, devolver: oa.devolver, coordinadoraConfirmada: () => null };
const pedirControl = (c, cmd, { sesion = 'ses-coord', modo, comprobar = () => null } = {}) => ow.decidir({
  evento: { session_id: sesion, tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, cwd: c.repo, ...(modo ? { permission_mode: modo } : {}) },
  escapes: [], arbol: arbolDelFreno(), pid: 201, casa: c.casa, ahora: AHORA, delegacion: delegacionReal, clasificar: () => null,
  ...(comprobar ? { comprobar } : {}), aprobador: () => APPROVERS.maintainers, aprobaciones });
const anotarClick = (c, sesion) => oa.anotar(c.casa, { tipo: 'click', sesion, ts: new Date(AHORA - 60000).toISOString(), tool_use_id: 'toolu_1', herramienta: { pid: 100, inicio: INICIO } });

// 🔴 Falla con: un cambio de control firmado por delegación, o sin el click de la persona; o un click que el registro
//    anota como de otra vía.
test('8.176-Coordinadora_SinClickNoFirma_ConClickEsDeLaPersona (T7) @story-8.176 @ac-6', (t) => {
  const { c, entradas, comando } = repoConArchivos(t, ['scripts/ci/a.sh']);
  const cmd = comando(entradas(), ' --for-session ses-a');
  const argv = ow.canonica(cmd);
  // en una pestaña común la firma va a la ventana de permiso, como siempre (en otra casa: deja su pedido vigente)
  const comun = repoConArchivos(t, ['scripts/ci/a.sh']);
  assert.strictEqual(pedirControl(comun.c, comun.comando(comun.entradas(), ' --for-session ses-a')).decision, 'ask');
  // sin permisos o de fondo, que es donde se lee el click: sin él no firma, ni por la delegación (owner_only)
  const sinClick = pedirControl(c, cmd, { modo: 'bypassPermissions' });
  assert.strictEqual(sinClick.decision, 'deny', sinClick.texto);
  assert.notStrictEqual(sinClick.via, 'delegacion');
  assert.strictEqual(ow.exigir({ firma: 'control-change', argv, pid: 301, arbol: arbolDelGuion(c.casa, cmd), casa: c.casa, ahora: AHORA + 60000, propia: 'ses-coord' }).codigo, 1);
  // con el click de la persona en esa pestaña: es suyo, y el registro lo dice
  anotarClick(c, 'ses-coord');
  const conClick = pedirControl(c, cmd, { modo: 'bypassPermissions' });
  assert.deepStrictEqual([conClick.decision, conClick.via], ['allow', 'click'], conClick.texto);
  const e = ow.exigir({ firma: 'control-change', argv, pid: 301, arbol: arbolDelGuion(c.casa, cmd), casa: c.casa, ahora: AHORA + 60000, propia: 'ses-coord' });
  assert.strictEqual(e.codigo, 0, e.motivo);
  assert.strictEqual(e.via, 'click');
  const firmado = fs.readFileSync(path.join(c.estado, 'gates.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((x) => x.name === 'control-change-signed');
  assert.deepStrictEqual(firmado.map((x) => x.via), ['click']);
  // la constancia que escribe el guion con esa firma es del dueño, sin vía
  assert.strictEqual(DS.signerOf(e), 'dueño');
});

// ── sin cuadro: una ruta que falsea lo que se ve ─────────────────────────────────────────────────────────────────────

// 🔴 Falla con: un cuadro armado con rutas que se ven distintas de las que se firman («, y 0 más» parece el fin de la
//    lista), o el «el comando: …» cortado cuando --entries no se lee; o una negativa que ofrece firmar igual.
test('8.176-Cuadro_RutaQueFalsea_SinCuadro (T10) @story-8.176 @ac-9', (t) => {
  const { c, base, entradas } = repoConArchivos(t, ['scripts/ci/a.sh']);
  const buena = JSON.parse(entradas())[0];
  const conRuta = (p) => JSON.stringify([{ path: p, blob: buena.blob }]);
  const con = (n) => `scripts/ci/a${String.fromCodePoint(n)}b.sh`;
  const casos = [
    ['coma', conRuta('scripts/ci/a.sh, y 0 más'), /«, »/],
    ['de dirección', conRuta(con(0x202e)), /uno que no se ve/],
    ['de ancho cero', conRuta(con(0x200b)), /uno que no se ve/],
    ['guion blando', conRuta(con(0x00ad)), /uno que no se ve/],
    ['marca de orden', conRuta(con(0xfeff)), /uno que no se ve/],
    ['relleno', conRuta(con(0x3164)), /uno que no se ve/],
    ['braille en blanco', conRuta(con(0x2800)), /uno que no se ve/],
    ['selector de variante', conRuta(con(0xfe0f)), /uno que no se ve/],
    ['carpeta', JSON.stringify([{ path: 'scripts/ci', blob: buena.blob }]), /alguna de sus rutas es una carpeta/],
    ['comodín', JSON.stringify([{ path: 'scripts/ci/*', blob: buena.blob }]), /está vacío/],
    ['ruta mágica de git', JSON.stringify([{ path: ':(glob)scripts/**', blob: buena.blob }]), /está vacío/],
    ['salto de línea', conRuta('scripts/ci/a.sh\nscripts/ci/otra.sh'), /salto de línea, un carácter de control o uno que no se ve/],
    ['carácter de control', conRuta('scripts/ci/a\u001b[2K.sh'), /salto de línea, un carácter de control o uno que no se ve/],
    ['separador de renglón', conRuta('scripts/ci/a .sh'), /salto de línea, un carácter de control o uno que no se ve/],
    ['espacios seguidos', conRuta('scripts/ci/a  b.sh'), /espacios/],
    ['espacio en la punta', conRuta(' scripts/ci/a.sh'), /espacios/],
    ['espacio que no es el común', conRuta('scripts/ci/a b.sh'), /espacios/],
    ['repetida', JSON.stringify([buena, buena]), /dos veces/],
    ['sin ruta', JSON.stringify([buena, { blob: buena.blob }]), /no trae ruta/],
    ['JSON roto', '[{"path":"scripts/ci/a.sh",', /no es JSON/],
    ['no es una lista', JSON.stringify(buena), /no es una lista/],
    ['lista vacía', '[]', /no es una lista/],
  ];
  for (const [nombre, lista, motivo] of casos) {
    const cmd = `bash ${CONTROLES} approve --root ${c.repo} --base ${base} --entries '${lista.replace(/'/g, "'\\''")}'`;
    const q = conFirma('control-change')(c, cmd);
    assert.ok(!q.pregunta, `${nombre}: armó el cuadro: ${q.pregunta}`);
    assert.match(String(q.error), motivo, nombre);
    assert.doesNotMatch(String(q.error), /el comando:/, nombre);
    // la negativa dice el motivo y la salida por pending, sin cuadro ni el --entries pedido; de fondo, con la
    // coordinadora y sin ella
    for (const [como, r] of [['en la pestaña', ow.negarSinVentana(`sin ventana; ${q.error}`, ['control-change'], 'ses-a', q)],
      ['de fondo', ow.negarSinVentana(`de fondo; ${q.error}`, ['control-change'], 'ses-a', q, true)],
      ['con la coordinadora', ow.negarSinVentana(`de fondo; ${q.error}`, ['control-change'], 'ses-a', q, true, false, { name: 'Coordinadora', sid: 'ses-coord' })]]) {
      assert.strictEqual(r.decision, 'deny', `${nombre} ${como}`);
      assert.ok(!r.cuadro, `${nombre} ${como}: dio el cuadro`);
      assert.ok(r.texto.includes(q.error), `${nombre} ${como}: ${r.texto}`);
      assert.match(r.texto, /run-base-controls\.sh pending --root /, `${nombre} ${como}: ${r.texto}`);
      assert.ok(!r.texto.includes(lista), `${nombre} ${como}: ofrece el mismo --entries`);
      assert.doesNotMatch(r.texto, /--terminal|AskUserQuestion|SendMessage/, `${nombre} ${como}: ${r.texto}`);
    }
  }
  // con --file, y con las opciones del guion pegadas a su valor, que el guion no lee: la pregunta mostraría otra cosa
  const otros = [
    ['--file vacío', `bash ${CONTROLES} approve --root ${c.repo} --file '' --rev HEAD`, /--file no dice qué archivo/],
    ['--file con coma', `bash ${CONTROLES} approve --root ${c.repo} --file 'scripts/ci/a.sh, y 0 más' --rev HEAD`, /«, »/],
    ['--file que es otra opción', `bash ${CONTROLES} approve --root ${c.repo} --file --rev HEAD`, /--file no dice qué archivo/],
    ['--file que no se ve', `bash ${CONTROLES} approve --root ${c.repo} --file '${con(0x200b)}' --rev HEAD`, /uno que no se ve/],
    ['--file con espacios seguidos', `bash ${CONTROLES} approve --root ${c.repo} --file 'scripts/ci/a  b.sh' --rev HEAD`, /espacios/],
    ['--file carpeta', `bash ${CONTROLES} approve --root ${c.repo} --file scripts/ci --rev HEAD`, /alguna de sus rutas es una carpeta/],
    ['--entries pegada', `bash ${CONTROLES} approve --root ${c.repo} --file scripts/ci/a.sh --entries='${conRuta('scripts/ci/otra.sh')}'`, /--entries=… no lo lee el guion/],
    ['--root pegada', `bash ${CONTROLES} approve --root=${c.repo} --base ${base} --entries '${entradas()}'`, /--root=… no lo lee el guion/],
    ['--base pegada', `bash ${CONTROLES} approve --root ${c.repo} --base=${base} --entries '${entradas()}'`, /--base=… no lo lee el guion/],
    ['--file pegada', `bash ${CONTROLES} approve --root ${c.repo} --file=scripts/ci/a.sh --rev HEAD`, /--file=… no lo lee el guion/],
    ['--rev pegada', `bash ${CONTROLES} approve --root ${c.repo} --file scripts/ci/a.sh --rev=HEAD`, /--rev=… no lo lee el guion/],
    ['--out pegada', `bash ${CONTROLES} approve --root ${c.repo} --base ${base} --out=.tycon/x.jsonl --entries '${entradas()}'`, /--out=… no lo lee el guion/],
  ];
  for (const [nombre, cmd, motivo] of otros) {
    const q = conFirma('control-change')(c, cmd);
    assert.ok(!q.pregunta, `${nombre}: armó el cuadro: ${q.pregunta}`);
    assert.match(String(q.error), motivo, nombre);
  }
  // la refirma tras traer main comparte el cuadro, y su negativa también manda a pending
  const refirma = conFirma('refresh-after-main')(c, `bash ${CONTROLES} approve --root ${c.repo} --base ${base} --entries '[]'`);
  const r = ow.negarSinVentana(`de fondo; ${refirma.error}`, ['refresh-after-main'], 'ses-a', refirma, true);
  assert.strictEqual(r.decision, 'deny', r.texto);
  assert.ok(!r.cuadro, r.texto);
  assert.match(r.texto, /no es una lista.*run-base-controls\.sh pending --root /, r.texto);
  // en la ventana de permiso, el cuadro se mira antes que el chequeo del guion, que diría otra cosa («--entries no es
  // JSON») sin la salida por pending
  const roto = `bash ${CONTROLES} approve --root ${c.repo} --base ${base} --entries '[{"path":"scripts/ci/a.sh",'`;
  const antes = pedirControl(c, roto, { sesion: 'ses-a', comprobar: () => assert.fail('el chequeo del guion corrió antes que el cuadro') });
  assert.strictEqual(antes.decision, 'deny', antes.texto);
  assert.match(antes.texto, /no es JSON.*run-base-controls\.sh pending --root /, antes.texto);
  const deVerdad = pedirControl(c, roto, { sesion: 'ses-a', comprobar: null });
  assert.strictEqual(deVerdad.decision, 'deny', deVerdad.texto);
  assert.doesNotMatch(deVerdad.texto, /No abrí la ventana/, deVerdad.texto);
  assert.match(deVerdad.texto, /run-base-controls\.sh pending --root /, deVerdad.texto);
});

// 🔴 Mutaciones: mostrar sólo la nota de repensar (T8), tomar la nota de otra vuelta como la pedida o decir «nada
// abierto» cuando el informe no se lee (T9), un sello que no cambia cuando cambia lo abierto (T8).
const VUELTA_4 = `node ${PIPELINE} smart-reloop --iter 4 --extra-round`;
test('SignatureQuestion_ExtraRound_NamesRoundOpenAndItsNote (T8) @story-8.267 @ac-7', (t) => {
  const c = corrida(t);
  const informe = path.join(c.runDir, 'findings.json');
  fs.writeFileSync(informe, JSON.stringify([
    { rule_id: 'SEC-C1', severity: 'CRITICAL', file: 'a.js', summary: 'secreto', disposition: 'open' },
    { rule_id: 'TEST-W2', severity: 'WARNING', file: 'b.js', summary: 'falta una prueba', disposition: 'open' },
    { rule_id: 'SEC-C2', severity: 'CRITICAL', file: 'c.js', summary: 'arreglado', disposition: 'fixed' },
  ]));
  const nota = path.join(c.runDir, 'rethink', 'iter-4.json');
  fs.mkdirSync(path.dirname(nota), { recursive: true });
  fs.writeFileSync(nota, JSON.stringify({ iter: 4, repeated: 'vuelve el mismo hallazgo', change: 'se parte el archivo', story_change: 'ninguno' }));
  const q = conFirma('extra-round')(c, VUELTA_4);
  const queHace = (q.pregunta.match(/Qué hace: ([^]*?)\. (?:Archivos|Completo en)/) || [])[1] || '';
  // 8.275: dos renglones, la vuelta con lo abierto, y la nota
  const [vuelta, deLaNota] = queHace.split(' · ');
  // un tramo por hallazgo abierto, en un renglón: la nota tiene que entrar
  assert.strictEqual(vuelta, 'Vuelta 4 de revisores: Sigue abierto: SEC-C1 en a.js, bloquea; TEST-W2 en b.js, no bloquea', q.pregunta);
  assert.strictEqual(deLaNota, 'Nota de la vuelta 4: Se repitió: vuelve el mismo hallazgo; Cambia: se parte el archivo; Cambia la historia: ninguno', q.pregunta);
  assert.doesNotMatch(queHace, /c\.js/, 'lo arreglado no sigue abierto');
  // lo abierto va en la fuente: si cambia después del cuadro, el sello cambia y el click no vale
  fs.writeFileSync(informe, JSON.stringify([{ rule_id: 'SEC-C1', severity: 'CRITICAL', file: 'a.js', summary: 'secreto', disposition: 'fixed' }]));
  const despues = conFirma('extra-round')(c, VUELTA_4);
  assert.notStrictEqual(despues.sello, q.sello, 'cambió lo abierto y el sello no');
  assert.match(despues.pregunta, /Qué hace: Vuelta 4 de revisores: Nada abierto en el informe de hallazgos · Nota de la vuelta 4/);
  // sin --iter válido, el renglón de hoy
  assert.match(conFirma('extra-round')(c, `node ${PIPELINE} smart-reloop --extra-round`).pregunta, /Qué hace: Una vuelta más de revisores sobre lo que quedó abierto\./);
});

test('SignatureQuestion_ExtraRound_OtherRoundNote_NotShown (T9) @story-8.267 @ac-7', (t) => {
  const c = corrida(t);
  fs.mkdirSync(path.join(c.runDir, 'rethink'), { recursive: true });
  fs.writeFileSync(path.join(c.runDir, 'rethink', 'iter-3.json'), JSON.stringify({ iter: 3, repeated: 'la nota de la tres', change: 'algo' }));
  fs.writeFileSync(path.join(c.runDir, 'findings.json'), '{ roto');
  const r = conFirma('extra-round')(c, VUELTA_4);
  const q = r.pregunta;
  assert.match(q, /Sin nota de repensar de la vuelta 4/);
  assert.doesNotMatch(q, /la nota de la tres/, 'mostró la nota de otra vuelta');
  // 8.275: el renglón se corta en la oración; entero, en el detalle
  assert.match(r.pregunta, /No pude leer el informe de hallazgos/);
  assert.ok(r.detalle.some((l) => l.includes('No pude leer el informe de hallazgos: findings.json no se lee')), JSON.stringify(r.detalle));
  assert.doesNotMatch(q, /Nada abierto/, '«no pude leer» no es «nada abierto»');
});

// 🔴 Mutaciones: mostrar una nota que existe y no se lee como «sin nota», o una carpeta que no se ubica como «no hay
// informe»: las dos callan un error.
test('SignatureQuestion_ExtraRound_UnreadableNoteAndNoRunDir_SaySo (T9) @story-8.267 @ac-7', (t) => {
  const c = corrida(t);
  const nota = path.join(c.runDir, 'rethink', 'iter-4.json');
  fs.mkdirSync(path.dirname(nota), { recursive: true });
  fs.writeFileSync(nota, JSON.stringify({ iter: 4, repeated: 'x', change: 'y' }));
  fs.chmodSync(nota, 0o000);
  t.after(() => { try { fs.chmodSync(nota, 0o644); } catch (_) { /* ya se borró */ } });
  let legible = true;
  try { fs.readFileSync(nota); } catch (_) { legible = false; }
  if (!legible) {
    const q = conFirma('extra-round')(c, VUELTA_4).pregunta;
    assert.match(q, /No pude leer la nota de repensar de la vuelta 4/);
    assert.doesNotMatch(q, /Sin nota de repensar/);
  }
  const sinCarpeta = fuentes.abiertoDeLaCorrida(null);
  assert.match(sinCarpeta.linea, /No pude ubicar la carpeta de la ejecución/);
  assert.doesNotMatch(sinCarpeta.linea, /No hay informe/);
});

// ── los invisibles que faltaban y la cuenta de lo que cambió ────────────────────────────────────────────────────────

// 🔴 Falla con: una ruta con un carácter de uso privado o una marca de acento sin letra base arma el cuadro (se ve otra
//    cosa que lo que se firma), o el motivo la nombra con el carácter crudo; o una tilde compuesta deja sin cuadro.
test('Cuadro_UsoPrivadoYMarcaSuelta_NoSeVen_TildesSi (T15) @story-8.282 @ac-20 @ac-21 @ac-23 @ac-29', (t) => {
  const { c, base, entradas } = repoConArchivos(t, ['scripts/ci/a.sh']);
  const buena = JSON.parse(entradas())[0];
  const conRuta = (p) => JSON.stringify([{ path: p, blob: buena.blob }]);
  const porEntries = (p) => `bash ${CONTROLES} approve --root ${c.repo} --base ${base} --entries '${conRuta(p)}'`;
  const porFile = (p) => `bash ${CONTROLES} approve --root ${c.repo} --file '${p}' --rev HEAD`;
  const casos = [
    ['uso privado', 'scripts/ci/a\u{e000}.sh', '\\u{e000}', [porEntries, porFile]],
    ['marca suelta al principio', '́scripts/ci/a.sh', '\\u{301}', [porEntries, porFile]],
    ['marca suelta después de /', 'scripts/ci/́a.sh', '\\u{301}', [porEntries, porFile]],
    ['secuencia de terminal', 'scripts/ci/a\u001b[2K.sh', '\\u001b', [porFile]],
    // por --file, un salto parte el comando en dos y no llega a esta fuente: se prueba por --entries
    ['salto de línea', 'scripts/ci/a.sh\nscripts/ci/otra.sh', '\\n', [porEntries]],
    ['de dirección', 'scripts/ci/a‮b.sh', '\\u{202e}', [porFile]],
    // detrás de un control que el motivo escribe con letras (\n, \t, \u001b), la marca sigue siendo suelta
    ['marca suelta después de un salto', 'scripts/ci/a\ńb.sh', '\\n\\u{301}', [porEntries]],
    ['marca suelta después de un tabulador', 'scripts/ci/a\t́b.sh', '\\t\\u{301}', [porEntries]],
    ['marca suelta después de un control', 'scripts/ci/a\u001b́b.sh', '\\u001b\\u{301}', [porEntries]],
  ];
  for (const [nombre, ruta, escrito, formas] of casos) {
    for (const forma of formas) {
      const q = conFirma('control-change')(c, forma(ruta));
      assert.ok(!q.pregunta, `${nombre}: armó el cuadro: ${q.pregunta}`);
      assert.match(String(q.error), /uno que no se ve/, nombre);
      assert.ok(String(q.error).includes(escrito), `${nombre}: el motivo no lo escribe como código: ${q.error}`);
      assert.ok(!String(q.error).includes(ruta), `${nombre}: el motivo trae la ruta cruda`);
    }
  }
  // una letra con su marca es una tilde compuesta: se ve, y el cuadro se arma (git sin normalizar el nombre, como en
  // Linux y Windows)
  const tilde = 'scripts/ci/cámara.sh';
  const conTilde = repoConArchivos(t, [tilde], { config: [['core.precomposeunicode', 'false']] });
  const q = conFirma('control-change')(conTilde.c, conTilde.comando(conTilde.entradas())).pregunta;
  assert.ok(q, 'la tilde compuesta no dio cuadro');
  assert.match(q, /Qué hace: Cambia 1 archivo\(s\) de control: \+1 −0 líneas\./);
  // sin invisibles, el cuadro de siempre
  const comun = conFirma('control-change')(c, `bash ${CONTROLES} approve --root ${c.repo} --base ${base} --entries '${entradas()}'`).pregunta;
  // 8.275: el archivo en su zona, no su ruta
  assert.match(comun, /Qué hace: Cambia 1 archivo\(s\) de control: \+1 −0 líneas\. Archivos: 1 archivo: de código \(a\)\./);
});

// 🔴 Falla con: «Cambia 5» cuando de las 5 rutas pedidas sólo 2 tienen cambio: el dueño cree que firma cinco cambios.
test('Cuadro_CambiaN_CuentaLasQueCambiaron (T16) @story-8.282 @ac-22 @ac-29', (t) => {
  const cambian = ['scripts/ci/a.sh', 'scripts/ci/b.sh'];
  const fijas = ['scripts/ci/c.sh', 'scripts/ci/d.sh', 'scripts/ci/e.sh'];
  const { c, entradas, comando } = repoConArchivos(t, cambian, { fijas });
  const q = conFirma('control-change')(c, comando(entradas([...cambian, ...fijas]))).pregunta;
  assert.match(q, /Qué hace: Cambia 2 de 5 archivo\(s\) de control pedidos: \+2 −0 líneas\./);
  // sin base, o si git no puede leer la base, no hay «Cambia»: el texto de siempre
  const cinco = entradas([...cambian, ...fijas]);
  const sinBase = conFirma('control-change')(c, `bash ${CONTROLES} approve --root ${c.repo} --entries '${cinco}'`).pregunta;
  assert.match(sinBase, /Qué hace: Firma 5 archivo\(s\) de control en su versión de la punta \(sin base para comparar\)\./);
  const baseRota = conFirma('control-change')(c, `bash ${CONTROLES} approve --root ${c.repo} --base ${'0'.repeat(40)} --entries '${cinco}'`).pregunta;
  assert.match(baseRota, /Qué hace: no pude leer el cambio de 5 archivo\(s\) de control: /);
  // con todo lo pedido cambiado, el texto de hoy
  const todas = repoConArchivos(t, ['scripts/ci/a.sh', 'scripts/ci/b.sh', 'scripts/lib/c.js']);
  const igual = conFirma('control-change')(todas.c, todas.comando(todas.entradas())).pregunta;
  assert.match(igual, /Qué hace: Cambia 3 archivo\(s\) de control: \+3 −0 líneas\./);
});

// ── 8.275: el cuadro se lee en un celular ────────────────────────────────────────────────────────────────────────────

// una palabra que empieza como ruta absoluta (la carpeta de la casa, `~/` o una unidad de Windows)
const RUTA_ABSOLUTA = /(^|[\s«(["'`])(\/|~\/|[A-Za-z]:[\\/])/;
const sinSello = (q) => q.pregunta.slice(0, q.pregunta.length - q.sello.length - 3);
const queHaceDe = (q) => (q.pregunta.match(/Qué hace: ([^]*?)\. (?:Archivos|Completo en|Revisión|Si sale mal)/) || [])[1] || '';
const enElDetalle = (q, prefijo) => (q.detalle || []).find((l) => l.startsWith(prefijo));
const largas = (n, letra = 'palabra') => Array.from({ length: n }, (_, k) => `Renglón ${k + 1}: ${`${letra} `.repeat(40)}`.slice(0, 200));

// 🔴 Falla con: un «Qué hace» de tres renglones de 200 en el cuadro, cortado con «…» a mitad de palabra.
test('SignatureQuestion_WhatItDoes_TwoLinesCutAtSentence (T4) @story-8.275 @ac-1 @ac-9', () => {
  const lineas = ['Primera oración corta. Segunda oración que sigue y sigue con muchas palabras para pasar el largo del renglón del cuadro sin terminar nunca la idea completa que tenía',
    ...largas(2)];
  const q = oa.cuadroDe({ firma: 'save', destino: 'ses-a', que: 'guardar', queHace: lineas, siSaleMal: 'se revierte', huella: 'ab12cd34' });
  const qh = queHaceDe(q);
  const renglones = qh.split(' · ');
  assert.strictEqual(renglones.length, 3, qh);
  // el primero corta en la oración que entra; el segundo, en la última palabra entera
  assert.strictEqual(renglones[0], 'Primera oración corta (sigue en el detalle)');
  assert.ok(renglones[1].length <= 140 && renglones[1].endsWith(' (sigue en el detalle)') && renglones[1].startsWith('Renglón 1: palabra'), renglones[1]);
  assert.match(renglones[1], /palabra \(sigue en el detalle\)$/);
  assert.strictEqual(renglones[2], 'y 1 más en el detalle');
  assert.ok(!q.pregunta.includes('…'), q.pregunta);
  for (const l of lineas) assert.ok(q.detalle.some((d) => d.includes(l)), `el detalle no trae entero: ${l}`);
});

test('SignatureQuestion_GuardadoAjeno_NotCut (T4) @story-8.275 @ac-1', () => {
  const lineas = largas(4).map((l) => `${l} /r/repo/archivo.js`);
  const q = oa.cuadroDe({ firma: 'adhoc-lane:guardado-ajeno', destino: 'ses-a', que: 'dejar pasar un guardado ajeno', queHace: lineas, todoQueHace: true, siSaleMal: 'se revierte', huella: 'ab12cd34' });
  assert.ok(q.pregunta.includes(`Qué hace: ${lineas.join(' · ')}.`), q.pregunta);
});

// 🔴 Falla con: «el comando: node /Users/<persona>/…/marker.js …» en una firma sin fuente, cortado con «…».
test('SignatureQuestion_NoSourceFirma_CatalogLineAndShortCommand (T5) @story-8.275 @ac-2 @ac-7 @ac-9', (t) => {
  const c = corrida(t);
  const lejos = `/Users/x/${'carpeta/'.repeat(30)}`;
  const perdida = conFirma('lost-run')(c, `node ${MARKER} clear-session ses-b --lost --repo ${lejos}repo`);
  const qh = queHaceDe(perdida);
  assert.ok(qh.startsWith(sig.SIGNATURES.find((s) => s.id === 'lost-run').approves), qh);
  assert.match(qh, /el comando: marker\.js clear-session ses-b --lost --repo repo/);
  assert.doesNotMatch(sinSello(perdida), RUTA_ABSOLUTA);
  assert.ok(!perdida.pregunta.includes('…'), perdida.pregunta);
  assert.ok(enElDetalle(perdida, 'El comando:').includes(`${lejos}repo`), JSON.stringify(perdida.detalle));
  const escape = ow.cuadroPara({ firma: 'escape:TYCON_SAFETY_OFF', comando: `TYCON_SAFETY_OFF=1 rm -rf ${lejos}x`, palabras: null, destino: 'ses-a', sesion: 'ses-a', cwd: c.repo, casa: c.casa });
  assert.ok(escape.pregunta, escape.error);
  assert.doesNotMatch(sinSello(escape), RUTA_ABSOLUTA);
  assert.ok(!escape.pregunta.includes('…'), escape.pregunta);
  // sign-file: su texto propio, con el archivo por su nombre; la ruta entera en el detalle
  const archivo = `${lejos}evidencia.md`;
  const firmaArchivo = conFirma('escape:dod_runtime_exempt')(c, `node ${MARKER} sign-file dod_runtime_exempt ${archivo}`);
  assert.match(queHaceDe(firmaArchivo), /sobre el archivo evidencia\.md/);
  assert.doesNotMatch(sinSello(firmaArchivo), RUTA_ABSOLUTA);
  assert.ok(!firmaArchivo.pregunta.includes('…'), firmaArchivo.pregunta);
  assert.ok(firmaArchivo.detalle.some((l) => l.includes(archivo)), JSON.stringify(firmaArchivo.detalle));
  // designation-confirm: la sesión designada con sus 8 letras, la cita sin «…»
  const sid = 'sesionde-prueba-larga-con-id-entero-0001';
  fs.writeFileSync(path.join(c.estado, 'gates.log'), `${JSON.stringify({ name: 'relay-designation', status: 'ok', rol: 'coordinadora', sesion: sid, ts: '2026-11-16T00:00:00Z', cita: `nombro a la coordinadora ${'porque hace falta '.repeat(20)}` })}\n`);
  const conf = ow.cuadroPara({ firma: 'designation-confirm', comando: 'node delegated-signing.js confirm-designation', palabras: ow.canonica('node delegated-signing.js confirm-designation'), destino: 'ses-a', sesion: 'ses-a', cwd: c.repo, casa: c.casa });
  assert.ok(conf.pregunta, conf.error);
  assert.ok(!conf.pregunta.includes('…'), conf.pregunta);
  assert.ok(!sinSello(conf).includes(sid), conf.pregunta);
});

// 🔴 Falla con: un plan de tres líneas que no se puede firmar, o uno de cuatro que se firma callado.
test('SignatureQuestion_PlanThreeLines_TwoShownOneInDetail (T6) @story-8.275 @ac-3', (t) => {
  const plan = (n) => ['# Plan', '', '## Qué hace', '', ...Array.from({ length: n }, (_, k) => `Línea ${k + 1} del plan.`), '', '## Archivos', '', '- scripts/lib/a.js', ''].join('\n');
  const c = corrida(t);
  escribirPlan(c, plan(2));
  assert.strictEqual(queHaceDe(cuadro(c, APRUEBA_PLAN, { firma: 'plan-approval' })), 'Línea 1 del plan · Línea 2 del plan');
  escribirPlan(c, plan(3));
  const tres = cuadro(c, APRUEBA_PLAN, { firma: 'plan-approval' });
  assert.strictEqual(queHaceDe(tres), 'Línea 1 del plan · Línea 2 del plan · y 1 más en el detalle');
  assert.ok(tres.detalle.some((l) => l.includes('Línea 3 del plan.')), JSON.stringify(tres.detalle));
  assert.doesNotMatch(tres.pregunta, /hasta 3 líneas/);
  escribirPlan(c, plan(4));
  assert.match(cuadro(c, APRUEBA_PLAN, { firma: 'plan-approval' }).pregunta, /el plan no dice qué hace en hasta 3 líneas: su sección «## Qué hace» tiene 4/);
});

// 🔴 Falla con: las rutas de los archivos en el cuadro del plan o del cambio de control, o la ruta que falsea con cuadro.
test('SignatureQuestion_PlanAndControls_FilesAsZones (T7) @story-8.275 @ac-4 @ac-6', (t) => {
  const c = corrida(t);
  const archivos = ['scripts/lib/a.js', 'scripts/lib/b.js', 'scripts/lib/c.js', 'scripts/tools/d.js', 'scripts/tests/a.test.js', 'scripts/tests/b.test.js',
    'scripts/tests/c.test.js', 'guides/x.md', 'guides/y.md', 'specs/story-9.99-prueba.md', '.tycon/advisors.yaml'];
  escribirPlan(c, ['# Plan', '', '## Qué hace', '', 'Hace algo.', '', '## Archivos', '', ...archivos.map((a) => `- ${a}`), ''].join('\n'));
  const p = cuadro(c, APRUEBA_PLAN, { firma: 'plan-approval' });
  assert.match(p.pregunta, /Archivos: 11 archivos: 4 de código \(lib y tools\), 3 pruebas, 1 historia, 2 guías, 1 de configuración\./);
  for (const a of archivos) assert.ok(!p.pregunta.includes(a) && !p.detalle.some((l) => l.includes(a)), `se ve ${a}`);
  const rutas = ['scripts/ci/a.sh', 'scripts/ci/b.sh', 'scripts/lib/c.js'];
  const r = repoConArchivos(t, rutas);
  const q = conFirma('control-change')(r.c, r.comando(r.entradas()));
  assert.match(q.pregunta, /Qué hace: Cambia 3 archivo\(s\) de control: \+3 −0 líneas\. Archivos: 3 archivos: 3 de código \(a, b y c\)\./);
  for (const a of rutas) assert.ok(!q.pregunta.includes(a) && !q.detalle.some((l) => l.includes(a)), `se ve ${a}`);
  // una ruta que trae «, » todavía no tiene cuadro (8.176 AC 9)
  const coma = `bash ${CONTROLES} approve --root ${r.c.repo} --base ${r.base} --entries '${JSON.stringify([{ path: 'scripts/ci/a, b.sh', blob: 'x' }])}'`;
  assert.ok(conFirma('control-change')(r.c, coma).error);
});

/** Una corrida con cada firma de AC 11 armada por el freno, con su fuente escrita. */
function cadaFirma(t) {
  const c = corrida(t, eximibles([1, 2]));
  escribirPlan(c);
  fs.writeFileSync(path.join(c.runDir, 'findings.json'), JSON.stringify([{ rule_id: 'SEC-C1', severity: 'CRITICAL', file: 'a.js', summary: 'secreto en el código', disposition: 'open' }]));
  const nota = path.join(c.runDir, 'rethink', 'iter-3.json');
  fs.mkdirSync(path.dirname(nota), { recursive: true });
  fs.writeFileSync(nota, JSON.stringify({ iter: 3, repeated: 'vuelve', change: 'se parte el archivo' }));
  const adhoc = path.join(c.estado, 'adhoc');
  fs.mkdirSync(adhoc, { recursive: true });
  fs.writeFileSync(path.join(adhoc, 'ses-a.json'), JSON.stringify({ reason: 'x', maxFiles: 8, files: [], frenoDatos: { huella: 'h1', hallazgos: [{ id: 'proceso', strength: 'strong', says: 'una llamada', file: 'src/a.tsx', line: 3, borrada: false, texto: 'executeQuery(x)' }] } }));
  const r = repoConArchivos(t, ['scripts/ci/a.sh', 'scripts/ci/b.sh']);
  const arreglo = `node ${MARKER} adhoc set '{"reason":"arreglar el aviso","maxFiles":3}'`;
  const casos = {
    'plan-approval': [c, APRUEBA_PLAN],
    'control-change': [r.c, r.comando(r.entradas())],
    'refresh-after-main': [r.c, r.comando(r.entradas())],
    'critical-waiver': [c, `node ${MARKER} waive-critical --rule SEC-C1 --file a.js --reason "lo cubre otra capa"`],
    'runtime-waiver': [c, `node ${MARKER} runtime-waiver ${c.ruta} --acs 1,2`],
    'manual-test': [c, `node ${MARKER} mark-tested --acs 2`],
    'extra-round': [c, `node ${PIPELINE} smart-reloop --iter 3 --extra-round`],
    'adhoc-lane': [c, arreglo],
    'adhoc-lane:sobre-cupo': [c, arreglo],
    'escape:rojo-esperado-de-la-matriz': [c, `node ${MARKER} expect-red acmatrix --tests T1 --until 2026-12-01`],
    'designation-set': [c, `node ${MARKER} designate-relay`],
    'adhoc-lane:datos': [c, `node ${MARKER} adhoc allow-data-change --changed "el botón pide al proceso" --recommends pasar --why "el proceso tiene su seguridad"`],
  };
  return Object.entries(casos).map(([firma, [cc, cmd]]) => [firma, conFirma(firma)(cc, cmd)]);
}

// 🔴 Falla con: una ruta absoluta o un «…» en la pregunta de cualquier firma.
test('SignatureQuestion_EveryFirma_NoAbsolutePathNorEllipsis (T8) @story-8.275 @ac-7 @ac-9', (t) => {
  const palabras = {
    'plan-approval': 'el plan, en la carpeta de la corrida', 'control-change': 'el cambio, en un archivo de la corrida', 'critical-waiver': 'el informe de hallazgos de la corrida',
    'runtime-waiver': 'la historia 9.99', 'manual-test': 'la historia 9.99', 'extra-round': 'la nota de la vuelta, en la carpeta de la corrida', 'escape:rojo-esperado-de-la-matriz': 'la historia 9.99',
  };
  for (const [firma, q] of cadaFirma(t)) {
    assert.ok(q.pregunta, `${firma}: ${q.error}`);
    assert.doesNotMatch(sinSello(q), RUTA_ABSOLUTA, `${firma}: ${q.pregunta}`);
    assert.ok(!q.pregunta.includes('…'), `${firma}: ${q.pregunta}`);
    if (palabras[firma]) assert.ok(q.pregunta.includes(`Completo en: ${palabras[firma]}.`), `${firma}: ${q.pregunta}`);
  }
});

test('SignatureQuestion_GuardadoAjeno_ShownAsToday (T8) @story-8.275 @ac-7', () => {
  const lineas = ['Guarda en /r/repo con git commit', 'Los hooks: /r/repo/.githooks/pre-commit'];
  const q = oa.cuadroDe({ firma: 'adhoc-lane:guardado-ajeno', destino: 'ses-a', que: 'dejar pasar un guardado ajeno', queHace: lineas, todoQueHace: true, siSaleMal: 'se revierte', huella: 'ab12cd34' });
  assert.ok(q.pregunta.includes(`Qué hace: ${lineas.join(' · ')}.`), q.pregunta);
});

// 🔴 Falla con: un título largo que ocupa la pantalla, o el id entero de la sesión en el texto.
test('SignatureQuestion_LongTitle_GoesToDetail_ShortSessionId (T9) @story-8.275 @ac-8', () => {
  const sid = 'sesionde-prueba-larga-con-id-entero-0001';
  const con = (titulo) => oa.cuadroDe({ firma: 'save', destino: sid, que: 'guardar', historia: { id: '9.99', titulo }, queHace: ['x'], siSaleMal: 'se revierte', huella: 'ab12cd34' });
  const t81 = 'T'.repeat(81);
  const largo = con(t81);
  assert.ok(largo.pregunta.includes('Historia 9.99, sesión sesionde.'), largo.pregunta);
  assert.ok(!sinSello(largo).includes(t81));
  assert.ok(largo.detalle.some((l) => l.includes(t81)));
  const t80 = 'T'.repeat(80);
  assert.ok(con(t80).pregunta.includes(`Historia 9.99, «${t80}», sesión sesionde.`));
  assert.ok(largo.sello.includes(`sesión ${sid}`), largo.sello);
  assert.ok(!sinSello(largo).includes(sid));
});

// 🔴 Falla con: un cuadro con sus campos al máximo que no entra en el tope del teléfono, o que entra sacando lo que se aprueba.
test('SignatureQuestion_EveryFirma_FitsPhoneCap (T10) @story-8.275 @ac-10 @ac-11', () => {
  const tope = oa.LARGO_EN_TELEFONO;
  assert.strictEqual(tope, 600);
  const archivos = Array.from({ length: 40 }, (_, k) => `scripts/${'d'.repeat(10)}${k % 7}/${'a'.repeat(130)}${k}.js`);
  const criterios = Array.from({ length: 12 }, (_, k) => k + 1);
  const completo = `/Users/x/${'c/'.repeat(100)}plan.md`;
  const pruebas = criterios.map((n) => `T${n}`).join(', ');
  // cada firma con lo más largo que da cada campo que su fuente da (signature-sources.js y owner-window.js)
  const campos = {
    'plan-approval': { queHace: largas(3), archivos, completo, revision: { linea: 'aprobado con notas', detalle: largas(3) }, cita: 'x'.repeat(400) },
    'control-change': { queHace: largas(1), archivos, completo },
    'refresh-after-main': { queHace: largas(1), archivos, completo },
    'critical-waiver': { queHace: largas(3), archivos, completo, cita: 'x'.repeat(400) },
    'runtime-waiver': { criterios, queHace: largas(3), completo, que: ow.queDeLaExcepcion(criterios.map((ac) => ({ ac, reason: 'y'.repeat(300), coveredBy: 'T1', text: 'z' }))) },
    'manual-test': { criterios, queHace: largas(3), completo },
    'extra-round': { queHace: largas(3), completo },
    'adhoc-lane': { queHace: largas(2), cita: 'x'.repeat(400) },
    'adhoc-lane:sobre-cupo': { queHace: largas(2), cita: 'x'.repeat(400) },
    'escape:rojo-esperado-de-la-matriz': { criterios, queHace: largas(3), completo, que: `llevar al commit los AC ${criterios.join(', ')} sin evidencia en vivo (pruebas ${pruebas}), hasta el 2026-12-01` },
    'designation-set': { queHace: largas(2) },
    'escape:TYCON_SAFETY_OFF': { queHace: largas(1) },
  };
  for (const [id, c] of Object.entries(campos)) {
    const s = sig.SIGNATURES.find((x) => x.id === id);
    const q = oa.cuadroDe({ firma: id, destino: 'sesionde-prueba-larga-con-id-entero-0001', que: c.que || s.approves, historia: { id: '9.99', titulo: 'T'.repeat(300) }, criterios: c.criterios || [],
      queHace: c.queHace, archivos: c.archivos || [], completo: c.completo, completoEnPalabras: c.completo ? 'el plan, en la carpeta de la corrida' : null,
      revision: c.revision || null, siSaleMal: s.ifWrong, cita: c.cita || null, huella: 'ab12cd34' });
    assert.ok(q.pregunta.length <= tope, `${id}: ${q.pregunta.length} letras: ${q.pregunta}`);
    assert.strictEqual(q.pasaElTope, false, id);
    // lo que nunca se saca
    assert.ok(q.pregunta.startsWith(`¿${(c.que || s.approves).charAt(0).toUpperCase()}`), `${id}: ${q.pregunta}`);
    assert.ok(q.pregunta.includes(`Si sale mal: ${s.ifWrong.replace(/[.\s]+$/, '')}.`), `${id}: ${q.pregunta}`);
    if (c.archivos) assert.ok(q.pregunta.includes('Archivos: 40 archivos: 40 de código'), `${id}: ${q.pregunta}`);
    assert.ok(q.pregunta.includes('sesión sesionde'), `${id}: ${q.pregunta}`);
    assert.ok(q.pregunta.endsWith(`(${q.sello})`), id);
    if (c.criterios) assert.ok(q.pregunta.includes('Criterios: AC 1 a 12.') || q.pregunta.includes(`Criterios: AC ${criterios.slice(0, -1).join(', ')} y 12.`), `${id}: ${q.pregunta}`);
    assert.ok(!q.pregunta.includes('…'), `${id}: ${q.pregunta}`);
  }
});

// 🔴 Falla con: el sello de un comando que cambia con el formato nuevo (un click del dueño ya dado no valdría por nada).
test('SignatureQuestion_SameSealBeforeAndAfter (T12) @story-8.275 @ac-14', (t) => {
  // los sellos de main antes de la 8.275 (94099637), calculados con estos mismos comandos y esta misma corrida
  const ANTES = { 'adhoc-lane': 'e7379f59', save: '40b87e99', 'lost-run': 'c6466a32', 'runtime-waiver': 'c2042686', 'designation-set': '12396fc2' };
  const c = corrida(t, { titulo: 'x', extraHistoria: ['runtime_not_verifiable:', '  - ac: 1', '    reason: "el servicio externo no tiene ambiente de prueba"', '    covered_by: T1'] });
  const de = (firma, cmd, cwd = c.repo) => ow.cuadroPara({ firma, comando: cmd, palabras: ow.canonica(cmd), destino: 'ses-a', sesion: 'ses-a', cwd, casa: c.casa });
  const ahora = {
    'adhoc-lane': de('adhoc-lane', `node ${MARKER} adhoc set '{"reason":"arreglar el aviso","maxFiles":3}'`),
    save: de('save', `node ${MARKER} approve-save`),
    'lost-run': de('lost-run', `node ${MARKER} clear-session ses-b --lost`),
    'runtime-waiver': de('runtime-waiver', `node ${MARKER} runtime-waiver specs/story-9.99-prueba.md --acs 1`),
    'designation-set': de('designation-set', `node ${MARKER} designate-relay`, '/r/repo'),
  };
  for (const [firma, q] of Object.entries(ahora)) assert.strictEqual(q.sello, `firma ${firma} · sesión ses-a · código ${ANTES[firma]}`, `${firma}: ${q.error || q.sello}`);
});

// 🔴 Falla con: otra pregunta desde la coordinadora que desde la sesión (su click no valdría para el comando de la sesión).
test('SignatureQuestion_SameQuestionFromSessionAndCoordinator (T12) @story-8.275 @ac-15', (t) => {
  const c = corrida(t);
  escribirPlan(c);
  const desde = (cmd, sesion, cwd) => ow.cuadroPara({ firma: 'plan-approval', comando: cmd, palabras: ow.canonica(cmd), destino: 'ses-a', sesion, cwd, casa: c.casa });
  const propia = desde(APRUEBA_PLAN, 'ses-a', c.repo);
  const ajena = desde(`${APRUEBA_PLAN} --for-session ses-a`, 'ses-coord', os.tmpdir());
  assert.ok(propia.pregunta, propia.error);
  assert.strictEqual(ajena.pregunta, propia.pregunta);
  assert.deepStrictEqual(ajena.detalle, propia.detalle);
});

// 🔴 Falla con: un cuadro que no entra en el teléfono dado sin aviso, o recortado hasta sacar lo que se aprueba.
test('SignatureQuestion_OverCap_GivenWithLine (T11) @story-8.275 @ac-12', (t) => {
  const C = require('../tools/coordination.js');
  // 60 criterios salteados: sus números no se achican en tramos, y no entran
  const c = corrida(t, eximibles(Array.from({ length: 60 }, (_, k) => 2 * (k + 1))));
  const adhoc = path.join(c.estado, 'adhoc');
  fs.mkdirSync(adhoc, { recursive: true });
  const archivos = Array.from({ length: 30 }, (_, k) => `src/modulo-${k}/${'componente-largo-'.repeat(4)}${k}.tsx`);
  fs.writeFileSync(path.join(adhoc, 'ses-a.json'), JSON.stringify({ reason: 'x', maxFiles: 8, files: [],
    guardadoAjeno: { huella: 'h2', comando: 'git commit -am "guardar"', repo: c.repo, rama: 'main', guarda: [{ tipo: 'commit', archivos }], hooks: [], hooksCarpeta: null, configuracion: [] },
    frenoDatos: { huella: 'h1', hallazgos: [{ id: 'proceso', strength: 'strong', says: 'una llamada', file: 'src/a.tsx', line: 3, borrada: false, texto: `executeQuery(${'x'.repeat(200)})` }] } }));
  const largo = 'cambia de dónde salen los datos del tablero, que ahora pide al proceso en lugar de leer la tabla '.repeat(3);
  const casos = {
    'adhoc-lane:guardado-ajeno': `node ${MARKER} adhoc allow-foreign-save`,
    'adhoc-lane:datos': `node ${MARKER} adhoc allow-data-change --changed "${largo}" --recommends pasar --why "${largo}"`,
    'runtime-waiver': `node ${MARKER} runtime-waiver ${c.ruta}`,
  };
  for (const [firma, cmd] of Object.entries(casos)) {
    const q = conFirma(firma)(c, cmd);
    assert.ok(q.pregunta, `${firma}: ${q.error}`);
    assert.strictEqual(q.pasaElTope, true, `${firma}: ${q.pregunta.length}`);
    const linea = oa.renglonDelTope(q);
    assert.strictEqual(linea, `Este cuadro pasa el tope del teléfono (${q.pregunta.length} de ${oa.LARGO_EN_TELEFONO} letras): leelo en la máquina si no se ve entero.`);
    // por owner-next: la pregunta entera y el renglón aparte
    const r = { tipo: 'firma', id: 'f1', rotulo: 'Firma 1/1', opciones: q.opciones, pregunta: q.pregunta, sello: q.sello, aviso: 'repetí', destino: 'ses-a', nombre: 'A',
      problemas: [], faltaRepetir: [], saltados: [], detalle: q.detalle, pasaElTope: q.pasaElTope, largo: q.largo, tope: q.tope };
    const out = C.ownerNextText(r, 'ses-coord');
    assert.ok(out.includes(`Pregunta:\n${q.pregunta}\n`), `${firma}: ${out}`);
    assert.ok(out.includes(linea), `${firma}: ${out}`);
    // por decidir: el texto a la sesión trae la pregunta y el mismo renglón
    const d = ow.negarSinVentana('sin ventana', [firma], 'ses-a', q, true);
    assert.ok(d.texto.includes(q.pregunta), `${firma}: ${d.texto}`);
    assert.ok(d.texto.includes(linea), `${firma}: ${d.texto}`);
  }
  // uno que entra no lleva el renglón
  escribirPlan(c);
  const plan = cuadro(c, APRUEBA_PLAN, { firma: 'plan-approval' });
  assert.strictEqual(plan.pasaElTope, false);
  assert.strictEqual(oa.renglonDelTope(plan), null);
});
