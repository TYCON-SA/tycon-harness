#!/usr/bin/env bash
# test-scope-guard-pre.sh — enforcement de test-execution-discipline.
#
# Hook PreToolUse matcher=Bash|PowerShell (en Windows Claude Code corre los comandos con su herramienta
# PowerShell, y con matcher `Bash` solo este freno no se dispararía; ver safety-guard-pre.sh). BLOQUEA (exit 2)
# comandos de test SIN scope: las reglas NO-NEGOCIABLES de test-execution-discipline.md son solo prosa, y una
# full-suite sin filtro puede congelar la máquina del dev (swap thrash). Este hook las vuelve mecánicas.
#
# Bloquea:
#   - `npm test` / `npm run test` / `npm run test:coverage` SIN patrón posicional
#   - `vitest run` / `npx vitest run` / `vitest` SIN archivo/patrón
#   - `dotnet test` SIN --filter NI un .csproj/.dll/dir de proyecto específico
#
# Deja pasar:
#   - `npm test -- ListadoToolbar` (patrón posicional = scoped)
#   - `vitest run src/foo.test.ts`
#   - `dotnet test --filter "FullyQualifiedName~GetTimedOutStages"`
#   - `dotnet test tests/Foo.Tests/Foo.Tests.csproj` (proyecto específico)
#   - Cualquier comando prefijado `TYCON_FULL_SUITE=1 ...` (la corrida legítima: el portón de
#     /tycon-merge-to-main o un pedido del dev; la del pipeline va por test-gate.sh — queda
#     registrada en bypass.log para audit).
#
# Cómo lee el comando: si nombra una herramienta de pruebas, lo corta como el shell con scripts/lib/test-scope.js
# (prefijos, agrupaciones, envoltorios, otros gestores, las opciones de cada herramienta; lo que vale y lo que no está en
# guides/test-execution-discipline.md §«El freno de pruebas sin alcance»). Sin Node, el corte simple de abajo, que frena
# de más.
#
# Fail-open: error inesperado → exit 0 (no romper la sesión por un bug del hook).
#
# 🔴 La entrada se lee SIN depender de `jq`: con `command -v jq || exit 0`, en una máquina sin `jq` la suite completa
# sin filtro pasaría sin una palabra, y `jq` no es un requisito declarado del arnés (`node` sí). Se lee con `jq` si
# está y, si no, con `node`; el resultado es el mismo con los dos (casos `sin-jq-…` del banco). Lo mismo vale para
# la línea de bypass.log.
#
# 🟡 Qué hace si no hay NI `jq` NI `node` (o la entrada llega vacía, no se pudo leer o no es JSON): deja
# pasar, AVISANDO en cada llamada, y sale 1. Es la misma decisión que safety-guard-pre.sh, con el
# razonamiento completo en su encabezado: frenar (exit 2) frenaría todos los comandos, no sólo los
# de pruebas; salir 0 con el aviso por stderr es callar (ese stderr va al registro de depuración);
# con exit 1 el comando corre y a la persona le aparece la primera línea del aviso. Acá el daño de
# dejar pasar es menor que en el safety-guard (una máquina congelada se recupera). Para frenar:
# cambiar el `exit 1` de `cannot_read` por `exit 2` y los casos `…-deja-pasar-y-lo-dice` del banco.
# 🔴 Límite conocido: que con exit 1 el comando corre y el aviso se ve sale de la documentación de hooks de Claude
# Code; no está medido en vivo, ni en Claude Code ni en Codex. Lo único medido en las dos es que `exit 2` frena y
# llega al modelo (guides/maintaining/codex-divergence-inventory.md). Se mediría con
# `scripts/controls-bench/live-fire.js` contra un `PreToolUse` real.
#
# Test manual:
#   echo '{"tool_input":{"command":"npm test"},"cwd":"/tmp"}' | bash test-scope-guard-pre.sh; echo "exit=$?"   # → 2
#   echo '{"tool_input":{"command":"npm test -- ListadoToolbar"},"cwd":"/tmp"}' | bash test-scope-guard-pre.sh; echo "exit=$?"  # → 0

set -u
trap 'exit 0' ERR

# Off completo (simétrico al safety-guard).
if [[ "${TYCON_TEST_SCOPE_GUARD:-1}" == "0" ]]; then exit 0; fi

