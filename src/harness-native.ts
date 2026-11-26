import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { clearStoppedLead, type LeadResume } from "./harness-native-resume.ts";
import { harnessLaunchEnv, nativeHarnessCommand, rolePrompt, type Deps } from "./harness.ts";
import { leadCarryPath, readLeadCarry, unheldCarry } from "./inbox-carry.ts";
import { acquire, release } from "./loop-lock.ts";
import { Refusal } from "./refusal.ts";
import { refText, sameSession } from "./refs.ts";
import { laneMessengerOverrides } from "./release/runtime.ts";
import { groupId } from "./runtime/group.ts";
import { type HeadlessObservation, HeadlessRuntime } from "./runtime/headless.ts";
import { laneEntry, readPrivate, writePrivate } from "./runtime/headless-record.ts";
import { HEADLESS_ADDRESS, type SessionRef } from "./runtime/types.ts";
import { RESERVED_KEYS, type Role } from "./store-types.ts";

/** Agent roles record the OMP session they proved; the lead's transcript is what a later `up` resumes. */
export type Binding = { readonly ref: SessionRef; readonly sessionId?: string; readonly sessionFile?: string };
type Inventory = { readonly version: 1; readonly stateDir: string; readonly roles: Partial<Record<Role, Binding>> };

export const inventoryPath = (d: Deps) => join(d.store.root, "harness-native.json");
const agent = (role: Role): role is "lead" | "duty" => role === "lead" || role === "duty";
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function withHarnessLock<T>(
  d: Parameters<typeof acquire>[0] & { readonly store: Pick<Deps["store"], "root"> },
  run: () => Promise<T> | T,
): Promise<T> {
  const path = join(d.store.root, "harness.lock");
  const held = acquire(d, path);
  if ("holder" in held) throw new Refusal(`another harness operation owns this home (${held.holder})`);
  try {
    return await run();
  } finally {
    release(d, held.nonce, path);
  }
}

export function nativeInventory(d: Deps): Inventory | undefined {
  const saved = readPrivate<Inventory>(inventoryPath(d));
  if (!saved) return undefined;
  if (
    saved.version !== 1 ||
    typeof saved.stateDir !== "string" ||
    !isAbsolute(saved.stateDir) ||
    !saved.roles ||
    typeof saved.roles !== "object" ||
    Array.isArray(saved.roles)
  )
    throw new Refusal("native harness inventory is invalid; no process can be assumed owned");
  const ids = new Set<string>();
  const sessions = new Set<string>();
  for (const [role, record] of Object.entries(saved.roles)) {
    if (
      !RESERVED_KEYS.some((key) => key === role) ||
      !record ||
      record.ref?.runtime !== "headless" ||
      !HEADLESS_ADDRESS.test(record.ref.id) ||
      ids.has(record.ref.id) ||
      (record.sessionId !== undefined &&
        (!agent(role as Role) ||
          !record.sessionId ||
          typeof record.sessionId !== "string" ||
          sessions.has(record.sessionId))) ||
      (record.sessionFile !== undefined && (typeof record.sessionFile !== "string" || !isAbsolute(record.sessionFile)))
    )
      throw new Refusal("native harness inventory has an ambiguous role or session identity");
    ids.add(record.ref.id);
    if (record.sessionId) sessions.add(record.sessionId);
  }
  return saved;
}

