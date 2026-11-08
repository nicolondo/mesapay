# Calendario para elegir un día en Órdenes

El botón con la fecha abría la edición de un rango. Ahora abre un calendario y elegir una fecha filtra exactamente ese día. Conserva la búsqueda y el estado de las órdenes, y vuelve a la primera página. La pestaña Rango mantiene la selección explícita de intervalos; Semana y Mes conservan su navegación.

El calendario permite cambiar de mes, escribir una fecha y navegar con teclado. Respeta el día de negocio del restaurante, deshabilita fechas futuras y devuelve el foco al botón al cerrar. Incluye textos en español, inglés y portugués. Las etiquetas de fechas normalizan diferencias de abreviaturas entre Node y Safari que podían provocar un error de hidratación y perder el primer evento de teclado.

Validación: 52 pruebas unitarias de fechas, etiquetas y filtros, y 10 pruebas de navegador en Chrome y Safari móvil. Cubren selección entre meses, filtros, Atrás/Recargar, rangos, teclado, Escape, foco, fechas futuras y los tres idiomas. La lógica nueva de calendario tiene cobertura del 100 % de líneas y ramas. Revisión independiente aprobada y capturas de móvil/escritorio inspeccionadas.

No cambia datos, cálculos de ventas, permisos, dependencias ni esquema. Las pruebas usan un comercio sintético local que se elimina al terminar.
