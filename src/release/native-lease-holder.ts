/** The holder of a script's lease: the shell `CATALY_NATIVE_LEASE_PID` names, else the parent that will exec OMP. */
export function scriptLeaseHolder(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const named = env["CATALY_NATIVE_LEASE_PID"];
  if (named !== undefined && !/^[1-9]\d*$/.test(named)) throw new Error("CATALY_NATIVE_LEASE_PID must be a process id");
  if (named) return Number(named);
  // An orphan's parent is init, which never ends; the script itself holds then.
  return process.ppid > 1 ? process.ppid : process.pid;
}
