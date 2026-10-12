#!/usr/bin/env bash
# projects-snapshot.test.sh — los casos de la foto por proyecto (story 2.20).
#
# La foto proyecta, por cada repo con stories, la lista que lee el control de proyectos de un producto del equipo:
# stories, épicas, sprints, plan, alertas y las métricas que el medidor ya calculó. Todo lo que
# DECIDE algo (qué es una story, qué estado es cerrado, qué es evidencia) viene importado del
# medidor, del descubridor y del portón; estos casos vigilan que siga siendo así.
#
# 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la MUTACIÓN que lo pone en rojo.
#
# Portable: sólo git y node, fixtures en mktemp -d, HOME falso. El exit code se lee ANTES de
# cualquier pipe.

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FOTO="$RAIZ/scripts/nightly/projects/snapshot.js"
MEDIDOR="$RAIZ/scripts/metrics/sdlc-stage-metrics.js"
HOME="$(mktemp -d)"; export HOME
TMP="$(mktemp -d)"
trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP" "$HOME"' EXIT
export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@ejemplo.test
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@ejemplo.test
unset TYCON_STATES_PATH TYCON_TODAY TYCON_STORY_SCAN_BUDGET_MS
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

echo "== projects-snapshot.test.sh =="

# ── fixtures ────────────────────────────────────────────────────────────────────────────────

# repo_nuevo <dir> — git init con la huella del arnés (.tycon/) para que `--only-harness` lo mida.
repo_nuevo() {
  mkdir -p "$1/.tycon" "$1/specs"
  git -C "$1" init -q -b main
  echo "stories: {}" > "$1/.tycon/advisors.yaml"
}

# commit_en <dir> <fecha ISO> <mensaje> — commitea todo con fecha fija.
commit_en() {
  git -C "$1" add -A
  GIT_AUTHOR_DATE="$2" GIT_COMMITTER_DATE="$2" git -C "$1" commit -q -m "$3"
}

# story <dir> <id> <status> [clave=valor ...] — escribe specs/story-<id>.md con frontmatter mínimo.
# Las claves extra se escriben tal cual (`sprint=2`, `ado_work_item=101`, `epic=3`…); `sprint=-`
# omite el sprint.
story() {
  local dir="$1" id="$2" st="$3"; shift 3
  local epic="${id%%.*}" sprint="1" extra="" body="Cuerpo de la story $id."
  local wi="ado_work_item: 9$(echo "$id" | tr -d '.')"
  for kv in "$@"; do
    case "$kv" in
      epic=*) epic="${kv#epic=}" ;;
      sprint=*) sprint="${kv#sprint=}" ;;
      body=*) body="${kv#body=}" ;;
      ado_work_item=-) wi="" ;;
      ado_work_item=*) wi="ado_work_item: ${kv#ado_work_item=}" ;;
      *) extra="$extra${kv%%=*}: ${kv#*=}"$'\n' ;;
    esac
  done
  {
    echo "---"
    echo "epic: $epic"
    echo "story: \"$id\""
    echo "title: \"Story $id\""
    echo "status: $st"
    [ "$sprint" != "-" ] && echo "sprint: $sprint"
    echo "priority: \"P1\""
    [ -n "$wi" ] && echo "$wi"
    printf '%s' "$extra"
    echo "---"
    echo
    echo "$body"
  } > "$dir/specs/story-$id.md"
}

# j <archivo> <expresión JS sobre `j`> — imprime el resultado (para comparar en bash).
j() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const r=(new Function("j","return ("+process.argv[2]+")"))(j);console.log(typeof r==="string"?r:JSON.stringify(r))' "$1" "$2"; }

foto() { node "$FOTO" "$@"; }

[ -f "$FOTO" ] || echo "  ·    — $FOTO no existe todavía: los casos que lo corren salen en rojo"

# ── T1 · Contrato_ClavesExactasYUnArchivoPorRepo (AC 1, 2, 8) ──
# 🔴 rojo previo: sin el guion no hay archivos; volcar el frontmatter → claves de más en stories[].
R="$TMP/t1"; mkdir -p "$R"
repo_nuevo "$R/A__S"; for i in 1 2 3 4; do story "$R/A__S" "1.$i" backlog; done; commit_en "$R/A__S" 2026-09-01T10:00:00Z inicial
repo_nuevo "$R/A__Code"; echo x > "$R/A__Code/a.txt"; commit_en "$R/A__Code" 2026-09-01T10:00:00Z inicial
repo_nuevo "$R/B__P"; story "$R/B__P" 1.1 backlog; story "$R/B__P" 1.2 done; commit_en "$R/B__P" 2026-09-01T10:00:00Z inicial
SALIDA="$(foto --scan "$R" --only-harness --out "$TMP/t1-out" 2>&1)"; RC=$?
ARCH="$(cd "$TMP/t1-out" 2>/dev/null && ls | tr '\n' ' ')"
if [ "$RC" = 0 ] && [ "$ARCH" = "A__S.json B__P.json " ]; then ok "T1 un archivo por repo con stories ($ARCH)"
else mal "T1 archivos esperados A__S.json B__P.json, hay «${ARCH}» (exit $RC)"; fi
K="$(j "$TMP/t1-out/A__S.json" 'Object.keys(j).join(",")' 2>/dev/null)"
[ "$K" = "v,generated_at,proyecto,repo,cobertura,plan,epicas,sprints,stories,alertas,metricas" ] \
  && ok "T1 claves de primer nivel exactas" || mal "T1 claves de primer nivel: $K"
