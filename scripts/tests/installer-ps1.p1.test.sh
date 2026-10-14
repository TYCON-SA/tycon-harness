#!/usr/bin/env bash
# Una parte de scripts/tests/installer-ps1.test.sh: corre el archivo entero dejando pasar sólo su bloque
# (scripts/tests/lib/suite-parts.sh). Para correr todo: bash scripts/tests/installer-ps1.test.sh
SUITE_PART=1/2 exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/installer-ps1.test.sh"
