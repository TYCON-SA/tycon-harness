#!/usr/bin/env bash
# harness-team-init.test.sh — el alta guiada de la organización: `harness.js team-init`, por
# EJECUCIÓN, en una HOME de juguete con el arnés instalado desde el GitHub de juguete.
#
# Lo que no se puede perder:
#   · T25 — con terminal pregunta nombre, plataforma, repo del perfil y carpeta; escribe SÓLO los tres archivos
#           obligatorios (team-layer.json, team-profile.json, team-repos.json) con lo contestado: `requires.harness` = la
#           versión instalada, sin bloque `ado` en GitHub, `install.profile: minimal`, `update.apply: ask`; el revisor, el
#           paquete y la skill del ejemplo no se copian.
#   · T26 — con Azure DevOps: `ado.org` en el perfil y el repo del perfil con platform azure, org, proyecto y repo.
#   · T27 — un ejemplo con una clave que la versión instalada no conoce: sale 1 nombrando el archivo y la clave y no
#           escribe nada; un nombre con espacios tampoco escribe nada.
#   · T28 — con git y «s», «s»: commit local, push al repo del perfil (un bare de juguete) y `install --team` apila la
#           capa; el resumen trae la línea para el resto del equipo (get-harness con --team: la de npx no, mientras el
#           paquete no esté publicado) y el enlace de los procesos de la noche.
#   · T29 — sin git imprime los dos comandos; con un push que falla deja la carpeta con su commit, repite los comandos y
#           no ofrece instalar con el perfil.
#   · T30 — `--dry-run` muestra los archivos y valores sin escribir (HOME idéntica); sin arnés instalado sale 2.
#   · T38 `TeamInit_AdversarialRegressions` — en una máquina instalada por versión publicada, el paso 3 y
#           requires.harness usan la versión del estado, no el piso de version.json; la ruta del árbol va entre comillas
#           en la línea pegable; la línea para el equipo no promete que el guion pida el permiso (dice cómo llega); un git
#           que no puede commitear tras «s» sale 1. Y en Azure, `ado.org` lleva la
#           organización codificada, como la URL del repo, y el lector real de la configuración la acepta así.
#   · T46 a T48 — `--local`: el perfil de un dev solo sin dirección ni cuenta, con git en la máquina; sin
#           git sale 1; un paquete en ese perfil se instala con `install --team <carpeta>` y sobrevive a una reinstalación;
#           T10, doctor lo dice como aviso «sin copia de respaldo».
#   · T31 — con red, el ejemplo de juguete (fixtures/team-init-example/) es igual byte a byte al publicado; sin red,
#           «no medido».
#
# Cómo mide, sin red: el laboratorio de harness-lab.sh (servidor de juguete con tres repos: el arnés
# `example-org/example-harness`, el ejemplo `example-org/harness-team-profile-example` y el perfil
# `acme/harness-team-profile`), la terminal de juguete de python3, y `TYCON_TEAM_EXAMPLE_REPO` (variable sólo de pruebas)
# para que team-init baje el ejemplo de juguete. El push va a un bare local por `url.<bare>.insteadOf` en la
# configuración de git del proceso (GIT_CONFIG_COUNT): nunca sale a github.com.
# Sin python3, git o node: UNA línea «NO MEDIDO» y exit 2.
# Correr: bash scripts/tests/harness-team-init.test.sh   (~2 min)

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIX="$RAIZ/scripts/tests/fixtures/team-init-example"
for tool in python3 git node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "⏭ harness-team-init: NO MEDIDO — no hay ${tool} en esta máquina"; exit 2; }
done
[ -f "$RAIZ/scripts/setup/harness/team-init.js" ] || { echo "❌ harness-team-init: no existe scripts/setup/harness/team-init.js"; exit 1; }

FAILURES=0; TOTAL=0
ok() { TOTAL=$((TOTAL+1)); echo "✅ harness-team-init: $1"; }
no() { TOTAL=$((TOTAL+1)); FAILURES=$((FAILURES+1)); echo "❌ harness-team-init: $1"; }
brief() { tail -6 "$1" 2>/dev/null | tr '\n' ' ' | cut -c1-"${2:-400}"; }

BASE="$(mktemp -d /tmp/harness-team-init.XXXXXX)" && BASE="$(cd "$BASE" && pwd -P)" || { echo "❌ harness-team-init: no pude crear la carpeta temporal"; exit 1; }
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$BASE"' EXIT
REAL_NODE="$(command -v node)"; REAL_GIT="$(command -v git)"
# shellcheck source=lib/harness-lab.sh
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
harness_lab_create "$BASE/lab" || { echo "❌ harness-team-init: no pude armar el laboratorio"; exit 1; }
# los commits del laboratorio (el ejemplo de juguete y el que hace team-init) con fecha fija: ningún sha depende de la hora
export GIT_AUTHOR_DATE="2026-10-16T12:00:00Z" GIT_COMMITTER_DATE="2026-10-16T12:00:00Z"
ORG=example-org; NAME=example-harness
harness_lab_release_server "$ORG" "$NAME" || { echo "❌ harness-team-init: el servidor de versiones de juguete no arrancó"; exit 1; }
harness_lab_publish_stable 2026.10.08.1 || { echo "❌ harness-team-init: no pude publicar la versión de juguete"; exit 1; }
export TYCON_UPDATE_APPLY=auto TYCON_THIRD_PARTY=0
unset TYCON_GITHUB_TOKEN TYCON_AZURE_TOKEN HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy

# ── el ejemplo de juguete (los tres archivos del fixture + lo que NO se copia) y el perfil, un bare vacío ──────────────
EX_SEED="$LAB/seed/example"; EX_BARE="$LAB/remotes/example.git"; EX_AUTHOR="$LAB/author/example"
mkdir -p "$EX_SEED/packs/acme" "$EX_SEED/agents" "$EX_SEED/skills/infrastructure/git-workflow"
cp "$FIX"/team-layer.json "$FIX"/team-profile.json "$FIX"/team-repos.json "$EX_SEED/"
printf '{ "name": "acme" }\n' > "$EX_SEED/packs/acme/pack.json"
printf -- '---\nname: acme-logging-reviewer\n---\nrevisor de juguete\n' > "$EX_SEED/agents/acme-logging-reviewer.md"
printf -- '---\nname: git-workflow\n---\nskill de juguete\n' > "$EX_SEED/skills/infrastructure/git-workflow/SKILL.md"
harness_lab_git "$EX_SEED" init -q -b main >/dev/null && harness_lab_git "$EX_SEED" add -A >/dev/null \
  && harness_lab_git "$EX_SEED" commit -q -m "el ejemplo de juguete" >/dev/null \
  && harness_lab_git "$LAB/remotes" clone -q --bare "$EX_SEED" "$EX_BARE" && harness_lab_git "$LAB/author" clone -q "$EX_BARE" "$EX_AUTHOR" \
  || { echo "❌ harness-team-init: no pude armar el ejemplo de juguete"; exit 1; }
