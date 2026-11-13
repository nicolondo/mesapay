# Servir todos los pendientes del bar

La acción masiva ya existía para administradores, pero el rol del bar no podía verla ni utilizarla. Ahora el personal del bar puede usar **Servir todo** únicamente en su estación. Cocina y otros roles conservan sus permisos anteriores.

Se reutiliza la confirmación existente: congela los productos visibles y respeta la subestación seleccionada. Excluye cancelados, rechazados, ya servidos, otros comercios y productos que lleguen después de abrir la confirmación. La operación mantiene bloqueos, auditoría e idempotencia.

Validación: 64 pruebas unitarias y 4 pruebas de navegador con Chrome y Safari móvil, datos sintéticos y base local. Se comprobó permiso de estación, subestaciones, aislamiento, reintentos y conservación de llegadas posteriores. No se sirvieron pedidos reales durante las pruebas.
