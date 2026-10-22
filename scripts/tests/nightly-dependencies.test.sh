#!/usr/bin/env bash
# Prueba de nightly-dependencies.js — la revisión nocturna de dependencias.
#
# Motivo: el análisis de dependencias es el ÚNICO de los tres controles de seguridad
# que pregunta AFUERA, así que su veredicto puede cambiar sin que cambie una línea de código — y
# sólo corre en los pull requests. Ejemplo: un repo pasa en verde a las 15:56 y a
# las 16:42 aparece una vulnerabilidad nueva sobre una de sus dependencias.
#
# Los casos giran alrededor de tres confusiones que matarían la pieza en silencio:
#   · "no pude medir" leído como "está limpio";
#   · "no había nada" indistinguible de "no corrí";
#   · un tope de ruido que, para no molestar, ENTIERRA hallazgos que nunca se anunciaron.
# Ninguno toca la red.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NOC="$AQUI/scripts/nightly/dependencies/nightly-dependencies.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ nocturno-deps: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ nocturno-deps: $1"; fallos=$((fallos+1)); }

# El comando externo, de mentira: elige el fixture por el nombre de la carpeta del repo, así cada
# repo del mundo de prueba puede devolver algo distinto.
cat > "$TMP/doble.sh" <<'DOBLE'
#!/usr/bin/env bash
# 🔴 El nocturno audita un árbol temporal parado en origin/main, así que la carpeta NO se llama
# como el repo: el fixture se elige por un archivo versionado, que sí viaja al árbol.
F="$FIX/$(cat "$PWD/SOY" 2>/dev/null || basename "$PWD").json"
case "${TYCON_DEP_REAL}:$1" in
  npm:audit)      [ -f "$F" ] && cat "$F"; exit 0 ;;
  dotnet:restore) exit 0 ;;
  dotnet:list)    [ -f "$F" ] && cat "$F"; exit 0 ;;
esac
exit 0
DOBLE
chmod +x "$TMP/doble.sh"

LIMPIO='{"vulnerabilities":{},"metadata":{"vulnerabilities":{"critical":0,"high":0,"moderate":0,"low":0}}}'
UNA='{"vulnerabilities":{"browserslist":{"severity":"high","via":[{"url":"https://x/GHSA-73wf"}]}},"metadata":{"vulnerabilities":{"critical":0,"high":1,"moderate":0,"low":0}}}'
DOS_ALTAS='{"vulnerabilities":{"browserslist":{"severity":"high","via":[{"url":"https://x/GHSA-73wf"}]},"handlebars":{"severity":"high","via":[{"url":"https://x/GHSA-2qvq"}]}},"metadata":{"vulnerabilities":{"critical":0,"high":2,"moderate":0,"low":0}}}'
TRES_CRIT_DOS_ALTAS='{"vulnerabilities":{"c1":{"severity":"critical","via":[{"url":"https://x/GHSA-c1"}]},"c2":{"severity":"critical","via":[{"url":"https://x/GHSA-c2"}]},"c3":{"severity":"critical","via":[{"url":"https://x/GHSA-c3"}]},"a1":{"severity":"high","via":[{"url":"https://x/GHSA-a1"}]},"a2":{"severity":"high","via":[{"url":"https://x/GHSA-a2"}]}},"metadata":{"vulnerabilities":{"critical":3,"high":2,"moderate":0,"low":0}}}'
DOS='{"vulnerabilities":{"browserslist":{"severity":"high","via":[{"url":"https://x/GHSA-73wf"}]},"handlebars":{"severity":"critical","via":[{"url":"https://x/GHSA-2qvq"}]}},"metadata":{"vulnerabilities":{"critical":1,"high":1,"moderate":0,"low":0}}}'

# 🔴 Los repos de prueba son repos git CON origin/main: el nocturno audita lo
# publicado (un árbol temporal parado ahí), y un directorio que no es un repo git es "no medido".
mundo(){ rm -rf "$TMP/mundo" "$TMP/fix"; mkdir -p "$TMP/fix"
  for r in "$@"; do mkdir -p "$TMP/mundo/$r"; ( cd "$TMP/mundo/$r"
    : > package-lock.json; echo "$r" > SOY
    git init -q -b main . && git config user.email t@t && git config user.name t
    git add -A && git commit -qm publicado
    git remote add origin . && git update-ref refs/remotes/origin/main HEAD ) >/dev/null 2>&1; done; }
config(){ # <archivo> <tope> <repos...>
  local f="$1" tope="$2"; shift 2; local items=""
  for r in "$@"; do items="$items{\"producto\":\"$r\",\"ruta\":\"$r\",\"tipo\":\"npm\",\"activo\":true},"; done
  cat > "$f" <<CFG
{ "presupuesto_de_ruido": { "tope_pr_por_noche": $tope },
  "raiz_por_defecto": "$TMP/mundo", "repos": [ ${items%,} ] }
CFG
}
noche(){ # <config> <fecha>
  FIX="$TMP/fix" TYCON_DEP_CMD="$TMP/doble.sh" node "$NOC" run --config "$1" \
    --out "$TMP/out" --pending "$TMP/pend" --today "$2" >"$TMP/o.txt" 2>&1; echo $?; }
anunciados(){ sed -n '/^--- anunciar ---$/,$p' "$TMP/o.txt" | tail -n +2 | grep -c . || true; }

# ── 1. la PRIMERA corrida es la línea base: no anuncia nada ──────────────────────────────────
# Sin snapshot previo no hay con qué comparar. Anunciar acá dispararía un aviso por CADA
# vulnerabilidad preexistente del equipo la primera noche — el estreno más ruidoso posible.
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$DOS" > "$TMP/fix/A.json"; config "$TMP/c.json" 2 A
rc=$(noche "$TMP/c.json" 2026-09-01)
{ [ "$rc" -eq 0 ] && [ "$(anunciados)" -eq 0 ] && grep -qi "LÍNEA BASE" "$TMP/o.txt"; } \
  && ok "la primera ejecución es línea base y no anuncia nada" || no "línea base: rc=$rc anunció $(anunciados)"

# ── 2. lo que aparece DESPUÉS sí se anuncia ─────────────────────────────────────────────────
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; config "$TMP/c.json" 2 A
noche "$TMP/c.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"
rc=$(noche "$TMP/c.json" 2026-09-02)
{ [ "$rc" -eq 0 ] && [ "$(anunciados)" -eq 1 ] && grep -q "browserslist" "$TMP/o.txt"; } \
  && ok "una vulnerabilidad nueva se anuncia (el caso browserslist)" || no "nuevo: rc=$rc anunció $(anunciados)"

# ── 3. y deja su borrador para que una persona decida ───────────────────────────────────────
[ "$(ls "$TMP/pend/pending"/*.yaml 2>/dev/null | wc -l)" -eq 1 ] \
  && ok "queda un borrador esperando decisión" || no "no quedó el borrador"

# ── 4. 🔴 SABE CALLARSE: una noche sin novedad no anuncia nada ───────────────────────────────
rc=$(noche "$TMP/c.json" 2026-09-03)
{ [ "$rc" -eq 0 ] && [ "$(anunciados)" -eq 0 ]; } \
  && ok "una noche sin novedad no anuncia nada" || no "noche tranquila anunció $(anunciados)"

# ── 5. 🔴 EL TOPE NO PIERDE HALLAZGOS: el postergado entra PRIMERO al día siguiente ──────────
# El modo de falla más silencioso que puede tener un presupuesto de ruido: lo que no entra hoy
# mañana ya no es "nuevo", y se enterraría sin haberse anunciado nunca.
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; config "$TMP/c1.json" 1 A
noche "$TMP/c1.json" 2026-09-01 >/dev/null
echo "$DOS_ALTAS" > "$TMP/fix/A.json"
noche "$TMP/c1.json" 2026-09-02 >/dev/null; primero=$(anunciados)
grep -qi "postergado" "$TMP/o.txt" && dice_posterga=1 || dice_posterga=0
noche "$TMP/c1.json" 2026-09-03 >/dev/null; segundo=$(anunciados)
noche "$TMP/c1.json" 2026-09-04 >/dev/null; tercero=$(anunciados)
{ [ "$primero" -eq 1 ] && [ "$dice_posterga" -eq 1 ] && [ "$segundo" -eq 1 ] && [ "$tercero" -eq 0 ]; } \
  && ok "el tope reparte en dos noches y no entierra nada (1,1,0)" \
  || no "presupuesto: anunció $primero,$segundo,$tercero (posterga=$dice_posterga)"

# ── 5b. 🔴 UNA CRÍTICA NO ESPERA TURNO: no consume el tope y sale la misma noche ───────────────
# Con el tope por noches primero, una crítica recién aparecida quedaría
# detrás de altas más viejas y podría esperar varias noches. El tope es para no aturdir con altas;
# una crítica se anuncia siempre. Tope 1, tres críticas y dos altas → 3 + 1 hoy, la alta que queda mañana.
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; config "$TMP/c1b.json" 1 A
noche "$TMP/c1b.json" 2026-09-01 >/dev/null
echo "$TRES_CRIT_DOS_ALTAS" > "$TMP/fix/A.json"
noche "$TMP/c1b.json" 2026-09-02 >/dev/null; primero=$(anunciados)
crit_hoy=$(grep -cE '📣 c[123] \[critical\]' "$TMP/o.txt" || true)
noche "$TMP/c1b.json" 2026-09-03 >/dev/null; segundo=$(anunciados)
noche "$TMP/c1b.json" 2026-09-04 >/dev/null; tercero=$(anunciados)
{ [ "$primero" -eq 4 ] && [ "$crit_hoy" -eq 3 ] && [ "$segundo" -eq 1 ] && [ "$tercero" -eq 0 ]; } \
  && ok "🔴 las críticas no consumen el tope: 3 críticas + 1 alta la primera noche, la otra alta la siguiente (4,1,0)" \
  || no "críticas y tope: anunció $primero,$segundo,$tercero (críticas hoy=$crit_hoy) · $(sed -n '/^--- anunciar ---$/,$p' "$TMP/o.txt")"

# ── 6. 🔴 un repo NO MEDIDO no se cuenta como limpio, y no sirve de línea base ───────────────
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"
config "$TMP/c2.json" 2 A Fantasma      # Fantasma no existe en el mundo
rc=$(noche "$TMP/c2.json" 2026-09-01)
{ [ "$rc" -eq 0 ] && grep -q "NO MEDIDO" "$TMP/o.txt" \
  && node -e "process.exit(require('$TMP/out/dependencias-2026-09-01.json').corrida_completa?1:0)"; } \
  && ok "un repo ausente sale como NO MEDIDO y la ejecución no queda 'completa'" \
  || no "no-medido: rc=$rc · $(cat "$TMP/o.txt")"

# ── 7. un repo caído NO tumba la vigilancia de los otros ────────────────────────────────────
[ "$rc" -eq 0 ] && ok "con 1 de 2 repos medidos la noche sigue en verde" || no "un repo caído tumbó la ejecución"

# ── 8. 🔴 …pero si NO SE PUDO MEDIR NADA, eso no puede salir en verde ────────────────────────
rm -rf "$TMP/out" "$TMP/pend"; mundo; config "$TMP/c3.json" 2 Fantasma1 Fantasma2
rc=$(noche "$TMP/c3.json" 2026-09-01)
[ "$rc" -eq 1 ] && ok "una noche en que no se miró NADA sale 1" || no "sin ningún repo medido salió $rc"

# ── 9. el mismo aviso en varios repos es UN hallazgo, con la lista de repos ─────────────────
rm -rf "$TMP/out" "$TMP/pend"; mundo A B; echo "$LIMPIO" > "$TMP/fix/A.json"; cp "$TMP/fix/A.json" "$TMP/fix/B.json"
config "$TMP/c4.json" 2 A B
noche "$TMP/c4.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; cp "$TMP/fix/A.json" "$TMP/fix/B.json"
noche "$TMP/c4.json" 2026-09-02 >/dev/null
n=$(node -e "const h=require('$TMP/out/dependencias-2026-09-02.json').hallazgos;console.log(h.length+':'+h[0].repos.length)")
{ [ "$(anunciados)" -eq 1 ] && [ "$n" = "1:2" ]; } \
  && ok "un aviso que toca 2 repos es 1 hallazgo con los 2 repos, no 2 avisos" || no "agrupación: $n"

# ── 10. lo DECLARADO como deuda no despierta a nadie ────────────────────────────────────────
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; config "$TMP/c5.json" 2 A
noche "$TMP/c5.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"
echo '{"revision":"2026-12-31","paquetes":[{"paquete":"browserslist","advisories":["GHSA-73wf"]}]}' > "$TMP/mundo/A/vulnerabilidades-pendientes.json"
( cd "$TMP/mundo/A" && git add -A && git commit -qm "declaro la deuda" && git update-ref refs/remotes/origin/main HEAD ) >/dev/null 2>&1   # 🔴 se audita lo PUBLICADO: una declaración sin commitear no ampara
noche "$TMP/c5.json" 2026-09-02 >/dev/null
[ "$(anunciados)" -eq 0 ] && ok "lo declarado como deuda no genera aviso" || no "lo declarado despertó a alguien"

# 🔴 La declaración nombra los avisos que ampara: declarar sólo el nombre
# ampararía el paquete entero, para todo aviso futuro.
# ── 11. …pero si la declaración VENCE, vuelve a contar ──────────────────────────────────────
echo '{"revision":"2026-01-01","paquetes":[{"paquete":"browserslist","advisories":["GHSA-73wf"]}]}' > "$TMP/mundo/A/vulnerabilidades-pendientes.json"
( cd "$TMP/mundo/A" && git add -A && git commit -qm "declaro la deuda" && git update-ref refs/remotes/origin/main HEAD ) >/dev/null 2>&1   # 🔴 se audita lo PUBLICADO: una declaración sin commitear no ampara
noche "$TMP/c5.json" 2026-09-03 >/dev/null
[ "$(anunciados)" -eq 1 ] && ok "una declaración vencida vuelve a despertar" || no "la declaración vencida siguió tapando"

