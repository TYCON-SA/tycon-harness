#!/usr/bin/env bash
# =============================================================================
# tycon-pipeline — Test Gate (cierre del Step 4)
# =============================================================================
# Corre la suite de tests + coverage UNA SOLA VEZ y persiste el resultado como
# artefacto machine-parseable. Nace de la auditoría 2026-06-09:
#
#   - tycon-plugin-tests-coverage (advisor LLM con Bash) corría la FULL SUITE
#     dentro del fan-out del Step 5, EN CADA iteración (3-4x por corrida) y en
#     paralelo con 4-5 subagentes — la combinación exacta que congeló la máquina
#     del dev 2 veces. Ahora el advisor LEE este artefacto (sin Bash).
#   - El gate de coverage 75% lo "afirmaba" el LLM. Ahora el % sale de parsear
#     el cobertura.xml / coverage-final.json REAL.
#   - marker.checks.tests se setea vía `marker.js run-check` (exit code real,
#     provenance=run-check, gates.log) — el Stop-gate autónomo lee ground-truth.
#
# Uso:
#   test-gate.sh <repo-dir> [story-id|story-path] [subdir]
#
#   Detecta el stack: *.csproj → dotnet test --collect; package.json con vitest
#   → npx vitest run --coverage. Escribe:
#     <repo>/.advisors/tests-result.json   ← el artefacto que lee el advisor
#
#   En un repo con MÁS DE UN proyecto testeable, el alcance se DEDUCE de los
#   archivos que la story declara (`files_to_create`/`files_to_modify`) o, si no
#   hay story, del diff real. Si no se puede deducir, FRENA (exit 4) en vez de
#   elegir mal — decisiones del dev 2026-08-13. Ver `lib/test-scope.js`.
#   Pasar la RUTA de la story en $2 (en vez del id) habilita la deducción por
#   declaración y saca el id del frontmatter.
#
# Exit: el exit code REAL de la suite (0 verde, !=0 rojo) · 3 sin stack de tests
#       · 4 alcance ambiguo (no se corrió NADA) · 5 falta la herramienta que corre las
#       pruebas, `npx`, `dotnet` o `npm` (no se corrió NADA; story 8.17, AC 50)
#       · 6 la suite salió 0 sin ninguna prueba corrida, o sin informe que lo cuente (no es verde).
#
# Sin `python3`, `timeout` ni `realpath` (story 8.17, AC 46 y 50): en Windows no son
# requisito. El informe es lib/test-gate-report.js.
#
# Coverage sobre archivos NUEVOS (git diff --diff-filter=A + untracked): el
# umbral 75% (TEST-W2) NO bloquea acá — queda en el artefacto y el advisor lo
# reporta como WARNING con cita al archivo.
# =============================================================================
set -uo pipefail

# 🔴 Lanzado DENTRO de `node --test` (una prueba que corre este gate), el hijo heredaba NODE_TEST_CONTEXT y el
# `node --test` de la suite escribía en el formato interno de Node, no el resumen `ℹ tests N`: el informe no contaba
# ninguna prueba y quedaba verde (hallazgo de la tanda W6 de la story 8.17). La suite corre como en una terminal.
unset NODE_TEST_CONTEXT

# REPO canonicalizado a ABSOLUTO (verificación adversarial 2026-06-11): la rama
# multi-proyecto embebe los paths de los .csproj en un bash -c que corre tras
# `cd $REPO_RUN` — con un repo-dir relativo dejaban de resolver (MSB1009 falso).
REPO="$(cd "${1:?Falta <repo-dir>}" && pwd)"
STORY_ARG="${2:-}"
STORY_ID="${STORY_ARG:-unknown}"
# La CLAVE con que se nombra la copia sellada del resultado (story 1.17): el número solo si es único en el
# repo de la story, `<tema>__<número>` si se repite. La calcula lib/evidence-key.js desde la RUTA de la
# story; si no puede decidirla, la copia no se escribe (lo dice el informe) — las pruebas corren igual.
unset TYCON_EVIDENCE_KEY TYCON_EVIDENCE_KEY_FAILED
case "$STORY_ARG" in
  *.md)
    # La corrida del repo hermano (story 7.26) no escribe copia sellada: se nombra con la clave de la story y pisaría
    # la del repo de la story. Su resultado viaja en `companions` del artefacto de ese repo.
    if [[ "${TYCON_TEST_GATE_COMPANION:-}" == "1" ]]; then
      export TYCON_EVIDENCE_KEY_FAILED="corrida del repo hermano: la copia sellada es la del repo de la story (su resultado va en companions)"
    elif [ ! -f "$STORY_ARG" ]; then
      export TYCON_EVIDENCE_KEY_FAILED="no encontré la story $STORY_ARG"
    else
      if _TG_KEY="$(node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/evidence-key.js" "$STORY_ARG" 2>&1)"; then
        export TYCON_EVIDENCE_KEY="$_TG_KEY"
      else
        export TYCON_EVIDENCE_KEY_FAILED="$_TG_KEY"
      fi
    fi ;;
esac
# El script y sus vecinos (marker.js, lib/) se resuelven desde su PROPIA ubicación,
# no desde $HOME: así el gate funciona en un checkout alternativo del harness y es
# testeable con un HOME falso (los tests le pasan uno para no ensuciar el real).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKER_JS="$SCRIPT_DIR/marker.js"
OUT_DIR="$REPO/.advisors"
OUT_FILE="$OUT_DIR/tests-result.json"
# El umbral lo resuelve el informe: la variable de la máquina, si sirve › la organización › 75. Acá va
# tal cual, vacía si no está, para que el artefacto pueda decir de dónde salió.
COV_MIN="${TYCON_COVERAGE_MIN:-}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$OUT_DIR"

