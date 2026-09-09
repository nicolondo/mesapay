import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ connect: vi.fn(), end: vi.fn(), list: vi.fn() }));
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
  },
}));
import { testSftpConnection } from "./sftp";
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
