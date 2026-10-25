'use strict';

/**
 * delegated-signing.js — la firma de un cambio de control por delegación (`run-base-controls.sh approve --relayed-by`).
 *
 * La sesión designada firma en nombre del dueño sólo si están todas las llaves:
 *   (a) el perfil del equipo delega `control-change` y nombra esta máquina por su huella;
 *   (b) la designación vigente es de ese rol y el dueño la confirmó en su terminal (`confirm-designation`);
 *   (c) la máquina mostró ese cambio (`pending` anotó `control-change-shown`);
 *   (d) el dueño escribió la frase en la conversación de la sesión designada, después de la muestra, nombrando el
 *       cambio, y no se echó atrás;
 *   (f) la sesión designada no tiene trabajo propio abierto (una ejecución o un ad-hoc);
 *   (e) el freno de seguridad dejó una ficha para ese mismo comando, en esa sesión, hace 60 s o menos; se usa una vez.
 *
 * Todo se lee de la casa de la cuenta (`real-home.js`), nunca de `HOME`, `USERPROFILE` ni de una variable `TYCON_*`:
 * el agente puede poner esas variables. Cada dependencia entra por parámetro.
 *
 * CLI:
 *   node delegated-signing.js guard-token --session <sid> --command-stdin   (lo llama el freno de seguridad)
 *   node delegated-signing.js confirm-designation                           (lo corre el dueño en su terminal)
 *
 * Casos: scripts/tests/delegated-approve.test.js
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PIPELINE_LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
const FIRMA = 'control-change';
const SHOWN = 'control-change-shown';
const SIGNED = 'control-change-signed';
const CONFIRMED = 'relay-designation-confirmed';
const TOKEN_TTL_MS = 60 * 1000;
const IMPLEMENTA = 'la sesión que implementa no firma su propio cambio de control';
const QUOTE_PLACEHOLDER = '<frase del dueño>';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeSid = (s) => String(s).replace(/[/\\]/g, '_');

/** La casa de la cuenta: la inyectada, o la del sistema (nunca `HOME`). */
function accountHome({ home, userInfo } = {}) {
  if (home) return home;
  return require('./real-home.js').casaDeLaCuenta(userInfo ? { userInfo } : {});
}

/** Las rutas de la cuenta, sin mirar el ambiente: el estado en `~/.tycon/state` si existe, si no donde siempre. */
function accountPaths(home) {
  const own = path.join(home, '.tycon', 'state');
  let isOwn = false;
  // sólo «no existe» cae donde siempre; una carpeta que no se deja leer no se reemplaza por otra
  try { isOwn = fs.statSync(own).isDirectory(); } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw new Error(`no pude leer la carpeta de estado de la cuenta (${e.code || e.message})`);
  }
  const state = isOwn ? own : path.join(home, '.claude', '.tycon-pipeline');
  return { home, state, gates: path.join(state, 'gates.log'), tokens: path.join(state, 'signing-tokens') };
}

/** El resumen del comando que se firma: lo calcula igual el freno y `approve`. */
function digestOf(args) { return sha(JSON.stringify(['approve', ...args.map(String)])); }

