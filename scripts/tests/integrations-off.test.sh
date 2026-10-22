#!/usr/bin/env bash
# integrations-off.test.sh — sin configuración, las ocho integraciones están APAGADAS: el instalador no
# registra sus hooks ni llama a ningún servicio, y cada comando que las necesitaba termina bien y lo dice
# (T9 Integraciones_SinPerfil_ApagadasYSinLlamadas · T10 Integraciones_ApagadaLoDiceYNoMiente).
#
# La falla que caza, en sus dos caras: para afuera, una integración sin configurar que llama
# a un servicio ajeno o falla en silencio; para el equipo, «PR abiertos: 0» cuando en realidad no se miró nada.
#
# Cómo mide:
#   · HOME temporal con ~/.claude/agent-skills enlazado (es layout, no un servicio), TYCON_PROFILE=0 (sin el perfil
#     del equipo, que el clon interno encuentra por su ubicación) y TYCON_MAILBOX_JSON a un archivo que no existe (la
#     llave del buzón viene con el clon interno; afuera no está). `env -i`: ninguna TYCON_* de quien corre se cuela.
#   · PATH con `az`, `engram`, `curl`, `codex`, `claude` y `codegraph` DE MENTIRA delante del PATH real: anotan cada
#     llamada en $LLAMADAS. Cero líneas = nadie llamó a nada. Se antepone una carpeta, no se copian binarios (dylibs).
#   · El instalador corre SIN --check (con --check el refresco de az y la tanda de fondo ni se intentan) y con los
#     TYCON_NO_* de lo LOCAL (sync de bloques, git hooks, gui, sqlite, examen, rescate…); NUNCA los interruptores de
#     las integraciones (TYCON_NO_AZ_PROJECTS_REFRESH, TYCON_NO_UPLOAD_RUNS, …): eso es lo que se mide.
#   · Control positivo (la contraprueba del propio test): con las llaves prendidas por variable, los siete hooks SÍ se
#     registran y `az` SÍ es llamado. Si el instalador dejara de registrar todo, este bloque lo delata.
# 🔴 Nada acá toca el HOME real ni escribe en agent-skills (se lee) — y se MIDE: al final, la raíz de agent-skills
#    tiene que estar igual que al empezar. Sin la distinción,
#    el instalador registraría clocki, engram y los avisos de nocturnos siempre, y refrescaría `az` con sólo tenerlo.
# T32 SyncBloques_IntegracionRequerida, al final: un bloque del CLAUDE.md que requiere una integración se
#    escribe sólo con ella prendida, y se quita al apagarla.
# Correr: bash scripts/tests/integrations-off.test.sh   (~30 s)

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INST="$RAIZ/scripts/install-tycon-hooks.sh"
CFG="$RAIZ/scripts/lib/tycon-config.js"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
LLAMADAS="$T/llamadas.log"
FALLOS=0; TOTAL=0
ok() { TOTAL=$((TOTAL+1)); echo "✅ integraciones: $1"; }
no() { TOTAL=$((TOTAL+1)); FALLOS=$((FALLOS+1)); echo "❌ integraciones: $1"; }

# agent-skills: TYCON_SKILLS_DIR (raíz o skills/) o ~/.claude/agent-skills. Sin él el instalador aborta.
# 🔴 «No pude preguntar» no es «no está»: la biblioteca tira cuando su vecina está y no carga.
#    Con `2>/dev/null || true` eso saldría como «agent-skills no está en esta máquina». La causa se dice entera.
if ! SK_REPO="$(node -e 'try { console.log(require(process.argv[1]).resolveSkillsDirs(process.env.TYCON_SKILLS_DIR || "").repo); } catch (e) { console.error(String((e && e.message) || e).split("\n")[0]); process.exit(1); }' "$RAIZ/scripts/lib/skills-dir.js" 2> "$T/skills-dir.err")"; then
  echo "integraciones: NO MEDIDO — no pude resolver la carpeta de skills: $(head -n 1 "$T/skills-dir.err")"
  exit 1
fi
if [ -z "$SK_REPO" ] || [ ! -d "$SK_REPO/skills/tycon-pipeline" ]; then
  echo "integraciones: NO MEDIDO — agent-skills no está en esta máquina (TYCON_SKILLS_DIR o ~/.claude/agent-skills): el instalador aborta sin él"
  exit 1
fi
SK_ANTES="$(ls -A "$SK_REPO")"

# ── los binarios de mentira: anotan y salen 0 ─────────────────────────────────────────────────────
FAKEBIN="$T/bin"; mkdir -p "$FAKEBIN"
for b in az engram curl codex claude codegraph; do
  printf '#!/bin/sh\necho "%s $*" >> "${LLAMADAS:?}"\nexit 0\n' "$b" > "$FAKEBIN/$b"; chmod +x "$FAKEBIN/$b"
done