K="$(j "$TMP/t1-out/A__S.json" 'Object.keys(j.stories[0]).join(",")' 2>/dev/null)"
[ "$K" = "id,titulo,ruta,estado,canonico,grupo,epica,sprint,prioridad,ado_work_item,depends_on,followup_of,followup_reason,evidencia_de_cierre,dias_en_estado,tandas_pendientes" ] \
  && ok "T1 stories[] con las 16 claves y nada más" || mal "T1 claves de stories[]: $K"
[ "$(j "$TMP/t1-out/A__S.json" '[j.v,j.proyecto,j.repo,j.stories.length].join("|")' 2>/dev/null)" = "1|A|S|4" ] \
  && ok "T1 v, proyecto, repo y 4 stories" || mal "T1 v/proyecto/repo/stories mal"
grep -q "A__Code" <<<"$SALIDA" && ok "T1 A__Code se nombra como «sin stories»" || mal "T1 la salida no nombra A__Code"
foto --repo "$R/B__P" --out "$TMP/t1-uno" >/dev/null 2>&1; RC=$?
[ "$RC" = 0 ] && [ -f "$TMP/t1-uno/B__P.json" ] && ok "T1 --repo mide un solo repo" || mal "T1 --repo no escribió B__P.json (exit $RC)"

# ── T2 · Estados_CanonicoGrupoYDesconocido (AC 2, 6) ──
# 🔴 rojo previo: una lista propia de estados en vez del diccionario → `implemented` sale desconocido;
#    leer el estado con un escalar que no corta el comentario → `done   # nota` sale desconocido
#    (pasó en un repo real el 2026-10-07: el medidor lo contaba cerrado y la foto, no).
R="$TMP/t2"; repo_nuevo "$R/P__S"
story "$R/P__S" 1.1 done; story "$R/P__S" 1.2 implemented; story "$R/P__S" 1.3 review
story "$R/P__S" 1.4 deferred; story "$R/P__S" 1.5 cancelled; story "$R/P__S" 1.6 "done   # habilitada, sin depender de nada"
commit_en "$R/P__S" 2026-09-01T10:00:00Z inicial
foto --repo "$R/P__S" --out "$TMP/t2-out" >/dev/null 2>&1
G="$(j "$TMP/t2-out/P__S.json" 'j.stories.map(s=>s.id+":"+s.canonico+":"+s.grupo).join(" ")' 2>/dev/null)"
[ "$G" = "1.1:done:cerrado 1.2:done:cerrado 1.3:review:en_curso 1.4:null:desconocido 1.5:cancelled:sin_entrega 1.6:done:cerrado" ] \
  && ok "T2 canónico y grupo salen del diccionario (alias incluido)" || mal "T2 estados: $G"
[ "$(j "$TMP/t2-out/P__S.json" 'JSON.stringify(j.cobertura.desconocidos)')" = '{"deferred":1}' ] \
  && ok "T2 cobertura.desconocidos cuenta el estado fuera del diccionario" || mal "T2 cobertura.desconocidos mal"
[ "$(j "$TMP/t2-out/P__S.json" 'j.stories[1].estado')" = "implemented" ] && ok "T2 estado crudo intacto" || mal "T2 estado crudo perdido"

# ── T3 · Epicas_TituloDesdeArchivoOEpicsMd_ONull (AC 3) ──
# 🔴 rojo previo: inventar el título desde el slug del archivo o desde el id.
R="$TMP/t3"; repo_nuevo "$R/P__S"
story "$R/P__S" 1.1 done epic=1; story "$R/P__S" 2.1 backlog epic=2; story "$R/P__S" 3.1 backlog epic=3
printf '# Épica 1 — Encuesta\n\nTexto.\n' > "$R/P__S/specs/epica-1-encuesta.md"
printf '# Épicas\n\n## Epic 2 — Pagos\n\n## Epic 20 — Otra\n' > "$R/P__S/specs/epics.md"
commit_en "$R/P__S" 2026-09-01T10:00:00Z inicial
foto --repo "$R/P__S" --out "$TMP/t3-out" >/dev/null 2>&1
E="$(j "$TMP/t3-out/P__S.json" 'j.epicas.map(e=>e.id+"="+e.titulo).join(" | ")' 2>/dev/null)"
[ "$E" = "1=Épica 1 — Encuesta | 2=Epic 2 — Pagos | 3=null" ] && ok "T3 título desde archivo, desde epics.md, o null" || mal "T3 épicas: $E"
C="$(j "$TMP/t3-out/P__S.json" 'Object.keys(j.epicas[2].conteo).sort().join(",")+"/"+j.epicas[0].conteo.cerrado' 2>/dev/null)"
[ "$C" = "backlog,bloqueado,cerrado,en_curso,sin_entrega/1" ] && ok "T3 conteo con las cinco claves" || mal "T3 conteo: $C"

# ── T4 · Sprints_OrdenYSinSprint (AC 4) ──
# 🔴 rojo previo: perder las stories sin sprint o con sprint no entero.
R="$TMP/t4"; repo_nuevo "$R/P__S"
story "$R/P__S" 1.1 backlog sprint=2; story "$R/P__S" 1.2 backlog sprint=1
story "$R/P__S" 1.3 backlog 'sprint="x"'; story "$R/P__S" 1.4 backlog sprint=-
# `sprint="x"` entra como clave extra: se corrige a mano para que quede una sola línea de sprint.
sed -i.bak '/^sprint: 1$/d' "$R/P__S/specs/story-1.3.md"; rm -f "$R/P__S/specs/"*.bak
commit_en "$R/P__S" 2026-09-01T10:00:00Z inicial
foto --repo "$R/P__S" --out "$TMP/t4-out" >/dev/null 2>&1
S="$(j "$TMP/t4-out/P__S.json" 'j.sprints.map(s=>s.n+":"+s.stories.join("+")).join(" ")' 2>/dev/null)"
[ "$S" = "1:1.2 2:1.1 null:1.3+1.4" ] && ok "T4 sprints en orden y el balde sin sprint al final" || mal "T4 sprints: $S"

