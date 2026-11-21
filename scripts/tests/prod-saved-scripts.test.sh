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
OTRO_PROD="base-acme.interna.example"
printf '{"servers":[{"host":"%s","environment":"produccion","keychain":"%s"},{"host":"%s","environment":"produccion","keychain":"%s"}]}\n' "$PROD" "$LLAVERO" "$OTRO_PROD" "$LLAVERO" > "$REPOS/backend-acme/.tycon/production.json"

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
{"name":"juguete","scripts":{"leer":"$LEE_CLAVE","x":"node scripts/leer.js","x2":"node scripts/x2.js","build":"echo armando",
 "xruta":"scripts/leer.sh","xarriba":"../juguete/scripts/leer.sh","xcd":"cd scripts && node leer.js","xcds":"cd scripts && ./leer.sh",
 "xsolo":"node scripts/solo","xenv":"/usr/bin/env bash scripts/leer.sh"}}
JSON
# lo que el intérprete resuelve solo, y los archivos que llegan por otro lado
mkdir -p "$JUG/lib" "$JUG/app" "$JUG/con espacio" "$JUG/inst"
cp "$JUG/scripts/leer.js" "$JUG/scripts/solo.js"; cp "$JUG/scripts/leer.js" "$JUG/lib/index.js"; cp "$JUG/scripts/leer.py" "$JUG/app/__main__.py"
cp "$JUG/scripts/leer.sh" "$JUG/scripts/pelado"; cp "$JUG/scripts/leer.sh" "$JUG/con espacio/leer.sh"
printf '{"name":"inst","scripts":{"postinstall":"%s"}}\n' "$LEE_CLAVE" > "$JUG/inst/package.json"
printf '#!/usr/bin/env bash\n# \0\n%s\n' "$LEE_CLAVE" > "$JUG/scripts/nul.sh"
printf '#!/usr/bin/env bash\n/usr/bin/%s find-generic-password -s%s -w\n' "$SEC" "$LLAVERO" > "$JUG/scripts/pegado.sh"
printf '#!/usr/bin/env bash\nconectar %s\n' "$OTRO_PROD" > "$JUG/scripts/host.sh"
# la puerta dentro de otras formas, y lo que la nombra sin correrla
printf '#!/usr/bin/env bash\nX="$(%s %s q)"\n' "$PUERTA" "$PROD" > "$JUG/scripts/p-sub.sh"
printf '#!/usr/bin/env bash\neval "%s %s q"\n' "$PUERTA" "$PROD" > "$JUG/scripts/p-eval.sh"
printf '#!/usr/bin/env bash\n/usr/bin/env %s %s q\n' "$PUERTA" "$PROD" > "$JUG/scripts/p-env.sh"
printf '#!/usr/bin/env bash\nP=%s\n' "$PUERTA" > "$JUG/scripts/asigna.sh"
printf '#!/usr/bin/env bash\ncase "$1" in\n  %s) echo si ;;\n  %s|otro) echo si ;;\nesac\n' "${PUERTA##*/}" "${PUERTA##*/}" > "$JUG/scripts/caso.sh"
printf '#!/usr/bin/env bash\nA=(\n%s\notro\n)\n' "$PUERTA" > "$JUG/scripts/arreglo.sh"
printf '#!/usr/bin/env node\nconsole.log(`ayuda:\n%s\n`);\n' "$PUERTA" > "$JUG/scripts/doc.js"; chmod +x "$JUG/scripts/doc.js"
printf 'tell application "System Events" to click button 1 of window 1 of process "osascript"\n' > "$JUG/scripts/p.applescript"
# Makefiles con lo que make sí corre aunque no esté escrito en la receta del objetivo
mk(){ mkdir -p "$JUG/mk/$1"; printf '%b' "$2" > "$JUG/mk/$1/Makefile"; }
mk cond "cond:\nifeq (\$(X),)\n\t$LEE_CLAVE\nendif\n"
mk defecto ".DEFAULT_GOAL := leer\notro:\n\techo otro\nleer:\n\t$LEE_CLAVE\n"
mk define "define R\n$LEE_CLAVE\nendef\nleer:\n\t\$(R)\n"
mk vars "K := $LLAVERO\nS := /usr/bin/$SEC\nP := $PUERTA\nvar:\n\t\$(S) find-generic-password -s \$(K) -w\nvarp:\n\t\$(P) $PROD q\n"
mk shell "X := \$(shell $LEE_CLAVE)\nnada:\n\t@true\n"
mk sub "arriba:\n\t\$(MAKE) leer\nleer:\n\t$LEE_CLAVE\n"
mk comenta "a: # leer es sólo una palabra\n\techo a\nb: X=leer\nleer:\n\t$LEE_CLAVE\n"
mk prereq "D := leer\narriba: \$(D)\n\techo listo\nleer:\n\t$LEE_CLAVE\n"
{ printf 'todo:'; for i in $(seq 1 210); do printf ' o%s' "$i"; done; printf '\n\techo fin\n'; } > "$JUG/mk/muchos.mk"
printf 'leer:\n\t%s\n' "$LEE_CLAVE" > "$JUG/mk/a.mk"; printf 'otro:\n\techo otro\n' > "$JUG/mk/b.mk"
# lo que corre al leer el Makefile, esté donde esté
mk sh-cond "ifeq (\$(shell $LEE_CLAVE),x)\nendif\nnada:\n\t@true\n"
mk sh-dep "nada: \$(shell $LEE_CLAVE)\n\t@true\n"
mk sh-inc "include \$(shell $LEE_CLAVE)\nnada:\n\t@true\n"
mk sh-igual "X != $LEE_CLAVE\nnada:\n\t@true\n"
mk sh-llave "X := \${shell $LEE_CLAVE}\nnada:\n\t@true\n"
mk sh-define "define D\n\$(shell $LEE_CLAVE)\nendef\n\$(eval \$(D))\nnada:\n\t@true\n"
mk sh-suelto "\$(shell $LEE_CLAVE)\nnada:\n\t@true\n"
mk sh-calculado "S := shell\nX := \$(\$(S) $LEE_CLAVE)\nnada:\n\t@true\n"
mk sh-incluido "include gen.mk\ngen.mk:\n\t$LEE_CLAVE\nnada:\n\t@true\n"
mk sh-rehace "Makefile:\n\t$LEE_CLAVE\nnada:\n\t@true\n"
mk sh-opaco "X := \$(\$(NO_DEFINIDA) true)\nnada:\n\t@true\n"
mk sh-call "X := \$(call shell,$LEE_CLAVE)\nnada:\n\t@true\n"
mk sh-call-llave "X := \${call shell,$LEE_CLAVE}\nnada:\n\t@true\n"
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

