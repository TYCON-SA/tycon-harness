#!/usr/bin/env bash
#
# sync-claude-md-blocks.sh — sincroniza los bloques team-wide de `~/.claude/CLAUDE.md`
# desde `claude-md-blocks/*.md` de este repo — y, en una máquina que usa Codex, llama a
# `agents-md-blocks.js`, que deja los mismos bloques en `~/.codex/AGENTS.md` (story 8.23, tanda C).
#
# Por qué existe: `~/.claude/CLAUDE.md` NO está versionado — es un archivo suelto en el
# home de cada dev. Las guías de este repo son lectura *on-demand* (Claude las abre cuando
# aplica el trigger), así que una regla que tiene que estar SIEMPRE cargada — estilo de
# respuesta, convenciones de comunicación — no puede vivir en `guides/`: tiene que estar
# en el `CLAUDE.md`. Este script es el puente.
#
# Lado Codex (2026-08-20; cambiado en la story 8.23, tanda C): dos copias de la misma regla se
# separan solas — la copia manual de julio en `~/.codex/AGENTS.md` driftó 48 líneas sin que
# nadie se entere (caso disparador de codex-migration.md). Hasta la tanda C este script escribía
# AGENTS.md como COPIA ENTERA del CLAUDE.md; desde entonces AGENTS.md lleva los BLOQUES entre sus
# marcas, escritos por `agents-md-blocks.js` sin leer el CLAUDE.md (un dev que sólo usa Codex no
# tiene CLAUDE.md que copiar, y lo que la persona escribe en AGENTS.md ya no se pisa). Los bloques
# con variante por lado en `claude-md-blocks/names/<bloque>.codex.md` (hoy: `tool-names`) llevan el
# cuerpo de la variante: las reglas refieren a las tools por lo que hacen, y los nombres exactos
# viven en la sección de nombres-por-herramienta, distinta por lado.
#
# Diseño (mismo contrato que install-tycon-hooks.sh):
#   - Idempotente: corre N veces, si el contenido ya coincide no toca el archivo.
#   - Quirúrgico (lado Claude): SOLO reemplaza lo que está entre sus propios marcadores.
#     Todo lo que el dev escribió a mano queda intacto (incluido el bloque CODEGRAPH).
#   - Backup automático `<target>.bak.<timestamp>` ANTES del primer cambio — salvo lanzado por `harness.js`
#     (`TYCON_HARNESS_SNAPSHOT_DIR` puesta, story 8.13 AC 18): ahí la copia ya la tomó el mecanismo.
#   - Con `TYCON_REPORT_PIECES=<archivo>` (se la deja el aplicador con `--report-json`) anota ahí, una por línea, los
#     bloques que quedaron en su lugar (story 8.13, AC 15); el AGENTS.md de Codex lo anota `agents-md-blocks.js`. Con
#     `--check` no anota nada.
#   - Atomic write (tmp + mv).
#   - Silencioso si no hubo cambios; 1 línea por bloque/target actualizado.
#   - Fail-open total: cualquier problema → exit 0 sin romper el arranque de la sesión.
#   - Opt-out: `TYCON_NO_CLAUDEMD_SYNC=1`. Lado Codex: opt-IN con `TYCON_CODEX=1`.
#   - Cross-platform: bash + python3 (sin jq). Contraparte Windows: sync-claude-md-blocks.ps1
#     (⚠ al 2026-08-20 la .ps1 NO tiene el lado Codex — se nivela en la Etapa F, que es por OS).
#
# Cómo llega a las demás máquinas: el hook `SessionStart` hace `git pull` de este repo y
# después corre `install-tycon-hooks.sh`, que invoca este script. O sea, el dev no hace nada:
# el bloque se actualiza solo en el primer arranque de sesión posterior al push.
#
# Agregar un bloque nuevo: crear `claude-md-blocks/<nombre>.md` y commitear. El nombre del
# archivo es el nombre del bloque; los marcadores se generan solos. Si el bloque necesita
# contenido distinto en Codex, crear además `claude-md-blocks/names/<nombre>.codex.md`.
#
# Un bloque que requiere una integración (story 8.7, AC 25): si la PRIMERA línea del archivo es exactamente
# `<!-- requires-integration: <integración> -->`, el bloque se escribe sólo con esa integración prendida según
# `scripts/lib/tycon-config.js integrations --json` (se pregunta una vez, y sólo si algún bloque lo declara):
#   - prendida → se agrega o se actualiza, como cualquier otro. Esa primera línea NO se copia: el CLAUDE.md de una
#     máquina con la integración prendida queda byte a byte como antes de que existiera el comentario.
#   - apagada  → no se agrega; si ya estaba, se quita entre sus marcadores (con `--check` sólo avisa que sobra) y no se
#     anota como pieza. El AGENTS.md de Codex aplica la misma regla por su cuenta (`agents-md-blocks.js`).
#   - no se pudo saber (configuración rota, sin `node`, integración que el lector no conoce) → no se agrega si falta;
#     si está, queda y se actualiza; una línea lo dice. No saber no es «apagada».
#
# Un bloque que requiere un perfil de instalación (story 8.16, tanda C · AC 24): `<!-- requires-profile: full -->` en sus
# primeras líneas, solo o junto a `requires-integration` (uno de cada uno como mucho, en cualquier orden; ninguno se copia).
# El perfil sale de `tycon-config.js get install.profile` (sin valor es `full`, lo de siempre). Con el perfil activo fuera
# de la lista, el bloque se trata como con su integración apagada (no se agrega; si estaba, se quita entre sus marcadores;
# con `--check` sólo avisa que sobra); si no se pudo saber, como «no se pudo saber». Apagado por una de las dos razones
# alcanza. Con `full` o sin valor, el CLAUDE.md queda byte a byte como antes de que existiera el marcador.
#
# Un paquete también puede traer reglas siempre cargadas: los `.md` de `packs/<paquete>/claude-md-blocks/`, que se escriben
# como el bloque `packs/<paquete>/<nombre>` mientras la organización activa ese paquete (`packs.default`, el mismo que enlaza
# sus revisores y sus skills; lo dice `scripts/lib/pack-pieces.js blocks --json`). Llevan los mismos marcadores de
# integración y de perfil. Un bloque `packs/…` ya escrito cuyo paquete dejó de estar activo, o que ya no lo trae, se quita
# entre sus marcadores; si no se pudo saber qué paquetes activa la organización, queda donde está y una línea lo dice.
#
# Uso:
#   ./sync-claude-md-blocks.sh          # sincroniza
#   ./sync-claude-md-blocks.sh --check  # reporta qué está desactualizado, no modifica

