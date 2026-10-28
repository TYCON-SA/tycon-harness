#!/usr/bin/env bash
# engram-chunk-secrets.test.sh — la memoria compartida no lleva claves al repo.
#
# El pre-commit global exporta la memoria del proyecto (`engram sync`) y prepara `.engram/` para el commit. Una nota que
# trae una clave entera viajaría con el commit al pedido y a la historia del repo. Antes de preparar, cada archivo
# pendiente de `.engram/chunks/` pasa por el detector de claves: con una, el commit no se crea y se dice qué nota y qué
# forma, sin mostrar la clave.
#
# Corre GIT DE VERDAD en un repo de laboratorio, con el gancho global como `core.hooksPath` y un `engram` de mentira
# que escribe el archivo que le dan. Las claves de juguete se arman por partes: este archivo no trae ninguna entera.
# E14-E17: la segunda vuelta del pase adversarial.
# Casos: E1 con clave no se crea · E2 limpia pasa y viaja · E3 la clave no se muestra · E4 el pendiente se sigue
# frenando en el commit siguiente · E5 clave de licencia junto a su palabra · E6 cadena de conexión · E7 sin el
# detector no se prepara nada y el commit pasa · E8 lo que parece una clave y no es · E9-E13 lo que encontraron la
# revisión de seguridad y el pase adversarial.

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FALLOS=0
T=""
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); if [ -n "$T" ] && [ -s "$T/salida.txt" ]; then tail -n 6 "$T/salida.txt" | cut -c1-220 | sed 's/^/         salida: /'; fi; }
TMPS=(); trap 'for d in ${TMPS[@]+"${TMPS[@]}"}; do rm -rf "$d"; done' EXIT
export GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME=lab GIT_AUTHOR_EMAIL=lab@example.invalid GIT_COMMITTER_NAME=lab GIT_COMMITTER_EMAIL=lab@example.invalid
export GIT_AUTHOR_DATE="2026-01-01T10:00:00Z" GIT_COMMITTER_DATE="2026-01-01T10:00:00Z"
export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false GIT_CONFIG_KEY_1=gc.auto GIT_CONFIG_VALUE_1=0

# El repo de laboratorio: con `.engram/` y `.engram-project`, el gancho global en su carpeta y un `engram` que, al
# sincronizar, copia ENGRAM_CHUNK a `.engram/chunks/<ENGRAM_ID>.jsonl.gz` y dice «Created chunk».
montar() {
  T="$(mktemp -d)"; TMPS+=("$T")
  mkdir -p "$T/hooks" "$T/bin" "$T/repo/.engram/chunks"
  cp "$RAIZ/scripts/hooks/git-pre-commit-global.sh" "$T/hooks/pre-commit"; chmod +x "$T/hooks/pre-commit"
  cat > "$T/bin/engram" <<'ENG'
#!/usr/bin/env bash
[ "${1:-}" = sync ] || exit 0
[ -n "${ENGRAM_CHUNK:-}" ] || { echo "Nothing to sync"; exit 0; }
gzip -c "$ENGRAM_CHUNK" > ".engram/chunks/${ENGRAM_ID}.jsonl.gz"
echo "Created chunk ${ENGRAM_ID}"
ENG
  chmod +x "$T/bin/engram"
  echo acme > "$T/repo/.engram-project"; echo '{"version":1,"chunks":[]}' > "$T/repo/.engram/manifest.json"
  git -C "$T/repo" init -q -b main
  git -C "$T/repo" add -A; git -C "$T/repo" -c core.hooksPath=/dev/null commit -q -m base
}
nota() { # <archivo> <título> <contenido>
  node -e 'const [f,t,c]=process.argv.slice(1); require("fs").writeFileSync(f, JSON.stringify({sessions:null,observations:[{id:7,type:"discovery",title:t,content:c}],prompts:[]}))' "$@"
}
commitear() { # <id>  (la nota en $T/nota.json; GUIAS cambia dónde se busca el arnés)
  echo "cambio $1" >> "$T/repo/README"; git -C "$T/repo" add README
  ( cd "$T/repo" && PATH="$T/bin:$PATH" TYCON_GUIDES_DIR="${GUIAS:-$RAIZ}" TYCON_ENGRAM_HOOK=1 ENGRAM_CHUNK="$T/nota.json" ENGRAM_ID="$1" \
      git -c core.hooksPath="$T/hooks" commit -q -m "cambio $1" ) > "$T/salida.txt" 2>&1
  RC=$?
}
creado() { git -C "$T/repo" log --format=%s -1 | grep -x "cambio $1" >/dev/null; }
en_commit() { git -C "$T/repo" show --name-only --format= HEAD | grep -x "$1" >/dev/null; }

