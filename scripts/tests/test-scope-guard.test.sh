#!/usr/bin/env bash
# test-scope-guard.test.sh — el freno de pruebas sin alcance (scripts/hooks/test-scope-guard-pre.sh) frena el comando de
# pruebas que se corre de verdad, y no frena un texto que sólo se busca o se nombra entre comillas.
#
# Cada caso le pasa al freno la entrada de un PreToolUse de Bash, con una HOME vacía (lo que anota no toca la de quien
# corre) y mira su salida: 2 frena, 0 deja pasar.
#
# Correr: bash scripts/tests/test-scope-guard.test.sh, y /bin/bash scripts/tests/test-scope-guard.test.sh (el 3.2 de la
# Mac): el freno corre con el mismo bash que la suite.

set -u
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD="$RAIZ/scripts/hooks/test-scope-guard-pre.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
PASA=0; FALLA=0
ok() { echo "  ok   — $1"; PASA=$((PASA + 1)); }
mal() { echo "  MAL  — $1"; FALLA=$((FALLA + 1)); }

# el freno con un comando: imprime su código de salida
frena() {
  local entrada
  entrada="$(node -e 'process.stdout.write(JSON.stringify({ tool_name: "Bash", tool_input: { command: process.argv[1] }, cwd: process.argv[2] }))' "$1" "$T")"
  printf '%s' "$entrada" | env -u TYCON_TEST_SCOPE_GUARD -u TYCON_FULL_SUITE HOME="$T" "$BASH" "$GUARD" >/dev/null 2>&1
  echo $?
}

# Guard_GrepForCommandText_Passes @story-7.51 @ac-12 — un texto entre comillas no es un comando corrido
# stable-data: no crea commits ni lee el reloj; el `git commit -m …` de un caso es un texto que se le pasa al freno
for cmd in \
  'grep -n -E "test-runners.js|resolve|dotnet test|\.sln" test-gate.sh' \
  "rg 'npm test' scripts/" \
  'grep -c "dotnet test" a.sh; echo listo' \
  "echo 'para correr: npm test'" \
  "$(printf 'git commit -m "arreglo\nnpm test corre igual"')"; do
  [ "$(frena "$cmd")" = "0" ] && ok "deja pasar: $cmd" || mal "frenó un texto entre comillas: $cmd"
done

# el comando corrido de verdad sigue frenando, también encadenado o al lado de un texto con comillas
for cmd in \
  'dotnet test' \
  'npm test' \
  'cd x && dotnet test' \
  'grep -c "x|y" a.sh; npm test' \
  'echo "listo" | dotnet test' \
  "echo it\\'s; npm test; echo 'x'" \
  'echo "a \"b|c\" d"; dotnet test' \
  'bash -c "cd x; dotnet test"' \
  "sh -c 'echo; npm test'" \
  'eval "true; npm test"' \
  'ssh build "cd app; dotnet test"' \
  'pwsh -Command "cd app; dotnet test"' \
  "echo \$'it\\'s'; npm test" \
  'echo "$(cd x; dotnet test)"' \
  "$(printf 'echo "\140cd x; npm test\140"')" \
  "$(printf "echo hola # don't\ndotnet test")" \
  'echo $(dotnet test)' \
  'x=$(dotnet test) && echo ok' \
  'echo `dotnet test`' \
  'bash -c "dotnet test"' \
  "eval 'npm test'" \
  "$(printf 'cat <<EOF\nit'"'"'s\nEOF\nnpm test')" \
  "$(printf 'echo a \\\\\\\\\ndotnet test')" \
  "$(printf '# nota \\\\\ndotnet test')"; do
  [ "$(frena "$cmd")" = "2" ] && ok "frena: $cmd" || mal "dejó pasar el comando de pruebas corrido: $cmd"
done

# con alcance, pasa (lo de siempre)
for cmd in 'dotnet test --filter "FullyQualifiedName~Foo"' 'npm test -- Foo' 'dotnet test "tests/Foo.Tests/Foo.Tests.csproj"' \
  'bash -c "dotnet test --filter FullyQualifiedName~Foo"' 'x=$(npm test -- Foo)'; do
  [ "$(frena "$cmd")" = "0" ] && ok "con alcance pasa: $cmd" || mal "frenó un comando con alcance: $cmd"
done

# sin un perl que funcione, el comando se corta como antes: frena de más, nunca de menos
mkdir -p "$T/bin-perl-roto"
printf '#!/bin/sh\nexit 1\n' > "$T/bin-perl-roto/perl"; chmod +x "$T/bin-perl-roto/perl"
frena_con_perl_roto() {
  local entrada
  entrada="$(node -e 'process.stdout.write(JSON.stringify({ tool_name: "Bash", tool_input: { command: process.argv[1] }, cwd: process.argv[2] }))' "$1" "$T")"
  printf '%s' "$entrada" | env -u TYCON_TEST_SCOPE_GUARD -u TYCON_FULL_SUITE HOME="$T" PATH="$T/bin-perl-roto:$PATH" "$BASH" "$GUARD" >/dev/null 2>&1
  echo $?
}
[ "$(frena_con_perl_roto 'npm test')" = "2" ] && ok "con perl roto, el comando corrido sigue frenando" || mal "con perl roto dejó pasar «npm test»"

