#!/usr/bin/env node
'use strict';
/**
 * check-profile-levels.js — el perfil del equipo delega sólo rutina.
 *
 * La coordinadora firma sola lo que el perfil pone en `approvals.delegated_signing`. Por la tabla de niveles
 * (scripts/lib/signatures.js, LEVELS) eso es sólo el nivel 1: una excepción (2) o algo irreversible (3) lo firma una
 * persona. Este control rechaza el perfil que delega una firma de nivel 2 o más, nombrada por su id o traída por un
 * grupo. Mide el nivel que la firma alcanza por delegación (`delegatedLevel`).
 *
 * Uso: node scripts/ci/check-profile-levels.js [--profile <ruta>]
 *   Sin --profile mira team-profile.json (o el nombre viejo, perfil-equipo.json) en la raíz del árbol, que es donde la
 *   capa del equipo lo deja; TYCON_PROFILE_ROOT cambia esa raíz.
 * Sale 0 si sólo delega rutina, o si no hay perfil (y lo dice: no midió); 1 si delega de más; 2 si no se pudo leer.
 */
const fs = require('fs');
const path = require('path');
const cat = require('../lib/signatures.js');

const NOMBRES = ['team-profile.json', 'perfil-equipo.json'];

/** Las firmas delegadas de nivel 2 o más: `{ rejected: [{ id, level, via }] }`, `via` es el valor del perfil que la trae. */
function check(profile) {
  const a = profile && typeof profile === 'object' && profile.approvals && typeof profile.approvals === 'object' ? profile.approvals : {};
  const v = a.delegated_signing;
  const valores = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  const rejected = [];
  // recortado como lo lee el lector del perfil (tycon-config.js): con espacios alrededor, el valor igual delega
  for (const via of valores.map((x) => String(x).trim())) {
    for (const id of cat.expand(via)) {
      const level = cat.delegatedLevel(id);
      if (level >= 2 && !rejected.some((r) => r.id === id)) rejected.push({ id, level, via });
    }
  }
  return { rejected };
}

function main(argv) {
  const i = argv.indexOf('--profile');
  let ruta = i >= 0 ? argv[i + 1] : null;
  if (i >= 0 && !ruta) { console.error('check-profile-levels: --profile pide una ruta'); return 2; }
  if (!ruta) {
    const raiz = process.env.TYCON_PROFILE_ROOT || path.resolve(__dirname, '..', '..');
    ruta = NOMBRES.map((n) => path.join(raiz, n)).find((p) => fs.existsSync(p)) || null;
    if (!ruta) { console.log(`check-profile-levels: no hay perfil del equipo en ${raiz}: no se midió`); return 0; }
  }
  let profile;
  try { profile = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch (e) {
    console.error(`check-profile-levels: no se pudo leer ${ruta}: ${e.message}`);
    return 2;
  }
  const { rejected } = check(profile);
  if (!rejected.length) { console.log(`check-profile-levels: ${path.basename(ruta)} sólo delega rutina (nivel 1)`); return 0; }
  console.error(`check-profile-levels: ${path.basename(ruta)} delega firmas que la coordinadora no puede dar sola:`);
  for (const r of rejected) {
    console.error(`  ${r.id}: nivel ${r.level}${r.via === r.id ? '' : ` (la trae el grupo «${r.via}»)`}`);
  }
  console.error('Sacalas de approvals.delegated_signing: una excepción o algo irreversible lo firma una persona (guides/firmas-del-arnes.md).');
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { check };
