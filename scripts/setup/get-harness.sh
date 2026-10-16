#!/usr/bin/env bash
# get-harness.sh — baja la versión publicada del arnés (sin git) y la instala. Leelo entero antes de correrlo: para eso es corto.
# Es la entrada «a mano». La otra, en una línea y en Node: `npx @tyconsa/harness@latest` (scripts/setup/npm/).
# Uso: bash get-harness.sh [--repo <org/nombre>] [-- <opciones de harness.js install>]
#
# Qué hace, en orden:
#   1. Revisa los requisitos: node (NODE_FLOOR o más), bash, curl, tar y python3 (éste sólo si se enchufa Claude Code: con
#      `-- --tool codex` no hace falta). Nada de git. Si falta alguno, te dice cómo instalarlo y sale 1 sin bajar nada. El
#      comando sugerido se imprime; este guion nunca instala nada ni usa sudo.
#   2. La credencial, ANTES de bajar: el repo es público y no hace falta. Usa el permiso de lectura de GitHub si lo hay
#      (TYCON_GITHUB_TOKEN, o el guardado en ~/.tycon/config.json); lo pide —sin eco; sin terminal sale 1— sólo ante 401 o 404.
#   3. Baja el comprimido con curl (honra HTTPS_PROXY/NO_PROXY) a una carpeta temporal, mira su listado y lo desempaqueta
#      con tar; nada fuera de esa carpeta. Sin permiso, sin la API de GitHub (su tope: 60 consultas por hora por conexión):
#      main de `info/refs` y el comprimido de codeload. Con permiso, la API (la credencial por stdin, sólo a su host).
#   4. Desde ese árbol: guarda el permiso si lo pidió (`harness.js config set github.token`, por stdin) y corre
#      `harness.js install --version latest --repo <org/nombre> <opciones>` en esta misma terminal: la bajada VERIFICADA y
#      la instalación son las del arnés (quedan en ~/.tycon); la carpeta temporal se borra al terminar.
set -u

REPO="TYCON-SA/tycon-harness"
API="${TYCON_RELEASE_API:-https://api.github.com}"   # TYCON_RELEASE_API: sólo pruebas (el GitHub de juguete)
GITBASE="${TYCON_RELEASE_GIT:-https://github.com}"; CODELOAD="${TYCON_RELEASE_ARCHIVE:-https://codeload.github.com}"; PUB=1   # ídem
[ -n "${TYCON_RELEASE_API:-}" ] && [ -z "${TYCON_RELEASE_GIT:-}" ] && PUB=0   # la API de juguete con el github.com real: nunca
NODE_FLOOR=22   # el piso para INSTALAR (el de la documentación); harness.js tolera 20 sólo para actualizar
TOKEN_URL="https://github.com/settings/personal-access-tokens/new"

say() { printf 'get-harness: %s\n' "$*" >&2; }
for u in "API=$API" "GIT=$GITBASE" "CODELOAD=$CODELOAD"; do case "${u#*=}" in http://*|https://*) ;; *) say "TYCON_RELEASE_${u%%=*} tiene que empezar con http:// o https:// (no sigo otros esquemas): ${u#*=}"; exit 2 ;; esac; done
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) if [ $# -lt 2 ] || [ -z "$2" ]; then say "--repo pide un valor (org/nombre)"; exit 2; fi; REPO="$2"; shift 2 ;;
    --) shift; break ;;
    -h|--help) say "uso: bash get-harness.sh [--repo <org/nombre>] [-- <opciones de install>]"
      say 'sin terminal (instalación desatendida): agregá `-- --profile minimal --yes` (o --profile full)'; say "el permiso de lectura de GitHub: el guardado en ~/.tycon/config.json, TYCON_GITHUB_TOKEN, o se pide en la terminal"; exit 0 ;;
    *) say "opción desconocida: $1 (las de install van después de --)"; exit 2 ;;
  esac
done

