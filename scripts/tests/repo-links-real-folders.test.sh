#!/usr/bin/env bash
# repo-links-real-folders.test.sh — ~/.claude/skills y ~/.claude/agents siempre carpetas REALES.
#
# Si `~/.claude/skills` fuera un enlace a la carpeta ENTERA del árbol del arnés, lo que Claude Code sincroniza ahí
# (`skills/synced`, cada ~10 min) y lo que el dev crea (una skill o un agente propio) caería adentro del arnés, y la
# actualización lo perdería. Por eso son carpetas del dev con un enlace por cada skill y agente del arnés, y una máquina
# con un enlace entero se convierte sola la próxima vez que corre el aplicador, moviendo lo propio a la carpeta real.
#
# Lo que no se puede perder:
#   T2  · FreshInstall_RealFolders — sin las carpetas, quedan reales con un enlace por entrada (del arnés y de terceros).
#   T3  · Convert_WholeLink_KeepsOwnAndSynced — el enlace entero se convierte: lo propio, synced/ y .trash/ quedan en la
#         carpeta real, enteros; las del arnés, enlazadas; el árbol ya no tiene nada ajeno; una línea lo dice. En un
#         clon, «del arnés» es lo que git rastrea.
#   T4  · Convert_NeverDeletesThroughLink — lo del arnés al que el enlace llevaba queda intacto.
#   T5  · Convert_ResumesCutAndRecreatedSynced — la temporal de un corte se retoma; si Claude recreó la carpeta, se junta.
#   T6  · Convert_HeldOwn_RetriesNoBlock — algo propio que no se puede mover: sale 0, lo dice, el enlace queda, se
#         reintenta y la corrida siguiente convierte.
#   T7  · Clash_OwnWins — una entrada propia con el nombre de una del arnés queda y se nombra.
#   T8  · OtherCloneLink_NotConverted — un enlace entero a OTRO clon del arnés no se toca.
#   T9  · Update_KeepsOwnAndSynced — después de convertir, una versión nueva (con la forma de un enlace por skill): lo
#         propio y synced/ siguen, la skill nueva queda enlazada, los enlaces llevan a la versión nueva.
#   T10 · Uninstall_KeepsRealFolders — uninstall quita los enlaces del arnés y deja las carpetas con lo propio.
#   T11 · Doctor_OldForm_SaysConversion · Migrate_BornReal — doctor dice la forma vieja; la mudanza deja carpetas reales.
#   T16 · Convert_SameName_SaysWhy — un nombre repetido en la temporal: con el mismo contenido se junta; con otro, la
#         conversión sigue, una versión queda en <carpeta>.tycon-aparte y la línea lo dice una vez (sin culpar a un programa).
#   T17 · Convert_HeldAtMerge_NotClaimedDone — algo tomado al juntar o al devolver: la línea no dice «pasó», nada se
#         pierde, la corrida siguiente termina.
#   T18 · Convert_TmpBesideOwnLink_Untouched — una temporal al lado de un enlace propio del dev: no se toca ninguno.
#   T19 · Convert_UnknownCheckCrossDisk — sin manifiesto ni git no se mueve nada; --check no escribe; terceros (las dos
#         formas del manifiesto) y la capa del equipo son del arnés; en otro disco se copia y se borra.
#   T20 · TwoClonesTransition_Untouched — la máquina con el clon viejo de agent-skills aparte no se convierte.
#
# Laboratorio: un árbol de juguete y una HOME de juguete bajo mktemp; para T10 y T11 el de scripts/tests/lib/harness-lab.sh.
# Nunca ~/.claude ni el checkout real. 🔴 Sin pipes sobre lo medido. «Tomado» se simula con una envoltura de
# fs.renameSync (NODE_OPTIONS) que falla con EPERM sobre lo que nombra TYCON_TEST_HELD.
# @story-8.35
# Uso: bash scripts/tests/repo-links-real-folders.test.sh [--only T2|T3|…]
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
BASE="$(mktemp -d)"
# (los nombres del lugar salen de su definición: no se escriben a mano)
LEGACY_NAME="$(node -p "require('$RAIZ/scripts/setup/harness/tycon-home.js').LEGACY_PLACE_NAME")"
case "$BASE" in *"$LEGACY_NAME"*|*agent-skills*|*/.claude*) echo "❌ repo-links-real-folders: el laboratorio cayó en ${BASE}"; exit 1 ;; esac
trap 'rm -rf "$BASE"; kill $(jobs -p) 2>/dev/null' EXIT
CP="$RAIZ/scripts/lib/canonical-path.js"
HELD_JS="$BASE/held-rename.js"
cat > "$HELD_JS" <<'JS'
// held-rename.js (repo-links-real-folders.test.sh): simula en posix algo TOMADO de Windows
const fs = require('fs'), path = require('path');
const list = (v) => (process.env[v] || '').split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
const held = list('TYCON_TEST_HELD'), far = list('TYCON_TEST_OTHER_DISK');
const under = (f, l) => l.some((h) => f === h || f.startsWith(h + path.sep));
const orig = fs.renameSync;
fs.renameSync = function renameSync(from, to) {
  const f = path.resolve(String(from));
  if (under(f, held)) { const e = new Error(`EPERM: operation not permitted, rename '${from}'`); e.code = 'EPERM'; throw e; }
  // TYCON_TEST_OTHER_DISK: el origen está en «otro disco» (el renombre no puede: hay que copiar y borrar)
  if (under(f, far)) { const e = new Error(`EXDEV: cross-device link not permitted, rename '${from}'`); e.code = 'EXDEV'; throw e; }
  return orig.apply(this, arguments);
};
JS
# el árbol de juguete: dos skills y dos revisores del arnés, una skill de terceros; `release` trae el manifiesto de una
# versión bajada, `git` es un clon (lo de terceros, ignorado por git como en el arnés)
arbol() { # arbol <dir> release|git
  local t="$1"
  mkdir -p "$t/scripts/publishing" "$t/skills/tycon-pipeline" "$t/skills/otra" "$t/skills/tercera" "$t/agents"
  printf '#!/bin/sh\n' > "$t/scripts/install-tycon-hooks.sh"
  printf 'pipeline\n' > "$t/skills/tycon-pipeline/SKILL.md"
  printf 'otra\n' > "$t/skills/otra/SKILL.md"
  printf 'tercera\n' > "$t/skills/tercera/SKILL.md"
  printf 'a\n' > "$t/agents/rev-a.md"; printf 'b\n' > "$t/agents/rev-b.md"
  printf '{ "third_party": [ { "target": "skills/tercera" } ] }\n' > "$t/scripts/publishing/third-party-skills.json"
  if [ "$2" = release ]; then
    printf '{ "version": "2026.10.07.1", "commit": "x", "tree": "y", "files": [ {"path":"scripts/install-tycon-hooks.sh"}, {"path":"skills/tycon-pipeline/SKILL.md"}, {"path":"skills/otra/SKILL.md"}, {"path":"agents/rev-a.md"}, {"path":"agents/rev-b.md"}, {"path":"scripts/publishing/third-party-skills.json"} ] }\n' > "$t/.tycon-release.json"
  else
    printf 'skills/tercera/\nskills/synced/\n' > "$t/.gitignore"
    git -C "$t" init -q -b main && git -C "$t" add -A && git -C "$t" -c user.name=lab -c user.email=lab@example.com commit -q -m arbol
  fi
}
enlaza() { # enlaza <tree> <home> [más variables]: corre la pieza que usa el aplicador
  node "$CP" --ensure-repo-links --clone "$1" --only entries --home "$2"
}
es_carpeta() { [ -d "$1" ] && [ ! -L "$1" ]; }
destino() { [ -L "$1" ] && readlink "$1"; }
# ¿`$1` es un enlace que lleva a `$2`? Por la ruta real (en Mac /var es /private/var)
lleva() { [ -L "$1" ] && [ "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1")" = "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$2")" ]; }
siembra_vieja() { # siembra_vieja <tree> <home>: la forma vieja con lo propio adentro del árbol
  local t="$1" h="$2"
  mkdir -p "$h/.claude"
  ln -s "$t/skills" "$h/.claude/skills"; ln -s "$t/agents" "$h/.claude/agents"
  mkdir -p "$t/skills/mia" "$t/skills/synced/org_cuenta/de-la-cuenta" "$t/skills/.trash/vieja"
  printf 'mia\n' > "$t/skills/mia/SKILL.md"
  printf 'cuenta\n' > "$t/skills/synced/org_cuenta/de-la-cuenta/SKILL.md"
  printf 'basura\n' > "$t/skills/.trash/vieja/x"
  printf 'mio\n' > "$t/agents/mio.md"
}

