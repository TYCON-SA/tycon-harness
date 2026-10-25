#!/usr/bin/env node
/**
 * pre-push-repo-rules.js — las cuatro reglas que vigilan todo el repo del arnés corren antes de empujar.
 *
 * 🔴 POR QUÉ EXISTE. En la CI pública, 3 de cada 10 empujes salían rojos y cerca del 40 % de esas suites eran cuatro
 * reglas que miran el repo entero: que cada script corrido con `node` arranque por el piso de Node, que toda prueba
 * esté registrada, que `suites.json` y el disco digan lo mismo, y que el SKILL.md del pipeline conserve su contrato.
 * Tardan unos segundos, pero la sesión no las corre: la puerta de pruebas sólo elige las suites que nombran o leen un
 * archivo tocado, y éstas no nombran ninguno. El rojo se veía recién en la CI.
 *
 * QUÉ HACE. Lo llama `git-pre-push-global.sh` después del freno de publicación, parado en el repo, con los argumentos y
 * la entrada que git le da al gancho. Si el empuje es del arnés (la misma respuesta del freno, `concernsHarness`, a
 * cualquier remoto), corre las cuatro sobre cada commit que viaja: en el árbol si está limpio y su HEAD es ese commit;
 * si no, en una copia temporal (`git worktree add --detach`) que se borra al terminar. Una suite que no viaja en ese
 * commit se saltea y lo dice. Tope total de 60 s.
 *
 * Salida: 0 deja salir · 1 frena (una regla en rojo, el tope, o no se pudo medir: lo que no se midió no es verde).
 * No hay variable para saltearlo; `TYCON_PRE_PUSH_RULES_CAP_MS` sólo baja el tope, para las pruebas.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const guard = require('./public-push-guard.js');

const TAG = '[reglas-del-repo]';
// La lista vive acá, sin configuración: es una regla del arnés, no de cada organización. Sumar otra pide su medición.
const SUITES = [
  'scripts/tests/node-floor.test.js',
  'scripts/tests/suites-listed.test.js',
  'scripts/tests/suites-coverage.test.js',
  'skills/tycon-pipeline/scripts/tests/test-skill-contract.js',
];
const CAP_MS = Number(process.env.TYCON_PRE_PUSH_RULES_CAP_MS) > 0 ? Number(process.env.TYCON_PRE_PUSH_RULES_CAP_MS) : 60000;
const ZERO = /^0+$/;
const TAIL = 15;

const decir = (texto) => console.error(`${TAG} ${texto}`);
function frenar(texto) {
  console.error(`⛔ EMPUJE FRENADO — ${texto}`);
  return 1;
}
function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Una copia temporal de ese commit, siempre: el árbol de trabajo nunca dice con certeza lo mismo que el commit (lo
 * ignorado, lo marcado assume-unchanged o skip-worktree y un checkout parcial no salen en `git status`, y las reglas
 * recorren el disco).
 */
function lugarPara(repo, sha) {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-reglas-'));
  } catch (e) {
    throw new Error(`no pude armar la copia temporal del commit ${sha.slice(0, 8)}: ${e.message}`);
  }
  const borrar = () => {
    git(repo, ['worktree', 'remove', '--force', dir]);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ya no está */ }
    git(repo, ['worktree', 'prune']);
  };
  const r = git(repo, ['worktree', 'add', '--detach', '--quiet', dir, sha]);
  if (r.status !== 0) {
    borrar();
    throw new Error(`no pude armar la copia temporal del commit ${sha.slice(0, 8)}: ${(r.stderr || '').trim().split('\n').pop()}`);
  }
  decir(`corro las reglas en una copia temporal del commit que viaja (${sha.slice(0, 8)}).`);
  return { dir, borrar };
}

