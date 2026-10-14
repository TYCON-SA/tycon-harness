#!/usr/bin/env bash
# harness-map-public.test.sh — la versión pública del mapa del arnés se deriva de la privada (2026-09-15).
#
# Lo que se protege: que la pública (la del sitio abierto) diga lo mismo que la privada sin llevar nada interno, y que
# ninguna de las dos se separe de la otra sin que nadie se entere. Cada caso trabaja sobre copias en un directorio
# temporal; nunca toca los archivos del repo.
#
# El código (scripts/tools/harness-map/) vive en el repo público; el mapa interno (artifacts/mapa-arnes.html), su
# configuración pública (scripts/tools/harness-map/publica.json) y el sitio con su selector de idioma
# (onboarding/mini-class/), en el repo del equipo. Por eso los casos del generador corren sobre un mapa de JUGUETE con la
# misma forma (scripts/tests/fixtures/harness-map/: internal-map.html, public-config.json e i18n/inject.js, datos inventados), y los
# que miden el mapa de verdad (R-xx) corren sólo donde está: en el árbol del equipo, con lo público encima. Sin él dicen
# «NO MEDIDO» y no cuentan como verde.
set -uo pipefail

RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
# el mapa del arnés vive en scripts/tools/harness-map/ desde la story 8.12, tanda R4
HMAP="scripts/tools/harness-map"
GEN="$RAIZ/$HMAP/public-version.js"
# el mapa de juguete
FIX="$RAIZ/scripts/tests/fixtures/harness-map"
FPRIV="$FIX/internal-map.html"
FCFG="$FIX/public-config.json"
FI18N="$FIX/i18n/inject.js"
# el mapa de verdad, si este árbol lo trae
PRIV="$RAIZ/artifacts/mapa-arnes.html"
CFG="$RAIZ/$HMAP/publica.json"
# la pública vive con la mini-clase en onboarding/mini-class/ desde la story 8.9, tanda F
PUBDIR="onboarding/mini-class"
PUB="$RAIZ/$PUBDIR/mapa-del-arnes.html"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BIEN=0; MAL=0; SIN=0
ok()  { echo "  ✓ $1"; BIEN=$((BIEN + 1)); }
mal() { echo "  ✗ $1"; MAL=$((MAL + 1)); }
sin_medir() { echo "  ⚠️   — $1 NO MEDIDO: este árbol no trae el mapa interno (artifacts/mapa-arnes.html, del repo del equipo). No es un verde."; SIN=$((SIN + 1)); }
REAL=0; [ -f "$PRIV" ] && [ -f "$CFG" ] && [ -f "$PUB" ] && REAL=1

# editar-ficha <archivo> <id> <campo> <texto>  (texto vacío = borrar la ficha entera; campo "+" = agregar ficha nueva)
editar_ficha() {
  node -e '
    const fs = require("fs");
    const [archivo, id, campo, texto] = process.argv.slice(1);
    let s = fs.readFileSync(archivo, "utf8");
    const M = "const D = ", i = s.indexOf(M), f = s.indexOf("\n};\n", i);
    const D = JSON.parse(s.slice(i + M.length, f + 2));
    if (campo === "+") D[id] = { capa: "Prueba", nombre: texto, por: "x", lugar: "dev", donde: "", cuando: "x", archivos: [["tcg", "scripts/x.js"]] };
    else if (!texto) delete D[id];
    else D[id][campo] = texto;
    const b = "{\n" + Object.entries(D).map(([k, v]) => "  " + JSON.stringify(k) + ": " + JSON.stringify(v)).join(",\n") + "\n}";
    fs.writeFileSync(archivo, s.slice(0, i + M.length) + b + s.slice(f + 2));
  ' "$@"
}

# correr [opciones]: genera la pública del mapa de juguete copiado en $TMP/priv.html
correr() { node "$GEN" --input "$TMP/priv.html" --config "$FCFG" --i18n "$FI18N" --output "$TMP/pub.html" "$@" >"$TMP/out" 2>&1; echo $?; }

echo "harness-map-public"

# C-01 · del mapa de juguete sale un documento completo: los textos públicos puestos, lo interno quitado, el selector de
# idioma incrustado para la página del mapa, y nada de lo prohibido.
cp "$FPRIV" "$TMP/priv.html"
rc=$(correr)
if [ "$rc" = 0 ] && head -1 "$TMP/pub.html" | grep -i '^<!doctype html>' >/dev/null && grep -q 'Una única máquina designada.' "$TMP/pub.html" \
   && grep -q '"admin": "Una máquina designada"' "$TMP/pub.html" && grep -q 'idioma de prueba: map' "$TMP/pub.html" \
   && ! grep -qE 'servidor-acme|admin del arnés|>ADMIN<|acme-harness-interno|03:30|prefers-color-scheme: dark' "$TMP/pub.html"; then
  ok "C-01 la pública sale completa, con sus textos y sin nada interno"