# ── 12. un borrador que nadie mira en 7 días queda como IGNORADO ────────────────────────────
# `ignorado` cuenta PEOR que `descartado`: un descarte con motivo es alguien que leyó y decidió.
noche "$TMP/c5.json" 2026-09-11 >/dev/null
{ [ -f "$TMP/pend/archived"/*.yaml ] 2>/dev/null || ls "$TMP/pend/archived"/*.yaml >/dev/null 2>&1; } \
  && grep -q "veredicto: ignorado" "$TMP/pend/archived"/*.yaml \
  && ok "a los 7 días sin decisión el borrador queda como 'ignorado'" || no "no se archivó como ignorado"

# ── 13. el texto del pull request nombra el paquete y los repos ─────────────────────────────
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; config "$TMP/c6.json" 2 A
noche "$TMP/c6.json" 2026-09-01 >/dev/null; echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c6.json" 2026-09-02 >/dev/null
B=$(ls "$TMP/pend/pending"/*.yaml | head -1)
node "$NOC" pr-text --draft "$B" > "$TMP/pr.txt" 2>&1
{ head -1 "$TMP/pr.txt" | grep "browserslist" >/dev/null && grep -q -- "---CUERPO---" "$TMP/pr.txt" && grep -q "declara" "$TMP/pr.txt"; } \
  && ok "el pull request nombra el paquete y explica qué decidir" || no "pr-text: $(head -3 "$TMP/pr.txt")"

# ── 14. `report` distingue lo ignorado de lo descartado ─────────────────────────────────────
node "$NOC" report --pending "$TMP/pend" > "$TMP/rep.txt" 2>&1
grep -qi "ignorado" "$TMP/rep.txt" && grep -qi "descartado" "$TMP/rep.txt" \
  && ok "la medición separa 'ignorado' de 'descartado'" || no "report no distingue los veredictos"

# ── 15-18. 🔴 auditar LO PUBLICADO, no la rama que quedó en el disco ─────────────────────────
# Este nocturno PROMETE mirar `main` —es lo que corre en producción—; si auditara el
# árbol de trabajo, o sea la rama en la que quedó el checkout de cada repo (en las máquinas del
# equipo suele ser `dev`), se reportarían vulnerabilidades que producción no tiene, o peor, se
# PERDERÍAN las que sí.
cat > "$TMP/doble2.sh" <<'DOBLE2'
#!/usr/bin/env bash
# elige el fixture por un archivo VERSIONADO del repo, así main y dev pueden diferir
F="$FIX/$(cat "$PWD/QUE-SOY" 2>/dev/null || echo desconocido).json"
case "${TYCON_DEP_REAL}:$1" in
  npm:audit) [ -f "$F" ] && cat "$F"; exit 0 ;;
esac
exit 0
DOBLE2
chmod +x "$TMP/doble2.sh"

repogit(){ # <ruta> — main con una vulnerabilidad, dev limpio y CHECKEADO
  rm -rf "$1"; mkdir -p "$1"; ( cd "$1"
    git init -q -b main . && git config user.email t@t && git config user.name t
    : > package-lock.json; echo main > QUE-SOY
    git add -A && git commit -qm publicado
    git remote add origin . && git update-ref refs/remotes/origin/main HEAD
    git checkout -q -b dev && echo dev > QUE-SOY && git commit -qam "trabajo en curso" ) >/dev/null 2>&1
}
noche2(){ FIX="$TMP/fix" TYCON_DEP_CMD="$TMP/doble2.sh" node "$NOC" run --config "$1" \
    --out "$TMP/out" --pending "$TMP/pend" --today "${2:-2026-09-10}" >"$TMP/o.txt" 2>&1; echo $?; }

rm -rf "$TMP/mundo" "$TMP/fix"; mkdir -p "$TMP/fix"
echo "$UNA" > "$TMP/fix/main.json"; echo "$LIMPIO" > "$TMP/fix/dev.json"
repogit "$TMP/mundo/ProdA"
config "$TMP/c-pub.json" 2 ProdA
rc=$(noche2 "$TMP/c-pub.json")
grep -qi 'browserslist' "$TMP/o.txt" \
  && ok "🔴 audita lo PUBLICADO: encuentra la vulnerabilidad de main aunque el disco esté en dev" \
  || no "🔴 auditó el disco (dev, limpio) y perdió lo que producción SÍ tiene — rc=$rc · $(head -3 "$TMP/o.txt")"

grep -qiE 'publicad|origin/main' "$TMP/o.txt" \
  && ok "…y deja constancia de qué auditó" || no "no dijo qué auditó: $(head -3 "$TMP/o.txt")"

# 🔴 si no se pudo preparar el árbol publicado, es NO MEDIDO — nunca "limpio"
rm -rf "$TMP/mundo/ProdB"; mkdir -p "$TMP/mundo/ProdB"; : > "$TMP/mundo/ProdB/package-lock.json"
echo main > "$TMP/mundo/ProdB/QUE-SOY"   # existe y parece auditable, pero NO es un repo git
config "$TMP/c-nog.json" 2 ProdB
rc=$(noche2 "$TMP/c-nog.json")
grep -qi 'no medido' "$TMP/o.txt" \
  && ok "🔴 un repo del que no se puede sacar lo publicado sale NO MEDIDO, no limpio" \
  || no "🔴 sin poder ver lo publicado lo dio por medido: $(head -3 "$TMP/o.txt")"

sobran=$(git -C "$TMP/mundo/ProdA" worktree list 2>/dev/null | grep -c nocturno || true)
[ "${sobran:-0}" = "0" ] && ok "no deja árboles temporales colgados" || no "quedaron $sobran árboles temporales"

# ── 19. 🔴 un pendiente cuya vulnerabilidad DESAPARECE se cierra como RESUELTO, no como ignorado ──
# Si el dev paga SSH.NET en tres repos, sin este camino el borrador sigue en pending/
# hasta el día 7 y se archiva como `ignorado` — el peor veredicto — por un trabajo que sí se hizo.
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; config "$TMP/c19.json" 2 A
noche "$TMP/c19.json" 2026-09-01 >/dev/null; echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c19.json" 2026-09-02 >/dev/null
ls "$TMP/pend/pending"/*.yaml >/dev/null 2>&1 || no "19: no quedó el borrador pendiente de la noche 2"
echo "$LIMPIO" > "$TMP/fix/A.json"; noche "$TMP/c19.json" 2026-09-03 >/dev/null
{ ls "$TMP/pend/promoted"/*.yaml >/dev/null 2>&1 && grep -q "veredicto: util" "$TMP/pend/promoted"/*.yaml \
  && grep -q "resuelto: 2026-09-03" "$TMP/pend/promoted"/*.yaml && ! ls "$TMP/pend/pending"/*.yaml >/dev/null 2>&1 \
  && grep -q "RESUELTO" "$TMP/o.txt"; } \
  && ok "🔴 la vulnerabilidad que desaparece con el repo medido cierra el borrador como resuelto (util), y se dice" \
  || no "19: el borrador no pasó a promoted/ como util — $(ls "$TMP/pend"/* 2>/dev/null | tr '\n' ' ')"

# ── 20. 🔴 …pero NO si alguno de sus repos no se midió esa noche: "no medido" nunca es "limpio" ──
rm -rf "$TMP/out" "$TMP/pend"; mundo A B; echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/B.json"; config "$TMP/c20.json" 2 A B
noche "$TMP/c20.json" 2026-09-01 >/dev/null; echo "$UNA" > "$TMP/fix/A.json"; echo "$UNA" > "$TMP/fix/B.json"; noche "$TMP/c20.json" 2026-09-02 >/dev/null
grep -q "^  - B" "$TMP/pend/pending"/*.yaml 2>/dev/null || no "20: el borrador debería listar a B"
echo "$LIMPIO" > "$TMP/fix/A.json"; rm -rf "$TMP/mundo/B"   # B desaparece: esta noche NO se mide
noche "$TMP/c20.json" 2026-09-03 >/dev/null
{ ls "$TMP/pend/pending"/*.yaml >/dev/null 2>&1 && ! ls "$TMP/pend/promoted"/*.yaml >/dev/null 2>&1 && grep -q "NO MEDIDO" "$TMP/o.txt"; } \
  && ok "🔴 con un repo sin medir el borrador se queda pendiente: no se sabe si se pagó" \
  || no "20: se resolvió (o se perdió) un borrador con un repo NO MEDIDO — $(ls "$TMP/pend"/* 2>/dev/null | tr '\n' ' ')"

# ── 21. el borrador refresca los HECHOS de cada noche (repos, noches) sin tocar la decisión ─────
# Sin el refresco, el PR de SSH.NET nombraría a los tres repos de la primera noche aunque la noche actual
# sólo tenga uno distinto: el borrador quedaría congelado en su primera noche.
rm -rf "$TMP/out" "$TMP/pend"; mundo A B; echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/B.json"; config "$TMP/c21.json" 2 A B
noche "$TMP/c21.json" 2026-09-01 >/dev/null; echo "$UNA" > "$TMP/fix/A.json"; echo "$UNA" > "$TMP/fix/B.json"; noche "$TMP/c21.json" 2026-09-02 >/dev/null
B21=$(ls "$TMP/pend/pending"/*.yaml | head -1)
sed -i.bak 's/^veredicto: pendiente$/veredicto: pendiente # decision-en-curso/' "$B21" && rm -f "$B21.bak"
echo "$LIMPIO" > "$TMP/fix/A.json"; noche "$TMP/c21.json" 2026-09-03 >/dev/null    # A se arregla, B sigue
{ grep -q "^  - B/B$" "$B21" && ! grep -q "^  - A/A$" "$B21" && grep -q "^noches: 2$" "$B21" && grep -q "decision-en-curso" "$B21"; } \
  && ok "el borrador dice los repos y las noches de HOY, y la decisión escrita no se toca" \
  || no "21: el borrador quedó congelado o pisó la decisión — $(grep -E '^(noches|repos|veredicto|  - )' "$B21" | tr '\n' ' ')"

# ── 22-27. 🔴 SUBCARPETAS: el gateway de mensajería de Acme ─────────────────
# `Acme/BackEnd` lleva en `tools/chat-gateway` un SEGUNDO programa (Node) que corre en
# producción, con su propio lockfile y su propia deuda declarada. El pipeline del repo lo audita
# (`--repo tools/chat-gateway`); el nocturno no lo haría si cada entrada fuera un repo entero. Ejemplo
# sobre origin/main: la raíz da 0 altas y el gateway 1 crítica + 6 altas — o sea que el
# nocturno lo reportaría LIMPIO todas las noches. Un verde que significa "no miré eso".
mundosub(){ # <repo> <sub> — raíz y subcarpeta, cada una con su lockfile y su fixture ("<repo>" y "<repo>-sub")
  rm -rf "$TMP/mundo" "$TMP/fix"; mkdir -p "$TMP/fix" "$TMP/mundo/$1/$2"; ( cd "$TMP/mundo/$1"
    : > package-lock.json; echo "$1" > SOY
    : > "$2/package-lock.json"; echo "$1-sub" > "$2/SOY"
    git init -q -b main . && git config user.email t@t && git config user.name t
    git add -A && git commit -qm publicado
    git remote add origin . && git update-ref refs/remotes/origin/main HEAD ) >/dev/null 2>&1; }
configsub(){ # <archivo> <entradas json>
  cat > "$1" <<CFG
{ "presupuesto_de_ruido": { "tope_pr_por_noche": 2 }, "raiz_por_defecto": "$TMP/mundo", "repos": [ $2 ] }
CFG
}
RAIZ_A='{"producto":"A","ruta":"A","ado":"ado/A","tipo":"npm","activo":true}'
SUB_A='{"producto":"A","ruta":"A","subruta":"sub","ado":"ado/A","tipo":"npm","activo":true}'

# ── 22. 🔴 hoy una `ruta` que apunta a una subcarpeta NO FALLA: MIENTE ───────────────────────
# `git -C <sub>` resuelve la raíz del repo desde cualquier subcarpeta, y después se auditaba la
# raíz del árbol temporal rotulada con el nombre de la subcarpeta: un número equivocado con la
# etiqueta correcta. Tiene que salir NO MEDIDO con el motivo, nunca la raíz por consuelo.
rm -rf "$TMP/out" "$TMP/pend"; mundosub A sub; echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$UNA" > "$TMP/fix/A-sub.json"
configsub "$TMP/c22.json" '{"producto":"A","ruta":"A/sub","ado":"ado/A","tipo":"npm","activo":true}'
rc=$(noche "$TMP/c22.json" 2026-09-01)
{ [ "$rc" -eq 1 ] && grep -q "NO MEDIDO" "$TMP/o.txt" && grep -qi "subruta" "$TMP/o.txt" && grep -q "Repos mirados: 0/1" "$TMP/o.txt"; } \
  && ok "🔴 una ruta que apunta a una subcarpeta sale NO MEDIDO (y dice cómo declararla), no la raíz con otra etiqueta" \
  || no "🔴 22: auditó la raíz y la rotuló como la subcarpeta — rc=$rc · $(head -4 "$TMP/o.txt" | tr '\n' ' ')"

# ── 23. 🔴 con `subruta` se audita LA SUBCARPETA: la raíz limpia no tapa al gateway ──────────
rm -rf "$TMP/out" "$TMP/pend"; mundosub A sub; echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/A-sub.json"
configsub "$TMP/c23.json" "$SUB_A"
noche "$TMP/c23.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A-sub.json"     # la raíz sigue limpia; el gateway se enferma
rc=$(noche "$TMP/c23.json" 2026-09-02)
{ [ "$rc" -eq 0 ] && [ "$(anunciados)" -eq 1 ] && grep -q "browserslist" "$TMP/o.txt" && grep -q "A/A/sub" "$TMP/o.txt"; } \
  && ok "🔴 con subruta se audita la subcarpeta: la vulnerabilidad del gateway se encuentra aunque la raíz esté limpia" \
  || no "🔴 23: la raíz limpia tapó al gateway — rc=$rc anunció $(anunciados) · $(grep -i 'repos mirados\|browserslist' "$TMP/o.txt" | tr '\n' ' ')"

# ── 24. 🔴 una subruta que NO EXISTE en origin/main es NO MEDIDO — nunca la raíz por consuelo ─
rm -rf "$TMP/out" "$TMP/pend"; mundosub A sub; echo "$LIMPIO" > "$TMP/fix/A.json"
configsub "$TMP/c24.json" '{"producto":"A","ruta":"A","subruta":"no-existe","ado":"ado/A","tipo":"npm","activo":true}'
rc=$(noche "$TMP/c24.json" 2026-09-01)
{ [ "$rc" -eq 1 ] && grep -q "NO MEDIDO" "$TMP/o.txt" && grep -q "no-existe" "$TMP/o.txt" && grep -q "Repos mirados: 0/1" "$TMP/o.txt"; } \
  && ok "🔴 una subruta ausente en lo publicado sale NO MEDIDO con su nombre, y no se audita la raíz en su lugar" \
  || no "🔴 24: midió algo que no era la subcarpeta — rc=$rc · $(head -4 "$TMP/o.txt" | tr '\n' ' ')"

# ── 25. 🔴 la IDENTIDAD incluye la subruta: raíz y gateway no se mezclan, y las viejas no cambian ─
# Con dos entradas que comparten `ruta`, la etiqueta `producto/basename(ruta)` colisionaba: los
# hallazgos del gateway se mezclarían con los del plugin y un borrador abierto de uno taparía al
# otro. Y la etiqueta de las entradas que ya existen NO puede cambiar: si cambia, mañana todo el
# mundo parece nuevo y se come el presupuesto de ruido (el caso 21 ya fija `A/A`).
rm -rf "$TMP/out" "$TMP/pend"; mundosub A sub; echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/A-sub.json"
configsub "$TMP/c25.json" "$RAIZ_A, $SUB_A"
noche "$TMP/c25.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; echo "$UNA" > "$TMP/fix/A-sub.json"
noche "$TMP/c25.json" 2026-09-02 >/dev/null
n=$(node -e "const h=require('$TMP/out/dependencias-2026-09-02.json').hallazgos;console.log(h.length+':'+h[0].repos.join(','))")
[ "$n" = "1:A/A,A/A/sub" ] \
  && ok "🔴 raíz y subcarpeta del mismo repo son dos etiquetas distintas (A/A y A/A/sub), y la vieja no cambió" \
  || no "🔴 25: las etiquetas colisionaron o cambiaron — $n"
echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/A-sub.json"
noche "$TMP/c25.json" 2026-09-03 >/dev/null
{ ls "$TMP/pend/promoted"/*.yaml >/dev/null 2>&1 && ! ls "$TMP/pend/pending"/*.yaml >/dev/null 2>&1; } \
  && ok "…y cuando las dos se curan el borrador se resuelve: la etiqueta del medido coincide con la del hallazgo" \
  || no "25b: el borrador no se resolvió con raíz y subcarpeta medidas y limpias — $(ls "$TMP/pend"/* 2>/dev/null | tr '\n' ' ')"

# ── 26. 🔴 la deuda declarada se lee EN LA SUBCARPETA: el gateway entra en silencio ──────────
# El archivo ya existe en tools/chat-gateway/vulnerabilidades-pendientes.json. La raíz acá
# tiene la misma vulnerabilidad SIN declarar a propósito: si el nocturno audita la raíz por error,
# avisa; si audita la subcarpeta y lee su declaración, calla.
rm -rf "$TMP/out" "$TMP/pend"; mundosub A sub; echo "$UNA" > "$TMP/fix/A.json"; echo "$UNA" > "$TMP/fix/A-sub.json"
echo '{"revision":"2026-12-31","paquetes":[{"paquete":"browserslist","advisories":["GHSA-73wf"]}]}' > "$TMP/mundo/A/sub/vulnerabilidades-pendientes.json"
( cd "$TMP/mundo/A" && git add -A && git commit -qm "el gateway declara su deuda" && git update-ref refs/remotes/origin/main HEAD ) >/dev/null 2>&1
configsub "$TMP/c26.json" "$SUB_A"
noche "$TMP/c26.json" 2026-09-01 >/dev/null
noche "$TMP/c26.json" 2026-09-02 >/dev/null
d=$(node -e "const r=require('$TMP/out/dependencias-2026-09-02.json').repos[0];console.log(r.medido+':'+(r.graves||[]).length+':'+((r.graves||[])[0]||{}).declarada)")
{ [ "$(anunciados)" -eq 0 ] && [ "$d" = "true:1:true" ]; } \
  && ok "🔴 la declaración de la subcarpeta se encuentra sola: el gateway entra en silencio, con su deuda vista y amparada" \
  || no "🔴 26: no leyó la declaración del gateway (o auditó la raíz) — anunció $(anunciados), repo=$d"

# ── 27. el pipeline clona cada `ruta` UNA vez aunque tenga dos entradas ──────────────────────
# El clon de Azure DevOps sale de esta lista. Con raíz y subcarpeta declaradas, el segundo clon
# fallaría ("destination path already exists") y el repo figuraría como NO clonado siendo que sí.
configsub "$TMP/c27.json" "$RAIZ_A, $SUB_A, {\"producto\":\"B\",\"ruta\":\"B\",\"ado\":\"ado/B\",\"tipo\":\"npm\",\"activo\":false}"
node "$NOC" clone-list --config "$TMP/c27.json" > "$TMP/cl.txt" 2>&1
{ [ "$(grep -c . "$TMP/cl.txt")" -eq 1 ] && grep -q "^A	ado/A$" "$TMP/cl.txt"; } \
  && ok "\`clones\` lista cada ruta activa una sola vez (raíz + subcarpeta = un clon; apagado = ninguno)" \
  || no "27: la lista de clones no deduplica o no existe — $(cat "$TMP/cl.txt" | head -3 | tr '\n' ' ')"

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# Que «resuelto» signifique resuelto
#
# Tres defectos que se tapan entre sí:
#   1. La ficha ACEPTADA (promoted/) no se volvería a mirar: nunca recibiría `resuelto:` y sus datos
#      quedarían congelados en la primera noche.
#   2. Declarar la deuda se leería como PAGADO: lo declarado se descuenta antes de comparar, el id
#      desaparece de `hallazgos` y se lee como "ya no está".
#   3. El identificador se movería solo: un aviso nuevo sobre el mismo paquete crea otra huella, así
#      que el viejo se daría por resuelto (falso) y el nuevo nacería como ficha nueva con PR nuevo.
# ═══════════════════════════════════════════════════════════════════════════════════════════════

# Una config donde cada entrada declara su `ado` (el proyecto de Azure DevOps) y puede estar
# apagada. Spec por repo: "<repo>", "<repo>|<ado>" o "<repo>|<ado>|off".
configx(){ # <archivo> <tope> <spec>...
  local f="$1" tope="$2"; shift 2; local items=""
  for spec in "$@"; do
    local r ado act
    IFS='|' read -r r ado act <<< "$spec"
    [ -n "${ado:-}" ] || ado="Proy$r/$r"
    [ "${act:-}" = "off" ] && act=false || act=true
    items="$items{\"producto\":\"$r\",\"ruta\":\"$r\",\"tipo\":\"npm\",\"ado\":\"$ado\",\"activo\":$act},"
  done
  cat > "$f" <<CFG
{ "presupuesto_de_ruido": { "tope_pr_por_noche": $tope },
  "raiz_por_defecto": "$TMP/mundo", "repos": [ ${items%,} ] }
CFG
}

# El mismo paquete con DOS avisos: cambia el conjunto de advisories, o sea la huella, o sea el id.
DOSAV='{"vulnerabilities":{"browserslist":{"severity":"high","via":[{"url":"https://x/GHSA-73wf"},{"url":"https://x/GHSA-nuevo"}]}},"metadata":{"vulnerabilities":{"critical":0,"high":1,"moderate":0,"low":0}}}'

# Declarar la deuda en un repo del mundo, COMMITEADA (se audita lo publicado).
declarar(){ # <repo> <fecha-vencimiento> <aviso>...
  local r="$1" vence="$2"; shift 2
  local avs="" a
  for a in "$@"; do avs="$avs\"$a\","; done
  echo "{\"revision\":\"$vence\",\"paquetes\":[{\"paquete\":\"browserslist\",\"advisories\":[${avs%,}]}]}" \
    > "$TMP/mundo/$r/vulnerabilidades-pendientes.json"
  ( cd "$TMP/mundo/$r" && git add -A && git commit -qm "declaro la deuda" \
    && git update-ref refs/remotes/origin/main HEAD ) >/dev/null 2>&1
}
desdeclarar(){ # <repo> — saca la declaración y la publica
  rm -f "$TMP/mundo/$1/vulnerabilidades-pendientes.json"
  ( cd "$TMP/mundo/$1" && git add -A && git commit -qm "saco la deuda" \
    && git update-ref refs/remotes/origin/main HEAD ) >/dev/null 2>&1
}
# Mover una ficha a promoted/ EXACTAMENTE como lo hace el pipeline (git mv + sed).
aceptar(){ # <id>
  mkdir -p "$TMP/pend/promoted"
  mv "$TMP/pend/pending/$1.yaml" "$TMP/pend/promoted/$1.yaml"
  sed -i.bak 's/^veredicto: pendiente$/veredicto: util/' "$TMP/pend/promoted/$1.yaml"
  rm -f "$TMP/pend/promoted/$1.yaml.bak"
}
unaficha(){ ls "$TMP/pend/$1"/*.yaml 2>/dev/null | head -1; }
snap(){ node -e "const s=require('$TMP/out/dependencias-$1.json');$2"; }

# ── T1. 🔴 la ficha ACEPTADA se sigue vigilando: sus datos son los de HOY ─────────────────────
# El pipeline mueve la ficha a promoted/ al mergear su pull request, y desde ahí no la mira
# nadie: sin esto, `noches` queda congelado en la primera noche para siempre.
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; configx "$TMP/c-t1.json" 2 A
noche "$TMP/c-t1.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-t1.json" 2026-09-02 >/dev/null
ID1=$(basename "$(unaficha pending)" .yaml); aceptar "$ID1"
noche "$TMP/c-t1.json" 2026-09-03 >/dev/null
F1="$TMP/pend/promoted/$ID1.yaml"
{ grep -q "^noches: 2$" "$F1" && grep -q "^  - A/A$" "$F1" && grep -q "^veredicto: util$" "$F1" \
  && ! grep -q "^resuelto:" "$F1"; } \
  && ok "🔴 la ficha aceptada se refresca como una pendiente (noches y repos de hoy) y su veredicto no se toca" \
  || no "T1: la ficha aceptada quedó congelada — $(grep -E '^(noches|veredicto|resuelto)' "$F1" | tr '\n' ' ')"

# ── T2. 🔴 …y cuando la vulnerabilidad desaparece de verdad, recibe `resuelto:` ───────────────
# Es lo ÚNICO que escribe `resuelto:`: la medición. Ni el pull request mergeado, ni una deuda
# declarada, ni un id que se movió. Y la ficha SE QUEDA en promoted/: ya fue aceptada.
echo "$LIMPIO" > "$TMP/fix/A.json"; noche "$TMP/c-t1.json" 2026-09-04 >/dev/null
{ grep -q "^resuelto: 2026-09-04$" "$F1" && grep -q "dejó de aparecer" "$F1" \
  && grep -q "RESUELTO" "$TMP/o.txt" \
  && snap 2026-09-04 "process.exit(s.resueltos_ids.includes('$ID1')?0:1)"; } \
  && ok "🔴 la ficha aceptada cuya vulnerabilidad desaparece recibe \`resuelto:\`, se queda en promoted/ y se dice" \
  || no "T2: la ficha aceptada no se resolvió — $(grep -E '^(resuelto|motivo)' "$F1" | tr '\n' ' ')"

# ── T3. 🔴 …pero NO si alguno de sus repos no se midió: "no medido" nunca es "limpio" ─────────
rm -rf "$TMP/out" "$TMP/pend"; mundo A B; echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/B.json"
configx "$TMP/c-t3.json" 2 A B
noche "$TMP/c-t3.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; echo "$UNA" > "$TMP/fix/B.json"; noche "$TMP/c-t3.json" 2026-09-02 >/dev/null
ID3=$(basename "$(unaficha pending)" .yaml); aceptar "$ID3"
echo "$LIMPIO" > "$TMP/fix/A.json"; rm -rf "$TMP/mundo/B"      # B desaparece: esta noche NO se mide
noche "$TMP/c-t3.json" 2026-09-03 >/dev/null
{ ! grep -q "^resuelto:" "$TMP/pend/promoted/$ID3.yaml" \
  && snap 2026-09-03 "process.exit(s.resueltos_ids.length===0?0:1)"; } \
  && ok "🔴 una ficha aceptada con un repo SIN MEDIR no se resuelve: no se sabe si se pagó" \
  || no "T3: se resolvió con un repo sin medir — $(grep -E '^(resuelto|repos)' "$TMP/pend/promoted/$ID3.yaml" | tr '\n' ' ')"

# ── T4. 🔴 un repo APAGADO no cuenta como medido, y la ficha lo DICE ──────────────────────────
# Contar un repo apagado como medido sería "no medido = limpio". Dejar la ficha muda sería
# "aceptada sin resolver para siempre, sin decir por qué". Es un ESTADO, no una alarma.
rm -rf "$TMP/out" "$TMP/pend"; mundo A B; echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/B.json"
configx "$TMP/c-t4.json" 2 A B
noche "$TMP/c-t4.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; echo "$UNA" > "$TMP/fix/B.json"; noche "$TMP/c-t4.json" 2026-09-02 >/dev/null
ID4=$(basename "$(unaficha pending)" .yaml); aceptar "$ID4"
echo "$LIMPIO" > "$TMP/fix/A.json"
configx "$TMP/c-t4b.json" 2 A "B|ProyB/B|off"        # B se apaga a propósito
noche "$TMP/c-t4b.json" 2026-09-03 >/dev/null
F4="$TMP/pend/promoted/$ID4.yaml"
t4=$(snap 2026-09-03 "const a=(s.aceptadas_sin_resolver||[])[0]||{};console.log([s.resueltos_ids.length,a.id,a.paquete,a.desde,a.bloqueada_por].join('|'))")
{ grep -q '^bloqueada_por: "repo apagado: B/B"$' "$F4" && ! grep -q "^resuelto:" "$F4" \
  && [ "$t4" = "0|$ID4|browserslist|2026-09-02|repo apagado: B/B" ]; } \
  && ok "🔴 un repo apagado bloquea la resolución y la ficha lo dice (\`bloqueada_por\`), sin alarma" \
  || no "T4: el repo apagado no se dijo o se resolvió igual — snap=$t4 · $(grep -E '^(bloqueada_por|resuelto)' "$F4" | tr '\n' ' ')"

# ── T4b. …y el marcador SE BORRA la noche en que el repo vuelve ───────────────────────────────
# Un marcador que se escribe y nunca se saca es una alarma que se queda encendida sola.
echo "$LIMPIO" > "$TMP/fix/B.json"
noche "$TMP/c-t4.json" 2026-09-04 >/dev/null        # B vuelve a estar activo, y limpio
{ grep -q "^resuelto: 2026-09-04$" "$F4" && ! grep -q "^bloqueada_por:" "$F4"; } \
  && ok "…y cuando el repo apagado vuelve limpio, la ficha se resuelve y el marcador desaparece" \
  || no "T4b: no se destrabó — $(grep -E '^(bloqueada_por|resuelto)' "$F4" | tr '\n' ' ')"

# ── T5. 🔴 DECLARAR NO ES PAGAR ───────────────────────────────────────────────────────────────
# Lo declarado se descuenta ANTES de comparar, así que el id desaparecería de
# `hallazgos` y se leería como "ya no está" → la ficha saldría a promoted/ con motivo "(se pagó)".
# La vulnerabilidad sigue ahí; lo que hubo es una decisión de postergar, con fecha.
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; configx "$TMP/c-t5.json" 2 A
noche "$TMP/c-t5.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-t5.json" 2026-09-02 >/dev/null
ID5=$(basename "$(unaficha pending)" .yaml)
declarar A 2026-12-31 GHSA-73wf
noche "$TMP/c-t5.json" 2026-09-03 >/dev/null
F5="$TMP/pend/archived/$ID5.yaml"
{ [ -f "$F5" ] && grep -q "^veredicto: descartado$" "$F5" && grep -q "^descartado: 2026-09-03$" "$F5" \
  && grep -q '^motivo: "declarada como deuda en A/A (vence 2026-12-31)"$' "$F5" \
  && ! grep -rq "^resuelto:" "$TMP/pend" \
  && grep -q "DESCARTADO por deuda declarada" "$TMP/o.txt" \
  && snap 2026-09-03 "process.exit(s.descartados_ids.includes('$ID5')&&s.resueltos_ids.length===0?0:1)"; } \
  && ok "🔴 declarar la deuda NO es pagarla: la ficha se archiva como descartada con el vencimiento, sin \`resuelto:\`" \
  || no "T5: la deuda declarada salió como pagada — $(ls "$TMP/pend"/*/*.yaml 2>/dev/null | tr '\n' ' ') $(grep -E '^(veredicto|resuelto|motivo)' "$TMP/pend"/*/"$ID5.yaml" 2>/dev/null | tr '\n' ' ')"

# ── T6. la deuda declarada en ALGUNOS repos deja la ficha VIVA ────────────────────────────────
# Declarada en Globex y viva en Acme es viva. Archivarla por una sola declaración taparía el
# repo donde el problema sigue sin decidir.
rm -rf "$TMP/out" "$TMP/pend"; mundo A B; echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/B.json"
configx "$TMP/c-t6.json" 2 A B
noche "$TMP/c-t6.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; echo "$UNA" > "$TMP/fix/B.json"; noche "$TMP/c-t6.json" 2026-09-02 >/dev/null
ID6=$(basename "$(unaficha pending)" .yaml)
declarar A 2026-12-31 GHSA-73wf
noche "$TMP/c-t6.json" 2026-09-03 >/dev/null
F6="$TMP/pend/pending/$ID6.yaml"
{ [ -f "$F6" ] && grep -q "^veredicto: pendiente$" "$F6" \
  && [ "$(sed -n '/^repos:/,/^[a-z_]*:/p' "$F6" | grep -c '^  - ')" -eq 1 ] && grep -q "^  - B/B$" "$F6" \
  && grep -q "^  - A/A (vence 2026-12-31)$" "$F6" && grep -q "^declarada_en:$" "$F6"; } \
  && ok "la deuda declarada en ALGUNOS repos deja la ficha viva: \`repos\` los sin declarar, \`declarada_en\` los otros" \
  || no "T6: la deuda parcial archivó o perdió un repo — $(grep -E '^(veredicto|repos|declarada_en|  - )' "$F6" 2>/dev/null | tr '\n' ' ')"

# ── T7. declarada en unos y AUSENTE en los otros: eso sí se descarta ──────────────────────────
echo "$LIMPIO" > "$TMP/fix/B.json"                  # B se cura; en A sigue, declarada
noche "$TMP/c-t6.json" 2026-09-04 >/dev/null
{ [ -f "$TMP/pend/archived/$ID6.yaml" ] \
  && grep -q '^motivo: "declarada como deuda en A/A (vence 2026-12-31)"$' "$TMP/pend/archived/$ID6.yaml"; } \
  && ok "«en todos declarada o ausente» descarta la ficha, con el vencimiento en el motivo" \
  || no "T7: no se descartó con la deuda declarada en A y B ya limpio — $(ls "$TMP/pend"/*/*.yaml 2>/dev/null | tr '\n' ' ')"

# ── T8. una declaración que VENCE reactiva la MISMA ficha, no crea una segunda ────────────────
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; configx "$TMP/c-t8.json" 2 A
noche "$TMP/c-t8.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-t8.json" 2026-09-02 >/dev/null
ID8=$(basename "$(unaficha pending)" .yaml)
declarar A 2026-12-31 GHSA-73wf; noche "$TMP/c-t8.json" 2026-09-03 >/dev/null      # descartada por deuda
[ -f "$TMP/pend/archived/$ID8.yaml" ] || no "T8: la deuda declarada no archivó la ficha"
declarar A 2026-01-01 GHSA-73wf                                                     # la declaración vence
noche "$TMP/c-t8.json" 2026-09-04 >/dev/null
F8="$TMP/pend/pending/$ID8.yaml"
{ [ -f "$F8" ] && [ "$(ls "$TMP/pend"/*/*.yaml | wc -l | tr -d ' ')" -eq 1 ] \
  && grep -q "^veredicto: pendiente$" "$F8" && grep -q "^reaparecido: 2026-09-04$" "$F8" \
  && grep -q "^descartado_antes: 2026-09-03$" "$F8" && grep -q "^motivo_antes:" "$F8" \
  && snap 2026-09-04 "process.exit(s.reaparecidos_ids.includes('$ID8')&&s.anunciados_hoy.includes('$ID8')?0:1)"; } \
  && ok "una declaración vencida reactiva la MISMA ficha (con su historia en \`_antes\`), no abre una segunda" \
  || no "T8: nació una ficha nueva o no se reactivó — $(ls "$TMP/pend"/*/*.yaml | tr '\n' ' ')"

# ── T9. 🔴 un aviso NUEVO sobre el mismo paquete se ANEXA: no es una ficha nueva ───────────────
# La huella es `paquete|severidad|avisos`, así que un aviso más = otro id. El viejo
# desaparecería —"resuelto", falso— y el nuevo nacería con su propio pull request. Dos pull requests y
# un arreglo fantasma por el mismo hecho.
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; configx "$TMP/c-t9.json" 2 A
noche "$TMP/c-t9.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-t9.json" 2026-09-02 >/dev/null
ID9=$(basename "$(unaficha pending)" .yaml)
echo "$DOSAV" > "$TMP/fix/A.json"; noche "$TMP/c-t9.json" 2026-09-03 >/dev/null
F9="$TMP/pend/pending/$ID9.yaml"
t9=$(snap 2026-09-03 "const h=s.hallazgos[0]||{};const a=(s.anexados||[])[0]||{};
  console.log([s.anunciados_hoy.length,s.hallazgos.length,h.anunciado,h.ficha,a.ficha,h.noches,h.primera_noche].join('|'))")
{ [ "$(ls "$TMP/pend"/*/*.yaml | wc -l | tr -d ' ')" -eq 1 ] \
  && [ "$(sed -n '/^ids:/,/^[a-z_]*:/p' "$F9" | grep -c '^  - ')" -eq 2 ] \
  && [ "$(sed -n '/^avisos:/,$p' "$F9" | grep -c '^  - ')" -eq 2 ] \
  && grep -q "^noches: 2$" "$F9" && [ "$t9" = "0|1|true|$ID9|$ID9|2|2026-09-02" ] \
  && grep -q "anexado a la ficha" "$TMP/o.txt"; } \
  && ok "🔴 un aviso nuevo del mismo paquete se anexa a la ficha que ya está: un archivo, dos ids, y no consume el tope" \
  || no "T9: nació una ficha nueva por un aviso más — snap=$t9 · $(ls "$TMP/pend"/*/*.yaml | tr '\n' ' ')"

# ── T9b. 🔴 …y con el id viejo ausente la ficha NO se resuelve: `resuelto:` exige TODOS ────────
{ ! grep -q "^resuelto:" "$F9" && snap 2026-09-03 "process.exit(s.resueltos_ids.length===0?0:1)"; } \
  && ok "🔴 que desaparezca UN id no resuelve la ficha: la vulnerabilidad sigue ahí con otro nombre" \
  || no "T9b: se resolvió por el id viejo ausente — $(grep '^resuelto' "$F9")"

# ── T10. con TODOS los ids ausentes sí se resuelve; con uno presente, sigue viva ───────────────
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-t9.json" 2026-09-04 >/dev/null   # vuelve sólo el viejo
[ -f "$F9" ] && ! grep -q "^resuelto:" "$F9" \
  && ok "con uno de sus dos ids presente la ficha sigue viva" \
  || no "T10a: se resolvió con un id presente"
echo "$LIMPIO" > "$TMP/fix/A.json"; noche "$TMP/c-t9.json" 2026-09-05 >/dev/null
{ grep -q "^resuelto: 2026-09-05$" "$TMP/pend/promoted/$ID9.yaml" 2>/dev/null \
  || grep -q "^resuelto: 2026-09-05$" "$F9" 2>/dev/null; } \
  && ok "…y cuando ninguno de sus ids aparece, se resuelve" \
  || no "T10b: no se resolvió con los dos ids ausentes — $(ls "$TMP/pend"/*/*.yaml | tr '\n' ' ')"

# ── T11. 🔴 el mismo paquete en OTRO proyecto de Azure NO se anexa: son dos fichas ─────────────
# El pedido de trabajo es uno por proyecto, así que `js-yaml` en Globex y en Acme son dos fichas
# con dos dueños. Anexar por paquete a secas las fundiría en una sola, con un dueño equivocado.
rm -rf "$TMP/out" "$TMP/pend"; mundo A B
echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/B.json"
configx "$TMP/c-t11.json" 4 "A|ProyA/A" "B|Proy%20B/B"
noche "$TMP/c-t11.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; echo "$DOSAV" > "$TMP/fix/B.json"   # mismo paquete, avisos distintos
noche "$TMP/c-t11.json" 2026-09-02 >/dev/null
{ [ "$(ls "$TMP/pend/pending"/*.yaml | wc -l | tr -d ' ')" -eq 2 ] \
  && snap 2026-09-02 "process.exit((s.anexados||[]).length===0&&s.anunciados_hoy.length===2?0:1)"; } \
  && ok "🔴 el mismo paquete en dos proyectos de Azure distintos son DOS fichas: no se anexan" \
  || no "T11: se fundieron en una ficha — $(ls "$TMP/pend"/*/*.yaml | tr '\n' ' ')"

# ── T12. una ficha RESUELTA cuyo hallazgo vuelve se reactiva: no nace un segundo archivo ───────
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; configx "$TMP/c-t12.json" 2 A
noche "$TMP/c-t12.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-t12.json" 2026-09-02 >/dev/null
ID12=$(basename "$(unaficha pending)" .yaml); aceptar "$ID12"
echo "$LIMPIO" > "$TMP/fix/A.json"; noche "$TMP/c-t12.json" 2026-09-03 >/dev/null   # se arregla
grep -q "^resuelto: 2026-09-03$" "$TMP/pend/promoted/$ID12.yaml" || no "T12: no se resolvió primero"
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-t12.json" 2026-09-04 >/dev/null      # y vuelve
F12="$TMP/pend/pending/$ID12.yaml"
{ [ -f "$F12" ] && [ "$(ls "$TMP/pend"/*/*.yaml | wc -l | tr -d ' ')" -eq 1 ] \
  && grep -q "^veredicto: pendiente$" "$F12" && grep -q "^reaparecido: 2026-09-04$" "$F12" \
  && grep -q "^resuelto_antes: 2026-09-03$" "$F12" && ! grep -q "^resuelto:" "$F12" \
  && snap 2026-09-04 "process.exit(s.reaparecidos_ids.includes('$ID12')&&s.anunciados_hoy.includes('$ID12')?0:1)"; } \
  && ok "una ficha resuelta que reaparece se reactiva con su historia (\`resuelto_antes\`), y se anuncia de nuevo" \
  || no "T12: no se reactivó o nació un archivo nuevo — $(ls "$TMP/pend"/*/*.yaml | tr '\n' ' ')"

# ── T12b. 🔴 y si lo que vuelve es un id NUEVO, lo anunciado es el id de la FICHA ──────────────
# El pipeline abre el pull request buscando `pending/<id>.yaml`. Si se anunciara el id nuevo, no
# encontraría el archivo y saltearía el pull request en silencio: la ficha reactivada sin aviso.
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; configx "$TMP/c-t12b.json" 2 A
noche "$TMP/c-t12b.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-t12b.json" 2026-09-02 >/dev/null
IDB=$(basename "$(unaficha pending)" .yaml); aceptar "$IDB"
echo "$LIMPIO" > "$TMP/fix/A.json"; noche "$TMP/c-t12b.json" 2026-09-03 >/dev/null
echo "$DOSAV" > "$TMP/fix/A.json"; noche "$TMP/c-t12b.json" 2026-09-04 >/dev/null   # vuelve con OTRO id
FB="$TMP/pend/pending/$IDB.yaml"
{ [ -f "$FB" ] && [ "$(ls "$TMP/pend"/*/*.yaml | wc -l | tr -d ' ')" -eq 1 ] \
  && [ "$(sed -n '/^ids:/,/^[a-z_]*:/p' "$FB" | grep -c '^  - ')" -eq 2 ] \
  && snap 2026-09-04 "process.exit(s.anunciados_hoy.length===1&&s.anunciados_hoy[0]==='$IDB'?0:1)"; } \
  && ok "🔴 una ficha cerrada que vuelve con OTRO aviso se reactiva y se anuncia con el id de la ficha (el que el pipeline busca)" \
  || no "T12b: se anunció el id nuevo o nació otro archivo — $(ls "$TMP/pend"/*/*.yaml | tr '\n' ' ') · $(snap 2026-09-04 'console.log(s.anunciados_hoy.join(","))')"

# ── T13. 🔴 los repos de una ficha se leen POR SECCIÓN, no "toda línea con guion" ─────────────
# Si `archivarResueltos` tomara cualquier `  - x` que no fuera una URL como si fuera un repo, con la
# lista `ids:` un identificador se exigiría "medido" — y como un id nunca va a estar entre los repos
# medidos, la ficha NO SE RESOLVERÍA NUNCA. El defecto aparecería sobre las fichas que crea esa misma lista.
rm -rf "$TMP/out" "$TMP/pend"; mundo A B
echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/B.json"
configx "$TMP/c-t13.json" 2 A B
noche "$TMP/c-t13.json" 2026-09-01 >/dev/null   # línea base con los dos repos limpios
mkdir -p "$TMP/pend/pending"
cat > "$TMP/pend/pending/abc12345.yaml" <<'FICHA'
id: abc12345
detectado: 2026-09-01
veredicto: pendiente
paquete: browserslist
severidad: high
noches: 1
ids:
  - abc12345
  - def67890
repos:
  - A/A
declarada_en:
  - B/B (vence 2026-12-31)
avisos:
  - https://x/GHSA-73wf
FICHA
noche "$TMP/c-t13.json" 2026-09-02 >/dev/null   # A y B medidos y limpios
{ ls "$TMP/pend/promoted/abc12345.yaml" >/dev/null 2>&1 \
  && grep -q "^resuelto: 2026-09-02$" "$TMP/pend/promoted/abc12345.yaml"; } \
  && ok "🔴 los repos de la ficha se leen por sección: un id de \`ids:\` no se exige 'medido' y la ficha se resuelve" \
  || no "T13: la ficha con ids:/declarada_en: no se resolvió con sus dos repos medidos y limpios — $(ls "$TMP/pend"/*/*.yaml 2>/dev/null | tr '\n' ' ')"

# ── T13b. …y los tres lectores externos siguen leyendo lo suyo ────────────────────────────────
# `pr-text` (lista por clave), y el regex escalar de dependencies-notice.js. Si una clave nueva
# (`ids:`, `declarada_en:`, `bloqueada_por:`, `resuelto_antes:`) los confundiera, el pull request
# nombraría identificadores como si fueran repos y el aviso del arranque mostraría basura.
F13="$TMP/pend/promoted/abc12345.yaml"
if [ -f "$F13" ]; then
  node "$NOC" pr-text --draft "$F13" > "$TMP/pr13.txt" 2>&1
  notice=$(node -e "const fs=require('fs');const t=fs.readFileSync('$F13','utf8');
    const c=(k)=>(t.match(new RegExp('^'+k+':\\\\s*(.+)\$','m'))||[,''])[1].trim();
    console.log([c('paquete'),c('severidad'),c('noches')].join('|'))")
  { grep -q "^- A/A$" "$TMP/pr13.txt" && ! grep -qE "^- (abc12345|def67890)$" "$TMP/pr13.txt" \
    && ! grep -q "^- B/B (vence" "$TMP/pr13.txt" && [ "$notice" = "browserslist|high|1" ]; } \
    && ok "…y el pull request y el aviso del arranque siguen leyendo lo suyo (repos reales, no ids)" \
    || no "T13b: un lector externo se comió una clave nueva — pr=$(grep '^- ' "$TMP/pr13.txt" | tr '\n' ' ') notice=$notice"
else
  no "T13b: no hay ficha que leer (T13 falló antes)"
fi

# ── T14. el snapshot publica lo que DECIDE, no sólo lo que anuncia ────────────────────────────
# Para que `report` cuente arreglos y no decisiones, hace falta que la corrida publique las presencias
# y las listas de cada clase. Vacías
# cuando no hubo nada — NUNCA ausentes: una clave que falta y una lista vacía no son lo mismo.
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; configx "$TMP/c-t14.json" 2 A
noche "$TMP/c-t14.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"
declarar A 2026-12-31 GHSA-73wf     # presente pero declarada: NO entra en hallazgos, SÍ en presencias
noche "$TMP/c-t14.json" 2026-09-02 >/dev/null
t14=$(snap 2026-09-02 "
  const claves=['presencias','descartados_ids','reaparecidos_ids','anexados','aceptadas_sin_resolver'];
  const faltan=claves.filter(k=>s[k]===undefined);
  const p=(s.presencias||[])[0]||{};
  const r=(p.repos||[])[0]||{};
  console.log([faltan.join(',')||'-', s.hallazgos.length, (s.presencias||[]).length,
               p.paquete, r.repo, r.declarada, r.vence].join('|'))")
[ "$t14" = "-|0|1|browserslist|A/A|true|2026-12-31" ] \
  && ok "🔴 el snapshot publica \`presencias\` (con declarada y vencimiento) y las cinco listas, aunque estén vacías" \
  || no "T14: el snapshot no publica lo que decide — $t14"

# ── T15. 🔴 `report` cuenta ARREGLOS, no decisiones ───────────────────────────────────────────
# "Trabajo real" no es TODA la carpeta promoted/, o sea toda ficha cuyo pull
# request alguien mergeó: mergearlo quiere decir "sí, hay que arreglarlo", no "está
# arreglado". Y una deuda declarada no es ni un arreglo ni un descarte: no entra al denominador.
rm -rf "$TMP/rep15"; mkdir -p "$TMP/rep15/pending" "$TMP/rep15/promoted" "$TMP/rep15/archived"
ficha15(){ # <carpeta> <id> <líneas extra…>
  local d="$1" i="$2"; shift 2
  { echo "id: $i"; echo "detectado: 2026-09-01"; echo "paquete: browserslist"; echo "severidad: high"
    echo "noches: 1"; for l in "$@"; do echo "$l"; done
    echo "repos:"; echo "  - A/A"; } > "$TMP/rep15/$d/$i.yaml"
}
ficha15 promoted arreglada 'veredicto: util' 'resuelto: 2026-09-05' 'motivo: "dejó de aparecer"'
ficha15 promoted aceptada  'veredicto: util'
ficha15 promoted trabada   'veredicto: util' 'bloqueada_por: "repo apagado: B/B"'
ficha15 archived porpersona 'veredicto: descartado' 'descartado: 2026-09-05' 'motivo: "no viaja al navegador"'
ficha15 archived pordeuda   'veredicto: descartado' 'descartado: 2026-09-05' 'motivo: "declarada como deuda en A/A (vence 2026-12-31)"'
ficha15 archived nadielamiro 'veredicto: ignorado'
ficha15 pending  esperando   'veredicto: pendiente'
node "$NOC" report --pending "$TMP/rep15" --json > "$TMP/r15.json" 2>&1
r15=$(node -e "const r=require('$TMP/r15.json');console.log([r.total,r.trabajo_real,r.aceptadas_sin_resolver,
  r.bloqueadas_por_repo_apagado,r.descartadas,r.descartadas_por_deuda,r.ignoradas,r.pendientes,
  ('util' in r)?'TIENE-util':'sin-util'].join('|'))")
[ "$r15" = "7|1|2|1|1|1|1|1|sin-util" ] \
  && ok "🔴 \`report\` cuenta arreglos: 1 trabajo real, 2 aceptadas sin resolver (1 trabada), y la deuda declarada aparte" \
  || no "T15: los contadores no separan arreglo de decisión — $r15"

# …y lo descartado por deuda NO entra en el denominador de las reglas de retiro.
node "$NOC" report --pending "$TMP/rep15" > "$TMP/r15.txt" 2>&1
{ grep -q "Trabajo real           : 1" "$TMP/r15.txt" \
  && grep -q "Aceptadas sin resolver : 2" "$TMP/r15.txt" \
  && grep -q "bloqueada(s) por repo apagado" "$TMP/r15.txt" \
  && grep -q "no cuenta en el denominador" "$TMP/r15.txt"; } \
  && ok "…y lo dice en castellano, con la deuda declarada fuera del denominador" \
  || no "T15b: el texto no explica los contadores — $(grep -E 'Trabajo|Aceptadas|deuda' "$TMP/r15.txt" | tr '\n' ' ')"

# ── T18. 🔴 DOS avisos nuevos del mismo paquete y proyecto en UNA MISMA noche ──────────────────
# La lista de fichas se lee UNA
# vez antes del bucle: sin cuidado, el segundo anexo escribiría sobre el texto que leyó al principio y
# PISARÍA al primero en disco. El resumen diría "los dos anexados" y el archivo tendría uno solo: el
# identificador perdido quedaría marcado como anunciado, sin pull request, y nadie se enteraría.
rm -rf "$TMP/out" "$TMP/pend"; mundo A B
echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/B.json"
configx "$TMP/c-t18.json" 4 "A|ProyX/A" "B|ProyX/B"       # 🔴 el MISMO proyecto de Azure
noche "$TMP/c-t18.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-t18.json" 2026-09-02 >/dev/null
ID18=$(basename "$(unaficha pending)" .yaml)
# Esta noche aparecen DOS huellas nuevas del mismo paquete, las dos en ProyX
echo "$DOSAV" > "$TMP/fix/A.json"
echo '{"vulnerabilities":{"browserslist":{"severity":"high","via":[{"url":"https://x/GHSA-tercero"}]}},"metadata":{"vulnerabilities":{"critical":0,"high":1,"moderate":0,"low":0}}}' > "$TMP/fix/B.json"
noche "$TMP/c-t18.json" 2026-09-03 >/dev/null
F18="$TMP/pend/pending/$ID18.yaml"
n18=$(sed -n '/^ids:/,/^[a-z_]*:/p' "$F18" 2>/dev/null | grep -c '^  - ')
anex=$(snap 2026-09-03 "console.log((s.anexados||[]).length)")
{ [ "$(ls "$TMP/pend"/*/*.yaml | wc -l | tr -d ' ')" -eq 1 ] && [ "$n18" -eq 3 ] && [ "$anex" = "2" ] \
  && grep -q "GHSA-tercero" "$F18" && grep -q "GHSA-nuevo" "$F18"; } \
  && ok "🔴 dos avisos nuevos del mismo paquete y proyecto en la misma noche se anexan LOS DOS: ninguno se pisa" \
  || no "T18: un anexo pisó al otro — ids=$n18 (esperado 3) anexados=$anex · $(ls "$TMP/pend"/*/*.yaml | tr '\n' ' ')"

# ── T18b. 🔴 …y dos que reactivan la MISMA ficha cerrada no rompen la corrida ─────────────────
# Mismo origen: la segunda reactivación intentaría borrar un archivo que la primera ya movió
# → excepción sin capturar → la corrida entera se caería, con los repos ya auditados y nada escrito.
rm -rf "$TMP/out" "$TMP/pend"; mundo A B
echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/B.json"
configx "$TMP/c-t18b.json" 4 "A|ProyX/A" "B|ProyX/B"
noche "$TMP/c-t18b.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-t18b.json" 2026-09-02 >/dev/null
IDC=$(basename "$(unaficha pending)" .yaml); aceptar "$IDC"
echo "$LIMPIO" > "$TMP/fix/A.json"; noche "$TMP/c-t18b.json" 2026-09-03 >/dev/null   # se resuelve
grep -q "^resuelto:" "$TMP/pend/promoted/$IDC.yaml" || no "T18b: no se resolvió antes de reaparecer"
echo "$DOSAV" > "$TMP/fix/A.json"
echo '{"vulnerabilities":{"browserslist":{"severity":"high","via":[{"url":"https://x/GHSA-tercero"}]}},"metadata":{"vulnerabilities":{"critical":0,"high":1,"moderate":0,"low":0}}}' > "$TMP/fix/B.json"
rc18=$(noche "$TMP/c-t18b.json" 2026-09-04)
nC=$(sed -n '/^ids:/,/^[a-z_]*:/p' "$TMP/pend/pending/$IDC.yaml" 2>/dev/null | grep -c '^  - ')
{ [ "$rc18" -eq 0 ] && [ -f "$TMP/pend/pending/$IDC.yaml" ] \
  && [ "$(ls "$TMP/pend"/*/*.yaml | wc -l | tr -d ' ')" -eq 1 ] && [ "$nC" -eq 3 ] \
  && grep -q "^reaparecido: 2026-09-04$" "$TMP/pend/pending/$IDC.yaml"; } \
  && ok "🔴 dos avisos que reactivan la misma ficha cerrada no rompen la ejecución: una reactivación, los dos ids" \
  || no "T18b: la corrida se cayó o duplicó la ficha — rc=$rc18 ids=$nC · $(ls "$TMP/pend"/*/*.yaml 2>/dev/null | tr '\n' ' ')"

# ── T19. 🔴 un repo que NO SE MIDIÓ no puede desaparecer de la ficha ───────────────────────────
# El refresco de los hechos escribe `repos:`
# con los repos donde el paquete está PRESENTE, y un repo que no se pudo medir no está presente en
# ningún lado: si se borrara del archivo, la noche siguiente ese repo ya no sería "de la ficha", no
# bloquearía, y la ficha se resolvería SIN HABERLO MIRADO NUNCA — el «no medido = limpio» que esta pieza
# existe para evitar. Hacen falta dos noches, no una: por eso T3
# (que mira una sola noche) lo esquiva.
rm -rf "$TMP/out" "$TMP/pend"; mundo A B
echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/B.json"; configx "$TMP/c-t19.json" 2 A B
noche "$TMP/c-t19.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; echo "$UNA" > "$TMP/fix/B.json"; noche "$TMP/c-t19.json" 2026-09-02 >/dev/null
ID19=$(basename "$(unaficha pending)" .yaml); F19="$TMP/pend/pending/$ID19.yaml"
grep -q "^  - B/B$" "$F19" || no "T19: la ficha debería nacer con los dos repos"
# Noche 3: B desaparece del mundo (NO se mide). A sigue enfermo → la ficha sigue viva.
rm -rf "$TMP/mundo/B"; noche "$TMP/c-t19.json" 2026-09-03 >/dev/null
grep -q "^  - B/B$" "$F19" \
  && ok "🔴 un repo sin medir SIGUE en la ficha: no se borra por no haberse podido mirar" \
  || no "T19: el repo sin medir desapareció de la ficha — $(sed -n '/^repos:/,/^[a-z_]*:/p' "$F19" | tr '\n' ' ')"
# Noche 4: A se cura, B SIGUE sin medirse → NO puede resolverse.
echo "$LIMPIO" > "$TMP/fix/A.json"; noche "$TMP/c-t19.json" 2026-09-04 >/dev/null
{ [ -f "$F19" ] && ! grep -q "^resuelto:" "$F19" && ! ls "$TMP/pend/promoted"/*.yaml >/dev/null 2>&1; } \
  && ok "🔴 …y dos noches después sigue sin resolverse: ese repo nunca se miró" \
  || no "T19b: se resolvió con un repo que jamás se midió — $(ls "$TMP/pend"/*/*.yaml 2>/dev/null | tr '\n' ' ')"

# ── T20. 🔴 una ficha que REAPARECE no se archiva como ignorada la misma noche ────────────────
# Es el caso NORMAL, no el raro: una ficha
# conserva su `detectado:` al reactivarse y una deuda vence a meses, así que casi toda
# reaparición llega con más de 7 días encima. Si la reactivación y el archivado como ignorada pasaran
# la MISMA noche, la ficha quedaría en `anunciados_hoy` pero fuera de `pending/`, el pipeline la
# saltearía diciendo «no está el borrador», y la noche siguiente el hallazgo heredaría
# `anunciado: true` — así que no se anunciaría NUNCA MÁS. La vulnerabilidad vuelve, nadie recibiría su
# pull request, y la medición la contaría como «nadie la miró».
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; configx "$TMP/c-t20.json" 2 A
noche "$TMP/c-t20.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-t20.json" 2026-09-02 >/dev/null
ID20=$(basename "$(unaficha pending)" .yaml); aceptar "$ID20"
echo "$LIMPIO" > "$TMP/fix/A.json"; noche "$TMP/c-t20.json" 2026-09-03 >/dev/null   # se resuelve
grep -q "^resuelto:" "$TMP/pend/promoted/$ID20.yaml" || no "T20: no se resolvió antes de reaparecer"
# Pasan 9 días limpios y la vulnerabilidad VUELVE: `detectado:` es del 09-02, hace 10 días.
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-t20.json" 2026-09-12 >/dev/null
F20="$TMP/pend/pending/$ID20.yaml"
t20=$(snap 2026-09-12 "console.log([s.anunciados_hoy.join(','),(s.ignorados_ids||[]).length,(s.reaparecidos_ids||[]).length].join('|'))")
{ [ -f "$F20" ] && grep -q "^veredicto: pendiente$" "$F20" && grep -q "^reaparecido: 2026-09-12$" "$F20" \
  && [ "$t20" = "$ID20|0|1" ] && ! ls "$TMP/pend/archived"/*.yaml >/dev/null 2>&1; } \
  && ok "🔴 una ficha que reaparece con más de 7 días encima queda en pending/, no se archiva como ignorada esa misma noche" \
  || no "T20: la reactivación se archivó como ignorada al instante — snap=$t20 · $(ls "$TMP/pend"/*/*.yaml 2>/dev/null | tr '\n' ' ')"

# ── T20b. …y el reloj de «ignorado» arranca de nuevo: 7 días DESPUÉS de reaparecer ────────────
noche "$TMP/c-t20.json" 2026-09-18 >/dev/null      # 6 días desde que reapareció: todavía no
[ -f "$F20" ] && ok "a los 6 días de reaparecer sigue esperando decisión" \
  || no "T20b: se archivó antes de los 7 días desde la reaparición"
noche "$TMP/c-t20.json" 2026-09-20 >/dev/null      # 8 días desde que reapareció: ahora sí
{ ls "$TMP/pend/archived/$ID20.yaml" >/dev/null 2>&1 && grep -q "^veredicto: ignorado$" "$TMP/pend/archived/$ID20.yaml"; } \
  && ok "…y a los 8 sí se archiva como ignorada: el corte de 7 días no cambió, cambió desde cuándo se cuenta" \
  || no "T20c: no se archivó a los 8 días de reaparecer — $(ls "$TMP/pend"/*/*.yaml 2>/dev/null | tr '\n' ' ')"

# ── T21. `proyectoDe` se prueba DIRECTO: es un contrato que otras piezas reusan ────────────────
# Sus dos ramas se ejecutan en T11 pero ninguna aserción
# depende del resultado — con el decodificado roto, T11 pasaría igual. Un contrato hacia otra
# pieza que nadie asserta es un contrato que se rompe sin que nadie se entere.
t21=$(node -e "
const m=require('$NOC');
const cfg={repos:[
  {producto:'A',ruta:'A',ado:'ProyA/A'},
  {producto:'B',ruta:'B',ado:'Acme%20Web/AcmeWebSite'},
  {producto:'C',ruta:'C'},
  {producto:'D',ruta:'D',ado:'Globex/BackEnd',subruta:'tools/gw'}]};
console.log([
  m.proyectoDe('A/A',cfg),                 // por ado
  m.proyectoDe('B/B',cfg),                 // 🔴 decodificado: Acme%20Web -> 'Acme Web'
  m.proyectoDe('C/C',cfg),                 // sin ado -> el producto
  m.proyectoDe('D/D/tools/gw',cfg),        // etiqueta con subcarpeta
  m.proyectoDe('Z/Z',cfg),                 // sin entrada en la config -> primer segmento
  m.proyectoDe('X/X',null)                 // sin config -> no explota
].join('|'))" 2>&1)
[ "$t21" = "ProyA|Acme Web|C|Globex|Z|X" ] \
  && ok "\`proyectoDe\` decodifica el nombre del proyecto y resuelve sus cinco caminos (contrato de la story 4.4)" \
  || no "T21: proyectoDe no resuelve como promete — $t21"

# ── T22. `--dry-run` dice qué haría y NO escribe nada ─────────────────────────────────────────
# Sin caso, un `--dry-run`
# que empezara a escribir fichas no lo notaría nadie — y es la bandera que alguien usa justamente
# para mirar sin tocar.
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; configx "$TMP/c-t22.json" 2 A
noche "$TMP/c-t22.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-t22.json" 2026-09-02 >/dev/null
antes=$(find "$TMP/pend" "$TMP/out" -type f 2>/dev/null | sort | xargs shasum -a 256 2>/dev/null | shasum -a 256)
FIX="$TMP/fix" TYCON_DEP_CMD="$TMP/doble.sh" node "$NOC" run --config "$TMP/c-t22.json" \
  --out "$TMP/out" --pending "$TMP/pend" --today 2026-09-03 --dry-run > "$TMP/dry.txt" 2>&1
rcdry=$?
despues=$(find "$TMP/pend" "$TMP/out" -type f 2>/dev/null | sort | xargs shasum -a 256 2>/dev/null | shasum -a 256)
{ [ "$rcdry" -eq 0 ] && [ "$antes" = "$despues" ] && grep -qi "browserslist" "$TMP/dry.txt" \
  && ! ls "$TMP/out/dependencias-2026-09-03.json" >/dev/null 2>&1; } \
  && ok "\`--dry-run\` informa lo que encontró y no escribe NADA: ni ficha, ni snapshot" \
  || no "T22: --dry-run tocó el disco o no informó — rc=$rcdry · $(head -3 "$TMP/dry.txt" | tr '\n' ' ')"

# ── T23. una ficha SIN la clave `ids:` se vigila igual: es la forma de las fichas ya existentes ──
# Las fichas existentes no tienen `ids:`. Si la lectura no
# tratara su ausencia como «un solo identificador, el suyo», la primera noche se
# romperían o se resolverían TODAS. T13 prueba la ficha CON la clave; ésta prueba la que no la tiene.
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; configx "$TMP/c-t23.json" 2 A
noche "$TMP/c-t23.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-t23.json" 2026-09-02 >/dev/null
ID23=$(basename "$(unaficha pending)" .yaml)
# La dejamos EXACTAMENTE como las de hoy: aceptada, y sin la clave `ids:`
aceptar "$ID23"; F23="$TMP/pend/promoted/$ID23.yaml"
python3 - "$F23" <<'PYX'
import sys,re
p=sys.argv[1]; t=open(p,encoding='utf8').read()
t=re.sub(r'^ids:\n(?:\s+-\s+.*\n)+','',t,flags=re.M)      # la forma de las fichas anteriores a la story
open(p,'w',encoding='utf8').write(t)
PYX
grep -q "^ids:" "$F23" && no "T23: el fixture debía quedar SIN ids:"
# Sigue vigilada: esta noche el hallazgo persiste → se refresca
noche "$TMP/c-t23.json" 2026-09-03 >/dev/null
grep -q "^noches: 2$" "$F23" || no "T23: una ficha sin ids: dejó de refrescarse"
# Y cuando la vulnerabilidad desaparece, se resuelve por su propio id
echo "$LIMPIO" > "$TMP/fix/A.json"; noche "$TMP/c-t23.json" 2026-09-04 >/dev/null
{ grep -q "^resuelto: 2026-09-04$" "$F23" && snap 2026-09-04 "process.exit(s.resueltos_ids.includes('$ID23')?0:1)"; } \
  && ok "una ficha sin la clave \`ids:\` (la forma de las 5 que ya existen) se vigila y se resuelve por su propio id" \
  || no "T23: la ficha sin ids: no se resolvió — $(grep -E '^(noches|resuelto)' "$F23" | tr '\n' ' ')"

# ── T24. 🔴 una ficha resuelta en una noche INCOMPLETA que vuelve, se reactiva igual ───────────
# Hay DOS líneas base distintas que conviene mirar juntas: la
# resolución se decide por ficha CUALQUIER noche, pero la reactivación sale de la lista de
# anuncios, que hereda `anunciado: true` del último snapshot COMPLETO. Basta que UN repo de los 20
# no se mida la noche en que otra ficha se cura: esa ficha queda `resuelto:` PARA SIEMPRE aunque la
# vulnerabilidad vuelva, `report` la cuenta como trabajo real, y nadie vuelve a ser avisado.
rm -rf "$TMP/out" "$TMP/pend"; mundo A B
echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/B.json"
configx "$TMP/c-t24.json" 2 "A|ProyX/A" "B|ProyY/B"
noche "$TMP/c-t24.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-t24.json" 2026-09-02 >/dev/null
ID24=$(basename "$(unaficha pending)" .yaml); aceptar "$ID24"
# Noche 3: A se cura y B NO se mide → la ficha se resuelve, pero la noche queda INCOMPLETA
echo "$LIMPIO" > "$TMP/fix/A.json"; mv "$TMP/mundo/B" "$TMP/mundo/B.off"
noche "$TMP/c-t24.json" 2026-09-03 >/dev/null
grep -q "^resuelto: 2026-09-03$" "$TMP/pend/promoted/$ID24.yaml" || no "T24: no se resolvió en la noche 3"
snap 2026-09-03 "process.exit(s.corrida_completa===false?0:1)" || no "T24: la noche 3 debía quedar incompleta"
# Noche 4: B vuelve y la vulnerabilidad TAMBIÉN vuelve en A. Tiene que reactivarse.
mv "$TMP/mundo/B.off" "$TMP/mundo/B"; echo "$UNA" > "$TMP/fix/A.json"
noche "$TMP/c-t24.json" 2026-09-04 >/dev/null
F24="$TMP/pend/pending/$ID24.yaml"
{ [ -f "$F24" ] && grep -q "^veredicto: pendiente$" "$F24" && grep -q "^reaparecido: 2026-09-04$" "$F24" \
  && grep -q "^resuelto_antes: 2026-09-03$" "$F24" && ! grep -q "^resuelto:" "$F24" \
  && snap 2026-09-04 "process.exit(s.reaparecidos_ids.includes('$ID24')?0:1)"; } \
  && ok "🔴 una ficha resuelta en una noche incompleta se reactiva igual cuando la vulnerabilidad vuelve" \
  || no "T24: quedó resuelta con la vulnerabilidad viva — $(ls "$TMP/pend"/*/*.yaml | tr '\n' ' ') · $(grep -E '^(veredicto|resuelto)' "$TMP/pend"/*/"$ID24.yaml" | tr '\n' ' ')"

# ── T25. 🔴 un identificador que NACE declarado no puede leerse como «ya no está» ──────────────
# La declaración ampara por AVISO, no por severidad: si el mismo aviso
# se re-puntúa de alto a crítico, nace otra huella —ya amparada— que nunca entra a la lista de
# anuncios (lo declarado no despierta a nadie) y por lo tanto nunca se anexa a la ficha. La ficha
# no la ve, cree que su paquete desapareció, y escribe `resuelto:` donde correspondía «descartado
# por deuda». Es el defecto de la deuda contada como arreglo entrando por otra puerta.
CRIT='{"vulnerabilities":{"browserslist":{"severity":"critical","via":[{"url":"https://x/GHSA-73wf"}]}},"metadata":{"vulnerabilities":{"critical":1,"high":0,"moderate":0,"low":0}}}'
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; configx "$TMP/c-t25.json" 2 A
noche "$TMP/c-t25.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-t25.json" 2026-09-02 >/dev/null
ID25=$(basename "$(unaficha pending)" .yaml); aceptar "$ID25"
# Misma noche: se declara la deuda Y el mismo aviso se re-puntúa a crítico (otra huella, ya amparada)
declarar A 2026-12-31 GHSA-73wf; echo "$CRIT" > "$TMP/fix/A.json"
noche "$TMP/c-t25.json" 2026-09-03 >/dev/null
{ ! grep -rq "^resuelto:" "$TMP/pend" \
  && [ -f "$TMP/pend/archived/$ID25.yaml" ] \
  && grep -q "^veredicto: descartado$" "$TMP/pend/archived/$ID25.yaml" \
  && grep -q '^motivo: "declarada como deuda en A/A (vence 2026-12-31)"$' "$TMP/pend/archived/$ID25.yaml" \
  && snap 2026-09-03 "process.exit(s.descartados_ids.includes('$ID25')&&s.resueltos_ids.length===0?0:1)"; } \
  && ok "🔴 un aviso re-puntuado que nace ya declarado se ve como deuda, no como arreglo" \
  || no "T25: la deuda declarada se contó como trabajo real — $(ls "$TMP/pend"/*/*.yaml | tr '\n' ' ') · $(grep -E '^(veredicto|resuelto|motivo)' "$TMP/pend"/*/"$ID25.yaml" | tr '\n' ' ')"

# ══════════════════════════════════════════════════════════════════════════════════════════════
# El pull request recordado. `note` es el ÚNICO que escribe la ficha: el guion
# compartido del pipeline (scripts/ci/open-pr-per-finding.sh) decide y delega, nunca hace `sed`.
# ══════════════════════════════════════════════════════════════════════════════════════════════

# Una ficha de dependencias como la escribe el nocturno, con un comentario de una persona al pie.
fichafalsa(){ cat > "$1" <<'FICHA'
id: aa11bb22
detectado: 2026-09-05
veredicto: pendiente
paquete: browserslist
severidad: high
noches: 3
ids:
  - aa11bb22
repos:
  - A/A
avisos:
  - https://x/GHSA-73wf

# la nota de una persona que NO se puede perder
FICHA
}
note(){ node "$NOC" note "$@" >"$TMP/an.txt" 2>&1; echo $?; }

# ── U1. `note --pr` escribe la identidad del pull request en la ficha ────────────────
# Sin esto la relación ficha↔PR vive SÓLO en el nombre de la rama, y "no encontré PR activo" —que
# también es lo que devuelve una consulta que falló— se lee como "nunca tuvo": un PR por noche.
F1="$TMP/u1.yaml"; fichafalsa "$F1"
rc=$(note --card "$F1" --pr 12)
antes=$(cat "$F1"); rc2=$(note --card "$F1" --pr 12)          # idempotente
rcmal=$(note --card "$F1" --pr abc)                            # un id no entero es error de uso
{ [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] && [ "$antes" = "$(cat "$F1")" ] && [ "$rcmal" -eq 2 ] \
  && grep -q '^pr: 12$' "$F1" \
  && [ "$(grep -n '^noches:' "$F1" | cut -d: -f1)" -lt "$(grep -n '^pr: 12$' "$F1" | cut -d: -f1)" ] \
  && grep -q '^# la nota de una persona' "$F1"; } \
  && ok "U1: la ficha recuerda su pull request (idempotente, entero obligatorio, sin tocar comentarios)" \
  || no "U1: rc=$rc rc2=$rc2 rcmal=$rcmal · $(grep -E '^(noches|pr)' "$F1" | tr '\n' ' ')"

# ── U2. el motivo del rechazo entra ENTERO y en UNA línea ──────────────────────────────
# 🔴 El comentario de una persona trae saltos de línea, comillas y `#`. En varias líneas rompe a
# los CUATRO lectores por expresión regular de la ficha; con `#` sin comillas, `leerFicha` lo
# cortaría por la mitad y el motivo quedaría mutilado justo en el dato que explica la decisión.
F2="$TMP/u2.yaml"; fichafalsa "$F2"
LARGO="no viaja al navegador
lo probé con \"dos\" navegadores # y anda"
rc=$(note --card "$F2" --rejected 2026-09-06 --reason "$LARGO" --pr 7)
LINEAS=$(grep -c '^motivo_rechazo:' "$F2")
LEIDO=$(node -e "const{leerFicha}=require('$NOC');console.log(leerFicha(require('fs').readFileSync('$F2','utf8')).escalares.motivo_rechazo)")
LEN=$(printf '%s' "$LEIDO" | wc -c | tr -d ' ')
grep -q "^rechazado: 2026-09-06$" "$F2" && tiene_fecha=1 || tiene_fecha=0
rcq=$(note --card "$F2" --clear-rejection)
{ [ "$rc" -eq 0 ] && [ "$LINEAS" -eq 1 ] && [ "$LEN" -le 200 ] && [ "$tiene_fecha" -eq 1 ] \
  && case "$LEIDO" in *"no viaja al navegador"*"y anda"*) true ;; *) false ;; esac \
  && [ "$rcq" -eq 0 ] && ! grep -q '^rechazado:' "$F2" && ! grep -q '^motivo_rechazo:' "$F2"; } \
  && ok "U2: el motivo del rechazo entra entero, en una línea y ≤200; --clear-rejection lo borra" \
  || no "U2: rc=$rc fecha=$tiene_fecha lineas=$LINEAS len=$LEN leido=«${LEIDO}» rcq=$rcq"

# ── U8. `--pr-closed` ─────────────────────────────────────────────────────────────────
F8="$TMP/u8.yaml"; fichafalsa "$F8"
rc=$(note --card "$F8" --pr-closed 2026-09-10); a8=$(cat "$F8")
rc2=$(note --card "$F8" --pr-closed 2026-09-10)
{ [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] && [ "$a8" = "$(cat "$F8")" ] && grep -q '^pr_cerrado: 2026-09-10$' "$F8"; } \
  && ok "U8: se anota cuándo se cerró el pull request de una archivada (idempotente)" \
  || no "U8: rc=$rc rc2=$rc2 · $(grep -E '^pr' "$F8" | tr '\n' ' ')"

# ── U1b. sin acción, o con una ficha que no está, es error de USO (no un cero silencioso) ──────
rcv=$(note --card "$F8"); rcx=$(note --card "$TMP/no-existe.yaml" --pr 1)
{ [ "$rcv" -eq 2 ] && [ "$rcx" -eq 2 ]; } \
  && ok "U1b: note sin acción o sobre una ficha ausente sale 2 con la ayuda" || no "U1b: $rcv/$rcx"

# ── U3. una ficha que REAPARECE corta la historia de su pull request ────────────────────
# La ficha reactivada tiene que recibir un PR NUEVO: si conservara `pr:`, el guion consultaría el
# PR de su vida anterior —completado— y no abriría nada. La historia no se pierde: se renombra.
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; configx "$TMP/c-u3.json" 2 A
noche "$TMP/c-u3.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-u3.json" 2026-09-02 >/dev/null
IDU3=$(basename "$(unaficha pending)" .yaml); aceptar "$IDU3"
FU3="$TMP/pend/promoted/$IDU3.yaml"
node "$NOC" note --card "$FU3" --pr 3058 >/dev/null 2>&1
node "$NOC" note --card "$FU3" --rejected 2026-09-06 --reason "x" --pr 3058 >/dev/null 2>&1
node "$NOC" note --card "$FU3" --pr-closed 2026-09-06 >/dev/null 2>&1
echo "$LIMPIO" > "$TMP/fix/A.json"; noche "$TMP/c-u3.json" 2026-09-03 >/dev/null   # se resuelve
echo "$UNA" > "$TMP/fix/A.json";    noche "$TMP/c-u3.json" 2026-09-04 >/dev/null   # y vuelve
RU3="$TMP/pend/pending/$IDU3.yaml"
{ [ -f "$RU3" ] && grep -q '^pr_antes: 3058$' "$RU3" && grep -q '^rechazado_antes: 2026-09-06$' "$RU3" \
  && grep -q '^motivo_rechazo_antes:' "$RU3" \
  && ! grep -q '^pr:' "$RU3" && ! grep -q '^pr_cerrado:' "$RU3" && ! grep -q '^rechazado:' "$RU3"; } \
  && ok "U3: 🔴 la ficha reactivada no arrastra su pull request viejo — la historia queda en los _antes" \
  || no "U3: $(grep -E '^(pr|rechazado|motivo_rechazo)' "$RU3" 2>/dev/null | tr '\n' ' ')"

# ── U4. RECHAZAR ES MIRAR: una rechazada no se archiva como ignorada ────────────────────
# `ignorado` cuenta PEOR que descartado porque mide "a nadie le importó". Una ficha cuyo PR una
# persona se tomó el trabajo de rechazar es exactamente lo contrario, y contarla ahí mentiría.
rm -rf "$TMP/out" "$TMP/pend"; mundo A B; echo "$LIMPIO" > "$TMP/fix/A.json"; cp "$TMP/fix/A.json" "$TMP/fix/B.json"
configx "$TMP/c-u4.json" 4 "A|ProyA/A" "B|ProyB/B"
noche "$TMP/c-u4.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; echo "$DOS" > "$TMP/fix/B.json"
noche "$TMP/c-u4.json" 2026-09-02 >/dev/null
CONR=$(grep -l 'ProyA/A\|A/A' "$TMP/pend/pending"/*.yaml 2>/dev/null | head -1)
[ -n "$CONR" ] || CONR=$(ls "$TMP/pend/pending"/*.yaml | head -1)
SINR=$(ls "$TMP/pend/pending"/*.yaml | grep -v "^$CONR$" | head -1)
node "$NOC" note --card "$CONR" --rejected 2026-09-02 --reason "lo miré y no aplica" --pr 7 >/dev/null 2>&1
noche "$TMP/c-u4.json" 2026-09-10 >/dev/null      # 8 días después de detectado
{ [ -f "$CONR" ] && [ ! -f "$SINR" ] && [ -f "$TMP/pend/archived/$(basename "$SINR")" ]; } \
  && ok "U4: 🔴 rechazar ES mirar — la rechazada no se archiva como ignorada, la otra sí" \
  || no "U4: rechazada=$([ -f "$CONR" ] && echo viva || echo archivada) otra=$([ -f "$SINR" ] && echo viva || echo archivada)"

# ── U5. una rechazada VIVA se publica: el rechazo no la saca de main ────────────────────
# Decisión 7 del dev: la vulnerabilidad es un hecho MEDIDO; rechazar el aviso no la arregla. Si no
# se publicara, una rechazada sería indistinguible de una resuelta en todos los contadores.
RIDS=$(snap 2026-09-10 "console.log(JSON.stringify(s.rechazadas_sin_deuda_ids||null))")
RJSON=$(node "$NOC" report --pending "$TMP/pend" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log(r.rechazadas_sin_deuda+'/'+r.pendientes)})")
RTXT=$(node "$NOC" report --pending "$TMP/pend" 2>/dev/null)
{ case "$RIDS" in *"$(basename "$CONR" .yaml)"*) true ;; *) false ;; esac \
  && grep -qi "rechazada" "$TMP/o.txt" && [ "$RJSON" = "1/1" ] \
  && case "$RTXT" in *"Rechazadas sin deuda"*"sigue viva"*) true ;; *) false ;; esac; } \
  && ok "U5: 🔴 una rechazada sin deuda declarada se publica y se cuenta — sigue viva" \
  || no "U5: ids=$RIDS report=$RJSON"

# ── U5b. la lista está SIEMPRE, aunque esté vacía ──────────────────────────────────────────────
# Una clave ausente y una lista vacía se leen igual desde afuera, y hay quien lee justo ésta.
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; configx "$TMP/c-u5b.json" 2 A
noche "$TMP/c-u5b.json" 2026-09-01 >/dev/null
snap 2026-09-01 "process.exit(Array.isArray(s.rechazadas_sin_deuda_ids)&&s.rechazadas_sin_deuda_ids.length===0?0:1)" \
  && ok "U5b: la lista de rechazadas está siempre presente, vacía cuando no hay" || no "U5b: falta la clave"

# ── U6. el pull request nuevo DICE que ya se rechazó antes, y por qué ───────────────────────
# Sin eso, quien lo recibe vuelve a decidir a ciegas lo mismo que ya decidió, y el arnés parece
# insistir sin memoria — la forma más rápida de que se deje de mirar la lista.
F6="$TMP/u6.yaml"; fichafalsa "$F6"
node -e "const f='$F6',fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/^noches: 3$/m,'noches: 3\npr_antes: 3058\nrechazado_antes: 2026-09-06\nmotivo_rechazo_antes: \"no aplica a este repo\"'))"
T6=$(node "$NOC" pr-text --draft "$F6" 2>&1)
F6b="$TMP/u6b.yaml"; fichafalsa "$F6b"; T6b=$(node "$NOC" pr-text --draft "$F6b" 2>&1)
{ case "$T6" in *"Ya se había rechazado el 2026-09-06"*"3058"*"no aplica a este repo"*) true ;; *) false ;; esac \
  && case "$T6b" in *"Ya se había rechazado"*) false ;; *) true ;; esac; } \
  && ok "U6: el pull request de una ficha reactivada avisa que ya se había rechazado, y por qué" \
  || no "U6: $(printf '%s' "$T6" | grep -i rechaz | head -2 | tr '\n' ' ')"

# ── U7. rechazar NO impide que la deuda declarada la archive ───────────────────────────────────
# La única salida de una rechazada es la medición o la deuda en TODOS sus
# repos. Si el rechazo bloqueara el descarte, la ficha quedaría viva para siempre.
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; configx "$TMP/c-u7.json" 2 A
noche "$TMP/c-u7.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-u7.json" 2026-09-02 >/dev/null
IDU7=$(basename "$(unaficha pending)" .yaml)
node "$NOC" note --card "$TMP/pend/pending/$IDU7.yaml" --rejected 2026-09-02 --reason "no" --pr 9 >/dev/null 2>&1
declarar A 2026-12-31 GHSA-73wf
noche "$TMP/c-u7.json" 2026-09-03 >/dev/null
{ [ -f "$TMP/pend/archived/$IDU7.yaml" ] && grep -q '^veredicto: descartado$' "$TMP/pend/archived/$IDU7.yaml" \
  && snap 2026-09-03 "process.exit(s.rechazadas_sin_deuda_ids.length===0?0:1)"; } \
  && ok "U7: la deuda declarada archiva igual a una rechazada, y sale de la lista de rechazadas" \
  || no "U7: $(ls "$TMP/pend"/*/*.yaml | tr '\n' ' ')"

# ── U9. 🔴 una rechazada VIVA no desaparece porque un repo no se midió ─────────────────────────
# Si la publicación estuviera en la última rama del recorrido,
# después del `continue` de la primera, una noche con un repo apagado dejaría la lista VACÍA
# —el cero silencioso que esta pieza existe para no cometer— y contradiría a `report`, que sí la
# cuenta. El hecho es de la FICHA, no de la noche: está rechazada y sigue viva.
rm -rf "$TMP/out" "$TMP/pend"; mundo A B; echo "$LIMPIO" > "$TMP/fix/A.json"; cp "$TMP/fix/A.json" "$TMP/fix/B.json"
configx "$TMP/c-u9.json" 2 A B
noche "$TMP/c-u9.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; cp "$TMP/fix/A.json" "$TMP/fix/B.json"
noche "$TMP/c-u9.json" 2026-09-02 >/dev/null
ID9=$(basename "$(unaficha pending)" .yaml)
node "$NOC" note --card "$TMP/pend/pending/$ID9.yaml" --rejected 2026-09-02 --reason "no aplica" --pr 77 >/dev/null 2>&1
noche "$TMP/c-u9.json" 2026-09-03 >/dev/null              # las dos medidas: aparece
CON=$(snap 2026-09-03 "console.log(s.rechazadas_sin_deuda_ids.join(','))")
configx "$TMP/c-u9b.json" 2 A "B|ProyB/B|off"             # B apagado a propósito
noche "$TMP/c-u9b.json" 2026-09-04 >/dev/null
SIN=$(snap 2026-09-04 "console.log(s.rechazadas_sin_deuda_ids.join(','))")
REP=$(node "$NOC" report --pending "$TMP/pend" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).rechazadas_sin_deuda))")
{ [ "$CON" = "$ID9" ] && [ "$SIN" = "$ID9" ] && [ "$REP" = "1" ] && [ -f "$TMP/pend/pending/$ID9.yaml" ]; } \
  && ok "U9: 🔴 una rechazada viva se publica igual la noche en que un repo no se midió" \
  || no "U9: medidas=«${CON}» con-repo-apagado=«${SIN}» report=$REP"

