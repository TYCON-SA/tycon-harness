#!/usr/bin/env bash
# harness-health.test.sh — la comprobación de salud después de aplicar una versión (story 8.13, tanda C · T25, AC 21).
#
# Lo que no se puede perder:
#   T25 · una versión nueva que deja la máquina rota NO se da por buena porque el aplicador salió 0. Cuatro roturas: un
#         `PreToolUse` que sale 2 en todo (deja una máquina sin Bash), un hook con error de sintaxis, `harness.js` roto, y
#         la suite rápida del aplicador que imprime «FALLÓ». En cada una: restaurada por piezas (hooks y bloques como en
#         la versión anterior), las fuentes de vuelta en la anterior y en `main`, `failed` anotado con su `reason` y las
#         puntas que fallaron, dos `startup` seguidos NO reintentan el mismo commit, `update --yes` sí, `doctor` en rojo,
#         y la copia fija de arranque sin refrescar (mismo sha256). Una versión sana: `last_health` escrito y la copia
#         fija refrescada (con `program/harness.js`). Un `merge` a medias («unable to unlink», simulado con un
#         directorio del árbol sin permiso de escritura) es `interrupted`: restaura y SÍ reintenta en el arranque
#         siguiente.
#   UNIT · `health.check` directo (scripts/setup/harness/health.js): un hook por evento —el primero registrado— con su
#         payload mínimo desde un repo vacío temporal que se borra; sale 2 = falla, tope vencido = aviso; `node --check` /
#         `bash -n` de cada hook del reporte (`@tcg:x` → árbol, lo demás → agent-skills); «FALLÓ» en la salida del
#         aplicador; `doctor --json` con `fail` (o que no responde) = falla.
#   T99 · (story 8.17, tanda W3a) en Windows la sintaxis de un hook `.sh` se revisa con el bash de Git, nunca con el
#         `bash` del PATH (puede ser el lanzador de WSL); sin el de Git, aviso «sin comprobar» y no falla; un `.sh` con
#         `\r\n` es un AVISO con el guion y el remedio, nunca una falla (está en el disco del clon: volver atrás no lo
#         arregla), y uno que no se puede leer es «sin comprobar»; y el primer `.sh` de un evento se lanza con ese bash,
#         no con cmd.exe. En Mac y Linux, como antes.
#   EPIPE · un hook que sale sin leer su payload corrió: el EPIPE que trae spawnSync con el código de salida no es «no pude
#         lanzarlo» (era un aviso falso de a ratos, y el rojo inestable de T99 en public-ci).
#
# Nota de laboratorio (el Given/Fixture de la story ya lo dice así): con `chmod 000` git no puede ni mirar el archivo y el
# merge falla con «would be overwritten by merge» (bloqueada, no interrumpida). El texto que decide `interrupted` («unable to unlink»)
# sale con el directorio sin permiso de ESCRITURA (`chmod 555`), que es lo que se usa acá. Como root (CI en contenedor)
# los permisos no frenan nada: ese caso se omite y se dice.
#
# Laboratorio: scripts/tests/lib/harness-lab.sh. Nunca ~/.claude ni el checkout real. 🔴 Sin pipes sobre el comando medido.
#
#   T38 · (story 8.18, AC 35 y 37) la salud en las tres formas de máquina que deja la unión de los dos repos: un hook de
#         skills llega, se registra con la ruta fija ~/.claude/agent-skills y la salud pasa; en la máquina re-apuntada un
#         hook roto hace volver las DOS fuentes al mismo commit; y una mudanza que no pudo pasar no tira abajo la salud.
#
# Uso: bash scripts/tests/harness-health.test.sh [--only T25|T25-DENY|T25-SYNTAX|T25-HARNESS|T25-SUITE|T25-SANA|T25-INTERRUPTED|UNIT|T38|T38-PROFILE|T99|EPIPE]
#   (T38 de la story 8.18 y T38-PROFILE de la 8.16, tanda C: la salud en minimal, con eventos sin hooks)
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ] || [ "${1%%-*}" = "$ONLY" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
BASE="$(mktemp -d "${TMPDIR:-/tmp}/harness-health.XXXXXX")"
case "$BASE" in *tycon-claude-guides*|*agent-skills*|*/.claude*) echo "❌ harness-health: el laboratorio cayó en ${BASE}"; exit 1 ;; esac
trap 'chmod -R u+rwx "$BASE" 2>/dev/null; rm -rf "$BASE"' EXIT
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
ESTADO() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"; }
estado() { j "$(ESTADO)" "$1"; }
estado_set() { python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p, encoding='utf-8')); $1; json.dump(d, open(p,'w', encoding='utf-8'), indent=2)" "$(ESTADO)"; }
head_de() { harness_lab_git "$1" rev-parse HEAD; }
rama_de() { harness_lab_git "$1" rev-parse --abbrev-ref HEAD; }
# las corridas del aplicador de juguete con un VERSION dado (prueba de que se intentó esa versión)
corridas_v() { local n; n="$(grep -c "^run check=0 .*version=$1 at=" "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>/dev/null)"; echo "${n:-0}"; }
# todos los hooks de settings.json, «EVENTO|command», ordenados
hooks_settings() {
  python3 -c 'import json,sys
s=json.load(open(sys.argv[1], encoding="utf-8"))
out=[]
for ev,bl in (s.get("hooks") or {}).items():
    for b in bl:
        for h in b.get("hooks",[]): out.append(ev+"|"+h.get("command",""))
print("\n".join(sorted(out)))' "$TYCON_SETTINGS_PATH"
}
bloques() { grep -o 'TYCON_BLOCK:[^ ]* START' "$CLAUDE_MD_PATH" 2>/dev/null | LC_ALL=C sort; }
# la copia fija de arranque: bootstrap* y program/ (sin copias de seguridad, registro ni candado)
copia_fija_hash() {
  ( cd "$LAB_HOME/.claude/.tycon-pipeline/harness" 2>/dev/null || exit 0
    { find . -maxdepth 1 -type f -name 'bootstrap*'; [ -d program ] && find ./program -type f; } | LC_ALL=C sort | while IFS= read -r f; do
      printf '%s ' "$f"; shasum -a 256 < "$f"; done ) | shasum -a 256 | cut -d' ' -f1
}
sha_de() { shasum -a 256 < "$1" 2>/dev/null | cut -d' ' -f1; }
# una versión nueva del árbol: VERSION y un comentario en bootstrap.js (si la copia fija se refrescara, se vería);
# con «harness», además, harness.js queda con un error de sintaxis
publicar_version() { # publicar_version <n> [harness]
  local v="$1" a="$LAB_AUTHOR_TREE"
  harness_lab_git "$a" pull -q --ff-only origin main >/dev/null 2>&1 || true
  printf '%s\n' "$v" > "$a/VERSION"
  printf '// versión de laboratorio %s\n' "$v" >> "$a/scripts/setup/harness/bootstrap.js"
  [ "${2:-}" = harness ] && printf '\n)( harness.js roto a propósito (T25) ;\n' >> "$a/scripts/setup/harness.js"
  harness_lab_git "$a" add -A >/dev/null
  harness_lab_git "$a" commit -q -m "versión $v" >/dev/null
  harness_lab_git "$a" push -q origin main >/dev/null 2>&1
}
# un arranque que de verdad sale a la red (sin el «< 10 min» de last_fetch)
arranque() { estado_set "d['last_fetch']=None"; harness startup; }
export TYCON_UPDATE_APPLY=auto   # la política del equipo, sin perfil en el laboratorio: startup aplica