# 🔴 Una entrada VACÍA o que no se pudo leer NO es «nada que frenar»: es «no pude leer», y va por
# `cannot_read` como el resto (más abajo, cuando ya está definida). Salir 0 acá, mudo, sería la misma
# familia que el `exit 0` sin `jq`: un fallo silencioso. Lo que sí es «nada que frenar» es una entrada que se lee y no trae comando: ésa sigue saliendo 0 callada.
INPUT="$(cat 2>/dev/null)" || INPUT=""

# Con qué se lee: `jq` si está (es más rápido y este hook corre en cada comando) y `node`, que es
# requisito del arnés, si `jq` no está O no pudo. Ninguno de los dos → `cannot_read`.
# El Node del arnés: el propio si está y es ejecutable; si no, el del PATH. No cambia el PATH.
# con el bash de la Mac (3.2) y `set -e`, un `.` que no encuentra el archivo corta el guion aunque lleve `||`: se mira antes
_hn="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/harness-node.sh"
{ [ -f "$_hn" ] && . "$_hn" 2>/dev/null; } || harness_node_bin() { echo node; }
HNODE="$(harness_node_bin)"
HAS_JQ=0; HAS_NODE=0
if command -v jq >/dev/null 2>&1; then HAS_JQ=1; fi
if command -v "$HNODE" >/dev/null 2>&1; then HAS_NODE=1; fi

# read_field <ruta.con.puntos> — imprime ese campo de $INPUT: el texto tal cual; nada si falta, es
# null o es false. Sale ≠ 0 si NO PUDO LEER: no hay lector, o la entrada no es UN documento JSON
# (o el camino pasa por algo que no es un objeto). Las dos ramas hacen lo mismo a propósito: `jq`
# con `-s` exige un solo documento, que es lo que `JSON.parse` acepta; con `-s` `jq` no imprime
# nada si falla, así que probar después con `node` no duplica la salida.
# Por qué se prueba con `node` cuando `jq` falla: hay JSON válido que `jq` rechaza (un `\ud800`
# suelto), y eso sería otra forma de pasar sin revisión, en silencio.
# 🔴 Si tocás una rama, tocá la otra: este bloque está copiado igual en safety-guard-pre.sh.
read_field() {
  if [[ "$HAS_JQ" == "1" ]]; then
    if printf '%s' "$INPUT" | jq -rs --arg p "$1" \
      'if length == 1 then (.[0] | getpath($p | split(".")) // empty) else error("la entrada no es UN documento JSON") end' 2>/dev/null
    then return 0; fi
  fi
  if [[ "$HAS_NODE" == "1" ]]; then
    printf '%s' "$INPUT" | "$HNODE" -e '
      let v;
      try { v = JSON.parse(require("fs").readFileSync(0, "utf8").replace(/^\uFEFF/, "")); } catch (e) { process.exit(1); }
      for (const k of process.argv[1].split(".")) {
        if (v === null) break;
        if (typeof v !== "object" || Array.isArray(v)) process.exit(1);
        v = Object.prototype.hasOwnProperty.call(v, k) ? v[k] : null;
      }
      if (v === null || v === false) process.exit(0);
      process.stdout.write((typeof v === "string" ? v : JSON.stringify(v, null, 2)) + "\n");
    ' "$1" 2>/dev/null
    return $?
  fi
  return 1
}

# to_json_text — stdin → ese texto escrito como un string JSON (para la línea de bypass.log). Con
# `node` se iguala lo único que `jq` escribe distinto: el carácter DEL sale como \u007f.
to_json_text() {
  if [[ "$HAS_JQ" == "1" ]]; then jq -Rs .
  else "$HNODE" -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0, "utf8")).replace(/\x7f/g, "\\u007f") + "\n");'
  fi
}

# No se pudo leer la entrada: el comando pasa SIN revisar, y se DICE (decisión a confirmar: ver el
# encabezado). Una sola línea: la herramienta le muestra a la persona la primera de stderr.
cannot_read() {
  local reason="la entrada no se pudo leer como UN documento JSON"
  if [[ -z "$INPUT" ]]; then reason="la entrada llegó vacía o no se pudo leer"
  elif [[ "$HAS_JQ" == "0" && "$HAS_NODE" == "0" ]]; then reason="no hay ni jq ni node en el PATH de este hook"; fi
  echo "⚠️ TYCON test-scope-guard NO REVISÓ este comando y lo dejó pasar: ${reason}. Mientras siga así una suite completa sin filtro corre sin freno. Arreglo: que node (requisito del arnés) esté en el PATH con el que arranca la herramienta." >&2
  exit 1
}

