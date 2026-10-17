#!/usr/bin/env bash
# base-controls.test.sh — la revisión de un pedido corre los controles de la base, no los del pedido.
#
# Lo que se prueba es scripts/ci/run-base-controls.sh sobre repos de juguete armados acá con git: una base con un control
# que frena una palabra (`PROHIBIDO`) salvo en los archivos de su lista, con un modo (`block`/`warn`), y un pedido que
# intenta saltearlo. Sin red y sin nada instalado.
#
#   T1  BaseControls_Inventory_EveryControlAndRuleClassified — el inventario real del arnés cuadra con su pre-commit
#       (cada guion con su entrada, cada archivo de datos que nombran con su clase) y, en un juguete, un archivo de datos
#       sin clasificar es rojo
#   T2  BaseControls_EmptiedPreCommit_BaseCopyRuns_Red — el pedido vacía el pre-commit y trae lo que frena: rojo, y el
#       registro dice que el control salió de la base
#   T3  BaseControls_DeletedControlScript_BaseCopyRuns_Red — el pedido borra el guion del control: rojo con su nombre
#   T4  BaseControls_LooserRuleInPR_BaseRuleApplies_Red — el pedido suma su excepción a la lista: rojo, nombra la lista
#   T5  BaseControls_ModeLoweredInPR_BaseModeApplies_Red — el pedido baja el modo a `warn`: rojo
#   T6  BaseControls_NewControlInPR_RunsToo — un control nuevo del pedido corre y su rojo cuenta; la base corre igual
#   T7  BaseControls_StricterControl_OwnTestsGreen_Passes — el pedido endurece el control: verde, sin constancia
#   T8  BaseControls_LoosenedControl_WithoutApproval_Red_WithApproval_Passes — aflojar: sin la constancia del dueño rojo;
#       con ella «cambio de control aprobado» nombrando la regla; `approve` sin terminal se niega
#   T9  BaseControls_BaseUnreachable_NotRunRed — la base no se lee: «no pude correr», nunca verde
#   T10 BaseControls_InventoryMissingScript_Red — el inventario nombra un guion que la base no trae: rojo
#   T11 BaseControls_UninventoriedControl_Red — el pre-commit llama un guion sin entrada: «control sin inventariar»
#   T15 BaseControls_WorkflowStopsBringingBase_Red — el pedido saca del workflow lo que trae la base: rojo, con el archivo
#   T16 BaseControls_MainBroughtWorkflowChangeWithoutApproval_Warns — main cambió el workflow mientras el pedido estaba
#       abierto: aviso sin constancia, nada con constancia; el veredicto no cambia
#   T17 BaseControls_RuleAdditionsListedPerFile — las excepciones que suma el pedido, listadas por archivo; la alarma
#       cuenta la que trajo main
#
# T12, T13 y T14 están en public-ci.test.sh (el workflow y el guion de la CI) y en la prueba de la 170 del repo de
# mantenimiento (el yml que sólo existe ahí).
#
# Portable (`requiere: []`). Correr: bash scripts/tests/base-controls.test.sh

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/ci/run-base-controls.sh"
T="$(mktemp -d "${TMPDIR:-/tmp}/base-controls-test.XXXXXX")"
T="$(cd "${T}" && pwd -P)"
trap 'rm -rf "${T}"' EXIT
mkdir -p "${T}/home"
export HOME="${T}/home"
unset XDG_CONFIG_HOME GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR

TOTAL=0; FAILS=0
ok() { TOTAL=$((TOTAL + 1)); echo "✅ $1"; }
no() { TOTAL=$((TOTAL + 1)); FAILS=$((FAILS + 1)); echo "❌ $1"; }
is() { if [ "$2" = "$3" ]; then ok "$1"; else no "$1 — esperaba «${2}» y dio «${3}»"; fi; }
has() { if grep -qF -- "$3" "$2" 2>/dev/null; then ok "$1"; else no "$1 — no aparece «${3}»: $(tail -n 12 "$2" 2>/dev/null | tr '\n' ' ')"; fi; }
lacks() { if grep -qF -- "$3" "$2" 2>/dev/null; then no "$1 — aparece «${3}»"; else ok "$1"; fi; }
# git de la suite: fecha fija y sin mantenimiento automático (un repo que se reempaqueta solo cambia entre dos lecturas)
export GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z'
lab_git() { git -c user.email=t@t -c user.name=t -c commit.gpgsign=false -c init.defaultBranch=main -c maintenance.auto=false -c gc.auto=0 "$@"; }

[ -f "${SCRIPT}" ] || { no "no existe scripts/ci/run-base-controls.sh"; echo "❌ base-controls: ${FAILS} de ${TOTAL}"; exit 1; }

