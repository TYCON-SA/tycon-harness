#!/usr/bin/env node
'use strict';
// office-board-real.smoke.js — el tablero real de esta máquina, numerado sobre una copia: board.js lo guarda, cada fila
// recibe su número y la oficina las muestra todas. Nunca toca el tablero real: lo copia a una carpeta de juguete.
//
//   node scripts/tests/office-board-real.smoke.js [--board <tablero.json>]
//
// El primer guardado puede no escribir: filas escritas a mano con `estimadaIso`, o hechas sin `realIso`. Se corrigen en la
// copia como lo haría la coordinadora en su archivo aparte (la hora estimada pasa a `pronosticoIso`; una hecha sin hora
// toma la del tablero) y se guarda otra vez. Imprime sólo números: ni títulos ni personas.
// Sale 0 si todas quedaron numeradas y ninguna se perdió; 1 si no; 2 si no hay tablero que copiar.
// stable-data: lee el tablero de la máquina tal como está; no compara fechas.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const board = require(path.join(ROOT, 'scripts', 'tools', 'office', 'board.js'));
const office = require(path.join(ROOT, 'scripts', 'tools', 'office.js'));
const { stateDir } = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js'));

const i = process.argv.indexOf('--board');
const source = i > 0 ? process.argv[i + 1] : path.join(stateDir(os.homedir()), 'coordination', 'tablero.json');
let raw;
try { raw = JSON.parse(fs.readFileSync(source, 'utf8')); } catch (e) { console.error(`no hay tablero que copiar (${e.code || e.message})`); process.exit(2); }

const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablero-real-'));
fs.mkdirSync(path.join(sdir, 'coordination'));
const rows = Array.isArray(raw.pendientes) ? raw.pendientes.filter((r) => r && typeof r === 'object' && typeof r.titulo === 'string' && r.titulo.trim()) : [];
console.log(`antes: ${rows.length} filas, ${rows.filter((r) => r.id).length} con número`);

const first = board.save(sdir, raw, { home: sdir, live: [] });
const broken = first.code === 0 ? 0 : first.lines.filter((l) => l.startsWith('   · ')).length;
console.log(`primer guardado: ${first.code === 0 ? 'escribió' : `no escribió (${broken} reglas rotas)`}`);

// lo que la coordinadora corrige en su archivo aparte
const fixedAt = typeof (raw.meta && raw.meta.actualizado) === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(raw.meta.actualizado) ? raw.meta.actualizado.slice(0, 16) : null;
let fixed = 0;
const pendientes = (raw.pendientes || []).map((r) => {
  if (!r || typeof r !== 'object') return r;
  const c = { ...r };
  if (c.estimadaIso != null) { if (c.pronosticoIso == null) c.pronosticoIso = c.estimadaIso; delete c.estimadaIso; fixed += 1; }
  if (c.estado === 'hecho' && !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(String(c.realIso || ''))) { c.realIso = String(c.realIso || '').slice(0, 16) || fixedAt || '2026-01-01T00:00'; fixed += 1; }
  return c;
});
const second = first.code === 0 ? first : board.save(sdir, { ...raw, pendientes }, { home: sdir, live: [] });
if (first.code !== 0) console.log(`corregidas: ${fixed} · segundo guardado: ${second.code === 0 ? 'escribió' : 'no escribió'}`);
if (second.code !== 0) { console.log(second.lines.filter((l) => !l.startsWith('   · ')).join('\n')); process.exit(1); }

const after = JSON.parse(fs.readFileSync(path.join(sdir, 'coordination', 'tablero.json'), 'utf8')).pendientes.filter((r) => r && typeof r.titulo === 'string' && r.titulo.trim());
const ids = after.map((r) => r.id);
const numbered = ids.every((id) => board.ID.test(String(id))) && new Set(ids).size === ids.length;
console.log(`después: ${after.length} filas, ${ids.filter(Boolean).length} con número, ${new Set(ids).size} distintos`);

// la oficina sobre la copia: cada número está en una tarjeta del kanban o en lo terminado de otros días
const { data } = office.buildOffice({ wip: { rows: [], details: [], extra: [], free: [], halfway: [], unreadable: [] }, board: office.buildBoard({ ...raw, pendientes: after }), nowMs: Date.now() });
const shown = new Set([...data.kanban.columnas.flatMap((c) => c.tarjetas), ...(data.kanban.anteriores || [])].map((c) => c.numero));
const lost = ids.filter((id) => !shown.has(id));
console.log(`en la oficina: ${ids.length - lost.length} de ${ids.length}${lost.length ? ` · faltan ${lost.length}` : ''}`);

const ok = after.length === rows.length && numbered && lost.length === 0;
console.log(ok ? 'E4: OK — todas numeradas, ninguna perdida' : 'E4: FALLA');
process.exit(ok ? 0 : 1);
