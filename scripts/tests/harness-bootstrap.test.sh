#!/usr/bin/env bash
# harness-bootstrap.test.sh — la copia fija de arranque (`scripts/setup/harness/bootstrap.js` + los dos respaldos en
# shell) sobre una máquina de juguete (story 8.13, tanda A · T14 y la parte «árbol de developer borrado» de T11).
#
# Lo que no se puede perder:
#   · La línea de arranque nueva llama a la COPIA FIJA (`~/.claude/.tycon-pipeline/harness/bootstrap.js`), no al árbol:
#     `bootstrap.js` lanza `harness.js startup` del árbol y devuelve su exit code; si no sale 0, si `node` no alcanza el
#     piso, o si el árbol o el enlace faltan, la línea cae al respaldo en shell: `git pull --ff-only --autostash` en los
#     dos repos y el aplicador. Así un `harness.js` roto no deja la máquina quieta (doctrina «lo durable no viaja por el
#     camino roto»). `startup.log` y `notice` lo dicen. La copia fija NO cambia por el respaldo.
#   · Estado `developer` con el árbol borrado: `bootstrap.js` vuelve solo a `managed` sobre `tree_before` (re-apunta el
#     enlace, escribe el estado bajo el candado) y deja el aviso.
#   · `bootstrap.js` es autónomo: cero `require` del árbol (es lo que sobrevive al árbol roto).
#
# El árbol de juguete lleva un `harness.js` FALSO (sale 0, sale 1 o tiene error de sintaxis según el caso; anota argv y
# PATH en `fake-harness.log`): el `harness.js` real lo prueban las otras suites. La parte «la copia fija se refresca sólo
# tras una salud verde y `doctor` dice al día / vieja a propósito» necesita el `update` real: harness-update/doctor.test.sh.
#
# Laboratorio: `scripts/tests/lib/harness-lab.sh` (HOME de juguete, dos remotos bare, clones, aplicador de mentira).
# 🔴 Nada toca `~/.claude`, el checkout real ni `~/.claude/agent-skills`. Sin pipes sobre el comando medido.
set -u
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE="$(mktemp -d "${TMPDIR:-/tmp}/tycon-harness-bootstrap.XXXXXX")"
node "$RAIZ/scripts/tests/lib/lab-guard.js" "$BASE" harness-bootstrap || exit 1
trap 'rm -rf "$BASE"' EXIT
FALLAS=0
ok() { echo "✅ harness-bootstrap: $1"; }
bad() { echo "❌ harness-bootstrap: $1"; FALLAS=$((FALLAS + 1)); }

SRC="$RAIZ/scripts/setup/harness"
FIXTURE="$RAIZ/scripts/tests/fixtures/startup-lines.json"
for f in bootstrap.js bootstrap-fallback.sh bootstrap-fallback.ps1; do
  [ -f "$SRC/$f" ] || { bad "falta $SRC/$f (la feature no existe)"; }
done
[ "$FALLAS" -eq 0 ] || { echo "harness-bootstrap: $FALLAS fallas"; exit 1; }

# ─── estático: autónomo, sin nombres reales, sintaxis ────────────────────────────────────────────────────────────────
if grep -nE "require\((['\"])(\.|/|\\$)" "$SRC/bootstrap.js" >/dev/null; then bad "bootstrap.js hace require de algo del árbol (tiene que ser autónomo)"; else ok "bootstrap.js: cero require del árbol"; fi
node --check "$SRC/bootstrap.js" 2>/dev/null && ok "bootstrap.js compila" || bad "bootstrap.js no compila"
bash -n "$SRC/bootstrap-fallback.sh" 2>/dev/null && ok "bootstrap-fallback.sh: sintaxis" || bad "bootstrap-fallback.sh: error de sintaxis"
for needle in "pull --ff-only --autostash" "agent-skills" "install-tycon-hooks.ps1" "startup.log" "notice"; do
  grep -q -- "$needle" "$SRC/bootstrap-fallback.ps1" && ok "bootstrap-fallback.ps1 (por lectura): trae «${needle}»" || bad "bootstrap-fallback.ps1 no trae «${needle}»"
done
if grep -nE '/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+' "$SRC/bootstrap.js" "$SRC/bootstrap-fallback.sh" "$SRC/bootstrap-fallback.ps1" >/dev/null; then bad "una ruta de usuario fija en la copia fija (los nombres reales los frena new-names.js en el pre-commit)"; else ok "la copia fija no trae rutas de usuario fijas"; fi

# ─── el laboratorio ─────────────────────────────────────────────────────────────────────────────────────────────────
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
harness_lab_create "$BASE/lab" || { echo "❌ harness-bootstrap: no pude armar el laboratorio"; exit 1; }
PIPE="$LAB_HOME/.claude/.tycon-pipeline"; HDIR="$PIPE/harness"; STATE="$PIPE/harness-state.json"
LINK="$LAB_HOME/.claude/tycon-claude-guides"; FAKE_LOG="$PIPE/fake-harness.log"; APPLIER_LOG="$PIPE/lab-applier.log"
ln -s "$LAB_TREE" "$LINK"

NEW_LINE="$(node -e 'process.stdout.write(require(process.argv[1]).new.posix)' "$FIXTURE")"

