'use strict';
/**
 * release-photo.js — la foto de una carpeta de usuario con el arnés instalado como VERSIÓN BAJADA (archivos, sin git),
 * el juicio de esa foto y la comparación de dos.
 *
 * POR QUÉ EXISTE. La foto de `team-lab.js` es la de una instalación con clones: mira la rama y el commit de cada clon,
 * decide «se actualizó» comparando commits y lee el estado de una ruta fija. Sobre una versión bajada todo eso miente:
 * sin git la rama sale vacía y el juicio dice «no se actualiza». Acá:
 *   · no hay nada de git: «qué versión quedó» es el número de `version.json` del árbol instalado;
 *   · el estado, el registro de arranque y la copia fija se leen de la carpeta que resuelve el propio arnés (se le
 *     pasan como `paths`: ver `toy-lab.statePaths`), no de una ruta escrita acá;
 *   · los hooks esperados salen de la lista del árbol instalado (`scripts/setup/hooks-list.json`).
 * Lo que no depende de git conserva el identificador y la gravedad que ya tiene en `team-lab.js`: `settings:*`,
 * `hooks:*`, `startup:*`, `links:*`, `doctor:*`, `import:*`, `state:*`, `session:*`, `smoke:*`, `commands:*`.
 *
 * Sólo lee. Sin dependencias.
 */
const fs = require('fs');
const path = require('path');
const L = require('./lab.js');
const T = require('./team-lab.js');
const C = require('./count-hooks.js');
const TL = require('./toy-lab.js');
const PLACE = require('../../setup/harness/place.js');

const LIST = 'scripts/setup/hooks-list.json';
const finding = (id, severity, kind, detail) => ({ id, severity, kind, detail });
const gates = new Set(['PreToolUse', 'UserPromptSubmit', 'Stop']);
/** Un mensaje sin lo que cambia de una corrida a otra (commits, fechas, rutas, números). */
const normal = (s) => String(s).replace(/[0-9a-f]{7,40}/g, '#').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '@').replace(/[A-Za-z]:[\\/][^\s:·)]+|\/[^\s:·)]+/g, '~').replace(/\d+/g, 'N');
const IMPORT_RX = new RegExp(`^@.*(?:${PLACE.PLACE_NAME}|${PLACE.LEGACY_PLACE_NAME}).*README\\.md\\s*$`);

/** El lector de configuración del árbol instalado, con el ambiente de la variante: `{ exit, error, stdout }`, o `null` si el árbol no lo trae. */
function config(tree, args, env) {
  const reader = path.join(tree, 'scripts', 'lib', 'tycon-config.js');
  if (!fs.existsSync(reader)) return null;
  return L.run(process.execPath, [reader, ...args], { env, timeoutMs: 30000, cap: 20000 });
}

/** Los hooks registrados contra la lista del árbol instalado. `{ problem }` si no se puede comparar: no se inventa una lista. */
function expectedFacts({ home, tree, settingsFile, env, platform = process.platform }) {
  try {
    if (!fs.existsSync(path.join(tree, ...LIST.split('/')))) return { problem: `el árbol instalado no trae ${LIST}: no hay lista contra la que comparar` };
    let integrations = {};
    const read = config(tree, ['integrations', '--json'], env);
    if (read && read.exit === 0) { try { integrations = JSON.parse(read.stdout); } catch (_) { integrations = null; } } else if (read) integrations = null;
    let profile = { state: 'ok', value: 'full' };
    const asked = config(tree, ['get', 'install.profile'], env);
    if (asked) {
      const said = String(asked.stdout || '').trim();
      if (!asked.error && asked.exit === 0 && (said === 'minimal' || said === 'full')) profile = { state: 'ok', value: said };
      else if (!(!asked.error && asked.exit === 3)) profile = { state: 'rota', value: null };
    }
    const exp = C.expectedFromList(tree, { integrations, env, home, profile, platform });
    if (!exp) return { problem: `el árbol instalado no trae ${LIST}: no hay lista contra la que comparar` };
    if (exp.problems.length) return { problem: `la lista esperada no es de fiar: ${exp.problems.join(' · ')}` };
    const result = C.compare(exp.hooks, T.readJsonLoose(settingsFile).value, { superseded: exp.superseded, home, clone: tree, platform });
    return {
      from: LIST, integrations, profile: profile.value, names: exp.hooks.map((h) => `${h.event}:${h.relpath}`), expected_total: result.expected_total, in_place: result.in_place,
      missing: result.missing.map((m) => m.hook), duplicated: result.duplicated.map((d) => d.hook), superseded: result.superseded.map((s) => s.hook),
      misplaced: result.misplaced.map((m) => m.hook), unexpected: result.unexpected.map((u) => u.hook), dangling: result.dangling.map((d) => d.hook),
    };
  } catch (e) { return { problem: e.message }; }
}

