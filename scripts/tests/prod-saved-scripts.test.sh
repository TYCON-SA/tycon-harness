#!/usr/bin/env bash
# prod-saved-scripts.test.sh — el freno de producción mira adentro de lo que el comando corre y ya vivía en el disco.
#
# Caso que lo motiva: el freno miraba adentro sólo de un guion temporal o escrito por el mismo comando. Un guion guardado
# en el repo que leía la clave del Llavero (`bash scripts/leer.sh`, `./scripts/leer.sh`, `node scripts/leer.js`), un
# `npm run leer` o un `make leer` pasaban; y `bash scripts/consulta.sh`, que llamaba a la puerta, consultaba producción
# sin ningún cuadro, porque la regla de aprobación mira el texto del comando y ahí no aparecía la puerta.
#
# Lo que prueba:
#   T-puerta-4  — un guion que llama a la puerta: el freno sale 2; corrido sin el freno, la puerta pide el cuadro y sin
#                 respuesta no consulta
#   T-puerta-6  — `bash scripts/leer.sh` y `./scripts/leer.sh` salen 2 y el motivo nombra el archivo
#   T-puerta-7  — `node scripts/leer.js` y `python3 scripts/leer.py` salen 2
#   T-puerta-8  — `npm run`, `yarn run` y `pnpm run` salen 2 y el motivo nombra package.json y el script
#   T-puerta-9  — `make leer` sale 2; otro objetivo del mismo Makefile pasa
#   T-puerta-10 — `npm run` que corre un archivo: se mira ese archivo, y el segundo nivel no
#   T-puerta-11 — automatizar la pantalla (System Events con click, keystroke o key code; cliclick) sale 2;
#                 `display notification` pasa
#   T-puerta-26 — un guion más grande que el tope, uno sin permiso de lectura y un `npm run` sin ese script pasan y
#                 quedan en el registro como «no-mirado»
#   T-puerta-30 — un guion que nombra un llavero no declarado y las piezas del propio freno pasan
#
# 🔴 HOME falso y repos de juguete: nada toca el Llavero, la base ni /opt. Los nombres que el freno vivo frenaría se
#    arman al correr. Con /opt/tycon presente las costuras no existen y la suite se saltea; en una máquina con el freno
#    se corre con /opt/tycon escondido: sandbox-exec -f <perfil que niega leer /opt/tycon> bash <esta suite>
# Correr: bash scripts/tests/prod-saved-scripts.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$AQUI/scripts/hooks/prod-access-guard.js"
PUERTA_REPO="$AQUI/scripts/production/tycon-prod-sql"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ prod-saved: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ prod-saved: $1"; fallos=$((fallos+1)); }

if [ -d /opt/tycon ]; then
  echo "⏭ prod-saved: esta máquina tiene el freno instalado (/opt/tycon): sin costuras de prueba, esta suite corre en el nocturno."
  exit 0
fi

# los nombres, armados al correr
PROD="acme-sql.database.windows.net"
LLAVERO="tycon-prod-""acme"
NO_DECLARADO="tycon-prod-""prueba"
PUERTA="/opt/tycon/bin/tycon-prod-""sql"
SEC="secu""rity"

