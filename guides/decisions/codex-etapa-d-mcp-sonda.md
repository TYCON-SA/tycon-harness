# Propuesta — Etapa D: servidores MCP por advisor + 2 reglas del catálogo

**Fecha**: 2026-08-21 · **Plan**: [codex-migration.md](../codex-migration.md) · **Estado**: ✅ RESUELTO 2026-08-22 — los 6
puntos decididos por el dev y aplicados. Dos decisiones salieron DISTINTO de lo propuesto y hubo
dos hallazgos nuevos durante la aplicación: ver el addendum al pie.

---

## Parte 1 — La sonda de MCP: qué se probó y qué dio

Cuatro sondas contra Codex CLI 0.149.0. Cada una con **canario**: el resultado sólo se puede
saber llamando a la herramienta de verdad (el id y el título exacto de la memoria #3186), así que
un modelo que no la llamó no puede fingir que la llamó.

| # | Qué probó | Veredicto |
|---|---|---|
| A | ¿El archivo de perfil (`$CODEX_HOME/<name>.config.toml`) acepta declarar un servidor MCP? | 🟢 **Sí** — `mcp: engram/mem_search started` + canario correcto |
| B | ¿Declararlo por línea de comandos (`-c mcp_servers...`) funciona? | ⚪ **Inconcluso** — el modelo dijo "ninguna", pero la sonda no tenía canario, así que no prueba nada. No lo necesitamos |
| C | ¿El nombre de la herramienta lo fija la etiqueta que le ponemos al servidor? | 🟢 **Sí, y es el hallazgo de la tanda** — ver abajo |
| D | Sin declarar el servidor, ¿falla a los gritos o en silencio? | 🟡 **Ni una cosa ni la otra** — ver 1.8 |

### 🔑 El hallazgo: el problema de los nombres se disuelve, no se traduce

El inventario daba por hecho que los nombres de las herramientas **cambian** al no venir por
plugin, y que había que traducirlos en la prosa de cada advisor (categoría ②). La sonda C muestra
que **el nombre lo elegimos nosotros**:

| Cómo declaramos el servidor | Nombre que ve el modelo |
|---|---|
| `[mcp_servers.engram]` | `mcp__engram__mem_search` ← distinto de Claude |
| `[mcp_servers.plugin_engram_engram]` | `mcp__plugin_engram_engram__mem_search` ← **idéntico a Claude** |

O sea: si la etiqueta del servidor replica el identificador que usa Claude, **el nombre de la
herramienta sale byte por byte igual** y la prosa de los tres advisors no se toca. Cero
traducción, cero riesgo de que se desincronicen dos copias del mismo nombre.

**Propuesta 1.1** — que la etiqueta del servidor sea siempre la de Claude, y que eso viva en la
tabla de equivalencias (`build/equivalences.json`), no en cada advisor:

```json
"mcp_servers": {
  "__doc": "Servidor MCP → cómo lo lanza Codex. La CLAVE es la etiqueta de Claude a propósito: el nombre de la tool que ve el modelo es mcp__<etiqueta>__<tool>, así que replicando la etiqueta el nombre sale idéntico en las dos herramientas y la prosa del advisor no se traduce. Verificado con canario (sonda C, 2026-08-21).",
  "plugin_engram_engram": { "command": "engram", "args": ["mcp", "--tools=agent"] },
  "codegraph":            { "command": "<pendiente: ver 1.4>", "args": [] }
}
```

**Propuesta 1.2** — que `build/generate.js` emita `[mcp_servers.<etiqueta>]` en el `.toml` de cada
advisor, derivándolo de las tools `mcp__*` que ya declara el frontmatter del canónico. Hoy el
generador las ignora (sólo mira `tools:` para elegir el modo de sandbox), y por eso los tres
advisors quedaron trabados.

### Tres gotchas que costaron tiempo y hay que cablear

**1.3 — El orden del TOML no es cosmético.** Si `developer_instructions` queda DESPUÉS de un
`[mcp_servers.*]`, TOML lo mete adentro de esa tabla y el perfil no carga. El generador tiene que
emitir todas las claves sueltas ANTES de cualquier tabla. Lo bueno: `--strict-config` lo cazó al
instante y con el número de línea — es un freno que funciona, hay que seguir usándolo siempre.

**1.4 — `codegraph` no se puede declarar todavía, y `codebase-memory` no existe.**
`tycon-sibling-pattern-reviewer` declara seis herramientas de dos servidores: `codegraph` (que sí
está, pero por configuración de proyecto — falta ver con qué comando se lanza) y
**`codebase-memory`, que no está configurado en ninguna parte** (`claude mcp list` no lo muestra, y
tampoco aparece en la sesión). O sea: es un input muerto **también del lado Claude**, igual que los
dos que la etapa ya había destapado. Lo cita también `tycon-feature-wiring-checker`.
→ **Propuesta**: sacar las dos herramientas de `codebase-memory` del frontmatter de los dos
advisors, y anotarlo como hallazgo (no es de la migración, es deuda vieja que la migración
encontró).

**1.5 — Codex le regala al advisor ~160 herramientas que nadie pidió.** Con la función `apps`
prendida (viene así de fábrica), el modelo recibe `mcp__codex_apps__*`: crear y mergear pull
requests, borrar archivos de un repo, mandar y programar mails de Outlook, desinstalar apps, tocar
controles parentales. Un advisor de seguridad declarado **read-only** las tiene todas a mano. El
sandbox de disco no las frena: no pasan por el disco.
→ **Propuesta**: que cada perfil de advisor apague esa función (`features.apps = false`), y que el
banco tenga un caso que verifique que están apagadas. Es la asimetría más grande encontrada hasta
ahora entre las dos herramientas, y hoy no está declarada en ningún lado.

**1.6 — `codex mcp list` miente sobre los perfiles.** Sólo lee la configuración global: con el
servidor declarado y funcionando dentro de un perfil, sigue diciendo "no hay servidores
configurados". No usarlo como verificación; la verificación es el canario.

**1.7 — `codex exec` se cuelga para siempre si le queda la entrada abierta.** Sin `< /dev/null`
espera texto por entrada estándar y nunca arranca: 0% de CPU, cero salida, nueve minutos hasta que
lo corté. El banco actual no sufre esto (ya cierra la entrada), pero cualquier lugar nuevo que
llame a Codex tiene que cerrarla, y conviene que sea el generador quien lo documente en la
cabecera del `.toml`.

**1.8 — Cuando la herramienta falta, el advisor no se detiene: se la arregla por otro lado.**
Ésta es la sonda que más cambia lo que creíamos. El modelo **no inventó** el resultado —reportó
"FALLO" honestamente—, pero antes de rendirse **intentó reemplazar la herramienta faltante por un
comando de consola** (`engram search ... --project ...`) sin avisar que estaba cambiando de método.
En esta corrida el reemplazo fracasó, y fracasó **por el sandbox de sólo lectura**, no por
honestidad del modelo: la base de memoria necesitaba escribir para migrar y el sandbox lo impidió.

O sea que el riesgo real no es "el advisor inventa un dato". Es: **el advisor cambia de fuente de
información sin declararlo, y el reporte sale igual de convincente**. Un comando de consola no
consulta lo mismo que la herramienta ni respeta los mismos filtros, así que el veredicto puede
cambiar sin que nada se vea distinto.

Lo que lo tapó fue el sólo-lectura — y hay exactamente **un advisor que no corre en sólo lectura**:
`tycon-retrospective-capturer`, el único con permiso de escritura. Es justo donde esta sustitución
pasaría inadvertida.
→ **Propuesta**: el caso de banco de cada advisor con MCP no alcanza con verificar que la regla se
dispare; tiene que verificar **que la herramienta se llamó** (Codex lo imprime: `mcp: <etiqueta>/<tool> started`).
Un advisor que llega al veredicto correcto por un camino distinto está roto igual, y hoy ningún
caso lo notaría.

### Qué destraba esto

Los tres advisors trabados pasan a ser trabajo mecánico, **sin reescritura de prosa**: ya tienen
reglas con ID (7, 14 y 7). El único que queda con decisión de fondo es
`tycon-retrospective-capturer`.

---

## Parte 2 — Las dos reglas del catálogo

### 2.1 · MIGRATION-C5 — acepto la recomendación (b), "calibrada"

Que la regla frene sólo cuando la mezcla es **riesgosa** (el DDL es destructivo o el DML pierde
datos) y baje a aviso cuando todo el bloque es aditivo e idempotente. Es lo que el advisor ya hace;
lo que falta es que esté escrito. Toca dos lugares: la fila del catálogo
(`advisor-rules-catalog.md:474`) y la del advisor (`migration-impact-analyzer.md:39` + el paso 6 de
su procedimiento).

**Consecuencia que hay que aceptar de frente**: el caso del banco que hoy está en rojo pasa a
verde, pero **no porque lo arreglemos** — porque cambiamos la regla que ese caso mide. El fixture
ya fue endurecido a DDL destructivo, así que sigue midiendo algo real.

### 2.2 · VAL-W8 — acepto la recomendación (a), Owner = `tycon-story-validator`

Dueño único en el catálogo, y en `signed-scope-audit` queda como referencia cruzada explícita.

**Corrección al texto de la propuesta**: dice que "con VAL-W8 fuera, a `signed-scope-audit` le
queda una sola regla propia". Eso **ya no es cierto** — una reescritura posterior lo llevó de
1 regla a 10. El argumento sigue siendo válido como historia de por qué se reescribió, pero hay que
marcarlo como resuelto para que nadie lo lea como pendiente.

---

## Lo que pido aprobar

| # | Cambio | Toca |
|---|---|---|
| 1 | Etiqueta del servidor = la de Claude, declarada en la tabla de equivalencias | `build/equivalences.json` |
| 2 | El generador emite `[mcp_servers.*]` desde el frontmatter, con las claves sueltas primero | `build/generate.js` |
| 3 | Apagar la función `apps` en los perfiles de advisor + caso de banco que lo verifique | `build/generate.js`, banco |
| 4 | Sacar `codebase-memory` (servidor inexistente) de los dos advisors que lo citan | 2 advisors canónicos |
| 4b | Los casos de advisors con MCP verifican **que la herramienta se llamó**, no sólo el veredicto | banco (`advisor-runner.js`) |
| 5 | MIGRATION-C5 → redacción calibrada (b) | catálogo + advisor |
| 6 | VAL-W8 → Owner `tycon-story-validator` + referencia cruzada | catálogo + 1 advisor |

Los tres advisors trabados **no** entran en esta tanda: entran en la siguiente, cada uno con su red
previa y sus casos, una vez que 1-4 estén aplicados y verdes.


---

## ✅ Addendum de cierre (2026-08-22) — qué se decidió y qué cambió al aplicar

| # | Propuesto | Decidido por el dev | Estado |
|---|---|---|---|
| 1 | Etiqueta del server = la de Claude, en `equivalences.json` | Como se propuso | ✅ aplicado |
| 2 | `generate.js` emite `[mcp_servers.*]`, claves sueltas primero | Como se propuso (invariante cableado: `assertLooseKeysFirst`) | ✅ aplicado |
| — | codegraph (ruta por repo) | NO se declara — asimetría escrita en `equivalences.json` y en la cabecera de cada `.toml`; revisar en Etapa F | ✅ aplicado |
| 3 | Apagar `features.apps` + caso de banco | Como se propuso — `features.apps = false` en todos los perfiles; verificado por canario (APPS=NO en 4/4) | ✅ aplicado |
| 4 | **Sacar** `codebase-memory` de los 2 advisors | **AL REVÉS: instalarlo de verdad.** Estaba instalado (0.8.1) y sin registrar. Registrado en Claude user-scope + declarado en perfiles Codex | ✅ aplicado (distinto) |
| 4b | Los casos con MCP assertan que la tool se llamó | Como se propuso, con la variante elegida: **salteo con constancia** si el server no está en la máquina | ✅ aplicado (`expect_mcp` + `--selftest-mcp` 7/7) |
| 5 | MIGRATION-C5 calibrada, opción (b) | Como se propuso — catálogo + advisor. **La premisa "hay un caso en rojo que pasa a verde" estaba vieja**: los 3 casos ya estaban verdes en ambas herramientas antes del cambio (mismo patrón que el texto viejo de VAL-W8). En su lugar, la mitad nueva de la regla entró CON su caso: `mig-c5-aditivo-idempotente-degrada-warning` (la mezcla aditiva sin transacción debe seguir citando C5 — la calibración baja severidad, no silencia) | ✅ aplicado (distinto) |
| 6 | VAL-W8 → Owner `tycon-story-validator` | Como se propuso; el argumento "le queda 1 sola regla" marcado obsoleto (hoy tiene 10) | ✅ aplicado |

**Dos hallazgos nuevos al aplicar**: (a) Codex sanea `-` → `_` en la
etiqueta al armar el nombre de la tool → la etiqueta se renombró a `codebase_memory` en LOS DOS
lados y la regla quedó escrita: etiquetas sólo `[a-z0-9_]`; (b) el default de aprobación `auto`
decide por las anotaciones de la tool — sin anotaciones pide permiso y en headless eso DENIEGA:
el valor correcto es `approve`, emitido por el generador. Bonus: `enabled_tools` existe por
server — la lista blanca por-tool de MCP en Codex es real y el generador la emite.

**La corrección del 2.2 quedó absorbida**: el texto viejo ("queda 1 sola regla propia") ya no
gobierna nada — el Owner quedó fijado en la fila del catálogo de `VAL-W8` con fecha.
