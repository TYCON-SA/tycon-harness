'use strict';

/**
 * internal-data-leftovers.test.js — tres cosas que se sacaron de lo que se publica y que ninguna otra suite cuidaba
 * (T23-T25).
 *
 * POR QUÉ EXISTE. Hay datos internos que la lista de nombres no ve. Casi todo lo que se quitó de la copia publicada ya
 * tiene una suite que lo mira. Estas tres cosas no: son texto de guías y una lista de pendientes, y volverían a entrar
 * sin que nada se ponga rojo.
 *
 *   · T23 — la guía de reglas para revisores no enumera, en su texto público, la cartera de repos de producto. La lista
 *     vive en un bloque interno (`tycon:internal-*`), que la copia no trae.
 *   · T24 — ninguna guía trae, en su texto público, un enlace a un repo de Azure DevOps de una organización de verdad.
 *     Un ejemplo con marcadores (`<org>`, `<repo>`) no cuenta.
 *   · T25 — cada hallazgo de la auditoría que quedó sin hacer tiene su línea de deuda en `tasks/todo.md`.
 *
 * El «texto público» se saca con la misma función que usa el exportador (`public-copy.js → internalBlocks`): adentro,
 * la guía con sus bloques internos; en la copia, la guía ya sin ellos. Las dos dan lo mismo.
 *
 * En la copia pública `tasks/` no viaja: T25 sale NO MEDIDO ahí. No usa red ni herramientas de afuera.
 * Cada una falla si la guía enumera la cartera, si tres guías enlazan el repo interno o si falta una línea de deuda.
 *
 * CASOS SUMADOS (T26-T30 y T34). Cierran dos huecos: inventados que delatan al real y una lista que se esquiva con un
 * cambio mínimo. Lo que se suma acá:
 *
 *   · T26 — formas partidas: con una lista SINTÉTICA (ningún nombre es de nadie), cada término se ve con guion, con
 *     guion bajo, pegado, con `%20`, con tilde o sin ella, en singular y en plural, en otra caja, en una ruta, en una
 *     URL, como el valor de una clave, después de un escape, sin los puntos de un host, partido con comillas y partido
 *     en dos renglones. Y lo que NO tiene que ver: una frase común que sólo se parece a un nombre de caja exacta.
 *   · T27 — la guía de publicación no explica, en su texto público, cómo se eligió cada nombre inventado.
 *   · T28 — un marcador de bloque interno «casi» bien escrito frena: no deja salir el bloque en silencio.
 *   · T29 y T30 — con la lista de VERDAD (privada: en la copia salen NO MEDIDO): cada patrón ve las muestras que la
 *     propia lista le declara (`ve`) y no ve sus contramuestras (`noVe`), y la entrada de llavero con el inventado de
 *     cualquier cliente de la tabla de reemplazos se ve, sin una lista copiada a mano que se desfase.
 *   · T34 — T23 ve también una cartera partida por el corte de renglón.
 *   · T35 — las dos listas de la suite de humo no repiten ningún nombre de las de antes, ni entero ni lo de después
 *     del prefijo. Las listas viejas se leen de la historia del repo (no viven en el árbol); sin esa historia, NO MEDIDO.
 *     T29, además, exige que cada patrón de la lista traiga las dos mitades: muestras y contramuestras.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { internalBlocks, markerLines } = require(path.join(ROOT, 'scripts', 'publishing', 'public-copy.js'));
const detector = require(path.join(ROOT, 'scripts', 'publishing', 'detector.js'));

/** El texto de un `.md` como sale en la copia. Con marcadores mal puestos el exportador frena; acá también. */
function publicText(rel) {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const r = internalBlocks(raw, rel);
  assert.deepStrictEqual(r.errors, [], `${rel}: marcadores de bloque mal puestos`);
  return r.text;
}

/** Todos los `.md` de una carpeta, con ruta relativa a la raíz. */
function markdownUnder(rel) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(rel);
  return out.sort();
}

// Un enlace a un repo de Azure DevOps: el host de la organización y `/_git/`. Un marcador (`<org>`) corta la URL antes
// de `/_git/` y no coincide: los ejemplos con marcadores pasan.
const REPO_LINK = /https?:\/\/[^\s)`>"']*(?:visualstudio\.com|dev\.azure\.com)[^\s)`>"']*\/_git\//g;

// La forma de la cartera: un producto y, entre paréntesis, sus repos separados por coma. La guía va cortada a ancho
// fijo, así que entre el producto y su paréntesis, y después de cada coma, puede haber un salto de renglón (T34).
const ROSTER = /\b[A-Z][A-Za-z0-9-]*\s+\((?:[A-Z][A-Za-z0-9]*)(?:,\s+[A-Z][A-Za-z0-9]*)+\)/g;

test('T23 ReviewerRulesGuide_PublicText_NoRepoRoster — la guía dice quiénes la tienen sin enumerar la cartera de repos', () => {
  const rel = 'guides/reglas-para-revisores.md';
  const text = publicText(rel);
  const start = text.indexOf('\n## Qué repos la tienen');
  assert.ok(start >= 0, `${rel}: no encontré la sección «Qué repos la tienen»`);
  const next = text.indexOf('\n## ', start + 1);
  const section = text.slice(start, next < 0 ? undefined : next);

  assert.match(section, /todos los repos de producto del equipo/, 'la sección tiene que decirlo en general');
  assert.doesNotMatch(section, /\b\d+ repos de front y back\b/, 'cuántos repos hay es dato de la cartera: va en el bloque interno');
  assert.strictEqual(('Acme (AcmeBackend, AcmeForms) y Globex (Backend, FrontEnd, Mobile)'.match(ROSTER) || []).length, 2,
    'el patrón no ve una lista de muestra');
  const roster = section.match(ROSTER) || [];
  assert.strictEqual(roster.length, 0, `la sección enumera ${roster.length} producto(s) con sus repos en el texto público`);
});

test('T34 ReviewerRulesGuide_RosterSplitAcrossLines — la cartera partida por el corte de renglón también se ve', () => {
  const count = (s) => (s.match(ROSTER) || []).length;
  assert.strictEqual(count('la tienen Acme (AcmeBackend, AcmeForms) y los demás'), 1, 'en un renglón');
  assert.strictEqual(count('la tienen Acme\n(AcmeBackend, AcmeForms) y los demás'), 1, 'el paréntesis cae en el renglón de abajo');
  assert.strictEqual(count('la tienen Acme (AcmeBackend,\nAcmeForms) y los demás'), 1, 'el corte cae después de una coma');
  assert.strictEqual(count('Acme\n  (Backend,\n  FrontEnd, Mobile), Globex\n(Backend, Forms)'), 2, 'dos productos, los dos partidos');
  assert.strictEqual(count('ver la sección (arriba) y el caso (uno, dos)'), 0, 'un paréntesis cualquiera no es una cartera');
});

