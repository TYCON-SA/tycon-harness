#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * ¿La lista de pendientes tiene un pendiente abierto sin aprobación?
 *
 * Abrir un pendiente lo decide la coordinadora (o la persona): un renglón `- [ ]` nuevo en `tasks/todo.md` sin su
 * aprobación firmada en `tasks/pending-approvals.jsonl` frena. La regla y el formato del registro están en
 * `scripts/lib/pending-approvals.js`.
 *
 * Uso:
 *   node scripts/ci/check-pending-approvals.js [--repo <carpeta>]            el árbol (la revisión de la noche)
 *   node scripts/ci/check-pending-approvals.js --staged [--repo <carpeta>]   lo que se va a commitear (el pre-commit)
 *
 * Con `--staged` lee la lista y el registro del índice, y las líneas que el commit agrega al registro tienen que tener
 * su renglón firmado en el registro del arnés de esta cuenta. Un repo sin lista no tiene nada que revisar.
 *
 * Sale 0 sin pendientes sin aprobar, 1 si hay alguno (los nombra, con el comando de la firma), 2 si no pudo leer lo que
 * necesita: un control que no leyó no es un verde.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PA = require('../lib/pending-approvals.js');

function opciones(argv) {
  const o = { repo: process.cwd(), staged: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--staged') o.staged = true;
    else if (argv[i] === '--repo') o.repo = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') o.ayuda = true;
    else throw new Error(`no conozco la opción ${argv[i]}`);
  }
  if (!o.repo) throw new Error('--repo necesita una carpeta');
  return o;
}

/** Un archivo de git (`:ruta` el índice, `HEAD:ruta` el último commit): su texto, o null si no está. */
function deGit(repo, ref) {
  try {
    return execFileSync('git', ['-C', repo, 'show', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const err = String((e && e.stderr) || '');
    // que no esté (en el índice o en el commit, o que no haya commits todavía) no es un error de lectura
    if (/does not exist|exists on disk, but not in|not in the index|invalid object name|bad revision|unknown revision/i.test(err)) return null;
    throw new Error(`git show ${ref}: ${err.trim().split('\n')[0] || (e && e.message)}`);
  }
}

function delDisco(repo, rel) {
  try { return fs.readFileSync(path.join(repo, rel), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new Error(`no pude leer ${rel} (${e.code || e.message})`);
  }
}

/** Los renglones de la firma en el registro del arnés de la cuenta (no el de `HOME`). */
function renglonesDeLaCuenta() {
  const { casaDeLaCuenta } = require('../lib/real-home.js');
  const { stateDir } = require('../../skills/tycon-pipeline/scripts/lib/state-dir.js');
  const f = path.join(stateDir(casaDeLaCuenta()), 'gates.log');
  try { return PA.renglonesDeFirma(fs.readFileSync(f, 'utf8')); } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw new Error(`no pude leer el registro del arnés (${e.code || e.message})`);
  }
}

/** Cómo se pide la aprobación de un código: la coordinadora desde su pestaña, o la persona. */
function comoSePide(codigo, repo) {
  const sesion = process.env.CLAUDE_CODE_SESSION_ID || process.env.TYCON_SESSION_ID || process.env.CODEX_SESSION_ID || null;
  const [delegado, terminal] = PA.comandos(codigo, repo, sesion);
  return [
    '   Abrir un pendiente lo decide la coordinadora. Pedile que lo apruebe desde su pestaña:',
    `     node <arnés>/skills/tycon-pipeline/scripts/${delegado}`,
    `   (uno por código; sin la coordinadora, la persona lo firma en la ventana de permiso, o en su terminal: ${terminal}).`,
    '   Si no hace falta anotarlo, arreglalo en este cambio y sacá el renglón.',
  ];
}

function main(argv) {
  let o;
  try { o = opciones(argv); } catch (e) { console.error(`check-pending-approvals: ${e.message}`); return 2; }
  if (o.ayuda) { console.log('uso: check-pending-approvals.js [--staged] [--repo <carpeta>]'); return 0; }
  let todo; let registro; let nuevas = [];
  try {
    todo = o.staged ? deGit(o.repo, `:${PA.TODO}`) : delDisco(o.repo, PA.TODO);
    if (todo == null) { console.log(`check-pending-approvals: no hay ${PA.TODO}: nada que revisar`); return 0; }
    registro = (o.staged ? deGit(o.repo, `:${PA.RECORD}`) : delDisco(o.repo, PA.RECORD)) || '';
    if (o.staged) {
      const antes = deGit(o.repo, `HEAD:${PA.RECORD}`) || '';
      const todoAntes = deGit(o.repo, `HEAD:${PA.TODO}`) || '';
      // sólo se lee el registro del arnés si el commit agrega líneas: sin líneas nuevas no hay firma que buscar
      nuevas = PA.revisarNuevas({ antes, despues: registro, renglones: registro !== antes ? renglonesDeLaCuenta() : [], todoAntes, todoDespues: todo });
    }
  } catch (e) {
    console.error(`⛔ check-pending-approvals: ${e.message}. Sin leerlo no sé si hay pendientes nuevos sin aprobar.`);
    return 2;
  }
  const r = PA.revisar({ todo, registro });
  if (r.ok && !nuevas.length) {
    console.log(`check-pending-approvals: ${PA.pendientesAbiertos(todo).length} pendiente(s) abierto(s), todos aprobados`);
    return 0;
  }
  const out = [];
  if (r.faltan.length) {
    out.push(`⛔ ${r.faltan.length} pendiente(s) nuevo(s) en ${PA.TODO} sin la aprobación de la coordinadora:`);
    for (const p of r.faltan) out.push(`   · ${p.codigo} (renglón ${p.numero})`);
    out.push(...comoSePide(r.faltan[0].codigo, o.repo));
    out.push('   Si no hace falta anotarlo, arreglalo en este cambio y sacá el renglón.');
  }
  if (r.sinCodigo.length) {
    out.push(`⛔ ${r.sinCodigo.length} pendiente(s) abierto(s) sin código en ${PA.TODO}: sin código no se pueden aprobar.`);
    for (const p of r.sinCodigo) out.push(`   · renglón ${p.numero}: ${p.linea.slice(0, 100)}`);
    out.push('   Ponele un código al principio (`- [ ] [DEF-…] …`) y pedí su aprobación.');
  }
  if (r.repetidos.length) {
    out.push(`⛔ ${PA.TODO} tiene renglones abiertos con un código que ya va abierto más arriba: un código, un pendiente.`);
    for (const p of r.repetidos) out.push(`   · ${p.codigo || p.clave} (renglón ${p.numero})`);
  }
  if (r.rotas.length) {
    out.push(`⛔ ${PA.RECORD} tiene línea(s) que no valen:`);
    for (const x of r.rotas) out.push(`   · línea ${x.numero}${x.id ? ` (${x.id})` : ''}: ${x.motivo}`);
  }
  if (nuevas.length) {
    out.push('⛔ el commit trae pendientes o aprobaciones que no valen:');
    for (const x of nuevas) out.push(`   · ${x.id || '?'}: ${x.motivo}`);
    out.push('   El registro no se escribe a mano: lo escribe marker.js approve-pending con la firma.');
    const abre = nuevas.find((x) => /^se abre en este commit/.test(x.motivo));
    if (abre && !r.faltan.length) out.push(...comoSePide(abre.id, o.repo));
  }
  console.error(out.join('\n'));
  return 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main };