function scopeCommand(d: Deps, role: "lead" | "duty", argv: readonly string[]): string[] {
  const dir = join(d.store.root, "prompts");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${role}.md`);
  const prompt = rolePrompt(d, `${role}.md`);
  const scope =
    role === "duty"
      ? prompt +
        "\nThe harness owns duty-loop and hourly-loop. Do not open terminal panes, start duplicate controllers, or take over lead intake.\n"
      : prompt +
        "\nYou are the native headless lead; use the harness commands to observe and reach registered sessions, not terminal emulation.\n";
  // Atomic, owner-only file: the native CLI consumes an explicit prompt file, never shell interpolation.
  const promptPath = `${path}.${crypto.randomUUID()}.md`;
  writeFileSync(promptPath, scope, { flag: "wx", mode: 0o600 });
  return [...argv, "--append-system-prompt", promptPath];
}

/**
 * Runs under the harness lock. Publish a reservation before its process starts, then publish only proven roles. A
 * `resume` lead must prove exactly that session; duty and the loops always start fresh.
 */
export async function startNativeHarness(d: Deps, rt: HeadlessRuntime, cwd: string, resume?: LeadResume) {
  const commands = {
    lead: scopeCommand(d, "lead", (await nativeHarnessCommand(d, "lead")).argv),
    duty: scopeCommand(d, "duty", (await nativeHarnessCommand(d, "duty")).argv),
  };
  const env = {
    ...harnessLaunchEnv(d),
    CATALY_STATE_DIR: rt.stateDir,
    CATALY_LANE: "",
    CATALY_LANE_POLICY: "",
    CATALY_RUNTIME: "headless",
  };
  const state: Inventory = { version: 1, stateDir: rt.stateDir, roles: {} };
  const files = new Set<string>();
  const save = () => writePrivate(inventoryPath(d), state);
  for (const role of RESERVED_KEYS) {
    try {
      const ref = await rt.create({
        name: role,
        role,
        container: role === "lead" ? "workspace-root" : "tab",
        cwd,
        env,
        group: groupId(d.store.root),
      });
      state.roles[role] = { ref };
      save();
      const scoped = role === "lead" ? env : { ...env, ...laneMessengerOverrides };
      const seen = agent(role)
        ? await rt.startNative(ref, commands[role], scoped, role === "lead" ? resume : undefined)
        : await rt.startLoop(ref, scoped);
      if (agent(role)) {
        if (
          !seen.sessionId ||
          !seen.sessionFile ||
          files.has(seen.sessionFile) ||
          Object.values(state.roles).some((binding) => seen.sessionId === binding.sessionId)
        )
          throw new Refusal("native role did not prove a distinct OMP session");
        files.add(seen.sessionFile);
        state.roles[role] = { ref, sessionId: seen.sessionId, sessionFile: seen.sessionFile };
        save();
        if (role === "lead") clearStoppedLead(d);
      }
      if (d.store.roles()[role]) throw new Refusal(`${role} was registered independently during startup`);
      d.store.setRole(role, ref);
      // A stop carried what the previous lead never read. Hand it over as soon as the lead exists, before duty and the
      // loops can queue anything newer, so the owner's unanswered message survives the restart once and in order.
      if (role === "lead") {
        const carried = readLeadCarry(d.store.root);
        const restorable = unheldCarry(carried, d.store.queued(ref));
        for (const m of restorable) await d.store.enqueue(ref, { at: m.at, from: m.from, text: m.text }, true);
        if (restorable.length > 0) console.log(`CARRIED ${restorable.length} unread lead message(s) restored`);
        if (carried.length > 0) rmSync(leadCarryPath(d.store.root), { force: true });
      }
    } catch (error) {
      throw new Refusal(
        `Cannot start ${role}: ${reason(error)}. Existing sessions were not replaced; inspect cataly harness status, then use cataly harness stop.`,
      );
    }
  }
  const show = (role: Role) => refText(state.roles[role]!.ref);
  console.log(
    `UP runtime=headless lead=${show("lead")} duty=${show("duty")} loop=${show("duty-loop")} hourly=${show("hourly-loop")} home=${d.store.root}${resume ? ` resumed=${resume.sessionId}` : ""}`,
  );
}

export const runtimeAt = (d: Deps, state: Inventory): HeadlessRuntime =>
  new HeadlessRuntime(state.stateDir, { ...process.env, CATALY_HOME: resolve(d.store.root) });

export function checkRegistration(d: Deps, role: Role, expected: SessionRef): void {
  const current = d.store.roles()[role];
  if (current && !sameSession(current, expected))
    throw new Refusal(`${role} registration does not match the owned ref`);
}

/** Native role refs belong to their inventory's runtime, not the invoking shell's state directory. */
export function registeredNativeTarget(d: Deps, ref: SessionRef) {
  const roles = d.store.roles();
  const registered = RESERVED_KEYS.filter((role) => {
    const candidate = roles[role];
    return candidate && sameSession(candidate, ref);
  });
  if (ref.runtime !== "headless") {
    if (registered.length && nativeInventory(d))
      throw new Refusal(`${registered.join(", ")} has no owned native role binding; inspect cataly harness status`);
    return undefined;
  }
  const state = nativeInventory(d);
  for (const role of RESERVED_KEYS) {
    const binding = state?.roles[role];
    if (!state || !binding || !sameSession(binding.ref, ref)) continue;
    if (registered.length !== 1 || registered[0] !== role || (agent(role) && !binding.sessionId))
      throw new Refusal(`${role} has no matching verified native role registration; inspect cataly harness status`);
    if (laneEntry(state.stateDir, ref)?.reservation.role !== role)
      throw new Refusal(`${role} native reservation identity is unconfirmed; inspect cataly harness status`);
    return { role, sessionId: binding.sessionId, runtime: runtimeAt(d, state) };
  }
  if (registered.length)
    throw new Refusal(`${registered.join(", ")} has no owned native role binding; inspect cataly harness status`);
  // An unpublished reservation is not an alternative route to a harness role, even by its raw UUID.
  const fallback = d.runtimes.for(ref);
  if (fallback instanceof HeadlessRuntime) {
    const role = laneEntry(fallback.stateDir, ref)?.reservation.role;
    if (role && role !== "lane")
      throw new Refusal(`${role} has no owned native role binding; inspect cataly harness status`);
  }
  return undefined;
}

/** An exact unpublished reservation is useful only for inspecting or settling the broker's current dialog. */
export async function nativeDialogTarget(d: Deps, ref: SessionRef) {
  const state = nativeInventory(d);
  const registered = d.store.roles();
  for (const role of ["lead", "duty"] as const) {
    const binding = state?.roles[role];
    if (!state || !binding || registered[role] || !sameSession(binding.ref, ref)) continue;
    if (Object.values(registered).some((candidate) => candidate && sameSession(candidate, ref)))
      throw new Refusal(`${role} recovery has a conflicting registration`);
    if (laneEntry(state.stateDir, ref)?.reservation.role !== role)
      throw new Refusal(`${role} native reservation identity is unconfirmed`);
    const runtime = runtimeAt(d, state);
    const seen = await runtime.observe(ref);
    if (
      seen.harnessRole !== role ||
      seen.role !== "cataly" ||
      !sameSession(seen.ref, ref) ||
      !seen.sessionId ||
      !seen.sessionFile ||
      (binding.sessionId !== undefined && binding.sessionId !== seen.sessionId) ||
      Object.entries(state.roles).some(([name, other]) => name !== role && other?.sessionId === seen.sessionId)
    )
      throw new Refusal(`${role} recovery session identity is unconfirmed or changed`);
    return { role, sessionId: seen.sessionId, runtime };
  }
  return registeredNativeTarget(d, ref);
}

export async function nativeHarnessStatus(d: Deps): Promise<string[]> {
  const state = nativeInventory(d);
  if (!state) return [];
  const rt = runtimeAt(d, state);
  return Promise.all(
    RESERVED_KEYS.flatMap((role) => {
      const binding = state.roles[role];
      if (!binding) return [];
      return [
        (async () => {
          const prefix = `NATIVE ${role} ${refText(binding.ref)}`;
          let seen: HeadlessObservation;
          try {
            checkRegistration(d, role, binding.ref);
            seen = await rt.observe(binding.ref);
          } catch (error) {
            return `${prefix} unknown (${reason(error)})`;
          }
          if (seen.harnessRole !== role || (binding.sessionId && seen.sessionId !== binding.sessionId))
            return `${prefix} ${seen.status === "gone" ? "gone" : "unknown"}${seen.detail ? ` (${seen.detail})` : ""}`;
          const log = agent(role) ? "" : ` log=${rt.loopLog(binding.ref)}`;
          return `${prefix} ${agent(role) ? seen.status : seen.status === "working" ? "running" : seen.status}${seen.pid ? ` pid=${seen.pid}` : ""}${seen.sessionId ? ` session=${seen.sessionId}` : ""}${log}`;
        })(),
      ];
    }),
  );
}
