'use strict';
// remove.js — quita de la máquina una pieza registrada del arnés, por tipo, sin tocar lo ajeno (story 8.13, tanda C ·
// AC 19 y 22). Lo usan `uninstall` (quita todo lo registrado) y la vuelta atrás (quita lo registrado que la versión
// anterior ya no trae).
//
// Por qué un módulo propio: el registro (`managed` en harness-state.json, managed.js) dice QUÉ dejó el aplicador; acá
// vive CÓMO se deshace cada cosa sin llevarse nada del dev. La regla es quitar exactamente lo que el aplicador escribe
// —`install-tycon-hooks.sh` (el python de settings.json, los hooks globales de git, los comandos, los LaunchAgents),
// `sync-claude-md-blocks.sh` (los bloques)— y nada más:
//   · hook          el `command` con la forma que escribe el aplicador (`node|bash|python3 "<ruta>"`, la ruta termina en la
//                   de su spec y vive bajo el árbol, su enlace o agent-skills; `$HOME/`/`~/` se expanden y se comparan
//                   enteros), en ESE evento. Lo ajeno y su orden quedan; un grupo que queda sin hooks se va, un evento sin
//                   grupos también, y `hooks` vacío también. El mismo hook con texto alrededor (un argumento, un prefijo
//                   de env) lo cambió el dev: no se toca y va a «revisalo».
//   · setting       sólo si sigue con el `value` registrado (si el dev lo cambió, es suyo). `env.X` borra la clave, y
//                   `env` si queda vacío.
//   · block         `<!-- TYCON_BLOCK:<n> START … END -->` del archivo de su `where` (CLAUDE.md o el espejo AGENTS.md),
//                   con el renglón en blanco que el sync le puso delante. Sin marcador de cierre no se adivina: queda.
//   · import        la línea (`@~/.claude/<lugar>/README.md`, con cualquiera de los dos nombres del lugar).
//   · startup-line  el hook de SessionStart que `startup-line.isNew` reconoce.
//   · link          sólo si es un enlace que resuelve al árbol o adentro de él (o colgado, apuntando al árbol que se borró):
//                   el del arnés y, en el repo único de la 8.7, agent-skills, skills, agents y los enlaces por entrada.
//   · command       el archivo; uno que el dev cambió (distinto del del árbol) queda; uno que pisó uno propio vuelve a la copia.
//                   Si el árbol ya no lo trae, se quita sólo si sigue como lo dejó la instalación (`afterSha`); si no, queda.
//   · git-hook      el archivo, si sigue siendo el del arnés; si existe `<hook>.local`, vuelve a `<hook>` (decisión 5).
//   · launch-agent  `$LAUNCHCTL_BIN bootout gui/<uid> <plist>` (o `unload`), y se borra el plist.
//   · codex         sólo bajo CODEX_HOME o el espejo AGENTS.md (afuera: no se toca). `AGENTS.md`: sus bloques;
//                   `hooks.json`/`config.toml`: se borran sólo si la copia `install` dice que no existían Y siguen byte a
//                   byte como los dejó esa instalación (`afterSha`), si no → «revisalo»; lo demás que genera el despliegue
//                   (perfiles, skills) se borra.
//   · third-party   no se toca: vive dentro del árbol.
//   · file          se borra, sólo si cae bajo la carpeta de la copia fija (~/.claude/.tycon-pipeline/harness/).
//
// El byte a byte (AC 23): `restoreIfEqual` = `{ [ruta]: <ruta del archivo en la copia> | null }`. Después de quitar, un
// archivo tocado que es IGUAL a su copia —como JSON (settings.json, sin contar `hooks`/`env` vacíos) o como texto (salvo
// el final de línea)— se escribe con los bytes de la copia: así vuelve el formato del dev, no el del aplicador. `null` =
// el archivo no existía antes de instalar: si quedó vacío, se borra. Un comando con copia vuelve a ella. `afterSha` =
// `{ [ruta]: <sha256_after de esa copia> }`: cómo dejó el archivo la instalación (lo pasa `uninstall`; sin él, lo que
// necesita esa prueba queda o va a «revisalo»).
//
// `dryRun: true` clasifica sin escribir nada: es el plan de `uninstall` (y de `--dry-run`), con las mismas reglas.
//
// Nunca tira: lo que no se pudo quitar va a `kept` con el motivo (`error: true` si fue un fallo). Escrituras atómicas
// (`state.writeAtomic`). Sólo `require` de `scripts/setup/harness/` (corre desde la copia fija). Funciones puras respecto
// del HOME: reciben `home`/`env`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateDir: stateDirOf } = require('./tycon-home.js');   // story 8.23 (A2): la carpeta del estado, de una sola pieza
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { writeAtomic, paths: statePaths } = require('./state');
const M = require('./managed');
const SL = require('./startup-line');

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const slash = (s) => String(s).replace(/\\/g, '/');
const lexists = (p) => { try { fs.lstatSync(p); return true; } catch (_) { return false; } };
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };
/** Una ruta comparable: barras normales, sin barra final, sin el `/private` con que macOS resuelve /tmp y /var. */
const norm = (p) => slash(p).replace(/\/+$/, '').replace(/^\/private(?=\/(?:var|tmp|etc)\/)/, '');
// el intérprete: una palabra (`node`, `bash`, `sh`, `python3`) o, desde la story 8.17 (W4 · AC 29), la ruta del bash de
// Git entre comillas, como registra un `.sh` el aplicador en Windows (`"C:/…/bash.exe" "<ruta>"`). Otro programa entre
// comillas no cuenta (pase adversarial de la W3W4, clase 11).
const RUNNER = '(?:node|bash|sh|python3?|"[^"]*/bash(?:\\.exe)?")';
const RUNNER_RE = new RegExp(`^\\s*${RUNNER}\\s+"([^"]+)"\\s*$`, 'i');
const BOM = /^﻿/;

