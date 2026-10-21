#!/usr/bin/env bash
# instinct-executor.test.sh — red del ejecutor AGNÓSTICO del observer de instincts.
#
# Verifica que instinct-observer.js elige el ejecutor correcto según qué CLI tenga la máquina
# (claude→Haiku, codex→gpt-5.4-mini, ollama local) y escribe `proposed_by` en el instinct — así
# un dev SOLO-Codex también recibe propuestas (si el cerebro estuviera
# clavado a `claude`, bajo Codex-solo no se propondría nada). Usa STUBS en PATH (no gasta tokens, no toca la red).
#
# 🔴 Nunca escribe en el arnés. Si corriera el observador REAL sobre el árbol, escribiría cada propuesta en
#    inbox/instincts/pending/ del árbol —y borraría ahí por patrón—, y sobre la copia pública, que no trae esa carpeta, la
#    crearía. Los guiones se copian a un árbol de prueba que NO trae su buzón, así que la propuesta cae en la casa
#    de la carpeta de usuario del laboratorio; al final se mide que el árbol real quedó igual.
#
# Corre en la pasada diaria del instalador (BASH_TESTS). Manual: bash scripts/tests/instinct-executor.test.sh
set -uo pipefail
# Una TYCON_HOME heredada del ambiente de quien corre movería la casa del laboratorio (tycon-home.js la mira antes que
# HOME): acá la carpeta de usuario es la del laboratorio, siempre.
unset TYCON_HOME
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fallos=0
ok()  { echo "✅ $1"; }
bad() { echo "❌ $1 — $2"; fallos=$((fallos+1)); }

# Sandbox: HOME temporal con 1 observación repetida ≥3× (un patrón) + stubs de CLI en PATH.
LAB=$(mktemp -d); trap 'rm -rf "$LAB"' EXIT
# El árbol de prueba: los guiones del grabador, la biblioteca y la pieza que dice dónde vive el estado. Sin buzón.
ARBOL="$LAB/arbol"
mkdir -p "$ARBOL/scripts/instincts" "$ARBOL/scripts/setup/harness"
cp "$TCG/scripts/instincts/"*.js "$ARBOL/scripts/instincts/"
cp -R "$TCG/scripts/lib" "$ARBOL/scripts/lib"
cp "$TCG/scripts/setup/harness/tycon-home.js" "$ARBOL/scripts/setup/harness/"
OBS="$ARBOL/scripts/instincts/instinct-observer.js"
# La bandeja: `pending/` de la casa de esa carpeta de usuario. Dónde es se le pregunta a la pieza, no se escribe acá.
CASA_LAB=$(HOME="$LAB" USERPROFILE="$LAB" node -e 'process.stdout.write(require(process.argv[1]).writePlace())' "$ARBOL/scripts/instincts/instinct-dirs.js" 2>/dev/null)
[ -n "$CASA_LAB" ] || { echo "❌ instinct-executor: NO MEDIDO — la pieza no dijo dónde se escribe (scripts/instincts/instinct-dirs.js)"; exit 1; }
PEND="$CASA_LAB/pending"
# El árbol real, antes: su primer nivel y lo que haya en su bandeja (en la copia pública no hay ninguna)
real_ahora() { echo "$(ls -A "$TCG" | sort | tr '\n' ' ')| $(ls -A "$TCG/inbox/instincts/pending" 2>/dev/null | sort | tr '\n' ' ')"; }
REAL_ANTES="$(real_ahora)"
ESPERADAS=0   # cuántas corridas tienen que dejar una propuesta en la casa del laboratorio
OBSDIR="$LAB/.claude/tycon-observations"; mkdir -p "$OBSDIR" "$LAB/bin"
# node/curl reales al bin del sandbox (homebrew no está en /usr/bin|/bin); claude/codex NO,
# así los stubs controlan qué ejecutor "existe". PATH del sandbox = solo $LAB/bin + /usr/bin + /bin.
ln -sf "$(command -v node)" "$LAB/bin/node"
ln -sf "$(command -v curl)" "$LAB/bin/curl" 2>/dev/null || true
MONTH=$(date -u +%Y-%m)
for i in 1 2 3 4; do
  echo "{\"ts\":\"${MONTH}-0${i}T10:00:00Z\",\"session_id\":\"s\",\"tool\":\"Bash\",\"project\":\"FRESNO\",\"summary\":\"git push origin main specs-only PR, ADO no dispara, agregar commit .cs\",\"status\":\"ok\"}" >> "$OBSDIR/${MONTH}.jsonl"
