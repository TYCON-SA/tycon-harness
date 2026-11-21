#!/usr/bin/env bash
# harness-failures.test.sh — la instalación cuando algo se corta: las copias de respaldo que quedan abiertas.
#
# Lo que no se puede perder:
#   T2  · Update_KilledWhileWriting_StartupNamesOpenCopy: con el aplicador REAL y el arnés ya instalado, `harness.js
#         apply` se corta con `kill -9` al grupo entero entre `settings.json` y los bloques del CLAUDE.md (la mezcla se
#         comprueba). El arranque siguiente nombra la copia abierta, da `harness.js rollback --to <copia>` y dice «por
#         piezas».
#   T3  · Rollback_KilledMidway_RerunFinishes: una vuelta atrás se corta con `kill -9` DESPUÉS del primer comando de git
#         que escribe un árbol (variante: después del último). Queda a medias; el arranque dice «una vuelta atrás se
#         cortó» con `rollback --to <rollback_to>`, nunca la `before-rollback`; el comando del aviso y el mismo comando
#         sin `--to` la terminan: árboles en los commits de la copia destino, la destino en su carpeta, la
#         `before-rollback` cerrada.
#   T4  · TwoInstalls_OneApplies_OtherLeaves3: dos `harness.js install` a la vez, el primero retenido adentro del candado
#         (su aplicador duerme) hasta que el segundo sale con 3. Aplica una sola vez, sin candado colgado ni copias
#         abiertas.
#   T5  · ExistingSuites_StillGreen: T3 y T39L de harness-update, T23 y T24 de harness-rollback, T9 de harness-install y
#         el candado de `run-check` siguen en verde.
#   T9  · HarnessFailedPaths_CloseAsFailed_KeepOlderOpen: con una copia abierta vieja de un corte, cada operación que
#         falla deja la suya «failed» y la vieja abierta, con su aviso.
#   T10 · Startup_AfterCut_ClearsNotice_StaysGone: después de un corte, el arranque sano cierra la copia cortada y el
#         aviso se va de `state.notice` y no vuelve (tampoco por `keepFromLastLook`); igual con `rollback --to`.
#   T11 · SuccessfulOps_CloseOlderOnlyWhenRewroteAll: sólo la operación que reescribió todo cierra la copia de un corte.
#   T12 · FixedCopy_RefreshedAfterHealthyUpdate: la copia fija trae el código nuevo y su `rollback` cierra la copia.
#   T13 · ReleaseMachine_Cut_StartupNamesOpenCopy: en una máquina con versión bajada, el arranque también avisa.
#
# Los cortes se eligen desde AFUERA, con testigos en el PATH del laboratorio o con el aplicador de juguete dormido:
# nunca un gancho de prueba en el aplicador. El `kill -9` va al grupo de procesos entero (con `set -m`; macOS no trae
# `setsid`): si muriera sólo harness.js, el aplicador huérfano seguiría escribiendo mientras el arranque siguiente pisa
# el candado. Toda espera tiene tope y dice qué esperaba si vence.
#
# Corren el instalador de verdad en un laboratorio: pesan como las suites portables (varios minutos).
#
# Uso: bash scripts/tests/harness-failures.test.sh [--only T2|T3|T4|T5|T9|T10|T11|T12|T13]
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
export TYCON_STARTUP_DETACH=0
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0; NO_MEDIDOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
no_medido() { echo "  ⏭   — $1 NO MEDIDO: $2"; NO_MEDIDOS=$((NO_MEDIDOS+1)); }
BASE="$(mktemp -d "${TMPDIR:-/tmp}/harness-failures.XXXXXX")"
node "$RAIZ/scripts/tests/lib/lab-guard.js" "$BASE" harness-failures || exit 1
GRUPOS=""   # los grupos de procesos que lanzó esta prueba: se matan al salir (sólo los propios, por su número)
trap 'for g in $GRUPOS; do kill -9 -- "-$g" 2>/dev/null; done; chmod -R u+w "$BASE" 2>/dev/null; rm -rf "$BASE"' EXIT
REAL_GIT="$(command -v git)"; REAL_PY="$(command -v python3)"

j() { "$REAL_PY" -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
ESTADO() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"; }
estado() { j "$(ESTADO)" "$1"; }
estado_set() { "$REAL_PY" -c "import json,sys; p=sys.argv[1]; d=json.load(open(p, encoding='utf-8')); $1; json.dump(d, open(p,'w', encoding='utf-8'), indent=2)" "$(ESTADO)"; }
aviso() { estado "d.get('notice') or ''"; }
head_de() { harness_lab_git "$1" rev-parse HEAD; }
COPIAS() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness/backups"; }
LOCK() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness/harness.lock"; }
# las copias, de la más nueva a la más vieja: «nombre reason open closed_by rollback_to»
copias() {
  "$REAL_PY" - "$(COPIAS)" <<'PY'
import json, os, sys
root = sys.argv[1]
rows = []
for n in (os.listdir(root) if os.path.isdir(root) else []):
    try: m = json.load(open(os.path.join(root, n, "manifest.json"), encoding="utf-8"))
    except Exception: continue
    rows.append((m.get("seq") or 0, n, m.get("reason") or "-", "open" if m.get("open") is True else "closed", m.get("closed_by") or "-", m.get("rollback_to") or "-"))
for r in sorted(rows, reverse=True): print(" ".join(str(x) for x in r[1:]))
PY
}
# las copias abiertas, de la más nueva a la más vieja: «nombre reason rollback_to»
abiertas() { copias | awk '$3=="open" {print $1, $2, $5}'; }
campo() { j "$(COPIAS)/$1/manifest.json" "d.get('$2')"; }
abierta() { [ "$(campo "$1" open)" = True ]; }
# espera_archivo <archivo> <segundos>: 0 si apareció a tiempo
espera_archivo() { local n=0 tope=$(( $2 * 5 )); while [ ! -e "$1" ] && [ "$n" -lt "$tope" ]; do sleep 0.2; n=$((n + 1)); done; [ -e "$1" ]; }
# corta <pgid>: kill -9 al grupo entero, y espera a que no quede ninguno
corta() { kill -9 -- "-$1" 2>/dev/null; local n=0; while kill -0 -- "-$1" 2>/dev/null && [ "$n" -lt 50 ]; do sleep 0.2; n=$((n + 1)); done; }
# un laboratorio con el arnés instalado y sano (el aplicador de juguete)
instalado() { harness_lab_create "$1" >/dev/null; harness install --yes >/dev/null 2>&1; }
# corte_apply <etiqueta>: un `harness.js apply` cortado con `kill -9` mientras su aplicador de juguete duerme adentro del
# candado. Deja en CORTADA el nombre de su copia, abierta (o vacío si el corte no dejó ninguna).
CORTADA=""
corte_apply() {
  local et="$1" antes
  antes="$(abiertas | awk '{print $1}' | tr '\n' ' ')"
  set -m
  ( LAB_APPLIER_SLEEP=60 harness apply > "$LAB/$et-apply.out" 2>&1 ) &
  local pg=$!; GRUPOS="$GRUPOS $pg"
  set +m
  # el aplicador ya duerme cuando su línea llegó al registro del aplicador de juguete
  local n=0; while ! grep -q -v -- '--check' "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>/dev/null && [ "$n" -lt 150 ]; do sleep 0.2; n=$((n + 1)); done
  local total; total="$(grep -c -v -- '--check' "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>/dev/null)"
  n=0; while [ "$(grep -c -v -- '--check' "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>/dev/null)" = "$total" ] && [ "$n" -lt 150 ] && [ -z "$(abiertas | awk -v a=" $antes " 'index(a, " " $1 " ")==0 {print $1}')" ]; do sleep 0.2; n=$((n + 1)); done
  sleep 1
  corta "$pg"
  CORTADA="$(abiertas | awk -v a=" $antes " 'index(a, " " $1 " ")==0 {print $1; exit}')"
}

# ═══ T4 · TwoInstalls_OneApplies_OtherLeaves3 ═══════════════════════════════════════════════════════════════════════
if corre T4; then
  harness_lab_create "$BASE/t4" >/dev/null
  set -m
  ( LAB_APPLIER_SLEEP=6 harness install --yes > "$BASE/t4/a.out" 2>&1; echo $? > "$BASE/t4/a.rc" ) &
  PRIMERO=$!; GRUPOS="$GRUPOS $PRIMERO"
  set +m
  # el primero tiene el candado y su aplicador duerme adentro: recién ahí arranca el segundo
  if espera_archivo "$(LOCK)" 30; then
    harness install --yes > "$BASE/t4/b.out" 2>&1; RCB=$?
    espera_archivo "$BASE/t4/a.rc" 120 || mal "T4 el primer install no terminó en 120 s: $(tail -3 "$BASE/t4/a.out")"
    RCA="$(cat "$BASE/t4/a.rc" 2>/dev/null)"
    [ "$RCB" = 3 ] && grep -q 'otra sesión está actualizando' "$BASE/t4/b.out" \
      && ok "T4 el segundo install sale 3 con «otra sesión está actualizando»" || mal "T4 el segundo install: rc $RCB: $(cat "$BASE/t4/b.out")"
    [ "$RCA" = 0 ] && ok "T4 el primero aplica y sale 0" || mal "T4 el primero salió ${RCA:-—}: $(tail -5 "$BASE/t4/a.out")"
    CORRIDAS="$(grep -c -v -- '--check' "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>/dev/null)"
    [ "$CORRIDAS" = 1 ] && ok "T4 el aplicador corrió una sola vez (sin --check)" || mal "T4 el aplicador corrió $CORRIDAS veces: $(cat "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>&1)"
    [ "$(estado "d['mode']")" = managed ] && [ "$(harness_lab_settings_commands | grep -c 'lab-hook.js')" = 1 ] \
      && ok "T4 estado y settings.json coherentes (managed, el hook una vez)" || mal "T4 estado $(estado "d.get('mode')"), hooks $(harness_lab_settings_commands | grep -c 'lab-hook.js')"
    [ ! -e "$(LOCK)" ] && ok "T4 sin candado colgado" || mal "T4 quedó el candado"
    [ -z "$(abiertas)" ] && ok "T4 ninguna copia abierta" || mal "T4 quedaron copias abiertas: $(abiertas | tr '\n' ';')"
  else mal "T4 el primer install no tomó el candado en 30 s: $(cat "$BASE/t4/a.out")"; fi
