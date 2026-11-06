'use strict';
// retro-coverage.js — cuándo un merge a main tiene su retrospectiva: un `metrics-*.json` con el repo y el merge_commit.
// Una sola copia de la regla para quien la cobra en la máquina (scripts/hooks/retro-pending.js) y quien la paga cada
// noche (scripts/metrics/retro-sweep.js). Casos: scripts/tests/retro-sweep.test.js (T17).
//
// La regla: el archivo nombra el repo (absoluto, por ruta real; o relativo, por sufijo con corte en separador, porque
// los primeros capturers escribían «Producto/Backend») y su sha empieza como el del merge, o al revés.
// `kindOf` dice quién lo escribió: el latido (sin modelo) o una retro con aprendizajes.

const fs = require('fs');
const path = require('path');

// el `generated_by` del latido, armado por partes como lo arma retro-heartbeat.js
const HEARTBEAT = ['retro', 'latido.js'].join('-');

const realMemo = new Map();
function real(p) {
  const k = String(p);
  if (realMemo.has(k)) return realMemo.get(k);
  let r;
  try { r = fs.realpathSync(p); } catch { r = k; }
  realMemo.set(k, r);
  return r;
}

// Cada carpeta se lee y se parsea UNA vez por proceso: releer los cientos de archivos por cada merge hacía tardar
// segundos al aviso del arranque. null = carpeta ilegible (quien llama la saltea).
// Un latido anulado (`anulado`, lo agrega `retro-heartbeat.js --annul`) no cubre nada: queda aparte, en `anuladosIn`.
const memo = new Map();
const anuladosMemo = new Map();
function metricsIn(dir) {
  if (memo.has(dir)) return memo.get(dir);
  let list = null;
  let anulados = null;
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    list = [];
    anulados = [];
    for (const f of files) {
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      // un archivo que es `null` se conserva: quien llama decide (retro-pending.js lo trata como roto)
      if (d === null) { list.push({ roto: true }); continue; }
      const repo = d.repo || d.repo_path || d.repoPath;
      const sha = String(d.merge_commit || d.mergeCommit || d.commit || '');
      if (!repo || !sha) continue;
      const registro = { repoStr: String(repo), sha, generatedBy: typeof d.generated_by === 'string' ? d.generated_by : null };
      if (d.anulado) anulados.push(registro); else list.push(registro);
    }
  } catch { list = null; anulados = null; }
  memo.set(dir, list);
  anuladosMemo.set(dir, anulados);
  return list;
}
/** Los latidos anulados de `dir`, con la misma forma que `metricsIn`; null = carpeta ilegible. */
function anuladosIn(dir) {
  if (!anuladosMemo.has(dir)) metricsIn(dir);
  return anuladosMemo.get(dir);
}

/** ¿El archivo `m` es del repo `repoPath`? */
function sameRepo(m, repoPath) {
  const repoReal = real(repoPath);
  if (path.isAbsolute(m.repoStr)) return real(m.repoStr) === repoReal;
  // separadores a «/» en los dos lados: con `path.sep` un relativo escrito con «/» nunca matcheaba en Windows
  return repoReal.replace(/\\/g, '/').endsWith('/' + m.repoStr.replace(/[\\/]+$/, '').replace(/\\/g, '/'));
}
const sameSha = (a, b) => a.startsWith(b) || String(b).startsWith(a);

/** Los archivos de `dirs` que cubren el merge `sha` de `repoPath`. Un archivo `null` tira (como siempre). */
function coveringRecords({ repoPath, sha }, dirs) {
  const out = [];
  for (const dir of dirs) {
    const list = metricsIn(dir);
    if (!list) continue;
    for (const m of list) {
      if (m.roto) throw new TypeError(`metrics null en ${dir}`);
      if (sameRepo(m, repoPath) && sameSha(m.sha, String(sha))) out.push(m);
    }
  }
  return out;
}

const kindOf = (m) => (m.generatedBy === HEARTBEAT ? 'latido' : 'aprendizajes');

module.exports = { HEARTBEAT, real, metricsIn, anuladosIn, sameRepo, sameSha, coveringRecords, kindOf };
