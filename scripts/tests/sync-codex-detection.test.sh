#!/usr/bin/env bash
# Prueba de cómo sync-claude-md-blocks.sh decide si mantiene el espejo de Codex.
#
# 🔴 POR QUÉ EXISTE (2026-09-04). El lado Codex se mantenía SÓLO con la variable de entorno
# TYCON_CODEX=1. Esa variable vive en el rc del shell del dev, y el sincronizado corre desde el
# arranque de sesión, que NO lee ese rc: la llave existía para el dev y no para el proceso que hace
# el trabajo. Medido ese día: la llave estaba puesta (línea 162 del .zshrc) y el AGENTS.md llevaba
# CINCO DÍAS sin actualizar, con el bloque de estilo viejo de 16.833 caracteres mientras el de
# Claude tenía 6.352. Nada avisaba: el espejo se congeló en silencio.
#
# El arreglo: la señal deja de depender del entorno. Si el AGENTS.md YA EXISTE con bloques del
# arnés, esta máquina usa Codex y el espejo se mantiene, haya o no variable. La variable sigue
# valiendo para estrenar el espejo en una máquina donde todavía no existe.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SYNC="$AQUI/scripts/setup/sync-claude-md-blocks.sh"
# La ruta vieja del guion, armada del mapa (nunca escrita a mano: es la que traen las marcas de cada máquina).
# La copia pública no lleva el mapa (nace con los nombres nuevos): ahí no hay marcas viejas que probar y el caso 4 se
# saltea con constancia; el resto usa la marca con la ruta de hoy.
MAPA="$AQUI/scripts/lib/renames.json"
VIEJA=""
if [ -f "$MAPA" ]; then
  VIEJA="$(node -e 'const e=require(process.argv[1]).entries.find((x)=>x.new==="scripts/setup/sync-claude-md-blocks.sh");process.stdout.write(e?e.old:"")' "$MAPA" 2>/dev/null)"
  [ -n "$VIEJA" ] || { echo "❌ sync-codex: el mapa no trae la ruta vieja de sync-claude-md-blocks.sh"; exit 1; }
fi
MARCA_VIEJA="<!-- TYCON_BLOCK:response-style START — generado por tycon-claude-guides/${VIEJA:-scripts/setup/sync-claude-md-blocks.sh} · NO EDITAR A MANO (se pisa en el próximo SessionStart); editá claude-md-blocks/response-style.md y commiteá -->"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
ok(){ echo "✅ sync-codex: $1"; }
no(){ echo "❌ sync-codex: $1"; fallos=$((fallos+1)); }
fallos=0
BLK="$AQUI/claude-md-blocks/response-style.md"
[ -f "$BLK" ] || { echo "⚠️ sin bloque de referencia — salteado"; exit 0; }
marca(){ grep -c 'TYCON_BLOCK:response-style START' "$1" 2>/dev/null || echo 0; }

corre(){ CLAUDE_MD_PATH="$TMP/CLAUDE.md" CODEX_AGENTS_MD_PATH="$TMP/AGENTS.md" \
         TYCON_CODEX="${1:-}" bash "$SYNC" >/dev/null 2>&1; }

# ── 1. 🔴 EL CASO REAL: el espejo ya existe con bloques y NO hay variable → se mantiene igual
: > "$TMP/CLAUDE.md"
printf '%s\n%s\n%s\n' "$(head -c 200 /dev/zero | tr '\0' '#')" \
  "$MARCA_VIEJA" \
  "VIEJO
<!-- TYCON_BLOCK:response-style END -->" > "$TMP/AGENTS.md"
corre ""
if grep -q 'VIEJO' "$TMP/AGENTS.md"; then
  no "🔴 el espejo de Codex ya existía y quedó SIN actualizar sin la variable (es el caso que congeló 5 días)"
else
  ok "🔴 un espejo de Codex que ya existe se mantiene aunque no esté la variable de entorno"
fi

