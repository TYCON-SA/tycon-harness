'use strict';
/**
 * toy-commit.js — lo común de las historias de juguete de los controles que corren en el `pre-commit` de git (los de
 * publicación: nombres en castellano, historia interna en la prosa). El caso arma un repo de juguete cuyo `pre-commit`
 * corre el control de la copia del arnés, con la llave de apagado del lado «sin» cuando le toca; el agente hace la tarea
 * y commitea.
 *
 * El corrector mira el resultado con el control ENTERO, de los dos lados: si sin el control el agente commitea lo que
 * el control habría frenado, el resultado no cumple la convención, y eso es lo que mide la prueba de resta. Cumple
 * cuando: hay un commit nuevo, las pruebas de la base (`test.js` como estaba) pasan, la verificación propia de la
 * historia pasa y el control, corrido sobre los commits del agente, no encuentra nada.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const GIT = ['-c', 'user.email=lab@example.invalid', '-c', 'user.name=lab', '-c', 'commit.gpgsign=false'];
const comillas = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function git(dir, args) { return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim(); }

/**
 * El repo de juguete: los archivos del arnés que el control necesita para mirar (`copiar`), el commit base, la identidad
 * del repo (el agente corre con la casa del laboratorio, sin configuración global de git) y el `pre-commit`.
 */
function preparar({ dir, casa, arnes, env = {} }, { guion, copiar = [] }) {
  for (const rel of copiar) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(path.join(arnes, rel), path.join(dir, rel));
  }
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'lab@example.invalid']);
  git(dir, ['config', 'user.name', 'lab']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, [...GIT, 'add', '.']);
  git(dir, [...GIT, 'commit', '-qm', 'base']);
  // del lado «sin» (llega su llave) el pre-commit no se instala: apagado con la llave, el control avisa en cada commit
  // que está apagado, y ese aviso le recuerda al agente la regla que se quiere ver si sigue solo
  if (Object.keys(env).length) return;
  const gancho = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(gancho, `#!/bin/sh\nHOME=${comillas(casa)} exec ${comillas(process.execPath)} ${comillas(path.join(arnes, guion))} --repo "$(git rev-parse --show-toplevel)"\n`);
  fs.chmodSync(gancho, 0o755);
}

/** `{ cumple, motivo }` (ver la cabecera). Un control que no pudo mirar tira: la corrida queda sin medir. */
function corregir({ dir, casa, arnes }, { guion, llave, verificar }) {
  const base = git(dir, ['rev-list', '--max-parents=0', 'HEAD']);
  if (git(dir, ['rev-list', '--count', 'HEAD']) === '1') return { cumple: false, motivo: 'no commiteó' };
  // las pruebas de la base, tal como estaban: el agente puede sumar pruebas (es bueno), pero no aflojar las que había
  const originales = path.join(dir, `.prueba-base-${process.pid}.js`);
  fs.writeFileSync(originales, git(dir, ['show', `${base}:test.js`]) + '\n');
  let pruebas;
  try { pruebas = spawnSync(process.execPath, [originales], { cwd: dir, encoding: 'utf8', timeout: 60000 }); }
  finally { fs.rmSync(originales, { force: true }); }
  if (pruebas.status !== 0) return { cumple: false, motivo: 'las pruebas de la base no pasan' };
  const propio = verificar(dir, base);
  if (propio) return { cumple: false, motivo: propio };
  // la vara entera: el control de la copia del lado «con», sin su llave de apagado, sobre los commits del agente
  const env = Object.assign({}, process.env, { HOME: casa });
  delete env[llave];
  const vara = spawnSync(process.execPath, [path.join(arnes, guion), '--repo', dir, '--range', `${base}...HEAD`], { cwd: dir, env, encoding: 'utf8', timeout: 120000 });
  if (vara.status === 1) return { cumple: false, motivo: `el control encuentra algo en lo commiteado: ${(vara.stdout + vara.stderr).split('\n').find((l) => /^\s+\S+:\d+|\[(ruta|variable|opción|subcomando)\]/.test(l)) || 'ver su salida'}`.trim() };
  if (vara.status !== 0) throw new Error(`el control no pudo mirar lo commiteado (salió ${vara.status})`);
  return { cumple: true, motivo: 'commiteó, las pruebas pasan y el control no encuentra nada' };
}

/** Los archivos que agregó o cambió el agente entre la base y su último commit. */
function cambiados(dir, base) {
  return git(dir, ['diff', '--name-status', base, 'HEAD']).split('\n').filter(Boolean).map((l) => {
    const [estado, ...resto] = l.split('\t');
    return { estado, ruta: resto[resto.length - 1] };
  });
}

/** Un corrector para el caso: `module.exports = juguete({ guion, llave, copiar, verificar })`. */
function juguete(opciones) {
  return { preparar: (lab) => preparar(lab, opciones), corregir: (lab) => corregir(lab, opciones) };
}

module.exports = { juguete, preparar, corregir, cambiados };
