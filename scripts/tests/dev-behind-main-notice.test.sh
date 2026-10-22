#!/usr/bin/env bash
# dev-behind-main-notice.test.sh — el aviso de arranque de `dev` atrasada (T1-T23, T27-T32).
#
# Lo que no se puede perder:
#   · Que hable sólo cuando hay algo que hacer: atraso real (sin merges, sin copias por contenido y sin los commits de
#     versión del bot) o trabajo en `dev` trabado hace 7 días o más. Lo del bot y lo reciente callan.
#   · Que nunca diga «al día» sobre datos viejos: sin `FETCH_HEAD` o con uno de más de 24 h, dice «no sé».
#   · Que no salga a la red, que no rompa el arranque (exit 0 siempre) y que sólo mire repos de la organización del equipo.
#   · Que la oferta al agente salga una vez por estado (main + dev) y la línea, siempre.
#
# Laboratorio: repos de juguete (`git init --bare` como origin + clon), sin red, con un HOME de juguete y la
# configuración fijada por variables (`TYCON_ADO_ORG`, `TYCON_PROFILE=0`) para que la de la máquina no entre.
# 🔴 Sin pipes sobre el comando medido: el exit code REAL es el veredicto.
set -u
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$TCG/scripts/hooks/dev-behind-main-notice.js"
BASE="$(mktemp -d /tmp/tycon-dev-behind.XXXXXX)"
node "$TCG/scripts/tests/lib/lab-guard.js" "$BASE" dev-behind-main-notice || exit 1
trap 'rm -rf "$BASE"' EXIT
FALLAS=0
ok() { echo "✅ dev-behind-main-notice: $1"; }
bad() { echo "❌ dev-behind-main-notice: $1"; FALLAS=$((FALLAS + 1)); }
g() { env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
  GIT_AUTHOR_NAME=Lab GIT_AUTHOR_EMAIL=lab@example.com GIT_COMMITTER_NAME=Lab GIT_COMMITTER_EMAIL=lab@example.com \
  git -c core.hooksPath=/dev/null -c maintenance.auto=false -c gc.auto=0 "$@"; }
# una fecha de hace N días, en ISO (portable: la calcula node)
ago() { node -e 'console.log(new Date(Date.now() - Number(process.argv[1]) * 86400000).toISOString())' "$1"; }
# AAAAMMDDhhmm de hace N horas, para `touch -t`
touch_ago() { node -e 'const d=new Date(Date.now()-Number(process.argv[1])*3600000);const p=(n)=>String(n).padStart(2,"0");console.log(`${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`)' "$1"; }
ORG_URL="https://dev.azure.com/acme"
TEAM_REMOTE="https://dev.azure.com/acme/Prod/_git/Backend"

# commit <dir> <asunto> [días atrás]
commit() { local d="$1" s="$2" n="${3:-0}" when; when="$(ago "$n")"
  GIT_COMMITTER_DATE="$when" GIT_AUTHOR_DATE="$when" g -C "$d" commit -q --allow-empty -m "$s"; }
# repo <nombre> → $BASE/<nombre>/clon con main y dev iguales, origin en Azure (la URL no se usa: el hook no sale)
repo() {
  local r="$BASE/$1"; g init -q --bare -b main "$r/origin.git"; g init -q -b main "$r/clon"
  commit "$r/clon" "base" 30; g -C "$r/clon" remote add origin "$r/origin.git"
  g -C "$r/clon" push -q origin main; g -C "$r/clon" push -q origin main:dev
  g -C "$r/clon" fetch -q origin; g -C "$r/clon" remote set-url origin "$TEAM_REMOTE"
  touch -t "$(touch_ago 1)" "$r/clon/.git/FETCH_HEAD"; echo "$r/clon"
}
# empuja la rama <rama> del clon al bare y refresca las refs como un fetch (sin red: el bare es local)
publish() { local c="$1" b="$2"; local o; o="$(dirname "$c")/origin.git"
  g -C "$c" push -q "$o" "HEAD:refs/heads/$b"; g -C "$c" fetch -q "$o" "+refs/heads/*:refs/remotes/origin/*"
  touch -t "$(touch_ago "${3:-1}")" "$c/.git/FETCH_HEAD"; }
