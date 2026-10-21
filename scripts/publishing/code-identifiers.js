#!/usr/bin/env node
'use strict';
// code-identifiers.js — ¿sale en una copia un identificador de código de la lista de denegación, con CUALQUIER grafía?
//
// POR QUÉ EXISTE: los ejemplos del arnés no pueden citar componentes, hooks, servicios, stories ni archivos del código de
// productos: los identificadores reales están en la lista de denegación como término de CAJA EXACTA (sin
// caja marcaría prosa común: `ZetaPanel` no es «the zeta panel»). El detector, entonces, ve la grafía exacta; la
// misma cosa escrita `zeta-panel`, `ZETA_PANEL` o pegada a otra palabra (`abrirZetaPanel`) se le pasa.
// Este buscador mira eso: cada NOMBRE de la copia, aplanado. Lo llama `scripts/tests/export-real.test.sh`
// sobre la copia pública de verdad; su lógica la prueba `scripts/tests/code-identifiers.test.js`.
//
// QUÉ ES UN IDENTIFICADOR DE CÓDIGO de la lista: un término `interno`, de caja exacta (`mayusculas`), que vale también
// pegado a otra palabra (sin `palabra`), escrito sólo con letras, números, guiones, puntos y guiones bajos, con dos
// partes o más (`ZetaPanel`, `story-b2-algo`) y ocho caracteres o más una vez aplanado. Los de palabra entera (repos,
// siglas) y las frases los ve el detector con su término.
//
// CÓMO COMPARA: un nombre es una tira de letras y números con separadores `-`, `_` o `.` adentro (uno o varios; el guion
// bajo puede venir escapado, `\_`). Se parte en PARTES por los separadores y por las jorobas (`abrirZetaPanel` → abrir ·
// Zeta · Panel; `IZetaPanel` → I · Zeta · Panel) y se aplana (sin separadores, en minúscula). Coincide si la clave del
// término cae justo entre dos bordes de parte: `abrirZetaPanel`, `zeta-panel.test.tsx` y `ZETA_PANEL` sí; `PizzetaPanel`
// o `zetapanelista` no (es otra palabra). Un nombre partido entre carpetas (`zeta/panel.tsx`) o por `:` es otro nombre.
// Se miran el contenido de cada archivo de texto y el NOMBRE de cada archivo y de cada carpeta.
//
// LA PALABRA COMÚN: un identificador que en minúscula y pegado es una palabra corriente la declara en el `noVe` de su
// término (`"noVe": ["zonarecreo"]`): ese nombre, escrito exactamente así, no cuenta. Con otra grafía sigue contando.
//
// CÓMO FALLA: nunca da verde sin mirar. Una lista con menos de 30 identificadores, uno que el buscador no puede ver ni
// en su propia grafía, o una entrada de la copia que no se deja leer, son rojo con su motivo. El rojo nombra al término
// por su NÚMERO en la lista (`terminos[N]`), nunca por su texto.
//
// A mano:  node scripts/publishing/code-identifiers.js [--label <texto>] <copia> <denylist.json>
//          imprime UNA línea: «✅|❌|⏭ <label> <mensaje>» y sale 0 (el veredicto va en el texto; ⏭ = NO MEDIDO, sin lista).
//          Sin argumentos, con la lista rota o de otra forma, o con una copia que no existe: una línea ❌ con el motivo.

const fs = require('fs');
const path = require('path');

const MIN_IDENTIFIERS = 30;
const MIN_KEY = 8;
const SEPARATOR = /(?:\\?[-_.])+/;
// un nombre: letras y números, con separadores adentro
const NAME = /[A-Za-z0-9]+(?:(?:\\?[-_.])+[A-Za-z0-9]+)*/g;
const HUMP = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

/** Las partes de un nombre, en minúscula: por separador y por joroba. */
function partsOf(name) {
  return name.split(SEPARATOR).flatMap((p) => p.split(HUMP)).filter(Boolean).map((p) => p.toLowerCase());
}