# ───────────────────────────────────────────── T2 ─────────────────────────────────────────────
if corre T2; then
  echo "T2 · FreshInstall_RealFolders — sin las carpetas, quedan reales con un enlace por entrada"
  T="$BASE/t2/arbol"; H="$BASE/t2/home"; arbol "$T" release; mkdir -p "$H/.claude"
  out="$(enlaza "$T" "$H" 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "sale 0" || mal "salió $rc: $out"
  es_carpeta "$H/.claude/skills" && es_carpeta "$H/.claude/agents" && ok "skills y agents son carpetas reales" || mal "no son carpetas reales: $(ls -la "$H/.claude" | tr '\n' ' ')"
  for e in skills/tycon-pipeline skills/otra skills/tercera agents/rev-a.md agents/rev-b.md; do
    lleva "$H/.claude/$e" "$T/$e" && ok "$e enlazada al arnés" || mal "$e: $(ls -la "$H/.claude/$e" 2>&1)"
  done
fi

# ───────────────────────────────────────────── T3 / T4 ────────────────────────────────────────
if corre T3; then
  echo "T3 · Convert_WholeLink_KeepsOwnAndSynced · T4 Convert_NeverDeletesThroughLink — la forma vieja se convierte sin perder nada"
  for modo in release git; do
    T="$BASE/t3-$modo/arbol"; H="$BASE/t3-$modo/home"; arbol "$T" "$modo"; siembra_vieja "$T" "$H"
    out="$(enlaza "$T" "$H" 2>&1)"; rc=$?
    [ "$rc" = 0 ] && ok "$modo · sale 0" || mal "$modo · salió $rc: $out"
    es_carpeta "$H/.claude/skills" && es_carpeta "$H/.claude/agents" && ok "$modo · skills y agents pasaron a carpetas reales" || mal "$modo · no se convirtieron: $(ls -la "$H/.claude" | tr '\n' ' ') — $out"
    [ "$(cat "$H/.claude/skills/mia/SKILL.md" 2>/dev/null)" = mia ] && es_carpeta "$H/.claude/skills/mia" && ok "$modo · la skill propia quedó entera en la carpeta real" || mal "$modo · la skill propia no está: $(ls -la "$H/.claude/skills" 2>&1 | tr '\n' ' ')"
    [ "$(cat "$H/.claude/skills/synced/org_cuenta/de-la-cuenta/SKILL.md" 2>/dev/null)" = cuenta ] && ok "$modo · synced/ (las de la cuenta) quedó en la carpeta real" || mal "$modo · synced/ no está"
    [ -f "$H/.claude/skills/.trash/vieja/x" ] && ok "$modo · .trash/ quedó" || mal "$modo · .trash/ no está"
    [ "$(cat "$H/.claude/agents/mio.md" 2>/dev/null)" = mio ] && [ ! -L "$H/.claude/agents/mio.md" ] && ok "$modo · el agente propio quedó como archivo real" || mal "$modo · el agente propio no está"
    lleva "$H/.claude/skills/tycon-pipeline" "$T/skills/tycon-pipeline" && lleva "$H/.claude/agents/rev-a.md" "$T/agents/rev-a.md" && ok "$modo · las del arnés, enlazadas" || mal "$modo · las del arnés no quedaron enlazadas"
    [ ! -e "$T/skills/mia" ] && [ ! -e "$T/skills/synced" ] && [ ! -e "$T/skills/.trash" ] && [ ! -e "$T/agents/mio.md" ] && ok "$modo · el árbol del arnés ya no tiene nada ajeno" || mal "$modo · quedó algo ajeno en el árbol: $(ls -a "$T/skills" "$T/agents" | tr '\n' ' ')"
    [ -f "$T/skills/tycon-pipeline/SKILL.md" ] && [ -f "$T/skills/tercera/SKILL.md" ] && [ -f "$T/agents/rev-b.md" ] && ok "$modo · T4: lo del arnés al que llevaba el enlace quedó intacto" || mal "$modo · T4: se borró algo del arnés a través del enlace"
    case "$out" in *"carpeta tuya"*) ok "$modo · una línea lo dice" ;; *) mal "$modo · no lo dice: $out" ;; esac
    ls -d "$H/.claude/"*.tycon-new-* >/dev/null 2>&1 && mal "$modo · quedó una temporal" || ok "$modo · no quedan temporales"
    out2="$(enlaza "$T" "$H" 2>&1)"
    [ -z "$out2" ] && ok "$modo · una segunda ejecución no hace ni dice nada" || mal "$modo · la segunda ejecución dijo: $out2"
  done
