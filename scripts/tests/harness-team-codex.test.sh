#!/usr/bin/env bash
# harness-team-codex.test.sh — los revisores de la capa del equipo del lado de Codex (T30), en el
# laboratorio: una versión de juguete con las piezas REALES del enchufe de Codex (build/, harness_lab_codex_pieces), el
# GitHub de juguete con los dos repos y una máquina con Claude Code y Codex. Nombres inventados.
#
# Lo que no se puede perder (T30 = Codex_LayerReviewersToCodexHome_…):
#   (a) install --team: las dos traducciones de cada revisor de la capa en $CODEX_HOME (generadas por la máquina) y NINGUNA en
#       adapters/ del árbol; doctor sin «editado»; el registro con los cuatro archivos; la skill de una carpeta enlazada.
#   (b) la paridad mide los de la capa contra lo que el generador escribiría: uno que falta es `faltan`, no la nota de los
#       «¿personales?»; y vuelve al verde con el despliegue forzado.
#   (c) un revisor con un servidor MCP que equivalences.json no conoce no se despliega y se nombra, los otros sí, el despliegue
#       sale 0 y el sello queda escrito; un archivo del dev con el nombre de un revisor de la capa no se pisa, se dice y la
#       paridad lo cuenta como faltante.
#   (d) una versión pública nueva con ese revisor roto en la capa: update la instala sin `failed` ni vuelta atrás.
#   (e) dos arranques: el commit de la capa que saca un revisor (y una skill) lo saca de $CODEX_HOME en ese arranque, sin
#       enlace colgando; con su .toml editado a mano, el editado queda.
#   (f) con .tycon-team.json ilegible no se borra nada de la capa en Codex, y se dice.
#   (g) un cambio sólo de la capa cambia la huella, que sigue teniendo cinco partes y nombra el commit de la capa.
#   (h) sin capa, la huella de esta rama es la MISMA cadena que la de main sobre el mismo árbol.
#   (i) uninstall: ningún .toml de la capa queda en $CODEX_HOME.
#
# Laboratorio: scripts/tests/lib/harness-lab.sh. Nunca ~/.claude, ~/.codex ni el checkout real. Sin pipes sobre el comando medido.
# Uso: bash scripts/tests/harness-team-codex.test.sh
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
export TYCON_UPDATE_APPLY=auto TYCON_STARTUP_DETACH=0
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
BASE="$(mktemp -d)"
case "$BASE" in "$RAIZ"*|*agent-skills*|*/.claude*) echo "❌ harness-team-codex: el laboratorio cayó en ${BASE}"; exit 1 ;; esac
trap 'rm -rf "$BASE"; kill $(jobs -p) 2>/dev/null' EXIT
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
NEW() { printf '%s' "$LAB_HOME/.tycon/harness"; }
ESTADO() { node -e 'process.stdout.write(require(process.argv[1]).stateDir(process.argv[2]))' "$(NEW)/scripts/setup/harness/tycon-home.js" "$LAB_HOME"; }
estado() { j "$(ESTADO)/harness-state.json" "$1"; }
REC() { printf '%s' "$(ESTADO)/codex-team-deploy.json"; }
ventana() { # ventana none — la última mirada a la red: nunca (el arranque siguiente mira)
  python3 - "$(ESTADO)/harness-state.json" <<'PY'
import json,sys
f=sys.argv[1]; d=json.load(open(f, encoding='utf-8'))
d['last_fetch']=None; d['last_fetch_failed']=None
json.dump(d, open(f,'w', encoding='utf-8'), indent=2)
PY
}
huella() { (cd "$(NEW)" && node -e 'process.stdout.write(require(process.argv[1]).fingerprint())' "${1:-$(NEW)/build/deploy-codex-all.js}"); }
sello() { j "$(ESTADO)/codex-deploy-stamp.json" "d.get('fingerprint') or ''"; }
paridad_advisors() { # paridad_advisors → «ok|detalle» de la superficie advisors
  TYCON_PARITY_BENCH_DIR="$BASE/bench" node "$(NEW)/scripts/lib/harness-parity.js" --json 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); s=[x for x in d['surfaces'] if x['name']=='advisors'][0]; print(('ok' if s['ok'] else 'rojo')+'|'+s['detail'])"
}
agente() { # agente <nombre> [tools]
  mkdir -p "$LAB_AUTHOR_TEAM/agents"
  printf -- '---\nname: %s\ndescription: revisor del equipo de juguete\nmodel: sonnet\ntools: %s\n---\n\nRevisa cosas del equipo de juguete.\n' "$1" "${2:-Read, Grep, Glob}" > "$LAB_AUTHOR_TEAM/agents/$1.md"
}
skill() { mkdir -p "$LAB_AUTHOR_TEAM/skills/$1"; printf -- '---\nname: %s\ndescription: skill del equipo de juguete\n---\nUsala para probar.\n' "$1" > "$LAB_AUTHOR_TEAM/skills/$1/SKILL.md"; }
arranque() { ventana; STARTUP_OUT="$(harness_release startup 2>&1)"; STARTUP_RC=$?; }
colgados() { find "$CODEX_HOME" -type l ! -exec test -e {} \; -print 2>/dev/null; }

