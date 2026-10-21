#!/usr/bin/env bash
# third-party-origin.test.sh — cada skill de terceros sigue estando en su origen, tal cual la fija el manifiesto
# (T20 · nocturna, CON red; nunca en el pre-commit ni en el arranque).
#
# Por cada entrada `download` del manifiesto real trae `commit`:`path` de su `origin` (git fetch --depth 1 sin blobs:
# un commit por su sha, ~1 s), le quita `omit`, le aplica `mode_fixes` y compara el hash de árbol con `tree`. Es lo que
# el paso del instalador hace en una máquina sin historia (la copia pública): si un origen se mueve, se borra o reescribe
# su historia, esto lo ve antes de que un dev lo necesite.
#
# Salida: 0 = todas coinciden · 1 = una no coincide, o su commit / su origen ya no está (se nombra) · 2 = NO MEDIDO: no
# pude preguntar (sin red, o GitHub no contesta). NO MEDIDO nunca es verde: una salida vacía puede ser un comando que
# falló. Control negativo: una entrada con el árbol alterado a mano tiene que salir 1.
# 🔴 Sin pipes sobre el comando medido: el exit code REAL es el veredicto.
set -u
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST="$TCG/scripts/publishing/third-party-skills.json"
BASE="$(mktemp -d "${TMPDIR:-/tmp}/tycon-terceros-origen.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT
FALLAS=0
ok() { echo "✅ third-party-origin: $1"; }
bad() { echo "❌ third-party-origin: $1"; FALLAS=$((FALLAS + 1)); }

# Dónde está agent-skills (lo usa T9, más abajo). Se pregunta ACÁ, antes de salir a la red: si la biblioteca no puede
# contestar —tira cuando su vecina está y no carga—, no se mide nada. Con `2>/dev/null` la carpeta queda vacía, T9
# dice «no encontré … (sin ubicar)» sin sumar nada, y el guion puede cerrar con «todo verde».
if ! AS="$(node -e 'try { console.log(require(process.argv[1]).resolveSkillsDirs().repo); } catch (e) { console.error(String((e && e.message) || e).split("\n")[0]); process.exit(1); }' "$TCG/scripts/lib/skills-dir.js" 2> "$BASE/skills-dir.err")"; then
  echo "⏭ third-party-origin: NO MEDIDO — no pude resolver la carpeta de skills: $(head -n 1 "$BASE/skills-dir.err")"
  exit 2
fi

cat > "$BASE/check.js" <<'NODE'
// <manifiesto> <carpeta temporal> → 0 / 1 / 2, con una línea por entrada que no coincide
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const [manifestPath, tmp, tcg] = process.argv.slice(2);
const { loadManifest } = require(path.join(tcg, 'scripts/publishing/third-party-coverage.js'));
const { treeSha, classifyFetchError } = require(path.join(tcg, 'scripts/publishing/install-third-party.js'));
const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const m = loadManifest(manifestPath);
const fetched = new Map();
const bad = [];
let unmeasured = 0;
let equal = 0;
for (const e of m.thirdParty.filter((x) => x.install === 'download')) {
  const key = `${e.origin}@${e.commit}`;
  if (!fetched.has(key)) {
    const dir = fs.mkdtempSync(path.join(tmp, 'o-'));
    git(dir, ['init', '-q', '--bare']);
    const r = git(dir, ['fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', e.origin, e.commit]);
    fetched.set(key, r.status === 0 ? { dir } : { kind: r.error ? 'no-network' : classifyFetchError(r.stderr || ''), detail: ((r.stderr || String(r.error || '')).trim().split('\n').pop() || '').slice(0, 160) });
  }
  const f = fetched.get(key);
  if (f.kind === 'no-network') { unmeasured++; console.log(`   ⏭ ${e.target}: no pude preguntar a ${e.origin} (${f.detail})`); continue; }
  if (f.kind) { bad.push(`${e.target}: ${f.kind === 'missing-commit' ? `el commit ${e.commit.slice(0, 12)} ya no está en` : 'ya no existe'} ${e.origin} (${f.detail})`); continue; }
  const ls = git(f.dir, ['ls-tree', '-r', '-z', e.path ? `${e.commit}:${e.path}` : `${e.commit}^{tree}`]);
  if (ls.status !== 0) { bad.push(`${e.target}: la ruta «${e.path}» no está en ${e.commit.slice(0, 12)}`); continue; }
  const omit = (e.omit || []).map((x) => x.file);
  const fixes = new Map((e.mode_fixes || []).map((x) => [x.file, x.mode]));
  const entries = ls.stdout.split('\0').filter(Boolean).map((rec) => {
    const tab = rec.indexOf('\t');
    const [mode, , sha] = rec.slice(0, tab).split(' ');
    const p = rec.slice(tab + 1);
    return { mode: fixes.get(p) || mode, sha, path: p };
  }).filter((x) => !omit.some((o) => x.path === o || x.path.startsWith(`${o}/`)));
  const got = treeSha(entries);
  if (got === e.tree) equal++;
  else bad.push(`${e.target}: ${e.origin} en ${e.commit.slice(0, 12)}:${e.path || '/'} da ${got.slice(0, 12)}, no el árbol declarado ${e.tree.slice(0, 12)}`);
}
for (const b of bad) console.log(`   · ${b}`);
console.log(`   ${equal} iguales · ${bad.length} distintas o perdidas · ${unmeasured} sin medir`);
process.exit(bad.length ? 1 : unmeasured ? 2 : 0);
NODE