# ── el juguete ───────────────────────────────────────────────────────────────────────────────────────────────────────
# make_base <carpeta>: la base, en main. El pre-commit llama al control; el control lee su regla (modo y lista) del disco.
make_base() {
  local r="$1"
  mkdir -p "${r}/.githooks" "${r}/scripts/ci" "${r}/.github/workflows" "${r}/docs"
  cat > "${r}/.githooks/pre-commit-checks" <<'SH'
#!/usr/bin/env bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
bash "$REPO_ROOT/scripts/ci/toy-check.sh" || exit 1
SH
  cat > "${r}/scripts/ci/toy-check.sh" <<'SH'
#!/usr/bin/env bash
# el control de juguete: frena la palabra PROHIBIDO en lo que trae el commit, salvo en los archivos de su lista
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORD="PROHIBIDO"
node -e '
const fs = require("fs"); const { execFileSync } = require("child_process");
const [root, word] = process.argv.slice(1);
const rules = JSON.parse(fs.readFileSync(root + "/scripts/ci/toy-rules.json", "utf8"));
const files = execFileSync("git", ["-C", root, "diff", "--cached", "--name-only", "--diff-filter=ACMR"]).toString().split("\n").filter(Boolean);
let bad = 0;
for (const f of files) {
  if (f.startsWith("scripts/") || f.startsWith(".")) continue;
  const text = execFileSync("git", ["-C", root, "show", ":" + f]).toString();
  if (text.includes(word) && !(rules.allow || []).includes(f)) { console.log("toy: " + word + " en " + f); bad++; }
}
process.exit(bad && rules.mode === "block" ? 1 : 0);
' "$REPO_ROOT" "$WORD"
SH
  printf '%s\n' '{ "mode": "block", "allow": ["docs/permitido.txt"] }' > "${r}/scripts/ci/toy-rules.json"
  printf '%s\n' '{ "names": ["uno"] }' > "${r}/scripts/ci/toy-names.json"
  cat > "${r}/scripts/ci/controls-from-base.json" <<'JSON'
{
  "hook": ".githooks/pre-commit-checks",
  "passes": [
    { "name": "pre-commit", "mode": "index", "cmd": ["bash", ".githooks/pre-commit-checks"] }
  ],
  "controls": [
    { "name": "toy", "script": "scripts/ci/toy-check.sh", "rules": ["scripts/ci/toy-rules.json", "scripts/ci/toy-names.json"] },
    { "name": "base-controls", "script": "scripts/ci/run-base-controls.sh", "rules": ["scripts/ci/controls-from-base.json"] }
  ],
  "content": [],
  "workflows": [
    { "path": ".github/workflows/ci.yml", "must_contain": ["run-base-controls"] }
  ],
  "approvals": ".tycon/control-changes.jsonl"
}
JSON
  cp "${SCRIPT}" "${r}/scripts/ci/run-base-controls.sh"
  printf '%s\n' 'name: ci' 'jobs: { ci: { steps: [ { run: "bash run-base-controls" } ] } }' > "${r}/.github/workflows/ci.yml"
  printf 'nada\n' > "${r}/docs/leeme.txt"
  ( cd "${r}" && lab_git init -q . && lab_git add -A && lab_git commit -qm base ) > /dev/null 2>&1
}
# pr <carpeta>: abre la rama del pedido
pr() { lab_git -C "$1" checkout -q -b pedido; }
commit() { lab_git -C "$1" add -A > /dev/null 2>&1; lab_git -C "$1" commit -qm "${2:-pedido}" > /dev/null 2>&1; }
# run <carpeta> <salida> [args…]: la revisión del pedido contra main; deja el exit en RC
run() {
  local r="$1" out="$2"; shift 2
  bash "${SCRIPT}" run --root "${r}" --base main --range main...pedido "$@" > "${out}" 2>&1; RC=$?
}

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# T1 · el inventario real cuadra; en un juguete, un archivo de datos sin clasificar es rojo
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
bash "${SCRIPT}" check-inventory --root "${ROOT}" > "${T}/t1-real.out" 2>&1; RC=$?
is "T1 el inventario real del arnés cuadra con su pre-commit (exit)" "0" "${RC}"
lacks "T1 el inventario real no deja ningún archivo de datos sin clasificar" "${T}/t1-real.out" "sin clasificar"
R="${T}/t1"; make_base "${R}"
printf '%s\n' '# la regla de otro: "scripts/ci/otra-lista.json"' >> "${R}/scripts/ci/toy-check.sh"
printf '{}\n' > "${R}/scripts/ci/otra-lista.json"
commit "${R}" "lista sin clasificar"
bash "${SCRIPT}" check-inventory --root "${R}" > "${T}/t1.out" 2>&1; RC=$?
is "T1 un archivo de datos que nombra un control y no está clasificado: rojo" "1" "${RC}"
has "T1 el rojo nombra el archivo sin clasificar" "${T}/t1.out" "sin clasificar: scripts/ci/otra-lista.json"

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# T2 · el pedido vacía el pre-commit y trae lo que frena
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
R="${T}/t2"; make_base "${R}"; pr "${R}"
: > "${R}/.githooks/pre-commit-checks"; printf 'PROHIBIDO\n' > "${R}/docs/malo.txt"; commit "${R}"
run "${R}" "${T}/t2.out"
is "T2 el pre-commit vaciado no saltea el control: rojo" "1" "${RC}"
has "T2 el control de la base frena el contenido" "${T}/t2.out" "toy: PROHIBIDO en docs/malo.txt"
has "T2 el registro dice que la pasada salió de la base" "${T}/t2.out" "pre-commit — rojo (base $(lab_git -C "${R}" rev-parse --short=12 main))"
has "T2 el registro nombra la regla que el pedido cambió" "${T}/t2.out" ".githooks/pre-commit-checks"

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# T3 · el pedido borra el guion del control
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
R="${T}/t3"; make_base "${R}"; pr "${R}"
rm "${R}/scripts/ci/toy-check.sh"; printf 'PROHIBIDO\n' > "${R}/docs/malo.txt"; commit "${R}"
run "${R}" "${T}/t3.out"
is "T3 el guion borrado no saltea el control: rojo" "1" "${RC}"
has "T3 corre la copia de la base" "${T}/t3.out" "toy: PROHIBIDO en docs/malo.txt"
has "T3 el rojo nombra el control borrado" "${T}/t3.out" "scripts/ci/toy-check.sh (control toy): borrado"

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# T4 · el pedido suma su excepción a la lista
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
R="${T}/t4"; make_base "${R}"; pr "${R}"
printf '%s\n' '{ "mode": "block", "allow": ["docs/permitido.txt", "docs/malo.txt"] }' > "${R}/scripts/ci/toy-rules.json"
printf 'PROHIBIDO\n' > "${R}/docs/malo.txt"; commit "${R}"
run "${R}" "${T}/t4.out"
is "T4 la excepción que suma el pedido no vale para él: rojo" "1" "${RC}"
has "T4 frena lo que la base frena" "${T}/t4.out" "toy: PROHIBIDO en docs/malo.txt"
has "T4 el rojo nombra el archivo de regla que el pedido cambió" "${T}/t4.out" "scripts/ci/toy-rules.json (control toy)"

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# T5 · el pedido baja el modo
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
R="${T}/t5"; make_base "${R}"; pr "${R}"
printf '%s\n' '{ "mode": "warn", "allow": ["docs/permitido.txt"] }' > "${R}/scripts/ci/toy-rules.json"
printf 'PROHIBIDO\n' > "${R}/docs/malo.txt"; commit "${R}"
run "${R}" "${T}/t5.out"
is "T5 el modo bajado a warn no vale para el pedido: rojo" "1" "${RC}"
has "T5 el cambio de modo queda nombrado" "${T}/t5.out" '~ mode: "block" → "warn"'

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# T6 · un control nuevo del pedido corre y su rojo cuenta; la base corre igual
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
R="${T}/t6"; make_base "${R}"; pr "${R}"
printf '%s\n' 'grep -rq NUEVO "$(git rev-parse --show-toplevel)/docs" && { echo "nuevo: NUEVO en docs"; exit 1; }; exit 0' > "${R}/scripts/ci/toy-new.sh"
printf '%s\n' 'bash "$REPO_ROOT/scripts/ci/toy-new.sh" || exit 1' >> "${R}/.githooks/pre-commit-checks"
node -e 'const f=process.argv[1];const j=JSON.parse(require("fs").readFileSync(f,"utf8"));j.controls.push({name:"nuevo",script:"scripts/ci/toy-new.sh",rules:[]});require("fs").writeFileSync(f,JSON.stringify(j,null,2))' "${R}/scripts/ci/controls-from-base.json"
printf 'NUEVO\n' > "${R}/docs/nuevo.txt"; commit "${R}"
run "${R}" "${T}/t6.out"
is "T6 el rojo del control nuevo del pedido cuenta" "1" "${RC}"
has "T6 corrió el control nuevo, desde el pedido" "${T}/t6.out" "nuevo: NUEVO en docs"
has "T6 la pasada del pedido sale en rojo" "${T}/t6.out" "pre-commit — rojo (pedido"
has "T6 la pasada de la base corrió también" "${T}/t6.out" "✅ base-controls: pre-commit (base"

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# T7 · el pedido endurece el control: verde, sin trámite
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
R="${T}/t7"; make_base "${R}"; pr "${R}"
printf '%s\n' '{ "mode": "block", "allow": [] }' > "${R}/scripts/ci/toy-rules.json"
printf 'limpio\n' > "${R}/docs/otro.txt"; commit "${R}"
run "${R}" "${T}/t7.out"
is "T7 endurecer un control entra sin constancia: verde" "0" "${RC}"
has "T7 lo dice" "${T}/t7.out" "la base y el pedido pasan: entra sin constancia"
has "T7 la regla que cambia queda listada" "${T}/t7.out" '- allow: "docs/permitido.txt"'

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# T8 · aflojar: sin constancia rojo, con constancia «cambio de control aprobado»
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
R="${T}/t8"; make_base "${R}"; pr "${R}"
printf '%s\n' '{ "mode": "block", "allow": ["docs/permitido.txt", "docs/malo.txt"] }' > "${R}/scripts/ci/toy-rules.json"
printf 'PROHIBIDO\n' > "${R}/docs/malo.txt"; commit "${R}"
run "${R}" "${T}/t8a.out"
is "T8 aflojar sin la constancia del dueño: rojo" "1" "${RC}"
has "T8 el rojo dice que es un aflojamiento y cómo firmarlo" "${T}/t8a.out" "afloja un control sin la constancia del dueño"
bash "${SCRIPT}" approve --root "${R}" --base main --range main...pedido < /dev/null > "${T}/t8-approve.out" 2>&1; RC=$?
is "T8 approve sin terminal se niega (exit 2)" "2" "${RC}"
has "T8 approve sin terminal dice por qué" "${T}/t8-approve.out" "pide una terminal"
[ ! -e "${R}/.tycon/control-changes.jsonl" ] && ok "T8 approve sin terminal no escribe nada" || no "T8 approve sin terminal escribió la constancia"
# `pending` dice qué cambia y el comando de la firma, nunca la constancia lista para pegar
bash "${SCRIPT}" pending --root "${R}" --base main --range main...pedido > "${T}/t8-pending.out" 2>&1
has "T8 pending da el comando de la firma, con las entradas" "${T}/t8-pending.out" "approve --root"
lacks "T8 pending no imprime la constancia lista para pegar" "${T}/t8-pending.out" '"by":"dueño"'
ENTRIES="$(sed -n "s/^.* --entries '\(.*\)'\$/\1/p" "${T}/t8-pending.out" | head -n 1)"
bash "${SCRIPT}" approve --root "${R}" --entries "${ENTRIES}" < /dev/null > "${T}/t8-approve2.out" 2>&1; RC=$?
is "T8 approve --entries sin terminal también se niega" "2" "${RC}"
# la constancia, como la escribe el dueño desde su terminal (acá, a mano: la prueba no tiene terminal)
LINE="$(node -e 'const e=JSON.parse(process.argv[1]);const t=e.map(x=>`${x.path}\t${x.blob}\n`).sort().join("");console.log(JSON.stringify({hash:require("crypto").createHash("sha256").update(t).digest("hex"),rules:e,at:"2026-10-17",by:"dueño"}))' "${ENTRIES}" 2>/dev/null)"
if [ -n "${LINE}" ]; then mkdir -p "${R}/.tycon"; printf '%s\n' "${LINE}" > "${R}/.tycon/control-changes.jsonl"; commit "${R}" "constancia"; else no "T8 pending no dio las entradas a firmar"; fi
run "${R}" "${T}/t8b.out"
is "T8 con la constancia del dueño: verde" "0" "${RC}"
has "T8 lo dice nombrando la regla" "${T}/t8b.out" "cambio de control aprobado: scripts/ci/toy-rules.json"
# una constancia vieja no vale para otro cambio de la misma regla
printf '%s\n' '{ "mode": "warn", "allow": ["docs/permitido.txt", "docs/malo.txt"] }' > "${R}/scripts/ci/toy-rules.json"; commit "${R}" "otro cambio"
run "${R}" "${T}/t8c.out"
is "T8 la constancia está anclada al cambio: otro cambio de la regla vuelve a rojo" "1" "${RC}"

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# T9 · la base no se lee
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
R="${T}/t9"; make_base "${R}"; pr "${R}"; printf 'limpio\n' > "${R}/docs/otro.txt"; commit "${R}"
bash "${SCRIPT}" run --root "${R}" --base no-existe --range main...pedido > "${T}/t9a.out" 2>&1; RC=$?
is "T9 una base que no resuelve: no pude correr (exit 9)" "9" "${RC}"
has "T9 lo dice" "${T}/t9a.out" "no pude correr"
lab_git -C "${R}" checkout -q -b sin-inventario main && lab_git -C "${R}" rm -q scripts/ci/controls-from-base.json && commit "${R}" "sin inventario"
bash "${SCRIPT}" run --root "${R}" --base sin-inventario --range main...pedido > "${T}/t9b.out" 2>&1; RC=$?
is "T9 una base sin inventario: no pude correr, nunca los controles del pedido" "9" "${RC}"
lacks "T9 sin base no corre la pasada del pedido como si fuera la revisión" "${T}/t9b.out" "✅ base-controls: verde"

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# T10 · el inventario nombra un guion que la base no trae
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
R="${T}/t10"; make_base "${R}"
node -e 'const f=process.argv[1];const j=JSON.parse(require("fs").readFileSync(f,"utf8"));j.controls.push({name:"fantasma",script:"scripts/ci/fantasma.sh",rules:[]});require("fs").writeFileSync(f,JSON.stringify(j,null,2))' "${R}/scripts/ci/controls-from-base.json"
commit "${R}" "inventario con un fantasma"
bash "${SCRIPT}" check-inventory --root "${R}" > "${T}/t10.out" 2>&1; RC=$?
is "T10 el inventario con un guion que no está: rojo" "1" "${RC}"
has "T10 lo nombra" "${T}/t10.out" "el inventario nombra scripts/ci/fantasma.sh y el árbol no lo trae"

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# T11 · el pre-commit llama un guion sin entrada en el inventario
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
R="${T}/t11"; make_base "${R}"
printf 'exit 0\n' > "${R}/scripts/ci/suelto.sh"
printf '%s\n' 'bash "$REPO_ROOT/scripts/ci/suelto.sh" || exit 1' >> "${R}/.githooks/pre-commit-checks"
commit "${R}" "control suelto"
bash "${SCRIPT}" check-inventory --root "${R}" > "${T}/t11.out" 2>&1; RC=$?
is "T11 un control del pre-commit sin inventariar: rojo" "1" "${RC}"
has "T11 lo nombra" "${T}/t11.out" "control sin inventariar: scripts/ci/suelto.sh"
# y en una revisión: el pedido que suma un control sin su entrada
R="${T}/t11b"; make_base "${R}"; pr "${R}"
printf 'exit 0\n' > "${R}/scripts/ci/suelto.sh"
printf '%s\n' 'bash "$REPO_ROOT/scripts/ci/suelto.sh" || exit 1' >> "${R}/.githooks/pre-commit-checks"
commit "${R}"
run "${R}" "${T}/t11b.out"
is "T11 el pedido que suma un control sin inventariar: rojo" "1" "${RC}"
has "T11 la revisión lo nombra" "${T}/t11b.out" "control sin inventariar: scripts/ci/suelto.sh"

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# T15 · el pedido saca del workflow lo que trae la base
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
R="${T}/t15"; make_base "${R}"; pr "${R}"
printf '%s\n' 'name: ci' 'jobs: { ci: { steps: [ { run: "bash scripts/ci/public-ci.sh" } ] } }' > "${R}/.github/workflows/ci.yml"; commit "${R}"
run "${R}" "${T}/t15.out"
is "T15 un workflow que deja de traer la base: rojo" "1" "${RC}"
has "T15 el rojo nombra el archivo y lo que falta" "${T}/t15.out" ".github/workflows/ci.yml ya no trae la base (falta «run-base-controls»)"
has "T15 lo frena la pasada de la base" "${T}/t15.out" "(base $(lab_git -C "${R}" rev-parse --short=12 main))"

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# T16 · main cambió el workflow mientras el pedido estaba abierto
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
R="${T}/t16"; make_base "${R}"; pr "${R}"; printf 'limpio\n' > "${R}/docs/otro.txt"; commit "${R}"
lab_git -C "${R}" checkout -q main
printf '%s\n' '# un comentario' >> "${R}/.github/workflows/ci.yml"; commit "${R}" "main toca el workflow sin firmar"
SIN="$(lab_git -C "${R}" rev-parse --short=12 HEAD)"
lab_git -C "${R}" checkout -q pedido
run "${R}" "${T}/t16a.out"
is "T16 un pedido limpio sigue verde aunque main trajo un cambio sin firmar" "0" "${RC}"
has "T16 avisa con el commit y el archivo" "${T}/t16a.out" "main trajo .github/workflows/ci.yml en ${SIN} sin constancia del dueño"
has "T16 dice cómo firmarla" "${T}/t16a.out" "run-base-controls.sh approve"
# firmado en main: la constancia ancla esa versión del archivo
lab_git -C "${R}" checkout -q main
BLOB="$(lab_git -C "${R}" rev-parse HEAD:.github/workflows/ci.yml)"
mkdir -p "${R}/.tycon"
printf '{"hash":"x","rules":[{"path":".github/workflows/ci.yml","blob":"%s"}],"at":"2026-10-17","by":"dueño"}\n' "${BLOB}" > "${R}/.tycon/control-changes.jsonl"
commit "${R}" "la firma del dueño"
lab_git -C "${R}" checkout -q pedido
run "${R}" "${T}/t16b.out"
is "T16 con la constancia, verde" "0" "${RC}"
lacks "T16 el cambio firmado no avisa" "${T}/t16b.out" "sin constancia del dueño"

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# T17 · las excepciones que se suman quedan listadas por archivo
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
R="${T}/t17"; make_base "${R}"; pr "${R}"
printf '%s\n' '{ "mode": "block", "allow": ["docs/permitido.txt", "docs/a.txt", "docs/b.txt"] }' > "${R}/scripts/ci/toy-rules.json"
printf '%s\n' '{ "names": ["uno", "dos"] }' > "${R}/scripts/ci/toy-names.json"
printf 'limpio\n' > "${R}/docs/a.txt"; commit "${R}"
lab_git -C "${R}" checkout -q main
printf '%s\n' '{ "mode": "block", "allow": ["docs/permitido.txt", "docs/de-main.txt"] }' > "${R}/scripts/ci/toy-rules.json"; commit "${R}" "main suma una"
lab_git -C "${R}" checkout -q pedido
run "${R}" "${T}/t17.out"
is "T17 sumar excepciones que el contenido no usa no frena: verde" "0" "${RC}"
has "T17 lista la primera suma, en su archivo" "${T}/t17.out" '+ allow: "docs/a.txt"'
has "T17 lista la segunda" "${T}/t17.out" '+ allow: "docs/b.txt"'
has "T17 lista la de la otra lista" "${T}/t17.out" '+ names: "dos"'
has "T17 cuenta por archivo" "${T}/t17.out" "scripts/ci/toy-rules.json (control toy): 2 suma(s)"
has "T17 la alarma cuenta la que trajo main" "${T}/t17.out" "main trajo, mientras el pedido estaba abierto: scripts/ci/toy-rules.json: 1 suma(s)"

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# Lo que encontró el pase adversarial, y los caminos de error: cada uno, con su caso
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
# add_node_control <carpeta>: un control de node que carga su ayudante con path.join(__dirname, …) y lanza un hijo
add_node_control() {
  local r="$1"
  mkdir -p "${r}/scripts/ci/lib"
  cat > "${r}/scripts/ci/toy-node.js" <<'JS'
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const helper = require(path.join(__dirname, 'lib', 'toy-helper.js'));
const root = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim();
const files = execFileSync('git', ['-C', root, 'diff', '--cached', '--name-only', '--diff-filter=ACMR']).toString().split('\n').filter((f) => f.startsWith('docs/'));
let bad = 0;
for (const f of files) {
  const text = execFileSync('git', ['-C', root, 'show', `:${f}`]).toString();
  if (helper.forbidden(text)) { console.log(`toy-node: vedado en ${f}`); bad++; }
}
const child = spawnSync(process.execPath, [path.join(__dirname, 'toy-child.js'), root], { stdio: 'inherit' });
process.exit(bad || child.status !== 0 ? 1 : 0);
JS
  printf '%s\n' "module.exports = { forbidden: (t) => t.includes('VEDADO') };" > "${r}/scripts/ci/lib/toy-helper.js"
  cat > "${r}/scripts/ci/toy-child.js" <<'JS'
const { execFileSync } = require('child_process');
const root = process.argv[2];
const files = execFileSync('git', ['-C', root, 'diff', '--cached', '--name-only', '--diff-filter=ACMR']).toString().split('\n').filter((f) => f.startsWith('docs/'));
const bad = files.filter((f) => execFileSync('git', ['-C', root, 'show', `:${f}`]).toString().includes('HIJO'));
for (const f of bad) console.log(`toy-child: hijo en ${f}`);
process.exit(bad.length ? 1 : 0);
JS
  printf '%s\n' 'node "$REPO_ROOT/scripts/ci/toy-node.js" || exit 1' >> "${r}/.githooks/pre-commit-checks"
  node -e 'const f=process.argv[1];const j=JSON.parse(require("fs").readFileSync(f,"utf8"));j.controls.push({name:"toy-node",script:"scripts/ci/toy-node.js",rules:[]});require("fs").writeFileSync(f,JSON.stringify(j,null,2))' "${r}/scripts/ci/controls-from-base.json"
  commit "${r}" "base con un control de node"
}
# inv <carpeta> <cuerpo JS sobre j>: edita el inventario del juguete
inv() { node -e 'const f=process.argv[1];const j=JSON.parse(require("fs").readFileSync(f,"utf8"));new Function("j",process.argv[2])(j);require("fs").writeFileSync(f,JSON.stringify(j,null,2))' "$1/scripts/ci/controls-from-base.json" "$2"; }