set -uo pipefail

[[ "${TYCON_NO_CLAUDEMD_SYNC:-0}" == "1" ]] && exit 0

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BLOCKS_DIR="$SCRIPT_DIR/../../claude-md-blocks"
TARGET="${CLAUDE_MD_PATH:-$HOME/.claude/CLAUDE.md}"
CODEX_TARGET="${CODEX_AGENTS_MD_PATH:-$HOME/.codex/AGENTS.md}"
# 🔴 LA SEÑAL NO PUEDE VIVIR SÓLO EN EL ENTORNO (2026-09-04).
#
# El espejo de Codex se mantenía únicamente con TYCON_CODEX=1, una variable del rc del shell del
# dev. Este guion corre desde el arranque de sesión, que NO lee ese rc: la llave existía para el
# dev y no para el proceso que hace el trabajo. Medido ese día: la variable estaba puesta (línea
# 162 del .zshrc) y el AGENTS.md llevaba CINCO DÍAS sin actualizar, con el bloque de estilo viejo
# de 16.833 caracteres mientras el de Claude ya tenía 6.352. Nada avisaba: el espejo se congeló en
# silencio, que es la forma en que mueren estas piezas.
#
# Ahora la señal es el DISCO, que sí ve el proceso: si el AGENTS.md ya existe CON bloques del
# arnés, esta máquina usa Codex y su espejo se mantiene, haya o no variable. La variable sigue
# sirviendo para ESTRENAR el espejo donde todavía no existe — a una máquina que no usa Codex no se
# le impone uno.
CODEX_ON="${TYCON_CODEX:-0}"
if [[ "$CODEX_ON" != "1" ]] && [[ -f "$CODEX_TARGET" ]] && grep -q 'TYCON_BLOCK:' "$CODEX_TARGET" 2>/dev/null; then
  CODEX_ON=1
fi

[[ -d "$BLOCKS_DIR" ]] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

python3 - "$BLOCKS_DIR" "$TARGET" "$CHECK_ONLY" "$SCRIPT_DIR/../lib/tycon-config.js" "$SCRIPT_DIR/../lib/pack-pieces.js" <<'PYEOF'
import os, sys, glob, datetime, tempfile, re, json, subprocess

