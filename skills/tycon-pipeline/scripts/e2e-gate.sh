#!/usr/bin/env bash
# =============================================================================
# e2e-gate.sh — Gate E2E GENÉRICO del harness TYCON
# =============================================================================
# Por qué vive acá y no en cada repo: si cada proyecto escribe su gate, el
# CONTRATO de la evidencia (qué campos tiene que traer para que runtime-matrix.js la lea)
# vive sólo en la documentación y las N copias se desincronizan solas. Si DODRT-C8 suma
# la sección "## Tests corridos" y un repo la tiene y otro no, la regla bloquea al segundo
# por un detalle del script, no por su calidad.
# Mismo patrón que `lint-story-frontmatter.js` / `lint-wiki.sh`: el script vive UNA vez en
# el harness y cada repo lo referencia; lo específico del proyecto viaja por configuración.
#
# Uso (contrato de tycon-pipeline): e2e-gate.sh <frontend-dir> <ruta-de-la-story.md | story-id> <evidence-dir> [spec-filter...]
#   Con la RUTA de la story, la clave del archivo de evidencia la calcula lib/evidence-key.js:
#   el número solo si es único en su repo, `<tema>__<número>` si se repite.
#   - Con [spec-filter] corre SCOPED a esos specs; sin filtro, la suite completa.
#   - Escribe <story-id>-e2e-gate-<tsUTC>.md con el bloque machine-parseable que consume
#     runtime-matrix.js: verdict=, **Spec filter**:, totales y "## Tests corridos".
#   - Códigos de salida (los decide `veredicto()` en lib/e2e-evidence.js — ver su cabecera; el
#     orquestador ACTÚA según el número, así que no son libres):
#       0 = PASS  ·  1 = FAIL (Playwright en rojo)  ·  2 = el filtro no matcheó ningún test
#       3 = el stack no levantó (precondición)       ·  4 = había tests y TODOS se saltearon solos
#     2 y 4 NO son verdes: el gate no ejerció nada (verdict=SIN_EJERCER). Se separan porque el
#     arreglo difiere — 2 es un nombre de spec mal escrito, 4 es un entorno sin los datos que
#     los specs necesitan.
#
# Config del repo (.tycon/advisors.yaml), TODO opcional salvo frontend_dir:
#   e2e:
#     frontend_dir: mi-frontend         # dir con playwright.config.*
#     preconditions:                        # servicios que tienen que responder ANTES
#       - "http://localhost:5001/api/health|DevHost backend — Backend/scripts/devhost.sh start"
#       - "http://localhost:8083/dev.html|form servido — FrontEnd/start-all.sh"
#     bundle:                               # frescura del artefacto que el navegador CARGA
#       artifact: dist/form.dev.js          #   relativo al frontend_dir
#       sources: src                        #   dir cuyo archivo más nuevo se compara
#       rebuild: npm run build:dev          #   opcional: si está, se recompila solo
#   Un repo con necesidades raras puede seguir declarando `gate:` propio y este script no
#   se usa: el escape sigue existiendo, sólo deja de ser el default.
# =============================================================================
set -uo pipefail

FRONTEND_DIR="${1:?uso: e2e-gate.sh <frontend-dir> <story-id> <evidence-dir> [spec-filter...]}"
STORY_ID="${2:?falta story-id o la ruta de la story}"
EVIDENCE_DIR="${3:?falta evidence-dir}"
# La clave de la evidencia: con la ruta de la story, la calcula lib/evidence-key.js. Si no se
# puede decidir, el gate no corre: un resultado bajo una clave adivinada puede contarle a otra story.
# 2 y 4 ya significan «no ejerció nada» en el contrato del gate: todo esto sale 1 (una falla), sin escribir evidencia.
case "$STORY_ID" in
  *.md)
    if [ ! -f "$STORY_ID" ]; then
      echo "e2e-gate.sh: no encontré la story $STORY_ID — el gate no corre (una ruta mal escrita no puede nombrar evidencia)." >&2
      exit 1
    fi
    KEY_JS="$(cd "$(dirname "$0")" && pwd)/lib/evidence-key.js"
    if ! STORY_KEY="$(node "$KEY_JS" "$STORY_ID")" || [ -z "$STORY_KEY" ]; then
      echo "e2e-gate.sh: no pude calcular la clave de la evidencia de $STORY_ID — el gate no corre." >&2
      exit 1
    fi
    STORY_ID="$STORY_KEY" ;;