/**
 * La línea de CLAUDE.md con cualquiera de los dos nombres del lugar (story 8.19, tanda B · AC 20): la pieza pudo quedar
 * registrada con un nombre y la línea escrita con el otro (`relocate` cambia los dos; una vuelta atrás, uno solo).
 * Otra línea queda como es.
 */
function importForms(id) {
  const PLACE = require('./place.js');
  const forms = [PLACE.PLACE_NAME, PLACE.LEGACY_PLACE_NAME].map((n) => `@~/.claude/${n}/README.md`);
  return new Set(forms.includes(id) ? forms : [id]);
}

// ── Los enlaces duros que anotó canonical-path.js (story 8.17, W4 · AC 39) ─────────────────────────────────────────
// Este archivo viaja en la copia fija y no puede cargar scripts/lib/: lee el mismo registro, con la misma regla que
// `ownHardLink` de canonical-path.js (si cambia uno, cambia el otro). La entrada es del arnés MIENTRAS el archivo siga
// siendo ése (dispositivo, inodo, fecha y tamaño) y su destino caiga dentro del árbol.
const hardLinksFile = (home) => path.join(stateDirOf(home), 'hard-links.json');
const linkKey = (p) => { const d = path.dirname(path.resolve(p)); return path.join(real(d) || d, path.basename(p)); };
function ownHardLinkRecord(home, where, treeNorms) {
  let reg; try { reg = JSON.parse(fs.readFileSync(hardLinksFile(home), 'utf8')); } catch (_) { return { own: false }; }
  const links = reg && Array.isArray(reg.links) ? reg.links : [];
  const rec = links.find((x) => x && x.where === linkKey(where));
  if (!rec || !rec.id || typeof rec.target !== 'string') return { own: false };
  let s; try { s = fs.lstatSync(where, { bigint: true }); } catch (_) { return { own: false }; }
  const same = !s.isSymbolicLink() && s.isFile() && String(s.dev) === rec.id.dev && String(s.ino) === rec.id.ino
    && String(s.mtimeNs) === rec.id.mtime && String(s.size) === rec.id.size;
  const t = norm(rec.target);
  const toTree = treeNorms.some((x) => t === x || t.startsWith(`${x}/`));
  return { own: same && toTree, key: rec.where, links };
}
function forgetHardLinkRecord(home, hl) {
  const left = hl.links.filter((x) => !(x && x.where === hl.key));
  try {
    if (left.length) writeAtomic(hardLinksFile(home), `${JSON.stringify({ schema: 1, links: left }, null, 2)}\n`);
    else fs.rmSync(hardLinksFile(home), { force: true });
  } catch (_) { /* el registro nunca frena la desinstalación: la entrada queda y la próxima instalación la olvida (ya no coincide) */ }
}

