#!/usr/bin/env bash
# harness-team-a2.test.sh — la capa del equipo con revisores y skills (T19, T20, T26, T27, T29), en el
# laboratorio: el GitHub de juguete con los dos repos y una versión de juguete que trae el pipeline (para que el cargador de
# paquetes y `pipeline.js advisors` corran sobre lo instalado). Nombres inventados: nunca los del paquete real del equipo.
#
# Lo que no se puede perder:
#   T19 · un paquete roto (nombra un revisor que no existe) frena como un perfil roto: install sale 1 sin dejar incoming/,
#         caché nueva ni estado; update arrastra la capa instalada y lo dice; si la versión nueva tampoco acepta la instalada,
#         no se instala, queda `failed: team-invalid` (doctor lo dice) y el arranque siguiente no la vuelve a bajar; el
#         refresco en el lugar deja la instalada; un paquete que se muda de carpeta pasa (la capa vieja no cuenta); las
#         variables TYCON_PACKS_DIR/TYCON_AGENTS_DIR no cambian nada.
#   T20 · con la capa: los dos revisores en `pipeline.js advisors`, el agente y la skill anidada por su ruta, doctor sin la
#         línea del paquete que falta; una carpeta real ~/.claude/skills con su propio `projects/` se avisa nombrándola.
#   T26 · los dos momentos: lo que se juzga sobre lo bajado (un nombre que no coincide) sale 1 con la HOME idéntica en install
#         y en migrate; lo que se juzga contra la versión (un agente que se llama como uno de la versión) sale 1 sin incoming/,
#         sin caché nueva y sin estado; el Azure de juguete con 50 archivos pide cada uno UNA vez.
#   T27 · el refresco con carpetas: un revisor y una skill anidada de más y una skill de menos llegan en el arranque; lo sacado
#         no deja carpetas vacías ni enlaces colgando (los barre lo que corre el aplicador real, canonical-path.js — el
#         aplicador del laboratorio es de juguete); un archivo editado en una skill anidada se conserva y uninstall lo guarda.
#   T29 · una punta rechazada por una versión se vuelve a evaluar con otra versión instalada (install --version, rollback).
#
# Laboratorio: scripts/tests/lib/harness-lab.sh. Nunca ~/.claude ni el checkout real. Sin pipes sobre el comando medido.
# Uso: bash scripts/tests/harness-team-a2.test.sh [--only T19|T20|T26|T27|T29]
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
export TYCON_UPDATE_APPLY=auto TYCON_STARTUP_DETACH=0
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
BASE="$(mktemp -d)"
case "$BASE" in "$RAIZ"*|*agent-skills*|*/.claude*) echo "❌ harness-team-a2: el laboratorio cayó en ${BASE}"; exit 1 ;; esac
trap 'rm -rf "$BASE"; kill $(jobs -p) 2>/dev/null' EXIT
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
jtxt() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
ESTADO() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"; }
estado() { j "$(ESTADO)" "$1"; }
NEW() { printf '%s' "$LAB_HOME/.tycon/harness"; }
TEAM_CACHE() { printf '%s' "$LAB_HOME/.tycon/team/$(printf '%s' "$1" | cut -c1-12)"; }
sha7() { printf '%s' "$1" | cut -c1-7; }
ventana() { # ventana now|none — la última mirada a la red: recién (dentro de la ventana) o nunca (fuera)
  python3 - "$(ESTADO)" "$1" <<'PY'
import json,sys,datetime
f,m=sys.argv[1:3]; d=json.load(open(f, encoding='utf-8'))
d['last_fetch']=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z') if m=='now' else None
d['last_fetch_failed']=None
json.dump(d, open(f,'w', encoding='utf-8'), indent=2)
PY
}
tarballs() { local n; n="$(grep -c -- "/tarball/" "$LAB_RELEASE_LOG" 2>/dev/null)"; printf '%s' "${n:-0}"; }
instala_team() { INSTALL_OUT="$(harness install --version latest --team "$LAB_TEAM" --yes 2>&1)"; INSTALL_RC=$?; }
team_head() { harness_lab_team_head; }
VACIA="$BASE/vacia"; mkdir -p "$VACIA"

