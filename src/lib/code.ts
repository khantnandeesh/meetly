export const CODE_PATTERN = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

export function isValidCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

export function generateCode(): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const chars = Array.from(bytes, (b) => letters[b % letters.length]).join("");
  return `${chars.slice(0, 3)}-${chars.slice(3, 7)}-${chars.slice(7)}`;
}

/** Accepts a bare code, a code without dashes, or a full meeting link. */
export function parseCode(input: string): string | null {
  let value = input.trim().toLowerCase();
  const fromUrl = value.match(/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?(?:[?#].*)?$/);
  if (fromUrl) return fromUrl[1];
  value = value.replace(/[\s-]/g, "");
  if (/^[a-z]{10}$/.test(value)) {
    return `${value.slice(0, 3)}-${value.slice(3, 7)}-${value.slice(7)}`;
  }
  return null;
}
