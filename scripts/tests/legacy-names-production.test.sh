#!/usr/bin/env bash
# legacy-names-production.test.sh — el freno de producción renombrado a inglés con
# ESCRITURA DOBLE (T49-T51).
#
# POR QUÉ ESCRITURA DOBLE Y NO UN ALIAS: la copia del freno que corre de verdad vive en /opt/tycon, de root, y sólo se
# actualiza cuando la persona reinstala con `sudo`. Hasta que TODAS las máquinas autorizadas reinstalen, en cada una
# conviven la copia vieja de /opt (lee `produccion-indice.json`, `produccion-memoria.json` y `.tycon/produccion.json`) y
# el arnés nuevo (escribe `production-*.json` y lee `.tycon/production.json`). Si el nuevo escribiera sólo los nombres
# nuevos, un servidor declarado después del renombre le quedaría invisible a la copia vieja. Por eso el índice y la
# memoria se escriben con los dos nombres, y el catálogo se lee con los dos.
#
# Qué prueba:
#   T49 — un servidor declarado con el nombre nuevo lo frena la copia VIEJA de /opt (índice fresco, y también cuando
#         la copia vieja reconstruye sola el índice: por la memoria vieja, que se sigue escribiendo).
#   T50 — el freno nuevo protege del agente los dos nombres del catálogo, del índice y de la memoria; la configuración
#         administrada pide confirmación sobre los dos; el lanzador en bash reconoce los dos.
#   T51 — con una copia instalada anterior al renombre, el aviso dice «el freno quedó viejo: reinstalalo», nunca
#         «alguien lo cambió».
#   Además: el catálogo con los dos nombres, las claves viejas, las opciones viejas del instalador y la mudanza de /opt.
#
# EL /opt DE LABORATORIO: una carpeta temporal armada con `ARCHIVOS` del commit anterior al renombre (OLD_SHA).
# Nunca /opt real ni `sudo`. HOME de juguete siempre, con TYCON_NO_NIGHTLY_EXAM=1.
# Los nombres viejos, en el código de esta prueba, se arman por concatenación.
#
# Correr: bash scripts/tests/legacy-names-production.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export TYCON_NO_NIGHTLY_EXAM=1
fallos=0; pasaron=0
ok(){ echo "✅ legacy-names-production: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ legacy-names-production: $1"; fallos=$((fallos+1)); }

# La base: el último commit de main con el freno en su carpeta vieja.
OLD_SHA=a6bae2bd95bfd7dd789ee3e219bcfa565f2ea546

# los nombres viejos, armados
P_OLD="produ""ccion"
OLD_DIR="scripts/$P_OLD"
OLD_CATALOG=".tycon/$P_OLD.json"
OLD_INDEX="$P_OLD-ind""ice.json"
OLD_MEMORY="$P_OLD-memo""ria.json"
OLD_MANAGED="tycon-$P_OLD.json"
OLD_ROOT_VAR="TYCON_PROD_RA""IZ"
OLD_SESSION_VAR="$(printf 'TYCON_PROD_%s' 'SESION_DESDE')"
OLD_NO_SUDO="--s""in-sudo"
K_SERVERS="servi""dores"; K_ENV="ambi""ente"; K_KEYCHAIN="llave""ro"

NEW_DIR="$AQUI/scripts/production"
NOTICE="$AQUI/scripts/hooks/production-notice.js"
GUARD="$AQUI/scripts/hooks/prod-access-guard.js"
SHIM="$NEW_DIR/node-shim.sh"
INSTALLER="$NEW_DIR/install-guard.sh"
TEMPLATE="$NEW_DIR/managed-settings.tycon-production.json.template"

HOST_NEW="nuevo-prod.example.com"
HOST_OLD="viejo-prod.example.com"

