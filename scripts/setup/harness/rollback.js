'use strict';
// rollback.js — la vuelta atrás por piezas: a qué copia se vuelve y cómo se restaura.
// Lo comparten `harness.js rollback` y la comprobación de salud que falla después de una actualización.
//
// El destino (`pickTarget`): sin `--to`, la copia más nueva (mayor `seq`) cuyos `sources` difieren de los HEAD actuales —la
// que se tomó antes de mover los árboles—; las copias de `startup`/`apply` posteriores, de la misma versión, no cuentan. Así
// un segundo `rollback` vuelve a la copia `before-rollback` del primero: un rollback se deshace con otro. Basta con que
// difiera UNA fuente: un hook nuevo de agent-skills no cambia el número de versión (sale del arnés) y también se deshace.
// Si ninguna copia tiene `sources` (sin ese dato), la más nueva y sólo archivos, y se dice.
//
// La restauración (`restore`), en este orden:
//   (1) cada archivo de la copia cuyo hash actual es su `sha256_after` (nadie lo tocó desde el cambio) vuelve ENTERO a como
//       estaba; si cambió después (un permiso que agregó Claude Code, una línea propia) se avisa y se deja: de él se quitan
//       sólo las piezas, en (4). `existed: false` → se borra sólo si sigue siendo pieza registrada del arnés.
//   (2) en `managed`, cada fuente a los `sources` de la copia con `sources.revert` (stash propio + `reset --hard` sobre su
//       rama: `main` interno o `tycon/installed`); NUNCA `checkout <commit>` —la rama queda en `main`, atrás de origin—.
//       Antes de tocar nada se mira que cada fuente esté en su rama y que el commit esté en el
//       clon: si una no se puede mover no se toca nada, y se dice. Un árbol sucio: el stash propio de `revert`; si no pudo
//       apartarlo, no se mueve y se dice. En `developer` este paso no existe: el árbol es el clon del dev.
//   (3) el aplicador de ese árbol con `--report-json` (el `runApplier` de harness.js: así no se duplica). Su reporte se
//       suma a las piezas compartidas que `runApplier` hizo antes de lanzarlo: las dos son «lo que esta
//       versión deja», y sin las compartidas el paso (4) las quitaría recién hechas.
//   (4) se quita lo registrado que ese reporte ya no trae (no se usa `managed[].version`), salvo las piezas
//       propias de harness.js (el `@import`, la línea de arranque, la copia fija) — con `remove.js`. Un bloque que se va
//       de CLAUDE.md se va también del espejo ~/.codex/AGENTS.md si es pieza registrada (el espejo es copia entera). Lo
//       que el paso (1) volvió ENTERO y sigue así no se quita: son los bytes de antes del cambio.
//   (5) `managed` sale de ese reporte (la unión de managed.js, sin lo quitado ni lo que volvió entero).
// Capa privada: una fuente `layer` no es un árbol —su clon de lectura es --bare— y (2) no la mueve. Quien
// llama pasa `beforeTrees()` (corre justo antes de mover los árboles: lo pisado por la capa vuelve al público) y
// `afterTrees(copia | null)` (después de (2) y antes del aplicador: re-apila la capa en el commit de la copia, o donde
// estaba con `null` si los árboles no se pudieron mover; devuelve lo que movió). Sin capa no se pasan y nada cambia.
// `ok: false` si algún paso falló, también si `remove.js` dejó algo por un error (`kept[].error`) o tiró.
// `restore` cambia `state.managed` y `state.sources[].commit/previous`; el resto del estado (`version`, `hold`, `notice`) y
// la copia `before-rollback` los escribe harness.js.
//
// Núcleo público: corre desde la copia fija (`~/.claude/.tycon-pipeline/harness/program/harness/`), así que no hace
// `require` fuera de scripts/setup/harness/. Funciones puras respecto del HOME: reciben `home`/`env`.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { paths } = require('./state.js');
const sources = require('./sources.js');
const managed = require('./managed.js');
const report = require('./report.js');
const shared = require('./shared.js');
const startupLine = require('./startup-line.js');

