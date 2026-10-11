/**
 * Turkish is typed with its own letters ("hatırla", "yanlış"), but the intent
 * patterns are spelled without them, and neither the `i` flag nor `\b` bridges
 * the gap: `/hatirla/i` does not match "hatırla", and `\b` treats "ş" as a
 * separator. Matching against the folded text reads both spellings alike.
 *
 * One code unit in, one code unit out, so an index found in the folded text
 * points at the same place in the original.
 */
const TURKISH_TO_ASCII: Readonly<Record<string, string>> = {
  ı: "i", İ: "I", ş: "s", Ş: "S", ğ: "g", Ğ: "G", ü: "u", Ü: "U", ö: "o", Ö: "O", ç: "c", Ç: "C",
};

export function foldTurkishLetters(text: string): string {
  return text.replace(/[ıİşŞğĞüÜöÖçÇ]/g, (letter) => TURKISH_TO_ASCII[letter] ?? letter);
}