test('T24 Guides_PublicText_NoInternalRepoLinks — ninguna guía enlaza un repo de Azure DevOps de una organización de verdad', () => {
  // el patrón ve lo que tiene que ver y deja pasar un ejemplo con marcadores
  const sample = ['https://', 'una-org', '.visualstudio.com/Un%20Proyecto/_git/Un%20Repo'].join('');
  assert.strictEqual((sample.match(REPO_LINK) || []).length, 1, 'el patrón no ve un enlace de muestra');
  assert.strictEqual(('https://dev.azure.com/<org>/<proyecto>/_git/<repo>'.match(REPO_LINK) || []).length, 0,
    'el patrón toma por enlace un ejemplo con marcadores');

  const guides = markdownUnder('guides');
  assert.ok(guides.length > 0, 'no encontré ninguna guía: no pude mirar');
  const found = [];
  for (const rel of guides) {
    const text = publicText(rel);
    text.split('\n').forEach((line, i) => { if ((line.match(REPO_LINK) || []).length) found.push(`${rel}:${i + 1}`); });
  }
  assert.deepStrictEqual(found, [], `enlaces a un repo interno en el texto público de las guías: ${found.join(', ')}`);
});

test('T25 DeferredFindings_EachHasItsDebtLine — cada hallazgo de la auditoría que no se hizo tiene su línea de deuda', (t) => {
  const todo = path.join(ROOT, 'tasks', 'todo.md');
  if (!fs.existsSync(todo)) {
    t.skip('NO MEDIDO: esta copia no trae tasks/ (la lista de pendientes es del repo del equipo)');
    return;
  }
  const lines = fs.readFileSync(todo, 'utf8').split('\n');
  const missing = [];
  for (let n = 11; n <= 19; n++) {
    const re = new RegExp(`^- \\[[ x]\\] \\[DEF-8\\.10\\.1-${n}-[a-z0-9-]+\\]`);
    const hits = lines.filter((l) => re.test(l)).length;
    if (hits !== 1) missing.push(`hallazgo ${n}: ${hits} línea(s)`);
  }
  assert.deepStrictEqual(missing, [], `en tasks/todo.md, una línea [DEF-8.10.1-<n>-…] por hallazgo: ${missing.join(' · ')}`);
});

// ── Segunda vuelta ───────────────────────────────────────────────────────────────────────────────────────────────

/** Cuántas veces ve una regla (un término o un patrón, por su nombre) un texto. Sus variantes cuentan como la regla. */
function ruleHits(cfg, text, rule) {
  return detector.reviewText(cfg, text, 'muestra/formas.txt').hallazgos.filter((h) => h.regla === rule || h.regla.startsWith(`${rule} (`)).length;
}

// Una lista SINTÉTICA con una entrada de cada clase que tiene la de verdad. Ningún nombre es de nadie.
const SWEEP_LIST = {
  terminos: [
    { patron: 'Zorblax', categoria: 'cliente' }, //                                   un nombre simple
    { patron: 'QuuxTracking', categoria: 'cliente' }, //                              un nombre compuesto
    { patron: 'ZRB', categoria: 'cliente', palabra: true, mayusculas: true }, //      una sigla
    { patron: 'Depositos', categoria: 'cliente' }, //                                 la palabra de un rubro, en plural y sin tilde
    { patron: 'Almacén', categoria: 'cliente', palabra: true }, //                    una palabra con tilde
    { patron: 'Finanzas/Recibos', categoria: 'cliente' }, //                          una ruta del código
    { patron: 'pruebas.zorbnet.test', categoria: 'host-interno' }, //                 un host
    { patron: "org: 'zorbnet'", categoria: 'host-interno' }, //                       una clave con su valor
    { patron: 'QuickReview', categoria: 'interno', mayusculas: true }, //             dos palabras comunes, de caja exacta
    { patron: 'Telezor', categoria: 'cliente', palabra: true }, //                    el comienzo de otra palabra
    { patron: 'NOX', categoria: 'cliente', palabra: true, mayusculas: true, glued: false }, // una sigla que es además una palabra común: sin las formas pegadas
    { patron: 'Z4K', categoria: 'cliente', palabra: true, mayusculas: true }, //               una sigla con un dígito: también se busca pegada
  ],
  patrones: [
    { nombre: 'servidor-de-muestra', categoria: 'host-interno', regex: '[a-z0-9]+zorbnet[-_]?(?:sql|db)' },
    { nombre: 'organizacion-de-muestra', categoria: 'host-interno', mayusculas: true, regex: '\\b[Oo]rg(?:anizaci[oó]n)?\\s+zorbnet\\b' },
  ],
};