blocks_dir, target, check_only = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
config_reader = sys.argv[4]
packs_reader = sys.argv[5]

# Las primeras líneas de un bloque pueden declarar la integración que requiere y el perfil de instalación que requiere
# (story 8.16, tanda C · AC 24): `<!-- requires-integration: <x> -->` y `<!-- requires-profile: full -->`, una de cada una
# como mucho y en cualquier orden. No son parte del cuerpo.
REQUIRES_RE = re.compile(r"^<!--\s*requires-integration:\s*([a-z]+)\s*-->\s*$")
PROFILE_RE = re.compile(r"^<!--\s*requires-profile:\s*([a-z]+(?:\s*,\s*[a-z]+)*)\s*-->\s*$")

# Un marcador CASI bien escrito (otra forma, o después del cuerpo) no es un bloque común: sería una regla escrita
# donde su servicio está apagado, con el comentario copiado al CLAUDE.md y sin una palabra. Es «no se pudo saber».
LOOKS_LIKE_REQUIRES_RE = re.compile(r"^\s*<!--\s*requires-integration\b", re.IGNORECASE)
LOOKS_LIKE_PROFILE_RE = re.compile(r"^\s*<!--\s*requires-profile\b", re.IGNORECASE)
PROFILES = ("minimal", "full")

def read_block(path):
    """(cuerpo, integración requerida o None, perfiles requeridos o None, marcador mal escrito o None): el cuerpo va sin
    las líneas de los marcadores (bien o mal escritos: nunca se copian) y con el recorte de saltos de siempre. Un BOM
    delante no cambia nada. El marcador mal escrito es `(clase, línea)`: `integration` o `profile`."""
    with open(path, "r", encoding="utf-8") as fh:
        raw = fh.read()
    if raw.startswith("﻿"):
        raw = raw[1:]
    lines = raw.split("\n")
    requires, profiles, bad, i = None, None, None, 0
    # los marcadores bien escritos, al principio y seguidos (como siempre: un solo marcador en la primera línea)
    while i < len(lines):
        m, p = REQUIRES_RE.match(lines[i]), PROFILE_RE.match(lines[i])
        if m and requires is None:
            requires = m.group(1)
        elif p and profiles is None:
            profiles = tuple(x.strip() for x in p.group(1).split(","))
            if any(x not in PROFILES for x in profiles):
                bad = ("profile", lines[i].strip())   # un perfil que no existe: no se puede decidir
        elif m or p:
            bad = ("integration" if m else "profile", lines[i].strip())   # dos del mismo: «uno de cada uno como mucho»
        else:
            break
        i += 1
    rest = lines[i:]
    if bad is None:
        for idx, line in enumerate(rest):
            if not line.strip():
                continue
            if LOOKS_LIKE_REQUIRES_RE.match(line) or LOOKS_LIKE_PROFILE_RE.match(line):
                bad = ("integration" if LOOKS_LIKE_REQUIRES_RE.match(line) else "profile", line.strip())
                rest = rest[:idx] + rest[idx + 1:]
            break   # la primera línea con texto es otra cosa: el cuerpo
    return "\n".join(rest).strip("\n"), requires, profiles, bad

_asked = []  # la respuesta del lector, una sola vez: (integraciones, None) o (None, por qué no se pudo saber)

def ask_integrations():
    if _asked:
        return _asked[0]
    data, why = None, None
    if not os.path.isfile(config_reader):
        why = "no encontré el lector de configuración (scripts/lib/tycon-config.js)"
    else:
        try:
            # sólo la salida, y en bytes: lo que el lector dice por stderr (la configuración rota) ya lo muestra el instalador
            r = subprocess.run(["node", config_reader, "integrations", "--json"], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, timeout=10)
            if r.returncode == 2:
                why = "configuración rota: `node scripts/lib/tycon-config.js validate` dice qué"
            elif r.returncode != 0:
                why = "el lector de configuración falló (exit %d)" % r.returncode
            else:
                data = json.loads(r.stdout.decode("utf-8"))
                if not isinstance(data, dict):
                    data, why = None, "el lector de configuración contestó algo que no se entiende"
        except FileNotFoundError:
            why = "falta node en el PATH"
        except subprocess.TimeoutExpired:
            why = "el lector de configuración no contestó a tiempo"
        except (OSError, ValueError):
            why = "el lector de configuración contestó algo que no se entiende"
    _asked.append((data, why))
    return _asked[0]

