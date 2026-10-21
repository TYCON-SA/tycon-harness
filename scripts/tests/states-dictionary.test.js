'use strict';
/**
 * states-dictionary.test.js — la red del vocabulario de estados de story.
 *
 * Valida el ARCHIVO (`scripts/metrics/states.json`) y su relación con el resto del arnés, sin
 * correr el medidor: son chequeos de forma, baratos y deterministas. Lo que necesita medir de
 * verdad (que el conteo cierre, que el diccionario ilegible no publique cero) vive en
 * `sdlc-transitions.test.js`, que arma repos git efímeros.
 *
 * 🔴 REGLA DE ADMISIÓN: cada caso trae escrita, en su comentario, la
 *    MUTACIÓN que lo pone en rojo. Un caso que no sabe ponerse rojo no vale.
 *
 * Lo que cuida, en una frase: que el diccionario no se contradiga a sí mismo, que ningún estado
 * medido en los repos reales quede sin una decisión ESCRITA, que cada canónico esté en
 * exactamente un grupo, que el código no vuelva a tener su propia lista de «cerrado», y que lo
 * que el orquestador del pipeline ESCRIBE el diccionario lo sepa LEER.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const METRICS = path.resolve(__dirname, '..', 'metrics');
const ESTADOS_PATH = path.join(METRICS, 'states.json');
// El censo de estados medidos: el que se le pase (TYCON_STATES_CENSUS=<ruta>, para medir contra uno propio más nuevo) o
// el de la carpeta de datos de prueba, que trae sólo los valores de una corrida real del medidor (sin repos ni conteos).
const CENSO_PATH = process.env.TYCON_STATES_CENSUS
  ? path.resolve(process.env.TYCON_STATES_CENSUS)
  : path.resolve(__dirname, 'fixtures', 'states-census.json');
const FUENTE_MEDIDOR = path.join(METRICS, 'sdlc-stage-metrics.js');
const DASHBOARD = path.resolve(__dirname, '..', '..', '.dashboard');

const dict = JSON.parse(fs.readFileSync(ESTADOS_PATH, 'utf8'));

/** El fuente sin comentarios: bloques `/* *\/` y lo que sigue a `//` fuera de una cadena. */
function sinComentarios(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1'))
    .join('\n');
}

/** El mismo normalizado que `canonEstado()`. Se copia a propósito: este archivo valida la FORMA
 *  del diccionario sin cargar el medidor (que a su vez lee el diccionario). */
const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

/** Resuelve un valor crudo contra el diccionario: canónico, alias, o null. */
function resolver(valor) {
  const k = norm(valor);
  if (!k) return null;
  if (dict.canonical.includes(k)) return k;
  if (Object.prototype.hasOwnProperty.call(dict.alias || {}, k)) return dict.alias[k];
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T1 · el diccionario no se contradice a sí mismo
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T1 · todos los alias apuntan a un canónico, sin duplicados y sin doble rol', () => {
  // 🔴 rojo: un alias a un canónico inexistente (`"foo": "shipped"`) — hoy nadie lo mira.
  assert.ok(Array.isArray(dict.canonical) && dict.canonical.length,
    'canonical tiene que ser una lista no vacía');

  const vistos = new Set();
  for (const c of dict.canonical) {
    assert.ok(!vistos.has(c), `el canónico ${c} está duplicado en la lista`);
    vistos.add(c);
  }

  assert.ok(dict.alias && typeof dict.alias === 'object', 'alias tiene que ser un objeto');
  for (const [alias, destino] of Object.entries(dict.alias)) {
    assert.ok(dict.canonical.includes(destino),
      `el alias ${alias} apunta a "${destino}", que no es un canónico`);
    assert.ok(!dict.canonical.includes(alias),
      `${alias} figura como alias y como canónico a la vez — uno de los dos manda y no se sabe cuál`);
  }
});

