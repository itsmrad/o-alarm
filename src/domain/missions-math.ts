import { z } from 'zod';

export const MATH_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type MathDifficulty = (typeof MATH_DIFFICULTIES)[number];

export const MATH_MAX_PROBLEMS = 10;
export const MATH_MAX_INPUT_LENGTH = 6;

export const mathConfigSchema = z.object({
  difficulty: z.enum(MATH_DIFFICULTIES).default('easy'),
  problemCount: z.number().int().min(1).max(MATH_MAX_PROBLEMS).default(3),
});
export type MathConfig = z.infer<typeof mathConfigSchema>;

export const defaultMathConfig: MathConfig = { difficulty: 'easy', problemCount: 3 };

export interface MathProblem {
  prompt: string;
  /** Always a positive integer. */
  answer: number;
}

/** Small seedable PRNG (mulberry32). Returns floats in [0, 1). */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const int = (rng: Rng, min: number, max: number) => min + Math.floor(rng() * (max - min + 1));

function makeProblem(difficulty: MathDifficulty, rng: Rng): MathProblem {
  const pickSecond = rng() < 0.5;
  switch (difficulty) {
    case 'easy': {
      const a = int(rng, 11, 49);
      const b = int(rng, 11, 49);
      return pickSecond
        ? { prompt: `${a + b} − ${b}`, answer: a }
        : { prompt: `${a} + ${b}`, answer: a + b };
    }
    case 'medium': {
      if (pickSecond) {
        const a = int(rng, 6, 12);
        const b = int(rng, 6, 12);
        return { prompt: `${a} × ${b}`, answer: a * b };
      }
      const a = int(rng, 120, 899);
      const b = int(rng, 120, 899);
      return { prompt: `${a} + ${b}`, answer: a + b };
    }
    case 'hard': {
      if (pickSecond) {
        const a = int(rng, 13, 29);
        const b = int(rng, 6, 19);
        return { prompt: `${a} × ${b}`, answer: a * b };
      }
      const a = int(rng, 6, 15);
      const b = int(rng, 6, 15);
      const c = int(rng, 11, 99);
      return { prompt: `${a} × ${b} + ${c}`, answer: a * b + c };
    }
  }
}

/** Pure + seeded: the same (config, seed) always yields the same problems. */
export function generateMathProblems(config: MathConfig, seed: number): MathProblem[] {
  const rng = createRng(seed);
  const problems: MathProblem[] = [];
  const seen = new Set<string>();
  let guard = 0;
  while (problems.length < config.problemCount && guard++ < 200) {
    const problem = makeProblem(config.difficulty, rng);
    if (seen.has(problem.prompt)) continue;
    seen.add(problem.prompt);
    problems.push(problem);
  }
  return problems;
}

export type KeypadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'back';

/** Applies one keypad press to the answer being typed. Digits only, no leading zeros. */
export function applyKeypadKey(input: string, key: KeypadKey): string {
  if (key === 'back') return input.slice(0, -1);
  if (input.length >= MATH_MAX_INPUT_LENGTH) return input;
  if (input === '0') return key;
  return input + key;
}

export function isMathAnswerCorrect(problem: MathProblem, input: string): boolean {
  return input !== '' && Number(input) === problem.answer;
}
