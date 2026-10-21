'use strict';
/**
 * Paridad de las DOS validaciones del registro de autoría.
 *
 * La validación del roster está escrita dos veces a propósito: el portón de CI corre en un agente
 * que sólo hace checkout de los repos, sin `~/.claude/`, así que no puede importar la lib del
 * skill. Dos copias del mismo criterio terminan divergiendo (el regex que lee la fecha del run dir y la
 * política ante fecha ilegible son lo primero que se separa entre capas).
 *
 * 🔴 Este archivo es el caso que cuida la paridad que el comentario del portón promete: un control
 * documentado que no corre es el pecado que el arnés más persigue.
 *
 * Si la lib del skill no está instalada (una máquina sin el arnés, o CI), el test NO pasa en
 * silencio: avisa fuerte y se saltea — un skip mudo sería otra vez el mismo pecado.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gate = require(path.join(__dirname, '..', 'ci', 'tycon-ci-gate.js'));
const libPath = path.join(os.homedir(), '.claude', 'agent-skills', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'review-roster.js');

let lib = null;
try { lib = require(libPath); } catch { /* sin el skill instalado */ }

const rev = (agent, extra = {}) => ({ agent, kind: 'subagente', ...extra });
const CASOS = [
  ['válido', { version: 1, implementer: { kind: 'sesion-principal', session_id: 's1' }, reviewers: [rev('a')] }, null],
  ['sin revisores', { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [] }, null],
  ['version desconocida', { version: 9, implementer: { kind: 'sesion-principal' }, reviewers: [rev('a')] }, null],
  ['sin implementer', { version: 1, reviewers: [rev('a')] }, null],
  ['reviewers no es lista', { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: 'a' }, null],
  ['revisor sin nombre', { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [{ kind: 'subagente' }] }, null],
  ['el autor figura como revisor', { version: 1, implementer: { kind: 'sesion-principal', session_id: 's1' }, reviewers: [{ agent: 'yo', kind: 'sesion-principal' }] }, null],
  ['no es un objeto', 'nada', null],
  ['findings coherentes', { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [rev('a')] }, ['a']],
  ['findings con un advisor ausente', { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [rev('a')] }, ['fantasma']],
  ['findings con fuentes del propio pipeline', { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [rev('a')] }, ['mech-check', 'adversarial-verify:x', 'pipeline']],
  // Las cinco fuentes REALES del pipeline, medidas sobre los runs del disco. Una es
  // una variante de un patrón conocido — por eso se reconoce el prefijo, no el nombre exacto.
  ['findings con las fuentes del pipeline que faltaban', { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [rev('a')] },
    ['orquestador', 'orquestador (smoke AC 15)', 'runtime-matrix (smoke AC 14)', 'adversarial-verify (3 lentes)', 'ensayo runtime (no advisor)']],
  // Los pases adversariales nombrados con guion no deben dar roster-incoherente.
  ['findings con pases adversariales nombrados con guion', { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [rev('a')] },
    ['adversarial-verify-fable', 'adversarial-verify-opus', 'adversarial-verify-sonnet-final', 'adversarial-verify-sonnet-pase2', 'adversarial-verify-5b']],
  ['findings con un advisor que se parece pero no es', { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [rev('a')] }, ['orquestadorx', 'el orquestador', 'adversarial-verifyx']],
  // Cinco nombres reales que frenarían el portón. Cuatro son el MISMO revisor del roster con la vuelta o el
  // modelo pegados entre paréntesis, y uno es el gate de E2E, que tampoco es un spawn. Ninguno es un revisor
  // ausente.
  ['findings con la vuelta pegada al nombre del revisor',
    { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [rev('tycon-silent-failure-hunter'), rev('tycon-plugin-security-basics')] },
    ['tycon-silent-failure-hunter (iter 3)', 'tycon-plugin-security-basics (iter 4)', 'pase adversarial (5b, opus)', 'e2e-runtime']],
  // 🔴 El recorte del paréntesis NO puede tapar a un revisor que de verdad no corrió: `tycon-sibling-
  // pattern-reviewer` sigue siendo incoherente, con o sin adorno.
  ['un revisor ausente de verdad sigue siéndolo aunque traiga paréntesis',
    { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [rev('tycon-silent-failure-hunter')] },
    ['tycon-sibling-pattern-reviewer', 'tycon-sibling-pattern-reviewer (iter 2)']],
  // Un paréntesis en el medio no se toca: sólo se recorta el del final.
  ['el recorte no fusiona dos agentes distintos',
    { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [rev('a')] },
    ['b (x) c', 'a b']],
  // ── El hallazgo dice de qué TRAMO viene, y el cruce compara tramo contra tramo ──
  // El roster cubre la ronda del paso 5 y `findings.json` toda la corrida: sin el tramo, un hallazgo del paso 1
  // daría `roster-incoherente` SIEMPRE. Las dos copias tienen que entender la forma del tramo igual, o el dev ve una cosa en la máquina y otra en el PR.
  ['un hallazgo del paso 1 contra el tramo que le corresponde',
    { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [rev('a')],
      agentes_previos: [rev('tycon-story-validator')] },
    [{ advisor: 'a', tramo: 'revision' }, { advisor: 'tycon-story-validator', tramo: 'previo' }]],
  ['un hallazgo del paso 1 con un firmante que NO estuvo en ese tramo sigue siendo incoherencia',
    { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [rev('a')],
      agentes_previos: [rev('tycon-story-validator')] },
    [{ advisor: 'tycon-fantasma', tramo: 'previo' }]],
  ['un revisor de la ronda NO se cuela por el tramo del paso 1, ni al revés',
    { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [rev('a')],
      agentes_previos: [rev('tycon-story-validator')] },
    [{ advisor: 'tycon-story-validator', tramo: 'revision' }]],
  ['la forma vieja (strings pelados) sigue valiendo: un roster con tramos no rompe a quien no los manda',
    { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [rev('a')],
      agentes_previos: [rev('tycon-story-validator')] },
    ['a', 'tycon-story-validator']],
  ['un roster SIN la pieza nueva se sigue juzgando como siempre',
    { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [rev('a')] },
    [{ advisor: 'fantasma', tramo: 'revision' }]],
];

