'use strict';
/**
 * write-findings-signer — el firmante de un hallazgo se ELIGE, no se tipea (story 7.13).
 *
 * Caso disparador: un pull request de un producto del equipo (2026-09-22). El portón frenó cinco stories sanas con
 * `roster-incoherente` y cuatro eran suyas. La causa no era el cruce: el nombre del revisor se
 * escribe en DOS lados con dos criterios. El roster lo proyecta un hook desde el ledger de spawns
 * (id pelado, kebab-case); el `advisor` de `findings.json` lo tipeaba el orquestador con la vuelta
 * o el modelo pegados (`tycon-silent-failure-hunter (iter 3)`). Comparar esos dos textos letra por
 * letra es apostar a la suerte, y la suerte se agotó cinco veces en un pull request.
 *
 * Acá se fija el lado del ESCRITOR: `write-findings` valida el firmante contra los revisores de
 * ESA corrida más las fuentes propias del pipeline, separa la anotación en campos propios, y anota
 * de qué TRAMO viene el hallazgo. Lo que el cruce recibe es un id comparable.
 *
 * 🔴 REGLA DE ADMISIÓN: cada caso trae escrito su rojo previo.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const rlib = require(path.join(SCRIPTS, 'lib', 'review-roster.js'));

const STORY_ID = '7.13';
const RUN = `${STORY_ID}-20260922120000`;

/** Laboratorio: repo con su story y un run dir con el roster que se le pase. */
function lab(roster) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'firmante-'));
  const spec = path.join(d, `story-${STORY_ID}-x.md`);
  fs.writeFileSync(spec, ['---', `story: "${STORY_ID}"`, 'title: "t"', 'status: in-progress', '---', '',
    '# Story', '', '## Acceptance Criteria', '', '1. algo', ''].join('\n'));
  const runDir = path.join(d, '.advisors', 'pipeline-runs', RUN);
  fs.mkdirSync(runDir, { recursive: true });
  if (roster !== undefined) {
    fs.writeFileSync(path.join(runDir, 'review-roster.json'),
      typeof roster === 'string' ? roster : `${JSON.stringify(roster, null, 2)}\n`);
  }
  return { d, spec, runDir, findings: path.join(runDir, 'findings.json') };
}

const rev = (agent) => ({ agent, kind: 'subagente', model: null, model_source: 'heredado', ts: null, iter: 1 });
const rosterCon = (...agentes) => ({
  version: 1, story: STORY_ID, written_by: 'on-advisor-run.js', ts: '2026-09-22T12:00:00Z',
  base_sha: null, tree_sha: null,
  implementer: { kind: 'sesion-principal', session_id: 's1', model: 'claude-opus-5' },
  reviewers: agentes.map(rev), iterations: 1, iterations_source: 'ledger',
});

