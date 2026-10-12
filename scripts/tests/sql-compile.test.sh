#!/usr/bin/env bash
# sql-compile.test.sh — red de `scripts/ci/sql-compile.js`, el aviso de migraciones SQL sin compilar.
#
# Caso que lo motiva (el repo del framework, 2026-09-10): una migración con un error de sintaxis
# (Msg 1046, una subconsulta dentro de un PRINT) llegó al commit sin haberse ejecutado nunca y frenó
# el despliegue entero. Pasó por decenas de revisores y 2589 tests: ninguno toca un `.sql` suelto.
#
# Ningún caso toca una base: `sqlcmd` es un doble que anota qué recibió y contesta lo que el caso
# fabrica. Lo que se prueba es que el aviso compile SIN EJECUTAR (NOEXEC, y sin mandar archivos
# con comandos de sqlcmd), que compile lo STAGEADO y no el disco, que nunca frene el commit, que «no compilé» no
# se lea como «compila», y que la contraseña no aparezca en ningún lado.
#
# Correr: bash scripts/tests/sql-compile.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$AQUI/scripts/ci/sql-compile.js"
HOOK="$AQUI/scripts/hooks/git-pre-commit-global.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ sql-compila: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ sql-compila: $1"; fallos=$((fallos+1)); }

# El doble de sqlcmd: anota argv y el archivo de entrada, y contesta según SQLCMD_FALSO_MODO.
cat > "$TMP/sqlcmd" <<'SH'
#!/usr/bin/env bash
dir="$(dirname "$0")"
printf '%s\n' "$*" >> "$dir/argv.log"
while [ $# -gt 0 ]; do
  if [ "$1" = "-i" ]; then cat "$2" >> "$dir/entrada.log"; printf '\n--fin--\n' >> "$dir/entrada.log"; fi
  shift
done
printf 'pass=%s\n' "${SQLCMDPASSWORD:-}" >> "$dir/env.log"
case "${SQLCMD_FALSO_MODO:-ok}" in
  error) echo "Msg 1046, Level 15, State 1, Server prueba, Line 4"; echo "Subqueries are not allowed in this context. Only scalar expressions are allowed."; exit 1 ;;
  login) echo "Msg 18456, Level 14, State 1, Server prueba, Line 1"; echo "Login failed for user 'lector'."; exit 1 ;;
  *) exit 0 ;;
esac
SH
chmod +x "$TMP/sqlcmd"

repo(){ # repo nuevo con un commit inicial; deja el cwd ahí
  rm -rf "$TMP/r" "$TMP/h" "$TMP"/argv.log "$TMP"/entrada.log "$TMP"/env.log
  mkdir -p "$TMP/r/database" "$TMP/h"
  cd "$TMP/r" || exit 9
  git init -q . && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
}
correr(){ # correr [env extra...] → salida en $TMP/o.txt, imprime rc
  env HOME="$TMP/h" TYCON_SQL_CMD="$TMP/sqlcmd" "$@" node "$SCRIPT" --staged --repo "$TMP/r" > "$TMP/o.txt" 2>&1
  echo $?
}
CONF=(TYCON_SQL_COMPILE_SERVER=prueba.local TYCON_SQL_COMPILE_DATABASE=Pruebas TYCON_SQL_COMPILE_USER=lector SQLCMDPASSWORD=clave-que-no-debe-aparecer)
salida(){ tr '\n' ' ' < "$TMP/o.txt"; }
llamadas(){ [ -f "$TMP/argv.log" ] && wc -l < "$TMP/argv.log" | tr -d ' ' || echo 0; }

# ── C1. sin base configurada: avisa que NO compiló, no dice que compila, no frena ──────────────
repo
printf 'PRINT (SELECT 1);\n' > database/054_limpieza.sql && git add database/054_limpieza.sql
rc=$(correr)
{ [ "$rc" -eq 0 ] && grep -q '054_limpieza.sql' "$TMP/o.txt" && grep -qi 'sin compilar' "$TMP/o.txt" \
  && grep -qi 'no hay base configurada' "$TMP/o.txt" && ! grep -qi ' compila ' "$TMP/o.txt" && [ "$(llamadas)" -eq 0 ]; } \
  && ok "C1: sin base configurada dice «sin compilar» con el motivo, sale 0 y no llama a sqlcmd" \
  || no "C1: rc=$rc llamadas=$(llamadas) · $(salida)"

