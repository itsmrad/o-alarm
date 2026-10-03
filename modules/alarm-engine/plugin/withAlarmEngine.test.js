const fs = require('fs');
const path = require('path');

const { androidSoundResourceName } = require('./withAlarmEngine');
const { SOUND_OPTIONS } = require('../../../src/features/alarms/sounds');

describe('alarm-engine config plugin: custom sounds', () => {
  it('sanitizes res/raw names exactly like CustomSounds.resourceName (Kotlin)', () => {
    expect(androidSoundResourceName('classic')).toBe('classic');
    expect(androidSoundResourceName('classic.wav')).toBe('classic');
    expect(androidSoundResourceName('Morning-Bell.WAV')).toBe('morning_bell');
    expect(androidSoundResourceName('8bit')).toBe('s_8bit');
    expect(androidSoundResourceName('_hidden')).toBe('s__hidden');
    expect(androidSoundResourceName('.wav')).toBe('s__wav');
  });

  it('every custom sound the editor offers is bundled from assets/sounds', () => {
    const bundled = fs
      .readdirSync(path.resolve(__dirname, '../../../assets/sounds'))
      .map((file) => path.parse(file).name);
    const custom = SOUND_OPTIONS.filter((option) => option.sound.kind === 'custom').map(
      (option) => option.sound.id,
    );
    expect(custom.length).toBeGreaterThan(0);
    for (const id of custom) expect(bundled).toContain(id);
  });
});

describe('alarm-engine config plugin: direct boot guard', () => {
  const { addDirectBootGuard } = require('./withAlarmEngine');
  const mainApplication = [
    'class MainApplication : Application(), ReactApplication {',
    '  override fun onCreate() {',
    '    super.onCreate()',
    '    loadReactNative(this)',
    '    ApplicationLifecycleDispatcher.onApplicationCreate(this)',
    '  }',
    '}',
  ].join('\n');

  it('defers RN/Expo init until unlock, right after super.onCreate(), once', () => {
    const patched = addDirectBootGuard(mainApplication, 'kt');
    const lines = patched.split('\n');
    const guard = lines.findIndex((line) => line.includes('DirectBoot.deferUntilUnlocked'));
    expect(lines[guard - 3]).toBe('    super.onCreate()');
    expect(lines[guard]).toBe(
      '    if (com.oalarm.alarmengine.DirectBoot.deferUntilUnlocked(this) { onCreate() }) return',
    );
    expect(guard).toBeLessThan(lines.findIndex((line) => line.includes('loadReactNative')));
    expect(addDirectBootGuard(patched, 'kt')).toBe(patched);
  });

  it('fails the build loudly instead of shipping without the guard', () => {
    expect(() => addDirectBootGuard('public class MainApplication {}', 'java')).toThrow(
      /direct-boot guard/,
    );
  });
});
