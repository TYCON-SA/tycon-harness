#!/usr/bin/env bash
# installer-shell-matcher.test.sh — los hooks que miran comandos se registran con `Bash|PowerShell`, y una máquina ya
# instalada con el matcher viejo (`Bash`) queda con UNA entrada por guion, no con dos (2026-10-04).
#
# EL CASO. Medido en una sesión REAL de Claude Code 2.1.289 en Windows 11, con el arnés instalado y `doctor` en orden:
# Claude Code corre los comandos con su herramienta PowerShell (`tool_name: "PowerShell"`, la misma entrada
# `tool_input.command`; fuente: code.claude.com/docs/en/tools-reference §«PowerShell tool»: «Match `Bash|PowerShell` in
# hooks that inspect shell commands»). Los frenos estaban registrados con matcher `Bash` y no se disparaban: pasaron
# `git add -A` en agent-skills y un commit que saltea los hooks de git. Con «corré con Bash» el mismo freno sí frenó.
#
# LA MIGRACIÓN. El instalador compara matchers como conjuntos: `{Bash}` no es `{Bash, PowerShell}`, así que sin más
# AGREGARÍA el registro nuevo y dejaría el viejo, y en Bash el freno correría dos veces. Un guion registrado con un
# matcher MÁS ANGOSTO que el de la lista (mismo evento, mismo guion) es la misma pieza: se mueve al matcher nuevo con su
# comando tal cual, y una copia que sobre se saca. Lo ajeno que comparte el bloque viejo queda donde estaba.
#
# Qué mide (el instalador REAL, con HOME falso y todo lo que sale a la red apagado, como installer-cleanup-period):
#   1. instalación nueva: cada hook que mira comandos está UNA vez, con `Bash|PowerShell`; ninguno con `Bash` solo.
#   2. una settings.json de antes (los mismos hooks con `Bash`, y hooks ajenos en esos bloques): queda igual que (1),
#      lo ajeno sigue con `Bash`, el reporte lo dice, y `Edit|Write` de rebuild-before-verify.js no se toca.
#   3. una segunda corrida deja settings.json byte a byte igual.
#   4. el viejo y el nuevo a la vez (una máquina que volvió a una versión anterior y después avanzó): queda uno.
#   5. --check sobre la de antes: sale 0, no escribe, y nombra lo que falta con su matcher nuevo.
#   6. la de antes reinstalada por un enlace al clon: tampoco duplica.
# Lo que NO mide: el .ps1 (eso es installer-ps1.test.sh, sección v) ni Windows de verdad.
# Correr: bash scripts/tests/installer-shell-matcher.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INST="$ROOT/scripts/install-tycon-hooks.sh"
FAILURES=0
ok()  { echo "  ok   — $1"; }
bad() { echo "  MAL  — $1"; FAILURES=$((FAILURES+1)); }
command -v node >/dev/null 2>&1 || { echo "⏭ installer-shell-matcher: NO MEDIDO — no hay node"; exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "⏭ installer-shell-matcher: NO MEDIDO — no hay python3"; exit 0; }

T="$(mktemp -d)" && T="$(cd "$T" && pwd -P)"; trap 'rm -rf "$T"' EXIT
export TYCON_NO_CANONICAL_PATH=1 TYCON_NO_AZ_PROJECTS_REFRESH=1 TYCON_NO_BOOTSTRAP_HEAL=1 \
  TYCON_NO_CLAUDEMD_SYNC=1 TYCON_NO_COMMANDS_SYNC=1 TYCON_NO_ENGRAM_PROJECT_CHECK=1 \
  TYCON_NO_ENGRAM_VERSION_CHECK=1 TYCON_NO_NIGHTLY_EXAM=1 TYCON_NO_GIT_HOOKS=1 \
  TYCON_NO_GUI_ENV=1 TYCON_NO_SQLITE_CHECK=1 TYCON_NO_AGENTSMD_POINTER=1 \
  TYCON_NO_THREAD_RESCUE=1 TYCON_NO_UPLOAD_RUNS=1 TYCON_NO_DOWNLOAD_RUNS=1 TYCON_NO_COLLECT_FINDINGS=1 \
  TYCON_MAILBOX_URL_BASE=http://127.0.0.1:9