# ── el commit viejo tiene que estar (un clon superficial no lo trae: se trae, o NO MEDIDO) ─────────
if ! git -C "$AQUI" cat-file -e "${OLD_SHA}^{commit}" 2>/dev/null; then
  if [ "$(git -C "$AQUI" rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
    git -C "$AQUI" fetch -q --depth=2147483647 origin >/dev/null 2>&1 || true   # la historia entera
  fi
fi
if ! git -C "$AQUI" cat-file -e "${OLD_SHA}^{commit}" 2>/dev/null; then
  # La copia pública nace sin historia: ese commit no está ni va a estar, y ahí esta prueba no mide (sale 0 y lo dice: sin esto, la
  # validación de un pedido del público lo leería como un rojo nuevo en cada corrida).
  # En el repo del equipo (con su perfil) que falte el commit es «no pude medir», y eso no es un verde: sale 2.
  if [ ! -f "$AQUI/perfil-equipo.json" ]; then
    echo "⏭ legacy-names-production: NO MEDIDO — la copia pública no trae la historia del repo (el commit anterior al renombre, ${OLD_SHA:0:10}). No es un verde."
    exit 0
  fi
  echo "⏭ legacy-names-production: NO MEDIDO — no tengo el commit anterior al renombre (${OLD_SHA:0:10}) para armar la copia vieja del freno"
  exit 2
fi

# ── la copia VIEJA del freno, como la dejó instalar-freno.sh en /opt, en una raíz de laboratorio ────────────────
# $1 = raíz de laboratorio. Copia cada archivo de ARCHIVOS del commit viejo a su lugar de /opt (el mismo mapeo que
# los pasos «instalar» del instalador viejo).
old_opt(){
  local root="$1" src="$TMP/old-src"
  rm -rf "$src"; mkdir -p "$src"
  local list
  list="$(git -C "$AQUI" show "$OLD_SHA:$OLD_DIR/instalar-""freno.sh" | awk '/^ARCHIVOS=\(/{f=1;next} f&&/^\)/{f=0} f{print $1}')"
  [ -n "$list" ] || return 1
  # shellcheck disable=SC2086
  git -C "$AQUI" archive "$OLD_SHA" $list | tar -x -C "$src" || return 1
  mkdir -p "$root/opt/tycon/hooks" "$root/opt/tycon/lib" "$root/opt/tycon/$P_OLD" "$root/opt/tycon/bin" \
    "$root/Library/Application Support/ClaudeCode/managed-settings.d"
  cp "$src/scripts/hooks/prod-access-guard.js" "$root/opt/tycon/hooks/"
  cp "$src"/scripts/lib/* "$root/opt/tycon/lib/"
  cp "$src/$OLD_DIR/ind""ice-$P_OLD.js" "$src/$OLD_DIR/cargar-clave.command.template" "$root/opt/tycon/$P_OLD/"
  cp "$src/$OLD_DIR/tycon-prod-sql" "$root/opt/tycon/bin/"
  cp "$src/$OLD_DIR/node-shim.sh" "$root/opt/tycon/"
  cp "$src/$OLD_DIR/managed-settings.tycon-$P_OLD.json.template" "$root/Library/Application Support/ClaudeCode/managed-settings.d/$OLD_MANAGED"
  cp "$(command -v node)" "$root/opt/tycon/bin/node"
  printf '#!/bin/sh\nexit 0\n' > "$root/opt/tycon/bin/sqlcmd"; chmod +x "$root/opt/tycon/bin/sqlcmd"
  node -e '
    const c = require("crypto"), f = require("fs"), r = process.argv[1];
    const h = (p) => c.createHash("sha256").update(f.readFileSync(r + p)).digest("hex");
    const k = ["/opt/tycon/bin/tycon-prod-sql", "/opt/tycon/bin/node", "/opt/tycon/bin/sqlcmd", "/opt/tycon/hooks/prod-access-guard.js"];
    f.writeFileSync(r + "/opt/tycon/huellas.json", JSON.stringify(Object.fromEntries(k.map((x) => [x, h(x)])), null, 1));
  ' "$root"
}

# ── el mundo: HOME de juguete + repos con catálogo ─────────────────────────────────────────────────────────────
world(){
  CASA="$TMP/casa"; REPOS="$TMP/repos"
  rm -rf "$CASA" "$REPOS"
  mkdir -p "$CASA/.claude/.tycon-pipeline" "$REPOS/nuevo/.tycon" "$REPOS/viejo/.tycon"
  ( cd "$REPOS/nuevo" && git init -q . ) >/dev/null 2>&1
  ( cd "$REPOS/viejo" && git init -q . ) >/dev/null 2>&1
  # el catálogo nuevo, con las claves nuevas: lo declara alguien DESPUÉS del renombre
  printf '{"servers":[{"host":"%s","environment":"produccion","keychain":"tycon-prod-nuevo"}]}' "$HOST_NEW" > "$REPOS/nuevo/.tycon/production.json"
  # un producto que todavía no pasó a los nombres nuevos (los productos migran aparte)
  printf '{"%s":[{"host":"%s","%s":"produccion","%s":"tycon-prod-viejo"},{"host":"test-viejo.example.com","%s":"no-produccion"}]}' \
    "$K_SERVERS" "$HOST_OLD" "$K_ENV" "$K_KEYCHAIN" "$K_ENV" > "$REPOS/viejo/$OLD_CATALOG"
  PIPE="$CASA/.claude/.tycon-pipeline"
}

# El aviso nuevo, regenerando el índice (lo que hace cada arranque de sesión)
reindex(){ env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" TYCON_GUIDES_DIR="$AQUI" node "$NOTICE" --reindex --json >"$TMP/reindex-out" 2>&1; }

payload(){ CMD="$1" node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",hook_event_name:"PreToolUse",cwd:"/tmp",tool_input:{command:process.env.CMD}}))'; }
# $1 = hook, $2 = comando → exit code (stderr en $TMP/err)
run_guard(){ payload "$2" | env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" TYCON_PROD_SESSION_SINCE=0 "$OLD_SESSION_VAR=0" node "$1" >"$TMP/out" 2>"$TMP/err"; echo $?; }

has_host(){ node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const h=process.argv[2]; const x=d.hosts?d.hosts[h]:null; const m=(d.produccion||d.memoria||[]); process.exit((x&&x.ambiente==="produccion")||m.includes(h)?0:1)' "$1" "$2" 2>/dev/null; }

# ═════ T49 · BatchP_DoubleWrite ═════════════════════════════════════════════════════════════════════════════
world
LAB="$TMP/lab-opt"
if ! old_opt "$LAB"; then
  no "T49 · no pude armar la copia vieja del freno desde ${OLD_SHA:0:10}"
else
  OLD_GUARD="$LAB/opt/tycon/hooks/prod-access-guard.js"
  reindex
  if [ -f "$PIPE/production-index.json" ] && [ -f "$PIPE/$OLD_INDEX" ] && has_host "$PIPE/production-index.json" "$HOST_NEW" && has_host "$PIPE/$OLD_INDEX" "$HOST_NEW"; then
    ok "T49a · el índice se escribe con los dos nombres y los dos tienen el servidor declarado con el nombre nuevo"
  else no "T49a · falta un índice o el servidor nuevo — $(ls "$PIPE" | tr '\n' ' ') · $(head -c 200 "$TMP/reindex-out")"; fi

  if [ -f "$PIPE/production-memory.json" ] && [ -f "$PIPE/$OLD_MEMORY" ] && has_host "$PIPE/production-memory.json" "$HOST_NEW" && has_host "$PIPE/$OLD_MEMORY" "$HOST_NEW"; then
    ok "T49b · la memoria de producción se escribe con los dos nombres y los dos la tienen"
  else no "T49b · falta una memoria o el servidor nuevo en ella"; fi

  if cmp -s "$PIPE/production-index.json" "$PIPE/$OLD_INDEX"; then ok "T49c · los dos índices son idénticos (la copia vieja lee el mismo contenido)"
  else no "T49c · los dos índices difieren"; fi

  if has_host "$PIPE/production-index.json" "$HOST_OLD"; then ok "T49d · el catálogo con el nombre y las claves viejas se sigue leyendo"
  else no "T49d · el servidor del catálogo viejo no entró al índice"; fi

  rc="$(run_guard "$OLD_GUARD" "sqlcmd -S $HOST_NEW -Q \"select 1\"")"
  if [ "$rc" = 2 ] && grep -q "está declarado como PRODUCCIÓN" "$TMP/err"; then ok "T49e · la copia VIEJA de /opt frena como producción un servidor declarado después del renombre"
  else no "T49e · la copia vieja no lo frenó como producción (rc=$rc) — $(head -c 200 "$TMP/err")"; fi

  # la copia vieja reconstruye sola el índice (el suyo, viejo) cuando no está: no ve el catálogo nuevo, pero la memoria
  # vieja —que el arnés nuevo sigue escribiendo— lo tiene
  rm -f "$PIPE/$OLD_INDEX"
  rc="$(run_guard "$OLD_GUARD" "sqlcmd -S $HOST_NEW -Q \"select 1\"")"
  if [ "$rc" = 2 ] && grep -q "está declarado como PRODUCCIÓN" "$TMP/err" && grep -q "por memoria" "$TMP/err"; then
    ok "T49f · y cuando la copia vieja reconstruye su índice, lo frena por la memoria vieja"
  else no "T49f · al reconstruir, la copia vieja no lo frenó por memoria (rc=$rc) — $(head -c 200 "$TMP/err")"; fi

  # lo que aprendió la copia vieja por su cuenta (un host en su memoria) no se pierde en la nueva: se leen las dos
  node -e '
    const f=require("fs"), c=require("crypto"), p=process.argv[1];
    const d=JSON.parse(f.readFileSync(p,"utf8")); d.produccion=[...new Set([...d.produccion,"solo-vieja.example.com"])].sort();
    d.huella=c.createHash("sha256").update(JSON.stringify({produccion:d.produccion})).digest("hex"); f.writeFileSync(p, JSON.stringify(d,null,2));
  ' "$PIPE/$OLD_MEMORY"
  reindex
  if has_host "$PIPE/production-memory.json" "solo-vieja.example.com" && has_host "$PIPE/production-index.json" "solo-vieja.example.com"; then
    ok "T49g · la memoria nueva junta lo de la vieja (producción pegajosa entre los dos nombres)"
  else no "T49g · un host que sólo tenía la memoria vieja se perdió"; fi

  rc="$(run_guard "$GUARD" "sqlcmd -S $HOST_NEW -Q \"select 1\"")"
  if [ "$rc" = 2 ] && grep -q "está declarado como PRODUCCIÓN" "$TMP/err"; then ok "T49h · el freno nuevo también lo frena como producción"
  else no "T49h · el freno nuevo no lo frenó (rc=$rc) — $(head -c 200 "$TMP/err")"; fi
fi

# el catálogo con los dos nombres y contenido distinto: ese repo no se lee (sus hosts quedan desconocidos → frenados)
world
printf '{"servers":[{"host":"doble.example.com","environment":"no-produccion"}]}' > "$REPOS/nuevo/.tycon/production.json"
printf '{"%s":[{"host":"otro.example.com","%s":"no-produccion"}]}' "$K_SERVERS" "$K_ENV" > "$REPOS/nuevo/$OLD_CATALOG"
reindex
if node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(!d.hosts["doble.example.com"] && d.errores.some((e)=>e.repo==="nuevo") ? 0 : 1)' "$PIPE/production-index.json" 2>/dev/null; then
  ok "T49i · el catálogo con los dos nombres y contenidos distintos es un error de ese repo, no una elección callada"
else no "T49i · con los dos catálogos distintos el índice eligió uno en silencio"; fi

# claves viejas y nuevas del mismo servidor, distintas: error de ese repo
world
printf '{"servers":[{"host":"mezcla.example.com","environment":"no-produccion","%s":"produccion"}]}' "$K_ENV" > "$REPOS/nuevo/.tycon/production.json"
reindex
if node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const h=d.hosts["mezcla.example.com"]; process.exit((!h || h.ambiente==="produccion") && d.errores.length ? 0 : 1)' "$PIPE/production-index.json" 2>/dev/null; then
  ok "T49j · una clave con su nombre viejo y el nuevo, distintos, no se resuelve a «no-produccion» en silencio"
else no "T49j · la mezcla de claves se leyó como no-producción"; fi

# ═════ T50 · BatchP_GuardProtectsBothNames ══════════════════════════════════════════════════════════════════
world; reindex
for target in "$REPOS/nuevo/.tycon/production.json" "$REPOS/viejo/$OLD_CATALOG" "$PIPE/production-index.json" "$PIPE/$OLD_INDEX" "$PIPE/production-memory.json" "$PIPE/$OLD_MEMORY"; do
  name="${target#"$TMP"/}"
  rc="$(run_guard "$GUARD" "printf '{}' > $target")"
  [ "$rc" = 2 ] && ok "T50a · el freno frena escribir ${name}" || no "T50a · escribir ${name} pasó (rc=$rc)"
  rc="$(run_guard "$GUARD" "rm -f $target")"
  [ "$rc" = 2 ] && ok "T50b · el freno frena borrar ${name}" || no "T50b · borrar ${name} pasó (rc=$rc)"
done

if [ -f "$TEMPLATE" ] && node -e '
  const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const ask = ((t.permissions || {}).ask || []).join("\n");
  const need = [".tycon/production.json", ".tycon/" + process.argv[2] + ".json", "production-index.json", process.argv[3], "production-memory.json", process.argv[4]];
  const miss = need.filter((n) => !ask.includes(n));
  if (miss.length) { console.error(miss.join(", ")); process.exit(1); }
' "$TEMPLATE" "$P_OLD" "$OLD_INDEX" "$OLD_MEMORY" 2>"$TMP/tpl-err"; then
  ok "T50c · la configuración administrada pide confirmación para editar los dos nombres del catálogo, del índice y de la memoria"
else no "T50c · a la plantilla administrada le faltan reglas: $(cat "$TMP/tpl-err" 2>/dev/null)"; fi

# el filtro crudo del lanzador en bash (lo que decide cuando node no se puede correr): los dos nombres
if [ -f "$SHIM" ]; then
  eval "$(sed -n '/^nombra_bases() {/,/^}/p' "$SHIM")"
  for t in ".tycon/production.json" "$OLD_CATALOG" "production-index.json" "$OLD_INDEX" "production-memory.json" "$OLD_MEMORY"; do
    ENTRADA="{\"tool_input\":{\"command\":\"cat x/$t\"}}"
    if nombra_bases; then ok "T50d · el lanzador reconoce ${t} como algo del freno"; else no "T50d · el lanzador no reconoce ${t}"; fi
  done
  ENTRADA='{"tool_input":{"command":"git status"}}'
  if ! nombra_bases; then ok "T50e · y un comando cualquiera no"; else no "T50e · el lanzador reconoce «git status» como base"; fi
else no "T50d · no está el lanzador en su carpeta nueva ($SHIM)"; fi

# el filtro crudo del freno: un pedido ilegible que nombra el catálogo nuevo sale 2
rc="$(printf 'no es json: cat .tycon/production.json' | env HOME="$CASA" node "$GUARD" >/dev/null 2>&1; echo $?)"
[ "$rc" = 2 ] && ok "T50f · ante un pedido ilegible que nombra el catálogo nuevo, el freno frena (falla cerrado)" || no "T50f · el pedido ilegible pasó (rc=$rc)"

# ═════ T51 · BatchP_NoticeSaysStaleNotTampered ══════════════════════════════════════════════════════════════
# Un arnés de laboratorio con historia: el commit de antes del renombre y el renombre, con origin/main apuntando al
# segundo. Contra ése se juzga una copia instalada antes del renombre.
H="$TMP/arnes-lab"
rm -rf "$H"; mkdir -p "$H"
git -C "$H" init -q . && git -C "$H" config user.email lab@example.com && git -C "$H" config user.name lab
# Las bibliotecas que el aviso también compara, con la ruta que tenían en el commit viejo ("-" si no
# existían). Sin ellas en lo publicado del laboratorio, el aviso dice «no pude comparar… ni si alguien lo cambió» y el
# laboratorio deja de parecerse al arnés de verdad, que sí las publica.
LIBS="$(node -e '
  const { spawnSync } = require("child_process");
  const [notice, repo, sha] = process.argv.slice(1);
  const m = require(notice);
  const hay = (p) => spawnSync("git", ["-C", repo, "cat-file", "-e", `${sha}:${p}`]).status === 0;
  // con la ruta compartida de la que salía antes de la copia propia del freno (2026-10-14): ésa es la que trae el commit viejo
  for (const b of m.BIBLIOTECAS_DEL_FRENO) console.log(`${b.repo} ${[b.repo, ...m.rutasViejas(b.repo), ...(b.antes ? [b.antes, ...m.rutasViejas(b.antes)] : [])].find(hay) || "-"}`);
' "$NOTICE" "$AQUI" "$OLD_SHA" 2>/dev/null)"
LIBS_OLD="$(printf '%s\n' "$LIBS" | awk '$2 != "-" {print $2}')"
# shellcheck disable=SC2086
git -C "$AQUI" archive "$OLD_SHA" scripts/hooks/prod-access-guard.js "$OLD_DIR/tycon-prod-sql" "$OLD_DIR/node-shim.sh" "$OLD_DIR/managed-settings.tycon-$P_OLD.json.template" $LIBS_OLD | tar -x -C "$H"
git -C "$H" add -A >/dev/null && git -C "$H" commit -qm "antes del renombre" >/dev/null
mkdir -p "$H/scripts/production"
git -C "$H" mv "$OLD_DIR/tycon-prod-sql" scripts/production/tycon-prod-sql
git -C "$H" mv "$OLD_DIR/node-shim.sh" scripts/production/node-shim.sh
git -C "$H" mv "$OLD_DIR/managed-settings.tycon-$P_OLD.json.template" scripts/production/managed-settings.tycon-production.json.template
while read -r lib_new lib_old; do
  [ -n "$lib_new" ] && [ "$lib_old" != "-" ] && [ "$lib_old" != "$lib_new" ] && { mkdir -p "$H/$(dirname "$lib_new")"; git -C "$H" mv "$lib_old" "$lib_new"; }
done <<< "$LIBS"
for f in scripts/hooks/prod-access-guard.js scripts/production/tycon-prod-sql scripts/production/node-shim.sh scripts/production/managed-settings.tycon-production.json.template $(printf '%s\n' "$LIBS" | awk '{print $1}'); do
  [ -f "$AQUI/$f" ] && { mkdir -p "$H/$(dirname "$f")"; cp "$AQUI/$f" "$H/$f"; }
done
git -C "$H" add -A >/dev/null && git -C "$H" commit -qm "el renombre" >/dev/null
git -C "$H" update-ref refs/remotes/origin/main HEAD

# Con una HOME vacía: con la de la máquina, el aviso compara contra el clon que ella declara mantener (`paths.maintained`)
# y no contra el repo de juguete, y la copia de antes del renombre sale «alterada». Sin TYCON_HOME, que lleva al mismo clon.
STATE_HOME="$TMP/casa-estado"; mkdir -p "$STATE_HOME"
state_of(){ # $1 = archivo instalado, $2 = ruta nueva en el repo → estado según el aviso
  env -u TYCON_HOME HOME="$STATE_HOME" TYCON_GUIDES_DIR="$H" node -e '
    const m = require(process.argv[1]);
    process.stdout.write(m.estadoContraPublicado(process.argv[2], process.argv[3]));
  ' "$NOTICE" "$1" "$2" 2>"$TMP/state-err"
}
# Sin la copia vieja (un árbol que trae el commit pero no sus archivos), juzgar un archivo vacío daría «alterada»:
# eso es no haber medido, no un rojo del aviso.
old_copy="$TMP/old-tycon-prod-sql"; old_managed="$TMP/old-managed.json"
if git -C "$AQUI" show "$OLD_SHA:$OLD_DIR/tycon-prod-sql" > "$old_copy" 2>/dev/null \
  && git -C "$AQUI" show "$OLD_SHA:$OLD_DIR/managed-settings.tycon-$P_OLD.json.template" > "$old_managed" 2>/dev/null; then
s="$(state_of "$old_copy" scripts/production/tycon-prod-sql)"
[ "$s" = "vieja" ] && ok "T51a · una copia de la puerta instalada antes del renombre es «vieja», no «alterada»" || no "T51a · la copia de antes del renombre salió «${s}» — $(head -c 160 "$TMP/state-err")"
s="$(state_of "$old_managed" scripts/production/managed-settings.tycon-production.json.template)"
[ "$s" = "vieja" ] && ok "T51b · la configuración administrada de antes del renombre es «vieja»" || no "T51b · la administrada de antes del renombre salió «${s}»"
printf 'retocada\n' >> "$old_copy"
s="$(state_of "$old_copy" scripts/production/tycon-prod-sql)"
[ "$s" = "alterada" ] && ok "T51c · y una copia retocada sigue siendo «alterada» (el control no se afloja)" || no "T51c · una copia retocada salió «${s}»"
else
  echo "⏭ legacy-names-production: T51a/b/c NO MEDIDOS — el commit ${OLD_SHA:0:10} está pero no trae la copia vieja de la puerta"
  sin_medir=1
fi

# De punta a punta, con la raíz de laboratorio. El aviso la honra sólo si /opt/tycon no existe de verdad (una sesión hija
# no puede apuntarlo a una raíz falsa en una máquina con el freno): en una máquina autorizada se saltea DICIÉNDOLO y lo
# mide el nocturno, que corre sin freno instalado.
if [ -d /opt/tycon ]; then
  echo "⏭ legacy-names-production: T51d/e salteados — con el freno instalado, el aviso ignora la raíz de laboratorio; los mide el nocturno."
else
  world
  LAB2="$TMP/lab-opt-51"
  old_opt "$LAB2"
  out="$(env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" TYCON_GUIDES_DIR="$H" TYCON_PROD_ROOT="$LAB2" TYCON_PRODUCTION_AUTOINSTALL=0 node "$NOTICE" --report 2>&1)"
  if printf '%s' "$out" | grep "el freno quedó viejo: reinstalalo" >/dev/null; then ok "T51d · el aviso dice «el freno quedó viejo: reinstalalo»"
  else no "T51d · el aviso no dijo que quedó viejo — $(printf '%s' "$out" | head -c 300)"; fi
  if printf '%s' "$out" | grep "alguien lo cambió" >/dev/null; then no "T51e · el aviso dijo «alguien lo cambió» ante una copia vieja"
  else ok "T51e · y nunca «alguien lo cambió»"; fi
fi

# ═════ el instalador: opciones viejas y la mudanza de /opt ═════════════════════════════════════════════════
if [ ! -f "$INSTALLER" ]; then
  no "T49k · no está el instalador con su nombre nuevo ($INSTALLER)"
else
  out="$(env -u TYCON_PROD_ROOT bash "$INSTALLER" "$OLD_NO_SUDO" 2>&1)"; rc=$?
  if [ "$rc" != 0 ] && printf '%s' "$out" | grep -- "--no-sudo necesita TYCON_PROD_ROOT" >/dev/null; then
    ok "T49k · la opción vieja del instalador se entiende como la nueva (y el mensaje nombra la nueva)"
  else no "T49k · la opción vieja no se tradujo (rc=$rc) — $(printf '%s' "$out" | head -c 200)"; fi
  out="$(bash "$INSTALLER" --no-sudo --bogus-flag 2>&1)"; rc=$?
  [ "$rc" = 2 ] && ok "T49l · una opción desconocida sigue saliendo 2" || no "T49l · una opción desconocida salió $rc"

  # la mudanza: una máquina con la instalación vieja (carpeta y archivo administrado viejos, origen ya fijado)
  SYS="$TMP/sys-mudanza"; BIN="$TMP/bin-mudanza"
  rm -rf "$SYS" "$BIN"; mkdir -p "$BIN"
  old_opt "$SYS"
  # ── de qué clon instala T49m…p ─────────────────────────────────────────────────────────────────────────────────
  # El instalador sólo instala desde un clon cuyo `origin` sea, por https, el repo en el que confía. Corriendo sobre ESTE
  # clon, estos chequeos dependían del remoto de quien corre: desde otro repo de la misma organización (o por ssh) el
  # instalador moría por el remoto y los cuatro daban rojo sin haber medido la mudanza. Con ese origin se sigue
  # instalando desde ESTE clon, con la organización del perfil. Sin él se arma un clon de laboratorio con los archivos
  # del instalador y un origin inventado —lo que hace T19 de install-guard.test.sh— y se dice.
  URL="$(git -C "$AQUI" remote get-url origin 2>/dev/null)"
  HARNESS_T49="$AQUI"; ORG_ENV=""
  case "$URL" in https://*/tycon-claude-guides/_git/tycon-claude-guides) : ;; *) HARNESS_T49="" ;; esac
  if [ -n "$HARNESS_T49" ]; then
    ORG="$(node -e 'const p=require(process.argv[1]); const o=(p.ado||{}).org||""; process.stdout.write(o)' "$AQUI/perfil-equipo.json" 2>/dev/null)"
    case "$ORG" in https://*) ;; *) ORG="https://dev.azure.com/$ORG" ;; esac
  else
    echo "⏭ legacy-names-production: T49m…p corren sobre un clon de laboratorio con un origin de Azure DevOps inventado — el origin de este clon no es el repo en el que confía el instalador, por https (${URL:-sin remoto}). Que ESTE clon sea instalable no se midió acá."
    HARNESS_T49="$TMP/harness-t49"; ORG="https://dev.azure.com/lab-org"; ORG_ENV="$ORG"
    URL="https://dev.azure.com/lab-org/tycon-claude-guides/_git/tycon-claude-guides"
    rm -rf "$HARNESS_T49"; mkdir -p "$HARNESS_T49"
    # los archivos del instalador y, si este arnés es el del equipo, su perfil y su mapa (el instalador los exige juntos)
    for f in $(sed -n '/^ARCHIVOS=(/,/^)/p' "$INSTALLER" | grep '^  scripts/') scripts/lib/renames.json perfil-equipo.json; do
      [ -f "$AQUI/$f" ] || continue
      mkdir -p "$HARNESS_T49/$(dirname "$f")"; cp "$AQUI/$f" "$HARNESS_T49/$f"
    done
    ( cd "$HARNESS_T49" && git init -q . && git remote add origin "$URL" ) >/dev/null 2>&1
  fi
  printf '{"url":"%s","org":"%s","fijado":"2026-09-15T00:00:00Z"}' "$URL" "$ORG" > "$SYS/opt/tycon/$P_OLD/origen-de-confianza.json"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/sqlcmd"; chmod +x "$BIN/sqlcmd"
  # SIN TYCON_PROD_ACCEPT_ORIGIN: si el instalador no encuentra el origen fijado viejo, pide confirmar y muere
  out="$(env HOME="$TMP/casa-inst" PATH="$BIN:$PATH" TYCON_PROD_TEST_PATH="$BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" TYCON_PROD_NODE_LOCAL=1 \
    ${ORG_ENV:+TYCON_ADO_ORG="$ORG_ENV"} TYCON_PROD_ROOT="$SYS" TYCON_PROD_HARNESS="$HARNESS_T49" bash "$INSTALLER" --no-sudo 2>&1)"; rc=$?
  MD="$SYS/Library/Application Support/ClaudeCode/managed-settings.d"
  if [ "$rc" = 0 ] && [ -f "$SYS/opt/tycon/production/trusted-origin.json" ] && grep -q "\"$URL\"" "$SYS/opt/tycon/production/trusted-origin.json"; then
    ok "T49m · el origen fijado en la carpeta vieja pasa a la nueva sin volver a pedir confirmación"
  else no "T49m · la mudanza del origen fijado falló (rc=$rc) — $(printf '%s' "$out" | tail -3 | tr '\n' ' ')"; fi
  if [ -f "$MD/tycon-production.json" ] && [ ! -f "$MD/$OLD_MANAGED" ] && ls "$MD" | grep "^$OLD_MANAGED.bak-" >/dev/null; then
    ok "T49n · el archivo administrado pasa al nombre nuevo, el viejo queda respaldado y sale (el freno no se registra dos veces)"
  else no "T49n · archivo administrado: $(ls "$MD" | tr '\n' ' ')"; fi
  if [ ! -e "$SYS/opt/tycon/$P_OLD" ] && [ -f "$SYS/opt/tycon/production/production-index.js" ] && [ -f "$SYS/opt/tycon/production/load-key.command.template" ]; then
    ok "T49o · /opt/tycon queda con su carpeta nueva y sin la vieja"
  else no "T49o · /opt/tycon: $(ls "$SYS/opt/tycon" | tr '\n' ' ')"; fi
  if printf '{"tool_name":"Bash","tool_input":{"command":"sqlcmd -S %s -Q \\"select 1\\""}}' "$HOST_NEW" \
       | env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" node "$SYS/opt/tycon/hooks/prod-access-guard.js" >/dev/null 2>&1; then
    no "T49p · el freno instalado por el instalador nuevo dejó pasar un servidor de producción"
  else ok "T49p · el freno instalado por el instalador nuevo carga y frena (su índice está en la carpeta nueva)"; fi