GH_BARES="$LAB/remotes/gh"; PROFILE_BARE="$GH_BARES/acme/harness-team-profile.git"
mkdir -p "$GH_BARES/acme" && "$REAL_GIT" init -q --bare -b main "$PROFILE_BARE" || { echo "❌ harness-team-init: no pude armar el bare del perfil"; exit 1; }
# el servidor con los tres repos (el primero es el público del arnés)
kill "$LAB_RELEASE_PROCESS" 2>/dev/null; for i in $(seq 1 30); do kill -0 "$LAB_RELEASE_PROCESS" 2>/dev/null || break; sleep 0.1; done
rm -f "$LAB_RELEASE_DIR/ports.env"
node "$RAIZ/scripts/tests/fixtures/toy-release-server.js" --repo "$LAB_REMOTE_TREE" --org "$ORG" --name "$NAME" \
  --repo "$EX_BARE" --org "$ORG" --name harness-team-profile-example --repo "$PROFILE_BARE" --org acme --name harness-team-profile \
  --git "$REAL_GIT" --control "$LAB_RELEASE_CONTROL" --log "$LAB_RELEASE_LOG" --port-file "$LAB_RELEASE_DIR/ports.env" &
export LAB_RELEASE_PROCESS=$!
for i in $(seq 1 100); do [ -f "$LAB_RELEASE_DIR/ports.env" ] && break; sleep 0.1; done
[ -f "$LAB_RELEASE_DIR/ports.env" ] || { echo "❌ harness-team-init: el servidor de juguete con tres repos no arrancó"; exit 1; }
_harness_lab_release_ports
export TYCON_TEAM_EXAMPLE_REPO="$ORG/harness-team-profile-example"
# git de la máquina de juguete: identidad y github.com → los bares locales (nunca la red)
export GIT_CONFIG_COUNT=3 GIT_CONFIG_KEY_0="url.$GH_BARES/.insteadOf" GIT_CONFIG_VALUE_0="https://github.com/" \
  GIT_CONFIG_KEY_1=user.name GIT_CONFIG_VALUE_1="Persona de laboratorio" GIT_CONFIG_KEY_2=user.email GIT_CONFIG_VALUE_2="lab@example.invalid"

H() { "$REAL_NODE" "$LAB_HOME/.tycon/harness/scripts/setup/harness.js" "$@"; }
jget() { "$REAL_NODE" -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o==null?undefined:o[k],j);console.log(v===undefined?"<ausente>":typeof v==="object"?JSON.stringify(v):String(v))}catch(e){console.log("<ilegible>")}' "$1" "$2"; }
files_in() { [ -d "$1" ] && (cd "$1" && find . -path ./.git -prune -o -type f -print | sed 's|^\./||' | LC_ALL=C sort | tr '\n' ' ') || echo 'no existe'; }

# ══ T30 (b) · sin arnés instalado: sale 2 «instalá primero» ═════════════════════════════════════════════════════════
harness_lab_release_fresh_home
"$REAL_NODE" "$LAB_TREE/scripts/setup/harness.js" team-init --name acme --platform github --profile-repo acme/harness-team-profile --dir "$BASE/sin-arnes" < /dev/null > "$BASE/t30b.out" 2>&1; RC=$?
if [ "$RC" -eq 2 ] && grep -q 'instalá primero' "$BASE/t30b.out" && [ ! -e "$BASE/sin-arnes" ]; then ok "T30 sin arnés instalado: sale 2 «instalá primero» sin escribir nada"
else no "T30 sin arnés (rc $RC): $(brief "$BASE/t30b.out")"; fi

# ── la máquina instalada (para todo lo que sigue) ────────────────────────────────────────────────────────────────
"$REAL_NODE" "$LAB_TREE/scripts/setup/harness.js" install --version latest --profile minimal --integrations none --packs none --yes < /dev/null > "$BASE/install.out" 2>&1 \
  || { echo "❌ harness-team-init: no pude instalar la máquina de juguete: $(brief "$BASE/install.out")"; exit 1; }
VERSION="$(H version --json 2>/dev/null | "$REAL_NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).number)}catch{console.log("")}})')"
[ "$VERSION" = 2026.10.08.1 ] || no "la versión instalada de juguete no es 2026.10.08.1 (es «${VERSION}»)"

# ══ T30 (a) · --dry-run: muestra sin escribir ════════════════════════════════════════════════════════════════════
D="$BASE/perfiles/dry"; HASH0="$(harness_lab_home_hash)"
H team-init --name acme --platform github --profile-repo acme/harness-team-profile --dir "$D" --dry-run < /dev/null > "$BASE/t30a.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ ! -e "$D" ] && [ "$(harness_lab_home_hash)" = "$HASH0" ] && grep -q 'team-layer.json' "$BASE/t30a.out" && grep -q 'team-profile.json' "$BASE/t30a.out" && grep -q 'team-repos.json' "$BASE/t30a.out" && grep -q '"acme"' "$BASE/t30a.out" && grep -q ">= $VERSION" "$BASE/t30a.out"; then
  ok "T30 --dry-run muestra los tres archivos con sus valores y no escribe nada (la carpeta no existe, HOME idéntica)"
else no "T30 --dry-run (rc $RC, carpeta $([ -e "$D" ] && echo existe || echo no)): $(brief "$BASE/t30a.out")"; fi

# ══ T25 · con terminal: pregunta y escribe sólo los tres archivos ═══════════════════════════════════════════════════
D="$BASE/perfiles/gh"
# la última respuesta («no») es la del repo de historias, que se pregunta al final
LAB_PTY_DELAY=3 harness_lab_pty $'acme\ngithub\nacme/harness-team-profile\n'"$D"$'\nn\nno' "$REAL_NODE" "$LAB_HOME/.tycon/harness/scripts/setup/harness.js" team-init > "$BASE/t25.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(files_in "$D")" = "team-layer.json team-profile.json team-repos.json " ]; then ok "T25 con terminal escribe SÓLO los tres archivos obligatorios (sin el revisor, el paquete ni la skill del ejemplo)"
else no "T25 los archivos (rc $RC): $(files_in "$D") — $(brief "$BASE/t25.out")"; fi
if [ "$(jget "$D/team-layer.json" name)" = acme ] && [ "$(jget "$D/team-layer.json" requires.harness)" = ">= $VERSION" ] && [ "$(jget "$D/team-layer.json" schema)" = 1 ]; then ok "T25 team-layer.json: schema 1, name acme, requires.harness = la versión instalada"
else no "T25 team-layer.json: $(cat "$D/team-layer.json" 2>/dev/null | tr '\n' ' ')"; fi
if [ "$(jget "$D/team-profile.json" ado)" = '<ausente>' ] && [ "$(jget "$D/team-profile.json" install.profile)" = minimal ] && [ "$(jget "$D/team-profile.json" update.apply)" = ask ]; then ok "T25 team-profile.json: sin bloque ado (GitHub), install.profile minimal, update.apply ask"
else no "T25 team-profile.json: ado $(jget "$D/team-profile.json" ado) · profile $(jget "$D/team-profile.json" install.profile) · apply $(jget "$D/team-profile.json" update.apply)"; fi
if [ "$(jget "$D/team-repos.json" profile)" = '{"platform":"github","org":"acme","repo":"harness-team-profile"}' ] && [ "$(jget "$D/team-repos.json" public)" = "{\"platform\":\"github\",\"org\":\"$ORG\",\"repo\":\"$NAME\"}" ] && [ "$(jget "$D/team-repos.json" version)" = 1 ]; then
  ok "T25 team-repos.json: version 1, profile = el contestado, public = el repo del arnés que esta máquina instaló"
