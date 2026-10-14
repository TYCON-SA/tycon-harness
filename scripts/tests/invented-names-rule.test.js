'use strict';
// invented-names-rule.test.js — la regla de un nombre inventado (story 8.10.3, tanda E, AC 19 · T18).
//
// POR QUÉ EXISTE: la tabla privada de reemplazos cambia cada nombre real por uno inventado. Durante meses el inventado
// se eligió «parecido» al real —la misma inicial, el mismo largo, una palabra en común—, y con eso quien lee la copia
// pública puede acercarse al real. La tanda E cambió los inventados que se parecían; esta prueba es lo que impide que
// vuelva a entrar uno así.
//
// LA REGLA. Un inventado de cliente, persona, máquina o interno NO conserva del real:
//   · la inicial (sin contar un prefijo neutro del inventado ni lo que las dos formas traen igual al principio por
//     convención, por estructura o porque es el inventado de OTRO par);
//   · el largo exacto (salvo un identificador de formato fijo, que no puede cambiar de largo); para un cliente cuenta
//     también el largo de su nombre escrito pegado o con separadores, que el exportador reemplaza igual;
//   · una palabra de cuatro letras o más que no sea estructural (las que nombran la clase de cosa, no la cosa): la
//     misma palabra, o cinco letras seguidas en común entre una parte del real y una del inventado (un plural, otra
//     flexión, o un tramo dentro de un nombre escrito todo pegado), sin contar las palabras estructurales;
// y dos reales no comparten inventado. Se mide cada forma del par y su forma de prosa (`anonimoProsa`), si la tiene.
//
// La regla y sus listas viven ACÁ, cada lista con su motivo, y no en un módulo aparte.
//
// DÓNDE ESTÁ LA TABLA. Es privada: vive en el repo de mantenimiento del equipo (scripts/publishing/replacements.json)
// y llega al árbol armado de los nocturnos, que se reconoce por la lista del repo privado (.tycon/internal-forms.json).
// En el público solo no existe por diseño: ahí corren los casos de mentira (la regla, cada motivo y cada exención, y
// cómo dice «no pude medir») y el caso de la tabla real sale SALTEADO, con su motivo. En el árbol armado, que falte la
// tabla es «no pude medir» (2), como siempre.
//
// SALIDAS. 0 = la tabla cumple · 1 = hay pares que no cumplen (se nombran por índice y categoría, nunca por su valor) ·
// 2 = no pude medir: falta la tabla (en el árbol armado), no es JSON, no tiene la forma esperada, trae una categoría que
// la regla no conoce, un par sin formas o un inventado vacío, o no trae ningún par que medir. Sin medir NO hay verde.
//
// Correr: node scripts/tests/invented-names-rule.test.js
// Medir otra tabla (lo usan los casos de abajo): node scripts/tests/invented-names-rule.test.js --table <ruta>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const TABLA = path.join(RAIZ, 'scripts', 'publishing', 'replacements.json');
// ¿El árbol armado (lo privado del equipo con el público encima)? Ahí la tabla tiene que estar.
const ARMADO = fs.existsSync(path.join(RAIZ, '.tycon', 'internal-forms.json'));
const SIN_TABLA_POR_DISENO = !ARMADO && !fs.existsSync(TABLA);
const NO_MEDIDO_PUBLICO = 'NO MEDIDO en el público solo: la tabla de reemplazos es privada (vive en el repo de mantenimiento y se mide en el árbol armado)';

// Las categorías que nombran a alguien o a algo del equipo: las mide la regla.
const CATEGORIAS = ['cliente', 'persona', 'maquina', 'interno'];
// Las que la regla conoce y NO mide, con su motivo. Cualquier otra categoría es «no pude medir»: una mal escrita no
// puede dejar a su par afuera de la cuenta sin que nadie se entere.
const CATEGORIAS_FUERA = {
  'host-interno': 'los servidores conservan el dominio del producto con `.example`: tienen su propia deuda',
};

// Palabras estructurales: nombran la CLASE de cosa (un repositorio, una pantalla, un tipo de repo), no la cosa. Que el
// real y el inventado las compartan no acerca al real. Las cinco primeras son las de la story; el resto lo sumó el
// inventario de la tanda E (aprobado por el dueño el 2026-10-08), agrupado por su motivo.
const ESTRUCTURALES = {
  'las cinco de la story: el papel de una clase': ['repository', 'service', 'worker', 'exception', 'controller'],
  'tipo de pieza de código (sufijo o prefijo de clase, de archivo o de carpeta)': [
    'endpoints', 'tests', 'modal', 'store', 'layout', 'page', 'drawer', 'badge', 'context', 'handler', 'table', 'form',
    'section', 'detail', 'queue', 'button', 'client', 'column', 'mapping', 'filter', 'filters', 'config', 'type',
    'features', 'root', 'name', 'dashboard', 'translation', 'import', 'conflict', 'probe', 'received', 'updated', 'auth',
    'async', 'sync'],
  'tipo de repo o de proyecto de la plataforma': ['backend', 'front', 'project', 'proyecto', 'docs', 'react'],
  'tipo de artefacto de planificación o de calidad': ['story', 'epic', 'sprints', 'propuesta', 'pasos'],
  'verbo de convención al principio de un nombre (migraciones, manejadores)': ['rename', 'configure', 'process', 'agregar'],
  'modelo de máquina, no su nombre': ['macbook', 'book'],
};

