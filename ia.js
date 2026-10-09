/* ia.js — Análisis de conversaciones de WhatsApp con IA para la Planilla de Venta.
 *
 * Se carga DESPUÉS del script principal de index.html y usa sus globales:
 * CATEGORIES, currentCategory y scheduleSave. No ejecuta nada que venga de la IA:
 * solo asigna texto a campos que ya existen, y siempre tras la confirmación del usuario.
 */
(function () {
  "use strict";

  // ===== CONFIGURACIÓN: cambia solo esta URL por la de tu Worker (ver DESPLIEGUE.md) =====
  const IA_WORKER_URL = "https://planilla-ia.TU-SUBDOMINIO.workers.dev/analizar";

  const MAX_CHARS = 12000;
  const TIMEOUT_MS = 30000;
  const KEY_STORAGE = "planilla_ia_clave";     // solo si el usuario marca "Recordar"
  const PASTE_STORAGE = "planilla_pegado";     // texto pegado, para no perderlo sin conexión
  const MAX_FIELD = { observaciones: 500 };
  const MAX_FIELD_DEFAULT = 160;

  const $ = (id) => document.getElementById(id);
  let claveMemoria = "";
  let enCurso = null;

  // ---------------------------------------------------------------- estilos
  const css = `
  .ia-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:1000;display:flex;align-items:flex-end;justify-content:center}
  .ia-sheet{background:var(--card-bg,#fff);width:100%;max-width:720px;max-height:90vh;display:flex;flex-direction:column;border-radius:16px 16px 0 0;box-shadow:0 -10px 40px rgba(0,0,0,.2)}
  .ia-head{padding:16px 20px 12px;border-bottom:1px solid var(--border-light,#e9edf2)}
  .ia-head h2{font-size:17px;font-weight:700;letter-spacing:-.01em}
  .ia-head p{font-size:12px;color:var(--text-muted,#94a3b8);margin-top:2px}
  .ia-body{padding:12px 20px 4px;overflow:auto;flex:1}
  .ia-foot{padding:12px 20px calc(12px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--border-light,#e9edf2);display:flex;gap:10px}
  .ia-foot .btn{min-width:0}
  .ia-sec h3{font-size:13px;font-weight:600;margin:12px 0 6px;color:var(--text-secondary,#475569)}
  .ia-row{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border:1px solid var(--border-light,#e9edf2);border-radius:10px;margin-bottom:6px;background:#fafbfc;font-size:14px}
  .ia-row.dudoso{border-color:#fcd34d;background:#fffbeb}
  .ia-sheet input[type=checkbox],.ia-sheet input[type=radio]{width:18px;height:18px;padding:0;margin-top:2px;flex:none}
  .ia-row .ia-txt{flex:1;min-width:0;word-break:break-word}
  .ia-row .ia-lbl{font-size:12px;color:var(--text-secondary,#475569);display:block}
  .ia-row .ia-ahora{font-size:12px;color:var(--text-muted,#94a3b8);display:block}
  .ia-aviso{background:#fffbeb;border:1px solid #fcd34d;color:#92400e;border-radius:10px;padding:10px 12px;font-size:13px;margin:8px 0}
  .ia-error{background:var(--danger-soft,#fef2f2);border:1px solid rgba(220,38,38,.25);color:var(--danger,#dc2626);border-radius:10px;padding:12px;font-size:14px;margin:8px 0}
  .ia-info{font-size:13px;color:var(--text-secondary,#475569);margin:8px 0}
  .ia-lista{font-size:13px;color:var(--text-secondary,#475569)}
  .ia-opt{display:flex;gap:8px;align-items:flex-start;font-size:14px;margin:4px 0}
  .ia-motivo{font-size:12px;color:var(--text-muted,#94a3b8);margin:2px 0 4px}
  .ia-sheet input[type=password]{margin-top:6px}
  .ia-recordar{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--text-muted,#94a3b8);margin-top:8px}
  `;
  const estilo = document.createElement("style");
  estilo.textContent = css;
  document.head.appendChild(estilo);

  // ------------------------------------------------- protección de datos personales
  // CI, teléfonos y tarjetas se sustituyen por marcadores ANTES de salir del navegador.
  function proteger(texto) {
    const mapa = {};
    const vistos = {};
    const cont = { CI: 0, TEL: 0, TARJETA: 0 };
    function marcador(tipo, valor) {
      // El mismo teléfono escrito de varias formas (+53 5..., 53..., 5...) comparte marcador.
      const canon = tipo === "TEL" ? normalizarTelefono(valor) : valor;
      const clave = tipo + ":" + canon;
      if (vistos[clave]) return vistos[clave];
      cont[tipo] += 1;
      const m = "[" + tipo + "_" + cont[tipo] + "]";
      vistos[clave] = m;
      mapa[m] = valor;
      return m;
    }
    let t = texto;
    t = t.replace(/\b\d{4}([ -]?)\d{4}\1\d{4}\1\d{4}\b/g, (m) => marcador("TARJETA", m));
    t = t.replace(/\b\d{13,19}\b/g, (m) => marcador("TARJETA", m));
    t = t.replace(/\b\d{11}\b/g, (m) => marcador("CI", m));
    t = t.replace(/(^|[^\d])((?:\+?53[ -]?)?5\d{7})(?!\d)/g, (m, pre, num, off, todo) => {
      const despues = todo.slice(off + m.length, off + m.length + 10);
      // "50000000 MN" es un monto, no un teléfono.
      if (/^\s*(usd|cup|mn|mlc|eur|\$|d[oó]lar|peso)/i.test(despues)) return m;
      return pre + marcador("TEL", num);
    });
    return { texto: t, mapa };
  }

  function restaurar(valor, mapa) {
    return valor.replace(/\[(CI|TEL|TARJETA)_(\d+)\]/g, (m, tipo) => {
      if (tipo === "TARJETA") return "[tarjeta omitida]";
      return mapa[m] !== undefined ? mapa[m] : m;
    });
  }

  // ------------------------------------------------------------------ validación
  function limpiar(valor, max) {
    if (typeof valor === "number") valor = String(valor);
    if (typeof valor !== "string") return "";
    let v = valor.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    if (/^(null|none|n\/a|ninguno|desconocido|no consta|no aparece|-+)$/i.test(v)) return "";
    return v.slice(0, max);
  }

  function soloDigitos(s) { return String(s).replace(/\D/g, ""); }

  function normalizarTelefono(s) {
    let d = soloDigitos(s);
    if (d.length === 10 && d.indexOf("53") === 0) d = d.slice(2);
    return d;
  }

  // Devuelve {valor, dudoso, aviso} o null si hay que descartarlo.
  function validarCampo(id, valor) {
    if (id === "ciCliente") {
      const d = soloDigitos(valor);
      return d.length === 11 ? { valor: d } : { valor, dudoso: true, aviso: "CI sin 11 dígitos" };
    }
    if (id === "telCliente" || id === "zelleTelefono" || id === "gestorTelefono") {
      const d = normalizarTelefono(valor);
      return /^5\d{7}$/.test(d) ? { valor: d } : { valor, dudoso: true, aviso: "teléfono con formato inusual" };
    }
    if (id === "pagaQuien") {
      const m = valor.toLowerCase();
      if (m.indexOf("gestor") === 0) return { valor: "Gestor" };
      if (m.indexOf("cliente") === 0) return { valor: "Cliente" };
      return null;
    }
    if (["cantidad", "cambio", "domicilio", "vuelto", "comision"].indexOf(id) !== -1 && !/\d/.test(valor)) {
      return { valor, dudoso: true, aviso: "no incluye ninguna cifra" };
    }
    return { valor };
  }

  function normComparar(id, s) {
    if (/Telefono$/.test(id)) return normalizarTelefono(s);
    return String(s).toLowerCase().replace(/\s+/g, " ").trim();
  }

  function parseMonto(s) {
    const m = String(s || "").match(/(\d+(?:[.,]\d+)?)\s*(usd|cup|mn|mlc|eur|\$|d[oó]lares?|pesos?)?/i);
    if (!m) return null;
    let moneda = (m[2] || "").toUpperCase();
    if (moneda === "$" || moneda.indexOf("D") === 0) moneda = "USD";
    if (moneda.indexOf("PES") === 0) moneda = "MN";
    return { n: parseFloat(m[1].replace(",", ".")), moneda };
  }

  function formatoNumero(n) {
    return String(Math.round(n * 100) / 100);
  }

  // ------------------------------------------------- campos reales de la planilla
  function camposDePlanilla(cat, formEl) {
    const ids = []
      .concat(cat.fieldDefs, cat.zelleDefs, cat.gestorDefs)
      .map((f) => f.id)
      .concat("observaciones");
    return ids.filter((id) => {
      if (id === "fecha" || id === "gestorTarjeta") return false;
      const el = formEl.elements.namedItem(id);
      return el && !el.readOnly && !el.disabled;
    });
  }

  function etiquetaDe(cat, id) {
    const todos = [].concat(cat.fieldDefs, cat.zelleDefs, cat.gestorDefs);
    for (let i = 0; i < todos.length; i++) {
      if (todos[i].id === id) return todos[i].label.replace(/^[^\wÁÉÍÓÚÑáéíóúñ]+/u, "").trim();
    }
    return id === "observaciones" ? "Observaciones" : id;
  }

  // ---------------------------------------- construir la propuesta para la vista previa
  function construirPropuesta(res, mapa, cat, formEl) {
    const permitidos = camposDePlanilla(cat, formEl);
    const p = {
      confirmado: res.pedido_confirmado,
      nuevos: [], cambios: [], coinciden: 0, conflictos: [], pendientes: [],
      extras: [], avisos: [], obs: [],
    };
    const campos = res.campos && typeof res.campos === "object" ? res.campos : {};
    const enConflicto = {};

    (Array.isArray(res.conflictos) ? res.conflictos : []).forEach((c) => {
      if (!c || permitidos.indexOf(c.campo) === -1 || !Array.isArray(c.opciones)) return;
      const max = MAX_FIELD[c.campo] || MAX_FIELD_DEFAULT;
      const opciones = [];
      c.opciones.slice(0, 4).forEach((o) => {
        const lim = limpiar(typeof o === "string" ? restaurar(o, mapa) : "", max);
        if (!lim) return;
        const v = validarCampo(c.campo, lim);
        if (v && opciones.indexOf(v.valor) === -1) opciones.push(v.valor);
      });
      if (opciones.length < 2) return;
      enConflicto[c.campo] = true;
      p.conflictos.push({ id: c.campo, label: etiquetaDe(cat, c.campo), opciones, motivo: limpiar(c.motivo, 140) });
    });

    permitidos.forEach((id) => {
      if (enConflicto[id]) return;
      const el = formEl.elements.namedItem(id);
      const actual = (el.value || "").trim();
      const crudo = campos[id];
      let valor = typeof crudo === "string" ? limpiar(restaurar(crudo, mapa), MAX_FIELD[id] || MAX_FIELD_DEFAULT) : "";

      if (/\[(CI|TEL)_\d+\]/.test(valor)) {
        p.avisos.push("La IA devolvió un marcador desconocido en «" + etiquetaDe(cat, id) + "»; se descartó.");
        valor = "";
      }
      if (!valor) {
        if (!actual && id !== "observaciones") p.pendientes.push(etiquetaDe(cat, id));
        return;
      }
      const v = validarCampo(id, valor);
      if (!v) {
        p.avisos.push("Valor no válido para «" + etiquetaDe(cat, id) + "»; se descartó.");
        return;
      }
      const item = { id, label: etiquetaDe(cat, id), valor: v.valor, actual, dudoso: !!v.dudoso, aviso: v.aviso || "" };

      if (id === "observaciones") { p.obs.push({ texto: item.valor, tipo: "obs", marcado: true, label: "Observaciones" }); return; }
      if (!actual) { p.nuevos.push(item); return; }
      if (normComparar(id, actual) === normComparar(id, v.valor)) { p.coinciden += 1; return; }
      p.cambios.push(item);
    });

    // Vuelto calculado (no lo calcula la IA): solo si el campo existe, está vacío y las monedas coinciden.
    if (permitidos.indexOf("vuelto") !== -1 && !enConflicto.cantidad) {
      const yaTiene = p.nuevos.concat(p.cambios).some((i) => i.id === "vuelto") || (formEl.elements.namedItem("vuelto").value || "").trim();
      if (!yaTiene) {
        const precioTxt = (p.nuevos.concat(p.cambios).filter((i) => i.id === "cantidad")[0] || {}).valor || (formEl.elements.namedItem("cantidad").value || "");
        const pago = parseMonto(typeof res.pago_entregado === "string" ? restaurar(res.pago_entregado, mapa) : "");
        const precio = parseMonto(precioTxt);
        if (pago && precio && pago.moneda && pago.moneda === precio.moneda && pago.n > precio.n) {
          p.nuevos.push({
            id: "vuelto", label: "Vuelto", valor: formatoNumero(pago.n - precio.n) + " " + pago.moneda,
            actual: "", dudoso: false, aviso: "", calculado: "calculado: " + formatoNumero(pago.n) + " − " + formatoNumero(precio.n),
          });
        }
      }
    }

    (Array.isArray(res.extras) ? res.extras : []).slice(0, 6).forEach((e) => {
      if (!e) return;
      const et = limpiar(e.etiqueta, 40);
      let val = typeof e.valor === "string" ? limpiar(restaurar(e.valor, mapa), MAX_FIELD_DEFAULT) : "";
      if (!et || !val) return;
      p.extras.push({ texto: et + ": " + val, tipo: "extra", marcado: false, label: et });
    });

    (Array.isArray(res.notas) ? res.notas : []).slice(0, 3).forEach((n) => {
      const t = typeof n === "string" ? limpiar(restaurar(n, mapa), 160) : "";
      if (t) p.avisos.push(t);
    });
    return p;
  }

  // -------------------------------------------------------------- panel (vista)
  let panel = null;

  function nodo(tag, props, hijos) {
    const e = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach((k) => {
        if (k === "texto") e.textContent = props[k];
        else if (k === "clase") e.className = props[k];
        else if (k === "onclick") e.addEventListener("click", props[k]);
        else e.setAttribute(k, props[k]);
      });
    }
    (hijos || []).forEach((h) => { if (h) e.appendChild(h); });
    return e;
  }

  function abrirPanel(titulo, sub) {
    cerrarPanel();
    const cuerpo = nodo("div", { clase: "ia-body" });
    const pie = nodo("div", { clase: "ia-foot" });
    const hoja = nodo("div", { clase: "ia-sheet", role: "dialog", "aria-modal": "true", "aria-label": titulo }, [
      nodo("div", { clase: "ia-head" }, [nodo("h2", { texto: titulo }), sub ? nodo("p", { texto: sub }) : null]),
      cuerpo, pie,
    ]);
    const overlay = nodo("div", { clase: "ia-overlay", id: "iaPanel" }, [hoja]);
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay && !enCurso) cerrarPanel(); });
    document.body.appendChild(overlay);
    panel = { overlay, cuerpo, pie };
    return panel;
  }

  function cerrarPanel() {
    if (panel && panel.overlay.parentNode) panel.overlay.parentNode.removeChild(panel.overlay);
    panel = null;
  }

  function boton(texto, clase, fn) {
    return nodo("button", { type: "button", clase: "btn " + clase, texto, onclick: fn });
  }

  function mostrarMensaje(titulo, mensaje, esError) {
    const p = abrirPanel(titulo);
    p.cuerpo.appendChild(nodo("div", { clase: esError ? "ia-error" : "ia-info", texto: mensaje, role: "alert" }));
    p.pie.appendChild(boton("Cerrar", "btn-outline", cerrarPanel));
  }

  // ------------------------------------------------------------- flujo principal
  function pedirClave(alContinuar) {
    const p = abrirPanel("Clave de acceso", "Solo la primera vez en esta sesión.");
    const campo = nodo("input", { type: "password", id: "iaClave", autocomplete: "off", placeholder: "Clave de acceso" });
    const recordar = nodo("input", { type: "checkbox", id: "iaRecordar" });
    p.cuerpo.appendChild(nodo("div", { clase: "ia-info", texto: "Escribe la clave que configuraste en el Worker." }));
    p.cuerpo.appendChild(campo);
    p.cuerpo.appendChild(nodo("label", { clase: "ia-recordar", for: "iaRecordar" }, [
      recordar,
      nodo("span", { texto: "Recordar en este dispositivo (se guarda en el almacenamiento del navegador; no lo marques en un equipo compartido)." }),
    ]));
    const seguir = () => {
      const v = campo.value.trim();
      if (!v) { campo.focus(); return; }
      claveMemoria = v;
      if (recordar.checked) { try { localStorage.setItem(KEY_STORAGE, v); } catch (e) { /* sin almacenamiento */ } }
      alContinuar();
    };
    campo.addEventListener("keydown", (ev) => { if (ev.key === "Enter") seguir(); });
    p.pie.appendChild(boton("Cancelar", "btn-outline", cerrarPanel));
    p.pie.appendChild(boton("Continuar", "btn-primary", seguir));
    campo.focus();
  }

  function iniciarAnalisis() {
    if (enCurso) return;
    const area = $("pasteInput");
    const texto = (area.value || "").trim();

    if (IA_WORKER_URL.indexOf("TU-SUBDOMINIO") !== -1) {
      mostrarMensaje("Falta configurar la IA", "Edita ia.js y pon la URL de tu Worker en IA_WORKER_URL (ver DESPLIEGUE.md). Mientras tanto puedes usar «Autocompletar campos».", true);
      return;
    }
    if (!texto) {
      mostrarMensaje("No hay conversación", "Pega primero la conversación de WhatsApp en el cuadro de texto.", false);
      return;
    }
    if (texto.length > MAX_CHARS) {
      mostrarMensaje("Conversación demasiado larga", "Tiene " + texto.length + " caracteres y el máximo es " + MAX_CHARS + ". Pega solo la parte del pedido (los últimos mensajes). Tu texto no se ha borrado.", true);
      return;
    }
    if (!navigator.onLine) {
      mostrarMensaje("Sin conexión", "La IA necesita internet. Tu texto se conserva en el cuadro; pulsa de nuevo cuando vuelva la señal. Mientras tanto puedes usar «Autocompletar campos».", true);
      return;
    }
    if (!claveMemoria) {
      try { claveMemoria = localStorage.getItem(KEY_STORAGE) || ""; } catch (e) { claveMemoria = ""; }
    }
    if (!claveMemoria) { pedirClave(iniciarAnalisis); return; }
    enviar(texto);
  }

  async function enviar(texto) {
    const cat = CATEGORIES[currentCategory];
    const formEl = $(cat.formId);
    const proteccion = proteger(texto);
    const btn = $("iaBtn");

    enCurso = new AbortController();
    btn.disabled = true;
    const p = abrirPanel("Analizando la conversación…", "Puede tardar unos segundos.");
    p.cuerpo.appendChild(nodo("div", { clase: "ia-info", texto: "Se envía el texto sin CI, teléfonos ni números de tarjeta (van sustituidos por marcadores)." }));
    p.pie.appendChild(boton("Cancelar", "btn-outline", () => { if (enCurso) enCurso.abort(); }));
    let agotado = false;
    const temporizador = setTimeout(() => { agotado = true; if (enCurso) enCurso.abort(); }, TIMEOUT_MS);

    let datos = null;
    let fallo = null;
    try {
      const r = await fetch(IA_WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Access-Key": claveMemoria },
        body: JSON.stringify({ planilla: currentCategory, texto: proteccion.texto }),
        signal: enCurso.signal,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      let cuerpo = null;
      try { cuerpo = await r.json(); } catch (e) { cuerpo = null; }
      if (!r.ok || !cuerpo || cuerpo.ok !== true) fallo = { estado: r.status, error: cuerpo && cuerpo.error };
      else datos = cuerpo.resultado;
    } catch (e) {
      const abortado = e && e.name === "AbortError";
      fallo = { red: true, abortado, tiempo: abortado && agotado };
    } finally {
      clearTimeout(temporizador);
      enCurso = null;
      btn.disabled = false;
    }

    if (fallo) { mostrarFallo(fallo); return; }
    if (!datos || typeof datos !== "object") {
      mostrarMensaje("Respuesta no válida", "La IA devolvió algo que no se pudo leer. Tu texto sigue en el cuadro; puedes intentarlo de nuevo o usar «Autocompletar campos».", true);
      return;
    }
    mostrarVistaPrevia(construirPropuesta(datos, proteccion.mapa, cat, formEl), cat, formEl);
  }

  function mostrarFallo(f) {
    if (f.abortado && !f.tiempo) { cerrarPanel(); return; }
    let msg;
    if (f.tiempo) msg = "La IA tardó demasiado en responder. No se reintentó automáticamente. Tu texto sigue en el cuadro.";
    else if (f.red) msg = "No se pudo conectar con el servicio de IA. Revisa tu conexión; tu texto sigue en el cuadro. No se reintentó automáticamente.";
    else if (f.estado === 401) { claveMemoria = ""; try { localStorage.removeItem(KEY_STORAGE); } catch (e) { /* nada */ } msg = "La clave de acceso es incorrecta. Pulsa de nuevo el botón para escribirla otra vez."; }
    else if (f.error === "cuota") msg = "Se agotó la cuota gratuita diaria de la IA. Se reinicia a las 00:00 UTC (hacia las 8 p. m. en Cuba). Mientras tanto usa «Autocompletar campos» o rellena a mano; tu texto sigue en el cuadro.";
    else if (f.estado === 429) msg = "Demasiadas peticiones seguidas. Espera un minuto y vuelve a intentarlo.";
    else if (f.estado === 413) msg = "La conversación es demasiado larga para el servicio. Pega solo la parte del pedido.";
    else if (f.estado === 403) msg = "El servicio rechazó esta web (origen no autorizado). Revisa ALLOWED_ORIGINS en el Worker.";
    else msg = "El servicio de IA no pudo analizar la conversación (error " + (f.estado || "?") + "). Tu texto sigue en el cuadro; usa «Autocompletar campos» o rellena a mano.";
    mostrarMensaje("No se pudo analizar", msg, true);
  }

  // ------------------------------------------------------------ vista previa
  function fila(p, item, opciones) {
    const cb = nodo("input", { type: "checkbox", "aria-label": item.label });
    cb.checked = !!opciones.marcado;
    cb.addEventListener("change", () => actualizarContador(p));
    item.cb = cb;
    const txt = nodo("span", { clase: "ia-txt" }, [
      nodo("span", { clase: "ia-lbl", texto: item.label + (item.calculado ? " (" + item.calculado + ")" : "") }),
      nodo("span", { texto: item.valor || item.texto }),
      item.actual ? nodo("span", { clase: "ia-ahora", texto: "Ahora: " + item.actual }) : null,
      item.aviso ? nodo("span", { clase: "ia-ahora", texto: "⚠️ " + item.aviso }) : null,
    ]);
    return nodo("label", { clase: "ia-row" + (item.dudoso ? " dudoso" : "") }, [cb, txt]);
  }

  function seccion(titulo, hijos) {
    return nodo("div", { clase: "ia-sec" }, [nodo("h3", { texto: titulo })].concat(hijos));
  }

  function mostrarVistaPrevia(p, cat, formEl) {
    const v = abrirPanel("Revisa lo que detectó la IA", "Nada se aplica hasta que pulses «Aplicar».");
    const cuerpo = v.cuerpo;

    if (p.confirmado === false) {
      cuerpo.appendChild(nodo("div", { clase: "ia-aviso", texto: "⚠️ La conversación no parece tener un pedido confirmado (puede ser solo una consulta o una negociación abierta). Revisa con cuidado." }));
    }
    if (p.nuevos.length) {
      cuerpo.appendChild(seccion("Datos detectados (campos vacíos)", p.nuevos.map((i) => fila(v, i, { marcado: !i.dudoso }))));
    }
    if (p.cambios.length) {
      cuerpo.appendChild(seccion("Cambios en campos que ya tenían datos (no se aplican salvo que los marques)", p.cambios.map((i) => fila(v, i, { marcado: false }))));
    }
    if (p.conflictos.length) {
      const bloques = p.conflictos.map((c) => {
        const nombre = "ia_conf_" + c.id;
        const opts = c.opciones.map((o, idx) => {
          const r = nodo("input", { type: "radio", name: nombre, value: String(idx) });
          r.addEventListener("change", () => actualizarContador(v));
          return nodo("label", { clase: "ia-opt" }, [r, nodo("span", { texto: o })]);
        });
        const ninguna = nodo("input", { type: "radio", name: nombre, value: "-1" });
        ninguna.checked = true;
        ninguna.addEventListener("change", () => actualizarContador(v));
        opts.push(nodo("label", { clase: "ia-opt" }, [ninguna, nodo("span", { texto: "Ninguna (lo decido yo)" })]));
        c.radios = opts;
        return nodo("div", { clase: "ia-row" }, [nodo("div", { clase: "ia-txt" }, [
          nodo("span", { clase: "ia-lbl", texto: c.label }),
          c.motivo ? nodo("div", { clase: "ia-motivo", texto: c.motivo }) : null,
        ].concat(opts))]);
      });
      cuerpo.appendChild(seccion("Datos contradictorios: elige cuál vale", bloques));
    }
    if (p.obs.length || p.extras.length) {
      const piezas = p.obs.concat(p.extras);
      cuerpo.appendChild(seccion("Observaciones y datos sin campo en esta planilla (se añaden a Observaciones)", piezas.map((i) => fila(v, i, { marcado: i.marcado }))));
    }
    if (p.pendientes.length) {
      cuerpo.appendChild(seccion("Pendientes (no aparecen en la conversación)", [nodo("div", { clase: "ia-lista", texto: p.pendientes.join(" · ") })]));
    }
    if (p.avisos.length) {
      cuerpo.appendChild(seccion("Avisos", p.avisos.map((a) => nodo("div", { clase: "ia-aviso", texto: a }))));
    }
    if (p.coinciden) {
      cuerpo.appendChild(nodo("div", { clase: "ia-info", texto: p.coinciden + " dato(s) ya coinciden con lo que tenías escrito." }));
    }
    if (!p.nuevos.length && !p.cambios.length && !p.conflictos.length && !p.obs.length && !p.extras.length) {
      cuerpo.appendChild(nodo("div", { clase: "ia-info", texto: "La IA no encontró datos nuevos que aplicar." }));
    }

    const aplicarBtn = boton("Aplicar", "btn-primary", () => aplicar(p, cat, formEl));
    aplicarBtn.id = "iaAplicar";
    v.pie.appendChild(boton("Cancelar", "btn-outline", cerrarPanel));
    v.pie.appendChild(aplicarBtn);
    v.propuesta = p;
    actualizarContador(v);
    aplicarBtn.focus();
  }

  function seleccionados(p) {
    const lista = [];
    p.nuevos.concat(p.cambios).forEach((i) => { if (i.cb && i.cb.checked) lista.push({ id: i.id, valor: i.valor }); });
    p.conflictos.forEach((c) => {
      const marcado = (c.radios || []).map((l) => l.querySelector("input")).filter((r) => r.checked)[0];
      const idx = marcado ? parseInt(marcado.value, 10) : -1;
      if (idx >= 0) lista.push({ id: c.id, valor: c.opciones[idx] });
    });
    return lista;
  }

  function piezasObs(p) {
    return p.obs.concat(p.extras).filter((i) => i.cb && i.cb.checked).map((i) => i.texto);
  }

  function actualizarContador(v) {
    const p = v.propuesta;
    if (!p) return;
    const n = seleccionados(p).length + (piezasObs(p).length ? 1 : 0);
    const btn = $("iaAplicar");
    if (btn) { btn.textContent = n ? "Aplicar (" + n + ")" : "Aplicar"; btn.disabled = n === 0; }
  }

  // ------------------------------------------------------- aplicar a los campos reales
  function asignar(formEl, id, valor) {
    const campo = formEl.elements.namedItem(id);
    if (!campo || campo.readOnly || campo.disabled) return false;
    if (campo.tagName === "SELECT") {
      let existe = false;
      for (let i = 0; i < campo.options.length; i++) if (campo.options[i].value === valor) existe = true;
      if (!existe) return false;
    }
    campo.value = valor;
    campo.classList.add("autofilled");
    setTimeout(() => campo.classList.remove("autofilled"), 4000);
    // Dispara el autoguardado de borradores del script principal.
    campo.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  function aplicar(p, cat, formEl) {
    let n = 0;
    seleccionados(p).forEach((s) => { if (asignar(formEl, s.id, s.valor)) n += 1; });
    const piezas = piezasObs(p);
    if (piezas.length) {
      const obs = formEl.elements.namedItem("observaciones");
      const actual = (obs.value || "").trim();
      const nuevo = piezas.join("; ").slice(0, MAX_FIELD.observaciones);
      if (asignar(formEl, "observaciones", actual ? actual + " | " + nuevo : nuevo)) n += 1;
    }
    cerrarPanel();
    const res = $("autofillResult");
    if (res) res.textContent = n > 0
      ? "✅ La IA completó " + n + " campo(s). Revisa y corrige antes de enviar."
      : "No se aplicó ningún dato.";
    scheduleSave(formEl, cat.storageKey);
  }

  // ----------------------------------------------------------------- arranque
  function iniciar() {
    const area = $("pasteInput");
    const btn = $("iaBtn");
    if (!area || !btn) return;
    btn.addEventListener("click", iniciarAnalisis);

    // El texto pegado se conserva en este dispositivo (como los borradores) hasta que lo borres.
    try { const guardado = localStorage.getItem(PASTE_STORAGE); if (guardado && !area.value) area.value = guardado; } catch (e) { /* nada */ }
    let t = null;
    area.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => { try { localStorage.setItem(PASTE_STORAGE, area.value); } catch (e) { /* nada */ } }, 400);
    });
    const borrar = $("clearPasteBtn");
    if (borrar) borrar.addEventListener("click", () => { try { localStorage.removeItem(PASTE_STORAGE); } catch (e) { /* nada */ } });
  }

  iniciar();
})();