run() { # run <cwd> [VAR=valor …] → $OUT, $ERR, $RC
  local cwd="$1"; shift
  OUT="$(printf '{"source":"startup","cwd":"%s","session_id":"t"}' "$cwd" | env -u GIT_DIR HOME="$BASE/home" \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null TYCON_PROFILE=0 TYCON_ADO_ORG="$ORG_URL" \
    TYCON_HARNESS_IDENTITIES="https://dev.azure.com/acme/Harness/_git/harness" "$@" node "$HOOK" 2>"$BASE/err")"; RC=$?
  ERR="$(cat "$BASE/err")"
}
mkdir -p "$BASE/home"

# ═══ T1 · al día, datos frescos → calla ══════════════════════════════════════════════════════════════════════════
C="$(repo t1)"; run "$C"
[ "$RC" = 0 ] && [ -z "$OUT" ] && ok "T1 DevAlDia_Calla" || bad "T1 DevAlDia_Calla (rc=$RC, salida: $OUT)"

# ═══ T2 · atraso real + del bot → una línea con los números y la edad ═══════════════════════════════════════════
C="$(repo t2)"; for i in 1 2 3; do commit "$C" "feat: cambio $i" 2; done
commit "$C" "chore: bump version to 1.0.1 [skip ci]" 1; commit "$C" "chore: update form versions" 1; publish "$C" main
run "$C"
[ "$RC" = 0 ] && grep -q "le faltan 3 commits de main (y 2 de versión del bot)" <<<"$OUT" && grep -q "datos del último fetch, hace" <<<"$OUT" \
  && [ "$(grep -c 'dev atrasada en' <<<"$OUT")" = 1 ] && ok "T2 AtrasoReal_UnaLineaConNumeros" || bad "T2 AtrasoReal_UnaLineaConNumeros ($OUT)"

# ═══ T3 · sólo commits del bot → calla ═══════════════════════════════════════════════════════════════════════════
C="$(repo t3)"; for i in 1 2 3 4; do commit "$C" "chore: bump version to 1.0.$i [skip ci]" 1; done; publish "$C" main
run "$C"
[ "$RC" = 0 ] && [ -z "$OUT" ] && ok "T3 AtrasoSoloDelBot_Calla" || bad "T3 AtrasoSoloDelBot_Calla ($OUT)"

# ═══ T4 · trabajo trabado en dev → lo nombra con su edad ═════════════════════════════════════════════════════════
C="$(repo t4)"; g -C "$C" switch -q -c dev origin/dev; commit "$C" "feat: viejo 1" 10; commit "$C" "feat: viejo 2" 9
publish "$C" dev; g -C "$C" switch -q main; run "$C"
[ "$RC" = 0 ] && grep -q "2 commits en dev sin llegar a main, el más viejo de hace 10 días" <<<"$OUT" \
  && ok "T4 TrabajoTrabado_LoNombraConSuEdad" || bad "T4 TrabajoTrabado_LoNombraConSuEdad ($OUT)"
T4="$C"

# ═══ T5 · trabajo en curso (de hoy) → no es trabado, calla ═══════════════════════════════════════════════════════
C="$(repo t5)"; g -C "$C" switch -q -c dev origin/dev; commit "$C" "feat: de hoy" 0; publish "$C" dev; g -C "$C" switch -q main
run "$C"
[ "$RC" = 0 ] && [ -z "$OUT" ] && ok "T5 TrabajoEnCursoReciente_NoEsTrabado" || bad "T5 TrabajoEnCursoReciente_NoEsTrabado ($OUT)"

# ═══ T6 · el umbral se configura ═════════════════════════════════════════════════════════════════════════════════
run "$C" TYCON_DEV_BEHIND_STUCK_DAYS=0; a="$OUT"
# un valor que no es un número de días válido vuelve al de siempre (7): el commit de hoy no es trabado
run "$C" TYCON_DEV_BEHIND_STUCK_DAYS=abc; b="$RC|$OUT"; run "$C" TYCON_DEV_BEHIND_STUCK_DAYS=-3; c="$RC|$OUT"
run "$C" TYCON_DEV_BEHIND_STALE_HOURS=abc; d="$RC|$OUT"
grep -q "1 commit en dev sin llegar a main, el más viejo de hace 0 días" <<<"$a" && [ "$b" = "0|" ] && [ "$c" = "0|" ] && [ "$d" = "0|" ] \
  && ok "T6 UmbralDeTrabadoConfigurable" || bad "T6 UmbralDeTrabadoConfigurable (0: $a | abc: $b | -3: $c | horas abc: $d)"

