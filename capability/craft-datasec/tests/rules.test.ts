import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RULES, Sanitizer, enabledBuiltinRules } from "../rules.ts";

test("built-in rules sanitize default and opt-in sensitive values", () => {
  const tokens: Array<[string, string]> = [];
  const sanitizer = new Sanitizer(DEFAULT_RULES.map(rule => ({ ...rule, enabled: true })), (name, value) => {
    tokens.push([name, value]);
    return `[TOKEN_${name}]`;
  });
  assert.equal(sanitizer.text("call 13812345678"), "call [TOKEN_phone]");
  assert.equal(sanitizer.text("mail user@example.com"), "mail u*@example.com");
  assert.equal(sanitizer.text("[CRAFT_DATASEC_phone_0123456789abcdef0123456789abcdef]"), "[CRAFT_DATASEC_phone_0123456789abcdef0123456789abcdef]");
  assert.equal(sanitizer.text("phone 13812345678 and 13912345678"), "phone [TOKEN_phone] and [TOKEN_phone]");
  assert.equal(sanitizer.text("overlap 1381234567813912345678"), "overlap 1381234567813912345678");
  assert.deepEqual(tokens.slice(0, 1), [["phone", "13812345678"]]);
  assert.throws(() => enabledBuiltinRules("unknown"), /Unknown/u);
  assert.equal(enabledBuiltinRules("bank").some(rule => rule.name === "bank" && rule.enabled), true);
});

test("sanitizer value recursion, numeric redaction and validation stay bounded", () => {
  const sanitizer = new Sanitizer([{ name: "digits", pattern: "123", group: 0 }], () => "[X]");
  assert.deepEqual(sanitizer.value({ "123": 123, list: ["123", true, null] }), { "[X]": "[X]", list: ["[X]", true, null] });
  assert.equal(sanitizer.value(456), 456);
  assert.equal(sanitizer.text("no match"), "no match");
  assert.throws(() => sanitizer.value(Array(70).fill(null).reduce((value) => [value], "123")), /nesting/u);
  assert.throws(() => new Sanitizer([], () => "[X]"), /No rules/u);
  assert.throws(() => new Sanitizer([{ name: "Bad Name", pattern: "x" }], () => "[X]"), /Invalid rule/u);
  assert.throws(() => new Sanitizer([{ name: "bad", pattern: "([", group: 1 }], () => "[X]"));
});

test("default rules select, validate and reject malformed email matches", () => {
  assert.equal(enabledBuiltinRules(undefined), DEFAULT_RULES);
  assert.throws(() => enabledBuiltinRules(" , "), /Unknown/u);
  const sanitizer = new Sanitizer([{ name: "email", pattern: String.raw`\b[A-Z0-9@.-]+\b`, flags: "i" }], () => "[X]");
  assert.throws(() => sanitizer.text("@@bad"), /Invalid email/u);
});

test("numeric values stay numeric when no sanitizer rule matches", () => {
  const sanitizer = new Sanitizer([{ name: "letters", pattern: "[a-z]+" }], (name) => `[${name}]`);
  assert.equal(sanitizer.value(42), 42);
  assert.equal(sanitizer.value(true), true);
});

test("rule flags are deduplicated and grouped captures sanitize values", () => {
  const sanitizer = new Sanitizer([{ name: "secret", pattern: "value=([A-Z]+)", flags: "gi", group: 1 }], (name, value) => `[${name}:${value}]`);
  assert.equal(sanitizer.text("VALUE=abc value=XYZ"), "VALUE=[secret:abc] value=[secret:XYZ]");
});

test("sanitizer handles alternate rule flags and capture groups", () => {
  const sanitizer = new Sanitizer([{ name: "word", pattern: "X([0-9])", flags: "i", group: 1 }], (name, value) => `[${name}:${value}]`);
  assert.equal(sanitizer.text("x1"), "x[word:1]");
});

test("sanitizer leaves empty text and non-string leaves unchanged", () => {
  const sanitizer = new Sanitizer([{ name: "word", pattern: "x", flags: "g" }], () => "[X]");
  assert.equal(sanitizer.text(""), "");
  assert.equal(sanitizer.value(false), false);
  assert.equal(sanitizer.value(null), null);
});

test("email rule masks only the local part", () => {
  const sanitizer = new Sanitizer([{ name: "email", pattern: String.raw`[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}`, flags: "i" }], () => "[X]");
  assert.equal(sanitizer.text("user.name@example.com"), "u*@example.com");
});

test("existing protected ranges are not sanitized twice", () => {
  const token = "[CRAFT_DATASEC_word_0123456789abcdef0123456789abcdef]";
  const sanitizer = new Sanitizer([{ name: "word", pattern: "[A-Za-z]+" }], () => "[X]");
  assert.equal(sanitizer.text(token), token);
});

test("overlapping matches are ignored and later matches still sanitize", () => {
  const sanitizer = new Sanitizer([
    { name: "wide", pattern: "abcdef" },
    { name: "inner", pattern: "bcd" },
    { name: "tail", pattern: "xyz" },
  ], (name) => `[${name}]`);
  assert.equal(sanitizer.text("abcdef xyz"), "[wide] [tail]");
});

test("same-start matches prefer the longest match", () => {
  const sanitizer = new Sanitizer([
    { name: "short", pattern: "ab" },
    { name: "long", pattern: "abc" },
  ], (name) => `[${name}]`);
  assert.equal(sanitizer.text("abc"), "[long]");
});
