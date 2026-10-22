#!/usr/bin/env bash
# node-old-real.test.sh — el arnés con un Node 12 de verdad en el PATH (T8 y T12).
#
# POR QUÉ. Con Node 12 en el PATH, cada hook y cada comando del pipeline morían con un SyntaxError que Claude Code toma
# como «non-blocking»: los frenos no corrían. Las pruebas de node-floor.test.js hacen de cuenta que el Node es viejo; ésta
# lo baja de verdad (nodejs.org, con su SHASUMS256) y corre con él lo que corre la persona.
#
# QUÉ MIDE.
#   T8  · con el Node del arnés presente: los scripts que las instrucciones mandan correr arrancan con Node 12 sin
#         SyntaxError (vuelven a lanzar con el del arnés); un freno por el piso corre; sin el Node del arnés, un comando
#         sale 1 con la línea legible y un freno sale 2.
#   T12 · el Node del PATH cambia a mitad de sesión (Node 12, o un `node` que no arranca): los hooks registrados por el
#         aplicador siguen corriendo con el del arnés.
#
# En la Mac con Apple Silicon hace falta Rosetta (Node 12 no tiene binario arm64): sin ella sale NO MEDIDO, nunca verde.
# Un binario ya bajado se pasa con TYCON_TEST_NODE12=<ruta>. La que cuenta es la corrida en Windows (la 182).
#
# Correr:   bash scripts/tests/node-old-real.test.sh
set -u
RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
V=v12.22.12
T="$(mktemp -d "${TMPDIR:-/tmp}/node-old-real.XXXXXX")"
trap 'rm -rf "$T"' EXIT
fallas=0
ok() { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; fallas=$((fallas + 1)); }
nomedido() { echo "  NO MEDIDO — $1"; exit 0; }

case "$(uname -s)" in
  Darwin) PLAT=darwin-x64; EXT=tar.gz ;;
  Linux) PLAT=linux-x64; EXT=tar.gz ;;
  MINGW*|MSYS*|CYGWIN*) PLAT=win-x64; EXT=zip ;;
  *) nomedido "plataforma $(uname -s) sin Node 12 oficial" ;;
esac

# ── el Node 12 ────────────────────────────────────────────────────────────────────────────────────────────────────
N12="${TYCON_TEST_NODE12:-}"
if [ -z "$N12" ]; then
  f="node-$V-$PLAT.$EXT"
  curl -fsSL -o "$T/$f" "https://nodejs.org/dist/$V/$f" || nomedido "no pude bajar $f"
  want="$(curl -fsSL "https://nodejs.org/dist/$V/SHASUMS256.txt" | awk -v f="$f" '$2 == f {print $1}')"
  got="$( (command -v sha256sum >/dev/null && sha256sum "$T/$f" || shasum -a 256 "$T/$f") | awk '{print $1}')"
  [ -n "$want" ] && [ "$want" = "$got" ] || { echo "  MAL  — la huella de $f no es la de SHASUMS256"; exit 1; }
  if [ "$EXT" = zip ]; then
    powershell -NoProfile -Command "Expand-Archive -Path '$(cygpath -w "$T/$f")' -DestinationPath '$(cygpath -w "$T")'" >/dev/null || nomedido "no pude abrir $f"
    N12="$T/node-$V-$PLAT/node.exe"
  else
    tar xzf "$T/$f" -C "$T" || nomedido "no pude abrir $f"
    N12="$T/node-$V-$PLAT/bin/node"
  fi
fi
[ "$("$N12" --version 2>/dev/null)" = "$V" ] || nomedido "el Node 12 no arranca en esta máquina (¿Rosetta?)"

# ── una HOME de juguete con el Node del arnés (el Node que corre las pruebas) ─────────────────────────────────────────
H="$T/home"; mkdir -p "$H/.tycon/node/current/bin" "$H/.claude"
MODERNO="$(node -p process.execPath)"
if [ "$PLAT" = win-x64 ]; then
  HN="$H/.tycon/node/current/node.exe"; cp "$MODERNO" "$HN"
