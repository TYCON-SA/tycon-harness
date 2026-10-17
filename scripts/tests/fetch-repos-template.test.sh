#!/usr/bin/env bash
# fetch-repos-template.test.sh — la plantilla que deja las skills a mano en un pipeline, corrida de verdad
# (story 8.18, T13 y T15; contrato C2).
#
# EL CASO. Hasta la story 8.18 el arnés y agent-skills eran dos repos, y `pipelines/templates/fetch-repos.yml`
# clonaba el segundo en `main`: un pull request del arnés se validaba contra `main` de agent-skills, no contra su
# propia rama, y la identidad de build necesitaba permiso de lectura sobre otro proyecto. Con un solo repo, las
# skills ya vienen en el checkout: la plantilla ENLAZA `~/.claude/agent-skills` al propio checkout. Lo que este
# archivo cuida es que ese cambio no abra un verde falso:
#   · un checkout que dice ser el repo unido y no trae `skills/tycon-pipeline` no puede terminar enlazado;
#   · un checkout recortado (sin historia) que no se pudo completar tampoco: `third-party-real.test.sh` mide sobre
#     un commit viejo, y sin historia sale «NO MEDIDO» todas las noches (corrida 11337);
#   · un enlace que no se pudo crear no puede leerse como «las skills están»;
#   · y en los tres el paso sale ROJO con el motivo: sin las skills no se mide nada, así que nunca es «no medido».
#
# 🔴 SE CORRE EL BLOQUE REAL DE LA PLANTILLA, sacado por su `displayName`, en una HOME de juguete y con repos de
#    juguete. No una copia: si alguien edita el paso, este caso lo ejercita editado. Las macros de Azure del paso
#    (`$(Build.SourcesDirectory)`, `$(System.CollectionUri)`, `${{ parameters.agentSkillsRepo }}`) se cambian por
#    variables del laboratorio; una macro que el laboratorio no conoce es un rojo, no una sustitución de comandos.
# 🔴 ROJO PREVIO: con la plantilla de antes de la 8.18 (sólo sabía clonar) salen rojos T13a, T13b, T13c y T13d, y T15
#    por el clon propio del nocturno de métricas.
#
# Sin red: los «remotos» son carpetas del laboratorio. Cero llamadas a Azure. No toca la HOME de quien la corre.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE="$ROOT/pipelines/templates/fetch-repos.yml"
METRICS_YAML="$ROOT/pipelines/azure-pipelines.yml"
BENCH_YAML="$ROOT/pipelines/azure-pipelines-banco.yml"
PR_YAML="$ROOT/pipelines/azure-pipelines-maintainers-pr.yml"
STEP_NAME='Traer AgentSkills'
FAILS=0; PASSED=0
ok()  { echo "✅ fetch-repos-template: $1"; PASSED=$((PASSED + 1)); }
bad() { echo "❌ fetch-repos-template: $1"; FAILS=$((FAILS + 1)); }

# La copia pública no trae los pipelines del equipo (el exportador deja afuera pipelines/**): ahí no hay nada que
# medir, y se dice. En el repo del equipo, que falte la plantilla es un rojo.
if [ ! -f "$TEMPLATE" ]; then
  if [ ! -f "$ROOT/perfil-equipo.json" ]; then
    echo "⏭ fetch-repos-template: NO MEDIDO — no está pipelines/templates/fetch-repos.yml (la copia pública no trae los pipelines del equipo). No es un verde."
    exit 0
  fi
  echo "❌ fetch-repos-template: no encontré $TEMPLATE"; exit 1
fi

# git le exporta GIT_DIR/GIT_INDEX_FILE a sus hooks: corrida desde un pre-commit, los `git` del laboratorio
# escribirían en el repo de verdad. La lista de variables es la de la biblioteca, no una copia.
UNSET_LINES="$(node -e 'for (const k of require(process.argv[1]).DEL_PADRE) console.log("unset " + k)' "$ROOT/scripts/lib/clean-git-env.js")" \
  || { echo "❌ fetch-repos-template: no pude leer scripts/lib/clean-git-env.js"; exit 1; }
eval "$UNSET_LINES"