const SWEEP = [
  { rule: 'Zorblax',
    sees: [
      'el repo de zorblax', 'EL CASO ZORBLAX', 'GET /api/zorblax/orders', 'https://zorblax.example.com/x', //   caja, ruta, URL
      'ZorblaxBackend', 'test_ZorblaxOrders_Works', //                                                          pegado a otro nombre
      'project: "zorblax"', 'project: zorblax', 'PROJECT=zorblax', //                                           el valor de una clave
      'un Zórblax con tilde', //                                                                                 con tilde
      JSON.stringify({ out: 'uno\nZorblax dos' }), 'https://x.example/Mi%20Zorblax%20Repo', //                   tras un escape, entre %20
      '--name Zorb"lax"', "name = 'Zorb' + 'lax'", '--name "Zorb"\'lax\'', //                                    partido con comillas
      'cmd --name Zorb\\\nlax --go', //                                                                          partido en dos renglones
    ],
    doesNotSee: ['el repo de zorbla', 'nada que ver'] },
  { rule: 'QuuxTracking',
    sees: [
      'quux-tracking', 'quux_tracking', 'quuxtracking', 'Quux Tracking', 'quux.tracking', 'Quux%20Tracking', 'quux+tracking',
      'src/quux/tracking/x.js', 'C:\\repos\\Quux\\Tracking', 'los QuuxTrackings', '"Quux"Tracking',
      'el producto Quux\nTracking sigue igual', '> el producto Quux\n> Tracking sigue igual',
    ],
    doesNotSee: ['quux y después tracking', 'tracking de quux'] },
  { rule: 'ZRB',
    sees: [
      'el plugin de ZRB falló', 'la entrada llavero-prod-zrb', 'GET /api/zrb/ordenes', "project: 'zrb'", 'engram_project=zrb',
      'project: zrb', '  - cliente: zrb', '"project": "zrb",', 'los ZRBs de hoy', 'el alias zrbs-mac',
      JSON.stringify({ out: 'uno\nZRB dos' }), 'https://x.example/Mi%20ZRB%20Repo',
      // pegada a otra palabra: con la inicial en mayúscula dentro de un CamelCase —el
      // nombre de una etapa de pipeline, una clase— y en minúscula al principio o al final del valor de una clave que
      // nombra un proyecto
      'SYSTEM_STAGENAME=DeployZrbStaging SYSTEM_JOBNAME=DeployToZrbStaging', 'la clase ZrbBackend', 'un PanelZrb nuevo',
      "project: 'proyectozrb'", 'engram_project=zrbviejo', '  repo: "zrbforms",', 'pin: proyectozrb',
    ],
    // una sigla de palabra entera pegada a letras es otra palabra: sólo se mira pegada con la inicial en mayúscula en
    // un CamelCase y en el valor de una clave que nombra un proyecto. El resto del pegado en CamelCase lo mira el
    // control de nombres pegados del exportador
    doesNotSee: ['un zrb suelto en la prosa', 'ZRBX es otra cosa', 'el zrb.', 'la opción es: zrb y nada más',
      'un Zrbito cualquiera', 'la palabra cazrbo', "title: 'proyectozrb'", 'el proyectozrb en la prosa'] },
  { rule: 'Depositos',
    sees: ['Depósitos', 'un Deposito', 'el depósito', 'DEPOSITOS', 'ZetaDepositos', 'https://x.example/o/Zeta%20Depositos/_git/R',
      'DepositosBackend', '--project "Zeta Deposito"', 'zeta-depositos', 'zeta_depósito'],
    doesNotSee: ['depositar no es'] },
  { rule: 'Almacén',
    sees: ['el Almacen', 'un almacén', 'los Almacenes', 'ALMACEN', '/api/almacen/1'],
    doesNotSee: ['el almacenamiento'] },
  { rule: 'Finanzas/Recibos',
    sees: ['Finanzas\\Recibos', 'namespace Acme.Finanzas.Recibos;', 'src/finanzas/recibos/x.cs', 'src/Finanzas/Recibo/x.cs', 'FinanzasRecibos'],
    doesNotSee: ['finanzas y recibos'] },
  { rule: 'pruebas.zorbnet.test',
    sees: ["  name: 'Pruebaszorbnettest'", 'pruebas-zorbnet-test', 'PRUEBAS.ZORBNET.TEST', 'pruebas_zorbnet_test', 'https://pruebas."zorbnet".test/x'],
    doesNotSee: ['pruebas de zorbnet en test'] },
  { rule: "org: 'zorbnet'",
    sees: ['org: "zorbnet"', 'org: zorbnet', "org:'zorbnet'", 'org = zorbnet', 'ORG=zorbnet', '"org": "zorbnet"'],
    doesNotSee: ['la org es otra', 'zorbnet solo'] },
  { rule: 'QuickReview',
    sees: ['QuickReview', 'usa QuickReviewService', 'Quick_Review', 'Quick-Review'],
    doesNotSee: ['Do a quick review of the change before you merge it.', '## Quick Review', 'a quick-review pass', 'quickreview'] },
  { rule: 'Telezor',
    sees: ['Telezor', 'telezor-sms', '/telezor/x', 'TELEZOR'],
    doesNotSee: ['un telezorzal en la prosa'] },
  { rule: 'NOX',
    sees: ['el plugin de NOX falló', 'la entrada llavero-prod-nox', "project: 'nox'"],
    // con `glued: false` la sigla no se busca pegada: es también una palabra común y daría hallazgos en nombres legítimos
    doesNotSee: ['SYSTEM_STAGENAME=DeployNoxStaging', 'la clase NoxBackend', "project: 'proyectonox'", 'engram_project=noxviejo'] },
  // una sigla con un dígito en el medio: cuenta como «sigla» para una
  // condición y no para la otra, y pegada pasaría sin verse y sin aviso
  { rule: 'Z4K',
    sees: ['el plugin de Z4K falló', 'SYSTEM_STAGENAME=DeployZ4kStaging', 'la clase Z4kBackend', "project: 'proyectoz4k'", 'engram_project=z4kviejo'],
    doesNotSee: ['un z4k suelto en la prosa', 'Z4KX es otra cosa', "title: 'proyectoz4k'"] },
  { rule: 'servidor-de-muestra',
    sees: ['xxzorbnetsql', 'XXZORBNETDB', 'xxzorbnet-sql', 'xxzorbnetsqlserver', '--server "xxzorbnet"sql', '--server xxzorbnets"ql"',
      "host = 'xxzorbnet' + 'sql'", '--server xxzorbnet\\\n    sql --go'],
    doesNotSee: ['zorbnet sql', 'xx zorbnet'] },
  { rule: 'organizacion-de-muestra',
    sees: ['la org zorbnet', 'la org `zorbnet`', 'en la organización\nzorbnet no hay nada', '> en la org\n> zorbnet no hay nada'],
    doesNotSee: ['el paquete zorbnet', 'la org Zorbnet'] },
];

test('T26 SplitForms_SyntheticList_EveryFormIsSeen — cada término se ve en sus formas partidas, y sólo en ésas', () => {
  const cfg = detector.cargarConfig('lista-sintetica.json', JSON.stringify(SWEEP_LIST));
  const rules = [...SWEEP_LIST.terminos.map((t) => t.patron), ...SWEEP_LIST.patrones.map((p) => p.nombre)];
  assert.deepStrictEqual(SWEEP.map((s) => s.rule), rules, 'el barrido tiene que cubrir cada entrada de la lista sintética');
  const missed = [];
  const extra = [];
  for (const { rule, sees, doesNotSee } of SWEEP) {
    for (const text of sees) if (ruleHits(cfg, text, rule) < 1) missed.push(`${rule} ← ${JSON.stringify(text)}`);
    for (const text of doesNotSee) if (ruleHits(cfg, text, rule) > 0) extra.push(`${rule} ← ${JSON.stringify(text)}`);
  }
  assert.deepStrictEqual(missed, [], `formas que el detector NO vio:\n  ${missed.join('\n  ')}`);
  assert.deepStrictEqual(extra, [], `texto legítimo que el detector tomó por un nombre:\n  ${extra.join('\n  ')}`);
  // una forma cuenta UNA vez: partida con comillas no suma al nombre que la línea ya mostraba
  assert.strictEqual(ruleHits(cfg, 'el repo "Zorblax" y nada más', 'Zorblax'), 1);
  assert.strictEqual(ruleHits(cfg, 'Zorblax y "Zorb"lax', 'Zorblax'), 2);
});

/** Las líneas de adentro de los bloques internos de un `.md` (sin los marcadores). */
function internalLines(raw) {
  const out = [];
  let inside = false;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t === MARK.start) inside = true;
    else if (t === MARK.end) inside = false;
    else if (inside) out.push(line);
  }
  return out;
}

// Los marcadores se arman por partes: ninguna línea de este archivo es un marcador, ni se le parece.
const OPEN = '<' + '!--';
const CLOSE = '--' + '>';
const MARK = { start: `${OPEN} tycon:internal-start ${CLOSE}`, end: `${OPEN} tycon:internal-end ${CLOSE}` };

test('T27 PublishingGuide_PublicText_NoAnonymizationRule — la guía no explica en público cómo se eligió cada inventado', () => {
  const rel = 'guides/maintaining/publicacion-espejo.md';
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const text = publicText(rel);
  const start = text.indexOf('\n### La tabla real');
  assert.ok(start >= 0, `${rel}: no encontré la sección «La tabla real»`);
  const next = text.indexOf('\n### ', start + 1);
  const section = text.slice(start, next < 0 ? undefined : next);
  assert.match(section, /La tabla es privada: en lo que se publica no queda ninguna correspondencia entre un inventado y su real\./,
    'la sección tiene que decirlo en general');
  assert.doesNotMatch(text, /S[oó]lo en el repo del equipo/, 'un bloque que es sólo del repo del equipo quedó en el texto público');
  // nada de lo que está adentro de un bloque interno aparece también afuera (en la copia no hay bloques: no hay qué comparar)
  const inside = internalLines(raw).map((l) => l.trim()).filter((l) => l.length >= 30);
  const leaked = inside.filter((l) => text.includes(l));
  assert.deepStrictEqual(leaked, [], `${leaked.length} línea(s) de un bloque interno están también en el texto público`);
});