# la versión de juguete con el pipeline adentro (el cargador de paquetes y `pipeline.js advisors` de ESTA rama) y un agente
# del núcleo de juguete
pipeline_en_la_version() {
  local a="$LAB_AUTHOR_TREE"
  mkdir -p "$a/skills/tycon-pipeline" "$a/agents"
  cp -R "$RAIZ/skills/tycon-pipeline/scripts" "$a/skills/tycon-pipeline/"
  rm -rf "$a/skills/tycon-pipeline/scripts/tests"
  printf -- '---\nname: tycon-core-juguete\ndescription: revisor del núcleo de juguete\n---\nRevisa.\n' > "$a/agents/tycon-core-juguete.md"
  printf -- '---\nname: publica-juguete\ndescription: skill pública de juguete\n---\n' > "$a/skills/tycon-pipeline/SKILL.md"
}
# agente <archivo> <name>: los revisores del paquete de juguete (rev-juguete-*) van en la carpeta de su paquete; los
# demás, en agents/ de la raíz de la capa
agente() {
  local d="$LAB_AUTHOR_TEAM/agents"
  case "$1" in rev-juguete-*) d="$LAB_AUTHOR_TEAM/packs/equipo-juguete/agents" ;; esac
  mkdir -p "$d"
  printf -- '---\nname: %s\ndescription: revisor del equipo de juguete\n---\nRevisa cosas del equipo.\n' "$2" > "$d/$1.md"
}
skill() { mkdir -p "$LAB_AUTHOR_TEAM/skills/$1"; printf -- '---\nname: %s\ndescription: skill del equipo de juguete\n---\nUsala para %s.\n' "$(basename "$1")" "$1" > "$LAB_AUTHOR_TEAM/skills/$1/SKILL.md"; }
paquete() { # paquete <carpeta> <revisor-base> <revisor-condicional> — con sus agentes en la carpeta del paquete (menos un fantasma)
  mkdir -p "$LAB_AUTHOR_TEAM/packs/$1/agents"
  python3 - "$LAB_AUTHOR_TEAM/packs/$1/pack.json" "$1" "$2" "$3" <<'PY'
import json,sys
f,n,b,c=sys.argv[1:5]
rev=lambda a,g: {"agent": a, "group": g, "when": {"detection": "codeModified"}, "surface": {"paths": ["**/*.ts"]}, "depth": "standard", "prefixes": ["JUG"]}
json.dump({"name": n, "description": "paquete del equipo de juguete", "reviewers": [rev(b, "base"), rev(c, "condicional")]}, open(f, "w"), indent=2)
PY
  local r
  for r in "$2" "$3"; do
    [ "$r" = rev-fantasma ] && continue
    printf -- '---\nname: %s\ndescription: revisor del equipo de juguete\n---\nRevisa cosas del equipo.\n' "$r" > "$LAB_AUTHOR_TEAM/packs/$1/agents/$r.md"
  done
}
# la capa sana: un paquete con dos revisores y sus agentes, una skill de una carpeta y una anidada a tres
capa_a2() {
  paquete equipo-juguete rev-juguete-base rev-juguete-cond
  skill sola-juguete
  skill projects/cliente-inventado/arquitectura-juguete
  mkdir -p "$LAB_AUTHOR_TEAM/skills/projects/cliente-inventado/arquitectura-juguete/references"
  printf '# referencia de juguete\n' > "$LAB_AUTHOR_TEAM/skills/projects/cliente-inventado/arquitectura-juguete/references/a.md"
  harness_lab_team_publish "${1:-la capa de la A2a}"
}
lab_a2() { # lab_a2 <dir> — la máquina sin arnés, los dos repos, la versión con el pipeline y la capa de la A2a
  harness_lab_create "$1"
  export TYCON_PROFILE=
  harness_lab_release_server
  pipeline_en_la_version
  harness_lab_publish_stable 2026.10.08.1
  harness_lab_team_repo
  capa_a2
  harness_lab_team_server
  harness_lab_release_fresh_home
}

