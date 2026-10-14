#!/usr/bin/env bash
# harness-rollback.test.sh — `harness.js rollback`: la vuelta atrás por piezas que se queda (story 8.13, tanda C · T23,
# T24; AC 19-20).
#
# Lo que no se puede perder:
#   U   · `rollback.pickTarget` (el destino), sin laboratorio: sin `--to`, la copia más nueva (mayor `seq`) cuyos `sources`
#         difieren de los HEAD actuales —también si sólo difiere agent-skills (un hook nuevo de agent-skills no cambia el
#         número de versión, que sale del arnés)—; si ninguna copia tiene `sources`, la más nueva y «sólo archivos»; si
#         todas son de la versión instalada, ninguna («nada que deshacer»); `--to` por nombre de carpeta o por `seq`, y una
#         copia sin `sources` elegida así es «sólo archivos»; un `--to` que no existe no elige nada y lo nombra.
#   T23 · Rollback_ByPieces_HoldBlocksAuto_ReleaseAdvances (AC 19-20) — v1 → v2 (un hook nuevo que publica agent-skills y un
#         bloque nuevo que declara el arnés) aplicada por un `startup` con `apply: auto`; la copia de esa actualización es
#         nueva, cerrada con `sha256_after` y con `sources` (los commits de v1); un permiso y una línea a mano; `rollback`:
#         hooks y bloques como en v1, lo de a mano sigue, los dos árboles en v1 y en `main` (nunca un HEAD suelto), estado
#         con `version` = v1, `sources[].previous` = v2 y `hold` = v2; dos `startup` con la red habilitada no avanzan y el
#         aviso lo dice con el comando para liberar; `rollback --release` y otro `startup` sí avanzan a v2; `doctor` sin
#         nada en rojo en cada paso; `rollback --list` muestra seq · from → to · reason · at.
#   T24 · Rollback_ToOlderCopy_FilesAndTreesSameVersion_DirtyTree_FromBootstrap (AC 19) — con tres copias, `--to` la más
#         vieja lleva los árboles a SUS `sources` (no a la anterior inmediata); un archivo que cambió después de la
#         actualización se avisa y se deja; un árbol con un archivo trackeado modificado: stash propio y reaplicado (o no
#         se mueve), y se dice; una copia sin `sources` (anterior a la C) sólo restaura archivos y lo dice; en `developer`
#         no toca git y lo dice; desde la copia fija (`bootstrap.js rollback`) con el `harness.js` del árbol roto funciona.
#
# Regresiones del pase adversarial de la tanda C (cada una nació roja contra el defecto que nombra):
#   REG-H2  · el bloque que la versión vieja ya no trae se va de CLAUDE.md Y del espejo ~/.codex/AGENTS.md (si la pieza
#             codex AGENTS.md está registrada); antes quedaba en el espejo y Codex seguía leyendo lo deshecho.
#   REG-H16 · un archivo que el paso (1) volvió ENTERO a como estaba (un comando propio del dev que pisó la versión nueva)
#             no lo borra el paso (4), y sale del registro (ya no es del arnés).
#   REG-R3  · si `remove.removePieces` deja algo con `error: true` —o tira—, `restore` sale `ok: false` y lo que quedó
#             lleva `error: true` (antes: `ok: true` y el fallo escondido).
#   REG-H9  · (harness.js) la copia `before-rollback` forzada corre la retención: la copia DESTINO tiene que sobrevivir
#             y restaurarse aunque sea la quinta más nueva.
#   REG-H11 · (harness.js) un segundo rollback que deshace el primero —vuelve a la versión nueva— no deja `hold` (levanta
#             el que había) y el arranque siguiente sigue actualizando.
#   REG-H17 · (harness.js) si restore se frenó por bloqueos (la fuente en otra rama con commits propios), rollback no
#             re-registra commits ni versión: el doctor sigue marcando el HEAD que no es el registrado.
#   REG-H5  · (harness.js/snapshot.js) después de 6 arranques que cambian settings.json, `rollback` igual encuentra la
#             versión anterior: la copia de antes de la actualización no se poda.
#   REG-DB  · (pase adversarial de la tanda D, causa B) en una copia pública todavía sin `tycon/installed`, el motivo por
#             el que `rollback` no mueve la fuente no manda a `checkout tycon/installed` (esa rama no existe): el comando
#             que aconseja se corre y sale 0; con la rama ya creada, el consejo de siempre vale.
#
# El comando `harness.js rollback` lo cablea harness.js con las funciones de scripts/setup/harness/rollback.js (contratos en
# el plan de la tanda C, §2). Laboratorio: scripts/tests/lib/harness-lab.sh. Nunca ~/.claude ni el checkout real.
# 🔴 Sin pipes sobre el comando medido: el exit code REAL es el veredicto.
#
#   T38 · (story 8.18, AC 37) rollback en las tres formas de máquina que deja la unión de los dos repos: dos clones sin
#         re-apuntar, dos clones con el viejo re-apuntado al repo unificado (vuelven LAS DOS al mismo commit, y el clon
#         sigue re-apuntado), y un solo árbol.
#
# Uso: bash scripts/tests/harness-rollback.test.sh [--only U|T23|T24|REG-H2|REG-H16|REG-R3|REG-H9|REG-H11|REG-H17|REG-H5|REG-DB|T38]
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
BASE="$(mktemp -d "${TMPDIR:-/tmp}/harness-rollback.XXXXXX")"
case "$BASE" in *tycon-claude-guides*|*agent-skills*|*/.claude*) echo "❌ harness-rollback: el laboratorio cayó en ${BASE}"; exit 1 ;; esac
trap 'rm -rf "$BASE"' EXIT
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
ESTADO() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"; }
estado() { j "$(ESTADO)" "$1"; }
estado_set() { python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p, encoding='utf-8')); $1; json.dump(d, open(p,'w', encoding='utf-8'), indent=2)" "$(ESTADO)"; }
head_de() { harness_lab_git "$1" rev-parse HEAD; }
rama_de() { harness_lab_git "$1" symbolic-ref --short -q HEAD || echo '(HEAD suelto)'; }
COPIAS() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness/backups"; }
# copias: una línea por copia, de la más vieja a la más nueva: «seq nombre reason harness agent_skills cerrada»
copias() {
  python3 - "$(COPIAS)" <<'PY'
import json, os, sys
root = sys.argv[1]
rows = []
for n in (os.listdir(root) if os.path.isdir(root) else []):
    try: m = json.load(open(os.path.join(root, n, "manifest.json"), encoding="utf-8"))
    except Exception: continue
    s = m.get("sources") or {}
    closed = any(f.get("sha256_after") for f in m.get("files", []))
    rows.append((m.get("seq") or 0, n, m.get("reason"), s.get("harness") or "-", s.get("agent_skills") or "-", "cerrada" if closed else "abierta"))
for r in sorted(rows): print(" ".join(str(x) for x in r))
PY
}
# el sha256_after (o sha256) de un archivo en el manifiesto de una copia: manifiesto <nombre> <ruta> <campo>
manifiesto() { python3 -c "import json,sys; m=json.load(open(sys.argv[1], encoding='utf-8')); print(next((f.get(sys.argv[3]) for f in m['files'] if f['path']==sys.argv[2]), None))" "$(COPIAS)/$1/manifest.json" "$2" "$3"; }
sha_de() { shasum -a 256 < "$1" | cut -d' ' -f1; }
# doctor sin nada en rojo: imprime los fail (vacío = verde)
doctor_fails() { harness doctor --json 2>/dev/null | python3 -c "import json,sys; print(' | '.join(json.load(sys.stdin).get('fail', [])))" 2>/dev/null || echo "(doctor --json ilegible)"; }
doctor_verde() { # doctor_verde <etiqueta>
  local f; f="$(doctor_fails)"
  [ -z "$f" ] && ok "$1: doctor sin nada en rojo" || mal "$1: doctor en rojo: $f"
}
hay() { grep -q -- "$1" "$2" 2>/dev/null; }
# los hooks de settings.json, «EVENTO <archivo del command>» separados por «;» (para los mensajes de error)
comandos() { python3 -c "import json,sys,os
s=json.load(open(sys.argv[1], encoding='utf-8'))
print('; '.join('%s %s' % (ev, os.path.basename(c.get('command','').rstrip('\"'))) for ev,bl in s.get('hooks',{}).items() for b in bl for c in b.get('hooks',[])))" "$TYCON_SETTINGS_PATH" 2>&1; }
# un permiso a mano en settings.json (como lo agrega Claude Code o el dev)
permiso_a_mano() {
  python3 - "$TYCON_SETTINGS_PATH" <<'PY'
import json, sys
p = sys.argv[1]
s = json.load(open(p, encoding="utf-8"))
s.setdefault("permissions", {}).setdefault("allow", []).append("Bash(lab-manual:*)")
open(p, "w", encoding="utf-8").write(json.dumps(s, indent=2, ensure_ascii=False) + "\n")
PY
}
export TYCON_UPDATE_APPLY=auto   # la política del equipo, sin perfil en el laboratorio
HOOK_V2='tycon-pipeline/lab-rollback.js'
BLOCK_V2='lab-v2'

# v1 instalada, v2 (hook nuevo en agent-skills + bloque nuevo en el arnés) aplicada por un startup con auto.
# Deja T1 S1 (v1) y T2 S2 (v2) y V1 V2 (los números de versión).
v1_a_v2() { # v1_a_v2 <dir>
  harness_lab_create "$1" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "install de v1 falló en $1"
  T1="$(head_de "$LAB_TREE")"; S1="$(head_de "$LAB_SKILLS")"; V1="$(estado "d['version']['number']")"
  harness_lab_publish_hook PreToolUse "$HOOK_V2" 'process.exit(0);'
  harness_lab_publish_block "$BLOCK_V2"
  T2="$(head_de "$LAB_AUTHOR_TREE")"; S2="$(head_de "$LAB_AUTHOR_SKILLS")"
  estado_set "d['last_fetch']=None"
  harness startup >/dev/null 2>&1
  V2="$(estado "d['version']['number']")"
}
# el nombre de v2 en `hold`/`failed`: el número (sale del arnés) más el agent-skills (pase adversarial H19)
etiqueta_v2() { printf '%s · agent-skills %s' "$V2" "${S2:0:7}"; }

# ═══ U · pickTarget, sin laboratorio ═════════════════════════════════════════════════════════════════════════════════
if corre U; then
  SALIDA="$(node - "$RAIZ/scripts/setup/harness/rollback.js" <<'JS' 2>&1
const { pickTarget } = require(process.argv[2]);
const A = 'a'.repeat(40), B = 'b'.repeat(40), X = 'c'.repeat(40), Y = 'd'.repeat(40);
const c = (seq, name, reason, sources) => ({ dir: `/lab/backups/${name}`, name, manifest: { seq, reason, sources, files: [] } });
const install = c(1, '20261002-100000', 'install', null);
const upd = c(2, '20261002-110000', 'startup', { harness: A, agent_skills: X });
const later = c(3, '20261002-120000', 'startup', { harness: B, agent_skills: Y });
const current = { harness: B, agent_skills: Y };
const out = [];
const t = (label, cond, got) => out.push(`${cond ? 'ok' : 'MAL'} ${label}${cond ? '' : ` → ${JSON.stringify(got)}`}`);
let r = pickTarget([later, upd, install], { currentSources: current });
t('sin --to: la más nueva con sources distintos de los HEAD', r.copy === upd && r.filesOnly === false, r);
r = pickTarget([install, upd, later], { currentSources: current });
t('el orden de entrada no importa: manda seq', r.copy === upd, r);
const onlySkills = c(4, '20261002-130000', 'update', { harness: B, agent_skills: X });
r = pickTarget([onlySkills, later, upd, install], { currentSources: current });
t('sólo agent-skills distinto (un hook nuevo de agent-skills) también cuenta', r.copy === onlySkills, r);
const bare = [c(2, 'n2', 'startup', null), c(3, 'n3', 'apply', null), c(1, 'n1', 'install', null)];
r = pickTarget(bare, { currentSources: current });
t('ninguna con sources: la más nueva, sólo archivos, y lo dice', r.copy === bare[1] && r.filesOnly === true && /sources/.test(r.reason || ''), r);
r = pickTarget([later, c(2, 'n2', 'startup', { harness: B, agent_skills: Y })], { currentSources: current });
t('todas de la versión instalada: ninguna, «nada que deshacer»', r.copy === null && /nada que deshacer/.test(r.reason || ''), r);
r = pickTarget([later, upd, install], { to: '20261002-110000', currentSources: current });
t('--to por nombre de carpeta', r.copy === upd && r.filesOnly === false, r);
r = pickTarget([later, upd, install], { to: '1', currentSources: current });
t('--to por seq, una copia sin sources: sólo archivos', r.copy === install && r.filesOnly === true && /sources/.test(r.reason || ''), r);
r = pickTarget([later, upd, install], { to: '/lab/backups/20261002-120000', currentSources: current });
t('--to por ruta', r.copy === later, r);
r = pickTarget([later, upd, install], { to: 'no-existe', currentSources: current });
t('--to que no existe: ninguna y lo nombra', r.copy === null && /no-existe/.test(r.reason || ''), r);
r = pickTarget([], { currentSources: current });
t('sin copias: ninguna y lo dice', r.copy === null && typeof r.reason === 'string' && r.reason.length > 0, r);
console.log(out.join('\n'));
JS
)"; RC=$?
  [ "$RC" = 0 ] || mal "U pickTarget no corrió (rc $RC): $SALIDA"
  while IFS= read -r l; do
    case "$l" in "ok "*) ok "U ${l#ok }" ;; "MAL "*) mal "U ${l#MAL }" ;; esac
  done <<<"$SALIDA"