# ── 2. …y una máquina SIN espejo no lo estrena sola: ahí sí hace falta la variable
rm -f "$TMP/AGENTS.md"; : > "$TMP/CLAUDE.md"
corre ""
[ ! -f "$TMP/AGENTS.md" ] && ok "sin espejo previo y sin variable, no se crea uno (no se le impone Codex a nadie)" \
  || no "creó un AGENTS.md en una máquina que no usa Codex"

# ── 3. con la variable, sí lo estrena
rm -f "$TMP/AGENTS.md"; : > "$TMP/CLAUDE.md"
corre "1"
[ "$(marca "$TMP/AGENTS.md")" = "1" ] && ok "con la variable, el espejo se estrena" || no "con la variable no lo creó"

# ── 4. T15 R1_SyncBlocks_OldMarkersRewrittenOnce (story 8.12, AC 12): las marcas que cada máquina ya tiene nombran
# la ruta vieja del guion ($VIEJA, del mapa). Se reconocen por su prefijo y la corrida siguiente las reescribe con la
# ruta nueva (scripts/setup/), sin duplicar el bloque; una segunda corrida no cambia nada.
if [ -z "$VIEJA" ]; then
  echo "⏭ sync-codex: NO MEDIDO — T15: copia pública sin el mapa de renombres (no hay marcas viejas que reescribir)"
else
  rm -f "$TMP/AGENTS.md"
  printf '%s\n%s\n%s\n' "# lo mío" \
    "$MARCA_VIEJA" \
    "VIEJO
<!-- TYCON_BLOCK:response-style END -->" > "$TMP/CLAUDE.md"
  corre ""
  if [ "$(marca "$TMP/CLAUDE.md")" = "1" ] && grep -q 'scripts/setup/sync-claude-md-blocks.sh' "$TMP/CLAUDE.md" \
     && ! grep -qF "tycon-claude-guides/$VIEJA " "$TMP/CLAUDE.md" && ! grep -q 'VIEJO' "$TMP/CLAUDE.md" \
     && grep -q '^# lo mío$' "$TMP/CLAUDE.md"; then
    ok "T15 una marca con la ruta vieja se reescribe con la nueva, una sola vez y sin tocar lo del dev"
  else
    no "T15 la marca vieja no quedó reescrita una sola vez con la ruta nueva"
  fi
  cp "$TMP/CLAUDE.md" "$TMP/CLAUDE.antes"
  corre ""
  cmp -s "$TMP/CLAUDE.md" "$TMP/CLAUDE.antes" && ok "T15 la segunda corrida no cambia nada" || no "T15 la segunda corrida volvió a cambiar el archivo"
fi

