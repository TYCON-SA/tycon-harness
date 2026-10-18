#!/usr/bin/env node
'use strict';
/**
 * incident-cases.js — cada incidente del registro dice qué revisor debió verlo y cuál es su caso en el banco.
 * Casos: scripts/tests/incident-cases.test.js.
 *
 * POR QUÉ EXISTE. Un incidente que un revisor dejó pasar y no quedó como caso de su examen puede volver sin que nadie
 * lo note. El registro lleva, bajo cada `### ` de incidente, un renglón:
 *   **Revisor:** <revisor> · **caso:** <id>          el caso está en `<dir>/<revisor>.json`
 *   **Revisor:** ninguno — <motivo>                  ningún revisor podía verlo
 * Una sección (`## `) puede declarar una vez, antes de su primer incidente, `**Revisores:** ninguno — <motivo>`: cubre a
 * los incidentes de esa sección que no traen renglón propio. El renglón propio manda.
 *
 * Uso:  node scripts/controls-bench/incident-cases.js --log <registro.md> --cases <dir> [--cases <dir>…] [--debts <tasks/todo.md>] [--json]
 * Exit: 0 todo en orden · 1 hay incidentes sin revisor, sin motivo o sin su caso · 2 uso incorrecto o registro ilegible
 */

const fs = require('fs');
const path = require('path');

const NONE = /^ninguno\b/i;

/** El motivo de un «ninguno»: lo que sigue a la palabra, sin separadores. */
function reasonOf(rest) {
  return rest.replace(NONE, '').replace(/^[\s—–:-]+/, '').trim();
}

/** Recorre el registro (las secciones se identifican por la línea de su `## `): `{ incidents: [{ id, section, line, revisor?, caso?, none?, reason?, ownLine }], sections }`. */
function parseLog(text) {
  const incidents = [];
  const sections = new Map();
  let section = null;
  let current = null;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (/^## /.test(line)) {
      section = { title: line.slice(3).trim(), decl: null };
      sections.set(i + 1, section);
      current = null;
      return;
    }
    const head = /^### (.*)/.exec(line);
    if (head) {
      const id = (/`([^`]+)`/.exec(head[1]) || [])[1] || head[1].trim();
      current = { id, section: section ? [...sections.keys()].pop() : null, line: i + 1, ownLine: false };
      incidents.push(current);
      return;
    }
    const decl = /\*\*Revisores:\*\*\s*(.*)/.exec(line);
    if (decl && section && !current && !section.decl) {
      section.decl = { none: NONE.test(decl[1].trim()), reason: reasonOf(decl[1].trim()) };
      return;
    }
    const own = /\*\*Revisor:\*\*\s*(.*)/.exec(line);
    // un incidente puede nombrar más de un revisor: cada renglón se valida por su cuenta
    if (own && current) {
      current.ownLine = true;
      const rest = own[1].trim();
      const entry = {};
      if (NONE.test(rest)) { entry.none = true; entry.reason = reasonOf(rest); }
      else {
        entry.revisor = (/^[^\s·]+/.exec(rest) || [''])[0];
        entry.caso = (/\*\*caso:\*\*\s*(\S+)/.exec(rest) || [])[1];
        // `**caso:** pendiente — DEF-<id>`: el caso todavía no está y la deuda lo dice
        if (entry.caso === 'pendiente') entry.debt = (/pendiente\s*[—-]+\s*(DEF-[\w.-]+)/.exec(rest) || [])[1] || null;
      }
      (current.entries = current.entries || []).push(entry);
    }
  });
  return { incidents, sections };
}

/** Los ids de caso de un revisor: la unión de sus archivos en todos los directorios; `null` si no tiene ninguno. */
function caseIds(dirs, revisor) {
  let ids = null;
  for (const dir of dirs) {
    const file = path.join(dir, `${revisor}.json`);
    if (!fs.existsSync(file)) continue;
    try {
      ids = ids || new Set();
      for (const c of (JSON.parse(fs.readFileSync(file, 'utf8')).cases) || []) ids.add(c.id);
    } catch (e) { return { error: `${file} no se puede leer (${e.message})` }; }
  }
  return ids;
}

/** ¿La deuda está ABIERTA en la lista de pendientes (`- [ ] [DEF-…]`)? Una cerrada ya no excusa la falta del caso. */
function openDebt(todoText, id) {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*- \\[ \\] \\[${esc}\\]`, 'm').test(todoText);
}

