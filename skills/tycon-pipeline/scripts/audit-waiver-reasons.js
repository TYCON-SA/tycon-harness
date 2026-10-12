#!/usr/bin/env node
'use strict';
/**
 * audit-waiver-reasons.js — lista, por cada AC waiveado, la RAZÓN declarada de por qué no se
 * puede verificar corriendo la app. Sirve para revisar a mano si alguna aprobación tapó algo que
 * en realidad SÍ era ejecutable (que es el único abuso que el mecanismo no puede detectar solo).
 *
 * Uso: node audit-waiver-reasons.js --repos <dir> [<dir> ...]
 */
const fs = require('fs');
const path = require('path');
const waiver = require(path.join(__dirname, 'lib', 'runtime-waiver.js'));

const argv = process.argv.slice(2);
const repos = [];
{
  const i = argv.indexOf('--repos');
  if (i !== -1) for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) repos.push(path.resolve(argv[j]));
}
if (!repos.length) { console.error('uso: --repos <dir> [...]'); process.exit(2); }

function walk(dir, out, d = 0) {
  if (d > 8) return out;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, d + 1); else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}
const fmOf = (t) => (t.startsWith('---') && t.indexOf('\n---', 3) !== -1 ? t.slice(4, t.indexOf('\n---', 3)) : null);
function parseNV(fm) {
  const out = []; const lines = fm.split('\n');
  let i = lines.findIndex((l) => /^runtime_not_verifiable:\s*$/.test(l));
  if (i === -1) return out;
  const strip = (s) => s.replace(/^["']|["']$/g, '').trim();
  let cur = null;
  for (i++; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l)) break;
    const a = l.match(/^\s*-\s*ac:\s*(\d+)/);
    if (a) { if (cur) out.push(cur); cur = { ac: +a[1], reason: '', coveredBy: '' }; continue; }
    if (!cur) continue;
    const r = l.match(/^\s*reason:\s*(.+?)\s*$/); if (r) { cur.reason = strip(r[1]); continue; }
    const c = l.match(/^\s*covered_by:\s*(.+?)\s*$/); if (c) { cur.coveredBy = strip(c[1]); continue; }
  }
  if (cur) out.push(cur);
  return out;
}

const idx = new Map();
for (const repo of repos) for (const f of walk(repo, [])) {
  let t; try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const fm = fmOf(t); if (!fm) continue;
  const m = fm.match(/^story:\s*["']?([\d.]+)["']?\s*$/m); if (!m) continue;
  const arr = idx.get(m[1]) || []; arr.push({ file: f, decls: parseNV(fm) }); idx.set(m[1], arr);
}

// Señales de que una razón podría estar tapando algo AUTOMATIZABLE. No es un veredicto: es un
// filtro para leer primero lo que más huele. La decisión la toma una persona leyendo la razón.
const SOSPECHA = [
  [/flaky|intermitente|inestable/i, 'dice que es inestable — "difícil" no es "imposible"'],
  [/no (hay|tengo) (tiempo|forma f[aá]cil)|costoso|caro|lleva mucho/i, 'apela al costo, no a la imposibilidad'],
  [/manual|a mano|el usuario (lo )?prueba/i, 'delega la prueba a una persona'],
  [/e2e|playwright|navegador|browser/i, 'menciona una herramienta que SÍ podría correrlo'],
  [/ui|pantalla|visual|render/i, 'superficie de UI — suele ser automatizable con navegador'],
];
const rows = [];
for (const e of waiver.verifyChain().entries) {
  const cands = idx.get(String(e.story)) || [];
  let best = cands[0], bestN = -1;
  for (const c of cands) { const s = new Set(c.decls.map((d) => d.ac)); const n = e.acs.filter((a) => s.has(a)).length; if (n > bestN) { best = c; bestN = n; } }
  if (!best) continue;
  const byAc = new Map(best.decls.map((d) => [d.ac, d]));
  for (const ac of e.acs) {
    const d = byAc.get(ac); if (!d) continue;
    const flags = SOSPECHA.filter(([re]) => re.test(d.reason)).map(([, m]) => m);
    rows.push({ story: e.story, ac, reason: d.reason, coveredBy: d.coveredBy, flags, file: path.basename(best.file) });
  }
}
rows.sort((a, b) => (b.flags.length - a.flags.length) || String(a.story).localeCompare(String(b.story)));
const sos = rows.filter((r) => r.flags.length);
console.log(`# Auditoría de razones de waiver — ${rows.length} ACs aprobados\n`);
console.log(`Para revisar primero: ${sos.length}\n`);
for (const r of rows) {
  console.log(`## story ${r.story} · AC#${r.ac}${r.flags.length ? '  ⚠️' : ''}`);
  if (r.flags.length) console.log(`- señales: ${r.flags.join(' · ')}`);
  console.log(`- razón: ${r.reason}`);
  console.log(`- cubierto por: ${r.coveredBy}\n`);
}
