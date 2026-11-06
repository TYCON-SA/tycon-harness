#!/usr/bin/env bash
# harness-failures.test.sh — la instalación cuando algo falla: cortes a la mitad con `kill -9` y dos a la vez.
#
# Lo que no se puede perder:
#   T6  · Update_KilledWhileWriting_StartupNamesOpenCopy: con el aplicador REAL y el arnés ya instalado, `harness.js
#         apply` se corta con `kill -9` al grupo entero entre `settings.json` y los bloques del CLAUDE.md. El arranque
#         siguiente nombra la copia abierta y da `harness.js rollback --to <copia>`, «por piezas».
#   T7  · Rollback_KilledMidway_RerunFinishes: una vuelta atrás se corta con `kill -9` en su primer `git reset`. El arranque
#         siguiente dice «una vuelta atrás se cortó» y da `rollback --to <rollback_to>`, nunca la `before-rollback`; ese
#         comando termina: árboles en los commits de la copia destino, la copia destino en su carpeta, la
#         `before-rollback` del intento cortado cerrada.
#   T8  · TwoInstalls_OneApplies_OtherLeaves3: dos `harness.js install` a la vez, el primero retenido adentro del candado
#         (su aplicador duerme) hasta que el segundo sale con 3 «otra sesión está actualizando». El primero aplica una
#         sola vez; el estado y `settings.json` quedan coherentes.
#   T10 · ExistingSuites_StillGreen: T3 y T39L de harness-update, T23 y T24 de harness-rollback, T9 de harness-install y
#         el candado de `run-check` (marker-run-check.test.js) siguen en verde.
#
# Los cortes se eligen desde AFUERA, con testigos en el PATH del laboratorio: nunca un gancho de prueba en el aplicador.
# El `kill -9` va al grupo de procesos entero (con `set -m`; macOS no trae `setsid`): si muriera sólo harness.js, el
# aplicador huérfano seguiría escribiendo mientras el arranque siguiente pisa el candado. Toda espera tiene tope y dice
# qué esperaba si vence.
#
# Corren el instalador de verdad en un laboratorio: pesan como las suites portables (varios minutos).
#
# Uso: bash scripts/tests/harness-failures.test.sh [--only T6|T7|T8|T10]
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
export TYCON_STARTUP_DETACH=0
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
BASE="$(mktemp -d "${TMPDIR:-/tmp}/harness-failures.XXXXXX")"
node "$RAIZ/scripts/tests/lib/lab-guard.js" "$BASE" harness-failures || exit 1
GRUPOS=""   # los grupos de procesos que lanzó esta prueba: se matan al salir (sólo los propios, por su número)
trap 'for g in $GRUPOS; do kill -9 -- "-$g" 2>/dev/null; done; rm -rf "$BASE"' EXIT
REAL_GIT="$(command -v git)"; REAL_PY="$(command -v python3)"