fi

# ═════ ~/.claude/tycon.json: las secciones con su nombre nuevo y el viejo (la copia de tycon-config.js en /opt) ═
CFG_HOME="$TMP/casa-cfg"; mkdir -p "$CFG_HOME/.claude"
cfg(){ # $1 = contenido de tycon.json → «valor de paths.repos|valor de integrations.engram|errores»
  printf '%s' "$1" > "$CFG_HOME/.claude/tycon.json"
  # Sin TF_BUILD: en Azure, leer una clave vieja escribe el warning de la corrida en stderr, y acá stderr se suma a la
  # salida que se compara (T49r daría rojo sólo en el nocturno). El warning tiene su propia prueba.
  env -u TYCON_REPOS_ROOT -u TF_BUILD HOME="$CFG_HOME" node -e '
    const c = require(process.argv[1]).cargar({ env: { TYCON_PROFILE: "0" }, home: process.argv[2] });
    process.stdout.write(`${c.valores.rutas.repos || ""}|${c.valores.integraciones.engram}|${c.errores.map((e) => e.clave + " " + e.motivo).join(" / ")}`);
  ' "$AQUI/scripts/lib/tycon-config.js" "$CFG_HOME" 2>&1
}
R_OLD="ru""tas"; I_OLD="integra""ciones"
s="$(cfg '{"paths":{"repos":"/tmp/repos-nuevo"},"integrations":{"engram":true}}')"
[ "$s" = "/tmp/repos-nuevo|true|" ] && ok "T49q · tycon.json con las secciones en inglés (paths, integrations) se lee" || no "T49q · paths/integrations: «${s}»"
s="$(cfg "{\"$R_OLD\":{\"repos\":\"/tmp/repos-viejo\"},\"$I_OLD\":{\"engram\":true}}")"
[ "$s" = "/tmp/repos-viejo|true|" ] && ok "T49r · y con sus nombres de antes del renombre, igual (la copia de /opt de una máquina que no reinstaló)" || no "T49r · rutas/integraciones: «${s}»"
s="$(cfg "{\"paths\":{\"repos\":\"/tmp/a\"},\"$R_OLD\":{\"repos\":\"/tmp/b\"}}")"
case "$s" in *"paths"*"valores distintos"*) ok "T49s · la misma sección con los dos nombres y valores distintos es un error que nombra la nueva" ;; *) no "T49s · los dos nombres distintos: «${s}»" ;; esac
s="$(cfg "{\"$I_OLD\":{\"engram\":\"si\"}}")"
case "$s" in *"$I_OLD.engram"*) ok "T49t · el error nombra la sección como la escribió la persona" ;; *) no "T49t · el error no nombra lo escrito: «${s}»" ;; esac