/**
 * Los enlaces de `~/.claude` de una versión bajada. El lugar del arnés y `agent-skills` llegan al árbol instalado.
 * `skills` y `agents` llegan a su carpeta del árbol, o son una carpeta propia cuyas entradas llegan al árbol (así los
 * deja el aplicador cuando arma la carpeta entrada por entrada).
 */
function linkFacts(home, tree, { platform = process.platform } = {}) {
  const dot = path.join(home, '.claude');
  const real = L.realOrSelf(tree);
  const inside = (p) => L.isInside(L.realOrSelf(p), real, platform);
  const has = (n) => { try { fs.lstatSync(path.join(dot, n)); return true; } catch (_) { return false; } };
  const names = [has(PLACE.PLACE_NAME) || !has(PLACE.LEGACY_PLACE_NAME) ? PLACE.PLACE_NAME : PLACE.LEGACY_PLACE_NAME, 'agent-skills', 'agents', 'skills'];
  return names.map((name) => {
    const p = path.join(dot, name);
    let st;
    try { st = fs.lstatSync(p); } catch (_) { return { name, present: false, ok: false }; }
    const out = { name, present: true, kind: st.isSymbolicLink() ? 'link' : (st.isDirectory() ? 'folder' : 'file') };
    try { out.resolves_to = fs.realpathSync(p); } catch (e) { out.resolves_to = null; out.problem = e.code || e.message; }
    const want = name === 'agents' || name === 'skills' ? path.join(tree, name) : tree;
    out.ok = Boolean(out.resolves_to) && L.samePath(out.resolves_to, L.realOrSelf(want), platform);
    if (!out.ok && out.kind === 'folder' && (name === 'agents' || name === 'skills')) {
      let entries = [];
      try { entries = fs.readdirSync(p); } catch (_) { entries = []; }
      out.entries = entries.length;
      out.entries_from_tree = entries.filter((e) => inside(path.join(p, e))).length;
      out.ok = out.entries_from_tree > 0;
    }
    return out;
  });
}

/** La foto de una carpeta de usuario con una versión bajada. `paths`: las rutas del estado, como las resuelve el arnés. */
function photo({ home, tree, env, paths, platform = process.platform }) {
  const dot = path.join(home, '.claude');
  const settingsFile = path.join(dot, 'settings.json');
  const p = { at: L.nowIso() };
  p.settings = T.settingsFacts(settingsFile, { platform });
  p.links = linkFacts(home, tree, { platform });
  const harness = path.join(tree, 'scripts', 'setup', 'harness.js');
  p.doctor = T.doctorFacts(harness, env, tree);
  const ver = fs.existsSync(harness) ? L.run(process.execPath, [harness, 'version'], { env, cwd: tree, timeoutMs: 60000, cap: 1200 }) : { exit: null, error: 'sin harness.js', stdout: '', stderr: '' };
  // el número, y si no se pudo leer, por qué (sin archivo no hay versión instalada: eso no es un problema de lectura)
  const read = TL.versionFacts(tree);
  p.version = { exit: ver.exit, error: ver.error, text: L.clip(ver.stdout || ver.stderr, 600).trim(), number: read.number, problem: read.problem };
  // el estado: no está (`exists: false`), está y se lee, o está y NO se deja leer (`problem`) — tres cosas distintas
  try {
    const st = TL.stateOf(paths);
    if (!st || typeof st !== 'object') p.state = st === null ? { exists: false } : { exists: true, problem: `el estado del arnés (${paths.file}) no es un objeto` };
    else {
      const source = Array.isArray(st.sources) ? st.sources.find((s) => s && s.kind === 'release') || st.sources[0] || null : null;
      p.state = { exists: true, mode: st.mode || null, channel: st.channel || null, version: st.version && st.version.number ? st.version.number : null, kind: source ? source.kind || 'tree' : null, notice: st.notice || null, failed: st.failed || null, hold: st.hold || null, policy: st.policy || null, last_fetch: st.last_fetch || null, team: st.team ? { repo: st.team.repo || null, host: st.team.host || null, commit: st.team.commit || null } : null };
    }
  } catch (e) { p.state = { exists: true, problem: e.message }; }
  p.commands = (() => { try { return fs.readdirSync(path.join(dot, 'commands')).sort(); } catch (_) { return null; } })();
  try {
    const md = fs.readFileSync(path.join(dot, 'CLAUDE.md'), 'utf8');
    p.claude_md = { exists: true, imports: md.split(/\r?\n/).filter((l) => IMPORT_RX.test(l.replace(/^﻿/, ''))), blocks: (md.match(/TYCON_BLOCK:[^\s]+ START/g) || []).length, bom: md.charCodeAt(0) === 0xfeff, crlf: md.includes('\r\n') };
  } catch (_) { p.claude_md = { exists: false, imports: [] }; }
  p.fixed_copy = (() => {
    try { return fs.readdirSync(paths.bootstrapDir).filter((f) => /^bootstrap/.test(f)).sort().map((f) => ({ file: f, has_cr: /\.sh$/.test(f) ? fs.readFileSync(path.join(paths.bootstrapDir, f)).includes('\r\n') : null })); } catch (_) { return []; }
  })();
  p.startup_log_tail = (() => { try { return fs.readFileSync(paths.log, 'utf8').split('\n').filter(Boolean).slice(-12).map((l) => L.clip(l, 400)); } catch (_) { return []; } })();
  p.expected = p.settings.exists && !p.settings.problem ? expectedFacts({ home, tree, settingsFile, env, platform }) : { problem: 'sin settings.json legible' };
  return p;
}