# ── T5 · Plan_SoloLoQueExisteConSuUltimoCommit (AC 5) ──
# 🔴 rojo previo: listar rutas que no existen, o inventar una fecha para lo no commiteado.
R="$TMP/t5"; repo_nuevo "$R/P__S"; story "$R/P__S" 1.1 backlog
echo "# PRD" > "$R/P__S/specs/prd.md"
commit_en "$R/P__S" 2026-09-03T10:00:00Z inicial
echo "# Épicas" > "$R/P__S/specs/epics.md"
foto --repo "$R/P__S" --out "$TMP/t5-out" >/dev/null 2>&1
P="$(j "$TMP/t5-out/P__S.json" 'j.plan.map(p=>p.ruta+"@"+(p.ultimo_commit?p.ultimo_commit.slice(0,10):null)).join(" ")' 2>/dev/null)"
[ "$P" = "specs/epics.md@null specs/prd.md@2026-09-03" ] && ok "T5 plan con lo que existe y su último commit" || mal "T5 plan: $P"

# ── T6 · Evidencia_PropiaYDeCompanero_NullSiParcial (AC 9) ──
# 🔴 rojo previo: mirar sólo el repo propio → 1.3 y 1.4 salen false; dar false con escaneo parcial.
R="$TMP/t6"; repo_nuevo "$R/A__S"
for i in 1 2 3 4 5; do story "$R/A__S" "1.$i" done; done
printf 'evidence:\n  companion_repos:\n    - C\n' > "$R/A__S/.tycon/advisors.yaml"
mkdir -p "$R/A__S/.advisors/dod-runtime" "$R/A__Back/.advisors/dod-runtime" "$R/C/.advisors/dod-runtime"
echo "# gate" > "$R/A__S/.advisors/dod-runtime/1.2-e2e-gate.md"
echo '{}' > "$R/A__Back/.advisors/dod-runtime/1.3-smoke-ledger.jsonl"
echo "# gate" > "$R/C/.advisors/dod-runtime/1.4-e2e-gate.md"
echo "# matriz" > "$R/A__S/.advisors/dod-runtime/1.5-runtime-matrix.md"
commit_en "$R/A__S" 2026-09-01T10:00:00Z inicial
foto --repo "$R/A__S" --out "$TMP/t6-out" >/dev/null 2>&1
EV="$(j "$TMP/t6-out/A__S.json" 'j.stories.map(s=>s.id+"="+s.evidencia_de_cierre).join(" ")' 2>/dev/null)"
[ "$EV" = "1.1=false 1.2=true 1.3=true 1.4=true 1.5=false" ] \
  && ok "T6 evidencia propia, del hermano y del compañero declarado, con el criterio del portón" || mal "T6 evidencia: $EV"
cat > "$TMP/parcial.js" <<'JS'
// Precarga del caso T6: marca el descubrimiento como PARCIAL sin tocar el código de producción.
const Module = require('module');
const cargar = Module._load;
Module._load = function (pedido, ...resto) {
  const m = cargar.call(this, pedido, ...resto);
  if (/story-discovery(\.js)?$/.test(pedido) && m && !m.__parcial) {
    const original = m.discoverStories;
    m.discoverStories = (...a) => ({ ...original(...a), partial: true });
    m.__parcial = true;
  }
  return m;
};
JS
node -r "$TMP/parcial.js" "$FOTO" --repo "$R/A__S" --out "$TMP/t6-parcial" >/dev/null 2>&1
EV="$(j "$TMP/t6-parcial/A__S.json" 'j.cobertura.partial+"|"+j.stories.map(s=>String(s.evidencia_de_cierre)).join(",")' 2>/dev/null)"
[ "$EV" = "true|null,null,null,null,null" ] && ok "T6 con escaneo parcial la evidencia es null, nunca false" || mal "T6 parcial: $EV"

# ── T7 · Alertas_LasSeisYNingunaOtra (AC 7) ──
# 🔴 rojo previo: emitir `estancada` con dias_en_estado null; una alerta fuera de la lista.
R="$TMP/t7"; repo_nuevo "$R/P__S"
story "$R/P__S" 2.1 done
story "$R/P__S" 2.2 backlog
story "$R/P__S" 2.3 backlog ado_work_item=TBD
story "$R/P__S" 2.4 deferred
printf -- '---\nstory: "2.5"\nstatus: backlog\ntitle: "rota"\n\nSin cierre.\n' > "$R/P__S/specs/story-2.5.md"
story "$R/P__S" 2.6 backlog 'depends_on=["9.9"]'
commit_en "$R/P__S" 2026-09-01T10:00:00Z inicial
sed -i.bak 's/^status: backlog$/status: in-progress/' "$R/P__S/specs/story-2.2.md"; rm -f "$R/P__S/specs/"*.bak
commit_en "$R/P__S" 2026-10-01T10:00:00Z "2.2 en curso"
TYCON_TODAY=2026-10-30 foto --repo "$R/P__S" --out "$TMP/t7-out" >/dev/null 2>&1
A="$(j "$TMP/t7-out/P__S.json" '[...new Set(j.alertas.map(a=>a.tipo))].sort().join(",")' 2>/dev/null)"
[ "$A" = "dependencia_rota,done_sin_evidencia,estado_desconocido,estancada,frontmatter_ilegible,sin_work_item" ] \
  && ok "T7 las seis alertas" || mal "T7 tipos de alerta: $A"
