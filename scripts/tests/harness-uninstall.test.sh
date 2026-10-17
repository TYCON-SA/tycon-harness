#!/usr/bin/env bash
# harness-uninstall.test.sh — lo que el aplicador deja en la máquina, registrado pieza por pieza (story 8.13). La tanda C
# suma acá los casos de `harness.js uninstall` (que sólo saca lo registrado): este archivo es la red de las dos mitades.
#
# Lo que no se puede perder:
#   T18 · Applier_ReportJson_AgainstDeclaredList_Ps1ByReading (tanda B, AC 15) — el `install-tycon-hooks.sh` REAL en un HOME
#         de juguete, con todo prendido y con todo apagado, escribe con `--report-json <archivo>` un arreglo
#         `[{kind, where, id}]` sin duplicados; cada pieza casa con la lista declarada
#         (`scripts/tests/fixtures/harness-managed-pieces.json`) y ninguna con sus exclusiones; con todo apagado no aparece
#         ninguna de una integración ni de un opt-in, y aparecen todas las que corren siempre; con todo prendido aparecen
#         las de las integraciones y los opt-in. Con `--check` no se escribe el reporte. Sin la opción, la salida y lo que
#         queda en el disco son los de siempre, byte a byte. El `.ps1` por lectura: acepta la opción (`-ReportJson` y
#         `--report-json`), tiene `Record-Piece` en los sitios que la lista marca `windows: true` (y no en los `false`), y
#         escribe el reporte también en su salida temprana. Tanda D (AC 28): las piezas COMPARTIDAS (`when: shared` en la
#         lista: `cleanupPeriodDays`, la variable de `env`, los comandos) las reporta el `.sh` suelto, o las hace y las
#         anota `harness.js` (y entonces el reporte del `.sh` no las trae): el verificador acepta los dos lados sin
#         confundirlos, y el `.ps1` no las anota (en Windows son de `harness.js`).
#   T21 · Applier_NoLegacyBakUnderHarness_YesStandalone (tanda B, AC 18; la parte del aplicador `.sh` y del reparador de la
#         línea de arranque — la de sync-claude-md-blocks y los `.ps1` está en sync-codex-detection.test.sh) — con
#         `TYCON_HARNESS_SNAPSHOT_DIR` puesta no quedan `.bak` propios (settings.json, CLAUDE.md, pre-commit, post-commit);
#         suelto, sí, como hoy.
#   T26 · Uninstall_OnlyManaged_NeverVersionedInOtherRepo_WorksWithoutTree (tanda C, AC 22) — en tres partes: (a)
#         `remove.js` unitario (cada tipo de pieza, lo ajeno y su orden intactos, un ajuste cambiado por el dev se queda,
#         el `.local` vuelve, nunca tira); (b) `uninstall.js` directo sobre una instalación REAL (`harness.js install` con
#         el aplicador real en un HOME de juguete, sobre una copia descartable del árbol): plan, quita, deja, revisalo,
#         sin árbol, segunda corrida; (c) de punta a punta por `harness.js uninstall` y la copia fija
#         (`bootstrap.js uninstall --yes` con el clon borrado), `--dry-run`, sin `--yes` y sin terminal → 2 sin tocar
#         nada, «nada que quitar» y `doctor` «no instalado».
#   T27 · Uninstall_ByteForByte_AliensAndLocalHookIntact (tanda C, AC 23) — settings.json con hooks ajenos y formato
#         propio, CLAUDE.md con texto propio, ~/.claude/skills carpeta real, un pre-commit propio (el aplicador lo pasa
#         a .local), un repo de producto con AGENTS.md puntero; install → se borra el clon → uninstall --yes: settings.json
#         y CLAUDE.md iguales por `cmp` a los de antes de instalar, la skill sigue, el pre-commit vuelve, el AGENTS.md
#         sigue y sale en la lista, doctor «no instalado». Directo con el módulo y de punta a punta por la copia fija.
#   REG · las regresiones del pase adversarial de la tanda C (directo con los módulos, HOME de juguete, segundos):
#         REG-H1 (una pieza que no se pudo leer no se pierde: `run` sale ok:false y el estado queda con ella),
#         REG-H6 (un comando que el dev cambió queda aunque el árbol ya no lo traiga), REG-H7 (los repos que son enlaces a
#         carpetas también se miran por AGENTS.md puntero), REG-H13 (un hook del arnés con texto alrededor sale en
#         «revisalo», no desaparece), REG-H14 (`$HOME/…` o `~/…` que no es una raíz del arnés es ajeno), REG-H15
#         (hooks.json/config.toml de Codex se borran sólo si siguen como los dejó la instalación), REG-R1 (`file` y `codex`
#         fuera de su raíz no se borran), REG-R2 (un ajuste con su valor sin cambiar sí se quita).
#   K3  · Uninstall_SingleRepo_LinksIntoTheTree (story 8.7, tanda C · decisión C3) — en el repo único (skills/ y agents/ en
#         la raíz del clon) `uninstall --yes` quita ~/.claude/agent-skills, agents y skills cuando son enlaces al clon; con
#         skills/ y agents/ como carpetas reales quita los enlaces por entrada y deja la carpeta y lo propio; un enlace
#         colgado que apuntaba adentro de un clon borrado también se va; uno que apunta a OTRO lado no se toca (espejo).
#         Módulos directo y de punta a punta con el aplicador real.
#
# Aislamiento (el patrón de installer-cleanup-period.test.sh): HOME de juguete con un agent-skills de juguete (archivos
# vacíos en las rutas que pide el set canónico, nunca un enlace al real), sin perfil del equipo (TYCON_PROFILE=0), sin
# Codex, sin el examen ni launchd, sin la tanda de fondo, sin red. Nunca ~/.claude ni el checkout real.
# 🔴 Sin pipes sobre el comando medido: el exit code REAL es el veredicto.
#
#   T38 · (story 8.18, AC 37) `uninstall` en las tres formas de máquina que deja la unión de los dos repos: quita sólo lo
#         registrado y NO borra el clon viejo de skills ni toca su remoto — tampoco el re-apuntado, que queda re-apuntado.
#
# Uso: bash scripts/tests/harness-uninstall.test.sh [--only T18|T21|T26|T27|K3|REG|T38|S16]
#   S16 · (story 8.16, tanda A · AC 6) «deja» nombra ~/.claude/response-style/ y ~/.claude/safety-guard.log cuando existen.
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INST="$RAIZ/scripts/install-tycon-hooks.sh"
PS1="$RAIZ/scripts/install-tycon-hooks.ps1"
SYNC_PS1="$RAIZ/scripts/setup/sync-claude-md-blocks.ps1"
HEAL="$RAIZ/scripts/hooks/harness-bootstrap-heal.sh"
FIX="$RAIZ/scripts/tests/fixtures/harness-managed-pieces.json"
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
T="$(mktemp -d)"
node "$RAIZ/scripts/tests/lib/lab-guard.js" "$T" harness-uninstall || exit 1
trap 'rm -rf "$T"' EXIT
[ -f "$FIX" ] || { echo "❌ harness-uninstall: falta la lista declarada $FIX"; exit 1; }

# ── el HOME de juguete ─────────────────────────────────────────────────────────────────────────────────────────────
# agent-skills con un archivo vacío por cada hook de la lista que vive ahí (sin `@tcg:`), así el set canónico entero queda
# registrado y nada sale MISENV_UNSETG; y el estado del mecanismo ya escrito, para que el aplicador no lance `install --from-existing`.
new_home() { # new_home <dir>
  rm -rf "$1"; mkdir -p "$1/.claude/agent-skills/skills/tycon-pipeline" "$1/.claude/.tycon-pipeline"
  python3 - "$FIX" "$1/.claude/agent-skills/skills" <<'PY'
import json, os, sys
fix, skills = sys.argv[1], sys.argv[2]
for p in json.load(open(fix, encoding="utf-8"))["pieces"]:
    if p["kind"] != "hook" or "id" not in p or p["when"] == "platform:windows":
        continue
    rel = p["id"].split(":", 1)[1]
    if rel.startswith("@tcg:"):
        continue
    os.makedirs(os.path.dirname(os.path.join(skills, rel)), exist_ok=True)
    open(os.path.join(skills, rel), "a").close()
PY
  echo '{}' > "$1/.claude/.tycon-pipeline/harness-state.json"
}

# Lo que se borra del ambiente de quien corre la suite (podría estar corriendo bajo harness.js, o con sus interruptores).
ENV_UNSET=(-u TYCON_SETTINGS_PATH -u CLAUDE_MD_PATH -u CODEX_AGENTS_MD_PATH -u TYCON_HARNESS_SNAPSHOT_DIR -u TYCON_REPORT_PIECES
     -u TYCON_HARNESS_LOCK_HELD -u TYCON_HARNESS_SHARED_DONE -u TYCON_NO_AUTOINSTALL -u TYCON_NO_CLAUDEMD_SYNC -u TYCON_NO_COMMANDS_SYNC
     -u TYCON_NO_GIT_HOOKS -u TYCON_THIRD_PARTY -u TYCON_ENGRAM_HOOK -u TYCON_SAFETY_GUARD -u TYCON_TEST_SCOPE_GUARD
     -u TYCON_SESSION_GUARD -u TYCON_TG_ZOMBIE_SWEEP -u TYCON_CLOCKIFY -u TYCON_ENGRAM -u TYCON_NIGHTLY -u TYCON_ADO_ORG
     -u ADO_ORG -u TYCON_REPOS_ROOT -u TF_BUILD -u XDG_CONFIG_HOME -u TYCON_GUIDES_DIR -u TYCON_SKILLS_DIR
     -u CLAUDE_CODE_PLUGIN_DIRS)
