'use strict';
// version-order.js — el orden de dos números de versión publicados (story 8.13, tanda D · AC 25).
//
// Un número publicado es `YYYY.MM.DD.N` (hoy lo pone la etiqueta `v<número>` de cada merge a `main`; antes, `version.json`:
// ver «el número por etiqueta», abajo). «No bajar» se
// decide comparando esos números POR PARTES NUMÉRICAS —`2026.09.30.10` es más nuevo que `2026.09.30.9`; como texto sería
// al revés—, nunca por ancestría: el commit de una rama que se reescribe deja de ser ancestro de todo.
//
// La versión interna (`YYYY.MM.DD+sha7`, derivada del commit cuando el árbol no trae `version.json`) NO se ordena: dos
// commits del mismo día no dicen cuál es más nuevo. Lo que no tiene la forma publicada devuelve `null` —«no sé»—, nunca 0:
// quien llama decide qué hacer sin número (en `stable`, por ancestría; en `latest`, aplicar).
//
// Sin dependencias: corre también desde la copia fija del programa. Por eso la forma del número está COPIADA de
// `VERSION_SHAPE` de `scripts/publishing/export.js` (quien lo estampa) y no requerida: mes 01-12, día 01-31, N desde 1
// sin ceros adelante. `harness-state.test.js` compara las dos expresiones: si una cambia, la otra también.

const PUBLISHED = /^\d{4}\.(?:0[1-9]|1[0-2])\.(?:0[1-9]|[12]\d|3[01])\.[1-9]\d*$/;

/** `'2026.09.30.10'` → `[2026, 9, 30, 10]`; lo que no tiene esa forma → `null`. */
function parse(version) {
  if (typeof version !== 'string' || !PUBLISHED.test(version)) return null;
  const parts = version.split('.').map((p) => parseInt(p, 10));
  return parts.every((n) => Number.isSafeInteger(n)) ? parts : null;
}

/** ¿Es un número publicado (se puede ordenar)? */
function isOrdered(version) { return parse(version) !== null; }

/** -1 si `a` es más vieja que `b`, 0 si son el mismo número, 1 si es más nueva; `null` si alguna no se ordena. */
function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < pa.length; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// ── el número que sigue ──────────────────────────────────────────────────────────────────────────────────────────────
// La regla: la fecha es la de un commit, en UTC, y `N` es 1 más el mayor `N` de los números ya publicados con ESA fecha;
// si ninguno es de esa fecha, 1. Vive acá —y no sólo en la sincronización del repo público, que no viaja en la copia—
// porque el merge por pedido también numera (scripts/tools/merge-pr.js). Nada de esto mira el reloj ni el huso de la
// máquina: las mismas entradas dan el mismo número, corran cuando corran.

/**
 * La fecha UTC de un instante (segundos desde 1970) como `YYYY.MM.DD`. Sale por aritmética —de días desde 1970 a año,
 * mes y día del calendario gregoriano—: no pregunta la hora ni el huso a la máquina. Lo que no es un instante tira.
 */
function day(epoch) {
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error('no pude sacar la fecha de la versión: la fecha del commit no es un instante (segundos enteros desde 1970)');
  // los años se cuentan desde marzo: así el día que sobra en un bisiesto queda al final, y los meses salen por una cuenta
  const days = Math.floor(epoch / 86400) + 719468;
  const era = Math.floor(days / 146097);
  const dayOfEra = days - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const fromMarch = Math.floor((5 * dayOfYear + 2) / 153);
  const dayOfMonth = dayOfYear - Math.floor((153 * fromMarch + 2) / 5) + 1;
  const month = fromMarch < 10 ? fromMarch + 3 : fromMarch - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  const two = (n) => String(n).padStart(2, '0');
  return `${String(year).padStart(4, '0')}.${two(month)}.${two(dayOfMonth)}`;
}

/** La fecha (`YYYY.MM.DD`) y el orden en el día (`N`) de un número con forma. */
function parts(version) {
  const cut = version.lastIndexOf('.');
  return { day: version.slice(0, cut), order: Number(version.slice(cut + 1)) };
}

/**
 * El número que sigue: `date` y 1 más el mayor orden de los publicados con ESA fecha; si ninguno es de esa fecha, 1.
 * `published`: los números que ya existen (`null` = esa punta no trae el archivo). Uno sin forma no cuenta como «no
 * hay»: tira. Ojo: con una fecha ANTERIOR a la de un publicado da un número menor que ése; quien llama cuida que la
 * fecha no retroceda (la sincronización la saca de commits, que sólo avanzan; el merge por pedido toma la mayor).
 */
function next(date, published) {
  if (typeof date !== 'string' || !/^\d{4}\.\d{2}\.\d{2}$/.test(date)) throw new Error('la fecha de la versión no tiene la forma YYYY.MM.DD');
  let highest = 0;
  for (const version of published) {
    if (version == null) continue;
    if (typeof version !== 'string' || !PUBLISHED.test(version)) throw new Error('una versión publicada no tiene la forma YYYY.MM.DD.N');
    const p = parts(version);
    if (p.day === date) highest = Math.max(highest, p.order);
  }
  return `${date}.${highest + 1}`;
}

// ── el número por etiqueta ───────────────────────────────────────────────────────────────────────────────────────────
// Desde que el número lo pone el merge (y no cada pedido), cada merge a `main` del repo público recibe una etiqueta
// `v<número>` (la pone .github/workflows/version-tag.yml con scripts/ci/version-tag.js) y `version.json` queda fijo con
// `numbering: "merge-tag"`: su número es el PISO, el que ve una máquina con el código de antes. El número de un commit es
// el de su etiqueta si la tiene; si no, el de su `version.json` (los commits de antes, las copias de laboratorio).

const TAG_PREFIX = 'v';
/** La marca de `version.json` que dice «el número lo pone la etiqueta del merge»; el `version` del archivo es el piso. */
const NUMBERING_BY_TAG = 'merge-tag';

/** `'v2026.10.16.3'` (o `'refs/tags/v2026.10.16.3'`) → `'2026.10.16.3'`; otra cosa → `null`. */
function fromTag(name) {
  const short = String(name || '').replace(/^refs\/tags\//, '');
  if (!short.startsWith(TAG_PREFIX)) return null;
  const v = short.slice(TAG_PREFIX.length);
  return isOrdered(v) ? v : null;
}

/** El nombre de la etiqueta de un número. */
function tagName(version) { return `${TAG_PREFIX}${version}`; }

/** El mayor número entre etiquetas (nombres); las que no son de número no cuentan. `null` si ninguna lo es. */
function bestTag(names) {
  let best = null;
  for (const n of names || []) {
    const v = fromTag(n);
    if (v && (best === null || compare(v, best) > 0)) best = v;
  }
  return best;
}

/** ¿El `version.json` (ya leído) dice que el número lo pone la etiqueta del merge? */
function numberedByTag(json) { return Boolean(json && typeof json === 'object' && json.numbering === NUMBERING_BY_TAG); }

module.exports = { PUBLISHED, parse, isOrdered, compare, day, parts, next, TAG_PREFIX, NUMBERING_BY_TAG, fromTag, tagName, bestTag, numberedByTag };