A="$(j "$TMP/t7-out/P__S.json" 'j.alertas.filter(a=>a.tipo==="estancada").map(a=>a.story).join()+"|"+j.stories.find(s=>s.id==="2.2").dias_en_estado+"|"+j.alertas.filter(a=>a.tipo==="sin_work_item").map(a=>a.story).join()+"|"+j.alertas.every(a=>a.story!==undefined&&typeof a.detalle==="string"&&a.detalle.length>0)' 2>/dev/null)"
[ "$A" = "2.2|29|2.3|true" ] && ok "T7 estancada a los 29 días, TBD no es work item, todas con story y detalle" || mal "T7 detalle: $A"
cat > "$TMP/sin-transiciones.js" <<'JS'
// Precarga del caso T7: el historial de estados no se pudo medir.
const Module = require('module');
const cargar = Module._load;
Module._load = function (pedido, ...resto) {
  const m = cargar.call(this, pedido, ...resto);
  if (/sdlc-stage-metrics(\.js)?$/.test(pedido) && m && !m.__sinTr) {
    m.derivarTransiciones = () => ({ medible: false, motivo: 'transiciones: historial ilegible (fixture)', transiciones: {}, altas: {} });
    m.__sinTr = true;
  }
  return m;
};
JS
TYCON_TODAY=2026-10-30 node -r "$TMP/sin-transiciones.js" "$FOTO" --repo "$R/P__S" --out "$TMP/t7-null" >/dev/null 2>&1
A="$(j "$TMP/t7-null/P__S.json" 'j.cobertura.transiciones.estado+"|"+j.stories.every(s=>s.dias_en_estado===null)+"|"+j.alertas.some(a=>a.tipo==="estancada")' 2>/dev/null)"
[ "$A" = "no_medido|true|false" ] && ok "T7 sin transiciones: días null en todas y ninguna estancada" || mal "T7 sin transiciones: $A"

# ── T8 · Ilegibles_SeCuentanNoSeSaltean (AC 6) ──
# 🔴 rojo previo: el descubridor devuelve null para el frontmatter roto y nadie lo cuenta.
R="$TMP/t8"; repo_nuevo "$R/P__S"; story "$R/P__S" 1.1 backlog
printf -- '---\nstory: "1.2"\nstatus: backlog\n\nsin cierre\n' > "$R/P__S/specs/story-1.2.md"
printf -- '---\nstory: "1.3"\nstatus: done\ntitle: x\n' > "$R/P__S/specs/story-1.3.md"
printf -- '# Un documento cualquiera\n\nstory: no soy\n' > "$R/P__S/specs/notas.md"
commit_en "$R/P__S" 2026-09-01T10:00:00Z inicial
foto --repo "$R/P__S" --out "$TMP/t8-out" >/dev/null 2>&1
I="$(j "$TMP/t8-out/P__S.json" 'j.cobertura.ilegibles+"|"+j.alertas.filter(a=>a.tipo==="frontmatter_ilegible").length+"|"+j.alertas.filter(a=>a.tipo==="frontmatter_ilegible").map(a=>a.detalle).join(" ")' 2>/dev/null)"
case "$I" in
  "2|2|"*specs/story-1.2.md*specs/story-1.3.md*) ok "T8 dos ilegibles contados y alertados con su ruta" ;;
  *) mal "T8 ilegibles: $I" ;;
esac
# Iter 2 (chequeo de alcance): un repo SIN una sola story legible no escribe foto (AC 1), pero se nombra con
# su cuenta de frontmatters rotos — no se calla.
R="$TMP/t8b"; repo_nuevo "$R/P__Rotas"
printf -- '---\nstory: "1.1"\nstatus: backlog\n\nsin cierre\n' > "$R/P__Rotas/specs/story-1.1.md"
commit_en "$R/P__Rotas" 2026-09-01T10:00:00Z inicial
SALIDA="$(foto --repo "$R/P__Rotas" --out "$TMP/t8b-out" 2>&1)"; RC=$?
case "$RC|$([ -f "$TMP/t8b-out/P__Rotas.json" ] && echo con || echo sin)|$SALIDA" in
  "0|sin|"*"P__Rotas (1 con el frontmatter roto)"*) ok "T8 repo sólo con stories rotas: sin foto, nombrado con su cuenta" ;;
  *) mal "T8 repo sólo con stories rotas: exit $RC, «${SALIDA}»" ;;
esac
# Iter 3 (fallos silenciosos): en Azure DevOps ese repo es un AVISO visible — su foto de anoche quedaría vieja.
SALIDA="$(TF_BUILD=True foto --repo "$R/P__Rotas" --out "$TMP/t8b-out" 2>/dev/null)"
case "$SALIDA" in
  *"##vso[task.logissue type=warning]"*P__Rotas*) ok "T8 bajo Azure DevOps el repo con stories rotas sale como logissue" ;;
  *) mal "T8 sin logissue para el repo con stories rotas: «${SALIDA}»" ;;
esac

# ── T9 · Fuga_SinMarcadorCorreoNiRutaAbsoluta (AC 10) ──
# 🔴 rojo previo: volcar el frontmatter o el cuerpo entero.
R="$TMP/t9"; repo_nuevo "$R/P__S"
story "$R/P__S" 1.1 backlog body="Texto secreto ZQX-FUGA-1 del cuerpo." owner=dev@ejemplo.test \
  'files_to_create=["/Users/x/repo/a.cs", "/home/dev/b.cs"]'