j() { "$REAL_PY" -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
estado() { j "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" "$1"; }
estado_set() { "$REAL_PY" -c "import json,sys; p=sys.argv[1]; d=json.load(open(p, encoding='utf-8')); $1; json.dump(d, open(p,'w', encoding='utf-8'), indent=2)" "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"; }
head_de() { harness_lab_git "$1" rev-parse HEAD; }
COPIAS() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness/backups"; }
LOCK() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness/harness.lock"; }
# las copias abiertas, de la más nueva a la más vieja: «nombre reason rollback_to»
abiertas() {
  "$REAL_PY" - "$(COPIAS)" <<'PY'
import json, os, sys
root = sys.argv[1]
rows = []
for n in (os.listdir(root) if os.path.isdir(root) else []):
    try: m = json.load(open(os.path.join(root, n, "manifest.json"), encoding="utf-8"))
    except Exception: continue
    if m.get("open") is True: rows.append((m.get("seq") or 0, n, m.get("reason") or "-", m.get("rollback_to") or "-"))
for r in sorted(rows, reverse=True): print(" ".join(str(x) for x in r[1:]))
PY
}
campo() { j "$(COPIAS)/$1/manifest.json" "d.get('$2')"; }
# espera_archivo <archivo> <segundos>: 0 si apareció a tiempo
espera_archivo() { local n=0 tope=$(( $2 * 5 )); while [ ! -e "$1" ] && [ "$n" -lt "$tope" ]; do sleep 0.2; n=$((n + 1)); done; [ -e "$1" ]; }
# corta <pgid>: kill -9 al grupo entero, y espera a que no quede ninguno
corta() { kill -9 -- "-$1" 2>/dev/null; local n=0; while kill -0 -- "-$1" 2>/dev/null && [ "$n" -lt 50 ]; do sleep 0.2; n=$((n + 1)); done; }

# ═══ T8 · TwoInstalls_OneApplies_OtherLeaves3 ═══════════════════════════════════════════════════════════════════════
if corre T8; then
  harness_lab_create "$BASE/t8" >/dev/null
  set -m
  ( LAB_APPLIER_SLEEP=6 harness install --yes > "$BASE/t8/a.out" 2>&1; echo $? > "$BASE/t8/a.rc" ) &
  PRIMERO=$!; GRUPOS="$GRUPOS $PRIMERO"
  set +m
  # el primero tiene el candado y su aplicador duerme adentro: recién ahí arranca el segundo
  if espera_archivo "$(LOCK)" 30; then
    harness install --yes > "$BASE/t8/b.out" 2>&1; RCB=$?
    espera_archivo "$BASE/t8/a.rc" 120 || mal "T8 el primer install no terminó en 120 s: $(tail -3 "$BASE/t8/a.out")"
    RCA="$(cat "$BASE/t8/a.rc" 2>/dev/null)"
    [ "$RCB" = 3 ] && grep -q 'otra sesión está actualizando' "$BASE/t8/b.out" \
      && ok "T8 el segundo install sale 3 con «otra sesión está actualizando»" || mal "T8 el segundo install: rc $RCB: $(cat "$BASE/t8/b.out")"
    [ "$RCA" = 0 ] && ok "T8 el primero aplica y sale 0" || mal "T8 el primero salió ${RCA:-—}: $(tail -5 "$BASE/t8/a.out")"
    CORRIDAS="$(grep -c -v -- '--check' "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>/dev/null)"
    [ "$CORRIDAS" = 1 ] && ok "T8 el aplicador corrió una sola vez (sin --check)" || mal "T8 el aplicador corrió $CORRIDAS veces: $(cat "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>&1)"
    [ "$(estado "d['mode']")" = managed ] && [ "$(harness_lab_settings_commands | grep -c 'lab-hook.js')" = 1 ] \
      && ok "T8 estado y settings.json coherentes (managed, el hook una vez)" || mal "T8 estado $(estado "d.get('mode')"), hooks $(harness_lab_settings_commands | grep -c 'lab-hook.js')"
    [ ! -d "$(LOCK)" ] && ok "T8 sin candado colgado" || mal "T8 quedó el candado"
  else mal "T8 el primer install no tomó el candado en 30 s: $(cat "$BASE/t8/a.out")"; fi
fi

# ═══ T7 · Rollback_KilledMidway_RerunFinishes ═══════════════════════════════════════════════════════════════════════
if corre T7; then
  export TYCON_UPDATE_APPLY=auto
  harness_lab_create "$BASE/t7" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T7 install de v1 falló"
  T1="$(head_de "$LAB_TREE")"; S1="$(head_de "$LAB_SKILLS")"
  harness_lab_publish_hook PreToolUse 'tycon-pipeline/lab-rollback.js' 'process.exit(0);'
  harness_lab_publish_block 'lab-v2'
  T2="$(head_de "$LAB_AUTHOR_TREE")"
  estado_set "d['last_fetch']=None"
  harness startup >/dev/null 2>&1
  [ "$(head_de "$LAB_TREE")" = "$T2" ] || mal "T7 el arranque no aplicó v2: $(head_de "$LAB_TREE") vs $T2"
  # el testigo: frena el primer `git reset` (lo primero que escribe la vuelta atrás en los árboles)
  mkdir -p "$BASE/t7/bin"; SENAL="$BASE/t7/git-reset.llego"
  cat > "$BASE/t7/bin/git" <<SH
