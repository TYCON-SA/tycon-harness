#!/usr/bin/env bash
# safety-guard-sign.test.sh — ESC-C3 de la biblioteca de firma: nombrarla para leerla pasa, correrla frena.
#
# El freno de seguridad le pregunta a marker-command.js `--sign-gate`. Si el lector no está, se cae o no contesta en 5 s,
# frena como siempre. El nombre de la biblioteca se arma por partes: escrito entero, este archivo no se podría ni mirar.
#
# Correr: bash scripts/tests/safety-guard-sign.test.sh
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD="$AQUI/scripts/hooks/safety-guard-pre.sh"
PIPELINE="$AQUI/skills/tycon-pipeline/scripts/pipeline.js"
LIB="harness""-sign"
RAIZ="$(mktemp -d)"
trap 'rm -rf "$RAIZ"' EXIT
mkdir -p "$RAIZ/home"
FALLAS=0

ok() { echo "✅ safety-guard-sign: $1"; }
no() { echo "❌ safety-guard-sign: $1"; FALLAS=$((FALLAS + 1)); }

# correr <guion> <casa del arnés> <comando>: deja la salida de error en ERR
correr() {
  local guion="$1" casa="$2" comando="$3"
  ERR="$(COMMAND="$comando" node -e 'process.stdout.write(JSON.stringify({ tool_name: "Bash", session_id: "s-firma", cwd: process.cwd(), tool_input: { command: process.env.COMMAND } }))' \
    | HOME="$RAIZ/home" TYCON_HOME="$casa" bash "$guion" 2>&1 >/dev/null)"
}

pasa() { correr "$GUARD" "$RAIZ/sin-casa" "$1"; case "$ERR" in *ESC-C3*) no "T15 SignGate_ReaderTable @story-8.308 @ac-15 · frenó lo que sólo lee: $1" ;; *) ok "lee: $1" ;; esac; }
frena() { correr "$GUARD" "$RAIZ/sin-casa" "$1"; case "$ERR" in *ESC-C3*) ok "frena: $1" ;; *) no "T15 SignGate_ReaderTable @story-8.308 @ac-15 · no frenó: $1 (dijo: ${ERR%%$'\n'*})" ;; esac; }

pasa "grep -n $LIB notas.txt"
pasa "echo ${LIB}atures"
pasa "cat $LIB.js | head -3"
pasa "ls scripts/lib/$LIB.js"
pasa "git log --oneline -- scripts/lib/$LIB.js"
pasa "node $PIPELINE smart-reloop --iter 2 --files a.js,scripts/lib/$LIB.js"

frena "node $LIB.js"
frena "./$LIB.js"
frena "cat $LIB.js | node"
frena "grep x $LIB.js > y"
frena "ls $LIB.js; node x"
frena "$LIB\$1"
frena "git diff --output $LIB.js"
frena "bash run-base-controls.sh approve $LIB"
frena "node -e \"require('./$LIB')\""
frena "node harness.js sign emergency x"
frena "cat \"$LIB.js"
# un `\r` lo frena antes otra regla, la de los comandos con caracteres de control
correr "$GUARD" "$RAIZ/sin-casa" "cat $LIB.js"$'\r'
case "$ERR" in *CMD-C1*|*ESC-C3*) ok "frena con un retorno de carro" ;; *) no "T15 SignGate_ReaderTable @story-8.308 @ac-15 · no frenó con un retorno de carro" ;; esac

# sin el lector: una copia del freno en un árbol que no trae la biblioteca
mkdir -p "$RAIZ/arbol/scripts"
cp -R "$AQUI/scripts/hooks" "$AQUI/scripts/lib" "$RAIZ/arbol/scripts/"
correr "$RAIZ/arbol/scripts/hooks/safety-guard-pre.sh" "$RAIZ/sin-casa" "cat $LIB.js"
case "$ERR" in *ESC-C3*) ok "sin el lector, frena" ;; *) no "T15 SignGate_ReaderTable @story-8.308 @ac-15 · sin el lector no frenó" ;; esac