# ── 1. los requisitos (sin git: la versión se baja como archivos) ─────────────────────────────────────────────
OS="$(uname -s 2>/dev/null)"; DEBIAN=0
if [ "$OS" = Linux ] && [ -r /etc/os-release ]; then case "$(. /etc/os-release; printf '%s %s' "${ID:-}" "${ID_LIKE:-}")" in *debian*|*ubuntu*) DEBIAN=1 ;; esac; fi
suggest() { # suggest <herramienta> → cómo instalarla en este sistema (se imprime; nunca se corre)
  local brew="$1" apt="$1" page="https://www.gnu.org/software/$1/"
  case "$1" in node) brew=node; apt=nodejs; page="https://nodejs.org/en/download" ;; python3) brew=python; page="https://www.python.org/downloads/" ;; curl) page="https://curl.se/download.html" ;; esac
  if [ "$OS" = Darwin ]; then printf 'brew install %s' "$brew"
  elif [ "$DEBIAN" = 1 ] && [ "$1" = node ]; then printf 'sudo apt install nodejs (si te da una versión menor que %s: %s)' "$NODE_FLOOR" "$page"
  elif [ "$DEBIAN" = 1 ]; then printf 'sudo apt install %s' "$apt"
  else printf '%s' "$page"; fi
}
# en una Mac sin las herramientas de línea de comandos, /usr/bin/python3 existe pero sólo pide instalarlas
MISSING=0; NO_CLT=0; if [ "$OS" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then NO_CLT=1; fi
TOOLS="node bash curl tar python3"; case " $* " in *" --tool codex "*) TOOLS="node bash curl tar" ;; esac   # python3 lo pide el aplicador de Claude Code
for tool in $TOOLS; do
  if ! command -v "$tool" >/dev/null 2>&1; then say "falta $tool — sugerido (no lo corro): $(suggest "$tool")"; MISSING=1
  elif [ "$NO_CLT" = 1 ] && [ "$tool" = python3 ] && [ "$(command -v python3)" = /usr/bin/python3 ]; then
    say "falta python3 (el de /usr/bin pide las herramientas de línea de comandos) — sugerido (no lo corro): xcode-select --install"; MISSING=1
  fi
done
if command -v node >/dev/null 2>&1; then NV="$(node --version 2>/dev/null)"; NV="${NV#v}"; MAJOR="${NV%%.*}"
  case "$MAJOR" in
    ''|*[!0-9]*) say "node no dice su versión: el arnés pide Node $NODE_FLOOR o más — sugerido (no lo corro): $(suggest node)"; MISSING=1 ;;
    *) if [ "$MAJOR" -lt "$NODE_FLOOR" ]; then say "node $NV es viejo: el arnés pide Node $NODE_FLOOR o más — sugerido (no lo corro): $(suggest node)"; MISSING=1; fi ;;
  esac; fi
if [ "$MISSING" = 1 ]; then say "no bajé nada: instalá lo que falta y volvé a correr este guion"; exit 1; fi

# ── 2. el permiso de lectura, antes de bajar ──────────────────────────────────────────────────────────────────
TMP="$(mktemp -d "${TMPDIR:-/tmp}/get-harness.XXXXXX")" || { say "no pude crear una carpeta temporal"; exit 1; }; trap 'rm -rf "$TMP"' EXIT
CFG="${TYCON_HOME:-$HOME/.tycon}/config.json"
TOKEN="$(printf '%s' "${TYCON_GITHUB_TOKEN:-}" | tr -d '\r\n')"; SAVE=0; [ -n "$TOKEN" ] && SAVE=1   # un CR final (un archivo CRLF) no es parte del permiso
if [ -z "$TOKEN" ] && [ -f "$CFG" ]; then TOKEN="$(node -e 'try{const j=require(process.argv[1]);process.stdout.write(String((j.github&&j.github.token)||""))}catch(e){process.exit(3)}' "$CFG")" || { TOKEN=""; say "no pude leer $CFG (¿roto?): sigo como si no hubiera permiso guardado"; }; fi   # un archivo que no se lee NO es «sin permiso guardado»: se dice y se sigue sin él
# curl1 <URL> <archivo> <con credencial 1|0> → «<código> <redirección>». La credencial le llega a curl por stdin (-H @-),
# nunca en la línea de comandos; curl honra HTTPS_PROXY / NO_PROXY como el resto del arnés
curl1() { local hdr=''; [ "$3" = 1 ] && [ -n "$TOKEN" ] && hdr='-H @-'
  printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -sS $hdr -H 'Accept: application/vnd.github+json' -A get-harness -D "$TMP/hdr" -o "$2" -w '%{http_code} %{redirect_url}' "$1" 2>"$TMP/curl.err"; }
