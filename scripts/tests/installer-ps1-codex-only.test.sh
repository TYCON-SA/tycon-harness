#!/usr/bin/env bash
# installer-ps1-codex-only.test.sh — el instalador de Windows (`install-tycon-hooks.ps1`) en una máquina sólo con Codex
# (`TYCON_HARNESS_CLAUDE=off`, lo pone harness.js), por EJECUCIÓN con `pwsh`.
#
# La falla que caza: en Windows, una máquina sólo con Codex no corría el aplicador (el .ps1 no conocía ese modo): sin
# hooks de git, sin buzón, sin engram y sin el AGENTS.md puntero. Con el modo, corre la misma lista cerrada que el .sh
# (Codex usa esas piezas igual) y nada se escribe en la carpeta de Claude Code.
#
# Cómo mide: un clon de laboratorio (copia de `scripts/` sin sus pruebas, unido: `skills/tycon-pipeline` y `agents/` de
# juguete) con las piezas de afuera de mentira (anotan que corrieron, sin red ni servicios): el refresco de Azure, los
# chequeos de engram y de sqlite3 y la subida al buzón. Una HOME de laboratorio que vive en la casa propia, con un repo de
# proyecto (CLAUDE.md y origen en una organización de juguete) y un `az` de mentira. `env -i`: nada de quien corre se cuela;
# los `XDG_*` de pwsh fuera de la HOME. Mide además, con los guiones reales, que los sellos de engram y de sqlite3 de
# Windows van a la carpeta del estado.
# 🔴 Nunca la HOME real. Sin red, sin docker, sin sudo.
# Sin `pwsh` o sin `node` en el PATH: UNA línea «NO MEDIDO» y exit 0 — ni verde ni rojo.
# Lo que NO mide: Windows de verdad (rutas con `\`, PowerShell 5.1): lo mide el escenario codex-only del pipeline 182.
# Correr: bash scripts/tests/installer-ps1-codex-only.test.sh   (unos 15 s)

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v pwsh >/dev/null 2>&1 || { echo "⏭ installer-ps1-codex-only: NO MEDIDO — no hay pwsh en esta máquina"; exit 0; }
command -v node >/dev/null 2>&1 || { echo "⏭ installer-ps1-codex-only: NO MEDIDO — no hay node en esta máquina"; exit 0; }

T="$(mktemp -d "${TMPDIR:-/tmp}/ps1-codex-only.XXXXXX")" && T="$(cd "$T" && pwd -P)" || { echo "❌ installer-ps1-codex-only: no pude crear la carpeta temporal"; exit 1; }
trap 'rm -rf "$T"' EXIT
FAILURES=0; TOTAL=0
ok() { TOTAL=$((TOTAL+1)); echo "✅ installer-ps1-codex-only: $1"; }
no() { TOTAL=$((TOTAL+1)); FAILURES=$((FAILURES+1)); echo "❌ installer-ps1-codex-only: $1"; }

# ── el clon de laboratorio ─────────────────────────────────────────────────────────────────────────────────────────
CLONE="$T/clone"; mkdir -p "$CLONE/agents" "$CLONE/skills/tycon-pipeline"
( cd "$ROOT" && tar cf - --exclude=scripts/tests --exclude=node_modules --exclude=.bench scripts ) | ( cd "$CLONE" && tar xf - )
[ -f "$CLONE/scripts/install-tycon-hooks.ps1" ] || { echo "❌ installer-ps1-codex-only: no pude armar el clon de laboratorio"; exit 1; }
printf '# skill de juguete\n' > "$CLONE/skills/tycon-pipeline/SKILL.md"
anota_js() { printf 'require("fs").appendFileSync(require("path").join(require("os").homedir(), "corrio.txt"), "%s\\n");\n' "$1"; }
anota_js refresco-azure > "$CLONE/scripts/hooks/failed-query-notice.js"
anota_js subida-al-buzon > "$CLONE/scripts/metrics/upload-runs.js"
for f in check-engram-version ensure-sqlite3; do
  printf 'Add-Content -LiteralPath (Join-Path $HOME "corrio.txt") -Value "%s"\nif ($args.Count) { Add-Content -LiteralPath (Join-Path $HOME "corrio.txt") -Value ("%s con: " + ($args -join " ") + " auto=" + $env:TYCON_ENGRAM_AUTO_UPGRADE) }\nexit 0\n' "$f" "$f" > "$CLONE/scripts/setup/$f.ps1"
