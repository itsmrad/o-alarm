import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import {
  applyKeypadKey,
  generateMathProblems,
  isMathAnswerCorrect,
  type KeypadKey,
  type MathConfig,
} from '@/domain/missions-math';

import { missionHaptics } from './haptics';
import { Keypad } from './keypad';
import type { MissionViewProps } from './types';

export function MathMission({ config, seed, onComplete }: MissionViewProps<MathConfig>) {
  const problems = useMemo(() => generateMathProblems(config, seed), [config, seed]);
  const [index, setIndex] = useState(0);
  const [input, setInput] = useState('');
  const [wrong, setWrong] = useState(false);

  const problem = problems[index];
  if (!problem) return null;

  const submit = () => {
    if (!isMathAnswerCorrect(problem, input)) {
      missionHaptics.error();
      setWrong(true);
      setInput('');
      return;
    }
    missionHaptics.tap();
    setWrong(false);
    setInput('');
    if (index + 1 >= problems.length) onComplete();
    else setIndex(index + 1);
  };

  return (
    <View className="flex-1 justify-between gap-4">
      <View className="items-center gap-3 pt-2">
        <Text className="text-headline text-foreground-muted">
          Problem {index + 1} of {problems.length}
        </Text>
        <Text
          accessibilityRole="header"
          className="text-[52px] font-bold leading-[60px] text-foreground"
          style={{ fontVariant: ['tabular-nums'] }}
        >
          {problem.prompt}
        </Text>
        <View
          accessibilityLabel={input ? `Your answer ${input}` : 'Your answer is empty'}
          className={`min-h-[72px] w-full items-center justify-center rounded-card border-2 bg-surface px-4 ${
            wrong ? 'border-danger' : 'border-border'
          }`}
        >
          <Text
            className="text-[44px] font-bold text-foreground"
            style={{ fontVariant: ['tabular-nums'] }}
          >
            {input || ' '}
          </Text>
        </View>
        <Text
          accessibilityLiveRegion="polite"
          className={`min-h-[22px] text-headline text-danger ${wrong ? '' : 'opacity-0'}`}
        >
          Not quite — try again
        </Text>
      </View>
      <Keypad
        onKey={(key: KeypadKey) => {
          setWrong(false);
          setInput((current) => applyKeypadKey(current, key));
        }}
        onSubmit={submit}
        canSubmit={input.length > 0}
      />
    </View>
  );
}