# ═════ casos de borde: cada uno con su prueba ═══════════════════════════════════════════════════════════════
IDX="$NEW_DIR/production-index.js"
mem_case(){ # $1 = script node que prepara el estado en $CASA y deja el catálogo; imprime «estado|alterada» de un host
  node -e "$1" "$IDX" "$CASA" "$REPOS" 2>&1
}
# Las dos memorias ilegibles: se recupera del índice
world
printf '{"servers":[{"host":"b.example.com","environment":"produccion","keychain":"tycon-prod-b"}]}' > "$REPOS/nuevo/.tycon/production.json"
s="$(mem_case '
  const m = require(process.argv[1]); const fs = require("fs"); const [, , home, raiz] = process.argv;
  m.guardar(m.construir({ home, raiz }), home);
  fs.writeFileSync(`${raiz}/nuevo/.tycon/production.json`, JSON.stringify({ servers: [{ host: "b.example.com", environment: "no-produccion" }] }));
  fs.writeFileSync(m.rutaMemoria(home), "{"); fs.writeFileSync(m.rutaMemoriaVieja(home), "{");
  const i = m.construir({ home, raiz }); process.stdout.write(`${m.clasificar("b.example.com", i).estado}|${i.memoria_alterada}`);
')"
[ "$s" = "produccion|true" ] && ok "5B-C1a · con las dos memorias ilegibles, el host de producción se recupera del índice (y se dice alterada)" || no "5B-C1a · memorias ilegibles: «${s}»"
# La memoria vieja (la que escribe la copia de /opt) borrada, con un host que la nueva no tiene: se recupera
world
s="$(mem_case '
  const m = require(process.argv[1]); const fs = require("fs"); const [, , home, raiz] = process.argv;
  const P = "produ" + "ccion";
  fs.writeFileSync(`${raiz}/nuevo/.tycon/production.json`, JSON.stringify({ servers: [{ host: "a.example.com", environment: "produccion", keychain: "tycon-prod-a" }] }));
  m.guardar(m.construir({ home, raiz }), home);
  // la copia vieja aprendió B: su índice y su memoria lo tienen; la nueva no
  const vi = JSON.parse(fs.readFileSync(m.rutaIndiceVieja(home), "utf8")); vi.memoria = ["a.example.com", "b.example.com"];
  fs.writeFileSync(m.rutaIndiceVieja(home), JSON.stringify(vi));
  fs.writeFileSync(`${raiz}/nuevo/.tycon/production.json`, JSON.stringify({ servers: [{ host: "b.example.com", environment: "no-produccion" }] }));
  fs.unlinkSync(m.rutaMemoriaVieja(home));
  const i = m.construir({ home, raiz }); process.stdout.write(`${m.clasificar("b.example.com", i).estado}|${i.memoria_alterada}`);
