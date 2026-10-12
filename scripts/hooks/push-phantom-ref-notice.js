#!/usr/bin/env node
'use strict';
/**
 * push-phantom-ref-notice.js — antes de un `git push`, avisar si lo que se sube NOMBRA un archivo
 * que no existe.
 *
 * ── EL INCIDENTE QUE LO MOTIVA (2026-08-31) ─────────────────────────────────────────────────────
 * Una sesión commiteó y pusheó directo a `main` un cambio a `install-tycon-hooks.sh` que invocaba
 * `scripts/controls-bench/periodic-exam.js`. Ese archivo existía SÓLO en la rama de otra sesión,
 * sin mergear. Durante ~27 minutos, cualquier dev que hiciera `git pull` tenía en `main` un
 * instalador llamando a un archivo ausente.
 *
 * No falló ruidosamente: los dos bloques que lo invocan chequean `[ -f ]` antes, así que el
 * instalador degradó en silencio — que es peor. Y se cerró por casualidad, con el merge normal de
 * la otra story; si esa story hubiera tardado un día más, `main` habría quedado así.
 *
 * ── QUÉ MIRA, Y POR QUÉ ASÍ ─────────────────────────────────────────────────────────────────────
 * De las líneas AGREGADAS por los commits que se están por subir, saca los fragmentos que parecen
 * una ruta a un archivo de código del propio repo (`controls-bench/periodic-exam.js`) y verifica
 * que exista algo con ese final. Si no existe, lo dice.
 *
 * 🔴 **AVISA, NUNCA BLOQUEA.** Un push a main es trabajo real y esto es una heurística sobre texto:
 * un falso positivo que corta el trabajo se termina apagando, y se lleva puestos los casos donde sí
 * importaba. El sesgo es el mismo que eligió el hook de engram cuando dejó de bloquear.
 *
 * Y por eso mismo el filtro es CONSERVADOR — se calla ante la duda:
 *   · sólo mira lo que se agrega en archivos de código (`.js`, `.sh`, `.mjs`, `.cjs`, `.py`);
 *     en documentación se nombran rutas de ejemplo todo el tiempo;
 *   · el fragmento tiene que tener al menos una barra: un nombre suelto no es una referencia;
 *   · basta con que exista CUALQUIER archivo del repo cuyo camino termine en ese fragmento, así
 *     que una ruta armada con variables (`$DIR/../controls-bench/periodic-exam.js`) se resuelve
 *     igual — que es exactamente la forma que tenía el caso real.
 *
 * Off: TYCON_PUSH_GHOST=0
 * Autotest: node scripts/hooks/push-phantom-ref-notice.js --selftest
 */
const { execFileSync } = require('child_process');
const constancia = require('../lib/guard-record.js');

// El mismo reconocimiento de `git <sub>` que endureció `engram-pre-commit.sh` el 2026-08-25: por
// POSICIÓN y no por substring, aceptando `git -C /ruta push`, `command git push`, `/usr/bin/git
// push`. Un `grep "git push"` o un heredoc que escribe esa frase NO son un push.
const GIT = '(^|[;&|(]|&&|\\|\\|)\\s*(command\\s+)?([^\\s]*/)?git\\s+([^\\s]+\\s+){0,4}';
const EXT_CODIGO = /\.(js|mjs|cjs|sh|py)$/;

function esPush(cmd) {
  return new RegExp(`${GIT}push(\\s|$)`).test(String(cmd || ''));
}

/**
 * Fragmentos con pinta de ruta a un archivo del repo, sacados de las líneas agregadas.
 * Se le quitan los prefijos que no ayudan a resolver (variables de shell, `./`, `../`).
 */
function referencias(diff) {
  const out = new Set();
  for (const linea of String(diff || '').split('\n')) {
    if (!linea.startsWith('+') || linea.startsWith('+++')) continue;
    for (const bruto of linea.match(/[\w$(){}./-]+\.(?:js|mjs|cjs|sh|py|json)\b/g) || []) {
      // Se corta en el último tramo que NO tenga variables: `$DIR/../a/b.js` → `a/b.js`
      const partes = bruto.split('/').filter(Boolean);
      const limpio = [];
      for (const p of partes) {
        if (p === '.' || p === '..' || p.includes('$')) { limpio.length = 0; continue; }
        limpio.push(p);
      }
      const frag = limpio.join('/');
      if (frag.includes('/') && EXT_CODIGO.test(frag)) out.add(frag);
    }
  }
  return [...out];
}

/** ¿Hay en el repo algún archivo cuyo camino termine en ese fragmento? */
function existe(frag, archivos) {
  return archivos.some((a) => a === frag || a.endsWith(`/${frag}`));
}

