#!/usr/bin/env node
/**
 * engram-autoheal.js — unifica sola la memoria de engram que quedó partida, SÓLO donde es
 * inequívoco, y deja lo ambiguo para que lo decida una persona.
 *
 * ── EL PROBLEMA QUE RESUELVE ─────────────────────────────────────────────────────────────────
 * engram autodetecta el project name desde el nombre de la carpeta cuando el repo no lo fija. Un
 * rename, una sesión desde otra subcarpeta o un nombre tipeado a mano abren un cajón nuevo, y
 * buscar en el equivocado devuelve *"no memories found"* — indistinguible de "este proyecto no
 * tiene historia". El 2026-08-25 se midió en cuatro repos: 74, 135, 1151 y 507 observaciones
 * partidas.
 *
 * Los repos ya declaran su nombre canónico (`.engram/config.json`), y ESO viaja por git. Lo que no
 * viaja es el arreglo de la base LOCAL: cada máquina importó los chunks viejos con el nombre viejo,
 * y el import dedupea por `sync_id`, así que una observación que ya está no se re-etiqueta. Sin
 * este script, cada dev tendría que entender el problema y correr la unificación a mano.
 *
 * ── POR QUÉ SE PUEDE AUTOMATIZAR SIN ROMPER NADA ─────────────────────────────────────────────
 * Unir cajones es difícil de deshacer, así que la automatización sólo toca lo que NO puede estar
 * bien de otra manera. Tres guardas, todas por datos, ninguna por intuición:
 *
 *   1. **No es un proyecto transversal.** Guardar el arnés bajo `tycon` desde el cwd de cualquier
 *      producto es la convención del equipo (engram-workflow.md §2), no drift.
 *   2. **No es el nombre declarado por OTRO repo.** Medido: en la carpeta de Totora hay 311
 *      observaciones bajo `nimbobackend`. Alguien trabajó en otro producto desde ahí. Un
 *      automatismo sin esta guarda se las llevaba adentro de Totora, en silencio y sin vuelta.
 *   3. **No se usa desde más de una carpeta.** Si un nombre aparece en varios directorios es un
 *      proyecto con vida propia, no basura de autodetección. Caza el caso `backend`, que la
 *      autodetección genera IGUAL en `Totora/Backend` y en `Pacara/BackEnd`.
 *
 * Lo que pasa las tres guardas es, por construcción, un nombre que sólo existió como accidente de
 * la autodetección en una única carpeta. Lo demás se reporta para que lo mire una persona.
 *
 * ── CÓMO UNE ─────────────────────────────────────────────────────────────────────────────────
 * `engram projects consolidate` es interactivo y su emparejador es difuso (ofrece proyectos
 * ajenos). No se le delega el criterio: se lo usa como ÍNDICE. Se lee su lista numerada, se
 * eligen SÓLO los números cuyos nombres pasaron las guardas, y se le responde con esos. Si ofrece
 * de más, no se selecciona; si no ofrece algo del plan, no se une — los dos lados fallan hacia el
 * lado seguro. El orden de la lista se verificó determinístico.
 *
 * Y después se COMPROBACIÓN el resultado: los cajones del plan tienen que quedar en cero y ningún
 * otro proyecto puede haber perdido observaciones. Si la cuenta no cierra, grita — un merge que
 * salió distinto de lo planeado es exactamente lo que no se puede dejar pasar en silencio.
 *
 * Backup de la base antes de tocar nada, siempre.
 *
 * ── USO ──────────────────────────────────────────────────────────────────────────────────────
 *   node scripts/lib/engram-autoheal.js            # dice qué haría (default)
 *   node scripts/lib/engram-autoheal.js --apply    # lo hace
 *   node scripts/lib/engram-autoheal.js --json     # para consumir desde un hook
 *
 * Raíz de repos: `repos-root.js`, su vecino (env `TYCON_REPOS_ROOT`, si no la carpeta vecina a este clon).
 * Fail-open total: sin sqlite3, sin engram o sin base → no hace nada y lo dice.
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const JSON_OUT = process.argv.includes('--json');
const DB = path.join(os.homedir(), '.engram', 'engram.db');

// harness-audit resuelve la raíz de repos al cargar y con ~/.claude/tycon.json roto tira ConfigError: como comando se frena
// prolijo (archivo · clave · motivo, exit 2), no con una traza (pase adversarial de la tanda B). Como módulo, el que carga decide.
let audit;
try { audit = require('./harness-audit.js'); }
catch (e) { if (e && e.name === 'ConfigError' && require.main === module) { console.error(e.message); process.exit(2); } throw e; }
const REPOS_ROOT = (() => {
  try { return (require('./repos-root.js').resolveReposRoot().roots || [])[0] || null; }
  catch (e) { if (e && e.name === 'ConfigError') throw e; return null; }   // ~/.claude/tycon.json roto: un comando frena (story 8.3)
})();

const CROSS = audit.CROSS_CUTTING_PROJECTS;

const SQLITE = process.env.TYCON_SQLITE_BIN || 'sqlite3';

function sql(q, db) {
  return execFileSync(SQLITE, ['-readonly', db || DB, q], { encoding: 'utf8', timeout: 20000 })
    .split('\n').map((x) => x.trim()).filter(Boolean);
}

function engramBin() {
  if (process.env.ENGRAM_BIN) return process.env.ENGRAM_BIN;
  try { return execFileSync('command', ['-v', 'engram'], { shell: true, encoding: 'utf8' }).trim() || 'engram'; }
  catch { return 'engram'; }
}

/** Conteo de observaciones vivas por project (clave en minúscula). */
function conteos(db) {
  const m = new Map();
  for (const l of sql("SELECT lower(project) || '|' || COUNT(*) FROM observations WHERE deleted_at IS NULL AND project IS NOT NULL AND project <> '' GROUP BY lower(project);", db)) {
    const i = l.lastIndexOf('|');
    m.set(l.slice(0, i), Number(l.slice(i + 1)));
  }
  return m;
}

