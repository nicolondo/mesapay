import { rateLimit } from "@/lib/rateLimit";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { canStaffSignIn } from "@/lib/staffLogin";
import type { Role } from "@prisma/client";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      role: Role;
      restaurantId?: string | null;
      // Para role=group_admin: el grupo al que pertenece. Le permite
      // ver /group con los restaurantes de SU grupo + impersonar
      // cualquiera de ellos via IMPERSONATE_COOKIE (validado en
      // lib/activeRestaurant.ts).
      groupId?: string | null;
    };
  }
  interface User {
    sessionVersion?: number;
    role: Role;
    restaurantId?: string | null;
    groupId?: string | null;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    sessionVersion?: number;
    role: Role;
    restaurantId?: string | null;
    groupId?: string | null;
    userId: string;
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  session: { strategy: "jwt" },
  trustHost: true,
  pages: { signIn: "/signin" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (raw, req) => {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        if (!await rateLimit(`login:${parsed.data.email.toLowerCase()}`, 10, 300) || !await rateLimit(`login-ip:${req.headers.get("x-real-ip") ?? "unknown"}`, 60, 300)) return null;
        const user = await db.user.findUnique({
          where: { email: parsed.data.email.toLowerCase() },
          select: {
            id: true,
            email: true,
            name: true,
            passwordHash: true,
            role: true,
            restaurantId: true,
            groupId: true,
            disabledAt: true,
            sessionVersion: true,
          },
        });
        if (!user || user.passwordHash.startsWith("!pending-")) return null;
        const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
        if (!ok) return null;
        // Bloquea usuarios desactivados (p.ej. comerciales dados de baja) y
        // las filas legado con role=customer: `User` es SOLO personal desde
        // que el comensal se registra por comercio y vive en `Diner`. La
        // regla está en lib/staffLogin.ts para poder probarla sin NextAuth.
        if (!canStaffSignIn(user)) return null;
        return {
          id: user.id,
          sessionVersion: user.sessionVersion,
          email: user.email,
          name: user.name ?? undefined,
          role: user.role,
          restaurantId: user.restaurantId,
          groupId: user.groupId,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.sessionVersion = user.sessionVersion;
        token.userId = user.id as string;
        token.role = (user as { role: Role }).role;
        token.restaurantId = (user as { restaurantId?: string | null }).restaurantId ?? null;
        token.groupId = (user as { groupId?: string | null }).groupId ?? null;
      }
      const current = await db.user.findUnique({
        where: { id: token.userId },
        select: { sessionVersion: true, disabledAt: true, role: true, restaurantId: true, groupId: true },
      });
      if (!current || current.disabledAt || token.sessionVersion !== current.sessionVersion) return null;
      token.role = current.role;
      token.restaurantId = current.restaurantId;
      token.groupId = current.groupId;
      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.userId;
        session.user.role = token.role;
        session.user.restaurantId = token.restaurantId ?? null;
        session.user.groupId = token.groupId ?? null;
      }
      return session;
    },
  },
});