# la copia fija, como la deja `install`
install_fixed_copy() { mkdir -p "$HDIR"; cp "$SRC/bootstrap.js" "$SRC/bootstrap-fallback.sh" "$SRC/bootstrap-fallback.ps1" "$HDIR/"; }
fixed_hash() { ( cd "$HDIR" && cat bootstrap.js bootstrap-fallback.sh bootstrap-fallback.ps1 ) | shasum -a 256 | cut -d' ' -f1; }
write_state() { # write_state <mode> <tree> <tree_before|null>
  local tb="null"; [ "$3" != "null" ] && tb="\"$3\""
  cat > "$STATE" <<EOF
{ "schema": 1, "mode": "$1", "tree": "$2", "tree_before": $tb,
  "sources": [ { "name": "harness", "url": "$LAB_REMOTE_TREE", "ref": "main", "rewrites": false, "dir": "$LAB_TREE", "commit": null, "previous": null },
               { "name": "agent_skills", "url": "$LAB_REMOTE_SKILLS", "ref": "main", "rewrites": false, "dir": "$LAB_SKILLS", "commit": null, "previous": null } ],
  "channel": "latest", "version": { "number": "2026.10.02+lab", "installed_at": "2026-10-02T00:00:00Z" },
  "managed": [], "hold": null, "notice": null, "last_fetch": null, "last_apply": null, "last_health": null, "failed": null, "bootstrap": null }
EOF
}
state_field() { node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=s[process.argv[2]]; process.stdout.write(v===null||v===undefined?"":String(v))' "$STATE" "$1"; }
# el harness.js FALSO: anota argv y PATH, sale como se le pide
fake_harness() { # fake_harness <exit code | syntax>
  if [ "$1" = "syntax" ]; then printf '%s\n' "'use strict';" "function roto( {" "// harness.js ROTO a propósito (harness-bootstrap.test.sh): error de sintaxis"
  else printf '%s\n' "'use strict';" "// harness.js FALSO (harness-bootstrap.test.sh): anota argv y PATH y sale $1" \
    "require('fs').appendFileSync(require('path').join(require('os').homedir(), '.claude', '.tycon-pipeline', 'fake-harness.log'), 'argv=' + process.argv.slice(2).join(' ') + ' path=' + (process.env.PATH || '') + '\n');" \
    "process.exit($1);"; fi
}
publish_harness() { # publish_harness <exit|syntax> <mensaje>  — una versión nueva del árbol en el remoto, con ese harness.js
  harness_lab_publish tree "$2" scripts/setup/harness.js "$(fake_harness "$1")"
}
pull_tree() { harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1; }
head_of() { harness_lab_git "$1" rev-parse HEAD; }
remote_head() { harness_lab_git "$1" rev-parse HEAD; }
run_line() { # corre la línea de arranque nueva tal como la corre el hook (bash -c) y devuelve su exit code
  bash -c "$NEW_LINE" >"$BASE/line.out" 2>"$BASE/line.err"
}
applier_runs() { [ -f "$APPLIER_LOG" ] && grep -c '^run ' "$APPLIER_LOG" || echo 0; }
log_lines() { [ -f "$HDIR/startup.log" ] && grep -c ' fallback: ' "$HDIR/startup.log" || echo 0; }   # las líneas del respaldo (bootstrap.js anota aparte su motivo)

install_fixed_copy
write_state managed "$LAB_TREE" null
H0="$(fixed_hash)"
publish_harness 0 "v1: harness.js falso que sale 0"; pull_tree

# ═══ T14 · con el árbol sano la línea corre harness.js startup por la copia fija y NO cae al respaldo ════════════════
harness_lab_publish skills "skills v2 (no debería bajar: harness.js sano no hace pull)"
S0="$(head_of "$LAB_SKILLS")"
run_line; rc=$?
[ "$rc" -eq 0 ] && ok "T14 · línea nueva con el árbol sano: sale 0" || bad "T14 · línea nueva con el árbol sano salió $rc: $(cat "$BASE/line.err")"
grep -q '^argv=startup ' "$FAKE_LOG" 2>/dev/null && ok "T14 · bootstrap.js lanzó harness.js con «startup»" || bad "T14 · harness.js no recibió «startup»: $(cat "$FAKE_LOG" 2>/dev/null)"
grep -q "path=$PATH" "$FAKE_LOG" 2>/dev/null && ok "T14 · harness.js corrió con el mismo PATH" || bad "T14 · el PATH no es el de la sesión"
[ "$(head_of "$LAB_SKILLS")" = "$S0" ] && ok "T14 · sin respaldo: agent-skills no avanzó por pull" || bad "T14 · el respaldo corrió con el árbol sano"
[ "$(applier_runs)" = "0" ] && ok "T14 · sin respaldo: el aplicador no corrió" || bad "T14 · el aplicador corrió con el árbol sano"
[ "$(log_lines)" = "0" ] && ok "T14 · sin respaldo: startup.log sin líneas de respaldo" || bad "T14 · startup.log tiene líneas con el árbol sano: $(cat "$HDIR/startup.log")"
[ -z "$(state_field notice)" ] && ok "T14 · sin respaldo: notice vacío" || bad "T14 · notice con el árbol sano: $(state_field notice)"

# argv pasa tal cual (así `rollback` desde la copia fija anda en la C)
node "$HDIR/bootstrap.js" doctor --json >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && grep -q '^argv=doctor --json ' "$FAKE_LOG" && ok "T14 · bootstrap.js pasa cualquier argv (doctor --json)" || bad "T14 · argv no pasó (rc=$rc): $(tail -1 "$FAKE_LOG")"
# y devuelve el exit code de harness.js
publish_harness 3 "v1b: harness.js falso que sale 3"; pull_tree
node "$HDIR/bootstrap.js" version >/dev/null 2>&1; rc=$?
[ "$rc" -eq 3 ] && ok "T14 · bootstrap.js devuelve el exit code de harness.js (3)" || bad "T14 · esperaba 3, salió $rc"

# ═══ T14 · harness.js sale ≠ 0 → el respaldo: los dos repos avanzan por pull, el aplicador corre, log y notice ════════
publish_harness 1 "v2: harness.js falso que sale 1"; pull_tree
harness_lab_publish tree "tree v3 (la trae el respaldo)"; harness_lab_publish skills "skills v3 (la trae el respaldo)"
T_REMOTE="$(remote_head "$LAB_REMOTE_TREE")"; S_REMOTE="$(remote_head "$LAB_REMOTE_SKILLS")"
[ "$(head_of "$LAB_TREE")" != "$T_REMOTE" ] || bad "T14 · precondición: el árbol ya estaba al día"
run_line; rc=$?
[ "$rc" -eq 0 ] && ok "T14 · harness.js sale 1 → la línea sale 0 por el respaldo" || bad "T14 · la línea salió $rc: $(cat "$BASE/line.err")"
[ "$(head_of "$LAB_TREE")" = "$T_REMOTE" ] && ok "T14 · respaldo: el arnés avanzó por pull" || bad "T14 · el arnés no avanzó"
[ "$(head_of "$LAB_SKILLS")" = "$S_REMOTE" ] && ok "T14 · respaldo: agent-skills avanzó por pull" || bad "T14 · agent-skills no avanzó"
[ "$(applier_runs)" = "1" ] && ok "T14 · respaldo: el aplicador corrió (1 vez)" || bad "T14 · el aplicador corrió $(applier_runs) veces"
grep -qi "respaldo" "$HDIR/startup.log" 2>/dev/null && ok "T14 · startup.log dice que corrió el respaldo" || bad "T14 · startup.log no lo dice: $(cat "$HDIR/startup.log" 2>/dev/null)"
grep -qi "respaldo\|bootstrap" <<<"$(state_field notice)" && ok "T14 · notice en el estado lo dice" || bad "T14 · notice vacío o sin la frase: «$(state_field notice)»"
[ -z "$(cat "$BASE/line.out" "$BASE/line.err")" ] && ok "T14 · el respaldo es silencioso" || bad "T14 · el respaldo imprimió: $(cat "$BASE/line.out" "$BASE/line.err")"
[ "$(fixed_hash)" = "$H0" ] && ok "T14 · la copia fija NO cambió por el respaldo" || bad "T14 · la copia fija cambió"
[ -z "$(ls "$LAB_HOME/.claude/settings.json".bak.* 2>/dev/null)" ] || ok "T14 · (el aplicador de juguete dejó su copia de settings.json, como el real)"

# ═══ T14 · v2 con harness.js con ERROR DE SINTAXIS, v3 sana en el remoto → el respaldo trae la v3 ═══════════════════
publish_harness syntax "v4: harness.js con error de sintaxis"; pull_tree
node --check "$LAB_TREE/scripts/setup/harness.js" >/dev/null 2>&1 && bad "T14 · precondición: el harness.js roto compila"
publish_harness 0 "v5: harness.js sano otra vez"
harness_lab_publish skills "skills v5"
T_REMOTE="$(remote_head "$LAB_REMOTE_TREE")"; S_REMOTE="$(remote_head "$LAB_REMOTE_SKILLS")"
A0="$(applier_runs)"; L0="$(log_lines)"
run_line; rc=$?
[ "$rc" -eq 0 ] && ok "T14 · harness.js roto (sintaxis) → la línea sale 0 por el respaldo" || bad "T14 · la línea salió $rc"
[ "$(head_of "$LAB_TREE")" = "$T_REMOTE" ] && node --check "$LAB_TREE/scripts/setup/harness.js" 2>/dev/null && ok "T14 · el respaldo trajo la versión sana del árbol" || bad "T14 · el árbol no quedó en la versión sana"
[ "$(head_of "$LAB_SKILLS")" = "$S_REMOTE" ] && ok "T14 · …y agent-skills avanzó" || bad "T14 · agent-skills no avanzó tras el roto"
[ "$(applier_runs)" = "$((A0 + 1))" ] && ok "T14 · …y el aplicador corrió" || bad "T14 · el aplicador no corrió tras el roto"
[ "$(log_lines)" = "$((L0 + 1))" ] && ok "T14 · una línea más en startup.log" || bad "T14 · startup.log: esperaba $((L0 + 1)) líneas, hay $(log_lines)"
# la sesión siguiente ya arranca por harness.js (sano): sin respaldo
: > "$FAKE_LOG"; A0="$(applier_runs)"
run_line; rc=$?
[ "$rc" -eq 0 ] && grep -q '^argv=startup ' "$FAKE_LOG" && [ "$(applier_runs)" = "$A0" ] && ok "T14 · la sesión siguiente arranca por harness.js, sin respaldo" || bad "T14 · la sesión siguiente no arrancó por harness.js (rc=$rc, aplicador $(applier_runs) vs $A0)"

# ═══ T14 · enlace borrado → bootstrap.js sale ≠ 0 y el respaldo usa el árbol del estado ═════════════════════════════
rm "$LINK"
harness_lab_publish tree "tree v6"; harness_lab_publish skills "skills v6"
T_REMOTE="$(remote_head "$LAB_REMOTE_TREE")"; S_REMOTE="$(remote_head "$LAB_REMOTE_SKILLS")"
node "$HDIR/bootstrap.js" >/dev/null 2>"$BASE/bs.err"; rc=$?
[ "$rc" -ne 0 ] && ok "T14 · sin enlace bootstrap.js sale ≠ 0 ($rc)" || bad "T14 · sin enlace bootstrap.js salió 0"
grep -qiE "enlace|lugar" "$BASE/bs.err" && ok "T14 · …y lo dice en una línea" || bad "T14 · no nombra el lugar: $(cat "$BASE/bs.err")"
A0="$(applier_runs)"
run_line; rc=$?
[ "$rc" -eq 0 ] && ok "T14 · sin enlace la línea sale 0 por el respaldo" || bad "T14 · sin enlace la línea salió $rc"
[ "$(head_of "$LAB_TREE")" = "$T_REMOTE" ] && [ "$(head_of "$LAB_SKILLS")" = "$S_REMOTE" ] && ok "T14 · sin enlace el respaldo avanzó los dos repos (árbol del estado)" || bad "T14 · sin enlace los repos no avanzaron"
[ "$(applier_runs)" = "$((A0 + 1))" ] && ok "T14 · sin enlace el aplicador corrió desde el árbol del estado" || bad "T14 · sin enlace el aplicador no corrió"
grep -qi "enlace" <<<"$(state_field notice)" && ok "T14 · notice nombra el enlace" || bad "T14 · notice sin el enlace: «$(state_field notice)»"
ln -s "$LAB_TREE" "$LINK"

# ═══ T14 · node de mentira v18 en el PATH → bootstrap.js sale 2 antes de nada y el respaldo corre ═══════════════════
harness_lab_fake_node 18.0.0
harness_lab_publish tree "tree v7"; harness_lab_publish skills "skills v7"
T_REMOTE="$(remote_head "$LAB_REMOTE_TREE")"; S_REMOTE="$(remote_head "$LAB_REMOTE_SKILLS")"
: > "$FAKE_LOG"; A0="$(applier_runs)"
PATH="$LAB_BIN:$PATH" node "$HDIR/bootstrap.js" >/dev/null 2>"$BASE/bs.err"; rc=$?
[ "$rc" -eq 2 ] && ok "T14 · con node v18 bootstrap.js sale 2" || bad "T14 · con node v18 salió $rc"
grep -q "18.0.0" "$BASE/bs.err" && grep -q "20" "$BASE/bs.err" && [ "$(wc -l < "$BASE/bs.err" | tr -d ' ')" = "1" ] && ok "T14 · …con UNA línea que dice la versión y el piso" || bad "T14 · el aviso de Node: $(cat "$BASE/bs.err")"
[ ! -s "$FAKE_LOG" ] && ok "T14 · …sin cargar harness.js" || bad "T14 · con node v18 cargó harness.js"
PATH="$LAB_BIN:$PATH" bash -c "$NEW_LINE" >"$BASE/line.out" 2>"$BASE/line.err"; rc=$?
[ "$rc" -eq 0 ] && ok "T14 · con node v18 la línea sale 0 por el respaldo" || bad "T14 · con node v18 la línea salió $rc"
[ "$(head_of "$LAB_TREE")" = "$T_REMOTE" ] && [ "$(head_of "$LAB_SKILLS")" = "$S_REMOTE" ] && [ "$(applier_runs)" = "$((A0 + 1))" ] && ok "T14 · con node v18 el respaldo avanzó los dos repos y corrió el aplicador" || bad "T14 · con node v18 el respaldo no hizo su trabajo"
grep -q "18.0.0" "$HDIR/startup.log" && ok "T14 · startup.log dice la versión de Node" || bad "T14 · startup.log no dice la versión: $(tail -1 "$HDIR/startup.log")"
[ "$(fixed_hash)" = "$H0" ] && ok "T14 · la copia fija sigue igual tras todos los respaldos" || bad "T14 · la copia fija cambió"

# ═══ T11 · estado developer con el árbol borrado → vuelve solo a managed sobre tree_before, re-apunta el enlace ══════
GONE="$LAB/clones/developer-gone"
mkdir -p "$GONE/scripts/setup"; rm "$LINK"; ln -s "$GONE" "$LINK"; rm -rf "$GONE"
write_state developer "$GONE" "$LAB_TREE"
: > "$FAKE_LOG"
node "$HDIR/bootstrap.js" >"$BASE/bs.out" 2>"$BASE/bs.err"; rc=$?
[ "$rc" -eq 0 ] && ok "T11 · developer con el árbol borrado: bootstrap.js sale 0 (arrancó por tree_before)" || bad "T11 · salió $rc: $(cat "$BASE/bs.err")"
[ "$(state_field mode)" = "managed" ] && ok "T11 · el estado volvió a managed" || bad "T11 · mode=$(state_field mode)"
[ "$(state_field tree)" = "$LAB_TREE" ] && ok "T11 · tree = tree_before" || bad "T11 · tree=$(state_field tree)"
[ -z "$(state_field tree_before)" ] && ok "T11 · tree_before quedó vacío" || bad "T11 · tree_before=$(state_field tree_before)"
[ "$(cd -P "$LINK" 2>/dev/null && pwd -P)" = "$(cd -P "$LAB_TREE" && pwd -P)" ] && ok "T11 · el enlace apunta a tree_before" || bad "T11 · el enlace apunta a $(readlink "$LINK")"
grep -qi "developer\|desarrollador" <<<"$(state_field notice)" && ok "T11 · notice explica la vuelta a managed" || bad "T11 · notice: «$(state_field notice)»"
grep -q '^argv=startup ' "$FAKE_LOG" && ok "T11 · y la sesión arrancó por harness.js de tree_before" || bad "T11 · harness.js no corrió tras la vuelta"
[ ! -d "$HDIR/harness.lock" ] && ok "T11 · el candado quedó suelto" || bad "T11 · harness.lock quedó tomado"
[ "$(state_field schema)" = "1" ] && ok "T11 · el resto del estado se conservó (schema)" || bad "T11 · el estado perdió campos"
# otra sesión tiene el candado → no vuelve, sale ≠ 0 y el estado queda como estaba (lo hará la sesión siguiente)
rm "$LINK"; ln -s "$GONE" "$LINK"; write_state developer "$GONE" "$LAB_TREE"
# (story 8.23, AC 37: «otra sesión» es un proceso VIVO —esta misma prueba—; el de uno muerto se pisa, abajo)
mkdir -p "$HDIR/harness.lock"; echo $$ > "$HDIR/harness.lock/pid"
node "$HDIR/bootstrap.js" >/dev/null 2>&1; rc=$?
[ "$rc" -ne 0 ] && [ "$(state_field mode)" = "developer" ] && ok "T11 · con el candado tomado no vuelve: sale ≠ 0 y el estado no cambia" || bad "T11 · con el candado tomado: rc=$rc mode=$(state_field mode)"
rm -rf "$HDIR/harness.lock"
# T38 · el candado fresco de un proceso que YA NO EXISTE se pisa en el acto: vuelve a managed sin esperar 10 minutos
DEAD_PID="$(node -e 'process.stdout.write(String(process.pid))')"
mkdir -p "$HDIR/harness.lock"; printf '%s\n%s\n' "$DEAD_PID" "$(node -e 'process.stdout.write(require("os").hostname())')" > "$HDIR/harness.lock/pid"
node "$HDIR/bootstrap.js" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && [ "$(state_field mode)" = "managed" ] && ok "T38 · candado de un proceso muerto: bootstrap.js lo pisa y vuelve a managed" || bad "T38 · candado de un proceso muerto: rc=$rc mode=$(state_field mode)"
grep -q 'ya no existe' "$HDIR/startup.log" && ok "T38 · el registro dice que lo pisó" || bad "T38 · el registro no dice que pisó el candado"
[ ! -d "$HDIR/harness.lock" ] && ok "T38 · y lo soltó al terminar" || bad "T38 · harness.lock quedó tomado"
rm -rf "$HDIR/harness.lock"; rm "$LINK"; ln -s "$GONE" "$LINK"; write_state developer "$GONE" "$LAB_TREE"
# sin tree_before no hay a dónde volver: sale ≠ 0 (la línea cae al respaldo)
write_state developer "$GONE" null
node "$HDIR/bootstrap.js" >/dev/null 2>"$BASE/bs.err"; rc=$?
[ "$rc" -ne 0 ] && [ "$(state_field mode)" = "developer" ] && ok "T11 · developer sin tree_before: sale ≠ 0 y no inventa un árbol" || bad "T11 · sin tree_before: rc=$rc mode=$(state_field mode)"
rm "$LINK"; ln -s "$LAB_TREE" "$LINK"

# ═══ Regresiones de la iteración 1 (pase adversarial, 2026-10-02) ════════════════════════════════════════════════════
# REG-D8 · la vuelta sola a managed también corrige la fuente harness (sources[].dir): si no, update quedaba mirando el
# clon borrado y la máquina no se actualizaba nunca más (clase 26)
rm "$LINK"; ln -s "$GONE" "$LINK"; write_state developer "$GONE" "$LAB_TREE"
node -e 'const f=process.argv[1];const s=JSON.parse(require("fs").readFileSync(f,"utf8"));s.sources[0].dir=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(s))' "$STATE" "$GONE"
node "$HDIR/bootstrap.js" >/dev/null 2>&1
DIR_H="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(s.sources[0].dir))' "$STATE")"
[ "$DIR_H" = "$LAB_TREE" ] && ok "REG-D8 · la vuelta a managed apunta la fuente harness a tree_before" || bad "REG-D8 · sources[harness].dir quedó en $DIR_H"
rm "$LINK"; ln -s "$LAB_TREE" "$LINK"
# REG-W4 · el respaldo en shell NO toca el git del clon en modo developer (sólo corre el aplicador): el dev con
# harness.js roto a medio editar no puede terminar con su HEAD movido ni su trabajo en un autostash (clase 18)
DEVC="$LAB/clones/dev-propio"; harness_lab_git "$LAB/clones" clone -q "$LAB_REMOTE_TREE" "$DEVC" >/dev/null 2>&1
printf 'a medio editar\n' >> "$DEVC/README.md"
harness_lab_publish tree "una versión nueva que el respaldo NO debe traer en developer"
rm "$LINK"; ln -s "$DEVC" "$LINK"; write_state developer "$DEVC" "$LAB_TREE"
H_ANTES="$(head_of "$DEVC")"; N0="$(applier_runs)"
bash "$HDIR/bootstrap-fallback.sh" >/dev/null 2>&1
[ "$(head_of "$DEVC")" = "$H_ANTES" ] && grep -q 'a medio editar' "$DEVC/README.md" && [ -z "$(harness_lab_git "$DEVC" stash list)" ] && ok "REG-W4 · en developer el respaldo no hizo pull ni autostash" || bad "REG-W4 · el respaldo tocó el clon del dev (HEAD $(head_of "$DEVC") vs $H_ANTES; stash: $(harness_lab_git "$DEVC" stash list))"
[ "$(applier_runs)" -gt "$N0" ] && ok "REG-W4 · …y sí corrió el aplicador" || bad "REG-W4 · el aplicador no corrió"
rm "$LINK"; ln -s "$LAB_TREE" "$LINK"; write_state managed "$LAB_TREE" null

# ═══ T24/T26 (tanda C, decisión 7 del dueño) · rollback y uninstall corren el PROGRAMA de la copia fija ══════════════
# La copia fija suma `program/harness.js` y `program/harness/*.js` (la última versión que pasó la salud): `bootstrap.js
# rollback|uninstall` corre ESA, no la del árbol —que puede estar rota, o no estar—; `startup` sigue corriendo la del árbol.
fake_program() { # el harness.js FALSO de la copia fija: anota «program argv=…» y sale 0
  mkdir -p "$HDIR/program/harness"
  printf '%s\n' "'use strict';" "// harness.js FALSO de la copia fija (harness-bootstrap.test.sh)" \
    "require('fs').appendFileSync(require('path').join(require('os').homedir(), '.claude', '.tycon-pipeline', 'fake-harness.log'), 'program argv=' + process.argv.slice(2).join(' ') + '\n');" \
    "process.exit(0);" > "$HDIR/program/harness.js"
}
publish_harness syntax "un harness.js del árbol roto (rollback y uninstall no lo necesitan)"; pull_tree
fake_program; : > "$FAKE_LOG"
node "$HDIR/bootstrap.js" rollback --list >/dev/null 2>"$BASE/bs.err"; rc=$?
[ "$rc" -eq 0 ] && grep -q '^program argv=rollback --list$' "$FAKE_LOG" && ok "T24 · bootstrap.js rollback corre el harness.js de la copia fija con el del árbol roto" \
  || bad "T24 · bootstrap.js rollback no corrió la copia fija (rc=$rc): $(cat "$FAKE_LOG") $(cat "$BASE/bs.err")"
: > "$FAKE_LOG"
rm "$LINK"
node "$HDIR/bootstrap.js" uninstall --dry-run >/dev/null 2>"$BASE/bs.err"; rc=$?
[ "$rc" -eq 0 ] && grep -q '^program argv=uninstall --dry-run$' "$FAKE_LOG" && ok "T26 · sin enlace ni árbol, bootstrap.js uninstall corre la copia fija" \
  || bad "T26 · bootstrap.js uninstall sin árbol no corrió la copia fija (rc=$rc): $(cat "$FAKE_LOG") $(cat "$BASE/bs.err")"
ln -s "$LAB_TREE" "$LINK"
publish_harness 0 "el árbol sano otra vez"; pull_tree; : > "$FAKE_LOG"
node "$HDIR/bootstrap.js" >/dev/null 2>&1
grep -q '^argv=startup ' "$FAKE_LOG" && ! grep -q '^program ' "$FAKE_LOG" && ok "T24 · startup sigue corriendo el harness.js del árbol (no la copia fija)" \
  || bad "T24 · startup no corrió el árbol: $(cat "$FAKE_LOG")"
rm -rf "$HDIR/program"; : > "$FAKE_LOG"
node "$HDIR/bootstrap.js" rollback --list >/dev/null 2>&1
grep -q '^argv=rollback --list ' "$FAKE_LOG" && ok "T24 · sin programa en la copia fija, rollback cae al harness.js del árbol" \
  || bad "T24 · sin programa en la copia fija, rollback no corrió el árbol: $(cat "$FAKE_LOG")"

# ═══ T35 (story 8.18, AC 34) · la guarda del respaldo: nunca avanza a una punta que no trae las skills ═══════════════
# El respaldo hace `git pull` por su cuenta. Si `main` vuelve a un árbol de antes de la unión de los dos repos, el clon del
# que salen las skills (~/.claude/agent-skills: el clon viejo, re-apuntado o no, o el único árbol) se quedaría sin ellas:
# el respaldo mira lo traído ANTES de su pull y, si no trae skills/tycon-pipeline, no mueve NINGUNO de los dos clones.
GUARDA="la versión nueva no trae las skills: no se aplica"
for needle in "ls-tree -d --name-only" "skills/tycon-pipeline" "$GUARDA" "no pude mirar" "fetch --quiet"; do
  grep -q -- "$needle" "$SRC/bootstrap-fallback.ps1" && ok "T35 · bootstrap-fallback.ps1 (por lectura): la guarda trae «${needle}»" || bad "T35 · bootstrap-fallback.ps1 no trae «${needle}»"
done
publish_harness 0 "el árbol sano, para la guarda"; pull_tree; write_state managed "$LAB_TREE" null
harness_lab_git "$LAB_AUTHOR_SKILLS" pull -q --ff-only origin main >/dev/null 2>&1
harness_lab_git "$LAB_AUTHOR_SKILLS" rm -r -q skills >/dev/null 2>&1 && harness_lab_git "$LAB_AUTHOR_SKILLS" commit -q -m "retorno: una punta sin skills/" >/dev/null 2>&1 \
  && harness_lab_git "$LAB_AUTHOR_SKILLS" push -q origin main >/dev/null 2>&1 || bad "T35 · no pude publicar la punta sin skills"
harness_lab_publish tree "una versión del arnés que tampoco se trae mientras la guarda frene"
T_ANTES="$(head_of "$LAB_TREE")"; S_ANTES="$(head_of "$LAB_SKILLS")"; A0="$(applier_runs)"
[ "$T_ANTES" != "$(remote_head "$LAB_REMOTE_TREE")" ] && [ "$S_ANTES" != "$(remote_head "$LAB_REMOTE_SKILLS")" ] || bad "T35 · precondición: no hay nada nuevo que traer"
bash "$HDIR/bootstrap-fallback.sh" >"$BASE/guard.out" 2>&1; rc=$?
[ "$rc" -eq 0 ] && [ -z "$(cat "$BASE/guard.out")" ] && ok "T35 · con una punta sin skills el respaldo sale 0 y callado" || bad "T35 · el respaldo salió $rc o habló: $(cat "$BASE/guard.out")"
[ "$(head_of "$LAB_SKILLS")" = "$S_ANTES" ] && [ -d "$LAB_SKILLS/skills/tycon-pipeline" ] && ok "T35 · el clon de las skills NO avanzó a la punta sin skills, y las skills siguen" || bad "T35 · el clon de las skills avanzó (o se quedó sin skills): $(head_of "$LAB_SKILLS") vs $S_ANTES"
[ "$(head_of "$LAB_TREE")" = "$T_ANTES" ] && ok "T35 · …y el clon del arnés tampoco se movió (ninguna fuente se mueve)" || bad "T35 · el arnés avanzó solo: $(head_of "$LAB_TREE") vs $T_ANTES"
[ "$(applier_runs)" = "$((A0 + 1))" ] && ok "T35 · el aplicador corrió igual, con lo que hay" || bad "T35 · el aplicador no corrió"
grep -q "$GUARDA" <<<"$(tail -1 "$HDIR/startup.log")" && grep -q "$GUARDA" <<<"$(state_field notice)" && ok "T35 · startup.log y el aviso lo dicen" || bad "T35 · no lo dice: $(tail -1 "$HDIR/startup.log") · aviso «$(state_field notice)»"
# espejo: una punta que SÍ trae las skills se trae, y el arnés con ella
mkdir -p "$LAB_AUTHOR_SKILLS/skills/tycon-pipeline"; printf '# la skill, de vuelta\n' > "$LAB_AUTHOR_SKILLS/skills/tycon-pipeline/SKILL.md"
harness_lab_git "$LAB_AUTHOR_SKILLS" add -A >/dev/null && harness_lab_git "$LAB_AUTHOR_SKILLS" commit -q -m "las skills, de vuelta" >/dev/null && harness_lab_git "$LAB_AUTHOR_SKILLS" push -q origin main >/dev/null 2>&1
bash "$HDIR/bootstrap-fallback.sh" >/dev/null 2>&1
[ "$(head_of "$LAB_SKILLS")" = "$(remote_head "$LAB_REMOTE_SKILLS")" ] && [ "$(head_of "$LAB_TREE")" = "$(remote_head "$LAB_REMOTE_TREE")" ] \
  && ok "T35 · espejo: con una punta que trae las skills el respaldo avanza los dos clones" || bad "T35 · espejo: los clones no avanzaron"
[ "$(fixed_hash)" = "$H0" ] && ok "T35 · la copia fija sigue igual" || bad "T35 · la copia fija cambió"

# ─── T35 · «no pude mirar» no es «no trae las skills» (tramo 3 · revisor de fallos silenciosos, 2026-10-04) ─────────────
# La guarda preguntaba con `git cat-file -e <commit>:skills/tycon-pipeline`, que contesta lo mismo (≠ 0) si el árbol no
# trae la carpeta que si git no pudo leerlo (un objeto que falta, un candado, un tiempo agotado). Con el árbol de HEAD sin
# leer, el respaldo entendía «de este clon no salen las skills» y hacía el pull: a una punta sin skills. Con el de lo
# traído sin leer frenaba —bien—, pero diciendo «no trae las skills», que no era cierto. Ahora son tres respuestas: trae ·
# no trae · no pude mirar; con «no pude mirar» no se mueve NINGÚN clon y la línea lo dice con su causa.
# Cómo se mide: un `git` de laboratorio delante del PATH que falla (128) sólo cuando le preguntan por el árbol de UN
# commit (LAB_GIT_BLIND); todo lo demás va al git de verdad. Los dos respaldos por EJECUCIÓN: el .sh, y el .ps1 con pwsh
# si hay (en el laboratorio el árbol no trae install-tycon-hooks.ps1: el .ps1 sólo tiene el clon de las skills para mover).
REAL_GIT="$(command -v git)"; mkdir -p "$BASE/blind-bin"
cat > "$BASE/blind-bin/git" <<EOF
#!/bin/sh
# git de laboratorio (harness-bootstrap.test.sh): «no puedo leer el árbol» de \$LAB_GIT_BLIND; lo demás, al git de verdad
if [ -n "\${LAB_GIT_BLIND:-}" ]; then
  case " \$* " in
    *" ls-tree "*"\$LAB_GIT_BLIND^{tree}"*|*" cat-file "*"\$LAB_GIT_BLIND:"*) echo "fatal: unable to read tree (laboratorio)" >&2; exit 128 ;;
  esac