LAB="$(mktemp -d "${TMPDIR:-/tmp}/fetch-repos-template.XXXXXX")"
LAB="$(cd "$LAB" && pwd -P)"
trap 'rm -rf "$LAB"' EXIT
# el git del laboratorio no lee la configuración de la máquina ni la de la persona
export GIT_CONFIG_NOSYSTEM=1
GIT_HOME="$LAB/git-home"; mkdir -p "$GIT_HOME/.config"
lab_git() { HOME="$GIT_HOME" XDG_CONFIG_HOME="$GIT_HOME/.config" git -c user.email=lab@lab -c user.name=lab -c init.defaultBranch=main -c commit.gpgsign=false "$@"; }

# ── El paso de la plantilla, tal cual está en el yml, con las macros de Azure cambiadas por variables ─────────
# `${{ parameters.productRegistry }}` (story 8.26, tanda C) se cambia por `${LAB_REGISTRY}`: la lista de productos la elige
# cada caso.
extract_step() { # $1=displayName $2=archivo de salida
  node - "$TEMPLATE" "$1" > "$2" 2> "$LAB/extract.err" <<'JS'
const fs = require('fs');
const [file, display] = process.argv.slice(2);
const lines = fs.readFileSync(file, 'utf8').split('\n');
const at = lines.findIndex((l) => l.includes(`displayName: '${display}'`));
if (at < 0) { process.stderr.write(`no encontré el paso «${display}»\n`); process.exit(3); }
let start = -1;
for (let i = at; i >= 0; i--) if (/^\s*-\s+script:\s*\|\s*$/.test(lines[i])) { start = i; break; }
if (start < 0) { process.stderr.write('el paso no empieza con «- script: |»\n'); process.exit(3); }
const body = lines.slice(start + 1, at);
const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
let text = body.map((l) => l.slice(indent)).join('\n').replace(/\s+$/, '') + '\n';
text = text.split('$(Build.SourcesDirectory)').join('${LAB_SOURCES}')
  .split('$(System.CollectionUri)').join('${LAB_ORG}')
  .split('${{ parameters.productRegistry }}').join('${LAB_REGISTRY}');
const left = text.match(/\$\([A-Za-z]+\.[A-Za-z.]+\)|\$\{\{[^}]*\}\}/g);
if (left) { process.stderr.write(`macros de Azure que el laboratorio no conoce: ${[...new Set(left)].join(' ')}\n`); process.exit(4); }
process.stdout.write(text);
JS
}
SNIPPET="$LAB/step.sh"
extract_step "$STEP_NAME" "$SNIPPET"; RC=$?
if [ "$RC" != 0 ] || [ ! -s "$SNIPPET" ]; then
  echo "❌ fetch-repos-template: no pude sacar el paso «${STEP_NAME}» de la plantilla (código $RC): $(cat "$LAB/extract.err")"
  exit 1
fi

# ── Repos de juguete ─────────────────────────────────────────────────────────────────────────────────────────
commit_file() { # $1=repo $2=ruta $3=mensaje
  mkdir -p "$(dirname "$1/$2")" && printf '%s\n' "$3" > "$1/$2" && lab_git -C "$1" add -A && lab_git -C "$1" commit -q -m "$3"
}
unified_origin() { # $1=dir — el repo unido: agents/, skills/tycon-pipeline, packs/ y scripts/, con tres commits de historia
  lab_git init -q "$1" && commit_file "$1" scripts/tool.js uno && commit_file "$1" agents/reviewer.md dos \
    && commit_file "$1" packs/pack.json dos-y-medio && commit_file "$1" skills/tycon-pipeline/SKILL.md tres
}
OUT="$LAB/out.txt"
run_step() { # $1=HOME $2=checkout $3=org [$4=token] → deja la salida en $OUT y devuelve el código del paso
  local home="$1" src="$2" org="$3" token="${4:-}"
  if [ -n "$token" ]; then
    ( cd "$src" && env HOME="$home" XDG_CONFIG_HOME="$home/.config" LAB_SOURCES="$src" LAB_ORG="$org" SYSTEM_ACCESSTOKEN="$token" bash "$SNIPPET" ) > "$OUT" 2>&1
  else
    ( cd "$src" && env -u SYSTEM_ACCESSTOKEN HOME="$home" XDG_CONFIG_HOME="$home/.config" LAB_SOURCES="$src" LAB_ORG="$org" bash "$SNIPPET" ) > "$OUT" 2>&1
  fi
}
real_of() { ( cd "$1" 2>/dev/null && pwd -P ) || true; }
red_with_reason() { # $1=código $2=patrón del motivo → 0 si el paso salió rojo, con una línea de error de Azure y ese motivo
  [ "$1" != 0 ] && grep -q '##vso\[task.logissue type=error\]' "$OUT" && grep -qE "$2" "$OUT" \
    && ! grep -qiE 'no medid|type=warning' "$OUT"
}
show() { sed 's/^/     /' "$OUT" | head -12; }

