#!/usr/bin/env bash
# Una parte de scripts/tests/release-api-count.test.sh: corre el archivo entero dejando pasar sólo su bloque
# (scripts/tests/lib/suite-parts.sh). Para correr todo: bash scripts/tests/release-api-count.test.sh
SUITE_PART=2/2 exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-api-count.test.sh"