if [[ -z "$INPUT" ]]; then cannot_read; fi
CMD="$(read_field tool_input.command)" || cannot_read
if [[ -z "$CMD" ]]; then exit 0; fi

# Constancia de la decisión. Ayuda, no evidencia: nunca cambia lo que este freno
# decide ni con qué código sale. El comando va por STDIN y de él sólo se guarda la huella.
constancia() { # $1 = regla  $2 = veredicto
  local lib="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/guard-record.js"
  [[ -f "$lib" ]] || return 0
  command -v "$HNODE" >/dev/null 2>&1 || return 0
  printf '%s' "$CMD" | "$HNODE" "$lib" --guard test-scope-guard --rule "$1" --verdict "$2" --cmd-stdin >/dev/null 2>&1 || true
  return 0
}

# Override explícito por comando: la full-suite legítima (portón del merge o pedido del dev).
# (también `$env:TYCON_FULL_SUITE="1"`, con el 1 entre comillas, como se escribe en PowerShell)
if [[ "$CMD" =~ TYCON_FULL_SUITE=[\"\']?1 ]]; then
  STATE_DIR="$HOME/.claude/.tycon-pipeline"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  printf '{"ts":"%s","type":"FULL_SUITE_RUN","command":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(echo "$CMD" | head -c 300 | to_json_text)" \
    >> "$STATE_DIR/bypass.log" 2>/dev/null || true
  # 🔴 NO se sale acá ni se anota todavía. El escape se reconoce por el TEXTO, así que un mensaje de
  #    commit, un heredoc o un `grep` que MENCIONEN la variable lo disparan: sobre el registro
  #    real, buena parte de las entradas no son escapes de verdad. La línea del registro nuevo se
  #    escribe al final, cuando ya se sabe si algún segmento era realmente un comando de pruebas.
  #    El `bypass.log` de arriba NO se toca: su ruido es conocido y cambiarlo movería un número que
  #    cuenta otra medición.
  HUBO_ESCAPE=1
fi
HUBO_ESCAPE="${HUBO_ESCAPE:-0}"

block() {
  # Con el escape declarado, el comportamiento es el de siempre: sale 0, sin mensaje.
  if [[ "${HUBO_ESCAPE:-0}" == "1" ]]; then
    constancia suite-completa escape
    exit 0
  fi
  # por la herramienta PowerShell el prefijo `TYCON_FULL_SUITE=1 <cmd>` no corre: se dice la forma que sí
  local ps_hint=""
  if [[ "$(read_field tool_name 2>/dev/null)" == "PowerShell" ]]; then
    ps_hint=$'\n'"    En PowerShell (ahí el prefijo no es sintaxis válida): \$env:TYCON_FULL_SUITE=1; $1"
  fi
  cat >&2 <<EOF
🛑 TYCON test-scope-guard BLOCK [TEST-DISCIPLINE]

Comando: $1

Motivo: comando de test SIN scope. La full-suite sin filtro paraleliza en ~cores-1
workers y en esta máquina (8c/16GB) ya la congeló 2 veces (swap thrash).

Regla (test-execution-discipline.md):
  - Iterando → SOLO el archivo tocado, con filtro:
      npm test -- <patrón>            (vitest posicional)
      dotnet test --filter "FullyQualifiedName~<Clase>"
      dotnet test tests/<Proyecto>/<Proyecto>.csproj
  - Suite completa → en el portón de /tycon-merge-to-main o cuando el dev la pide (el paso «Correr las pruebas» del
    pipeline la corre por test-gate.sh); fuera de eso, preguntale antes. Nunca en paralelo con
    subagentes. En el portón o con su OK:
      TYCON_FULL_SUITE=1 $1
    (el prefijo la permite y queda registrada en bypass.log)${ps_hint}
EOF
  constancia suite-completa bloqueo
  exit 2
}

# Puerta rápida: este freno corre en cada comando, y casi ninguno nombra una herramienta de pruebas. Sin nombrarla no
# hay nada que decidir y se sale sin arrancar Node. La lista es la misma que NOMBRA en scripts/lib/test-scope.js.
NOMBRA_PRUEBAS='dotnet|npm|pnpm|pnpx|yarn|bunx?|npx|vitest|jest|pytest|py\.test|(pwsh|powershell).*[[:space:]]-e'
shopt -s nocasematch
if ! [[ "$CMD" =~ $NOMBRA_PRUEBAS ]]; then exit 0; fi
shopt -u nocasematch

# El lector en Node corta el comando como el shell: prefijos, agrupaciones, envoltorios (`bash -c`, `ssh`, `docker
# exec`, `pwsh -Command`…), otros gestores y las opciones de cada herramienta. Su primer renglón es el veredicto; el
# segundo, el comando que lo decidió. Si no está o falla, se sigue con el corte de abajo, que frena de más.
_LECTOR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/test-scope.js"
if [[ "$HAS_NODE" == "1" && -f "$_LECTOR" ]]; then
  _HERRAMIENTA="$(read_field tool_name 2>/dev/null)" || _HERRAMIENTA=""
  if _R="$(printf '%s' "$CMD" | "$HNODE" "$_LECTOR" --tool "${_HERRAMIENTA:-Bash}" 2>/dev/null)"; then
    _VEREDICTO="${_R%%$'\n'*}"; _QUE="${_R#*$'\n'}"; _QUE="${_QUE%$'\n'}"
    case "$_VEREDICTO" in
      frena) HUBO_ESCAPE=0; block "$_QUE" ;;
      escape) constancia suite-completa escape; exit 0 ;;
      pasa) constancia suite-completa paso; exit 0 ;;
      nada) exit 0 ;;
    esac
  fi
