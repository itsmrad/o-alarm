package com.oalarm.alarmengine

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * The native mirror (D10): schedules, the ringing alarm, the observed-event log and small
 * counters, in one JSON file written atomically. The engine creates it in device-protected
 * storage so LOCKED_BOOT_COMPLETED can restore alarms before the first unlock.
 *
 * Not thread-safe by itself; [AlarmEngineCore] serializes all access.
 */
class AlarmStore(private val file: File) {
  val schedules = LinkedHashMap<String, ScheduledEntry>()
  var ringing: RingingRecord? = null

  /** Alarms that fired while another one was ringing (rung in order, never dropped). */
  val pendingRings = ArrayList<RingingRecord>()
  val events = ArrayList<ObservedEvent>()

  /** Snoozes used per occurrenceKey. */
  val snoozeCounts = HashMap<String, Int>()

  /** Wake-check attempts per occurrenceKey. */
  val wakeCheckAttempts = HashMap<String, Int>()

  /** Device zone at the last restore, to detect zone changes. */
  var lastZone: String? = null

  /** Set when the file existed but could not be parsed (reported once by the engine). */
  var loadError: String? = null
    private set

  init {
    load()
  }

  private fun load() {
    if (!file.exists()) return
    try {
      val root = JSONObject(file.readText())
      root.optJSONArray("schedules")?.forEachObject { ScheduledEntry.fromJson(it).let { e -> schedules[e.spec.id] = e } }
      ringing = root.optJSONObject("ringing")?.let { RingingRecord.fromJson(it) }
      root.optJSONArray("pendingRings")?.forEachObject { pendingRings.add(RingingRecord.fromJson(it)) }
      root.optJSONArray("events")?.forEachObject { events.add(ObservedEvent.fromJson(it)) }
      root.optJSONObject("snoozeCounts")?.let { o -> o.keys().forEach { snoozeCounts[it] = o.getInt(it) } }
      root.optJSONObject("wakeCheckAttempts")?.let { o -> o.keys().forEach { wakeCheckAttempts[it] = o.getInt(it) } }
      lastZone = if (root.isNull("lastZone")) null else root.getString("lastZone")
    } catch (e: Exception) {
      // Keep the unreadable file for diagnosis and start empty; JS reconcile re-schedules.
      loadError = e.message ?: e.javaClass.simpleName
      schedules.clear()
      ringing = null
      pendingRings.clear()
      events.clear()
      snoozeCounts.clear()
      wakeCheckAttempts.clear()
      file.renameTo(File(file.parentFile, file.name + ".corrupt"))
    }
  }

  fun save() {
    val root = JSONObject().apply {
      put("version", 1)
      put("schedules", JSONArray().apply { schedules.values.forEach { put(it.toJson()) } })
      put("ringing", ringing?.toJson() ?: JSONObject.NULL)
      put("pendingRings", JSONArray().apply { pendingRings.forEach { put(it.toJson()) } })
      put("events", JSONArray().apply { events.forEach { put(it.toJson()) } })
      put("snoozeCounts", JSONObject(snoozeCounts as Map<*, *>))
      put("wakeCheckAttempts", JSONObject(wakeCheckAttempts as Map<*, *>))
      put("lastZone", lastZone ?: JSONObject.NULL)
    }
    file.parentFile?.mkdirs()
    val tmp = File(file.parentFile, file.name + ".tmp")
    tmp.writeText(root.toString())
    Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
  }

  fun appendEvent(event: ObservedEvent) {
    events.add(event)
    while (events.size > MAX_EVENTS) events.removeAt(0)
  }

  /** Drops per-occurrence counters nothing refers to any more. */
  fun pruneCounters() {
    val live = HashSet<String>()
    schedules.values.forEach { live.add(it.spec.occurrenceKey) }
    ringing?.let { live.add(it.spec.occurrenceKey) }
    pendingRings.forEach { live.add(it.spec.occurrenceKey) }
    snoozeCounts.keys.retainAll(live)
    wakeCheckAttempts.keys.retainAll(live)
  }

  companion object {
    const val MAX_EVENTS = 500
  }
}

private inline fun JSONArray.forEachObject(block: (JSONObject) -> Unit) {
  for (i in 0 until length()) block(getJSONObject(i))
}
