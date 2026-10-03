const fs = require('fs');
const path = require('path');
const {
  IOSConfig,
  withDangerousMod,
  withInfoPlist,
  withMainApplication,
  withXcodeProject,
} = require('expo/config-plugins');

const DEFAULT_ALARMKIT_USAGE =
  'O-Alarm schedules your alarms with the system so they ring even in Silent mode and Focus.';

/** Bundled alarm sounds: `assets/sounds/<id>.<ext>` ↔ `AlarmScheduleSpec.sound {kind:'custom', id}`. */
const DEFAULT_SOUNDS_DIR = 'assets/sounds';
const SOUND_EXTENSIONS = new Set(['.wav', '.caf', '.aiff', '.aif', '.m4a', '.mp3']);

/**
 * Android `res/raw` name for a custom sound id. Must match `CustomSounds.resourceName`
 * (Kotlin): extension dropped, lowercase, anything outside [a-z0-9_] → `_`, and a leading
 * non-letter prefixed with `s_` (resource names must start with a letter).
 */
function androidSoundResourceName(id) {
  const dot = id.lastIndexOf('.');
  const base = (dot > 0 ? id.slice(0, dot) : id).toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return /^[a-z]/.test(base) ? base : `s_${base}`;
}

/** Sound files in `soundsDir` (sorted, so prebuild output is stable). Missing dir → none. */
function listSoundFiles(projectRoot, soundsDir) {
  const dir = path.resolve(projectRoot, soundsDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => SOUND_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .sort()
    .map((file) => path.join(dir, file));
}

/** Android: copy each sound to `app/src/main/res/raw/<sanitized>.<ext>` (RingingService resolves it). */
function withAndroidAlarmSounds(config, soundsDir) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const rawDir = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/res/raw');
      const seen = new Map();
      for (const source of listSoundFiles(cfg.modRequest.projectRoot, soundsDir)) {
        const name = androidSoundResourceName(path.basename(source));
        if (seen.has(name)) {
          throw new Error(
            `[alarm-engine] Sounds "${seen.get(name)}" and "${path.basename(source)}" both map to res/raw/${name}; rename one.`,
          );
        }
        seen.set(name, path.basename(source));
        fs.mkdirSync(rawDir, { recursive: true });
        fs.copyFileSync(source, path.join(rawDir, `${name}${path.extname(source).toLowerCase()}`));
      }
      return cfg;
    },
  ]);
}

/**
 * iOS: copy each sound next to the app sources and add it to the app target's resources, so
 * it lands in the main bundle where `AlertSound.named(<id>.<ext>)` finds it (AlarmKit also
 * looks in Library/Sounds; the bundle needs no runtime copy).
 */
function withIosAlarmSounds(config, soundsDir) {
  return withXcodeProject(config, (cfg) => {
    const { projectRoot, projectName } = cfg.modRequest;
    if (!projectName) throw new Error('[alarm-engine] Unable to find the iOS project name.');
    const sourceRoot = IOSConfig.Paths.getSourceRoot(projectRoot);
    let project = cfg.modResults;
    for (const source of listSoundFiles(projectRoot, soundsDir)) {
      const fileName = path.basename(source);
      fs.copyFileSync(source, path.join(sourceRoot, fileName));
      if (!project.hasFile(`${projectName}/${fileName}`)) {
        project = IOSConfig.XcodeUtils.addResourceFileToGroup({
          filepath: `${projectName}/${fileName}`,
          groupName: projectName,
          isBuildFile: true,
          project,
        });
      }
    }
    cfg.modResults = project;
    return cfg;
  });
}

const DIRECT_BOOT_MARKER = 'com.oalarm.alarmengine.DirectBoot';
const ON_CREATE = /(override fun onCreate\(\) \{\n(\s*)super\.onCreate\(\)\n)/;

/**
 * Android direct boot: `LOCKED_BOOT_COMPLETED` starts the process before the first unlock.
 * Guard `MainApplication.onCreate` so React Native / Expo init (credential-encrypted
 * storage) waits for the unlock while the engine's receivers re-arm alarms from
 * device-protected storage. See DirectBoot.kt.
 */
function addDirectBootGuard(contents, language) {
  if (contents.includes(DIRECT_BOOT_MARKER)) return contents;
  if (language !== 'kt' || !ON_CREATE.test(contents)) {
    throw new Error(
      '[alarm-engine] Could not add the direct-boot guard: MainApplication.kt has no ' +
        '`override fun onCreate() { super.onCreate()`. Update plugin/withAlarmEngine.js.',
    );
  }
  return contents.replace(
    ON_CREATE,
    (_, head, indent) =>
      `${head}${indent}// alarm-engine: before the first unlock only the native alarm engine runs; RN/Expo\n` +
      `${indent}// init touches credential-encrypted storage, so it resumes on ACTION_USER_UNLOCKED.\n` +
      `${indent}if (${DIRECT_BOOT_MARKER}.deferUntilUnlocked(this) { onCreate() }) return\n`,
  );
}

function withDirectBootGuard(config) {
  return withMainApplication(config, (cfg) => {
    cfg.modResults.contents = addDirectBootGuard(
      cfg.modResults.contents,
      cfg.modResults.language,
    );
    return cfg;
  });
}

/**
 * iOS: AlarmKit usage string (D4). AlarmKit refuses to schedule if it is missing or empty,
 * so an empty override falls back to the default. No entitlement or background mode is
 * needed: AlarmKit alerts and the engine's App Intents work with just this key.
 *
 * Android: guards `MainApplication.onCreate` for direct boot (see addDirectBootGuard).
 *
 * Both platforms: bundles the custom alarm sounds from `soundsDir` (default
 * `assets/sounds`). A sound that isn't bundled still rings with the default alarm sound and
 * shows a readiness warning (never silent).
 *
 * Android permissions, receivers, the ringing service and activity live in the module's
 * AndroidManifest.xml and are merged into the app manifest at build time.
 */
function withAlarmEngine(
  config,
  { alarmKitUsageDescription = DEFAULT_ALARMKIT_USAGE, soundsDir = DEFAULT_SOUNDS_DIR } = {},
) {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.NSAlarmKitUsageDescription =
      typeof alarmKitUsageDescription === 'string' && alarmKitUsageDescription.trim()
        ? alarmKitUsageDescription
        : DEFAULT_ALARMKIT_USAGE;
    return cfg;
  });
  config = withAndroidAlarmSounds(config, soundsDir);
  config = withDirectBootGuard(config);
  return withIosAlarmSounds(config, soundsDir);
}

module.exports = withAlarmEngine;
module.exports.androidSoundResourceName = androidSoundResourceName;
module.exports.addDirectBootGuard = addDirectBootGuard;