const sha7 = (s) => (s ? String(s).slice(0, 7) : '—');
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const pieceKey = (p) => `${p.kind}\u0000${p.where}\u0000${p.id}`;
const seqOf = (c) => (c && c.manifest && Number.isInteger(c.manifest.seq) && c.manifest.seq > 0 ? c.manifest.seq : null);
const hasSources = (c) => Boolean(c && c.manifest && isObject(c.manifest.sources) && Object.keys(c.manifest.sources).length);

/** Más nueva primero por `seq`; las que no lo tienen (sin ese dato) van debajo, en el orden en que vinieron. */
function newestFirst(copies) {
  return copies.map((c, i) => ({ c, i })).sort((a, b) => {
    const sa = seqOf(a.c); const sb = seqOf(b.c);
    if (sa !== null && sb !== null && sa !== sb) return sb - sa;
    if (sa === null && sb !== null) return 1;
    if (sb === null && sa !== null) return -1;
    return a.i - b.i;
  }).map((x) => x.c);
}

/** ¿Los `sources` de una copia son de otra versión que la instalada? Basta con una fuente que difiera. */
function differs(copySources, current) {
  const cur = isObject(current) ? current : {};
  return Object.entries(copySources).some(([name, sha]) => typeof cur[name] === 'string' && cur[name] && sha !== cur[name]);
}

/**
 * A qué copia vuelve `rollback`. `copies` es `snapshot.list()` (`[{ dir, name, manifest }]`, en cualquier orden);
 * `to` = el nombre de la carpeta, su `seq` o su ruta; `currentSources` = `{ <fuente>: <HEAD> }`.
 * @returns {{ copy: object|null, filesOnly: boolean, reason: string }}  `copy: null` = nada que hacer (y `reason` dice por qué)
 */
function pickTarget(copies, { to = null, currentSources = {} } = {}) {
  const list = newestFirst((Array.isArray(copies) ? copies : []).filter((c) => c && isObject(c.manifest)));
  if (to !== null && to !== undefined && String(to) !== '') {
    const want = String(to);
    const hit = list.find((c) => c.name === want)
      || list.find((c) => String(seqOf(c)) === want)
      || list.find((c) => c.dir && path.resolve(c.dir) === path.resolve(want));
    if (!hit) return { copy: null, filesOnly: false, reason: `no hay una copia «${want}» (harness.js rollback --list las muestra)` };
    if (!hasSources(hit)) return { copy: hit, filesOnly: true, reason: `la copia ${hit.name} no tiene sources (es anterior a la tanda C): sólo restauro archivos, los árboles no se mueven` };
    return { copy: hit, filesOnly: false, reason: `la copia ${hit.name} (seq ${seqOf(hit) || '—'}, ${hit.manifest.reason || 'sin motivo'})` };
  }
  if (!list.length) return { copy: null, filesOnly: false, reason: 'no hay copias de seguridad: no hay a qué volver' };
  if (!list.some(hasSources)) {
    const c = list[0];
    return { copy: c, filesOnly: true, reason: `ninguna copia tiene sources (son anteriores a la tanda C): vuelvo a la más nueva, ${c.name}, sólo archivos — los árboles no se mueven` };
  }
  const hit = list.find((c) => hasSources(c) && differs(c.manifest.sources, currentSources));
  if (!hit) return { copy: null, filesOnly: false, reason: 'todas las copias son de la versión instalada: nada que deshacer (harness.js rollback --list las muestra; --to elige una)' };
  return { copy: hit, filesOnly: false, reason: `la copia ${hit.name} (seq ${seqOf(hit) || '—'}, ${hit.manifest.reason || 'sin motivo'}), de antes de la versión instalada` };
}

// ── ayudantes de la restauración ──────────────────────────────────────────────────────────────────────────────────────

