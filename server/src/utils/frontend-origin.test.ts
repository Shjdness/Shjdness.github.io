import { describe, expect, it } from "vitest";
import { frontendOrigin } from "./frontend-origin";

describe("trusted frontend origin", () => {
  it("uses only the configured site origin for OAuth and CORS", () => {
    expect(frontendOrigin("https://shjdness.github.io/some/path"))
      .toBe("https://shjdness.github.io");
    expect(frontendOrigin("http://localhost:5173"))
      .toBe("http://localhost:5173");
  });

  it("rejects malformed, insecure and credential-bearing endpoints", () => {
    for (const value of ["", "example.com", "http://example.com", "https://user:pass@example.com"]) {
      expect(() => frontendOrigin(value)).toThrow();
    }
  });
});