# 🔴 CLAUDE_CODE_PLUGIN_DIRS (2026-10-15): desde la 7.27 el instalador la pone en cada máquina con el arnés (la carpeta de
#    sus mods), y la instalación SUMA lo que trae la terminal cuando settings.json no la tiene (plugin-dirs.js, addDir con
#    `inherited`). Heredada, la instalación de prueba anotaba la carpeta de mods DE VERDAD de quien corre la suite; la
#    desinstalación saca sólo la propia y T26/T27 salían con 4 MAL en cualquier máquina con el arnés instalado.
base() { # base <home> → el ambiente aislado común (en el arreglo RUN_ENV)
  # TYCON_PARITY_BENCH_DIR: con el perfil completo el instalador lanza de fondo el chequeo de paridad, que en un clon deja
  # su reporte en scripts/controls-bench/.bench/ del árbol (lo que corre a la vez lo ve); acá va a la carpeta de la suite
  RUN_ENV=(env "${ENV_UNSET[@]}" HOME="$1" TYCON_PROFILE=0 TYCON_INSTALL_PROFILE=full TYCON_PARITY_BENCH_DIR="$T/parity-bench" TYCON_CODEX=0 CODEX_HOME="$1/.codex" TYCON_GIT_HOOKS_DIR="$1/.git-hooks"
       TYCON_NO_NIGHTLY_EXAM=1 TYCON_NO_GUI_ENV=1 LAUNCHCTL_BIN=/usr/bin/true TYCON_BENCH_DAILY=0 TYCON_STAGE_METRICS=0
       TYCON_NO_THREAD_RESCUE=1 TYCON_NO_UPLOAD_RUNS=1 TYCON_NO_DOWNLOAD_RUNS=1 TYCON_NO_COLLECT_FINDINGS=1
       TYCON_MAILBOX_URL_BASE=http://127.0.0.1:9 TYCON_NO_AZ_PROJECTS_REFRESH=1 TYCON_NO_ENGRAM_VERSION_CHECK=1
       TYCON_NO_SQLITE_CHECK=1 TYCON_NO_ENGRAM_PROJECT_CHECK=1 TYCON_NO_AGENTSMD_POINTER=1 TYCON_NO_CANONICAL_PATH=1
       TYCON_THIRD_PARTY_NETWORK_BUDGET_S=1 GIT_CONFIG_NOSYSTEM=1)
}
# todo apagado: ninguna integración (sin perfil) y los opt-in que nacen prendidos, apagados. El buzón se apaga explícito:
# en el árbol del equipo (el privado con el público debajo) su llave lo prende sola, y desde que hay un hook que depende de
# él (owner-email-notice.js) «sin perfil» ya no alcanza para que quede apagado.
all_off() { base "$1"; RUN_ENV+=(TYCON_MAILBOX=0 TYCON_SAFETY_GUARD=0 TYCON_TEST_SCOPE_GUARD=0 TYCON_SESSION_GUARD=0); }
# todo prendido: clockify, engram y nocturnos por variable; los seis opt-in (el de Telegram por su plugin en el disco); el
# espejo de Codex por el disco (un AGENTS.md con bloques del arnés: el despliegue de Codex no corre en una prueba) y una
# skill de terceros ya restituida en el estado. Azure DevOps también (story 8.7, AC 25): el bloque de CLAUDE.md que la
# requiere (`<!-- requires-integration: ado -->`) sólo se escribe con ella prendida; el refresco de proyectos sigue apagado
# por TYCON_NO_AZ_PROJECTS_REFRESH (base).
all_on() {
  base "$1"; RUN_ENV+=(TYCON_CLOCKIFY=1 TYCON_ENGRAM=1 TYCON_NIGHTLY=1 TYCON_SESSION_GUARD=1 TYCON_ADO_ORG=https://dev.azure.com/acme)
  mkdir -p "$1/.claude/plugins/cache/claude-plugins-official/telegram" "$1/.codex" "$1/.claude/agent-skills/skills/lab-skill"
  printf '# de Codex\n<!-- TYCON_BLOCK:response-style START -->\nVIEJO\n<!-- TYCON_BLOCK:response-style END -->\n' > "$1/.codex/AGENTS.md"
  printf '{"version":1,"entries":{"skills/lab-skill":{"tree":"0000","complete":true,"files":{}}},"notices":{}}\n' \
    > "$1/.claude/.tycon-pipeline/third-party-state.json"
}

# verifica <lista> <reporte> <mode on|off> <home> <árbol> [applier|harness] → imprime «MAL: …» por cada problema; sale 1 si
# hubo alguno. El 6º argumento dice quién hizo las piezas COMPARTIDAS (`when: shared`): `applier` (por defecto: el .sh
# corrió suelto y las tiene que reportar) o `harness` (las hizo y las anotó harness.js: el reporte del .sh no las trae).
cat > "$T/verify.py" <<'PY'
import glob, json, os, re, sys
fix_path, report_path, mode, home, tree = sys.argv[1:6]
shared_by = sys.argv[6] if len(sys.argv) > 6 else "applier"
if shared_by not in ("applier", "harness"):
    print("MAL: el 6º argumento es applier o harness, no %r" % shared_by); sys.exit(1)
fix = json.load(open(fix_path, encoding="utf-8"))
bad = []
try:
    rep = json.load(open(report_path, encoding="utf-8"))
except Exception as e:
    print("MAL: el reporte no es JSON legible: %s" % e); sys.exit(1)
if not isinstance(rep, list):
    print("MAL: el reporte no es un arreglo"); sys.exit(1)
seen = set()
for p in rep:
    # un `setting` lleva además `value` (el valor JSON que escribió el arnés: F4 del pase adversarial); las demás, sólo tres
    keys = {"kind", "where", "id", "value"} if isinstance(p, dict) and p.get("kind") == "setting" else {"kind", "where", "id"}
    if not (isinstance(p, dict) and set(p) == keys and all(isinstance(p[k], str) and p[k] for k in ("kind", "where", "id"))):
        bad.append("pieza con otra forma: %r" % (p,)); continue
    if not os.path.isabs(p["where"]):
        bad.append("where no absoluto: %r" % (p,))
    key = (p["kind"], p["where"], p["id"])
    if key in seen:
        bad.append("pieza duplicada: %r" % (p,))
    seen.add(key)

def matches(decl, p):
    if decl["kind"] != p["kind"]:
        return False
    if "id" in decl and decl["id"] != p["id"]:
        return False
    if "id_pattern" in decl and not re.search(decl["id_pattern"], p["id"]):
        return False
    return bool(re.search(decl["where_pattern"], p["where"]))

found = []
for p in rep:
    if not isinstance(p, dict) or "kind" not in p:
        continue
    decls = [d for d in fix["pieces"] if matches(d, p)]
    if not decls:
        bad.append("pieza NO declarada en la lista: %s %s (%s)" % (p.get("kind"), p.get("id"), p.get("where"))); continue
    d = decls[0]
    if "value" in d and p.get("value") != d["value"]:
        bad.append("el setting %s trae value=%r y el arnés escribe %r" % (p["id"], p.get("value"), d["value"]))
    if d["when"] in ("harness.js", "platform:windows"):
        bad.append("el aplicador .sh reportó una pieza que no es suya (%s): %s %s" % (d["when"], p["kind"], p["id"]))
    if d["when"] == "shared" and shared_by == "harness":
        bad.append("bajo harness.js el aplicador reportó una pieza compartida (la hace y la anota harness.js): %s %s" % (p["kind"], p["id"]))
    if mode == "off" and (d["when"].startswith("integration:") or d["when"].startswith("optin:")):
        bad.append("con todo apagado apareció una pieza de %s: %s %s" % (d["when"], p["kind"], p["id"]))
    for ex in fix["excluded"]:
        if "where_pattern" in ex and re.search(ex["where_pattern"], p["where"]) and ex.get("kind", p["kind"]) == p["kind"]:
            bad.append("apareció una exclusión (%s): %s %s" % (ex["what"], p["kind"], p["where"]))
    found.append(p)

have = {(p["kind"], p["id"]) for p in found}
want = set()
on_whens = {"always"} if mode == "off" else {"always", "integration:clockify", "integration:engram", "integration:nightly",
    "optin:TYCON_SAFETY_GUARD", "optin:TYCON_TEST_SCOPE_GUARD", "optin:telegram-plugin", "optin:TYCON_SESSION_GUARD"}
if shared_by == "applier":
    on_whens.add("shared")   # suelto, las compartidas son suyas: las tiene que seguir reportando (No-regresión, AC 28)
for d in fix["pieces"]:
    if "id" in d and d["when"] in on_whens:
        want.add((d["kind"], d["id"]))
requires_re = re.compile(r"^<!--\s*requires-integration:\s*[a-z]+\s*-->\s*$")
for b in glob.glob(os.path.join(tree, "claude-md-blocks", "*.md")):
    block = ("block", "TYCON_BLOCK:" + os.path.splitext(os.path.basename(b))[0])
    # un bloque que requiere una integración (story 8.7, AC 25: su primera línea es el marcador) se escribe sólo con ella
    # prendida: con todo apagado NO tiene que estar en el reporte; con todo prendido, sí (las dos caras)
    first = open(b, encoding="utf-8").readline().rstrip("\n")
    if requires_re.match(first) and mode == "off":
        if block in have: bad.append("con todo apagado apareció el bloque de una integración: %s" % block[1])
        continue
    want.add(block)
if shared_by == "applier":   # los comandos son una pieza compartida: bajo harness.js los copia y los anota él
    for c in glob.glob(os.path.join(tree, "commands", "*.md")):
        want.add(("command", os.path.basename(c)))
if mode == "on":
    want |= {("codex", "AGENTS.md"), ("third-party", "lab-skill")}
for k in sorted(want - have):
    bad.append("falta en el reporte: %s %s" % k)
for b in bad:
    print("MAL: " + b)
print("piezas: %d" % len(found))
sys.exit(1 if bad else 0)
PY

if corre T18; then
  echo "T18 · Applier_ReportJson_AgainstDeclaredList_Ps1ByReading"
  H="$T/casa"

  # 1. todo apagado
  new_home "$H"; all_off "$H"
  rc=0; "${RUN_ENV[@]}" bash "$INST" --report-json "$H/reporte.json" > "$T/salida-off.txt" 2>&1 || rc=$?
  if [ "$rc" != "0" ]; then
    mal "T18 con todo apagado el aplicador salió $rc"; sed 's/^/        /' "$T/salida-off.txt" | tail -20
  elif [ ! -f "$H/reporte.json" ]; then
    mal "T18 con todo apagado y --report-json no escribió el reporte"
  elif python3 "$T/verify.py" "$FIX" "$H/reporte.json" off "$H" "$RAIZ" > "$T/v-off.txt"; then
    ok "T18 todo apagado: cada pieza casa con la lista, ninguna exclusión ni integración, están las que corren siempre ($(tail -1 "$T/v-off.txt"))"
  else
    mal "T18 todo apagado: el reporte no casa con la lista declarada"; grep '^MAL' "$T/v-off.txt" | head -15 | sed 's/^/        /'
  fi

  # 1b. las piezas COMPARTIDAS (tanda D, AC 28: `when: shared` — cleanupPeriodDays, la variable de env y los comandos) las
  #     reporta el .sh cuando corre suelto, o las hace y las anota harness.js (y entonces el reporte del .sh NO las trae).
  #     El verificador acepta los dos lados y no los confunde: su 6º argumento dice quién las hizo (`applier`, por
  #     defecto, o `harness`). Acá se prueba el verificador con el reporte real de arriba, entero y sin las compartidas.
  # 🔴 rojo previo: con la lista ya en `shared` y el verificador de antes, un reporte SIN las compartidas pasaba como
  #    suelto («falta en el reporte» dejó de mirar los dos ajustes) y uno CON ellas pasaba como «bajo harness.js».
  if [ -f "$H/reporte.json" ]; then
    python3 - "$FIX" "$H/reporte.json" "$T/reporte-sin-compartidas.json" <<'PY'
import json, re, sys
fix = json.load(open(sys.argv[1], encoding="utf-8"))
shared = [d for d in fix["pieces"] if d["when"] == "shared"]
def is_shared(p):
    return any(d["kind"] == p["kind"] and (d.get("id") == p["id"] or ("id_pattern" in d and re.search(d["id_pattern"], p["id"]))) for d in shared)
rep = json.load(open(sys.argv[2], encoding="utf-8"))
json.dump([p for p in rep if not is_shared(p)], open(sys.argv[3], "w", encoding="utf-8"))
PY
    cp "$H/reporte.json" "$T/reporte-suelto.json"
    n_shared=$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))) - len(json.load(open(sys.argv[2]))))" "$T/reporte-suelto.json" "$T/reporte-sin-compartidas.json")
    [ "$n_shared" -ge 3 ] && ok "T18 suelto, el reporte del .sh trae las piezas compartidas (${n_shared}: los dos ajustes y los comandos)" \
      || mal "T18 suelto, el reporte del .sh trae ${n_shared} piezas compartidas (esperado: los dos ajustes y al menos un comando)"
    if python3 "$T/verify.py" "$FIX" "$T/reporte-sin-compartidas.json" off "$H" "$RAIZ" applier > "$T/v-1b-a.txt"; then
      mal "T18 suelto, un reporte SIN las piezas compartidas pasó la verificación (suelto las tiene que seguir reportando)"
    else
      grep -q "falta en el reporte: setting cleanupPeriodDays" "$T/v-1b-a.txt" && grep -q "falta en el reporte: command " "$T/v-1b-a.txt" \
        && ok "T18 suelto, un reporte sin las piezas compartidas no pasa: «falta en el reporte» nombra los ajustes y los comandos" \
        || { mal "T18 suelto, el reporte sin las compartidas falló por otra cosa"; grep '^MAL' "$T/v-1b-a.txt" | head -5 | sed 's/^/        /'; }
    fi
    python3 "$T/verify.py" "$FIX" "$T/reporte-sin-compartidas.json" off "$H" "$RAIZ" harness > "$T/v-1b-b.txt" \
      && ok "T18 bajo harness.js (las hizo él), un reporte del .sh sin las piezas compartidas casa con la lista" \
      || { mal "T18 bajo harness.js, un reporte del .sh sin las piezas compartidas no casa con la lista"; grep '^MAL' "$T/v-1b-b.txt" | head -5 | sed 's/^/        /'; }
    if python3 "$T/verify.py" "$FIX" "$T/reporte-suelto.json" off "$H" "$RAIZ" harness > "$T/v-1b-c.txt"; then
      mal "T18 bajo harness.js, un reporte del .sh CON las piezas compartidas pasó la verificación (las anota harness.js, no el .sh)"
    else
      grep -q "bajo harness.js el aplicador reportó una pieza compartida" "$T/v-1b-c.txt" \
        && ok "T18 bajo harness.js, un reporte del .sh que trae una pieza compartida no pasa (la anota harness.js, no el .sh)" \
        || { mal "T18 bajo harness.js, el reporte con las compartidas falló por otra cosa"; grep '^MAL' "$T/v-1b-c.txt" | head -5 | sed 's/^/        /'; }
    fi
  fi

  # 1c. …y con una corrida REAL (T36): el .sh lanzado como lo lanza un harness.js que YA hizo las piezas compartidas
  #     (TYCON_HARNESS_SHARED_DONE=1, con el candado) entrega un reporte que casa con la lista «bajo harness.js» —sin
  #     ellas— y no deja ninguna de las tres en la máquina. El espejo: con sólo el candado (un programa viejo, que no
  #     conoce la variable) el reporte casa como suelto.
  # 🔴 rojo previo (medido con un .sh que no conoce la variable): «bajo harness.js el aplicador reportó una pieza
  #    compartida (la hace y la anota harness.js): setting cleanupPeriodDays», y lo mismo por la de env y cada comando.
  new_home "$H"; all_off "$H"
  rc=0; "${RUN_ENV[@]}" TYCON_HARNESS_LOCK_HELD=1 TYCON_HARNESS_SHARED_DONE=1 bash "$INST" --report-json "$H/reporte.json" > "$T/salida-1c.txt" 2>&1 || rc=$?
  if [ "$rc" = "0" ] && [ -f "$H/reporte.json" ] && python3 "$T/verify.py" "$FIX" "$H/reporte.json" off "$H" "$RAIZ" harness > "$T/v-1c.txt"; then
    ok "T18 corrida real bajo harness.js (TYCON_HARNESS_SHARED_DONE=1): el reporte casa con la lista sin las piezas compartidas ($(tail -1 "$T/v-1c.txt"))"
  else
    mal "T18 corrida real bajo harness.js (rc $rc): el reporte no casa con la lista"; grep '^MAL' "$T/v-1c.txt" 2>/dev/null | head -8 | sed 's/^/        /'
  fi
  if [ ! -e "$H/.claude/commands" ] && ! grep -q -E 'cleanupPeriodDays|CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR' "$H/.claude/settings.json"; then
    ok "T18 …y el .sh no dejó en la máquina ninguna de las tres (ni las dos claves ni ~/.claude/commands)"
  else
    mal "T18 bajo harness.js el .sh hizo igual una pieza compartida: commands=$(ls "$H/.claude/commands" 2>/dev/null | tr '\n' ' ') $(grep -E 'cleanupPeriodDays|CLAUDE_BASH_MAINTAIN' "$H/.claude/settings.json" | tr -d '\n')"
  fi
  new_home "$H"; all_off "$H"
  rc=0; "${RUN_ENV[@]}" TYCON_HARNESS_LOCK_HELD=1 bash "$INST" --report-json "$H/reporte.json" > "$T/salida-1c-lock.txt" 2>&1 || rc=$?
  if [ "$rc" = "0" ] && [ -f "$H/reporte.json" ] && python3 "$T/verify.py" "$FIX" "$H/reporte.json" off "$H" "$RAIZ" applier > "$T/v-1c-lock.txt"; then
    ok "T18 (espejo) corrida real con sólo TYCON_HARNESS_LOCK_HELD=1 (un programa viejo): el reporte trae las piezas compartidas, como suelto"
  else
    mal "T18 (espejo) con sólo el candado (rc $rc): el reporte no casa como suelto"; grep '^MAL' "$T/v-1c-lock.txt" 2>/dev/null | head -8 | sed 's/^/        /'
  fi

  # 2. todo prendido
  new_home "$H"; all_on "$H"
  rc=0; "${RUN_ENV[@]}" bash "$INST" --report-json "$H/reporte.json" > "$T/salida-on.txt" 2>&1 || rc=$?
  if [ "$rc" != "0" ]; then
    mal "T18 con todo prendido el aplicador salió $rc"; sed 's/^/        /' "$T/salida-on.txt" | tail -20
  elif [ ! -f "$H/reporte.json" ]; then
    mal "T18 con todo prendido y --report-json no escribió el reporte"
  elif python3 "$T/verify.py" "$FIX" "$H/reporte.json" on "$H" "$RAIZ" > "$T/v-on.txt"; then
    ok "T18 todo prendido: aparecen las integraciones, los opt-in, el espejo de Codex y la skill de terceros ($(tail -1 "$T/v-on.txt"))"
  else
    mal "T18 todo prendido: el reporte no casa con la lista declarada"; grep '^MAL' "$T/v-on.txt" | head -15 | sed 's/^/        /'
  fi

  # 3. una segunda corrida (nada que cambiar) reporta lo mismo: lo que ya estaba también es suyo
  if [ -f "$H/reporte.json" ]; then
    cp "$H/reporte.json" "$T/primera.json"
    rc=0; "${RUN_ENV[@]}" bash "$INST" --report-json "$H/reporte.json" > /dev/null 2>&1 || rc=$?
    if [ "$rc" = "0" ] && python3 -c "import json,sys; a,b=(sorted(map(json.dumps, json.load(open(f)))) for f in sys.argv[1:]); sys.exit(0 if a==b else 1)" "$T/primera.json" "$H/reporte.json"; then
      ok "T18 la segunda corrida, sin nada que escribir, reporta las mismas piezas (las que ya estaban)"
    else
      mal "T18 la segunda corrida reportó otras piezas (rc $rc)"
    fi
  fi

  # 4. con --check no escribe el reporte
  rm -f "$H/reporte-check.json"
  "${RUN_ENV[@]}" bash "$INST" --check --report-json "$H/reporte-check.json" > /dev/null 2>&1
  [ ! -e "$H/reporte-check.json" ] && ok "T18 con --check no se escribe el reporte" \
    || mal "T18 con --check se escribió el reporte"

  # 5. sin la opción, lo de siempre: la misma corrida con y sin --report-json, en el mismo HOME recién creado, da la misma
  #    salida y los mismos archivos (salvo el sello de hora de los .bak)
  normalize_ts() { sed -E 's/\.bak[.-][0-9T-]+/.bak.TS/g' "$1"; }
  tree_list() { (cd "$1" && find . -path ./reporte.json -prune -o \( -type f -o -type l \) -print | sed -E 's/\.bak[.-][0-9T-]+/.bak.TS/' | LC_ALL=C sort); }
  new_home "$H"; all_on "$H"; echo '{"hooks":{},"permissions":{"allow":[]}}' > "$H/.claude/settings.json"
  "${RUN_ENV[@]}" bash "$INST" > "$T/sin.txt" 2>&1
  cp "$H/.claude/settings.json" "$T/sin-settings.json"; cp "$H/.claude/CLAUDE.md" "$T/sin-claude.md" 2>/dev/null; tree_list "$H" > "$T/sin-tree_list.txt"
  new_home "$H"; all_on "$H"; echo '{"hooks":{},"permissions":{"allow":[]}}' > "$H/.claude/settings.json"
  "${RUN_ENV[@]}" bash "$INST" --report-json "$H/reporte.json" > "$T/con.txt" 2>&1
  tree_list "$H" > "$T/con-tree_list.txt"
  if [ "$(normalize_ts "$T/sin.txt")" = "$(normalize_ts "$T/con.txt")" ] && cmp -s "$T/sin-settings.json" "$H/.claude/settings.json" \
     && cmp -s "$T/sin-claude.md" "$H/.claude/CLAUDE.md" && cmp -s "$T/sin-tree_list.txt" "$T/con-tree_list.txt"; then
    ok "T18 sin --report-json la salida y lo que queda en el disco son los mismos que con la opción (y la opción sólo suma su archivo)"
  else
    mal "T18 --report-json cambió la salida o lo que el aplicador deja en el disco"
    diff <(normalize_ts "$T/sin.txt") <(normalize_ts "$T/con.txt") | head -8 | sed 's/^/        /'
    diff "$T/sin-tree_list.txt" "$T/con-tree_list.txt" | head -8 | sed 's/^/        /'
  fi

  # 6. el .ps1 por lectura
  if python3 - "$FIX" "$PS1" "$SYNC_PS1" > "$T/ps1.txt" <<'PY'
import json, re, sys
fix = json.load(open(sys.argv[1], encoding="utf-8"))
ps = open(sys.argv[2], encoding="utf-8").read()
sync = open(sys.argv[3], encoding="utf-8").read()
bad = []
if not re.search(r"\[Alias\('report-json'\)\]\s*\[string\]\$ReportJson", ps):
    bad.append("el .ps1 no acepta -ReportJson / --report-json")
for fn in ("Record-Piece", "Write-PieceReport"):
    if not re.search(r"function\s+%s\b" % fn, ps):
        bad.append("el .ps1 no define %s" % fn)
# los hooks que registra hoy, como los nombra el reporte: <EVENTO>:<spec> (con @tcg: los del repo de guías). Desde la
# story 8.17 (W3) salen de la lista única —lo que no excluye de Windows— y los anota el aplicador (apply-hooks.js), que
# el .ps1 lanza con --platform windows y con TYCON_REPORT_PIECES en el ambiente
import os
lst = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(sys.argv[2]))), "scripts", "setup", "hooks-list.json"), encoding="utf-8"))
reg = {"%s:%s" % (h["event"], h["spec"]) for h in lst["hooks"] if h.get("platforms", {}).get("windows") is not False}
for d in fix["pieces"]:
    if d["kind"] != "hook" or d["when"] == "harness.js":
        continue
    if d["windows"] and d["id"] not in reg:
        bad.append("la lista dice que Windows registra %s y el .ps1 no lo tiene" % d["id"])
    if not d["windows"] and d["id"] in reg:
        bad.append("la lista dice que Windows NO registra %s y el .ps1 lo tiene (la lista quedó vieja)" % d["id"])
if "apply-hooks.js" not in ps or "'--platform', 'windows'" not in ps:
    bad.append("el .ps1 no lanza apply-hooks.js con --platform windows (es quien registra y anota los hooks)")
if "$env:TYCON_REPORT_PIECES = $PiecesTmp" not in ps:
    bad.append("el .ps1 no le deja TYCON_REPORT_PIECES al aplicador: los hooks no se anotarían")
# por clase: las que Windows hace se anotan; las que no, no. Las compartidas (`when: shared`, tanda D) en Windows las hace
# y las anota harness.js, no el .ps1: su `windows: true` no le pide un Record-Piece, y si el .ps1 lo tuviera sería un error
kinds_win = {d["kind"] for d in fix["pieces"] if d["windows"] and d["when"] not in ("harness.js", "shared")}
kinds_no = {d["kind"] for d in fix["pieces"] if d["when"] != "harness.js"} - kinds_win
for k in sorted(kinds_win):
    if k in ("block", "hook"):   # los bloques los anota sync-claude-md-blocks.ps1 (abajo); los hooks, apply-hooks.js (arriba)
        continue
    if not re.search(r"Record-Piece\s+'%s'" % re.escape(k), ps):
        bad.append("Windows hace piezas «%s» y el .ps1 no las anota" % k)
for k in sorted(kinds_no):
    if re.search(r"Record-Piece\s+'%s'" % re.escape(k), ps):
        bad.append("el .ps1 anota «%s», que la lista dice que Windows no hace" % k)
# los bloques y el espejo los anota sync-claude-md-blocks.ps1, por la variable que le deja el aplicador
if "TYCON_REPORT_PIECES" not in ps:
    bad.append("el .ps1 no le pasa TYCON_REPORT_PIECES a sync-claude-md-blocks.ps1")
if not re.search(r"TYCON_REPORT_PIECES", sync) or not re.search(r"\"block`t", sync) or not re.search(r"\"codex`t", sync):
    bad.append("sync-claude-md-blocks.ps1 no anota sus bloques y su espejo en TYCON_REPORT_PIECES")
# una sola salida, al final, y con el reporte escrito antes (story 8.17, W4 · AC 30: ya no hay salida temprana cuando
# la lista de hooks no cambió; cada corrida llega al sync de bloques, que es quien anota los bloques en su lugar —el
# F10 del pase adversarial de la 8.13, que pedía anotarlos en la salida temprana, ya no aplica: no hay salida temprana)
body = ps[ps.index("$ApplyJs = Join-Path"):]
if re.search(r"if \(\$Added\.Count -eq 0 -and \$Removed\.Count -eq 0\)", body):
    bad.append("AC 30: el .ps1 todavía sale antes de tiempo cuando la lista de hooks no cambió")
if re.findall(r"(?m)^\s*exit 0\s*$", body):
    bad.append("después de los hooks, toda salida va por Exit-Installer (suelta el candado): hay un «exit 0» suelto")