test('T2 · las claves están normalizadas (minúscula, sin espacios de más)', () => {
  // 🔴 rojo: guardar la clave cruda (`" Ready-For-Dev "`). `canonEstado` normaliza la
  //    ENTRADA pero no la CLAVE, así que ese alias no matchearía nunca: falla silenciosa.
  for (const c of dict.canonical) {
    assert.equal(c, norm(c), `el canónico "${c}" no está normalizado (sería "${norm(c)}")`);
  }
  for (const a of Object.keys(dict.alias || {})) {
    assert.equal(a, norm(a), `el alias "${a}" no está normalizado (sería "${norm(a)}")`);
  }
  for (const [g, lista] of Object.entries(dict.groups || {})) {
    for (const e of lista) {
      assert.equal(e, norm(e), `la entrada "${e}" del grupo ${g} no está normalizada`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T3 · ningún estado medido queda sin decisión escrita
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T3 · cada estado del censo tiene decisión escrita (y el snapshot AVISA, no frena)', () => {
  // 🔴 rojo: agregar un valor al censo sin decidirlo en `alias` ni en `_decisions`.
  //
  // 🔴 El fixture NO se tipea a mano: sale del archivo que produjo el propio medidor
  //    (`fixtures/states-census.json`, los valores del censo de una corrida real). Una lista escrita a mano sólo mide lo que alguien se
  //    acordó de anotar: perdería estados vivos como `updated` y `redundant`.
  assert.ok(fs.existsSync(CENSO_PATH),
    `falta el censo commiteado (${CENSO_PATH}): sin él este caso no mide nada`);
  const censo = JSON.parse(fs.readFileSync(CENSO_PATH, 'utf8'));
  assert.ok(Array.isArray(censo.valores) && censo.valores.length,
    'el censo tiene que traer la lista `valores` (la UNIÓN del contador actual y el histórico)');

  const decididos = new Map();
  for (const d of dict._decisions || []) {
    assert.ok(d && d.valor, 'cada entrada de _decisions necesita `valor`');
    assert.ok(d.reason && String(d.reason).trim().length > 10,
      `la decisión sobre "${d.valor}" no trae motivo en castellano (\`reason\`)`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '')),
      `la decisión sobre "${d.valor}" no trae fecha (\`date\`, AAAA-MM-DD)`);
    decididos.set(norm(d.valor), d);
  }

  const sinDecidir = [];
  for (const v of censo.valores) {
    if (resolver(v)) continue;              // mapeado a un canónico: decidido
    if (decididos.has(norm(v))) continue;   // declarado «no es un estado»: decidido
    sinDecidir.push(v);
  }
  assert.deepEqual(sinDecidir, [],
    `estados medidos en los repos sin decisión escrita: ${sinDecidir.join(', ')}. `
    + 'Van a `alias`/`canonical` con su canónico, o a `_decisions` con motivo y fecha.');

  // 🔴 La segunda fuente AVISA y NO frena, a propósito. Se miden ≈3 estados nuevos por mes entre
  //    los 20 repos: assertar contra el snapshot pondría la suite del arnés en rojo una vez por
  //    mes por un repo de OTRO producto, sin que cambie una línea de código, y la salida sería
  //    editar el diccionario en vez de arreglar nada. Eso es un veredicto que cambia
  //    sin que cambie el código. El canal de alarma es la ficha del tablero, que los nombra con su cuenta.
  const nuevos = estadosDelUltimoSnapshot();
  if (nuevos === null) {
    console.log('ℹ️  T3: no hay snapshot del nocturno en .dashboard/ — sólo se validó el censo commiteado');
  } else {
    const sinVer = nuevos.filter((v) => !resolver(v) && !decididos.has(norm(v)));
    if (sinVer.length) {
      console.log(`⚠️  T3 (aviso, no falla): el último snapshot del nocturno trae ${sinVer.length} `
        + `estado(s) que el diccionario todavía no decide: ${sinVer.join(', ')}. `
        + 'Se ven en la ficha «desconocidas» del tablero; entran al diccionario cuando alguien los mire.');
    }
  }
});

/** Los estados sin diccionario del snapshot más reciente que viaja por git. `null` si no hay. */
function estadosDelUltimoSnapshot() {
  let archivos = [];
  try {
    archivos = fs.readdirSync(DASHBOARD)
      .filter((f) => /^sdlc-stage-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch { return null; }
  if (!archivos.length) return null;
  const ultimo = path.join(DASHBOARD, archivos[archivos.length - 1]);
  let d;
  try { d = JSON.parse(fs.readFileSync(ultimo, 'utf8')); } catch { return null; }
  const out = new Set();
  const epc = (d.global || {}).estados_por_canonico;
  for (const k of Object.keys((epc && epc.sin_diccionario) || {})) out.add(k);
  return [...out];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T6 · los grupos, en las DOS direcciones
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T6 · cada canónico está en exactamente un grupo, y todo grupo sólo tiene canónicos', () => {
  // 🔴 rojo (a): un canónico que no figure en ningún grupo → sale del denominador de la
  //    ficha sin que nadie lo note. (b): el mismo canónico en dos grupos → los tres números de la
  //    ficha suman MÁS que su denominador y nada falla. (c): una entrada que sea un alias o un
  //    typo (`["complete"]`, `["dome"]`) → el grupo queda sin efecto con el archivo bien formado,
  //    que es el camino de un diccionario mal formado que parece sano.
  assert.ok(dict.groups && typeof dict.groups === 'object',
    'el diccionario tiene que traer `groups` — es donde «en curso» y «cerrado» se definen UNA vez');

  const grupoDe = new Map();
  for (const [g, lista] of Object.entries(dict.groups)) {
    assert.ok(Array.isArray(lista), `el grupo ${g} tiene que ser una lista`);
    for (const e of lista) {
      assert.ok(dict.canonical.includes(e),
        `el grupo ${g} incluye "${e}", que no es un canónico `
        + `(${Object.prototype.hasOwnProperty.call(dict.alias || {}, norm(e)) ? 'es un alias' : 'no existe'}) `
        + '— el grupo queda sin efecto y el archivo se ve bien formado');
      assert.ok(!grupoDe.has(e),
        `el canónico "${e}" está en dos grupos (${grupoDe.get(e)} y ${g})`);
      grupoDe.set(e, g);
    }
  }

  const huerfanos = dict.canonical.filter((c) => !grupoDe.has(c));
  assert.deepEqual(huerfanos, [],
    `canónicos sin grupo: ${huerfanos.join(', ')} — desaparecen del denominador sin aviso`);

  for (const obligatorio of ['en_curso', 'backlog', 'cerrado']) {
    assert.ok(Array.isArray(dict.groups[obligatorio]) && dict.groups[obligatorio].length,
      `falta el grupo ${obligatorio}, que el medidor y el tablero necesitan`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T17 · el código no vuelve a tener su propia lista de cerrados
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T17 · el medidor no tiene una lista literal de estados de cierre en el código', () => {
  // 🔴 rojo: reintroducir `const DONE_STATUSES = new Set(['done','completed','closed'])`.
  //    Es el caso que impide que los DOS diccionarios se vuelvan a separar — que es lo que pasa si
  //    el código decide `done` con una lista fija y el diccionario de estados con otra.
  //
  // 🔴 Sirve contra el DESCUIDO, no contra la intención: reconstruir la lista sin literal
  //    (`Object.entries(alias).filter(([, v]) => v === 'done')`) pasa este caso. Va escrito acá
  //    para que nadie lo lea como una garantía.
  // 🔴 Se mira el CÓDIGO, no los comentarios. Nombrar la lista para explicar por qué ya no está
  //    —que es lo que hace un comentario sobre ella— no es tenerla: marcar por eso es
  //    un falso positivo, y un control que da falsas alarmas se apaga. Mismo criterio que
  //    `check-artifact-paths.js`: «un comentario que la nombre no es una lectura».
  const src = sinComentarios(fs.readFileSync(FUENTE_MEDIDOR, 'utf8'));
  assert.ok(!/DONE_STATUSES/.test(src),
    'reapareció DONE_STATUSES en sdlc-stage-metrics.js: el criterio de «cerrado» sale de groups.cerrado');

  const CIERRE = ['done', 'completed', 'closed', 'complete', 'implemented', 'vigente'];
  // Literales de lista/Set de cadenas: `['a', "b"]`. Dos o más del vocabulario de cierre juntos
  // es, por construcción, una segunda lista de cerrados.
  const literales = src.match(/\[\s*(?:'[^']*'|"[^"]*")\s*(?:,\s*(?:'[^']*'|"[^"]*")\s*)*,?\s*\]/g) || [];
  for (const lit of literales) {
    const cuantos = CIERRE.filter((c) => new RegExp(`['"]${c}['"]`).test(lit)).length;
    assert.ok(cuantos < 2,
      `el código trae una lista literal con estados de cierre: ${lit} — eso es un segundo diccionario`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T21 · lo que el orquestador ESCRIBE, el diccionario lo sabe LEER
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('T21 · el diccionario contiene todo VALID_STATUSES de marker.js', (t) => {
  // 🔴 rojo: sacar `blocked` del diccionario → el caso lo nombra. Sin este caso, el
  //    desfasaje entre lo que el orquestador escribe (`blocked`/`abandoned`) y lo que el
  //    diccionario reporta como desconocido se repite en silencio.
  // Las skills se buscan como en todo el arnés: TYCON_SKILLS_DIR, el propio clon si es unido, o las instaladas.
  const skills = require('../lib/skills-dir.js').resolveSkillsDirs(process.env.TYCON_SKILLS_DIR).skills;
  const marker = path.join(skills, 'tycon-pipeline', 'scripts', 'marker.js');
  if (!fs.existsSync(marker)) {
    // 🔴 Skip RUIDOSO, nunca mudo: un verde acá sin haber mirado sería exactamente el pecado
    //    que este repo persigue («no medido» leído como «medido y bien»).
    console.error(`⚠️  T21 NO SE MIDIÓ: no encontré marker.js en ${marker}. `
      + 'Instalá agent-skills o seteá TYCON_SKILLS_DIR. Esto NO es un verde.');
    t.skip('marker.js ausente — ver el aviso de arriba');
    return;
  }
  const src = fs.readFileSync(marker, 'utf8');
  const m = src.match(/VALID_STATUSES\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, `no pude leer VALID_STATUSES de ${marker} — cambió de forma; el caso se actualiza, no se borra`);
  const validos = m[1].match(/'([^']+)'|"([^"]+)"/g).map((s) => s.slice(1, -1));
  assert.ok(validos.length >= 4, `VALID_STATUSES salió con ${validos.length} valores: sospechoso`);

  const faltan = validos.filter((v) => !resolver(v));
  assert.deepEqual(faltan, [],
    `el orquestador puede escribir ${faltan.join(', ')} y el diccionario no los sabe leer: `
    + 'el medidor los publicaría como desconocidos');
});
