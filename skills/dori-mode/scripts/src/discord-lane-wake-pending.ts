const PREFIX = "discord-wake-pending:";
const BOUND_PREFIX = `${PREFIX}bound:`;

export const isDiscordWakePending = (epoch: string | undefined): boolean => epoch?.startsWith(PREFIX) === true;

export const discordWakePendingEpoch = (epoch: string): string => PREFIX + epoch;

export const discordWakeBoundEpoch = (epoch: string): string => BOUND_PREFIX + epoch;

export const discordWakeCompletedEpoch = (epoch: string): string | undefined =>
  epoch.startsWith(BOUND_PREFIX) ? epoch.slice(BOUND_PREFIX.length) : undefined;
