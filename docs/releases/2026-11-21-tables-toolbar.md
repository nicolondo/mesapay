# Organización de los controles de Mesas

En móvil, las acciones de la cabecera y de la barra de Mesas se repartían en varias filas desalineadas. El cuarto estado, Libres, quedaba fuera de la pantalla y exigía desplazamiento horizontal.

Los cuatro estados ahora se muestran completos en una cuadrícula de dos columnas en móvil y cuatro cuando hay espacio. Tarjetas/Mapa y Gestionar tienen su propia fila. Gestionar despliega en línea la impresión de QR, el alta y la edición de mesas; el formulario ocupa todo el ancho y conserva sus valores al cerrar el panel. Durante la edición, Listo permanece visible. Escape cierra la gestión y devuelve el foco a su botón.

La creación de facturas manuales y el acceso a sus pendientes quedan juntos en otra fila. El contador acompaña a una etiqueta breve, con un nombre accesible completo para lectores de pantalla y control por voz. Los controles mantienen un mínimo táctil de 44 píxeles. La barra usa el sistema visual y los colores existentes, también en los tres idiomas.

La presentación se concentra en `TablesToolbar`. Se conservan las reglas del salón: permisos del mesero, modo mostrador, disponibilidad y preferencia del mapa, filtros, conteos y actualización de las mesas. No cambian las API, los datos, el esquema ni las dependencias.

Validación: captura del problema original; pruebas de navegador en Chrome y WebKit móvil, con anchos de 320, 390, 1100 y 1280 píxeles, español/inglés/portugués, filtros, mapa, gestión, formulario, foco y permisos. Las pruebas usan datos ficticios locales y no emiten facturas ni imprimen documentos reales. Revisión independiente de UI y accesibilidad, pruebas generales, lint y compilación antes de publicar.