fi

# ═══ T3 · Rollback_KilledMidway_RerunFinishes ═══════════════════════════════════════════════════════════════════════
# t3_caso <etiqueta> <cuál>: corta la vuelta atrás después del comando de git que escribe un árbol número <cuál> (1 = el
# primero; «last» = el que deja todas las fuentes vueltas) y la termina con <cómo>: «aviso» (el --to que da el aviso) o
# «igual» (el mismo comando, sin --to)
t3_caso() {
  local et="$1" cual="$2" como="$3" d="$BASE/t3-$1"
  export TYCON_UPDATE_APPLY=auto
  instalado "$d"
  local T1 S1 T2
  T1="$(head_de "$LAB_TREE")"; S1="$(head_de "$LAB_SKILLS")"
  harness_lab_publish_hook PreToolUse 'tycon-pipeline/lab-rollback.js' 'process.exit(0);'
  harness_lab_publish_block 'lab-v2'
  T2="$(head_de "$LAB_AUTHOR_TREE")"
  estado_set "d['last_fetch']=None"
  harness startup >/dev/null 2>&1
  [ "$(head_de "$LAB_TREE")" = "$T2" ] || mal "T3/$et el arranque no aplicó v2: $(head_de "$LAB_TREE") vs $T2"
  # el testigo: deja CORRER el comando que escribe un árbol número <cuál> y recién después deja la señal y espera
  mkdir -p "$d/bin"; local SENAL="$d/git.llego" CUENTA="$d/git.cuenta"
  local tope="$cual"; [ "$cual" = last ] && tope=2   # dos fuentes con el árbol limpio: un `reset --hard` por fuente
  cat > "$d/bin/git" <<SH
#!/bin/sh
"$REAL_GIT" "\$@"; rc=\$?
case " \$* " in
  *" reset "*|*" stash "*|*" checkout "*|*" checkout-index "*|*" read-tree "*)
    n=\$(( \$(cat "$CUENTA" 2>/dev/null || echo 0) + 1 )); echo "\$n" > "$CUENTA"
    if [ "\$n" -ge "$tope" ]; then : > "$SENAL"; sleep 120; fi ;;
esac
exit \$rc
SH
  chmod +x "$d/bin/git"
  set -m
  ( PATH="$d/bin:$PATH" harness rollback > "$d/r1.out" 2>&1 ) &
  local CORTADO=$!; GRUPOS="$GRUPOS $CORTADO"
  set +m
  if espera_archivo "$SENAL" 60; then
    corta "$CORTADO"
    local BR DESTINO
    BR="$(abiertas | awk '$2=="before-rollback" {print $1; exit}')"
    DESTINO="$(abiertas | awk '$2=="before-rollback" {print $3; exit}')"
    [ -n "$BR" ] && [ "$DESTINO" != "-" ] && ok "T3/$et cortada: queda la before-rollback abierta ($BR) con su destino ($DESTINO)" || mal "T3/$et copias abiertas tras el corte: $(abiertas | tr '\n' ';')"
    [ -d "$(COPIAS)/$DESTINO" ] && ok "T3/$et la copia destino sigue en su carpeta" || mal "T3/$et no está la copia destino $DESTINO"
    # quedó a medias: con el primero, alguna fuente todavía no volvió o el estado sigue en v2; con el último, todas volvieron
    if [ "$cual" = last ]; then
      [ "$(head_de "$LAB_TREE")" = "$T1" ] && [ "$(head_de "$LAB_SKILLS")" = "$S1" ] \
        && ok "T3/$et el corte cayó con todas las fuentes ya vueltas" || mal "T3/$et el corte no cayó después del último: tree $(head_de "$LAB_TREE"), skills $(head_de "$LAB_SKILLS")"
    else
      { [ "$(head_de "$LAB_TREE")" != "$T1" ] || [ "$(head_de "$LAB_SKILLS")" != "$S1" ]; } \
        && ok "T3/$et la vuelta atrás quedó a medias (una fuente ya volvió, otra no)" || mal "T3/$et el corte no dejó la vuelta atrás a medias"
    fi
    harness startup >/dev/null 2>&1
    local AVISO; AVISO="$(aviso)"
    case "$AVISO" in *"una vuelta atrás se cortó"*"rollback --to $DESTINO"*) ok "T3/$et el arranque dice «una vuelta atrás se cortó» y da rollback --to $DESTINO" ;;
      *) mal "T3/$et aviso del arranque: «${AVISO}»" ;; esac
    case "$AVISO" in *"--to $BR"*) mal "T3/$et el aviso manda a volver a la before-rollback ($BR)" ;; *) ok "T3/$et el aviso nunca manda a la before-rollback" ;; esac
    local SALIDA RC
    if [ "$como" = aviso ]; then SALIDA="$(harness rollback --to "$DESTINO" 2>&1)"; RC=$?
    else SALIDA="$(harness rollback 2>&1)"; RC=$?; fi
    [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$T1" ] && [ "$(head_de "$LAB_SKILLS")" = "$S1" ] \
      && ok "T3/$et la vuelta atrás ($como) termina: árboles en los commits de la copia destino" || mal "T3/$et rollback ($como): rc $RC, tree $(head_de "$LAB_TREE") (v1 $T1): $SALIDA"
    [ -d "$(COPIAS)/$DESTINO" ] && ok "T3/$et la copia destino sigue después de volver" || mal "T3/$et se perdió la copia destino"
    [ "$(campo "$BR" open)" = False ] && [ "$(campo "$BR" closed_by)" = rollback ] \
      && ok "T3/$et la before-rollback del intento cortado quedó cerrada por la vuelta atrás" || mal "T3/$et la before-rollback $BR: open=$(campo "$BR" open) closed_by=$(campo "$BR" closed_by)"
    [ -z "$(abiertas)" ] && ok "T3/$et ninguna copia abierta al terminar" || mal "T3/$et quedaron abiertas: $(abiertas | tr '\n' ';')"
    harness startup >/dev/null 2>&1
    case "$(aviso)" in *"a medias:"*) mal "T3/$et el aviso del corte sigue después de terminar: $(aviso)" ;; *) ok "T3/$et terminada la vuelta atrás, el aviso del corte no vuelve" ;; esac
  else mal "T3/$et la vuelta atrás no llegó al comando que escribe un árbol en 60 s: $(cat "$d/r1.out")"; corta "$CORTADO"; fi
  unset TYCON_UPDATE_APPLY
}
if corre T3; then
  t3_caso primero 1 aviso
  t3_caso ultimo last igual
fi

