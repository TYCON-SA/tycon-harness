#!/usr/bin/env node
'use strict';
// work-item-field.js — el campo de la historia que guarda su pedido de trabajo: `work_item`. El nombre viejo,
// `ado_work_item`, se sigue leyendo; con los dos gana `work_item`; nadie escribe el viejo (al escribir, su línea pasa a
// llamarse `work_item`). Todo lector del arnés pasa por acá.
//
// Uso:
//   node scripts/lib/platform/work-item-field.js get <historia.md>       imprime el id; sale 3 si no tiene, 1 si no se lee
//   node scripts/lib/platform/work-item-field.js set <historia.md> <id>  lo escribe en el frontmatter
//
// Casos: scripts/tests/platform-work-item.test.js.

if (require.main === module) { try { require('../node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
const fs = require('fs');

const NAME = 'work_item';
const LEGACY = 'ado_work_item';

/** El frontmatter de un texto de historia (sin los `---`), o el texto entero si no lo tiene. */
function frontmatter(texto) {
  const t = String(texto);
  if (!t.startsWith('---')) return t;
  const fin = t.indexOf('\n---', 3);
  return fin < 0 ? t : t.slice(3, fin);
}

/** El valor de una clave de primer nivel, sin comentario ni comillas; null si falta, está vacía o es TBD. */
function valor(fm, clave) {
  const m = fm.match(new RegExp(`^${clave}:[ \\t]*(.*)$`, 'm'));
  if (!m) return null;
  const v = m[1].replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  return v && !/^(tbd|null|~)$/i.test(v) ? v : null;
}

/** El id del pedido de trabajo de una historia: de su texto (o su frontmatter) o de un frontmatter ya leído. */
function idOf(fuente) {
  if (fuente && typeof fuente === 'object') {
    for (const k of [NAME, LEGACY]) {
      const v = fuente[k];
      if (v !== undefined && v !== null && String(v).trim() && !/^(tbd|null)$/i.test(String(v).trim())) return String(v).trim();
    }
    return null;
  }
  const fm = frontmatter(fuente || '');
  return valor(fm, NAME) || valor(fm, LEGACY);
}

/**
 * Escribe `work_item: <id>` en el frontmatter de una historia: en la línea del campo (nuevo o viejo) si está; si no,
 * después de `depends_on:`, antes de `pipelines:`, o al final del frontmatter.
 */
function write(file, id) {
  // sólo un número: otra cosa (un salto de línea, por ejemplo) escribiría claves de más en el frontmatter
  if (!/^\d+$/.test(String(id))) throw new Error(`el id del pedido de trabajo no es un número: ${JSON.stringify(id)}`);
  const texto = fs.readFileSync(file, 'utf8');
  if (!texto.startsWith('---')) throw new Error(`${file} no tiene frontmatter`);
  const fin = texto.indexOf('\n---', 3);
  if (fin < 0) throw new Error(`${file}: el frontmatter no cierra`);
  const lineas = texto.slice(0, fin).split('\n');
  // con finales CRLF, cada línea guarda su «\r»: la escrita también, para no dejar una con LF suelto
  const linea = `${NAME}: ${id}${texto.includes('\r\n') ? '\r' : ''}`;
  const en = (rx) => lineas.findIndex((l, i) => i > 0 && rx.test(l));
  const actual = [en(new RegExp(`^${NAME}:`)), en(new RegExp(`^${LEGACY}:`))].find((i) => i > 0);
  if (actual) lineas[actual] = linea;
  else {
    const dep = en(/^depends_on:/);
    const pip = en(/^pipelines:/);
    if (dep > 0) {
      // después de depends_on y de su lista, si la tiene en bloque: sangrada o con los guiones al ras (YAML acepta las dos)
      let i = dep + 1;
      while (i < lineas.length && /^(\s+\S|-(\s|$))/.test(lineas[i])) i++;
      lineas.splice(i, 0, linea);
    } else if (pip > 0) lineas.splice(pip, 0, linea);
    else lineas.push(linea);
  }
  fs.writeFileSync(file, lineas.join('\n') + texto.slice(fin));
}

function main(argv) {
  const [cmd, file, id] = argv;
  if (cmd === 'get' && file) {
    // un archivo que no se lee no es «sin pedido» (3): sale 1 y lo dice
    let texto;
    try { texto = fs.readFileSync(file, 'utf8'); } catch (e) { process.stderr.write(`no pude leer ${file} (${(e && e.code) || 'error'})\n`); return 1; }
    const v = idOf(texto);
    if (!v) return 3;
    // lo que se imprime puede ir a un comando: sólo un número
    if (!/^\d+$/.test(v)) { process.stderr.write(`el pedido de trabajo de ${file} no es un número: ${JSON.stringify(v)}\n`); return 1; }
    process.stdout.write(`${v}\n`);
    return 0;
  }
  if (cmd === 'set' && file && id && /^\d+$/.test(id)) { write(file, id); return 0; }
  process.stderr.write('uso: work-item-field.js get <historia.md> | set <historia.md> <id>\n');
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { NAME, LEGACY, idOf, write, frontmatter };
