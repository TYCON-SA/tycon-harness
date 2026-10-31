#!/usr/bin/env node
'use strict';
/**
 * controls-table.js — la tabla de los controles de esta máquina, armada con los registros que ya existen.
 *
 * Por cada freno y regla: cuántas veces frenó, cuántas avisó, cuántas pasó con firma (un escape autorizado) y cuántas
 * dejó pasar. Las falsas alarmas conocidas salen «no medido»: ningún registro dice todavía cuál freno se equivocó. Por
 * cada firma: cuántas se dieron y por qué vía, y cuántas fueron delegadas.
 *
 * Lee `frenos.jsonl` (scripts/lib/guard-record.js) y `signatures.jsonl` (scripts/lib/signature-log.js) de la carpeta
 * de estado. Un registro que no está sale «no medido», nunca cero: no haberlo medido no es no haber frenado. Los
 * renglones que no se pueden leer se cuentan aparte.
 *
 * Sólo lee: no escribe en la carpeta de estado ni en el tablero. La tabla va a un archivo `.md` (`--out`) o a la salida.
 *
 * Uso: node scripts/metrics/controls-table.js [--out <archivo.md>] [--since <AAAA-MM-DD>] [--home <dir>] [--json]
 * Sale 0 si armó la tabla; 2 si no pudo escribir `--out` o un argumento no se entiende.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDirOf = (home) => require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js')).stateDir(home);

const VEREDICTOS = ['bloqueo', 'aviso', 'escape', 'paso'];
const NO_MEDIDO = 'no medido';

/** Los renglones de un registro: `{ estado: 'ok' | 'ausente' | 'ilegible', filas, malas, motivo? }`. */
function leerRegistro(file, desde) {
  let texto;
  try { texto = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { estado: 'ausente', filas: [], malas: 0 } : { estado: 'ilegible', filas: [], malas: 0, motivo: e.code || e.message };
  }
  const filas = [];
  let malas = 0;
  let sinFecha = 0;
  for (const l of texto.split('\n')) {
    if (!l.trim()) continue;
    let r;
    try { r = JSON.parse(l); } catch (_) { malas++; continue; }
    if (!r || typeof r !== 'object' || Array.isArray(r)) { malas++; continue; }
    // con --since, un renglón sin fecha no se sabe de cuándo es: no entra, y se cuenta aparte
    if (desde && typeof r.ts !== 'string') { sinFecha++; continue; }
    if (desde && r.ts < desde) continue;
    filas.push(r);
  }
  return { estado: 'ok', filas, malas, sinFecha };
}

/** Los conteos por freno y regla, y por firma. */
function contar({ frenos, firmas }) {
  const porControl = new Map();
  for (const f of frenos.filas) {
    const clave = `${f.freno || 'sin freno'}\u0000${f.regla || 'sin regla'}`;
    if (!porControl.has(clave)) porControl.set(clave, { freno: f.freno || 'sin freno', regla: f.regla || 'sin regla', bloqueo: 0, aviso: 0, escape: 0, paso: 0, otro: 0 });
    const c = porControl.get(clave);
    if (VEREDICTOS.includes(f.veredicto)) c[f.veredicto]++; else c.otro++;
  }
  const porFirma = new Map();
  for (const s of firmas.filas) {
    const id = s.signature || 'sin id';
    if (!porFirma.has(id)) porFirma.set(id, { firma: id, total: 0, delegadas: 0, vias: {} });
    const c = porFirma.get(id);
    c.total++;
    if (s.delegated === true) c.delegadas++;
    const via = s.via || 'sin vía';
    c.vias[via] = (c.vias[via] || 0) + 1;
  }
  const orden = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    controles: [...porControl.values()].sort((a, b) => orden(a.freno, b.freno) || orden(a.regla, b.regla)),
    firmas: [...porFirma.values()].sort((a, b) => orden(a.firma, b.firma)),
  };
}