# ═══ T2 · Update_KilledWhileWriting_StartupNamesOpenCopy ════════════════════════════════════════════════════════════
if corre T2; then
  harness_lab_create "$BASE/t2" >/dev/null
  # el molde de T9 de harness-install.test.sh: un clon «existente» con los archivos de trabajo encima, y el aplicador real
  T2_ORIGIN="$BASE/t2-origin"
  harness_lab_git "$BASE" clone -q --shared "$RAIZ" "$T2_ORIGIN" >/dev/null 2>&1
  harness_lab_git "$T2_ORIGIN" checkout -q -B main >/dev/null 2>&1
  DEV="$BASE/t2/clones/dev"; mkdir -p "$(dirname "$DEV")"
  harness_lab_git "$(dirname "$DEV")" clone -q --shared "$T2_ORIGIN" "$DEV" >/dev/null 2>&1
  harness_lab_git "$DEV" checkout -q -B main >/dev/null 2>&1
  for p in scripts/setup scripts/lib scripts/hooks scripts/install-tycon-hooks.sh scripts/install-tycon-hooks.ps1 scripts/publishing claude-md-blocks; do
    [ -e "$RAIZ/$p" ] && { rm -rf "${DEV:?}/$p"; cp -R "$RAIZ/$p" "$DEV/$p"; }
  done
  rm -f "$LAB_HOME/.claude/tycon-claude-guides"; ln -s "$DEV" "$LAB_HOME/.claude/tycon-claude-guides"
  harness_lab_old_line canonical
  # todo lo que sale a la red o a la máquina, apagado; los bloques del CLAUDE.md, PRENDIDOS (el corte es antes de ellos)
  AISLADO=(env TYCON_NO_CANONICAL_PATH=1 TYCON_NO_AZ_PROJECTS_REFRESH=1 TYCON_NO_BOOTSTRAP_HEAL=1
    TYCON_NO_COMMANDS_SYNC=1 TYCON_NO_ENGRAM_PROJECT_CHECK=1 TYCON_NO_ENGRAM_VERSION_CHECK=1 TYCON_NO_GIT_HOOKS=1
    TYCON_NO_SQLITE_CHECK=1 TYCON_NO_AGENTSMD_POINTER=1 TYCON_NO_THREAD_RESCUE=1 TYCON_NO_UPLOAD_RUNS=1 TYCON_NO_DOWNLOAD_RUNS=1
    TYCON_NO_COLLECT_FINDINGS=1 TYCON_MAILBOX_URL_BASE=http://127.0.0.1:9 TYCON_THIRD_PARTY=0)
  SALIDA="$("${AISLADO[@]}" bash "$DEV/scripts/install-tycon-hooks.sh" 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -f "$(ESTADO)" ] && ok "T2 el arnés quedó instalado con el aplicador real" \
    || mal "T2 la instalación previa falló (rc $RC): $(printf '%s' "$SALIDA" | tail -5)"
  # el cambio que trae el apply, visto desde la máquina: un gancho del arnés que falta en settings.json (el aplicador lo
  # vuelve a escribir, como uno nuevo de la lista) y un bloque nuevo del CLAUDE.md en el clon (cada claude-md-blocks/*.md
  # es un bloque). Así el corte deja una mezcla que se ve: el gancho escrito y el bloque todavía no
  printf '%s\n' "bloque de la prueba de cortes" > "$DEV/claude-md-blocks/zz-lab-corte-t2.md"
  GANCHO="$("$REAL_PY" - "$TYCON_SETTINGS_PATH" <<'PY'
import json, os, sys
p = sys.argv[1]; s = json.load(open(p, encoding="utf-8"))
gone = None
for ev, groups in (s.get("hooks") or {}).items():
    for g in groups:
        for h in list(g.get("hooks") or []):
            # uno de los ganchos de scripts/hooks/ (los escribe apply-hooks.js, antes de los bloques); no la línea de
            # arranque, que la escribe otro paso
            if gone is None and "/scripts/hooks/" in str(h.get("command", "")):
                g["hooks"].remove(h); gone = os.path.basename(str(h.get("command")).split("/scripts/hooks/", 1)[1].split('"')[0])
open(p, "w", encoding="utf-8").write(json.dumps(s, indent=2, ensure_ascii=False) + "\n")
print(gone or "")
PY
)"
  # cuántas veces lo nombra settings.json sin él (el aplicador lo vuelve a escribir con la ruta que resuelva: se cuenta por
  # el nombre del archivo, no por la línea entera)
  veces() { grep -o -F -- "$GANCHO" "$TYCON_SETTINGS_PATH" | wc -l | tr -d ' '; }
  SIN_GANCHO="$(veces)"
  [ -n "$GANCHO" ] || mal "T2 no encontré un gancho del arnés en settings.json para sacar"
  CLAUDE_ANTES="$(cat "$CLAUDE_MD_PATH" 2>/dev/null)"
  # el testigo: pasa todo al python3 real; la llamada de los bloques (`python3 - <bloques> <destino> 0 …/tycon-config.js`)
  # deja la señal y espera ANTES de pasarla: settings.json ya está escrito y los bloques todavía no
  mkdir -p "$BASE/t2/bin"; SENAL="$BASE/t2/bloques.llego"
  cat > "$BASE/t2/bin/python3" <<SH
#!/bin/sh
if [ "\${1:-}" = "-" ] && [ "\${4:-}" = "0" ]; then
  case "\${5:-}" in */tycon-config.js) : > "$SENAL"; sleep 120 ;; esac
fi
exec "$REAL_PY" "\$@"
SH
  chmod +x "$BASE/t2/bin/python3"
  set -m
  ( PATH="$BASE/t2/bin:$PATH" "${AISLADO[@]}" node "$DEV/scripts/setup/harness.js" apply > "$BASE/t2/apply.out" 2>&1 ) &
  CORTADO=$!; GRUPOS="$GRUPOS $CORTADO"
  set +m
  if espera_archivo "$SENAL" 180; then
    corta "$CORTADO"
    COPIA="$(abiertas | awk '{print $1; exit}')"
    [ -n "$COPIA" ] && ok "T2 cortado entre settings.json y los bloques: queda la copia abierta $COPIA" || mal "T2 no quedó ninguna copia abierta: $(ls "$(COPIAS)" 2>&1)"
    [ -e "$(LOCK)" ] && ok "T2 …y el candado del muerto (el corte de verdad)" || mal "T2 el corte no dejó el candado: la prueba no reproduce el caso"
    # la mezcla, antes del arranque: el gancho ya de vuelta en settings.json y el CLAUDE.md como antes (sin el bloque nuevo)
    if [ "$(veces)" -gt "$SIN_GANCHO" ] && [ "$(cat "$CLAUDE_MD_PATH" 2>/dev/null)" = "$CLAUDE_ANTES" ]; then
      ok "T2 la mezcla: settings.json ya con el gancho ($GANCHO) y los bloques del CLAUDE.md como antes"
    else mal "T2 el corte no cayó entre settings.json y los bloques ($GANCHO: $SIN_GANCHO → $(veces) en settings.json; CLAUDE.md igual: $([ "$(cat "$CLAUDE_MD_PATH" 2>/dev/null)" = "$CLAUDE_ANTES" ] && echo sí || echo no))"; fi
    SALIDA="$("${AISLADO[@]}" node "$DEV/scripts/setup/harness.js" startup 2>&1)"; RC=$?
    AVISO="$(aviso)"
    case "$AVISO" in *"a medias:"*"rollback --to $COPIA"*"por piezas"*) ok "T2 el arranque siguiente nombra la copia, da rollback --to $COPIA y dice «por piezas»" ;;
      *) mal "T2 aviso del arranque (rc $RC): «${AVISO}» — $(printf '%s' "$SALIDA" | tail -3)" ;; esac
  else mal "T2 el aplicador no llegó a los bloques en 180 s: $(tail -5 "$BASE/t2/apply.out")"; corta "$CORTADO"; fi
fi

# ═══ T10 · Startup_AfterCut_ClearsNotice_StaysGone ══════════════════════════════════════════════════════════════════
if corre T10; then
  instalado "$BASE/t10"
  corte_apply t10a
  if [ -n "$CORTADA" ]; then
    harness startup >/dev/null 2>&1
    NUEVA="$(copias | awk '$2=="startup" {print $1; exit}')"
    [ "$(campo "$CORTADA" open)" = False ] && [ -n "$NUEVA" ] && [ "$(campo "$CORTADA" closed_by)" = "$NUEVA" ] \
      && ok "T10 el arranque sano cerró la copia cortada ($CORTADA) con su nombre ($NUEVA)" || mal "T10 la cortada $CORTADA: open=$(campo "$CORTADA" open) closed_by=$(campo "$CORTADA" closed_by), la del arranque «${NUEVA}»"
    [ -z "$(abiertas)" ] && ok "T10 ninguna copia abierta después del arranque" || mal "T10 quedaron abiertas: $(abiertas | tr '\n' ';')"
    case "$(aviso)" in *"a medias:"*"rollback --to $CORTADA"*) ok "T10 ese arranque la avisa una vez, con su rollback --to" ;; *) mal "T10 el arranque que encontró el corte no lo avisó: «$(aviso)»" ;; esac
    # el camino de keepFromLastLook: un aviso viejo (de una mirada a la red) con el tramo del corte, y un arranque sin fetch
    estado_set "d['notice']='algo que dijo la red · a medias: un cambio del arnés se cortó (copia $CORTADA, apply, —): harness.js rollback --to $CORTADA vuelve a como estaba'; import datetime; d['last_fetch']=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')"
    harness startup >/dev/null 2>&1
    case "$(aviso)" in *"a medias:"*) mal "T10 el aviso del corte volvió con el aviso arrastrado: $(aviso)" ;; *) ok "T10 sin fetch, el aviso arrastrado no trae el tramo del corte" ;; esac
    [ -z "$(abiertas)" ] && ok "T10 el segundo arranque (reusa su copia) no deja ninguna abierta" || mal "T10 el segundo arranque dejó abiertas: $(abiertas | tr '\n' ';')"
  else mal "T10 el corte no dejó ninguna copia abierta: $(cat "$LAB/t10a-apply.out" 2>&1 | tail -3)"; fi
  # otro corte, y la vuelta atrás a esa copia con el comando del aviso
  corte_apply t10b
  if [ -n "$CORTADA" ]; then
    SALIDA="$(harness rollback --to "$CORTADA" 2>&1)"; RC=$?
    [ "$RC" = 0 ] && [ "$(campo "$CORTADA" open)" = False ] && [ "$(campo "$CORTADA" closed_by)" = rollback ] \
      && ok "T10 rollback --to $CORTADA la cierra con «rollback»" || mal "T10 rollback --to $CORTADA: rc $RC, open=$(campo "$CORTADA" open) closed_by=$(campo "$CORTADA" closed_by): $SALIDA"
    harness startup >/dev/null 2>&1
    case "$(aviso)" in *"a medias:"*) mal "T10 después de la vuelta atrás el aviso sigue: $(aviso)" ;; *) ok "T10 después de la vuelta atrás, el arranque no avisa el corte" ;; esac
  else mal "T10 el segundo corte no dejó ninguna copia abierta"; fi
