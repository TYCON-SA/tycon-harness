#!/usr/bin/env bash
# deploy-codex-copies.test.sh — desplegar los hooks de Codex desde otra ruta no los acumula (2026-09-15).
#
# El caso real: en la máquina del admin, ~/.codex/hooks.json tenía cada hook del arnés registrado hasta
# seis veces — la ruta de siempre más cinco copias temporales de otras sesiones, tres ya borradas. El
# despliegue reconocía como propias sólo las entradas con SU ruta, así que corrido desde una copia
# conservaba las de la ruta real y sumaba las suyas. Codex corría cada aviso varias veces, sin error.
#
# Todo pasa en carpetas temporales salvo el caso 4, que necesita un destino FUERA de ellas para probar
# el freno: usa una carpeta propia bajo ~/.cache y la borra al terminar.
# DEPLOY_HOOKS_JS apunta a otra versión del despliegue (para verificar el rojo previo contra la vieja).
set -uo pipefail

RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY="${DEPLOY_HOOKS_JS:-$RAIZ/build/deploy-codex-hooks.js}"
T="$(mktemp -d)"
FUERA="$HOME/.cache/tycon-prueba-codex-$$"
trap 'rm -rf "$T" "$FUERA"' EXIT

BIEN=0; MAL=0
ok()  { echo "  ✓ $1"; BIEN=$((BIEN + 1)); }
mal() { echo "  ✗ $1"; MAL=$((MAL + 1)); }

# copia <dir>: lo mínimo que el despliegue necesita para correr desde otra ruta.
copia() {
  mkdir -p "$1/build" "$1/adapters/codex" "$1/scripts/lib"
  cp "$DEPLOY" "$1/build/deploy-codex-hooks.js"
  cp "$RAIZ/adapters/codex/hooks.json" "$1/adapters/codex/hooks.json"
  cp "$RAIZ/scripts/lib/skills-dir.js" "$1/scripts/lib/skills-dir.js"
}
desplegar() { CODEX_HOME="$2" node "$1/build/deploy-codex-hooks.js" > "$T/out" 2>&1; }
comandos() { grep -c '"command"' "$1" 2>/dev/null || echo 0; }

echo "deploy-codex-copias"
copia "$T/a"; copia "$T/b"

# C-01 · desplegar desde otra ruta y volver deja la misma cantidad de hooks que un solo despliegue.
desplegar "$T/a" "$T/h1"; UNO=$(comandos "$T/h1/hooks.json")
desplegar "$T/a" "$T/h2"; desplegar "$T/b" "$T/h2"; desplegar "$T/a" "$T/h2"; TRES=$(comandos "$T/h2/hooks.json")
[ "$UNO" -gt 0 ] && [ "$UNO" = "$TRES" ] && ok "C-01 desplegar desde dos rutas no acumula hooks ($UNO y $TRES)" || mal "C-01 se acumularon hooks: $UNO con una ruta, $TRES con dos"

# C-02 · lo que dejó una copia que ya no existe se limpia en el próximo despliegue.
desplegar "$T/b" "$T/h3"; rm -rf "$T/b"; desplegar "$T/a" "$T/h3"
grep -q "$T/b/" "$T/h3/hooks.json" && mal "C-02 quedaron hooks apuntando a la copia borrada" || ok "C-02 los hooks de una copia borrada se limpian"

# C-03 · un hook propio del dev, aunque viva en una carpeta scripts/hooks, se conserva.
mkdir -p "$T/h4"
printf '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"bash /home/dev/scripts/hooks/mio.sh"}]}]}}\n' > "$T/h4/hooks.json"
desplegar "$T/a" "$T/h4"
grep -q "/home/dev/scripts/hooks/mio.sh" "$T/h4/hooks.json" && ok "C-03 el hook propio del dev se conserva" || mal "C-03 se borró el hook propio del dev"

# C-04 · desde una copia temporal no se toca un Codex que no es temporal (el de la máquina).
desplegar "$T/a" "$FUERA"
if [ ! -e "$FUERA/hooks.json" ] && grep -q "copia temporal" "$T/out"; then
  ok "C-04 desde una copia temporal no se toca el Codex de la máquina, y lo dice"
