#!/usr/bin/env bash
# =============================================================================
# tycon-pipeline — Test Gate (cierre de «Correr las pruebas»)
# =============================================================================
# Corre la suite de tests + coverage UNA SOLA VEZ y persiste el resultado como
# artefacto machine-parseable.
#
#   - El advisor tycon-plugin-tests-coverage LEE este artefacto (sin Bash): nunca corre la
#     suite. Así la suite no se repite dentro del fan-out del paso de revisores ni corre en paralelo con
#     subagentes, que es lo que congela la máquina.
#   - El gate de coverage 75% sale del parseo del cobertura.xml / coverage-final.json real,
#     no de una afirmación del LLM.
#   - marker.checks.tests se setea vía `marker.js run-check` (exit code real,
#     provenance=run-check, gates.log) — el Stop-gate autónomo lee ground-truth.
#
# Uso:
#   test-gate.sh <repo-dir> [story-id|story-path] [subdir]
#
#   Detecta el stack: *.csproj → dotnet test --collect; package.json con vitest
#   → npx vitest run --coverage; las de lib/test-runners.js (pytest, Playwright…). Un solo proyecto con pruebas en una
#   subcarpeta se corre con ese alcance. Escribe:
#     <repo>/.advisors/tests-result.json   ← el artefacto que lee el advisor
#
#   En un repo con MÁS DE UN proyecto testeable, el alcance se DEDUCE de los
#   archivos que la story declara (`files_to_create`/`files_to_modify`) o, si no
#   hay story, del diff real. Si no se puede deducir, FRENA (exit 4) en vez de
#   elegir mal. Ver `lib/test-scope.js`.
#   Pasar la RUTA de la story en $2 (en vez del id) habilita la deducción por
#   declaración y saca el id del frontmatter.
#
# Exit: el exit code REAL de la suite (0 verde, !=0 rojo) · 3 «sin medir»: no reconoce ninguna herramienta de pruebas
#       (deja tests-result.json con `no_stack` y el motivo en llano, y el check `tests` en `sin-medir`)
#       · 4 alcance ambiguo (no se corrió NADA) · 5 falta la herramienta que corre las
#       pruebas, `npx`, `dotnet` o `npm` (no se corrió NADA)
#       · 6 la suite salió 0 sin ninguna prueba corrida, o sin informe que lo cuente (no es verde).
#       · 7 «sin acotar»: la corrida del repo hermano no pudo acotarse a lo tocado (no se sabe qué se tocó, o ninguna
#       suite lo lee) y no corrió nada: no es verde ni rojo; la cubre la CI del pedido, y el merge la exige en verde.
#
# Sin `python3`, `timeout` ni `realpath`: en Windows no son
# requisito. El informe es lib/test-gate-report.js.
#
# Coverage sobre archivos NUEVOS (git diff --diff-filter=A + untracked): el
# umbral 75% (TEST-W2) NO bloquea acá — queda en el artefacto y el advisor lo
# reporta como WARNING con cita al archivo.
# =============================================================================
set -uo pipefail

# 🔴 Lanzado DENTRO de `node --test` (una prueba que corre este gate), el hijo heredaría NODE_TEST_CONTEXT y el
# `node --test` de la suite escribiría en el formato interno de Node, no el resumen `ℹ tests N`: el informe no contaría
# ninguna prueba y quedaría verde. Por eso la suite corre como en una terminal.
unset NODE_TEST_CONTEXT

# `--suite <ruta>` (en cualquier lugar de los argumentos): corre sólo esa suite de suites.json, con el mismo ambiente que
# la corrida completa. Es la que se repite primero después de un rojo (ver «Primero la suite que falló», en la rama de
# suites.json). Se saca antes de leer los posicionales.
SUITE_ONLY=""
_TG_ARGS=()
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--suite" ]]; then
    [[ -n "${2:-}" ]] || { echo "[test-gate] 🔴 --suite sin ruta: test-gate.sh <repo> [story] --suite <ruta de suites.json>" >&2; exit 2; }
    SUITE_ONLY="$2"; shift 2
  else
    _TG_ARGS+=("$1"); shift
  fi
done
set -- ${_TG_ARGS[@]+"${_TG_ARGS[@]}"}

# REPO canonicalizado a ABSOLUTO: la rama
# multi-proyecto embebe los paths de los .csproj en un bash -c que corre tras
# `cd $REPO_RUN` — con un repo-dir relativo dejaban de resolver (MSB1009 falso).
REPO="$(cd "${1:?Falta <repo-dir>}" && pwd)"
STORY_ARG="${2:-}"
STORY_ID="${STORY_ARG:-unknown}"
# Los archivos de trabajo de la corrida van a la carpeta temporal del sistema (TMPDIR), no a /tmp fijo.
TG_TMP="${TMPDIR:-/tmp}"; TG_TMP="${TG_TMP%/}"
# La CLAVE con que se nombra la copia sellada del resultado: el número solo si es único en el
# repo de la story, `<tema>__<número>` si se repite. La calcula lib/evidence-key.js desde la RUTA de la
# story; si no puede decidirla, la copia no se escribe (lo dice el informe) — las pruebas corren igual.
unset TYCON_EVIDENCE_KEY TYCON_EVIDENCE_KEY_FAILED
case "$STORY_ARG" in
  *.md)
    # La corrida del repo hermano no escribe copia sellada: se nombra con la clave de la story y pisaría
    # la del repo de la story. Su resultado viaja en `companions` del artefacto de ese repo.
    if [[ "${TYCON_TEST_GATE_COMPANION:-}" == "1" ]]; then
      export TYCON_EVIDENCE_KEY_FAILED="corrida del repo hermano: la copia sellada es la del repo de la story (su resultado va en companions)"
    elif [[ "${TYCON_TEST_GATE_PART:-}" == "1" ]]; then
      # una parte de una story que toca varios proyectos: la copia sellada es la del total, que escribe correr_partes
      export TYCON_EVIDENCE_KEY_FAILED="parte de una corrida por proyectos: la copia sellada es la del total"
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
# Una parte de una story que toca varios proyectos del repo (ver «Varios proyectos tocados»): su artefacto va aparte y
# el de la raíz lo arma la corrida que la lanzó.
if [[ "${TYCON_TEST_GATE_PART:-}" == "1" && -n "${TYCON_TEST_GATE_OUT_FILE:-}" ]]; then OUT_FILE="$TYCON_TEST_GATE_OUT_FILE"; fi
# El umbral lo resuelve el informe: la variable de la máquina, si sirve › la organización › 75. Acá va
# tal cual, vacía si no está, para que el artefacto pueda decir de dónde salió.
COV_MIN="${TYCON_COVERAGE_MIN:-}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$OUT_DIR"

# 🔴 Una salida que NO corrió la suite (4 freno, 5 falta el corredor) deja el check `tests` del marcador en ROJO con
# su código, igual que la 6. Sin esto, un verde de una corrida anterior queda en pie y `complete-step run-tests` lo acepta:
# «no pude correr» se dice en el artefacto y también en el marcador. Sin
# corrida activa, run-check no escribe nada. Nunca corta el gate.
# «Sin acotar» se lee de la CONSTANCIA, no del número: un corredor (jest, vitest, npm test, dotnet) o una suite también
# pueden salir 7 porque fallan, y eso es un rojo. Sólo la corrida cruzada de suites.json escribe `unscoped: true`.
es_sin_acotar() {
  node -e 'try{process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).unscoped===true?0:1)}catch(e){process.exit(1)}' "$1"
}

marcar_tests_en_rojo() {
  local codigo="$1" motivo="$2"
  # TYCON_TEST_GATE_MARK: la marca no corre pruebas y no toma el candado de `run-check`; con el de otra sesión saldría
  # 75 sin escribir, y el verde viejo quedaría en pie.
  ( cd "$REPO" && TYCON_TEST_GATE=1 TYCON_TEST_GATE_MARK=1 node "$MARKER_JS" run-check tests -- \
      node -e 'console.error("test-gate: " + process.argv[1]); process.exit(Number(process.argv[2]))' "$motivo" "$codigo" ) >&2 || true
}

# --- El repo hermano ----------------------------------------------
# Una story que vive en este repo y cambia otro declarado en `.tycon/advisors.yaml → evidence.companion_repos` (el repo
# hermano): al SALIR —por cualquiera de las salidas de abajo, también la 3 «sin pruebas acá», porque el repo de la story
# puede no tener suite y el código vivir en el hermano— se corre este mismo gate sobre cada hermano en el que la story
# declara archivos, con el alcance deducido de esos archivos. Sin esto, la suite del hermano no la corre ningún portón
# (por ejemplo, una story que toca dos repos de un producto del equipo).
#   · El resultado de cada hermano va a `companions` del artefacto de ESTE repo, y `all_green` dice el total.
#   · La salida combina: el código de este repo si falló; si no, el del primer hermano que falló. «Sin pruebas» (3) no
#     es falla; un repo sin pruebas con el hermano verde sale 0.
#   · Si el total es rojo, el check `tests` del marcador queda en rojo: la corrida del hermano escribe el suyo al
#     terminar y no puede dejar en verde un repo rojo.
#   · La corrida del hermano no sigue a los hermanos del hermano (TYCON_TEST_GATE_COMPANION=1) ni sella evidencia.
REPO_STORY="$REPO"   # la raíz que recibió el gate; REPO se mueve si hay alcance
# La corrida CRUZADA: la del repo hermano, o la que recibe un repo con la ruta de una story de otro repo (la story en el
# privado y el código en el público). Ahí el marcador es del otro repo: la base de «lo tocado» es la bifurcación y la
# corrida se acota a lo tocado. Va sólo a los comandos que la leen, en su línea: exportada, la heredarían las suites.
TG_CROSS=""
if [[ "${TYCON_TEST_GATE_COMPANION:-}" == "1" ]]; then
  TG_CROSS=1