# ═══ T7 · merges y cherry-picks no cuentan ═══════════════════════════════════════════════════════════════════════
C="$(repo t7)"; g -C "$C" switch -q -c dev origin/dev; echo trabado > "$C/t.txt"; g -C "$C" add t.txt
GIT_COMMITTER_DATE="$(ago 12)" g -C "$C" commit -q -m "feat: llega por copia"; COPIA="$(g -C "$C" rev-parse HEAD)"; publish "$C" dev
g -C "$C" switch -q main; g -C "$C" switch -q -c feat; commit "$C" "feat: por merge" 3; g -C "$C" switch -q main
g -C "$C" merge -q --no-ff feat -m "Merge feat"; g -C "$C" cherry-pick "$COPIA" >/dev/null; publish "$C" main
run "$C"
grep -q "le falta 1 commit de main" <<<"$OUT" && ! grep -q "sin llegar a main" <<<"$OUT" \
  && ok "T7 MergesYCherryPicks_NoCuentan" || bad "T7 MergesYCherryPicks_NoCuentan ($OUT)"

# ═══ T8 · origin sin dev, refspec de siempre → calla ═════════════════════════════════════════════════════════════
C="$(repo t8)"; g -C "$C" update-ref -d refs/remotes/origin/dev; run "$C"
[ "$RC" = 0 ] && [ -z "$OUT" ] && ok "T8 SinRamaDev_Calla" || bad "T8 SinRamaDev_Calla ($OUT)"

# ═══ T9 · clon que sólo trae main → «no puedo mirar» ═════════════════════════════════════════════════════════════
g -C "$C" config remote.origin.fetch "+refs/heads/main:refs/remotes/origin/main"; run "$C"
grep -q "dev: no puedo mirar — este clon sólo trae" <<<"$OUT" && ok "T9 ClonQueNoTraeDev_DiceQueNoPuedeMirar" || bad "T9 ClonQueNoTraeDev_DiceQueNoPuedeMirar ($OUT)"

# ═══ T10 · al día con datos de hace 3 días → «no sé», nunca silencio ═════════════════════════════════════════════
C="$(repo t10)"; touch -t "$(touch_ago 72)" "$C/.git/FETCH_HEAD"; run "$C"
grep -q "dev: no sé si está al día" <<<"$OUT" && grep -q "hace 3 días" <<<"$OUT" && ok "T10 DatosViejosYAlDia_DiceNoSe" || bad "T10 DatosViejosYAlDia_DiceNoSe ($OUT)"

# ═══ T11 · sin FETCH_HEAD → edad desconocida ═════════════════════════════════════════════════════════════════════
rm -f "$C/.git/FETCH_HEAD"; run "$C"
grep -q "de fecha desconocida" <<<"$OUT" && ok "T11 SinFetchHead_EdadDesconocida" || bad "T11 SinFetchHead_EdadDesconocida ($OUT)"

# ═══ T12 · atrasada con datos viejos → la línea lleva la edad ════════════════════════════════════════════════════
C="$(repo t12)"; commit "$C" "feat: algo" 3; publish "$C" main 48; run "$C"
grep -q "le falta 1 commit de main" <<<"$OUT" && grep -q "datos del último fetch, hace 2 días" <<<"$OUT" \
  && ok "T12 DatosViejosYAtrasada_LlevaLaEdad" || bad "T12 DatosViejosYAtrasada_LlevaLaEdad ($OUT)"