')"
[ "$s" = "produccion|true" ] && ok "5B-C1b · con la memoria vieja borrada, lo que aprendió la copia vieja vuelve del índice viejo (y se dice alterada)" || no "5B-C1b · memoria vieja borrada: «${s}»"
# Las dos memorias borradas: se une la memoria de LOS DOS índices, no la del primero no vacío
world
s="$(mem_case '
  const m = require(process.argv[1]); const fs = require("fs"); const [, , home, raiz] = process.argv;
  fs.writeFileSync(`${raiz}/nuevo/.tycon/production.json`, JSON.stringify({ servers: [{ host: "a.example.com", environment: "produccion", keychain: "tycon-prod-a" }] }));
  m.guardar(m.construir({ home, raiz }), home);
  const vi = JSON.parse(fs.readFileSync(m.rutaIndiceVieja(home), "utf8")); vi.memoria = ["a.example.com", "b.example.com"];
  fs.writeFileSync(m.rutaIndiceVieja(home), JSON.stringify(vi));
  fs.writeFileSync(`${raiz}/nuevo/.tycon/production.json`, JSON.stringify({ servers: [{ host: "b.example.com", environment: "no-produccion" }] }));
  fs.unlinkSync(m.rutaMemoria(home)); fs.unlinkSync(m.rutaMemoriaVieja(home));
  const i = m.construir({ home, raiz }); process.stdout.write(`${m.clasificar("b.example.com", i).estado}|${i.memoria_alterada}`);
