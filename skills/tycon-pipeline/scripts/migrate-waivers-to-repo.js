#!/usr/bin/env node
'use strict';
/**
 * migrate-waivers-to-repo.js — mueve las aprobaciones humanas de waivers del log LOCAL del home
 * a un log firmado DENTRO de cada repo, re-ancladas a la DECLARACIÓN de cada AC.
 *
 * El problema que resuelve (2026-07-29, pedido DevA): los waivers vivían en
 * `~/.claude/.tycon-pipeline/runtime-waivers.jsonl`, anclados al `matrixHash`. Ese hash pinnea la
 * evidencia de `.advisors/`, que está gitignoreada — o sea que en otra máquina, o en CI, no existe,
 * el hash da distinto y la aprobación NO engancha. La consecuencia práctica: lo ÚNICO de toda la
 * cadena que una máquina no puede recomputar —el criterio del humano— era lo único que no viajaba,
 * y había que rehacerlo a mano en cada máquina.
 *
 * Qué hace: por cada entry del log local, ubica la story en los repos que se le pasen, lee su
 * `runtime_not_verifiable`, computa el hash de la declaración de cada AC aprobado, y re-firma la
 * aprobación en `<repo>/.tycon/runtime-waivers.jsonl` (commiteable) preservando fecha y aprobador.
 *
 * NO borra el log local: queda como respaldo y como fuente legacy para lo que no se pueda migrar.
 *
 * Uso:
 *   node migrate-waivers-to-repo.js --repos <dir> [<dir> ...]          # dry-run (default)
 *   node migrate-waivers-to-repo.js --repos <dir> [...] --apply        # escribe — lo corre EL DEV, en su terminal
 *
 * 🔴 `--apply` pide la terminal del dev (2026-10-07, hallazgo de la revisión adversarial de la story 7.17). Migrar
 * vuelve a firmar cada aprobación contra el texto ACTUAL de la declaración del AC. Sin candado lo podía correr el
 * agente: reescribir la razón de un AC y migrar daba una firma válida para una razón que ningún humano aprobó — la
 * vía cómoda que `lib/runtime-waiver.js` existe para cerrar. Ahora escribe sólo si hay `/dev/tty` y el dev confirma
 * ahí lo que se va a firmar. El dry-run sigue libre: no escribe nada.
 */
const fs = require('fs');
const path = require('path');
const waiver = require(path.join(__dirname, 'lib', 'runtime-waiver.js'));

// --- indexar todas las stories de los repos por storyId -------------------------------------
function walk(dir, out, depth = 0) {
  if (depth > 8) return out;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}