# ═══ T25 · Health_AfterApply_BrokenHookOrHarness_AutoRestore_NoRetry — las cuatro roturas ═════════════════════════════
caso_roto() { # caso_roto <id> <deny|syntax|harness|suite> <reasons aceptadas, separadas por |>
  local id="$1" tipo="$2" reasons="$3" suite="" SALIDA RC V1_T V1_S V2_T V2_S HOOKS_V1 BLOQUES_V1 COPIA_V1 N2 R
  echo "· $id ($tipo)"
  harness_lab_create "$BASE/$id" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "$id install previo falló"
  arranque >/dev/null 2>&1
  V1_T="$(head_de "$LAB_TREE")"; V1_S="$(head_de "$LAB_SKILLS")"
  HOOKS_V1="$(hooks_settings)"; BLOQUES_V1="$(bloques)"; COPIA_V1="$(copia_fija_hash)"
  # la versión 2: un bloque nuevo siempre (la restauración tiene que sacarlo) y la rotura de este caso
  harness_lab_publish_block lab-v2
  case "$tipo" in
    deny)   harness_lab_publish_hook PreToolUse tycon-pipeline/deny-all.js 'process.stdout.write(JSON.stringify({ decision: "block", reason: "laboratorio T25" })); process.exit(2);' ;;
    syntax) harness_lab_publish_hook PostToolUse tycon-pipeline/broken-syntax.js 'function ( { roto a propósito' ;;
    suite)  harness_lab_publish_hook PreToolUse tycon-pipeline/fine.js 'process.exit(0);'; suite=1 ;;
  esac
  publicar_version 2 "$([ "$tipo" = harness ] && echo harness)"
  V2_T="$(head_de "$LAB_AUTHOR_TREE")"; V2_S="$(head_de "$LAB_AUTHOR_SKILLS")"

  SALIDA="$(estado_set "d['last_fetch']=None"; LAB_APPLIER_SUITE_FAIL=$suite harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "$id startup sale 0" || mal "$id startup rc $RC: $SALIDA"
  N2="$(corridas_v 2)"
  [ "$N2" -ge 1 ] && ok "$id el aplicador corrió la versión 2 (se intentó)" || mal "$id la versión 2 nunca se aplicó: $(tail -3 "$LAB_HOME/.claude/.tycon-pipeline/lab-applier.log" 2>&1)"
  [ "$(head_de "$LAB_TREE")" = "$V1_T" ] && [ "$(head_de "$LAB_SKILLS")" = "$V1_S" ] && ok "$id las dos fuentes volvieron a la versión 1" || mal "$id fuentes: harness $(head_de "$LAB_TREE") (v1 $V1_T) · agent-skills $(head_de "$LAB_SKILLS") (v1 $V1_S): $SALIDA"
  [ "$(rama_de "$LAB_TREE")" = main ] && [ "$(rama_de "$LAB_SKILLS")" = main ] && ok "$id …y siguen en main (nunca checkout de un commit)" || mal "$id ramas: $(rama_de "$LAB_TREE") / $(rama_de "$LAB_SKILLS")"
  [ "$(hooks_settings)" = "$HOOKS_V1" ] && ok "$id hooks de settings.json como en la versión 1" || mal "$id hooks: $(hooks_settings | tr '\n' ' ') — v1: $(printf '%s' "$HOOKS_V1" | tr '\n' ' ')"
  [ "$(bloques)" = "$BLOQUES_V1" ] && ok "$id bloques de CLAUDE.md como en la versión 1" || mal "$id bloques: $(bloques | tr '\n' ' ') — v1: $(printf '%s' "$BLOQUES_V1" | tr '\n' ' ')"
  R="$(estado "(d.get('failed') or {}).get('reason')")"
  case "|$reasons|" in *"|$R|"*) ok "$id failed anotado con reason $R" ;; *) mal "$id failed.reason «${R}» (esperado: $reasons): $(estado "d.get('failed')")" ;; esac
  [ "$(estado "((d.get('failed') or {}).get('sources') or {}).get('harness')")" = "$V2_T" ] && [ "$(estado "((d.get('failed') or {}).get('sources') or {}).get('agent_skills')")" = "$V2_S" ] && ok "$id failed.sources = las puntas que fallaron" || mal "$id failed.sources: $(estado "(d.get('failed') or {}).get('sources')") (puntas $V2_T / $V2_S)"
  [ -n "$(estado "(d.get('failed') or {}).get('at') or ''")" ] && [ -n "$(estado "(d.get('failed') or {}).get('log') or ''")" ] && ok "$id failed con at y log" || mal "$id failed sin at/log: $(estado "d.get('failed')")"
  [ "$(copia_fija_hash)" = "$COPIA_V1" ] && ok "$id la copia fija de arranque NO se refrescó (sha256 igual)" || mal "$id la copia fija cambió con una versión rota"
  harness doctor >/dev/null 2>&1; RC=$?
  [ "$RC" = 1 ] && ok "$id doctor en rojo (sale 1)" || mal "$id doctor rc $RC"
  case "$(harness doctor 2>&1)" in *"update --yes"*) ok "$id doctor nombra el comando para reintentar" ;; *) mal "$id doctor no nombra update --yes: $(harness doctor 2>&1 | grep -i fall)" ;; esac

  # dos arranques seguidos que sí salen a la red: no repiten el intento sobre las mismas puntas
  arranque >/dev/null 2>&1; arranque >/dev/null 2>&1
  [ "$(corridas_v 2)" = "$N2" ] && [ "$(head_de "$LAB_TREE")" = "$V1_T" ] && ok "$id dos startup seguidos NO reintentan el mismo commit" || mal "$id startup reintentó: corridas v2 $(corridas_v 2) (antes $N2), HEAD $(head_de "$LAB_TREE")"
  [ "$(estado "((d.get('failed') or {}).get('sources') or {}).get('harness')")" = "$V2_T" ] && ok "$id …y failed sigue anotado" || mal "$id failed se perdió: $(estado "d.get('failed')")"

  # update --yes sí reintenta (y como sigue rota, vuelve a restaurar)
  SALIDA="$(LAB_APPLIER_SUITE_FAIL=$suite harness update --yes 2>&1)"; RC=$?
  [ "$(corridas_v 2)" -gt "$N2" ] && ok "$id update --yes reintenta la versión 2" || mal "$id update --yes no reintentó (rc $RC): $SALIDA"
  [ "$RC" != 0 ] && [ "$(head_de "$LAB_TREE")" = "$V1_T" ] && [ "$(head_de "$LAB_SKILLS")" = "$V1_S" ] && ok "$id …sigue rota: sale $RC y restaura otra vez" || mal "$id update --yes: rc $RC HEAD $(head_de "$LAB_TREE"): $SALIDA"
}

corre T25-DENY    && caso_roto t25-deny    deny    health
corre T25-SYNTAX  && caso_roto t25-syntax  syntax  health
corre T25-HARNESS && caso_roto t25-harness harness health
corre T25-SUITE   && caso_roto t25-suite   suite   'health|applier'

# ═══ T25 · la versión sana: last_health y la copia fija refrescada (con el programa) ════════════════════════════════════
if corre T25-SANA; then
  echo "· t25-sana"
  harness_lab_create "$BASE/t25-sana" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T25-SANA install previo falló"
  arranque >/dev/null 2>&1
  LH0="$(estado "d.get('last_health')")"; COPIA_V1="$(copia_fija_hash)"
  harness_lab_publish_block lab-v2
  harness_lab_publish_hook PreToolUse tycon-pipeline/fine.js 'process.exit(0);'
  publicar_version 2
  V2_T="$(head_de "$LAB_AUTHOR_TREE")"
  SALIDA="$(arranque 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$V2_T" ] && ok "T25-SANA la versión 2 quedó aplicada" || mal "T25-SANA rc $RC HEAD $(head_de "$LAB_TREE") (punta $V2_T): $SALIDA"
  [ "$(estado "d.get('failed')")" = None ] && ok "T25-SANA sin failed" || mal "T25-SANA failed: $(estado "d.get('failed')")"
  LH1="$(estado "d.get('last_health')")"
  [ "$LH1" != None ] && [ "$LH1" != "$LH0" ] && ok "T25-SANA last_health escrito ($LH1)" || mal "T25-SANA last_health: $LH1 (antes $LH0)"
  [ "$(copia_fija_hash)" != "$COPIA_V1" ] && ok "T25-SANA la copia fija se refrescó" || mal "T25-SANA la copia fija no cambió"
  FIJA="$LAB_HOME/.claude/.tycon-pipeline/harness"
  [ "$(sha_de "$FIJA/bootstrap.js")" = "$(sha_de "$LAB_TREE/scripts/setup/harness/bootstrap.js")" ] && ok "T25-SANA bootstrap.js de la copia fija = el del árbol nuevo" || mal "T25-SANA bootstrap.js de la copia fija viejo"
  [ -f "$FIJA/program/harness.js" ] && [ "$(sha_de "$FIJA/program/harness.js")" = "$(sha_de "$LAB_TREE/scripts/setup/harness.js")" ] && ok "T25-SANA la copia fija trae program/harness.js del árbol nuevo" || mal "T25-SANA sin program/harness.js (o viejo) en $FIJA: $(ls "$FIJA" 2>&1 | tr '\n' ' ')"
  [ -f "$FIJA/program/harness/health.js" ] && ok "T25-SANA …y sus módulos (program/harness/health.js)" || mal "T25-SANA sin program/harness/*.js"
fi

