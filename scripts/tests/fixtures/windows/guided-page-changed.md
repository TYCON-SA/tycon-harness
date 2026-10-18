# Una página de juguete, con la forma de la página pública de Windows

Dato de prueba del ensayo guiado: la misma página con UN comando cambiado (el de instalar pide otro paquete), y el nombre del repo ya puesto (una organización
y un repo de juguete), como queda en una copia publicada. Donde la página nombra la carpeta del arnés va el marcador
`{{harness-place}}`: la prueba pone ahí el nombre de verdad antes de leerla.

## Parte 1 — instalación base

<!-- guided:base -->
```text
Necesito instalar en esta máquina el arnés TYCON para trabajar con Claude Code (y con BIZUIT Extensions). El arnés
vive en un repo público de GitHub: se baja sin cuenta y sin permiso. Seguí estos pasos EN ORDEN, en PowerShell 7,
corriendo cada comando TAL CUAL (no lo reescribas ni lo "mejores"). Si una salida no es la esperada, o aparece un error
que no está acá, PARÁ, no arregles nada a mano y mostrame la salida tal cual.

Perfil: si arriba de este pedido te escribí «quiero el perfil mínimo», en los pasos 2 y 3 cambiá --profile full por
--profile minimal, y salteá el paso 4. Si no, va full.

Si un paso contesta 403 o «límite de la API de GitHub»: GitHub limita los pedidos sin credencial a 60 por hora por
dirección de red, y una oficina entera suele compartir la suya. PARÁ y avisame, sin reintentar: o espero a que se
renueve (como mucho una hora) y repetimos ese paso; o, si tengo un permiso de GitHub propio, lo pongo YO en la variable
TYCON_GITHUB_TOKEN con la línea de abajo, en la misma terminal donde corro la línea npx (no se ve al pegarlo; vos no
lo leas ni lo muestres), y la vuelvo a correr: lo usa y lo guarda:
    $s = Read-Host -AsSecureString 'Permiso de GitHub'; $env:TYCON_GITHUB_TOKEN = [System.Net.NetworkCredential]::new('', $s).Password
Bajar el arnés va siempre sin credencial y casi no pasa por la API: gasta una sola consulta, la que verifica lo bajado.

1. Herramientas:
   $PSVersionTable.PSVersion.ToString(); node --version; npx --version; tar --version
   Esperado: PowerShell 7.algo, node v22 o más, npx (viene con node) y tar (viene con Windows 10 y posteriores). Lo
   que falte, decime que lo instale yo, de a uno:  winget install Microsoft.PowerShell · winget install OpenJS.NodeJS.LTS
   Después de instalar algo, tengo que cerrar y volver a abrir la terminal y Claude Code: avisame y esperá.
   (git NO hace falta: el arnés se baja como archivos, no se clona.)

2. Ver el plan de instalación (no instala nada): dame esta línea para mi ventana:
       npx @tyconsa/harness@latest --audience me --profile full --integrations none --packs all --dry-run
   La primera vez npx pregunta si baja el paquete («Need to install the following packages … Ok to proceed?
   (y)»): contesto y. Baja la versión a una carpeta temporal y muestra el plan. Te paso la salida: mostrame
   el plan resumido (qué escribe, qué hooks pone, y si configura la carpeta global de hooks de git) y preguntame si sigo.

3. Con mi sí, instalar, en mi ventana (la misma línea, sin la opción del final):
       npx @tyconsa/harness@latest --audience me --profile full --integrations none --packs bizuit
   Vuelve a mostrar el plan y pregunta «¿Instalo? [s/N]»: te paso la salida antes de contestar y, si es el mismo plan,
   contesto s. Esperado: termina con «versión: …» y un resumen, sin rojo. El arnés queda en $env:USERPROFILE\.tycon\harness
   (archivos, sin git).

4. Los controles que corren al commitear (hooks globales de git). Si git no tenía una carpeta global de hooks, la
   instalación la configuró (el plan lo decía): con ella git deja de llamar a los .git/hooks/ propios de mis repos, y el
   arnés los corre en su lugar (pre-commit, post-commit y pre-push; los de otro nombre no), junto con el
   .githooks/pre-commit de cada repo. Mirá cómo quedó:
   git config --global --get core.hooksPath
   Si no devuelve nada, corré:  git config --global core.hooksPath "$env:USERPROFILE\.git-hooks"
   Si devuelve otra carpeta, NO la pises: mostrámela y decidimos.

5. Verificar (tres comandos):
   node "$env:USERPROFILE\.claude\tycon-harness\scripts\setup\harness.js" doctor
   @(Get-ChildItem "$env:USERPROFILE\.claude\skills" -Directory).Count
   (Select-String -Path "$env:USERPROFILE\.claude\CLAUDE.md" -Pattern "INDEX.md").Count
   Esperado: doctor dice «perfil: full» (o «perfil: minimal» si pedí el mínimo) y cierra con «todo en orden» (o «N aviso(s), nada en rojo»); más de 40 skills; 1.

6. Armame UN solo bloque de texto, para guardarlo o para pedir ayuda, con la salida de los pasos 1 y 3 (el final), y
   la salida COMPLETA del paso 5, más una línea final «OK» o «NO OK». Después decime que cierre y vuelva a abrir Claude
   Code.

Para trabajar con BIZUIT Extensions: el paquete bizuit ya queda prendido para todos mis repos (--packs all). Las guías
para empezar un plugin o un formulario están en ~/.claude/tycon-harness/packs/bizuit/guides/ (vienen con el perfil de tu equipo) y te mandan a los templates públicos.
```
<!-- /guided:base -->
