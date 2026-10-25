#!/usr/bin/env node
'use strict';
// work-signal.js — el evento neutro de trabajo: «el agente empieza, sigue o termina con tal historia».
//
// El núcleo no registra horas ni sabe con qué herramienta se registran. Emite el evento y se lo pasa a la integración de
// horas que eligió la organización (`integrations.timeTracking`): la carpeta `integrations/<nombre>/` cuyo manifiesto
// dice `kind: "timeTracking"`. La integración lo recibe por la entrada estándar, como un objeto JSON:
//
//   { event, storyId, title, repo, sessionId, at, stateDir, settings, missing }
//
//   · `event`: start · activity · stop · sweep (cerrar lo que quedó abierto sin actividad) · entry (qué entrada tiene
//     abierta esta sesión: no abre ni cierra nada).
//   · `at`: la hora en UTC con Z, sin milésimas.
//   · `stateDir`: la carpeta donde la integración guarda su estado en esta máquina.
//   · `settings`: los ajustes que declara su manifiesto, por su última parte (`url`, `token`); `missing`, los que faltan,
//     con dónde se ponen. Los secretos viajan por la entrada estándar: el núcleo nunca los pone en un argumento.
//
// `stop` devuelve por la salida lo que informe la integración (`{"seconds":1080}`) o `{}`; `entry`, el id de la entrada
// abierta (`{"entryId":"…"}`) o `{}`, y el núcleo lo usa como evidencia de la acción del agente; cualquier evento puede traer
// además `{"action":"…"}`: lo que el agente tiene que hacer con una herramienta que maneja él. Sin integración elegida, con
// `none`, o con una que no existe, no corre nada y devuelve `{}`. Nunca sale distinto de 0 por la herramienta: una
// historia no se frena porque la herramienta de horas falla o falta configurarla (2 sólo para un uso mal escrito).
//
// Uso: node scripts/lib/work-signal.js <start|activity|stop|sweep|entry> --story <id> --title <t> --repo <ruta> --session <id>
// Casos: scripts/tests/work-signal.test.js.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const INT = require('./integrations.js');

const KIND = 'timeTracking';
const EVENTS = Object.freeze(['start', 'activity', 'stop', 'sweep', 'entry']);
const ON_WORK_MS = 15000;

const nowUtc = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** La configuración cargada sin frenar: rota, el motivo en una línea. */
function loadConfig({ env, home }) {
  let TC;
  try { TC = require('./tycon-config.js'); } catch (e) { return { config: null, problem: `el lector de configuración no carga (${e.code || e.message})` }; }
  const opts = { env };
  if (home) opts.home = home;
  const c = TC.cargar(opts);
  if (c.errores.length) return { config: null, problem: `la configuración está rota (${c.errores.map((e) => `${e.clave || e.archivo}: ${e.motivo}`).join(' | ')})` };
  return { config: c, TC };
}

/**
 * La integración de horas elegida: `{ manifest, value }`, o `{ manifest: null, warning }` (sin elegir, `none`, o una que
 * no existe; `warning` vacío cuando no hay nada que decir).
 */
function chosen({ env = process.env, home } = {}) {
  const l = loadConfig({ env, home });
  if (!l.config) return { manifest: null, value: null, warning: `aviso de trabajo: ${l.problem}; no registro nada`, config: null };
  const t = l.TC.timeTracking(l.config);
  if (t.value === 'none') return { manifest: null, value: 'none', warning: '', config: l.config };
  const manifest = INT.find(t.value, { kind: KIND, env });
  if (!manifest) {
    const all = INT.listManifests({ env });
    const broken = all.problems.find((p) => p.name === t.value);
    if (broken) return { manifest: null, value: t.value, warning: `la integración de horas «${t.value}» tiene el manifiesto roto (${broken.reasons.join('; ')}); se trata como ninguna`, config: l.config };
    const there = all.manifests.filter((m) => m.kind === KIND).map((m) => m.name);
    return { manifest: null, value: t.value, warning: `integración de horas desconocida: «${t.value}» (las que hay: ${there.length ? there.join(', ') : 'ninguna'}); se trata como ninguna`, config: l.config };
  }
  return { manifest, value: t.value, warning: '', config: l.config };
}

/** Los ajustes que la integración declara: `{ settings: { clave: valor }, missing: [{ key, where }] }`. */
function settingsFor(manifest, { config, env = process.env }) {
  const settings = {};
  const missing = [];
  const own = (config && config.valores.integraciones[manifest.name]) || {};
  for (const s of manifest.settings) {
    const name = s.key.split('.').pop();
    if (s.type === 'secreto') {
      const v = INT.readSecret(s.key, { env });
      if (v) settings[name] = v;
      else {
        // un archivo de secretos dañado no es «falta»: guardar encima no se puede (no se pisa), hay que arreglarlo
        const damaged = /dañado/.test(INT.secretState(s.key, { env }));
        missing.push(damaged ? { key: s.key, where: 'machine', damaged: true, file: INT.secretsFile(manifest.name, env) } : { key: s.key, where: 'machine', how: `harness.js config set ${s.key}` });
      }
    } else if (s.from === 'profile') {
      const v = own[name];
      if (typeof v === 'string' && v.trim()) settings[name] = v.trim(); else missing.push({ key: s.key, where: 'profile' });
    }
  }
  return { settings, missing };
}