# T2 · el código que un control carga con path.join(__dirname, …) o lanza como hijo también sale de la base
R="${T}/t2b"; make_base "${R}"; add_node_control "${R}"; pr "${R}"
printf '%s\n' "module.exports = { forbidden: () => false };" > "${R}/scripts/ci/lib/toy-helper.js"
printf 'VEDADO\n' > "${R}/docs/vedado.txt"; commit "${R}"
run "${R}" "${T}/t2b.out"
is "T2 un ayudante vaciado (cargado con path.join) no saltea el control: rojo" "1" "${RC}"
has "T2 corre el ayudante de la base" "${T}/t2b.out" "toy-node: vedado en docs/vedado.txt"
has "T2 el ayudante es regla y se lista" "${T}/t2b.out" "scripts/ci/lib/toy-helper.js (código que corre un control)"
R="${T}/t2c"; make_base "${R}"; add_node_control "${R}"; pr "${R}"
printf 'process.exit(0)\n' > "${R}/scripts/ci/toy-child.js"; printf 'HIJO\n' > "${R}/docs/hijo.txt"; commit "${R}"
run "${R}" "${T}/t2c.out"
is "T2 un hijo vaciado (lanzado como proceso) no saltea el control: rojo" "1" "${RC}"
has "T2 corre el hijo de la base" "${T}/t2c.out" "toy-child: hijo en docs/hijo.txt"