# ── T-puerta-35 · el guion se encuentra aunque llegue por otro camino ───────────────────────────
Q=scripts/leer
for c in "bash -c 'bash $Q.sh'" "sh -c \"node $Q.js\"" "eval 'bash $Q.sh'" "eval bash $Q.sh" "bash -c 'npm run leer'" "bash -c 'make leer'" \
         "/usr/bin/env bash $Q.sh" "/usr/bin/env node $Q.js" "/usr/bin/nohup bash $Q.sh" "caffeinate -i bash $Q.sh" "arch -arm64 bash $Q.sh" "xargs bash $Q.sh" \
         "python3.12 $Q.py" "node scripts/solo" "node ./scripts/solo" "node lib" "python3 app" "python3 -m scripts.leer" "cd scripts && bash pelado" \
         "bash con\\ espacio/leer.sh" "node --require ./lib/index.js $Q.js" "bash --rcfile /dev/null $Q.sh" \
         "(cd /) ; bash $Q.sh" "cd /no-existe || true; bash $Q.sh" "cd / | cat; bash $Q.sh" "cd - ; bash $Q.sh" \
         "cat $Q.sh | bash" "cat $Q.sh | sh -s" "bash <(cat $Q.sh)" "eval \"\$(cat $Q.sh)\"" \
         "npm run xruta" "npm run xarriba" "npm run xcd" "npm run xcds" "npm run xsolo" "npm run xenv" \
         "bash scripts/nul.sh" "bash scripts/pegado.sh" "bash scripts/host.sh" \
         "bash \"\$PWD/$Q.sh\"" "bash \"\$(pwd)/$Q.sh\"" "bun $Q.js" "eval ./$Q.sh" "bash --rcfile ./lib/index.js $Q.sh" "cd scripts; cd -; bash $Q.sh"; do
  frena "T-puerta-35 Freno_GuionPorOtroCamino · $c" "$c" "y este comando lo corre"