/** Lo que una foto dice por sí sola. Lo que no depende de git lo juzga la tabla de `team-lab.js`; nada de git acá. */
function judgePhoto(p) {
  // sin clones que mirar (`repos` vacío), esa tabla no dice nada de git
  const out = T.judgePhoto(Object.assign({}, p, { repos: {} }));
  if (!p.version || !p.version.number) out.push(finding('version:unreadable', T.SEVERITY.breaks, 'version', `el árbol instalado no trae un número de versión legible en version.json${p.version && p.version.problem ? ` (${p.version.problem})` : ''}: no se sabe qué versión quedó, ni si después se actualizó`));
  // un estado que está y no se deja leer no es «no hay estado»: de ahí salen el aviso a la persona y la capa del equipo
  if (p.state && p.state.problem) out.push(finding('state:unreadable', T.SEVERITY.loses, 'state', `el estado del arnés existe y no se puede leer: ${p.state.problem}. De ahí salen el aviso de versión nueva y la capa del equipo: no se sabe qué dicen`));
  return out;
}

/**
 * Las diferencias entre la foto de antes y la de después de una actualización, cada una con su gravedad. Función pura.
 * `expectVersion`: el número al que tenía que llegar (sin él —la máquina que pregunta— no llegar no es un hallazgo).
 */