unified_origin "$LAB/origin" || { echo "❌ fetch-repos-template: no pude armar el repo unido de juguete"; exit 1; }
lab_git clone -q "file://$LAB/origin" "$LAB/full" || { echo "❌ fetch-repos-template: no pude clonar el repo de juguete"; exit 1; }
NOWHERE="$LAB/no-such-org/"

# ── T13a · checkout del repo unido, con historia: enlaza al propio checkout, sin clonar nada y sin credencial ──
HOME_A="$LAB/home-a"; mkdir -p "$HOME_A"
run_step "$HOME_A" "$LAB/full" "$NOWHERE"; RC=$?
DEST="$HOME_A/.claude/agent-skills"
if [ "$RC" = 0 ] && [ -L "$DEST" ] && [ "$(real_of "$DEST")" = "$(real_of "$LAB/full")" ] && [ -d "$DEST/skills/tycon-pipeline" ]; then
  ok "T13a el checkout del repo unido queda enlazado en ~/.claude/agent-skills (un enlace al propio checkout, no otro clon)"
else bad "T13a esperaba el enlace al checkout y código 0 (código $RC)"; show; fi
if [ "$RC" = 0 ] && [ "$(lab_git -C "$DEST" rev-list --count HEAD 2>&1)" = 4 ] && [ "$(lab_git -C "$DEST" rev-parse --is-shallow-repository 2>&1)" = false ]; then
  ok "T13a por el enlace se lee la historia entera (4 commits, sin recorte)"
else bad "T13a la historia por el enlace no es la entera"; fi
# el remoto de agent-skills no existe en este laboratorio y no hay credencial: si el paso hubiera querido leer otro
# repo, habría salido rojo. Es la forma de medir «sin permiso de lectura sobre otro proyecto».
if [ "$RC" = 0 ] && ! grep -qi 'clon' "$OUT"; then ok "T13a no clona nada ni usa la credencial de la corrida: no lee otro proyecto"
else bad "T13a el paso nombra un clon en un checkout del repo unido"; show; fi

# T13a2 — dos veces da lo mismo (el pipeline de pull request incluye la plantilla dos veces en el mismo agente)
run_step "$HOME_A" "$LAB/full" "$NOWHERE"; RC=$?
if [ "$RC" = 0 ] && [ -L "$DEST" ] && [ "$(real_of "$DEST")" = "$(real_of "$LAB/full")" ]; then ok "T13a2 una segunda corrida deja el mismo enlace y sale 0"
else bad "T13a2 la segunda corrida no dejó el enlace (código $RC)"; show; fi

# T13a3 — un enlace de una corrida anterior hacia otro checkout (un agente propio que se reusa) se reemplaza
HOME_A3="$LAB/home-a3"; mkdir -p "$HOME_A3/.claude" "$LAB/old-checkout/skills/tycon-pipeline"
ln -s "$LAB/old-checkout" "$HOME_A3/.claude/agent-skills"
run_step "$HOME_A3" "$LAB/full" "$NOWHERE"; RC=$?
if [ "$RC" = 0 ] && [ "$(real_of "$HOME_A3/.claude/agent-skills")" = "$(real_of "$LAB/full")" ] && [ -d "$LAB/old-checkout/skills/tycon-pipeline" ]; then
  ok "T13a3 un enlace viejo hacia otro checkout se reemplaza (se saca el enlace, no lo enlazado)"
else bad "T13a3 el enlace viejo no se reemplazó (código $RC)"; show; fi

