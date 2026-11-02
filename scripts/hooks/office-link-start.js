#!/usr/bin/env node
'use strict';
/*
 * office-link-start.js — al abrir una sesión, con `site.url` en el perfil: el alta automática de la máquina en la oficina
 * del sitio y el proceso que le manda la foto.
 *
 * Sin `site.url` no hace nada: no arma clave ni lanza nada. Con `site.url`, si la máquina todavía no pidió el alta, arma su
 * par de claves, le manda al sitio sólo la pública y muestra una línea con la huella: el dev no corre nada, la aprueba
 * quien mantiene. Sin red no muestra nada y lo intenta en la próxima sesión. Después lanza el proceso de la oficina sin
 * esperarlo, o le avisa al que ya está, aunque el alta haya fallado: una clave rota no deja a la máquina sin proceso.
 *
 * Nunca tarda más de 3 s en arrancar la sesión ni frena nada: lo que falla queda en `<estado>/office/site-link.log`.
 * Apagado: TYCON_OFFICE_LINK=0. Casos: scripts/tests/office-site-link.test.js
 */
const os = require('os');
const path = require('path');

const MAX_MS = 2800;
// un agente de compilación no es una máquina del equipo: no pide el alta ni lanza nada
const ANY_VALUE = ['AGENT_ID', 'BUILD_BUILDID', 'SYSTEM_TEAMFOUNDATIONCOLLECTIONURI'];
const TRUE_VALUE = ['TF_BUILD', 'GITHUB_ACTIONS', 'CI'];
const inBuildAgent = (env) => ANY_VALUE.some((k) => String(env[k] || '').trim() !== '') || TRUE_VALUE.some((k) => /^(true|1)$/i.test(String(env[k] || '').trim()));

async function main({ env = process.env, home = os.homedir(), write = (t) => console.log(t) } = {}) {
  if (env.TYCON_OFFICE_LINK === '0' || env.TYCON_EVAL_SANDBOX === '1' || inBuildAgent(env)) return;
  const config = require('../lib/tycon-config.js');
  const read = config.leerParaHook();
  if (!read.ok) return;
  const site = config.valor(read.config, 'site.url');
  const { machineUrl } = require('../tools/office/fields.js');
  if (typeof site !== 'string' || !machineUrl(site)) return;

  setTimeout(() => process.exit(0), Math.max(0, MAX_MS - process.uptime() * 1000)).unref();
  const { stateDir } = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'));
  const { enrollIfNeeded, launchServer, appendLog } = require('../tools/office/site-link.js');
  const sdir = stateDir(home);
  try {
    const line = await enrollIfNeeded({ site, sdir });
    if (line) write(line);
  } catch (e) {
    appendLog(sdir, `el pedido de alta falló (${e.code || e.message}): se reintenta en la próxima sesión`);
  }
  try {
    const launched = await launchServer({ sdir, env });
    // el proceso que ya estaba se entera de la sesión nueva: conecta si la máquina acaba de pedir el alta o si estaba de baja
    if (launched === 'reused' || launched === 'busy') require('../lib/office-event.js').notify(null, { home, type: 'session' });
  } catch (e) {
    appendLog(sdir, `el arranque de la oficina falló (${e.code || e.message})`);
  }
}

if (require.main === module) {
  main().catch(() => { /* el arranque de la sesión no se entera */ });
}

module.exports = { main };
