#!/usr/bin/env node
/**
 * rules-catalog.js — el ÚNICO parser de `guides/advisor-rules-catalog.md` (story 2.9).
 *
 * POR QUÉ EXISTE
 * --------------
 * El mismo catálogo se contaba de tres maneras distintas: los censos del 2026-09-16 dieron **341,
 * 357 y 358** reglas porque cada uno escribió su propio parser. Dos listas del mismo vocabulario en
 * dos lugares se separan solas — el arnés ya lo pagó con los dos diccionarios de estados y con
 * `release-notes.sh` copiado en 8 repos. Acá hay uno, y `scripts/tools/rules-distill.js` lo consume.
 *
 * LAS TRES DECISIONES QUE LO ORDENAN
 * ----------------------------------
 * 1. 🔴 **Una regla se DEFINE, no se menciona.** La definición es la primera columna en negrita de
 *    una fila de tabla (`| **VAL-C1** | … |`). Nombrarla en la prosa (`ver DOTNET-C4/C5`) es una
 *    REFERENCIA y no crea una regla. `rules-distill.js` escaneaba el texto entero, así que 27 reglas
 *    figuraban con varios "dueños" que en realidad sólo las citaban.
 *
 * 2. 🔴 **El identificador ADMITE DÍGITOS en el prefijo.** El regex viejo
 *    (`rules-distill.js:79`, `/\b([A-Z]{2,12})-([CW])(\d{1,2})\b/g`) sólo aceptaba letras, y el área
 *    `I18N` tiene un 1 y un 8: sus **7 reglas eran invisibles** y el revisor de textos sin traducir
 *    figuraba como dueño de nada. Peor: como no las veía, tampoco podía acusarlas de nada — el
 *    agujero se tapaba a sí mismo, y el total se publicaba como 351.
 *
 * 3. 🔴 **La clave es (dueño, regla), no el identificador.** `SEC-C1` y `SEC-C2` están DEFINIDOS dos
 *    veces, por dos dueños distintos y con contenido sin relación: el revisor de seguridad y el freno
 *    de mano. Contar por identificador los fusiona y arruina el número en las dos puntas. `PIPE-C5`,
 *    en cambio, está definida dos veces por el MISMO dueño (dos casos de la misma regla) y es UNA.
 *
 * POR ESO PUBLICA TRES NÚMEROS, Y SON TRES A PROPÓSITO (medido 2026-09-16, con el sufijo):
 *     filas 362  ·  reglas 361 (pares dueño+regla — LA UNIDAD DE LA TABLA)  ·  identificadores 359
 * Y dos anomalías que se PUBLICAN en vez de esconderse: las colisiones (SEC-C1/SEC-C2, dos dueños) y
 * las reutilizaciones (SEC-W4, un identificador retirado que volvió a usarse para otra regla).
 *
 * «NO PUDE LEER» NUNCA ES «NO HAY REGLAS»
 * ---------------------------------------
 * Un catálogo ausente, ilegible, o sin una sola definición sale **exit 2 con motivo**. Devolver 0
 * reglas en verde se leería como «el catálogo está vacío» y la tabla de poda marcaría candidata a
 * retiro a todo. Lo mismo con el padrón de revisores: si no se puede leer, no se adivina que nadie
 * es revisor — se dice.
 *
 * USO
 *   node scripts/lib/rules-catalog.js --json [--catalog <ruta>] [--reviewers <dir>]
 *   node scripts/lib/rules-catalog.js --collisions
 *   require('./rules-catalog.js').leer({ catalogo, revisores })
 *
 * Env (para el banco y los tests): TYCON_CATALOG · TYCON_REVIEWERS_DIR
 * Exit: 0 = midió · 2 = no pudo medir (nunca 0 con lista vacía).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readEnv, aliasArgv } = require('./legacy-names.js');

const RAIZ = path.resolve(__dirname, '..', '..');
const CATALOGO_DEFAULT = path.join(RAIZ, 'guides', 'advisor-rules-catalog.md');
// El padrón de revisores es el que el arnés YA mantiene: un .toml generado por advisor
// (`build/generate.js`). No se escribe una lista a mano acá — sería la cuarta copia del mismo dato.
const REVISORES_DEFAULT = path.join(RAIZ, 'adapters', 'codex', 'agents');

/** Cabecera de sección con dueño: `## <Nombre> — \`<dueño>\``. El guión es em dash o guión simple. */
const SECCION_CON_DUENO = /^##\s+.*?[—-]\s*`([^`]+)`\s*$/;
/**
 * El identificador de una regla. El prefijo acepta dígitos después de la primera letra (`I18N`) y el
 * número acepta un SUFIJO (`ACCOV-C1-EXT`). Los dos son defectos que esta pieza cierra: sin el primero
 * desaparecían 7 reglas; sin el segundo, una (vuelta 1 de la revisión, 2026-09-16).
 */
