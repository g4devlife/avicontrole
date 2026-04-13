package com.remotectrl.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Build
import android.util.Log
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import androidx.annotation.RequiresApi
import org.json.JSONObject

/**
 * Service d'accessibilité — reçoit les commandes du desktop
 * et les injecte comme gestes tactiles / touches Android.
 *
 * Doit être activé manuellement dans :
 *   Paramètres → Accessibilité → Remote Control → Activer
 */
@RequiresApi(Build.VERSION_CODES.N)
class ControlAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "ControlService"
        private var instance: ControlAccessibilityService? = null
        fun getInstance(): ControlAccessibilityService? = instance
    }

    private lateinit var windowManager: WindowManager
    private var screenWidth  = 0
    private var screenHeight = 0

    override fun onServiceConnected() {
        instance = this
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        val metrics = resources.displayMetrics
        screenWidth  = metrics.widthPixels
        screenHeight = metrics.heightPixels
        Log.i(TAG, "Service connecté — écran ${screenWidth}x${screenHeight}")
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    // ──────────────────────────────────────────
    //  Traitement des commandes reçues du desktop
    // ──────────────────────────────────────────

    fun handleEvent(json: JSONObject) {
        when (json.optString("type")) {
            "touch"   -> handleTouch(json)
            "scroll"  -> handleScroll(json)
            "back"    -> performGlobalAction(GLOBAL_ACTION_BACK)
            "home"    -> performGlobalAction(GLOBAL_ACTION_HOME)
            "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            else      -> Log.w(TAG, "Événement inconnu: ${json.optString("type")}")
        }
    }

    // ──────────────────────────────────────────
    //  Touch : down, move, up
    // ──────────────────────────────────────────

    private fun handleTouch(json: JSONObject) {
        // Coordonnées normalisées 0.0-1.0 → pixels
        val x = (json.optDouble("x", 0.0) * screenWidth).toFloat()
        val y = (json.optDouble("y", 0.0) * screenHeight).toFloat()
        val action = json.optString("action", "down")

        val path = Path().apply { moveTo(x, y) }

        val stroke = GestureDescription.StrokeDescription(
            path,
            0L,          // startTime
            when (action) {
                "down" -> 50L
                "move" -> 16L
                else   -> 50L
            },
            action != "up",  // willContinue si pas "up"
        )

        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        dispatchGesture(gesture, null, null)
    }

    // ──────────────────────────────────────────
    //  Scroll
    // ──────────────────────────────────────────

    private fun handleScroll(json: JSONObject) {
        val centerX = (screenWidth  / 2).toFloat()
        val centerY = (screenHeight / 2).toFloat()
        val dx = json.optDouble("dx", 0.0).toFloat()
        val dy = json.optDouble("dy", 0.0).toFloat()

        val path = Path().apply {
            moveTo(centerX, centerY)
            lineTo(centerX + dx * 50f, centerY + dy * 50f)
        }

        val stroke = GestureDescription.StrokeDescription(path, 0L, 300L)
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        dispatchGesture(gesture, null, null)
    }
}
