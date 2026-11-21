#!/usr/bin/env node
'use strict';
/*
 * office-link-start.js — la oficina del sitio sin pasos para el dev: el alta automática de la máquina, el proceso que le
 * manda la foto, y la capa del equipo al día mientras se trabaja.
 *
 * Al abrir una sesión, con `site.url` en el perfil: si la máquina todavía no pidió el alta, arma su par de claves, le manda
 * al sitio sólo la pública y muestra una línea con la huella (el dev no corre nada, la aprueba quien mantiene). Sin red no
 * muestra nada y lo intenta en la próxima sesión. Después lanza el proceso de la oficina sin esperarlo, o le avisa al que
 * ya está, aunque el alta haya fallado: una clave rota no deja a la máquina sin proceso. Sin `site.url` no hace nada.
 *
 * En cada pedido de la persona, a lo sumo cada 30 min por máquina (el sello `<estado>/office/team-refresh.json`, escrito
 * al lanzar): lanza aparte, sin esperarlo, este mismo gancho con `--after-refresh`, que corre `harness.js team-refresh`
 * (la capa del equipo sola, sin versión ni aplicador) y después hace lo mismo que al abrir una sesión. Así un perfil que
 * trae `site.url` enlaza la máquina sin abrir sesión ni correr /office, y con la capa cambiada le avisa `config` al
 * proceso vivo, que relee la dirección.
 *
 * Nunca tarda más de 3 s ni frena nada: lo que falla queda en `<estado>/office/site-link.log`.
 * Apagado: TYCON_OFFICE_LINK=0 (todo) · TYCON_TEAM_REFRESH=0 (la puesta al día al pedir).
 * Casos: scripts/tests/office-site-link.test.js (T8, T9, T44, T45) y scripts/controls-bench/cases/hooks/79-oficina-canal-de-vuelta.json
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_MS = 2800;
const REFRESH_EVERY_MS = 30 * 60 * 1000;
const REFRESH_MAX_MS = 4 * 60 * 1000;
// un agente de compilación no es una máquina del equipo: no pide el alta ni lanza nada
const ANY_VALUE = ['AGENT_ID', 'BUILD_BUILDID', 'SYSTEM_TEAMFOUNDATIONCOLLECTIONURI'];
const TRUE_VALUE = ['TF_BUILD', 'GITHUB_ACTIONS', 'CI'];
const inBuildAgent = (env) => ANY_VALUE.some((k) => String(env[k] || '').trim() !== '') || TRUE_VALUE.some((k) => /^(true|1)$/i.test(String(env[k] || '').trim()));
const off = (env) => env.TYCON_OFFICE_LINK === '0' || env.TYCON_EVAL_SANDBOX === '1' || inBuildAgent(env);

const stateDirOf = (home) => require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')).stateDir(home);
const stampFile = (sdir) => path.join(sdir, 'office', 'team-refresh.json');

/** El evento de la herramienta, de lo que manda por la entrada; null si no se lee. */
function eventOf(input) {
  try { const d = JSON.parse(String(input || '')); return d && typeof d.hook_event_name === 'string' ? d.hook_event_name : null; } catch { /* abajo */ }
  // un pedido largo (un registro pegado) pasa de lo que se lee: el evento se busca en el texto cortado
  const m = /"hook_event_name"\s*:\s*"([A-Za-z]+)"/.exec(String(input || ''));
  return m ? m[1] : null;
}

/** Lo de abrir una sesión: el alta si hace falta y el proceso. `notifyType` es el aviso al proceso que ya estaba. */
async function linkNow({ env, home, write, notifyType = 'session' }) {
  const config = require('../lib/tycon-config.js');
  const { enrollIfNeeded, launchServer, appendLog } = require('../tools/office/site-link.js');
  const sdir = stateDirOf(home);
  const read = config.leerParaHook();
  if (!read.ok) { appendLog(sdir, 'la configuración no se pudo leer: la máquina no se enlaza con el sitio hasta que se lea'); return; }
  const site = config.valor(read.config, 'site.url');
  const { machineUrl } = require('../tools/office/fields.js');
  // sin dirección, un proceso vivo que sigue enlazado se tiene que enterar: la pudo sacar el arranque de la sesión, no
  // sólo la puesta al día de la capa (sin proceso vivo, el aviso no llega a nadie)
  if (typeof site !== 'string' || !machineUrl(site)) { require('../lib/office-event.js').notify(null, { home, type: 'config' }); return; }
  try {
    const line = await enrollIfNeeded({ site, sdir });
    if (line) write(line);
  } catch (e) {
    appendLog(sdir, `el pedido de alta falló (${e.code || e.message}): se reintenta en la próxima sesión`);
  }
  try {
    const launched = await launchServer({ sdir, env });
    // el proceso que ya estaba se entera: conecta si la máquina acaba de pedir el alta, si estaba de baja o si cambió la dirección
    if (launched === 'reused' || launched === 'busy') require('../lib/office-event.js').notify(null, { home, type: notifyType });
  } catch (e) {
    appendLog(sdir, `el arranque de la oficina falló (${e.code || e.message})`);
  }
}