# ── T20 · el manifiesto real contra sus orígenes ───────────────────────────────────────────────────────────────────
mkdir -p "$BASE/real"
node "$BASE/check.js" "$MANIFEST" "$BASE/real" "$TCG" > "$BASE/real.out" 2>&1; rc=$?
cat "$BASE/real.out"
case "$rc" in
  0) ok "T20 cada entrada «download» da su árbol en su origen, en el commit fijado" ;;
  2) echo "⏭ third-party-origin: NO MEDIDO — no pude preguntar a los orígenes (sin red o sin respuesta); esto no es verde"; exit 2 ;;
  *) bad "T20 hay entradas que su origen ya no da (rc=$rc) — arriba dice cuáles" ;;
esac

# ── T9 · el LICENSE de tycon-create-story es el de su origen, byte a byte ──────────────────────────────
# La derivada viaja a la copia pública con el LICENSE de BMAD sin editar; esto lo compara con el del commit fijado en
# `based_on`. Sin agent-skills o sin red: NO MEDIDO, dicho, nunca verde (ni rojo: no es un defecto de la derivada).
read -r BO_ORIGIN BO_COMMIT <<<"$(node -e 'const d=require(process.argv[1]).derived.find((x)=>x.target==="skills/tycon-create-story");console.log(d?`${d.based_on.origin} ${d.based_on.commit}`:"- -")' "$MANIFEST")"
if [ ! -f "$AS/skills/tycon-create-story/LICENSE" ]; then
  echo "⏭ third-party-origin: NO MEDIDO — T9: no encontré skills/tycon-create-story/LICENSE en agent-skills (${AS:-sin ubicar})"
elif [ "$BO_ORIGIN" = "-" ]; then bad "T9 el manifiesto no declara skills/tycon-create-story como derivada"
else
  mkdir -p "$BASE/bcs" && git -C "$BASE/bcs" init -q --bare
  if GIT_TERMINAL_PROMPT=0 git -C "$BASE/bcs" fetch -q --depth 1 --no-tags "$BO_ORIGIN" "$BO_COMMIT" > "$BASE/bcs.err" 2>&1; then
    if git -C "$BASE/bcs" show "$BO_COMMIT:LICENSE" | cmp -s - "$AS/skills/tycon-create-story/LICENSE"; then
      ok "T9 el LICENSE de tycon-create-story es el de ${BO_ORIGIN##*/} en ${BO_COMMIT:0:12}, byte a byte"
    else bad "T9 el LICENSE de tycon-create-story difiere del de ${BO_ORIGIN} en ${BO_COMMIT:0:12}"; fi
  else echo "⏭ third-party-origin: NO MEDIDO — T9: no pude traer ${BO_COMMIT:0:12} de ${BO_ORIGIN} ($(tail -1 "$BASE/bcs.err"))"; fi
fi

# ── control negativo: una entrada con el árbol alterado a mano sale 1 nombrándola ─────────────────────────────────────
node -e '
const [src, dst] = process.argv.slice(1); const m = JSON.parse(require("fs").readFileSync(src, "utf8"));
const e = m.third_party.find((x) => x.target === "skills/bmad-dev-story"); e.tree = "0".repeat(39) + "1";
m.third_party = [e]; require("fs").writeFileSync(dst, JSON.stringify(m));' "$MANIFEST" "$BASE/alterado.json"
mkdir -p "$BASE/alt"
node "$BASE/check.js" "$BASE/alterado.json" "$BASE/alt" "$TCG" > "$BASE/alt.out" 2>&1; rc=$?
if [ "$rc" -eq 1 ] && grep -q 'skills/bmad-dev-story' "$BASE/alt.out"; then ok "T20 control: la entrada con el árbol alterado sale 1 nombrándola"
else bad "T20 control: el árbol alterado salió ${rc}: $(tr '\n' ' ' < "$BASE/alt.out")"; fi

# ── sin red: NO MEDIDO, nunca verde ──────────────────────────────────────────────────────────────────────────────
mkdir -p "$BASE/sinred"
GIT_ALLOW_PROTOCOL=file node "$BASE/check.js" "$BASE/alterado.json" "$BASE/sinred" "$TCG" > "$BASE/sinred.out" 2>&1; rc=$?
if [ "$rc" -eq 2 ]; then ok "T20 sin red: sale 2 (NO MEDIDO), no 0"
else bad "T20 sin red salió ${rc}: $(tr '\n' ' ' < "$BASE/sinred.out")"; fi

[ "$FALLAS" -eq 0 ] && { echo "third-party-origin: todo verde"; exit 0; }
echo "third-party-origin: $FALLAS en rojo"; exit 1
