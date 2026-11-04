/*
 * page.js — el código de la página de la oficina. Lo cargan igual la oficina local y la pestaña «Oficinas» del sitio;
 * el HTML (page.html) no trae código, y la fuente la dice su atributo `data-source`.
 *
 * La librería 3D se pide recién al armar una sala: si no carga, las tarjetas y la tabla siguen andando.
 */
// la fuente la dice la página: `local`, `site` o `demo`. Sin ninguna, la foto fija, que lleva sus datos adentro
const RAIZ=document.documentElement,SOURCE=RAIZ.dataset.source||null,CON_OFICINAS=SOURCE==="site"||SOURCE==="demo";
let DATA=(()=>{const b=document.getElementById("officeData");return b?JSON.parse(b.textContent):{}})();
// con el proceso local, las fotos llegan por el WebSocket; la página nunca le manda nada
const LIVE=SOURCE==="local"?{token:RAIZ.dataset.token}:null;
const el=(t,c,txt)=>{const e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e};
const DAYS=["dom","lun","mar","mié","jue","vie","sáb"];
const parse=s=>{const m=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/.exec(s||"");return m?new Date(+m[1],m[2]-1,+m[3],+m[4],+m[5]):null};
const fmt=s=>{const d=parse(s);return d?DAYS[d.getDay()]+" "+String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0"):"—"};
const AST={trabajando:["Trabajando","#3ddc84"],prueba:["Corriendo pruebas","#5aa9ff"],parada:["Parada","#c9b458"],espera:["Esperando entrar","#a59fc4"],esperando:["Esperando","#e8b84a"],firma:["Tu firma","#ffa53d"],pregunta:["Te pregunta","#ffa53d"],libre:["Libre","#9aa3a0"],coordina:["Coordinando","#ff6fc0"],inactiva:["Inactiva","#6b6f6e"]};
const SHIRT=["#c2569b","#2f9e6a","#3b7ddd","#e08a1e","#7a5cc7","#d65a4a"];
let agents,items,meta;
function setData(d){DATA=d||{};agents=DATA.agents||[];items=DATA.items||[];meta=DATA.meta||null}
// el enlace al sitio sale sólo de lo que armó office.js, nunca de un mensaje del WebSocket, y sólo si es web
const SITE=(()=>{try{const u=new URL(RAIZ.dataset.site||"");return u.protocol==="https:"||u.protocol==="http:"?u.href:null}catch(e){return null}})();
setData(DATA);
// el fin lo calcula office.js una vez por sesión: la etiqueta, la tarjeta, el detalle, el panel y la tabla dicen lo mismo
const finTxt=a=>a.fin||null;
// los pendientes: cinco columnas siempre, del estado real y del tablero de la coordinadora. Todo va como texto, nunca como HTML
// cómo va una tarjeta de «En curso», de lo que ya dice su hora: lo calcula la oficina, con su margen de 15 minutos. Sin hora, nada
function estadoDeHora(i){const h=i.hora||"";if(i.espera||/^espera\b|parada/.test(h))return ["Esperando","#d19a00"];if(/tarde|se pasó|estaba para/.test(h))return ["Pasada de la hora","#e5534b"];if(/en hora|antes$/.test(h))return ["En hora","#2fa866"];return null}
function renderBoard(){const body=document.getElementById("boardBody"),k=DATA.kanban,t=DATA.tablero,KC={firma:"#ffa53d",curso:"#5aa9ff",entrando:"#a59fc4",sinEmpezar:"#9aa3a0",hechos:"#3ddc84"};body.replaceChildren();
  if(!k)return;
  const resumen=t&&t.resumen||"";
  const top=el("p","sum");top.textContent=resumen+(k.escrito?(resumen?" · ":"")+k.escrito:"");if(top.textContent)body.appendChild(top);
  const cols=el("div","cols");
  (k.columnas||[]).forEach(c=>{const col=el("div","col"),list=c.tarjetas||[];col.style.setProperty("--k",KC[c.id]||"var(--line)");col.appendChild(el("h3",null,c.nombre+" · "+list.filter(i=>!i.otro).length));
    if(c.nota)col.appendChild(el("p","none",c.nota));
    if(!list.length)col.appendChild(el("p","none","Nada"));
    list.forEach(i=>{const card=el("div","item abre"),tit=el("b","una-linea",i.titulo||"");tit.title=i.titulo||"";card.tabIndex=0;card.setAttribute("role","button");card.onclick=()=>{if(!String(window.getSelection?getSelection():""))abrirTarjeta(i,card);};card.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();abrirTarjeta(i,card);}};card.appendChild(tit);const line=[i.quien,i.hora,i.grupo].filter(Boolean).join(" · ");if(line)card.appendChild(el("span","m",line));const eh=c.id==="curso"&&estadoDeHora(i);if(eh){card.style.setProperty("--k",eh[1]);card.appendChild(el("span","estado-hora",eh[0]))}
      [i.espera?"Espera "+i.espera+".":"",i.marca,i.motivo,i.nota].forEach(v=>{if(v)card.appendChild(el("span","n",v))});col.appendChild(card)});
    cols.appendChild(col)});
  body.appendChild(cols);
}
// lo que de verdad quedó sin terminar, en las dos vistas, con qué hacer con cada cosa. Sin nada que decir, no aparece
function renderHalfway(){const sec=document.getElementById("halfway"),k=DATA.kanban||{},half=k.medioCamino||[];sec.replaceChildren();sec.hidden=!half.length&&!k.medioCaminoNoSe;if(sec.hidden)return;
  sec.appendChild(el("h2",null,"A medio camino"));
  if(k.medioCaminoLeido)sec.appendChild(el("p","none",k.medioCaminoLeido));
  half.forEach(i=>{const card=el("div","item");card.appendChild(el("b",null,i.titulo));card.appendChild(el("span","n",i.accion));sec.appendChild(card)});
  if(k.medioCaminoNoSe)sec.appendChild(el("p","none",k.medioCaminoNoSe))}
function renderTop(){
  document.getElementById("stamp").textContent=meta?"Al día a las "+meta.actualizado+(meta.pedidosLeidos?" · pedidos leídos a las "+meta.pedidosLeidos:""):"";
  const site=document.getElementById("site");if(SITE){site.href=SITE;site.hidden=false}else{site.removeAttribute("href");site.hidden=true}
  const you=(meta&&meta.teToca)||[],ul=document.getElementById("youList");ul.replaceChildren();you.forEach(t=>ul.appendChild(el("li",null,t)));if(!you.length)ul.appendChild(el("li","nada","Nada por ahora: no hay firmas pendientes ni pedidos en el tablero."));
  const tr=document.getElementById("trabado"),stuck=(meta&&meta.trabado)||[];tr.hidden=!stuck.length;tr.replaceChildren();if(stuck.length){tr.appendChild(el("h2",null,"Trabado"));stuck.forEach(g=>{tr.appendChild(el("h3",null,g.titulo));const u=el("ul");(g.filas||[]).forEach(f=>u.appendChild(el("li",null,f)));tr.appendChild(u)})}
  pintarResumen(you.length,stuck.reduce((n,g)=>n+(g.filas||[]).length,0));
  const tb=document.getElementById("rows");tb.replaceChildren();(DATA.rows||[]).forEach(r=>{const tr=el("tr");[r.work,r.state,r.end,r.session,r.folder].forEach(v=>tr.appendChild(el("td",null,v||"")));tb.appendChild(tr)});
  if(!(DATA.rows||[]).length){const tr=el("tr");const td=el("td",null,"Nadie trabaja en esta máquina.");td.colSpan=5;tr.appendChild(td);tb.appendChild(tr)}
  const fl=document.getElementById("freeLine"),free=(DATA.free||[]).length?"Libres: "+DATA.free.join(", "):"";fl.textContent=free;fl.hidden=!free;
  const nr=document.getElementById("noRead"),bad=(DATA.unreadable||[]).join(" · ");nr.textContent=bad?"No se pudo leer: "+bad:"";nr.hidden=!bad;
  renderBoard();renderTablas();renderHalfway();pintarVista()}
// el trabajo se ve de a una vista, y la página recuerda la última: sólo esta persona y este navegador
// las etiquetas de la oficina: siempre, o sólo al pasar el mouse. Lo que pide atención se ve igual: la mano y el aro son del dibujo
const ETIQUETAS_KEY="office.etiquetas";
function etiquetasGuardadas(){try{return localStorage.getItem(ETIQUETAS_KEY)==="mouse"?"mouse":"siempre"}catch(e){return "siempre"}}
function guardarEtiquetas(v){try{localStorage.setItem(ETIQUETAS_KEY,v)}catch(e){/* sin dónde guardarla, vale hasta recargar */}}
function modoEtiquetas(v){document.querySelectorAll(".stage").forEach(s=>s.classList.toggle("solo-mouse",v==="mouse"))}
document.querySelectorAll('input[name="etiquetas"]').forEach(r=>{r.checked=r.value===etiquetasGuardadas();r.onchange=()=>{guardarEtiquetas(r.value);modoEtiquetas(r.value)}});modoEtiquetas(etiquetasGuardadas());
const VISTA_KEY="office.vista";
// el bloque de arriba, en una línea que se abre al tocarla: destaca si algo te toca, y sin nada no hay qué abrir
const RESUMEN_KEY="office.resumenAbierto";
function resumenGuardado(){try{return localStorage.getItem(RESUMEN_KEY)==="1"}catch(e){return false}}
function guardarResumen(v){try{localStorage.setItem(RESUMEN_KEY,v?"1":"0")}catch(e){/* sin dónde guardarlo, vale hasta recargar */}}
let resumenAbierto=resumenGuardado();
function lineaResumen(toca,trabados){const vacio=!toca&&!trabados;return{texto:vacio?"Nada por ahora":"Te toca: "+toca+" · Trabado: "+trabados,pide:toca>0,vacio}}
function pintarResumen(toca,trabados){const r=lineaResumen(toca,trabados),b=document.getElementById("resumenLinea"),abierto=resumenAbierto&&!r.vacio;
  document.getElementById("resumen").classList.toggle("pide",r.pide);b.disabled=r.vacio;b.setAttribute("aria-expanded",String(abierto));b.replaceChildren(...(r.vacio?[]:[el("span",null,abierto?"▾":"▸")]),document.createTextNode(r.texto));document.getElementById("resumenListas").hidden=!abierto;
  b.onclick=()=>{resumenAbierto=!resumenAbierto;guardarResumen(resumenAbierto);pintarResumen(toca,trabados)}}
function vistaGuardada(){try{const v=localStorage.getItem(VISTA_KEY);return v==="kanban"||v==="tablas"?v:null}catch(e){return null}}
function guardarVista(v){try{localStorage.setItem(VISTA_KEY,v)}catch(e){/* sin dónde guardarla, vale hasta recargar */}}
let vista=vistaGuardada()||"tablas";
function pintarVista(){const hay=Boolean(DATA.tablas),k=Boolean(DATA.kanban),v=vista==="kanban"&&k||!hay?"kanban":"tablas";
  document.getElementById("tablas").hidden=v!=="tablas"||!hay;document.getElementById("board").hidden=v!=="kanban"||!k;
  document.getElementById("trabajo").hidden=!hay&&!k;
  document.querySelectorAll('input[name="vista"]').forEach(i=>{i.checked=i.value===v})}
document.querySelectorAll('input[name="vista"]').forEach(i=>i.addEventListener("change",()=>{if(!i.checked)return;vista=i.value;guardarVista(vista);pintarVista()}));
// los dos resúmenes por tema, con la hora en que se armaron. Un tema se abre y muestra sus trabajos, y sigue abierto con la foto
// nueva. Todo va como texto, nunca como HTML
const temasAbiertos=new Set();
function renderTablas(){const sec=document.getElementById("tablas"),ts=DATA.tablas,activo=document.activeElement,foco=activo&&activo.dataset?activo.dataset.tema:null;sec.replaceChildren();if(!ts)return;
  ["hoy","pendientes","hechos"].forEach(k=>{const t=ts[k];if(!t)return;const d=el("div","una");d.appendChild(el("h2",null,t.titulo));d.appendChild(el("span","escrito",[t.escrito,t.cruce].filter(Boolean).join(" · ")));
    if(!(t.filas||[]).length){d.appendChild(el("p","none",t.vacio||"Nada"));sec.appendChild(d);return;}
    const tb=el("table"),hd=el("tr");t.columnas.forEach(c=>hd.appendChild(el("th",null,c)));const th=el("thead");th.appendChild(hd);tb.appendChild(th);const bd=el("tbody");
    t.filas.forEach(r=>{const tr=el("tr");
      if(!(r.trabajos||[]).length){[r.grupo,r.que,r.col].forEach(v=>tr.appendChild(el("td",null,v||"")));bd.appendChild(tr);return}
      const id=k+"|"+r.grupo,b=el("button","temaBoton",r.grupo),primera=el("td"),det=el("tr","temaTrabajos"),dd=el("td"),ul=el("ul");
      b.type="button";b.dataset.tema=id;primera.appendChild(b);tr.className="temaFila";tr.appendChild(primera);[r.que,r.col].forEach(v=>tr.appendChild(el("td",null,v||"")));
      r.trabajos.forEach(w=>{const li=el("li");li.appendChild(el("b",null,w.titulo));li.appendChild(el("span",null,[w.quien,w.como].filter(Boolean).join(" · ")));ul.appendChild(li)});
      dd.colSpan=3;dd.appendChild(ul);det.appendChild(dd);
      const pintar=()=>{const abierta=temasAbiertos.has(id);det.hidden=!abierta;b.setAttribute("aria-expanded",String(abierta))};
      tr.addEventListener("click",()=>{if(temasAbiertos.has(id))temasAbiertos.delete(id);else temasAbiertos.add(id);pintar()});pintar();
      bd.appendChild(tr);bd.appendChild(det);if(foco===id)b.focus()});
    tb.appendChild(bd);const w=el("div","table");w.appendChild(tb);d.appendChild(w);sec.appendChild(d);})}
function renderCrew(){pintarTarjetas(document.getElementById("crew"),agents)}
function pintarTarjetas(c,list,alTocar){c.replaceChildren();
  if(!list.length){c.appendChild(el("p","empty","No hay sesiones abiertas en esta máquina."));return}
  list.forEach((a,i)=>{const s=AST[a.estado]||[a.estado||"","#999"];const k=el("div","card");
    const h=el("h3");const d=el("span","dot");d.style.background=SHIRT[i%SHIRT.length];h.appendChild(d);h.appendChild(document.createTextNode(a.nombre||""));k.appendChild(h);
    const st=el("span","st",s[0]);st.style.color=s[1];st.style.borderColor=s[1];const chips=el("div","chips");chips.appendChild(st);if(a.comoTrabaja&&a.comoTrabaja!==s[0])chips.appendChild(etiquetaComo(a.comoTrabaja));k.appendChild(chips);k.style.setProperty("--c",s[1]);
    pintarFicha(a,k,false);if(alTocar){k.classList.add("abre");k.tabIndex=0;k.setAttribute("role","button");k.onclick=e=>{if(!e.target.closest("button,summary,a"))alTocar(a)};k.onkeydown=e=>{if(e.target===k&&(e.key==="Enter"||e.key===" ")){e.preventDefault();alTocar(a)}}}c.appendChild(k);})}