done

# ── la HOME: vive en la casa propia, con un repo de proyecto y un az de mentira ─────────────────────────────────────
H="$T/home"; mkdir -p "$H/.tycon/state" "$H/repos" "$T/bin" "$T/xdg" "$T/tmp"; : > "$H/gitconfig"
printf '#!/bin/sh\nexit 0\n' > "$T/bin/az"; chmod +x "$T/bin/az"
P="$H/repos/proyecto"; mkdir -p "$P" && git -C "$P" init -q && git -C "$P" remote add origin "https://dev.azure.com/acme/proyecto/_git/proyecto" && printf '# reglas del proyecto\n' > "$P/CLAUDE.md"
lab() { # [VAR=val …] -- <comando…>: con la HOME de laboratorio y sin el ambiente de quien corre
  local extra=(); while [ $# -gt 0 ] && [ "$1" != "--" ]; do extra+=("$1"); shift; done; [ $# -gt 0 ] && shift
  ( cd "$H" && env -i HOME="$H" USERPROFILE="$H" PATH="$T/bin:$PATH" TMPDIR="$T/tmp" LANG="${LANG:-en_US.UTF-8}" \
      XDG_CACHE_HOME="$T/xdg/cache" XDG_DATA_HOME="$T/xdg/data" XDG_CONFIG_HOME="$T/xdg/config" \
      POWERSHELL_TELEMETRY_OPTOUT=1 POWERSHELL_UPDATECHECK=Off GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$H/gitconfig" \
      GIT_TERMINAL_PROMPT=0 TYCON_HARNESS_NODE=0 TYCON_PROFILE=0 TYCON_REPOS_ROOT="$H/repos" \
      ${extra[@]+"${extra[@]}"} "$@" )
}
claude_listing() { [ -e "$1/.claude" ] || return 0; ( cd "$1" && find .claude | LC_ALL=C sort ); }

# ── T1 · el aplicador de Windows sin Claude Code: la lista cerrada, y nada en la carpeta de Claude Code ────────────────
lab TYCON_HARNESS_CLAUDE=off TYCON_HARNESS_LOCK_HELD=1 TYCON_HARNESS_SHARED_DONE=1 TYCON_HARNESS_CODEX=done \
  TYCON_ENGRAM=1 TYCON_ADO_ORG=https://dev.azure.com/acme TYCON_MAILBOX=1 TYCON_MAILBOX_URL_BASE=http://127.0.0.1:9 \
  -- pwsh -NoProfile -NonInteractive -File "$CLONE/scripts/install-tycon-hooks.ps1" > "$T/t1.out" 2>&1; RC=$?
[ "$RC" = 0 ] && ok "T1 el aplicador de Windows sin Claude Code sale 0" || no "T1 salió $RC: $(tail -4 "$T/t1.out" | tr '\n' ' ' | cut -c1-400)"
# el refresco y la subida van de fondo
for _ in $(seq 1 40); do grep -q refresco-azure "$H/corrio.txt" 2>/dev/null && grep -q subida-al-buzon "$H/corrio.txt" 2>/dev/null && break; sleep 0.25; done
# el de sqlite3 corre con el PowerShell 7 de la misma consola (acá, el pwsh de esta máquina); su sello lo mide T3
for f in check-engram-version ensure-sqlite3 refresco-azure subida-al-buzon; do
  grep -qx "$f" "$H/corrio.txt" 2>/dev/null && ok "T1 corrió $f" || no "T1 no corrió $f: $(tr '\n' ' ' < "$H/corrio.txt" 2>/dev/null)"
done
grep -q 'puntero' "$P/AGENTS.md" 2>/dev/null && ok "T1 dejó el AGENTS.md puntero en el repo del proyecto" || no "T1 sin AGENTS.md puntero: $(grep -i agents "$T/t1.out" | head -2 | tr '\n' ' ')"
for g in pre-commit post-commit pre-push; do
  [ -f "$H/.git-hooks/$g" ] && ok "T1 el $g global de git en ~/.git-hooks" || no "T1 falta el $g global de git: $(ls -A "$H/.git-hooks" 2>&1 | tr '\n' ' ')"
done
[ -f "$H/.tycon/state/upload-runs.log" ] && ok "T1 el registro de la subida, en la carpeta del estado" || no "T1 sin upload-runs.log en el estado: $(ls -A "$H/.tycon/state" | tr '\n' ' ')"
[ -z "$(claude_listing "$H")" ] && ok "T1 nada en la carpeta de Claude Code" || no "T1 apareció en ~/.claude: $(claude_listing "$H" | head -10 | tr '\n' ' ')"
! grep -q 'agent-skills no encontrado' "$T/t1.out" && ok "T1 no busca agent-skills (las skills las enlaza harness.js)" || no "T1 buscó agent-skills: $(grep 'agent-skills' "$T/t1.out" | head -1)"

# ── T2 · con -Check: no escribe nada, y sin Claude Code tampoco busca agent-skills ──────────────────────────────────────
H2SNAP="$(cd "$H" && find . -path ./corrio.txt -prune -o -print | LC_ALL=C sort | tr '\n' ' ')"
lab TYCON_HARNESS_CLAUDE=off TYCON_HARNESS_LOCK_HELD=1 TYCON_HARNESS_CODEX=done TYCON_ENGRAM=1 TYCON_ADO_ORG=https://dev.azure.com/acme \
  -- pwsh -NoProfile -NonInteractive -File "$CLONE/scripts/install-tycon-hooks.ps1" -Check > "$T/t2.out" 2>&1; RC=$?
[ "$RC" = 0 ] && ok "T2 con -Check sale 0" || no "T2 con -Check salió $RC: $(tail -3 "$T/t2.out" | tr '\n' ' ' | cut -c1-300)"
[ "$(cd "$H" && find . -path ./corrio.txt -prune -o -print | LC_ALL=C sort | tr '\n' ' ')" = "$H2SNAP" ] && ok "T2 con -Check no escribió nada en la HOME" || no "T2 -Check escribió en la HOME"
grep -qx 'check-engram-version con: -Check auto=0' "$H/corrio.txt" 2>/dev/null && ok "T2 con -Check, el chequeo de engram también mira sin escribir ni actualizar" || no "T2 el chequeo de engram con -Check: $(grep 'con:' "$H/corrio.txt" 2>/dev/null | tr '\n' ' ')"

# ── T3 · los sellos de engram y de sqlite3 de Windows, con los guiones reales: en la carpeta del estado ─────────────────
H3="$T/home3"; mkdir -p "$H3/.tycon/state" "$T/bin3"
printf '#!/bin/sh\nexit 1\n' > "$T/bin3/sqlite3"; chmod +x "$T/bin3/sqlite3"
printf '#!/bin/sh\necho "engram 1.20.0"\necho "Update available: 1.20.0 -> 9.9.9" >&2\n' > "$T/bin3/engram"; chmod +x "$T/bin3/engram"
lab3() { ( cd "$H3" && env -i HOME="$H3" USERPROFILE="$H3" PATH="$T/bin3:$PATH" TMPDIR="$T/tmp" XDG_CACHE_HOME="$T/xdg/cache" XDG_DATA_HOME="$T/xdg/data" \
  XDG_CONFIG_HOME="$T/xdg/config" POWERSHELL_TELEMETRY_OPTOUT=1 POWERSHELL_UPDATECHECK=Off TYCON_HARNESS_CLAUDE=off "$@" ); }
lab3 TYCON_SQLITE_AUTO_INSTALL=0 pwsh -NoProfile -NonInteractive -File "$ROOT/scripts/setup/ensure-sqlite3.ps1" > "$T/t3a.out" 2>&1
[ -f "$H3/.tycon/state/sqlite3-install-last-try" ] && ok "T3 el sello de sqlite3 quedó en ~/.tycon/state" || no "T3 el sello de sqlite3: $(find "$H3" "$T/tmp" -name 'sqlite3-install-last-try' 2>/dev/null | tr '\n' ' ') · $(tail -2 "$T/t3a.out" | tr '\n' ' ')"
lab3 TYCON_ENGRAM_AUTO_UPGRADE=0 pwsh -NoProfile -NonInteractive -File "$ROOT/scripts/setup/check-engram-version.ps1" > "$T/t3b.out" 2>&1
[ -f "$H3/.tycon/state/.tycon-engram-upstream-notice" ] && ok "T3 el sello del aviso de engram quedó en ~/.tycon/state" || no "T3 el sello de engram: $(find "$H3" -name '.tycon-engram-*' 2>/dev/null | tr '\n' ' ') · $(tail -2 "$T/t3b.out" | tr '\n' ' ')"
[ -z "$(claude_listing "$H3")" ] && ok "T3 los dos guiones no escribieron en la carpeta de Claude Code" || no "T3 apareció en ~/.claude: $(claude_listing "$H3" | head -5 | tr '\n' ' ')"

# ── T4 · harness.js corre el aplicador de Windows sin Claude Code si el .ps1 conoce el modo (lo reconoce por su variable) ─
grep -q 'TYCON_HARNESS_CLAUDE' "$ROOT/scripts/install-tycon-hooks.ps1" && ok "T4 el .ps1 nombra TYCON_HARNESS_CLAUDE (harness.js lo lanza en una máquina sólo con Codex)" || no "T4 el .ps1 no nombra TYCON_HARNESS_CLAUDE: harness.js no lo lanzaría"
! grep -n 'isWin(ctx) && applierKnowsClaudeOff\|if (isWin(ctx)) return { ok: true, known: true, pieces: \[\] }' "$ROOT/scripts/setup/harness.js" >/dev/null \
  && ok "T4 harness.js ya no saltea el aplicador de Windows sin Claude Code" || no "T4 harness.js sigue salteando Windows: $(grep -n 'isWin(ctx) && applierKnowsClaudeOff' "$ROOT/scripts/setup/harness.js" | head -1)"

# ── T5 · sin PowerShell 7, una máquina sólo con Codex en Windows no corre el aplicador (no lo pide al instalar) ──────
mkdir -p "$T/sin-pwsh" "$T/con-pwsh"; printf '#!/bin/sh\necho "PowerShell 7.4.0"\n' > "$T/con-pwsh/pwsh"; chmod +x "$T/con-pwsh/pwsh"
printf '# nombra TYCON_HARNESS_CLAUDE\n' > "$T/aplicador.ps1"
R5="$(node -e '
const H = require(process.argv[1]); const [, , script, sin, con] = process.argv;
const corre = (platform, PATH) => H.applierRunsWithoutClaude({ platform, env: { PATH } }, script);
process.stdout.write([corre("win32", sin), corre("win32", con), corre("darwin", sin)].join(" "));' "$ROOT/scripts/setup/harness.js" "$T/aplicador.ps1" "$T/sin-pwsh" "$T/con-pwsh" 2>&1)"
[ "$R5" = "false true true" ] && ok "T5 en Windows sin PowerShell 7 el aplicador sin Claude Code no corre; con él, sí; en Mac no lo pide" || no "T5 Windows sin pwsh / con pwsh / Mac: «${R5}» (esperaba «false true true»)"

# ── T6 · con Claude Code, la mudanza del historial se dice aunque el instalador corte después (settings.json roto) ──────
H6="$T/home6"; mkdir -p "$H6/.tycon/state" "$H6/.claude"; printf 'una línea\n' > "$H6/.claude/safety-guard.log"; printf '{ "hooks": ' > "$H6/.claude/settings.json"
( cd "$H6" && env -i HOME="$H6" USERPROFILE="$H6" PATH="$PATH" TMPDIR="$T/tmp" XDG_CACHE_HOME="$T/xdg/cache" XDG_DATA_HOME="$T/xdg/data" \
    XDG_CONFIG_HOME="$T/xdg/config" POWERSHELL_TELEMETRY_OPTOUT=1 POWERSHELL_UPDATECHECK=Off GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    TYCON_HARNESS_NODE=0 TYCON_PROFILE=0 TYCON_THIRD_PARTY=0 TYCON_NO_GIT_HOOKS=1 TYCON_CODEX=0 TYCON_NO_CLAUDEMD_SYNC=1 TYCON_MAILBOX=0 \
    pwsh -NoProfile -NonInteractive -File "$CLONE/scripts/install-tycon-hooks.ps1" ) > "$T/t6.out" 2>&1
[ -f "$H6/.tycon/state/safety-guard.log" ] && grep -q 'mudé' "$T/t6.out" && ok "T6 la mudanza del historial se dice aunque el instalador corte por un settings.json roto" || no "T6 movido: $([ -f "$H6/.tycon/state/safety-guard.log" ] && echo sí || echo no) · dicho: $(grep -c 'mudé' "$T/t6.out") · $(tail -2 "$T/t6.out" | tr '\n' ' ' | cut -c1-200)"

echo
if [ "$FAILURES" -gt 0 ]; then echo "❌ installer-ps1-codex-only: $FAILURES de $TOTAL en rojo"; exit 1; fi
echo "✅ installer-ps1-codex-only: todo verde ($TOTAL chequeos)"; exit 0