else
  mal "C-01 la pública del mapa de juguete no salió bien (rc=$rc)"; cat "$TMP/out"
fi

# C-02 · algo interno que aparece en un texto sin versión pública frena la generación y dice qué.
cp "$FPRIV" "$TMP/priv.html"
editar_ficha "$TMP/priv.html" prompt por "Corre en el servidor-acme-02 a las 02:00."
rc=$(correr)
[ "$rc" = 2 ] && grep -q "quedaría algo interno" "$TMP/out" && ok "C-02 una máquina o un horario nuevo en la privada no llega a la pública" || { mal "C-02 se filtró algo interno (rc=$rc)"; cat "$TMP/out"; }

# C-03 · si la privada cambia un texto que tiene versión pública, frena y nombra la ficha.
cp "$FPRIV" "$TMP/priv.html"
editar_ficha "$TMP/priv.html" examen donde "Otra máquina, otro horario."
rc=$(correr)
[ "$rc" = 2 ] && grep -q "examen.donde" "$TMP/out" && ok "C-03 un texto público viejo frena y dice cuál revisar" || { mal "C-03 el texto público viejo pasó (rc=$rc)"; cat "$TMP/out"; }

# C-04 · un componente nuevo en la privada llega solo a la pública, sin sus archivos.
cp "$FPRIV" "$TMP/priv.html"
editar_ficha "$TMP/priv.html" componente-nuevo + "Componente de prueba"
rc=$(correr)
if [ "$rc" = 0 ] && grep -q "Componente de prueba" "$TMP/pub.html" && grep -q 'scripts/x.js' "$TMP/pub.html"; then
  ok "C-04 lo nuevo de la privada aparece en la pública, con su archivo"
else
  mal "C-04 el componente nuevo no llegó bien (rc=$rc)"; cat "$TMP/out"
fi

# C-05 · una ficha borrada de la privada que tenía texto público frena (no queda texto huérfano).
cp "$FPRIV" "$TMP/priv.html"
editar_ficha "$TMP/priv.html" vigilante donde ""
rc=$(correr)
[ "$rc" = 2 ] && grep -q '"vigilante"' "$TMP/out" && ok "C-05 una ficha que desaparece de la privada frena" || { mal "C-05 la ficha borrada pasó (rc=$rc)"; cat "$TMP/out"; }

# C-06 · la pública editada a mano se detecta.
cp "$FPRIV" "$TMP/priv.html"
correr >/dev/null
printf '\n<!-- editado a mano -->\n' >> "$TMP/pub.html"
rc=$(correr --check)
[ "$rc" = 1 ] && ok "C-06 una pública editada a mano no pasa el chequeo" || { mal "C-06 la edición a mano pasó (rc=$rc)"; cat "$TMP/out"; }

# C-07 · un cambio en el diagrama justo donde hay un reemplazo frena (no deja el texto interno).
cp "$FPRIV" "$TMP/priv.html"
sed -i.bak 's/"admin": "Máquina del admin del arnés"/"admin": "Máquina del admin"/' "$TMP/priv.html"
rc=$(correr)
[ "$rc" = 2 ] && grep -q "reemplazo" "$TMP/out" && ok "C-07 la privada cambió donde hay un reemplazo: frena" || { mal "C-07 el reemplazo roto pasó (rc=$rc)"; cat "$TMP/out"; }

# C-08 · sin el selector de idioma no se genera a medias: sale 2 y dice dónde lo buscó (el código vive en el repo
# público y el selector, con el sitio, en el del equipo: la ruta se recibe con --i18n).
cp "$FPRIV" "$TMP/priv.html"
node "$GEN" --input "$TMP/priv.html" --config "$FCFG" --i18n "$TMP/no-existe/inject.js" --output "$TMP/pub-sin.html" >"$TMP/out" 2>&1; rc=$?
[ "$rc" = 2 ] && grep -q "selector de idioma" "$TMP/out" && grep -q "no-existe/inject.js" "$TMP/out" && [ ! -e "$TMP/pub-sin.html" ] \
  && ok "C-08 sin el selector de idioma no se genera nada, y dice dónde lo buscó" || { mal "C-08 sin selector de idioma (rc=$rc)"; cat "$TMP/out"; }