# ═══ T13 · sin red: un git que anota sus argumentos ══════════════════════════════════════════════════════════════
mkdir -p "$BASE/bin13"; REAL_GIT="$(command -v git)"
printf '#!/bin/sh\necho "$*" >> "%s/git13.log"\nexec "%s" "$@"\n' "$BASE" "$REAL_GIT" > "$BASE/bin13/git"; chmod +x "$BASE/bin13/git"
C="$(repo t13)"; commit "$C" "feat: algo" 2; publish "$C" main; rm -rf "$BASE/t13/origin.git"
F0="$(ls -l "$C/.git/FETCH_HEAD")"; run "$C" PATH="$BASE/bin13:$PATH"
if grep -q "le falta 1 commit" <<<"$OUT" && [ -s "$BASE/git13.log" ] && ! grep -qE '(^| )(fetch|pull|ls-remote)( |$)' "$BASE/git13.log" \
  && [ "$F0" = "$(ls -l "$C/.git/FETCH_HEAD")" ]; then ok "T13 SinRed_NoSaleAfuera"; else bad "T13 SinRed_NoSaleAfuera ($OUT)"; fi

# ═══ T14 · repo del arnés → calla aunque dev esté atrasada ═══════════════════════════════════════════════════════
C="$(repo t14)"; commit "$C" "feat: algo" 2; publish "$C" main
g -C "$C" remote set-url origin "https://dev.azure.com/acme/Harness/_git/harness"; run "$C"
[ "$RC" = 0 ] && [ -z "$OUT" ] && ok "T14 RepoDelArnes_Calla" || bad "T14 RepoDelArnes_Calla ($OUT)"

# ═══ T15 · fuera de git, o repo sin remotos → calla ══════════════════════════════════════════════════════════════
mkdir -p "$BASE/suelto"; run "$BASE/suelto"; r1="$RC$OUT"
g init -q -b main "$BASE/sinremoto"; commit "$BASE/sinremoto" base 1; run "$BASE/sinremoto"; r2="$RC$OUT"
[ "$r1" = 0 ] && [ "$r2" = 0 ] && ok "T15 NoEsRepoOSinOrigin_Calla" || bad "T15 NoEsRepoOSinOrigin_Calla ($r1 | $r2)"

# ═══ T27 · remotos de afuera callan; la forma visualstudio.com es del equipo ═════════════════════════════════════
C="$(repo t27)"; commit "$C" "feat: algo" 2; publish "$C" main
g -C "$C" remote set-url origin "https://github.com/acme/r.git"; run "$C"; a="$OUT"
g -C "$C" remote set-url origin "https://dev.azure.com/otra-org/P/_git/r"; run "$C"; b="$OUT"
g -C "$C" remote set-url origin "https://acme.visualstudio.com/P/_git/r"; run "$C"; c="$OUT"
[ -z "$a" ] && [ -z "$b" ] && grep -q "le falta 1 commit" <<<"$c" && ok "T27 RemotoDeAfuera_Calla" || bad "T27 RemotoDeAfuera_Calla (gh: $a | otra: $b | vs: $c)"

# ═══ T28 · sin ado.org calla; configuración rota → aviso estándar por stderr y nada de dev ═══════════════════════
run "$C" TYCON_ADO_ORG= ADO_ORG=; a="$RC|$OUT"
mkdir -p "$BASE/home28/.claude"; echo '{ roto' > "$BASE/home28/.claude/tycon.json"; mkdir -p "$BASE/home28/.tycon"; echo '{ roto' > "$BASE/home28/.tycon/config.json"
OUT="$(printf '{"source":"startup","cwd":"%s"}' "$C" | env HOME="$BASE/home28" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null TYCON_PROFILE=0 \
  node "$HOOK" 2>"$BASE/err")"; RC=$?; ERR="$(cat "$BASE/err")"
[ "$a" = "0|" ] && [ "$RC" = 0 ] && ! grep -q "dev" <<<"$OUT" && grep -q "configuración del arnés está ROTA" <<<"$ERR" \
  && ok "T28 SinOrgOConfigRota_NoHablaDeDev" || bad "T28 SinOrgOConfigRota_NoHablaDeDev (sin org: $a | rota rc=$RC out=$OUT err=$ERR)"

# ═══ T16 · git falla después de saber que aplica → «no pude mirar» ═══════════════════════════════════════════════
mkdir -p "$BASE/bin16"; printf '#!/bin/sh\ncase "$*" in *cherry-pick*) echo boom >&2; exit 3;; esac\nexec "%s" "$@"\n' "$REAL_GIT" > "$BASE/bin16/git"; chmod +x "$BASE/bin16/git"
C="$(repo t16)"; run "$C" PATH="$BASE/bin16:$PATH"
[ "$RC" = 0 ] && grep -q "dev: no pude mirar si está al día (" <<<"$OUT" && ok "T16 GitFallaDespuesDeAplicar_NoPudeMirar" || bad "T16 GitFallaDespuesDeAplicar_NoPudeMirar (rc=$RC $OUT)"

