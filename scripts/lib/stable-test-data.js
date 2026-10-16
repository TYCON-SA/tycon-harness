'use strict';
// stable-test-data.js — la regla «una prueba no depende de un sha ni de una hora que cambian», en un solo lugar.
// stable-data: este archivo nombra las formas en sus patrones a propósito; no crea commits ni lee el reloj.
//
// La usan dos: la prueba que mira el repo entero (scripts/tests/stable-test-data.test.js, con el porqué en su cabecera)
// y el freno de antes del commit (scripts/ci/check-staged-ci-rules.js), que mira sólo las pruebas que el commit trae.
const fs = require('fs');
const path = require('path');

const FOLDERS = ['scripts', 'skills'];
// Dos listas: la del repo público y, si existe, la del repo del equipo (`….team.json`), que tiene pruebas propias.
// Rutas relativas a la raíz, con `/` (como las da git, también en Windows).
const BASELINES = ['stable-test-data-baseline.json', 'stable-test-data-baseline.team.json']
  .map((f) => `scripts/tests/fixtures/${f}`);

/** ¿Es una prueba? Un .js o .sh bajo una carpeta `tests`, en scripts/ o skills/ (ruta relativa, con `/`). */
function isTestFile(rel) {
  const parts = rel.split('/');
  if (!FOLDERS.includes(parts[0]) || !/\.(js|sh)$/.test(rel)) return false;
  const dirs = parts.slice(0, -1);
  if (dirs.some((p) => p === 'node_modules' || p.startsWith('.'))) return false;
  return dirs.includes('tests');
}

/** ¿Es un renglón de comentario? (`#` en shell; `//` y los renglones de un bloque `/* … *\/` en JS). */
function isComment(l, isShell) {
  const t = l.trim();
  if (isShell) return t.startsWith('#');
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}
/** Los renglones de código con su número, sin los de comentario. En shell, un renglón partido con `\` al final se junta
 * con el siguiente (`git -C "$R" \` y `  commit -q` son un solo comando) y lleva el número del primero. */
function codeLines(text, isShell) {
  const raw = text.split('\n');
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    let l = raw[i];
    const n = i + 1;
    while (isShell && /\\\r?$/.test(l) && i + 1 < raw.length) l = l.replace(/\\\r?$/, ' ') + raw[++i];
    if (!isComment(l, isShell)) out.push({ line: n, text: l });
  }
  return out;
}
/** Los renglones de comentario: la declaración vale sólo ahí, no dentro de un texto del código. */
function comments(text, isShell) { return text.split('\n').filter((l) => isComment(l, isShell)); }

// Un commit: `git … commit`; `'commit'` como argumento (un arreglo de spawn); `commit-tree`; o `commit` suelto seguido de
// una opción, para el commit hecho por un envoltorio de git (`g -C "$R" commit -q`, `harness_lab_git "$R" commit -q`).
// No ve un envoltorio que commitea sin ninguna opción (`g "$R" commit`): queda escrito en la guía como límite.
const CREATES_COMMIT = /\bgit\b[^\n]*\bcommit(?:-tree)?\b|['"]commit(?:-tree)?['"]|(?<![\w-])commit-tree\b|(?<![\w-])commit\s+-{1,2}[A-Za-z]/;
const READS_CLOCK_JS = /\bDate\.now\(\)|\bnew Date\(\s*\)/;
const READS_CLOCK_SH = /\$\(\s*date\b|`\s*date\b/;
const DATES = ['GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE'];
const MAINTENANCE_OFF = /maintenance\.auto|\bharness_lab_git\b|\bharness_lab_no_auto_maintenance\b/;
const INJECTED_DATE = /\bTYCON_[A-Z_]*(?:TODAY|NOW)\b/;
const DECLARED = /stable-data:[ \t]*\S/;
const MAINTENANCE_LABEL = 'el mantenimiento automático de git apagado';

/**
 * Lo que le falta a una prueba, por regla: { commits: [qué falta] | null, reloj: bool, commitLine, clockLine }.
 * `commits` es null si la prueba no crea commits o si cumple; `reloj` es true si lee el reloj sin inyectarlo ni declararlo.
 * `commitLine` / `clockLine`: el primer renglón donde crea un commit / lee el reloj (para decir dónde).
 * Las fechas, el mantenimiento apagado y la fecha inyectada se buscan en el CÓDIGO: un comentario que los nombre no
 * cumple la regla. La declaración `stable-data: <motivo>`, al revés, vale sólo en un comentario, y exime al archivo de
 * las dos reglas.
 */
function faltas(text, rel) {
  const isShell = rel.endsWith('.sh');
  const none = { commits: null, reloj: false, commitLine: null, clockLine: null };
  if (comments(text, isShell).some((l) => DECLARED.test(l))) return none;
  const lines = codeLines(text, isShell);
  const code = lines.map((l) => l.text).join('\n');
  const out = { ...none };
  const commit = lines.find((l) => CREATES_COMMIT.test(l.text));
  if (commit) {
    const missing = DATES.filter((v) => !code.includes(v));
    if (!MAINTENANCE_OFF.test(code)) missing.push(MAINTENANCE_LABEL);
    if (missing.length) { out.commits = missing; out.commitLine = commit.line; }
  }
  const clock = lines.find((l) => (isShell ? READS_CLOCK_SH : READS_CLOCK_JS).test(l.text));
  if (clock && !INJECTED_DATE.test(code)) { out.reloj = true; out.clockLine = clock.line; }
  return out;
}

/** Cómo arreglar cada regla, para el aviso. */
const FIX = {
  commits: 'fijá GIT_AUTHOR_DATE y GIT_COMMITTER_DATE y apagá el mantenimiento automático (`git -c maintenance.auto=false`, o harness_lab_git); o declarálo con un comentario «stable-data: <motivo>»',
  reloj: 'inyectá la fecha con una variable del arnés (TYCON_TODAY, TYCON_…_NOW) o declarálo con un comentario «stable-data: <motivo>»',
};

/** Las listas de las que ya existían, desde un lector de archivos relativo a la raíz: [{ file, commits, reloj }]. */
function readBaselines(readRel) {
  const out = [];
  for (const rel of BASELINES) {
    const text = readRel(rel);
    if (text === null) continue;
    const l = JSON.parse(text);
    out.push({ file: rel, commits: l.commits || [], reloj: l.reloj || [] });
  }
  return out;
}
function readBaselinesFromDisk(root) {
  return readBaselines((rel) => {
    const abs = path.join(root, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  });
}

module.exports = {
  FOLDERS, BASELINES, DATES, MAINTENANCE_LABEL, FIX,
  isTestFile, faltas, readBaselines, readBaselinesFromDisk,
};