fi

# ═══ T5 · ExistingSuites_StillGreen ═════════════════════════════════════════════════════════════════════════════════
if corre T5; then
  sub() { # sub <etiqueta> <comando…>
    local etiqueta="$1"; shift
    if "$@" > "$BASE/t5.out" 2>&1; then ok "T5 $etiqueta en verde"; else mal "T5 $etiqueta en rojo: $(grep -E 'MAL|not ok|✖' "$BASE/t5.out" | head -3)"; fi
  }
  sub "harness-update T3" bash "$RAIZ/scripts/tests/harness-update.test.sh" --only T3
  sub "harness-update T39L" bash "$RAIZ/scripts/tests/harness-update.test.sh" --only T39L
  sub "harness-rollback T23" bash "$RAIZ/scripts/tests/harness-rollback.test.sh" --only T23
  sub "harness-rollback T24" bash "$RAIZ/scripts/tests/harness-rollback.test.sh" --only T24
  sub "harness-install T9" bash "$RAIZ/scripts/tests/harness-install.test.sh" --only T9
  sub "marker-run-check (el candado de run-check)" node --test "$RAIZ/skills/tycon-pipeline/scripts/tests/marker-run-check.test.js"
fi

# ═══ T9 · HarnessFailedPaths_CloseAsFailed_KeepOlderOpen ════════════════════════════════════════════════════════════
if corre T9; then
  # Antes de cada operación, un corte deja una copia abierta (CORTADA). La operación que falla con el proceso vivo deja
  # TODAS sus copias nuevas con «failed», y la cortada sigue abierta: un fallo no repara lo que dejó un corte.
  # t9_antes: los nombres de las copias que ya están (para separar las que toma la operación)
  t9_antes() { T9_ANTES=" $(copias | awk '{print $1}' | tr '\n' ' ') "; }
  # t9_nuevas: «nombre reason open closed_by» de las copias que tomó la operación (las que no estaban antes)
  t9_nuevas() { copias | awk -v a="$T9_ANTES" 'index(a, " " $1 " ")==0 {print $1, $2, $3, $4}'; }
  # t9_falla <etiqueta> <cuántas copias espera>: todas las nuevas «failed» y la cortada abierta
  t9_falla() {
    local et="$1" esperadas="$2" nuevas n mal_cerradas
    nuevas="$(t9_nuevas)"; n="$(printf '%s' "$nuevas" | grep -c .)"
    mal_cerradas="$(printf '%s\n' "$nuevas" | awk 'NF && !($3=="closed" && $4=="failed")')"
    [ "$n" = "$esperadas" ] && [ -z "$mal_cerradas" ] \
      && ok "T9/$et la(s) copia(s) de la operación ($n) quedaron «failed»: $(printf '%s' "$nuevas" | awk '{print $1 " (" $2 ")"}' | tr '\n' ' ')" \
      || mal "T9/$et copias de la operación (esperaba $esperadas, todas failed): $(printf '%s' "$nuevas" | tr '\n' ';')"
    abierta "$CORTADA" && ok "T9/$et la copia cortada ($CORTADA) sigue abierta" || mal "T9/$et la copia cortada $CORTADA: open=$(campo "$CORTADA" open) closed_by=$(campo "$CORTADA" closed_by)"
  }
  # t9_sigue_avisando <etiqueta> [<comando harness>]: un arranque con el aplicador en error (no cierra nada) avisa la
  # cortada, con su comando
  t9_sigue_avisando() {
    local et="$1" cmd="${2:-harness}"
    LAB_APPLIER_FAIL=1 "$cmd" startup >/dev/null 2>&1
    case "$(aviso)" in *"a medias:"*"rollback --to $CORTADA"*) ok "T9/$et el aviso de la cortada sigue ($CORTADA)" ;;
      *) mal "T9/$et el aviso no nombra la cortada $CORTADA: «$(aviso)»" ;; esac
  }
  # el hook del aplicador de juguete fuera de settings.json: así `install` tiene algo que escribir (no corta en «sin cambios»)
  t9_sin_gancho() {
    "$REAL_PY" - "$TYCON_SETTINGS_PATH" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p, encoding="utf-8"))
for ev, groups in (s.get("hooks") or {}).items():
    for g in groups: g["hooks"] = [h for h in (g.get("hooks") or []) if "lab-hook.js" not in str(h.get("command", ""))]
open(p, "w", encoding="utf-8").write(json.dumps(s, indent=2) + "\n")
PY
  }

  instalado "$BASE/t9"

  # install con el aplicador en error
  corte_apply t9-install
  if [ -n "$CORTADA" ]; then
    t9_sin_gancho; t9_antes
    SALIDA="$(LAB_APPLIER_FAIL=1 harness install --yes 2>&1)"; RC=$?
    [ "$RC" = 1 ] && ok "T9/install sale 1 con el aplicador en error" || mal "T9/install rc $RC: $(printf '%s' "$SALIDA" | tail -3)"
    t9_falla install 1
  else mal "T9/install el corte no dejó ninguna copia abierta: $(tail -3 "$LAB/t9-install-apply.out" 2>&1)"; fi
  harness install --yes >/dev/null 2>&1   # la máquina sana otra vez para el caso siguiente

  # update con el aplicador en error (hay una versión nueva publicada)
  corte_apply t9-update
  if [ -n "$CORTADA" ]; then
    harness_lab_publish_block lab-t9-update
    estado_set "d['last_fetch']=None"
    t9_antes
    SALIDA="$(TYCON_UPDATE_APPLY=auto LAB_APPLIER_FAIL=1 harness update --yes 2>&1)"; RC=$?
    [ "$RC" = 1 ] && ok "T9/update sale 1 con el aplicador en error" || mal "T9/update rc $RC: $(printf '%s' "$SALIDA" | tail -3)"
    t9_falla update 1
  else mal "T9/update el corte no dejó ninguna copia abierta"; fi

  # apply con el aplicador en error
  corte_apply t9-apply
  if [ -n "$CORTADA" ]; then
    t9_antes
    SALIDA="$(LAB_APPLIER_FAIL=1 harness apply 2>&1)"; RC=$?
    [ "$RC" = 1 ] && ok "T9/apply sale 1 con el aplicador en error" || mal "T9/apply rc $RC: $(printf '%s' "$SALIDA" | tail -3)"
    t9_falla apply 1
  else mal "T9/apply el corte no dejó ninguna copia abierta"; fi

  # startup con el aplicador en error: su copia «failed», la cortada abierta y avisada
  corte_apply t9-startup
  if [ -n "$CORTADA" ]; then
    t9_antes
    LAB_APPLIER_FAIL=1 harness startup >/dev/null 2>&1
    t9_falla startup 1
    case "$(aviso)" in *"a medias:"*"rollback --to $CORTADA"*) ok "T9/startup el arranque en error avisa la cortada ($CORTADA)" ;;
      *) mal "T9/startup el aviso no nombra la cortada $CORTADA: «$(aviso)»" ;; esac
  else mal "T9/startup el corte no dejó ninguna copia abierta"; fi

  # startup con cambio de perfil y el aplicador en error: las dos copias del arranque (la del perfil y la suya) «failed»
  corte_apply t9-perfil
  if [ -n "$CORTADA" ]; then
    printf '{ "install": { "profile": "minimal" } }\n' > "$LAB_HOME/.claude/tycon.json"
    t9_antes
    LAB_APPLIER_FAIL=1 harness startup >/dev/null 2>&1
    t9_falla perfil 2
    t9_nuevas | awk '{print $2}' | grep -x profile >/dev/null && ok "T9/perfil una de las dos es la del cambio de perfil" || mal "T9/perfil no tomó la copia del perfil: $(t9_nuevas | tr '\n' ';')"
    rm -f "$LAB_HOME/.claude/tycon.json"
  else mal "T9/perfil el corte no dejó ninguna copia abierta"; fi

  # rollback --to a una copia cuyo árbol no se puede traer (sus `sources` nombran un commit que no está)
  corte_apply t9-rollback
  if [ -n "$CORTADA" ]; then
    DESTINO="$(copias | awk '$3=="closed" {print $1}' | while read -r c; do [ "$(campo "$c" sources)" != None ] && { echo "$c"; break; }; done)"
    if [ -n "$DESTINO" ]; then
      "$REAL_PY" - "$(COPIAS)/$DESTINO/manifest.json" <<'PY'
