#!/usr/bin/env bash
# hooks-messages-dont-run.test.sh — que el TEXTO de un mensaje no EJECUTE nada (2026-09-06).
#
# EL DEFECTO. En `scripts/hooks/engram-pre-commit.sh` el consejo de recuperación nombraba el
# comando entre backticks… adentro de un `echo` con comillas DOBLES. Para bash eso no es formato:
# es **sustitución de comando**. Entonces, cada vez que se disparaba la guarda del manifest, el
# hook CORRÍA `engram sync` —justo sobre un repo cuyo índice de memoria está roto— y además le
# BORRABA el nombre del comando al consejo: el dev terminaba leyendo "🔴 NO borres el manifest:
# no lo reconstruye", sin el comando del que habla. Dos daños de un solo par de comillas, y
# ninguno da error.
#
# Reproducido con un `engram` falso primero en el PATH que registra cada invocación: 2 llamadas
# donde debía haber 1. Peor: la del backtick corre SIN `--project`, así que engram deriva el
# proyecto del basename de la carpeta — la misma familia que ENGRAM-PROJECT-NAME-DRIFT-1, que
# este arnés ya persigue por otro lado.
#
# 🔴 DOS CAPAS, y la primera es la que impide el gemelo:
#   C-01 barre TODOS los .sh del repo. Un caso atado a cuatro números de línea no habría visto
#        el mismo defecto en el archivo de al lado. Medido al escribirlo: 4 ocurrencias, las 4 en
#        engram-pre-commit.sh; `ensure-sqlite3.sh` y la línea 131 del propio hook ya escapaban bien.
#   C-02/C-03 prueban la EJECUCIÓN y el TEXTO, no la sintaxis: un mensaje puede quedar bien
#        escrito y seguir corriendo algo, y un backtick escapado puede seguir comiéndose la palabra.
#
# Sin red.

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$RAIZ/scripts/hooks/engram-pre-commit.sh"
source "$RAIZ/scripts/tests/lib/fake-home.sh"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

# ── C-01 · ningún echo con comillas dobles trae un backtick sin escapar, en todo el repo ──────
# 🔴 rojo previo: desescapar cualquiera de los backticks de engram-pre-commit.sh.
SALIDA=$(python3 - "$RAIZ" <<'PY'
import re, os, sys
raiz = sys.argv[1]
hits = []
for dp, dn, fn in os.walk(raiz):
    # 🔴 Sólo lo que git LLEVA: `scratchpad/` (ignorado) tiene copias enteras del repo que dejan
    # los sandboxes de las revisiones adversariales, y la suite las leía como código del arnés —
    # cuatro falsos positivos el 2026-09-06, con el repo real impecable. Un control que se pone
    # rojo por basura de otro proceso se termina apagando.
    if any(x in dp for x in (f'{os.sep}.git', 'node_modules', f'{os.sep}scratchpad', f'{os.sep}.bench', f'{os.sep}artifacts')): continue
    for f in fn:
        if not f.endswith(('.sh', '.bash')): continue
        p = os.path.join(dp, f)
        try: lineas = open(p, encoding='utf8', errors='replace').read().split('\n')
        except OSError: continue
        for i, l in enumerate(lineas, 1):
            m = re.search(r'echo\s+(-[a-zA-Z]+\s+)?"([^"]*)"', l)
            if not m: continue
            if re.search(r'(?<!\\)`', m.group(2)):
                hits.append(f"{os.path.relpath(p, raiz)}:{i}")
print(len(hits))
for h in hits: print("   ", h)
PY
)
N=$(echo "$SALIDA" | head -1)
if [ "$N" = "0" ]; then
  ok "C-01 ningún mensaje del repo ejecuta lo que nombra (0 backticks sin escapar en echo \"…\")"
else
  mal "C-01 hay $N mensaje(s) que EJECUTAN el comando que nombran en vez de mostrarlo:"
  echo "$SALIDA" | tail -n +2
fi

