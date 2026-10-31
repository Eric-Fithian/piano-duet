type Difficulty = { low: number; high: number; chordNotes: number; notesPerHand: number; handSpan: number; handLeap: number;
  attackBeats: number; attackFloorMs: number; durationFraction: number };

const LEVELS: Difficulty[] = [
  { low: 48, high: 76, chordNotes: 2, notesPerHand: 1, handSpan: 5, handLeap: 5, attackBeats: 1, attackFloorMs: 450, durationFraction: 0.75 },
  { low: 43, high: 79, chordNotes: 3, notesPerHand: 2, handSpan: 7, handLeap: 7, attackBeats: 0.75, attackFloorMs: 300, durationFraction: 0.6 },
  { low: 36, high: 84, chordNotes: 4, notesPerHand: 3, handSpan: 12, handLeap: 12, attackBeats: 0.5, attackFloorMs: 180, durationFraction: 0.45 },
  { low: 28, high: 96, chordNotes: 6, notesPerHand: 4, handSpan: 12, handLeap: 19, attackBeats: 0.25, attackFloorMs: 100, durationFraction: 0.25 },
  { low: 21, high: 108, chordNotes: 8, notesPerHand: 5, handSpan: 14, handLeap: 24, attackBeats: 0.125, attackFloorMs: 70, durationFraction: 0 },
];

export class PerformanceLimits {
  readonly gap: number;
  readonly durationFloor: number;
  private readonly settings: Difficulty;
  private groupStart: number | null = null;
  private chord: number[] = [];
  private readonly handGroups = new Map<boolean, { start: number; pitches: number[] }>();
  private readonly lastAttack = new Map<number, number>();

  constructor(level: number, beat: number) {
    if (!Number.isInteger(level) || level < 1 || level > LEVELS.length) throw new Error("Reply difficulty must be an integer from 1 to 5");
    this.settings = LEVELS[level - 1];
    this.gap = Math.ceil(Math.max(this.settings.attackFloorMs, beat * this.settings.attackBeats * 1000) / 10) * 10;
    this.durationFloor = Math.ceil(this.gap * this.settings.durationFraction / 10) * 10;
  }

  inRange(pitch: number): boolean { return this.settings.low <= pitch && pitch <= this.settings.high; }

  private handCanMove(pitch: number): boolean {
    const previous = this.handGroups.get(pitch >= 60);
    return previous === undefined || Math.min(...previous.pitches.map((value) => Math.abs(pitch - value))) <= this.settings.handLeap;
  }

  private chordCanAdd(pitch: number): boolean {
    if (this.chord.length >= this.settings.chordNotes || this.chord.includes(pitch)) return false;
    const hand = this.chord.filter((value) => (value >= 60) === (pitch >= 60));
    if (hand.length >= this.settings.notesPerHand) return false;
    if (hand.length && Math.max(...hand, pitch) - Math.min(...hand, pitch) > this.settings.handSpan) return false;
    return hand.length > 0 || this.handCanMove(pitch);
  }

  windows(pitch: number, earliest: number): [number, number][] {
    if (!this.inRange(pitch)) return [];
    earliest = Math.max(earliest, (this.lastAttack.get(pitch) ?? -1000) + 60);
    if (this.groupStart === null) return [[earliest, Infinity]];
    const result: [number, number][] = [];
    if (earliest <= this.groupStart + 40 && this.chordCanAdd(pitch)) result.push([earliest, this.groupStart + 40]);
    if (this.handCanMove(pitch)) result.push([Math.max(earliest, this.groupStart + this.gap), Infinity]);
    return result;
  }

  record(pitch: number, onset: number): void {
    if (this.groupStart === null || onset > this.groupStart + 40) { this.groupStart = onset; this.chord = []; }
    this.chord.push(pitch);
    const hand = pitch >= 60;
    let group = this.handGroups.get(hand);
    if (!group || group.start !== this.groupStart) { group = { start: this.groupStart, pitches: [] }; this.handGroups.set(hand, group); }
    group.pitches.push(pitch);
    this.lastAttack.set(pitch, onset);
  }
}
