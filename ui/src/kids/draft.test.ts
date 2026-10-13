/* @vitest-environment node */
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "../lib/chat/composer-draft-store.runtime.ts";
import { requestResult } from "../lib/chat/control-ui-database.runtime.ts";
import { KidsDraft, type KidsDraftIdentity, type KidsDraftState } from "./draft.ts";

const identity: KidsDraftIdentity = {
  gatewayUrl: "wss://kids-drafts.test",
  sessionKey: "agent:student:kids:verified-child",
  sessionId: "physical-session-one",
};
const owners: KidsDraft[] = [];

function fixture() {
  const states: KidsDraftState[] = [];
  const owner = new KidsDraft((state) => states.push(state));
  owners.push(owner);
  return { owner, states };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  // Only the shared store's expiry sweep uses a timer; its I/O stays real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.dispose()));
  vi.restoreAllMocks();
  vi.clearAllTimers();
  await requestResult(indexedDB.deleteDatabase("openclaw-control-ui"));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("kids durable text draft", () => {
  it("restores text after reopening, never storing attachments or sending anything", async () => {
    const { owner } = fixture();
    const write = vi.spyOn(store, "writeDurableComposerDraft");
    await owner.bind(identity);
    owner.update("An unfinished story\nwith another line");
    await owner.dispose();

    const reopened = fixture().owner;
    await reopened.bind(identity);
    expect(reopened.state).toEqual({
      text: "An unfinished story\nwith another line",
      ready: true,
      saveError: null,
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![1]).toEqual({
      revision: expect.any(Number),
      text: "An unfinished story\nwith another line",
      attachments: [],
    });
  });

  it.each([
    { gatewayUrl: "wss://other-gateway.test" },
    { sessionKey: "agent:student:kids:another-verified-child" },
    { sessionId: "physical-session-after-reset" },
  ])("isolates restored text when identity changes: %j", async (change) => {
    const { owner } = fixture();
    await owner.bind(identity);
    owner.update("Private unfinished question");
    // Rebind before the queued write starts: the old accepted edit still saves.
    await owner.bind({ ...identity, ...change });
    expect(owner.state.text).toBe("");
    owner.update("A different question");
    await owner.bind(identity);
    expect(owner.state.text).toBe("Private unfinished question");
  });

  it("hides text on disconnect and retains it only for the same verified identity", async () => {
    const { owner } = fixture();
    await owner.bind(identity);
    owner.update("Keep my unfinished drawing idea");
    owner.disconnect();
    expect(owner.state).toEqual({ text: "", ready: false, saveError: null });
    owner.update("Unverified edits must not save");
    owner.accepted("Keep my unfinished drawing idea");
    await owner.bind(identity);
    expect(owner.state.text).toBe("Keep my unfinished drawing idea");
  });

  it("fences late restoration and coalesces superseded identity requests", async () => {
    const loaded = deferred<Awaited<ReturnType<typeof store.readDurableComposerDraft>>>();
    const started = deferred<void>();
    const read = vi.spyOn(store, "readDurableComposerDraft").mockImplementationOnce(() => {
      started.resolve();
      return loaded.promise;
    });
    const { owner, states } = fixture();
    const original = owner.bind(identity);
    await started.promise;
    const skipped = owner.bind({ ...identity, sessionId: "superseded" });
    const latest = owner.bind({ ...identity, sessionId: "newest" });
    owner.update("Not editable before restoration");
    loaded.resolve({
      status: "found",
      draft: { text: "Another identity's draft", revision: 1, writeId: "old", attachments: [] },
    });
    await Promise.all([original, skipped, latest]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]![0].scopeKey).toContain("newest");
    expect(states.some((state) => state.text === "Another identity's draft")).toBe(false);
    expect(owner.state).toEqual({ text: "", ready: true, saveError: null });
    owner.update("Now I can type");
    await owner.bind({ ...identity, sessionId: "newest" });
    expect(owner.state.text).toBe("Now I can type");
  });

  it("serializes writes and saves the latest old edit before restoring a new session", async () => {
    const { owner } = fixture();
    await owner.bind(identity);
    const actualWrite = store.writeDurableComposerDraft;
    const released = deferred<void>();
    const started = deferred<void>();
    const write = vi
      .spyOn(store, "writeDurableComposerDraft")
      .mockImplementationOnce(async (...args) => {
        started.resolve();
        await released.promise;
        return actualWrite(...args);
      });
    owner.update("First");
    await started.promise;
    owner.update("Second");
    owner.update("Latest");
    const rebound = owner.bind({ ...identity, sessionId: "new-session" });
    expect(owner.state.ready).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    released.resolve();
    await rebound;
    expect(write.mock.calls.map((call) => call[1].text)).toEqual(["First", "Latest"]);
    expect(owner.state.text).toBe("");
    await owner.bind(identity);
    expect(owner.state.text).toBe("Latest");
  });

  it("acknowledges only unchanged text and preserves edits made during a send", async () => {
    const { owner } = fixture();
    await owner.bind(identity);
    owner.update("First question");
    owner.update("Next question");
    owner.accepted("First question");
    expect(owner.state.text).toBe("Next question");
    owner.accepted("  Next question\n");
    expect(owner.state.text).toBe("");
    await owner.dispose();
    const reopened = fixture().owner;
    await reopened.bind(identity);
    expect(reopened.state.text).toBe("");
  });

  it("does not let a pending acknowledged write erase newer typing", async () => {
    const { owner } = fixture();
    await owner.bind(identity);
    const actualWrite = store.writeDurableComposerDraft;
    const released = deferred<void>();
    const started = deferred<void>();
    vi.spyOn(store, "writeDurableComposerDraft").mockImplementationOnce(async (...args) => {
      started.resolve();
      await released.promise;
      return actualWrite(...args);
    });
    owner.update("Accepted question");
    await started.promise;
    owner.accepted("Accepted question");
    owner.update("A follow-up still being written");
    released.resolve();
    await owner.dispose();
    const reopened = fixture().owner;
    await reopened.bind(identity);
    expect(reopened.state.text).toBe("A follow-up still being written");
  });

  it.each(["disconnect", "dispose", "rebind"] as const)(
    "retires an acknowledged draft while its save is pending across %s",
    async (retirement) => {
      const { owner } = fixture();
      await owner.bind(identity);
      const actualWrite = store.writeDurableComposerDraft;
      const released = deferred<void>();
      const started = deferred<void>();
      vi.spyOn(store, "writeDurableComposerDraft").mockImplementationOnce(async (...args) => {
        started.resolve();
        await released.promise;
        return actualWrite(...args);
      });
      owner.update("Already accepted");
      await started.promise;
      owner.accepted("Already accepted");
      expect(owner.state.text).toBe("");
      if (retirement === "disconnect") {
        owner.disconnect();
      } else if (retirement === "rebind") {
        void owner.bind({ ...identity, sessionId: "another-session" });
      }
      const closing = retirement === "dispose" ? owner.dispose() : null;
      released.resolve();
      await closing;
      await owner.dispose();
      const reopened = fixture().owner;
      await reopened.bind(identity);
      expect(reopened.state.text).toBe("");
    },
  );

  it.each([false, true])(
    "joins a receipt during restoration even after disposal (newer text: %s)",
    async (edited) => {
      const seeded = fixture().owner;
      await seeded.bind(identity);
      seeded.update(edited ? "Newer unsent thought" : "Already accepted");
      await seeded.dispose();
      const actualRead = store.readDurableComposerDraft;
      const released = deferred<void>();
      const started = deferred<void>();
      vi.spyOn(store, "readDurableComposerDraft").mockImplementationOnce(async (scope) => {
        started.resolve();
        await released.promise;
        return actualRead(scope);
      });
      const { owner } = fixture();
      const restoring = owner.bind(identity);
      await started.promise;
      owner.accepted("Already accepted");
      owner.disconnect();
      const closing = owner.dispose();
      released.resolve();
      await Promise.all([restoring, closing]);
      const reopened = fixture().owner;
      await reopened.bind(identity);
      expect(reopened.state.text).toBe(edited ? "Newer unsent thought" : "");
    },
  );

  it("retains an acknowledged intermediate restore when another write is draining", async () => {
    const acknowledgedIdentity = { ...identity, sessionId: "accepted-session" };
    const seeded = fixture().owner;
    await seeded.bind(acknowledgedIdentity);
    seeded.update("Already accepted");
    await seeded.dispose();
    const { owner } = fixture();
    await owner.bind(identity);
    const actualWrite = store.writeDurableComposerDraft;
    const released = deferred<void>();
    const started = deferred<void>();
    vi.spyOn(store, "writeDurableComposerDraft").mockImplementationOnce(async (...args) => {
      started.resolve();
      await released.promise;
      return actualWrite(...args);
    });
    owner.update("Unrelated current edit");
    await started.promise;
    void owner.bind(acknowledgedIdentity);
    owner.accepted("Already accepted");
    void owner.bind({ ...identity, sessionId: "latest-session" });
    const closing = owner.dispose();
    released.resolve();
    await closing;
    const reopened = fixture().owner;
    await reopened.bind(acknowledgedIdentity);
    expect(reopened.state.text).toBe("");
    await reopened.bind(identity);
    expect(reopened.state.text).toBe("Unrelated current edit");
  });

  it("admits an acknowledgement in the microtask after a write finishes", async () => {
    const { owner } = fixture();
    await owner.bind(identity);
    const actualWrite = store.writeDurableComposerDraft;
    const released = deferred<Awaited<ReturnType<typeof store.writeDurableComposerDraft>>>();
    const started = deferred<Parameters<typeof store.writeDurableComposerDraft>>();
    vi.spyOn(store, "writeDurableComposerDraft").mockImplementationOnce((...args) => {
      started.resolve(args);
      return released.promise;
    });
    owner.update("Already accepted");
    const args = await started.promise;
    const persisted = await actualWrite(...args);
    const acknowledged = deferred<void>();
    let rebound: Promise<void> | undefined;
    released.resolve(persisted);
    // The write's await resumes first. This action then lands before a chained
    // Promise.finally would release the previous worker's admission slot.
    queueMicrotask(() => {
      owner.accepted("Already accepted");
      rebound = owner.bind({ ...identity, sessionId: "new-session" });
      acknowledged.resolve();
    });
    await acknowledged.promise;
    await rebound;
    await owner.dispose();
    const reopened = fixture().owner;
    await reopened.bind(identity);
    expect(reopened.state.text).toBe("");
  });

  it("keeps both tabs' text intact when another tab wins the stored revision", async () => {
    const first = fixture().owner;
    const second = fixture().owner;
    await first.bind(identity);
    await second.bind(identity);
    first.update("First tab saved this");
    await first.bind(identity);
    second.update("Second tab's unsaved words");
    await second.bind(identity);
    expect(second.state).toEqual({
      text: "Second tab's unsaved words",
      ready: true,
      saveError: "conflict",
    });
    second.update("Still editable here");
    await second.bind(identity);
    expect(second.state.text).toBe("Still editable here");
    const reopened = fixture().owner;
    await reopened.bind(identity);
    expect(reopened.state.text).toBe("First tab saved this");
  });

  it.each(["read", "write"] as const)(
    "keeps local text editable and reports a %s storage failure without unsafe retries",
    async (failure) => {
      if (failure === "read") {
        vi.spyOn(store, "readDurableComposerDraft").mockResolvedValueOnce({
          status: "storage-failed",
        });
      }
      const write = vi.spyOn(store, "writeDurableComposerDraft");
      if (failure === "write") {
        write.mockResolvedValueOnce({ status: "storage-failed" });
      }
      const { owner } = fixture();
      await owner.bind(identity);
      owner.update("Keep these words");
      await owner.bind(identity);
      expect(owner.state).toEqual({
        text: "Keep these words",
        ready: true,
        saveError: "storage-failed",
      });
      owner.update("These words too");
      await owner.bind(identity);
      expect(owner.state.text).toBe("These words too");
      expect(write).toHaveBeenCalledTimes(failure === "read" ? 0 : 1);
    },
  );

  it("joins admitted saves during disposal while fencing callbacks and later input", async () => {
    const { owner, states } = fixture();
    await owner.bind(identity);
    const actualWrite = store.writeDurableComposerDraft;
    const released = deferred<void>();
    const started = deferred<void>();
    vi.spyOn(store, "writeDurableComposerDraft").mockImplementationOnce(async (...args) => {
      started.resolve();
      await released.promise;
      return actualWrite(...args);
    });
    owner.update("First");
    await started.promise;
    owner.update("Save this before closing");
    let joined = false;
    const closing = owner.dispose().then(() => {
      joined = true;
    });
    const count = states.length;
    owner.update("Too late");
    owner.disconnect();
    expect(joined).toBe(false);
    released.resolve();
    await closing;
    expect(joined).toBe(true);
    expect(states).toHaveLength(count);
    expect(owner.state).toEqual({ text: "", ready: false, saveError: null });
    const reopened = fixture().owner;
    await reopened.bind(identity);
    expect(reopened.state.text).toBe("Save this before closing");
  });
});
