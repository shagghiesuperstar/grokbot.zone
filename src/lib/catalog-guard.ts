// One equality for the static build and the live catalog: files/rows emitted == dataset == totalBots.
// A disagreeing total is a failed build or a 503, never a second number copied into a file.

export function catalogGuardMessage(emitted: number, dataset: number, totalBots: number): string | null {
  if (emitted === dataset && dataset === totalBots) return null;
  return `${emitted} emitted, ${dataset} dataset, totalBots ${totalBots}`;
}