# 🔴 Una salida que NO corrió la suite (4 freno, 5 falta el corredor) deja el check `tests` del marcador en ROJO con
# su código, igual que la 6. Sin esto, un verde de una corrida anterior quedaba en pie y `complete-step 4` lo aceptaba:
# «no pude correr» quedaba dicho en el artefacto y no en el marcador (pase adversarial de la W6, hallazgo #10). Sin
# corrida activa, run-check no escribe nada. Nunca corta el gate.
marcar_tests_en_rojo() {
  local codigo="$1" motivo="$2"
  ( cd "$REPO" && TYCON_TEST_GATE=1 node "$MARKER_JS" run-check tests -- \
      node -e 'console.error("test-gate: " + process.argv[1]); process.exit(Number(process.argv[2]))' "$motivo" "$codigo" ) >&2 || true
}

# --- El repo hermano (story 7.26) ----------------------------------------------
# Una story que vive en este repo y cambia otro declarado en `.tycon/advisors.yaml → evidence.companion_repos` (el repo
# hermano): al SALIR —por cualquiera de las salidas de abajo, también la 3 «sin pruebas acá», porque el repo de la story
# puede no tener suite y el código vivir en el hermano— se corre este mismo gate sobre cada hermano en el que la story
# declara archivos, con el alcance deducido de esos archivos. Antes la suite del hermano no la corría ningún portón
# (corrida de una story de dos repos de un producto del equipo, 2026-10-14).
#   · El resultado de cada hermano va a `companions` del artefacto de ESTE repo, y `all_green` dice el total.
#   · La salida combina: el código de este repo si falló; si no, el del primer hermano que falló. «Sin pruebas» (3) no
#     es falla; un repo sin pruebas con el hermano verde sale 0.
#   · Si el total es rojo, el check `tests` del marcador queda en rojo: la corrida del hermano escribe el suyo al
#     terminar y no puede dejar en verde un repo rojo.
#   · La corrida del hermano no sigue a los hermanos del hermano (TYCON_TEST_GATE_COMPANION=1) ni sella evidencia.
REPO_STORY="$REPO"   # la raíz que recibió el gate; REPO se mueve si hay alcance
correr_hermanos_al_salir() {
  local rc=$?
  trap - EXIT
  if [[ "${TYCON_TEST_GATE_COMPANION:-}" == "1" || -z "$STORY_ARG" || ! -f "$STORY_ARG" ]]; then exit "$rc"; fi
  local story_abs blancos err
  story_abs="$(cd "$(dirname "$STORY_ARG")" && pwd)/$(basename "$STORY_ARG")"
  err="$(mktemp /tmp/test-gate-hermanos-XXXXXX)"
  if ! blancos="$(node "$SCRIPT_DIR/lib/companion-repos.js" targets "$REPO_STORY" "$story_abs" 2>"$err")"; then
    # «No pude averiguar» no es «no hay hermanos»: con el repo en verde, salir 0 dejaba sin correr la suite de un
    # hermano que la story toca. Sale 4 (el «no sé qué correr» del gate) y el check `tests` queda en rojo.
    echo "[test-gate] 🔴 no pude averiguar los repos hermanos que toca la story ($(head -1 "$err")): sus suites NO se corrieron, y eso no es verde" >&2
    rm -f "$err"
    local fin="$rc"
    [[ "$rc" == "0" || "$rc" == "3" ]] && fin=4
    marcar_tests_en_rojo "$fin" "no pude averiguar los repos hermanos que toca la story: sus suites no se corrieron"
    exit "$fin"
  fi
  # Los avisos (un hermano declarado que no está en disco, un alcance que no se pudo deducir) se dicen siempre.
  cat "$err" >&2
  rm -f "$err"
  [[ -z "$blancos" ]] && exit "$rc"
  local filas="" final="$rc" root scope archivos hrc
  while IFS=$'\x1f' read -r root scope archivos; do
    [[ -z "$root" ]] && continue
    echo "[test-gate] repo hermano $(basename "$root"): la story declara ahí ${archivos//,/, } → corre su suite${scope:+ (alcance $scope)}" >&2
    hrc=0
    # TYCON_TEST_GATE_STORY_REPO: el repo de la story, para que el cruce de cobertura del hermano mire sólo lo que la
    # story crea en él (lib/companion-repos.js declared-in).
    # `< /dev/null`: la lista de hermanos entra al bucle por la entrada estándar; una suite que la lee se tragaba los
    # hermanos siguientes, que quedaban sin correr y sin aviso (revisor de fallas silenciosas, vuelta 2).
    if [[ -n "$scope" ]]; then
      TYCON_TEST_GATE_COMPANION=1 TYCON_TEST_GATE_STORY_REPO="$REPO_STORY" TYCON_TEST_SCOPE= bash "$SCRIPT_DIR/test-gate.sh" "$root" "$story_abs" "$scope" < /dev/null || hrc=$?
    else
      # Sin alcance propio: el de este repo (TYCON_TEST_SCOPE) no vale para el hermano.
      TYCON_TEST_GATE_COMPANION=1 TYCON_TEST_GATE_STORY_REPO="$REPO_STORY" TYCON_TEST_SCOPE= bash "$SCRIPT_DIR/test-gate.sh" "$root" "$story_abs" < /dev/null || hrc=$?
    fi
    filas+="${root}"$'\x1f'"${scope}"$'\x1f'"${archivos}"$'\x1f'"${hrc}"$'\n'
    if [[ "$final" == "0" || "$final" == "3" ]] && [[ "$hrc" != "0" && "$hrc" != "3" ]]; then final="$hrc"; fi
    if [[ "$final" == "3" && "$hrc" == "0" ]]; then final=0; fi
  done <<< "$blancos"
  node -e '
    const fs = require("fs"), p = require("path");
    const [out, ts, storyId, rc, final, filas] = process.argv.slice(1);
    const companions = filas.split("\n").filter(Boolean).map((l) => {
      const [root, scope, archivos, exit] = l.split("\x1f");
      const n = Number(exit);
      return { root, scope: scope || null, files: archivos.split(",").filter(Boolean), exit: n, green: n === 0,
        no_suite: n === 3, artifact: p.join(root, ".advisors", "tests-result.json") };
    });
    let art = null;
    try { art = JSON.parse(fs.readFileSync(out, "utf8")); } catch (_e) { art = null; }
    // Un artefacto de OTRA corrida (la salida 3 no escribe uno) no se completa: se reemplaza por uno de ésta.
    if (!art || art.ts !== ts) {
      art = { ts, story_id: storyId, runner: null, repo: null, suite_exit: Number(rc), suite_green: false,
        no_suite_here: Number(rc) === 3, totals: {},
        coverage: { per_new_file: {}, new_files_pct: null, threshold: null, meets_threshold: null },
        provenance: `test-gate.sh: el repo de la story no corrió suite propia (salida ${rc}); el resultado de los repos hermanos está en companions` };
    }
    art.companions = companions;
    art.all_green = Number(final) === 0;
    fs.mkdirSync(p.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(art, null, 2) + "\n");
  ' "$OUT_FILE" "$TS" "$STORY_ID" "$rc" "$final" "$filas" \
    || echo "[test-gate] ⚠️  no pude anotar los repos hermanos en $OUT_FILE (mirá el error de arriba)" >&2
  if [[ "$final" != "0" ]]; then
    marcar_tests_en_rojo "$final" "el total de la story (este repo + sus repos hermanos) no está en verde: salida $final"
  fi
  echo "[test-gate] repos hermanos: resultado total → salida $final (este repo: $rc)" >&2
  exit "$final"
}
trap correr_hermanos_al_salir EXIT