elif [[ "$STORY_ARG" == *.md && -f "$STORY_ARG" ]]; then
  # Se compara el repo (su carpeta .git común), no el checkout: un worktree del mismo repo no es otro repo.
  # Vacío si git no contesta: con bash 3.2, `cd ""` no falla y devuelve la carpeta misma, que se compararía como otro repo.
  _tg_repo_git() {
    local d
    d="$(cd "$1" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null)" || return 0
    [[ -n "$d" ]] || return 0
    ( cd "$1" && cd "$d" 2>/dev/null && pwd -P ) || true
  }
  _TG_TOP_REPO="$(_tg_repo_git "$REPO")"
  _TG_TOP_STORY="$(_tg_repo_git "$(dirname "$STORY_ARG")")"
  if [[ -n "$_TG_TOP_REPO" && -n "$_TG_TOP_STORY" && "$_TG_TOP_REPO" != "$_TG_TOP_STORY" ]]; then TG_CROSS=1
  elif [[ -z "$_TG_TOP_REPO" || -z "$_TG_TOP_STORY" ]]; then
    # Sin saber de qué repo es cada uno no se puede decir que sea cruzada: corre como siempre, y se dice.
    if [[ -z "$_TG_TOP_REPO" ]]; then _TG_SIN_REPO="$REPO"; else _TG_SIN_REPO="$(dirname "$STORY_ARG")"; fi
    echo "[test-gate] ⚠️  no pude averiguar el repo git de $_TG_SIN_REPO: si la story vive en otro repo, esta corrida no se acota" >&2
  fi