if not re.search(r"Write-PieceReport\s*\nExit-Installer 0\s*$", body):
    bad.append("la salida final no escribe el reporte antes de Exit-Installer 0")
# con -Check no se escribe el reporte: el temporal ni existe
if not re.search(r"if \(\$ReportJson -and -not \$Check\)", ps):
    bad.append("con -Check no tiene que escribir el reporte (el temporal de piezas no tiene que existir)")
for b in bad:
    print("MAL: " + b)
sys.exit(1 if bad else 0)
PY
  then
    ok "T18 el .ps1 por lectura: acepta la opción, anota en los sitios que Windows hace (y no en los otros) y escribe el reporte en sus dos salidas"
  else
    mal "T18 el .ps1 por lectura no cumple"; grep '^MAL' "$T/ps1.txt" | sed 's/^/        /'
  fi
  # y si hay pwsh, que el .ps1 al menos se deje leer
  if command -v pwsh >/dev/null 2>&1; then
    if pwsh -NoProfile -Command "\$e=\$null; [void][System.Management.Automation.Language.Parser]::ParseFile('$PS1', [ref]\$null, [ref]\$e); if (\$e.Count) { \$e | % { \$_.Message }; exit 1 }" > "$T/parse.txt" 2>&1; then
      ok "T18 el .ps1 se deja leer por PowerShell (sin errores de sintaxis)"
    else
      mal "T18 el .ps1 tiene errores de sintaxis"; head -5 "$T/parse.txt" | sed 's/^/        /'
    fi
    # F10 por ejecución (con pwsh). Hasta la W4 el .ps1 salía antes del sync cuando la lista de hooks no cambiaba, y un
    # Record-BlocksInPlace anotaba ahí los bloques que ya estaban (F10 del pase adversarial de la tanda B; el seguimiento
    # de la W3a, punto 12, los anotaba también con \r\n). Desde la W4 (AC 30) no hay salida temprana: cada corrida llega
    # al sync de bloques, que es quien los anota. Se mide la corrida que importaba: la SEGUNDA, sin hooks nuevos, con el
    # CLAUDE.md en \r\n (un clon viejo) — tiene que anotar los mismos bloques que la primera, todos.
    # Con Azure DevOps prendido, fijo: el bloque que la requiere (story 8.7, AC 25) sólo se escribe con ella prendida.
    P10="$T/f10"; H10="$P10/home"; mkdir -p "$H10/.claude"
    f10_run() { # f10_run <reporte> — el .ps1 entero, suelto, en la casa de juguete
      env "${ENV_UNSET[@]}" HOME="$H10" USERPROFILE="$H10" TYCON_ADO_ORG=https://dev.azure.com/acme TYCON_NO_NIGHTLY_EXAM=1 TYCON_THIRD_PARTY=0 \
        TYCON_NO_AZ_PROJECTS_REFRESH=1 TYCON_NO_ENGRAM_VERSION_CHECK=1 TYCON_NO_SQLITE_CHECK=1 TYCON_NO_GIT_HOOKS=1 TYCON_HARNESS_LOCK_HELD=1 \
        CODEX_HOME="$H10/codex" pwsh -NoProfile -File "$PS1" -ReportJson "$1" > "$1.out" 2>&1
    }
    n_want=$(ls "$RAIZ"/claude-md-blocks/*.md | wc -l | tr -d ' ')
    f10_blocks() { node -e 'const r = require(process.argv[1]); console.log(r.filter((p) => p.kind === "block" && /TYCON_BLOCK:/.test(p.id)).length)' "$1" 2>/dev/null || echo 0; }
    f10_run "$P10/r1.json"
    python3 - "$H10/.claude/CLAUDE.md" <<'PY'
import sys
p = sys.argv[1]
t = open(p, encoding="utf-8", newline="").read()
open(p, "w", encoding="utf-8", newline="").write(t.replace("\r\n", "\n").replace("\n", "\r\n"))
PY
    f10_run "$P10/r2.json"
    n1=$(f10_blocks "$P10/r1.json"); n2=$(f10_blocks "$P10/r2.json")
    if [ "$n1" = "$n_want" ] && [ "$n2" = "$n_want" ] && ! grep -q '  + ' "$P10/r2.json.out"; then
      ok "T18 F10 la segunda corrida (sin hooks nuevos, CLAUDE.md en \\r\\n) llega al sync y anota los $n_want bloques, igual que la primera"
    else
      mal "T18 F10 bloques anotados: primera $n1, segunda $n2 (esperaba $n_want en las dos, sin hooks nuevos en la segunda)"; tail -5 "$P10/r2.json.out" | sed 's/^/        /'
    fi
  fi
fi

if corre T21; then
  echo "T21 · Applier_NoLegacyBakUnderHarness_YesStandalone (aplicador .sh y reparador de la línea de arranque)"
  H="$T/casa21"
  # la máquina con un settings.json, un CLAUDE.md del dev y un pre-commit/post-commit ajenos que ya tienen su .local
  # (el caso en que, suelto, el ajeno sólo sobrevive en el .bak)
  seed_machine() {
    new_home "$H"; all_off "$H"
    echo '{"hooks":{}}' > "$H/.claude/settings.json"; printf '# lo mío\n' > "$H/.claude/CLAUDE.md"
    mkdir -p "$H/.git-hooks"
    for g in pre-commit post-commit pre-push; do printf '#!/bin/sh\necho ajeno\n' > "$H/.git-hooks/$g"; printf '#!/bin/sh\n' > "$H/.git-hooks/$g.local"; done
  }
  list_baks() { find "$H/.claude" "$H/.git-hooks" -maxdepth 1 -name '*.bak*' 2>/dev/null | sed "s|$H/||" | LC_ALL=C sort | tr '\n' ' '; }

  # F11 (revisor de alcance): con el hook ajeno Y su .local ya puesto, el ajeno no tiene otro lugar que su .bak — la copia del
  # mecanismo rota tras 5 y se perdería —, así que ESE .bak se hace igual bajo harness.js, y el aviso lo dice como hoy.
  # Los demás (settings.json, CLAUDE.md) no.
  seed_machine; mkdir -p "$T/copia"
  "${RUN_ENV[@]}" TYCON_HARNESS_SNAPSHOT_DIR="$T/copia" bash "$INST" > "$T/t21-con.txt" 2>&1
  B="$(list_baks)"
  if [[ "$B" == ".git-hooks/post-commit.bak-"*" .git-hooks/pre-commit.bak-"*" .git-hooks/pre-push.bak-"*" " && "$B" != *settings.json* && "$B" != *CLAUDE.md* ]]; then
    ok "T21 bajo harness.js sólo quedan los .bak del hook ajeno que ya tenía .local (F11); ni settings.json ni CLAUDE.md"
  else
    mal "T21 bajo harness.js quedaron «${B}» (esperado sólo pre-commit.bak-*, post-commit.bak-* y pre-push.bak-*)"
  fi
  [ "$(grep -c 'el ajeno quedó en .bak' "$T/t21-con.txt")" = 3 ] && ok "T21 bajo harness.js el aviso del hook ajeno dice «.bak», como hoy" \
    || mal "T21 bajo harness.js el aviso del hook ajeno no dice dónde quedó (esperado «quedó en .bak» tres veces)"
  # y el resto de los casos de git hooks bajo harness.js no deja .bak: un pre-commit del arnés viejo (se pisa) y un
  # post-commit o un pre-push ajenos sin .local (pasan a .local, y el del arnés queda en su lugar)
  seed_machine; rm -f "$H/.git-hooks/post-commit.local" "$H/.git-hooks/pre-push.local"
  printf '#!/bin/sh\n# git-pre-commit-global.sh (versión vieja)\n' > "$H/.git-hooks/pre-commit"
  "${RUN_ENV[@]}" TYCON_HARNESS_SNAPSHOT_DIR="$T/copia" bash "$INST" > "$T/t21-local.txt" 2>&1
  B="$(list_baks)"
  [ -z "$B" ] && [ -f "$H/.git-hooks/post-commit.local" ] \
    && ok "T21 bajo harness.js un hook del arnés viejo o un ajeno sin .local no dejan .bak" \
    || mal "T21 bajo harness.js un hook del arnés viejo o un ajeno sin .local dejaron «${B}»"
  # el pre-push (story 8.26, tanda F1): el ajeno sigue corriendo desde .local, ejecutable; el del arnés queda puesto y se dice
  if grep -q 'echo ajeno' "$H/.git-hooks/pre-push.local" && [ -x "$H/.git-hooks/pre-push.local" ] && [ -x "$H/.git-hooks/pre-push" ] \
     && grep -q 'git-pre-push-global.sh' "$H/.git-hooks/pre-push" && grep -q '✓ pre-push global de git instalado' "$T/t21-local.txt"; then
    ok "T21 el pre-push ajeno pasa a pre-push.local (ejecutable) y el del arnés queda puesto"
  else
    mal "T21 el pre-push ajeno no quedó en pre-push.local, o el del arnés no quedó puesto"
  fi
  # 🔴 si la copia falla, NO dice «instalado»: una máquina que cree tener el freno y no lo tiene es peor que una que sabe que no
  seed_machine; rm -f "$H/.git-hooks/pre-push" "$H/.git-hooks/pre-push.local"; mkdir "$H/.git-hooks/pre-push"
  "${RUN_ENV[@]}" TYCON_HARNESS_SNAPSHOT_DIR="$T/copia" bash "$INST" > "$T/t21-falla.txt" 2>&1
  if grep -q 'NO pude instalar el pre-push global' "$T/t21-falla.txt" && ! grep -q '✓ pre-push global de git instalado' "$T/t21-falla.txt"; then
    ok "T21 si no se puede copiar el pre-push, el instalador lo dice y no anuncia «instalado»"
  else
    mal "T21 con la copia del pre-push fallida el instalador anunció «instalado» (o no dijo nada)"; grep -n 'pre-push' "$T/t21-falla.txt" | head -5
  fi
  rmdir "$H/.git-hooks/pre-push" 2>/dev/null || rm -rf "$H/.git-hooks/pre-push"
  # 🔴 si no puede CONSERVAR el pre-push de la persona, no lo pisa: decía «no pude conservar» y lo copiaba encima igual.
  # La carpeta sin permiso de escritura (no se puede renombrar adentro) con el archivo escribible (copiar encima sí se puede)
  # (primero una instalación normal: así el pre-commit y el post-commit ya son los del arnés y sus bloques no escriben nada)
  seed_machine; rm -f "$H/.git-hooks/pre-push" "$H/.git-hooks/pre-push.local"
  "${RUN_ENV[@]}" TYCON_HARNESS_SNAPSHOT_DIR="$T/copia" bash "$INST" > /dev/null 2>&1
  rm -f "$H"/.git-hooks/*.bak-* "$H/.git-hooks/pre-push.local"
  printf '#!/bin/sh\necho ajeno\n' > "$H/.git-hooks/pre-push"; chmod u+w "$H/.git-hooks/pre-push"; chmod a-w "$H/.git-hooks"
  if [ -w "$H/.git-hooks" ]; then
    chmod u+w "$H/.git-hooks"; ok "T21 (no medido: esta cuenta escribe igual en una carpeta sin permiso; el caso del pre-push que no se puede conservar no aplica)"
  else
    "${RUN_ENV[@]}" TYCON_HARNESS_SNAPSHOT_DIR="$T/copia" bash "$INST" > "$T/t21-sin-conservar.txt" 2>&1
    chmod u+w "$H/.git-hooks"
    if grep -q 'echo ajeno' "$H/.git-hooks/pre-push" && ! grep -q 'git-pre-push-global.sh' "$H/.git-hooks/pre-push" \
       && grep -q 'NO instalé el pre-push global' "$T/t21-sin-conservar.txt" && ! grep -q '✓ pre-push global de git instalado' "$T/t21-sin-conservar.txt"; then
      ok "T21 si no puede conservar el pre-push de la persona, no lo pisa y dice que el freno NO quedó puesto"
    else
      mal "T21 el instalador pisó un pre-push que no pudo conservar (o no lo dijo)"; grep -n 'pre-push' "$T/t21-sin-conservar.txt" | head -5
    fi
  fi
  # el del arnés con el contenido correcto y SIN permiso de ejecución: git no lo corre; el instalador se lo devuelve
  seed_machine; rm -f "$H/.git-hooks/pre-push" "$H/.git-hooks/pre-push.local"
  "${RUN_ENV[@]}" TYCON_HARNESS_SNAPSHOT_DIR="$T/copia" bash "$INST" > /dev/null 2>&1
  chmod a-x "$H/.git-hooks/pre-push"
  "${RUN_ENV[@]}" TYCON_HARNESS_SNAPSHOT_DIR="$T/copia" bash "$INST" > "$T/t21-sin-permiso.txt" 2>&1
  if [ -x "$H/.git-hooks/pre-push" ] && grep -q 'le faltaba el permiso de ejecución' "$T/t21-sin-permiso.txt"; then
    ok "T21 un pre-push del arnés sin permiso de ejecución lo recupera al volver a instalar (por contenido se daba por puesto)"
  else
    mal "T21 un pre-push del arnés sin permiso de ejecución quedó así"; grep -n 'pre-push' "$T/t21-sin-permiso.txt" | head -5
  fi
  # lanzado por harness.js (TYCON_HARNESS_LOCK_HELD=1) el aplicador no vuelve a llamar a `harness.js install
  # --from-existing`: el estado lo escribe quien lo lanzó; antes se escribía dos veces y quedaba una copia de más
  seed_machine; rm -f "$H/.claude/.tycon-pipeline/harness-state.json"   # sin estado: es el caso en que se anidaba
  "${RUN_ENV[@]}" TYCON_HARNESS_LOCK_HELD=1 TYCON_HARNESS_SNAPSHOT_DIR="$T/copia" bash "$INST" > /dev/null 2>&1
  [ ! -e "$H/.claude/.tycon-pipeline/harness-state.json" ] && [ ! -d "$H/.claude/.tycon-pipeline/harness/backups" ] \
    && ok "T21 bajo harness.js el aplicador no anida un install --from-existing (ni estado ni copia propios)" \
    || mal "T21 bajo harness.js el aplicador anidó un install --from-existing"
  # el gemelo de Windows, por lectura: Invoke-HarnessFromExisting vuelve sin hacer nada si lo lanzó harness.js
  python3 - "$RAIZ/scripts/install-tycon-hooks.ps1" <<'PY' && ok "T21 el .ps1 tampoco anida install --from-existing bajo harness.js (lectura)" || mal "T21 el .ps1 anida install --from-existing bajo harness.js (lectura)"
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"function Invoke-HarnessFromExisting \{(.*?)\n\}", src, re.S)
sys.exit(0 if m and re.search(r"TYCON_HARNESS_LOCK_HELD\s+-eq\s+'1'\)\s*\{\s*return", m.group(1)) else 1)
PY

  seed_machine
  "${RUN_ENV[@]}" bash "$INST" > /dev/null 2>&1
  B="$(list_baks)"
  case "$B" in
    *settings.json.bak.*CLAUDE.md.bak.*|*CLAUDE.md.bak.*settings.json.bak.*) c1=1 ;; *) c1=0 ;;
  esac
  if [ "$c1" = 1 ] && [[ "$B" == *pre-commit.bak-* && "$B" == *post-commit.bak-* && "$B" == *pre-push.bak-* ]]; then
    ok "T21 suelto, como hoy: settings.json, CLAUDE.md, pre-commit, post-commit y pre-push con su .bak"
  else
    mal "T21 suelto faltan .bak: quedaron «${B}»"
  fi

  # el reparador de la línea de arranque (tanda A): su python copiaba settings.json a .bak antes de agregar la llamada
  for mode in con sin; do
    new_home "$H"
    printf '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"cd ~/x/tycon-claude-guides && git pull"}]}]}}\n' > "$H/.claude/settings.json"
    if [ "$mode" = con ]; then
      env "${ENV_UNSET[@]}" HOME="$H" TYCON_NO_AUTOINSTALL=1 TYCON_HARNESS_SNAPSHOT_DIR="$T/copia" bash "$HEAL" > /dev/null 2>&1
    else
      env "${ENV_UNSET[@]}" HOME="$H" TYCON_NO_AUTOINSTALL=1 bash "$HEAL" > /dev/null 2>&1
    fi
    repaired=0; grep -q 'install-tycon-hooks.sh' "$H/.claude/settings.json" && repaired=1
    n=$(find "$H/.claude" -maxdepth 1 -name 'settings.json.bak*' | wc -l | tr -d ' ')
    if [ "$mode" = con ]; then
      [ "$repaired" = 1 ] && [ "$n" = 0 ] && ok "T21 el reparador bajo harness.js repara la línea sin dejar .bak" \
        || mal "T21 el reparador bajo harness.js: repaired=$repaired, .bak=$n (esperado 1 y 0)"
    else
      [ "$repaired" = 1 ] && [ "$n" = 1 ] && ok "T21 el reparador suelto repara la línea con su .bak, como hoy" \
        || mal "T21 el reparador suelto: repaired=$repaired, .bak=$n (esperado 1 y 1)"
    fi
  done
fi

# ── tanda C: la desinstalación (T26 y T27) ─────────────────────────────────────────────────────────────────────────────
# El laboratorio: el aplicador REAL y el `harness.js install` REAL en un HOME de juguete (new_home + base, como T18), sobre
# una COPIA DESCARTABLE del árbol de la rama (`git init` de scripts/ sin sus pruebas, claude-md-blocks/, commands/ y el
# README): así se puede borrar el clon, que es lo que el AC 22 pide probar. Nunca el clon real ni ~/.claude.
lab_tree() { # lab_tree <dir> → una copia del árbol bajo prueba, con git propio (sin el .git del clon)
  rm -rf "$1"; mkdir -p "$1"
  ( cd "$RAIZ" && tar cf - --exclude=scripts/tests --exclude=node_modules scripts claude-md-blocks commands README.md ) | ( cd "$1" && tar xf - )
  env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=Lab GIT_AUTHOR_EMAIL=lab@example.com \
    GIT_COMMITTER_NAME=Lab GIT_COMMITTER_EMAIL=lab@example.com sh -c \
    'git -C "$1" init -q -b main && git -C "$1" add -A && git -C "$1" -c core.hooksPath=/dev/null commit -q -m "arbol de laboratorio"' _ "$1"
}
# el agent-skills de juguete de new_home, con git propio: así el estado tiene sus dos fuentes, como en el equipo
lab_skills_repo() { # lab_skills_repo <home>
  env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=Lab GIT_AUTHOR_EMAIL=lab@example.com \
    GIT_COMMITTER_NAME=Lab GIT_COMMITTER_EMAIL=lab@example.com sh -c \
    'git -C "$1" init -q -b main && git -C "$1" add -A && git -C "$1" -c core.hooksPath=/dev/null commit -q -m "agent-skills de laboratorio"' _ "$1/.claude/agent-skills"
}
# un hash de todo el HOME de juguete (rutas, enlaces y contenido): «no tocó nada» se prueba comparando dos
home_hash() {
  ( cd "$1" && find . -print | LC_ALL=C sort | while IFS= read -r f; do
      if [ -L "$f" ]; then printf '%s -> %s\n' "$f" "$(readlink "$f")"
      elif [ -f "$f" ]; then printf '%s ' "$f"; shasum -a 256 < "$f"
      else printf '%s/\n' "$f"; fi
    done ) | shasum -a 256 | cut -d' ' -f1
}
# el repo de producto con su AGENTS.md puntero (el texto con que lo deposita el aplicador), bajo la raíz de repos
lab_product_repo() { # lab_product_repo <raíz de repos>
  mkdir -p "$1/producto"
  env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -C "$1/producto" init -q -b main
  printf '# reglas del producto\n' > "$1/producto/CLAUDE.md"
  printf '# AGENTS.md — puntero (lo depositó el arnés TYCON; commitealo así le llega al equipo)\n\nLas reglas de este repo viven en `CLAUDE.md`.\n' > "$1/producto/AGENTS.md"
}
# el ambiente de las dos: base() + la raíz de repos y el freno de producción de mentira
lab_env() { # lab_env <home> <lab>
  base "$1"; RUN_ENV+=(TYCON_REPOS_ROOT="$2/repos" TYCON_PRODUCTION_GUARD_DIR="$2/opt-tycon")
}
# la desinstalación directo con el módulo (sin harness.js): `plan` → describePlan, o `run`; HOME y estado de juguete
cat > "$T/uninstall-direct.js" <<'JS'
const path = require('path'); const os = require('os');
const [, , raiz, what] = process.argv;
const U = require(path.join(raiz, 'scripts/setup/harness/uninstall.js'));
const S = require(path.join(raiz, 'scripts/setup/harness/state.js'));
const home = os.homedir(); const env = process.env;
const r = S.read(home);
const state = r.status === 'missing' ? null : r.state;
const ctx = { home, env, platform: process.platform, tree: state ? state.tree : null };
if (what === 'plan') { for (const l of U.describePlan(U.plan(ctx, state))) console.log(l); process.exit(0); }
const out = U.run(ctx, state, { log: () => {} });
for (const l of out.lines) console.log(l);
process.exit(out.ok ? 0 : 1);
JS

if corre T26; then
  echo "T26 · Uninstall_OnlyManaged_NeverVersionedInOtherRepo_WorksWithoutTree"
  T26_T0=$SECONDS

  # ── (a) remove.js unitario ─────────────────────────────────────────────────────────────────────────────────────────
  cat > "$T/remove-unit.js" <<'JS'
const fs = require('fs'); const path = require('path');
const [, , raiz, dir] = process.argv;
const say = (c, m) => console.log(c ? `  ok   — T26 remove.js: ${m}` : `  MAL  — T26 remove.js: ${m}`);
let R;
try { R = require(path.join(raiz, 'scripts/setup/harness/remove.js')); } catch (e) { say(false, `no carga (${e.message.split('\n')[0]})`); process.exit(0); }
const home = path.join(dir, 'home'); const tree = path.join(dir, 'tree'); const claude = path.join(home, '.claude');
for (const d of [path.join(tree, 'scripts/hooks'), path.join(tree, 'commands'), path.join(claude, 'commands'), path.join(claude, 'agent-skills/skills/tycon-pipeline/scripts'), path.join(dir, 'copia')]) fs.mkdirSync(d, { recursive: true });
const env = { LAUNCHCTL_BIN: path.join(dir, 'launchctl'), CODEX_HOME: path.join(home, '.codex'), TYCON_GIT_HOOKS_DIR: path.join(home, '.git-hooks') };
fs.writeFileSync(env.LAUNCHCTL_BIN, `#!/bin/sh\necho "$@" >> "${path.join(dir, 'launchctl.log')}"\n`, { mode: 0o755 });
const W = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); return f; };
const J = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const T = (f) => fs.readFileSync(f, 'utf8');
const ex = (f) => { try { fs.lstatSync(f); return true; } catch (_) { return false; } };
const run = (pieces, extra = {}) => { try { return R.removePieces(pieces, Object.assign({ home, env, tree, log: () => {} }, extra)); } catch (e) { say(false, `tiró: ${e.message}`); return { removed: [], kept: [], review: [] }; } };
const tcg = (x) => `node "${path.join(tree, 'scripts/hooks', x)}"`;
const ask = (x) => `node "${path.join(claude, 'agent-skills/skills', x)}"`;
const LINE = 'node "$HOME/.claude/.tycon-pipeline/harness/bootstrap.js" || bash "$HOME/.claude/.tycon-pipeline/harness/bootstrap-fallback.sh"';
const h = (command, more = {}) => Object.assign({ type: 'command', command }, more);

// 1. settings.json: hooks por evento y ruta, los ajenos y su orden intactos, un bloque vacío se va, la línea de arranque,
//    un ajuste que el dev cambió se queda, la variable de env con el valor del arnés se va (y `env` vacío con ella)
const S = W(path.join(claude, 'settings.json'), `${JSON.stringify({
  model: 'opus',
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: {
    Stop: [{ hooks: [h('echo ajeno-1'), h(tcg('response-style-meter.js')), h('echo ajeno-2')] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [h(ask('tycon-pipeline/scripts/on-bash-write-gate.js'))] }],
    UserPromptSubmit: [{ hooks: [h(`bash -c 'echo ${path.join(tree, 'scripts/hooks/blocking-notice.js')}'`)] }],
    SessionStart: [{ hooks: [h(LINE, { async: true })] }, { hooks: [h('echo ajeno-arranque')] }],
  },
  cleanupPeriodDays: 30,
  env: { CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1' },
}, null, 2)}\n`);
let r = run([
  { kind: 'hook', where: S, id: 'Stop:@tcg:response-style-meter.js' },
  { kind: 'hook', where: S, id: 'PreToolUse:tycon-pipeline/scripts/on-bash-write-gate.js' },
  { kind: 'hook', where: S, id: 'UserPromptSubmit:@tcg:blocking-notice.js' },
  { kind: 'startup-line', where: S, id: 'SessionStart:bootstrap.js' },
  { kind: 'setting', where: S, id: 'cleanupPeriodDays', value: 365 },
  { kind: 'setting', where: S, id: 'env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR', value: '1' },
]);
const want = {
  model: 'opus',
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: {
    Stop: [{ hooks: [h('echo ajeno-1'), h('echo ajeno-2')] }],
    UserPromptSubmit: [{ hooks: [h(`bash -c 'echo ${path.join(tree, 'scripts/hooks/blocking-notice.js')}'`)] }],
    SessionStart: [{ hooks: [h('echo ajeno-arranque')] }],
  },
  cleanupPeriodDays: 30,
};
say(JSON.stringify(J(S)) === JSON.stringify(want), 'settings.json sin los hooks del arnés ni la línea de arranque; lo ajeno, su orden y un comando que sólo nombra la ruta intactos; el bloque vacío se fue');
say(T(S).endsWith('}\n') && T(S).includes('\n  "model"'), 'settings.json reescrito con 2 espacios y salto final, como el aplicador');
say(r.removed.length === 4 && r.kept.some((k) => k.piece.id === 'cleanupPeriodDays' && /365|cambi/.test(k.why)), `cuatro quitadas y cleanupPeriodDays (cambiado por el dev) en «kept» con el motivo (removed=${r.removed.length})`);
say(!r.removed.some((p) => p.id === 'UserPromptSubmit:@tcg:blocking-notice.js'), 'un hook registrado que ya no está no cuenta como quitado');

// 2. el byte a byte: lo que queda es igual como JSON a la copia → se escribe la copia tal cual (su formato, no el nuestro)
const orig = '{\n    "model": "opus",\n    "hooks": {}\n}';
const copia = W(path.join(dir, 'copia', 'settings.json'), orig);
const S2 = W(path.join(dir, 's2', 'settings.json'), `${JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [h(tcg('blocking-meter.js'))] }], SessionStart: [{ hooks: [h(LINE)] }] }, cleanupPeriodDays: 365 }, null, 2)}\n`);
run([{ kind: 'hook', where: S2, id: 'Stop:@tcg:blocking-meter.js' }, { kind: 'startup-line', where: S2, id: 'SessionStart:bootstrap.js' }, { kind: 'setting', where: S2, id: 'cleanupPeriodDays', value: 365 }], { restoreIfEqual: { [S2]: copia } });
say(T(S2) === orig, 'settings.json igual como JSON a su copia → los bytes de la copia (formato del dev, sin salto final)');
// sin copia que diga lo contrario y el archivo no existía antes (null): queda vacío → se borra
const S3 = W(path.join(dir, 's3', 'settings.json'), `${JSON.stringify({ hooks: { Stop: [{ hooks: [h(tcg('blocking-meter.js'))] }] } }, null, 2)}\n`);
run([{ kind: 'hook', where: S3, id: 'Stop:@tcg:blocking-meter.js' }], { restoreIfEqual: { [S3]: null } });
say(!ex(S3), 'settings.json que no existía antes de instalar y quedó vacío → se borra');

// 3. CLAUDE.md: el @import y los bloques, sin tocar el texto propio; con la copia, byte a byte; un bloque sin cierre se queda
const B = (n, body) => `<!-- TYCON_BLOCK:${n} START — generado por tycon-claude-guides/scripts/setup/sync-claude-md-blocks.sh -->\n${body}\n<!-- TYCON_BLOCK:${n} END -->`;
const IMPORT = '@~/.claude/tycon-claude-guides/README.md';
const C1 = W(path.join(dir, 'c1', 'CLAUDE.md'), `# mío\nTexto propio\n${IMPORT}\n\n${B('a', 'A')}\n\n${B('b', 'B')}\nLínea mía\n`);
const cp = (f) => [{ kind: 'import', where: f, id: IMPORT }, { kind: 'block', where: f, id: 'TYCON_BLOCK:a' }, { kind: 'block', where: f, id: 'TYCON_BLOCK:b' }];
run(cp(C1));
say(T(C1) === '# mío\nTexto propio\nLínea mía\n', `CLAUDE.md sin @import ni bloques, con el texto propio (quedó ${JSON.stringify(T(C1))})`);
const origMd = '# mío\nTexto propio';
const copiaMd = W(path.join(dir, 'copia', 'CLAUDE.md'), origMd);
const C2 = W(path.join(dir, 'c2', 'CLAUDE.md'), `${origMd}\n${IMPORT}\n\n${B('a', 'A')}\n\n${B('b', 'B')}\n`);
run(cp(C2), { restoreIfEqual: { [C2]: copiaMd } });
say(T(C2) === origMd, 'CLAUDE.md igual como texto a su copia (salvo el final de línea) → los bytes de la copia');
const C3 = W(path.join(dir, 'c3', 'CLAUDE.md'), `# mío\n<!-- TYCON_BLOCK:a START -->\nA sin cierre\n`);
r = run([{ kind: 'block', where: C3, id: 'TYCON_BLOCK:a' }]);
say(T(C3).includes('A sin cierre') && r.kept.length === 1, 'un bloque sin marcador de cierre no se adivina: queda, y se dice');

// 4. hooks de git: el del arnés se va y el .local vuelve a su lugar; uno que ya no es del arnés se queda
const GH = env.TYCON_GIT_HOOKS_DIR;
const pre = W(path.join(GH, 'pre-commit'), '#!/bin/sh\n# git-pre-commit-global.sh (del arnés)\n');
W(path.join(GH, 'pre-commit.local'), '#!/bin/sh\necho mío\n');
const post = W(path.join(GH, 'post-commit'), '#!/bin/sh\necho otro\n');
r = run([{ kind: 'git-hook', where: pre, id: 'pre-commit' }, { kind: 'git-hook', where: post, id: 'post-commit' }]);
say(T(pre) === '#!/bin/sh\necho mío\n' && !ex(`${pre}.local`), 'pre-commit del arnés quitado y pre-commit.local de vuelta en pre-commit');
say(T(post) === '#!/bin/sh\necho otro\n' && r.kept.some((k) => k.piece.id === 'post-commit'), 'un post-commit que ya no es el del arnés se queda');
// el pre-push (story 8.26, tanda F1): igual que el pre-commit
const push = W(path.join(GH, 'pre-push'), '#!/usr/bin/env bash\n# git-pre-push-global.sh (del arnés)\n');
W(path.join(GH, 'pre-push.local'), '#!/bin/sh\necho mi pre-push\n');
r = run([{ kind: 'git-hook', where: push, id: 'pre-push' }]);
say(T(push) === '#!/bin/sh\necho mi pre-push\n' && !ex(`${push}.local`), 'pre-push del arnés quitado y pre-push.local de vuelta en pre-push');

// 5. enlaces: sólo si resuelve al árbol (también colgado, si apuntaba al árbol que se borró)
const L1 = path.join(claude, 'tycon-claude-guides'); fs.symlinkSync(tree, L1);
const otro = path.join(dir, 'otro'); fs.mkdirSync(otro);
const L2 = path.join(claude, 'agents'); fs.symlinkSync(otro, L2);
const L3 = path.join(claude, 'real'); fs.mkdirSync(L3);
r = run([{ kind: 'link', where: L1, id: 'tycon-claude-guides' }, { kind: 'link', where: L2, id: 'agents' }, { kind: 'link', where: L3, id: 'real' }]);
say(!ex(L1) && ex(tree), 'el enlace al árbol se quita (el árbol no se toca)');
say(ex(L2) && ex(L3) && r.kept.length === 2, 'un enlace a otro lado y una carpeta real no se tocan');
const gone = path.join(dir, 'tree-borrado'); const L4 = path.join(dir, 'l4'); fs.symlinkSync(gone, L4);
run([{ kind: 'link', where: L4, id: 'tycon-claude-guides' }], { tree: gone });
say(!ex(L4), 'el enlace colgado que apuntaba al árbol borrado se quita');

// 6. comandos: el copiado se borra; uno que el dev cambió se queda; uno que pisó uno propio vuelve a la copia
const cmd = (n, t) => { W(path.join(tree, 'commands', n), 'del arnés\n'); return W(path.join(claude, 'commands', n), t); };
const x = cmd('x.md', 'del arnés\n'); const y = cmd('y.md', 'lo cambié\n'); const z = cmd('z.md', 'del arnés\n');
const copiaZ = W(path.join(dir, 'copia', 'z.md'), 'mi comando z\n');
r = run(['x.md', 'y.md', 'z.md'].map((n) => ({ kind: 'command', where: path.join(claude, 'commands', n), id: n })), { restoreIfEqual: { [z]: copiaZ } });
say(!ex(x) && T(y) === 'lo cambié\n' && T(z) === 'mi comando z\n', 'comandos: el del arnés se borra, el cambiado se queda, el que pisó uno propio vuelve a la copia');

// 7. LaunchAgent: se descarga con $LAUNCHCTL_BIN y se borra el plist
const plist = W(path.join(home, 'Library/LaunchAgents/lab.example.harness-env.plist'), '<plist/>\n');
run([{ kind: 'launch-agent', where: plist, id: 'lab.example.harness-env' }]);
const llog = ex(path.join(dir, 'launchctl.log')) ? T(path.join(dir, 'launchctl.log')) : '';
say(!ex(plist) && llog.includes(`bootout gui/${process.getuid ? process.getuid() : 0}`) && llog.includes(plist), `LaunchAgent descargado (bootout gui/<uid> <plist>) y borrado (launchctl: ${JSON.stringify(llog.trim())})`);

// 8. Codex: AGENTS.md pierde sus bloques; lo generado se borra; hooks.json/config.toml sólo si la copia dice que no existían
const CX = env.CODEX_HOME;
const ag = W(path.join(CX, 'AGENTS.md'), `# de Codex\n${IMPORT}\n\n${B('a', 'A')}\n`);   // el espejo copia también el @import
const hj = W(path.join(CX, 'hooks.json'), '{}\n'); const ct = W(path.join(CX, 'config.toml'), 'x = 1\n');
const at = W(path.join(CX, 'agents/lab.toml'), 'y = 2\n');
r = run([{ kind: 'import', where: path.join(dir, 'sin-claude-md', 'CLAUDE.md'), id: IMPORT }, { kind: 'codex', where: ag, id: 'AGENTS.md' }, { kind: 'codex', where: hj, id: 'hooks.json' }, { kind: 'codex', where: ct, id: 'config.toml' }, { kind: 'codex', where: at, id: 'agents/lab.toml' }],
  { restoreIfEqual: { [hj]: null, [ct]: W(path.join(dir, 'copia', 'config.toml'), 'x = 0\n') },
    afterSha: { [hj]: require('crypto').createHash('sha256').update('{}\n').digest('hex') } });   // como lo dejó la instalación
say(T(ag) === '# de Codex\n' && !ex(hj) && !ex(at) && T(ct) === 'x = 1\n' && r.review.some((v) => v.piece.id === 'config.toml'),
  'Codex: AGENTS.md sin bloques ni la copia del @import, hooks.json (no existía) y agents/*.toml borrados, config.toml que ya existía a «revisalo»');

// 9. terceros: no se tocan (viven dentro del árbol); file: se borra; nunca tira (JSON roto, tipo desconocido)
const tp = path.join(claude, 'agent-skills/skills/lab-tercero'); fs.mkdirSync(tp, { recursive: true });
const fi = W(path.join(claude, '.tycon-pipeline/harness/bootstrap.js'), '// copia fija\n');
const roto = W(path.join(dir, 'roto', 'settings.json'), '{ roto');
r = run([{ kind: 'third-party', where: tp, id: 'lab-tercero' }, { kind: 'file', where: fi, id: 'bootstrap.js' },
  { kind: 'hook', where: roto, id: 'Stop:@tcg:blocking-meter.js' }, { kind: 'inventado', where: roto, id: 'x' }]);
say(ex(tp) && !ex(fi) && T(roto) === '{ roto' && r.kept.length === 3, 'terceros intactos, la copia fija borrada; JSON roto y tipo desconocido quedan con motivo, sin tirar');

// 10. dryRun: clasifica igual y no escribe nada (es el plan)
const S4 = W(path.join(dir, 's4', 'settings.json'), `${JSON.stringify({ hooks: { Stop: [{ hooks: [h(tcg('blocking-meter.js'))] }] }, cleanupPeriodDays: 30 }, null, 2)}\n`);
// (dentro de la carpeta de hooks globales: desde REG-R4 un git-hook de afuera no se toca)
const g4 = W(path.join(GH, 's4', 'pre-commit'), '#!/bin/sh\n# git-pre-commit-global.sh\n'); W(`${g4}.local`, 'mío\n');
const antes4 = T(S4);
r = run([{ kind: 'hook', where: S4, id: 'Stop:@tcg:blocking-meter.js' }, { kind: 'setting', where: S4, id: 'cleanupPeriodDays', value: 365 }, { kind: 'git-hook', where: g4, id: 'pre-commit' }], { dryRun: true });
say(T(S4) === antes4 && ex(`${g4}.local`) && T(g4).includes('global') && r.removed.length === 2 && r.kept.length === 1, 'dryRun: dos que quitaría, el ajuste cambiado que quedaría, y nada escrito');
JS
  rm -rf "$T/unit26"; mkdir -p "$T/unit26"
  node "$T/remove-unit.js" "$RAIZ" "$T/unit26" > "$T/unit26.txt" 2>&1
  cat "$T/unit26.txt"
  n=$(grep -c '^  MAL' "$T/unit26.txt"); FALLOS=$((FALLOS + n))
  grep -q '^  ok' "$T/unit26.txt" || { mal "T26 remove.js unitario no corrió"; }

  # ── la máquina de T26 ──────────────────────────────────────────────────────────────────────────────────────────────
  # hooks ajenos en settings.json, texto propio en CLAUDE.md, ~/.claude/skills enlazado a otro lado, un pre-commit ajeno
  # que YA tiene su .local (la excepción de la B: el aplicador lo deja en .bak-<ts>), el freno de producción de mentira y un
  # repo de producto con AGENTS.md puntero
  seed26() { # seed26 <home> <lab>
    new_home "$1"; rm -f "$1/.claude/.tycon-pipeline/harness-state.json"; lab_skills_repo "$1"
    printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo ajeno-stop"}]}],"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo ajeno-pre"}]}]},"permissions":{"allow":["Bash(ls:*)"]}}\n' > "$1/.claude/settings.json"
    printf '# lo mío\n' > "$1/.claude/CLAUDE.md"
    printf '{"update": {"channel": "stable"}}\n' > "$1/.claude/tycon.json"
    mkdir -p "$2/otras-skills" "$1/.git-hooks" "$2/opt-tycon/hooks"; ln -s "$2/otras-skills" "$1/.claude/skills"
    printf '#!/bin/sh\necho ajeno-pre-commit\n' > "$1/.git-hooks/pre-commit"; printf '#!/bin/sh\necho local-del-dev\n' > "$1/.git-hooks/pre-commit.local"
    printf '// freno de mentira\n' > "$2/opt-tycon/hooks/prod-access-guard.js"
    lab_product_repo "$2/repos"
  }
  install26() { # install26 <home> <lab> <árbol> → rc del install; después el dev cambia cleanupPeriodDays a 30
    seed26 "$1" "$2"; lab_tree "$3"; lab_env "$1" "$2"
    local rc=0; "${RUN_ENV[@]}" node "$3/scripts/setup/harness.js" install --yes >"$2/install.txt" 2>&1 || rc=$?
    python3 - "$1/.claude/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p, encoding="utf-8")); s["cleanupPeriodDays"] = 30
open(p, "w", encoding="utf-8").write(json.dumps(s, indent=2, ensure_ascii=False) + "\n")
PY
    return $rc
  }
  # lo que tiene que quedar después de quitar: imprime «MAL: …» por cada problema
  cat > "$T/check26.py" <<'PY'
import glob, json, os, sys
home, lab, tree, out_file = sys.argv[1:5]
out = open(out_file, encoding="utf-8").read()
claude = os.path.join(home, ".claude"); bad = []
def lex(p): return os.path.lexists(p)
s = json.load(open(os.path.join(claude, "settings.json"), encoding="utf-8"))
cmds = [h.get("command", "") for ev in s.get("hooks", {}).values() for b in ev for h in b.get("hooks", [])]
for c in cmds:
    if "/scripts/hooks/" in c or "/agent-skills/skills/" in c or "bootstrap.js" in c:
        bad.append("quedó un hook del arnés en settings.json: %s" % c[:120])
for want in ("echo ajeno-stop", "echo ajeno-pre"):
    if want not in cmds: bad.append("se perdió el hook ajeno «%s»" % want)
if s.get("cleanupPeriodDays") != 30: bad.append("cleanupPeriodDays (30, cambiado por el dev) no se quedó: %r" % s.get("cleanupPeriodDays"))
if "CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR" in (s.get("env") or {}): bad.append("la variable de env del arnés sigue")
if "harness-mods" in str((s.get("env") or {}).get("CLAUDE_CODE_PLUGIN_DIRS", "")): bad.append("la carpeta de los mods del arnés sigue en CLAUDE_CODE_PLUGIN_DIRS")
if s.get("permissions") != {"allow": ["Bash(ls:*)"]}: bad.append("los permisos del dev cambiaron")
md = open(os.path.join(claude, "CLAUDE.md"), encoding="utf-8").read()
if "TYCON_BLOCK" in md or "@~/.claude/tycon-claude-guides/README.md" in md or "@~/.claude/tycon-harness/README.md" in md or "@~/.claude/tycon-harness/INDEX.md" in md: bad.append("CLAUDE.md conserva bloques o el @import (por cualquiera de los dos nombres del lugar)")
if "# lo mío" not in md: bad.append("CLAUDE.md perdió el texto propio")
if glob.glob(os.path.join(claude, "commands", "tycon-*.md")): bad.append("quedaron los comandos copiados")
if lex(os.path.join(claude, "tycon-claude-guides")): bad.append("el enlace ~/.claude/tycon-claude-guides sigue")
sk = os.path.join(claude, "skills")
if not (os.path.islink(sk) and os.readlink(sk) == os.path.join(lab, "otras-skills")): bad.append("el enlace ~/.claude/skills (no registrado) cambió")
gh = os.path.join(home, ".git-hooks")
pre = open(os.path.join(gh, "pre-commit")).read() if os.path.exists(os.path.join(gh, "pre-commit")) else None
if pre != "#!/bin/sh\necho local-del-dev\n": bad.append("pre-commit no volvió desde pre-commit.local: %r" % pre)
if lex(os.path.join(gh, "pre-commit.local")): bad.append("pre-commit.local sigue (tenía que volver a pre-commit)")
baks = glob.glob(os.path.join(gh, "pre-commit.bak-*"))
if not baks: bad.append("el pre-commit.bak-<ts> (la excepción de la B) desapareció: no se restaura ni se borra solo")
if lex(os.path.join(gh, "post-commit")): bad.append("el post-commit del arnés sigue")
if not os.path.exists(os.path.join(lab, "repos", "producto", "AGENTS.md")): bad.append("se borró el AGENTS.md del repo de producto")
if not os.path.exists(os.path.join(lab, "opt-tycon", "hooks", "prod-access-guard.js")): bad.append("se tocó el freno de producción")
hd = os.path.join(claude, ".tycon-pipeline", "harness")
for f in ("bootstrap.js", "bootstrap-fallback.sh", "bootstrap-fallback.ps1", "program"):
    if lex(os.path.join(hd, f)): bad.append("la copia fija sigue: %s" % f)
if lex(os.path.join(claude, ".tycon-pipeline", "harness-state.json")): bad.append("el estado sigue")
if not os.path.isdir(os.path.join(hd, "backups")): bad.append("se borraron las copias de seguridad")
if not os.path.exists(os.path.join(claude, "tycon.json")): bad.append("se borró ~/.claude/tycon.json")
# lo que se imprime: deja (con la línea del freno, la carpeta de estado con su comando, los enlaces no registrados, los
# AGENTS.md puntero) y revisalo (el .bak-<ts>)
for need, what in ((os.path.join(lab, "repos", "producto", "AGENTS.md"), "el AGENTS.md puntero"),
                   (os.path.join(lab, "opt-tycon"), "el freno de producción"), ("sudo", "el freno se quita con su instalador y sudo"),
                   (os.path.basename(baks[0]) if baks else "pre-commit.bak-", "el .bak-<ts> en «revisalo»"),
                   (os.path.join(claude, "skills"), "el enlace ~/.claude/skills no registrado"), ("cleanupPeriodDays", "el ajuste que se quedó"),
                   (tree, "el clon"), ("rm -rf", "el comando para borrar la carpeta de estado"), ("tycon.json", "tycon.json")):
    if need not in out: bad.append("la salida no nombra %s (%s)" % (what, need))
for b in bad: print("MAL: " + b)
sys.exit(1 if bad else 0)
PY

  # ── (b) uninstall.js directo, sobre una instalación real y sin árbol ───────────────────────────────────────────────
  L="$T/lab26b"; H="$L/casa"; A="$L/arbol"; rm -rf "$L"; mkdir -p "$L"
  t0=$SECONDS
  if install26 "$H" "$L" "$A"; then
    ok "T26 instalación real en el HOME de juguete ($((SECONDS - t0)) s, copia del árbol incluida)"
    # tanda D (AC 28, T36): bajo harness.js las tres piezas compartidas las hace él —el aplicador REAL corre avisado y no
    # las reporta— y quedan en el registro, una vez cada una; lo que sigue de T26 prueba que `uninstall` las quita.
    # 🔴 rojo previo (medido con un harness.js sin el enganche): «el registro de harness.js no dice que hizo las piezas
    #    compartidas» (las hacía y las reportaba el aplicador).
    python3 - "$H/.claude/.tycon-pipeline/harness-state.json" "$H/.claude/.tycon-pipeline/harness/startup.log" "$A" > "$L/shared.txt" 2>&1 <<'PY'
import glob, json, os, sys
state_file, log_file, tree = sys.argv[1:4]
managed = json.load(open(state_file, encoding="utf-8")).get("managed") or []
keys = [(p["kind"], p["id"]) for p in managed if p["kind"] in ("setting", "command")]
want = [("setting", "cleanupPeriodDays"), ("setting", "env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR"),
        ("setting", "env.CLAUDE_CODE_PLUGIN_DIRS")]   # story 7.27: la carpeta de los mods del arnés
names = [os.path.basename(c) for c in glob.glob(os.path.join(tree, "commands", "*.md"))]
want += [("command", n) for n in names]
bad = []
if not names: bad.append("el árbol de laboratorio no trae comandos: no se mide la copia")
if sorted(keys) != sorted(want): bad.append("las piezas compartidas del registro son %r (esperado %r)" % (sorted(keys), sorted(want)))
log = open(log_file, encoding="utf-8").read() if os.path.exists(log_file) else ""
if "piezas compartidas: cleanupPeriodDays" not in log: bad.append("el registro de harness.js no dice que hizo las piezas compartidas")
print("; ".join(bad) if bad else "ok")
PY
    [ "$(cat "$L/shared.txt")" = "ok" ] && ok "T26 (T36) con el aplicador real: las tres piezas compartidas las hizo harness.js y quedaron en el registro, una vez cada una" \
      || mal "T26 (T36) las piezas compartidas bajo harness.js: $(cat "$L/shared.txt")"
    "${RUN_ENV[@]}" node "$T/uninstall-direct.js" "$RAIZ" plan > "$L/plan.txt" 2>&1
    if grep -q 'TYCON_BLOCK' "$L/plan.txt" && grep -q "$L/repos/producto/AGENTS.md" "$L/plan.txt" && grep -q 'settings.json' "$L/plan.txt"; then
      ok "T26 el plan lista lo que quitaría (hooks, bloques) y los AGENTS.md puntero"
    else
      mal "T26 el plan no lista lo que quitaría"; head -15 "$L/plan.txt" | sed 's/^/        /'
    fi
    rm -rf "$A"   # el dev borró el clon
    rc=0; "${RUN_ENV[@]}" node "$T/uninstall-direct.js" "$RAIZ" run > "$L/run.txt" 2>&1 || rc=$?
    if [ "$rc" = 0 ] && python3 "$T/check26.py" "$H" "$L" "$A" "$L/run.txt" > "$L/check.txt"; then
      ok "T26 sin árbol: quita sólo lo registrado, deja lo ajeno, el ajuste cambiado, el freno, los enlaces no registrados y el AGENTS.md (y lo dice)"
    else
      mal "T26 uninstall.js directo sin árbol (rc $rc)"; grep '^MAL' "$L/check.txt" | head -12 | sed 's/^/        /'; head -30 "$L/run.txt" | sed 's/^/        | /'
    fi
    grep -q 'no está' "$L/run.txt" && ok "T26 sin árbol lo dice (trabaja con el registro)" || mal "T26 sin árbol no dice que el árbol no está"
    rc=0; "${RUN_ENV[@]}" node "$T/uninstall-direct.js" "$RAIZ" run > "$L/run2.txt" 2>&1 || rc=$?
    [ "$rc" = 0 ] && grep -q 'nada que quitar' "$L/run2.txt" && ok "T26 segunda corrida: «nada que quitar», 0" \
      || { mal "T26 segunda corrida (rc $rc)"; head -5 "$L/run2.txt" | sed 's/^/        /'; }
  else
    mal "T26 la instalación real falló"; tail -15 "$L/install.txt" | sed 's/^/        /'
  fi

  # ── (c) de punta a punta: harness.js uninstall y la copia fija ─────────────────────────────────────────────────────
  L="$T/lab26c"; H="$L/casa"; A="$L/arbol"; rm -rf "$L"; mkdir -p "$L"
  if install26 "$H" "$L" "$A"; then
    before="$(home_hash "$H")"
    rc=0; "${RUN_ENV[@]}" node "$A/scripts/setup/harness.js" uninstall --dry-run < /dev/null > "$L/dry.txt" 2>&1 || rc=$?
    if [ "$rc" = 0 ] && grep -q 'TYCON_BLOCK' "$L/dry.txt" && grep -q "$L/repos/producto/AGENTS.md" "$L/dry.txt" && [ "$(home_hash "$H")" = "$before" ]; then
      ok "T26 uninstall --dry-run lista y no toca nada (hash del HOME igual)"
    else
      mal "T26 uninstall --dry-run (rc $rc, HOME $([ "$(home_hash "$H")" = "$before" ] && echo igual || echo CAMBIÓ))"; head -6 "$L/dry.txt" | sed 's/^/        /'
    fi
    rc=0; "${RUN_ENV[@]}" node "$A/scripts/setup/harness.js" uninstall < /dev/null > "$L/noyes.txt" 2>&1 || rc=$?
    [ "$rc" = 2 ] && [ "$(home_hash "$H")" = "$before" ] && ok "T26 sin --yes y sin terminal: sale 2 y no toca nada" \
      || { mal "T26 sin --yes y sin terminal salió $rc (esperado 2) o tocó el HOME"; head -4 "$L/noyes.txt" | sed 's/^/        /'; }
    rm -rf "$A"   # el dev borró el clon: corre desde la copia fija, que trae harness.js y sus módulos
    rc=0; "${RUN_ENV[@]}" node "$H/.claude/.tycon-pipeline/harness/bootstrap.js" uninstall --yes < /dev/null > "$L/yes.txt" 2>&1 || rc=$?
    if [ "$rc" = 0 ] && python3 "$T/check26.py" "$H" "$L" "$A" "$L/yes.txt" > "$L/check.txt"; then
      ok "T26 sin árbol, desde la copia fija (bootstrap.js uninstall --yes): quita lo registrado y deja el resto, dicho"
    else
      mal "T26 bootstrap.js uninstall --yes sin árbol (rc $rc)"; grep '^MAL' "$L/check.txt" | head -8 | sed 's/^/        /'; head -8 "$L/yes.txt" | sed 's/^/        | /'
    fi
    python3 - "$H" <<'PY' && ok "T26 la desinstalación tomó su copia (reason: uninstall)" || mal "T26 no hay una copia reason: uninstall"
import glob, json, os, sys
ms = [json.load(open(m)) for m in glob.glob(os.path.join(sys.argv[1], ".claude/.tycon-pipeline/harness/backups/*/manifest.json"))]
sys.exit(0 if any(m.get("reason") == "uninstall" for m in ms) else 1)
PY
    rc=0; "${RUN_ENV[@]}" node "$RAIZ/scripts/setup/harness.js" uninstall --yes < /dev/null > "$L/again.txt" 2>&1 || rc=$?
    [ "$rc" = 0 ] && grep -q 'nada que quitar' "$L/again.txt" && ok "T26 segunda corrida por harness.js: «nada que quitar», 0" \
      || { mal "T26 segunda corrida por harness.js (rc $rc)"; head -3 "$L/again.txt" | sed 's/^/        /'; }
    rc=0; "${RUN_ENV[@]}" node "$RAIZ/scripts/setup/harness.js" doctor < /dev/null > "$L/doctor.txt" 2>&1 || rc=$?
    [ "$rc" = 3 ] && grep -q 'no instalado' "$L/doctor.txt" && ok "T26 doctor después: «no instalado» (3)" \
      || { mal "T26 doctor después salió $rc"; head -3 "$L/doctor.txt" | sed 's/^/        /'; }
  else
    mal "T26 la instalación real falló (punta a punta)"; tail -15 "$L/install.txt" | sed 's/^/        /'
  fi
  echo "  ·    T26 tardó $((SECONDS - T26_T0)) s"
fi

if corre T27; then
  echo "T27 · Uninstall_ByteForByte_AliensAndLocalHookIntact"
  T27_T0=$SECONDS
  # la máquina del dev ANTES del arnés: settings.json con hooks ajenos y su propio formato (4 espacios, sin salto final),
  # CLAUDE.md propio sin salto final, ~/.claude/skills carpeta real con una skill, un pre-commit propio sin .local
  seed27() { # seed27 <home> <lab>
    new_home "$1"; rm -f "$1/.claude/.tycon-pipeline/harness-state.json"; lab_skills_repo "$1"
    printf '{\n    "permissions": {\n        "allow": ["Bash(ls:*)"]\n    },\n    "hooks": {\n        "Stop": [\n            {"hooks": [{"type": "command", "command": "echo ajeno-stop"}]}\n        ],\n        "PreToolUse": [\n            {"matcher": "Bash", "hooks": [{"type": "command", "command": "echo ajeno-pre"}]}\n        ]\n    },\n    "model": "opus"\n}' > "$1/.claude/settings.json"
    printf '# Mis reglas\n\nTexto propio, sin salto final' > "$1/.claude/CLAUDE.md"
    mkdir -p "$1/.claude/skills/mia" "$1/.git-hooks"; printf '# mi skill\n' > "$1/.claude/skills/mia/SKILL.md"
    printf '#!/bin/sh\necho mi-pre-commit\n' > "$1/.git-hooks/pre-commit"; chmod +x "$1/.git-hooks/pre-commit"
    lab_product_repo "$2/repos"
    cp "$1/.claude/settings.json" "$2/settings.antes"; cp "$1/.claude/CLAUDE.md" "$2/claude.antes"; cp "$1/.git-hooks/pre-commit" "$2/pre-commit.antes"
  }
  cat > "$T/check27.py" <<'PY'
import filecmp, os, sys
home, lab, out_file = sys.argv[1:4]
out = open(out_file, encoding="utf-8").read(); bad = []
c = os.path.join(home, ".claude")
for f, antes in (("settings.json", "settings.antes"), ("CLAUDE.md", "claude.antes")):
    p = os.path.join(c, f)
    if not (os.path.exists(p) and filecmp.cmp(p, os.path.join(lab, antes), shallow=False)):
        bad.append("%s no quedó byte a byte como antes de instalar" % f)
if not os.path.isfile(os.path.join(c, "skills", "mia", "SKILL.md")) or os.path.islink(os.path.join(c, "skills")): bad.append("la skill propia (carpeta real) no sigue")
pre = os.path.join(home, ".git-hooks", "pre-commit")
if not (os.path.exists(pre) and filecmp.cmp(pre, os.path.join(lab, "pre-commit.antes"), shallow=False)): bad.append("el pre-commit propio no volvió a su lugar")
if os.path.lexists(pre + ".local"): bad.append("pre-commit.local sigue")
ag = os.path.join(lab, "repos", "producto", "AGENTS.md")
if not os.path.exists(ag): bad.append("se borró el AGENTS.md del repo de producto")
if ag not in out: bad.append("el AGENTS.md del repo de producto no sale en la lista")
for b in bad: print("MAL: " + b)
sys.exit(1 if bad else 0)
PY
  for mode in module e2e; do
    L="$T/lab27-$mode"; H="$L/casa"; A="$L/arbol"; rm -rf "$L"; mkdir -p "$L"
    seed27 "$H" "$L"; lab_tree "$A"; lab_env "$H" "$L"; RUN_ENV+=(TYCON_PRODUCTION_GUARD_DIR="$L/sin-freno")
    t0=$SECONDS
    rc=0; "${RUN_ENV[@]}" node "$A/scripts/setup/harness.js" install --yes >"$L/install.txt" 2>&1 || rc=$?
    if [ "$rc" != 0 ]; then mal "T27 ($mode) la instalación real falló (rc $rc)"; tail -10 "$L/install.txt" | sed 's/^/        /'; continue; fi
    if [ -f "$H/.git-hooks/pre-commit.local" ] && ! cmp -s "$H/.claude/settings.json" "$L/settings.antes"; then
      ok "T27 ($mode) instalado en $((SECONDS - t0)) s: el pre-commit propio pasó a .local y settings.json cambió"
    else
      mal "T27 ($mode) la instalación no dejó el escenario (pre-commit.local, settings.json con hooks)"
    fi
    rm -rf "$A"   # se borra el clon
    rc=0
    if [ "$mode" = module ]; then
      "${RUN_ENV[@]}" node "$T/uninstall-direct.js" "$RAIZ" run > "$L/out.txt" 2>&1 || rc=$?
    else
      "${RUN_ENV[@]}" node "$H/.claude/.tycon-pipeline/harness/bootstrap.js" uninstall --yes < /dev/null > "$L/out.txt" 2>&1 || rc=$?
    fi
    if [ "$rc" = 0 ] && python3 "$T/check27.py" "$H" "$L" "$L/out.txt" > "$L/check.txt"; then
      ok "T27 ($mode) settings.json y CLAUDE.md iguales por cmp, la skill sigue, el pre-commit volvió, el AGENTS.md sigue y sale en la lista"
    else
      mal "T27 ($mode) uninstall sin árbol (rc $rc)"; grep '^MAL' "$L/check.txt" | sed 's/^/        /'; head -6 "$L/out.txt" | sed 's/^/        | /'
      [ -f "$H/.claude/settings.json" ] && diff "$L/settings.antes" "$H/.claude/settings.json" | head -8 | sed 's/^/        /'
    fi
    rc=0; "${RUN_ENV[@]}" node "$RAIZ/scripts/setup/harness.js" doctor < /dev/null > "$L/doctor.txt" 2>&1 || rc=$?
    [ "$rc" = 3 ] && grep -q 'no instalado' "$L/doctor.txt" && ok "T27 ($mode) doctor: «no instalado»" \
      || { mal "T27 ($mode) doctor después salió $rc"; head -3 "$L/doctor.txt" | sed 's/^/        /'; }
  done
  echo "  ·    T27 tardó $((SECONDS - T27_T0)) s"
fi

# ── story 8.7, tanda C (decisión C3): los enlaces del repo único ───────────────────────────────────────────────────────
# En el repo único (skills/ y agents/ en la raíz del clon) el aplicador deja tres enlaces más —~/.claude/agent-skills → el
# clon, ~/.claude/skills → <clon>/skills y ~/.claude/agents → <clon>/agents— o, si skills/ y agents/ ya son carpetas reales
# de la persona, un enlace por entrada adentro. Apuntan ADENTRO del árbol, no al árbol: `remove.js` los dejaba, y
# `uninstall.js` los listaba como «no registrados». Acá: (a) los módulos, con sus espejos (lo que apunta a otro lado no se
# toca); (b) de punta a punta, con el aplicador real, en las dos variantes.
if corre K3; then
  echo "K3 · Uninstall_SingleRepo_LinksIntoTheTree"
  K3_T0=$SECONDS

  # ── (a) remove.js y uninstall.js directo ───────────────────────────────────────────────────────────────────────────
  cat > "$T/k3-unit.js" <<'JS'
const fs = require('fs'); const path = require('path');
const [, , raiz, base] = process.argv;
const say = (c, m) => console.log(c ? `  ok   — K3 ${m}` : `  MAL  — K3 ${m}`);
const req = (m) => { try { return require(path.join(raiz, 'scripts/setup/harness', m)); } catch (e) { say(false, `${m} no carga (${e.message.split('\n')[0]})`); process.exit(0); } };
const R = req('remove.js'); const U = req('uninstall.js');
const dir = fs.realpathSync(base);
const ex = (f) => { try { fs.lstatSync(f); return true; } catch (_) { return false; } };
const mk = (...p) => { const d = path.join(dir, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const W = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); return f; };
const link = (target, where) => { fs.mkdirSync(path.dirname(where), { recursive: true }); fs.symlinkSync(target, where); return where; };
const L = (where, id) => ({ kind: 'link', where, id });
const run = (pieces, o) => { try { return R.removePieces(pieces, Object.assign({ log: () => {}, env: {} }, o)); } catch (e) { say(false, `removePieces tiró (${e.message})`); return { removed: [], kept: [], review: [], absent: [] }; } };

// el clon de repo único
const tree = mk('clone'); mk('clone', 'skills', 'tycon-pipeline'); W(path.join(tree, 'agents', 'lab-reviewer.md'), '# revisor\n');
const intact = () => ex(path.join(tree, 'skills', 'tycon-pipeline')) && ex(path.join(tree, 'agents', 'lab-reviewer.md'));

// 1. los tres enlaces a la carpeta entera: agent-skills apunta AL clon; skills y agents, ADENTRO
{
  const home = mk('h1'); const c = path.join(home, '.claude');
  const a = link(tree, path.join(c, 'agent-skills')); const s = link(path.join(tree, 'skills'), path.join(c, 'skills')); const g = link(path.join(tree, 'agents'), path.join(c, 'agents'));
  const pieces = [L(a, 'agent-skills'), L(s, 'skills'), L(g, 'agents')];
  const dry = run(pieces, { home, tree, dryRun: true });
  say(dry.removed.length === 3 && ex(a) && ex(s) && ex(g), `dryRun: los tres enlaces al clon se quitarían y nada se escribió (removed=${dry.removed.length})`);
  const r = run(pieces, { home, tree });
  say(r.removed.length === 3 && !ex(a) && !ex(s) && !ex(g) && intact(), `agent-skills (al clon), skills y agents (adentro del clon) se quitan; el clon queda intacto (removed=${r.removed.length}, kept=${r.kept.map((k) => k.why).join(' | ')})`);
}

// 2. carpetas reales de la persona: se va el enlace por entrada (a una carpeta y a un archivo); la carpeta y lo propio quedan
{
  const home = mk('h2'); const c = path.join(home, '.claude');
  const mineS = W(path.join(c, 'skills', 'mine', 'SKILL.md'), '# mía\n'); const mineA = W(path.join(c, 'agents', 'mine.md'), '# mío\n');
  const e1 = link(path.join(tree, 'skills', 'tycon-pipeline'), path.join(c, 'skills', 'tycon-pipeline'));
  const e2 = link(path.join(tree, 'agents', 'lab-reviewer.md'), path.join(c, 'agents', 'lab-reviewer.md'));
  const r = run([L(e1, 'skills/tycon-pipeline'), L(e2, 'agents/lab-reviewer.md'), L(path.join(c, 'skills'), 'skills')], { home, tree });
  say(!ex(e1) && !ex(e2) && ex(mineS) && ex(mineA) && fs.lstatSync(path.join(c, 'skills')).isDirectory() && r.removed.length === 2 && r.kept.length === 1 && intact(),
    `carpetas reales: los enlaces por entrada se quitan; la carpeta, lo propio y el clon quedan (removed=${r.removed.length}, kept=${r.kept.length})`);
}

// 3. colgados: el clon se borró y los enlaces apuntaban a él o adentro
{
  const home = mk('h3'); const c = path.join(home, '.claude'); const gone = path.join(dir, 'clone-deleted');
  const a = link(gone, path.join(c, 'agent-skills')); const s = link(path.join(gone, 'skills'), path.join(c, 'skills')); const e = link(path.join(gone, 'agents', 'x.md'), path.join(c, 'agents', 'x.md'));
  const r = run([L(a, 'agent-skills'), L(s, 'skills'), L(e, 'agents/x.md')], { home, tree: gone });
  say(!ex(a) && !ex(s) && !ex(e) && r.removed.length === 3, `colgados que apuntaban al clon borrado, o adentro, se quitan (removed=${r.removed.length})`);
}

// 4. por la ruta escrita o por la real: el enlace se escribió por un alias del clon, o el estado guarda el alias
{
  const home = mk('h4'); const c = path.join(home, '.claude'); const alias = link(tree, path.join(dir, 'alias-of-clone'));
  const s = link(path.join(alias, 'skills'), path.join(c, 'skills'));
  let r = run([L(s, 'skills')], { home, tree });
  say(!ex(s) && r.removed.length === 1, 'un enlace escrito por un alias del clon se quita (cuenta la ruta real)');
  const g = link(path.join(tree, 'agents'), path.join(c, 'agents'));
  r = run([L(g, 'agents')], { home, tree: alias });
  say(!ex(g) && r.removed.length === 1 && intact(), 'con el alias como árbol del estado, el enlace escrito por la ruta real se quita');
}

// 5. el espejo: lo que apunta a OTRO lado no se toca — otro clon, una carpeta cuyo nombre EMPIEZA igual, un colgado ajeno
{
  const home = mk('h5'); const c = path.join(home, '.claude');
  const o = link(mk('other-clone', 'skills'), path.join(c, 'skills')); const t = link(mk('clone-2', 'agents'), path.join(c, 'agents'));
  const d = link(path.join(dir, 'nowhere'), path.join(c, 'agent-skills'));
  const r = run([L(o, 'skills'), L(t, 'agents'), L(d, 'agent-skills')], { home, tree });
  say(ex(o) && ex(t) && ex(d) && r.removed.length === 0 && r.kept.length === 3 && r.kept.every((k) => /no al árbol/.test(k.why)),
    `espejo: otro clon, «clone-2» (empieza como «clone») y un colgado ajeno quedan, con el motivo (removed=${r.removed.length}, kept=${r.kept.length})`);
}

// 6. uninstall.js: «no está registrado: no lo toco» sale sólo para los enlaces que el registro NO trae
{
  const home = mk('h6'); const c = path.join(home, '.claude');
  const a = link(tree, path.join(c, 'agent-skills')); const s = link(path.join(tree, 'skills'), path.join(c, 'skills'));
  const g = link(mk('h6-own-agents'), path.join(c, 'agents'));   // de la persona: el registro no lo trae
  const env = { TYCON_PRODUCTION_GUARD_DIR: path.join(dir, 'no-guard'), TYCON_GIT_HOOKS_DIR: path.join(home, '.git-hooks'), CODEX_HOME: path.join(home, '.codex'), TYCON_REPOS_ROOT: mk('h6-repos') };
  const ctx = { home, env, platform: 'linux', tree };
  const state = { schema: 1, tree, sources: [], managed: [L(a, 'agent-skills'), L(s, 'skills')] };
  const p = U.plan(ctx, state);
  const unreg = p.keep.filter((l) => /no está registrado/.test(l));
  say(unreg.length === 1 && unreg[0].includes(g) && p.remove.some((x) => x.where === a) && p.remove.some((x) => x.where === s),
    `plan: agent-skills y skills (registrados) se quitan y no salen como «no registrado»; agents (de la persona) sí (${unreg.length} línea(s): ${unreg.join(' | ')})`);
  const out = U.run(ctx, state, { log: () => {} });
  const txt = out.lines.join('\n');
  say(out.ok === true && !ex(a) && !ex(s) && ex(g) && txt.includes(`el enlace ${a}`) && txt.includes(`el enlace ${s}`) && intact(),
    `run: quita los dos registrados y los nombra; el de la persona y el clon quedan (ok=${out.ok})`);
}
JS
  rm -rf "$T/k3unit"; mkdir -p "$T/k3unit"
  node "$T/k3-unit.js" "$RAIZ" "$T/k3unit" > "$T/k3unit.txt" 2>&1
  cat "$T/k3unit.txt"
  n=$(grep -c '^  MAL' "$T/k3unit.txt"); FALLOS=$((FALLOS + n))
  grep -q '^  ok' "$T/k3unit.txt" || mal "K3 los módulos no corrieron: $(head -3 "$T/k3unit.txt")"

  # ── (b) de punta a punta: el aplicador REAL sobre un clon de laboratorio de repo único ─────────────────────────────
  # lab_tree + el agent-skills de juguete de new_home puesto en la raíz del árbol (skills/) + un revisor de juguete
  # (agents/). La HOME no trae agent-skills: lo aporta el clon. Sin terceros (TYCON_THIRD_PARTY=0): ni red ni historia.
  lab_single_repo() { # lab_single_repo <árbol> <lab>
    lab_tree "$1"
    new_home "$2/seed"; mv "$2/seed/.claude/agent-skills/skills" "$1/skills"; rm -rf "$2/seed"
    mkdir -p "$1/agents" "$1/skills/lab-skill"
    printf '# revisor de laboratorio\n' > "$1/agents/lab-reviewer.md"; printf '# skill de laboratorio\n' > "$1/skills/lab-skill/SKILL.md"
    env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
      GIT_AUTHOR_NAME=Lab GIT_AUTHOR_EMAIL=lab@example.com GIT_COMMITTER_NAME=Lab GIT_COMMITTER_EMAIL=lab@example.com sh -c \
      'git -C "$1" add -A && git -C "$1" -c core.hooksPath=/dev/null commit -q -m "repo unico de laboratorio"' _ "$1"
  }
  cat > "$T/k3-check.py" <<'PY'
import json, os, re, sys
phase, home, tree, lab, fix_path, out_file = sys.argv[1:7]
# el nombre del lugar, de su definición (story 8.19; desde la 8.23 vive en tycon-home.js, place.js la re-exporta): nunca
# escrito a mano
PLACE = os.environ.get("TYCON_TEST_PLACE_NAME") or re.search(r"\bPLACE_NAME = '([^']+)'", open(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(fix_path)))), "setup", "harness", "tycon-home.js"), encoding="utf-8").read()).group(1)
claude = os.path.join(home, ".claude"); bad = []
rp = os.path.realpath
def lex(p): return os.path.lexists(p)
def points(name, target):
    p = os.path.join(claude, name)
    return os.path.islink(p) and rp(p) == rp(target)