/** ¿Toca la puesta al día? El sello vencido, roto o ausente dice que sí; se escribe al lanzar. */
function refreshDue(sdir, now) {
  try {
    const at = Date.parse(JSON.parse(fs.readFileSync(stampFile(sdir), 'utf8')).at);
    if (Number.isFinite(at) && now - at >= 0 && now - at < REFRESH_EVERY_MS) return false;
  } catch { /* sin sello o roto: toca */ }
  return true;
}

/** Al pedir: lanza aparte la puesta al día de la capa, sin esperarla. */
function onPrompt({ env, home, now = Date.now() }) {
  if (env.TYCON_TEAM_REFRESH === '0') return;
  const sdir = stateDirOf(home);
  if (!refreshDue(sdir, now)) return;
  const { appendLog } = require('../tools/office/site-link.js');
  try {
    fs.mkdirSync(path.dirname(stampFile(sdir)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stampFile(sdir), JSON.stringify({ at: new Date(now).toISOString() }));
  } catch (e) {
    appendLog(sdir, `no se pudo escribir el sello de la puesta al día (${e.code || e.message}): no se lanza`);
    return;
  }
  // un lanzamiento que falla borra el sello: el pedido siguiente lo vuelve a intentar, no dentro de 30 min
  const failed = (e) => {
    appendLog(sdir, `no se pudo lanzar la puesta al día de la capa del equipo (${e.code || e.message}): se reintenta en el próximo pedido`);
    try { fs.unlinkSync(stampFile(sdir)); } catch { /* ya no estaba */ }
  };
  try {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [__filename, '--after-refresh'], { detached: true, windowsHide: true, stdio: 'ignore', env });
    child.on('error', failed);
    child.unref();
  } catch (e) { failed(e); }
}

/** Aparte del pedido: la capa del equipo y, con ella al día, lo mismo que al abrir una sesión. */
async function afterRefresh({ env, home }) {
  setTimeout(() => process.exit(0), REFRESH_MAX_MS).unref();
  const { spawnSync } = require('child_process');
  const { appendLog } = require('../tools/office/site-link.js');
  const sdir = stateDirOf(home);
  // en las pruebas, la puesta al día es la que ellas den: el arnés real no se toca
  const harness = env.TYCON_OFFICE_TEST === '1' && env.TYCON_TEAM_REFRESH_RUN ? env.TYCON_TEAM_REFRESH_RUN : path.join(__dirname, '..', 'setup', 'harness.js');
  const r = spawnSync(process.execPath, [harness, 'team-refresh', '--json'], { env, encoding: 'utf8', windowsHide: true, timeout: REFRESH_MAX_MS - 10000, input: '' });
  let result = null;
  try { result = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { /* abajo */ }
  const said = () => (result.lines || []).join(' · ').slice(0, 300);
  if (!result) appendLog(sdir, `la puesta al día de la capa del equipo no contestó (${r.error ? r.error.code || r.error.message : `salió ${r.status}`}): se reintenta en 30 min`);
  else if (result.status === 'failed') appendLog(sdir, `la puesta al día de la capa del equipo falló: ${said()}`);
  else if (result.status === 'busy') appendLog(sdir, `la puesta al día de la capa del equipo no corrió, otra sesión estaba actualizando: ${said()}`);
  // sin capa que mirar (política mal escrita, un cambio de versión a medias) también queda: cada 30 min se repite igual
  else if (result.status === 'none') appendLog(sdir, `la puesta al día de la capa del equipo no miró nada: ${said()}`);
  const changed = Boolean(result && result.profileChanged);
  // un perfil que sacó la dirección también se avisa: el proceso vivo se desenlaza
  if (changed) require('../lib/office-event.js').notify(null, { home, type: 'config' });
  await linkNow({ env, home, write: (line) => appendLog(sdir, line), notifyType: changed ? 'config' : 'session' });
}

async function main({ env = process.env, home = os.homedir(), write = (t) => console.log(t), input = '', argv = process.argv.slice(2) } = {}) {
  if (off(env)) return;
  if (argv.includes('--after-refresh')) { await afterRefresh({ env, home }); return; }
  setTimeout(() => process.exit(0), Math.max(0, MAX_MS - process.uptime() * 1000)).unref();
  if (eventOf(input) === 'UserPromptSubmit') { onPrompt({ env, home }); return; }
  await linkNow({ env, home, write });
}

/** Lo que manda la herramienta, sin quedarse esperando: una terminal o una entrada que no cierra no frena el arranque. */
function readInput() {
  if (process.argv.includes('--after-refresh') || process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let text = '';
    const done = () => resolve(text);
    setTimeout(done, 300).unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { text += d; if (text.length > 64 * 1024) done(); });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

if (require.main === module) {
  // el arranque de la sesión no se entera; queda en el registro de la oficina, que en el proceso aparte es lo único que hay
  readInput().then((input) => main({ input })).catch((e) => {
    try { require('../tools/office/site-link.js').appendLog(stateDirOf(os.homedir()), `el gancho de la oficina falló (${e && (e.code || e.message)})`); } catch { /* sin registro: nada más que hacer */ }
  });
}

module.exports = { main, refreshDue, REFRESH_EVERY_MS };