# 🔴 Nunca la HOME real ni el agent-skills real: un esqueleto con un archivo vacío por cada guion de agent-skills que la
#    lista busca (así se registran, con su matcher, los dos de agent-skills que miran comandos).
HOME="$T/home"; export HOME
SK="$HOME/.claude/agent-skills/skills"; mkdir -p "$SK/tycon-pipeline"
# los guiones de las skills que registra el arnés, de la lista única (story 8.17, W3: antes, del texto del instalador)
node -e 'for (const h of require(process.argv[1]).hooks) if (!h.spec.startsWith("@tcg:")) console.log(h.spec)' "$ROOT/scripts/setup/hooks-list.json" | sort -u | while IFS= read -r rel; do
  mkdir -p "$SK/$(dirname "$rel")" && : > "$SK/$rel"
done
# CLAUDE_CODE_PLUGIN_DIRS fuera: la pone el instalador en cada máquina con el arnés (story 7.27) y, heredada, la
# instalación de prueba anotaba la carpeta de mods DE VERDAD de quien corre la suite (harness-uninstall, 2026-10-15).
ISOLATED=(env -u CLAUDE_CODE_PLUGIN_DIRS TYCON_CODEX=0 TYCON_BENCH_DAILY=0 TYCON_STAGE_METRICS=0 CODEX_HOME="$T/codex-home")
run() { TYCON_SETTINGS_PATH="$1" "${ISOLATED[@]}" bash "$INST" "${@:2}"; }   # <settings> [args] → el instalador; exit code real