// Prefijos de convención del código: lo que las dos formas traen IGUAL al principio por cómo se nombra en el lenguaje
// (un hook empieza con `use`, una interfaz con `I`) no es la inicial del nombre. Sólo cuentan para la inicial (el
// único de cuatro letras o más, `story`, es además estructural: nombra la clase de artefacto).
const CONVENCION = ['use', 'i', 'story', 'cr', 'fix', 'id', 'on', 'new', 'add', 'zz'];

// Prefijos neutros del inventado: una empresa de mentira delante del nombre, suelta (`acme-…`, `AcmeAlgo`) o pegada
// (`acmealgo`). La inicial se mira después de ellos.
const NEUTROS = ['acme', 'globex', 'demo', 'sample'];

// Formato fijo: un identificador con esta forma no puede cambiar de largo sin dejar de serlo, y su inventado es el de
// ceros que escribe el patrón genérico. Queda eximido del largo y de la inicial.
const FORMATO_FIJO = [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i];

// Cuántas letras iguales hacen «la misma palabra» cuando no es idéntica: el arranque de dos palabras (un plural, otra
// flexión) o un tramo dentro de un nombre pegado.
const LETRAS_EN_COMUN = 5;

const PALABRAS_ESTRUCTURALES = new Set(Object.values(ESTRUCTURALES).flat());
const PREFIJOS_DE_CONVENCION = new Set(CONVENCION);

const sinTildes = (s) => s.normalize('NFD').replace(/\p{M}/gu, '');
/** Las partes de un nombre, en minúscula y sin tildes: corta en las jorobas y en todo lo que no sea letra o número
 *  (cualquier letra: una Ñ o una vocal con tilde también hacen joroba). */
const partes = (s) => String(s)
  .split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})|[^\p{L}\p{N}]+/u)
  .filter(Boolean)
  .map((x) => sinTildes(x.toLowerCase()));

/** El tramo más largo de letras seguidas que dos palabras tienen en común. */
function tramoComun(a, b) {
  let mejor = '';
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > mejor.length) mejor = a.slice(i, i + k);
    }
  }
  return mejor;
}
/** Lo que queda de un tramo al sacarle las palabras estructurales que trae adentro (`…backend` pegado no es del nombre). */
function sinEstructurales(tramo) {
  let t = tramo;
  for (const w of [...PALABRAS_ESTRUCTURALES].sort((x, y) => y.length - x.length)) t = t.split(w).join(' ');
  return t.split(' ').sort((x, y) => y.length - x.length)[0] || '';
}

/**
 * Por qué UNA forma no cumple: [] si cumple; si no, 'inicial', 'largo' y/o 'palabra'.
 * `ajenos`: las partes que son el inventado de OTRO par (una forma intermedia: el real de una app escrito ya con el
 * inventado de su cliente). No son del real: no cuentan como inicial ni como palabra. `cliente`: mide también el largo
 * del nombre escrito con separadores.
 */
function motivos(real, inventado, { ajenos = new Set(), cliente = false } = {}) {
  const out = [];
  let pr = partes(real);
  let pi = partes(inventado);
  // el prefijo neutro del inventado, suelto o pegado, primero: no es del nombre
  if (pi.length > 1 && NEUTROS.includes(pi[0])) pi = pi.slice(1);
  else if (pi.length) {
    const neutro = NEUTROS.find((n) => pi[0].length > n.length && pi[0].startsWith(n));
    if (neutro) pi = [pi[0].slice(neutro.length), ...pi.slice(1)];
  }
  // lo que las dos formas traen igual al principio, si es de convención, estructural o el inventado de otro par
  while (pr.length > 1 && pi.length > 1 && pr[0] === pi[0]
    && (PREFIJOS_DE_CONVENCION.has(pr[0]) || PALABRAS_ESTRUCTURALES.has(pr[0]) || ajenos.has(pr[0]))) {
    pr = pr.slice(1);
    pi = pi.slice(1);
  }
  const fijo = FORMATO_FIJO.some((re) => re.test(real) && re.test(inventado));
  const inicialReal = pr.join('')[0] || '';
  const inicialInventado = pi.join('')[0] || '';
  if (inicialReal && inicialReal === inicialInventado && !fijo) out.push('inicial');
  const largoReal = String(real).length;
  const largoInventado = String(inventado).length;
  const todasLasDelReal = partes(real);
  // un cliente de varias partes también se reemplaza con sus partes pegadas o con un separador entre ellas (lo escriba
  // como lo escriba la fuente): esos dos largos cuentan igual que el de la forma declarada
  const pegado = todasLasDelReal.join('').length;
  const otrasEscrituras = cliente && todasLasDelReal.length > 1 && [pegado, pegado + todasLasDelReal.length - 1].includes(largoInventado);
  if ((largoReal === largoInventado || otrasEscrituras) && !fijo) out.push('largo');
  const delReal = [...new Set(todasLasDelReal)].filter((w) => w.length >= 4 && !PALABRAS_ESTRUCTURALES.has(w) && !ajenos.has(w));
  // el inventado de otro par no es del real SÓLO donde el real ya lo trae escrito (la forma intermedia)
  const delInventado = [...new Set(partes(inventado))].filter((p) => !PALABRAS_ESTRUCTURALES.has(p) && !(ajenos.has(p) && todasLasDelReal.includes(p)));
  const comparte = delReal.some((w) => delInventado.some((p) => p === w || sinEstructurales(tramoComun(w, p)).length >= LETRAS_EN_COMUN));
  if (comparte) out.push('palabra');
  return out;
}