const ID = '[A-Z][A-Z0-9]*-[CW]\\d+(?:-[A-Z0-9]+)*';
/** Una DEFINICIÓN: primera columna de una fila, en negrita. */
const DEFINICION = new RegExp(`^\\|\\s*\\*\\*\`?(${ID})\`?\\*\\*`);
/**
 * Una retirada: un identificador TACHADO en cualquier parte de la línea (fuera de un bloque de código).
 * 🔴 No sólo en filas de tabla: el catálogo también declara reservados en la prosa
 *    («**IDs reservados, no publicados**: `~~REAL-C5~~` · `~~REAL-W5~~`»). Con sólo las filas, esos dos
 *    salían como huérfanos y el chequeo de salud del arnés se ponía en rojo.
 */
const RETIRADA = new RegExp(`~~\`?(${ID})\`?~~`, 'g');
/**
 * 🔴 La marca «ningún guion verifica esta regla» (AC 7). Vive EN el catálogo, dentro de la sección cuyas
 *    reglas marca, porque el dato ya estaba ahí en prosa («sólo BANCO-W3 la verifica un guion; a las otras
 *    siete ningún script las detecta»). Copiarlo a otra lista sería la segunda copia que se separa sola; y
 *    derivarlo buscando el identificador en el guion dueño NO sirve — medido, ese guion ni siquiera nombra
 *    la única regla que sí verifica, y daba 10 donde el catálogo dice 7.
 *      <!-- sin-verificacion: BANCO-C1 BANCO-C2 … -->
 */
const MARCA_SIN_VERIFICACION = new RegExp(`^\\s*<!--\\s*sin-verificacion:\\s*((?:${ID}\\s*)+)-->\\s*$`);

function noMedido(codigo, motivo) {
  return { estado: 'no_medido', codigo, motivo, filas: null, reglas: null, identificadores: null, lista: [], colisiones: [] };
}

/**
 * Lee el catálogo y devuelve el mapa regla→dueño.
 * @returns {{estado, motivo?, filas, reglas, identificadores, lista, colisiones, retiradas, sinDueno}}
 */