fi
# LAB_GIT_UPSTREAM_FAIL=1: «¿a qué commit avanzaría?» (rev-parse de @{upstream}) no contesta: ni «no hay rama» (1) ni un sha
if [ "\${LAB_GIT_UPSTREAM_FAIL:-}" = 1 ]; then
  case " \$* " in *" rev-parse "*"@{upstream}"*) echo "fatal: no pude leer la rama de la que traer (laboratorio)" >&2; exit 128 ;; esac
fi
# LAB_GIT_NET_WITNESS=<archivo>: anota con qué ambiente se sale a la red (story 8.23, tanda L: nunca un login invisible)
if [ -n "\${LAB_GIT_NET_WITNESS:-}" ]; then
  case " \$* " in *" fetch "*|*" pull "*) printf 'GCM_INTERACTIVE=%s GIT_TERMINAL_PROMPT=%s\n' "\${GCM_INTERACTIVE:-}" "\${GIT_TERMINAL_PROMPT:-}" >> "\$LAB_GIT_NET_WITNESS" ;; esac
fi
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$BASE/blind-bin/git"
run_fallback() { # run_fallback sh|ps1 [VAR=valor…]: el respaldo de la copia fija, con el git de laboratorio delante del PATH
  local impl="$1"; shift
  [ -n "${LAB_HOME:-}" ] && [ "$HOME" = "$LAB_HOME" ] || { bad "T35 · la HOME no es la de juguete (${HOME}): no corro el respaldo"; return 1; }
  if [ "$impl" = ps1 ]; then
    env "$@" PATH="$BASE/blind-bin:$PATH" TYCON_NO_AUTOINSTALL=1 XDG_CACHE_HOME="$BASE/xdg/cache" XDG_DATA_HOME="$BASE/xdg/data" XDG_CONFIG_HOME="$BASE/xdg/config" \
      POWERSHELL_TELEMETRY_OPTOUT=1 POWERSHELL_UPDATECHECK=Off pwsh -NoProfile -NonInteractive -File "$HDIR/bootstrap-fallback.ps1" >/dev/null 2>&1
  else
    env "$@" PATH="$BASE/blind-bin:$PATH" bash "$HDIR/bootstrap-fallback.sh" >/dev/null 2>&1
  fi
}
skills_tip_without() { # una punta del repo de las skills SIN skills/
  harness_lab_git "$LAB_AUTHOR_SKILLS" pull -q --ff-only origin main >/dev/null 2>&1
  harness_lab_git "$LAB_AUTHOR_SKILLS" rm -r -q skills >/dev/null 2>&1 && harness_lab_git "$LAB_AUTHOR_SKILLS" commit -q -m "retorno: una punta sin skills/ ($1)" >/dev/null 2>&1 \
    && harness_lab_git "$LAB_AUTHOR_SKILLS" push -q origin main >/dev/null 2>&1
}
skills_tip_with() { # una punta del repo de las skills que SÍ las trae
  mkdir -p "$LAB_AUTHOR_SKILLS/skills/tycon-pipeline" && printf '# la skill, de vuelta (%s)\n' "$1" > "$LAB_AUTHOR_SKILLS/skills/tycon-pipeline/SKILL.md" \
    && harness_lab_git "$LAB_AUTHOR_SKILLS" add -A >/dev/null && harness_lab_git "$LAB_AUTHOR_SKILLS" commit -q -m "las skills, de vuelta ($1)" >/dev/null \
    && harness_lab_git "$LAB_AUTHOR_SKILLS" push -q origin main >/dev/null 2>&1
}
last_line() { tail -1 "$HDIR/startup.log" 2>/dev/null; }
for impl in sh ps1; do
  if [ "$impl" = ps1 ] && ! command -v pwsh >/dev/null 2>&1; then echo "⏭ harness-bootstrap: NO MEDIDO — T35 «no pude mirar» en bootstrap-fallback.ps1 por ejecución: no hay pwsh en esta máquina"; continue; fi
  F="bootstrap-fallback.$impl"
  # los dos clones al día; después, una punta SIN skills y una versión nueva del arnés
  harness_lab_git "$LAB_SKILLS" pull -q --ff-only origin main >/dev/null 2>&1; pull_tree
  skills_tip_without "$impl" || bad "T35 · $F: no pude publicar la punta sin skills"
  harness_lab_publish tree "una versión del arnés que no se trae si no se pudo mirar ($impl)"
  S_ANTES="$(head_of "$LAB_SKILLS")"; T_ANTES="$(head_of "$LAB_TREE")"
  [ -d "$LAB_SKILLS/skills/tycon-pipeline" ] && [ "$S_ANTES" != "$(remote_head "$LAB_REMOTE_SKILLS")" ] || bad "T35 · $F: precondición — el clon de las skills tiene que traerlas y estar atrás de lo publicado"
  # (1) el árbol de HEAD no se puede leer: no se sabe si de este clon salen las skills → no se mueve nada
  run_fallback "$impl" LAB_GIT_BLIND=HEAD; rc=$?
  [ "$rc" -eq 0 ] && [ "$(head_of "$LAB_SKILLS")" = "$S_ANTES" ] && [ -d "$LAB_SKILLS/skills/tycon-pipeline" ] && [ "$(head_of "$LAB_TREE")" = "$T_ANTES" ] \
    && ok "T35 · $F: sin poder leer el árbol de HEAD no avanza el clon de las skills (ni el del arnés), y las skills siguen" \
    || bad "T35 · $F: sin poder leer el árbol de HEAD (rc $rc) el clon de las skills quedó en $(head_of "$LAB_SKILLS") (estaba en ${S_ANTES}); skills/: $([ -d "$LAB_SKILLS/skills/tycon-pipeline" ] && echo siguen || echo SE FUERON)"
  case "$(last_line)" in *"no pude mirar"*"HEAD"*) SAID=1 ;; *) SAID=0 ;; esac
  [ "$SAID" = 1 ] && ! grep -q "$GUARDA" <<<"$(last_line)" && ok "T35 · $F: …y startup.log lo dice con su causa (no pudo mirar el árbol de HEAD), sin decir «no trae las skills»" \
    || bad "T35 · $F: sin poder leer HEAD la línea fue: $(last_line)"
  harness_lab_git "$LAB_SKILLS" reset -q --hard "$S_ANTES" >/dev/null 2>&1   # si avanzó (el rojo de antes), vuelve para lo que sigue
  # (2) lo publicado SÍ trae las skills, pero su árbol no se puede leer: tampoco se mueve, y no se dice «no las trae»
  skills_tip_with "$impl" || bad "T35 · $F: no pude publicar la punta con skills"
  TIP="$(remote_head "$LAB_REMOTE_SKILLS")"
  run_fallback "$impl" "LAB_GIT_BLIND=$TIP"; rc=$?
  case "$(last_line)" in *"no pude mirar"*) SAID=1 ;; *) SAID=0 ;; esac
  [ "$rc" -eq 0 ] && [ "$(head_of "$LAB_SKILLS")" = "$S_ANTES" ] && [ "$(head_of "$LAB_TREE")" = "$T_ANTES" ] && [ "$SAID" = 1 ] && ! grep -q "$GUARDA" <<<"$(last_line)" \
    && ok "T35 · $F: sin poder leer el árbol de lo traído no se mueve ningún clon, y dice que no pudo mirar (no que «no trae las skills»)" \
    || bad "T35 · $F: sin poder leer lo traído (rc $rc): skills $(head_of "$LAB_SKILLS") vs ${S_ANTES} — $(last_line)"
  [ "$impl" = sh ] && { grep -q 'no pude mirar' <<<"$(state_field notice)" && ok "T35 · $F: …y el aviso del estado también lo dice" || bad "T35 · $F: el aviso del estado no lo dice: «$(state_field notice)»"; }
  # (3) la tercera puerta (tercera vuelta del revisor de pruebas): git no contesta a qué commit avanzaría el clon (ni «no
  #     hay rama de la que traer», que sale 1 y callado, ni un sha). Tampoco se mueve ningún clon, y se dice
  run_fallback "$impl" LAB_GIT_UPSTREAM_FAIL=1; rc=$?
  case "$(last_line)" in *"no pude mirar a qué versión avanzaría"*) SAID=1 ;; *) SAID=0 ;; esac
  [ "$rc" -eq 0 ] && [ "$(head_of "$LAB_SKILLS")" = "$S_ANTES" ] && [ "$(head_of "$LAB_TREE")" = "$T_ANTES" ] && [ "$SAID" = 1 ] && ! grep -q "$GUARDA" <<<"$(last_line)" \
    && ok "T35 · $F: sin poder mirar a qué versión avanzaría no se mueve ningún clon, y dice que no pudo mirar" \
    || bad "T35 · $F: sin poder mirar a qué versión avanzaría (rc $rc): skills $(head_of "$LAB_SKILLS") vs ${S_ANTES}, arnés $(head_of "$LAB_TREE") vs ${T_ANTES} — $(last_line)"
  # (espejo) el mismo git, ya pudiendo leer: lo traído trae las skills → avanza
  : > "$BASE/net-$impl.log"
  run_fallback "$impl" "LAB_GIT_NET_WITNESS=$BASE/net-$impl.log"; rc=$?
  [ "$rc" -eq 0 ] && [ "$(head_of "$LAB_SKILLS")" = "$TIP" ] && ok "T35 · $F: espejo — pudiendo mirar, y con las skills en lo traído, avanza" \
    || bad "T35 · $F: espejo — no avanzó (rc $rc): $(head_of "$LAB_SKILLS") vs ${TIP} — $(last_line)"
  # T39 (story 8.23, tanda L · AC 38): el respaldo sale a la red sin poder abrir un login (ni la terminal ni el gestor)
  if [ -s "$BASE/net-$impl.log" ] && ! grep -v -q '^GCM_INTERACTIVE=never GIT_TERMINAL_PROMPT=0$' "$BASE/net-$impl.log"; then ok "T39 · $F: sus $(wc -l < "$BASE/net-$impl.log" | tr -d ' ') salidas a la red corren con GCM_INTERACTIVE=never y GIT_TERMINAL_PROMPT=0"
  else bad "T39 · $F: una salida a la red pudo preguntar: $(sort -u "$BASE/net-$impl.log" 2>/dev/null | head -3)"; fi