# T1 · un control del inventario que ninguna pasada corre ni el pre-commit llama es rojo
R="${T}/t1b"; make_base "${R}"; printf 'exit 0\n' > "${R}/scripts/ci/huerfano.sh"
inv "${R}" 'j.controls.push({name:"huerfano",script:"scripts/ci/huerfano.sh",rules:[]})'; commit "${R}" "control huérfano"
bash "${SCRIPT}" check-inventory --root "${R}" > "${T}/t1b.out" 2>&1; RC=$?
is "T1 un control que nada corre: rojo" "1" "${RC}"
has "T1 lo nombra" "${T}/t1b.out" "ningún paso corre scripts/ci/huerfano.sh"
# un inventario sin pasadas no mide nada: rojo en check-inventory, y en una revisión, nunca verde
R="${T}/t1f"; make_base "${R}"; inv "${R}" 'j.passes=[]'; commit "${R}" "sin pasadas"
bash "${SCRIPT}" check-inventory --root "${R}" > "${T}/t1f.out" 2>&1; RC=$?
is "T1 un inventario sin pasadas: rojo" "1" "${RC}"
has "T1 lo dice" "${T}/t1f.out" "el inventario no trae ninguna pasada"
pr "${R}"; printf 'x\n' > "${R}/docs/x.txt"; commit "${R}"
run "${R}" "${T}/t1g.out"
is "T1 una revisión en la que no corre ninguna pasada: rojo, nunca verde" "1" "${RC}"
has "T1 …lo dice" "${T}/t1g.out" "no corrió ninguna pasada del inventario desde la base"
# un './x.json' se resuelve contra la carpeta del guion, no contra la raíz
R="${T}/t1c"; make_base "${R}"
printf '{}\n' > "${R}/scripts/ci/toy-local.json"; printf '{}\n' > "${R}/toy-local.json"
printf '%s\n' '# su lista: "./toy-local.json"' >> "${R}/scripts/ci/toy-check.sh"
inv "${R}" 'j.controls[0].rules.push("scripts/ci/toy-local.json")'; commit "${R}" "lista local"
bash "${SCRIPT}" check-inventory --root "${R}" > "${T}/t1c.out" 2>&1; RC=$?
is "T1 './x.json' es el de la carpeta del guion" "0" "${RC}"
# --ref, inventario roto y uso
bash "${SCRIPT}" check-inventory --root "${R}" --ref HEAD~1 > "${T}/t1d.out" 2>&1; RC=$?
is "T1 check-inventory --ref mira ese commit" "0" "${RC}"
bash "${SCRIPT}" check-inventory --root "${R}" --ref no-existe > "${T}/t1e.out" 2>&1; RC=$?
is "T1 check-inventory --ref que no resuelve: no pude correr" "9" "${RC}"
bash "${SCRIPT}" > /dev/null 2>&1; is "T1 sin comando: uso (exit 2)" "2" "$?"
bash "${SCRIPT}" run --root "${R}" > /dev/null 2>&1; is "T1 run sin --base ni --range: uso (exit 2)" "2" "$?"