import json, sys
p = sys.argv[1]; m = json.load(open(p, encoding="utf-8"))
m["sources"] = {k: "0123456789abcdef0123456789abcdef01234567" for k in m["sources"]}
open(p, "w", encoding="utf-8").write(json.dumps(m, indent=2) + "\n")
PY
      t9_antes
      SALIDA="$(harness rollback --to "$DESTINO" 2>&1)"; RC=$?
      [ "$RC" != 0 ] && ok "T9/rollback --to una copia sin su árbol sale $RC" || mal "T9/rollback --to sale 0: $(printf '%s' "$SALIDA" | tail -3)"
      t9_falla rollback 1
      t9_nuevas | awk '{print $2}' | grep -x before-rollback >/dev/null && ok "T9/rollback la que quedó «failed» es su before-rollback" || mal "T9/rollback sin before-rollback: $(t9_nuevas | tr '\n' ';')"
    else mal "T9/rollback no encontré una copia cerrada con sources para usar de destino: $(copias | tr '\n' ';')"; fi
  else mal "T9/rollback el corte no dejó ninguna copia abierta"; fi

  # uninstall con una pieza manejada en una carpeta sin permiso de escritura (~/.claude: settings.json y CLAUDE.md)
  corte_apply t9-uninstall
  if [ -n "$CORTADA" ]; then
    chmod a-w "$LAB_HOME/.claude"
    if : > "$LAB_HOME/.claude/t9-escribe" 2>/dev/null; then
      rm -f "$LAB_HOME/.claude/t9-escribe"; chmod u+w "$LAB_HOME/.claude"
      no_medido "T9/uninstall con una carpeta sin permiso" "esta cuenta escribe igual en una carpeta sin permiso"
    else
      t9_antes
      SALIDA="$(harness uninstall --yes 2>&1)"; RC=$?
      chmod u+w "$LAB_HOME/.claude"
      [ "$RC" != 0 ] && ok "T9/uninstall a medias sale $RC" || mal "T9/uninstall sale 0 con ~/.claude sin permiso: $(printf '%s' "$SALIDA" | tail -3)"
      t9_falla uninstall 1
    fi
  else mal "T9/uninstall el corte no dejó ninguna copia abierta"; fi

  # repoint (la mudanza del clon de skills, por la llave update.skills_source) que falla: un git testigo hace fallar su
  # `merge --ff-only`. Después, el mismo repoint que sale bien: cierra sólo la suya (no corre el aplicador)
  harness_lab_team_machine "$BASE/t9r" toy >/dev/null
  [ -n "${LAB_HOME:-}" ] && [ "$HOME" = "$LAB_HOME" ] && case "$LAB" in */t9r) true ;; *) false ;; esac || { echo "❌ harness-failures: la HOME no es la del laboratorio (${HOME}): corto"; exit 1; }
  harness install --yes >/dev/null 2>&1
  harness_lab_cut >/dev/null 2>&1
  TYCON_UPDATE_APPLY=auto harness update >/dev/null 2>&1
  if [ "$(head_de "$LAB_TREE")" = "$LAB_COMMIT_UNION" ] && [ "$(harness_lab_git "$LAB_SKILLS" remote get-url origin)" = "$LAB_REMOTE_SKILLS" ]; then
    mkdir -p "$BASE/t9r-bin"
    cat > "$BASE/t9r-bin/git" <<SH
#!/bin/sh
case " \$* " in *" merge -q --ff-only --no-overwrite-ignore "*) echo "fatal: no pude (git de laboratorio)" >&2; exit 128 ;; esac
exec "$REAL_GIT" "\$@"
SH
    chmod +x "$BASE/t9r-bin/git"
    corte_apply t9-repoint
    if [ -n "$CORTADA" ]; then
      t9_antes
      SALIDA="$(PATH="$BASE/t9r-bin:$PATH" TYCON_UPDATE_APPLY=auto TYCON_UPDATE_SKILLS_SOURCE=unified harness update 2>&1)"; RC=$?
      [ "$(harness_lab_git "$LAB_SKILLS" remote get-url origin)" = "$LAB_REMOTE_SKILLS" ] && case "$SALIDA" in *"merge --ff-only"*) true ;; *) false ;; esac \
        && ok "T9/repoint el merge --ff-only falló y el clon quedó como estaba (rc $RC)" || mal "T9/repoint el fallo no fue el del merge (rc $RC): $(printf '%s' "$SALIDA" | tail -3)"
      t9_falla repoint 1
      t9_nuevas | awk '{print $2}' | grep -x repoint >/dev/null && ok "T9/repoint la que quedó «failed» es la del repoint" || mal "T9/repoint sin copia del repoint: $(t9_nuevas | tr '\n' ';')"
    else mal "T9/repoint el corte no dejó ninguna copia abierta"; fi
    corte_apply t9-repoint-ok
    if [ -n "$CORTADA" ]; then
      t9_antes
      SALIDA="$(TYCON_UPDATE_APPLY=auto TYCON_UPDATE_SKILLS_SOURCE=unified harness update 2>&1)"; RC=$?
      NUEVAS="$(t9_nuevas)"
      [ "$(harness_lab_git "$LAB_SKILLS" remote get-url origin)" = "$LAB_REMOTE_UNIFIED" ] && printf '%s\n' "$NUEVAS" | awk '$2=="repoint" && $3=="closed" && $4!="failed"' | grep . >/dev/null \
        && ok "T9/repoint-ok re-apuntado, con su copia cerrada sin «failed» (rc $RC)" || mal "T9/repoint-ok (rc $RC) origin $(harness_lab_git "$LAB_SKILLS" remote get-url origin), copias: $(printf '%s' "$NUEVAS" | tr '\n' ';'): $(printf '%s' "$SALIDA" | tail -2)"
      abierta "$CORTADA" && ok "T9/repoint-ok la copia cortada ($CORTADA) sigue abierta" || mal "T9/repoint-ok el repoint cerró la cortada $CORTADA: closed_by=$(campo "$CORTADA" closed_by)"
      # el arranque que mira el aviso, con la llave puesta (sin ella desharía el re-apuntado)
      LAB_APPLIER_FAIL=1 TYCON_UPDATE_SKILLS_SOURCE=unified harness startup >/dev/null 2>&1
      case "$(aviso)" in *"a medias:"*"rollback --to $CORTADA"*) ok "T9/repoint-ok el aviso de la cortada sigue ($CORTADA)" ;;
        *) mal "T9/repoint-ok el aviso no nombra la cortada $CORTADA: «$(aviso)»" ;; esac
    else mal "T9/repoint-ok el corte no dejó ninguna copia abierta"; fi
  else mal "T9/repoint no pude armar la máquina del equipo después del corte: arnés $(head_de "$LAB_TREE"), origin de skills $(harness_lab_git "$LAB_SKILLS" remote get-url origin)"; fi

  # install --tool y uninstall --tool que salen bien, después de un corte: enchufan o desenchufan una herramienta sin
  # correr el aplicador completo, así que cierran sólo la suya. Se miden en una máquina con versión bajada (es la forma
  # que los admite); el corte es un `apply` de esa versión
  harness_lab_create "$BASE/t9t" >/dev/null
  harness_lab_release_server
  harness_lab_codex_pieces
  harness_lab_publish_stable 2026.10.07.1
  harness_lab_tools both; harness_lab_tools_fresh_home
  mkdir -p "$LAB_HOME/.claude"; printf '{\n  "hooks": {}\n}\n' > "$LAB_HOME/.claude/settings.json"; : > "$LAB_HOME/.claude/CLAUDE.md"
  SALIDA="$(harness install --version latest --tool claude --yes 2>&1)" || mal "T9/tool la instalación de la versión bajada falló: $(printf '%s' "$SALIDA" | tail -3)"
  harness() { harness_release "$@"; }   # el corte y el arranque, con el programa de la versión instalada
  corte_apply t9-tool
  if [ -n "$CORTADA" ]; then
    t9_antes
    SALIDA="$(harness_release install --tool codex --yes 2>&1)"; RC=$?
    [ "$RC" = 0 ] && t9_nuevas | awk '$2=="tool" && $3=="closed" && $4!="failed"' | grep . >/dev/null \
      && ok "T9/tool install --tool codex sale 0, con su copia cerrada sin «failed»" || mal "T9/tool install --tool codex (rc $RC) copias: $(t9_nuevas | tr '\n' ';'): $(printf '%s' "$SALIDA" | tail -2)"
    abierta "$CORTADA" && ok "T9/tool install --tool deja abierta la cortada ($CORTADA)" || mal "T9/tool install --tool cerró la cortada $CORTADA: closed_by=$(campo "$CORTADA" closed_by)"
    t9_antes
    SALIDA="$(harness_release uninstall --tool codex --yes 2>&1)"; RC=$?
    [ "$RC" = 0 ] && t9_nuevas | awk '$2=="tool" && $3=="closed" && $4!="failed"' | grep . >/dev/null \
      && ok "T9/tool uninstall --tool codex sale 0, con su copia cerrada sin «failed»" || mal "T9/tool uninstall --tool codex (rc $RC) copias: $(t9_nuevas | tr '\n' ';'): $(printf '%s' "$SALIDA" | tail -2)"
    abierta "$CORTADA" && ok "T9/tool uninstall --tool deja abierta la cortada ($CORTADA)" || mal "T9/tool uninstall --tool cerró la cortada $CORTADA: closed_by=$(campo "$CORTADA" closed_by)"
    t9_sigue_avisando tool harness_release
  else mal "T9/tool el corte no dejó ninguna copia abierta: $(tail -3 "$LAB/t9-tool-apply.out" 2>&1) · copias: $(copias | tr '\n' ';')"; fi
  harness() { node "$LAB_TREE/scripts/setup/harness.js" "$@"; }
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  unset TYCON_RELEASE_API TYCON_RELEASE_GIT TYCON_RELEASE_RAW TYCON_RELEASE_ARCHIVE   # el servidor ya no está
fi

