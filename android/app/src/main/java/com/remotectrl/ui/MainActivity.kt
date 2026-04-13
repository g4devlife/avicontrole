package com.remotectrl.ui

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.provider.Settings
import android.text.InputFilter
import android.text.InputType
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import com.remotectrl.pairing.PairingManager
import com.remotectrl.service.ScreenCaptureService
import com.remotectrl.webrtc.SessionCodeEventBus

class MainActivity : AppCompatActivity() {

    companion object {
        const val REQ_MEDIA_PROJECTION = 100
    }

    // ── Écran d'appairage ──
    private lateinit var layoutPairing:  View
    private lateinit var etPairingCode:  EditText
    private lateinit var btnVerifyCode:  Button
    private lateinit var tvPairingError: TextView
    private lateinit var progressPair:   ProgressBar

    // ── Écran principal ──
    private lateinit var layoutMain:    View
    private lateinit var tvSessionCode: TextView
    private lateinit var tvStatus:      TextView
    private lateinit var btnStart:      Button
    private lateinit var btnStop:       Button
    private lateinit var layoutSession: View

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
        layoutMain    = findViewById(R.id.layout_main)
        tvSessionCode = findViewById(R.id.tv_session_code)
        tvStatus      = findViewById(R.id.tv_status)
        btnStart      = findViewById(R.id.btn_start)
        btnStop       = findViewById(R.id.btn_stop)
        layoutSession = findViewById(R.id.layout_session)

        // Clavier numérique + limite 5 chiffres
        etPairingCode.inputType = InputType.TYPE_CLASS_NUMBER
        etPairingCode.filters   = arrayOf(InputFilter.LengthFilter(5))
        etPairingCode.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) { submitCode(); true } else false
        }

        btnVerifyCode.setOnClickListener { submitCode() }

        SessionCodeEventBus.listener = { code ->
            runOnUiThread {
                tvSessionCode.text       = code
                layoutSession.visibility = View.VISIBLE
                tvStatus.text            = "En attente de connexion PC…"
            }
        }

        btnStart.setOnClickListener { requestScreenCapture() }
        btnStop.setOnClickListener  { stopStreaming() }

        updateUI()
    }

    // ── Vérification du code ────────────────────────────────────
    private fun submitCode() {
        val code = etPairingCode.text.toString().trim()
        if (code.length != 5) {
            tvPairingError.text = "Entrez les 5 chiffres"
            return
        }

        tvPairingError.text    = ""
        progressPair.visibility = View.VISIBLE
        btnVerifyCode.isEnabled = false

        PairingManager.getInstance(this).verifyCode(
            code      = code,
            onSuccess = { _ ->
                runOnUiThread {
                    progressPair.visibility = View.GONE
                    updateUI()
                    showPermissionsGuide()
                }
            },
            onError   = { msg ->
                runOnUiThread {
                    progressPair.visibility = View.GONE
                    btnVerifyCode.isEnabled = true
                    tvPairingError.text     = msg
                }
            },
        )
    }

    // ── Guide permissions ───────────────────────────────────────
    private fun showPermissionsGuide() {
        AlertDialog.Builder(this)
            .setTitle("✅ Téléphone associé !")
            .setMessage(
                "Pour le contrôle tactile, activez le service d'accessibilité :\n\n" +
                "Paramètres → Accessibilité → Avi Contrôle → Activer\n\n" +
                "La capture d'écran sera demandée au démarrage."
            )
            .setPositiveButton("Ouvrir l'accessibilité") { _, _ ->
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
            .setNegativeButton("Plus tard", null)
            .show()
    }

    // ── UI ──────────────────────────────────────────────────────
    private fun updateUI() {
        val paired = PairingManager.getInstance(this).isPaired()
        layoutPairing.visibility = if (paired) View.GONE    else View.VISIBLE
        layoutMain.visibility    = if (paired) View.VISIBLE else View.GONE
    }

    // ── Capture d'écran ────────────────────────────────────────
    private fun requestScreenCapture() {
        val mpManager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(mpManager.createScreenCaptureIntent(), REQ_MEDIA_PROJECTION)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_MEDIA_PROJECTION && resultCode == Activity.RESULT_OK && data != null) {
            startForegroundService(ScreenCaptureService.buildIntent(this, resultCode, data))
            btnStart.visibility = View.GONE
            btnStop.visibility  = View.VISIBLE
            tvStatus.text       = "Connexion au serveur…"
        }
    }

    private fun stopStreaming() {
        stopService(Intent(this, ScreenCaptureService::class.java))
        btnStart.visibility      = View.VISIBLE
        btnStop.visibility       = View.GONE
        layoutSession.visibility = View.GONE
        tvStatus.text            = "Streaming arrêté"
    }

    override fun onResume() {
        super.onResume()
        updateUI()
    }
}