test('T28 InternalBlocks_NearMarker_Brakes — un marcador casi bien escrito frena, no deja salir el bloque', () => {
  const doc = (a, b) => ['# Guía', '', 'Público.', a, 'SECRETO del equipo.', b, 'Más público.', ''].join('\n');
  const ok = internalBlocks(doc(MARK.start, MARK.end), 'guides/x.md');
  assert.deepStrictEqual(ok.errors, [], 'el control: los dos marcadores bien escritos');
  assert.ok(!ok.text.includes('SECRETO'), 'el control: el bloque no sale');

  const nearPairs = {
    'sin el espacio antes del cierre': [`${OPEN} tycon:internal-start${CLOSE}`, `${OPEN} tycon:internal-end${CLOSE}`],
    'sin el espacio después de la apertura': [`${OPEN}tycon:internal-start ${CLOSE}`, `${OPEN}tycon:internal-end ${CLOSE}`],
    'sin ningún espacio': [`${OPEN}tycon:internal-start${CLOSE}`, `${OPEN}tycon:internal-end${CLOSE}`],
    'con dos espacios': [`${OPEN}  tycon:internal-start ${CLOSE}`, `${OPEN}  tycon:internal-end ${CLOSE}`],
    'con un espacio después de los dos puntos': [`${OPEN} tycon: internal-start ${CLOSE}`, `${OPEN} tycon: internal-end ${CLOSE}`],
    'en mayúsculas': [`${OPEN} TYCON:INTERNAL-START ${CLOSE}`, `${OPEN} TYCON:INTERNAL-END ${CLOSE}`],
    'con otra caja': [`${OPEN} Tycon:Internal-Start ${CLOSE}`, `${OPEN} Tycon:Internal-End ${CLOSE}`],
    'con guion bajo': [`${OPEN} tycon:internal_start ${CLOSE}`, `${OPEN} tycon:internal_end ${CLOSE}`],
    'dentro de una cita': [`> ${MARK.start}`, `> ${MARK.end}`],
    'en un ítem de lista': [`- ${MARK.start}`, `- ${MARK.end}`],
    'con un espacio duro': [`${OPEN}\u00a0tycon:internal-start ${CLOSE}`, `${OPEN}\u00a0tycon:internal-end ${CLOSE}`],
    'con texto en la misma línea': [`${MARK.start} nota`, `${MARK.end} nota`],
    // la errata de DOS caracteres o con otro separador: no es un marcador ni un error de tipeo, y se cuela
    'con dos veces los dos puntos': [`${OPEN} tycon::internal-start ${CLOSE}`, `${OPEN} tycon::internal-end ${CLOSE}`],
    'con dos guiones bajos': [`${OPEN} tycon__internal-start ${CLOSE}`, `${OPEN} tycon__internal-end ${CLOSE}`],
    'con dos guiones': [`${OPEN} tycon--internal-start ${CLOSE}`, `${OPEN} tycon--internal-end ${CLOSE}`],
    'con un punto': [`${OPEN} tycon.internal-start ${CLOSE}`, `${OPEN} tycon.internal-end ${CLOSE}`],
    'con una coma y un espacio': [`${OPEN} tycon, internal-start ${CLOSE}`, `${OPEN} tycon, internal-end ${CLOSE}`],
    'con una barra': [`${OPEN} tycon/internal-start ${CLOSE}`, `${OPEN} tycon/internal-end ${CLOSE}`],
    'con la primera palabra mal escrita': [`${OPEN} tycom:internal-start ${CLOSE}`, `${OPEN} tycom:internal-end ${CLOSE}`],
    'sin la primera palabra': [`${OPEN} internal-start ${CLOSE}`, `${OPEN} internal-end ${CLOSE}`],
    'con un espacio en vez del guion': [`${OPEN} tycon:internal start ${CLOSE}`, `${OPEN} tycon:internal end ${CLOSE}`],
  };
  for (const [what, [a, b]] of Object.entries(nearPairs)) {
    const r = internalBlocks(doc(a, b), 'guides/x.md');
    assert.ok(r.errors.length >= 1, `${what}: los dos marcadores con la misma errata pasaron sin error y el bloque sale`);
    assert.match(r.errors[0].why, /casi/, `${what}: el error tiene que decir que es un marcador casi igual`);
    assert.strictEqual(r.changed, false, `${what}: con errores el texto vuelve como estaba`);
    assert.ok(markerLines(doc(a, b)).length >= 1, `${what}: fuera de un .md tampoco puede pasar sin verse`);
  }
  const sameLine = internalBlocks(['Público.', `${MARK.start} SECRETO ${MARK.end}`, ''].join('\n'), 'guides/x.md');
  assert.ok(sameLine.errors.length >= 1, 'apertura y cierre en la misma línea');
  const publicOnly = internalBlocks(['Público.', `${OPEN} tycon:public-only ${CLOSE}`, ''].join('\n'), 'guides/x.md');
  assert.ok(publicOnly.errors.length >= 1, 'un sólo-público abierto y cerrado en la misma línea');
  // nombrar los marcadores en la prosa (sin el comentario) no es un marcador
  const prose = internalBlocks('El texto entre `tycon:internal-start` y `tycon:internal-end` no sale.\n', 'guides/x.md');
  assert.deepStrictEqual(prose.errors, []);
  assert.strictEqual(markerLines('El texto entre `tycon:internal-start` y `tycon:internal-end` no sale.\n').length, 0);

  // con las guías de verdad: si sus marcadores se rompen los dos igual, el exportador tiene que frenar
  for (const rel of ['guides/maintaining/publicacion-espejo.md', 'guides/reglas-para-revisores.md']) {
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (!raw.includes(MARK.start)) continue;   // en la copia la guía ya salió sin sus bloques
    const broken = raw.split(MARK.start).join(`${OPEN} tycon:internal-start${CLOSE}`).split(MARK.end).join(`${OPEN} tycon:internal-end${CLOSE}`);
    assert.ok(internalBlocks(broken, rel).errors.length >= 2, `${rel}: con los dos marcadores rotos igual, no frenó`);
  }
});

/** La lista privada y la tabla de reemplazos: sólo en el repo del equipo. En la copia no viajan. */
function privateLists() {
  const dir = path.join(ROOT, 'scripts', 'publishing');
  const denied = path.join(dir, 'denylist.json');
  const table = path.join(dir, 'replacements.json');
  if (!fs.existsSync(denied) || !fs.existsSync(table)) return null;
  return { denied, list: JSON.parse(fs.readFileSync(denied, 'utf8')), table: JSON.parse(fs.readFileSync(table, 'utf8')) };
}

