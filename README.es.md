# Arnés TYCON

[English](README.md) · Castellano

**Un ciclo de desarrollo para agentes de código: completo, consistente, controlado y adaptable.**

- **Completo:** va del pedido a producción y a la medición; no se queda en escribir código.
- **Consistente:** cada historia hace el mismo recorrido, en cada máquina del equipo.
- **Controlado:** los controles frenan, no sólo avisan: no dependen de que el modelo se acuerde de las reglas. La
  instalación mínima trae uno (el de comandos destructivos); la completa suma los demás.
- **Adaptable:** cada organización suma sus revisores, sus skills y su configuración.

Tu agente de código escribe rápido; el arnés hace que lo haga con método. Funciona con Claude Code y con Codex. El
ciclo de desarrollo con IA (AI SDLC), paso por paso:

1. **Pedido e historia:** contás qué querés y el agente lo escribe como una historia (story): qué hay que hacer y cómo
   se prueba. Para un ajuste chico alcanza con pedirlo con tus palabras.
2. **Plan aprobado:** el agente arma el plan y espera tu visto bueno.
3. **Pruebas y código:** escribe las pruebas y el código, y corre las pruebas.
4. **Revisión:** revisores especializados (seguridad, convenciones, cobertura) miran el cambio antes del commit.
5. **Entrega:** el commit y el merge pasan por controles. Nada se commitea ni se sube sin tu permiso.
6. **Operación y medición:** cada merge a main deja su archivo de métricas, y los procesos de la noche de tu
   organización revisan las dependencias y arman el tablero del ciclo.

