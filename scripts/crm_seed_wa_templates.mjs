#!/usr/bin/env node
/**
 * Siembra las plantillas globales de WhatsApp del CRM (mensajes fríos).
 * Idempotente: upsert por id fijo — correr de nuevo no duplica ni pisa
 * ediciones manuales (solo crea las que falten).
 *
 * Uso (en el VPS, desde /opt/mesapay/current con el env de prod cargado):
 *   node scripts/crm_seed_wa_templates.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const db = new PrismaClient();

const TEMPLATES = [
  {
    id: "watpl_frio_portero_largo",
    name: "Frío — pedir contacto del encargado",
    body: `Hola 👋 Soy {{comercial}}, de MESAPAY.

Tenemos una plataforma con la que los clientes de {{comercio}} pueden pedir y pagar desde la mesa escaneando un QR — sin app, y el pedido pasa directamente a la cocina, sin que nadie tenga que transcribirlo. Los meseros también pueden ingresar pedidos manualmente para la mesa cuando el cliente prefiere que lo atiendan. La factura sale automática.

¿Me podría poner en contacto con la persona encargada de la administración o las decisiones de tecnología del restaurante? Es para mostrarle una demo breve, sin ningún compromiso. ¡Mil gracias! 🙏`,
  },
  {
    id: "watpl_frio_portero_corto",
    name: "Frío — pedir contacto (corto)",
    body: `Hola 👋 Soy {{comercial}}, de MESAPAY: los clientes piden y pagan desde la mesa con un QR, el pedido pasa directo a la cocina, y los meseros también pueden ingresar pedidos manualmente si la mesa lo prefiere. ¿Sería tan amable de indicarme quién es la persona encargada de la administración de {{comercio}} o pasarme su contacto? Quisiera mostrarle algo que les puede servir. ¡Gracias! 🙏`,
  },
  {
    id: "watpl_frio_dueno_directo",
    name: "Frío — dueño/administrador directo",
    body: `Hola {{nombre}} 👋 Soy {{comercial}}, de MESAPAY.

Le escribo porque conozco {{comercio}} y creo que esto le puede interesar: somos una plataforma donde sus clientes escanean un QR en la mesa, ven la carta con fotos, piden y pagan desde su celular — sin descargar nada. El pedido llega directo a cocina, la factura electrónica sale automática y el cierre de caja cuadra solo.

¿El resultado? Mesas que rotan más rápido, ticket 10–15% más alto, y sus meseros dedicados a atender y recomendar en vez de transcribir pedidos.

¿Le interesa que le muestre una demo de 15 minutos con su propia carta cargada? Sin costo y sin compromiso 🙌`,
  },
];

let created = 0;
for (const tpl of TEMPLATES) {
  const existing = await db.crmWhatsappTemplate.findUnique({ where: { id: tpl.id } });
  if (existing) {
    console.log(`= ya existe: ${tpl.name}`);
    continue;
  }
  await db.crmWhatsappTemplate.create({
    data: { id: tpl.id, name: tpl.name, body: tpl.body, scope: "global", ownerUserId: null },
  });
  created++;
  console.log(`+ creada: ${tpl.name}`);
}

console.log(`Listo: ${created} plantilla(s) creada(s), ${TEMPLATES.length - created} ya existían.`);
await db.$disconnect();