done
[ "$(fixed_hash)" = "$H0" ] && ok "T35 · la copia fija sigue igual después de las corridas sin poder mirar" || bad "T35 · la copia fija cambió"

# la máquina de UN SOLO árbol (~/.claude/agent-skills es un enlace al clon del arnés): el árbol no avanza a la punta sin skills
harness_lab_single_tree "$BASE/lab-single" >/dev/null || bad "T35 · no pude armar la máquina de un solo árbol"
PIPE="$LAB_HOME/.claude/.tycon-pipeline"; HDIR="$PIPE/harness"; STATE="$PIPE/harness-state.json"; APPLIER_LOG="$PIPE/lab-applier.log"
install_fixed_copy; write_state managed "$LAB_TREE" null
harness_lab_publish_without_skills || bad "T35 · no pude publicar la punta sin skills (un árbol)"
T_ANTES="$(head_of "$LAB_TREE")"
bash "$HDIR/bootstrap-fallback.sh" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && [ "$(head_of "$LAB_TREE")" = "$T_ANTES" ] && [ -d "$LAB_HOME/.claude/skills/tycon-pipeline" ] && grep -q "$GUARDA" "$HDIR/startup.log" \
  && ok "T35 · un solo árbol: el respaldo no avanza a la punta sin skills, las skills siguen y lo dice" || bad "T35 · un solo árbol: rc $rc, head $(head_of "$LAB_TREE") vs $T_ANTES: $(tail -1 "$HDIR/startup.log" 2>/dev/null)"