/** Corre el comando de verdad. Devuelve {exit, out} — el exit code REAL, leído antes de cualquier pipe. */
function escribir(L, findings) {
  const entrada = JSON.stringify(findings);
  try {
    const out = execFileSync('node', [PIPELINE, 'write-findings', '--repo', L.d, '--story', L.spec, '--findings', '-'],
      { encoding: 'utf8', input: entrada });
    return { exit: 0, out };
  } catch (e) {
    return { exit: e.status === undefined ? -1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const hallazgo = (advisor, extra = {}) => ({ rule_id: 'X-1', severity: 'WARNING', advisor, file: 'a.js', disposition: 'open', reason: 'r', ...extra });
const leer = (L) => JSON.parse(fs.readFileSync(L.findings, 'utf8'));
const limpiar = (L) => fs.rmSync(L.d, { recursive: true, force: true });

// ── T1 (AC 1) ────────────────────────────────────────────────────────────────────────────────
// ROJO PREVIO: hoy `advisor` pasa tal cual sin mirar nada — escribe el archivo y sale 0.
test('WriteFindings_FirmanteQueNoCorrio_Falla', () => {
  const L = lab(rosterCon('tycon-plugin-security-basics', 'tycon-silent-failure-hunter', 'tycon-story-validator'));
  const r = escribir(L, [hallazgo('tycon-fantasma')]);
  assert.notStrictEqual(r.exit, 0, 'un firmante que no corrió tiene que fallar');
  assert.match(r.out, /tycon-fantasma/, 'el mensaje nombra el valor recibido');
  for (const v of ['tycon-plugin-security-basics', 'tycon-silent-failure-hunter', 'tycon-story-validator']) {
    assert.ok(r.out.includes(v), `el mensaje lista los firmantes válidos (falta ${v})`);
  }
  assert.ok(!fs.existsSync(L.findings), 'el findings.json NO se escribe: se valida ANTES de escribir');
  limpiar(L);
});

// ── T2 (AC 2) ────────────────────────────────────────────────────────────────────────────────
// ROJO PREVIO: hoy `tycon-silent-failure-hunter (iter 3)` se escribe entero y el cruce no lo
// reconoce — los cuatro falsos positivos de aquel pull request.
test('WriteFindings_VueltaPegadaAlNombre_SeSeparaEnCampos', () => {
  const L = lab(rosterCon('tycon-silent-failure-hunter', 'tycon-plugin-security-basics', 'http-resilience-reviewer'));
  const r = escribir(L, [
    hallazgo('tycon-silent-failure-hunter (iter 3)'),
    hallazgo('tycon-plugin-security-basics (opus)', { rule_id: 'X-2' }),
    hallazgo('http-resilience-reviewer (tanda cobertura E2E)', { rule_id: 'X-3' }),
  ]);
  assert.strictEqual(r.exit, 0, `tenía que aceptar: ${r.out}`);
  const f = leer(L);
  assert.strictEqual(f[0].advisor, 'tycon-silent-failure-hunter', 'el id queda pelado');
  assert.strictEqual(f[0].iter, 3, 'la vuelta va a su campo');
  assert.strictEqual(f[1].advisor, 'tycon-plugin-security-basics');
  assert.strictEqual(f[1].model, 'opus', 'el modelo va a su campo');
  assert.strictEqual(f[2].advisor, 'http-resilience-reviewer');
  assert.strictEqual(f[2].nota, 'tanda cobertura E2E', 'lo que no es vuelta ni modelo tampoco se tira');
  limpiar(L);
});

// ── Hallazgo del pase de revisión (SILENT-W2, iter 1) ────────────────────────────────────────
// Un hallazgo SIN firmante atravesaba la validación nueva sin decir nada, aun con roster presente:
// la guarda sólo miraba los firmantes no vacíos. No es un firmante inválido (no hay nada que
// validar), pero tampoco es un hallazgo completo — y callarlo es justo lo que esta story combate.
// Avisa y no frena: hay llamadores legítimos que escriben hallazgos sin `advisor`.
// ROJO PREVIO: exit 0 y `warnings` vacío.
test('WriteFindings_HallazgoSinFirmante_AvisaYNoFrena', () => {
  const L = lab(rosterCon('tycon-plugin-security-basics'));
  const r = escribir(L, [{ rule_id: 'SIN-1', severity: 'WARNING', file: 'x.js', disposition: 'open', reason: 'r' }]);
  assert.strictEqual(r.exit, 0, 'sin firmante no se frena: hay llamadores que escriben así');
  const avisos = (JSON.parse(r.out).warnings || []).join(' | ');
  assert.match(avisos, /SIN-1/, 'el aviso nombra el hallazgo');
  assert.match(avisos, /firmante/i, 'y dice que lo que falta es el firmante');
  limpiar(L);
});

// ── T3 (AC 3) ────────────────────────────────────────────────────────────────────────────────
// El caso se DERIVA de `FUENTES_SINTETICAS`: un patrón nuevo entra al test solo. Enumerar la lista
// acá sería la tercera copia — es el defecto que la story vino a cerrar (el AC decía "las seis" y
// el código tenía ocho).
function nombreDeMuestra(re) {
  return re.source.replace(/^\^/, '').replace(/\((?:[^()\\]|\\.)*\)$/, '').replace(/\$$/, '').replace(/\\(.)/g, '$1');
}
test('WriteFindings_FuenteDelPipeline_SeAceptaSinRoster', () => {
  const L = lab(rosterCon('tycon-plugin-security-basics'));
  const muestras = rlib.FUENTES_SINTETICAS.map(nombreDeMuestra);
  assert.ok(muestras.length >= 6, 'la lista del código se leyó de verdad');
  for (const m of muestras) {
    assert.ok(rlib.FUENTES_SINTETICAS.some((re) => re.test(m)), `la muestra derivada "${m}" tiene que matchear su patrón`);
  }
  const r = escribir(L, muestras.map((m, i) => hallazgo(m, { rule_id: `F-${i}` })));
  assert.strictEqual(r.exit, 0, `las fuentes propias se aceptan sin roster: ${r.out}`);
  const f = leer(L);
  assert.strictEqual(f.length, muestras.length);
  for (const x of f) assert.strictEqual(x.tramo, 'pipeline', `${x.advisor} tiene que quedar marcado como fuente propia`);
  limpiar(L);
});

// ── T4 (AC 7, 8) ─────────────────────────────────────────────────────────────────────────────
// Un control que no puede correr no aprueba, pero tampoco puede dejar al dev sin escribir su
// evidencia. ROJO PREVIO: hoy no hay aviso de ningún tipo.
test('WriteFindings_SinRoster_AvisaYNoFrena', () => {
  const casos = [
    ['sin roster', undefined, /no (existe|se encontr)/i],
    ['roster ilegible', '{ esto no es json', /ileg|no se puede leer|JSON/i],
    ['roster sin lista de revisores', { version: 1, implementer: { kind: 'sesion-principal' } }, /revisores|reviewers/i],
  ];
  for (const [nombre, roster, esperado] of casos) {
    const L = lab(roster);
    const r = escribir(L, [hallazgo('cualquier-cosa-que-no-corrio')]);
    assert.strictEqual(r.exit, 0, `${nombre}: no puede frenar — ${r.out}`);
    assert.ok(fs.existsSync(L.findings), `${nombre}: el findings.json se escribe igual`);
    const salida = JSON.parse(r.out);
    const avisos = (salida.warnings || []).join(' | ');
    assert.match(avisos, /firmante|advisor|roster/i, `${nombre}: tiene que avisar por qué no pudo validar`);
    assert.match(avisos, esperado, `${nombre}: el aviso tiene que distinguir cuál de los tres casos es`);
    limpiar(L);
  }
});

// ── T10 (AC 6b) ──────────────────────────────────────────────────────────────────────────────
// La segunda causa de aquel pull request: el roster cubre la RONDA DEL PASO 5 y `findings.json` toda la
// corrida. `tycon-sibling-pattern-reviewer` corrió en el paso 1 y quedaba fuera por diseño, así
// que CUALQUIER story con un hallazgo del paso 1 disparaba `roster-incoherente`. Siempre.
// ROJO PREVIO: reproducido abajo con un roster armado sin la pieza.
const ledgerDeLosDosTramos = () => ([
  { ts: '2026-09-22T10:00:00Z', advisor: 'general-purpose', repo: '/r', story: STORY_ID },
  { ts: '2026-09-22T10:01:00Z', advisor: 'Explore', repo: '/r', story: STORY_ID },
  { ts: '2026-09-22T10:02:00Z', advisor: 'tycon-story-validator', repo: '/r', story: STORY_ID },
  { ts: '2026-09-22T10:03:00Z', advisor: 'tycon-sibling-pattern-reviewer', repo: '/r', story: STORY_ID },
  { event: 'step5-start', iter: 1 },
  { ts: '2026-09-22T11:00:00Z', advisor: 'tycon-plugin-security-basics', repo: '/r', story: STORY_ID },
]);

test('TramoDelHallazgo_Paso1_NoCuentaComoAusente', () => {
  const roster = rlib.build({ lines: ledgerDeLosDosTramos(), story: STORY_ID, sessionId: 's1' });
  const L = lab(roster);
  const r = escribir(L, [
    hallazgo('tycon-plugin-security-basics'),
    hallazgo('tycon-sibling-pattern-reviewer', { rule_id: 'XPAT-W1' }),
  ]);
  assert.strictEqual(r.exit, 0, `el hallazgo del paso 1 es legítimo y se acepta: ${r.out}`);
  const f = leer(L);
  assert.strictEqual(f[0].tramo, 'revision', 'el revisor de la ronda del paso 5 viene del tramo de revisión');
  assert.strictEqual(f[1].tramo, 'previo', 'el del paso 1 dice de qué tramo viene');

  // Y el cruce, con los tramos escritos, ya no lo cuenta como revisor ausente.
  const v = rlib.validate(roster, { advisoresEnFindings: f.map((x) => ({ advisor: x.advisor, tramo: x.tramo })) });
  assert.ok(v.ok, `el cruce tramo contra tramo no puede dar incoherencia: ${JSON.stringify(v.problemas)}`);

  // ROJO PREVIO reproducido: el mismo hallazgo contra un roster SIN la pieza (como el de AG-2).
  const viejo = { ...roster }; delete viejo.agentes_previos;
  const vViejo = rlib.validate(viejo, { advisoresEnFindings: ['tycon-plugin-security-basics', 'tycon-sibling-pattern-reviewer'] });
  assert.ok(!vViejo.ok && vViejo.problemas.some((p) => p.regla === 'roster-incoherente'),
    'sin la pieza el mismo caso daba roster-incoherente — ése era el defecto');
  limpiar(L);
});

// ── T11 (AC 6c) ──────────────────────────────────────────────────────────────────────────────
// 🔴 SALVAGUARDA: la ventana del paso 5 NO se ensancha. `general-purpose` tiene Write y en los
// pasos 0-4 a veces IMPLEMENTA: certificarlo como revisor volvería falsa la afirmación central de
// la pieza (lo cazó el pase adversarial). Un caso que lo certifique es un ROJO, no un avance.
test('RosterNoAdoptaAgentesQueImplementan', () => {
  const roster = rlib.build({ lines: ledgerDeLosDosTramos(), story: STORY_ID, sessionId: 's1' });
  assert.deepEqual(roster.reviewers.map((x) => x.agent), ['tycon-plugin-security-basics'],
    'reviewers sigue siendo SÓLO la ronda del paso 5');
  const previos = (roster.agentes_previos || []).map((x) => x.agent);
  assert.deepEqual(previos.sort(), ['tycon-sibling-pattern-reviewer', 'tycon-story-validator'].sort(),
    'los agentes de los pasos 0-4 se listan aparte, sin llamarlos revisores');
  const todos = JSON.stringify(roster);
  for (const adhoc of ['general-purpose', 'Explore', 'Plan', '"claude"']) {
    assert.ok(!todos.includes(adhoc), `${adhoc} no puede figurar en NINGUNA lista del roster`);
  }
  // Y firmar un hallazgo con uno de ellos sigue siendo un firmante inválido.
  const L = lab(roster);
  const r = escribir(L, [hallazgo('general-purpose')]);
  assert.notStrictEqual(r.exit, 0, 'un agente que implementa no puede firmar un hallazgo como revisor');
  limpiar(L);
});

// ── Los 5 confirmados del pase adversarial (2026-09-22, run wf_4da83466-b36) ──────────────────
// El pase EJECUTÓ el código y reprodujo cada uno; las pruebas que usó están en
// `<run>/step-05b-probes/`. Estos casos son la promoción de esas pruebas a la suite: sin esto, del
// hallazgo queda el relato y no el código.

// 🔴 EL MÁS GRAVE. `agentes_previos` es una lista que ALCANZA para dar por válido el firmante de un
// hallazgo, y el cruce inverso contra el registro de subagentes sólo recorría `reviewers`. O sea
// que escribiendo a mano un revisor inventado ahí, un hallazgo podía firmarlo y pasar por las dos
// capas — derrotando la afirmación central de la pieza por la puerta que la propia story abrió.
// El portón de CI no puede taparlo: no ve el registro. Se cruza en la máquina o no se cruza.
// ROJO PREVIO: `revisarRosterLocal` devolvía null (commit limpio) con el agente inventado puesto.
test('CruceInverso_AgenteInventadoEnTramoPrevio_TambienSeCaza', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prev-fab-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'prev-fab-repo-'));
  const runsDir = path.join(home, '.claude', '.tycon-pipeline', 'advisor-runs');
  fs.mkdirSync(runsDir, { recursive: true });
  // El registro real: UN solo spawn de verdad.
  fs.writeFileSync(path.join(runsDir, 'sessA.jsonl'),
    `${JSON.stringify({ ts: '2026-09-22T12:00:00.000Z', advisor: 'tycon-real-reviewer', model: null, repo, story: '1.1' })}\n`);
  const runDir = path.join(repo, '.advisors', 'pipeline-runs', '1.1-20260922120000');
  fs.mkdirSync(runDir, { recursive: true });
  const escribirRoster = (previos) => fs.writeFileSync(path.join(runDir, 'review-roster.json'), `${JSON.stringify({
    version: 1, story: '1.1', written_by: 'on-advisor-run.js', ts: '2026-09-22T12:00:00Z',
    base_sha: null, tree_sha: null,
    implementer: { kind: 'sesion-principal', session_id: 'impl', model: null },
    reviewers: [{ agent: 'tycon-real-reviewer', kind: 'subagente', model: null, model_source: 'heredado', ts: null, iter: 1 }],
    ...(previos ? { agentes_previos: previos } : {}),
    iterations: 1, iterations_source: 'ledger',
  }, null, 2)}\n`);
  const freno = () => JSON.parse(execFileSync('node', ['-e',
    `const r = require(${JSON.stringify(path.join(SCRIPTS, 'on-pre-commit.js'))}).revisarRosterLocal(${JSON.stringify(repo)}, '1.1'); process.stdout.write(JSON.stringify(r));`],
  { encoding: 'utf8', env: { ...process.env, HOME: home } }) || 'null');

  // Con un agente que el registro NUNCA vio spawnear, metido a mano en el tramo previo:
  escribirRoster([{ agent: 'tycon-fake-previo', kind: 'subagente', model: null, model_source: 'heredado', ts: null, tramo: 'previo' }]);
  const fab = freno();
  assert.equal(fab && fab.reason, 'roster-fabricado', `un inventado en agentes_previos también frena: ${JSON.stringify(fab)}`);
  assert.ok((fab.inventados || []).includes('tycon-fake-previo'), 'y se lo nombra');

  // Control: el MISMO mecanismo ya cazaba un inventado en `reviewers` — no es que el cruce no ande.
  escribirRoster([{ agent: 'tycon-real-reviewer', kind: 'subagente', model: null, model_source: 'heredado', ts: null, tramo: 'previo' }]);
  assert.equal(freno(), null, 'y un agente que SÍ corrió, en el tramo previo, pasa limpio');
  for (const d of [home, repo]) fs.rmSync(d, { recursive: true, force: true });
});

