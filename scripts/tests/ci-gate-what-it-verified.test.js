'use strict';
/**
 * Qué dice el portón de CI que verificó: el nivel de cada chequeo, la línea verde y las exenciones.
 *
 * El visto bueno del servidor se leía como «se probó» cuando muchas veces significa «hay un archivo con ese nombre».
 * Cada chequeo dice ahora su nivel: archivo presente, ejecución registrada, verificado por el servidor o no medido.
 * Las exenciones salen listadas con su razón, y una exención sin razón avisa hasta EXEMPT_REASON_FROM y frena desde ese
 * día. Repos de juguete en una carpeta temporal, HOME vacía, sin red.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const GATE = path.join(ROOT, 'scripts', 'ci', 'tycon-ci-gate.js');
const gate = require(GATE);

const ROSTER = {
  version: 1, story: '1.1', implementer: { kind: 'sesion-principal', session_id: 's1' },
  reviewers: [{ agent: 'tycon-plugin-security-basics', kind: 'subagente', model: 'opus' }], iterations: 1,
};
const APROBACION = { que: 'plan', cuando: '2026-11-10T12:00:00Z', tipo: 'automatica', quien: 'sin nombrar', via: 'complete-step approve-plan' };

function repoDeJuguete(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cigate-niveles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-11-10T12:00:00Z', GIT_COMMITTER_DATE: '2026-11-10T12:00:00Z' };
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.email=b@b', '-c', 'user.name=b', '-c', 'maintenance.auto=false', ...a], { stdio: 'pipe', encoding: 'utf8', env });
  const escribir = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), txt); };
  // una exención viaja con la constancia del dueño en el repo (lib/exemptions.js): la historia de juguete la trae
  const story = (estado, extra = '') => {
    escribir('specs/1-1.md', `---\nstory: "1.1"\nepic: "1"\nstatus: ${estado}\n${extra}---\n# Story 1.1\n`);
    const campos = [...extra.matchAll(/^(advisors_exempt|dod_runtime_exempt):\s*true\b/gm)].map((m) => m[1]);
    if (campos.length) escribir('.tycon/exemptions.jsonl', campos.map((campo) => `${JSON.stringify({ story: '1.1', campo, archivo: 'specs/1-1.md', via: 'prueba' })}\n`).join(''));
  };
  story('in-progress');
  git('init', '-q', '-b', 'main', '.');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  const commit = () => { git('add', '-A'); git('commit', '-q', '-m', 'x'); };
  return { dir, base, escribir, story, commit };
}

/** Historia a `done` con evidencia de cierre, carpeta de corrida y registro de autoría. */
function historiaSana(t, extra = '') {
  const r = repoDeJuguete(t);
  r.story('done', extra);
  r.escribir('.advisors/dod-runtime/1.1-20261110.md', 'evidencia');
  r.escribir('.advisors/pipeline-runs/1.1-20261110120000/review-roster.json', JSON.stringify(ROSTER));
  r.escribir('.advisors/pipeline-runs/1.1-20261110120000/approvals.jsonl', `${JSON.stringify(APROBACION)}\n`);
  r.commit();
  return r;
}