# ── U10. …pero la que se CIERRA esa misma noche sí sale de la lista ───────────────────────────
# Publicar antes de decidir no puede convertirse en publicar de más: una rechazada cuya deuda se
# declara en todos sus repos se archiva, y ahí ya no es una rechazada viva.
declarar A 2026-12-31 GHSA-73wf; declarar B 2026-12-31 GHSA-73wf
noche "$TMP/c-u9.json" 2026-09-05 >/dev/null
{ snap 2026-09-05 "process.exit(s.rechazadas_sin_deuda_ids.length===0?0:1)" \
  && [ -f "$TMP/pend/archived/$ID9.yaml" ]; } \
  && ok "U10: la rechazada que se archiva por deuda sale de la lista esa misma noche" \
  || no "U10: $(snap 2026-09-05 "console.log(JSON.stringify(s.rechazadas_sin_deuda_ids))") · $(ls "$TMP/pend"/*/*.yaml | tr '\n' ' ')"

# ── U11. 🔴 un valor con `$&` o `$'` no se interpreta al REESCRIBIR una clave ─────────────────
# `String.replace` interpreta esos patrones en la cadena de reemplazo, y el valor acá es el motivo
# de un rechazo: texto escrito por cualquiera que pueda comentar el pull request. En el vigilante
# ese mismo patrón sería un problema —`$'` copiaría el resto ENTERO de la ficha adentro del valor y la
# dejaría con claves duplicadas—; acá se cubre la misma clase, no sólo ese sitio.
#
# El camino de REESCRITURA (el peligroso) se alcanza así: la ficha ya tiene `motivo_rechazo:` de
# una vida anterior y NO tiene `rechazado:`, así que el chequeo de idempotencia deja pasar y el
# motivo nuevo se escribe encima del viejo.
F11="$TMP/u11.yaml"; fichafalsa "$F11"
python3 - "$F11" <<'INNER'
import sys
p=sys.argv[1]; s=open(p,encoding='utf8').read()
open(p,'w',encoding='utf8').write(s.replace('noches: 3\n','noches: 3\nmotivo_rechazo: "de la vida anterior"\n',1))
INNER
node "$NOC" note --card "$F11" --rejected 2026-09-06 --reason 'ver R$&D antes de subir' --pr 7 >/dev/null 2>&1
LEIDO11=$(node -e "const{leerFicha}=require('$NOC');console.log(leerFicha(require('fs').readFileSync('$F11','utf8')).escalares.motivo_rechazo)")
DUP11=$(grep -c '^motivo_rechazo:' "$F11")
{ [ "$DUP11" -eq 1 ] && [ "$LEIDO11" = 'ver R$&D antes de subir' ]; } \
  && ok "U11: 🔴 un motivo con \$& no se interpreta al reescribir la clave, y no duplica nada" \
  || no "U11: leido=«${LEIDO11}» · $DUP11 línea(s) motivo_rechazo"

