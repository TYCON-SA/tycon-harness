#!/usr/bin/env bash
# telegram-notify.test.sh — red de `scripts/lib/tycon-telegram-notify.sh`.
#
# Ninguno de estos casos toca la red ni manda un mensaje: el camino feliz se ejercita con
# --dry-run, y los caminos de error con un directorio de canal vacío. El caso que más importa no
# es que mande —eso se probó a mano una vez— sino que **falle diciéndolo**: un aviso perdido en
# silencio es peor que ninguno, porque quien lo llamó sigue creyendo que avisó.
#
# Correr: bash scripts/tests/telegram-notify.test.sh

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$RAIZ/scripts/lib/tycon-telegram-notify.sh"
VACIO="$(mktemp -d)"
FAKE="$(mktemp -d)"
printf 'TELEGRAM_BOT_TOKEN=123:TOKEN-SECRETO-QUE-NO-DEBE-APARECER\n' > "$FAKE/.env"
printf '{"dmPolicy":"allowlist","allowFrom":["999000111"]}\n' > "$FAKE/access.json"

fallos=0
check() { # check <nombre> <esperado> <obtenido>
  if [ "$2" = "$3" ]; then echo "✅ $1"; else echo "❌ $1 — esperaba [$2], obtuvo [$3]"; fallos=$((fallos+1)); fi
}
contiene() { # contiene <nombre> <aguja> <pajar>
  case "$3" in *"$2"*) echo "✅ $1";; *) echo "❌ $1 — no encontré [$2] en: $3"; fallos=$((fallos+1));; esac
}
no_contiene() {
  case "$3" in *"$2"*) echo "❌ $1 — apareció [$2] y NO debía"; fallos=$((fallos+1));; *) echo "✅ $1";; esac
}

# 1. Camino feliz sin red: resuelve token y destinatario del directorio del canal.
out="$(TYCON_TELEGRAM_DIR="$FAKE" bash "$SCRIPT" --dry-run "hola" 2>&1)"; rc=$?
check "dry-run sale 0" 0 "$rc"
contiene "dry-run resuelve el destinatario del access.json" "chat_id=999000111" "$out"
contiene "dry-run usa sendMessage" "método=sendMessage" "$out"

# 2. 🔴 El token NO se filtra por la salida — esta salida termina en logs y en el reporte del banco.
no_contiene "el token nunca aparece en la salida" "TOKEN-SECRETO-QUE-NO-DEBE-APARECER" "$out"

# 3. --edit cambia el método (es lo que permite UN aviso por tanda en vez de una catarata).
out="$(TYCON_TELEGRAM_DIR="$FAKE" bash "$SCRIPT" --edit 42 --dry-run "corregido" 2>&1)"
contiene "--edit usa editMessageText" "método=editMessageText" "$out"
contiene "--edit pasa el message_id" "message_id=42" "$out"

# 4. Sin token → NO manda y lo DICE (exit 3, no 0: fail-open silencioso sería el bug).
out="$(TYCON_TELEGRAM_DIR="$VACIO" bash "$SCRIPT" "hola" 2>&1)"; rc=$?
check "sin token sale 3" 3 "$rc"
contiene "sin token deja constancia" "no hay token" "$out"

# 5. Con token pero sin destinatario → mismo trato.
out="$(TYCON_TELEGRAM_DIR="$VACIO" TELEGRAM_BOT_TOKEN=x bash "$SCRIPT" "hola" 2>&1)"; rc=$?
check "sin destinatario sale 3" 3 "$rc"
contiene "sin destinatario deja constancia" "no hay destinatario" "$out"

# 6. Uso inválido (sin texto) → 2, distinto de "no pude mandar".
out="$(TYCON_TELEGRAM_DIR="$FAKE" bash "$SCRIPT" 2>&1)"; rc=$?
check "sin texto sale 2" 2 "$rc"

# 7. Telegram rechaza → 3, y el token tampoco se filtra por el mensaje de error.
out="$(TYCON_TELEGRAM_DIR="$FAKE" TYCON_TELEGRAM_API="http://127.0.0.1:9" bash "$SCRIPT" "hola" 2>&1)"; rc=$?
check "envío fallido sale 3" 3 "$rc"
no_contiene "el token no se filtra en el error de red" "TOKEN-SECRETO-QUE-NO-DEBE-APARECER" "$out"

