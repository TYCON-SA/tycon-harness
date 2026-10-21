#!/usr/bin/env bash
# fake-home.sh — la carpeta personal de prueba de las suites que simulan la máquina del dev.
#
# Por qué existe: una suite que simula la máquina del dev sin aislar su HOME deja constancias falsas en los registros
# REALES (`~/.claude/.tycon-pipeline/gates.log`, `frenos.jsonl`, `new-names.jsonl`, `reviewer-rules.jsonl`);
# `frenos.jsonl` sube al buzón y alimenta el tablero. Si cada suite arma su HOME falsa a mano y a su manera,
# olvidarse un paso ensucia la máquina sin avisar. Las librerías resuelven esos registros con `$HOME` /
# `os.homedir()` y NO se les agregan variables para redirigirlos: se aísla cambiando HOME.
#
# Se usa con `source` (tiene que cambiar el ambiente de la suite que lo carga, por eso no se ejecuta):
#
#   source "$AQUI/scripts/tests/lib/fake-home.sh"
#   fake_home_create "$TMP/casa"               # HOME, FAKE_HOME, REAL_HOME; fija TYCON_GUIDES_DIR/TYCON_SKILLS_DIR
#   fake_home_create "$TMP/casa" --installer   # además launchctl de mentira, sin examen nocturno ni entorno gráfico
#   n="$(fake_home_count frenos.jsonl '"freno":"pr-uno-por-repo"')"   # evidencia POSITIVA de dónde quedó
#
# · Se puede llamar una vez por caso (re-apunta a una carpeta nueva y conserva la HOME real).
# · Todo queda en el proceso que lo llama: en una subshell o en `$( … )`, afuera no cambia nada.
# · El control es siempre la cuenta en la falsa, nunca «el registro real no creció»: las sesiones reales del
#   dev escriben ahí al mismo tiempo.

# fake_home_create <dir> [--installer]
fake_home_create() {
  local dir="${1:-}" modo="${2:-}"
  if [ -z "$dir" ]; then
    echo "fake-home: falta la carpeta — uso: fake_home_create <dir> [--installer]" >&2; return 2
  fi
  if [ -n "$modo" ] && [ "$modo" != "--installer" ]; then
    echo "fake-home: opción desconocida «${modo}» — la única es --installer" >&2; return 2
  fi
  # Absoluta: una relativa depende del directorio actual, y desde la HOME real crearía una carpeta suelta
  # adentro de ella (sin esto, una suite la dejaría ahí). Las suites pasan rutas de `mktemp -d`.
  case "$dir" in
    /*) ;;
    *) echo "fake-home: «${dir}» no es una ruta absoluta — pasá una carpeta de mktemp -d" >&2; return 2 ;;
  esac

  # La HOME real: la de antes de la primera llamada. Si HOME ya es la falsa, la real es la que se guardó.
  local real
  if [ -n "${FAKE_HOME:-}" ] && [ -n "${REAL_HOME:-}" ] && [ "${HOME:-}" = "$FAKE_HOME" ]; then real="$REAL_HOME"
  else real="${HOME:-}"; fi
  if [ -z "$real" ]; then
    echo "fake-home: HOME está vacía — no sé cuál es la carpeta real que hay que proteger" >&2; return 2
  fi

  # Se compara la ruta FÍSICA: «~/», «~/.» o un enlace a la HOME siguen siendo la HOME real.
  local real_fisica dir_fisica
  real_fisica="$(cd "$real" 2>/dev/null && pwd -P)" || real_fisica="$real"
  if [ -d "$dir" ]; then
    dir_fisica="$(cd "$dir" 2>/dev/null && pwd -P)"
    if [ "$dir_fisica" = "$real_fisica" ]; then
      echo "fake-home: «${dir}» es la HOME real (${real}) — la carpeta de prueba tiene que ser otra" >&2; return 1
    fi
  fi
  if ! mkdir -p "$dir/.claude/.tycon-pipeline" 2>/dev/null; then
    echo "fake-home: no pude crear «${dir}/.claude/.tycon-pipeline» — HOME queda como estaba" >&2; return 1
  fi
  local abs
  abs="$(cd "$dir" 2>/dev/null && pwd)" || { echo "fake-home: no pude entrar a «${dir}»" >&2; return 1; }

  if [ "$modo" = "--installer" ]; then
    if ! mkdir -p "$abs/.fake-bin" 2>/dev/null || ! printf '#!/bin/sh\n# launchctl de mentira (fake-home.sh): no carga nada en la máquina real.\nexit 0\n' > "$abs/.fake-bin/launchctl" \
       || ! chmod +x "$abs/.fake-bin/launchctl"; then
      echo "fake-home: no pude armar el launchctl de mentira en «${abs}/.fake-bin»" >&2; return 1
    fi
  fi

  # El arnés y agent-skills: los guiones los buscan bajo `$HOME/.claude/` cuando no les pasan la variable. Se
  # fijan con lo que resolvía la HOME real, y sólo si existen: una ruta inventada cambiaría lo que ven.
  # (el arnés por el lugar y, si no está, por el nombre viejo, con los nombres de scripts/setup/harness/place.js)
  if [ -z "${TYCON_GUIDES_DIR:-}" ]; then
    for _fh_name in $(node -e 'const p=require(process.argv[1]); process.stdout.write(p.PLACE_NAME + " " + p.LEGACY_PLACE_NAME)' "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../setup/harness" 2>/dev/null && pwd)/place.js" 2>/dev/null); do
      if [ -d "$real/.claude/$_fh_name" ]; then export TYCON_GUIDES_DIR="$real/.claude/$_fh_name"; break; fi
    done
  fi
  if [ -z "${TYCON_SKILLS_DIR:-}" ] && [ -d "$real/.claude/agent-skills/skills" ]; then
    export TYCON_SKILLS_DIR="$real/.claude/agent-skills/skills"
  fi
  if [ "$modo" = "--installer" ]; then
    export LAUNCHCTL_BIN="$abs/.fake-bin/launchctl" TYCON_NO_NIGHTLY_EXAM=1 TYCON_NO_GUI_ENV=1
  fi
  export REAL_HOME="$real" FAKE_HOME="$abs" HOME="$abs"
  # Con la HOME de prueba, el instalador no baja el Node del arnés de nodejs.org
  export TYCON_HARNESS_NODE=0
  return 0
}

# fake_home_count <registro> <texto> — cuántas líneas de $FAKE_HOME/.claude/.tycon-pipeline/<registro>
# contienen <texto> (literal). Registro ausente → 0. Sin HOME falsa armada, falla: nunca cuenta en la real.
fake_home_count() {
  local registro="${1:-}" texto="${2:-}"
  if [ -z "${FAKE_HOME:-}" ] || [ ! -d "$FAKE_HOME/.claude/.tycon-pipeline" ]; then
    echo "fake-home: no hay HOME falsa armada (llamá fake_home_create antes) — no cuento en la real" >&2; return 2
  fi
  if [ -z "$registro" ] || [ -z "$texto" ]; then
    echo "fake-home: uso: fake_home_count <registro> <texto>" >&2; return 2
  fi
  local f="$FAKE_HOME/.claude/.tycon-pipeline/$registro" n rc
  if [ ! -e "$f" ]; then echo 0; return 0; fi
  n="$(grep -cF -- "$texto" "$f")"; rc=$?
  if [ "$rc" -gt 1 ]; then echo "fake-home: no pude leer «${f}»" >&2; return 2; fi
  echo "${n:-0}"
  return 0
}
