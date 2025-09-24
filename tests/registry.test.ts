import type { Context } from "../src/context";
import { Registry } from "../src/registry";
describe("Registry", () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  test("registers and retrieves a function by name", () => {
    function foo(_: Context, x: number) {
      return x * 2;
    }

    registry.add(foo);
    const [name, func, version] = registry.get("foo");

    expect(name).toBe("foo");
    expect(func).toBe(foo);
    expect(version).toBe(1);
  });

  test("registers and retrieves a function by reference", () => {
    function bar(_: Context, y: string) {
      return `hi ${y}`;
    }

    registry.add(bar, "customBar", 2);
    const [name, func, version] = registry.get(bar);

    expect(name).toBe("customBar");
    expect(func).toBe(bar);
    expect(version).toBe(2);
  });

  test("throws when registering same name+version twice", () => {
    function baz(_: Context) {
      return 42;
    }

    registry.add(baz, "baz", 1);
    expect(() => registry.add(baz, "baz", 1)).toThrow("function baz already registered");
  });

  test("You cannot register the same function under multiple versions", () => {
    function qux(_: Context) {
      return "ok";
    }

    registry.add(qux, "qux", 1);
    expect(() => registry.add(qux, "qux", 3)).toThrow("function qux already registered");
  });

  test("Multiple version", () => {
    function qux1(_: Context) {
      return "ok";
    }
    function qux2(_: Context) {
      return "ok";
    }

    registry.add(qux1, "qux", 1);
    registry.add(qux2, "qux", 2);
    expect(registry.latest("qux")).toBe(2);
  });

  test("throws when getting unknown function", () => {
    expect(() => registry.get("doesNotExist")).toThrow("function doesNotExist not found in registry");
  });

  test("returns default version when no entries", () => {
    expect(registry.latest("notHere", 99)).toBe(99);
  });

  test("throws if anonymous function registered without name", () => {
    expect(() => registry.add(() => 123)).toThrow("name required when registering an anonymous function");
  });
});