else
  mal "C-04 una copia temporal escribió en un Codex que no es temporal"; cat "$T/out"
fi

# C-05 · un hook que quedó apuntando a una copia temporal se limpia aunque el arnés ya no lo tenga.
mkdir -p "$T/h5"
printf '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"node %s/copia-vieja/scripts/hooks/retirado.js"}]}]}}\n' "$T" > "$T/h5/hooks.json"
desplegar "$T/a" "$T/h5"
grep -q "copia-vieja/scripts/hooks/retirado.js" "$T/h5/hooks.json" && mal "C-05 quedó un hook retirado apuntando a una copia temporal" || ok "C-05 un hook retirado que apunta a una copia temporal se limpia"

# C-06 y C-07 · story 8.18, hallazgo I12: quien ESCRIBE rutas en la máquina usa las skills INSTALADAS.
# La máquina del equipo después del corte: el clon del arnés ya trae skills/ y agents/ (es «unido») y además hay un
# ~/.claude/agent-skills instalado aparte. Con «el propio clon primero» los comandos de ~/.codex/hooks.json pasaban a
# apuntar al clon del arnés, y Codex aprueba cada hook por su texto: había que re-aprobarlos todos. Sin variable.
unida() { # <dir>: una copia con la forma del repo unido (lo que mira isSingleRepo) y los dos desplegadores
  copia "$1"
  cp "$RAIZ/scripts/lib/canonical-path.js" "$RAIZ/scripts/lib/legacy-names.js" "$1/scripts/lib/" 2>"$T/cp.err" \
    || { mal "no pude armar la copia unida: $(cat "$T/cp.err")"; return 1; }
  # lo que canonical-path.js importa viaja con ella (story 8.19: el nombre del lugar, scripts/setup/harness/place.js, que
  # desde la 8.23 lo toma de tycon-home.js, a su lado)
  mkdir -p "$1/scripts/setup/harness" && cp "$RAIZ/scripts/setup/harness/place.js" "$RAIZ/scripts/setup/harness/tycon-home.js" "$1/scripts/setup/harness/" 2>"$T/cp.err" \
    || { mal "no pude armar la copia unida: $(cat "$T/cp.err")"; return 1; }
  # el mapa de renombres no viaja a la copia pública (story 8.9): sin él legacy-names.js es paso directo, así que allá
  # se arma la copia sin él. Medido en T23 de la 8.7 (story 8.18): exigirlo daba tres rojos en la copia y verde adentro.
  if [ -f "$RAIZ/scripts/lib/renames.json" ]; then
    cp "$RAIZ/scripts/lib/renames.json" "$1/scripts/lib/" 2>"$T/cp.err" || { mal "no pude armar la copia unida: $(cat "$T/cp.err")"; return 1; }
  fi
  cp "$RAIZ/build/deploy-shared-skills.js" "$1/build/deploy-shared-skills.js"
  mkdir -p "$1/skills/tycon-pipeline" "$1/agents"
}
unida "$T/u"
CASA="$T/casa"; INSTALADAS="$CASA/.claude/agent-skills"
mkdir -p "$INSTALADAS/skills/tycon-pipeline" "$INSTALADAS/agents"
# el control: en esta copia la regla general SÍ contesta «el propio clon» (si no, el caso no distingue nada)
PROPIO="$(env -u TYCON_SKILLS_DIR HOME="$CASA" node "$T/u/scripts/lib/skills-dir.js" --source 2>&1)"
env -u TYCON_SKILLS_DIR HOME="$CASA" CODEX_HOME="$T/h6" node "$T/u/build/deploy-codex-hooks.js" > "$T/out" 2>&1
cuenta() { local n; n="$(grep -c -- "$1" "$2" 2>/dev/null)"; echo "${n:-0}"; }   # grep -c ya imprime 0 cuando no hay
A_INSTALADAS=$(cuenta "$INSTALADAS/skills/" "$T/h6/hooks.json")
AL_CLON=$(cuenta "$T/u/skills/" "$T/h6/hooks.json")
if [ "$PROPIO" = "own-clone" ] && [ "$A_INSTALADAS" -gt 0 ] && [ "$AL_CLON" = 0 ]; then
  ok "C-06 en una máquina con dos clones los hooks de Codex apuntan a las skills instaladas ($A_INSTALADAS), no al clon del arnés"