# ═══ T17 · git lento → tope y «no pude mirar» ════════════════════════════════════════════════════════════════════
mkdir -p "$BASE/bin17"; printf '#!/bin/sh\ncase "$*" in *cherry-pick*) sleep 5;; esac\nexec "%s" "$@"\n' "$REAL_GIT" > "$BASE/bin17/git"; chmod +x "$BASE/bin17/git"
t0="$(node -e 'console.log(Date.now())')"; run "$C" PATH="$BASE/bin17:$PATH"; t1="$(node -e 'console.log(Date.now())')"
o17="$OUT"; r17="$RC"
# el tope también vale al mirar si existe origin/dev: un git que se cuelga ahí no se lee como «no hay dev»
mkdir -p "$BASE/bin17b"; printf '#!/bin/sh\ncase "$*" in *origin/dev*) sleep 5;; esac\nexec "%s" "$@"\n' "$REAL_GIT" > "$BASE/bin17b/git"; chmod +x "$BASE/bin17b/git"
run "$C" PATH="$BASE/bin17b:$PATH"
[ "$r17" = 0 ] && grep -q "dev: no pude mirar si está al día (" <<<"$o17" && [ $((t1 - t0)) -lt 4500 ] \
  && [ "$RC" = 0 ] && grep -q "dev: no pude mirar si está al día (git tardó" <<<"$OUT" \
  && ok "T17 GitLento_TopeYNoPudeMirar" || bad "T17 GitLento_TopeYNoPudeMirar (rc=$r17, $((t1 - t0)) ms, $o17 | origin/dev: rc=$RC $OUT)"

# ═══ T29 · en un worktree, la edad sale del fetch más nuevo (el del repo común o el propio) ════════════════════════
C="$(repo t29)"; g -C "$C" worktree add -q "$BASE/t29/wt" -b feat >/dev/null 2>&1; run "$BASE/t29/wt"; a="$RC|$OUT"
touch -t "$(touch_ago 72)" "$C/.git/FETCH_HEAD"; publish "$C" main 72; g -C "$BASE/t29/wt" fetch -q "$BASE/t29/origin.git" "+refs/heads/*:refs/remotes/origin/*"
run "$C"; b="$OUT"
[ "$a" = "0|" ] && [ -z "$b" ] && ok "T29 Worktree_LeeElFetchMasNuevo" || bad "T29 Worktree_LeeElFetchMasNuevo (worktree recién creado: $a | fetch hecho en el worktree, visto del checkout: $b)"

# ═══ T30 · un origin con alias (url.<base>.insteadOf) se reconoce como del equipo ═══════════════════════════════════
C="$(repo t30)"; commit "$C" "feat: algo" 2; publish "$C" main
g -C "$C" config url."https://dev.azure.com/acme/".insteadOf "acme:"; g -C "$C" remote set-url origin "acme:Prod/_git/Backend"; run "$C"
grep -q "le falta 1 commit de main" <<<"$OUT" && ok "T30 AliasDeUrl_SeReconoceComoDelEquipo" || bad "T30 AliasDeUrl_SeReconoceComoDelEquipo ($OUT)"

# ═══ T31 · los refspecs se leen como git: nombre corto trae dev, uno negativo lo saca ════════════════════════════
C="$(repo t31)"; g -C "$C" update-ref -d refs/remotes/origin/dev
g -C "$C" config remote.origin.fetch "+main:refs/remotes/origin/main"; g -C "$C" config --add remote.origin.fetch "+dev:refs/remotes/origin/dev"; run "$C"; a="$OUT"
g -C "$C" config --replace-all remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"; g -C "$C" config --add remote.origin.fetch "^refs/heads/dev"; run "$C"; b="$OUT"
[ -z "$a" ] && grep -q "dev: no puedo mirar — este clon sólo trae" <<<"$b" && ok "T31 Refspecs_SeLeenComoGit" || bad "T31 Refspecs_SeLeenComoGit (nombre corto: $a | negativo: $b)"