# Los hooks que miran comandos, en su evento (los de agent-skills por su ruta dentro de skills/).
cat > "$T/check.js" <<'JS'
'use strict';
// check.js <settings.json> [foreign] → una línea por problema; nada y exit 0 si cumple.
const fs = require('fs');
const [file, foreign] = process.argv.slice(2);
const WANT = {
  PreToolUse: ['safety-guard-pre.sh', 'test-scope-guard-pre.sh', 'push-phantom-ref-notice.js', 'pr-one-per-repo-guard.js',
    'pr-auto-complete-guard.js', 'tycon-pipeline/scripts/on-pre-commit.js', 'tycon-pipeline/scripts/on-bash-write-gate.js'],
  PostToolUse: ['retro-pending.js', 'unpushed-work-notice.js', 'missing-path-notice.js', 'failed-query-notice.js',
    'rebuild-before-verify.js'],
};
const norm = (m) => String(m || '').split('|').map((x) => x.trim()).filter(Boolean).sort().join('|');
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
const out = [];
const rows = [];   // { event, matcher, cmd }
for (const [event, bucket] of Object.entries(s.hooks || {})) for (const e of bucket) for (const h of e.hooks || []) rows.push({ event, matcher: norm(e.matcher), cmd: String(h.command || '') });
const ours = (cmd, rel) => /^(node|bash) "/.test(cmd) && cmd.endsWith('/' + rel + '"');
for (const [event, rels] of Object.entries(WANT)) {
  for (const rel of rels) {
    const all = rows.filter((r) => r.event === event && ours(r.cmd, rel) && r.matcher !== 'Edit|Write');
    const good = all.filter((r) => r.matcher === 'Bash|PowerShell');
    if (good.length !== 1 || all.length !== 1) out.push(`${event} ${rel}: ${good.length} con «Bash|PowerShell», ${all.length} en total (${all.map((r) => r.matcher || '*').join(', ')})`);
  }
}
// rebuild-before-verify.js también va con Edit|Write en PostToolUse: ése no se toca
const editWrite = rows.filter((r) => r.event === 'PostToolUse' && r.matcher === 'Edit|Write' && ours(r.cmd, 'rebuild-before-verify.js'));
if (editWrite.length !== 1) out.push(`PostToolUse rebuild-before-verify.js con «Edit|Write»: está ${editWrite.length} veces`);
// ningún hook del arnés con `Bash` sin `PowerShell`
for (const r of rows) if (/^(Pre|Post)ToolUse$/.test(r.event) && r.matcher.split('|').includes('Bash') && !r.matcher.split('|').includes('PowerShell') && /^(node|bash) "/.test(r.cmd)) out.push(`${r.event} con «${r.matcher}»: ${r.cmd.split('/').pop()}`);
if (foreign) {
  // lo ajeno sigue donde estaba, con su matcher
  for (const [event, cmd] of [['PreToolUse', 'echo lab-pre-bash'], ['PostToolUse', 'echo lab-post-bash']]) {
    const f = rows.filter((r) => r.event === event && r.cmd === cmd);
    if (f.length !== 1 || f[0].matcher !== 'Bash') out.push(`el hook ajeno «${cmd}» quedó ${f.length} vez/veces con «${f.map((r) => r.matcher).join(', ')}»`);
  }
}
if (out.length) { console.log(out.slice(0, 8).join(' · ')); process.exit(1); }
JS
# <settings fuente> <settings destino>: la misma configuración «de antes»: cada `Bash|PowerShell` como `Bash`, y un hook
# ajeno en el bloque `Bash` de PreToolUse y en el de PostToolUse
make_old() {
  node -e '
    const fs = require("fs"); const [src, dst] = process.argv.slice(1);
    const s = JSON.parse(fs.readFileSync(src, "utf8"));
    for (const ev of ["PreToolUse", "PostToolUse"]) for (const e of s.hooks[ev] || []) if (e.matcher === "Bash|PowerShell") {
      e.matcher = "Bash"; e.hooks.push({ type: "command", command: ev === "PreToolUse" ? "echo lab-pre-bash" : "echo lab-post-bash" });
    }
    fs.writeFileSync(dst, JSON.stringify(s, null, 2) + "\n");' "$1" "$2"
}

# 1) instalación nueva
echo '{"hooks":{}}' > "$T/fresh.json"
run "$T/fresh.json" > "$T/1.out" 2>&1; RC=$?
R="$(node "$T/check.js" "$T/fresh.json")"; CK=$?
[ "$RC" -eq 0 ] && [ "$CK" -eq 0 ] && ok "1. instalación nueva: cada hook que mira comandos está una vez, con «Bash|PowerShell»" \
  || bad "1. instalación nueva (rc $RC): $R · $(tail -2 "$T/1.out" | tr '\n' ' ')"

# 2) una settings.json de antes
make_old "$T/fresh.json" "$T/old.json"
grep -q '"Bash|PowerShell"' "$T/old.json" && bad "2. no pude armar la settings.json de antes"
cp "$T/old.json" "$T/old.before.json"
run "$T/old.json" > "$T/2.out" 2>&1; RC=$?
R="$(node "$T/check.js" "$T/old.json" foreign)"; CK=$?
[ "$RC" -eq 0 ] && [ "$CK" -eq 0 ] && ok "2. una settings.json de antes: una entrada por guion, con el matcher nuevo; lo ajeno sigue con «Bash»" \
  || bad "2. una settings.json de antes (rc $RC): $R"
N="$(grep -c 'matcher ampliado' "$T/2.out")"
[ "$N" -ge 12 ] && ok "2. el reporte dice cada matcher ampliado ($N)" || bad "2. el reporte nombra $N matcher(s) ampliado(s) (esperaba al menos 12) · $(grep -m2 '^  +' "$T/2.out" | tr '\n' ' ')"
# el comando del guion migrado es el mismo de antes (se mueve, no se reescribe)
SG="$(node -e 'const s=require(process.argv[1]);for(const e of s.hooks.PreToolUse)for(const h of e.hooks)if(/safety-guard-pre\.sh"$/.test(h.command))console.log(h.command)' "$T/old.before.json")"
grep -qF "\"command\": \"$(printf '%s' "$SG" | sed 's/"/\\"/g')\"" "$T/old.json" && ok "2. el guion migrado conserva su comando tal cual" \
  || bad "2. el comando de safety-guard cambió al migrar (antes: $SG)"

# 3) idempotente
cp "$T/old.json" "$T/old.after.json"
run "$T/old.json" > "$T/3.out" 2>&1; RC=$?
[ "$RC" -eq 0 ] && cmp -s "$T/old.json" "$T/old.after.json" && ok "3. una segunda corrida deja settings.json byte a byte igual" \
  || bad "3. la segunda corrida (rc $RC) cambió settings.json: $(diff "$T/old.after.json" "$T/old.json" | head -4 | tr '\n' ' ')"