# ── P23. 🔴 con los pedidos ENCENDIDOS, una ficha sin pedido no es «ignorada» ──────────────
# `ignorado` mide «nadie la miró». Si el pedido de trabajo del líder nunca se pudo crear, nadie PUDO
# mirarla: archivarla ahí taparía un fallo de creación con la métrica que juzga a la pieza. En cuanto
# la ficha tiene pedido en su proyecto, la regla de los 7 días vuelve a valer igual que siempre.
# (Se llama P23 y no T23 porque T23 ya existe en esta suite.)
cfg44(){ # <archivo> <pedidos_activos: true|false>
  cat > "$1" <<CFG
{ "presupuesto_de_ruido": { "tope_pr_por_noche": 2 },
  "azure": { "org": "https://dev.azure.com/prueba", "fallback_owner": "respaldo@example.com", "pedidos_activos": $2 },
  "raiz_por_defecto": "$TMP/mundo",
  "repos": [ { "producto": "A", "ruta": "A", "tipo": "npm", "ado": "ProyA/A", "activo": true } ] }
CFG
}
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; cfg44 "$TMP/c-p23.json" true
noche "$TMP/c-p23.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-p23.json" 2026-09-02 >/dev/null
ID_P23=$(basename "$(unaficha pending)" .yaml)
noche "$TMP/c-p23.json" 2026-09-10 >/dev/null          # 8 días después de detectada, y sin pedido
SIGUE_P23=0; { [ -f "$TMP/pend/pending/$ID_P23.yaml" ] && [ ! -f "$TMP/pend/archived/$ID_P23.yaml" ]; } && SIGUE_P23=1
python3 - "$TMP/pend/pending/$ID_P23.yaml" <<'PYP23'
import sys
p = sys.argv[1]; t = open(p, encoding='utf8').read()
open(p, 'w', encoding='utf8').write(t.replace('ids:\n', 'pedidos:\n  - ProyA: 9\nids:\n', 1))
PYP23
# 🔴 Con pedido, «nadie la miró» se lee del PEDIDO — la noche trae su volcado, con el pedido
# abierto y sin cambios de una persona. Sin volcado la ficha ya no se ignora (lo prueba T21 del cruce).
echo "{\"fecha\":\"2026-09-11\",\"consultado\":true,\"motivo\":null,\"proyectos\":{},\"pedidos\":{\"9\":{\"ficha\":\"$ID_P23\",\"proyecto\":\"ProyA\",\"leido\":true,\"estado\":\"Active\",\"categoria\":\"InProgress\",\"motivo\":\"New\",\"estado_desde\":null,\"cambiado_por_persona_el\":null,\"cambiado_por_persona\":null,\"motivo_no_leido\":null}},\"huerfanos\":[],\"huerfanos_no_consultados\":[]}" > "$TMP/out/bugs-2026-09-11.json"
noche "$TMP/c-p23.json" 2026-09-11 >/dev/null          # ahora sí tiene pedido en su único proyecto
{ [ "$SIGUE_P23" -eq 1 ] && [ -f "$TMP/pend/archived/$ID_P23.yaml" ] \
  && grep -q '^veredicto: ignorado$' "$TMP/pend/archived/$ID_P23.yaml" \
  && grep -qx '  - ProyA: 9' "$TMP/pend/archived/$ID_P23.yaml"; } \
  && ok "P23 (story 4.4 T23 sin_pedido_no_se_ignora): 🔴 con los pedidos encendidos, la ficha sin pedido sigue pendiente; con su pedido, a los 7 días se ignora como siempre" \
  || no "P23: sigue-sin-pedido=$SIGUE_P23 · archivada=$([ -f "$TMP/pend/archived/$ID_P23.yaml" ] && echo sí || echo no)"

