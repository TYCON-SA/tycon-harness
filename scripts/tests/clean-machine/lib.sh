# shellcheck shell=bash
# lib.sh — lo que comparten clean-machine.test.sh (en el anfitrión) y los escenarios (dentro del contenedor).
#
# El formato de las líneas es contrato (story 8.7, AC 26): lo lee quien mira la noche y `public-ci.sh`.
#   ✅ clean-machine: T26 <texto>
#   ❌ clean-machine: T26 <texto>
#   ⏭ clean-machine: NO MEDIDO — <motivo>
# Adentro del contenedor no hay jq, curl, wget ni compiladores: sólo bash, git, python3 y node (y dotnet en la imagen
# del paquete). Nada de acá usa otra cosa; y lo que corre en la imagen sin node (missing-tool.sh) no llama a node.
#
# 🔴 bash 3.2 (el de macOS): una variable pegada a un carácter no ASCII va SIEMPRE con llaves.

CM_TOTAL=0; CM_FAILS=0; CM_SKIPPED=0
ok()   { CM_TOTAL=$((CM_TOTAL + 1)); echo "✅ clean-machine: $1"; }
no()   { CM_TOTAL=$((CM_TOTAL + 1)); CM_FAILS=$((CM_FAILS + 1)); echo "❌ clean-machine: $1"; }
skip() { CM_SKIPPED=$((CM_SKIPPED + 1)); echo "⏭ clean-machine: NO MEDIDO — $1"; }

# ── el bloque de requisitos de la portada ────────────────────────────────────────────────────────────────────
# Cada línea cumple `<herramienta>( >= <mayor>)?( (<paquete>))?`. Otra forma es un rojo: una línea que la prueba no
# sabe leer es un requisito que nadie comprueba.
#   git                la herramienta responde a `command -v`
#   node >= 22         además, su versión mayor es 22 o más
#   dotnet (bizuit)    se exige sólo en la imagen de ese paquete; en la del núcleo pasa a la lista vigilada
CM_REQ_RE='^([a-z][a-z0-9._+-]*)( >= ([0-9]+))?( \(([a-z][a-z0-9-]*)\))?$'
CM_NUM_RE='([0-9]+)'
# req_parse <línea> → REQ_TOOL, REQ_MIN (vacío si no pide versión), REQ_PACK (vacío si es del núcleo); 1 si la forma es otra
req_parse() {
  REQ_TOOL=""; REQ_MIN=""; REQ_PACK=""
  [[ "$1" =~ ${CM_REQ_RE} ]] || return 1
  REQ_TOOL="${BASH_REMATCH[1]}"; REQ_MIN="${BASH_REMATCH[3]:-}"; REQ_PACK="${BASH_REMATCH[5]:-}"
}
# req_check_file <archivo> <paquetes conocidos, separados por espacio> → 0 si todas las líneas se leen y nombran un
# paquete conocido; si no, 1 y una línea por cada una que no (en stdout, para el mensaje)
req_check_file() {
  local line bad=0 n=0 p known
  while IFS= read -r line || [ -n "${line}" ]; do
    n=$((n + 1))
    if ! req_parse "${line}"; then echo "línea ${n} con otra forma: «${line}»"; bad=1; continue; fi
    if [ -n "${REQ_PACK}" ]; then
      known=0; for p in $2; do [ "${p}" = "${REQ_PACK}" ] && known=1; done
      [ "${known}" -eq 1 ] || { echo "línea ${n} nombra un paquete que la prueba no conoce: «${REQ_PACK}»"; bad=1; }
    fi
  done < "$1"
  [ "${n}" -gt 0 ] || { echo "el bloque de requisitos está vacío"; bad=1; }
  return "${bad}"
}
# major_of <herramienta> → el primer número de `<herramienta> --version` (v22.3.0 → 22; «git version 2.39» → 2)
major_of() {
  local out; out="$("$1" --version 2>&1 | head -n 1)" || true
  [[ "${out}" =~ ${CM_NUM_RE} ]] && echo "${BASH_REMATCH[1]}"
}