fi
# La carpeta temporal del árbol armado del privado adelgazado (ver la rama suites.json) se borra siempre al
# salir: por el trap de EXIT y por los de las señales, que además cortan la corrida de las suites que esté en vuelo.
TG_PRIVATE_TREE_DIR=""
TG_SUITES_PID=""
TG_TREE_PUB_ROOT=""
TG_NO_COMPANIONS=""
TG_TREE_TOUCHED_FILE=""
TG_TOP_FULL=""
borrar_arbol_privado() {
  # La corrida de las suites va en su propio grupo de procesos (ver la rama suites.json): se corta el grupo entero, así
  # run-check y el corredor reciben la señal y el corredor corta sus suites. Cortar sólo el subshell las dejaría vivas
  # sobre el árbol ya borrado (casos: tests/test-gate-private-tree.test.js, el corte).
  if [[ -n "${TG_SUITES_PID:-}" ]]; then
    kill -TERM -- "-$TG_SUITES_PID" 2>/dev/null || kill -TERM "$TG_SUITES_PID" 2>/dev/null || true
    wait "$TG_SUITES_PID" 2>/dev/null || true
    TG_SUITES_PID=""
  fi
  if [[ -n "${TG_PRIVATE_TREE_DIR:-}" && -d "$TG_PRIVATE_TREE_DIR" ]]; then
    rm -rf "$TG_PRIVATE_TREE_DIR" || echo "[test-gate] ⚠️  no pude borrar la carpeta del árbol armado: queda en $TG_PRIVATE_TREE_DIR" >&2
  fi
  TG_PRIVATE_TREE_DIR=""
}
# Un corte por señal con el árbol armado: se borra todo, el check `tests` queda en rojo con el código (un verde de una
# corrida anterior no queda en pie, como en el 4, el 5 y el 6) y no se corren los repos hermanos.
cortar_arbol_privado() {
  borrar_arbol_privado
  # una suite sola (`--suite`) no es la corrida completa: su corte no toca el check `tests`
  [[ -n "$SUITE_ONLY" ]] || marcar_tests_en_rojo "$1" "la corrida se cortó (señal) mientras medía el repo privado adelgazado: no es verde"
  trap - EXIT
  exit "$1"
}
correr_hermanos_al_salir() {
  local rc=$?
  trap - EXIT
  borrar_arbol_privado
  if [[ "${TYCON_TEST_GATE_COMPANION:-}" == "1" || "${TYCON_TEST_GATE_PART:-}" == "1" || -z "$STORY_ARG" || ! -f "$STORY_ARG" ]]; then exit "$rc"; fi
  # El árbol del privado adelgazado no se pudo armar (o su lista está rota): el portón ya sale 4 sin medir nada, y
  # correr el público solo como hermano no lo vuelve medible.
  if [[ -n "$TG_NO_COMPANIONS" ]]; then
    echo "[test-gate] repos hermanos: no se corren — $TG_NO_COMPANIONS" >&2
    exit "$rc"
  fi
  local story_abs blancos err
  story_abs="$(cd "$(dirname "$STORY_ARG")" && pwd)/$(basename "$STORY_ARG")"
  err="$(mktemp "$TG_TMP/test-gate-hermanos-XXXXXX")"
  if ! blancos="$(node "$SCRIPT_DIR/lib/companion-repos.js" targets "$REPO_STORY" "$story_abs" 2>"$err")"; then
    # «No pude averiguar» no es «no hay hermanos»: con el repo en verde, salir 0 dejaría sin correr la suite de un
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
    hrc=0
    # El público que fue debajo del árbol armado ya se midió ahí, con lo privado encima (las mismas suites
    # que leen lo tocado). Correrlo otra vez solo duplicaría la corrida (unos 8 minutos más); su resultado es el de
    # este repo.
    if [[ -n "${TG_TREE_PUB_ROOT:-}" && "$root" == "$TG_TREE_PUB_ROOT" ]]; then
      echo "[test-gate] repo hermano $(basename "$root"): se midió dentro del árbol armado del privado (no se corre dos veces)" >&2
      filas+="${root}"$'\x1f'"${scope}"$'\x1f'"${archivos}"$'\x1f'"${rc}"$'\n'
      continue
    fi
    echo "[test-gate] repo hermano $(basename "$root"): la story declara ahí ${archivos//,/, } → corre su suite${scope:+ (alcance $scope)}" >&2
    # TYCON_TEST_GATE_STORY_REPO: el repo de la story, para que el cruce de cobertura del hermano mire sólo lo que la
    # story crea en él (lib/companion-repos.js declared-in).
    # `< /dev/null`: la lista de hermanos entra al bucle por la entrada estándar; una suite que la lee se traga los
    # hermanos siguientes: quedarían sin correr y sin aviso.
    if [[ -n "$scope" ]]; then
      TYCON_TEST_GATE_COMPANION=1 TYCON_TEST_GATE_STORY_REPO="$REPO_STORY" TYCON_TEST_SCOPE= bash "$SCRIPT_DIR/test-gate.sh" "$root" "$story_abs" "$scope" < /dev/null || hrc=$?
    else
      # Sin alcance propio: el de este repo (TYCON_TEST_SCOPE) no vale para el hermano.
      TYCON_TEST_GATE_COMPANION=1 TYCON_TEST_GATE_STORY_REPO="$REPO_STORY" TYCON_TEST_SCOPE= bash "$SCRIPT_DIR/test-gate.sh" "$root" "$story_abs" < /dev/null || hrc=$?
    fi
    # 75: en el hermano hay otra corrida de las pruebas en marcha. El total no se midió: no queda tests-result.json, el
    # check queda en rojo (este repo pudo dejarlo verde) y la puerta sale 75, igual que si el ocupado fuera este repo.
    if [[ "$hrc" == "75" ]]; then
      rm -f "$OUT_FILE"
      marcar_tests_en_rojo 1 "corrida a medias: el repo hermano $(basename "$root") no corrió porque otra corrida de sus pruebas está en marcha; no es verde"
      echo "🟡 [test-gate] el repo hermano $(basename "$root") no corrió: otra corrida de sus pruebas está en marcha. Esperá su resultado; no quedó tests-result.json." >&2
      exit 75
    fi
    # Un 7 del hermano sin la constancia de «sin acotar» es un rojo de verdad: se combina como 1.
    if [[ "$hrc" == "7" ]] && ! es_sin_acotar "$root/.advisors/tests-result.json"; then
      echo "[test-gate] ⚠️  el repo hermano $(basename "$root") salió 7 sin la constancia de «sin acotar»: es un rojo" >&2
      hrc=1
    fi
    filas+="${root}"$'\x1f'"${scope}"$'\x1f'"${archivos}"$'\x1f'"${hrc}"$'\n'
    # Un rojo de verdad gana; «sin acotar» (7) gana sobre verde y sobre «sin pruebas» (3).
    if [[ "$final" == "0" || "$final" == "3" || "$final" == "7" ]] && [[ "$hrc" != "0" && "$hrc" != "3" && "$hrc" != "7" ]]; then final="$hrc"
    elif [[ "$final" == "0" || "$final" == "3" ]] && [[ "$hrc" == "7" ]]; then final=7
    # el 3 de «la herramienta no arrancó» no es «sin pruebas acá»: este repo tiene pruebas y no se midieron
    elif [[ "$final" == "3" && "$hrc" == "0" && -z "${TG_NOT_MEASURED:-}" ]]; then final=0; fi
  done <<< "$blancos"
  node -e '
    const fs = require("fs"), p = require("path");
    const [out, ts, storyId, rc, final, filas] = process.argv.slice(1);
    const companions = filas.split("\n").filter(Boolean).map((l) => {
      const [root, scope, archivos, exit] = l.split("\x1f");
      const n = Number(exit);
      return { root, scope: scope || null, files: archivos.split(",").filter(Boolean), exit: n, green: n === 0,
        no_suite: n === 3, ...(n === 7 ? { unscoped: true } : {}), artifact: p.join(root, ".advisors", "tests-result.json") };
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
    // este repo no tiene pruebas que el portón sepa correr, pero un hermano las corrió: lo medido es el hermano, y
    // «pruebas no medidas» ya no es cierto (el marcador lo dejó la corrida del hermano)
    if (art.no_stack && companions.some((c) => c.green)) {
      delete art.no_stack; delete art.no_stack_reason;
      art.no_suite_here = true;
    }
    // «Sin acotar» en un hermano sube arriba: el total no es verde aunque este repo lo esté, y quien lee sólo el nivel
    // de arriba (el revisor de cobertura) no puede leerlo verde.
    if (Number(final) === 7) {
      const sin = companions.filter((c) => c.unscoped).map((c) => p.basename(c.root));
      // el motivo propio (si este repo tampoco se pudo acotar) se conserva; los hermanos se suman
      const motivos = [art.unscoped ? art.unscoped_reason : null, sin.length ? `repo(s) hermano(s) sin acotar: ${sin.join(", ")}` : null].filter(Boolean);
      art.unscoped = true;
      art.unscoped_reason = `${motivos.join("; ") || "sin acotar"} — la cubre la CI del pedido`;
      art.merge_requires_ci = true;
    }
    fs.mkdirSync(p.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(art, null, 2) + "\n");
  ' "$OUT_FILE" "$TS" "$STORY_ID" "$rc" "$final" "$filas" \
    || echo "[test-gate] ⚠️  no pude anotar los repos hermanos en $OUT_FILE (mirá el error de arriba)" >&2
  if [[ "$final" == "7" ]]; then
    marcar_tests_en_rojo 7 "sin acotar: la cubre la CI del pedido (un repo hermano no se pudo acotar a lo tocado); no es verde"
    ( cd "$REPO" && TYCON_TEST_GATE=1 node "$MARKER_JS" mark-tests-not-scoped "un repo hermano no se pudo acotar a lo tocado" ) >&2 || true
    echo "🟡 [test-gate] sin acotar: la cubre la CI del pedido — el merge exige la CI completa en verde." >&2
  elif [[ "$final" == "3" && -n "${TG_NOT_MEASURED:-}" ]]; then
    # la corrida del hermano dejó su verde en el marcador: el total vuelve a «sin medir»
    ( cd "$REPO" && TYCON_TEST_GATE=1 node "$MARKER_JS" mark-tests-not-measured "$TG_NOT_MEASURED" ) >&2 \
      || marcar_tests_en_rojo 3 "pruebas no medidas (no pude anotar «sin medir»): $TG_NOT_MEASURED"
  elif [[ "$final" != "0" ]]; then
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

# 🔴 REPO MULTI-STACK: DEDUCIR, y si no se puede, FRENAR.
#
# Con `apinetcore/` (.NET) y `mcp/` (node --test) en el mismo repo, y la story tocando sólo `mcp/`, un
# `dotnet test` por el .csproj que aparece primero es el stack equivocado. Un aviso por stderr no alcanza: un
# control que avisa y sigue se aprende a ignorar, y una constancia en rojo del proyecto equivocado es PEOR que
# ninguna, porque parece verificación. Se deduce de lo que la story declara (o del diff), y si hay ambigüedad
# NO se corre nada.
DEDUC_TSV="$(node "$SCRIPT_DIR/lib/test-scope.js" "$REPO" "$STORY_ARG" --tsv 2>/dev/null || true)"
TG_MULTI=0; TG_SCOPE=""; TG_SOURCE=""; TG_STORY_ID=""; TG_AMBIG=0; TG_CANDS=""; TG_REASON=""; TG_SCOPES=""
# 🔴 El separador es \x1f, NO un tabulador: bash trata el tab como espacio en blanco de IFS y
# colapsa los separadores consecutivos, así que un campo vacío en el medio corre todos los de
# atrás (el alcance llegaría valiendo "1", que es el flag de ambigüedad).
IFS=$'\x1f' read -r TG_MULTI TG_SCOPE TG_SOURCE TG_STORY_ID TG_AMBIG TG_CANDS TG_REASON TG_SCOPES <<< "$DEDUC_TSV"
TG_MULTI="${TG_MULTI:-0}"; TG_AMBIG="${TG_AMBIG:-0}"
# Cuando $2 es la RUTA de la story, el id sale del frontmatter — una sola verdad: lo lee el
# deductor, que ya abrió el archivo. Si $2 era un id, se respeta tal cual.
if [[ -n "$TG_STORY_ID" ]]; then STORY_ID="$TG_STORY_ID"; fi

# --- Varios proyectos tocados: una corrida por proyecto ---------------------------------------------------------
# Una story que toca dos o más proyectos con pruebas del mismo repo (el back en pytest y el front en Vitest) corre cada
# uno con su suite, en serie, cada uno con su artefacto; el de la raíz junta los resultados en `parts` y es verde sólo
# si todas lo son. Frenar con 4 dejaría el back sin medir. Archivos que no caen en ningún proyecto siguen
# frenando con 4, y una story de otro repo sigue con la salida 7 de la corrida cruzada.
correr_partes() {
  local partes="$1" story_abs="" final=0 filas="" scope hrc out
  [[ -n "$STORY_ARG" && -f "$STORY_ARG" ]] && story_abs="$(cd "$(dirname "$STORY_ARG")" && pwd)/$(basename "$STORY_ARG")"
  # el artefacto de una corrida anterior no puede quedar a la vista si éste no se llega a escribir
  rm -f "$OUT_FILE"
  echo "[test-gate] la story toca ${partes//,/, }: corre cada proyecto" >&2
  IFS=',' read -r -a _lista <<< "$partes"
  for scope in "${_lista[@]}"; do
    [[ -z "$scope" ]] && continue
    out="$OUT_DIR/tests-result.part-${scope//\//_}.json"
    hrc=0
    TYCON_TEST_GATE_PART=1 TYCON_TEST_GATE_OUT_FILE="$out" TYCON_TEST_SCOPE= bash "$SCRIPT_DIR/test-gate.sh" "$REPO" "${story_abs:-$STORY_ARG}" "$scope" < /dev/null || hrc=$?
    # 75: otra corrida de las pruebas está en marcha en este repo; no se juntan partes ni se corren hermanos
    if [[ "$hrc" == "75" ]]; then
      TG_NO_COMPANIONS="otra corrida de las pruebas está en marcha en este repo"
      # una parte anterior ya pudo dejar el check en verde: a medias no es verde
      [[ -n "$filas" ]] && marcar_tests_en_rojo 1 "corrida a medias: la parte $scope no corrió porque otra corrida de las pruebas está en marcha en este repo; no es verde"
      echo "🟡 [test-gate] la parte $scope no corrió: otra corrida de las pruebas está en marcha en este repo. Esperá su resultado; no quedó tests-result.json." >&2
      exit 75
    fi
    # un 7 de una parte sin la constancia de «sin acotar» es un rojo de verdad
    if [[ "$hrc" == "7" ]] && ! es_sin_acotar "$out"; then hrc=1; fi
    filas+="${scope}"$'\x1f'"${hrc}"$'\x1f'"${out}"$'\n'
    # un rojo de verdad gana sobre «sin acotar» (7), y éste sobre verde y sobre «sin pruebas» (3)
    if [[ "$hrc" != "0" && "$hrc" != "3" && "$hrc" != "7" ]]; then
      [[ "$final" == "0" || "$final" == "7" ]] && final="$hrc"
    elif [[ "$hrc" == "7" && "$final" == "0" ]]; then final=7; fi
  done
  node -e '
    const fs = require("fs"), p = require("path");
    const [out, ts, storyId, final, filas] = process.argv.slice(1);
    const parts = filas.split("\n").filter(Boolean).map((l) => {
      const [scope, exit, file] = l.split("\x1f");
      let a = null; try { a = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_e) { a = null; }
      return { scope, exit: Number(exit), green: Number(exit) === 0, runner: a ? a.runner : null, totals: a ? a.totals : {}, artifact: file };
    });
    const suma = (k) => parts.reduce((n, x) => n + (Number.isFinite(x.totals && x.totals[k]) ? x.totals[k] : 0), 0);
    // cero pruebas corridas entre todas las partes no es verde (salida 6), como en una corrida de un solo proyecto
    let fin = Number(final);
    const corridas = suma("total") - suma("skipped");
    if (fin === 0 && !(corridas > 0)) fin = 6;
    const art = { ts, story_id: storyId, runner: parts.map((x) => x.runner || "?").join("+"), repo: null,
      suite_exit: fin, suite_green: fin === 0 && parts.length > 0,
      ...(fin === 6 ? { no_tests_run: "ninguna de las partes corrió pruebas: eso no es verde" } : {}),
      ...(fin === 7 ? { unscoped: true, merge_requires_ci: true,
        unscoped_reason: `parte(s) sin acotar: ${parts.filter((x) => x.exit === 7).map((x) => x.scope).join(", ")} — la cubre la CI del pedido` } : {}),
      totals: { total: suma("total"), passed: suma("passed"), failed: suma("failed"), skipped: suma("skipped") },
      parts,
      coverage: { per_new_file: {}, new_files_pct: null, threshold: null, meets_threshold: null,
        no_cross_check: "la cobertura está en el artefacto de cada parte (parts[].artifact)" },
      provenance: "test-gate.sh: una corrida por proyecto tocado; el total es verde sólo si todas lo son" };
    fs.mkdirSync(p.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(art, null, 2) + "\n");
    // la copia que viaja (la que lee runtime-matrix.js) es la del TOTAL, no la de la última parte
    const clave = process.env.TYCON_EVIDENCE_KEY;
    if (clave && !process.env.TYCON_EVIDENCE_KEY_FAILED && /^[A-Za-z0-9][A-Za-z0-9._+~-]*$/.test(clave) && !clave.includes("..")) {
      const evDir = process.env.TYCON_EVIDENCE_DIR || p.join(p.dirname(out), "dod-runtime");
      fs.mkdirSync(evDir, { recursive: true });
      fs.writeFileSync(p.join(evDir, `${clave}-tests-result.json`), JSON.stringify({ kind: "tests-result-sellado", story_id: storyId,
        ts, runner: art.runner, suite_exit: art.suite_exit, suite_green: art.suite_green, halted: null, totals: art.totals,
        coverage: art.coverage, provenance: art.provenance }, null, 2));
    }
  ' "$OUT_FILE" "$TS" "$STORY_ID" "$final" "$filas" || {
    echo "[test-gate] 🔴 no pude juntar las partes en $OUT_FILE: sin artefacto, esto no es verde" >&2
    [[ "$final" == "0" ]] && final=1
  }
  # el total de pruebas lo decidió el artefacto (cero pruebas → 6)
  if [[ "$final" == "0" ]] && ! node -e 'try{process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).suite_green===true?0:1)}catch(e){process.exit(1)}' "$OUT_FILE"; then
    final=6
  fi
  if [[ "$final" == "7" ]]; then
    ( cd "$REPO" && TYCON_TEST_GATE=1 node "$MARKER_JS" mark-tests-not-scoped "una parte de la story no se pudo acotar a lo tocado" ) >&2 || true
  elif [[ "$final" != "0" ]]; then
    marcar_tests_en_rojo "$final" "una de las partes de la story (${partes//,/, }) no está en verde: salida $final"
  fi
  echo "[test-gate] partes: resultado total → salida $final" >&2
  exit "$final"
}
if [[ -z "$SCOPE" && -z "$SUITE_ONLY" && "$TG_MULTI" == "1" && "$TG_SCOPES" == *,* ]]; then correr_partes "$TG_SCOPES"; fi

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
# (ej. `custom-forms/`, con la solución un nivel más abajo) pasaría la detección, correría
# `dotnet test` ahí, saldría MSB1003 y dejaría `tests-result.json` en ROJO con el id de la story
# puesto — de un comando que no puede funcionar nunca. Una constancia falsa es peor que ninguna.
_DOTNET_CORRIBLE=""
if ls "$REPO"/*.sln >/dev/null 2>&1 || ls "$REPO"/*.csproj >/dev/null 2>&1; then
  _DOTNET_CORRIBLE="sí"
fi

RUNNER=""
# Las herramientas de lib/test-runners.js: la que declaró la organización (team-repos.json → stack.test_runners) va
# antes que todo; las de fábrica nuevas (pytest, Go, Maven, Gradle, Karma), después de las de siempre. El comando sale
# de la configuración del arnés, nunca del repo que se prueba.
GENERICO_JSON="$(node "$SCRIPT_DIR/lib/test-runners.js" resolve "$REPO" 2>/dev/null)" || GENERICO_JSON=""
_campo_generico() { node -e 'try{const j=JSON.parse(process.argv[1]);const r=j.runner||{};const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],r);process.stdout.write(v==null?"":String(v))}catch(e){}' "$GENERICO_JSON" "$1"; }
node -e 'try{for(const p of JSON.parse(process.argv[1]).problems||[])console.error("[test-gate] ⚠️  "+p)}catch(e){}' "$GENERICO_JSON" >&2 || true
GENERICO_NOMBRE="$(_campo_generico name)"
GENERICO_ORIGEN="$(_campo_generico source)"
if [[ -n "$GENERICO_NOMBRE" && "$GENERICO_ORIGEN" == "organizacion" ]]; then
  RUNNER="$GENERICO_NOMBRE"; GENERICO=1
elif [[ -n "$_HAY_DOTNET" && ( -n "$_DOTNET_CORRIBLE" || -z "$GENERICO_NOMBRE" ) ]]; then
  # un .csproj más abajo no le gana al proyecto de acá (pytest.ini, go.mod…): sólo una solución o un proyecto .NET en
  # esta misma carpeta
  RUNNER="dotnet"
elif [ -f "$REPO/package.json" ] && grep -q '"vitest"' "$REPO/package.json" 2>/dev/null; then
  RUNNER="vitest"
elif [ -f "$REPO/package.json" ] && grep -qE '"test"[[:space:]]*:[[:space:]]*"[^"]*node --test' "$REPO/package.json" 2>/dev/null; then
  # Runner nativo de Node (`node --test`) — el 3er stack del equipo, sin jest ni vitest.
  # Sin esta rama, un repo así cae en el `exit 3` de «no se detectó
  # stack» y la matriz runtime queda SIN artefacto: marca los ACs como NOT-RUN con la suite realmente
  # verde. Un gate que no puede mirar bloquea igual que uno que mira y ve rojo, pero por la razón equivocada.
  RUNNER="node-test"
elif [ -f "$REPO/package.json" ] && grep -qE '"jest"[[:space:]]*:|"test"[[:space:]]*:[[:space:]]*"[^"]*jest' "$REPO/package.json" 2>/dev/null; then
  # jest: sin esta rama,
  # el gate dice «no se detectó stack» y sale 3, y la suite del frontend no pasa por ningún control.
  # Su JSON (`--json`) y su coverage (`coverage/coverage-final.json`) tienen el MISMO formato que
  # vitest, así que el parser de abajo los lee sin ramas nuevas.
  RUNNER="jest"
elif [ -f "$REPO/scripts/tests/suites.json" ]; then
  # suites.json. El repo del ARNÉS no tiene package.json ni .csproj: sus suites son
  # archivos sueltos declarados en `scripts/tests/suites.json`, que el pipeline de Azure ya corre cada
  # noche. Sin este runner el gate sale 3 («no se detectó stack») y nunca escribe tests-result.json: la
  # matriz de DoD marcaría criterios como NOT-RUN con la suite realmente verde. El runner usa la MISMA
  # lista que el nocturno.
  RUNNER="suites-json"
elif [[ -n "$GENERICO_NOMBRE" ]]; then
  # una herramienta de fábrica con su detector EN esta carpeta (go.mod, pytest.ini…) gana sobre la búsqueda de un
  # proyecto node en las subcarpetas: el proyecto es el de acá
  RUNNER="$GENERICO_NOMBRE"; GENERICO=1
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
if [[ -z "$RUNNER" && -n "$GENERICO_NOMBRE" ]]; then RUNNER="$GENERICO_NOMBRE"; GENERICO=1; REPO_RUN="$REPO"; fi
GENERICO="${GENERICO:-}"

# Un solo proyecto con pruebas, en una subcarpeta (el back en `backend/` con pytest.ini y nada en la raíz): el deductor
# no tiene alcance que deducir, y la raíz no tiene corredor. Se corre ése, con su alcance, en vez de salir 3.
if [[ -z "$RUNNER" && -z "$SCOPE" && -n "$TG_CANDS" && "$TG_CANDS" != *,* ]]; then
  _UNICO="${TG_CANDS%%:*}"
  if [[ -n "$_UNICO" && "$_UNICO" != "." && -d "$REPO/$_UNICO" ]]; then
    echo "[test-gate] alcance: el único proyecto con pruebas, $_UNICO/" >&2
    trap - EXIT
    TYCON_TEST_SCOPE= exec bash "$SCRIPT_DIR/test-gate.sh" "$REPO" "$STORY_ARG" "$_UNICO" ${SUITE_ONLY:+--suite "$SUITE_ONLY"}
  fi
fi

# `--suite` es una suite de suites.json: con otro corredor no hay a qué entrada apuntar.
if [[ -n "$SUITE_ONLY" && "$RUNNER" != "suites-json" ]]; then
  echo "[test-gate] 🔴 --suite sólo sirve en un repo con scripts/tests/suites.json; acá el corredor es ${RUNNER:-ninguno}: no corrí nada" >&2
  trap - EXIT
  exit 2
fi

if [[ -z "$RUNNER" ]]; then
  # 🔴 La salida 3 deja constancia y el check `tests` queda «sin medir»: sin artefacto, el revisor de
  # pruebas lo leería como «el portón no corrió» (un crítico falso), y sin tocar el marcador la historia cerraría sin decir
  # que nadie midió nada (o con el verde de una corrida anterior).
  _MIRADAS="$(cd "$REPO" && { echo "."; for d in */; do [[ -d "$d" ]] && echo "${d%/}/"; done; } | head -12 | paste -sd ',' - | sed 's/,/, /g')"
  _RAZON="el portón no sabe correr las pruebas de este repo: miré ${_MIRADAS} y no encontré un proyecto de .NET, Vitest, Jest, node --test, pytest, Go, Maven, Gradle, Karma ni Playwright. Para medirlas, declará el comando de pruebas del repo en el sitio de la organización: pestaña Configuración → Tu tecnología → Cómo se corren las pruebas (stack.test_runners de team-repos.json)"
  echo "[test-gate] 🟡 pruebas no medidas: $_RAZON" >&2
  node -e '
    const fs = require("fs"), p = require("path");
    const [out, storyId, ts, reason] = process.argv.slice(1);
    fs.mkdirSync(p.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({
      ts, story_id: storyId, runner: null, repo: null,
      suite_exit: 3, suite_green: false,
      no_stack: true, no_stack_reason: reason,
      totals: {},
      coverage: { per_new_file: {}, new_files_pct: null, threshold: null, meets_threshold: null },
      provenance: "test-gate.sh NO MIDIÓ — no reconoce ninguna herramienta de pruebas en el repo; no se corrió ninguna suite",
    }, null, 2) + "\n");
  ' "$OUT_FILE" "$STORY_ID" "$TS" "$_RAZON" || echo "[test-gate] ⚠️  no pude escribir la constancia en $OUT_FILE" >&2
  # Una parte o un repo hermano sin pruebas no toca el marcador: el total lo decide la corrida que los lanzó, donde 3 es
  # «sin pruebas acá» y otra parte o el repo de la story pueden estar en verde.
  if [[ "${TYCON_TEST_GATE_PART:-}" != "1" && "${TYCON_TEST_GATE_COMPANION:-}" != "1" ]]; then
    # si el marcador no se deja escribir, un verde de otra corrida no puede quedar en pie: el check queda en rojo
    if ! ( cd "$REPO" && TYCON_TEST_GATE=1 node "$MARKER_JS" mark-tests-not-measured "$_RAZON" ) >&2; then
      echo "[test-gate] ⚠️  no pude anotar «sin medir» en el marcador: el check tests queda en rojo" >&2
      marcar_tests_en_rojo 3 "pruebas no medidas (no pude anotar «sin medir»): $_RAZON"
    fi
  fi
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

