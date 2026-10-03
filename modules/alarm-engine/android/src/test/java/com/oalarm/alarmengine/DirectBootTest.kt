package com.oalarm.alarmengine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DirectBootTest {
  private class FakeUser(var unlocked: Boolean) {
    var onUnlock: (() -> Unit)? = null
    var registered = 0
    var unregistered = 0

    fun register(listener: () -> Unit): () -> Unit {
      registered++
      onUnlock = listener
      return { unregistered++ }
    }

    fun unlock() {
      unlocked = true
      onUnlock?.invoke()
    }
  }

  @Test fun unlockedRunsTheAppInitNormally() {
    val user = FakeUser(unlocked = true)
    var inits = 0
    assertFalse(DirectBoot.deferUntilUnlocked({ user.unlocked }, user::register) { inits++ })
    assertEquals(0, user.registered)
    assertEquals(0, inits)
  }

  @Test fun lockedDefersTheAppInitToTheFirstUnlockOnce() {
    val user = FakeUser(unlocked = false)
    var inits = 0
    assertTrue(DirectBoot.deferUntilUnlocked({ user.unlocked }, user::register) { inits++ })
    assertEquals(0, inits) // nothing touches credential-encrypted storage while locked
    user.unlock()
    user.onUnlock?.invoke() // a duplicate broadcast never re-runs the init
    assertEquals(1, inits)
    assertEquals(1, user.unregistered)
  }

  @Test fun anUnlockRacingTheRegistrationRunsTheInitInline() {
    var checks = 0
    var unregistered = 0
    var inits = 0
    val deferred = DirectBoot.deferUntilUnlocked(
      isUnlocked = { checks++ > 0 }, // locked at the check, unlocked right after
      register = { { unregistered++ } },
      init = { inits++ },
    )
    assertFalse(deferred)
    assertEquals(1, unregistered)
    assertEquals(0, inits) // the caller continues its normal init
  }

  // The LOCKED_BOOT_COMPLETED restore itself: AlarmEngineCoreTest.bootRestoreReArmsTheMirrorWithoutJs.
}
