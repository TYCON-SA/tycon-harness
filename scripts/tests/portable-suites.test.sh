#!/usr/bin/env bash
# portable-suites.test.sh — las suites que dicen no necesitar nada (`requiere: []` en suites.json) dan verde
# en una HOME VACÍA y con un PATH sin ninguna herramienta del vocabulario (story 8.3, AC 13 · T13
# Suites_PortablesVerdesEnHomeVacia).
#
# Qué mide: la CLASIFICACIÓN de `suites.json`, no el arnés. Una suite marcada portable que en este entorno
# necesita `az`, `engram`, `codegraph`, `codex`, `claude`, el perfil del equipo o algo del HOME de quien la
# corre es un rojo de la story: se corrige su `requiere` (y se entiende por qué), nunca esta prueba.
#
# El entorno:
#   · HOME temporal vacía — sin settings.json, sin tycon.json — con los dos enlaces de instalación y nada más:
#     ~/.claude/agent-skills al real (es el lugar fijo de instalación, no un servicio) y ~/.claude/agents →
#     agent-skills/agents (el que cada dev crea a mano, INSTALL.md §3; por él se descubren los revisores);
#     TYCON_PROFILE=0 (sin el perfil del equipo, que desde el clon interno se encuentra por la ubicación del
#     script); TYCON_MAILBOX_JSON a un archivo inexistente (la llave del buzón viene con el clon interno, afuera no está).
#   · PATH armado con ENLACES a todo lo que hay en el PATH real MENOS az, engram, codegraph, codex y claude.
#     Enlaces y no copias: un binario copiado pierde sus dylibs. Se verifica que ninguna de las cinco quede.
#   · TYCON_GUIDES_DIR / TYCON_SKILLS_DIR apuntan a los clones: es layout, no un servicio (AC 12). TYCON_CHROME=0: la
#     máquina vacía no tiene navegador (Chrome sin sesión se cuelga en una HOME sin perfil; el caso que lo usa sale NO MEDIDO).
#   · Cada suite corre en su proceso, desde la raíz del arnés (como en el portón y el nocturno), con SU PROPIA
#     HOME vacía y su TMPDIR (cuatro a la vez sobre una misma HOME se pisan: settings.json, sellos, registros),
#     con un tope de tiempo, de a TYCON_PORTABLE_PARALLEL (4) a la vez. Un tope agotado es rojo, no «no medido».
#
# Dice cuántas corrió: CERO portables es un rojo, no un verde (una lista sin `requiere` daría 0 y silencio).
# Las entradas de agent-skills se declaran NO MEDIDAS si el árbol no está; nunca se cuentan como verdes.
# Se excluye a sí misma (correrse adentro de sí misma sería infinito).
# Costo: una segunda pasada de las portables (~100 suites, 5-6 min con 4 en paralelo). Por eso NO está en suites.json
# (decisión del dev, 2026-09-26: para el equipo no puede haber más espera en el portón ni en el nocturno): se corre a
# mano, y en el gate del commit de toda story que toque suites.json o el instalador. suites-coverage.test.js la lista
# como excepción declarada, con este motivo.
# Correr: bash scripts/tests/portable-suites.test.sh  (para probar la lista entera, no sólo las portables: TYCON_PORTABLE_ALL=1)
#
# UNA PARTE de las portables (TYCON_PORTABLE_SHARD=<i>/<n>, 2026-10-14): la CI pública de GitHub reparte este paso en
# <n> trabajos que corren a la vez (scripts/ci/public-ci.sh, TYCON_PUBLIC_CI_PART=suites-<i>-of-<n>). El reparto es el
# de la validación de Azure: scripts/ci/suites-shard.js, por peso, con el juego `pr` de scripts/ci/suites-weights.json;
# las <n> partes juntas son todas las portables y ninguna queda en dos. Dentro de la parte arrancan primero las más
# pesadas (con 4 a la vez, una larga que arranca última estira la parte entera). Un valor que no sea <i>/<n> con i
# entre 1 y n, o un reparto que no se puede hacer (falta suites-shard.js, los pesos no se dejan leer), es ROJO: correr
# todas, o ninguna, en silencio daría otro veredicto que el pedido. Una parte sin ninguna suite es rojo (cero no es verde).
#
# SÓLO ALGUNAS (TYCON_PORTABLE_ONLY=<ruta>,<ruta>…, 2026-10-16): corre sólo esas portables, con la misma HOME vacía. Lo
# usa la parte installer-floor de la CI pública (el Node más viejo que acepta el instalador). Una ruta que no es una
# portable declarada es rojo.

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUITES="$RAIZ/scripts/tests/suites.json"
T="$(mktemp -d)"
# 🔴 La HOME vacía NO va bajo /tmp ni /var/folders: va bajo .advisors/ del clon (git la ignora: `**/.advisors/*`).
#    Motivo medido: deploy-codex-copies.test.sh distingue «un Codex temporal» de «el de la máquina» por la ruta
#    (build/deploy-codex-hooks.js trata /tmp y /var/folders como temporales), y con la HOME ahí su caso C-04 daba
#    rojo por el entorno de esta prueba, no por la suite.
#    Si el propio clon vive bajo una carpeta temporal (una sesión que trabaja desde un clon descartable en /tmp),
#    TYCON_PORTABLE_HOME=<carpeta> la pone en otro lado; se crea y se borra entera al terminar.
CASA="${TYCON_PORTABLE_HOME:-$RAIZ/.advisors/portables-home-$$}"
trap 'rm -rf "$T" "$CASA"' EXIT

