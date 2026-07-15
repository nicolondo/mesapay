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
      env.MESAPAY_SFTP_PRIVATE_KEY,
  );
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
export async function uploadFileToSftp(args: {
  folder: string;
  fileName: string;
  data: Buffer;
}): Promise<void> {
  const host = env.MESAPAY_SFTP_HOST;
  const username = env.MESAPAY_SFTP_USER;
  const privateKey = env.MESAPAY_SFTP_PRIVATE_KEY;
  if (!host || !username || !privateKey) {
    throw new Error("sftp_not_configured");
  }

  const folder = safeSegment(args.folder) || "sin-nombre";
  const fileName = safeSegment(args.fileName);
  if (!fileName) throw new Error("sftp_empty_filename");

  const sftp = new SftpClient();
  try {
    await sftp.connect({
      host,
      port: env.MESAPAY_SFTP_PORT,
      username,
      privateKey: normalizeKey(privateKey),
      ...(env.MESAPAY_SFTP_PASSPHRASE
        ? { passphrase: env.MESAPAY_SFTP_PASSPHRASE }
        : {}),
      readyTimeout: 20_000,
    });
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