else no "T25 team-repos.json: $(cat "$D/team-repos.json" 2>/dev/null | tr '\n' ' ' | cut -c1-400)"; fi
if grep -q 'nombre de la organización' "$BASE/t25.out" && grep -q 'git init' "$BASE/t25.out" && grep -q 'github.com/new' "$BASE/t25.out"; then ok "T25 el resumen dice cómo crear el repo privado vacío y, con «no» a git, imprime los comandos"
else no "T25 el resumen: $(brief "$BASE/t25.out" 600)"; fi

# ══ T26 · Azure DevOps ═══════════════════════════════════════════════════════════════════════════════════════════
D="$BASE/perfiles/az"
H team-init --name acme --platform azure --profile-repo https://dev.azure.com/acme/Platform/_git/harness-team-profile --dir "$D" < /dev/null > "$BASE/t26.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(jget "$D/team-profile.json" ado.org)" = https://dev.azure.com/acme ] && [ "$(jget "$D/team-repos.json" profile)" = '{"platform":"azure","org":"acme","project":"Platform","repo":"harness-team-profile"}' ]; then
  ok "T26 con Azure DevOps: ado.org en el perfil y el repo del perfil con platform azure, org, proyecto y repo"
else no "T26 Azure (rc $RC): ado $(jget "$D/team-profile.json" ado) · profile $(jget "$D/team-repos.json" profile) — $(brief "$BASE/t26.out")"; fi
if grep -q 'dev.azure.com/acme/Platform' "$BASE/t26.out" && grep -q 'operations' "$BASE/t26.out"; then ok "T26 el resumen enlaza la página de repos de Azure DevOps y los procesos de la noche"
else no "T26 el resumen de Azure: $(brief "$BASE/t26.out" 600)"; fi
# los guiones de entrada no piden el permiso del repo del equipo; el resumen no lo promete
# y dice cómo llega (en Azure, la credencial del gestor de git)
if grep -q 'gestor de credenciales' "$BASE/t26.out" && ! grep -q 'el instalador se lo pide' "$BASE/t26.out"; then ok "T38 (Azure) la línea para el equipo dice cómo llega la credencial y no promete que el guion la pida"
else no "T38 el permiso del equipo en Azure: $(grep -o '4\. .*' "$BASE/t26.out" | cut -c1-400)"; fi

# ══ T27 · el ejemplo trae una clave que la versión instalada no conoce; un nombre con espacios ═════════════════════
printf '{\n  "schema": 1,\n  "name": "acme",\n  "requires": { "harness": ">= 2026.10.14.13" },\n  "mirrors": []\n}\n' > "$EX_AUTHOR/team-layer.json"
harness_lab_git "$EX_AUTHOR" commit -q -am "una clave nueva" >/dev/null && harness_lab_git "$EX_AUTHOR" push -q origin main >/dev/null 2>&1
D="$BASE/perfiles/clave"
H team-init --name acme --platform github --profile-repo acme/harness-team-profile --dir "$D" < /dev/null > "$BASE/t27a.out" 2>&1; RC=$?
if [ "$RC" -eq 1 ] && grep -q 'team-layer.json' "$BASE/t27a.out" && grep -q 'mirrors' "$BASE/t27a.out" && [ ! -e "$D" ]; then ok "T27 una clave que la versión instalada no conoce: sale 1 nombrando el archivo y la clave, y no escribe nada"
else no "T27 clave nueva (rc $RC, carpeta $([ -e "$D" ] && echo existe || echo no)): $(brief "$BASE/t27a.out")"; fi
harness_lab_git "$EX_AUTHOR" revert --no-edit HEAD >/dev/null && harness_lab_git "$EX_AUTHOR" push -q origin main >/dev/null 2>&1
D="$BASE/perfiles/espacios"
H team-init --name 'acme corp' --platform github --profile-repo acme/harness-team-profile --dir "$D" < /dev/null > "$BASE/t27b.out" 2>&1; RC=$?
if [ "$RC" -ne 0 ] && grep -q 'name' "$BASE/t27b.out" && [ ! -e "$D" ]; then ok "T27/T29 un nombre con espacios: sale $RC diciéndolo, sin escribir nada"
else no "T27 nombre con espacios (rc $RC): $(brief "$BASE/t27b.out")"; fi
H team-init --name acme --platform github --profile-repo 'no es un repo' --dir "$D" < /dev/null > "$BASE/t29dir.out" 2>&1; RC=$?
if [ "$RC" -ne 0 ] && grep -q 'org/nombre\|org/repo' "$BASE/t29dir.out" && [ ! -e "$D" ]; then ok "T29 una dirección de repo que el lector no entiende: sale $RC diciéndolo, sin escribir nada"
else no "T29 dirección inválida (rc $RC): $(brief "$BASE/t29dir.out")"; fi
mkdir -p "$BASE/perfiles/llena" && printf 'algo\n' > "$BASE/perfiles/llena/README.md"
H team-init --name acme --platform github --profile-repo acme/harness-team-profile --dir "$BASE/perfiles/llena" < /dev/null > "$BASE/t21full.out" 2>&1; RC=$?
if [ "$RC" -eq 1 ] && grep -qF "$BASE/perfiles/llena" "$BASE/t21full.out" && [ "$(files_in "$BASE/perfiles/llena")" = "README.md " ]; then ok "T29 una carpeta que existe y no está vacía: sale 1 nombrándola, sin tocarla"
else no "T29 carpeta llena (rc $RC): $(brief "$BASE/t21full.out")"; fi
printf 'un archivo\n' > "$BASE/perfiles/es-archivo"
H team-init --name acme --platform github --profile-repo acme/harness-team-profile --dir "$BASE/perfiles/es-archivo/adentro" < /dev/null > "$BASE/t29mk.out" 2>&1; RC=$?
if [ "$RC" -ne 0 ] && grep -q 'carpeta' "$BASE/t29mk.out"; then ok "T29 una carpeta que no se puede crear: sale $RC diciéndolo"
else no "T29 carpeta imposible (rc $RC): $(brief "$BASE/t29mk.out")"; fi

# ══ T29 · sin git imprime los dos comandos; un push que falla deja el commit y no ofrece instalar ════════════════════
D="$BASE/perfiles/sin-git"; mkdir -p "$LAB/no-git-bin"
env PATH="$LAB/no-git-bin" "$REAL_NODE" "$LAB_HOME/.tycon/harness/scripts/setup/harness.js" team-init --name acme --platform github --profile-repo acme/harness-team-profile --dir "$D" < /dev/null > "$BASE/t29a.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'git init' "$BASE/t29a.out" && grep -q 'git push' "$BASE/t29a.out" && [ ! -d "$D/.git" ] && [ "$(files_in "$D")" = "team-layer.json team-profile.json team-repos.json " ]; then ok "T29 sin git en el PATH: escribe los tres archivos e imprime los dos comandos para pegar"
else no "T29 sin git (rc $RC): $(brief "$BASE/t29a.out" 500)"; fi
D="$BASE/perfiles/push-falla"
LAB_PTY_DELAY=2 harness_lab_pty $'s\ns\nno' "$REAL_NODE" "$LAB_HOME/.tycon/harness/scripts/setup/harness.js" team-init --name acme --platform github --profile-repo acme/no-existe --dir "$D" > "$BASE/t29b.out" 2>&1; RC=$?
if [ "$RC" -eq 1 ] && [ "$("$REAL_GIT" -C "$D" rev-list --count HEAD 2>/dev/null)" = 1 ] && grep -q 'git push' "$BASE/t29b.out" && ! grep -q 'Instalo esta máquina' "$BASE/t29b.out"; then
  ok "T29 un push que falla: sale 1, deja la carpeta con su commit local, repite los comandos y no ofrece instalar con el perfil"