test('las dos validaciones del roster dan el MISMO veredicto en todos los casos', (t) => {
  if (!lib) {
    console.error(`⚠️  paridad NO verificada: no está ${libPath} (¿máquina sin el arnés?).\n` +
      '   No es un verde: es un control que no pudo correr.');
    t.skip('lib del skill ausente');
    return;
  }
  // 🔴 Las LISTAS, no sólo los veredictos sobre casos fijos: una regex DE MÁS en una copia dejaría este test verde con veredictos opuestos
  // sobre el advisor que sólo esa copia reconocía — los casos cubren las fuentes reales, no una
  // entrada que exista en una sola lista. Igual que closing-evidence-parity.test.js.
  assert.deepEqual((gate.FUENTES_SINTETICAS || []).map(String).sort(), (lib.FUENTES_SINTETICAS || []).map(String).sort(),
    'las dos listas FUENTES_SINTETICAS tienen que ser idénticas, patrón por patrón');
  assert.ok((gate.FUENTES_SINTETICAS || []).length >= 6, 'la lista del portón se exporta y no está vacía');
  for (const [nombre, roster, advisores] of CASOS) {
    const a = lib.validate(roster, advisores ? { advisoresEnFindings: advisores } : undefined);
    const b = gate.validarRoster(roster, advisores);
    assert.equal(b.ok, a.ok, `veredicto distinto en "${nombre}": skill=${a.ok} ci=${b.ok}`);
    assert.deepEqual(
      b.problemas.map((p) => p.regla).sort(),
      a.problemas.map((p) => p.regla).sort(),
      `reglas distintas en "${nombre}"`,
    );
  }
});

