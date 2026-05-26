import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
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
    role: Role;
    restaurantId?: string | null;
    groupId?: string | null;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
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
      authorize: async (raw) => {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const user = await db.user.findUnique({
          where: { email: parsed.data.email.toLowerCase() },
        });
        if (!user) return null;
        const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
        if (!ok) return null;
        return {
          id: user.id,
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
        token.userId = user.id as string;
        token.role = (user as { role: Role }).role;
        token.restaurantId = (user as { restaurantId?: string | null }).restaurantId ?? null;
        token.groupId = (user as { groupId?: string | null }).groupId ?? null;
      }
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