test('T29 RealList_EachPatternSeesItsSamples — cada patrón de la lista de verdad ve sus muestras y no ve sus contramuestras', (t) => {
  const lists = privateLists();
  if (!lists) {
    t.skip('NO MEDIDO: esta copia no trae la lista privada (scripts/publishing/denylist.json)');
    return;
  }
  const cfg = detector.cargarConfig(lists.denied);
  const problems = [];
  const check = (rule, entry, where) => {
    for (const s of entry.ve || []) if (ruleHits(cfg, s, rule) < 1) problems.push(`${where}: no ve su muestra ve[${entry.ve.indexOf(s)}]`);
    for (const s of entry.noVe || []) if (ruleHits(cfg, s, rule) > 0) problems.push(`${where}: toma por hallazgo su contramuestra noVe[${entry.noVe.indexOf(s)}]`);
  };
  (lists.list.patrones || []).forEach((p, i) => {
    if (!Array.isArray(p.ve) || p.ve.length === 0) problems.push(`patrones[${i}] (${p.nombre}): sin muestras («ve»): un patrón sin muestras no está probado`);
    // las dos mitades: sin contramuestras, un patrón puede estar frenando texto legítimo y nadie se entera
    if (!Array.isArray(p.noVe) || p.noVe.length === 0) problems.push(`patrones[${i}] (${p.nombre}): sin contramuestras («noVe»): no está probado que deje pasar lo que no es`);
    // Un patrón que es una lista larga de alternativas recorre cada renglón
    // de la copia si no lleva `pistas`: cuatro así llevan el detector de 8 a 45 segundos. Con ocho ramas o más, las lleva.
    const ramas = String(p.regex || '').split(')|(?:').length;
    if (ramas >= 8 && !(Array.isArray(p.pistas) && p.pistas.length)) problems.push(`patrones[${i}] (${p.nombre}): ${ramas} alternativas y sin «pistas»: recorre todos los renglones de la copia`);
    check(p.nombre, p, `patrones[${i}] (${p.nombre})`);
  });
  // un término puede declarar las suyas (las formas que la regla general no ve)
  let withSamples = 0;
  (lists.list.terminos || []).forEach((term, i) => {
    if (term.ve || term.noVe) withSamples++;
    // un término que APAGA la forma pegada (`glued: false`) tiene que mostrar qué deja pasar: sin contramuestras, si el
    // interruptor se rompe nadie se entera
    if (term.glued === false && (!Array.isArray(term.noVe) || term.noVe.length === 0)) problems.push(`terminos[${i}] (${term.categoria}): apaga la forma pegada (glued: false) sin contramuestras («noVe») que lo comprueben`);
    check(term.patron, term, `terminos[${i}] (${term.categoria})`);
  });
  assert.ok(withSamples >= 5, `la lista declara muestras en ${withSamples} términos: faltan las de la segunda vuelta`);
  // el mensaje nunca trae un valor entero de la lista: la posición alcanza para encontrarlo
  assert.deepStrictEqual(problems, [], `la lista privada no ve lo que ella misma declara:\n  ${problems.join('\n  ')}`);
});

test('T30 RealList_KeychainEntry_AnyClientAliasIsSeen — la entrada de llavero con el inventado de cualquier cliente se ve', (t) => {
  const lists = privateLists();
  if (!lists) {
    t.skip('NO MEDIDO: esta copia no trae la lista privada ni la tabla de reemplazos');
    return;
  }
  const cfg = detector.cargarConfig(lists.denied);
  const seen = (text) => detector.reviewText(cfg, text, 'muestra/llavero.txt').hallazgos.length > 0;
  // cada inventado simple de un par de cliente, tal cual lo deja la tabla en una entrada de llavero
  const aliases = new Set();
  for (const pair of lists.table.pares || []) {
    if (pair.categoria !== 'cliente') continue;
    for (const f of pair.formas || []) if (/^[A-Za-z][A-Za-z0-9]*$/.test(f.anonimo)) aliases.add(f.anonimo.toLowerCase());
  }
  assert.ok(aliases.size >= 30, `la tabla tiene que dar los inventados de cliente (dio ${aliases.size})`);
  const prefix = ['tycon', 'prod'].join('-');
  const unseen = [];
  let n = 0;
  for (const alias of [...aliases].sort()) {
    n++;
    const forms = [`${prefix}-${alias}`, `${prefix}-${alias}x`, `${prefix.replace('-', '_')}_${alias}`, `"${prefix}-"${alias}`, `tycon-pro?-${alias}`];
    forms.forEach((form, k) => { if (!seen(`security find-generic-password -s ${form} -w`)) unseen.push(`inventado #${n}, forma ${k}`); });
  }
  assert.deepStrictEqual(unseen, [], `entradas de llavero con el inventado de un cliente que nadie ve: ${unseen.join(' · ')}`);
  // …y las de ejemplo, que son neutras, siguen pasando
  for (const neutral of ['acme', 'globex', 'x']) assert.strictEqual(seen(`la entrada ${prefix}-${neutral} del llavero`), false, `la entrada neutra «${neutral}» dejó de pasar`);
});

// ── Las dos listas de la suite de humo contra las de antes ───────────────────────────────────────────────
// Las listas de antes no viven en el árbol: traen nombres de verdad. Se leen de la HISTORIA del repo del equipo, por
// commit, y nunca se copian acá. Sin esa historia
// (la copia pública, un clon sin profundidad) no hay contra qué comparar: NO MEDIDO.
const OLD_SMOKE_LISTS = [
  { commit: '8087e112219b05e08fd193d9952bbc16f32945a9', what: 'la de antes de la story' },
  { commit: '3d39d1020b1292047e267839114d0944a5ca69bb', what: 'la de la primera vuelta' },
];

/** Las dos listas (plugins y formularios) de un texto de smoke.test.sh, por la forma de la asignación y no por su nombre. */
function smokeLists(text) {
  const list = (word) => {
    const m = text.match(new RegExp(`^[A-Z_]*${word}[A-Z_]*="([^"]*)"$`, 'm'));
    return m ? m[1].split(/\s+/).filter(Boolean) : [];
  };
  return { plugins: list('PLUGINS'), forms: list('FORMS') };
}

/** El archivo en un commit, o null si esta copia no tiene ese commit. Sin las variables de git de un hook que nos llame. */
function fileAtCommit(commit, rel) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^GIT_/.test(k)) delete env[k];
  const r = require('child_process').spawnSync('git', ['show', `${commit}:${rel}`], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 1 << 26 });
  return r.status === 0 ? r.stdout : null;
}