# ───────────────────────────────────────────── T19 ────────────────────────────────────────────────────────────────────
if corre T19; then
  echo "T19 · un paquete roto frena como un perfil roto, con el cargador de la versión que va a quedar y sin mirar las variables"
  lab_a2 "$BASE/lab19"
  export TYCON_PACKS_DIR="$VACIA" TYCON_AGENTS_DIR="$VACIA"
  # (a) install sin capa previa, con el paquete que nombra un revisor que no existe
  paquete equipo-juguete rev-juguete-base rev-fantasma; harness_lab_team_publish "nombra un revisor que no existe"
  BROKEN="$(team_head)"
  instala_team
  [ "$INSTALL_RC" = 1 ] && ok "(a) install con el paquete roto sale 1" || mal "(a) rc $INSTALL_RC: $INSTALL_OUT"
  case "$INSTALL_OUT" in *"equipo-juguete"*"rev-fantasma"*|*"rev-fantasma"*"equipo-juguete"*) ok "(a) …nombrando paquete y revisor" ;; *) mal "(a) no nombra paquete y revisor: $INSTALL_OUT" ;; esac
  [ ! -e "$(NEW)" ] && ok "(a) no quedó ~/.tycon/harness" || mal "(a) quedó ~/.tycon/harness"
  [ -z "$(ls -d "$LAB_HOME/.tycon/incoming"/* 2>/dev/null)" ] && ok "(a) no quedó nada en incoming/" || mal "(a) quedó incoming/: $(ls "$LAB_HOME/.tycon/incoming" 2>/dev/null)"
  [ ! -e "$(TEAM_CACHE "$BROKEN")" ] && ok "(a) ni la caché del commit rechazado" || mal "(a) quedó la caché $(TEAM_CACHE "$BROKEN")"
  [ -z "$(estado "d.get('team') or ''")" ] && ok "(a) el estado no guarda team" || mal "(a) team en el estado: $(estado "d.get('team')")"
  # (b) la capa sana instalada; una punta rota y una versión nueva: se arrastra la instalada y se dice
  paquete equipo-juguete rev-juguete-base rev-juguete-cond; harness_lab_team_publish "sana otra vez"
  GOOD="$(team_head)"
  instala_team
  [ "$INSTALL_RC" = 0 ] && ok "(b) instalada con la capa sana" || mal "(b) install: rc $INSTALL_RC: $INSTALL_OUT"
  paquete equipo-juguete rev-juguete-base rev-fantasma; harness_lab_team_publish "rota otra vez"
  harness_lab_publish_stable 2026.10.08.2
  OUT="$(harness_release update --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "(b) update sale 0" || mal "(b) update rc $RC: $OUT"
  case "$OUT" in *"sigue en $(sha7 "$GOOD")"*) ok "(b) …arrastró la capa instalada y lo dice" ;; *) mal "(b) no dice que sigue en la instalada: $OUT" ;; esac
  [ "$(estado "d['version']['number']")" = 2026.10.08.2 ] && [ "$(estado "d['team']['commit']")" = "$GOOD" ] && ok "(b) versión nueva con la capa de antes" || mal "(b) $(estado "d['version']['number']") $(estado "d.get('team')")"
  # (c) el refresco en el lugar con la punta rota: la instalada sigue
  ventana none
  harness_release startup >/dev/null 2>&1
  [ "$(estado "d['team']['commit']")" = "$GOOD" ] && [ -f "$(NEW)/packs/equipo-juguete/pack.json" ] && ok "(c) el refresco no apila la punta rota: la capa sigue" || mal "(c) el refresco cambió la capa: $(estado "d.get('team')")"
  # (d) un paquete que se muda de carpeta: la capa vieja (packs/equipo-juguete) no cuenta como «otro paquete que ya declara»
  rm -rf "$LAB_AUTHOR_TEAM/packs/equipo-juguete"; paquete equipo-juguete-2 rev-juguete-base rev-juguete-cond; harness_lab_team_publish "el paquete se muda"
  MOVED="$(team_head)"
  ventana none
  harness_release startup >/dev/null 2>&1
  [ "$(estado "d['team']['commit']")" = "$MOVED" ] && [ -f "$(NEW)/packs/equipo-juguete-2/pack.json" ] && [ ! -e "$(NEW)/packs/equipo-juguete/pack.json" ] && ok "(d) el paquete mudado se refresca y el viejo se va" || mal "(d) $(estado "d.get('team')") $(ls "$(NEW)/packs" 2>/dev/null | tr '\n' ' ')"
  [ ! -d "$(NEW)/packs/equipo-juguete" ] && ok "(d) …sin dejar su carpeta vacía" || mal "(d) quedó la carpeta vacía packs/equipo-juguete"
  # (e) una versión que tampoco acepta la instalada (su cargador no sabe validar paquetes): no se instala, team-invalid
  paquete equipo-juguete-2 rev-juguete-base rev-fantasma; harness_lab_team_publish "rota de nuevo"
  harness_lab_publish_stable 2026.10.08.3 skills/tycon-pipeline/scripts/lib/packs.js "'use strict'; module.exports = { cargarPaquetes() { return []; } };"
  OUT="$(harness_release update --yes 2>&1)"; RC=$?
  [ "$RC" = 2 ] && ok "(e) update sale 2: ni la punta ni la instalada valen para la versión nueva" || mal "(e) rc $RC: $OUT"
  [ "$(estado "d['version']['number']")" = 2026.10.08.2 ] && ok "(e) la máquina quedó en 2026.10.08.2" || mal "(e) versión: $(estado "d['version']['number']")"
  [ "$(estado "(d.get('failed') or {}).get('reason')")" = team-invalid ] && ok "(e) la versión queda anotada: failed team-invalid" || mal "(e) failed: $(estado "d.get('failed')")"
  JSON="$(harness_release doctor --json 2>/dev/null)"
  case "$JSON" in *team-invalid*|*"no vale para la versión"*) ok "(e) doctor lo dice" ;; *) mal "(e) doctor no lo dice: $JSON" ;; esac
  N0="$(tarballs)"
  ventana none
  harness_release startup >/dev/null 2>&1
  [ "$(tarballs)" = "$N0" ] && ok "(e) el arranque siguiente no vuelve a bajar esa versión" || mal "(e) volvió a bajar: $(( $(tarballs) - N0 )) comprimido(s)"
  # (f) el equipo arregla su capa PARA la versión nueva (sin paquete, y `requires.harness` subido a ella: la instalada ya no la
  # acepta): el refresco ve otra punta y libera la versión; el arranque siguiente la instala con esa punta
  rm -rf "$LAB_AUTHOR_TEAM/packs" "$LAB_AUTHOR_TEAM/agents"
  printf '{ "schema": 1, "name": "equipo-lab", "requires": { "harness": ">= 2026.10.08.3" } }\n' > "$LAB_AUTHOR_TEAM/team-layer.json"
  harness_lab_team_publish "arreglada para 2026.10.08.3"
  FIXED="$(team_head)"
  ventana none; harness_release startup >/dev/null 2>&1
  [ -z "$(estado "(d.get('failed') or {}).get('reason') or ''")" ] && ok "(f) con otra punta del equipo, la versión fallida queda libre para reintentar" || mal "(f) failed sigue: $(estado "d.get('failed')")"
  ventana none; harness_release startup >/dev/null 2>&1
  [ "$(estado "d['version']['number']")" = 2026.10.08.3 ] && [ "$(estado "d['team']['commit']")" = "$FIXED" ] && ok "(f) el arranque siguiente instala 2026.10.08.3 con la punta arreglada" || mal "(f) versión $(estado "d['version']['number']") · team $(estado "d['team'].get('commit')")"
  unset TYCON_PACKS_DIR TYCON_AGENTS_DIR
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T20 ────────────────────────────────────────────────────────────────────
if corre T20; then
  echo "T20 · con la capa de la A2a: los revisores en el set, el agente y la skill anidada por su ruta, doctor sin «falta el paquete»"
  lab_a2 "$BASE/lab20"
  instala_team
  [ "$INSTALL_RC" = 0 ] && ok "instalada con la capa de la A2a" || mal "install: rc $INSTALL_RC: $INSTALL_OUT"
  DIFF=0
  for f in packs/equipo-juguete/pack.json packs/equipo-juguete/agents/rev-juguete-base.md packs/equipo-juguete/agents/rev-juguete-cond.md skills/sola-juguete/SKILL.md skills/projects/cliente-inventado/arquitectura-juguete/references/a.md; do
    cmp -s "$(NEW)/$f" "$LAB_AUTHOR_TEAM/$f" || { mal "$f no está o difiere en ~/.tycon/harness"; DIFF=1; }
  done
  [ "$DIFF" = 0 ] && ok "los archivos de la capa, byte a byte, en ~/.tycon/harness"
  [ "$(estado "d['team']['files']")" = 8 ] && ok "el estado cuenta los 8 archivos de la capa" || mal "team.files: $(estado "d['team'].get('files')")"
  # el set de revisores sobre un repo de juguete con un .ts: los dos del paquete del equipo (packs.default all del perfil)
  mkdir -p "$BASE/repo20"; printf 'export const x = 1;\n' > "$BASE/repo20/a.ts"
  OUT="$(node "$(NEW)/skills/tycon-pipeline/scripts/pipeline.js" advisors --repo "$BASE/repo20" --files a.ts 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "pipeline.js advisors sale 0" || mal "advisors rc $RC: $OUT"
  case "$OUT" in *rev-juguete-base*) ok "el revisor base del paquete del equipo está en el set" ;; *) mal "el revisor base no está: $OUT" ;; esac
  case "$OUT" in *rev-juguete-cond*) ok "el condicional también (su superficie toca a.ts)" ;; *) mal "el condicional no está: $OUT" ;; esac
  # lo que corre el aplicador real: los enlaces de agents y skills; después, el agente y la skill anidada por su ruta
  node "$(NEW)/scripts/lib/canonical-path.js" --ensure-repo-links --clone "$(NEW)" --home "$LAB_HOME" >/dev/null 2>&1
  [ -f "$LAB_HOME/.claude/agents/rev-juguete-base.md" ] && ok "~/.claude/agents/rev-juguete-base.md" || mal "el agente no está en ~/.claude/agents: $(ls -la "$LAB_HOME/.claude/agents" 2>&1 | head -3)"
  [ -f "$LAB_HOME/.claude/skills/projects/cliente-inventado/arquitectura-juguete/SKILL.md" ] && ok "la skill anidada se lee por su ruta (~/.claude/skills/projects/…)" || mal "la skill anidada no se alcanza"
  [ -f "$LAB_HOME/.claude/skills/sola-juguete/SKILL.md" ] && ok "la skill de una carpeta está donde Claude Code la carga" || mal "la skill de una carpeta no está"
  JSON="$(harness_release doctor --json 2>/dev/null)"
  [ "$(printf '%s' "$JSON" | jtxt "len(d['fail'])")" = 0 ] && ok "doctor sin fail" || mal "doctor fail: $(printf '%s' "$JSON" | jtxt "d['fail']")"
  case "$JSON" in *"paquete de revisores del equipo"*"todavía no está"*) mal "doctor sigue diciendo que falta el paquete del equipo" ;; *) ok "doctor ya no dice que falta el paquete del equipo" ;; esac
  # un dev con ~/.claude/skills carpeta REAL que ya trae su propio projects/: las anidadas del equipo no se ven, y se avisa
  rm -rf "$LAB_HOME/.claude/skills"; mkdir -p "$LAB_HOME/.claude/skills/projects/propio"
  JSON="$(harness_release doctor --json 2>/dev/null)"
  case "$(printf '%s' "$JSON" | jtxt "' '.join(d['warn'])")" in *"$LAB_HOME/.claude/skills/projects"*) ok "doctor avisa nombrando la carpeta propia que tapa las skills anidadas" ;; *) mal "doctor no lo avisa: $(printf '%s' "$JSON" | jtxt "d['warn']")" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T26 ────────────────────────────────────────────────────────────────────
