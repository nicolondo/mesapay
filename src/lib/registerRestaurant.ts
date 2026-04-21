import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { db } from "./db";

const CATEGORY_SEED = [
  { slug: "entradas", label: "Entradas", sortOrder: 0 },
  { slug: "platos", label: "Platos fuertes", sortOrder: 1 },
  { slug: "bebidas", label: "Bebidas", sortOrder: 2 },
  { slug: "postres", label: "Postres", sortOrder: 3 },
] as const;

type SeedItem = {
  category: (typeof CATEGORY_SEED)[number]["slug"];
  name: string;
  description: string;
  priceCents: number;
  tags: string[];
  sortOrder: number;
};

const MENU_SEED: SeedItem[] = [
  {
    category: "entradas",
    name: "Ceviche de corvina",
    description:
      "Corvina curada en limón, ají dulce, leche de tigre, crocante de maíz chulpi.",
    priceCents: 3800000,
    tags: ["firma"],
    sortOrder: 0,
  },
  {
    category: "entradas",
    name: "Empanadas de carne",
    description: "Tres empanadas doradas con ají picado de la casa.",
    priceCents: 1800000,
    tags: ["popular"],
    sortOrder: 1,
  },
  {
    category: "entradas",
    name: "Patacones con hogao",
    description: "Plátano verde frito, hogao casero y guacamole.",
    priceCents: 1600000,
    tags: ["veg"],
    sortOrder: 2,
  },
  {
    category: "platos",
    name: "Bandeja paisa",
    description:
      "Frijoles, arroz, carne molida, chicharrón, chorizo, huevo, plátano, aguacate y arepa.",
    priceCents: 4800000,
    tags: ["firma"],
    sortOrder: 0,
  },
  {
    category: "platos",
    name: "Sancocho de gallina",
    description:
      "Caldo tradicional con gallina criolla, papa, yuca, plátano y mazorca.",
    priceCents: 3600000,
    tags: ["popular"],
    sortOrder: 1,
  },
  {
    category: "platos",
    name: "Trucha al ajillo",
    description:
      "Trucha fresca al sartén con ajo dorado, mantequilla de limón y patacones.",
    priceCents: 4200000,
    tags: [],
    sortOrder: 2,
  },
  {
    category: "platos",
    name: "Ensalada de la huerta",
    description: "Mix de hojas, tomate, aguacate, quinoa y vinagreta de maracuyá.",
    priceCents: 2800000,
    tags: ["veg", "nuevo"],
    sortOrder: 3,
  },
  {
    category: "bebidas",
    name: "Limonada de coco",
    description: "Limón, coco rallado y leche condensada, bien fría.",
    priceCents: 1200000,
    tags: ["popular"],
    sortOrder: 0,
  },
  {
    category: "bebidas",
    name: "Jugo natural de mora",
    description: "Mora en agua o leche.",
    priceCents: 900000,
    tags: [],
    sortOrder: 1,
  },
  {
    category: "bebidas",
    name: "Agua con gas",
    description: "Botella 500ml.",
    priceCents: 500000,
    tags: [],
    sortOrder: 2,
  },
  {
    category: "postres",
    name: "Tres leches",
    description: "Bizcocho empapado en tres leches, crema chantilly y canela.",
    priceCents: 1500000,
    tags: ["firma"],
    sortOrder: 0,
  },
  {
    category: "postres",
    name: "Arequipe con brevas",
    description: "Brevas en almíbar con arequipe y queso campesino.",
    priceCents: 1400000,
    tags: [],
    sortOrder: 1,
  },
];

const RESERVED = new Set([
  "www",
  "api",
  "admin",
  "app",
  "signin",
  "signup",
  "operator",
  "operador",
  "t",
  "mesapay",
]);

export function normalizeSlug(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export type RegisterRestaurantInput = {
  restaurantName: string;
  restaurantSlug: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword: string;
};

export type RegisterRestaurantResult =
  | {
      ok: true;
      restaurantId: string;
      restaurantSlug: string;
      userId: string;
    }
  | {
      ok: false;
      error: string;
      status: number;
    };

export async function registerRestaurant(
  input: RegisterRestaurantInput,
): Promise<RegisterRestaurantResult> {
  const email = input.ownerEmail.trim().toLowerCase();
  const slug = normalizeSlug(input.restaurantSlug);
  if (slug.length < 2 || RESERVED.has(slug)) {
    return {
      ok: false,
      error: "Ese identificador no es válido. Intenta con otro.",
      status: 400,
    };
  }

  const [existingUser, existingRestaurant] = await Promise.all([
    db.user.findUnique({ where: { email } }),
    db.restaurant.findUnique({ where: { slug } }),
  ]);
  if (existingUser) {
    return {
      ok: false,
      error: "Ya existe una cuenta con ese correo",
      status: 409,
    };
  }
  if (existingRestaurant) {
    return {
      ok: false,
      error: "Ese identificador de restaurante ya está en uso",
      status: 409,
    };
  }

  const passwordHash = await bcrypt.hash(input.ownerPassword, 10);

  const result = await db.$transaction(async (tx) => {
    const restaurant = await tx.restaurant.create({
      data: {
        slug,
        name: input.restaurantName.trim(),
      },
    });

    const user = await tx.user.create({
      data: {
        email,
        name: input.ownerName.trim(),
        passwordHash,
        role: "operator",
        restaurantId: restaurant.id,
      },
    });

    const categoriesByKey = new Map<string, string>();
    for (const def of CATEGORY_SEED) {
      const cat = await tx.category.create({
        data: {
          restaurantId: restaurant.id,
          slug: def.slug,
          label: def.label,
          sortOrder: def.sortOrder,
        },
      });
      categoriesByKey.set(def.slug, cat.id);
    }

    for (const it of MENU_SEED) {
      const categoryId = categoriesByKey.get(it.category);
      if (!categoryId) continue;
      await tx.menuItem.create({
        data: {
          restaurantId: restaurant.id,
          categoryId,
          name: it.name,
          description: it.description,
          priceCents: it.priceCents,
          tags: it.tags,
          sortOrder: it.sortOrder,
        },
      });
    }

    await tx.table.create({
      data: {
        restaurantId: restaurant.id,
        number: 1,
        qrToken: randomBytes(16).toString("hex"),
      },
    });

    return { restaurant, user };
  });

  return {
    ok: true,
    restaurantId: result.restaurant.id,
    restaurantSlug: result.restaurant.slug,
    userId: result.user.id,
  };
}
