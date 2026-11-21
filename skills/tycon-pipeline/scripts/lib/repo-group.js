'use strict';
/**
 * repo-group.js — los repos hermanos que puede nombrar la lista de un camino corto (`<Nombre>/<ruta>`).
 *
 * Un hermano vale sólo si los dos repos se declaran en `repo_group` de `.tycon/advisors.yaml` (o `.yml`) **en la rama
 * principal del remoto** (`refs/remotes/origin/HEAD`), no en la carpeta ni en la rama local: el agente commitea en su
 * rama sin que le pregunten, y declarar un hermano afloja la lista. Sin esa rama, sin el archivo en ella o sin commits,
 * se niega y se dice cómo arreglarlo; nunca se cae a la carpeta.
 *
 * El hermano es una carpeta al lado del checkout principal del repo (el padre de su `git-common-dir`), que es la raíz de
 * su propio checkout principal, con commits, y no comparte el `git-common-dir`. Un worktree, el puesto de otra sesión o
 * un enlace que lleva a otro lado no valen. El nombre se compara sin distinguir mayúsculas y en Unicode NFC, como la Mac.
 *
 * El aviso de trabajo sin subir (`unpushed-work-notice.js`) tiene su propia lectura, laxa, de la carpeta: sólo avisa.
 *
 *   grupoDelRemoto(raiz)          `{ nombre, principal, padre, rama, grupo, invalidas }` o `{ problema }`.
 *   hermanoDeEdicion(raiz, n)     `{ raiz, nombre }` (la raíz real del hermano) o `{ problema }`.
 *   prefijoDeHermano(rel, cwd)    `{ nombre, resto, dir }` si el primer tramo nombra una carpeta al lado del repo de
 *                                 `cwd` y no una carpeta de `cwd`; sólo mira el disco (para clasificar sin leer el remoto).
 *   problemaDelNombre(n)          por qué un nombre de hermano no vale, o null.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const NOMBRES = ['advisors.yaml', 'advisors.yml'];
const clave = (n) => String(n).normalize('NFC').toLowerCase();
const real = (p) => { try { return fs.realpathSync.native(p); } catch (_) { return null; } };

function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
  return { ok: !r.error && r.status === 0, out: String(r.stdout || '').trim(), status: r.status };
}

/** Por qué `n` no vale como nombre de hermano, o null. */
function problemaDelNombre(n) {
  const s = typeof n === 'string' ? n : '';
  if (!s) return 'el nombre del repo está vacío';
  if (s !== s.trim()) return `«${s}» tiene espacios en los bordes`;
  if (s === '.' || s === '..' || clave(s) === '.git') return `«${s}» no es un nombre de repo`;
  if (s.startsWith('-')) return `«${s}» empieza con guion`;
  if (/[\\/]/.test(s)) return `«${s}» tiene una barra: va el nombre de la carpeta, solo`;
  return null;
}

// lo que se preguntó por carpeta en este proceso: una lista de veinte rutas pregunta una vez
const principales = new Map();

/** El checkout principal de la carpeta `dir` (el padre de su `git-common-dir`, real), o null. */
function checkoutPrincipal(dir) {
  if (principales.has(dir)) return principales.get(dir);
  const r = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const comun = r.ok && r.out ? real(r.out) : null;
  const principal = comun && path.basename(comun) === '.git' ? path.dirname(comun) : null;
  if (r.ok || r.status === 128) principales.set(dir, principal);
  return principal;
}