if corre T26; then
  echo "T26 · los dos momentos: lo de la capa sola antes de escribir; lo de la versión con la versión a mano; una sola bajada"
  lab_a2 "$BASE/lab26"
  # (1) momento 1 en install: un agente cuyo name: no es su archivo → 1 con la HOME idéntica
  agente rev-juguete-base otro-nombre; harness_lab_team_publish "name que no coincide"
  H0="$(harness_lab_home_hash)"
  instala_team
  [ "$INSTALL_RC" = 1 ] && ok "(1) install sale 1" || mal "(1) rc $INSTALL_RC: $INSTALL_OUT"
  case "$INSTALL_OUT" in *rev-juguete-base*) ok "(1) …nombrando el agente" ;; *) mal "(1) no nombra el agente: $INSTALL_OUT" ;; esac
  [ "$(harness_lab_home_hash)" = "$H0" ] && ok "(1) la HOME quedó idéntica por hash" || mal "(1) la HOME cambió"
  # (1 bis) momento 1 en migrate: una máquina con clon (su propio laboratorio, como T13 de la mudanza) que se muda con --team
  harness_lab_create "$BASE/lab26m"
  export TYCON_PROFILE=
  harness_lab_release_server
  pipeline_en_la_version
  harness_lab_publish_stable 2026.10.08.1
  harness_lab_team_repo
  capa_a2
  agente rev-juguete-base otro-nombre; harness_lab_team_publish "name que no coincide"
  harness_lab_team_server
  printf '{ "install": { "profile": "full" } }\n' > "$LAB_TREE/perfil-equipo.json"   # el clon contesta la pregunta del perfil (como T13)
  harness install --yes >"$BASE/lab26m/install-clon.out" 2>&1 || mal "(1 bis) la instalación desde el clon falló: $(tail -3 "$BASE/lab26m/install-clon.out" | tr '\n' ' ')"
  H1="$(harness_lab_home_hash)"
  OUT="$(harness migrate --to-home --team "$LAB_TEAM" 2>&1)"; RC=$?
  [ "$RC" = 1 ] && ok "(1 bis) migrate sale 1" || mal "(1 bis) rc $RC: $OUT"
  case "$OUT" in *rev-juguete-base*) ok "(1 bis) …nombrando el agente" ;; *) mal "(1 bis) no nombra el agente: $OUT" ;; esac
  [ "$(harness_lab_home_hash)" = "$H1" ] && ok "(1 bis) la HOME quedó idéntica por hash" || mal "(1 bis) la HOME cambió"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  # de vuelta al laboratorio de (1)
  harness_lab_create "$BASE/lab26b"
  export TYCON_PROFILE=
  harness_lab_release_server
  pipeline_en_la_version
  harness_lab_publish_stable 2026.10.08.1
  harness_lab_team_repo
  capa_a2
  harness_lab_team_server
  # (2) momento 2 en install: un agente que se llama como uno de la versión → 1, sin incoming/, sin caché nueva, sin estado
  harness_lab_release_fresh_home
  agente rev-juguete-base rev-juguete-base
  agente tycon-core-juguete tycon-core-juguete; harness_lab_team_publish "choca con el núcleo de la versión"
  CLASH="$(team_head)"
  instala_team
  [ "$INSTALL_RC" = 1 ] && ok "(2) install sale 1" || mal "(2) rc $INSTALL_RC: $INSTALL_OUT"
  case "$INSTALL_OUT" in *tycon-core-juguete*) ok "(2) …nombrando el agente que choca" ;; *) mal "(2) no lo nombra: $INSTALL_OUT" ;; esac
  [ -z "$(ls -d "$LAB_HOME/.tycon/incoming"/* 2>/dev/null)" ] && [ ! -e "$(NEW)" ] && ok "(2) sin incoming/ ni ~/.tycon/harness" || mal "(2) quedó algo: $(ls "$LAB_HOME/.tycon" 2>/dev/null | tr '\n' ' ')"
  [ ! -e "$(TEAM_CACHE "$CLASH")" ] && ok "(2) sin la caché del commit rechazado" || mal "(2) quedó la caché"
  [ -z "$(estado "d.get('team') or ''")" ] && ok "(2) sin team en el estado" || mal "(2) team: $(estado "d.get('team')")"
  rm -f "$LAB_AUTHOR_TEAM/agents/tycon-core-juguete.md"; harness_lab_team_publish "sana"
  # (3) el Azure de juguete con una capa de 50 archivos: cada uno se pide UNA vez (la bajada del momento 1 es la que se apila)
  # 8 de la capa sana + 42 = 50
  for i in $(seq 1 42); do printf '# referencia %s\n' "$i" > "$LAB_AUTHOR_TEAM/skills/projects/cliente-inventado/arquitectura-juguete/references/r$i.md"; done
  harness_lab_team_publish "50 archivos"
  harness_lab_release_fresh_home
  harness_lab_team_azure_server
  harness_lab_team_azure_pat
  OUT="$(harness install --version latest --team "$LAB_TEAM_URL" --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "(3) install con la capa de 50 archivos desde Azure sale 0" || mal "(3) rc $RC: $OUT"
  [ "$(estado "d['team']['files']")" = 50 ] && ok "(3) 50 archivos apilados" || mal "(3) team.files: $(estado "d.get('team')")"
  REPEATS="$(grep -o 'items?path=[^&]*' "$LAB_AZURE_LOG" 2>/dev/null | sort | uniq -d | wc -l | tr -d ' ')"
  [ "$REPEATS" = 0 ] && ok "(3) ningún archivo se pidió dos veces" || mal "(3) $REPEATS archivo(s) pedidos más de una vez"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T27 ────────────────────────────────────────────────────────────────────