limited() { grep -qi '^x-ratelimit-remaining: *0' "$TMP/hdr" 2>/dev/null || return 0; local h; h="$(node -e 'const d=new Date((Number(process.argv[1])||Date.now()/1e3+3600)*1e3);process.stdout.write(`${d.getHours()}`.padStart(2,"0")+":"+`${d.getMinutes()}`.padStart(2,"0"))' "$(tr -d '\r' < "$TMP/hdr" | sed -n 's/^[Xx]-[Rr]ate[Ll]imit-[Rr]eset: *//p')")"
  say "GitHub limita las consultas $([ -n "$TOKEN" ] && echo 'de tu permiso' || echo 'sin permiso de esta conexión') hasta las $h: probá de nuevo después de esa hora. No bajé nada."; exit 1; }
# fetch <URL> <archivo> → el código HTTP del último salto (000 sin red; 1 si la cabecera no vale o la redirección no es http(s)).
# Redirecciones a mano, hasta 4: la credencial sigue sólo mientras el ORIGEN (host y puerto) no cambie —como en http-get.js—
fetch() { local url="$1" auth=1 hop=0 out code loc h1 h2
  while :; do out="$(curl1 "$url" "$2" "$auth")" || out="000 "; code="${out%% *}"; loc="${out#* }"
    if grep -qi 'illegal.*header\|header.*illegal' "$TMP/curl.err" 2>/dev/null; then say "el permiso trae caracteres que no valen en una cabecera (¿un salto de línea, un acento?): revisalo"; code=1; break; fi
    case "$code" in 30[1278]) hop=$((hop+1)); if [ "$hop" -gt 4 ] || [ -z "$loc" ]; then break; fi
      case "$loc" in http://*|https://*) ;; *) say "la redirección de $url apunta a un esquema que no es http(s): no la sigo"; code=1; break ;; esac
      h1="${url#*://}"; h1="${h1%%/*}"; h2="${loc#*://}"; h2="${h2%%/*}"; [ "$h1" = "$h2" ] || auth=0; url="$loc"; continue ;; esac
    break; done
  printf '%s' "${code:-000}"; }
ask() { # sin permiso y el repo no se lee: en la terminal se pide sin eco; sin terminal, la única acción y 1
  if [ ! -t 0 ]; then say "el repo $REPO no se puede leer sin un permiso de GitHub: creá uno de sólo lectura (Fine-grained, Contents: read) en $TOKEN_URL y pasalo en TYCON_GITHUB_TOKEN (o pegalo después con harness.js config set github.token). No bajé nada."; exit 1; fi
  say "el repo $REPO no se puede leer sin tu permiso de GitHub: uno de sólo lectura (Fine-grained, Contents: read) en $TOKEN_URL"; printf 'get-harness: pegá el permiso de GitHub y Enter: ' >&2
  IFS= read -rs TOKEN; printf '\n' >&2; TOKEN="$(printf '%s' "$TOKEN" | tr -d '\r\n')"; SAVE=1; if [ -z "$TOKEN" ]; then say "sin permiso no puedo bajar la versión: no bajé nada"; exit 1; fi
}
SHA=""; REF="$TMP/ref.json"; CODE=200; refs() { CODE="$(fetch "$GITBASE/$REPO.git/info/refs?service=git-upload-pack" "$TMP/refs")"; [ "$CODE" = 200 ] && SHA="$(node -e 'const t=require("fs").readFileSync(process.argv[1],"latin1");const m=t.startsWith("001e# service=git-upload-pack\n0000")&&/([0-9a-f]{40}) refs\/heads\/main[\0\n]/.exec(t);if(m)process.stdout.write(m[1])' "$TMP/refs")"; return 0; }   # sin permiso, main de info/refs; 401/404: se pide el permiso; otra cosa: la API
if [ -z "$TOKEN" ] && [ "$PUB" = 1 ]; then refs; case "$CODE" in 401|404) ask ;; esac; fi
[ -z "$SHA" ] && { CODE="$(fetch "$API/repos/$REPO/git/ref/heads/main" "$REF")"; if [ -z "$TOKEN" ] && { [ "$CODE" = 401 ] || [ "$CODE" = 404 ]; }; then ask; CODE="$(fetch "$API/repos/$REPO/git/ref/heads/main" "$REF")"; fi; }
if [ "$CODE" = 401 ] && [ -n "$TOKEN" ] && [ "$PUB" = 1 ]; then T0="$TOKEN"; TOKEN=""; refs; if [ -n "$SHA" ]; then CODE=200; [ "$SAVE" = 1 ] && say "el permiso de GitHub de TYCON_GITHUB_TOKEN venció o se revocó (401), pero no hace falta: el repo del arnés es público. Sigo sin él y no lo guardo."; SAVE=0; else TOKEN="$T0"; CODE=401; fi; fi   # un permiso vencido (401) y el repo se lee sin él: se sigue SIN el permiso y no se guarda; el guardado lo dice install
case "$CODE" in
  200) ;; 403) limited; say "GitHub contestó 403 al pedir la rama main de $REPO. No bajé nada."; exit 1 ;;
  401) say "el permiso de GitHub no vale (401): venció o se revocó. Creá otro en $TOKEN_URL y pegalo con harness.js config set github.token. No bajé nada."; exit 1 ;;
  404) say "GitHub no muestra $REPO (404): sin permiso guardado, o el permiso no ve el repo, o falta aceptar la invitación. El permiso: $TOKEN_URL. No bajé nada."; exit 1 ;;
  000) say "sin red: no pude llegar a $API ($(head -c 160 "$TMP/curl.err" 2>/dev/null | tr '\n' ' ')). No bajé nada."; exit 1 ;; 1) exit 1 ;;
  *) say "GitHub contestó $CODE al pedir la rama main de $REPO. No bajé nada."; exit 1 ;;