done
frena "T-puerta-35 Freno_GuionPorOtroCamino · heredoc que alimenta un shell" "bash <<'FIN'
bash $Q.sh
FIN" "scripts/leer.sh"
printf "#!/usr/bin/env bash\nbash <<'FIN'\n%s %s q\nFIN\n" "$PUERTA" "$PROD" > "$JUG/scripts/p-heredoc.sh"
printf "#!/usr/bin/env bash\ncat <<'FIN'\n%s <host> q\nFIN\n" "$PUERTA" > "$JUG/scripts/p-texto.sh"
pasa "T-puerta-38 Freno_NombrarNoEsCorrer · un heredoc que sólo se imprime" "bash scripts/p-texto.sh"
for g in p-sub p-eval p-env p-heredoc; do frena "T-puerta-35 Freno_GuionPorOtroCamino · la puerta en $g" "bash scripts/$g.sh" "llama a la puerta"; done

# ── T-puerta-36 · make: lo que corre aunque no esté escrito en la receta ────────────────────────
for c in "make -C mk/cond cond" "make -C mk/defecto" "make -C mk/define leer" "make -C mk/vars var" "make -C mk/vars varp" "make -C mk/shell" "make -C mk/sub" "make -C mk/prereq" \
         "make -j 4" "make -j4" "make --jobs 4" "make -l 2" "make -f mk/b.mk -f mk/a.mk leer" "make -C mk/comenta leer"; do
  frena "T-puerta-36 Freno_MakeComoLoLeeMake · $c" "$c" "y este comando lo corre"
done
: > "$REGISTRO"
pasa "T-puerta-38 Freno_NombrarNoEsCorrer · una función de nombre calculado que no se resuelve pasa" "make -C mk/sh-opaco nada"
if grep -q 'nombre calculado' "$REGISTRO"; then ok "T-puerta-38 Freno_NombrarNoEsCorrer · y queda como «no-mirado»"
else no "T-puerta-38 Freno_NombrarNoEsCorrer · nombre calculado sin anotar: $(head -c 200 "$REGISTRO")"; fi
for d in sh-cond sh-dep sh-inc sh-igual sh-llave sh-define sh-suelto sh-calculado sh-incluido sh-rehace sh-call sh-call-llave; do
  frena "T-puerta-36 Freno_MakeComoLoLeeMake · lo que corre al leerlo: $d" "make -C mk/$d nada" "y este comando lo corre"
done
frena "T-puerta-36 Freno_MakeComoLoLeeMake · make -n igual lee el archivo" "make -n -C mk/sh-cond nada" "y este comando lo corre"
pasa "T-puerta-36 Freno_MakeComoLoLeeMake · make -n no corre la receta" "make -n leer"
pasa "T-puerta-36 Freno_MakeComoLoLeeMake · un comentario después de los «:» no es un prerrequisito" "make -C mk/comenta a"

# ── T-puerta-37 · npm, yarn, pnpm y bun: las opciones y lo que corre al instalar ────────────────
for c in "npm --registry local run leer" "npm --registry=local run leer" "npm run --silent leer" "npm run -- leer" "npm -- run leer" "npm -w otro run leer" "pnpm -F otro leer" "pnpm --filter otro run leer" "yarn workspace otro leer" "bun run leer" \
         "npm --prefix inst install" "cd inst && npm i" "cd inst && npm ci" "cd inst && yarn" "cd inst && pnpm install"; do
  frena "T-puerta-37 Freno_GestoresConOpciones · $c" "$c" "y este comando lo corre"
done
pasa "T-puerta-37 Freno_GestoresConOpciones · npm view no corre scripts" "npm view leer"

