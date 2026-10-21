#!/usr/bin/env bash
# publish-bump.test.sh — el guion único que publica el bump de los formularios.
# Mismo banco que nightly-publishes-report.test.sh: remoto bare local, un rival que gana la carrera,
# y el árbol sucio que deja un build. Sin red.
#
# 🔴 Mutaciones que ponen un caso en rojo: quitarle `--autostash` al guion pone rojo el
#    caso del árbol sucio; quitarle el chequeo de «ya está en el remoto» pone rojo el caso benigno.
# 🔴 C-05, C-07, C-08 y C-09 cubren el contrato que `forms-to-version.sh` lee para saber desde dónde mirar: el guion
#    anota `Commit: <sha>` y deja la marca aunque no haya cambios. Sin eso, con dos merges agrupados el
#    formulario del primero no se versionaría nunca, en verde. Sin el contrato: C-05 «nada nuevo», exit 0 sin
#    commit; C-07 cuerpo sin `Commit:`; C-08 rc=128.
set -uo pipefail
# 🔴 En Azure la suite hereda BUILD_SOURCEVERSION = el commit del ARNÉS (el repo que el nocturno
# construye), y el guion la lee como «commit de partida» ANTES de mirar HEAD: los repos temporales de
# estos casos no tienen ese commit y el guion se niega (y el nocturno daría rojo). Acá se
# borra para que los casos ejerciten el camino de HEAD, y C-10/C-11 ejercitan la variable a propósito.
unset BUILD_SOURCEVERSION
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
G="$RAIZ/scripts/ci/publish-bump.sh"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
[ -f "$G" ] || { echo "  MAL  — no encontré $G"; exit 1; }

montar() {  # remoto bare + clon "job" con un formulario versionado
  local T="$1"
  git init -q --bare "$T/remoto.git"
  # 🔴 La rama del remoto se fija acá, no se hereda del git de la máquina: el git de macOS trae
  # `init.defaultBranch=main` en su config de sistema y el de Ubuntu arranca en `master`. Con HEAD en
  # una rama que no existe, el clon del rival sale vacío y su push falla: en Azure C-03 daría rojo
  # todas las noches, y C-01/C-02 darían VERDE sin que la carrera ocurriera.
  git -C "$T/remoto.git" symbolic-ref HEAD refs/heads/main
  git clone -q "$T/remoto.git" "$T/semilla" 2>/dev/null
  mkdir -p "$T/semilla/pedidos" "$T/semilla/dist"
  echo '{"name":"pedidos","version":"1.0.1"}' > "$T/semilla/pedidos/package.json"
  echo 'x' > "$T/semilla/rastro.txt"
  git -C "$T/semilla" add -A; git -C "$T/semilla" -c user.email=b@b -c user.name=b commit -q -m base
  git -C "$T/semilla" branch -M main; git -C "$T/semilla" push -q origin main
  git clone -q "$T/remoto.git" "$T/job"; git -C "$T/job" checkout -q main
  git -C "$T/job" config user.email ci@ci; git -C "$T/job" config user.name ci
}
adelantar_remoto() {  # el rival mueve main DESPUÉS del clon del job
  local T="$1" QUE="${2:-otro}" ANTES
  ANTES=$(git -C "$T/remoto.git" rev-parse main)
  git clone -q "$T/remoto.git" "$T/rival"
  if [ "$QUE" = "mismo-bump" ]; then echo '{"name":"pedidos","version":"1.0.2"}' > "$T/rival/pedidos/package.json"; else echo 'del rival' > "$T/rival/otro.txt"; fi
  git -C "$T/rival" add -A; git -C "$T/rival" -c user.email=r@r -c user.name=r commit -q -m rival; git -C "$T/rival" push -q origin main
  rm -rf "$T/rival"
  # Un rival que no pudo mover main deja un caso «con carrera» que no probó ninguna carrera: rojo.
  [ "$(git -C "$T/remoto.git" rev-parse main)" != "$ANTES" ] || mal "montaje: el rival no movió main — el caso no ejercitó la carrera"
}
bump() { mkdir -p "$1/job/dist"; echo '{"name":"pedidos","version":"1.0.2"}' > "$1/job/pedidos/package.json"; }
correr() { ( cd "$1/job" && bash "$G" main "chore: bump [skip ci]" -- '*/package.json' ) > "$1/out.txt" 2>&1; echo $?; }
en_main() { git -C "$1/remoto.git" show main:pedidos/package.json 2>/dev/null; }
cuerpo_en_main() { git -C "$1/remoto.git" log -1 --pretty=%B main 2>/dev/null; }

