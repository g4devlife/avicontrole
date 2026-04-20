package com.remotectrl.service

import android.app.*
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import com.remotectrl.app.R
import com.remotectrl.overlay.OverlayManager
import com.remotectrl.ui.MainActivity
import com.remotectrl.webrtc.WebRTCManager

class ScreenCaptureService : Service() {

    companion object {
        const val TAG               = "ScreenCaptureService"
        const val CHANNEL_ID        = "ControleChannel"
        const val NOTIF_ID          = 1001
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_RESULT_DATA = "result_data"

        var isRunning: Boolean = false
            private set

        private var instance: ScreenCaptureService? = null

        fun refreshOverlay() {
            instance?.overlayManager?.maintainOverlay()
        }

        fun buildIntent(ctx: Context, resultCode: Int, data: Intent): Intent =
            Intent(ctx, ScreenCaptureService::class.java).apply {
                putExtra(EXTRA_RESULT_CODE, resultCode)
                putExtra(EXTRA_RESULT_DATA, data)
            }
    }

    private lateinit var metrics:      DisplayMetrics
    private var cpuLock:    PowerManager.WakeLock? = null
    private var screenLock: PowerManager.WakeLock? = null
    private var overlayManager: OverlayManager? = null

    // ── Relance la capture quand l'écran se rallume ─────────────────────────
    private val screenOnReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == Intent.ACTION_SCREEN_ON) {
                Log.i(TAG, "Écran allumé → redémarrage capture")
                WebRTCManager.getInstance(context).restartCapture()
            }
        }
    }

    @Suppress("DEPRECATION")
    override fun onCreate() {
        super.onCreate()
        instance = this
        isRunning = true
        createNotificationChannel()
        overlayManager = OverlayManager(this)

        metrics = DisplayMetrics()
        (getSystemService(WINDOW_SERVICE) as WindowManager)
            .defaultDisplay.getRealMetrics(metrics)

        // Lock CPU — garde le service actif même écran éteint
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        cpuLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Controle::CpuLock")
            .apply { acquire(3 * 60 * 60 * 1000L) }

        // Écouter le rallumage de l'écran pour redémarrer la capture
        registerReceiver(screenOnReceiver, IntentFilter(Intent.ACTION_SCREEN_ON))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val initialNotif = buildNotification("Initialisation…")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, initialNotif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIF_ID, initialNotif)
        }

        if (intent == null) {
            updateNotification("En attente…")
            return START_STICKY
        }

        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
        @Suppress("DEPRECATION")
        val resultData = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        else
            intent.getParcelableExtra(EXTRA_RESULT_DATA)

        if (resultCode != Activity.RESULT_OK || resultData == null) {
            Log.e(TAG, "Démarrage avorté : resultCode=$resultCode")
            stopForeground(true)
            stopSelf()
            return START_NOT_STICKY
        }

        updateNotification("Connexion en cours…")

        WebRTCManager.getInstance(this).startStreaming(
            resultData  = resultData,
            width       = metrics.widthPixels,
            height      = metrics.heightPixels,
            onConnected = {
                updateNotification("Connecté")
                overlayManager?.start()
                acquireScreenLock()
            },
            onDisconnected = {
                updateNotification("En attente du PC…")
                overlayManager?.stop()
                releaseScreenLock()
            },
        )

        Log.i(TAG, "Service démarré — ${metrics.widthPixels}x${metrics.heightPixels}")
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        try { unregisterReceiver(screenOnReceiver) } catch (_: Exception) {}
        instance = null
        isRunning = false
        releaseScreenLock()
        if (cpuLock?.isHeld == true) cpuLock?.release()
        overlayManager?.stop()
        WebRTCManager.getInstance(this).stopStreaming()
        Log.i(TAG, "Service arrêté")
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        updateNotification("Actif en arrière-plan")
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── Écran allumé pendant la connexion ─────────────────────────────────

    @Suppress("DEPRECATION")
    private fun acquireScreenLock() {
        if (screenLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        screenLock = pm.newWakeLock(
            PowerManager.FULL_WAKE_LOCK or
            PowerManager.ACQUIRE_CAUSES_WAKEUP or
            PowerManager.ON_AFTER_RELEASE,
            "Controle::ScreenLock"
        ).apply { acquire(3 * 60 * 60 * 1000L) }
        Log.i(TAG, "ScreenLock acquis — écran maintenu allumé")
    }

    private fun releaseScreenLock() {
        if (screenLock?.isHeld == true) screenLock?.release()
        screenLock = null
    }

    // ── Notification ───────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "Contrôle", NotificationManager.IMPORTANCE_LOW)
                .apply { description = "Connexion PC active"; setShowBadge(false) }
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(ch)
        }
    }

    private fun buildNotification(text: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
            },
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Contrôle")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun updateNotification(text: String) {
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .notify(NOTIF_ID, buildNotification(text))
    }
}