/** sha256 del archivo, o null si no está. Otro error (permisos, una carpeta) tira: no se miente «no está». */
function hashOf(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
    throw e;
  }
}

/** Escribe bytes atómico (temporal al lado + rename), con el modo que tenía la copia. */
function writeBytesAtomic(file, buf, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, buf);
  if (mode) { try { fs.chmodSync(tmp, mode & 0o777); } catch (_) { /* el modo es cortesía: el contenido ya está */ } }
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ya no está */ } throw e; }
}

/** Las piezas propias de harness.js (no las saca ni las repone el aplicador): el `@import`, la línea de arranque y los
 *  archivos de la copia fija (todo lo que vive en ~/.claude/.tycon-pipeline/harness/). Mismo criterio que harness.js. */
function defaultIsOwnPiece(home) {
  const dir = path.resolve(paths(home).harnessDir);
  return (p) => p.kind === 'import' || p.kind === 'startup-line' || (p.kind === 'file' && path.resolve(String(p.where)).startsWith(dir + path.sep));
}

/** `remove.js` (el agente «quitar»). Sin él, la restauración no puede quitar piezas: lo dice, no lo inventa. */
function loadRemove() {
  try { return require('./remove.js'); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && /remove\.js/.test(String(e.message))) return null;
    throw e;
  }
}

const describe = (x) => {
  if (typeof x === 'string') return x;
  if (isObject(x) && x.kind) return managed.describe(x);
  if (isObject(x) && x.piece) return `${managed.describe(x.piece)}${x.why ? ` (${x.why})` : ''}`;
  return JSON.stringify(x);
};

/** Paso (1): los archivos enteros. Devuelve `{ restored, warned, problems }` (rutas y líneas). */
function restoreFiles(copy, state, { say }) {
  const files = Array.isArray(copy.manifest.files) ? copy.manifest.files : [];
  const out = { restored: [], warned: [], problems: [] };
  if (!files.some((f) => f && typeof f.sha256_after === 'string')) {
    say(`la copia ${copy.name} no quedó cerrada (sin sha256_after): no restauro archivos enteros; vuelvo sólo por piezas`);
    return out;
  }
  const registered = new Set((Array.isArray(state.managed) ? state.managed : []).map((p) => p && p.where).filter(Boolean));
  for (const f of files) {
    if (!f || typeof f.path !== 'string') continue;
    let cur;
    try { cur = hashOf(f.path); } catch (e) { out.problems.push(`${f.path}: no lo pude leer (${e.code || e.message}): lo dejo como está`); continue; }
    const before = f.existed ? (f.sha256 || null) : null;
    const after = typeof f.sha256_after === 'string' ? f.sha256_after : null;
    if (cur === before) continue;                                   // ya está como antes del cambio
    if (cur !== after) { out.warned.push(f.path); continue; }        // cambió después: se avisa y se deja
    try {
      if (f.existed) {
        const src = path.join(copy.dir, f.copy || '');
        if (!f.copy || hashOf(src) !== before) { out.problems.push(`${f.path}: la copia de ${copy.name} no está o no coincide con su sha256: no lo restauro`); continue; }
        let mode = null;
        try { mode = fs.statSync(src).mode; } catch (_) { mode = null; }
        writeBytesAtomic(f.path, fs.readFileSync(src), mode);
        out.restored.push(f.path);
      } else if (registered.has(f.path)) {
        fs.rmSync(f.path, { force: true });                          // no existía antes y sigue siendo pieza del arnés
        out.restored.push(f.path);
      } else {
        out.warned.push(f.path);                                     // no existía antes, pero ya no es del arnés: no lo borro
      }
    } catch (e) { out.problems.push(`${f.path}: no lo pude restaurar (${e.code || e.message}): queda como está`); }
  }
  for (const p of out.restored) say(`restaurado entero (nadie lo tocó desde el cambio): ${p}`);
  for (const p of out.warned) say(`${p} cambió después de esa copia (alguien lo tocó): no lo restauro entero; le quito sólo las piezas del arnés`);
  for (const l of out.problems) say(l);
  return out;
}

