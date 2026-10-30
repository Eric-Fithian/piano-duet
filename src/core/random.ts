export class RandomSource {
  private readonly draw: () => number;

  constructor(draw: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) {
    this.draw = draw;
  }

  random(): number {
    const value = this.draw();
    if (!(value >= 0 && value < 1)) throw new Error("Random draws must be in [0, 1)");
    return value;
  }

  choice<T>(options: T[]): T {
    if (!options.length) throw new Error("Cannot choose from an empty sequence");
    return options[Math.floor(this.random() * options.length)];
  }

  choices(options: number[], weights: number[]): number[] {
    if (!options.length || options.length !== weights.length || weights.some((weight) => !Number.isFinite(weight) || weight < 0)) {
      throw new Error("Weighted choices need matching, nonnegative finite weights");
    }
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (!(total > 0) || !Number.isFinite(total)) throw new Error("Weighted choices need a positive finite total");
    const threshold = this.random() * total;
    let cumulative = 0;
    for (let index = 0; index < options.length; index++) {
      cumulative += weights[index];
      if (threshold < cumulative) return [options[index]];
    }
    throw new Error("The weighted choice could not be resolved");
  }

  sample(options: number[], count: number): number[] {
    if (!Number.isInteger(count) || count < 0 || count > options.length) throw new Error("Invalid sample size");
    const remaining = [...options];
    return Array.from({ length: count }, () => remaining.splice(Math.floor(this.random() * remaining.length), 1)[0]);
  }
}
