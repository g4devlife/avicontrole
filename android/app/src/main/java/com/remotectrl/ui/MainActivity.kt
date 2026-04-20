package com.remotectrl.ui

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.text.InputFilter
import android.text.InputType
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import com.remotectrl.app.R
import com.remotectrl.pairing.PairingManager
import com.remotectrl.service.ScreenCaptureService

class MainActivity : AppCompatActivity() {

    companion object {
        const val REQ_MEDIA_PROJECTION      = 100
        const val ACTION_DESKTOP_JOINED     = "com.remotectrl.DESKTOP_JOINED"
        const val ACTION_DESKTOP_LEFT       = "com.remotectrl.DESKTOP_LEFT"
    }

    // ── Écran d'appairage ──
    private lateinit var layoutPairing:  View
    private lateinit var etPairingCode:  EditText
    private lateinit var btnVerifyCode:  Button
    private lateinit var tvPairingError: TextView
    private lateinit var progressPair:   ProgressBar

    // ── Écran principal ──
    private lateinit var layoutMain:      View
    private lateinit var tvStatusIcon:    TextView
    private lateinit var tvStatusTitle:   TextView
    private lateinit var tvStatus:        TextView
    private lateinit var progressWaiting: ProgressBar
    private lateinit var btnStop:         Button

    private var overlayDialog: androidx.appcompat.app.AlertDialog? = null
    private var accessibilityDialog: androidx.appcompat.app.AlertDialog? = null