def state():
    return json.load(open(os.path.join(claude, ".tycon-pipeline", "harness-state.json"), encoding="utf-8"))
def links(st):
    return [p for p in st.get("managed", []) if p.get("kind") == "link"]
def declared(st):
    fix = json.load(open(fix_path, encoding="utf-8"))
    for p in links(st):
        ok = False
        for d in fix["pieces"]:
            if d["kind"] != "link": continue
            if "id" in d and d["id"] != p["id"]: continue
            if "id_pattern" in d and not re.search(d["id_pattern"], p["id"]): continue
            if re.search(d["where_pattern"], p["where"]): ok = True; break
        if not ok: bad.append("el enlace %s (%s) no está en la lista declarada de piezas" % (p["id"], p["where"]))
out = open(out_file, encoding="utf-8").read() if out_file != "-" else ""
entries = {"skills": sorted(os.listdir(os.path.join(tree, "skills"))) if os.path.isdir(os.path.join(tree, "skills")) else [],
           "agents": sorted(os.listdir(os.path.join(tree, "agents"))) if os.path.isdir(os.path.join(tree, "agents")) else []}
if phase == "installed-links":
    # (story 8.35) el lugar y agent-skills son enlaces al clon; skills y agents, carpetas REALES con un enlace por entrada
    for name, target in ((PLACE, tree), ("agent-skills", tree)):
        if not points(name, target): bad.append("~/.claude/%s no es un enlace a %s" % (name, target))
    st = state(); ids = {p["id"] for p in links(st)}
    for want in (PLACE, "agent-skills"):
        if want not in ids: bad.append("el registro no trae el enlace «%s» (trae %s)" % (want, sorted(ids)))
    for name in ("skills", "agents"):
        d = os.path.join(claude, name)
        if os.path.islink(d) or not os.path.isdir(d): bad.append("~/.claude/%s no es una carpeta real" % name)
        if name in ids: bad.append("el registro trae «%s» entero" % name)
        for e in entries[name]:
            if not points(os.path.join(name, e), os.path.join(tree, name, e)): bad.append("falta el enlace por entrada ~/.claude/%s/%s" % (name, e))
            if "%s/%s" % (name, e) not in ids: bad.append("el registro no trae el enlace por entrada «%s/%s»" % (name, e))
    if len(st.get("sources", [])) != 1: bad.append("el estado tiene %d fuentes (repo único: una)" % len(st.get("sources", [])))
    declared(st)