/** Una ruta comparable: absoluta y sin el `/private` con que macOS resuelve /tmp y /var (el manifiesto y el registro
 *  pueden escribir una u otra). */
const comparablePath = (p) => path.resolve(String(p)).replace(/^\/private(?=\/(?:var|tmp|etc)\/)/, '');

/** Lo que el paso (1) volvió entero a sus bytes de antes del cambio y sigue así (el aplicador del paso 3 no lo tocó). */
function intactRestored(copy, restored) {
  const back = new Set((restored || []).map(comparablePath));
  const out = new Set();
  for (const f of Array.isArray(copy.manifest.files) ? copy.manifest.files : []) {
    if (!f || !f.existed || typeof f.path !== 'string' || !back.has(comparablePath(f.path))) continue;
    let cur = null;
    try { cur = hashOf(f.path); } catch (_) { cur = null; }   // ilegible: no se da por intacto (se trata por piezas)
    if (cur && cur === f.sha256) out.add(comparablePath(f.path));
  }
  return out;
}

/** El espejo de Codex: por cada bloque registrado que el reporte ya no trae, la misma pieza en cada `AGENTS.md` registrado
 *  (pieza `codex`), salvo que el reporte la traiga ahí, ya esté registrada ahí (la quita `gone`) o el espejo haya vuelto
 *  entero a como estaba. `remove.js` la quita del `where` de la pieza: la API pública, sin nada nuevo. */
function mirrorBlocks(prev, reportList, reported, own, untouchedKeys, intact) {
  const isAgents = (p) => p.kind === 'codex' && (p.id === 'AGENTS.md' || path.basename(String(p.where)) === 'AGENTS.md');
  const agents = [...new Set(prev.concat(reportList || []).filter((p) => isObject(p) && p.where && isAgents(p)).map((p) => p.where))];
  if (!agents.length) return [];
  const prevKeys = new Set(prev.map(pieceKey));
  const out = []; const seen = new Set();
  for (const b of prev) {
    if (b.kind !== 'block' || reported.has(pieceKey(b)) || own(b) || untouchedKeys.has(pieceKey(b))) continue;
    for (const where of agents) {
      if (comparablePath(where) === comparablePath(b.where) || intact.has(comparablePath(where))) continue;
      const m = { kind: 'block', where, id: b.id };
      const k = pieceKey(m);
      if (reported.has(k) || prevKeys.has(k) || seen.has(k)) continue;
      seen.add(k); out.push(m);
    }
  }
  return out;
}

/**
 * Mira, sin mover nada, si cada fuente puede ir al commit de la copia. `{ moves: [{ st, from, to }], blockers: [] }`
 * Una fuente que se reescribe se mueve sólo desde `tycon/installed`; el motivo, si no está ahí, lo arma
 * `sources.offInstalledBranch` —el mismo de `update` y de `doctor`—: antes de la primera actualización esa rama todavía
 * no existe, y aconsejar `checkout tycon/installed` mandaría a un comando que falla.
 * «No está» y «no se pudo leer» no se confunden: un HEAD ilegible no es «no es
 * un clon», una rama del mecanismo ilegible no es «todavía no existe» (lo contesta `offInstalledBranch`), y un commit de
 * la copia que no se pudo mirar no es «no está en el clon». En los tres casos no se mueve nada y se dice qué no se leyó.
 */
