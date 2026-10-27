#!/usr/bin/env bash
# open-pr-per-finding-github.test.sh — un pull request por hallazgo, también en GitHub.
#
# Corre `scripts/ci/open-pr-per-finding.sh --platform github` contra:
#   · un repo de operaciones local (bare) con `main` y la cola `inbox/dependencies/{pending,promoted,archived}`;
#   · un árbol armado COMO `pipelines/operations/github/prepare-tree.sh`: los datos de `main` y el arnés en un commit local
#     que no se empuja, con la identidad `github-actions[bot]`, `origin` = el repo de operaciones y traído SÓLO `main`
#     (sin ramas de seguimiento de `dependencias/*`: un `git clone` común las traería todas y escondería la segunda noche, T7);
#   · el `gh` de mentira (`scripts/tests/lib/fake-gh.js`) por `TYCON_GH_CMD`, que sirve pull requests, comentarios,
#     revisiones y issues desde un JSON y anota cada llamada.
# Un `git` de mentira delante del verdadero (en `$T/bin`) anota cada invocación y puede fallar el `ls-remote` de una rama.
# Cero red. Los casos se nombran como en la tabla de la story:
#   T2 OpenPrGh_UsageAndOpen · T3 OpenPrGh_Adopt · T4 OpenPrGh_Decisions · T5 OpenPrGh_ForeignNumber
#   T6 OpenPrGh_CloseArchived · T7 OpenPrGh_SecondNight · T8 OpenPrGh_FailuresAreNotEmpty · T13 OpenPrGh_IssueFollowsPr
#   T2b OpenPrGh_NoSave · T8b OpenPrGh_FailuresInListsAndReviews · T13b OpenPrGh_IssueOnlyDeclaredRepos · T14 OpenPrGh_RecordOnlyDoesNotClose
#   T15 OpenPrGh_RejectsMalformedCards · T16 OpenPrGh_MotiveFromDiffComments · T17 OpenPrGh_NightClosedIsNotARejection
# Uso: bash open-pr-per-finding-github.test.sh [T2 T7 …]   (sin argumentos corre todos)

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAKE="$RAIZ/scripts/tests/lib/fake-gh.js"
REALGIT="$(command -v git)"
OPERATIONS_REPO="acme-org/acme-operations"
SHOP="acme-org/acme-shop"
HOY="2026-10-14"
SCRIPT_DEPS="scripts/nightly/dependencies/nightly-dependencies.js"

# Lo que la plantilla deja en el entorno de todo paso que guarda; la guarda del árbol va de mentira (overlay-harness.js).
export HARNESS_TREE=arbol-de-prueba
unset AGENT_TEMPDIRECTORY GUARD_EXIT GIT_LS_REMOTE_FAILS
# Los ganchos globales del dev (core.hooksPath) no corren en los repos de prueba.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null GIT_TERMINAL_PROMPT=0

FALLOS=0; CASO=""; T=""; RC=0
TMPS=()
limpiar() { local d; for d in ${TMPS[@]+"${TMPS[@]}"}; do rm -rf "$d"; done; }
trap limpiar EXIT

caso() { CASO="$1 [$2]"; echo; echo "== $1 $2"; }
ok()  { echo "  ok   — $CASO: $1"; }
mal() {
  echo "  MAL  — $CASO: $1"; FALLOS=$((FALLOS+1))
  if [ -n "$T" ] && [ -s "$T/salida.txt" ]; then tail -n 4 "$T/salida.txt" | cut -c1-220 | sed 's/^/         salida: /'; fi
}
si() { local d="$1"; shift; if "$@" > /dev/null 2>&1; then ok "$d"; else mal "$d"; fi; }
contiene()    { grep -qE -- "$2" <<< "$1"; }
contiene_i()  { grep -qiE -- "$2" <<< "$1"; }
literal()     { grep -qF -- "$2" <<< "$1"; }
no_contiene() { ! grep -qE -- "$2" <<< "$1"; }
sin_rama()    { ! rama_existe "$1"; }
igual()       { [ "$1" = "$2" ]; }
quiero() { [ "${#ARGS[@]}" -eq 0 ] && return 0; local a; for a in "${ARGS[@]}"; do [ "$a" = "$1" ] && return 0; done; return 1; }
ARGS=("$@")

# Los commits de la prueba (los de la semilla y los que hace el guion) con fecha fija y sin el mantenimiento automático
# de git: el resultado no depende de la hora ni de un `gc` que corra en el medio.
export GIT_AUTHOR_DATE="2026-10-14T05:00:00Z" GIT_COMMITTER_DATE="2026-10-14T05:00:00Z"
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false

# ── Fixture ────────────────────────────────────────────────────────────────────────────────────
montar() { # deja el directorio de trabajo en $T
  T="$(mktemp -d)"; TMPS+=("$T")
  mkdir -p "$T/bin"; : > "$T/gh.log"; : > "$T/git.log"
  # El `git` de mentira: anota cada invocación y, con GIT_LS_REMOTE_FAILS=<rama>, hace fallar el `ls-remote` de esa rama.
  printf '#!/usr/bin/env bash\n[ -n "${GIT_LOG:-}" ] && echo "$*" >> "$GIT_LOG"\nif [ -n "${GIT_LS_REMOTE_FAILS:-}" ]; then case " $* " in *" ls-remote "*"refs/heads/${GIT_LS_REMOTE_FAILS}"*) echo "fatal: no pude hablar con el remoto (de prueba)" >&2; exit 128 ;; esac; fi\nexec %s "$@"\n' "$REALGIT" > "$T/bin/git"
  chmod +x "$T/bin/git"
  git init -q --bare "$T/remoto.git"
  git -C "$T/remoto.git" symbolic-ref HEAD refs/heads/main
  git clone -q "$T/remoto.git" "$T/semilla" 2>/dev/null
  git -C "$T/semilla" symbolic-ref HEAD refs/heads/main
  local e
  for e in pending promoted archived; do mkdir -p "$T/semilla/inbox/dependencies/$e"; : > "$T/semilla/inbox/dependencies/$e/.gitkeep"; done
  git -C "$T/semilla" add -A
  git -C "$T/semilla" -c user.email=b@b -c user.name=b commit -q -m base
  git -C "$T/semilla" push -q origin main
}
ficha() { # <pending|promoted|archived> <id> <detectado> [línea extra]...   (PAQUETE cambia el paquete)
  local E="$1" ID="$2" DET="$3"; shift 3
  local V=pendiente; [ "$E" = promoted ] && V=util; [ "$E" = archived ] && V=ignorado
  local D="$T/semilla/inbox/dependencies/$E" l; mkdir -p "$D"
  { echo "id: $ID"; echo "detectado: $DET"; echo "veredicto: $V"; echo "paquete: ${PAQUETE:-browserslist}"
    echo "severidad: high"; echo "noches: 2"
    for l in "$@"; do printf '%s\n' "$l"; done
    echo "ids:"; echo "  - $ID"; echo "repos:"; echo "  - A/A"; echo "avisos:"; echo "  - https://x/GHSA-73wf"; } > "$D/$ID.yaml"
}
estado() { # <js que devuelve el estado extra de gh>   — con P, C, R, I y OPERATIONS_REPO/SHOP a mano
  OPERATIONS_REPO="$OPERATIONS_REPO" SHOP="$SHOP" REMOTE_PATH="$T/remoto.git" node -e '
    const fs = require("fs"); const OPERATIONS_REPO = process.env.OPERATIONS_REPO, SHOP = process.env.SHOP;
    const P = (number, ref, state, x = {}) => ({ number, state, merged_at: null, created_at: "2026-10-11T08:00:00Z",
      closed_at: state === "closed" ? "2026-10-12T09:00:00Z" : null, title: "pr " + number, body: "", head: { ref },
      base: { repo: { full_name: OPERATIONS_REPO } }, user: { login: "github-actions[bot]", type: "Bot" }, requested_reviewers: [], ...x });
    const C = (login, body, at, type = "User") => ({ body, created_at: at, user: { login, type } });
    const R = (login, state, body, at, type = "User") => ({ state, body, submitted_at: at, user: { login, type } });
    const I = (n, state, reason) => ({ number: n, state, state_reason: reason || null, title: "dep " + n, body: "", labels: [], assignees: [],
      user: "github-actions[bot]", created_at: "2026-10-01T00:00:00Z", closed_at: state === "closed" ? "2026-10-10T00:00:00Z" : null,
      closed_by: state === "closed" ? "github-actions[bot]" : null });
    const base = { user: "github-actions[bot]", now: "2026-10-14T05:00:00Z", users: ["lider", "dev1"],
      collaborators: { [OPERATIONS_REPO]: ["lider", "dev1"] }, remotes: { [OPERATIONS_REPO]: process.env.REMOTE_PATH }, pulls: {}, comments: {}, reviews: {}, issues: {} };
    const extra = eval("(" + process.argv[2] + ")");
    fs.writeFileSync(process.argv[1], JSON.stringify({ ...base, ...extra }, null, 2));
  ' "$T/gh.json" "$1"
}
armar_arbol() { # el árbol de una noche: como prepare-tree.sh (datos de main + arnés en un commit local, sólo `main` traído)
  local J="$T/job"; rm -rf "$J"; mkdir -p "$J/scripts/ci" "$J/scripts/nightly"
  cp "$RAIZ/scripts/ci/open-pr-per-finding.sh" "$RAIZ/scripts/ci/legacy-options.sh" "$RAIZ/scripts/ci/push-nightly-data.js" "$J/scripts/ci/"
  cp -R "$RAIZ/scripts/nightly/dependencies" "$RAIZ/scripts/nightly/findings" "$J/scripts/nightly/"
  cp -R "$RAIZ/scripts/lib" "$J/scripts/lib"
  echo 'process.exit(Number(process.env.GUARD_EXIT || 0));' > "$J/scripts/ci/overlay-harness.js"
  # repos.json: por defecto declara SHOP; REPOS_JSON=none lo deja sin repos.json; otro valor se escribe tal cual (para probar uno ilegible).
  # La copia de `dependencies` trae el repos.json real donde exista (el árbol del nocturno lo tiene): «none» lo borra.
  if [ "${REPOS_JSON:-}" = none ]; then
    rm -f "$J/scripts/nightly/dependencies/repos.json"
  else
    local RJ="${REPOS_JSON:-}"
    [ -n "$RJ" ] || RJ="{\"repos\":[{\"producto\":\"Shop\",\"ruta\":\"shop\",\"github\":\"$SHOP\",\"tipo\":\"npm\",\"activo\":true},{\"producto\":\"Off\",\"ruta\":\"off\",\"github\":\"acme-org/apagado\",\"tipo\":\"npm\",\"activo\":false}]}"
    printf '%s\n' "$RJ" > "$J/scripts/nightly/dependencies/repos.json"
  fi
  git -C "$J" init -q; git -C "$J" symbolic-ref HEAD refs/heads/main
  git -C "$T/remoto.git" archive main inbox | tar -x -C "$J"
  git -C "$J" config user.name 'github-actions[bot]'
  git -C "$J" config user.email '41898282+github-actions[bot]@users.noreply.github.com'
  git -C "$J" add -A -f; git -C "$J" commit -q -m "arnés y datos de operaciones [local, no se empuja]"
  git -C "$J" remote add origin "$T/remoto.git"
  git -C "$J" fetch -q origin main
}
publicar() { # lo que se agregó a la semilla va a `main` del bare, y se arma el árbol
  git -C "$T/semilla" add -A
  git -C "$T/semilla" -c user.email=b@b -c user.name=b commit -q -m fixture
  git -C "$T/semilla" push -q origin main
  armar_arbol
}
armar_todo() { # <js del estado>   — la semilla ya tiene las fichas
  estado "$1"; publicar
}

