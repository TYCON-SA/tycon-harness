#!/usr/bin/env bash
# githook-git-dir-chain.test.sh — los ganchos propios del repo en `.git/hooks/`, disparados por git de verdad.
#
# Con `core.hooksPath` global git usa sólo esa carpeta: el `.git/hooks/<gancho>` de cada repo deja de correr, en
# silencio. Los tres ganchos globales del arnés (pre-commit, post-commit, pre-push) lo corren en su lugar: después del
# `.local` de la persona y antes del `.githooks/` del repo y de los controles del arnés. Esta suite lo mira con commits
# y empujes reales: si el commit se crea, si la ref remota cambia, y qué anotó cada gancho y en qué orden.
#
# Todo corre en repos de laboratorio bajo mktemp, con HOME propia y sin la configuración de git de la máquina (la
# carpeta global se pasa con `-c core.hooksPath=` en cada comando). El arnés del laboratorio trae dos piezas de mentira
# que sólo anotan: el compilado de SQL (cuenta cuántas veces corrieron los controles del pre-commit) y el freno de
# publicación (dice si corrió y cuándo).
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PRE="$RAIZ/scripts/hooks/git-pre-commit-global.sh"
POST="$RAIZ/scripts/hooks/git-post-commit-global.sh"
PUSH="$RAIZ/scripts/hooks/git-pre-push-global.sh"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
for f in "$PRE" "$POST" "$PUSH"; do [ -f "$f" ] || { echo "  MAL  — no encontré $f"; exit 1; }; done
command -v node >/dev/null 2>&1 || { echo "  MAL  — falta node: sin él no corren las piezas de mentira del laboratorio"; exit 1; }

# Fechas fijas y sin el mantenimiento automático de git: un sha que cambia o un `gc` de fondo hacen rojos de azar.
export GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z
QUIEN=(-c user.name=Prueba -c user.email=prueba@example.com -c commit.gpgsign=false -c maintenance.auto=false -c gc.auto=0)
g() { GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git "$@"; }
TODOS=()
trap 'rm -rf ${TODOS[@]+"${TODOS[@]}"}' EXIT

# ── El laboratorio: core.hooksPath → los tres ganchos globales → .git/hooks/ y .githooks/ del repo ──────────────────
nuevo() {
  local T; T="$(mktemp -d)"; TODOS+=("$T")
  mkdir -p "$T/hooks" "$T/casa" "$T/arnes/scripts/ci" "$T/arnes/scripts/hooks"
  cp "$PRE" "$T/hooks/pre-commit"; cp "$POST" "$T/hooks/post-commit"; cp "$PUSH" "$T/hooks/pre-push"
  chmod +x "$T/hooks/pre-commit" "$T/hooks/post-commit" "$T/hooks/pre-push"
  # las dos piezas de mentira: anotan en LAB_LOG y salen 0
  printf '%s\n' "require('fs').appendFileSync(process.env.LAB_LOG, 'sql\\n')" > "$T/arnes/scripts/ci/sql-compile.js"
  printf '%s\n' "require('fs').appendFileSync(process.env.LAB_LOG, 'freno\\n')" > "$T/arnes/scripts/hooks/public-push-guard.js"
  : > "$T/log"
  g init -q --bare -b main "$T/remoto.git"
  g init -q -b main "$T/repo"
  ( cd "$T/repo" && printf 'base\n' > README.md && g add -A && g "${QUIEN[@]}" commit -q -m base \
      && g remote add origin "$T/remoto.git" && g -c core.hooksPath=/dev/null push -q origin main ) \
    || { echo "  MAL  — no pude armar el laboratorio"; exit 1; }
  printf '%s' "$T"
}
# Un gancho del repo de juguete que anota su nombre y sale con el código pedido. gancho <archivo> <nombre> [código]
gancho() {
  mkdir -p "$(dirname "$1")"
  printf '#!/usr/bin/env bash\necho %s >> "$LAB_LOG"\nexit %s\n' "$2" "${3:-0}" > "$1"; chmod +x "$1"
}
# Corre un comando de git con la cadena enchufada, con tope de 30 s (un lazo no cuelga la suite). Deja la salida en
# $T/out.txt y devuelve su código; 124 si se pasó del tope.
con_cadena() {
  local T="$1" desde="$2"; shift 2
  ( export HOME="$T/casa" USERPROFILE="$T/casa" TYCON_GUIDES_DIR="$T/arnes" LAB_LOG="$T/log" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
    cd "$desde" && exec git -c core.hooksPath="$T/hooks" "${QUIEN[@]}" "$@" ) > "$T/out.txt" 2>&1 &
  local pid=$! n=0
  while kill -0 "$pid" 2>/dev/null; do
    n=$((n+1)); if [ "$n" -gt 300 ]; then pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; return 124; fi
    sleep 0.1
  done
  wait "$pid"
}
commitear() {   # commitear <T> [carpeta]
  local T="$1" desde="${2:-$1/repo}"
  printf '%s\n' "$RANDOM$RANDOM" >> "$desde/cambio.txt"; g -C "$desde" add cambio.txt
  con_cadena "$T" "$desde" commit -q -m "un cambio"
}
cuantos() { g -C "${2:-$1/repo}" rev-list --count HEAD; }
veces() { grep -cx "$2" "$1/log"; }