# ── T13b · un checkout que dice ser el repo unido y no trae skills/tycon-pipeline: rojo con motivo ────────────
lab_git init -q "$LAB/no-skills" && commit_file "$LAB/no-skills" scripts/tool.js uno && commit_file "$LAB/no-skills" agents/reviewer.md dos
HOME_B="$LAB/home-b"; mkdir -p "$HOME_B"
run_step "$HOME_B" "$LAB/no-skills" "$NOWHERE" lab-token; RC=$?
if red_with_reason "$RC" 'skills/tycon-pipeline' && [ ! -e "$HOME_B/.claude/agent-skills" ] && [ ! -L "$HOME_B/.claude/agent-skills" ]; then
  ok "T13b sin skills/tycon-pipeline el paso sale rojo nombrando lo que falta, y no deja ningún enlace"
else bad "T13b esperaba rojo con motivo y sin enlace (código $RC)"; show; fi
# …y con la carpeta skills/ pero sin tycon-pipeline adentro, lo mismo
commit_file "$LAB/no-skills" skills/other-skill/SKILL.md tres
run_step "$HOME_B" "$LAB/no-skills" "$NOWHERE" lab-token; RC=$?
if red_with_reason "$RC" 'skills/tycon-pipeline' && [ ! -L "$HOME_B/.claude/agent-skills" ]; then
  ok "T13b con skills/ pero sin tycon-pipeline adentro también sale rojo"
else bad "T13b skills/ sin tycon-pipeline: esperaba rojo (código $RC)"; show; fi

# ── T13c · checkout recortado ────────────────────────────────────────────────────────────────────────────────
# (c1) se puede completar: el paso trae la historia y enlaza
lab_git clone -q --depth 1 "file://$LAB/origin" "$LAB/shallow-ok"
HOME_C1="$LAB/home-c1"; mkdir -p "$HOME_C1"
BEFORE="$(lab_git -C "$LAB/shallow-ok" rev-parse --is-shallow-repository)"
run_step "$HOME_C1" "$LAB/shallow-ok" "$NOWHERE"; RC=$?
if [ "$BEFORE" = true ] && [ "$RC" = 0 ] && [ "$(lab_git -C "$LAB/shallow-ok" rev-parse --is-shallow-repository)" = false ] \
   && [ "$(lab_git -C "$LAB/shallow-ok" rev-list --count HEAD)" = 4 ] && [ "$(real_of "$HOME_C1/.claude/agent-skills")" = "$(real_of "$LAB/shallow-ok")" ]; then
  ok "T13c un checkout recortado que se puede completar queda con la historia entera, y enlazado"
else bad "T13c (completable) recortado antes=$BEFORE, código $RC"; show; fi
# (c2) no se puede completar (el remoto no contesta): rojo con motivo, sin enlace
lab_git clone -q --depth 1 "file://$LAB/origin" "$LAB/shallow-bad"
lab_git -C "$LAB/shallow-bad" remote set-url origin "file://$LAB/origin-that-is-gone"
HOME_C2="$LAB/home-c2"; mkdir -p "$HOME_C2"
run_step "$HOME_C2" "$LAB/shallow-bad" "$NOWHERE" lab-token; RC=$?
if red_with_reason "$RC" 'recortad' && [ ! -L "$HOME_C2/.claude/agent-skills" ] && [ ! -e "$HOME_C2/.claude/agent-skills" ]; then
  ok "T13c un checkout recortado que NO se pudo completar sale rojo con el motivo, y no deja ningún enlace"
else bad "T13c (no completable) esperaba rojo con «recortado» y sin enlace (código $RC)"; show; fi

# ── T13d · el enlace no se puede crear ───────────────────────────────────────────────────────────────────────
# (d1) en el lugar hay una carpeta real (un clon de otra corrida, lo que sea): no se pisa, y el paso sale rojo
HOME_D1="$LAB/home-d1"; mkdir -p "$HOME_D1/.claude/agent-skills"; echo keep > "$HOME_D1/.claude/agent-skills/own-file.txt"
run_step "$HOME_D1" "$LAB/full" "$NOWHERE" lab-token; RC=$?
if red_with_reason "$RC" 'enlazar' && [ ! -L "$HOME_D1/.claude/agent-skills" ] && [ "$(cat "$HOME_D1/.claude/agent-skills/own-file.txt")" = keep ]; then
  ok "T13d una carpeta real en ~/.claude/agent-skills no se pisa: rojo con el motivo, y lo que había sigue ahí"
