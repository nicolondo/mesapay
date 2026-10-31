/**
 * Índice de TODOS los artículos planeados del centro de ayuda.
 *
 * Es el contrato entre el mapa de cobertura (`coverage.ts`: qué pantalla
 * explica cada artículo) y el contenido (`<idioma>/<categoria>.json`). Los
 * tests exigen que una categoría con artículos tenga exactamente estos slugs,
 * ni uno más ni uno menos, en los tres idiomas.
 *
 * Se armó leyendo el código de cada pantalla (etiquetas de `messages/es.json`
 * y reglas de los componentes y de `src/lib`), no de memoria. `covers` dice
 * qué tiene que explicar el artículo; los nombres entre comillas son los
 * textos exactos de la interfaz en español.
 *
 * `legacy` guarda el texto de la guía rápida que tenía la ayuda anterior
 * (`opErp.helpGuide*`), como punto de partida para quien escriba el artículo.
 *
 * Etapa 2: cada redactor edita SOLO el bloque de su categoría (están
 * separados para que git combine sin conflictos). Ver README.md.
 */
import type { HelpCategoryId } from "./categories";

export type HelpOutlineEntry = {
  /** En español, kebab-case, único en toda la ayuda. */
  slug: string;
  /** Título de trabajo en español (el definitivo va en el JSON). */
  title: string;
  /** Qué tiene que cubrir, en una línea. */
  covers: string;
  /** Texto de la guía rápida anterior, si había una para este tema. */
  legacy?: string;
};

