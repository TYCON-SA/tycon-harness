#!/usr/bin/env node
'use strict';
/**
 * bash-gate-real-commands.test.js — las formas nuevas del freno de edición invisible contra los comandos reales (T36).
 *
 * QUÉ CUIDA: que manifiestos, destinos armados y borrar o deshacer no frenen de más. Toma los comandos de la terminal de
 * los hilos de esta máquina (`~/.claude/projects/<carpeta>/<sesión>.jsonl`), los pasa por el freno con una corrida
 * abierta en la carpeta de cada comando, y se queda con los frenos de las formas nuevas. Cada uno tiene que estar en la
 * lista de esperados, con su motivo; uno que no está deja la prueba en rojo y lo nombra.
 *
 * La lista vive fuera del repo, en la historia que la decidió (los comandos traen rutas de proyectos reales):
 * `TYCON_T36_EXPECTED` apunta al archivo; cada renglón `- <clave>` de la sección «Frenos esperados (T36)» es uno.
 * Sin hilos o sin lista no mide y lo dice (en la CI no hay ninguno de los dos): «no medido» no es verde.
 *
 * Correr: TYCON_T36_EXPECTED=<historia.md> node --test skills/tycon-pipeline/scripts/tests/bash-gate-real-commands.test.js
 *   `TYCON_T36_FILES` acota los hilos más recientes que se leen (400 por omisión); `TYCON_T36_OUT` escribe la lista medida.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bash = require(path.join(__dirname, '..', 'on-bash-write-gate.js'));
const { isManifestFile } = require(path.join(__dirname, '..', 'lib', 'story-gate.js'));

function hilos(max) {
  const raiz = path.join(os.homedir(), '.claude', 'projects');
  const out = [];
  let carpetas = [];
  try { carpetas = fs.readdirSync(raiz); } catch (_) { return []; }
  for (const d of carpetas) {
    try { for (const f of fs.readdirSync(path.join(raiz, d))) if (f.endsWith('.jsonl')) out.push(path.join(raiz, d, f)); } catch (_) { /* no es carpeta */ }
  }
  return out.map((f) => [f, fs.statSync(f).mtimeMs]).sort((a, b) => b[1] - a[1]).slice(0, max).map((x) => x[0]);
}

function comandos(archivos) {
  const out = [];
  for (const f of archivos) {
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!l.includes('"tool_use"')) continue;
      let j;
      try { j = JSON.parse(l); } catch (_) { continue; }
      const contenido = (j.message && Array.isArray(j.message.content)) ? j.message.content : [];
      for (const c of contenido) {
        if (c.type === 'tool_use' && (c.name === 'Bash' || c.name === 'PowerShell') && c.input && c.input.command && j.cwd) {
          out.push({ tool: c.name, cmd: c.input.command, cwd: j.cwd });
        }
      }
    }
  }
  return out;
}

/** La clave de un freno nuevo: la forma y lo que nombra, sin el resto del comando. */
function claveDelFreno(block) {
  const archivos = [...block.matchAll(/^ {5}· (.+)$/gm)].map((m) => m[1]);
  if (/Borrar o deshacer/.test(block) || /Un script inline/.test(block)) return archivos.join(' | ');
  if (archivos.length && archivos.every((f) => isManifestFile(f))) return archivos.map((f) => `manifiesto ${f}`).join(' | ');
  return null;   // un freno que ya existía
}

function esperados(archivo) {
  const texto = fs.readFileSync(archivo, 'utf8');
  const i = texto.search(/^#{2,5}\s+Frenos esperados \(T36\)/m);
  if (i < 0) return null;
  const tramo = texto.slice(i).split('\n').slice(1);
  const out = new Set();
  for (const l of tramo) {
    if (/^#{1,5}\s/.test(l)) break;
    // `clave`, o ``clave`` (la forma de Markdown para una clave que trae comillas invertidas)
    const m = l.match(/^\s*-\s+(?:``\s?(.+?)\s?``|`([^`]+)`)/);
    if (m) out.add(m[1] || m[2]);
  }
  return out;
}

test('T36 Freno_MedicionComandosReales', (t) => {
  const lista = process.env.TYCON_T36_EXPECTED;
  const archivos = hilos(Number(process.env.TYCON_T36_FILES) || 400);
  if (!archivos.length || !lista || !fs.existsSync(lista)) {
    t.skip(`no medido: ${!archivos.length ? 'no hay hilos en esta máquina' : 'sin la lista de esperados (TYCON_T36_EXPECTED)'}`);
    return;
  }
  const esperado = esperados(lista);
  assert.ok(esperado, `la lista ${lista} no tiene la sección «Frenos esperados (T36)»`);
  const estado = fs.mkdtempSync(path.join(os.tmpdir(), 't36-'));
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  const antes = process.env.TYCON_NO_RUN_CHANGE;
  process.env.TYCON_NO_RUN_CHANGE = '1';
  const medidos = new Map();
  try {
    const marcadorDe = new Map();
    for (const c of comandos(archivos)) {
      // una corrida abierta en la carpeta del comando: el peor caso para el freno
      if (!marcadorDe.has(c.cwd)) {
        const sid = `t36-${marcadorDe.size}`;
        fs.writeFileSync(path.join(estado, 'active', `${sid}.json`), JSON.stringify({
          storyId: 'T36', repoPath: c.cwd, sessionId: sid, stepsCompleted: ['start', 'approve-plan'], stepsPending: ['implement'],
        }));
        marcadorDe.set(c.cwd, sid);
      }
      let r = null;
      try {
        r = bash.handle({ tool_name: c.tool, session_id: marcadorDe.get(c.cwd), cwd: c.cwd, tool_input: { command: c.cmd } },
          { stateDir: estado, installedRoots: [] });
      } catch (_) { continue; }
      const clave = r && r.block ? claveDelFreno(r.block) : null;
      if (clave) medidos.set(clave, (medidos.get(clave) || 0) + 1);
    }
  } finally {
    if (antes === undefined) delete process.env.TYCON_NO_RUN_CHANGE; else process.env.TYCON_NO_RUN_CHANGE = antes;
    fs.rmSync(estado, { recursive: true, force: true });
  }
  if (process.env.TYCON_T36_OUT) {
    fs.writeFileSync(process.env.TYCON_T36_OUT, [...medidos].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}\t${k}`).join('\n') + '\n');
  }
  const sobran = [...medidos.keys()].filter((k) => !esperado.has(k));
  assert.deepEqual(sobran, [], `frenos nuevos que la lista no explica:\n${sobran.join('\n')}`);
});