elif phase == "installed-folders":
    for name, mine in (("skills", os.path.join("mine", "SKILL.md")), ("agents", "mine.md")):
        d = os.path.join(claude, name)
        if os.path.islink(d) or not os.path.isdir(d): bad.append("~/.claude/%s dejó de ser una carpeta real" % name)
        if not os.path.isfile(os.path.join(d, mine)): bad.append("lo propio de ~/.claude/%s se perdió" % name)
        for e in entries[name]:
            if not points(os.path.join(name, e), os.path.join(tree, name, e)): bad.append("falta el enlace por entrada ~/.claude/%s/%s" % (name, e))
    if not points("agent-skills", tree): bad.append("~/.claude/agent-skills no es un enlace al clon")
    st = state(); ids = {p["id"] for p in links(st)}
    for name in ("skills", "agents"):
        if name in ids: bad.append("el registro trae «%s» y es una carpeta real de la persona" % name)
        for e in entries[name]:
            if "%s/%s" % (name, e) not in ids: bad.append("el registro no trae el enlace por entrada «%s/%s»" % (name, e))
    declared(st)
elif phase == "dry-run":
    for name in ("agent-skills", PLACE, os.path.join("skills", "tycon-pipeline")):
        if "el enlace %s" % os.path.join(claude, name) not in out: bad.append("el plan no quita el enlace ~/.claude/%s" % name)
    if "no está registrado" in out: bad.append("el plan lista un enlace registrado como «no está registrado»")