AWS="AKIA""ABCDEFGHIJKLMNOP"
LIC="Q7rT""9xK2mVb4Lp8ZwN3c"
PASS="Hx9""kLm2Qp7"
HOST="Ser""ver=db.lab.invalid"
PW="Pass""word"

echo "== E1 con clave de juguete el commit no se crea"
montar; nota "$T/nota.json" "Credenciales del entorno" "la llave de AWS del ambiente es $AWS"
commitear c1
if creado c1; then mal "E1: el commit se creó con una clave en la memoria"; else ok "E1: el commit no se crea"; fi
if grep -q "c1" "$T/salida.txt" && grep -q "Credenciales del entorno" "$T/salida.txt" && grep -q "AWS" "$T/salida.txt"; then ok "E1: dice el archivo, la nota y la forma"; else mal "E1: no dice qué archivo, qué nota y qué forma"; fi
if git -C "$T/repo" diff --cached --name-only | grep '^.engram/' >/dev/null; then mal "E1: la nota quedó preparada para el commit"; else ok "E1: la nota no queda preparada"; fi

echo "== E3 la clave no se muestra"
if grep -qF "$AWS" "$T/salida.txt"; then mal "E3: la salida muestra la clave entera"; else ok "E3: la salida no muestra la clave"; fi

echo "== E4 el pendiente se sigue frenando en el commit siguiente"
echo "otro" >> "$T/repo/README"; git -C "$T/repo" add README
( cd "$T/repo" && PATH="$T/bin:$PATH" TYCON_GUIDES_DIR="$RAIZ" TYCON_ENGRAM_HOOK=1 git -c core.hooksPath="$T/hooks" commit -q -m "cambio c1b" ) > "$T/salida.txt" 2>&1
if creado c1b; then mal "E4: sin nota nueva, el commit siguiente pasó con la clave pendiente"; else ok "E4: el archivo pendiente con la clave sigue frenando"; fi

echo "== E2 una nota limpia pasa y viaja con el commit"
montar; nota "$T/nota.json" "Decisión de diseño" "el lector cachea los nombres por proceso; el token de prueba se arma por partes"
commitear c2
if [ "$RC" = 0 ] && creado c2; then ok "E2: el commit se crea"; else mal "E2: una nota limpia frenó el commit (rc $RC)"; fi
if en_commit .engram/chunks/c2.jsonl.gz; then ok "E2: la nota viaja con el commit"; else mal "E2: la nota limpia no se preparó"; fi

echo "== E5 una clave de licencia junto a su palabra"
montar; nota "$T/nota.json" "Licencia BIZUIT" "la clave de licencia de BIZUIT es $LIC, vence en marzo"
commitear c5
if creado c5; then mal "E5: pasó una clave de licencia escrita junto a «clave de licencia»"; else ok "E5: frena"; fi
if grep -qF "$LIC" "$T/salida.txt"; then mal "E5: la salida muestra la clave"; else ok "E5: sin mostrarla"; fi

echo "== E6 una cadena de conexión con su contraseña"
montar; nota "$T/nota.json" "Conexión a la base" "$HOST;Database=x;User Id=app;${PW}=$PASS;"
commitear c6
if creado c6; then mal "E6: pasó una cadena de conexión con su contraseña"; else ok "E6: frena"; fi
if grep -qF "$PASS" "$T/salida.txt"; then mal "E6: la salida muestra la contraseña"; else ok "E6: sin mostrarla"; fi