else
  mal "C-06 hooks de Codex: $A_INSTALADAS a las instaladas y $AL_CLON al clon del arnés (la regla general dijo «${PROPIO}»)"; tail -3 "$T/out"
fi
SALE="$(env -u TYCON_SKILLS_DIR HOME="$CASA" CODEX_HOME="$T/h7" node "$T/u/build/deploy-shared-skills.js" --dry-run 2>&1)"
case "$SALE" in
  *"$INSTALADAS/skills →"*) ok "C-07 los enlaces de las skills de Codex salen de las instaladas, no del clon del arnés" ;;
  *) mal "C-07 deploy-shared-skills tomó otra carpeta: $SALE" ;;
esac

# C-08 · los cuatro que escriben (o auditan lo escrito) usan la MISMA variante. C-06 y C-07 ejecutan dos; el despliegue
# completo y la auditoría de paridad no se pueden correr en este laboratorio sin montar la máquina entera, así que acá
# se mira el fuente: es una guarda contra el revert, no una prueba de comportamiento. Si uno vuelve a la regla general,
# la auditoría y el despliegue miran árboles distintos.
for f in build/deploy-codex-all.js build/deploy-codex-hooks.js build/deploy-shared-skills.js scripts/lib/harness-parity.js; do
  if [ ! -f "$RAIZ/$f" ]; then mal "C-08 no encontré $f: no pude mirar"; continue; fi
  if grep -q "resolveInstalledSkillsDirs()" "$RAIZ/$f" && ! grep -q "[.]resolveSkillsDirs()" "$RAIZ/$f"; then
    ok "C-08 $f usa la variante instalada"
  else
    mal "C-08 $f no usa la variante instalada (resolveInstalledSkillsDirs): escribe o audita con «el propio clon primero»"
  fi
done

# C-09 a C-13 · DEF-8.23-C-hooks-codex-sin-integracion (2026-10-09): los hooks de una integración apagada no se registran
# en Codex, con la misma decisión que el lado Claude Code (scripts/setup/apply-hooks.js). Corre el despliegue del árbol
# ENTERO (necesita el aplicador, la lista y el lector de la configuración al lado), con una HOME y un Codex de prueba;
# cada integración la fija su variable, que gana sobre el perfil del equipo. Visto en el nocturno 12518: con Codex
# enchufado y engram apagada, doctor corrió engram-pre-commit.sh.
# story 2.28: el aviso del correo (owner-email-notice.js) es de la integración del buzón, y entra en la cuenta.
DE_INTEGRACION="engram-pre-commit.sh engram-drift-notice.js clocki/scripts/on-prompt.js clocki/scripts/touch-activity.js clocki/scripts/sweep.js dependencies-notice.js dashboard-notice.js retro-staleness-notice.js owner-email-notice.js"
CASA9="$T/casa9"; mkdir -p "$CASA9"
APAGADAS="TYCON_ENGRAM=0 TYCON_CLOCKIFY=0 TYCON_NIGHTLY=0 TYCON_CODEGRAPH=0 TYCON_MAILBOX=0"
PRENDIDAS="TYCON_ENGRAM=1 TYCON_CLOCKIFY=1 TYCON_NIGHTLY=1 TYCON_CODEGRAPH=1 TYCON_MAILBOX=1"
desplegar_arbol() { # <codex home> <VAR=valor…>: el despliegue del árbol de verdad
  local destino="$1"; shift
  env -u TYCON_ENGRAM_HOOK HOME="$CASA9" USERPROFILE="$CASA9" CODEX_HOME="$destino" "$@" node "$RAIZ/build/deploy-codex-hooks.js" > "$T/out9" 2>&1
}
cuantos() { local n; n="$(grep -c -F -- "$1" "$2" 2>/dev/null)"; echo "${n:-0}"; }
TOTAL_FRAG=$(comandos "$RAIZ/adapters/codex/hooks.json")

