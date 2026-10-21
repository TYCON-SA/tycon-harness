#!/usr/bin/env bash
# test-scope-guard.test.sh — el freno de pruebas sin alcance (scripts/hooks/test-scope-guard-pre.sh) frena el comando de
# pruebas que se corre de verdad, y no frena un texto que sólo se busca o se nombra entre comillas.
#
# Cada caso le pasa al freno la entrada de un PreToolUse de Bash, con una HOME vacía (lo que anota no toca la de quien
# corre) y mira su salida: 2 frena, 0 deja pasar.
#
# Correr: bash scripts/tests/test-scope-guard.test.sh

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
  printf '%s' "$entrada" | env -u TYCON_TEST_SCOPE_GUARD -u TYCON_FULL_SUITE HOME="$T" bash "$GUARD" >/dev/null 2>&1
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
  'echo "`cd x; npm test`"' \
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
  printf '%s' "$entrada" | env -u TYCON_TEST_SCOPE_GUARD -u TYCON_FULL_SUITE HOME="$T" PATH="$T/bin-perl-roto:$PATH" bash "$GUARD" >/dev/null 2>&1
  echo $?
}
[ "$(frena_con_perl_roto 'npm test')" = "2" ] && ok "con perl roto, el comando corrido sigue frenando" || mal "con perl roto dejó pasar «npm test»"

echo "test-scope-guard: $PASA ok, $FALLA mal"
[ "$FALLA" = "0" ]