# ═══ T25 · interrupted: un merge a medias («unable to unlink») restaura y SÍ reintenta ══════════════════════════════════
if corre T25-INTERRUPTED; then
  echo "· t25-interrupted"
  harness_lab_create "$BASE/t25-int" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T25-INTERRUPTED install previo falló"
  harness_lab_publish tree "carpeta que se traba" lab-locked/f.txt uno
  arranque >/dev/null 2>&1
  V1_T="$(head_de "$LAB_TREE")"
  if [ ! -f "$LAB_TREE/lab-locked/f.txt" ] || [ "$V1_T" != "$(head_de "$LAB_AUTHOR_TREE")" ]; then
    mal "T25-INTERRUPTED la versión base (con lab-locked/) no quedó aplicada: HEAD $V1_T"
  else
    HOOKS_V1="$(hooks_settings)"; COPIA_V1="$(copia_fija_hash)"
    harness_lab_publish tree "toca la carpeta trabada" lab-locked/f.txt dos
    publicar_version 3
    V3_T="$(head_de "$LAB_AUTHOR_TREE")"
    chmod 555 "$LAB_TREE/lab-locked"
    if touch "$LAB_TREE/lab-locked/.escritura" 2>/dev/null; then
      rm -f "$LAB_TREE/lab-locked/.escritura"; chmod 755 "$LAB_TREE/lab-locked"
      ok "T25-INTERRUPTED omitido: este usuario escribe aunque el permiso diga que no (root)"
    else
      SALIDA="$(arranque 2>&1)"; RC=$?
      [ "$RC" = 0 ] && ok "T25-INTERRUPTED startup sale 0" || mal "T25-INTERRUPTED rc $RC: $SALIDA"
      [ "$(head_de "$LAB_TREE")" = "$V1_T" ] && [ "$(rama_de "$LAB_TREE")" = main ] && ok "T25-INTERRUPTED el árbol volvió a la versión anterior, en main" || mal "T25-INTERRUPTED HEAD $(head_de "$LAB_TREE") rama $(rama_de "$LAB_TREE") (antes $V1_T)"
      [ "$(estado "(d.get('failed') or {}).get('reason')")" = interrupted ] && ok "T25-INTERRUPTED failed.reason = interrupted" || mal "T25-INTERRUPTED failed: $(estado "d.get('failed')") · log: $(tail -3 "$LAB_HOME/.claude/.tycon-pipeline/harness/startup.log" 2>&1)"
      [ "$(hooks_settings)" = "$HOOKS_V1" ] && [ "$(copia_fija_hash)" = "$COPIA_V1" ] && ok "T25-INTERRUPTED hooks como antes y copia fija sin refrescar" || mal "T25-INTERRUPTED hooks o copia fija cambiaron"
      chmod 755 "$LAB_TREE/lab-locked"
      SALIDA="$(arranque 2>&1)"; RC=$?
      [ "$(head_de "$LAB_TREE")" = "$V3_T" ] && ok "T25-INTERRUPTED el arranque siguiente SÍ reintenta y aplica" || mal "T25-INTERRUPTED no reintentó: HEAD $(head_de "$LAB_TREE") (punta $V3_T): $SALIDA"
      [ "$(estado "d.get('failed')")" = None ] && ok "T25-INTERRUPTED …y failed se borra" || mal "T25-INTERRUPTED failed quedó: $(estado "d.get('failed')")"
    fi
  fi
fi

# ═══ REG (pase adversarial de la tanda C, iteración 1) ══════════════════════════════════════════════════════════════════
# H3/H4 · una instalación que falló la salud no se condena sola: el `failed` viejo no hace fallar la salud siguiente
if corre REG-H3; then
  echo "· reg-h3"
  harness_lab_create "$BASE/reg-h3" >/dev/null
  LAB_APPLIER_SUITE_FAIL=1 harness install --yes >/dev/null 2>&1; RC=$?
  [ "$RC" = 1 ] && [ "$(estado "(d.get('failed') or {}).get('reason')")" = health ] && ok "REG-H3 install con la salud rota sale 1 y anota failed" || mal "REG-H3 install roto: rc $RC failed=$(estado "d.get('failed')")"
  # algo para reponer (install no corta en «sin cambios»): la línea de import, escrita con cualquiera de los dos nombres del lugar
  grep -v -e '^@~/.claude/tycon-harness/INDEX.md$' -e '^@~/.claude/tycon-harness/README.md$' -e '^@~/.claude/tycon-claude-guides/README.md$' "$CLAUDE_MD_PATH" > "$BASE/cm" ; cp "$BASE/cm" "$CLAUDE_MD_PATH"
  SALIDA="$(harness install --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d.get('failed')")" = None ] && ok "REG-H3 la reinstalación sana pasa la salud y borra failed" || mal "REG-H3 reinstalación: rc $RC failed=$(estado "d.get('failed')") · $SALIDA"
  harness doctor >/dev/null 2>&1 && ok "REG-H3 doctor verde después" || mal "REG-H3 doctor sigue en rojo"
  # startup --force con un intento fallido de una versión (otra punta) registrado: la salud del árbol actual pasa
  estado_set "d['failed']={'commit':'vieja','sources':{'harness':'0'*40},'at':'2026-10-02T00:00:00Z','log':'x','reason':'health'}"
  harness startup --force >/dev/null 2>&1
  case "$(estado "d.get('notice') or ''")" in *"comprobación de salud no pasó"*) mal "REG-H3 startup --force falló la salud por el failed viejo: $(estado "d.get('notice')")" ;; *) ok "REG-H3 startup --force no falla la salud por un intento viejo registrado" ;; esac
fi

# H18 · la sesión muere en medio de la salud (después de mover los árboles): el arranque siguiente la corre y no da la
# versión por buena sin pasarla. El hook de juguete mata a harness.js la primera vez que la salud lo lanza.
if corre REG-H18; then
  echo "· reg-h18"
  harness_lab_create "$BASE/reg-h18" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "REG-H18 install previo falló"
  arranque >/dev/null 2>&1
  FLAG="$LAB/matar-una-vez"; : > "$FLAG"
  # sube por los padres hasta el proceso de harness.js (el /bin/sh de la salud puede haber hecho exec) y lo mata
  harness_lab_publish_hook PreToolUse tycon-pipeline/killer.js "const fs=require('fs');const {execSync}=require('child_process');if(fs.existsSync('$FLAG')){fs.unlinkSync('$FLAG');let p=process.ppid;for(let i=0;i<5&&p>1;i++){const [pp,...cmd]=execSync('ps -o ppid=,command= -p '+p).toString().trim().split(/\s+/);if(cmd.join(' ').includes('scripts/setup/harness.js')){process.kill(p,'SIGKILL');break;}p=Number(pp);}}process.exit(0);"
  publicar_version 2
  V2_T="$(head_de "$LAB_AUTHOR_TREE")"; COPIA_V1="$(copia_fija_hash)"
  arranque >/dev/null 2>&1
  [ ! -f "$FLAG" ] && ok "REG-H18 la salud lanzó el hook y harness.js murió en el medio" || mal "REG-H18 el hook asesino no corrió (la salud no lo lanzó)"
  rm -rf "$LAB_HOME/.claude/.tycon-pipeline/harness/harness.lock"   # el candado del proceso muerto (huérfano a los 10 min)
  [ "$(estado "(d.get('failed') or {}).get('pending')")" = health ] && ok "REG-H18 queda constancia de la salud pendiente" || mal "REG-H18 sin constancia de salud pendiente: $(estado "d.get('failed')")"
  arranque >/dev/null 2>&1
  [ "$(estado "d.get('failed')")" = None ] && [ "$(head_de "$LAB_TREE")" = "$V2_T" ] && ok "REG-H18 el arranque siguiente corrió la salud pendiente y la versión quedó" || mal "REG-H18 tras el arranque: failed=$(estado "d.get('failed')") HEAD $(head_de "$LAB_TREE")"
  [ "$(copia_fija_hash)" != "$COPIA_V1" ] && ok "REG-H18 …y recién ahí se refrescó la copia fija" || mal "REG-H18 la copia fija no se refrescó tras la salud pendiente"
fi

# S1 (fallos silenciosos, iteración 2) · la salud pendiente que se retoma no queda ciega a la suite rápida: las líneas
# «FALLÓ» del aplicador de esa actualización se guardan con la constancia y el arranque siguiente las mira
if corre REG-S1; then
  echo "· reg-s1"
  harness_lab_create "$BASE/reg-s1" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "REG-S1 install previo falló"
  arranque >/dev/null 2>&1
  V1_T="$(head_de "$LAB_TREE")"
  publicar_version 2
  arranque >/dev/null 2>&1
  [ "$(head_de "$LAB_TREE")" != "$V1_T" ] || mal "REG-S1 la versión 2 no se aplicó"
  # como si la sesión hubiera muerto en el medio de la salud de la v2, con el aplicador que había dicho «FALLÓ»
  # (con las puntas de la v2, como la graba harness.js: así el mismo arranque no la vuelve a aplicar)
  T2="$(head_de "$LAB_TREE")"; S2="$(head_de "$LAB_SKILLS")"
  estado_set "d['failed']={'commit':'v2','sources':{'harness':'$T2','agent_skills':'$S2'},'at':'2026-10-02T00:00:00Z','log':'x','reason':'interrupted','pending':'health','applier_failed':['✗ suite de la capa determinista: lab-suite FALLÓ']}"
  arranque >/dev/null 2>&1
  [ "$(estado "(d.get('failed') or {}).get('reason')")" = health ] && [ "$(head_de "$LAB_TREE")" = "$V1_T" ] && ok "REG-S1 la salud retomada ve el «FALLÓ» guardado y vuelve a v1" || mal "REG-S1 salud retomada ciega: failed=$(estado "d.get('failed')") HEAD $(head_de "$LAB_TREE") (v1 $V1_T)"
fi

