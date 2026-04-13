package com.remotectrl.service

import android.app.*
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import com.remotectrl.webrtc.WebRTCManager

class ScreenCaptureService : Service() {

    companion object {
        const val TAG             = "ScreenCaptureService"
        const val CHANNEL_ID      = "AviControleChannel"
        const val NOTIF_ID        = 1001

        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_RESULT_DATA = "result_data"

        fun buildIntent(ctx: Context, resultCode: Int, data: Intent): Intent =
            Intent(ctx, ScreenCaptureService::class.java).apply {
                putExtra(EXTRA_RESULT_CODE, resultCode)
                putExtra(EXTRA_RESULT_DATA, data)
            }
    }

    private lateinit var metrics: DisplayMetrics

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        (getSystemService(WINDOW_SERVICE) as WindowManager)
            .defaultDisplay.getRealMetrics(metrics)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) { stopSelf(); return START_NOT_STICKY }

        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, -1)
        val resultData = intent.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)!!

        startForeground(NOTIF_ID, buildNotification())

        // Démarrer WebRTC + capture d'écran.
        // WebRTCManager se connecte au signaling, et ne lance la capture réelle
        // qu'une fois le desktop rejoint (pour éviter de capturer à vide).
        WebRTCManager.getInstance(this).startStreaming(
            resultData = resultData,
            width      = metrics.widthPixels,
            height     = metrics.heightPixels,
        )

        Log.i(TAG, "Service démarré — capture prête : ${metrics.widthPixels}x${metrics.heightPixels}")
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        WebRTCManager.getInstance(this).stopStreaming()
        Log.i(TAG, "Service arrêté")
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── Notification foreground ────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Avi Contrôle",
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Streaming d'écran actif" }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Avi Contrôle actif")
            .setContentText("Votre écran est partagé en ce moment")
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setOngoing(true)
            .build()
}
