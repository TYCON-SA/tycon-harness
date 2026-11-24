'use strict';
/**
 * without-team-profile.js — la prueba fija su propio ambiente: sin el perfil del equipo.
 *
 * Las claves que vale sólo el perfil del equipo (las firmas de trámite, la delegación, la coordinadora) salen del perfil
 * que está en la carpeta del arnés, y ninguna variable las cambia (tycon-config.js, PROFILE_ONLY). En el nocturno y en
 * la validación del repo privado esa carpeta trae el perfil del equipo encima: una prueba que no dice qué perfil usa ve
 * las firmas que el equipo delega y sale roja por el árbol, no por lo que mira. Requerir este archivo antes que nada
 * hace que, dentro del proceso de la prueba, la firma de trámite y la delegación lean un arnés sin perfil, salvo que la
 * llamada pase el suyo (`arnes` o `perfil`). No cambia el perfil ni el código del arnés: cambia lo que ve la prueba.
 *
 * Los guiones que la prueba lanza como procesos leen su propio árbol: para esos, la copia del arnés (harness-copy.js),
 * que no trae el perfil.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// un arnés de juguete sin perfil: la carpeta vacía alcanza (sin team-profile.json, sin claves del equipo)
const ARNES_SIN_PERFIL = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sin-perfil-')));
process.on('exit', () => { try { fs.rmSync(ARNES_SIN_PERFIL, { recursive: true, force: true }); } catch (_e) { /* la limpia el sistema */ } });

const LIB = path.join(__dirname, '..', '..', 'lib');
const ds = require(path.join(LIB, 'delegated-signing.js'));
const leerListas = ds.profileLists;
ds.profileLists = (o = {}) => leerListas({ ...o, arnes: o.arnes || ARNES_SIN_PERFIL });
// la delegación lee las listas por dentro: también recibe el arnés sin perfil, salvo que traiga el suyo o sus listas
const delega = ds.delegaSinVentana;
ds.delegaSinVentana = (o = {}) => delega({ ...o, arnes: o.arnes || (o.perfil ? undefined : ARNES_SIN_PERFIL) });

const as = require(path.join(LIB, 'automatic-signing.js'));
const deTramite = as.esDeTramite;
const todas = as.todasDeTramite;
as.esDeTramite = (o = {}) => deTramite({ ...o, arnes: o.arnes || ARNES_SIN_PERFIL });
as.todasDeTramite = (firmas, o = {}) => todas(firmas, { ...o, arnes: o.arnes || ARNES_SIN_PERFIL });

module.exports = { ARNES_SIN_PERFIL };
