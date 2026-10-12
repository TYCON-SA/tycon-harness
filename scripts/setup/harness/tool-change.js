'use strict';
// tool-change.js — sumar o sacar una herramienta en una máquina que YA tiene el arnés (story 8.23, tanda C · AC 26).
//
// ── EL CASO ───────────────────────────────────────────────────────────────────────────────────────────────────────
// Una persona instala el arnés con la herramienta que tiene y después suma la otra (o deja de usar una). Hasta la
// tanda C eso era «instalá todo otra vez»: el instalador volvía a escribir los enchufes de las dos, y sacar una no
// existía (sólo `uninstall` entero). Acá:
//   · `install --tool <la nueva>`  enchufa SÓLO esa, desde el árbol que ya está: sin red, sin cambiar de versión y sin
//                                  tocar los enchufes de la otra (ni corre su instalador).
//   · `uninstall --tool <una>`     quita SÓLO las piezas registradas de esa, con la mecánica de siempre (`remove.js`: lo
//                                  ajeno no se toca, un archivo que queda igual a como estaba antes del arnés vuelve a
//                                  sus bytes); el arnés y la otra herramienta quedan. La última no se saca así: eso es
//                                  `uninstall` entero.
//
// De quién es cada pieza registrada: de Codex, las `kind: codex` (lo que deja su enchufe: perfiles, `hooks.json`,
// `config.toml`, los enlaces de skills y `AGENTS.md`). De nadie —se quedan siempre—: la copia fija de arranque y las
// skills de terceros. El resto (hooks de `settings.json`, ajustes, bloques, el `@import`, la línea de arranque, enlaces,
// comandos, y lo que su instalador deja en git y en las tareas del sistema) es de Claude Code.
//
// Los dos límites que quedan para la mudanza (tanda D), dichos y con salida 2:
//   · una máquina que NACIÓ sin Claude Code vive en `~/.tycon`, y el instalador de Claude Code (shell) tiene escrito el
//     lugar de antes: sumarle Claude Code espera a la mudanza;
//   · una instalación desde un CLON vive en la carpeta de Claude Code: ahí Claude Code no se saca.
//
// Contrato: `add(ctx, state, H)` y `remove(ctx, state, H)` → `{ code, lines }`. `H` son las piezas de harness.js que
// ya existen (`takeSnapshot`, `finishSnapshot`, `runClaudeApplier`, `runHealth`, `recordPieces`, `ensureLink`,
// `ensureImport`, `settingsPath`, `linkPath`, `busy`). Sólo `require` de esta carpeta (viaja con la copia fija).
const fs = require('fs');
const path = require('path');
const S = require('./state.js');
const R = require('./report.js');
const L = require('./lock.js');
const T = require('./tools.js');
const TH = require('./tycon-home.js');

const nowIso = () => new Date().toISOString();
const exists = (p) => { try { fs.lstatSync(p); return true; } catch (_) { return false; } };
const plural = (tools, one, many) => (tools.length === 1 ? one : many);

/** ¿De qué herramienta es una pieza registrada? `'codex'`, `'claude'`, o null (del arnés: se queda con cualquiera). */
function ownerOf(piece, fixedDir) {
  if (!piece || typeof piece.kind !== 'string') return null;
  if (piece.kind === 'codex') return 'codex';
  if (piece.kind === 'third-party') return null;
  if (piece.kind === 'file' && typeof piece.where === 'string' && (path.dirname(piece.where) === fixedDir || piece.where.startsWith(fixedDir + path.sep))) return null;
  return 'claude';
}

const version = (state) => (state && state.version && state.version.number) || '—';

/** El aviso «herramienta sin enchufar» guardado en el estado se recalcula recién en el próximo arranque: al enchufar o
 *  desenchufar acá, se saca ya (pase adversarial, clase 20: doctor lo seguía mostrando justo después de enchufar). */
function clearUnpluggedNotice(state, R) {
  if (typeof state.notice !== 'string' || !T.NOTICE_TAIL.test(state.notice)) return;
  const rest = state.notice.replace(T.NOTICE_TAIL, '').replace(/^ · /, '').trim();
  if (rest) R.setNotice(state, rest); else R.clearNotice(state);
}