# C-09 · la pública muestra, como la privada, el nombre en el código y el repo y archivo de cada pieza. El repo, con el
# nombre que ve alguien de afuera, no con el del repo interno (2026-10-06, pedido del dueño).
cp "$FPRIV" "$TMP/priv.html"
rc=$(correr)
if [ "$rc" = 0 ] && grep -q 'check-hook-coverage' "$TMP/pub.html" && grep -q '"tcg": "acme-harness"' "$TMP/pub.html" \
   && ! grep -q 'acme-harness-interno' "$TMP/pub.html" && grep -q 'build/check-hook-coverage.js' "$TMP/pub.html"; then
  ok "C-09 la pública trae los nombres del código y los archivos"
else
  mal "C-09 la pública no trae los nombres del código o los archivos (rc=$rc)"; cat "$TMP/out"
fi

# C-10 · un nombre en el código cargado en una ficha de la privada llega a la pública.
cp "$FPRIV" "$TMP/priv.html"
editar_ficha "$TMP/priv.html" censo real "nombre-de-prueba-x"
rc=$(correr)
if [ "$rc" = 0 ] && grep -q 'nombre-de-prueba-x' "$TMP/pub.html"; then
  ok "C-10 el nombre de una ficha llega a la pública"
else
  mal "C-10 el nombre de una ficha no llegó a la pública (rc=$rc)"; cat "$TMP/out"
fi

# C-11 · T47 (story 8.12, R7) · la pública trae en cada ficha el mismo `tipo` que la privada, y ninguna va sin tipo.
hereda_de() {
  node -e '
    const fs = require("fs");
    const d = (p) => { const h = fs.readFileSync(p, "utf8"); const M = "const D = ", i = h.indexOf(M), f = h.indexOf("\n};\n", i); return JSON.parse(h.slice(i + M.length, f + 2)); };
    const priv = d(process.argv[1]), pub = d(process.argv[2]);
    const mal = Object.keys(priv).filter((k) => !priv[k].tipo || !pub[k] || pub[k].tipo !== priv[k].tipo);
    console.log(mal.length ? "MAL " + mal.join(",") : "OK " + Object.keys(priv).length);
  ' "$1" "$2" 2>&1
}
cp "$FPRIV" "$TMP/priv.html"
correr >/dev/null
hereda=$(hereda_de "$TMP/priv.html" "$TMP/pub.html")
[ "${hereda%% *}" = OK ] && ok "C-11 la pública hereda el tipo de cada pieza (${hereda#OK } fichas)" || mal "C-11 la pública no trae el tipo de la privada: $hereda"