# S2 (fallos silenciosos, iteración 2) · `install` también deja la constancia de salud pendiente: si la sesión muere en
# el medio, el arranque siguiente la corre (antes la instalación quedaba «sana» sin haberse comprobado)
if corre REG-S2; then
  echo "· reg-s2"
  harness_lab_create "$BASE/reg-s2" >/dev/null
  FLAG="$LAB/matar-una-vez"; : > "$FLAG"
  harness_lab_publish_hook PreToolUse tycon-pipeline/killer.js "const fs=require('fs');const {execSync}=require('child_process');if(fs.existsSync('$FLAG')){fs.unlinkSync('$FLAG');let p=process.ppid;for(let i=0;i<5&&p>1;i++){const [pp,...cmd]=execSync('ps -o ppid=,command= -p '+p).toString().trim().split(/\s+/);if(cmd.join(' ').includes('scripts/setup/harness.js')){process.kill(p,'SIGKILL');break;}p=Number(pp);}}process.exit(0);"
  harness_lab_git "$LAB_SKILLS" pull -q --ff-only origin main >/dev/null 2>&1
  harness install --yes >/dev/null 2>&1
  [ ! -f "$FLAG" ] && ok "REG-S2 la salud de install lanzó el hook y harness.js murió en el medio" || mal "REG-S2 el hook asesino no corrió en la salud de install"
  rm -rf "$LAB_HOME/.claude/.tycon-pipeline/harness/harness.lock"
  [ "$(estado "(d.get('failed') or {}).get('pending')")" = health ] && ok "REG-S2 queda constancia de la salud pendiente de install" || mal "REG-S2 sin constancia: failed=$(estado "d.get('failed')") last_health=$(estado "d.get('last_health')")"
  arranque >/dev/null 2>&1
  [ "$(estado "d.get('failed')")" = None ] && [ "$(estado "d.get('last_health')")" != None ] && ok "REG-S2 el arranque siguiente corrió la salud pendiente" || mal "REG-S2 tras el arranque: failed=$(estado "d.get('failed')") last_health=$(estado "d.get('last_health')")"
fi

# H19 · una actualización sólo de agent-skills que falla se nombra con el sha de agent-skills (no «X → X»)
if corre REG-H19; then
  echo "· reg-h19"
  harness_lab_create "$BASE/reg-h19" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "REG-H19 install previo falló"
  arranque >/dev/null 2>&1
  harness_lab_publish_hook PreToolUse tycon-pipeline/deny.js 'console.log(JSON.stringify({decision:"block"}));process.exit(2);'
  S2="$(head_de "$LAB_AUTHOR_SKILLS")"
  arranque >/dev/null 2>&1
  C="$(estado "(d.get('failed') or {}).get('commit') or ''")"
  case "$C" in *"${S2:0:7}"*) ok "REG-H19 failed.commit nombra el agent-skills que falló ($C)" ;; *) mal "REG-H19 failed.commit sin el sha de agent-skills ${S2:0:7}: «${C}»" ;; esac
  case "$(estado "d.get('notice') or ''")" in *"${S2:0:7}"*) ok "REG-H19 el aviso también" ;; *) mal "REG-H19 el aviso no nombra agent-skills: $(estado "d.get('notice')")" ;; esac
fi

# ═══ UNIT · health.check directo ════════════════════════════════════════════════════════════════════════════════════
if corre UNIT; then
  echo "· unit"
  harness_lab_create "$BASE/unit" >/dev/null
  U="$LAB/unit"; mkdir -p "$U"
  SK="$LAB_SKILLS/skills"; mkdir -p "$SK/tycon-pipeline"
  # un hook que anota lo que recibió: el payload, su cwd y si ese cwd era un repo git
  SPY='const fs=require("fs"),path=require("path");let i="";process.stdin.on("data",c=>i+=c).on("end",()=>{fs.appendFileSync(process.env.LAB_SPY,JSON.stringify({payload:JSON.parse(i||"{}"),cwd:process.cwd(),git:fs.existsSync(path.join(process.cwd(),".git")),projectDir:process.env.CLAUDE_PROJECT_DIR||null})+"\n");process.exit(0);});'
  printf '%s\n' "$SPY" > "$LAB_TREE/scripts/hooks/spy-start.js"
  printf '%s\n' "$SPY" > "$SK/tycon-pipeline/spy-pre.js"
  printf 'process.stdout.write(JSON.stringify({decision:"block"})); process.exit(2);\n' > "$SK/tycon-pipeline/deny-all.js"
  printf 'function ( { roto\n' > "$SK/tycon-pipeline/broken.js"
  printf '#!/usr/bin/env bash\nif then fi\n' > "$LAB_TREE/scripts/hooks/broken.sh"
  printf 'setTimeout(()=>process.exit(0), 4000);\n' > "$SK/tycon-pipeline/slow.js"
  printf 'process.exit(0);\n' > "$SK/tycon-pipeline/fine.js"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$LAB_TREE/scripts/hooks/fine-stop.sh"
  # doctores de mentira: uno en rojo, uno verde, uno que no arranca
  printf 'process.stdout.write(JSON.stringify({mode:"managed",fail:["fuente harness: algo rojo de laboratorio"],warn:[],ok:[]})); process.exitCode=1;\n' > "$U/doctor-red.js"
  printf 'process.stdout.write(JSON.stringify({mode:"managed",fail:[],warn:[],ok:["todo bien"]}));\n' > "$U/doctor-green.js"
  printf ')( roto\n' > "$U/doctor-broken.js"
  # settings.json: cada hook con su command, como lo escribe el aplicador
  python3 - "$TYCON_SETTINGS_PATH" "$LAB_TREE" "$SK" <<'PY'
import json, sys
p, tree, sk = sys.argv[1:4]
H = lambda c: {"hooks": [{"type": "command", "command": c}]}
s = {"hooks": {
  "SessionStart": [H('node "%s/scripts/hooks/spy-start.js"' % tree)],
  "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": 'node "%s/tycon-pipeline/spy-pre.js"' % sk}]},
                 {"matcher": "Bash", "hooks": [{"type": "command", "command": 'node "%s/tycon-pipeline/deny-all.js"' % sk}]},
                 {"matcher": "Bash", "hooks": [{"type": "command", "command": 'node "%s/tycon-pipeline/fine.js"' % sk}]}],
  "PostToolUse": [H('node "%s/tycon-pipeline/broken.js"' % sk)],
  "UserPromptSubmit": [H('node "%s/tycon-pipeline/slow.js"' % sk)],
  "Stop": [H('bash "%s/scripts/hooks/fine-stop.sh"' % tree), H('bash "%s/scripts/hooks/broken.sh"' % tree)],
}}
json.dump(s, open(p, "w", encoding="utf-8"), indent=2)
PY
  cat > "$U/check.js" <<'JS'