# --- Alcance: explícito, deducido, o FRENO -----------------------------------
# Override explícito: en un repo con DOS stacks, el caller manda. Tercer posicional o env var.
#   test-gate.sh <repo> <story> <subdir>      ·      TYCON_TEST_SCOPE=<subdir> test-gate.sh ...
SCOPE="${3:-${TYCON_TEST_SCOPE:-}}"
SCOPE_SOURCE="explicito"

# 🔴 REPO MULTI-STACK: DEDUCIR, y si no se puede, FRENAR (decisiones del dev 2026-08-13,
# tags `dec-2026-08-13-deducir-el-alcance` + `dec-2026-08-13-frenar-si-no-sabe`).
#
# Historia de este bloque, en dos pasos:
#   - 2026-08-04 (Story 4.27 de un repo del equipo): el repo tiene `apinetcore/` (.NET) y `mcp/` (node
#     --test); la story tocaba SÓLO `mcp/`, el `.csproj` ganaba por estar primero, y el gate corría
#     `dotnet test`. Se puso un AVISO por stderr y se siguió corriendo el stack equivocado, para no
#     romper a los repos que andaban.
#   - 2026-08-13 (cierre de la Story 4.30, MEDIDO): el aviso salía por stderr y nadie lo leyó. El
#     gate corrió .NET, falló en 1,3s y dejó `tests-result.json` en ROJO con el id `4.30` puesto —
#     de un proyecto que la story jamás tocó. Un control que avisa y sigue es un control que se
#     aprende a ignorar; y una constancia en rojo del proyecto equivocado es PEOR que ninguna,
#     porque parece verificación. Ahora: se deduce de lo que la story declara (o del diff), y si
#     hay ambigüedad NO se corre nada.
DEDUC_TSV="$(node "$SCRIPT_DIR/lib/test-scope.js" "$REPO" "$STORY_ARG" --tsv 2>/dev/null || true)"
TG_MULTI=0; TG_SCOPE=""; TG_SOURCE=""; TG_STORY_ID=""; TG_AMBIG=0; TG_CANDS=""; TG_REASON=""
# 🔴 El separador es \x1f, NO un tabulador: bash trata el tab como espacio en blanco de IFS y
# colapsa los separadores consecutivos, así que un campo vacío en el medio corre todos los de
# atrás (el alcance llegaba valiendo "1", que era el flag de ambigüedad). Lo cazó el test del freno.
IFS=$'\x1f' read -r TG_MULTI TG_SCOPE TG_SOURCE TG_STORY_ID TG_AMBIG TG_CANDS TG_REASON <<< "$DEDUC_TSV"
TG_MULTI="${TG_MULTI:-0}"; TG_AMBIG="${TG_AMBIG:-0}"
# Cuando $2 es la RUTA de la story, el id sale del frontmatter — una sola verdad: lo lee el
# deductor, que ya abrió el archivo. Si $2 era un id, se respeta tal cual.
if [[ -n "$TG_STORY_ID" ]]; then STORY_ID="$TG_STORY_ID"; fi

if [[ -z "$SCOPE" && "$TG_MULTI" == "1" ]]; then
  if [[ "$TG_AMBIG" == "0" && -n "$TG_SCOPE" ]]; then
    SCOPE="$TG_SCOPE"; SCOPE_SOURCE="${TG_SOURCE:-desconocida}"
    echo "[test-gate] alcance DEDUCIDO → '$SCOPE' (fuente: $SCOPE_SOURCE — $TG_REASON)" >&2
  else
    {
      echo ""
      echo "🔴 [test-gate] FRENADO — NO PUEDO SABER QUÉ SUITE CORRER, así que no corro ninguna."
      echo "   Proyectos con tests en este repo: ${TG_CANDS:-(ninguno)}"
      echo "   Motivo: ${TG_REASON:-sin datos para deducir}"
      echo ""
      echo "   Decile vos cuál mirar:"
      echo "       test-gate.sh $REPO ${STORY_ID} <subdir>"
      echo "   o pasá la RUTA de la story en \$2 para que se deduzca de lo que declara"
      echo "   (\`files_to_create\` / \`files_to_modify\`)."
      echo ""
      echo "   Por qué frena en vez de elegir: elegir mal deja constancia en rojo de un proyecto"
      echo "   que la story no tocó, con el nombre de la story puesto. Eso parece verificación."
      echo ""
    } >&2
    node -e '
      const fs = require("fs"), p = require("path");
      const [out, storyId, ts, reason, cands] = process.argv.slice(1);
      fs.mkdirSync(p.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({
        ts, story_id: storyId, runner: null, repo: null,
        suite_exit: 4, suite_green: false,
        halted: true, halt_reason: reason,
        candidates: cands ? cands.split(",").filter(Boolean) : [],
        totals: {},
        coverage: { per_new_file: {}, new_files_pct: null, threshold: null, meets_threshold: null },
        provenance: "test-gate.sh FRENADO — alcance ambiguo, no se ejecutó ninguna suite",
      }, null, 2) + "\n");
    ' "$OUT_FILE" "$STORY_ID" "$TS" "${TG_REASON:-sin datos para deducir}" "$TG_CANDS"
    echo "[test-gate] constancia del freno → $OUT_FILE" >&2
    marcar_tests_en_rojo 4 "FRENADO, alcance ambiguo: no se corrió ninguna suite (${TG_REASON:-sin datos para deducir})"
    exit 4
  fi
