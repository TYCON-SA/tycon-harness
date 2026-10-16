#!/usr/bin/env bash
# bench-git-deterministic.test.sh — el git del SANDBOX del banco no depende de la máquina (2026-09-18).
#
# Caso disparador: el nocturno de Azure venía con 4 rojos —dos casos de `retro-pending.js` por cada
# herramienta— y los mismos casos daban VERDE en la Mac del dev. La diferencia no era el control:
# `git init --bare` toma el nombre de la rama de `init.defaultBranch`, en macOS lo fija el gitconfig
# del SISTEMA que instala Xcode (→ main) y en el agente Linux no hay ninguno, así que git cae en
# `master`. El remoto quedaba con HEAD apuntando a una rama que no existe, el clon no podía hacer
# checkout y el push moría con «src refspec main does not match any». Un rojo que sólo se ve en una
# máquina no se puede ni reproducir ni creer, y encima es el criterio (a) del corte de la Etapa 3
# del plan de protección por pull request: «cero rojos nuevos que nadie pueda explicar».
#
# Lo que fija este test: un caso del banco que crea repos git se comporta IGUAL en cualquier máquina,
# porque el sandbox ignora el gitconfig del sistema y trae el suyo. El caso de prueba corre su `git`
# con GIT_CONFIG_NOSYSTEM=1 —o sea, simula al agente Linux en cualquier máquina— y exige `main`:
# sin el arreglo del corredor sale `master` y el caso se pone rojo en las dos plataformas.
#
# 🔴 Sin pipes sobre el corredor: el exit code real es parte del veredicto.
set -u
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fallos=0
ok()  { echo "✅ $1"; }
mal() { echo "❌ $1"; fallos=$((fallos+1)); }

mkdir -p "$TMP/casos" "$TMP/bin"
# Un "control" mudo: lo que se juzga acá es el SANDBOX, no el hook.
cat > "$TMP/bin/mudo.sh" <<'HOOK'
#!/usr/bin/env bash
cat > /dev/null
exit 0
HOOK
chmod +x "$TMP/bin/mudo.sh"

cat > "$TMP/casos/99-git-determinista.json" <<JSON
{
  "hooks": [
    {
      "script": "$TMP/bin/mudo.sh",
      "event": "PostToolUse",
      "cases": [
        {
          "id": "el-sandbox-arma-repos-con-main-en-cualquier-maquina",
          "type": "must-stay-quiet",
          "__doc": "El setup simula al agente Linux (sin gitconfig del sistema) y exige que el remoto nazca en main.",
          "setup": [
            "GIT_CONFIG_NOSYSTEM=1 git init -q --bare \\"\$HOME/remoto.git\\"",
            "test \\"\$(GIT_CONFIG_NOSYSTEM=1 git -C \\"\$HOME/remoto.git\\" symbolic-ref HEAD)\\" = refs/heads/main"
          ],
          "stdin": { "session_id": "bench-git", "cwd": "\${SANDBOX_HOME}", "tool_name": "Bash", "tool_input": { "command": "true" } },
          "expect": { "exit": 0 }
        }
      ]
    }
  ]
}
JSON

salida="$TMP/salida.txt"
# El corredor escribe su registro (last-run-*.json) en el .bench/ de SU árbol, sin variable que lo mueva: corre desde
# una copia del árbol (los archivos del repo, sin lo ignorado), así esta prueba no deja nada en el clon que comparten
# las demás suites (portable-suites.test.sh lo controla).
ARBOL="$TMP/arbol"; mkdir -p "$ARBOL"
if git -C "$TCG" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  (cd "$TCG" && git ls-files -z --cached --others --exclude-standard | while IFS= read -r -d '' f; do [ -e "$f" ] && printf '%s\0' "$f"; done \
    | tar --null -T - -cf -) | tar -xf - -C "$ARBOL"
else
  (cd "$TCG" && tar --exclude=./.git -cf - .) | tar -xf - -C "$ARBOL"
fi
TYCON_BENCH_CASES_DIR="$TMP/casos" node "$ARBOL/scripts/controls-bench/runner.js" --tool claude --only "mudo.sh" > "$salida" 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then ok "C-1 el sandbox arma sus repos en 'main' aunque la máquina no lo declare"
else mal "C-1 el caso salió rojo (rc=$rc) — el sandbox está heredando el git de la máquina"; sed -n '1,12p' "$salida"; fi

# C-2: el arreglo tiene que ser del SANDBOX, no del caso — el corredor le escribe su propio gitconfig.
if grep -q "defaultBranch" "$TCG/scripts/controls-bench/runner.js"; then
  ok "C-2 el corredor le escribe al sandbox su propio gitconfig"
else
  mal "C-2 el corredor ya no le escribe gitconfig al sandbox: los casos vuelven a depender de la máquina"
fi

# C-3: y lo ignora el del sistema, en los DOS entornos (setup del caso y comando del control).
n=$(grep -c "GIT_CONFIG_NOSYSTEM" "$TCG/scripts/controls-bench/runner.js")
if [ "$n" -ge 2 ]; then ok "C-3 el sandbox ignora el gitconfig del sistema en los dos entornos"
else mal "C-3 GIT_CONFIG_NOSYSTEM aparece $n vez/veces (hacen falta 2: setup y comando del control)"; fi

echo "─────────────────────────────"
if [ "$fallos" -eq 0 ]; then echo "✅ OK — el banco corre igual en cualquier máquina"; else echo "❌ FALLARON $fallos chequeo(s)"; fi
exit $(( fallos > 0 ))