# T9 · un inventario de la base que no se lee, un rango mal escrito, sin ancestro común: no pude correr
R="${T}/t9c"; make_base "${R}"; printf '{ roto\n' > "${R}/scripts/ci/controls-from-base.json"; commit "${R}" "inventario roto"; pr "${R}"; printf 'x\n' > "${R}/docs/x.txt"; commit "${R}"
run "${R}" "${T}/t9c.out"; is "T9 un inventario de la base que no se lee: no pude correr" "9" "${RC}"
R="${T}/t9d"; make_base "${R}"; pr "${R}"; printf 'x\n' > "${R}/docs/x.txt"; commit "${R}"
bash "${SCRIPT}" run --root "${R}" --base main --range main..pedido > /dev/null 2>&1; is "T9 un rango sin los tres puntos: no pude correr" "9" "$?"
lab_git -C "${R}" checkout -q --orphan huerfana && commit "${R}" "sin historia común"
bash "${SCRIPT}" run --root "${R}" --base main --range main...huerfana > "${T}/t9e.out" 2>&1; RC=$?
is "T9 sin ancestro común: no pude correr" "9" "${RC}"

# T10 · en una revisión, el inventario de la base que no cuadra es rojo; y el pedido que borra el suyo, se dice
R="${T}/t10b"; make_base "${R}"; inv "${R}" 'j.controls.push({name:"fantasma",script:"scripts/ci/fantasma.sh",rules:[]})'; commit "${R}" "fantasma en main"
pr "${R}"; printf 'x\n' > "${R}/docs/x.txt"; commit "${R}"
run "${R}" "${T}/t10b.out"; is "T10 run con un inventario de la base que no cuadra: rojo" "1" "${RC}"
has "T10 lo dice" "${T}/t10b.out" "el inventario de la base no cuadra"
R="${T}/t10c"; make_base "${R}"; pr "${R}"; lab_git -C "${R}" rm -q scripts/ci/controls-from-base.json; commit "${R}"
run "${R}" "${T}/t10c.out"
is "T10 el pedido que borra el inventario: rojo (borrar una regla que la base tiene es un cambio de control)" "1" "${RC}"
has "T10 corre el de la base y lo dice" "${T}/t10c.out" "el pedido no trae un inventario que se lea"
has "T10 …nombrando lo borrado" "${T}/t10c.out" "el pedido borra scripts/ci/controls-from-base.json, que la base tiene"
has "T10 …y el borrado se lista" "${T}/t10c.out" "scripts/ci/controls-from-base.json (el inventario): borrado"