/** La copia contra la que `uninstall --tool` compara: la más nueva (terminada, con `sha256_after`) de las que REGISTRARON
 *  alguna de estas piezas —`tool` o `install`—, y si ninguna, la del primer install (U.baseline). La copia recién tomada
 *  por este mismo uninstall (`snap`) no cuenta: todavía no tiene su «después». */
function baselineFor(home, pieces, U, snap) {
  const wanted = new Set(pieces.map((p) => path.resolve(String(p.where))));
  let copies = [];
  try { copies = require('./snapshot.js').list(home); } catch (_) { copies = []; }
  // la copia que CREÓ la pieza (la más nueva donde no existía antes): contra ésa se pregunta si sigue como la dejó.
  // Una copia posterior donde ya existía (un reinstall con la llave apagada) diría «ya existía antes de instalar» y
  // la pieza quedaría viva para siempre
  for (const c of copies) {   // la más nueva primero
    const m = c && c.manifest;
    if (!m || !Array.isArray(m.files) || (snap && snap.dir === c.dir)) continue;
    if (!['tool', 'install'].includes(m.reason)) continue;
    const mine = m.files.filter((f) => f && typeof f.path === 'string' && wanted.has(path.resolve(f.path)) && typeof f.sha256_after === 'string' && f.existed === false);
    if (!mine.length) continue;
    const map = {}; const after = {};
    for (const f of m.files) {
      if (!f || typeof f.path !== 'string') continue;
      map[f.path] = f.existed && f.copy ? path.join(c.dir, f.copy) : null;
      if (typeof f.sha256_after === 'string') after[f.path] = f.sha256_after;
    }
    return { map, after, dir: c.dir };
  }
  return U.baseline(home);
}