# ── T-puerta-38 · nombrar la puerta sin correrla no frena; lo que no se puede leer queda anotado ──
for g in asigna caso arreglo; do pasa "T-puerta-38 Freno_NombrarNoEsCorrer · $g" "bash scripts/$g.sh"; done
pasa "T-puerta-38 Freno_NombrarNoEsCorrer · un programa de node corrido por su ruta" "./scripts/doc.js"
: > "$REGISTRO"
pasa "T-puerta-38 Freno_NombrarNoEsCorrer · una ruta con variable pasa" 'bash "$DIR/leer.sh"'
pasa "T-puerta-38 Freno_NombrarNoEsCorrer · tras un cd que no se lee, lo que no se encuentra pasa" 'cd "$DIR" && bash nada.sh'
n="$(grep -c '"tipo":"no-mirado"' "$REGISTRO" 2>/dev/null)"
if [ "${n:-0}" = 2 ]; then ok "T-puerta-38 Freno_NombrarNoEsCorrer · las dos quedan como «no-mirado»"
else no "T-puerta-38 Freno_NombrarNoEsCorrer · el registro: $(tr '\n' ' ' < "$REGISTRO" | head -c 300)"; fi
: > "$REGISTRO"
cp "$JUG/scripts/leer.sh" "$TMP/cerrado-temporal.sh"; chmod 000 "$TMP/cerrado-temporal.sh"
pasa "T-puerta-38 Freno_NombrarNoEsCorrer · un guion temporal sin permiso de lectura pasa" "bash $TMP/cerrado-temporal.sh"
if grep -q 'cerrado-temporal' "$REGISTRO" && grep -q 'sin permiso de lectura' "$REGISTRO"; then ok "T-puerta-38 Freno_NombrarNoEsCorrer · y queda como «no-mirado»"
else no "T-puerta-38 Freno_NombrarNoEsCorrer · sin anotar: $(head -c 200 "$REGISTRO")"; fi
: > "$REGISTRO"
muchos=""; for i in $(seq 1 40); do cp "$JUG/scripts/no-declarado.sh" "$JUG/scripts/m$i.sh"; muchos="$muchos bash scripts/m$i.sh;"; done
pasa "T-puerta-38 Freno_NombrarNoEsCorrer · un comando con más guiones de los que se leen pasa" "$muchos"
if grep -q 'alcanzo a leer' "$REGISTRO"; then ok "T-puerta-38 Freno_NombrarNoEsCorrer · y dice que no los leyó todos"
else no "T-puerta-38 Freno_NombrarNoEsCorrer · sin anotar: $(head -c 200 "$REGISTRO")"; fi
: > "$REGISTRO"
pasa "T-puerta-38 Freno_NombrarNoEsCorrer · un Makefile con más objetivos de los que se siguen pasa" "make -f mk/muchos.mk todo"
if grep -q 'alcanzo a seguir' "$REGISTRO"; then ok "T-puerta-38 Freno_NombrarNoEsCorrer · y dice que no los siguió todos"
else no "T-puerta-38 Freno_NombrarNoEsCorrer · sin anotar: $(head -c 200 "$REGISTRO")"; fi
# con un catálogo ilegible no se sabe qué está declarado: pasa, y queda dicho que no se miró
CASA_BIEN="$CASA"; REPOS_BIEN="$REPOS"; REGISTRO_BIEN="$REGISTRO"
CASA="$TMP/casa-rota"; REPOS="$TMP/repos-rotos"; REGISTRO="$CASA/.claude/.tycon-pipeline/production.log"
mkdir -p "$CASA/.claude/.tycon-pipeline" "$REPOS/backend-acme/.tycon"; ( cd "$REPOS/backend-acme" && git init -q . ) >/dev/null 2>&1
printf '{ roto' > "$REPOS/backend-acme/.tycon/production.json"
pasa "T-puerta-38 Freno_NombrarNoEsCorrer · con el catálogo ilegible pasa" "bash scripts/leer.sh"
if grep -q 'no se pudieron leer' "$REGISTRO"; then ok "T-puerta-38 Freno_NombrarNoEsCorrer · y dice que no miró lo declarado"
else no "T-puerta-38 Freno_NombrarNoEsCorrer · sin anotar: $(head -c 200 "$REGISTRO" 2>/dev/null)"; fi
CASA="$CASA_BIEN"; REPOS="$REPOS_BIEN"; REGISTRO="$REGISTRO_BIEN"
# lo que podría colgar al freno: una variable de Makefile referida miles de veces, y un FIFO donde iría un package.json
{ printf 'V := %s\n' "$(head -c 2000 /dev/zero | tr '\0' 'x')"; printf 'bomba:\n\t@echo'; for i in $(seq 1 6000); do printf ' $(V)'; done; printf '\n'; } > "$JUG/mk/bomba.mk"
mkdir -p "$JUG/fifo"; mkfifo "$JUG/fifo/package.json"
head -c 60000 /dev/zero | tr '\0' '#' > "$JUG/mk/relleno.mk"
{ for i in $(seq 1 2500); do printf 'include mk/relleno.mk\n'; done; printf 'nada:\n\t@true\n'; } > "$JUG/mk/incluye.mk"
for c in "make -f mk/bomba.mk bomba" "make -f mk/incluye.mk nada" "node fifo"; do
  t0="$(node -e 'console.log(Date.now())')"; rc="$(corre "$c")"; ms=$(( $(node -e 'console.log(Date.now())') - t0 ))
  if [ "$rc" = 0 ] && [ "$ms" -lt 5000 ]; then ok "T-puerta-38 Freno_NombrarNoEsCorrer · «${c}» no cuelga al freno"
  else no "T-puerta-38 Freno_NombrarNoEsCorrer · «${c}»: rc=$rc en $ms ms"; fi