fi

# ═══ T23 · Rollback_ByPieces_HoldBlocksAuto_ReleaseAdvances ══════════════════════════════════════════════════════════
if corre T23; then
  v1_a_v2 "$BASE/t23"
  doctor_verde "T23 tras install + update"
  [ "$(head_de "$LAB_TREE")" = "$T2" ] && [ "$(head_de "$LAB_SKILLS")" = "$S2" ] && hay "$HOOK_V2" "$TYCON_SETTINGS_PATH" && hay "TYCON_BLOCK:$BLOCK_V2 START" "$CLAUDE_MD_PATH" \
    && ok "T23 el startup con auto aplicó v2 (hook de agent-skills y bloque del arnés en la máquina)" \
    || mal "T23 v2 no quedó aplicada: tree $(head_de "$LAB_TREE") skills $(head_de "$LAB_SKILLS"); $(cat "$LAB_HOME/.claude/.tycon-pipeline/harness/startup.log" 2>/dev/null | tail -3)"
  # la copia de ESA actualización: nueva (después de la de install), con los commits de v1 y cerrada con el después de v2
  UPD="$(copias | awk -v t="$T1" -v s="$S1" '$4==t && $5==s && $3!="install" {n=$2} END {print n}')"
  INSTALL_SEQ="$(copias | awk '$3=="install" {print $1; exit}')"
  UPD_SEQ="$(copias | awk -v n="$UPD" '$2==n {print $1}')"
  if [ -n "$UPD" ] && [ "${UPD_SEQ:-0}" -gt "${INSTALL_SEQ:-0}" ] && [ "$(manifiesto "$UPD" "$TYCON_SETTINGS_PATH" sha256_after)" = "$(sha_de "$TYCON_SETTINGS_PATH")" ]; then
    ok "T23 la copia de la actualización es nueva, tiene sources (v1) y su sha256_after es el settings.json de v2"
  else mal "T23 copia de la actualización (nombre «${UPD}», seq ${UPD_SEQ:-—} vs install ${INSTALL_SEQ:-—}): $(copias | tr '\n' ';')"; fi
  # lo de a mano, DESPUÉS de la actualización
  permiso_a_mano
  printf 'línea a mano del dev\n' >> "$CLAUDE_MD_PATH"
  SALIDA="$(harness rollback 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "T23 rollback sale 0" || mal "T23 rollback rc $RC: $SALIDA"
  ! hay "$HOOK_V2" "$TYCON_SETTINGS_PATH" && hay 'lab-hook.js' "$TYCON_SETTINGS_PATH" \
    && ok "T23 hooks como en v1: el de agent-skills de v2 salió, el de v1 sigue" || mal "T23 hooks: $(comandos)"
  ! hay "TYCON_BLOCK:$BLOCK_V2" "$CLAUDE_MD_PATH" && ok "T23 bloques como en v1: el bloque de v2 salió" || mal "T23 el bloque de v2 sigue: $(cat "$CLAUDE_MD_PATH")"
  hay 'Bash(lab-manual:\*)' "$TYCON_SETTINGS_PATH" && hay 'línea a mano del dev' "$CLAUDE_MD_PATH" \
    && ok "T23 el permiso y la línea a mano siguen" || mal "T23 se perdió lo de a mano: settings=$(hay lab-manual "$TYCON_SETTINGS_PATH" && echo sí || echo no) CLAUDE.md=$(hay 'a mano' "$CLAUDE_MD_PATH" && echo sí || echo no)"
  hay '@~/.claude/tycon-harness/INDEX.md' "$CLAUDE_MD_PATH" && ok "T23 el @import (pieza propia de harness.js, por el lugar desde la story 8.19) no se tocó" || mal "T23 se fue el @import: $(cat "$CLAUDE_MD_PATH")"
  [ "$(head_de "$LAB_TREE")" = "$T1" ] && [ "$(head_de "$LAB_SKILLS")" = "$S1" ] && ok "T23 los dos árboles en v1" || mal "T23 árboles: tree $(head_de "$LAB_TREE") (v1 $T1) skills $(head_de "$LAB_SKILLS") (v1 $S1)"
  [ "$(rama_de "$LAB_TREE")" = main ] && [ "$(rama_de "$LAB_SKILLS")" = main ] && ok "T23 …en main, no en un HEAD suelto" || mal "T23 ramas: $(rama_de "$LAB_TREE") / $(rama_de "$LAB_SKILLS")"
  [ "$(estado "d['version']['number']")" = "$V1" ] && ok "T23 estado: version = v1 ($V1)" || mal "T23 version $(estado "d['version']['number']") (v1 $V1)"
  [ "$(estado "[s for s in d['sources'] if s['name']=='harness'][0]['previous']")" = "$T2" ] && [ "$(estado "[s for s in d['sources'] if s['name']=='agent_skills'][0]['previous']")" = "$S2" ] \
    && ok "T23 estado: sources[].previous = v2" || mal "T23 previous: $(estado "[(s['name'], s.get('previous')) for s in d['sources']]")"
  [ "$(estado "d['hold']['commit']")" = "$(etiqueta_v2)" ] && [ "$(estado "d['hold']['sources']['harness']")" = "$T2" ] && [ "$(estado "d['hold']['reason']")" = rollback ] \
    && ok "T23 estado: hold = v2 ($(etiqueta_v2)), con sus sources y reason rollback" || mal "T23 hold: $(estado "d.get('hold')")"
  [ "$(estado "[s for s in d['sources'] if s['name']=='harness'][0]['commit']")" = "$T1" ] && ok "T23 estado: sources[].commit = v1" || mal "T23 commit: $(estado "[(s['name'], s.get('commit')) for s in d['sources']]")"
  ! estado "d['managed']" | grep -q 'lab-rollback.js' && ok "T23 el registro ya no trae el hook de v2" || mal "T23 managed sigue con el hook de v2"
  doctor_verde "T23 tras rollback"
  # dos arranques con la red habilitada: no avanzan, y el aviso lo dice con el comando para liberar
  for n in 1 2; do
    estado_set "d['last_fetch']=None"
    harness startup >/dev/null 2>&1
    [ "$(head_de "$LAB_TREE")" = "$T1" ] && [ "$(head_de "$LAB_SKILLS")" = "$S1" ] && ok "T23 startup $n con hold y auto: no avanza" || mal "T23 startup $n avanzó: tree $(head_de "$LAB_TREE") skills $(head_de "$LAB_SKILLS")"
    case "$(estado "d.get('notice') or ''")" in *"rollback --release"*) ok "T23 startup $n: el aviso dice la retención y cómo liberarla" ;; *) mal "T23 startup $n: aviso «$(estado "d.get('notice')")»" ;; esac
    doctor_verde "T23 tras startup $n con hold"
  done
  SALIDA="$(harness rollback --list 2>&1)"; RC=$?
  if [ "$RC" = 0 ] && grep -q 'before-rollback' <<<"$SALIDA" && grep -q 'install' <<<"$SALIDA" && grep -Eq '20[0-9]{2}-[0-9]{2}-[0-9]{2}T' <<<"$SALIDA" && grep -q -- '→' <<<"$SALIDA"; then
    ok "T23 rollback --list: seq · from → to · reason · at"
  else mal "T23 rollback --list (rc $RC): $SALIDA"; fi
  SALIDA="$(harness rollback --release 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado "d.get('hold')")" = None ] && ok "T23 rollback --release sale 0 y levanta la retención" || mal "T23 --release (rc $RC): hold=$(estado "d.get('hold')"): $SALIDA"
  estado_set "d['last_fetch']=None"
  harness startup >/dev/null 2>&1
  [ "$(head_de "$LAB_TREE")" = "$T2" ] && [ "$(head_de "$LAB_SKILLS")" = "$S2" ] && hay "$HOOK_V2" "$TYCON_SETTINGS_PATH" \
    && ok "T23 tras --release, un startup avanza a v2" || mal "T23 tras --release no avanzó: tree $(head_de "$LAB_TREE") skills $(head_de "$LAB_SKILLS")"
  doctor_verde "T23 tras --release y startup"