function estadoDe(r, nombre) {
  if (r.estado === 'ausente') return `${NO_MEDIDO} (no hay ${nombre})`;
  if (r.estado === 'ilegible') return `${NO_MEDIDO} (no se pudo leer ${nombre}: ${r.motivo})`;
  return `${r.filas.length} renglón(es)${r.malas ? `, ${r.malas} ilegible(s)` : ''}${r.sinFecha ? `, ${r.sinFecha} sin fecha (fuera del período)` : ''}`;
}

/** La tabla en markdown. */
function markdown({ frenos, firmas, conteo, desde, ahora }) {
  const l = ['# Tabla de controles', '', `Armada el ${ahora} con los registros de esta máquina${desde ? `, desde el ${desde}` : ''}. Sólo lee.`, '',
    `- Frenos (frenos.jsonl): ${estadoDe(frenos, 'frenos.jsonl')}`, `- Firmas (signatures.jsonl): ${estadoDe(firmas, 'signatures.jsonl')}`, '',
    '## Frenos', ''];
  if (frenos.estado !== 'ok') l.push(`${NO_MEDIDO}: ${estadoDe(frenos, 'frenos.jsonl')}.`);
  else if (!conteo.controles.length) l.push('Ningún freno anotó una decisión en el período.');
  else {
    l.push('| Freno | Regla | Frenó | Avisó | Pasó con firma | Dejó pasar | Falsas alarmas conocidas |', '|---|---|---:|---:|---:|---:|---|');
    for (const c of conteo.controles) l.push(`| ${c.freno} | ${c.regla} | ${c.bloqueo} | ${c.aviso} | ${c.escape} | ${c.paso} | ${NO_MEDIDO} |`);
    const otros = conteo.controles.reduce((n, c) => n + c.otro, 0);
    if (otros) l.push('', `${otros} renglón(es) con un veredicto que no es ninguno de ${VEREDICTOS.join(', ')}.`);
  }
  l.push('', '## Firmas', '');
  if (firmas.estado !== 'ok') l.push(`${NO_MEDIDO}: ${estadoDe(firmas, 'signatures.jsonl')}.`);
  else if (!conteo.firmas.length) l.push('No se dio ninguna firma en el período.');
  else {
    l.push('| Firma | Total | Delegadas | Por vía |', '|---|---:|---:|---|');
    for (const f of conteo.firmas) l.push(`| ${f.firma} | ${f.total} | ${f.delegadas} | ${Object.entries(f.vias).sort().map(([v, n]) => `${v}: ${n}`).join(', ')} |`);
  }
  return `${l.join('\n')}\n`;
}

function tabla({ home = os.homedir(), desde = null, ahora = new Date().toISOString() } = {}) {
  const dir = stateDirOf(home);
  const frenos = leerRegistro(path.join(dir, 'frenos.jsonl'), desde);
  const firmas = leerRegistro(path.join(dir, 'signatures.jsonl'), desde);
  const conteo = contar({ frenos, firmas });
  return { frenos, firmas, conteo, md: markdown({ frenos, firmas, conteo, desde, ahora }) };
}

module.exports = { leerRegistro, contar, markdown, tabla };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const valor = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const no = (m) => { process.stderr.write(`controls-table: ${m}\n`); process.exit(2); };
  for (const f of ['--out', '--since', '--home']) if (argv.includes(f) && !valor(f)) no(`${f} va con un valor`);
  const desde = valor('--since') || null;
  if (desde && !/^\d{4}-\d\d-\d\d/.test(desde)) no('--since va con una fecha AAAA-MM-DD');
  const t = tabla({ home: valor('--home') || os.homedir(), desde });
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ frenos: { estado: t.frenos.estado, malas: t.frenos.malas }, firmas: { estado: t.firmas.estado, malas: t.firmas.malas }, ...t.conteo }, null, 2)}\n`);
  }
  const out = valor('--out');
  if (out) {
    try { fs.writeFileSync(out, t.md); } catch (e) { no(`no pude escribir ${out} (${e.code || e.message})`); }
    process.stderr.write(`controls-table: la tabla quedó en ${out}\n`);
  } else if (!argv.includes('--json')) process.stdout.write(t.md);
}