// corre health.check con un reporte y opciones dadas por argumento; imprime el resultado como JSON
const [mod, tree, skillsDir, reportJson, applierOut, harnessJs, timeout] = process.argv.slice(2);
const health = require(mod);
const ctx = { home: process.env.HOME, env: process.env, platform: process.platform, tree };
const lines = [];
const r = health.check(ctx, { tree, skillsDir, report: JSON.parse(reportJson), applierOut, harnessJs, log: (l) => lines.push(String(l)), hookTimeoutMs: Number(timeout) || undefined });
process.stdout.write(JSON.stringify(Object.assign({ logged: lines.length }, r)));
JS
  SP="$TYCON_SETTINGS_PATH"
  piezas() { # piezas <id>… → el reporte JSON
    python3 -c 'import json,sys; print(json.dumps([{"kind":"hook","where":sys.argv[1],"id":i} for i in sys.argv[2:]]))' "$SP" "$@"
  }
  HEALTH_JS="$RAIZ/scripts/setup/harness/health.js"
  export LAB_SPY="$U/spy.jsonl"
  TMP_ANTES="$(ls "$LAB_TMP" | LC_ALL=C sort)"

  # (a) roto: el PreToolUse que deniega es el primero; un .js con error de sintaxis; un .sh con error de sintaxis; un
  #     hook lento (tope 1 s → aviso); «FALLÓ» en la salida del aplicador; doctor en rojo
  REP="$(piezas 'SessionStart:@tcg:spy-start.js' 'PreToolUse:tycon-pipeline/deny-all.js' 'PreToolUse:tycon-pipeline/spy-pre.js' 'PostToolUse:tycon-pipeline/broken.js' 'UserPromptSubmit:tycon-pipeline/slow.js' 'Stop:@tcg:fine-stop.sh' 'Stop:@tcg:broken.sh')"
  OUT="$U/a.json"
  node "$U/check.js" "$HEALTH_JS" "$LAB_TREE" "$SK" "$REP" $'aplicador corrido\n✗ suite de la capa determinista: lab-suite FALLÓ' "$U/doctor-red.js" 1000 > "$OUT" 2> "$U/a.err"; RC=$?
  [ "$RC" = 0 ] && ok "UNIT check no tira (devuelve el resultado)" || mal "UNIT check tiró (rc $RC): $(cat "$U/a.err")"
  u() { j "$OUT" "$1"; }
  [ "$(u "d['ok']")" = False ] && ok "UNIT roto: ok = false" || mal "UNIT roto: ok = $(u "d.get('ok')")"
  [ "$(u "any('deny-all.js' in f and '2' in f for f in d['failures'])")" = True ] && ok "UNIT el PreToolUse que sale 2 es falla" || mal "UNIT sin la falla del PreToolUse: $(u "d['failures']")"
  [ "$(u "any('broken.js' in f for f in d['failures'])")" = True ] && ok "UNIT node --check del .js roto es falla" || mal "UNIT sin la falla de broken.js: $(u "d['failures']")"
  [ "$(u "any('broken.sh' in f for f in d['failures'])")" = True ] && ok "UNIT bash -n del .sh roto es falla" || mal "UNIT sin la falla de broken.sh: $(u "d['failures']")"
  [ "$(u "any('FALLÓ' in f for f in d['failures'])")" = True ] && ok "UNIT «FALLÓ» en la salida del aplicador es falla" || mal "UNIT sin la falla de FALLÓ: $(u "d['failures']")"
  [ "$(u "any('algo rojo de laboratorio' in f for f in d['failures'])")" = True ] && ok "UNIT doctor con fail es falla, con su texto" || mal "UNIT sin la falla de doctor: $(u "d['failures']")"
  [ "$(u "any('slow.js' in w for w in d['warnings'])")" = True ] && [ "$(u "any('slow.js' in f for f in d['failures'])")" = False ] && ok "UNIT un tope vencido es aviso, no falla" || mal "UNIT tope: warnings $(u "d['warnings']") failures $(u "d['failures']")"
  [ "$(u "any('spy-pre.js' in f for f in d['failures'])")" = False ] && ok "UNIT un hook sano no es falla" || mal "UNIT spy-pre.js como falla: $(u "d['failures']")"
  [ "$(u "d['logged'] > 0")" = True ] && ok "UNIT anota lo que hace en log" || mal "UNIT log vacío"
  # un hook por evento: el primero registrado. El PreToolUse espía (segundo) NO corrió; el SessionStart espía sí
  if [ -f "$LAB_SPY" ]; then
    E="$(python3 -c 'import json,sys; print(",".join(sorted(json.loads(l)["payload"].get("hook_event_name","?") for l in open(sys.argv[1]))))' "$LAB_SPY")"
    [ "$E" = SessionStart ] && ok "UNIT un hook por evento: corrió el primero (SessionStart), no el segundo PreToolUse" || mal "UNIT eventos que corrieron los espías: $E"
    L1() { python3 -c "import json,sys; d=json.loads(open(sys.argv[1]).readline()); print($1)" "$LAB_SPY"; }
    [ "$(L1 "d['payload'].get('session_id')")" = tycon-harness-health ] && ok "UNIT payload con session_id tycon-harness-health" || mal "UNIT session_id: $(L1 "d['payload']")"
    [ "$(L1 "d['git']")" = True ] && [ "$(L1 "d['payload'].get('cwd') == d['cwd']")" = True ] && ok "UNIT corre desde un repo git vacío y el payload trae ese cwd" || mal "UNIT cwd: $(L1 "d")"
    CWD="$(L1 "d['cwd']")"
    [ ! -e "$CWD" ] && ok "UNIT el repo temporal se borra al final" || mal "UNIT quedó el repo temporal $CWD"
  else
    mal "UNIT el hook espía de SessionStart nunca corrió"
  fi
  [ "$(ls "$LAB_TMP" | LC_ALL=C sort)" = "$TMP_ANTES" ] && ok "UNIT no deja nada en el temporal" || mal "UNIT dejó en $LAB_TMP: $(ls "$LAB_TMP" | tr '\n' ' ')"

  # (b) sano: el primer PreToolUse es el espía (el que deniega viene después y no corre); doctor verde; sin «FALLÓ»
  rm -f "$LAB_SPY"
  REP="$(piezas 'SessionStart:@tcg:spy-start.js' 'PreToolUse:tycon-pipeline/spy-pre.js' 'PreToolUse:tycon-pipeline/deny-all.js' 'Stop:@tcg:fine-stop.sh')"
  OUT="$U/b.json"
  node "$U/check.js" "$HEALTH_JS" "$LAB_TREE" "$SK" "$REP" 'aplicador corrido: todo ok' "$U/doctor-green.js" 5000 > "$OUT" 2> "$U/b.err"; RC=$?
  [ "$RC" = 0 ] && [ "$(u "d['ok']")" = True ] && [ "$(u "len(d['failures'])")" = 0 ] && ok "UNIT sano: ok = true, sin fallas" || mal "UNIT sano: rc $RC $(cat "$OUT" "$U/b.err" 2>&1)"
  E="$(python3 -c 'import json,sys; print(",".join(sorted(json.loads(l)["payload"].get("hook_event_name","?") for l in open(sys.argv[1]))))' "$LAB_SPY" 2>/dev/null)"
  [ "$E" = "PreToolUse,SessionStart" ] && ok "UNIT sano: corrieron SessionStart y el primer PreToolUse" || mal "UNIT sano: eventos de los espías: $E"
  PT="$(python3 -c 'import json,sys
for l in open(sys.argv[1]):
    p=json.loads(l)["payload"]
    if p.get("hook_event_name")=="PreToolUse": print(p.get("tool_name"), (p.get("tool_input") or {}).get("command"))' "$LAB_SPY" 2>/dev/null)"
  case "$PT" in Bash*) ok "UNIT el PreToolUse recibe un Bash inofensivo ($PT)" ;; *) mal "UNIT payload de PreToolUse: $PT" ;; esac

  # (c) doctor que no arranca (harness.js roto) y un hook del reporte cuyo archivo no está
  REP="$(piezas 'Stop:@tcg:fine-stop.sh' 'PostToolUse:tycon-pipeline/no-existe.js')"
  OUT="$U/c.json"
  node "$U/check.js" "$HEALTH_JS" "$LAB_TREE" "$SK" "$REP" '' "$U/doctor-broken.js" 5000 > "$OUT" 2> "$U/c.err"; RC=$?
  [ "$(u "d['ok']")" = False ] && [ "$(u "any('doctor' in f for f in d['failures'])")" = True ] && ok "UNIT un harness.js que no arranca es falla (doctor no responde)" || mal "UNIT doctor roto: $(cat "$OUT" "$U/c.err" 2>&1)"
  [ "$(u "any('no-existe.js' in f for f in d['failures'])")" = True ] && ok "UNIT un hook registrado sin su archivo es falla" || mal "UNIT sin la falla de no-existe.js: $(u "d['failures']")"
fi