else
  # un envoltorio que deja constancia de que corrió: así se ve que el piso volvió a lanzar con él
  HN="$H/.tycon/node/current/bin/node"
  printf '#!/bin/sh\n[ "$1" = "--version" ] || echo x >> "%s/relanzado"\nexec "%s" "$@"\n' "$T" "$MODERNO" > "$HN"; chmod +x "$HN"
fi
export HOME="$H" USERPROFILE="$H" TYCON_HOME="$H/.tycon" TYCON_PROFILE=0 TYCON_NO_NIGHTLY_EXAM=1
cd "$T"

# ── T8 · cada script del inventario lo LEE un Node 12 (si no, muere antes de llegar a la guarda) ─────────────────────
# la lista sale del mismo inventario que node-floor.test.js: un script nuevo en una instrucción entra solo
LEIDOS=0
for s in $(node "$RAIZ/scripts/tests/node-floor-inventory.js") scripts/lib/node-floor.js skills/tycon-pipeline/scripts/lib/node-floor.js; do
  err="$("$N12" --check "$RAIZ/$s" 2>&1)" && LEIDOS=$((LEIDOS + 1)) || mal "T8 Node 12 no puede leer $s: $(echo "$err" | grep -m1 -E 'SyntaxError|Error')"
done
[ "$LEIDOS" -ge 20 ] && ok "T8 Node 12 lee los $LEIDOS scripts del inventario y el piso" || mal "T8 sólo $LEIDOS scripts leídos (¿el inventario vino vacío?)"

# ── T8 · los scripts de las instrucciones, con Node 12 ──────────────────────────────────────────────────────────────
INVENTARIO="scripts/lib/tycon-config.js skills/tycon-pipeline/scripts/lib/tmp-path.js skills/tycon-pipeline/scripts/qa-guide.js
skills/tycon-pipeline/scripts/mockup.js skills/tycon-pipeline/scripts/lib/story-discovery.js scripts/instincts/instinct-promote.js
scripts/nightly/watcher/vigilante.js scripts/setup/harness.js scripts/metrics/download-runs.js scripts/nightly/dashboard/dashboard.js"
for s in $INVENTARIO; do
  out="$("$N12" "$RAIZ/$s" --help 2>&1 < /dev/null)"
  case "$out" in
    *SyntaxError*|*"Unexpected token"*) mal "T8 $s con Node 12: $(echo "$out" | grep -m1 -E 'SyntaxError|Unexpected token')" ;;
    *) ok "T8 $s arranca con Node 12 sin SyntaxError" ;;
  esac
done
if [ "$PLAT" != win-x64 ]; then
  [ -s "$T/relanzado" ] && ok "T8 el piso volvió a lanzar con el Node del arnés" || mal "T8 nadie lanzó el Node del arnés"
fi

# un freno por el piso, con un evento de juguete: corre (sale 0 con un comando inocente)
GATE="$RAIZ/skills/tycon-pipeline/scripts/on-bash-write-gate.js"
EVENTO='{"session_id":"node-old-real","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo hola"},"cwd":"'"$T"'"}'
rc=0; printf '%s' "$EVENTO" | "$N12" "$RAIZ/scripts/lib/node-floor.js" --gate "$GATE" >/dev/null 2>"$T/err" || rc=$?
[ "$rc" = 0 ] && ok "T8 un freno por el piso corre con Node 12 en el PATH" || mal "T8 el freno salió $rc: $(head -2 "$T/err")"

# sin el Node del arnés: un comando sale 1 con la línea; un freno sale 2
mv "$H/.tycon/node" "$H/.tycon/node.fuera"
rc=0; out="$("$N12" "$RAIZ/skills/tycon-pipeline/scripts/mockup.js" --help 2>&1 < /dev/null)" || rc=$?
case "$out" in *"Node 12.22.12: el arnés necesita Node 20 o más"*) [ "$rc" = 1 ] && ok "T8 sin Node del arnés, el comando sale 1 con la línea legible" || mal "T8 salió $rc";; *) mal "T8 sin Node del arnés dijo: $out";; esac
rc=0; printf '%s' "$EVENTO" | "$N12" "$RAIZ/scripts/lib/node-floor.js" --gate "$GATE" >/dev/null 2>&1 || rc=$?
[ "$rc" = 2 ] && ok "T8 sin Node del arnés, el freno falla cerrado (2)" || mal "T8 el freno salió $rc"
mv "$H/.tycon/node.fuera" "$H/.tycon/node"

