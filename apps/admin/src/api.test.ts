import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, login } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("admin API client", () => {
  it("keeps the bearer token in the request header and saves only draft content operations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ saved: true, itemCount: 1 }), {
      status: 200, headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("opaque-admin-token");
    await client.saveContent([{ id: "prep-01", status: "draft", channel: "internal" }]);
    expect(fetchMock).toHaveBeenCalledWith("/v1/admin/content/working-copy", expect.objectContaining({
      method: "PUT",
      headers: expect.objectContaining({ authorization: "Bearer opaque-admin-token" })
    }));
  });

  it("surfaces a generic login error without returning credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "账号或密码错误" } }), {
      status: 401, headers: { "content-type": "application/json" }
    })));
    await expect(login("admin@internal.local", "wrong-password")).rejects.toThrow("账号或密码错误");
  });
});