fi

# ───────────────────────────────────────────── T5 ─────────────────────────────────────────────
if corre T5; then
  echo "T5 · Convert_ResumesCutAndRecreatedSynced — la temporal de un corte se retoma; la carpeta recreada se junta"
  T="$BASE/t5/arbol"; H="$BASE/t5/home"; arbol "$T" release; siembra_vieja "$T" "$H"
  # el corte: la skill propia ya se movió a la temporal y el enlace entero sigue
  TMPD="$H/.claude/skills.tycon-new-999"; mkdir -p "$TMPD"; mv "$T/skills/mia" "$TMPD/mia"
  enlaza "$T" "$H" >/dev/null 2>&1
  es_carpeta "$H/.claude/skills" && [ -f "$H/.claude/skills/mia/SKILL.md" ] && [ -d "$H/.claude/skills/synced" ] && ok "se retomó: la carpeta real tiene lo de la temporal y lo que faltaba mover" || mal "no se retomó: $(ls -la "$H/.claude/skills" 2>&1 | tr '\n' ' ')"
  [ ! -e "$TMPD" ] && ok "la temporal se sacó" || mal "quedó la temporal"
  # Claude recreó ~/.claude/skills (con synced/) entre quitar el enlace y renombrar: queda la temporal al lado
  T="$BASE/t5b/arbol"; H="$BASE/t5b/home"; arbol "$T" release; mkdir -p "$H/.claude/skills/synced/org_cuenta/nueva" "$H/.claude/skills.tycon-new-998/mia"
  printf 'nueva\n' > "$H/.claude/skills/synced/org_cuenta/nueva/SKILL.md"; printf 'mia\n' > "$H/.claude/skills.tycon-new-998/mia/SKILL.md"
  enlaza "$T" "$H" >/dev/null 2>&1
  [ -f "$H/.claude/skills/synced/org_cuenta/nueva/SKILL.md" ] && [ -f "$H/.claude/skills/mia/SKILL.md" ] && ok "la carpeta recreada se conservó y se completó con lo de la temporal" || mal "la recreada: $(ls -la "$H/.claude/skills" 2>&1 | tr '\n' ' ')"
  [ ! -e "$H/.claude/skills.tycon-new-998" ] && ok "y la temporal se sacó" || mal "quedó la temporal"
  lleva "$H/.claude/skills/otra" "$T/skills/otra" && ok "y las del arnés quedaron enlazadas" || mal "faltan los enlaces del arnés"
fi

# ───────────────────────────────────────────── T6 ─────────────────────────────────────────────
if corre T6; then
  echo "T6 · Convert_HeldOwn_RetriesNoBlock — algo propio tomado: no frena, lo dice, se reintenta"
  T="$BASE/t6/arbol"; H="$BASE/t6/home"; arbol "$T" release; siembra_vieja "$T" "$H"
  # (la envoltura compara rutas tal cual: se nombra por la ruta real, como la ve la pieza)
  out="$(NODE_OPTIONS="--require $HELD_JS" TYCON_TEST_HELD="$(cd "$T" && pwd -P)/skills/mia" enlaza "$T" "$H" 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "sale 0" || mal "salió $rc"
  [ -L "$H/.claude/skills" ] && [ "$(destino "$H/.claude/skills")" = "$T/skills" ] && ok "el enlace entero quedó como estaba" || mal "el enlace cambió: $(ls -la "$H/.claude" | tr '\n' ' ')"
  [ -f "$T/skills/mia/SKILL.md" ] && [ -d "$T/skills/synced" ] && ok "nada se perdió (lo movido volvió)" || mal "se perdió algo: $(ls -a "$T/skills" | tr '\n' ' ')"
  case "$out" in *mia*) ok "nombra lo tomado: $out" ;; *) mal "no nombra lo tomado: $out" ;; esac
  ls -d "$H/.claude/"skills.tycon-new-* >/dev/null 2>&1 && mal "quedó una temporal" || ok "no quedó temporal"
  enlaza "$T" "$H" >/dev/null 2>&1
  es_carpeta "$H/.claude/skills" && [ -f "$H/.claude/skills/mia/SKILL.md" ] && ok "suelta, la ejecución siguiente convierte" || mal "suelta no convirtió"
fi

# ───────────────────────────────────────────── T7 ─────────────────────────────────────────────
if corre T7; then
  echo "T7 · Clash_OwnWins — una propia con el nombre de una del arnés queda y se nombra"
  T="$BASE/t7/arbol"; H="$BASE/t7/home"; arbol "$T" release; mkdir -p "$H/.claude/skills/otra"; printf 'mia\n' > "$H/.claude/skills/otra/SKILL.md"
  out="$(enlaza "$T" "$H" 2>&1)"
  [ "$(cat "$H/.claude/skills/otra/SKILL.md")" = mia ] && [ ! -L "$H/.claude/skills/otra" ] && ok "la propia quedó" || mal "la propia se pisó"
  case "$out" in *otra*) ok "y se nombra" ;; *) mal "no se nombra: $out" ;; esac
fi