# ── P23b. Con la llave APAGADA rige la regla de siempre ───────────────────────────────────
# Mientras la pieza está simulada ninguna ficha tiene pedido: aplicar la protección igual haría que
# ninguna volviera a archivarse como ignorada, y el pull request del arnés —el único
# canal mientras tanto— sí le llega a alguien.
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; cfg44 "$TMP/c-p23b.json" false
noche "$TMP/c-p23b.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-p23b.json" 2026-09-02 >/dev/null
ID_P23B=$(basename "$(unaficha pending)" .yaml)
noche "$TMP/c-p23b.json" 2026-09-10 >/dev/null
{ [ -f "$TMP/pend/archived/$ID_P23B.yaml" ] && grep -q '^veredicto: ignorado$' "$TMP/pend/archived/$ID_P23B.yaml"; } \
  && ok "P23b (story 4.4 T23b sin_pedido_con_la_llave_apagada): con los pedidos apagados, la ficha sin pedido se ignora a los 7 días como hoy" \
  || no "P23b (T23b): la llave apagada cambió la regla de hoy (la ficha no se archivó)"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# El cruce «pedido cerrado, vulnerabilidad viva»
#
# Hay dos fuentes sobre el mismo hecho: el ESTADO del Bug (lo que una persona decidió) y la
# MEDICIÓN de esta noche. El nocturno las compara POR PROYECTO sobre `bugs-<fecha>.json`, que vuelca el
# paso anterior del pipeline — así esta suite no toca la red: el volcado se fabrica a mano. Los casos
# giran alrededor de lo que convertiría la pieza en ruido (avisar la primera noche, avisar dos veces) o
# en silencio («no leído» leído como «coincide», una gracia que no se consume nunca, un marcador que
# sobrevive a la reapertura). Los 🔴 corren noches reales; el resto llama a las funciones exportadas.
cfgc(){ # <archivo> — un repo A en «Proy A» (codificado como en la URL), con los pedidos encendidos
  cat > "$1" <<CFG
{ "presupuesto_de_ruido": { "tope_pr_por_noche": 2 },
  "azure": { "org": "https://dev.azure.com/prueba", "fallback_owner": "respaldo@example.com", "pedidos_activos": true,
             "motivos_arreglado": ["Fixed", "Fixed and verified", "Verified", "Work finished"] },
  "raiz_por_defecto": "$TMP/mundo",
  "repos": [ { "producto": "A", "ruta": "A", "tipo": "npm", "ado": "Proy%20A/A", "activo": true } ] }
CFG
}
agregar(){ # <ficha> <clave> <línea> — agrega (o suma a) una lista antes de `ids:`
  python3 - "$1" "$2" "$3" <<'PYAG'
import sys, re
p, k, l = sys.argv[1:]; t = open(p, encoding='utf8').read()
m = re.search(r'^' + re.escape(k) + r':\n((?:[ \t]+-.*\n)*)', t, re.M)
if m: t = t[:m.end()] + '  - ' + l + '\n' + t[m.end():]
else: t = t.replace('ids:\n', k + ':\n  - ' + l + '\nids:\n', 1)
open(p, 'w', encoding='utf8').write(t)
PYAG
}
volcado(){ # <fecha> <estado> <categoria> <motivo> [leido=true] — el volcado de esa noche para el pedido 101 de $ID
  node -e '
const [fecha, estado, categoria, motivo, leido, ficha, f] = process.argv.slice(1);
const ok = leido !== "false";
const x = { ficha, proyecto: "Proy A", leido: ok, estado: ok ? estado : null, categoria: ok ? categoria : null, motivo: ok ? motivo : null,
  estado_desde: ok ? "2026-09-01T10:00:00Z" : null, cambiado_por_persona_el: null, cambiado_por_persona: null,
  motivo_no_leido: ok ? null : "no pude leer el work item (salió 1: se cayó la conexión)" };
require("fs").writeFileSync(f, JSON.stringify({ fecha, consultado: true, motivo: null, proyectos: {}, pedidos: { 101: x }, huerfanos: [], huerfanos_no_consultados: [] }));' \
    "$1" "$2" "$3" "$4" "${5:-true}" "$ID" "$TMP/out/bugs-$1.json"
}
cruce(){ # <fecha> <expresión JS sobre c = snapshot.cruce> → 0/1
  node -e 'let s; try { s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { process.exit(1); }
const c = s.cruce; if (!c) process.exit(1); process.exit(eval(process.argv[2]) ? 0 : 1);' "$TMP/out/dependencias-$1.json" "$2"
}
crucej(){ node -e 'try { console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).cruce)); } catch (e) { console.log("<<" + e.message + ">>"); }' "$TMP/out/dependencias-$1.json" | cut -c1-500; }
mundo_cruce(){ # dos noches: la línea base y la que crea la ficha; después la ficha recibe su pedido
  rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; cfgc "$TMP/cx.json"
  noche "$TMP/cx.json" 2026-09-01 >/dev/null
  echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/cx.json" 2026-09-02 >/dev/null
  FX=$(unaficha pending); export ID; ID=$(basename "$FX" .yaml)
  agregar "$FX" pedidos "Proy A: 101"
}

# ── T8. 🔴 una noche de gracia, y después UN aviso ────────────────────────────────────────
mundo_cruce
volcado 2026-09-03 Closed Completed Verified; noche "$TMP/cx.json" 2026-09-03 >/dev/null
n1=0; { grep -qx 'visto_cerrado:' "$FX" && grep -qx '  - Proy A: 2026-09-03' "$FX" && cruce 2026-09-03 'c.en_gracia.length === 1 && c.cerrados_vivos.length === 0 && c.evaluados === 1'; } && n1=1
volcado 2026-09-04 Closed Completed Verified; noche "$TMP/cx.json" 2026-09-04 >/dev/null
n2=0; { cruce 2026-09-04 'const x = c.cerrados_vivos[0]; c.cerrados_vivos.length === 1 && x.ficha === process.env.ID && x.proyecto === "Proy A" && String(x.pedido) === "101" && x.clase === "arreglado" && x.avisar === true && x.visto_cerrado === "2026-09-03" && JSON.stringify(x.repos) === "[\"A/A\"]" && x.estado === "Closed" && x.motivo === "Verified"' \
  && grep -q '🔴 1 pedido(s) CERRADO(s) con la vulnerabilidad VIVA' "$TMP/o.txt"; } && n2=1
agregar "$FX" avisado_cerrado_vivo "Proy A (2026-09-04)"
volcado 2026-09-05 Closed Completed Verified; noche "$TMP/cx.json" 2026-09-05 >/dev/null
n3=0; cruce 2026-09-05 'c.cerrados_vivos.length === 1 && c.cerrados_vivos[0].avisar === false' && n3=1
[ "$n1$n2$n3" = 111 ] \
  && ok "T8 (story 4.5): 🔴 la primera noche cerrado sólo se anota (gracia); la segunda sale en cerrados_vivos con avisar:true; con el aviso ya dado sigue listado sin repetir" \
  || no "T8: gracia=$n1 alarma=$n2 sin-repetir=$n3 · $(crucej 2026-09-04)"

# ── T11. 🔴 reabrir borra los marcadores: un cierre nuevo empieza de cero ────────────────
mundo_cruce
volcado 2026-09-03 Closed Completed Verified; noche "$TMP/cx.json" 2026-09-03 >/dev/null
agregar "$FX" avisado_cerrado_vivo "Proy A (2026-09-03)"
volcado 2026-09-04 Active InProgress "Reactivated"; noche "$TMP/cx.json" 2026-09-04 >/dev/null
r1=0; { cruce 2026-09-04 'c.reabiertos.length === 1 && c.reabiertos[0].proyecto === "Proy A" && c.cerrados_vivos.length === 0' \
  && ! grep -q '^visto_cerrado:' "$FX" && ! grep -q '^avisado_cerrado_vivo:' "$FX"; } && r1=1
volcado 2026-09-05 Closed Completed Verified; noche "$TMP/cx.json" 2026-09-05 >/dev/null
r2=0; cruce 2026-09-05 'c.en_gracia.length === 1 && c.cerrados_vivos.length === 0' && r2=1
volcado 2026-09-06 Closed Completed Verified; noche "$TMP/cx.json" 2026-09-06 >/dev/null
r3=0; cruce 2026-09-06 'c.cerrados_vivos.length === 1 && c.cerrados_vivos[0].avisar === true && c.cerrados_vivos[0].visto_cerrado === "2026-09-05"' && r3=1
[ "$r1$r2$r3" = 111 ] \
  && ok "T11 (story 4.5): 🔴 un pedido reabierto borra visto_cerrado y avisado_cerrado_vivo; el cierre siguiente vuelve a tener su noche de gracia y su aviso" \
  || no "T11: reabre=$r1 gracia-otra-vez=$r2 aviso-otra-vez=$r3 · $(crucej 2026-09-04) · $(grep -A2 '^visto_cerrado\|^avisado' "$FX" | tr '\n' ' ')"

