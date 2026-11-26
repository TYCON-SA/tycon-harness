#!/usr/bin/env node
'use strict';
/**
 * signatures-guide.js — las tablas de guides/owner-signatures.md salen del catálogo de firmas.
 *
 * La guía es prosa escrita a mano con tres tablas generadas de scripts/lib/signatures.js: los niveles (LEVELS), las
 * firmas que se piden hoy (SIGNATURES) y los grupos (GROUPS). Un escape retirado (`retired`) sigue en las tablas, con
 * «retirada» en lugar de su comando y la emergencia como forma de la terminal. Cada tabla va entre
 * `<!-- generado: <nombre> -->` y `<!-- fin: <nombre> -->`; lo de afuera no se toca. Sin un marcador no genera nada: no adivina dónde va la tabla.
 *
 * Uso: node scripts/tools/signatures-guide.js --write   reescribe las tablas
 *      node scripts/tools/signatures-guide.js --check   sale 1 si la guía no es la que sale del catálogo
 */
const fs = require('fs');
const path = require('path');
const cat = require('../lib/signatures.js');

const GUIA = path.resolve(__dirname, '..', '..', 'guides', 'owner-signatures.md');

const OTRA_SESION = { yes: 'sí', no: 'no, en la pestaña de esa sesión', pending: 'todavía sin comando' };
const otraSesion = (s) => (cat.ONLY_IN_TERMINAL.includes(s.id) ? 'no, sólo en tu terminal' : OTRA_SESION[s.otherSession]);
const NIVEL = { 1: '1 · rutina', 2: '2 · excepción', 3: '3 · irreversible' };
const code = (s) => `\`${s}\``;
const fila = (celdas) => `| ${celdas.join(' | ')} |`;
const tabla = (cabecera, filas) => [fila(cabecera), fila(cabecera.map(() => '---')), ...filas.map(fila)].join('\n');
// la fila de un escape retirado: ya nada lo pide, y en la terminal queda la emergencia
const RETIRADA = 'retirada: ya no apaga nada; la salida es la emergencia';

const TABLAS = {
  niveles: () => tabla(['Firma', 'Nivel', 'Quién la ve', 'Qué aprueba', 'Se pide hoy con'], cat.LEVELS.map((l) => {
    const cubren = cat.SIGNATURES.filter((s) => s.covers.includes(l.id));
    const hoy = cubren.filter((s) => !s.retired).map((s) => code(s.id));
    let pide = hoy.length ? hoy.join(', ') : 'todavía no se pide';
    if (!hoy.length && cubren.length) pide = 'ya nada la pide';
    return [code(l.id), NIVEL[l.level], l.profiles.includes('dev') ? 'dev y mantenimiento' : 'sólo mantenimiento', l.approves, pide];
  })),
  firmas: () => tabla(['Firma', 'Qué aprueba', 'Comando que la pide', '¿Desde otra sesión?', 'Firmarla en la terminal'],
    cat.SIGNATURES.map((s) => (s.retired
      ? [code(s.id), s.approves, RETIRADA, otraSesion(s), code(s.retired)]
      : [code(s.id), s.approves, code(s.command), otraSesion(s), s.terminal === null ? '—' : code(s.terminal)]))),
  grupos: () => tabla(['Grupo', 'Firmas'], Object.entries(cat.GROUPS).map(([g, ids]) => [code(g), ids.map(code).join(', ')])),
};

/** La guía con sus tablas generadas del catálogo. */
function render(texto) {
  let out = texto;
  for (const [nombre, generar] of Object.entries(TABLAS)) {
    const abre = `<!-- generado: ${nombre} -->`;
    const cierra = `<!-- fin: ${nombre} -->`;
    const i = out.indexOf(abre);
    const j = out.indexOf(cierra);
    if (i < 0 || j < i) throw new Error(`la guía no tiene el marcador de la tabla «${nombre}» (${abre} … ${cierra})`);
    out = `${out.slice(0, i + abre.length)}\n${generar()}\n${out.slice(j)}`;
  }
  return out;
}

function main(argv) {
  const modo = argv[0];
  if (!['--write', '--check'].includes(modo)) { console.error('uso: signatures-guide.js --write | --check'); return 2; }
  const texto = fs.readFileSync(GUIA, 'utf8');
  const nuevo = render(texto);
  if (modo === '--write') { if (nuevo !== texto) fs.writeFileSync(GUIA, nuevo); console.log('signatures-guide: tablas al día'); return 0; }
  if (nuevo === texto) { console.log('signatures-guide: la guía es la del catálogo'); return 0; }
  console.error('signatures-guide: la guía no es la que sale del catálogo: correr node scripts/tools/signatures-guide.js --write');
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { render, RETIRADA };