# ───────────────────────────────────────────── T8 ─────────────────────────────────────────────
if corre T8; then
  echo "T8 · OtherCloneLink_NotConverted — un enlace entero a OTRO clon del arnés no se toca"
  T="$BASE/t8/arbol"; O="$BASE/t8/otro"; H="$BASE/t8/home"; arbol "$T" release; arbol "$O" release; mkdir -p "$H/.claude"
  ln -s "$O/skills" "$H/.claude/skills"
  enlaza "$T" "$H" >/dev/null 2>&1
  [ "$(destino "$H/.claude/skills")" = "$O/skills" ] && ok "el enlace al otro clon quedó" || mal "se tocó: $(ls -la "$H/.claude" | tr '\n' ' ')"
fi

# ───────────────────────────────────────────── T9 ─────────────────────────────────────────────
if corre T9; then
  echo "T9 · Update_KeepsOwnAndSynced — después de convertir, una versión nueva no se lleva nada (forma de enlaces de la 8.33)"
  OWN="$BASE/t9/home/.tycon"; H="$BASE/t9/home"; mkdir -p "$OWN/versions"
  arbol "$OWN/versions/v1" release; ln -s "$OWN/versions/v1" "$OWN/harness"
  siembra_vieja "$OWN/harness" "$H"
  enlaza "$OWN/harness" "$H" >/dev/null 2>&1
  [ "$(destino "$H/.claude/skills/otra")" = "$OWN/harness/skills/otra" ] && ok "las entradas nombran ~/.tycon/harness (no la carpeta numerada)" || mal "la entrada nombra $(destino "$H/.claude/skills/otra")"
  # una versión nueva, con una skill más; el enlace pasa a ella
  cp -R "$OWN/versions/v1" "$OWN/versions/v2"; mkdir -p "$OWN/versions/v2/skills/nueva"; printf 'nueva\n' > "$OWN/versions/v2/skills/nueva/SKILL.md"
  rm "$OWN/harness"; ln -s "$OWN/versions/v2" "$OWN/harness"
  enlaza "$OWN/harness" "$H" >/dev/null 2>&1
  [ -f "$H/.claude/skills/mia/SKILL.md" ] && [ -d "$H/.claude/skills/synced" ] && [ -f "$H/.claude/agents/mio.md" ] && ok "lo propio y synced/ siguen" || mal "se perdió algo propio: $(ls -a "$H/.claude/skills" | tr '\n' ' ')"
  [ "$(cat "$H/.claude/skills/nueva/SKILL.md" 2>/dev/null)" = nueva ] && ok "la skill nueva quedó enlazada" || mal "la skill nueva no se ve"
  [ "$(cd "$H/.claude/skills/otra" && pwd -P)" = "$(cd "$OWN/versions/v2/skills/otra" && pwd -P)" ] && ok "los enlaces llevan a la versión nueva" || mal "los enlaces llevan a $(cd "$H/.claude/skills/otra" && pwd -P)"
fi

# ───────────────────────────────────────────── T16 ────────────────────────────────────────────
if corre T16; then
  echo "T16 · Convert_SameName_SaysWhy — un nombre repetido en la temporal: igual se junta; distinto se dice, sin culpar a nadie"
  # igual: el corte dejó en la temporal una copia idéntica de synced/ y Claude Code la volvió a bajar adentro del árbol
  T="$BASE/t15a/arbol"; H="$BASE/t15a/home"; arbol "$T" release; siembra_vieja "$T" "$H"
  TMPD="$H/.claude/skills.tycon-new-995"; mkdir -p "$TMPD"; cp -R "$T/skills/synced" "$TMPD/synced"
  out="$(enlaza "$T" "$H" 2>&1)"
  es_carpeta "$H/.claude/skills" && [ "$(cat "$H/.claude/skills/synced/org_cuenta/de-la-cuenta/SKILL.md" 2>/dev/null)" = cuenta ] && ok "igual: se juntó y convirtió" || mal "igual: no convirtió — $out"
  [ ! -e "$TMPD" ] && [ ! -e "$T/skills/synced" ] && ok "igual: no quedó temporal ni copia en el árbol" || mal "igual: quedó algo: $(ls -a "$H/.claude" "$T/skills" | tr '\n' ' ')"
  case "$out" in "✓ tycon"*) ok "igual: la línea dice que pasó" ;; *) mal "igual: $out" ;; esac
  # distinto, con el enlace entero todavía: no traba nada; una versión queda aparte (Claude Code no la lee) y se dice una vez
  T="$BASE/t15b/arbol"; H="$BASE/t15b/home"; arbol "$T" release; siembra_vieja "$T" "$H"
  TMPD="$H/.claude/skills.tycon-new-994"; mkdir -p "$TMPD/mia"; printf 'otra version\n' > "$TMPD/mia/SKILL.md"
  out="$(enlaza "$T" "$H" 2>&1)"; rc=$?
  [ "$rc" = 0 ] && es_carpeta "$H/.claude/skills" && [ ! -e "$TMPD" ] && ok "distinto: sale 0, convierte y no queda temporal" || mal "distinto: rc $rc, $(ls -la "$H/.claude" | tr '\n' ' ') — $out"
  [ "$(cat "$H/.claude/skills/mia/SKILL.md" 2>/dev/null)" = "otra version" ] && [ "$(cat "$H/.claude/skills.tycon-aparte/mia/SKILL.md" 2>/dev/null)" = mia ] && [ ! -e "$T/skills/mia" ] && ok "distinto: las dos versiones siguen, una aparte y fuera del árbol" || mal "distinto: $(ls -aR "$H/.claude" 2>&1 | tr '\n' ' ')"
  case "$out" in *"distinto contenido"*"tycon-aparte"*) ok "distinto: dice qué quedó aparte y dónde" ;; *) mal "distinto: no lo dice: $out" ;; esac
  case "$out" in *"lo tiene abierto"*) mal "distinto: culpa a un programa: $out" ;; *) ok "distinto: no culpa a un programa" ;; esac
  out2="$(enlaza "$T" "$H" 2>&1)"
  [ -z "$out2" ] && ok "distinto: la ejecución siguiente no lo repite" || mal "distinto: la siguiente dijo: $out2"
  # distinto, con la carpeta ya real (Claude Code la recreó): queda la de la carpeta; la de la temporal, aparte
  T="$BASE/t15c/arbol"; H="$BASE/t15c/home"; arbol "$T" release; mkdir -p "$H/.claude/skills/mia" "$H/.claude/skills.tycon-new-993/mia"
  printf 'nueva\n' > "$H/.claude/skills/mia/SKILL.md"; printf 'vieja\n' > "$H/.claude/skills.tycon-new-993/mia/SKILL.md"
  out="$(enlaza "$T" "$H" 2>&1)"
  [ "$(cat "$H/.claude/skills/mia/SKILL.md")" = nueva ] && [ "$(cat "$H/.claude/skills.tycon-aparte/mia/SKILL.md" 2>/dev/null)" = vieja ] && [ ! -e "$H/.claude/skills.tycon-new-993" ] && ok "recreada: las dos versiones siguen y no queda temporal" || mal "recreada: $(ls -aR "$H/.claude" 2>&1 | tr '\n' ' ')"
  case "$out" in *"tycon-aparte"*) ok "recreada: dice qué quedó aparte" ;; *) mal "recreada: $out" ;; esac
  # un `.tycon-aparte` que es un ENLACE (lo puso otro): no se escribe a través de él; lo repetido queda en la temporal
  T="$BASE/t15d/arbol"; H="$BASE/t15d/home"; arbol "$T" release; mkdir -p "$H/.claude/skills/mia" "$H/.claude/skills.tycon-new-988/mia" "$BASE/t15d/otro-lado"
  printf 'nueva\n' > "$H/.claude/skills/mia/SKILL.md"; printf 'vieja\n' > "$H/.claude/skills.tycon-new-988/mia/SKILL.md"
  ln -s "$BASE/t15d/otro-lado" "$H/.claude/skills.tycon-aparte"
  out="$(enlaza "$T" "$H" 2>&1)"
  [ -z "$(ls -A "$BASE/t15d/otro-lado")" ] && [ "$(cat "$H/.claude/skills.tycon-new-988/mia/SKILL.md" 2>/dev/null)" = vieja ] && ok "aparte enlazado: no escribió a través del enlace; la versión quedó en la temporal" || mal "aparte enlazado: $(ls -aR "$BASE/t15d" | tr '\n' ' ')"
  case "$out" in *"no es una carpeta"*) ok "aparte enlazado: lo dice" ;; *) mal "aparte enlazado: $out" ;; esac
  lleva "$H/.claude/skills/otra" "$T/skills/otra" && ok "recreada: las del arnés igual quedan enlazadas" || mal "recreada: faltan enlaces del arnés"
