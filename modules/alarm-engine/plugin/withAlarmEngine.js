const { withInfoPlist } = require('expo/config-plugins');

const DEFAULT_ALARMKIT_USAGE =
  'O-Alarm schedules your alarms with the system so they ring even in Silent mode and Focus.';

/**
 * iOS: AlarmKit usage string (D4). Android needs no app-level changes: permissions,
 * receivers, the ringing service and activity live in the module's AndroidManifest.xml
 * and are merged into the app manifest at build time.
 */
function withAlarmEngine(config, { alarmKitUsageDescription = DEFAULT_ALARMKIT_USAGE } = {}) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.NSAlarmKitUsageDescription = alarmKitUsageDescription;
    return cfg;
  });
}

module.exports = withAlarmEngine;
