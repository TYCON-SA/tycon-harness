'use strict';
/**
 * Las huellas de las constancias de control. `run-base-controls.sh approve` anota en el gates.log de la cuenta la huella
 * (sha256) de cada constancia que escribe: un archivo de `.github/control-changes/` o un renglón de
 * `.tycon/control-changes.jsonl`. El freno de la consola pide la huella de cada constancia nueva antes de commitearla
 * (las que no están commiteadas) y antes de empujarla (las que la rama trae y `origin/main` no tiene). Así no importa con
 * qué comando se escribió: lo que no escribió `approve` en esta máquina no tiene huella.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const NOMBRE = 'control-change-written';
// una constancia por archivo (`<hash>.json`): en el público y en el repo de mantenimiento; y los registros de una línea por
// firma de antes, que ya no se escriben pero se leen
const CARPETAS = ['.github/control-changes', '.tycon/control-changes'];
const REGISTROS = ['.tycon/control-changes.jsonl', '.github/control-changes.jsonl'];
const RUTAS = [...CARPETAS, ...REGISTROS];
const esDeCarpeta = (archivo) => CARPETAS.some((c) => archivo.startsWith(`${c}/`)) && archivo.endsWith('.json');

/** La huella de una constancia: sha256 del texto sin los finales de renglón de Windows ni los blancos del final. */
function huellaDe(texto) {
  return crypto.createHash('sha256').update(String(texto).replace(/\r\n/g, '\n').replace(/\s+$/, '')).digest('hex');
}

/** Anota la huella de lo que `approve` escribió en `archivo` (relativo al repo). Una falla no deshace la firma: se dice. */
function anotar({ stateDir, repo, archivo, texto, ahora = Date.now() }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const renglon = { ts: new Date(ahora).toISOString(), name: NOMBRE, status: 'ok', repo: String(repo), file: String(archivo), sha256: huellaDe(texto) };
  fs.appendFileSync(path.join(stateDir, 'gates.log'), `${JSON.stringify(renglon)}\n`);
}

/** Las huellas anotadas en el gates.log de `stateDir`. `{ huellas: Set }`, o `{ error }` si no se pudo leer. */
function conocidas(stateDir) {
  let texto;
  try { texto = fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { huellas: new Set() };
    return { error: `no pude leer el registro de la máquina (${e.code || e.message})` };
  }
  const huellas = new Set();
  for (const l of texto.split('\n')) {
    if (!l.includes(NOMBRE)) continue;
    let r;
    try { r = JSON.parse(l); } catch { continue; }
    if (r && r.name === NOMBRE && typeof r.sha256 === 'string') huellas.add(r.sha256);
  }
  return { huellas };
}

function git(dir, args) {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  return spawnSync('git', ['-C', dir, '-c', 'core.quotepath=false', ...args], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, env, maxBuffer: 64 * 1024 * 1024 });
}
const fallo = (r) => (r.error && (r.error.code || r.error.message)) || String(r.stderr || '').trim().split('\n')[0] || `git salió ${r.status}`;


/**
 * Las constancias sin commitear del repo de `dir` (nuevas o cambiadas contra HEAD), con su texto: `{ constancias: [{ archivo,
 * texto }] }`, o `{ error }`. Del registro `.jsonl`, sólo sus renglones nuevos. Lo que ya está igual en `origin/main` vino
 * de main y no se pide.
 */