# ── T1 · un .git/hooks/pre-commit que rechaza: el commit NO se crea, y la salida lo nombra ─────────────────────────
T="$(nuevo)"; gancho "$T/repo/.git/hooks/pre-commit" gitdir 1
A="$(cuantos "$T")"; commitear "$T"; RC=$?
if [ "$RC" -ne 0 ] && [ "$(cuantos "$T")" = "$A" ] && grep -q '\.git/hooks/pre-commit' "$T/out.txt"; then
  ok "T1 PreCommit_GitDirHook_Rechaza: el commit no se crea y la salida nombra .git/hooks/pre-commit"
else mal "T1 rc=$RC commits ${A}→$(cuantos "$T")"; sed -n '1,8p' "$T/out.txt"; fi

# ── T2 · uno que acepta: el commit entra, y corrió una sola vez ──────────────────────────────────────────────────
T="$(nuevo)"; gancho "$T/repo/.git/hooks/pre-commit" gitdir 0
A="$(cuantos "$T")"; commitear "$T"; RC=$?
if [ "$RC" -eq 0 ] && [ "$(cuantos "$T")" = "$((A+1))" ] && [ "$(veces "$T" gitdir)" = 1 ]; then
  ok "T2 PreCommit_GitDirHook_AceptaYCorreUnaVez: el commit entra y el del repo corrió una vez"
else mal "T2 rc=$RC commits ${A}→$(cuantos "$T") · corrió $(veces "$T" gitdir) vez/veces"; sed -n '1,8p' "$T/out.txt"; fi

# ── T3 · post-commit: corre, su falla no cambia nada y el aviso de lo que quedó afuera sigue saliendo ─────────────
T="$(nuevo)"; gancho "$T/repo/.git/hooks/post-commit" post 1; printf 'suelto\n' > "$T/repo/suelto.txt"
A="$(cuantos "$T")"; commitear "$T"; RC=$?
if [ "$RC" -eq 0 ] && [ "$(cuantos "$T")" = "$((A+1))" ] && [ "$(veces "$T" post)" = 1 ] && grep -q 'quedaron afuera' "$T/out.txt"; then
  ok "T3 PostCommit_GitDirHook_CorreYSuFallaNoCambiaNada: corrió una vez, el commit quedó y salió el aviso"
else mal "T3 rc=$RC commits ${A}→$(cuantos "$T") · corrió $(veces "$T" post)"; sed -n '1,8p' "$T/out.txt"; fi

# ── T4 · pre-push: recibe los argumentos y la entrada de git; su rechazo frena; si acepta, el freno corre después ─
T="$(nuevo)"
mkdir -p "$T/repo/.git/hooks"
cat > "$T/repo/.git/hooks/pre-push" <<'EOF'
#!/usr/bin/env bash
echo prepush >> "$LAB_LOG"
printf 'args:%s|%s\n' "$1" "$2" >> "$LAB_LOG.detalle"
while read -r l; do printf 'in:%s\n' "$l" >> "$LAB_LOG.detalle"; done
exit "${PREPUSH_RC:-0}"
EOF
chmod +x "$T/repo/.git/hooks/pre-push"
( cd "$T/repo" && printf 'x\n' > nuevo.txt && g add -A && g "${QUIEN[@]}" -c core.hooksPath=/dev/null commit -q -m nuevo )
PUNTA="$(g -C "$T/repo" rev-parse HEAD)"
PREPUSH_RC=1 con_cadena "$T" "$T/repo" push -q origin main; RC1=$?
REMOTA1="$(g -C "$T/remoto.git" rev-parse main)"
FRENO1="$(veces "$T" freno)"
con_cadena "$T" "$T/repo" push -q origin main; RC2=$?
REMOTA2="$(g -C "$T/remoto.git" rev-parse main)"
ORDEN="$(tr '\n' ' ' < "$T/log")"
if [ "$RC1" -ne 0 ] && [ "$REMOTA1" != "$PUNTA" ] && [ "$FRENO1" = 0 ]; then T4A=1; else T4A=0; fi
if [ "$T4A" = 1 ] && [ "$RC2" -eq 0 ] && [ "$REMOTA2" = "$PUNTA" ] && [ "$ORDEN" = "prepush prepush freno " ] \
   && grep -q "^args:origin|$T/remoto.git\$" "$T/log.detalle" && grep -q "^in:refs/heads/main $PUNTA refs/heads/main " "$T/log.detalle"; then
  ok "T4 PrePush_GitDirHook_ArgumentosEntradaYVeredicto: su rechazo frena; si acepta, sale y el freno corre después"
