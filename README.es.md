# Arnés TYCON para Claude Code y Codex

[English](README.md) · Castellano

**Un ciclo de desarrollo con IA (AI SDLC), de la spec a producción y después**, para Claude Code y Codex.

1. **Spec:** con el agente escribís la story del cambio: qué hay que hacer y cómo se prueba. Para un ajuste chico
   alcanza con pedirlo con tus palabras.
2. **Código:** el agente arma el plan, espera tu visto bueno y escribe el código y las pruebas.
3. **Revisión:** revisores especializados (seguridad, convenciones, cobertura) miran el cambio antes del commit.
4. **Entrega:** el commit y el merge pasan por controles. Para plugins de BIZUIT trae los guiones que despliegan a
   pruebas y a producción.
5. **Después:** cada merge a main deja su archivo de métricas. El tablero del ciclo y los procesos de cada noche
   (dependencias vulnerables, poda de reglas) hoy corren sólo en TYCON y se están publicando.

**Se vigila a sí mismo.** Un banco de pruebas comprueba, en cada cambio al arnés, que cada control siga frenando lo que
dice. Si lo prendés, además observa tus sesiones y propone reglas nuevas, que vos aprobás.

Con el perfil completo, los controles frenan, no sólo avisan: no depende de que el modelo se acuerde de las reglas. La
mayoría nació de un incidente real.

**Cada organización pone lo suyo.** Sus revisores, sus skills y su configuración viajan en el perfil de su equipo.
TYCON trae los suyos para plugins de BIZUIT.

## Antes de instalar: qué cambia en tu máquina

Si instalás con Claude, como dice más abajo, queda el perfil completo (`full`); el comando a mano te pregunta cuál
querés. El completo cambia cosas en todos tus proyectos, no sólo en uno:

- Claude te contesta en castellano, corto y con la conclusión primero.
- En un repo que trabaja con stories, Claude no edita código sin pasar por el proceso de stories del arnés.
- Git pasa a usar una carpeta global para sus controles al commitear (`core.hooksPath`). Desde ahí, git deja de correr
  los controles propios de cada repo, los de `.git/hooks/`. La instalación la configura sólo si git no tiene ninguna, y
  el plan te lo dice antes de tu «sí»; si ya tenés otra, no la toca.
- Una vez por día lee el historial de git de tus repos de proyectos (encuentra su carpeta por dónde usás Claude Code). Lo que anota queda en tu máquina.
- Claude Code guarda tus conversaciones un año.

Si no querés esto, pedí el perfil mínimo (`minimal`). Trae las guías, los revisores y el proceso de stories. No cambia
cómo te contesta Claude ni toca git. Deja un solo freno: el de comandos destructivos.
Para sacar el arnés, `harness.js uninstall --dry-run` muestra qué quitaría, y `harness.js uninstall --yes` lo quita.

## Qué necesitás

- Node 24 y `tar` (para correr la línea de instalación alcanza con Node 22 o posterior). En Mac, además, Python 3.
- Windows 11 con PowerShell 7, Mac o Linux. En WSL no se probó.
- Claude Code (o Codex), instalado y con tu sesión iniciada: es donde se usa el arnés.
- Git **no** hace falta para usar el arnés: se baja como archivos, no se clona.
  Tampoco hace falta una cuenta de GitHub: este repo es público.
- Tu Node hace falta para instalar. Después el arnés baja su propio Node 24 (unos 50 MB, de nodejs.org) y sus hooks
  corren con él; tus proyectos siguen con tu Node, que no se toca. Se apaga con `TYCON_HARNESS_NODE=0`.
- Para programar extensiones de BIZUIT, el SDK de .NET de tu plugin. Sin él, la implementación frena al compilar.

Si te falta algo, el instalador te dice qué y no instala nada.

## Instalar en una línea

Esta línea revisa los requisitos, baja la versión publicada del arnés y lo instala; es la misma en Windows, en Mac y en
Linux, y es el camino estándar: no hace falta Claude. Abrí la terminal (en Windows, PowerShell 7) y escribí:

```bash
npx @tyconsa/harness@latest
```