esac
[ -n "$SHA" ] || SHA="$(node -e 'process.stdout.write(require(process.argv[1]).object.sha)' "$REF" 2>/dev/null)"
if [ -z "$SHA" ]; then say "la respuesta de GitHub no trae el commit de main de $REPO"; exit 1; fi

# ── 3. la bajada, a la carpeta temporal ───────────────────────────────────────────────────────────────────────
say "bajo $REPO (main $(printf '%.7s' "$SHA")) a una carpeta temporal"
if [ -z "$TOKEN" ] && [ "$PUB" = 1 ]; then CODE="$(fetch "$CODELOAD/$REPO/tar.gz/$SHA" "$TMP/arnes.tgz")"; else CODE="$(fetch "$API/repos/$REPO/tarball/$SHA" "$TMP/arnes.tgz")"; fi
if [ "$CODE" != 200 ]; then [ "$CODE" = 403 ] && limited; [ "$CODE" = 1 ] || say "no pude bajar el comprimido (GitHub contestó $CODE): no quedó nada"; exit 1; fi   # 1: ya dicho
# antes de abrirlo con el tar del sistema se mira el listado: un enlace (l), un enlace duro (h) o una ruta que sale (`..`)
# lo rechazan entero (la verificación de verdad —el árbol de git contra el commit— la hace install con la bajada suya)
NAMES="$(tar -tzf "$TMP/arnes.tgz")" && TYPES="$(tar -tvzf "$TMP/arnes.tgz")" || { say "el comprimido no se pudo leer (¿cortado?): no quedó nada"; exit 1; }
if printf '%s\n' "$TYPES" | grep -qE '^[lh]' || printf '%s\n' "$NAMES" | grep -qE '^/|(^|/)\.\.(/|$)'; then say "el comprimido trae enlaces o rutas que salen de su carpeta: no lo abro, no quedó nada"; exit 1; fi
mkdir -p "$TMP/tree" && tar -xzf "$TMP/arnes.tgz" -C "$TMP/tree" || { say "el comprimido no se pudo desempaquetar: no quedó nada"; exit 1; }
TREE=""; for d in "$TMP"/tree/*/; do TREE="${d%/}"; done
if [ ! -f "$TREE/scripts/setup/harness.js" ]; then say "el comprimido no trae scripts/setup/harness.js: no instalo"; exit 1; fi

# ── 4. la instalación, desde ese árbol y en esta misma terminal ───────────────────────────────────────────────
if [ "$SAVE" = 1 ]; then printf '%s' "$TOKEN" | node "$TREE/scripts/setup/harness.js" config set github.token || { say "no pude guardar el permiso"; exit 1; }; fi
node "$TREE/scripts/setup/harness.js" install --version latest --repo "$REPO" "$@"