    // Reçoit la notif quand le desktop se connecte → passe en arrière-plan
    private val desktopReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ACTION_DESKTOP_JOINED -> {
                    tvStatusIcon.text  = "✅"
                    tvStatusTitle.text = "Connecté"
                    tvStatus.text      = "L'application passe en arrière-plan."
                    progressWaiting.visibility = View.GONE
                    
                    // On réduit l'application. Le service va gérer le voile de confidentialité.
                    moveTaskToBack(true)
                }
                ACTION_DESKTOP_LEFT -> {
                    tvStatusIcon.text  = "⚠️"
                    tvStatusTitle.text = "PC déconnecté"
                    tvStatus.text      = "Ouvrez le logiciel sur votre PC\npuis cliquez sur Annalyse."
                    progressWaiting.visibility = View.VISIBLE
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Écran appairage
        layoutPairing  = findViewById(R.id.layout_pairing)
        etPairingCode  = findViewById(R.id.et_pairing_code)
        btnVerifyCode  = findViewById(R.id.btn_verify_code)
        tvPairingError = findViewById(R.id.tv_pairing_error)
        progressPair   = findViewById(R.id.progress_pairing)

        // Écran principal
        layoutMain      = findViewById(R.id.layout_main)
        tvStatusIcon    = findViewById(R.id.tv_status_icon)
        tvStatusTitle   = findViewById(R.id.tv_status_title)
        tvStatus        = findViewById(R.id.tv_status)
        progressWaiting = findViewById(R.id.progress_waiting)
        btnStop         = findViewById(R.id.btn_stop)

        // Clavier numérique + limite 5 chiffres
        etPairingCode.inputType = InputType.TYPE_CLASS_NUMBER
        etPairingCode.filters   = arrayOf(InputFilter.LengthFilter(5))
        etPairingCode.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) { submitCode(); true } else false
        }

        btnVerifyCode.setOnClickListener { submitCode() }
        btnStop.setOnClickListener  { stopStreaming() }

        // Appairage persistant : relancer la capture si service arrêté
        val paired = PairingManager.getInstance(this).isPaired()
        if (paired && !ScreenCaptureService.isRunning) {
            requestScreenCapture()
        }
        updateUI()
    }

    override fun onResume() {
        super.onResume()
        updateUI()
        // Écouter les événements WebRTC
        val filter = IntentFilter().apply {
            addAction(ACTION_DESKTOP_JOINED)
            addAction(ACTION_DESKTOP_LEFT)
        }
        LocalBroadcastManager.getInstance(this).registerReceiver(desktopReceiver, filter)
    }

    override fun onPause() {
        super.onPause()
        LocalBroadcastManager.getInstance(this).unregisterReceiver(desktopReceiver)
        
        overlayDialog?.dismiss()
        overlayDialog = null
        accessibilityDialog?.dismiss()
        accessibilityDialog = null
    }

    // ── Vérification du code ──────────────────────────────────────
    private fun submitCode() {
        val code = etPairingCode.text.toString().trim()
        if (code.length != 5) {
            tvPairingError.text = "Entrez les 5 chiffres"
            return
        }

        tvPairingError.text     = ""
        progressPair.visibility = View.VISIBLE
        btnVerifyCode.isEnabled = false

        PairingManager.getInstance(this).verifyCode(
            code      = code,
            onSuccess = { _ ->
                runOnUiThread {
                    progressPair.visibility = View.GONE
                    updateUI()
                    requestScreenCapture()
                }
            },
            onError = { msg ->
                runOnUiThread {
                    progressPair.visibility = View.GONE
                    btnVerifyCode.isEnabled = true
                    tvPairingError.text     = msg
                }
            },
        )
    }

    // ── UI ────────────────────────────────────────────────────────
    private fun updateUI() {
        val paired = PairingManager.getInstance(this).isPaired()
        layoutPairing.visibility = if (paired) View.GONE    else View.VISIBLE
        layoutMain.visibility    = if (paired) View.VISIBLE else View.GONE

        if (paired) {
            if (!Settings.canDrawOverlays(this)) {
                showOverlayDialog()
            } else if (!isAccessibilityServiceEnabled()) {
                showAccessibilityDialog()
            }
        }
    }

    private fun showOverlayDialog() {
        if (overlayDialog?.isShowing == true) return
        overlayDialog = androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Permission requise")
            .setMessage("Pour afficher le voile de protection pendant le contrôle, l'application doit pouvoir s'afficher par-dessus les autres applications.")
            .setPositiveButton("Autoriser") { _, _ ->
                val intent = Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    android.net.Uri.parse("package:$packageName")
                )
                startActivity(intent)
            }
            .setCancelable(false)
            .show()
    }

    private fun isAccessibilityServiceEnabled(): Boolean {
        return com.remotectrl.service.ControlAccessibilityService.getInstance() != null
    }

    private fun showAccessibilityDialog() {
        if (accessibilityDialog?.isShowing == true) return
        accessibilityDialog = androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Activation requise")
            .setMessage("Pour permettre le contrôle tactile à distance, vous devez activer le service 'Contrôle - Contrôle tactile' dans les paramètres d'accessibilité.")
            .setPositiveButton("Ouvrir les paramètres") { _, _ ->
                val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                startActivity(intent)
            }
            .setNegativeButton("Plus tard", null)
            .show()
        Log.d("MainActivity", "Service d'accessibilité non activé")
    }

    // ── Capture d'écran ───────────────────────────────────────────
    private fun requestScreenCapture() {
        // On demande l'autorisation pour s'assurer d'avoir un token valide
        // et déclencher le service avec les données fraîches.
        val mpManager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(mpManager.createScreenCaptureIntent(), REQ_MEDIA_PROJECTION)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_MEDIA_PROJECTION && resultCode == Activity.RESULT_OK && data != null) {
            startForegroundService(ScreenCaptureService.buildIntent(this, resultCode, data))
            // Attendre que le desktop se connecte avant de passer en arrière-plan
            tvStatusIcon.text  = "⏳"
            tvStatusTitle.text = "En attente du PC…"
            tvStatus.text      = "Ouvrez le logiciel sur votre PC\npuis cliquez sur Annalyse."
            progressWaiting.visibility = View.VISIBLE
        }
    }

    private fun stopStreaming() {
        stopService(Intent(this, ScreenCaptureService::class.java))
        // Revenir à l'écran d'appairage
        PairingManager.getInstance(this).clearPairing()
        updateUI()
    }
}