# ═══ T38 (story 8.18, AC 35 y 37) · la comprobación de salud en las tres formas de máquina ═══════════════════════════
# Un hook nuevo de skills llega por donde corresponde a cada forma (el repo viejo, o el unificado), queda registrado con la
# ruta fija ~/.claude/agent-skills/skills/…, y la salud entera pasa. Y el espejo: un hook de skills ROTO en la máquina
# re-apuntada hace volver las DOS fuentes a la versión anterior — el mismo commit en los dos clones, o ninguno se movió.
# skills_hook <ruta en skills/> <contenido>  — publica un hook de skills por el repo del que esta forma lee las skills
skills_hook() {
  local rel="$1" content="$2" a="$LAB_AUTHOR_TREE"
  if [ "$LAB_SHAPE" = two-clones ]; then harness_lab_publish_hook PreToolUse "$rel" "$content"; return; fi
  harness_lab_git "$a" pull -q --ff-only origin main >/dev/null 2>&1 || true
  mkdir -p "$(dirname "$a/skills/$rel")"; printf '%s\n' "$content" > "$a/skills/$rel"; printf 'PreToolUse|%s\n' "$rel" >> "$a/lab-hooks.txt"
  harness_lab_git "$a" add -A >/dev/null && harness_lab_git "$a" commit -q -m "hook nuevo de skills $rel" >/dev/null && harness_lab_git "$a" push -q origin main >/dev/null 2>&1
}
if corre T38; then
  for shape in two-clones repointed single; do
    harness_lab_shape "$BASE/t38-$shape" "$shape" || { mal "T38 ($shape) no pude armar la máquina"; continue; }
    skills_hook tycon-pipeline/lab-t38.js "process.exit(0);"
    SALIDA="$(harness update 2>&1)"; RC=$?
    RUTA="$(hooks_settings | grep 'lab-t38.js')"
    [ "$RC" = 0 ] && case "$RUTA" in "PreToolUse|"*"/.claude/agent-skills/skills/tycon-pipeline/lab-t38.js"*) true ;; *) false ;; esac \
      && ok "T38 ($shape) un hook nuevo de skills llega, pasa la salud y queda registrado con la ruta fija ~/.claude/agent-skills" || mal "T38 ($shape) update (rc $RC), hook «${RUTA}»: $SALIDA"
    estado_set "d['last_health']=None"
    SALIDA="$(harness startup --force 2>&1)"; RC=$?
    [ "$RC" = 0 ] && [ "$(estado "d['last_health'] is not None")" = True ] && [ "$(estado "d.get('failed')")" = None ] && [ "$(estado "d.get('notice')")" = None ] \
      && ok "T38 ($shape) startup --force: la comprobación de salud entera pasa (sus hooks, reconocidos por la ruta fija)" || mal "T38 ($shape) startup --force (rc $RC): failed=$(estado "d.get('failed')") aviso=$(estado "d.get('notice')"): $SALIDA"
    [ "$(harness doctor --json 2>/dev/null | python3 -c "import json,sys; print(len(json.load(sys.stdin)['fail']))")" = 0 ] && ok "T38 ($shape) doctor sin rojo" || mal "T38 ($shape) doctor en rojo: $(harness doctor 2>&1 | head -5)"
    if [ "$shape" = repointed ]; then
      # espejo: una versión cuyo hook de skills no compila → la salud falla y vuelven LAS DOS, al mismo commit
      A_T="$(head_de "$LAB_TREE")"; A_S="$(head_de "$LAB_SKILLS")"
      [ "$A_T" = "$A_S" ] || mal "T38 (repointed) precondición: los dos clones no están en el mismo commit"
      skills_hook tycon-pipeline/lab-t38-broken.js "function ( { roto"
      SALIDA="$(harness update 2>&1)"; RC=$?
      [ "$RC" = 1 ] && [ "$(head_de "$LAB_TREE")" = "$A_T" ] && [ "$(head_de "$LAB_SKILLS")" = "$A_T" ] && [ "$(estado "d['failed']['reason']")" = health ] \
        && ok "T38 (repointed) espejo: con un hook de skills roto la salud falla y las DOS fuentes vuelven al mismo commit de antes" || mal "T38 (repointed) espejo (rc $RC): arnés $(head_de "$LAB_TREE") skills $(head_de "$LAB_SKILLS") antes $A_T: $SALIDA"
      [ ! -e "$LAB_SKILLS/scripts" ] && [ "$(harness_lab_git "$LAB_SKILLS" remote get-url origin)" = "$LAB_REMOTE_UNIFIED" ] && [ -d "$LAB_SKILLS/skills/tycon-pipeline" ] \
        && ok "T38 (repointed) …y el clon de skills sigue re-apuntado, mostrando sólo lo suyo, con sus skills" || mal "T38 (repointed) el clon de skills cambió de forma después de la vuelta atrás"
    fi
  done
  # un intento de mudanza que no pudo pasar no tira abajo la salud: bajo la salud, doctor lo dice como aviso
  harness_lab_shape "$BASE/t38-blocked" two-clones || mal "T38 no pude armar la máquina bloqueada"
  harness_lab_git "$LAB_SKILLS" checkout -q -b lab/work
  TYCON_UPDATE_SKILLS_SOURCE=unified harness update >/dev/null 2>&1
  [ "$(estado "d['repoint']['blocked']['cause']")" = branch ] || mal "T38 precondición: la mudanza no quedó anotada como bloqueada: $(estado "d.get('repoint')")"
  SALIDA="$(TYCON_UPDATE_SKILLS_SOURCE=unified harness startup --force 2>&1)"; RC=$?
  case "$(estado "d.get('notice')")" in *"comprobación de salud no pasó"*) mal "T38 una mudanza bloqueada tiró abajo la salud: $(estado "d.get('notice')")" ;; *"la llave pide el repo unificado"*) ok "T38 una mudanza que no pudo pasar no tira abajo la comprobación de salud (queda su propio aviso)" ;; *) mal "T38 aviso inesperado: $(estado "d.get('notice')")" ;; esac
fi

# ═══ T99 ·Health_ShHookSyntax_GitBashNotBareBash_CrlfIsRed (story 8.17, tanda W3a · AC 72) ═════════════════════════════
# En Windows `bash` a secas puede ser el lanzador de WSL (sale distinto de 0 con cualquier guion): con él, la sintaxis de un
# hook `.sh` sano daba «falla» y la actualización volvía atrás. La salud usa el bash de Git; sin él, avisa «sin comprobar».
# Y un `.sh` con `\r\n` se DICE (`bash -n` lo da por bueno, pero al correr sale 255 y un freno así no frena) como AVISO, no
# como rojo (primera vuelta de revisión; el nombre del caso conserva «CrlfIsRed» porque así está en la tabla de la story).
# La plataforma se inyecta (no hay Windows acá). El «bash de Git» de juguete anota cada llamada y, como el de verdad, pone
# lo suyo primero en el PATH; el `bash` de juguete que queda primero en el PATH anota y sale 1, como el lanzador de WSL.
# 🔴 rojo previo: con la salud de antes, en Windows el `.sh` sano fallaba («bash -n falló: rc 1»), el `bash` del PATH se
#    usaba (queda su registro) y el `.sh` con `\r\n` pasaba.
if corre T99; then
  echo "· t99"
  harness_lab_create "$BASE/t99" >/dev/null
  U="$LAB/unit"; mkdir -p "$U/path-first" "$U/git/bin"
  SK="$LAB_SKILLS/skills"
  HEALTH_JS="$RAIZ/scripts/setup/harness/health.js"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$LAB_TREE/scripts/hooks/fine-stop.sh"
  printf '#!/usr/bin/env bash\nif then fi\n' > "$LAB_TREE/scripts/hooks/broken.sh"
  printf '#!/usr/bin/env bash\r\nexit 0\r\n' > "$LAB_TREE/scripts/hooks/crlf-guard.sh"
  printf 'process.stdout.write(JSON.stringify({mode:"managed",fail:[],warn:[],ok:["todo bien"]}));\n' > "$U/doctor-green.js"
  REAL_BASH="$(command -v bash)"
  printf '#!/bin/sh\n# el primer bash del PATH: como el lanzador de WSL, no corre ningún guion\necho "bare $*" >> "%s"\nexit 1\n' "$U/bare-bash.log" > "$U/path-first/bash"
  printf '#!/bin/sh\n# el bash de Git de juguete: anota, pone lo suyo primero en el PATH y corre el bash de verdad\necho "git $*" >> "%s"\nPATH="%s:$PATH" exec "%s" "$@"\n' "$U/git-bash.log" "$(dirname "$REAL_BASH")" "$REAL_BASH" > "$U/git/bin/bash.exe"
  chmod +x "$U/path-first/bash" "$U/git/bin/bash.exe"
  python3 - "$TYCON_SETTINGS_PATH" "$LAB_TREE" <<'PY'
import json, sys
p, tree = sys.argv[1:3]
H = lambda c: {"hooks": [{"type": "command", "command": c}]}
s = {"hooks": {"Stop": [H('bash "%s/scripts/hooks/fine-stop.sh"' % tree), H('bash "%s/scripts/hooks/broken.sh"' % tree), H('bash "%s/scripts/hooks/crlf-guard.sh"' % tree)]}}
json.dump(s, open(p, "w", encoding="utf-8"), indent=2)
PY
  cat > "$U/check-platform.js" <<'JS'