fi

# ───────────────────────────────────────────── T17 ────────────────────────────────────────────
if corre T17; then
  echo "T17 · Convert_HeldAtMerge_NotClaimedDone — algo tomado al juntar: no dice «pasó»; lo que no vuelve, queda en la temporal"
  T="$BASE/t16/arbol"; H="$BASE/t16/home"; arbol "$T" release; mkdir -p "$H/.claude/skills" "$H/.claude/skills.tycon-new-992/mia"
  printf 'mia\n' > "$H/.claude/skills.tycon-new-992/mia/SKILL.md"
  # (la temporal se nombra desde la HOME tal como se pasa; el árbol, por su ruta real)
  TOMADO="$H/.claude/skills.tycon-new-992/mia"
  out="$(NODE_OPTIONS="--require $HELD_JS" TYCON_TEST_HELD="$TOMADO" enlaza "$T" "$H" 2>&1)"
  case "$out" in *"pasó a carpeta tuya"*) mal "dice que pasó con algo tomado: $out" ;; *"no pude mover"*) ok "dice que no pudo mover" ;; *) mal "no lo dice: $out" ;; esac
  [ -f "$H/.claude/skills.tycon-new-992/mia/SKILL.md" ] && ok "lo tomado sigue en la temporal" || mal "se perdió lo tomado"
  enlaza "$T" "$H" >/dev/null 2>&1
  [ -f "$H/.claude/skills/mia/SKILL.md" ] && [ ! -e "$H/.claude/skills.tycon-new-992" ] && ok "suelto, la ejecución siguiente lo junta" || mal "suelto no juntó"
  # lo movido no puede volver: queda en la temporal (de un corte anterior), se dice, y la corrida siguiente termina
  T="$BASE/t16b/arbol"; H="$BASE/t16b/home"; arbol "$T" release; siembra_vieja "$T" "$H"
  TMPD="$H/.claude/skills.tycon-new-991"; mkdir -p "$TMPD"
  HT="$(cd "$T" && pwd -P)"
  out="$(NODE_OPTIONS="--require $HELD_JS" TYCON_TEST_HELD="$HT/skills/mia:$TMPD/synced" enlaza "$T" "$H" 2>&1)"
  case "$out" in *"no pude devolver"*) ok "dice lo que no pudo devolver" ;; *) mal "no lo dice: $out" ;; esac
  [ -f "$TMPD/synced/org_cuenta/de-la-cuenta/SKILL.md" ] && [ -f "$T/skills/mia/SKILL.md" ] && ok "nada se perdió" || mal "se perdió algo"
  enlaza "$T" "$H" >/dev/null 2>&1
  es_carpeta "$H/.claude/skills" && [ -f "$H/.claude/skills/mia/SKILL.md" ] && [ -d "$H/.claude/skills/synced" ] && [ ! -e "$TMPD" ] && ok "la ejecución siguiente termina" || mal "no terminó: $(ls -a "$H/.claude" "$H/.claude/skills" 2>&1 | tr '\n' ' ')"
fi

# ───────────────────────────────────────────── T18 ────────────────────────────────────────────
if corre T18; then
  echo "T18 · Convert_TmpBesideOwnLink_Untouched — una temporal al lado de un enlace propio: no se toca ninguno"
  T="$BASE/t17/arbol"; H="$BASE/t17/home"; arbol "$T" release; mkdir -p "$H/mis-skills/propia" "$H/.claude/skills.tycon-new-990/mia"
  printf 'mia\n' > "$H/.claude/skills.tycon-new-990/mia/SKILL.md"; ln -s "$H/mis-skills" "$H/.claude/skills"
  out="$(enlaza "$T" "$H" 2>&1)"
  [ "$(destino "$H/.claude/skills")" = "$H/mis-skills" ] && [ -d "$H/mis-skills/propia" ] && ok "el enlace propio quedó" || mal "se tocó el enlace propio: $(ls -la "$H/.claude" | tr '\n' ' ')"
  [ -f "$H/.claude/skills.tycon-new-990/mia/SKILL.md" ] && ok "la temporal quedó" || mal "se tocó la temporal"
  case "$out" in *"no toco"*) ok "lo dice" ;; *) mal "no lo dice: $out" ;; esac