# Revisión de seguridad (iter 1): el estado crudo viaja como CLAVE de `cobertura.desconocidos`, y una ruta de
# máquina puede no empezar por /Users ni /home.
# (Los ataques van en campos que VIAJAN —estado, épica—: el ayudante `story` ya escribe una `priority:`, y una
#  segunda nunca se leía; así estaba en la iter 2 y el caso no probaba nada.)
story "$R/P__S" 1.2 "esperando-a-dev@ejemplo.test" "epic=P1 en /private/var/folders/x"
# Iter 2 y 3: rutas pegadas a `:` o `<`, `file://`, `C:/` con barras normales, `**/…` y `-/…`.
story "$R/P__S" 1.3 "ruta:/Users/u/a.cs <\/home/u/b> file:///Volumes/u/c C:/Users/u/d **/home/u/e** -/Users/u/f"
# Control: lo que NO es una ruta de máquina sigue igual (relativa, fecha, URL).
story "$R/P__S" 1.4 backlog "epic=specs/a/b.md 2026/10/07 https://dev.ejemplo.test/org/x"
commit_en "$R/P__S" 2026-09-01T10:00:00Z inicial
foto --repo "$R/P__S" --out "$TMP/t9-out" >/dev/null 2>&1
F="$TMP/t9-out/P__S.json"
if [ -f "$F" ]; then
  N="$(grep -c -e 'ZQX-FUGA-1' -e 'dev@ejemplo.test' -e '/Users/' -e '/home/' -e '/private/' -e '/Volumes/' -e 'C:\\\\' -e 'C:/' "$F")"
  [ "$N" = 0 ] && ok "T9 ni el marcador, ni el correo, ni rutas absolutas" || mal "T9 el JSON filtra $N línea(s)"
  [ "$(j "$F" 'j.stories[0].ruta')" = "specs/story-1.1.md" ] && ok "T9 la ruta es relativa al repo" || mal "T9 ruta no relativa"
  [ "$(j "$F" 'j.stories.find(s=>s.id==="1.4").epica')" = "specs/a/b.md 2026/10/07 https://dev.ejemplo.test/org/x" ] \
    && ok "T9 control: ruta relativa, fecha y URL no se sanean" || mal "T9 control: se saneó algo que no es ruta de máquina"
else mal "T9 no hay archivo"; fi
R="$TMP/t9b"; repo_nuevo "$R/P__S"; story "$R/P__S" 1.1 backlog
sed -i.bak 's/^title: .*/title: "Control ZQX-FUGA-1 de a@b.test en \/Users\/z\/w"/' "$R/P__S/specs/story-1.1.md"; rm -f "$R/P__S/specs/"*.bak
commit_en "$R/P__S" 2026-09-01T10:00:00Z inicial
foto --repo "$R/P__S" --out "$TMP/t9b-out" >/dev/null 2>&1
T="$(j "$TMP/t9b-out/P__S.json" 'j.stories[0].titulo' 2>/dev/null)"
case "$T" in
  *ZQX-FUGA-1*) if grep -q -e 'a@b.test' -e '/Users/' "$TMP/t9b-out/P__S.json"; then mal "T9 control: el título viaja sin sanear ($T)"
                else ok "T9 control positivo: el título viaja como texto, saneado ($T)"; fi ;;
  *) mal "T9 control positivo: el título no aparece ($T)" ;;
esac

# ── T10 · Exportador_SigueExcluyendoDashboard (AC 10) ──
# 🔴 rojo previo: sacar `.dashboard/**` de las exclusiones fijas del exportador.
# T10, T12 y T14 miran cómo está cableada la pieza en el repo del equipo (la lista del exportador, el pipeline nocturno,
# el .gitignore que deja pasar la foto, el mapa del arnés). La copia pública no trae nada de eso (no tiene los papeles
# del exportador, ni pipelines/, ni artifacts/, y su .gitignore ignora .dashboard/ entero porque no hay nocturno):
# ahí salen NO MEDIDO, no verdes. Lo que mide la foto misma corre igual en los dos lados.
INTERNO=0; [ -d "$RAIZ/scripts/publishing/public-files" ] && INTERNO=1
if [ "$INTERNO" = 0 ]; then
  echo "  ⏭️   — T10 NO MEDIDO: la copia pública no trae la lista del exportador. No es un verde."
elif node "$RAIZ/scripts/publishing/export.js" --explain 2>&1 | grep -qE '\.dashboard/\*\*.*' \
   && node "$RAIZ/scripts/publishing/export.js" --explain 2>&1 | grep -E '^\s+\.dashboard/' | grep -q 'fija'; then
  ok "T10 la copia pública sigue excluyendo .dashboard/** como fija"
else mal "T10 el exportador ya no lista .dashboard/** como exclusión fija"; fi

# ── T11 · ModosDeFalla_NoGit_DiccionarioRoto_ExitCodes (AC 11) ──
# 🔴 rojo previo: un throw sin atrapar → exit ≠ 0/2 y el paso del nocturno se cae.
R="$TMP/t11"; mkdir -p "$R/P__NoGit/specs"; story "$R/P__NoGit" 1.1 backlog
SALIDA="$(foto --repo "$R/P__NoGit" --out "$TMP/t11-a" 2>&1)"; RC=$?
if [ "$RC" = 2 ] && [ ! -f "$TMP/t11-a/P__NoGit.json" ] && grep -q "P__NoGit" <<<"$SALIDA" && grep -qi "git" <<<"$SALIDA"; then
  ok "T11 repo sin git: anotado con su motivo, sin archivo, exit 2"
