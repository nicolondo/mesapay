/**
 * Cliente de Prisma FALSO para los tests del borrado (no es código de
 * producción: sólo lo importan los *.test.ts). Responde cualquier
 * `cliente.<modelo>.<método>()` con un valor neutro y anota cada llamada en
 * `events`, para poder afirmar el ORDEN (archivo antes que borrado, disco
 * después del commit…).
 */
type Row = Record<string, unknown>;
type Args = { where?: Record<string, unknown>; skip?: number; select?: Record<string, boolean>; distinct?: string[]; data?: unknown };

export type FakeOptions = {
  restaurant?: Row | null;
  /** Filas que devuelve `findMany` (sin `select`) por delegate, p. ej. { order: [...] }. */
  rows?: Record<string, Row[]>;
  /** Respuesta de `count` (por defecto 0). */
  count?: (model: string, args: Args, state: FakeState) => number;
  /** Respuesta de `findMany` con `select` (por defecto []). */
  select?: (model: string, args: Args) => Row[];
  findUnique?: (model: string, args: Args) => Row | null;
  /** Error que tira `$transaction` en vez de correr el callback. */
  transactionError?: unknown;
};

export type FakeState = { deletesStarted: boolean };
export type FakeCall = { model: string; method: string; args: Args };

export function fakeClient(options: FakeOptions = {}) {
  const events: string[] = [];
  const calls: FakeCall[] = [];
  const state: FakeState = { deletesStarted: false };

  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async (args: Args = {}) => {
          calls.push({ model: name, method, args });
          switch (method) {
            case "count":
              return options.count?.(name, args, state) ?? 0;
            case "findMany":
              // Con `select`: la lista de usuarios del comercio (sin `distinct`) o
              // las búsquedas de referencias (por defecto, ninguna).
              if (args.select) {
                return options.select?.(name, args) ?? (name === "user" && !("distinct" in args) ? (options.rows?.user ?? []) : []);
              }
              if ((args.skip ?? 0) > 0) return [];
              return options.rows?.[name] ?? [];
            case "findUnique":
            case "findUniqueOrThrow":
            case "findFirst": {
              const custom = options.findUnique?.(name, args);
              if (custom !== undefined) return custom;
              if (name === "restaurant") return options.restaurant ?? null;
              return null;
            }
            case "deleteMany":
              state.deletesStarted = true;
              events.push(`deleteMany:${name}`);
              return { count: 0 };
            case "updateMany":
              events.push(`updateMany:${name}`);
              return { count: 0 };
            case "create":
              events.push(`create:${name}`);
              return { id: `${name}-1` };
            case "delete":
              events.push(`delete:${name}`);
              return {};
            default:
              return null;
          }
        },
      },
    );

  const client: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === "then") return undefined;
        if (prop === "$queryRawUnsafe" || prop === "$executeRawUnsafe") {
          return async (sql: string) => {
            events.push(`${prop}:${sql.replace(/\s+/g, " ").trim()}`);
            return prop === "$queryRawUnsafe" ? [{ n: 0 }] : 0;
          };
        }
        if (prop === "$executeRaw" || prop === "$queryRaw") {
          return async (strings: TemplateStringsArray) => {
            events.push(`${prop}:${strings.join("?").replace(/\s+/g, " ").trim().slice(0, 60)}`);
            return prop === "$queryRaw" ? [] : 0;
          };
        }
        if (prop === "$transaction") {
          return async (fn: (tx: unknown) => Promise<unknown>) => {
            if (options.transactionError) throw options.transactionError;
            events.push("tx:begin");
            const result = await fn(client);
            events.push("tx:commit");
            return result;
          };
        }
        return model(prop);
      },
    },
  );
  return { client, events, calls, state };
}
