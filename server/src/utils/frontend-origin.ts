export function frontendOrigin(configuredUrl: string): string {
  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error("FRONTEND_URL must be a valid absolute URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password) {
    throw new Error("FRONTEND_URL must be an HTTPS origin (or local development URL)");
  }
  return url.origin;
}