# ── T23 · R3_Lib_MovedRequires (story 8.12, tanda R3, AC 20) ─────────────────────────────────────────────────────
# El aviso vive en scripts/lib/: compila desde ahí y, sin red, resuelve token y destinatario igual que antes. En la ruta
# de siempre queda el reemplazo generado (lo llaman el bloque de Codex de cada máquina y los pasos de agent-skills):
# lanza el de lib/ con los mismos argumentos, así que el `--edit <id>` y el message_id que imprime no se pierden. La
# ruta de siempre sale del mapa; la copia pública no lo lleva y el caso lo dice. Sólo la falta del mapa saltea: con el
# mapa presente, ilegible o sin la entrada es un rojo (pase adversarial de la R3: «sin entrada» leído como «copia
# pública» dejaba pasar en verde un reemplazo que falta).
bash -n "$SCRIPT" 2>/dev/null; check "T23 R3_Lib_MovedRequires — compila desde scripts/lib/" 0 "$?"
T23_MAP="$RAIZ/scripts/lib/renames.json"
T23_OLD=""
if [ -f "$T23_MAP" ]; then
  T23_OLD="$(node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const e = m.entries.find((x) => x && x.batch === "R3" && x.new === "scripts/lib/tycon-telegram-notify.sh");
process.stdout.write(e ? e.old : "");' "$T23_MAP" 2>&1)"; T23_RC=$?
  if [ "$T23_RC" -ne 0 ]; then
    check "T23 R3_Lib_MovedRequires — el mapa se puede leer" 0 "$T23_RC"; T23_OLD=""
  elif [ -z "$T23_OLD" ]; then
    check "T23 R3_Lib_MovedRequires — el mapa no tiene la entrada de scripts/lib/tycon-telegram-notify.sh" "con entrada" "sin entrada"
  fi
fi
if [ ! -f "$T23_MAP" ]; then
  echo "  NO MEDIDO — copia pública sin el mapa (T23: el reemplazo en la ruta de siempre)"
elif [ -n "$T23_OLD" ]; then
  marca="$(node -e '
const L = require(process.argv[1]); const fs = require("fs"), path = require("path");
const [raiz, viejo, nuevo] = process.argv.slice(2);
let texto = ""; try { texto = fs.readFileSync(path.join(raiz, viejo), "utf8"); } catch { process.stdout.write("NO-EXISTE"); process.exit(0); }
const destino = L.shimTarget(path.join(raiz, viejo));
process.stdout.write(L.isGeneratedShim(viejo, texto) && destino && path.resolve(destino) === path.resolve(raiz, nuevo) ? "OK" : "NO-ES-EL-GENERADO");
' "$RAIZ/scripts/lib/legacy-names.js" "$RAIZ" "$T23_OLD" "scripts/lib/tycon-telegram-notify.sh" 2>&1)"
  check "T23 R3_Lib_MovedRequires — en la ruta de siempre queda el reemplazo generado que lanza el de lib/" OK "$marca"
  nuevo_out="$(TYCON_TELEGRAM_DIR="$FAKE" bash "$SCRIPT" --edit 42 --dry-run "corregido" 2>&1)"; nuevo_rc=$?
  # HOME de mentira: el reemplazo anota su uso en el home, y una prueba no ensucia el de la máquina
  T23_HOME="$(mktemp -d)"
  viejo_out="$(HOME="$T23_HOME" TYCON_GUIDES_DIR= TYCON_TELEGRAM_DIR="$FAKE" TYCON_NO_NIGHTLY_EXAM=1 bash "$RAIZ/$T23_OLD" --edit 42 --dry-run "corregido" 2>/dev/null)"; viejo_rc=$?
  rm -rf "$T23_HOME"
  check "T23 R3_Lib_MovedRequires — por la ruta de siempre, mismo código que por lib/" "$nuevo_rc" "$viejo_rc"
  contiene "T23 R3_Lib_MovedRequires — por la ruta de siempre, --edit sigue pasando el message_id" "message_id=42" "$viejo_out"
  contiene "T23 R3_Lib_MovedRequires — por la ruta de siempre, sigue usando editMessageText" "método=editMessageText" "$viejo_out"
fi