// Sin marca de ronda en el registro no se pueden afirmar tramos. Pasa de verdad: cuando el freno
// local REGENERA el roster, las líneas vienen del registro ya filtrado y los eventos no están.
// Publicar `agentes_previos` vacío ahí devolvía el defecto original por una puerta lateral (un
// hallazgo del paso 1 volvía a contar como revisor ausente).
// ROJO PREVIO: el roster salía con `agentes_previos` ausente pero con TODO en `reviewers`, sin
// que nada dijera que el corte no se pudo ubicar.
test('SinMarcaDeRonda_ElRosterNoAfirmaTramos', () => {
  const l = (a) => ({ ts: '2026-09-22T10:00:00Z', advisor: a, repo: '/r', story: '9.9' });
  const conCorte = rlib.build({ lines: [l('tycon-story-validator'), { event: 'step5-start', iter: 1 }, l('tycon-plugin-security-basics')], story: '9.9', sessionId: 's1' });
  assert.deepEqual((conCorte.agentes_previos || []).map((x) => x.agent), ['tycon-story-validator'], 'con corte, los tramos se publican');

  const sinCorte = rlib.build({ lines: [l('tycon-story-validator'), l('tycon-plugin-security-basics')], story: '9.9', sessionId: 's1' });
  assert.equal(sinCorte.agentes_previos, undefined,
    'sin corte NO se publica la lista: un `agentes_previos` vacío afirmaría que no hubo nadie en los pasos previos, y lo que pasa es que no se sabe');
});