function correr(r, ...args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cigate-home-'));
  try {
    return spawnSync(process.execPath, [GATE, '--repo', r.dir, '--base', r.base, ...args],
      { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

const NIVELES = ['archivo-presente', 'ejecucion-registrada', 'verificado-por-el-servidor', 'no-medido'];
const ANTES = (() => { const d = new Date(`${gate.EXEMPT_REASON_FROM}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();

test('T1 Output_LevelPerCheck — la salida nombra el nivel de cada chequeo y --json trae verificacion @ac-1', (t) => {
  const r = historiaSana(t);
  const salida = correr(r);
  const texto = salida.stdout + salida.stderr;
  for (const nivel of ['archivo presente', 'ejecución registrada', 'verificado por el servidor']) assert.match(texto, new RegExp(nivel), `falta «${nivel}» en:\n${texto}`);
  const j = JSON.parse(correr(r, '--json').stdout);
  assert.ok(Array.isArray(j.verificacion) && j.verificacion.length, 'trae verificacion');
  for (const v of j.verificacion) assert.ok(NIVELES.includes(v.nivel), `nivel desconocido: ${JSON.stringify(v)}`);
  const de = (chequeo) => j.verificacion.find((v) => v.story === '1.1' && v.chequeo === chequeo);
  assert.strictEqual(de('frontmatter-legible').nivel, 'verificado-por-el-servidor');
  assert.strictEqual(de('evidencia-de-cierre').nivel, 'archivo-presente');
  assert.strictEqual(de('constancia-de-revisores').nivel, 'archivo-presente');
  assert.strictEqual(de('registro-de-autoria').nivel, 'ejecucion-registrada');
  assert.strictEqual(de('registro-de-aprobaciones').nivel, 'ejecucion-registrada');
});

test('T1 Output_SkippedChecksAreNotMeasured — el examen de revisores sin su control es no medido @ac-1', () => {
  // El examen está junto al guion en este árbol: si corre, es del servidor; si no estuviera, no medido. Se prueba la
  // función que decide el nivel, con y sin el control al lado.
  assert.strictEqual(gate.nivelDelExamen(true), 'verificado-por-el-servidor');
  assert.strictEqual(gate.nivelDelExamen(false), 'no-medido');
  assert.strictEqual(gate.nivelDelIndice({ engram: { estado: 'indice-local' } }), 'no-medido');
  assert.strictEqual(gate.nivelDelIndice({ avisos: [{ regla: 'indice-de-memoria-no-comparable' }] }), 'no-medido');
  assert.strictEqual(gate.nivelDelIndice({ engram: { estado: 'al-dia' } }), 'verificado-por-el-servidor');
  assert.strictEqual(gate.nivelDelIndice(null), null, 'si el diff no toca el índice, el chequeo no se nombra');
});

test('T1 Output_LevelsFollowWhatWasRead — sin registro leído, sin clave o sin comparar, el chequeo es no medido @ac-1', (t) => {
  // una corrida sin registro de autoría ni de aprobaciones: el portón no leyó ningún registro
  const r = repoDeJuguete(t);
  r.story('done');
  r.escribir('.advisors/dod-runtime/1.1-20261110.md', 'evidencia');
  r.escribir('.advisors/pipeline-runs/1.1-20261110120000/step-06-consolidated-report.md', 'informe');
  r.commit();
  const j = gate.revisar({ repo: r.dir, base: r.base, hoy: ANTES });
  const de = (chequeo) => j.verificacion.find((v) => v.story === '1.1' && v.chequeo === chequeo);
  assert.strictEqual(de('registro-de-autoria').nivel, 'no-medido');
  assert.strictEqual(de('registro-de-aprobaciones').nivel, 'no-medido');
  // el examen que no pudo comparar no está verificado
  assert.strictEqual(gate.nivelDelExamen(true, { error: 'la base no existe' }), 'no-medido');
  assert.strictEqual(gate.nivelDelExamen(true, { hallazgos: [], avisos: [] }), 'verificado-por-el-servidor');
  // sin la clave de la story no se buscó nada: no medido, no «archivo presente»
  assert.strictEqual(gate.nivelDeBusqueda(false, null), 'no-medido');
  assert.strictEqual(gate.nivelDeBusqueda(true, '1.1-'), 'no-medido', 'la exención tampoco busca');
  assert.strictEqual(gate.nivelDeBusqueda(false, '1.1-'), 'archivo-presente');
});

test('T1 Output_RepeatedNumberKeptApart — dos historias con el mismo número no mezclan sus chequeos ni sus exenciones @ac-1 @ac-2', (t) => {
  const r = repoDeJuguete(t);
  r.escribir('specs/a/1-1.md', '---\nstory: "1.1"\nstatus: in-progress\n---\n# A\n');
  r.escribir('specs/b/1-1.md', '---\nstory: "1.1"\nstatus: in-progress\n---\n# B\n');
  r.commit();
  const base = execFileSync('git', ['-C', r.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  r.escribir('specs/a/1-1.md', '---\nstory: "1.1"\nstatus: done\ndod_runtime_exempt: true\ndod_runtime_exempt_reason: "sólo texto"\n---\n# A\n');
  r.escribir('specs/b/1-1.md', '---\nstory: "1.1"\nstatus: review\n---\n# B\n');
  r.commit();
  const j = gate.revisar({ repo: r.dir, base, hoy: ANTES });
  for (const v of j.verificacion.filter((x) => x.story)) assert.ok(v.archivo, `cada chequeo trae su archivo: ${JSON.stringify(v)}`);
  const evidencia = (archivo) => j.verificacion.find((v) => v.archivo === archivo && v.chequeo === 'evidencia-de-cierre').nivel;
  assert.strictEqual(evidencia('specs/a/1-1.md'), 'no-medido', 'la exención es de A');
  assert.notStrictEqual(evidencia('specs/b/1-1.md'), 'no-medido', 'B no está exenta');
  assert.deepStrictEqual(j.exenciones.map((e) => e.archivo), ['specs/a/1-1.md']);
  // la salida pone debajo de cada archivo sólo sus chequeos
  const salida = spawnSync(process.execPath, [GATE, '--repo', r.dir, '--base', base], { encoding: 'utf8' });
  const bloqueB = salida.stdout.slice(salida.stdout.indexOf('specs/b/1-1.md'));
  const lineaB = bloqueB.split('\n').find((l) => /chequeos:/.test(l));
  assert.ok(lineaB && !/evidencia de cierre: no medido/.test(lineaB), `B no hereda el no medido de A:\n${salida.stdout}`);
});

test('T2 Output_GreenLineSaysNoReexecution — exit 0 y la línea verde dice que no se re-ejecutó nada @ac-1', (t) => {
  const r = historiaSana(t);
  const salida = correr(r);
  assert.strictEqual(salida.status, 0, salida.stdout + salida.stderr);
  assert.match(salida.stdout, /✅.*el servidor no re-ejecutó nada/i);
  // también la verde de «ninguna story pasa a review/done»
  const vacio = repoDeJuguete(t);
  vacio.escribir('README.md', 'hola'); vacio.commit();
  const s2 = correr(vacio);
  assert.strictEqual(s2.status, 0);
  assert.match(s2.stdout, /✅.*el servidor no re-ejecutó nada/i);
});

test('T3 Exemptions_ListedWithReason — la exención sale con su razón en la salida y en --json @ac-1 @ac-2', (t) => {
  const r = historiaSana(t, 'advisors_exempt: true\nadvisors_exempt_reason: "historia de sólo texto, sin revisores"\n');
  const salida = correr(r);
  assert.match(salida.stdout + salida.stderr, /1 exención\(es\): advisors_exempt \(razón: historia de sólo texto, sin revisores\)/);
  const j = JSON.parse(correr(r, '--json').stdout);
  assert.deepStrictEqual(j.exenciones, [{ story: '1.1', archivo: 'specs/1-1.md', campo: 'advisors_exempt', razon: 'historia de sólo texto, sin revisores' }]);
  const exento = j.verificacion.find((v) => v.chequeo === 'constancia-de-revisores');
  assert.strictEqual(exento.nivel, 'no-medido', 'una exención nunca cuenta como verificado');
});

test('T3 Exemptions_BlockReasonIsRead — una razón en bloque | o > se lee entera, no como el literal «|» @ac-2 @ac-3', (t) => {
  const r = historiaSana(t, 'dod_runtime_exempt: true\ndod_runtime_exempt_reason: |\n  no hay nada que correr:\n  es una guía\nadvisors_exempt: true\nadvisors_exempt_reason: >\n');
  const j = gate.revisar({ repo: r.dir, base: r.base, hoy: gate.EXEMPT_REASON_FROM });
  const dod = j.exenciones.find((e) => e.campo === 'dod_runtime_exempt');
  assert.strictEqual(dod.razon, 'no hay nada que correr: es una guía');
  const adv = j.exenciones.find((e) => e.campo === 'advisors_exempt');
  assert.strictEqual(adv.razon, null, 'un bloque vacío no es una razón');
  assert.ok(j.hallazgos.some((h) => h.regla === 'exencion-sin-razon' && /advisors_exempt/.test(h.mensaje)), 'el bloque vacío frena desde la fecha');
  assert.ok(!j.hallazgos.some((h) => h.regla === 'exencion-sin-razon' && /dod_runtime_exempt/.test(h.mensaje)), 'el bloque con texto vale');
});

test('T3 Exemptions_NullAndPlainReasons — un nulo de YAML no es razón; una razón en la línea de abajo, sí @ac-2 @ac-3', (t) => {
  const razon = (fm) => gate.razonDe(fm, 'advisors_exempt');
  assert.strictEqual(razon('advisors_exempt: true\nadvisors_exempt_reason: ~\n'), null);
  assert.strictEqual(razon('advisors_exempt: true\nadvisors_exempt_reason: null\n'), null);
  assert.strictEqual(razon("advisors_exempt: true\nadvisors_exempt_reason: ''\n"), null);
  assert.strictEqual(razon('advisors_exempt: true\nadvisors_exempt_reason:\n  la historia es sólo texto\n  y no tiene revisores\n'), 'la historia es sólo texto y no tiene revisores');
  assert.strictEqual(razon('advisors_exempt: true\nadvisors_exempt_reason : sin código\n'), 'sin código');
  // un comentario no es razón; el comentario al final de una razón no es parte de ella
  assert.strictEqual(razon('advisors_exempt: true\nadvisors_exempt_reason: # pendiente\n'), null);
  assert.strictEqual(razon('advisors_exempt: true\nadvisors_exempt_reason: sin código # nota\n'), 'sin código');
  assert.strictEqual(razon('advisors_exempt: true\nadvisors_exempt_reason: "sin código # de verdad" # nota\n'), 'sin código # de verdad');
  // un bloque que empieza con una línea en blanco sigue siendo el bloque
  assert.strictEqual(razon('advisors_exempt: true\nadvisors_exempt_reason: |\n\n  la razón va acá\n'), 'la razón va acá');
  const r = historiaSana(t, 'advisors_exempt: true\nadvisors_exempt_reason: ~\n');
  const j = gate.revisar({ repo: r.dir, base: r.base, hoy: gate.EXEMPT_REASON_FROM });
  assert.ok(j.hallazgos.some((h) => h.regla === 'exencion-sin-razon'), 'el nulo frena desde la fecha');
});

test('T3 Exemptions_ReasonIsSanitized — la razón que se imprime no puede dar órdenes al registro del pipeline @ac-2', (t) => {
  const r = historiaSana(t, 'advisors_exempt: true\nadvisors_exempt_reason: "##vso[task.setvariable variable=x]1"\n');
  const salida = correr(r);
  assert.doesNotMatch(salida.stdout + salida.stderr, /##vso/);
  assert.match(salida.stdout, /advisors_exempt \(razón: #vso\[task\.setvariable variable=x\]1\)/);
});

test('T4 ExemptionWithoutReason_StagedReviewToDoneSaysNotice — en el pre-commit de review → done el aviso no dice «Frena» @ac-3 @ac-19', (t) => {
  const s = repoDeJuguete(t);
  s.story('review', 'advisors_exempt: true\n');
  s.commit();
  s.story('done', 'advisors_exempt: true\n');
  execFileSync('git', ['-C', s.dir, 'add', '-A']);
  const j = gate.revisar({ repo: s.dir, staged: true, hoy: gate.EXEMPT_REASON_FROM });
  const aviso = j.avisos.find((a) => a.regla === 'exencion-sin-razon');
  assert.ok(aviso, 'avisa');
  assert.doesNotMatch(aviso.mensaje, /Frena\./);
  assert.match(aviso.mensaje, /en el pedido frena/);
});

test('T4 ExemptionWithoutReason_NoticeThenBlocks — avisa antes de la fecha y frena desde ella, en pedido y en staged @ac-3', (t) => {
  assert.match(gate.EXEMPT_REASON_FROM, /^\d{4}-\d{2}-\d{2}$/);
  const r = historiaSana(t, 'advisors_exempt: true\n');
  const antes = gate.revisar({ repo: r.dir, base: r.base, hoy: ANTES });
  assert.ok(antes.avisos.some((a) => a.regla === 'exencion-sin-razon'), 'antes: aviso');
  assert.ok(!antes.hallazgos.some((h) => h.regla === 'exencion-sin-razon'), 'antes: no frena');
  assert.strictEqual(antes.hallazgos.length, 0);
  const desde = gate.revisar({ repo: r.dir, base: r.base, hoy: gate.EXEMPT_REASON_FROM });
  assert.ok(desde.hallazgos.some((h) => h.regla === 'exencion-sin-razon'), 'desde: hallazgo');

  // staged: la misma historia, todavía sin commitear (in-progress → done en el índice)
  const s = repoDeJuguete(t);
  s.story('done', 'dod_runtime_exempt: true\nadvisors_exempt: true\n');
  execFileSync('git', ['-C', s.dir, 'add', '-A']);
  const sAntes = gate.revisar({ repo: s.dir, staged: true, hoy: ANTES });
  assert.ok(sAntes.avisos.some((a) => a.regla === 'exencion-sin-razon') && !sAntes.hallazgos.some((h) => h.regla === 'exencion-sin-razon'), 'staged antes: aviso');
  const sDesde = gate.revisar({ repo: s.dir, staged: true, hoy: gate.EXEMPT_REASON_FROM });
  assert.strictEqual(sDesde.hallazgos.filter((h) => h.regla === 'exencion-sin-razon').length, 2, 'staged desde: las dos exenciones sin razón frenan');

  // ninguna variable de ambiente mueve la fecha
  const fuente = fs.readFileSync(GATE, 'utf8');
  assert.match(fuente, /const EXEMPT_REASON_FROM = '\d{4}-\d{2}-\d{2}';/, 'la fecha está escrita en el código, sin variable');
});

test('T4 ExemptionWithoutReason_CliExitCodes — el CLI sale 0 con el aviso y el aviso tiene su propio título @ac-3', (t) => {
  const r = historiaSana(t, 'advisors_exempt: true\n');
  const salida = correr(r);
  // stable-data: el portón lee el reloj sin variable que lo mueva (lo fija T3), y la prueba cubre los dos lados de la fecha
  const hoy = new Date().toISOString().slice(0, 10);
  if (hoy < gate.EXEMPT_REASON_FROM) {
    assert.strictEqual(salida.status, 0, salida.stdout + salida.stderr);
    assert.match(salida.stderr, /exencion-sin-razon/);
    assert.doesNotMatch(salida.stderr, /review → done sin evidencia completa/, 'no va bajo el título de review → done');
  } else {
    assert.strictEqual(salida.status, 1, salida.stdout + salida.stderr);
  }
});

test('T5 Guide_SaysWhatGreenMeans — la guía dice qué significa el visto bueno y lo que no resuelve @ac-4 @ac-8', () => {
  const guia = fs.readFileSync(path.join(ROOT, 'guides', 'ci-gate.md'), 'utf8');
  const arriba = guia.split('\n').slice(0, 12).join('\n');
  assert.match(arriba, /hay archivos con el nombre correcto y lo que el servidor verificó él mismo; el servidor no re-ejecuta nada/);
  assert.match(guia, /## Lo que el portón NO resuelve/);
  assert.doesNotMatch(guia, /22 casos/);
  assert.doesNotMatch(guia, /Rollout COMPLETO/);
  assert.match(guia, /medido el \d{4}-\d{2}-\d{2}/, 'la cifra de adopción va como medición con su fecha');
  assert.match(guia, /no se firma en el servidor/);
  assert.match(guia, /`requerido` no prueba que el portón corra/);
  // el inventario cuenta lo que la credencial ve: una sin alcance sobre los privados los deja afuera sin error (AC 4)
  assert.match(guia, /la cuenta es la de los repos que la credencial ve/i);
  const inventario = fs.readFileSync(path.join(ROOT, 'scripts', 'nightly', 'gate-adoption', 'gate-adoption.js'), 'utf8');
  assert.match(inventario.split('\n').slice(0, 40).join('\n'), /la cuenta es la de los repos que la credencial ve/i);
  const cabecera = fs.readFileSync(GATE, 'utf8').split('\n').slice(0, 60).join('\n');
  assert.doesNotMatch(cabecera, /Los seis son MECÁNICOS/);
  assert.match(cabecera, /VERIFICA EL SERVIDOR/);
  assert.match(cabecera, /SÓLO MIRAN QUE EXISTA/);
});

test('ExistingSuites_StayGreen (T25) — una historia sana sale 0, review → done con --staged avisa, los exports siguen @ac-18 @ac-19 @ac-20', (t) => {
  const r = historiaSana(t, 'dod_runtime_exempt: true\ndod_runtime_exempt_reason: "sin app que levantar"\n');
  const salida = correr(r);
  assert.strictEqual(salida.status, 0, salida.stdout + salida.stderr);

  // review → done en el índice: avisa y no frena (como hoy)
  const s = repoDeJuguete(t);
  s.story('review'); s.escribir('.advisors/dod-runtime/1.1-20261110.md', 'evidencia'); s.commit();
  s.story('done');
  execFileSync('git', ['-C', s.dir, 'add', '-A']);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cigate-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.TYCON_REVIEW_A_DONE;
  const st = spawnSync(process.execPath, [GATE, '--repo', s.dir, '--staged'], { encoding: 'utf8', env });
  assert.strictEqual(st.status, 0, st.stdout + st.stderr);
  assert.match(st.stderr, /review → done sin evidencia completa/);

  for (const nombre of ['esEvidenciaDeCierre', 'revisar', 'hayEvidencia', 'prefijoDeEvidencia', 'runDirsDeStory', 'validarRoster', 'mdDelDiff', 'contenidoEn', 'NO_ES_EVIDENCIA_DE_CIERRE', 'ES_EVIDENCIA_ADEMAS']) {
    assert.ok(gate[nombre] !== undefined, `el portón sigue exportando ${nombre}`);
  }
  for (const rel of ['scripts/nightly/projects/snapshot.js', 'scripts/metrics/sdlc-stage-metrics.js']) {
    assert.doesNotThrow(() => require(path.join(ROOT, rel)), `${rel} carga`);
  }
});

test('ExistingSuites_SelftestPastTheCutoff (T25) — la autoprueba del portón no se pone roja sola el día de la fecha de corte @ac-18', () => {
  // Cada historia exenta de la autoprueba trae su razón: si no, desde EXEMPT_REASON_FROM la autoprueba frenaría sola.
  const fuente = fs.readFileSync(GATE, 'utf8');
  const cuerpo = fuente.slice(fuente.indexOf('function selftest()'), fuente.indexOf('function main()'));
  const exentas = cuerpo.match(/story\('done', '[^']*_exempt: true[^']*'\)/g) || [];
  assert.ok(exentas.length >= 2, 'la autoprueba tiene historias exentas');
  for (const e of exentas) {
    for (const campo of ['dod_runtime_exempt', 'advisors_exempt']) {
      if (e.includes(`${campo}: true`)) assert.ok(e.includes(`${campo}_reason:`), `${e} declara ${campo} sin razón`);
    }
  }
  const st = spawnSync(process.execPath, [GATE, '--selftest'], { encoding: 'utf8' });
  assert.strictEqual(st.status, 0, st.stdout + st.stderr);
});