if corre T27; then
  echo "T27 · el refresco con carpetas: lo nuevo llega, lo sacado no deja carpetas vacías ni enlaces colgando, lo editado se guarda"
  lab_a2 "$BASE/lab27"
  instala_team
  [ "$INSTALL_RC" = 0 ] && ok "instalada con la capa" || mal "install: rc $INSTALL_RC: $INSTALL_OUT"
  links() { node "$(NEW)/scripts/lib/canonical-path.js" --ensure-repo-links --clone "$(NEW)" --home "$LAB_HOME" >/dev/null 2>&1; }
  colgados() { find "$LAB_HOME/.claude/agents/" "$LAB_HOME/.claude/skills/" -type l ! -exec test -e {} \; -print 2>/dev/null | wc -l | tr -d ' '; }
  for forma in entero por-entrada; do
    if [ "$forma" = por-entrada ]; then
      # ~/.claude/agents y ~/.claude/skills como carpetas REALES: el aplicador deja un enlace por entrada
      rm -rf "$LAB_HOME/.claude/agents" "$LAB_HOME/.claude/skills"; mkdir -p "$LAB_HOME/.claude/agents" "$LAB_HOME/.claude/skills"
    fi
    links
    # un commit con un revisor y una skill anidada más, y una skill menos; además un archivo editado a mano en una anidada
    agente rev-juguete-extra-$forma rev-juguete-extra-$forma
    skill projects/cliente-inventado/nueva-$forma
    rm -rf "$LAB_AUTHOR_TEAM/skills/sola-juguete"
    harness_lab_team_publish "uno más, una menos ($forma)"
    printf '# editado a mano\n' >> "$(NEW)/skills/projects/cliente-inventado/arquitectura-juguete/references/a.md"
    ventana none
    harness_release startup >/dev/null 2>&1
    links
    [ "$(estado "d['team']['commit']")" = "$(team_head)" ] && ok "($forma) la capa se refrescó en el arranque" || mal "($forma) team: $(estado "d.get('team')")"
    [ -f "$LAB_HOME/.claude/agents/rev-juguete-extra-$forma.md" ] && ok "($forma) el revisor nuevo en ~/.claude/agents" || mal "($forma) el revisor nuevo no está"
    [ -f "$LAB_HOME/.claude/skills/projects/cliente-inventado/nueva-$forma/SKILL.md" ] && ok "($forma) la skill anidada nueva por su ruta" || mal "($forma) la anidada nueva no está"
    [ ! -e "$(NEW)/skills/sola-juguete" ] && ok "($forma) la skill sacada no deja su carpeta" || mal "($forma) quedó skills/sola-juguete: $(ls -a "$(NEW)/skills/sola-juguete" 2>/dev/null | tr '\n' ' ')"
    [ "$(colgados)" = 0 ] && ok "($forma) cero enlaces colgando" || mal "($forma) $(colgados) enlace(s) colgando"
    VACIAS="$(find "$LAB_HOME/.claude/agents/" "$LAB_HOME/.claude/skills/" -type d -empty 2>/dev/null | wc -l | tr -d ' ')"
    [ "$VACIAS" = 0 ] && ok "($forma) ninguna carpeta vacía bajo ~/.claude/{agents,skills}" || mal "($forma) $VACIAS carpeta(s) vacía(s) bajo ~/.claude: $(find "$LAB_HOME/.claude/agents/" "$LAB_HOME/.claude/skills/" -type d -empty 2>/dev/null | head -3 | tr '\n' ' ')"
    grep -q 'editado a mano' "$(NEW)/skills/projects/cliente-inventado/arquitectura-juguete/references/a.md" && ok "($forma) el archivo editado en la skill anidada se conservó" || mal "($forma) el editado se pisó"
    skill sola-juguete; harness_lab_team_publish "vuelve la skill"   # para la vuelta siguiente
    git -C "$LAB_AUTHOR_TEAM" show HEAD:skills/projects/cliente-inventado/arquitectura-juguete/references/a.md > "$(NEW)/skills/projects/cliente-inventado/arquitectura-juguete/references/a.md" 2>/dev/null
    ventana none; harness_release startup >/dev/null 2>&1
  done
  # uninstall conserva un archivo editado dentro de una skill anidada
  printf '# editado antes de desinstalar\n' >> "$(NEW)/skills/projects/cliente-inventado/arquitectura-juguete/references/a.md"
  OUT="$(harness_release uninstall --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "uninstall sale 0" || mal "uninstall rc $RC: $OUT"
  KEPT="$(find "$LAB_HOME/.tycon/team" -path '*kept-*' -name a.md 2>/dev/null | head -1)"
  [ -n "$KEPT" ] && grep -q 'editado antes de desinstalar' "$KEPT" && ok "uninstall guardó el editado de la skill anidada en kept-…" || mal "uninstall no lo guardó: $(find "$LAB_HOME/.tycon/team" -maxdepth 3 2>/dev/null | head)"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T29 ────────────────────────────────────────────────────────────────────