# ── C2. con base: compila lo STAGEADO, con NOEXEC adelante y sin sustituir variables ────────
repo
printf 'PRINT 1;\nGO\n' > database/055_ok.sql && git add database/055_ok.sql
printf 'DELETE FROM Tabla; -- esto es el disco, no lo stageado\n' > database/055_ok.sql
rc=$(correr "${CONF[@]}")
{ [ "$rc" -eq 0 ] && grep -q '055_ok.sql compila' "$TMP/o.txt" \
  && [ "$(llamadas)" -eq 1 ] && head -1 "$TMP/entrada.log" | grep -qi '^SET NOEXEC ON' \
  && grep -q 'PRINT 1;' "$TMP/entrada.log" && ! grep -q 'DELETE FROM Tabla' "$TMP/entrada.log" \
  && grep -Eq '(^| )-b( |$)' "$TMP/argv.log" && grep -Eq '(^| )-x( |$)' "$TMP/argv.log" \
  && grep -q -- '-S prueba.local' "$TMP/argv.log" && grep -q -- '-d Pruebas' "$TMP/argv.log"; } \
  && ok "C2: 🔴 compila lo que se commitea (no el disco), con SET NOEXEC ON primero, -b y -x" \
  || no "C2: rc=$rc llamadas=$(llamadas) · $(salida) · argv=$(cat "$TMP/argv.log" 2>/dev/null) · entrada=$(head -3 "$TMP/entrada.log" 2>/dev/null | tr '\n' '|')"

# ── C3. el caso real: la subconsulta en un PRINT no compila — se nombra con el error, y no frena ─
repo
printf 'BEGIN TRAN;\nPRINT (SELECT COUNT(*) FROM Plugins);\nCOMMIT;\n' > database/054_limpieza.sql && git add database/054_limpieza.sql
rc=$(correr "${CONF[@]}" SQLCMD_FALSO_MODO=error)
{ [ "$rc" -eq 0 ] && grep -q '054_limpieza.sql' "$TMP/o.txt" && grep -qi 'NO compila' "$TMP/o.txt" && grep -q 'Msg 1046' "$TMP/o.txt"; } \
  && ok "C3: 🔴 una migración que no compila se nombra con el mensaje de SQL Server, y el commit sigue (aviso)" \
  || no "C3: rc=$rc · $(salida)"

# ── C3b. un login rechazado NO es «no compila»: es «sin compilar», con el motivo ────────────────
repo
printf 'PRINT 1;\n' > database/054_ok.sql && git add database/054_ok.sql
rc=$(correr "${CONF[@]}" SQLCMD_FALSO_MODO=login)
{ [ "$rc" -eq 0 ] && grep -qi 'sin compilar' "$TMP/o.txt" && grep -q '18456' "$TMP/o.txt" && ! grep -q 'NO compila' "$TMP/o.txt"; } \
  && ok "C3b: 🔴 si la base rechaza el login, la migración queda «sin compilar» y no se acusa de no compilar" \
  || no "C3b: rc=$rc · $(salida)"

# ── C4. una migración que apaga NOEXEC no se manda: compilarla podría ejecutarla ────────────────
repo
printf 'SET NOEXEC OFF;\nDELETE FROM Plugins;\n' > database/056_trampa.sql && git add database/056_trampa.sql
rc=$(correr "${CONF[@]}")
{ [ "$rc" -eq 0 ] && [ "$(llamadas)" -eq 0 ] && grep -q '056_trampa.sql' "$TMP/o.txt" && grep -qi 'NOEXEC' "$TMP/o.txt" && grep -qi 'sin compilar' "$TMP/o.txt"; } \
  && ok "C4: 🔴 un .sql que menciona NOEXEC no llega a la base, y queda «sin compilar» con el motivo" \
  || no "C4: rc=$rc llamadas=$(llamadas) · $(salida)"