esac
# El id nombra el archivo de evidencia: sólo letras, números y `. _ + ~ -`, sin `..` (una barra escribiría afuera).
_ID_RE='^[A-Za-z0-9][A-Za-z0-9._+~-]*$'
if ! [[ "$STORY_ID" =~ $_ID_RE ]] || [[ "$STORY_ID" == *..* ]]; then
  echo "e2e-gate.sh: «${STORY_ID}» no sirve para nombrar evidencia (sólo letras, números y . _ + ~ -, sin ..) — el gate no corre." >&2
  exit 1
fi
shift 3
SPEC_FILTERS=("$@")

BUNDLE_NOTA=""
LLAVE_NOTA=""
TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$EVIDENCE_DIR"
EVIDENCE_FILE="$EVIDENCE_DIR/${STORY_ID}-e2e-gate-${TS}.md"

escribir_evidencia() {
  local verdict="$1" total="$2" passed="$3" failed="$4" skipped="$5" exit_code="$6" extra="${7:-}"
  {
    echo "# E2E Gate — $STORY_ID — $TS"
    echo ""
    echo "verdict=$verdict"
    # Todos los filtros: con sólo el primero, los demás specs corridos quedan invisibles en la constancia.
    echo "**Spec filter**: ${SPEC_FILTERS[*]:-}"
    echo ""
    echo "## Playwright Run"
    echo "- verdict: $verdict"
    echo "- total: $total"
    echo "- passed: $passed"
    echo "- failed: $failed"
    echo "- skipped: $skipped"
    echo "- scope: ${SPEC_FILTERS[*]:-full}"
    echo "- exit_code: $exit_code"
    echo "- frontend_dir: $FRONTEND_DIR"
    # Sin esta línea, un verde sobre un bundle viejo es indistinguible de uno de verdad.
    echo "- bundle: ${BUNDLE_NOTA:-no declarado (e2e.bundle en .tycon/advisors.yaml)}"
    # Con qué llaves corrió: un verde en modo exigente y uno en modo permisivo se leen IGUAL si esto
    # no se escribe, y son cosas distintas — en el permisivo un spec puede saltearse sin dejar rastro.
    echo "- llave_exigente: ${LLAVE_NOTA:-(no se llegó a computar)}"
    echo ""
    # Contrato DODRT-C8: sin esta sección la matriz no puede distinguir "el test miró el
    # botón" de "el test lo apretó" (título con @mutates), y un AC de acción queda parcial.
    echo "## Tests corridos (títulos completos — contrato DODRT-C8)"
    echo "${TITULOS:-}"
    echo ""
    # Lo que el cierre le muestra al dev antes de pedir el commit. Va SIEMPRE, como las otras: sin
    # capturas dice por qué (una sección ausente no distingue «no hubo» de «este gate es viejo»).
    echo "## Capturas"
    if [ -n "${CAPTURAS_LISTA:-}" ]; then echo "$CAPTURAS_LISTA"
    else echo "${CAPTURAS_NOTA:-ninguna — el gate terminó antes de correr las pruebas}"; fi
    echo ""
    # La sección va SIEMPRE, aunque no haya salida: una sección ausente es ambigua —
    # no se distingue "corrió y no hubo errores" de "este gate es viejo y no la escribe".
    # Es el mismo modo de falla que "## Tests corridos" (DODRT-C8): el silencio no informa.
    echo "## Output (tail)"
    echo '```'
    echo "${extra:-(sin salida de error)}"
    echo '```'
  } > "$EVIDENCE_FILE"
}

fail_precondition() {
  TITULOS=""
  escribir_evidencia "FAIL" 0 0 0 0 1 "precondición no cumplida: $1"
  echo "E2E GATE FAIL: $1" >&2
  exit 1
}

