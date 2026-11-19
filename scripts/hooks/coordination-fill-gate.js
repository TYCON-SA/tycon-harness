#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard({ hook: true }); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * coordination-fill-gate.js — freno `Stop`: la coordinadora no deja la máquina vacía.
 *
 * POR QUÉ EXISTE. El aviso de cada turno le dice a la coordinadora qué reabrir, y se puede ignorar: cuatro veces en dos
 * días paró sesiones «para ahorrar memoria» y no abrió nada, con lugar, memoria libre y seis historias firmadas
 * esperando. Este freno no deja cerrar el turno en esa situación hasta que abra una sesión o deje escrito por qué no.
 *
 * QUÉ MIRA. Sólo en la sesión designada coordinadora, al cerrar cada turno: `fillCheck` de scripts/tools/coordination.js,
 * que cuenta el lugar como `open` (las otras que trabajan más la coordinadora, por debajo del tope), lee las historias
 * listas sin sesión del proyecto de la coordinadora (la lectura de proyectos de la oficina, que el freno manda a refrescar
 * de fondo si está vencida) y mide la memoria libre al final (40 % o más). Un motivo vigente (`coordination.js keep-free`,
 * scripts/lib/free-slots.js) que cubra ese trabajo lo calla. Las corridas detenidas no entran: las sigue nombrando el aviso
 * de la fila larga del portón.
 *
 * QUÉ HACE. Con lugar, memoria y trabajo listo escribe `{"decision":"block","reason":…}`: qué hay (hasta cinco historias,
 * por número, título y prioridad) y cómo anotar el motivo. No da comandos para abrir: eso lo dice guides/coordination.md.
 * Tres bloqueos seguidos de la misma coordinadora y al cuarto cierre deja pasar, y lo anota como «cerró sin abrir ni
 * motivo», que vale y se ve como un motivo (/wip y la oficina). Un cierre que no frena borra el contador: cuentan sólo los
 * bloqueos seguidos. `stop_hook_active` no lo salta: el tope es lo que evita el bucle.
 *
 * QUÉ NO HACE. No abre ni reabre sesiones. No tiene interruptor: la salida es el motivo, que queda escrito. Un error propio,
 * un evento ilegible, un estado que no se puede leer o un contador que no se puede anotar nunca cortan el cierre: sale 0 con
 * el motivo en la salida de errores; lo que no pudo leer sin frenar también lo dice ahí. En Windows la memoria no se mide,
 * así que ahí no frena.
 *
 * `--memory-pct <n>` toma ese valor como la memoria medida: lo usan las pruebas y el banco, que corren el gancho en una
 * casa de juguete. El registro del gancho (scripts/setup/hooks-list.json) lo corre sin argumentos.
 * Salida: siempre 0; la decisión va por la salida normal.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const C = require('../tools/coordination.js');
const FS = require('../lib/free-slots.js');
const { stateDir } = require('../../skills/tycon-pipeline/scripts/lib/state-dir.js');

const MAX_BLOCKS = 3;
const TAG = 'coordination-fill-gate';
const safeSid = (sid) => String(sid).replace(/[^\w.-]/g, '_');
const countFile = (home, sid) => path.join(C.coordinationDir(home), `fill-gate-${safeSid(sid)}.count`);
const hhmm = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '?' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const firstLine = (e) => String((e && (e.code || e.message)) || e).split('\n')[0].slice(0, 200);
// lo que no se pudo leer, en una línea y con tope: un mensaje de error puede traer un trozo del archivo roto
const cut = (list) => list.map((p) => String(p).replace(/\s+/g, ' ').trim().slice(0, 160)).join(' · ').slice(0, 600);

/**
 * El gancho, sin leer la entrada ni escribir: `{ code, stdout, stderr }`. `event` es el evento de `Stop`; `now`, `readMemory`,
 * `refreshLauncher` y `arnes` son para las pruebas.
 */
function run({ event, home = os.homedir(), env = process.env, arnes, now = Date.now(), readMemory, refreshLauncher } = {}) {
  const out = { code: 0, stdout: '', stderr: '' };
  const say = (m) => { out.stderr += `${TAG}: ${m}\n`; };
  try {
    if (!event || typeof event !== 'object' || Array.isArray(event)) { say('no pude leer el evento del cierre: no freno'); return out; }
    const sid = event.session_id || event.sessionId || null;
    if (!sid) return out;
    const r = C.fillCheck({ home, env, arnes, now, sessionId: sid, cwd: event.cwd || process.cwd(), readMemory, refreshLauncher });
    const file = countFile(home, sid);
    const clean = () => { try { fs.unlinkSync(file); } catch { /* no existía */ } };
    if (!r.block) {
      if (r.why === 'estado-ilegible') say(`no pude leer el estado de la máquina (${cut(r.problems)}): no freno`);
      else if (r.problems.length) say(`no freno (${r.why}); no pude leer: ${cut(r.problems)}`);
      if (r.why !== 'no-coordinadora') clean();
      return out;
    }
    let blocks = 0;
    try { blocks = Number(fs.readFileSync(file, 'utf8')) || 0; } catch { blocks = 0; }
    if (blocks >= MAX_BLOCKS) {
      const rec = FS.record({ kind: 'closed-without-reason', at: now, sid, session: r.session, reason: 'cerró sin abrir ni motivo', working: r.working, cap: r.cap, memoryPct: r.memoryPct, work: r.keys });
      try { FS.write(stateDir(home), rec); } catch (e) {
        say(`no pude anotar el cierre sin motivo (${firstLine(e)}): dejo cerrar igual`);
        clean();
        return out;
      }
      say(`${MAX_BLOCKS} bloqueos seguidos: dejo cerrar y anoto «cerró sin abrir ni motivo» hasta las ${hhmm(rec.expiresAt)}; /wip y la oficina lo muestran`);
      clean();
      return out;
    }
    // el contador sube antes de escribir la decisión; sin contador no hay tope, y el tope es lo que evita el bucle: un
    // bloqueo que no se puede anotar no frena
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, String(blocks + 1)); } catch (e) { say(`no pude anotar el bloqueo (${firstLine(e)}): no freno`); return out; }
    out.stdout = `${JSON.stringify({ decision: 'block', reason: `${r.reason}\nBloqueo ${blocks + 1}/${MAX_BLOCKS}.` })}\n`;
    return out;
  } catch (e) {
    return { code: 0, stdout: '', stderr: `${out.stderr}${TAG}: ${firstLine(e)}: no freno\n` };
  }
}

function main() {
  // se lee la entrada antes de decidir nada: salir sin drenarla rompe la tubería de quien escribe
  let payload = '';
  try { payload = fs.readFileSync(0, 'utf8'); } catch { payload = ''; }
  let event = null;
  try { event = payload.trim() ? JSON.parse(payload) : {}; } catch { event = null; }
  const i = process.argv.indexOf('--memory-pct');
  const forced = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  const readMemory = Number.isFinite(forced) ? () => ({ pct: forced, why: null }) : undefined;
  const r = run({ event, readMemory });
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.stdout) process.stdout.write(r.stdout);
  process.exitCode = r.code;
}

if (require.main === module) main();

module.exports = { run, countFile, MAX_BLOCKS };