def integration_state(name):
    """('on' | 'off' | 'unknown', motivo). `detect` cuenta como prendida, igual que en el lector."""
    data, why = ask_integrations()
    if data is None:
        return "unknown", why
    if name not in data:
        return "unknown", "el lector no conoce esa integración"
    return ("off" if data[name] is False else "on"), None

_response = []  # cómo contesta el asistente, una sola vez: ({language, style, max_chars}, None) o (None, por qué no)

def ask_response():
    """Story 2.31: el idioma, el estilo y el tope del bloque de respuesta, ya resueltos por el lector."""
    if _response:
        return _response[0]
    data, why = None, None
    if not os.path.isfile(config_reader):
        why = "no encontré el lector de configuración (scripts/lib/tycon-config.js)"
    else:
        try:
            r = subprocess.run(["node", config_reader, "response", "--json"], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, timeout=10)
            if r.returncode == 2:
                why = "configuración rota: `node scripts/lib/tycon-config.js validate` dice qué"
            elif r.returncode != 0:
                why = "el lector de configuración falló (exit %d)" % r.returncode
            else:
                data = json.loads(r.stdout.decode("utf-8"))
                if not isinstance(data, dict) or not isinstance(data.get("max_chars"), int):
                    data, why = None, "el lector de configuración contestó algo que no se entiende"
        except FileNotFoundError:
            why = "falta node en el PATH"
        except subprocess.TimeoutExpired:
            why = "el lector de configuración no contestó a tiempo"
        except (OSError, ValueError):
            why = "el lector de configuración contestó algo que no se entiende"
    _response.append((data, why))
    return _response[0]

VARIANTS_RE = re.compile(r"^<!--\s*variants:\s*(response)\s*-->\s*$")