else bad "T13d (carpeta real) esperaba rojo con motivo y la carpeta intacta (código $RC)"; show; fi
# (d2) ~/.claude no se puede crear (hay un archivo con ese nombre): rojo con el motivo
HOME_D2="$LAB/home-d2"; mkdir -p "$HOME_D2"; echo file > "$HOME_D2/.claude"
run_step "$HOME_D2" "$LAB/full" "$NOWHERE" lab-token; RC=$?
if red_with_reason "$RC" 'enlazar|crear'; then ok "T13d sin poder crear ~/.claude el paso sale rojo con el motivo"
else bad "T13d (~/.claude es un archivo) esperaba rojo con motivo (código $RC)"; show; fi

# ── T13e · un checkout sin agents/, skills/ ni packs/: rojo, sin clonar ningún otro repo ─────────────────────────
# Hasta la story 8.26 (tanda C) ese checkout era «el arnés de antes de la unión» y el paso clonaba el repo viejo de las
# skills en main, con su nombre escrito en la plantilla. Ya no hay ramas sin unir, y la plantilla viaja en el público:
# un checkout así no trae las skills, y sin ellas no se mide nada.
lab_git init -q "$LAB/harness-only" && commit_file "$LAB/harness-only" scripts/tool.js uno
HOME_E="$LAB/home-e"; mkdir -p "$HOME_E"
run_step "$HOME_E" "$LAB/harness-only" "$LAB/remote/" lab-token; RC=$?
if red_with_reason "$RC" 'no trae las skills' && [ ! -e "$HOME_E/.claude/agent-skills" ] && ! grep -qi 'clon' "$OUT"; then
  ok "T13e un checkout sin skills sale rojo con el motivo, sin clonar otro repo ni dejar nada en ~/.claude/agent-skills"
else bad "T13e esperaba rojo con «no trae las skills», sin clon (código $RC)"; show; fi

# T13e2 — la carpeta de fuentes no es un checkout (un pipeline con varios `checkout` deja cada repo en una
# subcarpeta): no se puede saber qué trae, y NO se cae al clon del repo viejo en silencio — rojo con el motivo
mkdir -p "$LAB/not-a-checkout/some-repo/skills/tycon-pipeline"
HOME_E3="$LAB/home-e3"; mkdir -p "$HOME_E3"
run_step "$HOME_E3" "$LAB/not-a-checkout" "$LAB/remote/" lab-token; RC=$?
if red_with_reason "$RC" 'no es un checkout' && [ ! -e "$HOME_E3/.claude/agent-skills" ]; then
  ok "T13e2 si la carpeta de fuentes no es un checkout, el paso sale rojo en vez de clonar el repo viejo sin decirlo"
else bad "T13e2 esperaba rojo con «no es un checkout» y nada en ~/.claude/agent-skills (código $RC)"; show; fi

# ── T13f · el contrato C2: los mismos cuatro parámetros, con sus valores de siempre ──────────────────────────
PARAMS="$(node -e '
const t = require("fs").readFileSync(process.argv[1], "utf8");
const head = t.slice(t.indexOf("\nparameters:"), t.indexOf("\nsteps:"));
const out = [...head.matchAll(/- name: (\w+)\s+type: (\w+)\s+default: (.+)/g)].map((m) => `${m[1]}:${m[2]}:${m[3].trim()}`);
process.stdout.write(out.join(" "));' "$TEMPLATE")"
# Story 8.26, tanda C: `agentSkillsRepo` (el repo viejo de las skills) se fue con el camino de dos repos, y la lista de
# productos pasó a parámetro, con la de siempre por defecto (el banco nocturno y la publicación no cambian).
EXPECTED_PARAMS="agentSkills:boolean:true productos:boolean:false condicion:string:'succeeded()' productRegistry:string:'scripts/nightly/dependencies/repos.json'"
if [ "$PARAMS" = "$EXPECTED_PARAMS" ]; then ok "T13f la plantilla declara sus parámetros, con la lista de productos de siempre por defecto (la usan también el banco y la publicación)"
else bad "T13f los parámetros cambiaron: «${PARAMS}»"; fi

