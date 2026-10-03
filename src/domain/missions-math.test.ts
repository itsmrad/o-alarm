import {
  applyKeypadKey,
  createRng,
  generateMathProblems,
  isMathAnswerCorrect,
  MATH_DIFFICULTIES,
  mathConfigSchema,
  type MathDifficulty,
} from './missions-math';

describe('createRng', () => {
  it('is deterministic per seed and stays in [0, 1)', () => {
    const a = createRng(42);
    const b = createRng(42);
    const values = Array.from({ length: 50 }, () => a());
    expect(values).toEqual(Array.from({ length: 50 }, () => b()));
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(createRng(43)()).not.toBe(createRng(42)());
  });
});

describe('generateMathProblems', () => {
  it('is pure: same config + seed gives the same problems', () => {
    const config = mathConfigSchema.parse({ difficulty: 'hard', problemCount: 5 });
    expect(generateMathProblems(config, 7)).toEqual(generateMathProblems(config, 7));
    expect(generateMathProblems(config, 7)).not.toEqual(generateMathProblems(config, 8));
  });

  it.each(MATH_DIFFICULTIES)('%s: N distinct problems with positive integer answers', (d) => {
    for (let seed = 0; seed < 200; seed++) {
      const problems = generateMathProblems({ difficulty: d, problemCount: 6 }, seed);
      expect(problems).toHaveLength(6);
      expect(new Set(problems.map((p) => p.prompt)).size).toBe(6);
      for (const p of problems) {
        expect(Number.isInteger(p.answer)).toBe(true);
        expect(p.answer).toBeGreaterThan(0);
      }
    }
  });

  it('computes answers that match the prompt', () => {
    const evaluate = (prompt: string) => {
      const tokens = prompt.replace(/−/g, '-').replace(/×/g, '*');
      return Function(`"use strict"; return (${tokens})`)() as number;
    };
    for (const d of MATH_DIFFICULTIES) {
      for (let seed = 0; seed < 100; seed++) {
        for (const p of generateMathProblems({ difficulty: d, problemCount: 3 }, seed)) {
          expect(evaluate(p.prompt)).toBe(p.answer);
        }
      }
    }
  });

  it('gets harder: larger answers on average', () => {
    const avg = (d: MathDifficulty) => {
      const answers = Array.from({ length: 100 }, (_, seed) =>
        generateMathProblems({ difficulty: d, problemCount: 3 }, seed).map((p) => p.answer),
      ).flat();
      return answers.reduce((s, n) => s + n, 0) / answers.length;
    };
    expect(avg('medium')).toBeGreaterThan(avg('easy'));
    expect(avg('hard')).toBeGreaterThan(avg('easy'));
  });

  it('config defaults and bounds', () => {
    expect(mathConfigSchema.parse({})).toEqual({ difficulty: 'easy', problemCount: 3 });
    expect(mathConfigSchema.safeParse({ problemCount: 0 }).success).toBe(false);
    expect(mathConfigSchema.safeParse({ difficulty: 'nope' }).success).toBe(false);
  });
});

describe('keypad', () => {
  it('appends digits, supports backspace, no leading zeros, bounded length', () => {
    expect(applyKeypadKey('', '0')).toBe('0');
    expect(applyKeypadKey('0', '5')).toBe('5');
    expect(applyKeypadKey('12', '3')).toBe('123');
    expect(applyKeypadKey('123', 'back')).toBe('12');
    expect(applyKeypadKey('', 'back')).toBe('');
    expect(applyKeypadKey('123456', '7')).toBe('123456');
  });

  it('checks answers; empty input is never correct', () => {
    expect(isMathAnswerCorrect({ prompt: '1 + 1', answer: 2 }, '2')).toBe(true);
    expect(isMathAnswerCorrect({ prompt: '1 + 1', answer: 2 }, '3')).toBe(false);
    expect(isMathAnswerCorrect({ prompt: '1 + 1', answer: 2 }, '')).toBe(false);
  });
});
