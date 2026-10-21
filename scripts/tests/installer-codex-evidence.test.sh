#!/usr/bin/env bash
# installer-codex-evidence.test.sh — el instalador decide si la máquina usa Codex por el DISCO, no sólo
# por la llave del ambiente.
#
# La llave TYCON_CODEX vive en el rc del shell y al instalador (arranque de sesión) no
# le llega: puesta en el .zshrc y en launchctl, vacía en la sesión → el lado Codex
# no se desplegaría en ninguna máquina, en silencio. Decide codexDeployed() de harness-parity.js.
#
# Se mira el bloque del AGENTS.md puntero en modo --check (avisa y no escribe): sale el aviso ⇔ el
# instalador cree que la máquina usa Codex. Casos: (1) evidencia sin llave → sí; (2) sin evidencia ni
# llave → no; (3) llave en 0 explícito con evidencia → no; (4) llave en 1 sin evidencia → sí;
# (5) chequeo roto → avisa la causa y sigue; (6) el instalador con la pregunta al disco
# arrancada (el defecto: sólo miraría la llave), con evidencia y sin llave → no. Todas las corridas «no» exigen además que el instalador TERMINE (código 0).
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INST="$RAIZ/scripts/install-tycon-hooks.sh"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export TYCON_NO_CANONICAL_PATH=1 TYCON_NO_AZ_PROJECTS_REFRESH=1 TYCON_NO_BOOTSTRAP_HEAL=1 \
  TYCON_NO_CLAUDEMD_SYNC=1 TYCON_NO_COMMANDS_SYNC=1 TYCON_NO_ENGRAM_PROJECT_CHECK=1 \
  TYCON_NO_ENGRAM_VERSION_CHECK=1 TYCON_NO_NIGHTLY_EXAM=1 TYCON_NO_GIT_HOOKS=1 \
  TYCON_NO_GUI_ENV=1 TYCON_NO_SQLITE_CHECK=1 \
  TYCON_NO_THREAD_RESCUE=1 TYCON_NO_UPLOAD_RUNS=1 TYCON_NO_DOWNLOAD_RUNS=1 TYCON_NO_COLLECT_FINDINGS=1 \
  TYCON_MAILBOX_URL_BASE=http://127.0.0.1:9 TYCON_BENCH_DAILY=0 TYCON_STAGE_METRICS=0
# HOME falso (mismo aislamiento que installer-cleanup-period.test.sh): el instalador exige el esqueleto de
# tycon-pipeline, y el barrido del puntero recorre $HOME/SourceCode — ahí va un repo del equipo de juguete.
HOME="$T/casa"; mkdir -p "$HOME/.claude/agent-skills/skills/tycon-pipeline"; export HOME
# La raíz de repos no cae a $HOME/SourceCode: se declara. Sin esto el barrido del
# puntero dice «sin raíz de repos conocida» y no mira el repo de juguete.
export TYCON_REPOS_ROOT="$HOME/SourceCode"
# Y la llave de Codex sale de la configuración (`integrations.codex`): sin perfil del equipo nace
# APAGADA. Lo que esta suite mide es el modo «detect» (lo que trae el perfil): se declara en el archivo de la
# máquina de esta HOME; TYCON_CODEX=0/1 por variable sigue mandando por encima, que es lo que los otros casos prueban.
# La organización también: el barrido del puntero AGENTS.md sólo mira repos de la organización configurada (la del
# origin del repo de juguete de abajo; una organización inventada).
mkdir -p "$HOME/.claude"; printf '{"ado":{"org":"https://dev.azure.com/acme"},"integrations":{"codex":"detect"}}' > "$HOME/.claude/tycon.json"
R="$HOME/SourceCode/Producto"; mkdir -p "$R"; git -C "$R" init -q
git -C "$R" remote add origin https://dev.azure.com/acme/Producto/_git/Producto
echo '# reglas' > "$R/CLAUDE.md"
CON="$T/codex-con"; mkdir -p "$CON"; echo '{"hooks":{}}' > "$CON/hooks.json"   # evidencia: hooks.json desplegado
SIN="$T/codex-sin"; mkdir -p "$SIN"
AVISO='tiene CLAUDE.md sin AGENTS.md'

# correr <instalador> <CODEX_HOME> [TYCON_CODEX]: imprime la salida del instalador en --check y, al final,
# la línea «RC=<n>» con su código de salida. Sin tercer argumento, la variable NO existe en el ambiente
# (unset), que es el caso del arranque real.
# 🔴 El código importa: el instalador corre con `set -e`, y si se cortara
#    entero cuando la respuesta es «no» (código 10), sólo mirar que FALTE un aviso daría verde igual.
correr() {
  echo '{"hooks":{}}' > "$T/s.json"
  local rc=0
  if [ $# -ge 3 ]; then
    env TYCON_CODEX="$3" CODEX_HOME="$2" TYCON_SETTINGS_PATH="$T/s.json" bash "$1" --check 2>&1 || rc=$?
  else
    env -u TYCON_CODEX CODEX_HOME="$2" TYCON_SETTINGS_PATH="$T/s.json" bash "$1" --check 2>&1 || rc=$?
  fi
  echo "RC=$rc"
}
termino() { case "$1" in *"RC=0") return 0 ;; *) return 1 ;; esac; }
avisa() { case "$1" in *"$AVISO"*) return 0 ;; *) return 1 ;; esac; }