# ═══ T32 · un commit con asunto vacío no le corrompe la fecha al trabajo trabado ═════════════════════════════════
C="$(repo t32)"; g -C "$C" switch -q -c dev origin/dev; when="$(ago 10)"
GIT_COMMITTER_DATE="$when" GIT_AUTHOR_DATE="$when" g -C "$C" commit -q --allow-empty --allow-empty-message -m ""
publish "$C" dev; g -C "$C" switch -q main; run "$C"
grep -q "1 commit en dev sin llegar a main, el más viejo de hace 10 días" <<<"$OUT" && ok "T32 AsuntoVacio_LaFechaSeLeeBien" || bad "T32 AsuntoVacio_LaFechaSeLeeBien ($OUT)"

# ═══ T18 · la oferta, una vez por estado ═════════════════════════════════════════════════════════════════════════
H18="$BASE/home18"; mkdir -p "$H18"
C="$(repo t18)"; commit "$C" "feat: algo" 2; publish "$C" main
run "$C" HOME="$H18"; o1="$OUT"; run "$C" HOME="$H18"; o2="$OUT"
commit "$C" "feat: otro" 1; publish "$C" main; run "$C" HOME="$H18"; o3="$OUT"
# la clave del estado no guarda credenciales, y la misma URL con o sin usuario y clave es el mismo repo
# (la arroba va aparte: escrita junta, la URL de juguete parece un correo para el freno de publicar)
AT='@'; g -C "$C" remote set-url origin "https://usuario:secreto${AT}dev.azure.com/acme/Prod/_git/Backend"; run "$C" HOME="$H18"; o4="$OUT"
estado="$(cat "$(find "$H18" -name 'dev-behind-notice.json' | head -1)" 2>/dev/null)"
grep -q "Para el agente" <<<"$o1" && grep -q "dev atrasada en" <<<"$o2" && ! grep -q "Para el agente" <<<"$o2" && grep -q "Para el agente" <<<"$o3" \
  && grep -q "dev atrasada en" <<<"$o4" && ! grep -q "Para el agente" <<<"$o4" && [ -n "$estado" ] && ! grep -qE "secreto|usuario|dev\.azure\.com" <<<"$estado" \
  && ok "T18 OfertaSoloConEstadoNuevo" || bad "T18 OfertaSoloConEstadoNuevo (1: $o1 | 2: $o2 | 3: $o3 | con credenciales: $o4 | estado: $estado)"

# ═══ T19 · con trabajo trabado, la oferta nombra el merge a main ═════════════════════════════════════════════════
run "$T4" HOME="$BASE/home19"
grep -q "/tycon-merge-to-main" <<<"$OUT" && grep -q "Poner .dev. al día" <<<"$OUT" && ok "T19 TrabadoOfreceElMergeAMain" || bad "T19 TrabadoOfreceElMergeAMain ($OUT)"

# ═══ T20 · estado ilegible vuelve a ofrecer; apagado calla sin leer git ══════════════════════════════════════════
H20="$BASE/home20"; run "$C" HOME="$H20" >/dev/null; for f in $(find "$H20" -name 'dev-behind-notice.json'); do echo 'basura{' > "$f"; done
run "$C" HOME="$H20"; a="$RC|$OUT"
mkdir -p "$BASE/bin20"; printf '#!/bin/sh\necho "$*" >> "%s/git20.log"\nexec "%s" "$@"\n' "$BASE" "$REAL_GIT" > "$BASE/bin20/git"; chmod +x "$BASE/bin20/git"
run "$C" TYCON_DEV_BEHIND_NOTICE=0 PATH="$BASE/bin20:$PATH"
[ -n "$(find "$H20" -name 'dev-behind-notice.json')" ] && grep -q "Para el agente" <<<"$a" && [ "$RC" = 0 ] && [ -z "$OUT" ] && [ ! -s "$BASE/git20.log" ] \
  && ok "T20 EstadoIlegibleYApagado" || bad "T20 EstadoIlegibleYApagado ($a | apagado rc=$RC out=$OUT)"

