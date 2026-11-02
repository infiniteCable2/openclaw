import "../config/sessions/session-accessor.sqlite-replacement-publication.test-support.js";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { readSessionEntryCache } from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { readExactSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { applySessionEntryExactReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
} from "./session-sharing-preparation.js";

const { getReplacementPublicationDelivery } =
  await import("../config/sessions/session-accessor.sqlite-replacement-publication.test-support.js");
const delivery = getReplacementPublicationDelivery();

it.each(["unchanged", "visibility", "public-share"] as const)(
  "retains only proven native access facts after metadata and participant supersession (%s)",
  async (foreignChange) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("metadata-supersession.sqlite");
      const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
      const scope = { agentId: "main", storePath, sessionKey: "agent:main:metadata-supersession" };
      replaceSessionEntrySync(scope, {
        sessionId: "metadata-supersession",
        lifecycleRevision: "same-conversation",
        updatedAt: 1,
        visibility: "draft",
        chatType: "direct",
        createdActor: { type: "human", source: "profile", id: "owner" },
      });
      recordSessionParticipant(scope, {
        identity: { type: "profile", id: "owner" },
        promptedAt: 1,
      });
      const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      const facts = await prepareSessionMutationFacts({ cfg, ...scope });
      try {
        const initial = facts.readCurrent(cfg).target;
        expect(initial?.entry.participantCount).toBe(1);
        if (foreignChange !== "unchanged") {
          const patch =
            foreignChange === "visibility"
              ? { visibility: "shared" }
              : {
                  publicShare: {
                    id: "synthetic-public-share",
                    sessionId: "metadata-supersession",
                    createdAt: 1,
                  },
                };
          using foreign = new DatabaseSync(storePath);
          foreign
            .prepare(
              "UPDATE session_nodes SET entry_json = json_patch(entry_json, ?) WHERE session_key = ?",
            )
            .run(JSON.stringify(patch), scope.sessionKey);
        }
        // Exercise an acknowledged worker COMMIT whose delivery is overtaken by a
        // native postimage. The executor/SQL and retained authority remain real.
        delivery.afterResult = () => {
          readSessionEntryCache(database, { cache: true });
          recordSessionParticipant(scope, {
            identity: { type: "profile", id: "second-reader" },
            promptedAt: 2,
          });
        };
        await applySessionEntryExactReplacements({
          ...scope,
          sessionKeys: [scope.sessionKey],
          update: ([row]) => ({
            result: undefined,
            replacements: [
              { sessionKey: scope.sessionKey, entry: { ...row!.entry, label: "completed reply" } },
            ],
          }),
        });
        expect(readExactSessionEntryRow(database, scope.sessionKey)?.entry.label).toBe(
          "completed reply",
        );
        if (foreignChange !== "unchanged") {
          expect(() => facts.readCurrent(cfg)).toThrow(SessionMutationFactsUnavailableError);
          expect(readExactSessionEntryRow(database, scope.sessionKey)?.entry).toMatchObject(
            foreignChange === "visibility"
              ? { visibility: "shared", participantCount: 2 }
              : { publicShare: { id: "synthetic-public-share" }, participantCount: 2 },
          );
          return;
        }
        const current = facts.readCurrent(cfg).target;
        expect(current?.entry).toMatchObject({
          sessionId: initial?.entry.sessionId,
          lifecycleRevision: "same-conversation",
          visibility: "draft",
          participantCount: 2,
          participants: [
            { identity: { type: "profile", id: "owner" } },
            { identity: { type: "profile", id: "second-reader" } },
          ],
        });
      } finally {
        delivery.afterResult = undefined;
        facts.release();
      }
    });
  },
);

it.each([
  { supersede: false, foreignPreimage: false },
  { supersede: true, foreignPreimage: false },
  { supersede: false, foreignPreimage: true },
])(
  "keeps acknowledged worker run facts current before result delivery with native supersession=$supersede foreign-preimage=$foreignPreimage",
  async ({ supersede, foreignPreimage }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("run-publication.sqlite");
      const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
      const scope = { agentId: "main", storePath, sessionKey: "agent:main:run-publication" };
      const incarnation = { sessionId: "run-publication", lifecycleRevision: "same-conversation" };
      replaceSessionEntrySync(scope, {
        ...incarnation,
        updatedAt: 1,
        visibility: "draft",
        chatType: "direct",
        activeWriterRunId: foreignPreimage ? "next-writer" : "previous-writer",
        lifecycleRunId: foreignPreimage ? "next-run" : "previous-run",
        createdActor: { type: "human", source: "profile", id: "owner" },
      });
      recordSessionParticipant(scope, {
        identity: { type: "profile", id: "owner" },
        promptedAt: 2,
        expectedSession: incarnation,
      });
      const facts = await prepareSessionMutationFacts({ cfg, ...scope });
      if (foreignPreimage) {
        using foreign = new DatabaseSync(storePath);
        foreign
          .prepare(
            "UPDATE session_nodes SET entry_json = json_patch(entry_json, ?) WHERE session_key = ?",
          )
          .run(JSON.stringify({ visibility: "shared" }), scope.sessionKey);
      }
      const observe = () => {
        try {
          return facts.readCurrent(cfg);
        } catch (error) {
          console.warn("[native-run-publication] retained facts failed", error);
          return error;
        }
      };
      let beforeDelivery: unknown;
      let fresh: Awaited<ReturnType<typeof prepareSessionMutationFacts>> | undefined;
      let freshBeforeDelivery: unknown;
      let oldAfterFresh: unknown;
      try {
        // Actual SQL, commit admission and native settlement finish before this
        // observation seam delays the ordinary result's domain publication.
        delivery.afterResult = async () => {
          if (supersede) {
            // The same original human's earlier timestamp changes no audience.
            expect(
              recordSessionParticipant(scope, {
                identity: { type: "profile", id: "owner" },
                promptedAt: 1,
                expectedSession: incarnation,
              }),
            ).toBe("updated");
          }
          beforeDelivery = observe();
          if (!supersede) {
            fresh = await prepareSessionMutationFacts({ cfg, ...scope });
            freshBeforeDelivery = fresh.readCurrent(cfg);
            oldAfterFresh = observe();
          }
        };
        await applySessionEntryExactReplacements({
          ...scope,
          sessionKeys: [scope.sessionKey],
          update: ([row]) => ({
            result: undefined,
            replacements: [
              {
                sessionKey: scope.sessionKey,
                entry: {
                  ...row!.entry,
                  visibility: "draft",
                  activeWriterRunId: "next-writer",
                  lifecycleRunId: "next-run",
                },
              },
            ],
          }),
        });
        const afterDelivery = observe();
        const expected = {
          target: {
            entry: {
              ...incarnation,
              activeWriterRunId: "next-writer",
              lifecycleRunId: "next-run",
              visibility: "draft",
              participantCount: 1,
              participants: [{ identity: { type: "profile", id: "owner" } }],
            },
          },
        };
        if (foreignPreimage) {
          expect(beforeDelivery).toBeInstanceOf(SessionMutationFactsUnavailableError);
          expect(oldAfterFresh).toBeInstanceOf(SessionMutationFactsUnavailableError);
        } else {
          expect(beforeDelivery).toMatchObject(expected);
        }
        expect(afterDelivery).toMatchObject(expected);
        if (!supersede) {
          expect(freshBeforeDelivery).toMatchObject(expected);
        }
      } finally {
        delivery.afterResult = undefined;
        facts.release();
        fresh?.release();
      }
    });
  },
);
