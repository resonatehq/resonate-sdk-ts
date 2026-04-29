import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Codec } from "../src/codec.js";

const path = resolve(process.argv[2] ?? "office-chair-2026-04-29T16-35-25-815Z.json");
const raw = readFileSync(path, "utf8");
const value = JSON.parse(raw);

const codec = new Codec();

const encoded = codec.encode(value);
const decoded = codec.decode(encoded);

assert.deepStrictEqual(decoded, value);

console.log(`file:           ${path}`);
console.log(`input bytes:    ${raw.length}`);
console.log(`encoded bytes:  ${encoded.data.length}`);
console.log("round-trip OK");
