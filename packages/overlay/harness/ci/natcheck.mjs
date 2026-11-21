#!/usr/bin/env node
// PLAN H5: what kind of NAT this runner is behind, before its peers try to link to anyone. One
// UDP socket asks two STUN servers what address they see it at (RFC 5389 binding requests). The
// same mapped port from both: an endpoint-independent mapping, which hole punching gets through.
// Two different ports: a symmetric NAT, which it does not, and every link to another machine
// needs TURN. Writes {mapped, symmetric} as JSON to $1, and never fails the job.
//
// Owner: E-harness.
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { writeFileSync } from "node:fs";

const SERVERS = [
  ["stun.l.google.com", 19302],
  ["stun.cloudflare.com", 3478],
];
const MAGIC = 0x2112a442;

function request() {
  const id = randomBytes(12);
  const packet = Buffer.alloc(20);
  packet.writeUInt16BE(0x0001, 0); // Binding request
  packet.writeUInt16BE(0, 2);
  packet.writeUInt32BE(MAGIC, 4);
  id.copy(packet, 8);
  return { id, packet };
}

/** XOR-MAPPED-ADDRESS (or MAPPED-ADDRESS) from a binding response, IPv4 only. */
function mapped(message) {
  for (let at = 20; at + 4 <= message.length; ) {
    const type = message.readUInt16BE(at);
    const length = message.readUInt16BE(at + 2);
    const value = message.subarray(at + 4, at + 4 + length);
    if ((type === 0x0020 || type === 0x0001) && value[1] === 0x01) {
      const xor = type === 0x0020;
      const port = value.readUInt16BE(2) ^ (xor ? MAGIC >>> 16 : 0);
      const ip = [0, 1, 2, 3].map((i) => value[4 + i] ^ (xor ? (MAGIC >>> (24 - 8 * i)) & 0xff : 0)).join(".");
      return { ip, port };
    }
    at += 4 + length + ((4 - (length % 4)) % 4);
  }
  return null;
}

async function main() {
  const out = process.argv[2] ?? "nat.json";
  const socket = createSocket("udp4");
  await new Promise((resolve) => socket.bind(0, resolve));
  const answers = [];
  const pending = new Map();
  socket.on("message", (message) => {
    const key = message.subarray(8, 20).toString("hex");
    const resolve = pending.get(key);
    if (resolve) resolve(mapped(message));
  });
  for (const [host, port] of SERVERS) {
    let answer = null;
    try {
      const { address } = await lookup(host, { family: 4 });
      for (let attempt = 0; attempt < 3 && !answer; attempt++) {
        const { id, packet } = request();
        answer = await new Promise((resolve) => {
          pending.set(id.toString("hex"), resolve);
          socket.send(packet, port, address);
          setTimeout(() => resolve(null), 1500);
        });
      }
    } catch {
      // No answer is an answer: recorded as null.
    }
    answers.push({ server: `${host}:${port}`, mapped: answer });
  }
  socket.close();
  const ports = answers.filter((a) => a.mapped).map((a) => a.mapped.port);
  const result = { mapped: answers, symmetric: ports.length === 2 ? ports[0] !== ports[1] : null };
  writeFileSync(out, JSON.stringify(result));
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.log(`natcheck: ${error}`);
});
