#!/usr/bin/env node
/**
 * office-inbox-watch.js — hook `SessionStart` y `Stop`, de fondo (`asyncRewake`): el vigilante del buzón de la oficina para
 * esta sesión. Cuando la persona le escribe a la sesión desde /office, el mensaje queda en el buzón
 * (scripts/lib/office-messages.js); el vigilante lo toma, lo escribe por la salida de error y termina con código 2. Con eso la
 * herramienta despierta a la sesión si estaba quieta, o se lo da al terminar el paso si estaba ocupada, siempre como aviso
 * del sistema y no como la persona: un mensaje de la oficina nunca firma.
 *
 * Queda uno solo vivo por sesión: su candado (`<estado>/office/vigilantes/<sesión>.json`) guarda el pid y la hora de arranque
 * del proceso, así un pid reutilizado no pasa por vivo. Si ya hay uno, el nuevo se va sin hacer nada. Al entregar, el candado
 * queda con la hora de la entrega: la oficina sabe que la sesión todavía no cerró ese turno y que al cerrarlo arma otro.
 * Al limpiar la conversación (`/clear`) la sesión cambia de id: el vigilante nuevo despide a los de ids viejos del mismo
 * proceso de la herramienta.
 *
 * Sólo se arma si lo lanzó la herramienta, en una entrada de `WAKE_ENTRYPOINTS` (una sesión de terminal o de fondo, o la
 * extensión de VS Code): lanzado por
 * otro proceso (un laboratorio, el chequeo de salud, el banco), o bajo `claude -p` o el SDK, que esperan a que el gancho
 * termine para salir, sale enseguida con 0.
 *
 * Un mensaje que pasó su plazo no se entrega: sale del buzón anotado como no entregado, aunque la oficina esté cerrada.
 * Espera con `fs.watch` y repasa cada 5 s por si el aviso del sistema se pierde. Vive menos que el plazo del gancho
 * (TYCON_OFFICE_WATCH_MAX_MS). Cualquier error termina con 0 y sin escribir nada: el vigilante nunca molesta a la sesión.
 *
 * Off: TYCON_OFFICE_MESSAGES=0.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const POLL_MS = 5000;
const CLAIM_SETTLE_MS = 150;
// un poco menos que el plazo del gancho en hooks-list.json: el vigilante se va solo antes de que lo corten
const MAX_LIFE_MS = 23.5 * 3600 * 1000;

const numEnv = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : dflt; };

// El nombre del proceso de la herramienta tal como lo da `ps`: `claude`, con su ruta, `claude.exe`, o `claude bg-spare` en
// una sesión de fondo.
const isToolName = (comm) => /(^|\/)claude(\.exe)?(\s|$)/.test(String(comm || '').trim());

// Las entradas de la herramienta donde un gancho de fondo despierta a la sesión. Cada una entra con su medición:
// - `cli`: una sesión de terminal y una de fondo.
// - `claude-vscode`: la extensión de VS Code; su proceso vive entre turnos y el gancho la despierta.
// Afuera `sdk-cli` y `sdk-ts` (`claude -p` y el SDK), que esperan al gancho de fondo para salir y se quedarían colgados.
// No es la lista de las entradas donde alguien lee los avisos del arranque (claude-versions.js): cada una cambia con su medición.
const WAKE_ENTRYPOINTS = ['cli', 'claude-vscode'];

function wakes(entry = require(path.join(__dirname, '..', 'lib', 'claude-versions.js')).entrypointOf()) {
  return WAKE_ENTRYPOINTS.includes(entry);
}

// El proceso de la herramienta que lanzó este gancho: el padre, o el padre de una consola intermedia. La herramienta lanza el
// gancho directo; quien lo lanza desde más lejos (un laboratorio, el chequeo de salud, una prueba) espera a que termine y no
// tiene sesión que despertar. null si no es ninguno de los dos, o en Windows.
function toolPid() {
  if (process.platform === 'win32') return null;
  let pid = process.ppid;
  for (let i = 0; i < 2 && pid > 1; i += 1) {
    const r = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { windowsHide: true, encoding: 'utf8', timeout: 2000 });
    if (r.status !== 0) return null;
    const m = /^\s*(\d+)\s+(.*)$/.exec(r.stdout.trim());
    if (!m) return null;
    if (isToolName(m[2])) return pid;
    pid = Number(m[1]);
  }
  return null;
}

function main(om, sdir, event, tool) {
  const sid = String(event.session_id || '');
  const p = om.paths(sdir);
  if (om.watcherState(sdir, sid).alive) return 0;
  om.privateTree(sdir, p.watchers);
  const me = { pid: process.pid, started: om.processStart(process.pid), tool, at: Date.now() };
  om.writePrivate(p.watcher(sid), JSON.stringify(me));
  return new Promise((resolve) => {
    let done = false;
    const timers = [];
    let watcher = null;
    const mine = () => { try { return JSON.parse(fs.readFileSync(p.watcher(sid), 'utf8')).pid === process.pid; } catch { return false; } };
    const finish = (code, write) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      try { if (watcher) watcher.close(); } catch { /* ya cerrado */ }
      if (write) {
        try { om.writePrivate(p.watcher(sid), JSON.stringify({ pid: null, deliveredAt: Date.now() })); } catch { /* la oficina lo verá sin vigilante */ }
        process.stderr.write(write);
      } else if (mine()) {
        try { fs.unlinkSync(p.watcher(sid)); } catch { /* ya no estaba */ }
      }
      resolve(code);
    };
    const look = () => {
      if (done) return;
      if (!mine()) { finish(0); return; }
      let got;
      try {
        got = om.take(sdir, sid);
        while (got && got.estado === 'vencido') got = om.take(sdir, sid);
      } catch { finish(0); return; }
      if (got && got.estado === 'recibido') finish(2, got.envelope);
    };
    for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => finish(0));
    // si dos arrancaron a la vez, sigue el que quedó escrito en el candado
    timers.push(setTimeout(() => {
      if (!mine()) { finish(0); return; }
      // la misma herramienta con otro id: la conversación se limpió y ese vigilante escucha a un id que ya no existe
      if (me.tool) {
        let names = [];
        try { names = fs.readdirSync(p.watchers).filter((f) => f.endsWith('.json') && f !== `${sid}.json`); } catch { /* sin otros */ }
        for (const f of names) {
          try {
            const other = JSON.parse(fs.readFileSync(path.join(p.watchers, f), 'utf8'));
            if (other && other.tool === me.tool && Number.isInteger(other.pid) && om.watcherState(sdir, f.slice(0, -5)).alive) process.kill(other.pid, 'SIGTERM');
          } catch { /* uno ilegible o ya ido */ }
        }
      }
      const dir = p.inbox(sid);
      try { om.privateTree(sdir, p.inboxRoot); om.privateDir(dir); } catch { /* se repasa igual */ }
      try { watcher = fs.watch(dir, () => look()); watcher.on('error', () => { /* queda el repaso */ }); } catch { /* queda el repaso */ }
      const poll = () => { look(); if (!done) timers.push(setTimeout(poll, numEnv('TYCON_OFFICE_WATCH_POLL_MS', POLL_MS))); };
      poll();
      timers.push(setTimeout(() => finish(0), numEnv('TYCON_OFFICE_WATCH_MAX_MS', MAX_LIFE_MS)));
    }, CLAIM_SETTLE_MS));
  });
}

async function run() {
  if (process.env.TYCON_EVAL_SANDBOX === '1' || process.env.TYCON_OFFICE_MESSAGES === '0') return 0;
  let event;
  try { event = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return 0; }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(event.session_id || ''))) return 0;
  if (!wakes()) return 0;
  const tool = toolPid();
  // TYCON_OFFICE_WATCH_ANY_PARENT=1: arma el vigilante aunque no lo haya lanzado la herramienta (sólo las pruebas del vigilante)
  if (tool === null && process.env.TYCON_OFFICE_WATCH_ANY_PARENT !== '1') return 0;
  const om = require(path.join(__dirname, '..', 'lib', 'office-messages.js'));
  const { stateDir } = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
  return main(om, stateDir(os.homedir()), event, tool);
}

if (require.main === module) {
  run().then((code) => { process.exit(code); }, () => { process.exit(0); });
}

module.exports = { toolPid, isToolName, WAKE_ENTRYPOINTS, wakes };
