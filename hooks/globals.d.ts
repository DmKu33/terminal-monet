// The engine's JavaScript has the TC39 base64 methods on Uint8Array;
// TypeScript 5.6 does not list them yet.
interface Uint8Array {
  toBase64(): string
}
interface Uint8ArrayConstructor {
  fromBase64(text: string): Uint8Array
}