else mal "T4 rechazo rc=$RC1 (freno $FRENO1) · acepta rc=$RC2 · remota=$REMOTA2 punta=$PUNTA · orden «${ORDEN}»"; cat "$T/log.detalle" 2>/dev/null | head -4; fi

# el mensaje del rechazo, aparte (la salida del primer empuje la pisó el segundo)
T="$(nuevo)"; gancho "$T/repo/.git/hooks/pre-push" prepush 1
( cd "$T/repo" && printf 'x\n' > nuevo.txt && g add -A && g "${QUIEN[@]}" -c core.hooksPath=/dev/null commit -q -m nuevo )
con_cadena "$T" "$T/repo" push -q origin main; RC=$?
if [ "$RC" -ne 0 ] && grep -q '\.git/hooks/pre-push' "$T/out.txt"; then ok "T4 el rechazo del pre-push del repo se nombra"
else mal "T4 rechazo sin nombrar: rc=$RC"; sed -n '1,6p' "$T/out.txt"; fi

# ── T5 · orden: .local → .git/hooks → .githooks ──────────────────────────────────────────────────────────────────
T="$(nuevo)"
gancho "$T/hooks/pre-commit.local" local 0
gancho "$T/repo/.git/hooks/pre-commit" gitdir 0
gancho "$T/repo/.githooks/pre-commit" githooks 0
commitear "$T"; RC=$?
ORDEN="$(grep -vx sql "$T/log" | tr '\n' ' ')"
if [ "$RC" -eq 0 ] && [ "$ORDEN" = "local gitdir githooks " ]; then ok "T5 Orden_LocalGitDirGithooks: local, .git/hooks, .githooks"
else mal "T5 rc=$RC orden «${ORDEN}»"; fi

# ── T6 · no dos veces ────────────────────────────────────────────────────────────────────────────────────────────
# (a) .git/hooks/pre-commit es un enlace al .githooks/pre-commit del repo
T="$(nuevo)"; gancho "$T/repo/.githooks/pre-commit" githooks 0
if ln -s ../../.githooks/pre-commit "$T/repo/.git/hooks/pre-commit" 2>/dev/null && [ -L "$T/repo/.git/hooks/pre-commit" ]; then
  commitear "$T"; RC=$?
  if [ "$RC" -eq 0 ] && [ "$(veces "$T" githooks)" = 1 ]; then ok "T6a el enlace al .githooks/pre-commit corre una sola vez"
  else mal "T6a rc=$RC corrió $(veces "$T" githooks) veces"; fi
else echo "  --   — T6a salteado: esta máquina no crea enlaces simbólicos"; fi
# (b) .git/hooks/pre-commit es una copia del gancho global del arnés
T="$(nuevo)"; cp "$PRE" "$T/repo/.git/hooks/pre-commit"; chmod +x "$T/repo/.git/hooks/pre-commit"
commitear "$T"; RC=$?
if [ "$RC" -eq 0 ] && [ "$(veces "$T" sql)" = 1 ]; then ok "T6b la copia del gancho del arnés no se corre: los controles, una vez"
else mal "T6b rc=$RC controles $(veces "$T" sql) veces"; sed -n '1,6p' "$T/out.txt"; fi
# (c) la carpeta .git/hooks ES la carpeta global
T="$(nuevo)"; rm -rf "$T/repo/.git/hooks"
if ln -s "$T/hooks" "$T/repo/.git/hooks" 2>/dev/null && [ -L "$T/repo/.git/hooks" ]; then
  commitear "$T"; RC=$?
  if [ "$RC" -eq 0 ] && [ "$(veces "$T" sql)" = 1 ]; then ok "T6c .git/hooks apuntando a la carpeta global: sin repetir los controles"
  else mal "T6c rc=$RC controles $(veces "$T" sql) veces"; sed -n '1,6p' "$T/out.txt"; fi