# ── T11 de la story 8.26 (tanda C, AC 11) · los repos de los productos: sin lista o sin ningún clon, ROJO ──────────
# Hasta la tanda C, sin la lista el `node` de la sustitución de proceso fallaba, el lazo no daba ninguna vuelta y el paso
# salía verde con «repos clonados: 0»: las suites que leen productos se salteaban «con constancia» y la cobertura bajaba
# sin un rojo. En el árbol público la lista no está (es del repo de mantenimiento): la validación la trae aparte y se la
# pasa por `productRegistry`. Un repo que no se clona sigue siendo AVISO, mientras se clone alguno.
PSNIP="$LAB/products.sh"
if extract_step 'Traer los repos de los productos' "$PSNIP" && [ -s "$PSNIP" ]; then
  make_remote() { # $1=proyecto/repo → un repo de juguete en el «Azure» del laboratorio
    local d="$LAB/porg/${1%%/*}/_git/${1##*/}"; mkdir -p "$d" && lab_git init -q "$d" && commit_file "$d" README.md "$1"
  }
  make_remote LabProj/RepoA && make_remote LabProj/RepoB
  run_products() { # $1=HOME $2=lista → deja la salida en $OUT
    ( cd "$LAB/full" && env HOME="$1" XDG_CONFIG_HOME="$1/.config" LAB_SOURCES="$LAB/full" LAB_ORG="file://$LAB/porg/" LAB_REGISTRY="$2" SYSTEM_ACCESSTOKEN=lab-token bash "$PSNIP" ) > "$OUT" 2>&1
  }
  printf '{"repos":[{"ruta":"Lab/RepoA","ado":"LabProj/RepoA"},{"ruta":"Lab/RepoB","ado":"LabProj/RepoB"}]}\n' > "$LAB/reg-ok.json"
  HP1="$LAB/home-p1"; mkdir -p "$HP1"; run_products "$HP1" "$LAB/reg-ok.json"; RC=$?
  if [ "$RC" = 0 ] && [ -d "$HP1/SourceCode/Lab/RepoA/.git" ] && [ -d "$HP1/SourceCode/Lab/RepoB/.git" ] && grep -q 'repos clonados: 2' "$OUT"; then
    ok "T11a con la lista que se le pasa, clona sus repos en ~/SourceCode/<ruta>"
  else bad "T11a esperaba los dos repos de la lista clonados (código $RC)"; show; fi
  HP2="$LAB/home-p2"; mkdir -p "$HP2"; run_products "$HP2" "$LAB/no-existe.json"; RC=$?
  if red_with_reason "$RC" 'lista de los repos de los productos'; then ok "T11b sin la lista, rojo con el motivo (no «repos clonados: 0» en verde)"
  else bad "T11b sin la lista esperaba rojo con motivo (código $RC)"; show; fi
  printf '{"repos":[{"ruta":"Lab/RepoX","ado":"LabProj/RepoX"}]}\n' > "$LAB/reg-bad.json"
  HP3="$LAB/home-p3"; mkdir -p "$HP3"; run_products "$HP3" "$LAB/reg-bad.json"; RC=$?
  if [ "$RC" != 0 ] && grep -q '##vso\[task.logissue type=error\]' "$OUT" && grep -q 'ningún repo' "$OUT"; then ok "T11c si no se clonó ninguno, rojo: la cobertura de las suites que leen productos no baja en silencio"
  else bad "T11c sin ningún clon esperaba rojo (código $RC)"; show; fi
  printf '{"repos":[]}\n' > "$LAB/reg-empty.json"
  HP4="$LAB/home-p4"; mkdir -p "$HP4"; run_products "$HP4" "$LAB/reg-empty.json"; RC=$?
  if red_with_reason "$RC" 'ningún repo'; then ok "T11d una lista vacía también es rojo"
  else bad "T11d con la lista vacía esperaba rojo (código $RC)"; show; fi
  printf '{"repos":[{"ruta":"Lab/RepoA","ado":"LabProj/RepoA"},{"ruta":"Lab/RepoX","ado":"LabProj/RepoX"}]}\n' > "$LAB/reg-half.json"
  HP5="$LAB/home-p5"; mkdir -p "$HP5"; run_products "$HP5" "$LAB/reg-half.json"; RC=$?
  # el aviso de Azure lleva texto fijo (AC 45: el control del pedido es público); el repo y el error, en la línea común
  if [ "$RC" = 0 ] && grep -q '##vso\[task.logissue type=warning\]' "$OUT" && ! grep '##vso' "$OUT" | grep 'RepoX' >/dev/null && grep -q 'RepoX' "$OUT"; then
    ok "T11e un repo que no se clona avisa (con texto fijo; el nombre en el registro) y el paso sigue"
  else bad "T11e esperaba aviso de texto fijo y código 0 (código $RC)"; show; fi
