'use strict';
// relocate.js — `harness.js relocate [--check]`: muda A MANO lo registrado por el nombre viejo del lugar del arnés.
//
// ── EL PORQUÉ ─────────────────────────────────────────────────────────────────────────────────────────────────────
// El lugar del arnés se llama como el repo público (`place.js`) y el nombre viejo sigue resolviendo en las
// máquinas ya instaladas. Lo que una máquina registró por el nombre viejo —hooks, permisos, los `.local` de git, Codex,
// LaunchAgents, comandos y la línea de CLAUDE.md— sigue andando, pero el día que el viejo se retire se rompe.
// Ninguna máquina se muda sola: la mudanza por el perfil es el primer paso del retiro. Esto es el
// comando a mano. `startup`, `update` y `apply` nunca lo llaman.
//
// ── QUÉ HACE, EN ORDEN ────────────────────────────────────────────────────────────────────────────────────────────
//   1. comprueba, sólo leyendo, que el lugar y el viejo resuelven a la misma carpeta (`samePath`) y que la copia fija de
//      arranque ya es la del árbol (la vieja no sabe desinstalar un hook registrado por el lugar). Si no cierra: no toca
//      nada, sale 1 y dice la causa y el comando;
//   2. (harness.js) toma la copia del mecanismo, `reason: relocate`;
//   3. corre `--reroot <viejo> <lugar>` de `scripts/lib/legacy-names.js` (del árbol): reescribe hooks y demás, AGREGA la
//      forma nueva al lado de cada permiso, y saca un hook que ya estaba por la ruta real del clon;
//   4. cambia la línea `@~/.claude/<viejo>/README.md` de CLAUDE.md por la de hoy, `@~/.claude/<lugar>/INDEX.md` (si
//      están las dos, queda una) y el id de su pieza registrada;
//   5. dice una línea por archivo cambiado y el total.
// No guarda estado: es textual e idempotente. Una corrida cortada se termina corriéndolo otra vez (nunca restaurando
// desde una copia: se perdería lo que otra sesión guardó en el medio). Corre igual en `managed` y `developer` y no mira
// `update.apply` ni TYCON_UPDATE.
//
// TYCON_RELOCATE_DIE_AT=<paso> (after-snapshot | after-reroot | after-import) es SÓLO de prueba: mata el proceso en ese
// punto, para medir que una segunda corrida termina lo que faltaba (harness-relocate.test.js, T25).
const fs = require('fs');
const path = require('path');
const PLACE = require('./place.js');

const STEPS = ['after-snapshot', 'after-reroot', 'after-import'];
const IMPORT = require('./import-line.js');
const NEW_IMPORT = IMPORT.IMPORT_LINE;
const OLD_IMPORT = IMPORT.LEGACY_PLACE_FORMS.find((l) => l.endsWith('/README.md'));
const lexists = (p) => { try { fs.lstatSync(p); return true; } catch (_) { return false; } };
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };
const claudeMdPath = (ctx) => ctx.env.CLAUDE_MD_PATH || path.join(ctx.home, '.claude', 'CLAUDE.md');
const trimmed = (l) => l.replace(/\r$/, '').trim();

/**
 * CLAUDE.md con la línea del índice en su forma de hoy: la del nombre viejo (o la del README.md que era el índice) pasa al
 * lugar y a INDEX.md; si ya estaba la de hoy, la vieja se va (queda una). La regla vive en import-line.js.
 */
function swapImport(text) {
  const r = IMPORT.rewrite(text, { relocate: true });
  return { text: r.text, changed: r.changed };
}

/** La biblioteca de `--reroot` del árbol, o el motivo por el que no está. */
function rerootLib(tree) {
  let lib;
  try { lib = require(path.join(tree, 'scripts', 'lib', 'legacy-names.js')); } catch (e) {
    return { problem: `no pude cargar scripts/lib/legacy-names.js de ${tree} (${e && e.message ? e.message : e})` };
  }
  if (typeof lib.rerootMachine !== 'function' || typeof lib.countRegistered !== 'function') {
    return { problem: `el árbol ${tree} no trae --reroot (legacy-names.js de antes de esta versión): harness.js update primero` };
  }
  return { lib };
}