# C-13 · T31 R4_HarnessMap_PreCommitAndCensusFolders (mitad del pre-commit, story 8.12, tanda R4, AC 27): con commits
# de verdad en un repo de laboratorio, el pre-commit regenera la pública desde la carpeta nueva del mapa —(a) si el
# commit toca la privada, (b) si toca sólo publica.json en su ruta nueva— y la pública regenerada entra en el commit.
# Si el pre-commit siguiera buscando el generador o publica.json en la carpeta vieja, (a) entraría sin regenerar o
# frenaría, y (b) ni siquiera se daría cuenta de que tocaron el mapa. El laboratorio es un repo del equipo de juguete:
# el mapa, publica.json y el selector de idioma de juguete puestos donde los tiene el de verdad.
lab_mapa() {   # $1=dir [$2=sin-mapa] — un repo con el pre-commit real y el código del mapa; todo commiteado con los hooks apagados
  local L="$1"
  mkdir -p "$L/repo/.githooks" "$L/repo/scripts" "$L/repo/$HMAP" "$L/casa"
  # el guion del arnés: con los dos repos unidos (story 8.18) `.githooks/pre-commit` es el despachador y el del arnés es
  # `pre-commit-harness`; cuál es lo elige scripts/tests/lib/pre-commit-hook.js (si falla, su error se ve)
  local hook; hook="$(node "$RAIZ/scripts/tests/lib/pre-commit-hook.js" harness "$RAIZ")"
  [ -n "$hook" ] || hook="$RAIZ/.githooks/pre-commit"
  cp "$hook" "$L/repo/.githooks/pre-commit" && chmod +x "$L/repo/.githooks/pre-commit"
  cp -R "$RAIZ/scripts/lib" "$L/repo/scripts/"
  cp "$RAIZ/$HMAP/"*.js "$L/repo/$HMAP/"
  if [ "${2:-}" != sin-mapa ]; then
    mkdir -p "$L/repo/artifacts" "$L/repo/$PUBDIR/i18n"
    cp "$FPRIV" "$L/repo/artifacts/mapa-arnes.html"
    cp "$FCFG" "$L/repo/$HMAP/publica.json"
    # el generador le incrusta el selector de idioma: en el repo del equipo vive en onboarding/mini-class/i18n/
    cp "$FI18N" "$L/repo/$PUBDIR/i18n/inject.js"
    ( cd "$L/repo" && node "$HMAP/public-version.js" >/dev/null )
  fi
  git init -q -b main "$L/repo"
  ( cd "$L/repo" && git add -A && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m base )
}
commit_lab() {   # $1=dir $2=mensaje — un commit de verdad, con el pre-commit del laboratorio
  ( cd "$1/repo" && HOME="$1/casa" TYCON_NO_NIGHTLY_EXAM=1 \
      git -c core.hooksPath=.githooks -c user.email=b@b -c user.name=b commit -q -m "$2" ) > "$1/out" 2>&1
  echo $?
}
ficha_lab() {   # $1=privada — una ficha nueva, con el tipo que le da su ruta (si no, el censo --check frena antes)
  editar_ficha "$1" pieza-lab-r4 + "Pieza de laboratorio R4"
  editar_ficha "$1" pieza-lab-r4 tipo "script"
}
# (a) el commit toca la privada
L="$TMP/lab-a"; lab_mapa "$L"; antes=$(git -C "$L/repo" rev-list --count HEAD)
ficha_lab "$L/repo/artifacts/mapa-arnes.html"
( cd "$L/repo" && git add artifacts/mapa-arnes.html )
rc=$(commit_lab "$L" "privada con una ficha nueva")
# 🔴 La pública del commit se vuelca a un archivo y se busca ahí. Con `git show … | grep -q` y pipefail, grep corta al
#    encontrar la ficha y git, que todavía escribe el final del archivo, muere por la tubería: la línea daba falso con
#    la pública bien regenerada (validaciones 12355 y 12364, en Linux; en la Mac no pasaba).
git -C "$L/repo" show "HEAD:$PUBDIR/mapa-del-arnes.html" > "$L/publica-del-commit.html" 2> "$L/publica-del-commit.err"
if [ "$rc" = 0 ] && [ "$(git -C "$L/repo" rev-list --count HEAD)" = "$((antes + 1))" ] \
   && grep -q "Pieza de laboratorio R4" "$L/publica-del-commit.html" \
   && grep -q "se regeneró" "$L/out"; then
  ok "C-13 T31 (a) un commit que toca la privada entra con la pública regenerada desde $HMAP/"
else
  mal "C-13 T31 (a) la pública no se regeneró desde la carpeta nueva (rc=$rc)"; sed -n '1,12p' "$L/out"
fi
# (b) la pública quedó vieja en la base y el commit toca SÓLO publica.json en su ruta nueva
L="$TMP/lab-b"; lab_mapa "$L"
ficha_lab "$L/repo/artifacts/mapa-arnes.html"
( cd "$L/repo" && git add -A && git -c core.hooksPath=/dev/null -c user.email=b@b -c user.name=b commit -q -m "pública vieja" )
printf '\n' >> "$L/repo/$HMAP/publica.json"
( cd "$L/repo" && git add "$HMAP/publica.json" )
rc=$(commit_lab "$L" "sólo publica.json")
git -C "$L/repo" show "HEAD:$PUBDIR/mapa-del-arnes.html" > "$L/publica-del-commit.html" 2> "$L/publica-del-commit.err"
if [ "$rc" = 0 ] && grep -q "Pieza de laboratorio R4" "$L/publica-del-commit.html"; then
  ok "C-13 T31 (b) un commit que toca sólo $HMAP/publica.json dispara la regeneración"
else
  mal "C-13 T31 (b) tocar $HMAP/publica.json no regeneró la pública (rc=$rc)"; sed -n '1,12p' "$L/out"
fi
# (c) la pública editada a mano, sin tocar la privada, frena el commit
L="$TMP/lab-c"; lab_mapa "$L"
printf '\n<!-- editado a mano -->\n' >> "$L/repo/$PUBDIR/mapa-del-arnes.html"
( cd "$L/repo" && git add "$PUBDIR/mapa-del-arnes.html" )
rc=$(commit_lab "$L" "pública a mano")
[ "$rc" != 0 ] && grep -q "no se edita a mano" "$L/out" && ok "C-13 T31 (c) una pública editada a mano no entra" \
  || { mal "C-13 T31 (c) la pública editada a mano entró (rc=$rc)"; sed -n '1,12p' "$L/out"; }