function planTrees(state, copy, env, home) {
  const moves = []; const blockers = []; const notes = [];
  for (const st of Array.isArray(state.sources) ? state.sources : []) {
    if (!st || !st.name || !st.dir || st.kind === 'layer') continue;   // la capa la re-apila quien llama (afterTrees)
    const to = copy.manifest.sources[st.name];
    if (!to) { notes.push(`${st.name}: la copia ${copy.name} no trae su commit: no se mueve`); continue; }
    const from = sources.head(st.dir, { env });
    if (!from) {
      blockers.push(sources.isRepo(st.dir, { env })
        ? `${st.name}: no pude leer HEAD de ${st.dir} (${sources.refState(st.dir, 'HEAD', { env }).reason || 'no apunta a ningún commit'}): no se sabe qué hay instalado`
        : `${st.name}: ${st.dir} no es un clon de git`);
      continue;
    }
    if (from === to) continue;
    const want = st.rewrites ? sources.INSTALLED_BRANCH : (st.ref || 'main');
    const cur = sources.branch(st.dir, { env });
    if (st.rewrites) {
      const off = sources.offInstalledBranch(st, { env, home, onlyFromInstalled: true, who: 'rollback' });
      if (off) { blockers.push(off); continue; }
    } else if (cur !== want) { blockers.push(`${st.name} está en la rama ${cur || '(sin rama)'} y no en ${want}: no se toca (git -C ${st.dir} checkout ${want})`); continue; }
    const target = sources.commitState(st.dir, to, { env });
    if (target.status === 'absent') { blockers.push(`${st.name}: el commit ${sha7(to)} de la copia no está en el clon`); continue; }
    if (target.status === 'problem') { blockers.push(`${st.name}: no pude mirar si el commit ${sha7(to)} de la copia está en el clon (${target.reason})`); continue; }
    moves.push({ st, from, to, branch: want });
  }
  return { moves, blockers, notes };
}

/**
 * Restaura la máquina a la copia `copy` (un elemento de `snapshot.list()`), por piezas. `ctx` = `{ home, env, platform,
 * tree }`; el árbol es `state.tree` (el de `ctx` si el estado no lo trae). Opciones: `why` (rollback | health: prefijo del
 * registro), `runApplier(ctx, tree, { log, snapshotDir })` (el de harness.js), `log(línea)`, `filesOnly` (la de
 * `pickTarget`), `snapshotDir` (la copia que se tomó antes: el aplicador no hace sus `.bak`), `isOwnPiece(p)`.
 * Nunca tira por un paso que falla: lo dice en `lines` y `ok: false`.
 * @returns {{ ok, lines, report, version, moved: [{name, from, to}], undone: {<fuente>: <HEAD de antes>}, restored, warned, removed, kept, review }}
 */