fi

# ═══ T23b · el @import en su forma HEREDADA sobrevive a la vuelta atrás, y el arranque lo repone si falta ═══════════
# Máquina Windows de un dev (2026-10-07): su CLAUDE.md tenía la línea de import con el nombre viejo del lugar, la vuelta
# atrás la quitó como «pieza que esta versión ya no trae» y ningún arranque la repuso: la máquina quedó sin las guías.
if corre T23b; then
  LOG() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness/startup.log"; }
  v1_a_v2 "$BASE/t23b"
  # la forma heredada sale de place.js (T38 de harness-place: la ruta del lugar viejo no se escribe a mano)
  LEGACY="@~/.claude/$(node -p "require('$RAIZ/scripts/setup/harness/place.js').LEGACY_PLACE_NAME")/README.md"
  # el CLAUDE.md y el registro con la forma heredada (como quedó en las máquinas instaladas antes de la 8.19)
  python3 - "$CLAUDE_MD_PATH" "$(ESTADO)" "$LEGACY" <<'PY'
import json, sys, re
md, st, legacy = sys.argv[1], sys.argv[2], sys.argv[3]
t = open(md, encoding='utf-8').read()
t = re.sub(r'^@~/\.claude/[^/\n]+/(?:README|INDEX)\.md$', legacy, t, flags=re.M)
open(md, 'w', encoding='utf-8').write(t)
d = json.load(open(st, encoding='utf-8'))
for p in d.get('managed', []):
    if p.get('kind') == 'import': p['id'] = legacy
