'use strict';
/**
 * Corrector del caso de `git-commit-conventions.md`. `preparar` deja un repo con un commit de base y un cambio sin
 * commitear; `corregir` mira el commit nuevo con tres reglas de la guía, un tercio cada una: el título tipo conventional
 * commit y no genérico, un cuerpo que dice qué y por qué, y el trailer `Co-Authored-By` separado por una línea en blanco.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BASE = 'base: cálculo del precio con IVA';
// la guía prohíbe el asunto que es SÓLO una de estas palabras, no el que arranca con ella
const GENERICOS = /^(fix|update|sync|wip|changes|merge|trigger rebuild|arreglo|cambios)[.!]?$/i;
const TITULO = /^(feat|fix|refactor|docs|test|chore|perf|style)(\([^)]+\))?: \S.{8,}$/;

// el git del dev (ganchos, firmas, plantillas) no decide el resultado: config global vacía
const ENV_GIT = Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: ENV_GIT });
  if (r.status !== 0) throw new Error(`git ${args[0]} falló: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

function preparar(dir) {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'dev@example.com');
  git(dir, 'config', 'user.name', 'Dev de prueba');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'precio.js'), 'module.exports = (neto) => Math.floor(neto * 1.21 * 100) / 100;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', BASE);
  fs.writeFileSync(path.join(dir, 'precio.js'), 'module.exports = (neto) => Math.round(neto * 1.21 * 100) / 100;\n');
}

function evaluarMensaje(mensaje) {
  const lineas = String(mensaje).replace(/\s+$/, '').split('\n');
  const titulo = lineas[0].trim();
  const iTrailer = lineas.findIndex((l) => /^Co-Authored-By:/i.test(l));
  const cuerpo = lineas.slice(1, iTrailer >= 0 ? iTrailer : undefined).filter((l) => l.trim());
  return {
    titulo: TITULO.test(titulo) && !GENERICOS.test(titulo.replace(/^\w+(\([^)]+\))?:\s*/, '')),
    cuerpo: lineas.length > 1 && lineas[1].trim() === '' && cuerpo.length > 0,
    trailer: iTrailer > 0 && lineas[iTrailer - 1].trim() === '',
  };
}

// si git no anda, `git()` lanza: el corredor lo cuenta como «no pude medir», no como un 0
function corregir({ dir }) {
  if (git(dir, 'log', '-1', '--format=%s').trim() === BASE) return { score: 0, motivo: 'no commiteó el cambio' };
  // un commit vacío o de otro archivo no es commitear el cambio pedido
  if (git(dir, 'status', '--porcelain', '--', 'precio.js').trim()) return { score: 0, motivo: 'el cambio de precio.js sigue sin commitear' };
  const r = evaluarMensaje(git(dir, 'log', '-1', '--format=%B'));
  const faltan = Object.entries(r).filter(([, ok]) => !ok).map(([k]) => k);
  return { score: Math.round(((3 - faltan.length) / 3) * 1000) / 1000, motivo: faltan.length ? `falta: ${faltan.join(', ')}` : 'las tres reglas' };
}

module.exports = { preparar, corregir, evaluarMensaje };