fi

if [[ -n "$SCOPE" ]]; then
  if [[ -d "$REPO/$SCOPE" ]]; then REPO="$(cd "$REPO/$SCOPE" && pwd)"
  elif [[ -d "$SCOPE" ]]; then REPO="$(cd "$SCOPE" && pwd)"
  else echo "[test-gate] scope '$SCOPE' no existe bajo $REPO" >&2; exit 2; fi
  # OUT_FILE NO se mueve a propósito: el artefacto vive en el `.advisors/` de la RAÍZ, que es
  # donde el advisor `tycon-plugin-tests-coverage` lo busca (recibe el repo root, no el subdir).
  echo "[test-gate] alcance $SCOPE_SOURCE → $REPO" >&2
fi

# --- Detección de stack ------------------------------------------------------
_HAY_DOTNET=""
if ls "$REPO"/*.sln >/dev/null 2>&1 || find "$REPO" -maxdepth 3 -name '*.csproj' -not -path '*/node_modules/*' 2>/dev/null | head -1 | grep . >/dev/null; then
  _HAY_DOTNET="sí"
fi

# 🔴 Un `.csproj` en el subárbol NO alcanza: `dotnet test` necesita una solución o un proyecto
# EN la carpeta donde corre. Sin este chequeo, un alcance que es un CONTENEDOR de proyectos
# (ej. `custom-forms/`, con la solución un nivel más abajo) pasaba la detección, corría
# `dotnet test` ahí, salía MSB1003 y dejaba `tests-result.json` en ROJO con el id de la story
# puesto — de un comando que no podía funcionar nunca. Caso medido: el repo del framework, Story 10.2,
# 2026-08-15. Misma familia que el caso 4.30: una constancia falsa es peor que ninguna.
_DOTNET_CORRIBLE=""
if ls "$REPO"/*.sln >/dev/null 2>&1 || ls "$REPO"/*.csproj >/dev/null 2>&1; then
  _DOTNET_CORRIBLE="sí"
fi

RUNNER=""
if [[ -n "$_HAY_DOTNET" ]]; then
  RUNNER="dotnet"
elif [ -f "$REPO/package.json" ] && grep -q '"vitest"' "$REPO/package.json" 2>/dev/null; then
  RUNNER="vitest"
elif [ -f "$REPO/package.json" ] && grep -qE '"test"[[:space:]]*:[[:space:]]*"[^"]*node --test' "$REPO/package.json" 2>/dev/null; then
  # Runner nativo de Node (`node --test`) — el 3er stack del equipo, sin jest ni vitest.
  # Caso disparador: `mcp/` de un repo del equipo (Story 4.23, 2026-07-25). Antes caía en el `exit 3`
  # de "no se detectó stack" y la matriz runtime se quedaba SIN artefacto → marcaba los 35 ACs
  # como NOT-RUN con la suite realmente verde. Un gate que no puede mirar bloquea igual que uno
  # que mira y ve rojo, pero por la razón equivocada.
  RUNNER="node-test"
elif [ -f "$REPO/package.json" ] && grep -qE '"jest"[[:space:]]*:|"test"[[:space:]]*:[[:space:]]*"[^"]*jest' "$REPO/package.json" 2>/dev/null; then
  # jest — 4to stack del equipo (2026-08-15). Caso disparador: `custom-forms/runtime-app` de
  # el repo del framework (596 tests) quedaba SIN medir: el gate decía "no se detectó stack" y salía 3,
  # así que la suite del frontend nunca pasó por un control y había que correrla a mano.
  # Su JSON (`--json`) y su coverage (`coverage/coverage-final.json`) tienen el MISMO formato que
  # vitest, así que el parser de abajo los lee sin ramas nuevas.
  RUNNER="jest"
elif [ -f "$REPO/scripts/tests/suites.json" ]; then
  # suites.json — 5to stack del equipo (2026-09-05). Caso disparador: el repo del ARNÉS
  # (el arnés, story 2.2) no tiene package.json ni .csproj: sus 57 suites son archivos
  # sueltos declarados en `scripts/tests/suites.json`, que el pipeline de Azure ya corre cada
  # noche. El gate salía 3 («no se detectó stack») y NUNCA escribía tests-result.json → la matriz
  # de DoD marcaba 11 criterios como NOT-RUN con la suite realmente verde. Tercera vez del mismo
  # patrón (node --test en julio, jest en agosto). El runner usa la MISMA lista que el nocturno.
  RUNNER="suites-json"
else
  # workspace contenedor: primer subdir con package.json + un runner conocido
  for d in "$REPO"/*/; do
    if [ -f "${d}package.json" ] && grep -q '"vitest"' "${d}package.json" 2>/dev/null; then
      REPO_RUN="${d%/}"; RUNNER="vitest"; break
    fi
    if [ -f "${d}package.json" ] && grep -qE '"test"[[:space:]]*:[[:space:]]*"[^"]*node --test' "${d}package.json" 2>/dev/null; then
      REPO_RUN="${d%/}"; RUNNER="node-test"; break
    fi
    if [ -f "${d}package.json" ] && grep -qE '"jest"[[:space:]]*:|"test"[[:space:]]*:[[:space:]]*"[^"]*jest' "${d}package.json" 2>/dev/null; then
      REPO_RUN="${d%/}"; RUNNER="jest"; break
    fi
  done