/**
 * El plan: por repo, qué nombres se pueden absorber solos y cuáles necesitan una persona.
 * @returns {{plan: Array, motivo?: string}}
 */
// `opciones` existe SÓLO para el test: le permite apuntar a una base y una raíz de laboratorio en
// vez de a las reales. En uso normal no se pasa nada.
function planificar(opciones) {
  const db = (opciones && opciones.db) || DB;
  const root = (opciones && opciones.root) || REPOS_ROOT;
  if (!root) return { plan: [], motivo: 'sin raíz de repos (definí TYCON_REPOS_ROOT o rutas.repos en ~/.claude/tycon.json): no medido' };
  // `sinBase` distingue dos cosas que NO son lo mismo: que no exista base de engram (nada que
  // verificar — una máquina que todavía no la usa) de que exista y no se pueda leer (ahí sí, no
  // se sabe). Mezclarlas hacía que el hook gritara "no pude verificar" en cualquier máquina sin
  // engram, que es ruido puro.
  if (!fs.existsSync(db)) return { plan: [], motivo: 'no hay base de engram en esta máquina', sinBase: true };

  let pinned;
  try { pinned = audit.scanEngramRepos(opciones && opciones.root ? root : undefined).pinned; } catch { return { plan: [], motivo: 'no se pudo escanear los repos' }; }
  if (!pinned.length) return { plan: [], motivo: 'ningún repo con .engram/ y nombre declarado' };

  const pinsDeclarados = new Set(pinned.map((r) => String(r.project).toLowerCase()));
  const obs = conteos(db);

  // sesiones: directorio → nombres usados, y nombre → en cuántos directorios aparece
  const dirAProjects = new Map();
  const projectADirs = new Map();
  try {
    for (const l of sql("SELECT directory || ' :: ' || project FROM sessions WHERE directory <> '' AND project <> '';", db)) {
      const i = l.indexOf(' :: ');
      if (i < 0) continue;
      const dir = l.slice(0, i).trim();
      const proj = l.slice(i + 4).trim().toLowerCase();
      // 🔴 SÓLO carpetas que existen en ESTA máquina. La tabla de sesiones viaja en los chunks,
      // así que trae las rutas de los demás devs — medido acá: 680 directorios que no existen en
      // este disco, incluido `/Users/<dev>/Proyectos/FRESNO/FRESNOBZExtBackend`. Contándolas, la
      // guarda 3 ve "usado desde 2 carpetas" para CUALQUIER proyecto que otro dev también tenga, y
      // el arreglo automático no se dispara nunca en ninguna máquina — cada una bloqueada por las
      // carpetas de las otras. La guarda hace una pregunta LOCAL ("¿este nombre se usa para más de
      // un repo ACÁ?"), así que se responde con evidencia local. Una ruta ajena no es verificable
      // y no puede decidir sobre este disco.
      if (!fs.existsSync(dir)) continue;
      if (!dirAProjects.has(dir)) dirAProjects.set(dir, new Set());
      dirAProjects.get(dir).add(proj);
      if (!projectADirs.has(proj)) projectADirs.set(proj, new Set());
      projectADirs.get(proj).add(dir);
    }
  } catch { return { plan: [], motivo: 'no se pudo leer la tabla de sesiones (¿falta sqlite3?)' }; }

  const plan = [];
  for (const { repo, project, dir: suDir } of pinned) {
    // con varias carpetas de repos, la auditoría dice dónde está cada uno
    const dir = suDir || path.join(root, repo);
    const usados = dirAProjects.get(dir);
    if (!usados) continue;
    const pin = String(project).toLowerCase();

    const auto = [];
    const humano = [];
    for (const p of usados) {
      if (p === pin) continue;
      if (!obs.get(p)) continue;                                    // cajón vacío: nada que mover
      if (CROSS.has(p)) continue;                                   // guarda 1
      if (pinsDeclarados.has(p)) { humano.push({ nombre: p, obs: obs.get(p), motivo: 'es el nombre declarado por otro repo' }); continue; }  // guarda 2
      if ((projectADirs.get(p) || new Set()).size > 1) { humano.push({ nombre: p, obs: obs.get(p), motivo: `se usa desde ${projectADirs.get(p).size} carpetas distintas` }); continue; }  // guarda 3
      auto.push({ nombre: p, obs: obs.get(p) });
    }
    if (auto.length || humano.length) plan.push({ repo, dir, pin: project, auto, humano });
  }
  return { plan };
}