# C-14 · en un repo que no trae el mapa interno (el público), un commit que toca sólo el código del mapa entra y dice por
# qué no regeneró nada: antes de que el código viajara, el pre-commit rechazaba ese commit porque no encontraba la
# privada en el índice, y por eso el código no podía vivir en el repo público.
L="$TMP/lab-d"; lab_mapa "$L" sin-mapa
printf '\n// cambio de prueba\n' >> "$L/repo/$HMAP/census.js"
( cd "$L/repo" && git add "$HMAP/census.js" )
rc=$(commit_lab "$L" "sólo el código del mapa")
[ "$rc" = 0 ] && grep -q "no trae el mapa interno" "$L/out" && [ -z "$(git -C "$L/repo" ls-files "$PUBDIR")" ] \
  && ok "C-14 sin el mapa interno, tocar el código del mapa no frena el commit y lo dice" \
  || { mal "C-14 sin el mapa interno el commit del código no entró (rc=$rc)"; sed -n '1,12p' "$L/out"; }

# ── El mapa de verdad: sólo en el árbol del equipo (con lo público encima) ─────────────────────────────────────
# R-01 · la pública commiteada es exactamente la que sale de la privada commiteada.
if [ "$REAL" = 1 ]; then
  node "$GEN" --input "$PRIV" --config "$CFG" --output "$PUB" --check >"$TMP/out" 2>&1
  [ $? = 0 ] && ok "R-01 la pública está al día con la privada" || { mal "R-01 la pública no está al día"; cat "$TMP/out"; }
else sin_medir "R-01"; fi

# R-02 · la pública de verdad es un documento completo y no trae la máquina, el canal ni el rótulo del admin.
if [ "$REAL" = 1 ]; then
  if head -1 "$PUB" | grep -i '^<!doctype html>' >/dev/null && ! grep -qE 'Telegram|Mac mini|admin del arnés' "$PUB"; then
    ok "R-02 la pública es un documento completo y limpio"
  else
    mal "R-02 la pública no es un documento completo o trae algo interno"
  fi
else sin_medir "R-02"; fi

# R-03 · la pública de verdad trae el nombre en el código y el repo como lo ve alguien de afuera.
if [ "$REAL" = 1 ]; then
  if grep -q 'check-hook-coverage' "$PUB" && grep -q '"tcg": "tycon-harness"' "$PUB" && ! grep -q 'tycon-claude-guides' "$PUB" && grep -q 'build/check-hook-coverage.js' "$PUB"; then
    ok "R-03 la pública trae los nombres del código y los archivos"
  else
    mal "R-03 la pública no trae los nombres del código o los archivos"
  fi
else sin_medir "R-03"; fi

# R-04 · todo modelo de Codex que nombra el mapa existe en la tabla de equivalencias (si la tabla cambia, el mapa no
# queda viejo sin que nadie lo note).
if [ "$REAL" = 1 ]; then
  viejos=$(node -e '
    const fs = require("fs");
    const eq = JSON.parse(fs.readFileSync(process.argv[2] + "/build/equivalences.json", "utf8"));
    const validos = new Set(Object.values(eq.models));
    const usados = new Set(fs.readFileSync(process.argv[1], "utf8").match(/gpt-[0-9][\w.-]*[\w]/g) || []);
    console.log([...usados].filter((m) => !validos.has(m)).join(" "));
  ' "${MAPA_PRIV:-$PRIV}" "$RAIZ")
  if [ -z "$viejos" ] && grep -q 'gpt-5' "${MAPA_PRIV:-$PRIV}"; then
    ok "R-04 los modelos de Codex del mapa están en la tabla de equivalencias"
  else
    mal "R-04 el mapa nombra modelos de Codex que no están en la tabla: ${viejos:-(ninguno nombrado)}"
  fi
else sin_medir "R-04"; fi

# R-05 · T47 · la pública commiteada trae en cada ficha el mismo `tipo` que la privada.
if [ "$REAL" = 1 ]; then
  hereda=$(hereda_de "$PRIV" "$PUB")
  [ "${hereda%% *}" = OK ] && ok "R-05 la pública hereda el tipo de cada pieza (${hereda#OK } fichas)" || mal "R-05 la pública no trae el tipo de la privada: $hereda"
else sin_medir "R-05"; fi

echo "  $BIEN bien · $MAL mal · $SIN sin medir"
[ "$MAL" = 0 ]
