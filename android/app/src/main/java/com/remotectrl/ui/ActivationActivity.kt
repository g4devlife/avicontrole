package com.remotectrl.ui

import android.os.Bundle
import android.view.View
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import com.remotectrl.app.R
import com.remotectrl.license.LicenseManager

class ActivationActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_activation)

        val etKey       = findViewById<EditText>(R.id.et_license_key)
        val btnActivate = findViewById<Button>(R.id.btn_activate)
        val tvResult    = findViewById<TextView>(R.id.tv_result)
        val progress    = findViewById<ProgressBar>(R.id.progress)

        btnActivate.setOnClickListener {
            val key = etKey.text.toString().trim()
            if (key.length < 10) {
                tvResult.text = "Clé invalide (trop courte)"
                tvResult.setTextColor(getColor(android.R.color.holo_red_light))
                return@setOnClickListener
            }

            progress.visibility    = View.VISIBLE
            btnActivate.isEnabled  = false
            tvResult.text          = "Activation en cours..."

            LicenseManager.getInstance(this).activateLicense(
                licenseKey = key,
                onSuccess  = { msg ->
                    runOnUiThread {
                        progress.visibility   = View.GONE
                        tvResult.text         = "✅ $msg"
                        tvResult.setTextColor(getColor(android.R.color.holo_green_light))
                        // Retourner à MainActivity après 1.5s
                        etKey.postDelayed({ finish() }, 1500)
                    }
                },
                onError    = { err ->
                    runOnUiThread {
                        progress.visibility   = View.GONE
                        btnActivate.isEnabled = true
                        tvResult.text         = "❌ $err"
                        tvResult.setTextColor(getColor(android.R.color.holo_red_light))
                    }
                },
            )
        }
    }
}
