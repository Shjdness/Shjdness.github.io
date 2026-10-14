import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchText, isSafeYouTubeUrl, resolveChannelId } from "./youtube";

afterEach(() => { vi.unstubAllGlobals(); });

describe("YouTube fetch boundary", () => {
  it("accepts only HTTPS YouTube hosts without credentials or custom ports", () => {
    expect(isSafeYouTubeUrl("https://www.youtube.com/channel/UC123")).toBe(true);
    for (const url of [
      "http://www.youtube.com/redirect",
      "https://youtube.com.evil.example/",
      "https://user:pass@youtube.com/",
      "https://youtube.com:8443/",
      "https://127.0.0.1/",
    ]) expect(isSafeYouTubeUrl(url)).toBe(false);
  });

  it("does not follow a YouTube redirect to another network target", async () => {
    const mockedFetch = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/private" },
    }));
    vi.stubGlobal("fetch", mockedFetch);
    await expect(fetchText("https://www.youtube.com/@example"))
      .rejects.toThrow("不受信任");
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects YouTube redirect endpoints as channel input", async () => {
    await expect(resolveChannelId("https://www.youtube.com/redirect?q=https://example.invalid"))
      .rejects.toThrow("仅支持 YouTube 频道");
  });
});