# ═══ T11 · SuccessfulOps_CloseOlderOnlyWhenRewroteAll ═══════════════════════════════════════════════════════════════
if corre T11; then
  # Antes de cada operación, un corte deja una copia abierta (CORTADA). Sólo la operación que reescribió todo (aplicador
  # completo, sin error y con la salud en verde) la cierra, con el nombre de su copia; las demás la dejan abierta.
  t11_antes() { T11_ANTES=" $(copias | awk '{print $1}' | tr '\n' ' ') "; }
  # t11_nueva <reason>: la copia nueva (no estaba antes) de la operación, con ese motivo
  t11_nueva() { copias | awk -v a="$T11_ANTES" -v r="$1" 'index(a, " " $1 " ")==0 && $2==r {print $1; exit}'; }
  # t11_cerro <etiqueta> <copia nueva>: la cortada quedó cerrada por esa copia, y un arranque después no la avisa
  t11_cerro() {
    local et="$1" nueva="$2"
    [ -n "$nueva" ] && [ "$(campo "$CORTADA" open)" = False ] && [ "$(campo "$CORTADA" closed_by)" = "$nueva" ] \
      && ok "T11/$et cerró la copia cortada ($CORTADA) con el nombre de la suya ($nueva)" || mal "T11/$et la cortada $CORTADA: open=$(campo "$CORTADA" open) closed_by=$(campo "$CORTADA" closed_by), la nueva «${nueva}»"
    # el arranque con el aplicador en error no cierra nada: si la cortada siguiera abierta, la avisaría
    LAB_APPLIER_FAIL=1 harness startup >/dev/null 2>&1
    case "$(aviso)" in *"a medias:"*"$CORTADA"*) mal "T11/$et el aviso de la cortada sigue: $(aviso)" ;; *) ok "T11/$et el aviso de la cortada se fue" ;; esac
  }
  # t11_no_cerro <etiqueta> <copia nueva> <closed_by esperado de la nueva>: la cortada sigue abierta
  t11_no_cerro() {
    local et="$1" nueva="$2" esperado="$3"
    [ -n "$nueva" ] && [ "$(campo "$nueva" open)" = False ] && [ "$(campo "$nueva" closed_by)" = "$esperado" ] \
      && ok "T11/$et su copia ($nueva) cerrada con «${esperado}»" || mal "T11/$et su copia «${nueva}»: open=$(campo "$nueva" open) closed_by=$(campo "$nueva" closed_by) (esperaba $esperado)"
    abierta "$CORTADA" && ok "T11/$et la copia cortada ($CORTADA) sigue abierta" || mal "T11/$et cerró la cortada $CORTADA: closed_by=$(campo "$CORTADA" closed_by)"
  }
  # el hook del aplicador de juguete fuera de settings.json: así `install` tiene algo que escribir (no corta en «sin cambios»)
  t11_sin_gancho() {
    "$REAL_PY" - "$TYCON_SETTINGS_PATH" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p, encoding="utf-8"))
for ev, groups in (s.get("hooks") or {}).items():
    for g in groups: g["hooks"] = [h for h in (g.get("hooks") or []) if "lab-hook.js" not in str(h.get("command", ""))]
open(p, "w", encoding="utf-8").write(json.dumps(s, indent=2) + "\n")
PY
  }
  # t11_avisa <etiqueta>: un arranque con el aplicador en error (no cierra nada) sigue avisando la cortada
  t11_avisa() {
    LAB_APPLIER_FAIL=1 harness startup >/dev/null 2>&1
    case "$(aviso)" in *"a medias:"*"rollback --to $CORTADA"*) ok "T11/$1 el aviso de la cortada sigue ($CORTADA)" ;;
      *) mal "T11/$1 el aviso no nombra la cortada $CORTADA: «$(aviso)»" ;; esac
  }
  # t11_version <nombre>: una versión nueva publicada, y el arranque o update que la mira sin esperar la ventana de la red
  t11_version() { harness_lab_publish_block "$1"; estado_set "d['last_fetch']=None"; }

  instalado "$BASE/t11"

  # install sano
  corte_apply t11-install
  if [ -n "$CORTADA" ]; then
    t11_sin_gancho; t11_antes
    SALIDA="$(harness install --yes 2>&1)"; RC=$?
    [ "$RC" = 0 ] && ok "T11/install sale 0" || mal "T11/install rc $RC: $(printf '%s' "$SALIDA" | tail -3)"
    t11_cerro install "$(t11_nueva install)"
  else mal "T11/install el corte no dejó ninguna copia abierta: $(tail -3 "$LAB/t11-install-apply.out" 2>&1)"; fi

  # update sano
  corte_apply t11-update
  if [ -n "$CORTADA" ]; then
    t11_version lab-t11-update; t11_antes
    SALIDA="$(TYCON_UPDATE_APPLY=auto harness update --yes 2>&1)"; RC=$?
    [ "$RC" = 0 ] && ok "T11/update sale 0" || mal "T11/update rc $RC: $(printf '%s' "$SALIDA" | tail -3)"
    t11_cerro update "$(t11_nueva update)"
  else mal "T11/update el corte no dejó ninguna copia abierta"; fi

  # apply sano
  corte_apply t11-apply
  if [ -n "$CORTADA" ]; then
    t11_antes
    SALIDA="$(harness apply 2>&1)"; RC=$?
    [ "$RC" = 0 ] && ok "T11/apply sale 0" || mal "T11/apply rc $RC: $(printf '%s' "$SALIDA" | tail -3)"
    t11_cerro apply "$(t11_nueva apply)"
  else mal "T11/apply el corte no dejó ninguna copia abierta"; fi

  # rollback sano (sin --to: vuelve a la de antes de la versión instalada). Su before-rollback cierra con «rollback» y,
  # como reescribió todo, la cortada también queda cerrada
  corte_apply t11-rollback
  if [ -n "$CORTADA" ]; then
    t11_antes
    SALIDA="$(harness rollback 2>&1)"; RC=$?
    BR="$(t11_nueva before-rollback)"
    [ "$RC" = 0 ] && ok "T11/rollback sale 0" || mal "T11/rollback rc $RC: $(printf '%s' "$SALIDA" | tail -3)"
    [ -n "$BR" ] && [ "$(campo "$BR" open)" = False ] && [ "$(campo "$BR" closed_by)" = rollback ] \
      && ok "T11/rollback su before-rollback ($BR) cerrada con «rollback»" || mal "T11/rollback su before-rollback «${BR}»: open=$(campo "$BR" open) closed_by=$(campo "$BR" closed_by)"
    case "$(campo "$CORTADA" open):$(campo "$CORTADA" closed_by)" in "False:rollback"|"False:$BR") ok "T11/rollback cerró la cortada ($CORTADA, closed_by $(campo "$CORTADA" closed_by))" ;;
      *) mal "T11/rollback la cortada $CORTADA: open=$(campo "$CORTADA" open) closed_by=$(campo "$CORTADA" closed_by)" ;; esac
  else mal "T11/rollback el corte no dejó ninguna copia abierta"; fi

  # install y update con la salud en rojo: la suya «failed», la cortada abierta
  corte_apply t11-install-rojo
  if [ -n "$CORTADA" ]; then
    t11_sin_gancho; t11_antes
    SALIDA="$(LAB_APPLIER_SUITE_FAIL=1 harness install --yes 2>&1)"; RC=$?
    [ "$RC" = 1 ] && ok "T11/install-rojo sale 1 (la salud no pasó)" || mal "T11/install-rojo rc $RC: $(printf '%s' "$SALIDA" | tail -3)"
    t11_no_cerro install-rojo "$(t11_nueva install)" failed
    t11_avisa install-rojo
  else mal "T11/install-rojo el corte no dejó ninguna copia abierta"; fi
  harness install --yes >/dev/null 2>&1   # sana otra vez
  corte_apply t11-update-rojo
  if [ -n "$CORTADA" ]; then
    t11_version lab-t11-update-rojo; t11_antes
    SALIDA="$(TYCON_UPDATE_APPLY=auto LAB_APPLIER_SUITE_FAIL=1 harness update --yes 2>&1)"; RC=$?
    [ "$RC" = 1 ] && case "$SALIDA" in *"no quedó sana"*) true ;; *) false ;; esac && ok "T11/update-rojo sale 1: la versión no quedó sana" || mal "T11/update-rojo rc $RC: $(printf '%s' "$SALIDA" | tail -3)"
    t11_no_cerro update-rojo "$(t11_nueva update)" failed
    t11_avisa update-rojo
  else mal "T11/update-rojo el corte no dejó ninguna copia abierta"; fi

  # relocate (muda lo registrado por el nombre viejo del lugar) que sale bien: no corre el aplicador, cierra sólo la suya.
  # Lo que muda: un hook registrado por el nombre viejo, y el nombre viejo como enlace al clon
  harness install --yes >/dev/null 2>&1   # sana otra vez
  corte_apply t11-relocate
  if [ -n "$CORTADA" ]; then
    T11_VIEJO="$(node -p "require('$LAB_TREE/scripts/setup/harness/place.js').LEGACY_PLACE_NAME")"
    "$REAL_PY" - "$TYCON_SETTINGS_PATH" "$LAB_HOME/.claude/$T11_VIEJO/scripts/hooks/lab-hook.js" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p, encoding="utf-8"))