done
# el mismo archivo incluido miles de veces se lee una sola: no llega al tope de lo que se lee
if ! grep -q 'incluye más' "$REGISTRO"; then ok "T-puerta-38 Freno_NombrarNoEsCorrer · un include repetido se lee una vez"
else no "T-puerta-38 Freno_NombrarNoEsCorrer · include repetido: $(grep 'incluye más' "$REGISTRO" | head -c 200)"; fi
# un include dentro de otro se sigue; lo que pasa de los topes queda dicho
printf 'include mk/in2.mk\n' > "$JUG/mk/in1.mk"; printf 'leer:\n\t%s\n' "$LEE_CLAVE" > "$JUG/mk/in2.mk"; printf 'include mk/in1.mk\n' > "$JUG/mk/anidado.mk"
frena "T-puerta-36 Freno_MakeComoLoLeeMake · un include dentro de otro" "make -f mk/anidado.mk leer" "y este comando lo corre"
{ for i in $(seq 1 9); do printf 'nada%s:\n\t@true\n' "$i" > "$JUG/mk/n$i.mk"; printf 'include mk/n%s.mk\n' "$i"; done; printf 'nada:\n\t@true\n'; } > "$JUG/mk/nueve.mk"
{ for i in $(seq 1 300); do printf 'include mk/falta%s.mk\n' "$i"; done; printf 'nada:\n\t@true\n'; } > "$JUG/mk/trescientos.mk"
{ for i in $(seq 1 20); do printf 'X%s := $(shell true)\n' "$i"; done; printf 'nada:\n\t@true\n'; } > "$JUG/mk/veinte.mk"
for caso in "nueve:incluye más archivos" "trescientos:incluye más archivos" "veinte:alcanzo a mirar"; do
  : > "$REGISTRO"; pasa "T-puerta-38 Freno_NombrarNoEsCorrer · ${caso%%:*} pasa" "make -f mk/${caso%%:*}.mk nada"
  if grep -q "${caso#*:}" "$REGISTRO"; then ok "T-puerta-38 Freno_NombrarNoEsCorrer · ${caso%%:*} queda como «no-mirado»"
  else no "T-puerta-38 Freno_NombrarNoEsCorrer · ${caso%%:*}: sin anotar: $(head -c 200 "$REGISTRO")"; fi