/** `install --tool <herramienta>` sobre una máquina instalada: enchufa sólo las que faltan. */
function add(ctx, state, H) {
  const head = 'harness.js install --tool';
  const opt = T.parseOption(ctx.opts.tool);
  if (!opt.ok) return { code: 2, lines: [`${head}: ${opt.reason}`] };
  const where = { home: ctx.home, env: ctx.env };
  const plugged = T.plugged(state, where);
  const adding = opt.tools.filter((t) => !plugged.includes(t));
  if (!adding.length) {
    return { code: 0, lines: [`${T.names(opt.tools)} ya ${plural(opt.tools, 'está enchufada', 'están enchufadas')}: nada que hacer`, `herramientas enchufadas: ${T.names(plugged)}`] };
  }
  const wanted = T.TOOLS.filter((t) => plugged.includes(t) || adding.includes(t));
  if (adding.includes('claude') && TH.livesInOwnHome(ctx.home) && !TH.ownHomeStale(ctx.home)) {
    return { code: 2, lines: [`${head}: esta máquina vive en la casa propia del arnés (${TH.ownStateDir(ctx.home)}): se instaló sin Claude Code, y su instalador todavía tiene escrito el lugar de antes. Sumarle Claude Code llega con la mudanza (tanda D de la story 8.23). No escribí nada`] };
  }
  const tree = state.tree;
  const detected = T.detect({ home: ctx.home, env: ctx.env, platform: ctx.platform });
  const notes = adding.filter((t) => !detected[t].installed).map((t) => `ojo: no encontré ${T.LABELS[t]} instalado en esta máquina (ni su ejecutable en el PATH ni su configuración): lo enchufo igual porque lo pediste`);
  const what = `${T.names(adding)} en la instalación que ya está (versión ${version(state)}, ${tree}): sin bajar nada y sin tocar los enchufes de ${T.names(plugged)}`;
  if (ctx.opts['dry-run']) return { code: 0, lines: [`se enchufaría ${what}`, ...notes] };
  if (!ctx.opts.yes) {
    const P = require('./prompt.js');
    if (!P.isTerminal()) return { code: 2, lines: [`se enchufa ${what}`, ...notes, `${head}: sin \`--yes\` y sin terminal no escribo nada: harness.js install --tool ${adding.join(' --tool ')} --yes`] };
    process.stdout.write(`${[`se enchufa ${what}`, ...notes].join('\n')}\n`);
    if (!P.ask('¿Lo enchufo? [s/N] ')) return { code: 0, lines: ['no se enchufó nada'] };
  }
  return L.withLock(ctx.home, () => {
    const fresh = S.read(ctx.home);
    if (fresh.status !== 'ok') { const f = S.fail(fresh, { home: ctx.home }); return { code: f.code, lines: [f.line] }; }
    const st = fresh.state;
    const log = (l) => R.log(ctx.home, `install --tool: ${l}`);
    const snap = H.takeSnapshot(ctx, tree, { reason: 'tool', from: version(st), log, state: st, force: true });
    const fail = (why) => { H.finishSnapshot(ctx, snap, log); return { code: 1, lines: [`${head}: ${why} — detalle en ${S.paths(ctx.home).log}`, ...notes] }; };
    let report = []; let shared = []; let out = '';
    if (adding.includes('claude')) {
      // los enchufes propios de Claude Code que no pone su instalador: el lugar, el enlace de las skills, la línea de
      // arranque y el @import (los mismos pasos de `install --version`)
      const l = H.ensureLink(ctx, tree, { link: tree, prefer: tree });
      if (!l.ok) return fail(`no pude asegurar el enlace del arnés: ${l.out || l.err}`);
      const skillsLink = TH.installedSkillsDir(ctx.home);
      try { if (!exists(skillsLink)) fs.symlinkSync(tree, skillsLink, process.platform === 'win32' ? 'junction' : 'dir'); } catch (e) { notes.push(`no pude crear el enlace ${skillsLink}: ${e.message}`); }
      const SL = require('./startup-line.js');
      const n = SL.checkNode({ env: ctx.env });
      SL.migrate(H.settingsPath(ctx), { home: ctx.home, platform: ctx.platform, nodeOk: n.ok, nodeVersion: n.version, addIfMissing: true, backup: !snap });
      H.ensureImport(ctx);
      // su instalador, avisado de lo de Codex: `done` si ya está enchufado (no lo toca), `off` si no
      const a = H.runClaudeApplier(ctx, tree, { log, snapshotDir: snap && snap.dir, codex: wanted.includes('codex') ? 'done' : 'off' });
      if (!a.ok) return fail(`el aplicador falló (${a.reason})`);
      if (Array.isArray(a.report)) report.push(...a.report); else report = null;
      shared = a.shared || [];
      out = a.out || '';
      for (const w of a.warnings || []) if (!notes.includes(w)) notes.push(w);
    }
    if (adding.includes('codex')) {
      const c = T.plugCodex({ tree, home: ctx.home, env: ctx.env, log, snapshotDir: snap && snap.dir, force: true });
      if (!c.ok) return fail(`el enchufe de Codex falló (${c.reason})`);
      if (report) report.push(...c.pieces);
      out = [out, c.out].filter(Boolean).join('\n');
      for (const w of c.warnings) if (!notes.includes(w)) notes.push(w);
    }
    st.tools = wanted;
    st.last_apply = nowIso();
    clearUnpluggedNotice(st, R);
    H.recordPieces(ctx, st, report, shared);
    S.write(ctx.home, st);
    const h = H.runHealth(ctx, st, { report, applierOut: out, log });
    if (!h.ok) {
      st.failed = { commit: version(st), sources: {}, at: nowIso(), log: S.paths(ctx.home).log, reason: 'health', stage: 'install' };
      st.last_health = null;
      S.write(ctx.home, st);
      return fail(`${T.names(adding)} quedó enchufado, pero la comprobación de salud no pasó: ${h.failures.join(' · ')}`);
    }
    st.last_health = nowIso();
    S.write(ctx.home, st);
    H.finishSnapshot(ctx, snap, log);
    log(`enchufado: ${adding.join(', ')} · quedan: ${wanted.join(', ')}`);
    return { code: 0, lines: [`${T.names(adding)} ${plural(adding, 'enchufado', 'enchufados')} · sin bajar nada ni tocar ${T.names(plugged)}`, `herramientas enchufadas: ${T.names(wanted)}`, ...notes] };
  }, { env: ctx.env, onBusy: H.busy });
}