echo "== E7 sin el detector en el arnés no se prepara nada y el commit pasa"
montar; nota "$T/nota.json" "Credenciales del entorno" "la llave de AWS del ambiente es $AWS"
GUIAS="$T/sin-arnes" commitear c7
if [ "$RC" = 0 ] && creado c7; then ok "E7: el commit se crea"; else mal "E7: sin detector, el commit no se creó (rc $RC)"; fi
if en_commit .engram/chunks/c7.jsonl.gz; then mal "E7: sin detector, la memoria viajó sin revisar"; else ok "E7: la memoria no viaja sin revisar"; fi
if grep -q "no pude revisar" "$T/salida.txt"; then ok "E7: lo dice"; else mal "E7: no dice que la memoria quedó sin preparar"; fi

echo "== E8 lo que parece una clave y no es: una expresión de reemplazo y un identificador de regla"
montar; nota "$T/nota.json" "Registros de humo" "los registros tapan ${PW}=/Aaa=/Bbbbbbb= y la clave nueva aparece sola: SEC-12.6-alguna-regla-mas"
commitear c8
if [ "$RC" = 0 ] && creado c8; then ok "E8: no frena"; else mal "E8: frenó por algo que no es una clave (rc $RC)"; fi

# Lo que sigue lo encontraron la revisión de seguridad y el pase adversarial: cada caso pasaba la clave o frenaba de más.
commit_a_mano() { # <mensaje> [variables…]: un commit sin nota nueva, con el gancho
  local m="$1"; shift
  ( cd "$T/repo" && env PATH="$T/bin:$PATH" TYCON_GUIDES_DIR="$RAIZ" "$@" git -c core.hooksPath="$T/hooks" commit -q -m "$m" ) > "$T/salida.txt" 2>&1
  RC=$?
}
gz_nota() { nota "$T/n.json" "$1" "$2"; gzip -c "$T/n.json" > "$3"; }

echo "== E9 lo preparado se lee del índice: una clave preparada y limpiada después en el disco no viaja"
montar; gz_nota "Credenciales" "la llave es $AWS" "$T/repo/.engram/chunks/c9.jsonl.gz"
git -C "$T/repo" add .engram
gz_nota "Credenciales" "sin nada" "$T/repo/.engram/chunks/c9.jsonl.gz"
echo x >> "$T/repo/README"; git -C "$T/repo" add README
commit_a_mano "cambio c9" TYCON_ENGRAM_HOOK=1
if creado c9; then mal "E9: viajó la copia preparada con la clave"; else ok "E9: frena por lo preparado"; fi

echo "== E10 con la sincronización apagada, un git add -A no lleva la clave"
montar; gz_nota "Credenciales" "la llave es $AWS" "$T/repo/.engram/chunks/c10.jsonl.gz"
echo x >> "$T/repo/README"; git -C "$T/repo" add -A
commit_a_mano "cambio c10" TYCON_ENGRAM_HOOK=0
if creado c10; then mal "E10: con el sync apagado la clave viajó"; else ok "E10: frena igual"; fi
montar; gz_nota "Credenciales" "la llave es $AWS" "$T/repo/.engram/chunks/c10b.jsonl.gz"
echo x >> "$T/repo/README"; git -C "$T/repo" add -A
( cd "$T/repo" && PATH="/usr/bin:/bin:$(dirname "$(command -v node)")" TYCON_GUIDES_DIR="$RAIZ" git -c core.hooksPath="$T/hooks" commit -q -m "cambio c10b" ) > "$T/salida.txt" 2>&1
if creado c10b; then mal "E10: sin engram instalado la clave viajó"; else ok "E10: sin engram instalado también frena"; fi

echo "== E11 renombrar una memoria limpia no frena"
montar; gz_nota "Decisión" "nada secreto" "$T/repo/.engram/chunks/c11.jsonl.gz"
git -C "$T/repo" add .engram; git -C "$T/repo" -c core.hooksPath=/dev/null commit -q -m base2
git -C "$T/repo" mv .engram/chunks/c11.jsonl.gz .engram/chunks/c11b.jsonl.gz
commit_a_mano "cambio c11" TYCON_ENGRAM_HOOK=1
if [ "$RC" = 0 ] && creado c11; then ok "E11: pasa"; else mal "E11: un renombre limpio frenó (rc $RC)"; fi

echo "== E12 la contraseña de conexión en el título no se muestra"
montar; nota "$T/nota.json" "conn: ${PW}=$PASS" "la cadena de la nota"
commitear c12
if creado c12; then mal "E12: no frenó"; else ok "E12: frena"; fi
if grep -qF "$PASS" "$T/salida.txt"; then mal "E12: el título muestra la contraseña"; else ok "E12: el título sale tapado"; fi

