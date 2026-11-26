import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type Binding,
  checkRegistration,
  inventoryPath,
  nativeInventory,
  runtimeAt,
  withHarnessLock,
} from "./harness-native.ts";
import { recordStoppedLead } from "./harness-native-resume.ts";
import type { Deps } from "./harness.ts";
import { retireTerminalRoles } from "./harness-terminal-roles.ts";
import { carryLeadInbox } from "./inbox-carry.ts";
import { pendingLead } from "./inbox-files.ts";
import { inboxSealed, lockInboxFiles, lockRoute, mergeOwnSpool, sealNativeInbox } from "./inbox-spool.ts";
import { Refusal } from "./refusal.ts";
import { refText, sameSession } from "./refs.ts";
import type { HeadlessObservation, HeadlessRuntime } from "./runtime/headless.ts";
import { laneEntry, readPrivate, type StopReceipt, writePrivate } from "./runtime/headless-record.ts";
import { RESERVED_KEYS, type Role } from "./store-types.ts";

function holdForOwedLead(d: Deps): void {
  const lead = d.store.roles().lead;
  if (lead && !inboxSealed(d.store.root, lead) && pendingLead(d.store.root))
    throw new Refusal("pending inbox notices need a duty pass");
}

async function checkStopIdentity(rt: HeadlessRuntime, role: Role, binding: Binding) {
  const { ref, sessionId } = binding;
  const entry = laneEntry(rt.stateDir, ref);
  if (!entry || entry.reservation.role !== role) throw new Refusal("native harness reservation mismatch");
  const stopped = () => readPrivate<StopReceipt>(join(entry.dir, "stopped.json")) !== undefined;
  if (stopped() || !existsSync(join(entry.dir, "started"))) return undefined;
  const seen = await rt.observe(ref);
  if (stopped()) return undefined;
  if (seen.harnessRole !== role || !sameSession(seen.ref, ref))
    throw new Refusal("native role identity is unconfirmed");
  if (role === "duty-loop" || role === "hourly-loop") {
    if (seen.pid === undefined || seen.role !== undefined) throw new Refusal("plain loop identity is unconfirmed");
    return seen;
  }
  if (
    seen.role !== "cataly" ||
    !seen.sessionId ||
    !seen.sessionFile ||
    (sessionId !== undefined && seen.sessionId !== sessionId)
  )
    throw new Refusal("native role session identity is unconfirmed or changed");
  if (seen.held || seen.status !== "idle")
    throw new Refusal("native role is busy or awaiting an answer; no approval was touched");
  return seen;
}

export async function stopNativeHarness(d: Deps): Promise<void> {
  await withHarnessLock(d, async () => {
    const state = nativeInventory(d);
    if (!state) {
      const retired = await retireTerminalRoles(d);
      console.log(
        retired
          ? `STOPPED retired ${retired} already-gone terminal role registration(s)`
          : "STOPPED no owned native harness",
      );
      return;
    }
    const rt = runtimeAt(d, state);
    const root = d.store.root;
    const unlock: (() => void)[] = [];
    const stopped = new Set<Role>();
    const retained: string[] = [];
    let checking: Role | undefined;
    try {
      const registered = d.store.roles();
      if (Object.keys(registered).some((name) => !RESERVED_KEYS.some((role) => name === role)))
        throw new Refusal("unknown registration is not owned by this native harness");
      for (const role of RESERVED_KEYS) {
        checking = role;
        const binding = state.roles[role];
        if (!binding) {
          if (registered[role]) throw new Refusal("registration is not owned by this native harness");
          continue;
        }
        checkRegistration(d, role, binding.ref);
        // A sender holds route while writing or spooling; a flush only holds the queue lock.
        const route = lockRoute(root, binding.ref, d.now());
        if (!route) throw new Refusal("inbox route is in use; retry after it settles");
        unlock.push(route);
        const queue = lockInboxFiles(root, binding.ref, d.now());
        if (!queue) throw new Refusal("inbox flush is in progress; retry after it settles");
        unlock.push(queue);
        const entry = laneEntry(rt.stateDir, binding.ref);
        const receipt = entry?.reservation.role === role && readPrivate<StopReceipt>(join(entry.dir, "stopped.json"));
        if (receipt) {
          if (
            binding.sessionId &&
            receipt.closedSessionId !== undefined &&
            receipt.closedSessionId !== binding.sessionId
          )
            throw new Refusal("native stop receipt belongs to a different OMP session");
          // Natural exit has no close-request session ID; the broker writes to its single-use reservation.
          stopped.add(role);
        }
        const pending = d.store.queued(binding.ref).length > 0 || d.store.mergePending(binding.ref);
        if (pending && !stopped.has(role))
          throw new Refusal(
            `pending inbox entries; let duty flush or inspect cataly harness inbox list ${refText(binding.ref)}`,
          );
        if (pending) retained.push(refText(binding.ref));
      }
      checking = "lead";
      if (!stopped.has("lead")) holdForOwedLead(d);
      const seen = new Map<Role, HeadlessObservation>();
      for (const role of RESERVED_KEYS) {
        checking = role;
        const binding = state.roles[role];
        if (!binding) continue;
        const observed = await checkStopIdentity(rt, role, binding);
        if (observed) seen.set(role, observed);
      }
      checking = undefined;
      const lead = seen.get("lead");
      const duty = seen.get("duty");
      if (lead && duty && (lead.sessionId === duty.sessionId || lead.sessionFile === duty.sessionFile))
        throw new Refusal("lead and duty have ambiguous native identity");

      // The hourly pass can produce logical lead notices while winding down. Check again before sealing lead, and
      // leave duty running until the agent inboxes are retired. A send after the seal can only reach the next lead.
      for (const role of ["hourly-loop", "lead", "duty", "duty-loop"] as const) {
        const binding = state.roles[role];
        if (!binding) continue;
        checking = role;
        if (role === "lead" && !stopped.has(role)) holdForOwedLead(d);
        checkRegistration(d, role, binding.ref);
        if (role === "lead") {
          // The lead's inbox dies with its session: keep what it never read for the next one before sealing. This stop
          // already holds the inbox lock, so the queue is read directly after its spool is moved in (that move needs
          // exactly this lock; taking the lock again could only fail).
          mergeOwnSpool(root, binding.ref);
          const carried = carryLeadInbox(root, d.store.queued(binding.ref));
          if (carried > 0) console.log(`CARRIED ${carried} unread lead message(s) for the next lead`);
        }
        sealNativeInbox(root, binding.ref);
        await rt.stopHarnessRole(binding.ref, role, binding.sessionId ?? seen.get(role)?.sessionId);
        // The next `up` resumes this lead only if its stop receipt closed exactly this session.
        if (role === "lead")
          recordStoppedLead(d, state.stateDir, {
            ref: binding.ref,
            sessionId: binding.sessionId ?? seen.get(role)?.sessionId,
            sessionFile: binding.sessionFile ?? seen.get(role)?.sessionFile,
          });
        d.store.clearRoles([[role, binding.ref]]);
        delete state.roles[role];
        writePrivate(inventoryPath(d), state);
      }
      rmSync(inventoryPath(d));
      console.log("STOPPED native harness");
      for (const ref of retained) console.log(`RETAINED inbox ${ref}; inspect cataly harness inbox list ${ref}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Refusal(`HARNESS STOP HELD\n${checking ? `${checking}: ` : ""}${detail}`);
    } finally {
      for (const release of unlock.reverse()) release();
    }
  });
}