function readGates(p) {
  let raw;
  try { raw = fs.readFileSync(p.gates, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { lines: [] } : { error: `no pude leer el registro del arnés (${e.code || e.message})` }; }
  const lines = [];
  for (const l of raw.split('\n')) { if (!l.trim()) continue; try { lines.push(JSON.parse(l)); } catch (_) { /* un renglón roto no tapa a los demás */ } }
  return { lines };
}
function appendGatesLine(p, obj) {
  fs.mkdirSync(path.dirname(p.gates), { recursive: true });
  fs.appendFileSync(p.gates, `${JSON.stringify(obj)}\n`);
}

/** El renglón que deja `confirm-designation`: ata la confirmación a ESA designación (sesión, hora y frase). */
function confirmationRecord(designacion, ts) {
  return { name: CONFIRMED, status: 'ok', ts, sesion: designacion.sesion, designacion_ts: designacion.ts, cita_sha: sha(designacion.cita) };
}

/** La designación vigente, confirmada en la terminal del dueño: `{ ok, designacion }` o `{ ok:false, reason }`. */
function confirmedDesignation(p) {
  const cw = require(path.join(PIPELINE_LIB, 'critical-waivers.js'));
  const d = cw.designacionVigente({ dir: p.state });
  if (!d) return { ok: false, reason: 'ninguna sesión de esta máquina está designada para reenviar los ok del dueño' };
  if (d.error) return { ok: false, reason: d.error };
  const g = readGates(p);
  if (g.error) return { ok: false, reason: g.error };
  const want = confirmationRecord(d, null);
  const ok = g.lines.some((l) => l && l.name === CONFIRMED && l.status === 'ok' && l.sesion === want.sesion
    && l.designacion_ts === want.designacion_ts && l.cita_sha === want.cita_sha);
  if (!ok) return { ok: false, reason: 'la designación de la sesión no está confirmada en la terminal del dueño: que corra `node scripts/lib/delegated-signing.js confirm-designation` en su terminal' };
  return { ok: true, designacion: d };
}

/**
 * ¿La sesión `sid` tiene trabajo propio abierto? `{ open, reason }`. Una ejecución (un marcador en `active/`, por su
 * nombre o porque dice esa sesión; uno viejo también cuenta) o un ad-hoc declarado, mientras exista. Ilegible: abierto.
 */
function openWork(p, sid) {
  const active = path.join(p.state, 'active');
  let names = [];
  try { names = fs.readdirSync(active); } catch (e) {
    if (e.code !== 'ENOENT') return { open: true, reason: `no pude leer los marcadores de ejecución (${e.code || e.message}): no se firma sin saber si hay una abierta` };
  }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    if (n === `${safeSid(sid)}.json`) return { open: true, reason: `${IMPLEMENTA}: tiene una ejecución abierta (${n}); se cierra con marker.js clear-session` };
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(active, n), 'utf8')); } catch (e) {
      return { open: true, reason: `no pude leer el marcador de ejecución ${n} (${e.code || e.message}): no se firma sin saber de quién es` };
    }
    if (m && m.sessionId === sid) return { open: true, reason: `${IMPLEMENTA}: tiene una ejecución abierta (${n}); se cierra con marker.js clear-session` };
  }
  // el marcador de un solo archivo de las versiones viejas (`active.json`) también cuenta
  let legacy = null;
  try { legacy = fs.readFileSync(path.join(p.state, 'active.json'), 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') return { open: true, reason: `no pude leer el marcador viejo active.json (${e.code || e.message}): no se firma sin saber de quién es` };
  }
  if (legacy !== null) {
    let m = null;
    try { m = JSON.parse(legacy); } catch (_) { return { open: true, reason: 'el marcador viejo active.json no se puede leer: no se firma sin saber de quién es' }; }
    const nombra = (v, hondo = 0) => hondo < 8 && v && typeof v === 'object' && (v.sessionId === sid || Object.values(v).some((x) => nombra(x, hondo + 1)));
    if (nombra(m)) return { open: true, reason: `${IMPLEMENTA}: tiene una ejecución abierta (active.json); se cierra con marker.js clear-session` };
  }
  const adhoc = path.join(p.state, 'adhoc', `${safeSid(sid)}.json`);
  let raw = null;
  try { raw = fs.readFileSync(adhoc, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') return { open: true, reason: `no pude leer su ad-hoc (${e.code || e.message}): no se firma sin saber si hay uno abierto` };
  }
  let a = null;
  try { a = JSON.parse(raw); } catch (_) { /* con otra forma también cuenta */ }
  // un ad-hoc cuenta mientras exista, viejo o con otra forma
  if (raw !== null) return { open: true, reason: `${IMPLEMENTA}: tiene un ad-hoc declarado («${(a && a.reason) || 'sin motivo'}»); se cierra con marker.js adhoc clear` };
  return { open: false };
}

/** `pending` anota que la máquina mostró este cambio: desde ahí cuenta la frase del dueño. */
function recordShown({ home, userInfo, hash, now = () => new Date() } = {}) {
  try {
    const p = accountPaths(accountHome({ home, userInfo }));
    appendGatesLine(p, { name: SHOWN, status: 'ok', ts: now().toISOString(), hash });
    return { ok: true };
  } catch (e) { return { ok: false, reason: `no pude anotar la muestra (${e.code || e.message})` }; }
}

/** El rol que reenvía los ok del dueño según el perfil (`approvals.relay_session`), o un hueco a llenar. */
function relayRole({ home, userInfo, profile } = {}) {
  try {
    const prof = (profile || (() => defaultProfile(accountHome({ home, userInfo }))))();
    const r = prof && prof.doc && prof.doc.approvals && prof.doc.approvals.relay_session;
    return typeof r === 'string' && /^[\w-]+$/.test(r) ? r : '<rol>';
  } catch (_) { return '<rol>'; }
}

/** El comando de la delegación, a partir del de la terminal. */
function delegatedCommand(terminal, rol) {
  return `${terminal} --relayed-by ${rol} --quote '${QUOTE_PLACEHOLDER}'`;
}

/** El freno deja la ficha: sólo para la sesión designada y sin trabajo propio abierto. `{ ok, reason, id }`. */
function issueToken({ home, userInfo, session, args, now = () => new Date() } = {}) {
  let p;
  try { p = accountPaths(accountHome({ home, userInfo })); } catch (e) { return { ok: false, reason: e.message }; }
  const d = confirmedDesignation(p);
  const cw = require(path.join(PIPELINE_LIB, 'critical-waivers.js'));
  // sin la designación confirmada no hay ficha; a otra sesión se le dice primero que no es la designada
  const des = d.ok ? d.designacion : cw.designacionVigente({ dir: p.state });
  if (des && !des.error && String(session || '') !== des.sesion) return { ok: false, reason: `sólo la sesión designada puede firmar por delegación: esta (${session || 'sin número de sesión'}) no lo es` };
  if (!d.ok) return { ok: false, reason: d.reason };
  const w = openWork(p, d.designacion.sesion);
  if (w.open) return { ok: false, reason: w.reason };
  const id = `${now().getTime()}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.mkdirSync(p.tokens, { recursive: true });
    fs.writeFileSync(path.join(p.tokens, `${id}.json`), JSON.stringify({ session: d.designacion.sesion, digest: digestOf(args), at: now().toISOString() }), { flag: 'wx' });
  } catch (e) { return { ok: false, reason: `no pude dejar la ficha (${e.code || e.message})` }; }
  return { ok: true, id };
}

/** Busca la ficha de este comando y la consume. `{ ok, reason }`. */
function takeToken(p, session, digest, nowMs) {
  let names = [];
  try { names = fs.readdirSync(p.tokens); } catch (e) {
    return { ok: false, reason: e.code === 'ENOENT' ? 'no hay ficha del freno para este comando: la firma por delegación se pide con el comando escrito tal cual, en la sesión designada' : `no pude leer las fichas (${e.code || e.message})` };
  }
  let used = false;
  let old = false;
  for (const n of names.sort().reverse()) {
    let t;
    try { t = JSON.parse(fs.readFileSync(path.join(p.tokens, n), 'utf8')); } catch (_) { continue; }
    if (!t || t.session !== session || t.digest !== digest) continue;
    if (n.endsWith('.used.json')) { used = true; continue; }
    if (!n.endsWith('.json')) continue;
    const age = nowMs - Date.parse(t.at || '');
    if (!(age >= 0 && age <= TOKEN_TTL_MS)) { old = true; continue; }
    try { fs.renameSync(path.join(p.tokens, n), path.join(p.tokens, n.replace(/\.json$/, '.used.json'))); } catch (e) {
      // otra firma la tomó primero: esta no
      return { ok: false, reason: `la ficha de este comando ya se usó (${e.code || e.message})` };
    }
    return { ok: true };
  }
  if (old) return { ok: false, reason: 'la ficha de este comando está vencida (tiene más de 60 s): pedí la firma de nuevo' };
  if (used) return { ok: false, reason: 'la ficha de este comando ya se usó: cada firma pide la suya' };
  return { ok: false, reason: 'no hay ficha del freno para este comando en la sesión designada' };
}

/** ¿El perfil del equipo delega esta firma en esta máquina? `{ ok, reason, huella }`. */
function machineDelegates({ home, userInfo, profile, fingerprint } = {}) {
  const no = (reason) => ({ ok: false, reason });
  let prof;
  try { prof = (profile || (() => defaultProfile(accountHome({ home, userInfo }))))(); } catch (e) { return no(`no pude leer el perfil del equipo: ${e.message}`); }
  if (!prof || prof.error) return no(`no pude leer el perfil del equipo: ${(prof && prof.error) || 'sin perfil'}`);
  const cfg = require('./tycon-config.js');
  if (!cfg.delegaFirma(prof.doc, FIRMA)) return no('el perfil del equipo no delega la firma de los cambios de control (approvals.delegated_signing no tiene «control-change»)');
  const fp = (fingerprint || (() => require('./machine-id.js').huella()))();
  if (!fp || fp.error) return no(`no pude leer la huella de esta máquina: ${(fp && fp.error) || 'sin huella'}`);
  const machines = (prof.doc.approvals && prof.doc.approvals.delegated_machines) || [];
  if (!Array.isArray(machines) || !machines.some((x) => x && x.id === fp.huella)) return no('esta máquina no está en la lista del perfil (approvals.delegated_machines): acá no se firma por delegación');
  return { ok: true, huella: fp.huella };
}

function argOf(args, name) { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; }

/**
 * El juez del mensaje del dueño que trae la frase: nombra el cambio (el hash corto o un archivo), dice que sí, y no
 * pregunta, no niega ni frena nada, en ninguna parte del mensaje (la frase es un pedazo: recortar el «no» no la vuelve
 * un ok). Un mensaje posterior que niega o frena y nombra el cambio o la firma la retracta.
 */
// «si» sin tilde pone una condición, no dice que sí; «para» sin tilde es casi siempre la preposición
const RE_SI = /(?<![\p{L}\p{N}])(?:ok|okay|dale|sí|listo|adelante|firm\p{L}*|aprob\p{L}*|apruebo|confirm\p{L}*|autoriz\p{L}*)(?![\p{L}\p{N}])/iu;
const RE_FRENO = /(?<![\p{L}\p{N}])(?:esper[aá]|esperen|pará|fren[aá]|aguant[aá]|paus[aá]|todav[ií]a|despu[eé]s|m[aá]s\s+tarde|antes|primero|hasta|cuando|ma[ñn]ana|luego|wait|hold|stop|later)(?![\p{L}\p{N}])/iu;

function quoteJudge(hash, files) {
  const names = (texto) => {
    const t = String(texto || '').toLowerCase();
    const hex = t.match(/[0-9a-f]{7,64}/g) || [];
    return hex.some((h) => hash.startsWith(h)) || files.some((f) => f && (t.includes(f.toLowerCase()) || t.includes(path.basename(f).toLowerCase())));
  };
  const cw = require(path.join(PIPELINE_LIB, 'critical-waivers.js'));
  const juzgar = (texto) => {
    if (!names(texto)) return 'la frase no nombra el cambio: tiene que decir su hash (7 letras o más) o un archivo';
    if (/[?¿]/.test(String(texto))) return 'el mensaje del dueño pregunta algo: una pregunta no es un ok';
    if (cw.RE_NIEGA.test(String(texto))) return 'el mensaje del dueño niega algo: un ok con un «no» adentro no se firma';
    if (RE_FRENO.test(String(texto))) return 'el mensaje del dueño frena o deja para después: eso no es un ok';
    if (!RE_SI.test(String(texto))) return 'el mensaje del dueño no dice que sí: el ok dice «firmá», «ok», «dale» o «aprobado»';
    return null;
  };
  juzgar.retracta = (texto) => (cw.RE_NIEGA.test(String(texto)) || RE_FRENO.test(String(texto))) && (names(texto) || /\bfirm/i.test(String(texto)));
  return juzgar;
}

/**
 * ¿Se puede firmar? `{ ok, reason, fields }`. `fields` son los campos de la delegación para la línea de la constancia.
 * Inyectables: `home`/`userInfo`, `profile()` → `{ doc }` o `{ error }`, `fingerprint()` → `{ huella }` o `{ error }`,
 * `now()`. Consume la ficha sólo cuando todo lo demás dio.
 */
function checkDelegatedApprove({ home, userInfo, args, hash, entries, profile, fingerprint, now = () => new Date() } = {}) {
  const no = (reason) => ({ ok: false, reason });
  let p;
  try { p = accountPaths(accountHome({ home, userInfo })); } catch (e) { return no(e.message); }
  const files = (entries || []).map((e) => e.path);
  const relayedBy = argOf(args, '--relayed-by');
  const quote = argOf(args, '--quote');
  if (!relayedBy || !quote) return no('la firma por delegación pide --relayed-by <rol> y --quote \'<frase del dueño>\'');
  // (a) el perfil y la máquina
  const m = machineDelegates({ home: p.home, profile, fingerprint });
  if (!m.ok) return no(m.reason);
  const fp = { huella: m.huella };
  // (b) la designación, su rol y su confirmación
  const d = confirmedDesignation(p);
  if (!d.ok) return no(d.reason);
  const des = d.designacion;
  if (!des.rol || des.rol.toLowerCase() !== String(relayedBy).toLowerCase()) return no(`la sesión designada es la «${des.rol}», no la «${relayedBy}»: el rol no coincide`);
  // (c) la muestra
  const g = readGates(p);
  if (g.error) return no(g.error);
  const shown = g.lines.filter((l) => l && l.name === SHOWN && l.hash === hash).pop();
  if (!shown) return no('la máquina no mostró este cambio: corré `pending` antes de firmarlo');
  // (d) la frase, en la conversación de la sesión designada, desde la muestra
  const po = require(path.join(PIPELINE_LIB, 'person-ok.js'));
  const c = po.citaDeLaPersona(quote, { home: p.home, env: {}, sesion: des.sesion, desde: shown.ts, juzgar: quoteJudge(hash, files), soloCadena: true });
  if (!c.legible) return no(`no pude leer la conversación de la sesión designada: ${c.motivo}`);
  if (!c.encontrada) {
    if (c.rechazo) return no(c.rechazo);
    if (c.corta) return no('la frase es demasiado corta');
    if (c.anterior) return no('la frase es anterior a la muestra del cambio: el dueño tiene que darla después de verlo');
    return no('la frase no está en la conversación de la sesión designada como escrita por el dueño');
  }
  // (f) sin trabajo propio abierto
  const w = openWork(p, des.sesion);
  if (w.open) return no(w.reason);
  // (e) la ficha: lo último, porque la consume
  const t = takeToken(p, des.sesion, digestOf(args), now().getTime());
  if (!t.ok) return no(t.reason);
  return { ok: true, fields: { via: 'delegacion', delegated_by: 'dueño', signed_by_session: des.sesion, quote, quote_at: c.cuando, maquina: fp.huella } };
}

function defaultProfile(home) {
  const cfg = require('./tycon-config.js');
  const place = require('../setup/harness/tycon-home.js').resolvePlace({ home });
  if (!place.dir) return { error: 'no encontré el arnés instalado en la casa de la cuenta' };
  const ruta = cfg.perfilDelArbol(place.dir).ruta;
  let texto;
  try { texto = fs.readFileSync(ruta, 'utf8'); } catch (e) { return { error: `no pude leer ${ruta} (${e.code || e.message})` }; }
  const r = cfg.parse(texto);
  if (!r.ok) return { error: r.problems.map((x) => `${x.path}: ${x.message}`).join('; ') };
  return { doc: r.data };
}

/**
 * Escribe la firma: primero el renglón `control-change-signed` en el registro de la cuenta, después la línea de la
 * constancia. Sin el renglón no hay línea. `appendGates(obj)` y `writeApproval(line)` se inyectan.
 */
function writeDelegatedApproval({ home, userInfo, hash, entries, fields, now = () => new Date(), appendGates, writeApproval } = {}) {
  const at = now();
  const gatesLine = { name: SIGNED, status: 'ok', ts: at.toISOString(), hash, sesion: fields.signed_by_session, maquina: fields.maquina };
  try {
    if (appendGates) appendGates(gatesLine);
    else appendGatesLine(accountPaths(accountHome({ home, userInfo })), gatesLine);
  } catch (e) { return { ok: false, reason: `no pude anotar la firma en el registro de la cuenta (${e.code || e.message}): no se firmó nada` }; }
  const line = JSON.stringify({ hash, rules: entries, at: at.toISOString().slice(0, 10), by: 'dueño', ...fields });
  try { writeApproval(line); } catch (e) { return { ok: false, reason: `no pude escribir la constancia (${e.code || e.message})` }; }
  return { ok: true, line };
}

/**
 * Los argumentos de `approve` de un comando escrito literal: `[bash|sh] <…>run-base-controls.sh approve <args>`.
 * `{ args }` o `{ error }`. Nada que el shell expanda: ni `$`, ni comillas invertidas, ni separadores, ni saltos.
 */
function parseApproveCommand(cmd) {
  const s = String(cmd || '').trim();
  if (/[\n\r`]/.test(s)) return { error: 'el comando trae un salto de línea o comillas invertidas' };
  const words = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === ' ' || s[i] === '\t') { i++; continue; }
    let w = '';
    while (i < s.length && s[i] !== ' ' && s[i] !== '\t') {
      const ch = s[i];
      if (ch === "'") {
        const j = s.indexOf("'", i + 1);
        if (j < 0) return { error: 'una comilla simple sin cerrar' };
        w += s.slice(i + 1, j); i = j + 1;
      } else if (ch === '"') {
        const j = s.indexOf('"', i + 1);
        if (j < 0) return { error: 'una comilla doble sin cerrar' };
        const inner = s.slice(i + 1, j);
        if (/[$\\]/.test(inner)) return { error: 'entre comillas dobles no va `$` ni `\\`: usá comillas simples' };
        w += inner; i = j + 1;
      } else if (/[$\\;|&<>(){}*?[\]~#!]/.test(ch)) {
        return { error: `el comando trae «${ch}» fuera de comillas: se escribe literal, sin nada que el shell expanda` };
      } else { w += ch; i++; }
    }
    words.push(w);
  }
  let k = 0;
  if (words[k] === 'bash' || words[k] === 'sh') k++;
  if (!words[k] || !/(^|\/)run-base-controls\.sh$/.test(words[k])) return { error: 'no es un comando de run-base-controls.sh' };
  if (words[k + 1] !== 'approve') return { error: 'no es un `approve`' };
  return { args: words.slice(k + 2) };
}