// ── El tramo, con VEREDICTO esperado ────────────────────────────────────────────
// 🔴 La paridad sola no alcanza acá y es una trampa conocida: compara las dos copias ENTRE SÍ, así
// que si las dos ignoran los tramos igual, el test sale verde con el comportamiento mal. Este caso
// fija lo que tiene que PASAR, no sólo que las dos opinen lo mismo.
// Falla si: ninguna de las dos entiende `{advisor, tramo}` — lo pasa por String(), le sale
// `[object Object]`, y las dos dan `roster-incoherente` en los cuatro casos.
const ROSTER_DOS_TRAMOS = {
  version: 1, implementer: { kind: 'sesion-principal' },
  reviewers: [rev('tycon-plugin-security-basics')],
  agentes_previos: [rev('tycon-story-validator')],
};
const VEREDICTOS = [
  ['el firmante de la ronda del paso 5', [{ advisor: 'tycon-plugin-security-basics', tramo: 'revision' }], []],
  ['el firmante del paso 1, contra SU tramo', [{ advisor: 'tycon-story-validator', tramo: 'previo' }], []],
  ['un firmante que no estuvo en ningún tramo', [{ advisor: 'tycon-fantasma', tramo: 'previo' }], ['roster-incoherente']],
  ['un firmante del paso 1 que se declara de la ronda (y al revés) NO se cuela',
    [{ advisor: 'tycon-story-validator', tramo: 'revision' }], ['roster-incoherente']],
  ['la forma vieja, strings pelados, sigue valiendo contra los dos tramos',
    ['tycon-plugin-security-basics', 'tycon-story-validator'], []],
];

test('el cruce compara tramo contra tramo — en las DOS copias, con el veredicto que corresponde', () => {
  if (!lib) { console.error('⚠️  paridad NO verificada: falta la lib del skill.'); return; }
  for (const [nombre, firmantes, esperadas] of VEREDICTOS) {
    for (const [capa, res] of [
      ['skill', lib.validate(ROSTER_DOS_TRAMOS, { advisoresEnFindings: firmantes })],
      ['portón', gate.validarRoster(ROSTER_DOS_TRAMOS, firmantes)],
    ]) {
      assert.deepEqual(res.problemas.map((x) => x.regla).sort(), [...esperadas].sort(),
        `${capa} — "${nombre}": ${JSON.stringify(res.problemas)}`);
    }
  }
});

// ── T8 — dos rosters REALES, versionados como dato de prueba ───────────────
// Mide el recorte del paréntesis sobre los dos rosters reales: con el recorte, un
// solo hallazgo. Es la medición que decide si el recorte se retira o se queda con su razón.
// Los fixtures están anonimizados (ver su LEEME.md); los nombres, que es lo que el caso mide,
// están enteros.
const FIXTURES = path.join(__dirname, 'fixtures');
const firmantesDe = (dir) => [...new Set(JSON.parse(fs.readFileSync(path.join(FIXTURES, dir, 'findings.json'), 'utf8'))
  .map((f) => f.advisor).filter(Boolean))];
const rosterDe = (dir) => JSON.parse(fs.readFileSync(path.join(FIXTURES, dir, 'review-roster.json'), 'utf8'));

test('los rosters reales de AG-2 y AG-3 dan UN hallazgo, no cinco', () => {
  const ag2 = gate.validarRoster(rosterDe('roster-ag2'), firmantesDe('roster-ag2'));
  const incoherentes = ag2.problemas.filter((p) => p.regla === 'roster-incoherente');
  assert.equal(incoherentes.length, 1, `AG-2 tiene que dar exactamente 1: ${JSON.stringify(ag2.problemas)}`);
  assert.match(incoherentes[0].detalle, /tycon-sibling-pattern-reviewer/,
    'el único que queda es el revisor del paso 1, que es real — los otros cuatro eran del propio control');

  const ag3 = gate.validarRoster(rosterDe('roster-ag3'), firmantesDe('roster-ag3'));
  assert.equal(ag3.problemas.filter((p) => p.regla === 'roster-incoherente').length, 0,
    `AG-3 tiene que salir limpio: ${JSON.stringify(ag3.problemas)}`);
});