# C-09 · con las cuatro integraciones apagadas no queda ninguno de sus hooks; lo demás queda, y lo dice. El de CodeGraph
# queda aunque su llave esté apagada: del lado Claude Code lo registra install-codegraph.sh sin mirarla
# shellcheck disable=SC2086
desplegar_arbol "$T/h9" $APAGADAS; RC=$?
SOBRAN=""; for h in $DE_INTEGRACION; do [ "$(cuantos "$h" "$T/h9/hooks.json")" = 0 ] || SOBRAN="$SOBRAN $h"; done
if [ "$RC" = 0 ] && [ -z "$SOBRAN" ] && [ "$(cuantos safety-guard-pre.sh "$T/h9/hooks.json")" = 1 ] \
   && [ "$(cuantos codegraph-session-hook.sh "$T/h9/hooks.json")" = 1 ] \
   && grep -q "sin registrar porque su integración está apagada:.*engram-pre-commit.sh (engram)" "$T/out9"; then
  ok "C-09 con engram, Clockify, nocturnos y buzón apagados, Codex no registra sus 9 hooks, registra el resto (también el de CodeGraph) y lo dice"
else
  mal "C-09 salida $RC; quedaron registrados:${SOBRAN:- (ninguno)}; safety-guard $(cuantos safety-guard-pre.sh "$T/h9/hooks.json") y codegraph $(cuantos codegraph-session-hook.sh "$T/h9/hooks.json") vez/veces"; tail -3 "$T/out9"
fi

# C-10 · con las cuatro prendidas, el fragmento entero, como antes
# shellcheck disable=SC2086
desplegar_arbol "$T/h10" $PRENDIDAS
N10=$(comandos "$T/h10/hooks.json")
[ "$N10" = "$TOTAL_FRAG" ] && ok "C-10 con las integraciones prendidas se registra el fragmento entero ($N10 de $TOTAL_FRAG)" \
  || mal "C-10 con las integraciones prendidas quedaron $N10 de los $TOTAL_FRAG hooks del fragmento"

# C-11 · apagar después de haber desplegado los saca del hooks.json que ya estaba, y lo propio del dev se queda
cp "$T/h10/hooks.json" "$T/h11.json"; mkdir -p "$T/h11"
node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));j.hooks.PreToolUse.push({matcher:"Bash",hooks:[{type:"command",command:"bash /home/dev/mio.sh"}]});fs.writeFileSync(process.argv[2],JSON.stringify(j));' "$T/h11.json" "$T/h11/hooks.json"
# shellcheck disable=SC2086
desplegar_arbol "$T/h11" $APAGADAS
if [ "$(cuantos engram-pre-commit.sh "$T/h11/hooks.json")" = 0 ] && [ "$(cuantos clocki/scripts/on-prompt.js "$T/h11/hooks.json")" = 0 ] \
   && [ "$(cuantos /home/dev/mio.sh "$T/h11/hooks.json")" = 1 ]; then
  ok "C-11 apagar una integración saca sus hooks del Codex ya desplegado, y el hook propio del dev se queda"
else
  mal "C-11 tras apagar: engram-pre-commit $(cuantos engram-pre-commit.sh "$T/h11/hooks.json") · on-prompt de clocki $(cuantos clocki/scripts/on-prompt.js "$T/h11/hooks.json") · el del dev $(cuantos /home/dev/mio.sh "$T/h11/hooks.json")"
fi

# C-12 · el interruptor del aplicador manda igual que del lado Claude Code: TYCON_ENGRAM_HOOK=1 registra el hook del
# commit con engram apagada (el aviso diario de engram sigue afuera: no tiene interruptor)
# shellcheck disable=SC2086
desplegar_arbol "$T/h12" $APAGADAS TYCON_ENGRAM_HOOK=1
if [ "$(cuantos engram-pre-commit.sh "$T/h12/hooks.json")" = 1 ] && [ "$(cuantos engram-drift-notice.js "$T/h12/hooks.json")" = 0 ]; then
  ok "C-12 TYCON_ENGRAM_HOOK=1 registra el hook del commit con engram apagada, como del lado Claude Code"
else
  mal "C-12 con TYCON_ENGRAM_HOOK=1: engram-pre-commit $(cuantos engram-pre-commit.sh "$T/h12/hooks.json") · engram-drift-notice $(cuantos engram-drift-notice.js "$T/h12/hooks.json")"