echo "T30 · los revisores de la capa del equipo en Codex: generados por la máquina, nunca en el árbol, y sacados cuando la capa los saca"
harness_lab_create "$BASE/lab"
export TYCON_PROFILE=
harness_lab_release_server
harness_lab_codex_pieces || mal "no pude sumar las piezas de Codex al laboratorio"
harness_lab_publish_stable 2026.10.08.1
harness_lab_team_repo
agente rev-capa-uno; agente rev-capa-dos; skill sola-juguete
harness_lab_team_publish "la capa con dos revisores y una skill"
harness_lab_team_server
harness_lab_release_fresh_home
harness_lab_tools both

# (a) install --team
OUT="$(harness install --version latest --team "$LAB_TEAM" --yes 2>&1)"; RC=$?
[ "$RC" = 0 ] && ok "(a) install --team con Claude Code y Codex sale 0" || mal "(a) install salió $RC: $OUT"
for n in rev-capa-uno rev-capa-dos; do
  [ -f "$CODEX_HOME/$n.config.toml" ] && [ -f "$CODEX_HOME/agents/$n.toml" ] && ok "(a) $n: perfil y subagente en \$CODEX_HOME" || mal "(a) $n no está en $CODEX_HOME: $(ls "$CODEX_HOME" "$CODEX_HOME/agents" 2>&1 | tr '\n' ' ')"
done
grep -q 'modelo\|model = ' "$CODEX_HOME/rev-capa-uno.config.toml" 2>/dev/null && ok "(a) …con el generador de la versión (trae model)" || mal "(a) el perfil no parece generado: $(head -5 "$CODEX_HOME/rev-capa-uno.config.toml" 2>&1)"
[ -z "$(ls "$(NEW)/adapters/codex/agents" "$(NEW)/adapters/codex/agents-native" 2>/dev/null | grep rev-capa)" ] && ok "(a) ninguna traducción de la capa en adapters/ del árbol" || mal "(a) hay traducciones de la capa en el árbol"
DOC="$(harness_release doctor --json 2>&1)"
case "$DOC" in *editado*) mal "(a) doctor dice «editado»: $(printf '%s' "$DOC" | grep -o '[^"]*editado[^"]*' | head -2)" ;; *) ok "(a) doctor sin «editado»" ;; esac
N="$(j "$(REC)" "len(d['files'])")"
[ "$N" = 4 ] && ok "(a) el registro anota los cuatro archivos" || mal "(a) el registro tiene ${N:-nada}: $(cat "$(REC)" 2>&1 | head -5)"
[ -e "$CODEX_HOME/skills/sola-juguete/SKILL.md" ] && ok "(a) la skill de una carpeta de la capa, enlazada en ~/.codex/skills (medido)" || mal "(a) la skill de la capa no llegó a ~/.codex/skills: $(ls -la "$CODEX_HOME/skills" 2>&1 | grep juguete)"

# (b) la paridad
P="$(paridad_advisors)"
case "$P" in ok\|*"de la capa del equipo"*) ok "(b) la paridad cuenta a los de la capa y da verde: ${P#ok|}" ;; *) mal "(b) paridad: $P" ;; esac
rm -f "$CODEX_HOME/agents/rev-capa-dos.toml"
P="$(paridad_advisors)"
case "$P" in rojo\|*faltan\ 1*rev-capa-dos*) ok "(b) sin un .toml de la capa: rojo, faltan 1, nombrándolo" ;; *) mal "(b) sin el .toml la paridad dice: $P" ;; esac
case "$P" in *personales*rev-capa*) mal "(b) los de la capa aparecen en la nota de los personales: $P" ;; *) ok "(b) los de la capa no van a la nota «¿personales?»" ;; esac
node "$(NEW)/build/deploy-codex-all.js" --force >/dev/null 2>&1
P="$(paridad_advisors)"; case "$P" in ok\|*) ok "(b) el despliegue forzado lo repone" ;; *) mal "(b) después del despliegue forzado: $P" ;; esac