# T8 · una constancia no tapa un rojo que viene de otra regla que main endureció después
R="${T}/t8d"; make_base "${R}"; pr "${R}"
printf '%s\n' '{ "mode": "block", "allow": ["docs/permitido.txt", "docs/malo.txt"] }' > "${R}/scripts/ci/toy-rules.json"
printf 'PROHIBIDO\n' > "${R}/docs/malo.txt"; printf 'OTRO\n' > "${R}/docs/otro2.txt"; commit "${R}"
lab_git -C "${R}" checkout -q main
sed -i.bak 's/WORD="PROHIBIDO"/WORD="PROHIBIDO"; grep -rq OTRO "$REPO_ROOT\/docs" \&\& { echo "toy: OTRO en docs"; exit 1; }/' "${R}/scripts/ci/toy-check.sh"; rm -f "${R}/scripts/ci/toy-check.sh.bak"
commit "${R}" "main endurece el control"
lab_git -C "${R}" checkout -q pedido
bash "${SCRIPT}" pending --root "${R}" --base main --range main...pedido > "${T}/t8d-pending.out" 2>&1
ENTRIES="$(sed -n "s/^.* --entries '\(.*\)'\$/\1/p" "${T}/t8d-pending.out" | head -n 1)"
LINE="$(node -e 'const e=JSON.parse(process.argv[1]);const t=e.map(x=>`${x.path}\t${x.blob}\n`).sort().join("");console.log(JSON.stringify({hash:require("crypto").createHash("sha256").update(t).digest("hex"),rules:e,at:"2026-10-17",by:"dueño"}))' "${ENTRIES}" 2>/dev/null)"
mkdir -p "${R}/.tycon"; printf '%s\n' "${LINE}" > "${R}/.tycon/control-changes.jsonl"; commit "${R}" "constancia"
run "${R}" "${T}/t8d.out"
is "T8 la constancia de un aflojamiento no tapa lo que main endureció: rojo" "1" "${RC}"
has "T8 lo dice" "${T}/t8d.out" "la constancia cubre scripts/ci/toy-rules.json, pero la base sigue frenando"
# la constancia del público tiene que poder commitearse: su archivo no está ignorado por el .gitignore del repo
if [ -d "${ROOT}/.git" ] || [ -f "${ROOT}/.git" ]; then
  APPROVALS="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log([].concat(j.approvals)[0])' "${ROOT}/scripts/ci/controls-from-base.json")"
  if git -C "${ROOT}" check-ignore -q "${APPROVALS}"; then no "T8 el .gitignore del repo ignora ${APPROVALS}: la constancia no llegaría al pedido"; else ok "T8 ${APPROVALS} no está ignorado: la constancia se puede commitear"; fi
fi
# en GitHub el commit revisado es el merge de la base con el pedido: la constancia firmada sobre el pedido vale igual
R="${T}/t8f"; make_base "${R}"; pr "${R}"
printf '%s\n' '{ "mode": "block", "allow": ["docs/permitido.txt", "docs/malo.txt"] }' > "${R}/scripts/ci/toy-rules.json"
printf 'PROHIBIDO\n' > "${R}/docs/malo.txt"; commit "${R}"
bash "${SCRIPT}" pending --root "${R}" --base main --range main...pedido > "${T}/t8f-pending.out" 2>&1
ENTRIES="$(sed -n "s/^.* --entries '\(.*\)'\$/\1/p" "${T}/t8f-pending.out" | head -n 1)"
LINE="$(node -e 'const e=JSON.parse(process.argv[1]);const t=e.map(x=>`${x.path}\t${x.blob}\n`).sort().join("");console.log(JSON.stringify({hash:require("crypto").createHash("sha256").update(t).digest("hex"),rules:e,at:"2026-10-17",by:"dueño"}))' "${ENTRIES}" 2>/dev/null)"
mkdir -p "${R}/.tycon"; printf '%s\n' "${LINE}" > "${R}/.tycon/control-changes.jsonl"; commit "${R}" "constancia"
lab_git -C "${R}" checkout -q main; printf 'otra cosa\n' > "${R}/docs/de-main.txt"; commit "${R}" "main avanza"
lab_git -C "${R}" checkout -q -b merge-ref main; lab_git -C "${R}" merge -q --no-ff --no-edit pedido > /dev/null 2>&1
bash "${SCRIPT}" run --root "${R}" --base main --range main...merge-ref > "${T}/t8f.out" 2>&1; RC=$?
is "T8 con el merge de GitHub, la constancia firmada sobre el pedido vale" "0" "${RC}"
has "T8 …y lo dice" "${T}/t8f.out" "cambio de control aprobado: scripts/ci/toy-rules.json"
# --approvals-out decide a qué archivo apunta la firma que imprime el rojo (la 170 pasa el del repo de mantenimiento)
run "${T}/t8" "${T}/t8g.out" --approvals-out .tycon/otro-archivo.jsonl
has "T8 el comando de la firma apunta al archivo pedido con --approvals-out" "${T}/t8g.out" "--out '.tycon/otro-archivo.jsonl' --entries"
# las constancias pueden estar en cualquiera de los archivos del inventario
R="${T}/t8h"; make_base "${R}"; inv "${R}" 'j.approvals=[".github/control-changes.jsonl",".tycon/control-changes.jsonl"]'; commit "${R}" "dos archivos de constancias"; pr "${R}"
printf '%s\n' '{ "mode": "block", "allow": ["docs/permitido.txt", "docs/malo.txt"] }' > "${R}/scripts/ci/toy-rules.json"; printf 'PROHIBIDO\n' > "${R}/docs/malo.txt"; commit "${R}"
bash "${SCRIPT}" pending --root "${R}" --base main --range main...pedido > "${T}/t8h-pending.out" 2>&1
has "T8 sin --approvals-out, la firma va al primer archivo del inventario" "${T}/t8h-pending.out" "--out '.github/control-changes.jsonl'"
ENTRIES="$(sed -n "s/^.* --entries '\(.*\)'\$/\1/p" "${T}/t8h-pending.out" | head -n 1)"
LINE="$(node -e 'const e=JSON.parse(process.argv[1]);const t=e.map(x=>`${x.path}\t${x.blob}\n`).sort().join("");console.log(JSON.stringify({hash:require("crypto").createHash("sha256").update(t).digest("hex"),rules:e,at:"2026-10-17",by:"dueño"}))' "${ENTRIES}" 2>/dev/null)"
mkdir -p "${R}/.tycon"; printf '%s\n' "${LINE}" > "${R}/.tycon/control-changes.jsonl"; commit "${R}" "constancia en el segundo archivo"
run "${R}" "${T}/t8h.out"
has "T8 una constancia en el segundo archivo del inventario vale" "${T}/t8h.out" "cambio de control aprobado: scripts/ci/toy-rules.json"
# la base frena sin que el pedido cambie reglas: main endureció; el pedido se pone al día
R="${T}/t8i"; make_base "${R}"; pr "${R}"; printf 'OTRO\n' > "${R}/docs/otro3.txt"; commit "${R}"
lab_git -C "${R}" checkout -q main
sed -i.bak 's/WORD="PROHIBIDO"/WORD="PROHIBIDO"; grep -rq OTRO "$REPO_ROOT\/docs" \&\& { echo "toy: OTRO en docs"; exit 1; }/' "${R}/scripts/ci/toy-check.sh"; rm -f "${R}/scripts/ci/toy-check.sh.bak"
commit "${R}" "main endurece"; lab_git -C "${R}" checkout -q pedido
run "${R}" "${T}/t8i.out"
is "T8 lo que main endureció alcanza al pedido viejo: rojo" "1" "${RC}"
has "T8 dice que el pedido tiene que ponerse al día" "${T}/t8i.out" "el pedido tiene que ponerse al día"
bash "${SCRIPT}" run --root "${T}/no-existe" --base main --range main...pedido > /dev/null 2>&1; is "T9 un --root que no existe: no pude correr" "9" "$?"
bash "${SCRIPT}" pending --root "${T}/t7" --base main --range main...main > "${T}/t8e.out" 2>&1
has "T8 pending sin cambios: no hay nada que firmar" "${T}/t8e.out" "no hay nada que firmar"

