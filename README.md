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

### Consultar el radicado de ejemplo (definido en `radicados.json`)

```bash
npm run consultar
```

### Consultar un radicado puntual por línea de comandos

```bash
node consultar.js 05266310300120130032400
```

### Agregar varios radicados a la rotación

Edita `radicados.json`:

```json
{
  "radicados": [
    { "numero": "05266310300120130032400", "alias": "Proceso A" },
    { "numero": "11001400308820210012300", "alias": "Proceso B" }
  ]
}
```

## Qué revisar tras correrlo

1. Abre la carpeta `resultados/` y confirma que la captura muestra la tabla de
   actuaciones y el banner con la fecha/hora.
2. Revisa el JSON: el campo `totalActuaciones` te dice cuántas filas se
   extrajeron; si es 0, probablemente los selectores necesitan ajuste para la
   estructura actual del portal.
3. Si hay error, el script guarda `resultados/error_<radicado>_<fecha>.png`
   para diagnosticar qué pantalla vio Playwright en el momento de la falla.

## Próximos pasos sugeridos

- **Diff entre corridas**: comparar cada JSON nuevo contra el anterior del
  mismo radicado para listar únicamente las actuaciones nuevas.
- **Agendamiento**: una vez validado, mover la ejecución a GitHub Actions con
  `on.schedule` (cron) para que no dependa de tener el computador encendido.
- **Notificación**: disparar un correo o abrir un issue cuando aparezcan
  actuaciones nuevas.