/**
 * ¿El comando corre `run-base-controls.sh approve … --relayed-by`? Un `grep`, un `cat` o un mensaje de commit que nombran
 * esas palabras no lo corren: el guion tiene que ser lo que arranca un tramo, detrás de un prefijo (`env`, `sudo`,
 * `A=1`) o de `bash`. Lo que corre adentro de un `bash -c '…'`, un `eval` o un `"$(…)"` se mira igual.
 */
function executesApprove(cmd, depth = 0) {
  // más hondo que esto no se sigue: se toma como que corre, y el freno pide el comando literal
  if (depth > 4) return true;
  // la barra con salto de línea une los renglones, como en el shell
  const { segments, inner } = shellSegments(String(cmd || '').replace(/\\\r?\n/g, ' '));
  if (inner.some((s) => executesApprove(s, depth + 1))) return true;
  const INTERPRETES = ['bash', 'sh', 'zsh', 'dash'];
  const limpios = segments.map(sinPrefijos);
  return limpios.some((words, k) => {
    const base = path.basename(words[0] || '');
    if (base === 'eval') return executesApprove(words.slice(1).join(' '), depth + 1);
    if (INTERPRETES.includes(base) || base === 'source' || base === '.') {
      const c = words.findIndex((w, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
      if (c > 0) return executesApprove(words[c + 1] || '', depth + 1);
      words = sacarOpciones(words.slice(1), /^[-+][oO]$/);
      // un intérprete sin guion lee lo que le llega: el texto de un `echo` o un `printf` de antes
      if (!words.length && k > 0 && ['echo', 'printf'].includes(path.basename(limpios[k - 1][0] || ''))) return executesApprove(limpios[k - 1].slice(1).join(' '), depth + 1);
    }
    return /(^|\/)run-base-controls\.sh$/.test(words[0] || '') && words.includes('approve') && words.includes('--relayed-by');
  });
}

// lo que se antepone a un comando sin cambiar cuál corre: prefijos, las opciones con valor de cada uno, y las palabras del shell
const PREFIJOS = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'timeout', 'xargs', 'setsid', 'stdbuf', 'caffeinate']);
const CLAVES_DEL_SHELL = new Set(['{', '}', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!']);
const OPCION_CON_VALOR = /^-[ugCnIdEsLPkDh]$/;

function sinPrefijos(seg) {
  let words = seg.slice();
  let prefijo = null;
  for (;;) {
    const w = words[0];
    if (w === undefined) break;
    if (CLAVES_DEL_SHELL.has(w) || /^[A-Za-z_]\w*=/.test(w)) { words = words.slice(1); continue; }
    if (PREFIJOS.has(w)) { prefijo = w; words = words.slice(1); if (w === 'timeout') words = sacarOpciones(words).slice(1); continue; }
    if (prefijo && w.startsWith('-')) { words = words.slice(OPCION_CON_VALOR.test(w) ? 2 : 1); continue; }
    break;
  }
  return words;
}

function sacarOpciones(words, conValor = OPCION_CON_VALOR) {
  let i = 0;
  while (i < words.length && /^[-+]/.test(words[i])) i += conValor.test(words[i]) ? 2 : 1;
  return words.slice(i);
}

/**
 * Un comando partido como lo corre el shell: los tramos (separados por `;`, `&`, `|`, saltos, paréntesis, comillas
 * invertidas y `$(`), cada uno con sus palabras ya sin comillas ni escapes; y lo que corre adentro de unas comillas
 * dobles (`"$(…)"`, comillas invertidas), para mirarlo aparte.
 */
function shellSegments(s) {
  const segments = [];
  const inner = [];
  let words = [];
  let w = null;
  const push = () => { if (w !== null) { words.push(w); w = null; } };
  const end = () => { push(); if (words.length) segments.push(words); words = []; };
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { w = (w || '') + s[i + 1]; i += 2; continue; }
    if (c === "'") {
      let j = s.indexOf("'", i + 1);
      if (j < 0) j = s.length;
      w = (w || '') + s.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let txt = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) { txt += s[j + 1]; j += 2; } else { txt += s[j]; j++; }
      }
      const corre = /\$\(([\s\S]*)|`([\s\S]*)/.exec(txt);
      if (corre) inner.push(corre[1] !== undefined ? corre[1] : corre[2]);
      w = (w || '') + txt;
      i = j + 1;
      continue;
    }
    if (/\s/.test(c) && c !== '\n') { push(); i++; continue; }
    if (';&|\n()`'.includes(c)) { end(); i++; continue; }
    if (c === '$' && s[i + 1] === '(') { end(); i += 2; continue; }
    w = (w || '') + c;
    i++;
  }
  end();
  return { segments, inner };
}

function cli(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'guard-token') {
    const session = argOf(rest, '--session');
    if (!rest.includes('--command-stdin')) { console.error('uso: delegated-signing.js guard-token --session <sid> --command-stdin'); return 2; }
    let text = '';
    try { text = fs.readFileSync(0, 'utf8'); } catch (e) { console.error(`no pude leer el comando (${e.code || e.message})`); return 2; }
    // 3: el comando no firma nada, el freno lo deja pasar
    if (!executesApprove(text)) return 3;
    const parsed = parseApproveCommand(text);
    if (parsed.error) { console.error(`la firma por delegación se escribe literal: ${parsed.error}`); return 1; }
    const r = issueToken({ session, args: parsed.args });
    if (!r.ok) { console.error(r.reason); return 1; }
    return 0;
  }
  if (cmd === 'confirm-designation') {
    const rw = require(path.join(PIPELINE_LIB, 'runtime-waiver.js'));
    if (!rw.hasTty()) { console.error('🔒 confirm-designation pide la terminal del dueño (/dev/tty): el agente no puede correrlo.'); return 2; }
    const p = accountPaths(accountHome());
    const cw = require(path.join(PIPELINE_LIB, 'critical-waivers.js'));
    const d = cw.designacionVigente({ dir: p.state });
    if (!d || d.error) { console.error((d && d.error) || 'ninguna sesión de esta máquina está designada'); return 1; }
    console.error(`La sesión designada es la «${d.rol}» (${d.sesion}), desde ${d.ts}, con la frase: «${d.cita}».`);
    console.error('Con esto, esa sesión puede firmar cambios de control en tu nombre, con tu frase en su chat.');
    if (!rw.confirmarFrase()) { console.error('No coincide: no se confirmó nada.'); return 1; }
    appendGatesLine(p, confirmationRecord(d, new Date().toISOString()));
    console.error('✅ designación confirmada.');
    return 0;
  }
  console.error('uso: delegated-signing.js guard-token --session <sid> --command-stdin | confirm-designation');
  return 2;
}

module.exports = {
  accountPaths, digestOf, confirmationRecord, recordShown, relayRole, delegatedCommand, issueToken, checkDelegatedApprove,
  writeDelegatedApproval, parseApproveCommand, executesApprove, machineDelegates, openWork, quoteJudge, TOKEN_TTL_MS, QUOTE_PLACEHOLDER,
};

if (require.main === module) process.exit(cli(process.argv.slice(2)));