/** Corre las reglas en `dir` hasta `deadline`. Devuelve null si todas pasaron, o el motivo para frenar. */
function correrReglas(dir, deadline) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;   // corrido desde una prueba, el hijo escribiría en el formato interno de node --test
  // las que git le pone al gancho apuntan al repo que se empuja: en la copia temporal, un `git` de la suite leería ése.
  // Las del arnés (TYCON_SKILLS_DIR y compañía) llevan a una suite a medir otra carpeta y no el commit que viaja.
  for (const k of Object.keys(env)) if (/^(GIT_|TYCON_)/.test(k)) delete env[k];
  let corridas = 0;
  for (const suite of SUITES) {
    if (!fs.existsSync(path.join(dir, suite))) { decir(`${suite}: no viaja en este commit, la salteo.`); continue; }
    const queda = deadline - Date.now();
    if (queda <= 0) return `pasó el tope de ${CAP_MS / 1000} s antes de correr ${suite}.`;
    const r = spawnSync(process.execPath, [suite], { cwd: dir, env, encoding: 'utf8', timeout: queda, killSignal: 'SIGKILL' });
    if (r.error && r.error.code === 'ETIMEDOUT') return `pasó el tope de ${CAP_MS / 1000} s con ${suite} corriendo.`;
    if (r.error) return `no pude correr ${suite}: ${r.error.message}`;
    if (r.signal || cortado) return `el empuje se cortó con ${suite} corriendo.`;
    if (r.status !== 0) {
      const lineas = `${r.stdout || ''}${r.stderr || ''}`.trimEnd().split('\n').slice(-TAIL).map((l) => `   ${l}`).join('\n');
      return `la regla ${suite} salió en rojo (código ${r.status}). Sus últimas líneas:\n${lineas}\n` +
        `   Para correrla sola, en la raíz del repo: node ${suite}`;
    }
    corridas += 1;
  }
  decir(`${corridas} de ${corridas} en verde.`);
  return null;
}

/** Los commits distintos que viajan, uno por árbol: una marca y su rama, o dos ramas en el mismo árbol, se miden una vez. */
function commitsPorArbol(repo, lines) {
  const porArbol = new Map();
  for (const l of lines) {
    if (ZERO.test(l.localSha)) continue;   // borra una ref remota: no viaja nada
    const c = git(repo, ['rev-parse', '--verify', '--quiet', `${l.localSha}^{commit}`]);
    const t = git(repo, ['rev-parse', '--verify', '--quiet', `${l.localSha}^{tree}`]);
    if (c.status !== 0 || t.status !== 0) { decir(`${l.localRef || l.localSha}: no es un commit, no tiene reglas que correr.`); continue; }
    if (!porArbol.has(t.stdout.trim())) porArbol.set(t.stdout.trim(), c.stdout.trim());
  }
  return [...porArbol.values()];
}

let cortado = false;

function main(argv) {
  const [, url, flag] = argv;   // <remoto> <url> [--input-unreadable]
  const cwd = process.cwd();
  const top = guard.toplevel(cwd);
  const repo = top || cwd;
  if (flag === '--input-unreadable') {
    // sin la entrada no se sabe qué viaja: si el árbol o el remoto dicen que es del arnés, eso no es verde
    let delArnes;
    try { delArnes = guard.isHarnessTree(top) || guard.concernsHarness({ repo, top, lines: [], url, env: process.env }); } catch (_) { delArnes = true; }
    return delArnes ? frenar('no pude leer qué se empuja, así que no pude correr las reglas del repo.') : 0;
  }
  let lines;
  try {
    lines = guard.parseLines(fs.readFileSync(0, 'utf8'));
    if (!guard.concernsHarness({ repo, top, lines, url, env: process.env })) return 0;
  } catch (e) {
    return frenar(`no pude decidir si el empuje es del arnés, así que no corrí las reglas del repo: ${e.message}`);
  }
  // un corte (Ctrl-C) mata a la suite que corre; el proceso sigue hasta borrar la copia y después frena
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { cortado = true; });
  git(repo, ['worktree', 'prune']);   // registros de copias de un corte anterior cuya carpeta ya no está
  const shas = commitsPorArbol(repo, lines);
  const deadline = Date.now() + CAP_MS;
  for (const sha of shas) {
    // un commit que no trae ninguna de las cuatro no tiene reglas que correr: sale callado, sin armar la copia
    if (!SUITES.some((s) => git(repo, ['cat-file', '-e', `${sha}:${s}`]).status === 0)) continue;
    let lugar;
    try { lugar = lugarPara(repo, sha); } catch (e) { return frenar(e.message); }
    try {
      const motivo = correrReglas(lugar.dir, deadline);
      if (motivo) return frenar(motivo);
    } finally {
      lugar.borrar();
    }
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { SUITES, main };
