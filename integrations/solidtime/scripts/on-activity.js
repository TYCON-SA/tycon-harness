#!/usr/bin/env node
'use strict';
// on-activity.js — hook PostToolUse de Solidtime (de fondo): cada uso de una herramienta anota la última actividad de la
// sesión, sin llamar a la API. La lógica, en hook-event.js.

require('./hook-event.js').run('activity');
