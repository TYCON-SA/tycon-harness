#!/usr/bin/env bash
# Una parte de scripts/tests/githook-livefire.test.sh: corre el archivo entero dejando pasar sólo su bloque
# (scripts/tests/lib/suite-parts.sh). Para correr todo: bash scripts/tests/githook-livefire.test.sh
SUITE_PART=2/2 exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/githook-livefire.test.sh"