else
  bad "T11 no pude sacar el paso «Traer los repos de los productos»: $(cat "$LAB/extract.err")"
fi

# ── T13g · los yml que toca el tramo parsean ─────────────────────────────────────────────────────────────────
if python3 -c 'import yaml' >/dev/null 2>&1; then
  BROKEN=""
  for y in "$TEMPLATE" "$METRICS_YAML" "$BENCH_YAML" "$PR_YAML"; do
    # la copia pública lleva la validación y su plantilla, no los nocturnos (story 8.26, tanda C)
    [ -f "$y" ] || [ -f "$ROOT/perfil-equipo.json" ] || continue
    python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1], encoding="utf8"))' "$y" > "$LAB/yaml.err" 2>&1 || BROKEN="$BROKEN $(basename "$y") ($(tail -1 "$LAB/yaml.err"))"
  done
  [ -z "$BROKEN" ] && ok "T13g la plantilla y los tres pipelines parsean como YAML" || bad "T13g no parsean:$BROKEN"
else
  echo "⏭ fetch-repos-template: T13g NO MEDIDO — sin PyYAML en esta máquina. No es un verde."
fi

# ── T15 · el nocturno del banco y el de métricas no clonan agent-skills por su cuenta, y la raíz sale de la regla ──
# Lectura de los yml sin sus comentarios: un comentario que cuenta la historia no es un clon.
code_of() { grep -vE '^[[:space:]]*#' "$1"; }
# La copia pública lleva la validación (story 8.26, tanda C) pero no los dos nocturnos: lo de ellos ahí no se mide, y se
# dice. En el repo del equipo (con su perfil) que falten es un rojo.
if [ ! -f "$BENCH_YAML" ] && [ ! -f "$ROOT/perfil-equipo.json" ]; then
  echo "⏭ fetch-repos-template: T15 de los nocturnos NO MEDIDO — la copia pública no trae los pipelines nocturnos del equipo. No es un verde."
  NIGHTLY_YAMLS=()
else
  NIGHTLY_YAMLS=("$METRICS_YAML" "$BENCH_YAML")
fi
for y in ${NIGHTLY_YAMLS[@]+"${NIGHTLY_YAMLS[@]}"} "$PR_YAML"; do
  B="$(basename "$y")"
  if [ ! -f "$y" ]; then bad "T15 no está $B"; continue; fi
  if code_of "$y" | grep -niE 'clone.*(agentskills|agent-skills)|(agentskills|agent-skills).*clone|AgentSkills/_git' > "$LAB/clone.txt"; then
    bad "T15 $B clona agent-skills por su cuenta: $(head -2 "$LAB/clone.txt" | tr '\n' ' ')"
  else ok "T15 $B no clona agent-skills por su cuenta"; fi
  # la ruta instalada escrita a mano es «cada lector a su modo»: la raíz la da resolveSkillsDirs(). Pasarle a un
  # guion, por la variable, lo que la regla ya contestó (`TYCON_SKILLS_DIR="$SK"`) no es fijarla a mano.
  if code_of "$y" | grep -E '\.claude/agent-skills/skills|TYCON_SKILLS_DIR=' | grep -vF 'TYCON_SKILLS_DIR="$SK"' > "$LAB/literal.txt"; then
    bad "T15 $B fija la raíz de las skills a mano: $(head -2 "$LAB/literal.txt" | tr '\n' ' ')"
  else ok "T15 $B no fija la raíz de las skills a mano"; fi