# ── Correr el guion ────────────────────────────────────────────────────────────────────────────
correr_crudo() { # los argumentos tal cual
  ( cd "$T/job" && PATH="$T/bin:$PATH" GIT_LOG="$T/git.log" TYCON_GH_CMD="$FAKE" FAKE_GH_STATE="$T/gh.json" FAKE_GH_LOG="$T/gh.log" \
      bash scripts/ci/open-pr-per-finding.sh "$@" ) > "$T/salida.txt" 2>&1 < /dev/null
  RC=$?
}
correr() { # los argumentos de la noche, más los que se pasen
  correr_crudo --platform github --repo "$OPERATIONS_REPO" --queue inbox/dependencies --branch dependencias --script "$SCRIPT_DEPS" --today "$HOY" "$@"
}
SALIDA() { cat "$T/salida.txt"; }

# ── Lecturas ───────────────────────────────────────────────────────────────────────────────────
enmain()      { git -C "$T/remoto.git" show "main:inbox/dependencies/$1/$2.yaml" 2>/dev/null; }   # <estado> <id>
rama_existe() { git -C "$T/remoto.git" rev-parse -q --verify "refs/heads/$1" > /dev/null 2>&1; }
ramas()       { git -C "$T/remoto.git" for-each-ref --format='%(refname:short)' refs/heads | sort | tr '\n' ' '; }
val()         { node -e 'const fs=require("fs");const st=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const OPERATIONS_REPO=process.argv[3],SHOP=process.argv[4];try{console.log(String(eval(process.argv[2])))}catch(e){console.log("!error: "+e.message)}' "$T/gh.json" "$1" "$OPERATIONS_REPO" "$SHOP"; }
nllam()       { node -e 'const fs=require("fs");const OPERATIONS_REPO=process.argv[3],SHOP=process.argv[4];
  const l=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(x=>JSON.parse(x));
  try{console.log(l.filter((e)=>eval(process.argv[2])).length)}catch(x){console.log("!error: "+x.message)}' "$T/gh.log" "$1" "$OPERATIONS_REPO" "$SHOP"; }   # cuántas llamadas cumplen el predicado (sobre `e`)
cambia_estado() { node -e 'const fs=require("fs");const f=process.argv[1];const st=JSON.parse(fs.readFileSync(f,"utf8"));const OPERATIONS_REPO=process.argv[3],SHOP=process.argv[4];eval(process.argv[2]);fs.writeFileSync(f,JSON.stringify(st,null,2))' "$T/gh.json" "$1" "$OPERATIONS_REPO" "$SHOP"; }

# ══════════════════════════════════════════════════════════════════════════════════════════════
# T2 — uso, apertura y --record-only
# ══════════════════════════════════════════════════════════════════════════════════════════════
if quiero T2; then
  caso "T2 OpenPrGh_UsageAndOpen" "@story-8.32 @ac-2 @ac-3 @ac-10"
  montar
  PAQUETE='@scope/paquete' ficha pending aa11 2026-10-12 "pedidos:" "  - $SHOP: 7"
  armar_todo '{}'
  mkdir -p "$T/job/inbox/watcher/pending"
  HEAD0=$(git -C "$T/job" rev-parse HEAD)

  correr_crudo --platform github --repo "$OPERATIONS_REPO" --queue inbox/watcher --branch vigilante --script "$SCRIPT_DEPS" --today "$HOY"
  si "otra cola que la de dependencias con --platform github sale 2" [ "$RC" = 2 ]
  si "…y dice por qué (nombra la cola de dependencias, no es una opción desconocida)" contiene_i "$(SALIDA)" 'dependencies|dependencias'
  si "…ni es «opción desconocida»" no_contiene "$(SALIDA)" 'desconocida'
  correr_crudo --platform github --queue inbox/dependencies --branch dependencias --script "$SCRIPT_DEPS" --today "$HOY"
  si "sin --repo sale 2" [ "$RC" = 2 ]
  si "…y nombra --repo" literal "$(SALIDA)" '--repo'
  si "…ni es «opción desconocida»" no_contiene "$(SALIDA)" 'desconocida'
  correr_crudo --queue inbox/dependencies --branch dependencias --script "$SCRIPT_DEPS" --today "$HOY"
  si "(AC 1) sin --platform sigue siendo Azure: pide --org, sale 2" [ "$RC" = 2 ]
  si "…y nombra --org" literal "$(SALIDA)" '--org'
  si "ninguna de esas salidas habló con GitHub" [ "$(nllam 'true')" = 0 ]

  correr --record-only
  si "(AC 10) --record-only sale 0" [ "$RC" = 0 ]
  si "…no abre ningún pull request" [ "$(nllam 'e.method==="POST"&&/\/pulls$/.test(e.ruta)')" = 0 ]
  si "…ni empuja la rama" sin_rama dependencias/aa11

  correr --reviewers "lider dev1"
  si "(AC 3) la pasada completa sale 0 sin --org ni --project" [ "$RC" = 0 ]
  si "empuja la rama dependencias/aa11" rama_existe dependencias/aa11
  ARBOL=$(git -C "$T/remoto.git" ls-tree -r --name-only dependencias/aa11 2>/dev/null)
  si "la rama lleva la ficha en promoted/" contiene "$ARBOL" 'inbox/dependencies/promoted/aa11\.yaml'
  si "…y ya no en pending/" no_contiene "$ARBOL" 'pending/aa11\.yaml'
  si "…con el veredicto cambiado a util" contiene "$(git -C "$T/remoto.git" show dependencias/aa11:inbox/dependencies/promoted/aa11.yaml 2>/dev/null)" '^veredicto: util$'
  si "el checkout no se movió: HEAD igual" igual "$HEAD0" "$(git -C "$T/job" rev-parse HEAD)"
  si "…la ficha sigue en pending/ del disco y no está en promoted/" bash -c "[ -f \"\$1/inbox/dependencies/pending/aa11.yaml\" ] && [ ! -f \"\$1/inbox/dependencies/promoted/aa11.yaml\" ]" _ "$T/job"
  si "se abre exactamente un pull request" [ "$(val 'st.pulls[OPERATIONS_REPO].length')" = 1 ]
  si "…contra main, desde la rama de la ficha" [ "$(val 'st.pulls[OPERATIONS_REPO][0].base.ref + " " + st.pulls[OPERATIONS_REPO][0].head.ref')" = "main dependencias/aa11" ]
  si "…con título" [ "$(val 'st.pulls[OPERATIONS_REPO][0].title.length>0')" = true ]
  CUERPO=$(val 'st.pulls[OPERATIONS_REPO][0].body')
  si "…con cuerpo" [ -n "$CUERPO" ]
  si "…leído sin error" no_contiene "$CUERPO" '^!error'
  si "el texto es el de GitHub: los issues de la ficha en una lista con #N" literal "$CUERPO" "- $SHOP#7"
  si "…sin palabras de cierre (mergear no cierra el issue del producto)" bash -c '! grep -qiE "(closes|fixes|resolves)" <<< "$1"' _ "$CUERPO"
  si "los revisores se piden en OTRA llamada, con los de reviewers.dependencies" \
     [ "$(nllam 'e.method==="POST"&&/\/pulls\/\d+\/requested_reviewers$/.test(e.ruta)&&JSON.stringify(e.cuerpo.reviewers)===JSON.stringify(["lider","dev1"])')" = 1 ]
  si "…y la llamada que crea no los lleva" [ "$(nllam 'e.method==="POST"&&/\/pulls$/.test(e.ruta)&&e.cuerpo.reviewers!==undefined')" = 0 ]
  si "el pull request quedó con los revisores" [ "$(val 'st.pulls[OPERATIONS_REPO][0].requested_reviewers.length')" = 2 ]
  FICHA=$(enmain pending aa11)
  si "el guardado de la fase C anota pr: 1" contiene "$FICHA" '^pr: 1$'
  si "…y pr_repo: del repo de operaciones" contiene "$FICHA" "^pr_repo: $OPERATIONS_REPO\$"
  si "los commits de la noche van firmados por la identidad del árbol (github-actions[bot])" [ "$(git -C "$T/remoto.git" log -1 --format=%an main)" = 'github-actions[bot]' ]
  si "…también el de la rama" [ "$(git -C "$T/remoto.git" log -1 --format=%an refs/heads/dependencias/aa11 2>/dev/null)" = 'github-actions[bot]' ]
  si "…y nadie firmó como Azure Pipelines" no_contiene "$(git -C "$T/remoto.git" log --all --format=%an)" 'Azure Pipelines'
  si "el guion no tocó user.name del árbol" [ "$(git -C "$T/job" config user.name)" = 'github-actions[bot]' ]
  si "la rama rehecha (fase D) lleva la ficha con su pr:" contiene "$(git -C "$T/remoto.git" show dependencias/aa11:inbox/dependencies/promoted/aa11.yaml 2>/dev/null)" '^pr: 1$'
  si "los mensajes dicen #1" literal "$(SALIDA)" '#1'
  si "…y no PR !N (eso es de Azure)" no_contiene "$(SALIDA)" 'PR !'
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# T3 — adoptar lo que ya existe, con páginas y ramas de nombre parecido
# ══════════════════════════════════════════════════════════════════════════════════════════════
if quiero T3; then
  caso "T3 OpenPrGh_Adopt" "@story-8.32 @ac-4"
  montar
  ficha pending ad01 2026-10-10
  ficha pending ad02 2026-10-10
  ficha pending ad03 2026-10-10
  armar_todo '(() => {
    const pulls = [P(1, "dependencias/ad01-bis", "open", { leak: "dependencias/ad01" })];   // de otra rama, de nombre parecido, abierto y primero
    for (let i = 2; i <= 100; i++) pulls.push(P(i, "dependencias/ad01-bis", "closed", { leak: "dependencias/ad01" }));   // la página 1 entera
    pulls.push(P(101, "dependencias/ad01", "open"));                  // el suyo: en la página 2
    pulls.push(P(102, "dependencias/ad02", "closed", { created_at: "2026-10-11T08:00:00Z", closed_at: "2026-10-12T09:00:00Z" }));   // dentro de la vida
    pulls.push(P(103, "dependencias/ad03", "closed", { created_at: "2026-10-01T08:00:00Z", closed_at: "2026-10-02T09:00:00Z" }));   // antes de la vida
    return { pulls: { [OPERATIONS_REPO]: pulls }, comments: { [OPERATIONS_REPO + "#102"]: [C("lider", "No aplica en este producto", "2026-10-12T08:00:00Z")] } };
  })()'
  correr
  si "la noche sale 0" [ "$RC" = 0 ]
  F1=$(enmain pending ad01)
  si "ad01: adopta SU pull request (el de la página 2, no el de la rama parecida): pr: 101" contiene "$F1" '^pr: 101$'
  si "…con pr_repo:" contiene "$F1" "^pr_repo: $OPERATIONS_REPO\$"
  si "…y no abre otro" [ "$(nllam 'e.method==="POST"&&/\/pulls$/.test(e.ruta)&&/dependencias\/ad01$/.test(e.cuerpo.head)')" = 0 ]
  si "…recorrió la página 2 de la lista" [ "$(nllam 'e.method==="GET"&&/\/pulls\?/.test(e.ruta)&&/page=2/.test(e.ruta)')" -ge 1 ]
  F2=$(enmain pending ad02)
  si "ad02: adopta el rechazo de esta vida: rechazado: 2026-10-12" contiene "$F2" '^rechazado: 2026-10-12$'
  si "…con pr: 102" contiene "$F2" '^pr: 102$'
  si "…y pr_repo:" contiene "$F2" "^pr_repo: $OPERATIONS_REPO\$"
  si "…y el motivo de la persona" literal "$F2" 'No aplica en este producto'
  si "…y no abre otro pull request" [ "$(nllam 'e.method==="POST"&&/\/pulls$/.test(e.ruta)&&/dependencias\/ad02$/.test(e.cuerpo.head)')" = 0 ]
  F3=$(enmain pending ad03)
  si "ad03: el cerrado de antes de su vida NO se adopta como rechazo" no_contiene "$F3" '^rechazado:'
  si "…se abre uno nuevo para su rama" [ "$(nllam 'e.method==="POST"&&/\/pulls$/.test(e.ruta)&&/dependencias\/ad03$/.test(e.cuerpo.head)')" = 1 ]
  si "…y la ficha anota el nuevo (104), no el viejo (103)" contiene "$F3" '^pr: 104$'
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# T4 — las decisiones: mergeado, rechazado (y su motivo), reabierto
# ══════════════════════════════════════════════════════════════════════════════════════════════
if quiero T4; then
  caso "T4 OpenPrGh_Decisions" "@story-8.32 @ac-5"
  montar
  for n in 1 2 3 4 5 6 7; do ficha pending "dc0$n" 2026-10-10 "pr: 5$n" "pr_repo: $OPERATIONS_REPO"; done
  ficha pending dc07 2026-10-10 "pr: 57" "pr_repo: $OPERATIONS_REPO" "rechazado: 2026-10-11|57" 'motivo_rechazo: "no aplica"'
  ficha pending dc08 2026-10-10 "rechazado: 2026-10-11|58" 'motivo_rechazo: "viejo"'
  armar_todo '(() => {
    const pulls = [
      P(51, "dependencias/dc01", "closed", { merged_at: "2026-10-12T09:00:00Z" }),
      P(52, "dependencias/dc02", "closed"), P(53, "dependencias/dc03", "closed"), P(54, "dependencias/dc04", "closed"),
      P(55, "dependencias/dc05", "closed"), P(56, "dependencias/dc06", "closed"),
      P(57, "dependencias/dc07", "open"), P(58, "dependencias/dc08", "open")];
    const largo = Array.from({ length: 101 }, (_, i) => C("dev1", "c" + i, new Date(Date.UTC(2026, 9, 11, 0, i)).toISOString()));
    largo[100] = C("lider", "motivo final de la segunda pagina", new Date(Date.UTC(2026, 9, 11, 0, 100)).toISOString());
    return { pulls: { [OPERATIONS_REPO]: pulls },
      comments: {
        [OPERATIONS_REPO + "#52"]: [C("lider", "No aplica: es una dependencia de desarrollo", "2026-10-12T08:30:00Z"),
                        C("dependabot[bot]", "Superseded", "2026-10-12T08:45:00Z", "Bot"), C("ci-helper", "Build ok", "2026-10-12T08:50:00Z", "Bot")],
        [OPERATIONS_REPO + "#53"]: [C("lider", "primero lo vi yo", "2026-10-12T10:00:00Z"), C("tycon-bot[bot]", "ruido de bot", "2026-10-12T15:00:00Z", "Bot")],
        [OPERATIONS_REPO + "#54"]: [C("github-actions[bot]", "aviso automatico", "2026-10-12T10:00:00Z", "Bot")],
        [OPERATIONS_REPO + "#56"]: largo },
      reviews: {
        [OPERATIONS_REPO + "#53"]: [R("dev1", "CHANGES_REQUESTED", "Falta el parche, no lo aceptamos", "2026-10-12T12:00:00Z"),
                        R("lider", "COMMENTED", "", "2026-10-12T13:00:00Z"), R("dev1", "PENDING", "borrador sin enviar", "2026-10-12T14:00:00Z")],
        [OPERATIONS_REPO + "#54"]: [R("copilot-reviewer", "COMMENTED", "reseña automática", "2026-10-12T11:00:00Z", "Bot")] } };
  })()'
  correr
  si "la noche sale 0 (un mergeado en pending/ es un aviso, no un fallo)" [ "$RC" = 0 ]
  D1=$(enmain pending dc01)
  si "mergeado con la ficha en pending/: avisa revisar a mano" contiene_i "$(SALIDA)" 'revisar a mano'
  si "…y no toca la ficha" no_contiene "$D1" '^rechazado:'
  D2=$(enmain pending dc02)
  si "cerrado sin merge: rechazado con la fecha de cierre y el número" contiene "$D2" '^rechazado: 2026-10-12$'
  si "…y su pr: 52" contiene "$D2" '^pr: 52$'
  si "…el motivo es el último texto de una PERSONA (no el de los bots)" literal "$D2" 'No aplica: es una dependencia de desarrollo'
  si "…con pr_repo:" contiene "$D2" "^pr_repo: $OPERATIONS_REPO\$"
  si "…y la ficha sigue viva en pending/" contiene "$D2" '^veredicto: pendiente$'
  D3=$(enmain pending dc03)
  si "el motivo puede estar en una revisión Request changes, la más nueva con texto" literal "$D3" 'Falta el parche, no lo aceptamos'
  si "…ni la revisión vacía más nueva ni la PENDING lo pisan" no_contiene "$D3" 'borrador sin enviar'
  si "…ni el comentario de bot más nuevo" no_contiene "$D3" 'ruido de bot'
  si "sólo con bots: \"sin motivo escrito\"" contiene "$(enmain pending dc04)" '^motivo_rechazo: .*sin motivo escrito'
  si "sin nada: \"sin motivo escrito\"" contiene "$(enmain pending dc05)" '^motivo_rechazo: .*sin motivo escrito'
  si "con comentarios en dos páginas: lee el último de la página 2" literal "$(enmain pending dc06)" 'motivo final de la segunda pagina'
  D7=$(enmain pending dc07)
  si "reabierto: se borra el rechazo y su motivo" no_contiene "$D7" '^(rechazado|motivo_rechazo):'
  si "…la ficha conserva su pr:" contiene "$D7" '^pr: 57$'
  D8=$(enmain pending dc08)
  si "rechazo sin pr: y pull request de su rama abierto: lo adopta (pr: 58)" contiene "$D8" '^pr: 58$'
  si "…y borra el rechazo" no_contiene "$D8" '^rechazado:'
  si "…y nunca abre un segundo pull request en toda la noche" [ "$(nllam 'e.method==="POST"&&/\/pulls$/.test(e.ruta)')" = 0 ]
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# T5 — números que no son de este repo
# ══════════════════════════════════════════════════════════════════════════════════════════════
if quiero T5; then
  caso "T5 OpenPrGh_ForeignNumber" "@story-8.32 @ac-6 @ac-7"
  montar
  ficha pending fn01 2026-09-10 "pr: 77" "rechazado: 2026-09-20|77" 'motivo_rechazo: "no aplica"'
  ficha pending fn02 2026-09-10 "pr: 78"
  ficha pending fn03 2026-09-10 "pr: 5" "pr_repo: otro-org/otro-repo"
  ficha pending fn04 2026-09-10 "pr: 6" "pr_repo: otro-org/otro-repo" "rechazado: 2026-09-21|6" 'motivo_rechazo: "no aplica"'
  ficha archived fn05 2026-09-10 "pr: 79"
  armar_todo '{ pulls: { [OPERATIONS_REPO]: [P(78, "otra/rama", "open"), P(79, "x/y", "open"), P(90, "dependencias/fn02", "open")] } }'
  ORIG1=$(cat "$T/semilla/inbox/dependencies/pending/fn01.yaml"); ORIG4=$(cat "$T/semilla/inbox/dependencies/pending/fn04.yaml")
  correr
  si "la noche sale 0" [ "$RC" = 0 ]
  si "con pr: de Azure o de otro repo NO se consulta ese número (ni se llama a otro repo)" \
     [ "$(nllam '/pulls\/(77|78|79|5|6)$/.test(e.ruta) || /otro-org/.test(e.ruta)')" = 0 ]
  si "un rechazo ya anotado se respeta (fn01, pr: de Azure): la ficha no cambia" [ "$(enmain pending fn01)" = "$ORIG1" ]
  si "…lo mismo con el pr: de otro repo (fn04)" [ "$(enmain pending fn04)" = "$ORIG4" ]
  si "…y no abre nada para esas dos" [ "$(nllam 'e.method==="POST"&&/\/pulls$/.test(e.ruta)&&/(fn01|fn04)$/.test(e.cuerpo.head)')" = 0 ]
  F2=$(enmain pending fn02)
  si "sin rechazo y con pr: de Azure se sigue como sin pr:: adopta el de su rama (90)" contiene "$F2" '^pr: 90$'
  si "…con pr_repo:" contiene "$F2" "^pr_repo: $OPERATIONS_REPO\$"
  F3=$(enmain pending fn03)
  si "sin rechazo y con pr: de otro repo se abre uno propio (91)" contiene "$F3" '^pr: 91$'
  si "…con pr_repo: de acá" contiene "$F3" "^pr_repo: $OPERATIONS_REPO\$"
  si "…y ya no queda el repo ajeno" no_contiene "$F3" 'otro-org'
  si "…y es el único pull request que abre la noche" [ "$(nllam 'e.method==="POST"&&/\/pulls$/.test(e.ruta)')" = 1 ]
  si "archivada con pr: de Azure: avisa (nombra la ficha)" contiene "$(SALIDA)" 'fn05'
  si "…anota pr_cerrado: con la fecha" contiene "$(enmain archived fn05)" "^pr_cerrado: $HOY\$"
  si "…y no cierra nada en GitHub" [ "$(nllam 'e.method==="PATCH"')" = 0 ]
  armar_arbol; : > "$T/gh.log"
  correr
  si "la noche siguiente sale 0" [ "$RC" = 0 ]
  si "…y no vuelve a avisar de la archivada (aviso una vez)" no_contiene "$(SALIDA)" 'fn05'
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# T6 — cerrar el pull request de lo archivado o resuelto
# ══════════════════════════════════════════════════════════════════════════════════════════════
if quiero T6; then
  caso "T6 OpenPrGh_CloseArchived" "@story-8.32 @ac-7"
  montar
  ficha archived ca01 2026-10-01 "pr: 20" "pr_repo: $OPERATIONS_REPO"
  ficha promoted ca02 2026-10-01 "pr: 21" "pr_repo: $OPERATIONS_REPO" "resuelto: 2026-10-13"
  ficha promoted ca03 2026-10-01 "pr: 22" "pr_repo: $OPERATIONS_REPO"
  ficha archived ca04 2026-10-01 "pr: 23" "pr_repo: $OPERATIONS_REPO"
  armar_todo '{ pulls: { [OPERATIONS_REPO]: [P(20, "dependencias/ca01", "open"), P(21, "dependencias/ca02", "open"), P(22, "dependencias/ca03", "open"),
                                  P(23, "dependencias/ca04", "closed", { closed_at: "2026-10-09T00:00:00Z" })] } }'
  for r in ca01 ca02 ca03; do git -C "$T/semilla" push -q origin "main:refs/heads/dependencias/$r"; done
  correr
  si "la noche sale 0" [ "$RC" = 0 ]
  si "archivada con el pull request abierto: lo cierra (PATCH state closed)" [ "$(nllam 'e.method==="PATCH"&&/\/pulls\/20$/.test(e.ruta)&&e.cuerpo.state==="closed"')" = 1 ]
  si "…con un comentario que dice por qué" [ "$(nllam 'e.method==="POST"&&/\/issues\/20\/comments$/.test(e.ruta)&&String(e.cuerpo.body).length>10')" = 1 ]
  si "…borra la rama" sin_rama dependencias/ca01
  si "…y anota pr_cerrado:" contiene "$(enmain archived ca01)" "^pr_cerrado: $HOY\$"
  si "resuelta en promoted/: lo cierra" [ "$(nllam 'e.method==="PATCH"&&/\/pulls\/21$/.test(e.ruta)&&e.cuerpo.state==="closed"')" = 1 ]
  si "…con comentario" [ "$(nllam 'e.method==="POST"&&/\/issues\/21\/comments$/.test(e.ruta)')" = 1 ]
  si "…y borra la rama" sin_rama dependencias/ca02
  si "…con pr_cerrado:" contiene "$(enmain promoted ca02)" "^pr_cerrado: $HOY\$"
  si "aceptada que sigue viva (sin resuelto:): su pull request queda abierto" [ "$(val 'st.pulls[OPERATIONS_REPO].find(p=>p.number===22).state')" = open ]
  si "…y su rama queda" rama_existe dependencias/ca03
  si "…y su ficha no se anota" no_contiene "$(enmain promoted ca03)" '^pr_cerrado:'
  si "archivada cuyo pull request ya estaba cerrado: no se cierra otra vez" [ "$(nllam 'e.method==="PATCH"&&/\/pulls\/23$/.test(e.ruta)')" = 0 ]
  si "…y se anota la fecha en que cerró" contiene "$(enmain archived ca04)" '^pr_cerrado: 2026-10-09$'
  si "los dos pull requests quedaron cerrados en GitHub" [ "$(val 'st.pulls[OPERATIONS_REPO].filter(p=>[20,21].includes(p.number)&&p.state==="closed").length')" = 2 ]
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# T7 — la segunda noche: la rama ya empujada y un árbol que trae sólo main
# ══════════════════════════════════════════════════════════════════════════════════════════════
if quiero T7; then
  caso "T7 OpenPrGh_SecondNight" "@story-8.32 @ac-8"
  montar
  ficha pending sn01 2026-10-12
  armar_todo '{ no_pr_create: true }'
  correr
  si "primera noche (crear da 403): sale 1" [ "$RC" = 1 ]
  si "…la rama quedó empujada" rama_existe dependencias/sn01
  si "…con la punta esperada vacía (la rama no existía)" contiene "$(cat "$T/git.log")" 'push.*--force-with-lease=refs/heads/dependencias/sn01:( |$)'
  si "…y no hay pull request" [ "$(val '(st.pulls[OPERATIONS_REPO]||[]).length')" = 0 ]
  si "…ni pr: en la ficha" no_contiene "$(enmain pending sn01)" '^pr:'
  PUNTA=$(git -C "$T/remoto.git" rev-parse -q --verify refs/heads/dependencias/sn01 2>/dev/null)
  cambia_estado 'st.no_pr_create=false'
  armar_arbol; : > "$T/gh.log"; : > "$T/git.log"
  si "(el árbol de la segunda noche trae sólo main: sin rama de seguimiento de dependencias/*)" [ "$(git -C "$T/job" branch -r --format='%(refname:short)' | tr '\n' ' ')" = 'origin/main ' ]
  correr
  si "segunda noche (con el ajuste prendido): sale 0" [ "$RC" = 0 ]
  si "…empuja con la punta real de la rama como valor esperado" contiene "$(cat "$T/git.log")" "push.*--force-with-lease=refs/heads/dependencias/sn01:$PUNTA"
  si "…le preguntó la punta al remoto antes (ls-remote)" contiene "$(cat "$T/git.log")" 'ls-remote.*refs/heads/dependencias/sn01'
  si "…abre UN pull request" [ "$(val 'st.pulls[OPERATIONS_REPO].length')" = 1 ]
  si "…sobre la rama que ya estaba" [ "$(val 'st.pulls[OPERATIONS_REPO][0].head.ref')" = dependencias/sn01 ]
  si "…no queda una segunda rama" [ "$(ramas)" = 'dependencias/sn01 main ' ]
  si "…y la ficha anota el pull request" contiene "$(enmain pending sn01)" '^pr: 1$'
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# T8 — preguntar mal no es «no hay ninguno»
# ══════════════════════════════════════════════════════════════════════════════════════════════
s8() { # <nombre> <js del estado> <texto crudo que debe salir> [rama cuyo ls-remote falla]
  local NOMBRE="$1" ESTADO="$2" TEXTO="$3" LS="${4:-}"
  montar
  ficha pending f1 2026-10-12 "pr: 31" "pr_repo: $OPERATIONS_REPO"
  ficha pending f2 2026-10-12
  armar_todo "$ESTADO"
  local ORIG; ORIG=$(cat "$T/semilla/inbox/dependencies/pending/f1.yaml")
  [ -z "$LS" ] || export GIT_LS_REMOTE_FAILS="$LS"
  correr
  unset GIT_LS_REMOTE_FAILS
  si "$NOMBRE: sale 1" [ "$RC" = 1 ]
  si "$NOMBRE: la ficha que falló no se toca" [ "$(enmain pending f1)" = "$ORIG" ]
  si "$NOMBRE: se imprime el error crudo" literal "$(SALIDA)" "$TEXTO"
  si "$NOMBRE: las demás se procesan (f2 tiene su pull request)" contiene "$(enmain pending f2)" '^pr: [0-9]+$'
}
if quiero T8; then
  caso "T8 OpenPrGh_FailuresAreNotEmpty" "@story-8.32 @ac-9"
  PR31='P(31, "dependencias/f1", "open")'
  s8 "401" "{ pulls: { [OPERATIONS_REPO]: [$PR31] }, fail: { [\"GET repos/\" + OPERATIONS_REPO + \"/pulls/31\"]: { status: 401, message: \"Bad credentials\" } } }" 'Bad credentials'
  s8 "403" "{ pulls: { [OPERATIONS_REPO]: [$PR31] }, fail: { [\"GET repos/\" + OPERATIONS_REPO + \"/pulls/31\"]: { status: 403, message: \"Resource not accessible by integration\" } } }" 'Resource not accessible by integration'
  s8 "404 del repo" "{ pulls: { [OPERATIONS_REPO]: [$PR31] }, fail: { [\"GET repos/\" + OPERATIONS_REPO + \"/pulls/31\"]: { status: 404, message: \"Not Found\" } } }" 'Not Found'
  s8 "respuesta que no es JSON" "{ pulls: { [OPERATIONS_REPO]: [$PR31] }, fail: { [\"GET repos/\" + OPERATIONS_REPO + \"/pulls/31\"]: { raw: \"<html>502 Bad Gateway</html>\" } } }" 'f1'
  montar
  ficha pending f1 2026-10-12
  ficha pending f2 2026-10-12
  armar_todo '{}'
  ORIG=$(cat "$T/semilla/inbox/dependencies/pending/f1.yaml")
  export GIT_LS_REMOTE_FAILS=dependencias/f1; correr; unset GIT_LS_REMOTE_FAILS
  si "ls-remote falla (ficha nueva): sale 1" [ "$RC" = 1 ]
  si "…la ficha no se toca" igual "$(enmain pending f1)" "$ORIG"
  si "…y no se empuja su rama" sin_rama dependencias/f1
  si "…no se abre su pull request" [ "$(nllam 'e.method==="POST"&&/\/pulls$/.test(e.ruta)&&/dependencias\/f1$/.test(e.cuerpo.head)')" = 0 ]
  si "…se imprime el error crudo" literal "$(SALIDA)" 'no pude hablar con el remoto'
  si "…y la otra sí se abre" rama_existe dependencias/f2

  montar
  ficha pending f1 2026-10-12
  armar_todo '{ fail: { ["GET repos/" + OPERATIONS_REPO + "/pulls?"]: { status: 500, message: "Server Error" } } }'
  ORIG=$(cat "$T/semilla/inbox/dependencies/pending/f1.yaml")
  correr
  si "la lista de pull requests de la rama falla (500): sale 1" [ "$RC" = 1 ]
  si "…nunca se lee como «no hay ninguno»: no crea pull requests" [ "$(nllam 'e.method==="POST"&&/\/pulls$/.test(e.ruta)')" = 0 ]
  si "…ni empuja la rama" sin_rama dependencias/f1
  si "…la ficha no se toca" igual "$(enmain pending f1)" "$ORIG"
  si "…y se imprime el error crudo" literal "$(SALIDA)" 'Server Error'

  montar
  ficha pending f1 2026-10-12 "pr: 32" "pr_repo: $OPERATIONS_REPO"
  armar_todo '{ pulls: { [OPERATIONS_REPO]: [P(32, "dependencias/f1", "closed")] }, fail: { ["GET repos/" + OPERATIONS_REPO + "/issues/32/comments"]: { status: 500, message: "Server Error" } } }'
  ORIG=$(cat "$T/semilla/inbox/dependencies/pending/f1.yaml")
  correr
  si "no se pudo leer el motivo del rechazo: sale 1" [ "$RC" = 1 ]
  si "…y NO se anota «sin motivo escrito» (mañana se reintenta): la ficha no cambia" igual "$(enmain pending f1)" "$ORIG"

  montar
  ficha pending f2 2026-10-12
  armar_todo '{ no_pr_create: true }'
  ORIG=$(cat "$T/semilla/inbox/dependencies/pending/f2.yaml")
  correr
  si "el 403 de «GitHub Actions is not permitted to create or approve pull requests»: sale 1" [ "$RC" = 1 ]
  si "…nombra el ajuste del repo (Allow GitHub Actions to create and approve pull requests)" contiene_i "$(SALIDA)" 'Allow GitHub Actions to create and approve pull requests'
  si "…y el de la organización" contiene_i "$(SALIDA)" 'organi[sz]ation|organización'
  si "…y la ficha no se anota" igual "$(enmain pending f2)" "$ORIG"
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# T13 — el issue sigue al pull request (decisión 12)
# ══════════════════════════════════════════════════════════════════════════════════════════════
if quiero T13; then
  caso "T13 OpenPrGh_IssueFollowsPr" "@story-8.32 @ac-11b"
  montar
  ficha promoted is01 2026-10-01 "pr: 41" "pr_repo: $OPERATIONS_REPO" "pedidos:" "  - $SHOP: 7"
  ficha pending  is02 2026-10-01 "pr: 42" "pr_repo: $OPERATIONS_REPO" "pedidos:" "  - $SHOP: 8"
  ficha pending  is03 2026-10-01 "pr: 43" "pr_repo: $OPERATIONS_REPO" "rechazado: 2026-10-12|43" 'motivo_rechazo: "no aplica"' "alineado: 43:closed" "pedidos:" "  - $SHOP: 9"
  ficha promoted is04 2026-10-01 "pr: 44" "pr_repo: $OPERATIONS_REPO" "pedidos:" "  - $SHOP: 10"
  armar_todo '(() => {
    const persona = (i, quien) => ({ ...i, closed_by: quien });
    return {
      pulls: { [OPERATIONS_REPO]: [P(41, "dependencias/is01", "closed", { merged_at: "2026-10-13T09:00:00Z" }), P(42, "dependencias/is02", "closed"),
                       P(43, "dependencias/is03", "open"), P(44, "dependencias/is04", "closed", { merged_at: "2026-10-13T09:00:00Z" })] },
      comments: { [OPERATIONS_REPO + "#42"]: [C("lider", "no aplica: sólo dev", "2026-10-12T08:00:00Z")],
                  [SHOP + "#9"]: [C("github-actions[bot]", "Cerrado por la noche: el pull request " + OPERATIONS_REPO + "#43 se cerró sin mergear. <!-- tycon-nocturno -->", "2026-10-12T10:00:00Z", "Bot")] },
      issues: { [SHOP]: [persona(I(7, "closed", "not_planned"), "dev1"), I(8, "open"), I(9, "closed", "not_planned"), I(10, "closed", "completed")] } };
  })()'
  correr
  si "la noche sale 0" [ "$RC" = 0 ]
  si "mergeado + issue cerrado como not planned: reabre el issue" [ "$(nllam 'e.method==="PATCH"&&e.ruta==="repos/"+SHOP+"/issues/7"&&e.cuerpo.state==="open"')" = 1 ]
  si "…con un comentario que nombra el pull request y lleva la marca de la noche" \
     [ "$(nllam 'e.method==="POST"&&e.ruta==="repos/"+SHOP+"/issues/7/comments"&&e.cuerpo.body.includes(OPERATIONS_REPO+"#41")&&e.cuerpo.body.includes("<!-- tycon-nocturno -->")')" = 1 ]
  si "…el issue quedó abierto" [ "$(val 'st.issues[SHOP].find(i=>i.number===7).state')" = open ]
  si "cerrado sin merge + issue abierto: lo cierra como not planned" [ "$(nllam 'e.method==="PATCH"&&e.ruta==="repos/"+SHOP+"/issues/8"&&e.cuerpo.state==="closed"&&e.cuerpo.state_reason==="not_planned"')" = 1 ]
  si "…con un comentario que nombra el pull request, el motivo y la marca" \
     [ "$(nllam 'e.method==="POST"&&e.ruta==="repos/"+SHOP+"/issues/8/comments"&&e.cuerpo.body.includes(OPERATIONS_REPO+"#42")&&e.cuerpo.body.includes("no aplica: sólo dev")&&e.cuerpo.body.includes("<!-- tycon-nocturno -->")')" = 1 ]
  si "pull request reabierto + issue cerrado por la noche: reabre el issue" [ "$(nllam 'e.method==="PATCH"&&e.ruta==="repos/"+SHOP+"/issues/9"&&e.cuerpo.state==="open"')" = 1 ]
  si "…con un comentario que nombra el pull request y la marca" \
     [ "$(nllam 'e.method==="POST"&&e.ruta==="repos/"+SHOP+"/issues/9/comments"&&e.cuerpo.body.includes(OPERATIONS_REPO+"#43")&&e.cuerpo.body.includes("<!-- tycon-nocturno -->")')" = 1 ]
  si "…y el rechazo de la ficha se borró" no_contiene "$(enmain pending is03)" '^rechazado:'
  si "un issue cerrado como completed (arreglado) no se toca" [ "$(nllam '/issues\/10/.test(e.ruta)&&(e.method==="PATCH"||e.method==="POST")')" = 0 ]
  si "se anota alineado: 41:merged" contiene "$(enmain promoted is01)" '^alineado: 41:merged$'
  si "…alineado: 42:closed" contiene "$(enmain pending is02)" '^alineado: 42:closed$'
  si "…alineado: 43:reopened" contiene "$(enmain pending is03)" '^alineado: 43:reopened$'
  # la segunda noche: una persona vuelve a cerrar el issue 7 como not planned; la decisión ya se alineó una vez
  cambia_estado 'const i=st.issues[SHOP].find(x=>x.number===7);Object.assign(i,{state:"closed",state_reason:"not_planned",closed_by:"dev1"})'
  armar_arbol; : > "$T/gh.log"
  correr
  si "la segunda noche sale 0" [ "$RC" = 0 ]
  si "…no repite ningún cambio de issue (se hizo una vez por decisión, aunque alguien lo vuelva a cerrar)" \
     [ "$(nllam '/\/issues\/\d+/.test(e.ruta)&&(e.method==="PATCH"||e.method==="POST")')" = 0 ]
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# T2b — --no-save: anota en el disco y no guarda ni abre nada
# ══════════════════════════════════════════════════════════════════════════════════════════════
if quiero T2b; then
  caso "T2b OpenPrGh_NoSave" "@story-8.32 @ac-10"
  montar
  ficha pending nb01 2026-10-12
  ficha pending nb02 2026-10-10
  armar_todo '{ pulls: { [OPERATIONS_REPO]: [P(61, "dependencias/nb02", "closed")] }, comments: { [OPERATIONS_REPO + "#61"]: [C("lider", "no aplica acá", "2026-10-12T08:00:00Z")] } }'
  MAIN0=$(git -C "$T/remoto.git" rev-parse main)
  correr --record-only --no-save
  si "--record-only --no-save sale 0" [ "$RC" = 0 ]
  si "…main del remoto no cambia" igual "$MAIN0" "$(git -C "$T/remoto.git" rev-parse main)"
  si "…no crea ninguna rama" [ "$(ramas)" = 'main ' ]
  si "…ni ningún pull request" [ "$(nllam 'e.method==="POST"&&/\/pulls$/.test(e.ruta)')" = 0 ]
  DISCO=$(cat "$T/job/inbox/dependencies/pending/nb02.yaml")
  si "…en el DISCO la ficha con el pull request cerrado queda con rechazado:" contiene "$DISCO" '^rechazado: 2026-10-12'
  si "…y con pr_repo:" contiene "$DISCO" "^pr_repo: $OPERATIONS_REPO\$"
  si "…y main sigue sin el rechazo" no_contiene "$(enmain pending nb02)" '^rechazado:'
  armar_arbol; : > "$T/gh.log"
  correr --no-save
  si "--no-save sin --record-only sale 0" [ "$RC" = 0 ]
  si "…tampoco abre ningún pull request" [ "$(nllam 'e.method==="POST"&&/\/pulls$/.test(e.ruta)')" = 0 ]
  si "…ni empuja ramas" [ "$(ramas)" = 'main ' ]
  si "…y main sigue igual" igual "$MAIN0" "$(git -C "$T/remoto.git" rev-parse main)"
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# T8b — fallos en las listas y en las revisiones; un revisor rechazado es un aviso
# ══════════════════════════════════════════════════════════════════════════════════════════════
if quiero T8b; then
  caso "T8b OpenPrGh_FailuresInListsAndReviews" "@story-8.32 @ac-9"
  montar
  ficha pending g1 2026-10-12
  armar_todo '{ fail: { ["GET repos/" + OPERATIONS_REPO + "/pulls?"]: { status: 500, message: "Server Error" } } }'
  ORIG=$(cat "$T/semilla/inbox/dependencies/pending/g1.yaml")
  correr
  si "la lista por rama falla (500): sale 1" [ "$RC" = 1 ]
  si "…la ficha no se toca" igual "$(enmain pending g1)" "$ORIG"
  si "…no abre pull request ni empuja la rama" [ "$(nllam 'e.method==="POST"&&/\/pulls$/.test(e.ruta)')" = 0 ] && sin_rama dependencias/g1
  si "…y se imprime el error crudo" literal "$(SALIDA)" 'Server Error'

  montar
  ficha pending g2 2026-10-12 "pr: 32" "pr_repo: $OPERATIONS_REPO"
  armar_todo '{ pulls: { [OPERATIONS_REPO]: [P(32, "dependencias/g2", "closed")] }, comments: { [OPERATIONS_REPO + "#32"]: [C("lider", "no aplica", "2026-10-12T08:00:00Z")] },
    fail: { ["GET repos/" + OPERATIONS_REPO + "/pulls/32/reviews"]: { status: 500, message: "Server Error" } } }'
  ORIG=$(cat "$T/semilla/inbox/dependencies/pending/g2.yaml")
  correr
  si "las revisiones del pull request cerrado fallan (500): sale 1" [ "$RC" = 1 ]
  si "…no se anota el rechazo: la ficha no cambia" igual "$(enmain pending g2)" "$ORIG"
  si "…y se imprime el error crudo" literal "$(SALIDA)" 'Server Error'

  montar
  ficha pending g3 2026-10-12
  armar_todo '{ collaborators: { [OPERATIONS_REPO]: ["dev1"] } }'
  correr --reviewers "lider"
  si "un revisor que GitHub rechaza (422): la noche sale 0" [ "$RC" = 0 ]
  si "…el pull request se abre igual" [ "$(val 'st.pulls[OPERATIONS_REPO].length')" = 1 ]
  si "…la ficha anota su pr:" contiene "$(enmain pending g3)" '^pr: 1$'
  si "…y la salida avisa del revisor" contiene_i "$(SALIDA)" 'lider'
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# T13b — el issue sólo se toca si su repo está declarado en repos.json
# ══════════════════════════════════════════════════════════════════════════════════════════════
t13b_estado='(() => ({
    pulls: { [OPERATIONS_REPO]: [P(71, "dependencias/ib01", "closed")] },
    comments: { [OPERATIONS_REPO + "#71"]: [C("lider", "no aplica", "2026-10-12T08:00:00Z")] },
    issues: { [SHOP]: [I(7, "open")], "otro-org/otro-repo": [I(5, "open")] } }))()'