# ── C5. comandos de sqlcmd (:r, !!) no se mandan: correrían del lado del cliente ────────────────
repo
printf ':r otra.sql\nPRINT 1;\n' > database/057_incluye.sql
printf 'PRINT 1;\n!! echo hola\n' > database/058_shell.sql
git add database/057_incluye.sql database/058_shell.sql
rc=$(correr "${CONF[@]}")
{ [ "$rc" -eq 0 ] && [ "$(llamadas)" -eq 0 ] && grep -q '057_incluye.sql' "$TMP/o.txt" && grep -q '058_shell.sql' "$TMP/o.txt" && grep -qi 'comandos de sqlcmd' "$TMP/o.txt"; } \
  && ok "C5: un .sql con :r o !! no se manda a sqlcmd, y se dice por qué" \
  || no "C5: rc=$rc llamadas=$(llamadas) · $(salida)"

# ── C6. sin migraciones en el commit: silencio total (no-regresión) ──────────────────────────────
repo
printf 'x\n' > app.js && git add app.js
printf 'SELECT 1;\n' > docs.sql && mkdir -p docs && printf 'SELECT 1;\n' > docs/ejemplo.sql && git add docs.sql docs/ejemplo.sql
rc=$(correr "${CONF[@]}")
{ [ "$rc" -eq 0 ] && [ ! -s "$TMP/o.txt" ] && [ "$(llamadas)" -eq 0 ]; } \
  && ok "C6: un commit sin migraciones (ni .sql fuera de database/) no dice nada ni llama a sqlcmd" \
  || no "C6: rc=$rc llamadas=$(llamadas) · «$(salida)»"

# ── C7. una migración BORRADA no se compila ──────────────────────────────────────────────────────
repo
# el commit con la HOME de juguete: con la real, el pre-commit global de la máquina corría sql-compile.js y anotaba esta
# migración de prueba en la carpeta de estado REAL (68 líneas desde el 2026-09-16; visto en la tanda D2 de la 8.9)
printf 'PRINT 1;\n' > database/050_vieja.sql && git add database/050_vieja.sql && HOME="$TMP/h" git -c user.email=t@t -c user.name=t commit -q -m vieja
git rm -q database/050_vieja.sql
rc=$(correr "${CONF[@]}")
{ [ "$rc" -eq 0 ] && [ ! -s "$TMP/o.txt" ] && [ "$(llamadas)" -eq 0 ]; } \
  && ok "C7: borrar una migración no dispara el aviso" \
  || no "C7: rc=$rc llamadas=$(llamadas) · «$(salida)»"

# ── C8. 🔴 la contraseña viaja por el ambiente, nunca por argv, la salida ni el registro ─────────
repo
printf 'PRINT 1;\n' > database/059_ok.sql && git add database/059_ok.sql
rc=$(correr "${CONF[@]}")
todo="$(cat "$TMP/o.txt" "$TMP/argv.log" 2>/dev/null; cat "$TMP/h/.claude/.tycon-pipeline/sql-compile.jsonl" 2>/dev/null)"
{ [ "$rc" -eq 0 ] && ! printf '%s' "$todo" | grep -q 'clave-que-no-debe-aparecer' && grep -q 'pass=clave-que-no-debe-aparecer' "$TMP/env.log"; } \
  && ok "C8: 🔴 la contraseña le llega a sqlcmd por SQLCMDPASSWORD y no aparece en argv, en la salida ni en el registro" \
  || no "C8: rc=$rc · argv=$(cat "$TMP/argv.log" 2>/dev/null)"

# ── C9. sin sqlcmd instalado: «sin compilar», no «compila» ───────────────────────────────────────
repo
printf 'PRINT 1;\n' > database/060_ok.sql && git add database/060_ok.sql
env HOME="$TMP/h" TYCON_SQL_CMD="$TMP/no-existe/sqlcmd" "${CONF[@]}" node "$SCRIPT" --staged --repo "$TMP/r" > "$TMP/o.txt" 2>&1; rc=$?
{ [ "$rc" -eq 0 ] && grep -qi 'sin compilar' "$TMP/o.txt" && grep -qi 'sqlcmd' "$TMP/o.txt" && ! grep -qi ' compila ' "$TMP/o.txt"; } \
  && ok "C9: sin sqlcmd la migración queda «sin compilar» con el motivo" \
  || no "C9: rc=$rc · $(salida)"