else no "T29 push que falla (rc $RC, commits $("$REAL_GIT" -C "$D" rev-list --count HEAD 2>/dev/null)): $(brief "$BASE/t29b.out" 600)"; fi

# ══ T38 · la versión, la línea pegable y el código de salida ═════════════════════════════
# en una máquina instalada por versión publicada, «la instalada» es la del estado, nunca el piso de version.json
# (numbering: merge-tag): con el piso, install --version bajaría a un commit viejo. La ruta del árbol va entre
# comillas en la línea que se pega (una carpeta personal con espacios)
VJ="$LAB_HOME/.tycon/harness/version.json"; cp "$VJ" "$BASE/version.json.bak"
"$REAL_NODE" -e 'const fs=require("fs"),f=process.argv[1];const j=JSON.parse(fs.readFileSync(f,"utf8"));j.version="2026.10.01.1";j.numbering="merge-tag";fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$VJ"
D="$BASE/perfiles/piso"
H team-init --name acme --platform github --profile-repo acme/harness-team-profile --dir "$D" < /dev/null > "$BASE/t32a.out" 2>&1; RC=$?
cp "$BASE/version.json.bak" "$VJ"
STATE_V="$(jget "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" version.number)"
if [ "$RC" -eq 0 ] && grep -qF -- "--version $STATE_V --team acme/harness-team-profile" "$BASE/t32a.out" && ! grep -q '2026\.10\.01\.1' "$BASE/t32a.out" && [ "$(jget "$D/team-layer.json" requires.harness)" = ">= $STATE_V" ]; then
  ok "T38 (clase 11) instalada por versión publicada: el paso 3 y requires.harness usan la versión del estado ($STATE_V), no el piso de version.json"
else no "T38 la versión instalada (rc $RC, estado $STATE_V, requires $(jget "$D/team-layer.json" requires.harness)): $(grep -o '3\. .*' "$BASE/t32a.out" | cut -c1-300)"; fi
if grep -qE 'node "[^"]+/scripts/setup/harness\.js" install --version' "$BASE/t32a.out"; then ok "T38 (clase 10) la línea para instalar con el perfil lleva la ruta del árbol entre comillas"
else no "T38 la ruta sin comillas: $(grep -o '3\. .*' "$BASE/t32a.out" | cut -c1-300)"; fi
# un git que no puede commitear (sin identidad) tras «s» no sale 0: el perfil no quedó subido
D="$BASE/perfiles/sin-identidad"
LAB_PTY_DELAY=2 harness_lab_pty $'s\nno' env -u EMAIL -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_1=user.useConfigOnly GIT_CONFIG_VALUE_1=true GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
  "$REAL_NODE" "$LAB_HOME/.tycon/harness/scripts/setup/harness.js" team-init --name acme --platform github --profile-repo acme/otro-perfil --dir "$D" > "$BASE/t32c.out" 2>&1; RC=$?
if [ "$RC" -eq 1 ] && grep -q 'no pudo commitear' "$BASE/t32c.out" && ! grep -q 'Instalo esta máquina' "$BASE/t32c.out"; then ok "T38 (clase 13) git sin identidad tras «s»: sale 1 diciéndolo, como el push que falla"
else no "T38 commit fallido (rc $RC): $(grep -m2 -E 'falló|no pudo|Instalo' "$BASE/t32c.out" | tr '\n' ' ' | cut -c1-500)"; fi
# la organización de Azure va codificada en ado.org (como en la URL del repo que arma parseTeam),
# y el lector real de la configuración la acepta así
ADO_OUT="$("$REAL_NODE" -e '
const path=require("path"),fs=require("fs");const R=process.argv[1],F=process.argv[2];
const TI=require(path.join(R,"scripts/setup/harness/team-init.js")),T=require(path.join(R,"scripts/setup/harness/team.js"));
const ex={};for(const f of TI.FILES)ex[f]=fs.readFileSync(path.join(F,f),"utf8");
const bad=[];
for(const org of ["mi org","ñandú (uno)","acme"]){
  const src=T.parseTeam(`https://dev.azure.com/${encodeURIComponent(org)}/Platform/_git/harness-team-profile`);
  if(!src.ok){bad.push(`${org}: parseTeam ${src.problem}`);continue}
  const b=TI.build(ex,{name:"acme",src,version:"2026.10.08.1",publicRepo:"example-org/example-harness"});
  if(!b.ok){bad.push(`${org}: ${b.reason}`);continue}
  const got=JSON.parse(b.texts["team-profile.json"]).ado.org,want=`https://dev.azure.com/${encodeURIComponent(org)}`;
  if(got!==want||!src.url.startsWith(`${want}/`))bad.push(`${org}: ado.org ${got} (quería ${want}, la URL ${src.url})`);
  const v=T.validateProfile(b.texts["team-profile.json"],{readerTree:R});
  if(!v.ok)bad.push(`${org}: el lector lo rechaza (${v.reason})`);else if((v.entries.find((e)=>e.ruta==="ado.org")||{}).valor!==want)bad.push(`${org}: el lector lo lee distinto`);
}
console.log(bad.length?bad.join(" | "):"OK")' "$RAIZ" "$FIX" 2>&1)"
if [ "$ADO_OUT" = OK ]; then ok "T38 (Azure) ado.org lleva la organización codificada, igual que la URL del repo, y el lector real la acepta"
else no "T38 ado.org codificada: $ADO_OUT"; fi

# ══ T28 · con git: commit, push al repo del perfil e install --team ══════════════════════════════════════════════
D="$BASE/perfiles/push"
LAB_PTY_DELAY=3 harness_lab_pty $'s\ns\ns\nno' "$REAL_NODE" "$LAB_HOME/.tycon/harness/scripts/setup/harness.js" team-init --name acme --platform github --profile-repo acme/harness-team-profile --dir "$D" > "$BASE/t28.out" 2>&1; RC=$?
PUSHED="$("$REAL_GIT" -C "$PROFILE_BARE" ls-tree --name-only main 2>/dev/null | tr '\n' ' ')"
if [ "$PUSHED" = "team-layer.json team-profile.json team-repos.json " ]; then ok "T28 con «s» a git: commit local y push al repo del perfil con los tres archivos"
else no "T28 el push (rc $RC; en el bare: «${PUSHED}»): $(brief "$BASE/t28.out" 600)"; fi
TEAM_IN_STATE="$("$REAL_NODE" -e 'try{const s=require(process.argv[1]);console.log(s.team?s.team.repo:"")}catch{console.log("")}' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json")"
if [ "$RC" -eq 0 ] && [ "$TEAM_IN_STATE" = acme/harness-team-profile ]; then ok "T28 con «s» a instalar: install --team apila la capa del perfil recién subido (estado team)"
else no "T28 install --team (rc $RC, estado team «${TEAM_IN_STATE}»): $(brief "$BASE/t28.out" 600)"; fi
# la línea para el resto del equipo es la de npx con --team (el paquete está publicado), con
# los guiones de entrada como el camino «a mano»
if grep -qF 'npx @tyconsa/harness@latest --team acme/harness-team-profile' "$BASE/t28.out" && grep -qF 'bash get-harness.sh -- --team acme/harness-team-profile' "$BASE/t28.out" && grep -qF 'pwsh -File get-harness.ps1 -- --team acme/harness-team-profile' "$BASE/t28.out" && ! grep -qE 'npx (-y|--yes)' "$BASE/t28.out" && grep -q 'pipelines/operations' "$BASE/t28.out"; then
  ok "T28 el resumen trae la línea para el resto del equipo (npx con --team, y los guiones a mano) y el enlace de los procesos de la noche"