# T15 · borrar un workflow que la base tiene es rojo, también el opcional; el yml de la 170 tiene sus marcas
R="${T}/t15b"; make_base "${R}"; pr "${R}"; lab_git -C "${R}" rm -q .github/workflows/ci.yml; commit "${R}"
run "${R}" "${T}/t15b.out"
is "T15 un pedido que borra el workflow: rojo" "1" "${RC}"
has "T15 lo nombra" "${T}/t15b.out" "el pedido borra .github/workflows/ci.yml, que la base tiene"
R="${T}/t15c"; make_base "${R}"
mkdir -p "${R}/pipelines"; printf '%s\n' 'steps: bash "$MAIN_DIR/scripts/ci/run-base-controls.sh" run' > "${R}/pipelines/azure-pipelines-maintainers-pr.yml"
inv "${R}" 'j.workflows.push({path:"pipelines/azure-pipelines-maintainers-pr.yml",optional:true,must_contain:["scripts/ci/run-base-controls.sh\" run"]})'; commit "${R}" "con el yml de la 170"
pr "${R}"; printf '%s\n' 'steps: bash scripts/otra-cosa.sh' > "${R}/pipelines/azure-pipelines-maintainers-pr.yml"; commit "${R}"
run "${R}" "${T}/t15c.out"
is "T15 el yml de la 170 que deja de traer la base: rojo" "1" "${RC}"
has "T15 lo nombra" "${T}/t15c.out" "pipelines/azure-pipelines-maintainers-pr.yml ya no trae la base"
lab_git -C "${R}" rm -q pipelines/azure-pipelines-maintainers-pr.yml; commit "${R}" "lo borra"
run "${R}" "${T}/t15d.out"
is "T15 borrar el yml opcional que la base tiene: rojo" "1" "${RC}"
# un cambio legítimo al workflow, con la constancia: entra
#   (como check-public-workflow.js: la base trae la forma del workflow, y el pedido cambia el workflow y la forma juntos)
R="${T}/t15e"; make_base "${R}"
printf '%s\n' '! grep -q "una nota" .github/workflows/ci.yml' > "${R}/scripts/ci/toy-forma.sh"
inv "${R}" 'j.controls.push({name:"toy-forma",script:"scripts/ci/toy-forma.sh",rules:[]}); j.passes.push({name:"forma",mode:"tree",cmd:["bash","scripts/ci/toy-forma.sh"]})'; commit "${R}" "la forma del workflow"
pr "${R}"; printf '%s\n' '# una nota' >> "${R}/.github/workflows/ci.yml"; printf 'exit 0\n' > "${R}/scripts/ci/toy-forma.sh"; commit "${R}"
run "${R}" "${T}/t15e.out"; is "T15 un cambio al workflow sin constancia: rojo" "1" "${RC}"
bash "${SCRIPT}" pending --root "${R}" --base main --range main...pedido > "${T}/t15e-pending.out" 2>&1
ENTRIES="$(sed -n "s/^.* --entries '\(.*\)'\$/\1/p" "${T}/t15e-pending.out" | head -n 1)"
LINE="$(node -e 'const e=JSON.parse(process.argv[1]);const t=e.map(x=>`${x.path}\t${x.blob}\n`).sort().join("");console.log(JSON.stringify({hash:require("crypto").createHash("sha256").update(t).digest("hex"),rules:e,at:"2026-10-17",by:"dueño"}))' "${ENTRIES}" 2>/dev/null)"
mkdir -p "${R}/.tycon"; printf '%s\n' "${LINE}" > "${R}/.tycon/control-changes.jsonl"; commit "${R}" "constancia"
run "${R}" "${T}/t15f.out"
has "T15 con la constancia del dueño, el cambio al workflow entra" "${T}/t15f.out" "cambio de control aprobado: .github/workflows/ci.yml"

# las pasadas en modo árbol y en modo rango corren de verdad; lo que una pasada necesita y el pedido borra es rojo
R="${T}/tpass"; make_base "${R}"
printf '%s\n' '[ -f docs/leeme.txt ] || exit 1; exit 0' > "${R}/scripts/ci/toy-tree.sh"
printf '%s\n' 'git diff --name-only "$1" "$2" | grep RANGO >/dev/null && { echo "toy-range: RANGO entre $1 y $2"; exit 1; }; exit 0' > "${R}/scripts/ci/toy-range.sh"
inv "${R}" 'j.controls.push({name:"toy-tree",script:"scripts/ci/toy-tree.sh",rules:[]},{name:"toy-range",script:"scripts/ci/toy-range.sh",rules:[]}); j.passes.push({name:"toy-tree",mode:"tree",cmd:["bash","scripts/ci/toy-tree.sh"],if_exists:["docs/leeme.txt"]},{name:"toy-range",mode:"range",cmd:["bash","scripts/ci/toy-range.sh","{base}","{tip}"]})'
commit "${R}" "pasadas de árbol y de rango"; pr "${R}"; printf 'x\n' > "${R}/docs/RANGO.txt"; commit "${R}"
run "${R}" "${T}/tpass.out"
is "T2 la pasada de rango recibe {base} y {tip}: rojo" "1" "${RC}"
has "T2 corrió la pasada de rango" "${T}/tpass.out" "toy-range: RANGO entre"
R2="${T}/tpass2"; cp -R "${R}" "${R2}"; lab_git -C "${R2}" reset -q --hard main; lab_git -C "${R2}" rm -q docs/leeme.txt; commit "${R2}" "borra lo que la pasada necesita"
run "${R2}" "${T}/tpass2.out"
is "T2 el pedido borra un archivo que la pasada necesita y la base tiene: rojo" "1" "${RC}"
has "T2 lo dice" "${T}/tpass2.out" "el pedido borra docs/leeme.txt, que la pasada toy-tree necesita"