# ── T12 · el Node del PATH cambia a mitad de sesión ────────────────────────────────────────────────────────────────
LIST="$T/list.json"
printf '{"hooks":[{"event":"PreToolUse","matcher":"Bash","spec":"tycon-pipeline/scripts/on-bash-write-gate.js","label":"x","when":"always","platforms":{"windows":true},"effect":"blocks"}],"superseded":[],"legacy_fragments":[]}\n' > "$LIST"
SETTINGS="$H/.claude/settings.json"; echo '{}' > "$SETTINGS"
APPLY=(node "$RAIZ/scripts/setup/apply-hooks.js" --settings "$SETTINGS" --hooks-dir "$RAIZ/scripts/hooks" --skills "$RAIZ/skills" --list "$LIST" --effects "$RAIZ/scripts/setup/install-effects.json")
"${APPLY[@]}" >/dev/null 2>&1 || mal "T12 el aplicador falló"
CMD_PROPIO="$(node -e 'const s=require(process.argv[1]);process.stdout.write(s.hooks.PreToolUse[0].hooks[0].command)' "$SETTINGS")"
mkdir -p "$T/bin12" "$T/binroto"
ln -sf "$N12" "$T/bin12/node" 2>/dev/null || cp "$N12" "$T/bin12/"
printf '#!/bin/sh\nexit 1\n' > "$T/binroto/node"; chmod +x "$T/binroto/node"
for p in bin12 binroto; do
  rc=0; printf '%s' "$EVENTO" | PATH="$T/$p:$PATH" sh -c "$CMD_PROPIO" >/dev/null 2>&1 || rc=$?
  [ "$rc" = 0 ] && ok "T12 con el Node del arnés registrado, un node del PATH $p no cambia nada" || mal "T12 ($p) el hook salió $rc"
done
# registrado por el piso (sin el Node del arnés al aplicar), con Node 12 en el PATH: vuelve a lanzar con el del arnés
mv "$H/.tycon/node" "$H/.tycon/node.fuera"; echo '{}' > "$SETTINGS"; "${APPLY[@]}" >/dev/null 2>&1; mv "$H/.tycon/node.fuera" "$H/.tycon/node"
CMD_PISO="$(node -e 'const s=require(process.argv[1]);process.stdout.write(s.hooks.PreToolUse[0].hooks[0].command)' "$SETTINGS")"
case "$CMD_PISO" in *node-floor.js*--gate*) ok "T12 sin Node del arnés al aplicar, el freno queda por el piso con --gate";; *) mal "T12 quedó: $CMD_PISO";; esac
rc=0; printf '%s' "$EVENTO" | PATH="$T/bin12:$PATH" sh -c "$CMD_PISO" >/dev/null 2>&1 || rc=$?
[ "$rc" = 0 ] && ok "T12 por el piso, con Node 12 en el PATH, el freno corre con el del arnés" || mal "T12 por el piso salió $rc"
# y el comando del modelo con Node 12 en el PATH
rc=0; out="$(PATH="$T/bin12:$PATH" node "$RAIZ/skills/tycon-pipeline/scripts/lib/story-discovery.js" --help 2>&1 < /dev/null)" || rc=$?
case "$out" in *SyntaxError*|*"Unexpected token"*) mal "T12 el comando del modelo con Node 12: SyntaxError";; *) ok "T12 el comando del modelo con Node 12 en el PATH corre";; esac

[ "$fallas" = 0 ] && { echo "node-old-real: todo en verde"; exit 0; }
echo "node-old-real: FALLARON $fallas"; exit 1