// 🔴 POR QUÉ EL RECORTE SE QUEDA. Hay corridas YA COMMITEADAS con la anotación pegada al nombre, y una
// máquina con el skill viejo las sigue escribiendo hasta que actualice. El cruce conserva la tolerancia de
// quien LEE mientras exista ese histórico, aunque a quien ESCRIBE se le exija elegir el firmante. Este caso
// mide el precio exacto de retirarlo: AG-2 pasaría de 1 hallazgo a 3.
test('sin el recorte, los mismos rosters vuelven a marcar al revisor que sí corrió', () => {
  const roster = rosterDe('roster-ag2');
  const nombres = new Set(roster.reviewers.map((r) => r.agent));   // SIN nombreCanonico, a propósito
  const crudos = firmantesDe('roster-ag2').filter((a) => !gate.FUENTES_SINTETICAS.some((re) => re.test(a)) && !nombres.has(a));
  assert.ok(crudos.length > 1,
    `sin el recorte el cruce marca más de uno (medido: ${crudos.length} → ${crudos.join(', ')})`);
  assert.ok(crudos.some((a) => /\(iter \d+\)$/.test(a)),
    'y los de más son el MISMO revisor con la vuelta pegada — exactamente los falsos positivos de aquel pull request');
});

// ── El hallazgo VALIDADO al escribirse se distingue del que nadie validó ─────────────────────
// `roster-incoherente` avisa y no frena cuando nadie validó el hallazgo. El firmante se valida contra el
// registro AL ESCRIBIR el hallazgo, pero eso vale para los hallazgos NUEVOS: las corridas viejas siguen
// marcando por el formato anterior, y frenar de golpe por ellas sería un falso positivo.
//
// La marca no es la fecha ni una lista: es el propio hallazgo. `tramo` lo escribe `write-findings`
// SÓLO cuando pudo leer el registro y ubicar al firmante — o sea, cuando la validación de verdad
// ocurrió. Un hallazgo con `tramo` que igual no cuadra es una incoherencia REAL y frena; uno sin
// `tramo` nadie lo validó, así que sigue avisando. Se enciende solo a medida que las corridas
// viejas dejan de cerrarse: sin día de corte y sin que nadie tenga que acordarse.
// 🔴 Falla si: los dos casos salen iguales, sin nada que permita separarlos.
test('un hallazgo incoherente se marca como validado SÓLO si venía con su tramo', () => {
  const roster = { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [rev('tycon-real')] };
  const nuevo = [{ advisor: 'tycon-fantasma', tramo: 'revision' }];   // lo escribió write-findings validando
  const viejo = ['tycon-fantasma'];                                   // formato viejo: nadie lo validó

  for (const [capa, val] of [['portón', gate.validarRoster], ['skill', null]]) {
    const corre = (adv) => (val ? val(roster, adv) : lib.validate(roster, { advisoresEnFindings: adv }));
    if (!val && !lib) continue;
    const n = corre(nuevo).problemas.find((p) => p.regla === 'roster-incoherente');
    const v = corre(viejo).problemas.find((p) => p.regla === 'roster-incoherente');
    assert.ok(n && v, `${capa}: los dos siguen siendo incoherencia`);
    assert.equal(n.validado, true, `${capa}: el hallazgo con tramo viene de una escritura validada → puede frenar`);
    assert.ok(!v.validado, `${capa}: el del formato viejo NO se marca → sigue avisando`);
  }
});