json.dump(d, open(st, 'w', encoding='utf-8'), indent=2)
PY
  hay "$LEGACY" "$CLAUDE_MD_PATH" && ok "T23b CLAUDE.md con el @import heredado" || mal "T23b no quedó el import heredado: $(cat "$CLAUDE_MD_PATH")"
  SALIDA="$(harness rollback 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "T23b rollback sale 0" || mal "T23b rollback rc $RC: $SALIDA"
  grep -q '/README.md' "$CLAUDE_MD_PATH" && ok "T23b el @import (forma heredada) sigue en CLAUDE.md tras la vuelta atrás" || mal "T23b la vuelta atrás quitó el @import: $(cat "$CLAUDE_MD_PATH")"
  case "$SALIDA" in *"quitada"*"README.md"*) mal "T23b rollback dijo que quitó el import: $SALIDA" ;; *) ok "T23b …y no lo anunció como pieza quitada" ;; esac
  # sin ninguna línea de import, el arranque siguiente la repone
  # sin ninguna línea de import (el archivo puede quedar vacío: grep -v sale 1 y el mv va igual)
  grep -v -E '/(README|INDEX)\.md$' "$CLAUDE_MD_PATH" > "$CLAUDE_MD_PATH.tmp"; mv "$CLAUDE_MD_PATH.tmp" "$CLAUDE_MD_PATH"
  grep -q -E '/(README|INDEX)\.md$' "$CLAUDE_MD_PATH" && mal "T23b (armado) el import no se pudo sacar" || ok "T23b (armado) CLAUDE.md sin ninguna línea de import"
  estado_set "d['last_fetch']=None"
  harness startup >/dev/null 2>&1
  grep -q '^@~/.claude/.*/INDEX.md$' "$CLAUDE_MD_PATH" && ok "T23b el arranque repuso el @import que faltaba (el de hoy: INDEX.md)" || mal "T23b el arranque no repuso el import: $(cat "$CLAUDE_MD_PATH")"
  grep -q "faltaba en CLAUDE.md: repuesto" "$(LOG)" && ok "T23b …y lo dejó en el registro" || mal "T23b el registro no dice que lo repuso"
fi

# ═══ T24 · Rollback_ToOlderCopy_FilesAndTreesSameVersion_DirtyTree_FromBootstrap ═════════════════════════════════════
if corre T24; then
  # (a) tres copias; --to la más vieja; un archivo cambiado después; un árbol sucio
  v1_a_v2 "$BASE/t24a"
  harness_lab_publish_block lab-v3
  T3="$(head_de "$LAB_AUTHOR_TREE")"
  estado_set "d['last_fetch']=None"
  harness startup >/dev/null 2>&1
  [ "$(head_de "$LAB_TREE")" = "$T3" ] || mal "T24 v3 no se aplicó: $(head_de "$LAB_TREE")"
  N="$(copias | grep -c .)"
  [ "$N" -ge 3 ] && ok "T24 hay $N copias (≥ 3)" || mal "T24 copias: $(copias | tr '\n' ';')"
  VIEJA="$(copias | awk '$4!="-" {print $2; exit}')"
  VIEJA_T="$(copias | awk -v n="$VIEJA" '$2==n {print $4}')"; VIEJA_S="$(copias | awk -v n="$VIEJA" '$2==n {print $5}')"
  [ "$VIEJA_T" = "$T1" ] || mal "T24 la copia más vieja con sources no es de v1: $(copias | tr '\n' ';')"
  printf 'línea a mano después de v3\n' >> "$CLAUDE_MD_PATH"
  printf 'cambio local sin commitear\n' >> "$LAB_TREE/README.md"
  SALIDA="$(harness rollback --to "$VIEJA" 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "T24 rollback --to la más vieja sale 0" || mal "T24 --to (rc $RC): $SALIDA"
  [ "$(head_de "$LAB_TREE")" = "$VIEJA_T" ] && [ "$(head_de "$LAB_SKILLS")" = "$VIEJA_S" ] \
    && ok "T24 los árboles van a los sources de ESA copia (v1), no a la anterior inmediata (v2)" || mal "T24 árboles: tree $(head_de "$LAB_TREE") (esperado $VIEJA_T; v2 $T2) skills $(head_de "$LAB_SKILLS")"
  [ "$(rama_de "$LAB_TREE")" = main ] && ok "T24 …en main" || mal "T24 rama $(rama_de "$LAB_TREE")"
  ! hay 'TYCON_BLOCK:lab-v3' "$CLAUDE_MD_PATH" && ! hay "TYCON_BLOCK:$BLOCK_V2" "$CLAUDE_MD_PATH" && ! hay "$HOOK_V2" "$TYCON_SETTINGS_PATH" \
    && ok "T24 piezas como en v1 (bloques de v2 y v3 y hook de v2 fuera)" || mal "T24 piezas: $(grep -o 'TYCON_BLOCK:[a-z0-9-]* START' "$CLAUDE_MD_PATH" | tr '\n' ' ') $(grep -c lab-rollback "$TYCON_SETTINGS_PATH")"
  hay 'línea a mano después de v3' "$CLAUDE_MD_PATH" && grep -q 'CLAUDE.md' <<<"$SALIDA" \
    && ok "T24 el archivo que cambió después se deja (sigue la línea a mano) y se avisa" || mal "T24 el cambiado: línea=$(hay 'a mano después' "$CLAUDE_MD_PATH" && echo sí || echo no): $SALIDA"
  if hay 'cambio local sin commitear' "$LAB_TREE/README.md" && grep -qi 'stash\|apart' <<<"$SALIDA"; then
    ok "T24 árbol sucio: lo local se apartó en un stash propio, se reaplicó, y se dice"
  elif [ "$(head_de "$LAB_TREE")" != "$VIEJA_T" ] && grep -qi 'no se mov\|sin commitear' <<<"$SALIDA"; then
    ok "T24 árbol sucio: no se movió, y se dice"
  else mal "T24 árbol sucio: README $(tail -1 "$LAB_TREE/README.md"): $SALIDA"; fi

  # (b) una copia sin sources (anterior a la C): sólo archivos, y lo dice
  v1_a_v2 "$BASE/t24b"
  UPD="$(copias | awk -v t="$T1" '$4==t && $3!="install" && $6=="cerrada" {n=$2} END {print n}')"
  [ -n "$UPD" ] || mal "T24 (b) sin la copia de la actualización: $(copias | tr '\n' ';')"
  python3 -c "import json,sys; p=sys.argv[1]; m=json.load(open(p, encoding='utf-8')); m['sources']=None; open(p,'w', encoding='utf-8').write(json.dumps(m, indent=2)+'\n')" "$(COPIAS)/$UPD/manifest.json"
  SALIDA="$(harness rollback --to "$UPD" 2>&1)"; RC=$?
  [ "$RC" = 0 ] && grep -q 'sources' <<<"$SALIDA" && grep -q 'sólo' <<<"$SALIDA" && grep -q 'archivos' <<<"$SALIDA" && ok "T24 copia sin sources: sale 0 y dice «sólo archivos»" || mal "T24 sin sources (rc $RC): $SALIDA"
  [ "$(head_de "$LAB_TREE")" = "$T2" ] && [ "$(head_de "$LAB_SKILLS")" = "$S2" ] && ok "T24 …los árboles no se mueven" || mal "T24 sin sources movió árboles: $(head_de "$LAB_TREE")"
  ! hay "TYCON_BLOCK:$BLOCK_V2" "$CLAUDE_MD_PATH" && ! hay "$HOOK_V2" "$TYCON_SETTINGS_PATH" \
    && ok "T24 …y los archivos sin tocar desde la actualización vuelven enteros a como estaban antes" || mal "T24 sin sources no restauró archivos: $(cat "$CLAUDE_MD_PATH")"
  SALIDA="$(harness rollback --list 2>&1)"
  grep -q "sin sources" <<<"$SALIDA" && ok "T24 rollback --list marca la copia «sin sources»" || mal "T24 --list sin la marca: $SALIDA"

  # (c) developer: restaura piezas, no toca git, y lo dice
  v1_a_v2 "$BASE/t24c"
  harness link --local "$LAB_TREE" --allow-temporary >/dev/null 2>&1 || mal "T24 (c) link --local falló"
  GIT_ANTES="$(head_de "$LAB_TREE") $(head_de "$LAB_SKILLS") $(harness_lab_git "$LAB_TREE" stash list | wc -l) $(harness_lab_git "$LAB_TREE" status --porcelain | shasum -a 256)"
  SALIDA="$(harness rollback 2>&1)"; RC=$?
  GIT_DESPUES="$(head_de "$LAB_TREE") $(head_de "$LAB_SKILLS") $(harness_lab_git "$LAB_TREE" stash list | wc -l) $(harness_lab_git "$LAB_TREE" status --porcelain | shasum -a 256)"
  [ "$RC" = 0 ] && [ "$GIT_ANTES" = "$GIT_DESPUES" ] && grep -qi 'desarrollador' <<<"$SALIDA" && grep -qi 'git' <<<"$SALIDA" \
    && ok "T24 developer: sale 0, no toca git y lo dice" || mal "T24 developer (rc $RC; git $GIT_ANTES → $GIT_DESPUES): $SALIDA"

  # (d) desde la copia fija, con el harness.js del árbol roto
  v1_a_v2 "$BASE/t24d"
  [ -f "$LAB_HOME/.claude/.tycon-pipeline/harness/program/harness.js" ] && ok "T24 la copia fija trae el programa (program/harness.js)" || mal "T24 la copia fija no trae program/harness.js: $(ls "$LAB_HOME/.claude/.tycon-pipeline/harness/")"
  printf '\n}}} roto (\n' >> "$LAB_TREE/scripts/setup/harness.js"
  node --check "$LAB_TREE/scripts/setup/harness.js" >/dev/null 2>&1 && mal "T24 no pude romper el harness.js del árbol"
  SALIDA="$(harness_lab_bootstrap rollback 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ! grep -q 'SyntaxError' <<<"$SALIDA" && ok "T24 bootstrap.js rollback con el harness.js del árbol roto: sale 0 (corre el de la copia fija)" || mal "T24 desde la copia fija (rc $RC): $SALIDA"
  [ "$(head_de "$LAB_TREE")" = "$T1" ] && [ "$(head_de "$LAB_SKILLS")" = "$S1" ] && ok "T24 …y los árboles vuelven a v1" || mal "T24 desde la copia fija: tree $(head_de "$LAB_TREE") skills $(head_de "$LAB_SKILLS")"
