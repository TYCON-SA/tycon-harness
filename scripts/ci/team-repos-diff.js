#!/usr/bin/env node
'use strict';
// team-repos-diff.js — el perfil de la organización para la noche, y si su team-repos.json es el de operaciones.
//
// Uso:  node scripts/ci/team-repos-diff.js --team-repos <team-repos.json de operaciones> --clone-dir <carpeta>
//                                          --profile-out <carpeta>
//
// POR QUÉ EXISTE. La noche lee team-repos.json del repo de operaciones; las máquinas del equipo, el del perfil. Una
// organización con perfil tiene el archivo en los dos lados, y nada los mantiene iguales: si difieren, la noche mide
// otros repos que los que la organización cree. Este guion baja el perfil del repo que declara
// `team-repos.json → profile` (con la credencial de CLONE_TOKEN, como el barrido de retrospectivas) y compara.
// De paso deja el perfil (team-profile.json) en --profile-out: el resumen y el aviso sacan de ahí los canales. Si el
// perfil trae un team-repos.json legible, lo deja también, tal cual: las métricas sacan de ahí la unidad de las
// estimaciones.
//
// Lo que deja en --profile-out es de esta corrida: antes de bajar el perfil saca lo que hubiera de una corrida anterior,
// y el team-repos.json del perfil queda sólo si pasa el lector (scripts/lib/team-repos.js), el mismo que lo usa después.
//
// QUÉ DICE: una línea. Las claves de primer nivel que difieren, NUNCA sus valores (nombran repos y proyectos). El orden
// de las claves no cuenta.
//
// Salida: 0 iguales · 1 difieren, o el perfil no trae un team-repos.json legible · 3 no pude leer el perfil (el aviso
// sale por el canal por defecto) · 4 no pude dejar el perfil en --profile-out (lo que haya ahí no vale) · 2 uso. Quien lo llama decide el color; ninguna salida es una noche roja.
// Casos: scripts/tests/operations-pipelines.test.js (TeamRepos_DistintoDelPerfil_Avisa).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const TR = require('../lib/team-repos.js');
const RS = require('../metrics/retro-sweep.js');

const NO_PROFILE = 'no pude leer el perfil: los canales del aviso no son los de la organización';
const PROFILE_NAMES = ['team-profile.json', 'perfil-equipo.json'];

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!['--team-repos', '--clone-dir', '--profile-out'].includes(k)) return null;
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) return null;
    o[k.slice(2).replace(/-(.)/g, (_, c) => c.toUpperCase())] = argv[i + 1];
  }
  return o.teamRepos && o.cloneDir && o.profileOut ? o : null;
}

/** El contenido de un archivo en main del perfil, o null si no está; una falla de git que no es «no está» se lanza. */
function show(dir, ref, file) {
  const g = spawnSync('git', ['-C', dir, 'show', `${ref}:${file}`], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (g.status === 0) return g.stdout;
  if (/does not exist|exists on disk, but not in/i.test(String(g.stderr || ''))) return null;
  throw new Error(RS.clean(String(g.stderr || '').trim().split('\n')[0] || `git salió ${g.status}`));
}

/** El JSON con las claves ordenadas en todos los niveles: dos archivos iguales salvo el orden dan el mismo texto. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** Las claves de primer nivel que difieren, ordenadas; una clave que un lado no tiene cuenta como distinta. */
function differingKeys(mine, theirs) {
  const own = (obj, k) => (Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined);
  const keys = [...new Set([...Object.keys(mine), ...Object.keys(theirs)])].sort();
  return keys.filter((k) => canonical(own(mine, k)) !== canonical(own(theirs, k)));
}

/** Escribe en --profile-out; si falla, la falla se marca para que main la diga como lo que es (salida 4). */
function writeOut(fn) {
  try { return fn(); } catch (e) { e.profileOut = true; throw e; }
}

function run(o, say) {
  writeOut(() => { for (const f of ['team-profile.json', 'team-repos.json']) fs.rmSync(path.join(o.profileOut, f), { force: true }); });
  const ops = TR.load(o.teamRepos);
  if (!ops.ok) { say(`${NO_PROFILE} (team-repos.json de operaciones no se pudo leer)`); return 3; }
  if (!ops.data.profile) { say(`${NO_PROFILE} (team-repos.json de operaciones no declara el repo del perfil)`); return 3; }
  const got = RS.obtain({ nombre: ops.data.profile.repo, fuente: TR.url(ops.data.profile) }, o.cloneDir);
  if (!got.dir) { say(`${NO_PROFILE} (${RS.clean(got.motivo)})`); return 3; }
  let profile = null;
  let theirs;
  try {
    for (const name of PROFILE_NAMES) { profile = show(got.dir, got.ref, name); if (profile !== null) break; }
    theirs = show(got.dir, got.ref, 'team-repos.json');
  } catch (e) {
    say(`${NO_PROFILE} (git no pudo leerlo: ${e.message})`);
    return 3;
  }
  if (profile === null) { say(`${NO_PROFILE} (el repo del perfil no tiene team-profile.json en main)`); return 3; }
  writeOut(() => {
    fs.mkdirSync(o.profileOut, { recursive: true });
    fs.writeFileSync(path.join(o.profileOut, 'team-profile.json'), profile);
  });
  let parsed;
  try { parsed = theirs === null ? null : JSON.parse(theirs); } catch (_) { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    say('team-repos.json: el perfil no trae uno legible en main, no se pudo comparar con el de operaciones');
    return 1;
  }
  const checked = TR.parse(theirs);
  if (!checked.ok) {
    const where = [...new Set((checked.problems || []).map((p) => p.path || '(raíz)'))].join(', ');
    say(`team-repos.json: el del perfil no vale para el lector (en: ${where}), no se pudo comparar con el de operaciones`);
    return 1;
  }
  writeOut(() => fs.writeFileSync(path.join(o.profileOut, 'team-repos.json'), theirs));
  const differ = differingKeys(ops.data, parsed);
  if (differ.length) { say(`team-repos.json de operaciones y el del perfil difieren en: ${differ.join(', ')}`); return 1; }
  say('team-repos.json: el de operaciones es igual al del perfil');
  return 0;
}

function main(argv, { log = (m) => console.log(m) } = {}) {
  const o = parse(argv);
  if (!o) {
    console.error('uso: team-repos-diff.js --team-repos <archivo> --clone-dir <carpeta> --profile-out <carpeta>');
    return 2;
  }
  try {
    return run(o, log);
  } catch (e) {
    const code = (e && (e.code || e.name)) || 'error';
    if (e && e.profileOut) { log(`no pude dejar el perfil en ${o.profileOut}: ${code}`); return 4; }
    log(`${NO_PROFILE} (${code})`);
    return 3;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, canonical, differingKeys };