# 1 · árbol limpio + carrera → publica
T=$(mktemp -d); montar "$T"; bump "$T"; adelantar_remoto "$T"
RC=$(correr "$T"); V=$(en_main "$T")
[ "$RC" = "0" ] && [[ "$V" == *1.0.2* ]] && ok "C-01 árbol limpio + carrera: publica (exit 0, main tiene 1.0.2)" || { mal "C-01 exit $RC, main tiene «${V}»"; head -5 "$T/out.txt"; }
rm -rf "$T"

# 2 · árbol SUCIO (el build dejó dist/ y un trackeado modificado) + carrera → publica igual
T=$(mktemp -d); montar "$T"; bump "$T"; echo 'build' > "$T/job/dist/form.js"; echo 'sucio' > "$T/job/rastro.txt"; adelantar_remoto "$T"
RC=$(correr "$T"); V=$(en_main "$T")
[ "$RC" = "0" ] && [[ "$V" == *1.0.2* ]] && ok "C-02 árbol SUCIO + carrera: publica igual (el caso que mataba a Totora)" || { mal "C-02 exit $RC, main tiene «${V}»"; head -5 "$T/out.txt"; }
rm -rf "$T"

# 3 · un run concurrente YA publicó el mismo bump → OK benigno, sin duplicar
T=$(mktemp -d); montar "$T"; bump "$T"; adelantar_remoto "$T" mismo-bump
RC=$(correr "$T"); N=$(git -C "$T/remoto.git" rev-list --count main)
[ "$RC" = "0" ] && [ "$N" = "2" ] && grep -q "run concurrente" "$T/out.txt" && ok "C-03 el bump ya estaba en el remoto: OK benigno y sin commit duplicado" || { mal "C-03 exit $RC, commits en main=$N"; head -5 "$T/out.txt"; }
rm -rf "$T"

# 4 · imposible publicar → sale 1 Y LO DICE (logissue)
T=$(mktemp -d); montar "$T"; bump "$T"
mkdir -p "$T/ganchos"; printf '#!/bin/sh\necho rechazado >&2\nexit 1\n' > "$T/ganchos/pre-receive"; chmod +x "$T/ganchos/pre-receive"
git -C "$T/remoto.git" config core.hooksPath "$T/ganchos"   # explícito: el core.hooksPath GLOBAL eclipsa hooks/ del bare
echo 'sucio' > "$T/job/rastro.txt"
RC=$(correr "$T")
[ "$RC" != "0" ] && grep -q "task.logissue" "$T/out.txt" && ok "C-04 sin poder publicar: sale $RC y emite el aviso" || { mal "C-04 exit $RC y/o sin aviso"; head -5 "$T/out.txt"; }
rm -rf "$T"

# 5 · nada que commitear → igual deja la MARCA (commit vacío con `Commit: <sha>`), exit 0
# 🔴 El contrato: si no queda marca, la corrida siguiente lee la versión anterior
# de un commit del bot viejo y el host deduplica el bump — el formulario nunca llega, en verde.
T=$(mktemp -d); montar "$T"; BASE=$(git -C "$T/job" rev-parse HEAD)
RC=$(correr "$T"); N=$(git -C "$T/remoto.git" rev-list --count main); B=$(cuerpo_en_main "$T")
if [ "$RC" = "0" ] && [ "$N" = "2" ] && [[ "$B" == *"Commit: $BASE"* ]]; then
  ok "C-05 sin cambios: deja la marca vacía con Commit: <sha de partida> (exit 0)"
else
  mal "C-05 sin cambios: exit $RC, commits en main=$N, cuerpo=«$(echo "$B" | tr '\n' ' ')»"; head -3 "$T/out.txt"
fi
rm -rf "$T"

# 6 · sin paths → error de uso, no un commit de todo
T=$(mktemp -d); montar "$T"; bump "$T"; echo 'basura' > "$T/job/dist/form.js"
RC=$( ( cd "$T/job" && bash "$G" main "msg" ) >/dev/null 2>&1; echo $? )
[ "$RC" = "2" ] && ok "C-06 sin paths se niega (exit 2): nunca un add de todo" || mal "C-06 sin paths dio exit $RC"
rm -rf "$T"