// lo que se dice de una sesión, de un solo lugar: la tarjeta y el panel pintan esta lista y sólo cambia su estilo
function ficha(a){const r=[],add=(k,v,x)=>{if(v!=null&&v!=="")r.push({k,v,...x})};
  add("Trabajo",a.titulo);add("De la historia",a.historia);add("Encargo",a.encargo);
  if(a.haciendoAhora)add("Haciendo ahora",a.haciendoAhora);else if(a.haciendo!==a.titulo&&!SOLO_COORDINA.test(a.haciendo||""))add("Haciendo",a.haciendo);
  if(a.agentesAhora)r.push({k:"",v:a.agentesAhora});
  add("Última acción",a.ultimaAccion);add("Espera",a.espera);add("Parada",a.parada);add("Novedades",a.callada);
  const ms=AST[a.mientrasEstado];add("Mientras tanto",a.mientras?a.mientras+(ms?" ("+ms[0].toLowerCase()+")":""):"");
  add("En pausa",a.enPausa);
  // quien espera a otro no da una hora: dice qué espera, o qué pasó con los pedidos que esperaba
  const f=finTxt(a),h=f?String(f.hora):"";if(h.startsWith("espera "))add("Espera",h.slice(7),{dif:f.dif,cls:f.cls});else if(/^El \d+ /.test(h))r.push({k:"",v:h});else if(f)add("Termina",f.hora,{dif:f.dif,cls:f.cls});
  add("Por qué",a.horaPorque);if(a.estimadaIso)add("Prometido",fmt(a.estimadaIso));
  if(a.avance!=null)add("Avance",a.avance+"%",{pct:a.avance});
  const tk=(DATA.tokens||{})[a.nombre];if(tk){if(tk.noMedido)add("Tokens","no medido");else{add("Contexto",tk.contexto);add("Tokens consumidos",tk.consumidos);if(tk.agentes)r.push({k:"",v:tk.agentes===1?"Incluye su agente":"Incluye sus "+tk.agentes+" agentes"});}}
  add("Carpeta",a.carpeta);return r;}
// la ficha dentro de `box`; los pasos van plegados en la tarjeta y abiertos en el panel
// El ícono de cómo trabaja: la forma alcanza para distinguirlos, sin color. Se arma con nodos y dibujos fijos, nunca con el
// texto de la foto. La coordinadora lleva la misma flecha de su estado; la de camino corto termina en una barra.
const AVION_ICONO=["path",{d:"M21 3 3 10.5l7 2.6L12.5 21zM21 3 10 13.1"}];
const SOLO_COORDINA=/^Coordina las sesiones de esta máquina\.?$/;
const COMO_ICONO={corto:["path",{d:"M3 12h11M10 7l5 5-5 5M20 6v12"}],historia:["path",{d:"M12 6c-2-1.5-5-2-8-2v14c3 0 6 .5 8 2 2-1.5 5-2 8-2V4c-3 0-6 .5-8 2zM12 6v14"}],otra:["circle",{cx:"12",cy:"12",r:"7"}]};
const COMO_SVG={viewBox:"0 0 24 24",fill:"none",stroke:"currentColor","stroke-width":"2.2","stroke-linecap":"round","stroke-linejoin":"round"};
function iconoComo(como){const s=document.createElement("span");s.className="ico";s.setAttribute("aria-hidden","true");const t=String(como||"");
  if(t==="Coordinando"){s.textContent="→";return s}
  const k=t==="Camino corto"?"corto":t.startsWith("Historia")?"historia":"otra";
  s.appendChild(dibujo(COMO_ICONO[k]));return s}
function dibujo(forma){const NS="http://www.w3.org/2000/svg",nodo=(tag,attrs)=>{const n=document.createElementNS(NS,tag);Object.entries(attrs).forEach(([a,v])=>n.setAttribute(a,v));return n},svg=nodo("svg",COMO_SVG);svg.appendChild(nodo(...forma));return svg}
// el globo de diálogo del botón de la conversación
const CHARLA_ICONO=["path",{d:"M4 5h16v11H10l-5 4v-4H4zM8 9h8M8 12h5"}];
function botonCharla(nombre,p){const b=el("button","verCharla"),s=el("span","ico");s.setAttribute("aria-hidden","true");s.appendChild(dibujo(CHARLA_ICONO));b.appendChild(s);b.appendChild(document.createTextNode("Ver conversación"));b.type="button";b.onclick=()=>abrirCharla(nombre,b,p);return b}
// de dónde sale la conversación de lo que se está pintando: la oficina local, o la máquina del sitio que se pinta ahora
let fuenteCharla=null,maquinaDelDetalle=null;
const fuenteLocal=()=>LIVE?{fuente:"local",token:LIVE.token}:SOURCE==="site"?{fuente:"site",maquina:maquinaDelDetalle}:{fuente:SOURCE};
function pintarFicha(a,box,abiertos){const dl=el("dl");
  ficha(a).forEach(r=>{const dd=el("dd");if(r.pct!=null){const b=el("span","pbar"),i=el("i");i.style.width=r.pct+"%";b.appendChild(i);dd.appendChild(b);dd.appendChild(document.createTextNode(" "))}
    if(r.k==="Trabajo"&&!abiertos){dd.className="una-linea";dd.title=r.v}dd.appendChild(document.createTextNode(r.v));if(r.dif){const x=el("em",r.cls||null," · "+r.dif);dd.appendChild(x)}dl.appendChild(el("dt",null,r.k));dl.appendChild(dd)});box.appendChild(dl);
  if(a.pasos&&a.pasos.length){const d=el("details","pasos");d.open=abiertos;d.appendChild(el("summary",null,"Pasos de la ejecución"));const ol=el("ol","steps");let now=false;
    a.pasos.forEach(p=>{const cur=!p.done&&!now;if(cur)now=true;const li=el("li",p.done?"done":cur?"now":"");li.appendChild(el("span",null,p.done?"✓":cur?"▸":"·"));li.appendChild(document.createTextNode(p.name));ol.appendChild(li)});d.appendChild(ol);box.appendChild(d)}
  // la conversación se pide a la oficina abierta en esta máquina, o al sitio; en la foto fija y en la demo no hay de dónde
  const p={...(fuenteCharla||fuenteLocal()),nombre:a.nombre};
  if(a.nombre&&pedidoDeCharla(p))box.appendChild(botonCharla(a.nombre,p))}
function etiquetaComo(como){const e=el("span","como-chip");e.appendChild(iconoComo(como));e.appendChild(document.createTextNode(como));return e}
// ---------- la conversación: se pide sólo al abrir su ventana, y nunca viaja en la foto ----------
let charlaDe=null,charlaVuelve=null,ultimoPedido=0;
const ALCANCE=SOURCE==="site"?"Llegan de la máquina al sitio, que los guarda sólo en su memoria.":"No se guardan en el disco. Si esta máquina está aprobada en el sitio de la organización, se ven también ahí.";
const ventana=()=>document.getElementById("ventana");
// Quién hace una tarjeta, si es una sesión de esta oficina. Una fila del tablero puede nombrar a más de una persona: cuenta la primera.
function sesionDeTarjeta(i){const q=String(i.quien||"").trim(),primera=q.split(/[\s,]+/)[0];return agents.find(a=>a.nombre===q)||agents.find(a=>a.nombre===primera)||null;}
// El detalle de una tarjeta del kanban, en la misma ventana que la conversación: su título entero, lo que sabe la tarjeta y, si la hace una sesión, su ficha.
function abrirTarjeta(i,card){const v=ventana(),box=v.firstElementChild,a=sesionDeTarjeta(i);charlaDe=null;ultimoPedido+=1;charlaVuelve=card;v.hidden=false;box.classList.add("detalle");box.setAttribute("aria-label","Detalle de la tarjeta");document.documentElement.classList.add("con-ventana");
  const cerrar=el("button","cerrar","Cerrar");cerrar.type="button";cerrar.onclick=cerrarCharla;box.replaceChildren(el("h3",null,i.titulo||"Sin título"));
  const dl=el("dl"),fila=(k,x)=>{if(x==null||x==="")return;const dd=el("dd");dd.append(x);dl.append(el("dt",null,k),dd);};
  fila("Quién",i.quien);if(!a||String(i.hora||"")!==String((finTxt(a)||{}).hora||""))fila("Cuándo",i.hora);if(!a||i.espera!==a.espera)fila("Espera",i.espera);fila("Marca",i.marca);fila("Motivo",i.motivo);fila("Nota",i.nota);fila("Grupo",i.grupo);
  // el enlace sólo lleva a estos dos sitios: de los datos sale la ruta, nunca la dirección entera
  if(i.pedido){const texto="Pedido "+i.pedido.numero,base=i.pedido.sitio==="github"?"https://github.com/":i.pedido.sitio==="azure"?"https://dev.azure.com/":null;if(base&&i.pedido.ruta){const l=el("a",null,texto);l.href=base+i.pedido.ruta;l.target="_blank";l.rel="noopener";fila("Pedido",l);}else fila("Pedido",texto);}
  if(dl.children.length)box.append(dl);
  if(a){const s=AST[a.estado]||[a.estado||"","#999"],chips=el("div","chips"),st=el("span","chip","● "+s[0]);st.style.setProperty("--c",s[1]);chips.append(st);if(a.comoTrabaja&&a.comoTrabaja!==s[0])chips.append(etiquetaComo(a.comoTrabaja));box.append(chips);pintarFicha(a,box,true);}
  box.append(cerrar);cerrar.focus();}
function abrirCharla(nombre,boton,p=null){const v=ventana(),box=v.firstElementChild;box.classList.remove("detalle");box.setAttribute("aria-label","Conversación");charlaDe=nombre;if(!v.contains(boton))charlaVuelve=boton;v.hidden=false;document.documentElement.classList.add("con-ventana");
  const cerrar=el("button","cerrar","Cerrar");cerrar.type="button";cerrar.onclick=cerrarCharla;box.replaceChildren(el("h3",null,"Conversación de "+nombre),el("p","m","Leyendo…"),cerrar);cerrar.focus();
  const yo=++ultimoPedido,pedido=p||{...fuenteLocal(),nombre},deSitio=pedido.fuente==="site";
  // lo que falla queda en la consola: en la ventana, la persona ve sólo que no se pudo leer
  fetch(pedidoDeCharla(pedido),{credentials:"same-origin"}).then(r=>{const que=charlaSegunRespuesta(r.status);if(que==="vacia")return {vacia:true,deSitio};if(que!=="datos")throw new Error("respondió "+r.status);return r.json().then(datos=>{if(!charlaConForma(datos))throw new Error("una conversación sin su forma");return {datos}})}).catch(e=>{console.warn("conversación de "+nombre+": "+(e&&e.message));return {falla:true}}).then(c=>{if(yo!==ultimoPedido||charlaDe!==nombre)return;try{pintarCharla(box,nombre,c,cerrar)}catch(e){console.warn("conversación de "+nombre+": "+(e&&e.message));pintarCharla(box,nombre,{falla:true},cerrar)}});}
function cerrarCharla(){const v=ventana();if(v.hidden)return;v.hidden=true;document.documentElement.classList.remove("con-ventana");v.firstElementChild.classList.remove("detalle");v.firstElementChild.replaceChildren();charlaDe=null;ultimoPedido+=1;if(charlaVuelve&&charlaVuelve.isConnected)charlaVuelve.focus({preventScroll:true});charlaVuelve=null}
document.addEventListener("keydown",e=>{if(e.key==="Escape")cerrarCharla()});
// El formato simple de un mensaje: negritas, código y listas. Todo se arma con nodos y textContent, así que lo que traiga
// el mensaje nunca llega a ser HTML.
function enLinea(padre,texto){for(const p of String(texto).split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/)){if(!p)continue;
  if(p.startsWith("**")&&p.endsWith("**")&&p.length>4){const e=document.createElement("strong");e.textContent=p.slice(2,-2);padre.append(e)}
  else if(p.startsWith("`")&&p.endsWith("`")&&p.length>2){const e=document.createElement("code");e.textContent=p.slice(1,-1);padre.append(e)}
  else padre.append(document.createTextNode(p))}}