Contestá sus preguntas: para quién es la instalación (`1`, para vos), el perfil (`full` o `minimal`), las
integraciones (Enter, ninguna) y si usás el paquete del stack (`s`). Antes de escribir nada te muestra el plan de lo que
va a cambiar en tu máquina y pregunta «¿Instalo? [s/N]»: con un «no», no queda nada.

A mano, sin npm: las tres líneas que bajan el guion de instalación, lo muestran y lo corren están en la
[Referencia](getting-started/reference.es.md), en «Bajar e instalar».

## Instalar con Claude Code

Es la alternativa más fácil, si preferís que te guíen, y lleva unos 10 minutos. Claude corre casi todos los comandos; la
instalación corre en tu propia terminal.

1. Abrí las instrucciones de tu sistema: [Windows](getting-started/windows.md), [Mac](getting-started/mac.md) o [Linux](getting-started/linux.md).
2. Copiá el bloque entero de la «Parte 1». Abrí Claude Code en cualquier carpeta y pegalo en una conversación nueva.
3. Claude te da la línea npx para tu propia terminal: la corrés vos, así ves el plan antes de contestar. Nada te pide
   iniciar sesión: el arnés nunca abre un navegador.
4. Claude te muestra el plan de instalación y espera tu «sí». El plan dice si va a configurar `core.hooksPath`.
5. Al final te arma un resumen que termina en «OK» o «NO OK». Cerrá Claude Code y abrilo de nuevo.

Si en el camino instalás una herramienta, Claude te pide cerrar y abrir la terminal y Claude Code. Si el resumen dice
«NO OK», guardalo: es lo que hay que mostrar al pedir ayuda.

El arnés queda en `~/.tycon/harness`, como archivos bajados (sin git). `~/.claude/tycon-harness` es un acceso directo a
esa misma carpeta, y es el que usan los comandos de esta página. No borres ni muevas esa carpeta: Claude Code lo
usa desde ahí, y se actualiza solo en ese lugar. Usar el arnés nunca necesita un clon de este repo.

**Perfil mínimo.** Al pegar el bloque, escribí arriba «quiero el perfil mínimo». Claude instala `minimal` y no toca
`core.hooksPath`.

## Empezar a trabajar

1. Cerrá Claude Code y abrilo de nuevo en la carpeta del repo de tu extensión: las reglas entran al abrirlo.
2. Pedí una story: «creá una story con `tycon-create-story` para agregar un filtro por fecha». Leela y ajustala.
3. Pedí «implementemos la story» con la ruta del archivo. Esa frase va en castellano.
4. La primera vez, Claude Code te pide permiso para leer la carpeta del arnés. Se acepta una vez.
5. Claude te muestra el plan, espera tu visto bueno, programa y corre las pruebas y los revisores.
6. Deja el commit preparado: nunca commitea ni sube cambios sin tu permiso.

Si algo no anda, escribí `/tycon-harness` en Claude Code (qué versión tenés, si está bien instalado y si hay una nueva), o corré `node ~/.claude/tycon-harness/scripts/setup/harness.js doctor`, que dice qué falta. Ninguno de los dos toca nada.

## Para una organización

**Primero probalo solo.** Instalalo en tu máquina como dice arriba: no hace falta nada de tu organización. Si te sirve,
se arma para el equipo con dos repos de la organización, que sólo ve tu equipo, además de éste, que es el mismo para
todos:

| Repo | Qué guarda | ¿Llega a cada máquina? |
|---|---|---|
| Éste (público) | el arnés | Sí |
| El **perfil del equipo** (por ejemplo `harness-team-profile`) | la configuración que comparte el equipo y la lista de dónde vive cada repo de la organización (`team-repos.json`) | Sí, a cada máquina que instala con `--team` |
| Las **operaciones del equipo** (por ejemplo `harness-team-operations`) | lo que corre de noche para la organización (dependencias, tablero, retrospectivas) y a quién se le asignan sus avisos (`operations.json`) | No: lo leen sólo esos procesos |

Un ejemplo: en ACME, Pedro administra y Juan programa.

