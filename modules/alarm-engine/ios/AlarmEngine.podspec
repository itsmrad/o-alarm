Pod::Spec.new do |s|
  s.name           = 'AlarmEngine'
  s.version        = '1.0.0'
  s.summary        = 'O-Alarm native alarm engine'
  s.description    = 'O-Alarm native alarm engine (AlarmKit, iOS 26+)'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '26.0'
  }
  s.source         = { git: '' }
  s.static_framework = true
  # Swift 5 language mode: AlarmKit/AppIntents types are used from an actor and intents;
  # concurrency safety is enforced by AlarmEngineCore's serialization, not strict checking.
  s.swift_version  = '5.9'
  s.frameworks     = 'AlarmKit', 'AppIntents', 'ActivityKit', 'SwiftUI', 'CryptoKit'

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
