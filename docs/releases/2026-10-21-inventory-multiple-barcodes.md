# Varios códigos de barras por insumo

Desde **Administración → Inventario**, tanto en Existencias como durante un conteo editable, se puede agregar el primer código de un insumo o códigos adicionales. Cualquiera identifica el mismo insumo al escanear. No cambia la unidad de conteo ni multiplica cantidades por empaque.

La pantalla conserva las cantidades digitadas sin guardar. Un código desconocido queda sugerido al abrir «Agregar código de barras» o «Agregar otro código» del insumo elegido. Fallos de conexión y duplicados conservan el texto para corregirlo o reintentar. La interfaz está traducida a español, inglés y portugués.

## Persistencia y acceso

- `POST /api/operator/ingredients/[id]/barcode` admite únicamente `{barcode}`. Usa la autenticación, protección de origen, límite de solicitudes y permisos existentes del módulo inventory. El insumo debe pertenecer al comercio, estar activo y llevar inventario.
- `IngredientBarcode` registra el principal y los adicionales. La unicidad `(restaurantId, barcode)` evita que un código identifique dos insumos del mismo comercio; otro comercio puede usarlo. Se preservan ceros iniciales y mayúsculas/minúsculas.
- `Ingredient.barcode` conserva el principal compatible con la ficha actual. Agregar un código nunca reemplaza un principal existente. Repetir una petición es idempotente. Solo las altas nuevas generan `ingredient.barcode.add`.
- La edición del principal desde la ficha sigue permitida: sustituye ese código y conserva los adicionales. La respuesta completa del servidor reemplaza únicamente la metadata de códigos en el cliente, para retirar códigos que otro operador haya cambiado sin perder cantidades locales.
- Los escritores existentes detectan duplicados también contra códigos adicionales y devuelven `barcode_taken`, incluso cuando otra petición gana la carrera.

## Migración y respaldo

`20261021170000_ingredient_barcodes` es aditiva. Backfill y activación del trigger ocurren dentro de una transacción con bloqueo de escrituras de Ingredient. No actualiza precios, cantidades, movimientos ni `updatedAt` de los insumos existentes.

Un trigger sincroniza escrituras del principal desde versiones anteriores durante blue/green; las referencias de códigos deben pertenecer al mismo comercio. No se admite trasladar un insumo entre comercios.

Las copias nuevas contienen todos los códigos. Las antiguas reconstruyen los principales a partir de Ingredient. Restaurar valida pertenencia y propietarios contradictorios antes de modificar datos. Usa los marcadores transaccionales `app.restoring` y `app.ingredient_barcodes_restore`.

**Operación de rollback:** el binario anterior puede seguir sirviendo y editar principales, pero no debe utilizarse para restaurar copias. La base rechaza restauraciones desde versiones antiguas y también copias nuevas que omitan la tabla cuando ya existan códigos adicionales. Usar esta versión o una posterior para respaldar/restaurar; no retirar las guardas ni la tabla al volver temporalmente a un binario anterior.

## Validación

- ECC: pruebas RED antes de implementar y revisión independiente de estado, seguridad, migración y restauración.
- 3.647 pruebas unitarias y 281 integraciones PostgreSQL aprobadas. Endpoint nuevo y utilidades de códigos: 100 % de cobertura de líneas, ramas, funciones y sentencias en sus suites específicas.
- Seis pruebas de navegador WebKit móvil/Chromium escritorio: múltiples códigos, escaneo, cantidades sin guardar, duplicados, reintentos, traducciones, código de 64 caracteres sin desbordamiento y ciclo completo preliminar/reconteo/cierre.
- Ensayo desde el esquema previo: seis insumos y sus existencias idénticos después de migrar, incluidos precios y `updatedAt`; cinco principales conservados exactamente y el nulo excluido.
- La prueba de login espera la hidratación y el destino final antes de navegar, evitando carreras del entorno WebKit de desarrollo. No cambia autenticación de la aplicación.
