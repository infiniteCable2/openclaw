import { inventory } from "./database-worker-inventory.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  compareRatchetCounts,
  parseRatchetArgs,
  reportRatchetFailures,
  resolveRatchetBase,
} from "./lib/shrink-ratchet.mts";

// Approved compatibility debt: the released synchronous append contract must
// persist its journal intent in the original transcript transaction. Keep these
// calls classified T1; allow only one lookup and one insert in this operation.
// Remove this allowance with the synchronous append contract's worker cutover.
function compatibilityAllowance(row: ReturnType<typeof inventory>[number]): number {
  if (row.file !== "src/config/sessions/conversation-publication.kernel.ts") {
    return 0;
  }
  const capture = row.calls.filter(
    (call) => call.operation === "captureConversationPublicationInTransaction",
  );
  return (
    Number(
      capture.some(
        (call) =>
          call.primitive === "executeSqliteQueryTakeFirstSync" && call.binding === "existing",
      ),
    ) +
    Number(
      capture.some(
        (call) => call.primitive === "executeSqliteQuerySync" && call.binding === undefined,
      ),
    )
  );
}

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  try {
    const args = parseRatchetArgs(argv);
    if (args.prune) {
      throw new Error("SQLite worker ratchet has no baseline to prune.");
    }
    const base = resolveRatchetBase(root, args);
    if (!base) {
      throw new Error("SQLite worker ratchet requires a Git base commit.");
    }
    const counts = (rows: ReturnType<typeof inventory>) =>
      new Map(
        rows
          .filter((row) => row.tier === "T1")
          .map((row) => [row.file, row.calls.length - compatibilityAllowance(row)]),
      );
    const head = inventory(root, "", args.staged);
    const before = counts(inventory(root, base));
    const after = counts(head);
    const total = (files: ReadonlyMap<string, number>) =>
      [...files.values()].reduce((sum, count) => sum + count, 0);
    const { increased } = compareRatchetCounts(after, before);
    if (
      total(after) > total(before) &&
      reportRatchetFailures(
        [
          {
            title: `Main-thread SQLite T1 total grew: ${total(before)} -> ${total(after)}`,
            entries: increased.flatMap(({ entry, allowed, current }) =>
              [`${entry}: ${allowed} -> ${current}`].concat(
                head
                  .filter((row) => row.file === entry)
                  .flatMap((row) => row.calls)
                  .map((call) => `${entry}:${call.line}:${call.column} ${call.primitive}`),
              ),
            ),
          },
        ],
        "Move SQL behind the owner's worker operation: docs/reference/database-schemas/worker-access.md\n" +
          "If the file only executes inside a worker, name it *.worker.ts or add it to workerModules in scripts/database-worker-inventory.mjs with caller evidence.",
      )
    ) {
      return 1;
    }
    console.log(
      "SQLite worker ratchet OK: no unapproved T1 call-count growth against " +
        base +
        "; bounded synchronous journal allowance: " +
        head
          .filter((row) => row.tier === "T1")
          .reduce((sum, row) => sum + compatibilityAllowance(row), 0) +
        " sites.",
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