else echo "  --   — T6c salteado: esta máquina no crea enlaces simbólicos"; fi

# ── T7 · sin permiso de ejecución: avisa y no frena ──────────────────────────────────────────────────────────────
T="$(nuevo)"; gancho "$T/repo/.git/hooks/pre-commit" gitdir 1; chmod -x "$T/repo/.git/hooks/pre-commit"
if [ -x "$T/repo/.git/hooks/pre-commit" ]; then echo "  --   — T7 salteado: en esta máquina un guion con #! es ejecutable igual"
else
  A="$(cuantos "$T")"; commitear "$T"; RC=$?
  if [ "$RC" -eq 0 ] && [ "$(cuantos "$T")" = "$((A+1))" ] && grep -q 'NO es ejecutable' "$T/out.txt" && [ "$(veces "$T" gitdir)" = 0 ]; then
    ok "T7 NoEjecutable_AvisaYNoFrena: el commit entra y se avisa que no corrió"
  else mal "T7 rc=$RC commits ${A}→$(cuantos "$T")"; sed -n '1,6p' "$T/out.txt"; fi
fi

# ── T8 · sin lazo: un .git/hooks/pre-commit que llama al gancho global ───────────────────────────────────────────
T="$(nuevo)"
printf '#!/usr/bin/env bash\necho gitdir >> "$LAB_LOG"\nexec "%s" "$@"\n' "$T/hooks/pre-commit" > "$T/repo/.git/hooks/pre-commit"
chmod +x "$T/repo/.git/hooks/pre-commit"
A="$(cuantos "$T")"; commitear "$T"; RC=$?
if [ "$RC" -eq 0 ] && [ "$(cuantos "$T")" = "$((A+1))" ] && [ "$(veces "$T" gitdir)" = 1 ] && [ "$(veces "$T" sql)" = 2 ]; then
  ok "T8 SinLazo_GanchoQueLlamaAlGlobal: termina; el del repo una vez y los controles una vez por cada vuelta del global"
else mal "T8 rc=$RC (124 = colgado) · del repo $(veces "$T" gitdir) · controles $(veces "$T" sql)"; sed -n '1,6p' "$T/out.txt"; fi

# ── T9 · worktree: corre el .git/hooks/pre-commit de la carpeta común ────────────────────────────────────────────
T="$(nuevo)"; gancho "$T/repo/.git/hooks/pre-commit" gitdir 1
g -C "$T/repo" worktree add -q -b otra "$T/wt" main
A="$(cuantos "$T" "$T/wt")"; commitear "$T" "$T/wt"; RC=$?
if [ "$RC" -ne 0 ] && [ "$(cuantos "$T" "$T/wt")" = "$A" ] && [ "$(veces "$T" gitdir)" = 1 ]; then
  ok "T9 Worktree_CorreElDeLaCarpetaComun: desde un worktree enlazado, el del repo rechaza"
else mal "T9 rc=$RC commits ${A}→$(cuantos "$T" "$T/wt")"; sed -n '1,6p' "$T/out.txt"; fi

# ── T10 · la documentación ya no dice que git deja de correr los .git/hooks ──────────────────────────────────────
DOC_MAL=""
for f in getting-started/reference.es.md getting-started/mac.md getting-started/linux.md getting-started/windows.md; do
  grep -q 'deja de correr los .\{0,1\}\.git/hooks' "$RAIZ/$f" && DOC_MAL="$DOC_MAL $f(viejo)"
  grep -q 'pre-commit.\{0,1\}, .\{0,1\}post-commit.\{0,1\} y .\{0,1\}pre-push' "$RAIZ/$f" || DOC_MAL="$DOC_MAL $f(sin los tres)"
done
grep -q 'stops running the `\.git/hooks/`' "$RAIZ/getting-started/reference.md" && DOC_MAL="$DOC_MAL reference.md(viejo)"
grep -q '`pre-commit`, `post-commit` and `pre-push`' "$RAIZ/getting-started/reference.md" || DOC_MAL="$DOC_MAL reference.md(sin los tres)"
if [ -z "$DOC_MAL" ]; then ok "T10 Documentacion_DiceLoNuevo: las cinco páginas nombran los tres ganchos"
else mal "T10 documentación:$DOC_MAL"; fi