#!/bin/sh
case " \$* " in *" reset "*) : > "$SENAL"; exec sleep 120 ;; esac
exec "$REAL_GIT" "\$@"
SH
  chmod +x "$BASE/t7/bin/git"
  set -m
  ( PATH="$BASE/t7/bin:$PATH" harness rollback > "$BASE/t7/r1.out" 2>&1 ) &
  CORTADO=$!; GRUPOS="$GRUPOS $CORTADO"
  set +m
  if espera_archivo "$SENAL" 60; then
    corta "$CORTADO"
    BR="$(abiertas | awk '$2=="before-rollback" {print $1; exit}')"
    DESTINO="$(abiertas | awk '$2=="before-rollback" {print $3; exit}')"
    [ -n "$BR" ] && [ "$DESTINO" != "-" ] && ok "T7 cortada: queda la before-rollback abierta ($BR) con su destino ($DESTINO)" || mal "T7 copias abiertas tras el corte: $(abiertas | tr '\n' ';')"
    [ -d "$(COPIAS)/$DESTINO" ] && ok "T7 la copia destino sigue en su carpeta" || mal "T7 no está la copia destino $DESTINO"
    harness startup >/dev/null 2>&1
    AVISO="$(estado "d.get('notice') or ''")"
    case "$AVISO" in *"una vuelta atrás se cortó"*"rollback --to $DESTINO"*) ok "T7 el arranque dice «una vuelta atrás se cortó» y da rollback --to $DESTINO" ;;
      *) mal "T7 aviso del arranque: «${AVISO}»" ;; esac
    case "$AVISO" in *"--to $BR"*) mal "T7 el aviso manda a volver a la before-rollback ($BR)" ;; *) ok "T7 el aviso nunca manda a la before-rollback" ;; esac
    SALIDA="$(harness rollback --to "$DESTINO" 2>&1)"; RC=$?
    [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$T1" ] && [ "$(head_de "$LAB_SKILLS")" = "$S1" ] \
      && ok "T7 el comando del aviso termina la vuelta atrás: árboles en v1" || mal "T7 rollback --to $DESTINO: rc $RC, tree $(head_de "$LAB_TREE") (v1 $T1): $SALIDA"
    [ -d "$(COPIAS)/$DESTINO" ] && ok "T7 la copia destino sigue después de volver" || mal "T7 se perdió la copia destino"
    [ "$(campo "$BR" open)" = False ] && [ "$(campo "$BR" closed_by)" = rollback ] \
      && ok "T7 la before-rollback del intento cortado quedó cerrada por la vuelta atrás" || mal "T7 la before-rollback $BR: open=$(campo "$BR" open) closed_by=$(campo "$BR" closed_by)"
    harness startup >/dev/null 2>&1
    case "$(estado "d.get('notice') or ''")" in *"a medias:"*) mal "T7 el aviso del corte sigue después de terminar: $(estado "d.get('notice')")" ;; *) ok "T7 terminada la vuelta atrás, el aviso del corte no vuelve" ;; esac
  else mal "T7 la vuelta atrás no llegó al git reset en 60 s: $(cat "$BASE/t7/r1.out")"; corta "$CORTADO"; fi
  unset TYCON_UPDATE_APPLY
fi

# ═══ T6 · Update_KilledWhileWriting_StartupNamesOpenCopy ════════════════════════════════════════════════════════════
if corre T6; then
  harness_lab_create "$BASE/t6" >/dev/null
  # el molde de T9 de harness-install.test.sh: un clon «existente» con los archivos de trabajo encima, y el aplicador real
  T6_ORIGIN="$BASE/t6-origin"
  harness_lab_git "$BASE" clone -q --shared "$RAIZ" "$T6_ORIGIN" >/dev/null 2>&1
  harness_lab_git "$T6_ORIGIN" checkout -q -B main >/dev/null 2>&1
  DEV="$BASE/t6/clones/dev"; mkdir -p "$(dirname "$DEV")"
  harness_lab_git "$(dirname "$DEV")" clone -q --shared "$T6_ORIGIN" "$DEV" >/dev/null 2>&1
  harness_lab_git "$DEV" checkout -q -B main >/dev/null 2>&1
  for p in scripts/setup scripts/lib scripts/hooks scripts/install-tycon-hooks.sh scripts/install-tycon-hooks.ps1 scripts/publishing claude-md-blocks; do
    [ -e "$RAIZ/$p" ] && { rm -rf "$DEV/$p"; cp -R "$RAIZ/$p" "$DEV/$p"; }
  done
  rm -f "$LAB_HOME/.claude/tycon-claude-guides"; ln -s "$DEV" "$LAB_HOME/.claude/tycon-claude-guides"
  harness_lab_old_line canonical
  # todo lo que sale a la red o a la máquina, apagado; los bloques del CLAUDE.md, PRENDIDOS (el corte es antes de ellos)
  AISLADO=(env TYCON_NO_CANONICAL_PATH=1 TYCON_NO_AZ_PROJECTS_REFRESH=1 TYCON_NO_BOOTSTRAP_HEAL=1
    TYCON_NO_COMMANDS_SYNC=1 TYCON_NO_ENGRAM_PROJECT_CHECK=1 TYCON_NO_ENGRAM_VERSION_CHECK=1 TYCON_NO_GIT_HOOKS=1
    TYCON_NO_SQLITE_CHECK=1 TYCON_NO_AGENTSMD_POINTER=1 TYCON_NO_THREAD_RESCUE=1 TYCON_NO_UPLOAD_RUNS=1 TYCON_NO_DOWNLOAD_RUNS=1
    TYCON_NO_COLLECT_FINDINGS=1 TYCON_MAILBOX_URL_BASE=http://127.0.0.1:9 TYCON_THIRD_PARTY=0)
  SALIDA="$("${AISLADO[@]}" bash "$DEV/scripts/install-tycon-hooks.sh" 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -f "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" ] && ok "T6 el arnés quedó instalado con el aplicador real" \
    || mal "T6 la instalación previa falló (rc $RC): $(printf '%s' "$SALIDA" | tail -5)"
  # un cambio a mano: la copia del apply es nueva (sin «después»), no la reusada
  "$REAL_PY" - "$TYCON_SETTINGS_PATH" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p, encoding="utf-8"))