fi

# ═══ Regresiones de rollback.js, sin laboratorio (restore directo, con un aplicador de mentira) ══════════════════════
# unidad <etiqueta> <script de node>: corre el script con (rollback.js, carpeta propia) y traduce sus líneas «ok …»/«MAL …»
unidad() {
  local etq="$1" js="$2" dir salida rc
  dir="$(mktemp -d "$BASE/${etq}.XXXXXX")"
  salida="$(node -e "$js" "$RAIZ/scripts/setup/harness/rollback.js" "$dir" 2>&1)"; rc=$?
  [ "$rc" = 0 ] || mal "$etq no corrió (rc $rc): $salida"
  while IFS= read -r l; do
    case "$l" in "ok "*) ok "$etq ${l#ok }" ;; "MAL "*) mal "$etq ${l#MAL }" ;; esac
  done <<<"$salida"
}
# lo común de los scripts: un HOME y un árbol de juguete, sha256, y `t(etiqueta, condición, lo observado)`
UNIDAD_COMUN='
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const RB_PATH = process.argv[1], BASE_DIR = process.argv[2];
const rollback = require(RB_PATH);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const home = path.join(BASE_DIR, "home"), tree = path.join(BASE_DIR, "tree");
fs.mkdirSync(path.join(home, ".claude", "commands"), { recursive: true });
fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
fs.mkdirSync(path.join(tree, "commands"), { recursive: true });
const env = Object.assign({}, process.env, { HOME: home });
const out = [];
const t = (label, cond, got) => out.push(`${cond ? "ok" : "MAL"} ${label}${cond ? "" : ` → ${JSON.stringify(got)}`}`);
const SRC = { harness: "a".repeat(40) };
'

if corre REG-H2; then
  unidad REG-H2 "$UNIDAD_COMUN"'
const CLAUDE = path.join(home, ".claude", "CLAUDE.md"), AGENTS = path.join(home, ".codex", "AGENTS.md");
const blk = (n, b) => `<!-- TYCON_BLOCK:${n} START · generado por sync-claude-md-blocks.sh · NO EDITAR A MANO -->\n${b}\n<!-- TYCON_BLOCK:${n} END -->`;
// después de la versión nueva (trajo B2), con una línea a mano en CLAUDE.md: no se restaura entero
const text = `# mis cosas\nlinea a mano\n\n${blk("B1", "regla uno")}\n\n${blk("B2", "regla dos (deshecha)")}\n`;
fs.writeFileSync(CLAUDE, text); fs.writeFileSync(AGENTS, text);
// el aplicador viejo hace lo del sync real: espeja el CLAUDE.md entero en AGENTS.md y reporta B1 y el espejo
const runApplier = () => { fs.writeFileSync(AGENTS, fs.readFileSync(CLAUDE, "utf8"));
  return { ok: true, report: [{ kind: "block", where: CLAUDE, id: "TYCON_BLOCK:B1" }, { kind: "codex", where: AGENTS, id: "AGENTS.md" }] }; };
const state = { mode: "developer", tree, sources: [], managed: [
  { kind: "block", where: CLAUDE, id: "TYCON_BLOCK:B1" }, { kind: "block", where: CLAUDE, id: "TYCON_BLOCK:B2" },
  { kind: "codex", where: AGENTS, id: "AGENTS.md" } ] };
const copy = { name: "c1", dir: path.join(BASE_DIR, "snap"), manifest: { seq: 2, sources: SRC, files: [] } };
const r = rollback.restore({ home, env, tree }, state, copy, { runApplier });
const c = fs.readFileSync(CLAUDE, "utf8"), a = fs.readFileSync(AGENTS, "utf8");
t("restore sale ok", r.ok === true, r.lines);
t("el bloque deshecho se fue de CLAUDE.md", !c.includes("TYCON_BLOCK:B2"), c);
t("…y también del espejo AGENTS.md", !a.includes("TYCON_BLOCK:B2"), a);
t("el bloque que la versión vieja trae sigue en los dos, y lo de a mano en el espejo", c.includes("TYCON_BLOCK:B1 END") && a.includes("TYCON_BLOCK:B1 END") && a.includes("linea a mano"), a);
t("el registro: B1 y el espejo, sin B2", JSON.stringify(state.managed.map((p) => p.id).sort()) === JSON.stringify(["AGENTS.md", "TYCON_BLOCK:B1"]), state.managed);
// sin la pieza codex registrada, el espejo no se toca (no es del arnés)
fs.writeFileSync(CLAUDE, text); fs.writeFileSync(AGENTS, text);
const st2 = { mode: "developer", tree, sources: [], managed: [ { kind: "block", where: CLAUDE, id: "TYCON_BLOCK:B1" }, { kind: "block", where: CLAUDE, id: "TYCON_BLOCK:B2" } ] };
rollback.restore({ home, env, tree }, st2, copy, { runApplier: () => ({ ok: true, report: [{ kind: "block", where: CLAUDE, id: "TYCON_BLOCK:B1" }] }) });
t("sin la pieza codex registrada, AGENTS.md no se toca", fs.readFileSync(AGENTS, "utf8") === text, fs.readFileSync(AGENTS, "utf8"));
console.log(out.join("\n"));
'
fi

if corre REG-H16; then
  unidad REG-H16 "$UNIDAD_COMUN"'
const foo = path.join(home, ".claude", "commands", "foo.md");
const MINE = "comando propio del dev\n", V2 = "comando foo del arnés v2\n";
fs.writeFileSync(foo, V2);                                      // la versión nueva lo pisó (el aplicador hace cp)
fs.mkdirSync(path.join(BASE_DIR, "snap", "files"), { recursive: true });
fs.writeFileSync(path.join(BASE_DIR, "snap", "files", "01-foo.md"), MINE);
const copy = { dir: path.join(BASE_DIR, "snap"), name: "c1", manifest: { seq: 2, reason: "update", sources: SRC,
  files: [{ path: foo, existed: true, sha256: sha(MINE), copy: "files/01-foo.md", sha256_after: sha(V2) }] } };
const state = { mode: "developer", tree, sources: [], managed: [{ kind: "command", where: foo, id: "foo.md", version: "2" }] };
const r = rollback.restore({ home, env, tree }, state, copy, { runApplier: () => ({ ok: true, report: [] }) });
t("restore sale ok", r.ok === true, r.lines);
t("el comando propio vuelve entero y el paso (4) no lo borra", fs.existsSync(foo) && fs.readFileSync(foo, "utf8") === MINE, fs.existsSync(foo) ? fs.readFileSync(foo, "utf8") : "(borrado)");
t("no figura como quitado", !(r.removed || []).some((p) => p && p.where === foo), r.removed);
t("sale del registro: ya no es del arnés", !state.managed.some((p) => p.where === foo), state.managed);
console.log(out.join("\n"));
'
fi

