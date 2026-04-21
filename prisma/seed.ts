import { PrismaClient } from "@prisma/client";
import type { Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

const U = (id: string, w = 800) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=75`;

const CATEGORIES = [
  { slug: "entradas", label: "Para empezar", sortOrder: 1 },
  { slug: "principales", label: "Principales", sortOrder: 2 },
  { slug: "del-horno", label: "Del horno", sortOrder: 3 },
  { slug: "postres", label: "Postres", sortOrder: 4 },
  { slug: "vinos", label: "Vinos y copas", sortOrder: 5 },
  { slug: "cocteles", label: "Cócteles de autor", sortOrder: 6 },
];

const MENU = [
  // Entradas
  {
    cat: "entradas",
    name: "Ceviche de corvina",
    description:
      "Corvina curada en limón de Tahití, ají dulce, leche de tigre, crocante de maíz chulpi.",
    priceCents: 3800000,
    tags: ["firma", "popular"],
    photoUrl: U("1559847844-5315695dadae"),
    modifiers: [
      {
        id: "picante",
        label: "Nivel de picante",
        type: "radio",
        opts: ["Suave", "Medio", "Bravo"],
        default: "Medio",
      },
    ],
  },
  {
    cat: "entradas",
    name: "Tartar de atún",
    description:
      "Atún aleta amarilla, aguacate hass, sésamo tostado, vinagreta de naranja tangerina.",
    priceCents: 4200000,
    tags: ["nuevo"],
    photoUrl: U("1553621042-f6e147245754"),
  },
  {
    cat: "entradas",
    name: "Burrata de La Calera",
    description:
      "Burrata cremosa, tomates asados al romero, aceite de albahaca, pan de masa madre.",
    priceCents: 3400000,
    tags: ["veg"],
    photoUrl: U("1608897013039-887f21d8c804"),
  },
  {
    cat: "entradas",
    name: "Empanaditas de rabo",
    description:
      "Masa crocante de maíz, rabo desmechado al vino tinto, hogao ahumado, ají de la casa.",
    priceCents: 2800000,
    tags: ["popular"],
    photoUrl: U("1601050690597-df0568f70950"),
  },

  // Principales
  {
    cat: "principales",
    name: "Posta negra reinventada",
    description:
      "Muchacho al horno 8 horas con panela, hoja de laurel, puré de yuca criolla, chimichurri de cilantro.",
    priceCents: 6800000,
    tags: ["firma", "popular"],
    photoUrl: U("1544025162-d76694265947"),
    modifiers: [
      { id: "termino", label: "Término", type: "radio", opts: ["3/4", "Bien cocida"], default: "3/4" },
      {
        id: "acomp",
        label: "Acompañamiento",
        type: "radio",
        opts: ["Yuca criolla", "Puré rústico", "Ensalada verde"],
        default: "Yuca criolla",
      },
    ],
  },
  {
    cat: "principales",
    name: "Trucha del páramo",
    description:
      "Trucha entera al horno, hierbas del huerto, mantequilla noisette, papa criolla confitada.",
    priceCents: 5800000,
    tags: ["nuevo"],
    photoUrl: U("1467003909585-2f8a72700288"),
  },
  {
    cat: "principales",
    name: "Ají de gallina de la abuela",
    description:
      "Pollo campesino deshilachado, salsa de ají amarillo, nuez, papa amarilla, huevo de codorniz.",
    priceCents: 4600000,
    tags: ["spicy"],
    photoUrl: U("1547592180-85f173990554"),
  },
  {
    cat: "principales",
    name: "Risotto de hongos y trufa",
    description:
      "Arroz carnaroli, hongos paris, porcini, aceite de trufa blanca, parmesano reggiano.",
    priceCents: 5200000,
    tags: ["veg", "firma"],
    photoUrl: U("1476124369491-e7addf5db371"),
  },

  // Del horno
  {
    cat: "del-horno",
    name: "Focaccia del día",
    description: "Masa madre de 36 horas, aceite de oliva extravirgen, romero, sal de Guérande.",
    priceCents: 1800000,
    tags: ["veg"],
    photoUrl: U("1586444248902-2f64eddc13df"),
  },
  {
    cat: "del-horno",
    name: "Pan con tomate catalán",
    description: "Pan rústico tostado, tomate rallado, ajo confitado, jamón serrano 18 meses.",
    priceCents: 2600000,
    tags: [],
    photoUrl: U("1509440159596-0249088772ff"),
  },

  // Postres
  {
    cat: "postres",
    name: "Tres leches de guanábana",
    description: "Bizcocho esponjoso, crema de guanábana, merengue flameado, polvo de cacao.",
    priceCents: 2200000,
    tags: ["firma", "popular"],
    photoUrl: U("1488477181946-6428a0291777"),
  },
  {
    cat: "postres",
    name: "Brownie tibio",
    description: "Chocolate 70% origen Arauca, helado de vainilla Bourbon, sal marina.",
    priceCents: 2400000,
    tags: ["veg"],
    photoUrl: U("1606313564200-e75d5e30476c"),
  },
  {
    cat: "postres",
    name: "Tarta de maracuyá",
    description: "Base de galleta, crema de maracuyá del Huila, merengue italiano.",
    priceCents: 2100000,
    tags: ["nuevo", "veg"],
    photoUrl: U("1571877227200-a0d98ea607e9"),
  },

  // Vinos
  {
    cat: "vinos",
    name: "Malbec Reserva · copa",
    description: "Mendoza, Argentina. Notas de mora, ciruela y vainilla tostada.",
    priceCents: 2800000,
    tags: [],
    photoUrl: U("1510812431401-41d2bd2722f3"),
  },
  {
    cat: "vinos",
    name: "Sauvignon Blanc · copa",
    description: "Valle de Casablanca, Chile. Cítrico, herbal, mineral.",
    priceCents: 2400000,
    tags: [],
    photoUrl: U("1568213816046-0ee1c42bd559"),
  },
  {
    cat: "vinos",
    name: "Carménère · botella",
    description: "Colchagua, Chile. 750ml. Especiado, notas de pimienta negra.",
    priceCents: 14000000,
    tags: ["firma"],
    photoUrl: U("1553361371-9b22f78e8b1d"),
  },

  // Cócteles
  {
    cat: "cocteles",
    name: "Teresita",
    description: "Ron de Santander añejo, miel de caña, limón criollo, aromas de mandarina.",
    priceCents: 3200000,
    tags: ["firma"],
    photoUrl: U("1514362545857-3bc16c4c7d1b"),
  },
  {
    cat: "cocteles",
    name: "Negroni de la casa",
    description: "Gin botánico, campari, vermouth rosso, twist de naranja quemada.",
    priceCents: 3400000,
    tags: ["popular"],
    photoUrl: U("1551024709-8f23befc6f87"),
  },
  {
    cat: "cocteles",
    name: "Jardín de Chapinero",
    description: "Mezcal, shrub de piña, albahaca, ají dulce, tónica artesanal.",
    priceCents: 3600000,
    tags: ["nuevo", "spicy"],
    photoUrl: U("1587223962930-cb7f31384c19"),
  },
];

async function main() {
  console.log("Seeding...");

  // Demo tenant
  const teresita = await db.restaurant.upsert({
    where: { slug: "casa-teresita" },
    update: { name: "Casa Teresita", tagline: "Bistró de barrio · Chapinero" },
    create: {
      slug: "casa-teresita",
      name: "Casa Teresita",
      tagline: "Bistró de barrio · Chapinero",
    },
  });
  console.log("Tenant:", teresita.slug);

  // Categories
  const catByslug: Record<string, string> = {};
  for (const c of CATEGORIES) {
    const cat = await db.category.upsert({
      where: { restaurantId_slug: { restaurantId: teresita.id, slug: c.slug } },
      update: { label: c.label, sortOrder: c.sortOrder },
      create: { restaurantId: teresita.id, ...c },
    });
    catByslug[c.slug] = cat.id;
  }

  // Menu items (wipe and re-create so edits in seed are authoritative)
  await db.menuItem.deleteMany({ where: { restaurantId: teresita.id } });
  for (const [i, m] of MENU.entries()) {
    await db.menuItem.create({
      data: {
        restaurantId: teresita.id,
        categoryId: catByslug[m.cat],
        name: m.name,
        description: m.description,
        priceCents: m.priceCents,
        tags: m.tags,
        photoUrl: m.photoUrl,
        modifiers: m.modifiers ?? undefined,
        sortOrder: i,
      },
    });
  }
  console.log(`Seeded ${MENU.length} menu items.`);

  // Tables (1..20)
  for (let n = 1; n <= 20; n++) {
    const token = `cs${n.toString().padStart(2, "0")}-${Math.random().toString(36).slice(2, 8)}`;
    await db.table.upsert({
      where: { restaurantId_number: { restaurantId: teresita.id, number: n } },
      update: {},
      create: {
        restaurantId: teresita.id,
        number: n,
        label: `Mesa ${n}`,
        qrToken: token,
      },
    });
  }
  console.log("Seeded 20 tables.");

  // Test accounts
  const pwHash = await bcrypt.hash("mesapay123", 10);
  const accounts: Array<{ email: string; name: string; role: Role; restaurantId?: string }> = [
    {
      email: "cliente@mesapay.co",
      name: "Cliente Demo",
      role: "customer",
    },
    {
      email: "mesero@casateresita.co",
      name: "Andrés M.",
      role: "operator",
      restaurantId: teresita.id,
    },
    {
      email: "admin@mesapay.co",
      name: "Platform Admin",
      role: "platform_admin",
    },
  ];
  for (const a of accounts) {
    await db.user.upsert({
      where: { email: a.email },
      update: { name: a.name, role: a.role, restaurantId: a.restaurantId ?? null },
      create: {
        email: a.email,
        name: a.name,
        role: a.role,
        restaurantId: a.restaurantId ?? null,
        passwordHash: pwHash,
      },
    });
  }
  console.log("Seeded test accounts (password: mesapay123).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