# ── el ambiente «de afuera»: nada configurado, nada del ambiente de quien corre ────────────────────
LOCAL_OFF=(TYCON_NO_CLAUDEMD_SYNC=1 TYCON_NO_COMMANDS_SYNC=1 TYCON_NO_GIT_HOOKS=1 TYCON_NO_GUI_ENV=1 TYCON_NO_SQLITE_CHECK=1
  TYCON_NO_NIGHTLY_EXAM=1 TYCON_NO_THREAD_RESCUE=1 TYCON_NO_COLLECT_FINDINGS=1 TYCON_STAGE_METRICS=0 TYCON_BENCH_DAILY=0
  TYCON_NO_CANONICAL_PATH=1 TYCON_NO_BOOTSTRAP_HEAL=1 TYCON_MAILBOX_URL_BASE=http://127.0.0.1:9)
casa() { # <nombre> → crea una HOME temporal NUEVA con agent-skills enlazado e imprime su ruta
  # Siempre nueva y con `ln -n`: un `ln -s` sobre un enlace a carpeta que ya existe no lo reemplaza, crea el enlace
  # ADENTRO del agent-skills real: `casa rota` dos veces deja ~/.claude/agent-skills/agent-skills
  # apuntando a sí mismo.
  local c; c="$(mktemp -d "$T/$1.XXXXXX")" && mkdir -p "$c/.claude" && ln -sn "$SK_REPO" "$c/.claude/agent-skills" && echo "$c"
}
afuera() { # <casa> [VAR=val ...] -- <cmd...>   (exit code REAL, sin pipes sobre el comando medido)
  # TYCON_THIRD_PARTY=0: la HOME enlaza agent-skills al clon, y el instalador bajaría ahí las skills de terceros
  # TYCON_PARITY_BENCH_DIR: el chequeo de paridad que lanza de fondo dejaría su reporte en .bench/ del clon
  local c="$1"; shift
  local extra=(); while [ $# -gt 0 ] && [ "$1" != "--" ]; do extra+=("$1"); shift; done; shift
  env -i HOME="$c" PATH="$FAKEBIN:$PATH" TMPDIR="$T" LLAMADAS="$LLAMADAS" LANG="${LANG:-en_US.UTF-8}" \
    TYCON_PROFILE=0 TYCON_THIRD_PARTY=0 TYCON_PARITY_BENCH_DIR="$T/parity-bench" TYCON_MAILBOX_JSON="$T/no-hay-llave.json" "${LOCAL_OFF[@]}" ${extra[@]+"${extra[@]}"} "$@"
}
registrado() { grep -q "$2" "$1/.claude/settings.json" 2>/dev/null; }
esperar_llamada() { # <patrón> <segundos>: espera a que aparezca en el registro (las tandas son de fondo)
  local i=0; while [ "$i" -lt "$2" ]; do grep -q "$1" "$LLAMADAS" 2>/dev/null && return 0; sleep 1; i=$((i+1)); done; return 1
}

# ── La suite corre por partes (ninguna suite pasa de 45 s en la validación de una rama). Entera
# —a mano— corre todos los bloques; como parte (`integrations-off.p<k>.test.sh`), sólo los suyos. Lo de afuera de
# los bloques corre siempre: un bloque no puede depender de lo que dejó otro (scripts/tests/lib/suite-parts.sh).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/suite-parts.sh"
suite_parts 2
if suite_part 1; then   # ── parte 1 de 2 ──

# ═════════════════════════════════════════════════════════════════════════════════════════════════
# T9 · el instalador sin perfil: los hooks de las integraciones no se registran y nadie llama a nada
# ═════════════════════════════════════════════════════════════════════════════════════════════════
C1="$(casa apagada)"
rm -f "$LLAMADAS"
afuera "$C1" -- bash "$INST" > "$C1/instalador.out" 2>&1; RC=$?
[ "$RC" -eq 0 ] && ok "T9 el instalador termina bien sin ninguna integración (exit 0)" \
  || no "T9 el instalador salió $RC sin integraciones: $(tail -5 "$C1/instalador.out" | tr '\n' ' ')"
[ -f "$C1/.claude/settings.json" ] || no "T9 el instalador no escribió settings.json en la HOME temporal"

for h in integrations/clockify/scripts/on-prompt.js integrations/clockify/scripts/touch-activity.js engram-pre-commit.sh engram-drift-notice.js \
         dashboard-notice.js dependencies-notice.js retro-staleness-notice.js; do
  if registrado "$C1" "$h"; then no "T9 apagada, y el instalador igual registró $h"; else ok "T9 apagada: $h no se registra"; fi
done
for h in tycon-pipeline/scripts/hook-post-edit.js bench-notice.js failed-query-notice.js tycon-pipeline/scripts/on-pre-commit.js; do
  if registrado "$C1" "$h"; then ok "T9 lo compartido con el núcleo sigue: $h registrado"; else no "T9 $h (núcleo) no se registró"; fi
done
sleep 3   # las tandas de fondo del instalador (si alguna se lanzó) ya escribieron
if [ -s "$LLAMADAS" ]; then no "T9 con todo apagado alguien llamó a un servicio: $(sort -u "$LLAMADAS" | head -5 | tr '\n' ' ')"
else ok "T9 cero llamadas a az/engram/curl/codex/claude/codegraph (incluido el refresco de proyectos del instalador)"; fi
if grep -qE 'integraciones.*apagadas:.*ado.*engram.*codegraph.*mailbox.*codex.*nightly.*telegram' "$C1/instalador.out" \
   && grep -qE 'prendidas: *\(ninguna\)' "$C1/instalador.out"; then ok "T9 el instalador dice en una línea qué integraciones quedaron apagadas"
else no "T9 el instalador no resume las integraciones: $(grep -i 'integraciones' "$C1/instalador.out" | head -2 | tr '\n' ' ')"; fi
# T70 · la línea dice la herramienta de horas, no la llave vieja (InstallerStatusLine_SaysTimeTool)
TIME_NAMES="$(node -e 'const I=require(process.argv[1]);console.log(I.listManifests({dir:process.argv[2]}).manifests.filter((m)=>m.kind==="timeTracking").map((m)=>m.name).join(" "))' "$RAIZ/scripts/lib/integrations.js" "$RAIZ/integrations")"
LINEA="$(grep -m1 'integraciones — prendidas' "$C1/instalador.out")"
VIEJA=0; for n in $TIME_NAMES; do case "$LINEA" in *" $n"*) VIEJA=1 ;; esac; done
if [ "$VIEJA" = 0 ] && grep -q 'herramienta de horas: ninguna' "$C1/instalador.out"; then ok "T70 la línea del instalador dice «herramienta de horas: ninguna» y no lista la llave vieja"
else no "T70 la línea del instalador: «${LINEA}» · $(grep -m1 'herramienta de horas' "$C1/instalador.out")"; fi

# `explain` lista las ocho como apagadas
EXPL="$(afuera "$C1" -- node "$CFG" explain 2>&1)"; RC=$?
[ "$RC" -eq 0 ] || no "T9 explain salió $RC: $(echo "$EXPL" | tail -2 | tr '\n' ' ')"
for i in ado clockify engram codegraph mailbox codex nightly telegram; do
  if echo "$EXPL" | grep -E "^\s+$i\s+apagada" >/dev/null; then ok "T9 explain: $i apagada"; else no "T9 explain no lista $i como apagada: $(echo "$EXPL" | grep -E "^\s+$i " | head -1)"; fi
done

# el despachador de ediciones sigue registrado y NO corre clocki-enforce (Clockify apagada)
mkdir -p "$T/repo/src"; echo x > "$T/repo/src/a.ts"
EVENTO="{\"session_id\":\"t9\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$T/repo/src/a.ts\"},\"cwd\":\"$T/repo\"}"
DISP="$SK_REPO/skills/tycon-pipeline/scripts/hook-post-edit.js"
SAL="$(printf '%s' "$EVENTO" | afuera "$C1" TYCON_GUIDES_DIR="$RAIZ" -- node "$DISP" 2>&1)"; RC=$?
[ "$RC" -eq 0 ] || no "T9 el despachador salió $RC con Clockify apagada: $(echo "$SAL" | head -3 | tr '\n' ' ')"
if echo "$SAL" | grep -i 'clocki' >/dev/null; then no "T9 Clockify apagada y el despachador igual corrió clocki-enforce: $(echo "$SAL" | grep -i clocki | head -1)"
else ok "T9 Clockify apagada: el despachador de ediciones corre y saltea clocki-enforce"; fi
C1b="$(casa apagada-control-clocki)"
SAL="$(printf '%s' "$EVENTO" | afuera "$C1b" TYCON_GUIDES_DIR="$RAIZ" TYCON_CLOCKIFY=1 -- node "$DISP" 2>&1)"
if echo "$SAL" | grep -iE 'clocki|timer' >/dev/null; then ok "T9 control: con TYCON_CLOCKIFY=1 el despachador sí corre clocki-enforce (avisa que no hay timer)"
else no "T9 control: con Clockify prendida el despachador no avisó nada de clocki (¿el test mide algo?): $(echo "$SAL" | head -2 | tr '\n' ' ')"; fi

# ── control positivo: con las llaves por variable, los siete se registran y az SÍ es llamado ──────
C2="$(casa prendida)"
rm -f "$LLAMADAS"
afuera "$C2" TYCON_ADO_ORG=https://dev.azure.com/equipo TYCON_CLOCKIFY=1 TYCON_ENGRAM=1 TYCON_NIGHTLY=1 -- bash "$INST" > "$C2/instalador.out" 2>&1; RC=$?
[ "$RC" -eq 0 ] || no "T9 control: el instalador salió $RC con las llaves prendidas: $(tail -3 "$C2/instalador.out" | tr '\n' ' ')"
for h in integrations/clockify/scripts/on-prompt.js integrations/clockify/scripts/touch-activity.js engram-pre-commit.sh engram-drift-notice.js \
         dashboard-notice.js dependencies-notice.js retro-staleness-notice.js; do
  registrado "$C2" "$h" && ok "T9 control: prendida, $h registrado" || no "T9 control: prendida y $h NO se registró"
done
if esperar_llamada '^az ' 8; then ok "T9 control: con Azure DevOps prendida el instalador refresca la lista de proyectos (az fue llamado)"
else no "T9 control: con Azure DevOps prendida az nunca fue llamado (el registro está vacío: ¿el test mide el refresco?)"; fi
# y apagar después REMUEVE lo registrado (la misma HOME, ahora sin llaves)
afuera "$C2" -- bash "$INST" > "$C2/instalador-2.out" 2>&1
if registrado "$C2" integrations/clockify/scripts/on-prompt.js || registrado "$C2" dashboard-notice.js || registrado "$C2" engram-drift-notice.js; then
  no "T9 al apagar las llaves, el instalador dejó registrados hooks de integraciones apagadas"
else ok "T9 al apagar las llaves, el instalador remueve los hooks que había registrado"; fi
# configuración ROTA: aviso, y los hooks de integraciones quedan como estaban (ni se agregan ni se remueven)
C3="$(casa rota)"
afuera "$C3" TYCON_CLOCKIFY=1 TYCON_NIGHTLY=1 -- bash "$INST" > /dev/null 2>&1
printf '{ "integrations": { "clokify": true } }' > "$C3/.claude/tycon.json"
afuera "$C3" -- bash "$INST" > "$C3/instalador-rota.out" 2>&1; RC=$?
[ "$RC" -eq 0 ] || no "T9 con la configuración rota el instalador salió $RC (un hook de arranque no frena por esto)"
grep -q 'clokify' "$C3/instalador-rota.out" && ok "T9 configuración rota: el instalador nombra el archivo, la clave y el motivo" \
  || no "T9 configuración rota: el instalador no dijo qué está roto: $(grep -i 'config' "$C3/instalador-rota.out" | head -2 | tr '\n' ' ')"
if registrado "$C3" integrations/clockify/scripts/on-prompt.js && registrado "$C3" dashboard-notice.js; then ok "T9 configuración rota: los hooks quedan como estaban (no se lee como «todo apagado»)"
else no "T9 configuración rota: el instalador removió hooks de integraciones (leyó el archivo roto como «todo apagado»)"; fi

# ═════════════════════════════════════════════════════════════════════════════════════════════════
# T10 · cada comando con su integración apagada: exit 0 y una línea que la nombra; nunca «0» ni «nada»
# ═════════════════════════════════════════════════════════════════════════════════════════════════
C4="$(casa comandos)"
rm -f "$LLAMADAS"
dice_apagada() { # <etiqueta> <rc> <salida> <regex de la integración>
  local et="$1" rc="$2" sal="$3" re="$4" linea
  linea="$(echo "$sal" | grep -iE 'apagad' | grep -iE "$re" | head -1)"
  if [ "$rc" -ne 0 ]; then no "T10 $et: salió $rc (tenía que terminar bien y decir que la integración está apagada): $(echo "$sal" | tail -2 | tr '\n' ' ')"; return; fi
  if [ -z "$linea" ]; then no "T10 $et: no dijo que la integración ($re) está apagada: $(echo "$sal" | head -3 | tr '\n' ' ')"; return; fi
  if echo "$linea" | grep -iE 'ninguno|: 0( |$)|\bnada\b' >/dev/null; then no "T10 $et: la línea miente («0»/«nada» sin haber mirado): $linea"; return; fi
  ok "T10 $et: exit 0 y lo dice — $(echo "$linea" | cut -c1-110)"
}

SAL="$(afuera "$C4" -- node "$RAIZ/scripts/nightly/open-prs/open-prs.js" --today 2026-09-26 --out "$T/prs.txt" 2>&1)"; RC=$?
dice_apagada "open-prs.js (Azure DevOps)" "$RC" "$SAL" 'azure devops'
grep -qi 'apagad' "$T/prs.txt" 2>/dev/null && ok "T10 open-prs.js: la sección escrita en --out también lo dice (va al resumen diario)" \
  || no "T10 open-prs.js: la sección en --out no dice que Azure DevOps está apagado: $(cat "$T/prs.txt" 2>/dev/null | head -1)"

SAL="$(afuera "$C4" -- node "$RAIZ/scripts/metrics/upload-runs.js" --dry-run 2>&1)"; RC=$?
dice_apagada "upload-runs.js (buzón)" "$RC" "$SAL" 'buz'
SAL="$(afuera "$C4" -- node "$RAIZ/scripts/metrics/download-runs.js" 2>&1)"; RC=$?
dice_apagada "download-runs.js (buzón)" "$RC" "$SAL" 'buz'

SAL="$(afuera "$C4" TYCON_INSTINCT_NOTIFY=1 -- node "$RAIZ/scripts/instincts/instinct-observer.js" --notify --dry-run 2>&1)"; RC=$?
dice_apagada "instinct-observer.js --notify (Telegram)" "$RC" "$SAL" 'telegram'

SAL="$(afuera "$C4" -- node "$RAIZ/scripts/lib/engram-autoheal.js" 2>&1)"; RC=$?
dice_apagada "engram-autoheal.js (engram)" "$RC" "$SAL" 'engram'
SAL="$(afuera "$C4" -- node "$RAIZ/scripts/setup/engram-rescue-unexported.js" 2>&1)"; RC=$?
dice_apagada "engram-rescue-unexported.js (engram)" "$RC" "$SAL" 'engram'
SAL="$(afuera "$C4" -- bash "$RAIZ/scripts/setup/validate-engram-upgrade.sh" 2>&1)"; RC=$?
dice_apagada "validate-engram-upgrade.sh (engram)" "$RC" "$SAL" 'engram'
SAL="$(afuera "$C4" -- node "$RAIZ/scripts/hooks/engram-drift-notice.js" --force 2>&1)"; RC=$?
dice_apagada "engram-drift-notice.js (engram)" "$RC" "$SAL" 'engram'

SAL="$(afuera "$C4" -- bash "$RAIZ/scripts/ci/validate-pipeline-in-ado.sh" --project Producto --pipeline 1 2>&1)"; RC=$?
dice_apagada "validate-pipeline-in-ado.sh (Azure DevOps)" "$RC" "$SAL" 'azure devops'

# (acá sólo los SERVICIOS de las integraciones: el observador de instintos pregunta por `claude`/`codex` para elegir
#  su modelo, y eso no es una integración)
if grep -qE '^(az|engram|curl) ' "$LLAMADAS" 2>/dev/null; then no "T10 con las integraciones apagadas, algún comando igual llamó a un servicio: $(grep -E '^(az|engram|curl) ' "$LLAMADAS" | sort -u | head -5 | tr '\n' ' ')"
else ok "T10 ningún comando apagado llamó a az/engram/curl"; fi

# el paso de work item (prosa de agent-skills): resuelve la organización por la configuración y, apagada, lo dice y se saltea;
# no hay un «default por proyecto conocido»
for f in skills/tycon-pipeline/steps/step-01-start.md skills/tycon-pipeline/steps/close-work-item.md skills/tycon-ado-story-wi/SKILL.md; do
  p="$SK_REPO/$f"
  if [ ! -f "$p" ]; then echo "  ℹ NO MEDIDO — $f no está en $SK_REPO"; continue; fi
  if grep -qiE 'default por proyecto conocido|defaults conocidos' "$p"; then no "T10 $f: sigue teniendo el «default por proyecto conocido»"; else ok "T10 $f: sin «default por proyecto conocido»"; fi
  if grep -qiE 'Azure DevOps (está )?apagad' "$p" && grep -q 'ado.org' "$p"; then ok "T10 $f: la organización sale de ado.org y, apagada, el paso lo dice y se saltea"
  else no "T10 $f: no resuelve la organización por ado.org ni dice qué hace con Azure DevOps apagado"; fi
done

# ── controles: con la integración PRENDIDA el mismo comando NO dice «apagada» (y sí intenta el servicio) ──
rm -f "$LLAMADAS"
SAL="$(afuera "$C4" TYCON_ADO_ORG=https://dev.azure.com/equipo -- node "$RAIZ/scripts/nightly/open-prs/open-prs.js" --today 2026-09-26 2>&1)"
if echo "$SAL" | grep -i 'apagad' >/dev/null; then no "T10 control: con Azure DevOps prendida, open-prs.js igual dice «apagado»"
elif grep -q '^az ' "$LLAMADAS" 2>/dev/null; then ok "T10 control: con Azure DevOps prendida, open-prs.js consulta az"
else no "T10 control: con Azure DevOps prendida, open-prs.js no consultó az: $(echo "$SAL" | head -2 | tr '\n' ' ')"; fi
SAL="$(afuera "$C4" TYCON_MAILBOX=1 -- node "$RAIZ/scripts/metrics/upload-runs.js" --dry-run 2>&1)"; RC=$?
if echo "$SAL" | grep -i 'apagad' >/dev/null; then no "T10 control: con el buzón prendido por variable y sin llave, upload-runs.js dice «apagado» (tenía que decir que falta la llave)"
elif [ "$RC" -ne 0 ] && echo "$SAL" | grep -i 'llave' >/dev/null; then ok "T10 control: buzón prendido sin llave = el error de siempre (falta la llave, exit $RC), no «apagado»"
else no "T10 control: buzón prendido sin llave: exit $RC — $(echo "$SAL" | tail -1)"; fi
SAL="$(afuera "$C4" TYCON_ENGRAM=1 -- node "$RAIZ/scripts/lib/engram-autoheal.js" 2>&1)"
if echo "$SAL" | grep -i 'apagad' >/dev/null; then no "T10 control: con engram prendida, engram-autoheal.js igual dice «apagada»"; else ok "T10 control: con engram prendida, engram-autoheal.js no dice «apagada»"; fi

# ── T10 · un BUG del lector no se traga ─────────────────────────
# «Sin la lib al lado: como siempre» vale SÓLO cuando la lib no está (MODULE_NOT_FOUND). Un error de verdad dentro del lector
# (acá: un TypeError plantado) tiene que verse: el comando frena con exit ≠ 0 y lo dice; el hook sigue (exit 0) pero lo
# dice. Si seis consumidores lo envolvieran en un catch-all, un bug del lector sería invisible en todos a la vez.
F="$(mktemp -d)"; cp -R "$RAIZ/scripts" "$F/scripts"
printf '%s\n' "throw new TypeError('bug de mentira en el lector');" > "$F/scripts/lib/tycon-config.js"
SAL="$(afuera "$C4" -- node "$F/scripts/lib/engram-autoheal.js" 2>&1)"; RC=$?
if [ "$RC" -ne 0 ] && echo "$SAL" | grep 'bug de mentira' >/dev/null && ! echo "$SAL" | grep -i 'apagad' >/dev/null; then ok "T10 un bug del lector NO se traga: el comando (engram-autoheal.js) frena (exit $RC) y lo dice"
else no "T10 con el lector roto por un bug, engram-autoheal.js salió $RC sin decirlo: $(echo "$SAL" | tail -2 | tr '\n' ' ')"; fi
SAL="$(afuera "$C4" -- node "$F/scripts/hooks/bench-notice.js" 2>&1)"; RC=$?
if [ "$RC" -eq 0 ] && echo "$SAL" | grep 'lector de configuración falló' >/dev/null; then ok "T10 un bug del lector NO se traga: el hook (bench-notice.js) sigue (exit 0) y lo dice"
else no "T10 con el lector roto por un bug, bench-notice.js salió $RC sin decirlo: $(echo "$SAL" | tail -2 | tr '\n' ' ')"; fi
rm -rf "$F"

# ── T10 · configuración ROTA en un comando que carga harness-audit: frena prolijo (exit 2, archivo · clave · motivo), no
#          con una traza sin capturar (exit 1); harness-audit tira al CARGAR el módulo
C5="$(casa rota-engram)"; printf '{ "integrations": { "engram": "si" } }' > "$C5/.claude/tycon.json"
for cmd in "scripts/lib/harness-audit.js --json" "scripts/lib/engram-autoheal.js"; do
  SAL="$(afuera "$C5" -- node $RAIZ/$cmd 2>&1)"; RC=$?
  if [ "$RC" -eq 2 ] && echo "$SAL" | grep 'integrations.engram' >/dev/null &&! echo "$SAL" | grep 'at raizDeLaMaquina\|at Object' >/dev/null; then ok "T10 config rota: ${cmd%% *} frena con exit 2 y nombra la clave, sin traza"
  else no "T10 config rota: ${cmd%% *} salió $RC — $(echo "$SAL" | grep -v '^\s*$' | tail -3 | tr '\n' ' ' | cut -c1-200)"; fi
done

# ── T10 · el interruptor por hook puesto en 1 manda sobre la llave apagada («en los dos sentidos») ──────
#          engram-drift-notice con TYCON_ENGRAM_DRIFT=1 y engram apagada NO dice «apagado» (el instalador lo
#          registra, así que el hook tiene que actuar); el hook de git con TYCON_ENGRAM_HOOK=1 llama a engram (de mentira)
SAL="$(afuera "$C4" TYCON_ENGRAM_DRIFT=1 -- node "$RAIZ/scripts/hooks/engram-drift-notice.js" --force 2>&1)"
if echo "$SAL" | grep -i 'engram apagad' >/dev/null; then no "T10 con TYCON_ENGRAM_DRIFT=1 y la llave apagada, engram-drift-notice igual dice «apagado»"
else ok "T10 TYCON_ENGRAM_DRIFT=1 manda sobre la llave apagada (engram-drift-notice no dice «apagado»)"; fi
R="$T/repo-engram"; mkdir -p "$R"; ( cd "$R" && git init -q . && printf 'proy\n' > .engram-project && mkdir -p .engram && git add -A && git -c user.email=t@t -c user.name=t commit -qm x ) 2>/dev/null
: > "$LLAMADAS"
SAL="$(cd "$R" && afuera "$C4" TYCON_ENGRAM_HOOK=1 TYCON_GUIDES_DIR="$RAIZ" -- bash "$RAIZ/scripts/hooks/git-pre-commit-global.sh" 2>&1)"; RC=$?
if grep -q '^engram sync' "$LLAMADAS" 2>/dev/null && ! echo "$SAL" | grep -i 'engram apagad' >/dev/null; then ok "T10 TYCON_ENGRAM_HOOK=1 manda sobre la llave apagada (el hook de git sincroniza)"
else no "T10 con TYCON_ENGRAM_HOOK=1 y la llave apagada el hook de git no sincronizó (rc $RC): $(echo "$SAL" | tail -2 | tr '\n' ' ' | cut -c1-200) — llamadas: $(cat "$LLAMADAS" 2>/dev/null | tr '\n' ' ' | cut -c1-100)"; fi
: > "$LLAMADAS"
SAL="$(cd "$R" && afuera "$C4" TYCON_GUIDES_DIR="$RAIZ" -- bash "$RAIZ/scripts/hooks/git-pre-commit-global.sh" 2>&1)"
if ! grep -q '^engram' "$LLAMADAS" 2>/dev/null && echo "$SAL" | grep -i 'engram apagad' >/dev/null; then ok "T10 control: sin el interruptor y con la llave apagada, el hook de git no sincroniza y lo dice"
else no "T10 control: sin interruptor y llave apagada el hook de git hizo otra cosa: $(echo "$SAL" | tail -1 | cut -c1-150) — llamadas: $(cat "$LLAMADAS" 2>/dev/null | tr '\n' ' ' | cut -c1-80)"; fi

fi
if suite_part 2; then   # ── parte 2 de 2 ──

# ═════════════════════════════════════════════════════════════════════════════════════════════════
# settings.json como función de la configuración (T1, T2)
# Prender → apagar → prender no deja el hook re-agregado al FINAL de su bloque: el resultado es igual byte a byte a
# una instalación fresca con las mismas llaves.
# ═════════════════════════════════════════════════════════════════════════════════════════════════
# settings.json de una casa con su ruta reemplazada por «CASA»: dos casas distintas se comparan por contenido.
normal() { sed "s#$1#CASA#g" "$1/.claude/settings.json"; }
LLAVES_ON=(TYCON_ENGRAM=1 TYCON_CLOCKIFY=1 TYCON_NIGHTLY=1)
C5="$(casa fresca)"; afuera "$C5" "${LLAVES_ON[@]}" -- bash "$INST" > /dev/null 2>&1
C6="$(casa vaiven)"
afuera "$C6" "${LLAVES_ON[@]}" -- bash "$INST" > /dev/null 2>&1
afuera "$C6" -- bash "$INST" > /dev/null 2>&1
cp "$C6/.claude/settings.json" "$T/antes-de-prender.json"
afuera "$C6" "${LLAVES_ON[@]}" -- bash "$INST" > "$C6/instalador-3.out" 2>&1
if [ -n "$(normal "$C5")" ] && [ "$(normal "$C5")" = "$(normal "$C6")" ]; then ok "T1 prender → apagar → prender deja el mismo settings.json que una instalación fresca con las mismas llaves"
else no "T1 prender → apagar → prender NO da el settings.json de una instalación fresca: $(diff <(normal "$C5") <(normal "$C6") | grep '^[<>]' | head -4 | tr '\n' ' ' | cut -c1-300)"; fi
# La corrida que re-inserta pasó por el backup, y el backup es lo que había antes de prender
BAK="$(ls -t "$C6/.claude/"settings.json.bak.* 2>/dev/null | head -1)"
if [ -n "$BAK" ] && cmp -s "$BAK" "$T/antes-de-prender.json"; then ok "T1 (Task 0) antes de re-insertar el instalador guardó el settings.json anterior, recuperable tal cual"
else no "T1 (Task 0) no hay backup de la corrida que re-insertó, o no es el archivo anterior (${BAK:-sin backup})"; fi

# T2 · un hook ajeno en el medio del bloque del arnés no se mueve
C7="$(casa ajeno)"
afuera "$C7" "${LLAVES_ON[@]}" -- bash "$INST" > /dev/null 2>&1
python3 - "$C7/.claude/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p))
for ev, bloques in s["hooks"].items():
    for b in bloques:
        hs = b.get("hooks", [])
        k = next((j for j, h in enumerate(hs) if "engram-drift-notice" in h.get("command", "")), None)
        if k is not None and k + 1 < len(hs):   # justo DESPUÉS del hook que se apaga y se prende, con hooks del arnés detrás
            hs.insert(k + 1, {"type": "command", "command": "node /opt/ajeno/hook-del-dev.js"})
            json.dump(s, open(p, "w"), indent=2); sys.exit(0)
sys.exit("no encontré un bloque con engram-drift-notice y hooks detrás")
PY
posicion() { python3 - "$1/.claude/settings.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
for ev, bloques in s["hooks"].items():
    for i, b in enumerate(bloques):
        for j, h in enumerate(b.get("hooks", [])):
            if "hook-del-dev.js" in h.get("command", ""): print(f"{ev}/{i}/{j}")
PY
}
P_ANTES="$(posicion "$C7")"
afuera "$C7" -- bash "$INST" > /dev/null 2>&1
afuera "$C7" "${LLAVES_ON[@]}" -- bash "$INST" > /dev/null 2>&1
P_DESPUES="$(posicion "$C7")"
if [ -n "$P_ANTES" ] && [ "$P_ANTES" = "$P_DESPUES" ]; then ok "T2 el hook ajeno queda donde estaba ($P_ANTES) tras apagar y prender"
else no "T2 el hook ajeno se movió: antes=${P_ANTES:-ausente} después=${P_DESPUES:-ausente}"; fi

# ═════════════════════════════════════════════════════════════════════════════════════════════════
# T32 SyncBloques_IntegracionRequerida — un bloque del CLAUDE.md que requiere una integración
# Sin esto, el sync escribiría todos los bloques siempre; afuera, sin Azure DevOps, cada sesión cargaría
# igual la regla sobre un servicio que no usa. El bloque lo declara en su primera línea
# (`<!-- requires-integration: ado -->`) y el sync pregunta al lector de configuración.
# Se llama al sync DIRECTO y sin TYCON_NO_CLAUDEMD_SYNC (el ayudante `afuera` lo apaga con LOCAL_OFF).
# ═════════════════════════════════════════════════════════════════════════════════════════════════
SYNC="$RAIZ/scripts/setup/sync-claude-md-blocks.sh"
B_ADO=ado-runs-list-lag
ADO_ON=TYCON_ADO_ORG=https://dev.azure.com/equipo
SEED='# notas del dev\n\nuna regla escrita a mano\n'
home32() { # <nombre> [seed] → HOME temporal nueva; con `seed`, con un CLAUDE.md escrito a mano
  local c; c="$(mktemp -d "$T/t32-$1.XXXXXX")" && mkdir -p "$c/.claude" || return 1
  [ "${2:-}" = seed ] && printf "$SEED" > "$c/.claude/CLAUDE.md"
  echo "$c"
}
sync32() { # <casa> [VAR=val ...] [-- <args del sync>] → corre el sync de $SYNC32 (por defecto el real); exit code REAL
  local c="$1"; shift
  local extra=(); while [ $# -gt 0 ] && [ "$1" != "--" ]; do extra+=("$1"); shift; done; [ $# -gt 0 ] && shift
  env -i HOME="$c" PATH="${PATH32:-$PATH}" TMPDIR="$T" LANG="${LANG:-en_US.UTF-8}" TYCON_PROFILE=0 \
    ${extra[@]+"${extra[@]}"} bash "${SYNC32:-$SYNC}" "$@"
}
has_block() { grep -q "TYCON_BLOCK:$2 START" "$1" 2>/dev/null; }   # <archivo> <bloque>
seed_stale() { # <archivo> <bloque>: agrega el bloque a mano, con un cuerpo viejo (el sync lo encuentra por el prefijo del marcador)
  printf '\n<!-- TYCON_BLOCK:%s START -->\nVIEJO\n<!-- TYCON_BLOCK:%s END -->\n' "$2" "$2" >> "$1"
}

# ── apagada: el bloque no está; lo demás sí (el espejo) ──
N="$(home32 never seed)"; MD_N="$N/.claude/CLAUDE.md"
SAL="$(sync32 "$N" 2>&1)"; RC=$?
[ "$RC" -eq 0 ] || no "T32 el sync salió $RC con Azure DevOps apagado: $(echo "$SAL" | tail -2 | tr '\n' ' ')"
if has_block "$MD_N" "$B_ADO"; then no "T32 Azure DevOps apagado y el sync igual escribió el bloque $B_ADO"
else ok "T32 Azure DevOps apagado: el bloque $B_ADO no se escribe"; fi
if has_block "$MD_N" response-style && has_block "$MD_N" tool-names && has_block "$MD_N" background-execution; then ok "T32 espejo: los bloques que no requieren integración se escriben igual"
else no "T32 con Azure DevOps apagado faltan bloques que no requieren nada: $(grep -c 'TYCON_BLOCK:.* START' "$MD_N" 2>/dev/null) de 3"; fi
cp "$MD_N" "$T/t32-never.md"
SAL="$(sync32 "$N" 2>&1)"
if [ -z "$SAL" ] && cmp -s "$MD_N" "$T/t32-never.md"; then ok "T32 apagada y ausente: la segunda ejecución no dice nada ni toca el archivo"
else no "T32 apagada y ausente, la segunda ejecución habló o escribió: $(echo "$SAL" | head -2 | tr '\n' ' ')"; fi

# ── prendida: el bloque está, sin el comentario; apagada otra vez: se va y el resto queda byte a byte ──
V="$(home32 cycle seed)"; MD_V="$V/.claude/CLAUDE.md"
sync32 "$V" "$ADO_ON" > "$V/on.out" 2>&1
if has_block "$MD_V" "$B_ADO"; then ok "T32 con TYCON_ADO_ORG el bloque $B_ADO se escribe"
else no "T32 con TYCON_ADO_ORG el bloque $B_ADO no se escribió: $(head -2 "$V/on.out" | tr '\n' ' ')"; fi
if grep -q 'requires-integration' "$MD_V"; then no "T32 el comentario requires-integration se copió al CLAUDE.md"
elif head -1 "$RAIZ/claude-md-blocks/$B_ADO.md" | grep -x '<!-- requires-integration: ado -->' >/dev/null; then ok "T32 el bloque declara su integración en la primera línea y el comentario no llega al CLAUDE.md"
else no "T32 claude-md-blocks/$B_ADO.md no declara «<!-- requires-integration: ado -->» en su primera línea"; fi
SAL="$(sync32 "$V" 2>&1)"; RC=$?
if [ "$RC" -eq 0 ] && ! has_block "$MD_V" "$B_ADO" && echo "$SAL" | grep "$B_ADO" | grep 'integración «ado» apagada' >/dev/null; then ok "T32 apagada con el bloque ya escrito: el sync lo quita y lo dice"
else no "T32 apagada con el bloque ya escrito: sigue ahí o no se dijo (rc $RC): $(echo "$SAL" | head -2 | tr '\n' ' ')"; fi
if cmp -s "$MD_V" "$T/t32-never.md"; then ok "T32 «lo tuvo y se apagó» es byte a byte «nunca lo tuvo» (lo escrito a mano y los otros bloques, intactos)"
else no "T32 «lo tuvo y se apagó» difiere de «nunca lo tuvo»: $(diff "$T/t32-never.md" "$MD_V" | grep '^[<>]' | head -3 | tr '\n' ' ' | cut -c1-240)"; fi
# el bloque agregado al FINAL (apagada → prendida → apagada) también se va sin dejar rastro
sync32 "$N" "$ADO_ON" > /dev/null 2>&1; sync32 "$N" > /dev/null 2>&1
if cmp -s "$MD_N" "$T/t32-never.md"; then ok "T32 apagada → prendida → apagada: el archivo vuelve byte a byte a como estaba"
else no "T32 apagada → prendida → apagada no vuelve al mismo archivo: $(diff "$T/t32-never.md" "$MD_N" | grep '^[<>]' | head -3 | tr '\n' ' ' | cut -c1-240)"; fi
# la máquina limpia (sin CLAUDE.md previo): el mismo ida y vuelta
N0="$(home32 clean-never)"; V0="$(home32 clean-cycle)"
sync32 "$N0" > /dev/null 2>&1; sync32 "$V0" "$ADO_ON" > /dev/null 2>&1; sync32 "$V0" > /dev/null 2>&1
if [ -s "$N0/.claude/CLAUDE.md" ] && cmp -s "$N0/.claude/CLAUDE.md" "$V0/.claude/CLAUDE.md"; then ok "T32 sin CLAUDE.md previo: «lo tuvo y se apagó» también es byte a byte «nunca lo tuvo»"
else no "T32 sin CLAUDE.md previo el ida y vuelta deja otro archivo: $(diff "$N0/.claude/CLAUDE.md" "$V0/.claude/CLAUDE.md" 2>&1 | head -3 | tr '\n' ' ' | cut -c1-240)"; fi

# ── el espejo «lo sano sí pasa»: con Azure DevOps prendido, el CLAUDE.md es byte a byte el de antes del cambio ──
#    (armado acá por separado: cada bloque sin su comentario, con el recorte y los marcadores de siempre)
E="$(home32 team)"
sync32 "$E" "$ADO_ON" > /dev/null 2>&1
python3 - "$RAIZ/claude-md-blocks" "$T/t32-expected.md" <<'PY'
import glob, os, sys
out = ""
for p in sorted(glob.glob(os.path.join(sys.argv[1], "*.md"))):
    n = os.path.splitext(os.path.basename(p))[0]
    lines = open(p, encoding="utf-8").read().split("\n")
    # los marcadores de las primeras líneas no se copian (requires-integration; desde la story 8.16, también requires-profile)
    while lines and (lines[0].startswith("<!-- requires-integration:") or lines[0].startswith("<!-- requires-profile:")):
        lines = lines[1:]
    # un bloque que declara sus variantes (story 2.31) trae el texto de la que elige la configuración: sin perfil, la
    # neutra en castellano, con el tope de su estilo (2000) y sus renglones (20)
    if lines and lines[0].startswith("<!-- variants: response -->"):
        lines = open(os.path.join(sys.argv[1], n, "neutral.es.md"), encoding="utf-8").read().split("\n")
        while lines and lines[0].startswith("<!-- requires-"):
            lines = lines[1:]
        lines = "\n".join(lines).replace("{{max_chars}}", "2000").replace("{{max_lines}}", "20").split("\n")
    # las filas con su integración (story 2.31): acá sólo Azure DevOps está prendido; las otras filas marcadas no van y
    # la marca nunca se copia
    import re
    fila = re.compile(r"^(.*\|)[ \t]*<!--\s*integration:\s*([a-z]+)\s*-->\s*$")
    lines = [(fila.match(l).group(1).rstrip() if fila.match(l) else l) for l in lines if not (fila.match(l) and fila.match(l).group(2) != "ado")]
    # el lugar de las filas de la herramienta de horas: acá no hay ninguna elegida, así que no queda nada
    lines = [l for l in lines if not re.match(r"^<!--\s*time-tool-rows\s*-->\s*$", l)]
    start = ("<!-- TYCON_BLOCK:%s START — generado por scripts/setup/sync-claude-md-blocks.sh del arnés · "
             "NO EDITAR A MANO (se pisa en el próximo SessionStart); editá claude-md-blocks/%s.md y commiteá -->" % (n, n))
    out = out.rstrip("\n") + "\n\n" + start + "\n" + "\n".join(lines).strip("\n") + "\n<!-- TYCON_BLOCK:%s END -->\n" % n
open(sys.argv[2], "wb").write(out.encode("utf-8"))
PY
if [ -s "$T/t32-expected.md" ] && cmp -s "$E/.claude/CLAUDE.md" "$T/t32-expected.md"; then ok "T32 espejo: con Azure DevOps prendido el CLAUDE.md es byte a byte el de antes (los cuatro bloques, sin el comentario)"
else no "T32 con Azure DevOps prendido el CLAUDE.md no es el de antes: $(diff "$T/t32-expected.md" "$E/.claude/CLAUDE.md" 2>&1 | grep '^[<>]' | head -3 | tr '\n' ' ' | cut -c1-240)"; fi

# ── --check sólo avisa ──
K="$(home32 check)"; MD_K="$K/.claude/CLAUDE.md"
sync32 "$K" "$ADO_ON" > /dev/null 2>&1; cp "$MD_K" "$T/t32-check.md"
SAL="$(sync32 "$K" -- --check 2>&1)"
if echo "$SAL" | grep "$B_ADO" | grep 'sobra (integración «ado» apagada)' >/dev/null && cmp -s "$MD_K" "$T/t32-check.md"; then ok "T32 --check con el bloque de una integración apagada: avisa que sobra y no toca el archivo"
else no "T32 --check no avisó «sobra (integración «ado» apagada)» o escribió: $(echo "$SAL" | head -2 | tr '\n' ' ')"; fi
SAL="$(sync32 "$K" "$ADO_ON" -- --check 2>&1)"
if [ -z "$SAL" ]; then ok "T32 espejo: --check con Azure DevOps prendido y el bloque al día no dice nada"
else no "T32 --check con todo al día habló: $(echo "$SAL" | head -2 | tr '\n' ' ')"; fi

# ── el espejo de Codex sigue al CLAUDE.md, y un bloque quitado no se anota como pieza ──
X="$(home32 codex)"; AG_X="$X/.codex/AGENTS.md"
sync32 "$X" "$ADO_ON" TYCON_CODEX=1 TYCON_REPORT_PIECES="$X/pieces-on.txt" > /dev/null 2>&1
if has_block "$AG_X" "$B_ADO" && ! grep -q 'requires-integration' "$AG_X" && grep -q "TYCON_BLOCK:$B_ADO\$" "$X/pieces-on.txt" 2>/dev/null; then ok "T32 prendida: el espejo de Codex trae el bloque (sin el comentario) y el bloque se anota como pieza"
else no "T32 prendida: el espejo de Codex no trae el bloque, trae el comentario, o el bloque no se anotó como pieza"; fi
sync32 "$X" TYCON_CODEX=1 TYCON_REPORT_PIECES="$X/pieces-off.txt" > /dev/null 2>&1
if ! has_block "$AG_X" "$B_ADO" && has_block "$AG_X" response-style; then ok "T32 apagada: el bloque se va también del espejo de Codex (y los otros quedan)"
else no "T32 apagada: el espejo de Codex conserva el bloque $B_ADO o perdió los otros"; fi
if ! grep -q "TYCON_BLOCK:$B_ADO" "$X/pieces-off.txt" 2>/dev/null && grep -q 'TYCON_BLOCK:response-style$' "$X/pieces-off.txt" 2>/dev/null; then ok "T32 apagada: el bloque quitado no se anota como pieza (los que quedan, sí)"
else no "T32 apagada: el reporte de piezas nombra el bloque quitado, o no nombra los que quedan: $(tr '\n' ' ' < "$X/pieces-off.txt" 2>/dev/null | cut -c1-200)"; fi

# ── no saber no es «apagada»: configuración rota → no se agrega si falta; queda y se actualiza si está; una línea lo dice ──
R1="$(home32 broken-absent)"; R2="$(home32 broken-present seed)"
for c in "$R1" "$R2"; do printf '{ "integrations": { "clokify": true } }' > "$c/.claude/tycon.json"; done
seed_stale "$R2/.claude/CLAUDE.md" "$B_ADO"
SAL="$(sync32 "$R1" 2>&1)"; RC=$?
# los otros tres bloques piden el perfil full: con la configuración rota tampoco se sabe el
# perfil, así que tampoco se agregan, y cada uno lo dice en su línea
if [ "$RC" -eq 0 ] && ! has_block "$R1/.claude/CLAUDE.md" "$B_ADO" && ! has_block "$R1/.claude/CLAUDE.md" response-style \
   && [ "$(echo "$SAL" | grep "$B_ADO" | grep -c 'integración «ado»')" = 1 ] && echo "$SAL" | grep "'response-style'" | grep 'perfil' >/dev/null; then ok "T32 configuración rota y bloque ausente: no se agrega (tampoco los del perfil), y una línea lo dice por cada uno"
else no "T32 configuración rota y bloque ausente (rc $RC): $(echo "$SAL" | grep "$B_ADO" | head -2 | tr '\n' ' ' | cut -c1-240)"; fi
SAL="$(sync32 "$R2" 2>&1)"
if has_block "$R2/.claude/CLAUDE.md" "$B_ADO" && ! grep -q '^VIEJO$' "$R2/.claude/CLAUDE.md" && ! grep -q 'requires-integration' "$R2/.claude/CLAUDE.md" \
   && [ "$(echo "$SAL" | grep "$B_ADO" | grep -c 'integración «ado»')" = 1 ]; then ok "T32 configuración rota y bloque presente: queda, se actualiza, y una línea lo dice (no se lee como «apagada»)"
else no "T32 configuración rota y bloque presente: se quitó, no se actualizó o no se dijo: $(echo "$SAL" | head -3 | tr '\n' ' ' | cut -c1-240)"; fi

# ── sin node el lector no contesta: lo mismo ──
if env -i PATH=/usr/bin:/bin /bin/sh -c 'command -v node' > /dev/null 2>&1 || ! env -i PATH=/usr/bin:/bin python3 -c 'pass' > /dev/null 2>&1; then
  echo "  ℹ NO MEDIDO — T32 sin node: /usr/bin:/bin trae node o no trae python3 en esta máquina"
else
  S1="$(home32 no-node-absent)"; S2="$(home32 no-node-present seed)"; seed_stale "$S2/.claude/CLAUDE.md" "$B_ADO"
  SAL="$(PATH32=/usr/bin:/bin sync32 "$S1" "$ADO_ON" 2>&1)"
  # (sin node tampoco se sabe el perfil, así que el bloque de estilo tampoco se agrega)
  if ! has_block "$S1/.claude/CLAUDE.md" "$B_ADO" && ! has_block "$S1/.claude/CLAUDE.md" response-style && echo "$SAL" | grep "$B_ADO" | grep 'node' >/dev/null; then ok "T32 sin node y bloque ausente: no se agrega (tampoco los del perfil), y la línea nombra node"
  else no "T32 sin node y bloque ausente: $(echo "$SAL" | head -2 | tr '\n' ' ' | cut -c1-240)"; fi
  SAL="$(PATH32=/usr/bin:/bin sync32 "$S2" 2>&1)"
  if has_block "$S2/.claude/CLAUDE.md" "$B_ADO" && ! grep -q '^VIEJO$' "$S2/.claude/CLAUDE.md" && echo "$SAL" | grep "$B_ADO" | grep 'node' >/dev/null; then ok "T32 sin node y bloque presente: queda, se actualiza, y la línea nombra node"
  else no "T32 sin node y bloque presente: $(echo "$SAL" | head -3 | tr '\n' ' ' | cut -c1-240)"; fi
fi

# ── integración desconocida (árbol de laboratorio: el sync, el lector y dos bloques de juguete) ──
LAB="$T/t32-lab"; mkdir -p "$LAB/scripts/setup" "$LAB/claude-md-blocks"
cp -R "$RAIZ/scripts/lib" "$LAB/scripts/lib"; cp "$SYNC" "$LAB/scripts/setup/"
printf '<!-- requires-integration: zeta -->\n# regla de zeta\ntexto de zeta\n' > "$LAB/claude-md-blocks/zeta.md"
printf '# regla común\ntexto común\n' > "$LAB/claude-md-blocks/common.md"
D1="$(home32 unknown-absent)"; D2="$(home32 unknown-present seed)"; seed_stale "$D2/.claude/CLAUDE.md" zeta
SAL="$(SYNC32="$LAB/scripts/setup/sync-claude-md-blocks.sh" sync32 "$D1" 2>&1)"
if ! has_block "$D1/.claude/CLAUDE.md" zeta && has_block "$D1/.claude/CLAUDE.md" common && echo "$SAL" | grep "'zeta'" | grep 'integración «zeta»' >/dev/null; then ok "T32 integración desconocida y bloque ausente: no se agrega, lo demás sí, y una línea lo dice"
else no "T32 integración desconocida y bloque ausente: $(echo "$SAL" | head -2 | tr '\n' ' ' | cut -c1-240)"; fi
SAL="$(SYNC32="$LAB/scripts/setup/sync-claude-md-blocks.sh" sync32 "$D2" 2>&1)"
if has_block "$D2/.claude/CLAUDE.md" zeta && grep -q '^texto de zeta$' "$D2/.claude/CLAUDE.md" && ! grep -q '^VIEJO$' "$D2/.claude/CLAUDE.md" \
   && ! grep -q 'requires-integration' "$D2/.claude/CLAUDE.md" && echo "$SAL" | grep "'zeta'" | grep 'integración «zeta»' >/dev/null; then ok "T32 integración desconocida y bloque presente: queda, se actualiza (sin el comentario), y una línea lo dice"
else no "T32 integración desconocida y bloque presente: $(echo "$SAL" | head -3 | tr '\n' ' ' | cut -c1-240)"; fi

# ── un marcador CASI bien escrito ──
# Con otra forma (mayúsculas, guion, dos nombres) o fuera de la primera línea, el bloque pasaría por un bloque común: se
# escribiría con la integración apagada y el comentario se copiaría al CLAUDE.md, sin una palabra. Es «no se sabe»: no se
# agrega, queda si estaba, el comentario nunca se copia y una línea lo dice. Un BOM delante no cambia nada.
LAB2="$T/t32-lab2"; mkdir -p "$LAB2/scripts/setup" "$LAB2/claude-md-blocks"
cp -R "$RAIZ/scripts/lib" "$LAB2/scripts/lib"; cp "$SYNC" "$LAB2/scripts/setup/"
printf '<!-- requires-integration: ADO -->\n# regla\ntexto de upper\n' > "$LAB2/claude-md-blocks/upper.md"
printf '<!-- requires-integration: ado-org -->\n# regla\ntexto de dashed\n' > "$LAB2/claude-md-blocks/dashed.md"
printf '<!-- requires-integration: ado, clockify -->\n# regla\ntexto de multi\n' > "$LAB2/claude-md-blocks/multi.md"
printf '\n<!-- requires-integration: ado -->\n# regla\ntexto de blank\n' > "$LAB2/claude-md-blocks/blank.md"
printf '\357\273\277<!-- requires-integration: ado -->\n# regla\ntexto de bom\n' > "$LAB2/claude-md-blocks/bom.md"
printf '<!-- una nota cualquiera -->\n# regla común\ntexto de plain\n' > "$LAB2/claude-md-blocks/plain.md"
M1="$(home32 marker-absent)"
SAL="$(SYNC32="$LAB2/scripts/setup/sync-claude-md-blocks.sh" sync32 "$M1" 2>&1)"; MD_M="$M1/.claude/CLAUDE.md"
MAL=""
for b in upper dashed multi blank; do
  has_block "$MD_M" "$b" && MAL="$MAL $b(se escribió)"
  echo "$SAL" | grep "'$b'" | grep 'mal escrito' >/dev/null || MAL="$MAL $b(sin aviso)"
done
if [ -z "$MAL" ] && ! grep -q 'requires-integration' "$MD_M" 2>/dev/null; then ok "T32 un marcador casi bien escrito (mayúsculas, guion, dos nombres, fuera de la primera línea): el bloque no se agrega, el comentario no se copia y una línea lo dice"
else no "T32 marcador casi bien escrito:$MAL · $(grep -c 'requires-integration' "$MD_M" 2>/dev/null) comentario(s) copiado(s)"; fi
if ! has_block "$MD_M" bom && ! echo "$SAL" | grep "'bom'" >/dev/null; then ok "T32 un BOM delante del marcador no cambia nada: con la integración apagada el bloque no se escribe (y sin aviso: está bien escrito)"
else no "T32 con BOM delante del marcador: $(has_block "$MD_M" bom && echo 'el bloque se escribió') $(echo "$SAL" | grep "'bom'" | head -1 | cut -c1-160)"; fi
if has_block "$MD_M" plain && grep -q '^<!-- una nota cualquiera -->$' "$MD_M"; then ok "T32 el espejo: un bloque cuya primera línea es otro comentario es un bloque común (se escribe entero)"
else no "T32 el espejo: un bloque con otro comentario en su primera línea no se escribió entero"; fi
M2="$(home32 marker-present seed)"; seed_stale "$M2/.claude/CLAUDE.md" upper
SAL="$(SYNC32="$LAB2/scripts/setup/sync-claude-md-blocks.sh" sync32 "$M2" 2>&1)"
if has_block "$M2/.claude/CLAUDE.md" upper && grep -q '^texto de upper$' "$M2/.claude/CLAUDE.md" && ! grep -q 'requires-integration' "$M2/.claude/CLAUDE.md" \
   && echo "$SAL" | grep "'upper'" | grep 'mal escrito' >/dev/null; then ok "T32 marcador mal escrito y bloque presente: queda, se actualiza sin el comentario, y una línea lo dice"
else no "T32 marcador mal escrito y bloque presente: $(echo "$SAL" | head -3 | tr '\n' ' ' | cut -c1-240)"; fi

fi   # ── fin de los bloques: lo que sigue corre en todas las partes ──

# ── lo prometido en la cabecera: agent-skills se lee, no se escribe ────────────────────────────────
SK_DESPUES="$(ls -A "$SK_REPO")"
if [ "$SK_ANTES" = "$SK_DESPUES" ]; then ok "agent-skills quedó como estaba: el test sólo lo lee"
else no "el test escribió en agent-skills ($SK_REPO): $(diff <(echo "$SK_ANTES") <(echo "$SK_DESPUES") | grep '^[<>]' | tr '\n' ' ' | cut -c1-200)"; fi

echo
[ "$FALLOS" -eq 0 ] && { echo "integraciones-apagadas: todo verde ($TOTAL chequeos)"; exit 0; }
echo "integraciones-apagadas: $FALLOS de $TOTAL en rojo"; exit 1
