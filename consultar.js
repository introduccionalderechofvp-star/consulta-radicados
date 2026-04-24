import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const URL_BASE = 'https://consultaprocesos.ramajudicial.gov.co/Procesos/NumeroRadicacion';
const TIMEOUT_NAV = 60_000;
const TIMEOUT_CONSULTA = 90_000;

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

async function consultarRadicado(page, numero, alias, directorioSalida) {
  const inicio = new Date();
  console.log(`\n[${alias ?? numero}] Consultando ${numero}…`);

  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_NAV });

  const inputRadicado = page.locator('input#txtRadicacion, input[name="txtRadicacion"], input[placeholder*="Radicación" i], input[placeholder*="radicado" i]').first();
  await inputRadicado.waitFor({ state: 'visible', timeout: TIMEOUT_NAV });
  await inputRadicado.fill(numero);

  const botonConsultar = page.getByRole('button', { name: /consultar/i }).first();
  await botonConsultar.click();

  // El portal es una SPA y tarda ~30 s en renderizar el detalle; networkidle
  // se declara "idle" mucho antes de que los datos aparezcan en pantalla.
  // Esperamos explícitamente a "DETALLE DEL PROCESO" o a una fila con el
  // radicado (si hubiera varias coincidencias).
  const esperaDetalle = page
    .getByText(/DETALLE DEL PROCESO/i)
    .first()
    .waitFor({ state: 'visible', timeout: TIMEOUT_CONSULTA });
  const esperaFila = page
    .locator('table tr')
    .filter({ hasText: numero })
    .first()
    .waitFor({ state: 'visible', timeout: TIMEOUT_CONSULTA });

  await Promise.race([esperaDetalle, esperaFila]).catch(() => {});

  // Si caímos en un listado intermedio, clickeamos la fila para entrar al detalle.
  const detalleVisible = await page.getByText(/DETALLE DEL PROCESO/i).count();
  if (detalleVisible === 0) {
    const fila = page.locator('table tr').filter({ hasText: numero }).first();
    if ((await fila.count()) > 0) {
      const clicable = fila.locator('a, button').first();
      if ((await clicable.count()) > 0) {
        await clicable.click().catch(() => {});
      } else {
        await fila.click().catch(() => {});
      }
      await page
        .getByText(/DETALLE DEL PROCESO/i)
        .first()
        .waitFor({ state: 'visible', timeout: TIMEOUT_CONSULTA })
        .catch(() => {});
    }
  }

  // Antes de buscar la pestaña, asegurarnos de que el texto "ACTUACIONES"
  // esté en el DOM (el renderizado del bloque de tabs es asíncrono también).
  await page
    .locator('xpath=//*[normalize-space(text())="ACTUACIONES"]')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => {});

  // Abrir la pestaña de Actuaciones. Usamos locators nativos de Playwright
  // (disparan eventos de mouse reales, a diferencia de element.click() en JS,
  // que Angular Material a veces ignora). Probamos de más específico a más
  // genérico; el último recurso es un XPath que busca cualquier elemento
  // cuyo texto propio (sin descendientes) sea exactamente "ACTUACIONES".
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
      estrategiaUsada = obtener.toString().match(/\('(.+?)'\)|locator\((.+?)\)/)?.[0] ?? 'desconocida';
      break;
    } catch {
      // Probar siguiente.
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

  // Esperar a que la tabla termine de cargar. La fila inicial dice
  // "Cargando... Por favor espere"; seguimos esperando hasta que aparezca
  // al menos una fila que no sea ese placeholder.
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
          const textoFilas = filasDatos
            .map((tr) => tr.innerText.toLowerCase())
            .join(' ');
          return !textoFilas.includes('cargando');
        });
      },
      { timeout: 45_000 },
    )
    .catch(() => {});

  await page.waitForLoadState('networkidle', { timeout: TIMEOUT_CONSULTA }).catch(() => {});

  // Extraer las filas de actuaciones. El portal no usa thead/tbody, así que
  // tomamos los <th> y <tr><td> directamente del <table>.
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

  const textoCompleto = await page.evaluate(() => document.body.innerText);

  const fin = new Date();
  const leyenda = `${numero} · ${timestampLegible(fin)}`;
  await inyectarBannerTimestamp(page, leyenda).catch(() => {});

  const sufijo = `${numero}_${timestampParaNombre(fin)}`;
  const rutaScreenshot = path.join(directorioSalida, `captura_${sufijo}.png`);
  const rutaJson = path.join(directorioSalida, `actuaciones_${sufijo}.json`);

  await page.screenshot({ path: rutaScreenshot, fullPage: true });

  const resultado = {
    radicado: numero,
    alias: alias ?? null,
    consultadoEn: fin.toISOString(),
    consultadoEnBogota: timestampLegible(fin),
    duracionMs: fin.getTime() - inicio.getTime(),
    url: page.url(),
    totalActuaciones: actuaciones.filas.length,
    actuaciones: actuaciones.filas,
    encabezadosDetectados: actuaciones.encabezadosDisponibles,
    textoPaginaPreview: textoCompleto.slice(0, 2000),
  };

  await writeFile(rutaJson, JSON.stringify(resultado, null, 2), 'utf8');
  console.log(`  ✔ Captura:     ${rutaScreenshot}`);
  console.log(`  ✔ Actuaciones: ${actuaciones.filas.length} (JSON: ${rutaJson})`);

  return resultado;
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
      const r = await consultarRadicado(page, numero, alias, directorioSalida);
      resumen.push({ numero, alias, ok: true, total: r.totalActuaciones });
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