/** Las carpetas bajo las que viven los hooks del arnés: el árbol, sus dos nombres (el lugar y el viejo, story 8.19) y
 *  agent-skills (y sus rutas reales). */
function hookRoots(home, tree) {
  const claude = path.join(home, '.claude');
  const PLACE = require('./place.js');
  const out = [tree, PLACE.placePath(home), PLACE.legacyPlacePath(home), path.join(claude, 'agent-skills'), path.join(claude, 'agent-skills', 'skills')];
  for (const r of out.slice()) { const x = r && real(r); if (x) out.push(x); }
  return [...new Set(out.filter(Boolean).map(norm))];
}

/**
 * ¿Esta ruta de un `command` es la del hook `relpath` del arnés? Termina en la de su spec y lo de delante es una raíz
 * conocida. `$HOME/…`, `${HOME}/…` y `~/…` se expanden con `home` y se comparan enteros: `$HOME/scripts/hooks/x.js` o
 * `~/skills/…` del dev NO son del arnés aunque una raíz termine igual (pase adversarial, H14).
 */
function isHarnessPath(raw, relpath, roots, home) {
  const p = norm(raw);
  const needle = M.hookNeedle(relpath);
  if (!p.endsWith(needle)) return false;
  let base = p.slice(0, p.length - needle.length);
  const m = /^(?:\$HOME|\$\{HOME\}|~)(?=$|\/)/.exec(base);
  if (m) {
    if (!home) return false;
    base = norm(`${slash(home)}${base.slice(m[0].length)}`);
  }
  return roots.some((r) => base === r || base.startsWith(`${r}/`));
}

/** ¿Este `command` es el que escribe el aplicador para esa ruta? (forma exacta `runner "<ruta>"`, la ruta del arnés) */
function isHarnessCommand(command, relpath, roots, home = null) {
  const m = RUNNER_RE.exec(slash(command || ''));
  return Boolean(m) && isHarnessPath(m[1], relpath, roots, home);
}

/** ¿El `command` corre ese hook del arnés con texto alrededor (un argumento al final, un prefijo de env)? (H13) */
const RUNNER_ANY_RE = new RegExp(`(?:^|[\\s;&|(])${RUNNER}\\s+"([^"]+)"`, 'gi');
function mentionsHarnessHook(command, relpath, roots, home) {
  const c = slash(command || ''); let m;
  RUNNER_ANY_RE.lastIndex = 0;
  while ((m = RUNNER_ANY_RE.exec(c))) if (isHarnessPath(m[1], relpath, roots, home)) return true;
  return false;
}

/** ¿`p` cae dentro de `root` (no es `root` mismo)? Por ruta y, si existe, por la ruta real de su carpeta (un enlace no la saca afuera). */
function inside(p, root) {
  if (!root) return false;
  const a = norm(path.resolve(p)); const r = norm(path.resolve(root));
  if (!a.startsWith(`${r}/`)) return false;
  const rd = real(path.dirname(path.resolve(p))); const rr = real(root);
  if (rd && rr) { const x = norm(rd); const y = norm(rr); if (x !== y && !x.startsWith(`${y}/`)) return false; }
  return true;
}
const sameFile = (a, b) => norm(path.resolve(a)) === norm(path.resolve(b));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Saca de `settings.hooks` los hooks que cumplen `match(event, hook)`; deja lo demás y su orden. Devuelve cuántos sacó. */
function dropHooks(settings, match) {
  if (!isObject(settings) || !isObject(settings.hooks)) return 0;
  let n = 0;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const g of groups) {
      if (!isObject(g) || !Array.isArray(g.hooks)) { kept.push(g); continue; }
      const hs = g.hooks.filter((h) => !(isObject(h) && typeof h.command === 'string' && match(event, h) && ++n));
      if (hs.length === g.hooks.length) { kept.push(g); continue; }
      if (hs.length) kept.push(Object.assign({}, g, { hooks: hs }));
    }
    if (kept.length) settings.hooks[event] = kept; else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return n;
}