// corre health.check con la plataforma dada por argumento; imprime el resultado como JSON
const [mod, tree, skillsDir, reportJson, harnessJs, platform] = process.argv.slice(2);
const health = require(mod);
const ctx = { home: process.env.HOME, env: process.env, platform, tree };
const r = health.check(ctx, { tree, skillsDir, report: JSON.parse(reportJson), applierOut: '', harnessJs, hookTimeoutMs: 5000 });
process.stdout.write(JSON.stringify(r));
JS
  piezas99() { python3 -c 'import json,sys; print(json.dumps([{"kind":"hook","where":sys.argv[1],"id":i} for i in sys.argv[2:]]))' "$TYCON_SETTINGS_PATH" "$@"; }
  salud99() { # salud99 <salida> <plataforma> <id>…  — con lo que haya en PATH y en CLAUDE_CODE_GIT_BASH_PATH
    local out="$1" plat="$2"; shift 2
    rm -f "$U/bare-bash.log" "$U/git-bash.log"
    node "$U/check-platform.js" "$HEALTH_JS" "$LAB_TREE" "$SK" "$(piezas99 "$@")" "$U/doctor-green.js" "$plat" > "$out" 2> "$out.err"
  }
  u99() { j "$OUT" "$1"; }

  # (a) Windows, con el bash de Git y un `bash` que sale 1 primero en el PATH: la sintaxis se revisa con el de Git
  OUT="$U/t99-a.json"
  PATH="$U/path-first:$PATH" CLAUDE_CODE_GIT_BASH_PATH="$U/git/bin/bash.exe" salud99 "$OUT" win32 'Stop:@tcg:fine-stop.sh' 'Stop:@tcg:broken.sh'; RC=$?
  [ "$RC" = 0 ] && [ "$(u99 "any('fine-stop.sh' in f for f in d['failures'])")" = False ] && ok "T99 Windows: un .sh sano no es falla aunque el primer bash del PATH salga 1" || mal "T99 Windows: el .sh sano falló (rc $RC): $(u99 "d['failures']") $(cat "$OUT.err")"
  [ ! -e "$U/bare-bash.log" ] && ok "T99 Windows: el bash del PATH no se usó (ni para la sintaxis ni para lanzar el hook)" || mal "T99 Windows: se usó el bash del PATH: $(tr '\n' '|' < "$U/bare-bash.log")"
  [ "$(grep -c '^git -n ' "$U/git-bash.log" 2>/dev/null)" = 2 ] && ok "T99 Windows: la sintaxis de los dos .sh se revisó con el bash de Git" || mal "T99 Windows: llamadas al bash de Git: $(tr '\n' '|' < "$U/git-bash.log" 2>/dev/null)"
  [ "$(u99 "any('broken.sh' in f for f in d['failures'])")" = True ] && ok "T99 Windows: un .sh con error de sintaxis sigue siendo falla" || mal "T99 Windows: sin la falla de broken.sh: $(u99 "d['failures']")"
  [ "$(grep -c '^git -c bash ' "$U/git-bash.log" 2>/dev/null)" = 1 ] && [ "$(u99 "any('fine-stop.sh' in w for w in d['warnings'])")" = False ] && ok "T99 Windows: el primer .sh del evento se lanzó con el bash de Git (-c), no con cmd.exe, y salió 0" || mal "T99 Windows: lanzamiento del .sh: $(tr '\n' '|' < "$U/git-bash.log" 2>/dev/null) avisos $(u99 "d['warnings']")"

  # (b) Windows sin el bash de Git: «sin comprobar», como aviso; nunca falla, y tampoco cae en el bash del PATH
  OUT="$U/t99-b.json"
  PATH="$U/path-first:$PATH" CLAUDE_CODE_GIT_BASH_PATH="" salud99 "$OUT" win32 'Stop:@tcg:fine-stop.sh' 'Stop:@tcg:broken.sh'; RC=$?
  [ "$RC" = 0 ] && [ "$(u99 "d['ok']")" = True ] && [ "$(u99 "len(d['failures'])")" = 0 ] && ok "T99 Windows sin bash de Git: la salud no falla" || mal "T99 Windows sin bash de Git: rc $RC $(cat "$OUT" "$OUT.err" 2>&1)"
  [ "$(u99 "sum(1 for w in d['warnings'] if 'sin comprobar' in w and ('fine-stop.sh' in w or 'broken.sh' in w)) >= 2")" = True ] && ok "T99 Windows sin bash de Git: avisa «sin comprobar» por cada .sh" || mal "T99 Windows sin bash de Git: avisos $(u99 "d['warnings']")"
  [ ! -e "$U/bare-bash.log" ] && ok "T99 Windows sin bash de Git: tampoco usa el bash del PATH" || mal "T99 Windows sin bash de Git: usó el bash del PATH: $(tr '\n' '|' < "$U/bare-bash.log")"

  # (c) Windows: un .sh con \r\n en disco es un AVISO, con el guion y el remedio; NUNCA una falla (primera vuelta de
  #     revisión de la W3a). El \r\n está en el disco del clon, no lo trajo la versión nueva: si fuera falla, la
  #     actualización volvería atrás, volver atrás no lo arregla, y se repetiría en cada `update`.
  OUT="$U/t99-c.json"
  CLAUDE_CODE_GIT_BASH_PATH="$U/git/bin/bash.exe" salud99 "$OUT" win32 'Stop:@tcg:fine-stop.sh' 'Stop:@tcg:crlf-guard.sh'; RC=$?
  [ "$(u99 "any('crlf-guard.sh' in w and '\\\\r\\\\n' in w and 'rm --cached -r -q .' in w and 'reset --hard -q' in w for w in d['warnings'])")" = True ] && ok "T99 Windows: un .sh con \\r\\n es un aviso, con el guion y el remedio" || mal "T99 Windows: el .sh con \\r\\n no es un aviso con su guion y su remedio: avisos $(u99 "d['warnings']") fallas $(u99 "d['failures']")"
  # Health_CrlfShHook_WarnNotFail_UpdateNotReverted — lo que `finishHealth` (harness.js) mira para volver atrás es `ok`:
  # con sólo el \r\n, la salud queda en verde y la actualización sigue (el camino verde entero lo prueba T25-SANA)
  [ "$RC" = 0 ] && [ "$(u99 "d['ok']")" = True ] && [ "$(u99 "len(d['failures'])")" = 0 ] && ok "T99 Windows: …y la salud queda en verde (ok = true, sin fallas): la actualización NO vuelve atrás por un \\r\\n del disco" || mal "T99 Windows: un .sh con \\r\\n dejó la salud en rojo (haría volver atrás la actualización): ok $(u99 "d['ok']") fallas $(u99 "d['failures']")"
  [ "$(u99 "any('fine-stop.sh' in x for x in d['failures'] + d['warnings'])")" = False ] && ok "T99 Windows: …y el .sh sano (con \\n) no sale ni como aviso ni como falla" || mal "T99 Windows: el .sh sano salió: fallas $(u99 "d['failures']") avisos $(u99 "d['warnings']")"
  # el espejo: una rotura que SÍ es de la versión (un .sh con error de sintaxis) sigue siendo falla, con el \r\n al lado
  OUT="$U/t99-c2.json"
  CLAUDE_CODE_GIT_BASH_PATH="$U/git/bin/bash.exe" salud99 "$OUT" win32 'Stop:@tcg:fine-stop.sh' 'Stop:@tcg:broken.sh' 'Stop:@tcg:crlf-guard.sh'; RC=$?
  [ "$(u99 "d['ok']")" = False ] && [ "$(u99 "any('broken.sh' in f for f in d['failures'])")" = True ] && [ "$(u99 "any('crlf-guard.sh' in f for f in d['failures'])")" = False ] && [ "$(u99 "any('crlf-guard.sh' in w for w in d['warnings'])")" = True ] \
    && ok "T99 espejo: con un .sh de sintaxis rota al lado, la salud sí falla (por ése), y el \\r\\n sigue siendo aviso" || mal "T99 espejo de la rotura real: ok $(u99 "d['ok']") fallas $(u99 "d['failures']") avisos $(u99 "d['warnings']")"

  # (c') Health_UnreadableShHook_WarnUnverified_NeverSilent — Windows: un .sh que NO SE PUEDE LEER (lo tiene tomado otro
  #      programa) no es «sin \r\n»: aviso «sin comprobar» con el motivo; ni verde callado, ni falla (es de la máquina,
  #      no de la versión). Acá: sin permiso de lectura; como root el permiso no frena, y pasa a ser una carpeta.
  LOCKED="$LAB_TREE/scripts/hooks/locked-guard.sh"
  printf '#!/usr/bin/env bash\r\nexit 0\r\n' > "$LOCKED"; chmod 000 "$LOCKED"
  if [ -r "$LOCKED" ]; then rm -f "$LOCKED"; mkdir "$LOCKED"; fi
  OUT="$U/t99-c3.json"
  CLAUDE_CODE_GIT_BASH_PATH="$U/git/bin/bash.exe" salud99 "$OUT" win32 'Stop:@tcg:fine-stop.sh' 'Stop:@tcg:locked-guard.sh'; RC=$?
  [ "$(u99 "any('locked-guard.sh' in w and 'sin comprobar' in w for w in d['warnings'])")" = True ] && ok "T99 Windows: un .sh que no se puede leer es un aviso «sin comprobar» (no un verde callado)" || mal "T99 Windows: el .sh ilegible no dio aviso «sin comprobar»: avisos $(u99 "d['warnings']") fallas $(u99 "d['failures']")"
  [ "$(u99 "d['ok']")" = True ] && [ "$(u99 "any('locked-guard.sh' in f for f in d['failures'])")" = False ] && ok "T99 Windows: …y no es falla (la salud queda en verde)" || mal "T99 Windows: el .sh ilegible salió como falla: $(u99 "d['failures']")"
  [ "$(grep -c 'locked-guard' "$U/git-bash.log" 2>/dev/null)" = 0 ] && ok "T99 Windows: …y su sintaxis no se manda a revisar (fallaría por lo mismo)" || mal "T99 Windows: el .sh ilegible se mandó al bash de Git: $(tr '\n' '|' < "$U/git-bash.log" 2>/dev/null)"
  # el espejo: en Mac y Linux nada cambia — un .sh ilegible sigue siendo falla de `bash -n`, como antes
  OUT="$U/t99-c4.json"
  salud99 "$OUT" linux 'Stop:@tcg:fine-stop.sh' 'Stop:@tcg:locked-guard.sh'; RC=$?
  [ "$(u99 "any('locked-guard.sh' in f for f in d['failures'])")" = True ] && [ "$(u99 "any('sin comprobar' in w for w in d['warnings'])")" = False ] && ok "T99 espejo linux: un .sh ilegible sigue siendo falla de bash -n, como antes" || mal "T99 espejo linux del .sh ilegible: fallas $(u99 "d['failures']") avisos $(u99 "d['warnings']")"
  if [ -d "$LOCKED" ]; then rmdir "$LOCKED"; else chmod 644 "$LOCKED"; rm -f "$LOCKED"; fi

  # (d) espejo: en Mac y Linux nada cambia — `bash` del PATH para la sintaxis y /bin/sh para lanzar; el \r\n no se mira
  for PLAT in linux darwin; do
    OUT="$U/t99-d-$PLAT.json"
    CLAUDE_CODE_GIT_BASH_PATH="$U/git/bin/bash.exe" salud99 "$OUT" "$PLAT" 'Stop:@tcg:fine-stop.sh' 'Stop:@tcg:broken.sh' 'Stop:@tcg:crlf-guard.sh'; RC=$?
    [ "$(u99 "any('broken.sh' in f for f in d['failures'])")" = True ] && [ "$(u99 "any('fine-stop.sh' in f or 'crlf-guard.sh' in f for f in d['failures'])")" = False ] && ok "T99 espejo $PLAT: como antes (falla sólo el de sintaxis rota; el \\r\\n no se mira)" || mal "T99 espejo $PLAT: $(u99 "d['failures']") $(cat "$OUT.err")"
    [ ! -e "$U/git-bash.log" ] && ok "T99 espejo $PLAT: no busca ni usa el bash de Git" || mal "T99 espejo $PLAT: usó el bash de Git: $(tr '\n' '|' < "$U/git-bash.log")"
    OUT="$U/t99-d2-$PLAT.json"
    PATH="$U/path-first:$PATH" CLAUDE_CODE_GIT_BASH_PATH="" salud99 "$OUT" "$PLAT" 'Stop:@tcg:fine-stop.sh'; RC=$?
    [ "$(grep -c '^bare -n ' "$U/bare-bash.log" 2>/dev/null)" = 1 ] && [ "$(u99 "any('fine-stop.sh' in f for f in d['failures'])")" = True ] && ok "T99 espejo $PLAT: usa el bash del PATH, como siempre" || mal "T99 espejo $PLAT: bash del PATH: $(tr '\n' '|' < "$U/bare-bash.log" 2>/dev/null) fallas $(u99 "d['failures']")"
  done