# ── T12. 🔴 una noche que no se pudo leer no decide nada ─────────────────────────────────
mundo_cruce
volcado 2026-09-03 Closed Completed Verified; noche "$TMP/cx.json" 2026-09-03 >/dev/null
volcado 2026-09-04 x x x false; noche "$TMP/cx.json" 2026-09-04 >/dev/null
l1=0; { cruce 2026-09-04 'c.no_leidos.length === 1 && /se cayó la conexión/.test(c.no_leidos[0].motivo) && c.cerrados_vivos.length === 0 && c.en_gracia.length === 0 && c.evaluados === 0' \
  && grep -qx '  - Proy A: 2026-09-03' "$FX"; } && l1=1
volcado 2026-09-05 Closed Completed Verified; noche "$TMP/cx.json" 2026-09-05 >/dev/null
l2=0; cruce 2026-09-05 'c.cerrados_vivos.length === 1 && c.cerrados_vivos[0].avisar === true && c.cerrados_vivos[0].visto_cerrado === "2026-09-03"' && l2=1
[ "$l1$l2" = 11 ] \
  && ok "T12 (story 4.5): 🔴 un pedido no leído en la segunda noche sale en no_leidos, sin alarma ni gracia, con el marcador intacto; la primera noche legible decide" \
  || no "T12: no-leído=$l1 decide-después=$l2 · $(crucej 2026-09-04)"

# ── T15. 🔴 sin volcado, NADA coincide ────────────────────────────────────────────────────
mundo_cruce; agregar "$FX" visto_cerrado "Proy A: 2026-09-01"
cp "$FX" "$TMP/antes-t15.yaml"
noche "$TMP/cx.json" 2026-09-03 >/dev/null
s1=0; { cruce 2026-09-03 'c.volcado === null && c.consultado === false && /sin volcado bugs-2026-09-03\.json/.test(c.motivo) && c.no_leidos.length === 1 && c.no_leidos[0].ficha === process.env.ID && c.cerrados_vivos.length === 0 && c.en_gracia.length === 0 && c.resueltas_con_pedido_abierto.length === 0 && c.evaluados === 0' \
  && grep -q '🚧 1 pedido(s) NO LEÍDO(s)' "$TMP/o.txt" && grep -qx '  - Proy A: 2026-09-01' "$FX"; } && s1=1
echo '{"fecha":"2026-09-04","consultado":false,"motivo":"sin token: AZURE_DEVOPS_EXT_PAT está vacío"}' > "$TMP/out/bugs-2026-09-04.json"
noche "$TMP/cx.json" 2026-09-04 >/dev/null
s2=0; cruce 2026-09-04 'c.volcado === "bugs-2026-09-04.json" && c.consultado === false && /sin token/.test(c.motivo) && c.no_leidos.length === 1 && c.cerrados_vivos.length === 0' && s2=1
echo '{ esto no es json' > "$TMP/out/bugs-2026-09-05.json"
noche "$TMP/cx.json" 2026-09-05 >/dev/null
s3=0; cruce 2026-09-05 'c.consultado === false && /volcado ilegible/.test(c.motivo) && c.no_leidos.length === 1' && s3=1
[ "$s1$s2$s3" = 111 ] \
  && ok "T15 (story 4.5): 🔴 sin volcado, con un volcado que no consultó, o ilegible: consultado:false con su motivo, todos los pares en no_leidos, ninguna alarma, y la salida dice NO LEÍDO" \
  || no "T15: sin-volcado=$s1 no-consultó=$s2 ilegible=$s3 · $(crucej 2026-09-03)"

# ── T14. la clave `cruce` está SIEMPRE, con listas vacías ─────────────────────────────────
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; cfgc "$TMP/cx.json"
mkdir -p "$TMP/out"; echo '{"fecha":"2026-09-01","consultado":true,"motivo":null,"proyectos":{},"pedidos":{},"huerfanos":[],"huerfanos_no_consultados":[]}' > "$TMP/out/bugs-2026-09-01.json"
noche "$TMP/cx.json" 2026-09-01 >/dev/null
cruce 2026-09-01 'c.consultado === true && c.evaluados === 0 && ["cerrados_vivos","en_gracia","cerrados_con_deuda","reabiertos","resueltas_con_pedido_abierto","no_leidos","no_evaluados","ignorado_frenado","huerfanos","huerfanos_no_consultados"].every((k) => Array.isArray(c[k]) && c[k].length === 0)' \
  && ok "T14 (story 4.5): una noche sin fichas con pedido publica cruce con consultado:true, evaluados 0 y todas las listas vacías (nunca ausentes)" \
  || no "T14: $(crucej 2026-09-01)"

# ── Las decisiones del cruce, sin noches: se llama a las funciones exportadas ───────────────────────
cat > "$TMP/xc.js" <<'XC'
const fs = require('fs'), path = require('path'); const noc = require(process.env.NOC);
const nuevaBase = () => { const b = fs.mkdtempSync(path.join(process.env.TMPX, 'xc-')); for (const d of ['pending', 'promoted', 'archived']) fs.mkdirSync(path.join(b, d)); return b; };
let base = nuevaBase();
const cfg = (voc = true) => ({ azure: { org: 'x', fallback_owner: 'a', pedidos_activos: true, ...(voc ? { motivos_arreglado: ['Fixed', 'Fixed and verified', 'Verified', 'Work finished'] } : {}) },
  repos: [['A', 'Proy%20A'], ['B', 'ProyB'], ['C', 'ProyC']].map(([r, p]) => ({ producto: r, ruta: r, ado: `${p}/${r}`, tipo: 'npm', activo: true })) });
function F(carpeta, { id = 'abc12345', repos = ['A/A'], declarada = [], extra = [], detectado = '2026-09-01' } = {}) {
  const L = [`id: ${id}`, `detectado: ${detectado}`, `veredicto: ${carpeta === 'promoted' ? 'util' : 'pendiente'}`, 'paquete: browserslist', 'severidad: high', 'noches: 3', ...extra, 'ids:', `  - ${id}`];
  if (repos.length) L.push('repos:', ...repos.map((r) => `  - ${r}`));
  if (declarada.length) L.push('declarada_en:', ...declarada.map((r) => `  - ${r}`));
  L.push('avisos:', '  - https://x/GHSA-73wf', '');
  const p = path.join(base, carpeta, `${id}.yaml`); fs.writeFileSync(p, L.join('\n')); return p;
}
const S = ({ presentes = { 'A/A': false }, vence = null, sinMedir = [], id = 'abc12345' } = {}) => ({
  repos: ['A', 'B', 'C'].map((r) => ({ producto: r, ruta: r, medido: !sinMedir.includes(`${r}/${r}`) })),
  presencias: Object.keys(presentes).length ? [{ id, paquete: 'browserslist', severidad: 'high', advisories: [],
    repos: Object.entries(presentes).map(([repo, declarada]) => ({ repo, declarada, vence: declarada ? vence : null })) }] : [] });
const P = (proyecto, estado, categoria, motivo, extra = {}) => ({ ficha: 'abc12345', proyecto, leido: true, estado, categoria, motivo,
  estado_desde: '2026-09-01T10:00:00Z', cambiado_por_persona_el: null, cambiado_por_persona: null, motivo_no_leido: null, ...extra });