function restore(ctx, state, copy, { why = 'rollback', runApplier = null, log = null, filesOnly = false, snapshotDir = null, isOwnPiece = null, beforeTrees = null, afterTrees = null } = {}) {
  const home = (ctx && ctx.home) || os.homedir();
  const env = (ctx && ctx.env) || process.env;
  const tree = state.tree || (ctx && ctx.tree);
  const lines = [];
  const say = (l) => { lines.push(l); if (log) log(`${why}: ${l}`); };
  const result = { ok: true, lines, report: null, version: null, moved: [], undone: {}, restored: [], warned: [], removed: [], kept: [], review: [] };
  if (!copy || !isObject(copy.manifest)) { result.ok = false; say('sin copia a la que volver'); return result; }
  const developer = state.mode === 'developer';
  const onlyFiles = Boolean(filesOnly) || !hasSources(copy);
  for (const st of Array.isArray(state.sources) ? state.sources : []) {
    if (st && st.name && st.dir) result.undone[st.name] = (st.kind === 'layer' ? st.commit : sources.head(st.dir, { env }) || st.commit) || null;
  }

  // antes de tocar nada: ¿se pueden mover los árboles? Si una fuente no puede, no se toca nada (ni archivos)
  let plan = { moves: [], blockers: [], notes: [] };
  if (!onlyFiles && !developer) {
    plan = planTrees(state, copy, env, home);
    if (plan.blockers.length) {
      result.ok = false;
      for (const b of plan.blockers) say(b);
      say('no se tocó nada: ni archivos ni árboles');
      return result;
    }
  }

  // (1) los archivos enteros que nadie tocó desde el cambio
  const files = restoreFiles(copy, state, { say });
  result.restored = files.restored; result.warned = files.warned;
  if (files.problems.length) result.ok = false;
  if (onlyFiles) {
    say(`la copia ${copy.name} no tiene sources (es anterior a la tanda C): sólo restauré archivos; los árboles y el registro de piezas no se tocaron`);
    return result;
  }

  // (2) los árboles, en managed; en developer no se toca el git del dev
  let treesFailed = false;
  if (developer) {
    say(`modo desarrollador: no toco el git de ${tree} (es tu clon); restauro piezas con el aplicador del árbol actual`);
  } else {
    for (const n of plan.notes) say(n);
    const done = [];
    if (typeof beforeTrees === 'function') {
      try { beforeTrees(); } catch (e) { say(`antes de mover los árboles: ${e.message}`); }
    }
    for (const m of plan.moves) {
      const dirty = sources.git(m.st.dir, ['status', '--porcelain', '--untracked-files=no'], { env }).out !== '';
      const rv = sources.revert(m.st, m.to, { env });
      if (!rv.ok) {
        treesFailed = true;
        say(rv.reason || `${m.st.name}: no pude volver a ${sha7(m.to)}`);
        for (const d of done) {
          const back = sources.revert(d.st, d.from, { env });
          if (back.ok) { d.st.commit = d.from; d.st.previous = null; }
          if (!back.ok || back.kept) say(back.reason || `${d.st.name}: no pude dejarla donde estaba`);
        }
        say(`no se movió ningún árbol${done.length ? ` (${done.map((d) => d.st.name).join(', ')} volvió a donde estaba)` : ''}: corro el aplicador del árbol actual para dejar las piezas coherentes`);
        break;
      }
      done.push(m);
      m.st.previous = m.from;
      m.st.commit = m.to;
      result.moved.push({ name: m.st.name, from: m.from, to: m.to });
      say(`${m.st.name}: ${sha7(m.from)} → ${sha7(m.to)} (rama ${m.branch}, atrás de origin; sin checkout de un commit suelto)`);
      if (rv.kept) say(rv.reason);
      else if (dirty) say(`${m.st.name}: lo que tenías sin commitear se apartó en un stash propio (${sources.STASH_MSG}) y se volvió a aplicar`);
    }
    if (treesFailed) result.ok = false;
    // la capa: en el commit de la copia, o donde estaba si los árboles no se movieron
    if (typeof afterTrees === 'function') {
      try {
        for (const m of afterTrees(treesFailed ? null : copy) || []) {
          result.moved.push(m);
          say(`${m.name}: ${sha7(m.from)} → ${sha7(m.to)} (la capa, re-apilada desde el clon de lectura)`);
        }
      } catch (e) { result.ok = false; say(`la capa no se pudo re-apilar: ${e.message}`); }
    }
  }

  // (3) el aplicador de ese árbol, con el reporte de lo que dejó
  if (typeof runApplier !== 'function') { result.ok = false; say('sin aplicador para correr: no quito piezas ni toco el registro'); return result; }
  let a;
  try { a = runApplier(ctx, tree, { log, snapshotDir }); } catch (e) { a = { ok: false, report: null, reason: e.message }; }
  if (!a || !a.ok) {
    result.ok = false;
    say(`el aplicador de ${tree} falló (${(a && a.reason) || 'sin motivo'}): no quito piezas ni toco el registro`);
    return result;
  }
  // lo que esa versión deja en la máquina: el reporte del aplicador MÁS las piezas compartidas que `runApplier` hizo antes
  // de lanzarlo (`a.shared`). Sin sumarlas, el paso (4) las tomaría por «lo que esta versión ya no trae» y
  // las quitaría recién hechas. Con `union`: un aplicador viejo las reporta él también, y no se repiten
  result.report = Array.isArray(a.report) ? shared.union(a.report, a.shared) : null;
  const derived = report.derive(state, { env });
  result.version = derived && derived.number ? derived.number : null;
  if (!result.report) {
    say('el aplicador no devolvió el reporte de piezas: no quito nada y el registro queda como estaba');
    return result;
  }

  // (4) lo registrado que ese reporte ya no trae, salvo lo propio de harness.js
  const own = typeof isOwnPiece === 'function' ? isOwnPiece : defaultIsOwnPiece(home);
  const opts = { home, env, isStartupLine: startupLine.isNew };
  const reported = new Set(result.report.map(pieceKey));
  const prev = (Array.isArray(state.managed) ? state.managed : []).filter((p) => isObject(p) && p.kind && p.where && p.id);
  // lo que el paso (1) volvió ENTERO a como estaba antes del cambio —y sigue así después del aplicador— no se toca: esos
  // bytes son los de antes (un comando propio que la versión nueva pisó, por ejemplo). Lo que la versión vieja no reporta
  // de ahí no es suyo: sale del registro sin quitarlo de la máquina.
  const intact = intactRestored(copy, files.restored);
  const untouched = prev.filter((p) => !reported.has(pieceKey(p)) && !own(p) && intact.has(comparablePath(p.where)));
  for (const p of untouched) say(`queda como estaba antes del cambio (lo restauré entero): ${describe(p)}; sale del registro`);
  const untouchedKeys = new Set(untouched.map(pieceKey));
  // lo que ya no está en la máquina (el archivo entero volvió en el paso 1) no hay que quitarlo: sale del registro en (5)
  const gone = prev.filter((p) => !reported.has(pieceKey(p)) && !own(p) && !untouchedKeys.has(pieceKey(p)) && managed.present(p, opts) !== false);
  // el espejo de Codex (~/.codex/AGENTS.md) es copia del CLAUDE.md entero: un bloque que se va de CLAUDE.md se va también de
  // ahí —si el espejo es pieza registrada—, aunque el aplicador lo haya vuelto a espejar en el paso (3)
  const mirrors = mirrorBlocks(prev, result.report, reported, own, untouchedKeys, intact);
  const toRemove = gone.concat(mirrors);
  const removedKeys = new Set();
  if (toRemove.length) {
    const R = loadRemove();
    if (!R || typeof R.removePieces !== 'function') {
      result.ok = false;
      say(`no puedo quitar ${toRemove.length} pieza(s) que esta versión ya no trae (falta remove.js): ${toRemove.map(describe).join(', ')}`);
    } else {
      let res;
      // si remove.js tira, nada se quitó: todo queda, como fallo (para que otra corrida lo reintente)
      try { res = R.removePieces(toRemove, { home, env, tree, log }); } catch (e) { res = { removed: [], kept: toRemove.map((p) => ({ piece: p, why: `no pude quitarla (${e.message})`, error: true })), review: [] }; }
      result.removed = Array.isArray(res && res.removed) ? res.removed : [];
      result.kept = Array.isArray(res && res.kept) ? res.kept : [];
      result.review = Array.isArray(res && res.review) ? res.review : [];
      for (const p of result.removed) { if (isObject(p)) removedKeys.add(pieceKey(p)); say(`quitada (esta versión ya no la trae): ${describe(p)}`); }
      for (const k of result.kept) say(`quedó: ${describe(k)}`);
      for (const r of result.review) say(`revisalo: ${describe(r)}`);
      // lo que quedó por decisión (es del dev) no es un fallo; lo que quedó por un error, sí
      if (result.kept.some((k) => isObject(k) && k.error === true)) result.ok = false;
    }
  }

  // (5) el registro sale de ese reporte: lo quitado se va; lo que ya no está en la máquina también (managed.merge); lo
  // que volvió entero a como estaba antes, también
  state.managed = managed.merge(prev.filter((p) => !removedKeys.has(pieceKey(p)) && !untouchedKeys.has(pieceKey(p))), result.report, {
    version: result.version,
    present: (p) => (own(p) ? true : managed.present(p, opts)),
  });
  return result;
}

module.exports = { pickTarget, restore, newestFirst, defaultIsOwnPiece };
