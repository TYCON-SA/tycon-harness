'use strict';
/**
 * safety-trace.js — cuánto tarda cada node que lanza el freno de seguridad, para encontrar el paso que se vuelve lento.
 *
 * Lo carga Node antes de cada guion (`NODE_OPTIONS=--require …`) sólo cuando el freno corre con `TYCON_SAFETY_TRACE`:
 * el freno exporta la variable para sus hijos, y así queda medido también lo que lanzan ellos (el chequeo de la ventana
 * de permiso corre el guion de la firma). Cada proceso deja dos renglones en `TYCON_SAFETY_TRACE_FILE`: uno al
 * arrancar y otro al terminar, con lo que tardó y su tiempo de procesador. Un proceso que corta el reloj del freno deja
 * sólo el primero: ése es el que se comió el tiempo.
 *
 * Anota el guion y su subcomando (una palabra sola), nunca los valores: una cita o un comando pueden traer lo que la
 * persona escribió. Nunca escribe en la salida ni corta al guion: si no puede anotar, calla.
 */
const fs = require('fs');
const path = require('path');

const archivo = process.env.TYCON_SAFETY_TRACE_FILE;
if (archivo) {
  // con `node -e <código> <valor>`, argv[1] es el primer valor, no un guion: no se anota
  const evaluado = process.execArgv.some((a) => /^(-e|--eval|-p|--print)(=|$)/.test(a));
  const guion = !evaluado && process.argv[1] ? path.basename(process.argv[1]) : '(-e)';
  const sub = !evaluado && /^-{0,2}[a-z][a-z0-9-]*$/.test(process.argv[2] || '') ? process.argv[2] : null;
  const base = { corrida: process.env.TYCON_SAFETY_TRACE_RUN || null, pid: process.pid, ppid: process.ppid, guion, sub };
  const anotar = (r) => {
    try { fs.appendFileSync(archivo, `${JSON.stringify({ ts: new Date().toISOString(), ...base, ...r })}\n`); } catch (_) { /* la medición es ayuda */ }
  };
  anotar({ evento: 'arranca' });
  process.on('exit', (codigo) => {
    const cpu = process.cpuUsage();
    anotar({ evento: 'termina', ms: Math.round(process.uptime() * 1000), cpu_ms: Math.round((cpu.user + cpu.system) / 1000), salida: codigo });
  });
}