fi

# ───────────────────────────────────────────── T19 ────────────────────────────────────────────
if corre T19; then
  echo "T19 · Convert_UnknownCheckCrossDisk — sin saber qué es del arnés no se mueve nada; --check no escribe; otro disco: copia"
  T="$BASE/t18a/arbol"; H="$BASE/t18a/home"; arbol "$T" release; siembra_vieja "$T" "$H"; rm "$T/.tycon-release.json"
  out="$(enlaza "$T" "$H" 2>&1)"
  lleva "$H/.claude/skills" "$T/skills" && [ -f "$T/skills/mia/SKILL.md" ] && ok "sin manifiesto ni git: el enlace y lo propio quedan" || mal "sin manifiesto: se movió algo"
  case "$out" in *"no sé qué es del arnés"*) ok "y lo dice" ;; *) mal "no lo dice: $out" ;; esac
  T="$BASE/t18b/arbol"; H="$BASE/t18b/home"; arbol "$T" release; siembra_vieja "$T" "$H"
  out="$(node "$CP" --ensure-repo-links --clone "$T" --only entries --home "$H" --check 2>&1)"
  lleva "$H/.claude/skills" "$T/skills" && [ -f "$T/skills/mia/SKILL.md" ] && ! ls -d "$H/.claude/"*.tycon-new-* >/dev/null 2>&1 && ok "--check no escribe nada" || mal "--check escribió"
  case "$out" in *"pasaría a carpeta tuya"*) ok "--check dice lo que haría" ;; *) mal "--check: $out" ;; esac
  # lo de terceros con la otra forma del manifiesto (thirdParty) y la capa del equipo son del arnés: no se mueven
  T="$BASE/t18c/arbol"; H="$BASE/t18c/home"; arbol "$T" release; mkdir -p "$T/skills/del-equipo"; printf 'eq\n' > "$T/skills/del-equipo/SKILL.md"
  printf '{ "thirdParty": [ { "target": "skills/tercera" } ] }\n' > "$T/scripts/publishing/third-party-skills.json"
  printf '{ "files": [ {"path":"skills/del-equipo/SKILL.md"} ] }\n' > "$T/.tycon-team.json"
  siembra_vieja "$T" "$H"
  HT="$(cd "$T" && pwd -P)"
  out="$(NODE_OPTIONS="--require $HELD_JS" TYCON_TEST_OTHER_DISK="$HT/skills/mia" enlaza "$T" "$H" 2>&1)"
  [ -f "$T/skills/tercera/SKILL.md" ] && [ -f "$T/skills/del-equipo/SKILL.md" ] && ok "terceros y equipo quedan en el árbol" || mal "se movió lo de terceros o del equipo"
  lleva "$H/.claude/skills/tercera" "$T/skills/tercera" && lleva "$H/.claude/skills/del-equipo" "$T/skills/del-equipo" && ok "y quedan enlazadas" || mal "no quedaron enlazadas: $out"
  [ "$(cat "$H/.claude/skills/mia/SKILL.md" 2>/dev/null)" = mia ] && [ ! -e "$T/skills/mia" ] && ok "otro disco: se copió entera y se sacó del árbol" || mal "otro disco: $(ls -a "$H/.claude/skills" "$T/skills" | tr '\n' ' ')"
fi

# ───────────────────────────────────────────── T20 ────────────────────────────────────────────
if corre T20; then
  echo "T20 · TwoClonesTransition_Untouched — la máquina con el clon viejo de agent-skills aparte no se convierte"
  T="$BASE/t19/arbol"; H="$BASE/t19/home"; arbol "$T" release; mkdir -p "$H/.claude"
  arbol "$H/.claude/agent-skills" git
  ln -s "$H/.claude/agent-skills/skills" "$H/.claude/skills"; ln -s "$H/.claude/agent-skills/agents" "$H/.claude/agents"
  out="$(enlaza "$T" "$H" 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ "$(destino "$H/.claude/skills")" = "$H/.claude/agent-skills/skills" ] && [ "$(destino "$H/.claude/agents")" = "$H/.claude/agent-skills/agents" ] && ok "los enlaces al clon viejo quedan" || mal "se tocaron: rc $rc, $(ls -la "$H/.claude" | tr '\n' ' ') — $out"
fi