echo "== E13 fuera de chunks/, en otro formato, o detrás de una variable: se mira igual"
montar; printf '{"title":"x","content":"la llave es %s"}\n' "$AWS" > "$T/repo/.engram/chunks/c13.jsonl"
echo x >> "$T/repo/README"; git -C "$T/repo" add -A
commit_a_mano "cambio c13" TYCON_ENGRAM_HOOK=1
if creado c13; then mal "E13: un .jsonl suelto viajó con la clave"; else ok "E13: un .jsonl suelto frena"; fi
montar; gz_nota "Credenciales" "la llave es $AWS" "$T/repo/.engram/viejo.jsonl.gz"; nota "$T/nota.json" "Decisión" "nada secreto"
commitear c13b
if creado c13b; then mal "E13: un archivo fuera de chunks/ viajó con la clave"; else ok "E13: fuera de chunks/ frena"; fi
montar; nota "$T/nota.json" "Conexión" "Pwd=\$(DBPASSVAR);Pwd=$PASS;"
commitear c13c
if creado c13c; then mal "E13: la contraseña detrás de una variable pasó"; else ok "E13: la segunda contraseña frena"; fi

echo "== E14 un preparado viaja aunque la carpeta ya no esté en el disco"
montar; gz_nota "Credenciales" "la llave es $AWS" "$T/repo/.engram/chunks/c14.jsonl.gz"
git -C "$T/repo" add .engram; rm -rf "$T/repo/.engram"
echo x >> "$T/repo/README"; git -C "$T/repo" add README
commit_a_mano "cambio c14" TYCON_ENGRAM_HOOK=1
if creado c14; then mal "E14: sin la carpeta en el disco, la clave preparada viajó"; else ok "E14: frena por lo preparado"; fi

echo "== E15 un enlace simbólico no se sigue: a /dev/zero no cuelga el commit"
montar; ln -s /dev/zero "$T/repo/.engram/cero"; nota "$T/nota.json" "Decisión" "nada secreto"
( commitear c15 ) & PID=$!
( sleep 60; kill "$PID" 2>/dev/null ) & VIGIA=$!
wait "$PID"; kill "$VIGIA" 2>/dev/null
if creado c15; then ok "E15: el commit termina y pasa"; else mal "E15: el enlace a /dev/zero colgó o frenó el commit"; fi

echo "== E16 la clave en el nombre de un archivo no viaja"
montar; nota "$T/nota.json" "Decisión" "nada secreto"; echo nada > "$T/repo/.engram/$AWS.txt"
commitear c16
if creado c16; then mal "E16: un nombre con la clave viajó"; else ok "E16: frena"; fi
if grep -qF "$AWS" "$T/salida.txt"; then mal "E16: el aviso muestra la clave del nombre"; else ok "E16: sin mostrarla"; fi

echo "== E17 UTF-16 y un gzip dentro de otro se leen"
montar; printf '\xff\xfe' > "$T/repo/.engram/u16.json"; printf '{"title":"x","content":"la llave es %s"}' "$AWS" | iconv -f utf-8 -t utf-16le >> "$T/repo/.engram/u16.json"
echo x >> "$T/repo/README"; git -C "$T/repo" add -A
commit_a_mano "cambio c17" TYCON_ENGRAM_HOOK=1
if creado c17; then mal "E17: una nota en UTF-16 viajó con la clave"; else ok "E17: UTF-16 frena"; fi
montar; gz_nota "Credenciales" "la llave es $AWS" "$T/uno.gz"; gzip -c "$T/uno.gz" > "$T/repo/.engram/chunks/c17b.jsonl.gz"
echo x >> "$T/repo/README"; git -C "$T/repo" add -A
commit_a_mano "cambio c17b" TYCON_ENGRAM_HOOK=1
if creado c17b; then mal "E17: un gzip dentro de otro viajó con la clave"; else ok "E17: gzip dentro de gzip frena"; fi

echo
if [ "$FALLOS" = 0 ]; then echo "✅ engram-chunk-secrets: todo en orden"; exit 0; fi
echo "❌ engram-chunk-secrets: $FALLOS fallo(s)"; exit 1