class NoPudeMedir extends Error {}
const vacio = (s) => typeof s !== 'string' || !s.trim();

/** Mide una tabla ya leída. Devuelve los pares que no cumplen, por índice y categoría — nunca por su valor. */
function medirTabla(tabla) {
  if (!tabla || !Array.isArray(tabla.pares)) throw new NoPudeMedir('la tabla no trae `pares`');
  // primero la forma de TODOS los pares: lo que no se puede medir no puede quedar sin decir
  tabla.pares.forEach((par, indice) => {
    if (!par || vacio(par.real) || !Array.isArray(par.formas)) throw new NoPudeMedir(`pares[${indice}]: sin \`real\` o sin \`formas\``);
    if (!CATEGORIAS.includes(par.categoria) && !Object.prototype.hasOwnProperty.call(CATEGORIAS_FUERA, par.categoria)) {
      throw new NoPudeMedir(`pares[${indice}]: su \`categoria\` no es una de las que la regla conoce (${[...CATEGORIAS, ...Object.keys(CATEGORIAS_FUERA)].join(', ')})`);
    }
    if (!par.formas.length) throw new NoPudeMedir(`pares[${indice}]: sin ninguna forma`);
    par.formas.forEach((f, j) => {
      if (!f || vacio(f.texto) || vacio(f.anonimo)) throw new NoPudeMedir(`pares[${indice}].formas[${j}]: sin \`texto\` o sin \`anonimo\``);
    });
    if (par.anonimoProsa !== undefined && vacio(par.anonimoProsa)) throw new NoPudeMedir(`pares[${indice}].anonimoProsa: no es un texto`);
  });
  // los inventados de una sola parte, y de qué pares son: para reconocer una forma intermedia
  const duenosDeParte = new Map();
  tabla.pares.forEach((par, indice) => {
    for (const f of par.formas) {
      const p = partes(f.anonimo);
      if (p.length !== 1) continue;
      if (!duenosDeParte.has(p[0])) duenosDeParte.set(p[0], new Set());
      duenosDeParte.get(p[0]).add(indice);
    }
  });
  const violan = new Map(); // índice → { categoria, motivos:Set }
  const anotar = (indice, categoria, motivo) => {
    if (!violan.has(indice)) violan.set(indice, { indice, categoria, motivos: new Set() });
    violan.get(indice).motivos.add(motivo);
  };
  const duenos = new Map(); // inventado → Set de índices de par
  let medidos = 0;
  let formas = 0;
  tabla.pares.forEach((par, indice) => {
    if (!CATEGORIAS.includes(par.categoria)) return; // conocida y fuera de la regla (CATEGORIAS_FUERA)
    medidos++;
    const ajenos = new Set([...duenosDeParte].filter(([, quienes]) => [...quienes].some((q) => q !== indice)).map(([parte]) => parte));
    const opciones = { ajenos, cliente: par.categoria === 'cliente' };
    const inventados = [];
    for (const f of par.formas) {
      formas++;
      for (const m of motivos(f.texto, f.anonimo, opciones)) anotar(indice, par.categoria, m);
      inventados.push(f.anonimo);
    }
    if (par.anonimoProsa !== undefined) {
      formas++;
      for (const m of motivos(par.real, par.anonimoProsa, opciones)) anotar(indice, par.categoria, m);
      inventados.push(par.anonimoProsa);
    }
    for (const inv of new Set(inventados)) {
      if (!duenos.has(inv)) duenos.set(inv, new Set());
      duenos.get(inv).add(indice);
    }
  });
  if (!medidos) throw new NoPudeMedir(`la tabla no trae ningún par de las categorías que la regla mide (${CATEGORIAS.join(', ')})`);
  for (const indices of duenos.values()) {
    if (indices.size < 2) continue;
    for (const i of indices) anotar(i, tabla.pares[i].categoria, 'comparte');
  }
  const lista = [...violan.values()].sort((a, b) => a.indice - b.indice).map((v) => ({ ...v, motivos: [...v.motivos].sort() }));
  return { medidos, formas, violan: lista };
}