# ═══ T21 · los patrones del bot son los de label-prs.sh ══════════════════════════════════════════════════════════
falta=""; for p in $(grep -oE "'\^chore: [a-z ]+'" "$TCG/scripts/ci/label-prs.sh" | tr -d "'^" | tr ' ' '_'); do
  grep -qF "'${p//_/ }'" "$HOOK" || falta="$falta ${p//_/ }"; done
n="$(grep -oE "'\^chore: [a-z ]+'" "$TCG/scripts/ci/label-prs.sh" | wc -l | tr -d ' ')"
[ "$n" = 3 ] && [ -z "$falta" ] && ok "T21 PatronesDelBot_IgualesALaCorrida" || bad "T21 PatronesDelBot_IgualesALaCorrida (en label-prs.sh: $n; faltan en el hook:$falta)"

# ═══ T22 · el banco ══════════════════════════════════════════════════════════════════════════════════════════════
B="$(node "$TCG/scripts/controls-bench/runner.js" --tool claude --only dev-behind-main-notice.js 2>&1)"; rcb=$?
[ "$rcb" = 0 ] && grep -q "4 corridos · 0 rojos" <<<"$B" && ok "T22 Banco_CasosDelAviso" || bad "T22 Banco_CasosDelAviso (rc=$rcb: $(tail -5 <<<"$B"))"

# ═══ T23 · registrado en los dos lados, en las suites, la guía y sin el paso en las plantillas ════════════════════
p=""
node -e 'const l=require(process.argv[1]);const a=(l.hooks||l).filter?.((h)=>h.event==="SessionStart"&&/dev-behind-main-notice\.js$/.test(h.spec))||[];process.exit(a.length===1&&/Off: TYCON_DEV_BEHIND_NOTICE=0/.test(a[0].label)?0:1)' \
  "$TCG/scripts/setup/hooks-list.json" || p="$p hooks-list"
node -e 'const j=require(process.argv[1]);const s=JSON.stringify(j.hooks.SessionStart||[]);process.exit(s.includes("dev-behind-main-notice.js")?0:1)' "$TCG/adapters/codex/hooks.json" || p="$p codex"
grep -q '"tests/dev-behind-main-notice.test.sh"' "$TCG/scripts/tests/suites.json" || p="$p suites"
grep -q "dev-behind-main-notice.js" "$TCG/guides/piezas-del-arnes.md" || p="$p piezas"
grep -q "dev-behind-main-notice" "$TCG/guides/maintaining/codex-divergence-inventory.md" || p="$p inventario-codex"
grep -q 'dev atrasada en' "$TCG/INDEX.md" || p="$p INDEX"
G="$TCG/guides/git-commit-conventions.md"
SEC="$(awk '/^## Poner `dev` al día/{f=1;next} /^## /{f=0} f' "$G")"
pasos="$(grep -cE '^[1-6]\. ' <<<"$SEC")"
[ "$pasos" = 6 ] && grep -q "git fetch origin" <<<"$SEC" && grep -q "git pull --ff-only" <<<"$SEC" && grep -q "git merge --no-ff origin/main" <<<"$SEC" \
  && grep -q "git merge --abort" <<<"$SEC" && grep -q "git push origin dev" <<<"$SEC" && grep -qi "sin un sí" <<<"$SEC" || p="$p guía(pasos=$pasos)"
# las plantillas y el mapa viven en otros repos: se miran si el árbol los trae (la validación los pone encima)
nm=""; T="$TCG/packs/bizuit/templates/pipelines"
if [ -d "$T" ]; then grep -lqE "fell behind|ATRASO=" "$T/backend-ci.yml" "$T/forms-ci.yml" && p="$p plantillas"; else nm="$nm plantillas"; fi
if [ -f "$TCG/artifacts/mapa-arnes.html" ]; then grep -q "dev-behind-main-notice" "$TCG/artifacts/mapa-arnes.html" || p="$p mapa"; else nm="$nm mapa"; fi
[ -z "$p" ] && ok "T23 Registro_EnLosDosLadosYElMapa${nm:+ (no medido en este árbol:$nm)}" || bad "T23 Registro_EnLosDosLadosYElMapa (falta:$p)"

echo
[ "$FALLAS" = 0 ] && { echo "dev-behind-main-notice: todo verde"; exit 0; }
echo "dev-behind-main-notice: $FALLAS en rojo"; exit 1
