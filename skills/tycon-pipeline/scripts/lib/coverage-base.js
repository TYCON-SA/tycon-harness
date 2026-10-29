#!/usr/bin/env node
/**
 * coverage-base.js — ¿contra qué commit se miden las «líneas tocadas»?
 *
 * test-gate.sh cruza la cobertura con las líneas que la story agregó o modificó. Para saber cuáles son
 * hace falta una base, y la elección no es obvia:
 *   - `HEAD` solo pierde todo lo que se commiteó durante la corrida.
 *   - la base de `main`, en un repo de producto donde se trabaja en `dev`, mete las stories de otros.
 * Lo correcto es el commit en el que ARRANCÓ la corrida, que `pipeline.js start` anota en el marcador
 * (`baseSha`). Orden:
 *   1. `TYCON_COVERAGE_BASE` (el que llama manda)
 *   2. `baseSha` del marcador, si el marcador es del MISMO repo git y el commit es ancestro de HEAD
 *   3. en una corrida cruzada (`TYCON_TEST_GATE_CROSS_REPO=1`: la del repo hermano, o un repo con la story de otro) con
 *      el marcador de otro repo, o sin marcador: la bifurcación con su rama principal (`merge-base HEAD origin/HEAD` ›
 *      `origin/main` › `main`). El marcador es del repo de la story; en el repo de código, lo que la story cambió es lo
 *      posterior a la bifurcación, más lo sin commitear.
 *   4. `HEAD` (sólo lo no commiteado)
 * Una base que no sirve NO se usa en silencio: queda en `descartadas` con su motivo, y se cae a la
 * siguiente. Fuera de git no hay base (`ref: null`) y el parser lo dice.
 *
 * CLI: node coverage-base.js <repo>   → imprime {ref, source, descartadas} (lee el marcador con marker.js get)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Devuelve { out } o { error } con el detalle de git: un git que FALLA (binario ausente, carpeta que no
// existe, permisos) no puede leerse como «ref inválida» o «no es un repo» sin decir por qué.
function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return { error: `git no se pudo ejecutar (${r.error.code || r.error.message})` };
  if (r.status !== 0) return { error: (r.stderr || '').trim().split('\n')[0] || `git salió ${r.status}` };
  return { out: r.stdout.trim() };
}

function real(p) {
  try { return fs.realpathSync(p); } catch (_e) { return path.resolve(p); }
}

function verificar(top, ref) {
  const r = git(top, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (r.error) return { motivo: `«${ref}» no es un commit de este repo (${r.error})` };
  const sha = r.out;
  const anc = spawnSync('git', ['-C', top, 'merge-base', '--is-ancestor', sha, 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  if (anc.error) return { motivo: `no se pudo verificar si ${sha.slice(0, 12)} es ancestro de HEAD (${anc.error.code || anc.error.message})` };
  if (anc.status === 1) return { motivo: `${sha.slice(0, 12)} no es ancestro de HEAD (otra rama o historia reescrita)` };
  if (anc.status !== 0) return { motivo: `no se pudo verificar si ${sha.slice(0, 12)} es ancestro de HEAD (${(anc.stderr || '').trim().split('\n')[0] || `git salió ${anc.status}`})` };
  return { sha };
}

// La bifurcación del repo con su rama principal: { sha, rama } o { motivo } con lo que se probó.
function bifurcacion(top) {
  const probadas = [];
  for (const rama of ['origin/HEAD', 'origin/main', 'main']) {
    const v = git(top, ['rev-parse', '--verify', '-q', `${rama}^{commit}`]);
    if (v.error) { probadas.push(rama); continue; }
    const mb = git(top, ['merge-base', 'HEAD', v.out]);
    if (mb.out) return { sha: mb.out, rama };
    probadas.push(`${rama} (sin ancestro común con HEAD${mb.error ? `: ${mb.error}` : ''})`);
  }
  return { motivo: `no encontré la rama principal contra la que buscar la bifurcación (probé ${probadas.join(', ')})` };
}

function resolver({ repo, env = process.env, marker = null, markerError = null } = {}) {
  const descartadas = [];
  const t = repo ? git(repo, ['rev-parse', '--show-toplevel']) : { error: 'no se indicó carpeta' };
  if (t.error) {
    descartadas.push({ source: 'git', motivo: `la carpeta medida no es un repo git utilizable: no hay base contra la que medir (${t.error})` });
    return { ref: null, source: null, descartadas };
  }
  const top = t.out;
  if (markerError) descartadas.push({ source: 'marcador', motivo: `no se pudo leer el marcador de la corrida: ${markerError}` });

  const envRef = env && env.TYCON_COVERAGE_BASE;
  if (envRef) {
    const v = verificar(top, envRef);
    if (v.sha) return { ref: v.sha, source: 'env', descartadas };
    descartadas.push({ source: 'env', motivo: v.motivo });
  }

  if (marker && marker.baseSha) {
    const m = marker.repoPath ? git(marker.repoPath, ['rev-parse', '--show-toplevel']) : { error: 'sin repoPath' };
    const mTop = m.out;
    if (!mTop || real(mTop) !== real(top)) {
      descartadas.push({ source: 'marcador', motivo: 'el marcador de la corrida es de otro repo' });
    } else {
      const v = verificar(top, marker.baseSha);
      if (v.sha) return { ref: v.sha, source: 'marcador', descartadas };
      descartadas.push({ source: 'marcador', motivo: v.motivo });
    }
  }

  const delOtro = !marker || !marker.baseSha || descartadas.some((d) => d.source === 'marcador' && /otro repo/.test(d.motivo));
  if (env && env.TYCON_TEST_GATE_CROSS_REPO === '1' && delOtro) {
    const b = bifurcacion(top);
    if (b.sha) return { ref: b.sha, source: 'bifurcacion', rama: b.rama, descartadas };
    descartadas.push({ source: 'bifurcacion', motivo: b.motivo });
  }

  const h = git(top, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (h.error) {
    // Un repo sin commits todavía (el que inicia el arranque) se mide contra el árbol vacío: todo es línea tocada.
    // Casos: skills/tycon-pipeline/scripts/tests/start-no-git.test.js
    const sinCommits = git(top, ['symbolic-ref', '-q', 'HEAD']);
    const vacio = sinCommits.out ? spawnSync('git', ['-C', top, 'hash-object', '-t', 'tree', '--stdin'], { input: '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) : null;
    if (vacio && vacio.status === 0 && vacio.stdout.trim()) return { ref: vacio.stdout.trim(), source: 'arbol-vacio', descartadas };
    descartadas.push({ source: 'HEAD', motivo: `no hay un HEAD utilizable (${h.error})` });
    return { ref: null, source: null, descartadas };
  }
  return { ref: h.out, source: 'HEAD', descartadas };
}

// { marker, error }: un marker.js que falla se DICE (queda en descartadas), no se lee como «sin corrida».
function leerMarcador() {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'marker.js'), 'get'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
  if (r.error) return { marker: null, error: `marker.js get no corrió (${r.error.code || r.error.message})` };
  if (r.status !== 0) return { marker: null, error: `marker.js get salió ${r.status}: ${(r.stderr || '').trim().split('\n')[0]}` };
  try { return { marker: JSON.parse(r.stdout || '{}'), error: null }; } catch (e) { return { marker: null, error: `marker.js get devolvió algo ilegible (${e.message})` }; }
}

if (require.main === module) {
  const repo = process.argv[2] || process.cwd();
  let out;
  try {
    const lm = leerMarcador();
    out = resolver({ repo, env: process.env, marker: lm.marker, markerError: lm.error });
  } catch (e) {
    out = { ref: null, source: null, descartadas: [{ source: 'coverage-base', motivo: `falló al resolver la base: ${e.message}` }] };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}

module.exports = { resolver, bifurcacion };