# ───────────────────────────────────────────── T21 ────────────────────────────────────────────
if corre T21; then
  echo "T21 · Update_OwnInPreviousVersion_Moved — la primera conversión corre DESPUÉS del cambio de versión: lo propio quedó en la anterior"
  for forma in enlaces copia; do
    OWN="$BASE/t21-$forma/home/.tycon"; H="$BASE/t21-$forma/home"; mkdir -p "$OWN/versions" "$H/.claude"
    if [ "$forma" = enlaces ]; then arbol "$OWN/versions/v1" release; ln -s "$OWN/versions/v1" "$OWN/harness"; else arbol "$OWN/harness" release; fi
    # la forma vieja, y lo propio escrito a través del enlace entero (cae en la versión activa)
    ln -s "$OWN/harness/skills" "$H/.claude/skills"; ln -s "$OWN/harness/agents" "$H/.claude/agents"
    mkdir -p "$H/.claude/skills/mia" "$H/.claude/skills/synced/org_cuenta/de-la-cuenta"
    printf 'mia\n' > "$H/.claude/skills/mia/SKILL.md"; printf 'cuenta\n' > "$H/.claude/skills/synced/org_cuenta/de-la-cuenta/SKILL.md"; printf 'mio\n' > "$H/.claude/agents/mio.md"
    # el cambio de versión que trae la conversión: la activa pasa a `previous`, la nueva a `harness`
    if [ "$forma" = enlaces ]; then
      arbol "$OWN/versions/v2" release; ln -s "$OWN/versions/v1" "$OWN/previous"; rm "$OWN/harness"; ln -s "$OWN/versions/v2" "$OWN/harness"
    else
      mv "$OWN/harness" "$OWN/previous"; arbol "$OWN/harness" release
    fi
    out="$(enlaza "$OWN/harness" "$H" 2>&1)"; rc=$?
    [ "$rc" = 0 ] && es_carpeta "$H/.claude/skills" && es_carpeta "$H/.claude/agents" && ok "$forma · convirtió" || mal "$forma · rc $rc: $out"
    [ "$(cat "$H/.claude/skills/mia/SKILL.md" 2>/dev/null)" = mia ] && [ -f "$H/.claude/skills/synced/org_cuenta/de-la-cuenta/SKILL.md" ] && [ "$(cat "$H/.claude/agents/mio.md" 2>/dev/null)" = mio ] && ok "$forma · lo propio y synced/ salieron de la versión anterior a la carpeta real" || mal "$forma · lo propio quedó atrás: $(ls -a "$H/.claude/skills" "$OWN/previous/skills" 2>&1 | tr '\n' ' ')"
    [ ! -e "$OWN/previous/skills/mia" ] && [ -f "$OWN/previous/skills/tycon-pipeline/SKILL.md" ] && ok "$forma · la versión anterior conserva lo suyo y nada ajeno" || mal "$forma · la versión anterior: $(ls -a "$OWN/previous/skills" | tr '\n' ' ')"
    lleva "$H/.claude/skills/otra" "$OWN/harness/skills/otra" && ok "$forma · las del arnés, enlazadas a la versión nueva" || mal "$forma · faltan los enlaces"
  done
  # un CLON que se llama `harness` con una carpeta `previous` al lado (sin manifiesto): no es una versión anterior
  B="$BASE/t21-clon"; H="$B/home"; arbol "$B/harness" git; arbol "$B/previous" git; mkdir -p "$B/previous/skills/ajena" "$H/.claude"
  printf 'ajena\n' > "$B/previous/skills/ajena/SKILL.md"
  ln -s "$B/harness/skills" "$H/.claude/skills"; ln -s "$B/harness/agents" "$H/.claude/agents"
  enlaza "$B/harness" "$H" >/dev/null 2>&1
  [ -f "$B/previous/skills/ajena/SKILL.md" ] && [ ! -e "$H/.claude/skills/ajena" ] && ok "clon llamado harness: su vecino previous no se toca" || mal "clon: se movió algo del vecino: $(ls -a "$H/.claude/skills" | tr '\n' ' ')"
fi

# ───────────────────────────────────────────── T22 ────────────────────────────────────────────
if corre T22; then
  echo "T22 · Dangling_BecomesRealFolder — un enlace colgado pasa a carpeta real en la primera ejecución (nunca la forma vieja)"
  T="$BASE/t22/arbol"; H="$BASE/t22/home"; arbol "$T" release; mkdir -p "$H/.claude"
  ln -s "$BASE/t22/borrado/skills" "$H/.claude/skills"; ln -s "$BASE/t22/borrado/agents" "$H/.claude/agents"
  out="$(enlaza "$T" "$H" 2>&1)"
  es_carpeta "$H/.claude/skills" && es_carpeta "$H/.claude/agents" && ok "carpetas reales en la primera ejecución" || mal "no: $(ls -la "$H/.claude" | tr '\n' ' ') — $out"
  lleva "$H/.claude/skills/tycon-pipeline" "$T/skills/tycon-pipeline" && lleva "$H/.claude/agents/rev-a.md" "$T/agents/rev-a.md" && ok "con un enlace por entrada" || mal "faltan los enlaces por entrada"
  case "$out" in *"enlace colgado"*) ok "lo dice" ;; *) mal "no lo dice: $out" ;; esac
  out2="$(enlaza "$T" "$H" 2>&1)"
  [ -z "$out2" ] && ok "la segunda ejecución no hace ni dice nada" || mal "la segunda dijo: $out2"
fi

# ───────────────────────────────────────────── T23 ────────────────────────────────────────────
if corre T23; then
  echo "T23 · HeldResume_ReturnsAll — retomando un corte, si algo no se puede mover, TODO vuelve (también lo del corte)"
  T="$BASE/t23/arbol"; H="$BASE/t23/home"; arbol "$T" release; siembra_vieja "$T" "$H"
  TMPD="$H/.claude/skills.tycon-new-989"; mkdir -p "$TMPD/vieja-mia"; printf 'v\n' > "$TMPD/vieja-mia/SKILL.md"
  HT="$(cd "$T" && pwd -P)"
  out="$(NODE_OPTIONS="--require $HELD_JS" TYCON_TEST_HELD="$HT/skills/mia" enlaza "$T" "$H" 2>&1)"
  lleva "$H/.claude/skills" "$T/skills" && ok "el enlace entero queda" || mal "el enlace cambió"
  [ -f "$T/skills/vieja-mia/SKILL.md" ] && [ ! -e "$TMPD" ] && ok "lo del corte volvió con lo demás; no quedó temporal escondida" || mal "quedó escondido: $(ls -a "$H/.claude" "$T/skills" 2>&1 | tr '\n' ' ')"
  enlaza "$T" "$H" >/dev/null 2>&1
  [ -f "$H/.claude/skills/vieja-mia/SKILL.md" ] && [ -f "$H/.claude/skills/mia/SKILL.md" ] && ok "suelto, la ejecución siguiente convierte todo" || mal "suelto no convirtió"
fi

# ───────────────────────────────────────────── T24 ────────────────────────────────────────────
if corre T24; then
  echo "T24 · NestedSkillsFolder_StaysHarness — una skill del arnés con su propia subcarpeta skills/ sigue siendo del arnés"
  T="$BASE/t24/arbol"; H="$BASE/t24/home"; arbol "$T" release
  mkdir -p "$T/skills/anidada/skills"; printf 'x\n' > "$T/skills/anidada/skills/x.md"
  python3 - "$T/.tycon-release.json" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['files'].append({'path':'skills/anidada/skills/x.md'}); json.dump(d,open(p,'w'))
PY
  siembra_vieja "$T" "$H"
  enlaza "$T" "$H" >/dev/null 2>&1
  [ -f "$T/skills/anidada/skills/x.md" ] && lleva "$H/.claude/skills/anidada" "$T/skills/anidada" && ok "quedó en el árbol y enlazada" || mal "se movió como propia: $(ls -la "$H/.claude/skills" | tr '\n' ' ')"