# ── C10. se mide: cada migración deja una línea con su resultado ─────────────────────────────────
repo
printf 'PRINT 1;\n' > database/061_ok.sql && printf 'PRINT (SELECT 1);\n' > database/bd-no.sql && git add database/061_ok.sql database/bd-no.sql
correr "${CONF[@]}" >/dev/null
reg="$TMP/h/.claude/.tycon-pipeline/sql-compile.jsonl"
{ [ -f "$reg" ] && node -e '
const ls = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
const ok = ls.length === 2 && ls.every((l) => l.ts && l.repo && l.archivo && ["compila", "no-compila", "sin-compilar"].includes(l.resultado));
process.exit(ok ? 0 : 1);' "$reg"; } \
  && ok "C10: cada migración deja su resultado en sql-compile.jsonl (lo que permite medir antes de decidir si frena)" \
  || no "C10: $(cat "$reg" 2>/dev/null)"

# ── C13. (story 8.9, tanda D2) el registro con nombre viejo pasa al nuevo sin perder su historia ───
# El nombre viejo sale del mapa de renombres (no se escribe literal). Con sólo el viejo, la primera
# medición lo copia al nuevo y anota ahí; el viejo queda intacto hasta el retiro.
# En la copia pública el mapa no viaja: sin nombre viejo no hay nada que migrar, el caso se saltea con motivo.
if [ ! -f "$AQUI/scripts/lib/renames.json" ]; then
  ok "C13: se saltea — copia pública, sin el mapa de renombres"
else
viejo="$(node -e 'const m=require(process.argv[1]);const e=m.entries.find(x=>x.batch==="D2"&&x.new.endsWith("/sql-compile.jsonl"));process.stdout.write(e?require("path").basename(e.old):"")' "$AQUI/scripts/lib/renames.json")"
repo
mkdir -p "$TMP/h/.claude/.tycon-pipeline"
[ -n "$viejo" ] && echo '{"ts":"2026-09-01T00:00:00Z","repo":"historia-vieja"}' > "$TMP/h/.claude/.tycon-pipeline/$viejo"
printf 'PRINT 1;\n' > database/064_ok.sql && git add database/064_ok.sql
correr "${CONF[@]}" >/dev/null
reg="$TMP/h/.claude/.tycon-pipeline/sql-compile.jsonl"
{ [ -n "$viejo" ] && grep -q 'historia-vieja' "$reg" 2>/dev/null && grep -q '064_ok.sql' "$reg" \
  && [ "$(wc -l < "$TMP/h/.claude/.tycon-pipeline/$viejo" | tr -d ' ')" = "1" ]; } \
  && ok "C13: el registro nuevo trae la historia del viejo y la medición nueva; el viejo queda intacto" \
  || no "C13: viejo=«${viejo}» · nuevo=$(cat "${reg}" 2>/dev/null)"
fi

# ── C11. apagado explícito: silencio ─────────────────────────────────────────────────────────────
repo
printf 'PRINT 1;\n' > database/062_ok.sql && git add database/062_ok.sql
rc=$(correr "${CONF[@]}" TYCON_SQL_COMPILE=0)
{ [ "$rc" -eq 0 ] && [ ! -s "$TMP/o.txt" ] && [ "$(llamadas)" -eq 0 ]; } \
  && ok "C11: TYCON_SQL_COMPILE=0 lo apaga" || no "C11: rc=$rc · «$(salida)»"

# ── C12. el pre-commit global lo corre, y el commit se hace igual ────────────────────────────────
repo
printf 'PRINT (SELECT 1);\n' > database/063_hook.sql && git add database/063_hook.sql
env HOME="$TMP/h" TYCON_GUIDES_DIR="$AQUI" TYCON_SQL_CMD="$TMP/sqlcmd" bash "$HOOK" > "$TMP/o.txt" 2>&1; rc=$?
{ [ "$rc" -eq 0 ] && grep -q '063_hook.sql' "$TMP/o.txt" && grep -qi 'sin compilar' "$TMP/o.txt"; } \
  && ok "C12: el pre-commit global de git corre el aviso y no rechaza el commit" \
  || no "C12: rc=$rc · $(salida)"

cd "$AQUI" || exit 9
echo
total=$((pasaron + fallos))
[ "$fallos" -eq 0 ] && { echo "✅ sql-compila: $pasaron/$total"; exit 0; } \
  || { echo "❌ sql-compila: $fallos fallo(s) de $total"; exit 1; }
