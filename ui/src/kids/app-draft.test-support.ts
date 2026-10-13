import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, vi, type MockInstance } from "vitest";
import { requestResult } from "../lib/chat/control-ui-database.runtime.ts";
import { KidsDraft } from "./draft.ts";

/**
 * Real draft owner/store with test-owned IndexedDB. App suites retire their apps
 * first; cleanup then closes/deletes the database through its version lifecycle.
 * Tests keep setImmediate real for IndexedDB and await bind rather than polling.
 */
export function useKidsDraftStoreFixture() {
  let database: IDBFactory;
  let binding: MockInstance<KidsDraft["bind"]>;
  beforeEach(() => {
    database = new IDBFactory();
    vi.stubGlobal("indexedDB", database);
    binding = vi.spyOn(KidsDraft.prototype, "bind");
  });
  afterEach(async () => {
    binding.mockRestore();
    await requestResult(database.deleteDatabase("openclaw-control-ui"));
    vi.unstubAllGlobals();
  });
  return {
    /** Join the last real bind initiated by a verified conversation update. */
    async settle(): Promise<void> {
      const result = binding.mock.results.at(-1);
      if (result?.type !== "return") {
        throw new Error("The app has not bound a verified draft yet");
      }
      await result.value;
    },
  };
}