1. Pedro da de alta ACME con `npx @tyconsa/harness@latest --audience org` (o contesta `3` a «¿para quién es esta
   instalación?»). La línea instala su máquina y sigue con `harness.js team-init`: pregunta el nombre, la plataforma y
   la dirección del repo del perfil, arma sus tres archivos (`team-layer.json`, `team-profile.json` y `team-repos.json`)
   a partir de [un perfil de ejemplo](https://github.com/TYCON-SA/harness-team-profile-example) y los valida antes de
   escribir. No crea repos ni pide credenciales: le dice dónde crear el repo vacío, con acceso sólo para el equipo, y
   si dice que sí lo sube con su git. Con el arnés ya instalado, lo mismo es
   `node ~/.tycon/harness/scripts/setup/harness.js team-init`. El repo de operaciones se crea aparte (abajo, «Los
   procesos de la noche»).
2. Todo lo que se personaliza —dónde vive cada repo, a quién se le asignan los avisos, los umbrales— se configura desde
   la pestaña **Configuración** del [sitio de la organización](guides/organization-site.md) (sólo para los que mantienen): valida con los
   mismos lectores del arnés y propone cada cambio con un pull request, nunca escribe `main`. Mientras ACME no tiene su
   sitio desplegado, se edita con un pull request al repo de operaciones. La página local
   (`node ~/.tycon/harness/scripts/setup/harness.js team-config`) muestra, de sólo lectura y sin nada en internet, lo que
   hay en sus clones y los problemas que ven los lectores; no guarda ni propone nada.
3. Juan instala con npx y el perfil: `npx @tyconsa/harness@latest --team acme/harness-team-profile` si está en GitHub,
   o `npx @tyconsa/harness@latest --team https://dev.azure.com/acme/<proyecto>/_git/harness-team-profile` si está en
   Azure DevOps. Como ese repo lo ve sólo el equipo, antes de bajar nada la línea mira si lo puede leer y, si no, le
   pide el permiso de lectura. Desde ahí, cada actualización le trae también lo del equipo.

Cómo se extiende el arnés para tu organización —las capas, la página de configuración y un recorrido de ejemplo— en un
[mapa interactivo](https://www.bizuit.com/sdd-harness/more/mapa-del-arnes.html).

**Los procesos de la noche.** En Azure DevOps, la revisión de dependencias, las métricas del ciclo y el tablero corren en
tu organización con tres pipelines modelo y tu repo de operaciones: [cómo darlos de alta](pipelines/operations/README.md).
En GitHub, los mismos tres corren como workflows de GitHub Actions, y los hallazgos de dependencias son issues en el
repo de cada producto: [cómo darlos de alta](pipelines/operations/github/README.md). El vigilante de producción no se
publicó: todavía es propio de TYCON.

## Dónde seguir

| Si querés… | Leé |
|---|---|
| Instalar a mano, en Linux o sin nadie delante | [Instalar a mano](getting-started/reference.es.md#instalar-a-mano) |
| Saber qué escribe en tu máquina y cómo apagar cada cosa | [Qué escribe en tu máquina](getting-started/reference.es.md#qué-escribe-en-tu-máquina-y-qué-hace-solo) |
| Actualizar, volver atrás o desinstalar | [Cómo se actualiza](getting-started/reference.es.md#cómo-se-actualiza) |
| Usarlo con Codex | [Qué es opcional](getting-started/reference.es.md#qué-es-opcional) |
| Cambiar el arnés | [CONTRIBUTING.md](.github/CONTRIBUTING.md) |

## Licencia y marcas

Apache License 2.0: ver [LICENSE](LICENSE). [NOTICE](NOTICE) lista el titular, las marcas y las atribuciones de
los archivos derivados de trabajo de terceros.

TYCON y Bizuit son marcas de sus dueños, y la licencia no las otorga.
Este arnés usa BMad Method, MIT; no está afiliado ni respaldado por BMad Code, LLC.

Para contribuir, leé [CONTRIBUTING.md](.github/CONTRIBUTING.md). Para reportar una vulnerabilidad, leé
[SECURITY.md](.github/SECURITY.md). Participar sigue el [código de conducta](.github/CODE_OF_CONDUCT.md).