/** Lo que `uninstall --tool` quitaría, sin escribir: `{ pieces, links }`. */
function removal(ctx, state, tool, H, { codexStays = false } = {}) {
  const fixedDir = S.paths(ctx.home).bootstrapDir;
  const pieces = (Array.isArray(state.managed) ? state.managed : []).filter((p) => ownerOf(p, fixedDir) === tool);
  const links = [];
  const notes = [];
  if (tool === 'claude' && S.isRelease(state)) {
    // el lugar y el enlace de las skills: `install --version` los crea sin registrarlos; se van si apuntan al arnés
    // a dónde APUNTA (readlink), contra la casa del arnés escrita de las dos formas: como se la nombra y resuelta (en
    // Mac la carpeta temporal y algunas HOME viven detrás de un enlace, y el enlace guarda la ruta resuelta)
    const root = TH.ownPaths({ env: ctx.env }).root;
    const roots = [root];
    try { const real = fs.realpathSync(root); if (real !== root) roots.push(real); } catch (_) { /* la casa no está */ }
    for (const l of [H.linkPath(ctx.home), TH.installedSkillsDir(ctx.home)]) {
      try {
        if (!fs.lstatSync(l).isSymbolicLink()) continue;
        const to = path.resolve(path.dirname(l), fs.readlinkSync(l));
        if (!roots.some((r) => to === r || to.startsWith(r + path.sep))) continue;
        // el enlace de las skills es adonde apuntan los enlaces de ~/.codex/skills y los hooks ${SKILLS} de Codex: con
        // Codex quedándose, se queda (pase adversarial, clase 23: sacarlo dejaba a Codex colgado y doctor no lo veía)
        if (codexStays && l === TH.installedSkillsDir(ctx.home)) { notes.push(`queda el enlace ${l}: las skills y los hooks de Codex apuntan ahí`); continue; }
        links.push(l);
      } catch (_) { /* no está */ }
    }
  }
  return { pieces, links, notes };
}