fi

# ───────────────────────────────────────────── T25 ────────────────────────────────────────────
if corre T25; then
  echo "T25 · CheckPlan_SeesConversion — con --check, el plan del instalador anota que hay algo que escribir"
  T="$BASE/t25/arbol"; H="$BASE/t25/home"; arbol "$T" release; siembra_vieja "$T" "$H"
  PLAN="$BASE/t25/plan.tsv"; : > "$PLAN"
  TYCON_PLAN_PIECES="$PLAN" node "$CP" --ensure-repo-links --clone "$T" --only entries --home "$H" --check >/dev/null 2>&1
  grep -q "	skills	update" "$PLAN" && grep -q "	agents	update" "$PLAN" && ok "skills y agents, en el plan" || mal "el plan no lo ve: $(tr '\n' ' ' < "$PLAN")"
  lleva "$H/.claude/skills" "$T/skills" && ok "y no escribió nada" || mal "--check escribió"
fi

# ───────────────────────────────────────────── T26 ────────────────────────────────────────────
if corre T26; then
  echo "T26 · CaseInsensitiveDisk_OldFormSeen — en un disco que no distingue mayúsculas, la forma vieja se reconoce igual"
  T="$BASE/t26/arbol"; H="$BASE/t26/home"; arbol "$T" release; siembra_vieja "$T" "$H"
  OTRA="$BASE/t26/ARBOL"
  if [ "$(uname)" = Darwin ] && [ -d "$OTRA/skills" ]; then
    rm "$H/.claude/skills"; ln -s "$OTRA/skills" "$H/.claude/skills"
    enlaza "$T" "$H" >/dev/null 2>&1
    es_carpeta "$H/.claude/skills" && [ -f "$H/.claude/skills/mia/SKILL.md" ] && ok "convirtió el enlace escrito con otras mayúsculas" || mal "no lo reconoció: $(ls -la "$H/.claude" | tr '\n' ' ')"
  else
    ok "este disco distingue mayúsculas: el caso no aplica"
  fi
fi

# ───────────────────────────────────────────── T10 / T11 (laboratorio) ─────────────
if corre T10 || corre T11; then
  source "$RAIZ/scripts/tests/lib/harness-lab.sh"
  export TYCON_UPDATE_APPLY=auto
  harness_lab_create "$BASE/lab"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  harness_lab_release_fresh_home
  harness install --version latest --yes >/dev/null 2>&1
  TR="$LAB_HOME/.tycon/harness"
  ESTADO="$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"
fi
if corre T10; then
  echo "T10 · Uninstall_KeepsRealFolders — uninstall quita los enlaces del arnés y deja las carpetas con lo propio"
  PIEZAS="$BASE/piezas.tsv"; : > "$PIEZAS"
  TYCON_REPORT_PIECES="$PIEZAS" node "$CP" --ensure-repo-links --clone "$TR" --only entries --home "$LAB_HOME" >/dev/null 2>&1
  mkdir -p "$LAB_HOME/.claude/skills/mia"; printf 'mia\n' > "$LAB_HOME/.claude/skills/mia/SKILL.md"
  # las piezas que el aplicador de verdad anota: se suman al estado como lo hace el mecanismo
  python3 - "$ESTADO" "$PIEZAS" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); m=d.setdefault('managed',[])
for l in open(sys.argv[2]):
    k,w,i=l.rstrip('\n').split('\t'); m.append({'kind':k,'where':w,'id':i})
json.dump(d,open(p,'w'),indent=2)
PY
  [ -s "$PIEZAS" ] && ok "el aplicador anota los enlaces por entrada como piezas" || mal "no anotó piezas"
  out="$(harness_release uninstall --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "uninstall sale 0" || mal "uninstall salió $rc: $out"
  es_carpeta "$LAB_HOME/.claude/skills" && [ -f "$LAB_HOME/.claude/skills/mia/SKILL.md" ] && ok "la carpeta y lo propio quedan" || mal "se llevó la carpeta o lo propio"
  [ ! -L "$LAB_HOME/.claude/skills/tycon-pipeline" ] && ok "el enlace del arnés se quitó" || mal "quedó el enlace del arnés"
fi
if corre T11; then
  echo "T11 · Doctor_OldForm_SaysConversion · Migrate_BornReal"
  harness_lab_release_fresh_home
  harness install --version latest --yes >/dev/null 2>&1
  rm -rf "$LAB_HOME/.claude/skills"; ln -s "$TR/skills" "$LAB_HOME/.claude/skills"
  out="$(harness_release doctor 2>&1)"
  case "$out" in *"forma vieja"*) ok "doctor dice la forma vieja" ;; *) mal "doctor no la dice: $out" ;; esac
  rm "$LAB_HOME/.claude/skills"; mkdir -p "$LAB_HOME/.claude/skills"
  out="$(harness_release doctor 2>&1)"
  case "$out" in *"forma vieja"*|*"a medias"*|*"apartadas"*) mal "doctor dice de más con la forma nueva: $out" ;; *) ok "con la forma nueva, doctor no dice nada de más" ;; esac
  # lo que deja la conversión: una temporal de un corte y lo apartado
  mkdir -p "$LAB_HOME/.claude/skills.tycon-new-77/mia" "$LAB_HOME/.claude/skills.tycon-aparte/mia"
  out="$(harness_release doctor 2>&1)"
  case "$out" in *"a medias"*) ok "doctor dice la conversión a medias" ;; *) mal "doctor no dice la temporal: $out" ;; esac
  case "$out" in *"apartadas"*) ok "doctor dice lo apartado" ;; *) mal "doctor no dice lo apartado: $out" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
  # (la mudanza re-enchufa con el aplicador de la versión nueva, que corre esta misma pieza —la de T2—: el laboratorio de
  # la mudanza usa un aplicador de juguete, así que ahí no se ve; la pieza es la misma que prueba T2)
fi

if [ "$FALLOS" = 0 ]; then echo "✅ repo-links-real-folders: todo en verde"; exit 0; fi
echo "❌ repo-links-real-folders: $FALLOS fallo(s)"
exit 1
