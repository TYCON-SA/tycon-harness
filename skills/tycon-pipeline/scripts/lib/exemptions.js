'use strict';
// exemptions.js — las exenciones que se agregan a una historia y su constancia en el repo.
//
// Una exención (`dod_runtime_exempt`, `advisors_exempt`) saltea un chequeo del cierre. Agregarla la decide el dueño con su
// firma sobre la historia: el gancho del encabezado (on-frontmatter-write.js) la pide antes de escribir y, con ella, anota
// un renglón en `<repo>/.tycon/exemptions.jsonl`, que viaja con el commit. El portón del commit (on-pre-commit.js) y el
// de CI (scripts/ci/tycon-ci-gate.js) leen ese archivo sólo cuando lo que se commitea agrega una exención a una historia:
// sin su renglón frenan, se haya escrito por donde se haya escrito (la herramienta de edición, la consola, un parche). Una
// exención que ya estaba no pide nada.
//
// El archivo lo escribe sólo `anotar`; los frenos de escritura lo cuentan como una constancia que no se escribe a mano
// (lib/story-gate.js `signedRecordKind`).
const fs = require('fs');
const path = require('path');

const RUTA = '.tycon/exemptions.jsonl';

// Las exenciones, cada una con qué saltea y cuál es el camino normal.
const EXENCIONES = [
  { campo: 'dod_runtime_exempt', saltea: 'la exime de la prueba en vivo',
    camino: ['El camino normal es correr la prueba en vivo; si la historia no se puede terminar, dejarla como deuda', '(marker.js close-as-debt).'] },
  { campo: 'advisors_exempt', saltea: 'la exime de los revisores',
    camino: ['El camino normal es correr los revisores de la historia en su ejecución del pipeline.'] },
];

// El encabezado como lo lee el portón de CI, sin la marca de orden de bytes: desde las rayas del comienzo, con lo que
// tengan después en su renglón, hasta el primer renglón que empieza con rayas. null si no hay.
function encabezadoAncho(c) {
  const t = String(c || '').replace(/^﻿/, '');
  if (!t.startsWith('---')) return null;
  const fin = t.indexOf('\n---', 3);
  return fin === -1 ? null : t.slice(3, fin);
}
const esHistoriaAncha = (c) => { const fm = encabezadoAncho(c); return fm !== null && /^\s*(?:story|status)\s*:/m.test(fm); };

// Los lectores que conceden una exención: el más ancho (en cualquier renglón, con sangría o comillas), el del freno del
// commit (en cualquier renglón, sin sangría ni comillas) y los del portón de CI y pipeline.js (en el encabezado). Sólo en
// una historia: un archivo que no lo es no concede nada.
function lectoresDe(campo) {
  const ancho = new RegExp(`^\\s*${campo}:\\s*["']?true\\b`, 'm');
  const estrecho = new RegExp(`^${campo}:\\s*true\\b`, 'm');
  return [(c) => ancho.test(c), (c) => estrecho.test(c), (c) => ancho.test(encabezadoAncho(c) || '')];
}

/** El `story:` del encabezado, sin comillas ni comentario, o null. */
function idDe(texto) {
  const m = /^\s*story\s*:\s*["']?([^"'\s#]+)/m.exec(encabezadoAncho(texto) || '');
  return m ? m[1] : null;
}

// Nueva: algún lector la ve en lo que queda escrito y no la veía antes. «Ya estaba» cuenta sólo si ese mismo lector la
// concedía en una historia con el mismo `story:`: un archivo exento que pasa a ser otra historia no le pasa su exención
function esExencionNueva(campo, viejo, nuevo) {
  if (!esHistoriaAncha(nuevo)) return false;
  const antesEraEsta = !!viejo && esHistoriaAncha(viejo) && idDe(viejo) === idDe(nuevo);
  return lectoresDe(campo).some((ve) => ve(nuevo) && !(antesEraEsta && ve(viejo)));
}

/** Los campos de las exenciones que `nuevo` agrega respecto de `viejo` (null o '' si la historia es nueva). */
const nuevas = (viejo, nuevo) => EXENCIONES.filter((ex) => esExencionNueva(ex.campo, viejo, nuevo)).map((ex) => ex.campo);

/**
 * ¿El texto del archivo de constancias trae la de `campo` para la historia `story` en el archivo `archivo` (ruta desde
 * la raíz del repo, con `/`)? Las dos cosas: un número de historia se repite entre archivos. Un renglón ilegible no cuenta.
 */
function tieneConstancia(texto, story, campo, archivo) {
  return String(texto || '').split('\n').some((l) => {
    try {
      const r = JSON.parse(l);
      return !!r && String(r.story) === String(story) && r.campo === campo && r.archivo === archivo;
    } catch { return false; }
  });
}

/**
 * Los campos de las exenciones que `nuevo` agrega a la historia del archivo `archivo` y no tienen su constancia. `viejo`
 * es lo que había antes en ese archivo (o en el de origen, si se renombró). `leer()` devuelve el texto del archivo de
 * constancias tal como se commitea, y se llama sólo si hay alguna exención nueva: lo demás no lee nada. Sin poder leerlo,
 * o sin `story:` en la historia, ninguna tiene constancia.
 */
function faltan({ viejo, nuevo, archivo, leer }) {
  const campos = nuevas(viejo, nuevo);
  if (!campos.length) return [];
  const story = idDe(nuevo);
  let texto = '';
  try { texto = leer() || ''; } catch { texto = ''; }
  return campos.filter((c) => !story || !tieneConstancia(texto, story, c, archivo));
}

/** ¿El texto nombra alguna exención? Para no leer lo de antes de una historia que no la trae. */
const nombraExencion = (texto) => EXENCIONES.some((ex) => new RegExp(`${ex.campo}\\s*["']?\\s*:`).test(String(texto || '')));

/** El texto que dice qué falta, para los dos portones: la exención, la historia y cómo se firma. */
function mensajeDeFalta(campos, story) {
  return `agrega ${campos.map((c) => `\`${c}\``).join(' y ')} y \`${RUTA}\` no trae su constancia para la historia ${story || '(sin `story:`)'}. `
    + 'Eximir una historia lo decide la persona: con su firma de la exención sobre la historia, el arnés anota la constancia '
    + 'al escribirla, y se commitea con ella.';
}

/** Anota la constancia de `campo` para la historia en el repo `repoRoot`. Lanza si no puede escribirla. */
function anotar(repoRoot, { story, campo, archivo, via, sesion, ts = new Date().toISOString() }) {
  const f = path.join(repoRoot, RUTA);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${JSON.stringify({ story: String(story), campo, archivo, via, sesion, ts })}\n`);
}

module.exports = { RUTA, EXENCIONES, encabezadoAncho, esHistoriaAncha, lectoresDe, esExencionNueva, nuevas, idDe, tieneConstancia, faltan, nombraExencion, mensajeDeFalta, anotar };
