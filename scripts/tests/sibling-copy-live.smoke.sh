#!/usr/bin/env bash
# sibling-copy-live.smoke.sh — `coordination.js open --repo` de verdad, con el Claude Code de la máquina:
#   1. en un repo cuya carpeta principal está aprobada, crea la copia hermana <repo>--wt-<nombre> y abre la sesión ahí;
#   2. en un repo sin aprobar, se niega, nombra la carpeta principal y no deja ni la copia ni la rama.
# Después cierra lo que abrió: para y borra la sesión de fondo por su id (`claude stop` y `claude rm`), y saca la copia y
# su rama con git.
#
#   bash scripts/tests/sibling-copy-live.smoke.sh [<repo aprobado>]
#
# Sin argumento, el repo aprobado es la carpeta principal de este clon. Sale 0 si todo pasó, 1 si algo no, 2 si no se
# pudo probar (no hay claude, o el repo no es un repo).
#
# Corre con la carpeta personal real: la aprobación de una carpeta vive en ~/.claude.json, y una HOME vacía no tiene
# ninguna. Por eso la sesión que abre cuenta para el tope de la máquina: mientras dura y, cerrada a mano, como recién
# abierta durante 10 minutos más. Se corre con turno de la coordinadora y con un lugar libre en el tope. Nunca escribe
# en ~/.claude.json ni aprueba nada.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COORD="$ROOT/scripts/tools/coordination.js"
NODE="${NODE:-node}"
fails=0
ok() { echo "ok  $*"; }
mal() { echo "MAL $*"; fails=$((fails + 1)); }

command -v claude >/dev/null 2>&1 || { echo "NO SE PROBÓ: no hay claude en el PATH"; exit 2; }

if [ $# -ge 1 ]; then APROBADO="$1"; else
  comun="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || { echo "NO SE PROBÓ: $ROOT no es un repo"; exit 2; }
  APROBADO="$(dirname "$comun")"
fi
git -C "$APROBADO" rev-parse --git-dir >/dev/null 2>&1 || { echo "NO SE PROBÓ: $APROBADO no es un repo"; exit 2; }

# stable-data: el reloj sólo arma un nombre que no choque con otra sesión viva; ningún resultado depende de la fecha
SELLO="$(date +%s)"
NOMBRE="humo-copia-$SELLO"
COPIA="$APROBADO--wt-$NOMBRE"
TMP="$(mktemp -d)"

# el id de fondo de la sesión abierta, por su nombre, de los archivos de sesión de Claude Code
id_de() {
  "$NODE" -e '
const fs = require("fs"); const path = require("path");
const dir = path.join(require("os").homedir(), ".claude", "sessions");
let id = "";
for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
  try { const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); if (s.name === process.argv[1] && typeof s.jobId === "string") id = s.jobId; } catch (_) {}
}
process.stdout.write(id);' "$1"
}

cerrar() {
  local id=""
  for _ in $(seq 1 30); do id="$(id_de "$NOMBRE")"; [ -n "$id" ] && break; sleep 2; done
  if [ -n "$id" ]; then
    claude stop "$id" >/dev/null 2>&1
    claude rm "$id" >/dev/null 2>&1
    echo "    cerré la sesión $id (sigue contando para el tope como recién abierta hasta que vence, a los 10 min)"
  else
    echo "    no encontré el id de fondo de «${NOMBRE}»: cerrala a mano (claude agents)"
    fails=$((fails + 1))
  fi
  [ -d "$COPIA" ] && git -C "$APROBADO" worktree remove --force "$COPIA" >/dev/null 2>&1
  git -C "$APROBADO" worktree prune >/dev/null 2>&1
  git -C "$APROBADO" branch -D "wt/$NOMBRE" >/dev/null 2>&1
  rm -rf "$TMP"
}

# ── 1 · repo sin aprobar: se niega y no deja nada ────────────────────────────────────────────────────────────────────
# primero: una apertura que falla no cuenta para el tope, y la que abre sí (aun cerrada, cuenta un rato como reciente)
SIN="$(mktemp -d)"
NUEVO="$SIN/sin-aprobar-$SELLO"
git init -q --bare "$SIN/origen.git"
git init -q -b main "$NUEVO"
# la ruta real: en macOS la carpeta temporal tiene dos nombres (/var y /private/var) y `open` nombra la real
NUEVO="$(cd "$NUEVO" && pwd -P)"
GIT_AUTHOR_DATE="2026-11-10T10:00:00Z" GIT_COMMITTER_DATE="2026-11-10T10:00:00Z" \
  git -C "$NUEVO" -c maintenance.auto=false -c user.name=humo -c user.email=humo@example.invalid commit -q --allow-empty -m inicio
git -C "$NUEVO" remote add origin "$SIN/origen.git"
git -C "$NUEVO" push -q origin main 2>/dev/null
NOMBRE2="humo-sin-aprobar-$SELLO"
salida="$("$NODE" "$COORD" open --name "$NOMBRE2" --repo "$NUEVO" -- "Humo del arnés: no hagas nada." 2>&1)"; rc=$?
echo "    open (sin aprobar): $salida"
if [ "$rc" != 0 ] && printf '%s' "$salida" | grep -qF "falta aprobar la carpeta principal $NUEVO" \
  && printf '%s' "$salida" | grep -qF -- "--slot" && [ ! -d "$NUEVO--wt-$NOMBRE2" ] \
  && ! git -C "$NUEVO" show-ref --verify --quiet "refs/heads/wt/$NOMBRE2"; then
  ok "AC 4: se negó, nombró la carpeta principal y la opción --slot, y no dejó la copia ni la rama"
else
  mal "AC 4: rc=$rc; la copia $( [ -d "$NUEVO--wt-$NOMBRE2" ] && echo quedó || echo no quedó)"
  id="$(id_de "$NOMBRE2")"; [ -n "$id" ] && { claude stop "$id" >/dev/null 2>&1; claude rm "$id" >/dev/null 2>&1; }
fi
rm -rf "$SIN"

# ── 2 · repo aprobado: abre en la copia hermana ──────────────────────────────────────────────────────────────────────
salida="$("$NODE" "$COORD" open --name "$NOMBRE" --repo "$APROBADO" -- "Humo del arnés: no hagas nada; contestá «listo» y terminá." 2>&1)"; rc=$?
echo "    open (aprobado): $salida"
if [ "$rc" = 0 ] && [ -d "$COPIA" ] && printf '%s' "$salida" | grep -qF "$COPIA" \
  && [ "$(git -C "$COPIA" rev-parse --abbrev-ref HEAD 2>/dev/null)" = "wt/$NOMBRE" ]; then
  ok "AC 1: abrió «${NOMBRE}» en la copia $COPIA, en la rama wt/$NOMBRE, sin pedir aprobación"
else
  mal "AC 1: no abrió en la copia (rc=$rc)"
fi
cerrar
[ ! -d "$COPIA" ] && ! git -C "$APROBADO" show-ref --verify --quiet "refs/heads/wt/$NOMBRE" \
  && ok "cerré lo que abrí: ni la copia ni la rama quedaron" || mal "quedó la copia o la rama de «${NOMBRE}»"

[ "$fails" = 0 ] && { echo "— humo de la copia hermana: todo pasó —"; exit 0; }
echo "— humo de la copia hermana: $fails fallo(s) —"; exit 1