fi

# C-13 · la paridad Claude↔Codex espera lo MISMO que se despliega: sobre el Codex de C-09, la superficie de hooks en
# verde y diciendo cuántos no van por su integración apagada
# shellcheck disable=SC2086
PAR="$(env -u TYCON_ENGRAM_HOOK HOME="$CASA9" USERPROFILE="$CASA9" CODEX_HOME="$T/h9" $APAGADAS node -e '
  const p = require(process.argv[1]);
  const s = p.collect(p.buildCtx({ tools: ["claude", "codex"], recorded: true })).find((x) => x.name === "hooks");
  console.log(`${s.ok}|${s.detail}`);' "$RAIZ/scripts/lib/harness-parity.js" 2>&1)"
case "$PAR" in
  "true|"*"9 sin registrar por su integración apagada"*) ok "C-13 la paridad da verde la superficie de hooks y cuenta los 9 que no van ($PAR)" ;;
  *) mal "C-13 la paridad de hooks dice: $PAR" ;;
esac

# ── story 8.39: los hooks de Codex con el Node propio del arnés ─────────────────────────────────────────────────────
# Un Node del arnés de juguete en la HOME de prueba: un GUION que dice la versión de la lista y si no llama al node real
# por su ruta absoluta (nunca un enlace a un binario real), con el enlace `current`.
CASA39="$T/casa39"; NODE_V="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$RAIZ/scripts/production/node-official.json")"
nodo_de_juguete() { # <casa> [versión]
  local v="${2:-$NODE_V}"
  mkdir -p "$1/.tycon/node/versions/$v/bin"
  printf '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "%s"; exit 0; fi\nexec "%s" "$@"\n' "$v" "$(command -v node)" > "$1/.tycon/node/versions/$v/bin/node"
  chmod +x "$1/.tycon/node/versions/$v/bin/node"
  rm -f "$1/.tycon/node/current"; ln -s "versions/$v" "$1/.tycon/node/current"
}
desplegar39() { env -u TYCON_ENGRAM_HOOK -u TYCON_HOME -u TYCON_NODE_BIN HOME="$CASA39" USERPROFILE="$CASA39" CODEX_HOME="$1" node "$RAIZ/build/deploy-codex-hooks.js" > "$T/out39" 2>&1; }
mkdir -p "$CASA39"; nodo_de_juguete "$CASA39"
BIN39="$CASA39/.tycon/node/current/bin/node"

# T19 @story-8.39 @ac-7 · CodexHooks_NodeDelArnes_SeReemplazaSinDuplicar: un hooks.json con hooks del arnés en las dos
# formas y uno del dev → sólo la forma que decide el intérprete, una vez; el del dev intacto; el aviso de /hooks una vez
mkdir -p "$T/h39"
desplegar39 "$T/h39"
node -e '
const f = process.argv[1], bin = process.argv[2];
const j = JSON.parse(require("fs").readFileSync(f, "utf8"));
const g = j.hooks.SessionStart || (j.hooks.SessionStart = [{ hooks: [] }]);
const own = g.flatMap((x) => x.hooks).find((h) => h.command.startsWith(bin + " "));
if (!own) { console.error("sin hook propio"); process.exit(1); }
g.push({ hooks: [{ type: "command", command: own.command.replace(bin + " ", "node ") }, { type: "command", command: "node /home/dev/mio.js" }] });
require("fs").writeFileSync(f, JSON.stringify(j, null, 1) + "\n");' "$T/h39/hooks.json" "$BIN39" || mal "T19 no pude armar el hooks.json de partida"
ANTES39="$(grep -c "\"$BIN39 " "$T/h39/hooks.json")"
desplegar39 "$T/h39"
PROPIOS="$(grep -c "\"$BIN39 " "$T/h39/hooks.json")"; NODE_FORMA="$(grep -c '"node [^"]*/scripts/hooks/' "$T/h39/hooks.json")"
if [ "$PROPIOS" = "$ANTES39" ] && [ "$NODE_FORMA" = 0 ] && grep -q '"node /home/dev/mio.js"' "$T/h39/hooks.json"; then ok "T19 los hooks del arnés quedan una vez, con el Node del arnés ($PROPIOS); la forma node se reemplazó; el del dev quedó"
else mal "T19 propios $PROPIOS (antes $ANTES39), con node $NODE_FORMA, dev: $(grep -c mio.js "$T/h39/hooks.json")"; fi
[ "$(grep -c 'TRUST: Codex aprueba hooks POR HASH' "$T/out39")" = 1 ] && ok "T19 el aviso de aprobar con /hooks sale como mucho una vez" || mal "T19 el aviso de /hooks salió más de una vez"
# y de vuelta: sin current, todo a node, sin duplicar
rm -f "$CASA39/.tycon/node/current"; desplegar39 "$T/h39"
if [ "$(grep -c "\"$BIN39 " "$T/h39/hooks.json")" = 0 ] && [ "$(grep -c '"node [^"]*/scripts/hooks/' "$T/h39/hooks.json")" -gt 0 ]; then ok "T19 sin el Node del arnés, de vuelta a node, sin duplicar"; else mal "T19 la vuelta a node dejó $(grep -c "\"$BIN39 " "$T/h39/hooks.json") con la ruta"; fi