/** Saca un bloque `TYCON_BLOCK:<name>` con el renglón en blanco que el sync le puso delante. `null` si no está o no cierra. */
function dropBlock(text, name) {
  const start = `<!-- TYCON_BLOCK:${name} START`;
  const end = `<!-- TYCON_BLOCK:${name} END -->`;
  const i = text.indexOf(start);
  if (i < 0) return { text, found: false };
  const j = text.indexOf(end, i);
  if (j < 0) return { text, found: true, unclosed: true };
  let before = text.slice(0, i);
  let after = text.slice(j + end.length);
  if (after.startsWith('\r\n')) after = after.slice(2); else if (after.startsWith('\n')) after = after.slice(1);
  // el sync agrega con `rstrip + "\n\n" + bloque + "\n"`: se devuelve un solo salto entre lo de antes y lo de después
  if (before.trim()) before = `${before.replace(/(\r?\n)+$/, '')}\n`; else before = '';
  return { text: before + after, found: true };
}

const TYCON_BLOCK_RE = /<!--\s*TYCON_BLOCK:([^\s>]+)\s+START/g;
function blockNames(text) {
  const out = []; let m;
  TYCON_BLOCK_RE.lastIndex = 0;
  while ((m = TYCON_BLOCK_RE.exec(text))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** JSON comparable: sin `hooks`/`env` vacíos (el aplicador crea `hooks: {}` donde no había). */
function comparable(obj) {
  if (!isObject(obj)) return JSON.stringify(obj);
  const o = Object.assign({}, obj);
  for (const k of ['hooks', 'env']) if (isObject(o[k]) && !Object.keys(o[k]).length) delete o[k];
  return JSON.stringify(o);
}
const sortKeys = (x) => (Array.isArray(x) ? x.map(sortKeys) : isObject(x) ? Object.keys(x).sort().reduce((a, k) => { a[k] = sortKeys(x[k]); return a; }, {}) : x);
const sameJson = (a, b) => comparable(sortKeys(a)) === comparable(sortKeys(b));
const sameText = (a, b) => a.replace(/\r\n/g, '\n').replace(/\s+$/, '') === b.replace(/\r\n/g, '\n').replace(/\s+$/, '');

function getPath(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split('.')) { if (!isObject(cur) || !(part in cur)) return undefined; cur = cur[part]; }
  return cur;
}

/**
 * Quita las piezas. `opts` = `{ home, env, tree, log, restoreIfEqual, platform, dryRun }`. Con `dryRun` no escribe nada:
 * clasifica igual (lo que quitaría, lo que quedaría y por qué, lo que hay que revisar, lo que ya no está) — es el plan.
 * @returns {{ removed: object[], kept: {piece, why, error?}[], review: {piece, why}[], absent: object[] }}
 */
function removePieces(pieces, { home = os.homedir(), env = process.env, tree = null, log = null, restoreIfEqual = null, afterSha = null, platform = process.platform, dryRun = false } = {}) {
  const out = { removed: [], kept: [], review: [], absent: [] };
  const say = (l) => { try { if (log && !dryRun) log(l); } catch (_) { /* el registro nunca frena */ } };
  const keep = (piece, why, error = false) => { out.kept.push(error ? { piece, why, error: true } : { piece, why }); say(`queda ${M.describe(piece)}: ${why}`); };
  // la copia de cada archivo, por ruta comparable (el reporte y el manifiesto pueden escribir /var o /private/var)
  const restoreMap = new Map(Object.entries(isObject(restoreIfEqual) ? restoreIfEqual : {}).map(([k, v]) => [norm(k), v]));
  const copyOf = (file) => (restoreMap.has(norm(file)) ? { has: true, copy: restoreMap.get(norm(file)) } : { has: false, copy: undefined });
  // `afterSha` = `{ [ruta]: sha256 }`: cómo dejó el archivo la instalación (el `sha256_after` de la copia install). Un
  // archivo que sigue así es del arnés; uno distinto, o sin ese dato, puede tener texto del dev (H6, H15)
  const afterMap = new Map(Object.entries(isObject(afterSha) ? afterSha : {}).map(([k, v]) => [norm(k), v]));
  const asInstalled = (file) => { const want = afterMap.get(norm(file)); if (typeof want !== 'string') return false; try { return sha256(fs.readFileSync(file)) === want; } catch (_) { return false; } };
  const roots = hookRoots(home, tree);
  const fixedDir = statePaths(home).harnessDir;
  const codexHome = (typeof env.CODEX_HOME === 'string' && env.CODEX_HOME) || path.join(home, '.codex');
  const mirror = (typeof env.CODEX_AGENTS_MD_PATH === 'string' && env.CODEX_AGENTS_MD_PATH) || path.join(home, '.codex', 'AGENTS.md');
  const gitHooksDir = (typeof env.TYCON_GIT_HOOKS_DIR === 'string' && env.TYCON_GIT_HOOKS_DIR) || path.join(home, '.git-hooks');
  const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
  const importIds = new Set((Array.isArray(pieces) ? pieces : []).filter((p) => isObject(p) && p.kind === 'import' && typeof p.id === 'string').flatMap((p) => [...importForms(p.id)]));
  const treeNorms = [tree, tree && real(tree)].filter(Boolean).map(norm);

  // los archivos que se editan por dentro (settings.json como JSON; CLAUDE.md y AGENTS.md como texto): se cargan una vez,
  // se cambian en memoria y se escriben al final, una vez cada uno
  const docs = new Map();   // ruta → { type, raw, data, dirty, broken }
  const doc = (file, type) => {
    if (docs.has(file)) return docs.get(file);
    let raw = null; let data = null; let broken = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (!(e && e.code === 'ENOENT')) broken = `no se pudo leer (${(e && e.code) || e.message})`; }
    if (raw !== null && type === 'json') { try { data = JSON.parse(raw.replace(BOM, '')); } catch (e) { broken = `JSON ilegible (${e.message})`; } }
    if (raw !== null && type === 'text') data = raw;
    const d = { type, raw, data, dirty: false, broken };
    docs.set(file, d);
    return d;
  };
  const json = (piece) => {
    const d = doc(piece.where, 'json');
    if (d.broken) { keep(piece, `${piece.where}: ${d.broken} — no lo toco`, true); return null; }
    if (d.raw === null || !isObject(d.data)) { out.absent.push(piece); return null; }
    return d;
  };
  const text = (piece, file = piece.where) => {
    const d = doc(file, 'text');
    if (d.broken) { keep(piece, `${file}: ${d.broken} — no lo toco`, true); return null; }
    if (d.raw === null) { out.absent.push(piece); return null; }
    return d;
  };
  const rm = (piece, p, { recursive = false } = {}) => {
    if (dryRun) { out.removed.push(piece); return true; }
    try { fs.rmSync(p, { force: true, recursive }); out.removed.push(piece); return true; } catch (e) { keep(piece, `no pude borrar ${p} (${e.code || e.message})`, true); return false; }
  };
  // un ENLACE (un junction en Windows) se borra como nombre: unlink y, si no, rmdir; nunca un borrado recursivo, que en un
  // junction podría seguir al clon de la persona (story 8.19, AC 13 b)
  const rmName = (piece, p) => {
    if (dryRun) { out.removed.push(piece); return true; }
    try {
      try { fs.unlinkSync(p); } catch (_) { fs.rmdirSync(p); }
      out.removed.push(piece); return true;
    } catch (e) { keep(piece, `no pude borrar ${p} (${e.code || e.message})`, true); return false; }
  };
  const restoreCopy = (piece, file, copy) => {
    if (dryRun) { out.removed.push(piece); return true; }
    try { writeAtomic(file, fs.readFileSync(copy, 'utf8')); out.removed.push(piece); say(`${file}: vuelve a su copia de antes de instalar`); return true; } catch (e) { keep(piece, `no pude volver ${file} a su copia (${e.code || e.message})`, true); return false; }
  };

  for (const piece of Array.isArray(pieces) ? pieces : []) {
    if (!isObject(piece) || typeof piece.where !== 'string' || typeof piece.id !== 'string') { keep(piece, 'pieza sin la forma del registro'); continue; }
    try {
      switch (piece.kind) {
        case 'hook': {
          const d = json(piece); if (!d) break;
          const { event, relpath } = M.hookId(piece.id);
          const n = dropHooks(d.data, (ev, h) => (!event || ev === event) && isHarnessCommand(h.command, relpath, roots, home));
          // lo que queda y corre ese mismo hook con texto alrededor lo cambió el dev: no se toca, pero se dice (H13)
          const edited = [];
          if (isObject(d.data.hooks)) {
            for (const [ev, groups] of Object.entries(d.data.hooks)) {
              if ((event && ev !== event) || !Array.isArray(groups)) continue;
              for (const g of groups) for (const x of (isObject(g) && Array.isArray(g.hooks) ? g.hooks : [])) {
                if (isObject(x) && typeof x.command === 'string' && mentionsHarnessHook(x.command, relpath, roots, home)) edited.push(x.command);
              }
            }
          }
          if (n) { d.dirty = true; out.removed.push(piece); }
          if (edited.length) out.review.push({ piece, why: `${piece.where}: el hook ${piece.id} del arnés tiene texto agregado (${edited.map((c) => `«${c}»`).join(', ')}): lo cambiaste, no lo toco — sacalo a mano si ya no lo querés` });
          if (!n && !edited.length) out.absent.push(piece);
          break;
        }
        case 'startup-line': {
          const d = json(piece); if (!d) break;
          const n = dropHooks(d.data, (ev, h) => ev === 'SessionStart' && SL.isNew(h.command));
          if (n) { d.dirty = true; out.removed.push(piece); } else out.absent.push(piece);
          break;
        }
        case 'setting': {
          const d = json(piece); if (!d) break;
          const cur = getPath(d.data, piece.id);
          if (cur === undefined) { out.absent.push(piece); break; }
          if (!('value' in piece)) { keep(piece, `${piece.id} sin el valor que puso el arnés en el registro: no sé si es tuyo, lo dejo`); break; }
          if (JSON.stringify(cur) !== JSON.stringify(piece.value)) { keep(piece, `${piece.id} vale ${JSON.stringify(cur)} y el arnés puso ${JSON.stringify(piece.value)}: lo cambiaste, es tuyo`); break; }
          const parts = piece.id.split('.');
          const parent = parts.length > 1 ? getPath(d.data, parts.slice(0, -1).join('.')) : d.data;
          delete parent[parts[parts.length - 1]];
          if (parts.length > 1 && isObject(parent) && !Object.keys(parent).length) delete d.data[parts[0]];
          d.dirty = true; out.removed.push(piece);
          break;
        }
        case 'block': {
          const d = text(piece); if (!d) break;
          const r = dropBlock(d.data, piece.id.replace(/^TYCON_BLOCK:/, ''));
          if (!r.found) { out.absent.push(piece); break; }
          if (r.unclosed) { keep(piece, `${piece.id} en ${piece.where} no tiene marcador de cierre: no adivino dónde termina, revisalo a mano`); break; }
          d.data = r.text; d.dirty = true; out.removed.push(piece);
          break;
        }
        case 'import': {
          const d = text(piece); if (!d) break;
          const lines = d.data.split('\n');
          const ids = importForms(piece.id);
          const left = lines.filter((l) => !ids.has(l.replace(/\r$/, '').trim()));
          if (left.length === lines.length) { out.absent.push(piece); break; }
          d.data = left.join('\n'); d.dirty = true; out.removed.push(piece);
          break;
        }
        case 'link': {
          let st; try { st = fs.lstatSync(piece.where); } catch (_) { out.absent.push(piece); break; }
          if (!st.isSymbolicLink()) {
            // un enlace duro que creó el arnés (canonical-path.js, «LOS ENLACES DUROS QUE CREÓ EL ARNÉS»; story 8.17, W4 ·
            // AC 39 y pase adversarial de la W3W4): se saca si sigue siendo el anotado y se enlazó a este árbol. Un archivo
            // propio con ese nombre no está anotado (o ya no es ése) y queda.
            const hl = ownHardLinkRecord(home, piece.where, treeNorms);
            if (st.isFile() && hl.own) { if (rm(piece, piece.where) && !dryRun) forgetHardLinkRecord(home, hl); break; }
            keep(piece, `${piece.where} es una carpeta o un archivo real, no un enlace: no lo toco`); break;
          }
          const raw = fs.readlinkSync(piece.where);
          const target = norm(path.resolve(path.dirname(piece.where), raw));
          const resolved = real(piece.where);
          // al árbol o ADENTRO (8.7, tanda C): en el repo único ~/.claude/skills → <clon>/skills, agents → <clon>/agents y
          // los enlaces por entrada apuntan adentro del clon. Por la ruta escrita (vale colgado) o por la real
          const within = (p) => treeNorms.some((t) => p === t || p.startsWith(`${t}/`));
          // el nombre viejo del lugar apunta AL LUGAR, no al árbol (story 8.19): es del arnés aunque el lugar ya se haya
          // quitado y él haya quedado colgado. Pero si el lugar sigue y apunta a OTRO clon (un --link de la persona), el
          // viejo también queda: borrarlo dejaría ese clon fuera de lo que todavía lee por el viejo (segunda vuelta, M1)
          const placeNow = require('./place.js').placePath(home);
          const placeReal = real(placeNow);
          const toPlace = target === norm(placeNow) && (!lexists(placeNow) || !placeReal || within(norm(placeReal)));
          const toTree = within(target) || (resolved && within(norm(resolved))) || toPlace;
          if (!toTree) { keep(piece, `${piece.where} apunta a ${raw}, no al árbol${tree ? ` ${tree}` : ''}: no lo toco`); break; }
          rmName(piece, piece.where);
          break;
        }
        case 'command': {
          if (!lexists(piece.where)) { out.absent.push(piece); break; }
          const mine = tree ? path.join(tree, 'commands', piece.id) : null;
          if (mine && fs.existsSync(mine)) {
            if (fs.readFileSync(mine, 'utf8') !== fs.readFileSync(piece.where, 'utf8')) { keep(piece, `${piece.where} no es igual al del arnés: lo cambiaste, lo dejo`); break; }
          } else if (!asInstalled(piece.where)) {
            // sin su par en el árbol (vuelta atrás a una versión anterior al comando, clon borrado) sólo se sabe que es del
            // arnés si sigue como lo dejó la instalación; si no, puede tener texto del dev (H6)
            keep(piece, `${piece.where}: el árbol no trae commands/${piece.id} para comparar y no sigue como lo dejó la instalación — puede ser tuyo, lo dejo`); break;
          }
          const c = copyOf(piece.where).copy;
          if (typeof c === 'string' && fs.existsSync(c)) restoreCopy(piece, piece.where, c);
          else rm(piece, piece.where);
          break;
        }
        case 'git-hook': {
          if (!lexists(piece.where)) { out.absent.push(piece); break; }
          // sólo en la carpeta de los hooks globales (la misma clase que `file`/`codex`: revisión de seguridad, iter. 2)
          if (!inside(piece.where, gitHooksDir)) { keep(piece, `${piece.where} no está en ${gitHooksDir}: no lo toco`); break; }
          const body = fs.readFileSync(piece.where, 'utf8');
          const src = tree ? path.join(tree, 'scripts', 'hooks', `git-${piece.id}-global.sh`) : null;
          const ours = body.includes(`git-${piece.id}-global.sh`) || (src && fs.existsSync(src) && fs.readFileSync(src, 'utf8') === body);
          if (!ours) { keep(piece, `${piece.where} ya no es el del arnés: no lo toco`); break; }
          if (!rm(piece, piece.where)) break;
          const local = `${piece.where}.local`;
          if (lexists(local) && !dryRun) {
            try { fs.renameSync(local, piece.where); say(`${local} vuelve a ${piece.where}`); } catch (e) { keep(piece, `quité el del arnés pero no pude volver ${local} a ${piece.where} (${e.code || e.message})`, true); }
          }
          break;
        }
        case 'launch-agent': {
          if (!lexists(piece.where)) { out.absent.push(piece); break; }
          if (!inside(piece.where, launchAgentsDir)) { keep(piece, `${piece.where} no está en ${launchAgentsDir}: no lo toco`); break; }
          const bin = env.LAUNCHCTL_BIN || (platform === 'darwin' ? 'launchctl' : null);
          if (bin && !dryRun) {
            const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
            const r = spawnSync(bin, ['bootout', `gui/${uid}`, piece.where], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
            if (r.status !== 0) spawnSync(bin, ['unload', piece.where], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
          }
          rm(piece, piece.where);
          break;
        }
        case 'codex': {
          // sólo bajo CODEX_HOME o el espejo AGENTS.md: una ruta registrada que cae afuera no se toca (revisión de seguridad)
          if (!inside(piece.where, codexHome) && !sameFile(piece.where, mirror)) { keep(piece, `${piece.where} no está bajo ${codexHome} ni es el espejo ${mirror}: no la toco`); break; }
          const base = path.basename(piece.where);
          if (piece.id === 'AGENTS.md' || base === 'AGENTS.md') {
            const d = text(piece); if (!d) break;
            const names = blockNames(d.data);
            let t = d.data; let n = 0;
            for (const name of names) { const r = dropBlock(t, name); if (r.found && !r.unclosed) { t = r.text; n++; } }
            // el espejo es copia del CLAUDE.md entero: si en esta tanda se va el @import de CLAUDE.md, se va también su copia
            const lines = t.split('\n');
            const left = lines.filter((l) => !importIds.has(l.replace(/\r$/, '').trim()));
            if (left.length !== lines.length) { t = left.join('\n'); n++; }
            if (n) { d.data = t; d.dirty = true; out.removed.push(piece); } else out.absent.push(piece);
            break;
          }
          if (!lexists(piece.where)) { out.absent.push(piece); break; }
          if (piece.id === 'hooks.json' || piece.id === 'config.toml') {
            // se borra sólo si no existía antes de instalar Y sigue byte a byte como lo dejó esa instalación: una
            // reinstalación pudo encontrarlo con contenido del dev (H15). Si no, «revisalo»: nunca se pierde lo suyo
            const k = copyOf(piece.where);
            if (k.has && k.copy === null && asInstalled(piece.where)) rm(piece, piece.where);
            else out.review.push({ piece, why: `${piece.where}: ya existía antes de instalar, o cambió desde que lo dejó la instalación (o no hay copia que lo diga): el despliegue de Codex le sumó lo suyo, revisalo a mano` });
            break;
          }
          rm(piece, piece.where, { recursive: true });
          break;
        }
        case 'third-party':
          keep(piece, `la skill de terceros ${piece.id} (${piece.where}): vive dentro del árbol, no la toco`);
          break;
        case 'file':
          if (!lexists(piece.where)) { out.absent.push(piece); break; }
          // sólo dentro de la carpeta de la copia fija: una ruta registrada que cae afuera no se borra (revisión de seguridad)
          if (!inside(piece.where, fixedDir)) { keep(piece, `${piece.where} no está bajo ${fixedDir}: no la toco`); break; }
          rm(piece, piece.where, { recursive: true });
          break;
        default:
          keep(piece, `tipo de pieza desconocido «${piece.kind}»: no sé quitarla, no la toco`);
      }
    } catch (e) {
      keep(piece, `no pude quitarla (${e.code || e.message})`, true);
    }
  }

  // se escriben los archivos tocados; si quedaron iguales a su copia de antes de instalar, con los bytes de la copia
  for (const [file, d] of docs) {
    if (!d.dirty || dryRun) continue;
    try {
      const { copy } = copyOf(file);
      if (typeof copy === 'string') {
        let c = null; try { c = fs.readFileSync(copy, 'utf8'); } catch (_) { c = null; }
        if (c !== null) {
          let equal = false;
          if (d.type === 'json') { try { equal = sameJson(d.data, JSON.parse(c.replace(BOM, ''))); } catch (_) { equal = false; } } else equal = sameText(d.data, c);
          if (equal) { writeAtomic(file, c); say(`${file}: igual al de antes de instalar, vuelve byte a byte`); continue; }
        }
      }
      const empty = d.type === 'json' ? comparable(d.data) === '{}' : !d.data.trim();
      if (copy === null && empty) { fs.rmSync(file, { force: true }); say(`${file}: no existía antes de instalar y quedó vacío, se borra`); continue; }
      writeAtomic(file, d.type === 'json' ? `${JSON.stringify(d.data, null, 2)}\n` : d.data);
    } catch (e) {
      // lo quitado de ese archivo no quedó escrito: esas piezas no se quitaron
      const lost = out.removed.filter((p) => p.where === file);
      out.removed = out.removed.filter((p) => p.where !== file);
      for (const p of lost) keep(p, `no pude escribir ${file} (${e.code || e.message})`, true);
    }
  }
  return out;
}

module.exports = { removePieces, dropBlock, isHarnessCommand, hookRoots };