# (c) un revisor que Codex no puede traducir y un archivo del dev con el nombre de otro
printf '# el perfil propio del dev\n' > "$CODEX_HOME/rev-capa-tres.config.toml"
agente rev-capa-tres; agente rev-capa-cuatro 'Read, mcp__servidor-desconocido-lab__buscar'
harness_lab_team_publish "dos revisores más"
TEAM2="$(harness_lab_team_head)"
arranque
[ "$(j "$(NEW)/.tycon-team.json" "d['commit']")" = "$TEAM2" ] && ok "(c) el arranque refrescó la capa" || mal "(c) la capa no se refrescó: $STARTUP_OUT"
[ "$(cat "$CODEX_HOME/rev-capa-tres.config.toml")" = "# el perfil propio del dev" ] && ok "(c) el archivo del dev con el nombre de un revisor no se pisó" || mal "(c) se pisó el archivo del dev"
[ -f "$CODEX_HOME/agents/rev-capa-tres.toml" ] && ok "(c) …y el subagente de ese revisor sí está" || mal "(c) falta el subagente de rev-capa-tres"
[ ! -e "$CODEX_HOME/rev-capa-cuatro.config.toml" ] && [ ! -e "$CODEX_HOME/agents/rev-capa-cuatro.toml" ] && ok "(c) el revisor sin equivalencia no se desplegó" || mal "(c) rev-capa-cuatro se desplegó"
[ -f "$CODEX_HOME/rev-capa-uno.config.toml" ] && ok "(c) los demás siguen desplegados" || mal "(c) rev-capa-uno no está"
GOUT="$(cd "$(NEW)" && node build/generate.js --deploy-only 2>&1)"; GRC=$?
[ "$GRC" = 0 ] && ok "(c) el despliegue sale 0 con un revisor de la capa roto" || mal "(c) generate.js --deploy-only salió $GRC: $GOUT"
case "$GOUT" in *"revisor de la capa rev-capa-cuatro no desplegado"*servidor-desconocido-lab*) ok "(c) …y lo nombra con su motivo" ;; *) mal "(c) no nombra el revisor roto: $GOUT" ;; esac
case "$GOUT" in *rev-capa-tres.config.toml*"no se pisa"*) ok "(c) …y dice que el archivo del dev no se pisa" ;; *) mal "(c) no dice lo del archivo del dev: $GOUT" ;; esac
[ -n "$(sello)" ] && [ "$(sello)" = "$(huella)" ] && ok "(c) el sello del despliegue quedó escrito con la huella de ahora" || mal "(c) sello «$(sello)» vs huella «$(huella)»"
P="$(paridad_advisors)"
case "$P" in rojo\|*faltan*) ok "(c) la paridad cuenta el archivo del dev y el revisor roto como faltantes: ${P#rojo|}" ;; *) mal "(c) paridad: $P" ;; esac

# (d) una versión pública nueva con el revisor roto en la capa: se instala, sin failed ni vuelta atrás
harness_lab_publish_stable 2026.10.08.2
OUT="$(harness_release update --yes 2>&1)"; RC=$?
[ "$RC" = 0 ] && [ "$(estado "d['version']['number']")" = 2026.10.08.2 ] && ok "(d) update instala la versión nueva" || mal "(d) update salió $RC, versión $(estado "d.get('version')"): $OUT"
[ "$(estado "d.get('failed') or ''")" = "" ] && ok "(d) …sin failed ni vuelta atrás" || mal "(d) failed: $(estado "d.get('failed')")"

# (e) dos arranques: el que saca un revisor (y la skill) y el que saca otro con su .toml editado a mano
rm -f "$LAB_AUTHOR_TEAM/agents/rev-capa-uno.md" "$LAB_AUTHOR_TEAM/agents/rev-capa-cuatro.md"; rm -rf "$LAB_AUTHOR_TEAM/skills/sola-juguete"
harness_lab_team_publish "sale rev-capa-uno y la skill"
arranque
[ ! -e "$CODEX_HOME/rev-capa-uno.config.toml" ] && [ ! -e "$CODEX_HOME/agents/rev-capa-uno.toml" ] && ok "(e) el revisor que la capa sacó ya no está en \$CODEX_HOME, en ese arranque" || mal "(e) rev-capa-uno sigue: $(ls "$CODEX_HOME" | tr '\n' ' ')"
[ -z "$(colgados)" ] && ok "(e) ningún enlace colgando en \$CODEX_HOME (la skill sacada)" || mal "(e) enlaces colgando: $(colgados)"
printf '# editado a mano\n' >> "$CODEX_HOME/agents/rev-capa-dos.toml"
rm -f "$LAB_AUTHOR_TEAM/agents/rev-capa-dos.md"
harness_lab_team_publish "sale rev-capa-dos"
arranque
[ ! -e "$CODEX_HOME/rev-capa-dos.config.toml" ] && ok "(e) del revisor sacado, lo que no se tocó se borró" || mal "(e) rev-capa-dos.config.toml sigue"
grep -q 'editado a mano' "$CODEX_HOME/agents/rev-capa-dos.toml" 2>/dev/null && ok "(e) …y el .toml editado a mano quedó" || mal "(e) se borró el editado a mano"

