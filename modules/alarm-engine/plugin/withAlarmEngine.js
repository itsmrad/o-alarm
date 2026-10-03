const { withInfoPlist } = require('expo/config-plugins');

const DEFAULT_ALARMKIT_USAGE =
  'O-Alarm schedules your alarms with the system so they ring even in Silent mode and Focus.';

/**
 * iOS: AlarmKit usage string (D4). AlarmKit refuses to schedule if it is missing or empty,
 * so an empty override falls back to the default. No entitlement or background mode is
 * needed: AlarmKit alerts and the engine's App Intents work with just this key.
 *
 * Android needs no app-level changes: permissions, receivers, the ringing service and
 * activity live in the module's AndroidManifest.xml and are merged into the app manifest
 * at build time.
 */
function withAlarmEngine(config, { alarmKitUsageDescription = DEFAULT_ALARMKIT_USAGE } = {}) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.NSAlarmKitUsageDescription =
      typeof alarmKitUsageDescription === 'string' && alarmKitUsageDescription.trim()
        ? alarmKitUsageDescription
        : DEFAULT_ALARMKIT_USAGE;
    return cfg;
  });
}

module.exports = withAlarmEngine;