# 7 · con cambios: el cuerpo del commit anota `Commit: <sha del que partió la corrida>`
# (por default el HEAD del checkout —en Azure, Build.SourceVersion—; `--from <sha>` lo fija)
T=$(mktemp -d); montar "$T"; bump "$T"; BASE=$(git -C "$T/job" rev-parse HEAD)
RC=$(correr "$T"); B=$(cuerpo_en_main "$T")
[ "$RC" = "0" ] && [[ "$B" == *"Commit: $BASE"* ]] && ok "C-07 el commit del bump anota de qué commit partió (Commit: <sha>)" || { mal "C-07 exit $RC, cuerpo=«$(echo "$B" | tr '\n' ' ')»"; head -3 "$T/out.txt"; }
rm -rf "$T"
T=$(mktemp -d); montar "$T"; bump "$T"; BASE=$(git -C "$T/job" rev-parse HEAD)
RC=$( ( cd "$T/job" && bash "$G" main "chore: bump [skip ci]" --from "$BASE" -- '*/package.json' ) > "$T/out.txt" 2>&1; echo $? ); B=$(cuerpo_en_main "$T")
[ "$RC" = "0" ] && [[ "$B" == *"Commit: $BASE"* ]] && ok "C-07b --from <sha> explícito queda en el cuerpo" || { mal "C-07b exit $RC, cuerpo=«$(echo "$B" | tr '\n' ' ')»"; head -3 "$T/out.txt"; }
rm -rf "$T"

# 8 · un pathspec que no matchea nada (el `'*/upload/'` de FRESNO con los ZIPs ignorados) NO mata al
# guion: avisa y publica el resto. Sin esto: `fatal: pathspec … did not match`, rc=128, sin commit.
T=$(mktemp -d); montar "$T"; bump "$T"; echo 'upload/' > "$T/job/.gitignore"; mkdir -p "$T/job/pedidos/upload"; echo 'zip' > "$T/job/pedidos/upload/g.zip"
RC=$( ( cd "$T/job" && bash "$G" main "chore: bump [skip ci]" -- '*/package.json' '*/upload/' ) > "$T/out.txt" 2>&1; echo $? ); V=$(en_main "$T")
[ "$RC" = "0" ] && [[ "$V" == *1.0.2* ]] && grep -q "no matchea" "$T/out.txt" && ok "C-08 un pathspec sin match avisa y publica el resto (exit 0)" || { mal "C-08 exit $RC, main tiene «${V}»"; head -5 "$T/out.txt"; }
rm -rf "$T"

# 9 · `--from` con un sha que no existe → se niega (exit 2): una marca falsa es peor que ninguna
T=$(mktemp -d); montar "$T"; bump "$T"
RC=$( ( cd "$T/job" && bash "$G" main "msg" --from 0000000000000000000000000000000000000000 -- '*/package.json' ) >/dev/null 2>&1; echo $? ); N=$(git -C "$T/remoto.git" rev-list --count main)
[ "$RC" = "2" ] && [ "$N" = "1" ] && ok "C-09 --from inexistente: se niega (exit 2) y no publica" || mal "C-09 --from inexistente dio exit $RC, commits en main=$N"
rm -rf "$T"


# 10 · BUILD_SOURCEVERSION (la que pone Azure) apunta a un commit que EXISTE en el job → la marca lo usa
T=$(mktemp -d); montar "$T"; bump "$T"; BASE=$(git -C "$T/job" rev-parse HEAD)
RC=$( ( cd "$T/job" && BUILD_SOURCEVERSION="$BASE" bash "$G" main "chore: bump [skip ci]" -- '*/package.json' ) > "$T/out.txt" 2>&1; echo $? ); B=$(cuerpo_en_main "$T")
[ "$RC" = "0" ] && [[ "$B" == *"Commit: $BASE"* ]] && ok "C-10 BUILD_SOURCEVERSION válida: la marca es ese commit (el camino real del pipeline)" || { mal "C-10 exit $RC, cuerpo=«$(echo "$B" | tr '\n' ' ')»"; head -3 "$T/out.txt"; }
rm -rf "$T"

# 11 · BUILD_SOURCEVERSION de OTRO repo (el síntoma del nocturno) → se niega (exit 2), no publica una marca falsa
T=$(mktemp -d); montar "$T"; bump "$T"
RC=$( ( cd "$T/job" && BUILD_SOURCEVERSION=e3b8cf4514c6fdd92b66f0074fc1304fff45ee1d bash "$G" main "msg" -- '*/package.json' ) > "$T/out.txt" 2>&1; echo $? ); N=$(git -C "$T/remoto.git" rev-list --count main)
[ "$RC" = "2" ] && [ "$N" = "1" ] && grep -q "no existe en este clon" "$T/out.txt" && ok "C-11 BUILD_SOURCEVERSION ajena: se niega (exit 2) y lo dice" || { mal "C-11 exit $RC, commits=$N"; head -3 "$T/out.txt"; }
rm -rf "$T"

echo
if [ "$FALLOS" -gt 0 ]; then echo "FALLARON $FALLOS chequeo(s)"; exit 1; fi
echo "todo verde"; exit 0