s.setdefault("permissions", {}).setdefault("allow", []).append("Bash(lab-t6:*)")
open(p, "w", encoding="utf-8").write(json.dumps(s, indent=2, ensure_ascii=False) + "\n")
PY
  # el testigo: pasa todo al python3 real; la llamada de los bloques (`python3 - <bloques> <destino> 0 …/tycon-config.js`)
  # deja la señal y espera ANTES de pasarla: settings.json ya está escrito y los bloques todavía no
  mkdir -p "$BASE/t6/bin"; SENAL="$BASE/t6/bloques.llego"
  cat > "$BASE/t6/bin/python3" <<SH
#!/bin/sh
if [ "\${1:-}" = "-" ] && [ "\${4:-}" = "0" ]; then
  case "\${5:-}" in */tycon-config.js) : > "$SENAL"; sleep 120 ;; esac
fi
exec "$REAL_PY" "\$@"
SH
  chmod +x "$BASE/t6/bin/python3"
  set -m
  ( PATH="$BASE/t6/bin:$PATH" "${AISLADO[@]}" node "$DEV/scripts/setup/harness.js" apply > "$BASE/t6/apply.out" 2>&1 ) &
  CORTADO=$!; GRUPOS="$GRUPOS $CORTADO"
  set +m
  if espera_archivo "$SENAL" 180; then
    corta "$CORTADO"
    COPIA="$(abiertas | awk '{print $1; exit}')"
    [ -n "$COPIA" ] && ok "T6 cortado entre settings.json y los bloques: queda la copia abierta $COPIA" || mal "T6 no quedó ninguna copia abierta: $(ls "$(COPIAS)" 2>&1)"
    [ -d "$(LOCK)" ] && ok "T6 …y el candado del muerto (el corte de verdad)" || mal "T6 el corte no dejó el candado: la prueba no reproduce el caso"
    SALIDA="$("${AISLADO[@]}" node "$DEV/scripts/setup/harness.js" startup 2>&1)"; RC=$?
    AVISO="$(estado "d.get('notice') or ''")"
    case "$AVISO" in *"a medias:"*"rollback --to $COPIA"*"por piezas"*) ok "T6 el arranque siguiente nombra la copia, da rollback --to $COPIA y dice «por piezas»" ;;
      *) mal "T6 aviso del arranque (rc $RC): «${AVISO}» — $(printf '%s' "$SALIDA" | tail -3)" ;; esac
    grep -q "candado: era del pid" "$LAB_HOME/.claude/.tycon-pipeline/harness/startup.log" 2>/dev/null \
      && ok "T6 el registro dice que pisó el candado del muerto" || mal "T6 el registro no dice qué candado pisó: $(tail -3 "$LAB_HOME/.claude/.tycon-pipeline/harness/startup.log" 2>&1)"
  else mal "T6 el aplicador no llegó a los bloques en 180 s: $(tail -5 "$BASE/t6/apply.out")"; corta "$CORTADO"; fi
fi

# ═══ T10 · ExistingSuites_StillGreen ════════════════════════════════════════════════════════════════════════════════
if corre T10; then
  sub() { # sub <etiqueta> <comando…>
    local etiqueta="$1"; shift
    if "$@" > "$BASE/t10.out" 2>&1; then ok "T10 $etiqueta en verde"; else mal "T10 $etiqueta en rojo: $(grep -E 'MAL|not ok|✖' "$BASE/t10.out" | head -3)"; fi
  }
  sub "harness-update T3" bash "$RAIZ/scripts/tests/harness-update.test.sh" --only T3
  sub "harness-update T39L" bash "$RAIZ/scripts/tests/harness-update.test.sh" --only T39L
  sub "harness-rollback T23" bash "$RAIZ/scripts/tests/harness-rollback.test.sh" --only T23
  sub "harness-rollback T24" bash "$RAIZ/scripts/tests/harness-rollback.test.sh" --only T24
  sub "harness-install T9" bash "$RAIZ/scripts/tests/harness-install.test.sh" --only T9
  sub "marker-run-check (el candado de run-check)" node --test "$RAIZ/skills/tycon-pipeline/scripts/tests/marker-run-check.test.js"
fi

if [ "$FALLOS" = 0 ]; then echo "✅ harness-failures: todo verde"; exit 0; fi
echo "❌ harness-failures: $FALLOS fallo(s)"; exit 1