// sin el comentario del final (` # …`) y sin comillas
const sinComentario = (s) => String(s).replace(/(^|\s)#.*$/, '').trim();
const sinComillas = (s) => s.replace(/^['"]|['"]$/g, '');

/**
 * Las entradas de `repo_group` de un yaml: la lista en línea o la de guiones (con o sin sangría, con renglones en blanco
 * o de comentario en el medio y comentarios al final), sin comillas. null si no está.
 */
function entradasDe(texto) {
  const renglones = String(texto || '').split(/\r?\n/);
  const i = renglones.findIndex((l) => /^repo_group:/.test(l));
  if (i < 0) return null;
  const resto = sinComentario(renglones[i].slice('repo_group:'.length));
  const enLinea = resto.match(/^\[([^\]]*)\]$/);
  if (enLinea) return enLinea[1].split(',').map((s) => sinComillas(s.trim())).filter(Boolean);
  if (resto) return null;
  const out = [];
  for (const l of renglones.slice(i + 1)) {
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const m = l.match(/^\s*-\s+(.*)$/);
    if (!m) break;
    const v = sinComillas(sinComentario(m[1]));
    if (v) out.push(v);
  }
  return out.length ? out : null;
}

/**
 * El grupo del repo de `raiz`, leído de la rama principal del remoto de su checkout principal. `grupo`: los nombres
 * sueltos; `invalidas`: las entradas que no lo son (`../B`, una ruta absoluta), que no valen.
 */
function grupoDelRemoto(raiz) {
  const principal = checkoutPrincipal(raiz);
  if (!principal) return { problema: `no encuentro el checkout principal del repo de ${raiz}` };
  const nombre = path.basename(principal);
  const ref = git(principal, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
  const rama = ref.ok ? ref.out.replace(/^refs\/remotes\/origin\//, '') : '';
  if (!rama) return { problema: `${nombre}: no leo la rama principal del remoto (refs/remotes/origin/HEAD); se arregla con git -C ${principal} remote set-head origin --auto` };
  let texto = null;
  for (const n of NOMBRES) {
    const r = git(principal, ['show', `refs/remotes/origin/${rama}:.tycon/${n}`]);
    if (r.ok) { texto = r.out; break; }
  }
  if (texto === null) return { problema: `${nombre}: no hay .tycon/advisors.yaml en origin/${rama}; repo_group vale commiteado y subido a la rama principal` };
  const entradas = entradasDe(texto);
  if (!entradas) return { problema: `${nombre}: .tycon/advisors.yaml de origin/${rama} no declara repo_group` };
  const grupo = entradas.filter((e) => !problemaDelNombre(e));
  const invalidas = entradas.filter((e) => problemaDelNombre(e));
  return { nombre, principal, padre: path.dirname(principal), rama, grupo, invalidas };
}

/** Las carpetas de `dir` cuyo nombre es `n` sin distinguir mayúsculas ni la forma Unicode. */
function carpetasLlamadas(dir, n) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  return ents.filter((d) => clave(d.name) === clave(n) && (d.isDirectory() || d.isSymbolicLink())).map((d) => d.name);
}

/** ¿Algún nombre de `lista` es `n`, sin distinguir mayúsculas ni la forma Unicode? */
const incluye = (lista, n) => lista.some((x) => clave(x) === clave(n));

/** El hermano `n` del repo de `raiz`, para editar: `{ raiz, nombre }` o `{ problema }`. */
function hermanoDeEdicion(raiz, n) {
  const malNombre = problemaDelNombre(n);
  if (malNombre) return { problema: malNombre };
  const g = grupoDelRemoto(raiz);
  if (g.problema) return { problema: g.problema };
  if (!incluye(g.grupo, n)) {
    const mal = g.invalidas.find((e) => clave(path.basename(e)) === clave(n));
    if (mal) return { problema: `${g.nombre} declara «${mal}» en repo_group: va el nombre de la carpeta, solo («${path.basename(mal)}»)` };
    return { problema: `${n} no está en repo_group de ${g.nombre} (origin/${g.rama})`, fueraDelGrupo: true };
  }
  const halladas = carpetasLlamadas(g.padre, n);
  if (!halladas.length) return { problema: `${n} no existe al lado de ${g.nombre} (${g.padre})` };
  if (halladas.length > 1) return { problema: `hay más de una carpeta ${n} al lado de ${g.nombre}: ${halladas.join(', ')}` };
  const dir = path.join(g.padre, halladas[0]);
  const raizReal = real(dir);
  if (!raizReal || path.dirname(raizReal) !== real(g.padre)) return { problema: `${n} es un enlace que lleva fuera de ${g.padre}` };
  const top = git(raizReal, ['rev-parse', '--show-toplevel']);
  if (!top.ok || real(top.out) !== raizReal) return { problema: `${n} no es la raíz de un repo` };
  const dirs = git(raizReal, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
  const [gitDir, comun] = dirs.ok ? dirs.out.split('\n').map((x) => real(x.trim())) : [];
  if (!gitDir || !comun || gitDir !== comun) return { problema: `${n} es un worktree, no el checkout principal de su repo` };
  if (path.dirname(comun) === g.principal) return { problema: `${n} es una copia del mismo repo ${g.nombre}` };
  if (!git(raizReal, ['rev-parse', '-q', '--verify', 'HEAD']).ok) return { problema: `${n} no tiene commits` };
  const vuelta = grupoDelRemoto(raizReal);
  if (vuelta.problema) return { problema: vuelta.problema };
  if (!incluye(vuelta.grupo, g.nombre)) return { problema: `${vuelta.nombre} no declara a ${g.nombre} en repo_group de origin/${vuelta.rama}: el grupo va en los dos sentidos` };
  return { raiz: raizReal, nombre: path.basename(raizReal) };
}

/**
 * ¿El primer tramo de `rel` nombra una carpeta al lado del checkout principal del repo de `cwd`, y no una de `cwd`?
 * `{ nombre, resto, dir, local }` o null. `local`: `cwd` también tiene una carpeta con ese nombre (la entrada es ambigua).
 */
function prefijoDeHermano(rel, cwd) {
  const partes = String(rel || '').replace(/\\/g, '/').split('/');
  if (partes.length < 2 || !partes[0] || partes[0] === '.' || partes[0] === '..') return null;
  const principal = cwd ? checkoutPrincipal(cwd) : null;
  if (!principal) return null;
  const padre = path.dirname(principal);
  const al = carpetasLlamadas(padre, partes[0]).filter((x) => real(path.join(padre, x)) !== principal);
  if (!al.length) return null;
  let ents = [];
  try { ents = fs.readdirSync(cwd); } catch (_) { ents = []; }
  const dir = path.join(padre, al[0]);
  // `esRepo`: tiene su `.git`. Una carpeta común al lado que no está en el grupo no hace de la entrada la de un hermano
  return { nombre: partes[0], resto: partes.slice(1).join('/'), dir, local: incluye(ents, partes[0]), esRepo: fs.existsSync(path.join(dir, '.git')) };
}

module.exports = { grupoDelRemoto, hermanoDeEdicion, prefijoDeHermano, problemaDelNombre, checkoutPrincipal, entradasDe, clave };