fi
REPO_RUN="${REPO_RUN:-$REPO}"

if [[ -z "$RUNNER" ]]; then
  echo "[test-gate] No se detectó stack de tests (ni .csproj, ni vitest, ni jest, ni \`node --test\`, ni scripts/tests/suites.json) en $REPO" >&2
  exit 3
fi

# El alcance dice ".NET" pero no hay solución ni proyecto EN esta carpeta → frenar (ver arriba).
if [[ "$RUNNER" == "dotnet" && -z "$_DOTNET_CORRIBLE" ]]; then
  _RAZON="el alcance '$REPO' contiene proyectos .NET más abajo, pero no tiene ningún .sln ni .csproj propio: 'dotnet test' ahí sale MSB1003"
  {
    echo ""
    echo "🔴 [test-gate] FRENADO — el alcance NO ES UN PROYECTO, es una carpeta que los contiene."
    echo "   $_RAZON"
    echo ""
    echo "   Pasá el proyecto de verdad:"
    for _sln in $(find "$REPO" -maxdepth 3 \( -name '*.sln' -o -name '*.csproj' \) -not -path '*/node_modules/*' -not -path '*/bin/*' -not -path '*/obj/*' 2>/dev/null | head -5); do
      echo "       test-gate.sh <repo> ${STORY_ID} $(dirname "$_sln")"
    done
    echo ""
    echo "   Por qué frena en vez de intentar: correr y fallar deja constancia EN ROJO con el"
    echo "   nombre de la story puesto, de un comando que no podía funcionar. Eso parece"
    echo "   verificación y es peor que no dejar nada."
    echo ""
  } >&2
  node -e '
    const fs = require("fs"), p = require("path");
    const [out, storyId, ts, reason] = process.argv.slice(1);
    fs.mkdirSync(p.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({
      ts, story_id: storyId, runner: null, repo: null,
      suite_exit: 4, suite_green: false,
      halted: true, halt_reason: reason,
      totals: {},
      coverage: { per_new_file: {}, new_files_pct: null, threshold: null, meets_threshold: null },
      provenance: "test-gate.sh FRENADO — el alcance no es un proyecto ejecutable, no se corrió ninguna suite",
    }, null, 2) + "\n");
  ' "$OUT_FILE" "$STORY_ID" "$TS" "$_RAZON"
  echo "[test-gate] constancia del freno → $OUT_FILE" >&2
  marcar_tests_en_rojo 4 "FRENADO: $_RAZON"
  exit 4
fi

# --- La herramienta que corre las pruebas tiene que estar (story 8.17, AC 50) ---
# Sin `npx` o sin `dotnet` en el PATH (en Windows pasa: Git Bash no ve lo que instaló otro shell), `run-check`
# lanzaba un comando inexistente y quedaba un rojo con totales vacíos que nadie sabía leer. Ahora se dice qué falta,
# el artefacto lo anota, y NO se corre nada: «no pude correr» no es «pasaron» ni «fallaron».
case "$RUNNER" in
  dotnet) _HERRAMIENTA="dotnet" ;;
  vitest|jest) _HERRAMIENTA="npx" ;;
  node-test) _HERRAMIENTA="npm" ;;
  *) _HERRAMIENTA="node" ;;
esac
# `command -v` sólo no alcanza (pase adversarial de la W6, hallazgo #8): en Windows Git Bash encuentra el guion `npx`
# sin extensión, pero run-check lo lanza desde Node, que no lanza un `npx.cmd` sin shell; y bash cuenta también un
# archivo sin permiso de ejecución. `portable-tools.js can-launch` mira con la MISMA búsqueda con la que run-check lanza.
_NO_LANZA=""
if ! command -v "$_HERRAMIENTA" >/dev/null 2>&1; then
  _NO_LANZA="no está en el PATH"
elif ! _MOTIVO_LANZA="$(node "$SCRIPT_DIR/lib/portable-tools.js" can-launch "$_HERRAMIENTA" 2>&1)"; then
  _NO_LANZA="el shell lo ve, pero run-check no lo puede lanzar: ${_MOTIVO_LANZA:-sin motivo}"
fi
if [[ -n "$_NO_LANZA" ]]; then
  _RAZON="no pude correr las pruebas: falta $_HERRAMIENTA ($_NO_LANZA; el corredor $RUNNER lo necesita)"
  {
    echo ""
    echo "🔴 [test-gate] $_RAZON."
    echo "   No se corrió ninguna suite: esto NO es un resultado de las pruebas."
    echo "   Instalalo, o abrí la sesión con un PATH que lo vea, y volvé a correr test-gate.sh."
    echo ""
  } >&2
  node -e '
    const fs = require("fs"), p = require("path");
    const [out, storyId, ts, runner, tool, reason] = process.argv.slice(1);
    fs.mkdirSync(p.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({
      ts, story_id: storyId, runner, repo: null,
      suite_exit: 5, suite_green: false,
      halted: true, halt_reason: reason, missing_tool: tool,
      totals: {},
      coverage: { per_new_file: {}, new_files_pct: null, threshold: null, meets_threshold: null },
      provenance: "test-gate.sh NO CORRIÓ — falta la herramienta que corre las pruebas, no se ejecutó ninguna suite",
    }, null, 2) + "\n");
  ' "$OUT_FILE" "$STORY_ID" "$TS" "$RUNNER" "$_HERRAMIENTA" "$_RAZON"
  echo "[test-gate] constancia de que no se pudo correr → $OUT_FILE" >&2
  marcar_tests_en_rojo 5 "$_RAZON"
  exit 5
fi

