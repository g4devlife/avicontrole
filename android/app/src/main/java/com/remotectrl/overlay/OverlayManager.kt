package com.remotectrl.overlay

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout

/**
 * OverlayManager : Gère un voile de confidentialité robuste via WindowManager.
 * 
 * Cette implémentation répond aux contraintes suivantes :
 * - Toujours visible sur le téléphone (TYPE_APPLICATION_OVERLAY).
 * - Ne disparaît pas lors des changements de focus (FLAG_NOT_FOCUSABLE).
 * - Invisible dans le flux MediaProjection (via FLAG_SECURE).
 * - Maintenance active (Watchdog) pour garantir le Z-order.
 */
class OverlayManager(private val context: Context) {

    private val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private var overlayView: View? = null
    private val handler = Handler(Looper.getMainLooper())

    // Watchdog pour s'assurer que l'overlay reste attaché et au premier plan
    private val watchdogRunnable = object : Runnable {
        override fun run() {
            maintainOverlay()
            handler.postDelayed(this, 3000) // Vérification toutes les 3 secondes
        }
    }

    /**
     * Active le voile de confidentialité.
     */
    fun start() {
        showOverlay()
        handler.post(watchdogRunnable)
    }

    /**
     * Désactive le voile de confidentialité.
     */
    fun stop() {
        handler.removeCallbacks(watchdogRunnable)
        removeOverlay()
    }

    private fun showOverlay() {
        if (overlayView != null) return

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else
                @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_SYSTEM_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                    WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED or
                    // FLAG_SECURE exclut cette fenêtre des captures MediaProjection.
                    // Sur un voile plein écran, cela rendra le flux noir si l'overlay est opaque.
                    // Note: C'est la seule méthode "propre" (non-hack) pour exclure une vue du mirroring.
                    WindowManager.LayoutParams.FLAG_SECURE,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.FILL
            // On évite d'utiliser screenBrightness ici pour rester sur une solution purement logicielle
        }

        overlayView = FrameLayout(context).apply {
            setBackgroundColor(Color.BLACK)
        }

        try {
            windowManager.addView(overlayView, params)
            Log.i("OverlayManager", "Voile de confidentialité activé")
        } catch (e: Exception) {
            Log.e("OverlayManager", "Erreur lors de l'activation de l'overlay: ${e.message}")
        }
    }

    private fun removeOverlay() {
        overlayView?.let {
            try {
                windowManager.removeView(it)
                Log.i("OverlayManager", "Voile de confidentialité désactivé")
            } catch (e: Exception) {
                Log.e("OverlayManager", "Erreur lors du retrait de l'overlay: ${e.message}")
            } finally {
                overlayView = null
            }
        }
    }

    /**
     * Rafraîchit l'overlay pour s'assurer qu'il reste au premier plan.
     */
    fun maintainOverlay() {
        val view = overlayView ?: return
        if (!view.isAttachedToWindow) {
            Log.w("OverlayManager", "Overlay détaché anormalement, restauration...")
            overlayView = null
            showOverlay()
        } else {
            // Forcer le rafraîchissement du layout pour maintenir le Z-order au-dessus des nouvelles fenêtres
            try {
                windowManager.updateViewLayout(view, view.layoutParams)
            } catch (e: Exception) {}
        }
    }
}