# un intérprete de juguete que falla sólo al leer la firma: lo demás del freno sigue con el de verdad
NODE_REAL="$(command -v node)"
interprete() {
  mkdir -p "$RAIZ/$1/node/current/bin"
  printf '#!/bin/sh\ncase "$*" in *--sign-gate*) %s ;; esac\nexec "%s" "$@"\n' "$2" "$NODE_REAL" > "$RAIZ/$1/node/current/bin/node"
  chmod +x "$RAIZ/$1/node/current/bin/node"
}
interprete caido 'exit 1'
correr "$GUARD" "$RAIZ/caido" "cat $LIB.js"
case "$ERR" in *ESC-C3*) ok "con el lector caído, frena" ;; *) no "T15 SignGate_ReaderTable @story-8.308 @ac-15 · con el lector caído no frenó" ;; esac

# y uno que no contesta, con un nieto que se queda con la salida abierta
interprete lento 'sleep 30 & sleep 30'
INICIO=$SECONDS
correr "$GUARD" "$RAIZ/lento" "cat $LIB.js"
TARDO=$((SECONDS - INICIO))
case "$ERR" in *ESC-C3*) ok "con el lector lento, frena" ;; *) no "T15 SignGate_ReaderTable @story-8.308 @ac-15 · con el lector lento no frenó" ;; esac
if [ "$TARDO" -lt 15 ]; then ok "el lector lento se corta en ${TARDO} s"; else no "T15 SignGate_ReaderTable @story-8.308 @ac-15 · el lector lento tardó ${TARDO} s"; fi

# un `mktemp` que sin plantilla no puede crear, como en la corrida aislada de macOS: ahí la carpeta temporal del sistema
# no se escribe y $TMPDIR sí. Lo que sólo lee sigue pasando, porque el freno deja la respuesta del lector en $TMPDIR
mkdir -p "$RAIZ/sin-temporal-del-sistema" "$RAIZ/tmp"
printf '#!/bin/sh\n[ "$#" -eq 0 ] && exit 1\nexec "%s" "$@"\n' "$(command -v mktemp)" > "$RAIZ/sin-temporal-del-sistema/mktemp"
chmod +x "$RAIZ/sin-temporal-del-sistema/mktemp"
PATH="$RAIZ/sin-temporal-del-sistema:$PATH" TMPDIR="$RAIZ/tmp" correr "$GUARD" "$RAIZ/sin-casa" "grep -n $LIB notas.txt"
case "$ERR" in *ESC-C3*) no "sin la carpeta temporal del sistema, frenó lo que sólo lee" ;; *) ok "sin la carpeta temporal del sistema, lo que sólo lee pasa" ;; esac
PATH="$RAIZ/sin-temporal-del-sistema:$PATH" TMPDIR="$RAIZ/tmp" correr "$GUARD" "$RAIZ/sin-casa" "node $LIB.js"
case "$ERR" in *ESC-C3*) ok "sin la carpeta temporal del sistema, correrla frena" ;; *) no "sin la carpeta temporal del sistema, correrla no frenó" ;; esac
# y al revés: un $TMPDIR que ya no existe (lo borró la limpieza de temporales) no frena lo que sólo lee
TMPDIR="$RAIZ/no-existe" correr "$GUARD" "$RAIZ/sin-casa" "grep -n $LIB notas.txt"
case "$ERR" in *ESC-C3*) no "con un TMPDIR que no existe, frenó lo que sólo lee" ;; *) ok "con un TMPDIR que no existe, lo que sólo lee pasa" ;; esac
# sin ninguna de las dos, frena: lo que no se leyó no pasa
PATH="$RAIZ/sin-temporal-del-sistema:$PATH" TMPDIR="$RAIZ/no-existe" correr "$GUARD" "$RAIZ/sin-casa" "grep -n $LIB notas.txt"
case "$ERR" in *ESC-C3*) ok "sin ninguna carpeta temporal, frena" ;; *) no "sin ninguna carpeta temporal, no frenó" ;; esac

[ "$FALLAS" -eq 0 ] || { echo "❌ safety-guard-sign: $FALLAS falla(s)"; exit 1; }
echo "✅ safety-guard-sign: todo verde"