elif phase == "removed-links":
    for name in (PLACE, "agent-skills"):
        if lex(os.path.join(claude, name)): bad.append("~/.claude/%s sigue" % name)
    # (story 8.35) skills queda como la carpeta de la persona, sin los enlaces del arnés adentro
    sk = os.path.join(claude, "skills")
    if os.path.islink(sk) or not os.path.isdir(sk): bad.append("~/.claude/skills dejó de ser una carpeta real")
    elif [e for e in os.listdir(sk) if os.path.islink(os.path.join(sk, e))]: bad.append("quedaron enlaces del arnés en ~/.claude/skills")
    if not points("agents", os.path.join(lab, "own-agents")): bad.append("~/.claude/agents (re-apuntado por la persona a otro lado) se tocó")
    if os.path.join(lab, "own-agents") not in out or "no lo toco" not in out: bad.append("la salida no dice que ~/.claude/agents apunta a otro lado y queda")
    if not os.path.isdir(os.path.join(tree, "skills", "tycon-pipeline")) or not os.path.isfile(os.path.join(tree, "agents", "lab-reviewer.md")): bad.append("el clon no quedó intacto")
    if lex(os.path.join(claude, ".tycon-pipeline", "harness-state.json")): bad.append("el estado sigue")
elif phase == "removed-folders":
    for name, mine in (("skills", os.path.join("mine", "SKILL.md")), ("agents", "mine.md")):
        d = os.path.join(claude, name)
        if os.path.islink(d) or not os.path.isdir(d): bad.append("~/.claude/%s dejó de ser una carpeta real" % name); continue
        if not os.path.isfile(os.path.join(d, mine)): bad.append("lo propio de ~/.claude/%s se perdió" % name)
        left = [e for e in os.listdir(d) if os.path.islink(os.path.join(d, e))]
        if left: bad.append("quedaron enlaces por entrada en ~/.claude/%s: %s" % (name, left))
    for name in (PLACE, "agent-skills"):
        if lex(os.path.join(claude, name)): bad.append("~/.claude/%s sigue (colgado)" % name)
    if lex(os.path.join(claude, ".tycon-pipeline", "harness-state.json")): bad.append("el estado sigue")