S="$(correr "$INST" "$CON")"
avisa "$S" && ok "con Codex desplegado y SIN la llave en el ambiente, el instalador lo reconoce" \
  || mal "con Codex desplegado y sin la llave, el instalador no lo reconoce (el defecto de la deuda)"

S="$(correr "$INST" "$SIN")"
if avisa "$S"; then mal "sin evidencia ni llave, el instalador cree que la máquina usa Codex"
elif ! termino "$S"; then mal "sin evidencia ni llave, el instalador no terminó ($(echo "$S" | tail -1)): la respuesta «no» lo corta"
else ok "sin evidencia ni llave, no hace nada de Codex y el instalador termina"; fi

S="$(correr "$INST" "$CON" 0)"
if avisa "$S"; then mal "con TYCON_CODEX=0 explícito, el instalador igual hace lo de Codex (la suite no podría aislarlo)"
elif ! termino "$S"; then mal "con TYCON_CODEX=0 explícito, el instalador no terminó ($(echo "$S" | tail -1))"
else ok "con TYCON_CODEX=0 explícito gana el apagado, aunque haya evidencia"; fi

# El chequeo que FALLA (módulo roto) no se lee como «no»: avisa con la causa y el instalador sigue.
# Copia del instalador con un harness-parity.js que tira al cargarse, en la misma estructura del arnés.
mkdir -p "$T/tcg/scripts/lib" "$T/tcg/scripts/hooks" "$T/tcg/scripts/setup"; cp "$INST" "$T/tcg/scripts/install-tycon-hooks.sh"
# el instalador registra los hooks con el aplicador y su lista: viajan con él
cp "$RAIZ/scripts/setup/apply-hooks.js" "$RAIZ/scripts/setup/hooks-list.json" "$T/tcg/scripts/setup/"
# el aplicador usa scripts/setup/harness/plugin-dirs.js (y éste, place.js): la carpeta viaja entera
cp -R "$RAIZ/scripts/setup/harness" "$T/tcg/scripts/setup/"
echo "throw new Error('modulo-roto-de-prueba');" > "$T/tcg/scripts/lib/harness-parity.js"
S="$(correr "$T/tcg/scripts/install-tycon-hooks.sh" "$CON")"
case "$S" in
  *"no pude saber si esta máquina usa Codex (modulo-roto-de-prueba)"*)
    termino "$S" && ok "con el chequeo roto, avisa la causa y el instalador termina" \
      || mal "con el chequeo roto avisa, pero el instalador no terminó ($(echo "$S" | tail -1))" ;;
  *) mal "con el chequeo roto no avisa: cae a «no usa Codex» en silencio" ;;
esac

S="$(correr "$INST" "$SIN" 1)"
avisa "$S" && ok "con TYCON_CODEX=1 y nada desplegado, estrena el lado Codex" \
  || mal "con TYCON_CODEX=1 y nada desplegado, el instalador no hace lo de Codex"

# El defecto a reproducir es no preguntarle al disco (sólo la llave). Se arma desde el
# instalador actual, con la pregunta al disco (codexDeployed()) cambiada por «no»: no depende de un commit viejo, que
# un clon sin historia no tiene. Corre desde $T: el bloque del puntero no depende de la ruta del arnés.
if node -e '
const fs = require("fs");
const src = fs.readFileSync(process.argv[1], "utf8");
const pregunta = "require(process.argv[1]).codexDeployed()";
if (src.split(pregunta).length !== 2) { console.error("la pregunta al disco no aparece una sola vez en el instalador"); process.exit(1); }
fs.writeFileSync(process.argv[2], src.replace(pregunta, "false"));
' "$INST" "$T/inst-sin-disco.sh"; then
  S="$(correr "$T/inst-sin-disco.sh" "$CON")"
  avisa "$S" && mal "el rojo previo no se reproduce: sin preguntarle al disco, el instalador igual reconoce Codex sin la llave" \
    || ok "rojo previo: sin preguntarle al disco, con Codex desplegado y sin la llave, el instalador no lo reconoce"
else
  mal "no pude armar el instalador sin la pregunta al disco para el rojo previo"
fi

echo
if [ "$FALLOS" -gt 0 ]; then echo "FALLARON $FALLOS chequeo(s)"; exit 1; fi
echo "OK"