if corre REG-R3; then
  unidad REG-R3 "$UNIDAD_COMUN"'
const remove = require(path.join(path.dirname(RB_PATH), "remove.js"));
const orig = remove.removePieces;
const extra = path.join(home, ".claude", "lab-extra.txt");
const mk = () => { fs.writeFileSync(extra, "x\n"); return { mode: "developer", tree, sources: [], managed: [{ kind: "file", where: extra, id: "lab-extra.txt" }] }; };
const copy = { name: "c1", dir: path.join(BASE_DIR, "snap"), manifest: { seq: 2, sources: SRC, files: [] } };
const opts = { runApplier: () => ({ ok: true, report: [] }) };
try {
  remove.removePieces = (pieces) => ({ removed: [], kept: pieces.map((p) => ({ piece: p, why: "EACCES de mentira", error: true })), review: [] });
  let r = rollback.restore({ home, env, tree }, mk(), copy, opts);
  t("removePieces deja algo con error: restore sale ok:false", r.ok === false, { ok: r.ok, kept: r.kept });
  t("…y lo dice", r.lines.some((l) => /EACCES de mentira/.test(l)), r.lines);
  remove.removePieces = () => { throw new Error("se rompió de mentira"); };
  const st = mk();
  r = rollback.restore({ home, env, tree }, st, copy, opts);
  t("removePieces tira: restore sale ok:false", r.ok === false, { ok: r.ok, kept: r.kept });
  t("…y lo que quedó lleva error:true", r.kept.length === 1 && r.kept[0].error === true, r.kept);
  t("…y la pieza sigue registrada para reintentar", st.managed.some((p) => p.where === extra), st.managed);
  remove.removePieces = (pieces) => ({ removed: [], kept: pieces.map((p) => ({ piece: p, why: "lo cambiaste, es tuyo" })), review: [] });
  r = rollback.restore({ home, env, tree }, mk(), copy, opts);
  t("lo que queda por decisión (sin error) no es un fallo: ok:true", r.ok === true, { ok: r.ok, kept: r.kept });
} finally { remove.removePieces = orig; }
console.log(out.join("\n"));
'
fi

# ═══ Regresiones de harness.js (las arregla el coordinador), en el laboratorio ═══════════════════════════════════════
# un permiso distinto en settings.json y un arranque: cada uno deja una copia `startup` de la versión instalada
arranque_con_cambio() { # arranque_con_cambio <n>
  python3 - "$TYCON_SETTINGS_PATH" "$1" <<'PY'
import json, sys
p = sys.argv[1]
s = json.load(open(p, encoding="utf-8"))
s.setdefault("permissions", {}).setdefault("allow", []).append("Bash(lab-%s:*)" % sys.argv[2])
open(p, "w", encoding="utf-8").write(json.dumps(s, indent=2, ensure_ascii=False) + "\n")
PY
  harness startup >/dev/null 2>&1
}

if corre REG-H9; then
  v1_a_v2 "$BASE/reg-h9"
  DESTINO="$(copias | awk -v t="$T1" '$4==t && $3!="install" {n=$2} END {print n}')"
  for n in 1 2 3 4; do arranque_con_cambio "h9-$n"; done
  # el destino es la quinta copia más nueva: la copia forzada de antes de volver la empujaría fuera de la retención
  POS="$(copias | sort -rn | awk -v n="$DESTINO" '$2==n {print NR}')"
  [ "$POS" = 5 ] || mal "REG-H9 el escenario no quedó armado (el destino es la n.º «${POS}» más nueva, quiero la 5.ª): $(copias | tr '\n' ';')"
  SALIDA="$(harness rollback 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ! grep -q 'no está o no coincide' <<<"$SALIDA" && ok "REG-H9 rollback sale 0 y lee la copia destino" || mal "REG-H9 rollback (rc $RC): $SALIDA"
  copias | awk '{print $2}' | grep -qx "$DESTINO" && ok "REG-H9 la copia destino sobrevive a la retención" || mal "REG-H9 la copia destino $DESTINO se podó: $(copias | tr '\n' ';')"
  ! hay "TYCON_BLOCK:$BLOCK_V2" "$CLAUDE_MD_PATH" && [ "$(head_de "$LAB_TREE")" = "$T1" ] \
    && ok "REG-H9 …y se restauró: bloque de v2 fuera, árbol en v1" || mal "REG-H9 no se restauró: tree $(head_de "$LAB_TREE") (v1 $T1); bloque v2 $(hay "TYCON_BLOCK:$BLOCK_V2" "$CLAUDE_MD_PATH" && echo sigue || echo fuera)"
fi

if corre REG-H11; then
  v1_a_v2 "$BASE/reg-h11"
  harness rollback >/dev/null 2>&1 || mal "REG-H11 el primer rollback falló"
  [ "$(head_de "$LAB_TREE")" = "$T1" ] && [ "$(estado "d['hold']['commit']")" = "$(etiqueta_v2)" ] || mal "REG-H11 el primer rollback no dejó v1 con hold v2: tree $(head_de "$LAB_TREE") hold $(estado "d.get('hold')")"
  SALIDA="$(harness rollback 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$T2" ] && [ "$(head_de "$LAB_SKILLS")" = "$S2" ] \
    && ok "REG-H11 el segundo rollback deshace el primero: vuelve a v2" || mal "REG-H11 segundo rollback (rc $RC; tree $(head_de "$LAB_TREE"), v2 $T2): $SALIDA"
  [ "$(estado "d.get('hold')")" = None ] && ok "REG-H11 …y no deja retención (levanta la que había)" || mal "REG-H11 quedó hold: $(estado "d.get('hold')")"
  case "$(estado "d.get('notice') or ''")" in *"retención"*) mal "REG-H11 el aviso sigue con la retención: $(estado "d.get('notice')")" ;; *) ok "REG-H11 …ni aviso de retención" ;; esac
  harness_lab_publish_block lab-v3
  T3="$(head_de "$LAB_AUTHOR_TREE")"
  estado_set "d['last_fetch']=None"
  harness startup >/dev/null 2>&1
  [ "$(head_de "$LAB_TREE")" = "$T3" ] && ok "REG-H11 el arranque siguiente con auto avanza a v3" || mal "REG-H11 el arranque no avanzó a v3: tree $(head_de "$LAB_TREE") (v3 $T3); aviso $(estado "d.get('notice')")"
fi

if corre REG-H17; then
  v1_a_v2 "$BASE/reg-h17"
  harness_lab_git "$LAB_TREE" checkout -q -b feature || mal "REG-H17 no pude crear la rama"
  printf 'trabajo propio\n' > "$LAB_TREE/lab-feature.txt"
  harness_lab_git "$LAB_TREE" add lab-feature.txt && harness_lab_git "$LAB_TREE" commit -q -m 'trabajo propio' || mal "REG-H17 no pude commitear"
  COMMIT_ANTES="$(estado "[s for s in d['sources'] if s['name']=='harness'][0]['commit']")"
  VERSION_ANTES="$(estado "d['version']['number']")"; AT_ANTES="$(estado "d['version'].get('installed_at')")"
  SALIDA="$(harness rollback 2>&1)"; RC=$?
  [ "$RC" != 0 ] && grep -q 'no se tocó nada' <<<"$SALIDA" && ok "REG-H17 rollback con la fuente en otra rama: se frena y lo dice" || mal "REG-H17 rollback (rc $RC): $SALIDA"
  [ "$(estado "[s for s in d['sources'] if s['name']=='harness'][0]['commit']")" = "$COMMIT_ANTES" ] \
    && ok "REG-H17 …no re-registra el commit de la rama" || mal "REG-H17 re-registró el commit: $(estado "[s for s in d['sources'] if s['name']=='harness'][0]['commit']") (antes $COMMIT_ANTES)"
  [ "$(estado "d['version']['number']")" = "$VERSION_ANTES" ] && [ "$(estado "d['version'].get('installed_at')")" = "$AT_ANTES" ] \
    && ok "REG-H17 …ni la versión" || mal "REG-H17 versión $(estado "d['version']['number']") @ $(estado "d['version'].get('installed_at')") (antes $VERSION_ANTES @ $AT_ANTES)"
  case "$(doctor_fails)" in *"no es el commit registrado"*) ok "REG-H17 …y el doctor sigue marcando el HEAD que no es el registrado" ;; *) mal "REG-H17 el doctor ya no marca el HEAD: $(doctor_fails)" ;; esac