done
: > "$REGISTRO"
{ printf 'R := %s\nC := %s\nleer:\n\t@echo $(R) $(R) $(C)\n' "$(head -c 32740 /dev/zero | tr '\0' 'x')" "$LEE_CLAVE"; } > "$JUG/mk/esconde.mk"
pasa "T-puerta-38 Freno_NombrarNoEsCorrer · una variable que no entra en el tope pasa" "make -f mk/esconde.mk leer"
if grep -q 'alcanzo a expandir' "$REGISTRO"; then ok "T-puerta-38 Freno_NombrarNoEsCorrer · y dice que no la expandió"
else no "T-puerta-38 Freno_NombrarNoEsCorrer · sin anotar: $(head -c 200 "$REGISTRO")"; fi
repetido=""; for i in $(seq 1 400); do repetido="$repetido bash scripts/grande.sh;"; done
t0="$(node -e 'console.log(Date.now())')"; rc="$(corre "$repetido")"; ms=$(( $(node -e 'console.log(Date.now())') - t0 ))
if [ "$rc" = 0 ] && [ "$ms" -lt 5000 ]; then ok "T-puerta-38 Freno_NombrarNoEsCorrer · repetir un guion no gasta el reloj"
else no "T-puerta-38 Freno_NombrarNoEsCorrer · rc=$rc en $ms ms"; fi

# ── T-puerta-39 · apretar la pantalla, y leerla sin apretar nada ─────────────────────────────────
for accion in 'perform action "AXPress" of button 1 of window 1 of process "osascript"' 'key down return'; do
  frena "T-puerta-39 Freno_PantallaSinPalabrasExactas · $accion" "osascript -e 'tell application \"$SE\" to $accion'" "pantalla"
done
frena "T-puerta-39 Freno_PantallaSinPalabrasExactas · por su identificador" "osascript -e 'tell application id \"com.apple.systemevents\" to keystroke return'" "pantalla"
frena "T-puerta-39 Freno_PantallaSinPalabrasExactas · en dos -e" "osascript -e 'tell application \"$SE\"' -e 'keystroke return' -e 'end tell'" "pantalla"
frena "T-puerta-39 Freno_PantallaSinPalabrasExactas · un archivo por tubería" "cat scripts/p.applescript | osascript" "pantalla"
frena "T-puerta-39 Freno_PantallaSinPalabrasExactas · un archivo como argumento" "osascript scripts/p.applescript" "pantalla"
pasa "T-puerta-39 Freno_PantallaSinPalabrasExactas · leer procesos y filtrar por «click» no aprieta nada" "osascript -e 'tell application \"$SE\" to get name of every process' | grep -i click"