done

# Stub que imita `--version` ok y, ante el prompt, imprime un YAML válido con 1 instinct de alta conf.
mk_stub() { # $1=nombre  $2=modo(claude|codex|ollama)
  cat > "$LAB/bin/$1" <<STUB
#!/usr/bin/env bash
if [ "\$1" = "--version" ]; then echo "$1 stub 1.0"; exit 0; fi
# emitir YAML; codex usa -o <file>, claude imprime a stdout
YAML='\`\`\`yaml
- trigger: "after merging a specs-only PR to main in FRESNO"
  action: "add a commit touching a .cs file to trigger the ADO pipeline"
  confidence: 0.95
  domain: "build"
  scope: project
  project: "FRESNO"
  evidence_count: 4
  tycon_artifact_suggestion: null
  reasoning: "specs-only merges do not fire CI"
\`\`\`'
if [ "$2" = "codex" ]; then
  # buscar el arg -o <file>
  prev=""; for a in "\$@"; do [ "\$prev" = "-o" ] && echo "\$YAML" > "\$a"; prev="\$a"; done
  exit 0
fi
echo "\$YAML"; exit 0
STUB
  chmod +x "$LAB/bin/$1"
}

run_observer() { # $1=PATH-extra  -> imprime el proposed_by del instinct escrito
  rm -rf "$PEND"/*dar* 2>/dev/null
  HOME="$LAB" TYCON_INSTINCT_OBS_DIR="$OBSDIR" PATH="$LAB/bin:/usr/bin:/bin" \
    node "$OBS" --since "$MONTH" >/dev/null 2>&1
  local f; f=$(ls -t "$PEND"/*.yaml 2>/dev/null | head -1)
  [ -n "$f" ] && grep -h "proposed_by:" "$f" 2>/dev/null | head -1
  # cuenta lo que apareció en la casa del laboratorio (run_observer corre en un subshell: se anota en un archivo)
  [ -n "$f" ] && echo x >> "$LAB/escritas.txt"
  [ -n "$f" ] && rm -f "$f"
}

# ── 1. Solo claude en PATH → proposed_by claude/haiku ──
mk_stub claude claude
R=$(run_observer); ESPERADAS=$((ESPERADAS+1))
echo "$R" | grep "claude/claude-haiku" >/dev/null && ok "solo-claude → Haiku" || bad "solo-claude" "esperaba claude/haiku, dio: $R"
rm -f "$LAB/bin/claude"

# ── 2. Solo codex en PATH (dev SOLO-Codex) → proposed_by codex/gpt-5.4-mini ──
mk_stub codex codex
R=$(run_observer); ESPERADAS=$((ESPERADAS+1))
echo "$R" | grep "codex/gpt-5.4-mini" >/dev/null && ok "solo-codex → gpt-5.4-mini (dev Codex-only ya recibe propuestas)" || bad "solo-codex" "esperaba codex/gpt-5.4-mini, dio: $R"

# ── 3. auto con AMBOS → prefiere claude (Haiku, el más barato) ──
mk_stub claude claude
R=$(run_observer); ESPERADAS=$((ESPERADAS+1))
echo "$R" | grep "claude/claude-haiku" >/dev/null && ok "ambos → auto prefiere Haiku" || bad "ambos-auto" "esperaba claude/haiku, dio: $R"

# ── 4. TYCON_OBSERVER_EXECUTOR=codex fuerza codex aun con claude presente ──
rm -rf "$PEND"/*dar* 2>/dev/null
HOME="$LAB" TYCON_INSTINCT_OBS_DIR="$OBSDIR" TYCON_OBSERVER_EXECUTOR=codex \
  PATH="$LAB/bin:/usr/bin:/bin" node "$OBS" --since "$MONTH" >/dev/null 2>&1
F=$(ls -t "$PEND"/*.yaml 2>/dev/null | head -1); ESPERADAS=$((ESPERADAS+1))
[ -n "$F" ] && echo x >> "$LAB/escritas.txt"
if [ -n "$F" ] && grep -q "codex/gpt-5.4-mini" "$F"; then ok "EXECUTOR=codex fuerza codex con claude presente"; rm -f "$F"; else bad "forzar-codex" "no forzó codex"; [ -n "$F" ] && rm -f "$F"; fi

# ── T18 R2_Instincts_ScriptsFindRepoRootAndLib: la ruta vieja (reemplazo generado) hace lo mismo ──
# Una sesión con la copia vieja de /tycon-instincts, o una máquina que lo corre a mano, todavía llama al observador
# por su ruta vieja: el reemplazo corre el de scripts/instincts/ y la propuesta cae en la misma bandeja.
# La ruta vieja sale del mapa de renombres (no se escribe acá: la copia pública no lleva ni el mapa ni los reemplazos).
# El reemplazo se copia al árbol de prueba (lanza el observador de SU árbol: el del arnés escribiría en el arnés).
VIEJO=""
[ -f "$TCG/scripts/lib/renames.json" ] && VIEJO=$(node -e '
  const l = require(process.argv[1]);
  const e = l.usableEntries(l.loadMap()).find((x) => x.kind === "file" && x.new === process.argv[2]);
  process.stdout.write(e ? e.old : "");
' "$TCG/scripts/lib/legacy-names.js" "scripts/instincts/instinct-observer.js" 2>/dev/null)
if [ ! -f "$TCG/scripts/lib/renames.json" ]; then
  echo "⏭️  T18 ruta vieja del observador: NO MEDIDO — copia pública sin el mapa"
elif [ -z "$VIEJO" ]; then
  bad "T18 ruta vieja del observador" "el mapa no tiene la entrada de scripts/instincts/instinct-observer.js"
elif [ ! -f "$TCG/$VIEJO" ]; then
  bad "T18 ruta vieja del observador" "falta el reemplazo $VIEJO (legacy-names.js --write-shims)"
else
  mkdir -p "$(dirname "$ARBOL/$VIEJO")" && cp "$TCG/$VIEJO" "$ARBOL/$VIEJO"
  OBS_NUEVO="$OBS"; OBS="$ARBOL/$VIEJO"
  R=$(run_observer); ESPERADAS=$((ESPERADAS+1))
  OBS="$OBS_NUEVO"
  echo "$R" | grep "claude/claude-haiku" >/dev/null && ok "T18 la ruta vieja ($VIEJO) escribe en la misma bandeja: la casa de la persona (el árbol de prueba no trae buzón)" \
    || bad "T18 ruta vieja del observador" "esperaba la propuesta en $PEND, dio: $R"
fi

# ── 5. Ningún CLI de modelo → exit 0 limpio, no escribe nada (borra SOLO los stubs, no node/curl) ──
rm -f "$LAB/bin/claude" "$LAB/bin/codex" "$LAB/bin/ollama"
HOME="$LAB" TYCON_INSTINCT_OBS_DIR="$OBSDIR" PATH="$LAB/bin:/usr/bin:/bin" \
  node "$OBS" --since "$MONTH" >/dev/null 2>&1; RC=$?
[ "$RC" = "0" ] && ok "sin ejecutor → exit 0 limpio" || bad "sin-ejecutor" "exit $RC, esperaba 0"

# ── T17 Executor_WritesInLabHome_RealTreeUntouched ──
# CADA corrida que propone deja su propuesta en la casa del laboratorio (ni una menos: son 4, o 5 con el caso de la
# ruta vieja), el árbol de prueba no gana inbox/, y el árbol real queda igual.
ESCRITAS=$(grep -c x "$LAB/escritas.txt" 2>/dev/null || true)
if [ "$ESPERADAS" -ge 4 ] && [ "${ESCRITAS:-0}" = "$ESPERADAS" ] && [ ! -e "$ARBOL/inbox" ] && [ "$(real_ahora)" = "$REAL_ANTES" ]; then
  ok "T17 las $ESPERADAS propuestas cayeron en la casa del laboratorio, el árbol de prueba sin inbox/ y el árbol real igual que antes"
else
  bad "T17 la suite no escribe en el arnés" "escritas en la casa=${ESCRITAS:-0} de $ESPERADAS · árbol de prueba: $(ls -A "$ARBOL" | tr '\n' ' ')· real antes=[$REAL_ANTES] ahora=[$(real_ahora)]"
fi

echo; [ "$fallos" = "0" ] && { echo "✅ instinct-executor: todo verde"; exit 0; } || { echo "❌ instinct-executor: $fallos fallo(s)"; exit 1; }