# ── 5. T21 Applier_NoLegacyBakUnderHarness_YesStandalone (story 8.13, tanda B, AC 18): lanzado por harness.js
# (TYCON_HARNESS_SNAPSHOT_DIR puesta) el sync no deja sus .bak de CLAUDE.md ni del espejo AGENTS.md —la copia la tomó el
# mecanismo antes—; suelto, como hoy, deja los dos. La parte del aplicador .sh está en harness-uninstall.test.sh.
t21_seed(){ rm -f "$TMP"/*.bak.* "$TMP/AGENTS.md"; printf '# lo mío\n' > "$TMP/CLAUDE.md"
  printf '# de Codex\n%s\nVIEJO\n<!-- TYCON_BLOCK:response-style END -->\n' "$MARCA_VIEJA" > "$TMP/AGENTS.md"; }
t21_list_baks(){ find "$TMP" -maxdepth 1 -name '*.bak.*' | sed "s|$TMP/||" | LC_ALL=C sort | tr '\n' ' '; }
t21_seed
CLAUDE_MD_PATH="$TMP/CLAUDE.md" CODEX_AGENTS_MD_PATH="$TMP/AGENTS.md" TYCON_CODEX="" TYCON_HARNESS_SNAPSHOT_DIR="$TMP/copia" \
  bash "$SYNC" >/dev/null 2>&1
B="$(t21_list_baks)"
if [ -z "$B" ] && grep -q 'TYCON_BLOCK:response-style START' "$TMP/CLAUDE.md" && ! grep -q 'VIEJO' "$TMP/AGENTS.md"; then
  ok "T21 bajo harness.js el sync actualiza CLAUDE.md y el espejo sin dejar .bak"
else
  no "T21 bajo harness.js el sync dejó .bak («${B}») o no actualizó"
fi
t21_seed
CLAUDE_MD_PATH="$TMP/CLAUDE.md" CODEX_AGENTS_MD_PATH="$TMP/AGENTS.md" TYCON_CODEX="" TYCON_HARNESS_SNAPSHOT_DIR="" \
  bash "$SYNC" >/dev/null 2>&1
B="$(t21_list_baks)"
[[ "$B" == *AGENTS.md.bak.*CLAUDE.md.bak.* ]] && ok "T21 suelto el sync deja el .bak de CLAUDE.md y el del espejo, como hoy" \
  || no "T21 suelto faltan los .bak: quedaron «${B}»"

# ── 6. T21 los .ps1 por lectura (sin máquina Windows): cada copia .bak.<ts> que escriben el aplicador y el sync de Windows
# está detrás de TYCON_HARNESS_SNAPSHOT_DIR (el settings.json del aplicador; CLAUDE.md y el espejo del sync). Desde la
# story 8.17 (W3) el .ps1 ya no escribe settings.json: lo escribe scripts/setup/apply-hooks.js, que se mira abajo.
if python3 - "$AQUI/scripts/install-tycon-hooks.ps1" "$AQUI/scripts/setup/sync-claude-md-blocks.ps1" <<'PY'
import re, sys
want = {sys.argv[1]: 0, sys.argv[2]: 2}
bad = []
for path, n in want.items():
    lines = open(path, encoding="utf-8").read().split("\n")
    sites = [i for i, l in enumerate(lines) if re.search(r'\.bak\.\$', l) and not l.lstrip().startswith("#")]
    if len(sites) != n:
        bad.append("%s: esperaba %d sitios que arman un .bak.<ts> y hay %d" % (path, n, len(sites)))
    for i in sites:
        if not any("TYCON_HARNESS_SNAPSHOT_DIR" in l for l in lines[max(0, i - 3):i + 1]):
            bad.append("%s:%d arma un .bak sin mirar TYCON_HARNESS_SNAPSHOT_DIR" % (path, i + 1))
for b in bad:
    print("   " + b)
sys.exit(1 if bad else 0)
PY
then ok "T21 los .ps1 (instalador y sync) sólo escriben sus .bak sin TYCON_HARNESS_SNAPSHOT_DIR"
else no "T21 un .ps1 escribe su .bak también bajo harness.js"; fi
# …y el aplicador de settings.json (el de los dos instaladores): una sola copia, detrás de la variable
if node -e '
  const t = require("fs").readFileSync(process.argv[1], "utf8");
  const sites = t.split("\n").map((l, i) => [l, i]).filter(([l]) => /\.bak\.\$\{/.test(l) && !/^\s*(\/\/|\*)/.test(l));
  const guarded = sites.every(([, i]) => t.split("\n").slice(Math.max(0, i - 4), i + 1).some((l) => l.includes("TYCON_HARNESS_SNAPSHOT_DIR")));
  process.exit(sites.length === 1 && guarded ? 0 : 1);' "$AQUI/scripts/setup/apply-hooks.js"
then ok "T21 el aplicador (apply-hooks.js) sólo escribe el .bak de settings.json sin TYCON_HARNESS_SNAPSHOT_DIR"
else no "T21 el aplicador (apply-hooks.js) escribe el .bak de settings.json también bajo harness.js, o en más de un lugar"; fi

echo "─────────────"
[ "$fallos" -eq 0 ] && { echo "✅ sync-codex-deteccion: todo verde"; exit 0; } || { echo "❌ sync-codex-deteccion: $fallos falla(s)"; exit 1; }