fi

if corre REG-H5; then
  v1_a_v2 "$BASE/reg-h5"
  for n in 1 2 3 4 5 6; do arranque_con_cambio "h5-$n"; done
  copias | awk -v t="$T1" '$4==t && $3!="install"' | grep -q . && ok "REG-H5 tras 6 arranques que cambian settings.json, la copia de antes de la actualización sigue" \
    || mal "REG-H5 se podó la copia de antes de la actualización: $(copias | tr '\n' ';')"
  SALIDA="$(harness rollback 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$T1" ] && [ "$(head_de "$LAB_SKILLS")" = "$S1" ] && ! grep -q 'nada que deshacer' <<<"$SALIDA" \
    && ok "REG-H5 …y rollback vuelve a v1" || mal "REG-H5 rollback (rc $RC; tree $(head_de "$LAB_TREE"), v1 $T1): $SALIDA"
fi

# ═══ REG-DB · (pase adversarial de la tanda D, causa B) el motivo de rollback no aconseja un comando que falla ════════
# Una copia pública recién instalada está en su rama por defecto y `tycon/installed` todavía no existe (la crea la primera
# actualización). Si el clon se movió (un pull a mano) y se pide `rollback`, la fuente no se mueve —rollback sólo mueve
# desde la rama del mecanismo— y lo dice; lo que no puede hacer es mandar a `checkout tycon/installed`, una rama que no
# existe. El motivo sale de `sources.offInstalledBranch`, el mismo que usa `update`: los dos mensajes no divergen.
# 🔴 rojo previo (medido sobre este mismo guion antes del arreglo): 4 MAL — «harness está en la rama main y no en
#    tycon/installed: no se toca (git -C … checkout tycon/installed)»; ese comando: «pathspec 'tycon/installed' did not
#    match», y sin él rollback no tenía salida.
if corre REG-DB; then
  aconsejado() { printf '%s\n' "$1" | grep -oE "git -C [^ ]* checkout( -b)? tycon/installed( [0-9a-f]{40})?" | head -1; }
  correr_aconsejado() { env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR bash -c "$1"; }
  harness_lab_create "$BASE/reg-db" >/dev/null
  harness_lab_public
  harness_lab_publish_stable 2026.10.01.1
  harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
  harness install --yes >/dev/null 2>&1 || mal "REG-DB install falló"
  harness apply >/dev/null 2>&1 || mal "REG-DB apply falló"   # deja una copia con los commits de ahora (la de install no los trae)
  R0="$(head_de "$LAB_TREE")"
  copias | awk -v t="$R0" '$4==t' | grep -q . || mal "REG-DB el laboratorio no dejó una copia con el commit instalado: $(copias | tr '\n' ';')"
  harness_lab_publish_stable 2026.10.02.1
  harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1   # el clon se mueve a mano, en main
  P1="$(head_de "$LAB_TREE")"
  [ "$P1" != "$R0" ] && [ "$(rama_de "$LAB_TREE")" = main ] && ! harness_lab_git "$LAB_TREE" rev-parse --verify -q refs/heads/tycon/installed >/dev/null 2>&1 || mal "REG-DB el laboratorio no quedó como el caso: rama $(rama_de "$LAB_TREE") HEAD $P1"
  SALIDA="$(harness rollback 2>&1)"; RC=$?
  [ "$RC" != 0 ] && grep -q 'no se tocó nada' <<<"$SALIDA" && [ "$(head_de "$LAB_TREE")" = "$P1" ] && [ "$(rama_de "$LAB_TREE")" = main ] \
    && ok "REG-DB copia pública en su rama por defecto, sin tycon/installed: rollback no mueve el clon y lo dice" || mal "REG-DB rollback (rc $RC; rama $(rama_de "$LAB_TREE") HEAD $(head_de "$LAB_TREE")): $SALIDA"
  case "$SALIDA" in *" checkout tycon/installed"*) mal "REG-DB aconseja pasar a una rama que no existe: $SALIDA" ;; *"tycon/installed todavía no existe"*) ok "REG-DB …dice que la rama todavía no existe, sin mandar a «checkout tycon/installed»" ;; *) mal "REG-DB no dice qué pasa con la rama: $SALIDA" ;; esac
  # el comando que aconseja, corrido tal cual: sale 0, deja main como estaba, y rollback pasa a funcionar
  CMD="$(aconsejado "$SALIDA")"
  correr_aconsejado "${CMD:-false}" >/dev/null 2>&1; RC=$?
  [ -n "$CMD" ] && [ "$RC" = 0 ] && [ "$(rama_de "$LAB_TREE")" = tycon/installed ] && [ "$(harness_lab_git "$LAB_TREE" rev-parse main)" = "$P1" ] \
    && ok "REG-DB …el comando que aconseja funciona (rc 0) y deja la rama main como estaba" || mal "REG-DB el comando aconsejado «${CMD}» salió $RC (rama $(rama_de "$LAB_TREE")): $SALIDA"
  SALIDA="$(harness rollback 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$R0" ] && [ "$(rama_de "$LAB_TREE")" = tycon/installed ] && [ "$(harness_lab_git "$LAB_TREE" rev-parse main)" = "$P1" ] \
    && ok "REG-DB …y después rollback vuelve a la copia, sin tocar main" || mal "REG-DB rollback tras el remedio (rc $RC; rama $(rama_de "$LAB_TREE") HEAD $(head_de "$LAB_TREE"), copia $R0): $SALIDA"
  # espejo: con la rama YA existente y el clon en otra, el consejo de siempre («checkout tycon/installed») vale
  harness_lab_git "$LAB_TREE" checkout -q main
  SALIDA="$(harness rollback 2>&1)"; RC=$?
  [ "$RC" != 0 ] && grep -q 'no se tocó nada' <<<"$SALIDA" && [ "$(rama_de "$LAB_TREE")" = main ] && case "$SALIDA" in *"está en la rama main y no en tycon/installed: no se toca (git -C "*" checkout tycon/installed)"*) true ;; *) false ;; esac \
    && ok "REG-DB espejo: con tycon/installed ya creada y el clon en main, el motivo es el de siempre" || mal "REG-DB espejo (rc $RC; rama $(rama_de "$LAB_TREE")): $SALIDA"
  CMD="$(aconsejado "$SALIDA")"
  correr_aconsejado "${CMD:-false}" >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && [ "$(rama_de "$LAB_TREE")" = tycon/installed ] && [ "$(head_de "$LAB_TREE")" = "$R0" ] \
    && ok "REG-DB espejo: …y ese comando funciona (rc 0)" || mal "REG-DB espejo: el comando aconsejado «${CMD}» salió $RC (rama $(rama_de "$LAB_TREE"))"
fi

