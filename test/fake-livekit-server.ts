/**
 * A stand-in for the LiveKit server's RoomService, reached the way livekit-server-sdk reaches it:
 * Twirp over `fetch`, JSON bodies. Only the methods Meetly's server calls are here, and only the
 * fields it reads. It imitates the wire format; it is not LiveKit, and nothing here proves how a
 * real server behaves (the browser tests do that against `livekit-server --dev`).
 */

export type FakePermission = {
  canSubscribe?: boolean;
  canPublish?: boolean;
  canPublishData?: boolean;
  canUpdateMetadata?: boolean;
  hidden?: boolean;
};
export type FakeLiveKitParticipant = { identity: string; name: string; permission: FakePermission; attributes: Record<string, string> };
type FakeRoom = { name: string; metadata: string; participants: Map<string, FakeLiveKitParticipant> };

export class FakeLiveKitServer {
  readonly rooms = new Map<string, FakeRoom>();
  readonly calls: { method: string; body: Record<string, unknown> }[] = [];
  /** What our server sent into rooms (RoomService.sendData), as text. */
  readonly sent: { room: string; text: string }[] = [];
  private realFetch: typeof fetch | null = null;

  /** Someone connected to `room` with these permissions (as their token granted). */
  join(room: string, identity: string, permission: FakePermission, name = identity): FakeLiveKitParticipant {
    const person = { identity, name, permission, attributes: {} };
    this.rooms.get(room)!.participants.set(identity, person);
    return person;
  }

  meta(room: string): Record<string, unknown> {
    return JSON.parse(this.rooms.get(room)?.metadata || "{}");
  }

  install(): this {
    this.realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = url.pathname.split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      this.calls.push({ method, body });
      return this.answer(method, body);
    }) as typeof fetch;
    return this;
  }

  restore(): void {
    if (this.realFetch) globalThis.fetch = this.realFetch;
  }

  private answer(method: string, body: Record<string, unknown>): Response {
    const ok = (value: unknown) => Response.json(value);
    const notFound = () => Response.json({ code: "not_found", msg: "not found" }, { status: 404 });
    const room = this.rooms.get(String(body.room ?? ""));
    const info = (r: FakeRoom) => ({ name: r.name, metadata: r.metadata, numParticipants: r.participants.size });
    switch (method) {
      case "ListRooms": {
        const names = (body.names as string[] | undefined) ?? [];
        return ok({ rooms: [...this.rooms.values()].filter((r) => names.length === 0 || names.includes(r.name)).map(info) });
      }
      case "CreateRoom": {
        const made = { name: String(body.name), metadata: String(body.metadata ?? ""), participants: new Map() };
        this.rooms.set(made.name, made);
        return ok(info(made));
      }
      case "UpdateRoomMetadata":
        if (!room) return notFound();
        room.metadata = String(body.metadata ?? "");
        return ok(info(room));
      case "ListParticipants":
        return room ? ok({ participants: [...room.participants.values()] }) : notFound();
      case "GetParticipant": {
        const person = room?.participants.get(String(body.identity));
        return person ? ok(person) : notFound();
      }
      case "SendData": {
        // `data` is base64 in Twirp's JSON. Kept decoded, for the test to read.
        this.sent.push({ room: String(body.room), text: Buffer.from(String(body.data ?? ""), "base64").toString("utf8") });
        return ok({});
      }
      case "UpdateParticipant": {
        const person = room?.participants.get(String(body.identity));
        if (!person) return notFound();
        // Permissions are replaced whole; attributes are merged, and an empty value removes one.
        if (body.permission) person.permission = body.permission as FakePermission;
        for (const [key, value] of Object.entries((body.attributes as Record<string, string>) ?? {})) {
          if (value) person.attributes[key] = value;
          else delete person.attributes[key];
        }
        return ok(person);
      }
    }
    return Response.json({ code: "unimplemented", msg: method }, { status: 501 });
  }
}