def variants_of(path):
    """La configuración que elige el texto del bloque (`response`) si sus primeras líneas lo declaran
    (`<!-- variants: response -->`, junto a los otros marcadores), o None: un bloque común."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.read().lstrip("﻿").split("\n")
    except OSError:
        return None
    for line in lines:
        v = VARIANTS_RE.match(line)
        if v:
            return v.group(1)
        if not (REQUIRES_RE.match(line) or PROFILE_RE.match(line)):
            return None
    return None

def variant_file(directory):
    """(archivo de la variante elegida, None) o (None, por qué no se pudo elegir). Las variantes de un bloque viven en la
    carpeta del mismo nombre, `claude-md-blocks/<bloque>/<estilo>.<idioma>.md` (story 2.31: hoy, response-style)."""
    try:
        os.listdir(directory)
    except OSError:
        return None, "no pude leer su carpeta de variantes"
    data, why = ask_response()
    if data is None:
        return None, why
    path = os.path.join(directory, "%s.%s.md" % (data.get("style"), data.get("language")))
    if not os.path.isfile(path):
        return None, "no hay texto para el estilo «%s» en «%s»" % (data.get("style"), data.get("language"))
    return path, None

def fill_variant(body):
    """El tope de prosa en el texto del estilo: {{max_chars}} y {{max_lines}} (≈ cien caracteres por renglón)."""
    data = ask_response()[0]
    n = data["max_chars"]
    return body.replace("{{max_chars}}", str(n)).replace("{{max_lines}}", str((n + 50) // 100))

# Una fila de tabla que termina en `<!-- integration: <x> -->` se escribe sólo con esa integración prendida (story 2.31,
# AC 7-8); el marcador nunca se copia. No se pudo saber: la fila queda como estaba en el destino (si estaba, sigue).
ROW_RE = re.compile(r"^(.*\|)[ \t]*<!--\s*integration:\s*([a-z]+)\s*-->\s*$")

def filter_rows(body, existing):
    kept_lines = set(l.rstrip("\r") for l in existing.split("\n")) if existing else set()
    out = []
    for line in body.split("\n"):
        m = ROW_RE.match(line)
        if not m:
            out.append(line)
            continue
        row = m.group(1).rstrip()
        s, _ = integration_state(m.group(2))
        if s == "on" or (s == "unknown" and row in kept_lines):
            out.append(row)
    return "\n".join(out)

_profile = []  # el perfil de instalación, una sola vez: (perfil activo, None) o (None, por qué no se pudo saber)

def active_profile():
    """El perfil activo (`minimal` | `full`; sin valor es `full`, lo de siempre) o (None, motivo) si no se pudo saber."""
    if _profile:
        return _profile[0]
    value, why = None, None
    if not os.path.isfile(config_reader):
        why = "no encontré el lector de configuración (scripts/lib/tycon-config.js)"
    else:
        try:
            r = subprocess.run(["node", config_reader, "get", "install.profile"], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, timeout=10)
            out = r.stdout.decode("utf-8").strip()
            if r.returncode == 3:
                value = "full"
            elif r.returncode == 0 and out in PROFILES:
                value = out
            elif r.returncode == 2:
                why = "configuración rota: `node scripts/lib/tycon-config.js validate` dice qué"
            else:
                why = "el lector de configuración falló (exit %d)" % r.returncode
        except FileNotFoundError:
            why = "falta node en el PATH"
        except subprocess.TimeoutExpired:
            why = "el lector de configuración no contestó a tiempo"
        except (OSError, ValueError):
            why = "el lector de configuración contestó algo que no se entiende"
    _profile.append((value, why))
    return _profile[0]

def block_state(requires, profiles, bad):
    """('on' | 'off' | 'unknown', motivo de apagado o de no saber). Apagado por una de las dos razones alcanza."""
    if bad:
        return "unknown", None
    states = []
    if requires:
        s, why = integration_state(requires)
        states.append((s, "integración «%s» apagada" % requires if s == "off" else why, "integration"))
    if profiles:
        value, why = active_profile()
        if value is None:
            states.append(("unknown", why, "profile"))
        else:
            states.append(("on" if value in profiles else "off", "perfil «%s»" % value, "profile"))
    for s, why, kind in states:
        if s == "off":
            return "off", why
    for s, why, kind in states:
        if s == "unknown":
            return "unknown", (kind, why)
    return "on", None

# Bajo harness.js la copia del mecanismo (scripts/setup/harness/snapshot.js) ya tiene CLAUDE.md y AGENTS.md tal cual:
# un .bak más sería la pila sin tope que la 8.13 vino a cerrar. Suelto, el .bak de siempre.
snapshot = bool(os.environ.get("TYCON_HARNESS_SNAPSHOT_DIR"))
pieces_path = os.environ.get("TYCON_REPORT_PIECES") or ""

def record(kind, where, ident):
    """Anota una pieza para el reporte del aplicador (kind, ruta absoluta, id). Nunca rompe el sync."""
    if not pieces_path or check_only:
        return
    try:
        with open(pieces_path, "a", encoding="utf-8") as fh:
            fh.write("%s\t%s\t%s\n" % (kind, os.path.abspath(where), ident))
    except OSError:
        pass

# El plan del aplicador (story 8.16, tanda B · AC 11): con --check y TYCON_PLAN_PIECES (la deja `--plan-json`), cada
# bloque y el espejo de Codex con lo que el sync les haría: add · update · remove · keep. Nunca rompe el sync.
plan_path = os.environ.get("TYCON_PLAN_PIECES") or ""

def plan(kind, where, ident, action):
    if not plan_path or not check_only:
        return
    try:
        with open(plan_path, "a", encoding="utf-8") as fh:
            fh.write("%s\t%s\t%s\t%s\n" % (kind, os.path.abspath(where), ident, action))
    except OSError as e:
        # por stdout (el instalador descarta el stderr de este guion): harness.js lee esta línea y no muestra un plan
        # incompleto como si estuviera entero
        print("⚠ tycon: no pude anotar el bloque %s en el plan (%s)" % (ident, e))

# Los bloques de los paquetes que activa la organización: `packs/<p>/claude-md-blocks/<n>.md`, escritos como el bloque
# `packs/<p>/<n>`. Los lista `scripts/lib/pack-pieces.js blocks --json` (el mismo lector que el .ps1 y agents-md-blocks.js).
PACK_BLOCK_RE = re.compile(r"<!--\s*TYCON_BLOCK:(packs/[^/\s>]+/[^/\s>]+)\s+START")

def ask_pack_blocks():
    """({active, blocks}, None) o (None, por qué no se pudo saber qué paquetes activa la organización)."""
    if not os.path.isfile(packs_reader):
        return None, "no encontré el lector de paquetes (scripts/lib/pack-pieces.js)"
    try:
        r = subprocess.run(["node", packs_reader, "blocks", "--json", "--tree", os.path.dirname(os.path.abspath(blocks_dir))],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
        if r.returncode != 0:
            return None, "el lector de paquetes falló (exit %d)" % r.returncode
        data = json.loads(r.stdout.decode("utf-8"))
    except FileNotFoundError:
        return None, "falta node en el PATH"
    except subprocess.TimeoutExpired:
        return None, "el lector de paquetes no contestó a tiempo"
    except (OSError, ValueError):
        return None, "el lector de paquetes contestó algo que no se entiende"
    if not isinstance(data, dict) or not isinstance(data.get("blocks"), list):
        return None, "el lector de paquetes contestó algo que no se entiende"
    if data.get("active") is None:
        return None, data.get("error") or "no pude saber qué paquetes activa la organización"
    return data, None

def block_source(name):
    """El archivo del que sale el bloque, como lo nombra su marca."""
    m = re.match(r"^packs/([^/]+)/([^/]+)$", name)
    return "packs/%s/claude-md-blocks/%s.md" % (m.group(1), m.group(2)) if m else "claude-md-blocks/%s.md" % name

def marker_start(name):
    return ("<!-- TYCON_BLOCK:%s START — generado por scripts/setup/"
            "sync-claude-md-blocks.sh del arnés · NO EDITAR A MANO (se pisa en el próximo "
            "SessionStart); editá %s y commiteá -->" % (name, block_source(name)))

def marker_end(name):
    return "<!-- TYCON_BLOCK:%s END -->" % name

def atomic_write(path, content, original, label):
    """Backup (si había contenido) + escritura atómica. Devuelve el path del backup o None."""
    backup = None
    if original and not snapshot:
        ts = datetime.datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
        backup = "%s.bak.%s" % (path, ts)
        with open(backup, "w", encoding="utf-8") as fh:
            fh.write(original)
    elif not original:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    d = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".%s.tmp" % os.path.basename(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return backup

try:
    files = sorted(glob.glob(os.path.join(blocks_dir, "*.md")))
    # Cada bloque es un `.md` de la raíz (el contrato que leen el instalador, la desinstalación y sus pruebas). Uno que
    # declara `<!-- variants: response -->` (story 2.31) toma su texto de la carpeta del mismo nombre; una carpeta sola,
    # sin su archivo, no es un bloque. Orden por nombre, por código de carácter, en las tres implementaciones.
    entries = [(os.path.splitext(os.path.basename(p))[0], p, variants_of(p) is not None) for p in files]
    # y los de los paquetes activos, sólo si hay alguno escrito o algún paquete trae (sin paquetes, ni se pregunta… salvo
    # que el CLAUDE.md tenga un bloque de paquete, que hay que poder quitar)
    packs_data, packs_why = None, None
    try:
        with open(target, "r", encoding="utf-8") as fh:
            _peek = fh.read()
    except OSError:
        _peek = ""
    if PACK_BLOCK_RE.search(_peek) or glob.glob(os.path.join(os.path.dirname(os.path.abspath(blocks_dir)), "packs", "*", "claude-md-blocks", "*.md")):
        packs_data, packs_why = ask_pack_blocks()
        if packs_data:
            entries += [(b["name"], b["file"], False) for b in packs_data["blocks"]
                        if isinstance(b, dict) and isinstance(b.get("name"), str) and isinstance(b.get("file"), str)]
    entries = sorted(entries, key=lambda e: e[0])
    if not entries:
        sys.exit(0)

    try:
        with open(target, "r", encoding="utf-8") as fh:
            original = fh.read()
    except FileNotFoundError:
        original = ""
    except OSError:
        sys.exit(0)

    content = original
    changed = []
    removed = {}   # bloque → por qué se quita (la integración apagada, o el perfil que no lo trae)
    unknown = []   # avisos: bloques cuya integración o perfil no se pudo saber

    final = {}     # bloque → su texto entero entre marcadores, como debería quedar (para el reporte del aplicador)
    for name, path, is_variant in entries:
        start, end = marker_start(name), marker_end(name)
        # Localizar por PREFIJO del marcador, no por igualdad: así, si mañana cambia
        # el texto del comentario (ej. se agrega una aclaración), el bloque viejo se
        # encuentra igual y se reemplaza en vez de duplicarse.
        start_prefix = "<!-- TYCON_BLOCK:%s START" % name
        i = content.find(start_prefix)
        j0 = content.find(end, i) if i != -1 else -1
        existing_body = content[content.find("\n", i) + 1:j0] if j0 != -1 else ""

        # un bloque con variantes mira primero sus propias condiciones (perfil, integración), como cualquier otro; recién
        # prendido elige el texto. Apagado o sin saber, sigue por el camino común (y sin saber no se toca, abajo)
        if is_variant and block_state(*read_block(path)[1:])[0] == "on":
            vpath, vwhy = variant_file(os.path.join(blocks_dir, name))
            if vpath is None:
                # no se pudo elegir el texto (configuración rota, un estilo sin texto): no se inventa uno; lo que
                # había queda tal cual, sin actualizar (story 2.31, AC 6)
                unknown.append("⚠ tycon: bloque CLAUDE.md '%s': no pude saber cómo tiene que contestar el asistente (%s): %s"
                               % (name, vwhy, "no se agrega" if i == -1 else "queda como estaba"))
                if j0 != -1:
                    final[name] = content[i:j0 + len(end)]
                continue
            path = vpath

        body, requires, profiles, bad_marker = read_block(path)
        if is_variant and path.endswith(".md") and os.path.dirname(path) != blocks_dir:
            body = fill_variant(body)
        body = filter_rows(body, existing_body)
        state, why = block_state(requires, profiles, bad_marker)
        desired = "%s\n%s\n%s" % (start, body, end)
        final[name] = desired
        if state == "unknown":
            # No saber no es «apagada»: lo que falta no se agrega; lo que está queda y se actualiza abajo, como siempre.
            outcome = "no se agrega" if i == -1 else "queda donde está"
            if bad_marker and bad_marker[0] == "integration":
                unknown.append("⚠ tycon: bloque CLAUDE.md '%s': su marcador requires-integration está mal escrito (%s; va "
                               "en la primera línea, exacto: <!-- requires-integration: nombre -->): %s"
                               % (name, bad_marker[1], outcome))
            elif bad_marker:
                unknown.append("⚠ tycon: bloque CLAUDE.md '%s': su marcador requires-profile está mal escrito o repetido "
                               "(%s; va en las primeras líneas, una vez y exacto: <!-- requires-profile: full -->): %s"
                               % (name, bad_marker[1], outcome))
            elif why[0] == "profile":
                unknown.append("⚠ tycon: bloque CLAUDE.md '%s' requiere el perfil «%s» y no pude saber cuál tiene esta "
                               "máquina (%s): %s" % (name, ", ".join(profiles), why[1], outcome))
            else:
                unknown.append("⚠ tycon: bloque CLAUDE.md '%s' requiere la integración «%s» y no pude saber si está "
                               "prendida (%s): %s" % (name, requires, why[1], outcome))
            if is_variant:
                # sin saber sus condiciones no se elige texto: lo que había queda tal cual (su archivo sólo trae la marca)
                if j0 != -1:
                    final[name] = content[i:j0 + len(end)]
                continue
        if i == -1:
            if state != "on":
                continue
            content = content.rstrip("\n") + "\n\n" + desired + "\n"
            changed.append((name, "agregado"))
            continue

        j = content.find(end, i)
        if j == -1:
            # Marcador de cierre perdido (edición manual rota): no adivinamos dónde
            # termina — dejamos el archivo como está y avisamos.
            changed.append((name, "MARCADOR DE CIERRE FALTANTE — revisar a mano"))
            continue

        if state == "off":
            # Integración apagada con el bloque ya escrito: se va entre sus marcadores, con el renglón en blanco que el
            # agregado le puso delante (la regla de dropBlock en scripts/setup/harness/remove.js). Lo de antes y lo de
            # después quedan como si el bloque nunca hubiera estado.
            before, after = content[:i].rstrip("\n"), content[j + len(end):]
            if after.startswith("\n"):
                after = after[1:]
            content = before + "\n" + after if (before or after) else ""
            changed.append((name, "quitado (%s)" % why))
            removed[name] = why
            continue

        existing = content[i:j + len(end)]
        if existing == desired:
            continue
        content = content[:i] + desired + content[j + len(end):]
        changed.append((name, "actualizado"))

    # Un bloque de paquete escrito que ya no corresponde (el paquete dejó de estar activo, o ya no trae ese bloque) se va
    # entre sus marcadores, como uno con su integración apagada. Sin saber qué paquetes activa la organización, queda.
    names = set(e[0] for e in entries)
    for name in sorted(set(PACK_BLOCK_RE.findall(content)) - names):
        start_prefix, end = "<!-- TYCON_BLOCK:%s START" % name, marker_end(name)
        if packs_data is None:
            unknown.append("⚠ tycon: bloque CLAUDE.md '%s': no pude saber si su paquete está activo (%s): queda donde está"
                           % (name, packs_why))
            continue
        i = content.find(start_prefix)
        j = content.find(end, i)
        if j == -1:
            changed.append((name, "MARCADOR DE CIERRE FALTANTE — revisar a mano"))
            continue
        pack = name.split("/")[1]
        why = ("el paquete «%s» no está activo" % pack) if pack not in packs_data["active"] else ("el paquete «%s» ya no lo trae" % pack)
        before, after = content[:i].rstrip("\n"), content[j + len(end):]
        if after.startswith("\n"):
            after = after[1:]
        content = before + "\n" + after if (before or after) else ""
        changed.append((name, "quitado (%s)" % why))
        removed[name] = why

    real_changes = [c for c in changed if "FALTANTE" not in c[1]]

    for name, what in changed:
        if "FALTANTE" in what:
            print("⚠ tycon: bloque '%s' en %s: %s" % (name, target, what))
    for line in unknown:
        print(line)

    if real_changes and content != original:
        if check_only:
            for name, what in real_changes:
                if name in removed:
                    print("⚠ tycon: bloque CLAUDE.md '%s' sobra (%s) — corré "
                          "sync-claude-md-blocks.sh" % (name, removed[name]))
                    continue
                print("⚠ tycon: bloque CLAUDE.md '%s' desactualizado (%s) — corré "
                      "sync-claude-md-blocks.sh" % (name, what))
        else:
            try:
                backup = atomic_write(target, content, original, "CLAUDE.md")
            except OSError:
                sys.exit(0)
            for name, what in real_changes:
                print("✓ tycon: bloque CLAUDE.md '%s' %s" % (name, what))
            if backup:
                print("✓ tycon: backup en %s" % backup)

    # Los bloques que quedaron en su lugar (escritos ahora o que ya estaban), para el reporte del aplicador. Uno con el
    # marcador de cierre perdido no cuenta: no está en su lugar. Uno quitado por su integración apagada, tampoco.
    for name, _, _ in entries:
        whole = final.get(name)
        if whole is not None and whole in content:
            record("block", target, "TYCON_BLOCK:%s" % name)
            # por el PREFIJO de la marca, como se localiza el bloque (y como el .ps1): una marca de texto anterior es
            # el mismo bloque (story 8.19, tanda E: la marca cambió de texto)
            plan("block", target, "TYCON_BLOCK:%s" % name,
                 "keep" if whole in original else ("update" if ("<!-- TYCON_BLOCK:%s START" % name) in original else "add"))
        elif name in removed and ("<!-- TYCON_BLOCK:%s START" % name) in original:
            plan("block", target, "TYCON_BLOCK:%s" % name, "remove")
    for name in sorted(n for n in removed if n not in set(e[0] for e in entries)):
        plan("block", target, "TYCON_BLOCK:%s" % name, "remove")   # los de un paquete que ya no corresponde

except Exception:
    # Fail-open: este script jamás debe romper el arranque de una sesión.
    sys.exit(0)
PYEOF

# ============================================================
# Lado Codex: los bloques en ~/.codex/AGENTS.md, entre sus marcas (story 8.23, tanda C · AC 22).
#
# Hasta la tanda C esto era una COPIA ENTERA del CLAUDE.md, hecha acá adentro. Ahora AGENTS.md se arma desde los
# bloques, sin leer el CLAUDE.md, con `agents-md-blocks.js` (Node: el mismo en Mac, Linux y Windows): lo de la persona
# fuera de las marcas no se toca, y una máquina sin Claude Code recibe las reglas igual. Este guion sólo lo LLAMA
# cuando corre suelto y la máquina usa Codex (la señal de arriba: la variable, o un AGENTS.md que ya tiene bloques).
# Bajo el mecanismo (`TYCON_HARNESS_CODEX` puesta por harness.js) no lo llama: el enchufe de Codex ya lo hizo, o la
# máquina no enchufa a Codex.
# ============================================================
if [[ "$CODEX_ON" == "1" && -z "${TYCON_HARNESS_CODEX:-}" && -f "$SCRIPT_DIR/agents-md-blocks.js" ]] && command -v node >/dev/null 2>&1; then
  if [[ "$CHECK_ONLY" == "1" ]]; then
    CODEX_AGENTS_MD_PATH="$CODEX_TARGET" node "$SCRIPT_DIR/agents-md-blocks.js" --check || true
  else
    CODEX_AGENTS_MD_PATH="$CODEX_TARGET" node "$SCRIPT_DIR/agents-md-blocks.js" || true
  fi
fi

exit 0
