# Consulta de radicados - Rama Judicial

Prototipo que consulta uno o varios radicados en el portal público de la Rama
Judicial y guarda:

- Una captura de pantalla (`resultados/captura_<radicado>_<fecha>.png`) con un
  banner superior que indica fecha/hora de la consulta (hora de Bogotá).
- Un JSON (`resultados/actuaciones_<radicado>_<fecha>.json`) con la lista de
  actuaciones detectadas y un preview del texto de la página.

> Ejecutable desde cualquier máquina con Node.js 18+. El sandbox donde fue
> creado no permite descargar Chromium, por eso la primera corrida real debe
> hacerse en tu equipo local.

## Requisitos

- Node.js 18 o superior.
- Conexión a internet (el portal de la Rama a veces presenta intermitencias).

## Instalación

```bash
npm install
npx playwright install chromium
```

## Uso

### Opción A · Doble click al `consultar.bat` (Windows)

Es la forma más simple: haces doble click en `consultar.bat`, se abre una
ventana de CMD, te muestra el progreso mientras corre y se queda abierta al
final para que leas el resumen. La primera vez instala dependencias solo.

Si quieres tenerlo a la mano: click derecho sobre `consultar.bat` →
Enviar a → Escritorio (crear acceso directo), y queda un ícono en el
escritorio que puedes renombrar a gusto.

### Opción B · Consultar varios radicados de `radicados.json`

Edita `radicados.json` y agrega tantas entradas como quieras:

```json
{
  "radicados": [
    { "numero": "05266310300120130032400", "alias": "Ejecutivo Envigado" },
    { "numero": "11001400308820210012300", "alias": "Familia Bogota" },
    { "numero": "76001310500120240045600", "alias": "Laboral Cali" }
  ]
}
```

Reglas:

- Cada bloque va entre llaves `{ }` y lleva `numero` (los 23 dígitos) y
  `alias` (cualquier texto corto para identificarlo).
- Los bloques se separan con coma. La última entrada NO lleva coma al final.
- El alias se usa para nombrar los archivos de salida, así que conviene que
  sea corto y descriptivo (ej. "Carpeta-Juan-Perez").

Luego corres:

```bash
npm run consultar
```

El script procesa los radicados uno por uno y al final muestra un resumen
con el total de actuaciones encontradas para cada uno.

### Opción C · Consultar un radicado puntual por línea de comandos

Sin tocar `radicados.json`, útil para pruebas rápidas:

```bash
node consultar.js 05266310300120130032400
```

## Archivos generados

Cada corrida crea (si no existe) una subcarpeta `resultados/YYYY-MM-DD/`
con la fecha de la consulta en hora de Bogotá, y dentro deja:

- `captura_<alias>_<radicado>_<fecha>.png` — captura compacta con banner
  de fecha/hora y solo las 3 actuaciones más recientes visibles.
- `actuaciones_<alias>_<radicado>_<fecha>.json` — datos estructurados con
  las 3 actuaciones más recientes y el total detectado en el portal.
- `resumen_<fecha>.md` — informe en Markdown con tres secciones:
  procesos con movimiento en los últimos 5 días (y el detalle de cada
  actuación nueva), procesos sin movimiento reciente (fecha de la última
  actuación), y fallas. Se genera al final de cada corrida.
- `consolidado_<fecha>.pdf` — PDF consolidado con portada (fecha y
  estadísticas globales) y una página por cada captura, para hojear
  manualmente todas las consultas en un solo documento.

## Qué revisar tras correrlo

1. Abre la carpeta `resultados/` y confirma que la captura muestra la tabla de
   actuaciones y el banner con la fecha/hora.
2. Revisa el JSON: el campo `totalActuacionesEnPortal` te dice cuántas filas
   hay en total; `actuaciones` contiene las más recientes.
3. Si hay error, el script guarda `resultados/error_<radicado>_<fecha>.png`
   para diagnosticar qué pantalla vio Playwright en el momento de la falla.

## Próximos pasos sugeridos

- **Diff entre corridas**: comparar cada JSON nuevo contra el anterior del
  mismo radicado para listar únicamente las actuaciones nuevas.
- **Agendamiento**: una vez validado, mover la ejecución a GitHub Actions con
  `on.schedule` (cron) para que no dependa de tener el computador encendido.
- **Notificación**: disparar un correo o abrir un issue cuando aparezcan
  actuaciones nuevas.
