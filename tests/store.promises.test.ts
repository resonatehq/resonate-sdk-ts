import { Promises } from "../src/promises";
describe("State Transition Tests", () => {
  test("Test Case 0: transitions from Init to Pending via Create", async () => {
    const promises = new Promises();
    const promise = await promises.create({
      id: "id0",
      timeout: Number.MAX_SAFE_INTEGER,
      iKey: undefined,
      strict: true,
    });

    expect(promise.state).toBe("pending");
    expect(promise.id).toBe("id0");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 1: transitions from Init to Pending via Create", async () => {
    const promises = new Promises();
    const promise = await promises.create({
      id: "id1",
      timeout: Number.MAX_SAFE_INTEGER,
      iKey: undefined,
      strict: false,
    });

    expect(promise.state).toBe("pending");
    expect(promise.id).toBe("id1");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 2: transitions from Init to Pending via Create", async () => {
    const promises = new Promises();
    const promise = await promises.create({ id: "id2", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: true });

    expect(promise.state).toBe("pending");
    expect(promise.id).toBe("id2");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 3: transitions from Init to Pending via Create", async () => {
    const promises = new Promises();
    const promise = await promises.create({ id: "id3", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    expect(promise.state).toBe("pending");
    expect(promise.id).toBe("id3");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 4: transitions from Init to Init via Resolve", async () => {
    const promises = new Promises();
    await expect(promises.resolve({ id: "id4", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 5: transitions from Init to Init via Resolve", async () => {
    const promises = new Promises();
    await expect(promises.resolve({ id: "id5", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 6: transitions from Init to Init via Resolve", async () => {
    const promises = new Promises();
    await expect(promises.resolve({ id: "id6", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 7: transitions from Init to Init via Resolve", async () => {
    const promises = new Promises();
    await expect(promises.resolve({ id: "id7", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 8: transitions from Init to Init via Reject", async () => {
    const promises = new Promises();
    await expect(promises.reject({ id: "id8", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 9: transitions from Init to Init via Reject", async () => {
    const promises = new Promises();
    await expect(promises.reject({ id: "id9", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 10: transitions from Init to Init via Reject", async () => {
    const promises = new Promises();
    await expect(promises.reject({ id: "id10", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 11: transitions from Init to Init via Reject", async () => {
    const promises = new Promises();
    await expect(promises.reject({ id: "id11", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 12: transitions from Init to Init via Cancel", async () => {
    const promises = new Promises();
    await expect(promises.cancel({ id: "id12", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 13: transitions from Init to Init via Cancel", async () => {
    const promises = new Promises();
    await expect(promises.cancel({ id: "id13", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 14: transitions from Init to Init via Cancel", async () => {
    const promises = new Promises();
    await expect(promises.cancel({ id: "id14", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 15: transitions from Init to Init via Cancel", async () => {
    const promises = new Promises();
    await expect(promises.cancel({ id: "id15", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 16: transitions from Pending to Pending via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id16", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id16", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 17: transitions from Pending to Pending via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id17", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id17", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 18: transitions from Pending to Pending via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id18", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id18", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 19: transitions from Pending to Pending via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id19", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id19", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 20: transitions from Pending to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id20", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });

    const promise = await promises.resolve({ id: "id20", iKey: undefined, strict: true });

    expect(promise.state).toBe("resolved");
    expect(promise.id).toBe("id20");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 21: transitions from Pending to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id21", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });

    const promise = await promises.resolve({ id: "id21", iKey: undefined, strict: false });

    expect(promise.state).toBe("resolved");
    expect(promise.id).toBe("id21");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 22: transitions from Pending to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id22", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });

    const promise = await promises.resolve({ id: "id22", iKey: "iku", strict: true });

    expect(promise.state).toBe("resolved");
    expect(promise.id).toBe("id22");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 23: transitions from Pending to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id23", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });

    const promise = await promises.resolve({ id: "id23", iKey: "iku", strict: false });

    expect(promise.state).toBe("resolved");
    expect(promise.id).toBe("id23");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 24: transitions from Pending to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id24", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });

    const promise = await promises.reject({ id: "id24", iKey: undefined, strict: true });

    expect(promise.state).toBe("rejected");
    expect(promise.id).toBe("id24");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 25: transitions from Pending to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id25", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });

    const promise = await promises.reject({ id: "id25", iKey: undefined, strict: false });

    expect(promise.state).toBe("rejected");
    expect(promise.id).toBe("id25");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 26: transitions from Pending to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id26", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });

    const promise = await promises.reject({ id: "id26", iKey: "iku", strict: true });

    expect(promise.state).toBe("rejected");
    expect(promise.id).toBe("id26");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 27: transitions from Pending to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id27", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });

    const promise = await promises.reject({ id: "id27", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected");
    expect(promise.id).toBe("id27");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 28: transitions from Pending to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id28", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });

    const promise = await promises.cancel({ id: "id28", iKey: undefined, strict: true });

    expect(promise.state).toBe("rejected_canceled");
    expect(promise.id).toBe("id28");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 29: transitions from Pending to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id29", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });

    const promise = await promises.cancel({ id: "id29", iKey: undefined, strict: false });

    expect(promise.state).toBe("rejected_canceled");
    expect(promise.id).toBe("id29");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 30: transitions from Pending to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id30", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });

    const promise = await promises.cancel({ id: "id30", iKey: "iku", strict: true });

    expect(promise.state).toBe("rejected_canceled");
    expect(promise.id).toBe("id30");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 31: transitions from Pending to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id31", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });

    const promise = await promises.cancel({ id: "id31", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected_canceled");
    expect(promise.id).toBe("id31");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 32: transitions from Pending to Pending via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id32", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    await expect(
      promises.create({ id: "id32", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 33: transitions from Pending to Pending via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id33", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    await expect(
      promises.create({ id: "id33", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 34: transitions from Pending to Pending via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id34", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    const promise = await promises.create({ id: "id34", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: true });

    expect(promise.state).toBe("pending");
    expect(promise.id).toBe("id34");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 35: transitions from Pending to Pending via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id35", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    const promise = await promises.create({ id: "id35", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    expect(promise.state).toBe("pending");
    expect(promise.id).toBe("id35");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 36: transitions from Pending to Pending via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id36", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    await expect(
      promises.create({ id: "id36", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc*", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 37: transitions from Pending to Pending via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id37", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    await expect(
      promises.create({ id: "id37", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc*", strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 38: transitions from Pending to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id38", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    const promise = await promises.resolve({ id: "id38", iKey: undefined, strict: true });

    expect(promise.state).toBe("resolved");
    expect(promise.id).toBe("id38");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 39: transitions from Pending to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id39", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    const promise = await promises.resolve({ id: "id39", iKey: undefined, strict: false });

    expect(promise.state).toBe("resolved");
    expect(promise.id).toBe("id39");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 40: transitions from Pending to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id40", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    const promise = await promises.resolve({ id: "id40", iKey: "iku", strict: true });

    expect(promise.state).toBe("resolved");
    expect(promise.id).toBe("id40");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 41: transitions from Pending to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id41", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    const promise = await promises.resolve({ id: "id41", iKey: "iku", strict: false });

    expect(promise.state).toBe("resolved");
    expect(promise.id).toBe("id41");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 42: transitions from Pending to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id42", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    const promise = await promises.reject({ id: "id42", iKey: undefined, strict: true });

    expect(promise.state).toBe("rejected");
    expect(promise.id).toBe("id42");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 43: transitions from Pending to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id43", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    const promise = await promises.reject({ id: "id43", iKey: undefined, strict: false });

    expect(promise.state).toBe("rejected");
    expect(promise.id).toBe("id43");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 44: transitions from Pending to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id44", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    const promise = await promises.reject({ id: "id44", iKey: "iku", strict: true });

    expect(promise.state).toBe("rejected");
    expect(promise.id).toBe("id44");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 45: transitions from Pending to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id45", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    const promise = await promises.reject({ id: "id45", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected");
    expect(promise.id).toBe("id45");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 46: transitions from Pending to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id46", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    const promise = await promises.cancel({ id: "id46", iKey: undefined, strict: true });

    expect(promise.state).toBe("rejected_canceled");
    expect(promise.id).toBe("id46");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 47: transitions from Pending to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id47", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    const promise = await promises.cancel({ id: "id47", iKey: undefined, strict: false });

    expect(promise.state).toBe("rejected_canceled");
    expect(promise.id).toBe("id47");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 48: transitions from Pending to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id48", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    const promise = await promises.cancel({ id: "id48", iKey: "iku", strict: true });

    expect(promise.state).toBe("rejected_canceled");
    expect(promise.id).toBe("id48");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 49: transitions from Pending to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id49", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    const promise = await promises.cancel({ id: "id49", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected_canceled");
    expect(promise.id).toBe("id49");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 50: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id50", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id50", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id50", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 51: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id51", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id51", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id51", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 52: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id52", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id52", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id52", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 53: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id53", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id53", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id53", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 54: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id54", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id54", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id54", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 55: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id55", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id55", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id55", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 56: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id56", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id56", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id56", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 57: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id57", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id57", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id57", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 58: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id58", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id58", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id58", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 59: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id59", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id59", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id59", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 60: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id60", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id60", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id60", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 61: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id61", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id61", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id61", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 62: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id62", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id62", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id62", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 63: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id63", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id63", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id63", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 64: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id64", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id64", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id64", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 65: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id65", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id65", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id65", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 66: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id66", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id66", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id66", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 67: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id67", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id67", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id67", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 68: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id68", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id68", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id68", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 69: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id69", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id69", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id69", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 70: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id70", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id70", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id70", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 71: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id71", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id71", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id71", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 72: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id72", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id72", iKey: "iku", strict: false });

    const promise = await promises.resolve({ id: "id72", iKey: "iku", strict: true });

    expect(promise.state).toBe("resolved");
    expect(promise.id).toBe("id72");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 73: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id73", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id73", iKey: "iku", strict: false });

    const promise = await promises.resolve({ id: "id73", iKey: "iku", strict: false });

    expect(promise.state).toBe("resolved");
    expect(promise.id).toBe("id73");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 74: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id74", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id74", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id74", iKey: "iku*", strict: true })).rejects.toThrow();
  });

  test("Test Case 75: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id75", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id75", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id75", iKey: "iku*", strict: false })).rejects.toThrow();
  });

  test("Test Case 76: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id76", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id76", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id76", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 77: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id77", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id77", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id77", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 78: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id78", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id78", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id78", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 79: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id79", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id79", iKey: "iku", strict: false });

    const promise = await promises.reject({ id: "id79", iKey: "iku", strict: false });

    expect(promise.state).toBe("resolved");
    expect(promise.id).toBe("id79");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 80: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id80", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id80", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id80", iKey: "iku*", strict: true })).rejects.toThrow();
  });

  test("Test Case 81: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id81", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id81", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id81", iKey: "iku*", strict: false })).rejects.toThrow();
  });

  test("Test Case 82: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id82", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id82", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id82", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 83: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id83", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id83", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id83", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 84: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id84", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id84", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id84", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 85: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id85", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id85", iKey: "iku", strict: false });

    const promise = await promises.cancel({ id: "id85", iKey: "iku", strict: false });

    expect(promise.state).toBe("resolved");
    expect(promise.id).toBe("id85");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 86: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id86", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id86", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id86", iKey: "iku*", strict: true })).rejects.toThrow();
  });

  test("Test Case 87: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id87", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.resolve({ id: "id87", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id87", iKey: "iku*", strict: false })).rejects.toThrow();
  });

  test("Test Case 88: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id88", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id88", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id88", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 89: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id89", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id89", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id89", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 90: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id90", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id90", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id90", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 91: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id91", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id91", iKey: undefined, strict: false });

    const promise = await promises.create({ id: "id91", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });

    expect(promise.state).toBe("resolved");
    expect(promise.id).toBe("id91");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 92: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id92", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id92", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id92", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc*", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 93: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id93", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id93", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id93", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc*", strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 94: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id94", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id94", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id94", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 95: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id95", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id95", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id95", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 96: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id96", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id96", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id96", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 97: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id97", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id97", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id97", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 98: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id98", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id98", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id98", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 99: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id99", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id99", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id99", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 100: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id100", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id100", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id100", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 101: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id101", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id101", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id101", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 102: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id102", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id102", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id102", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 103: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id103", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id103", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id103", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 104: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id104", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id104", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id104", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 105: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id105", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id105", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id105", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 106: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id106", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id106", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id106", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 107: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id107", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id107", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id107", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 108: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id108", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id108", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id108", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 109: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id109", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id109", iKey: "iku", strict: false });

    const promise = await promises.create({
      id: "id109",
      timeout: Number.MAX_SAFE_INTEGER,
      iKey: "ikc",
      strict: false,
    });

    expect(promise.state).toBe("resolved");
    expect(promise.id).toBe("id109");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 110: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id110", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id110", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id110", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc*", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 111: transitions from Resolved to Resolved via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id111", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id111", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id111", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc*", strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 112: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id112", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id112", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id112", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 113: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id113", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id113", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id113", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 114: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id114", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id114", iKey: "iku", strict: false });

    const promise = await promises.resolve({ id: "id114", iKey: "iku", strict: true });

    expect(promise.state).toBe("resolved");
    expect(promise.id).toBe("id114");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 115: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id115", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id115", iKey: "iku", strict: false });

    const promise = await promises.resolve({ id: "id115", iKey: "iku", strict: false });

    expect(promise.state).toBe("resolved");
    expect(promise.id).toBe("id115");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 116: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id116", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id116", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id116", iKey: "iku*", strict: true })).rejects.toThrow();
  });

  test("Test Case 117: transitions from Resolved to Resolved via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id117", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id117", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id117", iKey: "iku*", strict: false })).rejects.toThrow();
  });

  test("Test Case 118: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id118", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id118", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id118", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 119: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id119", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id119", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id119", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 120: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id120", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id120", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id120", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 121: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id121", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id121", iKey: "iku", strict: false });

    const promise = await promises.reject({ id: "id121", iKey: "iku", strict: false });

    expect(promise.state).toBe("resolved");
    expect(promise.id).toBe("id121");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 122: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id122", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id122", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id122", iKey: "iku*", strict: true })).rejects.toThrow();
  });

  test("Test Case 123: transitions from Resolved to Resolved via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id123", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id123", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id123", iKey: "iku*", strict: false })).rejects.toThrow();
  });

  test("Test Case 124: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id124", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id124", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id124", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 125: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id125", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id125", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id125", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 126: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id126", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id126", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id126", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 127: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id127", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id127", iKey: "iku", strict: false });

    const promise = await promises.cancel({ id: "id127", iKey: "iku", strict: false });

    expect(promise.state).toBe("resolved");
    expect(promise.id).toBe("id127");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 128: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id128", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id128", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id128", iKey: "iku*", strict: true })).rejects.toThrow();
  });

  test("Test Case 129: transitions from Resolved to Resolved via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id129", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.resolve({ id: "id129", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id129", iKey: "iku*", strict: false })).rejects.toThrow();
  });

  test("Test Case 130: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id130", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id130", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id130", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 131: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id131", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id131", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id131", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 132: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id132", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id132", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id132", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 133: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id133", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id133", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id133", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 134: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id134", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id134", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id134", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 135: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id135", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id135", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id135", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 136: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id136", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id136", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id136", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 137: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id137", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id137", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id137", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 138: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id138", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id138", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id138", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 139: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id139", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id139", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id139", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 140: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id140", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id140", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id140", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 141: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id141", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id141", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id141", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 142: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id142", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id142", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id142", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 143: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id143", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id143", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id143", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 144: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id144", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id144", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id144", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 145: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id145", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id145", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id145", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 146: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id146", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id146", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id146", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 147: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id147", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id147", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id147", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 148: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id148", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id148", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id148", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 149: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id149", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id149", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id149", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 150: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id150", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id150", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id150", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 151: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id151", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id151", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id151", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 152: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id152", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id152", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id152", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 153: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id153", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id153", iKey: "iku", strict: false });

    const promise = await promises.resolve({ id: "id153", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected");
    expect(promise.id).toBe("id153");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 154: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id154", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id154", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id154", iKey: "iku*", strict: true })).rejects.toThrow();
  });

  test("Test Case 155: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id155", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id155", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id155", iKey: "iku*", strict: false })).rejects.toThrow();
  });

  test("Test Case 156: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id156", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id156", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id156", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 157: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id157", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id157", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id157", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 158: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id158", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id158", iKey: "iku", strict: false });

    const promise = await promises.reject({ id: "id158", iKey: "iku", strict: true });

    expect(promise.state).toBe("rejected");
    expect(promise.id).toBe("id158");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 159: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id159", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id159", iKey: "iku", strict: false });

    const promise = await promises.reject({ id: "id159", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected");
    expect(promise.id).toBe("id159");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 160: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id160", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id160", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id160", iKey: "iku*", strict: true })).rejects.toThrow();
  });

  test("Test Case 161: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id161", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id161", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id161", iKey: "iku*", strict: false })).rejects.toThrow();
  });

  test("Test Case 162: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id162", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id162", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id162", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 163: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id163", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id163", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id163", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 164: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id164", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id164", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id164", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 165: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id165", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id165", iKey: "iku", strict: false });

    const promise = await promises.cancel({ id: "id165", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected");
    expect(promise.id).toBe("id165");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 166: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id166", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id166", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id166", iKey: "iku*", strict: true })).rejects.toThrow();
  });

  test("Test Case 167: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id167", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.reject({ id: "id167", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id167", iKey: "iku*", strict: false })).rejects.toThrow();
  });

  test("Test Case 168: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id168", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id168", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id168", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 169: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id169", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id169", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id169", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 170: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id170", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id170", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id170", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 171: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id171", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id171", iKey: undefined, strict: false });

    const promise = await promises.create({
      id: "id171",
      timeout: Number.MAX_SAFE_INTEGER,
      iKey: "ikc",
      strict: false,
    });

    expect(promise.state).toBe("rejected");
    expect(promise.id).toBe("id171");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 172: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id172", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id172", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id172", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc*", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 173: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id173", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id173", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id173", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc*", strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 174: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id174", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id174", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id174", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 175: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id175", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id175", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id175", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 176: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id176", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id176", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id176", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 177: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id177", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id177", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id177", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 178: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id178", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id178", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id178", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 179: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id179", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id179", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id179", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 180: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id180", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id180", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id180", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 181: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id181", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id181", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id181", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 182: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id182", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id182", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id182", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 183: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id183", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id183", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id183", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 184: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id184", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id184", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id184", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 185: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id185", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id185", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id185", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 186: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id186", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id186", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id186", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 187: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id187", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id187", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id187", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 188: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id188", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id188", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id188", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 189: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id189", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id189", iKey: "iku", strict: false });

    const promise = await promises.create({
      id: "id189",
      timeout: Number.MAX_SAFE_INTEGER,
      iKey: "ikc",
      strict: false,
    });

    expect(promise.state).toBe("rejected");
    expect(promise.id).toBe("id189");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 190: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id190", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id190", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id190", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc*", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 191: transitions from Rejected to Rejected via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id191", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id191", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id191", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc*", strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 192: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id192", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id192", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id192", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 193: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id193", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id193", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id193", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 194: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id194", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id194", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id194", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 195: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id195", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id195", iKey: "iku", strict: false });

    const promise = await promises.resolve({ id: "id195", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected");
    expect(promise.id).toBe("id195");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 196: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id196", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id196", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id196", iKey: "iku*", strict: true })).rejects.toThrow();
  });

  test("Test Case 197: transitions from Rejected to Rejected via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id197", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id197", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id197", iKey: "iku*", strict: false })).rejects.toThrow();
  });

  test("Test Case 198: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id198", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id198", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id198", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 199: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id199", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id199", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id199", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 200: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id200", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id200", iKey: "iku", strict: false });

    const promise = await promises.reject({ id: "id200", iKey: "iku", strict: true });

    expect(promise.state).toBe("rejected");
    expect(promise.id).toBe("id200");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 201: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id201", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id201", iKey: "iku", strict: false });

    const promise = await promises.reject({ id: "id201", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected");
    expect(promise.id).toBe("id201");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 202: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id202", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id202", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id202", iKey: "iku*", strict: true })).rejects.toThrow();
  });

  test("Test Case 203: transitions from Rejected to Rejected via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id203", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id203", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id203", iKey: "iku*", strict: false })).rejects.toThrow();
  });

  test("Test Case 204: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id204", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id204", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id204", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 205: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id205", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id205", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id205", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 206: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id206", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id206", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id206", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 207: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id207", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id207", iKey: "iku", strict: false });

    const promise = await promises.cancel({ id: "id207", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected");
    expect(promise.id).toBe("id207");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 208: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id208", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id208", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id208", iKey: "iku*", strict: true })).rejects.toThrow();
  });

  test("Test Case 209: transitions from Rejected to Rejected via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id209", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.reject({ id: "id209", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id209", iKey: "iku*", strict: false })).rejects.toThrow();
  });

  test("Test Case 210: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id210", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id210", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id210", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 211: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id211", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id211", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id211", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 212: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id212", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id212", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id212", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 213: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id213", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id213", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id213", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 214: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id214", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id214", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id214", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 215: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id215", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id215", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id215", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 216: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id216", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id216", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id216", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 217: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id217", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id217", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id217", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 218: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id218", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id218", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id218", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 219: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id219", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id219", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id219", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 220: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id220", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id220", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id220", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 221: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id221", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id221", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id221", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 222: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id222", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id222", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id222", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 223: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id223", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id223", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id223", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 224: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id224", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id224", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id224", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 225: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id225", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id225", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id225", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 226: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id226", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id226", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id226", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 227: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id227", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id227", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id227", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 228: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id228", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id228", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id228", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 229: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id229", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id229", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id229", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 230: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id230", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id230", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id230", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 231: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id231", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id231", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id231", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 232: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id232", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id232", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id232", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 233: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id233", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id233", iKey: "iku", strict: false });

    const promise = await promises.resolve({ id: "id233", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected_canceled");
    expect(promise.id).toBe("id233");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 234: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id234", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id234", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id234", iKey: "iku*", strict: true })).rejects.toThrow();
  });

  test("Test Case 235: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id235", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id235", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id235", iKey: "iku*", strict: false })).rejects.toThrow();
  });

  test("Test Case 236: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id236", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id236", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id236", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 237: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id237", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id237", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id237", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 238: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id238", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id238", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id238", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 239: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id239", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id239", iKey: "iku", strict: false });

    const promise = await promises.reject({ id: "id239", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected_canceled");
    expect(promise.id).toBe("id239");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 240: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id240", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id240", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id240", iKey: "iku*", strict: true })).rejects.toThrow();
  });

  test("Test Case 241: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id241", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id241", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id241", iKey: "iku*", strict: false })).rejects.toThrow();
  });

  test("Test Case 242: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id242", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id242", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id242", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 243: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id243", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id243", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id243", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 244: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id244", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id244", iKey: "iku", strict: false });

    const promise = await promises.cancel({ id: "id244", iKey: "iku", strict: true });

    expect(promise.state).toBe("rejected_canceled");
    expect(promise.id).toBe("id244");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 245: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id245", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id245", iKey: "iku", strict: false });

    const promise = await promises.cancel({ id: "id245", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected_canceled");
    expect(promise.id).toBe("id245");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 246: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id246", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id246", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id246", iKey: "iku*", strict: true })).rejects.toThrow();
  });

  test("Test Case 247: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id247", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false });
    await promises.cancel({ id: "id247", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id247", iKey: "iku*", strict: false })).rejects.toThrow();
  });

  test("Test Case 248: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id248", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id248", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id248", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 249: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id249", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id249", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id249", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 250: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id250", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id250", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id250", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 251: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id251", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id251", iKey: undefined, strict: false });

    const promise = await promises.create({
      id: "id251",
      timeout: Number.MAX_SAFE_INTEGER,
      iKey: "ikc",
      strict: false,
    });

    expect(promise.state).toBe("rejected_canceled");
    expect(promise.id).toBe("id251");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 252: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id252", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id252", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id252", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc*", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 253: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id253", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id253", iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id253", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc*", strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 254: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id254", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id254", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id254", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 255: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id255", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id255", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id255", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 256: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id256", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id256", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id256", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 257: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id257", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id257", iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id257", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 258: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id258", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id258", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id258", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 259: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id259", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id259", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id259", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 260: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id260", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id260", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id260", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 261: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id261", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id261", iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id261", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 262: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id262", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id262", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id262", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 263: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id263", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id263", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id263", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 264: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id264", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id264", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id264", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 265: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id265", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id265", iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id265", iKey: "iku", strict: false })).rejects.toThrow();
  });

  test("Test Case 266: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id266", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id266", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id266", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 267: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id267", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id267", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id267", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 268: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id268", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id268", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id268", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 269: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id269", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id269", iKey: "iku", strict: false });

    const promise = await promises.create({
      id: "id269",
      timeout: Number.MAX_SAFE_INTEGER,
      iKey: "ikc",
      strict: false,
    });

    expect(promise.state).toBe("rejected_canceled");
    expect(promise.id).toBe("id269");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 270: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id270", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id270", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id270", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc*", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 271: transitions from Canceled to Canceled via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id271", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id271", iKey: "iku", strict: false });

    await expect(
      promises.create({ id: "id271", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc*", strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 272: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id272", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id272", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id272", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 273: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id273", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id273", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id273", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 274: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id274", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id274", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id274", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 275: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id275", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id275", iKey: "iku", strict: false });

    const promise = await promises.resolve({ id: "id275", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected_canceled");
    expect(promise.id).toBe("id275");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 276: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id276", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id276", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id276", iKey: "iku*", strict: true })).rejects.toThrow();
  });

  test("Test Case 277: transitions from Canceled to Canceled via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id277", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id277", iKey: "iku", strict: false });

    await expect(promises.resolve({ id: "id277", iKey: "iku*", strict: false })).rejects.toThrow();
  });

  test("Test Case 278: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id278", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id278", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id278", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 279: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id279", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id279", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id279", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 280: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id280", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id280", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id280", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 281: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id281", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id281", iKey: "iku", strict: false });

    const promise = await promises.reject({ id: "id281", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected_canceled");
    expect(promise.id).toBe("id281");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 282: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id282", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id282", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id282", iKey: "iku*", strict: true })).rejects.toThrow();
  });

  test("Test Case 283: transitions from Canceled to Canceled via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id283", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id283", iKey: "iku", strict: false });

    await expect(promises.reject({ id: "id283", iKey: "iku*", strict: false })).rejects.toThrow();
  });

  test("Test Case 284: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id284", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id284", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id284", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 285: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id285", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id285", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id285", iKey: undefined, strict: false })).rejects.toThrow();
  });

  test("Test Case 286: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id286", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id286", iKey: "iku", strict: false });

    const promise = await promises.cancel({ id: "id286", iKey: "iku", strict: true });

    expect(promise.state).toBe("rejected_canceled");
    expect(promise.id).toBe("id286");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 287: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id287", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id287", iKey: "iku", strict: false });

    const promise = await promises.cancel({ id: "id287", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected_canceled");
    expect(promise.id).toBe("id287");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe("iku");
  });

  test("Test Case 288: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id288", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id288", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id288", iKey: "iku*", strict: true })).rejects.toThrow();
  });

  test("Test Case 289: transitions from Canceled to Canceled via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id289", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false });
    await promises.cancel({ id: "id289", iKey: "iku", strict: false });

    await expect(promises.cancel({ id: "id289", iKey: "iku*", strict: false })).rejects.toThrow();
  });

  test("Test Case 290: transitions from Timedout to Timedout via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id290", timeout: 0, iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id290", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 291: transitions from Timedout to Timedout via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id291", timeout: 0, iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id291", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 292: transitions from Timedout to Timedout via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id292", timeout: 0, iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id292", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 293: transitions from Timedout to Timedout via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id293", timeout: 0, iKey: undefined, strict: false });

    await expect(
      promises.create({ id: "id293", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 294: transitions from Timedout to Timedout via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id294", timeout: 0, iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id294", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 295: transitions from Timedout to Timedout via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id295", timeout: 0, iKey: undefined, strict: false });

    const promise = await promises.resolve({ id: "id295", iKey: undefined, strict: false });

    expect(promise.state).toBe("rejected_timedout");
    expect(promise.id).toBe("id295");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 296: transitions from Timedout to Timedout via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id296", timeout: 0, iKey: undefined, strict: false });

    await expect(promises.resolve({ id: "id296", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 297: transitions from Timedout to Timedout via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id297", timeout: 0, iKey: undefined, strict: false });

    const promise = await promises.resolve({ id: "id297", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected_timedout");
    expect(promise.id).toBe("id297");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 298: transitions from Timedout to Timedout via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id298", timeout: 0, iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id298", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 299: transitions from Timedout to Timedout via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id299", timeout: 0, iKey: undefined, strict: false });

    const promise = await promises.reject({ id: "id299", iKey: undefined, strict: false });

    expect(promise.state).toBe("rejected_timedout");
    expect(promise.id).toBe("id299");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 300: transitions from Timedout to Timedout via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id300", timeout: 0, iKey: undefined, strict: false });

    await expect(promises.reject({ id: "id300", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 301: transitions from Timedout to Timedout via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id301", timeout: 0, iKey: undefined, strict: false });

    const promise = await promises.reject({ id: "id301", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected_timedout");
    expect(promise.id).toBe("id301");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 302: transitions from Timedout to Timedout via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id302", timeout: 0, iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id302", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 303: transitions from Timedout to Timedout via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id303", timeout: 0, iKey: undefined, strict: false });

    const promise = await promises.cancel({ id: "id303", iKey: undefined, strict: false });

    expect(promise.state).toBe("rejected_timedout");
    expect(promise.id).toBe("id303");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 304: transitions from Timedout to Timedout via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id304", timeout: 0, iKey: undefined, strict: false });

    await expect(promises.cancel({ id: "id304", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 305: transitions from Timedout to Timedout via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id305", timeout: 0, iKey: undefined, strict: false });

    const promise = await promises.cancel({ id: "id305", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected_timedout");
    expect(promise.id).toBe("id305");
    expect(promise.iKeyForCreate).toBe(undefined);
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 306: transitions from Timedout to Timedout via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id306", timeout: 0, iKey: "ikc", strict: false });

    await expect(
      promises.create({ id: "id306", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 307: transitions from Timedout to Timedout via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id307", timeout: 0, iKey: "ikc", strict: false });

    await expect(
      promises.create({ id: "id307", timeout: Number.MAX_SAFE_INTEGER, iKey: undefined, strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 308: transitions from Timedout to Timedout via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id308", timeout: 0, iKey: "ikc", strict: false });

    await expect(
      promises.create({ id: "id308", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 309: transitions from Timedout to Timedout via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id309", timeout: 0, iKey: "ikc", strict: false });

    const promise = await promises.create({
      id: "id309",
      timeout: Number.MAX_SAFE_INTEGER,
      iKey: "ikc",
      strict: false,
    });

    expect(promise.state).toBe("rejected_timedout");
    expect(promise.id).toBe("id309");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 310: transitions from Timedout to Timedout via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id310", timeout: 0, iKey: "ikc", strict: false });

    await expect(
      promises.create({ id: "id310", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc*", strict: true }),
    ).rejects.toThrow();
  });

  test("Test Case 311: transitions from Timedout to Timedout via Create", async () => {
    const promises = new Promises();
    await promises.create({ id: "id311", timeout: 0, iKey: "ikc", strict: false });

    await expect(
      promises.create({ id: "id311", timeout: Number.MAX_SAFE_INTEGER, iKey: "ikc*", strict: false }),
    ).rejects.toThrow();
  });

  test("Test Case 312: transitions from Timedout to Timedout via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id312", timeout: 0, iKey: "ikc", strict: false });

    await expect(promises.resolve({ id: "id312", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 313: transitions from Timedout to Timedout via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id313", timeout: 0, iKey: "ikc", strict: false });

    const promise = await promises.resolve({ id: "id313", iKey: undefined, strict: false });

    expect(promise.state).toBe("rejected_timedout");
    expect(promise.id).toBe("id313");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 314: transitions from Timedout to Timedout via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id314", timeout: 0, iKey: "ikc", strict: false });

    await expect(promises.resolve({ id: "id314", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 315: transitions from Timedout to Timedout via Resolve", async () => {
    const promises = new Promises();
    await promises.create({ id: "id315", timeout: 0, iKey: "ikc", strict: false });

    const promise = await promises.resolve({ id: "id315", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected_timedout");
    expect(promise.id).toBe("id315");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 316: transitions from Timedout to Timedout via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id316", timeout: 0, iKey: "ikc", strict: false });

    await expect(promises.reject({ id: "id316", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 317: transitions from Timedout to Timedout via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id317", timeout: 0, iKey: "ikc", strict: false });

    const promise = await promises.reject({ id: "id317", iKey: undefined, strict: false });

    expect(promise.state).toBe("rejected_timedout");
    expect(promise.id).toBe("id317");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 318: transitions from Timedout to Timedout via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id318", timeout: 0, iKey: "ikc", strict: false });

    await expect(promises.reject({ id: "id318", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 319: transitions from Timedout to Timedout via Reject", async () => {
    const promises = new Promises();
    await promises.create({ id: "id319", timeout: 0, iKey: "ikc", strict: false });

    const promise = await promises.reject({ id: "id319", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected_timedout");
    expect(promise.id).toBe("id319");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 320: transitions from Timedout to Timedout via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id320", timeout: 0, iKey: "ikc", strict: false });

    await expect(promises.cancel({ id: "id320", iKey: undefined, strict: true })).rejects.toThrow();
  });

  test("Test Case 321: transitions from Timedout to Timedout via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id321", timeout: 0, iKey: "ikc", strict: false });

    const promise = await promises.cancel({ id: "id321", iKey: undefined, strict: false });

    expect(promise.state).toBe("rejected_timedout");
    expect(promise.id).toBe("id321");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });

  test("Test Case 322: transitions from Timedout to Timedout via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id322", timeout: 0, iKey: "ikc", strict: false });

    await expect(promises.cancel({ id: "id322", iKey: "iku", strict: true })).rejects.toThrow();
  });

  test("Test Case 323: transitions from Timedout to Timedout via Cancel", async () => {
    const promises = new Promises();
    await promises.create({ id: "id323", timeout: 0, iKey: "ikc", strict: false });

    const promise = await promises.cancel({ id: "id323", iKey: "iku", strict: false });

    expect(promise.state).toBe("rejected_timedout");
    expect(promise.id).toBe("id323");
    expect(promise.iKeyForCreate).toBe("ikc");
    expect(promise.iKeyForComplete).toBe(undefined);
  });
});