/** Lee y mide una tabla del disco. Lo que no se puede leer es «no pude medir», nunca «cumple». */
function medirArchivo(ruta) {
  let crudo;
  try { crudo = fs.readFileSync(ruta, 'utf8'); } catch (e) { throw new NoPudeMedir(`no pude leer la tabla (${e.code || e.message})`); }
  let tabla;
  try { tabla = JSON.parse(crudo); } catch (e) { throw new NoPudeMedir(`la tabla no es JSON (${e.message})`); }
  return medirTabla(tabla);
}

const renglones = (r) => r.violan.map((v) => `  pares[${v.indice}] (${v.categoria}): ${v.motivos.join(', ')}`);

/** El modo de una sola tabla: dice la cuenta y devuelve 0, 1 o 2. No corta el proceso: lo escrito llega entero. */
function medirYDecir(ruta) {
  let r;
  try { r = medirArchivo(ruta); } catch (e) {
    if (!(e instanceof NoPudeMedir)) throw e;
    process.stderr.write(`invented-names-rule: no pude medir — ${e.message}\n`);
    return 2;
  }
  if (r.violan.length) {
    process.stdout.write(`❌ ${r.violan.length} de ${r.medidos} pares no cumplen la regla del inventado\n${renglones(r).join('\n')}\n`);
    return 1;
  }
  process.stdout.write(`✅ ${r.medidos} pares (${r.formas} formas) cumplen la regla del inventado\n`);
  return 0;
}

