import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  connect: vi.fn(),
  end: vi.fn(),
  list: vi.fn(),
  exists: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
  env: {
    MESAPAY_SFTP_HOST: "example.test",
    MESAPAY_SFTP_USER: "test",
    MESAPAY_SFTP_PRIVATE_KEY: "test-key",
    MESAPAY_SFTP_PORT: 22,
  },
}));
vi.mock("ssh2-sftp-client", () => ({
  default: class {
    connect = m.connect;
    end = m.end;
    list = m.list;
    exists = m.exists;
    delete = m.delete;
  },
}));
import { deleteFileFromSftp, testSftpConnection } from "./sftp";
beforeEach(() => {
  vi.resetAllMocks();
  m.end.mockResolvedValue(undefined);
});
it("closes the connection even when authentication fails before a client is returned", async () => {
  m.connect.mockRejectedValue(new Error("authentication failed"));
  expect(await testSftpConnection()).toEqual({
    ok: false,
    error: "authentication failed",
  });
  expect(m.end).toHaveBeenCalledTimes(1);
  expect(m.list).not.toHaveBeenCalled();
});

describe("deleteFileFromSftp", () => {
  const args = { folder: "SON Y MELONA SAS - 901944469", fileName: "RUT.pdf" };
  it("borra el archivo remoto cuando existe y cierra la conexión", async () => {
    m.exists.mockResolvedValue(true);
    m.delete.mockResolvedValue(undefined);
    await deleteFileFromSftp(args);
    expect(m.exists).toHaveBeenCalledWith("/SON Y MELONA SAS - 901944469/RUT.pdf");
    expect(m.delete).toHaveBeenCalledWith("/SON Y MELONA SAS - 901944469/RUT.pdf");
    expect(m.end).toHaveBeenCalledTimes(1);
  });
  it("no llama a delete cuando el archivo no existe", async () => {
    m.exists.mockResolvedValue(false);
    await deleteFileFromSftp(args);
    expect(m.delete).not.toHaveBeenCalled();
    expect(m.end).toHaveBeenCalledTimes(1);
  });
  it("lanza si el borrado remoto falla, pero igual cierra la conexión", async () => {
    m.exists.mockResolvedValue(true);
    m.delete.mockRejectedValue(new Error("permission denied"));
    await expect(deleteFileFromSftp(args)).rejects.toThrow("permission denied");
    expect(m.end).toHaveBeenCalledTimes(1);
  });
});