else no "T28 el resumen: $(brief "$BASE/t28.out" 600)"; fi
if grep -q 'TYCON_GITHUB_TOKEN' "$BASE/t28.out" && ! grep -q 'el instalador se lo pide' "$BASE/t28.out"; then ok "T38 (clase 12, GitHub) la línea para el equipo dice que el permiso va en TYCON_GITHUB_TOKEN y no promete que el guion lo pida"
else no "T38 el permiso del equipo en GitHub: $(grep -o '4\. .*' "$BASE/t28.out" | cut -c1-400)"; fi

# ══ T45 · el repo de historias ════════════════════════════════════════════════════════════════
# las plantillas genéricas del núcleo (scripts/setup/harness/team-stories/), llenas y en su lugar del repo, al lado de la carpeta del
# perfil; nunca crea el repo ni sube nada: imprime los comandos y la política de rama
no_markers() { ! grep -rqE '\{\{[A-Z0-9_]+\}\}' "$1" 2>/dev/null; }   # los de team-init (`${{ github.… }}` es de GitHub, no un marcador)
GH_FILES=".githooks/pre-commit .github/workflows/stories-gate.yml .specs/README.md .tycon/advisors.yaml AGENTS.md CLAUDE.md README.md "
AZ_FILES=".githooks/pre-commit .specs/README.md .tycon/ado-config.yaml .tycon/advisors.yaml AGENTS.md CLAUDE.md README.md pipelines/stories-gate.yml "
D="$BASE/historias/gh/perfil"; S="$BASE/historias/gh/acme-stories"
H team-init --name acme --platform github --profile-repo acme/harness-team-profile --dir "$D" --stories acme-stories < /dev/null > "$BASE/t45a.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(files_in "$S")" = "$GH_FILES" ] && no_markers "$S" && [ -x "$S/.githooks/pre-commit" ] && grep -q 'Las historias de \*\*acme\*\*' "$S/README.md"; then
  ok "T45 GitHub con --stories: el repo de historias al lado del perfil, en su lugar, sin marcadores y con el hook ejecutable"
else no "T45 GitHub (rc $RC): $(files_in "$S") — $(brief "$BASE/t45a.out" 500)"; fi
if grep -q 'acme-stories' "$BASE/t45a.out" && grep -q 'control requerido' "$BASE/t45a.out" && grep -qF "cd \"$S\" && git init" "$BASE/t45a.out" && [ ! -d "$S/.git" ]; then
  ok "T45 el resumen dice cómo crearlo, los dos comandos y la política de rama de GitHub, sin hacer git"
else no "T45 el resumen de GitHub: $(grep -A3 -i 'historias' "$BASE/t45a.out" | tr '\n' ' ' | cut -c1-600)"; fi
D="$BASE/historias/az/perfil"; S="$BASE/historias/az/acme-stories"
H team-init --name acme --platform azure --profile-repo https://dev.azure.com/acme/Platform/_git/harness-team-profile --dir "$D" --stories acme-stories < /dev/null > "$BASE/t45b.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(files_in "$S")" = "$AZ_FILES" ] && no_markers "$S" && grep -q '^ado_org: https://dev.azure.com/acme$' "$S/.tycon/ado-config.yaml" && grep -q '^ado_project: "Platform"$' "$S/.tycon/ado-config.yaml" && grep -q 'Build validation' "$BASE/t45b.out"; then
  ok "T45 Azure con --stories: ado-config con la organización y el proyecto, el portón en pipelines/ y la política de rama"
else no "T45 Azure (rc $RC): $(files_in "$S") — $(brief "$BASE/t45b.out" 500)"; fi
D="$BASE/historias/no/perfil"
H team-init --name acme --platform github --profile-repo acme/harness-team-profile --dir "$D" --no-stories < /dev/null > "$BASE/t45c.out" 2>&1; RC=$?
H team-init --name acme --platform github --profile-repo acme/harness-team-profile --dir "$BASE/historias/sin/perfil" < /dev/null > "$BASE/t45d.out" 2>&1; RC2=$?
if [ "$RC" -eq 0 ] && [ "$RC2" -eq 0 ] && [ "$(ls "$BASE/historias/no")" = perfil ] && [ "$(ls "$BASE/historias/sin")" = perfil ] && grep -q -- '--stories-only' "$BASE/t45d.out" && ! grep -q -- '--stories-only' "$BASE/t45c.out"; then
  ok "T45 --no-stories no lo arma; sin terminal ni opción no lo arma y dice la línea para armarlo después (--stories-only)"
else no "T45 sin historias (rc $RC/$RC2): no=$(ls "$BASE/historias/no" | tr '\n' ' ') sin=$(ls "$BASE/historias/sin" | tr '\n' ' ') — $(brief "$BASE/t45d.out" 400)"; fi
S="$BASE/historias/solo/acme-stories"
H team-init --stories-only --name acme --platform github --profile-repo acme/harness-team-profile --stories acme-stories --dir "$S" < /dev/null > "$BASE/t45e.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(files_in "$S")" = "$GH_FILES" ] && [ "$(ls "$BASE/historias/solo")" = acme-stories ]; then ok "T45 --stories-only escribe sólo el repo de historias, en --dir"
else no "T45 --stories-only (rc $RC): $(files_in "$S") — $(brief "$BASE/t45e.out" 400)"; fi
H team-init --stories-only --name acme --platform github --profile-repo acme/harness-team-profile --stories acme-stories --dir "$BASE/historias/seco/x" --dry-run < /dev/null > "$BASE/t45f.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ ! -e "$BASE/historias/seco" ] && grep -q '.github/workflows/stories-gate.yml' "$BASE/t45f.out"; then ok "T45 --dry-run lista el repo de historias sin escribir nada"
else no "T45 --dry-run (rc $RC): $(brief "$BASE/t45f.out" 400)"; fi
mkdir -p "$BASE/historias/ocupada" && printf 'algo\n' > "$BASE/historias/ocupada/README.md"
H team-init --stories-only --name acme --platform github --profile-repo acme/harness-team-profile --dir "$BASE/historias/ocupada" < /dev/null > "$BASE/t45g.out" 2>&1; RC=$?
if [ "$RC" -eq 1 ] && grep -qF "$BASE/historias/ocupada" "$BASE/t45g.out" && [ "$(files_in "$BASE/historias/ocupada")" = "README.md " ]; then ok "T45 una carpeta que existe y no está vacía: sale 1 nombrándola, sin tocarla"
else no "T45 carpeta ocupada (rc $RC): $(brief "$BASE/t45g.out")"; fi
TPL="$LAB_HOME/.tycon/harness/scripts/setup/harness/team-stories/README.md"; cp "$TPL" "$BASE/tpl.bak" && printf '\n{{NADIE_LO_LLENA}}\n' >> "$TPL"
H team-init --stories-only --name acme --platform github --profile-repo acme/harness-team-profile --dir "$BASE/historias/marca" < /dev/null > "$BASE/t45h.out" 2>&1; RC=$?
cp "$BASE/tpl.bak" "$TPL"
if [ "$RC" -eq 1 ] && grep -q 'NADIE_LO_LLENA' "$BASE/t45h.out" && [ ! -e "$BASE/historias/marca" ]; then ok "T45 un marcador que team-init no sabe llenar: sale 1 nombrándolo, sin escribir nada"
else no "T45 marcador desconocido (rc $RC): $(brief "$BASE/t45h.out")"; fi
D="$BASE/historias/tty/perfil"
LAB_PTY_DELAY=3 harness_lab_pty $'acme\ngithub\nacme/harness-team-profile\n'"$D"$'\nn\n' "$REAL_NODE" "$LAB_HOME/.tycon/harness/scripts/setup/harness.js" team-init > "$BASE/t45i.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(files_in "$BASE/historias/tty/harness-team-stories")" = "$GH_FILES" ]; then ok "T45 con terminal, Enter acepta el nombre por defecto (<repo del perfil sin -profile>-stories)"
else no "T45 con terminal (rc $RC): $(ls "$BASE/historias/tty" 2>/dev/null | tr '\n' ' ') — $(brief "$BASE/t45i.out" 500)"; fi

