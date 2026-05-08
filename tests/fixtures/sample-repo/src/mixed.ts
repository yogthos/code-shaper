// Interleaved declarations — round-trip must preserve source order.

export function alpha(): number {
  return 1;
}

export class Beta {
  m(): void {}
}

function gamma(): void {}

export const delta = (): string => "d";

export class Epsilon {
  static k(): number {
    return 5;
  }
}