')"
[ "$s" = "produccion|true" ] && ok "5B-C2 · con las dos memorias borradas, se juntan las memorias de los dos índices" || no "5B-C2 · memorias borradas: «${s}»"
# Un comodín `product*` cualquiera no es un archivo del freno; `production-*` en su carpeta sí
world; reindex
for cmd in "cp fixtures/product*.json out/" "rm -f build/product*" "mv product* archive/"; do
  rc="$(run_guard "$GUARD" "$cmd")"
  [ "$rc" = 0 ] && ok "5B-C3 · el freno deja pasar «${cmd}»" || no "5B-C3 · el freno frenó «${cmd}» (rc=$rc)"
done
rc="$(run_guard "$GUARD" "rm -f $PIPE/production-*")"
[ "$rc" = 2 ] && ok "5B-C3 · y sigue frenando un comodín sobre los estados del freno" || no "5B-C3 · el comodín sobre production-* pasó (rc=$rc)"
# `get` acepta el nombre que se ve en el archivo y en `explicar`
printf '{"paths":{"repos":"/tmp/repos-get"},"integrations":{"engram":true}}' > "$CFG_HOME/.claude/tycon.json" 2>/dev/null || { mkdir -p "$TMP/casa-cfg/.claude"; CFG_HOME="$TMP/casa-cfg"; printf '{"paths":{"repos":"/tmp/repos-get"},"integrations":{"engram":true}}' > "$CFG_HOME/.claude/tycon.json"; }
g1="$(env -u TYCON_REPOS_ROOT HOME="$CFG_HOME" TYCON_PROFILE=0 node "$AQUI/scripts/lib/tycon-config.js" get paths.repos 2>&1)"; r1=$?
g2="$(env HOME="$CFG_HOME" TYCON_PROFILE=0 node "$AQUI/scripts/lib/tycon-config.js" get integrations.engram 2>&1)"; r2=$?
{ [ "$r1" = 0 ] && [ "$g1" = "/tmp/repos-get" ] && [ "$r2" = 0 ]; } && ok "5B-C4 · tycon-config get entiende paths.* e integrations.*" || no "5B-C4 · get: «${g1}» ($r1) · «${g2}» ($r2)"
# Las dos formas de una sección con el mismo contenido en otro orden no son «valores distintos»
s="$(cfg "{\"integrations\":{\"engram\":true,\"codex\":false},\"$I_OLD\":{\"codex\":false,\"engram\":true}}")"
[ "$s" = "|true|" ] && ok "5B-C6 · el mismo contenido en otro orden no es un conflicto" || no "5B-C6 · mismo contenido, otro orden: «${s}»"
# Si el registro viejo no se puede pasar al nuevo, no se escribe el nuevo (se pierde la historia) — sigue en el viejo
world; reindex
OLD_LOG="$PIPE/$P_OLD.log"; printf '{"ts":"antes"}\n' > "$OLD_LOG"; chmod 200 "$OLD_LOG"
rc="$(run_guard "$GUARD" "sqlcmd -S $HOST_NEW -Q \"select 1\"")"
chmod 600 "$OLD_LOG"
if [ "$rc" = 2 ] && [ ! -e "$PIPE/production.log" ] && [ "$(wc -l < "$OLD_LOG" | tr -d ' ')" = 2 ]; then
  ok "5B-C7 · con el registro viejo ilegible, el freno no arranca uno nuevo sin historia: anota en el viejo"
