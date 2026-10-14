import { describe, expect, it } from "vitest";
import { imageFormat } from "./image-format";

describe("image upload signatures", () => {
  it("accepts raster image bytes independently of supplied filenames", () => {
    expect(imageFormat(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      .toEqual({ extension: "png", contentType: "image/png" });
    expect(imageFormat(Uint8Array.from([0xff, 0xd8, 0xff])))
      .toEqual({ extension: "jpg", contentType: "image/jpeg" });
  });

  it("rejects markup even when an upload claims an image MIME type", () => {
    expect(imageFormat(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    expect(imageFormat(new TextEncoder().encode("<!doctype html>"))).toBeNull();
  });
});