# espejo: la máquina de DOS clones sin re-apuntar — el arnés sí sigue a main (el retorno de antes de la llave)
harness_lab_team_machine "$BASE/lab-team" toy >/dev/null && harness_lab_cut && harness_lab_pull_tree || bad "T35 · no pude armar la máquina de dos clones"
PIPE="$LAB_HOME/.claude/.tycon-pipeline"; HDIR="$PIPE/harness"; STATE="$PIPE/harness-state.json"; APPLIER_LOG="$PIPE/lab-applier.log"
install_fixed_copy; write_state managed "$LAB_TREE" null
harness_lab_publish_without_skills || bad "T35 · no pude publicar la punta sin skills (dos clones)"
bash "$HDIR/bootstrap-fallback.sh" >/dev/null 2>&1
[ "$(head_of "$LAB_TREE")" = "$(remote_head "$LAB_REMOTE_TREE")" ] && [ "$(head_of "$LAB_SKILLS")" = "$LAB_COMMIT_SKILLS" ] && [ -d "$LAB_HOME/.claude/skills/tycon-pipeline" ] \
  && ok "T35 · espejo: con dos clones sin re-apuntar el arnés sigue a main y las skills siguen en el clon viejo" || bad "T35 · espejo dos clones: arnés $(head_of "$LAB_TREE") vs $(remote_head "$LAB_REMOTE_TREE")"

