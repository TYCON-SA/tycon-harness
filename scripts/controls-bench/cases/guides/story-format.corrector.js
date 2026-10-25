'use strict';
/**
 * Corrector del caso de `story-format.md`: la story que quedó en `specs/` pasa el lint de frontmatter del arnés (la mitad
 * del puntaje) y trae las secciones que la guía exige (la otra mitad, repartida entre ellas). Sin story, 0.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LINT = path.resolve(__dirname, '..', '..', '..', 'lib', 'lint-story-frontmatter.js');
// cada sección: su encabezado y lo que tiene que haber ADENTRO, hasta el próximo encabezado de su nivel o de uno mayor
const SECCIONES = [
  ['la story «Como …, quiero …, para …»', /^## Story\s*$/m, /\bComo\b[\s\S]*?\bquiero\b[\s\S]*?\bpara\b/],
  ['los criterios numerados', /^## Acceptance Criteria\s*$/m, /^\s*1\.\s/m],
  ['la tabla de pruebas', /^### Tests\b[^\n]*$/m, /^\|\s*#\s*\|/m],
  ['las tareas', /^## Tasks \/ Subtasks\s*$/m, null],
  ['las notas para el dev', /^## Dev Notes\s*$/m, null],
];

/** El cuerpo de la sección que abre `encabezado`, o null si no está. */
function cuerpo(texto, encabezado) {
  const m = encabezado.exec(texto);
  if (!m) return null;
  const nivel = /^#+/.exec(m[0])[0].length;
  const resto = texto.slice(m.index + m[0].length);
  const fin = new RegExp(`^#{1,${nivel}}\\s`, 'm').exec(resto);
  return fin ? resto.slice(0, fin.index) : resto;
}

const tiene = (texto, [, encabezado, adentro]) => {
  const c = cuerpo(texto, encabezado);
  return c !== null && (!adentro || adentro.test(c));
};

function storiesDe(dir) {
  const specs = path.join(dir, 'specs');
  const out = [];
  const recorrer = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      // un enlace puede apuntar fuera del árbol de la corrida: no se lee
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) recorrer(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  if (fs.existsSync(specs)) recorrer(specs);
  // en orden fijo: el orden de readdir cambia con el sistema de archivos
  return out.sort();
}

/**
 * Corrige cada .md de specs/ y se queda con el mejor: el agente puede dejar al lado un épico, un índice o un plan de
 * sprint, y eso no le resta a la story.
 */
function corregir({ dir }) {
  const stories = storiesDe(dir);
  if (!stories.length) return { score: 0, motivo: 'no escribió ninguna story en specs/' };
  let mejor = null;
  for (const story of stories) {
    const nota = corregirUna(dir, story);
    if (!mejor || nota.score > mejor.score) mejor = nota;
  }
  return mejor;
}

function corregirUna(dir, story) {
  const texto = fs.readFileSync(story, 'utf8');
  const lint = spawnSync(process.execPath, [LINT, story], { cwd: dir, encoding: 'utf8',
    env: Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) });
  // un lint que no arrancó o se cayó no dice nada de la story: el corredor lo cuenta como «no pude medir»
  // con 1 y sin «N revisadas», el lint no llegó a revisar (una excepción de Node también sale 1)
  const reviso = /\b\d+ revisad/.test(lint.stdout || '');
  if (lint.error || lint.status === null || lint.status > 1 || (lint.status === 1 && !reviso)) throw new Error(`el lint no corrió: ${(lint.error && lint.error.message) || lint.signal || (lint.stderr || '').trim().split('\n').pop()}`);
  // un archivo sin frontmatter el lint no lo toma por story («0 revisadas») y sale 0: eso no es pasarlo
  const paso = lint.status === 0 && /\b[1-9]\d* revisad/.test(lint.stdout || '');
  const faltan = SECCIONES.filter((s) => !tiene(texto, s)).map(([n]) => n);
  const score = (paso ? 0.5 : 0) + 0.5 * ((SECCIONES.length - faltan.length) / SECCIONES.length);
  const motivos = [path.basename(story), paso ? 'pasa el lint' : 'no pasa el lint', ...(faltan.length ? [`falta: ${faltan.join(', ')}`] : [])];
  return { score: Math.round(score * 1000) / 1000, motivo: motivos.join(' · ') };
}

module.exports = { corregir, SECCIONES };
