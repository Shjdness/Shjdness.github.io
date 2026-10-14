export type ImageFormat = { extension: string; contentType: string };

/** Identify upload bytes instead of trusting a filename or browser supplied MIME type. */
export function imageFormat(bytes: Uint8Array): ImageFormat | null {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return { extension: "png", contentType: "image/png" };
  if (starts(0xff, 0xd8, 0xff))
    return { extension: "jpg", contentType: "image/jpeg" };
  if (starts(0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61)
    return { extension: "gif", contentType: "image/gif" };
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
    return { extension: "webp", contentType: "image/webp" };
  const brand = new TextDecoder().decode(bytes.subarray(4, 12));
  if (brand === "ftypavif" || brand === "ftypavis")
    return { extension: "avif", contentType: "image/avif" };
  return null;
}