# ═══ story 8.19 · T10: la copia fija de antes y la de ahora, con los dos nombres del lugar ═══════════════════════════
# La copia fija de ANTES de la tanda A (congelada en fixtures/bootstrap-legacy-place.js) conoce sólo el nombre viejo: una
# máquina que no se actualizó la sigue corriendo. Con el código nuevo tiene que seguir arrancando por el viejo (que
# resuelve, y desde la 8.19 apunta al lugar); la copia nueva prueba primero el lugar y después el viejo; y con la salud
# roja y el árbol de vuelta al código anterior (es decir: la copia vieja otra vez), ese código encuentra el viejo y arranca.
harness_lab_create "$BASE/lab-t10" || bad "T10 · no pude armar el laboratorio"
PIPE="$LAB_HOME/.claude/.tycon-pipeline"; HDIR="$PIPE/harness"; STATE="$PIPE/harness-state.json"; FAKE_LOG="$PIPE/fake-harness.log"
PLACE_NAME="$(node -e 'process.stdout.write(require(process.argv[1]).PLACE_NAME)' "$SRC/place.js")"
LEGACY_NAME="$(node -e 'process.stdout.write(require(process.argv[1]).LEGACY_PLACE_NAME)' "$SRC/place.js")"
P_LINK="$LAB_HOME/.claude/$PLACE_NAME"; V_LINK="$LAB_HOME/.claude/$LEGACY_NAME"
write_state managed "$LAB_TREE" null
publish_harness 0 "t10: harness.js falso que sale 0"; pull_tree
OLD_COPY="$RAIZ/scripts/tests/fixtures/bootstrap-legacy-place.js"
mkdir -p "$HDIR"
# (1) la copia vieja, con el lugar → árbol y el viejo → el lugar (lo que deja la 8.19): arranca por el viejo
ln -s "$LAB_TREE" "$P_LINK"; ln -s "$P_LINK" "$V_LINK"
cp "$OLD_COPY" "$HDIR/bootstrap.js"; : > "$FAKE_LOG"
node "$HDIR/bootstrap.js" startup >/dev/null 2>"$BASE/t10.err"; rc=$?
[ "$rc" -eq 0 ] && grep -q '^argv=startup ' "$FAKE_LOG" && ok "T10 · la copia fija VIEJA arranca por el nombre viejo, que pasa por el lugar" || bad "T10 · la copia vieja no arrancó (rc $rc): $(cat "$BASE/t10.err")"
# (2) la copia nueva: primero el lugar
cp "$SRC/bootstrap.js" "$HDIR/bootstrap.js"; : > "$FAKE_LOG"
node "$HDIR/bootstrap.js" startup >/dev/null 2>"$BASE/t10.err"; rc=$?
[ "$rc" -eq 0 ] && grep -q '^argv=startup ' "$FAKE_LOG" && ok "T10 · la copia nueva arranca con los dos nombres" || bad "T10 · la copia nueva no arrancó con los dos (rc $rc): $(cat "$BASE/t10.err")"
# (3) la copia nueva con sólo el viejo (el lugar todavía no nació): arranca por el viejo, sin decir nada
rm "$P_LINK" "$V_LINK"; ln -s "$LAB_TREE" "$V_LINK"; : > "$FAKE_LOG"
node "$HDIR/bootstrap.js" startup >/dev/null 2>"$BASE/t10.err"; rc=$?
[ "$rc" -eq 0 ] && grep -q '^argv=startup ' "$FAKE_LOG" && [ ! -s "$BASE/t10.err" ] && ok "T10 · la copia nueva, con sólo el viejo, arranca por él y no dice nada" || bad "T10 · con sólo el viejo (rc $rc): $(cat "$BASE/t10.err")"
# (4) la copia nueva con sólo el lugar (una máquina de afuera): arranca
rm "$V_LINK"; ln -s "$LAB_TREE" "$P_LINK"; : > "$FAKE_LOG"
node "$HDIR/bootstrap.js" startup >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && grep -q '^argv=startup ' "$FAKE_LOG" && ok "T10 · la copia nueva, con sólo el lugar, arranca" || bad "T10 · con sólo el lugar salió $rc"
# (5) ninguno: sale ≠ 0, nombra el lugar y NO nombra el viejo (no existe en esta máquina)
rm "$P_LINK"
node "$HDIR/bootstrap.js" startup >/dev/null 2>"$BASE/t10.err"; rc=$?
[ "$rc" -ne 0 ] && grep -q "$PLACE_NAME" "$BASE/t10.err" && ! grep -q "$LEGACY_NAME" "$BASE/t10.err" && ok "T10 · sin ninguno: sale ≠ 0, nombra el lugar y no el viejo" || bad "T10 · sin ninguno (rc $rc): $(cat "$BASE/t10.err")"
# (6) la salud roja y el árbol de vuelta: la copia fija vuelve a ser la vieja; con los dos nombres como los deja la 8.19,
#     ese código encuentra el viejo y arranca
ln -s "$LAB_TREE" "$P_LINK"; ln -s "$P_LINK" "$V_LINK"; cp "$OLD_COPY" "$HDIR/bootstrap.js"; : > "$FAKE_LOG"
node "$HDIR/bootstrap.js" startup >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && grep -q '^argv=startup ' "$FAKE_LOG" && ok "T10 · (error) salud roja y el código anterior: encuentra el viejo y arranca" || bad "T10 · el código anterior no arrancó (rc $rc)"