const V = (pedidos, extra = {}) => ({ archivo: 'bugs-x.json', consultado: true, motivo: null, pedidos, huerfanos: [], huerfanos_no_consultados: [], ...extra });
const cruzar = (hoy, snapshot, volcado, c = cfg()) => noc.cruzarPedidos({ pendingDir: base, hoy, snapshot, volcado, cfg: c });
const lista = (p, k) => noc.listaDe(fs.readFileSync(p, 'utf8'), k);
const di = (x) => JSON.stringify(x);
XC
xc(){ NOC="$NOC" TMPX="$TMP" node -e "$(cat "$TMP/xc.js")
$1" 2>&1 | tail -3; }

# ── T6. la presencia se juzga POR PROYECTO ────────────────────────────────────────────────
r=$(xc 'const f = F("pending", { repos: ["A/A", "B/B"], extra: ["pedidos:", "  - Proy A: 101", "  - ProyB: 201"] });
const c = cruzar("2026-09-02", S({ presentes: { "A/A": false } }), V({ 101: P("Proy A", "Closed", "Completed", "Verified"), 201: P("ProyB", "Closed", "Completed", "Verified") }));
const bien = di(c.en_gracia.map((x) => x.proyecto)) === di(["Proy A"]) && c.cerrados_vivos.length === 0 && di(lista(f, "visto_cerrado")) === di(["Proy A: 2026-09-02"]) && c.evaluados === 2;
console.log(bien ? "ok" : "NO " + di(c) + " · " + di(lista(f, "visto_cerrado")));')
[ "$r" = ok ] && ok "T6 (story 4.5): una ficha en dos proyectos con los dos pedidos cerrados: viva en Proy A (gracia y marcador sólo ahí), pagada en ProyB (nada)" || no "T6: $r"

# ── T7. un repo sin medir no evalúa · un proyecto sin pedido tampoco ─────────────────
r=$(xc 'const f = F("pending", { extra: ["pedidos:", "  - Proy A: 101", "visto_cerrado:", "  - Proy A: 2026-09-01"] });
const c = cruzar("2026-09-02", S({ sinMedir: ["A/A"] }), V({ 101: P("Proy A", "Closed", "Completed", "Verified") }));
base = nuevaBase();
F("pending", { repos: ["A/A", "C/C"], extra: ["pedidos:", "  - Proy A: 101"] });
const d = cruzar("2026-09-02", S({ presentes: { "A/A": false, "C/C": false } }), V({ 101: P("Proy A", "Active", "InProgress", "New") }));
const bien = c.no_evaluados.some((x) => x.proyecto === "Proy A" && /A\/A sin medir esta noche/.test(x.motivo)) && c.cerrados_vivos.length === 0 && c.en_gracia.length === 0
  && di(lista(f, "visto_cerrado")) === di(["Proy A: 2026-09-01"])
  && d.no_evaluados.some((x) => x.proyecto === "ProyC" && x.motivo === "sin pedido en ProyC");
console.log(bien ? "ok" : "NO " + di(c.no_evaluados) + " · " + di(d.no_evaluados));')
[ "$r" = ok ] && ok "T7 (story 4.5): con un repo del proyecto sin medir el par sale no_evaluados con el motivo y el marcador no se toca; un proyecto sin pedido sale «sin pedido en ProyC»" || no "T7: $r"

# ── T9. «no aplica» tiene su clase, y lo que se cierra como arreglado la suya ────────────
r=$(xc 'const clase = (estado, cat, motivo) => { base = nuevaBase(); F("pending", { extra: ["pedidos:", "  - Proy A: 101", "visto_cerrado:", "  - Proy A: 2026-09-01"] });
  const c = cruzar("2026-09-02", S(), V({ 101: P("Proy A", estado, cat, motivo) })); return c.cerrados_vivos.length === 1 ? c.cerrados_vivos[0].clase : "NADA " + di(c); };
const r = [clase("Resolved", "Resolved", "Duplicate"), clase("Removed", "Removed", "Removed from the backlog"), clase("Closed", "Completed", "Verified"), clase("Done", "Completed", "Work finished")];
console.log(di(r) === di(["no-aplica", "no-aplica", "arreglado", "arreglado"]) ? "ok" : "NO " + di(r));')
[ "$r" = ok ] && ok "T9 (story 4.5): Resolved/Duplicate y Removed son «no-aplica»; Closed/Verified y Done/Work finished (Scrum) son «arreglado» — por categoría, no por nombre" || no "T9: $r"

# ── T10. cerrado con la deuda declarada: se lista, no se avisa ───────────────────────────
r=$(xc 'const f = F("pending", { repos: [], declarada: ["A/A (vence 2026-12-31)"], extra: ["pedidos:", "  - Proy A: 101"] });
const s = S({ presentes: { "A/A": true }, vence: "2026-12-31" }), v = V({ 101: P("Proy A", "Closed", "Completed", "Verified") });
const c1 = cruzar("2026-09-02", s, v), c2 = cruzar("2026-09-03", s, v);
const bien = [c1, c2].every((c) => c.cerrados_vivos.length === 0 && c.en_gracia.length === 0 && c.cerrados_con_deuda.length === 1 && c.cerrados_con_deuda[0].vence === "2026-12-31")
  && di(lista(f, "visto_cerrado")) === di(["Proy A: 2026-09-02"]);
console.log(bien ? "ok" : "NO " + di(c2) + " · " + di(lista(f, "visto_cerrado")));')
[ "$r" = ok ] && ok "T10 (story 4.5): un pedido cerrado con la vulnerabilidad declarada como deuda sale en cerrados_con_deuda con el vencimiento, se anota visto_cerrado y no se avisa ninguna noche" || no "T10: $r"

# ── T13. el espejo: resuelta con el pedido abierto se lista con su edad ───────────────────
r=$(xc 'F("promoted", { repos: [], extra: ["resuelto: 2026-09-05", "pedidos:", "  - Proy A: 101"] });
const a = cruzar("2026-09-08", S({ presentes: {} }), V({ 101: P("Proy A", "Active", "InProgress", "New") }));
const b = cruzar("2026-09-08", S({ presentes: {} }), V({ 101: P("Proy A", "Closed", "Completed", "Fixed") }));
const x = a.resueltas_con_pedido_abierto[0] || {};
const bien = a.resueltas_con_pedido_abierto.length === 1 && x.dias === 3 && String(x.pedido) === "101" && x.resuelto === "2026-09-05" && x.proyecto === "Proy A"
  && a.cerrados_vivos.length === 0 && b.resueltas_con_pedido_abierto.length === 0;
console.log(bien ? "ok" : "NO " + di(a) + " · " + di(b));')
[ "$r" = ok ] && ok "T13 (story 4.5): una ficha resuelta con el pedido abierto sale en resueltas_con_pedido_abierto con dias 3; con el pedido cerrado no se lista" || no "T13: $r"

# ── T25. el vocabulario de «arreglado» es exacto, y sin él no se clasifica nada ─────────
r=$(xc 'F("pending", { extra: ["pedidos:", "  - Proy A: 101", "visto_cerrado:", "  - Proy A: 2026-09-01"] });
const a = cruzar("2026-09-02", S(), V({ 101: P("Proy A", "Closed", "Completed", "fixed") }));
base = nuevaBase(); const f = F("pending", { extra: ["pedidos:", "  - Proy A: 101"] });
const b = cruzar("2026-09-02", S(), V({ 101: P("Proy A", "Closed", "Completed", "Verified") }), cfg(false));
const bien = a.cerrados_vivos.length === 1 && a.cerrados_vivos[0].clase === "no-aplica"
  && b.cerrados_vivos.length === 0 && b.en_gracia.length === 0 && b.no_leidos.some((x) => /sin vocabulario `motivos_arreglado`/.test(x.motivo)) && lista(f, "visto_cerrado").length === 0;
console.log(bien ? "ok" : "NO " + di(a.cerrados_vivos) + " · " + di(b));')
[ "$r" = ok ] && ok "T25 (story 4.5): «fixed» en minúscula no es «Fixed» (no-aplica); sin motivos_arreglado ningún cerrado se clasifica: van a no_leidos y no se anota nada" || no "T25: $r"

# ── T29n. el nocturno copia los Bugs sueltos del volcado a `cruce` ──────────────────────
r=$(xc 'const h = [{ id: 150, proyecto: "Proy A", ficha: "abc12345", estado: "Active", categoria: "InProgress" }], nc = [{ proyecto: "ProyB", motivo: "salió 1" }];
const a = cruzar("2026-09-02", S({ presentes: {} }), V({}, { huerfanos: h, huerfanos_no_consultados: nc }));
const b = cruzar("2026-09-02", S({ presentes: {} }), { archivo: null, consultado: false, motivo: "sin volcado bugs-2026-09-02.json" });
const bien = di(a.huerfanos) === di(h) && di(a.huerfanos_no_consultados) === di(nc) && di(b.huerfanos) === "[]" && di(b.huerfanos_no_consultados) === "[]" && b.consultado === false;
console.log(bien ? "ok" : "NO " + di(a) + " · " + di(b));')
[ "$r" = ok ] && ok "T29n (story 4.5): los Bugs sueltos y los proyectos no consultados del volcado llegan a cruce; sin volcado legible, listas vacías con consultado:false" || no "T29n: $r"

# ── T19–T21. `ignorado` se lee de la actividad de una PERSONA en el pedido ────────────────
ign(){ # <cuerpo JS que define v (volcado)> → "ids|motivos frenados|en archived"
  xc "F('pending', { extra: ['pedidos:', '  - Proy A: 101'] });
$1
const frenados = []; const ids = noc.archivarIgnorados(base, '2026-09-09', cfg(), v, frenados);
console.log(ids.join(',') + '|' + frenados.map((x) => x.ficha + ':' + x.motivo).join(';') + '|' + fs.existsSync(path.join(base, 'archived', 'abc12345.yaml')));"
}
t19=$(ign "const v = V({ 101: P('Proy A', 'Active', 'InProgress', 'New') });")
t20a=$(ign "const v = V({ 101: P('Proy A', 'Active', 'InProgress', 'New', { cambiado_por_persona_el: '2026-09-06T10:00:00Z', cambiado_por_persona: 'Persona Prueba' }) });")
t20b=$(ign "const v = V({ 101: P('Proy A', 'Active', 'InProgress', 'New', { cambiado_por_persona_el: '2026-08-31T10:00:00Z', cambiado_por_persona: 'Persona Prueba' }) });")
t21a=$(ign "const v = V({ 101: P('Proy A', null, null, null, { leido: false, motivo_no_leido: 'salió 1' }) });")
t21b=$(ign "const v = V({ 101: P('Proy A', 'Closed', 'Completed', 'Verified') });")
t21c=$(ign "const v = { archivo: null, consultado: false, motivo: 'sin volcado bugs-2026-09-09.json' };")
[ "$t19" = "abc12345||true" ] && ok "T19 (story 4.5): 🔴 una ficha de 8 días cuyo pedido abierto sólo tocó el pipeline se archiva como ignorada" || no "T19: $t19"
{ [[ "$t20a" == "|abc12345:"*"una persona lo tocó hace 3 días"*"|false" ]] && [ "$t20b" = "abc12345||true" ]; } \
  && ok "T20 (story 4.5): 🔴 una persona que tocó el pedido hace 3 días frena el ignorado (y se dice); hace 9 días, no" || no "T20: 3 días=«${t20a}» · 9 días=«${t20b}»"
{ [[ "$t21a" == "|abc12345:"*"no pude leer el pedido de Proy A"*"|false" ]] && [[ "$t21b" == "|abc12345:"*"el pedido de Proy A está cerrado"*"|false" ]] && [[ "$t21c" == "|abc12345:"*"sin volcado"*"|false" ]]; } \
  && ok "T21 (story 4.5): un pedido no leído, uno cerrado, o una noche sin volcado no ignoran la ficha, y dicen por qué" || no "T21: no-leído=«${t21a}» · cerrado=«${t21b}» · sin-volcado=«${t21c}»"

# ── T24. lo que no cambia ─────────────────────────────────────────────────────────────────
n=$(grep -c "ponerEscalar(txt, 'resuelto'" "$NOC")
[ "$n" -eq 1 ] && ok "T24 (story 4.5): «resuelto:» se sigue escribiendo en un solo lugar (la medición, no el cruce)" || no "T24: ponerEscalar(txt, 'resuelto' aparece ${n} veces"

# ════ El cruce: casos de borde ═════════════════════
# Cada caso cubre un defecto posible o una rama sin caso.

# ── A1. 🔴 reabrir no deja renglones sueltos en la ficha ──────────────────────────────────────────
# `ponerLista(k, [])` sobre una clave fuera de CLAVES_LISTA borraría sólo la cabecera: los ítems quedarían
# pegados a la lista anterior (`pedidos:`) y crecerían con cada cierre y reapertura. T11 mira sólo la cabecera.
mundo_cruce
volcado 2026-09-03 Closed Completed Verified; noche "$TMP/cx.json" 2026-09-03 >/dev/null
agregar "$FX" avisado_cerrado_vivo "Proy A (2026-09-03)"
volcado 2026-09-04 Active InProgress Reactivated; noche "$TMP/cx.json" 2026-09-04 >/dev/null
a1=$(node -e 'const n = require(process.argv[1]); const t = require("fs").readFileSync(process.argv[2], "utf8");
console.log(JSON.stringify(n.listaDe(t, "pedidos")) + "|" + (/^  - Proy A: 2026-09-03$|^  - Proy A \(2026-09-03\)$/m.test(t) ? "sueltos" : "limpia"));' "$NOC" "$FX")
[ "$a1" = '["Proy A: 101"]|limpia' ] && ok "A1 (story 4.5, 5b): 🔴 al reabrir, los marcadores se borran enteros — ni un renglón suelto pegado a pedidos:" \
  || no "A1: pedidos y marcadores tras reabrir = ${a1} · $(tail -8 "$FX" | tr '\n' '|')"

# ── F1. 🔴 una ficha que se reactiva no arrastra las marcas de su vida anterior ────────────────────
mundo_cruce
mkdir -p "$TMP/pend/promoted"; mv "$FX" "$TMP/pend/promoted/$ID.yaml"; FX="$TMP/pend/promoted/$ID.yaml"
python3 - "$FX" <<'PYF1'
import sys; p = sys.argv[1]; t = open(p, encoding='utf8').read()
t = t.replace('veredicto: pendiente', 'veredicto: util').replace('ids:\n', 'resuelto: 2026-09-02\nvisto_cerrado:\n  - Proy A: 2026-08-30\navisado_cerrado_vivo:\n  - Proy A (2026-08-31)\npagado_avisado:\n  - Proy A (2026-09-02)\nids:\n', 1)
open(p, 'w', encoding='utf8').write(t)
PYF1
noche "$TMP/cx.json" 2026-09-03 >/dev/null
F1="$TMP/pend/pending/$ID.yaml"
# (`pagado_avisado:` NO se borra acá — es por proyecto, y borrarlo entero repetiría «ya no aparece»
#  en el proyecto donde nada cambió; lo borra el guion de pedidos en el proyecto donde volvió a aparecer.)
{ [ -f "$F1" ] && grep -q '^reaparecido: 2026-09-03' "$F1" && ! grep -qE '^(visto_cerrado|avisado_cerrado_vivo):|^  - Proy A(: 2026-08-30| \(2026-08-31\))$' "$F1" \
  && grep -qx '  - Proy A: 101' "$F1" && grep -qx '  - Proy A (2026-09-02)' "$F1"; } \
  && ok "F1 (story 4.5, 5b): 🔴 la ficha que reaparece empieza un episodio nuevo del cruce: sin visto_cerrado ni avisado_cerrado_vivo viejos (el pedido y pagado_avisado se conservan)" \
  || no "F1: reactivada=$([ -f "$F1" ] && echo sí || echo no) · $(tr '\n' '|' < "${F1:-/dev/null}" 2>/dev/null | cut -c1-400)"

# ── Decisiones sin noches (función exportada) ─────────────────────────────────────────────────────
r=$(xc '// B1: repo que salió de repos.json con producto ≠ proyecto
const cfgZ = cfg();
F("pending", { repos: ["Z/Z"], extra: ["pedidos:", "  - ProyZ: 900"] });
const b = cruzar("2026-09-02", S({ presentes: {} }), V({ 900: P("ProyZ", "Closed", "Completed", "Verified") }), cfgZ);
const b1 = b.evaluados === 0 && b.no_evaluados.some((x) => x.proyecto === "ProyZ" && /Z\/Z/.test(x.motivo));
// H1: reapertura leída con un repo sin medir igual borra los marcadores
base = nuevaBase(); const fh = F("pending", { extra: ["pedidos:", "  - Proy A: 101", "visto_cerrado:", "  - Proy A: 2026-09-01", "avisado_cerrado_vivo:", "  - Proy A (2026-09-01)"] });
const h = cruzar("2026-09-02", S({ sinMedir: ["A/A"] }), V({ 101: P("Proy A", "Active", "InProgress", "Reactivated") }));
const h1 = h.reabiertos.length === 1 && lista(fh, "visto_cerrado").length === 0 && lista(fh, "avisado_cerrado_vivo").length === 0;
// G1: un visto_cerrado con fecha ilegible reinicia la gracia en vez de trabarla para siempre
base = nuevaBase(); const fg = F("pending", { extra: ["pedidos:", "  - Proy A: 101", "visto_cerrado:", "  - Proy A: ayer"] });
const g = cruzar("2026-09-02", S(), V({ 101: P("Proy A", "Closed", "Completed", "Verified") }));
const g2 = cruzar("2026-09-03", S(), V({ 101: P("Proy A", "Closed", "Completed", "Verified") }));
const g1 = g.en_gracia.length === 1 && di(lista(fg, "visto_cerrado")) === di(["Proy A: 2026-09-02"]) && g2.cerrados_vivos.length === 1 && g2.cerrados_vivos[0].visto_cerrado === "2026-09-02";
// E1: ignorado_frenado ordenado por ficha (el orden del disco no está garantizado)
base = nuevaBase();
for (const id of ["zzz99999", "aaa11111", "mmm55555"]) F("pending", { id, extra: ["pedidos:", "  - Proy A: 101"] });
const fr = []; noc.archivarIgnorados(base, "2026-09-09", cfg(), { consultado: false, motivo: "sin volcado" }, fr);
const e1 = di(fr.map((x) => x.ficha)) === di(["aaa11111", "mmm55555", "zzz99999"]);
// T1c: categoría ni abierta ni cerrada frena el ignorado con motivo
base = nuevaBase(); F("pending", { extra: ["pedidos:", "  - Proy A: 101"] });
const f2 = []; noc.archivarIgnorados(base, "2026-09-09", cfg(), V({ 101: P("Proy A", "Raro", "Rara", "x") }), f2);
const t1c = f2.length === 1 && /categoría Rara/.test(f2[0].motivo);
// T6c: volcado que dice consultado:true pero no trae pedidos
fs.writeFileSync(path.join(base, "bugs.json"), JSON.stringify({ consultado: true, motivo: null }));
const lv = noc.leerVolcado(path.join(base, "bugs.json"));
const t6c = lv.consultado === false && /no trae «pedidos»/.test(lv.motivo);
// T7c/T7d (vuelta 2, cobertura): categoría desconocida y pedido ausente del volcado van a no_leidos con su motivo
base = nuevaBase(); F("pending", { extra: ["pedidos:", "  - Proy A: 101"] });
const k1 = cruzar("2026-09-02", S(), V({ 101: P("Proy A", "On Hold", "RaraCategoria", "x") }));
const k2 = cruzar("2026-09-02", S(), V({}));
const t7c = k1.no_leidos.length === 1 && /categoría de estado desconocida: RaraCategoria/.test(k1.no_leidos[0].motivo) && k1.evaluados === 0;
const t7d = k2.no_leidos.length === 1 && k2.no_leidos[0].motivo === "el volcado no trae el pedido 101";
console.log(JSON.stringify({ b1, h1, g1, e1, t1c, t6c, t7c, t7d }));')
[ "$r" = '{"b1":true,"h1":true,"g1":true,"e1":true,"t1c":true,"t6c":true,"t7c":true,"t7d":true}' ] \
  && ok "B1/H1/G1/E1 (story 4.5, 5b) + ramas: un repo fuera de repos.json no se lee «coincide»; una reapertura leída borra marcadores aunque falte medir; una fecha ilegible reinicia la gracia; ignorado_frenado sale ordenado; categoría rara y volcado sin pedidos se dicen" \
  || no "B1/H1/G1/E1: ${r}"
# ── T11: la ficha dice cuándo una vulnerabilidad es alta por falta de dato ────────────────────────
# 🔴 Falla si el nocturno no pasa `gravedad_sin_dato`: quien decide vería «alta» sin saber que es un valor por defecto.
rm -rf "$TMP/out" "$TMP/pend"; mundo SD CD; echo "$LIMPIO" > "$TMP/fix/SD.json"; echo "$LIMPIO" > "$TMP/fix/CD.json"; config "$TMP/c.json" 5 SD CD
noche "$TMP/c.json" 2026-09-01 >/dev/null
echo '{"vulnerabilities":{"acme-sd":{"severity":"","via":[{"url":"https://x/GHSA-sd01"}]}},"metadata":{"vulnerabilities":{"critical":0,"high":0,"moderate":0,"low":0}}}' > "$TMP/fix/SD.json"
echo '{"vulnerabilities":{"acme-cd":{"severity":"high","via":[{"url":"https://x/GHSA-cd01"}]}},"metadata":{"vulnerabilities":{"critical":0,"high":1,"moderate":0,"low":0}}}' > "$TMP/fix/CD.json"
noche "$TMP/c.json" 2026-09-02 >/dev/null
fsd=$(grep -l "^paquete: acme-sd$" "$TMP/pend/pending"/*.yaml 2>/dev/null | head -1)
fcd=$(grep -l "^paquete: acme-cd$" "$TMP/pend/pending"/*.yaml 2>/dev/null | head -1)
{ [ -n "$fsd" ] && [ -n "$fcd" ] && grep -q "^# alta por falta de dato: el gestor de paquetes no informó la gravedad" "$fsd" \
  && ! grep -q "falta de dato" "$fcd" && grep -q "^severidad: high$" "$fsd" \
  && [ "$(basename "$fsd" .yaml)" = "$(sed -n 's/^id: //p' "$fsd")" ]; } \
  && ok "T11 8.55 la ficha de una alta sin dato lo dice; la de una alta informada, no" \
  || no "T11 8.55 fichas: sd=«${fsd}» cd=«${fcd}» $(cat "$fsd" 2>/dev/null)"

# T11 (más): el mismo hallazgo con la gravedad informada en un repo y sin dato en otro no lleva la marca
rm -rf "$TMP/out" "$TMP/pend"; mundo M1 M2; echo "$LIMPIO" > "$TMP/fix/M1.json"; echo "$LIMPIO" > "$TMP/fix/M2.json"; config "$TMP/c.json" 5 M1 M2
noche "$TMP/c.json" 2026-09-01 >/dev/null
echo '{"vulnerabilities":{"acme-mx":{"severity":"","via":[{"url":"https://x/GHSA-mx01"}]}},"metadata":{"vulnerabilities":{"critical":0,"high":0,"moderate":0,"low":0}}}' > "$TMP/fix/M1.json"
echo '{"vulnerabilities":{"acme-mx":{"severity":"high","via":[{"url":"https://x/GHSA-mx01"}]}},"metadata":{"vulnerabilities":{"critical":0,"high":1,"moderate":0,"low":0}}}' > "$TMP/fix/M2.json"
noche "$TMP/c.json" 2026-09-02 >/dev/null
fmx=$(grep -l "^paquete: acme-mx$" "$TMP/pend/pending"/*.yaml 2>/dev/null | head -1)
{ [ -n "$fmx" ] && ! grep -q "falta de dato" "$fmx" && grep -q "^  - M1/M1$" "$fmx" && grep -q "^  - M2/M2$" "$fmx"; } \
  && ok "T11 8.55 con un repo que informa la gravedad, la ficha no dice «falta de dato»" || no "T11 8.55 mezcla: $(cat "$fmx" 2>/dev/null)"

# ── la noche mira cada formulario ──────────────────────────────────────────────────────────────
# Un repo de formularios tiene un lockfile por formulario: mirar sólo el de la raíz deja afuera una alta en
# un formulario. La lista de carpetas sale del repo (lo publicado), no de repos.json. En los formularios no hay archivo SOY: el doble
# elige el fixture por el nombre de la carpeta.
mundoforms(){ # <repo> <formularios...> — raíz y formularios, cada uno con su lockfile
  local r="$1"; shift
  rm -rf "$TMP/mundo" "$TMP/fix"; mkdir -p "$TMP/fix" "$TMP/mundo/$r"; ( cd "$TMP/mundo/$r"
    : > package-lock.json; echo "$r" > SOY
    for f in "$@"; do mkdir -p "$f"; : > "$f/package-lock.json"; done
    git init -q -b main . && git config user.email t@t && git config user.name t
    git add -A && git commit -qm publicado
    git remote add origin . && git update-ref refs/remotes/origin/main HEAD ) >/dev/null 2>&1; }
publicar(){ # <repo> <formularios...> — suma formularios a origin/main
  local r="$1"; shift
  ( cd "$TMP/mundo/$r"; for f in "$@"; do mkdir -p "$f"; : > "$f/package-lock.json"; done
    git add -A && git commit -qm "más formularios" && git update-ref refs/remotes/origin/main HEAD ) >/dev/null 2>&1; }
snap(){ node -e "const s=require('$TMP/out/dependencias-$1.json');$2"; }
CRIT='{"vulnerabilities":{"c1":{"severity":"critical","via":[{"url":"https://x/GHSA-c1"}]}},"metadata":{"vulnerabilities":{"critical":1,"high":0,"moderate":0,"low":0}}}'

# T1 Formularios_CadaLockfileSeAudita @story-4.8 @ac-1
rm -rf "$TMP/out" "$TMP/pend"; mundoforms A F1a F1b
echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$UNA" > "$TMP/fix/F1a.json"; echo "$LIMPIO" > "$TMP/fix/F1b.json"
config "$TMP/c48.json" 2 A
rc=$(noche "$TMP/c48.json" 2026-09-01)
r=$(snap 2026-09-01 "console.log(s.repos.filter(r=>r.medido).map(r=>r.producto+'/'+r.ruta+(r.subruta?'/'+r.subruta:'')).sort().join(',')+'|'+s.hallazgos.map(h=>h.repos.join('+')).join(','))")
{ [ "$rc" -eq 0 ] && [ "$r" = "A/A,A/A/F1a,A/A/F1b|A/A/F1a" ]; } \
  && ok "T1 4.8 un repo con lockfiles por formulario se audita carpeta por carpeta, cada una con su etiqueta" \
  || no "T1 4.8 carpetas: rc=$rc · $r"

# T2 NodeModules_NoEsFormulario @story-4.8 @ac-1 @ac-3
rm -rf "$TMP/out" "$TMP/pend"; mundoforms A F2 node_modules/dep F2/node_modules/otra
echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/F2.json"; echo "$UNA" > "$TMP/fix/dep.json"; echo "$UNA" > "$TMP/fix/otra.json"
config "$TMP/c48.json" 2 A
noche "$TMP/c48.json" 2026-09-01 >/dev/null
r=$(snap 2026-09-01 "const c=(s.carpetas||[])[0]||{};console.log(s.repos.length+':'+(c.total)+':'+s.repos.some(r=>/node_modules/.test(r.subruta||'')))")
[ "$r" = "2:2:false" ] && ok "T2 4.8 node_modules no se descubre como formulario (ni en la raíz ni adentro de un formulario)" \
  || no "T2 4.8 node_modules: repos:total:auditó-node_modules = $r"

# T3 Raiz_EtiquetaYFichasIguales @story-4.8 @ac-2
rm -rf "$TMP/out" "$TMP/pend"; mundoforms A
echo "$LIMPIO" > "$TMP/fix/A.json"; config "$TMP/c48.json" 2 A
noche "$TMP/c48.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c48.json" 2026-09-02 >/dev/null
publicar A F3; echo "$LIMPIO" > "$TMP/fix/F3.json"
noche "$TMP/c48.json" 2026-09-03 >/dev/null
r=$(snap 2026-09-03 "console.log(s.hallazgos.map(h=>h.repos.join('+')).join(',')+'|'+s.anunciados_hoy.length+'|'+s.reaparecidos_ids.length)")
fichas=$(ls "$TMP/pend/pending"/*.yaml 2>/dev/null | wc -l | tr -d ' ')
{ [ "$r" = "A/A|0|0" ] && [ "$fichas" -eq 1 ]; } \
  && ok "T3 4.8 la raíz sigue siendo A/A y su ficha no reaparece ni se duplica al sumarse formularios" \
  || no "T3 4.8 raíz: $r · fichas=$fichas"

# T4 LockfileQueFalla_NoMedidoConCarpeta @story-4.8 @ac-3 @ac-5
rm -rf "$TMP/out" "$TMP/pend"; mundoforms A F4 F4b
echo "$LIMPIO" > "$TMP/fix/A.json"; echo "no es json" > "$TMP/fix/F4.json"; echo "$LIMPIO" > "$TMP/fix/F4b.json"
config "$TMP/c48.json" 2 A
rc=$(noche "$TMP/c48.json" 2026-09-01)
r=$(snap 2026-09-01 "const c=s.carpetas[0];console.log(s.no_medidos.map(x=>x.ruta+'='+!!x.motivo).join(',')+'|'+s.corrida_completa+'|'+c.miradas+'/'+c.total)")
{ [ "$rc" -eq 0 ] && [ "$r" = "A/F4=true|false|2/3" ] && grep -q "NO MEDIDO — A/F4" "$TMP/o.txt"; } \
  && ok "T4 4.8 un lockfile que no se pudo auditar sale NO MEDIDO con su carpeta y su motivo; los otros se miden" \
  || no "T4 4.8 no medido: rc=$rc · $r · $(grep 'NO MEDIDO' "$TMP/o.txt")"

# T5 ExclusionSinMotivo_Sale2 @story-4.8 @ac-4
rm -rf "$TMP/out" "$TMP/pend"; mundoforms A F5 F5b
echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$UNA" > "$TMP/fix/F5.json"; echo "$LIMPIO" > "$TMP/fix/F5b.json"
configsub "$TMP/c48x.json" '{"producto":"A","ruta":"A","tipo":"npm","activo":true,"exclude":[{"path":"F5"}]}'
rc=$(noche "$TMP/c48x.json" 2026-09-01)
{ [ "$rc" -eq 2 ] && grep -q "exclude" "$TMP/o.txt" && grep -q "F5" "$TMP/o.txt" && grep -q "reason" "$TMP/o.txt" && [ ! -f "$TMP/out/dependencias-2026-09-01.json" ]; } \
  && ok "T5 4.8 una exclusión sin motivo hace salir la ejecución con 2 y lo dice" \
  || no "T5 4.8 sin motivo: rc=$rc · $(cat "$TMP/o.txt")"
configsub "$TMP/c48x.json" '{"producto":"A","ruta":"A","tipo":"npm","activo":true,"exclude":[{"path":"F5","reason":"es una demo que no se publica"}]}'
rc=$(noche "$TMP/c48x.json" 2026-09-01)
r=$(snap 2026-09-01 "const c=s.carpetas[0];console.log(s.repos.length+'|'+c.miradas+'/'+c.total+'|'+c.excluidas.map(x=>x.path+':'+x.reason).join(','))")
{ [ "$rc" -eq 0 ] && [ "$r" = "2|2/2|F5:es una demo que no se publica" ]; } \
  && ok "T5 4.8 …y con motivo esa carpeta no se audita y queda dicha como excluida" \
  || no "T5 4.8 con motivo: rc=$rc · $r"

# T7 FormularioNuevo_EntraSolo @story-4.8 @ac-1
rm -rf "$TMP/out" "$TMP/pend"; mundoforms A F7
echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/F7.json"; config "$TMP/c48.json" 2 A
noche "$TMP/c48.json" 2026-09-01 >/dev/null
publicar A F7b; echo "$LIMPIO" > "$TMP/fix/F7b.json"
noche "$TMP/c48.json" 2026-09-02 >/dev/null
r=$(snap 2026-09-02 "const c=s.carpetas[0];console.log(s.repos.some(r=>r.subruta==='F7b'&&r.medido)+'|'+c.miradas+'/'+c.total)")
[ "$r" = "true|3/3" ] && ok "T7 4.8 un formulario nuevo entra solo, sin tocar repos.json" || no "T7 4.8 formulario nuevo: $r"

# T8 PrimeraNoche_NoAnunciaAltas @story-4.8 @ac-6
# La primera noche de una carpeta no es novedad para las altas (una línea por repo en el
# resumen y a la cola); la crítica sale igual esa noche. Desde la siguiente, el circuito normal.
rm -rf "$TMP/out" "$TMP/pend"; mundoforms A
echo "$LIMPIO" > "$TMP/fix/A.json"; config "$TMP/c48.json" 2 A
noche "$TMP/c48.json" 2026-09-01 >/dev/null
publicar A F8a F8b; echo "$UNA" > "$TMP/fix/F8a.json"; echo "$CRIT" > "$TMP/fix/F8b.json"
noche "$TMP/c48.json" 2026-09-02 >/dev/null
hoy=$(snap 2026-09-02 "console.log(s.hallazgos.filter(h=>s.anunciados_hoy.includes(h.id)).map(h=>h.paquete+'['+h.severidad+']').join(','))")
r=$(snap 2026-09-02 "const c=s.carpetas[0];console.log(s.primera_noche_de_carpeta.length+'|'+c.nuevas+'|'+c.altas_nuevas+'|'+s.graves_en_carpetas_nuevas)")
grep -q "carpeta(s) nueva(s)" "$TMP/o.txt" && dice=1 || dice=0
noche "$TMP/c48.json" 2026-09-03 >/dev/null; manana=$(anunciados)
{ [ "$hoy" = "c1[critical]" ] && [ "$r" = "1|2|2|2" ] && [ "$dice" -eq 1 ] && [ "$manana" -eq 1 ]; } \
  && ok "T8 4.8 la primera noche de una carpeta anuncia la crítica y no la alta, lo dice, y la alta sale la noche siguiente" \
  || no "T8 4.8 primera noche: hoy=«${hoy}» $r dice=$dice mañana=$manana"

# T9 MismoAviso_UnaFicha @story-4.8 @ac-6
rm -rf "$TMP/out" "$TMP/pend"; mundoforms A F9a F9b F9c
for x in A F9a F9b F9c; do echo "$LIMPIO" > "$TMP/fix/$x.json"; done; config "$TMP/c48.json" 2 A
noche "$TMP/c48.json" 2026-09-01 >/dev/null
for x in F9a F9b F9c; do echo "$UNA" > "$TMP/fix/$x.json"; done
noche "$TMP/c48.json" 2026-09-02 >/dev/null
r=$(snap 2026-09-02 "console.log(s.hallazgos.length+'|'+s.hallazgos[0].repos.join(','))")
fichas=$(ls "$TMP/pend/pending"/*.yaml 2>/dev/null | wc -l | tr -d ' ')
{ [ "$r" = "1|A/A/F9a,A/A/F9b,A/A/F9c" ] && [ "$fichas" -eq 1 ]; } \
  && ok "T9 4.8 la misma alta en tres formularios es un hallazgo y una ficha, con las tres carpetas" \
  || no "T9 4.8 una ficha: $r · fichas=$fichas"

# T1 (más) @story-4.8 @ac-1 — una subcarpeta declarada que además tiene lockfile se audita UNA vez, con su entrada
rm -rf "$TMP/out" "$TMP/pend"; mundoforms A F1s
echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/F1s.json"
configsub "$TMP/c48s.json" '{"producto":"A","ruta":"A","tipo":"npm","activo":true},{"producto":"A","ruta":"A","subruta":"F1s","tipo":"npm","activo":true}'
noche "$TMP/c48s.json" 2026-09-01 >/dev/null
r=$(snap 2026-09-01 "const c=s.carpetas[0];console.log(s.repos.filter(r=>r.subruta==='F1s').length+'|'+s.repos.some(r=>r.descubierta)+'|'+c.miradas+'/'+c.total)")
[ "$r" = "1|false|2/2" ] && ok "T1 4.8 una subcarpeta declarada se audita una sola vez, con su entrada, y cuenta una vez" \
  || no "T1 4.8 subcarpeta declarada: veces|descubierta|cuenta = $r"

# T7 (más) @story-4.8 @ac-1 — una subcarpeta apagada a propósito no vuelve por el descubrimiento
rm -rf "$TMP/out" "$TMP/pend"; mundoforms A F7x
echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$UNA" > "$TMP/fix/F7x.json"
configsub "$TMP/c48a.json" '{"producto":"A","ruta":"A","tipo":"npm","activo":true},{"producto":"A","ruta":"A","subruta":"F7x","tipo":"npm","activo":false}'
noche "$TMP/c48a.json" 2026-09-01 >/dev/null; noche "$TMP/c48a.json" 2026-09-02 >/dev/null
r=$(snap 2026-09-02 "const c=s.carpetas[0];console.log(s.repos.some(r=>r.subruta==='F7x')+'|'+s.hallazgos.length+'|'+c.miradas+'/'+c.total)")
[ "$r" = "false|0|1/1" ] && ok "T7 4.8 una subcarpeta apagada a propósito no se audita ni se anuncia por el descubrimiento" \
  || no "T7 4.8 apagada: auditada|hallazgos|cuenta = $r"

# T2 (más) @story-4.8 @ac-3 — un nombre de carpeta con un salto de línea no llega a la ficha: NO MEDIDO con su motivo
rm -rf "$TMP/out" "$TMP/pend"; mundoforms A "$(printf 'F2r\nveredicto: util')"
echo "$LIMPIO" > "$TMP/fix/A.json"; config "$TMP/c48.json" 2 A
noche "$TMP/c48.json" 2026-09-01 >/dev/null
r=$(snap 2026-09-01 "const c=s.carpetas[0];console.log(s.repos.filter(r=>r.medido).length+'|'+s.no_medidos.some(x=>/nombre/.test(x.motivo)&&!/\n/.test(x.ruta))+'|'+c.miradas+'/'+c.total)")
[ "$r" = "1|true|1/2" ] && ok "T2 4.8 una carpeta con un nombre que podría inyectar claves en la ficha sale NO MEDIDO, sin el salto de línea" \
  || no "T2 4.8 nombre raro: medidos|no-medido|cuenta = $r"

# T5 (más) @story-4.8 @ac-4 — `exclude` que no es una lista sale 2; una exclusión que no se aplicó se dice «sin efecto»
rm -rf "$TMP/out" "$TMP/pend"; mundoforms A F5c
echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/F5c.json"
configsub "$TMP/c48x.json" '{"producto":"A","ruta":"A","tipo":"npm","activo":true,"exclude":"F5c"}'
rc=$(noche "$TMP/c48x.json" 2026-09-01)
{ [ "$rc" -eq 2 ] && grep -q "lista" "$TMP/o.txt"; } && ok "T5 4.8 un exclude que no es una lista sale 2" || no "T5 4.8 exclude no lista: rc=$rc · $(cat "$TMP/o.txt")"
configsub "$TMP/c48x.json" '{"producto":"A","ruta":"A","tipo":"npm","activo":true,"exclude":[{"path":"NoExiste","reason":"un tipeo"}]}'
rc=$(noche "$TMP/c48x.json" 2026-09-01)
r=$(snap 2026-09-01 "const c=s.carpetas[0];console.log(c.excluidas.length+'|'+c.sin_efecto.map(x=>x.path).join(',')+'|'+c.miradas+'/'+c.total)")
{ [ "$rc" -eq 0 ] && [ "$r" = "0|NoExiste|2/2" ] && grep -q "sin efecto" "$TMP/o.txt"; } \
  && ok "T5 4.8 una exclusión sobre una carpeta sin lockfile no se cuenta como excluida: se dice «sin efecto»" \
  || no "T5 4.8 sin efecto: rc=$rc · $r"

# T8 (más) @story-4.8 @ac-6 — un formulario que nunca se puede auditar no deja en espera para siempre las altas de los
# demás: una noche incompleta no es línea base, pero sí dice qué carpetas ya se vieron
rm -rf "$TMP/out" "$TMP/pend"; mundoforms A
echo "$LIMPIO" > "$TMP/fix/A.json"; config "$TMP/c48.json" 2 A
noche "$TMP/c48.json" 2026-09-01 >/dev/null
publicar A F8n F8x; echo "$UNA" > "$TMP/fix/F8n.json"; echo "no es json" > "$TMP/fix/F8x.json"
noche "$TMP/c48.json" 2026-09-02 >/dev/null; primera=$(anunciados)
noche "$TMP/c48.json" 2026-09-03 >/dev/null; segunda=$(anunciados)
{ [ "$primera" -eq 0 ] && [ "$segunda" -eq 1 ]; } \
  && ok "T8 4.8 con un formulario que no se puede auditar, la alta de otro formulario nuevo sale igual la noche siguiente" \
  || no "T8 4.8 espera eterna: anunció $primera y después $segunda"

# T9 Note_PrRepo_And_GithubText @story-8.32 @ac-3 @ac-7 — el pull request de GitHub vive en el repo de operaciones:
# la ficha recuerda de qué repo es, y el texto no menciona a nadie ni cierra el issue del producto
G1="$TMP/g1.yaml"; fichafalsa "$G1"
rcg=$(note --card "$G1" --pr 12 --pr-repo acme-org/harness-ops)
{ [ "$rcg" = 0 ] && grep -q '^pr: 12$' "$G1" && grep -q '^pr_repo: acme-org/harness-ops$' "$G1" \
  && grep -q '^# la nota de una persona' "$G1"; } \
  && ok "T9 8.32 note --pr --pr-repo escribe pr: y pr_repo: sin tocar lo demás" \
  || no "T9 8.32 pr_repo: rc=$rcg · $(grep -E '^pr' "$G1" | tr '\n' ' ')"
G2="$TMP/g2.yaml"; fichafalsa "$G2"; antesg=$(cat "$G2")
rcm1=$(note --card "$G2" --pr 12 --pr-repo "sin-barra"); rcm2=$(note --card "$G2" --pr 12 --pr-repo "a/b/c"); rcm3=$(note --card "$G2" --pr 12 --pr-repo 'a/b c')
{ [ "$rcm1" = 2 ] && [ "$rcm2" = 2 ] && [ "$rcm3" = 2 ] && [ "$(cat "$G2")" = "$antesg" ]; } \
  && ok "T9 8.32 un --pr-repo mal formado sale 2 y no toca la ficha" || no "T9 8.32 pr-repo malo: $rcm1 $rcm2 $rcm3"
G3="$TMP/g3.yaml"; fichafalsa "$G3"
rcr=$(note --card "$G3" --rejected 2026-10-20 --reason "no aplica" --pr 5 --pr-repo acme-org/harness-ops)
{ [ "$rcr" = 0 ] && grep -q '^pr_repo: acme-org/harness-ops$' "$G3" && grep -q '^rechazado: 2026-10-20$' "$G3"; } \
  && ok "T9 8.32 note --rejected --pr-repo escribe también pr_repo:" || no "T9 8.32 rejected+pr_repo: rc=$rcr"
# alineado: el estado de la última alineación del issue con el pull request
G4="$TMP/g4.yaml"; fichafalsa "$G4"
rca=$(note --card "$G4" --aligned "12:merged"); rcb=$(note --card "$G4" --aligned "12:closed")
rce=$(note --card "$G4" --aligned "12:raro"); rcf=$(note --card "$G4" --aligned "xx:merged")
{ [ "$rca" = 0 ] && [ "$rcb" = 0 ] && [ "$rce" = 2 ] && [ "$rcf" = 2 ] && grep -q '^alineado: 12:closed$' "$G4" \
  && [ "$(grep -c '^alineado:' "$G4")" = 1 ]; } \
  && ok "T9 8.32 note --aligned escribe alineado: (un solo renglón); un estado o número inválido sale 2" \
  || no "T9 8.32 alineado: $rca $rcb $rce $rcf · $(grep '^alineado' "$G4" | tr '\n' ' ')"
# una ficha con pr_repo: que reaparece conserva la historia en pr_repo_antes
rm -rf "$TMP/out" "$TMP/pend"; mundo A; echo "$LIMPIO" > "$TMP/fix/A.json"; configx "$TMP/c-t98.json" 2 A
noche "$TMP/c-t98.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/c-t98.json" 2026-09-02 >/dev/null
ID98=$(basename "$(unaficha pending)" .yaml); aceptar "$ID98"; F98="$TMP/pend/promoted/$ID98.yaml"
node "$NOC" note --card "$F98" --pr 41 --pr-repo acme-org/harness-ops >/dev/null 2>&1
node "$NOC" note --card "$F98" --aligned "41:merged" >/dev/null 2>&1
echo "$LIMPIO" > "$TMP/fix/A.json"; noche "$TMP/c-t98.json" 2026-09-03 >/dev/null
echo "$UNA" > "$TMP/fix/A.json";    noche "$TMP/c-t98.json" 2026-09-04 >/dev/null
R98="$TMP/pend/pending/$ID98.yaml"
{ [ -f "$R98" ] && grep -q '^pr_antes: 41$' "$R98" && grep -q '^pr_repo_antes: acme-org/harness-ops$' "$R98" \
  && ! grep -q '^pr:' "$R98" && ! grep -q '^pr_repo:' "$R98" && ! grep -q '^alineado:' "$R98"; } \
  && ok "T9 8.32 una ficha que reaparece deja pr_antes: y pr_repo_antes:, y empieza sin pr_repo: ni alineado:" \
  || no "T9 8.32 reaparece: $(grep -E '^(pr|alineado)' "$R98" 2>/dev/null | tr '\n' ' ')"
# el texto del pull request de GitHub
G5="$TMP/g5.yaml"; cat > "$G5" <<'FICHA'
id: cc33dd44
detectado: 2026-10-20
veredicto: pendiente
paquete: @scope/paquete
severidad: high
noches: 2
pr_antes: 9
rechazado_antes: 2026-10-10
motivo_rechazo_antes: "no aplica"
pedidos:
  - acme-org/web: 101
  - acme-org/api: 202
ids:
  - cc33dd44
repos:
  - A/A
avisos:
  - https://github.com/advisories/GHSA-aaaa-bbbb-cccc
FICHA
TG=$(node "$NOC" pr-text --draft "$G5" --destination pr-github 2>&1)
TA=$(node "$NOC" pr-text --draft "$G5" 2>&1); TA2=$(node "$NOC" pr-text --draft "$G5" --destination pr 2>&1)
{ case "$TG" in *'**`@scope/paquete`**'*) true ;; *) false ;; esac \
  && ! printf '%s' "$TG" | sed -n '/^---CUERPO---$/,$p' | grep '[^`]@scope' >/dev/null \
  && case "$TG" in *'PR #9'*) true ;; *) false ;; esac && ! printf '%s' "$TG" | grep '!9' >/dev/null \
  && printf '%s' "$TG" | grep '^- acme-org/web#101$' >/dev/null && printf '%s' "$TG" | grep '^- acme-org/api#202$' >/dev/null \
  && ! printf '%s' "$TG" | grep -iE '\b(closes|fixes|resolves)\b' >/dev/null; } \
  && ok "T9 8.32 pr-text --destination pr-github: sin mención, #N, issues sin palabras de cierre" \
  || no "T9 8.32 pr-github: $(printf '%s' "$TG" | head -12 | tr '\n' '~')"
{ [ "$TA" = "$TA2" ] && printf '%s' "$TA" | grep 'PR !9' >/dev/null && ! printf '%s' "$TA" | grep 'acme-org/web#101' >/dev/null; } \
  && ok "T9 8.32 el texto de Azure (--destination pr) no cambia" || no "T9 8.32 Azure cambió"
rcd=$(node "$NOC" pr-text --draft "$G5" --destination raro >/dev/null 2>&1; echo $?)
[ "$rcd" = 2 ] && ok "T9 8.32 un --destination desconocido sale 2" || no "T9 8.32 destination raro: rc=$rcd"

# T9 (más) — el motivo de un rechazo anterior y los pedidos de afuera no se vuelven mención ni enlace
G6="$TMP/g6.yaml"; cat > "$G6" <<'FICHA'
id: ee55ff66
detectado: 2026-10-20
veredicto: pendiente
paquete: pkg
severidad: high
noches: 2
pr_antes: 9
rechazado_antes: 2026-10-10
motivo_rechazo_antes: "@victima mirá #5"
pedidos:
  - acme-org/web: 101
  - @x: 3
ids:
  - ee55ff66
repos:
  - A/A
avisos:
  - https://github.com/advisories/GHSA-aaaa-bbbb-cccc
FICHA
TG6=$(node "$NOC" pr-text --draft "$G6" --destination pr-github 2>&1)
CU6=$(printf '%s' "$TG6" | sed -n '/^---CUERPO---$/,$p')
{ printf '%s' "$CU6" | grep 'victima' >/dev/null \
  && ! printf '%s' "$CU6" | grep '[^`]@victima' >/dev/null && ! printf '%s' "$CU6" | grep -E '(^|[^`])#5([^`]|$)' >/dev/null ; } \
  && ok "T9 8.32 pr-github: el motivo del rechazo anterior no menciona a nadie ni enlaza #5" \
  || no "T9 8.32 motivo sin escapar: $(printf '%s' "$CU6" | grep -n 'victima' | head -3)"
{ printf '%s' "$CU6" | grep '^- acme-org/web#101$' >/dev/null && ! printf '%s' "$CU6" | grep '@x' >/dev/null; } \
  && ok "T9 8.32 pr-github: un pedido cuyo proyecto no es dueño/repo no sale en la lista" \
  || no "T9 8.32 proyecto inválido en la lista: $(printf '%s' "$CU6" | grep -n '@x#\|@x' | head -3)"

# ══════════════════════════════════════════════════════════════════════════════════════════════
# dependencias-por-formulario A..E — al mirar cada formulario: la deuda de la raíz cubre a sus formularios,
# una ficha reactivada trae los repos de hoy, dos hallazgos del mismo paquete son una ficha, y lo que vuelve
# pasa por el tope de altas.
# ══════════════════════════════════════════════════════════════════════════════════════════════
RAIZ_DEBE=A
deuda_en(){ # <carpeta relativa a mundo/A, "" = raíz> <vencimiento> <aviso>... — declara browserslist, COMMITEADA
  local d="$1" vence="$2"; shift 2; local avs="" a
  for a in "$@"; do avs="$avs\"$a\","; done
  mkdir -p "$TMP/mundo/$RAIZ_DEBE/$d"
  echo "{\"revision\":\"$vence\",\"paquetes\":[{\"paquete\":\"browserslist\",\"advisories\":[${avs%,}]}]}" \
    > "$TMP/mundo/$RAIZ_DEBE/$d/vulnerabilidades-pendientes.json"
  ( cd "$TMP/mundo/$RAIZ_DEBE" && git add -A && git commit -qm "declaro la deuda" \
    && git update-ref refs/remotes/origin/main HEAD ) >/dev/null 2>&1
}
UNA_OTRO='{"vulnerabilities":{"browserslist":{"severity":"high","via":[{"url":"https://x/GHSA-otro"}]}},"metadata":{"vulnerabilities":{"critical":0,"high":1,"moderate":0,"low":0}}}'
ALTA_X='{"vulnerabilities":{"px":{"severity":"high","via":[{"url":"https://x/GHSA-px"}]}},"metadata":{"vulnerabilities":{"critical":0,"high":1,"moderate":0,"low":0}}}'
ALTA_Y='{"vulnerabilities":{"py":{"severity":"high","via":[{"url":"https://x/GHSA-py"}]}},"metadata":{"vulnerabilities":{"critical":0,"high":1,"moderate":0,"low":0}}}'

# A. la deuda de la raíz cubre al formulario descubierto; si el formulario tiene la suya, manda la suya
rm -rf "$TMP/out" "$TMP/pend"; mundoforms A FA
echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/FA.json"; config "$TMP/cdf.json" 2 A
noche "$TMP/cdf.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/FA.json"; deuda_en "" 2026-12-31 GHSA-73wf
noche "$TMP/cdf.json" 2026-09-02 >/dev/null
r=$(snap 2026-09-02 "const f=s.repos.find(r=>r.subruta==='FA');console.log(s.hallazgos.length+'|'+s.anunciados_hoy.length+'|'+f.graves.map(g=>g.paquete+':'+g.declarada).join(','))")
nf=$(ls "$TMP/pend"/*/*.yaml 2>/dev/null | wc -l | tr -d ' ')
{ [ "$r" = "0|0|browserslist:true" ] && [ "$nf" -eq 0 ]; } \
  && ok "dependencias-por-formulario A: la deuda declarada en la raíz cubre al formulario descubierto (declarada, sin hallazgo ni ficha)" \
  || no "dependencias-por-formulario A: hallazgos|anunciados|graves = $r · fichas=$nf (esperado 0|0|browserslist:true y 0 fichas)"
deuda_en FA 2026-12-31 GHSA-otro   # el formulario declara la suya, de OTRO aviso: la de la raíz ya no vale ahí
noche "$TMP/cdf.json" 2026-09-03 >/dev/null
r=$(snap 2026-09-03 "const f=s.repos.find(r=>r.subruta==='FA');console.log(s.hallazgos.length+'|'+f.graves.map(g=>g.declarada).join(','))")
[ "$r" = "1|false" ] \
  && ok "dependencias-por-formulario A: si el formulario tiene su propio archivo de deuda, manda el suyo" \
  || no "dependencias-por-formulario A: archivo propio: hallazgos|declarada = $r (esperado 1|false)"

# B. una ficha archivada por deuda que vuelve sin declarar se reactiva CON los repos de hoy
rm -rf "$TMP/out" "$TMP/pend"; mundoforms A FB
echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/FB.json"; config "$TMP/cdf.json" 2 A
noche "$TMP/cdf.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/FB.json"; noche "$TMP/cdf.json" 2026-09-02 >/dev/null
IDB=$(basename "$(unaficha pending)" .yaml)
deuda_en FB 2026-12-31 GHSA-73wf; noche "$TMP/cdf.json" 2026-09-03 >/dev/null
[ -f "$TMP/pend/archived/$IDB.yaml" ] || no "dependencias-por-formulario B: la deuda del formulario no archivó la ficha (preparación)"
deuda_en FB 2026-01-01 GHSA-73wf   # vence: vuelve sin declarar
noche "$TMP/cdf.json" 2026-09-04 >/dev/null
FB="$TMP/pend/pending/$IDB.yaml"
{ [ -f "$FB" ] && grep -q "^reaparecido: 2026-09-04$" "$FB" && grep -qE '^repos:$' "$FB" && grep -q '^  - A/A/FB$' "$FB"; } \
  && ok "dependencias-por-formulario B: la ficha reactivada trae los repos de hoy en repos:" \
  || no "dependencias-por-formulario B: ficha reactivada sin repos: — $(grep -E '^(veredicto|reaparecido|repos|  - )' "$FB" 2>/dev/null | tr '\n' ' ') · $(ls "$TMP/pend"/*/*.yaml | tr '\n' ' ')"

# C. dos hallazgos nuevos del mismo paquete y el mismo proyecto, la misma noche: UNA ficha
rm -rf "$TMP/out" "$TMP/pend"; mundoforms A FC1 FC2
for x in A FC1 FC2; do echo "$LIMPIO" > "$TMP/fix/$x.json"; done; config "$TMP/cdf.json" 4 A
noche "$TMP/cdf.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/FC1.json"; echo "$UNA_OTRO" > "$TMP/fix/FC2.json"
noche "$TMP/cdf.json" 2026-09-02 >/dev/null
nf=$(ls "$TMP/pend/pending"/*.yaml 2>/dev/null | wc -l | tr -d ' ')
FC=$(unaficha pending)
r=$(snap 2026-09-02 "console.log(s.anunciados_hoy.length+'|'+new Set(s.anunciados_hoy).size)")
{ [ "$nf" -eq 1 ] && [ -n "$FC" ] && [ "$(grep -c '^  - [0-9a-f]\{8\}$' "$FC")" -eq 2 ] \
  && grep -q 'GHSA-73wf' "$FC" && grep -q 'GHSA-otro' "$FC" && [ "${r%%|*}" = "${r##*|}" ]; } \
  && ok "dependencias-por-formulario C: dos hallazgos del mismo paquete y proyecto son una ficha con los dos ids y los avisos unidos" \
  || no "dependencias-por-formulario C: fichas=$nf · anunciados|únicos=$r · $(grep -E '^  - ' "${FC:-/dev/null}" 2>/dev/null | tr '\n' ' ')"

# D. lo que reactiva la vigilancia respeta el tope de altas por noche; la crítica no espera
cenario_d(){ # <fixture de FD> <tope> — FD tiene una ficha archivada por deuda que vuelve la noche 3 junto con dos altas nuevas
  rm -rf "$TMP/out" "$TMP/pend"; mundoforms A FD FX FY
  for x in A FD FX FY; do echo "$LIMPIO" > "$TMP/fix/$x.json"; done; config "$TMP/cdf.json" "$2" A
  noche "$TMP/cdf.json" 2026-09-01 >/dev/null
  echo "$1" > "$TMP/fix/FD.json"; noche "$TMP/cdf.json" 2026-09-02 >/dev/null
  IDD=$(basename "$(unaficha pending)" .yaml)
  deuda_en FD 2026-12-31 GHSA-73wf; noche "$TMP/cdf.json" 2026-09-03 >/dev/null
  deuda_en FD 2026-01-01 GHSA-73wf   # vence: vuelve; y en la misma noche hay dos altas nuevas
  echo "$ALTA_X" > "$TMP/fix/FX.json"; echo "$ALTA_Y" > "$TMP/fix/FY.json"
  noche "$TMP/cdf.json" 2026-09-04 >/dev/null
}
cenario_d "$UNA" 2
# la que vuelve compite por el cupo con las dos nuevas (las tres son altas de una noche): entran dos, una espera
{ snap 2026-09-04 "process.exit(new Set(s.anunciados_hoy).size===2&&s.postergados_por_presupuesto.length===1?0:1)" \
  && [ "$(ls "$TMP/pend/pending"/*.yaml 2>/dev/null | wc -l | tr -d ' ')" -eq 2 ]; } \
  && ok "dependencias-por-formulario D: con tope 2, entre la ficha ALTA que vuelve y dos altas nuevas se anuncian dos y una queda postergada" \
  || no "dependencias-por-formulario D: la alta reactivada se saltó el tope — $(ls "$TMP/pend"/*/*.yaml | tr '\n' ' ')"
CRIT_B='{"vulnerabilities":{"browserslist":{"severity":"critical","via":[{"url":"https://x/GHSA-73wf"}]}},"metadata":{"vulnerabilities":{"critical":1,"high":0,"moderate":0,"low":0}}}'
cenario_d "$CRIT_B" 2
{ [ -f "$TMP/pend/pending/$IDD.yaml" ] && snap 2026-09-04 "process.exit(s.reaparecidos_ids.includes('$IDD')?0:1)"; } \
  && ok "dependencias-por-formulario D: una CRÍTICA que vuelve se reactiva aunque el tope esté lleno" \
  || no "dependencias-por-formulario D: la crítica que vuelve no se reactivó — $(ls "$TMP/pend"/*/*.yaml | tr '\n' ' ')"
# …y una alta que vuelve sólo en una carpeta que es su primera noche tampoco se reactiva
rm -rf "$TMP/out" "$TMP/pend"; mundoforms A F0
echo "$LIMPIO" > "$TMP/fix/A.json"; echo "$LIMPIO" > "$TMP/fix/F0.json"; config "$TMP/cdf.json" 2 A
noche "$TMP/cdf.json" 2026-09-01 >/dev/null
echo "$UNA" > "$TMP/fix/A.json"; noche "$TMP/cdf.json" 2026-09-02 >/dev/null
IDN=$(basename "$(unaficha pending)" .yaml)
deuda_en "" 2026-12-31 GHSA-73wf; noche "$TMP/cdf.json" 2026-09-03 >/dev/null
[ -f "$TMP/pend/archived/$IDN.yaml" ] || no "dependencias-por-formulario D: la deuda de la raíz no archivó la ficha (preparación)"
deuda_en "" 2026-01-01 GHSA-73wf; echo "$LIMPIO" > "$TMP/fix/A.json"
publicar A FN; echo "$UNA" > "$TMP/fix/FN.json"        # vuelve SOLO en FN, que hoy es su primera noche
noche "$TMP/cdf.json" 2026-09-04 >/dev/null
{ [ -f "$TMP/pend/archived/$IDN.yaml" ] && [ ! -f "$TMP/pend/pending/$IDN.yaml" ]; } \
  && ok "dependencias-por-formulario D: una alta que vuelve sólo en carpetas de su primera noche no se reactiva" \
  || no "dependencias-por-formulario D: se reactivó por una carpeta de primera noche — $(ls "$TMP/pend"/*/*.yaml | tr '\n' ' ')"

# E. pr-text no arma el texto de una ficha sin repos
SINREPO="$TMP/sinrepo.yaml"
cat > "$SINREPO" <<'FICHA'
id: aa11bb22
detectado: 2026-09-05
veredicto: pendiente
paquete: browserslist
severidad: high
noches: 1
ids:
  - aa11bb22
avisos:
  - https://x/GHSA-73wf
FICHA
TE=$(node "$NOC" pr-text --draft "$SINREPO" 2>&1); rce=$?
{ [ "$rce" -ne 0 ] && printf '%s' "$TE" | grep -i "no nombra ning" >/dev/null ; } \
  && ok "dependencias-por-formulario E: pr-text rechaza una ficha sin repos: y lo dice" \
  || no "dependencias-por-formulario E: rc=$rce · $(printf '%s' "$TE" | head -2 | tr '\n' ' ')"

echo
total=$((pasaron + fallos))
[ "$fallos" -eq 0 ] && { echo "✅ nocturno-dependencias: $pasaron/$total"; exit 0; } || { echo "❌ nocturno-dependencias: $fallos fallo(s) de $total"; exit 1; }