s.setdefault("hooks", {}).setdefault("SessionStart", []).append({"hooks": [{"type": "command", "command": 'node "%s"' % sys.argv[2]}]})
open(p, "w", encoding="utf-8").write(json.dumps(s, indent=2) + "\n")
PY
    [ -e "$LAB_HOME/.claude/$T11_VIEJO" ] || ln -s "$LAB_TREE" "$LAB_HOME/.claude/$T11_VIEJO"
    t11_antes
    SALIDA="$(harness relocate 2>&1)"; RC=$?
    [ "$RC" = 0 ] && case "$SALIDA" in *"total: 1 cambio"*) true ;; *) false ;; esac && ok "T11/relocate sale 0 y mudó lo registrado por el nombre viejo" || mal "T11/relocate rc $RC: $(printf '%s' "$SALIDA" | tail -3)"
    t11_no_cerro relocate "$(t11_nueva relocate)" relocate
    t11_avisa relocate
  else mal "T11/relocate el corte no dejó ninguna copia abierta"; fi

  # uninstall sano: cierra sólo la suya; la cortada sigue abierta (se mira el manifiesto: ya no hay arranque)
  corte_apply t11-uninstall
  if [ -n "$CORTADA" ]; then
    t11_antes
    SALIDA="$(harness uninstall --yes 2>&1)"; RC=$?
    [ "$RC" = 0 ] && ok "T11/uninstall sale 0" || mal "T11/uninstall rc $RC: $(printf '%s' "$SALIDA" | tail -3)"
    t11_no_cerro uninstall "$(t11_nueva uninstall)" uninstall
  else mal "T11/uninstall el corte no dejó ninguna copia abierta"; fi

  # la mudanza del arranque: la máquina (instalada desde el clon) pide la carpeta nueva (`install.home: tycon`) y el
  # arranque la muda. La copia de la mudanza corrió el aplicador completo con la salud en verde: ella cierra la cortada,
  # no la del arranque
  harness_lab_create "$BASE/t11m" >/dev/null
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.08.1
  if harness install --yes >/dev/null 2>&1; then
    corte_apply t11-mudanza
    if [ -n "$CORTADA" ]; then
      printf '{ "install": { "profile": "full", "home": "tycon" } }\n' > "$LAB/lab-profile.json"
      t11_antes
      SALIDA="$(TYCON_UPDATE_APPLY=auto harness startup 2>&1)"; RC=$?
      # mudada, las copias viven en ~/.tycon/backups (se mudaron con todo)
      COPIAS() { printf '%s' "$LAB_HOME/.tycon/backups"; }
      MUDANZA="$(t11_nueva migrate)"; ARRANQUE="$(t11_nueva startup)"
      [ "$RC" = 0 ] && [ "$(estado "d['sources'][0].get('kind')")" = release ] && [ -n "$MUDANZA" ] \
        && ok "T11/mudanza el arranque mudó la máquina, con la copia de la mudanza ($MUDANZA)" || mal "T11/mudanza no mudó (rc $RC, kind $(estado "d['sources'][0].get('kind')"), copias nuevas: $(copias | awk -v a="$T11_ANTES" 'index(a, " " $1 " ")==0' | tr '\n' ';')): $(printf '%s' "$SALIDA" | tail -2)"
      [ "$(campo "$CORTADA" open)" = False ] && [ -n "$MUDANZA" ] && [ "$(campo "$CORTADA" closed_by)" = "$MUDANZA" ] \
        && ok "T11/mudanza la cortada ($CORTADA) la cerró la copia de la mudanza" || mal "T11/mudanza la cortada $CORTADA: open=$(campo "$CORTADA" open) closed_by=$(campo "$CORTADA" closed_by) (mudanza «${MUDANZA}», arranque «${ARRANQUE}»)"
      [ -z "$ARRANQUE" ] || [ "$(campo "$CORTADA" closed_by)" != "$ARRANQUE" ] && ok "T11/mudanza …no la del arranque" || mal "T11/mudanza la cerró la copia del arranque ($ARRANQUE)"
      [ -n "$ARRANQUE" ] && [ "$(campo "$ARRANQUE" closed_by)" = startup ] \
        && ok "T11/mudanza la copia del arranque la cerró el arranque mismo, no la mudanza" || mal "T11/mudanza la copia del arranque «${ARRANQUE}»: closed_by=$(campo "$ARRANQUE" closed_by)"
      COPIAS() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness/backups"; }
    else mal "T11/mudanza el corte no dejó ninguna copia abierta"; fi
  else mal "T11/mudanza la instalación desde el clon falló"; fi
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  unset TYCON_RELEASE_API TYCON_RELEASE_GIT TYCON_RELEASE_RAW TYCON_RELEASE_ARCHIVE   # el servidor ya no está

  # una vuelta atrás que se corta (su before-rollback queda abierta), un update sano que cambia de versión, y después
  # rollback sin --to: el update cierra la before-rollback con «superseded», y el rollback elige por los `sources` (la
  # copia de antes de la versión instalada), no el destino de la vuelta atrás vieja
  instalado "$BASE/t11b"
  t11_version lab-t11-v2
  TYCON_UPDATE_APPLY=auto harness update --yes >/dev/null 2>&1 || mal "T11/superseded el update a la versión 2 falló"
  # el corte: la vuelta atrás, muerta con kill -9 mientras su aplicador de juguete duerme (los árboles ya volvieron)
  N0="$(grep -c -v -- '--check' "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>/dev/null)"
  set -m
  ( LAB_APPLIER_SLEEP=60 harness rollback > "$LAB/t11-rollback.out" 2>&1 ) &
  T11_PG=$!; GRUPOS="$GRUPOS $T11_PG"
  set +m
  n=0; while [ "$(grep -c -v -- '--check' "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>/dev/null)" = "$N0" ] && [ "$n" -lt 150 ]; do sleep 0.2; n=$((n + 1)); done
  sleep 1
  corta "$T11_PG"
  BR="$(abiertas | awk '$2=="before-rollback" {print $1; exit}')"
  VIEJO_DESTINO="$(abiertas | awk '$2=="before-rollback" {print $3; exit}')"
  if [ -n "$BR" ] && [ "$VIEJO_DESTINO" != "-" ]; then
    ok "T11/superseded la vuelta atrás cortada dejó su before-rollback abierta ($BR, iba a $VIEJO_DESTINO)"
    t11_version lab-t11-v3; t11_antes
    SALIDA="$(TYCON_UPDATE_APPLY=auto harness update --yes 2>&1)"; RC=$?
    NUEVA="$(t11_nueva update)"
    [ "$RC" = 0 ] && [ -n "$NUEVA" ] && ok "T11/superseded el update a la versión 3 sale 0 ($NUEVA)" || mal "T11/superseded update a la versión 3: rc $RC: $(printf '%s' "$SALIDA" | tail -3)"
    [ "$(campo "$BR" open)" = False ] && [ "$(campo "$BR" closed_by)" = superseded ] \
      && ok "T11/superseded el update cerró la before-rollback con «superseded»" || mal "T11/superseded la before-rollback $BR: open=$(campo "$BR" open) closed_by=$(campo "$BR" closed_by)"
    SALIDA="$(harness rollback 2>&1)"; RC=$?
    case "$SALIDA" in *"retomo la vuelta atrás"*|*"la copia $VIEJO_DESTINO "*) mal "T11/superseded el rollback sin --to retomó la vuelta atrás vieja: $(printf '%s' "$SALIDA" | head -2)" ;;
      *"vuelta atrás a la copia $NUEVA "*) [ "$RC" = 0 ] && ok "T11/superseded el rollback sin --to eligió por los sources ($NUEVA, la de antes de la versión 3)" || mal "T11/superseded rollback rc $RC: $(printf '%s' "$SALIDA" | tail -3)" ;;
      *) mal "T11/superseded el rollback sin --to no eligió la copia de antes de la versión 3 ($NUEVA): rc $RC: $(printf '%s' "$SALIDA" | head -2)" ;; esac
  else mal "T11/superseded la vuelta atrás cortada no dejó una before-rollback abierta: $(abiertas | tr '\n' ';') · $(tail -3 "$LAB/t11-rollback.out" 2>&1)"; fi
fi