/** `uninstall --tool <herramienta>`: desenchufa sólo ésa. */
function remove(ctx, state, H) {
  const head = 'harness.js uninstall --tool';
  const opt = T.parseOption(ctx.opts.tool);
  if (!opt.ok) return { code: 2, lines: [`${head}: ${opt.reason}`] };
  const where = { home: ctx.home, env: ctx.env };
  const plugged = T.plugged(state, where);
  // también una herramienta que `install` dejó de mantener por su llave (ya no está en `tools`) pero cuyas piezas siguen
  // registradas: el plan promete «sus piezas quedan hasta uninstall --tool <x>», y acá se cumple (pase adversarial, clase 11)
  const fixedDirNow = S.paths(ctx.home).bootstrapDir;
  const registered = T.TOOLS.filter((t) => (Array.isArray(state.managed) ? state.managed : []).some((p) => ownerOf(p, fixedDirNow) === t));
  const removing = opt.tools.filter((t) => plugged.includes(t) || registered.includes(t));
  if (!removing.length) return { code: 0, lines: [`${T.names(opt.tools)} no ${plural(opt.tools, 'está enchufada', 'están enchufadas')}: nada que quitar`, `herramientas enchufadas: ${T.names(plugged)}`] };
  const left = plugged.filter((t) => !removing.includes(t));
  if (!left.length) {
    return { code: 2, lines: [`${head}: ${T.names(removing)} ${plural(plugged, 'es la única herramienta enchufada', 'son todas las herramientas enchufadas')}: sacarla es quitar el arnés — harness.js uninstall. No toqué nada`] };
  }
  if (removing.includes('claude') && !S.isRelease(state)) {
    return { code: 2, lines: [`${head}: esta instalación es desde un clon, que vive en la carpeta de Claude Code: ahí Claude Code no se saca solo. La mudanza a ~/.tycon (tanda D de la story 8.23) es la que separa al arnés de esa carpeta. No toqué nada`] };
  }
  const U = require('./uninstall.js');
  const RM = require('./remove.js');
  const plans = removing.map((t) => Object.assign({ tool: t }, removal(ctx, state, t, H, { codexStays: left.includes('codex') })));
  const total = plans.reduce((n, p) => n + p.pieces.length + p.links.length, 0);
  const planLines = plans.map((p) => `quita los enchufes de ${T.LABELS[p.tool]}: ${p.pieces.length} pieza(s) registrada(s)${p.links.length ? ` y ${p.links.length} enlace(s) del arnés en su carpeta` : ''}`);
  for (const p of plans) for (const n of p.notes || []) planLines.push(n);
  planLines.push(`deja: el arnés (${state.tree}, versión ${version(state)}) y los enchufes de ${T.names(left)}`);
  if (ctx.opts['dry-run']) return { code: 0, lines: planLines };
  if (!ctx.opts.yes) {
    const P = require('./prompt.js');
    if (!P.isTerminal()) return { code: 2, lines: [...planLines, `${head}: sin --yes y sin terminal no hago nada (harness.js uninstall --tool ${removing.join(' --tool ')} --yes)`] };
    process.stdout.write(`${planLines.join('\n')}\n`);
    if (!P.ask(`¿Desenchufo ${T.names(removing)}? [s/N] `)) return { code: 0, lines: ['no se desenchufó nada'] };
  }
  return L.withLock(ctx.home, () => {
    const fresh = S.read(ctx.home);
    if (fresh.status !== 'ok') { const f = S.fail(fresh, { home: ctx.home }); return { code: f.code, lines: [f.line] }; }
    const st = fresh.state;
    const log = (l) => R.log(ctx.home, `uninstall --tool: ${l}`);
    const snap = H.takeSnapshot(ctx, st.tree, { reason: 'tool', from: version(st), log, state: st, force: true });
    const lines = [];
    const errors = [];
    const gone = new Set();
    for (const t of removing) {
      const p = removal(ctx, st, t, H, { codexStays: left.includes('codex') });
      // «¿sigue como lo dejó la instalación?» se pregunta contra la copia que ESCRIBIÓ esas piezas: la de `install --tool`
      // (reason `tool`) si la herramienta se enchufó después, si no la del primer install (pase adversarial, clase 1:
      // con la copia del primer install, hooks.json y config.toml de Codex quedaban vivos y el estado decía «sin Codex»)
      const base = baselineFor(ctx.home, p.pieces, U, snap);
      const r = RM.removePieces(p.pieces, { home: ctx.home, env: ctx.env, tree: st.tree, log, restoreIfEqual: base.map, afterSha: base.after, platform: ctx.platform });
      for (const x of [...r.removed, ...r.absent]) gone.add(x);
      const failed = r.kept.filter((k) => k.error);
      for (const k of failed) errors.push(`${T.LABELS[t]}: ${k.why}`);
      for (const l of p.links) { try { fs.unlinkSync(l); } catch (e) { errors.push(`${T.LABELS[t]}: no pude quitar el enlace ${l} (${e.code || e.message})`); } }
      lines.push(`${T.LABELS[t]} desenchufado: ${r.removed.length} pieza(s) quitada(s)${p.links.length ? `, ${p.links.length} enlace(s)` : ''}${r.kept.length - failed.length ? `; quedan ${r.kept.length - failed.length} que no son del arnés o cambiaste vos` : ''}`);
      for (const k of r.kept) if (!k.error) lines.push(`  - queda: ${k.why}`);
      for (const k of r.review) lines.push(`  - revisalo: ${k.why}`);
    }
    // el registro: se va lo quitado (y lo que ya no estaba); lo que no se pudo quitar queda, para reintentar
    st.managed = (Array.isArray(st.managed) ? st.managed : []).filter((p) => !gone.has(p));
    const still = removing.filter((t) => errors.some((e) => e.startsWith(`${T.LABELS[t]}:`)));
    st.tools = T.TOOLS.filter((t) => left.includes(t) || still.includes(t));
    clearUnpluggedNotice(st, R);
    S.write(ctx.home, st);
    H.finishSnapshot(ctx, snap, log);
    log(`desenchufado: ${removing.join(', ')} · quedan: ${st.tools.join(', ')} · errores: ${errors.length}`);
    if (errors.length) return { code: 1, lines: [...lines, ...errors.map((e) => `  ✗ ${e}`), `${head}: quedó a medias — harness.js uninstall --tool ${still.join(' --tool ')} --yes lo reintenta`] };
    return { code: 0, lines: [...lines, `herramientas enchufadas: ${T.names(st.tools)}`, `deja: el arnés (${st.tree}) — ${total} pieza(s) revisada(s); la copia de antes, en ${snap && snap.dir ? snap.dir : 'las copias de seguridad del mecanismo'}`] };
  }, { env: ctx.env, onBusy: H.busy });
}

module.exports = { add, remove, ownerOf, removal };