# T45 · el contenido del repo de historias y el «no» en la terminal
S="$BASE/historias/gh/acme-stories"
if grep -q 'CLAUDE.md' "$S/AGENTS.md" 2>/dev/null; then ok "T45 AGENTS.md es un puntero a CLAUDE.md"; else no "T45 AGENTS.md: $(cat "$S/AGENTS.md" 2>/dev/null)"; fi
if [ ! -e "$BASE/perfiles/harness-team-stories" ] && grep -q '6\. ¿Armo también el repo de historias' "$BASE/t25.out"; then ok "T45 con terminal, «no» al paso 6 no arma el repo de historias"
else no "T45 «no» en la terminal: $(ls "$BASE/perfiles" | tr '\n' ' ')"; fi
H team-init --stories-only --no-stories --name acme --platform github --profile-repo acme/harness-team-profile < /dev/null > "$BASE/t45j.out" 2>&1; RC=$?
H team-init --stories-only --stories no --name acme --platform github --profile-repo acme/harness-team-profile --dir "$BASE/historias/no-es-nombre" < /dev/null > "$BASE/t45k.out" 2>&1; RC2=$?
if [ "$RC" -eq 2 ] && [ "$RC2" -eq 2 ] && grep -q -- '--no-stories' "$BASE/t45k.out" && [ ! -e "$BASE/historias/no-es-nombre" ]; then ok "T45 --stories-only con --no-stories sale 2; «--stories no» no arma un repo llamado «no» (sale 2 y dice --no-stories)"
else no "T45 --no-stories/«no» (rc $RC/$RC2): $(brief "$BASE/t45j.out" 200) · $(brief "$BASE/t45k.out" 200)"; fi
H team-init --name acme --platform github --profile-repo acme/harness-team-profile --dir "$BASE/historias/seco2/perfil" --stories acme-stories --dry-run < /dev/null > "$BASE/t45l.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ ! -e "$BASE/historias/seco2" ] && grep -q 'el repo de historias acme-stories' "$BASE/t45l.out"; then ok "T45 --dry-run del alta completa con --stories lista también el repo de historias, sin escribir"
else no "T45 --dry-run con --stories (rc $RC): $(brief "$BASE/t45l.out" 300)"; fi
S="$BASE/historias/azure-raro/repo"
H team-init --stories-only --name acme --platform azure --profile-repo 'https://dev.azure.com/acme/Mi%20Proyecto%20(x)/_git/Perfil%20Equipo' --dir "$S" < /dev/null > "$BASE/t45m.out" 2>&1; RC=$?
LINE="$(grep 'git remote add origin' "$BASE/t45m.out" | sed 's/^ *//')"
if [ "$RC" -eq 0 ] && [ "$(files_in "$S")" = "$AZ_FILES" ] && grep -q 'Perfil-Equipo-stories' "$BASE/t45m.out" && bash -n -c "$LINE" 2>/dev/null; then ok "T45 Azure con espacios y paréntesis: el nombre por defecto sirve y la línea para subirlo se puede pegar"
else no "T45 Azure raro (rc $RC): $(brief "$BASE/t45m.out" 400)"; fi
TPLD="$LAB_HOME/.tycon/harness/scripts/setup/harness/team-stories"; mv "$TPLD" "$TPLD.fuera"
H team-init --stories-only --name acme --platform github --profile-repo acme/harness-team-profile --dir "$BASE/historias/sin-plantillas" < /dev/null > "$BASE/t45n.out" 2>&1; RC=$?
H team-init --name acme --platform github --profile-repo acme/harness-team-profile --dir "$BASE/historias/sin-plantillas-2/perfil" < /dev/null > "$BASE/t45o.out" 2>&1; RC2=$?
mv "$TPLD.fuera" "$TPLD"
if [ "$RC" -eq 1 ] && grep -q 'no trae las plantillas' "$BASE/t45n.out" && [ ! -e "$BASE/historias/sin-plantillas" ] && [ "$RC2" -eq 0 ]; then ok "T45 una versión sin las plantillas: pedido a propósito (--stories-only) sale 1 diciéndolo; el alta sin pedirlo sigue y sale 0"
else no "T45 sin plantillas (rc $RC/$RC2): $(brief "$BASE/t45n.out" 300)"; fi