# T16 · la alarma mira desde el pedido: en GitHub el commit revisado es un merge que ya contiene la base
R="${T}/t16c"; make_base "${R}"; pr "${R}"; printf 'limpio\n' > "${R}/docs/otro.txt"; commit "${R}"
lab_git -C "${R}" checkout -q main; printf '%s\n' '# sin firmar' >> "${R}/.github/workflows/ci.yml"; commit "${R}" "main toca el workflow"
SIN="$(lab_git -C "${R}" rev-parse --short=12 HEAD)"
lab_git -C "${R}" checkout -q -b merge-ref main; lab_git -C "${R}" merge -q --no-ff --no-edit pedido > /dev/null 2>&1
bash "${SCRIPT}" run --root "${R}" --base main --range main...merge-ref > "${T}/t16c.out" 2>&1; RC=$?
is "T16 con el commit de merge de GitHub, el pedido limpio sigue verde" "0" "${RC}"
has "T16 la alarma mira desde el pedido (el segundo padre)" "${T}/t16c.out" "main trajo .github/workflows/ci.yml en ${SIN} sin constancia del dueño"
# una sola alarma por archivo: dos commits al workflow, firmado el final, no avisan
R="${T}/t16d"; make_base "${R}"; pr "${R}"; printf 'limpio\n' > "${R}/docs/otro.txt"; commit "${R}"
lab_git -C "${R}" checkout -q main
printf '%s\n' '# uno' >> "${R}/.github/workflows/ci.yml"; commit "${R}" "uno"
printf '%s\n' '# dos' >> "${R}/.github/workflows/ci.yml"; commit "${R}" "dos"
BLOB="$(lab_git -C "${R}" rev-parse HEAD:.github/workflows/ci.yml)"; mkdir -p "${R}/.tycon"
printf '{"hash":"x","rules":[{"path":".github/workflows/ci.yml","blob":"%s"}],"at":"2026-10-17","by":"dueño"}\n' "${BLOB}" > "${R}/.tycon/control-changes.jsonl"
printf 'esto no es JSON\n' >> "${R}/.tycon/control-changes.jsonl"; commit "${R}" "firma del final"
lab_git -C "${R}" checkout -q pedido
run "${R}" "${T}/t16d.out"
lacks "T16 dos commits al workflow con el final firmado: no avisa" "${T}/t16d.out" "sin constancia del dueño"
has "T16 una línea rota en las constancias se avisa" "${T}/t16d.out" "una línea de .tycon/control-changes.jsonl no se lee"
# --alarm-range explícito: el que resuelve mira ese tramo; el que no, lo dice
run "${R}" "${T}/t16e.out" --alarm-range "main~3..main~2"
has "T16 --alarm-range mira el tramo pedido (el commit intermedio, sin firma)" "${T}/t16e.out" "sin constancia del dueño"
run "${R}" "${T}/t16f.out" --alarm-range "no..existe"
has "T16 --alarm-range que no resuelve lo dice" "${T}/t16f.out" "la alarma a posteriori NO miró nada"
# un workflow que main borró sin constancia también avisa
R="${T}/t16h"; make_base "${R}"; pr "${R}"; printf 'limpio\n' > "${R}/docs/otro.txt"; commit "${R}"
lab_git -C "${R}" checkout -q main; lab_git -C "${R}" rm -q .github/workflows/ci.yml; commit "${R}" "main borra el workflow"; lab_git -C "${R}" checkout -q pedido
run "${R}" "${T}/t16h.out"
has "T16 main borró el workflow sin constancia: avisa" "${T}/t16h.out" "main trajo .github/workflows/ci.yml en"
# un archivo de regla que main dejó ilegible: la alarma dice que no pudo comparar
R="${T}/t16g"; make_base "${R}"; pr "${R}"; printf 'limpio\n' > "${R}/docs/otro.txt"; commit "${R}"
lab_git -C "${R}" checkout -q main; printf '{ roto\n' > "${R}/scripts/ci/toy-names.json"; commit "${R}" "main rompe una lista"; lab_git -C "${R}" checkout -q pedido
run "${R}" "${T}/t16g.out"
has "T16 una regla de main que no es JSON: la alarma no pudo comparar" "${T}/t16g.out" "no pude comparar scripts/ci/toy-names.json"

# T17 · lo que viene del pedido no arma líneas propias en el registro: una clave con salto de línea sale escapada
R="${T}/t17c"; make_base "${R}"; pr "${R}"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ names: ["uno"], "x\n::error::firmá esto\n##vso[task.complete]": 1, "y\r::warning::r ###vso[x] :::z": 2 }))' "${R}/scripts/ci/toy-names.json"
printf 'x\n' > "${R}/docs/x.txt"; commit "${R}"
run "${R}" "${T}/t17c.out"
if grep -E '::|##' "${T}/t17c.out" >/dev/null; then no "T17 una clave del pedido dejó un comando de la CI (:: o ##) en el registro"; else ok "T17 ningún «::» ni «##» del pedido llega entero al registro"; fi
# lo mismo con lo que el pedido mete en su inventario: un nombre de guion con salto de línea y un comando de la CI
R="${T}/t17d"; make_base "${R}"; pr "${R}"
inv "${R}" 'j.controls.push({name:"x",script:"scripts/ci/no-esta.sh\n::error::forjado",rules:[]})'; printf 'x\n' > "${R}/docs/x.txt"; commit "${R}"
run "${R}" "${T}/t17d.out"
if grep -E '::|##' "${T}/t17d.out" >/dev/null; then no "T17 un nombre del inventario del pedido dejó un comando de la CI en el registro"; else ok "T17 lo que trae el inventario del pedido tampoco arma comandos de la CI"; fi
has "T17 el salto de línea sale escapado y el comando partido" "${T}/t17c.out" 'x\n: :error: :'

# la salida de un control rojo también: un nombre de archivo del pedido con un comando de la CI sale partido
R="${T}/t17e"; make_base "${R}"; pr "${R}"; printf 'PROHIBIDO\n' > "${R}/docs/a::error::b.txt"; commit "${R}"
run "${R}" "${T}/t17e.out"
is "T17 el contenido prohibido frena igual" "1" "${RC}"
if grep -E '::|##' "${T}/t17e.out" >/dev/null; then no "T17 la salida de un control rojo dejó un comando de la CI en el registro"; else ok "T17 la salida de un control rojo sale neutralizada"; fi

# T17 · el orden de las claves no inventa sumas
R="${T}/t17b"; make_base "${R}"
printf '%s\n' '{ "names": [ { "a": 1, "b": 2 } ] }' > "${R}/scripts/ci/toy-names.json"; commit "${R}" "objetos"; pr "${R}"
printf '%s\n' '{ "names": [ { "b": 2, "a": 1 } ] }' > "${R}/scripts/ci/toy-names.json"; printf 'x\n' > "${R}/docs/x.txt"; commit "${R}"
run "${R}" "${T}/t17b.out"
has "T17 reordenar las claves no suma nada" "${T}/t17b.out" "scripts/ci/toy-names.json (control toy): 0 suma(s)"
lacks "T17 …ni saca nada" "${T}/t17b.out" '- names:'

echo
if [ "${FAILS}" -eq 0 ]; then echo "✅ base-controls: ${TOTAL} verificaciones verdes"; exit 0; fi
echo "❌ base-controls: ${FAILS} de ${TOTAL} en rojo"
exit 1