// ── el portón del repo de la STORY acepta el roster proyectado ────────────────────────
// La proyección (`projected_from`) la ejercita el freno local, que es quien la necesita para
// encontrar el testigo. Acá se mide contra el portón mismo: el portón no sabe nada de procedencia
// —ni la necesita, porque no ve el registro de subagentes— y un roster proyectado tiene que
// pasarle igual que uno nacido en el repo.
test('el portón acepta un roster proyectado desde el repo del código (AC 9)', () => {
  const roster = rosterDe('roster-ag3');
  const proyectado = { ...roster, projected_from: { repo: '/otro/repo/Backend', run_dir: '/otro/repo/Backend/.advisors/pipeline-runs/AG-3-iter1' } };
  const v = gate.validarRoster(proyectado, firmantesDe('roster-ag3'));
  assert.ok(v.ok, `un roster proyectado pasa el portón igual que uno propio: ${JSON.stringify(v.problemas)}`);
  // …y la anotación de procedencia no vuelve válido a un roster que no lo es.
  const roto = { ...proyectado, reviewers: [] };
  assert.ok(!gate.validarRoster(roto, []).ok, '`projected_from` no es un permiso: un roster sin revisores sigue sin valer');
});

// ── El portón tampoco puede APAGAR el cruce en silencio ──────────────────────────────────────
// Un JSON roto avisa, y un JSON válido con otra forma (`{"status":"ok"}`) también: si cayera a `[]` mudo, el
// cruce no correría y el punto ciego quedaría abierto sin decirlo. Los tres caminos del portón
// tienen que ser los mismos que los del freno local.
// 🔴 Falla si: con `{"status":"ok"}` devuelve [] sin una línea a stderr.
test('el portón avisa cuando no puede leer los hallazgos, en los TRES caminos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-findings-'));
  const fj = path.join(dir, 'findings.json');
  const capturar = (fn) => {
    const orig = console.error; const dicho = [];
    console.error = (...a) => dicho.push(a.join(' '));
    try { return { r: fn(), dicho: dicho.join('\n') }; } finally { console.error = orig; }
  };

  // (a) ausente → mudo y null: es el camino normal (una corrida puede no tener hallazgos).
  const ausente = capturar(() => gate.advisoresEnFindings(dir));
  assert.equal(ausente.r, null);
  assert.equal(ausente.dicho, '', 'el archivo ausente no genera ruido');

  // (b) JSON roto → avisa y null, SIN filtrar la ruta absoluta ni un pedazo del archivo.
  // Este aviso sale por el registro público de la corrida: mismo criterio que `cierre-recortado`
  // T10 le exige a la constancia del cierre.
  fs.writeFileSync(fj, '[{ "secreto-del-cliente": 1');
  const roto = capturar(() => gate.advisoresEnFindings(dir));
  assert.equal(roto.r, null);
  assert.match(roto.dicho, /findings\.json/, 'el JSON roto deja rastro');
  assert.ok(!roto.dicho.includes(dir), 'pero NO la ruta absoluta del checkout');
  assert.ok(!/secreto-del-cliente/.test(roto.dicho), 'ni un fragmento del archivo (el parser lo arrastra)');

  // (c) JSON válido con otra forma → avisa y null
  fs.writeFileSync(fj, '{"status":"ok"}');
  const raro = capturar(() => gate.advisoresEnFindings(dir));
  assert.equal(raro.r, null, 'no puede devolver [] como si no hubiera hallazgos');
  assert.match(raro.dicho, /no es una lista/, 'y dice por qué no pudo');

  // (d) las dos formas legítimas siguen funcionando, sin ruido
  fs.writeFileSync(fj, JSON.stringify([{ advisor: 'a', tramo: 'revision' }, { advisor: 'b' }]));
  const lista = capturar(() => gate.advisoresEnFindings(dir));
  assert.deepEqual(lista.r, [{ advisor: 'a', tramo: 'revision' }, 'b']);
  assert.equal(lista.dicho, '', 'el camino feliz no avisa nada');
  fs.writeFileSync(fj, JSON.stringify({ findings: [{ advisor: 'c' }] }));
  assert.deepEqual(capturar(() => gate.advisoresEnFindings(dir)).r, ['c'], '`{findings: […]}` sigue valiendo');
  fs.rmSync(dir, { recursive: true, force: true });
});
