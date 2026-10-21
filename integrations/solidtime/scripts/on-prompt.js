#!/usr/bin/env node
'use strict';
// on-prompt.js — hook UserPromptSubmit de Solidtime (de fondo): con cada mensaje de la persona cierra lo que quedó 15
// minutos sin actividad, con el fin en su última actividad. De fondo porque llama a la instancia: una que no contesta
// no demora el mensaje. La lógica, en hook-event.js.

require('./hook-event.js').run('sweep');