# ── el mundo: HOME falso, un repo con el catálogo y un repo de juguete con guiones guardados ──────
# 🔴 El repo de juguete NO va en una carpeta temporal: ahí el freno ya lee los guiones con el análisis de siempre y esta
# suite daría verde sin medir la capa de los guiones guardados. Va dentro de la copia del repo o, si la copia misma está
# en una carpeta temporal (el árbol armado para medir), en el HOME. Si no hay ninguna, no se mide.
es_temporal(){ case "$1" in /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*|*/scratchpad/*) return 0 ;; esac
  [ -n "${TMPDIR:-}" ] && case "$1" in "${TMPDIR%/}"/*) return 0 ;; esac; return 1; }
FUERA=""
for base in "$AQUI" "${HOME:-}"; do
  [ -n "$base" ] && [ -d "$base" ] && [ -w "$base" ] || continue
  base="$(cd "$base" && pwd -P)"
  es_temporal "$base/" && continue
  FUERA="$(mktemp -d "$base/.prod-saved-XXXXXX")" && break
done
if [ -z "$FUERA" ]; then
  echo "⏭ prod-saved: NO MEDIDO — no encontré una carpeta que el freno no tome por temporal (ni la copia del repo ni el HOME)."
  exit 3
fi
trap 'chmod -R u+r "$TMP" "$FUERA" 2>/dev/null; rm -rf "$TMP" "$FUERA"' EXIT
CASA="$TMP/casa"; REPOS="$TMP/repos"; JUG="$FUERA/juguete"
mkdir -p "$CASA/.claude/.tycon-pipeline" "$REPOS/backend-acme/.tycon" "$JUG/scripts" "$JUG/sub/dir"
( cd "$REPOS/backend-acme" && git init -q . ) >/dev/null 2>&1
printf '{"servers":[{"host":"%s","environment":"produccion","keychain":"%s"}]}\n' "$PROD" "$LLAVERO" > "$REPOS/backend-acme/.tycon/production.json"

LEE_CLAVE="/usr/bin/$SEC find-generic-password -s $LLAVERO -w"
printf '#!/usr/bin/env bash\n%s\n' "$LEE_CLAVE" > "$JUG/scripts/leer.sh"; chmod +x "$JUG/scripts/leer.sh"
printf "require('child_process').execFileSync('/usr/bin/%s', ['find-generic-password', '-s', '%s', '-w']);\n" "$SEC" "$LLAVERO" > "$JUG/scripts/leer.js"
printf "import subprocess\nsubprocess.run(['/usr/bin/%s', 'find-generic-password', '-s', '%s', '-w'])\n" "$SEC" "$LLAVERO" > "$JUG/scripts/leer.py"
printf "#!/usr/bin/env bash\n%s %s 'select 1'\n" "$PUERTA" "$PROD" > "$JUG/scripts/consulta.sh"; chmod +x "$JUG/scripts/consulta.sh"
printf '#!/usr/bin/env bash\n/usr/bin/%s find-generic-password -s %s -w\n' "$SEC" "$NO_DECLARADO" > "$JUG/scripts/no-declarado.sh"
# el segundo nivel: x2.js corre y2.sh, que es el que nombra el llavero
printf "require('child_process').execFileSync('bash', ['scripts/y2.sh']);\n" > "$JUG/scripts/x2.js"
cp "$JUG/scripts/leer.sh" "$JUG/scripts/y2.sh"
cat > "$JUG/package.json" <<JSON
{"name":"juguete","scripts":{"leer":"$LEE_CLAVE","x":"node scripts/leer.js","x2":"node scripts/x2.js","build":"echo armando"}}
JSON
printf 'leer:\n\t@%s\n\ncompilar:\n\techo compilando\n\ndelega: ayuda\n\techo listo\n\nayuda:\n\t-%s\n' "$LEE_CLAVE" "$LEE_CLAVE" > "$JUG/Makefile"
# lo que no se puede mirar: más grande que el tope (64 KB) y sin permiso de lectura
{ printf '#!/usr/bin/env bash\n%s\n' "$LEE_CLAVE"; head -c 70000 /dev/zero | tr '\0' '#'; printf '\n'; } > "$JUG/scripts/grande.sh"
cp "$JUG/scripts/leer.sh" "$JUG/scripts/cerrado.sh"; chmod 000 "$JUG/scripts/cerrado.sh"

REGISTRO="$CASA/.claude/.tycon-pipeline/production.log"
corre(){ # $1 = comando, corrido desde el repo de juguete; imprime el exit code
  local payload; payload="$(CMD="$1" CWD="$JUG" node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",hook_event_name:"PreToolUse",cwd:process.env.CWD,tool_input:{command:process.env.CMD}}))')"
  printf '%s' "$payload" | ( cd "$JUG" && env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" TYCON_PROD_SESSION_SINCE=0 node "$HOOK" ) >"$TMP/out" 2>"$TMP/err"
  echo $?
}
frena(){ # $1 = etiqueta, $2 = comando, $3 = lo que tiene que nombrar el motivo
  local rc; rc="$(corre "$2")"
  if [ "$rc" = 2 ] && grep -qF -- "$3" "$TMP/err"; then ok "$1"
  else no "$1 (rc=$rc, esperaba 2 nombrando «$3») — $(head -c 200 "$TMP/err" | tr '\n' ' ')"; fi
}
pasa(){
  local rc; rc="$(corre "$2")"
  if [ "$rc" = 0 ]; then ok "$1"; else no "$1 (rc=$rc, esperaba 0) — $(head -c 200 "$TMP/err" | tr '\n' ' ')"; fi
}

# ── T-puerta-6 · guiones guardados que leen la clave, por bash y por ruta ──────────────────────
frena "T-puerta-6 Freno_GuionGuardado_BashYRuta · bash scripts/leer.sh" "bash scripts/leer.sh" "scripts/leer.sh"
frena "T-puerta-6 Freno_GuionGuardado_BashYRuta · ./scripts/leer.sh" "./scripts/leer.sh" "scripts/leer.sh"
frena "T-puerta-6 Freno_GuionGuardado_BashYRuta · el motivo nombra el llavero" "bash scripts/leer.sh" "$LLAVERO"
frena "T-puerta-6 Freno_GuionGuardado_BashYRuta · scripts/leer.sh corrido como programa (sin ./)" "scripts/leer.sh" "scripts/leer.sh"
frena "T-puerta-6 Freno_GuionGuardado_BashYRuta · ../juguete/scripts/leer.sh" "../juguete/scripts/leer.sh" "scripts/leer.sh"
frena "T-puerta-6 Freno_GuionGuardado_BashYRuta · cd scripts && bash leer.sh (sigue el cd)" "cd scripts && bash leer.sh" "scripts/leer.sh"
frena "T-puerta-6 Freno_GuionGuardado_BashYRuta · desde otra carpeta, con la ruta absoluta" "cd / && bash $JUG/scripts/leer.sh" "scripts/leer.sh"

# ── T-puerta-7 · node y python ──────────────────────────────────────────────────────────────────
frena "T-puerta-7 Freno_GuionGuardado_NodeYPython · node scripts/leer.js" "node scripts/leer.js" "scripts/leer.js"
frena "T-puerta-7 Freno_GuionGuardado_NodeYPython · python3 scripts/leer.py" "python3 scripts/leer.py" "scripts/leer.py"

# ── T-puerta-4 · un guion que llama a la puerta (sonda p10) ─────────────────────────────────────
frena "T-puerta-4 Sonda_p10_GuionLlamaALaPuerta_PideCuadro · el freno lo frena" "bash scripts/consulta.sh" "llama a la puerta"
# corrido SIN el freno (como lo haría otro asistente o un hook propio): la puerta pide el cuadro, y sin respuesta no
# lee la clave ni llama al cliente
RAIZ="$TMP/sys"; mkdir -p "$RAIZ/usr/bin" "$RAIZ/bin" "$RAIZ/opt/tycon/bin"
printf '#!/usr/bin/env bash\nprintf "security %%s\\n" "$*" >> "%s/orden.log"\nexit 0\n' "$TMP" > "$RAIZ/usr/bin/security"
printf '#!/usr/bin/env bash\nprintf "sqlcmd %%s\\n" "$*" >> "%s/orden.log"\nexit 0\n' "$TMP" > "$RAIZ/opt/tycon/bin/sqlcmd"
printf '#!/usr/bin/env bash\nprintf "cuadro\\n" >> "%s/orden.log"\nexit 1\n' "$TMP" > "$RAIZ/usr/bin/osascript"
printf '#!/usr/bin/env bash\necho Aqua\n' > "$RAIZ/bin/launchctl"
chmod +x "$RAIZ/usr/bin/security" "$RAIZ/opt/tycon/bin/sqlcmd" "$RAIZ/usr/bin/osascript" "$RAIZ/bin/launchctl"
sed "s|$PUERTA|bash $PUERTA_REPO|" "$JUG/scripts/consulta.sh" > "$TMP/consulta-repo.sh"
( cd "$JUG" && env -i HOME="$CASA" PATH=/usr/bin:/bin TYCON_PROD_TEST_PATH="$(dirname "$(command -v node)")" TYCON_PROD_ROOT="$RAIZ" TYCON_REPOS_ROOT="$REPOS" bash "$TMP/consulta-repo.sh" ) >"$TMP/out4" 2>&1
rc=$?
if [ "$rc" = 2 ] && [ "$(head -1 "$TMP/orden.log" 2>/dev/null)" = cuadro ] && ! grep -q '^security\|^sqlcmd' "$TMP/orden.log"; then
  ok "T-puerta-4 Sonda_p10_GuionLlamaALaPuerta_PideCuadro · sin el freno, la puerta pide el cuadro y sin respuesta no consulta"
else no "T-puerta-4 Sonda_p10_GuionLlamaALaPuerta_PideCuadro · rc=$rc · orden: $(tr '\n' ' ' < "$TMP/orden.log" 2>/dev/null) · $(head -c 200 "$TMP/out4")"; fi

# ── T-puerta-8 · npm, yarn y pnpm (sonda p05) ───────────────────────────────────────────────────
for g in npm yarn pnpm; do
  frena "T-puerta-8 Freno_NpmYarnPnpmRun · $g run leer" "$g run leer" "package.json (script «leer»)"
done
frena "T-puerta-8 Freno_NpmYarnPnpmRun · npm --prefix con la carpeta" "npm --prefix $JUG run leer" "package.json (script «leer»)"
frena "T-puerta-8 Freno_NpmYarnPnpmRun · npm run leer desde una subcarpeta del paquete" "cd sub/dir && npm run leer" "package.json (script «leer»)"
pasa "T-puerta-8 Freno_NpmYarnPnpmRun · npm run build (no nombra nada) pasa" "npm run build"

# ── T-puerta-9 · make (sonda p06) ───────────────────────────────────────────────────────────────
frena "T-puerta-9 Freno_Make · make leer" "make leer" "Makefile (objetivo «leer»)"
frena "T-puerta-9 Freno_Make · make sin objetivo corre el primero" "make" "Makefile (objetivo «leer»)"
frena "T-puerta-9 Freno_Make · make delega: el prerrequisito nombra el llavero" "make delega" "Makefile (objetivo «ayuda»)"
pasa "T-puerta-9 Freno_Make · make compilar (no nombra nada) pasa" "make compilar"

# ── T-puerta-10 · un nivel más, y no dos ────────────────────────────────────────────────────────
frena "T-puerta-10 Freno_NpmRunQueCorreUnArchivo_MiraUnNivel · npm run x → node scripts/leer.js" "npm run x" "scripts/leer.js"
pasa "T-puerta-10 Freno_NpmRunQueCorreUnArchivo_MiraUnNivel · el segundo nivel no se mira" "npm run x2"

# ── T-puerta-11 · automatizar la pantalla ───────────────────────────────────────────────────────
SE="System ""Events"
frena "T-puerta-11 Freno_AutomatizarLaPantalla · click" "osascript -e 'tell application \"$SE\" to click button \"Aprobar\" of window 1 of process \"osascript\"'" "pantalla"
frena "T-puerta-11 Freno_AutomatizarLaPantalla · keystroke" "osascript -e 'tell application \"$SE\" to keystroke return'" "pantalla"
frena "T-puerta-11 Freno_AutomatizarLaPantalla · key code" "osascript -e 'tell application \"$SE\" to key code 36'" "pantalla"
frena "T-puerta-11 Freno_AutomatizarLaPantalla · cliclick" "cliclick c:500,400" "pantalla"
pasa "T-puerta-11 Freno_AutomatizarLaPantalla · display notification pasa" "osascript -e 'display notification \"listo\"'"

# ── T-puerta-26 · lo que no se puede mirar pasa y queda anotado ─────────────────────────────────
: > "$REGISTRO"
pasa "T-puerta-26 Freno_GuionIlegibleOGrande_NoSeMiraYSeAnota · guion de más de 64 KB" "bash scripts/grande.sh"
pasa "T-puerta-26 Freno_GuionIlegibleOGrande_NoSeMiraYSeAnota · guion sin permiso de lectura" "bash scripts/cerrado.sh"
pasa "T-puerta-26 Freno_GuionIlegibleOGrande_NoSeMiraYSeAnota · npm run sin ese script" "npm run no-existe"
# una opción larga de make que el freno no sabe leer puede cambiar qué archivo corre: se dice que no se miró
OPCION_RARA="--make""file=otro.mk"
pasa "T-puerta-26 Freno_GuionIlegibleOGrande_NoSeMiraYSeAnota · make con una opción que no sabe leer" "make $OPCION_RARA compilar"
n="$(grep -c '"tipo":"no-mirado"' "$REGISTRO" 2>/dev/null)"
if [ "${n:-0}" = 4 ] && grep -q 'grande.sh' "$REGISTRO" && grep -q 'cerrado.sh' "$REGISTRO" && grep -q 'no-existe' "$REGISTRO" && grep -q 'opción que no sé leer' "$REGISTRO" && ! grep -q '"bloqueo"' "$REGISTRO"; then
  ok "T-puerta-26 Freno_GuionIlegibleOGrande_NoSeMiraYSeAnota · los cuatro quedan como «no-mirado», ninguno como bloqueo"
else no "T-puerta-26 Freno_GuionIlegibleOGrande_NoSeMiraYSeAnota · el registro: $(tr '\n' ' ' < "$REGISTRO" | head -c 400)"; fi

# ── T-puerta-30 · lo no declarado y las piezas del freno pasan ──────────────────────────────────
pasa "T-puerta-30 Freno_NombresNoDeclaradosYPiezasDelFreno_Pasan · un llavero no declarado" "bash scripts/no-declarado.sh"
pasa "T-puerta-30 Freno_NombresNoDeclaradosYPiezasDelFreno_Pasan · node scripts/hooks/prod-access-guard.js" "node $HOOK"
pasa "T-puerta-30 Freno_NombresNoDeclaradosYPiezasDelFreno_Pasan · un programa compilado por ruta no es un guion" "/bin/ls -la"

echo "— prod-saved: $pasaron ok, $fallos fallos —"
[ "$fallos" -eq 0 ]
