#!/usr/bin/env node
/**
 * test-group-findings.js — el pase adversarial paga UNA verificación por problema (story 7.11).
 *
 * 🔴 Caso disparador, medido en la corrida de la story 7.10 (2026-09-20): el pase usó 25 agentes y
 *    2.668.124 tokens. Son 6 cazadores y 19 verificadores — uno por hallazgo. Pero los 19 hallazgos
 *    eran 9 problemas distintos: el mismo defecto reportado por varias lentes con otra redacción, y
 *    cada copia se llevó su propio verificador. ~10 agentes reprodujeron lo ya reproducido.
 *
 * 🔴 Y el riesgo que gobierna el diseño: agrupar dos hallazgos que en realidad eran distintos PIERDE
 *    uno, y nadie se entera — el pase sale igual de verde. Por eso el criterio de «no perder nada» acá
 *    es mecánico y no un juicio: la partición que produce el agrupador tiene que ser un REFINAMIENTO
 *    de la partición real (puede separar de más, jamás juntar de más). Separar de más cuesta un
 *    verificador; juntar de más esconde un defecto.
 *
 * Los casos T3/T4/T5 corren contra el caso REAL de la 7.10 (fixtures/findings-7-10.json, con su
 * procedencia adentro). Los T6/T7/T8 corren el guion REAL del pase bajo workflow-lite con un agente
 * de mentira, sin modelo — el mismo molde que adversarial-probes.test.js.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/test-group-findings.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const LIB = path.join(SCRIPTS, 'lib', 'group-findings.js');
const WFLITE = path.join(SCRIPTS, 'workflow-lite.js');
const WORKFLOW = path.join(SCRIPTS, 'adversarial-verify.workflow.js');
const CASO = path.join(__dirname, 'fixtures', 'findings-7-10.json');

// ------------------------------------------------------------------ T3

test('T3 Agrupa_CasoReal710 — agrupa los 19 hallazgos de la 7.10 y deja escrita la comparación', () => {
  const { agrupar, compararContra } = require(LIB);
  const caso = JSON.parse(fs.readFileSync(CASO, 'utf8'));
  assert.strictEqual(caso.hallazgos.length, 19, 'el caso real son 19 hallazgos');

  const r = agrupar(caso.hallazgos);
  assert.ok(r.clases.length > 0, 'produce clases');
  assert.ok(r.clases.length < caso.hallazgos.length, 'agrupa algo: menos clases que hallazgos');

  // Ningún hallazgo se pierde por el camino: la unión de las clases son los 19, sin repetidos.
  const miembros = r.clases.flatMap((c) => c.miembros).sort((a, b) => a - b);
  assert.deepStrictEqual(miembros, caso.hallazgos.map((_h, i) => i), 'cada hallazgo cae en exactamente una clase');
  for (const c of r.clases) {
    assert.ok(c.miembros.includes(c.representante), 'el representante de la clase es uno de sus miembros');
    assert.ok(typeof c.motivo === 'string' && c.motivo.length > 0, 'cada clase dice POR QUÉ se agrupó');
  }

  // La comparación contra las 9 clases reales queda escrita: cuáles coinciden y cuáles no.
  const cmp = compararContra(r, caso.hallazgos.map((h) => h.clase_real));
  assert.strictEqual(cmp.clases_reales, 9, 'la corrida 7.10 tuvo 9 clases reales');
  assert.ok(Array.isArray(cmp.coinciden), 'lista las clases que el criterio reprodujo exactas');
  assert.ok(Array.isArray(cmp.separadas_de_mas), 'lista las clases reales que el criterio partió, con su motivo');
  for (const s of cmp.separadas_de_mas) assert.ok(s.motivo, 'cada clase partida dice por qué el criterio no las juntó');
  assert.ok(cmp.texto.includes('7.10'), 'la comparación se puede pegar en el informe');
});

// ------------------------------------------------------------------ T4

test('T4 NoPierdeHallazgos — verificar una por clase confirma los MISMOS hallazgos que la 7.10', () => {
  const { agrupar, compararContra } = require(LIB);
  const caso = JSON.parse(fs.readFileSync(CASO, 'utf8'));
  const reales = caso.hallazgos.map((h) => h.clase_real);
  const r = agrupar(caso.hallazgos);
  const cmp = compararContra(r, reales);

  // 🔴 EL GATE DE LA STORY. Una clase producida que contenga hallazgos de dos clases reales distintas
  // significa que UN defecto real se verificó con la prueba de OTRO: se pierde, y el pase sale verde igual.
  assert.deepStrictEqual(
    cmp.juntadas_de_mas, [],
    `el criterio juntó hallazgos de clases reales distintas — NO se cablea: ${JSON.stringify(cmp.juntadas_de_mas)}`
  );
  assert.strictEqual(cmp.pierde, false, 'no se pierde ningún hallazgo');

  // Y el ahorro es real: menos agentes que hallazgos, sin bajar de las 9 clases reales.
  assert.ok(r.clases.length >= cmp.clases_reales, 'nunca menos clases que las reales (eso sería juntar de más)');
  assert.ok(r.resumen.agentes_ahorrados >= 5, `el ahorro tiene que valer la pena; fue ${r.resumen.agentes_ahorrados}`);
});

// ------------------------------------------------------------------ T5

test('T5 AnteLaDudaSepara — dos hallazgos del mismo archivo con síntomas distintos NO se agrupan', () => {
  const { agrupar } = require(LIB);
  const base = { lens: 'traversal-completeness', severity: 'bug', file: 'src/x.js', confidence: 'high' };
  const hallazgos = [
    { ...base, line: 40, summary: 'la exención `lectura-entera-ok:` se evalúa sobre el comando entero', repro: 'un segmento exime a los otros' },
    { ...base, line: 40, summary: 'module.exports es inalcanzable: main() corre al require()', repro: 'require() mata el proceso' },
  ];
  const r = agrupar(hallazgos);
  assert.strictEqual(r.clases.length, 2, 'mismo archivo y misma línea, pero síntomas distintos → separados');
  assert.ok(r.dudas.length >= 1, 'el caso queda REGISTRADO para poder calibrar el criterio con datos');
  assert.ok(r.dudas.every((d) => typeof d.motivo === 'string' && d.motivo), 'cada duda dice por qué no se agrupó');

  // Y el revés: mismo archivo, misma línea y mismo síntoma → sí se agrupan (si no, no ahorra nada).
  const iguales = [
    { ...base, line: 103, summary: 'la regex de redirección matchea cualquier `>`, incluido 2>/dev/null', repro: 'cat a 2>/dev/null no se mide' },
    { ...base, line: 103, summary: 'la exclusión por escritura matchea 2>&1, así que el cat entero escapa', repro: 'cat a 2>&1 no se mide' },
  ];
  assert.strictEqual(agrupar(iguales).clases.length, 1, 'mismo sitio y mismo síntoma → una sola clase');

  // Sin línea declarada, agrupar por «mismo archivo» a secas juntaría cualquier cosa: no alcanza.
  const sinLinea = [
    { ...base, line: null, summary: 'archivoDe() no reconoce `<`', repro: 'x' },
    { ...base, line: null, summary: 'el contador acotadas usa una lista propia', repro: 'y' },
  ];
  assert.strictEqual(agrupar(sinLinea).clases.length, 2, 'sin línea y sin símbolo compartido → separados');
});

// --------------------------------------------- el guion real, con agente de mentira

// El stub contesta como cazador o como verificador según el prompt, y deja un archivo por llamada
// para poder contar cuántos verificadores se abrieron. Tres lentes devuelven 2 hallazgos cada una,
// armados para que caigan en 3 clases de 2 (mismo archivo + misma línea + mismo síntoma).
function mkStub(tmp) {
  const stub = path.join(tmp, 'stub.js');
  fs.writeFileSync(stub, `
const fs = require('fs'); const path = require('path');
const prompt = process.env.TYCON_WFLITE_PROMPT || '';
const dir = ${JSON.stringify(tmp)};
fs.writeFileSync(path.join(dir, 'prompt-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.txt'), prompt);
const F = (line, sum) => ({ severity: 'bug', file: 'src/a.js', line, summary: sum, repro: 'repro ' + line, confidence: 'high' });
const HEREDOC = 'el cuerpo del heredoc se parsea como comandos';
const OFFSET  = 'offset: 0 evade la medición';
const EXPORTS = 'module.exports es inalcanzable sin require.main';
if (/REFUTAR/i.test(prompt)) {
  const m = prompt.match(/Cre\\u00e1 la carpeta (\\S+)/) || prompt.match(/Creá la carpeta (\\S+)/);
  console.log(JSON.stringify({ verdict: 'CONFIRMED', reasoning: 'reproducido', adjusted_severity: 'bug', probe_dir: m ? m[1] : '', todos_el_mismo_defecto: true }));
} else if (/LENTE: completitud/.test(prompt)) {
  console.log(JSON.stringify({ lens: 'traversal-completeness', findings: [F(10, HEREDOC), F(20, OFFSET)] }));
} else if (/LENTE: determinismo/.test(prompt)) {
  console.log(JSON.stringify({ lens: 'determinism-ordering', findings: [F(10, HEREDOC), F(30, EXPORTS)] }));
} else if (/LENTE: falsos negativos/.test(prompt)) {
  console.log(JSON.stringify({ lens: 'false-negative-classification', findings: [F(20, OFFSET), F(30, EXPORTS)] }));
} else {
  console.log(JSON.stringify({ lens: 'otra', findings: [] }));
}
`);
  return stub;
}

function correr(extra) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agrupar-'));
  const stub = mkStub(tmp);
  const out = path.join(tmp, 'out.json');
  const args = { repo: tmp, files: ['src/a.js'], runDir: path.join(tmp, 'run'), ...(extra || {}) };
  delete args.__env;
  const r = spawnSync(process.execPath, [WFLITE, WORKFLOW, '--args', JSON.stringify(args), '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TYCON_WFLITE_AGENT_CMD: `${process.execPath} ${stub}`, ...(extra && extra.__env ? extra.__env : {}) },
  });
  const verificadores = fs.readdirSync(tmp)
    .filter((f) => f.startsWith('prompt-'))
    .filter((f) => /REFUTAR/i.test(fs.readFileSync(path.join(tmp, f), 'utf8'))).length;
  const salida = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  return { r, salida, verificadores, tmp };
}

// ------------------------------------------------------------------ T6

test('T6 LanzaPorClase — con hallazgos de 3 clases se abren 3 verificadores, no 6', () => {
  const { salida, verificadores, r } = correr();
  assert.ok(salida, `el pase no devolvió salida: ${r.stderr}`);
  assert.strictEqual(salida.hallazgos, 6, 'los cazadores reportaron 6 hallazgos');
  assert.strictEqual(salida.clases, 3, 'que son 3 problemas distintos');
  assert.strictEqual(verificadores, 3, 'se abre UN verificador por clase, no uno por hallazgo');

  // Cada hallazgo de la clase queda con el veredicto de su clase Y con cuál se reprodujo (AC 6).
  assert.strictEqual(salida.confirmed.length, 6, 'los 6 hallazgos quedan confirmados, no sólo los 3 representantes');
  for (const c of salida.confirmed) {
    assert.ok(typeof c.clase === 'number' || typeof c.clase === 'string', 'cada hallazgo dice a qué clase pertenece');
    assert.ok(c.verificado_via, 'cada hallazgo dice CUÁL fue el hallazgo que se reprodujo');
  }
});

// ------------------------------------------------------------------ T7

test('T7 VolcadoDiceElAhorro — la salida trae hallazgos, clases y agentes ahorrados', () => {
  const { salida } = correr();
  assert.strictEqual(salida.hallazgos, 6);
  assert.strictEqual(salida.clases, 3);
  assert.strictEqual(salida.agentes_ahorrados, 3, 'ahorro = hallazgos - clases');
});

// ------------------------------------------------------------------ T8

test('T8 ApagadoPorVariable — con la variable puesta, un verificador por hallazgo (como hoy)', () => {
  const { salida, verificadores } = correr({ __env: { TYCON_5B_GROUP: '0' } });
  assert.strictEqual(verificadores, 6, 'apagado = exactamente el comportamiento de antes');
  assert.strictEqual(salida.confirmed.length, 6);
  assert.strictEqual(salida.agentes_ahorrados, 0, 'apagado no ahorra nada, y lo dice');
});

// --------------------------------------- el volcado del marker guarda las clases (AC 7)

test('AC7 — mark-adversarial-result acepta --classes y lo guarda en el volcado del pase', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-clases-'));
  const MARKER = path.join(SCRIPTS, 'marker.js');
  const env = { ...process.env, HOME: tmp, CLAUDE_CODE_SESSION_ID: 'test-7-11' };
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });

  const set = spawnSync(process.execPath, [MARKER, 'set', JSON.stringify({ storyId: '7.11', repoPath: repo, storyPath: path.join(repo, 's.md') })], { encoding: 'utf8', env });
  assert.strictEqual(set.status, 0, `no se pudo armar el marker: ${set.stderr}`);

  const res = spawnSync(process.execPath, [MARKER, 'mark-adversarial-result', '6', '--type', '5b', '--classes', '3', '--tests', '0', '--deferred', '6', '--reason', 'caso de prueba'], { encoding: 'utf8', env });
  assert.strictEqual(res.status, 0, `mark-adversarial-result rechazó --classes: ${res.stderr}`);

  const get = spawnSync(process.execPath, [MARKER, 'get'], { encoding: 'utf8', env });
  const m = JSON.parse(get.stdout);
  const pase = (m.adversarialPasses || []).slice(-1)[0];
  assert.ok(pase, 'quedó anotado el pase');
  assert.strictEqual(pase.confirmados, 6);
  assert.strictEqual(pase.clases, 3, 'el volcado guarda en cuántas clases se agruparon');
  assert.strictEqual(pase.agentes_ahorrados, 3, 'y cuántos agentes se ahorraron, para medir el ratio solo');
});

test('AC7 — el volcado también guarda los hallazgos que quedaron sin verificar (--separate)', () => {
  // Un hallazgo que el verificador declaró «no es el mismo defecto» no lo miró nadie. Si no queda en
  // el volcado, la corrida se cierra y ese hallazgo desaparece sin que nunca haya existido para nadie.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-aparte-'));
  const MARKER = path.join(SCRIPTS, 'marker.js');
  const env = { ...process.env, HOME: tmp, CLAUDE_CODE_SESSION_ID: 'test-7-11-aparte' };
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync(process.execPath, [MARKER, 'set', JSON.stringify({ storyId: '7.11', repoPath: repo, storyPath: path.join(repo, 's.md') })], { encoding: 'utf8', env });

  const ok = spawnSync(process.execPath, [MARKER, 'mark-adversarial-result', '6', '--type', '5b', '--classes', '3', '--separate', '2', '--tests', '0', '--deferred', '6', '--reason', 'x'], { encoding: 'utf8', env });
  assert.strictEqual(ok.status, 0, `rechazó --separate: ${ok.stderr}`);
  const m = JSON.parse(spawnSync(process.execPath, [MARKER, 'get'], { encoding: 'utf8', env }).stdout);
  assert.strictEqual(m.adversarialPasses.slice(-1)[0].a_verificar_aparte, 2, 'queda anotado en el volcado');

  const imposible = spawnSync(process.execPath, [MARKER, 'mark-adversarial-result', '2', '--type', '5b', '--separate', '5', '--tests', '0', '--deferred', '2', '--reason', 'x'], { encoding: 'utf8', env });
  assert.strictEqual(imposible.status, 2, 'más sin verificar que confirmados es imposible');
});

// ------------------- las dos copias del criterio no se separan (la deuda que el propio pase cazó)

test('anti-deriva — el núcleo copiado dentro del pase es IDÉNTICO al de lib/group-findings.js', () => {
  // 🔴 Por qué existe este caso: el pase corre en una caja sin `require`, así que el criterio va
  // copiado adentro del guion. Dos copias que se separan es exactamente el defecto que este mismo
  // pase encontró en la corrida 7.10 («el contador acotadas usa una lista duplicada y
  // desincronizada de CONFIG»): la copia vieja sigue andando y nadie se entera.
  const { nucleo } = require(LIB);
  const wf = fs.readFileSync(WORKFLOW, 'utf8');
  const i = wf.indexOf('// ===== NUCLEO-AGRUPAR: INICIO =====');
  const j = wf.indexOf('// ===== NUCLEO-AGRUPAR: FIN =====');
  assert.ok(i >= 0 && j > i, 'el pase tiene que traer el núcleo entre sus marcas');
  assert.strictEqual(
    wf.slice(i, j).trimEnd(),
    nucleo(),
    'las dos copias del criterio se separaron — re-sincronizá: node lib/group-findings.js --emit-core'
  );
});

// ------------- un verificador muerto NO arrastra a su clase en silencio (vuelta 2, SILENT-C2)

test('verificador muerto — la clase queda SIN VEREDICTO y el pase lo dice, no la da por refutada', () => {
  // 🔴 Caso del cazador de fallos silenciosos (2026-09-20): `agent()` devuelve null cuando el agente
  // muere o no contesta JSON válido, y eso se trataba igual que un REFUTED real. Antes costaba un
  // hallazgo; con la agrupación cuesta la CLASE ENTERA — varios hallazgos de lentes distintas
  // desaparecen del reporte y el pase sale verde. Agrupar sin contar esto multiplica el agujero.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agrupar-muerto-'));
  const stub = path.join(tmp, 'stub.js');
  fs.writeFileSync(stub, `
const prompt = process.env.TYCON_WFLITE_PROMPT || '';
const F = (line, sum) => ({ severity: 'bug', file: 'src/a.js', line, summary: sum, repro: 'r' + line, confidence: 'high' });
if (/REFUTAR/i.test(prompt)) { console.log('esto no es JSON'); process.exit(0); }
if (/LENTE: completitud/.test(prompt)) { console.log(JSON.stringify({ lens: 'traversal-completeness', findings: [F(10, 'el cuerpo del heredoc se parsea como comandos')] })); }
else { console.log(JSON.stringify({ lens: 'otra', findings: [] })); }
`);
  const out = path.join(tmp, 'out.json');
  const args = { repo: tmp, files: ['src/a.js'], runDir: path.join(tmp, 'run') };
  const r = spawnSync(process.execPath, [WFLITE, WORKFLOW, '--args', JSON.stringify(args), '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TYCON_WFLITE_AGENT_CMD: `${process.execPath} ${stub}` },
  });
  const salida = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  assert.ok(salida, `el pase no devolvió salida: ${r.stderr}`);
  assert.strictEqual(salida.hallazgos, 1, 'hubo un hallazgo');
  assert.strictEqual(salida.clases, 1, 'que es una clase');
  assert.strictEqual(salida.confirmed.length, 0, 'sin veredicto no se confirma nada (default REFUTED sigue valiendo)');
  assert.strictEqual(salida.sin_veredicto, 1, 'pero la clase sin respuesta técnica se CUENTA y se devuelve');
  assert.match(r.stderr, /sin veredicto|no contest|sin respuesta/i, 'y se avisa por el registro del pase');
});

test('AC7 — --classes rechaza lo que no es un entero y lo que supera a los confirmados', () => {
  // El camino feliz ya está cubierto arriba. Acá el que NO lo está: un `--classes` basura o mayor que
  // los hallazgos deja el volcado mintiendo sobre el ahorro, y el ratio se mide solo a partir de ahí.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-clases-mal-'));
  const MARKER = path.join(SCRIPTS, 'marker.js');
  const env = { ...process.env, HOME: tmp, CLAUDE_CODE_SESSION_ID: 'test-7-11-mal' };
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync(process.execPath, [MARKER, 'set', JSON.stringify({ storyId: '7.11', repoPath: repo, storyPath: path.join(repo, 's.md') })], { encoding: 'utf8', env });

  const correr = (clases) => spawnSync(
    process.execPath,
    [MARKER, 'mark-adversarial-result', '6', '--type', '5b', '--classes', clases, '--tests', '0', '--deferred', '6', '--reason', 'x'],
    { encoding: 'utf8', env }
  );

  const basura = correr('tres');
  assert.strictEqual(basura.status, 2, 'un --classes que no es número tiene que frenar');
  assert.match(basura.stderr, /entero/i, 'y decir por qué');

  const imposible = correr('9');
  assert.strictEqual(imposible.status, 2, 'más causas que hallazgos es imposible');
  assert.match(imposible.stderr, /no puede haber m[aá]s causas que hallazgos/i, 'y lo dice en criollo');

  // 🔴 Y el otro extremo, que el pase adversarial cazó: cero causas con hallazgos confirmados anota
  // un ahorro igual al total y deja el ratio mintiendo para siempre.
  const cero = correr('0');
  assert.strictEqual(cero.status, 2, 'cero causas con hallazgos es imposible');
  assert.match(cero.stderr, /al menos una causa/i, 'y lo dice');

  const get = spawnSync(process.execPath, [MARKER, 'get'], { encoding: 'utf8', env });
  const m = JSON.parse(get.stdout);
  assert.strictEqual((m.adversarialPasses || []).length, 0, 'ninguno de los dos dejó nada anotado');
});

// ═══════════ vuelta 3: lo que encontró el pase adversarial sobre el propio criterio ═══════════
//
// 🔴 El criterio de la vuelta 1 estaba AJUSTADO AL ÚNICO CASO que tenía (la corrida 7.10, donde cada
// problema vivía en una línea distinta). El pase lo ejecutó contra casos de otros dominios y mostró
// que juntaba de más: el «veto por síntoma» sólo frena cuando las DOS descripciones caen en el
// vocabulario cerrado de 8 categorías sacado de aquel archivo. Fuera de ahí el veto queda inerte y
// «mismo archivo + misma línea» funde cualquier par.
//
// El arreglo invierte la carga de la prueba: para juntar hace falta una señal POSITIVA de que son el
// mismo defecto, no la ausencia de señal de que son distintos.

test('vuelta 3 — mismo archivo y misma línea, sin NADA más en común, NO se juntan', () => {
  const { agrupar } = require(LIB);
  const base = { lens: 'traversal-completeness', severity: 'bug', file: 'src/x.js', line: 50, confidence: 'high' };
  const hallazgos = [
    { ...base, summary: 'binarySearch() usa < en vez de <= en el punto medio: loop infinito con repetidos', repro: 'array con dos iguales' },
    { ...base, summary: 'processQueue() tiene una carrera: dos llamadas concurrentes procesan el mismo item', repro: 'dos llamadas a la vez' },
  ];
  const r = agrupar(hallazgos);
  assert.strictEqual(r.clases.length, 2, 'dos bugs sin relación no se funden por caer en la misma línea');
  assert.ok(r.dudas.length >= 1, 'y el caso queda REGISTRADO (AC 5), que antes ni eso pasaba');
});

test('vuelta 3 — sin línea, compartir sólo el nombre de la función NO alcanza', () => {
  const { agrupar } = require(LIB);
  const base = { lens: 'traversal-completeness', severity: 'bug', file: 'src/pay.js', line: null, confidence: 'high' };
  const hallazgos = [
    { ...base, summary: 'En processPayment(), redondeo con Math.floor en vez de Math.round: subcobra', repro: 'monto 10.99' },
    { ...base, summary: 'processPayment() traga el error del gateway externo: el timeout no se propaga', repro: 'gateway caído' },
  ];
  const r = agrupar(hallazgos);
  assert.strictEqual(r.clases.length, 2, 'el nombre de la función que los contiene no prueba que sean el mismo defecto');
  assert.ok(r.dudas.length >= 1, 'y queda registrado');
});

test('vuelta 3 — el criterio SIGUE agrupando lo que sí es el mismo defecto (no se volvió inútil)', () => {
  const { agrupar, compararContra } = require(LIB);
  const caso = JSON.parse(fs.readFileSync(CASO, 'utf8'));
  const r = agrupar(caso.hallazgos);
  const cmp = compararContra(r, caso.hallazgos.map((h) => h.clase_real));
  assert.deepStrictEqual(cmp.juntadas_de_mas, [], 'sigue sin juntar de más');
  assert.ok(r.resumen.agentes_ahorrados >= 5, `y sigue ahorrando; ahorró ${r.resumen.agentes_ahorrados}`);
});

test('vuelta 3 — compararContra no canta "coincide" si la clase producida mezcla otra clase real', () => {
  // 🔴 El pase lo cazó: alcanzaba con que los miembros de una clase real cayeran TODOS en una misma
  // clase producida, sin mirar si esa clase producida traía además miembros de otra clase real.
  const { compararContra } = require(LIB);
  const fabricado = {
    clases: [{ id: 1, miembros: [0, 1, 2], representante: 0, motivo: 'fabricado para el test' }],
    dudas: [],
    resumen: { hallazgos: 3, clases: 1, agentes_ahorrados: 2 },
  };
  const cmp = compararContra(fabricado, ['A', 'A', 'B']);
  assert.ok(!cmp.coinciden.includes('A'), 'A no "coincide": su clase producida se comió también a B');
  assert.strictEqual(cmp.juntadas_de_mas.length, 1, 'y queda reportado como juntada de más');
  assert.strictEqual(cmp.pierde, true);
});

test('vuelta 3 — si el verificador dice que uno NO es el mismo defecto, ese hallazgo no se da por verificado', () => {
  // 🔴 El pase lo cazó: el prompt le pedía al verificador «si alguno NO es el mismo defecto, decilo»,
  // pero su respuesta sólo tenía lugar para UN veredicto de clase y nadie leía ese texto. O sea: el
  // escape hatch era decorativo, y un bug real quedaba marcado como verificado sin que nadie lo
  // hubiera reproducido.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agrupar-distinto-'));
  const stub = path.join(tmp, 'stub.js');
  fs.writeFileSync(stub, `
const prompt = process.env.TYCON_WFLITE_PROMPT || '';
const F = (line, sum) => ({ severity: 'bug', file: 'src/a.js', line, summary: sum, repro: 'r', confidence: 'high' });
const S = 'el cuerpo del heredoc se parsea como comandos';
if (/REFUTAR/i.test(prompt)) {
  console.log(JSON.stringify({ verdict: 'CONFIRMED', reasoning: 'el segundo resultó ser otra cosa', adjusted_severity: 'bug', probe_dir: '', todos_el_mismo_defecto: false }));
} else if (/LENTE: completitud/.test(prompt)) { console.log(JSON.stringify({ lens: 'traversal-completeness', findings: [F(10, S), F(10, S + ' (otra lente)')] })); }
else { console.log(JSON.stringify({ lens: 'otra', findings: [] })); }
`);
  const out = path.join(tmp, 'out.json');
  const r = spawnSync(process.execPath, [WFLITE, WORKFLOW, '--args', JSON.stringify({ repo: tmp, files: ['src/a.js'], runDir: path.join(tmp, 'run') }), '--out', out], {
    encoding: 'utf8', env: { ...process.env, TYCON_WFLITE_AGENT_CMD: `${process.execPath} ${stub}` },
  });
  const salida = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  assert.ok(salida, `sin salida: ${r.stderr}`);
  assert.strictEqual(salida.hallazgos, 2);
  assert.strictEqual(salida.clases, 1, 'el criterio los juntó');
  assert.strictEqual(salida.confirmed.length, 1, 'sólo el representante queda confirmado: el otro no lo reprodujo nadie');
  assert.strictEqual(salida.a_verificar_aparte, 1, 'y el otro queda contado para verificarse aparte');
  assert.match(r.stderr, /aparte|no (es|son) el mismo/i, 'y se avisa');
});

test('vuelta 3b — si la respuesta del verificador no es un SÍ limpio, no se hereda el veredicto', () => {
  // 🔴 `=== false` dejaba pasar null, "" o el string "false": cualquier cosa que no fuera el booleano
  // false se leía como «sí, son el mismo defecto» y TODOS los miembros heredaban CONFIRMED sin que
  // nadie los hubiera reproducido. Invertía el principio de la story: ante la duda, heredaba.
  const casos = ['null', '""', '"false"', 'undefined'];
  for (const valor of casos) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agrupar-turbio-'));
    const stub = path.join(tmp, 'stub.js');
    fs.writeFileSync(stub, `
const prompt = process.env.TYCON_WFLITE_PROMPT || '';
const F = (line, sum) => ({ severity: 'bug', file: 'src/a.js', line, summary: sum, repro: 'r', confidence: 'high' });
const S = 'el cuerpo del heredoc se parsea como comandos';
if (/REFUTAR/i.test(prompt)) {
  console.log(JSON.stringify({ verdict: 'CONFIRMED', reasoning: 'turbio', adjusted_severity: 'bug', probe_dir: '', todos_el_mismo_defecto: ${valor} }));
} else if (/LENTE: completitud/.test(prompt)) { console.log(JSON.stringify({ lens: 'traversal-completeness', findings: [F(10, S), F(10, S + ' (otra lente)')] })); }
else { console.log(JSON.stringify({ lens: 'otra', findings: [] })); }
`);
    const out = path.join(tmp, 'out.json');
    spawnSync(process.execPath, [WFLITE, WORKFLOW, '--args', JSON.stringify({ repo: tmp, files: ['src/a.js'], runDir: path.join(tmp, 'run') }), '--out', out], {
      encoding: 'utf8', env: { ...process.env, TYCON_WFLITE_AGENT_CMD: `${process.execPath} ${stub}` },
    });
    const salida = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
    if (!salida) continue; // una respuesta que el esquema rechaza entero también es un no-hereda válido
    assert.ok(salida.confirmed.length <= 1,
      `con todos_el_mismo_defecto = ${valor} no se puede heredar el veredicto a la clase entera (confirmó ${salida.confirmed.length})`);
  }
});