function sinCommitear(dir) {
  // sin juntar renombres: `a -> b` es dos rutas, y la nueva se mira como cualquier otra
  const r = git(dir, ['status', '--porcelain', '--no-renames', '--untracked-files=all', '--', ...RUTAS]);
  if (r.error || r.status !== 0) return { error: `no pude mirar las constancias sin commitear (${fallo(r)})` };
  const enRef = (ref, archivo) => { const s = git(dir, ['show', `${ref}:${archivo}`]); return !s.error && s.status === 0 ? String(s.stdout) : null; };
  const out = [];
  for (const l of String(r.stdout).split('\n').filter(Boolean)) {
    const archivo = l.slice(3).trim().replace(/^"|"$/g, '');
    if (!REGISTROS.includes(archivo) && !esDeCarpeta(archivo)) continue;
    // lo que se commitea es el índice (`git commit`) o el árbol (`git commit -a`): se miran los dos
    const textos = [];
    const indice = enRef('', archivo);
    if (indice !== null) textos.push(indice);
    let disco = null;
    try { disco = fs.readFileSync(path.join(dir, archivo), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') return { error: `no pude leer ${archivo} (${e.code || e.message})` }; }
    if (disco !== null) textos.push(disco);
    if (REGISTROS.includes(archivo)) {
      // los renglones que no están en HEAD ni en origin/main
      const ya = new Set([...(enRef('HEAD', archivo) || '').split('\n'), ...(enRef('refs/remotes/origin/main', archivo) || '').split('\n')].map(huellaDe));
      for (const t of new Set(textos.flatMap((x) => x.split('\n')).filter((x) => x.trim() && !ya.has(huellaDe(x))))) out.push({ archivo, texto: t });
      continue;
    }
    const enMain = enRef('refs/remotes/origin/main', archivo);
    for (const texto of new Set(textos)) {
      if (enMain !== null && huellaDe(enMain) === huellaDe(texto)) continue;
      out.push({ archivo, texto });
    }
  }
  return { constancias: out };
}

/**
 * Las constancias que la rama de `dir` trae y `origin/main` no tiene, con su texto (las de HEAD): `{ constancias }`,
 * `{ sinOrigen: true }` sin `origin/main` (no hay contra qué comparar), o `{ error }`.
 */
function delEmpuje(dir, ref = 'HEAD') {
  const o = git(dir, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/main']);
  if (!o.error && o.status === 1) return { sinOrigen: true, constancias: [] };
  if (o.error || o.status !== 0) return { error: `no pude leer origin/main (${fallo(o)})` };
  // lo que no existe en el repo no se puede empujar (git lo rechaza): no hay nada que mirar. Git que no contesta, sí frena
  const v = git(dir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  if (!v.error && v.status === 1) return { constancias: [] };
  if (v.error || v.status !== 0) return { error: `no pude leer lo que se empuja (${ref}: ${fallo(v)})` };
  // sin juntar renombres: una constancia movida y editada es una constancia nueva
  const r = git(dir, ['diff', '--name-only', '--no-renames', '--diff-filter=AM', 'refs/remotes/origin/main', ref, '--', ...RUTAS]);
  if (r.error || r.status !== 0) return { error: `no pude comparar ${ref} con origin/main (${fallo(r)})` };
  // lo que ya está igual en la rama remota ya se empujó (y pasó por su pedido): no se pide otra vez. Cubre las constancias
  // firmadas antes de que approve anotara su huella
  const remota = ramaRemota(dir, ref);
  const out = [];
  for (const archivo of String(r.stdout).split('\n').map((x) => x.trim()).filter(Boolean)) {
    if (REGISTROS.includes(archivo)) {
      // los renglones de lo que se empuja que no están en main ni en la rama remota
      const de = (x) => { const s = git(dir, ['show', `${x}:${archivo}`]); return !s.error && s.status === 0 ? String(s.stdout).split('\n') : null; };
      const propios = de(ref);
      if (!propios) return { error: `no pude leer ${archivo} de ${ref}` };
      const ya = new Set([...(de('refs/remotes/origin/main') || []), ...((remota && de(remota)) || [])].map(huellaDe));
      for (const t of propios.filter((l) => l.trim() && !ya.has(huellaDe(l)))) out.push({ archivo, texto: t });
      continue;
    }
    if (!esDeCarpeta(archivo)) continue;
    const s = git(dir, ['show', `${ref}:${archivo}`]);
    if (s.error || s.status !== 0) return { error: `no pude leer ${archivo} de ${ref} (${fallo(s)})` };
    if (remota) {
      const ya = git(dir, ['show', `${remota}:${archivo}`]);
      if (!ya.error && ya.status === 0 && huellaDe(ya.stdout) === huellaDe(s.stdout)) continue;
    }
    out.push({ archivo, texto: s.stdout });
  }
  return { constancias: out };
}

// la rama remota de la rama `ref` de `dir` (la que sigue, o `origin/<rama>`), o null
function ramaRemota(dir, ref = 'HEAD') {
  const u = git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${ref === 'HEAD' ? '' : ref}@{u}`]);
  if (!u.error && u.status === 0 && String(u.stdout).trim()) return String(u.stdout).trim();
  const b = ref === 'HEAD' ? git(dir, ['symbolic-ref', '-q', '--short', 'HEAD']) : { status: 0, stdout: ref.replace(/^refs\/heads\//, '') };
  const rama = !b.error && b.status === 0 ? String(b.stdout).trim() : '';
  if (!rama) return null;
  const v = git(dir, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${rama}`]);
  return !v.error && v.status === 0 ? `refs/remotes/origin/${rama}` : null;
}

/**
 * Lo que frena antes de un commit (`cuando: 'commit'`) o de un empuje (`'push'`) en el repo de `dir`: `null` si nada, o el
 * texto del cartel. Lo que no se puede mirar frena: no se sabe si la constancia es del dueño.
 */
function frenoDe({ dir: desde, cuando, stateDir, comoFirmar, refs = ['HEAD'] }) {
  // las rutas de git son desde la raíz del repo: el comando puede correr en una subcarpeta. Fuera de un repo, nada que mirar
  const top = git(desde, ['rev-parse', '--show-toplevel']);
  if (top.error || top.status !== 0 || !String(top.stdout).trim()) return null;
  const dir = String(top.stdout).trim();
  // al empujar, cada rama que se empuja (con `--all`, todas las locales)
  let lista;
  if (cuando === 'push') {
    let ramas = refs;
    if (refs.includes('*')) {
      const f = git(dir, ['for-each-ref', '--format=%(refname)', 'refs/heads']);
      if (f.error || f.status !== 0) return `🔒 CONSTANCIA SIN MIRAR — antes de empujar en ${dir}: no pude listar las ramas (${fallo(f)}). Lo que no se puede mirar frena.`;
      ramas = String(f.stdout).split('\n').map((x) => x.trim()).filter(Boolean);
    }
    lista = { constancias: [] };
    for (const ref of ramas) {
      const una = delEmpuje(dir, ref);
      if (una.error) { lista = una; break; }
      lista.constancias.push(...una.constancias);
    }
  } else lista = sinCommitear(dir);
  if (lista.error) return `🔒 CONSTANCIA SIN MIRAR — antes de ${cuando === 'push' ? 'empujar' : 'commitear'} en ${dir}: ${lista.error}. Lo que no se puede mirar frena: no se sabe si la constancia la firmó el dueño.`;
  if (!lista.constancias.length) return null;
  const c = conocidas(stateDir);
  if (c.error) return `🔒 CONSTANCIA SIN MIRAR — antes de ${cuando === 'push' ? 'empujar' : 'commitear'} en ${dir}: ${c.error}. Lo que no se puede mirar frena.`;
  const sin = lista.constancias.filter((x) => !c.huellas.has(huellaDe(x.texto)));
  if (!sin.length) return null;
  const archivos = [...new Set(sin.map((x) => x.archivo))];
  return [
    `🔒 CONSTANCIA SIN HUELLA — ${cuando === 'push' ? 'el empuje lleva' : 'el commit lleva'} en ${dir} ${archivos.length === 1 ? 'una constancia' : 'constancias'} de cambio de control que \`approve\` no escribió en esta máquina: ${archivos.join(', ')}.`,
    'Una constancia la escribe sólo `bash scripts/ci/run-base-controls.sh approve` con la firma del dueño, y deja su huella en el registro de la máquina.',
    'Cómo se sigue:',
    `  · Si el dueño la firmó en OTRA máquina: empujá desde esa máquina, o firmala de nuevo acá (anota la huella sin cambiar el archivo): ${comoFirmar || 'el comando que da `run-base-controls.sh pending --root <repo> --base <base> --range <base>...HEAD`'}.`,
    `  · Si no la escribió approve: sacala (\`git rm --cached <archivo>\` y borrala, o \`git checkout -- <archivo>\`) y pedí la firma con ese mismo comando.`,
  ].join('\n');
}

module.exports = { NOMBRE, CARPETAS, REGISTROS, huellaDe, anotar, conocidas, sinCommitear, delEmpuje, frenoDe };
