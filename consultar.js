import { chromium } from 'playwright';
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

  if (estado === 'detalle') {
    const r = await procesarDetalle(page, numero, alias ?? numero, directorioSalida);
    return [r];
  }

  if (estado === 'listado') {
    const fila = page.locator('table tr').filter({ hasText: numero }).first();
    await entrarAlDetalleDesdeFila(page, fila);
    const r = await procesarDetalle(page, numero, alias ?? numero, directorioSalida);
    return [r];
  }

  // estado === 'varios-registros': hay N coincidencias en la lista.
  const cantidad = await page.locator('table tr').filter({ hasText: numero }).count();
  console.log(
    `  ℹ Encontradas ${cantidad} coincidencias para este radicado; consultaré cada una.`,
  );

  const resultados = [];
  for (let i = 0; i < cantidad; i += 1) {
    const sufijoIdx = `-${String(i + 1).padStart(2, '0')}`;
    const aliasCompleto = `${alias ?? numero}${sufijoIdx}`;

    // Para la segunda y siguientes iteraciones re-hacemos la búsqueda desde
    // cero para volver a un estado limpio del listado.
    if (i > 0) {
      await realizarBusqueda(page, numero);
    }

    const fila = page.locator('table tr').filter({ hasText: numero }).nth(i);
    try {
      await entrarAlDetalleDesdeFila(page, fila);
      const r = await procesarDetalle(page, numero, aliasCompleto, directorioSalida);
      resultados.push(r);
    } catch (err) {
      console.error(
        `  ✘ Error procesando coincidencia ${i + 1}/${cantidad} (${aliasCompleto}): ${err.message}`,
      );
    }
  }

  return resultados;
}

async function main() {
  const argRadicado = process.argv[2];
  const directorioSalida = path.resolve('resultados');
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

  const resumen = [];
  for (const { numero, alias } of radicados) {
    try {
      const resultados = await consultarRadicado(page, numero, alias, directorioSalida);
      if (resultados.length === 0) {
        resumen.push({ numero, alias, ok: false, error: 'No se pudo procesar ninguna coincidencia.' });
      } else if (resultados.length === 1) {
        resumen.push({
          numero,
          alias,
          ok: true,
          total: resultados[0].totalActuacionesEnPortal,
        });
      } else {
        resultados.forEach((r, idx) => {
          resumen.push({
            numero,
            alias: `${alias ?? ''}-${String(idx + 1).padStart(2, '0')}`,
            ok: true,
            total: r.totalActuacionesEnPortal,
          });
        });
      }
    } catch (error) {
      console.error(`  ✘ Error con ${numero}:`, error.message);
      const rutaError = path.join(
        directorioSalida,
        `error_${numero}_${timestampParaNombre(new Date())}.png`,
      );
      await page.screenshot({ path: rutaError, fullPage: true }).catch(() => {});
      resumen.push({ numero, alias, ok: false, error: error.message });
    }
  }

  await browser.close();

  console.log('\n=== Resumen ===');
  for (const r of resumen) {
    const estado = r.ok ? `OK (${r.total} actuaciones)` : `FALLA (${r.error})`;
    console.log(`  ${r.alias ?? ''} ${r.numero}: ${estado}`);
  }
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