# ── T-puerta-33 · un renglón hecho para trabar la lectura no cuelga al freno ─────────────────────
{ head -1 "$JUG/scripts/consulta.sh"; node -e 'process.stdout.write("!|".repeat(2000) + "\n")'; tail -n +2 "$JUG/scripts/consulta.sh"; } > "$JUG/scripts/hostil.sh"
payload="$(CMD="bash scripts/hostil.sh" CWD="$JUG" node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",hook_event_name:"PreToolUse",cwd:process.env.CWD,tool_input:{command:process.env.CMD}}))')"
printf '%s' "$payload" | ( cd "$JUG" && env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" TYCON_PROD_SESSION_SINCE=0 /usr/bin/perl -e 'alarm 8; exec @ARGV' node "$HOOK" ) >"$TMP/out" 2>"$TMP/err"; rc=$?
if [ "$rc" = 2 ] && grep -qF "llama a la puerta" "$TMP/err"; then ok "T-puerta-33 Freno_RenglonQueTrabaLaLectura · lee el guion a tiempo y lo frena"
else no "T-puerta-33 Freno_RenglonQueTrabaLaLectura · rc=$rc (142 = se colgó) · $(head -c 160 "$TMP/err" | tr '\n' ' ')"; fi

for i in 1 2 3 4; do { head -1 "$JUG/scripts/consulta.sh"; node -e 'process.stdout.write("a=( ".repeat(15000) + "\n")'; [ "$i" != 4 ] || tail -n +2 "$JUG/scripts/consulta.sh"; } > "$JUG/scripts/arreglo$i.sh"; done
payload="$(CMD="bash scripts/arreglo1.sh; bash scripts/arreglo2.sh; bash scripts/arreglo3.sh; bash scripts/arreglo4.sh" CWD="$JUG" node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",hook_event_name:"PreToolUse",cwd:process.env.CWD,tool_input:{command:process.env.CMD}}))')"
printf '%s' "$payload" | ( cd "$JUG" && env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" TYCON_PROD_SESSION_SINCE=0 /usr/bin/perl -e 'alarm 8; exec @ARGV' node "$HOOK" ) >"$TMP/out" 2>"$TMP/err"; rc=$?
if [ "$rc" = 2 ] && grep -qF "llama a la puerta" "$TMP/err"; then ok "T-puerta-33 Freno_ArreglosSinCerrar · varios guiones con «x=(» sin cierre se leen a tiempo"
else no "T-puerta-33 Freno_ArreglosSinCerrar · rc=$rc (142 = se colgó) · $(head -c 160 "$TMP/err" | tr '\n' ' ')"; fi

a_tiempo(){ # $1 = etiqueta, $2 = comando: se frena por la puerta antes del tope (142 = se colgó)
  local payload rc; payload="$(CMD="$2" CWD="$JUG" node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",hook_event_name:"PreToolUse",cwd:process.env.CWD,tool_input:{command:process.env.CMD}}))')"
  printf '%s' "$payload" | ( cd "$JUG" && env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" TYCON_PROD_SESSION_SINCE=0 /usr/bin/perl -e 'alarm 4; exec @ARGV' node "$HOOK" ) >"$TMP/out" 2>"$TMP/err"; rc=$?
  if [ "$rc" = 2 ] && grep -qF "llama a la puerta" "$TMP/err"; then ok "$1"; else no "$1 · rc=$rc · $(head -c 160 "$TMP/err" | tr '\n' ' ')"; fi
}
{ head -1 "$JUG/scripts/consulta.sh"; node -e 'process.stdout.write("if [[ " + "a( ".repeat(20000) + "\n")'; tail -n +2 "$JUG/scripts/consulta.sh"; } > "$JUG/scripts/condicion.sh"
a_tiempo "T-puerta-33 Freno_ParentesisSinCerrar · muchos «(» después de un «if [[» se leen a tiempo" "bash scripts/condicion.sh"
nombre="$(node -e 'process.stdout.write("f".repeat(300))')"
printf '#!/usr/bin/env bash\n%s(){ %s; }\n' "$nombre" "$(tail -n +2 "$JUG/scripts/consulta.sh")" > "$JUG/scripts/funcion-larga.sh"
a_tiempo "T-puerta-33 Freno_FuncionDeNombreLargo · el cuerpo de la función se mira" "bash scripts/funcion-larga.sh"

# ── T-puerta-40 · la medición no da verde sin haber medido ──────────────────────────────────────
TRANS="$CASA/.claude/projects/p"; mkdir -p "$TRANS"
renglon(){ C="$1" D="$2" node -e 'console.log(JSON.stringify({type:"assistant",cwd:process.env.D,message:{content:[{type:"tool_use",name:"Bash",input:{command:process.env.C}}]}}))'; }
medir(){ ( cd "$JUG" && env HOME="$CASA" node "$AQUI/scripts/production/measure-guard.js" 100 "$REPOS" ) > "$TMP/medida" 2>"$TMP/medida.err"; echo $?; }
{ renglon "echo uno" /no/existe; renglon "echo dos" /no/existe; } > "$TRANS/t.jsonl"
rc="$(medir)"
if [ "$rc" = 1 ] && grep -q '"medidos": 0' "$TMP/medida"; then ok "T-puerta-40 MedirFreno_SinMedirNoDaVerde · ningún comando medido: sale 1"
else no "T-puerta-40 MedirFreno_SinMedirNoDaVerde · rc=$rc · $(head -c 200 "$TMP/medida" | tr '\n' ' ') · $(head -c 160 "$TMP/medida.err")"; fi
{ renglon "echo uno" "$JUG"; renglon "echo dos" /no/existe; renglon "osascript -e 'tell application \"$SE\" to keystroke return'" "$JUG"; } > "$TRANS/t.jsonl"
rc="$(medir)"
if [ "$rc" = 0 ] && grep -q '"frenados_por_apretar_la_pantalla": 1' "$TMP/medida" && grep -q '"frenados_que_no_nombran_bases": 0' "$TMP/medida" && grep -q '"sin_carpeta": 1' "$TMP/medida"; then
  ok "T-puerta-40 MedirFreno_SinMedirNoDaVerde · apretar la pantalla no cuenta como falso positivo, y lo no medido se muestra"
