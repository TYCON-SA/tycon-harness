#!/usr/bin/env bash
# test-scope-guard-pre.sh — enforcement de test-execution-discipline (2026-06-09).
#
# Hook PreToolUse matcher=Bash|PowerShell (en Windows Claude Code corre los comandos con su herramienta
# PowerShell, y con matcher `Bash` solo este freno no se disparaba — medido el 2026-10-04 en una sesión
# real; ver safety-guard-pre.sh). BLOQUEA (exit 2) comandos de test SIN scope:
# las 6 reglas NO-NEGOCIABLES de test-execution-discipline.md eran solo prosa y
# la máquina del dev (8c/16GB) se congeló DOS veces por full-suites sin filtro
# (swap thrash, collect 822s). Este hook las vuelve mecánicas.
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
# Fail-open: error inesperado → exit 0 (no romper la sesión por un bug del hook).
#
# 🔴 La entrada se lee SIN depender de `jq` (2026-10-03). Hasta ese día el freno hacía
# `command -v jq || exit 0`: en una máquina sin `jq` la suite completa sin filtro pasaba sin una
# palabra, y `jq` no es un requisito declarado del arnés (`node` sí). Ahora se lee con `jq` si está
# y, si no, con `node`; el resultado es el mismo con los dos (casos `sin-jq-…` del banco). Lo mismo
# para la línea de bypass.log, que también se escribía con `jq`.
#
# 🟡 DECISIÓN A CONFIRMAR — qué hace si no hay NI `jq` NI `node` (o la entrada llega vacía, no se
# pudo leer o no es JSON): deja
# pasar, AVISANDO en cada llamada, y sale 1. Es la misma decisión que safety-guard-pre.sh, con el
# razonamiento completo en su encabezado: frenar (exit 2) frenaría todos los comandos, no sólo los
# de pruebas; salir 0 con el aviso por stderr es callar (ese stderr va al registro de depuración);
# con exit 1 el comando corre y a la persona le aparece la primera línea del aviso. Acá el daño de
# dejar pasar es menor que en el safety-guard (una máquina congelada se recupera). Para frenar:
# cambiar el `exit 1` de `cannot_read` por `exit 2` y los casos `…-deja-pasar-y-lo-dice` del banco.
# 🔴 FALTA CONFIRMARLO CON UNA SESIÓN REAL: que con exit 1 el comando corre y el aviso se ve sale
# de la documentación de hooks de Claude Code; no se midió en vivo, ni en Claude Code ni en Codex.
# Lo único medido en las dos es que `exit 2` frena y llega al modelo
# (guides/codex-divergence-inventory.md). Hay que correr `scripts/controls-bench/live-fire.js`
# contra un `PreToolUse` real. Deuda anotada: `[FUP-frenos-sin-jq-live-fire]` en tasks/todo.md.
#
# Test manual:
#   echo '{"tool_input":{"command":"npm test"},"cwd":"/tmp"}' | bash test-scope-guard-pre.sh; echo "exit=$?"   # → 2
#   echo '{"tool_input":{"command":"npm test -- ListadoToolbar"},"cwd":"/tmp"}' | bash test-scope-guard-pre.sh; echo "exit=$?"  # → 0

set -u
trap 'exit 0' ERR

# Off completo (simétrico al safety-guard).
if [[ "${TYCON_TEST_SCOPE_GUARD:-1}" == "0" ]]; then exit 0; fi

# 🔴 Una entrada VACÍA o que no se pudo leer NO es «nada que frenar»: es «no pude leer», y va por
# `cannot_read` como el resto (más abajo, cuando ya está definida). Antes salía 0 acá mismo, mudo:
# la misma familia que el `exit 0` sin `jq` (revisor de fallos silenciosos, 2026-10-03). Lo que sí
# es «nada que frenar» es una entrada que se lee y no trae comando: ésa sigue saliendo 0 callada.
INPUT="$(cat 2>/dev/null)" || INPUT=""

# Con qué se lee: `jq` si está (es más rápido y este hook corre en cada comando) y `node`, que es
# requisito del arnés, si `jq` no está O no pudo. Ninguno de los dos → `cannot_read`.
# El Node del arnés (story 8.39): el propio si está y es ejecutable; si no, el del PATH. No cambia el PATH.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/harness-node.sh" 2>/dev/null || harness_node_bin() { echo node; }
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
# suelto), y antes eso era otra forma de pasar sin revisión — y en silencio.
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

# Constancia de la decisión (story 2.6). Ayuda, no evidencia: nunca cambia lo que este freno
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
  #    commit, un heredoc o un `grep` que MENCIONEN la variable lo disparan: medido sobre el registro
  #    real, 135 de 516 entradas (26 %) no son escapes de verdad. La línea del registro nuevo se
  #    escribe al final, cuando ya se sabe si algún segmento era realmente un comando de pruebas
  #    (pase adversarial, 2026-09-16). El `bypass.log` de arriba NO se toca: su ruido es anterior a
  #    esta story y cambiarlo movería un número que cuenta otra ficha — queda declarado como deuda.
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
  - Suite completa → en el portón de /tycon-merge-to-main o cuando el dev la pide (el Step 4 del
    pipeline la corre por test-gate.sh); fuera de eso, preguntale antes. Nunca en paralelo con
    subagentes. En el portón o con su OK:
      TYCON_FULL_SUITE=1 $1
    (el prefijo la permite y queda registrada en bypass.log)${ps_hint}
EOF
  constancia suite-completa bloqueo
  exit 2
}

# Analizar cada segmento del comando (manejo de && ; |).
# Nota: split simple — suficiente para los patrones reales de npm/dotnet test.
IFS=$'\n'
# ¿Alguno de los segmentos era un comando de pruebas? Sólo entonces este freno «tuvo algo que
# decidir» y anota un `paso` (story 2.6, decisión D1: el denominador no son todos los comandos).
ES_TEST=0
# Con el escape puesto, el prefijo `TYCON_FULL_SUITE=1` tapa al comando de pruebas que le sigue
# (`^npm …` no matchea `TYCON_FULL_SUITE=1 npm …`), y sin esto un escape LEGÍTIMO se quedaba sin
# anotar. Se saca sólo para MIRAR: lo que se frena se decide sobre el comando tal cual.
CMD_SEG="$CMD"
[[ "${HUBO_ESCAPE:-0}" == "1" ]] && CMD_SEG="$(echo "$CMD" | sed -E 's/TYCON_FULL_SUITE=1[[:space:]]+//g')"
SEGMENTS=$(echo "$CMD_SEG" | tr ';&|' '\n')
for SEG in $SEGMENTS; do
  SEG="$(echo "$SEG" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
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
