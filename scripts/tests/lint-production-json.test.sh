#!/usr/bin/env bash
# lint-production-json.test.sh — red del lint del CATÁLOGO de producción (.tycon/production.json).
#
# POR QUÉ EXISTE. Ese archivo es de dónde el freno saca qué host es producción. El lint corre en el
# pre-commit y es lo único que impide que entre malformado; sin casos propios,
# un cambio en su esquema no rompería nada visible.
#
# Un servidor con instancia nombrada en puerto no estándar declara `port`. Lo que estos casos fijan
# no es sólo que el campo se acepte: es que lo que está
# CERRADO siga cerrado — el puerto adentro del host, la instancia con barra invertida, y cualquier
# clave inventada. Es justo lo que un campo nuevo tiende a aflojar sin que nadie lo note.
#
# Las claves van en inglés (`servers`, `environment`, `keychain`, `port`); las del nombre anterior
# se siguen aceptando —los repos de producto migran aparte—, pero no las dos juntas.
#
# No toca ninguna base, ningún Llavero y ningún archivo real: sólo JSON en un temporal.
#
# Correr: bash scripts/tests/lint-production-json.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LINT="$AQUI/scripts/production/lint-production-json.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ lint-prod: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ lint-prod: $1"; fallos=$((fallos+1)); }

caso(){ # $1 = nombre, $2 = json, $3 = exit esperado (0 acepta, 1 rechaza)
  printf '%s' "$2" > "$TMP/production.json"
  node "$LINT" "$TMP/production.json" >"$TMP/out" 2>&1
  local rc=$?
  if [ "$rc" = "$3" ]; then ok "$1"
  else no "$1 (esperaba exit $3, dio $rc)"; sed 's/^/       /' "$TMP/out" | head -3; fi
}

SRV='"host":"srv.acme.test","environment":"produccion","keychain":"tycon-prod-acme"'

# ── lo que tiene que seguir entrando ─────────────────────────────────────────────────────────
caso "un servidor de siempre, sin puerto"        "{\"servers\":[{$SRV,\"base\":\"AcmeDb\"}]}"      0
caso "con puerto válido"                         "{\"servers\":[{$SRV,\"port\":1435}]}"          0
caso "puerto en el borde de abajo (1)"           "{\"servers\":[{$SRV,\"port\":1}]}"             0
caso "puerto en el borde de arriba (65535)"      "{\"servers\":[{$SRV,\"port\":65535}]}"         0
caso "un servidor de no producción, pelado"      '{"servers":[{"host":"stg.acme.test","environment":"no-produccion"}]}' 0

# ── el campo nuevo, mal puesto ───────────────────────────────────────────────────────────────
caso "puerto entre comillas"                     "{\"servers\":[{$SRV,\"port\":\"1435\"}]}"      1
caso "puerto con decimales"                      "{\"servers\":[{$SRV,\"port\":1435.5}]}"        1
caso "puerto 0"                                  "{\"servers\":[{$SRV,\"port\":0}]}"             1
caso "puerto negativo"                           "{\"servers\":[{$SRV,\"port\":-1}]}"            1
caso "puerto fuera de rango"                     "{\"servers\":[{$SRV,\"port\":70000}]}"         1
caso "puerto nulo"                               "{\"servers\":[{$SRV,\"port\":null}]}"          1

# ── 🔴 lo que el campo nuevo NO tiene que haber abierto ──────────────────────────────────────
# El host es la IDENTIDAD del servidor: con él se lo busca en el catálogo, se arma el nombre del
# servicio en el Llavero, y el freno lo reconoce en un comando. Dos escrituras del mismo servidor
# es exactamente el agujero que se evitó poniendo el puerto en su propio campo.
caso "el puerto metido en el host"               '{"servers":[{"host":"srv.acme.test,1435","environment":"produccion","keychain":"tycon-prod-acme"}]}' 1
caso "instancia con barra invertida en el host"  '{"servers":[{"host":"srv.acme.test\\sqlprod","environment":"produccion","keychain":"tycon-prod-acme"}]}' 1
caso "host con esquema"                          '{"servers":[{"host":"tcp://srv.acme.test","environment":"produccion","keychain":"tycon-prod-acme"}]}' 1
caso "una clave inventada"                       "{\"servers\":[{$SRV,\"instancia\":\"sqlprod\"}]}" 1
caso "keychain que no empieza con tycon-prod-"   '{"servers":[{"host":"srv.acme.test","environment":"produccion","keychain":"otro-llavero"}]}' 1
caso "environment que no existe"                 '{"servers":[{"host":"srv.acme.test","environment":"staging"}]}' 1
caso "el mismo host dos veces"                   "{\"servers\":[{$SRV},{$SRV}]}"                   1

# ── los nombres anteriores al renombre: se aceptan solos, nunca junto al nuevo ─────────────
# Armados por concatenación: son los nombres que se retiran.
S_OLD="servi""dores"; E_OLD="ambi""ente"; K_OLD="llave""ro"; P_OLD="puer""to"
caso "el catálogo con las claves de antes del renombre"  "{\"$S_OLD\":[{\"host\":\"srv.acme.test\",\"$E_OLD\":\"produccion\",\"$K_OLD\":\"tycon-prod-acme\",\"$P_OLD\":1435}]}" 0
caso "una clave con su nombre viejo y el nuevo"          "{\"servers\":[{$SRV,\"$K_OLD\":\"tycon-prod-acme\"}]}" 1
caso "la lista con su nombre viejo y el nuevo"           "{\"servers\":[{$SRV}],\"$S_OLD\":[]}" 1
caso "el viejo mal puesto sigue rechazándose"            "{\"$S_OLD\":[{\"host\":\"srv.acme.test\",\"$E_OLD\":\"produccion\",\"$K_OLD\":\"otro\"}]}" 1

# los dos catálogos en el mismo repo, en lo que va a quedar commiteado
R="$TMP/repo"; mkdir -p "$R/.tycon" "$R/database"
( cd "$R" && git init -q . ) >/dev/null 2>&1
printf '{"servers":[{"host":"stg.acme.test","environment":"no-produccion"}]}' > "$R/.tycon/production.json"
printf '{"servers":[{"host":"stg.acme.test","environment":"no-produccion"}]}' > "$R/.tycon/produc""cion.json"
( cd "$R" && git add .tycon ) >/dev/null 2>&1
node "$LINT" --staged --repo "$R" >"$TMP/out" 2>&1; rc=$?
if [ "$rc" = 1 ] && grep -q "los dos nombres" "$TMP/out"; then ok "el catálogo con los dos nombres en el mismo repo se rechaza"
else no "el catálogo con los dos nombres pasó (rc=$rc)"; fi

echo "— lint-prod: $pasaron ok, $fallos fallos —"
[ "$fallos" -eq 0 ]
