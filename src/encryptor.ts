import type { Value } from "./types";

export interface Encryptor {
  encrypt(plaintext: Value<string>): Value<string>;
  decrypt(ciphertext: Value<string>): Value<string>;
}

export class NoopEncryptor implements Encryptor {
  encrypt(plaintext: Value<string>): Value<string> {
    return plaintext;
  }

  decrypt(ciphertext: Value<string>): Value<string> {
    return ciphertext;
  }
}