# ── Banco para C-02/C-03: repo de juguete con el manifest roto y un `engram` falso en el PATH ──
montar() {
  local T="$1"
  mkdir -p "$T/bin" "$T/repo/.engram"
  # el engram falso registra sus argumentos y no hace nada
  printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s/llamadas.txt"\nexit 0\n' "$T" > "$T/bin/engram"
  chmod +x "$T/bin/engram"
  git init -q -b main "$T/repo"
  echo 'proyecto-de-prueba' > "$T/repo/.engram-project"
  # manifest CON marcadores de conflicto → dispara la guarda que imprime el consejo
  printf '<<<<<<< HEAD\n{"a":1}\n=======\n{"a":2}\n>>>>>>> otra\n' > "$T/repo/.engram/manifest.json"
  ( cd "$T/repo" && git add -A && git -c user.email=b@b -c user.name=b commit -q -m base ) >/dev/null 2>&1
}

correr_hook() {
  local T="$1"
  # HOME de la prueba: la arma fake_home_create antes de montar (story 7.16); la constancia del freno
  # no va al frenos.jsonl real del dev.
  # 🔴 La prueba declara lo que necesita: la integración de engram PRENDIDA (TYCON_ENGRAM_HOOK=1, el interruptor del
  # propio hook). Antes la daba por prendida: en la copia pública nace apagada (el perfil del equipo no viaja), el hook
  # salía sin hacer nada y C-02, C-03 y C-05 daban rojo ahí (medido el 2026-10-09 en la validación desde GitHub).
  ( cd "$T/repo" && PATH="$T/bin:$PATH" ENGRAM_BIN="$T/bin/engram" TYCON_ENGRAM_HOOK=1 \
      bash "$HOOK" <<< '{"tool_input":{"command":"git commit -m prueba"}}' ) > "$T/salida.txt" 2>&1
  echo $?
}

# ── C-02 · el mensaje no dispara una invocación de más ────────────────────────────────────────
# 🔴 rojo previo: desescapar el backtick de la línea del consejo → 2 llamadas en vez de 1.
T=$(mktemp -d); fake_home_create "$T/casa" || exit 1; montar "$T"
RC=$(correr_hook "$T")
LLAMADAS=$(wc -l < "$T/llamadas.txt" 2>/dev/null | tr -d ' '); LLAMADAS=${LLAMADAS:-0}
SIN_PROJECT=$(grep -c -- '--project' "$T/llamadas.txt" 2>/dev/null || echo 0)
if [ "$LLAMADAS" = "1" ] && [ "$SIN_PROJECT" = "1" ]; then
  ok "C-02 una sola invocación de engram, y con --project (el hook, no el mensaje)"
else
  mal "C-02 engram se invocó $LLAMADAS vez/veces ($SIN_PROJECT con --project) — el texto del mensaje está ejecutando"
  sed 's/^/       llamada: /' "$T/llamadas.txt" 2>/dev/null
fi

# ── C-03 · el consejo conserva el comando del que habla ───────────────────────────────────────
# El otro daño del mismo defecto, y el que sufre el dev: la sustitución se come la palabra y el
# consejo de recuperación queda con un hueco justo donde iba lo que hay que tipear.
if grep -q 'engram sync' "$T/salida.txt"; then
  ok "C-03 el consejo nombra el comando (no se lo comió la sustitución)"
else
  mal "C-03 el consejo perdió el nombre del comando — el dev lee un consejo sin el comando"
  grep -iE 'manifest|reconstruye' "$T/salida.txt" | head -2 | sed 's/^/       /'
fi
[ "$RC" = "0" ] && ok "C-04 el hook sigue siendo fail-open (exit 0)" || mal "C-04 el hook frenó (exit $RC) — era fail-open"
# ── C-05 · T22 (story 7.15) la constancia del manifest roto va a la HOME de la prueba ─────────────
# El hook deja «no pude medir» en frenos.jsonl, que sube al buzón y alimenta el tablero: en la HOME real
# era una constancia falsa por corrida. Evidencia POSITIVA. Rojo previo: sin HOME temporal, no está acá.
if [ "$(fake_home_count frenos.jsonl '"freno":"engram-manifest"')" -gt 0 ]; then
  ok "C-05 la constancia engram-manifest quedó en la HOME de la prueba, no en la real"
else
  mal "C-05 🔴 la constancia engram-manifest no está en la HOME de la prueba: fue al frenos.jsonl real del dev"
fi
rm -rf "$T"

echo
if [ "$FALLOS" -gt 0 ]; then echo "FALLARON $FALLOS chequeo(s)"; exit 1; fi
echo "todo verde"
exit 0
