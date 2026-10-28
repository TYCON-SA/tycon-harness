#!/usr/bin/env bash
# production-environment-alias.test.sh — el valor de `environment` del catálogo de producción en inglés.
#
# `.tycon/production.json` acepta «production» y «non-production»; «produccion» y «no-produccion» siguen valiendo. El
# índice guarda siempre los valores de antes, porque la copia del freno instalada en /opt lo lee y no conoce los nuevos
# hasta que la máquina reinstala. Un servidor declarado «production» entra a la memoria pegajosa como cualquier otro.
#
# 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la mutación que lo pone en rojo.
#
# Sin /opt ni sudo: HOME y raíz de repos de juguete, con TYCON_NO_NIGHTLY_EXAM=1.
# Correr: bash scripts/tests/production-environment-alias.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INDICE="$AQUI/scripts/production/production-index.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export TYCON_NO_NIGHTLY_EXAM=1
fallos=0; pasaron=0
ok(){ echo "✅ production-alias: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ production-alias: $1"; fallos=$((fallos+1)); }

CASA="$TMP/casa"; REPOS="$TMP/repos"
mkdir -p "$CASA/.claude/.tycon-pipeline" "$REPOS/backend-acme/.tycon"
( cd "$REPOS/backend-acme" && git -c maintenance.auto=false init -q . ) >/dev/null 2>&1
cat > "$REPOS/backend-acme/.tycon/production.json" <<'JSON'
{"servers":[{"host":"acme-sql.example.test","environment":"production","keychain":"tycon-prod-acme"},
            {"host":"acme-sql-staging.example.test","environment":"non-production"},
            {"host":"globex-sql.example.test","environment":"produccion","keychain":"tycon-prod-globex"}]}
JSON

json="$(HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" node "$INDICE" --json 2>"$TMP/err")"; rc=$?
campo(){ printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }

# T1 — 🔴 mutación: sin traducir «production», el servidor sale «mal declarado» y el índice no lo conoce.
if [ "$rc" = 0 ] && [ "$(campo 'i.hosts["acme-sql.example.test"] && i.hosts["acme-sql.example.test"].ambiente')" = "produccion" ]; then
  ok "T1 · «production» entra al índice como producción, con el valor que lee la copia de /opt"
else no "T1 · «production» no entró como producción (rc=$rc): $(head -c 300 "$TMP/err") $(campo 'JSON.stringify(i.errores)')"; fi

# T2 — 🔴 mutación: sin traducir «non-production», el servidor de staging queda desconocido y se frena.
if [ "$(campo 'i.hosts["acme-sql-staging.example.test"] && i.hosts["acme-sql-staging.example.test"].ambiente')" = "no-produccion" ]; then
  ok "T2 · «non-production» entra al índice como no-producción"
else no "T2 · «non-production» no entró como no-producción: $(campo 'JSON.stringify(i.errores)')"; fi

# T3 — 🔴 mutación: guardar el valor nuevo en el índice; la copia de /opt no lo reconocería.
if [ "$(campo 'Object.values(i.hosts).map(h=>h.ambiente).filter(a=>a!=="produccion"&&a!=="no-produccion").length')" = "0" ] \
  && [ "$(campo 'i.errores.length')" = "0" ]; then
  ok "T3 · el índice guarda sólo los valores de antes y no anota errores"
else no "T3 · el índice guardó otro valor o anotó errores: $(campo 'JSON.stringify(i.hosts)') $(campo 'JSON.stringify(i.errores)')"; fi

# T4 — 🔴 mutación: dejar afuera de la memoria lo declarado «production»; borrar el catálogo lo destaparía.
if [ "$(campo 'i.memoria.includes("acme-sql.example.test") && i.memoria.includes("globex-sql.example.test") && !i.memoria.includes("acme-sql-staging.example.test")')" = "true" ]; then
  ok "T4 · lo declarado «production» entra a la memoria pegajosa, igual que «produccion»"
else no "T4 · la memoria no trae lo declarado «production»: $(campo 'JSON.stringify(i.memoria)')"; fi

# T5 — 🔴 mutación: aceptar cualquier capitalización o una variante sin guion abriría valores que nadie documenta.
printf '{"servers":[{"host":"x.acme.test","environment":"Production","keychain":"tycon-prod-x"},{"host":"y.acme.test","environment":"nonproduction"}]}' > "$REPOS/backend-acme/.tycon/production.json"
json="$(HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" node "$INDICE" --json 2>/dev/null)"
if [ "$(campo 'i.errores.length')" = "2" ] && [ "$(campo 'Boolean(i.hosts["x.acme.test"] || i.hosts["y.acme.test"])')" = "false" ]; then
  ok "T5 · «Production» y «nonproduction» siguen siendo servidores mal declarados"
else no "T5 · una variante no documentada entró: $(campo 'JSON.stringify(i.hosts)')"; fi

echo "— production-alias: $pasaron ok, $fallos fallos —"
[ "$fallos" -eq 0 ]