else mal "T11 repo sin git: exit $RC, salida «${SALIDA}»"; fi
repo_nuevo "$R/P__S"; story "$R/P__S" 1.1 done; commit_en "$R/P__S" 2026-09-01T10:00:00Z inicial
echo '{ roto' > "$TMP/estados-roto.json"
TYCON_STATES_PATH="$TMP/estados-roto.json" foto --repo "$R/P__S" --out "$TMP/t11-b" >/dev/null 2>&1; RC=$?
D="$(j "$TMP/t11-b/P__S.json" 'j.metricas+"|"+j.cobertura.transiciones.estado+"|"+(j.cobertura.transiciones.motivo||"").includes("diccionario")+"|"+j.stories[0].grupo' 2>/dev/null)"
[ "$RC" = 0 ] && [ "$D" = "null|no_medido|true|desconocido" ] \
  && ok "T11 diccionario roto: archivo con metricas null y el motivo, exit 0" || mal "T11 diccionario roto: exit $RC, $D"
mkdir -p "$TMP/t11-c"; chmod 555 "$TMP/t11-c"
foto --repo "$R/P__S" --out "$TMP/t11-c" >/dev/null 2>&1; RC=$?
chmod 755 "$TMP/t11-c"
[ "$RC" = 2 ] && ok "T11 --out sin permiso: exit 2" || mal "T11 --out sin permiso: exit $RC"
foto --out "$TMP/t11-d" >/dev/null 2>&1; RC=$?
[ "$RC" = 1 ] && ok "T11 sin --repo ni --scan: exit 1" || mal "T11 argumentos faltantes: exit $RC"
# Revisión de fallos silenciosos (iter 1): todos sin stories NO es una falla; una raíz sin repos, sí.
R2="$TMP/t11-vacio"; repo_nuevo "$R2/P__Code"; echo x > "$R2/P__Code/a.txt"; commit_en "$R2/P__Code" 2026-09-01T10:00:00Z inicial
foto --scan "$R2" --only-harness --out "$TMP/t11-e" >/dev/null 2>&1; RC=$?
[ "$RC" = 0 ] && ok "T11 todos los repos sin stories: exit 0 (no es una falla)" || mal "T11 todos sin stories: exit $RC"
mkdir -p "$TMP/t11-sin-repos"
foto --scan "$TMP/t11-sin-repos" --out "$TMP/t11-f" >/dev/null 2>&1; RC=$?
[ "$RC" = 2 ] && ok "T11 raíz sin ningún repo: exit 2" || mal "T11 raíz sin repos: exit $RC"
# Iter 3 (cobertura): un repo que falla, bajo Azure DevOps, es un logissue; fuera de Azure, no se imprime.
SALIDA="$(TF_BUILD=True foto --repo "$R/P__NoGit" --repo "$R/P__S" --out "$TMP/t11-h" 2>/dev/null)"; RC=$?
case "$RC|$SALIDA" in
  "0|"*"##vso[task.logissue type=warning]Foto por proyecto, no escrito — P__NoGit"*) ok "T11 repo fallido con otro escrito: exit 0 y logissue en Azure DevOps" ;;
  *) mal "T11 repo fallido bajo TF_BUILD: exit $RC, «${SALIDA}»" ;;
esac
SALIDA="$(env -u TF_BUILD node "$FOTO" --repo "$R/P__NoGit" --repo "$R/P__S" --out "$TMP/t11-h" 2>/dev/null)"
case "$SALIDA" in *"##vso["*) mal "T11 fuera de Azure DevOps imprime ##vso" ;; *) ok "T11 fuera de Azure DevOps no imprime ##vso" ;; esac
# `--transitions-budget-ms`: un valor ilegible es error de argumentos (nunca «sin presupuesto»); uno válido corre.
foto --repo "$R/P__S" --out "$TMP/t11-i" --transitions-budget-ms abc >/dev/null 2>&1; RC=$?
[ "$RC" = 1 ] && ok "T11 --transitions-budget-ms ilegible: exit 1" || mal "T11 --transitions-budget-ms ilegible: exit $RC"
foto --repo "$R/P__S" --out "$TMP/t11-i" --transitions-budget-ms 30000 >/dev/null 2>&1; RC=$?
[ "$RC" = 0 ] && [ -f "$TMP/t11-i/P__S.json" ] && ok "T11 --transitions-budget-ms válido: corre" || mal "T11 --transitions-budget-ms válido: exit $RC"
# Pase adversarial (iter 1): un --sdlc que no existe (el medidor no escribió hoy) no copia nada viejo.
foto --repo "$R/P__S" --sdlc "$TMP/no-existe/sdlc-stage-2026-10-07.json" --out "$TMP/t11-g" >/dev/null 2>&1; RC=$?
D="$(j "$TMP/t11-g/P__S.json" 'j.metricas+"|"+j.cobertura.metricas.estado' 2>/dev/null)"
[ "$RC" = 0 ] && [ "$D" = "null|no_medido" ] && ok "T11 --sdlc ausente: metricas null con motivo" || mal "T11 --sdlc ausente: exit $RC, $D"

# ── T12 · Nocturno_PasoDespuesDeMedirYAntesDelCommit (AC 11, 13) ──
# 🔴 rojo previo: correr la foto antes de medir, sin --sdlc, o sin aviso en su falla.
YML="$RAIZ/pipelines/azure-pipelines.yml"
if [ "$INTERNO" = 0 ] && [ ! -f "$YML" ]; then
  echo "  ⏭️   — T12 NO MEDIDO: la copia pública no trae los pipelines del equipo. No es un verde."