# Dónde están las skills lo dice LA función que usan todos los lectores de suites.json (story 8.18, AC 13): la
# variable › este clon si es unido › lo instalado. Pedida por su modo de línea de comandos, que sale 1 con el motivo
# si la carpeta no existe: ese motivo es el que acompaña a cada «NO MEDIDA» (antes el error se tiraba y la línea
# decía sólo «no está en esta máquina»).
SK_REPO=""; SK_SOURCE=""; SK_WHY=""
if SK_REPO="$(node "$RAIZ/scripts/lib/skills-dir.js" --repo 2>"$T/skills-dir.err")"; then
  SK_SOURCE="$(node "$RAIZ/scripts/lib/skills-dir.js" --source 2>>"$T/skills-dir.err")" || SK_SOURCE="sin dato"
else
  SK_REPO=""; SK_WHY="$(tr '\n' ' ' < "$T/skills-dir.err")"
fi
HAY_SKILLS=0; [ -n "$SK_REPO" ] && [ -d "$SK_REPO/skills/tycon-pipeline" ] && HAY_SKILLS=1
if [ "$HAY_SKILLS" = 1 ]; then
  echo "suites-portables: raíz agent-skills: $SK_REPO/skills (salió de: $SK_SOURCE)"
elif [ -z "$SK_WHY" ]; then
  SK_WHY="$SK_REPO/skills no trae tycon-pipeline (salió de: $SK_SOURCE)"
fi

# ── la HOME vacía: sólo los dos enlaces de instalación (agent-skills, y ~/.claude/agents → agent-skills/agents, el
#    que cada dev crea a mano en INSTALL.md §3 y por el que Claude Code y el arnés descubren los revisores) ────────────
#    Cada suite recibe SU PROPIA HOME vacía (una carpeta bajo $CASA con los dos enlaces): cuatro suites a la vez sobre
#    una misma HOME se pisan (settings.json, sellos, registros) y aparecen rojos que no son de la suite.
rm -rf "$CASA"; mkdir -p "$CASA" "$T/tmp"

# ── el PATH sin las herramientas del vocabulario ──────────────────────────────────────────────────
BIN="$T/bin"; mkdir -p "$BIN"
IFS=':' read -r -a DIRS <<< "$PATH"
for d in "${DIRS[@]}"; do
  [ -d "$d" ] || continue
  for f in "$d"/*; do
    b="${f##*/}"
    case "$b" in az|engram|codegraph|codex|claude) continue ;; esac
    [ -e "$BIN/$b" ] || ln -s "$f" "$BIN/$b" 2>/dev/null || true
  done
done
for b in az engram codegraph codex claude; do
  if PATH="$BIN" command -v "$b" >/dev/null 2>&1; then echo "❌ suites-portables: $b sigue en el PATH armado — la medición no vale"; exit 1; fi
done
PATH="$BIN" command -v node >/dev/null 2>&1 || { echo "❌ suites-portables: no quedó node en el PATH armado"; exit 1; }

# ── las skills de terceros, ANTES de lanzar nada en paralelo ──────────────────────────────────────
#    Algunas suites (harness-install, install-third-party) las ponen en skills/ del árbol mientras otras corren. Una
#    suite que compara dos instalaciones (installer-shared-pieces S11) las ve aparecer entre la primera y la segunda, y
#    da rojo según con quién le toque correr (story 8.40, DEF-8.40-carrera-skills-de-terceros). Con el árbol ya completo,
#    nadie cambia skills/ a mitad de camino. Con una HOME temporal, el estado del paso no cae en la de quien corre.
mkdir -p "$T/third-party-home"
HOME="$T/third-party-home" node "$RAIZ/scripts/publishing/install-third-party.js" --repo "$RAIZ" 2>&1 | sed 's/^/suites-portables: /'