# 4) el viejo y el nuevo a la vez
node -e '
  const fs = require("fs"); const [src, dst] = process.argv.slice(1);
  const s = JSON.parse(fs.readFileSync(src, "utf8"));
  const sg = s.hooks.PreToolUse.flatMap((e) => e.hooks).find((h) => /safety-guard-pre\.sh"$/.test(h.command));
  s.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: sg.command }] });
  fs.writeFileSync(dst, JSON.stringify(s, null, 2) + "\n");' "$T/fresh.json" "$T/both.json"
run "$T/both.json" > "$T/4.out" 2>&1; RC=$?
R="$(node "$T/check.js" "$T/both.json")"; CK=$?
[ "$RC" -eq 0 ] && [ "$CK" -eq 0 ] && grep -q 'safety-guard-pre.sh .*matcher viejo' "$T/4.out" && ok "4. el viejo y el nuevo a la vez: queda uno, y se dice" \
  || bad "4. el viejo y el nuevo a la vez (rc $RC): $R · $(grep -m1 'safety-guard' "$T/4.out")"

# 5) --check sobre la de antes
cp "$T/old.before.json" "$T/check.json"
run "$T/check.json" --check > "$T/5.out" 2>&1; RC=$?
[ "$RC" -eq 0 ] && cmp -s "$T/check.json" "$T/old.before.json" && grep -q "PreToolUse (matcher='Bash|PowerShell') → @tcg:safety-guard-pre.sh" "$T/5.out" \
  && ok "5. --check sobre la de antes: sale 0, no escribe y nombra el freno con su matcher nuevo" \
  || bad "5. --check sobre la de antes (rc $RC): $(grep -m1 'safety-guard' "$T/5.out") · $(cmp -s "$T/check.json" "$T/old.before.json" && echo 'sin escribir' || echo 'ESCRIBIÓ')"

# 6) la de antes, reinstalada llamando al instalador por OTRA ruta al mismo clon (un enlace) — segunda vuelta, C1:
#    la migración reconocía el guion sólo por el texto de su ruta, y con el enlace dejaba el viejo Y el nuevo (en Bash,
#    cada freno dos veces; engram-pre-commit, dos `engram sync` a la vez). «Ya está» lo decide names_file (story 8.18).
ln -s "$ROOT" "$T/link"
cp "$T/old.before.json" "$T/via-link.json"
TYCON_SETTINGS_PATH="$T/via-link.json" "${ISOLATED[@]}" bash "$T/link/scripts/install-tycon-hooks.sh" > "$T/6.out" 2>&1; RC=$?
R="$(node "$T/check.js" "$T/via-link.json" foreign)"; CK=$?
[ "$RC" -eq 0 ] && [ "$CK" -eq 0 ] && ok "6. la de antes reinstalada por un enlace al clon: una entrada por guion, con el matcher nuevo" \
  || bad "6. la de antes reinstalada por un enlace al clon (rc $RC): $R"

# 7) el matcher escrito con coma («Bash, PowerShell»: la documentación de hooks acepta las dos formas) es el mismo:
#    no se agrega otro registro (segunda vuelta, MENOR 6)
node -e '
  const fs = require("fs"); const [src, dst] = process.argv.slice(1);
  const s = JSON.parse(fs.readFileSync(src, "utf8"));
  for (const ev of ["PreToolUse", "PostToolUse"]) for (const e of s.hooks[ev] || []) if (e.matcher === "Bash|PowerShell") e.matcher = "Bash, PowerShell";
  fs.writeFileSync(dst, JSON.stringify(s, null, 2) + "\n");' "$T/fresh.json" "$T/comma.json"
cp "$T/comma.json" "$T/comma.before.json"
run "$T/comma.json" > "$T/7.out" 2>&1; RC=$?
[ "$RC" -eq 0 ] && cmp -s "$T/comma.json" "$T/comma.before.json" && ok "7. el matcher escrito con coma cuenta como el mismo: settings.json no cambia" \
  || bad "7. el matcher escrito con coma (rc $RC): $(grep -m2 '^  +' "$T/7.out" | tr '\n' ' ')"

echo
if [ "$FAILURES" -gt 0 ]; then echo "FALLARON $FAILURES chequeo(s)"; exit 1; fi
echo "todo verde"; exit 0