function comparePhotos(before, after, { sessions = [], smokeBefore = null, smokeAfter = null, expectVersion = null } = {}) {
  const out = [];
  const add = (...a) => { const f = finding(...a); if (!out.some((x) => x.id === f.id)) out.push(f); };
  const wasFine = (id) => !judgePhoto(before).some((f) => f.id === id);
  // 1 · lo que la foto de después dice por sí sola y la de antes no decía
  for (const f of judgePhoto(after)) {
    // faltar contra la lista no es de esta actualización: acá cuentan los hooks que ESTABAN y ya no (más abajo)
    if (/^hooks:missing:/.test(f.id)) continue;
    if (f.id === 'state:notice' && before.state && before.state.notice === after.state.notice) continue;
    if (wasFine(f.id) || f.id === 'state:notice') add(f.id, f.severity, f.kind, f.detail);
  }
  // 2 · los hooks que estaban antes y después no
  const keys = (p) => new Set(((p.settings && p.settings.hooks) || []).map(T.hookKey));
  const had = keys(before); const has = keys(after);
  const expectedNow = new Set((after.expected && after.expected.names) || []);
  for (const k of had) {
    if (has.has(k)) continue;
    const plain = k.replace(/\[.*\]$/, '');
    const retired = after.expected && !after.expected.problem && !expectedNow.has(plain);
    add(`hooks:lost:${k}`, retired ? T.SEVERITY.noise : T.SEVERITY.loses, 'hook', retired ? `${k} estaba antes y después no; la lista de la versión nueva ya no lo trae (retirado a propósito)` : `${k} estaba registrado antes de actualizar y después no está: se perdió en la actualización`);
  }
  const gained = [...has].filter((k) => !had.has(k));
  // 3 · la línea de arranque
  const lineOf = (p) => ((p.settings && p.settings.startup_lines) || []).map((l) => `${l.form}:${l.shell}`).join(',');
  if (lineOf(before) !== lineOf(after)) add('startup:line-changed', T.SEVERITY.noise, 'startup-line', `la línea de arranque pasó de «${lineOf(before) || 'ninguna'}» a «${lineOf(after) || 'ninguna'}»`);
  // 4 · doctor
  if (before.doctor.readable && after.doctor.readable) {
    const old = new Set(before.doctor.warn.map(normal));
    for (const w of after.doctor.warn) if (!old.has(normal(w))) add(`doctor:new-warn:${normal(w).slice(0, 80)}`, T.SEVERITY.noise, 'doctor', `doctor suma un aviso que antes no daba: ${w}`);
    if (after.doctor.fail.length < before.doctor.fail.length) add('doctor:better', T.SEVERITY.noise, 'doctor', `doctor mejoró: ${before.doctor.fail.length} rojo(s) antes, ${after.doctor.fail.length} después`);
  }
  // 5 · cómo quedó escrito settings.json, y lo que el arnés le sumó
  const sb = before.settings || {}; const sa = after.settings || {};
  if (sa.exists && !sa.problem && sb.exists && !sb.problem) {
    const shape = (s) => `sangría ${s.indent}, ${s.crlf ? 'CRLF' : 'LF'}${s.bom ? ', con marca de orden de bytes' : ''}${s.ends_with_newline ? '' : ', sin salto final'}`;
    if (shape(sb) !== shape(sa)) add('settings:rewritten', T.SEVERITY.noise, 'settings', `settings.json cambió de forma: ${shape(sb)} → ${shape(sa)}`);
    const keysOf = (s) => [...(s.top_keys || []).filter((k) => k !== 'hooks'), ...Object.keys(s.env || {}).map((k) => `env.${k}`)].sort();
    const plus = keysOf(sa).filter((k) => !keysOf(sb).includes(k)); const minus = keysOf(sb).filter((k) => !keysOf(sa).includes(k));
    if (minus.length) add('settings:keys-lost', T.SEVERITY.loses, 'settings', `settings.json perdió claves que antes tenía: ${minus.join(', ')}`);
    if (plus.length) add('settings:keys-added', T.SEVERITY.noise, 'settings', `settings.json suma claves: ${plus.join(', ')}`);
    const common = (s, other) => (s.top_keys || []).filter((k) => (other.top_keys || []).includes(k)).join(',');
    if (common(sb, sa) !== common(sa, sb)) add('settings:keys-reordered', T.SEVERITY.noise, 'settings', `settings.json cambió el orden de sus claves: ${common(sb, sa)} → ${common(sa, sb)}`);
    if ((sa.backups || 0) > (sb.backups || 0)) add('settings:more-backups', T.SEVERITY.noise, 'settings', `quedaron ${(sa.backups || 0) - (sb.backups || 0)} copia(s) .bak más de settings.json`);
    if (gained.length) add('hooks:gained', T.SEVERITY.noise, 'hook', `hooks nuevos registrados (${gained.length}): ${gained.join(', ')}`);
  }
  // 6 · ~/.claude/commands
  const cb = before.commands || []; const ca = after.commands || [];
  const gone = cb.filter((c) => !ca.includes(c));
  if (gone.length) add('commands:lost', T.SEVERITY.loses, 'commands', `~/.claude/commands perdió: ${gone.join(', ')}`);
  const fresh = ca.filter((c) => !cb.includes(c));
  if (fresh.length) add('commands:added', T.SEVERITY.noise, 'commands', `~/.claude/commands suma: ${fresh.join(', ')}`);
  // 7 · la versión: el número del árbol instalado
  const nb = before.version && before.version.number; const na = after.version && after.version.number;
  if (!na) add('version:unreadable', T.SEVERITY.breaks, 'version', 'después de actualizar, el árbol instalado no trae un número de versión legible: no se sabe qué quedó');
  else if (expectVersion && na !== expectVersion) add('version:not-applied', T.SEVERITY.loses, 'version', `la máquina quedó en la versión ${na} y no en la ${expectVersion}: la versión nueva no se aplicó`);
  if (na && nb !== na) add('version:changed', T.SEVERITY.noise, 'version', `versión: «${nb || '—'}» → «${na}»`);
  // 8 · el arranque: qué dijo cada sesión, y si su trabajo desprendido terminó
  // (el juicio de una sesión es uno solo, el de `toy-lab.sessionFindings`: lo usan también las sesiones que no entran a
  // una comparación de fotos)
  for (const s of sessions) for (const f of TL.sessionFindings(s)) add(f.id, f.severity, f.kind, f.detail);
  // dos sesiones seguidas lanzadas igual que dejan settings.json distinto: cada arranque lo reescribe. La sesión de
  // después de actualizar a mano estrena código nuevo (escribir una vez es lo esperado): se comparan las de antes
  const fine = sessions.filter((x) => !x.problem && x.settings_sha256 && !x.by_hand);
  const [prev, last] = fine.slice(-2);
  if (prev && last && prev.form === last.form && prev.settings_sha256 !== last.settings_sha256) add('settings:rewritten-every-session', T.SEVERITY.noise, 'settings', `dos sesiones seguidas (${prev.label} y ${last.label}, las dos por ${last.form}) dejaron settings.json distinto: cada arranque lo vuelve a escribir`);
  // 9 · el humo: un hook que antes pasaba una entrada legítima y después no
  if (smokeAfter && smokeAfter.rows) {
    const old = new Map(((smokeBefore && smokeBefore.rows) || []).map((r) => [`${r.key}|${r.form}`, r]));
    for (const r of smokeAfter.rows) {
      // frenar una entrada legítima cuenta aunque salga 0: un hook frena también imprimiendo el bloqueo en JSON
      const failed = (x) => Boolean(x.error || x.exit !== 0 || x.blocked);
      if (!failed(r)) continue;
      const was = old.get(`${r.key}|${r.form}`);
      // «ya fallaba igual»: la misma salida, el mismo error y el mismo freno; un cambio de falla se reporta
      if (was && failed(was) && was.exit === r.exit && (was.error || null) === (r.error || null) && Boolean(was.blocked) === Boolean(r.blocked)) continue;
      const blocks = r.blocked && gates.has(r.event);
      const then = !was ? ' (hook nuevo)' : !failed(was) ? ' (antes salía 0)' : ` (antes ${was.error ? `no arrancaba: ${was.error}` : `salía ${was.exit}${was.blocked ? ' y frenaba' : ''}`})`;
      add(`smoke:${r.form}:${r.key}`, blocks ? T.SEVERITY.breaks : T.SEVERITY.loses, 'smoke', `${r.key}, lanzado por ${r.form} con una entrada legítima, ${r.error ? `no arrancó (${r.error})` : `salió ${r.exit}${r.blocked ? ' y frenó' : ''}`}${blocks ? ' y FRENA: bloquea cada uso de esa herramienta' : ''}${then}${r.said ? ` — ${r.said}` : ''}`);
    }
  }
  return out.sort((a, b) => T.SEVERITY_ORDER.indexOf(a.severity) - T.SEVERITY_ORDER.indexOf(b.severity));
}