export const HELP_OUTLINE: Record<HelpCategoryId, HelpOutlineEntry[]> = {
  /* ─────────────────────────── primeros-pasos ─────────────────────────── */
  "primeros-pasos": [
    {
      slug: "por-donde-empezar",
      title: "Por dónde empezar con MESAPAY",
      covers:
        "Qué deja creado el registro (cuenta de operador, el restaurante y una mesa o el mostrador; la carta empieza vacía), el correo de bienvenida para crear la contraseña y el orden recomendado: Identidad, Impuestos, Usuarios, Mesas y QR, Carta, Estaciones, Impresoras y Pagos, todo desde Configuración.",
    },
    {
      slug: "conocer-el-panel",
      title: "Conoce el panel del restaurante",
      covers:
        "Resumen (\"Ventas hoy\", \"Órdenes pagadas\", \"Ticket promedio\", \"Abiertas ahora\", caja, ventas de 7 días, top platos, mesas activas), el menú lateral y sus grupos, la barra de arriba (\"Buscar orden\", \"Cierre de turno\", \"Nueva orden\"), \"Ir a una sección\" (⌘ K) y por qué algunos ítems no aparecen (módulos).",
    },
    {
      slug: "identidad-del-comercio",
      title: "Completa la identidad del comercio",
      covers:
        "Logo, nombre del restaurante, razón social, NIT con dígito de verificación, dirección, ciudad con código DANE y teléfono; dónde aparece cada dato; errores del dígito de verificación; razón social compartida en grupos.",
    },
    {
      slug: "usuarios-y-roles",
      title: "Crea los usuarios de tu equipo",
      covers:
        "Roles Operador (dueño), Mesero, Cocina, Bar y Datáfono, a qué pantalla entra cada uno, crear, editar, cambiar la contraseña y eliminar; correo único; no puedes eliminarte ni cambiar tu propio rol.",
    },
    {
      slug: "mesas-por-mesero",
      title: "Asigna mesas a cada mesero",
      covers:
        "\"Mesas por mesero\": secciones con \"Todas\", \"Ninguna\" y \"Rango\", qué ve el mesero según su sección (sin mesas marcadas ve todas), guardado automático y el campo \"Comisión (%)\".",
    },
    {
      slug: "permisos-propinas-y-turnos",
      title: "Define permisos, propinas y turnos del equipo",
      covers:
        "\"Políticas operativas\": reparto de propinas, turno único o por mesero, mesero sin turno del local, \"Sólo el administrador puede iniciar el cobro\", quién puede no cobrar, gastos de representación, quién mueve platos entre mesas, riesgo de irse sin pagar y la hora de inicio del día contable.",
    },
    {
      slug: "suscripcion",
      title: "Tu suscripción y el débito automático",
      covers:
        "Plan activo y su precio, estados, próximo cobro o vencimiento, \"Activar débito automático\", \"Cambiar tarjeta\", \"Cancelar débito automático\", historial de pagos y qué pasa si la cuenta queda suspendida.",
    },
    {
      slug: "cambiar-el-idioma",
      title: "Cambia el idioma de la plataforma",
      covers:
        "Selector de idioma (Español, English, Português) en el panel y en la pantalla de ingreso, que la elección queda en cada dispositivo, que la moneda no cambia y que la carta del comensal se traduce aparte.",
    },
  ],

  /* ─────────────────────────── salon-y-pedidos ─────────────────────────── */
  "salon-y-pedidos": [
    {
      slug: "tomar-un-pedido-desde-mesas",
      title: "Toma y marcha un pedido desde Mesas",
      covers:
        "Tocar una mesa libre abre la carta en \"Modo mesero\"; modificadores, \"+ Nota para la cocina\", \"Ver y enviar pedido\", \"Marchar orden\" / \"Marchar adición\" y \"¿Cómo quieres que salga?\" (\"Lo que vaya saliendo\" / \"Fuertes juntos\"); en mostrador el botón es \"Ir a pagar\" y la cocina recibe después del pago.",
      legacy:
        "Los comensales piden por QR o el mesero desde su app. Cada pedido entra a Cocina y Bar por estación, con su tiquete.",
    },
    {
      slug: "la-pantalla-mesas",
      title: "Lee la pantalla Mesas y la ficha de cada mesa",
      covers:
        "Colores por riesgo de irse sin pagar, filtros \"Todas\", \"Por cobrar\", \"Recién pagadas\" y \"Libres\", la ficha \"Estado del pedido\" (pendiente, comensal identificado, \"Agregar platos\", \"Agregar cargo o servicio\") y \"🔥 Apurar\"; modo mostrador.",
    },
    {
      slug: "crear-mesas-e-imprimir-qr",
      title: "Crea mesas e imprime sus códigos QR",
      covers:
        "\"Editar mesas\", \"+ Añadir mesa\" (\"Una\" / \"Varias\", hasta 200), número y nombre, por qué no se borra una mesa con historial, \"Imprimir QRs\" (hoja A4), \"Links para compartir\" y el QR de recogida.",
    },
    {
      slug: "tablero-de-cocina-y-bar",
      title: "Trabaja con el tablero de Cocina y Bar",
      covers:
        "Columnas \"Por preparar\", \"En cocina\" / \"En preparación\" y \"Listo\"; \"Empezar\", \"Listo\", \"Servir\", las acciones por tarjeta y \"Servir todo\" (solo administrador); código corto, \"Montó: …\", \"Recoger\", \"Fuertes juntos\", platos apurados; cuenta regresiva y pestañas de sub-estación del bar; pitido de pedidos nuevos (\"Probar sonido\"); cancelar desde cocina.",
    },
    {
      slug: "estaciones-de-preparacion",
      title: "Decide a qué estación va cada plato",
      covers:
        "\"Estaciones de preparación\": \"¿Tenés bartender?\", sub-estaciones del bar, estación por categoría (Cocina, Bar / barista, Refri / mostrador), cambiar toda una carta de estación y \"Marchar automáticamente al llegar el pedido\".",
    },
    {
      slug: "salon-entregar-platos-y-llamadas",
      title: "Usa Salón para entregar platos y atender llamadas",
      covers:
        "Secciones de Salón: cancelaciones de cocina (\"Avisé al cliente\"), \"Llamadas pendientes\" (\"Voy en camino\"), pedidos de datáfono y de efectivo, platos listos por mesa (\"Marcar todo\", \"Entregar\"), \"Aún en preparación\" y \"Fuertes juntos\".",
    },
    {
      slug: "corregir-un-pedido",
      title: "Cancela, no cobres o mueve un plato",
      covers:
        "\"Cancelar\" (plato no entregado) vs \"No cobrar\" (entregado) y sus motivos, la regla de que tras empezar la preparación solo el administrador cancela, \"Cancelar la cuenta\", \"Mover\" un plato y \"Mover a otra mesa\" la cuenta, y los permisos y errores de cada acción.",
    },
    {
      slug: "buscar-y-revisar-ordenes",
      title: "Busca una orden y revisa su detalle",
      covers:
        "\"Buscar orden\", el código corto de 6 caracteres, filtros de \"Órdenes\" (estado y periodo), y el detalle: rondas y sus estados, quién montó cada ronda, \"Por persona\", pagos y factura.",
    },
    {
      slug: "reservas",
      title: "Recibe y gestiona reservas",
      covers:
        "Configuración de Reservas (link, Google Maps, \"Confirmar solas\", duración, anticipación, turnos, depósito), mesas reservables con capacidad, consumo mínimo y depósito, el \"Mapa del salón\" y el tablero Reservas (\"Confirmar\", \"Llegaron\", \"No-show\", aplicar el abono a la cuenta).",
    },
    {
      slug: "etiquetas-de-platos",
      title: "Crea las etiquetas de tus platos",
      covers:
        "\"Etiquetas de platos\": emoji, nombre visible e ID, ordenar, máximo 20, que cambiar el ID les quita la etiqueta a los platos que la tenían y dónde las ve el comensal.",
    },
  ],

  /* ─────────────────────────── cobro-y-caja ─────────────────────────── */
  "cobro-y-caja": [
    {
      slug: "cobrar-una-cuenta",
      title: "Cobra una cuenta paso a paso",
      covers:
        "\"Cobrar la cuenta\" desde la ficha o la orden, confirmar el pedido, la propina (\"Sin propina\", 5 a 20 %, 10 % por defecto), elegir el medio, la factura y la pantalla final; qué pasa con \"Sólo el administrador puede iniciar el cobro\" (\"Pedir la cuenta\" y el aviso a pantalla completa).",
      legacy:
        "Desde Salón o la app del mesero: efectivo, datáfono o cortesía (gastos de representación). Tras el pago se ofrece la factura al cliente.",
    },
    {
      slug: "cobrar-en-efectivo",
      title: "Cobra en efectivo y entrega la devuelta",
      covers:
        "\"Recibir en efectivo\" y \"Registrar cobro\" en Salón: \"¿Con qué te pagó?\", \"Pagó exacto\", devuelta, \"Lo deja de propina\", y el aviso cuando el mesero no tiene turno abierto.",
    },
    {
      slug: "cobrar-con-datafono",
      title: "Cobra con datáfono",
      covers:
        "Datáfono Kushki (\"Cobrar con datáfono\", directo al datáfono asignado o desde Salón) vs datáfono propio del comercio (\"Aprobado\" / \"Rechazado\"), errores de envío y la pantalla \"Mesas en vivo\" del usuario Datáfono.",
    },
    {
      slug: "dividir-la-cuenta",
      title: "Divide la cuenta o combina medios de pago",
      covers:
        "\"¿Cómo cobrar?\": \"Todo\", \"Partes iguales\" (2 a 20), \"Individual\" (por nombre en los platos) y \"Combinar medios\" (\"Importe de este pago\", \"Cobrar saldo restante\"); qué opciones hay en mostrador.",
    },
    {
      slug: "pagos-pendientes-del-comensal",
      title: "Confirma los pagos que pidió el comensal",
      covers:
        "\"El comensal pidió pagar con…\" y \"Confirmar pago recibido\", \"Pago en línea en curso\", \"No se recibió este pago\" y que cobrar de otra forma reemplaza la solicitud.",
    },
    {
      slug: "imprimir-la-precuenta",
      title: "Imprime la precuenta",
      covers:
        "\"Imprimir precuenta\" y \"Ver precuenta\" desde la ficha de la mesa, propina sugerida, que no es factura ni numera nada, y la impresión por la impresora de facturas o por el navegador.",
    },
    {
      slug: "cobrar-a-credito",
      title: "Vende a crédito y registra abonos",
      covers:
        "Cliente con \"Permitir pagar a crédito\", límite y plazo, \"Cobrar a crédito\" al cobrar, que no entra en caja, \"Abonar\" (cuenta donde entró la plata), \"Estado de cuenta\" y \"Reversar abono\".",
    },
    {
      slug: "descuentos-para-clientes",
      title: "Da descuentos a tus clientes",
      covers:
        "Descuento del comensal registrado (1 a 100 %, identificarlo en la mesa con \"Cédula o correo\", \"Quitar descuento\") vs descuento comercial del cliente de facturación (hasta 50 %), y el historial de la ficha del comensal.",
    },
    {
      slug: "cortesias-y-productos-no-cobrados",
      title: "Cortesías, gastos de representación y productos no cobrados",
      covers:
        "Cerrar una cuenta como cortesía (\"¿A quién se le dio?\", solo sin pagos aprobados) y el informe de \"Gastos de representación\" / \"Productos no cobrados\": filtros, tipos, vistas y \"Descargar CSV\".",
    },
    {
      slug: "cobros-reembolsos-y-conciliacion",
      title: "Revisa cobros, devuelve un pago o concilia",
      covers:
        "Lista de Cobros (búsqueda por código, estados, \"Requiere revisión\", \"Ver detalle\"), \"Devolver\" (solo tarjeta, Apple Pay o datáfono Kushki, solo administradores) y \"Conciliar pago\".",
    },
    {
      slug: "abrir-y-cerrar-el-turno",
      title: "Abre y cierra el turno del día",
      covers:
        "Cierre del día: \"Abrir turno\" con efectivo inicial, cuentas abiertas que bloquean el cierre, \"Cerrar turno\" con conteo y diferencia, \"Cerrar también los turnos de meseros\", el día contable, \"Cierres recientes\" y el detalle imprimible de cada turno.",
      legacy:
        "En Cierre cuadrás la caja del turno: ventas por método de pago, propinas y diferencias del arqueo.",
    },
    {
      slug: "la-caja",
      title: "Lleva la caja: base, ingresos y egresos",
      covers:
        "Tarjeta \"Caja\" en Resumen y Cierre: cómo se calcula \"En caja\", \"Registrar egreso\" (egreso o ingreso), editar la base, \"Cajas de meseros\" y \"Consolidado\".",
    },
  ],

  /* ─────────────────────────── app-del-mesero ─────────────────────────── */
  "app-del-mesero": [
    {
      slug: "entrar-e-instalar-la-app",
      title: "Entra a la app del mesero e instálala en el celular",
      covers:
        "Ingreso con el correo y la contraseña que crea el dueño (y \"¿Olvidaste tu contraseña?\"), instalar \"MP MESERO\" con \"Agregar a pantalla de inicio\", activar los avisos (\"Activar\") y qué avisos llegan, cómo salir.",
    },
    {
      slug: "mis-mesas",
      title: "Toma y suelta tus mesas",
      covers:
        "\"Mis mesas\" en Yo: tomar o soltar una mesa, que no se toma una mesa de otro mesero y que sin mesas propias se ven todas.",
    },
    {
      slug: "mesas-y-ficha-en-la-app",
      title: "Usa Mesas y la ficha de la mesa en la app",
      covers:
        "Pestaña Mesas: filtros, colores y campana; la ficha \"Estado del pedido\": identificar al comensal, agregar platos o cargos, precuenta, apurar, cancelar o no cobrar según permisos.",
    },
    {
      slug: "pedir-desde-la-app",
      title: "Toma un pedido desde la app",
      covers:
        "\"Tomando pedido en Mesa N\": buscar en la carta, modificadores, notas, \"Marchar orden\" / \"Marchar adición\" y a dónde vuelve al enviar.",
    },
    {
      slug: "salon-en-la-app",
      title: "Atiende el Salón desde la app",
      covers:
        "Entregar platos listos, \"Voy en camino\", \"Avisé al cliente\", cobros de datáfono propio (\"Aprobado\" / \"Rechazado\") y de efectivo (\"Registrar cobro\").",
    },
    {
      slug: "cobrar-desde-la-app",
      title: "Cobra una cuenta desde la app",
      covers:
        "Formas de cobro, propina, efectivo, datáfono asignado o del comercio, crédito, gastos de representación, \"Cobro realizado\" y la factura al final.",
    },
    {
      slug: "turno-del-mesero",
      title: "Abre y cierra tu turno de mesero",
      covers:
        "Tarjeta del turno en Yo según la política del local, \"Abrir turno\" con base, \"Cerrar turno\" con \"Arqueo de tu caja\", cifras del día y \"Mis comisiones\".",
    },
    {
      slug: "por-que-no-puedo-cobrar-o-mover",
      title: "Por qué no veo Cobrar, Mover o No cobrar",
      covers:
        "Cobro reservado al administrador, sin turno abierto, mover solo para administradores, roles que pueden no cobrar, preparación ya empezada y mesas fuera de la sección.",
    },
  ],

  /* ─────────────────────── experiencia-del-comensal ─────────────────────── */
  "experiencia-del-comensal": [
    {
      slug: "el-qr-de-la-mesa",
      title: "Qué pasa cuando el comensal escanea el QR",
      covers:
        "El QR abre la carta de esa mesa (permiso de 12 horas), \"Solo ver la carta\" sin mesa, la página de bienvenida del restaurante y por qué un link reenviado no deja pedir.",
    },
    {
      slug: "la-carta-del-comensal",
      title: "Cómo ve tu carta el comensal",
      covers:
        "Pestañas de cartas, \"Categorías\", búsqueda en toda la carta, vistas \"Lista\" / \"Cuadrícula\" / \"Editorial\", etiquetas, estrellas, platos agotados e idioma con traducción automática.",
    },
    {
      slug: "como-pide-el-comensal",
      title: "Cómo pide el comensal y sigue su pedido",
      covers:
        "\"¿Cómo te llamamos?\", carrito, rondas, \"¿Cómo quieres que salga?\", estado en vivo y tiempo estimado, cancelar un plato \"Por preparar\", \"Llamar al mesero\", \"Añadir más\"; en mostrador paga primero.",
    },
    {
      slug: "como-paga-el-comensal",
      title: "Cómo paga el comensal",
      covers:
        "\"¿Cómo quieres pagar?\" (\"Todo\", \"Partes iguales\", \"Lo mío\"), propina, bono, medios disponibles (Apple Pay, tarjeta, PSE, datáfono, efectivo), pantallas de espera, verificación del banco, pago rechazado y \"Pagar más\".",
    },
    {
      slug: "factura-del-comensal",
      title: "Factura genérica o personalizada para el comensal",
      covers:
        "\"Factura electrónica genérica\" (correo opcional) y \"Factura electrónica personalizada\" (datos sin dígito de verificación), pedirla antes o después de pagar, datos guardados en el celular y \"Corregir datos\".",
    },
    {
      slug: "cuenta-del-comensal",
      title: "La cuenta del comensal en tu restaurante",
      covers:
        "\"Crea tu cuenta\", entrar con \"Cédula o correo\" o con enlace por correo (vence en 20 minutos), \"Mi cuenta\", sus órdenes, seguridad y cómo se aplica su descuento.",
    },
    {
      slug: "resenas-de-platos",
      title: "Reseñas de tus platos",
      covers:
        "El comensal califica de 1 a 5 estrellas los platos servidos (\"¿Qué te pareció?\"), y la pantalla Reseñas: promedios, \"Por plato\" y \"Comentarios recientes\" (últimas 200).",
    },
    {
      slug: "reservas-del-comensal",
      title: "Cómo reserva el comensal",
      covers:
        "\"Reservá tu mesa\": fecha, personas, horario, mesa en el mapa, depósito (mesa apartada 15 minutos), código, \"Ver o cancelar mi reserva\" y \"Cancelar mi reserva\".",
    },
    {
      slug: "pedidos-para-llevar",
      title: "Pedidos para recoger",
      covers:
        "QR de recogida, horario, \"Tu nombre\" y \"Celular\", pago antes de cocina, seguimiento \"Pedido para recoger\" y \"Muestra el código al cajero\"; quién activa la función.",
    },
  ],

  /* ─────────────────────────── carta-y-produccion ─────────────────────────── */
  "carta-y-produccion": [
    {
      slug: "crear-la-carta",
      title: "Crea tu carta: categorías y productos",
      covers:
        "\"+ Nueva categoría\", \"+ Producto\" y la hoja \"Editar producto\": nombre, precio, \"Prep (min)\", descripción (\"Generar descripción con IA\"), foto, \"Llevar inventario\", estación, etiquetas; categoría de platos fuertes; límites y errores.",
    },
    {
      slug: "organizar-la-carta",
      title: "Ordena la carta, sepárala en cartas y edita en bloque",
      covers:
        "\"Orden de los platos\" (\"Alfabético\" / \"Manual\"), flechas y arrastre, \"Subcat. de\", búsqueda, acciones masivas (mover, estación, IA, copiar modificadores, eliminar) y \"Cartas\" (\"+ Nuevo menú\", ordenar, eliminar, mover categorías).",
    },
    {
      slug: "modificadores",
      title: "Agrega modificadores y adiciones",
      covers:
        "Grupos con \"Uno solo\" / \"Varias\", \"Obligatorio\", opción por defecto, precio adicional y descripción, máximo 8 grupos y 12 opciones, copiar modificadores y \"Convertir en modificador\".",
    },
    {
      slug: "agotar-archivar-o-eliminar-un-plato",
      title: "Agota, archiva o elimina un plato",
      covers:
        "\"Disponible\" / \"Agotado\", \"Archivar\", que eliminar un plato con pedidos lo archiva, que una categoría con platos no se borra y que cocina puede sacar un plato de la carta al cancelarlo.",
    },
    {
      slug: "importar-la-carta",
      title: "Importa tu carta desde un PDF, una foto o un enlace",
      covers:
        "\"Importar carta con AI\": archivos aceptados y límites, enlaces de Shopify, Justo, Cluvi y Menüpp, revisión (\"Revisar (confianza …)\", categorías nuevas), \"Importar a\" y que reimportar duplica.",
    },
    {
      slug: "traducir-la-carta",
      title: "Traduce tu carta a inglés y portugués",
      covers:
        "\"Traducir carta con IA\", edición manual por celda (se guarda al salir de la celda), \"Volver a traducir todo con IA\" (conserva lo editado), que la carta del comensal solo muestra lo ya traducido (lo nuevo o cambiado queda en español hasta volver a traducir) y que los modificadores no se traducen.",
    },
    {
      slug: "insumos-y-proveedores",
      title: "Crea tus insumos y proveedores",
      covers:
        "Insumos (dimensión, \"Llevar inventario\", precio de referencia, punto de reorden, código de barras principal —los demás se agregan en Inventario—, archivar, acciones masivas, \"Importar con IA\" solo con Inventario) y proveedores (datos, condiciones de pago, \"Lista de precios\", un solo preferido por insumo, \"IVA de compras descontable\").",
    },
    {
      slug: "recetas-y-food-cost",
      title: "Arma las recetas y controla el food cost",
      covers:
        "Pestaña \"Platos\": líneas, merma, \"Food cost\" y su semáforo, \"Insumos por modificador\", \"Insumos al alza\", e \"Ingeniería\" (\"Estrellas\", \"Caballitos de batalla\", \"Incógnitas\", \"Perros\").",
      legacy:
        "Cargás los insumos, armás las recetas y el sistema descuenta el inventario al vender para calcular el costo real (CMV).",
    },
    {
      slug: "sub-recetas-y-produccion",
      title: "Crea sub-recetas y registra la producción por lotes",
      covers:
        "\"Nueva sub-receta\" (insumo elaborado y rendimiento), \"Producir\" / \"Registrar producción\", consumo estimado, costo parcial y que no se anula un lote.",
    },
    {
      slug: "inventario-del-dia-a-dia",
      title: "Registra entradas, ajustes y mermas de inventario",
      covers:
        "\"Existencias\" (filtros \"Bajo mínimo\", \"Con existencias\", \"Mostrar archivados\"): \"Entrada\", \"Ajuste\", \"Merma\" y motivos, costo promedio, \"Categorías sin inventario\"; \"Movimientos\" y el consumo por venta (requiere Inventario y Recetas, y \"Llevar inventario\" en el plato y en el insumo).",
    },
    {
      slug: "conteo-de-inventario",
      title: "Haz un conteo físico con lector de código de barras",
      covers:
        "\"Nuevo conteo\" (\"Qué contar\"), etapas \"Conteo inicial\", \"Preliminar\", \"Conteo definitivo\" y \"Revisión final\", lector de códigos y varias cantidades por insumo (\"+ Agregar cantidad\"), asociar códigos (\"Agregar código de barras\" / \"Agregar otro código\"), \"Guardar borrador\", \"Ver preliminar\", \"Iniciar conteo definitivo\", \"Confirmar y ajustar inventario\", \"Borrar conteo\" y \"Reiniciar conteo definitivo\" si el inventario cambió.",
    },
    {
      slug: "ordenes-de-compra",
      title: "Haz órdenes de compra, recibe la mercancía y paga a tus proveedores",
      covers:
        "\"Nueva orden\" (de la lista de precios o sin presentación, IVA, descuentos por línea y sobre el total), \"Sugerir por reorden\" (requiere Inventario y proveedor preferido), estados, \"Enviar por WhatsApp\" / \"Imprimir\" / \"Marcar enviada\", \"Anular orden\", \"Recibir mercancía\" (parcial), \"Por pagar\", \"Registrar pago\" (\"Se pagó desde\"), \"Pagar saldo\" y \"Editar factura\".",
    },
    {
      slug: "cargar-facturas-de-compra",
      title: "Registra una compra subiendo la factura",
      covers:
        "\"Cargar factura\" (PDF o imagen hasta 15 MB), \"Revisar factura\", crear proveedor o insumo al vuelo, \"Recordar esta relación…\", retenciones, cuenta de cobro, \"Solo crear borrador\" o \"Crear y recibir\", impuestos por línea (\"Impuestos incluidos en este importe\", impuesto al consumo) y \"Sugerir retenciones\".",
      legacy:
        "En Compras subís una foto o PDF y la IA extrae proveedor, insumos, cantidades e impuestos para que los revises antes de guardar.",
    },
  ],

  /* ─────────────────────────── facturacion ─────────────────────────── */
  facturacion: [
    {
      slug: "impuesto-de-ventas",
      title: "Configura el impuesto de ventas",
      covers:
        "\"Ninguno\", \"Impuesto al consumo (INC)\" o \"IVA\" y la tarifa, que va incluido en el precio, desde cuándo aplica un cambio y que lo emitido a la DIAN no cambia.",
    },
    {
      slug: "resolucion-de-facturacion",
      title: "Carga tu resolución de numeración",
      covers:
        "Campos de la resolución (número, prefijo, rango, vigencia, fecha, próximo consecutivo, correo de recepción), aviso de números por agotarse y que existe con o sin facturación electrónica.",
    },
    {
      slug: "activar-la-facturacion-electronica",
      title: "Activa la facturación electrónica con la DIAN",
      covers:
        "Requisitos de Identidad (NIT, municipio, contacto), \"Certificado digital\", \"Credenciales DIAN\", \"Correr set de pruebas\", \"Consultar estado\" y el paso a Producción.",
    },
    {
      slug: "emision-automatica-de-facturas",
      title: "Cómo se emiten tus facturas y qué hacer si se frenan",
      covers:
        "Emisión al cobrar (consumidor final o nominativa), estados DIAN, reintentos automáticos, banners de bloqueo con su motivo, \"Emitir a la DIAN\" y \"Reintentar emisión\".",
    },
    {
      slug: "solicitudes-de-factura",
      title: "Gestiona las solicitudes de factura",
      covers:
        "\"Facturas electrónicas\": \"Pendientes\" / \"Ya generadas\", \"✓ Marcar como generada\", \"Copiar datos\", \"Rechazar\", \"Imprimir en datáfono\" y \"Copiar CUFE\".",
    },
    {
      slug: "factura-manual",
      title: "Crea una factura manual sin mesa",
      covers:
        "\"Nueva orden\" → \"Factura manual\" o el botón en Mesas, agregar platos o cargos, \"Identificar cliente\" (o consumidor final), cobrar y \"Descartar factura manual\".",
    },
    {
      slug: "imprimir-y-enviar-facturas",
      title: "Imprime, reimprime y envía facturas por correo",
      covers:
        "Impresión automática al cobrar, \"Ver factura\", \"Reimprimir factura\", \"Reenviar por correo\" (con facturación electrónica, solo aceptadas) y el error cuando nadie pidió factura.",
    },
    {
      slug: "notas-credito",
      title: "Emite una nota crédito electrónica",
      covers:
        "\"Numeración de notas crédito\", buscar la factura, ajuste total o parcial, \"Motivo DIAN\", \"Confirmar y enviar a DIAN\", estados, PDF / XML, y descartar o \"Descartar y emitir de nuevo\" una nota rechazada o no recibida por la DIAN.",
    },
    {
      slug: "clientes-de-facturacion",
      title: "Crea clientes para facturar",
      covers:
        "\"Clientes para facturación\": \"Crear cliente\", tipo y número de documento (NIT sin dígito de verificación), correo y teléfono, editar y buscar; diferencia con los comensales registrados.",
    },
  ],

  /* ─────────────────────── contabilidad-y-reportes ─────────────────────── */
  "contabilidad-y-reportes": [
    {
      slug: "como-funciona-la-contabilidad",
      title: "Cómo funciona la contabilidad en MESAPAY",
      covers:
        "El módulo, los menús Contabilidad y Reportes, las pestañas de \"Contabilidad\", el selector de mes, \"Todos los reportes\" y la regla clave: los asientos del mes se crean con \"Generar / actualizar asientos\".",
      legacy:
        "El P&L mensual muestra ventas, CMV, gastos, impuestos y utilidad. Podés descargar el Excel para el contador.",
    },
    {
      slug: "registrar-gastos",
      title: "Registra gastos y gastos recurrentes",
      covers:
        "\"Nuevo gasto\": categoría, cuenta, proveedor, centro de costos, \"Ya está pagado\" o vencimiento, \"Gasto recurrente\" (día 1 a 28) y la lista de recurrentes.",
    },
    {
      slug: "pyg-y-libros-del-mes",
      title: "Lee el PYG del mes y exporta los libros",
      covers:
        "PYG (ventas, CMV real, mermas, gastos, costo laboral, prime cost, ventas por categoría) y Libros de ventas y compras con \"Exportar CSV\" y \"Descargar Excel para el contador\".",
    },
    {
      slug: "plan-de-cuentas",
      title: "Ajusta el plan de cuentas",
      covers:
        "PUC, \"Nueva cuenta\" con \"Sugerir con IA\", \"Agregar auxiliar\", \"Importar el plan de cuentas de mi contador\", exportar y desactivar.",
    },
    {
      slug: "cerrar-el-mes-contable",
      title: "Genera los asientos y cierra el mes",
      covers:
        "\"Generar / actualizar asientos\", estados del mes (\"Cuadra\"), \"Cierre de período\": \"Cerrar mes\", numeración, \"Reabrir último mes\" y el cierre del ejercicio.",
    },
    {
      slug: "comprobantes-contables",
      title: "Crea, edita o reversa comprobantes",
      covers:
        "\"Nuevo comprobante\" de partida doble, tercero, \"Cuadrado ✓\", cuándo se puede editar, eliminar o \"Reversar\", y los errores frecuentes.",
    },
    {
      slug: "conciliacion-bancaria",
      title: "Concilia el extracto del banco",
      covers:
        "\"Importar extracto\", reglas \"Si la descripción contiene…\", \"Aplicar reglas\", \"Contabilizar\" o \"Ignorar\" y meses cerrados.",
    },
    {
      slug: "activos-fijos-y-diferidos",
      title: "Activos fijos, depreciación y diferidos",
      covers:
        "\"Nuevo activo\" (vida útil, salvamento, cuentas), depreciación en línea recta, \"Dar de baja\"; \"Nuevo diferido\" (gasto o ingreso por anticipado), proyección y baja.",
    },
    {
      slug: "presupuestos-y-centros-de-costos",
      title: "Presupuestos y centros de costos",
      covers:
        "\"Agregar presupuesto\" por cuenta o prefijo, general o por centro, \"Aplicar a todos los meses del año\", ejecución del mes y crear o desactivar centros de costos.",
    },
    {
      slug: "impuestos-y-retenciones",
      title: "IVA, INC, retenciones y pago de impuestos",
      covers:
        "Pestaña Impuestos (impuestos del mes, conceptos de retención y UVT, \"Registrar pago\"), \"Impuestos del período\" e \"Impuestos detallados\"; que no reemplaza la declaración.",
    },
    {
      slug: "informacion-exogena",
      title: "Prepara la información exógena",
      covers:
        "\"Información exógena\": año gravable, formatos, \"Incidencias\" que bloquean, \"Corregir\", \"Descargar XML\", captura manual 1010 / 1012, y el TXT 1001 de la pestaña Impuestos.",
    },
    {
      slug: "libros-y-estados-financieros",
      title: "Libros oficiales y estados financieros",
      covers:
        "\"Libro diario\" (detallado o resumido), \"Libro mayor\", \"Balance de prueba\" (niveles PUC), \"Estado de resultado\" y \"Estado de situación financiera\": filtros, CSV, impresión y verificación de cuadre.",
    },
    {
      slug: "cartera",
      title: "Cartera: cuentas por cobrar y por pagar",
      covers:
        "\"Cartera (CxC/CxP)\": pestañas, \"Corte hasta\", antigüedad por tercero, extracto del tercero y dónde se registran los abonos.",
    },
    {
      slug: "reporte-de-comisiones",
      title: "Reporte de comisiones de ventas",
      covers:
        "\"Comisiones de ventas\": resumen por persona, detalle cuenta a cuenta, CSV, cómo se calcula la base y que las devoluciones no se descuentan solas.",
    },
    {
      slug: "pulso",
      title: "Pregúntale a Pulso sobre tu negocio",
      covers:
        "El asistente \"Pulso\": preguntas sugeridas, en qué planes está, límite diario de preguntas y qué datos usa.",
    },
  ],

  /* ─────────────────────────── equipo-y-nomina ─────────────────────────── */
  "equipo-y-nomina": [
    {
      slug: "crear-el-equipo",
      title: "Registra a tu equipo y sus salarios",
      covers:
        "\"Nuevo empleado\": cargo, \"Salario básico mensual\" y \"Valor hora ordinaria\" (salario ÷ divisor, solo para recargos), usuario del app, \"Horario de plantilla\", registro facial y desactivar en vez de eliminar.",
    },
    {
      slug: "turnos-y-asistencia",
      title: "Planea los turnos y controla la asistencia",
      covers:
        "\"Semana\" (\"Nuevo turno\", \"Copiar semana anterior\", \"Aplicar plantilla\"), \"Hoy\" (\"Entró\" / \"Salió\", \"Turno extra\"), \"Revisiones\", ajustes de recargos, divisor y \"Asistencia estricta\", y \"Descargar reporte\".",
    },
    {
      slug: "kiosko-de-asistencia",
      title: "Instala y usa el kiosko de asistencia",
      covers:
        "Tablet con \"MP Asistencia\", \"Entrada\" / \"Salida\" con la cámara, reconocimiento en el dispositivo, \"¿Quién eres?\" cuando no reconoce y los errores frecuentes.",
    },
    {
      slug: "liquidar-la-nomina",
      title: "Liquida la nómina del mes",
      covers:
        "\"Liquidar / actualizar nómina\", devengados, deducciones, aportes y provisiones, \"Parámetros\", el asiento contable y que las cifras son de referencia.",
    },
    {
      slug: "comisiones-de-meseros",
      title: "Configura las comisiones de los meseros",
      covers:
        "\"Comisión (%)\" en \"Mesas por mesero\", que se fija al cobrar cada cuenta, la base sin propina ni impuesto, a quién se le asigna la cuenta y \"Mis comisiones\" en la app del mesero; el reporte \"Comisiones de ventas\" (requiere contabilidad) y que no entra en la nómina.",
    },
  ],

  /* ─────────────────────────── pagos-en-linea ─────────────────────────── */
  "pagos-en-linea": [
    {
      slug: "activar-pagos-en-linea",
      title: "Activa los pagos en línea",
      covers:
        "\"Activar pagos\": los siete documentos (máx. 10 MB, PDF/JPG/PNG/WebP, composición accionaria de menos de 90 días), lectura con IA del RUT y de la certificación bancaria, representante legal a mano, titular igual al RUT, \"Enviar solicitud\", el formulario de alta que MESAPAY entrega solo a Kushki, y los estados (\"En revisión\", \"Entrega pendiente a Kushki\", \"¡Listo para cobrar!\", \"Solicitud rechazada\"), con \"Editar documentos\" y \"Reenviar solicitud\" durante la revisión.",
    },
    {
      slug: "medios-de-pago-en-linea",
      title: "Tarjeta, PSE y Apple Pay para tus clientes",
      covers:
        "Qué medios ve el comensal y quién los habilita (MESAPAY), Apple Pay solo en Safari de iPhone o Mac y si MESAPAY lo activa, y los medios del depósito de reservas.",
    },
    {
      slug: "wallet-y-transferencias",
      title: "Tu saldo en Wallet y las transferencias al banco",
      covers:
        "\"Saldo disponible\" y \"Pendiente\", \"Pasar al banco\", \"Transferir a otra cuenta\", la lista \"Transferencias\" con sus estados, y que \"Dispersión automática\" hoy solo guarda la preferencia.",
    },
    {
      slug: "bonos-empresariales",
      title: "Bonos empresariales: configura y emite",
      covers:
        "\"Modo de cobro\" (\"Prepago\" / \"A crédito\"), valores por defecto, \"Emitir bonos\", lotes y sus estados, cancelar bonos o lotes y cómo los redimen los invitados.",
    },
    {
      slug: "corte-de-bonos",
      title: "Cierra el corte de bonos y cobra lo usado",
      covers:
        "\"Bonos usados y corte\": filtros, redenciones, \"Exportar CSV\", \"Cerrar corte\", \"Cortes\" y \"Reenviar correo\".",
    },
    {
      slug: "links-de-pago",
      title: "Links de pago de bonos",
      covers:
        "Que los links de pago se crean solos con los bonos (lote prepago o corte a crédito), qué ve la empresa al pagar (tarjeta, PSE, Apple Pay) y cuando un link ya no está disponible.",
    },
  ],

  /* ─────────────────────────── impresion-y-equipos ─────────────────────────── */
  "impresion-y-equipos": [
    {
      slug: "como-imprimir-las-comandas",
      title: "Elige cómo imprimir las comandas",
      covers:
        "Las dos formas (programa de impresión o pestaña del navegador), \"Impresión de tickets\" en Estaciones con \"Marchar automáticamente\" y ancho del papel, la pestaña \"Impresora — Cocina\" / \"Bar\" con \"Imprimir prueba\" e impresión silenciosa, y los avisos de impresión sin impresora.",
    },
    {
      slug: "instalar-el-agente-de-impresion",
      title: "Instala el programa de impresión en el computador",
      covers:
        "Descarga y aviso de Windows, carpeta fija, servicio (install / start / query), vincular con el token \"mpa_\" desde \"Impresoras de red\", agregar cada impresora (IP, puerto, estación, ancho), \"Imprimir prueba\" y fijar la IP.",
    },
    {
      slug: "impresoras-de-red",
      title: "Revisa tus impresoras desde el panel",
      covers:
        "\"Impresoras de red\": computadores y su estado (\"Responde\", \"Sin responder\", \"Nunca se conectó\"), \"Revocar\" y \"Eliminar equipo\", impresoras reportadas (\"Apagar\" / \"Encender\", \"Imprimir prueba\"), \"Últimos trabajos\" y \"Reimprimir\", y la sección \"Facturas\".",
    },
    {
      slug: "cuando-no-imprime",
      title: "Qué hacer cuando no sale una comanda o una factura",
      covers:
        "Diagnóstico por el bloque Estado del programa, sin conexión, token rechazado, impresora sin papel o en otra red, IP cambiada, todo en cero (categorías sin estación), servicio detenido y el archivo de registro para soporte.",
    },
    {
      slug: "datafonos",
      title: "Configura los datáfonos y asígnalos",
      covers:
        "\"Datáfonos\" (solo con datáfono Kushki activo): \"Código de comercio\", \"Agregar datáfono\" con serial, \"Activo\" / \"Inactivo\", \"Mesero asignado\", el usuario Datáfono y su pantalla \"Mesas en vivo\", y el datáfono propio del comercio.",
    },
    {
      slug: "tablet-de-cocina-y-bar",
      title: "Usa una tablet como pantalla de cocina o bar",
      covers:
        "Usuario con rol Cocina o Bar, entrar desde la tablet, instalar \"MP COCINA\" / \"MP BAR\", usarla en horizontal, activar el sonido de pedidos nuevos y mantenerla encendida.",
    },
    {
      slug: "copias-de-seguridad",
      title: "Crea y restaura copias de seguridad",
      covers:
        "Qué guarda y qué no, copia automática diaria (4:00 a. m.) y manuales (hasta 5), 7 días de vigencia, \"Restaurar\" con la palabra RESTAURAR y la copia previa, \"Eliminar\" y los casos en que no se puede restaurar.",
    },
  ],
};

/** Todos los slugs del outline, en orden. */
export function outlineSlugs(): string[] {
  return Object.values(HELP_OUTLINE).flatMap((list) => list.map((e) => e.slug));
}

/** Categoría a la que pertenece un slug, o null si no está en el outline. */
export function outlineCategoryOf(slug: string): HelpCategoryId | null {
  for (const [cat, list] of Object.entries(HELP_OUTLINE)) {
    if (list.some((e) => e.slug === slug)) return cat as HelpCategoryId;
  }
  return null;
}