# ═══ T12 · FixedCopy_RefreshedAfterHealthyUpdate ════════════════════════════════════════════════════════════════════
if corre T12; then
  export TYCON_UPDATE_APPLY=auto
  instalado "$BASE/t12"
  FIJA="$LAB_HOME/.claude/.tycon-pipeline/harness/program/harness"
  # la versión nueva cambia los tres módulos que la copia fija tiene que traer (una línea de comentario al final de cada
  # uno): así «iguales al árbol» sólo se cumple si la actualización sana la refrescó
  harness_lab_git "$LAB_AUTHOR_TREE" pull -q --ff-only origin main >/dev/null 2>&1
  for m in lock snapshot rollback; do
    printf '\n// versión nueva de %s.js (la prueba de la copia fija)\n' "$m" >> "$LAB_AUTHOR_TREE/scripts/setup/harness/$m.js"
  done
  harness_lab_git "$LAB_AUTHOR_TREE" add -A >/dev/null
  GIT_AUTHOR_DATE=2026-11-01T00:00:00Z GIT_COMMITTER_DATE=2026-11-01T00:00:00Z harness_lab_git "$LAB_AUTHOR_TREE" commit -q -m "versión nueva de lock.js, snapshot.js y rollback.js" >/dev/null
  harness_lab_git "$LAB_AUTHOR_TREE" push -q origin main >/dev/null 2>&1
  NUEVO="$(head_de "$LAB_AUTHOR_TREE")"
  grep -q 'versión nueva de lock.js' "$FIJA/lock.js" 2>/dev/null && mal "T12 (armado) la copia fija ya traía la versión nueva antes de actualizar"
  # el update sano: aplica la versión nueva, con el aplicador y la salud en verde
  estado_set "d['last_fetch']=None"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$NUEVO" ] && [ "$(estado "d.get('failed')")" = None ] \
    && ok "T12 el update sano aplicó la versión nueva" || mal "T12 update: rc $RC, árbol $(head_de "$LAB_TREE") (esperado $NUEVO), failed=$(estado "d.get('failed')"): $SALIDA"
  for m in lock snapshot rollback; do
    if cmp -s "$LAB_TREE/scripts/setup/harness/$m.js" "$FIJA/$m.js" && grep -q "versión nueva de $m.js" "$FIJA/$m.js"; then
      ok "T12 $m.js de la copia fija es igual byte a byte al del árbol (la versión nueva)"
    else mal "T12 $m.js de la copia fija no es el del árbol: $(ls -la "$FIJA/$m.js" 2>&1)"; fi
  done
  # una copia abierta (un corte), y la vuelta atrás a ella por la copia fija: bootstrap.js corre program/harness.js
  corte_apply t12
  if [ -n "$CORTADA" ]; then
    SALIDA="$(harness_lab_bootstrap rollback --to "$CORTADA" 2>&1)"; RC=$?
    [ "$RC" = 0 ] && ok "T12 bootstrap.js rollback --to $CORTADA sale 0" || mal "T12 bootstrap.js rollback --to $CORTADA: rc $RC: $SALIDA"
    [ "$(campo "$CORTADA" open)" = False ] && [ "$(campo "$CORTADA" closed_by)" = rollback ] \
      && ok "T12 la vuelta atrás desde la copia fija cerró la copia cortada con «rollback»" || mal "T12 la cortada $CORTADA: open=$(campo "$CORTADA" open) closed_by=$(campo "$CORTADA" closed_by)"
    [ -z "$(abiertas)" ] && ok "T12 ninguna copia abierta después de la vuelta atrás" || mal "T12 quedaron abiertas: $(abiertas | tr '\n' ';')"
  else mal "T12 el corte no dejó ninguna copia abierta: $(tail -3 "$LAB/t12-apply.out" 2>&1)"; fi
  unset TYCON_UPDATE_APPLY
fi

# ═══ T13 · ReleaseMachine_Cut_StartupNamesOpenCopy ══════════════════════════════════════════════════════════════════
if corre T13; then
  export TYCON_UPDATE_APPLY=auto
  # la máquina con versión bajada (el molde de harness-release.test.sh): sin arnés, instala una versión del servidor de
  # juguete en la casa propia del arnés, sin git
  harness_lab_create "$BASE/t13" >/dev/null
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  harness_lab_release_fresh_home
  SALIDA="$(harness install --version latest --yes 2>&1)"; RC=$?
  if [ "$RC" = 0 ] && [ "$(estado "d['sources'][0]['kind']")" = release ]; then
    ok "T13 (armado) la versión bajada quedó instalada (kind: release)"
    # el corte: `harness.js apply` DE LA VERSIÓN INSTALADA, cortado con `kill -9` mientras su aplicador duerme (corte_apply
    # llama a `harness`: mientras dura, `harness` es el programa de la versión instalada)
    harness() { harness_release "$@"; }
    corte_apply t13
    harness() { node "$LAB_TREE/scripts/setup/harness.js" "$@"; }
    if [ -n "$CORTADA" ]; then
      [ "$(campo "$CORTADA" reason)" = apply ] && ok "T13 el corte dejó abierta la copia del apply ($CORTADA)" || mal "T13 la copia abierta $CORTADA es de «$(campo "$CORTADA" reason)»"
      # el arranque siguiente, por el programa de la versión bajada: pasa por su arranque (release.js)
      SALIDA="$(harness_release startup 2>&1)"; RC=$?
      AVISO="$(aviso)"
      case "$AVISO" in *"a medias:"*"copia $CORTADA"*"harness.js rollback --to $CORTADA"*) ok "T13 el arranque nombra la copia cortada y da harness.js rollback --to $CORTADA" ;;
        *) mal "T13 aviso del arranque (rc $RC): «${AVISO}» — $(printf '%s' "$SALIDA" | tail -3)" ;; esac
      # el arranque salió sano: cerró la copia cortada con el nombre de la suya, y el aviso no queda para el próximo
      NUEVA="$(copias | awk '$2=="startup" {print $1; exit}')"
      [ "$(campo "$CORTADA" open)" = False ] && [ -n "$NUEVA" ] && [ "$(campo "$CORTADA" closed_by)" = "$NUEVA" ] \
        && ok "T13 el arranque sano cerró la copia cortada con su nombre ($NUEVA)" || mal "T13 la cortada $CORTADA: open=$(campo "$CORTADA" open) closed_by=$(campo "$CORTADA" closed_by), la del arranque «${NUEVA}»"
      [ -z "$(abiertas)" ] && ok "T13 ninguna copia abierta después del arranque" || mal "T13 quedaron abiertas: $(abiertas | tr '\n' ';')"
      harness_release startup >/dev/null 2>&1
      case "$(aviso)" in *"a medias:"*) mal "T13 el segundo arranque sigue avisando el corte: $(aviso)" ;; *) ok "T13 el segundo arranque ya no trae el aviso del corte" ;; esac
    else mal "T13 el corte no dejó ninguna copia abierta: $(tail -3 "$LAB/t13-apply.out" 2>&1)"; fi
  else mal "T13 (armado) install --version salió $RC (kind $(estado "d['sources'][0]['kind']")): $(printf '%s' "$SALIDA" | tail -5)"; fi
  # el servidor de versiones de juguete corre de fondo: se apaga acá (la salida de la batería mata sólo sus grupos)
  [ -n "${LAB_RELEASE_PROCESS:-}" ] && kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  unset TYCON_UPDATE_APPLY
fi

# ═══ T14 · TakeSnapshot_EveryErrorReturn_ClosesIt (el caso del pase adversarial) ═══════════════════════════════════
if corre T14; then
  # `install --version` sobre una máquina que ya tiene una versión bajada toma su copia antes del cambio; si después no
  # puede escribir el perfil pedido, sale 2. Esa copia tiene que quedar cerrada como «failed»: abierta, el arranque
  # siguiente avisaría un corte que no hubo
  harness_lab_create "$BASE/t14" >/dev/null
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  harness_lab_release_fresh_home
  SALIDA="$(harness install --version latest --yes 2>&1)"; RC=$?
  if [ "$RC" = 0 ] && [ "$(estado "d['sources'][0]['kind']")" = release ]; then
    CONF="$(node -e 'process.stdout.write(require(process.argv[1]).configFile(process.argv[2]))' "$LAB_TREE/scripts/setup/harness/tycon-home.js" "$LAB_HOME")"
    # la configuración no se deja escribir: está rota (el escritor único no escribe sobre un archivo roto)
    printf '{roto\n' > "$CONF"
    ANTES="$(copias | awk '{print $1}' | sort)"
    SALIDA="$(harness install --version latest --profile minimal --yes 2>&1)"; RC=$?
    NUEVA="$(comm -13 <(printf '%s\n' "$ANTES") <(copias | awk '{print $1}' | sort) | tail -1)"
    if [ "$RC" = 2 ] && printf '%s' "$SALIDA" | grep 'no pude escribir el perfil' >/dev/null; then
      ok "T14 install --version con la configuración rota sale 2 y lo dice"
      if [ -n "$NUEVA" ]; then
        [ "$(campo "$NUEVA" open)" = False ] && [ "$(campo "$NUEVA" closed_by)" = failed ] \
          && ok "T14 la copia del install que no pudo seguir ($NUEVA) quedó cerrada como «failed»" \
          || mal "T14 la copia $NUEVA quedó open=$(campo "$NUEVA" open) closed_by=$(campo "$NUEVA" closed_by)"
      else mal "T14 el install no tomó ninguna copia: $(copias | tr '\n' ';') · registro: $(grep 'copia de seguridad' "$(dirname "$(ESTADO)")/harness/harness.log" 2>/dev/null | tail -2)"; fi
      [ -z "$(abiertas)" ] && ok "T14 ninguna copia abierta después del error" || mal "T14 quedaron abiertas: $(abiertas | tr '\n' ';')"
    else mal "T14 install --profile con la configuración rota salió $RC: $(printf '%s' "$SALIDA" | tail -3)"; fi
  else mal "T14 (armado) install --version salió $RC: $(printf '%s' "$SALIDA" | tail -5)"; fi
  [ -n "${LAB_RELEASE_PROCESS:-}" ] && kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  unset TYCON_RELEASE_API TYCON_RELEASE_GIT TYCON_RELEASE_RAW TYCON_RELEASE_ARCHIVE   # el servidor ya no está
fi

if [ "$FALLOS" = 0 ]; then
  if [ "$NO_MEDIDOS" -gt 0 ]; then echo "✅ harness-failures: verde, con $NO_MEDIDOS caso(s) NO MEDIDO(s)"; else echo "✅ harness-failures: todo verde"; fi
  exit 0
fi
echo "❌ harness-failures: $FALLOS fallo(s)"; exit 1