t13b_ficha() { ficha pending ib01 2026-10-01 "pr: 71" "pr_repo: $OPERATIONS_REPO" "pedidos:" "  - $SHOP: 7" "  - otro-org/otro-repo: 5"; }
if quiero T13b; then
  caso "T13b OpenPrGh_IssueOnlyDeclaredRepos" "@story-8.32 @ac-11b"
  montar; t13b_ficha; armar_todo "$t13b_estado"
  correr
  si "la noche sale 0" [ "$RC" = 0 ]
  si "el issue del repo declarado se cierra como not planned" [ "$(nllam 'e.method==="PATCH"&&e.ruta==="repos/"+SHOP+"/issues/7"&&e.cuerpo.state==="closed"&&e.cuerpo.state_reason==="not_planned"')" = 1 ]
  si "el repo NO declarado no recibe NINGUNA llamada" [ "$(nllam '/otro-org/.test(e.ruta)')" = 0 ]
  si "…y la salida lo nombra: no es un repo declarado" contiene_i "$(SALIDA)" 'otro-org/otro-repo.*no es un repo declarado|no es un repo declarado.*otro-org/otro-repo'
  si "…la ficha anota alineado:" contiene "$(enmain pending ib01)" '^alineado: 71:closed$'

  for MODO in ausente ilegible; do
    montar; t13b_ficha
    if [ "$MODO" = ausente ]; then export REPOS_JSON=none; else export REPOS_JSON='{ no es json'; fi
    armar_todo "$t13b_estado"
    unset REPOS_JSON
    correr
    si "repos.json $MODO: la noche sale 1" [ "$RC" = 1 ]
    si "…ningún issue se toca" [ "$(nllam '/\/issues\//.test(e.ruta)&&(e.method==="PATCH"||e.method==="POST")')" = 0 ]
    si "…y la ficha no anota alineado:" no_contiene "$(enmain pending ib01)" '^alineado:'
  done

  # un issue que ya no existe (404) o que se borró (410) es una respuesta: aviso, y la decisión queda alineada.
  # Pasa cuando un repo de producto se recrea: los issues no viajan con el código.
  montar
  ficha pending ib02 2026-10-01 "pr: 72" "pr_repo: $OPERATIONS_REPO" "pedidos:" "  - $SHOP: 8" "  - $SHOP: 9"
  armar_todo '(() => ({ pulls: { [OPERATIONS_REPO]: [P(72, "dependencias/ib02", "closed")] },
    comments: { [OPERATIONS_REPO + "#72"]: [C("lider", "no aplica", "2026-10-12T08:00:00Z")] },
    issues: { [SHOP]: [I(9, "open")] }, gone: [SHOP + "#9"] }))()'
  correr
  si "issues que ya no existen (404 y 410): la noche sale 0" [ "$RC" = 0 ]
  si "…lo dice, con el número del issue" contiene_i "$(SALIDA)" "$SHOP#8 ya no existe"
  si "…y la ficha anota alineado:" contiene "$(enmain pending ib02)" '^alineado: 72:closed$'

  # cualquier otro error sigue siendo «no pude preguntar»: fallo, y no se anota
  montar
  ficha pending ib03 2026-10-01 "pr: 73" "pr_repo: $OPERATIONS_REPO" "pedidos:" "  - $SHOP: 9"
  armar_todo '(() => ({ pulls: { [OPERATIONS_REPO]: [P(73, "dependencias/ib03", "closed")] },
    comments: { [OPERATIONS_REPO + "#73"]: [C("lider", "no aplica", "2026-10-12T08:00:00Z")] },
    issues: { [SHOP]: [I(9, "open")] }, fail: { ["GET repos/" + SHOP + "/issues/9"]: { status: 500, message: "Server Error" } } }))()'
  correr
  si "un 500 al consultar el issue: la noche sale 1" [ "$RC" = 1 ]
  si "…y la ficha no anota alineado:" no_contiene "$(enmain pending ib03)" '^alineado:'
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# T14 — --record-only no cierra pull requests; la pasada completa sí, y el cierre va antes del comentario
# ══════════════════════════════════════════════════════════════════════════════════════════════
if quiero T14; then
  caso "T14 OpenPrGh_RecordOnlyDoesNotClose" "@story-8.32 @ac-7 @ac-10"
  montar
  ficha archived cl01 2026-10-01 "pr: 81" "pr_repo: $OPERATIONS_REPO"
  armar_todo '{ pulls: { [OPERATIONS_REPO]: [P(81, "dependencias/cl01", "open")] } }'
  correr --record-only
  si "--record-only sale 0" [ "$RC" = 0 ]
  si "…ningún PATCH a ese pull request" [ "$(nllam 'e.method==="PATCH"&&/\/pulls\/81$/.test(e.ruta)')" = 0 ]
  si "…ni comentario" [ "$(nllam 'e.method==="POST"&&/\/issues\/81\/comments$/.test(e.ruta)')" = 0 ]
  si "…la ficha no gana pr_cerrado:" no_contiene "$(enmain archived cl01)" '^pr_cerrado:'
  si "…y la salida dice que se cierra en la pasada completa" contiene_i "$(SALIDA)" 'pasada completa'
  armar_arbol; : > "$T/gh.log"
  correr
  si "la pasada completa sale 0" [ "$RC" = 0 ]
  si "…cierra el pull request (PATCH state closed)" [ "$(nllam 'e.method==="PATCH"&&/\/pulls\/81$/.test(e.ruta)&&e.cuerpo.state==="closed"')" = 1 ]
  si "…y anota pr_cerrado:" contiene "$(enmain archived cl01)" "^pr_cerrado: $HOY\$"
  ORDEN=$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(x=>JSON.parse(x));
    const a=l.findIndex(e=>e.method==="PATCH"&&/\/pulls\/81$/.test(e.ruta)),b=l.findIndex(e=>e.method==="POST"&&/\/issues\/81\/comments$/.test(e.ruta));
    console.log(a>=0&&b>=0&&a<b?"bien":"mal "+a+" "+b)' "$T/gh.log")
  si "…el cierre va ANTES del comentario" igual "$ORDEN" bien

  montar
  ficha archived cl02 2026-10-01 "pr: 82" "pr_repo: $OPERATIONS_REPO"
  armar_todo '{ pulls: { [OPERATIONS_REPO]: [P(82, "dependencias/cl02", "open")] }, fail: { ["PATCH repos/" + OPERATIONS_REPO + "/pulls/82"]: { status: 500, message: "Server Error" } } }'
  correr
  si "si el PATCH falla: no se comenta" [ "$(nllam 'e.method==="POST"&&/\/issues\/82\/comments$/.test(e.ruta)')" = 0 ]
  si "…sale 1" [ "$RC" = 1 ]
  si "…y no se anota pr_cerrado:" no_contiene "$(enmain archived cl02)" '^pr_cerrado:'
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# T15 — fichas mal formadas: fallo, nada de rutas armadas con ellas, nada de comandos del flujo
# ══════════════════════════════════════════════════════════════════════════════════════════════
if quiero T15; then
  caso "T15 OpenPrGh_RejectsMalformedCards" "@story-8.32 @ac-9"
  for MALO in '12/../../x' 'abc'; do
    montar
    ficha pending mf01 2026-10-12 "pr: $MALO" "pr_repo: $OPERATIONS_REPO"
    armar_todo '{}'
    ORIG=$(cat "$T/semilla/inbox/dependencies/pending/mf01.yaml")
    correr
    si "pr: «${MALO}»: da fallo, sale 1" [ "$RC" = 1 ]
    si "…ninguna llamada con esa ruta" [ "$(nllam '/\.\.|pulls\/abc|issues\/abc|pulls\/12/.test(e.ruta)')" = 0 ]
    si "…la ficha no se toca" igual "$(enmain pending mf01)" "$ORIG"
  done
  for NOMBRE in 'a b' 'x@y'; do
    montar
    ficha pending "$NOMBRE" 2026-10-12
    armar_todo '{}'
    correr
    si "ficha «${NOMBRE}.yaml»: sale 1" [ "$RC" = 1 ]
    si "…no se le abre nada: ni rama ni pull request" [ "$(ramas)" = 'main ' ] && [ "$(nllam 'e.method==="POST"&&/\/pulls$/.test(e.ruta)')" = 0 ]
    si "…y ninguna línea de la salida empieza con «::»" bash -c '! grep -q "^::" "$1"' _ "$T/salida.txt"
  done
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# T16 — el motivo también puede estar en un comentario sobre una línea del diff
# ══════════════════════════════════════════════════════════════════════════════════════════════
if quiero T16; then
  caso "T16 OpenPrGh_MotiveFromDiffComments" "@story-8.32 @ac-5"
  montar
  ficha pending rc01 2026-10-10 "pr: 91" "pr_repo: $OPERATIONS_REPO"
  armar_todo '{ pulls: { [OPERATIONS_REPO]: [P(91, "dependencias/rc01", "closed")] },
    review_comments: { [OPERATIONS_REPO + "#91"]: [{ body: "este paquete no viaja al navegador", created_at: "2026-10-12T08:00:00Z", user: { login: "lider", type: "User" } }] } }'
  correr
  si "la noche sale 0" [ "$RC" = 0 ]
  F=$(enmain pending rc01)
  si "queda rechazado:" contiene "$F" '^rechazado: 2026-10-12'
  si "…y el motivo es el comentario sobre la línea del diff" literal "$F" 'este paquete no viaja al navegador'
  si "…consultó GET pulls/91/comments" [ "$(nllam 'e.method==="GET"&&/\/pulls\/91\/comments/.test(e.ruta)')" -ge 1 ]
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# T17 — el pull request que cerró LA NOCHE no es un rechazo, aunque la ficha vuelva el mismo día
# ══════════════════════════════════════════════════════════════════════════════════════════════
if quiero T17; then
  caso "T17 OpenPrGh_NightClosedIsNotARejection" "@story-8.32 @ac-4 @ac-11b"
  montar
  # la noche archivó la ficha, cerró su pull request con su marca, y la ficha volvió ese mismo día sin `pr:`
  ficha pending nc01 2026-10-01 "reaparecido: $HOY" "pr_antes: 95" "pr_repo_antes: $OPERATIONS_REPO" "pedidos:" "  - $SHOP: 4"
  armar_todo '{ pulls: { [OPERATIONS_REPO]: [P(95, "dependencias/nc01", "closed", { created_at: "'"$HOY"'T05:00:00Z", closed_at: "'"$HOY"'T06:00:00Z" })] },
    comments: { [OPERATIONS_REPO + "#95"]: [C("github-actions[bot]", "La ficha nc01 ya salió de la cola (se archivó): este pull request no tiene nada que decidir, y la noche lo cerró.\n\n<!-- tycon-nocturno -->", "'"$HOY"'T06:00:00Z", "Bot")] },
    issues: { [SHOP]: [I(4, "open")] } }'
  correr
  F=$(enmain pending nc01)
  si "la noche sale 0" [ "$RC" = 0 ]
  si "…no anota un rechazo" no_contiene "$F" '^rechazado:'
  si "…abre un pull request nuevo y lo anota" contiene "$F" '^pr: [0-9]'
  si "…y no toca el issue del producto" [ "$(nllam 'e.method==="PATCH"&&/\/issues\/4$/.test(e.ruta)')" = 0 ]

  # el mismo pull request, cerrado por una persona (sin la marca): es un rechazo de esta vida
  montar
  ficha pending nc02 2026-10-01 "reaparecido: $HOY" "pedidos:" "  - $SHOP: 4"
  armar_todo '{ pulls: { [OPERATIONS_REPO]: [P(96, "dependencias/nc02", "closed", { created_at: "'"$HOY"'T05:00:00Z", closed_at: "'"$HOY"'T06:00:00Z" })] },
    comments: { [OPERATIONS_REPO + "#96"]: [C("lider", "no aplica", "'"$HOY"'T06:00:00Z")] },
    issues: { [SHOP]: [I(4, "open")] } }'
  correr
  si "cerrado por una persona el mismo día: anota el rechazo con su motivo" literal "$(enmain pending nc02)" 'no aplica'
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# T67 — con el sitio andando (`site.url` en operations.json) la noche no abre pedidos nuevos; los abiertos siguen
# ══════════════════════════════════════════════════════════════════════════════════════════════
if quiero T67; then
  caso "T67 OpenPr_ConSitio_NoAbreNuevos" "@story-4.11 @ac-20"
  montar
  ficha pending st01 2026-10-12
  ficha pending st02 2026-10-12
  ficha pending st03 2026-10-12 "pr: 53" "pr_repo: $OPERATIONS_REPO"
  armar_todo '{ pulls: { [OPERATIONS_REPO]: [P(52, "dependencias/st02", "open"),
      P(53, "dependencias/st03", "closed", { created_at: "2026-10-12T05:00:00Z", closed_at: "2026-10-13T06:00:00Z" })] },
    comments: { [OPERATIONS_REPO + "#53"]: [C("lider", "no aplica en el sitio", "2026-10-13T06:00:00Z")] } }'
  printf '{"site":{"url":"https://sitio.acme.example"}}\n' > "$T/job/operations.json"
  correr
  si "con site.url la noche sale 0" [ "$RC" = 0 ]
  si "…no crea ningún pull request" [ "$(nllam 'e.method==="POST"&&/\/pulls$/.test(e.ruta)')" = 0 ]
  si "…ni empuja la rama de la ficha sin pedido" sin_rama dependencias/st01
  si "…y dice que lo decide el sitio" contiene_i "$(SALIDA)" 'st01: .*sitio'
  si "el pedido ya abierto se sigue adoptando: pr: 52" contiene "$(enmain pending st02)" '^pr: 52$'
  si "el rechazo del pedido cerrado se sigue anotando, con su motivo" literal "$(enmain pending st03)" 'no aplica en el sitio'

  # sin site.url, como hoy: se abre el pedido de la ficha que no tiene uno
  montar
  ficha pending st04 2026-10-12
  armar_todo '{}'
  printf '{"site":{}}\n' > "$T/job/operations.json"
  correr
  si "sin site.url se abre el pedido, como hoy" [ "$(nllam 'e.method==="POST"&&/\/pulls$/.test(e.ruta)')" = 1 ]

  # un operations.json que no se lee se trata como «no», y se dice
  montar
  ficha pending st05 2026-10-12
  armar_todo '{}'
  printf '{ no es json\n' > "$T/job/operations.json"
  correr
  si "con operations.json ilegible se abre el pedido, como hoy" [ "$(nllam 'e.method==="POST"&&/\/pulls$/.test(e.ruta)')" = 1 ]
  si "…y lo dice" contiene "$(SALIDA)" 'operations.json no se pudo leer'
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# T68 — con el sitio, la ficha que ya está en promoted/ (se decidió arreglar ahí) cierra el pull request viejo de la noche
# ══════════════════════════════════════════════════════════════════════════════════════════════
if quiero T68; then
  caso "T68 OpenPr_ConSitio_CierraElPedidoViejoDeLoDecidido" "@mantenimiento"
  montar
  ficha promoted sd01 2026-10-12 "pr: 61" "pr_repo: $OPERATIONS_REPO"
  armar_todo '{ pulls: { [OPERATIONS_REPO]: [P(61, "dependencias/sd01", "open")] } }'
  git -C "$T/semilla" push -q origin "main:refs/heads/dependencias/sd01"
  printf '{"site":{"url":"https://sitio.acme.example"}}\n' > "$T/job/operations.json"
  correr
  si "con site.url la noche sale 0" [ "$RC" = 0 ]
  si "decidida en el sitio: cierra su pull request viejo" [ "$(nllam 'e.method==="PATCH"&&/\/pulls\/61$/.test(e.ruta)&&e.cuerpo.state==="closed"')" = 1 ]
  si "…con un comentario que dice que se decidió en el sitio" [ "$(nllam 'e.method==="POST"&&/\/issues\/61\/comments$/.test(e.ruta)&&/se decidió en el sitio/.test(e.cuerpo.body)')" = 1 ]
  si "…y anota pr_cerrado:" contiene "$(enmain promoted sd01)" "^pr_cerrado: $HOY\$"
fi

echo
if [ "$FALLOS" = 0 ]; then echo "open-pr-per-finding-github: todo en verde"; exit 0; fi
echo "open-pr-per-finding-github: $FALLOS verificación(es) en rojo"; exit 1
