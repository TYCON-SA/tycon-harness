#!/usr/bin/env bash
# harness-release-links.test.sh — la versión bajada con ENLACES (story 8.33): en Windows `~/.tycon/harness` y
# `~/.tycon/previous` son uniones a `~/.tycon/versions/<v>/`, y cambiar de versión es cambiar los enlaces; ninguna
# carpeta en uso se mueve. Así la actualización anda con otra sesión o un VS Code abiertos.
#
# En Mac y Linux esa forma NO se usa (decisión 2 de la story): estas pruebas la ejercitan con la variable SÓLO de pruebas
# `TYCON_RELEASE_LINKS=1`, con enlaces simbólicos en lugar de uniones. «Tomado» se simula con una envoltura de
# `fs.renameSync` (precargada con NODE_OPTIONS) que falla con EPERM sobre las carpetas que nombra `TYCON_TEST_HELD`: en
# posix un archivo abierto no traba un rename, y lo que la story protege es justamente el rename que en Windows falla.
# Lo que prueba la propiedad de verdad es el ensayo de Windows (182, escenario no-clone: T1 y T16).
#
# Lo que no se puede perder:
#   T2  · Swap_LinksOnly_NoVersionDirRenamed — install y dos update: la nueva en versions/<v>, harness y previous
#         enlaces a las dos últimas, sin diario; ninguna carpeta de versions/ se renombra; un lector en bucle nunca ve
#         harness ausente (el cambio del enlace en posix es atómico).
#   T3  · Swap_ActiveFileHeld_Applies — con la versión ACTIVA tomada, update aplica en esa corrida: sale 0, sin
#         `waiting` ni `failed`.
#   T4  · Persisted_NeverNamesVersionDir — después de install, update y rollback, nada escrito fuera de ~/.tycon
#         (enchufes, CLAUDE.md, estado, configuración, copia fija, enlaces de ~/.claude) nombra versions/.
#   T5  · Repair_LinkJournal_EveryStage — un corte en cada etapa de link-swap.json (y de la conversión) lo repara el
#         arranque y bootstrap.js: queda una versión entera apuntada por harness, y lo dice. Un swap.json viejo se sigue
#         reparando como hoy. (El respaldo de PowerShell, en el ensayo de Windows: T16.)
#   T6  · OldBootstrapCopy_LeavesNewJournal — el respaldo en shell de ANTES de esta story no toca link-swap.json; el
#         arranque nuevo lo repara.
#   T7  · Rollback_SwapsLinks_TwiceUndoes — rollback con la activa tomada intercambia los destinos y sale 0; un segundo
#         rollback lo deshace; sin previous, dice install --version.
#   T8  · HealthRed_BackByLink_NotRetried — salud roja: harness vuelve a la anterior por el enlace, previous se quita,
#         failed, y no se reintenta sola; ninguna carpeta de versions/ se renombra.
#   T9  · Fallback_BrokenHarness_RetargetsLink — lo prueba el ensayo de Windows con el respaldo de PowerShell
#         (scripts/tests/windows/no-clone-probe.js, T16): el respaldo en shell es de Mac y Linux, y ahí no cambia.
#   T10 · Convert_OldLayout_OnceAndWhenHeld — una máquina con harness/ y previous/ carpetas reales se convierte; con
#         harness/ tomada, la versión nueva queda en versions/, la máquina sigue en la de antes, el arranque sale 0 y el
#         aviso (qué cerrar, reiniciar como último recurso, el comando) sale UNA vez; suelta, se convierte y aplica.
#   T11 · Cleanup_FreeGone_HeldKept_NamedKept — de versions/ se borra lo libre que no es destino; lo tomado y lo nombrado
#         quedan; doctor los lista con su edad; el aviso del arranque sale con la más vieja tomada de 7 días, no de 6.
#   T12 · InstallAndMigrate_BornInNewLayout — install en una casa vacía nace en la forma nueva (la mudanza: harness-move-home).
#   T13 · Uninstall_LinksAndVersions_NeverThroughLink — uninstall quita los enlaces y versions/ sin borrar a través de un
#         enlace: un marcador fuera de ~/.tycon al que apunta previous queda intacto; config.json se conserva.
#   T14 · Doctor_LinksAndPending — doctor dice dónde apunta cada enlace, la conversión trabada y lo pendiente.
#
# Laboratorio: scripts/tests/lib/harness-lab.sh. Nunca ~/.claude ni el checkout real. 🔴 Sin pipes sobre lo medido.
#
# @story-8.33
# Uso: bash scripts/tests/harness-release-links.test.sh [--only T2|T3|…]
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
export TYCON_UPDATE_APPLY=auto
export TYCON_RELEASE_LINKS=1
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
BASE="$(mktemp -d)"
case "$BASE" in *tycon-claude-guides*|*agent-skills*|*/.claude*) echo "❌ harness-release-links: el laboratorio cayó en ${BASE}"; exit 1 ;; esac
trap 'rm -rf "$BASE"; kill $(jobs -p) 2>/dev/null' EXIT
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
ESTADO() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"; }
estado() { j "$(ESTADO)" "$1"; }
LOG() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness/startup.log"; }
TYCON_DIR() { printf '%s' "$LAB_HOME/.tycon"; }
PROGRAM() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness"; }
PLACE_NAME="$(node -p "require('$RAIZ/scripts/setup/harness/tycon-home.js').PLACE_NAME")"
# a dónde apunta un enlace, sin seguirlo (vacío si no es un enlace)
destino() { [ -L "$1" ] && readlink "$1"; }
# la versión del árbol al que lleva un nombre (siguiendo el enlace)
version_en() { j "$1/.tycon-release.json" "d['version']"; }
instala() {
  harness_lab_release_fresh_home
  INSTALL_OUT="$(harness install --version "${1:-latest}" --yes 2>&1)"; INSTALL_RC=$?
}
# la envoltura de «tomado»: rename de una carpeta nombrada en TYCON_TEST_HELD (o de algo adentro) falla con EPERM; con
# TYCON_TEST_RENAME_LOG anota cada rename (origen<TAB>destino)
HELD_JS="$BASE/held-rename.js"
cat > "$HELD_JS" <<'JS'
// held-rename.js (harness-release-links.test.sh): simula en posix una carpeta TOMADA de Windows
const fs = require('fs'), path = require('path');
const held = (process.env.TYCON_TEST_HELD || '').split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
const log = process.env.TYCON_TEST_RENAME_LOG || '';
const orig = fs.renameSync;
fs.renameSync = function renameSync(from, to) {
  const f = path.resolve(String(from));
  if (log) { try { fs.appendFileSync(log, `${f}\t${path.resolve(String(to))}\n`); } catch (_) { /* sin registro */ } }
  if (held.some((h) => f === h || f.startsWith(h + path.sep))) {
    const e = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`);
    e.code = 'EPERM'; e.errno = -1; e.syscall = 'rename';
    throw e;
  }
  return orig.apply(this, arguments);
};
JS
# corre un comando con la envoltura puesta: con_tomado "<carpetas separadas por :>" <comando…>
con_tomado() { local h="$1"; shift; NODE_OPTIONS="--require $HELD_JS" TYCON_TEST_HELD="$h" "$@"; }
# corre un comando anotando cada rename en RENAMES
RENAMES="$BASE/renames.log"
con_registro() { : > "$RENAMES"; NODE_OPTIONS="--require $HELD_JS" TYCON_TEST_RENAME_LOG="$RENAMES" "$@"; }
# ¿algún rename tuvo como ORIGEN una carpeta de versions/? (lo que la forma nueva no hace nunca)
renombro_versiones() { grep -q "^$(TYCON_DIR)/versions/" "$RENAMES" 2>/dev/null; }

# ───────────────────────────────────────────── T2 ─────────────────────────────────────────────
if corre T2; then
  echo "T2 · Swap_LinksOnly_NoVersionDirRenamed — la nueva en versions/<v>, los dos enlaces, sin diario, sin renombrar versiones"
  harness_lab_create "$BASE/lab2"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  T="$(TYCON_DIR)"
  [ "$INSTALL_RC" = 0 ] && ok "install sale 0" || mal "install salió $INSTALL_RC: $INSTALL_OUT"
  [ -L "$T/harness" ] && [ "$(destino "$T/harness")" = "$T/versions/2026.10.07.1" ] && ok "harness es un enlace a versions/2026.10.07.1" || mal "harness: $(ls -la "$T" 2>&1 | tr '\n' ' ')"
  [ ! -e "$T/previous" ] && [ ! -L "$T/previous" ] && ok "sin previous todavía" || mal "hay previous tras la primera instalación"
  harness_lab_publish_stable 2026.10.07.2
  # un lector en bucle mientras se actualiza: nunca ve harness ausente
  GAPS="$BASE/gaps2"; : > "$GAPS"
  ( while [ ! -e "$BASE/stop2" ]; do [ -e "$T/harness/.tycon-release.json" ] || echo hueco >> "$GAPS"; done ) &
  lector=$!
  out="$(con_registro harness_release update --yes 2>&1)"; rc=$?
  touch "$BASE/stop2"; wait "$lector" 2>/dev/null
  [ "$rc" = 0 ] && ok "update aplica: $out" || mal "update salió $rc: $out"
  [ "$(destino "$T/harness")" = "$T/versions/2026.10.07.2" ] && ok "harness → versions/2026.10.07.2" || mal "harness → $(destino "$T/harness")"
  [ "$(destino "$T/previous")" = "$T/versions/2026.10.07.1" ] && ok "previous → versions/2026.10.07.1" || mal "previous → $(destino "$T/previous")"
  [ "$(version_en "$T/harness")" = 2026.10.07.2 ] && [ "$(estado "d['version']['number']")" = 2026.10.07.2 ] && ok "el árbol y el estado dicen 2026.10.07.2" || mal "árbol $(version_en "$T/harness") · estado $(estado "d['version']['number']")"
  [ ! -e "$T/link-swap.json" ] && [ ! -e "$T/swap.json" ] && ok "sin diario al terminar" || mal "quedó un diario: $(ls "$T")"
  renombro_versiones && mal "se renombró una carpeta de versions/: $(grep "^$T/versions/" "$RENAMES")" || ok "ninguna carpeta de versions/ se renombró"
  [ ! -s "$GAPS" ] && ok "un lector en bucle nunca vio harness ausente" || mal "el lector vio harness ausente $(wc -l < "$GAPS") vez/veces"
  harness_lab_publish_stable 2026.10.07.3
  out="$(con_registro harness_release update --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ "$(destino "$T/harness")" = "$T/versions/2026.10.07.3" ] && [ "$(destino "$T/previous")" = "$T/versions/2026.10.07.2" ] && ok "otra más: harness → .3, previous → .2" || mal "tercera: rc=$rc harness → $(destino "$T/harness") previous → $(destino "$T/previous")"
  [ -d "$T/versions/2026.10.07.1" ] && ok "la .1 queda en versions/ para la limpieza del arranque siguiente" || mal "la .1 desapareció en el cambio"
  renombro_versiones && mal "se renombró una carpeta de versions/" || ok "tampoco en el segundo cambio"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T3 ─────────────────────────────────────────────
if corre T3; then
  echo "T3 · Swap_ActiveFileHeld_Applies — con la versión activa tomada, la actualización se aplica en esa corrida"
  harness_lab_create "$BASE/lab3"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  T="$(TYCON_DIR)"
  harness_lab_publish_stable 2026.10.07.2
  harness_release update --yes >/dev/null 2>&1
  harness_lab_publish_stable 2026.10.07.3
  # tomadas: la activa (.2) y la anterior (.1), como con una sesión y un VS Code abiertos
  out="$(con_tomado "$T/versions/2026.10.07.2:$T/versions/2026.10.07.1" harness_release update --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "update sale 0 con la activa tomada: $out" || mal "update salió $rc: $out"
  case "$out" in *espera*) mal "dice que espera: $out" ;; *) ok "no dice que espera" ;; esac
  [ "$(estado "d['version']['number']")" = 2026.10.07.3 ] && [ "$(destino "$T/harness")" = "$T/versions/2026.10.07.3" ] && ok "aplicada: harness → .3 y el estado en .3" || mal "estado $(estado "d['version']['number']") harness → $(destino "$T/harness")"
  [ "$(estado "d['failed']")" = None ] && ok "sin failed" || mal "quedó failed: $(estado "d['failed']")"
  # el arranque con la .1 tomada: sale 0 y la deja para otro arranque
  out="$(con_tomado "$T/versions/2026.10.07.1" harness_release startup 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ -d "$T/versions/2026.10.07.1" ] && ok "el arranque con la .1 tomada sale 0 y la deja" || mal "arranque: rc=$rc; .1 $( [ -d "$T/versions/2026.10.07.1" ] && echo está || echo borrada)"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T4 ─────────────────────────────────────────────
if corre T4; then
  echo "T4 · Persisted_NeverNamesVersionDir — nada escrito fuera de ~/.tycon nombra versions/"
  harness_lab_create "$BASE/lab4"
  harness_lab_release_server
  # con Codex enchufado también: sus desplegadores arman las rutas con __dirname, que resuelve el enlace
  harness_lab_codex_pieces || mal "T4 no pude sumar las piezas de Codex al laboratorio"
  harness_lab_publish_stable 2026.10.07.1
  harness_lab_tools both
  instala latest
  T="$(TYCON_DIR)"
  [ -f "$CODEX_HOME/hooks.json" ] && ok "Codex quedó enchufado (hooks.json escrito)" || mal "Codex no quedó enchufado: $(ls "$CODEX_HOME" 2>&1) — $INSTALL_OUT"
  harness_lab_publish_stable 2026.10.07.2
  harness_release update --yes >/dev/null 2>&1
  harness_lab_publish_stable 2026.10.07.3
  harness_release update --yes >/dev/null 2>&1
  harness_release rollback >/dev/null 2>&1
  harness_release startup >/dev/null 2>&1
  [ "$(destino "$T/harness")" = "$T/versions/2026.10.07.2" ] && ok "después del rollback, harness → .2" || mal "harness → $(destino "$T/harness")"
  hits=""
  for f in "$TYCON_SETTINGS_PATH" "$CLAUDE_MD_PATH" "$CODEX_HOME/hooks.json" "$CODEX_HOME/config.toml" "$CODEX_HOME/AGENTS.md" "$(ESTADO)" "$LAB_HOME/.claude/tycon.json" "$T/config.json" "$LAB_HOME"/Library/LaunchAgents/*.plist; do
    [ -f "$f" ] && grep -q "$T/versions" "$f" && hits="$hits $f"
  done
  # la copia fija de arranque (sus archivos de datos y guiones)
  # (los registros —*.log— cuentan lo que pasó, no apuntan a nada: no cuentan)
  if grep -rlq --exclude='*.log' --exclude='*.log.1' "$T/versions" "$(PROGRAM)" 2>/dev/null; then hits="$hits $(grep -rl --exclude='*.log' --exclude='*.log.1' "$T/versions" "$(PROGRAM)" | tr '\n' ' ')"; fi
  for l in "$LAB_HOME/.claude/$PLACE_NAME" "$LAB_HOME/.claude/agent-skills"; do
    if [ -L "$l" ]; then case "$(readlink "$l")" in *versions*) hits="$hits (enlace $l → $(readlink "$l"))" ;; esac
    else hits="$hits (falta el enlace $l)"; fi
  done
  # los enlaces de skills y revisores que el aplicador deja en ~/.claude
  for d in "$LAB_HOME/.claude/skills" "$LAB_HOME/.claude/agents" "$LAB_HOME/.claude/commands"; do
    [ -d "$d" ] || continue
    for l in "$d"/*; do [ -L "$l" ] && case "$(readlink "$l")" in *"$T/versions"*) hits="$hits (enlace $l)" ;; esac; done
  done
  [ -z "$hits" ] && ok "nada fuera de ~/.tycon nombra versions/ (enchufes, CLAUDE.md, estado, configuración, copia fija, enlaces)" || mal "lo nombran: $hits"
  [ "$(estado "d['tree']")" = "$T/harness" ] && ok "el estado dice ~/.tycon/harness como árbol" || mal "el estado dice tree=$(estado "d['tree']")"
  # (pase adversarial, clase 5) el modo desarrollador y la vuelta: `link --managed` vuelve a ~/.tycon/harness, no a la
  # carpeta numerada (con real() quedaban el estado y el lugar atados a la versión de ese momento)
  harness_release link --local "$LAB_TREE" --allow-temporary >/dev/null 2>&1
  out="$(harness_release link --managed 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ "$(estado "d['tree']")" = "$T/harness" ] && [ "$(readlink "$LAB_HOME/.claude/$PLACE_NAME")" = "$T/harness" ] && ok "link --managed vuelve a ~/.tycon/harness (estado y lugar), no a versions/" || mal "link --managed: rc=$rc tree=$(estado "d['tree']") lugar → $(readlink "$LAB_HOME/.claude/$PLACE_NAME") — $out"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T5 ─────────────────────────────────────────────
if corre T5; then
  echo "T5 · Repair_LinkJournal_EveryStage — el corte en cada etapa lo repara el arranque, bootstrap.js y el respaldo en shell"
  harness_lab_create "$BASE/lab5"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  T="$(TYCON_DIR)"
  harness_lab_publish_stable 2026.10.07.2
  harness_release update --yes >/dev/null 2>&1
  V1="$T/versions/2026.10.07.1"; V2="$T/versions/2026.10.07.2"
  # una versión de juguete a medio instalar: copia de la .2 con otro número
  V9="$T/versions/2026.10.07.9"
  # (la limpieza de cada arranque la borra —ningún enlace la usa después de reparar—: se rehace antes de cada corte)
  nueve() { [ -d "$V9" ] || { cp -R "$V2" "$V9" && printf '{ "version": "2026.10.07.9", "files": [], "commit": "x", "tree": "y" }\n' > "$V9/.tycon-release.json"; }; }
  # el diario a medias de un cambio .2 → .9 en cada etapa; el disco, como queda si el corte fue justo después
  journal() { printf '{ "schema": 1, "kind": "swap", "stage": "%s", "version": "2026.10.07.9", "incoming": "%s", "dest": "%s", "harness_was": "%s", "previous_was": "%s" }\n' "$1" "$T/incoming/2026.10.07.9" "$V9" "$V2" "$V1" > "$T/link-swap.json"; }
  apunta() { rm -f "$T/$1"; ln -s "$2" "$T/$1"; }
  sano() { [ "$(destino "$T/harness")" = "$V2" ] && [ "$(destino "$T/previous")" = "$V1" ] && [ ! -e "$T/link-swap.json" ]; }
  for quien in startup bootstrap; do
    for etapa in start moved previous-pointed harness-pointed; do
      nueve; apunta harness "$V2"; apunta previous "$V1"
      case "$etapa" in
        previous-pointed) apunta previous "$V2" ;;
        harness-pointed) apunta previous "$V2"; apunta harness "$V9" ;;
      esac
      journal "$etapa"
      case "$quien" in
        startup) out="$(harness_release startup 2>&1)" ;;
        bootstrap) out="$(node "$(PROGRAM)/bootstrap.js" startup 2>&1)" ;;
      esac
      sano && ok "$quien · «${etapa}»: harness → .2 y previous → .1, entera, sin diario" || mal "$quien · «${etapa}»: harness → $(destino "$T/harness") previous → $(destino "$T/previous") diario: $( [ -e "$T/link-swap.json" ] && echo sigue || echo no) — $out"
    done
    # el hueco de Windows: harness no está (se borró la unión y no llegó a renombrarse la temporal)
    nueve; rm -f "$T/harness"; apunta previous "$V2"; ln -s "$V9" "$T/harness.tycon-new-999"; journal harness-pointed
    case "$quien" in
      startup) harness_release startup >/dev/null 2>&1 || true; out="" ;;
      bootstrap) node "$(PROGRAM)/bootstrap.js" startup >/dev/null 2>&1 ;;
    esac
    # (sin harness el comando del arranque directo no existe: lo corre la copia fija)
    [ "$quien" = startup ] && node "$(PROGRAM)/bootstrap.js" startup >/dev/null 2>&1
    sano && ok "$quien · harness ausente (el hueco de Windows): vuelve a .2" || mal "$quien · harness ausente: harness → $(destino "$T/harness") previous → $(destino "$T/previous")"
    [ ! -e "$T/harness.tycon-new-999" ] && [ ! -L "$T/harness.tycon-new-999" ] && ok "$quien · el enlace temporal que quedó se sacó" || mal "$quien · quedó el temporal harness.tycon-new-999"
  done
  grep -q "reparaci" "$(LOG)" && ok "el registro dice que reparó" || mal "el registro no dice reparación: $(tail -3 "$(LOG)")"
  # la conversión cortada: harness/ ya se movió a versions/<v> y el enlace no llegó a crearse
  rm -f "$T/harness"
  printf '{ "schema": 1, "kind": "convert", "stage": "moved", "moves": [ { "name": "%s", "dest": "%s" } ] }\n' "$T/harness" "$V2" > "$T/link-swap.json"
  node "$(PROGRAM)/bootstrap.js" startup >/dev/null 2>&1
  [ "$(destino "$T/harness")" = "$V2" ] && [ ! -e "$T/link-swap.json" ] && ok "conversión cortada: el enlace harness → la carpeta movida" || mal "conversión cortada: harness → $(destino "$T/harness")"
  # un cambio de rollback cortado («back»): harness vuelve a la de antes del rollback
  apunta harness "$V1"; apunta previous "$V2"
  printf '{ "schema": 1, "kind": "back", "why": "rollback", "stage": "harness-pointed", "harness_was": "%s", "previous_was": "%s" }\n' "$V2" "$V1" > "$T/link-swap.json"
  node "$(PROGRAM)/bootstrap.js" startup >/dev/null 2>&1
  sano && ok "un rollback cortado vuelve a la de antes (harness → .2, previous → .1)" || mal "rollback cortado: harness → $(destino "$T/harness") previous → $(destino "$T/previous")"
  # un diario ajeno que nombra rutas fuera de versions/: no se usa, nada apunta afuera, y queda para que alguien lo mire
  AFUERA="$BASE/afuera5"; mkdir -p "$AFUERA"
  printf '{ "schema": 1, "kind": "swap", "stage": "moved", "harness_was": "%s", "previous_was": null, "dest": "%s" }\n' "$AFUERA" "$AFUERA" > "$T/link-swap.json"
  node "$(PROGRAM)/bootstrap.js" startup >/dev/null 2>&1
  [ "$(destino "$T/harness")" = "$V2" ] && [ -e "$T/link-swap.json" ] && ok "un diario con rutas fuera de versions/ no se usa: harness sigue en .2 y el diario queda" || mal "diario ajeno: harness → $(destino "$T/harness"), diario $( [ -e "$T/link-swap.json" ] && echo queda || echo borrado)"
  printf '{ "schema": 1, "kind": "convert", "stage": "moved", "moves": [ { "name": "%s/otro", "dest": "%s" } ] }\n' "$BASE" "$V2" > "$T/link-swap.json"
  node "$(PROGRAM)/bootstrap.js" startup >/dev/null 2>&1
  [ ! -e "$BASE/otro" ] && [ ! -L "$BASE/otro" ] && ok "una conversión con un nombre que no es del arnés no crea ningún enlace" || mal "la conversión ajena creó $BASE/otro"
  # un diario ilegible: no se toca nada y queda
  printf 'esto no es json' > "$T/link-swap.json"
  node "$(PROGRAM)/bootstrap.js" startup >/dev/null 2>&1
  [ "$(destino "$T/harness")" = "$V2" ] && [ -e "$T/link-swap.json" ] && ok "un diario ilegible no toca nada y queda" || mal "diario ilegible: harness → $(destino "$T/harness")"
  rm -f "$T/link-swap.json"
  # un swap.json viejo se sigue reparando como hoy (con su forma de carpetas reales)
  printf '{ "schema": 1, "stage": "done", "harness": "%s", "previous": "%s" }\n' "$T/harness" "$T/previous" > "$T/swap.json"
  harness_release startup >/dev/null 2>&1
  [ ! -e "$T/swap.json" ] && ok "un swap.json viejo («done») se sigue sacando" || mal "quedó el swap.json viejo"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T6 ─────────────────────────────────────────────
if corre T6; then
  echo "T6 · OldBootstrapCopy_LeavesNewJournal — el respaldo de antes de esta story no toca link-swap.json"
  harness_lab_create "$BASE/lab6"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  T="$(TYCON_DIR)"
  harness_lab_publish_stable 2026.10.07.2
  harness_release update --yes >/dev/null 2>&1
  V1="$T/versions/2026.10.07.1"; V2="$T/versions/2026.10.07.2"
  # el respaldo en shell no cambia con esta story (decisión 2): el de la copia fija ES el de antes. Lo que se prueba es
  # que su bloque del diario (swap.json) no toca link-swap.json; en Windows, el .ps1 viejo lo prueba el ensayo (T16)
  OLD="$(PROGRAM)/bootstrap-fallback.sh"
  if [ -f "$OLD" ]; then
    rm -f "$T/harness"; ln -s "$V1" "$T/harness"   # el corte: harness quedó en la de antes del rollback a medias
    printf '{ "schema": 1, "kind": "back", "stage": "harness-pointed", "harness_was": "%s", "previous_was": "%s" }\n' "$V2" "$V1" > "$T/link-swap.json"
    bash "$OLD" >/dev/null 2>&1
    [ -e "$T/link-swap.json" ] && ok "el respaldo viejo dejó link-swap.json donde estaba" || mal "el respaldo viejo borró link-swap.json"
    [ "$(destino "$T/harness")" = "$V1" ] && ok "y no tocó los enlaces" || mal "el respaldo viejo cambió harness → $(destino "$T/harness")"
    node "$(PROGRAM)/bootstrap.js" startup >/dev/null 2>&1
    [ ! -e "$T/link-swap.json" ] && [ "$(destino "$T/harness")" = "$V2" ] && [ "$(destino "$T/previous")" = "$V1" ] && ok "el arranque nuevo lo reparó (harness → .2, previous → .1)" || mal "el arranque nuevo no reparó: harness → $(destino "$T/harness") diario $( [ -e "$T/link-swap.json" ] && echo sigue)"
  else
    mal "la copia fija no trae el respaldo en shell ($OLD)"
  fi
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T7 ─────────────────────────────────────────────
if corre T7; then
  echo "T7 · Rollback_SwapsLinks_TwiceUndoes — rollback con la activa tomada intercambia los enlaces; otro lo deshace"
  harness_lab_create "$BASE/lab7"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  T="$(TYCON_DIR)"
  out="$(harness_release rollback 2>&1)"; rc=$?
  [ "$rc" = 2 ] && case "$out" in *"install --version"*) true ;; *) false ;; esac && ok "sin previous: sale 2 y dice install --version" || mal "sin previous: rc=$rc $out"
  harness_lab_publish_stable 2026.10.07.2
  harness_release update --yes >/dev/null 2>&1
  V1="$T/versions/2026.10.07.1"; V2="$T/versions/2026.10.07.2"
  out="$(con_tomado "$V2:$V1" con_registro harness_release rollback 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "rollback con la activa tomada sale 0: $out" || mal "rollback salió $rc: $out"
  [ "$(destino "$T/harness")" = "$V1" ] && [ "$(destino "$T/previous")" = "$V2" ] && ok "harness → .1 y previous → .2 (intercambiados)" || mal "harness → $(destino "$T/harness") previous → $(destino "$T/previous")"
  [ "$(estado "d['version']['number']")" = 2026.10.07.1 ] && ok "el estado en .1" || mal "estado $(estado "d['version']['number']")"
  out="$(con_tomado "$V2:$V1" harness_release rollback 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ "$(destino "$T/harness")" = "$V2" ] && [ "$(destino "$T/previous")" = "$V1" ] && ok "un segundo rollback lo deshace" || mal "segundo rollback: rc=$rc harness → $(destino "$T/harness"): $out"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T8 ─────────────────────────────────────────────
if corre T8; then
  echo "T8 · HealthRed_BackByLink_NotRetried — salud roja: vuelve por el enlace, failed, sin reintento"
  harness_lab_create "$BASE/lab8"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  T="$(TYCON_DIR)"
  harness_lab_publish_stable 2026.10.07.2
  harness_release update --yes >/dev/null 2>&1
  harness_lab_publish_stable 2026.10.07.3 scripts/hooks/lab-hook.js 'process.exit(2);'
  out="$(con_registro harness_release update --yes 2>&1)"; rc=$?
  [ "$rc" = 1 ] && case "$out" in *"volvió sola a 2026.10.07.2"*) true ;; *) false ;; esac && ok "salud roja: sale 1 y dice que volvió sola a .2" || mal "salud roja: rc=$rc $out"
  [ "$(destino "$T/harness")" = "$T/versions/2026.10.07.2" ] && ok "harness → .2 otra vez" || mal "harness → $(destino "$T/harness")"
  [ ! -e "$T/previous" ] && [ ! -L "$T/previous" ] && ok "previous quedó sin enlace (lo roto no se guarda como anterior)" || mal "previous → $(destino "$T/previous")"
  [ -d "$T/versions/2026.10.07.3" ] && ok "la rota quedó en versions/ para la limpieza" || mal "la rota desapareció"
  [ "$(estado "d['failed']['commit']")" = 2026.10.07.3 ] && ok "failed registra la .3" || mal "failed: $(estado "d['failed']")"
  renombro_versiones && mal "se renombró una carpeta de versions/" || ok "sin mover carpetas de versions/"
  out="$(harness_release update 2>&1)"
  case "$out" in *"ya falló"*) ok "no se reintenta sola" ;; *) mal "reintentó: $out" ;; esac
  # (pase adversarial, clase 3) reinstalar esa versión con su carpeta vieja TOMADA: no se borra a medias; la nueva va al
  # lado, con sello
  printf 'un proceso la usa\n' > "$T/versions/2026.10.07.3/en-uso.txt"
  out="$(con_tomado "$T/versions/2026.10.07.3" harness install --version 2026.10.07.3 --yes 2>&1)"; rc=$?
  [ -f "$T/versions/2026.10.07.3/en-uso.txt" ] && ok "la carpeta tomada de la misma versión quedó entera" || mal "reinstalar borró la carpeta tomada: $(ls "$T/versions")"
  case "$(destino "$T/harness")" in "$T/versions/2026.10.07.3-"*) ok "la reinstalada fue al lado, con sello ($(basename "$(destino "$T/harness")"))" ;; *) mal "harness → $(destino "$T/harness") (rc $rc): $out" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T10 ────────────────────────────────────────────
if corre T10; then
  echo "T10 · Convert_OldLayout_OnceAndWhenHeld — la conversión; trabada: la versión queda, el aviso sale una vez"
  harness_lab_create "$BASE/lab10"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  # la máquina de hoy: sin la forma nueva (carpetas reales)
  harness_lab_release_fresh_home
  TYCON_RELEASE_LINKS=0 harness install --version latest --yes >/dev/null 2>&1
  harness_lab_publish_stable 2026.10.07.2
  TYCON_RELEASE_LINKS=0 harness_release update --yes >/dev/null 2>&1
  T="$(TYCON_DIR)"
  [ -d "$T/harness" ] && [ ! -L "$T/harness" ] && [ -d "$T/previous" ] && [ ! -L "$T/previous" ] && ok "la máquina de hoy: harness/ y previous/ carpetas reales" || mal "el armado no dio la forma de hoy: $(ls -la "$T" | tr '\n' ' ')"
  harness_lab_publish_stable 2026.10.07.3
  # trabada: harness/ tomada. El arranque sale 0, la versión nueva queda en versions/, la máquina sigue en .2
  python3 - "$(ESTADO)" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['last_fetch']=None; d['last_fetch_failed']=None; json.dump(d,open(p,'w'),indent=2)
PY
  out="$(con_tomado "$T/harness" harness_release startup 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "trabada: el arranque sale 0" || mal "trabada: el arranque salió $rc: $out"
  [ -d "$T/harness" ] && [ ! -L "$T/harness" ] && [ "$(estado "d['version']['number']")" = 2026.10.07.2 ] && ok "la máquina sigue en .2 (harness/ real)" || mal "estado $(estado "d['version']['number']") harness $(destino "$T/harness")"
  [ -f "$T/versions/2026.10.07.3/.tycon-release.json" ] && ok "la versión nueva no se perdió: quedó en versions/2026.10.07.3" || mal "versions/: $(ls "$T/versions" 2>&1)"
  # ajuste del dueño (2026-10-14, «molestar lo menos posible»): los primeros arranques trabados intentan en silencio
  case "$out" in *[Cc]"errá"*) mal "el primer arranque trabado ya avisa (tiene que intentar en silencio): $out" ;; *) ok "el primer arranque trabado no avisa: intenta en silencio" ;; esac
  [ "$(estado "d['failed']")" = None ] && ok "sin failed (no es una versión rota)" || mal "quedó failed: $(estado "d['failed']")"
  [ "$(estado "d['link_convert']['attempts']")" = 1 ] && ok "el estado cuenta el intento" || mal "link_convert: $(estado "d.get('link_convert')")"
  # el umbral es 3 días o 10 arranques, lo que llegue primero: con 8 intentos anotados, el noveno todavía calla; el
  # décimo avisa UNA vez
  python3 - "$(ESTADO)" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['link_convert']['attempts']=8; json.dump(d,open(p,'w'),indent=2)
PY
  out="$(con_tomado "$T/harness" harness_release startup 2>&1)"
  case "$out" in *[Cc]"errá"*) mal "al noveno arranque ya avisa (el umbral es 10): $out" ;; *) ok "al noveno arranque todavía calla" ;; esac
  out="$(con_tomado "$T/harness" harness_release startup 2>&1)"; rc=$?
  case "$out" in *"Cerrá"*"Claude Code"*"VS Code"*"update --yes"*"reinici"*) ok "al décimo arranque trabado avisa qué cerrar, el comando y reiniciar como último recurso: $out" ;; *) mal "al décimo no avisó: $out" ;; esac
  out2="$(con_tomado "$T/harness" harness_release startup 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "el arranque siguiente trabado también sale 0" || mal "arranque siguiente salió $rc"
  case "$out2" in *[Cc]"errá"*) mal "el aviso se repitió en pantalla: $out2" ;; *) ok "el aviso no se repite en pantalla" ;; esac
  # y por días: con la primera falla hace 2 días y pocos arranques, calla; hace 3 días, avisa
  dias() {
    python3 - "$(ESTADO)" "$1" <<'PY'
import json,sys,datetime; p=sys.argv[1]; d=json.load(open(p)); d['link_convert']={'since':(datetime.datetime.utcnow()-datetime.timedelta(days=int(sys.argv[2]),minutes=1)).strftime('%Y-%m-%dT%H:%M:%S.000Z'),'attempts':1}; json.dump(d,open(p,'w'),indent=2)
PY
  }
  dias 2
  out3="$(con_tomado "$T/harness" harness_release startup 2>&1)"
  case "$out3" in *[Cc]"errá"*) mal "a los 2 días ya avisa (el umbral es 3): $out3" ;; *) ok "a los 2 días todavía calla" ;; esac
  dias 3
  out3="$(con_tomado "$T/harness" harness_release startup 2>&1)"
  case "$out3" in *"Cerrá"*) ok "con la primera falla hace 3 días, avisa" ;; *) mal "a los 3 días no avisó: $out3" ;; esac
  grep -q "conversi" "$(LOG)" && ok "queda en el registro" || mal "el registro no habla de la conversión"
  d="$(harness_release doctor 2>&1)"
  case "$d" in *"conversi"*) ok "doctor la dice" ;; *) mal "doctor no la dice: $d" ;; esac
  # suelta: se convierte y aplica la que esperaba
  python3 - "$(ESTADO)" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['last_fetch']=None; d['last_fetch_failed']=None; json.dump(d,open(p,'w'),indent=2)
PY
  out="$(harness_release startup 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ -L "$T/harness" ] && [ -L "$T/previous" ] && ok "suelta: harness y previous son enlaces" || mal "suelta: rc=$rc $(ls -la "$T" | tr '\n' ' ')"
  [ "$(estado "d['version']['number']")" = 2026.10.07.3 ] && [ "$(version_en "$T/harness")" = 2026.10.07.3 ] && [ "$(version_en "$T/previous")" = 2026.10.07.2 ] && ok "y aplicó la .3 (previous en la .2)" || mal "estado $(estado "d['version']['number']") harness $(version_en "$T/harness") previous $(version_en "$T/previous")"
  d="$(harness_release doctor 2>&1)"
  case "$d" in *"conversi"*"tomada"*) mal "doctor sigue diciendo la conversión trabada: $d" ;; *) ok "doctor ya no la dice" ;; esac
  # (pase adversarial, clase 1) la conversión A MEDIAS: harness/ libre y previous/ tomada. No se actualiza hasta que las
  # dos sean enlaces (con previous todavía carpeta no habría a dónde volver), el aviso sale una vez; suelta, se completa
  harness_lab_release_fresh_home
  TYCON_RELEASE_LINKS=0 harness install --version 2026.10.07.2 --yes >/dev/null 2>&1
  TYCON_RELEASE_LINKS=0 harness_release update --yes >/dev/null 2>&1
  [ -d "$T/previous" ] && [ ! -L "$T/previous" ] || mal "la máquina a medias no tiene previous/ carpeta: $(ls -la "$T" | tr '\n' ' ')"
  harness_lab_publish_stable 2026.10.07.4
  python3 - "$(ESTADO)" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['last_fetch']=None; d['last_fetch_failed']=None; json.dump(d,open(p,'w'),indent=2)
PY
  v0="$(estado "d['version']['number']")"
  out="$(con_tomado "$T/previous" harness_release startup 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ "$(estado "d['version']['number']")" = "$v0" ] && ok "a medias: el arranque sale 0 y no cambia de versión (sigue en $v0)" || mal "a medias: rc=$rc versión $(estado "d['version']['number']") (era $v0): $out"
  case "$out" in *[Cc]"errá"*) mal "a medias: el primer arranque ya avisa (tiene que intentar en silencio): $out" ;; *) ok "a medias: el primer arranque intenta en silencio (ajuste del dueño)" ;; esac
  [ -f "$T/versions/2026.10.07.4/.tycon-release.json" ] && ok "a medias: la versión nueva quedó en versions/ (la limpieza no la borró)" || mal "a medias: la versión que espera no está: $(ls "$T/versions" 2>&1)"
  d="$(harness_release doctor 2>&1)"
  case "$d" in *"conversión a la forma con enlaces pendiente"*) ok "a medias: doctor dice la conversión pendiente" ;; *) mal "a medias: doctor no la dice: $d" ;; esac
  [ -d "$T/previous" ] && [ ! -L "$T/previous" ] && ok "a medias: previous/ sigue siendo la carpeta (nada se perdió)" || mal "a medias: previous → $(destino "$T/previous")"
  python3 - "$(ESTADO)" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['last_fetch']=None; d['last_fetch_failed']=None; json.dump(d,open(p,'w'),indent=2)
PY
  harness_release startup >/dev/null 2>&1
  [ -L "$T/harness" ] && [ -L "$T/previous" ] && [ "$(estado "d['version']['number']")" = 2026.10.07.4 ] && ok "suelta: las dos son enlaces y aplicó la .4" || mal "suelta: $(ls -la "$T" | tr '\n' ' ') versión $(estado "d['version']['number']")"
  # la conversión libre en una máquina al día (sin versión nueva): se hace igual en el arranque
  harness_lab_release_fresh_home
  TYCON_RELEASE_LINKS=0 harness install --version latest --yes >/dev/null 2>&1
  [ -d "$T/harness" ] && [ ! -L "$T/harness" ] || mal "la segunda máquina no nació en la forma de hoy"
  harness_release startup >/dev/null 2>&1
  [ -L "$T/harness" ] && [ "$(version_en "$T/harness")" = 2026.10.07.4 ] && ok "al día, el arranque igual la convierte (harness → versions/2026.10.07.4)" || mal "no convirtió: $(ls -la "$T" | tr '\n' ' ')"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T11 ────────────────────────────────────────────
if corre T11; then
  echo "T11 · Cleanup_FreeGone_HeldKept_NamedKept — la limpieza de versions/ y el aviso de los 7 días"
  harness_lab_create "$BASE/lab11"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  T="$(TYCON_DIR)"
  for i in 2 3 4 5; do harness_lab_publish_stable "2026.10.07.$i"; harness_release update --yes >/dev/null 2>&1; done
  [ "$(destino "$T/harness")" = "$T/versions/2026.10.07.5" ] && [ "$(destino "$T/previous")" = "$T/versions/2026.10.07.4" ] || mal "el armado no dio harness .5 y previous .4"
  # .1 libre · .2 tomada · .3 nombrada por settings.json. Además settings.json nombra una versión .10 (que no está): la .1
  # es PREFIJO de ese nombre y no por eso queda «nombrada» (pase adversarial, clase 4)
  python3 - "$TYCON_SETTINGS_PATH" "$T/versions/2026.10.07.3" "$T/versions/2026.10.07.10" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p))
for v in sys.argv[2:]: d.setdefault("hooks",{}).setdefault("SessionStart",[]).append({"hooks":[{"type":"command","command":"node "+v+"/scripts/hooks/lab-hook.js"}]})
json.dump(d,open(p,"w"),indent=2)
PY
  # (pase adversarial, clase 2) la misma casa escrita de otra forma (la ruta real, /private/var en vez de /var en Mac; en
  # Windows, otra caja): la activa y la anterior NO se ven libres
  REAL_T="$(cd "$T" && pwd -P)"
  if [ "$REAL_T" != "$T" ]; then
    TYCON_HOME="$REAL_T" con_tomado "$T/versions/2026.10.07.2:$REAL_T/versions/2026.10.07.2" harness_release startup >/dev/null 2>&1
    [ -f "$T/versions/2026.10.07.5/.tycon-release.json" ] && [ -f "$T/versions/2026.10.07.4/.tycon-release.json" ] && ok "con la casa escrita por su ruta real, la limpieza no tocó la activa ni la anterior" || mal "la limpieza borró una versión en uso con la casa escrita de otra forma: $(ls "$T/versions")"
  else ok "(la casa no tiene otra escritura en esta máquina: el caso no se puede armar)"; fi
  out="$(con_tomado "$T/versions/2026.10.07.2" harness_release startup 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "el arranque sale 0" || mal "el arranque salió $rc: $out"
  [ ! -e "$T/versions/2026.10.07.1" ] && ok "la .1 (libre) se borró" || mal "la .1 sigue"
  [ -d "$T/versions/2026.10.07.2" ] && [ -f "$T/versions/2026.10.07.2/.tycon-release.json" ] && ok "la .2 (tomada) quedó entera" || mal "la .2 no quedó entera"
  [ -d "$T/versions/2026.10.07.3" ] && ok "la .3 (nombrada) no se tocó" || mal "se borró la nombrada"
  [ -d "$T/versions/2026.10.07.4" ] && [ -d "$T/versions/2026.10.07.5" ] && ok "la activa y la anterior siguen" || mal "falta la activa o la anterior"
  case "$out" in *"7 días"*|*[Cc]"errá"*) mal "el aviso salió con una pendiente de hoy: $out" ;; *) ok "con una pendiente de hoy no hay aviso en pantalla" ;; esac
  d="$(harness_release doctor 2>&1)"
  case "$d" in *"pendiente de limpiar"*"2026.10.07.2"*) ok "doctor lista la pendiente" ;; *) mal "doctor no la lista: $d" ;; esac
  case "$d" in *"0 día"*|*"hoy"*) ok "con su edad" ;; *) mal "doctor no dice la edad: $d" ;; esac
  case "$d" in *"no se borra"*"2026.10.07.3"*"settings.json"*) ok "doctor lista también la nombrada, con quién la nombra" ;; *) mal "doctor no lista la nombrada: $d" ;; esac
  grep -q "$T/versions" "$(ESTADO)" && mal "el estado nombra versions/ (decisión 8): $(grep -o "$T/versions[^\"]*" "$(ESTADO)" | head -2)" || ok "el estado guarda lo pendiente por el número de versión, sin nombrar versions/"
  # la pendiente lleva 6 días: todavía sin aviso; con 7, el arranque avisa qué cerrar
  envejece() {
    python3 - "$(ESTADO)" "2026.10.07.2" "$1" <<'PY'
import json,sys,datetime; p=sys.argv[1]; d=json.load(open(p)); old=(datetime.datetime.utcnow()-datetime.timedelta(days=int(sys.argv[3]), minutes=1)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
pend=d.get('link_pending') or {}
assert sys.argv[2] in pend, 'el estado no registra la pendiente en link_pending'
pend[sys.argv[2]]=old; d['link_pending']=pend; json.dump(d,open(p,'w'),indent=2)
PY
  }
  envejece 6
  out="$(con_tomado "$T/versions/2026.10.07.2" harness_release startup 2>&1)"
  case "$out" in *[Cc]"errá"*) mal "con 6 días ya avisa: $out" ;; *) ok "con 6 días, sin aviso en pantalla" ;; esac
  envejece 7
  out="$(con_tomado "$T/versions/2026.10.07.2" harness_release startup 2>&1)"; rc=$?
  case "$out" in *[Cc]"errá"*"2026.10.07.2"*|*"2026.10.07.2"*[Cc]"errá"*) ok "con 7 días, el arranque avisa qué cerrar: $out" ;; *) mal "con 7 días no avisa: $out" ;; esac
  # suelta, se borra y el aviso se va
  out="$(harness_release startup 2>&1)"
  [ ! -e "$T/versions/2026.10.07.2" ] && ok "suelta, se borró" || mal "suelta, la .2 sigue"
  case "$out" in *[Cc]"errá"*) mal "el aviso siguió: $out" ;; *) ok "y el aviso se fue" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T12 ────────────────────────────────────────────
if corre T12; then
  echo "T12 · InstallAndMigrate_BornInNewLayout — install en una casa vacía nace en la forma nueva"
  harness_lab_create "$BASE/lab12"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  T="$(TYCON_DIR)"
  [ "$INSTALL_RC" = 0 ] && [ -L "$T/harness" ] && [ -d "$T/versions/2026.10.07.1" ] && ok "install nació con harness enlace a versions/2026.10.07.1" || mal "install: rc=$INSTALL_RC $(ls -la "$T" | tr '\n' ' ')"
  [ "$(cd "$LAB_HOME/.claude/$PLACE_NAME" && pwd -P)" = "$(cd "$T/versions/2026.10.07.1" && pwd -P)" ] && ok "el lugar de ~/.claude lleva a la versión (por ~/.tycon/harness)" || mal "el lugar no lleva a la versión"
  out="$(harness_release doctor 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "doctor sale 0" || mal "doctor salió $rc: $out"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  # la mudanza (migrate --to-home) también nace en la forma con enlaces: su suite, con la variable, lo asserta (T28)
  mh="$(bash "$RAIZ/scripts/tests/harness-move-home.test.sh" --only T28 < /dev/null 2>&1)"; rc=$?
  [ "$rc" = 0 ] && case "$mh" in *"es un enlace a versions/"*) true ;; *) false ;; esac && ok "migrate --to-home deja ~/.tycon/harness como enlace a versions/ (harness-move-home T28 con la variable)" || mal "la mudanza con enlaces: rc=$rc — $(printf '%s\n' "$mh" | grep -E 'MAL|bad|❌' | head -3)"
fi

# ───────────────────────────────────────────── T13 ────────────────────────────────────────────
if corre T13; then
  echo "T13 · Uninstall_LinksAndVersions_NeverThroughLink — uninstall quita enlaces y versions/ sin borrar a través de un enlace"
  harness_lab_create "$BASE/lab13"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  T="$(TYCON_DIR)"
  harness_lab_publish_stable 2026.10.07.2
  harness_release update --yes >/dev/null 2>&1
  FUERA="$BASE/fuera-de-tycon"; mkdir -p "$FUERA"; printf 'no me borres\n' > "$FUERA/marcador.txt"
  rm -f "$T/previous"; ln -s "$FUERA" "$T/previous"
  harness_release config set github.token < /dev/null >/dev/null 2>&1 || true
  printf '{ "github": { "token": "lab" } }\n' > "$T/config.json"
  out="$(harness_release uninstall --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "uninstall sale 0" || mal "uninstall salió $rc: $out"
  [ ! -e "$T/harness" ] && [ ! -L "$T/harness" ] && [ ! -e "$T/previous" ] && [ ! -L "$T/previous" ] && ok "los dos enlaces se quitaron" || mal "quedan enlaces: $(ls -la "$T" 2>&1 | tr '\n' ' ')"
  [ ! -e "$T/versions" ] && ok "versions/ se quitó" || mal "versions/ sigue: $(ls "$T/versions")"
  [ -f "$FUERA/marcador.txt" ] && ok "el marcador fuera de ~/.tycon al que apuntaba previous quedó intacto" || mal "se borró a través del enlace: falta $FUERA/marcador.txt"
  [ -f "$T/config.json" ] && ok "config.json se conserva, como hoy" || mal "se borró config.json"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T14 ────────────────────────────────────────────
if corre T14; then
  echo "T14 · Doctor_LinksAndPending — doctor dice dónde apunta cada enlace"
  harness_lab_create "$BASE/lab14"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala latest
  T="$(TYCON_DIR)"
  harness_lab_publish_stable 2026.10.07.2
  harness_release update --yes >/dev/null 2>&1
  out="$(harness_release doctor 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "doctor sale 0" || mal "doctor salió $rc: $out"
  case "$out" in *"$T/harness → $T/versions/2026.10.07.2"*) ok "dice harness → versions/2026.10.07.2" ;; *) mal "no dice a dónde apunta harness: $out" ;; esac
  case "$out" in *"$T/previous → $T/versions/2026.10.07.1"*) ok "dice previous → versions/2026.10.07.1" ;; *) mal "no dice a dónde apunta previous: $out" ;; esac
  out="$(harness_release doctor --json 2>&1)"
  python3 -c "import json,sys; d=json.loads(sys.argv[1]); assert not d['fail'], d['fail']" "$out" 2>/dev/null && ok "doctor --json sin fallos" || mal "doctor --json: $out"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T15 ────────────────────────────────────────────
if corre T15; then
  echo "T15 · Posix_Unchanged — sin la variable (Mac y Linux de verdad) no aparece nada de la forma con enlaces"
  harness_lab_create "$BASE/lab15"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  harness_lab_release_fresh_home
  TYCON_RELEASE_LINKS=0 harness install --version latest --yes >/dev/null 2>&1
  harness_lab_publish_stable 2026.10.07.2
  TYCON_RELEASE_LINKS=0 harness_release update --yes >/dev/null 2>&1
  TYCON_RELEASE_LINKS=0 harness_release rollback >/dev/null 2>&1
  TYCON_RELEASE_LINKS=0 harness_release startup >/dev/null 2>&1
  T="$(TYCON_DIR)"
  [ -d "$T/harness" ] && [ ! -L "$T/harness" ] && [ -d "$T/previous" ] && [ ! -L "$T/previous" ] && ok "harness/ y previous/ siguen siendo carpetas" || mal "la forma cambió: $(ls -la "$T" | tr '\n' ' ')"
  [ ! -e "$T/versions" ] && [ ! -e "$T/link-swap.json" ] && ok "ni versions/ ni link-swap.json" || mal "apareció versions/ o link-swap.json: $(ls "$T")"
  out="$(TYCON_RELEASE_LINKS=0 harness_release doctor 2>&1)"
  case "$out" in *"enlaces:"*) mal "doctor habla de enlaces sin la forma: $out" ;; *) ok "doctor no dice nada de enlaces" ;; esac
  case "$(cat "$(ESTADO)")" in *link_pending*|*link_convert*|*link_named*) mal "el estado trae campos de la forma con enlaces" ;; *) ok "el estado no trae campos nuevos" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

if [ "$FALLOS" = 0 ]; then echo "✅ harness-release-links: todo en verde"; exit 0; fi
echo "❌ harness-release-links: $FALLOS fallo(s)"
exit 1