elif [ -f "$YML" ]; then
  L_MED=$(grep -n 'node scripts/metrics/sdlc-stage-metrics.js' "$YML" | head -1 | cut -d: -f1)
  L_FOTO=$(grep -n 'node scripts/nightly/projects/snapshot.js' "$YML" | head -1 | cut -d: -f1)
  # El paso que guarda ya no hace `git add`: llama a push-nightly-data.js save con sus rutas (story 8.26, tanda H1a).
  # Lo que se fija es lo mismo: la foto corre antes de ese paso, y el paso lleva la carpeta de las fotos.
  L_ADD=$(grep -n 'push-nightly-data.js save' "$YML" | head -1 | cut -d: -f1)
  if [ -n "$L_FOTO" ] && [ -n "$L_ADD" ] && [ "$L_MED" -lt "$L_FOTO" ] && [ "$L_FOTO" -lt "$L_ADD" ]; then ok "T12 la foto corre después de medir y antes del commit"
  else mal "T12 orden: medir=$L_MED foto=${L_FOTO:-ausente} guardar=${L_ADD:-ausente}"; fi
  BLOQUE="$(sed -n "${L_FOTO:-1},\$p" "$YML" | sed -n '1,12p')"
  grep -q -- '--sdlc' <<<"$BLOQUE" && grep -q 'logissue type=warning' <<<"$BLOQUE" && grep -q -- '--only-harness' <<<"$BLOQUE" \
    && ok "T12 con --sdlc, --only-harness y aviso (no freno) en su falla" || mal "T12 falta --sdlc, --only-harness o el logissue de aviso"
  grep -qE 'echo "⏱ .*foto' "$YML" && ok "T12 imprime su duración" || mal "T12 no imprime la duración de la foto"
  # entre comillas simples: el comodín lo resuelve git (también contra lo borrado), no el shell
  sed -n "${L_ADD:-1},\$p" "$YML" | sed -n '1,6p' | grep -q -- "-- .*'.dashboard/proyectos/\*.json'" \
    && ok "T12 commitea .dashboard/proyectos/*.json" || mal "T12 el paso que guarda no lleva .dashboard/proyectos/*.json"
  # Pase adversarial (iter 1): «el más nuevo» por nombre puede ser el de ayer si el medidor no escribió hoy.
  if grep -q 'sdlc-stage-\$(date -u +%Y-%m-%d).json' <<<"$BLOQUE$(sed -n "$((L_FOTO-3)),${L_FOTO}p" "$YML")" && ! grep -q 'sdlc-stage-\*.json | tail' "$YML"; then
    ok "T12 --sdlc es el snapshot de HOY, no el más nuevo por nombre"
  else mal "T12 --sdlc no apunta al snapshot del día"; fi
else mal "T12 no encuentro $YML"; fi
# Pase adversarial (iter 1): `.dashboard/*` está ignorado — sin excepción, el `git add` sale 1 y con `set -e`
# aborta el commit del nocturno (y con él el snapshot SDLC del día).
if [ "$INTERNO" = 0 ]; then
  echo "  ⏭️   — T12 NO MEDIDO: el .gitignore de la copia pública ignora .dashboard/ entero (no hay nocturno que commitee). No es un verde."
elif git -C "$RAIZ" check-ignore -q .dashboard/proyectos/X__Y.json; then
  mal "T12 .gitignore ignora .dashboard/proyectos/*.json: el git add del nocturno aborta el commit"
else ok "T12 .gitignore deja pasar .dashboard/proyectos/*.json"; fi

# ── T13 · Idempotente_ReemplazaYNoAcumula (AC 1, 12) ──
# 🔴 rojo previo: fecha en el nombre del archivo → se acumulan; un .tmp que queda.
R="$TMP/t1"
G1="$(j "$TMP/t1-out/A__S.json" 'j.generated_at' 2>/dev/null)"; sleep 1
foto --scan "$R" --only-harness --out "$TMP/t1-out" >/dev/null 2>&1
ARCH2="$(cd "$TMP/t1-out" 2>/dev/null && ls -A | tr '\n' ' ')"
G2="$(j "$TMP/t1-out/A__S.json" 'j.generated_at' 2>/dev/null)"
[ "$ARCH2" = "A__S.json B__P.json " ] && [ -n "$G1" ] && [ "$G1" != "$G2" ] \
  && ok "T13 dos corridas: los mismos dos archivos, reemplazados" || mal "T13 tras dos corridas: «${ARCH2}» (${G1} → ${G2})"

# ── T14 · Registro_SuitesMapaYPiezas (AC 14) ──
# 🔴 rojo previo: olvidar registrar la pieza en alguno de los tres.
for f in scripts/tests/suites.json artifacts/mapa-arnes.html guides/piezas-del-arnes.md; do
  case "$f" in
    *suites.json) PAT='tests/projects-snapshot.test.sh' ;;
    *) PAT='scripts/nightly/projects/snapshot.js' ;;
  esac
  if [ "$INTERNO" = 0 ] && [ ! -f "$RAIZ/$f" ]; then echo "  ⏭️   — T14 NO MEDIDO: la copia pública no trae $f. No es un verde."; continue; fi
  grep -q "$PAT" "$RAIZ/$f" && ok "T14 $f nombra la pieza" || mal "T14 $f no nombra $PAT"
done

# ── T15 · SnapshotSdlc_IdenticoConYSinElPaso (AC 9, 13) ──
# 🔴 rojo previo: que la foto escriba o reordene el snapshot SDLC.
R="$TMP/t1"; D="$TMP/t15-dash"; mkdir -p "$D"
node "$MEDIDOR" --scan "$R" --only-harness --dashboard "$D" --snapshot >/dev/null 2>&1
S1="$(ls "$D"/sdlc-stage-*.json 2>/dev/null | head -1)"
if [ -n "$S1" ]; then
  cp "$S1" "$TMP/t15-antes.json"
  foto --scan "$R" --only-harness --sdlc "$S1" --out "$TMP/t15-foto" >/dev/null 2>&1
  cmp -s "$S1" "$TMP/t15-antes.json" && ok "T15 la foto no toca el snapshot SDLC" || mal "T15 la foto modificó el snapshot SDLC"
  node "$MEDIDOR" --scan "$R" --only-harness --dashboard "$D" --snapshot >/dev/null 2>&1
  IGUAL="$(node -e 'const f=(p)=>{const j=JSON.parse(require("fs").readFileSync(p,"utf8"));delete j.generated_at;return JSON.stringify(j)};console.log(f(process.argv[1])===f(process.argv[2]))' "$TMP/t15-antes.json" "$S1")"
  [ "$IGUAL" = true ] && ok "T15 el snapshot SDLC sale idéntico con y sin la foto (salvo generated_at)" || mal "T15 el snapshot SDLC cambió"
  ARCH="$(ls "$D" | tr '\n' ' ')"
  case "$ARCH" in *proyectos*) mal "T15 la foto escribió en la carpeta del tablero" ;; *) ok "T15 nada nuevo en la carpeta del tablero" ;; esac