else no "5B-C7 · registro: rc=$rc · nuevo $( [ -e "$PIPE/production.log" ] && echo existe || echo no) · viejo $(wc -l < "$OLD_LOG" | tr -d ' ') líneas"; fi
world; reindex
printf '{"ts":"antes"}\n' > "$PIPE/$P_OLD.log"
rc="$(run_guard "$GUARD" "sqlcmd -S $HOST_NEW -Q \"select 1\"")"
{ [ "$(head -1 "$PIPE/production.log" 2>/dev/null)" = '{"ts":"antes"}' ] && [ "$(wc -l < "$PIPE/production.log" | tr -d ' ')" = 2 ]; } \
  && ok "5B-C7 · y legible, el nuevo arranca con la historia del viejo y la línea nueva" || no "5B-C7 · el nuevo no trae la historia: $(head -c 120 "$PIPE/production.log" 2>/dev/null)"

# ═════ --stale-mentions aprende los kinds (folder, file, state-file, config-file, key) ═════════════════════
out="$(node -e '
  const s = require(process.argv[1]);
  const P = "produ" + "ccion";
  const entries = [
    { kind: "folder", old: `scripts/${P}`, new: "scripts/production" },
    { kind: "file", old: `scripts/${P}/indice-${P}.js`, new: "scripts/production/production-index.js" },
    { kind: "state-file", old: `~/.claude/.tycon-pipeline/${P}-indice.json`, new: "~/.claude/.tycon-pipeline/production-index.json" },
    { kind: "config-file", old: `.tycon/${P}.json`, new: ".tycon/production.json" },
    { kind: "key", old: "llave" + "ro", new: "keychain", where: ".tycon/production.json" },
  ];
  const paths = s.pathMatchers(entries); const keys = s.keyMatchers(entries);
  const hit = (text) => [...paths.filter((p) => p.res.some((r) => r.test(text))).map((p) => p.e.kind),
    ...keys.filter((k) => k.names.some((n) => text.includes(n)) && k.res.some((r) => r.test(text))).map((k) => k.e.kind)].sort().join(",");
  const casos = [
    [`node scripts/${P}/algo.js`, "folder"],
    [`ver scripts/${P}-otra/x.js`, ""],
    [`node indice-${P}.js --report`, "file"],
    [`mi-indice-${P}.js`, ""],
    [`rm ~/.claude/.tycon-pipeline/${P}-indice.json`, "state-file"],
    [`declaralo en .tycon/${P}.json`, "config-file"],
    [`en .tycon/${P}.json: {"${"llave" + "ro"}": "x"}`, "config-file,key"],
    [`{"${"llave" + "ro"}": "x"} en un archivo que no nombra el catálogo`, ""],
    [`la palabra ${"llave" + "ro"} suelta en .tycon/production.json es prosa`, ""],
  ];
  const mal = casos.filter(([t, want]) => hit(t) !== want).map(([t, want]) => `«${t}» dio «${hit(t)}», esperaba «${want}»`);
  const lectores = ["scripts/hooks/prod-access-guard.js", "scripts/production/managed-settings.tycon-production.json.template"].filter((f) => !s.LEGACY_READERS.has(f));
  process.stdout.write(mal.concat(lectores.map((f) => `falta en LEGACY_READERS: ${f}`)).join("\n"));
' "$AQUI/scripts/publishing/spanish-names.js" 2>&1)"
[ -z "$out" ] && ok "T50g · --stale-mentions reconoce carpeta, archivo, estado, catálogo y clave con su nombre viejo, sin marcar pedazos de otro nombre ni prosa" \
  || no "T50g · --stale-mentions: $out"

echo
echo "legacy-names-production: $pasaron pasaron · $fallos fallaron"
[ "$fallos" -eq 0 ] || exit 1
[ -z "${sin_medir:-}" ] || exit 2