# --- Pre-condiciones declaradas por el repo -----------------------------------
# Formato por línea: "<url>|<qué levantar si no responde>". curl -f: sin él un 404/500
# devuelve exit 0 y la precondición sería un no-op.
REPO_ROOT="$(cd "$FRONTEND_DIR" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null || echo "")"
YAML="$REPO_ROOT/.tycon/advisors.yaml"
[ -f "$YAML" ] || YAML="$REPO_ROOT/.tycon/advisors.yml"
if [ -f "$YAML" ]; then
  while IFS= read -r linea; do
    url="${linea%%|*}"; ayuda="${linea#*|}"
    [ -z "$url" ] && continue
    curl -sf -o /dev/null --max-time 5 "$url" || fail_precondition "$ayuda (no responde: $url)"
  done < <(awk '
    /^[[:space:]]*preconditions:[[:space:]]*$/ { en=1; next }
    en && /^[[:space:]]*-[[:space:]]/ { sub(/^[[:space:]]*-[[:space:]]*/, ""); gsub(/^["'"'"']|["'"'"']$/, ""); print; next }
    en && /^[[:space:]]*[a-zA-Z_]+:/ { en=0 }
  ' "$YAML")
fi

# --- La llave exigente: un spec que se saltea solo tiene que FALLAR ------------
# 🔴 Los specs del set crítico se saltean solos cuando la base no tiene datos (`test.skip(cantidad === 0, …)`).
# Playwright devuelve 0, y el gate no tiene con qué distinguir "probé y anduvo" de "no probé nada". El veredicto
# SIN_EJERCER frena el caso extremo —CERO ejecutados—, pero 1 de 4 seguiría siendo verde: el hueco no se cierra
# contando, se cierra haciendo que el salteo sea un rojo.
#
# La convención (`guides/definition-of-done.md` §2, regla REAL-C8 del advisor de realness):
# una env var `<DOMAIN>_REQUIRED=1` cuya rama LANZA en vez de saltear. Falta decidir quién la
# prende: pedirle al dev que se acuerde de exportarla es el mismo olvido corrido un casillero, así
# que la prende el gate, SIEMPRE. `E2E_REQUIRED` es el nombre paraguas del arnés; los nombres por
# dominio que ya usa cada repo se declaran en `e2e.required_env` y se prenden igual.
#
# Prenderla no rompe nada en un repo que todavía no la honra: es una env var que nadie lee. Lo que
# cambia es que un spec que se saltea en silencio es una DEUDA VISIBLE — la
# evidencia dice con qué llaves corrió, y la línea de salida nombra los salteos que quedaron.
LLAVES=("E2E_REQUIRED")
if [ -f "$YAML" ]; then
  while IFS= read -r nombre; do
    [ -z "$nombre" ] && continue
    LLAVES+=("$nombre")
  done < <(awk '
    /^[[:space:]]*required_env:[[:space:]]*$/ { en=1; next }
    en && /^[[:space:]]*-[[:space:]]/ { sub(/^[[:space:]]*-[[:space:]]*/, ""); gsub(/^["'"'"']|["'"'"']$/, ""); sub(/[[:space:]]+#.*$/, ""); print; next }
    en && /^[[:space:]]*[a-zA-Z_]+:/ { en=0 }
  ' "$YAML")
fi
for llave in "${LLAVES[@]}"; do export "$llave=1"; done
LLAVE_NOTA="$(printf '%s=1 ' "${LLAVES[@]}")"
LLAVE_NOTA="${LLAVE_NOTA% }"

# --- Frescura del bundle que el navegador realmente carga ---------------------
# 🔴 La página de
# desarrollo carga `dist/form.dev.js` mientras el build del pipeline genera `dist/form.js`. Correr
# los E2E sin recompilar prueba CÓDIGO VIEJO y sale VERDE — el peor resultado posible, porque un
# verde sobre el artefacto equivocado se lee igual que un verde de verdad. Acordarse a mano de
# recompilar no alcanza: un control que depende de que alguien se acuerde no es un control.
#
# Declarado por repo (`e2e.bundle` en .tycon/advisors.yaml): con `rebuild:` recompila solo; sin
# `rebuild:` falla ruidosamente diciendo qué comando correr.
# 🔴 Y SIN declarar también se juzga: si fuera sólo opt-in, NINGÚN repo lo declararía, ni uno con
# varias apps con `dev.html` + `dist/form.dev.js`. Un control que depende de que alguien se acuerde de DECLARARLO es el mismo
# olvido corrido un casillero. Si hay un `dev.html` que carga un bundle que existe en el disco y hay
# un `src/`, la frescura se juzga igual; lo que no se puede juzgar (sin página, sin bundle en disco,
# sin fuentes) se dice en la evidencia, nunca se calla. Casos C-07 a C-09 de e2e-gate-bundle.test.sh.
BUNDLE_NOTA=""
if [ -f "$YAML" ]; then
  leer_bundle() { awk -v k="$1" '
    /^[[:space:]]*bundle:[[:space:]]*$/ { en=1; next }
    en && $0 ~ "^[[:space:]]+" k ":" { sub("^[[:space:]]*" k ":[[:space:]]*", ""); gsub(/^["'"'"']|["'"'"']$/, ""); sub(/[[:space:]]+#.*$/, ""); print; exit }
    en && /^[[:space:]]{0,2}[a-zA-Z_]+:/ { en=0 }
  ' "$YAML"; }
  B_ART="$(leer_bundle artifact)"; B_SRC="$(leer_bundle sources)"; B_CMD="$(leer_bundle rebuild)"

  if [ -n "$B_ART" ] && [ -n "$B_SRC" ]; then
    ART_PATH="$FRONTEND_DIR/$B_ART"; SRC_PATH="$FRONTEND_DIR/$B_SRC"
    # El fuente más nuevo del árbol. -newer compara mtime: si el artefacto no existe, o hay
    # cualquier fuente posterior, hay que recompilar.
    VIEJO=0
    if [ ! -f "$ART_PATH" ]; then
      VIEJO=1; MOTIVO="el bundle no existe todavía"
    elif [ -d "$SRC_PATH" ] && [ -n "$(find "$SRC_PATH" -type f -newer "$ART_PATH" -print -quit 2>/dev/null)" ]; then
      VIEJO=1; MOTIVO="hay fuentes más nuevos que el bundle"
    fi

    if [ "$VIEJO" = "1" ]; then
      if [ -n "$B_CMD" ]; then
        echo "E2E gate: $MOTIVO — recompilando ($B_CMD)..." >&2
        if ( cd "$FRONTEND_DIR" && eval "$B_CMD" >/dev/null 2>&1 ); then
          BUNDLE_NOTA="bundle recompilado antes de correr ($MOTIVO; \`$B_CMD\`)"
        else
          TITULOS=""
          escribir_evidencia "FAIL" 0 0 0 0 1 "no se pudo recompilar el bundle: $B_CMD"
          echo "E2E GATE FAIL: $MOTIVO y \`$B_CMD\` falló — los E2E probarían código viejo" >&2
          exit 1
        fi
      else
        fail_precondition "$MOTIVO ($B_ART): los E2E probarían código viejo — recompilá antes de correr"
      fi
    else
      BUNDLE_NOTA="bundle al día ($B_ART)"
    fi
  fi
fi

# Sin declarar: la página de desarrollo dice qué bundle carga el navegador. Se detecta por POSICIÓN
# (el primer `<script src="…js">` relativo de `dev.html`), y sólo cuenta si el archivo existe.
if [ -z "$BUNDLE_NOTA" ] && [ -f "$FRONTEND_DIR/dev.html" ]; then
  D_ART="$(grep -o '<script[^>]*src="[^"]*\.js"' "$FRONTEND_DIR/dev.html" 2>/dev/null | grep -v 'src="http' | head -1 | sed 's/.*src="\([^"]*\)".*/\1/')"
  if [ -z "$D_ART" ]; then
    BUNDLE_NOTA="no declarado y dev.html no carga ningún bundle relativo: no se juzgó"
  elif [ ! -f "$FRONTEND_DIR/$D_ART" ]; then
    BUNDLE_NOTA="no declarado; dev.html carga $D_ART pero no existe en el disco: no se juzgó la frescura"
  elif [ ! -d "$FRONTEND_DIR/src" ]; then
    BUNDLE_NOTA="no declarado; dev.html carga $D_ART pero no hay src/ con qué compararlo: no se juzgó la frescura"
  elif [ -n "$(find "$FRONTEND_DIR/src" -type f -newer "$FRONTEND_DIR/$D_ART" -print -quit 2>/dev/null)" ]; then
    fail_precondition "hay fuentes en src/ más nuevos que $D_ART, el bundle que carga dev.html: los E2E probarían código viejo — recompilá antes de correr, o declará e2e.bundle con rebuild: en .tycon/advisors.yaml para que se recompile solo"
  else
    BUNDLE_NOTA="bundle al día ($D_ART, detectado en dev.html; e2e.bundle no declarado)"
  fi
fi

# --- Correr Playwright --------------------------------------------------------
cd "$FRONTEND_DIR" || fail_precondition "frontend_dir inexistente: $FRONTEND_DIR"

# --- Capturas de los specs de la story (story 7.24) ---------------------------
# 🔴 Caso disparador (2026-10-14): una ventana pasó todos los controles y
# nadie la vio antes del merge; el dueño la encontró «inentendible» en staging. Con filtro (los specs de la story), el
# gate fuerza `screenshot: 'on'` con una config ENVOLTORIO temporal que importa la del repo —la del repo no se toca— y
# copia a la evidencia las imágenes que lista el reporte (también las que el spec adjunta con `testInfo.attach`).
# Las capturas NUNCA cambian el veredicto: si el envoltorio no carga (se prueba con `--list`), corre como siempre y la
# evidencia dice el motivo. Sin filtro no se guardan: la corrida completa no es la de la story.
CAPTURAS_NOTA=""; CAPTURAS_LISTA=""; CONFIG_ARGS=(); ENVOLTORIO=""
if [ ${#SPEC_FILTERS[@]} -eq 0 ]; then
  CAPTURAS_NOTA="ninguna — corrida completa sin filtro: las capturas se guardan sólo para los specs de la story"
else
  BASE_CFG=""
  for c in playwright.config.ts playwright.config.mts playwright.config.js playwright.config.mjs playwright.config.cjs; do
    [ -f "$c" ] && { BASE_CFG="$c"; break; }
  done
  if [ -z "$BASE_CFG" ]; then
    CAPTURAS_NOTA="ninguna — no encontré playwright.config.* en $FRONTEND_DIR: no se pudo forzar la captura"
  else
    case "$BASE_CFG" in *.ts|*.js) BASE_IMPORT="./${BASE_CFG%.*}" ;; *) BASE_IMPORT="./$BASE_CFG" ;; esac
    ENVOLTORIO="$PWD/.tycon-e2e-captures-$$.config.ts"
    trap 'rm -f "$ENVOLTORIO" "$ENVOLTORIO.err"' EXIT
    cat > "$ENVOLTORIO" <<ENV
// Generado por el gate E2E del arnés (story 7.24); se borra al terminar. Fuerza la captura sin tocar la config del repo.
import base from '$BASE_IMPORT';
const b: any = (base as any)?.default ?? base;
const on = (u: any) => ({ ...(u || {}), screenshot: 'on' });
export default { ...b, use: on(b.use), ...(Array.isArray(b.projects) ? { projects: b.projects.map((p: any) => ({ ...p, use: on(p.use) })) } : {}) };
ENV
    if npx playwright test --config "$ENVOLTORIO" --list ${SPEC_FILTERS[@]+"${SPEC_FILTERS[@]}"} > /dev/null 2> "$ENVOLTORIO.err" < /dev/null; then
      CONFIG_ARGS=(--config "$ENVOLTORIO")
    else
      CAPTURAS_NOTA="ninguna — no se pudo forzar la captura (la config envuelta no cargó: $(grep -m1 . "$ENVOLTORIO.err" 2>/dev/null | cut -c1-200)); corrió con la config del repo"
      rm -f "$ENVOLTORIO"
    fi
  fi
fi

JSON_OUT="$(mktemp)"
# ${arr[@]+...}: expansión bash-3.2-safe — el array vacío con `set -u` es 'unbound variable'
# en el bash de macOS y el modo full-suite abortaba sin escribir evidencia.
npx playwright test ${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"} --workers=1 --reporter=json ${SPEC_FILTERS[@]+"${SPEC_FILTERS[@]}"} > "$JSON_OUT" 2> "$JSON_OUT.err"
EXIT_CODE=$?
[ -n "$ENVOLTORIO" ] && rm -f "$ENVOLTORIO" "$ENVOLTORIO.err"

if [ ${#CONFIG_ARGS[@]} -gt 0 ]; then
  # Lo que no se pudo copiar (imagen que falta, reporte ilegible, el propio comando que falla) se ESCRIBE en la
  # sección: callado, salía como «ningún test corrió» y escondía la causa. Nunca cambia el veredicto.
  CAPTURAS_LISTA="$(node "$(dirname "${BASH_SOURCE[0]}")/lib/e2e-evidence.js" captures "$JSON_OUT" "$EVIDENCE_DIR/${STORY_ID}-captures-${TS}" 2> "$JSON_OUT.cap")"
  CAP_RC=$?
  CAP_ERR="$(cut -c1-300 "$JSON_OUT.cap" 2>/dev/null | head -10)"; rm -f "$JSON_OUT.cap"
  [ "$CAP_RC" -eq 0 ] || CAP_ERR="la copia de capturas falló (exit $CAP_RC)${CAP_ERR:+: $CAP_ERR}"
  if [ -n "$CAPTURAS_LISTA" ]; then
    [ -z "$CAP_ERR" ] || CAPTURAS_LISTA="$CAPTURAS_LISTA"$'\n'"$(printf '%s\n' "$CAP_ERR" | sed 's/^/· /')"
  elif [ -n "$CAP_ERR" ]; then
    CAPTURAS_NOTA="ninguna — $(printf '%s' "$CAP_ERR" | tr '\n' ';')"
  else
    CAPTURAS_NOTA="ninguna — la corrida no dejó imágenes (¿ningún test llegó a correr?)"
  fi
fi

read -r TOTAL PASSED FAILED SKIPPED <<< "$(node -e 'const l=require(process.argv[2]);const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch(e){};const t=l.totals(j);console.log(t.total,t.passed,t.failed,t.skipped)' "$JSON_OUT" "$(dirname "${BASH_SOURCE[0]}")/lib/e2e-evidence.js")"

TITULOS="$(node "$(dirname "${BASH_SOURCE[0]}")/lib/e2e-evidence.js" titles "$JSON_OUT")"

# Veredicto de TRES estados (story FIX-Q1 de un producto del equipo, 2026-09-27). El exit code de Playwright NO
# alcanza: devuelve 0 cuando TODOS los tests se saltean, y así este gate reportó "PASS (0/4)" con
# cero flujos ejercidos. La decisión vive en la librería del contrato, con sus tests
# (tests/e2e-gate-verdict.test.js), para que no se re-copie mal en el gate de cada repo.
LIB="$(dirname "${BASH_SOURCE[0]}")/lib/e2e-evidence.js"
read -r VERDICT GATE_EXIT <<< "$(node -e 'const ev=require(process.argv[1]);const v=ev.veredicto({exitCode:+process.argv[2],total:+process.argv[3],passed:+process.argv[4],failed:+process.argv[5],skipped:+process.argv[6]});console.log(v.verdict, v.exit)' "$LIB" "$EXIT_CODE" "${TOTAL:-0}" "${PASSED:-0}" "${FAILED:-0}" "${SKIPPED:-0}")"
MOTIVO="$(node -e 'const ev=require(process.argv[1]);process.stdout.write(ev.veredicto({exitCode:+process.argv[2],total:+process.argv[3],passed:+process.argv[4],failed:+process.argv[5],skipped:+process.argv[6]}).motivo)' "$LIB" "$EXIT_CODE" "${TOTAL:-0}" "${PASSED:-0}" "${FAILED:-0}" "${SKIPPED:-0}")"

# Los recorridos declarados que esta app NO tiene: sin esta línea, correr 1 de 5 se lee igual que
# correr los 5.
NO_ENCONTRADOS="$(node -e 'const ev=require(process.argv[1]);console.log(ev.filtrosNoEncontrados(process.argv[2], process.argv.slice(3)).join(" "))' "$LIB" "$FRONTEND_DIR" ${SPEC_FILTERS[@]+"${SPEC_FILTERS[@]}"})"

EXTRA="$(tail -c 4000 "$JSON_OUT.err")"
[ -n "$MOTIVO" ] && EXTRA="motivo: $MOTIVO"$'\n'"$EXTRA"
[ -n "$NO_ENCONTRADOS" ] && EXTRA="declarados y NO encontrados en $(basename "$FRONTEND_DIR"): $NO_ENCONTRADOS"$'\n'"$EXTRA"
escribir_evidencia "$VERDICT" "${TOTAL:-0}" "${PASSED:-0}" "${FAILED:-0}" "${SKIPPED:-0}" "$EXIT_CODE" "$EXTRA"
rm -f "$JSON_OUT" "$JSON_OUT.err"

echo "E2E gate $VERDICT (${PASSED:-0} ejecutado/s de ${TOTAL:-0}, ${SKIPPED:-0} salteado/s) — $MOTIVO"
[ -n "$NO_ENCONTRADOS" ] && echo "⚠️  declarados y NO encontrados en $(basename "$FRONTEND_DIR"): $NO_ENCONTRADOS" >&2
# Un salteo con la llave prendida es un spec que NO la honra: deuda visible, no un verde limpio.
# No frena (frenar acá rompería a todo repo que aún no la implementó), pero se nombra siempre.
[ "${SKIPPED:-0}" -gt 0 ] && echo "⚠️  $SKIPPED test(s) se saltearon con la llave exigente prendida ($LLAVE_NOTA): esos specs no la honran — REAL-C8, el salteo debería LANZAR" >&2
echo "   evidencia: $EVIDENCE_FILE"
exit "$GATE_EXIT"