function formatear(texto){const out=[];let lista=null,codigo=null;
  for(const linea of String(texto).split("\n")){
    if(/^\s*```/.test(linea)){if(codigo){codigo=null}else{const pre=document.createElement("pre");codigo=document.createElement("code");pre.append(codigo);out.push(pre);lista=null}continue}
    if(codigo){codigo.textContent+=(codigo.textContent?"\n":"")+linea;continue}
    const it=/^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(linea);
    if(it){const tipo=it[2]?"OL":"UL";if(!lista||lista.tagName!==tipo){lista=document.createElement(tipo);out.push(lista)}const li=document.createElement("li");enLinea(li,it[3]);lista.append(li);continue}
    lista=null;const limpia=linea.replace(/^\s*#{1,6}\s+/,"");if(!limpia.trim())continue;
    const p=document.createElement("p");if(limpia!==linea){const f=document.createElement("strong");f.textContent=limpia.replace(/\*\*/g,"");p.append(f)}else enLinea(p,linea);out.push(p)}
  return out}
function msg(quien,cuando,texto,mio){const box=document.createElement("div");box.className="msg"+(mio?" mio":"");const b=document.createElement("b"),t=Number(cuando),hh=Number.isFinite(t)&&t>0?new Date(t):null;b.textContent=quien+(hh?" · "+String(hh.getHours()).padStart(2,"0")+":"+String(hh.getMinutes()).padStart(2,"0"):"");box.append(b,...formatear(texto));return box}
// Abre como un chat: cada conversación en lo último, dentro de su caja.
function listaCharla(filas,vacio){if(!filas.length)return el("p","m",vacio);const ch=el("div","chat");filas.forEach(f=>ch.append(f));return ch}
// Las dos conversaciones de la coordinadora, de a una y con todo el alto: abre en la primera. La otra arranca en lo último al mostrarse.
function pestanasCharla(partes){const tabs=el("div","seg pestanas"),paneles=[];tabs.setAttribute("role","radiogroup");tabs.setAttribute("aria-label","Con quién");
  partes.forEach(([titulo,lista],i)=>{const l=document.createElement("label"),r=document.createElement("input"),p=el("div","pestana");r.type="radio";r.name="charlaCon";r.checked=i===0;p.hidden=i>0;p.append(lista);paneles.push(p);
    r.onchange=()=>{paneles.forEach((x,j)=>{x.hidden=j!==i});const ch=lista.classList.contains("chat")?lista:lista.querySelector(".chat");if(ch&&!ch.dataset.vista){ch.dataset.vista="1";ch.scrollTop=ch.scrollHeight;}};l.append(r,el("span",null,titulo));tabs.append(l);});
  return [tabs,...paneles]}
// Cuándo fue el último mensaje con una sesión: la hora sola si es de hoy; si no, con el día, como las demás horas de la oficina.
function horaDeSesion(ms){const t=Number(ms);if(!Number.isFinite(t)||t<=0)return "";const d=new Date(t),h=String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");return d.toDateString()===new Date().toDateString()?h:DAYS[d.getDay()]+" "+h;}
// La conversación con cada sesión, de a una: una fila de botones, la que habló último primero, y sus mensajes abajo. Ya está toda leída: elegir otra no vuelve a leer.
const SESIONES_A_LA_VISTA=8;
function charlaPorSesion(nombre,sesiones,vacio){if(!sesiones.length)return listaCharla([],vacio);
  const box=el("div","porSesion"),fila=el("div","quienes");fila.setAttribute("role","group");fila.setAttribute("aria-label","Con qué sesión");
  let actual=null;
  const boton=s=>{const b=el("button",null,s.sesion);b.type="button";b.setAttribute("aria-pressed","false");b.append(el("small",null,horaDeSesion(s.at)));b.onclick=()=>elegir(s,b);return b;},
    elegir=(s,b)=>{if(actual)actual.setAttribute("aria-pressed","false");b.setAttribute("aria-pressed","true");actual=b;const ch=listaCharla(s.mensajes.map(m=>msg(m.de,m.at,m.texto,m.de===nombre)),vacio);box.replaceChildren(fila,ch);ch.scrollTop=ch.scrollHeight;};
  const botones=sesiones.slice(0,SESIONES_A_LA_VISTA).map(boton);fila.append(...botones);
  const resto=sesiones.slice(SESIONES_A_LA_VISTA);
  if(resto.length){const mas=el("button","mas","Las otras "+resto.length);mas.type="button";mas.onclick=()=>{const nuevos=resto.map(boton);mas.replaceWith(...nuevos);nuevos[0].focus();};fila.append(mas);}
  elegir(sesiones[0],botones[0]);return box;}
function pintarCharla(box,nombre,c,cerrar){const fin=x=>{box.insertBefore(x,cerrar)},seccion=(titulo,filas,vacio)=>{fin(el("h4",null,titulo));if(!filas.length){fin(el("p","m",vacio));return}const ch=el("div","chat");filas.forEach(f=>ch.append(f));fin(ch)};
  const leyendo=box.querySelector("p.m");if(leyendo)leyendo.remove();
  // en el sitio, un 404 es que todavía no llegó; en la oficina local, que la sesión ya no está
  if(c.vacia){fin(el("p","m",c.deSitio?"La conversación de esta sesión todavía no llegó al sitio.":"Esta sesión ya no está en la oficina."));return}
  if(c.falla){fin(el("p","m","No se pudo leer la conversación de esta sesión."));return}
  const d=c.datos||{};if(d.sinCoordinadora){fin(el("p","m","Esta máquina no tiene coordinadora designada: no hay con quién cruzar los mensajes."));return}
  const alFinal=()=>box.querySelectorAll(".chat").forEach(ch=>{ch.scrollTop=ch.scrollHeight});
  if(d.conVos){pestanasCharla([["Con vos",listaCharla(d.conVos.map(m=>msg(m.quien==="vos"?"Vos":nombre,m.at,m.texto,m.quien==="vos")),"No hay mensajes con vos en lo último de su conversación.")],
      ["Con las sesiones",charlaPorSesion(nombre,d.conSesiones||[],"No hay mensajes con las sesiones en lo último de su conversación.")]]).forEach(fin);
    fin(el("p","m","Tus últimos 20 mensajes con sus respuestas, y los últimos 10 con cada sesión, en orden; primero la que habló último. "+ALCANCE+" Las contraseñas y las claves se tapan."));alFinal();return}
  const filas=(d.conCoordinadora||[]).map(m=>msg(m.propio?nombre:m.de,m.at,m.texto,m.propio));if(d.arranque)filas.unshift(msg("Mensaje de arranque",d.arranque.at,d.arranque.texto,false));
  seccion("Con la coordinadora",filas,"No hay mensajes con la coordinadora en lo último de su conversación.");
  fin(el("p","m","Últimos 10 mensajes. "+ALCANCE));alFinal()}
// sin 3D, la tabla queda abierta y la sala dice por qué
function sinTresD(msg){const o=document.getElementById("ovl");o.textContent=msg;o.hidden=false;const t=document.getElementById("tablewrap");t.hidden=false;t.open=true}
window.tablero={agents:()=>agents,items:()=>items,kanban:()=>DATA.kanban||null,meta:()=>meta,site:()=>SITE,sobres:()=>DATA.sobres||[],live:()=>LIVE,AST,SHIRT,fmt,finTxt,sinTresD,pintarFicha,iconoComo,etiquetaComo,dibujo,AVION_ICONO};
// el reloj de la página (decisión 20): cada minuto compara la hora con la última novedad de cada sesión y marca las
// calladas; sin pid, pasadas las 2 h, la da por inactiva. No consulta nada afuera: mira la hora y los datos que tiene.
const QUIET_DEFAULT=15,DEAD_MS=2*3600000;
function umbral(m){const n=Number(m&&m.quietMin);return Number.isFinite(n)&&n>0?n:QUIET_DEFAULT}
function relojTick(list,now,m){const q=umbral(m)*60000,hh=t=>{const d=new Date(t);return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0")};
  (list||[]).forEach(a=>{if(typeof a.novedadMs!=="number"||a.estado==="inactiva")return;const desde="sin novedades desde las "+hh(a.novedadMs);
    if(a.sinPid&&now-a.novedadMs>DEAD_MS){a.estado="inactiva";a.callada=null;a.haciendo="Inactiva: "+desde+".";return}
    a.callada=a.estado!=="parada"&&now-a.novedadMs>q?desde:null})}
// fin del reloj
// el reloj corre también al abrir y con cada foto nueva: la foto y el minuto siguiente dicen lo mismo de cada sesión
if(!CON_OFICINAS){relojTick(agents,Date.now(),meta);renderTop();renderCrew();
  setInterval(()=>{relojTick(agents,Date.now(),meta);renderCrew();if(window.tablero.refresh)window.tablero.refresh()},60000)}
// la oficina viva: cada foto nueva actualiza en el lugar; si el proceso se cierra, queda la última foto y el aviso
const CERRADA="La oficina se cerró. Corré /office otra vez para verla al día.";
function cerrada(){const o=document.getElementById("ovl");o.textContent=CERRADA;o.hidden=false;const fl=document.getElementById("freeLine");fl.textContent=CERRADA;fl.hidden=false}
if(LIVE){const ws=new WebSocket("ws://"+location.host+"/live?t="+encodeURIComponent(LIVE.token));
  ws.onmessage=ev=>{const o=document.getElementById("ovl"),FALLA="No pude dibujar la última novedad; la oficina muestra la anterior. Corré /office otra vez si sigue así.";try{const m=JSON.parse(ev.data);if(!m||m.type!=="foto")return;setData(m.data);relojTick(agents,Date.now(),meta);renderTop();renderCrew();if(o.textContent===FALLA){o.textContent="";o.hidden=true}if(window.tablero.refresh)window.tablero.refresh()}catch(e){console.error(e);o.textContent=FALLA;o.hidden=false}};
  ws.onclose=cerrada;}
if(!CON_OFICINAS)setTimeout(()=>{if(!window.tablero.started)sinTresD("Este navegador no pudo cargar la oficina en 3D; las tarjetas y la tabla tienen lo mismo.")},8000);
document.getElementById("ventana").addEventListener("click",e=>{if(e.target===e.currentTarget)cerrarCharla()});
// la sala en 3D: una por oficina, cada una con su lugar en la página y sus datos
let LIB_3D=null;
const cargarTresD=()=>LIB_3D??=Promise.all([import("three"),import("three/addons/controls/OrbitControls.js"),import("three/addons/geometries/RoundedBoxGeometry.js"),import("three/addons/postprocessing/EffectComposer.js"),import("three/addons/postprocessing/RenderPass.js"),import("three/addons/postprocessing/UnrealBloomPass.js"),import("three/addons/postprocessing/OutputPass.js")]);
function armarSala(stage,T){cargarTresD().then(([THREE,{OrbitControls},{RoundedBoxGeometry},{EffectComposer},{RenderPass},{UnrealBloomPass},{OutputPass}])=>{
if(T.cancelada)return;
const labelsEl=stage.querySelector(".labels"),panel=stage.querySelector(".panel3"),ovl=stage.querySelector(".ovl");
T.started=true;
function aviso(t){ovl.textContent=t;ovl.hidden=!t}
try{construir()()}catch(e){console.error(e);T.sinTresD("Este navegador no puede mostrar la oficina en 3D; las tarjetas y la tabla tienen lo mismo.")}

function construir(){
// ---------- motor ----------
const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});
// la oficina queda abierta horas: la resolución tiene tope, y las sombras no se recalculan en cada cuadro
renderer.setPixelRatio(Math.min(devicePixelRatio,1.25));
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.shadowMap.autoUpdate=false;renderer.shadowMap.needsUpdate=true;
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.12;renderer.outputColorSpace=THREE.SRGBColorSpace;
stage.prepend(renderer.domElement);
const scene=new THREE.Scene();
const cam=new THREE.OrthographicCamera(-8,8,6,-6,0.1,200);
const TARGET=new THREE.Vector3(5,1.1,5);
cam.position.copy(TARGET).add(new THREE.Vector3(1,0.86,1).multiplyScalar(30));cam.lookAt(TARGET);
const controls=new OrbitControls(cam,renderer.domElement);
controls.target.copy(TARGET);controls.enablePan=false;controls.enableDamping=true;
controls.minAzimuthAngle=Math.PI/4-.45;controls.maxAzimuthAngle=Math.PI/4+.45;
controls.minPolarAngle=.75;controls.maxPolarAngle=1.05;controls.minZoom=.8;controls.maxZoom=2.6;controls.update();

// ---------- utilidades ----------
const geoCache={};
const RB=(w,h,d,r=.05,s=3)=>geoCache[[w,h,d,r,s].join()]??=new RoundedBoxGeometry(w,h,d,s,r);
const M=(color,o={})=>new THREE.MeshStandardMaterial({color,roughness:o.r??.75,metalness:o.m??0,...(o.x||{})});
function add(geo,mat,x,y,z,parent=scene,shadow=true){const m=new THREE.Mesh(geo,mat);m.position.set(x,y,z);m.castShadow=shadow;m.receiveShadow=true;parent.add(m);return m}
function canvasTex(w,h,draw,rep){const c=document.createElement("canvas");c.width=w;c.height=h;const g=c.getContext("2d");draw(g,w,h);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=4;if(rep){t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(...rep)}t.userData={c,g};return t}
let seed=7;const srnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
const FONT="system-ui,-apple-system,'Segoe UI',sans-serif";

// ---------- texturas ----------
const texFloor=canvasTex(512,512,(g,w,h)=>{const rows=8;for(let r=0;r<rows;r++){let x=-srnd()*120;while(x<w){const len=140+srnd()*120,l=52+srnd()*10;g.fillStyle=`hsl(${24+srnd()*6},${48+srnd()*10}%,${l}%)`;g.fillRect(x,r*h/rows,len,h/rows);
  g.strokeStyle="rgba(80,40,20,.12)";for(let k=0;k<5;k++){g.beginPath();const yy=r*h/rows+srnd()*h/rows;g.moveTo(x,yy);g.bezierCurveTo(x+len*.3,yy+4,x+len*.6,yy-4,x+len,yy);g.stroke()}
  g.fillStyle="rgba(60,30,15,.55)";g.fillRect(x,r*h/rows,2,h/rows);x+=len}g.fillStyle="rgba(60,30,15,.5)";g.fillRect(0,r*h/rows,w,2)}},[2.5,2.5]);
const texBrick=canvasTex(512,512,(g,w,h)=>{g.fillStyle="#5a3530";g.fillRect(0,0,w,h);const bh=32,bw=88;for(let r=0;r<h/bh;r++)for(let x=-(r%2)*bw/2;x<w;x+=bw){g.fillStyle=`hsl(${8+srnd()*10},${38+srnd()*14}%,${32+srnd()*10}%)`;g.fillRect(x+3,r*bh+3,bw-6,bh-6);g.fillStyle="rgba(255,255,255,.05)";g.fillRect(x+3,r*bh+3,bw-6,4)}},[3,1.2]);
const texPlaster=canvasTex(256,256,(g,w,h)=>{g.fillStyle="#7a5873";g.fillRect(0,0,w,h);for(let i=0;i<2200;i++){g.fillStyle=`rgba(${srnd()>.5?255:0},${srnd()>.5?220:0},255,.035)`;g.fillRect(srnd()*w,srnd()*h,2,2)}},[3,1]);
const texWains=canvasTex(512,128,(g,w,h)=>{g.fillStyle="#7a4a2c";g.fillRect(0,0,w,h);for(let x=0;x<w;x+=64){g.fillStyle="rgba(0,0,0,.25)";g.fillRect(x,0,3,h);g.fillStyle="rgba(255,220,180,.08)";g.fillRect(x+3,0,2,h)}g.fillStyle="#5a321c";g.fillRect(0,0,w,10)},[4,1]);
const texRug=canvasTex(512,440,(g,w,h)=>{g.fillStyle="#5a3a63";g.fillRect(0,0,w,h);g.strokeStyle="#d9b98a";g.lineWidth=10;g.strokeRect(18,18,w-36,h-36);g.fillStyle="#8a3d4f";g.fillRect(34,34,w-68,h-68);g.strokeStyle="#c98b5a";g.lineWidth=4;g.strokeRect(48,48,w-96,h-96);
  for(let x=60;x<w-60;x+=26){g.fillStyle="#d9b98a";g.beginPath();g.arc(x,40,5,0,7);g.arc(x,h-40,5,0,7);g.fill();}
  g.save();g.translate(w/2,h/2);for(let k=0;k<4;k++){g.rotate(Math.PI/2);g.fillStyle="#6b4a7a";g.beginPath();g.ellipse(0,-70,38,70,0,0,7);g.fill();}g.fillStyle="#d9b98a";g.beginPath();g.arc(0,0,46,0,7);g.fill();g.fillStyle="#5a3a63";g.beginPath();g.arc(0,0,30,0,7);g.fill();g.restore();
  for(let i=0;i<3000;i++){g.fillStyle=`rgba(0,0,0,${srnd()*.08})`;g.fillRect(srnd()*w,srnd()*h,2,2);}});
const texCity=canvasTex(512,300,(g,w,h)=>{const s=g.createLinearGradient(0,0,0,h);s.addColorStop(0,"#5b3c8f");s.addColorStop(.45,"#e0708a");s.addColorStop(.8,"#ffb36b");g.fillStyle=s;g.fillRect(0,0,w,h);
  g.fillStyle="#ffd28a";g.beginPath();g.arc(w*.62,h*.72,34,0,7);g.fill();
  let x=0;while(x<w){const bw=30+srnd()*50,bh=70+srnd()*150;g.fillStyle=`hsl(${265+srnd()*15},30%,${16+srnd()*8}%)`;g.fillRect(x,h-bh,bw,bh);for(let yy=h-bh+8;yy<h-6;yy+=12)for(let xx=x+5;xx<x+bw-6;xx+=9)if(srnd()>.55){g.fillStyle=srnd()>.3?"#ffcf6e":"#ff9f5a";g.fillRect(xx,yy,4,6)}x+=bw+2}});
const texCork=canvasTex(256,160,(g,w,h)=>{g.fillStyle="#b0804e";g.fillRect(0,0,w,h);for(let i=0;i<900;i++){g.fillStyle=`rgba(70,40,20,${srnd()*.4})`;g.fillRect(srnd()*w,srnd()*h,2,2)}const cs=["#ffe066","#ff9ec7","#8fe3b0","#9cc7ff"];for(let i=0;i<6;i++){g.save();g.translate(30+i%3*75,35+Math.floor(i/3)*70);g.rotate((srnd()-.5)*.3);g.fillStyle=cs[i%4];g.fillRect(-24,-22,48,44);g.fillStyle="rgba(0,0,0,.25)";for(let l=0;l<3;l++)g.fillRect(-16,-10+l*9,32,2);g.fillStyle="#d33";g.beginPath();g.arc(0,-18,3,0,7);g.fill();g.restore()}});
// el cartel: el nombre de la organización, grande; «Agentes de IA», chico
const texSign=canvasTex(1024,300,()=>{});
function drawSign(){const {g}=texSign.userData,w=1024,h=300;g.clearRect(0,0,w,h);g.fillStyle="#1d1030";g.beginPath();g.roundRect(6,6,w-12,h-12,36);g.fill();g.strokeStyle="#b67bff";g.lineWidth=8;g.shadowColor="#c58cff";g.shadowBlur=30;g.stroke();g.shadowBlur=0;
  g.save();g.translate(150,155);g.strokeStyle="#c9a2ff";g.lineWidth=10;g.beginPath();g.roundRect(-70,-50,140,110,26);g.stroke();g.beginPath();g.moveTo(0,-50);g.lineTo(0,-85);g.stroke();g.beginPath();g.arc(0,-92,9,0,7);g.stroke();g.fillStyle="#e9d6ff";g.beginPath();g.arc(-30,0,13,0,7);g.arc(30,0,13,0,7);g.fill();g.fillRect(-28,30,56,8);g.restore();
  g.shadowColor="#c58cff";g.shadowBlur=24;g.fillStyle="#f1e4ff";g.font="700 140px "+FONT;g.fillText("TYCON",290,165);g.shadowBlur=0;g.font="600 52px "+FONT;g.fillStyle="#c79cff";g.fillText("Agentes de IA",296,240);texSign.needsUpdate=true;}
drawSign();
// el panel de la pared: lo pendiente de esta máquina
const texPanel=canvasTex(768,640,()=>{});
// las columnas del kanban, con sus colores; lo que quedó a medio camino se cuenta aparte
const KCOL={firma:"#ffb04d",curso:"#6cb6ff",entrando:"#c4bdf0",sinEmpezar:"#9aa3a0",hechos:"#3ddc84"},HALF="#ff6b80";
const stampOf=(k,meta)=>k&&k.escrito||"Al día a las "+meta.actualizado;
// El orden del panel de la pared y de su detalle: primero lo que se está trabajando.
function paredEnOrden(K){const cols=(K&&K.columnas)||[];return ["firma","curso","entrando","medio","sinEmpezar","hechos"].map(id=>{if(id==="medio")return {id,nombre:"A medio camino",tarjetas:(K&&K.medioCamino)||[],color:HALF};const c=cols.find(x=>x.id===id);return c&&{id,nombre:c.nombre,tarjetas:c.tarjetas||[],color:KCOL[id]||"#9aa3a0"};}).filter(Boolean);}
function drawPanel(){const {g}=texPanel.userData,w=768,h=640,k=T.kanban(),meta=T.meta();g.clearRect(0,0,w,h);g.fillStyle="#0e1220";g.beginPath();g.roundRect(4,4,w-8,h-8,26);g.fill();g.strokeStyle="#4a5a8a";g.lineWidth=8;g.stroke();
  g.fillStyle="#ffffff";g.font="800 64px "+FONT;g.fillText("Pendientes",36,76);
  const toca=(meta&&meta.teToca)||[];g.fillStyle="#ffb04d";g.font="800 46px "+FONT;g.textAlign="right";g.fillText("Te toca: "+toca.length,w-36,72);g.textAlign="left";
  const stats=paredEnOrden(k).map(c=>[c.nombre,c.tarjetas.length,c.color]);
  stats.forEach(([l,n,c],i)=>{const x=36+(i%2)*356,y=96+Math.floor(i/2)*156;g.fillStyle="#1b2236";g.beginPath();g.roundRect(x,y,340,128,18);g.fill();g.fillStyle=c;g.fillRect(x,y,12,128);
    g.font="800 84px "+FONT;g.fillText(String(n),x+30,y+82);g.fillStyle="#ffffff";g.font="700 32px "+FONT;g.fillText(l,x+30,y+116);});
  g.fillStyle="#dfe6ff";g.font="600 26px "+FONT;g.textAlign="right";g.fillText("tocá para ver el detalle",w-36,612);g.textAlign="left";
  if(meta&&meta.actualizado){g.fillStyle="#9fb0d8";g.font="600 26px "+FONT;g.fillText(stampOf(k,meta),36,612);}texPanel.needsUpdate=true;}

// ---------- habitación ----------
const S=10,WH=4.2;
add(RB(S+1.0,.7,S+1.0,.28,4),M("#e8cdb6",{r:.6}),S/2-.2,-.36,S/2-.2);
add(RB(S+.7,.4,S+.7,.16,4),M("#8a5a3c",{r:.6}),S/2-.2,-.215,S/2-.2);
const floor=add(new THREE.PlaneGeometry(S,S),M("#ffffff",{r:.55,x:{map:texFloor}}),S/2,.001,S/2,scene,false);floor.rotation.x=-Math.PI/2;
add(new THREE.BoxGeometry(.35,WH,S+.35),M("#3b2a3e"),-.175,WH/2,S/2-.175);
const pl=add(new THREE.PlaneGeometry(S,WH-1.25),M("#ffffff",{x:{map:texPlaster}}),.002,1.25+(WH-1.25)/2,S/2,scene,false);pl.rotation.y=Math.PI/2;
const wa=add(new THREE.PlaneGeometry(S,1.25),M("#ffffff",{r:.6,x:{map:texWains}}),.003,.625,S/2,scene,false);wa.rotation.y=Math.PI/2;
add(new THREE.BoxGeometry(.08,.08,S),M("#5a321c"),.04,1.27,S/2);
add(new THREE.BoxGeometry(S,WH,.35),M("#3b2a3e"),S/2,WH/2,-.175);
add(new THREE.PlaneGeometry(S,WH),M("#ffffff",{r:.85,x:{map:texBrick}}),S/2,WH/2,.002,scene,false);
add(RB(.5,.22,S+.5,.1),M("#e8cdb6",{r:.6}),-.2,WH+.08,S/2-.25);
add(RB(S+.25,.22,.5,.1),M("#e8cdb6",{r:.6}),S/2-.12,WH+.08,-.2);
add(new THREE.BoxGeometry(.06,.16,S),M("#4a2a1a"),.03,.08,S/2);add(new THREE.BoxGeometry(S,.16,.06),M("#4a2a1a"),S/2,.08,.03);

// ---------- pared izquierda ----------
function onLeft(mesh,z,y){mesh.position.set(.02,y,z);mesh.rotation.y=Math.PI/2;scene.add(mesh);return mesh}
const win=new THREE.Group();onLeft(win,6.7,2.25);
add(new THREE.BoxGeometry(3.3,2.0,.12),M("#4a2c1c"),0,0,0,win);
add(new THREE.PlaneGeometry(3.0,1.7),new THREE.MeshBasicMaterial({map:texCity}),0,0,.07,win,false);
const blindMat=M("#d8b48a",{r:.6});for(let i=0;i<9;i++){const b=add(new THREE.BoxGeometry(3.0,.07,.03),blindMat,0,.82-i*.1,.1,win);b.rotation.x=-.5;}
add(new THREE.BoxGeometry(3.4,.12,.25),M("#4a2c1c"),0,-1.0,.12,win);add(new THREE.BoxGeometry(.06,1.7,.05),M("#4a2c1c"),0,0,.09,win);
const winLight=new THREE.PointLight("#ff9a6a",14,9,1.6);winLight.position.set(1.4,2.4,6.7);scene.add(winLight);
const cork=new THREE.Group();onLeft(cork,4.6,1.95);add(new THREE.BoxGeometry(1.5,1.0,.06),M("#6a4128"),0,0,0,cork);add(new THREE.PlaneGeometry(1.38,.88),M("#fff",{x:{map:texCork}}),0,0,.035,cork,false);
const notes=new THREE.Group();onLeft(notes,9.0,2.4);["#ffe066","#ff9ec7","#8fe3b0","#ffe066","#9cc7ff","#ffb36b"].forEach((c,i)=>{const n=add(new THREE.BoxGeometry(.32,.32,.015),M(c,{r:.9}),(i%3)*.38-.38,Math.floor(i/3)*-.4+.2,0,notes,false);n.rotation.z=(srnd()-.5)*.25});
const sign=new THREE.Group();onLeft(sign,3.0,3.45);add(RB(3.5,1.05,.12,.08),M("#1d1030"),0,0,0,sign);
const signFace=add(new THREE.PlaneGeometry(3.4,1.0),new THREE.MeshBasicMaterial({map:texSign,transparent:true}),0,0,.07,sign,false);
const signLight=new THREE.PointLight("#a46bff",22,9,1.4);signLight.position.set(1.1,3.3,3.0);scene.add(signLight);
// arcade, con su propia luz para que se vea
const arc=new THREE.Group();arc.position.set(.55,0,9.25);arc.rotation.y=Math.PI/2;scene.add(arc);
add(RB(.85,1.9,.75,.06),M("#5a2a7a",{r:.45,x:{emissive:"#2a0f3a",emissiveIntensity:.8}}),0,.95,0,arc);add(RB(.9,.32,.8,.05),M("#2a1238"),0,1.98,0,arc);
add(new THREE.PlaneGeometry(.72,.24),new THREE.MeshBasicMaterial({color:"#ffd34d",toneMapped:false}),0,1.98,.41,arc,false);
[-.44,.44].forEach(x=>add(new THREE.BoxGeometry(.03,1.8,.03),new THREE.MeshBasicMaterial({color:"#ff5fd2",toneMapped:false}),x,.95,.38,arc,false));
const arcScreen=canvasTex(128,110,(g,w,h)=>{g.fillStyle="#0b0820";g.fillRect(0,0,w,h);g.fillStyle="#d08bff";const inv=["00100000100","00010001000","00111111100","01101110110","11111111111","10111111101","10100000101","00011011000"];inv.forEach((r,y)=>[...r].forEach((c,x)=>{if(c==="1")g.fillRect(20+x*8,22+y*8,7,7)}))});
const as=add(new THREE.PlaneGeometry(.6,.5),new THREE.MeshBasicMaterial({map:arcScreen,toneMapped:false}),0,1.45,.33,arc,false);as.rotation.x=-.25;
add(new THREE.BoxGeometry(.8,.12,.3),M("#2a1238"),0,1.08,.45,arc);[["#ff4d6d",-.2],["#ffd34d",0],["#4dd2ff",.2]].forEach(([c,x])=>add(new THREE.CylinderGeometry(.04,.04,.04,12),M(c,{x:{emissive:c,emissiveIntensity:.9}}),x,1.16,.48,arc));
add(new THREE.CylinderGeometry(.02,.02,.14,8),M("#222"),-.3,1.2,.45,arc);
const arcLight=new THREE.PointLight("#ff6ad5",9,4.5,1.3);arcLight.position.set(1.5,1.7,9.25);scene.add(arcLight);

// ---------- pared del fondo: estantería, lámpara, panel, racks ----------
const shelf=new THREE.Group();shelf.position.set(1.5,0,.3);scene.add(shelf);const wood=M("#7a4a2a",{r:.6});
add(new THREE.BoxGeometry(1.7,.07,.5),wood,0,2.95,0,shelf);[[-0.85],[0.85]].forEach(([x])=>add(new THREE.BoxGeometry(.07,2.95,.5),wood,x,1.475,0,shelf));add(new THREE.BoxGeometry(1.7,2.95,.04),M("#5a341e"),0,1.475,-.23,shelf);
const bookCols=["#c0392b","#2e86de","#f6b93b","#38a169","#8e44ad","#e17055","#00a8a8","#d6a2e8"];
for(let s=0;s<4;s++){const y=.1+s*.72;add(new THREE.BoxGeometry(1.66,.05,.48),wood,0,y,0,shelf);let x=-.78;while(x<.6){const bw=.06+srnd()*.06,bh=.38+srnd()*.2;const b=add(new THREE.BoxGeometry(bw,bh,.32),M(bookCols[Math.floor(srnd()*8)],{r:.8}),x+bw/2,y+.025+bh/2,.02,shelf);if(srnd()>.85)b.rotation.z=.18;x+=bw+.01;}}
function plant(parent,x,y,z,s=1,pot="#c4643c"){const gp=new THREE.Group();gp.position.set(x,y,z);gp.scale.setScalar(s);parent.add(gp);add(new THREE.CylinderGeometry(.2,.15,.32,16),M(pot,{r:.6}),0,.16,0,gp);add(new THREE.CylinderGeometry(.18,.18,.03,16),M("#3b2516"),0,.31,0,gp);
  const lc=["#2f8f4e","#3fae5e","#257a40"];for(let i=0;i<9;i++){const a=i/9*Math.PI*2,r=.1+srnd()*.1;const l=add(new THREE.SphereGeometry(.13+srnd()*.06,10,8),M(lc[i%3],{r:.7}),Math.cos(a)*r,.45+srnd()*.35,Math.sin(a)*r,gp);l.scale.set(1,1.5,.6);l.rotation.set(srnd(),a,srnd()*.6)}return gp}
plant(shelf,.45,2.98,0,.7);plant(shelf,-.5,2.18,.05,.5,"#d9c3a0");
for(let i=0;i<14;i++)add(new THREE.SphereGeometry(.08,8,6),M(i%2?"#2f8f4e":"#3fae5e"),2.15+srnd()*.2,3.0-i*.12,.32+srnd()*.1);
const lamp=new THREE.Group();lamp.position.set(3.05,0,.65);scene.add(lamp);add(new THREE.CylinderGeometry(.22,.26,.06,20),M("#3a2a20",{m:.4,r:.4}),0,.03,0,lamp);add(new THREE.CylinderGeometry(.025,.025,1.9,10),M("#3a2a20",{m:.5,r:.4}),0,.98,0,lamp);
const lampShade=add(new THREE.CylinderGeometry(.22,.38,.42,24,1,true),new THREE.MeshStandardMaterial({color:"#ffd9a0",emissive:"#ffb25a",emissiveIntensity:.75,side:THREE.DoubleSide}),0,2.02,0,lamp,false);
const lampLight=new THREE.PointLight("#ffb367",11,7,1.5);lampLight.position.set(3.05,1.9,.75);scene.add(lampLight);
// la lámpara se prende y se apaga con un click, y cada navegador recuerda cómo la dejó
const lampHit=add(new THREE.CylinderGeometry(.42,.42,2.4,12),new THREE.MeshBasicMaterial({visible:false}),0,1.2,0,lamp,false);
const LAMPARA_KEY="office.lampara";
function lamparaGuardada(){try{return localStorage.getItem(LAMPARA_KEY)!=="apagada"}catch(e){return true}}
function guardarLampara(v){try{localStorage.setItem(LAMPARA_KEY,v?"prendida":"apagada")}catch(e){/* sin dónde guardarla, vale hasta recargar */}}
let lamparaPrendida=true;
function prenderLampara(v){lamparaPrendida=v;lampShade.material.emissiveIntensity=v?.75:0;lampLight.intensity=v?11:0}
function tocarLampara(){prenderLampara(!lamparaPrendida);guardarLampara(lamparaPrendida)}
prenderLampara(lamparaGuardada());
const pnl=new THREE.Group();pnl.position.set(8.0,2.45,.06);scene.add(pnl);add(RB(2.95,2.5,.1,.06),M("#0f121c"),0,0,0,pnl);const pnlFace=add(new THREE.PlaneGeometry(2.82,2.35),new THREE.MeshBasicMaterial({map:texPanel,toneMapped:false}),0,0,.06,pnl,false);
// racks: titilan más rápido cuantas más sesiones están trabajando
const leds=[];function rack(x,z){const g=new THREE.Group();g.position.set(x,0,z);scene.add(g);add(RB(.75,2.05,.7,.04),M("#22252f",{r:.45,m:.3}),0,1.025,0,g);
  for(let u=0;u<9;u++){add(new THREE.BoxGeometry(.62,.16,.02),M("#14161d"),0,.25+u*.2,.355,g);for(let k=0;k<3;k++){const m=new THREE.Mesh(new THREE.BoxGeometry(.04,.03,.02),new THREE.MeshBasicMaterial({color:"#3dff7a",toneMapped:false}));m.position.set(.18+k*.06,.25+u*.2,.37);g.add(m);leds.push(m)}}}
rack(8.75,4.3);rack(9.55,4.3);plant(scene,9.45,0,2.35,1.1);

// ---------- centro: alfombra, mesita, sofá ----------
const rug=add(new THREE.PlaneGeometry(4.0,3.6),M("#fff",{r:.95,x:{map:texRug}}),5.6,.012,5.4,scene,false);rug.rotation.x=-Math.PI/2;
const tbl=new THREE.Group();tbl.position.set(6.2,0,5.6);scene.add(tbl);add(new THREE.CylinderGeometry(.55,.55,.07,32),M("#7a4426",{r:.45}),0,.62,0,tbl);add(new THREE.CylinderGeometry(.07,.09,.58,12),M("#5a321c"),0,.31,0,tbl);add(new THREE.CylinderGeometry(.3,.34,.05,24),M("#5a321c"),0,.03,0,tbl);
function mug(parent,x,y,z,c="#f2ede4"){const g=new THREE.Group();g.position.set(x,y,z);parent.add(g);add(new THREE.CylinderGeometry(.09,.08,.17,16),M(c,{r:.4}),0,.085,0,g);add(new THREE.TorusGeometry(.05,.015,8,16),M(c,{r:.4}),.1,.09,0,g);add(new THREE.CylinderGeometry(.075,.075,.01,16),M("#4a2a14"),0,.16,0,g,false);return g}
mug(tbl,0,.655,0);
[["#2e86de",.0],["#f6b93b",.06],["#c0392b",.12]].forEach(([c,y],i)=>add(RB(.34,.06,.26,.01),M(c),.25,.68+y,.12,tbl).rotation.y=i*.2);
const steam=[];for(let i=0;i<6;i++){const s=new THREE.Mesh(new THREE.SphereGeometry(.05,8,6),new THREE.MeshBasicMaterial({color:"#ffffff",transparent:true,opacity:.35,depthWrite:false}));scene.add(s);steam.push({m:s,ph:i/6});}
// el sofá, contra la pared del fondo para no tapar a nadie
const sofa=new THREE.Group();sofa.position.set(5.6,0,4.0);sofa.rotation.y=Math.PI;scene.add(sofa);const lea=M("#7b3f22",{r:.38,m:.05}),lea2=M("#8d4a28",{r:.35,m:.05});
add(RB(2.5,.42,.95,.12),lea,0,.33,0,sofa);add(RB(2.5,.85,.3,.14),lea,0,.75,.38,sofa);[-1.2,1.2].forEach(x=>add(RB(.3,.62,.95,.13),lea,x,.55,0,sofa));[-.55,.55].forEach(x=>{add(RB(1.05,.16,.7,.08),lea2,x,.62,-.08,sofa);add(RB(1.0,.5,.16,.08),lea2,x,.98,.2,sofa)});
[[-1.15,-.4],[1.15,-.4],[-1.15,.4],[1.15,.4]].forEach(([x,z])=>add(new THREE.CylinderGeometry(.04,.03,.12,8),M("#2a1a10"),x,.06,z,sofa));
plant(scene,1.0,0,9.6,1.1);plant(scene,9.4,0,9.4,1.2,"#b8573a");

// ---------- puestos y personajes ----------
const woodDesk=M("#e4c79c",{r:.55}),woodDesk2=M("#cfae80",{r:.6}),beige=M("#e6dcc4",{r:.5}),beige2=M("#d3c7ab",{r:.55});
// los lugares los manda office.js según cuántas sesiones haya (hasta 10); la sesión de orden N ocupa el lugar N
const FIVE=[[5.6,1.45,0],[1.95,3.1,Math.PI/2],[8.75,6.9,Math.PI/2],[1.95,7.0,Math.PI/2],[5.3,8.55,0]];
const puestos=()=>{const m=T.meta();return m&&Array.isArray(m.puestos)&&m.puestos.length?m.puestos:FIVE};
const LOOKS=[{pelo:"short",pelocol:"#2b1a10",piel:"#f0c39d"},{pelo:"cap",gorra:"#2e4a86",piel:"#c98f66"},{pelo:"curly",pelocol:"#1c140f",piel:"#8d5a3b",lentes:true},{pelo:"afro",pelocol:"#1c140f",piel:"#a8714b"},{pelo:"short",pelocol:"#7a3b1f",piel:"#e0b08a",barba:true}];
function crearPuesto(agent,i,slot){
  const [x,z,rot]=slot,look=LOOKS[i%LOOKS.length],ropa=T.SHIRT[i%T.SHIRT.length];
  const st=new THREE.Group();st.position.set(x,0,z);st.rotation.y=rot;scene.add(st);
  add(RB(2.1,.09,.95,.03),woodDesk,0,.78,-.68,st);
  add(RB(.55,.72,.85,.03),woodDesk2,.72,.37,-.68,st);[.2,.42,.63].forEach(y=>{add(new THREE.BoxGeometry(.5,.005,.01),M("#9b7a52"),.72,y+.08,-.25,st,false);add(new THREE.BoxGeometry(.16,.03,.03),M("#6a4a2a",{m:.4}),.72,y-.02,-.24,st)});
  add(new THREE.BoxGeometry(.06,.72,.85),woodDesk2,-1.0,.37,-.68,st);add(new THREE.BoxGeometry(1.4,.4,.03),woodDesk2,-.3,.55,-1.1,st);
  const crt=new THREE.Group();crt.position.set(-.15,.83,-.82);st.add(crt);
  add(RB(.66,.56,.42,.06),beige,0,.34,.05,crt);add(RB(.5,.44,.35,.08),beige2,0,.32,-.28,crt);add(RB(.34,.06,.3,.02),beige2,0,.03,-.05,crt);add(new THREE.BoxGeometry(.14,.06,.14),beige2,0,.08,-.05,crt);
  const scr=canvasTex(160,120,()=>{});add(new THREE.PlaneGeometry(.52,.4),new THREE.MeshBasicMaterial({map:scr,toneMapped:false}),0,.35,.265,crt,false);
  add(new THREE.BoxGeometry(.04,.02,.01),M("#3ddc84",{x:{emissive:"#3ddc84",emissiveIntensity:1}}),.24,.1,.265,crt,false);
  add(RB(.62,.04,.2,.015),beige,-.15,.845,-.38,st);for(let r=0;r<3;r++)add(new THREE.BoxGeometry(.54,.012,.04),beige2,-.15,.87,-.44+r*.055,st,false);
  add(RB(.08,.035,.12,.015),beige,.3,.84,-.38,st);add(new THREE.BoxGeometry(.2,.005,.22),M("#3a4466"),.3,.825,-.38,st,false);
  mug(st,.62,.825,-.85,["#f2ede4","#3d6fb6","#e8b04a","#d9534f","#7b4fc2"][i%5]);
  if(i%2===0)plant(st,-.85,.825,-.85,.45);else{add(new THREE.CylinderGeometry(.06,.06,.14,12),M("#4a5a7a"),-.85,.895,-.85,st);[["#e74c3c",-.02],["#f1c40f",.02],["#2e86de",0]].forEach(([c,dx])=>{const p=add(new THREE.CylinderGeometry(.008,.008,.2,6),M(c),-.85+dx,.98,-.85+dx,st);p.rotation.z=dx*4});}
  add(new THREE.BoxGeometry(.24,.02,.32),M("#f4f1ea"),.35,.835,-.75,st,false);
  const chair=new THREE.Group();chair.position.set(0,0,.18);st.add(chair);const cm=M("#3b3550",{r:.6});
  add(RB(.62,.1,.58,.05),cm,0,.5,0,chair);add(RB(.58,.6,.1,.05),cm,0,.86,.3,chair);add(new THREE.CylinderGeometry(.035,.035,.38,8),M("#222",{m:.6,r:.3}),0,.27,0,chair);
  for(let k=0;k<5;k++){const a=k/5*Math.PI*2;const leg=add(new THREE.BoxGeometry(.05,.04,.32),M("#222",{m:.6,r:.3}),Math.sin(a)*.15,.07,Math.cos(a)*.15,chair);leg.rotation.y=a;add(new THREE.SphereGeometry(.04,8,6),M("#111"),Math.sin(a)*.3,.04,Math.cos(a)*.3,chair);}
  const p=crearPersonaje(look,ropa);p.position.set(0,0,.18);st.add(p);
  // aviso en el piso cuando espera la firma del dueño
  const ring=add(new THREE.RingGeometry(.55,.68,40),new THREE.MeshBasicMaterial({color:"#ffa53d",transparent:true,opacity:.0,toneMapped:false,side:THREE.DoubleSide}),0,.02,.18,st,false);ring.rotation.x=-Math.PI/2;
  const hit=new THREE.Mesh(new THREE.BoxGeometry(1.2,1.8,1.4),new THREE.MeshBasicMaterial({visible:false}));hit.position.set(0,.9,0);st.add(hit);
  return {st,screen:scr,person:p,hit,ring,agent,ropa,anchor:new THREE.Vector3(0,1.85,.18),headP:new THREE.Vector3(0,1.5,.2),t0:i*1.7};
}
function crearPersonaje(a,ropa){
  const g=new THREE.Group(),skin=M(a.piel,{r:.6}),hood=M(ropa,{r:.8}),pants=M("#2d3550",{r:.8}),dark=M("#1c1c24",{r:.5});
  [-.12,.12].forEach(x=>{const th=add(new THREE.CapsuleGeometry(.09,.3,6,10),pants,x,.56,-.12,g);th.rotation.x=Math.PI/2;add(new THREE.CapsuleGeometry(.08,.3,6,10),pants,x,.32,-.33,g);add(RB(.13,.08,.22,.03),M("#f0f0f0"),x,.06,-.38,g)});
  const up=new THREE.Group();up.position.set(0,.55,.02);g.add(up);
  const torso=add(new THREE.CapsuleGeometry(.24,.28,8,16),hood,0,.33,0,up);torso.scale.set(1,1,.82);
  add(new THREE.TorusGeometry(.17,.06,8,20),hood,0,.6,.06,up).rotation.x=Math.PI/2.4;
  add(new THREE.CylinderGeometry(.09,.1,.1,12),skin,0,.66,0,up);
  const head=new THREE.Group();head.position.set(0,.93,-.02);up.add(head);
  add(new THREE.SphereGeometry(.28,24,18),skin,0,0,0,head);[-.27,.27].forEach(x=>add(new THREE.SphereGeometry(.06,10,8),skin,x,-.02,0,head));
  const hc=M(a.pelocol||"#1c140f",{r:.85});
  if(a.pelo==="cap"){add(new THREE.SphereGeometry(.295,24,14,0,Math.PI*2,0,Math.PI/2),M(a.gorra,{r:.7}),0,.02,0,head);const brim=add(new THREE.CylinderGeometry(.2,.2,.03,20,1,false,0,Math.PI),M(a.gorra,{r:.7}),0,.04,-.24,head);brim.rotation.y=Math.PI/2;add(new THREE.SphereGeometry(.035,8,6),M(a.gorra),0,.31,0,head)}
  else if(a.pelo==="curly"){for(let i=0;i<26;i++){const th=srnd()*Math.PI*2,ph=srnd()*1.15;add(new THREE.SphereGeometry(.075,8,6),hc,Math.sin(ph)*Math.cos(th)*.28,Math.cos(ph)*.28+.02,Math.sin(ph)*Math.sin(th)*.28+.03,head)}}
  else if(a.pelo==="afro"){const af=add(new THREE.SphereGeometry(.36,20,14),hc,0,.1,.06,head);af.scale.set(1,.9,1)}
  else{add(new THREE.SphereGeometry(.3,20,12,0,Math.PI*2,0,Math.PI*.55),hc,0,.03,.02,head)}
  if(a.barba){const b=add(new THREE.SphereGeometry(.27,18,12,0,Math.PI*2,Math.PI*.55,Math.PI*.4),hc,0,-.02,-.02,head);b.scale.set(1.02,1,1.02)}
  if(a.lentes)[-.1,.1].forEach(x=>{const r=add(new THREE.TorusGeometry(.065,.012,6,16),M("#1a1a1a"),x,.02,-.27,head);r.rotation.y=0});
  const hpm=M("#2a2a33",{r:.4,m:.2});add(new THREE.TorusGeometry(.31,.03,8,24,Math.PI),hpm,0,.02,0,head);
  [-.3,.3].forEach(x=>{const c=add(new THREE.CylinderGeometry(.1,.1,.08,16),hpm,x,0,0,head);c.rotation.z=Math.PI/2;add(new THREE.CylinderGeometry(.07,.07,.085,16),M(ropa,{r:.5}),x*1.03,0,0,head).rotation.z=Math.PI/2});
  [-.09,.09].forEach(x=>add(new THREE.SphereGeometry(.03,8,6),dark,x,.02,-.26,head));add(new THREE.SphereGeometry(.04,8,6),skin,0,-.05,-.28,head);
  const arms=[-1,1].map(s=>{const pv=new THREE.Group();pv.position.set(s*.27,.52,0);up.add(pv);add(new THREE.CapsuleGeometry(.075,.3,6,10),hood,0,-.2,0,pv);add(new THREE.SphereGeometry(.07,10,8),skin,0,-.43,0,pv);return pv});
  g.userData={up,head,arms};return g;
}

// la pantalla de cada puesto cuenta su estado
function drawScreen(d,t){const {g}=d.screen.userData,w=160,h=120,e=d.agent.estado;
  if(e==="firma"||e==="pregunta"){const on=Math.floor(t*2.5)%2;g.fillStyle=on?"#5a3200":"#7a4600";g.fillRect(0,0,w,h);g.strokeStyle="#ffd08a";g.lineWidth=4;g.beginPath();for(let x=26;x<120;x+=4)g.lineTo(x,70+Math.sin(x/7+t*3)*10);g.stroke();g.fillStyle="#ffa53d";g.save();g.translate(126,50);g.rotate(.7);g.fillRect(-4,-22,8,34);g.beginPath();g.moveTo(-4,12);g.lineTo(4,12);g.lineTo(0,20);g.fill();g.restore();g.fillStyle="#ffe2b8";g.font="700 15px monospace";g.fillText("TU FIRMA",40,106);}
  else if(e==="prueba"){g.fillStyle="#0f1a33";g.fillRect(0,0,w,h);const n=Math.floor(t*1.6+d.t0)%6;for(let r=0;r<5;r++){const y=14+r*21;g.strokeStyle="#7fb2ff";g.lineWidth=2;g.strokeRect(14,y,14,14);g.fillStyle="#3a4a70";g.fillRect(38,y+4,70+((r*37)%40),6);if(r<n){g.fillStyle="#3ddc84";g.fillRect(14,y,14,14);g.strokeStyle="#0d2a18";g.lineWidth=3;g.beginPath();g.moveTo(17,y+7);g.lineTo(20,y+11);g.lineTo(26,y+3);g.stroke();}}}
  else if(e==="espera"){g.fillStyle="#141226";g.fillRect(0,0,w,h);const r=(t*.5)%1;g.save();g.translate(80,60);g.rotate(r>.85?(r-.85)/.15*Math.PI:0);g.strokeStyle="#c9c2ea";g.lineWidth=3;g.beginPath();g.moveTo(-18,-30);g.lineTo(18,-30);g.lineTo(-18,30);g.lineTo(18,30);g.closePath();g.stroke();g.fillStyle="#c9c2ea";const k=Math.min(r/.85,1);g.beginPath();g.moveTo(-14*(1-k),-26+26*k);g.lineTo(14*(1-k),-26+26*k);g.lineTo(0,0);g.fill();g.beginPath();g.moveTo(0,26-24*k);g.lineTo(14*k+2,26);g.lineTo(-14*k-2,26);g.fill();g.restore();}
  else if(e==="coordina"){g.fillStyle="#1f0f22";g.fillRect(0,0,w,h);g.strokeStyle="#ff8fd0";g.lineWidth=2;const B=[[60,10],[12,74],[60,74],[108,74]];B.forEach(([x,y],i)=>{g.globalAlpha=.55+.45*Math.abs(Math.sin(t*2+i));g.strokeRect(x,y,40,24)});g.globalAlpha=1;g.beginPath();g.moveTo(80,34);g.lineTo(80,54);g.moveTo(32,54);g.lineTo(128,54);[32,80,128].forEach(x=>{g.moveTo(x,54);g.lineTo(x,74)});g.stroke();}
  else if(e==="libre"){g.fillStyle="#06070d";g.fillRect(0,0,w,h);g.fillStyle="#5a6a9a";g.font="700 12px monospace";g.fillText("zZ",80+Math.sin(t*.7)*55-8,60+Math.cos(t*.9)*35);}
  else if(e==="parada"){g.fillStyle="#161208";g.fillRect(0,0,w,h);g.fillStyle="#c9b458";g.fillRect(58,36,14,48);g.fillRect(88,36,14,48);g.font="700 14px monospace";g.fillText("PARADA",54,106);}
  else{g.fillStyle="#0e1426";g.fillRect(0,0,w,h);const cols=["#7fe0b0","#7fb2ff","#ffcf6e","#ff8fb1","#c7a2ff"];const off=(t*26+d.t0*40)%12;for(let i=-1;i<11;i++){const yy=10+i*12-off,sl=Math.floor(i+t*26/12+d.t0*3);let x=8+(sl%3)*10;for(let k=0;k<3;k++){const ww=10+((sl*7+k*13)%30);g.fillStyle=cols[(sl+k)%5];g.fillRect(x,yy,ww,5);x+=ww+5;}}if(Math.floor(t*2)%2){g.fillStyle="#fff";g.fillRect(140,104,6,9);}}
  d.screen.needsUpdate=true;}

// el cuerpo según el estado: los brazos siempre sobre el escritorio, salvo para pedir la firma
function animar(d,t){const {up,head,arms}=d.person.userData,e=d.agent.estado,k=t+d.t0;let lean=.12,armL=1.25,armR=1.25,zL=.12,zR=-.12,hy=0,hx=.05;
  if(e==="trabajando"){armL=1.25+Math.sin(k*18)*.08;armR=1.25+Math.sin(k*18+1.7)*.08;hx=.08+Math.sin(k*2)*.03;hy=Math.sin(k*.8)*.08}
  else if(e==="prueba"){armL=1.25+Math.sin(k*6)*.05;armR=1.25;hx=.12;hy=Math.sin(k*1.2)*.05}
  else if(e==="coordina"){armR=2.35;zR=-.55;armL=1.15;hx=-.12;hy=.25+Math.sin(k*.9)*.08;lean=.02}
  else if(e==="espera"){lean=-.2+Math.sin(k*1.4)*.02;armL=armR=1.0;zL=.2;zR=-.2;hx=-.1;hy=Math.sin(k*.5)*.15}
  else if(e==="libre"){lean=-.24;armL=armR=1.0;zL=.2;zR=-.2;hx=.3+Math.sin(k*1.2)*.03}
  else if(e==="parada"){lean=-.16;armL=armR=1.05;zL=.18;zR=-.18;hx=.02;hy=Math.sin(k*.4)*.1}
  else if(e==="firma"||e==="pregunta"){armR=2.9+Math.sin(k*7)*.25;zR=-.25;armL=1.2;lean=-.06;hx=-.15;hy=.45}
  const ease=(o,v)=>o+(v-o)*.15;up.rotation.x=ease(up.rotation.x,-lean);up.scale.y=1+Math.sin(k*2.2)*.012;
  arms[0].rotation.x=ease(arms[0].rotation.x,armL);arms[1].rotation.x=ease(arms[1].rotation.x,armR);arms[0].rotation.z=ease(arms[0].rotation.z,zL);arms[1].rotation.z=ease(arms[1].rotation.z,zR);
  head.rotation.x=ease(head.rotation.x,-hx);head.rotation.y=ease(head.rotation.y,hy);
  d.ring.material.opacity=e==="firma"||e==="pregunta"?.45+.4*Math.sin(t*5):0}

// ---------- etiquetas ----------
let desks=[],sel=null;
const BOT='<svg class="bot" viewBox="0 0 24 24" fill="none" stroke="#c9b6ff" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="4" y="8" width="16" height="11" rx="4"/><path d="M12 8V4.5"/><circle cx="12" cy="3.5" r="1.2"/><circle cx="9" cy="13" r="1.3" fill="#c9b6ff"/><circle cx="15" cy="13" r="1.3" fill="#c9b6ff"/><path d="M2 12.5v3M22 12.5v3"/></svg>';
const FX={firma:"!",pregunta:"?",espera:"⌛",esperando:"⌛",coordina:"→",prueba:"✓",libre:"z",parada:"‖"};
function nuevoTag(d){const e=document.createElement("button");e.type="button";e.className="tag";e.innerHTML=BOT+'<div class="tx"><b></b><span class="como"></span><span class="st"><span class="dot"></span><span class="es"></span></span><span class="more"><span class="fin"></span><span class="bar"><i></i></span></span></div><span class="fx"></span>';e.onclick=()=>abrir(d.agent.nombre);labelsEl.appendChild(e);d.el=e}
function pintarTag(d){const a=d.agent,s=T.AST[a.estado]||[a.estado||"","#999"];d.el.style.setProperty("--c",s[1]);d.el.style.setProperty("--outfit",d.ropa);d.el.querySelector("b").textContent=a.nombre||"";d.el.querySelector(".como").replaceChildren(...(a.comoTrabaja&&a.comoTrabaja!==s[0]?[T.iconoComo(a.comoTrabaja),a.comoTrabaja]:[]));
  d.el.querySelector(".es").textContent=s[0]+(a.mientras?" · y algo más":"");const f=T.finTxt(a),fin=d.el.querySelector(".fin");fin.replaceChildren();
  if(f){fin.append(f.hora);if(f.dif){const x=document.createElement("em");x.className=f.cls;x.textContent=" · "+f.dif;fin.append(x);}}
  const bar=d.el.querySelector(".bar");bar.hidden=a.avance==null;bar.firstChild.style.width=(a.avance||0)+"%";
  const fx=d.el.querySelector(".fx");fx.textContent=FX[a.estado]||"";d.el.classList.toggle("alert",a.estado==="firma"||a.estado==="pregunta");d.el.classList.toggle("sel",sel===a.nombre);d.el.setAttribute("aria-label",(a.nombre||"")+": "+s[0]);}
const tmp=new THREE.Vector3();
function ubicarTags(){const W=stage.clientWidth,H=stage.clientHeight,cmp=stage.classList.contains("compact"),hr=cmp?11:20;
  const P=desks.map(d=>{tmp.copy(d.anchor);d.st.localToWorld(tmp);tmp.project(cam);const ax=(tmp.x+1)/2*W,ay=(1-tmp.y)/2*H;tmp.copy(d.headP);d.st.localToWorld(tmp);tmp.project(cam);
    return {d,ax,ay,hx:(tmp.x+1)/2*W,hy:(1-tmp.y)/2*H,w:d.el.offsetWidth,h:d.el.offsetHeight}});
  P.sort((a,b)=>b.ay-a.ay);const puestos=[];
  const choca=(x,y,w,h,yo)=>{const L=x-w/2,R=x+w/2,T=y-h;if(L<2||R>W-2||T<2)return true;
    if(P.some(q=>q!==yo&&q.hx+hr>L&&q.hx-hr<R&&q.hy+hr>T&&q.hy-hr<y))return true;
    return puestos.some(o=>o.x-o.w/2<R+4&&o.x+o.w/2>L-4&&o.y-o.h<y+4&&o.y>T-4)};
  // de abajo hacia arriba: sobre su cabeza; si choca, al costado; si no, un escalón más arriba
  P.forEach(p=>{const sx=p.w/2+hr+4,cands=[[0,0],[-sx,p.h*.5],[sx,p.h*.5],[-sx,0],[sx,0]];let pos=null;
    for(let up=0;up<8&&!pos;up++)for(const [dx,dy] of cands){const x=Math.min(Math.max(p.ax+dx,p.w/2+2),W-p.w/2-2),y=p.ay+dy-up*(p.h*.5+4);if(!choca(x,y,p.w,p.h,p)){pos=[x,y];break}}
    if(!pos)pos=[p.ax,p.ay];puestos.push({x:pos[0],y:pos[1],w:p.w,h:p.h});
    const el=p.d.el,beside=Math.abs(pos[0]-p.ax)>p.w/4;el.style.left=pos[0]+"px";el.style.top=pos[1]+"px";el.style.setProperty("--stem",beside?"0px":Math.max(0,p.ay-pos[1])+"px");el.style.zIndex=String(Math.round(p.ay))})}

// ---------- detalle de la sesión: la misma ficha que su tarjeta ----------
// `foto`: lo pidió una foto nueva, no un toque. Mantiene lo que se estaba leyendo y no vuelve a pedir la conversación.
function abrir(nombre,foto=false){panel.classList.remove("wide");const baja=foto&&sel===nombre?panel.scrollTop:0;sel=nombre;const a=T.agents().find(x=>x.nombre===nombre);if(!a){sel=null;panel.hidden=true;return}const s=T.AST[a.estado]||[a.estado||"","#999"];panel.hidden=false;panel.style.setProperty("--c",s[1]);
  panel.innerHTML='<button class="close" type="button" aria-label="Cerrar">×</button><h3></h3><div class="chips"><span class="chip">● <span class="es"></span></span></div>';
  panel.querySelector("h3").textContent=a.nombre;panel.querySelector(".es").textContent=s[0];if(a.comoTrabaja&&a.comoTrabaja!==s[0])panel.querySelector(".chips").append(T.etiquetaComo(a.comoTrabaja));T.pintarFicha(a,panel,true);
  panel.querySelector(".close").onclick=()=>{sel=null;panel.hidden=true;desks.forEach(pintarTag)};desks.forEach(pintarTag);
  if(foto)panel.scrollTop=baja}
// ---------- los sobres: quién le habla a quién, unos segundos, sin el texto ----------
const VUELO_MS=3000,MAX_VUELOS=3,vuelos=[],vistos=new Set(),a3=new THREE.Vector3(),b3=new THREE.Vector3();
// el mensaje que cruza es un avioncito de papel del tamaño de un monitor: alas con su pliegue, la cola en V y una quilla azul, con la nariz hacia adelante
const avionGeo=new THREE.BufferGeometry();avionGeo.setAttribute("position",new THREE.Float32BufferAttribute([0,0,1,-.66,.24,-.9,-.17,.05,-.68,0,0,1,.66,.24,-.9,.17,.05,-.68,0,0,1,-.17,.05,-.68,0,-.04,-.46,0,0,1,.17,.05,-.68,0,-.04,-.46,0,0,1,0,-.04,-.46,0,-.3,-.62],3));avionGeo.setAttribute("color",new THREE.Float32BufferAttribute([1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,.66,.78,1,.66,.78,1,.66,.78,1,.66,.78,1,.66,.78,1,.66,.78,1,.12,.44,.92,.12,.44,.92,.12,.44,.92],3));
const avionMat=new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide,toneMapped:false}),bordeGeo=new THREE.EdgesGeometry(avionGeo),bordeMat=new THREE.LineBasicMaterial({color:"#1f6feb",toneMapped:false});
function lanzarSobres(){const nuevos=[];
  for(const s of T.sobres()){if(vistos.has(s.id))continue;vistos.add(s.id);nuevos.push(s)}
  // con la sala fuera de vista no se dibuja: ese mensaje ya pasó
  if(!nuevos.length||!enVista||document.hidden)return;
  const conLugar=nuevos.map(s=>({s,de:desks.find(d=>d.agent.nombre===s.de),a:desks.find(d=>d.agent.nombre===s.a)})).filter(v=>v.de&&v.a&&v.de!==v.a);
  const van=conLugar.slice(-Math.max(0,MAX_VUELOS-vuelos.length)),resto=conLugar.length-van.length;
  van.forEach((v,i)=>{const m=new THREE.Group();m.rotation.order="YXZ";m.scale.setScalar(.55);m.add(new THREE.Mesh(avionGeo,avionMat),new THREE.LineSegments(bordeGeo,bordeMat));scene.add(m);
    const e=document.createElement("button");e.type="button";e.className="sobre";const fila=document.createElement("span"),dib=document.createElement("span");dib.className="dib";dib.append(T.dibujo(T.AVION_ICONO));dib.setAttribute("aria-hidden","true");fila.append(dib,v.s.de+" → "+v.s.a);e.append(fila);e.onclick=()=>abrir(v.s.de);
    if(resto&&i===van.length-1){const x=document.createElement("small");x.textContent="y "+resto+(resto===1?" mensaje más":" mensajes más");e.append(x);}
    labelsEl.appendChild(e);const vuelo={m,e,de:v.de,a:v.a,t0:performance.now()};vuelos.push(vuelo);
    if(reduce)setTimeout(()=>{quitarVuelo(vuelo);despertar()},VUELO_MS);});
  // mientras vuela, la sala se dibuja como si alguien la tocara; después vuelve a su ritmo
  if(van.length){hastaTocando=Math.max(hastaTocando,performance.now()+VUELO_MS);despertar()}}
function quitarVuelo(v){const i=vuelos.indexOf(v);if(i>=0)vuelos.splice(i,1);scene.remove(v.m);v.e.remove()}
function volar(){const W=stage.clientWidth,H=stage.clientHeight,now=performance.now();
  for(const v of [...vuelos]){const k=reduce?.5:(now-v.t0)/VUELO_MS;if(k>=1){quitarVuelo(v);continue}
    a3.copy(v.de.st.position);b3.copy(v.a.st.position);a3.lerp(b3,k);a3.y=1.7+Math.sin(k*Math.PI)*1.1;v.m.position.copy(a3);v.m.rotation.set(-Math.cos(k*Math.PI)*.3,Math.atan2(b3.x-v.de.st.position.x,b3.z-v.de.st.position.z),Math.sin(k*Math.PI*2)*.25);
    a3.project(cam);v.e.style.left=(a3.x+1)/2*W+"px";v.e.style.top=(1-a3.y)/2*H+"px"}}
const ray=new THREE.Raycaster(),ptr=new THREE.Vector2();let down=null;
renderer.domElement.addEventListener("pointerdown",e=>down=[e.clientX,e.clientY]);
function apuntado(e){const r=renderer.domElement.getBoundingClientRect();ptr.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);ray.setFromCamera(ptr,cam);return ray.intersectObjects([pnlFace,lampHit,...(sitio()?[signFace]:[]),...desks.map(d=>d.hit)])[0]}
// el cartel abre el sitio de la organización, sólo si el perfil trae su dirección
const sitio=()=>T.site();
renderer.domElement.addEventListener("pointermove",e=>{if(e.buttons)return;const h=sitio()&&apuntado(e);renderer.domElement.style.cursor=h&&h.object===signFace?"pointer":""});
renderer.domElement.addEventListener("pointerup",e=>{if(!down||Math.hypot(e.clientX-down[0],e.clientY-down[1])>5)return;const h=apuntado(e);
  // en una pantalla táctil, con las etiquetas ocultas, tocar a alguien muestra la suya; el detalle se abre al tocar la etiqueta
  if(stage.classList.contains("solo-mouse")&&e.pointerType==="touch"&&!(h&&(h.object===pnlFace||h.object===signFace||h.object===lampHit))){verEtiqueta((h&&desks.find(x=>x.hit===h.object))||null);return}
  if(!h)return;if(h.object===lampHit){tocarLampara();return}if(h.object===pnlFace){abrirTablero();return}if(h.object===signFace){const s=sitio();if(s)window.open(s,"_blank","noopener");return}const d=desks.find(x=>x.hit===h.object);if(d)abrir(d.agent.nombre)});
let mueve=null;renderer.domElement.addEventListener("pointermove",e=>{if(mueve)return;mueve=requestAnimationFrame(()=>{mueve=null;const h=apuntado(e);renderer.domElement.style.cursor=h?"pointer":"grab";if(e.pointerType!=="touch"&&stage.classList.contains("solo-mouse"))verEtiqueta((h&&desks.find(x=>x.hit===h.object))||null)})});
// con las etiquetas ocultas se ve sólo la de quien tiene el mouse encima, o la que tocó el dedo
let deskVisto=null;
function verEtiqueta(d){if(deskVisto===d)return;if(deskVisto&&deskVisto.el)deskVisto.el.classList.remove("ver");deskVisto=d;if(d&&d.el)d.el.classList.add("ver")}
stage.addEventListener("pointerleave",e=>{if(e.pointerType!=="touch")verEtiqueta(null)});
// el detalle de lo pendiente, plano y legible
function abrirTablero(){sel=null;desks.forEach(pintarTag);const K=T.kanban()||{},meta=T.meta();panel.hidden=false;panel.classList.add("wide");panel.style.setProperty("--c","#9cc2ff");panel.replaceChildren();
  const mk=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
  const cl=mk("button","close","×");cl.type="button";cl.setAttribute("aria-label","Cerrar");cl.onclick=()=>{panel.hidden=true;panel.classList.remove("wide")};panel.append(cl,mk("h3",null,"Pendientes"));
  const orden=paredEnOrden(K);panel.abiertos=panel.abiertos||new Set();
  const ct=mk("div","counts");orden.forEach(c=>{const k=mk("div","cnt");k.style.setProperty("--k",c.color);k.append(mk("b",null,String(c.tarjetas.length)),mk("span",null,c.nombre));ct.append(k);});panel.append(ct);
  const toca=(meta&&meta.teToca)||[];if(toca.length){panel.append(mk("h4","toca","Te toca"));const ul=mk("ul","toca");toca.forEach(t=>ul.append(mk("li",null,t)));panel.append(ul)}
  // lo que no se está trabajando no estira el detalle: con muchas, se abre a pedido, y sigue abierto cuando llega otra foto
  orden.forEach(c=>{const rows=c.tarjetas;if(!rows.length)return;const h=mk("h4",null,c.nombre+" · "+rows.length);h.style.color=c.color;panel.append(h);
    const lista=()=>{const ul=mk("ul","list");rows.forEach(r=>{const li=mk("li");li.append(mk("b",null,r.titulo||""));if(c.id==="medio")li.append(mk("span","m",r.accion||""));else{li.append(mk("span","m",[r.quien,r.hora,r.espera?"espera "+r.espera:"",r.marca,r.motivo].filter(Boolean).join(" · ")));if(r.nota)li.append(mk("span","m",r.nota));}ul.append(li);});return ul;};
    if((c.id==="sinEmpezar"||c.id==="hechos")&&rows.length>5&&!panel.abiertos.has(c.id)){const b=mk("button","verTodos","Ver los "+rows.length);b.type="button";b.onclick=()=>{panel.abiertos.add(c.id);b.replaceWith(lista());};panel.append(b);}
    else panel.append(lista());});
  if(K.medioCaminoLeido)panel.append(mk("p","m",K.medioCaminoLeido));
  if(K.medioCaminoNoSe)panel.append(mk("p","m",K.medioCaminoNoSe));
  if(!orden.some(c=>c.tarjetas.length))panel.append(mk("p","m","No hay nada pendiente en esta máquina."));
  if(meta&&meta.actualizado)panel.append(mk("p","m",stampOf(K,meta)))}

// ---------- luces y postproceso ----------
scene.add(new THREE.HemisphereLight("#ffd6b0","#5a3a6a",1.7));
const sun=new THREE.DirectionalLight("#ffd9b3",3.0);sun.position.set(14,16,9);sun.target.position.set(5,0,5);scene.add(sun,sun.target);
sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);Object.assign(sun.shadow.camera,{left:-9,right:9,top:9,bottom:-9,near:1,far:50});sun.shadow.bias=-.0004;sun.shadow.normalBias=.02;sun.shadow.radius=4;
const fill=new THREE.PointLight("#ff7fb0",8,14,1.5);fill.position.set(6,3.6,6);scene.add(fill);
const rt=new THREE.WebGLRenderTarget(1,1,{samples:2,type:THREE.HalfFloatType});
const composer=new EffectComposer(renderer,rt);composer.addPass(new RenderPass(scene,cam));
const bloom=new UnrealBloomPass(new THREE.Vector2(1,1),.38,.5,.9);composer.addPass(bloom);composer.addPass(new OutputPass());
function resize(){const w=stage.clientWidth,h=stage.clientHeight;if(!w||!h)return;const asp=w/h;const hh=Math.max(5.3,7.4/asp);cam.left=-hh*asp;cam.right=hh*asp;cam.top=hh;cam.bottom=-hh;cam.updateProjectionMatrix();stage.classList.toggle("compact",w<560);renderer.setSize(w,h,false);composer.setSize(w,h);bloom.setSize(w,h);tagsAlDia=false;despertar();}

const reduce=matchMedia("(prefers-reduced-motion: reduce)").matches,clock=new THREE.Clock();let lastScr=-1,ledRate=0,tagsAlDia=false;
// Se dibuja con ritmo: más rápido mientras alguien toca la sala, a un ritmo tranquilo si hay personas que se mueven, muy de
// vez en cuando si nadie se mueve, y nada si la sala no se ve. Con el movimiento reducido, sólo cuando algo cambia.
const FPS_TOCANDO=30,FPS_MOVIMIENTO=15,FPS_QUIETA=4,TOCANDO_MS=2000,SOMBRA_CADA=3,PANTALLAS_S=.4,SE_MUEVEN=new Set(["trabajando","prueba","coordina","firma","pregunta","espera"]);
let hastaTocando=0,enVista=true,timer=null,cuadros=0,apagada=false;
const ritmo=()=>reduce?0:performance.now()<hastaTocando?FPS_TOCANDO:T.chica?FPS_QUIETA:desks.some(d=>SE_MUEVEN.has(d.agent.estado))?FPS_MOVIMIENTO:FPS_QUIETA;
function programar(){clearTimeout(timer);timer=null;const f=ritmo();if(!f||!enVista||document.hidden)return;timer=setTimeout(()=>requestAnimationFrame(loop),1000/f)}
function despertar(){clearTimeout(timer);timer=setTimeout(()=>requestAnimationFrame(loop),0)}
function tocar(){hastaTocando=performance.now()+TOCANDO_MS;if(!timer)despertar()}
["pointerdown","pointermove"].forEach(ev=>renderer.domElement.addEventListener(ev,tocar,{passive:true}));
// La rueda sola mueve la página: se la saca de camino antes de que llegue a los controles de la cámara, sin frenarla. Para acercar:
// ⌘ o Ctrl más rueda (el pellizco del trackpad llega igual), el pellizco de Safari o los botones. Con dos dedos, los controles de siempre.
const avisoZoom=stage.querySelector(".avisoZoom"),zoomBox=stage.querySelector(".zoom");let avisoTimer=null,zoomBase=1;
avisoZoom.textContent=(/Mac|iPhone|iPad/.test(navigator.platform||"")?"⌘":"Ctrl")+" + rueda para acercar";
function acercar(f){const z=Math.min(controls.maxZoom,Math.max(controls.minZoom,cam.zoom*f));if(z===cam.zoom)return;cam.zoom=z;cam.updateProjectionMatrix();tagsAlDia=false;tocar();}
stage.addEventListener("wheel",e=>{if(e.target.closest(".panel3"))return;e.stopPropagation();if(e.ctrlKey||e.metaKey){e.preventDefault();avisoZoom.hidden=true;acercar(Math.exp(-e.deltaY*(Math.abs(e.deltaY)<50?.01:.002)));return;}
  avisoZoom.hidden=false;clearTimeout(avisoTimer);avisoTimer=setTimeout(()=>{avisoZoom.hidden=true;},1500);},{capture:true,passive:false});
stage.addEventListener("gesturestart",e=>{e.preventDefault();zoomBase=cam.zoom;});
stage.addEventListener("gesturechange",e=>{e.preventDefault();acercar(zoomBase*e.scale/cam.zoom);});
zoomBox.children[0].onclick=()=>acercar(1.25);zoomBox.children[1].onclick=()=>acercar(.8);zoomBox.hidden=false;
// Con una cámara ortogonal, el control avisa «change» en cada actualización aunque nada se mueva (da el zoom por cambiado):
// cuenta como toque sólo un cambio de verdad, con el mismo umbral del control. Si no, la sala nunca baja de su ritmo
const camVista={p:cam.position.clone(),q:cam.quaternion.clone(),z:cam.zoom};
function camaraCambio(){const c=camVista.p.distanceToSquared(cam.position)>1e-6||8*(1-camVista.q.dot(cam.quaternion))>1e-6||camVista.z!==cam.zoom;if(c){camVista.p.copy(cam.position);camVista.q.copy(cam.quaternion);camVista.z=cam.zoom}return c}
controls.addEventListener("change",()=>{if(!camaraCambio())return;tagsAlDia=false;tocar()});
const miraVista=new IntersectionObserver(es=>{enVista=es[es.length-1].isIntersecting;if(enVista)despertar()});miraVista.observe(stage);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)despertar()});
function loop(){if(apagada||!enVista||document.hidden){timer=null;return}try{dibujar()}finally{programar()}}
function dibujar(){const t=reduce?2:clock.getElapsedTime();controls.update();
  desks.forEach(d=>animar(d,t));volar();if(t-lastScr>PANTALLAS_S||lastScr<0){desks.forEach(d=>drawScreen(d,t));lastScr=t}
  if(cuadros++%SOMBRA_CADA===0)renderer.shadowMap.needsUpdate=true;
  leds.forEach((m,i)=>m.visible=ledRate?Math.sin(t*ledRate*(1+i%5*.3)+i*1.7)>-.5:true);
  steam.forEach(s=>{const p=(t*.35+s.ph)%1;s.m.position.set(6.2+Math.sin(p*9+s.ph*6)*.05,1.35+p*.7,5.6);s.m.material.opacity=.35*(1-p);s.m.scale.setScalar(.6+p*1.2)});
  if(T.chica)renderer.render(scene,cam);else composer.render();if(!tagsAlDia){ubicarTags();tagsAlDia=true}}
const miraTamano=new ResizeObserver(()=>{if(!apagada){resize();despertar()}});miraTamano.observe(stage);resize();
loop();

// ---------- datos: los de /wip, una sesión por escritorio ----------
// los escritorios se rehacen sólo cuando cambia quiénes están; si no, se repintan en el lugar, sin mover la cámara
let quienes=null;
function poblar(){const ps=puestos(),ags=T.agents().slice(0,ps.length);
  desks.forEach(d=>{scene.remove(d.st);d.el.remove()});
  desks=ags.map((a,i)=>{const d=crearPuesto(a,i,ps[i]);nuevoTag(d);pintarTag(d);return d});lastScr=-1;quienes=ags.map(a=>a.nombre).join("\n");renderer.shadowMap.needsUpdate=true;tagsAlDia=false;despertar()}
function alDia(){const ags=desks.map(d=>d.agent);
  ledRate=ags.filter(a=>a.estado==="trabajando"||a.estado==="prueba").length*1.6;
  drawPanel();
  const meta=T.meta(),extra=meta&&meta.extra;
  aviso(!ags.length?"No hay sesiones abiertas en esta máquina.":extra?"Y "+extra+" sesión(es) más: están en las tarjetas de abajo.":"")}
T.refresh=()=>{const ps=puestos(),ags=T.agents().slice(0,ps.length);
  if(ags.map(a=>a.nombre).join("\n")!==quienes)poblar();else{desks.forEach((d,i)=>{d.agent=ags[i];pintarTag(d)});lastScr=-1}
  tagsAlDia=false;despertar();alDia();lanzarSobres();
  if(sel){if(T.agents().some(a=>a.nombre===sel))abrir(sel,true);else{sel=null;panel.hidden=true}}
  else if(!panel.hidden&&panel.classList.contains("wide"))abrirTablero()};
T.abrir=n=>abrir(n);
T.apagar=()=>{apagada=true;clearTimeout(timer);timer=null;miraVista.disconnect();miraTamano.disconnect();controls.dispose();labelsEl.replaceChildren();panel.hidden=true;renderer.dispose();renderer.forceContextLoss();renderer.domElement.remove();T.refresh=null};
// dónde está la cámara, para comprobar que una foto nueva no la mueve
T.camara=()=>cam.position.toArray().map(n=>+n.toFixed(3));
return function(){resize();poblar();alDia();lanzarSobres()};
}
}).catch(e=>{console.error(e);T.sinTresD("Este navegador no pudo cargar la oficina en 3D; las tarjetas y la tabla tienen lo mismo.")})}
// la pestaña del sitio: lo que se decide sin tocar la pantalla
const TOPE_DE_SALAS=8,ESPERA_MIN_MS=2000,ESPERA_MAX_MS=60000;
// la coordinadora que espera una firma sigue coordinando: la foto la marca por cómo trabaja
function resumenDeOficina(foto){const a=(foto&&foto.agents)||[],n=l=>a.filter(x=>l.includes(x.estado)).length,c=a.find(x=>x.estado==="coordina"||x.comoTrabaja==="Coordinando");
  return {sesiones:a.length,trabajando:n(["trabajando","prueba"]),firma:n(["firma","pregunta"]),esperanOLibres:n(["espera","esperando","parada","libre","inactiva"]),coordina:c?c.nombre:null}}
// qué hace la pestaña cuando se corta la conexión, según el código con que la cerró el sitio
function alCerrarLaConexion(codigo,intento){
  if(codigo===4401||codigo===4403)return {reintenta:false,esperaMs:0,texto:"Tu sesión venció o tu cuenta ya no está en la lista: volvé a entrar al sitio."};
  if(codigo===1008)return {reintenta:false,esperaMs:0,texto:"Tenés demasiadas ventanas abiertas en las oficinas: cerrá otra pestaña y recargá esta."};
  const esperaMs=Math.min(ESPERA_MAX_MS,ESPERA_MIN_MS*2**Math.min(intento,10));
  return {reintenta:true,esperaMs,texto:"Se cortó la conexión con el sitio. Lo que ves es lo último que llegó; vuelvo a intentar en "+Math.round(esperaMs/1000)+" s."}}
function oficinaDelHash(hash){const h=String(hash||"").replace(/^#/,"");if(!h)return null;try{return decodeURIComponent(h)}catch(e){return null}}
// la grande: la pedida, mientras su máquina esté. La que conecta tarde, o se va y vuelve, sigue pedida
function oficinaAMostrar(elegida,pedida,ids,llego){if(elegida&&ids.has(elegida))return elegida;if(pedida&&ids.has(pedida))return pedida;return llego?null:elegida}
function aplicarOficinas(mapa,m){const out=m.entera?new Map():mapa;(m.oficinas||[]).forEach(o=>out.set(o.id,o));(m.fuera||[]).forEach(id=>out.delete(id));return out}
// qué oficinas tienen sala en 3D: la elegida siempre; después las que piden firma; después las que trabajan; después el resto
function salasVivas(lista,elegida,tope){const peso=o=>{const r=resumenDeOficina(o.foto);return o.id===elegida?0:r.firma?1:r.trabajando?2:3};
  return new Set([...lista].map((o,i)=>[o,i]).sort((a,b)=>peso(a[0])-peso(b[0])||a[1]-b[1]).slice(0,tope).map(([o])=>o.id))}
// de dónde se pide la conversación de una sesión: a la oficina local con su token, o al sitio con la máquina; sin de
// dónde (la foto fija, la demo), null y no hay botón
function pedidoDeCharla(p){const s=encodeURIComponent(String(p&&p.nombre||""));
  if(p&&p.fuente==="local"&&p.token)return "conversacion?t="+encodeURIComponent(p.token)+"&s="+s;
  if(p&&p.fuente==="site"&&p.maquina)return "/offices/conversation?m="+encodeURIComponent(p.maquina)+"&s="+s;
  return null}
// los sobres de una oficina del sitio, de su foto
function sobresDeOficina(foto){return foto&&Array.isArray(foto.sobres)?foto.sobres:[]}
// qué se muestra según la respuesta del pedido de la conversación: un 404 es que todavía no está (no llegó, quedó afuera
// del tope o el sitio se reinició), no una falla
function charlaSegunRespuesta(status){return status===200?"datos":status===404?"vacia":"falla"}
// un 200 vale sólo con la forma de una conversación: un cuerpo vacío no se muestra como «no hay mensajes»
const CHARLA_CLAVES=["sinCoordinadora","sinConversacion","conCoordinadora","arranque","conVos","conSesiones"];
function charlaConForma(d){return Boolean(d)&&typeof d==="object"&&!Array.isArray(d)&&CHARLA_CLAVES.some(k=>Object.prototype.hasOwnProperty.call(d,k))}
// fin de lo que se decide sin tocar la pantalla
// la pestaña del sitio: el dibujo
function hhmmDe(ms){const d=new Date(ms);return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0")}
// una sala nueva sale de la de la página, sin sus ids
function moldeDeSala(){const c=document.getElementById("stage").cloneNode(true);c.removeAttribute("id");c.querySelectorAll("[id]").forEach(e=>e.removeAttribute("id"));c.classList.toggle("solo-mouse",etiquetasGuardadas()==="mouse");return c}
function arrancarOficinas(){
  const $=id=>document.getElementById(id),sec=$("oficinas"),wrap=$("offices"),crews=$("crews"),back=$("back"),vacio=$("oficinasVacio"),avisoEl=$("oficinasAviso"),detalle=$("detalleOficina");
  let oficinas=new Map(),elegida=oficinaDelHash(location.hash),pedida=elegida,llego=false,cortada=false;const fichas=new Map();
  // lo de una sola oficina queda debajo de la elegida; la sala y las tarjetas de la página local no se usan
  sec.hidden=false;$("office").hidden=true;$("crew").closest("section").hidden=true;detalle.append($("resumen"),$("trabajo"),$("noRead"));sec.append($("foot"));wrap.before(document.querySelector(".interruptor"));
  document.querySelector("header h1").textContent="Oficinas del equipo";document.title="Oficinas del equipo";
  const decir=t=>{avisoEl.textContent=t||"";avisoEl.hidden=!t};
  // lo que repinta desde afuera de la conexión: si falla, se dice en la página, no sólo en la consola
  const seguro=f=>{try{f()}catch(e){console.error(e);decir("No pude dibujar la última novedad; muestro la anterior.")}};
  // cortada antes del primer mensaje y sin reintento: no hay nada cargando, y el aviso dice por qué
  function pintarVacio(){vacio.hidden=oficinas.size>0||(!llego&&cortada);document.querySelector(".interruptor").hidden=!oficinas.size;$("foot").hidden=!oficinas.size;vacio.textContent=llego?"Todavía no hay oficinas para mostrarte: aparecen cuando una máquina confirmada a tu nombre se conecta.":"Cargando las oficinas…"}
  function ubicar(){const W=wrap.clientWidth,ancho=W>=900,G=18;
    // en el orden del sitio, el mismo con que se eligen las salas: no en el de llegada, que cambia con lo que la página vio antes
    const orden=[...new Set([...oficinas.keys(),...fichas.keys()])].filter(id=>fichas.has(id)),cards=orden.map(id=>fichas.get(id).card);
    orden.forEach(id=>crews.append(fichas.get(id).bloque));let H=0;
    const pos=(c,x,y,w,h,mini)=>{Object.assign(c.style,{left:x+"px",top:y+"px",width:w+"px",height:h+"px"});c.classList.toggle("mini",mini);c.classList.toggle("on",c.dataset.id===elegida)};
    const big=elegida&&fichas.has(elegida)?fichas.get(elegida).card:null,otras=cards.filter(c=>c!==big);
    if(!big){if(ancho){const w=(W-G)/2,h=Math.round(Math.min(w*.72,innerHeight*.7));cards.forEach((c,i)=>pos(c,(i%2)*(w+G),Math.floor(i/2)*(h+G),w,h,false));H=Math.ceil(cards.length/2)*(h+G)-G}
      else{const h=Math.round(W*.85);cards.forEach((c,i)=>pos(c,0,i*(h+G),W,h,false));H=cards.length*(h+G)-G}}
    // la grande no crece con las demás: las que no entran al costado siguen en filas debajo de ella
    else if(ancho){const tw=Math.round(Math.min(320,W*.22)),th=Math.round(tw*.82),alto=Math.round(Math.max(520,innerHeight-150)),alCostado=Math.max(1,Math.floor((alto+G)/(th+G))),porFila=Math.max(1,Math.floor((W+G)/(tw+G)));
      pos(big,0,0,W-tw-G,alto,false);otras.forEach((c,i)=>{if(i<alCostado)pos(c,W-tw,i*(th+G),tw,th,true);else{const j=i-alCostado;pos(c,(j%porFila)*(tw+G),alto+G+Math.floor(j/porFila)*(th+G),tw,th,true)}});
      const resto=Math.max(0,otras.length-alCostado);H=alto+(resto?G+Math.ceil(resto/porFila)*(th+G)-G:0)}
    else{const th=150,tw=(W-G)/2,alto=Math.ceil(otras.length/2)*(th+G);otras.forEach((c,i)=>pos(c,(i%2)*(tw+G),Math.floor(i/2)*(th+G),tw,th,true));H=alto+Math.round(W*1.05);pos(big,0,alto,W,H-alto,false)}
    wrap.style.height=Math.max(H,0)+"px";back.hidden=!big;
    fichas.forEach((f,id)=>{f.bloque.hidden=!!big&&id!==elegida})}
  function fichaDe(o){let f=fichas.get(o.id);if(f)return f;
    const card=el("section","oficina");card.dataset.id=o.id;
    const head=el("div","ohead"),h=el("h2"),stats=el("div","stats");head.append(h,stats);
    const stage=moldeDeSala(),sinSala=el("p","sinSala","Tocala para ver su sala.");stage.append(sinSala);
    const cover=el("button","cover");cover.type="button";cover.onclick=()=>seguro(()=>foco(o.id));
    card.append(head,stage,cover);wrap.append(card);
    const bloque=el("div","crewblock"),titulo=el("h2"),crew=el("div","crew");bloque.dataset.id=o.id;bloque.append(titulo,crew);crews.append(bloque);
    f={card,h,stats,stage,sinSala,cover,bloque,titulo,crew,T:null};fichas.set(o.id,f);return f}
  // el reloj corre antes del resumen: una sesión que pasó a inactiva se cuenta igual que la dice su tarjeta
  function pintarOficina(o){const lista=(o.foto&&o.foto.agents)||[];relojTick(lista,Date.now(),o.foto&&o.foto.meta);
    const f=fichaDe(o),r=resumenDeOficina(o.foto),quien=o.person||o.id;
    f.h.replaceChildren(document.createTextNode(quien));if(o.person)f.h.append(el("small",null,o.id));
    const chip=(n,t,c)=>{const s=el("span","stat"+(c&&n?" "+c:""));s.append(el("b",null,String(n)),document.createTextNode(t));return s};
    f.stats.replaceChildren(chip(r.sesiones,r.sesiones===1?"sesión":"sesiones"),chip(r.trabajando,"trabajando"),chip(r.firma,"esperan tu firma","firma"),chip(r.esperanOLibres,"esperan o libres"));
    if(r.coordina){const s=el("span","stat");s.append("coordina ",el("b",null,r.coordina));f.stats.append(s)}
    if(o.sinConexionDesde)f.stats.append(el("span","stat apagada","sin conexión desde "+hhmmDe(o.sinConexionDesde)));
    (o.marcas||[]).forEach(m=>f.stats.append(el("span","stat firma",m==="clave_copiada"?"posible clave copiada":m==="mas_nueva"?"más nueva que el sitio":m)));
    f.cover.setAttribute("aria-label","Agrandar la oficina de "+quien);f.stage.setAttribute("aria-label","La oficina de "+quien);f.titulo.textContent="Las sesiones de "+quien;
    // la ficha lee de DATA lo que no es de la persona (sus tokens): mientras se pintan, DATA es la foto de esta oficina
    const antes=fuenteCharla,datos=DATA;fuenteCharla={fuente:"site",maquina:o.id};DATA=o.foto||{};
    try{pintarTarjetas(f.crew,lista,a=>{const yaEra=elegida===o.id;if(!yaEra)seguro(()=>foco(o.id));const abrirla=n=>{if(f.T&&f.T.abrir)f.T.abrir(a.nombre);else if(n>0)setTimeout(()=>abrirla(n-1),200)};setTimeout(()=>abrirla(25),yaEra?0:750)})}finally{fuenteCharla=antes;DATA=datos}}
  // las salas en 3D: hasta el tope, cada una con sus datos. Primero se apagan las que sobran, y sus lugares quedan libres
  function ponerSalas(cambiadas){const vivas=salasVivas(oficinas.values(),elegida,TOPE_DE_SALAS);
    fichas.forEach((f,id)=>{f.sinSala.hidden=vivas.has(id);if(f.T&&!vivas.has(id))apagarSala(f)});
    fichas.forEach((f,id)=>{if(!vivas.has(id))return;if(!f.T){crearSala(f,id);return}
      f.T.chica=id!==elegida;if(f.T.refresh&&(!cambiadas||cambiadas.has(id)))f.T.refresh()})}
  function apagarSala(f){f.T.cancelada=true;if(f.T.apagar)f.T.apagar();f.T=null}
  function crearSala(f,id){const foto=()=>(oficinas.get(id)||{}).foto||{};
    // los avioncitos de esa oficina vuelan en su sala, y la ficha de una persona pide su conversación a esa máquina
    const conLaMaquina=g=>(...x)=>{const antes=fuenteCharla,datos=DATA;fuenteCharla={fuente:"site",maquina:id};DATA=foto();try{return g(...x)}finally{fuenteCharla=antes;DATA=datos}};
    f.T={...window.tablero,agents:()=>foto().agents||[],items:()=>[],kanban:()=>foto().kanban||null,meta:()=>foto().meta||null,site:()=>null,sobres:()=>sobresDeOficina(foto()),live:()=>null,pintarFicha:conLaMaquina(window.tablero.pintarFicha),chica:id!==elegida,sinTresD:t=>{f.sinSala.textContent=t;f.sinSala.hidden=false}};
    armarSala(f.stage,f.T)}
  function pintarDetalle(){const o=elegida&&oficinas.get(elegida);detalle.hidden=!o;if(!o)return;maquinaDelDetalle=o.id;setData(o.foto);relojTick(agents,Date.now(),meta);renderTop()}
  function foco(id){const antes=elegida;elegida=id;pedida=id;history.replaceState(null,"",id?"#"+encodeURIComponent(id):location.pathname);pintarDetalle();ponerSalas(new Set([antes,id]));ubicar();pintarVacio()}
  function pintarTodo(cambiadas){fichas.forEach((f,id)=>{if(oficinas.has(id))return;if(f.T)apagarSala(f);f.card.remove();f.bloque.remove();fichas.delete(id)});
    oficinas.forEach((o,id)=>{if(!cambiadas||cambiadas.has(id))pintarOficina(o)});
    const antes=elegida;elegida=oficinaAMostrar(elegida,pedida,new Set(oficinas.keys()),llego);
    // la que pasa a grande o deja de serlo cambia de sala: se repinta aunque su foto no haya cambiado
    if(cambiadas&&antes!==elegida)cambiadas=new Set([...cambiadas,antes,elegida]);
    pintarDetalle();ponerSalas(cambiadas);ubicar();pintarVacio()}
  back.onclick=()=>seguro(()=>foco(null));new ResizeObserver(ubicar).observe(wrap);addEventListener("resize",ubicar);
  addEventListener("hashchange",()=>{const id=oficinaDelHash(location.hash);if(id!==elegida)seguro(()=>foco(id))});
  setInterval(()=>seguro(()=>pintarTodo(null)),60000);
  function recibir(m){if(!m||m.type!=="oficinas")return;oficinas=aplicarOficinas(oficinas,m);llego=true;pintarTodo(m.entera?null:new Set((m.oficinas||[]).map(o=>o.id)));requestAnimationFrame(()=>wrap.classList.add("anim"))}
  pintarVacio();
  // en la demo, un pedido común; en el sitio, la conexión. La página nunca le manda nada
  if(SOURCE==="demo"){fetch("/offices/demo.json",{credentials:"same-origin"}).then(r=>{if(!r.ok)throw new Error(String(r.status));return r.json()}).then(recibir).catch(e=>{console.error(e);cortada=true;pintarVacio();decir("No pude traer las oficinas de ejemplo.")});return}
  let intento=0;
  (function conectar(){const ws=new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host+"/live/offices");
    ws.onmessage=ev=>{intento=0;decir("");try{recibir(JSON.parse(ev.data))}catch(e){console.error(e);decir("No pude dibujar la última novedad; muestro la anterior.")}};
    ws.onclose=ev=>{const r=alCerrarLaConexion(ev.code,intento);decir(r.texto);if(!r.reintenta){cortada=true;pintarVacio();return}intento+=1;setTimeout(conectar,r.esperaMs)}})()}
// fin de la pestaña del sitio
if(CON_OFICINAS)arrancarOficinas();else armarSala(document.getElementById("stage"),window.tablero);
