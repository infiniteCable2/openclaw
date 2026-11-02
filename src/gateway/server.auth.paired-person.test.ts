import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, test } from "vitest";
import {
  GATEWAY_OWNER_PROFILE_ID,
  type UsersCreateResult,
  type UsersSelfResult,
} from "../../packages/gateway-protocol/src/schema/users.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { getPairedDevice } from "../infra/device-pairing.js";
import type { OperatorScope } from "./operator-scopes.js";
import {
  BROWSER_ORIGIN,
  configureGatewayAuth,
  connectIdentity,
  responseAuth,
} from "./server.auth.identity-scopes.test-support.js";
import {
  installGatewayTestHooks,
  openWs,
  rpcReq,
  testState,
  waitForWsClose,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const PERSON_SCOPES: OperatorScope[] = ["operator.read", "operator.write", "operator.talk"];
const DEVICE_SCOPES = [...PERSON_SCOPES, "operator.admin"];

test("binds two signed operator devices to one person and retires an unlinked connection", async () => {
  await configureGatewayAuth(
    { mode: "token", token: "secret" },
    {
      roles: {
        default: "guest",
        definitions: {
          guest: { sessions: { others: "none" }, agents: [], scopes: ["operator.read"] },
          member: {
            sessions: { others: "none" },
            agents: ["assistant"],
            scopes: PERSON_SCOPES,
          },
        },
      },
    },
  );
  testState.agentsConfig = { ownership: "explicit", entries: { assistant: {}, other: {} } };
  const devices = ["desk", "kitchen"].map((label) => {
    const identityPath = path.join(tempDirs.make("openclaw-paired-person-"), `${label}.sqlite`);
    return {
      identityPath,
      identity: {
        channelId: "gateway",
        accountId: "paired-device",
        senderId: loadOrCreateDeviceIdentity({ path: identityPath }).deviceId,
      },
    };
  });
  expect(expectDefined(devices[0], "first device").identity.senderId).not.toBe(
    expectDefined(devices[1], "second device").identity.senderId,
  );

  await withGatewayServer(async ({ port }) => {
    const sockets: Awaited<ReturnType<typeof openWs>>[] = [];
    const open = async () => {
      const socket = await openWs(port, { origin: BROWSER_ORIGIN });
      sockets.push(socket);
      return socket;
    };
    const paired: Array<
      (typeof devices)[number] & {
        bootstrap: Awaited<ReturnType<typeof openWs>>;
        deviceToken: string;
      }
    > = [];
    try {
      for (const device of devices) {
        const bootstrap = await open();
        const result = await connectIdentity(bootstrap, {
          token: "secret",
          scopes: DEVICE_SCOPES,
          deviceIdentityPath: device.identityPath,
        });
        expect(result.ok, JSON.stringify(result.error)).toBe(true);
        expect(responseAuth(result)?.scopes).toEqual(DEVICE_SCOPES);
        const deviceToken = responseAuth(result)?.deviceToken;
        if (!deviceToken) {
          throw new Error("Expected the native pairing owner to issue a device token");
        }
        expect(await getPairedDevice(device.identity.senderId)).toMatchObject({
          deviceId: device.identity.senderId,
          roles: ["operator"],
        });
        expect((await rpcReq<UsersSelfResult>(bootstrap, "users.self")).payload?.profile.id).toBe(
          GATEWAY_OWNER_PROFILE_ID,
        );
        paired.push({ ...device, bootstrap, deviceToken });
      }
      const first = expectDefined(paired[0], "first paired device");
      const second = expectDefined(paired[1], "second paired device");
      expect(first.deviceToken).not.toBe(second.deviceToken);
      const admin = first.bootstrap;
      const created = await rpcReq<UsersCreateResult>(admin, "users.create", {
        displayName: "Ada",
      });
      expect(created).toMatchObject({
        ok: true,
        payload: { profile: { displayName: "Ada", emails: [], githubIdentity: null } },
      });
      const profileId = created.payload?.profile.id;
      if (!profileId) {
        throw new Error("Expected a native person profile");
      }
      expect(profileId).not.toBe(GATEWAY_OWNER_PROFILE_ID);
      expect((await rpcReq(admin, "users.setRole", { profileId, role: "member" })).ok).toBe(true);
      const reconnect = async (
        device: (typeof paired)[number],
        deviceToken = device.deviceToken,
      ) => {
        const socket = await open();
        const result = await connectIdentity(socket, {
          skipDefaultAuth: true,
          prePairDevice: false,
          deviceToken,
          scopes: DEVICE_SCOPES,
          deviceIdentityPath: device.identityPath,
        });
        return { socket, result };
      };
      expect((await reconnect(first)).result).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("verified user identity") },
      });
      for (const device of paired) {
        expect(
          await rpcReq(admin, "users.linkChannelIdentity", {
            profileId,
            identity: device.identity,
          }),
        ).toMatchObject({ ok: true, payload: { profileId, identity: device.identity } });
      }
      // A durable person link cannot authenticate a wrong signed device credential.
      expect((await reconnect(first, second.deviceToken)).result.ok).toBe(false);
      const people: Awaited<ReturnType<typeof reconnect>>[] = [];
      for (const device of paired) {
        const person = await reconnect(device);
        expect(person.result.ok, JSON.stringify(person.result.error)).toBe(true);
        expect(responseAuth(person.result)?.scopes).toEqual(PERSON_SCOPES);
        expect(await rpcReq<UsersSelfResult>(person.socket, "users.self")).toMatchObject({
          ok: true,
          payload: { profile: { id: profileId, emails: [], role: "member" } },
        });
        const agents = await rpcReq<{ agents: { id: string }[] }>(person.socket, "agents.list");
        expect(agents.ok, JSON.stringify(agents.error)).toBe(true);
        expect(agents.payload?.agents.map(({ id }) => id)).toEqual(["assistant"]);
        expect(
          await rpcReq(person.socket, "users.create", { displayName: "Forbidden" }),
        ).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining("operator.admin") },
        });
        people.push(person);
      }
      // Adding a link never changes the shared-secret bootstrap's system identity.
      expect((await rpcReq<UsersSelfResult>(admin, "users.self")).payload?.profile.id).toBe(
        GATEWAY_OWNER_PROFILE_ID,
      );
      const firstPerson = expectDefined(people[0], "first person connection");
      const secondPerson = expectDefined(people[1], "second person connection");
      const closed = waitForWsClose(firstPerson.socket, 1_000);
      expect(
        await rpcReq(admin, "users.unlinkChannelIdentity", { profileId, identity: first.identity }),
      ).toMatchObject({ ok: true, payload: { removed: true } });
      expect(await closed).toBe(true);
      expect((await reconnect(first)).result.ok).toBe(false);
      expect(
        (await rpcReq<UsersSelfResult>(secondPerson.socket, "users.self")).payload?.profile.id,
      ).toBe(profileId);
      expect(
        (await rpcReq(admin, "users.linkChannelIdentity", { profileId, identity: first.identity }))
          .ok,
      ).toBe(true);
      expect(firstPerson.socket.readyState).toBe(firstPerson.socket.CLOSED);
      const replacement = await reconnect(first);
      expect(replacement.result.ok, JSON.stringify(replacement.result.error)).toBe(true);
      expect(
        (await rpcReq<UsersSelfResult>(replacement.socket, "users.self")).payload?.profile.id,
      ).toBe(profileId);
    } finally {
      for (const socket of sockets) {
        socket.close();
      }
    }
  });
});