# T45 · un nombre inválido, una plantilla suelta que falta, --stories con --no-stories, y el código
# de salida del paso 6 en el alta completa
H team-init --stories-only --stories 'a b' --name acme --platform github --profile-repo acme/harness-team-profile --dir "$BASE/historias/a-b" < /dev/null > "$BASE/t45p.out" 2>&1; RC=$?
H team-init --name acme --platform github --profile-repo acme/harness-team-profile --dir "$BASE/historias/mezcla/perfil" --stories x --no-stories < /dev/null > "$BASE/t45q.out" 2>&1; RC2=$?
if [ "$RC" -eq 2 ] && grep -q 'no sirve' "$BASE/t45p.out" && [ ! -e "$BASE/historias/a-b" ] && [ "$RC2" -eq 2 ] && [ ! -e "$BASE/historias/mezcla" ]; then ok "T45 un nombre con espacios sale 2 sin escribir; --stories con --no-stories sale 2 antes de escribir nada"
else no "T45 nombre inválido / --stories con --no-stories (rc $RC/$RC2): $(brief "$BASE/t45p.out" 200) · $(brief "$BASE/t45q.out" 200)"; fi
TPLF="$LAB_HOME/.tycon/harness/scripts/setup/harness/team-stories/specs-README.md"; mv "$TPLF" "$TPLF.fuera"
H team-init --stories-only --name acme --platform github --profile-repo acme/harness-team-profile --dir "$BASE/historias/suelta" < /dev/null > "$BASE/t45r.out" 2>&1; RC=$?
mv "$TPLF.fuera" "$TPLF"
if [ "$RC" -eq 1 ] && grep -q 'falta la plantilla' "$BASE/t45r.out" && [ ! -e "$BASE/historias/suelta" ] && ! ls -d "$BASE/historias/suelta.tmp-"* >/dev/null 2>&1; then ok "T45 una plantilla suelta que falta: sale 1 nombrándola, sin dejar nada (ni la carpeta temporal)"
else no "T45 plantilla suelta (rc $RC): $(brief "$BASE/t45r.out" 300)"; fi
mkdir -p "$BASE/historias/ocupada2/acme-stories" && printf 'algo\n' > "$BASE/historias/ocupada2/acme-stories/x.md"
H team-init --name acme --platform github --profile-repo acme/harness-team-profile --dir "$BASE/historias/ocupada2/perfil" --stories acme-stories < /dev/null > "$BASE/t45s.out" 2>&1; RC=$?
if [ "$RC" -eq 1 ] && [ "$(files_in "$BASE/historias/ocupada2/perfil")" = "team-layer.json team-profile.json team-repos.json " ] && grep -q 'ya existe y no está vacía' "$BASE/t45s.out"; then ok "T45 en el alta completa, un repo de historias que no se puede escribir deja el perfil y sale 1 diciéndolo"
else no "T45 alta completa con la carpeta de historias ocupada (rc $RC): $(brief "$BASE/t45s.out" 300)"; fi

# ══ T46 a T48 · el perfil de un dev solo, local ═════════════════════════════════════════════════════════════════
# sin dirección ni cuenta: los dos archivos, git en la máquina con un commit en main, y el arnés lo lee de esa carpeta
D="$BASE/solo/solo-profile"
H team-init --local --name solo --dir "$D" < /dev/null > "$BASE/t46.out" 2>&1; RC=$?
COMMITS="$("$REAL_GIT" -C "$D" rev-list --count main 2>/dev/null)"
if [ "$RC" -eq 0 ] && [ "$(files_in "$D")" = "team-layer.json team-profile.json " ] && [ "$COMMITS" = 1 ] && [ -z "$("$REAL_GIT" -C "$D" status --porcelain 2>/dev/null)" ] && [ "$(jget "$D/team-layer.json" name)" = solo ]; then
  ok "T46 team-init --local: la declaración y el perfil (sin team-repos.json), con git y un commit en main, sin nada sin commitear"
else no "T46 --local (rc $RC, commits «${COMMITS}»): $(files_in "$D") — $(brief "$BASE/t46.out" 500)"; fi
if grep -qF "install --version $VERSION --team \"$D\"" "$BASE/t46.out" && grep -q 'git remote add origin' "$BASE/t46.out" && grep -q 'git push' "$BASE/t46.out" && grep -q 'harness.js install --team' "$BASE/t46.out" && grep -qi 'copia de respaldo' "$BASE/t46.out" && ! grep -q 'github.com/new?owner=' "$BASE/t46.out"; then
  ok "T46 el resumen ofrece instalar con la carpeta y dice cómo subirlo después (remote, push e install --team), sin pedir dirección"
else no "T46 el resumen de --local: $(brief "$BASE/t46.out" 700)"; fi
LAB_PTY_DELAY=3 harness_lab_pty $'solo2\nlocal\n'"$BASE/solo/tty-profile"$'\nn' "$REAL_NODE" "$LAB_HOME/.tycon/harness/scripts/setup/harness.js" team-init --no-stories > "$BASE/t46b.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(files_in "$BASE/solo/tty-profile")" = "team-layer.json team-profile.json " ]; then ok "T46 con terminal, «local» como plataforma arma el perfil local sin preguntar dirección"
else no "T46 con terminal (rc $RC): $(files_in "$BASE/solo/tty-profile") — $(brief "$BASE/t46b.out" 500)"; fi
env PATH="$LAB/no-git-bin" "$REAL_NODE" "$LAB_HOME/.tycon/harness/scripts/setup/harness.js" team-init --local --name solo --dir "$BASE/solo/sin-git" < /dev/null > "$BASE/t47.out" 2>&1; RC=$?
if [ "$RC" -eq 1 ] && [ ! -e "$BASE/solo/sin-git" ] && grep -q 'git' "$BASE/t47.out"; then ok "T47 --local sin git en la máquina: sale 1 diciéndolo, sin escribir la carpeta"
else no "T47 --local sin git (rc $RC): $(brief "$BASE/t47.out" 400)"; fi
# un GIT_DIR heredado (team-init corrido dentro de un hook de git) no decide dónde se escribe
OTRO="$BASE/solo/otro-repo"; mkdir -p "$OTRO" && "$REAL_GIT" -C "$OTRO" -c maintenance.auto=false init -q -b main && "$REAL_GIT" -C "$OTRO" -c maintenance.auto=false commit -q --allow-empty -m "otro"
ANTES_OTRO="$("$REAL_GIT" -C "$OTRO" rev-list --count main)"
GIT_DIR="$OTRO/.git" GIT_WORK_TREE="$OTRO" "$REAL_NODE" "$LAB_HOME/.tycon/harness/scripts/setup/harness.js" team-init --local --name solo --dir "$BASE/solo/con-git-dir" < /dev/null > "$BASE/t47e.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$("$REAL_GIT" -C "$OTRO" rev-list --count main)" = "$ANTES_OTRO" ] && [ "$(env -u GIT_DIR -u GIT_WORK_TREE "$REAL_GIT" -C "$BASE/solo/con-git-dir" rev-list --count main 2>/dev/null)" = 1 ]; then
  ok "T47 con GIT_DIR heredado de otro repo: el commit va al perfil nuevo y el otro repo queda igual"
else no "T47 GIT_DIR heredado (rc $RC, otro: $("$REAL_GIT" -C "$OTRO" rev-list --count main)): $(brief "$BASE/t47e.out" 300)"; fi
# una carpeta como dirección con --platform github o azure no arma un perfil a medias
H team-init --name acme --platform github --profile-repo "$BASE/solo/x" --dir "$BASE/solo/mezcla" < /dev/null > "$BASE/t47b.out" 2>&1; RC=$?
H team-init --name acme --platform azure --profile-repo "$BASE/solo/x" --dir "$BASE/solo/mezcla" --dry-run < /dev/null > "$BASE/t47c.out" 2>&1; RC2=$?
H team-init --local --name solo --profile-repo acme/x --dir "$BASE/solo/mezcla" < /dev/null > "$BASE/t47d.out" 2>&1; RC3=$?
if [ "$RC" -eq 2 ] && [ "$RC2" -eq 2 ] && [ "$RC3" -eq 2 ] && [ ! -e "$BASE/solo/mezcla" ] && grep -q -- '--local' "$BASE/t47b.out"; then
  ok "T47 una carpeta con --platform github/azure, o --local con --profile-repo: sale 2 diciendo --local, sin escribir nada"