/**
 * Emite un evento. `{ ran, result, warnings }`: `result` es lo que la integración devolvió (`{}` si nada), `warnings` las
 * líneas que dejó en su salida de errores más las del núcleo.
 */
function emit(event, fields = {}, { env = process.env, home } = {}) {
  const c = chosen({ env, home });
  const warnings = c.warning ? [c.warning] : [];
  if (!c.manifest || !c.manifest.onWork) return { ran: false, result: {}, warnings };
  const { settings, missing } = settingsFor(c.manifest, { config: c.config, env });
  const payload = {
    event, storyId: fields.storyId || null, title: fields.title || null, repo: fields.repo || null, sessionId: fields.sessionId || null,
    at: nowUtc(), stateDir: path.join(INT.tyconHome(env), 'state', 'time-tracking', c.manifest.name), settings, missing,
  };
  if (!fs.existsSync(c.manifest.onWork)) {
    warnings.push(`${c.manifest.name}: no encuentro el guion que escucha el evento (${path.relative(c.manifest.dir, c.manifest.onWork)}); sigo sin registrar`);
    return { ran: false, result: {}, warnings };
  }
  const r = spawnSync(process.execPath, [c.manifest.onWork], { input: JSON.stringify(payload), encoding: 'utf8', timeout: ON_WORK_MS, env, windowsHide: true });
  if (r.error && r.error.code !== 'ETIMEDOUT') {
    warnings.push(`${c.manifest.name}: no pude lanzar la integración (${r.error.code || 'error'}); sigo sin registrar`);
    return { ran: false, result: {}, warnings };
  }
  if (r.error || r.status === null) {
    warnings.push(`${c.manifest.name}: la integración no terminó a tiempo (${Math.round(ON_WORK_MS / 1000)} s); sigo sin registrar`);
    return { ran: true, result: {}, warnings };
  }
  for (const line of String(r.stderr || '').split('\n')) if (line.trim()) warnings.push(line.trim());
  let result = {};
  const last = String(r.stdout || '').trim().split('\n').pop();
  if (last) { try { const j = JSON.parse(last); if (j && typeof j === 'object' && !Array.isArray(j)) result = j; } catch (_) { /* una salida que no es JSON no es un resultado */ } }
  if (r.status !== 0) warnings.push(`${c.manifest.name}: la integración salió ${r.status}; sigo sin registrar`);
  // lo que el núcleo deja pasar de la integración: los segundos registrados (`stop`) y, para una herramienta que maneja el
  // agente (su MCP), la acción que tiene que hacer
  const out = {};
  if (event === 'stop' && Number.isInteger(result.seconds) && result.seconds >= 0) out.seconds = result.seconds;
  if (event === 'entry' && typeof result.entryId === 'string' && result.entryId.trim()) out.entryId = result.entryId.trim().slice(0, 120);
  if (typeof result.action === 'string' && result.action.trim()) out.action = result.action.trim().slice(0, 600);
  return { ran: true, result: out, warnings };
}

function parseArgs(argv) {
  const [event, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const m = /^--(story|title|repo|session)$/.exec(rest[i]);
    if (!m || rest[i + 1] === undefined) return { error: `opción desconocida o sin valor: ${rest[i]}` };
    flags[m[1]] = rest[++i];
  }
  if (!EVENTS.includes(event)) return { error: `el evento es uno de ${EVENTS.join(', ')}${event ? ` (dice «${event}»)` : ''}` };
  return { event, fields: { storyId: flags.story, title: flags.title, repo: flags.repo, sessionId: flags.session } };
}

if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  if (a.error) {
    process.stderr.write(`work-signal: ${a.error}\nuso: work-signal.js <${EVENTS.join('|')}> --story <id> --title <t> --repo <ruta> --session <id>\n`);
    process.exit(2);
  }
  let r;
  try { r = emit(a.event, a.fields); } catch (e) { r = { result: {}, warnings: [`aviso de trabajo: falló (${e.code || e.message}); sigo sin registrar`] }; }
  for (const w of r.warnings) process.stderr.write(`${w}\n`);
  process.stdout.write(`${JSON.stringify(r.result)}\n`);
  process.exit(0);
}

module.exports = { chosen, settingsFor, emit, EVENTS, KIND };