/** Lee la lista numerada que ofrece `consolidate --dry-run` en ese directorio. */
function ofertaDe(dir, bin) {
  let salida;
  try {
    salida = execFileSync(bin, ['projects', 'consolidate', '--dry-run'],
      { cwd: dir, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return []; }
  const out = [];
  for (const linea of salida.split('\n')) {
    const m = linea.match(/^\s*\[(\d+)\]\s+(\S+)\s/);
    if (m) out.push({ n: m[1], nombre: m[2].toLowerCase() });
  }
  return out;
}

/**
 * El punto de restauración. Un backup que se puede pisar no es un punto de restauración
 * (hallazgo 6 de la revisión adversarial, 2026-08-25).
 *
 * Tres cosas que la versión anterior no hacía y que son la diferencia entre poder volver atrás y
 * creer que se puede:
 *   · el nombre llevaba SÓLO LA FECHA — la segunda corrida del día sobrescribía el único punto de
 *     restauración, justo cuando más falta hace (la primera ya movió memoria);
 *   · se creaba sin exclusión: dos procesos a la vez escribían el mismo archivo;
 *   · no se verificaba que la copia se pudiera LEER. Un backup corrupto es peor que ninguno,
 *     porque se decide mutar confiando en él.
 */
function hacerBackup() {
  const sello = new Date().toISOString().replace(/[:.]/g, '-');
  const destino = path.join(os.homedir(), '.engram', `engram.db.backup-autoheal-${sello}-${process.pid}`);
  if (fs.existsSync(destino)) return { error: `el backup ${destino} ya existe — no se pisa` };
  try { execFileSync(SQLITE, [DB, `.backup '${destino}'`], { timeout: 60000 }); }
  catch (e) { return { error: `no se pudo hacer backup (${String(e.message).split('\n')[0]})` }; }
  // Verificación de la copia: que exista no alcanza, tiene que poder consultarse.
  try {
    const n = execFileSync(SQLITE, ['-readonly', destino, 'SELECT count(*) FROM observations;'],
      { encoding: 'utf8', timeout: 30000 }).trim();
    if (!/^\d+$/.test(n)) return { error: `el backup ${destino} no se puede consultar — NO se toca la base` };
    return { destino, observaciones: Number(n) };
  } catch (e) {
    return { error: `el backup ${destino} quedó ilegible (${String(e.message).split('\n')[0]}) — NO se toca la base` };
  }
}

function ejecutar(plan, bin) {
  const antes = conteos();
  const b = hacerBackup();
  if (b.error) return { ok: false, error: `${b.error} — NO se tocó nada` };
  const backup = b.destino;
  console.error(`   Punto de restauración verificado: ${backup} (${b.observaciones} observaciones)`);

  const hechos = [];
  const problemas = [];
  for (const r of plan) {
    if (!r.auto.length) continue;
    const oferta = ofertaDe(r.dir, bin);
    const quiero = new Set(r.auto.map((a) => a.nombre));
    const numeros = oferta.filter((o) => quiero.has(o.nombre)).map((o) => o.n);
    const noOfrecidos = [...quiero].filter((n) => !oferta.some((o) => o.nombre === n));
    if (noOfrecidos.length) problemas.push(`${r.repo}: ${noOfrecidos.join(', ')} no aparecieron en la oferta — no se unieron`);
    if (!numeros.length) continue;
    try {
      execFileSync(bin, ['projects', 'consolidate'],
        { cwd: r.dir, input: numeros.join(',') + '\n', encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'ignore'] });
      hechos.push({ repo: r.repo, pin: r.pin, absorbidos: r.auto.filter((a) => numeros.some((n) => oferta.find((o) => o.n === n && o.nombre === a.nombre))).map((a) => a.nombre) });
    } catch (e) {
      problemas.push(`${r.repo}: el comando de unión falló (${String(e.message).split('\n')[0]})`);
    }
  }

  // COMPROBACIÓN: lo del plan tiene que haber quedado en cero, y nada AJENO puede haber perdido.
  // 🔴 En try/catch (hallazgo 6): si la comprobación se cae, la base YA está cambiada — y la
  // versión anterior moría con un stack sin decir dónde estaba el punto de restauración. Un error
  // acá no es "no pasó nada", es "pasó y no sé qué".
  try {
    const despues = conteos();
    const esperadoVacio = new Set(plan.flatMap((r) => r.auto.map((a) => a.nombre)));
    for (const n of esperadoVacio) {
      if (despues.get(n)) problemas.push(`'${n}' debía quedar en 0 y tiene ${despues.get(n)}`);
    }
    for (const [nombre, n] of antes) {
      if (esperadoVacio.has(nombre)) continue;
      const ahora = despues.get(nombre) || 0;
      if (ahora < n) problemas.push(`🔴 '${nombre}' PERDIÓ observaciones (${n} → ${ahora}) y no estaba en el plan — restaurá: ${backup}`);
    }
  } catch (e) {
    problemas.push(`🔴 la comprobación posterior FALLÓ (${String(e.message).split('\n')[0]}). La base ya fue modificada y no se pudo verificar. Restaurá: ${backup}`);
  }

  return { ok: !problemas.length, hechos, problemas, backup };
}

// Exportado para que el test ejerza las guardas sin tocar la base real ni correr uniones.
// El guard `require.main` mantiene intacto el uso como CLI y como hook.
module.exports = { planificar, ofertaDe, hacerBackup };

if (require.main !== module) return;

// engram (story 8.3, AC 9/10): con la integración apagada no hay memoria que unificar — se dice en UNA línea y sale 0;
// configuración rota → archivo, clave y motivo, exit 2 (un comando frena). Sin lector al lado: como hoy.
{
  let integ = null;
  try { integ = require('./tycon-config.js').integracionParaComando('engram'); }
  catch (e) {
    if (e && e.name === 'ConfigError') { console.error(e.message); process.exit(2); }
    if (!(e && e.code === 'MODULE_NOT_FOUND')) throw e;   // un bug del lector no se traga: un comando frena
  }
  if (integ && !integ.prendida) { console.log(integ.apagada); process.exit(0); }
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────
const { plan, motivo } = planificar();
const auto = plan.filter((r) => r.auto.length);
const humano = plan.filter((r) => r.humano.length);

if (JSON_OUT && !APPLY) {
  console.log(JSON.stringify({ motivo: motivo || null, auto, humano }, null, 2));
  process.exit(0);
}

if (motivo) { if (!JSON_OUT) console.log(`(sin datos para planificar: ${motivo})`); process.exit(0); }

if (!auto.length && !humano.length) {
  if (!JSON_OUT) console.log('✅ La memoria de esta máquina está unificada.');
  process.exit(0);
}

if (!APPLY) {
  if (auto.length) {
    console.log('🔧 Se puede unificar solo (sin intervención):');
    for (const r of auto) for (const a of r.auto) console.log(`   ${r.repo}: '${a.nombre}' (${a.obs} obs) → '${r.pin}'`);
  }
  if (humano.length) {
    console.log('\n🙋 Necesitan que lo mire una persona:');
    for (const r of humano) for (const h of r.humano) console.log(`   ${r.repo}: '${h.nombre}' (${h.obs} obs) — ${h.motivo}`);
  }
  console.log('\nPara aplicar lo automático: node scripts/lib/engram-autoheal.js --apply');
  process.exit(0);
}

const res = ejecutar(auto, engramBin());
if (res.error) { console.error(`⛔ ${res.error}`); process.exit(1); }
for (const h of res.hechos) console.log(`✅ ${h.repo}: absorbido ${h.absorbidos.join(', ')} → '${h.pin}'`);
if (res.problemas.length) {
  console.error('\n⚠️ La unión no cerró como estaba planeada:');
  for (const p of res.problemas) console.error(`   ${p}`);
  console.error(`   Backup previo: ${res.backup}`);
  process.exit(1);
}
if (!res.hechos.length) console.log('(nada que unir automáticamente)');
if (humano.length) {
  console.log('\n🙋 Queda para revisar a mano:');
  for (const r of humano) for (const h of r.humano) console.log(`   ${r.repo}: '${h.nombre}' (${h.obs} obs) — ${h.motivo}`);
}