else no "T-puerta-40 MedirFreno_SinMedirNoDaVerde · rc=$rc · $(tr -d '\n ' < "$TMP/medida" | head -c 300) · $(head -c 160 "$TMP/medida.err")"; fi
mkdir -p "$CASA/guiones"; cp "$JUG/scripts/leer.sh" "$CASA/guiones/leer.sh"
renglon "bash ~/guiones/leer.sh" "$JUG" > "$TRANS/t.jsonl"
rc="$(medir)"
if grep -q '"frenados": 1' "$TMP/medida"; then ok "T-puerta-40 MedirFreno_SinMedirNoDaVerde · un guion en ~/ se busca en la carpeta real"
else no "T-puerta-40 MedirFreno_SinMedirNoDaVerde · ~/: rc=$rc · $(tr -d '\n ' < "$TMP/medida" | head -c 300)"; fi

# ── T-puerta-30 · lo no declarado y las piezas del freno pasan ──────────────────────────────────
pasa "T-puerta-30 Freno_NombresNoDeclaradosYPiezasDelFreno_Pasan · un llavero no declarado" "bash scripts/no-declarado.sh"
pasa "T-puerta-30 Freno_NombresNoDeclaradosYPiezasDelFreno_Pasan · node scripts/hooks/prod-access-guard.js" "node $HOOK"
pasa "T-puerta-30 Freno_NombresNoDeclaradosYPiezasDelFreno_Pasan · un programa compilado por ruta no es un guion" "/bin/ls -la"

# ── T-puerta-indice · un guion que nombra sólo un host de producción, sin cliente de base ni otra señal, depende del
#    índice guardado para ser candidato: con el índice ilegible se mira igual (todo guion es candidato), y sin índice
#    pasa y queda anotado como «no-mirado», nunca en silencio ──
printf '#!/usr/bin/env bash\ncurl -s https://%s/estado\n' "$OTRO_PROD" > "$JUG/scripts/solo-host.sh"
corre "bash scripts/leer.sh" >/dev/null   # deja el índice armado
INDICE="$(find "$CASA" -name production-index.json -print -quit)"
if [ -z "$INDICE" ]; then no "T-puerta-indice no encontré el índice de servidores en la casa de prueba"
else
  frena "T-puerta-indice Freno_SoloHost_IndiceLegible · con el índice legible frena" "bash scripts/solo-host.sh" "$OTRO_PROD"
  printf '{ esto no es json' > "$INDICE"
  # al rearmarlo, la memoria de producción ya no cierra con su huella: frena por eso, y nunca deja pasar
  frena "T-puerta-indice Freno_SoloHost_IndiceIlegible · con el índice ilegible se mira igual y frena" "bash scripts/solo-host.sh" "FRENO DE PRODUCCIÓN"
  rm -f "$INDICE"; : > "$REGISTRO"
  rc="$(corre "bash scripts/solo-host.sh")"
  if grep -q '"tipo":"no-mirado"' "$REGISTRO" && grep -q 'índice' "$REGISTRO"; then
    ok "T-puerta-indice Freno_SoloHost_SinIndice · sin índice queda anotado como «no-mirado» (rc=$rc)"
  else no "T-puerta-indice Freno_SoloHost_SinIndice · sin índice no se anotó nada (rc=$rc): $(tr '\n' ' ' < "$REGISTRO" | head -c 300)"; fi
fi

echo "— prod-saved: $pasaron ok, $fallos fallos —"
[ "$fallos" -eq 0 ]