/**
 * Los identificadores de código de una lista de términos, cada uno con su posición en la lista.
 * Una lista con otra forma (no es una lista, un término que no es un objeto con su `patron`, un `noVe` que no es una
 * lista) LANZA con su motivo: no se saca de ahí «los que se pudieron leer», porque lo que no se leyó no se miró.
 */
function identifiersFrom(terminos) {
  if (!Array.isArray(terminos)) throw new Error('«terminos» tiene que ser una lista');
  const out = [];
  terminos.forEach((t, indice) => {
    if (!t || typeof t !== 'object' || typeof t.patron !== 'string') throw new Error(`terminos[${indice}]: no es un término (un objeto con su «patron»)`);
    if (t.noVe !== undefined && !Array.isArray(t.noVe)) throw new Error(`terminos[${indice}]: «noVe» tiene que ser una lista`);
    if (t.categoria !== 'interno' || !t.mayusculas || t.palabra) return;
    if (!/^[A-Za-z0-9._-]+$/.test(t.patron)) return;
    const partes = partsOf(t.patron);
    const clave = partes.join('');
    if (partes.length < 2 || clave.length < MIN_KEY) return;
    // los nombres que el propio término declara que NO son él (una palabra común), tal como están escritos
    const exentos = new Set();
    for (const muestra of t.noVe || []) {
      for (const m of String(muestra).matchAll(NAME)) if (partsOf(m[0]).join('') === clave) exentos.add(m[0]);
    }
    out.push({ indice, patron: t.patron, clave, exentos });
  });
  return out;
}

/** Los identificadores que aparecen en un texto: [{ indice, nombre }] (un nombre puede traer más de uno). */
function findInText(texto, ids, minimo) {
  const out = [];
  const corto = minimo === undefined ? Math.min(...ids.map((x) => x.clave.length), Infinity) : minimo;
  for (const m of texto.matchAll(NAME)) {
    const nombre = m[0];
    if (nombre.length < corto) continue;
    const partes = partsOf(nombre);
    const llano = partes.join('');
    if (llano.length < corto) continue;
    let bordes = null;   // dónde empieza cada parte, y el final
    for (const id of ids) {
      let desde = llano.indexOf(id.clave);
      if (desde < 0 || id.exentos.has(nombre)) continue;
      if (!bordes) {
        bordes = new Set([0]);
        let pos = 0;
        for (const p of partes) { pos += p.length; bordes.add(pos); }
      }
      for (; desde >= 0; desde = llano.indexOf(id.clave, desde + 1)) {
        if (bordes.has(desde) && bordes.has(desde + id.clave.length)) { out.push({ indice: id.indice, nombre }); break; }
      }
    }
  }
  return out;
}

/** Recorre una copia: el contenido de cada archivo de texto y el nombre de cada archivo y carpeta. */
function scanCopy(copia, ids) {
  const hallazgos = [];
  const sinLeer = [];
  const corto = Math.min(...ids.map((x) => x.clave.length), Infinity);
  const vistos = new Set();
  const anotar = (donde, encontrados) => {
    for (const e of encontrados) {
      const k = `${donde}\u0000${e.indice}`;
      if (!vistos.has(k)) { vistos.add(k); hallazgos.push({ donde, indice: e.indice }); }
    }
  };
  const andar = (dir) => {
    let entradas;
    try {
      entradas = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      sinLeer.push(`${path.relative(copia, dir) || '.'} (${e.code || e.message})`);
      return;
    }
    for (const e of entradas.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.name === '.git') continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(copia, abs).split(path.sep).join('/');
      anotar(`${rel} (nombre)`, findInText(e.name, ids, corto));
      if (e.isDirectory()) { andar(abs); continue; }
      if (!e.isFile()) continue;
      let texto;
      try {
        texto = fs.readFileSync(abs, 'utf8');
      } catch (err) {
        sinLeer.push(`${rel} (${err.code || err.message})`);
        continue;
      }
      if (texto.includes('\u0000')) continue;   // binario: su nombre ya se miró
      texto.split('\n').forEach((linea, i) => anotar(`${rel}:${i + 1}`, findInText(linea, ids, corto)));
    }
  };
  andar(copia);
  return { hallazgos, sinLeer };
}