fi

# ═══ T38 (story 8.16, tanda C · AC 28) · la salud en minimal: eventos sin ningún hook no son una falla ══════════════════
# minimal no trae hooks de Stop (ni la mayoría de los de los otros eventos): la comprobación lanza el primer hook de cada
# evento QUE TENGA alguno, y un evento vacío no se juzga. La parte de doctor vive en harness-doctor.test.sh.
if corre T38-PROFILE; then
  echo "· T38 HealthAndDoctor_Minimal_GreenWithEventsWithoutHooks (la salud)"
  harness_lab_create "$BASE/t38p" >/dev/null
  U="$LAB/t38p"; mkdir -p "$U"
  SK="$LAB_SKILLS/skills"; mkdir -p "$SK/tycon-pipeline"
  printf 'process.exit(0);\n' > "$SK/tycon-pipeline/on-advisor-run.js"
  printf 'process.exit(0);\n' > "$LAB_TREE/scripts/hooks/branch-guard-notice.js"
  printf 'process.stdout.write(JSON.stringify({mode:"managed",fail:[],warn:[],ok:["perfil: minimal (~/.claude/tycon.json)"]}));\n' > "$U/doctor-green.js"
  # el settings.json de una instalación minimal de juguete: SessionStart y PreToolUse con un hook; Stop, PostToolUse y
  # UserPromptSubmit sin ninguno
  python3 - "$TYCON_SETTINGS_PATH" "$LAB_TREE" "$SK" <<'PY'
import json, sys
p, tree, sk = sys.argv[1:4]
s = {"hooks": {
  "SessionStart": [{"hooks": [{"type": "command", "command": 'node "%s/scripts/hooks/branch-guard-notice.js"' % tree}]}],
  "PreToolUse": [{"matcher": "Task|Agent", "hooks": [{"type": "command", "command": 'node "%s/tycon-pipeline/on-advisor-run.js"' % sk}]}],
}}
json.dump(s, open(p, "w", encoding="utf-8"), indent=2)
PY
  cat > "$U/check.js" <<'JS'
const [mod, tree, skillsDir, reportJson, harnessJs] = process.argv.slice(2);
const r = require(mod).check({ home: process.env.HOME, env: process.env, platform: process.platform, tree }, { tree, skillsDir, report: JSON.parse(reportJson), applierOut: 'aplicador corrido', harnessJs, log: () => {} });
process.stdout.write(JSON.stringify(r));
JS
  REP="$(python3 -c 'import json,sys; print(json.dumps([{"kind":"hook","where":sys.argv[1],"id":i} for i in sys.argv[2:]]))' "$TYCON_SETTINGS_PATH" 'SessionStart:@tcg:branch-guard-notice.js' 'PreToolUse:tycon-pipeline/on-advisor-run.js')"
  node "$U/check.js" "$RAIZ/scripts/setup/harness/health.js" "$LAB_TREE" "$SK" "$REP" "$U/doctor-green.js" > "$U/t38.json" 2> "$U/t38.err"; RC=$?
  [ "$RC" = 0 ] && [ "$(j "$U/t38.json" "d['ok']")" = True ] && [ "$(j "$U/t38.json" "len(d['failures'])")" = 0 ] \
    && ok "T38 la salud de una instalación minimal (Stop, PostToolUse y UserPromptSubmit sin hooks) pasa" \
    || mal "T38 la salud en minimal: rc $RC · $(j "$U/t38.json" "d.get('failures')") $(head -c 200 "$U/t38.err")"
fi

# ═══ EPIPE · un hook que sale sin leer su payload CORRIÓ: no es «no pude lanzarlo» ═════════════════════════════════════
# public-ci, 2026-10-14: T99 salió rojo de a ratos con «hook Stop:@tcg:fine-stop.sh: no pude lanzarlo (spawnSync …
# EPIPE)». fine-stop.sh es `exit 0`: si termina antes de que spawnSync le escriba el payload, spawnSync trae EPIPE y
# TAMBIÉN el código de salida del hook. La salud miraba sólo `r.error`. Acá el EPIPE se provoca siempre: un payload más
# grande que el búfer del caño y un hijo que sale sin leer (node, no un shell: vale igual en Windows).
# 🔴 rojo previo: `r.error` viene puesto (lo que la salud miraba antes), así que el hook sano era un aviso.
if corre EPIPE; then
  echo "· epipe"
  U="$BASE/epipe"; mkdir -p "$U"
  cat > "$U/epipe.js" <<'JS'
const { spawnSync } = require('child_process');
const { launchError } = require(process.argv[2]);
const big = 'x'.repeat(1024 * 1024);
const run = (code) => spawnSync(process.execPath, ['-e', `process.exit(${code})`], { input: big, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const r0 = run(0); const r2 = run(2);
const missing = spawnSync('tycon-no-existe-este-programa', [], { input: 'x', encoding: 'utf8' });
const out = {
  r0: { code: r0.error && r0.error.code, status: r0.status, launch: launchError(r0) && launchError(r0).code },
  r2: { code: r2.error && r2.error.code, status: r2.status, launch: launchError(r2) && launchError(r2).code },
  missing: { launch: launchError(missing) && launchError(missing).code },
  epipeNoStatus: launchError({ error: { code: 'EPIPE' }, status: null }) ? 'error' : null,
  clean: launchError({ status: 0 }),
};
process.stdout.write(JSON.stringify(out));
JS
  node "$U/epipe.js" "$RAIZ/scripts/setup/harness/health.js" > "$U/epipe.json" 2> "$U/epipe.err"; RC=$?
  e() { j "$U/epipe.json" "$1"; }
  [ "$RC" = 0 ] && [ "$(e "d['r0']['code']")" = EPIPE ] && [ "$(e "d['r0']['status']")" = 0 ] \
    && ok "EPIPE reproducido: el hook salió 0 sin leer el payload y spawnSync trae EPIPE con el código de salida (lo que antes era aviso)" \
    || mal "EPIPE no se reprodujo (rc $RC): $(cat "$U/epipe.json" "$U/epipe.err" 2>/dev/null | head -c 300) — sin él el caso no mide nada"
  [ "$(e "d['r0']['launch']")" = None ] && ok "EPIPE: un hook que salió 0 sin leer el payload corrió (no es «no pude lanzarlo»)" || mal "EPIPE: el hook sano es error de lanzamiento: $(e "d['r0']")"
  [ "$(e "d['r2']['launch']")" = None ] && [ "$(e "d['r2']['status']")" = 2 ] && ok "EPIPE: uno que sale 2 sin leer también corrió, y su 2 llega (sigue siendo falla de la salud)" || mal "EPIPE: el que sale 2: $(e "d['r2']")"
  [ "$(e "d['missing']['launch']")" = ENOENT ] && ok "EPIPE espejo: un programa que no existe sigue siendo «no pude lanzarlo»" || mal "EPIPE espejo ENOENT: $(e "d['missing']")"
  [ "$(e "d['epipeNoStatus']")" = error ] && [ "$(e "d['clean']")" = None ] && ok "EPIPE espejo: un EPIPE sin código de salida (no se sabe si corrió) sigue siendo error; sin error, nada" || mal "EPIPE espejo sin código de salida: $(e "d['epipeNoStatus']") / $(e "d['clean']")"
fi

if [ "$FALLOS" = 0 ]; then echo "✅ harness-health: todo verde"; exit 0; fi
echo "❌ harness-health: $FALLOS fallo(s)"; exit 1