function fantasmas(diff, archivosDelRepo, archivosTocados) {
  const tocados = new Set(archivosTocados || []);
  return referencias(diff).filter((f) => {
    if (existe(f, archivosDelRepo)) return false;
    // Un archivo que ESTE mismo push agrega cuenta como existente aunque el listado del árbol
    // venga de antes: lo que se persigue es la referencia a algo que vive en OTRA rama.
    if ([...tocados].some((a) => a === f || a.endsWith(`/${f}`))) return false;
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

function selftest() {
  const repo = ['scripts/controls-bench/runner.js', 'scripts/hooks/bench-notice.js'];
  const casos = [
    ['reconoce un push simple', esPush('git push origin main')],
    ['reconoce `git -C /ruta push`', esPush('git -C /x/y push origin main')],
    ['reconoce `command git push` y la ruta absoluta', esPush('command git push') && esPush('/usr/bin/git push')],
    ['reconoce un push después de un separador', esPush('cd /x && git push')],
    ['NO confunde un grep que MENCIONA git push', !esPush('grep -n "git push" archivo.sh')],
    ['NO confunde `git pushear-algo`', !esPush('git pushear-algo')],

    ['caza la referencia a un archivo que no existe (el caso real)',
      fantasmas('+  EXAMEN="$DIR/../controls-bench/periodic-exam.js"', repo, []).length === 1],
    ['no dice nada de una referencia que SÍ existe',
      fantasmas('+  node scripts/controls-bench/runner.js', repo, []).length === 0],
    ['resuelve la ruta armada con variables (la forma del caso real)',
      fantasmas('+  bash "$TCG_HOOKS_DIR/../hooks/bench-notice.js"', repo, []).length === 0],
    ['un archivo que ESTE push agrega no es un fantasma',
      fantasmas('+  require("./scripts/nuevo/pieza.js")', repo, ['scripts/nuevo/pieza.js']).length === 0],
    ['ignora las líneas BORRADAS', fantasmas('-  require("scripts/no/existe.js")', repo, []).length === 0],
    ['un nombre suelto sin barra no es una referencia',
      fantasmas('+  el archivo se llama fantasma.js', repo, []).length === 0],
    ['🔴 se calla ante la duda: la documentación nombra rutas de ejemplo todo el tiempo',
      referencias('+ ver docs/ejemplo/inventado.md').length === 0],
    ['caza la referencia escrita en un YAML de pipeline, no sólo en un .sh',
      fantasmas('+      - script: bash scripts/ci/no-existe.sh', repo, []).length === 1],
    ['la referencia que se busca sigue siendo de CÓDIGO (un .json referenciado no se persigue)',
      fantasmas('+  const cfg = require("config/ausente.json");', repo, []).length === 0],
  ];
  let bad = 0;
  for (const [n, ok] of casos) { console.log(`${ok ? '✅' : '❌'} push-fantasma: ${n}`); if (!ok) bad++; }
  console.log(bad ? `❌ ${bad} rojos` : `✅ push-fantasma: ${casos.length}/${casos.length} verdes`);
  return bad ? 1 : 0;
}

if (process.argv.includes('--selftest')) process.exit(selftest());

// ─────────────────────────────────────────────────────────────────────────────────────────────

if (require('../lib/legacy-names.js').readEnv('TYCON_PUSH_GHOST', { where: 'scripts/hooks/push-phantom-ref-notice.js' }) === '0'
  || process.env.TYCON_EVAL_SANDBOX === '1') process.exit(0);

let entrada = '';
try { entrada = require('fs').readFileSync(0, 'utf8'); } catch (_) { process.exit(0); }
let ev = {};
try { ev = JSON.parse(entrada); } catch (_) { process.exit(0); }
const cmd = (ev.tool_input && ev.tool_input.command) || '';
if (!esPush(cmd)) process.exit(0);

try {
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const rama = git('rev-parse', '--abbrev-ref', 'HEAD');
  // Lo que se va a subir: contra el remoto de esta rama, y si no tiene, contra el de main.
  let rango;
  try { rango = `${git('rev-parse', '--abbrev-ref', `${rama}@{u}`)}..HEAD`; }
  catch (_) { rango = 'origin/main..HEAD'; }
  // Se MIRAN también los archivos que no son código pero sí lo referencian: un YAML de pipeline o
  // un `.tycon/*.yaml` puede invocar un guion igual que un `.sh` (hallazgo del revisor de fallos
  // silenciosos: si el incidente real se hubiera escrito en un YAML, este control no lo veía).
  // Los lock se excluyen: son miles de rutas de dependencias, puro ruido.
  const diff = git('diff', rango, '--unified=0', '--',
    '*.js', '*.mjs', '*.cjs', '*.sh', '*.py', '*.json', '*.yml', '*.yaml',
    ':(exclude)*package-lock.json', ':(exclude)*yarn.lock', ':(exclude)*pnpm-lock.yaml');
  if (!diff) process.exit(0);
  const archivos = git('ls-files').split('\n').filter(Boolean);
  const tocados = git('diff', '--name-only', rango).split('\n').filter(Boolean);
  const malos = fantasmas(diff, archivos, tocados);
  // Este freno NUNCA bloquea: sus veredictos son `aviso` y `paso`. Medirlo es lo que decide si
  // algún día tiene que pasar a frenar — «avisó N veces y nadie hizo nada» (story 2.6).
  constancia.anotar({
    freno: 'push-referencia-fantasma', regla: 'referencia-fantasma',
    veredicto: malos.length ? 'aviso' : 'paso', cmd,
  });
  if (malos.length) {
    console.log('⚠️  Lo que estás por pushear NOMBRA archivos que no existen en este repo:');
    for (const m of malos.slice(0, 5)) console.log(`   · ${m}`);
    console.log('   Suele significar que el cambio da por hecho algo que vive en OTRA rama sin mergear.');
    console.log('   Caso real (2026-08-31): main quedó 27 min con el instalador llamando a un archivo ausente,');
    console.log('   y no falló ruidosamente — degradó en silencio. Off: TYCON_PUSH_GHOST=0');
  }
} catch (e) {
  // 🔴 Fail-open SÍ, mudo NO (hallazgo del revisor de fallos silenciosos, 2026-08-31). Un aviso
  // jamás puede romper un push, pero "no pude mirar" y "miré y está limpio" NO pueden verse igual:
  // si mañana cambia el formato del evento, o el repo no tiene `origin/main`, este control queda
  // callado para siempre sin que nadie se entere — que es EXACTAMENTE el patrón que vino a cerrar.
  console.log(`⚠️  no pude verificar si este push nombra archivos ausentes (${e && e.message}) — asumilo NO verificado`);
}
process.exit(0);