# --- Correr la suite (UNA vez) vía run-check → exit code real + gates.log ----
RESULTS_DIR="$(mktemp -d /tmp/test-gate-XXXXXX)"
SUITE_EXIT=0
TEST_PROJECTS=()  # declarado arriba: la rama vitest también lo expande (set -u safe)

# 🔴 Marca de procedencia del check `tests` (decisión del dev 2026-08-13, tag
# `dec-2026-08-13-suite-completa-al-cerrar`). `marker.js run-check tests` la lee y anota
# provenance='test-gate' en vez de 'run-check'; `complete-step 4` BLOQUEA un verde que no venga
# de acá. Motivo medido: en el cierre de la 4.30 el check quedó verde con 872 de 2400 tests —
# los que la story declaraba, corridos a mano. La única corrida completa salió en rojo con 13
# fallas, dos de la propia story. Un verde parcial no puede pasar por control.
export TYCON_TEST_GATE=1
# El buzón apagado para cada prueba: ninguna sube al buzón real del equipo, aunque se equivoque (la llave de esta
# máquina está en el árbol). La llave apunta a un archivo que no existe; una prueba que mide la subida pone sus propias
# variables y su destino de prueba.
export TYCON_MAILBOX=0 TYCON_NO_UPLOAD_RUNS=1 TYCON_MAILBOX_JSON="${TMPDIR:-/tmp}/sin-llave-del-buzon-$$/corridas-buzon.json" TYCON_SUITE_RUNNER=test-gate