done
# los tres la piden por la regla (la misma función que los demás lectores)
for y in ${NIGHTLY_YAMLS[@]+"${NIGHTLY_YAMLS[@]}"} "$PR_YAML"; do
  B="$(basename "$y")"
  # `> /dev/null`, no `-q`: con `pipefail`, `grep -q` corta al primer acierto y `code_of` muere por SIGPIPE si lo que
  # falta leer no entra en la tubería — el yml de pull request, partido en cuatro trabajos, ya no entra (45 KB), y el
  # acierto salía como «no la pide».
  if code_of "$y" | grep -E 'SK="\$\(node scripts/lib/skills-dir\.js --skills\)"' > /dev/null; then ok "T15 $B pide la raíz de las skills a scripts/lib/skills-dir.js (la regla de resolveSkillsDirs)"
  else bad "T15 $B no pide la raíz de las skills a scripts/lib/skills-dir.js --skills"; fi
done
# el banco sigue incluyendo la plantilla en sus dos trabajos, con la lista de productos de siempre
if [ ${#NIGHTLY_YAMLS[@]} -gt 0 ]; then
  N_TEMPLATE="$(code_of "$BENCH_YAML" | grep -c 'template: /pipelines/templates/fetch-repos.yml')"
  if [ "$N_TEMPLATE" = 2 ] && ! code_of "$BENCH_YAML" | grep 'productRegistry' >/dev/null; then ok "T15 el banco incluye la plantilla en sus dos trabajos, con la lista de productos por defecto"
  else bad "T15 el banco incluye la plantilla $N_TEMPLATE vez/veces (esperaba 2) o le pasa otra lista"; fi
fi
# la historia entera se pide desde el checkout (la plantilla la completa si igual vino recortado)
for y in $([ ${#NIGHTLY_YAMLS[@]} -gt 0 ] && printf '%s' "$BENCH_YAML") "$PR_YAML"; do
  B="$(basename "$y")"
  N_CHECKOUT="$(code_of "$y" | grep -c 'checkout: self')"; N_DEPTH="$(code_of "$y" | grep -cE 'fetchDepth: 0([[:space:]]|$)')"
  if [ "$N_CHECKOUT" -ge 1 ] && [ "$N_CHECKOUT" = "$N_DEPTH" ]; then ok "T15 $B pide la historia entera en cada checkout ($N_CHECKOUT)"
  else bad "T15 $B tiene $N_CHECKOUT checkout y $N_DEPTH con fetchDepth: 0"; fi
done
# La línea que resuelve la raíz, tal cual está en el yml del banco, corrida en este clon con una HOME que la
# plantilla ya enlazó: tiene que dar <clon>/skills. Sólo se mide si este clon es el repo unido.
if [ -d "$ROOT/skills/tycon-pipeline" ] && [ -d "$ROOT/agents" ]; then
  SK_CALL="$(code_of "$([ -f "$BENCH_YAML" ] && printf '%s' "$BENCH_YAML" || printf '%s' "$PR_YAML")" | grep -oE 'SK="\$\(node [^)]*\)"' | head -1)"
  HOME_K="$LAB/home-k"; mkdir -p "$HOME_K/.claude"; ln -s "$ROOT" "$HOME_K/.claude/agent-skills"
  if [ -z "$SK_CALL" ]; then bad "T15 no encontré en el banco la llamada que resuelve la raíz de las skills (SK=\"\$(node …)\")"
  else
    GOT="$(cd "$ROOT" && env -u TYCON_SKILLS_DIR HOME="$HOME_K" bash -c "set -uo pipefail; ${SK_CALL} || exit 1; printf '%s' \"\$SK\"" 2> "$LAB/sk.err")"; RC=$?
    if [ "$RC" = 0 ] && [ -n "$GOT" ] && [ "$(real_of "$GOT")" = "$(real_of "$ROOT/skills")" ]; then ok "T15 la raíz agent-skills que resuelve el banco es la carpeta skills/ del propio checkout"
    else bad "T15 la raíz resuelta fue «${GOT}» (código $RC): $(head -2 "$LAB/sk.err" | tr '\n' ' ')"; fi
  fi
else
  echo "⏭ fetch-repos-template: T15 (la raíz resuelta) NO MEDIDO — este clon no trae skills/tycon-pipeline y agents/. No es un verde."
fi

echo "———"
[ "$FAILS" -eq 0 ] && { echo "✅ fetch-repos-template: $PASSED chequeo(s), 0 fallas"; exit 0; }
echo "❌ fetch-repos-template: FALLARON $FAILS de $((PASSED + FAILS))"; exit 1