else:
    bad.append("fase desconocida: %s" % phase)
for b in bad: print("MAL: " + b)
sys.exit(1 if bad else 0)
PY
  k3_check() { # k3_check <fase> <home> <árbol> <lab> <salida|-> <mensaje ok>
    if python3 "$T/k3-check.py" "$1" "$2" "$3" "$4" "$FIX" "$5" > "$4/check-$1.txt" 2>&1; then ok "K3 $6"
    else mal "K3 $6"; head -8 "$4/check-$1.txt" | sed 's/^/        /'; fi
  }

  # variante 1 · la HOME sin skills/ ni agents/: desde la story 8.35, carpetas reales con un enlace por entrada (antes, tres
  # enlaces a la carpeta entera)
  L="$T/lab-k3a"; H="$L/casa"; A="$L/arbol"; rm -rf "$L"; mkdir -p "$L" "$H/.claude"
  lab_single_repo "$A" "$L"; lab_env "$H" "$L"; RUN_ENV+=(TYCON_THIRD_PARTY=0 TYCON_PRODUCTION_GUARD_DIR="$L/sin-freno")
  rc=0; "${RUN_ENV[@]}" node "$A/scripts/setup/harness.js" install --yes >"$L/install.txt" 2>&1 || rc=$?
  if [ "$rc" != 0 ]; then
    mal "K3 (enlaces) la instalación real sobre el repo único falló (rc $rc)"; tail -6 "$L/install.txt" | sed 's/^/        /'
  else
    k3_check installed-links "$H" "$A" "$L" - "instalado: los cuatro enlaces apuntan al clon, están en el registro y en la lista declarada, y hay una sola fuente"
    rc=0; "${RUN_ENV[@]}" node "$A/scripts/setup/harness.js" uninstall --dry-run < /dev/null > "$L/dry.txt" 2>&1 || rc=$?
    [ "$rc" = 0 ] || mal "K3 (enlaces) uninstall --dry-run salió $rc"
    k3_check dry-run "$H" "$A" "$L" "$L/dry.txt" "el plan quita los cuatro enlaces y ninguno sale como «no está registrado»"
    # la persona re-apunta ~/.claude/agents a una carpeta suya: sigue registrado, pero ya no apunta al árbol (espejo)
    mkdir -p "$L/own-agents"; rm -rf "$H/.claude/agents"; ln -s "$L/own-agents" "$H/.claude/agents"
    rc=0; "${RUN_ENV[@]}" node "$A/scripts/setup/harness.js" uninstall --yes < /dev/null > "$L/yes.txt" 2>&1 || rc=$?
    [ "$rc" = 0 ] || { mal "K3 (enlaces) uninstall --yes salió $rc"; head -6 "$L/yes.txt" | sed 's/^/        | /'; }
    k3_check removed-links "$H" "$A" "$L" "$L/yes.txt" "uninstall --yes: quita los enlaces al clon; el re-apuntado a otro lado queda y se dice; el clon intacto"
  fi

  # variante 2 · skills/ y agents/ ya son carpetas reales con algo propio: un enlace por entrada; se borra el clon y se
  # desinstala desde la copia fija (los enlaces quedaron colgados hacia adentro del clon borrado)
  L="$T/lab-k3b"; H="$L/casa"; A="$L/arbol"; rm -rf "$L"; mkdir -p "$L" "$H/.claude/skills/mine" "$H/.claude/agents"
  printf '# mi skill\n' > "$H/.claude/skills/mine/SKILL.md"; printf '# mi agente\n' > "$H/.claude/agents/mine.md"
  lab_single_repo "$A" "$L"; lab_env "$H" "$L"; RUN_ENV+=(TYCON_THIRD_PARTY=0 TYCON_PRODUCTION_GUARD_DIR="$L/sin-freno")
  rc=0; "${RUN_ENV[@]}" node "$A/scripts/setup/harness.js" install --yes >"$L/install.txt" 2>&1 || rc=$?
  if [ "$rc" != 0 ]; then
    mal "K3 (carpetas reales) la instalación real sobre el repo único falló (rc $rc)"; tail -6 "$L/install.txt" | sed 's/^/        /'
  else
    k3_check installed-folders "$H" "$A" "$L" - "carpetas reales: un enlace por entrada del clon, lo propio intacto, y cada uno en el registro y en la lista declarada"
    cp -R "$A" "$L/arbol-copia"; rm -rf "$A"   # el clon se borró (la copia es sólo para que la verificación lea sus entradas)
    rc=0; "${RUN_ENV[@]}" node "$H/.claude/.tycon-pipeline/harness/bootstrap.js" uninstall --yes < /dev/null > "$L/yes.txt" 2>&1 || rc=$?
    [ "$rc" = 0 ] || { mal "K3 (carpetas reales) bootstrap.js uninstall --yes salió $rc"; head -6 "$L/yes.txt" | sed 's/^/        | /'; }
    k3_check removed-folders "$H" "$L/arbol-copia" "$L" "$L/yes.txt" "sin el clon: los enlaces por entrada (colgados) y agent-skills se quitan; las carpetas y lo propio quedan"
  fi
  echo "  ·    K3 tardó $((SECONDS - K3_T0)) s"
fi

if corre REG; then
  echo "REG · regresiones del pase adversarial (tanda C)"
  cat > "$T/reg.js" <<'JS'
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const [, , raiz, dir] = process.argv;
const say = (c, m) => console.log(c ? `  ok   — ${m}` : `  MAL  — ${m}`);
const req = (m) => { try { return require(path.join(raiz, 'scripts/setup/harness', m)); } catch (e) { say(false, `REG: ${m} no carga (${e.message.split('\n')[0]})`); process.exit(0); } };
const R = req('remove.js'); const U = req('uninstall.js'); const ST = req('state.js'); const SN = req('snapshot.js');
const W = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); return f; };
const T = (f) => fs.readFileSync(f, 'utf8');
const J = (f) => JSON.parse(T(f));
const ex = (f) => { try { fs.lstatSync(f); return true; } catch (_) { return false; } };
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const h = (command) => ({ type: 'command', command });
const lab = (name) => {
  const home = path.join(dir, name, 'home'); const tree = path.join(dir, name, 'tree');
  fs.mkdirSync(path.join(tree, 'scripts/hooks'), { recursive: true }); fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const env = { TYCON_PRODUCTION_GUARD_DIR: path.join(dir, name, 'sin-freno'), TYCON_GIT_HOOKS_DIR: path.join(home, '.git-hooks'), CODEX_HOME: path.join(home, '.codex') };
  return { home, tree, env, claude: path.join(home, '.claude'), ctx: { home, env, platform: 'linux', tree } };
};
const run = (pieces, o) => { try { return R.removePieces(pieces, Object.assign({ log: () => {} }, o)); } catch (e) { say(false, `REG: removePieces tiró (${e.message})`); return { removed: [], kept: [], review: [], absent: [] }; } };
const urun = (L, state) => { try { return U.run(L.ctx, state, { log: () => {} }); } catch (e) { say(false, `REG: uninstall.run tiró (${e.message})`); return { ok: null, lines: [] }; } };

// REG-H1 · settings.json ilegible: la pieza no se pierde. run sale ok:false, el estado queda reescrito con ella y lo dice;
// arreglado el JSON, otra corrida la quita
{
  const L = lab('h1');
  const cmd = `node "${path.join(L.tree, 'scripts/hooks/x.js')}"`;
  const S = W(path.join(L.claude, 'settings.json'), `{"hooks":{"Stop":[{"hooks":[${JSON.stringify(h(cmd))}]}]},}\n`);
  const piece = { kind: 'hook', where: S, id: 'Stop:@tcg:x.js' };
  const out = urun(L, { schema: 1, tree: L.tree, sources: [], managed: [piece] });
  const sf = ST.paths(L.home).file;
  const st = ex(sf) ? J(sf) : null;
  say(out.ok === false && st && Array.isArray(st.managed) && st.managed.length === 1 && st.managed[0].id === piece.id && out.lines.some((l) => /a medias/.test(l)) && out.lines.some((l) => /JSON ilegible/.test(l)),
    `REG-H1 settings.json ilegible: ok=${out.ok}, estado ${st ? `con ${(st.managed || []).length} pieza(s)` : 'BORRADO'} (esperado ok=false y el estado con la pieza, dicho)`);
  W(S, `${JSON.stringify({ hooks: { Stop: [{ hooks: [h(cmd)] }] } })}\n`);
  const out2 = st ? urun(L, st) : { ok: null };
  say(out2.ok === true && !ex(sf) && !T(S).includes('x.js'), `REG-H1 arreglado el JSON, la otra corrida la quita (ok=${out2.ok})`);
}

// REG-H6 · un comando que el dev cambió queda aunque el árbol ya no traiga commands/<id> (vuelta atrás a un árbol viejo,
// clon borrado); el que sigue como lo dejó la instalación (afterSha) sí se va
{
  const L = lab('h6');
  const x = W(path.join(L.claude, 'commands/x.md'), 'lo edité yo\n');
  let r = run([{ kind: 'command', where: x, id: 'x.md' }], { home: L.home, env: L.env, tree: L.tree });
  say(ex(x) && T(x) === 'lo edité yo\n' && r.kept.length === 1 && r.removed.length === 0, `REG-H6 comando editado sin su par en el árbol: queda (removed=${r.removed.length}, kept=${r.kept.length})`);
  const y = W(path.join(L.claude, 'commands/y.md'), 'del arnés\n');
  r = run([{ kind: 'command', where: y, id: 'y.md' }], { home: L.home, env: L.env, tree: path.join(dir, 'h6', 'sin-arbol'), afterSha: { [y]: sha('del arnés\n') } });
  say(!ex(y) && r.removed.length === 1, 'REG-H6 sin árbol, el comando igual al que dejó la instalación se quita');
}

// REG-H7 · un repo que es un enlace a una carpeta (el aplicador lo recorre y deja ahí su puntero) también se lista
{
  const P = path.join(dir, 'h7');
  const ptr = '# AGENTS.md — puntero (lo depositó el arnés TYCON; commitealo así le llega al equipo)\n';
  W(path.join(P, 'repos/plain/AGENTS.md'), ptr); W(path.join(P, 'elsewhere/prod/AGENTS.md'), ptr);
  fs.symlinkSync(path.join(P, 'elsewhere/prod'), path.join(P, 'repos/prod'));
  const got = U.findPointers(path.join(P, 'repos'));
  say(got.includes(path.join(P, 'repos/plain/AGENTS.md')) && got.includes(path.join(P, 'repos/prod/AGENTS.md')), `REG-H7 findPointers ve el repo enlazado (${got.map((f) => path.relative(P, f)).join(', ')})`);
}

// REG-H13 · hooks del arnés con texto alrededor (argumento final, prefijo de env): no desaparecen en silencio
{
  const L = lab('h13');
  const p = (n) => path.join(L.tree, 'scripts/hooks', n);
  const S = W(path.join(L.claude, 'settings.json'), `${JSON.stringify({ hooks: { PreToolUse: [{ hooks: [h(`node "${p('a.js')}"`), h(`node "${p('b.js')}" --quiet`), h(`TYCON_X=1 node "${p('c.js')}"`)] }] } }, null, 2)}\n`);
  const pieces = ['a.js', 'b.js', 'c.js'].map((n) => ({ kind: 'hook', where: S, id: `PreToolUse:@tcg:${n}` }));
  const r = run(pieces, { home: L.home, env: L.env, tree: L.tree, dryRun: true });
  const rv = r.review.map((v) => v.piece.id);
  say(r.removed.length === 1 && rv.includes('PreToolUse:@tcg:b.js') && rv.includes('PreToolUse:@tcg:c.js') && !(r.absent || []).length,
    `REG-H13 b.js (--quiet) y c.js (prefijo de env) van a «revisalo», no a «ya no está» (review=${JSON.stringify(rv)}, absent=${(r.absent || []).length})`);
  const out = urun(L, { schema: 1, tree: L.tree, sources: [], managed: pieces });
  const txt = out.lines.join('\n');
  const left = J(S).hooks.PreToolUse[0].hooks.map((x) => x.command);
  say(/revisalo/.test(txt) && txt.includes('b.js') && txt.includes('c.js') && left.length === 2 && !left.some((c) => c.includes('a.js')),
    'REG-H13 uninstall los nombra en «revisalo» y no los toca; a.js se quitó');
}

// REG-H14 · `$HOME/…` o `~/…` que no cae en una raíz del arnés es ajeno; el que sí cae, del arnés
{
  const L = lab('h14');
  for (const [command, id, gone] of [['node "$HOME/scripts/hooks/x.js"', 'Stop:@tcg:x.js', false], ['bash "~/skills/clocki/a.sh"', 'Stop:clocki/a.sh', false],
    ['node "$HOME/.claude/tycon-claude-guides/scripts/hooks/y.js"', 'Stop:@tcg:y.js', true], ['node "~/.claude/agent-skills/skills/clocki/b.js"', 'Stop:clocki/b.js', true]]) {
    const S = W(path.join(L.claude, `s-${id.replace(/\W/g, '_')}.json`), `${JSON.stringify({ hooks: { Stop: [{ hooks: [h(command)] }] } })}\n`);
    const r = run([{ kind: 'hook', where: S, id }], { home: L.home, env: L.env, tree: L.tree });
    say(gone ? (r.removed.length === 1 && !T(S).includes('hooks')) : (r.removed.length === 0 && T(S).includes('hooks')),
      `REG-H14 ${command} con ${id}: ${gone ? 'del arnés, se quita' : 'ajeno, queda'} (removed=${r.removed.length})`);
  }
}

