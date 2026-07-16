import { readFile } from "fs/promises";
import SftpClient from "ssh2-sftp-client";
import { env } from "@/lib/env";

/**
 * Entrega de archivos por SFTP a AWS Transfer Family. La llave privada y el
 * host/usuario viven SOLO en el .env del server (nunca en el repo). Si no está
 * configurado, `sftpConfigured()` es false y el caller omite la subida.
 */
export function sftpConfigured(): boolean {
  return Boolean(
    env.MESAPAY_SFTP_HOST &&
      env.MESAPAY_SFTP_USER &&
      (env.MESAPAY_SFTP_PRIVATE_KEY || env.MESAPAY_SFTP_PRIVATE_KEY_FILE),
  );
}

/**
 * Resuelve la llave privada: desde el archivo (MESAPAY_SFTP_PRIVATE_KEY_FILE,
 * recomendado) o inline (MESAPAY_SFTP_PRIVATE_KEY). null si no se pudo obtener.
 */
async function resolvePrivateKey(): Promise<string | null> {
  if (env.MESAPAY_SFTP_PRIVATE_KEY_FILE) {
    try {
      return await readFile(env.MESAPAY_SFTP_PRIVATE_KEY_FILE, "utf8");
    } catch (err) {
      console.error(
        "[sftp] no pude leer MESAPAY_SFTP_PRIVATE_KEY_FILE",
        env.MESAPAY_SFTP_PRIVATE_KEY_FILE,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }
  return env.MESAPAY_SFTP_PRIVATE_KEY
    ? normalizeKey(env.MESAPAY_SFTP_PRIVATE_KEY)
    : null;
}

/**
 * Algunas plataformas guardan la llave privada en una sola línea con "\n"
 * literales. PEM necesita saltos reales — los normalizamos si hace falta.
 */
function normalizeKey(key: string): string {
  return key.includes("\\n") && !key.includes("\n")
    ? key.replace(/\\n/g, "\n")
    : key;
}

/** Nombre seguro de carpeta/archivo remoto (sin barras ni saltos). */
function safeSegment(s: string): string {
  return s.replace(/[/\\\r\n]/g, "").trim();
}

/**
 * Sube un buffer a `<folder>/<fileName>` en el SFTP, creando la carpeta si no
 * existe. Lanza si algo falla (el caller decide best-effort/reintento).
 */
/** Abre una conexión SFTP con la config del server. Lanza si falta config. */
async function connectSftp(): Promise<SftpClient> {
  const host = env.MESAPAY_SFTP_HOST;
  const username = env.MESAPAY_SFTP_USER;
  const privateKey = await resolvePrivateKey();
  if (!host || !username || !privateKey) {
    throw new Error("sftp_not_configured");
  }
  const sftp = new SftpClient();
  await sftp.connect({
    host,
    port: env.MESAPAY_SFTP_PORT,
    username,
    privateKey,
    ...(env.MESAPAY_SFTP_PASSPHRASE
      ? { passphrase: env.MESAPAY_SFTP_PASSPHRASE }
      : {}),
    readyTimeout: 20_000,
  });
  return sftp;
}

export async function uploadFileToSftp(args: {
  folder: string;
  fileName: string;
  data: Buffer;
}): Promise<void> {
  const folder = safeSegment(args.folder) || "sin-nombre";
  const fileName = safeSegment(args.fileName);
  if (!fileName) throw new Error("sftp_empty_filename");

  const sftp = await connectSftp();
  try {
    // AWS Transfer chrootea al home del usuario → la carpeta cuelga de la raíz.
    const remoteDir = `/${folder}`;
    const exists = await sftp.exists(remoteDir);
    if (!exists) {
      await sftp.mkdir(remoteDir, true);
    }
    await sftp.put(args.data, `${remoteDir}/${fileName}`);
  } finally {
    await sftp.end().catch(() => undefined);
  }
}

/**
 * Diagnóstico: conecta al SFTP y lista la raíz. Para verificar credenciales/
 * conectividad sin subir un documento real. No lanza — devuelve ok/error.
 */
export async function testSftpConnection(): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (!sftpConfigured()) return { ok: false, error: "sftp_not_configured" };
  let sftp: SftpClient | null = null;
  try {
    sftp = await connectSftp();
    await sftp.list("/");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message.slice(0, 300)
          : String(err).slice(0, 300),
    };
  } finally {
    if (sftp) await sftp.end().catch(() => undefined);
  }
}
