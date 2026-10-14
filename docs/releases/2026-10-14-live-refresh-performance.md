# Rendimiento de actualizaciones en vivo — 14 de octubre de 2026

Son & Melona reportó lentitud durante el servicio. La revisión de producción
encontró hasta 980 solicitudes por minuto desde los clientes del comercio,
incluidas pantallas que se estaban precargando sin navegación. El servidor
tenía CPU y memoria disponibles; la carta respondía localmente en unos 55 ms.

## Causa y corrección

- Next 16.2.4 invalida la caché de precarga al ejecutar `router.refresh()` y
  vuelve a programar los enlaces visibles. La vista de mesas precargaba la
  carta completa por cada mesa libre o recién pagada. Se desactiva la precarga
  en la navegación de personal, dashboard, historial y enlaces de mesas.
  Los destinos y la navegación al hacer clic se conservan.
- Cocina, entrega y carta solicitaban una actualización por cada evento SSE.
  Ahora agrupan invalidaciones en ventanas fijas de 250 ms, conservando los
  cambios finales incluso con tráfico continuo. El dashboard sustituye su
  filtro inicial, que podía descartar el último cambio de una ráfaga.
- `open` recupera el estado una vez, también al reconectar; el mensaje de
  protocolo `hello` no solicita otra copia. Ocultar la pestaña cancela trabajo
  pendiente; volver a mostrarla recupera el estado actual.
- Los avisos y listeners de impresión siguen recibiendo cada evento. No hay
  migraciones ni cambios en permisos, pagos o estados de preparación.

## Validación

- 3.224 pruebas unitarias en 288 archivos; lint sin errores (31 advertencias
  anteriores); compilación de producción y TypeScript correctos.
- 21 pruebas del nuevo núcleo de invalidaciones: 100 % de cobertura en líneas,
  ramas y funciones de `liveRefresh.ts`. No es cobertura global del proyecto.
- 12 pruebas SSR comprueban los enlaces, sus destinos y la precarga desactivada.
- Cinco E2E contra builds de producción, autenticación y PostgreSQL aislados:
  cocina, entrega y carta pasan de 100 solicitudes a una por ráfaga de 100
  eventos en menos de 250 ms; todas conservan el último cambio. Conexión y
  `hello` pasan de dos solicitudes a una. En mesas, 37 precargas iniciales
  (51 tras actualizar) pasan a cero; navegar a cocina sigue funcionando.
- Los mismos E2E verifican reconexión y ocultar/mostrar pestañas. Se simula
  únicamente el transporte SSE para controlar las ráfagas, sin enviar pedidos,
  impresiones, correos ni pagos a proveedores reales.
- Otras once pruebas E2E existentes pasan con SSE real: nueve del flujo del
  comensal y dos de traslados en cocina/bar, incluyendo silencio al trasladar
  y aviso al llegar un producto nuevo. Son 16 casos de navegador en total.
  PostgreSQL de validación se configuró en UTC, igual que producción; su zona
  horaria inicial local desfasaba los eventos creados por triggers cinco horas.
  Se corrigió el entorno sin modificar las pruebas ni la base de producción.
- Revisión independiente ECC sin bloqueadores de corrección o seguridad.

La ventana reduce ráfagas, pero no serializa solicitudes que duren más de
250 ms. Las mediciones de navegador son de laboratorio; no representan una
garantía de tiempos en los dispositivos o la conexión del restaurante.