if [[ "$RUNNER" == "dotnet" ]]; then
  # Fix auditoría 9.4 (2026-06-11) — race bi-assembly: `dotnet test` a nivel solución
  # corre los assemblies de test EN PARALELO y, si comparten la BD de test (DatabaseFixture
  # droppea/recrea el schema), se pisan entre sí → exit=1 con 0 failed reales. En 9.4 esto
  # costó 2 corridas full rojas (~14 min) + 1 tercera secuencial manual. Si hay >1 proyecto
  # de test, se corren SECUENCIALES (un solo run-check envuelve la cadena && — exit code real).
  while IFS= read -r tp; do TEST_PROJECTS+=("$tp"); done < <(find "$REPO_RUN" -maxdepth 3 -path '*/tests/*' -name '*.csproj' -not -path '*/node_modules/*' -not -path '*/bin/*' -not -path '*/obj/*' 2>/dev/null | sort)
  # Cross-check contra el .sln (verificación adversarial 2026-06-11): el find por
  # layout '*/tests/*' puede DROPEAR un test project que viva fuera de tests/ o a
  # depth>3. Si el .sln declara MÁS proyectos test que los encontrados → warning
  # explícito + fallback a solución-level (corre TODO, aunque re-exponga la race —
  # nunca dropear assemblies en silencio).
  SLN_FILE="$(ls "$REPO_RUN"/*.sln 2>/dev/null | head -1)"
  if [[ -n "$SLN_FILE" && ${#TEST_PROJECTS[@]} -ge 1 ]]; then
    SLN_TEST_COUNT="$(grep -oE '[^"\\]+\.csproj' "$SLN_FILE" 2>/dev/null | grep -ciE '(^|[/\\._-])tests?[/\\._-]|Tests?\.csproj' || true)"
    if [[ -n "$SLN_TEST_COUNT" && "$SLN_TEST_COUNT" -gt ${#TEST_PROJECTS[@]} ]]; then
      echo "[test-gate] ⚠️ el .sln declara $SLN_TEST_COUNT proyectos de test pero find encontró ${#TEST_PROJECTS[@]} — fallback a solución-level para no dropear assemblies (OJO: re-expone la race bi-assembly; revisar el layout)." >&2
      TEST_PROJECTS=()
    fi
  fi
  if [[ ${#TEST_PROJECTS[@]} -gt 1 ]]; then
    echo "[test-gate] dotnet test SECUENCIAL — ${#TEST_PROJECTS[@]} proyectos de test (anti race bi-assembly), results → $RESULTS_DIR"
    SEQ_CMD=""
    for tp in "${TEST_PROJECTS[@]}"; do
      SEQ_CMD+="dotnet test $(printf %q "$tp") --collect:'XPlat Code Coverage' --results-directory $(printf %q "$RESULTS_DIR") --logger trx --nologo && "
    done
    SEQ_CMD="${SEQ_CMD% && }"
    ( cd "$REPO_RUN" && node "$MARKER_JS" run-check tests -- bash -c "$SEQ_CMD" ) || SUITE_EXIT=$?
  else
    echo "[test-gate] dotnet test + coverage (1 sola corrida, results → $RESULTS_DIR)"
    ( cd "$REPO_RUN" && node "$MARKER_JS" run-check tests -- \
        dotnet test --collect:"XPlat Code Coverage" --results-directory "$RESULTS_DIR" --logger "trx;LogFileName=test-gate.trx" --nologo ) || SUITE_EXIT=$?
  fi
elif [[ "$RUNNER" == "node-test" ]]; then
  echo "[test-gate] node --test (1 sola corrida, salida → $RESULTS_DIR/node-test.txt)"
  # `set -o pipefail` es OBLIGATORIO acá: sin él el exit code que ve `run-check` sería el del
  # `tee` (siempre 0) y el gate daría verde con la suite en rojo — el mismo error de método que
  # `test-execution-discipline.md` prohíbe ("gatear sobre el exit code real, no sobre output
  # pipeado"). El `tee` hace falta porque `node --test` no tiene reporter a archivo como vitest.
  # TYCON_FULL_SUITE=1: los repos con guard anti-suite-completa lo exigen; donde no hay guard es inocuo.
  ( cd "$REPO_RUN" && node "$MARKER_JS" run-check tests -- \
      bash -c "set -o pipefail; TYCON_FULL_SUITE=1 npm test 2>&1 | tee $(printf %q "$RESULTS_DIR/node-test.txt")" ) || SUITE_EXIT=$?
elif [[ "$RUNNER" == "suites-json" ]]; then
  # Corre TODA la lista (diarias + semanales) con el mismo runner que usa el nocturno. El resumen
  # queda en $RESULTS_DIR/suites.json y el exit es el ACUMULADO: una roja o una AUSENTE = rojo.
  #
  # Story 7.15 (2026-09-29): el runner corre en paralelo (la mitad de los núcleos) y DIFIERE las
  # suites con `gate_only_when_touching` que la story no toca (hoy exportador-real, 24-41 min). Para
  # eso necesita saber qué toca la story: lo declarado + el diff contra la base de la corrida + lo sin
  # trackear (lib/touched-files.js). La base se resuelve ACÁ, antes de correr, y el parser la reusa.
  # Si no se puede saber, no se pasa `--touched` y el runner corre todo — «no pude mirar» ≠ «no toca».
  BASE_JSON="$(node "$SCRIPT_DIR/lib/coverage-base.js" "$REPO" 2>/dev/null)" || BASE_JSON=""
  [[ -n "$BASE_JSON" ]] || BASE_JSON='{"ref":null,"source":null,"descartadas":[{"source":"coverage-base","motivo":"no se pudo correr lib/coverage-base.js"}]}'
  # Sin base, touched-files dice «no sé» y el runner corre todo (el lado seguro); igual se dice por qué.
  _TG_BASE="$(node -e 'try{const j=JSON.parse(process.argv[1]);process.stdout.write(j.ref||"")}catch(e){process.stderr.write(`[test-gate] ⚠️  la base de la corrida es ilegible (${e.message}): corren todas las suites\n`)}' "$BASE_JSON" || true)"
  # De dónde salió la base (env · marcador · HEAD): con «HEAD» por defecto lo commiteado no se ve, y
  # touched-files contesta «no sé» (pase adversarial 2026-09-29).
  _TG_BASE_SRC="$(node -e 'try{const j=JSON.parse(process.argv[1]);process.stdout.write(j.source||"")}catch(e){}' "$BASE_JSON" 2>/dev/null || true)"
  _TG_STORY_FILE=""; [[ -n "$STORY_ARG" && -f "$STORY_ARG" ]] && _TG_STORY_FILE="$STORY_ARG"
  # `${arr[@]+…}`: con el arreglo vacío y `set -u`, el bash 3.2 de macOS corta con «unbound variable».
  TOUCHED_ARGS=()
  if node "$SCRIPT_DIR/lib/touched-files.js" "$REPO_RUN" "$_TG_STORY_FILE" "$_TG_BASE" "$_TG_BASE_SRC" > "$RESULTS_DIR/touched.json" 2>"$RESULTS_DIR/touched.err"; then
    TOUCHED_ARGS=(--touched "$RESULTS_DIR/touched.json")
  else
    echo "[test-gate] ⚠️  no pude averiguar qué archivos toca la story ($(head -1 "$RESULTS_DIR/touched.err")): corren todas las suites" >&2
  fi
  # Con la cobertura pedida, cada suite corre bajo el medidor de Node y deja su lcov; el informe lee el
  # juntado ($RESULTS_DIR/coverage/lcov.info) para las líneas tocadas.
  echo "[test-gate] suites.json — corriendo scripts/tests/suites.json en paralelo, con cobertura (1 sola corrida, resumen → $RESULTS_DIR/suites.json)"
  ( cd "$REPO_RUN" && node "$MARKER_JS" run-check tests -- \
      node "$SCRIPT_DIR/lib/run-suites-json.js" "$REPO_RUN" "$RESULTS_DIR/suites.json" ${TOUCHED_ARGS[@]+"${TOUCHED_ARGS[@]}"} --coverage "$RESULTS_DIR/coverage" ) || SUITE_EXIT=$?
elif [[ "$RUNNER" == "jest" ]]; then
  # `--maxWorkers` capado por default: jest paraleliza en ~cores-1 y cada worker carga jsdom + el
  # grafo de módulos. En una 8-core/16GB eso es el swap thrash que `test-execution-discipline.md`
  # documenta (2 veces congeló la máquina del dev). Override: TYCON_JEST_MAX_WORKERS=100%.
  JEST_WORKERS="${TYCON_JEST_MAX_WORKERS:-50%}"
  echo "[test-gate] jest --coverage (1 sola corrida, maxWorkers=$JEST_WORKERS)"
  ( cd "$REPO_RUN" && node "$MARKER_JS" run-check tests -- \
      npx jest --coverage --maxWorkers="$JEST_WORKERS" --json --outputFile "$RESULTS_DIR/jest.json" ) || SUITE_EXIT=$?
else
  echo "[test-gate] vitest run --coverage (1 sola corrida)"
  ( cd "$REPO_RUN" && node "$MARKER_JS" run-check tests -- \
      npx vitest run --coverage --reporter=json --outputFile "$RESULTS_DIR/vitest.json" ) || SUITE_EXIT=$?
fi

# --- Parsear resultados + coverage (best-effort, nunca rompe) ----------------
# Respaldo del cruce de cobertura: los archivos que la story declara CREAR. git deja de
# reportar "added" apenas se commitea, así que en una iteración de fix POSTERIOR al commit
# la lista de archivos nuevos queda vacía y el cruce se perdía sin decir nada (hallazgo de
# una persona del equipo, 2026-08-25 — el `null` del reporte se leía igual que "esto está bien" — guides/maintaining/incident-log.md#case-declared-new-files-cross-lost-2026-08-25).
# Sin los que viven en un repo hermano (story 7.26): ésos los cruza la corrida del hermano, y acá salían como
# «declarados que no existen». En la corrida DEL hermano, al revés: sólo los que la story crea en él.
# Si la consulta falla, su error queda a la vista (stderr) y se cae a la lista de siempre.
if [[ -n "$STORY_ARG" && -f "$STORY_ARG" && "${TYCON_TEST_GATE_COMPANION:-}" == "1" && -n "${TYCON_TEST_GATE_STORY_REPO:-}" ]] \
  && DECLARED_NEW="$(node "$SCRIPT_DIR/lib/companion-repos.js" declared-in "$TYCON_TEST_GATE_STORY_REPO" "$STORY_ARG" "$REPO_STORY")"; then
  :
elif [[ -n "$STORY_ARG" && -f "$STORY_ARG" && "${TYCON_TEST_GATE_COMPANION:-}" != "1" ]] \
  && DECLARED_NEW="$(node "$SCRIPT_DIR/lib/companion-repos.js" declared-here "$REPO_STORY" "$STORY_ARG")"; then
  :
else
  DECLARED_NEW="$(node "$SCRIPT_DIR/lib/test-scope.js" "$REPO" "$STORY_ARG" --files-to-create 2>/dev/null || true)"
fi
TEST_PROJECT_COUNT="${#TEST_PROJECTS[@]}"
# Huella del código que esta corrida midió (fix 2026-08-28, TESTGATE-DEDUCTOR-LAYOUT-GAP-1
# parte 2): step-07b la compara con `suite-freshness.js check` al salir del loop de
# iteraciones — si el código cambió desde este verde, el verde ya no describe nada y se
# re-corre UNA vez sobre el código final (antes lo cazaba recién el DoD checker, Step 7c).
# Best-effort: sin git o con git fallando queda {"git":false} y el check dice SIN DATOS.
CODE_STATE_JSON="$(node "$SCRIPT_DIR/lib/suite-freshness.js" state "$REPO" 2>/dev/null || echo '{"git":false}')"
# Base de las «líneas tocadas» (story 2.4, 2026-09-16): el commit en el que arrancó la corrida
# (marcador), TYCON_COVERAGE_BASE, o HEAD — ver lib/coverage-base.js. Si no se puede resolver, el
# parser publica `touched_lines_pct: null` con el motivo; nunca rompe el gate.
# La rama suites-json ya la resolvió antes de correr (story 7.15): se reusa, no se recalcula.
if [[ -z "${BASE_JSON:-}" ]]; then
  BASE_JSON="$(node "$SCRIPT_DIR/lib/coverage-base.js" "$REPO" 2>/dev/null)" || BASE_JSON=""
  [[ -n "$BASE_JSON" ]] || BASE_JSON='{"ref":null,"source":null,"descartadas":[{"source":"coverage-base","motivo":"no se pudo correr lib/coverage-base.js"}]}'
fi
# La sesión con la cadena canónica del arnés (lib/session-id.js: Claude, Codex, banco) — la línea de
# gates.log no puede quedar con sesión null bajo otra herramienta (revisor de fallos silenciosos).
_SID_ERR="$(mktemp /tmp/test-gate-sid-XXXXXX)"
GATE_SESSION_ID="$(node -e 'process.stdout.write(String(require(process.argv[1]).resolveSessionId()))' "$SCRIPT_DIR/lib/session-id.js" 2>"$_SID_ERR")" \
  || { echo "[test-gate] ⚠️  no pude resolver la sesión con lib/session-id.js ($(head -1 "$_SID_ERR")); el parser usa la misma cadena de variables" >&2; GATE_SESSION_ID=""; }
rm -f "$_SID_ERR"
export GATE_SESSION_ID
BASE_REF="$(node -e 'try{const j=JSON.parse(process.argv[1]);process.stdout.write(j.ref||"")}catch(e){}' "$BASE_JSON" 2>/dev/null || true)"
# El informe (totales, cobertura de archivos nuevos y de líneas tocadas, copia que viaja, línea de gates.log) lo
# escribe lib/test-gate-report.js. Hasta la story 8.17 (tanda W6) era un bloque de Python embebido acá: en Windows
# `python3` no es requisito, y sin él la suite corría y no quedaba artefacto. Mismos argumentos, mismo JSON
# (tests/test-gate-report.test.js lo compara contra lo que escribía el Python). Tampoco depende de `timeout` ni de
# `realpath`, que en un Git Bash pueden faltar: el informe trae su propio reemplazo de los dos.
# El artefacto de una corrida anterior se borra antes: si el informe falla, no puede quedar un verde viejo a la vista.
rm -f "$OUT_FILE"
node "$SCRIPT_DIR/lib/test-gate-report.js" "$RUNNER" "$REPO" "$REPO_RUN" "$RESULTS_DIR" "$OUT_FILE" "$SUITE_EXIT" "$STORY_ID" "$COV_MIN" "$TS" "$TEST_PROJECT_COUNT" "$SCOPE" "$SCOPE_SOURCE" "$DECLARED_NEW" "$CODE_STATE_JSON" "$BASE_REF" "$BASE_JSON" \
  || echo "[test-gate] ⚠️  el informe falló (lib/test-gate-report.js): mirá el error de arriba; no quedó artefacto" >&2

# 🔴 Una suite que sale 0 sin haber corrido ninguna prueba (o sin informe que lo cuente) NO es verde (story 8.17,
# AC 50: «nunca pasaron»). El informe ya lo dejó dicho en el artefacto; acá el check `tests` del marcador queda en
# rojo con el mismo motivo —`run-check` ya lo había puesto verde por la salida 0— y el gate sale 6.
if [[ "$SUITE_EXIT" == "0" ]]; then
  _VERDE="$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j.suite_green===true?"si":"no")}catch(e){process.stdout.write("no")}' "$OUT_FILE")"
  if [[ "$_VERDE" != "si" ]]; then
    echo "🔴 [test-gate] la suite salió 0 pero no corrió ninguna prueba, o no se pudo contar: NO es verde." >&2
    ( cd "$REPO_RUN" && node "$MARKER_JS" run-check tests -- node -e 'console.error("test-gate: la suite salió 0 sin ninguna prueba corrida (o sin informe que lo cuente): no es verde"); process.exit(6)' ) || true
    SUITE_EXIT=6
  fi
fi

exit "$SUITE_EXIT"