# --- La herramienta que corre las pruebas tiene que estar ---
# Sin `npx` o sin `dotnet` en el PATH (en Windows pasa: Git Bash no ve lo que instaló otro shell), `run-check`
# lanzaría un comando inexistente y dejaría un rojo con totales vacíos. Acá se dice qué falta,
# el artefacto lo anota, y NO se corre nada: «no pude correr» no es «pasaron» ni «fallaron».
case "$RUNNER" in
  dotnet) _HERRAMIENTA="dotnet" ;;
  vitest|jest) _HERRAMIENTA="npx" ;;
  node-test) _HERRAMIENTA="npm" ;;
  *) _HERRAMIENTA="node" ;;
esac
[[ -n "$GENERICO" ]] && _HERRAMIENTA="$(_campo_generico tool)"
# `command -v` sólo no alcanza: en Windows Git Bash encuentra el guion `npx`
# sin extensión, pero run-check lo lanza desde Node, que no lanza un `npx.cmd` sin shell; y bash cuenta también un
# archivo sin permiso de ejecución. `portable-tools.js can-launch` mira con la MISMA búsqueda con la que run-check lanza.
_NO_LANZA=""
if [[ "$_HERRAMIENTA" == ./* ]]; then
  # un envoltorio del proyecto (./gradlew): tiene que estar y poder ejecutarse; lo lanza bash, no run-check
  [[ -x "$REPO_RUN/${_HERRAMIENTA#./}" ]] || _NO_LANZA="no está en el proyecto o no se puede ejecutar"
elif [[ -n "$GENERICO" ]]; then
  # el comando de estas herramientas lo lanza bash (run-check corre `bash -c`): alcanza con que el shell lo vea
  command -v "$_HERRAMIENTA" >/dev/null 2>&1 || _NO_LANZA="no está en el PATH"
elif ! command -v "$_HERRAMIENTA" >/dev/null 2>&1; then
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
# Las carpetas de resultados de más de 7 días que dejó la puerta (resumen y salida entera de cada suite roja) se borran
# acá: nadie más las limpia. Sólo las de este usuario con el nombre de mktemp de abajo.
node "$SCRIPT_DIR/lib/old-gate-results.js" "$TG_TMP" || true
RESULTS_DIR="$(mktemp -d "$TG_TMP/test-gate-XXXXXX")"
SUITE_EXIT=0
TEST_PROJECTS=()  # declarado arriba: la rama vitest también lo expande (set -u safe)

# 🔴 Marca de procedencia del check `tests`. `marker.js run-check tests` la lee y anota
# provenance='test-gate' en vez de 'run-check'; `complete-step run-tests` BLOQUEA un verde que no venga
# de acá. Un check verde con una fracción de las pruebas (sólo las que la story declara) no puede
# pasar por control: la corrida completa es la que cuenta.
export TYCON_TEST_GATE=1
# El buzón apagado para cada prueba: ninguna sube al buzón real del equipo, aunque se equivoque (la llave de esta
# máquina está en el árbol). La llave apunta a un archivo que no existe; una prueba que mide la subida pone sus propias
# variables y su destino de prueba.
export TYCON_MAILBOX=0 TYCON_NO_UPLOAD_RUNS=1 TYCON_MAILBOX_JSON="${TMPDIR:-/tmp}/sin-llave-del-buzon-$$/corridas-buzon.json" TYCON_SUITE_RUNNER=test-gate

if [[ -n "$GENERICO" ]]; then
  # El comando, con {results} ya reemplazado por la carpeta de esta corrida; la definición queda en runner.json para
  # el informe (qué reporte y qué cobertura leer). La marca de inicio sirve para leer sólo los reportes de esta corrida.
  node "$SCRIPT_DIR/lib/test-runners.js" resolve "$REPO_RUN" --results "$RESULTS_DIR" > "$RESULTS_DIR/runner.json" 2>/dev/null
  GENERICO_JSON="$(cat "$RESULTS_DIR/runner.json")"
  _CMD="$(_campo_generico command)"
  touch "$RESULTS_DIR/.inicio"
  echo "[test-gate] $RUNNER ($(_campo_generico source)): $_CMD"
  ( cd "$REPO_RUN" && node "$MARKER_JS" run-check tests -- \
      bash -c "set -o pipefail; $_CMD 2>&1 | tee $(printf %q "$RESULTS_DIR/run.log")" ) || SUITE_EXIT=$?
  # pytest sin pytest-cov rechaza --cov: se corre de nuevo sin cobertura, y el informe lo dice
  _SIN_COV="$(_campo_generico commandWithoutCoverage)"
  if [[ "$SUITE_EXIT" != "0" && "$SUITE_EXIT" != "75" && -n "$_SIN_COV" ]] && grep -q "unrecognized arguments: --cov" "$RESULTS_DIR/run.log" 2>/dev/null; then
    echo "[test-gate] ⚠️  $RUNNER sin pytest-cov: corre de nuevo sin cobertura" >&2
    echo "falta pytest-cov: las pruebas corrieron sin medir la cobertura" > "$RESULTS_DIR/sin-cobertura.txt"
    SUITE_EXIT=0
    ( cd "$REPO_RUN" && node "$MARKER_JS" run-check tests -- \
        bash -c "set -o pipefail; $_SIN_COV 2>&1 | tee $(printf %q "$RESULTS_DIR/run.log")" ) || SUITE_EXIT=$?
  fi
  # Las salidas 3 a 7 son del gate (sin pruebas, alcance, herramienta faltante, cero pruebas, sin acotar): la de una
  # herramienta no puede confundirse con ellas. pytest sale 5 cuando no encontró ninguna prueba: es un 6 del gate.
  if [[ "$RUNNER" == "pytest" && "$SUITE_EXIT" == "5" ]]; then
    echo "pytest no encontró ninguna prueba (salió 5)" > "$RESULTS_DIR/sin-pruebas.txt"
    SUITE_EXIT=6
  elif [[ "$SUITE_EXIT" =~ ^[3-7]$ ]]; then
    echo "[test-gate] $RUNNER salió $SUITE_EXIT: cuenta como falla (1), para no confundirlo con una salida del gate" >&2
    SUITE_EXIT=1
  fi
elif [[ "$RUNNER" == "dotnet" ]]; then
  # Race bi-assembly: `dotnet test` a nivel solución corre los assemblies de test EN PARALELO y, si
  # comparten la BD de test (DatabaseFixture droppea/recrea el schema), se pisan entre sí → exit=1 con
  # 0 failed reales. Si hay >1 proyecto de test, se corren SECUENCIALES (un solo run-check envuelve la
  # cadena && — exit code real).
  while IFS= read -r tp; do TEST_PROJECTS+=("$tp"); done < <(find "$REPO_RUN" -maxdepth 3 -path '*/tests/*' -name '*.csproj' -not -path '*/node_modules/*' -not -path '*/bin/*' -not -path '*/obj/*' 2>/dev/null | sort)
  # Cross-check contra el .sln: el find por
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
  #
  # El repo privado ADELGAZADO no trae lo que es del público. Medido solo, sus suites del público salían
  # ausentes y las de agent-skills corrían sobre el arnés INSTALADO (un verde que no dice nada de la rama). Se mide el
  # árbol armado —un clon del privado con sus cambios del disco y el público de la rama debajo— en una carpeta temporal
  # que se borra al salir, también si la corrida se corta. En la máquina corren sólo las suites que leen lo tocado (las
  # enteras las corre la CI del pedido y el nocturno): ver lib/private-tree.js.
  TG_TREE_ARGS=()
  _tg_thin=0
  node "$SCRIPT_DIR/lib/private-tree.js" detect "$REPO_RUN" || _tg_thin=$?
  # 0 «es», 10 «no es»; cualquier otra salida (el detector que se cae, node que falta) es «no sé», nunca «no es»
  if [[ "$_tg_thin" != "0" && "$_tg_thin" != "10" ]]; then
    [[ "$_tg_thin" == "4" ]] || echo "[test-gate] 🔴 el detector del privado adelgazado salió $_tg_thin: no sé si es el privado adelgazado, y medirlo solo leería el arnés instalado" >&2
    _tg_thin=4
  fi
  if [[ "$_tg_thin" == "4" ]]; then
    # la lista del privado adelgazado no se deja leer, o le falta su guion (el motivo, arriba): medirlo solo leería el
    # arnés instalado
    TG_NO_COMPANIONS="no se pudo saber si el repo es el privado adelgazado"
    marcar_tests_en_rojo 4 "no se pudo saber si el repo es el privado adelgazado (el motivo, arriba): no corrí nada"
    exit 4
  fi
  if [[ "$_tg_thin" == "0" ]]; then
    _tg_tmp_root="${TYCON_PRIVATE_TREE_TMP:-${TMPDIR:-/tmp}}"
    mkdir -p "$_tg_tmp_root"
    TG_PRIVATE_TREE_DIR="$(mktemp -d "${_tg_tmp_root%/}/arbol-privado-XXXXXX")" || { echo "[test-gate] 🔴 no pude crear la carpeta temporal del árbol armado en $_tg_tmp_root" >&2; TG_NO_COMPANIONS="no se pudo crear la carpeta del árbol armado"; marcar_tests_en_rojo 4 "no pude crear la carpeta del árbol armado"; exit 4; }
    trap 'cortar_arbol_privado 143' TERM
    trap 'cortar_arbol_privado 130' INT
    trap 'cortar_arbol_privado 129' HUP
    _TG_STORY_ARG="-"; [[ -n "$STORY_ARG" && -f "$STORY_ARG" ]] && _TG_STORY_ARG="$STORY_ARG"
    if ! _TG_TREE_JSON="$(node "$SCRIPT_DIR/lib/private-tree.js" build "$REPO_RUN" "$_TG_STORY_ARG" "$TG_PRIVATE_TREE_DIR")"; then
      # Sin público para poner debajo, o sin poder armar el árbol (el motivo, arriba): no se corre nada, y no es verde.
      TG_NO_COMPANIONS="no se pudo armar el árbol del privado adelgazado"
      marcar_tests_en_rojo 4 "no pude armar el árbol del privado adelgazado (el motivo, arriba): no corrí nada"
      exit 4
    fi
    _tg_tree_field() { node -e 'const j=JSON.parse(process.argv[1]);const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],j);process.stdout.write(v==null?"":String(v))' "$_TG_TREE_JSON" "$1"; }
    _TG_PUB_ROOT="$(_tg_tree_field base.root)"
    TG_TREE_PUB_ROOT="$_TG_PUB_ROOT"
    _tg_rama="$(_tg_tree_field base.branch)"
    _tg_equipo="$(_tg_tree_field team)"
    # de dónde salió la capa del equipo (lib/private-tree.js → teamLayer): la variable, lo que declara la máquina, o
    # ninguna; lo declarado que no sirve se dice acá y no se usa
    case "$(_tg_tree_field teamSource)" in
      env) _tg_capa="capa del equipo: $_tg_equipo (de HARNESS_TEAM_DIR)" ;;
      machine) if [[ -n "$_tg_equipo" ]]; then _tg_capa="capa del equipo: $_tg_equipo (declarada por la máquina: paths.team)"
               else _tg_capa="sin capa del equipo: $(_tg_tree_field teamProblem)"; fi ;;
      *) _tg_capa='sin capa del equipo (ni HARNESS_TEAM_DIR ni paths.team en la configuración de la máquina)' ;;
    esac
    echo "[test-gate] árbol armado del privado adelgazado — público debajo: $_TG_PUB_ROOT (rama ${_tg_rama:-suelta}, commit $(_tg_tree_field base.commit | cut -c1-12)$([[ "$(_tg_tree_field base.uncommitted)" == "true" ]] && echo ', con cambios sin commit')) · $_tg_capa · armado en $(_tg_tree_field seconds) s"
    REPO_RUN="$(_tg_tree_field tree)"
    TG_TREE_ARGS=(--skills "$(_tg_tree_field skills)" --only-touched)
    echo "[test-gate] en la máquina corren sólo las suites que leen lo tocado; las otras quedan diferidas (las corre la CI del pedido y el nocturno)"
  fi
  # --- Primero la suite que falló ---
  # Una corrida completa roja anota en el marcador las suites que fallaron (`tests-failed record`). Mientras quede alguna,
  # la completa no lanza nada: sale 76 y da el comando para repetir cada una sola. Relanzar todas para ver si se arregló
  # una cuesta la suite entera cada vez. «Completa» es la de arriba sin `--suite`, con los recortes que la puerta pone
  # sola (lo tocado, la liviana, la cruzada); una parte o un repo hermano no anotan ni se niegan.
  # `--suite <ruta>` corre esa sola en el check `tests-suite`: en verde la saca de la lista, y nunca escribe el check
  # `tests` ni tests-result.json (una suite sola no es la corrida completa).
  _TG_SUITES_FILE="$REPO_RUN/scripts/tests/suites.json"
  if [[ -n "$SUITE_ONLY" ]]; then
    _tg_has=0
    node "$SCRIPT_DIR/lib/failed-first.js" has "$_TG_SUITES_FILE" "$SUITE_ONLY" || _tg_has=$?
    if [[ "$_tg_has" != "0" ]]; then
      [[ "$_tg_has" == "1" ]] && echo "[test-gate] 🔴 $SUITE_ONLY no está en $_TG_SUITES_FILE: no corrí nada (la ruta es la de su entrada, sin la raíz)" >&2
      borrar_arbol_privado; trap - EXIT; exit 2
    fi
    _TG_ONE_ARGS=()
    [[ -n "${TG_PRIVATE_TREE_DIR:-}" ]] && _TG_ONE_ARGS=(--skills "$(_tg_tree_field skills)")
    echo "[test-gate] una sola suite: $SUITE_ONLY (mismo ambiente que la corrida completa; no escribe el check tests ni tests-result.json)"
    _tg_rc=0
    # --run-check: el corredor lo anota en el resumen con las marcas de la puerta; en rojo guarda además los casos que
    # fallaron y la salida entera de cada suite (la cola de run-check sola deja afuera el caso del medio).
    ( cd "$REPO" && node "$MARKER_JS" run-check tests-suite -- \
        node "$SCRIPT_DIR/lib/run-suites-json.js" "$REPO_RUN" "$RESULTS_DIR/suites.json" --suite "$SUITE_ONLY" ${_TG_ONE_ARGS[@]+"${_TG_ONE_ARGS[@]}"} --coverage "$RESULTS_DIR/coverage" --run-check tests-suite ) || _tg_rc=$?
    if [[ "$_tg_rc" == "0" ]]; then
      ( cd "$REPO" && TYCON_TEST_GATE=1 node "$MARKER_JS" tests-failed clear --path "$SUITE_ONLY" --repo "$REPO_STORY" ) \
        || echo "[test-gate] ⚠️  $SUITE_ONLY salió verde pero no pude sacarla de la lista de las que fallaron: la corrida completa la va a seguir pidiendo" >&2
    fi
    borrar_arbol_privado; trap - EXIT; exit "$_tg_rc"
  fi
  if [[ "${TYCON_TEST_GATE_PART:-}" != "1" && "${TYCON_TEST_GATE_COMPANION:-}" != "1" ]]; then
    TG_TOP_FULL=1
    _tg_pend=0
    ( cd "$REPO" && node "$MARKER_JS" tests-failed pending --suites "$_TG_SUITES_FILE" --gate "$SCRIPT_DIR/test-gate.sh" --repo "$REPO_STORY" ${STORY_ARG:+--story "$STORY_ARG"} ) || _tg_pend=$?
    if [[ "$_tg_pend" == "76" ]]; then
      # el artefacto de una corrida anterior no puede quedar a la vista: se leería como el resultado de ésta
      rm -f "$OUT_FILE"
      TG_NO_COMPANIONS="primero se repiten solas las suites que fallaron"
      exit 76
    fi
    [[ "$_tg_pend" == "0" ]] || echo "[test-gate] ⚠️  no pude leer la lista de las suites que fallaron (salida $_tg_pend): corro la completa igual" >&2
  fi
  BASE_JSON="$(TYCON_TEST_GATE_CROSS_REPO="$TG_CROSS" node "$SCRIPT_DIR/lib/coverage-base.js" "$REPO" 2>/dev/null)" || BASE_JSON=""
  [[ -n "$BASE_JSON" ]] || BASE_JSON='{"ref":null,"source":null,"descartadas":[{"source":"coverage-base","motivo":"no se pudo correr lib/coverage-base.js"}]}'
  # Sin base, touched-files dice «no sé» y el runner corre todo (el lado seguro; la corrida cruzada sale 7 sin correr
  # nada); igual se dice por qué. En el árbol armado del privado lo tocado sale de los dos repos, no de esta base.
  _TG_SIN_TOCADO="corren todas las suites"
  [[ -n "${TG_PRIVATE_TREE_DIR:-}" ]] && _TG_SIN_TOCADO="en el árbol armado lo tocado sale de los dos repos, no de esta base"
  [[ "$TG_CROSS" == "1" ]] && _TG_SIN_TOCADO="sin acotar — no corre ninguna suite (salida 7), la cubre la CI del pedido"
  _TG_BASE="$(node -e 'try{const j=JSON.parse(process.argv[1]);process.stdout.write(j.ref||"")}catch(e){process.stderr.write(`[test-gate] ⚠️  la base de la corrida es ilegible (${e.message}): ${process.argv[2]}\n`)}' "$BASE_JSON" "$_TG_SIN_TOCADO" || true)"
  # De dónde salió la base (env · marcador · HEAD): con «HEAD» por defecto lo commiteado no se ve, y
  # touched-files contesta «no sé» (pase adversarial 2026-09-29).
  _TG_BASE_SRC="$(node -e 'try{const j=JSON.parse(process.argv[1]);process.stdout.write(j.source||"")}catch(e){}' "$BASE_JSON" 2>/dev/null || true)"
  _TG_STORY_FILE=""; [[ -n "$STORY_ARG" && -f "$STORY_ARG" ]] && _TG_STORY_FILE="$STORY_ARG"
  # `${arr[@]+…}`: con el arreglo vacío y `set -u`, el bash 3.2 de macOS corta con «unbound variable».
  TOUCHED_ARGS=()
  if [[ -n "${TG_PRIVATE_TREE_DIR:-}" ]]; then
    # en el árbol armado, lo tocado es lo de los dos repos (las rutas del árbol son las de cada uno)
    if node "$SCRIPT_DIR/lib/private-tree.js" touched "$REPO" "$_TG_PUB_ROOT" "$_TG_STORY_ARG" "$RESULTS_DIR/touched.json" 2>"$RESULTS_DIR/touched.err"; then
      TOUCHED_ARGS=(--touched "$RESULTS_DIR/touched.json")
      # el informe cuenta las líneas tocadas en cada repo contra su base (no el árbol contra la base del privado). Va
      # sólo al informe, en su línea: exportada, la heredaban las suites que corren su propio portón de juguete.
      TG_TREE_TOUCHED_FILE="$RESULTS_DIR/touched.json"
    else
      echo "[test-gate] ⚠️  no pude averiguar qué archivos toca la story en los dos repos ($(head -1 "$RESULTS_DIR/touched.err")): sin acotar — no corre ninguna suite (salida 7), la cubre la CI del pedido" >&2
    fi
  elif node "$SCRIPT_DIR/lib/touched-files.js" "$REPO_RUN" "$_TG_STORY_FILE" "$_TG_BASE" "$_TG_BASE_SRC" > "$RESULTS_DIR/touched.json" 2>"$RESULTS_DIR/touched.err"; then
    TOUCHED_ARGS=(--touched "$RESULTS_DIR/touched.json")
  else
    echo "[test-gate] ⚠️  no pude averiguar qué archivos toca la story ($(head -1 "$RESULTS_DIR/touched.err")): $_TG_SIN_TOCADO" >&2
  fi
  # Story 7.32: en una corrida liviana (sólo documentación) corren sólo las suites que leen lo tocado; las demás quedan
  # «diferidas por corrida liviana», con la lista en el resumen. El tamaño lo dice el marcador de la sesión; sin
  # marcador legible, todo como siempre. Sin saber qué toca la story, el runner corre todo igual.
  LIGHT_ARGS=()
  # La corrida cruzada se acota a lo tocado: las ~400 suites del repo de código no corren enteras en la máquina del dev,
  # las corre la CI del pedido. Sin poder acotar, el corredor sale 7 («sin acotar») sin correr nada.
  if [[ "$TG_CROSS" == "1" ]]; then
    LIGHT_ARGS=(--only-touched)
    echo "[test-gate] la story vive en otro repo: corren sólo las suites que leen lo tocado (la completa la corre la CI del pedido)"
  elif [[ -z "${TG_PRIVATE_TREE_DIR:-}" ]]; then
    # El repo declara en `.test-gate.yaml` (lo commiteado: `test_gate`, lib/test-gate-scope.js) que su suite entera
    # la corre una CI antes del merge: en la máquina corren sólo las suites que leen lo tocado. Sin la clave, todo.
    _tg_scope_rc=0
    TG_FULL_SUITE_BY="$(node "$SCRIPT_DIR/lib/test-gate-scope.js" "$REPO_RUN")" || _tg_scope_rc=$?
    if [[ "$_tg_scope_rc" == "0" && -n "$TG_FULL_SUITE_BY" ]]; then
      LIGHT_ARGS=(--scoped-by-repo "$TG_FULL_SUITE_BY")
      echo "[test-gate] el repo acota el portón (test_gate en .test-gate.yaml): corren sólo las suites que leen lo tocado; la suite completa la corre la CI del pedido ($TG_FULL_SUITE_BY)"
    elif [[ "$_tg_scope_rc" != "10" ]]; then
      echo "[test-gate] ⚠️  no pude leer test_gate de .test-gate.yaml (salió $_tg_scope_rc): corre la suite entera" >&2
    fi
  fi
  _TG_SIZE="$(node "$MARKER_JS" get 2>/dev/null | node -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(t).size||""))}catch(e){process.stderr.write("[test-gate] no pude leer el tamaño de la corrida del marcador: corren las suites de siempre\n")}})' || true)"
  if [[ "$_TG_SIZE" == "liviana" ]]; then
    LIGHT_ARGS+=(--light)
    echo "[test-gate] corrida liviana: sólo las suites que leen algún archivo tocado (las demás, diferidas por corrida liviana)"
  fi
  # Con la cobertura pedida, cada suite corre bajo el medidor de Node y deja su lcov; el informe lee el
  # juntado ($RESULTS_DIR/coverage/lcov.info) para las líneas tocadas.
  echo "[test-gate] suites.json — corriendo scripts/tests/suites.json en paralelo, con cobertura (1 sola corrida, resumen → $RESULTS_DIR/suites.json)"
  if [[ -n "${TG_PRIVATE_TREE_DIR:-}" ]]; then
    # De fondo y con `wait`: así una señal corta la espera, el trap borra el árbol y no se espera a la suite. Con
    # `set -m` el trabajo de fondo tiene su propio grupo de procesos, que el trap corta entero.
    # El marcador es el del privado: run-check corre desde él; el corredor mide el árbol.
    set -m
    ( cd "$REPO" && node "$MARKER_JS" run-check tests -- \
        node "$SCRIPT_DIR/lib/run-suites-json.js" "$REPO_RUN" "$RESULTS_DIR/suites.json" ${TOUCHED_ARGS[@]+"${TOUCHED_ARGS[@]}"} "${TG_TREE_ARGS[@]}" --coverage "$RESULTS_DIR/coverage" --run-check tests ) &
    TG_SUITES_PID=$!
    set +m
    wait "$TG_SUITES_PID" || SUITE_EXIT=$?
    TG_SUITES_PID=""
  else
  ( cd "$REPO_RUN" && node "$MARKER_JS" run-check tests -- \
      node "$SCRIPT_DIR/lib/run-suites-json.js" "$REPO_RUN" "$RESULTS_DIR/suites.json" ${TOUCHED_ARGS[@]+"${TOUCHED_ARGS[@]}"} ${LIGHT_ARGS[@]+"${LIGHT_ARGS[@]}"} --coverage "$RESULTS_DIR/coverage" --run-check tests ) || SUITE_EXIT=$?
  fi
elif [[ "$RUNNER" == "jest" ]]; then
  # `--maxWorkers` capado por default: jest paraleliza en ~cores-1 y cada worker carga jsdom + el
  # grafo de módulos. En una 8-core/16GB eso es el swap thrash que `test-execution-discipline.md`
  # documenta (2 veces congeló la máquina del dev). Override: TYCON_JEST_MAX_WORKERS=100%.
  JEST_WORKERS="${TYCON_JEST_MAX_WORKERS:-50%}"
  echo "[test-gate] jest --coverage (1 sola corrida, maxWorkers=$JEST_WORKERS)"
  ( cd "$REPO_RUN" && node "$MARKER_JS" run-check tests -- \
      bash -c "set -o pipefail; npx jest --coverage --maxWorkers=$(printf %q "$JEST_WORKERS") --json --outputFile $(printf %q "$RESULTS_DIR/jest.json") 2>&1 | tee $(printf %q "$RESULTS_DIR/run.log")" ) || SUITE_EXIT=$?
else
  echo "[test-gate] vitest run --coverage (1 sola corrida)"
  ( cd "$REPO_RUN" && node "$MARKER_JS" run-check tests -- \
      bash -c "set -o pipefail; npx vitest run --coverage --reporter=json --outputFile $(printf %q "$RESULTS_DIR/vitest.json") 2>&1 | tee $(printf %q "$RESULTS_DIR/run.log")" ) || SUITE_EXIT=$?
fi

# De 3 a 7 son salidas del propio gate («sin suite», «no sé el alcance»…): una herramienta de pruebas que sale así
# es un rojo, y se pasa a 1 como ya hace el corredor genérico.
if [[ "$RUNNER" =~ ^(dotnet|node-test|jest|vitest)$ && "$SUITE_EXIT" =~ ^[3-7]$ ]]; then
  echo "[test-gate] $RUNNER salió $SUITE_EXIT: cuenta como falla (1), para no confundirlo con una salida del gate" >&2
  SUITE_EXIT=1
fi

# 75: `run-check tests` no lanzó nada porque otra corrida de las pruebas está en marcha en este repo (ya dijo desde
# cuándo y de quién). No es un rojo: no se escribe tests-result.json, no se toca el check y no se corren los hermanos.
if [[ "$SUITE_EXIT" == "75" ]]; then
  TG_NO_COMPANIONS="otra corrida de las pruebas está en marcha en este repo"
  # el de una corrida anterior tampoco queda a la vista: se leería como el resultado de ésta
  rm -f "$OUT_FILE"
  echo "🟡 [test-gate] no corrí nada: otra corrida de las pruebas está en marcha en este repo (arriba, desde cuándo y de quién). Esperá su resultado; no quedó tests-result.json." >&2
  exit 75
fi
# La corrida completa reemplaza la lista de las que fallaron: roja, con sus fallas; verde (o sin fallas con su entrada), vacía.
if [[ "$TG_TOP_FULL" == "1" ]]; then
  ( cd "$REPO" && TYCON_TEST_GATE=1 node "$MARKER_JS" tests-failed record --summary "$RESULTS_DIR/suites.json" --repo "$REPO_STORY" ) \
    || echo "[test-gate] ⚠️  no pude anotar las suites que fallaron: la próxima corrida completa no va a pedir repetirlas primero" >&2
fi

# --- Parsear resultados + coverage (best-effort, nunca rompe) ----------------
# Respaldo del cruce de cobertura: los archivos que la story declara CREAR. git deja de
# reportar "added" apenas se commitea, así que en una iteración de fix POSTERIOR al commit
# la lista de archivos nuevos queda vacía y el cruce se perdía sin decir nada (hallazgo de
# una persona del equipo, 2026-08-25 — el `null` del reporte se leía igual que "esto está bien").
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
# parte 2): «Revisores, otra vuelta» la compara con `suite-freshness.js check` al salir del loop de
# iteraciones — si el código cambió desde este verde, el verde ya no describe nada y se
# re-corre UNA vez sobre el código final (antes lo cazaba recién el DoD checker, paso «Probar en vivo»).
# Best-effort: sin git o con git fallando queda {"git":false} y el check dice SIN DATOS.
CODE_STATE_JSON="$(node "$SCRIPT_DIR/lib/suite-freshness.js" state "$REPO" 2>/dev/null || echo '{"git":false}')"
# Base de las «líneas tocadas» (story 2.4, 2026-09-16): el commit en el que arrancó la corrida
# (marcador), TYCON_COVERAGE_BASE, o HEAD — ver lib/coverage-base.js. Si no se puede resolver, el
# parser publica `touched_lines_pct: null` con el motivo; nunca rompe el gate.
# La rama suites-json ya la resolvió antes de correr (story 7.15): se reusa, no se recalcula.
if [[ -z "${BASE_JSON:-}" ]]; then
  BASE_JSON="$(TYCON_TEST_GATE_CROSS_REPO="$TG_CROSS" node "$SCRIPT_DIR/lib/coverage-base.js" "$REPO" 2>/dev/null)" || BASE_JSON=""
  [[ -n "$BASE_JSON" ]] || BASE_JSON='{"ref":null,"source":null,"descartadas":[{"source":"coverage-base","motivo":"no se pudo correr lib/coverage-base.js"}]}'
fi
# La sesión con la cadena canónica del arnés (lib/session-id.js: Claude, Codex, banco) — la línea de
# gates.log no puede quedar con sesión null bajo otra herramienta (revisor de fallos silenciosos).
_SID_ERR="$(mktemp "$TG_TMP/test-gate-sid-XXXXXX")"
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
TYCON_TEST_GATE_TREE_TOUCHED="${TG_TREE_TOUCHED_FILE:-}" node "$SCRIPT_DIR/lib/test-gate-report.js" "$RUNNER" "$REPO" "$REPO_RUN" "$RESULTS_DIR" "$OUT_FILE" "$SUITE_EXIT" "$STORY_ID" "$COV_MIN" "$TS" "$TEST_PROJECT_COUNT" "$SCOPE" "$SCOPE_SOURCE" "$DECLARED_NEW" "$CODE_STATE_JSON" "$BASE_REF" "$BASE_JSON" \
  || echo "[test-gate] ⚠️  el informe falló (lib/test-gate-report.js): mirá el error de arriba; no quedó artefacto" >&2

# 🔴 Una suite que sale 0 sin haber corrido ninguna prueba (o sin informe que lo cuente) NO es verde (story 8.17,
# AC 50: «nunca pasaron»). El informe ya lo dejó dicho en el artefacto; acá el check `tests` del marcador queda en
# rojo con el mismo motivo —`run-check` ya lo había puesto verde por la salida 0— y el gate sale 6.
# La herramienta no arrancó (el informe lo dejó en `not_started`): salió con error sin correr ninguna prueba y sin un
# error del código. No es un rojo de las pruebas: es «sin medir», con lo que escribió la herramienta. En una parte o un
# repo hermano sigue contando como falla: ahí la salida 3 es «sin pruebas acá» y el total podría salir verde.
_NO_ARRANCO=""
[[ -n "$GENERICO" && "$SUITE_EXIT" != "0" ]] && _NO_ARRANCO="$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j.not_started?String(j.not_started.reason||"sin detalle"):"")}catch(e){}' "$OUT_FILE")"
if [[ -n "$_NO_ARRANCO" ]]; then
  echo "🟡 [test-gate] sin medir: $RUNNER no arrancó y no corrió ninguna prueba. Escribió: $_NO_ARRANCO" >&2
  echo "   No es verde ni rojo: arreglá cómo se lanza la herramienta y volvé a medir." >&2
  if [[ "${TYCON_TEST_GATE_PART:-}" != "1" && "${TYCON_TEST_GATE_COMPANION:-}" != "1" ]]; then
    TG_NOT_MEASURED="la herramienta de pruebas ($RUNNER) no arrancó: $_NO_ARRANCO"
    # quien lee sólo el artefacto (el revisor de cobertura) tiene que ver «sin medir», no el rojo de la herramienta
    node -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));j.gate_exit=3;j.not_measured=true;fs.writeFileSync(process.argv[1],JSON.stringify(j,null,2)+"\n")}catch(e){}' "$OUT_FILE" || true
    if ! ( cd "$REPO" && TYCON_TEST_GATE=1 node "$MARKER_JS" mark-tests-not-measured "$TG_NOT_MEASURED" ) >&2; then
      marcar_tests_en_rojo 3 "pruebas no medidas (no pude anotar «sin medir»): $RUNNER no arrancó"
    fi
    exit 3
  fi
  exit 1
fi
if [[ "$SUITE_EXIT" == "7" ]] && ! { [[ "$RUNNER" == "suites-json" ]] && es_sin_acotar "$OUT_FILE"; }; then
  echo "🔴 [test-gate] la suite salió 7 y no es «sin acotar» (no hay constancia de una corrida cruzada sin acotar): es un rojo; el gate sale 1" >&2
  SUITE_EXIT=1
fi
if [[ "$SUITE_EXIT" == "7" ]]; then
  ( cd "$REPO_RUN" && TYCON_TEST_GATE=1 node "$MARKER_JS" mark-tests-not-scoped "$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).unscoped_reason||""))}catch(e){}' "$OUT_FILE")" ) >&2 || true
  echo "🟡 [test-gate] sin acotar: la cubre la CI del pedido — no se corrió ninguna suite (el motivo está en $OUT_FILE). No es verde: el merge exige la CI completa en verde." >&2
fi
if [[ "$SUITE_EXIT" == "0" ]]; then
  _VERDE="$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j.suite_green===true?"si":(j.totals&&j.totals.failed>0)?"falla":"no")}catch(e){process.stdout.write("no")}' "$OUT_FILE")"
  if [[ "$_VERDE" == "falla" ]]; then
    # la herramienta salió 0 pero el reporte trae fallas (Maven con testFailureIgnore, por ejemplo): es un rojo
    echo "🔴 [test-gate] la herramienta salió 0 pero el reporte trae pruebas fallidas: NO es verde." >&2
    ( cd "$REPO_RUN" && TYCON_TEST_GATE_MARK=1 node "$MARKER_JS" run-check tests -- node -e 'console.error("test-gate: la herramienta salió 0 con pruebas fallidas en el reporte: no es verde"); process.exit(1)' ) || true
    SUITE_EXIT=1
  elif [[ "$_VERDE" != "si" ]]; then
    echo "🔴 [test-gate] la suite salió 0 pero no corrió ninguna prueba, o no se pudo contar: NO es verde." >&2
    ( cd "$REPO_RUN" && TYCON_TEST_GATE_MARK=1 node "$MARKER_JS" run-check tests -- node -e 'console.error("test-gate: la suite salió 0 sin ninguna prueba corrida (o sin informe que lo cuente): no es verde"); process.exit(6)' ) || true
    SUITE_EXIT=6
  fi
fi

# Acotada por el repo: el cierre lo dice en una línea, verde o rojo, sólo si el corredor acotó de verdad (con
# TYCON_GATE_ALL_SUITES=1, o sin saber qué se tocó, corrió todo y su resumen no trae `scoped`).
if [[ -n "${TG_FULL_SUITE_BY:-}" && "$RUNNER" == "suites-json" ]] \
  && node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).scoped ? 0 : 1)' "$RESULTS_DIR/suites.json" 2>/dev/null; then
  echo "[test-gate] la suite completa la corre la CI del pedido ($TG_FULL_SUITE_BY): en esta máquina corrieron sólo las suites que leen lo tocado" >&2
fi

exit "$SUITE_EXIT"
