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

  await page.waitForLoadState('networkidle', { timeout: TIMEOUT_CONSULTA }).catch(() => {});

  // Hay dos escenarios: (1) aparece una fila con el proceso, debemos entrar al detalle;
  // (2) el portal muestra directamente el detalle.
  const filaProceso = page.locator('table tbody tr').first();
  const tieneFila = await filaProceso.count();
  if (tieneFila > 0) {
    const enlaceDetalle = filaProceso.locator('a, button').first();
    if ((await enlaceDetalle.count()) > 0) {
      await enlaceDetalle.click().catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: TIMEOUT_CONSULTA }).catch(() => {});
    }
  }

  // Abrir la pestaña de Actuaciones. El portal usa un tab custom sin role="tab",
  // así que buscamos por texto visible y vamos probando hasta que funcione.
  const estrategiasActuaciones = [
    () => page.getByRole('tab', { name: /actuaciones/i }).first(),
    () => page.locator('a, button, li, div, span').filter({ hasText: /^\s*ACTUACIONES\s*$/ }).first(),
    () => page.getByText('ACTUACIONES', { exact: true }).first(),
    () => page.getByText(/actuaciones/i).first(),
  ];

  let clickExitoso = false;
  for (const obtener of estrategiasActuaciones) {
    const locator = obtener();
    if ((await locator.count()) === 0) continue;
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await locator.click({ timeout: 5000 });
      clickExitoso = true;
      break;
    } catch {
      // Probar la siguiente estrategia.
    }
  }

  if (!clickExitoso) {
    console.warn('  ⚠ No pude hacer clic en la pestaña Actuaciones; continúo de todos modos.');
  }

  // Esperar a que aparezca la tabla de actuaciones (el contenido renderiza
  // asíncrono tras el clic). Damos varios segundos máximo.
  await page
    .waitForFunction(
      () => {
        const tablas = Array.from(document.querySelectorAll('table'));
        return tablas.some((t) => {
          const encabezado = t.querySelector('thead')?.innerText?.toLowerCase() ?? '';
          return (
            encabezado.includes('actuaci') &&
            (t.querySelectorAll('tbody tr').length > 0)
          );
        });
      },
      { timeout: 15_000 },
    )
    .catch(() => {});

  await page.waitForLoadState('networkidle', { timeout: TIMEOUT_CONSULTA }).catch(() => {});

  // Extraer las filas de actuaciones. Buscamos la tabla cuyo encabezado
  // mencione "actuaci" (cubre "Actuación", "Actuaciones"). Si no la
  // encontramos, devolvemos los encabezados disponibles para diagnóstico.
  const actuaciones = await page.evaluate(() => {
    const tablas = Array.from(document.querySelectorAll('table'));
    const encabezadosVistos = tablas.map(
      (t) => t.querySelector('thead')?.innerText?.trim() ?? '(sin thead)',
    );
    const tablaActuaciones = tablas.find((t) => {
      const encabezado = t.querySelector('thead')?.innerText?.toLowerCase() ?? '';
      return encabezado.includes('actuaci');
    });
    if (!tablaActuaciones) {
      return { filas: [], encabezadosDisponibles: encabezadosVistos };
    }
    const columnas = Array.from(tablaActuaciones.querySelectorAll('thead th')).map((th) =>
      th.innerText.trim(),
    );
    const filas = Array.from(tablaActuaciones.querySelectorAll('tbody tr')).map((fila) => {
      const celdas = Array.from(fila.querySelectorAll('td')).map((td) => td.innerText.trim());
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
