# Los dos rosters de un pull request de un producto del equipo, como dato de prueba (story 7.13)

Son el `review-roster.json` y el `findings.json` REALES de las ejecuciones de las stories AG-2 y AG-3
(2026-09-20/21), el caso que frenó cinco stories sanas con `roster-incoherente` y del que cuatro
hallazgos eran del propio control.

Viven acá versionados para que `T8` no dependa de un checkout de Totora — una prueba que sólo
corre en la máquina donde está el otro repo es una prueba que no corre.

**Anonimizado** (nada de esto lo mira el cruce): `implementer.session_id`, `base_sha`, `tree_sha`,
y de cada hallazgo el `file` y el `reason`, que son de un cliente. Los nombres de los firmantes y
de los revisores se conservan enteros: son exactamente lo que el caso mide.
