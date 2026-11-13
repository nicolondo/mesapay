# Administrador de plataforma: navegación y directorio

El administrador general adopta el lateral oscuro, acento naranja, superficies claras y tipografías del portal del comercio. La paleta del lateral se comparte entre ambos portales para evitar diferencias entre versiones.

## Uso

- El menú de la izquierda organiza Resumen, Comercios, Finanzas y Plataforma. La sección actual permanece identificada también dentro de las fichas de restaurante, grupo o pagos.
- La búsqueda de secciones, disponible con Ctrl/Cmd + K, permite llegar a cualquier sección y a las acciones de crear restaurante, consultar eliminados y abrir la cuenta.
- El directorio busca por nombre o identificador y combina los filtros de país y ciudad. Las cifras corresponden a los resultados de la vista. Una búsqueda sin coincidencias se diferencia de una plataforma sin restaurantes.
- El resumen distingue suscripciones y actividad de comercios y ofrece accesos frecuentes. Se conservan las fuentes y cálculos financieros existentes.
- En móvil, el menú se abre desde la izquierda. Se respetan las áreas seguras, el foco vuelve al botón al cerrar y Escape cierra en una sola pulsación. En el directorio, el buscador precede a las estadísticas y los filtros de ubicación comparten una fila.
- Se unifican títulos, espacios y anchos de formularios en cuenta, configuración, wallet, grupos, planes, comisiones, auditoría y fichas. La impresión oculta la navegación y conserva las diez columnas del directorio, incluidas las cifras plegadas en móvil.

## Compatibilidad y validación

Acceso exclusivo a `platform_admin`, con autenticación y cierre de sesión en el servidor. Los enlaces comerciales y la entrada al portal del comercio conservan su comportamiento. No hay migraciones, dependencias nuevas, cambios de importes ni operaciones financieras reales.

- 6.077 pruebas unitarias en 503 archivos; 418 de integración en 47 archivos, sobre PostgreSQL aislado.
- 21 pruebas de resolución de navegación y preservación de destinos.
- Navegadores Chromium y WebKit móvil: navegación, teclado, foco, filtros, permisos, impresión A4, áreas seguras y pantallas pequeñas. La suite conjunta de administrador y wallets completa 28 pruebas y dos omisiones intencionales de plataforma.
- Revisión visual en español, inglés y portugués; revisión independiente de accesibilidad y seguridad.
- Compilación de producción y TypeScript aprobados. ESLint sin errores y 30 advertencias previas.

Esta versión incluye la presentación de [fondos pendientes en las wallets](2026-11-06-wallet-pending-balance.md), que distingue un dato no informado de un saldo cero. La obtención del importe real pendiente de Kushki continúa sin resolverse; no se consultaron credenciales ni cuentas reales durante el rediseño.