/** Las respuestas cortas de una variante: ¿quedó sana?, ¿se actualizó?, ¿de qué versión a cuál? */
function answers(before, after, differences, { sessions = [], expectVersion = null } = {}) {
  const count = (sev) => differences.filter((d) => d.severity === sev).length;
  const na = after.version && after.version.number;
  const kept = before && before.settings && before.settings.hooks ? before.settings.hooks.filter((h) => ((after.settings && after.settings.hooks) || []).some((x) => T.hookKey(x) === T.hookKey(h))).length : null;
  return {
    healthy: count(T.SEVERITY.breaks) === 0 && count(T.SEVERITY.loses) === 0,
    // (tres estados: sin una versión que esperar, o sin número leído, no se sabe)
    updated: expectVersion && na ? na === expectVersion : null,
    version: { before: (before && before.version && before.version.number) || null, after: na || null, expected: expectVersion },
    by_severity: { breaks: count(T.SEVERITY.breaks), 'loses-control': count(T.SEVERITY.loses), noise: count(T.SEVERITY.noise) },
    doctor: { before: before && before.doctor.readable ? before.doctor.fail.length : null, after: after.doctor.readable ? after.doctor.fail.length : null },
    hooks: { before: before && before.settings.hooks ? before.settings.hooks.length : null, after: after.settings.hooks ? after.settings.hooks.length : null, kept },
    sessions_started: sessions.map((s) => ({ label: s.label, form: s.form, startup_exit: ((s.hooks || []).find((h) => h.startup) || {}).exit, detached: Boolean(s.wait && s.wait.detached), waited_ms: s.wait ? s.wait.waited_ms : null })),
  };
}

module.exports = { LIST, expectedFacts, linkFacts, photo, judgePhoto, comparePhotos, answers };