else mal "T15 el medidor no escribió snapshot sobre las fixtures"; fi

# ── T16 · Metricas_CopiadasDelSnapshotSdlc (AC 8) ──
# 🔴 rojo previo: recalcular las métricas, o volcar la entrada entera (aparece `rework_por_carril`).
if [ -n "${S1:-}" ] && [ -f "$TMP/t15-foto/B__P.json" ]; then
  M="$(node -e '
    const fs=require("fs");const path=require("path");
    const snap=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const foto=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
    const e=snap.repos.find(r=>path.basename(r.repo)==="B__P");
    const campos=["lead_time_days","rework_ratio","rework_por_causa","dod_evidence_ratio","tiempo_por_etapa","estados_por_canonico","not_measured"];
    const esperado={};for(const c of campos)esperado[c]=e[c]===undefined?null:e[c];
    console.log(JSON.stringify(Object.keys(foto.metricas))===JSON.stringify(campos)&&JSON.stringify(foto.metricas)===JSON.stringify(esperado));
  ' "$S1" "$TMP/t15-foto/B__P.json" 2>&1)"
  [ "$M" = true ] && ok "T16 metricas = lista blanca de la entrada del repo en el snapshot SDLC" || mal "T16 metricas no coinciden con el snapshot ($M)"
  repo_nuevo "$R/C__Nuevo"; story "$R/C__Nuevo" 1.1 backlog; commit_en "$R/C__Nuevo" 2026-09-01T10:00:00Z inicial
  foto --repo "$R/C__Nuevo" --sdlc "$S1" --out "$TMP/t16-out" >/dev/null 2>&1
  M="$(j "$TMP/t16-out/C__Nuevo.json" 'j.metricas+"|"+j.cobertura.metricas.estado+"|"+(j.cobertura.metricas.motivo||"")' 2>/dev/null)"
  case "$M" in "null|no_medido|"?*) ok "T16 repo ausente del snapshot: metricas null con motivo" ;; *) mal "T16 repo ausente: $M" ;; esac
  rm -rf "$R/C__Nuevo"
else mal "T16 sin snapshot SDLC o sin la foto de T15"; fi

# ── T17 · Frontmatter_VaciosYNulosSonNull (AC 2, 7) ──
# 🔴 rojo previo (pase adversarial, iter 1): el regex de una clave cruza el salto de línea y `epic:` vacío toma
#    la línea siguiente → `epica: "priority:"` y una épica inventada; `depends_on: null` → alerta por «null».
R="$TMP/t17"; repo_nuevo "$R/P__S"; story "$R/P__S" 1.1 backlog
python3 - "$R/P__S/specs/story-1.1.md" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
s = s.replace('epic: 1\n', 'epic:\n').replace('sprint: 1\n', 'sprint:\n').replace('priority: "P1"\n', 'priority:\n')
s = s.replace('ado_work_item: 911\n', 'ado_work_item: 911\ndepends_on: null\nfollowup_of: ~\n')
open(p, 'w').write(s)
PY
commit_en "$R/P__S" 2026-09-01T10:00:00Z inicial
foto --repo "$R/P__S" --out "$TMP/t17-out" >/dev/null 2>&1
V="$(j "$TMP/t17-out/P__S.json" '[j.stories[0].epica,j.stories[0].prioridad,j.stories[0].sprint,j.stories[0].depends_on.length,j.stories[0].followup_of.length,j.epicas.map(e=>e.id).join(),j.alertas.filter(a=>a.tipo==="dependencia_rota").length].join("|")' 2>/dev/null)"
[ "$V" = "|||0|0||0" ] && ok "T17 vacíos y nulos del frontmatter dan null y listas vacías, sin épicas ni alertas inventadas" || mal "T17 vacíos/nulos: $V"

# ── T18 · Tandas_ConListasAnidadas (AC 2) ──
# 🔴 rojo previo (pase adversarial, iter 1): partir el bloque `pipelines:` en cada `- ` separa el `status:` del
#    `name:` cuando la tanda trae una sublista antes del status.
T="$(node -e '
const { tandasPendientes } = require(process.argv[1]);
const fm = ["pipelines:", "  - name: a", "    status: pending", "  - name: b", "    tasks_partial:", "      - id: 5",
  "    status: blocked", "  - name: c", "    files:", "      - x.cs", "    status: done", "  - name: d",
  "    files: [y.cs]", "    status: pending", "epic: 1"].join("\n");
console.log(tandasPendientes(fm).join(","));' "$FOTO" 2>&1)"
[ "$T" = "a,b,d" ] && ok "T18 tandas con sublistas: el status se lee aunque venga después" || mal "T18 tandas: $T"

echo
if [ "$FALLOS" -gt 0 ]; then echo "FALLARON $FALLOS chequeo(s)"; exit 1; fi
echo "todo verde"
exit 0