# Guard_MeasuredCases_AllAsExpected @story-7.52 @ac-1 @ac-2 @ac-3 @ac-4 @ac-5 @ac-6 @ac-7 — la tabla de casos medidos, cada
# uno con lo que tiene que dar. Corre con el bash que corre esta suite: `bash` y `/bin/bash` (el 3.2 de la Mac) dan las dos
# pasadas. Guard_751Passes_StillPass @story-7.52 @ac-6 — de esos, los que pasaban en la 7.51 siguen pasando.
CASOS="$RAIZ/scripts/tests/fixtures/test-scope-guard-cases.json"
mkdir -p "$T/casos"
node -e '
  const fs = require("fs"), path = require("path");
  const { casos } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const lista = [];
  casos.forEach((c, i) => {
    fs.writeFileSync(path.join(process.argv[2], i + ".json"),
      JSON.stringify({ tool_name: c.herramienta || "Bash", tool_input: { command: c.cmd }, cwd: process.argv[2] }));
    lista.push([i, c.espera === "frena" ? 2 : 0, c.grupo, JSON.stringify(c.cmd)].join("\t"));
  });
  fs.writeFileSync(path.join(process.argv[2], "lista.tsv"), lista.join("\n") + "\n");
' "$CASOS" "$T/casos"
MAL_T1=0; MAL_T2=0; N_T1=0; N_T2=0
while IFS="$(printf '\t')" read -r i espera grupo cmd; do
  N_T1=$((N_T1 + 1))
  env -u TYCON_TEST_SCOPE_GUARD -u TYCON_FULL_SUITE HOME="$T" "$BASH" "$GUARD" < "$T/casos/$i.json" >/dev/null 2>&1
  dio=$?
  if [ "$grupo" = "pasan-7.51" ] && [ "$espera" = "0" ]; then N_T2=$((N_T2 + 1)); fi
  if [ "$dio" != "$espera" ]; then
    MAL_T1=$((MAL_T1 + 1))
    [ "$grupo" = "pasan-7.51" ] && [ "$espera" = "0" ] && MAL_T2=$((MAL_T2 + 1))
    echo "    esperaba $espera y dio $dio: $cmd"
  fi
done < "$T/casos/lista.tsv"
# el mínimo sigue a la tabla (los 452 del probador, los de los revisores y los que confirmó el pase adversarial): una
# tabla que se achica en silencio deja formas sin probar
[ "$N_T1" -ge 550 ] && [ "$MAL_T1" = "0" ] && ok "T1 los $N_T1 casos medidos dan lo esperado ($BASH_VERSION)" \
  || mal "T1 $MAL_T1 de $N_T1 casos medidos no dan lo esperado ($BASH_VERSION)"
[ "$N_T2" -gt 50 ] && [ "$MAL_T2" = "0" ] && ok "T2 los $N_T2 que pasaban en la 7.51 siguen pasando" \
  || mal "T2 $MAL_T2 de $N_T2 que pasaban en la 7.51 ahora frenan"

# Guard_ReaderBroken_FallsBackToSimpleCut @story-7.52 @ac-3 — con el lector de Node roto (un `node` que sale 1), el freno
# no deja pasar en silencio: con `jq` lee la entrada y corta como antes (frena), sin `jq` dice que no pudo leer (sale 1)
mkdir -p "$T/bin-node-roto"
printf '#!/bin/sh\nexit 1\n' > "$T/bin-node-roto/node"; chmod +x "$T/bin-node-roto/node"
entrada="$(node -e 'process.stdout.write(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm test" }, cwd: "/tmp" }))')"
dio="$(printf '%s' "$entrada" | env -u TYCON_TEST_SCOPE_GUARD -u TYCON_FULL_SUITE HOME="$T" TYCON_HARNESS_NODE=0 \
  PATH="$T/bin-node-roto:$PATH" "$BASH" "$GUARD" >/dev/null 2>&1; echo $?)"
if command -v jq >/dev/null 2>&1; then esperado=2; else esperado=1; fi
[ "$dio" = "$esperado" ] && ok "con el lector roto, «npm test» sale $esperado (corte de antes o «no pude leer»)" \
  || mal "con el lector roto, «npm test» salió $dio y se esperaba $esperado"

# Guard_Record_VerdictPerCommand @story-7.52 @ac-6 — cada decisión deja su constancia: frenar, pasar acotado, usar el
# escape; un comando sin herramienta de pruebas no deja nada
CASA="$T/casa-constancia"; mkdir -p "$CASA"
for cmd in 'npm test' 'npm test -- Foo' 'TYCON_FULL_SUITE=1 npm test' 'git status'; do
  printf '%s' "$(node -e 'process.stdout.write(JSON.stringify({ tool_name: "Bash", tool_input: { command: process.argv[1] }, cwd: "/tmp" }))' "$cmd")" \
    | env -u TYCON_TEST_SCOPE_GUARD -u TYCON_FULL_SUITE HOME="$CASA" "$BASH" "$GUARD" >/dev/null 2>&1
done
veredictos="$(grep -o '"veredicto":"[a-z]*"' "$CASA/.claude/.tycon-pipeline/frenos.jsonl" 2>/dev/null | tr '\n' ' ')"
[ "$veredictos" = '"veredicto":"bloqueo" "veredicto":"paso" "veredicto":"escape" ' ] && ok "la constancia: bloqueo, paso y escape, en orden" \
  || mal "la constancia dio: [$veredictos]"

echo "test-scope-guard: $PASA ok, $FALLA mal"
[ "$FALLA" = "0" ]