/**
 * Las precondiciones, sólo leyendo. `bootstrap` es el `bootstrapStatus` de harness.js.
 * @returns {{ nothing?: string, problems: string[], lib?: object, place: string, legacy: string }}
 */
function preconditions(ctx, state, { bootstrap }) {
  const place = PLACE.placePath(ctx.home);
  const legacy = PLACE.legacyPlacePath(ctx.home);
  const out = { problems: [], place, legacy };
  let st = null;
  try { st = fs.lstatSync(legacy); } catch (_) { st = null; }
  if (st && st.isDirectory() && !st.isSymbolicLink()) {
    // el clon vive en el nombre viejo: lo registrado por él es lo registrado por la ruta real, y esa carpeta no se retira
    out.nothing = `nada que mudar: el nombre viejo ${legacy} es una carpeta real (tu clon); lo registrado por él es lo registrado por tu clon`;
    return out;
  }
  // sin el viejo (o colgado) lo que quedó registrado por él está roto, y mudarlo es justo lo que sirve: --reroot es
  // textual y no necesita que el viejo exista
  const rp = real(place); const rl = st ? real(legacy) : null;
  if (!rp) out.problems.push(`el lugar ${place} no resuelve, y sin él no hay a dónde mudar — harness.js install (o install-tycon-hooks.sh) lo crea; después, harness.js relocate`);
  else if (rl && !PLACE.samePath(rp, rl, ctx.platform)) out.problems.push(`el lugar (→ ${rp}) y el nombre viejo (→ ${rl}) son carpetas distintas: elegí una con install-tycon-hooks.sh --link <ruta>; después, harness.js relocate`);
  const b = bootstrap || { missing: [], vsState: [], vsTree: [] };
  const stale = [...b.missing, ...b.vsState, ...b.vsTree];
  if (stale.length) out.problems.push(`la copia fija de arranque no es la del árbol (${[...new Set(stale)].join(', ')}): la vieja no sabe desinstalar un hook registrado por el lugar — harness.js update (o install) la refresca; después, harness.js relocate`);
  const L = rerootLib(state.tree);
  if (L.problem) out.problems.push(L.problem); else out.lib = L.lib;
  return out;
}

/** Los ids de las piezas `import` registradas con una forma vieja (pasan a la de hoy; si ya estaba, queda una). */
function relocatePieces(managed) {
  if (!Array.isArray(managed)) return { managed, changed: 0 };
  let changed = 0;
  const hasNew = (where) => managed.some((p) => p && p.kind === 'import' && p.id === NEW_IMPORT && p.where === where);
  const out = [];
  for (const p of managed) {
    if (p && p.kind === 'import' && p.id !== NEW_IMPORT && IMPORT.ALL_FORMS.includes(p.id)) {
      changed++;
      if (hasNew(p.where) || out.some((x) => x && x.kind === 'import' && x.id === NEW_IMPORT && x.where === p.where)) continue;
      out.push(Object.assign({}, p, { id: NEW_IMPORT }));
      continue;
    }
    out.push(p);
  }
  return { managed: out, changed };
}

/** Lo que cambiaría, sin escribir: { reroot, import, pieces, total }. */
function measure(ctx, state, pre) {
  const reroot = pre.lib.rerootMachine({ from: pre.legacy, to: pre.place, home: ctx.home, env: ctx.env, platform: ctx.platform, check: true });
  let text = '';
  try { text = fs.readFileSync(claudeMdPath(ctx), 'utf8'); } catch (_) { text = ''; }
  const imp = swapImport(text).changed;
  const pieces = relocatePieces(state.managed).changed;
  return { reroot, import: imp, pieces, total: reroot.rerooted + imp + pieces, check: true };
}

