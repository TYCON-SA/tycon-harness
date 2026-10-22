#!/usr/bin/env node
/**
 * guard-update-notice.js — al abrir la sesión: compara si esta máquina tiene el permiso de actualizar el freno de
 * producción sin contraseña con lo que eligió la organización (`guard.update` del perfil del equipo), y muestra la última
 * actualización que hizo sola. Casos: scripts/tests/guard-update-notice.test.sh.
 *
 * POR QUÉ EXISTE: el permiso de sudo de una máquina lo pone y lo saca su persona, con su contraseña; lo que elige la
 * organización desde el sitio no lo cambia solo. Sin este aviso, una organización que vuelve a «con la contraseña» sigue
 * con máquinas que se actualizan solas, y una que elige «solo» no se entera de qué máquinas no instalaron el permiso.
 *
 * QUÉ MIRA: la marca de root `/opt/tycon/production/auto-update.json` (la deja `install-guard.sh --allow-auto-update`)
 * contra `guard.update`, en las dos direcciones, con el comando exacto para corregirlo. Coincidiendo con el permiso puesto,
 * muestra el último renglón de `production/update-log.jsonl`. Un valor roto se toma como «con la contraseña» y se dice;
 * un perfil que no se lee, también se dice.
 *
 * Nunca cambia nada ni bloquea: imprime y sale 0. Sólo habla en una máquina con el freno instalado (/opt/tycon).
 * Off: TYCON_GUARD_UPDATE_NOTICE=0. En pruebas, TYCON_PROD_ROOT es la raíz de sistema falsa y TYCON_GUIDES_DIR el arnés
 * cuyo perfil se lee (sin ellas, /opt de verdad y el arnés de este archivo).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ARBOL = path.resolve(__dirname, '..', '..');
const INSTALADOR = path.join(ARBOL, 'scripts', 'production', 'install-guard.sh');

function leerEleccion(arnes) {
  // el lector de ESTE árbol; la clave vale sólo desde el perfil del equipo
  try {
    const c = require(path.join(ARBOL, 'scripts', 'lib', 'tycon-config.js')).cargar({ env: {}, arnes });
    const rota = (c.errores || []).find((e) => e.clave === 'guard.update');
    if (rota) return { valor: 'password', aviso: `guard.update está roto en el perfil del equipo (${rota.motivo}): lo tomo como «con la contraseña»` };
    const ilegible = (c.errores || []).find((e) => !e.clave);
    if (ilegible) return { valor: null, aviso: `no pude leer lo que eligió la organización para actualizar el freno (${ilegible.archivo}: ${ilegible.motivo})` };
    return { valor: c.valores.guard && c.valores.guard.update === 'auto' ? 'auto' : 'password' };
  } catch (e) {
    return { valor: null, aviso: `no pude leer lo que eligió la organización para actualizar el freno (${e.message})` };
  }
}

function ultimaActualizacion(registro) {
  let lineas;
  try { lineas = fs.readFileSync(registro, 'utf8').split('\n').filter((l) => l.trim()); } catch (e) {
    return e && e.code === 'ENOENT' ? 'todavía no se actualizó sola' : `no pude leer el registro de actualizaciones (${(e && e.code) || e})`;
  }
  for (let i = lineas.length - 1; i >= 0; i--) {
    try {
      const r = JSON.parse(lineas[i]);
      if (r && r.to_version) return `el freno se actualizó solo a ${r.to_version}${r.at ? ` (${String(r.at).slice(0, 16).replace('T', ' ')} UTC)` : ''}`;
    } catch { /* un renglón ilegible no es la última actualización: se mira el anterior */ }
  }
  return lineas.length ? 'no pude leer la última actualización del registro' : 'todavía no se actualizó sola';
}

function avisos({ raiz, arnes }) {
  const opt = path.join(raiz, 'opt', 'tycon');
  if (!fs.existsSync(opt)) return [];
  const prod = path.join(opt, 'production');
  const conPermiso = fs.existsSync(path.join(prod, 'auto-update.json'));
  const e = leerEleccion(arnes);
  const out = [];
  if (e.aviso) out.push(`🟠 freno de producción: ${e.aviso}.`);
  if (e.valor === null) return out;
  if (conPermiso && e.valor === 'password') {
    out.push(`🟠 freno de producción: la organización eligió «con la contraseña» y esta máquina tiene el permiso de actualizarse sola: sacalo con \`sudo bash ${INSTALADOR} --remove-auto-update\`.`);
  } else if (!conPermiso && e.valor === 'auto') {
    out.push(`🟠 freno de producción: la organización eligió «solo» y esta máquina no tiene el permiso: instalalo con \`sudo bash ${INSTALADOR} --allow-auto-update\` (pide tu contraseña).`);
  } else if (conPermiso) {
    out.push(`ℹ️ freno de producción: actualización sin contraseña encendida · ${ultimaActualizacion(path.join(prod, 'update-log.jsonl'))}.`);
  }
  return out;
}

if (require.main === module) {
  try {
    if (process.env.TYCON_GUARD_UPDATE_NOTICE !== '0') {
      const raiz = process.env.TYCON_PROD_ROOT || '/';
      const arnes = process.env.TYCON_GUIDES_DIR || ARBOL;
      for (const l of avisos({ raiz, arnes })) console.log(l);
    }
  } catch (e) {
    console.log(`🟠 freno de producción: el aviso de la actualización sin contraseña falló (${e.message}).`);
  }
  process.exit(0);
}

module.exports = { avisos };
