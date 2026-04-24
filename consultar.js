import { chromium } from 'playwright';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const URL_BASE = 'https://consultaprocesos.ramajudicial.gov.co/Procesos/NumeroRadicacion';
const TIMEOUT_NAV = 60_000;
const TIMEOUT_CONSULTA = 90_000;
const LIMITE_ACTUACIONES = 3;

function timestampParaNombre(fecha) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${fecha.getFullYear()}-${p(fecha.getMonth() + 1)}-${p(fecha.getDate())}_` +
    `${p(fecha.getHours())}${p(fecha.getMinutes())}${p(fecha.getSeconds())}`
  );
}

function timestampLegible(fecha) {
  return fecha.toLocaleString('es-CO', {
    dateStyle: 'full',
    timeStyle: 'long',
    timeZone: 'America/Bogota',
  });
}

function slugificar(texto) {
  return (texto ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function inyectarBannerTimestamp(page, texto) {
  await page.evaluate((t) => {
    const id = '__banner_consulta__';
    document.getElementById(id)?.remove();
    const div = document.createElement('div');
    div.id = id;
    div.textContent = `Consulta automatizada · ${t}`;
    Object.assign(div.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      zIndex: '2147483647',
      background: '#111',
      color: '#fff',
      padding: '8px 14px',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '14px',
      textAlign: 'center',
      borderBottom: '2px solid #ffcc00',
    });
    document.body.appendChild(div);
  }, texto);
}

// Realiza la búsqueda (navega, marca "Todos los Procesos", escribe el radicado
// y pulsa Consultar). Devuelve un string con el estado tras la consulta:
// 'detalle'           → ya estamos en la vista de detalle de un único proceso
// 'listado'           → hay una lista con al menos una fila que contiene el radicado
// 'varios-registros'  → apareció el diálogo "Se han encontrado varios registros"
//                        (ya se cerró con VOLVER antes de retornar)
// Lanza error si el portal responde "La consulta no generó resultados".
async function realizarBusqueda(page, numero) {
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_NAV });

  const estrategiasRadioTodos = [
    () => page.getByRole('radio', { name: /Todos los Procesos/i }),
    () => page.locator('mat-radio-button').filter({ hasText: /Todos los Procesos/i }),
    () => page.locator('label').filter({ hasText: /Todos los Procesos/i }),
    () => page.getByText(/Todos los Procesos/i).first(),
  ];
  for (const obtener of estrategiasRadioTodos) {
    const locator = obtener();
    if ((await locator.count()) === 0) continue;
    try {
      await locator.first().click({ timeout: 5000 });
      break;
    } catch {
      /* probar siguiente */
    }
  }

  const inputRadicado = page
    .locator(
      'input#txtRadicacion, input[name="txtRadicacion"], input[placeholder*="Radicación" i], input[placeholder*="radicado" i]',
    )
    .first();
  await inputRadicado.waitFor({ state: 'visible', timeout: TIMEOUT_NAV });
  await inputRadicado.fill(numero);

  const botonConsultar = page.getByRole('button', { name: /consultar/i }).first();
  await botonConsultar.click();

  const esperaDetalle = page
    .getByText(/DETALLE DEL PROCESO/i)
    .first()
    .waitFor({ state: 'visible', timeout: TIMEOUT_CONSULTA });
  const esperaFila = page
    .locator('table tr')
    .filter({ hasText: numero })
    .first()
    .waitFor({ state: 'visible', timeout: TIMEOUT_CONSULTA });
  const esperaSinResultados = page
    .getByText(/La consulta no generó resultados/i)
    .first()
    .waitFor({ state: 'visible', timeout: TIMEOUT_CONSULTA });
  const esperaVariosRegistros = page
    .getByText(/Se han encontrado varios registros/i)
    .first()
    .waitFor({ state: 'visible', timeout: TIMEOUT_CONSULTA });

  await Promise.race([
    esperaDetalle,
    esperaFila,
    esperaSinResultados,
    esperaVariosRegistros,
  ]).catch(() => {});

  if ((await page.getByText(/La consulta no generó resultados/i).count()) > 0) {
    throw new Error('El portal devolvió "La consulta no generó resultados".');
  }

  const hayVariosRegistros =
    (await page.getByText(/Se han encontrado varios registros/i).count()) > 0;

  if (hayVariosRegistros) {
    // Cerrar el diálogo para que quede visible la lista detrás.
    const botonVolver = page.getByRole('button', { name: /^\s*volver\s*$/i }).first();
    if ((await botonVolver.count()) > 0) {
      await botonVolver.click({ timeout: 5000 }).catch(() => {});
    } else {
      await page
        .locator('xpath=//*[normalize-space(text())="VOLVER"]')
        .first()
        .click({ timeout: 5000 })
        .catch(() => {});
    }
    await page
      .getByText(/Se han encontrado varios registros/i)
      .first()
      .waitFor({ state: 'hidden', timeout: 10_000 })
      .catch(() => {});
    return 'varios-registros';
  }

  if ((await page.getByText(/DETALLE DEL PROCESO/i).count()) > 0) {
    return 'detalle';
  }

  if ((await page.locator('table tr').filter({ hasText: numero }).count()) > 0) {
    return 'listado';
  }

  throw new Error('No logré interpretar el estado de la página tras la búsqueda.');
}

async function entrarAlDetalleDesdeFila(page, fila) {
  const clicable = fila.locator('a, button').first();
  if ((await clicable.count()) > 0) {
    await clicable.click({ timeout: 10_000 }).catch(() => {});
  } else {
    await fila.click({ timeout: 10_000 }).catch(() => {});
  }
  await page
    .getByText(/DETALLE DEL PROCESO/i)
    .first()
    .waitFor({ state: 'visible', timeout: TIMEOUT_CONSULTA });
}

// Procesa la pestaña de Actuaciones del detalle actualmente visible:
// clic en "ACTUACIONES", espera la tabla real, extrae filas, oculta las
// antiguas, estampa banner, toma captura y guarda JSON.
async function procesarDetalle(page, numero, aliasCompleto, directorioSalida) {
  const inicio = new Date();

  await page
    .locator('xpath=//*[normalize-space(text())="ACTUACIONES"]')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => {});

  const estrategiasTab = [
    () => page.locator('mat-tab-label').filter({ hasText: 'ACTUACIONES' }),
    () => page.locator('.mat-tab-label').filter({ hasText: 'ACTUACIONES' }),
    () => page.locator('.mat-mdc-tab').filter({ hasText: 'ACTUACIONES' }),
    () => page.locator('.mdc-tab').filter({ hasText: 'ACTUACIONES' }),
    () => page.locator('[role="tab"]').filter({ hasText: 'ACTUACIONES' }),
    () => page.locator('a, button').filter({ hasText: /^\s*ACTUACIONES\s*$/ }),
    () => page.locator('xpath=//*[normalize-space(text())="ACTUACIONES"]'),
  ];

  let estrategiaUsada = null;
  for (const obtener of estrategiasTab) {
    const locator = obtener();
    if ((await locator.count()) === 0) continue;
    try {
      await locator.first().scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await locator.first().click({ timeout: 5000 });
      estrategiaUsada =
        obtener.toString().match(/\('(.+?)'\)|locator\((.+?)\)/)?.[0] ?? 'desconocida';
      break;
    } catch {
      /* probar siguiente */
    }
  }

  if (!estrategiaUsada) {
    console.warn('  ⚠ No pude hacer clic en la pestaña Actuaciones. Guardando HTML para depurar.');
    const rutaHtml = path.join(
      directorioSalida,
      `dump_${numero}_${timestampParaNombre(new Date())}.html`,
    );
    await writeFile(rutaHtml, await page.content(), 'utf8').catch(() => {});
    console.warn(`    HTML guardado en: ${rutaHtml}`);
  } else {
    console.log(`  ✔ Clic en Actuaciones con estrategia: ${estrategiaUsada}`);
  }

  await page
    .waitForFunction(
      () => {
        const tablas = Array.from(document.querySelectorAll('table'));
        return tablas.some((t) => {
          const textoTh = Array.from(t.querySelectorAll('th'))
            .map((th) => th.innerText.toLowerCase())
            .join(' ');
          if (!textoTh.includes('actuaci')) return false;
          const filasDatos = Array.from(t.querySelectorAll('tr')).filter(
            (tr) => tr.querySelectorAll('td').length > 0,
          );
          if (filasDatos.length === 0) return false;
          const textoFilas = filasDatos.map((tr) => tr.innerText.toLowerCase()).join(' ');
          return !textoFilas.includes('cargando');
        });
      },
      { timeout: 45_000 },
    )
    .catch(() => {});

  await page.waitForLoadState('networkidle', { timeout: TIMEOUT_CONSULTA }).catch(() => {});

  const actuaciones = await page.evaluate(() => {
    const tablas = Array.from(document.querySelectorAll('table'));
    const encabezadosVistos = tablas.map((t) =>
      Array.from(t.querySelectorAll('th'))
        .map((th) => th.innerText.trim())
        .join(' | '),
    );
    const tablaActuaciones = tablas.find((t) => {
      const textoTh = Array.from(t.querySelectorAll('th'))
        .map((th) => th.innerText.toLowerCase())
        .join(' ');
      return textoTh.includes('actuaci');
    });
    if (!tablaActuaciones) {
      return { filas: [], encabezadosDisponibles: encabezadosVistos };
    }
    const columnas = Array.from(tablaActuaciones.querySelectorAll('th')).map((th) =>
      th.innerText.trim(),
    );
    const filas = Array.from(tablaActuaciones.querySelectorAll('tr'))
      .map((fila) => Array.from(fila.querySelectorAll('td')).map((td) => td.innerText.trim()))
      .filter((celdas) => celdas.length > 0)
      .filter((celdas) => !celdas.join(' ').toLowerCase().includes('cargando'))
      .map((celdas) => {
        const registro = {};
        celdas.forEach((valor, idx) => {
          const clave = columnas[idx] || `col_${idx}`;
          if (clave.startsWith('col_') && valor === '') return;
          registro[clave] = valor;
        });
        return registro;
      });
    return { filas, encabezadosDisponibles: encabezadosVistos };
  });

  if (actuaciones.filas.length === 0) {
    console.warn(
      `  ⚠ No encontré tabla de actuaciones. Encabezados detectados: ${JSON.stringify(
        actuaciones.encabezadosDisponibles,
      )}`,
    );
  }

  const totalEncontradas = actuaciones.filas.length;
  const actuacionesRecientes = actuaciones.filas.slice(0, LIMITE_ACTUACIONES);

  await page.evaluate((limite) => {
    const tablas = Array.from(document.querySelectorAll('table'));
    const tabla = tablas.find((t) => {
      const textoTh = Array.from(t.querySelectorAll('th'))
        .map((th) => th.innerText.toLowerCase())
        .join(' ');
      return textoTh.includes('actuaci');
    });
    if (!tabla) return;
    const filasDatos = Array.from(tabla.querySelectorAll('tr')).filter(
      (tr) => tr.querySelectorAll('td').length > 0,
    );
    filasDatos.slice(limite).forEach((tr) => {
      tr.style.display = 'none';
    });
  }, LIMITE_ACTUACIONES);

  const fin = new Date();
  const leyenda = `${numero} · ${timestampLegible(fin)} · Mostrando ${Math.min(
    LIMITE_ACTUACIONES,
    totalEncontradas,
  )} de ${totalEncontradas} actuaciones`;
  await inyectarBannerTimestamp(page, leyenda).catch(() => {});

  const aliasSlug = slugificar(aliasCompleto);
  const prefijoAlias = aliasSlug ? `${aliasSlug}_` : '';
  const sufijo = `${prefijoAlias}${numero}_${timestampParaNombre(fin)}`;
  const rutaScreenshot = path.join(directorioSalida, `captura_${sufijo}.png`);
  const rutaJson = path.join(directorioSalida, `actuaciones_${sufijo}.json`);

  await page.screenshot({ path: rutaScreenshot, fullPage: true });

  const resultado = {
    radicado: numero,
    alias: aliasCompleto ?? null,
    consultadoEn: fin.toISOString(),
    consultadoEnBogota: timestampLegible(fin),
    duracionMs: fin.getTime() - inicio.getTime(),
    url: page.url(),
    totalActuacionesEnPortal: totalEncontradas,
    actuacionesDevueltas: actuacionesRecientes.length,
    actuaciones: actuacionesRecientes,
    rutaScreenshot,
  };

  await writeFile(rutaJson, JSON.stringify(resultado, null, 2), 'utf8');
  console.log(`  ✔ Captura:     ${rutaScreenshot}`);
  console.log(
    `  ✔ Actuaciones: ${actuacionesRecientes.length} más recientes de ${totalEncontradas} (JSON: ${rutaJson})`,
  );

  return resultado;
}

async function consultarRadicado(page, numero, alias, directorioSalida) {
  console.log(`\n[${alias ?? numero}] Consultando ${numero}…`);
  const estado = await realizarBusqueda(page, numero);

  if (estado === 'detalle' || estado === 'listado') {
    if (estado === 'listado') {
      const fila = page.locator('table tr').filter({ hasText: numero }).first();
      await entrarAlDetalleDesdeFila(page, fila);
    }
    try {
      const r = await procesarDetalle(page, numero, alias ?? numero, directorioSalida);
      return [{ ok: true, subindice: null, resultado: r }];
    } catch (err) {
      return [{ ok: false, subindice: null, error: err.message }];
    }
  }

  // estado === 'varios-registros'
  const cantidad = await page.locator('table tr').filter({ hasText: numero }).count();
  console.log(
    `  ℹ Encontradas ${cantidad} coincidencias para este radicado; consultaré cada una.`,
  );

  const salidas = [];
  for (let i = 0; i < cantidad; i += 1) {
    const subindice = i + 1;
    const sufijoIdx = `-${String(subindice).padStart(2, '0')}`;
    const aliasCompleto = `${alias ?? numero}${sufijoIdx}`;

    if (i > 0) {
      try {
        await realizarBusqueda(page, numero);
      } catch (err) {
        console.error(`  ✘ Re-búsqueda para coincidencia ${subindice}/${cantidad}: ${err.message}`);
        salidas.push({ ok: false, subindice, error: `re-búsqueda: ${err.message}` });
        continue;
      }
    }

    const fila = page.locator('table tr').filter({ hasText: numero }).nth(i);
    try {
      await entrarAlDetalleDesdeFila(page, fila);
      const r = await procesarDetalle(page, numero, aliasCompleto, directorioSalida);
      salidas.push({ ok: true, subindice, resultado: r });
    } catch (err) {
      console.error(
        `  ✘ Error procesando coincidencia ${subindice}/${cantidad} (${aliasCompleto}): ${err.message}`,
      );
      salidas.push({ ok: false, subindice, error: err.message });
    }
  }

  return salidas;
}

// Errores que consideramos transitorios (vale la pena reintentar). El
// "no generó resultados" y similares NO entran, porque son respuestas
// legítimas del portal, no fallas de red o render.
const PATRONES_TRANSITORIOS = [
  /Timeout \d+ms exceeded/i,
  /No logré interpretar el estado/i,
  /net::ERR_/i,
];

function esErrorTransitorio(mensaje) {
  if (!mensaje) return false;
  return PATRONES_TRANSITORIOS.some((re) => re.test(mensaje));
}

function aliasConSubindice(alias, subindice) {
  if (subindice == null) return alias ?? '';
  const pad = String(subindice).padStart(2, '0');
  return `${alias ?? ''}-${pad}`;
}

function parseFechaISO(valor) {
  if (!valor || typeof valor !== 'string') return null;
  const m = valor.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fechaISOEnBogota(fecha) {
  // toLocaleDateString('en-CA') da el formato YYYY-MM-DD.
  return fecha.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

const DIAS_MOVIMIENTO_RECIENTE = 5;

function clasificarEntrada(entrada, umbral) {
  if (!entrada.ok) return { tipo: 'falla' };
  const actuaciones = entrada.resultado.actuaciones ?? [];
  if (actuaciones.length === 0) {
    return { tipo: 'sin-actuaciones' };
  }
  const recientes = actuaciones.filter((a) => {
    const fecha = parseFechaISO(a['Fecha de Registro'] ?? a['Fecha de Actuación']);
    return fecha && fecha >= umbral;
  });
  if (recientes.length > 0) {
    return { tipo: 'con-movimiento', recientes };
  }
  const ultima = actuaciones[0];
  const fechaUltima = ultima['Fecha de Registro'] ?? ultima['Fecha de Actuación'] ?? '?';
  return { tipo: 'sin-movimiento', fechaUltima };
}

async function generarPDFCompleto(entradas, directorioSalida, fechaConsulta) {
  const pdf = await PDFDocument.create();
  const fuente = await pdf.embedFont(StandardFonts.Helvetica);
  const fuenteBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const ANCHO = 612; // carta en puntos (8.5 x 11 pulgadas)
  const ALTO = 792;
  const MARGEN = 36;
  const CABECERA_ALTO = 48;
  const COLOR_TEXTO = rgb(0.12, 0.12, 0.12);
  const COLOR_GRIS = rgb(0.45, 0.45, 0.45);

  // --- Portada ---
  const portada = pdf.addPage([ANCHO, ALTO]);
  const fechaStr = fechaISOEnBogota(fechaConsulta);
  portada.drawText('Consulta de radicados', {
    x: MARGEN,
    y: ALTO - MARGEN - 30,
    size: 22,
    font: fuenteBold,
    color: COLOR_TEXTO,
  });
  portada.drawText(`Rama Judicial · ${fechaStr}`, {
    x: MARGEN,
    y: ALTO - MARGEN - 58,
    size: 13,
    font: fuente,
    color: COLOR_GRIS,
  });

  const umbral = new Date(fechaConsulta);
  umbral.setDate(umbral.getDate() - DIAS_MOVIMIENTO_RECIENTE);
  const conteo = { conMovimiento: 0, sinMovimiento: 0, sinActuaciones: 0, fallas: 0 };
  const listaConMovimiento = [];
  const listaFallas = [];
  for (const e of entradas) {
    const clasif = clasificarEntrada(e, umbral);
    const etiqueta = aliasConSubindice(e.alias, e.subindice);
    if (clasif.tipo === 'falla') {
      conteo.fallas += 1;
      const errBreve = (e.error ?? '').replace(/\s+/g, ' ').slice(0, 80);
      listaFallas.push(`${etiqueta} · ${e.numero} — ${errBreve}`);
    } else if (clasif.tipo === 'sin-actuaciones') {
      conteo.sinActuaciones += 1;
    } else if (clasif.tipo === 'con-movimiento') {
      conteo.conMovimiento += 1;
      listaConMovimiento.push(`${etiqueta} · ${e.numero}`);
    } else {
      conteo.sinMovimiento += 1;
    }
  }

  const lineasResumen = [
    `Total de entradas procesadas: ${entradas.length}`,
    `Con movimiento en los últimos ${DIAS_MOVIMIENTO_RECIENTE} días: ${conteo.conMovimiento}`,
    `Sin movimiento reciente: ${conteo.sinMovimiento}`,
    `Sin actuaciones registradas: ${conteo.sinActuaciones}`,
    `Fallas: ${conteo.fallas}`,
  ];
  let y = ALTO - MARGEN - 110;
  for (const linea of lineasResumen) {
    portada.drawText(linea, { x: MARGEN, y, size: 12, font: fuente, color: COLOR_TEXTO });
    y -= 18;
  }
  y -= 10;

  // Listas detalladas: radicados con movimiento y radicados con error. Si se
  // extienden más allá de la portada, continúan en páginas adicionales.
  let paginaActual = portada;
  const asegurarEspacio = (altura) => {
    if (y - altura < MARGEN) {
      paginaActual = pdf.addPage([ANCHO, ALTO]);
      y = ALTO - MARGEN;
    }
  };

  const dibujarSeccion = (titulo, items) => {
    if (items.length === 0) return;
    asegurarEspacio(26);
    paginaActual.drawText(titulo, {
      x: MARGEN,
      y,
      size: 13,
      font: fuenteBold,
      color: COLOR_TEXTO,
    });
    y -= 18;
    for (const item of items) {
      asegurarEspacio(13);
      const recortado = item.length > 100 ? `${item.slice(0, 97)}…` : item;
      paginaActual.drawText(`• ${recortado}`, {
        x: MARGEN,
        y,
        size: 10,
        font: fuente,
        color: COLOR_TEXTO,
      });
      y -= 13;
    }
    y -= 10;
  };

  dibujarSeccion(
    `Con movimiento reciente (${listaConMovimiento.length})`,
    listaConMovimiento,
  );
  dibujarSeccion(`Fallas (${listaFallas.length})`, listaFallas);

  // Nota de ordenamiento al pie, si todavía queda espacio en la página donde
  // terminamos; si no, la omitimos para no añadir una página casi vacía.
  if (y > MARGEN + 60) {
    paginaActual.drawText(
      'Orden de las capturas: primero los procesos con movimiento reciente, luego',
      { x: MARGEN, y: MARGEN + 30, size: 10, font: fuente, color: COLOR_GRIS },
    );
    paginaActual.drawText(
      'sin movimiento, luego sin actuaciones. Cada página muestra alias, radicado y PNG.',
      { x: MARGEN, y: MARGEN + 16, size: 10, font: fuente, color: COLOR_GRIS },
    );
  }

  // --- Una página por cada captura; primero las de procesos con movimiento
  // reciente para facilitar la revisión manual. Dentro de cada grupo se
  // conserva el orden original de radicados.json (sort estable en Node).
  const PRIORIDAD_TIPO = {
    'con-movimiento': 0,
    'sin-movimiento': 1,
    'sin-actuaciones': 2,
  };
  const entradasConCaptura = entradas
    .filter((e) => e.ok && e.resultado?.rutaScreenshot && existsSync(e.resultado.rutaScreenshot))
    .map((e) => ({ entrada: e, clasif: clasificarEntrada(e, umbral) }))
    .sort((a, b) => (PRIORIDAD_TIPO[a.clasif.tipo] ?? 9) - (PRIORIDAD_TIPO[b.clasif.tipo] ?? 9));

  for (let i = 0; i < entradasConCaptura.length; i += 1) {
    const { entrada: e, clasif } = entradasConCaptura[i];
    const etiqueta = aliasConSubindice(e.alias, e.subindice);
    const marcaMovimiento =
      clasif.tipo === 'con-movimiento' ? '  ·  movimiento reciente' : '';
    const cabecera = `${etiqueta}  ·  ${e.numero}${marcaMovimiento}`;

    let pngBytes;
    try {
      pngBytes = await readFile(e.resultado.rutaScreenshot);
    } catch {
      continue;
    }

    let imagen;
    try {
      imagen = await pdf.embedPng(pngBytes);
    } catch {
      continue;
    }

    const anchoUtil = ANCHO - MARGEN * 2;
    const altoUtil = ALTO - MARGEN * 2 - CABECERA_ALTO;
    const escala = Math.min(anchoUtil / imagen.width, altoUtil / imagen.height, 1);
    const anchoDibujo = imagen.width * escala;
    const altoDibujo = imagen.height * escala;

    const pagina = pdf.addPage([ANCHO, ALTO]);
    pagina.drawText(cabecera, {
      x: MARGEN,
      y: ALTO - MARGEN - 12,
      size: 12,
      font: fuenteBold,
      color: COLOR_TEXTO,
    });
    pagina.drawText(`Página ${i + 1} de ${entradasConCaptura.length}`, {
      x: MARGEN,
      y: ALTO - MARGEN - 28,
      size: 9,
      font: fuente,
      color: COLOR_GRIS,
    });

    const xImagen = MARGEN + (anchoUtil - anchoDibujo) / 2;
    const yImagen = MARGEN + (altoUtil - altoDibujo) / 2;
    pagina.drawImage(imagen, {
      x: xImagen,
      y: yImagen,
      width: anchoDibujo,
      height: altoDibujo,
    });

    if ((i + 1) % 10 === 0) {
      console.log(`  · PDF: ${i + 1}/${entradasConCaptura.length} páginas embebidas…`);
    }
  }

  const rutaPDF = path.join(
    directorioSalida,
    `consolidado_${timestampParaNombre(fechaConsulta)}.pdf`,
  );
  const bytes = await pdf.save();
  await writeFile(rutaPDF, bytes);
  return { rutaPDF, paginasAgregadas: entradasConCaptura.length };
}

async function generarResumen(entradas, directorioSalida, fechaConsulta) {
  const umbral = new Date(fechaConsulta);
  umbral.setDate(umbral.getDate() - DIAS_MOVIMIENTO_RECIENTE);

  const conMovimiento = [];
  const sinMovimiento = [];
  const sinActuaciones = [];
  const fallas = [];

  for (const e of entradas) {
    const clasif = clasificarEntrada(e, umbral);
    if (clasif.tipo === 'falla') fallas.push(e);
    else if (clasif.tipo === 'sin-actuaciones') sinActuaciones.push(e);
    else if (clasif.tipo === 'con-movimiento') conMovimiento.push({ ...e, recientes: clasif.recientes });
    else sinMovimiento.push({ ...e, fechaUltima: clasif.fechaUltima });
  }

  const fechaStr = fechaISOEnBogota(fechaConsulta);
  const lineas = [];
  lineas.push(`# Consulta de radicados · ${fechaStr}`);
  lineas.push('');
  lineas.push(`- Total de entradas procesadas: **${entradas.length}**`);
  lineas.push(`- Con movimiento en los últimos ${DIAS_MOVIMIENTO_RECIENTE} días: **${conMovimiento.length}**`);
  lineas.push(`- Sin movimiento reciente: **${sinMovimiento.length}**`);
  if (sinActuaciones.length > 0) {
    lineas.push(`- Sin actuaciones registradas: **${sinActuaciones.length}**`);
  }
  lineas.push(`- Fallas: **${fallas.length}**`);
  lineas.push('');

  if (conMovimiento.length > 0) {
    lineas.push(`## Con movimiento en los últimos ${DIAS_MOVIMIENTO_RECIENTE} días (${conMovimiento.length})`);
    lineas.push('');
    for (const e of conMovimiento) {
      const etiqueta = aliasConSubindice(e.alias, e.subindice);
      lineas.push(`### ${etiqueta} — ${e.numero}`);
      for (const a of e.recientes) {
        const fecha = a['Fecha de Registro'] ?? a['Fecha de Actuación'] ?? '?';
        const tipo = a['Actuación'] ?? '';
        const nota = a['Anotación'] ?? '';
        const piezas = [`**${fecha}**`, tipo, nota].filter((x) => x && x.length > 0);
        lineas.push(`- ${piezas.join(' · ')}`);
      }
      lineas.push('');
    }
  }

  if (sinMovimiento.length > 0) {
    lineas.push(`## Sin movimiento reciente (${sinMovimiento.length})`);
    lineas.push('');
    for (const e of sinMovimiento) {
      const etiqueta = aliasConSubindice(e.alias, e.subindice);
      lineas.push(`- ${etiqueta} — ${e.numero} — última: ${e.fechaUltima}`);
    }
    lineas.push('');
  }

  if (sinActuaciones.length > 0) {
    lineas.push(`## Sin actuaciones registradas (${sinActuaciones.length})`);
    lineas.push('');
    for (const e of sinActuaciones) {
      const etiqueta = aliasConSubindice(e.alias, e.subindice);
      lineas.push(`- ${etiqueta} — ${e.numero}`);
    }
    lineas.push('');
  }

  if (fallas.length > 0) {
    lineas.push(`## Fallas (${fallas.length})`);
    lineas.push('');
    for (const e of fallas) {
      const etiqueta = aliasConSubindice(e.alias, e.subindice);
      const marca = e.reintentado ? ' [reintento]' : '';
      lineas.push(`- ${etiqueta} — ${e.numero}: ${e.error}${marca}`);
    }
    lineas.push('');
  }

  const rutaResumen = path.join(
    directorioSalida,
    `resumen_${timestampParaNombre(fechaConsulta)}.md`,
  );
  await writeFile(rutaResumen, lineas.join('\n'), 'utf8');
  return rutaResumen;
}