function leer({ catalogo, revisores } = {}) {
  const rutaCat = catalogo || readEnv('TYCON_CATALOG', { where: 'scripts/lib/rules-catalog.js' }) || CATALOGO_DEFAULT;
  const rutaRev = revisores || readEnv('TYCON_REVIEWERS_DIR', { where: 'scripts/lib/rules-catalog.js' }) || REVISORES_DEFAULT;

  let texto;
  try {
    texto = fs.readFileSync(rutaCat, 'utf8');
  } catch (e) {
    return noMedido(2, `no pude leer el catálogo (${e.code || e.message})`);
  }

  // El padrón de revisores. 🔴 Si no se puede leer NO se asume que nadie es revisor: se dice.
  let padron;
  try {
    padron = new Set(
      fs.readdirSync(rutaRev).filter((f) => f.endsWith('.toml')).map((f) => f.slice(0, -'.toml'.length)),
    );
  } catch (e) {
    return noMedido(2, `no pude leer el padrón de revisores (${e.code || e.message}) — sin él, «no es revisor» sería una adivinanza`);
  }
  // 🔴 Un padrón que se lee pero está VACÍO no es «nadie es revisor»: es un padrón roto. Sin esta guarda
  //    las 361 reglas salían «sin revisor» y el resultado se publicaba como una medición.
  if (padron.size === 0) {
    return noMedido(2, 'el padrón de revisores no tiene un solo .toml — sin revisores conocidos, «no es revisor» sería una adivinanza');
  }

  let dueno = null;
  let seccion = -1;
  let filas = 0;
  const retiradas = [];
  const retiradasIds = new Set();
  const marcas = new Map();         // índice de sección → Set de identificadores marcados
  let sinDueno = 0;
  // pares: clave `${dueno}\u0000${regla}` → { regla, dueno, seccion, filas }
  const pares = new Map();
  const duenosPorRegla = new Map();

  const lineas = texto.split('\n');
  // 🔴 Un bloque de código es un EJEMPLO. La guía «Retirar una regla» del catálogo trae, dentro de uno,
  //    `| ~~SEC-W4~~ | … RETIRED …`: leído como texto plano retiraba a SEC-W4, que es una regla viva
  //    (firma de webhooks). rules-distill la escondía desde siempre por eso.
  let enCodigo = false;
  for (const linea of lineas) {
    if (/^\s*(```|~~~)/.test(linea)) { enCodigo = !enCodigo; continue; }
    if (enCodigo) continue;
    if (linea.startsWith('## ')) {
      const m = SECCION_CON_DUENO.exec(linea);
      // Una sección sin dueño (p. ej. «Cómo leer un finding») RESETEA: lo que venga después no
      // hereda el dueño de la sección anterior.
      dueno = m ? m[1] : null;
      seccion += 1;
      continue;
    }
    const marca = MARCA_SIN_VERIFICACION.exec(linea);
    if (marca) {
      if (!marcas.has(seccion)) marcas.set(seccion, new Set());
      for (const id of marca[1].trim().split(/\s+/)) marcas.get(seccion).add(id);
      continue;
    }
    RETIRADA.lastIndex = 0;
    let ret;
    let huboRetirada = false;
    while ((ret = RETIRADA.exec(linea)) !== null) {
      if (!retiradasIds.has(ret[1])) retiradas.push({ regla: ret[1], dueno });
      retiradasIds.add(ret[1]);
      huboRetirada = true;
    }
    // Una fila cuya primera columna está tachada es una retirada, no una definición: no hace falta mirar más.
    if (huboRetirada && /^\|\s*~~/.test(linea)) continue;

    const def = DEFINICION.exec(linea);
    if (!def) continue;
    const regla = def[1];
    filas += 1;
    if (!dueno) sinDueno += 1;

    const clave = `${dueno || ''}\u0000${regla}`;
    if (!pares.has(clave)) {
      pares.set(clave, { regla, dueno, seccion: dueno, indice: seccion, filas: 1, esRevisor: !!dueno && padron.has(dueno) });
    } else {
      pares.get(clave).filas += 1;
    }
    if (!duenosPorRegla.has(regla)) duenosPorRegla.set(regla, new Set());
    duenosPorRegla.get(regla).add(dueno);
  }

  if (filas === 0) {
    return noMedido(2, `el catálogo no tiene una sola definición de regla (${path.basename(rutaCat)}) — «no pude leer» no es «no hay reglas»`);
  }
  // 🔴 Un catálogo cuyas secciones no declaran dueño no es «361 reglas sin dueño»: es un catálogo que
  //    este parser no sabe leer (los encabezados cambiaron de forma). Se dice, no se publica.
  if (sinDueno === filas) {
    return noMedido(2, 'ninguna regla del catálogo tiene dueño: los encabezados de sección no tienen la forma «## Nombre — `dueño`»');
  }

  // «Sin verificación»: la marca aplica a las reglas que SU sección define. Una marca que nombra una regla
  // que la sección no define se publica aparte (una marca mal escrita tiene que verse, no ignorarse).
  const marcasSinRegla = [];
  for (const [idx, ids] of marcas) {
    for (const id of ids) {
      const existe = [...pares.values()].some((p) => p.indice === idx && p.regla === id);
      if (!existe) marcasSinRegla.push(id);
    }
  }

  const lista = [...pares.values()].map((p) => ({
    regla: p.regla,
    dueno: p.dueno,
    seccion: p.seccion,
    esRevisor: p.esRevisor,
    sin_verificacion: !!(marcas.get(p.indice) && marcas.get(p.indice).has(p.regla)),
    filas: p.filas,
  }));

  // 🔴 Un identificador RETIRADO que vuelve a aparecer definido es una reutilización: el catálogo lo
  //    prohíbe («no reusar IDs retirados»). La regla viva SE CUENTA —esconderla sería perder una regla
  //    activa, que es lo que hacía rules-distill— y la reutilización se publica. Medido: SEC-W4.
  const reutilizadas = [...retiradasIds].filter((id) => duenosPorRegla.has(id)).sort();

  // Los dueños que no están en el padrón se nombran: así se ve un .toml de revisor que falta, en vez de
  // que sus reglas pasen a «sin revisor» en silencio.
  const duenosSinPadron = [...new Set([...pares.values()].map((p) => p.dueno).filter((d) => d && !padron.has(d)))].sort();

  // Una COLISIÓN es un identificador DEFINIDO por más de un dueño: dejó de ser clave única.
  // Repetir la misma regla en el mismo dueño (dos casos de una regla) NO es una colisión.
  const colisiones = [...duenosPorRegla.entries()]
    .filter(([, ds]) => ds.size > 1)
    .map(([regla, ds]) => ({ regla, duenos: [...ds].sort() }))
    .sort((a, b) => (a.regla < b.regla ? -1 : 1));

  return {
    estado: 'medido',
    catalogo: rutaCat,
    filas,
    reglas: lista.length,              // pares (dueño, regla) — LA UNIDAD de la tabla de poda
    identificadores: duenosPorRegla.size,
    sin_dueno: sinDueno,
    lista,
    colisiones,
    retiradas: retiradas.sort((a, b) => (a.regla < b.regla ? -1 : a.regla > b.regla ? 1 : 0)),
    reutilizadas,
    duenos_sin_padron: duenosSinPadron,
    marcas_sin_regla: marcasSinRegla.sort(),
  };
}

/** El mapa que consume el cruce: `${dueno}\u0000${regla}` → entrada. */
function porPar(res) {
  const m = new Map();
  for (const r of res.lista) m.set(`${r.dueno || ''}\u0000${r.regla}`, r);
  return m;
}

// ───────────────────────────────── CLI ─────────────────────────────────

function valor(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function main() {
  const res = leer({ catalogo: valor('--catalog', null), revisores: valor('--reviewers', null) });

  if (res.estado !== 'medido') {
    console.error(`catalogo-de-reglas: ${res.motivo}`);
    if (process.argv.includes('--json')) console.log(JSON.stringify(res, null, 2));
    process.exitCode = res.codigo || 2;
    return;
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(res, null, 2));
  } else if (process.argv.includes('--collisions')) {
    if (res.colisiones.length === 0) {
      console.log('Sin colisiones: cada identificador tiene un solo dueño.');
    } else {
      console.log(`${res.colisiones.length} identificador(es) con más de un dueño — la clave es (dueño, regla), no el identificador:`);
      for (const c of res.colisiones) console.log(`  ${c.regla}: ${c.duenos.join(' · ')}`);
    }
  } else {
    const sinRev = res.lista.filter((r) => !r.esRevisor).length;
    console.log(`filas ${res.filas} · reglas ${res.reglas} (pares dueño+regla) · identificadores ${res.identificadores}`);
    console.log(`sin revisor: ${sinRev} · colisiones: ${res.colisiones.length} · retiradas: ${res.retiradas.length}`);
    if (res.sin_dueno) console.log(`⚠️  ${res.sin_dueno} fila(s) fuera de toda sección con dueño`);
  }
  process.exitCode = 0;
}

if (require.main === module) {
  aliasArgv('scripts/lib/rules-catalog.js', { exitCode: 2, prefix: 'catalogo-de-reglas: ' });   // los nombres viejos siguen andando (story 8.9, tanda B3a)
  main();
}
module.exports = { leer, porPar, ID, DEFINICION, SECCION_CON_DUENO };
