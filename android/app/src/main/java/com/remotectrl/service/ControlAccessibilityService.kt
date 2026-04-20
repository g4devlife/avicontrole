package com.remotectrl.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.media.AudioManager
import android.os.Looper
import android.os.PowerManager
import android.view.KeyEvent
import android.util.Log
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.annotation.RequiresApi
import com.remotectrl.webrtc.WebRTCManager
import org.json.JSONArray
import org.json.JSONObject

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

    // Geste en cours (down → move* → up)
    private var activePath: Path? = null
    private var gestureStartTime: Long = 0

    // Cache des champs de saisie détectés (bounds pour pouvoir les tapper)
    private val cachedFieldBounds = mutableListOf<Rect>()

    // Debounce pour le scan des champs (600 ms après le dernier événement)
    private val fieldScanHandler  = Handler(Looper.getMainLooper())
    private val fieldScanRunnable = Runnable { scanAndEmitFields() }

    override fun onServiceConnected() {
        instance = this
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        val metrics = resources.displayMetrics
        screenWidth  = metrics.widthPixels
        screenHeight = metrics.heightPixels
        Log.i(TAG, "Service connecté — écran ${screenWidth}x${screenHeight}")
    }

    override fun onDestroy() {
        fieldScanHandler.removeCallbacks(fieldScanRunnable)
        instance = null
        super.onDestroy()
    }

    // ──────────────────────────────────────────
    //  Scan des champs à chaque changement d'écran
    // ──────────────────────────────────────────

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        when (event.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
            AccessibilityEvent.TYPE_VIEW_FOCUSED,
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> {
                fieldScanHandler.removeCallbacks(fieldScanRunnable)
                fieldScanHandler.postDelayed(fieldScanRunnable, 600L)
            }
        }
    }

    override fun onInterrupt() {}

    private fun scanAndEmitFields() {
        val root = rootInActiveWindow ?: return
        val fields = JSONArray()
        cachedFieldBounds.clear()
        try {
            collectEditableNodes(root, fields)
        } finally {
            root.recycle()
        }
        WebRTCManager.getInstance(this).emitInputFields(fields)
    }

    private fun collectEditableNodes(node: AccessibilityNodeInfo, out: JSONArray) {
        if (node.isEditable) {
            val bounds = Rect()
            node.getBoundsInScreen(bounds)
            cachedFieldBounds.add(Rect(bounds))
            out.put(JSONObject().apply {
                put("id",      out.length())
                put("text",    node.text?.toString() ?: "")
                put("hint",    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                                   node.hintText?.toString() ?: "" else "")
                put("type",    if (node.isPassword) "password" else "text")
                put("focused", node.isFocused)
            })
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            collectEditableNodes(child, out)
            child.recycle()
        }
    }

    // ──────────────────────────────────────────
    //  Dispatch des commandes du desktop
    // ──────────────────────────────────────────

    fun handleEvent(json: JSONObject) {
        ScreenCaptureService.refreshOverlay()
        when (json.optString("type")) {
            "touch"              -> handleTouch(json)
            "longpress"          -> handleLongPress(json)
            "scroll"             -> handleScroll(json)
            "pinch"              -> handlePinch(json)
            "text"               -> handleText(json)
            "key"                -> handleKey(json)
            "paste"              -> handlePaste(json.optString("content", ""))
            "field:set"          -> handleFieldSet(json)
            "back"               -> performGlobalAction(GLOBAL_ACTION_BACK)
            "home"               -> performGlobalAction(GLOBAL_ACTION_HOME)
            "recents"            -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            "notifications"      -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
            "lock"               -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
                                        performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)
            "screenshot"         -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
                                        performGlobalAction(GLOBAL_ACTION_TAKE_SCREENSHOT)
            "screen_wake",
            "screen:wake"        -> handleScreenWake()
            "volume:up"      -> adjustVolume(AudioManager.ADJUST_RAISE)
            "volume:down"    -> adjustVolume(AudioManager.ADJUST_LOWER)
            "volume:mute"    -> adjustVolume(AudioManager.ADJUST_TOGGLE_MUTE)
            "media:play"     -> dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)
            "media:next"     -> dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_NEXT)
            "media:prev"     -> dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_PREVIOUS)
            "media:stop"     -> dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_STOP)
            "quick:settings" -> handleQuickSettings()
            else                 -> Log.w(TAG, "Événement inconnu: ${json.optString("type")}")
        }
    }

    // ──────────────────────────────────────────
    //  Réveil de l'écran
    // ──────────────────────────────────────────

    @Suppress("DEPRECATION")
    private fun handleScreenWake() {
        try {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            val wl = pm.newWakeLock(
                PowerManager.FULL_WAKE_LOCK or
                PowerManager.ACQUIRE_CAUSES_WAKEUP or
                PowerManager.ON_AFTER_RELEASE,
                "Controle:ScreenWake"
            )
            wl.acquire(3_000L)   // Auto-libération après 3 s — NE PAS appeler release()
            Log.i(TAG, "wakeScreen: écran allumé")
        } catch (e: Exception) {
            Log.e(TAG, "wakeScreen error: ${e.message}")
        }
    }

    // ──────────────────────────────────────────
    //  Remplissage d'un champ depuis le desktop
    // ──────────────────────────────────────────

    private fun handleFieldSet(json: JSONObject) {
        val id   = json.optInt("id", -1)
        val text = json.optString("content", "")
        if (id < 0 || id >= cachedFieldBounds.size) return

        val bounds = cachedFieldBounds[id]
        val cx = bounds.centerX().toFloat()
        val cy = bounds.centerY().toFloat()

        // 1. Tapper le champ pour le focus
        val path   = Path().apply { moveTo(cx, cy) }
        val stroke = GestureDescription.StrokeDescription(path, 0L, 100L)
        dispatchGesture(
            GestureDescription.Builder().addStroke(stroke).build(),
            object : GestureResultCallback() {
                override fun onCompleted(gd: GestureDescription) {
                    // 2. Après 350 ms → injecter le texte dans le champ focalisé
                    Handler(Looper.getMainLooper()).postDelayed({
                        val root    = rootInActiveWindow ?: return@postDelayed
                        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
                        focused?.let { node ->
                            val args = Bundle()
                            args.putCharSequence(
                                AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text
                            )
                            node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
                            node.recycle()
                        }
                        root.recycle()
                    }, 350L)
                }
            }, null
        )
    }

    // ──────────────────────────────────────────
    //  Touch (tap / swipe)
    // ──────────────────────────────────────────

    private fun handleTouch(json: JSONObject) {
        val x      = (json.optDouble("x", 0.0) * screenWidth).toFloat()
        val y      = (json.optDouble("y", 0.0) * screenHeight).toFloat()
        val action = json.optString("action", "down")

        when (action) {
            "down" -> {
                activePath      = Path().apply { moveTo(x, y) }
                gestureStartTime = System.currentTimeMillis()
            }
            "move" -> activePath?.lineTo(x, y)
            "up"   -> {
                activePath?.lineTo(x, y)
                val duration = System.currentTimeMillis() - gestureStartTime
                val stroke   = GestureDescription.StrokeDescription(
                    activePath!!, 0L, duration.coerceAtLeast(10L)
                )
                dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
                activePath = null
            }
        }
    }

    private fun handleLongPress(json: JSONObject) {
        val x    = (json.optDouble("x", 0.0) * screenWidth).toFloat()
        val y    = (json.optDouble("y", 0.0) * screenHeight).toFloat()
        val path = Path().apply { moveTo(x, y) }
        dispatchGesture(
            GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path, 0L, 800L))
                .build(), null, null
        )
    }

    // ──────────────────────────────────────────
    //  Scroll et Pinch
    // ──────────────────────────────────────────

    private fun handleScroll(json: JSONObject) {
        val x  = (json.optDouble("x", 0.5) * screenWidth).toFloat()
        val y  = (json.optDouble("y", 0.5) * screenHeight).toFloat()
        val dx = json.optDouble("dx", 0.0).toFloat() * screenWidth
        val dy = json.optDouble("dy", 0.0).toFloat() * screenHeight
        val path = Path().apply { moveTo(x, y); lineTo(x + dx, y + dy) }
        dispatchGesture(
            GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path, 0L, 250L))
                .build(), null, null
        )
    }

    private fun handlePinch(json: JSONObject) {
        val x     = (json.optDouble("x", 0.5) * screenWidth).toFloat()
        val y     = (json.optDouble("y", 0.5) * screenHeight).toFloat()
        val scale = json.optDouble("scale", 1.0).toFloat()
        val d     = 200f
        val path1 = Path().apply { moveTo(x - d, y - d); lineTo(x - d * scale, y - d * scale) }
        val path2 = Path().apply { moveTo(x + d, y + d); lineTo(x + d * scale, y + d * scale) }
        dispatchGesture(
            GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path1, 0L, 400L))
                .addStroke(GestureDescription.StrokeDescription(path2, 0L, 400L))
                .build(), null, null
        )
    }

    // ──────────────────────────────────────────
    //  Texte et clavier
    // ──────────────────────────────────────────

    private fun handleText(json: JSONObject) {
        val content = json.optString("content", "")
        val root    = rootInActiveWindow ?: return
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        focused?.let { node ->
            val args = Bundle()
            args.putCharSequence(
                AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                (node.text?.toString() ?: "") + content
            )
            node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
            node.recycle()
        }
        root.recycle()
    }

    private fun handleKey(json: JSONObject) {
        val root    = rootInActiveWindow ?: return
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        focused?.let { node ->
            when (json.optString("keyCode")) {
                "backspace" -> {
                    val current = node.text?.toString() ?: ""
                    if (current.isNotEmpty()) {
                        val args = Bundle()
                        args.putCharSequence(
                            AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                            current.dropLast(1)
                        )
                        node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
                    }
                }
                "enter" -> node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            }
            node.recycle()
        }
        root.recycle()
    }

    fun handlePaste(content: String) {
        if (content.isEmpty()) return
        val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("paste", content))
        val root    = rootInActiveWindow ?: return
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        focused?.let { node ->
            node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
            node.recycle()
        }
        root.recycle()
    }

    fun getSelectedText(): String {
        val root    = rootInActiveWindow ?: return ""
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            ?: run { root.recycle(); return "" }
        val text  = focused.text?.toString() ?: ""
        val start = focused.textSelectionStart
        val end   = focused.textSelectionEnd
        focused.recycle()
        root.recycle()
        return if (start >= 0 && end > start)
            text.substring(start.coerceAtMost(text.length), end.coerceAtMost(text.length))
        else text
    }

    // ──────────────────────────────────────────
    //  Volume
    // ──────────────────────────────────────────
    private fun adjustVolume(direction: Int) {
        val am = getSystemService(AUDIO_SERVICE) as AudioManager
        am.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, AudioManager.FLAG_SHOW_UI)
    }

    // ──────────────────────────────────────────
    //  Média (play/next/prev/stop)
    // ──────────────────────────────────────────
    private fun dispatchMediaKey(keyCode: Int) {
        val am = getSystemService(AUDIO_SERVICE) as AudioManager
        am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
        am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP,   keyCode))
    }

    // ──────────────────────────────────────────
    //  Paramètres rapides (swipe depuis le haut)
    // ──────────────────────────────────────────
    private fun handleQuickSettings() {
        // Double swipe from top: first to notif shade, then to quick settings
        val cx    = screenWidth / 2f
        val path  = Path().apply {
            moveTo(cx, 10f)
            lineTo(cx, screenHeight * 0.55f)
        }
        val stroke = GestureDescription.StrokeDescription(path, 0L, 500L)
        dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }
}