# ── ninguna suite escribe en el árbol: skills/ ni el .bench/ del banco ──────────────────────────────────────────
#    La foto se toma DESPUÉS de las de terceros y se compara al final: una suite que deja (o borra) algo ahí le cambia
#    el árbol a las que corren a la vez. Pasó con integrations-off y no-hardcoded-paths, que corrían el instalador con
#    el paso de terceros prendido sobre el agent-skills de su HOME, que es este clon (DEF-8.40-carrera-skills-de-terceros);
#    y con harness-uninstall, harness-snapshot, installer-shared-pieces, install-third-party, no-hardcoded-paths,
#    integrations-off y engram-autoheal, que dejaban el reporte de paridad en .bench/, y bench-git-deterministic, el
#    registro del corredor del banco. Con las de terceros ya puestas, las dos primeras no habrían dejado nada nuevo: la
#    foto caza lo que cualquier otra deje.
skills_foto() { local d; for d in "$RAIZ/skills" ${SK_REPO:+"$SK_REPO/skills"} "$RAIZ/scripts/controls-bench/.bench"; do [ -d "$d" ] && (cd "$d" && find . \( -type f -o -type l \) | sed "s|^\.|$d|"); done | LC_ALL=C sort -u; }
skills_foto > "$T/skills-antes.txt"

# ── correr las portables, de a 4, con tope ────────────────────────────────────────────────────────
node - "$RAIZ" "${SK_REPO:-}" "$HAY_SKILLS" "$CASA" "$BIN" "$T" "$SUITES" "${SK_WHY:-}" <<'JS'
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const [RAIZ, SK, HAY_SKILLS, CASA, BIN, T, SUITES, SK_WHY] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(SUITES, 'utf8'));
const todas = [...(cfg.diarias || []), ...(cfg.semanales || [])].filter((e) => e && e.ruta);
const esYo = (e) => /portable-suites\.test\.sh$/.test(e.ruta);
// TYCON_PORTABLE_ALL=1: diagnóstico para CLASIFICAR — corre la lista entera en este entorno; lo que falla necesita algo.
const TODAS = process.env.TYCON_PORTABLE_ALL === '1';
let portables = todas.filter((e) => (TODAS || (Array.isArray(e.requiere) && e.requiere.length === 0)) && !esYo(e));
const sinRequiere = todas.filter((e) => !Array.isArray(e.requiere)).length;
console.log(`suites-portables: ${todas.length} suites declaradas · ${portables.length} ${TODAS ? 'a correr (TYCON_PORTABLE_ALL=1: diagnóstico, no el veredicto de la clasificación)' : 'portables (requiere: [])'}` +
  (sinRequiere ? ` · ⚠️ ${sinRequiere} sin \`requiere\` (las juzga suites-coverage.test.js)` : ''));