if corre T29; then
  echo "T29 · una punta rechazada por una versión se vuelve a evaluar cuando cambia la versión instalada"
  lab_a2 "$BASE/lab29"
  # 2026.10.08.1 sabe validar paquetes; se instala con la capa SIN revisores
  rm -rf "$LAB_AUTHOR_TEAM/packs" "$LAB_AUTHOR_TEAM/agents"; harness_lab_team_publish "la capa sin revisores"
  instala_team
  [ "$INSTALL_RC" = 0 ] && ok "instalada (2026.10.08.1) con la capa sin revisores" || mal "install: rc $INSTALL_RC: $INSTALL_OUT"
  # 2026.10.08.2 NO sabe validar paquetes (su cargador no valida paquetes); update la instala con la misma capa
  harness_lab_publish_stable 2026.10.08.2 skills/tycon-pipeline/scripts/lib/packs.js "'use strict'; module.exports = { cargarPaquetes() { return []; } };"
  OUT="$(harness_release update --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d['version']['number']")" = 2026.10.08.2 ] && ok "update a 2026.10.08.2 con la misma capa" || mal "update rc $RC: $OUT"
  # la punta trae revisores: 2026.10.08.2 la rechaza en el refresco y la anota con su número
  capa_a2 "la punta trae revisores"
  TIP="$(team_head)"
  ventana none
  harness_release startup >/dev/null 2>&1
  [ "$(estado "(d['team'].get('rejected') or {}).get('commit')")" = "$TIP" ] && ok "la versión vieja rechaza la punta y la anota" || mal "rejected: $(estado "d['team'].get('rejected')")"
  [ "$(estado "(d['team'].get('rejected') or {}).get('version')")" = 2026.10.08.2 ] && ok "…con la versión que la rechazó" || mal "rejected sin versión: $(estado "d['team'].get('rejected')")"
  [ "$(printf '%s' "$(harness_release doctor --json 2>/dev/null)" | jtxt "len(d['fail'])")" = 0 ] && ok "doctor sin fail con la capa de antes" || mal "doctor con fail"
  # rollback a 2026.10.08.1 (la versión cambia sin pasar por el apilado de update): el refresco siguiente reevalúa la punta
  OUT="$(harness_release rollback 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d['version']['number']")" = 2026.10.08.1 ] && ok "rollback a 2026.10.08.1" || mal "rollback rc $RC: $OUT · versión $(estado "d['version']['number']")"
  # (la vuelta atrás retiene la actualización: el arranque no vuelve solo a 2026.10.08.2 y sí refresca la capa)
  ventana none
  harness_release startup >/dev/null 2>&1
  [ "$(estado "d['version']['number']")" = 2026.10.08.1 ] || mal "el arranque volvió a otra versión: $(estado "d['version']['number']")"
  [ "$(estado "d['team']['commit']")" = "$TIP" ] && [ -f "$(NEW)/packs/equipo-juguete/pack.json" ] && ok "con otra versión instalada, el refresco reevalúa la punta rechazada y la apila" || mal "no la reevaluó: $(estado "d.get('team')")"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

echo
[ "$FALLOS" = 0 ] && { echo "✅ harness-team-a2: todo verde"; exit 0; } || { echo "❌ harness-team-a2: $FALLOS falla(s)"; exit 1; }