# (f) .tycon-team.json ilegible: nada de la capa se borra en Codex, y se dice
cp "$(NEW)/.tycon-team.json" "$BASE/team-manifest.bak"
ANTES="$(ls "$CODEX_HOME" "$CODEX_HOME/agents" | LC_ALL=C sort)"
printf 'ilegible' > "$(NEW)/.tycon-team.json"
GOUT="$(cd "$(NEW)" && node build/generate.js --deploy-only 2>&1)"; GRC=$?
[ "$GRC" = 0 ] && [ "$ANTES" = "$(ls "$CODEX_HOME" "$CODEX_HOME/agents" | LC_ALL=C sort)" ] && ok "(f) con el manifiesto de la capa ilegible no se borra nada" || mal "(f) rc $GRC o cambió \$CODEX_HOME: $GOUT"
case "$GOUT" in *"no se borra nada de la capa en Codex"*) ok "(f) …y lo dice" ;; *) mal "(f) no lo dice: $GOUT" ;; esac
cp "$BASE/team-manifest.bak" "$(NEW)/.tycon-team.json"

# (g) un cambio sólo de la capa cambia la huella, que sigue en cinco partes y nombra la capa
H1="$(huella)"; C1="$(j "$(NEW)/.tycon-team.json" "d['commit']")"
agente rev-capa-cinco; harness_lab_team_publish "uno más"
arranque
H2="$(huella)"; C2="$(j "$(NEW)/.tycon-team.json" "d['commit']")"
[ "$H1" != "$H2" ] && [ "$C1" != "$C2" ] && ok "(g) un commit sólo de la capa cambia la huella" || mal "(g) la huella no cambió: $H1 / $H2"
[ "$(printf '%s' "$H2" | awk -F'|' '{print NF}')" = 5 ] && case "$H2" in *":t:$C2"*) true ;; *) false ;; esac && ok "(g) cinco partes, con el commit de la capa dentro de la del árbol" || mal "(g) huella: $H2"
[ -f "$CODEX_HOME/agents/rev-capa-cinco.toml" ] && ok "(g) …y ese arranque desplegó el revisor nuevo" || mal "(g) rev-capa-cinco no llegó a Codex en ese arranque"

# (h) sin capa, la huella de esta rama es la misma cadena que la de main sobre el mismo árbol
MAINFP="$(NEW)/build/.huella-main.js"
if git -C "$RAIZ" show origin/main:build/deploy-codex-all.js > "$MAINFP" 2>/dev/null; then
  mv "$(NEW)/.tycon-team.json" "$BASE/team-manifest.aparte"
  HM="$(huella "$MAINFP")"; HR="$(huella)"
  mv "$BASE/team-manifest.aparte" "$(NEW)/.tycon-team.json"
  [ -n "$HR" ] && [ "$HM" = "$HR" ] && ok "(h) sin capa, la huella de la rama es la de main" || mal "(h) main «${HM}» vs rama «${HR}»"
else echo "  no medido — (h) sin origin/main en este clon: la huella de main no se puede leer"; fi
rm -f "$MAINFP"

# (i) uninstall: lo que el registro dice que escribió la capa (el editado a mano de (e) ya es del dev y no está ahí)
REGISTRADOS="$(j "$(REC)" "' '.join(sorted(d['files']))")"
[ -n "$REGISTRADOS" ] && ok "(i) antes de desinstalar, el registro nombra: $REGISTRADOS" || mal "(i) el registro está vacío antes de desinstalar"
OUT="$(harness_release uninstall --yes 2>&1)"; RC=$?
[ "$RC" = 0 ] && ok "(i) uninstall sale 0" || mal "(i) uninstall salió $RC: $OUT"
QUEDAN=""; for r in $REGISTRADOS; do [ -e "$CODEX_HOME/$r" ] && QUEDAN="$QUEDAN $r"; done
[ -z "$QUEDAN" ] && ok "(i) ningún .toml que escribió la capa queda en \$CODEX_HOME" || mal "(i) quedan:$QUEDAN"
[ "$(cat "$CODEX_HOME/rev-capa-tres.config.toml" 2>/dev/null)" = "# el perfil propio del dev" ] && ok "(i) …y el del dev sigue" || mal "(i) uninstall se llevó el archivo del dev"

echo
[ "$FALLOS" = 0 ] && { echo "✅ harness-team-codex: T30 verde"; exit 0; } || { echo "❌ harness-team-codex: $FALLOS falla(s)"; exit 1; }
