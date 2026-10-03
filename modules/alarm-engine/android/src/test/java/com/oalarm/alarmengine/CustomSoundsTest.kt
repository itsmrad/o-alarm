package com.oalarm.alarmengine

import org.junit.Assert.assertEquals
import org.junit.Test

/** Same cases as plugin/withAlarmEngine.test.js: the plugin and the engine must agree. */
class CustomSoundsTest {
  @Test fun resourceNameMatchesTheConfigPlugin() {
    assertEquals("classic", CustomSounds.resourceName("classic"))
    assertEquals("classic", CustomSounds.resourceName("classic.wav"))
    assertEquals("morning_bell", CustomSounds.resourceName("Morning-Bell.WAV"))
    assertEquals("s_8bit", CustomSounds.resourceName("8bit"))
    assertEquals("s__hidden", CustomSounds.resourceName("_hidden"))
    assertEquals("s__wav", CustomSounds.resourceName(".wav"))
  }
}