function check(text, dirs, todoText = null) {
  const { incidents, sections } = parseLog(text);
  const findings = [];
  let pending = 0;
  for (const s of sections.values()) {
    if (s.decl && s.decl.none && !s.decl.reason) findings.push(`sección «${s.title}»: «ninguno» sin motivo.`);
  }
  const cache = new Map();
  let withCase = 0;
  let none = 0;
  for (const inc of incidents) {
    const name = `\`${inc.id}\``;
    if (!inc.ownLine) {
      const decl = (sections.get(inc.section) || {}).decl;
      if (!decl) findings.push(`${name}: no dice qué revisor lo debió ver ni «ninguno» con su motivo.`);
      else if (!decl.none) findings.push(`${name}: la sección «${(sections.get(inc.section) || {}).title}» sólo puede declarar «ninguno» con su motivo; un revisor va en el renglón propio de cada incidente.`);
      else if (decl.reason) none += 1;
      continue;
    }
    // el incidente cuenta en la clase de su primer renglón; todos los renglones se validan
    let kind = null;
    for (const e of inc.entries) {
      let k = null;
      if (e.none) {
        if (!e.reason) findings.push(`${name}: «ninguno» sin motivo.`);
        else k = 'none';
      } else if (!e.revisor || !e.caso) {
        findings.push(`${name}: el renglón no dice el revisor y el caso (\`**Revisor:** <revisor> · **caso:** <id>\`).`);
      } else if (e.caso === 'pendiente') {
        if (!e.debt) findings.push(`${name}: «pendiente» sin su deuda (\`**caso:** pendiente — DEF-<id>\`).`);
        else if (todoText === null) findings.push(`${name}: «pendiente — ${e.debt}» y no me pasaron la lista de pendientes (--debts): no puedo saber si la deuda existe.`);
        else if (!openDebt(todoText, e.debt)) findings.push(`${name}: la deuda ${e.debt} no está abierta en la lista de pendientes.`);
        else k = 'pending';
      } else {
        if (!cache.has(e.revisor)) cache.set(e.revisor, caseIds(dirs, e.revisor));
        const ids = cache.get(e.revisor);
        if (ids === null) findings.push(`${name}: el revisor ${e.revisor} no tiene archivo de casos.`);
        else if (ids.error) findings.push(`${name}: ${ids.error}.`);
        else if (!ids.has(e.caso)) findings.push(`${name}: el caso ${e.caso} no está en los casos de ${e.revisor}.`);
        else k = 'case';
      }
      if (kind === null) kind = k || 'bad';
    }
    if (kind === 'case') withCase += 1;
    else if (kind === 'pending') pending += 1;
    else if (kind === 'none') none += 1;
  }
  return { total: incidents.length, withCase, none, pending, findings };
}

function main(argv) {
  const values = (n) => argv.flatMap((a, i) => (a === n && argv[i + 1] ? [argv[i + 1]] : []));
  const log = values('--log')[0];
  const dirs = values('--cases').map((d) => path.resolve(d));
  if (!log || !dirs.length) { console.error('uso: incident-cases.js --log <registro.md> --cases <dir> [--cases <dir>…] [--debts <tasks/todo.md>] [--json]'); return 2; }
  let text;
  try { text = fs.readFileSync(log, 'utf8'); } catch (e) { console.error(`no puedo leer el registro: ${e.message}`); return 2; }
  const todoFile = values('--debts')[0];
  let todoText = null;
  if (todoFile) { try { todoText = fs.readFileSync(todoFile, 'utf8'); } catch (e) { console.error(`no puedo leer la lista de pendientes: ${e.message}`); return 2; } }
  const r = check(text, dirs, todoText);
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return r.findings.length ? 1 : 0; }
  for (const f of r.findings) console.error(`  ${f}`);
  const summary = `${r.total} incidente(s): ${r.withCase} con su caso, ${r.pending} pendiente(s) con su deuda, ${r.none} sin revisor por motivo, ${r.findings.length} por resolver.`;
  if (r.findings.length) { console.error(summary); return 1; }
  console.log(summary);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { parseLog, check };