# ── T11 · aviso de una sola vez, por repo y por gancho ───────────────────────────────────────────────────────────
T="$(nuevo)"; gancho "$T/repo/.git/hooks/pre-commit" gitdir 0
commitear "$T"; RC1=$?; grep -q 'Para dejarlo como estaba' "$T/out.txt"; P1=$?
commitear "$T"; RC2=$?; grep -q 'Para dejarlo como estaba' "$T/out.txt"; P2=$?
gancho "$T/repo/.git/hooks/post-commit" post 0
commitear "$T"; RC3=$?; grep -q 'Para dejarlo como estaba.*post-commit\|post-commit.*Para dejarlo como estaba' "$T/out.txt"; P3=$?
commitear "$T"; RC4=$?; grep -q 'Para dejarlo como estaba' "$T/out.txt"; P4=$?
if [ "$RC1$RC2$RC3$RC4" = 0000 ] && [ "$P1" = 0 ] && [ "$P2" != 0 ] && [ "$P3" = 0 ] && [ "$P4" != 0 ]; then
  ok "T11 AvisoDeUnaVez_PorRepoYGancho: el primero avisa con la manera de volver atrás; el siguiente, no; un gancho nuevo, una vez"
else mal "T11 rc=$RC1$RC2$RC3$RC4 · avisos 1º=$P1 2º=$P2 post=$P3 post2=$P4 (0 = avisó)"; fi

# ── T12 · el apagado del aviso de post-commit no apaga los ganchos del repo ─────────────────────────────────────
T="$(nuevo)"; gancho "$T/repo/.git/hooks/post-commit" post 0; printf 'suelto\n' > "$T/repo/suelto.txt"
TYCON_POST_COMMIT_NOTICE=0 commitear "$T"; RC=$?
if [ "$RC" -eq 0 ] && [ "$(veces "$T" post)" = 1 ] && ! grep -q 'quedaron afuera' "$T/out.txt"; then
  ok "T12 PostCommit_ApagadoDelAviso_ElDelRepoCorreIgual: calla el aviso y el del repo corre"
else mal "T12 rc=$RC corrió $(veces "$T" post) vez/veces"; sed -n '1,6p' "$T/out.txt"; fi

# ── T13 · la copia del arnés se reconoce por su cabecera: un gancho del repo que sólo nombra el archivo, corre ──────
T="$(nuevo)"
for h in pre-commit post-commit pre-push; do
  printf '#!/usr/bin/env bash\n# reemplaza al que instalaba git-%s-global.sh\necho %s >> "$LAB_LOG"\ncat >/dev/null\nexit 0\n' "$h" "$h" > "$T/repo/.git/hooks/$h"
  chmod +x "$T/repo/.git/hooks/$h"
done
commitear "$T"; RC1=$?
con_cadena "$T" "$T/repo" push -q origin main; RC2=$?
if [ "$RC1$RC2" = 00 ] && [ "$(veces "$T" pre-commit)" = 1 ] && [ "$(veces "$T" post-commit)" = 1 ] && [ "$(veces "$T" pre-push)" = 1 ]; then
  ok "T13 CopiaDelArnes_SoloPorSuCabecera: los tres ganchos que nombran el archivo del arnés en un comentario corren"
else mal "T13 rc=$RC1$RC2 · pre-commit $(veces "$T" pre-commit) · post-commit $(veces "$T" post-commit) · pre-push $(veces "$T" pre-push)"; fi

# ── T14 · el aviso de una vez, con cinco corridas a la vez: sale una sola vez ─────────────────────────────────────
T="$(nuevo)"; gancho "$T/repo/.git/hooks/post-commit" post 0
( export HOME="$T/casa" TYCON_GUIDES_DIR="$T/arnes" LAB_LOG="$T/log" TYCON_POST_COMMIT_NOTICE=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
  cd "$T/repo" && for i in 1 2 3 4 5; do "$T/hooks/post-commit" > "$T/par-$i.txt" 2>&1 & done; wait )
AVISOS="$(cat "$T"/par-*.txt | grep -c 'Para dejarlo como estaba')"
if [ "$AVISOS" = 1 ] && [ "$(veces "$T" post)" = 5 ]; then ok "T14 AvisoDeUnaVez_DosCorridasALaVez: cinco corridas a la vez, un solo aviso"
else mal "T14 avisos=$AVISOS corridas=$(veces "$T" post)"; fi

echo "─────────────"
[ "$FALLOS" -eq 0 ] && { echo "✅ githook-git-dir-chain: todo verde"; exit 0; }
echo "❌ githook-git-dir-chain: $FALLOS caso(s) en rojo"; exit 1