/** Corre esta misma prueba sobre una tabla de mentira, como proceso aparte. */
function conTabla(tabla, hacer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-rule-'));
  try {
    const ruta = path.join(dir, 'tabla.json');
    if (tabla !== undefined) fs.writeFileSync(ruta, typeof tabla === 'string' ? tabla : JSON.stringify(tabla));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // un proceso hijo con esta variable no corre: informa al de arriba y sale 0
    const r = spawnSync(process.execPath, [__filename, '--table', ruta], { encoding: 'utf8', env });
    if (r.error || r.status === null) throw new Error(`no pude lanzar la prueba sobre la tabla de mentira: ${r.error ? r.error.message : `señal ${r.signal}`}`);
    return hacer(r);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const par = (real, categoria, formas, extra = {}) => ({ real, categoria, formas: formas.map(([texto, anonimo]) => ({ texto, anonimo })), ...extra });

function pruebas() {
  const test = require('node:test');
  const assert = require('node:assert');

  // Los nombres de los casos son de mentira: ni un real ni un inventado de la tabla.
  test('InventedNames_Rule_EachReasonFires', () => {
    assert.deepStrictEqual(motivos('Fantasur', 'Mirlo'), [], 'otra inicial, otro largo, ninguna palabra: cumple');
    assert.deepStrictEqual(motivos('Fantasur', 'Fresquito'), ['inicial'], 'conserva la inicial');
    assert.deepStrictEqual(motivos('Fantasur', 'Molinete'), ['largo'], 'conserva el largo exacto');
    assert.deepStrictEqual(motivos('FantasurPagos', 'MolinoPagos'), ['palabra'], 'conserva una palabra de cuatro letras o más');
    assert.deepStrictEqual(motivos('fantasur-pagos', 'molino_pagos'), ['palabra'], 'la palabra se reconoce con otro separador');
    assert.deepStrictEqual(motivos('Fantasur', 'Falsario'), ['inicial', 'largo'], 'dos motivos a la vez');
    assert.deepStrictEqual(motivos('FantasurApi', 'TordoApi'), [], 'una palabra de tres letras no cuenta');
    assert.deepStrictEqual(motivos('fantasur', 'Fresquito'), ['inicial'], 'la inicial se compara sin distinguir mayúsculas');
    assert.deepStrictEqual(motivos('Ñandubay', 'nogal'), ['inicial'], 'ni tildes: ñ y n son la misma inicial');
    assert.deepStrictEqual(motivos('Árbol', 'alerce'), ['inicial'], 'una vocal con tilde es la misma inicial');
  });

  test('InventedNames_Rule_AWordIsAlsoItsRootAndAGluedRun', () => {
    // la misma palabra en plural o en otra flexión: arranca con las mismas cinco letras
    assert.deepStrictEqual(motivos('FantasurPagos', 'MirloPago'), [], 'cuatro letras en común no alcanzan');
    assert.deepStrictEqual(motivos('FantasurDocumento', 'MirloDocumentos'), ['palabra'], 'el plural es la misma palabra');
    assert.deepStrictEqual(motivos('FantasurShipping', 'MirloShipped'), ['palabra'], 'otra flexión: cinco letras iguales desde el principio');
    // todo pegado: no hay joroba que corte, se mira el tramo en común
    assert.deepStrictEqual(motivos('fantasurcobranzas', 'mirlocobranzas'), ['palabra'], 'pegado en minúsculas');
    assert.deepStrictEqual(motivos('FANTASURCOBRANZAS', 'MIRLOCOBRANZAS'), ['palabra'], 'pegado en mayúsculas');
    assert.deepStrictEqual(motivos('FantasurCobranzas', 'mirlocobranzas'), ['palabra'], 'el real con jorobas y el inventado pegado');
    assert.deepStrictEqual(motivos('fantasurbackend', 'mirlobackend'), [], 'el tramo en común es una palabra estructural: no cuenta');
    assert.deepStrictEqual(motivos('fantasurdocsbackend', 'mirlodocsbackend'), [], 'dos estructurales pegadas tampoco');
    // las jorobas con tilde o con ñ también cortan
    assert.deepStrictEqual(motivos('FantasurCañería', 'MirloCañería'), ['palabra'], 'una parte con ñ y tilde');
    assert.deepStrictEqual(motivos('fantasíaÑandú', 'mirloÑandú'), ['palabra'], 'la joroba después de una vocal con tilde');
  });

  test('InventedNames_Rule_EachExemptionIsNarrow', () => {
    // palabra estructural: compartirla no cuenta… y no tapa una palabra que sí es del nombre
    assert.deepStrictEqual(motivos('FantasurBackend', 'MirloBackend'), [], 'una palabra estructural compartida no cuenta');
    assert.deepStrictEqual(motivos('FantasurPagosBackend', 'MirloPagosBackend'), ['palabra'], 'la estructural no tapa la otra palabra');
    assert.deepStrictEqual(motivos('FantasurStory', 'MirloStory'), [], '`story` nombra la clase de artefacto: es estructural');
    assert.deepStrictEqual(motivos('story-fantasur-cobros', 'story-mirlo-cobros'), ['palabra'], '…y no tapa la palabra que sigue');
    // lo que las dos traen igual al principio y es estructural o de convención no es la inicial
    assert.deepStrictEqual(motivos('BackendFantasur', 'BackendMirlo'), [], 'el mismo prefijo estructural no es la inicial');
    assert.deepStrictEqual(motivos('useFantasurStore', 'useMirloStore'), [], 'el prefijo de convención no es la inicial');
    assert.deepStrictEqual(motivos('IFantasurService', 'IMirloService'), [], 'la I de interfaz no es la inicial');
    assert.deepStrictEqual(motivos('useFantasurStore', 'useFresquitoStore'), ['inicial'], 'después del prefijo, la inicial se mira igual');
    assert.deepStrictEqual(motivos('usaFantasur', 'usaMirlo'), ['inicial'], 'un prefijo que no es de convención sí es la inicial');
    // prefijo neutro del inventado, suelto o pegado
    assert.deepStrictEqual(motivos('Aldaba', 'acme-mirlo'), [], 'el prefijo neutro no cuenta como inicial');
    assert.deepStrictEqual(motivos('Mostaza', 'acme-mirlo'), ['inicial'], 'después del prefijo neutro, la inicial se mira igual');
    assert.deepStrictEqual(motivos('Aldaba', 'acme'), ['inicial'], 'un inventado que es sólo el prefijo no queda eximido');
    assert.deepStrictEqual(motivos('fantasurdb', 'acmefresquito'), ['inicial'], 'pegado, el prefijo neutro tampoco tapa la inicial');
    assert.deepStrictEqual(motivos('aldabadb', 'acmemirlo'), [], 'pegado, el prefijo neutro no cuenta como inicial');
    assert.deepStrictEqual(motivos('BackendFantasur', 'acme-backend-mirlo'), [], 'el prefijo neutro se saca antes de comparar lo que viene igual');
    // formato fijo
    assert.deepStrictEqual(motivos('a1b2c3d4-1111-2222-3333-444455556666', '00000000-0000-0000-0000-000000000000'), [], 'un UUID no puede cambiar de largo');
    assert.deepStrictEqual(motivos('0a1b2c3d-1111-2222-3333-444455556666', '00000000-0000-0000-0000-000000000000'), [], '…y su inventado es el de ceros: tampoco cuenta la inicial');
    assert.deepStrictEqual(motivos('a1b2c3d4-1111-2222-3333-444455556666', 'a0000000-0000-0000-0000-00000000000'), ['inicial'], 'si el inventado no es un UUID, no hay exención');
  });

  test('InventedNames_Rule_ClientLengthAlsoCountsWithSeparators', () => {
    // `FantasurBZ` también se reemplaza escrito `fantasur-bz` (un carácter más): el inventado no puede medir eso
    assert.deepStrictEqual(motivos('FantasurBZ', 'MirloTordos', { cliente: true }), ['largo'], 'el largo del nombre con un separador');
    assert.deepStrictEqual(motivos('FantasurBZ', 'MirloTordos'), [], 'sólo para un cliente: a los demás no se les reemplaza separado');
    assert.deepStrictEqual(motivos('FantasurBZ', 'MirloTordo', { cliente: true }), ['largo'], 'y el largo exacto, como siempre');
    assert.deepStrictEqual(motivos('fantasur-bz', 'MirloTordo', { cliente: true }), ['largo'], 'declarado con separador, también se reemplaza pegado');
    assert.deepStrictEqual(motivos('fantasur-bz', 'MirloTordosDos', { cliente: true }), [], 'ni el largo declarado, ni pegado, ni con separador');
    assert.deepStrictEqual(motivos('Fantasur', 'Mirlos', { cliente: true }), [], 'una sola parte no tiene variante con separador');
  });

  test('InventedNames_Rule_AnotherPairsInventedIsNotTheReal', () => {
    // una forma intermedia: el real de una app, escrito ya con el inventado de su cliente
    const ajenos = new Set(['mirlo']);
    assert.deepStrictEqual(motivos('mirlo-cobranzas', 'mirlo-pedidos', { ajenos }), [], 'el inventado del cliente no es del real');
    assert.deepStrictEqual(motivos('mirlo-cobranzas', 'mirlo-cobranza', { ajenos }), ['inicial', 'palabra'], 'lo que sigue se mide igual');
    assert.deepStrictEqual(motivos('FantasurCobranzas', 'mirlo-cobranza', { ajenos }), ['palabra'], 'el inventado de otro par sólo se descuenta donde el real ya lo trae');
    assert.deepStrictEqual(motivos('mirlo-cobranzas', 'mirlo-pedidos'), ['inicial', 'palabra'], 'si no es de otro par, es una palabra conservada');
  });

  test('InventedNames_Rule_ListsAreDeclaredWithTheirReason', () => {
    const todas = Object.values(ESTRUCTURALES).flat();
    for (const [motivo, lista] of Object.entries(ESTRUCTURALES)) {
      assert.ok(motivo.trim().length > 10, `cada grupo de palabras estructurales dice su motivo: «${motivo}»`);
      assert.ok(lista.length > 0, `un grupo vacío no declara nada: «${motivo}»`);
    }
    for (const [categoria, motivo] of Object.entries(CATEGORIAS_FUERA)) {
      assert.ok(motivo.trim().length > 10, `cada categoría que la regla no mide dice por qué: ${categoria}`);
      assert.ok(!CATEGORIAS.includes(categoria), `una categoría no puede estar adentro y afuera: ${categoria}`);
    }
    for (const w of [...todas, ...CONVENCION, ...NEUTROS]) assert.strictEqual(w, sinTildes(w.toLowerCase()), `las listas van en minúscula y sin tildes: ${w}`);
    assert.strictEqual(new Set(todas).size, todas.length, 'una palabra estructural, una sola vez');
    for (const w of todas) assert.ok(w.length >= 4, `una palabra de menos de cuatro letras nunca cuenta: sobra en la lista (${w})`);
    for (const w of CONVENCION) assert.ok(w.length < 4 || PALABRAS_ESTRUCTURALES.has(w), `un prefijo de convención de cuatro letras o más sólo exime la inicial: si además nombra una clase de cosa, va también a las estructurales (${w})`);
    for (const w of NEUTROS) assert.ok(!PALABRAS_ESTRUCTURALES.has(w) && !PREFIJOS_DE_CONVENCION.has(w), `un prefijo neutro no es además estructural ni de convención: ${w}`);
  });

  test('InventedNames_Table_CleanIsZeroAndViolationsAreNamedByIndex', () => {
    const limpia = { pares: [par('Fantasur', 'cliente', [['Fantasur', 'Mirlo'], ['FantasurBackend', 'MirloBackend']]), par('Nombrex', 'interno', [['Nombrex', 'Quebrachal']])] };
    conTabla(limpia, (r) => {
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /^✅ 2 pares \(3 formas\) cumplen/);
    });
    const sucia = { pares: [
      par('Fantasur', 'cliente', [['Fantasur', 'Mirlo'], ['FantasurPagos', 'MirloPagos']]), // 0: una forma con palabra
      par('Nombrex', 'interno', [['Nombrex', 'Quebrachal']]), // 1: cumple
      par('Zarzamora', 'persona', [['Zarzamora', 'Zorzalito']]), // 2: inicial y largo
      par('Tornasol', 'maquina', [['Tornasol', 'Pedernales']], { anonimoProsa: 'otra voz' }), // 3: la forma de prosa, mismo largo
      par('servidor.fantasur.example', 'host-interno', [['servidor.fantasur.example', 'servidor.fantasur.example']]), // 4: conocida, fuera de la regla
      par('mirlo-cobranzas', 'cliente', [['mirlo-cobranzas', 'mirlo-pedidos']]), // 5: forma intermedia con el inventado del par 0: cumple
    ] };
    conTabla(sucia, (r) => {
      assert.strictEqual(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /^❌ 3 de 5 pares no cumplen/, 'cuenta los pares de las cuatro categorías, no los servidores');
      assert.match(r.stdout, /^ {2}pares\[0\] \(cliente\): palabra$/m);
      assert.match(r.stdout, /^ {2}pares\[2\] \(persona\): inicial, largo$/m);
      assert.match(r.stdout, /^ {2}pares\[3\] \(maquina\): largo$/m, 'la forma de prosa también se mide');
      assert.doesNotMatch(r.stdout, /pares\[1\]|pares\[4\]|pares\[5\]/);
      assert.doesNotMatch(r.stdout + r.stderr, /Fantasur|Zarzamora|Tornasol|Mirlo|Zorzalito|Pagos/i, 'la salida nombra índice y categoría, nunca un valor');
    });
  });

  test('InventedNames_Table_TwoRealsDoNotShareAnInvented', () => {
    const comparten = { pares: [
      par('Fantasur', 'cliente', [['Fantasur', 'Mirlo']]),
      par('Nombrex', 'interno', [['Nombrex', 'Quebrachal'], ['NombrexDos', 'Mirlo']]),
      par('Zarzamora', 'persona', [['Zarzamora', 'Tordo'], ['zarzamora', 'Tordo']]), // el mismo inventado dentro de UN par no es compartir
    ] };
    conTabla(comparten, (r) => {
      assert.strictEqual(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /^ {2}pares\[0\] \(cliente\): comparte$/m);
      assert.match(r.stdout, /^ {2}pares\[1\] \(interno\): comparte$/m);
      assert.doesNotMatch(r.stdout, /pares\[2\]/);
    });
  });

  test('InventedNames_Table_WhatCannotBeMeasuredIsTwo', () => {
    const bueno = par('Nombrex', 'interno', [['Nombrex', 'Quebrachal']]);
    const casos = [
      ['sin tabla', undefined, /no pude medir — no pude leer la tabla \(ENOENT\)/],
      ['no es JSON', '{ "pares": [', /no pude medir — la tabla no es JSON/],
      ['sin pares', { otra: [] }, /no pude medir — la tabla no trae `pares`/],
      ['un par sin formas', { pares: [bueno, { real: 'Fantasur', categoria: 'cliente' }] }, /no pude medir — pares\[1\]: sin `real` o sin `formas`/],
      ['un par con la lista de formas vacía', { pares: [bueno, { real: 'Fantasur', categoria: 'cliente', formas: [] }] }, /no pude medir — pares\[1\]: sin ninguna forma/],
      ['una forma sin inventado', { pares: [bueno, { real: 'Fantasur', categoria: 'cliente', formas: [{ texto: 'Fantasur' }] }] }, /no pude medir — pares\[1\]\.formas\[0\]: sin `texto` o sin `anonimo`/],
      ['un inventado vacío', { pares: [bueno, par('Fantasur', 'cliente', [['Fantasur', '']])] }, /no pude medir — pares\[1\]\.formas\[0\]: sin `texto` o sin `anonimo`/],
      ['un inventado de espacios', { pares: [bueno, par('Fantasur', 'cliente', [['Fantasur', '  ']])] }, /no pude medir — pares\[1\]\.formas\[0\]: sin `texto` o sin `anonimo`/],
      ['una forma de prosa vacía', { pares: [bueno, par('Fantasur', 'cliente', [['Fantasur', 'Mirlo']], { anonimoProsa: '' })] }, /no pude medir — pares\[1\]\.anonimoProsa: no es un texto/],
      // un inventado IDÉNTICO al real bajo una categoría mal escrita: no puede salir de la cuenta callado
      ['una categoría en otra caja', { pares: [bueno, par('Fantasur', 'CLIENTE', [['Fantasur', 'Fantasur']])] }, /no pude medir — pares\[1\]: su `categoria` no es una de las que la regla conoce/],
      ['una categoría mal escrita', { pares: [bueno, par('Fantasur', 'clientes', [['Fantasur', 'Fantasur']])] }, /no pude medir — pares\[1\]: su `categoria` no es una de las que la regla conoce/],
      ['un par sin categoría', { pares: [bueno, { real: 'Fantasur', formas: [{ texto: 'Fantasur', anonimo: 'Fantasur' }] }] }, /no pude medir — pares\[1\]: su `categoria` no es una de las que la regla conoce/],
      ['ningún par que medir', { pares: [par('servidor.fantasur.example', 'host-interno', [['servidor.fantasur.example', 'otro.example']])] }, /no pude medir — la tabla no trae ningún par de las categorías que la regla mide/],
    ];
    for (const [nombre, tabla, mensaje] of casos) {
      conTabla(tabla, (r) => {
        assert.strictEqual(r.status, 2, `${nombre}: «no pude medir» es 2, nunca 0 ni 1\n${r.stdout}${r.stderr}`);
        assert.match(r.stderr, mensaje, nombre);
        assert.strictEqual(r.stdout, '', `${nombre}: sin veredicto en la salida`);
        assert.doesNotMatch(r.stderr, /Fantasur|Nombrex|Quebrachal/, `${nombre}: el motivo no nombra ningún valor`);
      });
    }
    // y la prueba ENTERA (sin `--table`), en un árbol sin la tabla o con una que no se puede medir: 2 y lo dice — ni un
    // salteo, ni un «0 pruebas» verde, ni un 1 que se confunda con «hay pares que no cumplen»
    const arboles = [
      ['sin la tabla', null, /no pude medir — no pude leer la tabla \(ENOENT\)/],
      ['con una tabla que no es JSON', '{ "pares": [', /no pude medir — la tabla no es JSON/],
      ['con una categoría que la regla no conoce', JSON.stringify({ pares: [bueno, par('Fantasur', 'Cliente', [['Fantasur', 'Fantasur']])] }), /no pude medir — pares\[1\]: su `categoria`/],
    ];
    for (const [nombre, tabla, mensaje] of arboles) {
      const arbol = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-rule-arbol-'));
      try {
        const copia = path.join(arbol, 'scripts', 'tests', path.basename(__filename));
        fs.mkdirSync(path.dirname(copia), { recursive: true });
        fs.copyFileSync(__filename, copia);
        // un árbol armado: ahí la tabla tiene que estar (en el público solo, que falte es lo esperado: ver abajo)
        fs.mkdirSync(path.join(arbol, '.tycon'), { recursive: true });
        fs.writeFileSync(path.join(arbol, '.tycon', 'internal-forms.json'), '{ "layout": "thin" }\n');
        if (tabla !== null) {
          fs.mkdirSync(path.join(arbol, 'scripts', 'publishing'), { recursive: true });
          fs.writeFileSync(path.join(arbol, 'scripts', 'publishing', 'replacements.json'), tabla);
        }
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const r = spawnSync(process.execPath, [copia], { encoding: 'utf8', env });
        assert.strictEqual(r.status, 2, `un árbol ${nombre}: 2\n${r.stdout}${r.stderr}`);
        assert.match(r.stderr, mensaje, nombre);
        assert.doesNotMatch(r.stdout, /^# pass/m, `${nombre}: no llega a correr ninguna prueba`);
      } finally {
        fs.rmSync(arbol, { recursive: true, force: true });
      }
    }
  });

  // en el público solo, sin la tabla y sin la lista del repo privado: corren los casos de mentira y el de la tabla real
  // sale SALTEADO con su motivo (nunca verde, nunca 2). El espejo: con la lista del repo privado y sin la tabla, 2 (arriba).
  // La copia corre con INVENTED_RULE_COPY=1: adentro de ella este caso no se vuelve a lanzar (sería una copia de la copia).
  test('PublicTree_WithoutTable_RunsTheToyCases_AndSkipsTheRealOne', (t) => {
    if (process.env.INVENTED_RULE_COPY === '1') { t.skip('dentro de la copia que lanza este mismo caso'); return; }
    const arbol = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-rule-publico-'));
    try {
      const copia = path.join(arbol, 'scripts', 'tests', path.basename(__filename));
      fs.mkdirSync(path.dirname(copia), { recursive: true });
      fs.copyFileSync(__filename, copia);
      const env = { ...process.env, INVENTED_RULE_COPY: '1' };
      delete env.NODE_TEST_CONTEXT;
      // TAP pedido a mano: desde Node 23 la salida por defecto es la de personas («﹣ … # NO MEDIDO»), sin «# SKIP» ni
      // «# pass»; con Node 20 local daba verde y en public-ci (Node 22 y 24) rojo
      const r = spawnSync(process.execPath, ['--test-reporter=tap', copia], { encoding: 'utf8', env, timeout: 60000 });
      assert.strictEqual(r.status, 0, `el público sin la tabla: 0\n${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /# SKIP NO MEDIDO en el público solo/, 'el caso de la tabla real sale salteado y dice por qué');
      assert.match(r.stdout, /^# pass [1-9]/m, 'y los casos de mentira corren');
    } finally {
      fs.rmSync(arbol, { recursive: true, force: true });
    }
  });

  test('InventedNames_DoNotKeepInitialLengthOrWord', (t) => {
    if (SIN_TABLA_POR_DISENO) { t.skip(NO_MEDIDO_PUBLICO); return; }
    const r = medirArchivo(TABLA);
    assert.ok(r.medidos > 0, 'la tabla trae pares de las cuatro categorías');
    assert.strictEqual(r.violan.length, 0, `${r.violan.length} de ${r.medidos} pares de la tabla no cumplen la regla del inventado `
      + `(inicial, largo exacto, una palabra no estructural, o un inventado compartido):\n${renglones(r).join('\n')}`);
  });
}

const iTabla = process.argv.indexOf('--table');
if (iTabla > 0) {
  process.exitCode = medirYDecir(process.argv[iTabla + 1] || '');
} else {
  // Antes de correr nada: si la tabla del árbol no se puede medir, se dice y se sale 2. Nunca un salteo verde, y nunca
  // un 1 (que quiere decir «hay pares que no cumplen»).
  let sePuede = true;
  if (SIN_TABLA_POR_DISENO) process.stderr.write(`invented-names-rule: ${NO_MEDIDO_PUBLICO}; corren los casos de mentira\n`);
  else try { medirArchivo(TABLA); } catch (e) {
    if (!(e instanceof NoPudeMedir)) throw e;
    process.stderr.write(`invented-names-rule: no pude medir — ${e.message}\n`);
    process.exitCode = 2;
    sePuede = false;
  }
  if (sePuede) pruebas();
}