# ── T60 · el texto nunca va en la línea de comandos de curl ───────────────────────────────────────────────────────
# En Windows el curl de Git lee sus argumentos en la página de códigos del sistema: un texto con «¿», «·» o un emoji
# llegaba a Telegram con «�» y «?» (aviso de espera, corrida 13729 de la 182). Un curl de mentira anota sus argumentos y
# su entrada: los argumentos no traen el texto ni ningún byte fuera de ASCII, y la entrada trae el texto entero, igual
# venga como argumento o por --stdin. Sin red.
T60_BIN="$(mktemp -d)"
T60_LOG="$(mktemp -d)"
cat > "$T60_BIN/curl" <<'CURL'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$T60_LOG_DIR/args"
cat > "$T60_LOG_DIR/stdin"
prev=""; for a in "$@"; do [ "$prev" = "-K" ] && { printf '%s' "$a" > "$T60_LOG_DIR/cfg-path"; cp "$a" "$T60_LOG_DIR/cfg"; ls -l "$a" | cut -c1-10 > "$T60_LOG_DIR/cfg-mode"; }; prev="$a"; done
echo '{"ok":true,"result":{"message_id":7}}'
CURL
chmod +x "$T60_BIN/curl"
T60_TEXT='⏳ Una corrida te espera · ¿Sigo con los revisores?'
for modo in arg stdin; do
  rm -f "$T60_LOG/args" "$T60_LOG/stdin"
  if [ "$modo" = arg ]; then
    out="$(PATH="$T60_BIN:$PATH" T60_LOG_DIR="$T60_LOG" TYCON_TELEGRAM_DIR="$FAKE" bash "$SCRIPT" "$T60_TEXT" 2>&1)"; rc=$?
  else
    out="$(printf '%s' "$T60_TEXT" | PATH="$T60_BIN:$PATH" T60_LOG_DIR="$T60_LOG" TYCON_TELEGRAM_DIR="$FAKE" bash "$SCRIPT" --stdin 2>&1)"; rc=$?
  fi
  check "T60 ($modo) manda y sale 0" 0 "$rc"
  check "T60 ($modo) imprime el message_id" 7 "$out"
  no_contiene "T60 ($modo) el texto no va en los argumentos de curl" "Sigo con los revisores" "$(cat "$T60_LOG/args" 2>/dev/null)"
  if LC_ALL=C grep -q '[^ -~]' "$T60_LOG/args" 2>/dev/null; then echo "❌ T60 ($modo) los argumentos de curl traen bytes fuera de ASCII"; fallos=$((fallos+1)); else echo "✅ T60 ($modo) los argumentos de curl son ASCII"; fi
  check "T60 ($modo) curl recibe el texto entero, byte a byte, por la entrada" "$T60_TEXT" "$(cat "$T60_LOG/stdin" 2>/dev/null)"
  contiene "T60 ($modo) el campo text sale de la entrada (text@-)" "text@-" "$(cat "$T60_LOG/args" 2>/dev/null)"
  # el token del bot tampoco: la dirección va en un archivo de configuración de curl (-K), con permisos 600, que se borra
  no_contiene "T61 ($modo) el token no va en los argumentos de curl" "TOKEN-SECRETO-QUE-NO-DEBE-APARECER" "$(cat "$T60_LOG/args" 2>/dev/null)"
  contiene "T61 ($modo) la dirección con el token va en el archivo de configuración" 'url = "https://api.telegram.org/bot123:TOKEN-SECRETO-QUE-NO-DEBE-APARECER/sendMessage"' "$(cat "$T60_LOG/cfg" 2>/dev/null)"
  check "T61 ($modo) el archivo es sólo de esta persona (600)" "-rw-------" "$(cat "$T60_LOG/cfg-mode" 2>/dev/null)"
  if [ -n "$(cat "$T60_LOG/cfg-path" 2>/dev/null)" ] && [ ! -e "$(cat "$T60_LOG/cfg-path")" ]; then echo "✅ T61 ($modo) el archivo se borra al salir"; else echo "❌ T61 ($modo) el archivo de la dirección quedó en el disco (o curl no lo recibió)"; fallos=$((fallos+1)); fi
done
out="$(TYCON_TELEGRAM_DIR="$FAKE" bash "$SCRIPT" --stdin "y además argumento" < /dev/null 2>&1)"; rc=$?
check "T60 --stdin con un texto de argumento es un uso inválido (2)" 2 "$rc"
out="$(TYCON_TELEGRAM_DIR="$FAKE" bash "$SCRIPT" --stdin < /dev/null 2>&1)"; rc=$?
check "T60 --stdin sin texto es un uso inválido (2)" 2 "$rc"
rm -rf "$T60_BIN" "$T60_LOG"

rm -rf "$VACIO" "$FAKE"
if [ "$fallos" -eq 0 ]; then echo "✅ telegram-notify: todo verde"; exit 0; fi
echo "❌ telegram-notify: $fallos rojos"; exit 1