else no "T47 plataforma mezclada (rc $RC/$RC2/$RC3): $(brief "$BASE/t47b.out" 300) · $(brief "$BASE/t47c.out" 200) · $(brief "$BASE/t47d.out" 200)"; fi
# T48: el paquete del ejemplo en el perfil local, activo, instalado con --team <carpeta>; sobrevive a una reinstalación
EXP="$RAIZ/examples/packs/svelte-fastapi"
mkdir -p "$D/packs/svelte-fastapi" && cp -R "$EXP/pack.json" "$EXP/agents" "$EXP/exam" "$D/packs/svelte-fastapi/" \
  && "$REAL_NODE" -e 'const f=process.argv[1],j=JSON.parse(require("fs").readFileSync(f,"utf8"));j.packs=Object.assign({},j.packs,{default:["svelte-fastapi"]});require("fs").writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$D/team-profile.json" \
  && "$REAL_GIT" -C "$D" add -A && "$REAL_GIT" -C "$D" commit -q -m "mi paquete" || no "T48 no pude armar el paquete en el perfil local"
# una versión de juguete con el pipeline de ESTA rama adentro: el cargador de paquetes valida el paquete de la capa
mkdir -p "$LAB_AUTHOR_TREE/skills/tycon-pipeline" && cp -R "$RAIZ/skills/tycon-pipeline/scripts" "$LAB_AUTHOR_TREE/skills/tycon-pipeline/" \
  && rm -rf "$LAB_AUTHOR_TREE/skills/tycon-pipeline/scripts/tests" \
  && printf -- '---\nname: tycon-pipeline\ndescription: skill pública de juguete\n---\n' > "$LAB_AUTHOR_TREE/skills/tycon-pipeline/SKILL.md" \
  && harness_lab_publish_stable 2026.10.08.2 || no "T48 no pude publicar la versión de juguete con el pipeline"
H install --version latest --team "$D" --yes < /dev/null > "$BASE/t48a.out" 2>&1; RC=$?
TEAM_IN_STATE="$("$REAL_NODE" -e 'try{const s=require(process.argv[1]);console.log(s.team?s.team.repo:"")}catch{console.log("")}' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json")"
PK="$LAB_HOME/.tycon/harness/packs/svelte-fastapi"
if [ "$RC" -eq 0 ] && [ "$TEAM_IN_STATE" = "$D" ] && [ -f "$PK/pack.json" ] && [ -f "$PK/agents/example-fastapi-reviewer.md" ] && [ -f "$PK/exam/example-fastapi-reviewer.json" ]; then
  ok "T48 install --team <carpeta>: el paquete del perfil local queda instalado (con su examen) y el estado guarda la carpeta"
else no "T48 install --team local (rc $RC, estado «${TEAM_IN_STATE}»): $(ls "$PK" 2>/dev/null | tr '\n' ' ') — $(brief "$BASE/t48a.out" 600)"; fi
H install --version latest --defaults --yes < /dev/null > "$BASE/t48b.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ -f "$PK/pack.json" ]; then ok "T48 una reinstalación (install --version latest) no lo borra: el paquete sigue"
else no "T48 la reinstalación (rc $RC): $(ls "$PK" 2>/dev/null | tr '\n' ' ') — $(brief "$BASE/t48b.out" 600)"; fi
# un cambio commiteado en el perfil local llega con update (el camino de todos los días)
"$REAL_NODE" -e 'const f=process.argv[1],j=JSON.parse(require("fs").readFileSync(f,"utf8"));j.reviewers[0].depth="standard";require("fs").writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$D/packs/svelte-fastapi/pack.json" \
  && "$REAL_GIT" -C "$D" commit -q -am "el revisor de svelte, más profundo" || no "T48 no pude cambiar el paquete"
H update --yes < /dev/null > "$BASE/t48c.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q '"depth": "standard"' "$PK/pack.json" 2>/dev/null; then ok "T48 harness.js update trae el cambio commiteado en el perfil local"
else no "T48 update (rc $RC): $(grep -o '"depth": "[a-z]*"' "$PK/pack.json" 2>/dev/null | head -1) — $(brief "$BASE/t48c.out" 500)"; fi
# T10: el perfil sólo en esta máquina es un aviso amarillo que no cambia el código de doctor
H doctor < /dev/null > "$BASE/t10.out" 2>&1; RC=$?
if grep -q '! .*copia de respaldo' "$BASE/t10.out" && grep -qF "$D" "$BASE/t10.out" && ! grep -q '✗ .*copia de respaldo' "$BASE/t10.out" && ! grep -q '✗ .*svelte-fastapi' "$BASE/t10.out"; then
  ok "T10 doctor con el perfil local: aviso «sin copia de respaldo» con la carpeta, nunca en rojo (doctor salió $RC)"
else no "T10 doctor perfil local (rc $RC): $(grep -i 'respaldo\|svelte' "$BASE/t10.out" | tr '\n' ' ' | cut -c1-500)"; fi
# con el perfil leído de un repo remoto (el de GitHub de juguete de T28), el aviso se va
H install --version latest --team acme/harness-team-profile --yes < /dev/null > "$BASE/t10b.out" 2>&1; RC=$?
H doctor < /dev/null > "$BASE/t10c.out" 2>&1
if [ "$RC" -eq 0 ] && ! grep -q 'copia de respaldo' "$BASE/t10c.out"; then ok "T10 con el perfil en un repo remoto, doctor ya no avisa «sin copia de respaldo»"
else no "T10 perfil remoto (rc $RC): $(grep -i 'respaldo' "$BASE/t10c.out" | cut -c1-300) — $(brief "$BASE/t10b.out" 300)"; fi

# ══ T31 · el ejemplo de juguete es el publicado (con red) ═════════════════════════════════════════════════════════
RAW="https://raw.githubusercontent.com/TYCON-SA/harness-team-profile-example/main"
if "$REAL_NODE" -e 'require("https").get(process.argv[1],{timeout:8000},r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1)).on("timeout",function(){this.destroy();process.exit(1)})' "$RAW/team-layer.json" 2>/dev/null; then
  DIFF=""
  for f in team-layer.json team-profile.json team-repos.json; do
    "$REAL_NODE" -e 'require("https").get(process.argv[1],{timeout:15000},r=>{const c=[];r.on("data",d=>c.push(d)).on("end",()=>{require("fs").writeFileSync(process.argv[2],Buffer.concat(c));process.exit(r.statusCode===200?0:1)})}).on("error",()=>process.exit(1))' "$RAW/$f" "$BASE/pub-$f" 2>/dev/null \
      && cmp -s "$BASE/pub-$f" "$FIX/$f" || DIFF="$DIFF $f"
  done
  if [ -z "$DIFF" ]; then ok "T31 los tres archivos del ejemplo de juguete son iguales byte a byte a los del ejemplo publicado"
  else no "T31 el ejemplo publicado cambió (o no se pudo bajar):$DIFF — copiá los nuevos a scripts/tests/fixtures/team-init-example/ y revisá si team-init los entiende"; fi
else echo "⏭ harness-team-init: T31 NO MEDIDO — sin red hacia raw.githubusercontent.com"; fi

echo ""
if [ "$FAILURES" -eq 0 ]; then echo "✅ harness-team-init: $TOTAL/$TOTAL"; exit 0; fi
echo "❌ harness-team-init: $FAILURES de $TOTAL fallaron"; exit 1