# ── la versión estampada de una copia (T34 de la story 8.13) ─────────────────────────────────────────────────
# El número que la publicación deja en `version.json`: AAAA.MM.DD.N (mes 01-12, día 01-31, N desde 1 sin ceros adelante).
CM_VERSION_RE='^[0-9]{4}\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])\.[1-9][0-9]*$'
# stamped_version_of <árbol> → el número de su version.json. 1 si el árbol no trae el archivo (una copia de antes de la
# primera sincronización numerada); 2 si no se puede leer o su número tiene otra forma. Usa `json` (más abajo) y git.
# Si el árbol es un clon y HEAD tiene la etiqueta liviana v<número> que pone el merge, ése es el número (el archivo, con
# `numbering: "merge-tag"`, dice el piso): lo mismo que muestra `harness.js version`.
stamped_version_of() {
  local v t
  [ -f "$1/version.json" ] || return 1
  v="$(json "$1/version.json" 'd.version')" || return 2
  [[ "${v}" =~ ${CM_VERSION_RE} ]] || return 2
  t="$(git -C "$1" for-each-ref --points-at HEAD --format='%(objecttype) %(refname:strip=2)' 'refs/tags/v*' 2>/dev/null \
    | sed -n 's/^commit v//p' | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1)"
  [ -n "${t}" ] && [[ "${t}" =~ ${CM_VERSION_RE} ]] && v="${t}"
  echo "${v}"
}
# next_version <AAAA.MM.DD.N> → el número siguiente del mismo día (N + 1)
next_version() { echo "${1%.*}.$(( ${1##*.} + 1 ))"; }

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
# De acá para abajo: sólo para los escenarios (dentro del contenedor)
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
LAB_DIR=/opt/lab                       # lo que la capa de la copia dejó: blocks/, scenarios/, example-repo/, lib.sh
COPY_DIR=/srv/tycon-harness            # la copia: lo que el desvío sirve en lugar del repo público
WORK_DIR=/work                         # donde se clona, como la carpeta que elige quien instala
OUT_DIR=/tmp/clean-machine-out         # la salida de cada comando del escenario
FAKES_DIR=/tmp/fakes/bin               # herramientas de mentira que anotan cada llamada (export-real.test.sh:115)
CALLS_LOG=/tmp/fakes/calls.log
WATCHED="jq az engram codegraph codex claude docker"   # lo que la portada NO pide: no puede estar ni ser llamado
PIPE_DIR="${HOME}/.claude/agent-skills/skills/tycon-pipeline/scripts"
HARNESS_LINK="${HOME}/.claude/tycon-harness"            # el lugar del arnés (story 8.19: el PLACE_NAME de scripts/setup/harness/place.js)
HARNESS_JS="${HARNESS_LINK}/scripts/setup/harness.js"
STATE_FILE="${HOME}/.claude/.tycon-pipeline/harness-state.json"
STAMPED_FILE="${LAB_DIR}/blocks/stamped-version.txt"   # el número que `harness.js version` tiene que dar (lo deja el anfitrión)
PUBLIC_URL=""; CLONE=""

scenario_begin() { # <nombre>
  mkdir -p "${OUT_DIR}"
  PUBLIC_URL="$(cat "${LAB_DIR}/blocks/public-url.txt")"
  echo "clean-machine: escenario $1 · $(id -un) · HOME=${HOME} · copia ${COPY_DIR} en lugar de ${PUBLIC_URL}"
}
# La última línea de todo escenario: sin ella el anfitrión lo toma por un escenario que no terminó (rojo).
scenario_end() { echo "clean-machine: fin del escenario $1"; }