# ═══ T38 (story 8.18, AC 37) · rollback en las tres formas de máquina ═════════════════════════════════════════════════
# Después de una versión nueva, `rollback` vuelve a la anterior en las tres formas. En la máquina re-apuntada vuelven LAS
# DOS fuentes al mismo commit, y el clon de skills sigue re-apuntado y mostrando sólo lo suyo: volver atrás una versión no
# deshace la mudanza (eso es la llave). `--release` y un update vuelven a subir.
if corre T38; then
  for shape in two-clones repointed single; do
    harness_lab_shape "$BASE/t38-$shape" "$shape" || { mal "T38 ($shape) no pude armar la máquina"; continue; }
    A_T="$(head_de "$LAB_TREE")"; A_S="$(head_de "$LAB_SKILLS")"; ORIGEN_S="$(harness_lab_git "$LAB_SKILLS" remote get-url origin)"
    harness_lab_publish tree "versión nueva (T38)" VERSION 38
    [ "$shape" = two-clones ] && harness_lab_publish skills "skills nuevas (T38)" VERSION 38
    harness update >/dev/null 2>&1 || mal "T38 ($shape) el update previo falló"
    B_T="$(head_de "$LAB_TREE")"; B_S="$(head_de "$LAB_SKILLS")"
    [ "$B_T" != "$A_T" ] && [ "$B_S" != "$A_S" ] || mal "T38 ($shape) precondición: la versión nueva no llegó (arnés $B_T, skills $B_S)"
    SALIDA="$(harness rollback 2>&1)"; RC=$?
    [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$A_T" ] && [ "$(head_de "$LAB_SKILLS")" = "$A_S" ] && [ "$(rama_de "$LAB_TREE")" = main ] && [ "$(rama_de "$LAB_SKILLS")" = main ] \
      && ok "T38 ($shape) rollback vuelve cada fuente a su commit de antes, en main" || mal "T38 ($shape) rollback (rc $RC): arnés $(head_de "$LAB_TREE") vs $A_T, skills $(head_de "$LAB_SKILLS") vs $A_S: $SALIDA"
    [ "$(estado "d['hold'] is not None")" = True ] && [ -d "$LAB_HOME/.claude/skills/tycon-pipeline" ] && ok "T38 ($shape) queda la retención, y las skills siguen" || mal "T38 ($shape) sin retención o sin skills"
    doctor_verde "T38 ($shape) después del rollback"
    if [ "$shape" = repointed ]; then
      [ "$(head_de "$LAB_TREE")" = "$(head_de "$LAB_SKILLS")" ] && [ "$(harness_lab_git "$LAB_SKILLS" remote get-url origin)" = "$ORIGEN_S" ] && [ ! -e "$LAB_SKILLS/scripts" ] && [ "$(estado "d['repoint']['applied'] is not None")" = True ] \
        && ok "T38 (repointed) los dos clones vuelven al MISMO commit, y el de skills sigue re-apuntado y mostrando sólo lo suyo" || mal "T38 (repointed) después del rollback: origin $(harness_lab_git "$LAB_SKILLS" remote get-url origin), repoint $(estado "d.get('repoint')")"
    fi
    harness rollback --release >/dev/null 2>&1
    estado_set "d['last_fetch']=None"
    harness update >/dev/null 2>&1
    [ "$(head_de "$LAB_TREE")" = "$B_T" ] && [ "$(head_de "$LAB_SKILLS")" = "$B_S" ] && ok "T38 ($shape) levantada la retención, update vuelve a subir las fuentes" || mal "T38 ($shape) después de --release: arnés $(head_de "$LAB_TREE") vs $B_T, skills $(head_de "$LAB_SKILLS") vs $B_S"
  done
fi

# ── T28 Rollback_ToFixedCommitBeforeStory_BothResolve_ImportDeduped (story 8.19, tanda B · AC 20) ────────────────────
# Una máquina mudada (`relocate`) que vuelve al código de ANTES de la story 8.19 —el commit fijado, que sólo conoce el
# nombre viejo— sigue andando: los dos nombres resuelven al árbol y no aparece un hook repetido. Ese código viejo agrega
# su línea de CLAUDE.md (no conoce la del lugar); al volver al código nuevo, `install` deja una sola. La versión vieja se
# pone en el árbol del laboratorio tal como la deja una vuelta atrás a ella (el programa y la biblioteca del enlace de
# ese commit). Sin ese commit en el clon (un CI superficial): «no medido», no verde.
T28_FIXED=ea450ae0
if ! git -C "$RAIZ" cat-file -e "${T28_FIXED}^{commit}" 2>/dev/null; then
  echo "  ⏭ T28 NO MEDIDO — el commit fijado ${T28_FIXED} (anterior a la story 8.19) no está en este clon"
else
  harness_lab_create "$BASE/lab28" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "T28 install previo falló"
  T28_PN="$(node -p "require('$RAIZ/scripts/setup/harness/place.js').PLACE_NAME")"
  T28_LN="$(node -p "require('$RAIZ/scripts/setup/harness/place.js').LEGACY_PLACE_NAME")"
  t28_both() { node -e 'const fs=require("fs");const [h,t,a,b]=process.argv.slice(1);const r=(p)=>{try{return fs.realpathSync(p)}catch(_){return null}};process.stdout.write(String(r(h+"/.claude/"+a)===fs.realpathSync(t)&&r(h+"/.claude/"+b)===fs.realpathSync(t)))' "$LAB_HOME" "$LAB_TREE" "$T28_PN" "$T28_LN"; }
  t28_repeated() { harness_lab_settings_commands | sort | uniq -d | wc -l | tr -d ' '; }
  t28_lines() { grep -cxF -e "@~/.claude/$T28_PN/README.md" -e "@~/.claude/$T28_LN/README.md" "$CLAUDE_MD_PATH"; }
  # la máquina como la deja esta story: los dos nombres, y lo registrado por el viejo mudado a mano
  node -e 'const fs=require("fs");const [t,p,o]=process.argv.slice(1);const ty=process.platform==="win32"?"junction":"dir";for(const a of [p,o]){try{fs.unlinkSync(a)}catch(_){try{fs.rmdirSync(a)}catch(_){}}}fs.symlinkSync(t,p,ty);fs.symlinkSync(p,o,ty)' "$LAB_TREE" "$LAB_HOME/.claude/$T28_PN" "$LAB_HOME/.claude/$T28_LN"
  printf '@~/.claude/%s/README.md\n' "$T28_LN" > "$CLAUDE_MD_PATH"
  harness relocate >/dev/null 2>&1; RC=$?
  T28_HOOKS="$(harness_lab_settings_commands | wc -l | tr -d ' ')"
  [ "$RC" = 0 ] && [ "$(t28_lines)" = 1 ] && grep -qxF "@~/.claude/$T28_PN/README.md" "$CLAUDE_MD_PATH" && ok "T28 la máquina mudada: relocate 0 y una línea, la del lugar" || mal "T28 relocate rc $RC: $(cat "$CLAUDE_MD_PATH")"
  # el código de antes de la story, en el árbol
  for f in $(git -C "$RAIZ" ls-tree --name-only "$T28_FIXED" scripts/setup/harness/) scripts/setup/harness.js scripts/lib/canonical-path.js; do
    git -C "$RAIZ" show "$T28_FIXED:$f" > "$LAB_TREE/$f"
  done
  # el install de ese commit no conoce --yes (no mostraba un plan): se corre sin terminal
  harness install </dev/null >/dev/null 2>&1; RC=$?
  harness startup >/dev/null 2>&1
  [ "$RC" = 0 ] && [ "$(t28_both)" = true ] && [ "$(t28_repeated)" = 0 ] && [ "$(harness_lab_settings_commands | wc -l | tr -d ' ')" = "$T28_HOOKS" ] \
    && ok "T28 con el código de antes de la story: arranca, los dos nombres resuelven al árbol, la misma cuenta de hooks y ninguno repetido" \
    || mal "T28 código viejo: install rc $RC, los dos=$(t28_both), repetidos=$(t28_repeated), hooks $(harness_lab_settings_commands | wc -l | tr -d ' ') (antes $T28_HOOKS)"
  echo "  · T28 el código viejo dejó $(t28_lines) línea(s) de arranque del arnés en CLAUDE.md"
  # de vuelta al código nuevo
  harness_lab_git "$LAB_TREE" checkout -q -- scripts/setup scripts/lib
  harness install --yes >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && [ "$(t28_lines)" = 1 ] && grep -qxF "@~/.claude/$T28_PN/README.md" "$CLAUDE_MD_PATH" && [ "$(t28_both)" = true ] && [ "$(t28_repeated)" = 0 ] \
    && ok "T28 de vuelta al código nuevo: una sola línea (la del lugar), los dos nombres resuelven, ningún hook repetido" \
    || mal "T28 de vuelta: rc $RC, líneas $(t28_lines): $(cat "$CLAUDE_MD_PATH" | tr '\n' ' '), los dos=$(t28_both), repetidos=$(t28_repeated)"
fi

if [ "$FALLOS" = 0 ]; then echo "✅ harness-rollback: todo verde"; exit 0; fi
echo "❌ harness-rollback: $FALLOS fallo(s)"; exit 1
