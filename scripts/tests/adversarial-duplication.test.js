#!/usr/bin/env node
/**
 * adversarial-duplication.test.js — red de `scripts/metrics/adversarial-duplication.js` (story 7.11).
 *
 * Qué fija esta suite (T1 y T2 de la tabla `### Tests` de la story):
 *   T1 `Ratio_CruzaLasDosFuentes` (AC 1) — el buzón dice CUÁNTOS hallazgos tuvo cada pase; el repo
 *      dice en cuántas CAUSAS se agrupaban. Cruzarlos da el ratio por pase, con mediana y percentiles
 *      sobre TODOS los pases medibles, no sobre uno.
 *   T2 `Ratio_DiceLoQueNoPudoMedir` (AC 2) — un pase del buzón cuyos hallazgos no están en ningún
 *      repo NO se estima ni se descarta en silencio: se cuenta aparte y el resumen dice sobre cuántos
 *      se midió y cuántos quedaron afuera.
 *
 * 🔴 Por qué importa el T2: el 40 % que originó la story salía de UNA corrida. Un medidor que promedia
 *    sólo lo que pudo leer y no declara el resto repite el mismo error con más decimales.
 *
 * Todo corre contra un buzón y repos de mentira armados en un tmpdir: no se lee el buzón real ni
 * ningún volcado archivado (Task 1 de la story — la medición no toca el estado guardado).
 *
 * Correr: node scripts/tests/adversarial-duplication.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MOD = path.resolve(__dirname, '..', 'metrics', 'adversarial-duplication.js');

let n = 0;
function t(name, fn) {
  n++;
  try { fn(); console.log(`  ok ${n} - ${name}`); } catch (e) { console.error(`  FAIL ${n} - ${name}\n    ${e && e.message}`); process.exitCode = 1; }
}

// ---------------------------------------------------------------- andamiaje

// Un volcado del buzón, con la forma real: `marker.adversarialPasses[].confirmados` es el número de
// hallazgos que el pase CONFIRMÓ, y `marker.repoPath` dice en qué repo corrió.
function volcado(dir, { story, repo, confirmados }) {
  const f = path.join(dir, `${story}-2026-09-20T1000.json`);
  fs.writeFileSync(f, JSON.stringify({
    archivedAt: '2026-09-20T10:00:00.000Z',
    marker: {
      storyId: story,
      repoPath: repo,
      startedAt: '2026-09-20T04:00:00.000Z',
      adversarialPasses: confirmados === null ? [] : [{ ts: '2026-09-20T09:00:00.000Z', tipo: '5b', confirmados }],
    },
  }, null, 1));
  return f;
}

// Una corrida en un repo: `findings.json` (la fuente consolidada, que SÍ viaja por git) y,
// opcionalmente, `step-05b-adversarial.json` (la salida cruda del pase, que NO viaja).
function corrida(repo, { story, clases = null, crudos = null }) {
  const run = path.join(repo, '.advisors', 'pipeline-runs', `${story}-20260920-040000`);
  fs.mkdirSync(run, { recursive: true });
  if (clases !== null) {
    const arr = [];
    for (let i = 0; i < clases; i++) arr.push({ rule_id: `ADV-${i}`, advisor: 'adversarial', file: 'a.js', severity: 'WARNING', reason: `clase ${i}` });
    arr.push({ rule_id: 'SEC-1', advisor: 'tycon-plugin-security-basics', file: 'a.js', severity: 'WARNING', reason: 'otro revisor' });
    fs.writeFileSync(path.join(run, 'findings.json'), JSON.stringify(arr, null, 1));
  }
  if (crudos !== null) {
    // Los crudos se arman de a pares sobre el mismo sitio: 8 hallazgos que son 4 problemas, que es
    // justo lo que el criterio de agrupación tiene que reconocer al medirlos de verdad.
    const confirmed = [];
    for (let i = 0; i < crudos; i++) confirmed.push({ lens: i % 2 ? 'determinism-ordering' : 'traversal-completeness', severity: 'bug', file: 'a.js', line: Math.floor(i / 2) + 1, summary: `hallazgo ${i}`, repro: 'x', confidence: 'high' });
    fs.writeFileSync(path.join(run, 'step-05b-adversarial.json'), JSON.stringify({ confirmed, all_lenses: [] }, null, 1));
  }
  return run;
}

function escenario() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-adv-'));
  const buzon = path.join(tmp, 'buzon', 'maquina-1');
  fs.mkdirSync(buzon, { recursive: true });
  const repo = path.join(tmp, 'repo-uno');
  fs.mkdirSync(repo, { recursive: true });

  // (a) pase con volcado CRUDO en el repo → la fuente buena: 8 hallazgos, y el consolidado dice 4 clases.
  volcado(buzon, { story: '1.1', repo, confirmados: 8 });
  corrida(repo, { story: '1.1', clases: 4, crudos: 8 });
  // (b) pase SIN volcado crudo → se cae al cruce con el consolidado: 10 hallazgos, 5 clases.
  volcado(buzon, { story: '1.2', repo, confirmados: 10 });
  corrida(repo, { story: '1.2', clases: 5 });
  // (c) pase sin nada del lado del repo → NO medible.
  volcado(buzon, { story: '1.3', repo, confirmados: 12 });
  // (d) pase de un repo que ni siquiera existe en esta máquina → NO medible.
  volcado(buzon, { story: '1.4', repo: path.join(tmp, 'repo-que-no-esta'), confirmados: 6 });
  // (e) corrida sin pase adversarial → ni se cuenta: no es un pase que no se pudo medir.
  volcado(buzon, { story: '1.5', repo, confirmados: null });

  return { tmp, buzon: path.join(tmp, 'buzon'), repo };
}

// ---------------------------------------------------------------------- T1

t('T1 Ratio_CruzaLasDosFuentes — da hallazgos y causas por pase, con mediana y percentiles', () => {
  const { buzon, repo } = escenario();
  const { medir } = require(MOD);
  const r = medir({ buzon, repos: [repo] });

  const filas = r.filas.filter((f) => f.medible);
  assert.strictEqual(filas.length, 2, 'se miden los dos pases que tienen su fuente de clases');

  const f11 = r.filas.find((f) => f.story === '1.1');
  assert.strictEqual(f11.hallazgos, 8, 'los hallazgos salen del buzón');
  assert.strictEqual(f11.fuente, 'crudo', 'con volcado crudo disponible, se prefiere el crudo');
  assert.strictEqual(f11.clases, 4, 'con los hallazgos enteros, las causas se miden aplicando el criterio de verdad (8 hallazgos sobre 4 sitios)');
  assert.ok(Math.abs(f11.ratio - 2) < 1e-9, 'ratio = hallazgos / clases');

  const f12 = r.filas.find((f) => f.story === '1.2');
  assert.strictEqual(f12.fuente, 'consolidado', 'sin volcado crudo, se cae al findings.json');
  assert.strictEqual(f12.clases, 5, 'sólo cuentan las entradas del pase adversarial, no las de otros revisores');

  assert.ok(typeof r.estadisticas.mediana === 'number', 'hay mediana del ratio');
  assert.ok(typeof r.estadisticas.p25 === 'number' && typeof r.estadisticas.p75 === 'number', 'hay percentiles');
  assert.ok(r.estadisticas.ahorro_pct > 0, 'el ahorro sale de los hallazgos que sobran sobre el total medido');
});

// ---------------------------------------------------------------------- T2

t('T2 Ratio_DiceLoQueNoPudoMedir — dice sobre cuántos midió y cuántos quedaron afuera', () => {
  const { buzon, repo } = escenario();
  const { medir, resumen } = require(MOD);
  const r = medir({ buzon, repos: [repo] });

  assert.strictEqual(r.pases, 4, 'los pases del buzón son los que tienen hallazgos anotados');
  assert.strictEqual(r.medidos, 2, 'medidos = los que tienen su fuente de clases');
  assert.strictEqual(r.sin_datos, 2, 'los otros dos quedan declarados, no descartados');

  const sinDatos = r.filas.filter((f) => !f.medible);
  assert.ok(sinDatos.every((f) => typeof f.motivo === 'string' && f.motivo.length > 0), 'cada pase no medido dice POR QUÉ');

  const txt = resumen(r);
  assert.ok(/2 de 4/.test(txt), `el resumen dice sobre cuántos midió; decía: ${txt}`);
  assert.ok(/no medid|afuera|sin datos/i.test(txt), 'el resumen nombra a los que quedaron afuera');
});

// ------------------------------------------------- muestra chica = se declara

t('T2b — con muestra chica el resumen lo declara en vez de prometer el número', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-adv-chica-'));
  const buzon = path.join(tmp, 'buzon', 'm');
  fs.mkdirSync(buzon, { recursive: true });
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  volcado(buzon, { story: '9.1', repo, confirmados: 19 });
  corrida(repo, { story: '9.1', clases: 9, crudos: 19 });

  const { medir, resumen } = require(MOD);
  const r = medir({ buzon: path.join(tmp, 'buzon'), repos: [repo] });
  assert.strictEqual(r.medidos, 1);
  assert.strictEqual(r.muestra_suficiente, false, 'un solo pase no sostiene un porcentaje');
  assert.ok(/n=1|una sola corrida|no alcanza/i.test(resumen(r)), 'el resumen declara que la muestra no alcanza');
});

// --------------------------------------------------- la medición no escribe

t('Task 1 — la medición sólo LEE: no toca los volcados ni las pruebas archivadas', () => {
  const { buzon, repo } = escenario();
  const antes = huella(buzon).concat(huella(repo));
  const { medir } = require(MOD);
  medir({ buzon, repos: [repo] });
  const despues = huella(buzon).concat(huella(repo));
  assert.deepStrictEqual(despues, antes, 'ningún archivo del buzón ni del repo cambió de tamaño o de fecha');
});

function huella(dir) {
  const out = [];
  (function walk(d) {
    let e = [];
    try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_e) { return; }
    for (const it of e.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else { const s = fs.statSync(p); out.push(`${p}:${s.size}:${s.mtimeMs}`); }
    }
  })(dir);
  return out;
}


// --------------------------------- datos ROTOS no son datos AUSENTES (SILENT-C2, vuelta 2)

t('un volcado o un findings.json ilegible se cuenta aparte y avisa — no desaparece como "sin datos"', () => {
  // 🔴 Caso del revisor de fallos silenciosos (2026-09-20): el buzón lo escriben 4 máquinas, así que
  // una escritura a medias es realista. Si un JSON corrupto se trata igual que un archivo que no
  // existe, el medidor dice «pregunté y no hay» donde la verdad es «no pude leer» — la mentira más
  // barata de producir y la más cara de detectar.
  const { buzon, repo, tmp } = escenario();
  // (f) un volcado del buzón truncado a la mitad
  fs.writeFileSync(path.join(tmp, 'buzon', 'maquina-1', '9.9-2026-09-20T1000.json'), '{"marker":{"storyId":"9.9"');
  // (g) una corrida cuyo findings.json existe pero está roto
  const run = corrida(repo, { story: '1.6', clases: 2 });
  fs.writeFileSync(path.join(run, 'findings.json'), '[{"advisor":"adversarial"');
  volcado(path.join(tmp, 'buzon', 'maquina-1'), { story: '1.6', repo, confirmados: 9 });

  const { medir, resumen } = require(MOD);
  const r = medir({ buzon, repos: [repo] });

  assert.ok(r.ilegibles >= 2, `los archivos rotos se cuentan aparte; fueron ${r.ilegibles}`);
  assert.ok(Array.isArray(r.ilegibles_detalle) && r.ilegibles_detalle.every((x) => x.archivo && x.motivo),
    'cada ilegible dice qué archivo y por qué');

  const f16 = r.filas.find((f) => f.story === '1.6');
  assert.ok(f16 && !f16.medible, 'la corrida con findings.json roto no se mide');
  assert.ok(/ilegible|no pude leer|roto/i.test(f16.motivo),
    `el motivo tiene que decir que no se pudo LEER, no que no hay datos; decía: ${f16.motivo}`);

  assert.ok(/ilegible/i.test(resumen(r)), 'el resumen nombra los ilegibles');
});

t('el motivo no publica la ruta completa de la máquina de otro dev (SEC-W8)', () => {
  // 🔴 Caso del revisor de seguridad (2026-09-20): el `repoPath` del buzón trae el path absoluto de
  // la máquina donde corrió — con el nombre de usuario de otro dev y el nombre del proyecto. La
  // columna `repo` de la tabla ya lo acortaba; el `motivo` no, y por esa asimetría el path entero se
  // coló en el .md que se iba a commitear.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-adv-sec-'));
  const buzon = path.join(tmp, 'buzon', 'm');
  fs.mkdirSync(buzon, { recursive: true });
  volcado(buzon, { story: '5.17', repo: '/Users/otrodev/Proyectos/CLIENTE/Codigo/RepoDelCliente', confirmados: 4 });

  const { medir, resumen, tabla } = require(MOD);
  const r = medir({ buzon: path.join(tmp, 'buzon'), repos: [] });
  const fila = r.filas.find((f) => f.story === '5.17');
  assert.ok(fila && !fila.medible, 'el repo no está en esta máquina: no se mide');
  assert.ok(!/\/Users\/otrodev/.test(fila.motivo), `el motivo no lleva la ruta completa; decía: ${fila.motivo}`);
  assert.ok(/RepoDelCliente/.test(fila.motivo), 'pero sí dice de qué repo se trata, para poder buscarlo');
  const texto = `${resumen(r)}\n${tabla(r)}`;
  assert.ok(!/\/Users\/otrodev/.test(texto), 'ni el resumen ni la tabla publican la ruta completa');

  // 🔴 Y tampoco en el DATO, no sólo al imprimir (vuelta 2 del revisor de seguridad): `--json` lo
  // consume otro script, y ahí la ruta volvía entera. Taparlo al renderizar no es taparlo.
  assert.ok(!/\/Users\/otrodev/.test(JSON.stringify(r.repos)), 'la lista de repos no guarda la ruta completa');
  for (const f of r.filas) assert.ok(!/\/Users\/otrodev/.test(String(f.repo)), `la fila de ${f.story} no guarda la ruta completa`);
});

t('ilegible por el HISTORIAL de git también dice "ilegible" en su fila, y se sabe de qué corrida', () => {
  // 🔴 Vuelta 2 del cazador de fallos silenciosos: el contador global subía, pero la FILA de esa
  // story seguía diciendo «no dejó nada». Y con el recorte de rutas, dos corridas rotas se veían
  // iguales en el detalle («findings.json» y «findings.json»): se sabía cuántas, no cuáles.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-adv-git-'));
  const buzon = path.join(tmp, 'buzon', 'm');
  fs.mkdirSync(buzon, { recursive: true });
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });

  // Dos corridas distintas, las dos con su findings.json roto en el working tree.
  for (const story of ['3.1', '3.2']) {
    const run = corrida(repo, { story, clases: 2 });
    fs.writeFileSync(path.join(run, 'findings.json'), '[{"advisor":"adversarial"');
    volcado(buzon, { story, repo, confirmados: 5 });
  }

  const { medir } = require(MOD);
  const r = medir({ buzon: path.join(tmp, 'buzon'), repos: [repo] });

  for (const story of ['3.1', '3.2']) {
    const f = r.filas.find((x) => x.story === story);
    assert.ok(f && !f.medible, `${story} no se mide`);
    assert.ok(/ilegible/i.test(f.motivo), `${story}: el motivo tiene que decir ILEGIBLE; decía: ${f.motivo}`);
  }
  const nombres = new Set(r.ilegibles_detalle.map((x) => x.archivo));
  assert.strictEqual(nombres.size, r.ilegibles_detalle.length,
    `dos archivos rotos de corridas distintas no pueden verse iguales: ${[...nombres].join(' , ')}`);
  assert.ok([...nombres].every((x) => /3\.[12]/.test(x)), 'cada ilegible dice a qué corrida pertenece');
});

t('con el criterio real a mano, las causas se miden APLICÁNDOLO — no con la cota por sitio (AC 1)', () => {
  // 🔴 Hueco que encontró el revisor de cobertura: la rama `if (agrupador)` es justo lo que el AC 1
  // describe («se les aplica el criterio»), y hasta ahora sólo corría en producción, vía main().
  // Todos los demás casos ejercitaban el fallback por sitio, que es la COTA, no la medición.
  const LIB = require(MOD).rutaDelCriterio();
  if (!LIB) { console.log(`  SKIP ${n} - el criterio vive en el repo hermano y no está en esta máquina`); return; }
  const { agrupar } = require(LIB);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-adv-crit-'));
  const buzon = path.join(tmp, 'buzon', 'm');
  fs.mkdirSync(buzon, { recursive: true });
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });

  // Cuatro hallazgos: dos en el mismo sitio y con el mismo síntoma (una clase), y dos que comparten
  // sitio pero NO síntoma — el criterio los separa y la cota por sitio no. Ahí se ven distinto.
  const run = path.join(repo, '.advisors', 'pipeline-runs', '8.1-20260920-040000');
  fs.mkdirSync(run, { recursive: true });
  const F = (line, summary) => ({ lens: 'traversal-completeness', severity: 'bug', file: 'a.js', line, summary, repro: summary, confidence: 'high' });
  fs.writeFileSync(path.join(run, 'step-05b-adversarial.json'), JSON.stringify({
    confirmed: [
      F(10, 'el cuerpo del heredoc se parsea como comandos'),
      F(10, 'las líneas del heredoc se toman como comandos independientes'),
      F(20, 'offset: 0 evade la medición'),
      F(20, 'module.exports es inalcanzable sin require.main'),
    ],
  }));
  volcado(buzon, { story: '8.1', repo, confirmados: 4 });

  const { medir } = require(MOD);
  const conCriterio = medir({ buzon: path.join(tmp, 'buzon'), repos: [repo], agrupador: agrupar });
  const conCota = medir({ buzon: path.join(tmp, 'buzon'), repos: [repo] });

  const f = conCriterio.filas.find((x) => x.story === '8.1');
  assert.strictEqual(f.fuente, 'crudo', 'con volcado crudo se usa el crudo');
  assert.strictEqual(f.clases, 3, 'el criterio junta los dos del heredoc y separa los dos de síntomas distintos');
  assert.strictEqual(conCota.filas.find((x) => x.story === '8.1').clases, 2,
    'la cota por sitio cuenta 2 (dos sitios) — por eso es una cota y no la medición');
});

// ═══════════ vuelta 3: lo que el pase adversarial encontró en el propio medidor ═══════════

t('un pase LIMPIO (0 hallazgos) es un dato válido, no "datos rotos"', () => {
  // 🔴 `if (!clases || clases > hallazgos)` tomaba el 0 legítimo como falta de datos. Un pase que no
  // encontró nada es exactamente lo que devuelve el workflow cuando las 6 lentes salen limpias.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-adv-limpio-'));
  const buzon = path.join(tmp, 'buzon', 'm');
  fs.mkdirSync(buzon, { recursive: true });
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  volcado(buzon, { story: '4.1', repo, confirmados: 0 });

  const { medir, resumen } = require(MOD);
  const r = medir({ buzon: path.join(tmp, 'buzon'), repos: [repo] });
  const f = r.filas.find((x) => x.story === '4.1');
  assert.ok(f, 'el pase limpio aparece en la tabla');
  assert.strictEqual(r.ilegibles, 0, 'no se cuenta como archivo roto');
  assert.ok(/limpio/i.test(f.motivo), `el motivo dice que salió limpio; decía: ${f.motivo}`);
  assert.strictEqual(r.limpios, 1, 'y se cuentan aparte de los que no se pudieron medir');
  assert.ok(/limpio/i.test(resumen(r)), 'el resumen los nombra');
});

t('los hallazgos y las causas salen de la MISMA anotación del pase, no de dos máximos sueltos', () => {
  // 🔴 El pase lo cazó: `max(confirmados)` y `max(clases)` se tomaban por separado, así que un
  // lanzamiento inicial sin --clases más un re-lanzamiento con --clases producían un par imposible.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-adv-par-'));
  const buzon = path.join(tmp, 'buzon', 'm');
  fs.mkdirSync(buzon, { recursive: true });
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(buzon, '5.1-2026-09-20T1000.json'), JSON.stringify({
    archivedAt: '2026-09-20T10:00:00.000Z',
    marker: {
      storyId: '5.1', repoPath: repo, startedAt: '2026-09-20T04:00:00.000Z',
      adversarialPasses: [
        { tipo: '5b', confirmados: 20 },          // el lanzamiento grande, sin causas anotadas
        { tipo: '5b', confirmados: 3, clases: 2 }, // un re-lanzamiento chico, con causas
      ],
    },
  }));

  const { medir } = require(MOD);
  const r = medir({ buzon: path.join(tmp, 'buzon'), repos: [repo] });
  const f = r.filas.find((x) => x.story === '5.1');
  assert.ok(f, 'la fila existe');
  assert.ok(!(f.hallazgos === 20 && f.clases === 2),
    'no se puede cruzar los 20 hallazgos de una anotación con las 2 causas de otra');
});

t('con el volcado crudo se usa lo que el pase YA dijo, no se re-agrupa lo ya filtrado', () => {
  // 🔴 El pase lo cazó: con fuente «crudo» se re-aplicaba el criterio sobre `confirmed`, que es el
  // subconjunto ya filtrado por veredicto — el número no es el que el pase midió en vivo.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-adv-crudo-'));
  const buzon = path.join(tmp, 'buzon', 'm');
  fs.mkdirSync(buzon, { recursive: true });
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const run = path.join(repo, '.advisors', 'pipeline-runs', '6.1-20260920-040000');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'step-05b-adversarial.json'), JSON.stringify({
    hallazgos: 9, clases: 4, agentes_ahorrados: 5,
    confirmed: [
      { lens: 'l', severity: 'bug', file: 'a.js', line: 1, summary: 'x', repro: 'x', confidence: 'high' },
      { lens: 'l', severity: 'bug', file: 'a.js', line: 2, summary: 'y', repro: 'y', confidence: 'high' },
    ],
  }));
  volcado(buzon, { story: '6.1', repo, confirmados: 9 });

  const { medir } = require(MOD);
  const r = medir({ buzon: path.join(tmp, 'buzon'), repos: [repo] });
  const f = r.filas.find((x) => x.story === '6.1');
  assert.strictEqual(f.clases, 4, 'vale el `clases` que el propio pase anotó, no re-agrupar los 2 confirmados');
});

t('la corrida se busca en el repo DECLARADO, no en cualquiera que tenga una story con ese número', () => {
  // 🔴 El pase lo cazó: se buscaba en todos los repos vistos en el buzón y se desempataba por fecha,
  // así que un id de story repetido en otro repo podía aportar las causas de una corrida ajena.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-adv-repo-'));
  const buzon = path.join(tmp, 'buzon', 'm');
  fs.mkdirSync(buzon, { recursive: true });
  const mio = path.join(tmp, 'repo-mio');
  const ajeno = path.join(tmp, 'repo-ajeno');
  fs.mkdirSync(mio, { recursive: true });
  fs.mkdirSync(ajeno, { recursive: true });
  corrida(mio, { story: '2.1', clases: 5 });
  corrida(ajeno, { story: '2.1', clases: 2 });
  volcado(buzon, { story: '2.1', repo: mio, confirmados: 10 });

  const { medir } = require(MOD);
  const r = medir({ buzon: path.join(tmp, 'buzon'), repos: [ajeno, mio] });
  const f = r.filas.find((x) => x.story === '2.1');
  assert.strictEqual(f.clases, 5, 'las causas salen de la corrida del repo declarado por el pase');
});

t('si el repo declarado no está, la fila DICE que el repo se resolvió por coincidencia de número', () => {
  // 🔴 El buzón lo escriben 4 máquinas: la ruta declarada por un pase ajeno casi nunca existe acá, y
  // ahí el medidor volvía a buscar la story en cualquier repo local. No está mal medirlo —es la única
  // fuente que hay— pero tiene que DECIRLO: si no, una corrida ajena con el mismo número de story
  // aporta causas que no son suyas y la fila se ve igual de confiable que las demás.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-adv-ajeno-'));
  const buzon = path.join(tmp, 'buzon', 'm');
  fs.mkdirSync(buzon, { recursive: true });
  const local = path.join(tmp, 'repo-local');
  fs.mkdirSync(local, { recursive: true });
  corrida(local, { story: '9.9', clases: 4 });
  volcado(buzon, { story: '9.9', repo: '/Users/otrodev/Proyectos/OtroRepo', confirmados: 8 });

  const { medir, resumen } = require(MOD);
  const r = medir({ buzon: path.join(tmp, 'buzon'), repos: [local] });
  const f = r.filas.find((x) => x.story === '9.9');
  assert.ok(f && f.medible, 'se mide igual: es la única fuente que hay');
  assert.strictEqual(f.repo_confirmado, false, 'pero la fila dice que el repo NO es el declarado');
  assert.ok(/coincidencia|no declarado|ajeno/i.test(String(f.nota || f.fuente)),
    `y deja dicho por qué; fuente=${f.fuente} nota=${f.nota}`);
  assert.ok(/coincidencia/i.test(resumen(r)), 'y el resumen lo declara, no lo esconde');
});

t('el criterio se busca por su nombre de hoy; el de antes del renombre vale sólo como respaldo, y si no está se dice (story 8.9, tanda G)', () => {
  // 🔴 rojo previo: el medidor buscaba el archivo SÓLO por el nombre que tenía antes de la story 8.9. En el equipo andaba
  //    por el reemplazo que deja el renombre; en la copia pública (sin reemplazos) no lo encontraba y medía con la cota
  //    por sitio sin decirlo: el número cambiaba de método callado.
  const { rutaDelCriterio, cargarCriterio } = require(MOD);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-adv-lib-'));
  assert.strictEqual(rutaDelCriterio(dir), null, 'sin el archivo: no hay criterio');
  const avisos = [];
  assert.strictEqual(cargarCriterio(dir, (m) => avisos.push(m)), null);
  assert.ok(avisos.length === 1 && /cota/.test(avisos[0]), `sin criterio, lo dice: ${JSON.stringify(avisos)}`);
  // el nombre de antes sale del mapa de renombres (la copia pública no lo trae: ahí sólo vale el de hoy)
  const mapa = path.resolve(__dirname, '..', 'lib', 'renames.json');
  if (fs.existsSync(mapa)) {
    const e = JSON.parse(fs.readFileSync(mapa, 'utf8')).entries.find((x) => x.kind === 'file' && x.repo === 'agent-skills' && /\/lib\/group-findings\.js$/.test(x.new));
    assert.ok(e, 'el mapa trae el renombre del criterio');
    const viejo = path.join(dir, path.posix.basename(e.old));
    fs.writeFileSync(viejo, 'module.exports = { agrupar: () => "viejo" };\n');
    assert.strictEqual(rutaDelCriterio(dir), viejo, 'una copia de agent-skills anterior al renombre: se usa el nombre de antes');
  }
  const nuevo = path.join(dir, 'group-findings.js');
  fs.writeFileSync(nuevo, 'module.exports = { agrupar: () => "nuevo" };\n');
  assert.strictEqual(rutaDelCriterio(dir), nuevo, 'con los dos, gana el nombre de hoy');
  const sinAvisos = [];
  assert.strictEqual(cargarCriterio(dir, (m) => sinAvisos.push(m))(), 'nuevo');
  assert.deepStrictEqual(sinAvisos, [], 'con el criterio a mano no avisa nada');
});

t('el criterio está y carga pero no trae la función que agrupa: se dice, como los otros dos caminos (story 8.9, tanda G, ronda 2)', () => {
  // 🔴 rojo previo: con el archivo encontrado y sin `agrupar`, devolvía null callado; «no encontré» y «no pude cargar» avisaban.
  const { cargarCriterio } = require(MOD);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-adv-lib-'));
  fs.writeFileSync(path.join(dir, 'group-findings.js'), 'module.exports = { otraCosa: () => 1 };\n');
  const avisos = [];
  assert.strictEqual(cargarCriterio(dir, (m) => avisos.push(m)), null);
  assert.ok(avisos.length === 1 && /agrupar/.test(avisos[0]) && /cota/.test(avisos[0]), `lo dice, y qué mide en su lugar: ${JSON.stringify(avisos)}`);
});

console.log(`\n${n} casos, ${process.exitCode ? 'CON FALLAS' : 'todos verdes'}`);