Los controles son una parte del ciclo: cuidan cada paso. Se arranca de dos maneras: [solo, en tu
máquina](#empezá-solo), o [para tu equipo](#para-equipos).

## Empezá solo

**Sirve hoy para .NET, JavaScript, TypeScript, Python, Go y Java**: el paso de pruebas corre de fábrica .NET, Vitest,
Jest, Node (`node --test`), pytest, Go, Maven, Gradle y Karma. Con otra herramienta, ese paso todavía no reconoce tus
pruebas hasta que tu equipo la declara en su configuración («Tu tecnología», en el sitio).

Antes de instalar necesitás tu agente de código (Claude Code o Codex) con tu sesión iniciada, y Node 22 o posterior.
La lista completa está en [Qué necesitás](#qué-necesitás).

Para que tu agente siga el ciclo, instalá el arnés en tu máquina. Abrí la terminal (en Windows, PowerShell 7) y
escribí:

```bash
npx @tyconsa/harness@latest
```

No te pregunta nada antes del plan: instala para vos, con la instalación mínima, sin conexiones opcionales y sin
revisores para una tecnología. Te muestra en cinco renglones qué va a cambiar y pregunta una sola vez
«¿Instalo? [s/N]»: con un «no», no queda nada. Si no tenés Claude Code ni Codex, te dice cómo instalarlos y no baja
nada. Con el «sí» tarda menos de un minuto y termina con «arnés instalado» y la versión. La instalación mínima suma a
tu agente el índice de guías del arnés en cada sesión; no toca git ni las reglas de cómo te contesta. Para sacarla,
`harness.js uninstall --dry-run` muestra qué quitaría y `harness.js uninstall --yes` la quita.

Si usás Codex, falta un paso: la última línea te pide abrir `codex`, correr `/hooks` y aprobarlos una vez. Codex
aprueba sus hooks uno por uno; sin ese paso, los controles del arnés no corren en Codex y no avisan.

La instalación completa suma los frenos en los repos que trabajan con el arnés y cambia cómo te contesta el agente en todos tus proyectos:
[qué cambia](getting-started/reference.es.md#qué-cambia-la-instalación-completa).

## Tu primera historia

Una historia es tu pedido escrito, con sus criterios y sus pruebas: el agente la sigue y los revisores la controlan. Que la primera sea chica, como una función nueva en un archivo: una así tarda unos 10 minutos.

1. **Abrí tu agente de código en la carpeta de tu repo**, para que cargue las reglas del arnés (si estaba abierto, cerralo y abrilo de nuevo: las reglas entran al abrirlo).
2. **Decí que confiás en la carpeta**: la primera vez que abrís tu agente en esa carpeta, te pregunta si confiás en ella: contestá que sí.
3. **Pedí la historia con tus palabras**, para que el cambio quede escrito antes de programar: «creá una historia para agregar un filtro por fecha».
4. **Revisá la historia.** El agente la arma con lo que le pediste, contestando tres preguntas en llano (qué tiene que hacer, cómo se ve que anda y qué no tiene que tocar), y te marca lo que supuso. Te la muestra y la escribe con tu «sí». Si tu repo ya trae la carpeta `_bmad/`, la arma con lo que hay ahí.
5. **Pedí «implementemos la story» con la ruta del archivo**, para arrancar el recorrido: la frase va así. Si no hay git, lo inicia; si estás en `main`, crea la rama. Valida la historia y, si le falta algo, te pregunta si la arregla. Te muestra el plan y lo aprobás vos. Después escribe las pruebas y el código, corre las pruebas y los revisores, y prueba cada criterio corriéndolo. Si la historia toca pantallas, además arma una maqueta para que la apruebes, la prueba con un navegador si tu repo ya tiene esas pruebas, y te deja una guía para probarla a mano.
6. **Revisá el resumen y decí «commitealo».** Te deja el mensaje armado y nunca commitea ni sube cambios sin tu permiso. Al cerrar la primera historia te ofrece la instalación completa.

Si algo no anda, `/tycon-harness` (en Claude Code) o `node ~/.claude/tycon-harness/scripts/setup/harness.js doctor` dicen qué falta, sin tocar nada.

## Qué necesitás

- Tu agente de código, Claude Code o Codex, instalado y con tu sesión iniciada: es donde se usa el arnés.
- Node 24 y `tar` (para correr la línea de instalación alcanza con Node 22 o posterior). En Mac y Linux, además, Python 3.
- Windows 11 con PowerShell 7, Mac o Linux. En WSL no se probó.
- Git **no** hace falta para instalar el arnés: se baja como archivos, no se clona.
  Tampoco hace falta una cuenta de GitHub: este repo es público. Para commitear tus historias sí hace falta git, con
  tu nombre y tu correo configurados (`git config --global user.name` y `user.email`).
- Tu Node hace falta para instalar. Después el arnés baja su propio Node 24 (unos 50 MB, de nodejs.org) y sus hooks
  corren con él; tus proyectos siguen con tu Node, que no se toca. Se apaga con `TYCON_HARNESS_NODE=0`.
- Lo que tu proyecto necesita para compilar (por ejemplo, el SDK de .NET). Sin eso, la implementación frena al compilar.

Si te falta algo, el instalador te dice qué y no instala nada. Para instalar a mano, sin npm, o sin nadie delante:
[Instalar a mano](getting-started/reference.es.md#instalar-a-mano).

## Instalar con Claude Code

Es la alternativa si preferís que te guíen, y lleva unos 10 minutos. Claude corre casi todos los comandos; la
instalación corre en tu propia terminal. Por este camino queda la instalación completa (`full`).

1. Abrí las instrucciones de tu sistema: [Windows](getting-started/windows.md), [Mac](getting-started/mac.md) o [Linux](getting-started/linux.md).
2. Copiá el bloque entero de la «Parte 1». Abrí Claude Code en cualquier carpeta y pegalo en una conversación nueva.
3. Claude te da la línea npx para tu propia terminal: la corrés vos, así ves el plan antes de contestar. Nada te pide
   iniciar sesión: el arnés nunca abre un navegador.
4. Claude te muestra el plan de instalación y espera tu «sí». El plan dice si va a configurar `core.hooksPath`.
5. Al final te arma un resumen que termina en «OK» o «NO OK». Cerrá Claude Code y abrilo de nuevo.

Si en el camino instalás una herramienta, Claude te pide cerrar y abrir la terminal y Claude Code. Si el resumen dice
«NO OK», guardalo: es lo que hay que mostrar al pedir ayuda.

El arnés queda en `~/.tycon/harness`, como archivos bajados (sin git). `~/.claude/tycon-harness` es un acceso directo a
esa misma carpeta, y es el que usan los comandos de esta página. No borres ni muevas esa carpeta: tu agente lo usa
desde ahí, y se actualiza solo en ese lugar. Usar el arnés nunca necesita un clon de este repo.

**La instalación mínima.** Al pegar el bloque, escribí arriba «quiero el perfil mínimo». Claude instala `minimal` y no
toca `core.hooksPath`.

## Para equipos

**Primero probalo solo.** Instalalo en tu máquina como dice arriba: no hace falta nada de tu organización. Si te sirve,
se arma para el equipo con dos repos de la organización, que sólo ve tu equipo, además de éste, que es el mismo para
todos:

| Repo | Qué guarda | ¿Llega a cada máquina? |
|---|---|---|
| Éste (público) | el arnés | Sí |
| El **repo del equipo** (por ejemplo `harness-team-profile`) | la configuración que comparte el equipo y la lista de dónde vive cada repo de la organización (`team-repos.json`) | Sí, a cada máquina que instala con `--team` |
| Las **operaciones del equipo** (por ejemplo `harness-team-operations`) | lo que corre de noche para la organización (dependencias, tablero, retrospectivas) y a quién se le asignan sus avisos (`operations.json`) | No: lo leen sólo esos procesos |

Un ejemplo: en ACME, Pedro es el admin y Juan programa.

1. Pedro da de alta ACME con `npx @tyconsa/harness@latest --audience org`. La línea instala su máquina y sigue con `harness.js team-init`: pregunta el nombre, la plataforma y
   la dirección del repo del equipo, arma sus tres archivos (`team-layer.json`, `team-profile.json` y `team-repos.json`)
   a partir de [un ejemplo](https://github.com/TYCON-SA/harness-team-profile-example) y los valida antes de escribir. No
   crea repos ni pide credenciales: le dice dónde crear el repo vacío, con acceso sólo para el equipo, y si dice que sí
   lo sube con su git. Con el arnés ya instalado, lo mismo es `node ~/.tycon/harness/scripts/setup/harness.js team-init`.
   El repo de operaciones se crea aparte (abajo, «Los procesos de la noche»).
2. Todo lo que se personaliza —dónde vive cada repo, a quién se le asignan los avisos, los umbrales— se configura desde
   la pestaña **Configuración** del [sitio del equipo](guides/organization-site.md) (sólo para los admins): valida con
   los mismos lectores del arnés y propone cada cambio con un pedido de cambio (pull request), nunca escribe `main`.
   Mientras ACME no tiene su sitio, cada archivo se cambia con un pedido de cambio a su repo: lo que llega a las
   máquinas, al repo del equipo; lo de la noche y del sitio, al de operaciones. El arnés funciona entero así: qué
   necesita cada caso y dónde vive cada configuración, en [Con sitio o sin sitio](getting-started/reference.es.md#con-sitio-o-sin-sitio).
   La página local (`node ~/.tycon/harness/scripts/setup/harness.js team-config`) muestra, de sólo lectura y sin nada
   en internet, lo que hay en sus clones y los problemas que ven los lectores; no guarda ni propone nada.
3. Juan instala con npx y el repo del equipo: `npx @tyconsa/harness@latest --team acme/harness-team-profile` si está en
   GitHub, o `npx @tyconsa/harness@latest --team https://dev.azure.com/acme/<proyecto>/_git/harness-team-profile` si
   está en Azure DevOps. Como ese repo lo ve sólo el equipo, antes de bajar nada la línea mira si lo puede leer y, si
   no, le pide el permiso de lectura. Desde ahí, cada actualización le trae también lo del equipo.

Cómo se extiende el arnés para tu organización —qué suma cada organización, la página de configuración y un recorrido de ejemplo— en un
[mapa interactivo](https://www.bizuit.com/sdd-harness/more/mapa-del-arnes.html).

**Los procesos de la noche.** En Azure DevOps, la revisión de dependencias, las métricas del ciclo y el tablero corren en
tu organización con tres procesos modelo y tu repo de operaciones: [cómo darlos de alta](pipelines/operations/README.md).
En GitHub, los mismos tres corren como workflows de GitHub Actions, y los hallazgos de dependencias son issues en el
repo de cada producto: [cómo darlos de alta](pipelines/operations/github/README.md).

## Qué más hace

- **Se vigila a sí mismo.** Un banco de pruebas comprueba, en cada cambio al arnés, que cada control siga frenando lo
  que dice. Si lo prendés, además observa tus sesiones y propone reglas nuevas, que vos aprobás.
- **Controles que nacieron de incidentes.** Con la instalación completa, los controles frenan, no sólo avisan. La
  mayoría nació de un incidente real.
- **Revisores para tu tecnología.** Cada organización suma los suyos en su repo del equipo. TYCON trae los suyos para
  plugins de BIZUIT, con los guiones que despliegan a pruebas y a producción.
- **Lo que todavía es propio de TYCON:** el vigilante de producción no se publicó.

Las palabras del arnés (historia, recorrido, freno, procesos de la noche…), una línea cada una, en
[Las palabras del arnés](getting-started/reference.es.md#las-palabras-del-arnés).

## Dónde seguir

| Si querés… | Leé |
|---|---|
| Instalar a mano, en Linux o sin nadie delante | [Instalar a mano](getting-started/reference.es.md#instalar-a-mano) |
| Saber qué escribe en tu máquina y cómo apagar cada cosa | [Qué escribe en tu máquina](getting-started/reference.es.md#qué-escribe-en-tu-máquina-y-qué-hace-solo) |
| Actualizar, volver atrás o desinstalar | [Cómo se actualiza](getting-started/reference.es.md#cómo-se-actualiza) |
| Usarlo con Codex | [Qué es opcional](getting-started/reference.es.md#qué-es-opcional) |
| Entender una palabra del arnés | [Las palabras del arnés](getting-started/reference.es.md#las-palabras-del-arnés) |
| Cambiar el arnés | [CONTRIBUTING.md](.github/CONTRIBUTING.md) |

## Licencia y marcas

Apache License 2.0: ver [LICENSE](LICENSE). [NOTICE](NOTICE) lista el titular, las marcas y las atribuciones de
los archivos derivados de trabajo de terceros.

TYCON y Bizuit son marcas de sus dueños, y la licencia no las otorga.
Este arnés usa BMad Method, MIT; no está afiliado ni respaldado por BMad Code, LLC.

Para contribuir, leé [CONTRIBUTING.md](.github/CONTRIBUTING.md). Para reportar una vulnerabilidad, leé
[SECURITY.md](.github/SECURITY.md). Participar sigue el [código de conducta](.github/CODE_OF_CONDUCT.md).