// REG-H15 · hooks.json/config.toml de Codex: la copia install más vieja dice «no existía», pero una reinstalación lo
// encontró con contenido del dev → no se borra, va a «revisalo»; el que sigue como lo dejó la instalación sí se va
{
  const L = lab('h15');
  const cx = L.env.CODEX_HOME; const hj = path.join(cx, 'hooks.json'); const ct = path.join(cx, 'config.toml');
  const senv = { HOME: L.home, CODEX_HOME: cx, TYCON_GIT_HOOKS_DIR: L.env.TYCON_GIT_HOOKS_DIR };
  const s1 = SN.take({ home: L.home, env: senv, tree: L.tree, reason: 'install', now: new Date('2026-01-01T00:00:00Z') });
  SN.finish(s1.dir, { home: L.home, env: senv });
  W(hj, '{"dev":"mine"}\n'); W(ct, 'mio = 1\n');
  const s2 = SN.take({ home: L.home, env: senv, tree: L.tree, reason: 'install', now: new Date('2026-02-01T00:00:00Z') });
  W(hj, '{"dev":"mine","hooks":{"tycon":1}}\n'); W(ct, 'mio = 1\n[tycon]\nx = 1\n');
  SN.finish(s2.dir, { home: L.home, env: senv });
  const pieces = [{ kind: 'codex', where: hj, id: 'hooks.json' }, { kind: 'codex', where: ct, id: 'config.toml' }];
  const out = urun(L, { schema: 1, tree: L.tree, sources: [], managed: pieces });
  const txt = out.lines.join('\n');
  say(ex(hj) && T(hj).includes('"dev":"mine"') && ex(ct) && T(ct).includes('mio = 1') && /revisalo/.test(txt) && txt.includes(hj),
    `REG-H15 hooks.json/config.toml con contenido del dev: quedan y van a «revisalo» (hooks.json ${ex(hj) ? 'sigue' : 'BORRADO'}, config.toml ${ex(ct) ? 'sigue' : 'BORRADO'})`);
  // control: instalación que los crea y nadie los toca después → se borran
  const C = lab('h15c'); const cx2 = C.env.CODEX_HOME; const hj2 = path.join(cx2, 'hooks.json');
  const senv2 = { HOME: C.home, CODEX_HOME: cx2, TYCON_GIT_HOOKS_DIR: C.env.TYCON_GIT_HOOKS_DIR };
  const c1 = SN.take({ home: C.home, env: senv2, tree: C.tree, reason: 'install', now: new Date('2026-01-01T00:00:00Z') });
  W(hj2, '{"hooks":{"tycon":1}}\n'); SN.finish(c1.dir, { home: C.home, env: senv2 });
  const out2 = urun(C, { schema: 1, tree: C.tree, sources: [], managed: [{ kind: 'codex', where: hj2, id: 'hooks.json' }] });
  say(out2.ok === true && !ex(hj2), 'REG-H15 control: hooks.json que creó la instalación y nadie tocó se borra');
}

// REG-R1 · `file` y `codex` sólo se borran bajo su raíz (la copia fija; CODEX_HOME o el espejo AGENTS.md)
{
  const L = lab('r1');
  const hd = ST.paths(L.home).harnessDir;
  const out1 = W(path.join(dir, 'r1', 'fuera', 'importante.txt'), 'no me borres\n');
  const outDir = path.join(dir, 'r1', 'fuera-dir'); W(path.join(outDir, 'dato.txt'), 'tampoco\n');
  fs.mkdirSync(hd, { recursive: true }); fs.symlinkSync(outDir, path.join(hd, 'enlace'));
  const cxOut = W(path.join(dir, 'r1', 'otro-codex', 'agents', 'x.toml'), 'z = 1\n');
  const r = run([
    { kind: 'file', where: out1, id: 'bootstrap.js' },
    { kind: 'file', where: path.join(hd, '..', '..', '..', '..', 'fuera'), id: 'program/' },
    { kind: 'file', where: path.join(hd, 'enlace', 'dato.txt'), id: 'program/harness.js' },
    { kind: 'codex', where: cxOut, id: 'agents/x.toml' },
  ], { home: L.home, env: L.env, tree: L.tree });
  say(ex(out1) && ex(path.join(outDir, 'dato.txt')) && ex(cxOut) && r.removed.length === 0 && r.kept.length === 4,
    `REG-R1 file/codex fuera de su raíz (también por «..» o por un enlace) no se tocan (removed=${r.removed.length}, kept=${r.kept.length})`);
}

// REG-R2 · un ajuste con el valor que puso el arnés, sin cambiar, SÍ se quita (y lo demás queda)
{
  const L = lab('r2');
  const S = W(path.join(L.claude, 'settings.json'), `${JSON.stringify({ model: 'opus', cleanupPeriodDays: 365 }, null, 2)}\n`);
  const r = run([{ kind: 'setting', where: S, id: 'cleanupPeriodDays', value: 365 }], { home: L.home, env: L.env, tree: L.tree });
  say(r.removed.length === 1 && !('cleanupPeriodDays' in J(S)) && J(S).model === 'opus', 'REG-R2 cleanupPeriodDays con el valor del arnés se quita; model queda');
}

// REG-R4 · la misma clase que R1 (revisión de seguridad, iteración 2): `git-hook` y `launch-agent` sólo se borran bajo su
// carpeta (TYCON_GIT_HOOKS_DIR o ~/.git-hooks; ~/Library/LaunchAgents)
{
  const L = lab('r4');
  const fueraHook = W(path.join(dir, 'r4', 'otro-lado', 'pre-commit'), '#!/bin/sh\n# git-pre-commit-global.sh\nexit 0\n');
  const fueraPlist = W(path.join(dir, 'r4', 'otro-lado', 'ar.com.tycon.harness-env.plist'), '<plist/>\n');
  const r = run([
    { kind: 'git-hook', where: fueraHook, id: 'pre-commit' },
    { kind: 'launch-agent', where: fueraPlist, id: 'ar.com.tycon.harness-env' },
  ], { home: L.home, env: Object.assign({}, L.env, { LAUNCHCTL_BIN: '/usr/bin/true' }), tree: L.tree });
  say(ex(fueraHook) && ex(fueraPlist) && r.removed.length === 0 && r.kept.length === 2,
    `REG-R4 git-hook/launch-agent fuera de su carpeta no se tocan (removed=${r.removed.length}, kept=${r.kept.length})`);
}
JS
  rm -rf "$T/reg"; mkdir -p "$T/reg"
  node "$T/reg.js" "$RAIZ" "$T/reg" > "$T/reg.txt" 2>&1
  cat "$T/reg.txt"
  n=$(grep -c '^  MAL' "$T/reg.txt"); FALLOS=$((FALLOS + n))
  grep -q '^  ok' "$T/reg.txt" || mal "REG no corrió"
fi

# ═══ T38 (story 8.18, AC 37) · uninstall en las tres formas de máquina ═══════════════════════════════════════════════
# `uninstall` quita sólo lo registrado en las tres formas, y NO borra el clon viejo de skills ni toca su remoto: ni el de
# antes (dos clones sin re-apuntar) ni el re-apuntado al repo unificado (que queda re-apuntado y mostrando sólo lo suyo:
# deshacer la mudanza es la llave, no la desinstalación). Va al final: el laboratorio cambia la HOME de la suite.
if corre T38; then
  echo "T38 · Mechanism_SkillsSourceInThreeShapes_Uninstall"
  # shellcheck disable=SC1091
  source "$RAIZ/scripts/tests/lib/harness-lab.sh"
  for shape in two-clones repointed single; do
    harness_lab_shape "$T/t38-$shape" "$shape" || { mal "T38 ($shape) no pude armar la máquina"; continue; }
    S_ORIGEN="$(harness_lab_git "$LAB_SKILLS" remote get-url origin)"; S_HEAD="$(harness_lab_git "$LAB_SKILLS" rev-parse HEAD)"
    S_EXTRAS="$(harness_lab_clone_extras "$LAB_SKILLS")"; S_ARBOL="$(harness_lab_worktree_hash "$LAB_SKILLS")"
    S_CONFIG="$(shasum -a 256 < "$LAB_SKILLS/.git/config")"; T_HEAD="$(harness_lab_git "$LAB_TREE" rev-parse HEAD)"
    SALIDA="$(harness uninstall --dry-run < /dev/null 2>&1)"; RC=$?
    if [ "$shape" = single ]; then
      [ "$RC" = 0 ] && case "$SALIDA" in *"el clon de agent_skills"*) false ;; *"el clon "*"/clones/harness"*) true ;; *) false ;; esac \
        && ok "T38 (single) --dry-run: deja el clon, y no nombra un clon aparte de skills" || mal "T38 (single) --dry-run (rc $RC): $SALIDA"
    else
      [ "$RC" = 0 ] && case "$SALIDA" in *"el clon de agent_skills "*"/.claude/agent-skills"*) true ;; *) false ;; esac \
        && ok "T38 ($shape) --dry-run: dice que deja el clon de agent_skills" || mal "T38 ($shape) --dry-run (rc $RC): $SALIDA"
    fi
    SALIDA="$(harness uninstall --yes < /dev/null 2>&1)"; RC=$?
    [ "$RC" = 0 ] && [ ! -e "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json" ] && ok "T38 ($shape) uninstall --yes sale 0 y quita el estado" || mal "T38 ($shape) uninstall --yes (rc $RC): $SALIDA"
    [ -d "$LAB_SKILLS/skills/tycon-pipeline" ] && [ "$(harness_lab_git "$LAB_SKILLS" remote get-url origin)" = "$S_ORIGEN" ] && [ "$(harness_lab_git "$LAB_SKILLS" rev-parse HEAD)" = "$S_HEAD" ] \
      && [ "$(shasum -a 256 < "$LAB_SKILLS/.git/config")" = "$S_CONFIG" ] && [ "$(harness_lab_clone_extras "$LAB_SKILLS")" = "$S_EXTRAS" ] && [ "$(harness_lab_worktree_hash "$LAB_SKILLS")" = "$S_ARBOL" ] \
      && ok "T38 ($shape) el clon de skills queda como estaba: ni borrado, ni su remoto, ni su commit, ni un archivo" || mal "T38 ($shape) uninstall tocó el clon de skills: origin $(harness_lab_git "$LAB_SKILLS" remote get-url origin) (era $S_ORIGEN)"
    [ "$(harness_lab_git "$LAB_TREE" rev-parse HEAD)" = "$T_HEAD" ] && ok "T38 ($shape) el clon del arnés queda donde estaba" || mal "T38 ($shape) uninstall movió el clon del arnés"
    if [ "$shape" = repointed ]; then
      [ "$S_ORIGEN" = "$LAB_REMOTE_UNIFIED" ] && [ ! -e "$LAB_SKILLS/scripts" ] && ok "T38 (repointed) …y sigue re-apuntado al repo unificado, mostrando sólo lo suyo" || mal "T38 (repointed) el clon dejó de estar re-apuntado"
    fi
    SALIDA="$(harness uninstall --yes < /dev/null 2>&1)"; RC=$?
    [ "$RC" = 0 ] && case "$SALIDA" in *"nada que quitar"*) ok "T38 ($shape) la segunda corrida: «nada que quitar»" ;; *) mal "T38 ($shape) segunda corrida: $SALIDA" ;; esac || mal "T38 ($shape) segunda corrida: rc $RC"
  done
fi

# ── S16-T6 · Uninstall_KeepsListed_ResponseStyleAndSafetyGuardLog (story 8.16, tanda A · AC 6) ──────────────────────
# El caso (auditoría de la copia publicada, 2026-10-03): la portada decía «uninstall deshace todo» y el comando deja,
# entre otras cosas, lo que guardaron dos hooks: las respuestas largas (`~/.claude/response-style/`) y los comandos
# bloqueados (`~/.claude/safety-guard.log`). No las nombraba. Ahora están en «deja» cuando existen, y sólo entonces.
if corre S16; then
  echo "S16-T6 · Uninstall_KeepsListed_ResponseStyleAndSafetyGuardLog"
  # shellcheck disable=SC1091
  source "$RAIZ/scripts/tests/lib/harness-lab.sh"
  harness_lab_create "$T/s16-t6" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "S16-T6 install previo falló"
  # lo que «deja» lista: de la línea «deja:» a la primera que no es un ítem
  deja() { printf '%s\n' "$SALIDA" | awk '/^deja:/{d=1;next} d&&/^  - /{print;next} d{exit}'; }
  SALIDA="$(harness uninstall --dry-run < /dev/null 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$(deja)" in *response-style*|*safety-guard.log*) mal "S16-T6 sin esas rutas en la máquina las nombra igual: $(deja)" ;; *) ok "S16-T6 sin las dos rutas en la máquina, «deja» no las nombra" ;; esac || mal "S16-T6 --dry-run sin las rutas: rc $RC: $SALIDA"
  mkdir -p "$LAB_HOME/.claude/response-style/long"; printf 'una respuesta larga\n' > "$LAB_HOME/.claude/response-style/long/x.md"
  printf 'un comando bloqueado\n' > "$LAB_HOME/.claude/safety-guard.log"
  # los otros dos medidores también guardan fuera de la carpeta de estado (pase adversarial de la tanda A)
  mkdir -p "$LAB_HOME/.claude/blocking-meter" "$LAB_HOME/.claude/lectura-grande"
  printf '{}\n' > "$LAB_HOME/.claude/blocking-meter/log.jsonl"; printf '{}\n' > "$LAB_HOME/.claude/lectura-grande/log.jsonl"
  ANTES="$(harness_lab_home_hash)"
  SALIDA="$(harness uninstall --dry-run < /dev/null 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(harness_lab_home_hash)" = "$ANTES" ] && ok "S16-T6 --dry-run sale 0 y no toca nada" || mal "S16-T6 --dry-run (rc $RC) tocó la HOME o falló: $SALIDA"
  case "$(deja)" in *"$LAB_HOME/.claude/response-style"*) ok "S16-T6 «deja» nombra ~/.claude/response-style/" ;; *) mal "S16-T6 «deja» no nombra response-style: $(deja)" ;; esac
  case "$(deja)" in *"$LAB_HOME/.claude/safety-guard.log"*) ok "S16-T6 «deja» nombra ~/.claude/safety-guard.log" ;; *) mal "S16-T6 «deja» no nombra safety-guard.log: $(deja)" ;; esac
  case "$(deja)" in *"$LAB_HOME/.claude/blocking-meter"*"$LAB_HOME/.claude/lectura-grande"*) ok "S16-T6 «deja» nombra también lo que guardan los otros dos medidores" ;; *) mal "S16-T6 «deja» no nombra blocking-meter y lectura-grande: $(deja)" ;; esac
  SALIDA="$(harness uninstall --yes < /dev/null 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -f "$LAB_HOME/.claude/response-style/long/x.md" ] && [ -f "$LAB_HOME/.claude/safety-guard.log" ] && ok "S16-T6 uninstall --yes las deja de verdad" || mal "S16-T6 uninstall --yes (rc $RC) las tocó: $SALIDA"
  case "$SALIDA" in *"$LAB_HOME/.claude/response-style"*"$LAB_HOME/.claude/safety-guard.log"*|*"$LAB_HOME/.claude/safety-guard.log"*"$LAB_HOME/.claude/response-style"*) ok "S16-T6 …y el cierre de uninstall las nombra" ;; *) mal "S16-T6 el cierre de uninstall no las nombra: $SALIDA" ;; esac
fi

# ── T29 de la story 8.39 · Uninstall_DosFormas_DejaLaCarpetaNombrada ─────────────────────────────────────────────────
# @story-8.39 @ac-22  uninstall reconoce el hook del arnés escrito con la ruta del Node propio (sin comillas, con
# comillas, y la forma de Windows en texto) y deja ~/.tycon/node, nombrado en «deja» con el comando para borrarlo
echo "T29 · uninstall y el Node del arnés"
T29_RES="$(node -e '
const { isHarnessCommand } = require(process.argv[1]);
const roots = ["/h/.claude/tycon-harness", "C:/Users/dev/.claude/tycon-harness"];
const rel = "@tcg:x.js";
const cases = [
  ["/h/.tycon/node/current/bin/node \"/h/.claude/tycon-harness/scripts/hooks/x.js\"", true],
  ["\"/h/mi casa/.tycon/node/current/bin/node\" \"/h/.claude/tycon-harness/scripts/hooks/x.js\"", true],
  ["C:/Users/dev/.tycon/node/current/node.exe \"C:/Users/dev/.claude/tycon-harness/scripts/hooks/x.js\"", true],
  ["node \"/h/.claude/tycon-harness/scripts/hooks/x.js\"", true],
  ["/usr/bin/otro \"/h/.claude/tycon-harness/scripts/hooks/x.js\"", false],
];
const bad = cases.filter(([c, want]) => isHarnessCommand(c, rel, roots) !== want).map(([c]) => c);
process.stdout.write(bad.join(" | "));' "$RAIZ/scripts/setup/harness/remove.js" 2>&1)"
[ -z "$T29_RES" ] && ok "T29 remove.js reconoce las formas con el Node del arnés (y no otro programa)" || mal "T29 remove.js no reconoce: $T29_RES"
# shellcheck disable=SC1091
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
harness_lab_create "$T/t29" >/dev/null
harness install --yes >/dev/null 2>&1 || mal "T29 install previo falló"
mkdir -p "$LAB_HOME/.tycon/node/versions/v24.21.0/bin"
B29="$LAB_HOME/.tycon/node/current/bin/node"
node -e 'const f=process.argv[1],b=process.argv[2];const s=JSON.parse(require("fs").readFileSync(f,"utf8"));for(const g of Object.values(s.hooks||{}))for(const e of g)for(const h of e.hooks||[])if(/^node "/.test(h.command)&&/lab-hook\.js"$/.test(h.command))h.command=h.command.replace(/^node /,b+" ");require("fs").writeFileSync(f,JSON.stringify(s,null,2))' "$LAB_HOME/.claude/settings.json" "$B29"
grep -q "$B29 " "$LAB_HOME/.claude/settings.json" || mal "T29 no pude pasar el hook de juguete a la forma nueva"
SALIDA="$(harness uninstall --yes < /dev/null 2>&1)"; RC=$?
[ "$RC" = 0 ] && ! grep -q 'lab-hook.js' "$LAB_HOME/.claude/settings.json" 2>/dev/null && ok "T29 uninstall saca el hook en la forma nueva" || mal "T29 uninstall (rc $RC) dejó el hook: $(grep -c lab-hook.js "$LAB_HOME/.claude/settings.json" 2>/dev/null)"
[ -d "$LAB_HOME/.tycon/node" ] && case "$SALIDA" in *"el Node propio del arnés $LAB_HOME/.tycon/node/ — para borrarlo: rm -rf"*) true ;; *) false ;; esac \
  && ok "T29 ~/.tycon/node queda, nombrado en «deja» con el comando para borrarlo" || mal "T29 la carpeta del Node: $( [ -d "$LAB_HOME/.tycon/node" ] && echo queda || echo borrada ) · salida: $(printf '%s' "$SALIDA" | grep -i 'node' | head -3)"

echo
if [ "$FALLOS" -gt 0 ]; then echo "❌ harness-uninstall: FALLARON $FALLOS chequeo(s)"; exit 1; fi
echo "✅ harness-uninstall: todo verde"; exit 0