// En un re-loop, los revisores de la vuelta anterior quedan ANTES del último `step5-start`. Con el
// roster previo en mano el merge los conserva, pero en una regeneración desde cero salían de
// `reviewers` y aparecían en `agentes_previos`: un revisor REAL degradado de tramo, y un
// `roster-incoherente` falso contra él la próxima vez que firmara. El mismo falso positivo que la
// story vino a matar, reencarnado.
// ROJO PREVIO: `tycon-plugin-security-basics` aparecía en agentes_previos tras la 2da ronda.
test('ReLoop_UnRevisorRealNoSeDegradaATramoPrevio', () => {
  const l = (a) => ({ ts: '2026-09-22T10:00:00Z', advisor: a, repo: '/r', story: '9.9' });
  const lines = [
    l('tycon-story-validator'),                       // paso 1, de verdad previo
    { event: 'step5-start', iter: 1 }, l('tycon-plugin-security-basics'),   // ronda 1
    { event: 'step5-start', iter: 2 }, l('tycon-silent-failure-hunter'),    // ronda 2
  ];
  const r = rlib.build({ lines, story: '9.9', sessionId: 's1' });   // desde cero, sin roster previo
  const previos = (r.agentes_previos || []).map((x) => x.agent);
  assert.ok(!previos.includes('tycon-plugin-security-basics'),
    `un revisor de la ronda 1 no puede terminar en el tramo previo: ${JSON.stringify(previos)}`);
  assert.deepEqual(previos, ['tycon-story-validator'], 'ahí sólo va quien de verdad corrió antes del paso 5');
  // Y nadie figura en las dos listas: ante la duda gana REVISOR.
  const enRevisores = new Set(r.reviewers.map((x) => x.agent));
  for (const p of previos) assert.ok(!enRevisores.has(p), `${p} no puede estar en las dos listas`);
});