fi

# Sin Node (o con el lector roto): cada segmento del comando (manejo de && ; |), con un corte simple.
IFS=$'\n'
# ¿Alguno de los segmentos era un comando de pruebas? Sólo entonces este freno «tuvo algo que
# decidir» y anota un `paso` (el denominador no son todos los comandos).
ES_TEST=0
# Con el escape puesto, el prefijo `TYCON_FULL_SUITE=1` tapa al comando de pruebas que le sigue
# (`^npm …` no matchea `TYCON_FULL_SUITE=1 npm …`), y sin esto un escape LEGÍTIMO quedaría sin
# anotar. Se saca sólo para MIRAR: lo que se frena se decide sobre el comando tal cual.
CMD_SEG="$CMD"
[[ "${HUBO_ESCAPE:-0}" == "1" ]] && CMD_SEG="$(echo "$CMD" | sed -E 's/TYCON_FULL_SUITE=1[[:space:]]+//g')"
# Lo que va entre comillas es texto, no un comando: en `grep "dotnet test|x"`, lo que sigue al `|` de adentro de las
# comillas no es un segmento. El comando se corta como siempre por `;`, `&`, `|` y saltos de línea, y se descartan sólo
# los segmentos que EMPIEZAN adentro de comillas: el que empieza afuera se mira entero, con sus comillas, como antes
# (`pytest "-x; echo "` sigue frenando). Una comilla escapada (`it\'s`) no abre texto.
# Lo que va entre comillas después de `bash -c`, `sh -c`, `eval`, `ssh`, `pwsh`/`powershell` o `cmd` SÍ es un comando, y
# las comillas `$'…'` tienen sus propios escapes: con cualquiera de ellos, o sin perl, se corta como antes y además se le
# sacan al segmento las comillas que quedaron sueltas (`bash -c "cd x; dotnet test"` frena).
_COMANDO_EN_TEXTO='(^|[^[:alnum:]_])((ba|z|da|k)?sh[[:space:]]+(-[[:alnum:]]+[[:space:]]+)*-[[:alnum:]]*c|eval|ssh|pwsh|powershell|cmd(\.exe)?)([[:space:]]|$)'
SEGMENTS=""
# Lo mismo con `$(…)` o comillas invertidas: lo de adentro se ejecuta aunque vaya entre comillas dobles.
# Con un heredoc (`<<`) las comillas de su cuerpo no son comillas: se corta como antes.
if command -v perl >/dev/null 2>&1 && ! [[ "$CMD_SEG" =~ $_COMANDO_EN_TEXTO ]] && [[ "$CMD_SEG" != *"\$'"* ]] && [[ "$CMD_SEG" != *"<<"* ]] \
   && [[ "$CMD_SEG" != *"\$("* ]] && [[ "$CMD_SEG" != *'`'* ]]; then
  # un comentario (`#` al empezar una palabra, fuera de comillas) llega hasta el fin de su línea: sus comillas no abren
  # texto, y su salto de línea corta como cualquier otro
  SEGMENTS="$(printf '%s' "$CMD_SEG" | perl -0ne '
    my ($cur, $q, $tira, $esc, $com) = ("", "", 0, 0, 0); my @out;
    for my $c (split //, $_) {
      if ($com) { if ($c eq "\n") { $com = 0; push @out, $cur unless $tira; $cur = ""; $tira = 0; } else { $cur .= $c; } next; }
      if ($esc) { $cur .= $c; $esc = 0; next; }
      if ($q eq "" && $c eq "#" && ($cur eq "" || $cur =~ /\s$/)) { $com = 1; $cur .= $c; next; }
      if ($c eq "\\" && $q ne "\x27") { $cur .= $c; $esc = 1; next; }
      if ($q eq "" && ($c eq "\"" || $c eq "\x27")) { $q = $c; $cur .= $c; next; }
      if ($q ne "" && $c eq $q) { $q = ""; $cur .= $c; next; }
      if ($c =~ /[;&|\n]/) { push @out, $cur unless $tira; $cur = ""; $tira = ($q ne "") ? 1 : 0; next; }
      $cur .= $c;
    }
    push @out, $cur unless $tira;
    print join("\n", @out), "\n";' 2>/dev/null)" || SEGMENTS=""