// 🔴 El destino NO es la carpeta que se pasó por `--repos`: es el repo GIT que contiene a la story.
// `~/Proyectos/Ceibo` y `~/Proyectos/Pacara` son CONTENEDORES con varios repos adentro
// (CeiboProject, CeiboBackend, BackEnd, FrontEnd…). Escribir el `.tycon/` en el contenedor lo deja
// fuera de todo repo → no se commitea → no viaja, que es exactamente lo que esta migración viene a
// arreglar. Se sube desde el archivo de la story hasta el primer `.git`.
function gitRootDe(file) {
  let dir = path.dirname(path.resolve(file));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function frontmatterOf(txt) {
  if (!txt.startsWith('---')) return null;
  const end = txt.indexOf('\n---', 3);
  return end === -1 ? null : txt.slice(4, end);
}
function storyIdOf(fm) {
  const m = fm.match(/^story:\s*["']?([\d.]+)["']?\s*$/m);
  return m ? m[1] : null;
}
// Mismo parser que runtime-matrix.js (una sola verdad sería mejor, pero ese módulo no lo exporta;
// si divergen, el que manda es el de la matriz — este script sólo migra).
function parseNotVerifiable(fm) {
  const out = [];
  const lines = fm.split('\n');
  let i = lines.findIndex((l) => /^runtime_not_verifiable:\s*$/.test(l));
  if (i === -1) return out;
  const strip = (s) => s.replace(/^["']|["']$/g, '').trim();
  let cur = null;
  for (i++; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    const acM = line.match(/^\s*-\s*ac:\s*(\d+)/);
    if (acM) { if (cur) out.push(cur); cur = { ac: parseInt(acM[1], 10), reason: null, coveredBy: null }; continue; }
    if (!cur) continue;
    const rM = line.match(/^\s*reason:\s*(.+?)\s*$/);
    if (rM) { cur.reason = strip(rM[1]); continue; }
    const cM = line.match(/^\s*covered_by:\s*(.+?)\s*$/);
    if (cM) { cur.coveredBy = strip(cM[1]); continue; }
  }
  if (cur) out.push(cur);
  return out;
}

/** Arma el plan de migración (sin escribir nada): qué aprobaciones van a qué repo, y qué no se puede migrar. */
function armarPlan(repos) {
  // 🔴 Los ids de story CHOCAN entre repos (hay una `1.1` en Ceibo y otra en un repo del equipo). Por eso
  // el índice guarda TODOS los candidatos por id y la elección se hace después, mirando cuál declara
  // los ACs que se están migrando. Quedarse con el primero mandaba la aprobación al repo equivocado
  // — o, como pasó en el dry-run, la descartaba con un "no lo declara" que era del otro repo.
  const index = new Map(); // storyId -> [{ repo, file, decls }]
  for (const repo of repos) {
    for (const f of walk(repo, [])) {
      let txt;
      try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
      const fm = frontmatterOf(txt);
      if (!fm) continue;
      const sid = storyIdOf(fm);
      if (!sid) continue;
      const arr = index.get(sid) || [];
      arr.push({ repo, file: f, decls: parseNotVerifiable(fm) });
      index.set(sid, arr);
    }
  }

  // De los candidatos con ese id, gana el que declara MÁS de los ACs aprobados (y, a igualdad, el
  // que declara alguno). Si ninguno declara ninguno, devuelve el primero para poder reportar por qué.
  function elegirCandidato(sid, acs) {
    const cands = index.get(String(sid)) || [];
    if (cands.length === 0) return null;
    let mejor = cands[0];
    let mejorN = -1;
    for (const c of cands) {
      const declBy = new Set(c.decls.map((d) => d.ac));
      const n = acs.filter((a) => declBy.has(a)).length;
      if (n > mejorN) { mejor = c; mejorN = n; }
    }
    return mejor;
  }

  // --- recorrer el log local y re-anclar ---------------------------------------------------------
  const { entries, ok, discarded } = waiver.verifyChain();

  const plan = new Map(); // repo -> [entry...]
  const problemas = [];
  for (const e of entries) {
    const hit = elegirCandidato(e.story, e.acs);
    if (!hit) { problemas.push({ story: e.story, acs: e.acs, motivo: 'no encontré la story en los repos dados' }); continue; }
    const declByAc = new Map(hit.decls.map((d) => [d.ac, d]));
    const declHashByAc = {};
    const sinDecl = [];
    for (const n of e.acs) {
      const d = declByAc.get(n);
      if (!d) { sinDecl.push(n); continue; }
      declHashByAc[n] = waiver.declHashFor(d.reason, d.coveredBy);
    }
    if (Object.keys(declHashByAc).length === 0) {
      problemas.push({ story: e.story, acs: e.acs, motivo: `la story no declara runtime_not_verifiable para esos ACs (${sinDecl.join(',')})` });
      continue;
    }
    if (sinDecl.length) problemas.push({ story: e.story, acs: sinDecl, motivo: 'estos ACs no están declarados — quedan SIN migrar (siguen sólo en el log local)' });
    const destinoRepo = gitRootDe(hit.file);
    if (!destinoRepo) { problemas.push({ story: e.story, acs: e.acs, motivo: `la story no está dentro de ningún repo git (${hit.file})` }); continue; }
    const arr = plan.get(destinoRepo) || [];
    arr.push({
      story: String(e.story),
      acs: Object.keys(declHashByAc).map(Number).sort((a, b) => a - b),
      matrixHash: e.matrixHash,
      approvedBy: e.approvedBy,
      nowIso: e.ts,
      declHashByAc,
      migratedFrom: 'home-log-2026-07-29',
      file: path.relative(destinoRepo, hit.file),
    });
    plan.set(destinoRepo, arr);
  }
  return { plan, problemas, ok, discarded };
}

/** Escribe el plan en el registro de cada repo. Sólo se llama DESPUÉS de la confirmación del dev en su terminal. */
function escribirPlan(plan) {
  let escritas = 0;
  for (const [repo, arr] of plan) {
    const logPath = waiver.repoWaiverLogPath(repo);
    // Sólo las VÁLIDAS del destino (story 7.17): una migración que quedó descartada no está hecha, se vuelve a escribir.
    const yaHay = new Set();
    for (const p of waiver.verifyChain(logPath).entries) yaHay.add(`${p.story}|${(p.acs || []).join(',')}|${p.ts}`);
    for (const a of arr) {
      if (yaHay.has(`${a.story}|${a.acs.join(',')}|${a.nowIso}`)) continue; // idempotente
      waiver.appendWaiver({ ...a, logPath });
      escritas++;
    }
  }
  return escritas;
}

function main(argv) {
  const apply = argv.includes('--apply');
  const repos = [];
  const i = argv.indexOf('--repos');
  if (i !== -1) {
    for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) repos.push(path.resolve(argv[j]));
  }
  if (repos.length === 0) {
    console.error('uso: migrate-waivers-to-repo.js --repos <dir> [<dir> ...] [--apply]');
    process.exit(2);
  }

  const { plan, problemas, ok, discarded } = armarPlan(repos);
  // Story 7.17: la cadena se lee como árbol — una línea descartada no arrastra a las que vienen después.
  if (!ok) console.error(`⚠️  el log local tiene ${discarded.length} línea(s) descartada(s) por la cadena (${discarded.map((d) => d.line).join(', ')}): migro las válidas, ésas no.`);

  let migradas = 0;
  for (const [repo, arr] of plan) {
    console.log(`\n📁 ${repo}  → .tycon/runtime-waivers.jsonl  (${arr.length} aprobaciones)`);
    for (const a of arr) console.log(`   story ${a.story}  ACs ${a.acs.join(',')}  · ${a.nowIso.slice(0, 10)} · ${a.file}`);
    migradas += arr.length;
  }
  if (problemas.length) {
    console.log(`\n⚠️  ${problemas.length} caso(s) que NO se migran:`);
    for (const p of problemas) console.log(`   story ${p.story} ACs ${(p.acs || []).join(',')} — ${p.motivo}`);
  }

  if (!apply) {
    console.log(`\nA MIGRAR (dry-run): ${migradas} aprobaciones en ${plan.size} repo(s).`);
    console.log('Para escribir, corrélo VOS en tu terminal con --apply (pide confirmación ahí).');
    return;
  }

  // 🔴 Windows (decisión del dueño, 2026-10-15): no hay /dev/tty; firma sólo una ventana de consola NUEVA que abre este
  //    mismo comando (lib/runtime-waiver.js, «WINDOWS»). Fuera de esa ventana, se abre y se espera.
  if (waiver.esWindows() && process.env[waiver.MARCA_VENTANA] !== '1') {
    console.error(`\n🪟 Abro una ventana nueva, «Firma de la migración»: seguí ahí. Tenés ${Math.round(waiver.topeVentanaS() / 60)} minutos.`);
    const v = waiver.abrirVentana({ script: __filename, args: argv, titulo: 'Firma de la migración' });
    if (v.estado === 'vencida') { console.error(`🔒 la ventana venció a los ${v.tope} s sin firmar — no se escribió nada.`); process.exit(3); }
    if (v.estado === 'no-abrio') { console.error(`🔒 no pude abrir la ventana de la firma (${v.motivo}) — no se escribió nada.`); process.exit(3); }
    process.exit(v.codigo === 0 ? 0 : (v.codigo || 1));
  }
  if (waiver.esWindows()) {
    waiver.anotarVentana();
    process.on('exit', () => waiver.pausaFinal());
  }

  // 🔴 El candado: escribir es firmar, y firmar es del dev. Sin terminal no se escribe nada.
  if (!waiver.hasTty()) {
    console.error('\n🔒 migrate-waivers-to-repo.js --apply BLOQUEADO — requiere una terminal interactiva real (/dev/tty).');
    console.error('   Migrar vuelve a firmar cada aprobación contra el texto actual de su AC: lo corre EL DEV, en su terminal.');
    console.error(`     node ${__filename} --repos ${repos.join(' ')} --apply`);
    process.exit(3);
  }
  const respuesta = waiver.promptTty(`\nSe van a firmar ${migradas} aprobaciones en ${plan.size} repo(s), contra el texto ACTUAL de cada AC.\nEscribí MIGRAR para confirmar: `);
  if (respuesta !== 'MIGRAR') {
    console.error('\nmigrate-waivers-to-repo.js: no confirmaste — no se escribió nada.');
    process.exit(1);
  }
  if (waiver.esWindows() && !waiver.confirmarFrase()) {
    console.error('\nmigrate-waivers-to-repo.js: la frase no coincide — no se escribió nada.');
    process.exit(1);
  }
  const escritas = escribirPlan(plan);
  console.log(`\nMIGRADAS: ${escritas} aprobaciones escritas (${migradas - escritas} ya estaban) en ${plan.size} repo(s).`);
  console.log('🔴 Commiteá los `.tycon/runtime-waivers.jsonl` — sin eso, no viajan.');
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { armarPlan, escribirPlan };