if (!portables.length) { console.log('❌ suites-portables: CERO portables — o nadie declaró `requiere: []` o la lista está rota. Cero no es verde.'); process.exit(1); }
// una parte de las portables (TYCON_PORTABLE_SHARD=<i>/<n>, ver la cabecera): el reparto de scripts/ci/suites-shard.js
const SHARD = process.env.TYCON_PORTABLE_SHARD || '';
if (SHARD) {
  const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(SHARD);
  if (!m || Number(m[1]) > Number(m[2])) { console.log(`❌ suites-portables: TYCON_PORTABLE_SHARD=${SHARD} no es una parte: <i>/<n>, con i entre 1 y n`); process.exit(1); }
  const [i, n] = [Number(m[1]), Number(m[2])];
  let shard; let weights;
  try {
    shard = require(path.join(RAIZ, 'scripts', 'ci', 'suites-shard.js'));
    weights = shard.readWeights(path.join(RAIZ, 'scripts', 'ci', 'suites-weights.json'), 'github');
  } catch (e) {
    console.log(`❌ suites-portables: no pude repartir las portables para la parte ${i} de ${n}: ${String((e && e.message) || e).split('\n')[0]}`); process.exit(1);
  }
  const weightOf = (e) => { const b = path.posix.basename(e.ruta); return Object.prototype.hasOwnProperty.call(weights.weights, b) ? weights.weights[b] : weights.fallback; };
  // assign() devuelve, por parte, los mismos objetos que recibe: cada uno lleva su entrada de suites.json
  const parts = shard.assign(portables.map((e) => ({ name: path.posix.basename(e.ruta), entry: e })), weights, n);
  const mine = parts[i - 1].suites.map((s) => s.entry);
  console.log(`suites-portables: parte ${i} de ${n} (repartidas por peso con scripts/ci/suites-shard.js, juego github): ${mine.length} de ${portables.length} portables · ~${Math.round(parts[i - 1].load)} s de peso`);
  if (!mine.length) { console.log(`❌ suites-portables: a la parte ${i} de ${n} no le tocó ninguna portable: cero no es verde (¿más partes que portables?)`); process.exit(1); }
  // primero las más pesadas (a igual peso, en el orden de suites.json)
  portables = mine.map((e, at) => ({ e, at, w: weightOf(e) })).sort((a, b) => (b.w - a.w) || (a.at - b.at)).map((x) => x.e);
}
// sólo algunas portables, por su ruta (TYCON_PORTABLE_ONLY=<ruta>,<ruta>…; 2026-10-16): el trabajo del piso del
// instalador de la CI pública corre así las suites de lo que corre con el Node del sistema. Una ruta que no es una
// portable declarada es rojo, nunca un salto: un nombre mal escrito dejaría la parte corriendo de menos y en verde.
const ONLY = (process.env.TYCON_PORTABLE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
if (ONLY.length) {
  const faltan = ONLY.filter((r) => !portables.some((e) => e.ruta === r));
  if (faltan.length) { console.log(`❌ suites-portables: TYCON_PORTABLE_ONLY nombra lo que no es una portable declarada: ${faltan.join(', ')}`); process.exit(1); }
  portables = portables.filter((e) => ONLY.includes(e.ruta));
  console.log(`suites-portables: sólo ${portables.length} (TYCON_PORTABLE_ONLY): ${ONLY.join(', ')}`);
}

/** La HOME vacía de UNA suite: sólo los dos enlaces de instalación. Una por suite, así no se pisan entre sí. */
let nCasa = 0;
function casaVacia() {
  const h = path.join(CASA, `h${++nCasa}`);
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  if (HAY_SKILLS === '1') { fs.symlinkSync(SK, path.join(h, '.claude', 'agent-skills')); fs.symlinkSync(path.join(SK, 'agents'), path.join(h, '.claude', 'agents')); }
  const tmp = path.join(T, 'tmp', `t${nCasa}`); fs.mkdirSync(tmp, { recursive: true });
  return { home: h, env: {
    HOME: h, USERPROFILE: h, PATH: BIN, TMPDIR: tmp, LANG: process.env.LANG || 'en_US.UTF-8',
    TYCON_PROFILE: '0', TYCON_GUIDES_DIR: RAIZ, TYCON_SKILLS_DIR: SK ? path.join(SK, 'skills') : '', TYCON_MAILBOX_JSON: path.join(h, 'no-hay-llave.json'),
    // la máquina vacía tampoco tiene navegador: Chrome sin sesión se queda colgado para siempre en una HOME sin perfil
    // (medido con dashboard-runs.test.sh); el caso que lo necesita sale NO MEDIDO, no se cuelga
    TYCON_CHROME: '0',
  } };
}
const POOL = Math.max(1, Number(process.env.TYCON_PORTABLE_PARALLEL || 4));
const TOPE_MS = Math.max(10000, Number(process.env.TYCON_PORTABLE_CAP_MS || 900000));
const raizDe = (e) => (e.raiz === 'arnes' ? path.join(RAIZ, 'scripts') : path.join(SK || '', 'skills'));

const cola = portables.slice();
const rojas = [];
const noMedidas = [];
let verdes = 0, vivos = 0;
const inicio = Date.now();
function seg(ms) { return `${Math.round(ms / 1000)}s`; }
function siguiente() {
  while (vivos < POOL && cola.length) {
    const e = cola.shift();
    if (e.raiz === 'agent-skills' && HAY_SKILLS !== '1') { noMedidas.push(e.ruta); console.log(`⏭ ${path.basename(e.ruta)} — agent-skills no está en esta máquina: NO MEDIDA (${(SK_WHY || 'sin motivo').trim()})`); continue; }
    const abs = path.join(raizDe(e), e.ruta);
    if (!fs.existsSync(abs)) { rojas.push(`${e.ruta} (no existe en disco)`); console.log(`❌ ${path.basename(e.ruta)} — no existe en disco`); continue; }
    vivos++;
    const ej = /\.js$/.test(e.ruta) ? 'node' : 'bash';
    const t0 = Date.now();
    let salida = '';
    let agotado = false;
    const casa = casaVacia();
    // `detached`: la suite es el líder de su propio grupo de procesos. Al agotarse el tope se mata EL GRUPO (-pid): matar
    // sólo al bash de la suite deja vivos a sus hijos, que retienen la salida y el `close` no llega nunca (medido: una
    // suite colgada en la máquina vacía dejó la corrida entera esperando, con el tope «vencido» y sin veredicto).
    const p = spawn(ej, [abs], { cwd: RAIZ, env: casa.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const matar = () => { try { process.kill(-p.pid, 'SIGKILL'); } catch (_) { try { p.kill('SIGKILL'); } catch (__) { /* ya murió */ } } };
    const timer = setTimeout(() => { agotado = true; matar(); }, TOPE_MS);
    p.stdout.on('data', (d) => { salida += d; });
    p.stderr.on('data', (d) => { salida += d; });
    p.on('close', (code) => {
      clearTimeout(timer);
      vivos--;
      try { fs.rmSync(casa.home, { recursive: true, force: true }); } catch (_) { /* se borra entera al final igual */ }
      const b = path.basename(e.ruta);
      if (code === 0 && !agotado) { verdes++; console.log(`✅ ${b} (${seg(Date.now() - t0)})`); }
      else {
        const motivo = agotado ? `se agotó el tope de ${seg(TOPE_MS)}` : `exit ${code}`;
        rojas.push(`${e.ruta} (${motivo})`);
        const cola8 = salida.trim().split('\n').slice(-8).map((l) => `     ${l}`).join('\n');
        console.log(`❌ ${b} — ${motivo} (${seg(Date.now() - t0)})\n${cola8}`);
        // En la CI pública, la salida ENTERA de la suite roja queda como un .log más en la carpeta que el último paso del
        // workflow imprime cuando algo sale rojo: con las últimas ocho líneas, el caso que falló quedaba afuera (las dos
        // suites del instalador que fallan de a ratos, 2026-10-13, no se pudieron diagnosticar por eso).
        if (process.env.TYCON_PUBLIC_CI_OUT) {
          try { fs.writeFileSync(path.join(process.env.TYCON_PUBLIC_CI_OUT, `portable-${b}.log`), salida); } catch (err) { console.log(`     (no pude guardar su salida completa: ${err.code || err.message})`); }
        }
      }
      siguiente();
      if (!vivos && !cola.length) fin();
    });
  }
}
function fin() {
  const corridas = verdes + rojas.length;
  console.log(`\nsuites-portables: ${corridas} corridas · ${verdes} verdes · ${rojas.length} rojas · ${noMedidas.length} no medidas · ${seg(Date.now() - inicio)}`);
  if (rojas.length) {
    console.log('❌ portables que en una HOME vacía y sin herramientas NO dieron verde — se corrige su `requiere` en suites.json (o la suite, si depende del HOME de quien la corre), nunca esta prueba:');
    for (const r of rojas) console.log(`   · ${r}`);
    process.exit(1);
  }
  if (!corridas) { console.log('❌ suites-portables: no se corrió ninguna (todas NO MEDIDAS): cero no es verde'); process.exit(1); }
  console.log(`✅ suites-portables: las ${corridas} portables dan verde en una HOME vacía sin az/engram/codegraph/codex/claude`);
  process.exit(0);
}
siguiente();
JS
RC=$?
skills_foto > "$T/skills-despues.txt"
if ! cmp -s "$T/skills-antes.txt" "$T/skills-despues.txt"; then
  echo "❌ suites-portables: una suite cambió skills/ o scripts/controls-bench/.bench/ del árbol (lo que corre a la vez lo ve cambiar a mitad de camino). Tiene que trabajar en su propia carpeta, o correr el instalador con TYCON_THIRD_PARTY=0 y TYCON_PARITY_BENCH_DIR=<su carpeta>. Para saber cuál: TYCON_PORTABLE_ONLY=<ruta>, de a una."
  diff "$T/skills-antes.txt" "$T/skills-despues.txt" | grep '^[<>]' | sed -e 's/^</   · se borró:/' -e 's/^>/   · apareció:/' | head -10
  exit 1
fi
exit "$RC"