function dieAt(ctx, step) {
  if (STEPS.includes(step) && ctx.env.TYCON_RELOCATE_DIE_AT === step) process.kill(process.pid, 'SIGKILL');
}

/** La mudanza (dentro del candado y después de la copia). Cambia `state.managed`; quien llama escribe el estado. */
function apply(ctx, state, pre) {
  const reroot = pre.lib.rerootMachine({ from: pre.legacy, to: pre.place, home: ctx.home, env: ctx.env, platform: ctx.platform, check: false });
  dieAt(ctx, 'after-reroot');
  const file = claudeMdPath(ctx);
  let imp = 0; const notes = [];
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') notes.push(`CLAUDE.md (${file}): no pude leerlo (${e.code || e.message}) — la línea sigue por el nombre viejo, que resuelve`); }
  if (text !== null) {
    const s = swapImport(text);
    if (s.changed) {
      try { require('./state').writeAtomic(file, s.text); imp = s.changed; } catch (e) { notes.push(`CLAUDE.md (${file}): no pude reescribirlo (${e.code || e.message}) — la línea sigue por el nombre viejo, que resuelve`); }
    }
  }
  dieAt(ctx, 'after-import');
  const p = relocatePieces(state.managed);
  if (p.changed) state.managed = p.managed;
  return { reroot, import: imp, pieces: p.changed, total: reroot.rerooted + imp + p.changed, notes, check: false };
}

/** Las líneas para la persona: una por archivo, los hooks que se fueron, los avisos y el total. */
function describe(res, { snapshot = null } = {}) {
  const L = [];
  if (!res.total) {
    L.push('nada que cambiar: no queda nada registrado por el nombre viejo (los permisos quedan con las dos formas a propósito: los saca el retiro del nombre viejo)');
    for (const n of [...(res.reroot.notes || []), ...(res.notes || [])]) L.push(`  ⚠ ${n}`);
    return L;
  }
  const verb = res.check ? 'cambiaría' : 'cambió';
  L.push(res.check ? `relocate --check: esto pasaría del nombre viejo al lugar (no escribí nada):` : 'relocate: del nombre viejo al lugar');
  let files = 0;
  for (const f of res.reroot.files) {
    files++;
    L.push(`  ${verb} ${f.label}: ${f.rerooted}${f.permissions_added ? ` (${f.permissions_added} permiso(s): la forma nueva al lado de la vieja, que queda)` : ''}${f.note ? ` — ${f.note}` : ''}`);
  }
  if (res.import) { files++; L.push(`  ${verb} CLAUDE.md: la línea ${OLD_IMPORT} → ${NEW_IMPORT}`); }
  if (res.pieces) L.push(`  ${verb} el registro: la pieza de esa línea`);
  for (const d of res.reroot.dropped || []) L.push(`  ${res.check ? 'saldría' : 'salió'} de ${d.label} (${d.event}): ${d.command} — ${d.why === 'twin' ? 'ya estaba por la ruta real del clon' : 'quedaba repetido'}`);
  for (const n of [...(res.reroot.notes || []), ...(res.notes || [])]) L.push(`  ⚠ ${n}`);
  if (!res.check && (res.reroot.files || []).some((f) => f.label === 'codex/hooks.json')) L.push('  en Codex, los hooks cambiados piden otra aprobación: corré /hooks');
  L.push(`total: ${res.total} cambio(s) en ${files} archivo(s)`);
  if (snapshot) L.push(`la copia de antes: ${snapshot}; además, cada archivo cambiado tiene su .bak-reroot-<fecha> (los .plist, en ~/.claude/.tycon-pipeline/reroot-bak/)`);
  if (res.check) L.push('para hacerlo: harness.js relocate');
  return L;
}

module.exports = { STEPS, NEW_IMPORT, OLD_IMPORT, swapImport, rerootLib, preconditions, relocatePieces, measure, apply, describe, dieAt };