/** Los identificadores que el buscador no ve ni en su propia grafía: no se pueden contar como mirados. */
function blind(ids) {
  return ids.filter((id) => !findInText(id.patron, [id]).some((x) => x.indice === id.indice));
}

/** El veredicto de una pasada: { estado: 'ok' | 'rojo', mensaje }. */
function verdict(resultado, ids) {
  if (ids.length < MIN_IDENTIFIERS) {
    return { estado: 'rojo', mensaje: `la lista trae ${ids.length} identificadores de código (interno, caja exacta, sin «palabra», dos partes o más): son menos de ${MIN_IDENTIFIERS}, la prueba no miraría lo que tiene que mirar` };
  }
  const ciegos = blind(ids);
  if (ciegos.length) {
    return { estado: 'rojo', mensaje: `${ciegos.length} identificador(es) de la lista que este buscador no puede ver ni en su propia grafía (terminos[${ciegos.map((x) => x.indice).slice(0, 8).join(', ')}]): no están mirados` };
  }
  if (resultado.sinLeer.length) {
    return { estado: 'rojo', mensaje: `no pude leer ${resultado.sinLeer.length} entrada(s) de la copia, y lo que no se miró no está limpio: ${resultado.sinLeer.slice(0, 5).join(' ')}` };
  }
  if (resultado.hallazgos.length) {
    const muestra = resultado.hallazgos.slice(0, 5).map((h) => `${h.donde} (término ${h.indice})`).join(' ');
    return { estado: 'rojo', mensaje: `un identificador de código real sale en la copia (${resultado.hallazgos.length}): ${muestra} — el número es su posición en \`terminos\` de la lista` };
  }
  return { estado: 'ok', mensaje: `ningún identificador de código real sale en la copia, en ninguna grafía, ni en el nombre de un archivo o de una carpeta (${ids.length} de la lista)` };
}

module.exports = { identifiersFrom, partsOf, findInText, scanCopy, blind, verdict, MIN_IDENTIFIERS };

if (require.main === module) {
  const args = process.argv.slice(2);
  let label = 'identificadores de código:';
  const i = args.indexOf('--label');
  if (i >= 0) { label = args[i + 1] || label; args.splice(i, 2); }
  const [copia, lista] = args;
  if (!copia || !lista) {
    console.log(`❌ ${label} uso: code-identifiers.js [--label <texto>] <copia> <denylist.json>`);
    process.exit(0);
  }
  let terminos;
  try {
    const leida = JSON.parse(fs.readFileSync(lista, 'utf8'));
    // sin la clave no hay términos (lista corta, se dice); con la clave, es lo que traiga — la forma la valida identifiersFrom
    terminos = leida && typeof leida === 'object' && !Array.isArray(leida) && leida.terminos !== undefined ? leida.terminos : [];
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log(`⏭ ${label} NO MEDIDO — la lista de denegación no está (${path.basename(lista)}): sin ella no hay identificadores que buscar`);
    } else {
      console.log(`❌ ${label} la lista de denegación no se deja leer (${e.code || e.message}): no se miró nada`);
    }
    process.exit(0);
  }
  // todo lo que sigue va adentro de un solo intento: una lista de otra forma, o cualquier otra sorpresa, es UNA línea
  // ❌ con su motivo — nunca una excepción suelta sin veredicto (el que llama cuenta las líneas)
  let v;
  try {
    const ids = identifiersFrom(terminos);
    v = verdict(scanCopy(copia, ids), ids);
  } catch (e) {
    v = { estado: 'rojo', mensaje: `no pude mirar: ${e && e.message ? e.message : String(e)}` };
  }
  console.log(`${v.estado === 'ok' ? '✅' : '❌'} ${label} ${v.mensaje}`);
}