# ─── T23 de la story 8.39 · Bootstrap_CurrentSanoOQueNoContesta ────────────────────────────────────────────────────────
# @story-8.39 @ac-8 @ac-16  bootstrap.js lanza harness.js con el Node del arnés (`<casa>/node/current`) sólo si su
# `--version` contesta en 5 s con n ≥ 20; si sale 1 o se cuelga, con el node que corre la copia fija, y el respaldo NO
# corre (un current roto no puede hacer volver atrás una versión sana). El Node de juguete es un GUION que anota su uso y
# llama al node real por su ruta absoluta: nunca un enlace a un binario real.
publish_harness 0 "t23: harness.js falso que sale 0"; pull_tree
install_fixed_copy; write_state managed "$LAB_TREE" null
N23="$LAB_HOME/.tycon/node"; mkdir -p "$N23/versions/v24.21.0/bin"; ln -s versions/v24.21.0 "$N23/current"
USO23="$BASE/uso-node-arnes.log"
nodo23() { # nodo23 healthy|fails|timeout  (sano · sale 1 · se cuelga)
  case "$1" in
    healthy) printf '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v24.21.0; exit 0; fi\necho usado >> "%s"\nexec "%s" "$@"\n' "$USO23" "$(command -v node)" ;;
    fails) printf '#!/bin/sh\necho roto >&2\nexit 1\n' ;;
    timeout) printf '#!/bin/sh\nsleep 30\n' ;;
  esac > "$N23/versions/v24.21.0/bin/node"
  chmod +x "$N23/versions/v24.21.0/bin/node"
}
nodo23 healthy; : > "$USO23"; : > "$FAKE_LOG"
TYCON_HARNESS_NODE=1 node "$HDIR/bootstrap.js" startup >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && [ -s "$USO23" ] && grep -q '^argv=startup ' "$FAKE_LOG" && ok "T23 · current sano: harness.js corre con el Node del arnés" || bad "T23 · current sano: rc $rc, uso $(wc -l < "$USO23" | tr -d ' ')"
for caso in fails timeout; do
  nodo23 "$caso"; : > "$FAKE_LOG"; t0=$SECONDS
  TYCON_HARNESS_NODE=1 node "$HDIR/bootstrap.js" startup >/dev/null 2>&1; rc=$?; dt=$(( SECONDS - t0 ))
  if [ "$rc" -eq 0 ] && grep -q '^argv=startup ' "$FAKE_LOG" && [ "$dt" -lt 7 ] && ! grep -q 'respaldo en shell' "$FAKE_LOG"; then ok "T23 · current que $caso: harness.js con el node de la copia fija, en ${dt} s, sin el respaldo"
  else bad "T23 · current que $caso: rc $rc en ${dt} s"; fi
done
grep -q 'el Node del arnés .* no contesta bien' "$HDIR/startup.log" && ok "T23 · el registro dice que el Node del arnés no contestó" || bad "T23 · el registro no lo dice"
nodo23 healthy; : > "$USO23"; TYCON_HARNESS_NODE=0 node "$HDIR/bootstrap.js" startup >/dev/null 2>&1
[ ! -s "$USO23" ] && ok "T23 · apagado: no usa el Node del arnés" || bad "T23 · apagado: lo usó"
rm -rf "$N23"

# ─── cierre ───────────────────────────────────────────────────────────────────────────────────────────────────────────
if [ "$FALLAS" -eq 0 ]; then echo "harness-bootstrap: todo verde"; exit 0; fi
echo "harness-bootstrap: $FALLAS fallas"; exit 1
