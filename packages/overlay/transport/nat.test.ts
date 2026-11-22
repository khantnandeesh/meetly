/** `classifyNat` and D48's early answer (SPEC §8.1). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyNat, earlyNat, type GatheredCandidate } from "@meetly/overlay/transport/nat";

const host = (address: string): GatheredCandidate => ({ type: "host", address, port: 50000 });
const srflx = (port: number): GatheredCandidate => ({ type: "srflx", address: "203.0.113.7", port, relatedAddress: "192.168.1.2", relatedPort: 50000 });

describe("NAT classification", () => {
  it("a public host address is open, at once", () => {
    assert.equal(earlyNat([host("198.51.100.4")], 2), "open");
    assert.equal(classifyNat([host("198.51.100.4")], 2), "open");
  });
  it("one socket mapped two ways is symmetric, at once", () => {
    assert.equal(earlyNat([host("192.168.1.2"), srflx(40001)], 2), null);
    assert.equal(earlyNat([host("192.168.1.2"), srflx(40001), srflx(40002)], 2), "symmetric");
  });
  it("one mapping is not decided early: cone only once the grace has run (D48)", () => {
    assert.equal(earlyNat([host("192.168.1.2"), srflx(40001)], 2), null);
    assert.equal(classifyNat([host("192.168.1.2"), srflx(40001)], 2), "cone");
  });
  it("nothing reflexive and private hosts only: not decided early, unknown at the end", () => {
    assert.equal(earlyNat([host("10.0.0.3")], 2), null);
    assert.equal(classifyNat([host("10.0.0.3")], 2), "unknown");
  });
});