# T20 @story-8.39 @ac-7 @ac-16 · CodexHooks_SelloAlDia_CambiaElInterprete_Redespliega: la huella de deploy-codex-all.js
# cambia cuando aparece current y cuando se rompe, sin tocar ningún repo; la autoprueba sigue con sus cinco insumos
huella() { env -u TYCON_HOME -u TYCON_NODE_BIN HOME="$CASA39" USERPROFILE="$CASA39" node -e 'process.stdout.write(require(process.argv[1]).fingerprint())' "$RAIZ/build/deploy-codex-all.js" 2>/dev/null; }
H_SIN="$(huella)"; nodo_de_juguete "$CASA39"; H_CON="$(huella)"
printf '#!/bin/sh\nexit 1\n' > "$CASA39/.tycon/node/versions/$NODE_V/bin/node"; H_ROTO="$(huella)"
if [ -n "$H_SIN" ] && [ "$H_SIN" != "$H_CON" ] && [ "$H_CON" != "$H_ROTO" ] && [ "$(printf '%s' "$H_CON" | tr '|' '\n' | wc -l | tr -d ' ')" = 4 ]; then ok "T20 la huella cambia al aparecer current y al romperse, y sigue con cinco partes"
else mal "T20 huellas: sin «${H_SIN}» · con «${H_CON}» · roto «${H_ROTO}»"; fi
node "$RAIZ/build/deploy-codex-all.js" --selftest > "$T/self39" 2>&1 && grep -q '5 insumos' "$T/self39" && ok "T20 la autoprueba de deploy-codex-all.js sigue verde con sus 5 insumos" || mal "T20 la autoprueba de deploy-codex-all.js: $(tail -1 "$T/self39")"

# T21 @story-8.39 @ac-7 · Paridad_NodeDelArnes_SinFaltantes: con Codex desplegado con el Node del arnés, la paridad
# (corrida sin TYCON_NODE_BIN, como corre a mano o de fondo) no marca faltantes
nodo_de_juguete "$CASA39"; mkdir -p "$T/h39b"; desplegar39 "$T/h39b"
PAR39="$(env -u TYCON_ENGRAM_HOOK -u TYCON_HOME -u TYCON_NODE_BIN HOME="$CASA39" USERPROFILE="$CASA39" CODEX_HOME="$T/h39b" node -e '
  const p = require(process.argv[1]);
  const s = p.collect(p.buildCtx({ tools: ["claude", "codex"], recorded: true })).find((x) => x.name === "hooks");
  console.log(`${s.ok}|${s.detail}`);' "$RAIZ/scripts/lib/harness-parity.js" 2>&1)"
case "$PAR39" in
  "true|"*) ok "T21 la paridad de hooks en verde con el Node del arnés, sin la variable ($PAR39)" ;;
  *) mal "T21 la paridad de hooks dice: $PAR39" ;;
esac

echo "  $BIEN bien · $MAL mal"
[ "$MAL" = 0 ]