# json <archivo> <expresión sobre d> → el valor (texto tal cual; lo demás, como JSON). Vacío y exit 1 si no se puede leer.
json() {
  node -e '
    let d; try { d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch (e) { process.exit(1); }
    let v; try { v = (new Function("d", "return (" + process.argv[2] + ");"))(d); } catch (e) { process.exit(1); }
    console.log(typeof v === "string" ? v : JSON.stringify(v));' "$1" "$2"
}

# requirements_check <T> <paquete de esta imagen, o vacío> [<herramienta que esta imagen NO tiene a propósito>]
# T24 por dentro, con el PATH limpio (ANTES de fakes_setup): cada requisito que le toca a esta imagen responde, con su
# versión; y nada de la lista vigilada —más lo que es de otro paquete— está.
requirements_check() {
  local t="$1" pack="$2" absent="${3:-}" line major missing="" have="" watched="${WATCHED}" w found=""
  while IFS= read -r line || [ -n "${line}" ]; do
    req_parse "${line}" || { missing="${missing} «${line}»(forma)"; continue; }
    if [ -n "${REQ_PACK}" ] && [ "${REQ_PACK}" != "${pack}" ]; then watched="${watched} ${REQ_TOOL}"; continue; fi
    [ "${REQ_TOOL}" = "${absent}" ] && continue
    if ! command -v "${REQ_TOOL}" >/dev/null 2>&1; then missing="${missing} ${REQ_TOOL}"; continue; fi
    if [ -n "${REQ_MIN}" ]; then
      major="$(major_of "${REQ_TOOL}")"
      if [ -z "${major}" ] || [ "${major}" -lt "${REQ_MIN}" ]; then missing="${missing} ${REQ_TOOL}(versión ${major:-?}, pide ${REQ_MIN})"; continue; fi
    fi
    have="${have} ${REQ_TOOL}"
  done < "${LAB_DIR}/blocks/requirements.txt"
  if [ -z "${missing}" ] && [ -n "${have}" ]; then ok "${t} cada requisito de la portada responde en esta imagen:${have}"
  else no "${t} requisitos de la portada que no responden en esta imagen:${missing:- (ninguno leído)}"; fi
  for w in ${watched}; do command -v "${w}" >/dev/null 2>&1 && found="${found} ${w}"; done
  if [ -z "${found}" ]; then ok "${t} ninguna herramienta vigilada está en esta imagen (${watched})"
  else no "${t} herramientas que la portada no pide y están en la imagen:${found}"; fi
  # AC 17: un usuario sin privilegios. Lo pone el `USER node` del Dockerfile; acá se mide adentro, para que sacarlo
  # por accidente sea un rojo y no un cambio que nadie ve.
  if [ "$(id -u)" != 0 ]; then ok "${t} el contenedor corre con un usuario sin privilegios ($(id -un), uid $(id -u))"
  else no "${t} el contenedor corre como root: quien instala desde la portada no lo es"; fi
}

# fakes_setup <herramienta…> — las de mentira, primeras en el PATH; cada llamada queda en CALLS_LOG
# 🔴 Las de mentira ANOTAN llamadas; no dicen qué herramientas tiene la máquina. Desde la story 8.23 (tanda C) `install`
# enchufa Codex si encuentra un `codex` en el PATH (scripts/setup/harness/tools.js, detect()), y el `codex` de mentira de
# acá contaba como Codex instalado: la paridad medía un Codex falso (tres rojos, y bench-notice hablaba al arranque) y
# doctor corría los hooks de Codex, que traen engram-pre-commit.sh, que encontraba el `jq` de mentira y lo llamaba
# (nocturno 12518, 2026-10-09). La detección mira el PATH de la imagen, el de ANTES de las de mentira, con la variable
# de prueba que usa el laboratorio (TYCON_TOOLS_DETECT_PATH, scripts/tests/lib/harness-lab.sh): así ve lo que tiene la
# imagen de verdad, que es lo que mide T24. check_install mira además qué quedó enchufado.
fakes_setup() {
  local b
  mkdir -p "${FAKES_DIR}"; : > "${CALLS_LOG}"
  for b in "$@"; do
    printf '#!/bin/sh\necho "%s $*" >> "%s"\nexit 0\n' "${b}" "${CALLS_LOG}" > "${FAKES_DIR}/${b}"; chmod +x "${FAKES_DIR}/${b}"
  done
  TYCON_TOOLS_DETECT_PATH="${PATH}"; export TYCON_TOOLS_DETECT_PATH
  PATH="${FAKES_DIR}:${PATH}"; export PATH
}
fakes_check() { # <T>
  if [ -s "${CALLS_LOG}" ]; then no "$1 alguien llamó a una herramienta que la portada no pide: $(sort -u "${CALLS_LOG}" | head -n 4 | tr '\n' ' ')"
  else ok "$1 el registro de las herramientas de mentira quedó vacío"; fi
}

# El desvío: la URL COMPLETA del repo público (la del bloque install:core) se sirve desde la copia. Así no desvía
# otros repos de la organización (el plugin de ejemplo sale de GitHub de verdad).
serve_copy()   { git config --global "url.${COPY_DIR}.insteadOf" "${PUBLIC_URL}"; }
unserve_copy() { git config --global --unset "url.${COPY_DIR}.insteadOf"; }

# run_block <core|bizuit> <salida> [<carpeta>] — el bloque bash de la portada, tal cual, desde la carpeta (por defecto /work)
run_block() { ( cd "${3:-${WORK_DIR}}" && bash "${LAB_DIR}/blocks/install-$1.sh" ) > "$2" 2>&1; }
# pty_run <respuesta> <comando…> — el comando dentro de una TERMINAL de juguete (stdin, stdout y stderr son una tty),
# con la respuesta escrita como si la tipeara una persona; sale con el código del comando (story 8.16, tanda B: desde
# ahí `install` muestra el plan y pregunta, y sin terminal no escribe nada). python3 + pty: igual en cualquier Linux.
pty_run() {
  local answer="$1"; shift
  python3 - "${answer}" "$@" <<'PY'
import os, pty, select, sys, time
answer, cmd = sys.argv[1], sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    try:
        os.execvp(cmd[0], cmd)
    finally:
        os._exit(127)
os.write(fd, (answer + "\n").encode("utf-8"))
out, status, deadline = b"", None, time.time() + 900
while time.time() < deadline:
    try:
        ready, _, _ = select.select([fd], [], [], 0.2)
    except (OSError, ValueError):
        break
    if ready:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
        continue
    done, st = os.waitpid(pid, os.WNOHANG)
    if done:
        status = st
        break
if status is None:
    if time.time() >= deadline:
        os.kill(pid, 9)
    try:
        _, status = os.waitpid(pid, 0)
    except ChildProcessError:
        status = 0
sys.stdout.write(out.decode("utf-8", "replace").replace("\r\n", "\n"))
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
PY
}
# Las respuestas de una primera instalación en la terminal (story 8.16, tanda D): perfil full, ninguna integración,
# paquete del stack no, y sí a la conformidad — una por línea; la terminal las entrega de a una.
ANSWERS_FULL=$'2\n\n\ns'
# run_block_pty <nombre> <salida> <respuesta> [carpeta] — el bloque de la portada, tal cual, en la terminal de juguete
run_block_pty() { ( cd "${4:-${WORK_DIR}}" && pty_run "$3" bash "${LAB_DIR}/blocks/install-$1.sh" ) > "$2" 2>&1; }
# find_clone → CLONE: la carpeta que el bloque clonó (la única de /work con el programa de instalación)
find_clone() {
  local f
  CLONE=""
  for f in "${WORK_DIR}"/*/scripts/setup/harness.js; do
    [ -f "${f}" ] && { CLONE="$(cd "$(dirname "${f}")/../.." && pwd -P)"; return 0; }
  done
  return 1
}
# real <ruta> → la ruta real, de una carpeta o de un archivo (`readlink -f` de coreutils: está en la imagen)
real() { readlink -f "$1"; }

# make_example_repo <carpeta> — el repo de ejemplo: la fixture, la story en specs/, rama story/1.1 y un commit
make_example_repo() {
  mkdir -p "$1/specs" \
    && cp -R "${LAB_DIR}/example-repo/package.json" "${LAB_DIR}/example-repo/src" "${LAB_DIR}/example-repo/test" "$1/" \
    && cp "${LAB_DIR}/example-repo/story-1.1.md.tpl" "$1/specs/story-1.1-greeting.md" \
    && git -C "$1" init -q && git -C "$1" checkout -q -b story/1.1 && git -C "$1" add -A \
    && git -C "$1" -c user.name=lab -c user.email=lab@example.com commit -q -m 'el repo de ejemplo'
}

# ── T26: lo que deja `install:core` (común a las dos variantes; los enlaces los mira cada escenario) ───────────
check_install() { # <T> [minimal|full] — el perfil que tiene que haber quedado (story 8.16, tanda D; por defecto full)
  local t="$1" profile="${2:-full}" v n cmd rc noisy f first url_cfg url_get want
  # el estado de la 8.13: managed, stable, ask, UNA fuente; y su url es lo que da `git remote get-url` (decisión C2)
  url_cfg="$(git -C "${CLONE}" config --get remote.origin.url)"; url_get="$(git -C "${CLONE}" remote get-url origin)"
  v="$(json "${STATE_FILE}" '[d.mode, d.channel, d.policy && d.policy.apply, (d.sources || []).length, d.sources && d.sources[0] && d.sources[0].url].join("|")')"
  if [ "${v}" = "managed|stable|ask|1|${url_get}" ] && [ "${url_cfg}" = "${PUBLIC_URL}" ]; then
    ok "${t} el estado: managed, canal stable, política ask y una fuente; el origen del clon es la URL del bloque"
  else no "${t} el estado dice «${v:-ilegible}» (esperado «managed|stable|ask|1|${url_get}») y el origen del clon es ${url_cfg} (esperado ${PUBLIC_URL})"; fi
  # qué quedó enchufado (story 8.23, tanda C): sólo Claude Code — la imagen no trae Codex, y el `codex` de mentira sólo
  # anota llamadas (fakes_setup). Si vuelve a enchufarse Codex acá, la causa se ve en esta línea y no en sus síntomas.
  v="$(json "${STATE_FILE}" 'Array.isArray(d.tools) ? d.tools.join(",") : "sin-tools"')"
  if [ "${v}" = claude ]; then ok "${t} el estado enchufa sólo Claude Code: el codex de mentira no cuenta como Codex instalado"
  else no "${t} el estado enchufa «${v:-ilegible}» (esperado «claude»): la detección vio una herramienta que la imagen no tiene"; fi
  # la línea de arranque nueva y la copia fija
  n="$(json "${HOME}/.claude/settings.json" '((d.hooks && d.hooks.SessionStart) || []).reduce((a, m) => a + (m.hooks || []).filter((h) => /\.tycon-pipeline\/harness\/bootstrap\.js/.test(h.command || "")).length, 0)')"
  if [ "${n:-0}" = 1 ] && [ -f "${HOME}/.claude/.tycon-pipeline/harness/bootstrap.js" ]; then ok "${t} la línea de arranque nueva está una vez en settings.json y la copia fija en ~/.claude/.tycon-pipeline/harness/"
  else no "${t} la línea de arranque nueva aparece ${n:-?} vez/veces en settings.json, o falta la copia fija (bootstrap.js)"; fi
  # version: la estampada, exacta (T34 de la story 8.13). El número esperado lo deja el anfitrión en blocks/: el de
  # laboratorio con que armó la copia (modo interno) o el del version.json del árbol (modo público). Si el árbol público
  # no trae version.json no hay contra qué comparar: se mira que responda, y lo exacto sale NO MEDIDO — nunca verde.
  want="$(cat "${STAMPED_FILE}" 2>/dev/null || true)"
  v="$(node "${HARNESS_JS}" version 2>&1)"; rc=$?
  if [ -z "${want}" ]; then
    if [ "${rc}" -eq 0 ] && [ -n "${v}" ]; then ok "${t} harness.js version responde: ${v}"; else no "${t} harness.js version salió ${rc}: ${v}"; fi
    skip "${t} harness.js version da la estampada: esta copia no trae version.json (es de antes de la primera sincronización numerada), no hay número contra el que comparar"
  else
    node "${HARNESS_JS}" version --json > "${OUT_DIR}/version.json" 2> "${OUT_DIR}/version.err"
    n="$(json "${OUT_DIR}/version.json" '[d.version && d.version.number, d.version && d.version.stamped].join("|")')"
    if [ "${rc}" -eq 0 ] && [ "${n}" = "${want}|true" ]; then ok "${t} harness.js version da la estampada, exacta (${want}): ${v}"
    else no "${t} harness.js version no da la estampada: --json dice «${n:-ilegible}» (esperado «${want}|true») y la línea, con salida ${rc}, es: ${v} $(head -c 200 "${OUT_DIR}/version.err" | tr '\n' ' ')"; fi
  fi
  # doctor
  node "${HARNESS_JS}" doctor --json > "${OUT_DIR}/doctor.json" 2> "${OUT_DIR}/doctor.err"
  v="$(json "${OUT_DIR}/doctor.json" 'Array.isArray(d.fail) ? d.fail.length + "|" + d.fail.slice(0, 3).join(" · ") : "sin-lista"')"
  if [ "${v}" = "0|" ]; then ok "${t} harness.js doctor --json no trae ningún fail"; else no "${t} harness.js doctor --json: ${v:-no es JSON} $(head -c 200 "${OUT_DIR}/doctor.err")"; fi
  # CLAUDE.md: el @import una vez, y cada bloque del arnés salvo los que piden una integración apagada (AC 25)
  n="$(grep -c -x -F '@~/.claude/tycon-harness/INDEX.md' "${HOME}/.claude/CLAUDE.md" 2>/dev/null || true)"
  if [ "${n:-0}" = 1 ]; then ok "${t} ~/.claude/CLAUDE.md tiene la línea del @import una vez"; else no "${t} la línea del @import aparece ${n:-0} veces en ~/.claude/CLAUDE.md"; fi
  v=""; n=0
  for f in "${CLONE}"/claude-md-blocks/*.md; do
    [ -f "${f}" ] || continue
    cmd="$(basename "${f}" .md)"; IFS= read -r first < "${f}" || true
    case "${first}" in
      '<!--'*requires-integration:*) grep -q "TYCON_BLOCK:${cmd} " "${HOME}/.claude/CLAUDE.md" 2>/dev/null && v="${v} sobra:${cmd}" ;;
      # los bloques de full (story 8.16, tanda C): en minimal no van
      '<!--'*requires-profile:*full*) if [ "${profile}" = minimal ]; then grep -q "TYCON_BLOCK:${cmd} " "${HOME}/.claude/CLAUDE.md" 2>/dev/null && v="${v} sobra:${cmd}"
        else n=$((n + 1)); grep -q "TYCON_BLOCK:${cmd} START" "${HOME}/.claude/CLAUDE.md" 2>/dev/null || v="${v} falta:${cmd}"; fi ;;
      *) n=$((n + 1)); grep -q "TYCON_BLOCK:${cmd} START" "${HOME}/.claude/CLAUDE.md" 2>/dev/null || v="${v} falta:${cmd}" ;;
    esac
  done
  if [ -z "${v}" ] && { [ "${n}" -gt 0 ] || [ "${profile}" = minimal ]; }; then ok "${t} ~/.claude/CLAUDE.md tiene los ${n} bloques del arnés de ${profile} y ninguno de una integración apagada"
  else no "${t} los bloques de ~/.claude/CLAUDE.md:${v:- no encontré ningún bloque en el clon}"; fi
  # el perfil que quedó (story 8.16, tanda D · AC 36): lo dice doctor
  v="$(json "${OUT_DIR}/doctor.json" 'd.profile ? d.profile.value : "sin-perfil"')"
  if [ "${v}" = "${profile}" ]; then ok "${t} harness.js doctor --json dice el perfil ${profile}"; else no "${t} harness.js doctor --json dice el perfil «${v:-ilegible}» (esperado ${profile})"; fi
  # --check: sale 0 y no trae ninguna línea de faltantes. Las dos cosas: con faltantes igual sale 0 (por eso se miran
  # las líneas), y si se cae a mitad de camino no llega a imprimirlas (por eso se mira la salida).
  bash "${CLONE}/scripts/install-tycon-hooks.sh" --check > "${OUT_DIR}/check.out" 2>&1; rc=$?
  if [ "${rc}" -ne 0 ]; then no "${t} install-tycon-hooks.sh --check salió ${rc} (se cayó antes de terminar la revisión): $(tail -n 2 "${OUT_DIR}/check.out" | tr '\n' ' ')"
  elif grep -q -e '🔴 TYCON hooks —' -e 'hooks faltan' "${OUT_DIR}/check.out"; then no "${t} install-tycon-hooks.sh --check dice que faltan cosas: $(grep -e '🔴 TYCON hooks —' -e 'hooks faltan' "${OUT_DIR}/check.out" | head -n 2 | tr '\n' ' ')"
  else ok "${t} install-tycon-hooks.sh --check sale 0 y no trae ninguna línea de faltantes"; fi
  # cada hook de arranque, una vez, con el payload de su evento y desde un repo vacío: no imprime nada
  mkdir -p /tmp/empty-repo && git -C /tmp/empty-repo init -q
  node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const m of (s.hooks && s.hooks.SessionStart) || []) for (const h of m.hooks || []) if (h.command) console.log(h.command);' \
    "${HOME}/.claude/settings.json" > "${OUT_DIR}/startup-hooks.txt" 2>/dev/null
  n="$(grep -c . "${OUT_DIR}/startup-hooks.txt" || true)"; noisy=0
  if [ "${n:-0}" -gt 0 ]; then
    while IFS= read -r cmd; do
      ( cd /tmp/empty-repo && printf '{"source":"startup"}' | bash -c "${cmd}" ) > "${OUT_DIR}/hook.out" 2>&1; rc=$?
      if [ "${rc}" -ne 0 ] || [ -s "${OUT_DIR}/hook.out" ]; then
        noisy=$((noisy + 1)); no "${t} un hook de arranque habló o falló (exit ${rc}): ${cmd:0:140} → $(head -c 300 "${OUT_DIR}/hook.out" | tr '\n' ' ')"
      fi
    done < "${OUT_DIR}/startup-hooks.txt"
    [ "${noisy}" -eq 0 ] && ok "${t} los ${n} hooks de arranque corren una vez y no imprimen nada"
  else no "${t} no hay ningún hook de arranque en ~/.claude/settings.json"; fi
  # la configuración: las ocho integraciones apagadas
  node "${HARNESS_LINK}/scripts/lib/tycon-config.js" explain > "${OUT_DIR}/explain.out" 2>&1; rc=$?
  n="$(grep -c -E '^[[:space:]]+(ado|clockify|engram|codegraph|mailbox|codex|nightly|telegram)[[:space:]]+apagada' "${OUT_DIR}/explain.out" || true)"
  if [ "${rc}" -eq 0 ] && [ "${n:-0}" = 8 ]; then ok "${t} tycon-config.js explain: las ocho integraciones apagadas"
  else no "${t} tycon-config.js explain salió ${rc} con ${n:-0} de 8 integraciones apagadas: $(grep -E 'prendida|detect' "${OUT_DIR}/explain.out" | head -n 3 | tr '\n' ' ')"; fi
  audit_clean "${t}"
}

# audit_clean <T> — harness-audit.js --json sin faltantes: los chequeos de «Advisor Coverage» que nombran revisores,
# paquete o guías, todos en verde (la definición de la T19 de export-real.test.sh)
audit_clean() {
  ( cd "${HARNESS_LINK}" && node scripts/lib/harness-audit.js --json ) > "${OUT_DIR}/audit.json" 2> "${OUT_DIR}/audit.err"
  node - "${OUT_DIR}/audit.json" "$1" <<'JS'
const fs = require('fs');
const [file, t] = process.argv.slice(2);
const said = (good, text) => console.log(`${good ? '✅' : '❌'} clean-machine: ${t} ${text}`);
let d; try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { said(false, `harness-audit.js --json no es JSON (${e.message})`); process.exit(0); }
const cats = d.categories || d.categorias || [];
const cov = (Array.isArray(cats) ? cats : Object.values(cats)).find((c) => c && c.name === 'Advisor Coverage');
const broken = cov ? cov.checks.filter((c) => /^Core advisor|del paquete|Paquete de revisores ilegible|guía/i.test(c.name) && !c.passed) : null;
said(!!cov && !broken.length, `harness-audit.js --json sin faltantes${broken && broken.length ? `: ${broken.map((c) => c.name).join(' · ')}` : (cov ? '' : ': no trae la categoría «Advisor Coverage»')}`);
JS
}

# third_party <clon> → «<total> <faltan, separados por coma, o -> <cargas sin su skill, o ->»: las skills de terceros
# del manifiesto DE LA COPIA (`install: download`) contra el disco, y las que cada una carga al arrancar según su propio
# SKILL.md («Load config via <skill> skill»). Es el control de presencia de los AC 20 y 23 (decisión C4).
third_party() {
  node -e '
    const fs = require("fs"); const path = require("path");
    const clone = process.argv[1];
    let m; try { m = JSON.parse(fs.readFileSync(path.join(clone, "scripts", "publishing", "third-party-skills.json"), "utf8")); } catch (e) { console.log("0 manifiesto-ilegible -"); process.exit(0); }
    const dl = (m.third_party || []).filter((e) => e && e.install === "download");
    const missing = []; const loads = [];
    for (const e of dl) {
      const f = path.join(clone, e.target, "SKILL.md");
      if (!fs.existsSync(f)) { missing.push(path.basename(e.target)); continue; }
      for (const x of fs.readFileSync(f, "utf8").matchAll(/[Ll]oad [^\n]{0,40}?via ([a-z0-9][a-z0-9-]*) skill/g)) {
        if (!fs.existsSync(path.join(clone, "skills", x[1], "SKILL.md"))) loads.push(`${path.basename(e.target)}→${x[1]}`);
      }
    }
    console.log(`${dl.length} ${missing.join(",") || "-"} ${loads.join(",") || "-"}`);' "$1"
}

# third_party_in_history <clon> → «<total> <en la historia>»: de las skills de terceros del manifiesto del clon
# (`install: download`), cuántas tienen su árbol alcanzable desde HEAD. Es lo que un clon nuevo baja, y de donde el
# instalador las restituye sin red (story 8.18, AC 36). Si no son todas —un clon recortado—, «desde la historia local» no
# se puede medir ahí: quien llama lo dice como NO MEDIDO, no como rojo.
third_party_in_history() {
  git -C "$1" rev-list --objects HEAD 2>/dev/null | node -e '
    const fs = require("fs"); const path = require("path");
    let m; try { m = JSON.parse(fs.readFileSync(path.join(process.argv[1], "scripts", "publishing", "third-party-skills.json"), "utf8")); } catch (e) { console.log("0 0"); process.exit(0); }
    const have = new Set(fs.readFileSync(0, "utf8").split("\n").map((l) => l.split(" ")[0]));
    const dl = (m.third_party || []).filter((e) => e && e.install === "download");
    console.log(`${dl.length} ${dl.filter((e) => have.has(e.tree)).length}`);' "$1"
}

# hooks_census <settings.json> → «<total> <repetidos>»: repetido = el mismo evento, el mismo matcher y el MISMO archivo
# (por su ruta real: el enlace ~/.claude/tycon-harness y la carpeta del clon son dos rutas al mismo archivo). El
# ensayo del alta (2026-10-03) midió 32 hooks registrados dos veces por llamar al instalador por el enlace.
hooks_census() {
  node -e '
    const fs = require("fs");
    let s; try { s = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { console.log("0 0"); process.exit(0); }
    const seen = new Map(); let total = 0;
    for (const [ev, bucket] of Object.entries(s.hooks || {})) for (const entry of bucket || []) {
      const matcher = String(entry.matcher || "").split("|").map((t) => t.trim()).filter(Boolean).sort().join("|");
      for (const h of entry.hooks || []) {
        const cmd = String(h.command || ""); total++;
        const q = /"(\/[^"]+)"/.exec(cmd);
        let file = cmd; if (q) { try { file = fs.realpathSync(q[1]); } catch (e) { file = q[1]; } }
        const key = `${ev}\u0000${matcher}\u0000${file}`;
        seen.set(key, (seen.get(key) || 0) + 1);
      }
    }
    let repeated = 0; for (const n of seen.values()) if (n > 1) repeated += n - 1;
    console.log(`${total} ${repeated}`);' "$1"
}

# ── T26: una versión nueva que la política `ask` no aplica (T34 de la story 8.13) ─────────────────────────────
# serve_new_version → NEW_VERSION: un commit nuevo en la copia que el desvío sirve (dentro del contenedor es de `node`:
# Dockerfile.copy), que cambia la portada y —si la copia trae version.json— sube su número al siguiente, con la forma
# exacta del archivo (dos espacios, las mismas claves en su orden, un salto de línea final). NEW_VERSION queda vacío si
# la copia no trae version.json. Si el archivo está y no se puede leer, no toca nada y devuelve 1.
NEW_VERSION=""
serve_new_version() {
  local now rc
  NEW_VERSION=""
  now="$(stamped_version_of "${COPY_DIR}")"; rc=$?
  case "${rc}" in
    0) NEW_VERSION="$(next_version "${now}")"
       node -e '
         const fs = require("fs"); const [file, next] = process.argv.slice(1);
         const j = JSON.parse(fs.readFileSync(file, "utf8")); j.version = next;
         fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");' "${COPY_DIR}/version.json" "${NEW_VERSION}" || return 1
       git -C "${COPY_DIR}" add -- version.json || return 1 ;;
    1) : ;;
    *) echo "serve_new_version: el version.json de ${COPY_DIR} no se puede leer, o su número tiene otra forma"; return 1 ;;
  esac
  printf '\n<!-- clean-machine: una versión nueva, de laboratorio -->\n' >> "${COPY_DIR}/README.md" \
    && git -C "${COPY_DIR}" add -- README.md \
    && git -C "${COPY_DIR}" -c user.name=lab -c user.email=lab@example.com -c commit.gpgsign=false -c core.hooksPath=/dev/null \
         commit -q -m "clean-machine: una versión nueva de laboratorio${NEW_VERSION:+ (${NEW_VERSION})}" || return 1
  # con el número por etiqueta, la versión nueva lleva su etiqueta, como la pone el merge en el repo público
  if [ -n "${NEW_VERSION}" ] && [ "$(json "${COPY_DIR}/version.json" 'd.numbering || ""')" = "merge-tag" ]; then
    git -C "${COPY_DIR}" tag -f "v${NEW_VERSION}" HEAD > /dev/null || return 1
  fi
}
# forget_last_fetch — suelta el sello de la última mirada a la red (lo que las suites de laboratorio hacen con
# `estado_set "d['last_fetch']=None"`): con él puesto, `startup` no vuelve a mirar el remoto hasta pasadas 6 horas
# (política ask). El resto del estado queda igual, con la forma con que lo escribe el programa.
forget_last_fetch() {
  node -e '
    const fs = require("fs"); const file = process.argv[1];
    const d = JSON.parse(fs.readFileSync(file, "utf8")); d.last_fetch = null;
    fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");' "${STATE_FILE}"
}

# uninstall_keeps_clone <T> — `harness.js uninstall --yes` sale 0 y el clon queda como estaba (mismo commit, mismo `git status`)
uninstall_keeps_clone() {
  local t="$1" head_before status_before rc
  head_before="$(git -C "${CLONE}" rev-parse HEAD)"; status_before="$(git -C "${CLONE}" status --porcelain)"
  node "${HARNESS_JS}" uninstall --yes > "${OUT_DIR}/uninstall.out" 2>&1; rc=$?
  if [ "${rc}" -eq 0 ]; then ok "${t} harness.js uninstall --yes sale 0"; else no "${t} harness.js uninstall --yes salió ${rc}: $(tail -n 3 "${OUT_DIR}/uninstall.out" | tr '\n' ' ')"; fi
  if [ -d "${CLONE}/.git" ] && [ "$(git -C "${CLONE}" rev-parse HEAD)" = "${head_before}" ] && [ "$(git -C "${CLONE}" status --porcelain)" = "${status_before}" ]; then
    ok "${t} tras uninstall el clon sigue intacto (mismo commit, mismo git status)"
  else no "${t} tras uninstall el clon cambió (o no está): ${CLONE}"; fi
  if [ ! -e "${STATE_FILE}" ] && [ ! -L "${HARNESS_LINK}" ] && [ ! -L "${HOME}/.claude/agent-skills" ]; then ok "${t} tras uninstall no quedan el estado ni los enlaces al clon"
  else no "${t} tras uninstall quedan el estado o un enlace al clon (estado: $([ -e "${STATE_FILE}" ] && echo sí || echo no) · el lugar: $([ -L "${HARNESS_LINK}" ] && echo sí || echo no) · agent-skills: $([ -L "${HOME}/.claude/agent-skills" ] && echo sí || echo no))"; fi
}