test('T35 SmokeLists_NothingFromTheOldLists — ningún nombre de las listas de humo repite uno de las de antes, ni entero ni su cola', (t) => {
  const rel = 'scripts/tests/smoke.test.sh';
  const now = smokeLists(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  assert.strictEqual(now.plugins.length, 9, 'la lista de plugins de hoy');
  assert.strictEqual(now.forms.length, 65, 'la lista de formularios de hoy');
  const tail = (name) => name.replace(/^[A-Za-z0-9]+[-_]/, '').toLowerCase();   // lo de después del prefijo
  // el control: la cola se saca bien, y una lista que repite una cola vieja se ve
  assert.strictEqual(tail('ACME-EtiquetaBolsa'), 'etiquetabolsa');
  assert.strictEqual(tail('demo_stock'), 'stock');

  const problems = [];
  const measured = [];
  for (const { commit, what } of OLD_SMOKE_LISTS) {
    const text = fileAtCommit(commit, rel);
    if (text === null) continue;
    const old = smokeLists(text);
    assert.ok(old.plugins.length >= 9 && old.forms.length >= 65, `${what}: el commit está pero no pude leer sus dos listas (${old.plugins.length} y ${old.forms.length})`);
    measured.push(what);
    const whole = new Set([...old.plugins, ...old.forms].map((n) => n.toLowerCase()));
    const tails = new Set(old.forms.map(tail));
    // el mensaje dice la posición, nunca el nombre: el de antes puede ser de verdad
    now.plugins.forEach((n, i) => { if (whole.has(n.toLowerCase())) problems.push(`plugins[${i}] repite un nombre entero de ${what}`); });
    now.forms.forEach((n, i) => {
      if (whole.has(n.toLowerCase())) problems.push(`formularios[${i}] repite un nombre entero de ${what}`);
      else if (tails.has(tail(n))) problems.push(`formularios[${i}] repite la cola de un nombre de ${what}`);
    });
  }
  if (measured.length === 0) {
    t.skip('NO MEDIDO: esta copia no tiene la historia con las listas de antes (la copia pública, o un clon sin profundidad)');
    return;
  }
  assert.deepStrictEqual(problems, [], `las listas de humo repiten algo de las de antes (medido contra: ${measured.join(' y ')}):\n  ${problems.join('\n  ')}`);
});

// ── T36 · una sigla «pegada» que cae ADENTRO de otro nombre de la lista no es un hallazgo aparte ──────────────────────
// Sin esto, con `ACME` y `AcmeCorp` en la lista,
// la forma pegada de la sigla (`Acme` delante de otra palabra en CamelCase) coincide también con el comienzo de
// `AcmeCorp`: cada aparición cuenta DOS veces, y un archivo donde `AcmeCorp` está permitido por una excepción pasa
// a tener un hallazgo. La excepción cubre el nombre entero, no el pedazo.
test('T36 GluedAcronym_InsideAnotherListedName_IsNotASecondFinding — la sigla pegada dentro de otro nombre de la lista no cuenta aparte', () => {
  const list = (permitidos = []) => JSON.stringify({
    terminos: [{ patron: 'AcmeCorp', categoria: 'cliente', palabra: true }, { patron: 'ACME', categoria: 'cliente', palabra: true, mayusculas: true }],
    patrones: [], emailsPermitidos: [], binariosPermitidos: [], excluir: [], permitidos,
  });
  const rules = (cfg, text, file) => detector.reviewText(cfg, text, file).hallazgos.map((h) => h.regla);
  const cfg = detector.cargarConfig('lab.json', list());
  assert.deepStrictEqual(rules(cfg, 'Lo pidió AcmeCorp.\n', 'docs/x.md'), ['AcmeCorp'], 'el nombre entero, una sola vez');
  // la sigla pegada a una palabra que NO es de la lista sigue siendo un hallazgo
  assert.deepStrictEqual(rules(cfg, 'la clase AcmeBackend\n', 'docs/x.md'), ['ACME (pegada en CamelCase)']);
  // y las dos cosas en la misma línea se cuentan cada una por lo suyo
  assert.deepStrictEqual(rules(cfg, 'AcmeCorp usa AcmeBackend y ACME\n', 'docs/x.md').sort(), ['ACME', 'ACME (pegada en CamelCase)', 'AcmeCorp']);
  // con el nombre entero permitido en ese archivo, el pedazo no reaparece como hallazgo
  const allowed = detector.cargarConfig('lab.json', list([{ archivo: 'docs/permitido.md', patron: 'AcmeCorp', motivo: 'laboratorio: el nombre, en ese archivo' }]));
  const inAllowed = detector.reviewText(allowed, 'Lo pidió AcmeCorp.\n', 'docs/permitido.md');
  assert.deepStrictEqual(inAllowed.hallazgos, [], 'en el archivo de la excepción no queda ningún hallazgo');
  assert.strictEqual(inAllowed.permitidos, 1);
  assert.deepStrictEqual(rules(allowed, 'Lo pidió AcmeCorp.\n', 'docs/otra.md'), ['AcmeCorp'], 'en otro archivo, el nombre entero y nada más');
});

// ── Casos límite de la lista y de los bloques ─────────────────────────────────────────────────────────────────────────
// Cada prueba reproduce el caso que la motiva, con la lista
// sintética. El nombre lleva el prefijo `8.10.2` para no chocar con las T numeradas de este mismo archivo.

/** Las muestras que una regla NO ve y las contramuestras que SÍ ve (las dos listas tienen que quedar vacías). */
function sweepRule(cfg, rule, sees, doesNotSee = []) {
  return {
    missed: sees.filter((text) => ruleHits(cfg, text, rule) < 1),
    extra: doesNotSee.filter((text) => ruleHits(cfg, text, rule) > 0),
  };
}

const sweepCfg = () => detector.cargarConfig('lista-sintetica.json', JSON.stringify(SWEEP_LIST));

/** Un documento con un bloque interno entre `a` y `b`. */
const blockDoc = (a, b) => ['# Guía', '', 'Público.', a, 'SECRETO del equipo.', b, 'Más público.', ''].join('\n');

/** Que un documento frene como «casi» marcador, en un `.md` y fuera de él. */
function assertBrakes(doc, what) {
  const r = internalBlocks(doc, 'guides/x.md');
  assert.ok(r.errors.length >= 1, `${what}: pasó sin error y el bloque sale`);
  assert.ok(r.errors.some((e) => /casi/.test(e.why)), `${what}: el error tiene que decir que es un marcador casi igual`);
  assert.strictEqual(r.changed, false, `${what}: con errores el texto vuelve como estaba`);
  assert.ok(markerLines(doc).length >= 1, `${what}: fuera de un .md tampoco puede pasar sin verse`);
}

test('8.10.2 T2 InternalBlocks_TypoInsideTheWord_Brakes — una errata dentro de «internal» o «public» frena', () => {
  const pairs = {
    'dos letras cambiadas de lugar': ['intenral-start', 'intenral-end'],
    'una letra de menos': ['interal-start', 'interal-end'],
    'otra letra de menos': ['internl-start', 'internl-end'],
  };
  for (const [what, [a, b]] of Object.entries(pairs)) {
    assertBrakes(blockDoc(`${OPEN} tycon:${a} ${CLOSE}`, `${OPEN} tycon:${b} ${CLOSE}`), what);
  }
  assertBrakes(['Público.', `${OPEN} tycon:pubilc-only`, 'sólo afuera', CLOSE, ''].join('\n'), 'el sólo-público con dos letras cambiadas');
});

test('8.10.2 T3 InternalBlocks_CommentSplitAcrossLines_Brakes — el comentario partido en renglones frena', () => {
  // el `<!--` solo en su renglón y el resto abajo: en dos renglones…
  assertBrakes(['# G', '', OPEN, `tycon:internal-start ${CLOSE}`, 'SECRETO', OPEN, `tycon:internal-end ${CLOSE}`, 'fin', ''].join('\n'), 'en dos renglones');
  // …y en tres
  assertBrakes(['Público.', OPEN, 'tycon:internal-start', CLOSE, 'SECRETO', OPEN, 'tycon:internal-end', CLOSE, 'fin', ''].join('\n'), 'en tres renglones');
  // Frena con cualquier cosa delante del `<!--` partido: prosa, un ítem de lista numerada, o
  // la primera palabra del marcador en el renglón de arriba
  assertBrakes(['Público.', `Ver ${OPEN}`, `tycon:internal-start ${CLOSE}`, 'SECRETO', `Ver ${OPEN}`, `tycon:internal-end ${CLOSE}`, 'fin', ''].join('\n'), 'con prosa delante');
  assertBrakes(['Público.', `1. ${OPEN}`, `tycon:internal-start ${CLOSE}`, 'SECRETO', `2. ${OPEN}`, `tycon:internal-end ${CLOSE}`, 'fin', ''].join('\n'), 'en una lista numerada');
  assertBrakes(['Público.', `${OPEN} tycon:`, `internal-start ${CLOSE}`, 'SECRETO', `${OPEN} tycon:`, `internal-end ${CLOSE}`, 'fin', ''].join('\n'), 'partido en el medio del contenido');
  // Frena partido en tres y en cuatro renglones: el comentario sigue hasta su cierre
  assertBrakes(['Público.', OPEN, 'tycon:', `internal-start ${CLOSE}`, 'SECRETO', OPEN, 'tycon:', `internal-end ${CLOSE}`, 'fin', ''].join('\n'), 'en tres renglones, cortado en el medio');
  assertBrakes(['Público.', OPEN, 'tycon:', 'internal-start', CLOSE, 'SECRETO', OPEN, 'tycon:', 'internal-end', CLOSE, 'fin', ''].join('\n'), 'en cuatro renglones');
  // Un `-->` en el medio cierra el comentario antes y deja el cuerpo del
  // marcador suelto en su renglón; y partido en más renglones que los que sigue un comentario abierto. El renglón que es
  // sólo el cuerpo de un marcador frena, esté o no adentro de un comentario
  assertBrakes(['Público.', OPEN, 'rango x--' + '>y', 'tycon:internal-start', CLOSE, 'SECRETO', OPEN, 'rango x--' + '>y', 'tycon:internal-end', CLOSE, 'fin', ''].join('\n'), 'un cierre falso en el medio');
  const lejos = (body) => [OPEN, 'a', 'b', 'c', 'd', 'e', 'f', body, CLOSE];
  assertBrakes(['Público.', ...lejos('tycon:internal-start'), 'SECRETO', ...lejos('tycon:internal-end'), 'fin', ''].join('\n'), 'partido en ocho renglones');
  assertBrakes(['Público.', '- tycon:internal-start', 'SECRETO', '- tycon:internal-end', ''].join('\n'), 'el cuerpo del marcador suelto, en una lista');
  // nombrarlo en una frase, o un título que dice «internal start», no es un marcador
  for (const ok of ['El texto entre tycon:internal-start y tycon:internal-end no sale.', '## Internal start', 'internal end']) {
    assert.deepStrictEqual(internalBlocks(`${ok}\n`, 'guides/x.md').errors, [], `no es un marcador: ${ok}`);
  }
  // un comentario común que sigue abajo no frena
  const comun = ['Texto.', `Ver ${OPEN}`, `una nota cualquiera para el equipo ${CLOSE}`, 'fin', ''].join('\n');
  assert.deepStrictEqual(internalBlocks(comun, 'guides/x.md').errors, [], 'un comentario común en dos renglones no es un marcador');
  // el sólo-público se escribe a propósito en varios renglones y sigue andando
  const ok = internalBlocks(['Antes.', `${OPEN} tycon:public-only`, 'sólo en la copia', CLOSE, 'Después.', ''].join('\n'), 'guides/x.md');
  assert.deepStrictEqual(ok.errors, [], 'el sólo-público de varias líneas no es un marcador partido');
  assert.strictEqual(ok.text, ['Antes.', 'sólo en la copia', 'Después.', ''].join('\n'));
});

test('8.10.2 T4 InternalBlocks_OrdinaryComments_DoNotBrake — un comentario común que nombra «internal» o «public» no frena', () => {
  const ordinary = [
    'internal endpoints: keep in sync with the API',
    'the internal startup sequence',
    'public only for beta',
    'TODO: internal end-of-life notes',
    'publicOnly flag documented below',
    'TYCON publicación espejo: ver guía',
  ];
  const braked = [];
  for (const c of ordinary) {
    const doc = ['# x', `${OPEN} ${c} ${CLOSE}`, 'texto', ''].join('\n');
    const r = internalBlocks(doc, 'guides/x.md');
    if (r.errors.length || r.text !== doc || markerLines(doc).length) braked.push(c);
  }
  assert.deepStrictEqual(braked, [], 'comentarios comunes tomados por un marcador');
  // empezar con la palabra del arnés seguida de algo parecido a «internal» o «public» queda reservado para los marcadores
  assertBrakes(['# x', `${OPEN} tycon internals, no tocar ${CLOSE}`, 'texto', ''].join('\n'), 'la palabra del arnés + «internals»');
  // Un apóstrofo o unas comillas en el comentario no lo vuelven «código
  // que arma un marcador»: eso es sólo la concatenación de cadenas
  assertBrakes(blockDoc(`${OPEN} tycon:internal-start isn't optional ${CLOSE}`, `${OPEN} tycon:internal-end, that's it ${CLOSE}`), 'con un apóstrofo');
  assertBrakes(blockDoc(`${OPEN} tycon:internal-start "nota" ${CLOSE}`, `${OPEN} tycon:internal-end \`x\` ${CLOSE}`), 'con comillas');
  // Frena una etiqueta delante del marcador, en el mismo comentario
  for (const label of ['marker:', 'BEGIN', 'inicio', 'config.js:']) {
    assertBrakes(blockDoc(`${OPEN} ${label} tycon:internal-start ${CLOSE}`, `${OPEN} ${label} tycon:internal-end ${CLOSE}`), `con la etiqueta «${label}» delante`);
  }
  // Una línea enorme con guiones después de un comentario sin cerrar no la cuelga
  const t0 = Date.now();
  markerLines(`${OPEN} ${'-'.repeat(300000)} x\n`);
  assert.ok(Date.now() - t0 < 1000, `una línea de 300.000 guiones tardó ${Date.now() - t0} ms`);
});

test('8.10.2 T6 GluedAcronym_UppercaseInCamelCase_IsSeen — la sigla pegada con su grafía en mayúsculas se ve', () => {
  const cfg = sweepCfg();
  const r = sweepRule(cfg, 'ZRB',
    ['SYSTEM_STAGENAME=DeployZRBStaging', 'job: DeployToZRB', 'class PanelZRB {}'],
    ['ZRBX es otra cosa', 'un 20ZRB cualquiera', 'un Zrbito cualquiera']);
  assert.deepStrictEqual(r, { missed: [], extra: [] });
  // la sigla al PRINCIPIO de un nombre la ve el control de nombres pegados del exportador (el prefijo): el
  // detector no la cuenta otra vez (sobre el repo, contarla en los dos sumaba 400 avisos duplicados)
  const { nombresPegados } = require(path.join(ROOT, 'scripts', 'publishing', 'export.js'));
  assert.strictEqual(nombresPegados([['x.cs', 'la clase ZRBBackend']], SWEEP_LIST.terminos).filter((h) => h.termino === 'ZRB').length, 1);
  assert.strictEqual(ruleHits(cfg, 'la clase ZRBBackend', 'ZRB'), 0);
  // con `glued: false` la sigla no se busca pegada, tampoco con su grafía
  assert.deepStrictEqual(sweepRule(cfg, 'NOX', [], ['DeployNOXStaging', 'class PanelNOX {}', 'NOXBackend']).extra, []);
});

test('8.10.2 T7 OtherCase_BackslashAndAtSign_IsSeen — la sigla junto a una barra invertida o antes de una arroba se ve', () => {
  const cfg = sweepCfg();
  const samples = ['C:\\clientes\\zrb\\backend', JSON.stringify('C:\\clientes\\zrb\\backend'), 'cd ..\\zrb\\src',
    // un email de un dominio de verdad se arma por partes: entero, este archivo saldría con un email en la copia
    'zrb@corp.example.com', ['mail: zrb@gmail', 'com'].join('.')];
  assert.deepStrictEqual(sweepRule(cfg, 'ZRB', samples).missed, [], 'formas que el detector no vio como el término');
});

test('8.10.2 T8 KeyValue_YamlIniToml_IsSeen — la sigla como valor de una clave se ve con comentario, espacios o llaves', () => {
  const r = sweepRule(sweepCfg(), 'ZRB',
    ['project: zrb  # el cliente', 'project = zrb', '{ project: zrb }', 'repo: zrb  # x'],
    ['la opción es: zrb y nada más']);
  assert.deepStrictEqual(r, { missed: [], extra: [] });
});

test('8.10.2 T9 GluedInProjectKey_AnyCaseAndTrailingComment_IsSeen — la sigla pegada en el valor de una clave de proyecto se ve en cualquier caja', () => {
  const r = sweepRule(sweepCfg(), 'ZRB',
    ['ENGRAM_PROJECT=zrbviejo', 'export ENGRAM_PROJECT=zrbviejo', 'PROJECT=proyectozrb', '"Project": "zrbforms",', 'REPO=zrbforms',
      'project: proyectozrb # x', 'repo: zrbForms', 'repo: zrbBackend'],
    ["title: 'proyectozrb'", 'el proyectozrb en la prosa']);
  assert.deepStrictEqual(r, { missed: [], extra: [] });
});

test('8.10.2 T10 AccentedWord_GluedWithoutAccent_IsSeen — un término con tilde, sin ella y pegado en CamelCase se ve', () => {
  const { nombresPegados } = require(path.join(ROOT, 'scripts', 'publishing', 'export.js'));
  const cfg = sweepCfg();
  const seen = (text) => ruleHits(cfg, text, 'Almacén') > 0 || nombresPegados([['x.cs', text]], SWEEP_LIST.terminos).some((h) => h.termino === 'Almacén');
  const missed = ['class AlmacenService {}', 'ServiceAlmacen', 'AlmacenesService'].filter((t) => !seen(t));
  assert.deepStrictEqual(missed, [], 'ni el detector ni el control de nombres pegados lo ven');
  const extra = ['el almacenamiento', 'Almacenamiento'].filter(seen);
  assert.deepStrictEqual(extra, [], 'pegado a una minúscula es otra palabra');
});

test('8.10.2 T11 PluralEs_SingularEndingInE_IsSeen — el singular de un plural en «-es» que termina en «e» se ve', () => {
  const cfg = detector.cargarConfig('lab.json', JSON.stringify({ terminos: [
    { patron: 'Deportes', categoria: 'cliente', palabra: true }, { patron: 'Sucursales', categoria: 'cliente', palabra: true }] }));
  assert.deepStrictEqual(sweepRule(cfg, 'Deportes', ['el Deporte de hoy', 'un deporte', 'los Deportes'], ['el deportivo']), { missed: [], extra: [] });
  assert.deepStrictEqual(sweepRule(cfg, 'Sucursales', ['una Sucursal', 'las sucursales']).missed, []);
});

test('8.10.2 T12 EnieAndCedilla_InAscii_AreSeen — la ñ y la ç escritas en ASCII se ven', () => {
  const cfg = detector.cargarConfig('lab.json', JSON.stringify({ terminos: [
    { patron: 'Zoñar', categoria: 'persona' }, { patron: 'Brançal', categoria: 'persona' }] }));
  assert.deepStrictEqual(sweepRule(cfg, 'Zoñar', ['Zoñar', 'Zonar', 'zonar-x', 'juan.zonar']).missed, []);
  assert.deepStrictEqual(sweepRule(cfg, 'Brançal', ['Brançal', 'Brancal', 'brancal_y']).missed, []);
});

test('8.10.2 T13 GluedAcronym_InsideBase64_IsNotAFinding — la sigla pegada dentro de una tira de base64 no cuenta', () => {
  const cfg = sweepCfg();
  const sha = `k3aZrbQ9xYw0${'AbCdEfGh12345678'.repeat(4)}ZRBq7Lm2==`;
  const lines = [
    `"integrity": "sha512-${sha}",`,
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB9ZrbCAYAAAAfFcSJAAAADUlEQVR42mNkZRBhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ];
  const glued = (text) => detector.reviewText(cfg, text, 'x.json').hallazgos.filter((h) => /^ZRB \(pegada/.test(h.regla));
  for (const l of lines) assert.deepStrictEqual(glued(l), [], `una tira de base64 no es un nombre: ${l.slice(0, 40)}…`);
  // la misma sigla pegada en un identificador común se sigue viendo, también en una ruta larga sin dígitos
  assert.strictEqual(glued('stage: DeployZrbStaging').length, 1);
  assert.strictEqual(glued('src/components/DeployZrbStaging/views/IndexPanelView.tsx').length, 1);
});

test('8.10.2 T14 GluedAcronym_InsideAnEmail_IsStillSeen — una sigla pegada sólo la tapa otro nombre de la lista', () => {
  const cfg = sweepCfg();
  // el segundo, un dominio que no es de ejemplo, armado por partes (entero saldría como email en la copia)
  assert.deepStrictEqual(sweepRule(cfg, 'ZRB', ['mail buildZrb@example.com now', ['mail buildZrb@acme', 'io now'].join('.')]).missed, []);
});

test('8.10.2 T15 FlattenedLine_CountsByPosition — la pasada sin comillas no pierde una forma partida', () => {
  const cfg = sweepCfg();
  assert.strictEqual(ruleHits(cfg, `x = {'c': 'zrb', 'n': "Z" + "RB"}`, 'ZRB'), 2, 'la sigla entre comillas y la forma partida');
  assert.strictEqual(ruleHits(cfg, `'zrb' "ZR"B`, 'ZRB'), 2, 'la sigla entre comillas y la forma partida, pegadas');
  assert.strictEqual(ruleHits(cfg, `n = "Z" + "RB" y m = "Z" + "RB"`, 'ZRB'), 2, 'dos formas partidas');
  // lo de T26, igual
  assert.strictEqual(ruleHits(cfg, 'el repo "Zorblax" y nada más', 'Zorblax'), 1);
  assert.strictEqual(ruleHits(cfg, 'Zorblax y "Zorb"lax', 'Zorblax'), 2);
});

test('8.10.2 T16 LineJoin_SameOccurrence_CountsOnce — la unión de renglones no repite una aparición', () => {
  assert.strictEqual(ruleHits(sweepCfg(), 'run ZRB\\\ns --go', 'ZRB'), 1);
});
