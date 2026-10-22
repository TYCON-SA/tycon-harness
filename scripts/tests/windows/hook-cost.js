#!/usr/bin/env node
'use strict';
/**
 * hook-cost.js — el costo de la grabadora de instintos en esta máquina: N llamadas síncronas, con la integración
 * prendida, desde la raíz de este repo (un repo con su remoto, como en una sesión real).
 *
 * POR QUÉ EXISTE. En Claude Code la grabadora corre de fondo y no demora la herramienta; si una herramienta la corre
 * síncrona, cada llamada se suma a cada uso. El tope es un p95 de 150 ms: arriba de eso la grabadora no se prende para
 * el equipo hasta bajarlo. Lo corre el ensayo de Windows (pipeline del agente Windows); en la Mac se corre a mano.
 *
 * CÓMO FALLA. Es una medición: sale 0 con el número aunque pase el tope (el veredicto va en la salida y en el JSON).
 * Sale 1 si no pudo medir (la grabadora no está, o una llamada salió con otro código).
 *
 * Uso: node scripts/tests/windows/hook-cost.js [--n 200] [--out <carpeta del reporte>]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HOOK = path.join(ROOT, 'integrations', 'instincts', 'scripts', 'instinct-observe.js');
const LIMIT_MS = 150;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function measure(n) {
  const obs = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-cost-'));
  try {
    const event = JSON.stringify({ session_id: 'abcdefgh', tool_name: 'Bash', tool_input: { command: 'git status --short' }, cwd: ROOT });
    const env = { ...process.env, TYCON_INSTINCTS: '1', TYCON_INSTINCT_OBS_DIR: obs };
    const times = [];
    for (let i = 0; i < n; i++) {
      const t0 = process.hrtime.bigint();
      const r = spawnSync(process.execPath, [HOOK], { input: event, env, cwd: ROOT });
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      if (r.status !== 0) throw new Error(`la llamada ${i + 1} salió con ${r.status === null ? r.signal : r.status}`);
    }
    const lines = fs.readdirSync(obs).filter((f) => f.endsWith('.jsonl'))
      .reduce((sum, f) => sum + fs.readFileSync(path.join(obs, f), 'utf8').trim().split('\n').filter(Boolean).length, 0);
    times.sort((a, b) => a - b);
    const q = (p) => Number(times[Math.min(times.length - 1, Math.ceil(p * times.length) - 1)].toFixed(1));
    const p95 = q(0.95);
    return { n, p50: q(0.5), p95, max: Number(times[times.length - 1].toFixed(1)), lines, limit_ms: LIMIT_MS, within_limit: p95 <= LIMIT_MS, platform: process.platform, node: process.version };
  } finally {
    fs.rmSync(obs, { recursive: true, force: true });
  }
}

function main() {
  const n = Number(arg('--n', '200'));
  const out = arg('--out', null);
  if (!fs.existsSync(HOOK)) { process.stderr.write(`hook-cost: no encontré la grabadora en ${HOOK}\n`); return 1; }
  let result;
  try { result = measure(n); } catch (e) { process.stderr.write(`hook-cost: no pude medir — ${e.message}\n`); return 1; }
  if (result.lines !== n) { process.stderr.write(`hook-cost: no pude medir — grabó ${result.lines} líneas de ${n}\n`); return 1; }
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'hook-cost.json'), `${JSON.stringify(result, null, 2)}\n`);
  }
  const verdict = result.within_limit ? 'dentro del tope' : `PASA el tope de ${LIMIT_MS} ms`;
  process.stdout.write(`hook-cost: ${n} llamadas en ${result.platform} · p50 ${result.p50} ms · p95 ${result.p95} ms · máx ${result.max} ms — ${verdict}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();
