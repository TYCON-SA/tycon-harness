#!/usr/bin/env node
// AC 14 · la serie es RETROACTIVA: llega meses atrás, hasta donde llega la historia del repo.
// No se compara contra un mes fijo: el repo empieza cuando empieza, y lo que la story promete
// es que la serie NO arranca el día de la corrida.
'use strict';
process.env.TYCON_SKILLS_DIR = process.env.TYCON_SKILLS_DIR
  || `${process.env.HOME}/.claude/agent-skills/skills`;
const fs = require('fs'); const path = require('path'); const cp = require('child_process');
const [medidor, repo] = process.argv.slice(2);
const M = require(medidor);

const stories = [];
(function walk(dir, prof = 0) {
  if (prof > 6) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.advisors'].includes(e.name)) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, prof + 1);
    else if (e.name.endsWith('.md')) {
      const fm = M.readFrontmatter(f);
      if (fm && fm.id) stories.push({ file: f, id: fm.id });
    }
  }
}(repo));

const r = M.derivarTransiciones(repo, stories, {});
const fechas = Object.values(r.transiciones).flat().map((t) => t.fecha).sort();
if (!fechas.length) { console.error('🛑 sin transiciones: la serie no se derivó'); process.exit(1); }

const primerCommit = cp.execSync(`git -C ${JSON.stringify(repo)} log --reverse --format=%aI`)
  .toString().split('\n')[0];
const meses = (Date.now() - Date.parse(fechas[0])) / (86400000 * 30.4);
const porMes = {};
for (const f of fechas) porMes[f.slice(0, 7)] = (porMes[f.slice(0, 7)] || 0) + 1;

console.log(`${fechas.length} transiciones · más vieja ${fechas[0].slice(0, 10)} `
  + `(${meses.toFixed(1)} meses atrás) · primer commit del repo ${primerCommit.slice(0, 10)}`);
console.log(`por mes: ${JSON.stringify(porMes)}`);
if (meses < 2) { console.error(`🛑 la serie NO es retroactiva: arranca hace ${meses.toFixed(1)} meses`); process.exit(1); }
if (Object.keys(porMes).length < 2) { console.error('🛑 la serie cubre un solo mes: no hay historia'); process.exit(1); }