async function procesarRadicado(page, { numero, alias }, directorioSalida) {
  try {
    return await consultarRadicado(page, numero, alias, directorioSalida);
  } catch (error) {
    console.error(`  ✘ Error con ${numero}:`, error.message);
    const rutaError = path.join(
      directorioSalida,
      `error_${numero}_${timestampParaNombre(new Date())}.png`,
    );
    await page.screenshot({ path: rutaError, fullPage: true }).catch(() => {});
    return [{ ok: false, subindice: null, error: error.message }];
  }
}

async function main() {
  const argRadicado = process.argv[2];
  const fechaConsulta = new Date();
  const directorioSalida = path.resolve('resultados', fechaISOEnBogota(fechaConsulta));
  if (!existsSync(directorioSalida)) {
    await mkdir(directorioSalida, { recursive: true });
  }

  let radicados;
  if (argRadicado) {
    radicados = [{ numero: argRadicado, alias: 'CLI' }];
  } else {
    const config = JSON.parse(await readFile('radicados.json', 'utf8'));
    radicados = config.radicados;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'es-CO',
    timezoneId: 'America/Bogota',
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();

  // Primer pase.
  const entradas = [];
  for (const radicado of radicados) {
    const salidas = await procesarRadicado(page, radicado, directorioSalida);
    salidas.forEach((s) => entradas.push({ ...radicado, ...s }));
  }

  // Identificar qué radicados necesitan reintento (con al menos una falla
  // transitoria). Reintentamos el radicado completo, no subprocesos sueltos.
  const radicadosAReintentar = new Set();
  for (const e of entradas) {
    if (!e.ok && esErrorTransitorio(e.error)) {
      radicadosAReintentar.add(e.numero);
    }
  }

  if (radicadosAReintentar.size > 0) {
    console.log(
      `\n=== Reintentando ${radicadosAReintentar.size} radicado(s) con fallas transitorias ===`,
    );
    for (const numero of radicadosAReintentar) {
      const radicado = radicados.find((r) => r.numero === numero);
      if (!radicado) continue;
      const nuevas = await procesarRadicado(page, radicado, directorioSalida);
      // Reemplazar en la lista de entradas todas las del mismo número.
      for (let i = entradas.length - 1; i >= 0; i -= 1) {
        if (entradas[i].numero === numero) entradas.splice(i, 1);
      }
      nuevas.forEach((s) => entradas.push({ ...radicado, ...s, reintentado: true }));
    }
  }

  await browser.close();

  console.log('\n=== Resumen ===');
  let okCount = 0;
  let fallaCount = 0;
  for (const e of entradas) {
    const aliasMostrado = aliasConSubindice(e.alias, e.subindice);
    const marca = e.reintentado ? ' [reintento]' : '';
    if (e.ok) {
      okCount += 1;
      console.log(
        `  ${aliasMostrado} ${e.numero}: OK (${e.resultado.totalActuacionesEnPortal} actuaciones)${marca}`,
      );
    } else {
      fallaCount += 1;
      console.log(`  ${aliasMostrado} ${e.numero}: FALLA (${e.error})${marca}`);
    }
  }
  console.log(`\nTotal: ${okCount} OK, ${fallaCount} fallas.`);

  try {
    const rutaResumen = await generarResumen(entradas, directorioSalida, fechaConsulta);
    console.log(`\n✔ Resumen guardado en: ${rutaResumen}`);
  } catch (err) {
    console.error('No pude generar el resumen:', err.message);
  }

  try {
    const { rutaPDF, paginasAgregadas } = await generarPDFCompleto(
      entradas,
      directorioSalida,
      fechaConsulta,
    );
    console.log(`✔ PDF consolidado (${paginasAgregadas} capturas): ${rutaPDF}`);
  } catch (err) {
    console.error('No pude generar el PDF consolidado:', err.message);
  }
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