fi
_SUELTAS=0
if [[ -z "${SEGMENTS//[[:space:]]/}" ]]; then
  # cortado como antes, y además en `$(`, `(` y comillas invertidas: lo de adentro de una sustitución corre; con
  # `bash -c`, `eval` y compañía, también en las comillas (lo de adentro es el comando)
  if [[ "$CMD_SEG" =~ $_COMANDO_EN_TEXTO ]]; then
    SEGMENTS=$(echo "$CMD_SEG" | tr ";&|\`(\"'" '\n')
  else
    SEGMENTS=$(echo "$CMD_SEG" | tr ";&|\`(" '\n')
  fi
  _SUELTAS=1
fi
for SEG in $SEGMENTS; do
  SEG="$(echo "$SEG" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  # cortado como antes: una comilla que quedó sola en un borde es de un `bash -c "…; dotnet test"` partido. Sólo si
  # quedó sola (cantidad impar): `pytest -m "not slow"` conserva las suyas
  if [[ "$_SUELTAS" == "1" ]]; then
    _DOBLES="${SEG//[^\"]/}"; _SIMPLES="${SEG//[^\']/}"
    if (( ${#_DOBLES} % 2 == 1 )); then SEG="${SEG#\"}"; SEG="${SEG%\"}"; fi
    if (( ${#_SIMPLES} % 2 == 1 )); then SEG="${SEG#\'}"; SEG="${SEG%\'}"; fi
    # y lo que quedó de un `$(…; dotnet test)` o de comillas invertidas partidas
    _INVERTIDAS="${SEG//[^\`]/}"
    if (( ${#_INVERTIDAS} % 2 == 1 )); then SEG="${SEG#\`}"; SEG="${SEG%\`}"; fi
    _ABRE="${SEG//[^(]/}"; _CIERRA="${SEG//[^)]/}"
    while (( ${#_CIERRA} > ${#_ABRE} )) && [[ "$SEG" == *")" ]]; do SEG="${SEG%)}"; _CIERRA="${SEG//[^)]/}"; done
    SEG="${SEG#\$(}"
    SEG="$(echo "$SEG" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  fi
  [[ -z "$SEG" ]] && continue

  # --- npm test / npm run test[:coverage] ---
  if [[ "$SEG" =~ ^npm[[:space:]]+(run[[:space:]]+)?test(:[a-z]+)?([[:space:]]|$) ]]; then
    ES_TEST=1
    # ¿Tiene patrón posicional tras `--`? `npm test -- Foo` → scoped.
    if [[ "$SEG" =~ --[[:space:]]+[^-[:space:]] ]]; then continue; fi
    # ¿Tiene algún arg posicional directo? (`npm test Foo` no es válido en npm, requiere --)
    block "$SEG"
  fi

  # --- vitest run / npx vitest ---
  if [[ "$SEG" =~ ^(npx[[:space:]]+)?vitest([[:space:]]+run)?([[:space:]]|$) ]]; then
    ES_TEST=1
    # Args posicionales que no sean flags → scoped.
    REST="$(echo "$SEG" | sed -E 's/^(npx[[:space:]]+)?vitest([[:space:]]+run)?//')"
    HAS_POSITIONAL=0
    for TOK in $REST; do
      case "$TOK" in
        -*) ;;
        *) HAS_POSITIONAL=1; break ;;
      esac
    done
    [[ "$HAS_POSITIONAL" == "1" ]] && continue
    block "$SEG"
  fi

  # --- pytest / python -m pytest ---
  # Un archivo, una carpeta o `-k <patrón>` acotan; sin nada, es la suite completa del proyecto.
  if [[ "$SEG" =~ ^(python[0-9.]*[[:space:]]+-m[[:space:]]+)?pytest([[:space:]]|$) ]]; then
    ES_TEST=1
    REST="$(echo "$SEG" | sed -E 's/^(python[0-9.]*[[:space:]]+-m[[:space:]]+)?pytest//')"
    HAS_POSITIONAL=0
    # Las opciones que llevan valor (`-n auto`, `--cov app`, `-p x`…) no acotan: su valor no es un archivo. Sólo
    # listar o pedir la versión no corre la suite.
    SALTEAR=0
    # IFS es el salto de línea (arriba): los argumentos se separan uno por renglón. Un argumento entre comillas
    # (`-m "not slow"`, `"tests/a b.py"`) cuenta como uno solo: si no, su segunda palabra pasa por un archivo. Entre
    # comillas, una opción (`"-x"`) o nada (`""`) siguen sin acotar. Una comilla que este tramo no cierra (el comando se
    # partió en un `;` o un `|` de adentro) no cuenta: `"-x` es la opción `-x`.
    for TOK in $(echo "$REST" | sed -E "s/\"(-[^\"]*)?\"/-q/g; s/'(-[^']*)?'/-q/g; s/\"[^\"]*\"/ARG/g; s/'[^']*'/ARG/g; s/[\"']//g" | tr -s ' \t' '\n'); do
      if [[ "$SALTEAR" == "1" ]]; then SALTEAR=0; continue; fi
      case "$TOK" in
        -k|-k=*) HAS_POSITIONAL=1; break ;;
        --version|--co|--collect-only|-h|--help) HAS_POSITIONAL=1; break ;;
        -n|-p|-m|-c|-o|-W|--maxfail|--cov|--cov-report|--cov-config|--junitxml|--junit-xml|--rootdir|--durations|--tb|--log-level|--basetemp|--deselect|--ignore|--ignore-glob|--confcutdir|--dist|--numprocesses) SALTEAR=1 ;;
        -*) ;;
        *) HAS_POSITIONAL=1; break ;;
      esac
    done
    [[ "$HAS_POSITIONAL" == "1" ]] && continue
    block "$SEG"
  fi

  # --- dotnet test ---
  if [[ "$SEG" =~ ^dotnet[[:space:]]+test([[:space:]]|$) ]]; then
    ES_TEST=1
    # --filter → scoped. Proyecto/dll/dir específico como arg posicional → scoped.
    if [[ "$SEG" =~ --filter ]]; then continue; fi
    if [[ "$SEG" =~ \.(csproj|dll|sln)([[:space:]]|$) ]]; then
      # .sln es la solución completa = full suite → bloquear igual.
      if [[ "$SEG" =~ \.sln([[:space:]]|$) ]]; then block "$SEG"; fi
      continue
    fi
    # ¿Arg posicional tipo path (tests/Foo.Tests)? → scoped a ese proyecto.
    REST="$(echo "$SEG" | sed -E 's/^dotnet[[:space:]]+test//')"
    HAS_PATH=0
    for TOK in $REST; do
      case "$TOK" in
        -*) ;;
        */*|*\\*) HAS_PATH=1; break ;;   # `tests\Foo.Tests` (Windows) es un proyecto, igual que `tests/Foo.Tests`
      esac
    done
    [[ "$HAS_PATH" == "1" ]] && continue
    block "$SEG"
  fi
done

# Sólo se anota si algún segmento era de VERDAD un comando de pruebas: el denominador de este freno
# son las veces que tuvo algo que decidir, no las veces que alguien escribió su nombre.
if [[ "$ES_TEST" == "1" ]]; then
  if [[ "${HUBO_ESCAPE:-0}" == "1" ]]; then constancia suite-completa escape
  else constancia suite-completa paso; fi
fi
exit 0
